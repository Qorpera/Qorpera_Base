// The agent's home (lanes/agent-box-20261113/HOME-PLAN.md, slices 1, 2 and 4; proven in P1-CODEX-OWN-TOOLS.md).
//
// A run's Codex stays in its sealed slot, with the member's sign-in, no network and the result fence. Its OWN shell,
// stdin and apply_patch run on the run's home machine: Codex's `exec-server`, which it reaches as an "environment"
// through one Unix socket in the run's scratch root. This module is the host side of that socket:
//
//   Codex (in the slot) --(`codex stdio-to-uds`)--> <scratch root>/exec.sock --> this host
//     --> the coding executor's channel --> `codex exec-server --listen stdio` on the machine, as the agent's account
//     (qorpera-agent, non-root by default, root without a password when it asks: everything `machine_run` can do)
//
// Everything the model asks of its home passes here as one JSON-RPC line, before any byte reaches the machine, so this
// is where the review lives (slice 4) and where the run's work log learns what the model did (slice 2).
//
// Three rules this host keeps:
// - **Nothing of the slot travels.** The host writes the environment file itself; the line it forwards is Codex's own.
//   P1 scanned 1,198 messages of a run (9.2 MB) for two canaries and found none.
// - **Every command and every change to files is reviewed first** (slice 4), by the same gate and the same "ask first"
//   cards as `machine_run`. A refusal is words the model can act on, as a denied tool result is.
// - **Nothing happens without the company's switch** (`qorpera_company_home_available`). With it off this file is never
//   built, the thread has no environment, and the provider's request is exactly today's.

