import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface BufferedResponse {
	readonly status: number;
	readonly body: Buffer;
}

export interface BufferedRequest {
	readonly method: "GET" | "POST";
	readonly headers: Record<string, string>;
	readonly body?: string;
}

/** The transport the core client uses. Tests give their own. */
export type Transport = (
	url: URL,
	request: BufferedRequest,
	maxBytes: number,
	signal: AbortSignal,
) => Promise<BufferedResponse>;

/** One request on node:http(s) with a buffered, bounded answer; redirects are not followed. The global `fetch`
 * needs WebAssembly, which `node --jitless` (the service unit's flag, kept for MemoryDenyWriteExecute) removes. The
 * caller decides which origins are allowed: the core client allows only its exact HTTPS origin. */
export const nodeRequest: Transport = (url, init, maxBytes, signal) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		if (url.protocol !== "https:" && url.protocol !== "http:") return reject(new Error("Only HTTP(S) is spoken"));
		const body = init.body === undefined ? undefined : Buffer.from(init.body, "utf8");
		const headers = { ...init.headers, ...(body ? { "content-length": String(body.byteLength) } : {}) };
		const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{ method: init.method, headers },
			(response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > maxBytes) response.destroy(new Error("The answer is too large"));
					else chunks.push(chunk);
				});
				response.once("error", reject);
				response.once("end", () =>
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, bytes) }),
				);
			},
		);
		const abort = (): void => {
			req.destroy(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
		req.once("error", reject);
		req.once("close", () => signal.removeEventListener("abort", abort));
		req.end(body);
	});
