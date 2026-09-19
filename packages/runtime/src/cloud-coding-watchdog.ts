import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ROOT = "/var/lib/qorpera-coding";
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
	schema: "qorpera.coding-guest-lease-refresh/v1";
	leaseTokenSha256: string;
	ttlMs: number;
	notAfterMonoMs?: number;
}
interface Lease extends CodingGuestLeaseScope {
	schema: "qorpera.coding-guest-lease/v1";
	bootId: string;
	leaseTokenSha256: string;
	refreshedAtMonoMs: number;
	expiresAtMonoMs: number;
}
export interface CodingGuestWatchdogPorts {
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
		"leaseTokenSha256",
		"ttlMs",
		...(value && typeof value === "object" && Object.hasOwn(value, "notAfterMonoMs") ? ["notAfterMonoMs"] : []),
	]);
	scope(v);
	if (
		v.schema !== "qorpera.coding-guest-lease-refresh/v1" ||
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
		"bootId",
		"leaseTokenSha256",
		"refreshedAtMonoMs",
		"expiresAtMonoMs",
	]);
	scope(v);
	if (
		v.schema !== "qorpera.coding-guest-lease/v1" ||
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
async function current(ports: CodingGuestWatchdogPorts): Promise<Lease> {
	return lease(await readProtectedCodingGuestLeaseJson(join(ports.root ?? ROOT, "lease.json"), ports));
}
async function stopAll(ports: CodingGuestWatchdogPorts): Promise<void> {
	const args = ["stop", "qorpera-coding.slice"];
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
export async function requireCodingGuestLease(
	s: CodingGuestLeaseScope,
	c: CodingGuestLeaseConfiguration,
	ports: CodingGuestWatchdogPorts = {},
): Promise<void> {
	const l = await current(ports);
	match(l, c);
	const time = await now(ports);
	if (
		(await boot(ports)) !== c.bootId ||
		s.workerId !== l.workerId ||
		s.vmId !== l.vmId ||
		s.requestId !== l.requestId ||
		s.turn !== l.turn ||
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
	schema: "qorpera.coding-guest-lease-receipt/v1";
	requestId: string;
	turn: number;
	validForMs: number;
}> {
	if (process.getuid?.() !== (ports.protectedUid ?? 0)) throw new Error("CODING_GUEST_LEASE_ROOT_REQUIRED");
	const v = parseCodingGuestLeaseRefresh(value);
	if (v.workerId !== c.workerId || v.vmId !== c.vmId || (await boot(ports)) !== c.bootId)
		throw new Error("CODING_GUEST_LEASE_SCOPE_CHANGED");
	const root = ports.root ?? ROOT;
	await protectedDirectory(root, ports);
	// No stale lock takeover: a crashed refresh blocks renewal and the independent
	// watchdog still stops the slice when the last committed lease expires.
	const lock = join(root, "lease-refresh-lock");
	await mkdir(lock, { mode: 0o700 });
	try {
		const time = await now(ports);
		let prior: Lease | undefined;
		try {
			prior = await current(ports);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		if (prior) {
			if (
				prior.workerId !== c.workerId ||
				prior.vmId !== c.vmId ||
				v.turn < prior.turn ||
				(v.turn === prior.turn &&
					(v.requestId !== prior.requestId ||
						v.leaseTokenSha256 !== prior.leaseTokenSha256 ||
						prior.bootId !== c.bootId ||
						time < prior.refreshedAtMonoMs ||
						time >= prior.expiresAtMonoMs))
			)
				throw new Error("CODING_GUEST_LEASE_GENERATION_UNAVAILABLE");
		}
		if (!prior || prior.turn !== v.turn) await stopAll(ports);
		const stamped = await now(ports);
		const expiresAt = Math.min(stamped + v.ttlMs, v.notAfterMonoMs ?? Number.MAX_SAFE_INTEGER);
		if (expiresAt <= stamped) throw new Error("CODING_GUEST_LEASE_REFRESH_EXPIRED");
		const record: Lease = {
			schema: "qorpera.coding-guest-lease/v1",
			workerId: v.workerId,
			vmId: v.vmId,
			requestId: v.requestId,
			turn: v.turn,
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
			schema: "qorpera.coding-guest-lease-receipt/v1",
			requestId: v.requestId,
			turn: v.turn,
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
		const l = await current(ports);
		await requireCodingGuestLease(l, c, ports);
		return "active";
	} catch {
		await stopAll(ports);
		return "stopped";
	}
}
export async function runCodingGuestWatchdog(): Promise<void> {
	try {
		if (process.argv.length !== 2 || process.getuid?.() !== 0) throw new Error("CODING_WATCHDOG_ROOT_REQUIRED");
		const c = (await readProtectedCodingGuestLeaseJson(
			"/etc/qorpera-coding/guest.json",
		)) as CodingGuestLeaseConfiguration;
		if (!c || ![c.workerId, c.vmId, c.bootId].every((id) => typeof id === "string" && UUID.test(id)))
			throw new Error("CODING_WATCHDOG_CONFIGURATION_INVALID");
		await reconcileCodingGuestLease(c);
	} catch (error) {
		await stopAll({}).catch(() => {});
		throw error;
	}
}
