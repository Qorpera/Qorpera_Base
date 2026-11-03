/* Company sites: serving (publish_site; design in the feature PR and supabase/CLIENT-CONTRACT.md, "Company sites").
 *
 * An agent publishes a static site from the company folder; this function serves it at
 * https://sites.qorpera.com/<slug>/, behind the site's password. The sites host's front (envoy-front, the sites virtual
 * host in deploy/sites/envoy-front-sites.yaml) rewrites every path there to /functions/v1/site-serve/<path> and sets
 * x-forwarded-host to the sites host; the API host answers 404 for /functions/v1/site-serve, so agent-made content is
 * never served from api.qorpera.com or app.qorpera.com. The function also refuses any request whose x-forwarded-host
 * (else host) is not the sites host. It holds no company data: the database (qorpera_site_serve, qorpera_site_unlock,
 * service role only) decides every answer, and the function reaches it with the platform's service key.
 *
 * Every site shares the one origin, so isolation comes from the browser: a site's files are served with a CSP
 * `sandbox` that leaves out allow-same-origin, so each document has an opaque origin and cannot read another site's
 * files, cookies or storage, or the platform's pages. A browser sends no SameSite cookie on requests from such a
 * document (its subresources and its links), so a site's files are served only under a session's path:
 * /<slug>/~<token>/<path>, where the token (32 characters, 30 days, ended by a password change) is the capability.
 * Relative links stay in it; Referrer-Policy no-referrer keeps it out of other sites' logs. The plain URL
 * /<slug>/<path> is the one a founder shares: with the session's cookie (HttpOnly, Secure, SameSite=Strict, Path
 * /<slug>/, set when the password was right) it redirects into the session's path, otherwise it shows the password
 * page. A cross-site navigation carries no Strict cookie, so it first gets a page that reloads itself once (same
 * origin, which sends the cookie the browser holds). The form posts to /<slug>/.qorpera/unlock; the database limits
 * wrong passwords per visitor and per site.
 *
 * Answers: a site file 200/206/304 (GET, HEAD, single byte ranges, ETag = its sha256), 308 to add a folder's slash,
 * 303 from a session path whose session ended back to the plain URL, the platform's own pages (password 401, a page
 * that is not part of the site 404, too many tries 429, unavailable 503), 405 for other methods, robots.txt at the
 * root. An unknown site looks like a locked one, so the host shows nothing of which sites exist. Never logged: a
 * token, a password or a cookie. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const DEFAULT_SITES_ORIGIN = "https://sites.qorpera.com";
/** The password form's body: a password and a path, far below this. */
export const MAX_UNLOCK_BODY_BYTES = 4096;
/** The largest answer the database may give: a 10 MiB file in base64 and its fields. */
export const MAX_STORE_ANSWER_BYTES = 16 * 1024 * 1024;
export const COOKIE = "qorpera_site";
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/;
const MAX_SEGMENTS = 16;
const MAX_PATH = 512;
const MAX_PASSWORD = 1024;
const ROUTE = /^(?:\/functions\/v1)?\/site-serve(\/.*)?$/;

/** What a site's file is served with: its own sandbox, so it never runs as the sites origin. */
export const CONTENT_SECURITY_POLICY =
	"sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors 'none'";
/** The platform's pages: no script, no framing, forms only to this origin. */
export const PAGE_SECURITY_POLICY =
	"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The database's two doors, service role only. A thrown error means it could not answer. */
export interface SiteStore {
	serve(slug: string, path: string, token: string | null, etag: string | null): Promise<unknown>;
	unlock(slug: string, password: string, client: string): Promise<unknown>;
}

export interface SiteServeOptions {
	/** The sites origin, e.g. https://sites.qorpera.com. */
	origin: string;
	store: SiteStore;
}

type ServeAnswer =
	| { state: "locked" }
	| { state: "missing" }
	| { state: "directory"; path: string }
	| { state: "file"; path: string; contentType: string; bytes: number; sha256: string; content: string | null };

type UnlockAnswer =
	| { state: "open"; token: string; maxAge: number }
	| { state: "wrong" }
	| { state: "limited"; retryAfter: number };

class InvalidAnswer extends Error {}

function invalid(): never {
	throw new InvalidAnswer("The database's answer is invalid");
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
	return record;
}

/** A site path as stored: segments of letters, digits, `.`, `_` and `-` (none `.` or `..`, none starting with a dot),
 * at most 16, at most 512 characters, the last one empty for a folder. */
