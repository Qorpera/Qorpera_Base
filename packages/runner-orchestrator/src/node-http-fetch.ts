import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function encodedBody(body: RequestInit["body"]): Buffer | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return Buffer.from(body, "utf-8");
	if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf-8");
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	throw new TypeError("Node HTTP transport accepts only buffered request bodies");
}

function responseHeaders(values: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(values)) {
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
		} else if (value !== undefined) {
			headers.set(name, String(value));
		}
	}
	return headers;
}

function responseStatus(status: number): number {
	return status === 0 ? 200 : status;
}

async function requestBody(input: string | URL | Request, init: RequestInit): Promise<Buffer | undefined> {
	if (init.body !== undefined && init.body !== null) return encodedBody(init.body);
	if (!(input instanceof Request) || input.method === "GET" || input.method === "HEAD") return undefined;
	return Buffer.from(await input.arrayBuffer());
}

function mergedHeaders(input: string | URL | Request, init: RequestInit): Headers {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	if (init.headers !== undefined) {
		for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
	}
	return headers;
}

async function executeRequest(
	url: URL,
	method: string,
	headers: Headers,
	body: Buffer | undefined,
	redirect: NonNullable<RequestInit["redirect"]>,
	signal: AbortSignal | null | undefined,
	redirects: number,
): Promise<Response> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("Node HTTP transport requires HTTP or HTTPS");
	}
	if (signal?.aborted) throw signal.reason;
	if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));
	return new Promise<Response>((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			action();
		};
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{ method, headers: Object.fromEntries(headers.entries()) },
			(response) => {
				const status = response.statusCode ?? 0;
				const location = response.headers.location;
				if (status >= 300 && status < 400 && location) {
					if (redirect === "error") {
						response.destroy();
						finish(() => reject(new TypeError("Node HTTP transport rejected a redirect")));
						return;
					}
					if (redirect === "follow") {
						response.destroy();
						if (redirects >= MAX_REDIRECTS) {
							finish(() => reject(new TypeError("Node HTTP transport exceeded its redirect limit")));
							return;
						}
						const nextUrl = new URL(location, url);
						const nextHeaders = new Headers(headers);
						if (nextUrl.origin !== url.origin) {
							nextHeaders.delete("authorization");
							nextHeaders.delete("cookie");
							nextHeaders.delete("apikey");
						}
						const switchToGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
						if (switchToGet) {
							nextHeaders.delete("content-length");
							nextHeaders.delete("content-type");
						}
						void executeRequest(
							nextUrl,
							switchToGet ? "GET" : method,
							nextHeaders,
							switchToGet ? undefined : body,
							redirect,
							signal,
							redirects + 1,
						).then(
							(value) => finish(() => resolve(value)),
							(error: unknown) => finish(() => reject(error)),
						);
						return;
					}
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer | string) => {
					const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					bytes += encoded.byteLength;
					if (bytes > MAX_RESPONSE_BYTES) {
						response.destroy(new Error("Node HTTP transport response exceeded its byte limit"));
						return;
					}
					chunks.push(encoded);
				});
				response.once("error", (error) => finish(() => reject(error)));
				response.once("end", () =>
					finish(() =>
						resolve(
							new Response(Buffer.concat(chunks), {
								status: responseStatus(status),
								statusText: response.statusMessage,
								headers: responseHeaders(response.headers),
							}),
						),
					),
				);
			},
		);
		const abort = (): void => {
			request.destroy(signal?.reason ?? new Error("Node HTTP transport aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		request.once("error", (error) => finish(() => reject(error)));
		if (body) request.write(body);
		request.end();
	});
}

/**
 * Buffered Node HTTP transport for hardened `--jitless` services. Node 22's
 * built-in fetch lazily requires WebAssembly, which V8 deliberately hides in
 * jitless mode. This narrow transport preserves the no-JIT/MDWE boundary.
 */
export const nodeHttpFetch: typeof fetch = async (input, init = {}) => {
	const url = new URL(input instanceof Request ? input.url : input);
	const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const headers = mergedHeaders(input, init);
	const body = await requestBody(input, init);
	return executeRequest(url, method, headers, body, init.redirect ?? "follow", init.signal, 0);
};
