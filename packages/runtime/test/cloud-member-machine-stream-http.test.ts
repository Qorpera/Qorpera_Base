import { createHash, randomBytes } from "node:crypto";
import { connect, Socket } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL,
	CloudMemberMachineStreamListener,
	type CloudMemberMachineStreamRun,
	cloudMemberMachineStreamClose,
	MEMBER_STREAM_HIGH_WATER_BYTES,
	MEMBER_STREAM_UNFLUSHED_MESSAGES,
	type MemberStreamWay,
	writeMemberStreamMessage,
} from "../src/cloud-member-machine-stream-http.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const TICKET = "A".repeat(43);
const ORIGIN = "https://app.qorpera.com";

/** A browser's side of one WebSocket, by hand: the upgrade, then frames. */
async function open(
	port: number,
	change: { path?: string; headers?: Record<string, string | undefined>; method?: string; halfOpen?: boolean } = {},
): Promise<{
	socket: Socket;
	status: string;
	head: string;
	frames: { opcode: number; payload: Buffer }[];
	closed: Promise<void>;
}> {
	// A client that keeps its own side open after the listener's end may go on writing (the v245 release review F1).
	const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: change.halfOpen === true });
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	const key = randomBytes(16).toString("base64");
	const headers: Record<string, string | undefined> = {
		Host: "screens.qorpera.com",
		Upgrade: "websocket",
		Connection: "Upgrade",
		"Sec-WebSocket-Key": key,
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Protocol": CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL,
		Origin: ORIGIN,
		...change.headers,
	};
	socket.write(
		`${change.method ?? "GET"} ${change.path ?? `/v1/member-machine-streams/${TICKET}`} HTTP/1.1\r\n${Object.entries(
			headers,
		)
			.filter(([, value]) => value !== undefined)
			.map(([name, value]) => `${name}: ${value}\r\n`)
			.join("")}\r\n`,
	);
	let buffer = Buffer.alloc(0);
	let head = "";
	const frames: { opcode: number; payload: Buffer }[] = [];
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	await new Promise<void>((resolve) => {
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!head) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				head = buffer.subarray(0, end).toString("latin1");
				buffer = buffer.subarray(end + 4);
				resolve();
			}
			for (;;) {
				if (buffer.byteLength < 2) break;
				const second = buffer[1] as number;
				expect(second & 0x80).toBe(0);
				let length = second & 0x7f;
				let at = 2;
				if (length === 126) {
					if (buffer.byteLength < 4) break;
					length = buffer.readUInt16BE(2);
					at = 4;
				} else if (length === 127) {
					if (buffer.byteLength < 10) break;
					length = Number(buffer.readBigUInt64BE(2));
					at = 10;
				}
				if (buffer.byteLength < at + length) break;
				frames.push({
					opcode: (buffer[0] as number) & 0x0f,
					payload: Buffer.from(buffer.subarray(at, at + length)),
				});
				buffer = buffer.subarray(at + length);
			}
		});
		socket.once("close", () => resolve());
	});
	if (head.startsWith("HTTP/1.1 101"))
		expect(head).toContain(
			`Sec-WebSocket-Accept: ${createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}`,
		);
	return { socket, status: head.split("\r\n")[0] ?? "", head, frames, closed };
}
/** A frame as a browser sends it: masked. */
function masked(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const body = Buffer.from(payload);
	for (let i = 0; i < body.byteLength; i++) body[i] = (body[i] as number) ^ (mask[i % 4] as number);
	return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.byteLength]), mask, body]);
}

/** Waits `ms` of real time, even while a test fakes the timers. */
const realTimeout = globalThis.setTimeout;
const pause = (ms: number) => new Promise<void>((resolve) => realTimeout(resolve, ms));
/** A stream that runs until it is ended, its signal kept. */
const waiting =
	(signals: AbortSignal[]): CloudMemberMachineStreamRun =>
	async (_sink, signal) => {
		signals.push(signal);
		return new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("closed")));
	};
const closeCode = (one: { frames: { opcode: number; payload: Buffer }[] }) =>
	one.frames
		.filter((frame) => frame.opcode === 0x8)
		.at(-1)
		?.payload.readUInt16BE(0);
