import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { BodyTooLargeError, jsonResponse, readBoundedBytes, sha256Hex } from "../_shared/http-guards.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** How long a ChatGPT plan confirmation may take end to end at this hop (see forwardLogin). */
export const CHATGPT_PLAN_CONFIRM_TIMEOUT_MS = 40_000;

export interface NativeProviderLoginProxyOptions {
	upstreamUrl?: string;
	/** Chooses the login gateway per request (least-loaded node); an undefined or invalid result falls back to upstreamUrl. */
	/** Receives the SHA-256 of the login capability so the backend can prefer the identity's home node. */
	upstreamResolver?: (
		capabilitySha256: string,
		purpose?: "account_refresh",
		signal?: AbortSignal,
	) => Promise<string | undefined>;
	/** Exact browser origins; native callers without Origin still require a capability. */
	allowedOrigins?: readonly string[];
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
}

function upstreamLoginUrl(value: string): string {
	const base = new URL(value);
	if (
		(base.protocol !== "https:" &&
			!(base.protocol === "http:" && (base.hostname === "127.0.0.1" || base.hostname === "localhost"))) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new Error("Native provider upstream URL is invalid");
	}
	return new URL("login", base).href;
}

function loginCapability(request: Request): string {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) throw new Error("Native login capability is missing");
	const capability = authorization.slice("Bearer ".length);
	if (!TOKEN_PATTERN.test(capability)) throw new Error("Native login capability is invalid");
	return capability;
}

/** The resolver's answer is used only when it is a valid gateway base; anything else keeps the configured upstream. */
async function resolveUpstream(
	options: NativeProviderLoginProxyOptions,
	signal: AbortSignal,
	capabilitySha256: string,
	purpose?: "account_refresh",
): Promise<{ url: string; source: "resolver" | "configured" | "fallback" }> {
	if (options.upstreamResolver) {
		try {
			const chosen = await options.upstreamResolver(capabilitySha256, purpose, signal);
			signal.throwIfAborted();
			if (typeof chosen === "string" && chosen) return { url: upstreamLoginUrl(chosen), source: "resolver" };
		} catch (error) {
			if (signal.aborted) throw error;
			return { url: upstreamLoginUrl(options.upstreamUrl ?? ""), source: "fallback" };
		}
		return { url: upstreamLoginUrl(options.upstreamUrl ?? ""), source: "fallback" };
	}
	return { url: upstreamLoginUrl(options.upstreamUrl ?? ""), source: "configured" };
}

/** Host of the gateway that was tried and why, for operators; never the capability or body. */
function gatewayHeader(target: { url: string; source: string } | undefined, outcome: string): string {
	const host = target ? new URL(target.url).host : "none";
	return `${outcome}; gateway=${host}; source=${target?.source ?? "none"}`;
}

async function forwardLogin(request: Request, options: NativeProviderLoginProxyOptions): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	let capability: string;
	try {
		capability = loginCapability(request);
	} catch {
		return jsonResponse({ error: "Invalid native login request" }, 400);
	}
	let target: { url: string; source: string } | undefined;
	try {
		const path = new URL(request.url).pathname;
		const refresh = path.endsWith("/account-refresh");
		// Sign in with ChatGPT: the web client confirms a plan sign-in with the same capability; the same
		// gateway (the company's vault) answers it. The vault's confirm route answers within 30 s (it may
		// exchange the code with OpenAI and save the login), after the gateway lookup (at most 5 s): this
		// hop waits 40 s, inside the web client's 45 s, so a member never sees a failure for a login the
		// vault saved.
		const planConfirm = path.endsWith("/chatgpt-plan-confirm");
		// A Claude sign-in's code (20260930564000): the same capability, the same gateway (the company's vault), whose
		// route answers once Claude Code has exchanged the code (34 s at most). This hop waits as long as a plan
		// confirmation does.
		const claudeCode = path.endsWith("/claude-code");
		const timeoutMs =
			options.timeoutMs ?? (planConfirm || claudeCode ? CHATGPT_PLAN_CONFIRM_TIMEOUT_MS : 30_000);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
			throw new Error("Native login proxy timeout is invalid");
		}
		return await withTimeoutScope(
			timeoutMs,
			async (signal) => {
				// WHY: Read the client body inside withTimeoutScope so slowloris request streams cannot pin the isolate indefinitely.
				let body: Uint8Array<ArrayBuffer>;
				try {
					body = await readBoundedBytes(request, MAX_REQUEST_BYTES, { signal });
				} catch (error) {
					if (error instanceof BodyTooLargeError) return jsonResponse({ error: "Native login request is too large" }, 413);
					return jsonResponse({ error: "Invalid native login request" }, 400);
				}
				target = await resolveUpstream(
					options,
					signal,
					await sha256Hex(capability),
					refresh ? "account_refresh" : undefined,
				);
				if (refresh) target.url = new URL("account-refresh", target.url).href;
				if (planConfirm) target.url = new URL("chatgpt-plan/confirm", target.url).href;
				if (claudeCode) target.url = new URL("claude/code", target.url).href;
				const upstream = await (options.fetchImplementation ?? fetch)(target.url, {
					method: "POST",
					headers: {
						accept: "application/json",
						authorization: `Bearer ${capability}`,
						"content-type": "application/json",
					},
					body: body.buffer,
					redirect: "error",
					signal,
				});
				const responseBody = await readBoundedBytes(upstream, MAX_RESPONSE_BYTES, {
					signal,
					ignoreContentLength: upstream.headers.has("content-encoding"),
				});
				return new Response(responseBody, {
					status: upstream.status,
					headers: {
						"cache-control": "no-store",
						"content-type": "application/json",
						"x-qorpera-login-gateway": gatewayHeader(target, "forwarded"),
					},
				});
			},
			request.signal,
		);
	} catch (error) {
		// Upstream detail stays private: the body is generic and the header names only the error class.
		const failure = error instanceof Error ? error.name : "Error";
		if (error instanceof BodyTooLargeError) return jsonResponse({ error: "Native login response is too large" }, 502);
		const response = jsonResponse({ error: "Native provider login is unavailable" }, 503);
		response.headers.set("x-qorpera-login-gateway", gatewayHeader(target, `failed:${failure}`));
		return response;
	}
}

/** Browser policy is applied before reading credentials or contacting the private upstream. */
export async function forwardNativeProviderLogin(
	request: Request,
	options: NativeProviderLoginProxyOptions,
): Promise<Response> {
	const origin = request.headers.get("origin");
	const allowed = options.allowedOrigins ?? ["https://app.qorpera.com"];
	if (
		origin &&
		!allowed.some((value) => {
			if (value !== origin) return false;
			try {
				const url = new URL(value);
				return url.protocol === "https:" && url.origin === value;
			} catch {
				return false;
			}
		})
	)
		return jsonResponse({ error: "Browser origin is not allowed" }, 403);
	let response: Response;
	if (request.method === "OPTIONS") {
		const method = request.headers.get("access-control-request-method");
		const requested = (request.headers.get("access-control-request-headers") ?? "")
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean);
		response =
			origin && method === "POST" && requested.every((value) => ["authorization", "content-type"].includes(value))
				? new Response(null, {
						status: 204,
						headers: {
							"cache-control": "no-store",
							"access-control-allow-methods": "POST",
							"access-control-allow-headers": "Authorization, Content-Type",
						},
					})
				: jsonResponse({ error: "Invalid native login preflight" }, 403);
	} else response = await forwardLogin(request, options);
	response.headers.set("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
	if (origin) response.headers.set("access-control-allow-origin", origin);
	return response;
}
