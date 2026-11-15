/* Company sites: serving (publish_site; design in the feature PR and supabase/CLIENT-CONTRACT.md, "Company sites").
 *
 * An agent publishes a static site from the company folder; this function serves it at
 * https://sites.qorpera.com/<slug>/, behind the site's password. The sites host's front (envoy-front, the sites virtual
 * host in deploy/sites/envoy-front-sites.yaml) rewrites every path there to /functions/v1/site-serve/<path> and sets
 * x-forwarded-host to the sites host; the API host answers 404 for /functions/v1/site-serve and replaces a visitor's
 * x-forwarded-host with the name the request asked for, so agent-made content is never served from api.qorpera.com or
 * app.qorpera.com. The function also refuses any request whose x-forwarded-host is not exactly the sites host (Host
 * never decides). It holds no company data: the database (qorpera_site_serve, qorpera_site_unlock, service role only)
 * decides every answer, and the function reaches it with the platform's service key. The password limits key on
 * CF-Connecting-IP only, which Cloudflare sets itself.
 *
 * Every site shares the one origin, so isolation comes from the browser: a site's files are served with a CSP
 * `sandbox` that leaves out allow-same-origin, so each document has an opaque origin and cannot read another site's
 * files, cookies or storage, or the platform's pages. A browser sends no SameSite cookie on requests from such a
 * document (its subresources and its links), so a site's files are served only under a session's path:
 * /<slug>/~<token>/<path>, where the token (32 characters, 7 days, ended by a password change) is the capability.
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
 * token, a password or a cookie.
 *
 * An address of its own (own code storage, step 5, release 5.1; lanes/own-code-storage/STEP5-BUILD.md). A files site
 * also has its own host, https://<slug>.qorpera.com/, served at the top so links from / work, and a next host,
 * https://<slug>--next.qorpera.com/, where an owner or admin looks at a version before it goes live (Look first). The
 * front's site-hosts virtual host sends every first-level name under qorpera.com here, x-forwarded-host set to it.
 * Whether a host is one is the one host rule SQL, this function and the web share (SITE_HOST, decided before any
 * database call); the database decides the rest (qorpera_site_serve_host, qorpera_site_unlock_host, qorpera_site_enter):
 * while its hosts_enabled is on, the old host's links move (308; 303 for its password form and any other method) to the
 * own host; a site Qorpera took down answers 410 on every host; a host with no site looks like a locked one. On the old
 * host the database is asked first for a path that names a site, and today's handler answers whatever it calls legacy.
 * A database without these calls (PGRST202, a function installed before its migration) is read as legacy everywhere,
 * and today's handler answers a site host 404.
 *
 * A site host is its own origin, so a site's files are served with no sandbox. The session is the host-only cookie
 * __Host-qorpera_site (no Domain, Path=/, Secure, HttpOnly, SameSite=Lax): a visitor's after the password on the own
 * host, a member's after a one-time ticket (/.qorpera/enter?t=) on the next host, which serves the version the ticket
 * named with a "Not live yet" bar appended to its HTML. Every site is same-site with every other and with the platform,
 * so no cookie a browser sends by itself is proof unless the answer also refuses other origins: on a site host a
 * request that is neither same-origin, nor typed in (Sec-Fetch-Site none), nor a top-level document navigation is
 * refused 403 before any database call (a request without Fetch Metadata passes); a service worker's script is refused
 * 404; every answer carries Cross-Origin-Resource-Policy same-origin, frame-ancestors 'self' with X-Frame-Options
 * SAMEORIGIN, no Access-Control-Allow-Origin, Strict-Transport-Security without includeSubDomains, an explicit
 * Cache-Control with no-transform (the zone's browser cache default is 4 hours and its features rewrite HTML) and
 * CDN-Cache-Control no-store; the password form and the ticket refuse an Origin that is not the host's own.
 *
 * Views (the company's numbers, door site; migration 20260930768000). After a page is answered, one call counts it
 * (qorpera_site_count_view), only for a GET answered 200 or 304 with a text/html file of the live version by a visitor's
 * session, with no Range, Sec-Fetch-Dest document or absent and no prefetch (Sec-Purpose, Purpose): on the own host and
 * on the old host's session paths, never on a next host, for an asset, a HEAD, the password page or a refusal. The call
 * sends the host, the file's path and the session's token, nothing of the request's headers, and never changes the
 * answer: it is handed to the edge runtime's waitUntil, or, without one, waited for at most 200 ms. A failure is logged
 * by its kind only.
 *
 * Seen inside Qorpera (company views step 4, slice V1; migration 20260930774000). The web shows a site in a frame on its
 * own host. A member's one-use pass (qorpera_site_member_pass, 60 seconds) is posted by a form of one of the web's
 * origins (QORPERA_WEB_ORIGINS, compared exactly) to POST /__qorpera/member, redeemed through the database
 * (qorpera_site_member_pass_redeem) for a member's session in the same cookie a right password sets, and answered 303 to
 * the top or a same-host path the form names; a pass that fails answers as a wrong password. The folder __qorpera/ is the
 * platform's on every site host: no site's file is served from it. Every own-host answer may be framed by the site's own
 * pages and the web's origins (frame-ancestors, no X-Frame-Options, which cannot name another origin), so on an own host
 * a frame's navigation (Sec-Fetch-Dest iframe) passes Fetch Metadata and frame-ancestors decides; a next host keeps
 * 'self' and X-Frame-Options SAMEORIGIN. A member's session is never counted as a view (the database skips it). */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const DEFAULT_SITES_ORIGIN = "https://sites.qorpera.com";
/** The web's origins when QORPERA_WEB_ORIGINS is not set: the production app. */
export const DEFAULT_WEB_ORIGINS: readonly string[] = ["https://app.qorpera.com"];
/** The password form's body: a password and a path, far below this. */
export const MAX_UNLOCK_BODY_BYTES = 4096;
/** The most bytes of a file one answer carries: a whole file at its largest. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
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

/** A site's own host or next host, lower-cased: the one host rule SQL (qorpera_site_host_pattern), this function and the
 * web share (STEP5-BUILD.md, release 5.1, item 3). The one label before qorpera.com is a name of letters and digits in
 * runs joined by single hyphens (group 1, the slug, which can never hold `--`), then `--next` on a next host (group 2).
 * The slug is also 3 to 48 long (SITE_HOST_SLUG_LENGTH); SQL checks the rest of the name rule. */
export const SITE_HOST = /^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$/;
const SITE_HOST_SLUG_LENGTH = { min: 3, max: 48 } as const;
/** The session cookie on a site host: host-only, so a visitor's on the own host and a member's on the next host never
 * meet, and no sibling can set or overwrite it. */
export const HOST_COOKIE = "__Host-qorpera_site";
/** Look first's one-time ticket: 32 random bytes, base64url without padding. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;
/** A site's file on a site host: its own origin, no sandbox; framed only by its own pages. */
export const HOST_CONTENT_SECURITY_POLICY = "frame-ancestors 'self'";
/** The platform's pages on a site host: as PAGE_SECURITY_POLICY, framed only by the site's own pages. */
export const HOST_PAGE_SECURITY_POLICY =
	"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'";
