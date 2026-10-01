import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 1000;

export interface NodeWebSocketHandlers {
	/** One complete text message. Binary messages are dropped. */
	message(text: string): void;
	/** Called once, when the connection ends for any reason. */
	close(reason: string): void;
}

/** A text-only WebSocket client (RFC 6455) on node:http and node:https. It needs no WebAssembly, so it runs
 * under `--jitless`, where Node's own WebSocket (Undici) does not. It answers pings, reassembles fragments and
 * refuses masked, reserved-bit or oversized frames from the server by closing. */
export class NodeWebSocket {
	readonly #socket: Socket;
	readonly #handlers: NodeWebSocketHandlers;
	#buffer: Buffer = Buffer.alloc(0);
	#fragments: Buffer[] = [];
	#fragmentBytes = 0;
	#fragmentOpcode = 0;
	#closing = false;
	#closed = false;

	private constructor(socket: Socket, handlers: NodeWebSocketHandlers) {
		this.#socket = socket;
		this.#handlers = handlers;
		socket.setTimeout(0);
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => this.#receive(chunk));
		socket.on("error", (error: Error) => this.#end(`WebSocket connection failed: ${error.message}`));
		socket.once("close", () => this.#end("WebSocket connection closed"));
	}

	/** Opens `ws:` or `wss:` `url`. Rejects when the handshake is refused, fails or takes longer than `timeoutMs`. */
	static connect(url: URL, handlers: NodeWebSocketHandlers, timeoutMs = 10_000): Promise<NodeWebSocket> {
		if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("WebSocket URL must use ws: or wss:");
		const secure = url.protocol === "wss:";
		const key = randomBytes(16).toString("base64");
		return new Promise((resolve, reject) => {
			const request = (secure ? httpsRequest : httpRequest)({
				protocol: secure ? "https:" : "http:",
				hostname: url.hostname,
				port: url.port || (secure ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-key": key,
					"sec-websocket-version": "13",
				},
				timeout: timeoutMs,
			});
			request.once("upgrade", (response, socket: Socket, head: Buffer) => {
				const accept = createHash("sha1").update(`${key}${ACCEPT_GUID}`).digest("base64");
				if (
					response.statusCode !== 101 ||
					String(response.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
					response.headers["sec-websocket-accept"] !== accept
				) {
					socket.destroy();
					reject(new Error("WebSocket handshake was refused"));
					return;
				}
				const connection = new NodeWebSocket(socket, handlers);
				if (head.byteLength > 0) connection.#receive(head);
				resolve(connection);
			});
			request.once("response", (response) => {
				response.resume();
				reject(new Error(`WebSocket handshake was refused (${response.statusCode ?? 0})`));
			});
			request.once("timeout", () => request.destroy(new Error("WebSocket handshake timed out")));
			request.once("error", reject);
			request.end();
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(text: string): void {
		if (this.#closing || this.#closed) throw new Error("WebSocket is closed");
		this.#write(0x1, Buffer.from(text, "utf-8"));
	}

	/** Sends a normal close and lets the connection end; the close handler runs once it has. */
	close(): void {
		if (this.#closing || this.#closed) return;
		this.#closing = true;
		try {
			this.#write(0x8, Buffer.from([0x03, 0xe8]));
		} catch {
			// The socket is already gone; ending it below is enough.
		}
		this.#socket.end();
		setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS).unref();
	}

	#write(opcode: number, payload: Buffer): void {
		const length = payload.byteLength;
		const header = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10);
		header[0] = 0x80 | opcode;
		if (length < 126) header[1] = 0x80 | length;
		else if (length < 65_536) {
			header[1] = 0x80 | 126;
			header.writeUInt16BE(length, 2);
		} else {
			header[1] = 0x80 | 127;
			header.writeUInt32BE(0, 2);
			header.writeUInt32BE(length, 6);
		}
		const mask = randomBytes(4);
		const masked = Buffer.allocUnsafe(length);
		for (let index = 0; index < length; index++) masked[index] = payload[index]! ^ mask[index & 3]!;
		this.#socket.write(Buffer.concat([header, mask, masked]));
	}

	#receive(chunk: Buffer): void {
		this.#buffer = this.#buffer.byteLength > 0 ? Buffer.concat([this.#buffer, chunk]) : chunk;
		while (!this.#closed && this.#buffer.byteLength >= 2) {
			const first = this.#buffer[0]!;
			const second = this.#buffer[1]!;
			const final = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			// Reserved bits (no extension is negotiated) and masked server frames are protocol errors.
			if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
				this.#fail("WebSocket frame is invalid");
				return;
			}
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.#buffer.byteLength < 4) return;
				length = this.#buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.#buffer.byteLength < 10) return;
				if (this.#buffer.readUInt32BE(2) !== 0) {
					this.#fail("WebSocket frame is too large");
					return;
				}
				length = this.#buffer.readUInt32BE(6);
				offset = 10;
			}
			if (length > MAX_MESSAGE_BYTES) {
				this.#fail("WebSocket frame is too large");
				return;
			}
			if (this.#buffer.byteLength < offset + length) return;
			const payload = this.#buffer.subarray(offset, offset + length);
			this.#buffer = this.#buffer.subarray(offset + length);
			if (opcode >= 0x8) {
				if (!final || length > 125) {
					this.#fail("WebSocket control frame is invalid");
					return;
				}
				if (opcode === 0x8) {
					this.close();
					this.#end("WebSocket closed by the server");
					return;
				}
				if (opcode === 0x9) this.#write(0xa, payload);
				else if (opcode !== 0xa) {
					this.#fail("WebSocket opcode is unknown");
					return;
				}
				continue;
			}
			if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
				this.#fail("WebSocket opcode is unknown");
				return;
			}
			if ((opcode === 0x0) !== this.#fragments.length > 0) {
				this.#fail("WebSocket fragments are out of order");
				return;
			}
			if (opcode !== 0x0) this.#fragmentOpcode = opcode;
			this.#fragmentBytes += length;
			if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
				this.#fail("WebSocket message is too large");
				return;
			}
			this.#fragments.push(Buffer.from(payload));
			if (!final) continue;
			const message = Buffer.concat(this.#fragments);
			const text = this.#fragmentOpcode === 0x1;
			this.#fragments = [];
			this.#fragmentBytes = 0;
			if (!text) continue;
			let decoded: string;
			try {
				decoded = new TextDecoder("utf-8", { fatal: true }).decode(message);
			} catch {
				this.#fail("WebSocket text is not UTF-8");
				return;
			}
			this.#handlers.message(decoded);
		}
	}

	#fail(reason: string): void {
		this.#socket.destroy();
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#handlers.close(reason);
	}
}
