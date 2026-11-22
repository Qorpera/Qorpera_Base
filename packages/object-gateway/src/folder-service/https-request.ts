import { type ClientRequest, Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

const REUSED_RESET_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_SOCKET_CLOSED"]);

class ReusedSocketResetError extends Error {
	readonly original: unknown;

	constructor(original: unknown) {
		super("Reused keep-alive socket reset");
		this.original = original;
	}
}

function isReusedSocketReset(req: ClientRequest, error: unknown): boolean {
	if (!req.reusedSocket || !(error instanceof Error)) return false;
	return "code" in error && typeof error.code === "string" && REUSED_RESET_CODES.has(error.code);
}

export class ResponseTooLargeError extends Error {
	constructor() {
		super("The answer is too large");
		this.name = "ResponseTooLargeError";
	}
}

export interface BufferedResponse {
	readonly status: number;
	readonly body: Buffer;
}

export interface BufferedRequest {
	readonly method: "GET" | "POST";
	readonly headers: Record<string, string>;
	readonly body?: string;
}

export type Transport = (
	url: URL,
	request: BufferedRequest,
	maxBytes: number,
	signal: AbortSignal,
) => Promise<BufferedResponse>;

export interface NodeTransportOptions {
	readonly ca?: string;
}

export interface ManagedTransport {
	readonly request: Transport;
	close(): void;
}

function sendNodeRequestOnce(
	url: URL,
	init: BufferedRequest,
	maxBytes: number,
	signal: AbortSignal,
	agent: HttpAgent | HttpsAgent | false | undefined,
	ca?: string,
): Promise<BufferedResponse> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		if (url.protocol !== "https:" && url.protocol !== "http:") return reject(new Error("Only HTTP(S) is spoken"));
		const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
		const headers = { ...init.headers, ...(body ? { "content-length": String(body.byteLength) } : {}) };
		let responded = false;
		const req =
			url.protocol === "https:"
				? httpsRequest(
						url,
						{
							method: init.method,
							headers,
							...(agent !== undefined ? { agent } : {}),
							...(ca ? { ca, minVersion: "TLSv1.2" } : {}),
						},
						onResponse,
					)
				: httpRequest(url, { method: init.method, headers, ...(agent !== undefined ? { agent } : {}) }, onResponse);
		function onResponse(response: IncomingMessage): void {
			responded = true;
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on("data", (chunk: Buffer) => {
				bytes += chunk.byteLength;
				if (bytes > maxBytes) response.destroy(new ResponseTooLargeError());
				else chunks.push(chunk);
			});
			response.once("error", reject);
			response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, bytes) }));
		}
		const abort = (): void => {
			req.destroy(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
		req.once("error", (error) => {
			if (!responded && !signal.aborted && init.method === "GET" && isReusedSocketReset(req, error)) {
				reject(new ReusedSocketResetError(error));
				return;
			}
			reject(error);
		});
		req.once("close", () => signal.removeEventListener("abort", abort));
		req.end(body);
	});
}

async function sendNodeRequest(
	url: URL,
	init: BufferedRequest,
	maxBytes: number,
	signal: AbortSignal,
	httpAgent?: HttpAgent,
	httpsAgent?: HttpsAgent,
	ca?: string,
): Promise<BufferedResponse> {
	const agent = url.protocol === "https:" ? httpsAgent : httpAgent;
	try {
		return await sendNodeRequestOnce(url, init, maxBytes, signal, agent, ca);
	} catch (error) {
		// WHY: retry idempotent GET once on a fresh socket when an idle keep-alive socket was closed by the peer.
		if (!(error instanceof ReusedSocketResetError) || signal.aborted) {
			throw error instanceof ReusedSocketResetError ? error.original : error;
		}
		try {
			return await sendNodeRequestOnce(url, init, maxBytes, signal, false, ca);
		} catch (retryError) {
			throw retryError instanceof ReusedSocketResetError ? retryError.original : retryError;
		}
	}
}

export function createNodeTransport(options: NodeTransportOptions = {}): ManagedTransport {
	const ca = options.ca;
	if (ca !== undefined && !ca.includes("-----BEGIN CERTIFICATE-----"))
		throw new Error("The TLS CA certificate is invalid");
	const httpsAgent = new HttpsAgent({
		keepAlive: true,
		keepAliveMsecs: 30_000,
		maxSockets: 32,
		maxFreeSockets: 16,
		...(ca ? { ca, minVersion: "TLSv1.2" } : {}),
	});
	const httpAgent = new HttpAgent({
		keepAlive: true,
		keepAliveMsecs: 30_000,
		maxSockets: 32,
		maxFreeSockets: 16,
	});
	return {
		request: (url, init, maxBytes, signal) => sendNodeRequest(url, init, maxBytes, signal, httpAgent, httpsAgent, ca),
		close: () => {
			httpsAgent.destroy();
			httpAgent.destroy();
		},
	};
}

export const nodeRequest: Transport = (url, init, maxBytes, signal) => sendNodeRequest(url, init, maxBytes, signal);