/** The platform's folder on a site host: no site's file is ever served from it. */
const PLATFORM_FOLDER = "__qorpera";
/** The member's door on an own host: a one-use pass from the web, posted in a form's body. */
export const MEMBER_PATH = `/${PLATFORM_FOLDER}/member`;
/** A member pass: 32 random bytes, base64url without padding, as Look first's ticket. */
const PASS = TICKET;

/** A site's file on an own host: framed by its own pages and the web's (V1). */
export function ownContentSecurityPolicy(webOrigins: readonly string[]): string {
	return `frame-ancestors 'self' ${webOrigins.join(" ")}`;
}

/** The platform's pages on an own host: as HOST_PAGE_SECURITY_POLICY, framed by the site's own pages and the web's. */
export function ownPageSecurityPolicy(webOrigins: readonly string[]): string {
	return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self' ${webOrigins.join(" ")}; base-uri 'none'`;
}

/** An https origin's shape: a host name of letters, digits, hyphens and dots, and a port. */
const WEB_ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$/;

/** The web's origins from QORPERA_WEB_ORIGINS (the stack's JSON array of exact origins, which other functions read too):
 * its entries that are an https origin and nothing more (no path, query, credentials or trailing slash), since each is
 * compared exactly with a request's Origin and written into frame-ancestors; at most eight. Any other entry is left out
 * (an http address of a developer's machine, say), and a value that is not set, not such an array, or holds none:
 * DEFAULT_WEB_ORIGINS. Never a throw: this public function must start whatever the stack's value is. */
export function webOrigins(value: string | undefined): readonly string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value ?? "");
	} catch {
		return DEFAULT_WEB_ORIGINS;
	}
	if (!Array.isArray(parsed)) return DEFAULT_WEB_ORIGINS;
	const origins = parsed.filter((item): item is string => {
		// Host names only: never a wildcard or anything else frame-ancestors would read as more than one origin.
		if (typeof item !== "string" || !WEB_ORIGIN.test(item)) return false;
		try {
			// Its own canonical form: no default port, a port that is one.
			return new URL(item).origin === item;
		} catch {
			return false;
		}
	});
	return origins.length > 0 ? [...new Set(origins)].slice(0, 8) : DEFAULT_WEB_ORIGINS;
}

/** Never includeSubDomains: the hosts beside a site's are the platform's and other companies'. */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";
/** Every answer that is not a private site file: never stored, never rewritten on the way. Every answer of this function
 * carries an explicit Cache-Control with no-transform (D23), the old host's too. */
const NO_STORE = "no-store, no-transform";

/** The database's doors, service role only. A thrown error means it could not answer; MissingFunction means the
 * database has no such call yet (PGRST202). */
export interface SiteStore {
	/** One file for a session: its bytes from `offset`, at most `length` of them (0 for none: a HEAD, a check). */
	serve(
		slug: string,
		path: string,
		token: string | null,
		etag: string | null,
		offset: number,
		length: number,
	): Promise<unknown>;
	unlock(slug: string, password: string, client: string): Promise<unknown>;
	/** What a host answers (qorpera_site_serve_host): on the old host whether the path's site moved or is gone, on a site
	 * host one file for a session as `serve` gives it, with its status and scope. */
	serveHost(
		host: string,
		path: string,
		token: string | null,
		etag: string | null,
		offset: number,
		length: number,
	): Promise<unknown>;
	/** An own host's password (qorpera_site_unlock_host): `unlock`'s answers for the host's site. */
	unlockHost(host: string, password: string, client: string): Promise<unknown>;
	/** A next host's ticket for a member's session (qorpera_site_enter). */
	enter(host: string, ticket: string): Promise<unknown>;
	/** Counts a page view of a session (qorpera_site_count_view): the host, the answered file's path in the site (on the
	 * old host after the site's name, `<slug>/<path>`) and the session's token. Its answer is not read. */
	countView(host: string, path: string, token: string): Promise<unknown>;
	/** An own host's member pass for a member's session (qorpera_site_member_pass_redeem): `enter`'s answers. */
	memberPass(host: string, pass: string): Promise<unknown>;
}

/** The database has no such function yet (PostgREST's PGRST202): this function was installed before its migration. */
export class MissingFunction extends Error {}

export interface SiteServeOptions {
	/** The sites origin, e.g. https://sites.qorpera.com. */
	origin: string;
	store: SiteStore;
	/** The web's origins (QORPERA_WEB_ORIGINS): the only origins a member pass is taken from, and the ones an own host's
	 * answers may be framed by. DEFAULT_WEB_ORIGINS when not given. */
	webOrigins?: readonly string[];
	/** Keeps work going after the answer is sent: the edge runtime's EdgeRuntime.waitUntil when not given. Without
	 * either, a view's count is waited for at most COUNT_WAIT_MS. */
	waitUntil?: (work: Promise<unknown>) => void;
}

/** The longest an answer waits for its view's count when no waitUntil keeps the count going after it. */
export const COUNT_WAIT_MS = 200;
/** The deadline of the count's database call. */
export const COUNT_TIMEOUT_MS = 2000;

type ServeAnswer =
	| { state: "locked" }
	| { state: "missing" }
	| { state: "directory"; path: string }
	| {
			state: "file";
			path: string;
			contentType: string;
			bytes: number;
			sha256: string;
			offset: number;
			content: string | null;
	  };

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

export function parseServeAnswer(value: unknown, etag: string | null, options: { length: number }): ServeAnswer {
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
	const answer = closed(value, ["state", "path", "contentType", "bytes", "sha256", "offset", "content"]);
	return { state, ...fileFields(answer, answer.sha256 === etag, options.length) };
}

/** A file answer's fields, as qorpera_site_serve gives them. `held`: the visitor holds exactly this file, so its content
 * may be left out. */
function fileFields(
	answer: Record<string, unknown>,
	held: boolean,
	length: number,
): Omit<Extract<ServeAnswer, { state: "file" }>, "state"> {
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
		!Number.isSafeInteger(answer.offset) ||
		(answer.offset as number) < 0 ||
		(answer.offset as number) > (answer.bytes as number) ||
		!(answer.content === null || (typeof answer.content === "string" && BASE64.test(answer.content))) ||
		// The content is left out when the visitor holds exactly this file, when none was asked for, or when the bytes
		// asked for start at the file's end.
		(answer.content === null && !held && length > 0 && (answer.offset as number) < (answer.bytes as number))
	)
		invalid();
	return {
		path: answer.path,
		// A type the database would never store is served as bytes.
		contentType: CONTENT_TYPE.test(answer.contentType) ? answer.contentType : "application/octet-stream",
		bytes: answer.bytes as number,
		sha256: answer.sha256,
		offset: answer.offset as number,
		content: answer.content as string | null,
	};
}

export function parseUnlockAnswer(value: unknown): UnlockAnswer {
	const state = (value as { state?: unknown } | null)?.state;
	if (state === "wrong") {
		closed(value, ["state"]);
		return { state };
	}
	if (state === "open") return openAnswer(value);
	if (state !== "limited") invalid();
	const answer = closed(value, ["state", "retryAfter"]);
	if (!Number.isSafeInteger(answer.retryAfter) || (answer.retryAfter as number) < 0) invalid();
	return { state, retryAfter: Math.max(1, answer.retryAfter as number) };
}

