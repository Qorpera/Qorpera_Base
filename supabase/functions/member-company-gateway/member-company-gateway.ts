const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** A member's bytes of a folder-v2 company, one manifest or chunk (folder core C4, P27b). */
const FOLDER_OBJECT = new RegExp(`^/v1/member-folder-objects/${UUID}/[0-9a-f]{64}$`);
/** A member's change set to a folder-v2 company (folder core C4, P34a). */
const FOLDER_COMMIT = new RegExp(`^/v1/member-folder-commits/${UUID}$`);
const PRESENCE = new RegExp(`^/v1/member-company-presence/${UUID}/${UUID}$`);
const MAX_BYTES = 8 * 1024 * 1024;

export interface MemberCompanyGatewayOptions {
	/** Operator-owned origin. Never selected by a request, path, or member token. */
	upstreamUrl?: string;
	allowedOrigins?: readonly string[];
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
}

function route(path: string): { method: string; headers: string[] } | undefined {
	if (FOLDER_OBJECT.test(path)) return { method: "GET", headers: ["authorization"] };
	if (FOLDER_COMMIT.test(path)) return { method: "POST", headers: ["authorization", "content-type"] };
	if (PRESENCE.test(path)) return { method: "POST", headers: ["authorization", "content-type"] };
	return undefined;
}

class BodyTooLarge extends Error {}

/** A deadline bounds request and response streaming, including peers that never close. */
async function bytes(
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
		if (Number(message.headers.get("content-length") ?? "0") > limit) throw new BodyTooLarge();
		// Grow with received data rather than reserving the full object limit for
		// every small reply. A single buffer also bounds tiny-chunk metadata.
		let result = new Uint8Array(0);
		let length = 0;
		while (reader) {
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			if (chunk.value.byteLength > limit - length) throw new BodyTooLarge();
			const needed = length + chunk.value.byteLength;
			if (needed > result.byteLength) {
				const grown = new Uint8Array(Math.min(limit, Math.max(needed, result.byteLength * 2)));
				grown.set(result);
				result = grown;
			}
			result.set(chunk.value, length);
			length = needed;
		}
		return length === result.byteLength ? result : result.slice(0, length);
	} catch (error) {
		cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader?.releaseLock();
	}
}

/** Public transport for the governed member routes only. The destination verifies the
 * original member JWT and current path authority. There are no service credentials,
 * public runtime routes, fallback destinations, or replayed writes. */
export async function forwardMemberCompanyGateway(
	request: Request,
	options: MemberCompanyGatewayOptions,
): Promise<Response> {
	const origin = request.headers.get("origin");
	const allowed = options.allowedOrigins ?? ["https://app.qorpera.com"];
	const headers = new Headers({
		"cache-control": "no-store",
		vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
	});
	const fail = (status: number, error: string) => Response.json({ error }, { status, headers });
	if (
		origin &&
		!allowed.some((value) => {
			try {
				const parsed = new URL(value);
				return parsed.protocol === "https:" && parsed.origin === value && origin === value;
			} catch {
				return false;
			}
		})
	)
		return fail(403, "Browser origin is not allowed");
	if (origin) headers.set("access-control-allow-origin", origin);
	const url = new URL(request.url);
	const prefix = "/member-company-gateway";
	const path = url.pathname.startsWith(`/functions/v1${prefix}/`)
		? url.pathname.slice(`/functions/v1${prefix}`.length)
		: url.pathname.startsWith(`${prefix}/`)
			? url.pathname.slice(prefix.length)
			: "";
	const policy = !url.search && route(path);
	if (!policy) return fail(404, "Member route is not available");
	if (request.method === "OPTIONS") {
		const requested = (request.headers.get("access-control-request-headers") ?? "")
			.toLowerCase()
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		if (
			!origin ||
			request.headers.get("access-control-request-method") !== policy.method ||
			requested.some((value) => !policy.headers.includes(value))
		)
			return fail(403, "Invalid member gateway preflight");
		headers.set("access-control-allow-methods", policy.method);
		headers.set("access-control-allow-headers", policy.headers.join(", "));
		return new Response(null, { status: 204, headers });
	}
	if (request.method !== policy.method) return fail(405, "Method not allowed");
	if (!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(request.headers.get("authorization") ?? ""))
		return fail(401, "Member sign-in is required");
	let upstream: URL;
	try {
		upstream = new URL(options.upstreamUrl ?? "");
		if (
			upstream.protocol !== "https:" ||
			upstream.username ||
			upstream.password ||
			upstream.pathname !== "/" ||
			upstream.search ||
			upstream.hash
		)
			throw new Error("Invalid origin");
	} catch {
		return fail(503, "Member gateway is not configured");
	}
	const timeout = options.timeoutMs ?? 25_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
		return fail(503, "Member gateway is not configured");
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]);
	let body: Uint8Array<ArrayBuffer> | undefined;
	try {
		// Match the gateway's bound for both writes, a folder commit and a presence report.
		if (request.method !== "GET") body = await bytes(request, 1024 * 1024, signal);
	} catch (error) {
		return fail(error instanceof BodyTooLarge ? 413 : 408, "Member gateway request could not be read");
	}
	try {
		const forwarded = new Headers();
		for (const name of policy.headers) {
			const value = request.headers.get(name);
			if (value !== null) forwarded.set(name, value);
		}
		if (body) forwarded.set("content-length", String(body.byteLength));
		const response = await (options.fetchImplementation ?? fetch)(new URL(path, upstream), {
			method: request.method,
			headers: forwarded,
			body,
			signal,
			redirect: "error",
			credentials: "omit",
		});
		const content = await bytes(response, MAX_BYTES, signal);
		for (const name of ["content-type", "x-qorpera-access-mode", "etag"]) {
			const value = response.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		headers.set("access-control-expose-headers", "x-qorpera-access-mode, etag");
		return new Response([204, 205, 304].includes(response.status) ? null : content, {
			status: response.status,
			headers,
		});
	} catch (error) {
		return fail(
			error instanceof BodyTooLarge ? 502 : 503,
			"Company File gateway is unavailable. A submitted change may still apply.",
		);
	}
}
