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
		if (chunk.byteLength === 0) return;
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

	/**
	 * Everything unread as one answer of at most `budget` bytes, and start over. Shown text has exactly the bytes of
	 * the output it shows (`shown`), so the counts are exact. While the command runs, a character its last write left
	 * unfinished waits for the next answer instead of showing as two broken halves.
	 */
	take(budget: number, final: boolean): RunBoxOutput {
		const head = Buffer.concat(this.#head);
		const tail = Buffer.concat(this.#tail);
		const dropped = this.#dropped;
		const end = tail.byteLength > 0 ? tail : head;
		const carry = final ? 0 : unfinished(end);
		const total = this.#total - carry;
		const kept = end.subarray(end.byteLength - carry);
		this.#head = [];
		this.#tail = [];
		this.#headBytes = 0;
		this.#tailBytes = 0;
		this.#total = 0;
		this.#dropped = false;
		if (carry > 0) this.push(Buffer.from(kept));
		const lastHead = tail.byteLength > 0 ? head : head.subarray(0, head.byteLength - carry);
		const lastTail = tail.subarray(0, tail.byteLength - (tail.byteLength > 0 ? carry : 0));
		if (total <= budget && !dropped)
			return { head: shown(Buffer.concat([lastHead, lastTail])), tail: "", skippedBytes: 0, totalBytes: total };
		const headBudget = Math.floor(budget * HEAD_SHARE);
		// When nothing was dropped the kept bytes are the whole output, so the tail may reach back into the head.
		const whole = dropped ? lastTail : Buffer.concat([lastHead, lastTail]);
		const headRaw = completeStart(lastHead.subarray(0, Math.min(headBudget, lastHead.byteLength)));
		const tailRaw = completeEnd(whole.subarray(Math.max(0, whole.byteLength - (budget - headBudget))));
		return {
			head: shown(headRaw),
			tail: shown(tailRaw),
			skippedBytes: total - headRaw.byteLength - tailRaw.byteLength,
			totalBytes: total,
		};
	}
}

/** The length of a UTF-8 sequence that starts with `byte`, or 0 for a byte no sequence starts with. */
function sequenceLength(byte: number): number {
	return byte < 0x80
		? 1
		: byte >= 0xc2 && byte <= 0xdf
			? 2
			: byte >= 0xe0 && byte <= 0xef
				? 3
				: byte >= 0xf0 && byte <= 0xf4
					? 4
					: 0;
}

/** How many bytes at the end of `bytes` start a character that has not been written whole yet. */
function unfinished(bytes: Buffer): number {
	for (let back = 1; back <= 3 && back <= bytes.byteLength; back++) {
		const byte = bytes[bytes.byteLength - back] as number;
		if ((byte & 0xc0) === 0x80) continue;
		return sequenceLength(byte) > back ? back : 0;
	}
	return 0;
}

/** Whether `bytes[at..]` holds a whole, valid UTF-8 character of `length` bytes (no overlong form, no surrogate). */
function validAt(bytes: Buffer, at: number, length: number): boolean {
	if (length === 0 || at + length > bytes.byteLength) return false;
	const first = bytes[at] as number;
	for (let i = 1; i < length; i++) if (((bytes[at + i] as number) & 0xc0) !== 0x80) return false;
	const second = bytes[at + 1] as number;
	if (first === 0xe0 && second < 0xa0) return false;
	if (first === 0xed && second > 0x9f) return false;
	if (first === 0xf0 && second < 0x90) return false;
	if (first === 0xf4 && second > 0x8f) return false;
	return true;
}

/**
 * Output as text, one pass: valid UTF-8 as it is; every other byte, and control characters other than tab, newline and
 * carriage return, as `?`. A stand-in of one byte keeps the shown text exactly as long as the output it shows, and its
 * JSON at most twice as long.
 */
function shown(bytes: Buffer): string {
	let text = "";
	let run = 0;
	let at = 0;
	while (at < bytes.byteLength) {
		const byte = bytes[at] as number;
		const length = sequenceLength(byte);
		const control = byte < 0x20 ? byte !== 0x09 && byte !== 0x0a && byte !== 0x0d : byte === 0x7f;
		if (!control && validAt(bytes, at, length)) {
			at += length;
			continue;
		}
		text += `${bytes.toString("utf8", run, at)}?`;
		at += 1;
		run = at;
	}
	return text + bytes.toString("utf8", run, at);
}

/** Drop a character cut in two at the end. */
function completeStart(bytes: Buffer): Buffer {
	return bytes.subarray(0, bytes.byteLength - unfinished(bytes));
}

/** Drop a character cut in two at the start. */
function completeEnd(bytes: Buffer): Buffer {
	let start = 0;
	while (start < 3 && start < bytes.byteLength && ((bytes[start] as number) & 0xc0) === 0x80) start++;
	return bytes.subarray(start);
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

	/** The commands still running. */
	get sessions(): number[] {
		return [...this.#sessions.values()].filter((session) => !session.ended).map((session) => session.id);
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
				return {
					t: "error",
					id: request.id,
					code: "WORKDIR_UNAVAILABLE",
					// The message stays inside the contract's 512 characters, however long the path.
					message: `No directory ${directory.length > 400 ? `...${directory.slice(-400)}` : directory}`,
				};
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
		const ended = session.ended;
		const output = session.unread.take(budget, ended !== undefined);
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
