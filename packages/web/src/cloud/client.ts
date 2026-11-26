import { createClient, navigatorLock, processLock, type SupabaseClient } from "@supabase/supabase-js";
import type { CloudConfig } from "./config.ts";

/* The client is a viewing, input, approval, upload, download endpoint
 * (runtime contract §2). It holds the publishable key and the member's token,
 * nothing else. Every cloud call goes through `rpc` so failures carry the
 * PostgREST/Postgres code the views use to tell "not deployed" from "denied". */

export class CloudRpcError extends Error {
	readonly rpc: string;
	readonly code: string | undefined;
	readonly status: number | undefined;
	readonly details: string | undefined;
	readonly hint: string | undefined;

	constructor(
		rpc: string,
		error: { message: string; code?: string | null; details?: string | null; hint?: string | null },
		status?: number,
	) {
		super(error.message);
		this.name = "CloudRpcError";
		this.rpc = rpc;
		this.code = error.code ?? undefined;
		this.status = status;
		this.details = error.details ?? undefined;
		this.hint = error.hint ?? undefined;
	}

	/** PostgREST could not find the function: the machinery is not deployed. */
	get missing(): boolean {
		return this.code === "PGRST202";
	}

	/** The cloud authority refused: no membership, wrong role, or signed out. */
	get denied(): boolean {
		return this.code === "42501" || this.status === 401 || this.status === 403;
	}
}

/** The cloud refused the member's stored session itself: the token, not the request. */
export interface SessionRejection {
	/** The access token the refused request carried (Auth's /user, PostgREST, functions, storage). */
	accessToken?: string;
	/** The refresh token a refused token refresh carried. */
	refreshToken?: string;
}

export interface Cloud {
	readonly config: CloudConfig;
	readonly supabase: SupabaseClient;
	rpc(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	/** Tells the listener each time the cloud refuses the session token it was sent. */
	onSessionRejected?(listener: (rejection: SessionRejection) => void): () => void;
	/** The web's own requests outside the SDK (direct PostgREST and function calls) report their answer here, with the
	 * session token they sent, so a refused session is noticed there too. */
	noticeResponse?(url: string, accessToken: string, response: Response): void;
}

/** The words PostgREST, Auth and the functions gateway use when the token itself fails:
 * a key that no longer matches (new signing keys), a bad signature, an expired or malformed JWT. */
const TOKEN_REFUSAL = /jwt|jws|no suitable key|wrong key type|invalid signature|token is expired/i;
const TOKEN_REFUSAL_CODES = new Set(["PGRST301", "PGRST303", "bad_jwt", "session_not_found", "session_expired"]);

function bearerToken(headers: Headers): string | undefined {
	const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
	return match?.[1];
}

function refusesToken(text: string): boolean {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return TOKEN_REFUSAL.test(text);
	}
	if (!body || typeof body !== "object") return false;
	const fields = body as Record<string, unknown>;
	for (const key of ["code", "error_code"]) {
		const value = fields[key];
		if (typeof value === "string" && TOKEN_REFUSAL_CODES.has(value)) return true;
	}
	return ["code", "error_code", "message", "msg", "error", "error_description"].some((key) => {
		const value = fields[key];
		return typeof value === "string" && TOKEN_REFUSAL.test(value);
	});
}

/**
 * Whether a cloud response refuses the member's session itself, and with which token.
 * Auth's /user and a token refresh answering 401/403 do; PostgREST, functions and storage
 * do when they answer 401 with a JWT error. A permission refusal (403, 42501), a network
 * failure or a 5xx never does: those keep the member signed in.
 */
