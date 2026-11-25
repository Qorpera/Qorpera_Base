import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_MESSAGE_BYTES = 256 * 1024;
const CLOSE_GRACE_MS = 1_000;
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

interface WakeSocketHandlers {
	message(text: string): void;
	close(reason: string): void;
}

// WHY: Minimal RFC 6455 client over node:http/https so object-gateway and folder-service receive Realtime push wakes without extra dependencies or Undici/WASM under --jitless.
class WakeWebSocket {
	readonly #socket: Socket;
	readonly #handlers: WakeSocketHandlers;
	#buffer: Buffer = Buffer.alloc(0);
	#fragments: Buffer[] = [];
	#fragmentBytes = 0;
	#fragmentOpcode = 0;
	#closeTimer: ReturnType<typeof setTimeout> | undefined;
	#closing = false;
	#closed = false;

	private constructor(socket: Socket, handlers: WakeSocketHandlers) {
		this.#socket = socket;
		this.#handlers = handlers;
		socket.setTimeout(0);
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => this.#receive(chunk));
		socket.on("error", (error: Error) => this.#end(`WebSocket failed: ${error.message}`));
		socket.once("close", () => {
			if (this.#closeTimer) {
				clearTimeout(this.#closeTimer);
				this.#closeTimer = undefined;
			}
			this.#end("WebSocket closed");
		});
	}

	static connect(
		url: URL,
		handlers: WakeSocketHandlers,
		options: { readonly timeoutMs?: number; readonly ca?: string } = {},
	): Promise<WakeWebSocket> {
		if (url.protocol !== "wss:" && url.protocol !== "ws:") {
			return Promise.reject(new Error("WebSocket URL must use ws: or wss:"));
		}
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
				timeout: options.timeoutMs ?? 10_000,
				...(secure && options.ca !== undefined ? { ca: options.ca } : {}),
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
				const connection = new WakeWebSocket(socket, handlers);
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

	close(): void {
		if (this.#closing || this.#closed) return;
		this.#closing = true;
		try {
			this.#write(0x8, Buffer.from([0x03, 0xe8]));
		} catch {
			// WHY: Ignore close-frame write errors when the underlying socket is already gone.
		}
		this.#socket.end();
		if (!this.#socket.destroyed && !this.#closeTimer) {
			this.#closeTimer = setTimeout(() => {
				this.#closeTimer = undefined;
				this.#socket.destroy();
			}, CLOSE_GRACE_MS);
			this.#closeTimer.unref();
		}
	}

	#write(opcode: number, payload: Buffer): void {
		const length = payload.byteLength;
		const mask = randomBytes(4);
		const headerLen = length < 126 ? 2 : length < 65_536 ? 4 : 10;
		const frame = Buffer.allocUnsafe(headerLen + 4 + length);
		frame[0] = 0x80 | opcode;
		if (headerLen === 2) {
			frame[1] = 0x80 | length;
		} else if (headerLen === 4) {
			frame[1] = 0x80 | 126;
			frame.writeUInt16BE(length, 2);
		} else {
			frame[1] = 0x80 | 127;
			frame.writeUInt32BE(0, 2);
			frame.writeUInt32BE(length, 6);
		}
		mask.copy(frame, headerLen);
		for (let i = 0; i < length; i++) frame[headerLen + 4 + i] = payload[i]! ^ mask[i & 3]!;
		this.#socket.write(frame);
	}

	#receive(chunk: Buffer): void {
		if (this.#closed) return;
		this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		while (!this.#closed && this.#buffer.byteLength >= 2) {
			const first = this.#buffer[0]!;
			const second = this.#buffer[1]!;
			const final = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
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
					this.#end("WebSocket closed by server");
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
			if (this.#fragments.length === 0 && final) {
				message = payload;
			} else {
				this.#fragments.push(Buffer.from(payload));
				if (!final) continue;
				message = Buffer.concat(this.#fragments, this.#fragmentBytes);
				this.#fragments = [];
			}
			const isText = this.#fragmentOpcode === 0x1;
			this.#fragmentBytes = 0;
			if (!isText) continue;
			try {
				this.#handlers.message(UTF8_FATAL.decode(message));
			} catch {
				this.#fail("WebSocket text is not UTF-8");
				return;
			}
		}
	}

	#fail(reason: string): void {
		this.#socket.destroy();
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer = Buffer.alloc(0);
		this.#fragments = [];
		this.#fragmentBytes = 0;
		this.#handlers.close(reason);
	}
}

export interface RealtimeTopicWakeOptions {
	readonly supabaseUrl: string;
	readonly apiKey: string;
	readonly ca?: string;
	readonly heartbeatMs?: number;
	readonly connectTimeoutMs?: number;
	readonly reconnectInitialMs?: number;
	readonly reconnectMaximumMs?: number;
}

export interface RealtimeBroadcastEvent {
	readonly topic: string;
	readonly event: string;
	readonly payload: Record<string, unknown> | null;
}

// WHY: Multiplex private Supabase Realtime broadcast topics over one persistent WebSocket for object-gateway and folder-service.
export class RealtimeTopicSubscriber {
	readonly #url: URL;
	readonly #apiKey: string;
	readonly #ca: string | undefined;
	readonly #heartbeatMs: number;
	readonly #connectTimeoutMs: number;
	readonly #reconnectInitialMs: number;
	readonly #reconnectMaximumMs: number;
	readonly #topics = new Map<string, Set<(event: RealtimeBroadcastEvent | null) => void>>();
	readonly #joinRefs = new Map<string, string>();
	readonly #joined = new Set<string>();
	#socket: WakeWebSocket | undefined;
	#connecting = false;
	#stopped = false;
	#heartbeatRef: string | undefined;
	#ref = 0;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: RealtimeTopicWakeOptions) {
		const url = new URL("/realtime/v1/websocket", options.supabaseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Realtime wake requires an HTTPS project URL");
		}
		if (!options.apiKey.trim() || /[\0\r\n]/.test(options.apiKey)) {
			throw new Error("Realtime wake requires an API key");
		}
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("apikey", options.apiKey);
		url.searchParams.set("vsn", "1.0.0");
		this.#url = url;
		this.#apiKey = options.apiKey;
		this.#ca = options.ca;
		this.#heartbeatMs = options.heartbeatMs ?? 25_000;
		this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
		this.#reconnectInitialMs = options.reconnectInitialMs ?? 1_000;
		this.#reconnectMaximumMs = options.reconnectMaximumMs ?? 30_000;
	}

