import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	CLOUD_MACHINE_GUEST_PATHS,
	type CloudCodingCommandRead,
	type CloudMachineCommandReceipt,
	type CloudMachineCommandRequest,
	parseCloudCodingCommandRead,
	parseCloudMachineCommandRequest,
} from "@qorpera/contracts";
import { collectCodingCommandOutput, readCodingCommandLog } from "./cloud-coding-command-log.ts";
import { codingErrorCode } from "./cloud-coding-error-code.ts";

// The command guest's machine profile (2026-09-28). A company machine is a
// whole VM for one company job: its commands run as root with no sandbox of
// their own and no deadline unless the agent set one, and Docker works. It
// keeps the command guest's model: a transient systemd unit per command, a
// retained intent before systemd is contacted (a missing unit after an intent
// is an unknown outcome, never permission to start again), bounded logs read
// by byte cursor (cloud-coding-command-log.ts) and a lease that stops the
// commands when the executor has been gone for longer than its lease. The
// state lives on the machine's own disk: there is no NAS custody and no
// session. Root can change all of this; the VM is the boundary, and the
// executor treats everything it reads back as untrusted, bounded data.

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATHS = CLOUD_MACHINE_GUEST_PATHS;
/** 64 MiB of output per command; later output is dropped after one marker. */
export const MACHINE_GUEST_MAX_LOG_BYTES = 67108864;
/** Exit status of an execute step refused before the command started. */
export const MACHINE_GUEST_REFUSED_EXIT_CODE = 125;
const COMMAND_ENV = Object.freeze({
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/root",
	USER: "root",
	LOGNAME: "root",
	SHELL: "/bin/bash",
	LANG: "C.UTF-8",
	DEBIAN_FRONTEND: "noninteractive",
});
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "lost"]);

