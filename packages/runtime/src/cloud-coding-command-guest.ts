import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { refreshCodingGuestLease, requireCodingGuestLease } from "./cloud-coding-watchdog.ts";

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const LIMIT = 4096;
const ROOT = "/var/lib/qorpera-coding";
const ENTRYPOINT = "/opt/qorpera-coding/cloud-coding-command-guest.mjs";
const ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });

export interface CodingGuestCommandRequest {
	readonly schema: "qorpera.coding-command-request/v1";
	readonly workerId: string;
	readonly vmId: string;
	readonly commandId: string;
	readonly requestId: string;
	readonly turn: number;
	readonly inputSha256: string;
	readonly command: string;
	readonly timeoutMs: number;
}
export interface CodingGuestCommandReceipt {
	readonly schema: "qorpera.coding-command-result/v1";
	readonly workerId: string;
	readonly commandId: string;
	readonly inputSha256: string;
	readonly state: "running" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
	readonly exitCode: number | null;
	readonly output: string;
	readonly truncated: boolean;
}
interface GuestConfiguration {
	schema: "qorpera.coding-command-guest/v1";
	workerId: string;
	vmId: string;
	bootId: string;
	uid: number;
	gid: number;
	workspacePath: string;
}
interface Intent {
	schema: "qorpera.coding-command-intent/v1";
	request: CodingGuestCommandRequest;
	commandSha256: string;
	bootId: string;
}
export interface CodingGuestCommandPorts {
	/** Trusted test composition only. Production uses fixed root-owned guest paths. */
	root?: string;
	configurationPath?: string;
	protectedUid?: number;
	protectedDirectoryRoot?: string;
	inspectMachine?: () => Promise<string>;
	nowMs?: () => Promise<number>;
	system?: (executable: string, args: readonly string[]) => Promise<string>;
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error("INVALID_CODING_GUEST_REQUEST");
	return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || value.length !== 36 || !UUID.test(value))
		throw new Error("INVALID_CODING_GUEST_ID");
	return value;
}
export function parseCodingGuestCommandRequest(value: unknown): CodingGuestCommandRequest {
	const input = closed(value, [
		"schema",
		"workerId",
		"vmId",
		"commandId",
		"requestId",
		"turn",
		"inputSha256",
		"command",
		"timeoutMs",
	]);
	if (
		input.schema !== "qorpera.coding-command-request/v1" ||
		Buffer.byteLength(JSON.stringify(input)) > 65536 ||
		!Number.isSafeInteger(input.turn) ||
		(input.turn as number) < 1 ||
		typeof input.inputSha256 !== "string" ||
		input.inputSha256.length !== 64 ||
		!HASH.test(input.inputSha256) ||
		typeof input.command !== "string" ||
		!input.command.trim() ||
		input.command.includes("\0") ||
		/[\ud800-\udfff]/u.test(input.command) ||
		Buffer.byteLength(input.command) > 16384 ||
		!Number.isSafeInteger(input.timeoutMs) ||
		(input.timeoutMs as number) < 1000 ||
		(input.timeoutMs as number) > 1800000
	)
		throw new Error("INVALID_CODING_GUEST_REQUEST");
	return Object.freeze({
		schema: "qorpera.coding-command-request/v1",
		workerId: uuid(input.workerId),
		vmId: uuid(input.vmId),
		commandId: uuid(input.commandId),
		requestId: uuid(input.requestId),
		turn: input.turn as number,
		inputSha256: input.inputSha256,
		command: input.command,
		timeoutMs: input.timeoutMs as number,
	});
}
async function system(executable: string, args: readonly string[]): Promise<string> {
	try {
		return (
			await executeFile(executable, [...args], {
				env: ENV,
				timeout: 10000,
				maxBuffer: 32768,
			})
		).stdout;
	} catch {
		throw new Error("CODING_GUEST_SERVICE_UNCONFIRMED");
	}
}
async function inspectMachine(): Promise<string> {
	if (process.platform !== "linux") throw new Error("CODING_GUEST_REQUIRES_LINUX_VM");
	await system("/usr/bin/systemd-detect-virt", ["--vm", "--quiet"]);
	return uuid((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
}
async function protectedRead(path: string, owner: number, maxBytes: number, boundary = "/"): Promise<Buffer> {
	// Inspect every component and open without following the final link. The
	// deployment owns these directories; the coding user cannot replace them.
	for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
		const stat = await lstat(parent);
		if (!stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o022) !== 0)
			throw new Error("UNPROTECTED_CODING_GUEST_PATH");
		if (parent === boundary) break;
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || (stat.mode & 0o022) !== 0 || stat.size > maxBytes)
			throw new Error("UNPROTECTED_CODING_GUEST_FILE");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}
