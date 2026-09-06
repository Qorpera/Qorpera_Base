const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface NativeProviderLoginProxyOptions {
	upstreamUrl: string;
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

export async function forwardNativeProviderLogin(
	request: Request,
	options: NativeProviderLoginProxyOptions,
): Promise<Response> {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	let capability: string;
	let body: Uint8Array;
	try {
		capability = loginCapability(request);
		const declared = Number(request.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
			return jsonResponse({ error: "Native login request is too large" }, 413);
		}
		body = new Uint8Array(await request.arrayBuffer());
		if (body.byteLength > MAX_REQUEST_BYTES) return jsonResponse({ error: "Native login request is too large" }, 413);
	} catch {
		return jsonResponse({ error: "Invalid native login request" }, 400);
	}
	try {
		const timeoutMs = options.timeoutMs ?? 30_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
			throw new Error("Native login proxy timeout is invalid");
		}
		const upstream = await (options.fetchImplementation ?? fetch)(upstreamLoginUrl(options.upstreamUrl), {
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${capability}`,
				"content-type": "application/json",
			},
			body: body.buffer,
			redirect: "error",
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
		});
		const declared = Number(upstream.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
			return jsonResponse({ error: "Native login response is too large" }, 502);
		}
		const responseBody = new Uint8Array(await upstream.arrayBuffer());
		if (responseBody.byteLength > MAX_RESPONSE_BYTES) {
			return jsonResponse({ error: "Native login response is too large" }, 502);
		}
		return new Response(responseBody, {
			status: upstream.status,
			headers: { "cache-control": "no-store", "content-type": "application/json" },
		});
	} catch {
		return jsonResponse({ error: "Native provider login is unavailable" }, 503);
	}
}
