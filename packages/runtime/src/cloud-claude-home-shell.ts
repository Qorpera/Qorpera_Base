// Claude Code's shell on the agent's home (lanes/agent-box-20261113/CLAUDE-HOME-BUILD.md, slice C2; proven in P4 with
// `scripts/p4/hostrelay.py`, which this replaces).
//
// Claude Code runs every Bash command through its documented `CLAUDE_CODE_SHELL_PREFIX`: it starts the prefix with the
// whole shell invocation as `$1`. The prefix in the box (cloud-claude-home-shell-client.ts) sends that invocation, its
// working folder and a few named variables to this host over one Unix socket, one connection per command. This host
// holds ONE exec-server channel to the home per run (the same channel kind and binary Codex's own tools use) and runs
// each command there as `bash -c <invocation>`, as the home's agent account:
//
//   Claude Code (box) -> prefix -> <scratch root>/shell.sock -> this host -> exec channel -> `codex exec-server` (home)
//
// The rules it keeps:
// - **Nothing of the box travels but the command.** The prefix sends the invocation, the folder and the variables named
//   in CLOUD_CLAUDE_SHELL_FORWARDED; this host drops any other name, so Claude Code's own environment (its config
//   folder, its pid, a token should one ever be there) never reaches the home.
// - **A dropped prefix ends its command on the home.** Claude Code stops a command (timeout, TaskStop, its own exit) by
//   killing the prefix; the connection drops and this host sends `process/terminate` (the command's process group).
// - **The channel belongs to the run, not to a command.** One `initialize` per channel; a channel that closes fails the
//   commands it carried (exit 255 with words) and the next command opens a new one under the same home session.

import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CLAUDE_REVIEW_FAILED,
	CLAUDE_REVIEW_HOOK_PATH,
	cloudClaudeInvocationCommand,
	cloudClaudeShellAction,
} from "./cloud-claude-home-review.ts";
import {
	CLAUDE_PICTURE_FAILED,
	CLAUDE_PICTURE_MAX_BYTES,
	type ClaudePictureHome,
	type ClaudePictureOutcome,
	type CloudClaudePictures,
	cloudClaudePictureCall,
	runClaudePictureCommand,
} from "./cloud-claude-picture-command.ts";
import type { CloudCodexHomeMachine, CloudCodexHomeReview } from "./cloud-codex-home.ts";
import { assertNativeSocketPath } from "./cloud-native-egress.ts";

/** The socket the box's prefix reaches, in the run's own scratch root. */
export const CLOUD_CLAUDE_SHELL_SOCKET_NAME = "shell.sock";
/** The variables of Claude Code's that a command on the home may see (P4: the bridge forwarded these seven). */
export const CLOUD_CLAUDE_SHELL_FORWARDED = Object.freeze([
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SESSION_ID",
	"GIT_EDITOR",
	"TMPDIR",
	"TERM",
	"COLUMNS",
]);
/** The home's account, as every command starts there (the exec unit's own environment, deploy/coding-worker). */
export const CLOUD_CLAUDE_SHELL_ENVIRONMENT = Object.freeze({
	HOME: "/var/lib/qorpera-agent",
	USER: "qorpera-agent",
	LOGNAME: "qorpera-agent",
	SHELL: "/bin/bash",
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	LANG: "C.UTF-8",
	TZ: "UTC",
});
/** One command's request line: a shell invocation can carry a heredoc; the channel's own line bound is 8 MiB. */
const REQUEST_BYTES = 4 * 1024 * 1024;
const VALUE_CHARS = 4096;
/** Commands at once (Claude Code runs background tasks beside the foreground one). */
const MAX_CONNECTIONS = 64;
/** How long `initialize` may take on a fresh channel. */
const INITIALIZE_MS = 20_000;
const FIRST_LINE_TIMEOUT_MS = 10_000;
const PROCESS_START_TIMEOUT_MS = 30_000;
const PROCESS_TERMINATE_TIMEOUT_MS = 5_000;
const QUIET_MAX_OUTPUT_BYTES = 1024 * 1024;
const PICTURE_PLACE_MS = 30_000;
const PICTURE_WRITE_MS = 120_000;
const PICTURE_PLACE = [
	't=$(realpath -m -- "$1") || exit 6; [ -d "$(dirname -- "$t")" ] || exit 3; [ -d "$t" ] && exit 5;',
	`if [ -f "$t" ] && [ -r "$t" ] && [ "$(stat -L -c %s -- "$t")" -le ${CLAUDE_PICTURE_MAX_BYTES} ];`,
	'then h=$(sha256sum < "$t" | cut -c1-64); elif [ -e "$t" ] || [ -L "$t" ]; then h=x; else h=-; fi;',
	'printf "%s %s" "$h" "$t"',
].join(" ");