async function retain(path: string, value: unknown, mode = 0o400): Promise<void> {
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally {
		await handle.close();
	}
	const parent = await open(dirname(path), constants.O_RDONLY);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
async function publishStatus(directory: string, receipt: CodingGuestCommandReceipt): Promise<void> {
	const temporary = join(directory, `status-${randomUUID()}.json`);
	await retain(temporary, receipt);
	await rename(temporary, join(directory, "status.json"));
	const journalDirectory = await open(directory, constants.O_RDONLY);
	try {
		await journalDirectory.sync();
	} finally {
		await journalDirectory.close();
	}
}
async function configuration(ports: CodingGuestCommandPorts): Promise<GuestConfiguration> {
	const configStat = await lstat(ports.configurationPath ?? "/etc/qorpera-coding/guest.json");
	if ((configStat.mode & 0o777) !== 0o444) throw new Error("UNREADABLE_CODING_GUEST_CONFIGURATION");
	const input = closed(
		JSON.parse(
			(
				await protectedRead(
					ports.configurationPath ?? "/etc/qorpera-coding/guest.json",
					ports.protectedUid ?? 0,
					4096,
					ports.protectedDirectoryRoot,
				)
			).toString("utf8"),
		),
		["schema", "workerId", "vmId", "bootId", "uid", "gid", "workspacePath"],
	);
	if (
		input.schema !== "qorpera.coding-command-guest/v1" ||
		!Number.isSafeInteger(input.uid) ||
		(input.uid as number) < 1000 ||
		!Number.isSafeInteger(input.gid) ||
		(input.gid as number) < 1000 ||
		typeof input.workspacePath !== "string" ||
		input.workspacePath !== resolve(input.workspacePath) ||
		input.workspacePath === "/" ||
		/[\s\0]/.test(input.workspacePath)
	)
		throw new Error("INVALID_CODING_GUEST_CONFIGURATION");
	return {
		schema: "qorpera.coding-command-guest/v1",
		workerId: uuid(input.workerId),
		vmId: uuid(input.vmId),
		bootId: uuid(input.bootId),
		uid: input.uid as number,
		gid: input.gid as number,
		workspacePath: input.workspacePath,
	};
}
async function output(
	root: string,
	commandId: string,
	owner: number,
	protectedOwner: number,
	boundary?: string,
): Promise<{ output: string; truncated: boolean }> {
	const path = join(root, "output", commandId, "output.log");
	for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
		const stat = await lstat(parent);
		if (!stat.isDirectory() || stat.uid !== protectedOwner || (stat.mode & 0o022) !== 0)
			throw new Error("UNPROTECTED_CODING_GUEST_OUTPUT_PATH");
		if (parent === boundary) break;
	}
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || stat.size > LIMIT + 1)
			throw new Error("INVALID_CODING_GUEST_OUTPUT");
		const buffer = Buffer.alloc(LIMIT + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const bytes = buffer.subarray(0, bytesRead);
		const normalized = Buffer.from(
			new TextDecoder("utf8", { fatal: false }).decode(bytes.subarray(0, LIMIT), { stream: true }),
		);
		return {
			output: new TextDecoder("utf8").decode(normalized.subarray(0, LIMIT), {
				stream: true,
			}),
			truncated: bytes.length > LIMIT || normalized.length > LIMIT,
		};
	} finally {
		await handle.close();
	}
}

/** Root supervisor installed inside the isolated coding VM only. Every effect
 * retains command identity before contacting systemd. A missing unit following
 * an intent is an unknown outcome, never permission to execute again. */
