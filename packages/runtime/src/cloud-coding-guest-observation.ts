import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CLOUD_CODING_GUEST_ROOTS, cloudCodingSessionLayout } from "@qorpera/contracts";

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Commands named per session; more are counted. A bound on the report, not on the work. */
export const CODING_GUEST_OBSERVED_COMMANDS = 64;
/** Bytes of a command the report keeps (the executor passes them to the next turn). */
export const CODING_COMMAND_PREVIEW_BYTES = 300;
/** Every published file fits one read of LXD's file API by the executor. */
export const CODING_GUEST_OBSERVATION_MAX_BYTES = 65536;
export interface CodingGuestObservedCommand {
	commandId: string;
	turn: number;
	command: string;
}
/** What runs inside the member's machine, per attached session: how many of
 * its commands' processes still run, the processor time its slice has used,
 * and its guest lease. The executor reads it back (it cannot read a command's
 * stdout through LXD), keeps attachments and decides when the machine is quiet
 * enough to sleep. Published at /run/qorpera-coding/observation.json. */
export interface CodingGuestObservation {
	schema: "qorpera.coding-guest-observation/v2";
	bootId: string;
	uptimeMs: number;
	sessions: {
		workerId: string;
		cpuUsageUsec: number;
		running: number;
		/** The lease the watchdog holds for the session: its attachment generation
		 * and how long it stays live on this boot's clock. 0 means run out, and a
		 * run-out generation is never renewed. */
		lease: { tokenSha256: string; expiresInMs: number } | null;
	}[];
}
/** The commands a session has running, by name: published per session at
 * /run/qorpera-coding/observation-<workerId>.json, so every file stays one read. */
export interface CodingGuestRunning {
	schema: "qorpera.coding-guest-running/v1";
	bootId: string;
	workerId: string;
	running: CodingGuestObservedCommand[];
	moreRunning: number;
}
export interface CodingGuestObservationPorts {
	/** Trusted test composition only. */
	runtimeRoot?: string;
	custodyRoot?: string;
	cgroupRoot?: string;
	protectedUid?: number;
	system?: (executable: string, args: readonly string[]) => Promise<string>;
	bootId?: () => Promise<string>;
	uptimeMs?: () => Promise<number>;
}

/** The command's first bytes, cut at a character boundary. */
export function codingCommandPreview(command: string, bytes = CODING_COMMAND_PREVIEW_BYTES): string {
	const buffer = Buffer.from(command);
	if (buffer.length <= bytes) return command;
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
/** Replaces `name` in `root` with `value`, root 0444, in one rename. */
async function publish(root: string, name: string, value: unknown): Promise<void> {
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > CODING_GUEST_OBSERVATION_MAX_BYTES)
		throw new Error("CODING_GUEST_OBSERVATION_TOO_LARGE");
	const temporary = join(root, `.observation-${randomUUID()}.tmp`);
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o444,
	);
	try {
		await handle.writeFile(text);
		await handle.chmod(0o444);
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, join(root, name));
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}
/** The watchdog's lease of a session (cloud-coding-watchdog.ts), as its generation and remaining time. */
async function leaseOf(
	path: string,
	owner: number,
	bootId: string,
	uptimeMs: number,
): Promise<CodingGuestObservation["sessions"][number]["lease"]> {
	let lease: { leaseTokenSha256?: unknown; bootId?: unknown; expiresAtMonoMs?: unknown };
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.uid !== owner || info.size > 4096) return null;
			lease = JSON.parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (missing(error) || error instanceof SyntaxError) return null;
		throw error;
	}
	if (
		typeof lease.leaseTokenSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(lease.leaseTokenSha256) ||
		!Number.isSafeInteger(lease.expiresAtMonoMs)
	)
		return null;
	return {
		tokenSha256: lease.leaseTokenSha256,
		expiresInMs: lease.bootId === bootId ? Math.max(0, Number(lease.expiresAtMonoMs) - uptimeMs) : 0,
	};
}
async function system(executable: string, args: readonly string[]): Promise<string> {
	try {
		return (
			await executeFile(executable, [...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C" },
				timeout: 10000,
				maxBuffer: 4194304,
			})
		).stdout;
	} catch {
		throw new Error("CODING_GUEST_OBSERVATION_UNCONFIRMED");
	}
}

/** Observes every session attached to this boot (a folder under
 * /run/qorpera-coding with its configuration) and publishes the result,
 * root-owned 0444: the summary at /run/qorpera-coding/observation.json, each
 * session's running commands beside it. Read-only otherwise: nothing is
 * started, stopped or repaired. */