/** A session opened: its token and how long the cookie keeps it. */
function openAnswer(value: unknown): { state: "open"; token: string; maxAge: number } {
	const answer = closed(value, ["state", "token", "maxAge"]);
	if (
		typeof answer.token !== "string" ||
		!TOKEN.test(answer.token) ||
		!Number.isSafeInteger(answer.maxAge) ||
		(answer.maxAge as number) < 60 ||
		(answer.maxAge as number) > 400 * 24 * 3600
	)
		invalid();
	return { state: "open", token: answer.token, maxAge: answer.maxAge as number };
}

/** A next host's ticket or an own host's member pass: a member's session, or refused (used, too old, another site's or
 * host's, or no longer theirs). */
export function parseEnterAnswer(value: unknown): { state: "open"; token: string; maxAge: number } | { state: "refused" } {
	const state = (value as { state?: unknown } | null)?.state;
	if (state === "refused") {
		closed(value, ["state"]);
		return { state };
	}
	if (state !== "open") invalid();
	return openAnswer(value);
}

type OldHostAnswer = { state: "legacy" } | { state: "gone" } | { state: "moved"; url: string };

/** The old host's answer for a path whose first part is `slug`: today's handler (legacy), gone, or moved to exactly the
 * slug's own host (never anywhere else, whatever the database says). */
export function parseOldHostAnswer(value: unknown, slug: string): OldHostAnswer {
	const state = (value as { state?: unknown } | null)?.state;
	if (state === "legacy" || state === "gone") {
		closed(value, ["state"]);
		return { state };
	}
	if (state !== "moved") invalid();
	const answer = closed(value, ["state", "url"]);
	if (answer.url !== `https://${slug}.qorpera.com/`) invalid();
	return { state, url: answer.url };
}

type HostAnswer =
	| { state: "none" }
	| { state: "gone" }
	| { state: "locked" }
	| { state: "missing" }
	| { state: "directory"; path: string }
	| (Extract<ServeAnswer, { state: "file" }> & { status: 200 | 404 });

/** A site host's answer, for a host of `scope` (by the host rule): every answer but none and gone names that scope and
 * says the site is not public (release 5.1 has no public sites). A file is the version's own (status 200) or its
 * 404.html for a path it lacks (status 404, whole: its content is never left out for the visitor's ETag). */
export function parseHostAnswer(
	value: unknown,
	scope: "site" | "next",
	etag: string | null,
	options: { length: number },
): HostAnswer {
	const state = (value as { state?: unknown } | null)?.state;
	if (state === "none" || state === "gone") {
		closed(value, ["state"]);
		return { state };
	}
	const scoped = (keys: readonly string[]) => {
		const answer = closed(value, [...keys, "scope", "public"]);
		if (answer.scope !== scope || answer.public !== false) invalid();
		return answer;
	};
	if (state === "locked" || state === "missing") {
		scoped(["state"]);
		return { state };
	}
	if (state === "directory") {
		const answer = scoped(["state", "path"]);
		if (typeof answer.path !== "string" || !answer.path.endsWith("/") || !isSitePath(answer.path)) invalid();
		return { state, path: answer.path };
	}
	if (state !== "file") invalid();
	const answer = scoped(["state", "status", "path", "contentType", "bytes", "sha256", "offset", "content"]);
	if (!(answer.status === 200 || (answer.status === 404 && answer.path === "404.html"))) invalid();
	return {
		state,
		status: answer.status as 200 | 404,
		...fileFields(answer, answer.status === 200 && answer.sha256 === etag, options.length),
	};
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
		notLive: "Not live yet",
		notLiveLead: "This address shows a project's next version to its team. Open it from What's new in Qorpera.",
		ticketUsed: "This link has been used or is too old. Open it again from What's new.",
		gone: "This site is not available.",
		ownAddress: "This page can only be opened at its own address.",
		fromQorpera: "This page can only be opened from Qorpera.",
		// HTML, ASCII only: appended to a page whatever its encoding.
		bar: "Not live yet &middot; only your team sees this",
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
		notLive: "Ikke live endnu",
		notLiveLead: "Her ser teamet et projekts næste version. Åbn den fra Nyheder i Qorpera.",
		ticketUsed: "Linket er brugt eller for gammelt. Åbn det igen fra Nyheder.",
		gone: "Siden er ikke tilgængelig.",
		ownAddress: "Siden kan kun åbnes på sin egen adresse.",
		fromQorpera: "Siden kan kun åbnes fra Qorpera.",
		bar: "Ikke live endnu &middot; kun jeres team ser dette",
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

/** A platform page. `referrer` is its own referrer policy, as its header names it: the password page's is same-origin,
 * so its form's POST carries the sites origin (under no-referrer a browser sends `Origin: null`, which the unlock
 * refuses, as it refuses every sandboxed site's). */
function page(lang: Language, title: string, body: string, head = "", referrer = "no-referrer"): string {
	return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="${referrer}">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main><footer>${escapeHtml(TEXT[lang].footer)}</footer></body></html>
`;
}

/** The password page; its form posts to `action`: /<slug>/.qorpera/unlock on the old host, /.qorpera/unlock on an own
 * host. */
function passwordPage(lang: Language, action: string, next: string, error?: string): string {
	const text = TEXT[lang];
	return page(
		lang,
		text.private,
		`<h1>${escapeHtml(text.private)}</h1><p>${escapeHtml(text.lead)}</p>` +
			`<form method="post" action="${action}"><input type="hidden" name="next" value="${escapeHtml(next)}">` +
			`<label for="password">${escapeHtml(text.password)}</label>` +
			`<input id="password" name="password" type="password" required maxlength="128" autocomplete="off" autofocus>` +
			`${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}` +
			`<button type="submit">${escapeHtml(text.open)}</button></form>`,
		"",
		"same-origin",
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

/** Headers on every answer the platform itself writes. Cache-Control with no-transform, as every answer of this function
 * (D23, step 5.1): the zone's browser cache default would add a lifetime to an answer without one, and its features
 * rewrite HTML. */
function pageHeaders(referrerPolicy: "no-referrer" | "same-origin" = "no-referrer"): Record<string, string> {
	return {
		"content-security-policy": PAGE_SECURITY_POLICY,
		"x-frame-options": "DENY",
		"x-content-type-options": "nosniff",
		"x-robots-tag": "noindex, nofollow, noarchive",
		"referrer-policy": referrerPolicy,
		"cache-control": NO_STORE,
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
		"cache-control": "private, no-cache, no-transform",
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

/** The bytes a GET's Range header starts from, before the file's size is known: an offset and how many (at most a whole
 * file), the last `suffix` bytes, or undefined to serve the whole file. */
export function rangeRequest(header: string | null): { offset: number; length: number } | { suffix: number } | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
	if (!match || (match[1] === "" && match[2] === "")) return undefined;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		return Number.isSafeInteger(suffix) ? { suffix } : undefined;
	}
	const start = Number(match[1]);
	const end = match[2] === "" ? undefined : Number(match[2]);
	if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) return undefined;
	return { offset: Math.min(start, MAX_FILE_BYTES), length: end === undefined ? MAX_FILE_BYTES : Math.min(end - start + 1, MAX_FILE_BYTES) };
}

/** One file for a session's request, asking the database for no more bytes than the answer needs: none for a HEAD,
 * the range's for a GET with one (the last bytes after a first answer names the size), the whole file otherwise. An
 * If-Range that does not name the file's digest asks again for the whole file. */
async function readFile(
	request: Request,
	store: SiteStore,
	slug: string,
	path: string,
	token: string,
	etag: string | null,
): Promise<{ answer: ServeAnswer; range: { start: number; end: number } | "unsatisfiable" | undefined }> {
	const ask = async (offset: number, length: number) =>
		parseServeAnswer(await store.serve(slug, path, token, etag, offset, length), etag, { length });
	if (request.method === "HEAD") return { answer: await ask(0, 0), range: undefined };
	const header = request.headers.get("range");
	const wanted = rangeRequest(header);
	let answer =
		wanted === undefined
			? await ask(0, MAX_FILE_BYTES)
			: "suffix" in wanted
				? await ask(0, 0)
				: await ask(wanted.offset, wanted.length);
	if (answer.state !== "file" || answer.sha256 === etag || wanted === undefined) return { answer, range: undefined };
	const ifRange = request.headers.get("if-range");
	if (ifRange !== null && ifRange.replace(/^"(.*)"$/, "$1") !== answer.sha256)
		return { answer: await ask(0, MAX_FILE_BYTES), range: undefined };
	const range = byteRange(header, answer.bytes);
	if (range === undefined) return { answer: await ask(0, MAX_FILE_BYTES), range: undefined };
	if (range !== "unsatisfiable" && "suffix" in wanted) answer = await ask(range.start, range.end - range.start + 1);
	return { answer, range };
}

function fileAnswer(
	request: Request,
	file: Extract<ServeAnswer, { state: "file" }>,
	etag: string | null,
	range: { start: number; end: number } | "unsatisfiable" | undefined,
): Response {
	const headers = contentHeaders(file);
	if (etag === file.sha256) return new Response(null, { status: 304, headers });
	if (request.method === "HEAD")
		return new Response(null, { status: 200, headers: { ...headers, "content-length": String(file.bytes) } });
	if (range === "unsatisfiable")
		return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${file.bytes}` } });
	const bytes = new Uint8Array(Buffer.from(file.content ?? "", "base64"));
	if (range) {
		// Exactly the range's bytes, from its start.
		if (file.offset !== range.start || bytes.byteLength !== range.end - range.start + 1) invalid();
		return new Response(bytes, {
			status: 206,
			headers: {
				...headers,
				"content-length": String(bytes.byteLength),
				"content-range": `bytes ${range.start}-${range.end}/${file.bytes}`,
			},
		});
	}
	// The bytes the database holds for this file, exactly.
	if (
		file.offset !== 0 ||
		bytes.byteLength !== file.bytes ||
		createHash("sha256").update(bytes).digest("hex") !== file.sha256
	)
		invalid();
	return new Response(bytes, { status: 200, headers: { ...headers, "content-length": String(bytes.byteLength) } });
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