export function isSitePath(path: string): boolean {
	if (path.length > MAX_PATH) return false;
	if (path === "") return true;
	const segments = path.split("/");
	const last = segments.at(-1) === "" ? segments.length - 1 : segments.length;
	if (last > MAX_SEGMENTS) return false;
	return segments.every((segment, index) => (index === last && segment === "") || SEGMENT.test(segment));
}

export function parseServeAnswer(value: unknown, etag: string | null): ServeAnswer {
	const state = (value as { state?: unknown } | null)?.state;
	if (state === "locked" || state === "missing") {
		closed(value, ["state"]);
		return { state };
	}
	if (state === "directory") {
		const answer = closed(value, ["state", "path"]);
		if (typeof answer.path !== "string" || !answer.path.endsWith("/") || !isSitePath(answer.path)) invalid();
		return { state, path: answer.path };
	}
	if (state !== "file") invalid();
	const answer = closed(value, ["state", "path", "contentType", "bytes", "sha256", "content"]);
	if (
		typeof answer.path !== "string" ||
		answer.path === "" ||
		answer.path.endsWith("/") ||
		!isSitePath(answer.path) ||
		typeof answer.contentType !== "string" ||
		!Number.isSafeInteger(answer.bytes) ||
		(answer.bytes as number) < 0 ||
		typeof answer.sha256 !== "string" ||
		!SHA256.test(answer.sha256) ||
		!(answer.content === null || (typeof answer.content === "string" && BASE64.test(answer.content))) ||
		// The content is left out only when the visitor already holds exactly this file.
		(answer.content === null && answer.sha256 !== etag)
	)
		invalid();
	return {
		state,
		path: answer.path,
		// A type the database would never store is served as bytes.
		contentType: CONTENT_TYPE.test(answer.contentType) ? answer.contentType : "application/octet-stream",
		bytes: answer.bytes as number,
		sha256: answer.sha256,
		content: answer.content as string | null,
	};
}

export function parseUnlockAnswer(value: unknown): UnlockAnswer {
	const state = (value as { state?: unknown } | null)?.state;
	if (state === "wrong") {
		closed(value, ["state"]);
		return { state };
	}
	if (state === "open") {
		const answer = closed(value, ["state", "token", "maxAge"]);
		if (
			typeof answer.token !== "string" ||
			!TOKEN.test(answer.token) ||
			!Number.isSafeInteger(answer.maxAge) ||
			(answer.maxAge as number) < 60 ||
			(answer.maxAge as number) > 400 * 24 * 3600
		)
			invalid();
		return { state, token: answer.token, maxAge: answer.maxAge as number };
	}
	if (state !== "limited") invalid();
	const answer = closed(value, ["state", "retryAfter"]);
	if (!Number.isSafeInteger(answer.retryAfter) || (answer.retryAfter as number) < 0) invalid();
	return { state, retryAfter: Math.max(1, answer.retryAfter as number) };
}

// --- Language and pages ---------------------------------------------------------------------------------------------

type Language = "en" | "da";

/** Danish when the visitor's first preference between Danish and English is Danish. */
export function language(header: string | null): Language {
	const tags = (header ?? "")
		.split(",")
		.map((part, index) => {
			const [tag = "", ...parameters] = part.trim().toLowerCase().split(";");
			const q = parameters.map((item) => /^\s*q=([0-9.]+)\s*$/.exec(item)?.[1]).find(Boolean);
			return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
		})
		.filter((item) => Number.isFinite(item.q) && item.q > 0)
		.sort((a, b) => b.q - a.q || a.index - b.index);
	for (const { tag } of tags) {
		if (tag === "da" || tag.startsWith("da-")) return "da";
		if (tag === "en" || tag.startsWith("en-")) return "en";
	}
	return "en";
}