import { createHash } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { CLOUD_MACHINE_HOME, type JsonValue, POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import type { CloudActionGateResult } from "./cloud-action-review.ts";
import { cloudHomeChannelLines } from "./cloud-home-channel.ts";
import type { CloudRunLog } from "./cloud-run-log.ts";

/** The environment id the host registers for the home. Codex names it on every tool call it makes there. */
export const CLOUD_HOME_ENVIRONMENT_ID = "home";
/** Where the home's folder is mounted inside the machine, and the environment's working directory. */
export const CLOUD_HOME_CWD = CLOUD_MACHINE_HOME.cwd;
/** The socket the namespace reaches, beside the result fence's, in the run's own scratch root. */
export const CLOUD_HOME_SOCKET_NAME = "exec.sock";
/** Connections the namespace may hold at once: Codex opens one environment, and one more while it reconnects. */
const MAX_CONNECTIONS = 4;
/** Calls whose output has not been released yet; past it the oldest are forgotten, as the boundary forgets results. */
const MAX_OPEN_CALLS = 8_192;
/** How long the run waits for its session to be closed in SQL as it ends; a close that fails is left to the executor. */
export const CLOUD_HOME_CLOSE_MS = 5_000;
/** What the model is told when its home could not be reached. Plain words, and what to do instead. */
export const CLOUD_HOME_UNAVAILABLE =
	"HOME_UNAVAILABLE: this agent's machine could not be reached, so nothing ran there. Use the company's own tools, or try again.";

/**
 * The exec-server methods that do something on the machine, each reviewed before it is forwarded. `process/write` is
 * among them: once a shell is running, what the model types into it is another command, and an approval of the shell
 * is not an approval of that (review round 1, F2). Everything else Codex asks of its home is a read or a poll.
 */
const REVIEWED_METHODS: ReadonlyMap<string, "command" | "change"> = new Map([
	["process/start", "command"],
	["process/write", "command"],
	["fs/writeFile", "change"],
	["fs/createDirectory", "change"],
	["fs/remove", "change"],
	["fs/copy", "change"],
]);
/** How much of an action's words the card and the reviewer read; the digest still covers the whole of it. */
const CLOUD_HOME_SUMMARY_CHARS = 2000;
/** What the model is told when the run's work log could not keep the record an action must leave behind. */
export const CLOUD_HOME_NO_RECORD =
	"WORK_LOG_UNAVAILABLE: this agent's work log could not keep a record of that action, so it did not happen on the machine. Try again.";

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

/**
 * What one request of Codex's would do on the machine, read from the request itself and whole: the review's identity
 * covers all of it, so an approval of one action is never an approval of another (review round 1, F1).
 */
export interface CloudCodexHomeAction {
	/** How the review classifies it: a command on the machine, or a change to its files (cloud-action-review.ts). */
	readonly tool: "home_command" | "home_change";
	/** What the card and the reviewer read: the command itself, or the path and what is done to it. */
	readonly summary: string;
	/** The whole action as the review records it: the machine, the words above, and every parameter of the request
	 * (bytes as their size and digest). `argumentSha256` is this text's digest. */
	readonly argumentsText: string;
	readonly argumentSha256: string;
	/** The model's own call this belongs to, as the request names it or as the turn's current call. */
	readonly callId: string;
	/** The tool name the run's work log keeps for it. */
	readonly stepTool: string;
	readonly paths: readonly string[];
	/** What a parked card tells the model to do when it is approved later. A home action is not a tool of the model's
	 * own, so "call the same tool again with the card's `call`" would be words it cannot act on (review round 1, F8). */
	readonly repeat: string;
}

/** The review of one native action, as the run's own review gate answers it (cloud-action-review.ts). */
export interface CloudCodexHomeReview {
	check(action: CloudCodexHomeAction, signal: AbortSignal): Promise<CloudActionGateResult>;
}

/** One step of the run's work log that an action opened, until the fence releases its call's output. */
interface OpenStep {
	readonly j: number;
	paths: string[];
}

/**
 * The run's native steps: what the model did on its home, as the run's work log holds it.
 *
 * A step is opened and **committed before the action runs** (`precommit`, as the tool boundary does for an acting
 * tool call; RUNTIME-AGENT-MEMORY-TREE.md §4.5), so a run that stops between the change and its answer still has the
 * record of what it was about to do. It is finished with the exact envelope the model is shown, whenever the result
 * fence releases that call's output; a turn that ends first leaves the step as it was committed, pending, which is
 * what a pending step means everywhere else.
 *
 * The step's arguments are the action the host reviewed, not Codex's later word about it, so a command that yields
 * before it ends, a write to its stdin and a file change all keep their step whatever order the news arrives in
 * (review round 1, F6 and F7). Several actions of one call (a patch writes several files) share its step and add
 * their paths to it.
 *
 * Without this a run that works on its home keeps no work log at all, and in Shared context the fold leaves its own
 * work out with no line.
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

	/**
	 * The step for this action, committed before it runs. Throws when the log cannot take it: the caller then refuses
	 * the action, because an effect with no record is worse than an effect that does not happen.
	 */
	async open(action: CloudCodexHomeAction, signal: AbortSignal): Promise<void> {
		const already = this.#open.get(action.callId);
		if (already) {
			for (const path of action.paths) if (!already.paths.includes(path)) already.paths.push(path);
			return;
		}
		const j = this.#log.step({
			call: action.callId,
			tool: action.stepTool,
			argumentsText: action.argumentsText,
			argumentSha256: action.argumentSha256,
		});
		this.#open.set(action.callId, { j, paths: [...action.paths] });
		remember(this.#open, MAX_OPEN_CALLS);
		this.opened++;
		await this.#log.precommit(j, signal);
	}

	/** The result fence releasing this call's output: its step keeps the exact envelope the model got. */
	finish(callId: string, envelope: string): void {
		const step = this.#open.get(callId);
		if (!step) return;
		this.#open.delete(callId);
		this.finished++;
		this.#log.finish(step.j, envelope, [], [...step.paths]);
	}
}

/** Keeps the newest entries only: a turn of thousands cannot grow these without bound. */
function remember(store: Map<string, unknown>, limit: number): void {
	while (store.size > limit) store.delete(store.keys().next().value as string);
}

/** A request's bytes, as the action records them: never the bytes themselves, always their size and digest. */
function digestOfBytes(value: string): JsonValue {
	const bytes = Buffer.from(value, "base64");
	return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** A path as a person reads it: `file:///company/notes/plan.md` is `/company/notes/plan.md`. */
function plainPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined;
	return value.startsWith("file://") ? decodeURI(value.slice("file://".length)) : value;
}

/**
 * What a request of Codex's would do, whole. Every parameter is kept, with bytes replaced by their size and digest,
 * so the digest below is the identity of this exact action on this exact machine, and nothing an approval covers is
 * left out of it (review round 1, F1).
 */