/** Every session token the visitor's cookies of that name hold (at most 3): a cookie of that name set for a wider path
 * or domain (or, on a site host, by a browser that does not know the __Host- prefix) never hides the site's own. */
function cookieTokens(header: string | null, cookie: string = COOKIE): string[] {
	const tokens: string[] = [];
	for (const part of (header ?? "").split(";")) {
		const [name, ...rest] = part.trim().split("=");
		const value = rest.join("=");
		if (name === cookie && TOKEN.test(value) && !tokens.includes(value)) tokens.push(value);
	}
	return tokens.slice(0, 3);
}

/** Whether the request came in on the sites host. Only x-forwarded-host decides, and only the front sets it: its sites
 * host overwrites a visitor's with the sites host, its API host replaces a visitor's with the name the request asked
 * for (deploy/sites/envoy-front-sites.yaml). It must be exactly the sites origin's host: one value (no comma list, no
 * second header), no other port, no trailing dot; letters in any case. Host never decides: behind the gateway it is
 * whatever the caller sent. */
export function onSitesHost(request: Request, origin: URL): boolean {
	const forwarded = request.headers.get("x-forwarded-host");
	// No trim: Headers has already taken off the spaces and tabs HTTP allows around a value, and nothing else goes.
	return forwarded !== null && forwarded.toLowerCase() === origin.host;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The visitor's address for the password limits: CF-Connecting-IP, which Cloudflare's edge sets on every request it
 * passes on (replacing a visitor's own), when it holds exactly one IPv4 or IPv6 address; else "", one bucket shared by
 * every such request. An IPv6 address comes back in its canonical form (the database counts its /64) and an
 * IPv4-mapped one as its IPv4. Never X-Forwarded-For, X-Real-IP, True-Client-IP or Forwarded: a visitor sets those. */
export function clientAddress(header: string | null): string {
	const value = (header ?? "").trim();
	if (IPV4.test(value)) return value;
	if (!value.includes(":") || !/^[0-9A-Fa-f:.]{2,45}$/.test(value)) return "";
	let address: string;
	try {
		address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
	} catch {
		return "";
	}
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (!mapped) return address;
	const high = Number.parseInt(mapped[1] ?? "", 16);
	const low = Number.parseInt(mapped[2] ?? "", 16);
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
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
	return htmlAnswer(request, passwordPage(lang, `/${slug}/.qorpera/unlock`, next, error), status, extra, "same-origin");
}

/** The Edge Function. The old host asks the database first for a path that names a site (moved, gone); a site host is
 * answered here; everything else, and whatever the database calls legacy, is today's handler's. */
export async function handleSiteServe(request: Request, options: SiteServeOptions): Promise<Response> {
	const route = ROUTE.exec(new URL(request.url).pathname);
	if (route) {
		const rest = route[1] ?? "/";
		const lang = language(request.headers.get("accept-language"));
		const origin = new URL(options.origin);
		// The old host first: by the rule alone, sites.qorpera.com would be the own host of a site named sites.
		const old = onSitesHost(request, origin);
		const site = old ? null : siteHost(request.headers.get("x-forwarded-host"));
		const answer = old
			? await onOldHost(request, options, lang, origin, rest)
			: site
				? await onSiteHost(request, options, lang, site, rest)
				: undefined;
		if (answer) return site?.scope === "site" ? framedByWeb(answer, options.webOrigins ?? DEFAULT_WEB_ORIGINS) : answer;
	}
	return legacySiteServe(request, options);
}

// --- The old host, while sites have hosts of their own ---------------------------------------------------------------

/** Headers on the old host's answers that today's handler never gave (moved, gone): as its pages', never stored or
 * rewritten on the way, and never kept at Cloudflare either. */
const OLD_HOST_FRESH = { "cache-control": NO_STORE, "cdn-cache-control": "no-store" } as const;

/** The old host: for a path whose first part could name a site, the database says legacy (today's handler), gone (410)
 * or moved. A move keeps the rest of the path, without a session's ~token part, and the query, by 308 (never cached, so
 * turning hosts off again sends old links to the path again); the password form's address and any method but GET and
 * HEAD go to the own host's top by 303, so a password is never posted on to another host. No cookie is read here. */
async function onOldHost(
	request: Request,
	options: SiteServeOptions,
	lang: Language,
	origin: URL,
	rest: string,
): Promise<Response | undefined> {
	const segments = rest.slice(1).split("/");
	const slug = segments[0] ?? "";
	// Never the root or robots.txt (no name), which today's handler answers itself.
	if (!SLUG.test(slug)) return undefined;
	let answer: OldHostAnswer;
	try {
		answer = parseOldHostAnswer(await options.store.serveHost(origin.host, `${slug}/`, null, null, 0, 0), slug);
	} catch (error) {
		if (error instanceof MissingFunction) return undefined;
		return unavailable(request, lang, error);
	}
	if (answer.state === "legacy") return undefined;
	if (answer.state === "gone") return htmlAnswer(request, gonePage(lang), 410, OLD_HOST_FRESH);
	const after = segments.slice(1);
	const method = request.method;
	if (
		(method !== "GET" && method !== "HEAD") ||
		(after.length === 2 && after[0] === ".qorpera" && after[1] === "unlock")
	)
		return redirect(answer.url, 303, OLD_HOST_FRESH);
	const path = sitePath(after[0]?.startsWith("~") ? after.slice(1) : after) ?? "";
	return redirect(`${answer.url}${path}${new URL(request.url).search}`, 308, OLD_HOST_FRESH);
}

// --- A site's own host and next host ---------------------------------------------------------------------------------

export interface SiteHost {
	/** The host, lower-cased. */
	host: string;
	slug: string;
	/** site: the own host (the live version, a visitor's session); next: the next host (a member's look first). */
	scope: "site" | "next";
}

/** The site host x-forwarded-host names by the one host rule (SITE_HOST and the slug's length), lower-cased; null for
 * any other value: another domain, another level, a port, a trailing dot, a list. Only the front sets the header. */
export function siteHost(forwarded: string | null): SiteHost | null {
	if (forwarded === null) return null;
	const host = forwarded.toLowerCase();
	const match = SITE_HOST.exec(host);
	const slug = match?.[1];
	if (!match || !slug || slug.length < SITE_HOST_SLUG_LENGTH.min || slug.length > SITE_HOST_SLUG_LENGTH.max) return null;
	return { host, slug, scope: match[2] ? "next" : "site" };
}

/** Fetch Metadata (D22): a site host's answers go to the site's own pages (same-origin), to what a person typed or
 * opened from a bookmark (none), and to a top-level document navigation from anywhere (a link, the password form).
 * Never to a sibling's script, image, style or fetch: those carry the visitor's Lax cookie, since every qorpera.com host
 * is the same site. A frame's navigation (Sec-Fetch-Dest iframe) passes only where `framed` (an own host, which the web
 * frames, V1): there the browser's frame-ancestors decides who may show the answer (the site's own pages and the web's
 * origins), as every browser that sends Fetch Metadata enforces it; a next host refuses it. A request without the header
 * passes (older browsers, crawlers): CORP and frame-ancestors still hold for browsers. */
export function fetchAllowed(headers: Headers, framed = false): boolean {
	const site = headers.get("sec-fetch-site");
	const dest = headers.get("sec-fetch-dest");
	return (
		site === null ||
		site === "same-origin" ||
		site === "none" ||
		(headers.get("sec-fetch-mode") === "navigate" && (dest === "document" || (framed && dest === "iframe")))
	);
}

/** An own host's answer, framable by the web (V1): its frame-ancestors names the web's origins after 'self', and it
 * carries no X-Frame-Options (which cannot name another origin). Every own-host answer passes here. An answer whose
 * policy is not one of the site host's two is left as it is: framed by its own pages only. */
function framedByWeb(response: Response, origins: readonly string[]): Response {
	const policy = response.headers.get("content-security-policy");
	const own =
		policy === HOST_PAGE_SECURITY_POLICY
			? ownPageSecurityPolicy(origins)
			: policy === HOST_CONTENT_SECURITY_POLICY
				? ownContentSecurityPolicy(origins)
				: null;
	if (own === null) return response;
	response.headers.set("content-security-policy", own);
	response.headers.delete("x-frame-options");
	return response;
}

/** A service worker's script, which a site host never serves: a worker would keep pages a takedown or a newer version
 * removed, and on a next host would see Look first's tickets. */
function serviceWorkerScript(headers: Headers): boolean {
	return headers.has("service-worker") || headers.get("sec-fetch-dest") === "serviceworker";
}

/** Headers on every answer on a site host. Every answer in release 5.1 is private or next: no other origin may read it
 * (CORP; no Access-Control-Allow-Origin), frame it, index it, or keep it at Cloudflare. */
function hostHeaders(): Record<string, string> {
	return {
		"x-content-type-options": "nosniff",
		"x-frame-options": "SAMEORIGIN",
		"x-robots-tag": "noindex, nofollow, noarchive",
		"cross-origin-resource-policy": "same-origin",
		"cdn-cache-control": "no-store",
		"strict-transport-security": STRICT_TRANSPORT_SECURITY,
	};
}

/** Headers on the platform's own answers on a site host: pages, redirects, robots.txt. */
function hostPageHeaders(referrerPolicy: "no-referrer" | "same-origin" = "no-referrer"): Record<string, string> {
	return {
		...hostHeaders(),
		"content-security-policy": HOST_PAGE_SECURITY_POLICY,
		"referrer-policy": referrerPolicy,
		"cache-control": NO_STORE,
	};
}

function hostHtml(
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
			...hostPageHeaders(referrerPolicy),
			"content-type": "text/html; charset=utf-8",
			"content-length": String(bytes.byteLength),
			...extra,
		},
	});
}