export interface MachineGuestPorts {
	stateRoot?: string;
	runtimeRoot?: string;
	helper?: string;
	/** Linux uptime in milliseconds: monotonic across wall-clock steps. */
	nowMs?: () => Promise<number>;
	bootId?: () => Promise<string>;
	system?: (executable: string, args: readonly string[]) => Promise<string>;
	/** The first line of /proc/stat. */
	readCpu?: () => Promise<string>;
	/** Where commands start (/root). */
	home?: string;
	requireRoot?: boolean;
}
interface Identity {
	schema: "qorpera.machine-guest/v1";
	machineId: string;
	bootId: string;
	generation: number;
}
interface Intent {
	schema: "qorpera.machine-command-intent/v1";
	request: CloudMachineCommandRequest;
	bootId: string;
}
interface Completion {
	schema: "qorpera.machine-command-completion/v1";
	state: "succeeded" | "failed" | "cancelled" | "lost";
	exitCode: number | null;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("INVALID_MACHINE_GUEST_ID");
	return value;
}
function roots(ports: MachineGuestPorts) {
	const state = ports.stateRoot ?? PATHS.state,
		runtime = ports.runtimeRoot ?? PATHS.runtime;
	return {
		state,
		runtime,
		inbox: join(state, "inbox"),
		commands: join(state, "commands"),
		replies: join(runtime, "replies"),
		identity: join(runtime, "machine.json"),
		lease: join(runtime, "lease.json"),
	};
}
async function system(executable: string, args: readonly string[]): Promise<string> {
	try {
		return (
			await executeFile(executable, [...args], {
				env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
				timeout: 15000,
				maxBuffer: 65536,
			})
		).stdout;
	} catch {
		throw new Error("MACHINE_GUEST_SERVICE_UNCONFIRMED");
	}
}
async function uptimeMs(): Promise<number> {
	const seconds = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]);
	if (!Number.isFinite(seconds) || seconds < 0) throw new Error("MACHINE_GUEST_CLOCK_UNAVAILABLE");
	return Math.floor(seconds * 1000);
}
async function currentBoot(): Promise<string> {
	return uuid((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
}
async function readJson(path: string, maxBytes: number): Promise<unknown> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("MACHINE_GUEST_FILE_INVALID");
		return JSON.parse((await handle.readFile()).toString("utf8"));
	} finally {
		await handle.close();
	}
}
/** Written whole, synced, then renamed into place. */
async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path);
}
/** Created once; an existing record is never replaced. */
async function retain(path: string, value: unknown): Promise<boolean> {
	try {
		const handle = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o400,
		);
		try {
			await handle.writeFile(JSON.stringify(value));
			await handle.sync();
		} finally {
			await handle.close();
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}
async function missing<T>(read: () => Promise<T>): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function requireRoot(ports: MachineGuestPorts): void {
	if ((ports.requireRoot ?? true) && process.getuid?.() !== 0) throw new Error("MACHINE_GUEST_REQUIRES_ROOT");
}

async function identity(ports: MachineGuestPorts): Promise<Identity> {
	const value = (await readJson(roots(ports).identity, 4096)) as Record<string, unknown>;
	if (
		!value ||
		Object.keys(value).sort().join() !== "bootId,generation,machineId,schema" ||
		value.schema !== "qorpera.machine-guest/v1" ||
		!Number.isSafeInteger(value.generation) ||
		Number(value.generation) < 1
	)
		throw new Error("MACHINE_GUEST_IDENTITY_INVALID");
	uuid(value.machineId);
	if (uuid(value.bootId) !== (await (ports.bootId ?? currentBoot)())) throw new Error("MACHINE_GUEST_BOOT_CHANGED");
	return value as unknown as Identity;
}

/** The executor claims this boot for its machine: the machine's id and the
 * executor's generation for this boot. Claiming again in the same boot keeps
 * the machine and only moves the generation forward. */
export async function prepareMachineGuest(
	machineId: string,
	generation: number,
	ports: MachineGuestPorts = {},
): Promise<Identity> {
	requireRoot(ports);
	uuid(machineId);
	if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("MACHINE_GUEST_GENERATION_INVALID");
	const r = roots(ports);
	for (const [path, mode] of [
		[r.state, 0o700],
		[r.inbox, 0o700],
		[r.commands, 0o755],
		[r.runtime, 0o755],
		[r.replies, 0o700],
	] as const)
		await mkdir(path, { recursive: true, mode });
	const bootId = await (ports.bootId ?? currentBoot)();
	const prior = await missing(() => identity(ports)).catch(() => undefined);
	if (prior && prior.machineId !== machineId) throw new Error("MACHINE_GUEST_BELONGS_TO_ANOTHER_MACHINE");
	const next: Identity = {
		schema: "qorpera.machine-guest/v1",
		machineId,
		bootId,
		generation: Math.max(generation, prior?.generation ?? 0),
	};
	await writeJson(r.identity, next, 0o644);
	return next;
}

/** The executor renews the lease every pass. Its length is long on purpose:
 * machine jobs run for hours and must outlive an executor restart or a
 * release cut; the lease only stops commands the control plane lost. */
export async function refreshMachineLease(ttlMs: number, ports: MachineGuestPorts = {}) {
	requireRoot(ports);
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 10000 || ttlMs > 3600000) throw new Error("MACHINE_GUEST_LEASE_INVALID");
	const guest = await identity(ports);
	const now = await (ports.nowMs ?? uptimeMs)();
	const lease = {
		schema: "qorpera.machine-guest-lease/v1",
		machineId: guest.machineId,
		bootId: guest.bootId,
		generation: guest.generation,
		expiresAtMonoMs: now + ttlMs,
	};
	await writeJson(roots(ports).lease, lease, 0o644);
	return {
		schema: "qorpera.machine-guest-lease-receipt/v1",
		machineId: guest.machineId,
		bootId: guest.bootId,
		validForMs: ttlMs,
	};
}
async function leaseLive(ports: MachineGuestPorts): Promise<boolean> {
	try {
		const guest = await identity(ports);
		const lease = (await readJson(roots(ports).lease, 4096)) as Record<string, unknown>;
		const now = await (ports.nowMs ?? uptimeMs)();
		return (
			lease.schema === "qorpera.machine-guest-lease/v1" &&
			lease.machineId === guest.machineId &&
			lease.bootId === guest.bootId &&
			Number.isSafeInteger(lease.expiresAtMonoMs) &&
			now < Number(lease.expiresAtMonoMs)
		);
	} catch {
		return false;
	}
}
/** Run by the watchdog timer: without a live lease, every command stops. */
export async function runMachineWatchdog(ports: MachineGuestPorts = {}): Promise<"live" | "stopped"> {
	requireRoot(ports);
	if (await leaseLive(ports)) return "live";
	await (ports.system ?? system)("/usr/bin/systemctl", ["stop", PATHS.slice]);
	return "stopped";
}