export async function sessionRejection(
	projectUrl: string,
	input: string | URL | Request,
	init: RequestInit | undefined,
	response: Response,
): Promise<SessionRejection | undefined> {
	if (response.status !== 401 && response.status !== 403) return undefined;
	const base = new URL(projectUrl);
	const url = new URL(input instanceof Request ? input.url : String(input));
	const basePath = base.pathname.replace(/\/+$/, "");
	if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) return undefined;
	const path = url.pathname.slice(basePath.length);
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	if (path === "/auth/v1/user") {
		const accessToken = bearerToken(headers);
		return accessToken ? { accessToken } : undefined;
	}
	if (path === "/auth/v1/token") {
		if (url.searchParams.get("grant_type") !== "refresh_token" || typeof init?.body !== "string") return undefined;
		try {
			const refreshToken: unknown = (JSON.parse(init.body) as Record<string, unknown> | null)?.refresh_token;
			return typeof refreshToken === "string" && refreshToken ? { refreshToken } : undefined;
		} catch {
			return undefined;
		}
	}
	if (response.status !== 401 || !/^\/(?:rest|functions|storage)\/v1\//.test(path)) return undefined;
	const accessToken = bearerToken(headers);
	if (!accessToken) return undefined;
	let text: string;
	try {
		text = await response.text();
	} catch {
		return undefined;
	}
	return refusesToken(text.slice(0, 4096)) ? { accessToken } : undefined;
}

/** Where this browser keeps the member's session (Auth's storage key). */
export const AUTH_STORAGE_KEY = "qorpera-web-auth/v1";

/** Removes the stored session when Auth's own sign-out could not (it keeps a session it failed to load). */
export function forgetStoredSession(): void {
	try {
		globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
	} catch {
		// Storage that cannot be written holds nothing to forget.
	}
}

export const DATABASE_ANSWER_MS = 20_000;

export const NO_ANSWER = "Qorpera did not answer in time.";

function abortRpcError(name: string, signal: AbortSignal): CloudRpcError {
	const reason = signal.reason;
	const message =
		reason instanceof Error
			? `${reason.name}: ${reason.message}`
			: typeof reason === "string" && reason
				? reason
				: "AbortError: The operation was aborted.";
	return new CloudRpcError(name, { message }, 0);
}

