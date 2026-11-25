import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { type AddressInfo, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { encodeJson, type Frame, FrameReader, Kind } from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { type RealtimeBroadcastEvent, RealtimeFolderHints, RealtimeTopicSubscriber } from "../src/realtime-wake.ts";
import { BRIDGE, ENV, FakeCore, grants, PASS, storeFile } from "./folder-service-fixtures.ts";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

function encodeServerTextFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const header =
		payload.byteLength < 126
			? Buffer.from([0x81, payload.byteLength])
			: Buffer.from([0x81, 126, (payload.byteLength >> 8) & 0xff, payload.byteLength & 0xff]);
	return Buffer.concat([header, payload]);
}

function decodeClientFrames(state: { buffer: Buffer }, chunk: Buffer): string[] {
	state.buffer = state.buffer.byteLength === 0 ? chunk : Buffer.concat([state.buffer, chunk]);
	const messages: string[] = [];
	while (state.buffer.byteLength >= 2) {
		const opcode = state.buffer[0]! & 0x0f;
		const masked = (state.buffer[1]! & 0x80) !== 0;
		let length = state.buffer[1]! & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (state.buffer.byteLength < 4) break;
			length = state.buffer.readUInt16BE(2);
			offset = 4;
		}
		const maskLen = masked ? 4 : 0;
		if (state.buffer.byteLength < offset + maskLen + length) break;
		const mask = masked ? state.buffer.subarray(offset, offset + 4) : undefined;
		const payload = Buffer.from(state.buffer.subarray(offset + maskLen, offset + maskLen + length));
		state.buffer = state.buffer.subarray(offset + maskLen + length);
		if (mask) {
			for (let i = 0; i < payload.byteLength; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
		}
		if (opcode === 0x1) messages.push(payload.toString("utf8"));
	}
	return messages;
}

interface FakeRealtimeServer {
	readonly url: string;
	readonly received: Record<string, unknown>[];
	readonly sockets: Set<Socket>;
	broadcast(topic: string, event: string, payload: Record<string, unknown>): void;
	dropAll(): void;
}

