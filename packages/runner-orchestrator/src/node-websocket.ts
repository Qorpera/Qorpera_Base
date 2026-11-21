import { createHash, randomBytes, randomFillSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 1000;
const EMPTY_BUFFER = Buffer.alloc(0);
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });
const MASK_SCRATCH = new Uint8Array(4);
const MASK_WORD = new Uint32Array(MASK_SCRATCH.buffer);

class ReceiveQueue {
	#chunks: Buffer[] = [];
	#head = 0;
	#headOffset = 0;
	#bytes = 0;

	get byteLength(): number {
		return this.#bytes;
	}

	push(chunk: Buffer): void {
		if (chunk.byteLength === 0) return;
		this.#chunks.push(chunk);
		this.#bytes += chunk.byteLength;
	}

	peekByte(index: number): number {
		let remaining = index;
		let chunkIndex = this.#head;
		let offset = this.#headOffset;
		while (chunkIndex < this.#chunks.length) {
			const chunk = this.#chunks[chunkIndex]!;
			const available = chunk.byteLength - offset;
			if (remaining < available) return chunk[offset + remaining]!;
			remaining -= available;
			chunkIndex += 1;
			offset = 0;
		}
		throw new RangeError("ReceiveQueue index out of range");
	}

	readUInt16BE(offset: number): number {
		const head = this.#chunks[this.#head];
		if (head && this.#headOffset + offset + 2 <= head.byteLength) {
			return head.readUInt16BE(this.#headOffset + offset);
		}
		return (this.peekByte(offset) << 8) | this.peekByte(offset + 1);
	}

	readUInt32BE(offset: number): number {
		const head = this.#chunks[this.#head];
		if (head && this.#headOffset + offset + 4 <= head.byteLength) {
			return head.readUInt32BE(this.#headOffset + offset);
		}
		return (
			(((this.peekByte(offset) << 24) >>> 0) |
				(this.peekByte(offset + 1) << 16) |
				(this.peekByte(offset + 2) << 8) |
				this.peekByte(offset + 3)) >>>
			0
		);
	}

	consume(count: number): void {
		let remaining = count;
		this.#bytes -= count;
		while (remaining > 0) {
			const chunk = this.#chunks[this.#head]!;
			const available = chunk.byteLength - this.#headOffset;
			if (remaining < available) {
				this.#headOffset += remaining;
				return;
			}
			remaining -= available;
			this.#head += 1;
			this.#headOffset = 0;
		}
		this.#compact();
	}

	take(skip: number, length: number): { readonly payload: Buffer; readonly owned: boolean } {
		if (skip > 0) this.consume(skip);
		if (length === 0) return { payload: EMPTY_BUFFER, owned: true };
		const first = this.#chunks[this.#head]!;
		const available = first.byteLength - this.#headOffset;
		if (length <= available) {
			const start = this.#headOffset;
			const payload = first.subarray(start, start + length);
			this.#bytes -= length;
			if (length === available) {
				this.#head += 1;
				this.#headOffset = 0;
				this.#compact();
			} else {
				this.#headOffset += length;
			}
			return { payload, owned: false };
		}
		const out = Buffer.allocUnsafe(length);
		let written = 0;
		while (written < length) {
			const chunk = this.#chunks[this.#head]!;
			const chunkAvail = chunk.byteLength - this.#headOffset;
			const takeBytes = Math.min(length - written, chunkAvail);
			chunk.copy(out, written, this.#headOffset, this.#headOffset + takeBytes);
			written += takeBytes;
			this.#bytes -= takeBytes;
			if (takeBytes === chunkAvail) {
				this.#head += 1;
				this.#headOffset = 0;
			} else {
				this.#headOffset += takeBytes;
			}
		}
		this.#compact();
		return { payload: out, owned: true };
	}

	clear(): void {
		this.#chunks = [];
		this.#head = 0;
		this.#headOffset = 0;
		this.#bytes = 0;
	}

	#compact(): void {
		if (this.#head === this.#chunks.length) {
			this.#chunks.length = 0;
			this.#head = 0;
			this.#headOffset = 0;
		} else if (this.#head >= 32 && this.#head * 2 >= this.#chunks.length) {
			this.#chunks = this.#chunks.slice(this.#head);
			this.#head = 0;
		}
	}
}

export interface NodeWebSocketHandlers {
	/** One complete text message. */
	message(text: string): void;
	/** One complete binary message. Without this handler, binary messages are dropped. */
	binary?(payload: Buffer): void;
	/** Called once, when the connection ends for any reason. */
	close(reason: string): void;
}

export interface NodeWebSocketOptions {
	/** Connect over this Unix socket (a `ws:` URL; its host is then only the Host header). */
	readonly socketPath?: string;
	/** Stops a handshake still pending: its request is destroyed and the connect rejects at once. */
	readonly signal?: AbortSignal;
}

/** A WebSocket client (RFC 6455) on node:http and node:https. It needs no WebAssembly, so it runs under
 * `--jitless`, where Node's own WebSocket (Undici) does not. It answers pings, reassembles fragments and refuses
 * masked, reserved-bit or oversized frames from the server by closing. */
export class NodeWebSocket {
	readonly #socket: Socket;
	readonly #handlers: NodeWebSocketHandlers;
	readonly #queue = new ReceiveQueue();
	#fragments: Buffer[] = [];
	#fragmentBytes = 0;
	#fragmentOpcode = 0;
	#closeTimer: ReturnType<typeof setTimeout> | undefined;
	#closing = false;
	#closed = false;

	private constructor(socket: Socket, handlers: NodeWebSocketHandlers) {
		this.#socket = socket;
		this.#handlers = handlers;
		socket.setTimeout(0);
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => this.#receive(chunk));
		socket.on("error", (error: Error) => this.#end(`WebSocket connection failed: ${error.message}`));
		socket.once("close", () => {
			if (this.#closeTimer !== undefined) {
				clearTimeout(this.#closeTimer);
				this.#closeTimer = undefined;
			}
			this.#end("WebSocket connection closed");
		});
	}

	/** Opens `ws:` or `wss:` `url`. Rejects when the handshake is refused, fails, takes longer than `timeoutMs` or is
	 * stopped by `options.signal`. */
	static connect(
		url: URL,
		handlers: NodeWebSocketHandlers,
		timeoutMs = 10_000,
		options: NodeWebSocketOptions = {},
	): Promise<NodeWebSocket> {
		if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("WebSocket URL must use ws: or wss:");
		const secure = url.protocol === "wss:";
		if (options.socketPath !== undefined && secure) throw new Error("A Unix socket WebSocket URL must use ws:");
		const key = randomBytes(16).toString("base64");
		const { signal } = options;
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("WebSocket handshake was stopped"));
				return;
			}
			const request = (secure ? httpsRequest : httpRequest)({
				protocol: secure ? "https:" : "http:",
				...(options.socketPath === undefined
					? { hostname: url.hostname, port: url.port || (secure ? 443 : 80) }
					: { socketPath: options.socketPath, hostname: url.hostname }),
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
			// Destroying the request closes its connection; its error event then rejects.
			const stopped = (): void => {
				request.destroy(new Error("WebSocket handshake was stopped"));
			};
			signal?.addEventListener("abort", stopped, { once: true });
			const settled = (): void => signal?.removeEventListener("abort", stopped);
			request.once("upgrade", (response, socket: Socket, head: Buffer) => {
				settled();
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
				settled();
				response.resume();
				reject(new Error(`WebSocket handshake was refused (${response.statusCode ?? 0})`));
			});
			request.once("timeout", () => request.destroy(new Error("WebSocket handshake timed out")));
			request.once("error", (error) => {
				settled();
				reject(error);
			});
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

	sendBinary(payload: Buffer): void {
		if (this.#closing || this.#closed) throw new Error("WebSocket is closed");
		this.#write(0x2, payload);
	}

	/** Sends one binary message and resolves once the socket has taken it (its write buffer drained), so a long input
	 * goes no faster than the server reads it. Rejects when the connection ends first. */
	async sendBinaryDrained(payload: Buffer): Promise<void> {
		if (this.#closing || this.#closed || this.#socket.destroyed) throw new Error("WebSocket is closed");
		if (this.#write(0x2, payload)) return;
		await new Promise<void>((resolveDrained, rejectDrained) => {
			const settle = (error?: Error): void => {
				this.#socket.off("drain", drained);
				this.#socket.off("close", closed);
				if (error) rejectDrained(error);
				else resolveDrained();
			};
			const drained = (): void => settle();
			const closed = (): void => settle(new Error("WebSocket is closed"));
			this.#socket.on("drain", drained);
			this.#socket.on("close", closed);
		});
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
		if (!this.#socket.destroyed && this.#closeTimer === undefined) {
			this.#closeTimer = setTimeout(() => {
				this.#closeTimer = undefined;
				this.#socket.destroy();
			}, CLOSE_GRACE_MS);
			this.#closeTimer.unref();
		}
	}

	/** Writes one masked frame; false when the socket's write buffer is past its high-water mark. */
	#write(opcode: number, payload: Buffer): boolean {
		const length = payload.byteLength;
		randomFillSync(MASK_SCRATCH);
		const m0 = MASK_SCRATCH[0]!;
		const m1 = MASK_SCRATCH[1]!;
		const m2 = MASK_SCRATCH[2]!;
		const m3 = MASK_SCRATCH[3]!;
		if (length < 126) {
			const frame = Buffer.allocUnsafe(6 + length);
			frame[0] = 0x80 | opcode;
			frame[1] = 0x80 | length;
			frame[2] = m0;
			frame[3] = m1;
			frame[4] = m2;
			frame[5] = m3;
			for (let index = 0; index < length; index++) frame[6 + index] = payload[index]! ^ MASK_SCRATCH[index & 3]!;
			return this.#socket.write(frame);
		}
		const headerLen = length < 65_536 ? 4 : 10;
		const payloadOffset = headerLen + 4;
		// WHY: a 10-byte header + 4-byte mask places the payload at offset 14 (2 mod 4); shifting the frame 2 bytes into
		// a fresh unpooled buffer aligns the payload on a 4-byte boundary for 32-bit XOR under --jitless without copying.
		const alignPad = (4 - (payloadOffset & 3)) & 3;
		const raw = Buffer.allocUnsafeSlow(alignPad + payloadOffset + length);
		const frame = alignPad === 0 ? raw : raw.subarray(alignPad);
		frame[0] = 0x80 | opcode;
		if (headerLen === 4) {
			frame[1] = 0x80 | 126;
			frame.writeUInt16BE(length, 2);
		} else {
			frame[1] = 0x80 | 127;
			frame.writeUInt32BE(0, 2);
			frame.writeUInt32BE(length, 6);
		}
		frame[headerLen] = m0;
		frame[headerLen + 1] = m1;
		frame[headerLen + 2] = m2;
		frame[headerLen + 3] = m3;
		payload.copy(frame, payloadOffset);
		const words = new Uint32Array(raw.buffer, alignPad + payloadOffset, length >>> 2);
		const key = MASK_WORD[0]!;
		for (let index = 0; index < words.length; index++) words[index] = words[index]! ^ key;
		for (let index = words.length * 4; index < length; index++) {
			frame[payloadOffset + index] = frame[payloadOffset + index]! ^ MASK_SCRATCH[index & 3]!;
		}
		return this.#socket.write(frame);
	}

	#receive(chunk: Buffer): void {
		if (this.#closed) return;
		this.#queue.push(chunk);
		while (!this.#closed && this.#queue.byteLength >= 2) {
			const first = this.#queue.peekByte(0);
			const second = this.#queue.peekByte(1);
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
				if (this.#queue.byteLength < 4) return;
				length = this.#queue.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.#queue.byteLength < 10) return;
				if (this.#queue.readUInt32BE(2) !== 0) {
					this.#fail("WebSocket frame is too large");
					return;
				}
				length = this.#queue.readUInt32BE(6);
				offset = 10;
			}
			if (length > MAX_MESSAGE_BYTES) {
				this.#fail("WebSocket frame is too large");
				return;
			}
			if (this.#queue.byteLength < offset + length) return;
			const { payload, owned } = this.#queue.take(offset, length);
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
			let message: Buffer;
			let messageOwned = owned;
			if (this.#fragments.length === 0 && final) {
				message = payload;
			} else {
				this.#fragments.push(owned ? payload : Buffer.from(payload));
				if (!final) continue;
				message = Buffer.concat(this.#fragments, this.#fragmentBytes);
				messageOwned = true;
				this.#fragments = [];
			}
			const text = this.#fragmentOpcode === 0x1;
			this.#fragmentBytes = 0;
			if (!text) {
				if (this.#handlers.binary) this.#handlers.binary(messageOwned ? message : Buffer.from(message));
				continue;
			}
			let decoded: string;
			try {
				decoded = UTF8_FATAL_DECODER.decode(message);
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
		this.#queue.clear();
		this.#fragments = [];
		this.#fragmentBytes = 0;
		this.#handlers.close(reason);
	}
}
