import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** An unmasked server frame. */
export function serverFrame(opcode: number, payload: Buffer, final = true, masked = false): Buffer {
	const length = payload.byteLength;
	const header = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10);
	header[0] = (final ? 0x80 : 0) | opcode;
	const maskBit = masked ? 0x80 : 0;
	if (length < 126) header[1] = maskBit | length;
	else if (length < 65_536) {
		header[1] = maskBit | 126;
		header.writeUInt16BE(length, 2);
	} else {
		header[1] = maskBit | 127;
		header.writeUInt32BE(0, 2);
		header.writeUInt32BE(length, 6);
	}
	return masked ? Buffer.concat([header, Buffer.alloc(4), payload]) : Buffer.concat([header, payload]);
}

interface Connection {
	socket: Socket;
	topics: Set<string>;
	buffer: Buffer;
}

/** A Supabase Realtime (Phoenix v1 JSON) endpoint on a plain local WebSocket, for the orchestrator's wake-ups:
 * it answers joins, leaves and heartbeats, and broadcasts wake events to the connections joined to a topic. */
export class FakeRealtime {
	readonly joins: Array<{ topic: string; payload: Record<string, unknown> }> = [];
	readonly leaves: string[] = [];
	readonly apikeys: string[] = [];
	readonly messages: string[] = [];
	readonly pongs: Buffer[] = [];
	readonly closes: number[] = [];
	connections = 0;
	refuseJoins = false;
	answerHeartbeats = true;
	readonly #open = new Set<Connection>();
	#server?: Server;
	url = "";

	async start(): Promise<string> {
		const server = createServer((_request, response) => response.writeHead(404).end());
		server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) =>
			this.#upgrade(request, socket, head),
		);
		this.#server = server;
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("fake Realtime address is unavailable");
		this.url = `http://127.0.0.1:${address.port}`;
		return this.url;
	}

	async close(): Promise<void> {
		this.dropAll();
		const server = this.#server;
		this.#server = undefined;
		if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}

	get openConnections(): number {
		return this.#open.size;
	}

	/** Broadcasts a database wake-up to every connection joined to `topic`; returns how many received it. */
	wake(topic: string): number {
		let delivered = 0;
		for (const connection of this.#open) {
			if (!connection.topics.has(topic)) continue;
			this.#send(connection, {
				topic: `realtime:${topic}`,
				event: "broadcast",
				payload: { type: "broadcast", event: "wake", payload: { schema: "qorpera.orchestrator-wake/v1" } },
				ref: null,
			});
			delivered++;
		}
		return delivered;
	}

	/** Writes raw bytes to every open connection. */
	sendRaw(bytes: Buffer): void {
		for (const connection of this.#open) connection.socket.write(bytes);
	}

	dropAll(): void {
		for (const connection of this.#open) connection.socket.destroy();
		this.#open.clear();
	}

	#upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const url = new URL(request.url ?? "/", "http://fake");
		const key = request.headers["sec-websocket-key"];
		if (url.pathname !== "/realtime/v1/websocket" || typeof key !== "string") {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		this.apikeys.push(url.searchParams.get("apikey") ?? "");
		const accept = createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		this.connections++;
		const connection: Connection = { socket, topics: new Set(), buffer: Buffer.alloc(0) };
		this.#open.add(connection);
		socket.on("data", (chunk: Buffer) => this.#receive(connection, chunk));
		socket.on("close", () => this.#open.delete(connection));
		socket.on("error", () => this.#open.delete(connection));
		if (head.byteLength > 0) this.#receive(connection, head);
	}

	#receive(connection: Connection, chunk: Buffer): void {
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		for (;;) {
			const buffer = connection.buffer;
			if (buffer.byteLength < 2) return;
			const opcode = buffer[0]! & 0x0f;
			if ((buffer[1]! & 0x80) === 0) throw new Error("client frames must be masked");
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
			for (let index = 0; index < payload.byteLength; index++) payload[index] = payload[index]! ^ mask[index & 3]!;
			connection.buffer = buffer.subarray(offset + 4 + length);
			if (opcode === 0x1) this.#message(connection, payload.toString("utf-8"));
			else if (opcode === 0xa) this.pongs.push(payload);
			else if (opcode === 0x8) {
				this.closes.push(payload.byteLength >= 2 ? payload.readUInt16BE(0) : 0);
				connection.socket.end(serverFrame(0x8, payload));
				this.#open.delete(connection);
				return;
			}
		}
	}

	#message(connection: Connection, text: string): void {
		this.messages.push(text);
		const message = JSON.parse(text) as {
			topic: string;
			event: string;
			payload: Record<string, unknown>;
			ref: string;
		};
		const topic = message.topic.startsWith("realtime:") ? message.topic.slice("realtime:".length) : message.topic;
		if (message.event === "phx_join") {
			this.joins.push({ topic, payload: message.payload });
			if (this.refuseJoins) {
				this.#reply(connection, message, "error", {
					reason: "Unauthorized: You do not have permissions to read from this Channel topic",
				});
				return;
			}
			connection.topics.add(topic);
			this.#reply(connection, message, "ok", { postgres_changes: [] });
		} else if (message.event === "phx_leave") {
			this.leaves.push(topic);
			connection.topics.delete(topic);
			this.#reply(connection, message, "ok", {});
		} else if (message.event === "heartbeat" && this.answerHeartbeats) {
			this.#reply(connection, message, "ok", {});
		}
	}

	#reply(
		connection: Connection,
		message: { topic: string; ref: string },
		status: string,
		response: Record<string, unknown>,
	): void {
		this.#send(connection, {
			topic: message.topic,
			event: "phx_reply",
			payload: { status, response },
			ref: message.ref,
		});
	}

	#send(connection: Connection, message: Record<string, unknown>): void {
		connection.socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(message), "utf-8")));
	}
}
