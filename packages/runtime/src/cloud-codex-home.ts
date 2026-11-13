// The agent's home (lanes/agent-box-20261113/HOME-PLAN.md, slices 1, 2 and 4; proven in P1-CODEX-OWN-TOOLS.md).
//
// A run's Codex stays in its sealed slot, with the member's sign-in, no network and the result fence. Its OWN shell,
// stdin and apply_patch run on the run's home machine: Codex's `exec-server`, which it reaches as an "environment"
// through one Unix socket in the run's scratch root. This module is the host side of that socket:
//
//   Codex (in the slot) --(`codex stdio-to-uds`)--> <scratch root>/exec.sock --> this host
//     --> the coding executor's channel --> `codex exec-server --listen stdio` on the machine, as the agent's user
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
import type { CloudRunLog } from "./cloud-run-log.ts";

/** The environment id the host registers for the home. Codex names it on every tool call it makes there. */
export const CLOUD_HOME_ENVIRONMENT_ID = "home";
/** Where the home's folder is mounted inside the machine, and the environment's working directory. */
export const CLOUD_HOME_CWD = CLOUD_MACHINE_HOME.cwd;
/** The socket the namespace reaches, beside the result fence's, in the run's own scratch root. */
export const CLOUD_HOME_SOCKET_NAME = "exec.sock";
/** One JSON-RPC line either way. Codex streams a command's output in chunks well under this. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Connections the namespace may hold at once: Codex opens one environment, and one more while it reconnects. */
const MAX_CONNECTIONS = 4;
/** What the model is told when its home could not be reached. Plain words, and what to do instead. */
export const CLOUD_HOME_UNAVAILABLE =
	"HOME_UNAVAILABLE: this agent's machine could not be reached, so nothing ran there. Use the company's own tools, or try again.";

/** The exec-server methods that change something on the machine, so each one is reviewed before it is forwarded. */
const REVIEWED_METHODS: ReadonlyMap<string, "command" | "change"> = new Map([
	["process/start", "command"],
	["fs/writeFile", "change"],
	["fs/createDirectory", "change"],
	["fs/remove", "change"],
	["fs/copy", "change"],
]);

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

/** The review of one native action, as the run's own review gate answers it (cloud-action-review.ts). */
export interface CloudCodexHomeReview {
	check(
		call: {
			readonly kind: "command" | "change";
			readonly summary: string;
			readonly argumentSha256: string;
			readonly callId: string;
		},
		signal: AbortSignal,
	): Promise<CloudActionGateResult>;
}

/** One native step of the run's work log, from Codex's own item notifications (slice 2). */
interface NativeStep {
	readonly j: number;
	readonly paths: readonly string[];
}

/**
 * The run's native steps: what the model did on its home, as the run's work log holds it.
 *
 * Codex tells the host what each of its own calls was (`item/completed` for a `commandExecution` with its command, its
 * working directory and its exit code, for a `fileChange` with the paths it changed). The host writes that as a step
 * the moment it hears it, and finishes the step with the exact envelope the model is shown when the result fence
 * releases it. Without this a run that works on its home keeps no work log at all, and in Shared context the fold
 * leaves its own work out with no line (memory-tree/run-work.ts).
 */
export class CloudCodexHomeSteps {
	readonly #log: CloudRunLog;
	readonly #open = new Map<string, NativeStep>();
	/** Counted for the proof and the report: steps opened, steps finished. */
	opened = 0;
	finished = 0;

	constructor(log: CloudRunLog) {
		this.#log = log;
	}

	/** Codex's own notification. Returns the step's index when one was opened. */
	note(method: string, params: Record<string, unknown>): number | undefined {
		if (method !== "item/completed") return undefined;
		const item = params.item;
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const value = item as Record<string, unknown>;
		const call = typeof value.id === "string" ? value.id : undefined;
		if (!call || call.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(call) || this.#open.has(call))
			return undefined;
		const described = describeItem(value);
		if (!described) return undefined;
		const argumentsText = JSON.stringify(described.arguments);
		const j = this.#log.step({
			call,
			tool: described.tool,
			argumentsText,
			argumentSha256: createHash("sha256").update(argumentsText).digest("hex"),
		});
		this.#open.set(call, { j, paths: described.paths });
		this.opened++;
		return j;
	}

	/** The result fence releasing this call's output: the step keeps the exact envelope the model got. */
	finish(callId: string, envelope: string): void {
		const step = this.#open.get(callId);
		if (!step) return;
		this.#open.delete(callId);
		this.finished++;
		this.#log.finish(step.j, envelope, [], [...step.paths]);
	}
}

/** What a step says about one of Codex's own calls: its tool, its canonical arguments and the paths it touched. */
function describeItem(
	item: Record<string, unknown>,
): { tool: string; arguments: JsonValue; paths: string[] } | undefined {
	const text = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	if (item.type === "commandExecution") {
		const command = text(item.command);
		if (!command) return undefined;
		return {
			tool: "exec_command",
			arguments: {
				machine: "home",
				command,
				...(text(item.cwd) ? { cwd: text(item.cwd) as string } : {}),
				...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
			},
			paths: [],
		};
	}
	if (item.type === "fileChange") {
		const changes = Array.isArray(item.changes) ? item.changes : [];
		// The paths are what the run's log harvests from a step (its needles), so they are named as `paths`.
		const paths = changes
			.map((change) =>
				change && typeof change === "object" && !Array.isArray(change)
					? text((change as Record<string, unknown>).path)
					: undefined,
			)
			.filter((path): path is string => path !== undefined);
		if (paths.length === 0) return undefined;
		const kinds = changes.map((change) => {
			const kind =
				change && typeof change === "object" && !Array.isArray(change)
					? (change as Record<string, unknown>).kind
					: undefined;
			const named =
				kind && typeof kind === "object" && !Array.isArray(kind) ? (kind as Record<string, unknown>).type : kind;
			return typeof named === "string" ? named : "change";
		});
		return { tool: "apply_patch", arguments: { machine: "home", paths, kinds }, paths };
	}
	return undefined;
}

