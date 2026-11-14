// The agent's home (lanes/agent-box-20261113/HOME-PLAN.md, slices 1, 2 and 4; proven in P1-CODEX-OWN-TOOLS.md).
//
// A run's Codex stays in its sealed slot, with the member's sign-in, no network and the result fence. Its OWN shell,
// stdin and apply_patch run on the run's home machine: Codex's `exec-server`, which it reaches as an "environment"
// through one Unix socket in the run's scratch root. This module is the host side of that socket:
//
//   Codex (in the slot) --(`codex stdio-to-uds`)--> <scratch root>/exec.sock --> this host
//     --> the coding executor's channel --> `codex exec-server --listen stdio` on the machine, as the agent's account
//     (qorpera-agent, not root by default, root through sudo when it asks: everything `machine_run` can do)
//
// Everything the model asks of its home passes here as one JSON-RPC line, before any byte reaches the machine, so this
// is where the review lives (slice 4) and where the run's work log learns what the model did (slice 2).
//
// The rules this host keeps:
// - **Nothing of the slot travels.** The host writes the environment file itself; the line it forwards is Codex's own.
//   P1 scanned 1,198 messages of a run (9.2 MB) for two canaries and found none.
// - **Every command and every change to files is reviewed before it reaches the machine** (slice 4), by the same gate,
//   rule and "ask first" cards as `machine_run`, **once per call of the model's**: a command once, what it types into a
//   running shell once per write, and a patch once with the whole patch, however many files it touches. What the
//   review approves is exactly what the model chose (the command, its folder, the patch), so the same call made again
//   after a card is approved runs without another review.
// - **Each call that changes something has its step in the run's work log before it happens** (slice 2, §4.5), in the
//   folder's own paths, finished with the envelope the model was shown.
// - **A home that is not there is said in words** the model can act on, for each thing it asks, never a dead turn.
// - **Nothing happens without the company's switch** (`qorpera_company_home_available`). With it off this file is never
//   built, the thread has no environment, and the provider's request is exactly today's.