function commandPaths(ports: MachineGuestPorts, commandId: string) {
	const directory = join(roots(ports).commands, uuid(commandId));
	return {
		directory,
		intent: join(directory, "intent.json"),
		completion: join(directory, "completion.json"),
		cancel: join(directory, "cancel.json"),
		log: join(directory, "output.log"),
		unit: `${PATHS.unitPrefix}${commandId}.service`,
	};
}
function commandSha(request: CloudMachineCommandRequest): string {
	return createHash("sha256")
		.update(JSON.stringify({ command: request.command, timeoutMs: request.timeoutMs }))
		.digest("hex");
}
async function readIntent(ports: MachineGuestPorts, commandId: string): Promise<Intent | undefined> {
	const value = (await missing(() => readJson(commandPaths(ports, commandId).intent, 131072))) as
		| Record<string, unknown>
		| undefined;
	if (!value) return undefined;
	if (
		Object.keys(value).sort().join() !== "bootId,request,schema" ||
		value.schema !== "qorpera.machine-command-intent/v1"
	)
		throw new Error("MACHINE_GUEST_INTENT_INVALID");
	const request = parseCloudMachineCommandRequest(value.request);
	if (request.commandId !== commandId) throw new Error("MACHINE_GUEST_INTENT_INVALID");
	return { schema: "qorpera.machine-command-intent/v1", request, bootId: uuid(value.bootId) };
}
async function readCompletion(ports: MachineGuestPorts, commandId: string): Promise<Completion | undefined> {
	const value = (await missing(() => readJson(commandPaths(ports, commandId).completion, 4096))) as
		| Record<string, unknown>
		| undefined;
	if (!value) return undefined;
	if (
		value.schema !== "qorpera.machine-command-completion/v1" ||
		!TERMINAL.has(String(value.state)) ||
		(value.exitCode !== null &&
			(!Number.isInteger(value.exitCode) || Number(value.exitCode) < 0 || Number(value.exitCode) > 255))
	)
		throw new Error("MACHINE_GUEST_COMPLETION_INVALID");
	return value as unknown as Completion;
}

/** The command's state as systemd and the retained records show it. A
 * command of an earlier boot is lost: the machine stopped or restarted. */
