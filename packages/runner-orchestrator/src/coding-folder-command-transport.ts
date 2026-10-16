import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { constants as os } from "node:os";
import { posix } from "node:path";
import {
	type CloudCodingCommandRead,
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	CODING_GUEST,
	type CodingGuestCommand,
	isUuid,
	parseClosedRecord,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
} from "@qorpera/contracts";
import {
	type CodingCommandSecretRequest,
	type CodingCommandSecrets,
	noCodingCommandSecrets,
} from "./coding-command-secrets.ts";
import type { CodingFolderControl } from "./coding-folder-control.ts";
import { CodingGuestRefused, type LxdCodingGuestClient } from "./coding-guest-client.ts";
import { type LxdCodingMachineBinding, lxdCodingMachinePlan } from "./coding-machine.ts";

// A model's commands on a member's coding machine on the folder model (F3 step 5g-3c; the plan's "Commands"). The
// guest agent runs each command as the session's user and keeps its output in a ring; the executor pulls the output,
// asks the folder service for the machine's boundary, and only then keeps the output, masked, in the worker's custody
// on the host, where the machine can't reach it. Pages and receipts are read from what the host kept. Nothing wires it
// in yet: 5g-6 chooses it for sessions on the folder model.

const SHA = /^[0-9a-f]{64}$/;
type Action = "start" | "read" | "cancel";
type State = CloudCodingCommandReceipt["state"];
type Final = Exclude<State, "running">;
type Authorize = (
	action: Action,
	scope: CloudCodingCommandScope,
	commandId: string,
	inputSha256: string | null,
	signal: AbortSignal,
) => Promise<void>;

/** Each call's own budget, inside the runtime's 30 s deadline for a command request. */
const BUDGET_MS = 25_000;
/** A first page, as the NAS transport answers a start and a cancel. */
const FIRST_PAGE = { offset: 0, limit: 4096 } as const;
const MAX_RECORD_BYTES = 65_536;
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const UNPROTECTED = "CODING_COMMAND_CUSTODY_UNPROTECTED";
const INVALID = "CODING_COMMAND_CUSTODY_INVALID";
const FINAL: readonly string[] = ["succeeded", "failed", "cancelled", "unconfirmed", "machine_stopped"];

/** One command at a time per custody and command, across every transport of this process: the runtime builds a
 * transport per request. */
const LOCKS = new Map<string, Promise<void>>();
async function locked<T>(key: string, work: () => Promise<T>): Promise<T> {
	const run = (LOCKS.get(key) ?? Promise.resolve()).then(work);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	LOCKS.set(key, tail);
	try {
		return await run;
	} finally {
		if (LOCKS.get(key) === tail) LOCKS.delete(key);
	}
}

/** `request.json`: the command as it was first started. Linked once. */
interface Request {
	readonly schema: "qorpera.coding-host-command/v1";
	readonly workerId: string;
	readonly commandId: string;
	readonly inputSha256: string;
	readonly command: string;
	readonly timeoutMs: number | null;
	readonly limitBytes: number;
	readonly turn: number;
	/** The machine's LXD start the command was started under. */
	readonly startOperationId: string;
}
const REQUEST_KEYS = [
	"schema",
	"workerId",
	"commandId",
	"inputSha256",
	"command",
	"timeoutMs",
	"limitBytes",
	"turn",
	"startOperationId",
];

/** `progress.json`: how far the host kept the command's output. Replaced whole. */
interface Progress {
	readonly schema: "qorpera.coding-host-command-progress/v1";
	/** The guest's byte offset the next pull starts at: every byte before it is kept, masked, or counted lost. */
	readonly raw: number;
	/** The mask's state at `raw` (`CodingCommandSecretMask.masked`): the bytes from there that the kept `***` already
	 * covers, or `null` when the kept output doesn't end in one. */
	readonly masked: number | null;
	/** The bytes of output.log, all kept. */
	readonly logBytes: number;
	/** The guest's bytes lost before the host kept them. */
	readonly gapBytes: number;
	readonly limitReached: boolean;
	/** The guest has the command. */
	readonly acknowledged: boolean;
	/** A cancel was asked for. */
	readonly cancelled: boolean;
	/** The guest's end when last seen. */
	readonly end: number;
}
const PROGRESS_KEYS = [
	"schema",
	"raw",
	"masked",
	"logBytes",
	"gapBytes",
	"limitReached",
	"acknowledged",
	"cancelled",
	"end",
];
const NO_PROGRESS: Progress = Object.freeze({
	schema: "qorpera.coding-host-command-progress/v1",
	raw: 0,
	masked: null,
	logBytes: 0,
	gapBytes: 0,
	limitReached: false,
	acknowledged: false,
	cancelled: false,
	end: 0,
});