const TEXT = {
	en: {
		private: "Private site",
		lead: "This site is private. Enter the password you were given.",
		password: "Password",
		open: "Open",
		wrong: "That password is not right. Try again.",
		empty: "Enter the password.",
		limited: (minutes: number) => `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
		notFound: "Page not found",
		notPart: "This page is not part of the site.",
		nothing: "There is no page at this address.",
		unavailable: "Not available",
		unavailableLead: "The site can't be shown right now. Try again in a moment.",
		opening: "Opening…",
		continue: "Continue",
		refused: "This form can only be sent from the site's own password page.",
		footer: "Shared with Qorpera",
	},
	da: {
		private: "Privat side",
		lead: "Siden er privat. Skriv den adgangskode, du har fået.",
		password: "Adgangskode",
		open: "Åbn",
		wrong: "Adgangskoden er forkert. Prøv igen.",
		empty: "Skriv adgangskoden.",
		limited: (minutes: number) =>
			`For mange forsøg. Prøv igen om ${minutes} ${minutes === 1 ? "minut" : "minutter"}.`,
		notFound: "Siden blev ikke fundet",
		notPart: "Denne side hører ikke til sitet.",
		nothing: "Der er ingen side på denne adresse.",
		unavailable: "Ikke tilgængelig",
		unavailableLead: "Sitet kan ikke vises lige nu. Prøv igen om lidt.",
		opening: "Åbner…",
		continue: "Fortsæt",
		refused: "Formularen kan kun sendes fra sitets egen adgangskodeside.",
		footer: "Delt med Qorpera",
	},
} as const;

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
	);
}

const STYLE = `:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1c1a;--muted:#6b6862;--line:#dcd9d2;--accent:#1d1c1a;--accent-text:#fff;--error:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--text:#edebe6;--muted:#a4a19a;--line:#3a3935;--accent:#edebe6;--accent-text:#161615;--error:#f2b8b5}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
h1{font-size:1.25rem;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-size:.875rem;font-weight:600;margin-bottom:6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button,a.button{display:inline-block;margin-top:14px;width:100%;font:inherit;font-weight:600;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);cursor:pointer;text-align:center;text-decoration:none}
.error{color:var(--error);margin:12px 0 0}footer{margin-top:16px;font-size:.75rem;color:var(--muted)}`;

function page(lang: Language, title: string, body: string, head = ""): string {
	return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main><footer>${escapeHtml(TEXT[lang].footer)}</footer></body></html>
`;
}

function passwordPage(lang: Language, slug: string, next: string, error?: string): string {
	const text = TEXT[lang];
	return page(
		lang,
		text.private,
		`<h1>${escapeHtml(text.private)}</h1><p>${escapeHtml(text.lead)}</p>` +
			`<form method="post" action="/${slug}/.qorpera/unlock"><input type="hidden" name="next" value="${escapeHtml(next)}">` +
			`<label for="password">${escapeHtml(text.password)}</label>` +
			`<input id="password" name="password" type="password" required maxlength="128" autocomplete="off" autofocus>` +
			`${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}` +
			`<button type="submit">${escapeHtml(text.open)}</button></form>`,
	);
}

function messagePage(lang: Language, title: string, lead: string): string {
	return page(lang, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(lead)}</p>`);
}

function refreshPage(lang: Language): string {
	const text = TEXT[lang];
	return page(
		lang,
		text.opening,
		`<h1>${escapeHtml(text.opening)}</h1><a class="button" href="">${escapeHtml(text.continue)}</a>`,
		'<meta http-equiv="refresh" content="0">',
	);
}

// --- Responses ------------------------------------------------------------------------------------------------------

/** Headers on every answer the platform itself writes. */
function pageHeaders(referrerPolicy: "no-referrer" | "same-origin" = "no-referrer"): Record<string, string> {
	return {
		"content-security-policy": PAGE_SECURITY_POLICY,
		"x-frame-options": "DENY",
		"x-content-type-options": "nosniff",
		"x-robots-tag": "noindex, nofollow, noarchive",
		"referrer-policy": referrerPolicy,
		"cache-control": "no-store",
	};
}

function htmlAnswer(
	request: Request,
	html: string,
	status: number,
	extra: Record<string, string> = {},
	referrerPolicy: "no-referrer" | "same-origin" = "no-referrer",
): Response {
	const bytes = new TextEncoder().encode(html);
	return new Response(request.method === "HEAD" ? null : bytes, {
		status,
		headers: {
			...pageHeaders(referrerPolicy),
			"content-type": "text/html; charset=utf-8",
			"content-length": String(bytes.byteLength),
			...extra,
		},
	});
}

function redirect(location: string, status: 303 | 308, extra: Record<string, string> = {}): Response {
	return new Response(null, { status, headers: { ...pageHeaders(), location, ...extra } });
}

function robots(request: Request): Response {
	const bytes = new TextEncoder().encode("User-agent: *\nDisallow: /\n");
	return new Response(request.method === "HEAD" ? null : bytes, {
		status: 200,
		headers: {
			...pageHeaders(),
			"content-type": "text/plain; charset=utf-8",
			"content-length": String(bytes.byteLength),
		},
	});
}

function notAllowed(allow: string): Response {
	return new Response(null, { status: 405, headers: { ...pageHeaders(), allow } });
}

/** Headers on every file of a site. */
function contentHeaders(file: { contentType: string; sha256: string }): Record<string, string> {
	return {
		"content-type": file.contentType,
		"content-security-policy": CONTENT_SECURITY_POLICY,
		"x-frame-options": "DENY",
		"x-content-type-options": "nosniff",
		"x-robots-tag": "noindex, nofollow, noarchive",
		"referrer-policy": "no-referrer",
		"cache-control": "private, no-cache",
		etag: `"${file.sha256}"`,
		// A document of the site has an opaque origin, so its module scripts and fonts are CORS fetches. The token in the
		// path is the capability; no cookie is used here.
		"access-control-allow-origin": "*",
		"accept-ranges": "bytes",
	};
}

/** The sha256 a visitor's If-None-Match names, when it names one. */
export function requestedEtag(header: string | null): string | null {
	for (const part of (header ?? "").split(",")) {
		const tag = part
			.trim()
			.replace(/^W\//, "")
			.replace(/^"(.*)"$/, "$1");
		if (SHA256.test(tag)) return tag;
	}
	return null;
}

/** One byte range of a file of `size` bytes, from a Range header: undefined to serve it whole (no header, several
 * ranges or one this does not read), "unsatisfiable" for a range past its end. */
export function byteRange(
	header: string | null,
	size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
	if (!match || (match[1] === "" && match[2] === "")) return undefined;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix)) return undefined;
		if (suffix === 0 || size === 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
	if (match[2] !== "" && Number(match[2]) < start) return undefined;
	if (start >= size) return "unsatisfiable";
	return { start, end };
}

function fileAnswer(request: Request, file: Extract<ServeAnswer, { state: "file" }>, etag: string | null): Response {
	const headers = contentHeaders(file);
	if (file.content === null || etag === file.sha256) return new Response(null, { status: 304, headers });
	const bytes = new Uint8Array(Buffer.from(file.content, "base64"));
	// The bytes the database holds for this file, exactly.
	if (bytes.byteLength !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) invalid();
	const ifRange = request.headers.get("if-range");
	const range =
		ifRange === null || ifRange.replace(/^"(.*)"$/, "$1") === file.sha256
			? byteRange(request.headers.get("range"), bytes.byteLength)
			: undefined;
	if (range === "unsatisfiable")
		return new Response(null, {
			status: 416,
			headers: { ...headers, "content-range": `bytes */${bytes.byteLength}` },
		});
	const part = range ? bytes.subarray(range.start, range.end + 1) : bytes;
	return new Response(request.method === "HEAD" ? null : part, {
		status: range ? 206 : 200,
		headers: {
			...headers,
			"content-length": String(part.byteLength),
			...(range ? { "content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}` } : {}),
		},
	});
}

