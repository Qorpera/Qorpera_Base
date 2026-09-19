import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "../cloud-company-computer-contract.ts";
import { CompanyComputerWebSocketDecoder, companyComputerWebSocketFrame } from "./cloud-company-computer-rfb.ts";
import {
	assertPrivateCompanyComputerAddress,
	COMPANY_COMPUTER_VIEW_SCHEMA,
	COMPANY_COMPUTER_VIEW_TOKEN,
	readCompanyComputerViewLine,
} from "./company-computer-view-protocol.ts";

/** Endpoint comes from the authenticated cloud registry, never from model/tool arguments. */
export function parseViewerEndpoint(value: string): { host: string; port: number } {
	const match = /^(\d+\.\d+\.\d+\.\d+):([1-9]\d{0,4})$/.exec(value);
	if (!match) throw new Error("INVALID_VIEWER_ENDPOINT");
	const host = match[1];
	const port = Number(match[2]);
	assertPrivateCompanyComputerAddress(host);
	if (port > 65_535) throw new Error("INVALID_VIEWER_ENDPOINT");
	return { host, port };
}

export interface ConnectedScreenView {
	/** Paused. Remainder precedes all subsequent socket data. */
	socket: Socket;
	binding: CompanyComputerScreenBinding;
	mode: "watch" | "shared" | "control";
	remainder: Buffer;
}

/** Member-side display transport only. Reconnection requires a NEW capability and exact binding. */
export async function connectCompanyComputerScreenView(input: {
	host: string;
	port: number;
	capability: string;
	binding: CompanyComputerScreenBinding;
	mode: "watch" | "shared" | "control";
	signal: AbortSignal;
}): Promise<ConnectedScreenView> {
	assertPrivateCompanyComputerAddress(input.host);
	assertCompanyComputerScreenBinding(input.binding, input.binding);
	if (
		!Number.isSafeInteger(input.port) ||
		input.port < 1 ||
		input.port > 65_535 ||
		!COMPANY_COMPUTER_VIEW_TOKEN.test(input.capability) ||
		!["watch", "shared", "control"].includes(input.mode)
	) {
		throw new Error("INVALID_VIEW_REQUEST");
	}
	input.signal.throwIfAborted();
	const socket = connect({ host: input.host, port: input.port });
	const abort = (): void => {
		socket.destroy();
	};
	input.signal.addEventListener("abort", abort, { once: true });
	socket.once("close", () => input.signal.removeEventListener("abort", abort));
	// Keep a listener after handshake too: the bridge attaches its own teardown listener later.
	socket.on("error", abort);
	try {
		await companyComputerRequest(
			(signal) =>
				new Promise<void>((resolve, reject) => {
					const cleanup = (): void => {
						socket.off("connect", ready);
						socket.off("close", failed);
						signal.removeEventListener("abort", failed);
					};
					const ready = (): void => {
						cleanup();
						resolve();
					};
					const failed = (): void => {
						cleanup();
						reject(new Error("VIEW_UNAVAILABLE"));
					};
					socket.once("connect", ready);
					socket.once("close", failed);
					signal.addEventListener("abort", failed, { once: true });
					if (signal.aborted || socket.destroyed) failed();
				}),
			input.signal,
		);
		const reply = readCompanyComputerViewLine(socket, input.signal);
		socket.write(`${JSON.stringify({ schema: COMPANY_COMPUTER_VIEW_SCHEMA, capability: input.capability })}\n`);
		const { value, remainder } = await reply;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("VIEW_UNAVAILABLE");
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).sort().join() !== "binding,mode,ok" ||
			record.ok !== true ||
			record.mode !== input.mode ||
			!record.binding ||
			typeof record.binding !== "object"
		)
			throw new Error("VIEW_UNAVAILABLE");
		assertCompanyComputerScreenBinding(record.binding as CompanyComputerScreenBinding, input.binding);
		input.signal.throwIfAborted();
		return { socket, binding: structuredClone(input.binding), mode: input.mode, remainder };
	} catch {
		socket.destroy();
		throw new Error("VIEW_UNAVAILABLE");
	}
}

export interface LocalScreenViewBridge {
	port: number;
	url: string;
	close(): Promise<void>;
}

/**
 * Adapted from the historical noVNC bridge. Exactly one local renderer may use
 * this random URL. Cloud input authorization remains at the gateway; the app
 * neither executes agent work nor receives cloud credentials. The host must
 * supply its existing renderer allowlist and trusted renderer Origin.
 */
