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
export interface CodingGuestObservedCommand {
	commandId: string;
	turn: number;
	command: string;
}
/** What runs inside the member's machine, per attached session: the commands
 * whose processes still run and the processor time its slice has used. The
 * executor reads it back (it cannot read a command's stdout through LXD), keeps
 * attachments and decides when the machine is quiet enough to sleep. */
export interface CodingGuestObservation {
	schema: "qorpera.coding-guest-observation/v1";
	bootId: string;
	uptimeMs: number;
	sessions: {
		workerId: string;
		cpuUsageUsec: number;
		running: CodingGuestObservedCommand[];
		moreRunning: number;
	}[];
}
export interface CodingGuestObservationPorts {
	/** Trusted test composition only. */
	runtimeRoot?: string;
	custodyRoot?: string;
	cgroupRoot?: string;
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
 * root-owned 0444, at /run/qorpera-coding/observation.json. Read-only
 * otherwise: nothing is started, stopped or repaired. */
export async function observeCloudCodingGuest(
	ports: CodingGuestObservationPorts = {},
): Promise<CodingGuestObservation> {
	if (!ports.system && (process.platform !== "linux" || process.getuid?.() !== 0))
		throw new Error("CODING_GUEST_OBSERVATION_ROOT_REQUIRED");
	const runtimeRoot = ports.runtimeRoot ?? CLOUD_CODING_GUEST_ROOTS.runtime,
		custodyRoot = ports.custodyRoot ?? CLOUD_CODING_GUEST_ROOTS.custody,
		cgroupRoot = ports.cgroupRoot ?? "/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice";
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
				named.push({ commandId, turn: request.turn as number, command: codingCommandPreview(request.command) });
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
		sessions.push({ workerId, cpuUsageUsec, running: named, moreRunning: commands.length - named.length });
	}
	const observation: CodingGuestObservation = {
		schema: "qorpera.coding-guest-observation/v1",
		bootId: ports.bootId ? await ports.bootId() : (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
		uptimeMs: ports.uptimeMs
			? await ports.uptimeMs()
			: Math.floor(Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000),
		sessions,
	};
	const temporary = join(runtimeRoot, `.observation-${randomUUID()}.tmp`);
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o444,
	);
	try {
		await handle.writeFile(JSON.stringify(observation));
		await handle.chmod(0o444);
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, join(runtimeRoot, "observation.json"));
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
	return observation;
}