/** `outcome.json`: how the command ended, kept once all its output was. Linked once; from then on nothing asks the
 * guest about the command. */
interface Outcome {
	readonly schema: "qorpera.coding-host-command-outcome/v1";
	readonly state: Final;
	readonly exitCode: number | null;
}
const OUTCOME_KEYS = ["schema", "state", "exitCode"];

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const exitOf = (state: unknown, code: unknown) =>
	state === "succeeded"
		? code === 0
		: state === "failed"
			? Number.isSafeInteger(code) && (code as number) >= 1 && (code as number) <= 255
			: code === null;

function custodyRecord<T>(
	bytes: Buffer,
	keys: readonly string[],
	check: (value: Record<string, unknown>) => boolean,
): T {
	let value: Record<string, unknown>;
	try {
		value = parseClosedRecord(
			JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)),
			"coding host command",
			keys,
		);
	} catch {
		throw new Error(INVALID);
	}
	if (!check(value)) throw new Error(INVALID);
	return value as T;
}
const requestOf = (bytes: Buffer, limit: { workerId: string; commandId: string }) =>
	custodyRecord<Request>(
		bytes,
		REQUEST_KEYS,
		(value) =>
			value.schema === "qorpera.coding-host-command/v1" &&
			value.workerId === limit.workerId &&
			value.commandId === limit.commandId &&
			typeof value.inputSha256 === "string" &&
			SHA.test(value.inputSha256) &&
			typeof value.command === "string" &&
			(value.timeoutMs === null || count(value.timeoutMs)) &&
			count(value.limitBytes) &&
			(value.limitBytes as number) >= 1_048_576 &&
			(value.limitBytes as number) <= 1_073_741_824 &&
			count(value.turn) &&
			isUuid(value.startOperationId),
	);
const progressOf = (bytes: Buffer, limitBytes: number) =>
	custodyRecord<Progress>(
		bytes,
		PROGRESS_KEYS,
		(value) =>
			value.schema === "qorpera.coding-host-command-progress/v1" &&
			count(value.raw) &&
			(value.masked === null || count(value.masked)) &&
			count(value.logBytes) &&
			(value.logBytes as number) <= limitBytes &&
			count(value.gapBytes) &&
			typeof value.limitReached === "boolean" &&
			(!value.limitReached || value.logBytes === limitBytes) &&
			typeof value.acknowledged === "boolean" &&
			typeof value.cancelled === "boolean" &&
			count(value.end),
	);
const outcomeOf = (bytes: Buffer) =>
	custodyRecord<Outcome>(
		bytes,
		OUTCOME_KEYS,
		(value) =>
			value.schema === "qorpera.coding-host-command-outcome/v1" &&
			FINAL.includes(value.state as string) &&
			exitOf(value.state, value.exitCode),
	);

const euid = () => process.geteuid?.() ?? -1;
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** A folder of the executor's alone: its own, mode exactly 0700. The custody root above it only needs to be the
 * executor's with no group or other write. */
async function assertFolder(path: string, exact: boolean): Promise<void> {
	const stat = await lstat(path);
	if (
		!stat.isDirectory() ||
		stat.uid !== euid() ||
		(exact ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)
	)
		throw new Error(UNPROTECTED);
}
async function makeFolder(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
		if (errno(error) !== "EEXIST") throw error;
	});
	await assertFolder(path, true);
}

/** A kept file, opened without following a link: one link, the executor's, of exactly `mode`. */
async function openKept(path: string, flags: number, mode: number): Promise<FileHandle | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (errno(error) === "ENOENT") return undefined;
		if (errno(error) === "ELOOP") throw new Error(UNPROTECTED);
		throw error;
	}
	const stat = await handle.stat().catch(async (error: unknown) => {
		await handle.close();
		throw error;
	});
	if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== euid() || (stat.mode & 0o7777) !== mode) {
		await handle.close();
		throw new Error(UNPROTECTED);
	}
	return handle;
}
async function readKept(path: string, mode: number): Promise<Buffer | undefined> {
	const handle = await openKept(path, constants.O_RDONLY, mode);
	if (!handle) return undefined;
	try {
		const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
		let used = 0;
		for (let read = 1; read && used < bytes.length; used += read)
			({ bytesRead: read } = await handle.read(bytes, used, bytes.length - used, used));
		if (used > MAX_RECORD_BYTES) throw new Error(INVALID);
		return bytes.subarray(0, used);
	} finally {
		await handle.close();
	}
}