function hostMessage(request: Request, lang: Language, status: number, title: string, lead: string): Response {
	return hostHtml(request, messagePage(lang, title, lead), status);
}

function hostRedirect(location: string, status: 303 | 308, extra: Record<string, string> = {}): Response {
	return new Response(null, { status, headers: { ...hostPageHeaders(), location, ...extra } });
}

function hostNotAllowed(allow: string): Response {
	return new Response(null, { status: 405, headers: { ...hostPageHeaders(), allow } });
}

function hostNotFound(request: Request, lang: Language, lead: string = TEXT[lang].nothing): Response {
	return hostMessage(request, lang, 404, TEXT[lang].notFound, lead);
}

function hostUnavailable(request: Request, lang: Language, error: unknown): Response {
	// The error's kind only: never a token, a ticket, a password or a cookie.
	console.error(`site-serve: the database could not answer (${error instanceof Error ? error.name : typeof error})`);
	const text = TEXT[lang];
	return hostHtml(request, messagePage(lang, text.unavailable, text.unavailableLead), 503, { "retry-after": "30" });
}

function gonePage(lang: Language): string {
	const text = TEXT[lang];
	return page(lang, text.gone, `<h1>${escapeHtml(text.gone)}</h1>`);
}

/** The session cookie on a site host: host-only (no Domain), the whole host, never sent by another site's request but a
 * top-level navigation. */