/** The listener's own sockets as it writes on them (an accepted socket carries its server), the pongs it wrote, and the
 * most that ever waited unflushed on one of them. */
function serverSide() {
	const sockets: Socket[] = [];
	const seen = { pongs: 0, pings: 0, most: 0 };
	const write = Socket.prototype.write;
	const spy = vi.spyOn(Socket.prototype, "write").mockImplementation(function (
		this: Socket & { server?: unknown },
		...args: unknown[]
	) {
		const result = (write as (...values: unknown[]) => boolean).apply(this, args);
		if (this.server) {
			if (!sockets.includes(this)) sockets.push(this);
			if (Buffer.isBuffer(args[0]) && args[0][0] === 0x8a) seen.pongs++;
			if (Buffer.isBuffer(args[0]) && args[0][0] === 0x89) seen.pings++;
			seen.most = Math.max(seen.most, this.writableLength);
		}
		return result;
	});
	cleanups.push(async () => {
		spy.mockRestore();
	});
	return { sockets, seen };
}

async function listener(
	admit: (ticket: string, origin: string) => CloudMemberMachineStreamRun | null,
	maxStreams?: number,
) {
	const service = new CloudMemberMachineStreamListener({
		host: "127.0.0.1",
		port: 0 as unknown as number,
		admit,
		...(maxStreams ? { maxStreams } : {}),
	});
	cleanups.push(() => service.close());
	return { service, port: await service.listen() };
}