function raceAbort<T>(name: string, promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(abortRpcError(name, signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			void promise.catch(() => undefined);
			reject(abortRpcError(name, signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function answeredWithin(ms: number, input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const parent = init?.signal;
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const armTimer = (): void => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new DOMException(NO_ANSWER, "TimeoutError")), ms);
	};
	armTimer();
	let done = false;
	const finish = (): void => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		timer = undefined;
		parent?.removeEventListener("abort", onAbort);
	};
	let response: Response;
	try {
		response = await globalThis.fetch(input, { ...init, signal: controller.signal });
	} catch (error) {
		finish();
		throw error;
	}
	// WHY: Clear the headers deadline on headers arrival and use a resettable per-chunk inactivity timer for body streaming.
	clearTimeout(timer);
	timer = undefined;
	if (
		!(response instanceof Response) ||
		!response.body ||
		response.status < 200 ||
		response.status > 599 ||
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304
	) {
		finish();
		return response;
	}
	const reader = response.body.getReader();
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const onBodyAbort = (): void => {
		const reason = controller.signal.reason ?? new DOMException(NO_ANSWER, "TimeoutError");
		controller.signal.removeEventListener("abort", onBodyAbort);
		finish();
		try {
			streamController?.error(reason);
		} catch {
			// WHY: Ignore if the wrapped stream already closed or errored concurrently.
		}
		void reader.cancel(reason).catch(() => undefined);
	};
	const release = (): void => {
		controller.signal.removeEventListener("abort", onBodyAbort);
		finish();
	};
	const wrappedBody = new ReadableStream<Uint8Array>({
		start(ctrl) {
			streamController = ctrl;
			if (controller.signal.aborted) {
				onBodyAbort();
				return;
			}
			controller.signal.addEventListener("abort", onBodyAbort, { once: true });
			armTimer();
		},
		async pull(ctrl) {
			try {
				const { value, done: ended } = await reader.read();
				if (ended) {
					release();
					ctrl.close();
					return;
				}
				if (!done) armTimer();
				if (value) ctrl.enqueue(value);
			} catch (error) {
				release();
				try {
					ctrl.error(controller.signal.aborted ? controller.signal.reason : error);
				} catch {
					// WHY: Ignore if onBodyAbort already errored the stream.
				}
			}
		},
		async cancel(reason) {
			release();
			await reader.cancel(reason).catch(() => undefined);
		},
	});
	return new Response(wrappedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export function createCloud(config: CloudConfig): Cloud {
	const rejectionListeners = new Set<(rejection: SessionRejection) => void>();
	// Every SDK request (Auth, PostgREST, functions, storage) passes here, so a session the
	// cloud no longer accepts is noticed wherever it is first refused. The global fetch is
	// looked up per call, as the SDK does without a custom fetch.
	const notice = (input: string | URL | Request, init: RequestInit | undefined, response: Response): void => {
		if ((response.status !== 401 && response.status !== 403) || rejectionListeners.size === 0) return;
		void sessionRejection(config.projectUrl, input, init, response.clone()).then(
			(rejection) => {
				if (rejection) for (const listener of [...rejectionListeners]) listener(rejection);
			},
			() => {},
		);
	};
	const base = config.projectUrl.replace(/\/+$/, "");
	const database = `${base}/rest/v1/`;
	const auth = `${base}/auth/v1/`;
	const observedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = requestUrl(input);
		// WHY: Bound /auth/v1/ fetches alongside /rest/v1/ so a stalled token refresh cannot hold the cross-tab navigatorLock forever.
		const response =
			url.startsWith(database) || url.startsWith(auth)
				? await answeredWithin(DATABASE_ANSWER_MS, input, init)
				: await globalThis.fetch(input, init);
		notice(input, init, response);
		return response;
	};
	const supabase = createClient(config.projectUrl, config.publishableKey, {
		global: { fetch: observedFetch },
		auth: {
			// updateUser persists its captured session before notifying subscribers.
			// Serialize it with sign-out, including across tabs, so a late name save
			// cannot restore a session that the member has already signed out of.
			lock:
				typeof navigator !== "undefined" && "locks" in navigator && navigator.locks ? navigatorLock : processLock,
			// A timeout must not steal a lock while the original request can still
			// commit its session. Wait for that request (or its tab) to release it.
			lockAcquireTimeout: -1,
			flowType: "pkce",
			persistSession: true,
			autoRefreshToken: true,
			detectSessionInUrl: true,
			storageKey: AUTH_STORAGE_KEY,
		},
		realtime: { params: { eventsPerSecond: 10 } },
	});
	return {
		config,
		supabase,
		async rpc(name, args = {}, signal) {
			if (signal?.aborted) throw abortRpcError(name, signal);
			const call = supabase.rpc(name, args);
			const pending = Promise.resolve(signal ? call.abortSignal(signal) : call);
			const { data, error, status } = signal ? await raceAbort(name, pending, signal) : await pending;
			if (error) throw new CloudRpcError(name, error, status);
			return data;
		},
		onSessionRejected(listener) {
			rejectionListeners.add(listener);
			return () => {
				rejectionListeners.delete(listener);
			};
		},
		noticeResponse(url, accessToken, response) {
			notice(url, { headers: { authorization: `Bearer ${accessToken}` } }, response);
		},
	};
}

const CONNECTION_LOST =
	/^(?:TypeError: )?(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|The network connection was lost\.?|The Internet connection appears to be offline\.?|fetch failed|Network request failed)$/;

let t: (source: string) => string = (source) => source;

export function translateCloudErrors(translate: (source: string) => string): void {
	t = translate;
}

export function connectionLost(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return (
		error.name === "TimeoutError" || error.message.startsWith("TimeoutError: ") || CONNECTION_LOST.test(error.message)
	);
}

export function describeError(error: unknown): string {
	if (connectionLost(error)) return t("Qorpera can't be reached right now. Check your connection and try again.");
	if (error instanceof CloudRpcError) {
		if (error.missing) return `${error.rpc} is not deployed on this cloud yet.`;
		// A refusal usually says exactly what rule was hit, and that sentence is
		// worth more than a paraphrase of the code.
		if (error.denied) {
			return error.message.trim() ? error.message : "The cloud refused this operation for your account.";
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return String(error);
}