// --- Requests -------------------------------------------------------------------------------------------------------

/** The site path a URL's raw segments name, each decoded on its own (so an escaped slash is never a separator), or
 * null when it is not one. */
function sitePath(segments: readonly string[]): string | null {
	const decoded: string[] = [];
	for (const [index, segment] of segments.entries()) {
		let value: string;
		try {
			value = decodeURIComponent(segment);
		} catch {
			return null;
		}
		if (!(SEGMENT.test(value) || (value === "" && index === segments.length - 1))) return null;
		decoded.push(value);
	}
	const path = decoded.join("/");
	return isSitePath(path) ? path : null;
}

function cookieToken(header: string | null): string | null {
	for (const part of (header ?? "").split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === COOKIE) {
			const value = rest.join("=");
			return TOKEN.test(value) ? value : null;
		}
	}
	return null;
}

/** The host the request came in on: the sites host front's x-forwarded-host, else Host. */
function requestHost(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-host");
	return ((forwarded ?? request.headers.get("host") ?? "").split(",")[0] ?? "").trim().toLowerCase();
}

/** Reads a body up to `limit` bytes; null when it is longer. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > limit) return null;
			chunks.push(chunk.value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function unavailable(request: Request, lang: Language, error: unknown): Response {
	// The error's kind only: never a token, a password or a cookie.
	console.error(`site-serve: the database could not answer (${error instanceof Error ? error.name : typeof error})`);
	const text = TEXT[lang];
	return htmlAnswer(request, messagePage(lang, text.unavailable, text.unavailableLead), 503, { "retry-after": "30" });
}

function notFound(request: Request, lang: Language, lead: string = TEXT[lang].nothing): Response {
	return htmlAnswer(request, messagePage(lang, TEXT[lang].notFound, lead), 404);
}

/** The password page, at the plain URL it was asked at (it is no session path, so its own referrer policy can let the
 * form's POST carry its origin). */
