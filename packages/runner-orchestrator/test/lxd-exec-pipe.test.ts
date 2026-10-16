import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LxdExecPipeRequest, LxdUnixClient } from "../src/lxd-client.ts";
import { serverFrame } from "./helpers/realtime-fake.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PROJECT = "qorpera-codehost-0123456789abcdef0123456789abcdef";
const INSTANCE = "qorpera-codehost";
const OPERATION = "/1.0/operations/6c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
const SECRETS = { "0": "e".repeat(64), "1": "f".repeat(64), "2": "9".repeat(64), control: "8".repeat(64) };
const MESSAGE = 64 * 1024;

interface FakeCommandIo {
	/** The whole of stdin, once its end message has come. */
	input(): Promise<Buffer>;
	print(stream: "stdout" | "stderr", payload: Buffer): void;
}
/** An exit code; `hold` runs until LXD kills it; `drop` ends with its stdout websocket closed without its end message. */
type FakeCommand = (io: FakeCommandIo) => Promise<number | "hold" | "drop">;

/** LXD's non-interactive exec with `wait-for-websocket` on a Unix socket: it starts the command once fds 0, 1 and 2
 * are connected and runs it beside its stdin, which it reads as it comes (not at all while `holdInput` is set: a
 * command busy before it reads). At the command's end it sends an empty text message on stdout and stderr, ends the
 * operation and closes every websocket; when the stdout websocket closes while the command runs, it kills it (137)
 * the same way. */
class FakeExecPipe {
	readonly posts: unknown[] = [];
	readonly upgrades: string[] = [];
	/** The size of each stdin message. */
	readonly inputMessages: number[] = [];
	unmaskedFrames = 0;
	input = Buffer.alloc(0);
	inputBytes = 0;
	/** Counts stdin without keeping it or its messages' sizes, as a command that streams it on. */
	discardInput = false;
	inputEnded = false;
	killed = false;
	holdInput = false;
	/** The fd whose upgrade it never answers, as an LXD that stalls the handshake. */
	withhold?: string;
	withheldSeen = false;
	withheldClosed = false;
	socket = "";
	readonly #sockets = new Set<Socket>();
	readonly #connected = new Map<string, Socket>();
	readonly #inputWaiters: Array<(input: Buffer) => void> = [];
	#exitCode?: number;
	readonly #waiters: Array<(exitCode: number) => void> = [];
	readonly #command: FakeCommand;

	constructor(command: FakeCommand) {
		this.#command = command;
	}