import { createHash, randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join, posix } from "node:path";
import { CLOUD_MACHINE_HOME, type JsonValue, POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import type { CloudActionGateResult } from "./cloud-action-review.ts";
import { CloudHomeChannelRefused, cloudHomeChannelLines } from "./cloud-home-channel.ts";
import type { CloudRunLog } from "./cloud-run-log.ts";

/** The environment id the host registers for the home. Codex names it on every tool call it makes there. */
export const CLOUD_HOME_ENVIRONMENT_ID = "home";
/** Where the home's folder is mounted inside the machine, and the environment's working directory. */
export const CLOUD_HOME_CWD = CLOUD_MACHINE_HOME.cwd;
/** The socket the namespace reaches, beside the result fence's, in the run's own scratch root. */
export const CLOUD_HOME_SOCKET_NAME = "exec.sock";
/** Connections the namespace may hold at once: Codex opens one environment, and one more while it reconnects. */
const MAX_CONNECTIONS = 4;
/** Calls, processes and patches this host remembers at once; past it the oldest are forgotten. */
const MAX_REMEMBERED = 8_192;
/** How long the run waits for its session to be closed in SQL as it ends; a run that comes back supersedes it. */
export const CLOUD_HOME_CLOSE_MS = 5_000;
/** How long a file change waits for Codex's word of the patch it belongs to (its item notification arrives on the
 * session's other pipe, so it can come a moment after the change itself). */
const PATCH_NOTICE_MS = 3_000;
/** The most of one text the review's identity carries as itself; past it, its head with its size and digest. */
const IDENTITY_TEXT_BYTES = 32 * 1024;
/** What all of a patch's diffs may take of the identity together, so the whole stays within the gate's 64 KiB. */
const IDENTITY_PATCH_BYTES = 48 * 1024;
/** How long a connection whose channel would not open answers in words before it tries again. */
const RETRY_MS = 5_000;
/** How long a machine that came back has to answer the handshake it is told again. */
const REPLAY_MS = 10_000;
/** How much of a command the card shows; the identity and the reviewer still have all of it. */
const CARD_CHARS = 2000;

/** The words the model is shown when its home is not there, by the reason the channel gave (or none). */
export const CLOUD_HOME_UNAVAILABLE =
	"HOME_UNAVAILABLE: this agent's machine could not be reached, so nothing ran there. Use the company's own tools, or try again.";
export const CLOUD_HOME_NOT_RUNNING =
	"HOME_NOT_RUNNING: this agent's machine is not running, so nothing ran there. Start it with machine_start and try again, or use the company's own tools.";
export const CLOUD_HOME_BUSY =
	"HOME_BUSY: this agent's machine is busy with another run's work, so nothing ran there. Use the company's own tools, or try again when that work is done.";
/** What the model is told when its machine's Codex is not the build its run speaks to: a machine that slept through an
 * image switch keeps its disk, and with it the tools of the image it was made from (20260930760000), so a wake does not
 * bring the home; a new machine has it, in the words the machine tools use for an earlier image (FOLDER_VIEWLESS). */
export const CLOUD_HOME_OUTDATED =
	"HOME_OUTDATED: this agent's machine was made from an earlier image, with an older build of the tools this run uses on it, so the home is unavailable on this machine and nothing ran there. Start a new machine for this agent (a new machine has it), or use the company's own tools.";
/** What the model is told when its home went away while it was working on it. */
export const CLOUD_HOME_LOST =
	"HOME_LOST: the connection to this agent's machine broke while that was running there, so there is no answer to it. Part of it may have happened on the machine. Look at the machine's own state before doing it again, or use the company's own tools.";
/** What the model is told for a request this host cannot read, which it therefore never lets reach the machine. */
export const CLOUD_HOME_REQUEST_INVALID =
	"HOME_REQUEST_INVALID: this agent's machine was asked something this host could not read, so nothing ran there. Try the call again as the tool describes it.";
/** What the model is told when the run's work log could not keep the record an action must leave behind. */
export const CLOUD_HOME_NO_RECORD =
	"WORK_LOG_UNAVAILABLE: this agent's work log could not keep a record of that action, so it did not happen on the machine. Try again.";

/** The words for a channel the ingress refused, by its reason; anything unknown is only "could not be reached". */
export function cloudHomeRefusalWords(reason: string | undefined): string {
	if (reason === "MACHINE_NOT_RUNNING") return CLOUD_HOME_NOT_RUNNING;
	if (reason === "MACHINE_BUSY_WITH_OTHER_WORK") return CLOUD_HOME_BUSY;
	if (reason === "HOME_CODEX_NOT_PINNED") return CLOUD_HOME_OUTDATED;
	return CLOUD_HOME_UNAVAILABLE;
}

/**
 * The exec-server's file requests that only read: forwarded as they are. Every other `fs/` request is a change and is
 * reviewed, so a file method this list does not know is never let through unreviewed; `process/start` and a nonempty
 * `process/write` are commands.
 */
const FS_READS = new Set(["fs/readFile", "fs/getMetadata", "fs/readDirectory", "fs/exists", "fs/canonicalize"]);
/** The other requests that need no review: the handshake, the environment's own questions, and a process's reads,
 * size and end. Everything not named here or above is either reviewed (`process/start`, `process/write`, any other
 * `fs/` method) or refused. */
const UNREVIEWED = new Set([
	"initialize",
	"environment/info",
	"environmentConfig/read",
	"process/read",
	"process/resize",
	"process/terminate",
]);
/** An answer from the machine, read from the head of its line: which request of the model's it belongs to. */
const ANSWER_ID = /^\{(?:"jsonrpc":"[^"]{1,16}",)?"id":(\d{1,20}|"[^"]{1,128}")/;
/** The machine's word that one of the model's processes is closed, read from the head of its line: the process id,
 * as JSON text, as the requests about it carry it. */
const PROCESS_CLOSED =
	/^\{(?:"jsonrpc":"[^"]{1,16}",)?"method":"process\/closed","params":\{"processId":("[^"]{1,64}"|\d{1,20})/;
/** Past this a line the head did not answer is left alone: an answer is small, a command's output is not. */
const ANSWER_READ_CHARS = 262_144;
/** A call id as Codex names it, kept only when it is one. */
const CALL_ID = /^[A-Za-z0-9_:.-]{1,160}$/;

/** The run's home as SQL answers it (`qorpera_company_home_available`): the machine, or none at all. */
export interface CloudCompanyHome {
	readonly machineId: string;
	readonly machine: string;
}

/** SQL's answer, or undefined for a run with no home. Nothing of it is trusted beyond its shape. */
export function parseCloudCompanyHome(value: unknown): CloudCompanyHome | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.schema !== "qorpera.company-home/v1" || record.available !== true) return undefined;
	if (
		typeof record.machineId !== "string" ||
		!POSTGRES_UUID_PATTERN.test(record.machineId) ||
		typeof record.machine !== "string" ||
		record.machine.length < 1 ||
		record.machine.length > 200
	)
		return undefined;
	return { machineId: record.machineId, machine: record.machine };
}

/** One open channel to the machine: lines in, lines out, as `codex exec-server --listen stdio` speaks them. */
export interface CloudCodexHomeStream {
	/** One complete JSON-RPC line (without its newline) towards the machine. */
	write(line: string): void;
	/** Each complete line the machine sent, in order. Ends when the channel closes. */
	lines: AsyncIterable<string>;
	close(): Promise<void>;
}

/** How the runtime reaches the run's home: the coding executor authorizes the session and starts the exec-server. */
export interface CloudCodexHomeChannel {
	open(
		input: { readonly sessionId: string; readonly machineId: string },
		signal: AbortSignal,
	): Promise<CloudCodexHomeStream>;
}

/** The machine, as an action names it: its id for the identity, its name for the card. */
export interface CloudCodexHomeMachine {
	readonly id: string;
	readonly name: string;
}

/**
 * One action of the model's on its home, as the review judges it and the work log keeps it: a command, a write into a
 * running shell, a patch, or a file change no patch accounts for.
 */
export interface CloudCodexHomeAction {
	/** How the review classifies it: a command on the machine, or a change to its files (cloud-action-review.ts). */
	readonly tool: "home_command" | "home_change";
	/** What the card shows: the command, the words typed, or which files change. */
	readonly summary: string;
	/** What the review approves, whole, and shows the reviewer: the machine and everything the model chose for this
	 * action (a text past 32 KiB as its head with its size and digest). `argumentSha256` is this text's digest, so an
	 * approval of one action is never an approval of another, and the same action made again is the same one. */
	readonly argumentsText: string;
	readonly argumentSha256: string;
	/** What the reviewer reads beyond the arguments: the text a lone file write puts there. */
	readonly contents?: JsonValue;
	/** The model's own call, or this host's id for an action no call of the model's names. */
	readonly callId: string;
	/** The step the run's work log keeps for it, in the folder's own paths (what erasure and zoom match). */
	readonly step: { readonly tool: string; readonly argumentsText: string; readonly paths: readonly string[] };
	/** What a parked card tells the model to do when it is approved later: there is no tool of its own to call again,
	 * so "call the same tool with the card's `call`" would be words it cannot act on (review round 1, F8). */
	readonly repeat: string;
}

/** The review of one native action, as the run's own review gate answers it (cloud-action-review.ts). */
export interface CloudCodexHomeReview {
	check(action: CloudCodexHomeAction, signal: AbortSignal): Promise<CloudActionGateResult>;
}

const REPEAT_COMMAND =
	"When you are woken because it was approved, run that exact command again yourself with your own shell, unchanged and in the same folder. There is no tool of yours to call for it: the card names what your shell asked for. Made unchanged, it runs without another review.";
const REPEAT_CHANGE =
	"When you are woken because it was approved, make that exact change again yourself with your own patch tool, unchanged. There is no tool of yours to call for it: the card names the patch you made. Made unchanged, it is applied without another review.";

/** A text's SHA-256, as lower-case hex. */
const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A text as the identity carries it: whole when it fits, else its head with its size and digest, so every byte of it
 * is still covered and the identity stays within the gate's bound. */
function bounded(value: string, limit: number): JsonValue {
	const bytes = Buffer.byteLength(value);
	if (bytes <= limit) return value;
	const head = new TextDecoder().decode(Buffer.from(value, "utf8").subarray(0, limit)).replace(/�$/, "");
	return { head, bytes, sha256: digestOf(value) };
}

/** A path on the machine as Codex names it (`file:///company/a.md`, `/company/a.md` or relative to the folder),
 * made absolute; undefined for anything that is not a path. */
function machinePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) return undefined;
	let path = value;
	if (path.startsWith("file://")) {
		try {
			path = decodeURIComponent(new URL(path).pathname);
		} catch {
			return undefined;
		}
	}
	return posix.resolve(CLOUD_HOME_CWD, path);
}

/** The company folder's own path for a machine path (`/company/notes/a.md` is `notes/a.md`), as the work log's paths
 * are everywhere else; undefined outside the folder. */
function folderPath(path: string): string | undefined {
	const prefix = `${CLOUD_HOME_CWD}/`;
	return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : undefined;
}

/** One path as a step names it: `path` inside the company folder (so erasure and zoom find it), `machinePath`
 * outside it, where the folder's rules do not reach. */