function hostCookie(token: string, maxAge: number): string {
	return `${HOST_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** What a site host with no session shows, whether or not the host has a site (existence never shows): the own host's
 * password page, the next host's "Not live yet" page. A session cookie that was sent goes. */
function hostLocked(
	request: Request,
	lang: Language,
	site: SiteHost,
	next: string,
	status: number,
	options: { error?: string; clear?: boolean; extra?: Record<string, string> } = {},
): Response {
	const extra = { ...(options.clear ? { "set-cookie": hostCookie("", 0) } : {}), ...options.extra };
	if (site.scope === "next") {
		const text = TEXT[lang];
		return hostHtml(request, messagePage(lang, text.notLive, text.notLiveLead), status, extra);
	}
	return hostHtml(request, passwordPage(lang, "/.qorpera/unlock", next, options.error), status, extra, "same-origin");
}

/** The bar on every HTML page of a next host: appended after the page's last byte (the parser puts it in the body
 * wherever the page ends), ASCII only, so a page's own encoding never garbles it. */
export function nextBar(lang: Language): string {
	return `\n<div lang="${lang}" role="status" style="all:initial;display:block;position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:8px 12px;background:#1d1c1a;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-align:center">${TEXT[lang].bar}</div>\n`;
}

function isHtml(contentType: string): boolean {
	return /^text\/html(?:;|$)/.test(contentType);
}

/** A site host's request (the host decided by the rule, before any database call). Undefined when the database has no
 * site host calls yet: today's handler answers. */
async function onSiteHost(
	request: Request,
	options: SiteServeOptions,
	lang: Language,
	site: SiteHost,
	rest: string,
): Promise<Response | undefined> {
	const text = TEXT[lang];
	const method = request.method;
	if (serviceWorkerScript(request.headers)) return hostNotFound(request, lang);
	if (!fetchAllowed(request.headers, site.scope === "site"))
		return hostMessage(request, lang, 403, text.unavailable, text.ownAddress);
	if (rest === "/robots.txt") {
		if (method !== "GET" && method !== "HEAD") return hostNotAllowed("GET, HEAD");
		const bytes = new TextEncoder().encode("User-agent: *\nDisallow: /\n");
		return new Response(method === "HEAD" ? null : bytes, {
			status: 200,
			headers: {
				...hostPageHeaders(),
				"content-type": "text/plain; charset=utf-8",
				"content-length": String(bytes.byteLength),
			},
		});
	}
	const segments = rest.slice(1).split("/");
	if (segments[0] === ".qorpera") {
		if (segments.length === 2 && segments[1] === "unlock") return hostUnlock(request, options, lang, site);
		if (segments.length === 2 && segments[1] === "enter" && site.scope === "next")
			return hostEnter(request, options, lang, site);
		return hostNotFound(request, lang);
	}
	const path = sitePath(segments);
	if (path === null) return hostNotFound(request, lang);
	// The platform's folder, whatever a site holds there: the member's door on an own host, nothing else.
	if (path === PLATFORM_FOLDER || path.startsWith(`${PLATFORM_FOLDER}/`)) {
		if (`/${path}` === MEMBER_PATH && site.scope === "site") return hostMember(request, options, lang, site);
		return hostNotFound(request, lang);
	}
	if (method !== "GET" && method !== "HEAD") return hostNotAllowed("GET, HEAD");
	const tokens = cookieTokens(request.headers.get("cookie"), HOST_COOKIE);
	// The next host serves no ETag: its pages carry the bar, and its version is the session's.
	const etag = site.scope === "site" ? requestedEtag(request.headers.get("if-none-match")) : null;
	let read: Awaited<ReturnType<typeof readHostFile>>;
	// The session cookie the answer was read with.
	let token = tokens[0] ?? null;
	try {
		// Each session cookie the browser sent, until one is not locked (none and gone are the site's, not the session's).
		read = await readHostFile(request, options.store, site, path, token, etag);
		for (const next of tokens.slice(1)) {
			if (read.answer.state !== "locked") break;
			token = next;
			read = await readHostFile(request, options.store, site, path, token, etag);
		}
	} catch (error) {
		if (error instanceof MissingFunction) return undefined;
		return hostUnavailable(request, lang, error);
	}
	const answer = read.answer;
	if (answer.state === "gone") return hostHtml(request, gonePage(lang), 410);
	if (answer.state === "none" || answer.state === "locked")
		return hostLocked(request, lang, site, path, 401, { clear: tokens.length > 0 });
	if (answer.state === "directory") return hostRedirect(`/${answer.path}${new URL(request.url).search}`, 308);
	if (answer.state === "missing") return hostNotFound(request, lang, text.notPart);
	let response: Response;
	try {
		response = hostFileAnswer(request, answer, site.scope, etag, read.range, lang);
	} catch (error) {
		return hostUnavailable(request, lang, error);
	}
	// A page of the live version on the own host (never a next host's look first, nor the version's 404.html): its
	// view counts.
	if (
		site.scope === "site" &&
		answer.status === 200 &&
		token !== null &&
		isHtml(answer.contentType) &&
		countsAsView(request, response.status)
	)
		return withViewCounted(options, response, site.host, answer.path, token);
	return response;
}

/** One file for a site host's request, as `readFile` asks for it, but whole for what is never served in parts: a
 * version's 404.html and a next host's HTML (it carries the bar). */
async function readHostFile(
	request: Request,
	store: SiteStore,
	site: SiteHost,
	path: string,
	token: string | null,
	etag: string | null,
): Promise<{ answer: HostAnswer; range: { start: number; end: number } | "unsatisfiable" | undefined }> {
	const ask = async (offset: number, length: number) =>
		parseHostAnswer(await store.serveHost(site.host, path, token, etag, offset, length), site.scope, etag, { length });
	if (request.method === "HEAD") return { answer: await ask(0, 0), range: undefined };
	const header = request.headers.get("range");
	const wanted = rangeRequest(header);
	if (wanted === undefined) return { answer: await ask(0, MAX_FILE_BYTES), range: undefined };
	let answer = "suffix" in wanted ? await ask(0, 0) : await ask(wanted.offset, wanted.length);
	if (answer.state !== "file") return { answer, range: undefined };
	if (answer.status === 404 || (site.scope === "next" && isHtml(answer.contentType)))
		return { answer: await ask(0, MAX_FILE_BYTES), range: undefined };
	if (answer.sha256 === etag) return { answer, range: undefined };
	const ifRange = request.headers.get("if-range");
	if (ifRange !== null && ifRange.replace(/^"(.*)"$/, "$1") !== answer.sha256)
		return { answer: await ask(0, MAX_FILE_BYTES), range: undefined };
	const range = byteRange(header, answer.bytes);
	if (range === undefined) return { answer: await ask(0, MAX_FILE_BYTES), range: undefined };
	if (range !== "unsatisfiable" && "suffix" in wanted) answer = await ask(range.start, range.end - range.start + 1);
	return { answer, range };
}

/** A site's file on a site host. The own host's live files: `private, no-cache` with an ETag and byte ranges. Its
 * 404.html (status 404) and every next host file: never stored, no ETag; a next host's HTML whole, the bar appended. */
function hostFileAnswer(
	request: Request,
	file: Extract<HostAnswer, { state: "file" }>,
	scope: "site" | "next",
	etag: string | null,
	range: { start: number; end: number } | "unsatisfiable" | undefined,
	lang: Language,
): Response {
	const fresh = scope === "site" && file.status === 200;
	const bar = scope === "next" && isHtml(file.contentType) ? new TextEncoder().encode(nextBar(lang)) : null;
	const headers: Record<string, string> = {
		...hostHeaders(),
		"content-type": file.contentType,
		"content-security-policy": HOST_CONTENT_SECURITY_POLICY,
		"referrer-policy": "same-origin",
		"cache-control": fresh ? "private, no-cache, no-transform" : NO_STORE,
		...(fresh ? { etag: `"${file.sha256}"` } : {}),
		...(file.status === 200 && !bar ? { "accept-ranges": "bytes" } : {}),
	};
	if (fresh && etag === file.sha256) return new Response(null, { status: 304, headers });
	const length = file.bytes + (bar?.byteLength ?? 0);
	if (request.method === "HEAD")
		return new Response(null, { status: file.status, headers: { ...headers, "content-length": String(length) } });
	if (range === "unsatisfiable")
		return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${file.bytes}` } });
	const bytes = new Uint8Array(Buffer.from(file.content ?? "", "base64"));
	if (range) {
		// Exactly the range's bytes, from its start.
		if (file.offset !== range.start || bytes.byteLength !== range.end - range.start + 1) invalid();
		return new Response(bytes, {
			status: 206,
			headers: {
				...headers,
				"content-length": String(bytes.byteLength),
				"content-range": `bytes ${range.start}-${range.end}/${file.bytes}`,
			},
		});
	}
	// The bytes the database holds for this file, exactly, before anything is appended.
	if (
		file.offset !== 0 ||
		bytes.byteLength !== file.bytes ||
		createHash("sha256").update(bytes).digest("hex") !== file.sha256
	)
		invalid();
	const body = bar ? new Uint8Array(Buffer.concat([bytes, bar])) : bytes;
	return new Response(body, {
		status: file.status,
		headers: { ...headers, "content-length": String(body.byteLength) },
	});
}

