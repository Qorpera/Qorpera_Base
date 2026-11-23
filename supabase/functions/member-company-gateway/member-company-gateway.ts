const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** A member's bytes of a folder-v2 company, one manifest or chunk (folder core C4, P27b). */
const FOLDER_OBJECT = new RegExp(`^/v1/member-folder-objects/${UUID}/[0-9a-f]{64}$`);
/** A member's change set to a folder-v2 company (folder core C4, P34a). */
const FOLDER_COMMIT = new RegExp(`^/v1/member-folder-commits/${UUID}$`);
const PRESENCE = new RegExp(`^/v1/member-company-presence/${UUID}/${UUID}$`);
/** A chat image: its upload for one pending input, or a canonical input's bytes (the gateway's attachment route). */
const ATTACHMENT = new RegExp(`^/v1/member-session-attachments/(upload|input|surface-upload|surface-input)/${UUID}/${UUID}/[0-9a-f]{64}$`);
/** A member's erase of one message: its request (an event id after the session) or where it stands (M3c). */
const ERASE = new RegExp(`^/v1/member-message-erases/${UUID}/${UUID}(/${UUID})?$`);
const PROGRAM_UPLOAD = new RegExp(`^/v1/member-program-uploads/${UUID}(/${UUID}(/(0|[1-9]|[1-5][0-9]|6[0-3]|stop))?)?$`);
const MAX_PROGRAM_PIECE_BYTES = 4 * 1024 * 1024;
const MAX_PROGRAM_STEP_BYTES = 16 * 1024;
/** A member's look at an agent's desktop computer (20260930712000): a company and a machine, and `/watching` when the
 * member says they still watch. The coding executor of the bridge's node answers it (deploy/coding-worker/README.md). */
const MACHINE_SCREEN = new RegExp(`^/v1/member-machine-screens/${UUID}/${UUID}(/watching)?$`);
/** A member's action on an agent's desktop they took over (20260930713000): one click, drag, scroll, key or text, with
 * the epoch and the seat of the hold the member's page captured it under (F24 and F26 of #1661; the executor and SQL
 * check both), at most 16 KiB. The body passes through as it came: what the member typed is in it, never kept or logged
 * here. */
const MACHINE_ACT = new RegExp(`^/v1/member-machine-screens/${UUID}/${UUID}/act$`);
const MAX_ACT_BYTES = 16 * 1024;
/** A member turns an agent's desktop computer's screen on (20260930714000): `{}` today (a later stage may say what to
 * open), at most 1 KiB, which the executor checks. The node's mux passes POST for this location. */
const MACHINE_START = new RegExp(`^/v1/member-machine-screens/${UUID}/${UUID}/start$`);
const MAX_START_BYTES = 1024;
/** A member's pointer on an agent's desktop (20260930744000): a pointer pass's begin or one move, at most 256 bytes of
 * numbers and an id, many a second while the member's pointer moves (the window keeps one in flight; the executor admits
 * at most 30 a second on a pass). Its body is read without asking the auth service first: a body this small is no hold
 * on the bridge, and the executor checks the member's token itself (SQL for a begin, the pass's own for a move), so a
 * move costs the auth service nothing. A browser keeps the preflight for 10 minutes. The node's mux already passes POST
 * for the location. */
const MACHINE_POINTER = new RegExp(`^/v1/member-machine-screens/${UUID}/${UUID}/pointer$`);
const MAX_POINTER_BYTES = 256;
/** A pointer move is worth little once a newer one exists: the window gives up on it after this. */
const POINTER_TIMEOUT_MS = 5_000;
/** How long a browser keeps a preflight of the pointer route (seconds). On production the API gateway in front of the
 * functions answers every preflight itself, so this is for a bridge without one; nothing depends on a preflight. */
const POINTER_PREFLIGHT_SECONDS = 600;
const COMPANY_DATA = new RegExp(`^/v1/company-data/${UUID}/(query|watch|apply|describe|rows|edit|change|changes)$`);
const COMPANY_DATA_PUBLIC = new RegExp(`^/v1/company-data-public/${UUID}/(query|change)$`);
const LARGE_DATA_CALLS: ReadonlySet<string> = new Set(["apply", "rows", "edit", "changes"]);
const DATA_WRITES: Record<string, string> = {
	apply: "Company data is unavailable just now. Steps sent may still apply.",
	edit: "Company data is unavailable just now. A change sent may still apply.",
	change: "Company data is unavailable just now. A change sent may still apply.",
};
/** A question or a look at a database: names, parameters, and a question's text when asked for. */
const MAX_DATA_BYTES = 64 * 1024;
/** A watch: up to 24 questions with their etags, and their texts of up to 16 KiB each when asked for. */
const MAX_WATCH_BYTES = 512 * 1024;
/** A watch is held by the data gateway for up to 20 s after its own reads, and the bridge's sign-in check may take
 * 5 s before it. */
