import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isUuid } from "@qorpera/contracts";
import { lxdCodingMachineName } from "./coding-machine.ts";
import type { LxdClient, LxdHostInventoryClient } from "./lxd-client.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";

/** The executor's runtime directory (systemd RuntimeDirectory, 0700, kept across
 * its restarts and emptied at every boot): one lease per member machine it holds. */
export const CODING_HOST_LEASE_ROOT = "/run/qorpera-coding-host";
/** Longer than the keeper's slowest gap between two renewals: a pass every 10 s
 * from the start of the last one, its machine list within 30 s and each machine
 * within 15 s, so two renewals are at most 75 s apart. */
export const CODING_HOST_LEASE_TTL_MS = 90_000;
const SCHEMA = "qorpera.coding-host-lease/v1";
const KEYS = "bootId,expiresAtBootMs,machineId,name,project,renewedAtBootMs,schema";
const NAME = /^qorpera-coding-machine-[0-9a-f]{32}$/;
const FILE = /^(qorpera-coding-machine-[0-9a-f]{32})\.json$/;
const TEMPORARY = /^\.qorpera-coding-machine-[0-9a-f]{32}\.[0-9a-f-]{36}\.tmp$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** LXD's status code for a stopped instance: anything else may still run. */
const STOPPED = 102;

/** This boot and the time since it began, the clock both the executor and the
 * watchdog read: a wall-clock change cannot extend a lease, and a lease never
 * outlives its boot. */
export interface CodingHostClock {
	bootId(): Promise<string>;
	uptimeMs(): Promise<number>;
}
export const linuxCodingHostClock: CodingHostClock = {
	async bootId() {
		const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		if (!isUuid(id)) throw new Error("CODING_HOST_CLOCK_UNAVAILABLE");
		return id;
	},
	async uptimeMs() {
		try {
			return parseLxdProcUptime(await readFile("/proc/uptime"));
		} catch {
			throw new Error("CODING_HOST_CLOCK_UNAVAILABLE");
		}
	},
};

export interface CodingHostLease {
	schema: typeof SCHEMA;
	project: string;
	name: string;
	machineId: string;
	bootId: string;
	renewedAtBootMs: number;
	expiresAtBootMs: number;
}
/** What a machine's lease says: live, or why its machine may not run. */
export type CodingHostLeaseVerdict = "live" | "missing" | "unreadable" | "other-boot" | "lapsed" | "mismatched";
export interface CodingHostLeaseOptions {
	root?: string;
	clock?: CodingHostClock;
	ttlMs?: number;
}
interface Holder {
	project: string;
	machineId: string;
}

