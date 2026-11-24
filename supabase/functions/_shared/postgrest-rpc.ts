import { withTimeoutScope } from "./abort-timeout.ts";
import {
	DEFAULT_RPC_MAX_RESPONSE_BYTES,
	DEFAULT_RPC_TIMEOUT_MS,
	readBoundedText,
	serviceHeaders,
} from "./http-guards.ts";

export interface PostgrestError {
	readonly code?: string;
	readonly message: string;
	readonly details?: string | null;
	readonly hint?: string | null;
}

export interface PostgrestRpcResult<T = unknown> {
	readonly data: T | null;
	readonly error: PostgrestError | null;
}

export interface PostgrestRpcPromise<T = unknown> extends PromiseLike<PostgrestRpcResult<T>> {
	abortSignal(signal: AbortSignal): PostgrestRpcPromise<T>;
}

export interface PostgrestAuthUserResult {
	readonly data: { readonly user: { readonly id?: string; readonly email?: string } | null };
	readonly error: { readonly message: string } | null;
}

export interface PostgrestClient {
	rpc<T = unknown>(name: string, args?: Record<string, unknown>): PostgrestRpcPromise<T>;
	readonly auth: {
		getUser(token: string, signal?: AbortSignal): Promise<PostgrestAuthUserResult>;
	};
}

export interface PostgrestClientOptions {
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
	readonly fetchImplementation?: typeof fetch;
}

export function createPostgrestClient(
	supabaseUrl: string,
	serviceKey: string,
	options?: PostgrestClientOptions,
): PostgrestClient {
	const base = supabaseUrl.replace(/\/+$/, "");
	const timeoutMs = options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
	const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_RPC_MAX_RESPONSE_BYTES;
	const fetcher = options?.fetchImplementation ?? fetch;
	const rpcHeaders = serviceHeaders(serviceKey, {
		"content-type": "application/json",
		accept: "application/json",
	});

	async function executeRpc<T>(
		name: string,
		args: Record<string, unknown> | undefined,
		parentSignal?: AbortSignal,
	): Promise<PostgrestRpcResult<T>> {
		return withTimeoutScope(
			timeoutMs,
			async (signal) => {
				let response: Response;
				try {
					response = await fetcher(`${base}/rest/v1/rpc/${encodeURIComponent(name)}`, {
						method: "POST",
						headers: rpcHeaders,
						body: JSON.stringify(args ?? {}),
						redirect: "error",
						signal,
					});
				} catch (error) {
					return {
						data: null,
						error: { message: error instanceof Error ? error.message : "RPC transport error" },
					};
				}
				let text: string;
				try {
					text = await readBoundedText(response, maxResponseBytes, {
						signal,
						ignoreContentLength: response.headers.has("content-encoding"),
					});
				} catch (error) {
					return {
						data: null,
						error: { message: error instanceof Error ? error.message : "RPC response error" },
					};
				}
				if (!response.ok) {
					try {
						const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
							return {
								data: null,
								error: {
									code: typeof parsed.code === "string" ? parsed.code : undefined,
									message: typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`,
									details: typeof parsed.details === "string" ? parsed.details : null,
									hint: typeof parsed.hint === "string" ? parsed.hint : null,
								},
							};
						}
					} catch {}
					return { data: null, error: { message: `HTTP ${response.status}` } };
				}
				if (!text) return { data: null, error: null };
				try {
					return { data: JSON.parse(text) as T, error: null };
				} catch {
					return { data: null, error: { message: "Invalid JSON response from RPC" } };
				}
			},
			parentSignal,
		);
	}

	return {
		rpc<T = unknown>(name: string, args?: Record<string, unknown>): PostgrestRpcPromise<T> {
			let attachedSignal: AbortSignal | undefined;
			let started: Promise<PostgrestRpcResult<T>> | undefined;
			const run = (): Promise<PostgrestRpcResult<T>> => {
				started ??= executeRpc<T>(name, args, attachedSignal);
				return started;
			};
			const builder: PostgrestRpcPromise<T> = {
				abortSignal(signal: AbortSignal) {
					attachedSignal = signal;
					return builder;
				},
				then(onFulfilled, onRejected) {
					return run().then(onFulfilled, onRejected);
				},
			};
			return builder;
		},
		auth: {
			async getUser(token: string, parentSignal?: AbortSignal): Promise<PostgrestAuthUserResult> {
				return withTimeoutScope(
					Math.min(timeoutMs, 10_000),
					async (signal) => {
						let response: Response;
						try {
							response = await fetcher(`${base}/auth/v1/user`, {
								method: "GET",
								headers: { apikey: serviceKey, authorization: `Bearer ${token}`, accept: "application/json" },
								redirect: "error",
								signal,
							});
						} catch (error) {
							return { data: { user: null }, error: { message: error instanceof Error ? error.message : "Auth failed" } };
						}
						if (!response.ok) {
							void response.body?.cancel().catch(() => undefined);
							return { data: { user: null }, error: { message: `HTTP ${response.status}` } };
						}
						try {
							const text = await readBoundedText(response, 64 * 1024, {
								signal,
								ignoreContentLength: response.headers.has("content-encoding"),
							});
							const parsed = JSON.parse(text) as { id?: unknown; email?: unknown };
							return {
								data: {
									user:
										parsed && typeof parsed === "object"
											? {
													id: typeof parsed.id === "string" ? parsed.id : undefined,
													email: typeof parsed.email === "string" ? parsed.email : undefined,
												}
											: null,
								},
								error: null,
							};
						} catch {
							return { data: { user: null }, error: { message: "Invalid auth response" } };
						}
					},
					parentSignal,
				);
			},
		},
	};
}