const WATCH_TIMEOUT_MS = 30_000;

/** The signing algorithms of the project's own access tokens (its legacy secret, or its asymmetric keys). */
const MEMBER_TOKEN_ALGORITHMS: ReadonlySet<string> = new Set(["HS256", "ES256", "RS256"]);
const MEMBER_ID = new RegExp(`^${UUID}$`);

/** Two issuers that differ only by a trailing slash are the same one (a deployment may write it either way). */
function same(claimed: unknown, issuer: string): boolean {
	return typeof claimed === "string" && claimed.replace(/\/$/, "") === issuer.replace(/\/$/, "");
}

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

/** One part of a token: base64url of a JSON object, or undefined. */
function tokenPart(segment: string): Record<string, unknown> | undefined {
	if (!/^[A-Za-z0-9_-]{2,4096}$/.test(segment)) return undefined;
	try {
		const binary = atob(
			segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4),
		);
		const value: unknown = JSON.parse(
			UTF8_FATAL_DECODER.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
		);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a bearer is a member's own access token that has not run out (step 2 of the member's pointer,
 * 20260930745000), read here alone: three base64url parts, a JSON header naming one of the project's signing
 * algorithms, and the claims of a signed-in member: role and audience `authenticated`, a user id, and an expiry still
 * ahead. The project's publishable (anon) key, a service key, an expired token or any other string is no member's.
 *
 * `issuer` is checked only when the deployment names one (`QORPERA_MEMBER_TOKEN_ISSUER`): the string the auth service
 * itself puts in `iss`, copied unchanged from the stack's own environment (on the pinned self-hosted configuration,
 * `API_EXTERNAL_URL` as it stands, with nothing appended: review r2 F2 of #1746). Nothing here derives it, and no shape
 * of it is assumed; deriving it from `SUPABASE_URL`, the address the functions reach the stack at, would have refused
 * every real member token (review r1 F2). Unnamed, every other check still holds.
 *
 * The signature is not checked here (no key, no call out): the executor has the database (PostgREST) check it before
 * any SQL runs for a pass's begin, and a move or a live picture's ticket is matched in the executor's memory against
 * the pass that token began (no SQL, no call). So nobody's request leaves the bridge, and a forged one that looks
 * right costs the executor one refused call to PostgREST, within its own bound on begins.
 */
export function memberTokenShaped(authorization: string, issuer: string | undefined, nowSeconds: number): boolean {
	const parts = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16,1024})$/.exec(authorization);
	if (!parts || authorization.length > 8192) return false;
	const header = tokenPart(parts[1] as string);
	const claims = tokenPart(parts[2] as string);
	if (!header || !claims) return false;
	if (typeof header.alg !== "string" || !MEMBER_TOKEN_ALGORITHMS.has(header.alg)) return false;
	if (header.typ !== undefined && header.typ !== "JWT") return false;
	const audience = claims.aud;
	return (
		claims.role === "authenticated" &&
		(audience === "authenticated" || (Array.isArray(audience) && audience.includes("authenticated"))) &&
		(issuer === undefined || same(claims.iss, issuer)) &&
		typeof claims.sub === "string" &&
		MEMBER_ID.test(claims.sub) &&
		Number.isSafeInteger(claims.exp) &&
		(claims.exp as number) > nowSeconds
	);
}
const MAX_BYTES = 8 * 1024 * 1024;
/** The gateway's bound for a folder commit and a presence report. */
const MAX_WRITE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 25_000;
/** An image upload: past the client's own 30 s, so the member's deadline decides (the browser's 8 MiB, the hop and
 * the gateway's commit). A retry with the same input id is safe: the begin and the commit answer the same file as
 * saved until the input is posted. */
const UPLOAD_TIMEOUT_MS = 35_000;
const MAX_STREAM_MS = 120_000;
const FOLDER_UNAVAILABLE = "Company File gateway is unavailable. A submitted change may still apply.";
const IMAGE_UNAVAILABLE = "Chat images are unavailable just now. An uploaded image may still be saved.";
const PROGRAM_UNAVAILABLE = "Programs are unavailable just now. A finished program may still be saved.";

