const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** A member's bytes of a folder-v2 company, one manifest or chunk (folder core C4, P27b). */
const FOLDER_OBJECT = new RegExp(`^/v1/member-folder-objects/${UUID}/[0-9a-f]{64}$`);
/** A member's change set to a folder-v2 company (folder core C4, P34a). */
const FOLDER_COMMIT = new RegExp(`^/v1/member-folder-commits/${UUID}$`);
const PRESENCE = new RegExp(`^/v1/member-company-presence/${UUID}/${UUID}$`);
/** A chat image: its upload for one pending input, or a canonical input's bytes (the gateway's attachment route). */
const ATTACHMENT = new RegExp(`^/v1/member-session-attachments/(upload|input)/${UUID}/${UUID}/[0-9a-f]{64}$`);
/** A member's erase of one message: its request (an event id after the session) or where it stands (M3c). */
const ERASE = new RegExp(`^/v1/member-message-erases/${UUID}/${UUID}(/${UUID})?$`);
const MAX_BYTES = 8 * 1024 * 1024;
/** The gateway's bound for a folder commit and a presence report. */
const MAX_WRITE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 25_000;
/** An image upload: past the client's own 30 s, so the member's deadline decides (the browser's 8 MiB, the hop and
 * the gateway's commit). A retry with the same input id is safe: the begin and the commit answer the same file as
 * saved until the input is posted. */
const UPLOAD_TIMEOUT_MS = 35_000;
const FOLDER_UNAVAILABLE = "Company File gateway is unavailable. A submitted change may still apply.";
const IMAGE_UNAVAILABLE = "Chat images are unavailable just now. An uploaded image may still be saved.";

export interface MemberCompanyGatewayOptions {
	/** Operator-owned origin. Never selected by a request, path, or member token. */
	upstreamUrl?: string;
	allowedOrigins?: readonly string[];
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
	/** Whether the auth service knows this `Bearer` token. A write's body is read only after it says yes, so no one
	 * signed out can make the bridge hold a body. */
	memberSignedIn?: (authorization: string, signal: AbortSignal) => Promise<boolean>;
}

interface RoutePolicy {
	method: string;
	headers: string[];
	maxBody?: number;
	timeoutMs?: number;
	unavailable: string;
}

function route(path: string): RoutePolicy | undefined {
	if (FOLDER_OBJECT.test(path)) return { method: "GET", headers: ["authorization"], unavailable: FOLDER_UNAVAILABLE };
	if (FOLDER_COMMIT.test(path))
		return {
			method: "POST",
			headers: ["authorization", "content-type"],
			maxBody: MAX_WRITE_BYTES,
			unavailable: FOLDER_UNAVAILABLE,
		};
	if (PRESENCE.test(path))
		return {
			method: "POST",
			headers: ["authorization", "content-type"],
			maxBody: MAX_WRITE_BYTES,
			unavailable: "Presence is unavailable just now.",
		};
	const attachment = ATTACHMENT.exec(path);
	// An upload is one image of at most 8 MiB, as the gateway takes it.
	if (attachment)
		return attachment[1] === "upload"
			? {
					method: "PUT",
					headers: ["authorization", "content-type"],
					maxBody: MAX_BYTES,
					timeoutMs: UPLOAD_TIMEOUT_MS,
					unavailable: IMAGE_UNAVAILABLE,
				}
			: { method: "GET", headers: ["authorization"], unavailable: IMAGE_UNAVAILABLE };
	const erase = ERASE.exec(path);
	if (erase)
		return {
			method: erase[1] ? "POST" : "GET",
			headers: ["authorization"],
			unavailable: "Message erase is unavailable just now. A submitted erase may still apply.",
		};
	return undefined;
}

class BodyTooLarge extends Error {}
class BodyInvalid extends Error {}

/** A deadline bounds request and response streaming, including peers that never close. A request is read into one
 * buffer of its declared length; a reply's chunks are joined once at the end, so nothing is reserved ahead of the
 * bytes received or copied while it grows. */
async function bytes(
	message: Request | Response,
	limit: number,
	signal: AbortSignal,
	declared?: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const reader = message.body?.getReader();
	const cancel = () => {
		void reader?.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		if (Number(message.headers.get("content-length") ?? "0") > limit) throw new BodyTooLarge();
		const exact = declared === undefined ? undefined : new Uint8Array(declared);
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (reader) {
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			if (chunk.value.byteLength > (declared ?? limit) - length)
				throw declared === undefined ? new BodyTooLarge() : new BodyInvalid();
			if (exact) exact.set(chunk.value, length);
			else chunks.push(chunk.value);
			length += chunk.value.byteLength;
		}
		if (exact) {
			if (length !== exact.byteLength) throw new BodyInvalid();
			return exact;
		}
		const result = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
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
		"x-content-type-options": "nosniff",
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
	const timeout = options.timeoutMs ?? policy.timeoutMs ?? TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > UPLOAD_TIMEOUT_MS)
		return fail(503, "Member gateway is not configured");
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]);
	// A write states its length, within the gateway's bound for its route: a folder commit, a presence report or a
	// chat image. A chunked body of unknown length is refused unread.
	const length = request.headers.get("content-length");
	const refuse = (status: number, error: string) => {
		void request.body?.cancel().catch(() => {});
		return fail(status, error);
	};
	if (request.headers.has("transfer-encoding") || (request.body && length === null))
		return refuse(411, "Member gateway request needs its length");
	if (length !== null && !/^(0|[1-9][0-9]{0,8})$/.test(length))
		return refuse(400, "Member gateway request could not be read");
	const size = Number(length ?? "0");
	if (size > (policy.maxBody ?? MAX_WRITE_BYTES)) return refuse(413, "Member gateway request could not be read");
	if (size > 0) {
		let signedIn: boolean;
		try {
			if (!options.memberSignedIn) throw new Error("Member sign-in check is not configured");
			signedIn = await options.memberSignedIn(request.headers.get("authorization") ?? "", signal);
		} catch {
			return refuse(503, "Member sign-in could not be checked");
		}
		if (!signedIn) return refuse(401, "Member sign-in is required");
	}
	let body: Uint8Array<ArrayBuffer> | undefined;
	try {
		if (request.method !== "GET") body = await bytes(request, size, signal, size);
	} catch (error) {
		return fail(
			error instanceof BodyTooLarge ? 413 : error instanceof BodyInvalid ? 400 : 408,
			"Member gateway request could not be read",
		);
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
		return fail(error instanceof BodyTooLarge ? 502 : 503, policy.unavailable);
	}
}