	async start(): Promise<void> {
		const root = await mkdtemp(join(tmpdir(), "qorpera-lxd-pipe-"));
		roots.push(root);
		this.socket = join(root, "lxd.socket");
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const reply = (status: number, body: unknown) =>
					response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
				if (request.method === "POST" && request.url === `/1.0/instances/${INSTANCE}/exec?project=${PROJECT}`) {
					this.posts.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
					reply(202, {
						type: "async",
						status: "Operation created",
						status_code: 100,
						operation: OPERATION,
						metadata: { id: OPERATION.slice(16), class: "websocket", metadata: { fds: SECRETS } },
					});
				} else if (request.method === "GET" && request.url === `${OPERATION}/wait?timeout=30`) {
					const answer = (exitCode: number) =>
						reply(200, {
							type: "sync",
							status: "Success",
							status_code: 200,
							metadata: { status: "Success", status_code: 200, err: "", metadata: { return: exitCode } },
						});
					if (this.#exitCode === undefined) this.#waiters.push(answer);
					else answer(this.#exitCode);
				} else reply(404, { type: "error", error_code: 404, error: "not found" });
			});
		});
		server.on("upgrade", (request: IncomingMessage, socket: Socket) => this.#upgrade(request, socket));
		servers.push(server);
		await new Promise<void>((resolveListen) => server.listen(this.socket, () => resolveListen()));
	}

	/** The command starts reading its stdin. */
	releaseInput(): void {
		this.holdInput = false;
		this.#connected.get("0")?.resume();
	}

	/** LXD drops the fd's websocket without its end message. */
	drop(fd: string): void {
		this.#connected.get(fd)?.destroy();
	}

	close(): void {
		for (const socket of this.#sockets) socket.destroy();
	}

	#upgrade(request: IncomingMessage, socket: Socket): void {
		this.#sockets.add(socket);
		const url = new URL(request.url ?? "/", "http://lxd");
		const fd = Object.entries(SECRETS).find(([, secret]) => secret === url.searchParams.get("secret"))?.[0];
		const key = request.headers["sec-websocket-key"];
		if (url.pathname !== `${OPERATION}/websocket` || !fd || fd === "control" || typeof key !== "string") {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		if (fd === this.withhold) {
			this.withheldSeen = true;
			// Reads on, so the client's end of the connection is seen; the server keeps its sockets half open.
			const closed = (): void => {
				this.withheldClosed = true;
				socket.destroy();
			};
			socket.once("end", closed);
			socket.once("error", closed);
			socket.once("close", closed);
			socket.resume();
			return;
		}
		this.upgrades.push(fd);
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		this.#connected.set(fd, socket);
		// The client may drop a connection while this side still writes to it.
		socket.on("error", () => undefined);
		if (fd === "0" && this.holdInput) socket.pause();
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.byteLength < 2) return;
				const opcode = buffer[0]! & 0x0f;
				if ((buffer[1]! & 0x80) === 0) this.unmaskedFrames++;
				let length = buffer[1]! & 0x7f;
				let offset = 2;
				if (length === 126) {
					if (buffer.byteLength < 4) return;
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					if (buffer.byteLength < 10) return;
					length = buffer.readUInt32BE(6);
					offset = 10;
				}
				if (buffer.byteLength < offset + 4 + length) return;
				const mask = buffer.subarray(offset, offset + 4);
				const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
				for (let index = 0; index < payload.byteLength; index++)
					payload[index] = payload[index]! ^ mask[index & 3]!;
				buffer = buffer.subarray(offset + 4 + length);
				if (opcode === 0x8) {
					this.#closedEarly(fd);
					this.#close(socket, payload);
					return;
				}
				if (fd !== "0" || this.inputEnded) continue;
				if (opcode === 0x2) {
					this.inputBytes += payload.byteLength;
					if (this.discardInput) continue;
					this.inputMessages.push(payload.byteLength);
					this.input = Buffer.concat([this.input, payload]);
				} else if (opcode === 0x1) {
					this.inputEnded = true;
					for (const waiter of this.#inputWaiters.splice(0)) waiter(this.input);
				}
			}
		});
		socket.on("close", () => this.#closedEarly(fd));
		if (["0", "1", "2"].every((connected) => this.#connected.has(connected))) void this.#run();
	}

	#closedEarly(fd: string): void {
		if (fd !== "1" || this.#exitCode !== undefined) return;
		this.killed = true;
		this.#end(137);
	}

	async #run(): Promise<void> {
		const stdout = this.#connected.get("1")!;
		const stderr = this.#connected.get("2")!;
		const outcome = await this.#command({
			input: () =>
				this.inputEnded
					? Promise.resolve(this.input)
					: new Promise((resolveInput) => this.#inputWaiters.push(resolveInput)),
			print: (stream, payload) => {
				const socket = stream === "stdout" ? stdout : stderr;
				if (this.#exitCode === undefined && !socket.writableEnded) socket.write(serverFrame(0x2, payload));
			},
		});
		if (outcome === "hold" || this.#exitCode !== undefined) return;
		if (outcome === "drop") {
			stdout.destroy();
			return;
		}
		stdout.write(serverFrame(0x1, Buffer.alloc(0)));
		stderr.write(serverFrame(0x1, Buffer.alloc(0)));
		this.#end(outcome);
	}

	#end(exitCode: number): void {
		if (this.#exitCode !== undefined) return;
		this.#exitCode = exitCode;
		for (const waiter of this.#waiters.splice(0)) waiter(exitCode);
		// LXD closes every websocket once the command is over, the stdin one whether or not it was read.
		for (const socket of this.#connected.values()) this.#close(socket, Buffer.from([0x03, 0xe8]));
	}

	#close(socket: Socket, payload: Buffer): void {
		if (!socket.writableEnded) socket.end(serverFrame(0x8, payload), () => socket.destroy());
	}
}

describe("LXD exec pipe", () => {
	const fakes: FakeExecPipe[] = [];
	afterEach(() => {
		for (const fake of fakes.splice(0)) fake.close();
	});
	async function fake(
		command: FakeCommand,
		options: { holdInput?: boolean; discardInput?: boolean } = {},
	): Promise<FakeExecPipe> {
		const exec = new FakeExecPipe(command);
		exec.holdInput = options.holdInput ?? false;
		exec.discardInput = options.discardInput ?? false;
		fakes.push(exec);
		await exec.start();
		return exec;
	}
	const request: LxdExecPipeRequest = {
		command: ["/usr/local/bin/git", "--git-dir=/company/code/acme/app/repo.git", "index-pack", "--stdin"],
		environment: {
			PATH: "/usr/local/bin:/usr/bin:/bin",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/dev/null",
		},
		cwd: "/var/lib/qorpera-code-host/jobs/0f",
		maxStdoutBytes: 1024,
		stderrTailBytes: 16,
	};
	function run(exec: FakeExecPipe, changes: Partial<LxdExecPipeRequest> = {}, signal = new AbortController().signal) {
		return new LxdUnixClient(exec.socket, 30).execInstancePipe(PROJECT, INSTANCE, { ...request, ...changes }, signal);
	}
	const endless = async function* (chunk: Buffer, closed: { done: boolean } = { done: false }) {
		try {
			for (;;) yield chunk;
		} finally {
			closed.done = true;
		}
	};
	// A source whose first read settles only once it is told to close, as a body that stopped arriving.
	function stalled() {
		const state = { reads: 0, closes: 0 };
		let release = (): void => undefined;
		const stdin: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]: () => ({
				next: () => {
					state.reads++;
					return new Promise<IteratorResult<Uint8Array>>((resolveRead) => {
						release = () => resolveRead({ done: true, value: undefined });
					});
				},
				return: async () => {
					state.closes++;
					release();
					return { done: true, value: undefined };
				},
			}),
		};
		return { stdin, state };
	}

	it("runs the command with its environment and directory and hands it its stdin, in no request body", async () => {
		const exec = await fake(async (io) => {
			const input = await io.input();
			io.print("stdout", Buffer.from(`read ${input.byteLength}`));
			io.print("stderr", Buffer.from("note"));
			return 0;
		});
		const result = await run(exec, { stdin: Buffer.from("PACK-the-bundle") });
		expect(result).toEqual({ exitCode: 0, stdout: Buffer.from("read 15"), stderrTail: Buffer.from("note") });
		expect(exec.posts).toEqual([
			{
				command: request.command,
				interactive: false,
				"wait-for-websocket": true,
				"record-output": false,
				user: 0,
				group: 0,
				cwd: request.cwd,
				environment: request.environment,
			},
		]);
		expect(JSON.stringify(exec.posts)).not.toContain("PACK");
		expect(exec.upgrades).toEqual(["1", "2", "0"]);
		expect(exec.input.toString()).toBe("PACK-the-bundle");
		expect(exec.inputEnded).toBe(true);
		expect(exec.killed).toBe(false);
	});

	it("closes stdin at once without an input and returns a failed command's status with the end of its stderr", async () => {
		const exec = await fake(async (io) => {
			await io.input();
			for (const line of ["fatal: one\n", "fatal: two\n", "fatal: the last line\n"])
				io.print("stderr", Buffer.from(line));
			return 128;
		});
		const result = await run(exec);
		expect(result).toEqual({
			exitCode: 128,
			stdout: Buffer.alloc(0),
			stderrTail: Buffer.from("fatal: the last line\n".slice(-16)),
		});
		expect(exec.inputEnded).toBe(true);
		expect(exec.input.byteLength).toBe(0);
	});

	it("streams any input in masked messages of at most 64 KiB, byte for byte, from bytes or a source", async () => {
		const bytes = randomBytes(200_008);
		const echo: FakeCommand = async (io) => {
			io.print("stdout", Buffer.from(String((await io.input()).byteLength)));
			return 0;
		};
		// Odd offsets and lengths: whole 32-bit words and the bytes after them.
		const parts = [bytes.subarray(3, 5), bytes.subarray(5, 6), bytes.subarray(6, 200_005), bytes.subarray(200_005)];
		const fromSource = await fake(echo);
		const streamed = await run(fromSource, {
			stdin: (async function* () {
				yield* parts;
			})(),
		});
		expect(streamed.stdout.toString()).toBe("200005");
		expect(Buffer.compare(fromSource.input, bytes.subarray(3))).toBe(0);
		expect(Math.max(...fromSource.inputMessages)).toBe(MESSAGE);
		expect(fromSource.unmaskedFrames).toBe(0);
		const fromBytes = await fake(echo);
		const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 1, 3 * MESSAGE + 7);
		expect((await run(fromBytes, { stdin: view })).stdout.toString()).toBe(String(view.byteLength));
		expect(Buffer.compare(fromBytes.input, view)).toBe(0);
		expect(fromBytes.inputMessages).toEqual([MESSAGE, MESSAGE, MESSAGE, 7]);
	});

	it("reads the source no faster than the command takes its input", async () => {
		const exec = await fake(
			async (io) => {
				io.print("stdout", Buffer.from(String((await io.input()).byteLength)));
				return 0;
			},
			{ holdInput: true },
		);
		let pulled = 0;
		const chunk = Buffer.alloc(MESSAGE, 1);
		const call = run(exec, {
			stdin: (async function* () {
				for (let index = 0; index < 64; index++) {
					pulled++;
					yield chunk;
				}
			})(),
		});
		await vi.waitFor(() => expect(pulled).toBeGreaterThan(0));
		await delay(300);
		const held = pulled;
		expect(held).toBeLessThan(32);
		await delay(100);
		expect(pulled).toBe(held);
		exec.releaseInput();
		expect((await call).stdout.toString()).toBe(String(64 * MESSAGE));
		expect(pulled).toBe(64);
	});

	it("keeps none of a long, finely chunked input once it is sent, while the command still runs", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		// A target a WeakRef was made or read for in this task stays until the task ends.
		const collect = async () => {
			await delay(0);
			gc();
		};
		const chunks = 16_384;
		const size = 4096;
		let finish = (): void => undefined;
		const exec = await fake(
			async (io) => {
				await io.input();
				await new Promise<void>((resolveFinish) => {
					finish = resolveFinish;
				});
				return 0;
			},
			{ discardInput: true },
		);
		const sent: WeakRef<Uint8Array>[] = [];
		await collect();
		const before = process.memoryUsage().arrayBuffers;
		const call = run(exec, {
			stdin: (async function* () {
				for (let index = 0; index < chunks; index++) {
					const chunk = Buffer.alloc(size, index);
					sent.push(new WeakRef(chunk));
					yield chunk;
				}
			})(),
		});
		try {
			await vi.waitFor(() => expect(exec.inputEnded).toBe(true), { timeout: 20_000 });
			expect(exec.inputBytes).toBe(chunks * size);
			// V8 frees a collected buffer's memory on a background thread after the GC, so a busy machine can still count
			// it for a while: collect again until it is gone. An input the pipe keeps never goes.
			await vi.waitFor(
				async () => {
					await collect();
					expect(process.memoryUsage().arrayBuffers - before).toBeLessThan((chunks * size) / 8);
				},
				{ timeout: 5_000, interval: 50 },
			);
			expect(sent.filter((chunk) => chunk.deref() !== undefined).length).toBeLessThan(chunks / 100);
		} finally {
			finish();
			// The call ends within the test, whatever failed.
			await call.catch(() => undefined);
		}
		expect((await call).exitCode).toBe(0);
	});

	it("kills a command stopped by its signal while its input waits, and closes the source", async () => {
		const exec = await fake(
			async (io) => {
				await io.input();
				return 0;
			},
			{ holdInput: true },
		);
		const closed = { done: false };
		const controller = new AbortController();
		const call = run(exec, { stdin: endless(Buffer.alloc(MESSAGE), closed) }, controller.signal);
		await vi.waitFor(() => expect(exec.upgrades).toHaveLength(3));
		await delay(50);
		controller.abort();
		await expect(call).rejects.toThrow("LXD exec pipe was stopped");
		await vi.waitFor(() => expect(exec.killed).toBe(true));
		await vi.waitFor(() => expect(closed.done).toBe(true), { timeout: 3000 });
	});

	it("closes a source whose read is pending when the call ends, by its signal or the command's exit", async () => {
		const stopped = await fake(async (io) => {
			await io.input();
			return 0;
		});
		const first = stalled();
		const controller = new AbortController();
		const call = run(stopped, { stdin: first.stdin }, controller.signal);
		await vi.waitFor(() => expect(first.state.reads).toBe(1));
		controller.abort();
		await expect(call).rejects.toThrow("LXD exec pipe was stopped");
		await vi.waitFor(() => expect(stopped.killed).toBe(true));
		await vi.waitFor(() => expect(first.state.closes).toBe(1));
		const exited = await fake(async (io) => {
			io.print("stderr", Buffer.from("fatal: no pack"));
			return 128;
		});
		const second = stalled();
		expect(await run(exited, { stdin: second.stdin })).toEqual({
			exitCode: 128,
			stdout: Buffer.alloc(0),
			stderrTail: Buffer.from("fatal: no pack"),
		});
		await vi.waitFor(() => expect(second.state.closes).toBe(1));
		// Neither source is read again.
		expect([first.state.reads, second.state.reads]).toEqual([1, 1]);
	});

	it("closes a generator stalled in a read once that read settles, and reads it no further", async () => {
		const exec = await fake(async (io) => {
			await io.input();
			return 0;
		});
		const state = { pulled: 0, closed: false };
		let arrive = (): void => undefined;
		const controller = new AbortController();
		const call = run(
			exec,
			{
				stdin: (async function* () {
					try {
						for (;;) {
							state.pulled++;
							await new Promise<void>((resolveArrival) => {
								arrive = resolveArrival;
							});
							yield Buffer.from("PACK");
						}
					} finally {
						state.closed = true;
					}
				})(),
			},
			controller.signal,
		);
		await vi.waitFor(() => expect(state.pulled).toBe(1));
		controller.abort();
		await expect(call).rejects.toThrow("LXD exec pipe was stopped");
		expect(state.closed).toBe(false);
		arrive();
		await vi.waitFor(() => expect(state.closed).toBe(true));
		expect(state.pulled).toBe(1);
		expect(exec.input.byteLength).toBe(0);
	});

	it("stops a handshake LXD never answers on the signal or when the call ends, well before its own timeout", async () => {
		const command: FakeCommand = async (io) => {
			await io.input();
			return 0;
		};
		const stopped = await fake(command);
		stopped.withhold = "2";
		const controller = new AbortController();
		const call = run(stopped, {}, controller.signal);
		await vi.waitFor(() => expect(stopped.withheldSeen).toBe(true));
		const abortedAt = Date.now();
		controller.abort();
		await expect(call).rejects.toThrow("LXD exec pipe was stopped");
		// The handshake's own timeout is 10 s.
		expect(Date.now() - abortedAt).toBeLessThan(1_000);
		await vi.waitFor(() => expect(stopped.withheldClosed).toBe(true));
		// The stdout websocket already connected is closed too.
		expect(stopped.upgrades).toEqual(["1"]);
		await vi.waitFor(() => expect(stopped.killed).toBe(true));
		const dropped = await fake(command);
		dropped.withhold = "2";
		const ended = run(dropped);
		await vi.waitFor(() => expect(dropped.withheldSeen).toBe(true));
		const droppedAt = Date.now();
		dropped.drop("1");
		await expect(ended).rejects.toThrow("LXD exec pipe ended before its output");
		expect(Date.now() - droppedAt).toBeLessThan(1_000);
		await vi.waitFor(() => expect(dropped.withheldClosed).toBe(true));
	});

	it("fails with the source's own error, or on a chunk that is not bytes, and kills the command", async () => {
		const broken = new Error("the bundle stopped arriving");
		const exec = await fake(async (io) => {
			await io.input();
			return 0;
		});
		await expect(
			run(exec, {
				stdin: (async function* () {
					yield Buffer.from("PACK");
					throw broken;
				})(),
			}),
		).rejects.toBe(broken);
		await vi.waitFor(() => expect(exec.killed).toBe(true));
		expect(exec.inputEnded).toBe(false);
		const wrong = await fake(async (io) => {
			await io.input();
			return 0;
		});
		await expect(
			run(wrong, {
				stdin: (async function* () {
					yield "PACK" as unknown as Uint8Array;
				})(),
			}),
		).rejects.toThrow("LXD exec pipe input is invalid");
		await vi.waitFor(() => expect(wrong.killed).toBe(true));
	});

	it("fails a command that succeeded without all of its input, and returns one that failed", async () => {
		const succeeded = await fake(
			async (io) => {
				io.print("stdout", Buffer.from("done"));
				return 0;
			},
			{ holdInput: true },
		);
		const first = { done: false };
		await expect(run(succeeded, { stdin: endless(Buffer.alloc(MESSAGE), first) })).rejects.toThrow(
			"LXD exec pipe command ended before its input",
		);
		const failed = await fake(
			async (io) => {
				io.print("stderr", Buffer.from("fatal: bad pack"));
				return 2;
			},
			{ holdInput: true },
		);
		const second = { done: false };
		expect(await run(failed, { stdin: endless(Buffer.alloc(MESSAGE), second) })).toEqual({
			exitCode: 2,
			stdout: Buffer.alloc(0),
			stderrTail: Buffer.from("fatal: bad pack"),
		});
		// Neither source is read on after its call.
		await vi.waitFor(() => expect(first.done && second.done).toBe(true), { timeout: 3000 });
	});

	it("reads a long output whole, up to its bound, and kills a command that passes it", async () => {
		const output = randomBytes(3 * 1024 * 1024 + 5);
		const long = await fake(async (io) => {
			await io.input();
			for (let offset = 0; offset < output.byteLength; offset += 32 * 1024)
				io.print("stdout", output.subarray(offset, offset + 32 * 1024));
			return 0;
		});
		expect((await run(long, { maxStdoutBytes: output.byteLength })).stdout.equals(output)).toBe(true);
		const over = await fake(async (io) => {
			io.print("stdout", Buffer.alloc(600));
			io.print("stdout", Buffer.alloc(600));
			return "hold";
		});
		await expect(run(over)).rejects.toThrow("LXD exec pipe output exceeded its bound");
		await vi.waitFor(() => expect(over.killed).toBe(true));
	});

	it("fails when a stream ends without its end message", async () => {
		const exec = await fake(async (io) => {
			io.print("stdout", Buffer.from("cut"));
			return "drop";
		});
		await expect(run(exec)).rejects.toThrow("LXD exec pipe ended before its output");
	});

	it("refuses an invalid command, environment, directory, input or bound before asking LXD", async () => {
		const exec = await fake(async () => 0);
		const client = new LxdUnixClient(exec.socket, 30);
		const many = (count: number, value: string) =>
			Object.fromEntries(Array.from({ length: count }, (_, index) => [`V${index}`, value]));
		const invalid: LxdExecPipeRequest[] = [
			{ ...request, command: [] },
			{ ...request, command: [""] },
			{ ...request, command: Array.from({ length: 65 }, () => "/bin/true") },
			{ ...request, command: ["/bin/sh", "-c", "a\0b"] },
			{ ...request, command: ["/bin/sh", "x".repeat(64 * 1024 + 1)] },
			{ ...request, environment: { "1PATH": "/bin" } },
			{ ...request, environment: { "A=B": "c" } },
			{ ...request, environment: { HOME: "/root\0" } },
			{ ...request, environment: many(257, "1") },
			{ ...request, environment: many(5, "x".repeat(60 * 1024)) },
			{ ...request, cwd: "relative/dir" },
			{ ...request, cwd: "/tmp\0" },
			{ ...request, stdin: "text" as unknown as Uint8Array },
			{ ...request, maxStdoutBytes: 256 * 1024 * 1024 + 1 },
			{ ...request, maxStdoutBytes: -1 },
			{ ...request, stderrTailBytes: 64 * 1024 + 1 },
		];
		for (const refused of invalid)
			await expect(
				client.execInstancePipe(PROJECT, INSTANCE, refused, new AbortController().signal),
			).rejects.toThrow("LXD instance command is invalid");
		expect(exec.posts).toEqual([]);
	});
});