export function describeCloudHomeAction(
	method: string,
	params: Record<string, unknown>,
	machine: { readonly id: string; readonly name: string },
	callId: string,
): CloudCodexHomeAction | undefined {
	const kind = REVIEWED_METHODS.get(method);
	if (!kind) return undefined;
	const parameters: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(params)) {
		if (key === "metadata") continue;
		if ((key === "dataBase64" || key === "chunk") && typeof value === "string")
			parameters[key] = digestOfBytes(value);
		else parameters[key] = (value ?? null) as JsonValue;
	}
	const paths = [params.path, params.sourcePath, params.source, params.destination]
		.map(plainPath)
		.filter((path): path is string => path !== undefined);
	let summary: string;
	let stepTool: string;
	if (method === "process/start") {
		const argv = Array.isArray(params.argv)
			? params.argv.filter((part): part is string => typeof part === "string")
			: [];
		if (argv.length === 0) return undefined;
		summary = argv.join(" ");
		stepTool = "exec_command";
	} else if (method === "process/write") {
		// What the model is typing into a shell that is already running: a command of its own, so it is reviewed as
		// one (review round 1, F2). Empty writes are only a poll for output and change nothing.
		const chunk = typeof params.chunk === "string" ? Buffer.from(params.chunk, "base64").toString("utf8") : "";
		if (chunk.length === 0) return undefined;
		summary = chunk;
		stepTool = "write_stdin";
	} else {
		summary = `${method.replace("fs/", "")} ${paths.join(" to ") || "a file"}`;
		stepTool = "apply_patch";
	}
	const canonical = {
		machine: machine.name,
		// The words the card and the reviewer read. The whole action is below, and the digest covers all of it.
		command: summary.slice(0, CLOUD_HOME_SUMMARY_CHARS),
		action: { method, machineId: machine.id, parameters },
	} satisfies JsonValue;
	const argumentsText = cloudToolJsonText(canonical, MAX_TOOL_ARGUMENT_BYTES);
	return {
		tool: kind === "command" ? "home_command" : "home_change",
		summary: canonical.command,
		argumentsText,
		argumentSha256: createHash("sha256").update(argumentsText).digest("hex"),
		callId,
		stepTool,
		paths,
		repeat:
			kind === "command"
				? "When you are woken because it was approved, do the same thing again on your own machine yourself: run that exact command once more, unchanged, with your own shell. There is no tool of yours to call for it, and the card is not one of your tool calls; it names what your shell asked for, under `call.action`. Run unchanged, it happens without another review."
				: "When you are woken because it was approved, make that exact change again on your own machine yourself: the same file and the same contents, with your own file tools. There is no tool of yours to call for it, and the card is not one of your tool calls; it names what your file tool asked for, under `call.action`. Made unchanged, it happens without another review.",
	};
}

/**
 * The host side of one run's home: the socket its Codex reaches, the channel to the machine, the review of every
 * action and the run's native steps. One home belongs to one run.
 */
export class CloudCodexHome {
	readonly #channel: CloudCodexHomeChannel;
	readonly #sessionId: string;
	readonly #machine: { readonly id: string; readonly name: string };
	readonly #review?: CloudCodexHomeReview;
	readonly #steps?: CloudCodexHomeSteps;
	readonly #signal: AbortSignal;
	readonly #sockets = new Set<Socket>();
	#server?: Server;
	#path?: string;
	/** Counted from the run, for the report: lines each way, actions reviewed, actions the review stopped. */
	readonly counts = { toMachine: 0, fromMachine: 0, reviewed: 0, declined: 0, unrecorded: 0, connections: 0 };
	/** The model's call the machine is working on now: a patch's file changes belong to it. */
	#call?: string;
	/** Whether a channel was ever opened, so the run closes only a session the executor really made. */
	#opened = false;
	readonly #endSession?: (sessionId: string, reason: "ended" | "stopped") => Promise<void>;
	/** Why a channel would not open, for this host's journal alone. */
	cause?: string;
	#failure?: string;

	/** The Codex the namespace runs `stdio-to-uds` with; the session's own artifact unless a proof's harness, whose
	 * command is its wrapper, names the binary the namespace actually has. */
	readonly program?: string;