	subscribe(topic: string, listener: (event: RealtimeBroadcastEvent | null) => void): () => void {
		if (this.#stopped) return () => undefined;
		let listeners = this.#topics.get(topic);
		const isNewTopic = !listeners;
		if (!listeners) {
			listeners = new Set();
			this.#topics.set(topic, listeners);
		}
		listeners.add(listener);
		if (isNewTopic) {
			if (this.#socket && !this.#socket.closed) {
				this.#join(topic);
			} else if (!this.#connecting && !this.#timer) {
				void this.#connect();
			}
		}
		return () => {
			const current = this.#topics.get(topic);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) {
				this.#topics.delete(topic);
				this.#joined.delete(topic);
				this.#joinRefs.delete(topic);
				if (this.#socket && !this.#socket.closed) this.#leave(topic);
				if (this.#topics.size === 0) this.#disconnect();
			}
		};
	}

	close(): void {
		this.#stopped = true;
		this.#topics.clear();
		this.#disconnect();
	}

	#disconnect(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#heartbeatRef = undefined;
		this.#joined.clear();
		this.#joinRefs.clear();
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close();
	}

	async #connect(): Promise<void> {
		if (this.#stopped || this.#connecting || this.#topics.size === 0) return;
		this.#connecting = true;
		let socket: WakeWebSocket | undefined;
		try {
			socket = await WakeWebSocket.connect(
				this.#url,
				{
					message: (text) => {
						if (socket && socket === this.#socket) this.#message(text);
					},
					close: () => {
						if (socket && socket === this.#socket) this.#drop();
					},
				},
				{ timeoutMs: this.#connectTimeoutMs, ...(this.#ca !== undefined ? { ca: this.#ca } : {}) },
			);
		} catch {
			this.#connecting = false;
			if (!this.#stopped && this.#topics.size > 0) this.#retry();
			return;
		}
		this.#connecting = false;
		if (this.#stopped || this.#topics.size === 0 || socket.closed) {
			socket.close();
			if (!this.#stopped && this.#topics.size > 0) this.#retry();
			return;
		}
		this.#socket = socket;
		this.#heartbeatRef = undefined;
		for (const topic of this.#topics.keys()) this.#join(topic);
		if (this.#socket) this.#schedule(this.#heartbeatMs, () => this.#heartbeat());
	}

	#join(topic: string): void {
		const joinRef = this.#nextRef();
		this.#joinRefs.set(topic, joinRef);
		this.#send({
			topic: `realtime:${topic}`,
			event: "phx_join",
			payload: {
				config: {
					broadcast: { ack: false, self: false },
					presence: { key: "", enabled: false },
					postgres_changes: [],
					private: true,
				},
				...(JWT_PATTERN.test(this.#apiKey) ? { access_token: this.#apiKey } : {}),
			},
			ref: joinRef,
			join_ref: joinRef,
		});
	}

	#leave(topic: string): void {
		this.#send({ topic: `realtime:${topic}`, event: "phx_leave", payload: {}, ref: this.#nextRef() });
	}

	#heartbeat(): void {
		if (!this.#socket) return;
		if (this.#heartbeatRef !== undefined) {
			this.#drop();
			return;
		}
		this.#heartbeatRef = this.#nextRef();
		this.#send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.#heartbeatRef });
		if (this.#socket) this.#schedule(this.#heartbeatMs, () => this.#heartbeat());
	}

	#message(text: string): void {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		const frame = raw as { topic?: unknown; event?: unknown; payload?: unknown; ref?: unknown };
		if (frame.topic === "phoenix" && frame.event === "phx_reply" && frame.ref === this.#heartbeatRef) {
			this.#heartbeatRef = undefined;
			return;
		}
		if (typeof frame.topic !== "string" || !frame.topic.startsWith("realtime:")) return;
		const topic = frame.topic.slice("realtime:".length);
		const listeners = this.#topics.get(topic);
		if (!listeners) return;
		if (frame.event === "phx_reply" && frame.ref === this.#joinRefs.get(topic)) {
			const status =
				frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
					? (frame.payload as { status?: unknown }).status
					: undefined;
			if (status === "ok") {
				this.#attempt = 0;
				this.#joined.add(topic);
				this.#notify(listeners, null);
			}
			return;
		}
		if (frame.event === "phx_error" || frame.event === "phx_close") {
			this.#joined.delete(topic);
			if (this.#topics.has(topic) && this.#socket && !this.#socket.closed) this.#drop();
			return;
		}
		if (frame.event === "broadcast") {
			const envelope =
				frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
					? (frame.payload as { event?: unknown; payload?: unknown })
					: undefined;
			const eventName = typeof envelope?.event === "string" ? envelope.event : "broadcast";
			const inner =
				envelope?.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
					? (envelope.payload as Record<string, unknown>)
					: null;
			this.#notify(listeners, { topic, event: eventName, payload: inner });
		}
	}

	#notify(
		listeners: ReadonlySet<(event: RealtimeBroadcastEvent | null) => void>,
		event: RealtimeBroadcastEvent | null,
	): void {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// WHY: Isolate listener failures so one bad callback cannot drop the shared Realtime socket.
			}
		}
	}

	#drop(): void {
		const hadJoined = this.#joined.size > 0;
		this.#disconnect();
		if (hadJoined) {
			for (const listeners of this.#topics.values()) this.#notify(listeners, null);
		}
		if (!this.#stopped && this.#topics.size > 0) this.#retry();
	}

	#retry(): void {
		if (this.#stopped || this.#topics.size === 0) return;
		const delay = Math.min(this.#reconnectMaximumMs, this.#reconnectInitialMs * 2 ** Math.min(this.#attempt, 10));
		this.#attempt += 1;
		this.#schedule(delay, () => {
			void this.#connect();
		});
	}

	#send(message: Record<string, unknown>): void {
		try {
			this.#socket?.send(JSON.stringify(message));
		} catch {
			this.#drop();
		}
	}

	#schedule(ms: number, run: () => void): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			run();
		}, ms);
		this.#timer.unref();
	}

	#nextRef(): string {
		this.#ref += 1;
		return String(this.#ref);
	}
}

export interface FolderHintSource {
	watch(environmentId: string, onHint: (seq: number | null) => void): () => void;
	close?(): void;
}

// WHY: Subscribe folder-service to existing qorpera_folder_hint_internal broadcasts so idle /company mounts advance immediately instead of backing off to 5s.
export class RealtimeFolderHints implements FolderHintSource {
	readonly #subscriber: RealtimeTopicSubscriber;

	constructor(options: RealtimeTopicWakeOptions) {
		this.#subscriber = new RealtimeTopicSubscriber(options);
	}

	watch(environmentId: string, onHint: (seq: number | null) => void): () => void {
		return this.#subscriber.subscribe(`qorpera-folder-${environmentId}`, (event) => {
			if (!event) {
				onHint(null);
				return;
			}
			const rawSeq = event.payload?.seq;
			const seq = typeof rawSeq === "number" && Number.isSafeInteger(rawSeq) && rawSeq >= 0 ? rawSeq : null;
			onHint(seq);
		});
	}

	close(): void {
		this.#subscriber.close();
	}
}