async function startFakeRealtimeServer(): Promise<FakeRealtimeServer> {
	const received: Record<string, unknown>[] = [];
	const sockets = new Set<Socket>();
	const server = createHttpServer();
	server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string") {
			socket.destroy();
			return;
		}
		const accept = createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		sockets.add(socket);
		const frameState = { buffer: Buffer.alloc(0) };
		socket.on("data", (chunk: Buffer) => {
			for (const text of decodeClientFrames(frameState, chunk)) {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				received.push(parsed);
				if (parsed.event === "phx_join") {
					socket.write(
						encodeServerTextFrame(
							JSON.stringify({
								topic: parsed.topic,
								event: "phx_reply",
								ref: parsed.ref,
								payload: { status: "ok", response: {} },
							}),
						),
					);
				} else if (parsed.event === "heartbeat") {
					socket.write(
						encodeServerTextFrame(
							JSON.stringify({
								topic: "phoenix",
								event: "phx_reply",
								ref: parsed.ref,
								payload: { status: "ok", response: {} },
							}),
						),
					);
				}
			}
		});
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	);
	return {
		url: `http://127.0.0.1:${port}`,
		received,
		sockets,
		broadcast(topic, event, payload) {
			const frame = encodeServerTextFrame(
				JSON.stringify({
					topic: `realtime:${topic}`,
					event: "broadcast",
					payload: { event, payload },
				}),
			);
			for (const socket of sockets) socket.write(frame);
		},
		dropAll() {
			for (const socket of sockets) socket.destroy();
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

class FeedClient {
	readonly #socket: Socket;
	readonly #reader = new FrameReader();
	readonly #frames: Frame[] = [];
	readonly #waiters: ((frame: Frame | undefined) => void)[] = [];

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (data: Buffer) => {
			for (const frame of this.#reader.push(data)) {
				const waiter = this.#waiters.shift();
				if (waiter) waiter(frame);
				else this.#frames.push(frame);
			}
		});
		socket.on("close", () => {
			for (const waiter of this.#waiters.splice(0)) waiter(undefined);
		});
	}

	static async open(path: string): Promise<FeedClient> {
		const socket = connect(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		cleanup.push(() => {
			socket.destroy();
		});
		return new FeedClient(socket);
	}

	send(kind: number, body: unknown): void {
		this.#socket.write(encodeJson(kind, body));
	}

	async next(): Promise<Frame | undefined> {
		const queued = this.#frames.shift();
		if (queued) return queued;
		return await new Promise<Frame | undefined>((resolve) => this.#waiters.push(resolve));
	}

	async json(): Promise<{ kind: number; body: Record<string, unknown> }> {
		const frame = await this.next();
		if (!frame) throw new Error("closed");
		return { kind: frame.kind, body: JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown> };
	}
}

describe("RealtimeTopicSubscriber and RealtimeFolderHints", () => {
	it("joins private topics, dispatches broadcasts, reconnects after drops, and leaves on unsubscribe", async () => {
		const realtime = await startFakeRealtimeServer();
		const subscriber = new RealtimeTopicSubscriber({
			supabaseUrl: realtime.url,
			apiKey: "sb_secret_test",
			reconnectInitialMs: 25,
			reconnectMaximumMs: 50,
		});
		cleanup.push(() => subscriber.close());

		const events: Array<RealtimeBroadcastEvent | null> = [];
		const unsub = subscriber.subscribe("qorpera-object-gateway-wake", (event) => events.push(event));
		await waitFor(() => events.length >= 1);
		expect(events[0]).toBeNull();
		expect(realtime.received[0]).toMatchObject({
			topic: "realtime:qorpera-object-gateway-wake",
			event: "phx_join",
			payload: { config: { private: true } },
		});

		realtime.broadcast("qorpera-object-gateway-wake", "wake", {
			schema: "qorpera.object-gateway-wake/v1",
			kind: "company_creation",
		});
		await waitFor(() => events.length >= 2);
		expect(events[1]).toEqual({
			topic: "qorpera-object-gateway-wake",
			event: "wake",
			payload: { schema: "qorpera.object-gateway-wake/v1", kind: "company_creation" },
		});

		realtime.dropAll();
		await waitFor(() => realtime.received.filter((msg) => msg.event === "phx_join").length >= 2);
		await waitFor(() => events.length >= 4);
		expect(events[2]).toBeNull();
		expect(events[3]).toBeNull();

		unsub();
		await waitFor(() => realtime.received.some((msg) => msg.event === "phx_leave"));
	});

	it("wakes an idle FolderService mount immediately on a Realtime folder hint without waiting for pollMs", async () => {
		const realtime = await startFakeRealtimeServer();
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-hints-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const core = new FakeCore();
		core.seed([await storeFile(dir, "notes/hello.txt", "initial", 1)]);
		const hints = new RealtimeFolderHints({
			supabaseUrl: realtime.url,
			apiKey: "sb_secret_test",
			reconnectInitialMs: 25,
		});
		const service = new FolderService({
			core,
			objects: new NasObjects({ root: dir, cacheBytes: 1024 * 1024 }),
			grants: grants(),
			hints,
			pollMs: 60_000,
			log: () => undefined,
		});
		const server: Server = createFolderServer(service, () => undefined);
		const socketPath = join(dir, "service.sock");
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		cleanup.push(() => service.stop());

		const feed = await FeedClient.open(socketPath);
		feed.send(Kind.bridge, BRIDGE);
		feed.send(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "feed" });
		const welcome = await feed.json();
		expect(welcome.kind).toBe(Kind.helloOk);
		const io = await FeedClient.open(socketPath);
		io.send(Kind.bridge, BRIDGE);
		io.send(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" });
		expect((await io.json()).kind).toBe(Kind.helloOk);

		await waitFor(() =>
			realtime.received.some((msg) => msg.topic === `realtime:qorpera-folder-${ENV}` && msg.event === "phx_join"),
		);

		core.write(await storeFile(dir, "notes/pushed.txt", "updated", 2));

		const pushedPromise = feed.json();
		realtime.broadcast(`qorpera-folder-${ENV}`, "folder", {
			schema: "qorpera.folder-hint/v1",
			seq: core.seq,
		});
		const pushed = await Promise.race([
			pushedPromise,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Timed out waiting for feed push")), 2_000),
			),
		]);
		expect(pushed).toEqual({ kind: Kind.change, body: { seq: 1, resync: false, paths: ["notes/pushed.txt"] } });
	});
});
