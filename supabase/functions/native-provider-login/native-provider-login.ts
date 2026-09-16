const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface NativeProviderLoginProxyOptions {
	upstreamUrl?: string;
	/** Chooses the login gateway per request (least-loaded node); an undefined or invalid result falls back to upstreamUrl. */
	upstreamResolver?: () => Promise<string | undefined>;
	/** Exact browser origins; native callers without Origin still require a capability. */
	allowedOrigins?: readonly string[];
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
}

function jsonResponse(value: unknown, status: number): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
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

class LoginBodyTooLarge extends Error {}

/** Bound retained bytes even without Content-Length; cancellation must not wait for the peer. */
async function readLoginBody(
	message: Request | Response,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
	const reader = message.body?.getReader();
	const cancel = () => {
		void reader?.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		const declared = Number(message.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > limit) throw new LoginBodyTooLarge();
		const bytes = new Uint8Array(limit);
		let length = 0;
		while (reader) {
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			if (next.value.byteLength > limit - length) throw new LoginBodyTooLarge();
			bytes.set(next.value, length);
			length += next.value.byteLength;
		}
		return bytes.slice(0, length);
	} catch (error) {
		cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader?.releaseLock();
	}
}

/** The resolver's answer is used only when it is a valid gateway base; anything else keeps the configured upstream. */
async function resolveUpstream(
	options: NativeProviderLoginProxyOptions,
	signal: AbortSignal,
): Promise<{ url: string; source: "resolver" | "configured" | "fallback" }> {
	if (options.upstreamResolver) {
		try {
			const chosen = await options.upstreamResolver();
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
	let body: Uint8Array<ArrayBuffer>;
	try {
		capability = loginCapability(request);
		body = await readLoginBody(request, MAX_REQUEST_BYTES, request.signal);
	} catch (error) {
		if (error instanceof LoginBodyTooLarge) return jsonResponse({ error: "Native login request is too large" }, 413);
		return jsonResponse({ error: "Invalid native login request" }, 400);
	}
	let target: { url: string; source: string } | undefined;
	try {
		const timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
			throw new Error("Native login proxy timeout is invalid");
		}
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
		target = await resolveUpstream(options, signal);
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
		const responseBody = await readLoginBody(upstream, MAX_RESPONSE_BYTES, signal);
		return new Response(responseBody, {
			status: upstream.status,
			headers: {
				"cache-control": "no-store",
				"content-type": "application/json",
				"x-qorpera-login-gateway": gatewayHeader(target, "forwarded"),
			},
		});
	} catch (error) {
		const failure = error instanceof Error ? error.name : "Error";
		if (error instanceof LoginBodyTooLarge) return jsonResponse({ error: "Native login response is too large" }, 502);
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
			try {
				const url = new URL(value);
				return url.protocol === "https:" && url.origin === value && value === origin;
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