function stepPath(path: string): Record<string, JsonValue> {
	const inFolder = folderPath(path);
	return inFolder === undefined ? { machinePath: path } : { path: inFolder };
}

function finishAction(input: {
	tool: CloudCodexHomeAction["tool"];
	machine: CloudCodexHomeMachine;
	summary: string;
	identity: Record<string, JsonValue>;
	contents?: JsonValue;
	callId: string;
	step: { tool: string; arguments: Record<string, JsonValue>; paths: readonly string[] };
	repeat: string;
}): CloudCodexHomeAction {
	const summary = input.summary.slice(0, CARD_CHARS);
	// The card reads `machine` and `command`; the rest is what the model chose, whole.
	const argumentsText = JSON.stringify({
		machine: input.machine.name,
		machineId: input.machine.id,
		command: summary,
		...input.identity,
	});
	const stepText = JSON.stringify(input.step.arguments);
	return {
		tool: input.tool,
		summary,
		argumentsText,
		argumentSha256: digestOf(argumentsText),
		...(input.contents === undefined ? {} : { contents: input.contents }),
		callId: input.callId,
		step: {
			tool: input.step.tool,
			argumentsText: stepText,
			paths: [...new Set(input.step.paths.flatMap((path) => folderPath(path) ?? []))],
		},
		repeat: input.repeat,
	};
}

/** The text a command runs: the shell's own words for `bash -lc <text>`, otherwise its arguments. */
function commandText(argv: readonly string[]): string {
	return argv.length === 3 && (argv[1] === "-lc" || argv[1] === "-c") ? argv[2] : argv.join(" ");
}

/** A command the model runs (`process/start`): what it runs, where, and whether on a terminal. The process's own id,
 * its environment (Codex's, the same for every command) and the call's metadata are not part of what is approved:
 * they change with every process and every thread, and an approval that covered them could never be used again. */
export function cloudHomeCommandAction(
	machine: CloudCodexHomeMachine,
	params: Record<string, unknown>,
	callId: string,
): CloudCodexHomeAction | undefined {
	const argv = Array.isArray(params.argv)
		? params.argv.filter((part): part is string => typeof part === "string")
		: [];
	if (argv.length === 0 || argv.length !== (params.argv as unknown[]).length) return undefined;
	const cwd = machinePath(params.cwd) ?? CLOUD_HOME_CWD;
	const tty = params.tty === true;
	const text = commandText(argv);
	return finishAction({
		tool: "home_command",
		machine,
		summary: text,
		identity: { argv: argv.map((part) => bounded(part, IDENTITY_TEXT_BYTES)), cwd, tty },
		callId,
		step: { tool: "exec_command", arguments: { command: text, workdir: cwd, ...(tty ? { tty } : {}) }, paths: [] },
		repeat: REPEAT_COMMAND,
	});
}

/** What the model types into a shell that is already running (`process/write`): another command, and an approval of
 * the shell is not an approval of it (review round 1, F2). It is approved with the shell it goes into. An empty write
 * only asks for output and is not an action. */
export function cloudHomeStdinAction(
	machine: CloudCodexHomeMachine,
	params: Record<string, unknown>,
	into: { readonly command: string; readonly cwd: string } | undefined,
	callId: string,
): CloudCodexHomeAction | undefined {
	if (typeof params.chunk !== "string") return undefined;
	const text = Buffer.from(params.chunk, "base64").toString("utf8");
	if (text.length === 0) return undefined;
	return finishAction({
		tool: "home_command",
		machine,
		summary: text,
		identity: {
			typed: bounded(text, IDENTITY_TEXT_BYTES),
			into: into ? { command: bounded(into.command, IDENTITY_TEXT_BYTES), cwd: into.cwd } : null,
		},
		callId,
		step: { tool: "write_stdin", arguments: { chars: text, ...(into ? { into: into.command } : {}) }, paths: [] },
		repeat: REPEAT_COMMAND,
	});
}

/** One patch of the model's, as Codex said it starts (its `fileChange` item): every file, what is done to it, and the
 * diff the model wrote. */
export interface CloudCodexHomePatch {
	readonly callId: string;
	readonly changes: readonly {
		readonly path: string;
		readonly kind: string;
		readonly movePath?: string;
		readonly diff: string;
	}[];
	/** Every machine path the patch touches, its moves' destinations included. */
	readonly paths: ReadonlySet<string>;
}

/** Codex's `fileChange` item, or undefined for any other item. */
export function parseCloudCodexHomePatch(item: unknown): CloudCodexHomePatch | undefined {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const record = item as Record<string, unknown>;
	if (record.type !== "fileChange" || typeof record.id !== "string" || !CALL_ID.test(record.id)) return undefined;
	if (!Array.isArray(record.changes) || record.changes.length === 0 || record.changes.length > 1000) return undefined;
	const changes: { path: string; kind: string; movePath?: string; diff: string }[] = [];
	const paths = new Set<string>();
	for (const entry of record.changes) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const change = entry as Record<string, unknown>;
		const path = machinePath(change.path);
		const kind =
			change.kind && typeof change.kind === "object" && !Array.isArray(change.kind)
				? (change.kind as Record<string, unknown>)
				: {};
		if (!path || typeof kind.type !== "string" || !/^[a-z]{1,16}$/.test(kind.type)) return undefined;
		const moved = machinePath(kind.movePath ?? kind.move_path);
		changes.push({
			path,
			kind: kind.type,
			...(moved ? { movePath: moved } : {}),
			diff: typeof change.diff === "string" ? change.diff : "",
		});
		paths.add(path);
		if (moved) paths.add(moved);
	}
	return { callId: record.id, changes, paths };
}

/** A patch as the review approves it: one action for the whole call, with every file and its diff. */
export function cloudHomePatchAction(machine: CloudCodexHomeMachine, patch: CloudCodexHomePatch): CloudCodexHomeAction {
	const each = Math.max(1024, Math.floor(IDENTITY_PATCH_BYTES / patch.changes.length));
	const shown: Record<string, JsonValue>[] = patch.changes.map((change) => ({
		...stepPath(change.path),
		kind: change.kind,
		...(change.movePath ? { to: folderPath(change.movePath) ?? change.movePath } : {}),
	}));
	const names = patch.changes.map((change) => folderPath(change.path) ?? change.path);
	return finishAction({
		tool: "home_change",
		machine,
		summary: `Change ${patch.changes.length === 1 ? "1 file" : `${patch.changes.length} files`}: ${names.join(", ")}`,
		identity: {
			changes: patch.changes.map((change, at) => ({ ...shown[at], diff: bounded(change.diff, each) })),
			// The whole patch, whatever of it the bounded diffs above leave out.
			patchSha256: digestOf(JSON.stringify(patch.changes)),
		},
		callId: patch.callId,
		step: {
			tool: "apply_patch",
			arguments: { changes: patch.changes.map((change, at) => ({ ...shown[at], diff: change.diff })) },
			paths: [...patch.paths],
		},
		repeat: REPEAT_CHANGE,
	});
}