export async function startLocalScreenViewWebSocketBridge(
	view: ConnectedScreenView,
	options: {
		origin: string;
		registerRendererUrl: (url: string) => () => void;
		attachTimeoutMs?: number;
	},
): Promise<LocalScreenViewBridge> {
	const attachTimeoutMs = options.attachTimeoutMs ?? 10_000;
	if (
		!options.origin ||
		options.origin === "*" ||
		/[\r\n]/.test(options.origin) ||
		!Number.isSafeInteger(attachTimeoutMs) ||
		attachTimeoutMs < 1 ||
		attachTimeoutMs > 30_000 ||
		view.socket.destroyed ||
		view.remainder.length > 256 * 1024
	) {
		view.socket.destroy();
		throw new Error("INVALID_VIEW_BRIDGE");
	}
	const route = `/${randomBytes(32).toString("base64url")}`;
	let attached: Duplex | undefined;
	let port = 0;
	let closed = false;
	let unregister = (): void => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let listening: Promise<void> = Promise.resolve();
	let closing: Promise<void> | undefined;
	const server = createHttpServer((_request, response) => {
		response.writeHead(404, { "content-type": "text/plain", connection: "close" });
		response.end("Not found\n");
	});
	const close = (): Promise<void> => {
		closed = true;
		clearTimeout(timer);
		unregister();
		unregister = (): void => {};
		attached?.destroy();
		view.socket.destroy();
		closing ??= (async () => {
			await listening.catch(() => undefined);
			if (server.listening)
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				});
		})();
		return closing;
	};
	view.socket.on("error", () => {
		void close();
	});
	view.socket.on("close", () => {
		void close();
	});
	server.on("upgrade", (request, socket, head) => {
		const key = request.headers["sec-websocket-key"];
		if (
			closed ||
			attached ||
			request.method !== "GET" ||
			request.url !== route ||
			request.headers.origin !== options.origin ||
			request.headers.host !== `127.0.0.1:${port}` ||
			request.headers.upgrade?.toLowerCase() !== "websocket" ||
			!request.headers.connection
				?.toLowerCase()
				.split(/\s*,\s*/)
				.includes("upgrade") ||
			request.headers["sec-websocket-version"] !== "13" ||
			typeof key !== "string" ||
			!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
			Buffer.from(key, "base64").length !== 16
		) {
			socket.destroy();
			return;
		}
		attached = socket;
		clearTimeout(timer);
		unregister();
		unregister = (): void => {};
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const decoder = new CompanyComputerWebSocketDecoder();
		const receive = (chunk: Buffer): void => {
			try {
				for (const message of decoder.push(chunk)) {
					if (message.opcode === 8) {
						void close();
						return;
					}
					if (message.opcode === 9) socket.write(companyComputerWebSocketFrame(message.payload, 10));
					else if (message.opcode === 2 && !view.socket.write(message.payload)) socket.pause();
					if (view.socket.writableLength > 256 * 1024 || socket.writableLength > 256 * 1024)
						throw new Error("VIEW_BACKPRESSURE_LIMIT");
				}
			} catch {
				void close();
			}
		};
		socket.on("data", receive);
		socket.on("error", () => {
			void close();
		});
		socket.on("close", () => {
			void close();
		});
		view.socket.on("drain", () => {
			if (!closed) socket.resume();
		});
		socket.on("drain", () => {
			if (!closed) view.socket.resume();
		});
		view.socket.on("data", (chunk: Buffer) => {
			if (!socket.write(companyComputerWebSocketFrame(chunk))) view.socket.pause();
			if (socket.writableLength > 256 * 1024) void close();
		});
		if (head.length) receive(head);
		if (!closed && view.remainder.length) socket.write(companyComputerWebSocketFrame(view.remainder));
		if (!closed) view.socket.resume();
	});
	listening = new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	try {
		await listening;
		server.on("error", () => {
			void close();
		});
		if (closed || view.socket.destroyed) throw new Error("VIEW_UNAVAILABLE");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("VIEW_UNAVAILABLE");
		port = address.port;
		const url = `ws://127.0.0.1:${port}${route}`;
		unregister = options.registerRendererUrl(url);
		timer = setTimeout(() => {
			void close();
		}, attachTimeoutMs);
		return { port, url, close };
	} catch (error) {
		await close();
		throw error;
	}
}
