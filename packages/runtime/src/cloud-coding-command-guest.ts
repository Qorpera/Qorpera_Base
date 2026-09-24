import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	CLOUD_CODING_GUEST_ROOTS,
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	cloudCodingSessionLayout,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import { collectCodingCommandOutput, readCodingCommandLog } from "./cloud-coding-command-log.ts";
import { codingErrorCode } from "./cloud-coding-error-code.ts";
import {
	type CodingGuestConfiguration,
	type CodingGuestFolders,
	parseCodingGuestConfiguration,
} from "./cloud-coding-guest-configuration.ts";
import { assertCloudCodingGuestStorage, type CodingGuestSandbox } from "./cloud-coding-storage-guest.ts";

import { refreshCodingGuestLease, requireCodingGuestLease } from "./cloud-coding-watchdog.ts";

const executeFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ENTRYPOINT = "/opt/qorpera-coding/cloud-coding-command-guest.mjs";
const ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
/** Exit status of an execute step refused before the command started. Its
 * output.log then holds one line with only the fixed refusal code. */
export const CODING_GUEST_REFUSED_EXIT_CODE = 125;

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
export type CodingGuestCommandReceipt = CloudCodingCommandReceipt;
interface Intent {
	schema: "qorpera.coding-command-intent/v1";
	request: CodingGuestCommandRequest;
	commandSha256: string;
	bootId: string;
}
export interface CodingGuestCommandPorts {
	/** Trusted test composition only. Production uses the session's fixed
	 * layout (cloudCodingSessionLayout): its custody root and configuration. */
	root?: string;
	configurationPath?: string;
	folders?: CodingGuestFolders;
	protectedUid?: number;
	protectedDirectoryRoot?: string;
	inspectMachine?: () => Promise<string>;
	nowMs?: () => Promise<number>;
	system?: (executable: string, args: readonly string[]) => Promise<string>;
	assertStorage?: (guest: CodingGuestConfiguration, sandbox?: CodingGuestSandbox) => Promise<void>;
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
/** The command unit's ReadWritePaths, in order. The execute step asserts its
 * storage against exactly these, so the two cannot drift apart. */
export function codingCommandWritablePaths(guest: CodingGuestConfiguration, commandId: string): string[] {
	return [guest.workspacePath, guest.homePath, guest.cachePath, join(guest.outputRoot, uuid(commandId))];
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
async function protectedRead(
	path: string,
	owner: number,
	maxBytes: number,
	boundary = "/",
	mountRoot?: string,
): Promise<Buffer> {
	// Inspect every component and open without following the final link. The
	// deployment owns these directories; the coding user cannot replace them.
	for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
		const stat = await lstat(parent);
		// The session's separately verified NAS custody mount root is owned by
		// the trusted host service. Descendants and all other ancestors remain root-owned.
		if (!stat.isDirectory() || (stat.uid !== owner && parent !== mountRoot) || (stat.mode & 0o022) !== 0)
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
async function publishStatus(
	directory: string,
	receipt: CodingGuestCommandReceipt,
	read?: CloudCodingCommandRead,
): Promise<void> {
	const temporary = join(directory, `status-${randomUUID()}.json`);
	await retain(temporary, receipt);
	await rename(temporary, join(directory, "status.json"));
	if (read) {
		const query = parseCloudCodingCommandRead(read);
		const slot =
			Number.parseInt(createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 2), 16) % 32;
		const page = join(directory, `page-${randomUUID()}.json`);
		await retain(page, { schema: "qorpera.coding-command-page/v1", query, receipt });
		await rename(page, join(directory, `read-page-${slot}.json`));
	}
	const journalDirectory = await open(directory, constants.O_RDONLY);
	try {
		await journalDirectory.sync();
	} finally {
		await journalDirectory.close();
	}
}
async function configuration(ports: CodingGuestCommandPorts, workerId: string): Promise<CodingGuestConfiguration> {
	const path = ports.configurationPath ?? `${cloudCodingSessionLayout(workerId).configurationRoot}/guest.json`;
	if (((await lstat(path)).mode & 0o777) !== 0o444) throw new Error("UNREADABLE_CODING_GUEST_CONFIGURATION");
	const guest = parseCodingGuestConfiguration(
		JSON.parse(
			(await protectedRead(path, ports.protectedUid ?? 0, 8192, ports.protectedDirectoryRoot)).toString("utf8"),
		),
		ports.folders,
	);
	if (guest.workerId !== workerId) throw new Error("CODING_GUEST_COMMAND_SCOPE_CHANGED");
	return guest;
}
/** The session's custody root: its commands, inbox and logs. */
function custody(ports: CodingGuestCommandPorts, workerId: string): string {
	return ports.root ?? cloudCodingSessionLayout(workerId).custodyRoot;
}

/** Root supervisor installed inside the isolated coding machine only, acting
 * for one attached session. Every effect retains command identity before
 * contacting systemd. A missing unit following an intent is an unknown
 * outcome, never permission to execute again. */
export async function runCodingGuestCommand(
	action: "start" | "read" | "cancel",
	workerId: string,
	commandId: string,
	ports: CodingGuestCommandPorts = {},
	read: Omit<CloudCodingCommandRead, "commandId"> = {},
): Promise<CodingGuestCommandReceipt> {
	uuid(workerId);
	uuid(commandId);
	if (!ports.inspectMachine && process.getuid?.() !== 0) throw new Error("CODING_GUEST_SUPERVISOR_REQUIRES_ROOT");
	const root = custody(ports, workerId);
	const owner = ports.protectedUid ?? 0;
	const guest = await configuration(ports, workerId);
	const layout = cloudCodingSessionLayout(workerId);
	await (ports.assertStorage ?? assertCloudCodingGuestStorage)(guest);
	const query = parseCloudCodingCommandRead({ commandId, ...read });
	const capture = (terminal: boolean) =>
		readCodingCommandLog({
			path: join(guest.outputRoot, commandId, "output.log"),
			owner: guest.uid,
			protectedOwner: owner,
			mountRoot: root,
			boundary: ports.protectedDirectoryRoot,
			maxBytes: guest.resourceProfile.maxLogBytes,
			read: query,
			terminal,
		});
	const bootId = await (ports.inspectMachine ?? inspectMachine)();
	const request = parseCodingGuestCommandRequest(
		JSON.parse(
			(
				await protectedRead(
					join(root, "inbox", `${commandId}.json`),
					owner,
					131072,
					ports.protectedDirectoryRoot,
					root,
				)
			).toString("utf8"),
		),
	);
	if (request.commandId !== commandId || request.workerId !== guest.workerId || request.vmId !== guest.vmId)
		throw new Error("CODING_GUEST_COMMAND_SCOPE_CHANGED");
	if (request.timeoutMs > guest.resourceProfile.maxTimeoutMs) throw new Error("CODING_COMMAND_PROFILE_TIMEOUT");
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
			JSON.parse(
				(await protectedRead(intentPath, owner, 131072, ports.protectedDirectoryRoot, root)).toString("utf8"),
			),
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
			const completed = parseCloudCodingCommandReceipt(
				JSON.parse(
					(
						await protectedRead(
							join(directory, "completion.json"),
							owner,
							131072,
							ports.protectedDirectoryRoot,
							root,
						)
					).toString("utf8"),
				),
			);
			if (!["succeeded", "failed", "cancelled"].includes(completed.state))
				throw new Error("CODING_GUEST_COMPLETION_CHANGED");
			if (
				completed.workerId !== request.workerId ||
				completed.commandId !== commandId ||
				completed.inputSha256 !== request.inputSha256
			)
				throw new Error("CODING_GUEST_COMPLETION_CHANGED");
			const page = { ...completed, ...(await capture(true)) };
			await publishStatus(directory, page, action === "read" ? query : undefined);
			return page;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const unit = `${layout.unitPrefix}${commandId}.service`;
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
		const writablePaths = codingCommandWritablePaths(guest, commandId),
			logs = writablePaths[3];
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
				`--property=MemoryMax=${guest.resourceProfile.memoryBytes}`,
				`--property=TasksMax=${guest.resourceProfile.tasksMax}`,
				`--property=CPUQuota=${guest.resourceProfile.cpuQuotaPercent}%`,
				"--property=RemainAfterExit=yes",
				"--property=ExitType=cgroup",
				"--property=KillMode=control-group",
				`--property=Slice=${layout.slice}`,
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
				// Each command gets its own System V IPC and POSIX message queues.
				// Sessions still share the machine's network (loopback included)
				// and /dev/shm, which uid and file mode guard.
				"--property=PrivateIPC=yes",
				// Only this session under the machine's guest roots, also against
				// sessions attached while the command runs. Its roots are bound
				// read-only: only the ReadWritePaths below are writable, so a command
				// cannot rewrite an earlier command's log of the same session.
				`--property=TemporaryFileSystem=${CLOUD_CODING_GUEST_ROOTS.data} ${CLOUD_CODING_GUEST_ROOTS.custody}`,
				`--property=BindReadOnlyPaths=${layout.dataRoot} ${layout.custodyRoot}`,
				`--property=ReadWritePaths=${writablePaths.join(" ")}`,
				"--property=StandardOutput=null",
				// Only the helper's own fixed refusal line reaches stderr (the
				// command's output is piped to its log); the journal stays in the VM.
				"--property=StandardError=journal",
				"/usr/bin/env",
				"-i",
				"PATH=/usr/bin:/bin",
				"LANG=C.UTF-8",
				"/usr/bin/node",
				ENTRYPOINT,
				"execute",
				workerId,
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
	let captured: Pick<CloudCodingCommandReceipt, "output" | "truncated" | "log"> = {
		output: "",
		truncated: false,
		log: {
			offset: 0,
			nextOffset: 0,
			totalBytes: 0,
			limitBytes: guest.resourceProfile.maxLogBytes,
			limitReached: false,
		},
	};
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
				await protectedRead(join(directory, "cancel.json"), owner, 256, ports.protectedDirectoryRoot, root);
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
			captured = await capture(["succeeded", "failed", "cancelled"].includes(state));
		} catch {
			state = "unconfirmed";
			exitCode = null;
		}
	}
	if (intent && intent.bootId !== bootId) {
		// Reboot loses the process observation, not the retained task log. It
		// cannot turn that unknown outcome into permission to execute again.
		try {
			captured = await capture(true);
		} catch {
			/* Remain explicitly unconfirmed. */
		}
	}
	const receipt: CodingGuestCommandReceipt = {
		schema: "qorpera.coding-command-result/v2",
		workerId: guest.workerId,
		commandId,
		inputSha256: request.inputSha256,
		state,
		exitCode,
		...captured,
	};
	if (intent) {
		if (["succeeded", "failed", "cancelled"].includes(state)) {
			try {
				await retain(join(directory, "completion.json"), receipt);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		await publishStatus(directory, receipt, action === "read" ? query : undefined);
	}
	return receipt;
}

/** Everything the execute step checks before it starts the command. */
async function prepareExecution(workerId: string, commandId: string, ports: CodingGuestCommandPorts) {
	uuid(workerId);
	uuid(commandId);
	const guest = await configuration(ports, workerId);
	// Inside the command unit: ProtectSystem=strict and ReadWritePaths change
	// the mount view, so assert against exactly the paths the unit declares.
	await (ports.assertStorage ?? assertCloudCodingGuestStorage)(guest, {
		writablePaths: codingCommandWritablePaths(guest, commandId),
	});
	const inspect = ports.inspectMachine ?? inspectMachine;
	if (process.getuid?.() !== guest.uid || process.getgid?.() !== guest.gid || (await inspect()) !== guest.bootId)
		throw new Error("CODING_GUEST_EXECUTION_IDENTITY_CHANGED");
	const retained = closed(
		JSON.parse(
			(
				await protectedRead(
					join(custody(ports, workerId), "commands", commandId, "intent.json"),
					ports.protectedUid ?? 0,
					131072,
					ports.protectedDirectoryRoot,
					custody(ports, workerId),
				)
			).toString("utf8"),
		),
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
	await requireCodingGuestLease(request, guest, { ...ports, inspectBoot: inspect });
	await mkdir(join(guest.cachePath, "tmp"), { recursive: true, mode: 0o700 });
	const handle = await open(
		join(guest.outputRoot, commandId, "output.log"),
		constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
	);
	return { guest, request, handle };
}

/** The refusal line: only a fixed code, only into this command's own empty,
 * singly linked log that the root supervisor pre-created for this uid. The
 * path is the fixed custody layout, so it holds even when the configuration
 * could not be read. Never creates, follows or appends to anything else. */
async function recordRefusal(root: string, commandId: string, code: string): Promise<void> {
	if (typeof commandId !== "string" || commandId.length !== 36 || !UUID.test(commandId)) return;
	try {
		const handle = await open(
			join(root, "logs", commandId, "output.log"),
			constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size !== 0) return;
			await handle.write(`${code}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		/* The exit status alone still reports the refusal. */
	}
}

/** Fixed unprivileged child. Drains both pipes with backpressure, retains the
 * admitted log budget and one overflow marker, and flushes each bounded write.
 * A refusal before the command starts exits CODING_GUEST_REFUSED_EXIT_CODE with
 * its fixed code in the log, so the read receipt shows it as failed. */
export async function executeCodingGuestCommand(
	workerId: string,
	commandId: string,
	ports: CodingGuestCommandPorts = {},
): Promise<number> {
	let prepared: Awaited<ReturnType<typeof prepareExecution>>;
	try {
		prepared = await prepareExecution(workerId, commandId, ports);
	} catch (error) {
		const code = codingErrorCode(error);
		process.stderr.write(`CODING_GUEST_COMMAND_REFUSED ${code}\n`);
		if (UUID.test(String(workerId))) await recordRefusal(custody(ports, workerId), commandId, code);
		return CODING_GUEST_REFUSED_EXIT_CODE;
	}
	const { guest, request, handle } = prepared;
	try {
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", request.command], {
			cwd: guest.workspacePath,
			env: {
				...ENV,
				PATH: `${join(guest.homePath, ".local/bin")}:${join(guest.homePath, ".cargo/bin")}:${ENV.PATH}`,
				TMPDIR: join(guest.cachePath, "tmp"),
				PYTHONUSERBASE: join(guest.homePath, ".local"),
				npm_config_prefix: join(guest.homePath, ".local"),
				HOME: guest.homePath,
				XDG_CACHE_HOME: guest.cachePath,
				XDG_CONFIG_HOME: join(guest.homePath, ".config"),
				npm_config_cache: join(guest.cachePath, "npm"),
				PIP_CACHE_DIR: join(guest.cachePath, "pip"),
				UV_CACHE_DIR: join(guest.cachePath, "uv"),
				CARGO_HOME: join(guest.homePath, ".cargo"),
				RUSTUP_HOME: join(guest.homePath, ".rustup"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		const exited = new Promise<number>((resolveExit) => {
			child.once("error", () => resolveExit(127));
			child.once("close", (code) => resolveExit(code ?? 128));
		});
		const collected = collectCodingCommandOutput(
			[child.stdout, child.stderr],
			handle,
			guest.resourceProfile.maxLogBytes,
		);
		// Collector failure cannot be reported as a successful build.
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

/** Only the trusted root provider may stage this fixed refresh input. The
 * provider must first renew and recheck the matching cloud queue lease. */
export async function refreshCodingGuestCommandLease(workerId: string, ports: CodingGuestCommandPorts = {}) {
	uuid(workerId);
	const guest = await configuration(ports, workerId);
	await (ports.assertStorage ?? assertCloudCodingGuestStorage)(guest);
	await (ports.system ?? system)("/usr/bin/systemctl", ["is-active", "--quiet", "qorpera-coding-watchdog.timer"]);
	const value = JSON.parse(
		(
			await protectedRead(
				join(custody(ports, workerId), "inbox", "lease-refresh.json"),
				ports.protectedUid ?? 0,
				4096,
				ports.protectedDirectoryRoot,
				custody(ports, workerId),
			)
		).toString("utf8"),
	);
	return refreshCodingGuestLease(value, guest, {
		...ports,
		inspectBoot: ports.inspectMachine ?? inspectMachine,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, workerId, commandId, offset, limit, extra] = process.argv.slice(2);
	try {
		if (
			extra ||
			!workerId ||
			(action === "refresh-lease" ? commandId !== undefined : !commandId) ||
			(action !== "read" && (offset !== undefined || limit !== undefined))
		)
			throw new Error("INVALID_CODING_GUEST_ARGUMENTS");
		if (action === "refresh-lease")
			process.stdout.write(`${JSON.stringify(await refreshCodingGuestCommandLease(workerId))}\n`);
		else if (commandId && action === "execute")
			process.exitCode = await executeCodingGuestCommand(workerId, commandId);
		else if (commandId && (action === "start" || action === "read" || action === "cancel")) {
			if (
				action === "read" &&
				((offset !== undefined && offset !== "tail" && !/^(0|[1-9][0-9]*)$/.test(offset)) ||
					(limit !== undefined && !/^[1-9][0-9]*$/.test(limit)))
			)
				throw new Error("INVALID_CODING_GUEST_ARGUMENTS");
			const read =
				offset === undefined
					? {}
					: offset === "tail"
						? { tail: true, limit: Number(limit ?? 4096) }
						: { offset: Number(offset), limit: Number(limit ?? 4096) };
			process.stdout.write(
				`${JSON.stringify(await runCodingGuestCommand(action, workerId, commandId, {}, read))}\n`,
			);
		} else throw new Error("INVALID_CODING_GUEST_ARGUMENTS");
	} catch {
		process.stderr.write("CODING_GUEST_COMMAND_REFUSED\n");
		process.exitCode = 1;
	}
}
