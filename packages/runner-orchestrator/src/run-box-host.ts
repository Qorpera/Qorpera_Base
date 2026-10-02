import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { resolve } from "node:path";
import {
	parseRunBoxRequest,
	RUN_BOX_LINE_LIMIT,
	RUN_BOX_MAX_OUTPUT_BYTES,
	RUN_BOX_MAX_SESSION,
	RUN_BOX_PROTOCOL,
	type RunBoxOutput,
	type RunBoxReply,
	type RunBoxRequest,
} from "@qorpera/contracts";

/**
 * The run box host (F3 step 2; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"). It runs inside the run's box
 * as the slot's box account and starts the run's commands there, for the slot's native host, which reaches it over
 * the box's socket unit (the protocol is `@qorpera/contracts` run-box). It holds nothing secret and decides nothing:
 * the box's unit is the boundary, and the native host trusts none of its answers.
 *
 * A command runs under bash. Its output (stdout and stderr in the order they arrive) is kept for the next answer, all
 * of it or its head and tail, and written whole to `<home>/output/<session>.log` in the box's memory. The command keeps
 * running after an answer; a later `write` feeds its terminal or reads on. It ends with the run: no time limit, no
 * output limit beyond the box's own memory.
 */

/** Of output nobody has read yet, this much of the start and of the end is kept: enough for any answer. */
const KEEP_BYTES = RUN_BOX_MAX_OUTPUT_BYTES;
/** After the command exits, output its children still hold open is awaited this long, then left. */
const EXIT_DRAIN_MS = 100;
/** Of an answer that cannot show everything, the head gets a quarter and the tail the rest. */
const HEAD_SHARE = 0.25;

export interface RunBoxHostOptions {
	/** The box account's home: each command's whole output goes to `<home>/output`. */
	home: string;
	/** The company folder, where commands start unless they name another directory. */
	company: string;
	/** The environment every command starts with (nothing else of the host's is passed on). */
	environment: Readonly<Record<string, string>>;
	shell?: string;
	/** util-linux `script`, which gives a command a terminal. */
	script?: string;
	now?: () => number;
}

/** Output not yet given out: the first KEEP_BYTES, the last KEEP_BYTES, and how much there was. */
class Unread {
	#head: Buffer[] = [];
	#headBytes = 0;
	#tail: Buffer[] = [];
	#tailBytes = 0;
	#total = 0;
	#dropped = false;

