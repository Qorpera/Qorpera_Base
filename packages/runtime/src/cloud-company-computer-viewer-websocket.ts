import { createHash } from "node:crypto";
import { createServer } from "node:https";
import { Duplex } from "node:stream";
import {
	CompanyComputerWebSocketDecoder,
	companyComputerWebSocketFrame,
} from "@qorpera/cloud-client/node/cloud-company-computer-rfb";
import type { CompanyComputerViewerRefusalObserver } from "./cloud-company-computer-diagnostics.ts";
import {
	type CompanyComputerViewerAuthority,
	CompanyComputerViewerConnections,
	type CompanyComputerViewerGuestTransport,
} from "./cloud-company-computer-viewer-gateway.ts";

/** Binary WebSocket -> existing bounded viewer protocol. The first binary
 * message carries the one-time ticket handshake; no ticket appears in a URL,
 * access log, cookie, subprotocol or renderer DOM. The same server-side RFB
 * input and clipboard filtering applies to both desktop and web transports. */
class ViewerWebSocket extends Duplex {
	readonly #socket: Duplex;
	readonly #decoder = new CompanyComputerWebSocketDecoder();

	constructor(socket: Duplex) {
		super({ readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 });
		this.#socket = socket;
		socket.pause();
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.on("error", () => this.destroy());
		socket.on("close", () => this.destroy());
		socket.on("end", () => {
			this.push(null);
		});
	}

	receive(chunk: Buffer): void {
		try {
			for (const message of this.#decoder.push(chunk)) {
				if (this.destroyed) return;
				if (message.opcode === 8) {
					this.destroy();
					return;
				}
				if (message.opcode === 9) this.#socket.write(companyComputerWebSocketFrame(message.payload, 10));
				else if (message.opcode === 2 && !this.push(message.payload)) this.#socket.pause();
				if (this.readableLength > 256 * 1024 || this.#socket.writableLength > 256 * 1024)
					throw new Error("VIEWER_BACKPRESSURE_LIMIT");
			}
		} catch {
			this.destroy();
		}
	}

	override _read(): void {
		this.#socket.resume();
	}
	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		if (this.#socket.destroyed || chunk.length > 256 * 1024 || this.#socket.writableLength > 256 * 1024) {
			callback(new Error("VIEWER_TRANSPORT_UNAVAILABLE"));
			return;
		}
		this.#socket.write(companyComputerWebSocketFrame(chunk), callback);
	}
	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.#socket.destroy();
		callback(error);
	}
}

/** TLS is mandatory, including local acceptance. Certificates come from host
 * configuration. Private guest sockets and service credentials never reach a
 * client. This listener does not terminate TLS through an untrusted proxy. */
export async function startCompanyComputerViewerWebSocketGateway(options: {
	host: string;
	port: number;
	path: string;
	origins: readonly string[];
	tls: { cert: Buffer; key: Buffer };
	authority: CompanyComputerViewerAuthority;
	guest: CompanyComputerViewerGuestTransport;
	/** Service owner stops sibling listeners and physical resources. */
	onFailure?: () => void;
	/** Journal-only reason for each refused or ended viewer; never reaches the client. */
	onRefusal?: CompanyComputerViewerRefusalObserver;
}): Promise<{ port: number; connections: CompanyComputerViewerConnections; close(): Promise<void> }> {
	if (
		!options.host ||
		/[\s/]/.test(options.host) ||
		!Number.isSafeInteger(options.port) ||
		options.port < 0 ||
		options.port > 65535 ||
		!/^\/office\/[0-9a-f-]{36}\/view$/.test(options.path) ||
		!options.tls.cert.length ||
		!options.tls.key.length ||
		options.origins.length < 1 ||
		options.origins.length > 16 ||
		options.origins.some((origin) => {
			try {
				const url = new URL(origin);
				return url.protocol !== "https:" || url.origin !== origin;
			} catch {
				return true;
			}
		})
	)
		throw new Error("INVALID_VIEWER_TLS_CONFIGURATION");
	const origins = new Set(options.origins);
	const connections = new CompanyComputerViewerConnections(options);
	const sockets = new Set<Duplex>();
	let closed = false;
	const server = createServer(
		{ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.3", handshakeTimeout: 5000 },
		(_request, response) => {
			response.writeHead(404, { "cache-control": "no-store", connection: "close" });
			response.end();
		},
	);
	server.maxConnections = 64;
	server.maxHeadersCount = 32;
	server.headersTimeout = 5000;
	server.requestTimeout = 10000;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("tlsClientError", (_error, socket) => socket.destroy());
	server.on("upgrade", (request, socket, head) => {
		const key = request.headers["sec-websocket-key"];
		// Which fixed check refused, for the journal only. Nothing the client sent is recorded.
		const refusal = closed
			? "VIEWER_UPGRADE_CLOSED"
			: request.method !== "GET" || request.url !== options.path
				? "VIEWER_UPGRADE_PATH"
				: typeof request.headers.origin !== "string" || !origins.has(request.headers.origin)
					? "VIEWER_UPGRADE_ORIGIN"
					: "VIEWER_UPGRADE_INVALID";
		if (
			closed ||
			request.method !== "GET" ||
			request.url !== options.path ||
			typeof request.headers.origin !== "string" ||
			!origins.has(request.headers.origin) ||
			request.headers.upgrade?.toLowerCase() !== "websocket" ||
			request.headers["sec-websocket-version"] !== "13" ||
			!request.headers.connection
				?.toLowerCase()
				.split(/\s*,\s*/)
				.includes("upgrade") ||
			request.headers["sec-websocket-protocol"] !== undefined ||
			typeof key !== "string" ||
			!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
			Buffer.from(key, "base64").toString("base64") !== key
		) {
			connections.refused("upgrade", new Error(refusal));
			socket.destroy();
			return;
		}
		// RFB input and update requests are tiny writes; Nagle would hold them.
		if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const channel = new ViewerWebSocket(socket);
		void connections.serve(channel);
		if (head.length) channel.receive(head);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", () => {
		closed = true;
		for (const socket of sockets) socket.destroy();
		options.onFailure?.();
		void connections.close().catch(() => undefined);
	});
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : options.port,
		connections,
		close: async () => {
			closed = true;
			const closing = new Promise<void>((resolve) => server.close(() => resolve()));
			for (const socket of sockets) socket.destroy();
			try {
				await connections.close();
			} finally {
				await closing;
			}
		},
	};
}