	constructor(options: {
		channel: CloudCodexHomeChannel;
		sessionId: string;
		machine: { readonly id: string; readonly name: string };
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

	/**
	 * One of Codex's own item notifications. The step's words come from the request this host reviewed, not from
	 * here; what this adds is which call the machine is working on, so a patch's file changes (whose requests name no
	 * call) belong to the call that made them.
	 */
	noteItem(method: string, params: Record<string, unknown>): void {
		if (method !== "item/started" && method !== "item/completed") return;
		const item = params.item;
		const id =
			item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).id : undefined;
		if (typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(id))
			this.#call = id;
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
	 * The run is over, however it ended: the socket goes, and the session the executor opened is closed in SQL, so
	 * the run's next attempt opens its own instead of meeting its predecessor (review round 1, F10). A close that
	 * cannot be made is not worth failing the run for: the executor closes a session whose run or boot has gone.
	 */
	async close(reason: "ended" | "stopped" = "ended"): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
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
		void this.#relay(client).catch(() => {
			client.destroy();
		});
	}

	async #relay(client: Socket): Promise<void> {
		let stream: CloudCodexHomeStream;
		try {
			stream = await this.#channel.open({ sessionId: this.#sessionId, machineId: this.#machine.id }, this.#signal);
		} catch (error) {
			// The model asked for its home and there is none: say so in words, on the next line it reads, and let its
			// turn go on with the company's own tools. The cause is the host's own (a refusal of the ingress, a channel
			// that would not open); it is kept for this host's journal, never shown to the model or the provider.
			this.#failure ??= CLOUD_HOME_UNAVAILABLE;
			this.cause ??= String((error as Error)?.message ?? error).slice(0, 200);
			client.destroy();
			return;
		}
		this.#opened = true;
		const stop = (): void => {
			client.destroy();
			void stream.close();
		};
		this.#signal.addEventListener("abort", stop, { once: true });
		// Either side ending ends the other (review round 1, F3): a machine whose exec-server closed leaves nothing
		// waiting in the slot, and a slot whose Codex went leaves no process running on the machine.
		const fromMachine = (async () => {
			try {
				for await (const line of stream.lines) {
					this.counts.fromMachine++;
					if (!client.writable) break;
					client.write(`${line}\n`);
				}
			} finally {
				client.destroy();
			}
		})();
		try {
			for await (const line of cloudHomeChannelLines(client)) {
				const answered = await this.#forward(line, stream);
				if (answered !== undefined && client.writable) client.write(`${answered}\n`);
			}
		} finally {
			this.#signal.removeEventListener("abort", stop);
			await stream.close();
			await fromMachine.catch(() => undefined);
			client.destroy();
		}
	}

	/**
	 * One line from the model's Codex towards its home. Returns a line to answer it with instead of forwarding it: a
	 * JSON-RPC error carrying the review's own words, or the host's own when the run's record could not be kept.
	 * Codex gives either to the model as its tool's failure, which the model can act on.
	 */
	async #forward(line: string, stream: CloudCodexHomeStream): Promise<string | undefined> {
		let message: Record<string, unknown> | undefined;
		try {
			const value: unknown = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) message = value as Record<string, unknown>;
		} catch {
			// Not a line this host understands: the machine's own parser refuses it, as it would without this host.
		}
		const method = typeof message?.method === "string" ? message.method : undefined;
		const id = message?.id;
		const params =
			message?.params && typeof message.params === "object" && !Array.isArray(message.params)
				? (message.params as Record<string, unknown>)
				: {};
		// Which call of the model's this belongs to: the request says so for a command and for its stdin, and a patch's
		// file changes belong to the call running then (Codex asks one thing at a time of an environment).
		const metadata =
			params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
				? (params.metadata as Record<string, unknown>)
				: undefined;
		const named = typeof metadata?.toolCallId === "string" ? metadata.toolCallId : undefined;
		if (named && named.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(named)) this.#call = named;
		if (method && REVIEWED_METHODS.has(method) && (typeof id === "string" || typeof id === "number")) {
			const action = describeCloudHomeAction(method, params, this.#machine, this.#call ?? `home:${this.#sessionId}`);
			// A request of a reviewed kind this host cannot read (an empty write, no argv) changes nothing and is
			// passed on; the machine's own parser answers it.
			if (action) {
				const refusal = await this.#admit(action);
				if (refusal !== undefined) return JSON.stringify({ id, error: { code: -32600, message: refusal } });
			}
		}
		this.counts.toMachine++;
		stream.write(line);
		return undefined;
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