/** A file change no patch of the model's accounts for: reviewed on its own, with the text it writes shown to the
 * reviewer (as a folder tool's write is), and kept under this host's own id. */
export function cloudHomeFileAction(
	machine: CloudCodexHomeMachine,
	method: string,
	params: Record<string, unknown>,
	callId: string,
): CloudCodexHomeAction {
	const paths = [params.path, params.sourcePath, params.source, params.destinationPath, params.destination]
		.map(machinePath)
		.filter((path): path is string => path !== undefined);
	const data = typeof params.dataBase64 === "string" ? Buffer.from(params.dataBase64, "base64") : undefined;
	const text = data && !data.includes(0) ? new TextDecoder("utf-8", { fatal: false }).decode(data) : undefined;
	const what = method.replace(/^fs\//, "");
	return finishAction({
		tool: "home_change",
		machine,
		summary: `${what} ${paths.map((path) => folderPath(path) ?? path).join(" to ") || "a file"}`,
		identity: {
			method,
			paths,
			recursive: params.recursive === true,
			...(data ? { data: { bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") } } : {}),
		},
		...(text === undefined ? {} : { contents: bounded(text, IDENTITY_TEXT_BYTES) }),
		callId,
		step: { tool: "home_change", arguments: { method, changes: paths.map(stepPath) }, paths },
		repeat: REPEAT_CHANGE,
	});
}

/** One step of the run's work log that an action opened, until the fence releases its call's output. */
interface OpenStep {
	readonly j: number;
	readonly paths: readonly string[];
}

/**
 * The run's native steps: what the model did on its home, as the run's work log holds it.
 *
 * A step is opened and **committed before the action runs** (`precommit`, as the tool boundary does for an acting
 * tool call; RUNTIME-AGENT-MEMORY-TREE.md §4.5), so a run that stops between the change and its answer still has the
 * record of what it was about to do; an action whose step cannot be committed does not happen. It is finished with the
 * exact envelope the model is shown, whenever the result fence releases that call's output, so a command that yields
 * before it ends keeps the step it was given; a turn that ends first leaves the step pending, which is what a pending
 * step means everywhere else. One call is one step: a patch's several files are one.
 */
export class CloudCodexHomeSteps {
	readonly #log: CloudRunLog;
	readonly #open = new Map<string, OpenStep>();
	/** Counted for the proof and the report. */
	opened = 0;
	finished = 0;

	constructor(log: CloudRunLog) {
		this.#log = log;
	}

	/** Whether a call has a step still waiting for its output. */
	has(callId: string): boolean {
		return this.#open.has(callId);
	}

	/** The step for this action, committed before it runs. Throws when the log cannot take it. */
	async open(action: CloudCodexHomeAction, signal: AbortSignal): Promise<void> {
		if (this.#open.has(action.callId)) return;
		const j = this.#log.step({
			call: action.callId,
			tool: action.step.tool,
			argumentsText: action.step.argumentsText,
			argumentSha256: digestOf(action.step.argumentsText),
		});
		this.#open.set(action.callId, { j, paths: action.step.paths });
		remember(this.#open, MAX_REMEMBERED);
		this.opened++;
		await this.#log.precommit(j, signal);
	}

	/** The result fence releasing this call's output: its step keeps the exact envelope the model got. A call that
	 * never acted on the machine (refused, or failed before it got there) is kept as a step too, written and finished
	 * at once, when this host knows what it was: the run's record is never thinner than what the model did and saw. */
	finish(callId: string, envelope: string, otherwise?: CloudCodexHomeAction["step"]): void {
		const step = this.#open.get(callId);
		if (!step) {
			if (!otherwise) return;
			const j = this.#log.step({
				call: callId,
				tool: otherwise.tool,
				argumentsText: otherwise.argumentsText,
				argumentSha256: digestOf(otherwise.argumentsText),
			});
			this.finished++;
			this.#log.finish(j, envelope, [], []);
			return;
		}
		this.#open.delete(callId);
		this.finished++;
		this.#log.finish(step.j, envelope, [], step.paths);
	}
}

/** Keeps the newest entries only: a turn of thousands cannot grow these without bound. */
function remember(
	store: { size: number; delete(key: string): boolean; keys(): IterableIterator<string> },
	limit: number,
): void {
	while (store.size > limit) store.delete(store.keys().next().value as string);
}

/** One connection of Codex's to its home, as the host keeps it. */
interface Connection {
	readonly client: Socket;
	/** The requests forwarded that the machine has not answered yet, by the id Codex gave them, with the call each
	 * belongs to: if the machine goes while they are out there, each is answered in words. */
	readonly waiting: Map<string, string | undefined>;
	stream?: CloudCodexHomeStream;
	pump?: Promise<void>;
	/** Codex's handshake on this connection, told again to a machine that comes back. */
	initialize?: Record<string, unknown>;
	initialized?: string;
	/** A handshake told again, until its answer comes. */
	again?: { readonly id: string; readonly answered: () => void };
	/** Codex is done with this connection (or the run is): its channel ending then is no loss. */
	closing?: boolean;
	/** The model's processes on the current channel, and those of channels that went away: a request about one of
	 * those is that process's loss, never a question for a machine that does not know it. */
	readonly live: Set<string>;
	readonly gone: Set<string>;
	/** Admitted actions whose requests name no call of the model's (a typed line, a lone file change), by request id:
	 * their steps, kept under this host's own ids and finished with the machine's own answer to each. */
	readonly unnamed: Map<string, string>;
}

/** The model's call a request names (`metadata.toolCallId`), when it names one. */
function parseCallId(params: Record<string, unknown>): string | undefined {
	const metadata =
		params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
			? (params.metadata as Record<string, unknown>)
			: undefined;
	return typeof metadata?.toolCallId === "string" && CALL_ID.test(metadata.toolCallId)
		? metadata.toolCallId
		: undefined;
}

/** A JSON-RPC line as an object, or undefined for anything else (which the machine's own parser answers). */
function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The machine answered this line: that request is no longer waiting. The id is read from the head of the line where
 * it sits there (every answer of the exec-server's), and otherwise by reading the line itself, so a request is never
 * told its machine was lost when the machine had in fact answered it. The machine's own notifications (output,
 * exited) carry a method and no id, and the big ones are never parsed twice.
 */
function answered(line: string, waiting: Map<string, string | undefined>): void {
	if (waiting.size === 0) return;
	const head = ANSWER_ID.exec(line.slice(0, 200));
	if (head?.[1]) {
		waiting.delete(head[1]);
		return;
	}
	if (line.length > ANSWER_READ_CHARS || !line.includes('"id"')) return;
	const message = parseLine(line);
	if (!message || typeof message.method === "string") return;
	if (typeof message.id === "string" || typeof message.id === "number") waiting.delete(JSON.stringify(message.id));
}

/**
 * One line from the model's Codex that this host answers itself, because there is no machine to forward it to: the
 * same JSON-RPC error a refused action gets, so Codex hands the model words instead of a tool that never answers.
 * A notification (no id) is answered with nothing, as the machine would answer it with nothing.
 */
function refusalLine(line: string, words: string): string | undefined {
	let id: unknown;
	try {
		const value: unknown = JSON.parse(line);
		if (value && typeof value === "object" && !Array.isArray(value)) id = (value as Record<string, unknown>).id;
	} catch {
		return undefined;
	}
	if (typeof id !== "string" && typeof id !== "number") return undefined;
	return JSON.stringify({ id, error: { code: -32010, message: words } });
}

/**
 * The host side of one run's home: the socket its Codex reaches, the channel to the machine, the review of every
 * action and the run's native steps. One home belongs to one run.
 */
export class CloudCodexHome {
	readonly #channel: CloudCodexHomeChannel;
	#sessionId: string;
	readonly #machine: CloudCodexHomeMachine;
	readonly #review?: CloudCodexHomeReview;
	readonly #steps?: CloudCodexHomeSteps;
	readonly #signal: AbortSignal;
	readonly #sockets = new Set<Socket>();
	#server?: Server;
	#path?: string;
	/** Counted from the run, for the report: lines each way, actions reviewed, actions the review stopped, requests
	 * that lost their machine mid-command. */
	readonly counts = {
		toMachine: 0,
		fromMachine: 0,
		reviewed: 0,
		declined: 0,
		unrecorded: 0,
		connections: 0,
		lost: 0,
		dropped: 0,
	};
	/** The words this host has for a call of the model's that it refused or that lost its machine, shown first in that
	 * call's output (Codex's own output for a failed patch drops them). */
	readonly #notes = new Map<string, string>();
	/** While the home is not there (it would not open, or went away), the words a call is shown that never reached
	 * the machine at all. */
	#down?: string;
	/** The calls of the model's that reached the machine: they ran there, so "nothing ran there" is never theirs. */
	readonly #reached = new Set<string>();
	/** What this host knows of a call of the model's that may never act on the machine (Codex announced it, or the
	 * review refused it): the step it is kept as, should it end without one. */
	readonly #known = new Map<string, CloudCodexHomeAction["step"]>();
	/** The model's processes, by the id Codex gave each: what a write into one is typed into. */
	readonly #processes = new Map<string, { readonly command: string; readonly cwd: string; readonly callId: string }>();
	/** The model's patches in progress, by call, as Codex announced them; a file change belongs to the one that names
	 * its path. */
	readonly #patches = new Map<string, CloudCodexHomePatch>();
	/** Each patch's one admission (its review and its step), which every file change of that call waits on. */
	readonly #admitted = new Map<string, Promise<string | undefined>>();
	readonly #patchNotices = new Set<() => void>();
	/** This host's own ids, for actions no call of the model's names, and for a handshake told again. */
	#unnamed = 0;
	#again = 0;
	/** Whether a channel was ever opened, so the run closes only a session the executor really made. */
	#opened = false;
	readonly #endSession?: (sessionId: string, reason: "ended" | "stopped") => Promise<void>;
	/** Why a channel would not open or ended, for this host's journal alone. */
	cause?: string;
	#failure?: string;

	/** The Codex the namespace runs `stdio-to-uds` with; the session's own artifact unless a proof's harness, whose
	 * command is its wrapper, names the binary the namespace actually has. */
	readonly program?: string;

	constructor(options: {
		channel: CloudCodexHomeChannel;
		sessionId: string;
		machine: CloudCodexHomeMachine;
		program?: string;
		review?: CloudCodexHomeReview;
		steps?: CloudCodexHomeSteps;
		/** Closes the run's session in SQL (`qorpera_close_home_session`) when the run ends. */
		endSession?: (sessionId: string, reason: "ended" | "stopped") => Promise<void>;
		signal: AbortSignal;
	}) {
		this.#channel = options.channel;
		this.#sessionId = options.sessionId;
		this.#machine = options.machine;
		this.#review = options.review;
		this.#steps = options.steps;
		this.#signal = options.signal;
		this.#endSession = options.endSession;
		this.program = options.program;
	}

	get steps(): CloudCodexHomeSteps | undefined {
		return this.#steps;
	}

	/** The result fence asks, for each call of Codex's own it releases, what to say first: this host's words for it,
	 * or, while the home is not there, why. */
	noteFor(callId: string): string | undefined {
		const note = this.#notes.get(callId);
		this.#notes.delete(callId);
		if (note) return note;
		return this.#reached.has(callId) ? undefined : this.#down;
	}

	/** The result fence released this call's output (`native`: one of Codex's own, not a tool of ours): its step keeps
	 * the exact envelope the model got. */
	released(callId: string, envelope: string, native = true): void {
		const known = this.#known.get(callId);
		this.#known.delete(callId);
		if (native) this.#steps?.finish(callId, envelope, known);
	}

	/** This host's words for one call of the model's, when it knows the call. */
	#note(callId: string | undefined, words: string): void {
		if (!callId || callId.startsWith("home:")) return;
		this.#notes.set(callId, words);
		remember(this.#notes, MAX_REMEMBERED);
	}

	/**
	 * One of Codex's own item notifications. A patch's file changes name no call of the model's, so the patches it
	 * announces are what they are matched to, by their paths: a patch starts before its first change and completes
	 * after its last.
	 */
	noteItem(method: string, params: Record<string, unknown>): void {
		if (method !== "item/started" && method !== "item/completed") return;
		const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : {};
		// A command Codex announced: should it end before it reached the machine, it is still the run's step.
		if (
			method === "item/started" &&
			item.type === "commandExecution" &&
			typeof item.id === "string" &&
			CALL_ID.test(item.id)
		) {
			const command = typeof item.command === "string" ? item.command : "";
			this.#known.set(item.id, { tool: "exec_command", argumentsText: JSON.stringify({ command }), paths: [] });
			remember(this.#known, MAX_REMEMBERED);
		}
		const patch = parseCloudCodexHomePatch(params.item);
		if (!patch) return;
		if (method === "item/completed") {
			this.#patches.delete(patch.callId);
			this.#admitted.delete(patch.callId);
			return;
		}
		this.#patches.set(patch.callId, patch);
		remember(this.#patches, MAX_REMEMBERED);
		this.#known.set(patch.callId, cloudHomePatchAction(this.#machine, patch).step);
		remember(this.#known, MAX_REMEMBERED);
		for (const wake of this.#patchNotices) wake();
	}

	/** The socket the namespace is given, inside the run's own scratch root (bound read-only, as the fence's is). */
	get socketPath(): string {
		if (!this.#path) throw new Error("The home's socket is not open");
		return this.#path;
	}

	/** Why the home could not serve the model, in the words the model is shown. */
	get failure(): string | undefined {
		return this.#failure;
	}

	/** Opens the socket in `root`. One per run; the namespace connects when the model first uses a native tool. */
	async listen(root: string): Promise<void> {
		if (!isAbsolute(root)) throw new Error("Invalid home root");
		const path = join(root, CLOUD_HOME_SOCKET_NAME);
		const server = createServer((socket) => this.#serve(socket));
		server.on("error", () => undefined);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		// This user alone, as the result fence's socket is (cloud-native-isolation.ts checks the same of it).
		await chmod(path, 0o600);
		this.#server = server;
		this.#path = path;
	}

	/**
	 * The run is over, however it ended: the socket goes, every connection with it (and so every exec-server the run
	 * had on its machine), and the session the executor opened is closed in SQL. A close that cannot be made is not
	 * worth failing the run for: the run's next attempt supersedes it (review round 1, F10).
	 */
	async close(reason: "ended" | "stopped" = "ended"): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		for (const wake of this.#patchNotices) wake();
		const server = this.#server;
		this.#server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (this.#path) await rm(this.#path, { force: true }).catch(() => undefined);
		if (this.#opened && this.#endSession) {
			this.#opened = false;
			await this.#endSession(this.#sessionId, reason).catch(() => undefined);
		}
	}

	/** One connection of the namespace: its own channel to the machine for as long as it lasts. */
	#serve(client: Socket): void {
		if (this.#sockets.size >= MAX_CONNECTIONS) {
			client.destroy();
			return;
		}
		this.#sockets.add(client);
		this.counts.connections++;
		client.on("error", () => undefined);
		client.once("close", () => this.#sockets.delete(client));
		void this.#relay(client).catch((error: unknown) => {
			// The host's own journal, never the model's: why one connection of the namespace ended.
			this.cause ??= `relay: ${String((error as Error)?.message ?? error)}`.slice(0, 200);
			client.destroy();
		});
	}

	/** The channel for one connection. A session of a boot that ended (the machine restarted under this run) is
	 * replaced by a new one on the new boot, once; every other refusal is said to the model in its own words. */
	async #open(): Promise<CloudCodexHomeStream> {
		for (let attempt = 0; ; attempt++) {
			try {
				const stream = await this.#channel.open(
					{ sessionId: this.#sessionId, machineId: this.#machine.id },
					this.#signal,
				);
				this.#opened = true;
				this.#down = undefined;
				return stream;
			} catch (error) {
				if (attempt === 0 && error instanceof CloudHomeChannelRefused && error.reason === "HOME_SESSION_ENDED") {
					this.#sessionId = randomUUID();
					continue;
				}
				throw error;
			}
		}
	}

	/**
	 * One connection of Codex's, for as long as it lasts. Its channel is opened when it starts and again whenever the
	 * machine's side went away under it (the machine stopped or restarted, its node's executor was rolled): the new
	 * exec-server is told what Codex told the one before (its `initialize` and `initialized`), so Codex's connection
	 * never dies with it and the model's next call simply works again. While there is no channel, every request is
	 * answered in words, and the model's turn goes on with the company's own tools.
	 */
	async #relay(client: Socket): Promise<void> {
		const connection: Connection = {
			client,
			waiting: new Map(),
			live: new Set(),
			gone: new Set(),
			unnamed: new Map(),
		};
		let retryAt = 0;
		const stop = (): void => {
			connection.closing = true;
			client.destroy();
			void connection.stream?.close();
		};
		this.#signal.addEventListener("abort", stop, { once: true });
		/** A channel for this connection, or the words to answer with while there is none. */
		const connect = async (current: Record<string, unknown> | undefined): Promise<string | undefined> => {
			if (Date.now() < retryAt) return this.#down ?? CLOUD_HOME_UNAVAILABLE;
			try {
				const stream = await this.#open();
				connection.stream = stream;
				connection.pump = this.#pump(stream, connection);
				// Codex told its handshake once, on this connection; a channel that did not hear it is told it again by
				// this host before anything else, unless what comes now is that handshake itself.
				if (connection.initialize && current?.method !== "initialize") await this.#replay(stream, connection);
			} catch (error) {
				// The cause is the host's own; it is kept for this host's journal, never shown to the model.
				const stream = connection.stream;
				connection.stream = undefined;
				await stream?.close();
				await connection.pump?.catch(() => undefined);
				const words = cloudHomeRefusalWords(error instanceof CloudHomeChannelRefused ? error.reason : undefined);
				this.#failure ??= words;
				this.#down = words;
				this.cause ??= String((error as Error)?.message ?? error).slice(0, 200);
				retryAt = Date.now() + RETRY_MS;
				return words;
			}
			this.#down = undefined;
			return undefined;
		};
		try {
			for await (const line of cloudHomeChannelLines(client)) {
				const message = parseLine(line);
				// Codex's own handshake, kept for a machine that comes back.
				if (message?.method === "initialize" && connection.initialize === undefined)
					connection.initialize = message;
				if (message?.method === "initialized" && connection.initialized === undefined)
					connection.initialized = line;
				const words = connection.stream ? undefined : await connect(message);
				const answered =
					words !== undefined
						? refusalLine(line, words)
						: connection.stream
							? await this.#forward(line, message, connection)
							: undefined;
				if (answered !== undefined && client.writable) client.write(`${answered}\n`);
			}
		} finally {
			connection.closing = true;
			this.#signal.removeEventListener("abort", stop);
			const stream = connection.stream;
			connection.stream = undefined;
			await stream?.close();
			await connection.pump?.catch(() => undefined);
			client.destroy();
		}
	}

	/** A new exec-server is told Codex's handshake as Codex told the one before; its answer is this host's, not Codex's
	 * (the pump keeps it back). */
	async #replay(stream: CloudCodexHomeStream, connection: Connection): Promise<void> {
		const id = JSON.stringify(`qorpera-home-again-${++this.#again}`);
		let timer: NodeJS.Timeout | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				connection.again = { id, answered: resolve };
				timer = setTimeout(() => reject(new Error("The machine did not answer the handshake")), REPLAY_MS);
				stream.write(JSON.stringify({ ...connection.initialize, id: JSON.parse(id) as JsonValue }));
			});
		} finally {
			clearTimeout(timer);
			connection.again = undefined;
		}
		// Codex's own `initialized` when it said it; otherwise the same word, as Codex says it after an answer.
		stream.write(
			connection.initialized ??
				JSON.stringify({
					...(typeof connection.initialize?.jsonrpc === "string"
						? { jsonrpc: connection.initialize.jsonrpc }
						: {}),
					method: "initialized",
				}),
		);
	}

	/**
	 * The machine's lines to Codex. When they end while Codex is still connected, the machine went away under it: every
	 * request still out there is answered that it was lost mid-command (part of it may have happened), and the next
	 * one opens a channel again (review round 1, F3; the lead's question of 13 Nov 2026).
	 */
	async #pump(stream: CloudCodexHomeStream, connection: Connection): Promise<void> {
		try {
			for await (const line of stream.lines) {
				this.counts.fromMachine++;
				// The answer to a handshake this host told again is its own.
				const again = connection.again;
				if (again && ANSWER_ID.exec(line.slice(0, 200))?.[1] === again.id) {
					again.answered();
					continue;
				}
				answered(line, connection.waiting);
				if (connection.unnamed.size > 0) this.#unnamedAnswered(line, connection);
				// A process the machine closed is no longer one a loss could cut short.
				const closed = PROCESS_CLOSED.exec(line.slice(0, 200))?.[1];
				if (closed !== undefined) connection.live.delete(closed);
				if (!connection.client.writable) break;
				connection.client.write(`${line}\n`);
			}
		} catch {
			// A channel that broke is a channel that ended.
		} finally {
			if (connection.stream === stream) connection.stream = undefined;
			if (!connection.closing && !connection.client.destroyed) {
				this.#failure ??= CLOUD_HOME_LOST;
				// Until a channel opens again, a call the machine never saw is told why: its home was lost under the
				// processes it had running (a poll of one is answered by Codex itself, never reaching this host), or,
				// with none running, that its home cannot be reached.
				this.#down = connection.live.size > 0 ? CLOUD_HOME_LOST : CLOUD_HOME_UNAVAILABLE;
				for (const started of connection.live) connection.gone.add(started);
				connection.live.clear();
				remember(connection.gone, MAX_REMEMBERED);
				for (const hostId of connection.unnamed.values())
					this.#steps?.finish(hostId, JSON.stringify({ error: { code: -32010, message: CLOUD_HOME_LOST } }));
				connection.unnamed.clear();
				for (const [id, callId] of connection.waiting) {
					this.counts.lost++;
					this.#note(callId, CLOUD_HOME_LOST);
					if (connection.client.writable)
						connection.client.write(
							`${JSON.stringify({ id: JSON.parse(id) as JsonValue, error: { code: -32010, message: CLOUD_HOME_LOST } })}\n`,
						);
				}
			}
			connection.waiting.clear();
		}
	}

	/** The machine answered an action that names no call: that answer is what its step keeps. */
	#unnamedAnswered(line: string, connection: Connection): void {
		let id = ANSWER_ID.exec(line.slice(0, 200))?.[1];
		if (id === undefined && line.length <= ANSWER_READ_CHARS) {
			const message = parseLine(line);
			if (
				message &&
				typeof message.method !== "string" &&
				(typeof message.id === "string" || typeof message.id === "number")
			)
				id = JSON.stringify(message.id);
		}
		const hostId = id === undefined ? undefined : connection.unnamed.get(id);
		if (id === undefined || hostId === undefined) return;
		connection.unnamed.delete(id);
		this.#steps?.finish(hostId, line.length <= ANSWER_READ_CHARS ? line : JSON.stringify({ answered: true }));
	}

	/**
	 * One line from the model's Codex towards its home. Returns a line to answer it with instead of forwarding it: a
	 * JSON-RPC error carrying the review's own words, or the host's own when the run's record could not be kept.
	 * Codex gives either to the model as its tool's failure, which the model can act on. Lines are taken one at a
	 * time, so nothing a later line asks overtakes an earlier one still under review.
	 */
	async #forward(
		line: string,
		message: Record<string, unknown> | undefined,
		connection: Connection,
	): Promise<string | undefined> {
		const stream = connection.stream;
		if (!stream) return refusalLine(line, CLOUD_HOME_UNAVAILABLE);
		const method = typeof message?.method === "string" ? message.method : undefined;
		const id = message?.id;
		const request = typeof id === "string" || typeof id === "number";
		// Toward the machine goes only what this host has read: a request (gated below) or the handshake's one
		// notification. Anything else is dropped, and a request this host cannot read is answered in words.
		if (!method || (!request && method !== "initialized")) {
			this.counts.dropped++;
			return request
				? JSON.stringify({ id, error: { code: -32600, message: CLOUD_HOME_REQUEST_INVALID } })
				: undefined;
		}
		const params =
			message?.params && typeof message.params === "object" && !Array.isArray(message.params)
				? (message.params as Record<string, unknown>)
				: {};
		const processId =
			typeof params.processId === "string" || typeof params.processId === "number"
				? JSON.stringify(params.processId)
				: undefined;
		let callId: string | undefined;
		let unnamed = false;
		if (request) {
			// A process that went with an earlier channel: the machine that answers now never knew it.
			if (processId && method !== "process/start" && connection.gone.has(processId)) {
				const named = parseCallId(params) ?? this.#processes.get(processId)?.callId;
				this.#note(named, CLOUD_HOME_LOST);
				return JSON.stringify({ id, error: { code: -32010, message: CLOUD_HOME_LOST } });
			}
			const gated = await this.#gate(method, params);
			callId = gated.callId;
			unnamed = gated.unnamed === true;
			if (gated.refusal !== undefined) {
				this.#note(callId, gated.refusal);
				return JSON.stringify({ id, error: { code: -32600, message: gated.refusal } });
			}
		}
		// Out there until the machine answers it: if the machine goes first, this is what gets the words instead.
		if (request) {
			connection.waiting.set(JSON.stringify(id), callId);
			remember(connection.waiting, MAX_REMEMBERED);
			if (unnamed && callId) connection.unnamed.set(JSON.stringify(id), callId);
		}
		if (method === "process/start" && processId) connection.live.add(processId);
		if (callId) {
			this.#reached.add(callId);
			remember(this.#reached, MAX_REMEMBERED);
		}
		this.counts.toMachine++;
		stream.write(line);
		return undefined;
	}

	/** Whether one request may reach the machine: the words to refuse it with (undefined to let it through), and the
	 * call of the model's it belongs to, when it belongs to one. */
	async #gate(
		method: string,
		params: Record<string, unknown>,
	): Promise<{ refusal?: string; callId?: string; unnamed?: boolean }> {
		const named = parseCallId(params);
		const callId = named ?? `home:${this.#sessionId}:${++this.#unnamed}`;
		const processId =
			typeof params.processId === "string" || typeof params.processId === "number"
				? JSON.stringify(params.processId)
				: undefined;
		/** Reviewed and recorded; an action no call of the model's names keeps its step under this host's own id, finished
		 * with the machine's answer (or, refused, with the refusal at once): which call made it is never guessed. */
		const settle = async (
			action: CloudCodexHomeAction,
		): Promise<{ refusal?: string; callId: string; unnamed?: boolean }> => {
			const refusal = await this.#admit(action);
			if (!action.callId.startsWith("home:")) return { refusal, callId: action.callId };
			if (refusal !== undefined)
				try {
					this.#steps?.finish(action.callId, JSON.stringify({ status: "refused", text: refusal }), action.step);
				} catch {
					// A log that cannot take the record now refused the action already; nothing more to keep.
				}
			return { refusal, callId: action.callId, unnamed: refusal === undefined };
		};
		if (method === "process/start") {
			const action = cloudHomeCommandAction(this.#machine, params, callId);
			// A command this host cannot read is not one it can review: it never reaches the machine.
			if (!action) return { refusal: CLOUD_HOME_REQUEST_INVALID };
			if (processId) {
				const argv = (params.argv as unknown[]).filter((part): part is string => typeof part === "string");
				this.#processes.set(processId, {
					command: commandText(argv),
					cwd: machinePath(params.cwd) ?? CLOUD_HOME_CWD,
					callId,
				});
				remember(this.#processes, MAX_REMEMBERED);
			}
			return await settle(action);
		}
		// A request about a running process (a read of its output, a write, its end) belongs to the call that names it,
		// or else to the command that started it: a machine lost while it waits is that command's loss.
		const running = processId ? this.#processes.get(processId) : undefined;
		if (method === "process/write") {
			if (params.chunk !== undefined && typeof params.chunk !== "string")
				return { refusal: CLOUD_HOME_REQUEST_INVALID };
			const action = cloudHomeStdinAction(this.#machine, params, running, callId);
			// The pinned Codex's write names no call of the model's (the proof showed it): settle keeps it unguessed.
			return action ? await settle(action) : { callId: named ?? running?.callId };
		}
		// What needs no review is named: the handshake, the environment's own questions, a process's reads and end, and
		// the file reads. Any other method is refused, so a Codex pinned later with a new acting method can never reach
		// the machine unreviewed; any other `fs/` method is a change and is reviewed below.
		if (UNREVIEWED.has(method) || FS_READS.has(method))
			return { callId: named ?? (method.startsWith("process/") ? running?.callId : undefined) };
		if (!method.startsWith("fs/")) return { refusal: CLOUD_HOME_REQUEST_INVALID };
		// A change to files: the patch of the model's it belongs to, by its path, admitted once for the whole call.
		const touched = [params.path, params.sourcePath, params.source, params.destinationPath, params.destination]
			.map(machinePath)
			.filter((path): path is string => path !== undefined);
		const patch = await this.#patchFor(method, touched);
		if (!patch) return await settle(cloudHomeFileAction(this.#machine, method, params, callId));
		let admitted = this.#admitted.get(patch.callId);
		if (!admitted) {
			admitted = this.#admit(cloudHomePatchAction(this.#machine, patch));
			this.#admitted.set(patch.callId, admitted);
			remember(this.#admitted, MAX_REMEMBERED);
		}
		return { refusal: await admitted, callId: patch.callId };
	}

	/** The patch in progress that this change belongs to: one whose files include the path, or (for a folder it
	 * creates) one with a file inside it. Its announcement may come a moment after the change, so it is waited for. */
	async #patchFor(method: string, touched: readonly string[]): Promise<CloudCodexHomePatch | undefined> {
		const find = (): CloudCodexHomePatch | undefined => {
			for (const patch of this.#patches.values())
				for (const path of touched)
					if (
						patch.paths.has(path) ||
						(method === "fs/createDirectory" && [...patch.paths].some((file) => file.startsWith(`${path}/`)))
					)
						return patch;
			return undefined;
		};
		if (touched.length === 0) return undefined;
		const until = Date.now() + PATCH_NOTICE_MS;
		for (;;) {
			const found = find();
			const left = until - Date.now();
			if (found || left <= 0 || this.#signal.aborted) return found;
			await new Promise<void>((resolve) => {
				const done = (): void => {
					clearTimeout(timer);
					this.#patchNotices.delete(done);
					resolve();
				};
				const timer = setTimeout(done, left);
				this.#patchNotices.add(done);
			});
		}
	}

	/**
	 * The two things that stand between the model and its machine: the run's review, and the record the run keeps of
	 * what it is about to do. Returns the words to refuse with, or undefined to let the action through.
	 */
	async #admit(action: CloudCodexHomeAction): Promise<string | undefined> {
		if (this.#review) {
			this.counts.reviewed++;
			const gate = await this.#review.check(action, this.#signal);
			if (!gate.run) {
				this.counts.declined++;
				// Refused, it never acts; it is still the step the run keeps of what the model did and was told.
				if (!action.callId.startsWith("home:")) {
					this.#known.set(action.callId, action.step);
					remember(this.#known, MAX_REMEMBERED);
				}
				return gate.text;
			}
		}
		if (!this.#steps) return undefined;
		try {
			// Committed before the action runs (§4.5): an effect this run cannot account for must not happen.
			await this.#steps.open(action, this.#signal);
		} catch {
			this.counts.unrecorded++;
			return CLOUD_HOME_NO_RECORD;
		}
		return undefined;
	}
}

/** The environment file the host writes into the run's Codex home, so Codex reaches its home and nothing else. */
export function cloudHomeEnvironmentsToml(codexBinary: string, socketPath: string): string {
	if (!/^\/[A-Za-z0-9._/-]{1,400}$/.test(codexBinary) || !/^\/[A-Za-z0-9._/-]{1,400}$/.test(socketPath))
		throw new Error("Invalid home environment paths");
	return [
		"# Written by the Qorpera runtime for this run alone (cloud-codex-home.ts). Its socket is the run's own.",
		"include_local = false",
		`default = "${CLOUD_HOME_ENVIRONMENT_ID}"`,
		"",
		"[[environments]]",
		`id = "${CLOUD_HOME_ENVIRONMENT_ID}"`,
		`program = "${codexBinary}"`,
		`args = ["stdio-to-uds", "${socketPath}"]`,
		"",
	].join("\n");
}
