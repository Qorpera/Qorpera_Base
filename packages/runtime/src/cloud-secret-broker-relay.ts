import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { nativeEgressPublicAddress, resolveNativeHost } from "./cloud-native-egress.ts";

// The secret broker's relay (F3 5j-6b): a running coding session's request to an MCP server it has a sign-in
// for, or its fetch of its own repository from GitHub, sent on by the broker with the sign-in's header, so the
// value never leaves the broker process. Bounds per connection only (no caps on volume or duration, 5 Oct 2026):
// 10 s to resolve and connect, 30 s more to the answer's headers, then the caller's idle timeout.
const CONNECT_MS = 10_000;
const HEADERS_MS = 30_000;

/** One connection the relay opens: the checked address, the host name TLS is verified against, and the request. */
export interface CloudSecretRelayTarget {
	readonly address: string;
	readonly host: string;
	readonly port: number;
	readonly method: string;
	readonly path: string;
	/** Every header sent, `host` and the sign-in's included. */
	readonly headers: Readonly<Record<string, string>>;
}

export interface CloudSecretRelayTransport {
	resolve(host: string, signal: AbortSignal): Promise<string[]>;
	request(target: CloudSecretRelayTarget): ClientRequest;
}

/** Real DNS (IPv4 only, as the native egress), then HTTPS to the checked address with the certificate verified
 * against the host name. One connection per request, never pooled. */
export const CLOUD_SECRET_RELAY_TRANSPORT: CloudSecretRelayTransport = {
	resolve: resolveNativeHost,
	request: (target) =>
		httpsRequest({
			host: target.address,
			port: target.port,
			servername: target.host,
			family: 4,
			method: target.method,
			path: target.path,
			headers: target.headers,
			agent: false,
		}),
};

export interface CloudSecretRelayRequest {
	/** `https://host[:port]`. */
	readonly origin: string;
	readonly method: "GET" | "POST" | "DELETE";
	/** The path and query sent upstream. */
	readonly path: string;
	/** Every header sent upstream but `host`, the sign-in's included. */
	readonly headers: Readonly<Record<string, string>>;
	/** The caller's body, streamed through (POST only). */
	readonly body?: Readable;
	/** Inactivity on the upstream connection, either way, after which it ends. */
	readonly idleMs: number;
}

/**
 * Sends one request on and resolves with the answer once its headers arrive. The host is resolved once and
 * refused unless every address is public; the relay connects to the first with TLS verified against the host
 * name, so a second DNS answer cannot swap the address. Redirects are never followed: the caller decides what of
 * the answer goes back. `signal` ends the connection at any time, before or after the answer.
 */
export async function openCloudSecretRelay(
	transport: CloudSecretRelayTransport,
	request: CloudSecretRelayRequest,
	signal: AbortSignal,
): Promise<IncomingMessage> {
	const { hostname: host, port: portText } = new URL(request.origin);
	const port = portText ? Number(portText) : 443;
	const resolving = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_MS)]);
	const started = Date.now();
	const addresses = await transport.resolve(host, resolving);
	resolving.throwIfAborted();
	if (!addresses.length || addresses.length > 16 || addresses.some((address) => !nativeEgressPublicAddress(address)))
		throw new Error("Cloud secret relay address denied");
	// Resolve once and dial the checked literal, never resolve again at connect.
	const upstream = transport.request({
		address: addresses[0],
		host,
		port,
		method: request.method,
		path: request.path,
		headers: { ...request.headers, host: port === 443 ? host : `${host}:${port}` },
	});
	const end = (): void => {
		upstream.destroy(new Error("Cloud secret relay ended"));
	};
	signal.addEventListener("abort", end, { once: true });
	upstream.once("close", () => signal.removeEventListener("abort", end));
	upstream.setTimeout(request.idleMs, end);
	return await new Promise<IncomingMessage>((resolve, reject) => {
		let timer = setTimeout(end, Math.max(0, CONNECT_MS - (Date.now() - started)));
		const connected = (): void => {
			clearTimeout(timer);
			timer = setTimeout(end, HEADERS_MS);
		};
		upstream.once("socket", (socket) => {
			if (socket.connecting) socket.once("connect", connected);
			else connected();
		});
		upstream.once("response", (answer) => {
			clearTimeout(timer);
			resolve(answer);
		});
		// Kept after the answer too: a later failure only ends the connection, which ends the answer.
		upstream.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		upstream.once("close", () => {
			clearTimeout(timer);
			reject(new Error("Cloud secret relay ended"));
		});
		if (signal.aborted) end();
		else if (request.body) request.body.pipe(upstream);
		else upstream.end();
	});
}
