import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CLOUD_CODING_GUEST_ROOTS, cloudCodingSessionLayout } from "@qorpera/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
// Execution authority is boot-local, not durable task data. A NAS outage must
// never block the watchdog's lease read before it can stop command cgroups.
// Each session attached to the member's machine has its own lease in its
// runtime folder (cloudCodingSessionLayout) and its own command slice. The
// lease follows the session's attachment, not its turn: its generation is the
// attachment token's digest, so the session's commands keep running between
// turns while the executor renews it, and stop when it expires. It also names
// the latest turn admitted under it and whether that turn is open: only an
// open turn's commands may start.
const executeFile = promisify(execFile);
export interface CodingGuestLeaseConfiguration {
	workerId: string;
	vmId: string;
	bootId: string;
}
export interface CodingGuestLeaseScope {
	workerId: string;
	vmId: string;
	requestId: string;
	turn: number;
}
export interface CodingGuestLeaseRefresh extends CodingGuestLeaseScope {
	schema: "qorpera.coding-guest-lease-refresh/v2";
	/** The turn may start commands (it is preparing or running). */
	open: boolean;
	leaseTokenSha256: string;
	ttlMs: number;
	notAfterMonoMs?: number;
}
interface Lease extends CodingGuestLeaseScope {
	schema: "qorpera.coding-guest-lease/v2";
	open: boolean;
	bootId: string;
	leaseTokenSha256: string;
	refreshedAtMonoMs: number;
	expiresAtMonoMs: number;
}
export interface CodingGuestWatchdogPorts {
	/** The session's runtime folder; trusted test composition only. */
	root?: string;
	protectedUid?: number;
	protectedDirectoryRoot?: string;
	nowMs?: () => Promise<number>;
	inspectBoot?: () => Promise<string>;
	system?: (executable: string, args: readonly string[]) => Promise<string>;
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("INVALID_CODING_GUEST_LEASE");
	return value as Record<string, unknown>;
}
function scope(value: Record<string, unknown>): void {
	if (
		![value.workerId, value.vmId, value.requestId].every((id) => typeof id === "string" && UUID.test(id)) ||
		!Number.isSafeInteger(value.turn) ||
		Number(value.turn) < 1
	)
		throw new Error("INVALID_CODING_GUEST_LEASE");
}
export function parseCodingGuestLeaseRefresh(value: unknown): CodingGuestLeaseRefresh {
	const v = closed(value, [
		"schema",
		"workerId",
		"vmId",
		"requestId",
		"turn",
		"open",
		"leaseTokenSha256",
		"ttlMs",
		...(value && typeof value === "object" && Object.hasOwn(value, "notAfterMonoMs") ? ["notAfterMonoMs"] : []),
	]);
	scope(v);
	if (
		v.schema !== "qorpera.coding-guest-lease-refresh/v2" ||
		typeof v.open !== "boolean" ||
		typeof v.leaseTokenSha256 !== "string" ||
		!HASH.test(v.leaseTokenSha256) ||
		!Number.isSafeInteger(v.ttlMs) ||
		Number(v.ttlMs) < 1 ||
		Number(v.ttlMs) > 60000 ||
		(Object.hasOwn(v, "notAfterMonoMs") && (!Number.isSafeInteger(v.notAfterMonoMs) || Number(v.notAfterMonoMs) < 1))
	)
		throw new Error("INVALID_CODING_GUEST_LEASE");
	return v as unknown as CodingGuestLeaseRefresh;
}
function lease(value: unknown): Lease {
	const v = closed(value, [
		"schema",
		"workerId",
		"vmId",
		"requestId",
		"turn",
		"open",
		"bootId",
		"leaseTokenSha256",
		"refreshedAtMonoMs",
		"expiresAtMonoMs",
	]);
	scope(v);
	if (
		v.schema !== "qorpera.coding-guest-lease/v2" ||
		typeof v.open !== "boolean" ||
		typeof v.bootId !== "string" ||
		!UUID.test(v.bootId) ||
		typeof v.leaseTokenSha256 !== "string" ||
		!HASH.test(v.leaseTokenSha256) ||
		!Number.isSafeInteger(v.refreshedAtMonoMs) ||
		!Number.isSafeInteger(v.expiresAtMonoMs) ||
		Number(v.refreshedAtMonoMs) < 0 ||
		Number(v.expiresAtMonoMs) <= Number(v.refreshedAtMonoMs) ||
		Number(v.expiresAtMonoMs) - Number(v.refreshedAtMonoMs) > 60000
	)
		throw new Error("INVALID_CODING_GUEST_LEASE");
	return v as unknown as Lease;
}
async function now(ports: CodingGuestWatchdogPorts): Promise<number> {
	// Linux uptime is tied to this boot and includes VM suspension. Wall-clock
	// corrections and a new Node process cannot extend an already-issued lease.
	const n = ports.nowMs
		? await ports.nowMs()
		: Math.floor(Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000);
	if (!Number.isSafeInteger(n) || n < 0) throw new Error("CODING_GUEST_MONOTONIC_CLOCK_UNAVAILABLE");
	return n;
}
async function boot(ports: CodingGuestWatchdogPorts): Promise<string> {
	const id = ports.inspectBoot
		? await ports.inspectBoot()
		: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	if (!UUID.test(id)) throw new Error("CODING_GUEST_BOOT_UNAVAILABLE");
	return id;
}
async function protectedDirectory(path: string, ports: CodingGuestWatchdogPorts): Promise<void> {
	for (let p = path; ; p = dirname(p)) {
		const st = await lstat(p);
		if (!st.isDirectory() || st.uid !== (ports.protectedUid ?? 0) || (st.mode & 0o022) !== 0)
			throw new Error("UNPROTECTED_CODING_GUEST_LEASE_PATH");
		if (p === (ports.protectedDirectoryRoot ?? "/") || p === dirname(p)) break;
	}
}
export async function readProtectedCodingGuestLeaseJson(
	path: string,
	ports: CodingGuestWatchdogPorts = {},
): Promise<unknown> {
	await protectedDirectory(dirname(path), ports);
	const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const st = await h.stat();
		if (
			!st.isFile() ||
			st.nlink !== 1 ||
			st.uid !== (ports.protectedUid ?? 0) ||
			(st.mode & 0o022) !== 0 ||
			st.size > 4096
		)
			throw new Error("UNPROTECTED_CODING_GUEST_LEASE_FILE");
		return JSON.parse((await h.readFile()).toString("utf8"));
	} finally {
		await h.close();
	}
}
function runtime(ports: CodingGuestWatchdogPorts, workerId: string): string {
	return ports.root ?? cloudCodingSessionLayout(workerId).runtimeRoot;
}
async function current(ports: CodingGuestWatchdogPorts, workerId: string): Promise<Lease> {
	return lease(await readProtectedCodingGuestLeaseJson(join(runtime(ports, workerId), "lease.json"), ports));
}
/** Stops one session's command slice, or with no session every coding slice. */
async function stop(ports: CodingGuestWatchdogPorts, workerId?: string): Promise<void> {
	const args = ["stop", workerId ? cloudCodingSessionLayout(workerId).slice : "qorpera-coding.slice"];
	if (ports.system) await ports.system("/usr/bin/systemctl", args);
	else
		await executeFile("/usr/bin/systemctl", args, {
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
			timeout: 5000,
			maxBuffer: 4096,
		});
}
function match(l: Lease, c: CodingGuestLeaseConfiguration): void {
	if (l.workerId !== c.workerId || l.vmId !== c.vmId || l.bootId !== c.bootId)
		throw new Error("CODING_GUEST_LEASE_SCOPE_CHANGED");
}
/** The live lease of this boot, naming the scope's turn and, for a command
 * start (turnOpen), with that turn open. The watchdog checks liveness only. */