export async function observeCloudCodingGuest(
	ports: CodingGuestObservationPorts = {},
): Promise<CodingGuestObservation> {
	if (!ports.system && (process.platform !== "linux" || process.getuid?.() !== 0))
		throw new Error("CODING_GUEST_OBSERVATION_ROOT_REQUIRED");
	const runtimeRoot = ports.runtimeRoot ?? CLOUD_CODING_GUEST_ROOTS.runtime,
		custodyRoot = ports.custodyRoot ?? CLOUD_CODING_GUEST_ROOTS.custody,
		cgroupRoot = ports.cgroupRoot ?? "/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice",
		owner = ports.protectedUid ?? 0;
	// One instant for every session's lease and processor time: the watchdog's own clock.
	const bootId = ports.bootId
		? await ports.bootId()
		: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const uptimeMs = ports.uptimeMs
		? await ports.uptimeMs()
		: Math.floor(Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000);
	// Created root 0755 by the first session's prepare; a machine with none yet gets it the same way.
	await mkdir(runtimeRoot, { mode: 0o755 }).catch((error) => {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	});
	let names: string[];
	try {
		names = (await readdir(runtimeRoot)).filter((name) => UUID.test(name)).sort();
	} catch (error) {
		if (!missing(error)) throw error;
		names = [];
	}
	const listing = await (ports.system ?? system)("/usr/bin/systemctl", [
		"list-units",
		"--all",
		"--full",
		"--plain",
		"--no-legend",
		"--no-pager",
		"--type=service",
		"qorpera-coding-*.service",
	]);
	// A unit whose processes still run: active (or starting or stopping) and not
	// merely retained after its last process exited (RemainAfterExit).
	const running = new Set(
		listing
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter(
				([unit, _load, active, sub]) =>
					unit?.endsWith(".service") &&
					["active", "activating", "deactivating"].includes(active) &&
					sub !== "exited",
			)
			.map(([unit]) => unit),
	);
	const sessions: CodingGuestObservation["sessions"] = [];
	for (const workerId of names) {
		const layout = cloudCodingSessionLayout(workerId);
		const commands = [...running]
			.filter((unit) => unit.startsWith(layout.unitPrefix))
			.map((unit) => unit.slice(layout.unitPrefix.length, -".service".length))
			.filter((commandId) => UUID.test(commandId))
			.sort();
		const named: CodingGuestObservedCommand[] = [];
		// Named while the file stays one read; the rest are counted.
		let bytes = 1024;
		for (const commandId of commands.slice(0, CODING_GUEST_OBSERVED_COMMANDS)) {
			try {
				const request = JSON.parse(
					await readFile(join(custodyRoot, workerId, "inbox", `${commandId}.json`), {
						encoding: "utf8",
						flag: "r",
					}),
				) as { commandId?: unknown; turn?: unknown; command?: unknown };
				if (
					request.commandId !== commandId ||
					!Number.isSafeInteger(request.turn) ||
					typeof request.command !== "string"
				)
					continue;
				const command = { commandId, turn: request.turn as number, command: codingCommandPreview(request.command) };
				bytes += Buffer.byteLength(JSON.stringify(command)) + 1;
				if (bytes > CODING_GUEST_OBSERVATION_MAX_BYTES) break;
				named.push(command);
			} catch {
				// A command whose staged request cannot be read is still counted below.
			}
		}
		let cpuUsageUsec = 0;
		try {
			const stat = await readFile(join(cgroupRoot, layout.slice, "cpu.stat"), "utf8");
			const usage = /^usage_usec (\d+)$/m.exec(stat);
			if (usage) cpuUsageUsec = Number(usage[1]);
		} catch (error) {
			if (!missing(error)) throw error;
		}
		const report: CodingGuestRunning = {
			schema: "qorpera.coding-guest-running/v1",
			bootId,
			workerId,
			running: named,
			moreRunning: commands.length - named.length,
		};
		await publish(runtimeRoot, `observation-${workerId}.json`, report);
		sessions.push({
			workerId,
			cpuUsageUsec,
			running: commands.length,
			lease: await leaseOf(join(runtimeRoot, workerId, "lease.json"), owner, bootId, uptimeMs),
		});
	}
	// A session detached since the last look leaves no file behind.
	for (const name of await readdir(runtimeRoot))
		if (/^observation-.+\.json$/.test(name) && !names.includes(name.slice("observation-".length, -".json".length)))
			await unlink(join(runtimeRoot, name)).catch((error) => {
				if (!missing(error)) throw error;
			});
	const observation: CodingGuestObservation = {
		schema: "qorpera.coding-guest-observation/v2",
		bootId,
		uptimeMs,
		sessions,
	};
	await publish(runtimeRoot, "observation.json", observation);
	return observation;
}