	push(chunk: Buffer): void {
		this.#total += chunk.byteLength;
		if (this.#headBytes < KEEP_BYTES) {
			const take = Math.min(KEEP_BYTES - this.#headBytes, chunk.byteLength);
			this.#head.push(chunk.subarray(0, take));
			this.#headBytes += take;
			chunk = chunk.subarray(take);
			if (chunk.byteLength === 0) return;
		}
		this.#tail.push(chunk);
		this.#tailBytes += chunk.byteLength;
		while (this.#tailBytes - (this.#tail[0]?.byteLength ?? 0) >= KEEP_BYTES) {
			this.#tailBytes -= (this.#tail.shift() as Buffer).byteLength;
			this.#dropped = true;
		}
		if (this.#tailBytes > KEEP_BYTES) {
			const first = this.#tail[0] as Buffer;
			const cut = this.#tailBytes - KEEP_BYTES;
			this.#tail[0] = first.subarray(cut);
			this.#tailBytes = KEEP_BYTES;
			this.#dropped = true;
		}
	}

	/** Everything unread as one answer of at most `budget` bytes of text, and start over. */
	take(budget: number): RunBoxOutput {
		const total = this.#total;
		const head = Buffer.concat(this.#head);
		const tail = Buffer.concat(this.#tail);
		const dropped = this.#dropped;
		this.#head = [];
		this.#tail = [];
		this.#headBytes = 0;
		this.#tailBytes = 0;
		this.#total = 0;
		this.#dropped = false;
		if (total <= budget && !dropped) {
			const all = Buffer.concat([head, tail]);
			const text = fitStart(decode(all), budget);
			return { head: text, tail: "", skippedBytes: Math.max(0, total - Buffer.byteLength(text)), totalBytes: total };
		}
		const headBudget = Math.floor(budget * HEAD_SHARE);
		const tailBudget = budget - headBudget;
		// When nothing was dropped the kept bytes are the whole output, so the tail may reach back into the head.
		const end = dropped ? tail : Buffer.concat([head, tail]);
		const headRaw = completeStart(head.subarray(0, Math.min(headBudget, head.byteLength)));
		const tailRaw = completeEnd(end.subarray(Math.max(0, end.byteLength - tailBudget)));
		const headText = fitStart(decode(headRaw), headBudget);
		const tailText = fitEnd(decode(tailRaw), tailBudget);
		return {
			head: headText,
			tail: tailText,
			skippedBytes: Math.max(0, total - headRaw.byteLength - tailRaw.byteLength),
			totalBytes: total,
		};
	}
}

function decode(bytes: Buffer): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replaceAll("\0", "�");
}

/** Drop a character cut in two at the end. */
function completeStart(bytes: Buffer): Buffer {
	let end = bytes.byteLength;
	for (let back = 1; back <= 3 && end - back >= 0; back++) {
		const byte = bytes[end - back] as number;
		if ((byte & 0xc0) === 0x80) continue;
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (length > back) end -= back;
		break;
	}
	return bytes.subarray(0, end);
}

/** Drop a character cut in two at the start. */
function completeEnd(bytes: Buffer): Buffer {
	let start = 0;
	while (start < 3 && start < bytes.byteLength && ((bytes[start] as number) & 0xc0) === 0x80) start++;
	return bytes.subarray(start);
}

/** Replacement characters take three bytes where the raw byte took one: trim again to the budget. */
function fitStart(text: string, budget: number): string {
	while (Buffer.byteLength(text) > budget) text = Array.from(text).slice(0, -1).join("");
	return text;
}

function fitEnd(text: string, budget: number): string {
	while (Buffer.byteLength(text) > budget) text = Array.from(text).slice(1).join("");
	return text;
}

class Session {
	readonly unread = new Unread();
	ended: { exitCode: number | null; signal: string | null } | undefined;
	logComplete = true;
	/** Ended, and the whole output is in the log. */
	#settled = false;
	readonly id: number;
	readonly child: ChildProcess;
	readonly logPath: string;
	readonly log: WriteStream;
	readonly #waiters = new Set<() => void>();

	constructor(id: number, child: ChildProcess, logPath: string, log: WriteStream) {
		this.id = id;
		this.child = child;
		this.logPath = logPath;
		this.log = log;
	}

	output(chunk: Buffer): void {
		this.unread.push(chunk);
		if (this.logComplete) this.log.write(chunk);
	}

	end(exitCode: number | null, signal: string | null): void {
		if (this.ended) return;
		// A command killed by a signal still has a code if bash reported it as one (128 + n).
		this.ended = { exitCode: exitCode ?? (signal === null ? 0 : null), signal: exitCode === null ? signal : null };
		this.child.stdout?.destroy();
		this.child.stderr?.destroy();
		this.child.stdin?.destroy();
		// The end is answered once the whole output is in the log, so a next command can read all of it.
		this.log.end(() => {
			this.#settled = true;
			for (const wake of this.#waiters) wake();
		});
	}

	/** Until the command ends (and its log is written) or `ms` pass. */
	wait(ms: number): Promise<void> {
		if (this.#settled || ms === 0) return Promise.resolve();
		return new Promise((done) => {
			const finish = (): void => {
				clearTimeout(timer);
				this.#waiters.delete(finish);
				done();
			};
			const timer = setTimeout(finish, ms);
			this.#waiters.add(finish);
		});
	}
}

export class RunBoxHost {
	readonly #options: Required<RunBoxHostOptions>;
	readonly #sessions = new Map<number, Session>();
	#next = 0;

	constructor(options: RunBoxHostOptions) {
		this.#options = { shell: "/bin/bash", script: "/usr/bin/script", now: Date.now, ...options };
	}

	get sessions(): number[] {
		return [...this.#sessions.keys()];
	}

	/** Serve every connection on `server` (the socket unit's, in the box). */
	serve(server: Server): void {
		server.on("connection", (socket) => this.#connection(socket));
	}

	async handle(request: RunBoxRequest): Promise<RunBoxReply> {
		const started = this.#options.now();
		if (request.t === "exec") {
			const directory = resolve(this.#options.company, request.workdir ?? ".");
			const directoryStat = await stat(directory).catch(() => undefined);
			if (!directoryStat?.isDirectory())
				return { t: "error", id: request.id, code: "WORKDIR_UNAVAILABLE", message: `No directory ${directory}` };
			const session = await this.#start(request.cmd, directory, request.tty);
			if (!session)
				return { t: "error", id: request.id, code: "SPAWN_FAILED", message: "The command could not be started" };
			await session.wait(request.yieldMs);
			return this.#result(request.id, session, request.maxOutputBytes, started);
		}
		const session = this.#sessions.get(request.session);
		if (!session)
			return {
				t: "error",
				id: request.id,
				code: "SESSION_UNKNOWN",
				message: `No command is running as session ${request.session}`,
			};
		if (request.chars.length > 0) {
			const input = session.child.stdin;
			if (!input || session.ended || input.destroyed)
				return {
					t: "error",
					id: request.id,
					code: "STDIN_CLOSED",
					message: "This command's input is closed; start it with a terminal (tty) to write to it",
				};
			input.write(request.chars);
		}
		await session.wait(request.yieldMs);
		return this.#result(request.id, session, request.maxOutputBytes, started);
	}

	/** Tests and shutdown: every command and what it started. */
	close(): void {
		for (const session of this.#sessions.values()) {
			if (session.ended || session.child.pid === undefined) continue;
			try {
				process.kill(-session.child.pid, "SIGKILL");
			} catch {}
		}
	}

	async #start(cmd: string, directory: string, tty: boolean): Promise<Session | undefined> {
		if (this.#next >= RUN_BOX_MAX_SESSION) return undefined;
		const id = ++this.#next;
		const outputDirectory = resolve(this.#options.home, "output");
		await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
		const logPath = resolve(outputDirectory, `${id}.log`);
		// The socket unit's listening descriptor (3) is closed before the command runs: nothing in the box answers in
		// the box host's place on its own socket.
		const program = tty ? 'exec 3>&-; exec "$0" -qefc "$1" /dev/null' : 'exec 3>&-; exec "$0" -c "$1"';
		const child = spawn(this.#options.shell, ["-c", program, tty ? this.#options.script : this.#options.shell, cmd], {
			cwd: directory,
			env: { ...this.#options.environment, TERM: tty ? "xterm-256color" : "dumb" },
			stdio: [tty ? "pipe" : "ignore", "pipe", "pipe"],
			detached: true,
		});
		const started = await new Promise<boolean>((done) => {
			child.once("spawn", () => done(true));
			child.once("error", () => done(false));
		});
		if (!started) return undefined;
		const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
		const session = new Session(id, child, logPath, log);
		log.on("error", () => {
			session.logComplete = false;
		});
		child.stdin?.on("error", () => undefined);
		child.stdout?.on("data", (chunk: Buffer) => session.output(chunk));
		child.stderr?.on("data", (chunk: Buffer) => session.output(chunk));
		child.once("exit", (code, signal) => {
			let drained = false;
			const finish = (): void => {
				if (drained) return;
				drained = true;
				session.end(code, signal);
			};
			child.once("close", finish);
			setTimeout(finish, EXIT_DRAIN_MS);
		});
		this.#sessions.set(id, session);
		return session;
	}

	#result(id: string, session: Session, budget: number, started: number): RunBoxReply {
		const output = session.unread.take(budget);
		const ended = session.ended;
		if (ended) this.#sessions.delete(session.id);
		return {
			t: "result",
			id,
			session: ended ? null : session.id,
			exitCode: ended ? ended.exitCode : null,
			signal: ended ? ended.signal : null,
			output,
			logPath: output.skippedBytes > 0 && session.logComplete ? session.logPath : null,
			wallMs: Math.max(0, this.#options.now() - started),
		};
	}

	#connection(socket: Socket): void {
		const send = (reply: RunBoxReply): void => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
		};
		socket.on("error", () => undefined);
		send({ t: "ready", protocol: RUN_BOX_PROTOCOL, sessions: this.sessions });
		let buffer = "";
		let queue = Promise.resolve();
		socket.setEncoding("utf8");
		socket.on("data", (text: string) => {
			buffer += text;
			if (buffer.length > RUN_BOX_LINE_LIMIT && !buffer.includes("\n")) {
				socket.destroy();
				return;
			}
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				let request: RunBoxRequest;
				try {
					request = parseRunBoxRequest(line);
				} catch {
					// Only the slot's native host can connect, and it sends well-formed lines.
					socket.destroy();
					return;
				}
				// One request at a time per connection, answered in order.
				queue = queue.then(async () => {
					try {
						send(await this.handle(request));
					} catch {
						send({ t: "error", id: request.id, code: "SPAWN_FAILED", message: "The box could not run that" });
					}
				});
			}
		});
	}
}