async function observe(
	ports: MachineGuestPorts,
	commandId: string,
	intent: Intent,
	bootId: string,
): Promise<{ state: CloudMachineCommandReceipt["state"]; exitCode: number | null }> {
	const done = await readCompletion(ports, commandId);
	if (done) return { state: done.state, exitCode: done.exitCode };
	const paths = commandPaths(ports, commandId);
	let state: CloudMachineCommandReceipt["state"] = "unconfirmed";
	let exitCode: number | null = null;
	if (intent.bootId !== bootId) state = "lost";
	else {
		try {
			const fields = Object.fromEntries(
				(
					await (ports.system ?? system)("/usr/bin/systemctl", [
						"show",
						paths.unit,
						"--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus",
					])
				)
					.trim()
					.split("\n")
					.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
			);
			const cancelled = !!(await missing(() => lstat(paths.cancel)));
			if (fields.LoadState === "loaded") {
				if (["active", "activating", "deactivating"].includes(fields.ActiveState) && fields.SubState !== "exited")
					state = "running";
				else if (["inactive", "failed"].includes(fields.ActiveState) || fields.SubState === "exited") {
					if (/^\d+$/.test(fields.ExecMainStatus) && fields.ExecMainCode === "1")
						exitCode = Number(fields.ExecMainStatus);
					state = cancelled ? "cancelled" : fields.Result === "success" && exitCode === 0 ? "succeeded" : "failed";
					if (state === "cancelled") exitCode = null;
					else if (state === "failed" && (exitCode === null || exitCode < 1 || exitCode > 255)) exitCode = 1;
				}
			}
		} catch {
			state = "unconfirmed";
			exitCode = null;
		}
	}
	if (state === "lost") exitCode = null;
	if (TERMINAL.has(state)) {
		await retain(paths.completion, { schema: "qorpera.machine-command-completion/v1", state, exitCode });
		// The finished unit has told us everything; let systemd forget it.
		if (state !== "lost")
			await (ports.system ?? system)("/usr/bin/systemctl", ["stop", paths.unit]).catch(() => undefined);
	}
	return { state, exitCode };
}
async function receipt(
	ports: MachineGuestPorts,
	guest: Identity,
	commandId: string,
	read: Omit<CloudCodingCommandRead, "commandId">,
): Promise<CloudMachineCommandReceipt> {
	const intent = await readIntent(ports, commandId);
	if (!intent) throw new Error("MACHINE_COMMAND_UNKNOWN");
	if (intent.request.machineId !== guest.machineId) throw new Error("MACHINE_GUEST_COMMAND_SCOPE_CHANGED");
	const { state, exitCode } = await observe(ports, commandId, intent, guest.bootId);
	const paths = commandPaths(ports, commandId);
	const page = await readCodingCommandLog({
		path: paths.log,
		owner: 0,
		protectedOwner: 0,
		mountRoot: roots(ports).state,
		boundary: roots(ports).state,
		maxBytes: MACHINE_GUEST_MAX_LOG_BYTES,
		read: parseCloudCodingCommandRead({ commandId, ...read }),
		terminal: TERMINAL.has(state),
	}).catch(() => ({
		output: "",
		truncated: false,
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: MACHINE_GUEST_MAX_LOG_BYTES, limitReached: false },
	}));
	return {
		schema: "qorpera.machine-command-result/v1",
		machineId: guest.machineId,
		commandId,
		inputSha256: intent.request.inputSha256,
		state,
		exitCode,
		...page,
	};
}