function errno(error: unknown, value: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === value;
}
/** Only this user may reach the leases: the executor and the watchdog run as it. */
async function protectedRoot(root: string): Promise<void> {
	const directory = await lstat(root);
	if (!directory.isDirectory() || directory.uid !== process.geteuid?.() || (directory.mode & 0o077) !== 0)
		throw new Error("CODING_HOST_LEASE_ROOT_UNPROTECTED");
}
function leaseName(holder: Holder): string {
	if (!PROJECT.test(holder.project)) throw new Error("CODING_HOST_LEASE_INVALID");
	return lxdCodingMachineName(holder.machineId);
}
async function syncDirectory(root: string): Promise<void> {
	const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
async function readLease(root: string, name: string): Promise<CodingHostLease> {
	await protectedRoot(root);
	const file = await open(join(root, `${name}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
	let value: Record<string, unknown>;
	try {
		const metadata = await file.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.uid !== process.geteuid?.() ||
			(metadata.mode & 0o077) !== 0 ||
			metadata.size > 4096
		)
			throw new Error("CODING_HOST_LEASE_UNPROTECTED");
		value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await file.readFile()));
	} finally {
		await file.close();
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== KEYS ||
		value.schema !== SCHEMA ||
		typeof value.project !== "string" ||
		typeof value.name !== "string" ||
		typeof value.machineId !== "string" ||
		typeof value.bootId !== "string" ||
		!Number.isSafeInteger(value.renewedAtBootMs) ||
		!Number.isSafeInteger(value.expiresAtBootMs)
	)
		throw new Error("CODING_HOST_LEASE_INVALID");
	return value as unknown as CodingHostLease;
}
/** A lease read for machine `name` of `project`, at `nowMs` of boot `bootId`. A
 * lease from the future, or longer than `ttlMs`, is unreadable: it was never
 * written so. */
function verdictOf(
	lease: CodingHostLease,
	project: string,
	name: string,
	bootId: string,
	nowMs: number,
	ttlMs: number,
): CodingHostLeaseVerdict {
	let named: string;
	try {
		named = lxdCodingMachineName(lease.machineId);
	} catch {
		return "mismatched";
	}
	if (lease.project !== project || lease.name !== name || named !== name) return "mismatched";
	if (lease.bootId !== bootId) return "other-boot";
	if (
		lease.renewedAtBootMs < 0 ||
		lease.renewedAtBootMs > nowMs ||
		lease.expiresAtBootMs <= lease.renewedAtBootMs ||
		lease.expiresAtBootMs - lease.renewedAtBootMs > ttlMs
	)
		return "unreadable";
	return nowMs < lease.expiresAtBootMs ? "live" : "lapsed";
}
async function judge(
	root: string,
	project: string,
	name: string,
	bootId: string,
	nowMs: number,
	ttlMs: number,
): Promise<CodingHostLeaseVerdict> {
	let lease: CodingHostLease;
	try {
		lease = await readLease(root, name);
	} catch (error) {
		return errno(error, "ENOENT") ? "missing" : "unreadable";
	}
	return verdictOf(lease, project, name, bootId, nowMs, ttlMs);
}
export function judgeCodingHostLease(
	name: string,
	project: string,
	options: { root?: string; bootId: string; nowMs: number; ttlMs?: number },
): Promise<CodingHostLeaseVerdict> {
	return judge(
		options.root ?? CODING_HOST_LEASE_ROOT,
		project,
		name,
		options.bootId,
		options.nowMs,
		options.ttlMs ?? CODING_HOST_LEASE_TTL_MS,
	);
}

/** The executor's leases, one per member machine it holds on this node: its
 * permission to run there. Written before a start and on every keeper pass for
 * each machine SQL lists as reserved here; dropped once the machine is stopped
 * or deleted. Every write, drop and prune runs one at a time, so a prune never
 * removes a lease a start has just written. */
export class CodingHostLeases {
	readonly #root: string;
	readonly #clock: CodingHostClock;
	readonly #ttlMs: number;
	#work: Promise<unknown> = Promise.resolve();
	constructor(options: CodingHostLeaseOptions = {}) {
		const ttlMs = options.ttlMs ?? CODING_HOST_LEASE_TTL_MS;
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > CODING_HOST_LEASE_TTL_MS)
			throw new Error("CODING_HOST_LEASE_INVALID");
		this.#root = options.root ?? CODING_HOST_LEASE_ROOT;
		this.#clock = options.clock ?? linuxCodingHostClock;
		this.#ttlMs = ttlMs;
	}
	#serial<T>(use: () => Promise<T>): Promise<T> {
		const work = this.#work.catch(() => undefined).then(use);
		this.#work = work;
		return work;
	}
	async #write(holder: Holder): Promise<string> {
		const name = leaseName(holder);
		await protectedRoot(this.#root);
		const bootId = await this.#clock.bootId(),
			now = await this.#clock.uptimeMs();
		if (!isUuid(bootId) || !Number.isSafeInteger(now) || now < 0) throw new Error("CODING_HOST_CLOCK_UNAVAILABLE");
		const lease: CodingHostLease = {
			schema: SCHEMA,
			project: holder.project,
			name,
			machineId: holder.machineId,
			bootId,
			renewedAtBootMs: now,
			expiresAtBootMs: now + this.#ttlMs,
		};
		const temporary = join(this.#root, `.${name}.${randomUUID()}.tmp`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(JSON.stringify(lease));
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, join(this.#root, `${name}.json`));
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		await syncDirectory(this.#root);
		return name;
	}
	/** Writes the machine's lease for another TTL from now. */
	renew(holder: Holder): Promise<void> {
		return this.#serial(async () => {
			await this.#write(holder);
		});
	}
	/** Removes the machine's lease (none is fine): only once it no longer runs. */
	drop(holder: Holder): Promise<void> {
		return this.#serial(async () => {
			const name = leaseName(holder);
			await protectedRoot(this.#root);
			try {
				await unlink(join(this.#root, `${name}.json`));
			} catch (error) {
				if (errno(error, "ENOENT")) return;
				throw error;
			}
			await syncDirectory(this.#root);
		});
	}
	/** The keeper's pass: renews the lease of every machine held, then removes
	 * every other lease that no longer lets its machine run (lapsed, from an
	 * earlier boot, unreadable) and leftovers of a write that crashed. A live
	 * lease of a machine not held stays until it lapses: its start may be under
	 * way. Returns each machine whose renewal failed; the prune is best effort,
	 * since a lapsed lease left behind is still lapsed. */
	hold(holders: readonly Holder[]): Promise<{ machineId: string; error: unknown }[]> {
		return this.#serial(async () => {
			const held = new Set<string>(),
				failures: { machineId: string; error: unknown }[] = [];
			for (const holder of holders)
				try {
					held.add(await this.#write(holder));
				} catch (error) {
					failures.push({ machineId: holder.machineId, error });
				}
			try {
				await this.#prune(held);
			} catch {
				/* Judged as lapsed all the same. */
			}
			return failures;
		});
	}
	async #prune(held: ReadonlySet<string>): Promise<void> {
		await protectedRoot(this.#root);
		const bootId = await this.#clock.bootId(),
			now = await this.#clock.uptimeMs();
		let removed = false;
		for (const entry of await readdir(this.#root)) {
			const name = FILE.exec(entry)?.[1];
			if (name && held.has(name)) continue;
			if (name) {
				let lease: CodingHostLease | null = null;
				try {
					lease = await readLease(this.#root, name);
				} catch {
					/* Unreadable: it lets nothing run. */
				}
				if (lease && verdictOf(lease, lease.project, name, bootId, now, this.#ttlMs) === "live") continue;
			} else if (!TEMPORARY.test(entry)) continue;
			try {
				await unlink(join(this.#root, entry));
				removed = true;
			} catch (error) {
				if (!errno(error, "ENOENT")) throw error;
			}
		}
		if (removed) await syncDirectory(this.#root);
	}
}

export interface CodingHostWatchdogOutcome {
	name: string;
	verdict: Exclude<CodingHostLeaseVerdict, "live">;
	state: "stopped" | "failed";
	code?: string;
}
/** One look at the node, independent of the executor and of SQL: every coding
 * machine VM in the executor's project that may be running (any state but
 * stopped) is force-stopped unless its lease is live. Only names of member
 * machines (qorpera-coding-machine-<32 hex>) are judged; kept per-session VMs,
 * company machines and every other project are left alone. The leases are read
 * after the listing, so a machine started meanwhile, whose lease is written
 * before its start, is never mistaken for one without. The stops run side by
 * side; each outcome is returned. An inventory LXD cannot confirm throws, and
 * nothing is stopped. */
export async function runCodingHostWatchdog(options: {
	client: LxdHostInventoryClient & Pick<LxdClient, "setInstancePower">;
	project: string;
	signal: AbortSignal;
	root?: string;
	clock?: CodingHostClock;
}): Promise<CodingHostWatchdogOutcome[]> {
	if (!PROJECT.test(options.project)) throw new Error("CODING_HOST_LEASE_INVALID");
	const clock = options.clock ?? linuxCodingHostClock,
		root = options.root ?? CODING_HOST_LEASE_ROOT;
	const { instances } = await options.client.inspectHostInventory(options.signal);
	const candidates = instances.filter(
		(instance) =>
			instance.project === options.project &&
			instance.type === "virtual-machine" &&
			NAME.test(instance.name) &&
			instance.statusCode !== STOPPED,
	);
	if (!candidates.length) return [];
	const bootId = await clock.bootId(),
		now = await clock.uptimeMs();
	if (!isUuid(bootId) || !Number.isSafeInteger(now) || now < 0) throw new Error("CODING_HOST_CLOCK_UNAVAILABLE");
	const outcomes = await Promise.all(
		candidates.map(async ({ name }): Promise<CodingHostWatchdogOutcome | null> => {
			const verdict = await judge(root, options.project, name, bootId, now, CODING_HOST_LEASE_TTL_MS);
			if (verdict === "live") return null;
			try {
				await options.client.setInstancePower(options.project, name, "stop", options.signal);
				return { name, verdict, state: "stopped" };
			} catch (error) {
				const message = error instanceof Error ? error.message : "";
				return {
					name,
					verdict,
					state: "failed",
					code: /^[A-Z][A-Z0-9_:]{0,119}$/.test(message) ? message : "UNCLASSIFIED",
				};
			}
		}),
	);
	return outcomes.filter((outcome): outcome is CodingHostWatchdogOutcome => outcome !== null);
}