export async function runCodingGuestCommand(
	action: "start" | "read" | "cancel",
	commandId: string,
	ports: CodingGuestCommandPorts = {},
): Promise<CodingGuestCommandReceipt> {
	uuid(commandId);
	if (!ports.inspectMachine && process.getuid?.() !== 0) throw new Error("CODING_GUEST_SUPERVISOR_REQUIRES_ROOT");
	const root = ports.root ?? ROOT;
	const owner = ports.protectedUid ?? 0;
	const guest = await configuration(ports);
	const bootId = await (ports.inspectMachine ?? inspectMachine)();
	const request = parseCodingGuestCommandRequest(
		JSON.parse(
			(
				await protectedRead(join(root, "inbox", `${commandId}.json`), owner, 131072, ports.protectedDirectoryRoot)
			).toString("utf8"),
		),
	);
	if (request.commandId !== commandId || request.workerId !== guest.workerId || request.vmId !== guest.vmId)
		throw new Error("CODING_GUEST_COMMAND_SCOPE_CHANGED");
	if (action === "start")
		await requireCodingGuestLease(request, guest, {
			...ports,
			inspectBoot: ports.inspectMachine ?? inspectMachine,
		});
	const directory = join(root, "commands", commandId);
	const intentPath = join(directory, "intent.json");
	const commandSha256 = createHash("sha256")
		.update(
			JSON.stringify({
				command: request.command,
				timeoutMs: request.timeoutMs,
			}),
		)
		.digest("hex");
	let intent: Intent | undefined;
	try {
		const saved = closed(
			JSON.parse((await protectedRead(intentPath, owner, 131072, ports.protectedDirectoryRoot)).toString("utf8")),
			["schema", "request", "commandSha256", "bootId"],
		);
		if (
			saved.schema !== "qorpera.coding-command-intent/v1" ||
			saved.commandSha256 !== commandSha256 ||
			JSON.stringify(parseCodingGuestCommandRequest(saved.request)) !== JSON.stringify(request)
		)
			throw new Error("CODING_GUEST_INTENT_CHANGED");
		intent = {
			schema: "qorpera.coding-command-intent/v1",
			request,
			commandSha256,
			bootId: uuid(saved.bootId),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (intent) {
		try {
			const savedCompletion = closed(
				JSON.parse(
					(
						await protectedRead(join(directory, "completion.json"), owner, 32768, ports.protectedDirectoryRoot)
					).toString("utf8"),
				),
				["schema", "workerId", "commandId", "inputSha256", "state", "exitCode", "output", "truncated"],
			);
			if (
				savedCompletion.schema !== "qorpera.coding-command-result/v1" ||
				typeof savedCompletion.output !== "string" ||
				Buffer.byteLength(savedCompletion.output) > LIMIT ||
				/[\ud800-\udfff]/u.test(savedCompletion.output) ||
				typeof savedCompletion.truncated !== "boolean" ||
				!(["succeeded", "failed", "cancelled"] as unknown[]).includes(savedCompletion.state) ||
				(savedCompletion.state === "succeeded" && savedCompletion.exitCode !== 0) ||
				(savedCompletion.state === "cancelled" && savedCompletion.exitCode !== null) ||
				(savedCompletion.state === "failed" &&
					(!Number.isSafeInteger(savedCompletion.exitCode) ||
						(savedCompletion.exitCode as number) < 1 ||
						(savedCompletion.exitCode as number) > 255))
			)
				throw new Error("CODING_GUEST_COMPLETION_CHANGED");
			const completed = savedCompletion as unknown as CodingGuestCommandReceipt;
			if (
				completed.workerId !== request.workerId ||
				completed.commandId !== commandId ||
				completed.inputSha256 !== request.inputSha256
			)
				throw new Error("CODING_GUEST_COMPLETION_CHANGED");
			await publishStatus(directory, completed);
			return completed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const unit = `qorpera-coding-${commandId}.service`;
	const call = ports.system ?? system;
	let cancellation = false;
	if (action === "start" && !intent) {
		if (bootId !== guest.bootId) throw new Error("CODING_GUEST_BOOT_CHANGED");
		await mkdir(directory, { mode: 0o755 });
		const commandRoot = await open(dirname(directory), constants.O_RDONLY);
		try {
			await commandRoot.sync();
		} finally {
			await commandRoot.close();
		}
		intent = {
			schema: "qorpera.coding-command-intent/v1",
			request,
			commandSha256,
			bootId,
		};
		await retain(intentPath, intent, 0o444);
		const logs = join(root, "output", commandId);
		await mkdir(logs, { mode: 0o755 });
		const log = await open(
			join(logs, "output.log"),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		try {
			await log.chown(guest.uid, guest.gid);
			await log.sync();
		} finally {
			await log.close();
		}
		// systemd owns process lifetime independently of this short supervisor.
		// The command itself runs without inherited credentials or a login shell.
		try {
			await call("/usr/bin/systemd-run", [
				"--quiet",
				`--unit=${unit}`,
				`--uid=${guest.uid}`,
				`--gid=${guest.gid}`,
				`--property=WorkingDirectory=${guest.workspacePath}`,
				`--property=RuntimeMaxSec=${Math.ceil(request.timeoutMs / 1000)}`,
				"--property=MemoryMax=2147483648",
				"--property=TasksMax=256",
				"--property=CPUQuota=200%",
				"--property=RemainAfterExit=yes",
				"--property=ExitType=cgroup",
				"--property=KillMode=control-group",
				"--property=Slice=qorpera-coding.slice",
				"--property=TimeoutStopSec=5",
				"--property=NoNewPrivileges=yes",
				"--property=ProtectSystem=strict",
				"--property=ProtectHome=yes",
				"--property=PrivateTmp=yes",
				"--property=PrivateDevices=yes",
				"--property=RestrictSUIDSGID=yes",
				"--property=ProtectKernelTunables=yes",
				"--property=ProtectKernelModules=yes",
				"--property=ProtectControlGroups=yes",
				"--property=ProtectProc=invisible",
				"--property=CapabilityBoundingSet=",
				"--property=AmbientCapabilities=",
				"--property=RestrictNamespaces=yes",
				`--property=ReadWritePaths=${guest.workspacePath} ${logs}`,
				"--property=StandardOutput=null",
				"--property=StandardError=null",
				"/usr/bin/env",
				"-i",
				"PATH=/usr/bin:/bin",
				"LANG=C.UTF-8",
				"/usr/bin/node",
				ENTRYPOINT,
				"execute",
				commandId,
			]);
		} catch {
			/* An unknown submission remains retained and is inspected below. */
		}
	}
	if (action === "cancel" && intent && intent.bootId === bootId) {
		try {
			await retain(join(directory, "cancel.json"), {
				commandId,
				inputSha256: request.inputSha256,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		try {
			await call("/usr/bin/systemctl", ["stop", unit]);
		} catch {
			/* Inspect instead of claiming cancellation. */
		}
	}
	let state: CodingGuestCommandReceipt["state"] = "unconfirmed";
	let exitCode: number | null = null;
	let capture = { output: "", truncated: false };
	if (intent && intent.bootId === bootId) {
		try {
			const status = await call("/usr/bin/systemctl", [
				"show",
				unit,
				"--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus",
			]);
			const fields = Object.fromEntries(
				status
					.trim()
					.split("\n")
					.map((line) => {
						const split = line.indexOf("=");
						return [line.slice(0, split), line.slice(split + 1)];
					}),
			);
			try {
				await protectedRead(join(directory, "cancel.json"), owner, 256, ports.protectedDirectoryRoot);
				cancellation = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (fields.LoadState === "loaded") {
				if (["active", "activating", "deactivating"].includes(fields.ActiveState) && fields.SubState !== "exited")
					state = "running";
				else if (["inactive", "failed"].includes(fields.ActiveState) || fields.SubState === "exited") {
					if (/^\d+$/.test(fields.ExecMainStatus) && fields.ExecMainCode === "1")
						exitCode = Number(fields.ExecMainStatus);
					state = cancellation
						? "cancelled"
						: fields.Result === "success" && exitCode === 0
							? "succeeded"
							: "failed";
					if (state === "cancelled") exitCode = null;
					else if (state === "failed" && (exitCode === null || exitCode < 1 || exitCode > 255)) exitCode = 1;
				}
			}
			capture = await output(root, commandId, guest.uid, owner, ports.protectedDirectoryRoot);
		} catch {
			state = "unconfirmed";
			exitCode = null;
		}
	}
	const receipt: CodingGuestCommandReceipt = {
		schema: "qorpera.coding-command-result/v1",
		workerId: guest.workerId,
		commandId,
		inputSha256: request.inputSha256,
		state,
		exitCode,
		...capture,
	};
	if (intent) {
		if (["succeeded", "failed", "cancelled"].includes(state)) {
			try {
				await retain(join(directory, "completion.json"), receipt);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		await publishStatus(directory, receipt);
	}
	return receipt;
}

/** Fixed systemd child. It streams and drains both pipes but persists at most
 * 4097 bytes; the extra byte is the durable truncation marker. */
export async function executeCodingGuestCommand(commandId: string): Promise<number> {
	uuid(commandId);
	const guest = await configuration({});
	if (
		process.getuid?.() !== guest.uid ||
		process.getgid?.() !== guest.gid ||
		(await inspectMachine()) !== guest.bootId
	)
		throw new Error("CODING_GUEST_EXECUTION_IDENTITY_CHANGED");
	const retained = closed(
		JSON.parse((await protectedRead(join(ROOT, "commands", commandId, "intent.json"), 0, 131072)).toString("utf8")),
		["schema", "request", "commandSha256", "bootId"],
	);
	const request = parseCodingGuestCommandRequest(retained.request);
	if (
		retained.schema !== "qorpera.coding-command-intent/v1" ||
		retained.bootId !== guest.bootId ||
		retained.commandSha256 !==
			createHash("sha256")
				.update(
					JSON.stringify({
						command: request.command,
						timeoutMs: request.timeoutMs,
					}),
				)
				.digest("hex")
	)
		throw new Error("CODING_GUEST_INTENT_CHANGED");
	if (request.workerId !== guest.workerId || request.vmId !== guest.vmId || request.commandId !== commandId)
		throw new Error("CODING_GUEST_COMMAND_SCOPE_CHANGED");
	await requireCodingGuestLease(request, guest, {
		inspectBoot: inspectMachine,
	});
	const handle = await open(join(ROOT, "output", commandId, "output.log"), constants.O_WRONLY | constants.O_NOFOLLOW);
	let bytes = 0;
	let pending = Promise.resolve();
	try {
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", request.command], {
			cwd: guest.workspacePath,
			env: ENV,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const capture = (chunk: Buffer): void => {
			const part = Buffer.from(chunk.subarray(0, Math.max(0, LIMIT + 1 - bytes)));
			bytes += part.length;
			if (part.length)
				pending = pending.then(async () => {
					await handle.write(part);
				});
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const exitCode = await new Promise<number>((resolveExit) => {
			child.once("error", () => resolveExit(127));
			child.once("close", (code) => resolveExit(code ?? 128));
		});
		await pending;
		await handle.sync();
		return exitCode;
	} finally {
		await handle.close();
	}
}

/** Only the trusted root provider may stage this fixed refresh input. The
 * provider must first renew and recheck the matching cloud queue lease. */
export async function refreshCodingGuestCommandLease(ports: CodingGuestCommandPorts = {}) {
	const guest = await configuration(ports);
	await (ports.system ?? system)("/usr/bin/systemctl", ["is-active", "--quiet", "qorpera-coding-watchdog.timer"]);
	const value = JSON.parse(
		(
			await protectedRead(
				join(ports.root ?? ROOT, "inbox", "lease-refresh.json"),
				ports.protectedUid ?? 0,
				4096,
				ports.protectedDirectoryRoot,
			)
		).toString("utf8"),
	);
	return refreshCodingGuestLease(value, guest, {
		...ports,
		inspectBoot: ports.inspectMachine ?? inspectMachine,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, commandId, extra] = process.argv.slice(2);
	try {
		if (extra || (action === "refresh-lease" ? commandId !== undefined : !commandId))
			throw new Error("INVALID_CODING_GUEST_ARGUMENTS");
		if (action === "refresh-lease")
			process.stdout.write(`${JSON.stringify(await refreshCodingGuestCommandLease())}\n`);
		else if (commandId && action === "execute") process.exitCode = await executeCodingGuestCommand(commandId);
		else if (commandId && (action === "start" || action === "read" || action === "cancel"))
			process.stdout.write(`${JSON.stringify(await runCodingGuestCommand(action, commandId))}\n`);
		else throw new Error("INVALID_CODING_GUEST_ARGUMENTS");
	} catch {
		process.stderr.write("CODING_GUEST_COMMAND_REFUSED\n");
		process.exitCode = 1;
	}
}