export async function requireCodingGuestLease(
	s: CodingGuestLeaseScope,
	c: CodingGuestLeaseConfiguration,
	ports: CodingGuestWatchdogPorts = {},
	turnOpen = true,
): Promise<void> {
	const l = await current(ports, c.workerId);
	match(l, c);
	const time = await now(ports);
	if (
		(await boot(ports)) !== c.bootId ||
		s.workerId !== l.workerId ||
		s.vmId !== l.vmId ||
		s.requestId !== l.requestId ||
		s.turn !== l.turn ||
		(turnOpen && !l.open) ||
		time < l.refreshedAtMonoMs ||
		time >= l.expiresAtMonoMs
	)
		throw new Error("CODING_GUEST_LEASE_UNAVAILABLE");
}
export async function refreshCodingGuestLease(
	value: unknown,
	c: CodingGuestLeaseConfiguration,
	ports: CodingGuestWatchdogPorts = {},
): Promise<{
	schema: "qorpera.coding-guest-lease-receipt/v2";
	requestId: string;
	turn: number;
	open: boolean;
	validForMs: number;
}> {
	if (process.getuid?.() !== (ports.protectedUid ?? 0)) throw new Error("CODING_GUEST_LEASE_ROOT_REQUIRED");
	const v = parseCodingGuestLeaseRefresh(value);
	if (v.workerId !== c.workerId || v.vmId !== c.vmId || (await boot(ports)) !== c.bootId)
		throw new Error("CODING_GUEST_LEASE_SCOPE_CHANGED");
	const root = runtime(ports, c.workerId);
	await protectedDirectory(root, ports);
	// No stale lock takeover: a crashed refresh blocks renewal and the independent
	// watchdog still stops the slice when the last committed lease expires.
	const lock = join(root, "lease-refresh-lock");
	await mkdir(lock, { mode: 0o700 });
	try {
		const time = await now(ports);
		let prior: Lease | undefined;
		try {
			prior = await current(ports, c.workerId);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		// Turns never go back. The same generation renews only while it is live
		// and never reopens a turn it closed. Another generation (a new
		// attachment) first stops everything an earlier one left.
		const same = prior?.leaseTokenSha256 === v.leaseTokenSha256;
		if (prior) {
			if (
				prior.workerId !== c.workerId ||
				prior.vmId !== c.vmId ||
				v.turn < prior.turn ||
				(same &&
					(prior.bootId !== c.bootId ||
						time < prior.refreshedAtMonoMs ||
						time >= prior.expiresAtMonoMs ||
						(v.turn === prior.turn && (v.requestId !== prior.requestId || (v.open && !prior.open)))))
			)
				throw new Error("CODING_GUEST_LEASE_GENERATION_UNAVAILABLE");
		}
		if (!same) await stop(ports, c.workerId);
		const stamped = await now(ports);
		const expiresAt = Math.min(stamped + v.ttlMs, v.notAfterMonoMs ?? Number.MAX_SAFE_INTEGER);
		if (expiresAt <= stamped) throw new Error("CODING_GUEST_LEASE_REFRESH_EXPIRED");
		const record: Lease = {
			schema: "qorpera.coding-guest-lease/v2",
			workerId: v.workerId,
			vmId: v.vmId,
			requestId: v.requestId,
			turn: v.turn,
			open: v.open,
			bootId: c.bootId,
			leaseTokenSha256: v.leaseTokenSha256,
			refreshedAtMonoMs: stamped,
			expiresAtMonoMs: expiresAt,
		};
		const temporary = join(root, `lease-${randomUUID()}.json`);
		const h = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o444,
		);
		try {
			await h.writeFile(JSON.stringify(record));
			await h.sync();
		} finally {
			await h.close();
		}
		try {
			await rename(temporary, join(root, "lease.json"));
		} catch (e) {
			await unlink(temporary).catch(() => {});
			throw e;
		}
		const d = await open(root, constants.O_RDONLY);
		try {
			await d.sync();
		} finally {
			await d.close();
		}
		return {
			schema: "qorpera.coding-guest-lease-receipt/v2",
			requestId: v.requestId,
			turn: v.turn,
			open: v.open,
			validForMs: expiresAt - stamped,
		};
	} finally {
		await rmdir(lock);
	}
}
export async function reconcileCodingGuestLease(
	c: CodingGuestLeaseConfiguration,
	ports: CodingGuestWatchdogPorts = {},
): Promise<"active" | "stopped"> {
	try {
		const l = await current(ports, c.workerId);
		await requireCodingGuestLease(l, c, ports, false);
		return "active";
	} catch {
		await stop(ports, c.workerId);
		return "stopped";
	}
}
/** Every session attached to the member's machine this boot, each judged on
 * its own lease: an expired, missing or unreadable one stops that session's
 * slice only. If the sessions cannot be listed at all, every coding slice stops. */