describe("the live-picture listener (20260930745000)", () => {
	it("refuses with a bare 404 anything but the one route's upgrade, a ticket it does not admit, and past its limit", async () => {
		const admit = vi.fn((ticket: string) =>
			ticket === TICKET
				? ((async (_sink, signal) =>
						new Promise<string>((resolve) =>
							signal.addEventListener("abort", () => resolve("closed")),
						)) as CloudMemberMachineStreamRun)
				: null,
		);
		const { port } = await listener(admit, 1);
		for (const change of [
			{ path: "/" },
			{ path: `/v1/member-machine-streams/${"A".repeat(42)}` },
			{ path: `/v1/member-machine-streams/${TICKET}/x` },
			{ path: `/v1/member-machine-screens/${TICKET}` },
			{ method: "POST" },
			{ headers: { Origin: undefined } },
			{ headers: { "Sec-WebSocket-Protocol": "chat" } },
			{ headers: { "Sec-WebSocket-Version": "8" } },
			{ headers: { Upgrade: undefined, Connection: undefined } },
			{ headers: { "Sec-WebSocket-Key": "short" } },
			{ path: `/v1/member-machine-streams/${"B".repeat(43)}` },
		]) {
			const one = await open(port, change);
			expect(one.status, JSON.stringify(change)).toBe("HTTP/1.1 404 Not Found");
			expect(one.head).not.toMatch(/content-type|error|ticket/i);
			await one.closed;
		}
		// The one admitted: and then the listener's limit is reached.
		const first = await open(port);
		expect(first.status).toBe("HTTP/1.1 101 Switching Protocols");
		expect(first.head).toContain(`Sec-WebSocket-Protocol: ${CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL}`);
		const second = await open(port);
		expect(second.status).toBe("HTTP/1.1 404 Not Found");
		first.socket.destroy();
	});

	it("sends what the stream sends as binary messages of any size, answers pings, and closes with why the stream ended", async () => {
		const big = randomBytes(70_000);
		let resolveRun: (reason: string) => void = () => {};
		const { port } = await listener(() => async (sink) => {
			await sink.send(Buffer.from([1, 0, 64, 0, 40]));
			await sink.send(big);
			return new Promise<string>((resolve) => {
				resolveRun = resolve;
			});
		});
		const one = await open(port);
		one.socket.write(masked(0x9, Buffer.from("hi")));
		await vi.waitFor(() => expect(one.frames.map((f) => f.opcode)).toEqual([0x2, 0x2, 0xa]));
		expect(one.frames[0]!.payload).toEqual(Buffer.from([1, 0, 64, 0, 40]));
		expect(one.frames[1]!.payload.equals(big)).toBe(true);
		expect(one.frames[2]!.payload.toString()).toBe("hi");
		resolveRun("DESKTOP_HELD_SINCE");
		await vi.waitFor(() => expect(one.frames.at(-1)?.opcode).toBe(0x8));
		const close = one.frames.at(-1)!.payload;
		expect(close.readUInt16BE(0)).toBe(4003);
		expect(close.subarray(2).toString()).toBe("DESKTOP_HELD_SINCE");
	});

	it("only shows: a browser that sends a data message, text or binary, is ended (1008), and the stream with it", async () => {
		for (const opcode of [0x1, 0x2]) {
			const signals: AbortSignal[] = [];
			const { port } = await listener(() => async (_sink, signal) => {
				signals.push(signal);
				return new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("closed")));
			});
			const one = await open(port);
			one.socket.write(masked(opcode, Buffer.from("click 10 10")));
			await vi.waitFor(() => expect(one.frames.at(-1)?.opcode).toBe(0x8));
			expect(one.frames.at(-1)!.payload.readUInt16BE(0)).toBe(1008);
			expect(signals[0]!.aborted).toBe(true);
		}
		// An unmasked frame, or a control frame too long: ended (1002).
		const { port } = await listener(
			() => async (_sink, signal) =>
				new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("closed"))),
		);
		const one = await open(port);
		one.socket.write(Buffer.from([0x89, 0x00]));
		await vi.waitFor(() => expect(one.frames.at(-1)?.payload.readUInt16BE(0)).toBe(1002));
	});

	it("ends the stream when the browser closes or goes, and every stream when it stops (1001)", async () => {
		const signals: AbortSignal[] = [];
		const { service, port } = await listener(() => async (_sink, signal) => {
			signals.push(signal);
			return new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("closed")));
		});
		const closing = await open(port);
		closing.socket.write(masked(0x8, Buffer.from([0x03, 0xe8])));
		await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
		const gone = await open(port);
		gone.socket.destroy();
		await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
		const staying = await open(port);
		await vi.waitFor(() => expect(signals).toHaveLength(3));
		await service.close();
		await vi.waitFor(() => expect(staying.frames.at(-1)?.payload.readUInt16BE(0)).toBe(1001));
	});

	it("lets a connection that sends nothing hold its socket about 6 s at most, never the 35 s of Node's default check (the lead's read, 13 Nov)", async () => {
		const { port } = await listener(() => null);
		const idle = connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => idle.once("connect", () => resolve()));
		idle.on("error", () => {});
		const began = Date.now();
		await new Promise<void>((resolve) => idle.once("close", () => resolve()));
		const held = Date.now() - began;
		// The upgrade's 5 s, checked every second.
		expect(held).toBeGreaterThanOrEqual(4500);
		expect(held).toBeLessThan(7000);
	}, 15_000);

	it("holds at most 256 connections: the 257th is closed as it is accepted, and a stream it admitted keeps running", async () => {
		let sends = 0;
		let stop: (reason: string) => void = () => {};
		const { service, port } = await listener(() => async (sink, signal) => {
			const beat = setInterval(() => {
				sends++;
				void sink.send(Buffer.from([1, 0, 64, 0, 40])).catch(() => {});
			}, 100);
			signal.addEventListener("abort", () => clearInterval(beat));
			return new Promise<string>((resolve) => {
				stop = (reason) => {
					clearInterval(beat);
					resolve(reason);
				};
			});
		});
		// One admitted stream: an upgraded connection counts among the 256 until it ends.
		const stream = await open(port);
		expect(stream.status).toBe("HTTP/1.1 101 Switching Protocols");
		// 255 connections that send nothing: 256 in all.
		const idle: Socket[] = [];
		cleanups.push(async () => {
			for (const one of idle) one.destroy();
		});
		for (let n = 0; n < 255; n++) {
			const one = connect(port, "127.0.0.1");
			one.on("error", () => {});
			await new Promise<void>((resolve) => one.once("connect", () => resolve()));
			idle.push(one);
		}
		// The 257th: accepted by the kernel, closed by the listener at once, before a byte is read.
		const over = connect(port, "127.0.0.1");
		over.on("error", () => {});
		const began = Date.now();
		await new Promise<void>((resolve) => over.once("close", () => resolve()));
		expect(Date.now() - began).toBeLessThan(1000);
		// The 256 are still open, and the stream still streams.
		expect(idle.filter((one) => one.destroyed).length).toBe(0);
		const before = stream.frames.length;
		await vi.waitFor(() => expect(stream.frames.length).toBeGreaterThan(before + 2));
		expect(stream.frames.every((one) => one.opcode === 0x2)).toBe(true);
		expect(sends).toBeGreaterThan(0);
		stop("closed");
		await vi.waitFor(() => expect(stream.frames.at(-1)?.opcode).toBe(0x8));
		// And the executor's stop is not held by them: the 255 that never upgraded are cut at once.
		const closing = Date.now();
		await service.close();
		expect(Date.now() - closing).toBeLessThan(3000);
		await vi.waitFor(() => expect(idle.every((one) => one.destroyed)).toBe(true));
	}, 15_000);

	it("lets a send through while at most MEMBER_STREAM_UNFLUSHED_MESSAGES are written and not flushed, and the bytes under the mark (review r12 of #1746)", async () => {
		// A member's way that flushes nothing until the test lets it: each write's callback held.
		const held: (() => void)[] = [];
		const out = new Writable({
			highWaterMark: 1 << 30,
			write(_chunk, _encoding, done) {
				held.push(() => done());
			},
			writev(_chunks, done) {
				held.push(() => done());
			},
		});
		const way: MemberStreamWay = { unflushed: 0 };
		const small = () => Buffer.alloc(13, 2);
		const settled = async (send: Promise<void>) =>
			Promise.race([send.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]);
		for (let n = 0; n < MEMBER_STREAM_UNFLUSHED_MESSAGES; n++)
			expect(await settled(writeMemberStreamMessage(out, way, Buffer.alloc(2), small()))).toBe(true);
		// One more: it is written, and its send waits until one of them is flushed.
		const waiting = writeMemberStreamMessage(out, way, Buffer.alloc(2), small());
		expect(await settled(waiting)).toBe(false);
		expect(way.unflushed).toBe(MEMBER_STREAM_UNFLUSHED_MESSAGES + 1);
		(held.shift() as () => void)();
		expect(await settled(waiting)).toBe(true);
		// Bytes too: one message past the mark waits, whatever the count.
		for (const flush of held.splice(0)) flush();
		await new Promise((resolve) => setImmediate(resolve));
		for (const flush of held.splice(0)) flush();
		await new Promise((resolve) => setImmediate(resolve));
		expect(way.unflushed).toBe(0);
		const large = writeMemberStreamMessage(
			out,
			way,
			Buffer.alloc(10),
			Buffer.alloc(MEMBER_STREAM_HIGH_WATER_BYTES + 1),
		);
		expect(await settled(large)).toBe(false);
		(held.shift() as () => void)();
		expect(await settled(large)).toBe(true);
	});

	describe("the client's side bounded as one invariant (the v245 release review F1)", () => {
		it("(a) reads nothing more of a stream it ended: a client that keeps writing at full speed after its rejection holds nothing, and its socket goes in time", async () => {
			const { sockets } = serverSide();
			const signals: AbortSignal[] = [];
			const { port } = await listener(() => waiting(signals));
			// What the client floods with: valid frames, each of which a handler still reading would parse.
			const flood = Buffer.concat(Array.from({ length: 10_000 }, () => masked(0xa, Buffer.alloc(0))));
			for (const reads of [true, false]) {
				const one = await open(port, { halfOpen: true });
				one.socket.on("error", () => {});
				cleanups.push(async () => {
					one.socket.destroy();
				});
				const mine = sockets.at(-1) as Socket;
				if (!reads) one.socket.pause();
				const before = process.memoryUsage().arrayBuffers;
				let most = 0;
				let written = 0;
				// The rejection: a data message (it only shows).
				one.socket.write(masked(0x1, Buffer.from("click 10 10")));
				const began = performance.now();
				let gone = 0;
				// The client writes as fast as the way takes it (never more than 1 MiB waiting on its own side) for the two
				// seconds, or until the listener's socket is gone.
				while (performance.now() - began < 2000) {
					if (mine.destroyed && gone === 0) gone = performance.now() - began;
					if (one.socket.writableLength < 1024 * 1024 && !one.socket.destroyed && one.socket.write(flood))
						written += flood.byteLength;
					await new Promise((resolve) => setImmediate(resolve));
					most = Math.max(most, process.memoryUsage().arrayBuffers - before);
				}
				expect(signals.at(-1)?.aborted).toBe(true);
				// Gone in time: the close is flushed at once here, and 2 s is the latest in any case.
				expect(mine.destroyed).toBe(true);
				expect(gone).toBeLessThan(2000);
				// Nothing of what came after the rejection is kept or joined on the executor: its buffers stay flat while
				// the client writes (the old handler joined every read onto all that came before it).
				expect(most).toBeLessThan(4 * 1024 * 1024);
				expect(written).toBeLessThan(64 * 1024 * 1024);
				if (reads) expect(closeCode(one)).toBe(1008);
			}
		}, 15_000);

		it("(b) ends a client that floods pings and never reads: its pongs never pile up, the write buffer stays bounded, and its socket goes after 2 s at the latest", async () => {
			const { sockets, seen } = serverSide();
			const picture = Buffer.alloc(256 * 1024, 7);
			let full = false;
			const signals: AbortSignal[] = [];
			const { port } = await listener(() => async (sink, signal) => {
				signals.push(signal);
				// Pictures until the way is full: the client reads none of them.
				while (!signal.aborted) {
					const sent = sink.send(picture).then(
						() => true,
						() => true,
					);
					if (!(await Promise.race([sent, pause(300).then(() => false)]))) {
						full = true;
						await sent;
					}
				}
				return "closed";
			});
			const one = await open(port);
			one.socket.on("error", () => {});
			cleanups.push(async () => {
				one.socket.destroy();
			});
			one.socket.pause();
			const mine = sockets.at(-1) as Socket;
			await vi.waitFor(() => expect(full).toBe(true), { timeout: 10_000 });
			const pongsBefore = seen.pongs;
			// A thousand pings at once.
			const began = performance.now();
			one.socket.write(Buffer.concat(Array.from({ length: 1000 }, () => masked(0x9, Buffer.from("ping")))));
			await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
			// Ended at the fifth: four pongs wait unflushed, and nothing more was answered.
			expect(seen.pongs - pongsBefore).toBe(4);
			expect(seen.most).toBeLessThanOrEqual(MEMBER_STREAM_HIGH_WATER_BYTES + picture.byteLength + 1024);
			// Its close cannot be flushed to a client that reads nothing: the socket goes after the 2 s.
			await vi.waitFor(() => expect(mine.destroyed).toBe(true), { timeout: 5000, interval: 20 });
			const held = performance.now() - began;
			expect(held).toBeGreaterThan(1500);
			expect(held).toBeLessThan(3000);
		}, 20_000);

		it("(c) ends a client that floods valid pongs at the bound, with the loop free, and reads nothing after", async () => {
			const signals: AbortSignal[] = [];
			const { port } = await listener(() => waiting(signals));
			const pong = () => masked(0xa, Buffer.alloc(0));
			// The bound itself is taken: 32 frames in a window.
			const one = await open(port);
			one.socket.write(Buffer.concat(Array.from({ length: 32 }, pong)));
			await pause(200);
			expect(signals[0]?.aborted).toBe(false);
			// One more in the same window ends it.
			one.socket.write(pong());
			await vi.waitFor(() => expect(closeCode(one)).toBe(1008));
			expect(signals[0]?.aborted).toBe(true);
			// A hundred thousand at once: ended at the 33rd; the rest is never looked at, and the loop never waits.
			const two = await open(port, { halfOpen: true });
			two.socket.on("error", () => {});
			const flood = Buffer.concat(Array.from({ length: 100_000 }, pong));
			let longest = 0;
			let last = performance.now();
			const beat = setInterval(() => {
				const at = performance.now();
				longest = Math.max(longest, at - last);
				last = at;
			}, 5);
			two.socket.write(flood);
			await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
			await vi.waitFor(() => expect(closeCode(two)).toBe(1008));
			await pause(100);
			clearInterval(beat);
			// The clock only tells a loop held for seconds from one that ran: the shared test machine sets timers aside for
			// tens of milliseconds under load (the exact bounds are the listener's own, checked above).
			expect(longest).toBeLessThan(1000);
		});

		it("(d) takes a frame split a byte a write, and a close split the same way", async () => {
			const signals: AbortSignal[] = [];
			const { port } = await listener(() => waiting(signals));
			const one = await open(port);
			one.socket.setNoDelay(true);
			for (const byte of masked(0x9, Buffer.from("abcd"))) {
				one.socket.write(Buffer.from([byte]));
				await pause(3);
			}
			await vi.waitFor(() => expect(one.frames.at(-1)?.opcode).toBe(0xa));
			expect(one.frames.at(-1)?.payload.toString()).toBe("abcd");
			expect(signals[0]?.aborted).toBe(false);
			// The longest frame a client may send (a close with a reason of 123 bytes: 131 bytes), a byte a write.
			for (const byte of masked(0x8, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.alloc(123, 0x61)]))) {
				one.socket.write(Buffer.from([byte]));
				await pause(1);
			}
			await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
			await vi.waitFor(() => expect(closeCode(one)).toBe(1000));
		}, 15_000);

		it("(e) ends nothing of a correct browser's pattern over ten minutes, and ends one that stops answering its pings", async () => {
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
			});
			try {
				const signals: AbortSignal[] = [];
				const { port } = await listener(() => waiting(signals));
				const one = await open(port);
				let own = 0;
				for (let half = 0; half < 20; half++) {
					const seen = one.frames.length;
					await vi.advanceTimersByTimeAsync(30_000);
					// Our ping comes every 30 s, and the browser answers it with a pong at once.
					await vi.waitFor(() => expect(one.frames.length).toBe(seen + 1));
					expect(one.frames.at(-1)?.opcode).toBe(0x9);
					one.socket.write(masked(0xa, Buffer.alloc(0)));
					// And now and then a ping of its own, answered (its pong also says the pong before it was read).
					const word = `own-${own++}`;
					one.socket.write(masked(0x9, Buffer.from(word)));
					await vi.waitFor(() => expect(one.frames.at(-1)?.payload.toString()).toBe(word));
				}
				// Ten minutes: nothing ended, no close was sent.
				expect(signals[0]?.aborted).toBe(false);
				expect(one.frames.some((frame) => frame.opcode === 0x8)).toBe(false);
				// The wall clock stepped back an hour changes nothing either.
				vi.setSystemTime(Date.now() - 3_600_000);
				await vi.advanceTimersByTimeAsync(30_000);
				await vi.waitFor(() => expect(one.frames.at(-1)?.opcode).toBe(0x9));
				expect(signals[0]?.aborted).toBe(false);
				// It stops answering: one ping waits unanswered and no second is sent on top of it; 60 s on, it is ended.
				const asked = one.frames.filter((frame) => frame.opcode === 0x9).length;
				await vi.advanceTimersByTimeAsync(30_000);
				expect(signals[0]?.aborted).toBe(false);
				await vi.advanceTimersByTimeAsync(30_000);
				await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
				expect(one.frames.filter((frame) => frame.opcode === 0x9).length).toBe(asked);
			} finally {
				vi.useRealTimers();
			}
		}, 30_000);
	});

	it("ends a client that reads nothing on time whatever pongs it sends: a pong answers our ping only once that ping left, and one ping at most waits (review r14 of #1746)", async () => {
		const { seen } = serverSide();
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
		});
		try {
			const signals: AbortSignal[] = [];
			const picture = Buffer.alloc(256 * 1024, 7);
			const { port } = await listener(() => async (sink, signal) => {
				signals.push(signal);
				// 32 MiB of pictures at once: far past what the kernel takes for a client that reads nothing, so every
				// write after them (our ping among them) waits in this process.
				for (let n = 0; n < 128; n++) void sink.send(picture).catch(() => {});
				return new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("closed")));
			});
			const one = await open(port);
			one.socket.on("error", () => {});
			cleanups.push(async () => {
				one.socket.destroy();
			});
			one.socket.pause();
			await vi.waitFor(() => expect(signals).toHaveLength(1));
			// A pong every 5 s, unasked or for a ping it never took: well under the input limits.
			let elapsed = 0;
			while (elapsed < 85_000) {
				await vi.advanceTimersByTimeAsync(5000);
				elapsed += 5000;
				one.socket.write(masked(0xa, Buffer.alloc(0)));
				await pause(5);
				expect(signals[0]?.aborted, `at ${elapsed} ms`).toBe(false);
				expect(seen.pings).toBeLessThanOrEqual(1);
			}
			// Our one ping went at 30 s and never left; 60 s on, at 90 s, the stream is ended, the pongs counting for nothing.
			await vi.advanceTimersByTimeAsync(5000);
			await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
			expect(seen.pings).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	}, 30_000);

	it("tells the browser why, in a code and a reason it acts on", () => {
		expect(cloudMemberMachineStreamClose("closed")).toEqual({ code: 1000, reason: "" });
		expect(cloudMemberMachineStreamClose("POINTER_PASS_ENDED")).toEqual({ code: 4001, reason: "POINTER_PASS_ENDED" });
		expect(cloudMemberMachineStreamClose("idle")).toEqual({ code: 4004, reason: "DESKTOP_ENDED" });
		expect(cloudMemberMachineStreamClose("MACHINE_BOOT_CHANGED")).toEqual({
			code: 4004,
			reason: "MACHINE_BOOT_CHANGED",
		});
		expect(cloudMemberMachineStreamClose("MEMBER_CANNOT_READ")).toEqual({ code: 4003, reason: "MEMBER_CANNOT_READ" });
		expect(cloudMemberMachineStreamClose("not one of ours")).toEqual({ code: 4003, reason: "STREAM_UNAVAILABLE" });
	});

	it("binds the loopback only", () => {
		expect(
			() =>
				new CloudMemberMachineStreamListener({
					host: "0.0.0.0" as "127.0.0.1",
					port: 8793,
					admit: () => null,
				}),
		).toThrow("Member machine stream listener is invalid");
	});

	it("accepts a coalesced control frame in the upgrade head and rejects oversized upgrade heads with 404", async () => {
		const signals: AbortSignal[] = [];
		const { port } = await listener((ticket) => (ticket === TICKET ? waiting(signals) : null));

		const rawCoalesced = async (extra: Buffer) => {
			const socket = connect({ port, host: "127.0.0.1" });
			await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
			const key = randomBytes(16).toString("base64");
			socket.write(
				Buffer.concat([
					Buffer.from(
						`GET /v1/member-machine-streams/${TICKET} HTTP/1.1\r\nHost: screens.qorpera.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL}\r\nOrigin: ${ORIGIN}\r\n\r\n`,
					),
					extra,
				]),
			);
			let buf = Buffer.alloc(0);
			let head = "";
			const frames: { opcode: number; payload: Buffer }[] = [];
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			await new Promise<void>((resolve) => {
				socket.on("data", (chunk: Buffer) => {
					buf = Buffer.concat([buf, chunk]);
					if (!head) {
						const end = buf.indexOf("\r\n\r\n");
						if (end < 0) return;
						head = buf.subarray(0, end).toString("latin1");
						buf = buf.subarray(end + 4);
						resolve();
					}
					while (buf.byteLength >= 2) {
						const len = (buf[1] as number) & 0x7f;
						if (buf.byteLength < 2 + len) break;
						frames.push({ opcode: (buf[0] as number) & 0x0f, payload: Buffer.from(buf.subarray(2, 2 + len)) });
						buf = buf.subarray(2 + len);
					}
				});
				socket.once("close", () => resolve());
			});
			return { socket, status: head.split("\r\n")[0] ?? "", frames, closed };
		};

		const ok = await rawCoalesced(masked(0x9, Buffer.from("coal")));
		expect(ok.status).toBe("HTTP/1.1 101 Switching Protocols");
		await vi.waitFor(() => expect(ok.frames.some((f) => f.opcode === 0xa && f.payload.toString() === "coal")).toBe(true));
		ok.socket.destroy();
		await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));

		const oversized = await rawCoalesced(Buffer.alloc(200, 0x41));
		expect(oversized.status).toBe("HTTP/1.1 404 Not Found");
		await oversized.closed;
	});
});
