import { withTimeoutScope } from "./abort-timeout.ts";

export const DEFAULT_RPC_TIMEOUT_MS = 25_000;
export const DEFAULT_RPC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_BODY_READ_TIMEOUT_MS = 10_000;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class BodyTooLargeError extends Error {
	constructor(message = "HTTP body exceeds allowed size") {
		super(message);
		this.name = "BodyTooLargeError";
	}
}

export interface ReadBoundedBodyOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly ignoreContentLength?: boolean;
	readonly sizeErrorMessage?: string;
}

export interface TimedFetchOptions {
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly redirect?: RequestRedirect;
	readonly fetchImplementation?: typeof fetch;
}

export function preferredServiceKey(readEnv: (name: string) => string | undefined): string | undefined {
	// WHY: Legacy service-role JWTs verify locally at the gateway, while sb_secret keys depend on KMS which has shed traffic during incidents.
	const legacyServiceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
	if (legacyServiceRoleKey) return legacyServiceRoleKey;
	try {
		const parsed: unknown = JSON.parse(readEnv("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const key = Object.values(parsed).find((value): value is string => typeof value === "string" && value.length > 20);
			if (key) return key;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function constantTimeEqual(left: string, right: string): boolean {
	const leftBytes = UTF8_ENCODER.encode(left);
	const rightBytes = UTF8_ENCODER.encode(right);
	let diff = leftBytes.byteLength ^ rightBytes.byteLength;
	const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < length; index++) {
		diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return diff === 0;
}

export function constantTimeIncludes(allowed: readonly string[], candidate: string): boolean {
	let matched = false;
	for (const entry of allowed) {
		if (constantTimeEqual(entry, candidate)) matched = true;
	}
	return matched;
}

async function readStreamBounded(
	message: Request | Response,
	maxBytes: number,
	sizeErrorMessage: string,
	ignoreContentLength: boolean,
	signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
	if (!ignoreContentLength) {
		const rawLength = message.headers.get("content-length");
		if (rawLength !== null) {
			const contentLength = Number(rawLength);
			if (!Number.isFinite(contentLength) || contentLength < 0) {
				void message.body?.cancel().catch(() => undefined);
				throw new Error(sizeErrorMessage);
			}
			if (contentLength > maxBytes) {
				void message.body?.cancel().catch(() => undefined);
				throw new BodyTooLargeError(sizeErrorMessage);
			}
		}
	}
	signal?.throwIfAborted();
	const reader = message.body?.getReader();
	if (!reader) return new Uint8Array(new ArrayBuffer(0));
	const cancel = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let total = 0;
	let completed = false;
	try {
		signal?.throwIfAborted();
		for (;;) {
			const { done, value } = await reader.read();
			// WHY: Cancelling a stalled reader resolves read() with done=true; re-check signal first so abort/timeout never looks like EOF.
			signal?.throwIfAborted();
			if (done) {
				completed = true;
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				throw new BodyTooLargeError(sizeErrorMessage);
			}
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
		if (!completed) cancel();
		reader.releaseLock();
	}
	if (chunks.length === 0) return new Uint8Array(new ArrayBuffer(0));
	const merged = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

export async function readBoundedBytes(
	message: Request | Response,
	maxBytes: number,
	options?: ReadBoundedBodyOptions,
): Promise<Uint8Array<ArrayBuffer>> {
	const sizeErrorMessage = options?.sizeErrorMessage ?? "HTTP body exceeds allowed size";
	const ignoreContentLength = options?.ignoreContentLength ?? false;
	if (options?.timeoutMs !== undefined) {
		return withTimeoutScope(
			options.timeoutMs,
			(signal) => readStreamBounded(message, maxBytes, sizeErrorMessage, ignoreContentLength, signal),
			options.signal,
		);
	}
	return readStreamBounded(message, maxBytes, sizeErrorMessage, ignoreContentLength, options?.signal);
}

export async function readBoundedText(
	message: Request | Response,
	maxBytes: number,
	options?: ReadBoundedBodyOptions,
): Promise<string> {
	const bytes = await readBoundedBytes(message, maxBytes, options);
	if (bytes.byteLength === 0) return "";
	return UTF8_DECODER.decode(bytes);
}

export async function readBoundedJson(
	message: Request | Response,
	maxBytes: number,
	options?: ReadBoundedBodyOptions,
): Promise<unknown> {
	const text = await readBoundedText(message, maxBytes, options);
	return JSON.parse(text);
}

export function withAbortSignal<T>(query: T, signal?: AbortSignal): T {
	if (signal && query && typeof (query as { abortSignal?: (s: AbortSignal) => T }).abortSignal === "function") {
		return (query as { abortSignal: (s: AbortSignal) => T }).abortSignal(signal);
	}
	return query;
}

export function createTimedFetch(options?: TimedFetchOptions): typeof fetch {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
	const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_RPC_MAX_RESPONSE_BYTES;
	const redirect = options?.redirect ?? "error";
	const fetchImpl = options?.fetchImplementation ?? fetch;
	return async function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const parentSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		return withTimeoutScope(
			timeoutMs,
			async (signal) => {
				const response = await fetchImpl(input, {
					...init,
					redirect: init?.redirect ?? redirect,
					signal,
				});
				const noBody = response.status === 204 || response.status === 205 || response.status === 304 || method === "HEAD";
				if (noBody) {
					void response.body?.cancel().catch(() => undefined);
					return new Response(null, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				}
				const body = await readBoundedBytes(response, maxResponseBytes, {
					signal,
					ignoreContentLength: response.headers.has("content-encoding"),
					sizeErrorMessage: "Upstream response exceeds allowed size",
				});
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			},
			parentSignal,
		);
	};
}
