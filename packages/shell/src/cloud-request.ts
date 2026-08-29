/** Modern Supabase secret keys authenticate through apikey, not a JWT bearer. */
export function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3)
		headers.authorization = `Bearer ${serviceKey}`;
	return headers;
}

export class CloudRequestTimeoutError extends Error {
	constructor() {
		super("Cloud service did not respond before the request deadline. Retry when the service recovers.");
		this.name = "CloudRequestTimeoutError";
	}
}

/** Bounds the entire operation, including token acquisition and response bodies. */
export async function withCloudDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
		throw new Error("Cloud request deadline is invalid");
	}
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	combined.throwIfAborted();
	let rejectAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectAbort = () => reject(combined.reason);
		combined.addEventListener("abort", rejectAbort, { once: true });
	});
	const timer = setTimeout(() => controller.abort(new CloudRequestTimeoutError()), timeoutMs);
	try {
		return await Promise.race([
			Promise.resolve().then(() => {
				combined.throwIfAborted();
				return operation(combined);
			}),
			cancelled,
		]);
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		clearTimeout(timer);
		combined.removeEventListener("abort", rejectAbort);
	}
}

/** Stream a finite response under a caller-owned deadline; never buffer an
 * unbounded body before checking its size. Cancellation does not await a
 * remote stream's cleanup, and no response bytes are included in errors. */
export async function readBoundedCloudResponse(
	response: Response,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 128 * 1024 * 1024)
		throw new Error("Cloud response byte limit is invalid");
	const declared = response.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error("Cloud response exceeds its byte limit");
	}
	const reader = response.body?.getReader();
	if (!reader) {
		signal.throwIfAborted();
		return new Uint8Array();
	}
	const cancel = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > maximumBytes) throw new Error("Cloud response exceeds its byte limit");
			chunks.push(next.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

export type CloudDependency = "auth" | "api" | "storage";
export type CloudDependencyStatus = "unknown" | "healthy" | "unavailable";
export type CloudAvailabilitySnapshot = Record<CloudDependency, CloudDependencyStatus>;

/** Supabase HTTP endpoints used here are finite JSON/blob responses, not SSE. */
export function boundedCloudFetch(
	fetchImplementation: typeof fetch,
	timeoutMs: number,
	observe: (dependency: CloudDependency, status: CloudDependencyStatus) => void = () => {},
): typeof fetch {
	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const dependency = url.pathname.startsWith("/auth/v1/")
			? "auth"
			: url.pathname.startsWith("/storage/v1/")
				? "storage"
				: "api";
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		try {
			const response = await withCloudDeadline(
				async (requestSignal) => {
					const result = await fetchImplementation(input, { ...init, signal: requestSignal });
					// A denied response must not become an outage/fallback merely because
					// its error body or cancellation stalls. Preserve the authoritative status.
					if (result.status === 401 || result.status === 403) {
						void result.body?.cancel().catch(() => undefined);
						return Response.json(
							{ message: "Cloud authority rejected the operation", statusCode: String(result.status) },
							{ status: result.status },
						);
					}
					const bytes = await result.arrayBuffer();
					return new Response(result.body === null ? null : bytes, {
						status: result.status,
						statusText: result.statusText,
						headers: result.headers,
					});
				},
				timeoutMs,
				signal ?? undefined,
			);
			observe(dependency, response.status >= 500 || response.status === 429 ? "unavailable" : "healthy");
			return response;
		} catch (error) {
			if (!signal?.aborted) observe(dependency, "unavailable");
			throw error;
		}
	};
}