export interface MemberCompanyGatewayOptions {
	/** Operator-owned origin. Never selected by a request, path, or member token. */
	upstreamUrl?: string;
	allowedOrigins?: readonly string[];
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
	maxStreamMs?: number;
	/** Whether the auth service knows this `Bearer` token. A write's body is read only after it says yes, so no one
	 * signed out can make the bridge hold a body. */
	memberSignedIn?: (authorization: string, signal: AbortSignal) => Promise<boolean>;
	/** Exactly what the auth service puts in a token's `iss`, copied unchanged from the stack's own environment, when
	 * the deployment names one (`QORPERA_MEMBER_TOKEN_ISSUER`): a token of another issuer is then refused here. Nothing
	 * is appended to it and no path is demanded of it — the pinned self-hosted configuration issues with
	 * `API_EXTERNAL_URL` as it stands (review r2 F2 of #1746) — and it is never derived from the address the functions
	 * reach the stack at, which is not the issuer (review r1 F2 of #1746). */
	memberTokenIssuer?: string;
	/** The clock, in milliseconds (the tests'). */
	now?: () => number;
}

interface RoutePolicy {
	method: string;
	headers: string[];
	proxyHeaders?: string[];
	maxBody?: number;
	timeoutMs?: number;
	unavailable: string;
	/** A body small enough to read before asking the auth service (the destination checks the member's token itself). */
	readsSmallBodyFirst?: boolean;
	/** How long a browser keeps this route's preflight (seconds). */
	preflightSeconds?: number;
	/** The browser's Origin goes with it (already one of the allowed origins): the executor binds a live-picture ticket
	 * to it, so only that Origin can open the stream (20260930745000). */
	forwardsOrigin?: boolean;
	/** Only a member's own unexpired token of this project goes on (memberTokenShaped): the route asks no auth service. */
	memberToken?: boolean;
	publicRoute?: boolean;
	passesBodyThrough?: boolean;
}