function locked(
	request: Request,
	lang: Language,
	slug: string,
	next: string,
	status: number,
	error?: string,
	extra: Record<string, string> = {},
): Response {
	return htmlAnswer(request, passwordPage(lang, slug, next, error), status, extra, "same-origin");
}

/** The Edge Function. */
export async function handleSiteServe(request: Request, options: SiteServeOptions): Promise<Response> {
	const origin = new URL(options.origin);
	const lang = language(request.headers.get("accept-language"));
	const route = ROUTE.exec(new URL(request.url).pathname);
	// Only through the sites host: never as the API's or the app's origin.
	if (!route || requestHost(request) !== origin.host) return notFound(request, lang);
	const rest = route[1] ?? "/";
	const method = request.method;
	if (rest === "/" || rest === "/robots.txt") {
		if (method !== "GET" && method !== "HEAD") return notAllowed("GET, HEAD");
		return rest === "/" ? notFound(request, lang) : robots(request);
	}
	const segments = rest.slice(1).split("/");
	const slug = segments[0] ?? "";
	if (!SLUG.test(slug)) return notFound(request, lang);
	const search = new URL(request.url).search;
	if (segments.length === 1) return redirect(`/${slug}/${search}`, 308);
	const second = segments[1] ?? "";

	// The password form.
	if (second === ".qorpera") {
		if (segments.length !== 3 || segments[2] !== "unlock") return notFound(request, lang);
		if (method === "GET" || method === "HEAD") return redirect(`/${slug}/`, 303);
		if (method !== "POST") return notAllowed("POST");
		return unlock(request, options, lang, slug);
	}

	// A session's path: the site's files.
	if (second.startsWith("~")) {
		const token = second.slice(1);
		if (!TOKEN.test(token)) return notFound(request, lang);
		if (segments.length === 2) return redirect(`/${slug}/~${token}/${search}`, 308);
		const path = sitePath(segments.slice(2));
		if (path === null) return notFound(request, lang);
		if (method === "OPTIONS")
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, HEAD",
					"access-control-allow-headers": "Range, If-None-Match",
					"access-control-max-age": "600",
				},
			});
		if (method !== "GET" && method !== "HEAD") return notAllowed("GET, HEAD, OPTIONS");
		const etag = requestedEtag(request.headers.get("if-none-match"));
		try {
			const answer = parseServeAnswer(await options.store.serve(slug, path, token, etag), etag);
			if (answer.state === "file") return fileAnswer(request, answer, etag);
			if (answer.state === "directory") return redirect(`/${slug}/~${token}/${answer.path}${search}`, 308);
			if (answer.state === "missing") return notFound(request, lang, TEXT[lang].notPart);
			// The session ended: the plain URL asks for the password again.
			return redirect(`/${slug}/${path}${search}`, 303);
		} catch (error) {
			return unavailable(request, lang, error);
		}
	}

	// The plain URL a founder shares.
	const path = sitePath(segments.slice(1));
	if (path === null) return notFound(request, lang);
	if (method !== "GET" && method !== "HEAD") return notAllowed("GET, HEAD");
	const cookieHeader = request.headers.get("cookie");
	const token = cookieToken(cookieHeader);
	if (token) {
		try {
			const answer = parseServeAnswer(await options.store.serve(slug, path, token, null), null);
			if (answer.state !== "locked") return redirect(`/${slug}/~${token}/${path}${search}`, 303);
		} catch (error) {
			return unavailable(request, lang, error);
		}
		// The session ended: its cookie goes with it.
		return locked(request, lang, slug, path, 401, undefined, {
			"set-cookie": `${COOKIE}=; Path=/${slug}/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
		});
	}
	// A navigation from another site carries no SameSite=Strict cookie: reload once from this origin, which does.
	if (
		method === "GET" &&
		!cookieHeader?.includes(`${COOKIE}=`) &&
		request.headers.get("sec-fetch-site") === "cross-site" &&
		request.headers.get("sec-fetch-mode") === "navigate"
	)
		return htmlAnswer(request, refreshPage(lang), 200);
	return locked(request, lang, slug, path, 401);
}

async function unlock(request: Request, options: SiteServeOptions, lang: Language, slug: string): Promise<Response> {
	const text = TEXT[lang];
	const sent = request.headers.get("origin");
	if (sent !== null && sent !== new URL(options.origin).origin)
		return htmlAnswer(request, messagePage(lang, text.private, text.refused), 403);
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
		return htmlAnswer(request, messagePage(lang, text.private, text.refused), 415);
	const body = await readBody(request, MAX_UNLOCK_BODY_BYTES);
	if (!body) return htmlAnswer(request, messagePage(lang, text.private, text.refused), 413);
	let form: URLSearchParams;
	try {
		form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return htmlAnswer(request, messagePage(lang, text.private, text.refused), 400);
	}
	const sentNext = form.get("next") ?? "";
	const next = isSitePath(sentNext) ? sentNext : "";
	const password = form.get("password") ?? "";
	if (!password || password.length > MAX_PASSWORD) return locked(request, lang, slug, next, 401, text.empty);
	let answer: UnlockAnswer;
	try {
		answer = parseUnlockAnswer(
			await options.store.unlock(
				slug,
				password,
				(request.headers.get("cf-connecting-ip") ?? "").trim().slice(0, 64),
			),
		);
	} catch (error) {
		return unavailable(request, lang, error);
	}
	if (answer.state === "wrong") return locked(request, lang, slug, next, 401, text.wrong);
	if (answer.state === "limited")
		return locked(request, lang, slug, next, 429, text.limited(Math.ceil(answer.retryAfter / 60)), {
			"retry-after": String(answer.retryAfter),
		});
	return redirect(`/${slug}/~${answer.token}/${next}`, 303, {
		"set-cookie": `${COOKIE}=${answer.token}; Path=/${slug}/; Max-Age=${answer.maxAge}; HttpOnly; Secure; SameSite=Strict`,
	});
}

// --- The database ---------------------------------------------------------------------------------------------------

/** The headers a Supabase secret key travels in: a legacy service role JWT is also the bearer. */
export function serviceHeaders(secretKey: string): Record<string, string> {
	return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secretKey)
		? { apikey: secretKey, authorization: `Bearer ${secretKey}` }
		: { apikey: secretKey };
}

/** The two RPCs through PostgREST with the service key: no redirect, a deadline, an answer of at most 16 MiB. */
export class PostgrestSiteStore implements SiteStore {
	readonly #projectUrl: string;
	readonly #secretKey: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(projectUrl: string, secretKey: string, fetcher: typeof fetch = fetch, timeoutMs = 20_000) {
		this.#projectUrl = projectUrl.replace(/\/+$/, "");
		this.#secretKey = secretKey;
		this.#fetch = fetcher;
		this.#timeoutMs = timeoutMs;
	}

	serve(slug: string, path: string, token: string | null, etag: string | null): Promise<unknown> {
		return this.#call("qorpera_site_serve", { p_slug: slug, p_path: path, p_token: token, p_etag: etag });
	}

	unlock(slug: string, password: string, client: string): Promise<unknown> {
		return this.#call("qorpera_site_unlock", { p_slug: slug, p_password: password, p_client: client });
	}

	async #call(name: string, args: Record<string, unknown>): Promise<unknown> {
		const response = await this.#fetch(`${this.#projectUrl}/rest/v1/rpc/${name}`, {
			method: "POST",
			redirect: "error",
			headers: { ...serviceHeaders(this.#secretKey), "content-type": "application/json" },
			body: JSON.stringify(args),
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`The database answered HTTP ${response.status}`);
		}
		const declared = response.headers.get("content-length");
		if (declared !== null && Number(declared) > MAX_STORE_ANSWER_BYTES) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error("The database's answer is too large");
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("The database answered without a body");
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				total += chunk.value.byteLength;
				if (total > MAX_STORE_ANSWER_BYTES) throw new Error("The database's answer is too large");
				chunks.push(chunk.value);
			}
		} finally {
			void reader.cancel().catch(() => undefined);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	}
}