/** The own host's password form (POST /.qorpera/unlock). A next host's never asks the database: its password is no
 * way in, and a form there must never count against the site's limits. */
async function hostUnlock(
	request: Request,
	options: SiteServeOptions,
	lang: Language,
	site: SiteHost,
): Promise<Response | undefined> {
	const text = TEXT[lang];
	const method = request.method;
	if (method === "GET" || method === "HEAD") return hostRedirect("/", 303);
	if (method !== "POST") return hostNotAllowed("POST");
	if (site.scope === "next") return hostLocked(request, lang, site, "", 401);
	const sent = request.headers.get("origin");
	if (sent !== null && sent !== `https://${site.host}`) return hostMessage(request, lang, 403, text.private, text.refused);
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
		return hostMessage(request, lang, 415, text.private, text.refused);
	const body = await readBody(request, MAX_UNLOCK_BODY_BYTES);
	if (!body) return hostMessage(request, lang, 413, text.private, text.refused);
	let form: URLSearchParams;
	try {
		form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return hostMessage(request, lang, 400, text.private, text.refused);
	}
	const sentNext = form.get("next") ?? "";
	const next = isSitePath(sentNext) ? sentNext : "";
	const password = form.get("password") ?? "";
	if (!password || password.length > MAX_PASSWORD) return hostLocked(request, lang, site, next, 401, { error: text.empty });
	let answer: UnlockAnswer;
	try {
		answer = parseUnlockAnswer(
			await options.store.unlockHost(site.host, password, clientAddress(request.headers.get("cf-connecting-ip"))),
		);
	} catch (error) {
		if (error instanceof MissingFunction) return undefined;
		return hostUnavailable(request, lang, error);
	}
	if (answer.state === "wrong") return hostLocked(request, lang, site, next, 401, { error: text.wrong });
	if (answer.state === "limited")
		return hostLocked(request, lang, site, next, 429, {
			error: text.limited(Math.ceil(answer.retryAfter / 60)),
			extra: { "retry-after": String(answer.retryAfter) },
		});
	return hostRedirect(`/${next}`, 303, { "set-cookie": hostCookie(answer.token, answer.maxAge) });
}

/** Look first's door on a next host (GET /.qorpera/enter?t=<ticket>): the ticket for a member's session, once. Only GET
 * spends it; a ticket of the wrong shape, or a request from another origin, never reaches the database. */
async function hostEnter(
	request: Request,
	options: SiteServeOptions,
	lang: Language,
	site: SiteHost,
): Promise<Response | undefined> {
	const text = TEXT[lang];
	if (request.method !== "GET") return hostNotAllowed("GET");
	const refused = () => hostMessage(request, lang, 403, text.notLive, text.ticketUsed);
	const sent = request.headers.get("origin");
	if (sent !== null && sent !== `https://${site.host}`) return refused();
	const tickets = new URL(request.url).searchParams.getAll("t");
	const ticket = tickets.length === 1 ? (tickets[0] ?? "") : "";
	if (!TICKET.test(ticket)) return refused();
	let answer: ReturnType<typeof parseEnterAnswer>;
	try {
		answer = parseEnterAnswer(await options.store.enter(site.host, ticket));
	} catch (error) {
		if (error instanceof MissingFunction) return undefined;
		return hostUnavailable(request, lang, error);
	}
	if (answer.state === "refused") return refused();
	return hostRedirect("/", 303, { "set-cookie": hostCookie(answer.token, answer.maxAge) });
}

/** The member's door on an own host (POST /__qorpera/member, V1): the web posts a member's pass (`pass`) and, if it
 * wants, a path of the site (`path`, with or without its leading slash) into its frame, from one of its origins. The
 * pass is redeemed once for a member's session in the cookie a right password sets, and the answer goes to that path on
 * this host (the top for none, or one that is not a site path). A pass of the wrong shape never reaches the database; a
 * pass the database refuses answers exactly as a wrong password does. */