async function syncFolder(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
/** Writes `.<name>.new` whole and synced. */
async function writeTemporary(folder: string, name: string, text: string, mode: number): Promise<string> {
	const path = `${folder}/.${name}.new`;
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.chmod(mode);
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return path;
}
/** Links a record into place once: false when one is there already. */
async function linkOnce(folder: string, name: string, value: object): Promise<boolean> {
	const temporary = await writeTemporary(folder, name, `${JSON.stringify(value)}\n`, 0o400);
	let linked = true;
	try {
		await link(temporary, `${folder}/${name}`);
	} catch (error) {
		if (errno(error) !== "EEXIST") throw error;
		linked = false;
	} finally {
		await unlink(temporary);
	}
	await syncFolder(folder);
	return linked;
}
async function replace(folder: string, name: string, value: object): Promise<void> {
	await rename(await writeTemporary(folder, name, `${JSON.stringify(value)}\n`, 0o600), `${folder}/${name}`);
	await syncFolder(folder);
}
/** A call that stopped half way leaves its temporary file; the next call under the lock removes it. */
async function sweep(folder: string): Promise<void> {
	for (const name of ["request.json", "progress.json", "outcome.json"])
		await unlink(`${folder}/.${name}.new`).catch((error: unknown) => {
			if (errno(error) !== "ENOENT") throw error;
		});
}

/** Puts `bytes` at `at` in output.log and cuts the file there, so a call that stopped half way leaves nothing. */
async function keepOutput(folder: string, at: number, bytes: Buffer): Promise<void> {
	const path = `${folder}/output.log`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			path,
			constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			0o600,
		);
		await handle.chmod(0o600);
	} catch (error) {
		if (errno(error) !== "EEXIST") throw error;
	}
	handle ??= await openKept(path, constants.O_RDWR, 0o600);
	if (!handle) throw new Error(INVALID);
	try {
		if ((await handle.stat()).size < at) throw new Error("CODING_LOG_CHANGED");
		await handle.truncate(at);
		for (let used = 0; used < bytes.length; ) {
			const { bytesWritten } = await handle.write(bytes, used, bytes.length - used, at + used);
			if (!bytesWritten) throw new Error("CODING_LOG_WRITE_FAILED");
			used += bytesWritten;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** A page of output.log, as the runtime's readCodingCommandLog pages a command's log: raw-byte offsets, at most
 * `limit` bytes of UTF-8 output, and a page that never ends inside a character while more may follow. The log is the
 * first `progress.logBytes` bytes of the file. */
async function readPage(
	folder: string,
	progress: Progress,
	limitBytes: number,
	terminal: boolean,
	read: Omit<CloudCodingCommandRead, "commandId">,
): Promise<Pick<CloudCodingCommandReceipt, "output" | "truncated" | "log">> {
	const totalBytes = progress.logBytes,
		limitReached = progress.limitReached,
		limit = read.limit ?? 4096;
	let offset = read.tail ? Math.max(0, totalBytes - limit) : (read.offset ?? 0);
	if (offset > totalBytes) throw new Error("CODING_LOG_OFFSET_UNAVAILABLE");
	const base = Math.max(0, offset - 3),
		buffer = Buffer.alloc(Math.min(totalBytes - base, limit + 7));
	if (buffer.length) {
		const handle = await openKept(`${folder}/output.log`, constants.O_RDONLY, 0o600);
		if (!handle) throw new Error("CODING_LOG_CHANGED");
		try {
			let used = 0;
			for (let got = 1; got && used < buffer.length; used += got)
				({ bytesRead: got } = await handle.read(buffer, used, buffer.length - used, base + used));
			if (used !== buffer.length) throw new Error("CODING_LOG_CHANGED");
		} finally {
			await handle.close();
		}
	}
	const width = (index: number): number => {
		const b = buffer[index];
		const n = b < 128 ? 1 : b >= 194 && b <= 223 ? 2 : b >= 224 && b <= 239 ? 3 : b >= 240 && b <= 244 ? 4 : 1;
		if (index + n > buffer.length) return 1;
		for (let j = 1; j < n; j++) if ((buffer[index + j] & 192) !== 128) return 1;
		if (
			(b === 224 && buffer[index + 1] < 160) ||
			(b === 237 && buffer[index + 1] > 159) ||
			(b === 240 && buffer[index + 1] < 144) ||
			(b === 244 && buffer[index + 1] > 143)
		)
			return 1;
		return n;
	};
	for (let i = 0; i < offset - base; i++) {
		const n = width(i);
		if (i + n > offset - base) {
			if (!read.tail) throw new Error("CODING_LOG_OFFSET_SPLITS_UTF8");
			offset = base + i + n;
			break;
		}
	}
	let cursor = offset - base,
		bytes = 0,
		output = "";
	const tailParts: { rawBytes: number; text: string; bytes: number }[] = [];
	while (cursor < buffer.length) {
		const lead = buffer[cursor],
			expected =
				lead >= 194 && lead <= 223 ? 2 : lead >= 224 && lead <= 239 ? 3 : lead >= 240 && lead <= 244 ? 4 : 1;
		// While more may follow, a character the log has only the start of waits for the rest.
		if (
			!terminal &&
			!limitReached &&
			base + cursor + expected > totalBytes &&
			buffer.subarray(cursor + 1).every((b) => (b & 192) === 128)
		)
			break;
		const n = width(cursor),
			part = new TextDecoder("utf8", { ignoreBOM: true }).decode(buffer.subarray(cursor, cursor + n)),
			size = Buffer.byteLength(part);
		if (bytes + size > limit && !read.tail) break;
		output += part;
		bytes += size;
		cursor += n;
		if (read.tail) tailParts.push({ rawBytes: n, text: part, bytes: size });
	}
	let removedCharacters = 0;
	for (const part of tailParts) {
		if (bytes <= limit) break;
		bytes -= part.bytes;
		offset += part.rawBytes;
		removedCharacters += part.text.length;
	}
	if (removedCharacters) output = output.slice(removedCharacters);
	const nextOffset = base + cursor;
	return {
		output,
		truncated: nextOffset < totalBytes || limitReached,
		log: { offset, nextOffset, totalBytes, limitBytes, limitReached },
	};
}

/** How the guest's command ended, as a receipt says it; null while it runs. A command the guest lost ended with the
 * machine when the machine started again since the command did. */
function finalOf(command: CodingGuestCommand, moved: boolean): Omit<Outcome, "schema"> | null {
	switch (command.state) {
		case "running":
			return null;
		case "exited": {
			// A signal ends a shell's command with 128 and the signal's number; one this host doesn't know with 1.
			const signal = command.exit?.signal ? os.signals[command.exit.signal as keyof typeof os.signals] : undefined;
			const code = command.exit?.code ?? (signal ? 128 + signal : 1);
			return code === 0 ? { state: "succeeded", exitCode: 0 } : { state: "failed", exitCode: code };
		}
		case "timed_out":
			return { state: "failed", exitCode: 124 };
		case "cancelled":
			return { state: "cancelled", exitCode: null };
		case "lost":
			return { state: moved ? "machine_stopped" : "unconfirmed", exitCode: null };
	}
}

/** What a command's process gets besides its secrets: the session user's home, a login's usual names, and the
 * user's own runtime folder with its bus and rootless Docker. Nothing of the guest's is added. */
function sessionEnvironment(uid: number): Record<string, string> {
	const user = `qorpera-${uid}`,
		runtime = `/run/user/${uid}`;
	return {
		HOME: `/home/${user}`,
		USER: user,
		LOGNAME: user,
		SHELL: "/bin/bash",
		PATH,
		LANG: "C.UTF-8",
		TMPDIR: "/tmp",
		XDG_RUNTIME_DIR: runtime,
		DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
		DOCKER_HOST: `unix://${runtime}/docker.sock`,
	};
}

const absolute = (path: unknown): path is string =>
	typeof path === "string" &&
	path.length > 1 &&
	posix.isAbsolute(path) &&
	posix.normalize(path) === path &&
	!path.endsWith("/");

/** The session a turn's commands run in, as the host set it up. */
export interface LxdCodingFolderCommandSession {
	/** The session user's ids in the guest. */
	readonly uid: number;
	readonly gid: number;
	/** Where each command starts: the session's worktree in the company folder. */
	readonly cwd: string;
	/** The host's own names for the session, such as GIT_CONFIG_*. */
	readonly environment?: Readonly<Record<string, string>>;
}

export interface LxdCodingFolderCommandTransportOptions {
	readonly machine: LxdCodingMachineBinding;
	readonly scope: CloudCodingCommandScope;
	/** The LXD operation that started the machine this turn runs on, from the machine's journal. */
	readonly startOperationId: string;
	readonly session: LxdCodingFolderCommandSession;
	/** The worker's custody folder on the host: the executor's, and out of the machine's reach. */
	readonly custody: string;
	/** The most output a command keeps: the resource profile's log bytes. */
	readonly limitBytes: number;
	readonly guest: Pick<LxdCodingGuestClient, "run" | "output" | "cancel">;
	readonly control: Pick<CodingFolderControl, "boundary">;
	/** The command's secrets and the mask for its output; none by default. */
	readonly secrets?: CodingCommandSecrets;
	/** As the NAS transport's: checks the request's authority before each call's work and again before its answer. */
	readonly authorize: Authorize;
}

/** The folder model's command transport: the same calls and receipts as `LxdCodingCommandTransport`. Only a trusted
 * provider constructs it, with an `authorize` that checks the request's lease and the machine before each effect.
 * Each call takes at most 25 s of its own; a command still running then shows `running`, with what was kept. */
export class LxdCodingFolderCommandTransport {
	readonly #scope: Readonly<CloudCodingCommandScope>;
	readonly #companyId: string;
	readonly #machineId: string;
	readonly #startOperationId: string;
	readonly #session: Readonly<Required<LxdCodingFolderCommandSession>>;
	readonly #custody: string;
	readonly #limitBytes: number;
	readonly #guest: LxdCodingFolderCommandTransportOptions["guest"];
	readonly #control: LxdCodingFolderCommandTransportOptions["control"];
	readonly #secrets: CodingCommandSecrets;
	readonly #authorize: Authorize;
	constructor(options: LxdCodingFolderCommandTransportOptions) {
		const machine = lxdCodingMachinePlan(options.machine).binding;
		const { scope, session } = options;
		if (
			Object.keys(scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			!isUuid(scope.workerId) ||
			scope.vmId !== machine.machineId ||
			!isUuid(scope.requestId) ||
			!Number.isSafeInteger(scope.turn) ||
			scope.turn < 1 ||
			!isUuid(options.startOperationId) ||
			![session.uid, session.gid].every(
				(id) => Number.isSafeInteger(id) && id >= CODING_GUEST.minUid && id <= CODING_GUEST.maxUid,
			) ||
			!absolute(session.cwd) ||
			!absolute(options.custody) ||
			!Number.isSafeInteger(options.limitBytes) ||
			options.limitBytes < 1_048_576 ||
			options.limitBytes > 1_073_741_824
		)
			throw new Error("CODING_COMMAND_BINDING_INVALID");
		this.#scope = Object.freeze({ ...scope });
		this.#companyId = machine.companyId;
		this.#machineId = machine.machineId;
		this.#startOperationId = options.startOperationId;
		this.#session = Object.freeze({
			uid: session.uid,
			gid: session.gid,
			cwd: session.cwd,
			environment: Object.freeze({ ...session.environment }),
		});
		this.#custody = options.custody;
		this.#limitBytes = options.limitBytes;
		this.#guest = options.guest;
		this.#control = options.control;
		this.#secrets = options.secrets ?? noCodingCommandSecrets;
		this.#authorize = options.authorize;
	}

	async #gate(
		action: Action,
		scope: CloudCodingCommandScope,
		commandId: string,
		inputSha256: string | null,
		signal: AbortSignal,
	): Promise<void> {
		if (
			Object.keys(scope).sort().join() !== "requestId,turn,vmId,workerId" ||
			Object.entries(this.#scope).some(([key, value]) => scope[key as keyof CloudCodingCommandScope] !== value) ||
			!isUuid(commandId) ||
			(inputSha256 !== null && !SHA.test(inputSha256))
		)
			throw new Error("CODING_COMMAND_SCOPE_DIFFERS");
		signal.throwIfAborted();
		await this.#authorize(action, this.#scope, commandId, inputSha256, signal);
		signal.throwIfAborted();
	}

	/** The call's work under the command's lock, with the call's budget, in the command's custody folder. */
	async #within<T>(
		commandId: string,
		signal: AbortSignal,
		create: boolean,
		work: (folder: string, budget: AbortSignal) => Promise<T>,
	): Promise<T> {
		const budget = AbortSignal.any([signal, AbortSignal.timeout(BUDGET_MS)]);
		return locked(`${this.#custody}\0${commandId}`, async () => {
			signal.throwIfAborted();
			await assertFolder(this.#custody, false);
			const commands = `${this.#custody}/host-commands`,
				folder = `${commands}/${commandId.replaceAll("-", "")}`;
			if (create) {
				await makeFolder(commands);
				await makeFolder(folder);
			} else {
				const found = await assertFolder(commands, true)
					.then(() => assertFolder(folder, true))
					.then(
						() => true,
						(error: unknown) => {
							if (errno(error) !== "ENOENT") throw error;
							return false;
						},
					);
				if (!found) throw new Error("CODING_COMMAND_UNKNOWN");
			}
			await sweep(folder);
			return work(folder, budget);
		});
	}

	async #records(folder: string, commandId: string) {
		const request = await readKept(`${folder}/request.json`, 0o400);
		if (!request) throw new Error("CODING_COMMAND_UNKNOWN");
		const kept = requestOf(request, { workerId: this.#scope.workerId, commandId });
		const progress = await readKept(`${folder}/progress.json`, 0o600);
		const outcome = await readKept(`${folder}/outcome.json`, 0o400);
		return {
			request: kept,
			progress: progress ? progressOf(progress, kept.limitBytes) : NO_PROGRESS,
			outcome: outcome ? outcomeOf(outcome) : undefined,
		};
	}

	async start(
		scope: CloudCodingCommandScope,
		input: { commandId: string; inputSha256: string; command: string; timeoutMs: number | null },
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> {
		if (
			Object.keys(input).sort().join() !== "command,commandId,inputSha256,timeoutMs" ||
			typeof input.command !== "string" ||
			!input.command.trim() ||
			input.command.includes("\0") ||
			Buffer.byteLength(input.command) > 16384 ||
			Buffer.from(input.command).toString("utf8") !== input.command ||
			(input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000))
		)
			throw new Error("CODING_COMMAND_INPUT_INVALID");
		await this.#gate("start", scope, input.commandId, input.inputSha256, signal);
		const receipt = await this.#within(input.commandId, signal, true, async (folder, budget) => {
			await linkOnce(folder, "request.json", {
				schema: "qorpera.coding-host-command/v1",
				workerId: this.#scope.workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				command: input.command,
				timeoutMs: input.timeoutMs,
				limitBytes: this.#limitBytes,
				turn: this.#scope.turn,
				startOperationId: this.#startOperationId,
			} satisfies Request);
			const records = await this.#records(folder, input.commandId);
			const { request, outcome } = records;
			let { progress } = records;
			// The same command again is the same command; another one under its id is refused.
			if (
				request.inputSha256 !== input.inputSha256 ||
				request.command !== input.command ||
				request.timeoutMs !== input.timeoutMs
			)
				throw new Error("CODING_COMMAND_CONFLICT");
			// Only on the machine it was first started on: one that started again since may have run it already.
			if (
				!outcome &&
				!progress.acknowledged &&
				!progress.cancelled &&
				request.startOperationId === this.#startOperationId
			) {
				const secrets = await this.#secrets.resolve(this.#secretRequest(input.commandId), budget);
				const { uid, gid, cwd, environment } = this.#session;
				try {
					await this.#guest.run(
						{
							schema: "qorpera.coding-guest-run/v1",
							workerId: this.#scope.workerId,
							commandId: input.commandId,
							uid,
							gid,
							command: request.command,
							cwd,
							environment: { ...secrets.environment, ...environment, ...sessionEnvironment(uid) },
							timeoutMs: request.timeoutMs,
						},
						budget,
					);
				} catch (error) {
					// The guest has the command with another environment, such as a secret's earlier value: it is this one.
					if (!(error instanceof CodingGuestRefused && error.code === "CODING_GUEST_COMMAND_CONFLICT"))
						throw error;
				}
				progress = await this.#save(folder, { ...progress, acknowledged: true });
			}
			return this.#settle(folder, request, progress, outcome, budget, signal, FIRST_PAGE, false);
		});
		await this.#gate("start", scope, input.commandId, input.inputSha256, signal);
		return receipt;
	}

	async read(
		scope: CloudCodingCommandScope,
		input: CloudCodingCommandRead,
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> {
		const read = parseCloudCodingCommandRead(input);
		await this.#gate("read", scope, read.commandId, null, signal);
		const receipt = await this.#within(read.commandId, signal, false, async (folder, budget) => {
			const { request, progress, outcome } = await this.#records(folder, read.commandId);
			return this.#settle(folder, request, progress, outcome, budget, signal, read, false);
		});
		await this.#gate("read", scope, read.commandId, null, signal);
		return receipt;
	}

	async cancel(
		scope: CloudCodingCommandScope,
		commandId: string,
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> {
		await this.#gate("cancel", scope, commandId, null, signal);
		const receipt = await this.#within(commandId, signal, false, async (folder, budget) => {
			const records = await this.#records(folder, commandId);
			const { request, outcome } = records;
			let { progress } = records;
			if (!outcome) {
				// Kept first, so a start that lands after the cancel is stopped too, when it is next read.
				if (!progress.cancelled) progress = await this.#save(folder, { ...progress, cancelled: true });
				await this.#stop(commandId, budget, signal);
			}
			return this.#settle(folder, request, progress, outcome, budget, signal, FIRST_PAGE, true);
		});
		await this.#gate("cancel", scope, commandId, null, signal);
		return receipt;
	}

	/** Brings the kept output up to date unless the command ended, and answers a page of it. */
	async #settle(
		folder: string,
		request: Request,
		progress: Progress,
		outcome: Outcome | undefined,
		budget: AbortSignal,
		signal: AbortSignal,
		read: Omit<CloudCodingCommandRead, "commandId">,
		cancelSent: boolean,
	): Promise<CloudCodingCommandReceipt> {
		let shown: State = "running";
		if (!outcome)
			({ progress, outcome, shown } = await this.#advance(folder, request, progress, budget, signal, cancelSent));
		const page = await readPage(folder, progress, request.limitBytes, outcome !== undefined, read);
		return parseCloudCodingCommandReceipt({
			schema: "qorpera.coding-command-result/v2",
			workerId: request.workerId,
			commandId: request.commandId,
			inputSha256: request.inputSha256,
			state: outcome?.state ?? shown,
			exitCode: outcome?.exitCode ?? null,
			output: page.output,
			truncated: page.truncated,
			log: { ...page.log, ...(progress.gapBytes > 0 ? { gapBytes: progress.gapBytes } : {}) },
		});
	}

	/** Pulls what the command printed since the host last kept its output, and keeps it once the machine's boundary
	 * released every read the machine was served until then. Without that release nothing is kept, and the command
	 * shows `running`. */
	async #advance(
		folder: string,
		request: Request,
		progress: Progress,
		budget: AbortSignal,
		signal: AbortSignal,
		cancelSent: boolean,
	): Promise<{ progress: Progress; outcome?: Outcome; shown: State }> {
		const workerId = this.#scope.workerId,
			commandId = request.commandId;
		// The machine started again since the command did.
		const moved = request.startOperationId !== this.#startOperationId;
		// Past the limit nothing more is kept: only where the command is.
		const skip = progress.limitReached;
		const pages: { offset: number; gap: number; bytes: Buffer }[] = [];
		let at = progress.raw,
			command: CodingGuestCommand | undefined;
		try {
			for (let index = 0; index < (skip ? 1 : CODING_GUEST.segments); index++) {
				const page = await this.#guest.output(
					{
						schema: "qorpera.coding-guest-output/v1",
						workerId,
						commandId,
						offset: at,
						maxBytes: skip ? 1 : CODING_GUEST.maxPageBytes,
						waitMs: 0,
					},
					budget,
				);
				command = page.answer;
				if (skip) {
					at = page.answer.end;
					break;
				}
				pages.push({ offset: page.answer.offset, gap: page.answer.gap, bytes: page.bytes });
				at = page.answer.offset + page.bytes.length;
				if (at >= page.answer.end || !page.bytes.length) break;
			}
		} catch (error) {
			signal.throwIfAborted();
			if (
				command === undefined &&
				error instanceof CodingGuestRefused &&
				error.code === "CODING_GUEST_COMMAND_UNKNOWN"
			)
				return this.#unknown(folder, progress, moved, budget, signal);
			// Out of time: what was kept stands.
			if (budget.aborted) return { progress, shown: "running" };
			throw error;
		}
		if (!command) throw new Error("CODING_GUEST_ANSWER_INVALID");
		const end = command.end,
			final = finalOf(command, moved);
		// A start that landed after its cancel is stopped now.
		if (progress.cancelled && command.state === "running" && !cancelSent) await this.#stop(commandId, budget, signal);
		const gap = pages.some((page) => page.gap > 0),
			pulled = pages.some((page) => page.bytes.length > 0);
		if (!final && (skip || (!gap && !pulled)))
			return {
				progress: await this.#note(folder, progress, { acknowledged: true, end, raw: skip ? at : progress.raw }),
				shown: "running",
			};
		// Held: nothing of the machine's reaches the model until its reads are released (5g-5 restarts a machine whose
		// reads are left unproven).
		if (!(await this.#released(budget, signal)))
			return { progress: await this.#note(folder, progress, { acknowledged: true, end }), shown: "running" };
		const secrets = await this.#secrets.resolve(this.#secretRequest(commandId), budget);
		let mask = secrets.mask(),
			gapBytes = progress.gapBytes;
		// The pull starts with the bytes the last one's mask held back, so this mask takes over from that one there.
		mask.resume(progress.masked);
		// The guest's offset up to which the kept output's last `***` already covers the bytes.
		const covered = progress.raw + (progress.masked ?? 0);
		const kept: Uint8Array[] = [];
		for (const page of pages) {
			if (page.gap) {
				// The tail the mask held back may start a secret whose rest was lost: it is lost with the gap, and the
				// mask starts again after it. Bytes past the gap that the kept `***` already covers stay behind it.
				gapBytes += mask.pending();
				mask = secrets.mask();
				if (covered > page.offset) mask.resume(covered - page.offset);
			}
			gapBytes += page.gap;
			kept.push(mask.push(page.bytes));
		}
		const caughtUp = at >= end;
		let pending = mask.pending(),
			masked = mask.masked();
		if (final && caughtUp) {
			kept.push(mask.end());
			pending = 0;
			masked = null;
		}
		// Bytes the mask still holds are pulled again next time, with what follows them.
		const bytes = Buffer.concat(kept),
			room = request.limitBytes - progress.logBytes,
			full = bytes.length > room;
		await keepOutput(folder, progress.logBytes, full ? bytes.subarray(0, room) : bytes);
		const next = await this.#save(folder, {
			...progress,
			raw: full ? at : at - pending,
			masked: full ? null : masked,
			logBytes: progress.logBytes + Math.min(room, bytes.length),
			gapBytes,
			limitReached: progress.limitReached || full,
			acknowledged: true,
			end,
		});
		if (!final || !(caughtUp || next.limitReached)) return { progress: next, shown: "running" };
		const outcome: Outcome = { schema: "qorpera.coding-host-command-outcome/v1", ...final };
		if (!(await linkOnce(folder, "outcome.json", outcome))) throw new Error(INVALID);
		return { progress: next, outcome, shown: outcome.state };
	}

	/** The guest has no record of the command: its start hasn't landed, or the session's records went with the session
	 * or with the machine. Bytes it printed that the host didn't keep are counted lost. */
	async #unknown(
		folder: string,
		progress: Progress,
		moved: boolean,
		budget: AbortSignal,
		signal: AbortSignal,
	): Promise<{ progress: Progress; outcome?: Outcome; shown: State }> {
		// A start may still land.
		if (!progress.acknowledged && !moved)
			return { progress, shown: progress.cancelled ? "cancelled" : "unconfirmed" };
		const state: Final =
			!progress.acknowledged && progress.cancelled ? "cancelled" : moved ? "machine_stopped" : "unconfirmed";
		// Past the limit nothing more would have been kept anyway.
		const lost = progress.limitReached ? 0 : Math.max(0, progress.end - progress.raw);
		// The guest's end is the guest's word, as its output is: the count reaches the model only once the machine's reads
		// are released. Until then the command shows running.
		if (lost > 0 && !(await this.#released(budget, signal))) return { progress, shown: "running" };
		const next = await this.#note(folder, progress, { gapBytes: progress.gapBytes + lost });
		const outcome: Outcome = { schema: "qorpera.coding-host-command-outcome/v1", state, exitCode: null };
		if (!(await linkOnce(folder, "outcome.json", outcome))) throw new Error(INVALID);
		return { progress: next, outcome, shown: state };
	}

	/** Whether the machine's boundary released every read the machine was served until now. No answer is no release. */
	async #released(budget: AbortSignal, signal: AbortSignal): Promise<boolean> {
		try {
			return (await this.#control.boundary(this.#machineId, [], budget)).reads === "released";
		} catch {
			signal.throwIfAborted();
			return false;
		}
	}

	/** Asks the guest to stop the command. One it doesn't have has nothing to stop. */
	async #stop(commandId: string, budget: AbortSignal, signal: AbortSignal): Promise<void> {
		try {
			await this.#guest.cancel(
				{ schema: "qorpera.coding-guest-cancel/v1", workerId: this.#scope.workerId, commandId },
				budget,
			);
		} catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof CodingGuestRefused && error.code === "CODING_GUEST_COMMAND_UNKNOWN")) throw error;
		}
	}

	#secretRequest(commandId: string): CodingCommandSecretRequest {
		return {
			companyId: this.#companyId,
			workerId: this.#scope.workerId,
			machineId: this.#machineId,
			commandId,
			kind: "command",
		};
	}

	async #save(folder: string, progress: Progress): Promise<Progress> {
		await replace(folder, "progress.json", progress);
		return progress;
	}
	/** Saves a change, if it changes anything. */
	async #note(folder: string, progress: Progress, change: Partial<Progress>): Promise<Progress> {
		const next: Progress = { ...progress, ...change };
		return PROGRESS_KEYS.every((key) => next[key as keyof Progress] === progress[key as keyof Progress])
			? progress
			: this.#save(folder, next);
	}
}
