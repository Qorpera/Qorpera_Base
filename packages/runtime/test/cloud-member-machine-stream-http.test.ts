import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLOUD_MEMBER_MACHINE_STREAM_PROTOCOL,
	CloudMemberMachineStreamListener,
	type CloudMemberMachineStreamRun,
	cloudMemberMachineStreamClose,
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
	change: { path?: string; headers?: Record<string, string | undefined>; method?: string } = {},
): Promise<{
	socket: Socket;
	status: string;
	head: string;
	frames: { opcode: number; payload: Buffer }[];
	closed: Promise<void>;
}> {
	const socket = connect(port, "127.0.0.1");
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
			// A message handed on as the pieces it was read in (a desktop's instance's, never joined): one message.
			await sink.send([big.subarray(0, 3), big.subarray(3, 65_536), big.subarray(65_536)]);
			return new Promise<string>((resolve) => {
				resolveRun = resolve;
			});
		});
		const one = await open(port);
		one.socket.write(masked(0x9, Buffer.from("hi")));
		await vi.waitFor(() => expect(one.frames.map((f) => f.opcode)).toEqual([0x2, 0x2, 0x2, 0xa]));
		expect(one.frames[0]!.payload).toEqual(Buffer.from([1, 0, 64, 0, 40]));
		expect(one.frames[1]!.payload.equals(big)).toBe(true);
		expect(one.frames[2]!.payload.equals(big)).toBe(true);
		expect(one.frames[3]!.payload.toString()).toBe("hi");
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
});