/** The words a command shows when its home is not there; Claude Code shows them to the model as the command's stderr. */
export const CLOUD_CLAUDE_SHELL_UNAVAILABLE =
	"HOME_UNAVAILABLE: this agent's machine could not be reached, so the command did not run there.";
export const CLOUD_CLAUDE_SHELL_LOST =
	"HOME_LOST: the connection to this agent's machine broke while the command was running there. Part of it may have happened.";

/** One channel to the home, as the run's host opens it (C1's contract: one route, the kind in the handshake). */
export interface CloudClaudeHomeStream {
	write(line: string): void;
	lines: AsyncIterable<string>;
	close(): Promise<void>;
}
export interface CloudClaudeHomeChannel {
	open(
		input: { readonly sessionId: string; readonly machineId: string; readonly kind?: "exec" | "sftp" },
		signal: AbortSignal,
	): Promise<CloudClaudeHomeStream>;
}

/** A command's request as the prefix sends it, or undefined for anything else. */
export function parseCloudClaudeShellRequest(
	line: string,
):
	| { cmd: string; cwd: string; env: Record<string, string>; dropped: string[]; hook?: string; real?: string }
	| undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.cmd !== "string" || typeof record.cwd !== "string") return undefined;
	if (!isAbsolute(record.cwd) || record.cwd.length > VALUE_CHARS || record.cwd.includes("\0")) return undefined;
	if (record.cmd.includes("\0")) return undefined;
	if (record.hook !== undefined && typeof record.hook !== "string") return undefined;
	if (record.real !== undefined && (typeof record.real !== "string" || !isAbsolute(record.real))) return undefined;
	const env: Record<string, string> = {};
	const dropped: string[] = [];
	const given = record.env && typeof record.env === "object" && !Array.isArray(record.env) ? record.env : {};
	for (const [name, text] of Object.entries(given as Record<string, unknown>)) {
		if (
			CLOUD_CLAUDE_SHELL_FORWARDED.includes(name) &&
			typeof text === "string" &&
			text.length <= VALUE_CHARS &&
			!text.includes("\0")
		)
			env[name] = text;
		else dropped.push(name.slice(0, 64));
	}
	return {
		cmd: record.cmd,
		cwd: record.cwd,
		env,
		dropped,
		...(typeof record.hook === "string" ? { hook: record.hook } : {}),
		...(typeof record.real === "string" ? { real: record.real } : {}),
	};
}

interface Channel {
	stream: CloudClaudeHomeStream;
	next: number;
	pending: Map<number, (message: Record<string, unknown>) => void>;
	processes: Map<string, (message: Record<string, unknown>) => void>;
	closed: boolean;
}

/** The host side of the box's shell socket for one run. */
export class CloudClaudeHomeShell {
	readonly #channel: CloudClaudeHomeChannel;
	readonly #sessionId: string;
	readonly #machineId: string;
	readonly #signal: AbortSignal;
	readonly #review?: { readonly gate: CloudCodexHomeReview; readonly machine: CloudCodexHomeMachine };
	readonly #hook?: (text: string, signal: AbortSignal, realPath?: string) => Promise<string | undefined>;
	readonly #pictures?: CloudClaudePictures;
	#reviews = 0;
	#pictureCalls = 0;
	readonly #picturesWritten = new Map<string, string>();
	readonly #sockets = new Set<Socket>();
	#server?: Server;
	#path?: string;
	#current?: Promise<Channel>;
	/** For the run's report: commands, searches among them, commands stopped by a dropped prefix, requests refused,
	 * channels opened, commands whose channel was lost. */
	readonly counts = {
		commands: 0,
		searches: 0,
		terminated: 0,
		refused: 0,
		channels: 0,
		lost: 0,
		reviewed: 0,
		declined: 0,
		hooks: 0,
		pictures: 0,
		picturesSaved: 0,
	};
	/** Why the channel would not open or ended, for this host's journal alone. */
	cause?: string;