async function hostMember(
	request: Request,
	options: SiteServeOptions,
	lang: Language,
	site: SiteHost,
): Promise<Response | undefined> {
	const text = TEXT[lang];
	if (request.method !== "POST") return hostNotAllowed("POST");
	// Exactly one of the web's origins: a form of another origin, a sibling's, the site's own or none is refused.
	const sent = request.headers.get("origin");
	if (sent === null || !(options.webOrigins ?? DEFAULT_WEB_ORIGINS).includes(sent))
		return hostMessage(request, lang, 403, text.private, text.fromQorpera);
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
		return hostMessage(request, lang, 415, text.private, text.fromQorpera);
	const body = await readBody(request, MAX_UNLOCK_BODY_BYTES);
	if (!body) return hostMessage(request, lang, 413, text.private, text.fromQorpera);
	let form: URLSearchParams;
	try {
		form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		return hostMessage(request, lang, 400, text.private, text.fromQorpera);
	}
	const sentPath = (form.get("path") ?? "").replace(/^\//, "");
	const next = isSitePath(sentPath) ? sentPath : "";
	const passes = form.getAll("pass");
	const pass = passes.length === 1 ? (passes[0] ?? "") : "";
	const wrong = () => hostLocked(request, lang, site, next, 401, { error: text.wrong });
	if (!PASS.test(pass)) return wrong();
	let answer: ReturnType<typeof parseEnterAnswer>;
	try {
		answer = parseEnterAnswer(await options.store.memberPass(site.host, pass));
	} catch (error) {
		if (error instanceof MissingFunction) return undefined;
		return hostUnavailable(request, lang, error);
	}
	if (answer.state === "refused") return wrong();
	return hostRedirect(`/${next}`, 303, { "set-cookie": hostCookie(answer.token, answer.maxAge) });
}

// --- Views --------------------------------------------------------------------------------------------------------------

/** Whether a request and the status it was answered with make a page view, for a text/html file of a session: a GET with
 * no Range (a part is no view), answered 200 or 304, a document (Sec-Fetch-Dest document, or no Fetch Metadata) and no
 * prefetch or prerender (Sec-Purpose, or the older Purpose). */
export function countsAsView(request: Request, status: number): boolean {
	const headers = request.headers;
	const dest = headers.get("sec-fetch-dest");
	return (
		request.method === "GET" &&
		(status === 200 || status === 304) &&
		!headers.has("range") &&
		(dest === null || dest === "document") &&
		!headers.has("sec-purpose") &&
		!headers.has("purpose")
	);
}

/** The edge runtime's waitUntil (Supabase's EdgeRuntime), when it has one. */
function edgeWaitUntil(): ((work: Promise<unknown>) => void) | undefined {
	const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: unknown } }).EdgeRuntime;
	const waitUntil = runtime?.waitUntil;
	if (typeof waitUntil !== "function") return undefined;
	return (work) => {
		waitUntil.call(runtime, work);
	};
}

/** A database that has no count call yet is said once, not on every page. */
let countMissingSaid = false;

/** The answer, once the view's count is on its way: handed to waitUntil, or waited for at most COUNT_WAIT_MS. The count
 * never changes the answer; a failure is logged by its kind only, never with a token, a path or a host. */
async function withViewCounted(
	options: SiteServeOptions,
	response: Response,
	host: string,
	path: string,
	token: string,
): Promise<Response> {
	const work = (async () => {
		try {
			await options.store.countView(host, path, token);
		} catch (error) {
			if (error instanceof MissingFunction) {
				if (countMissingSaid) return;
				countMissingSaid = true;
			}
			console.error(`site-serve: a view was not counted (${error instanceof Error ? error.name : typeof error})`);
		}
	})();
	const waitUntil = options.waitUntil ?? edgeWaitUntil();
	if (waitUntil) {
		try {
			waitUntil(work);
			return response;
		} catch {
			// No way to keep it going: wait for it below.
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, COUNT_WAIT_MS)))]);
	clearTimeout(timer);
	return response;
}

// --- The old host's path form: today's handler ------------------------------------------------------------------------

/** Today's handler: the old host's path form, and 404 for every other host. */
async function legacySiteServe(request: Request, options: SiteServeOptions): Promise<Response> {
	const origin = new URL(options.origin);
	const lang = language(request.headers.get("accept-language"));
	const route = ROUTE.exec(new URL(request.url).pathname);
	// Only through the sites host: never as the API's or the app's origin.
	if (!route || !onSitesHost(request, origin)) return notFound(request, lang);
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
					"cache-control": NO_STORE,
				},
			});
		if (method !== "GET" && method !== "HEAD") return notAllowed("GET, HEAD, OPTIONS");
		const etag = requestedEtag(request.headers.get("if-none-match"));
		try {
			const { answer, range } = await readFile(request, options.store, slug, path, token, etag);
			if (answer.state === "file") {
				const response = fileAnswer(request, answer, etag, range);
				// A page of the session: its view counts (on the old host, the site's name first).
				if (isHtml(answer.contentType) && countsAsView(request, response.status))
					return await withViewCounted(options, response, origin.host, `${slug}/${answer.path}`, token);
				return response;
			}
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
	const tokens = cookieTokens(cookieHeader);
	if (tokens.length) {
		try {
			for (const token of tokens) {
				// A check only: no bytes.
				const answer = parseServeAnswer(await options.store.serve(slug, path, token, null, 0, 0), null, { length: 0 });
				if (answer.state !== "locked") return redirect(`/${slug}/~${token}/${path}${search}`, 303);
			}
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
			await options.store.unlock(slug, password, clientAddress(request.headers.get("cf-connecting-ip"))),
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

/** The most bytes of a PostgREST error read for its code. */
const MAX_ERROR_BYTES = 4096;

/** The `code` of a PostgREST error body of at most 4 KiB, else null. The body is never logged. */
async function errorCode(response: Response): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > MAX_ERROR_BYTES) return null;
			chunks.push(chunk.value);
		}
		const parsed: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
		const code = (parsed as { code?: unknown } | null)?.code;
		return typeof code === "string" ? code : null;
	} catch {
		return null;
	} finally {
		void reader.cancel().catch(() => undefined);
	}
}

/** The RPCs through PostgREST with the service key: no redirect, a deadline, an answer of at most 16 MiB. */
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

	serve(
		slug: string,
		path: string,
		token: string | null,
		etag: string | null,
		offset: number,
		length: number,
	): Promise<unknown> {
		return this.#call("qorpera_site_serve", {
			p_slug: slug,
			p_path: path,
			p_token: token,
			p_etag: etag,
			p_offset: offset,
			p_length: length,
		});
	}

	unlock(slug: string, password: string, client: string): Promise<unknown> {
		return this.#call("qorpera_site_unlock", { p_slug: slug, p_password: password, p_client: client });
	}

	serveHost(
		host: string,
		path: string,
		token: string | null,
		etag: string | null,
		offset: number,
		length: number,
	): Promise<unknown> {
		return this.#call("qorpera_site_serve_host", {
			p_host: host,
			p_path: path,
			p_token: token,
			p_etag: etag,
			p_offset: offset,
			p_length: length,
		});
	}

	unlockHost(host: string, password: string, client: string): Promise<unknown> {
		return this.#call("qorpera_site_unlock_host", { p_host: host, p_password: password, p_client: client });
	}

	enter(host: string, ticket: string): Promise<unknown> {
		return this.#call("qorpera_site_enter", { p_host: host, p_ticket: ticket });
	}

	countView(host: string, path: string, token: string): Promise<unknown> {
		return this.#call(
			"qorpera_site_count_view",
			{ p_host: host, p_path: path, p_token: token },
			Math.min(this.#timeoutMs, COUNT_TIMEOUT_MS),
		);
	}

	memberPass(host: string, pass: string): Promise<unknown> {
		return this.#call("qorpera_site_member_pass_redeem", { p_host: host, p_pass: pass });
	}

	async #call(name: string, args: Record<string, unknown>, timeoutMs = this.#timeoutMs): Promise<unknown> {
		const response = await this.#fetch(`${this.#projectUrl}/rest/v1/rpc/${name}`, {
			method: "POST",
			redirect: "error",
			headers: { ...serviceHeaders(this.#secretKey), "content-type": "application/json" },
			body: JSON.stringify(args),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			// PostgREST answers 404 with code PGRST202 for a function it does not have: one whose migration is not applied.
			if (response.status === 404 && (await errorCode(response)) === "PGRST202") throw new MissingFunction(name);
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