/** What a reviewed line is about, in the words the review and its card show: "write p4/plan.md", "ls /company". */
function summarize(kind: "command" | "change", params: Record<string, unknown>): string {
	if (kind === "command") {
		const argv = Array.isArray(params.argv)
			? params.argv.filter((part): part is string => typeof part === "string")
			: [];
		return argv.join(" ").slice(0, 2000) || "a command";
	}
	const path =
		typeof params.path === "string" ? params.path : typeof params.sourcePath === "string" ? params.sourcePath : "";
	return path.replace(/^file:\/\//, "").slice(0, 2000) || "a file";
}

/**
 * The host side of one run's home: the socket its Codex reaches, the channel to the machine, the review of every
 * action and the run's native steps. One home belongs to one run.
 */
export class CloudCodexHome {
	readonly #channel: CloudCodexHomeChannel;
	readonly #sessionId: string;
	readonly #machineId: string;
	readonly #review?: CloudCodexHomeReview;
	readonly #steps?: CloudCodexHomeSteps;
	readonly #signal: AbortSignal;
	readonly #sockets = new Set<Socket>();
	#server?: Server;
	#path?: string;
	/** Counted from the run, for the report: lines each way, actions reviewed, actions the review stopped. */
	readonly counts = { toMachine: 0, fromMachine: 0, reviewed: 0, declined: 0, connections: 0 };
	/** Why a channel would not open, for this host's journal alone. */
	cause?: string;
	#failure?: string;

	/** The Codex the namespace runs `stdio-to-uds` with; the session's own artifact unless a proof's harness, whose
	 * command is its wrapper, names the binary the namespace actually has. */
	readonly program?: string;

	constructor(options: {
		channel: CloudCodexHomeChannel;
		sessionId: string;
		machineId: string;
		program?: string;
		review?: CloudCodexHomeReview;
		steps?: CloudCodexHomeSteps;
		signal: AbortSignal;
	}) {
		this.#channel = options.channel;
		this.#sessionId = options.sessionId;
		this.#machineId = options.machineId;
		this.#review = options.review;
		this.#steps = options.steps;
		this.#signal = options.signal;
		this.program = options.program;
	}

	get steps(): CloudCodexHomeSteps | undefined {
		return this.#steps;
	}

	/** One of Codex's own item notifications, as the session's reader hands it over (slice 2). */
	noteItem(method: string, params: Record<string, unknown>): void {
		this.#steps?.note(method, params);
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

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		const server = this.#server;
		this.#server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (this.#path) await rm(this.#path, { force: true }).catch(() => undefined);
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
			stream = await this.#channel.open({ sessionId: this.#sessionId, machineId: this.#machineId }, this.#signal);
		} catch (error) {
			// The model asked for its home and there is none: say so in words, on the next line it reads, and let its
			// turn go on with the company's own tools. The cause is the host's own (a refusal of the ingress, a channel
			// that would not open); it is kept for this host's journal, never shown to the model or the provider.
			this.#failure ??= CLOUD_HOME_UNAVAILABLE;
			this.cause ??= String((error as Error)?.message ?? error).slice(0, 200);
			client.destroy();
			return;
		}
		const stop = () => {
			client.destroy();
			void stream.close();
		};
		this.#signal.addEventListener("abort", stop, { once: true });
		const fromMachine = (async () => {
			for await (const line of stream.lines) {
				this.counts.fromMachine++;
				if (!client.writable) break;
				client.write(`${line}\n`);
			}
		})();
		try {
			for await (const line of lines(client)) {
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
	 * JSON-RPC error carrying the review's own words, which Codex gives the model as its tool's failure.
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
		const kind = method ? REVIEWED_METHODS.get(method) : undefined;
		const id = message?.id;
		if (kind && this.#review && (typeof id === "string" || typeof id === "number")) {
			const params =
				message?.params && typeof message.params === "object" && !Array.isArray(message.params)
					? (message.params as Record<string, unknown>)
					: {};
			const summary = summarize(kind, params);
			this.counts.reviewed++;
			const gate = await this.#review.check(
				{
					kind,
					summary,
					// The review's own identity of an action: this exact action, under the run's agent (its SQL takes the
					// tool and this digest alone). The same action twice reuses its answer, as a tool call's does.
					argumentSha256: createHash("sha256").update(`${kind}\u0000${summary}`).digest("hex"),
					callId: `${method}:${String(id)}`,
				},
				this.#signal,
			);
			if (!gate.run) {
				this.counts.declined++;
				return JSON.stringify({ id, error: { code: -32600, message: gate.text } });
			}
		}
		this.counts.toMachine++;
		stream.write(line);
		return undefined;
	}
}

/** Each complete line of a socket, in order; a line over the bound ends the connection. */
async function* lines(socket: Socket): AsyncGenerator<string> {
	let rest = "";
	for await (const chunk of socket) {
		rest += (chunk as Buffer).toString("utf8");
		if (Buffer.byteLength(rest) > MAX_LINE_BYTES) throw new Error("Home line too large");
		let end = rest.indexOf("\n");
		while (end >= 0) {
			yield rest.slice(0, end);
			rest = rest.slice(end + 1);
			end = rest.indexOf("\n");
		}
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