	constructor(options: {
		channel: CloudClaudeHomeChannel;
		sessionId: string;
		machineId: string;
		signal: AbortSignal;
		review?: { readonly gate: CloudCodexHomeReview; readonly machine: CloudCodexHomeMachine };
		hook?: (text: string, signal: AbortSignal, realPath?: string) => Promise<string | undefined>;
		pictures?: CloudClaudePictures;
	}) {
		this.#channel = options.channel;
		this.#sessionId = options.sessionId;
		this.#machineId = options.machineId;
		this.#signal = options.signal;
		if (options.review) this.#review = options.review;
		if (options.hook) this.#hook = options.hook;
		if (options.pictures) this.#pictures = options.pictures;
	}

	get socketPath(): string {
		if (!this.#path) throw new Error("The home's shell socket is not open");
		return this.#path;
	}

	/** Opens the socket in `root` (the run's private scratch root; the box binds it read-only). */
	async listen(root: string): Promise<void> {
		if (!isAbsolute(root)) throw new Error("Invalid shell root");
		const path = join(root, CLOUD_CLAUDE_SHELL_SOCKET_NAME);
		assertNativeSocketPath(path, "The home's shell");
		const server = createServer((socket) => void this.#serve(socket));
		server.on("error", () => undefined);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		this.#server = server;
		this.#path = path;
	}

	/** Ends every command, the channel and the socket. */
	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#server?.close();
		const current = this.#current;
		this.#current = undefined;
		if (current) await current.then((channel) => channel.stream.close()).catch(() => undefined);
		if (this.#path) await rm(this.#path, { force: true });
	}

	async #open(): Promise<Channel> {
		const stream = await this.#channel.open(
			{ sessionId: this.#sessionId, machineId: this.#machineId, kind: "exec" },
			this.#signal,
		);
		this.counts.channels += 1;
		const channel: Channel = { stream, next: 0, pending: new Map(), processes: new Map(), closed: false };
		void (async () => {
			try {
				for await (const line of stream.lines) {
					let message: Record<string, unknown>;
					try {
						message = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}
					if (typeof message.id === "number" && channel.pending.has(message.id)) {
						const answer = channel.pending.get(message.id);
						channel.pending.delete(message.id);
						answer?.(message);
					} else if (typeof message.method === "string" && message.method.startsWith("process/")) {
						const params = (message.params ?? {}) as Record<string, unknown>;
						const id = typeof params.processId === "string" ? params.processId : undefined;
						if (id) channel.processes.get(id)?.(message);
					}
				}
			} catch (error) {
				this.cause = String((error as Error)?.message ?? error);
			}
			channel.closed = true;
			if (this.#current && (await this.#current.catch(() => undefined)) === channel) this.#current = undefined;
			for (const answer of channel.pending.values()) answer({ error: { message: "closed" } });
			channel.pending.clear();
			for (const wake of channel.processes.values()) wake({ method: "process/closed", lost: true });
		})();
		let initTimer: ReturnType<typeof setTimeout> | undefined;
		let onInitAbort: (() => void) | undefined;
		const answer = await (async () => {
			try {
				return await Promise.race([
					call(channel, "initialize", { clientName: "qorpera-claude-home-shell" }),
					new Promise<Record<string, unknown>>((resolve) => {
						onInitAbort = () => resolve({ error: { message: "stopped" } });
						if (this.#signal.aborted) {
							onInitAbort();
							return;
						}
						this.#signal.addEventListener("abort", onInitAbort, { once: true });
						initTimer = setTimeout(() => resolve({ error: { message: "no answer" } }), INITIALIZE_MS);
						initTimer.unref();
					}),
				]);
			} finally {
				clearTimeout(initTimer);
				if (onInitAbort) this.#signal.removeEventListener("abort", onInitAbort);
			}
		})();
		if ("error" in answer) {
			await stream.close();
			throw new Error(`cloud_claude_shell_initialize: ${String((answer.error as { message?: string })?.message)}`);
		}
		stream.write(JSON.stringify({ method: "initialized", params: {} }));
		return channel;
	}

	/**
	 * The run's one channel: the open one, the one being opened, or a new one. Commands that waited on an opening that
	 * failed open ONE new channel between them: after each wait it looks again, and an opening that failed clears
	 * only itself (review round 1, F2: two waiters each opened one and the first leaked).
	 */
	async #channelNow(): Promise<Channel> {
		for (;;) {
			const waited = this.#current;
			if (!waited) break;
			const existing = await waited.catch(() => undefined);
			if (existing && !existing.closed) return existing;
			if (this.#current === waited) {
				this.#current = undefined;
				break;
			}
		}
		const opening = this.#open();
		this.#current = opening;
		opening.catch((error) => {
			this.cause = String((error as Error)?.message ?? error);
			if (this.#current === opening) this.#current = undefined;
		});
		return opening;
	}

	async #reviewed(request: { cmd: string; cwd: string }, signal: AbortSignal): Promise<string | undefined> {
		if (!this.#review) return undefined;
		const action = cloudClaudeShellAction(
			this.#review.machine,
			request,
			`claude-shell:${this.#sessionId}:${++this.#reviews}`,
		);
		if (!action) return undefined;
		this.counts.reviewed += 1;
		try {
			const gate = await this.#review.gate.check(action, signal);
			if (gate.run) return undefined;
			this.counts.declined += 1;
			return gate.text;
		} catch {
			this.counts.declined += 1;
			return CLAUDE_REVIEW_FAILED;
		}
	}

	#picture(
		call: { readonly path: string; readonly prompt: string },
		request: { cmd: string; cwd: string },
		signal: AbortSignal,
	): Promise<ClaudePictureOutcome> {
		const pictures = this.#pictures as CloudClaudePictures;
		return runClaudePictureCommand({
			call,
			command: cloudClaudeInvocationCommand(request.cmd).command,
			cwd: request.cwd,
			machine: this.#review?.machine ?? { id: this.#machineId, name: this.#machineId },
			...(this.#review ? { review: this.#review.gate } : {}),
			callId: `claude-picture:${this.#sessionId}:${++this.#pictureCalls}`,
			pictures,
			home: this.#pictureHome(),
			written: this.#picturesWritten,
			signal,
		});
	}

	#pictureHome(): ClaudePictureHome {
		return {
			place: async (path, signal) => {
				let channel: Channel;
				try {
					channel = await this.#channelNow();
				} catch {
					return "unavailable";
				}
				const ran = await quiet(channel, ["/bin/sh", "-c", PICTURE_PLACE, "picture", path], signal);
				if (ran?.code === 3) return "missing";
				if (ran?.code === 5) return "folder";
				if (ran?.code === 6) return "unresolved";
				const found = ran?.code === 0 ? /^(-|x|[0-9a-f]{64}) (\/[^\0]*)$/.exec(ran.out) : null;
				return found
					? { file: found[1] === "-" ? null : (found[1] as string), real: found[2] as string }
					: "unavailable";
			},
			write: async (path, png, signal) => {
				let channel: Channel;
				try {
					channel = await this.#channelNow();
				} catch {
					return false;
				}
				const answer = await raceWithDeadline(
					call(channel, "fs/writeFile", { path: pathToFileURL(path).href, dataBase64: png.toString("base64") }),
					signal,
					PICTURE_WRITE_MS,
				);
				return answer !== undefined && !("error" in answer);
			},
		};
	}

	async #serve(socket: Socket): Promise<void> {
		if (this.#sockets.size >= MAX_CONNECTIONS || this.#signal.aborted) {
			socket.destroy();
			return;
		}
		this.#sockets.add(socket);
		socket.on("error", () => undefined);
		const send = (record: Record<string, unknown>): boolean =>
			socket.writable ? socket.write(`${JSON.stringify(record)}\n`) : true;
		const waitDrain = (signal: AbortSignal): Promise<boolean> => {
			if (socket.destroyed || socket.writableEnded || signal.aborted) return Promise.resolve(false);
			return new Promise<boolean>((resolve) => {
				const done = (ok: boolean): void => {
					socket.removeListener("drain", onDrain);
					socket.removeListener("close", onEnd);
					socket.removeListener("error", onEnd);
					signal.removeEventListener("abort", onEnd);
					resolve(ok);
				};
				const onDrain = (): void => done(true);
				const onEnd = (): void => done(false);
				socket.once("drain", onDrain);
				socket.once("close", onEnd);
				socket.once("error", onEnd);
				signal.addEventListener("abort", onEnd, { once: true });
			});
		};
		const fail = (words: string, code: number): void => {
			send({ e: Buffer.from(`${words}\n`).toString("base64") });
			send({ x: code });
			socket.end();
		};
		let processId: string | undefined;
		let channel: Channel | undefined;
		const askedController = new AbortController();
		const onRunAbort = (): void => askedController.abort(this.#signal.reason);
		const onSocketClose = (): void => askedController.abort();
		let onDrop: (() => void) | undefined;
		try {
			const line = await firstLine(socket, this.#signal);
			if (line === undefined && (socket.destroyed || this.#signal.aborted)) {
				if (!socket.destroyed) socket.destroy();
				return;
			}
			const request = line === undefined ? undefined : parseCloudClaudeShellRequest(line);
			if (!request) {
				this.counts.refused += 1;
				fail("HOME_REQUEST_INVALID: the command could not be read, so it did not run.", 126);
				return;
			}
			if (this.#signal.aborted || socket.destroyed) {
				if (!socket.destroyed) socket.destroy();
				return;
			}
			this.#signal.addEventListener("abort", onRunAbort, { once: true });
			socket.once("close", onSocketClose);
			socket.resume();
			const asked = askedController.signal;
			if (request.cmd === CLAUDE_REVIEW_HOOK_PATH || request.cmd === "--hook") {
				this.counts.hooks += 1;
				const refusal =
					this.#hook && request.hook !== undefined
						? await this.#hook(request.hook, asked, request.real).catch(() => CLAUDE_REVIEW_FAILED)
						: undefined;
				if (asked.aborted) return;
				if (refusal === undefined) {
					send({ x: 0 });
					socket.end();
				} else fail(refusal, 2);
				return;
			}
			const picture = this.#pictures
				? cloudClaudePictureCall(cloudClaudeInvocationCommand(request.cmd).command, request.cwd)
				: undefined;
			if (picture) {
				this.counts.pictures += 1;
				const outcome: ClaudePictureOutcome | undefined =
					"usage" in picture
						? { err: picture.usage, code: 2 }
						: await this.#picture(picture, request, asked).catch(() =>
								asked.aborted ? undefined : { err: CLAUDE_PICTURE_FAILED, code: 1 },
							);
				if (asked.aborted || !outcome) return;
				if (outcome.saved !== undefined) this.counts.picturesSaved += 1;
				if (outcome.out) send({ o: Buffer.from(outcome.out).toString("base64") });
				if (outcome.err) send({ e: Buffer.from(`${outcome.err}\n`).toString("base64") });
				send({ x: outcome.code });
				socket.end();
				return;
			}
			const refusal = await this.#reviewed(request, asked);
			if (asked.aborted) return;
			if (refusal !== undefined) {
				fail(refusal, 126);
				return;
			}
			try {
				channel = await this.#channelNow();
			} catch (error) {
				// A refusal's reason is the ingress's own code (CloudHomeChannelRefused), never an address or an id.
				const reason = (error as { reason?: unknown })?.reason;
				fail(
					typeof reason === "string" && /^[A-Z][A-Z_]{0,63}$/.test(reason)
						? `${CLOUD_CLAUDE_SHELL_UNAVAILABLE} (${reason})`
						: CLOUD_CLAUDE_SHELL_UNAVAILABLE,
					255,
				);
				return;
			}
			this.counts.commands += 1;
			// Grep and Glob through the box's `rg` bridge (cloud-claude-home-shell-client.ts).
			if (request.cmd.startsWith("exec rg ")) this.counts.searches += 1;
			processId = `claude-${this.counts.commands}-${randomBytes(4).toString("hex")}`;
			let events: Record<string, unknown>[] = [];
			let eventHead = 0;
			let wake: (() => void) | undefined;
			channel.processes.set(processId, (message) => {
				events.push(message);
				wake?.();
			});
			const started = await call(
				channel,
				"process/start",
				{
					processId,
					argv: ["/bin/bash", "-c", request.cmd],
					cwd: `file://${encodeURI(request.cwd)}`,
					env: { ...CLOUD_CLAUDE_SHELL_ENVIRONMENT, ...request.env },
					tty: false,
					pipeStdin: false,
					arg0: null,
				},
				{ signal: asked, timeoutMs: PROCESS_START_TIMEOUT_MS },
			);
			if ("error" in started) {
				if (asked.aborted || (started.error as { message?: unknown })?.message === "timeout") {
					if (!channel.closed) {
						this.counts.terminated += 1;
						await call(channel, "process/terminate", { processId }, { timeoutMs: PROCESS_TERMINATE_TIMEOUT_MS });
					}
					if (asked.aborted) return;
				}
				fail(
					channel.closed ? CLOUD_CLAUDE_SHELL_UNAVAILABLE : "HOME_START_FAILED: the command could not start.",
					channel.closed ? 255 : 126,
				);
				return;
			}
			let dropped: boolean = socket.destroyed || asked.aborted;
			onDrop = () => {
				dropped = true;
				wake?.();
			};
			asked.addEventListener("abort", onDrop, { once: true });
			let exitCode: number | undefined;
			for (;;) {
				const message = eventHead < events.length ? events[eventHead++] : undefined;
				if (eventHead === events.length) {
					events.length = 0;
					eventHead = 0;
				} else if (eventHead >= 64 && eventHead * 2 >= events.length) {
					events = events.slice(eventHead);
					eventHead = 0;
				}
				if (!message) {
					if (dropped) {
						if (!channel.closed) {
							this.counts.terminated += 1;
							await call(
								channel,
								"process/terminate",
								{ processId },
								{ timeoutMs: PROCESS_TERMINATE_TIMEOUT_MS },
							);
						}
						return;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = undefined;
					continue;
				}
				const params = (message.params ?? {}) as Record<string, unknown>;
				if (message.method === "process/output") {
					const ok = send({
						[params.stream === "stderr" ? "e" : "o"]: typeof params.chunk === "string" ? params.chunk : "",
					});
					if (!ok && !(await waitDrain(asked))) dropped = true;
				} else if (message.method === "process/exited") {
					if (typeof params.exitCode === "number") exitCode = params.exitCode;
				} else if (message.method === "process/closed") {
					if (message.lost) {
						this.counts.lost += 1;
						fail(CLOUD_CLAUDE_SHELL_LOST, 255);
						return;
					}
					send({ x: exitCode ?? 255 });
					socket.end();
					return;
				}
			}
		} catch {
			socket.destroy();
		} finally {
			this.#signal.removeEventListener("abort", onRunAbort);
			socket.removeListener("close", onSocketClose);
			if (onDrop) askedController.signal.removeEventListener("abort", onDrop);
			if (processId) channel?.processes.delete(processId);
			this.#sockets.delete(socket);
		}
	}
}

function call(
	channel: Channel,
	method: string,
	params: Record<string, unknown>,
	options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, unknown>> {
	if (channel.closed) return Promise.resolve({ error: { message: "closed" } });
	if (options?.signal?.aborted) return Promise.resolve({ error: { message: "aborted" } });
	channel.next += 1;
	const id = channel.next;
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: Record<string, unknown>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
			channel.pending.delete(id);
			resolve(value);
		};
		const onAbort = (): void => finish({ error: { message: "aborted" } });
		if (options?.signal) options.signal.addEventListener("abort", onAbort, { once: true });
		if (options?.timeoutMs !== undefined) {
			timer = setTimeout(() => finish({ error: { message: "timeout" } }), options.timeoutMs);
			timer.unref();
		}
		channel.pending.set(id, finish);
		channel.stream.write(JSON.stringify({ id, method, params }));
	});
}

async function raceWithDeadline<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T | undefined> {
	if (signal.aborted) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref();
	});
	try {
		return await Promise.race([work, stop]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function quiet(
	channel: Channel,
	argv: readonly string[],
	signal: AbortSignal,
): Promise<{ code: number | undefined; out: string } | undefined> {
	const processId = `claude-picture-${randomBytes(6).toString("hex")}`;
	let exitCode: number | undefined;
	const out: Buffer[] = [];
	let outBytes = 0;
	let overflow = false;
	let lost = false;
	let closed: () => void = () => undefined;
	const done = new Promise<void>((resolve) => {
		closed = resolve;
	});
	channel.processes.set(processId, (message) => {
		const params = (message.params ?? {}) as Record<string, unknown>;
		if (message.method === "process/output" && params.stream !== "stderr" && typeof params.chunk === "string") {
			if (overflow) return;
			const decoded = Buffer.from(params.chunk, "base64");
			outBytes += decoded.length;
			if (outBytes > QUIET_MAX_OUTPUT_BYTES) {
				overflow = true;
				out.length = 0;
				closed();
				return;
			}
			out.push(decoded);
		} else if (message.method === "process/exited" && typeof params.exitCode === "number") exitCode = params.exitCode;
		else if (message.method === "process/closed") {
			lost = message.lost === true;
			closed();
		}
	});
	const deadlineAt = performance.now() + PICTURE_PLACE_MS;
	const remainingMs = () => Math.max(0, Math.ceil(deadlineAt - performance.now()));
	try {
		const started = await call(
			channel,
			"process/start",
			{
				processId,
				argv,
				cwd: "file:///",
				env: { ...CLOUD_CLAUDE_SHELL_ENVIRONMENT },
				tty: false,
				pipeStdin: false,
				arg0: null,
			},
			{ signal, timeoutMs: remainingMs() },
		);
		if ("error" in started) {
			if ((started.error as { message?: unknown })?.message === "timeout" || signal.aborted) {
				if (!channel.closed)
					void call(channel, "process/terminate", { processId }, { timeoutMs: PROCESS_TERMINATE_TIMEOUT_MS });
			}
			return undefined;
		}
		const finished = await raceWithDeadline(
			done.then(() => true),
			signal,
			remainingMs(),
		);
		if (finished !== true || overflow) {
			if (!channel.closed)
				void call(channel, "process/terminate", { processId }, { timeoutMs: PROCESS_TERMINATE_TIMEOUT_MS });
			return undefined;
		}
		return lost ? undefined : { code: exitCode, out: Buffer.concat(out).toString("utf8") };
	} finally {
		channel.processes.delete(processId);
	}
}

/** The request line, read without taking more of the socket than that line; undefined past REQUEST_BYTES. */
function firstLine(socket: Socket, signal: AbortSignal): Promise<string | undefined> {
	if (socket.destroyed || signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeListener("data", data);
			socket.removeListener("end", end);
			socket.removeListener("close", end);
			socket.removeListener("error", end);
			signal.removeEventListener("abort", end);
			socket.pause();
			resolve(value);
		};
		const data = (chunk: Buffer): void => {
			const endOfLine = chunk.indexOf(10);
			if (endOfLine >= 0) {
				if (bytes + endOfLine > REQUEST_BYTES) {
					done(undefined);
					return;
				}
				chunks.push(chunk.subarray(0, endOfLine));
				done(Buffer.concat(chunks, bytes + endOfLine).toString("utf8"));
				return;
			}
			bytes += chunk.length;
			if (bytes > REQUEST_BYTES) {
				done(undefined);
				return;
			}
			chunks.push(chunk);
		};
		const end = (): void => done(undefined);
		timer = setTimeout(end, FIRST_LINE_TIMEOUT_MS);
		timer.unref();
		socket.on("data", data);
		socket.once("end", end);
		socket.once("close", end);
		socket.once("error", end);
		signal.addEventListener("abort", end, { once: true });
	});
}