export async function runCodingGuestWatchdog(
	ports: CodingGuestWatchdogPorts & { sessionsRoot?: string } = {},
): Promise<void> {
	let listed = false;
	try {
		if (!ports.system && (process.argv.length !== 2 || process.getuid?.() !== 0))
			throw new Error("CODING_WATCHDOG_ROOT_REQUIRED");
		const root = ports.sessionsRoot ?? CLOUD_CODING_GUEST_ROOTS.runtime;
		let names: string[];
		try {
			await protectedDirectory(root, ports);
			names = await readdir(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
			else throw error;
		}
		const failures: unknown[] = [];
		listed = true;
		// All sessions at once: many leases expiring together (an executor gone)
		// must not queue their stops behind one another.
		const judge = async (workerId: string) => {
			const session = { ...ports, root: ports.sessionsRoot ? join(root, workerId) : undefined };
			try {
				let c: CodingGuestLeaseConfiguration;
				try {
					c = (await readProtectedCodingGuestLeaseJson(
						join(session.root ?? cloudCodingSessionLayout(workerId).runtimeRoot, "configuration", "guest.json"),
						session,
					)) as CodingGuestLeaseConfiguration;
				} catch (error) {
					// A session still being prepared has no configuration yet, and no commands.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				if (
					!c ||
					c.workerId !== workerId ||
					![c.vmId, c.bootId].every((id) => typeof id === "string" && UUID.test(id))
				)
					throw new Error("CODING_WATCHDOG_CONFIGURATION_INVALID");
				await reconcileCodingGuestLease(c, session);
			} catch (error) {
				failures.push(error);
				await stop(session, workerId).catch((stopError) => failures.push(stopError));
			}
		};
		await Promise.all(names.filter((name) => UUID.test(name)).map(judge));
		if (failures.length) throw failures[0];
	} catch (error) {
		// Each failed session was stopped on its own; only an unlisted machine stops every session.
		if (!listed) await stop(ports).catch(() => {});
		throw error;
	}
}
