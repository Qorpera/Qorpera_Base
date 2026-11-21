import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeWebSocket } from "../src/node-websocket.ts";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeServerFrame(opcode: number, payload: Buffer, fin = true): Buffer {
	const len = payload.byteLength;
	const header = Buffer.alloc(len < 126 ? 2 : len < 65_536 ? 4 : 10);
	header[0] = (fin ? 0x80 : 0) | opcode;
	if (len < 126) {
		header[1] = len;
	} else if (len < 65_536) {
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header[1] = 127;
		header.writeUInt32BE(0, 2);
		header.writeUInt32BE(len, 6);
	}
	return Buffer.concat([header, payload]);
}

function decodeMaskedClientFrames(buffer: Buffer): {
	frames: Array<{ opcode: number; payload: Buffer }>;
	rest: Buffer;
} {
	const frames: Array<{ opcode: number; payload: Buffer }> = [];
	let offset = 0;
	while (buffer.byteLength - offset >= 2) {
		const first = buffer[offset]!;
		const second = buffer[offset + 1]!;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		expect(masked).toBe(true);
		let len = second & 0x7f;
		let headerEnd = offset + 2;
		if (len === 126) {
			if (buffer.byteLength - offset < 4) break;
			len = buffer.readUInt16BE(offset + 2);
			headerEnd = offset + 4;
		} else if (len === 127) {
			if (buffer.byteLength - offset < 10) break;
			len = buffer.readUInt32BE(offset + 6);
			headerEnd = offset + 10;
		}
		if (buffer.byteLength < headerEnd + 4 + len) break;
		const mask = buffer.subarray(headerEnd, headerEnd + 4);
		const payload = Buffer.allocUnsafe(len);
		for (let i = 0; i < len; i += 1) {
			payload[i] = buffer[headerEnd + 4 + i]! ^ mask[i & 3]!;
		}
		frames.push({ opcode, payload });
		offset = headerEnd + 4 + len;
	}
	return { frames, rest: buffer.subarray(offset) };
}

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const stop of servers.splice(0)) await stop();
});

async function startWsServer(onConnection: (socket: Socket) => void): Promise<URL> {
	const sockets = new Set<Socket>();
	const server = createServer((_req, res) => {
		res.writeHead(426).end();
	});
	server.on("upgrade", (req, socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		const key = String(req.headers["sec-websocket-key"] ?? "");
		const accept = createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		onConnection(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	servers.push(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	);
	const address = server.address() as AddressInfo;
	return new URL(`ws://127.0.0.1:${address.port}/ws`);
}

describe("NodeWebSocket framing and close cleanup", () => {
	it("masks outbound frames accurately across 2-byte, 4-byte, and 10-byte header lengths", async () => {
		const received: Array<{ opcode: number; payload: Buffer }> = [];
		let rest: Buffer = Buffer.alloc(0);
		let serverSocket: Socket | undefined;
		const url = await startWsServer((socket) => {
			serverSocket = socket;
			socket.on("data", (chunk: Buffer) => {
				const parsed = decodeMaskedClientFrames(Buffer.concat([rest, chunk]));
				rest = parsed.rest;
				received.push(...parsed.frames);
			});
		});
		const ws = await NodeWebSocket.connect(url, {
			message: () => undefined,
			close: () => undefined,
		});
		const small = randomBytes(53);
		const medium = randomBytes(1027);
		const large = randomBytes(70_003);
		ws.sendBinary(small);
		ws.sendBinary(medium);
		await ws.sendBinaryDrained(large);
		await vi.waitFor(() => expect(received.filter((f) => f.opcode === 0x2)).toHaveLength(3), { timeout: 3000 });
		const binaryFrames = received.filter((f) => f.opcode === 0x2);
		expect(binaryFrames[0]!.payload.equals(small)).toBe(true);
		expect(binaryFrames[1]!.payload.equals(medium)).toBe(true);
		expect(binaryFrames[2]!.payload.equals(large)).toBe(true);
		ws.close();
		serverSocket?.destroy();
	});

	it("reassembles inbound frames split across tiny TCP segments and fragmented frames without corruption", async () => {
		const texts: string[] = [];
		const binaries: Buffer[] = [];
		let closedReason = "";
		const largePayload = randomBytes(72_005);
		const unicodeText = `${"på maskinen æøå ".repeat(200)}end`;
		const url = await startWsServer((socket) => {
			const frames = Buffer.concat([
				encodeServerFrame(0x2, largePayload),
				encodeServerFrame(0x1, Buffer.from(unicodeText, "utf8")),
				encodeServerFrame(0x1, Buffer.from("part-1-", "utf8"), false),
				encodeServerFrame(0x0, Buffer.from("part-2", "utf8"), true),
			]);
			let pos = 0;
			const step = () => {
				if (pos >= frames.byteLength) return;
				const sliceLen = pos < 32 ? 1 : pos < 256 ? 7 : 4096;
				socket.write(frames.subarray(pos, pos + sliceLen));
				pos += sliceLen;
				setImmediate(step);
			};
			step();
		});
		const ws = await NodeWebSocket.connect(url, {
			message: (text) => texts.push(text),
			binary: (payload) => binaries.push(payload),
			close: (reason) => {
				closedReason = reason;
			},
		});
		await vi.waitFor(() => expect(texts).toHaveLength(2), { timeout: 5000 });
		expect(binaries).toHaveLength(1);
		expect(binaries[0]!.equals(largePayload)).toBe(true);
		expect(texts[0]).toBe(unicodeText);
		expect(texts[1]).toBe("part-1-part-2");
		ws.close();
		await vi.waitFor(() => expect(closedReason).not.toBe(""), { timeout: 3000 });
	});

	it("clears the close grace timer once the socket finishes closing", async () => {
		const activeTimers = new Set<ReturnType<typeof setTimeout>>();
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const timer = realSetTimeout(...args);
			activeTimers.add(timer);
			return timer;
		}) as typeof setTimeout);
		const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
			timer: ReturnType<typeof setTimeout>,
		) => {
			activeTimers.delete(timer);
			return realClearTimeout(timer);
		}) as typeof clearTimeout);
		try {
			const url = await startWsServer((socket) => {
				socket.on("end", () => socket.end());
			});
			let closed = false;
			const ws = await NodeWebSocket.connect(url, {
				message: () => undefined,
				close: () => {
					closed = true;
				},
			});
			activeTimers.clear();
			ws.close();
			await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
			expect(activeTimers.size).toBe(0);
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});
});
