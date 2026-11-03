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
	rpc(name: string, args?: Record<string, unknown>): Promise<unknown>;
	/** Tells the listener each time the cloud refuses the session token it was sent. */
	onSessionRejected?(listener: (rejection: SessionRejection) => void): () => void;
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

export function createCloud(config: CloudConfig): Cloud {
	const rejectionListeners = new Set<(rejection: SessionRejection) => void>();
	// Every SDK request (Auth, PostgREST, functions, storage) passes here, so a session the
	// cloud no longer accepts is noticed wherever it is first refused. The global fetch is
	// looked up per call, as the SDK does without a custom fetch.
	const observedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const response = await globalThis.fetch(input, init);
		if ((response.status === 401 || response.status === 403) && rejectionListeners.size > 0) {
			void sessionRejection(config.projectUrl, input, init, response.clone()).then(
				(rejection) => {
					if (rejection) for (const listener of [...rejectionListeners]) listener(rejection);
				},
				() => {},
			);
		}
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
			storageKey: "qorpera-web-auth/v1",
		},
		realtime: { params: { eventsPerSecond: 10 } },
	});
	return {
		config,
		supabase,
		async rpc(name, args = {}) {
			const { data, error, status } = await supabase.rpc(name, args);
			if (error) throw new CloudRpcError(name, error, status);
			return data;
		},
		onSessionRejected(listener) {
			rejectionListeners.add(listener);
			return () => {
				rejectionListeners.delete(listener);
			};
		},
	};
}

export function describeError(error: unknown): string {
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