function route(path: string): RoutePolicy | undefined {
	if (FOLDER_OBJECT.test(path))
		return { method: "GET", headers: ["authorization"], unavailable: FOLDER_UNAVAILABLE, passesBodyThrough: true };
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
		return attachment[1].endsWith("upload")
			? {
					method: "PUT",
					headers: ["authorization", "content-type"],
					maxBody: MAX_BYTES,
					timeoutMs: UPLOAD_TIMEOUT_MS,
					unavailable: IMAGE_UNAVAILABLE,
				}
			: { method: "GET", headers: ["authorization"], unavailable: IMAGE_UNAVAILABLE };
	// A picture of at most 8 MiB, or 304 to the etag the member has: its If-None-Match goes with it.
	if (MACHINE_SCREEN.test(path))
		return {
			method: "GET",
			headers: ["authorization", "if-none-match"],
			unavailable: "The computer's screen is unavailable just now.",
		};
	if (MACHINE_ACT.test(path))
		return {
			method: "POST",
			headers: ["authorization", "content-type"],
			maxBody: MAX_ACT_BYTES,
			unavailable: "The computer is unavailable just now.",
		};
	if (MACHINE_POINTER.test(path))
		return {
			method: "POST",
			headers: ["authorization", "content-type"],
			maxBody: MAX_POINTER_BYTES,
			timeoutMs: POINTER_TIMEOUT_MS,
			readsSmallBodyFirst: true,
			preflightSeconds: POINTER_PREFLIGHT_SECONDS,
			forwardsOrigin: true,
			memberToken: true,
			unavailable: "The computer is unavailable just now.",
		};
	if (MACHINE_START.test(path))
		return {
			method: "POST",
			headers: ["authorization", "content-type"],
			maxBody: MAX_START_BYTES,
			unavailable: "The computer is unavailable just now.",
		};
	const verb = COMPANY_DATA.exec(path)?.[1];
	if (verb)
		return {
			method: "POST",
			headers: ["authorization", "content-type"],
			maxBody: LARGE_DATA_CALLS.has(verb) ? MAX_WRITE_BYTES : verb === "watch" ? MAX_WATCH_BYTES : MAX_DATA_BYTES,
			...(verb === "watch" ? { timeoutMs: WATCH_TIMEOUT_MS } : {}),
			unavailable: DATA_WRITES[verb] ?? "Company data is unavailable just now.",
		};
	const publicVerb = COMPANY_DATA_PUBLIC.exec(path)?.[1];
	if (publicVerb)
		return {
			method: "POST",
			headers: ["content-type"],
			proxyHeaders: ["x-forwarded-for"],
			maxBody: MAX_DATA_BYTES,
			publicRoute: true,
			unavailable: DATA_WRITES[publicVerb] ?? "Company data is unavailable just now.",
		};
	const upload = PROGRAM_UPLOAD.exec(path);
	if (upload)
		return upload[3] && upload[3] !== "stop"
			? {
					method: "PUT",
					headers: ["authorization", "content-type"],
					maxBody: MAX_PROGRAM_PIECE_BYTES,
					timeoutMs: UPLOAD_TIMEOUT_MS,
					unavailable: PROGRAM_UNAVAILABLE,
				}
			: {
					method: "POST",
					headers: ["authorization", "content-type"],
					maxBody: MAX_PROGRAM_STEP_BYTES,
					unavailable: PROGRAM_UNAVAILABLE,
				};
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
		if (chunks.length === 1) {
			const single = chunks[0]!;
			if (single.buffer instanceof ArrayBuffer) return single as Uint8Array<ArrayBuffer>;
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

interface UpstreamWatch {
	readonly signal: AbortSignal;
	wait(countTotal?: boolean): void;
	rest(): void;
	dispose(): void;
}

function watchUpstream(caller: AbortSignal, quietMs: number, maxTotalMs: number): UpstreamWatch {
	const upstream = new AbortController();
	const leave = () => upstream.abort(caller.aborted ? caller.reason : new Error("Upstream request timed out"));
	let quiet: ReturnType<typeof setTimeout> | undefined;
	let total: ReturnType<typeof setTimeout> | undefined;
	let remainingTotalMs = maxTotalMs;
	let waitingSince: number | undefined;
	let disposed = false;
	const pauseTotal = () => {
		clearTimeout(total);
		total = undefined;
		if (waitingSince !== undefined) {
			remainingTotalMs = Math.max(0, remainingTotalMs - Math.max(0, performance.now() - waitingSince));
			waitingSince = undefined;
		}
	};
	const cleanup = () => {
		if (disposed) return;
		disposed = true;
		clearTimeout(quiet);
		clearTimeout(total);
		quiet = undefined;
		total = undefined;
		waitingSince = undefined;
		caller.removeEventListener("abort", leave);
	};
	if (caller.aborted) {
		disposed = true;
		upstream.abort(caller.reason);
	} else {
		caller.addEventListener("abort", leave, { once: true });
		upstream.signal.addEventListener("abort", cleanup, { once: true });
	}
	return {
		signal: upstream.signal,
		wait(countTotal = false) {
			if (disposed) return;
			clearTimeout(quiet);
			quiet = setTimeout(leave, quietMs);
			(quiet as unknown as { unref?: () => void }).unref?.();
			if (countTotal) {
				pauseTotal();
				if (remainingTotalMs <= 0) {
					upstream.abort(new Error("Upstream stream exceeded total duration"));
					return;
				}
				waitingSince = performance.now();
				// WHY: Cap cumulative time waiting on upstream stream chunks while pausing during downstream reader backpressure.
				total = setTimeout(
					() => upstream.abort(new Error("Upstream stream exceeded total duration")),
					Math.max(1, Math.ceil(remainingTotalMs)),
				);
				(total as unknown as { unref?: () => void }).unref?.();
			}
		},
		rest() {
			clearTimeout(quiet);
			quiet = undefined;
			pauseTotal();
		},
		dispose: cleanup,
	};
}

function passedThrough(
	body: ReadableStream<Uint8Array>,
	limit: number,
	watch: UpstreamWatch,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let passed = 0;
	let over = false;
	let onAbort: (() => void) | undefined;
	const finish = () => {
		if (onAbort) {
			watch.signal.removeEventListener("abort", onAbort);
			onAbort = undefined;
		}
		watch.dispose();
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const stop = (error: unknown) => {
				if (over) return;
				over = true;
				finish();
				void reader.cancel().catch(() => {});
				controller.error(error);
			};
			onAbort = () => stop(watch.signal.reason);
			watch.signal.addEventListener("abort", onAbort, { once: true });
			if (watch.signal.aborted) stop(watch.signal.reason);
		},
		async pull(controller) {
			if (over) return;
			watch.wait(true);
			let failure: unknown;
			try {
				const chunk = await reader.read();
				if (over) return;
				watch.rest();
				if (chunk.done) {
					over = true;
					finish();
					controller.close();
					return;
				}
				passed += chunk.value.byteLength;
				if (passed <= limit) {
					controller.enqueue(chunk.value);
					return;
				}
				failure = new BodyTooLarge();
			} catch (error) {
				failure = error;
			}
			if (over) return;
			over = true;
			finish();
			void reader.cancel().catch(() => {});
			controller.error(failure);
		},
		cancel(reason) {
			over = true;
			finish();
			return reader.cancel(reason).catch(() => {});
		},
	});
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
	const url = new URL(request.url);
	const prefix = "/member-company-gateway";
	const path = url.pathname.startsWith(`/functions/v1${prefix}/`)
		? url.pathname.slice(`/functions/v1${prefix}`.length)
		: url.pathname.startsWith(`${prefix}/`)
			? url.pathname.slice(prefix.length)
			: "";
	const policy = !url.search && route(path);
	if (
		origin &&
		!policy?.publicRoute &&
		!allowed.some((value) => {
			if (origin !== value) return false;
			try {
				const parsed = new URL(value);
				return parsed.protocol === "https:" && parsed.origin === value;
			} catch {
				return false;
			}
		})
	)
		return fail(403, "Browser origin is not allowed");
	if (origin) headers.set("access-control-allow-origin", policy?.publicRoute ? "*" : origin);
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
		if (policy.preflightSeconds) headers.set("access-control-max-age", String(policy.preflightSeconds));
		return new Response(null, { status: 204, headers });
	}
	if (request.method !== policy.method) return fail(405, "Method not allowed");
	if (!policy.publicRoute && !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(request.headers.get("authorization") ?? ""))
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
	const maxStreamMs = options.maxStreamMs ?? MAX_STREAM_MS;
	if (!Number.isSafeInteger(maxStreamMs) || maxStreamMs < 1 || maxStreamMs > MAX_STREAM_MS)
		return fail(503, "Member gateway is not configured");
	const scoped = new AbortController();
	const onCallerAbort = () => scoped.abort(request.signal.reason);
	if (request.signal.aborted) scoped.abort(request.signal.reason);
	else request.signal.addEventListener("abort", onCallerAbort, { once: true });
	const deadline = setTimeout(() => scoped.abort(new Error("Member gateway timed out")), timeout);
	const signal = scoped.signal;
	let watch: UpstreamWatch | undefined;
	let handedOffWatch = false;
	try {
		// A write states its length, within the gateway's bound for its route: a folder commit, a presence report, a chat
		// image or a call to the company's data. A chunked body of unknown length is refused unread.
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
		// A route that asks no auth service takes only a member's own token that has not run out, and of the issuer the
		// deployment names when it names one: nobody's request goes further than here (20260930745000).
		if (
			policy.memberToken &&
			!memberTokenShaped(
				request.headers.get("authorization") ?? "",
				options.memberTokenIssuer,
				Math.floor((options.now ?? Date.now)() / 1000),
			)
		)
			return refuse(401, "Member sign-in is required");
		if (!policy.publicRoute && size > 0 && !(policy.readsSmallBodyFirst && size <= (policy.maxBody ?? 0))) {
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
		watch = policy.passesBodyThrough ? watchUpstream(request.signal, timeout, maxStreamMs) : undefined;
		try {
			const forwarded = new Headers();
			for (const name of [...policy.headers, ...(policy.proxyHeaders ?? [])]) {
				const value = request.headers.get(name);
				if (value !== null) forwarded.set(name, value);
			}
			if (body) forwarded.set("content-length", String(body.byteLength));
			if (policy.forwardsOrigin && origin) forwarded.set("origin", origin);
			watch?.wait();
			const response = await (options.fetchImplementation ?? fetch)(new URL(path, upstream), {
				method: request.method,
				headers: forwarded,
				body,
				signal: watch?.signal ?? signal,
				redirect: "error",
				credentials: "omit",
			});
			watch?.rest();
			const empty = [204, 205, 304].includes(response.status);
			const answered = new Headers(headers);
			for (const name of ["content-type", "x-qorpera-access-mode", "etag"]) {
				const value = response.headers.get(name);
				if (value !== null) answered.set(name, value);
			}
			answered.set("access-control-expose-headers", "x-qorpera-access-mode, etag");
			if (watch && response.body && !empty) {
				if (Number(response.headers.get("content-length") ?? "0") > MAX_BYTES) {
					void response.body.cancel().catch(() => {});
					return fail(502, policy.unavailable);
				}
				handedOffWatch = true;
				return new Response(passedThrough(response.body, MAX_BYTES, watch), {
					status: response.status,
					headers: answered,
				});
			}
			const content = await bytes(response, MAX_BYTES, signal);
			return new Response(empty ? null : content, { status: response.status, headers: answered });
		} catch (error) {
			watch?.rest();
			return fail(error instanceof BodyTooLarge ? 502 : 503, policy.unavailable);
		}
	} finally {
		clearTimeout(deadline);
		request.signal.removeEventListener("abort", onCallerAbort);
		if (!handedOffWatch) watch?.dispose();
	}
}