/** Starts the command the executor placed in the inbox, exactly once. */
export async function startMachineCommand(
	commandId: string,
	ports: MachineGuestPorts = {},
): Promise<CloudMachineCommandReceipt> {
	requireRoot(ports);
	uuid(commandId);
	const guest = await identity(ports);
	const request = parseCloudMachineCommandRequest(
		await readJson(join(roots(ports).inbox, `${commandId}.json`), 131072),
	);
	if (request.commandId !== commandId || request.machineId !== guest.machineId)
		throw new Error("MACHINE_GUEST_COMMAND_SCOPE_CHANGED");
	const paths = commandPaths(ports, commandId);
	const existing = await readIntent(ports, commandId);
	if (existing) {
		if (commandSha(existing.request) !== commandSha(request) || existing.request.inputSha256 !== request.inputSha256)
			throw new Error("MACHINE_GUEST_INTENT_CHANGED");
		return receipt(ports, guest, commandId, {});
	}
	if (!(await leaseLive(ports))) throw new Error("MACHINE_GUEST_LEASE_UNAVAILABLE");
	await mkdir(paths.directory, { mode: 0o755 });
	await retain(paths.intent, { schema: "qorpera.machine-command-intent/v1", request, bootId: guest.bootId });
	const log = await open(
		paths.log,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	await log.sync();
	await log.close();
	try {
		// systemd owns the command's lifetime, independent of this short helper.
		await (ports.system ?? system)("/usr/bin/systemd-run", [
			"--quiet",
			`--unit=${paths.unit}`,
			`--property=Slice=${PATHS.slice}`,
			"--property=WorkingDirectory=/root",
			...(request.timeoutMs === null ? [] : [`--property=RuntimeMaxSec=${Math.ceil(request.timeoutMs / 1000)}`]),
			"--property=RemainAfterExit=yes",
			"--property=ExitType=cgroup",
			"--property=KillMode=control-group",
			"--property=TimeoutStopSec=10",
			"--property=StandardOutput=null",
			"--property=StandardError=journal",
			"/usr/bin/env",
			"-i",
			`PATH=${COMMAND_ENV.PATH}`,
			"LANG=C.UTF-8",
			"/usr/bin/node",
			ports.helper ?? PATHS.helper,
			"execute",
			commandId,
		]);
	} catch {
		/* An unknown submission stays retained and is observed below. */
	}
	return receipt(ports, guest, commandId, {});
}

export async function readMachineCommand(
	commandId: string,
	read: Omit<CloudCodingCommandRead, "commandId">,
	ports: MachineGuestPorts = {},
): Promise<CloudMachineCommandReceipt> {
	requireRoot(ports);
	return receipt(ports, await identity(ports), uuid(commandId), read);
}

export async function cancelMachineCommand(
	commandId: string,
	ports: MachineGuestPorts = {},
): Promise<CloudMachineCommandReceipt> {
	requireRoot(ports);
	const guest = await identity(ports);
	const paths = commandPaths(ports, uuid(commandId));
	const intent = await readIntent(ports, commandId);
	if (!intent) throw new Error("MACHINE_COMMAND_UNKNOWN");
	if (intent.bootId === guest.bootId && !(await readCompletion(ports, commandId))) {
		await retain(paths.cancel, { commandId });
		await (ports.system ?? system)("/usr/bin/systemctl", ["stop", paths.unit]).catch(() => undefined);
	}
	return receipt(ports, guest, commandId, {});
}

/** One look inside for the executor's pass: how each listed command stands
 * (only the ended ones are reported, with the end of their output) and the
 * processor time used so far, from which the executor sees a busy machine. */
export async function observeMachine(commandIds: readonly string[], ports: MachineGuestPorts = {}) {
	requireRoot(ports);
	if (commandIds.length > 64) throw new Error("MACHINE_GUEST_OBSERVATION_INVALID");
	const guest = await identity(ports);
	const ended: { commandId: string; state: string; exitCode: number | null; outputTail: string }[] = [];
	for (const commandId of commandIds) {
		let current: CloudMachineCommandReceipt;
		try {
			current = await receipt(ports, guest, uuid(commandId), { tail: true, limit: 2000 });
		} catch (error) {
			// The executor lists what SQL knows; a command whose start never reached here is lost.
			if (error instanceof Error && error.message === "MACHINE_COMMAND_UNKNOWN") {
				ended.push({ commandId, state: "lost", exitCode: null, outputTail: "" });
				continue;
			}
			throw error;
		}
		if (TERMINAL.has(current.state))
			ended.push({ commandId, state: current.state, exitCode: current.exitCode, outputTail: current.output });
	}
	const cpu = (await (ports.readCpu ?? (() => readFile("/proc/stat", "utf8")))())
		.split("\n")[0]
		.trim()
		.split(/\s+/)
		.slice(1)
		.map(Number);
	const total = cpu.reduce((sum, value) => sum + value, 0),
		idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
	return {
		schema: "qorpera.machine-observation/v1",
		machineId: guest.machineId,
		bootId: guest.bootId,
		cpu: { busyTicks: total - idle, totalTicks: total },
		ended,
	};
}

async function refuse(ports: MachineGuestPorts, commandId: string, code: string): Promise<void> {
	try {
		const handle = await open(
			commandPaths(ports, commandId).log,
			constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
		);
		try {
			if ((await handle.stat()).size === 0) await handle.write(`${code}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		/* The exit status alone still reports the refusal. */
	}
}
/** Inside the command's unit: checks the retained intent and the lease, then
 * runs the command as root in a login shell and keeps its output. */
export async function executeMachineCommand(commandId: string, ports: MachineGuestPorts = {}): Promise<number> {
	let request: CloudMachineCommandRequest;
	try {
		requireRoot(ports);
		const guest = await identity(ports);
		const intent = await readIntent(ports, commandId);
		if (!intent || intent.bootId !== guest.bootId || intent.request.machineId !== guest.machineId)
			throw new Error("MACHINE_GUEST_INTENT_INVALID");
		if (!(await leaseLive(ports))) throw new Error("MACHINE_GUEST_LEASE_UNAVAILABLE");
		request = intent.request;
	} catch (error) {
		const code = codingErrorCode(error);
		process.stderr.write(`MACHINE_GUEST_COMMAND_REFUSED ${code}\n`);
		if (UUID.test(String(commandId))) await refuse(ports, commandId, code);
		return MACHINE_GUEST_REFUSED_EXIT_CODE;
	}
	const handle = await open(
		commandPaths(ports, commandId).log,
		constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
	);
	try {
		const child = spawn("/bin/bash", ["-l", "-c", request.command], {
			cwd: ports.home ?? "/root",
			env: { ...COMMAND_ENV, ...(ports.home ? { HOME: ports.home } : {}) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = new Promise<number>((resolveExit) => {
			child.once("error", () => resolveExit(127));
			child.once("close", (code) => resolveExit(code ?? 128));
		});
		const collected = collectCodingCommandOutput([child.stdout, child.stderr], handle, MACHINE_GUEST_MAX_LOG_BYTES);
		collected.catch(() => {
			child.kill("SIGKILL");
		});
		const exitCode = await exited;
		await collected;
		await handle.sync();
		return exitCode;
	} finally {
		await handle.close();
	}
}

/** Every answer goes to a reply file the executor reads back (LXD exec
 * returns no output); old replies are removed on the way. */
async function reply(ports: MachineGuestPorts, nonce: string, value: unknown): Promise<void> {
	const directory = roots(ports).replies;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const now = Date.now();
	for (const name of await readdir(directory).catch(() => [] as string[]))
		if (/^[0-9a-f-]{36}\.json$/.test(name)) {
			const stat = await lstat(join(directory, name)).catch(() => undefined);
			if (stat && now - stat.mtimeMs > 300000) await rm(join(directory, name), { force: true });
		}
	await writeJson(join(directory, `${uuid(nonce)}.json`), value);
}

export async function runMachineGuestCli(argv: readonly string[], ports: MachineGuestPorts = {}): Promise<number> {
	const [first, second, ...rest] = argv;
	if (first === "execute" && second && rest.length === 0) return executeMachineCommand(second, ports);
	if (first === "watchdog" && second === undefined) {
		await runMachineWatchdog(ports);
		return 0;
	}
	const nonce = uuid(first);
	let result: unknown;
	try {
		const [a, b, c] = rest;
		if (second === "prepare" && rest.length === 2) result = await prepareMachineGuest(uuid(a), Number(b), ports);
		else if (second === "refresh-lease" && rest.length === 1 && /^[1-9][0-9]{4,6}$/.test(a))
			result = await refreshMachineLease(Number(a), ports);
		else if (second === "start" && rest.length === 1) result = await startMachineCommand(a, ports);
		else if (second === "cancel" && rest.length === 1) result = await cancelMachineCommand(a, ports);
		else if (second === "read" && rest.length >= 1 && rest.length <= 3) {
			if (
				(b !== undefined && b !== "tail" && !/^(0|[1-9][0-9]*)$/.test(b)) ||
				(c !== undefined && !/^[1-9][0-9]*$/.test(c))
			)
				throw new Error("INVALID_MACHINE_GUEST_ARGUMENTS");
			const read =
				b === undefined
					? {}
					: b === "tail"
						? { tail: true, limit: Number(c ?? 4096) }
						: { offset: Number(b), limit: Number(c ?? 4096) };
			result = await readMachineCommand(a, read, ports);
		} else if (second === "observe" && rest.length === 1)
			result = await observeMachine(a === "-" ? [] : a.split(","), ports);
		else throw new Error("INVALID_MACHINE_GUEST_ARGUMENTS");
	} catch (error) {
		result = { schema: "qorpera.machine-guest-refusal/v1", code: codingErrorCode(error) };
	}
	await reply(ports, nonce, result);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runMachineGuestCli(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		() => {
			process.stderr.write("MACHINE_GUEST_REFUSED\n");
			process.exitCode = 1;
		},
	);
}
