import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

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

function sendNodeRequest(
	url: URL,
	init: BufferedRequest,
	maxBytes: number,
	signal: AbortSignal,
	httpAgent?: HttpAgent,
	httpsAgent?: HttpsAgent,
	ca?: string,
): Promise<BufferedResponse> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		if (url.protocol !== "https:" && url.protocol !== "http:") return reject(new Error("Only HTTP(S) is spoken"));
		const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
		const headers = { ...init.headers, ...(body ? { "content-length": String(body.byteLength) } : {}) };
		const req =
			url.protocol === "https:"
				? httpsRequest(
						url,
						{
							method: init.method,
							headers,
							...(httpsAgent ? { agent: httpsAgent } : {}),
							...(ca ? { ca, minVersion: "TLSv1.2" } : {}),
						},
						onResponse,
					)
				: httpRequest(
						url,
						{ method: init.method, headers, ...(httpAgent ? { agent: httpAgent } : {}) },
						onResponse,
					);
		function onResponse(response: IncomingMessage): void {
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
		req.once("error", reject);
		req.once("close", () => signal.removeEventListener("abort", abort));
		req.end(body);
	});
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
