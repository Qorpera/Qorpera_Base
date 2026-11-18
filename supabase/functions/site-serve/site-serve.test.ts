import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	byteRange,
	CONTENT_SECURITY_POLICY,
	COUNT_WAIT_MS,
	clientAddress,
	countsAsView,
	DEFAULT_WEB_ORIGINS,
	escapeHtml,
	fetchAllowed,
	HOST_CONTENT_SECURITY_POLICY,
	HOST_COOKIE,
	HOST_PAGE_SECURITY_POLICY,
	handleSiteServe,
	isSitePath,
	language,
	MAX_FILE_BYTES,
	MAX_STORE_ANSWER_BYTES,
	MAX_UNLOCK_BODY_BYTES,
	MEMBER_PATH,
	MissingFunction,
	nextBar,
	onSitesHost,
	ownContentSecurityPolicy,
	ownPageSecurityPolicy,
	PAGE_SECURITY_POLICY,
	PostgrestSiteStore,
	parseEnterAnswer,
	parseHostAnswer,
	parseOldHostAnswer,
	parseServeAnswer,
	parseUnlockAnswer,
	rangeRequest,
	requestedEtag,
	type SiteStore,
	serviceHeaders,
	siteHost,
	webOrigins,
} from "./site-serve.ts";

const ORIGIN = "https://sites.qorpera.com";
const BASE = "https://project.example.test/functions/v1/site-serve";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NEW_TOKEN = "zyxwvutsrqponmlkjihgfedcbaZYXWV9";
const HTML = "<!doctype html><title>Shop</title><p>Wristbands</p>";

type Json = Record<string, unknown>;
interface Calls {
	serve: [string, string, string | null, string | null, number, number][];
	unlock: [string, string, string][];
	serveHost: [string, string, string | null, string | null, number, number][];
	unlockHost: [string, string, string][];
	enter: [string, string][];
	countView: [string, string, string][];
	memberPass: [string, string][];
}

/** What the database's site host calls answer in a test: a value (an Error is thrown), or a function of the call's host,
 * path and token giving one. */
interface HostAnswers {
	serveHost?: unknown;
	unlockHost?: unknown;
	enter?: unknown;
	/** qorpera_site_count_view's answer: a value, an Error thrown, or a promise (one that never settles, say). */
	countView?: unknown;
	/** qorpera_site_member_pass_redeem's answer (20260930774000). */
	memberPass?: unknown;
}

/** qorpera_site_serve_host while hosts are off (20260930756000 applied, hosts_enabled false, nothing taken down): the
 * old host's paths are today's handler's, every other host has nothing. */
function hostsOff(host: string): Json {
	// The old host is the sites origin's: sites.qorpera.com here, sites.example.test:8443 in one test.
	return host.startsWith("sites.") ? { state: "legacy" } : { state: "none" };
}

function sha(text: string | Uint8Array): string {
	return createHash("sha256").update(text).digest("hex");
}

function file(text: string, extra: Json = {}): Json {
	return {
		state: "file",
		path: "index.html",
		contentType: "text/html; charset=utf-8",
		bytes: Buffer.byteLength(text),
		sha256: sha(text),
		content: Buffer.from(text).toString("base64"),
		...extra,
	};
}

/** A file answer as qorpera_site_serve gives it for these bytes: from the offset, at most the length (both clamped to
 * the file), and no content for the visitor's own digest or none asked for. Any other answer passes as it is. */
function asTheDatabase(value: unknown, etag: string | null, offset: number, length: number): unknown {
	const answer = value as Json | null;
	if (
		!answer ||
		answer.state !== "file" ||
		typeof answer.bytes !== "number" ||
		!(typeof answer.content === "string" || answer.content === null)
	)
		return value;
	const at = Math.min(Math.max(offset, 0), answer.bytes);
	const count = Math.min(Math.max(length, 0), answer.bytes - at);
	// A site host's 404.html is whole whatever the visitor's ETag (qorpera_site_serve_host).
	const content =
		answer.content === null || (etag === answer.sha256 && answer.status !== 404) || count === 0
			? null
			: Buffer.from(answer.content, "base64").subarray(at, at + count).toString("base64");
	return { ...answer, offset: at, content };
}

function store(
	serve: unknown = file(HTML),
	unlock: unknown = { state: "open", token: NEW_TOKEN, maxAge: 604800 },
	host: HostAnswers = {},
) {
	const calls: Calls = { serve: [], unlock: [], serveHost: [], unlockHost: [], enter: [], countView: [], memberPass: [] };
	const answer = async (value: unknown) => {
		if (value instanceof Error) throw value;
		return value;
	};
	const siteStore: SiteStore = {
		serve(slug, path, token, etag, offset, length) {
			calls.serve.push([slug, path, token, etag, offset, length]);
			const value = typeof serve === "function" ? (serve as (path: string) => unknown)(path) : serve;
			return answer(asTheDatabase(value, etag, offset, length));
		},
		unlock(slug, password, client) {
			calls.unlock.push([slug, password, client]);
			return answer(unlock);
		},
		serveHost(name, path, token, etag, offset, length) {
			calls.serveHost.push([name, path, token, etag, offset, length]);
			const given = "serveHost" in host ? host.serveHost : hostsOff;
			const value =
				typeof given === "function"
					? (given as (host: string, path: string, token: string | null) => unknown)(name, path, token)
					: given;
			return answer(asTheDatabase(value, etag, offset, length));
		},
		unlockHost(name, password, client) {
			calls.unlockHost.push([name, password, client]);
			return answer(host.unlockHost ?? { state: "wrong" });
		},
		enter(name, ticket) {
			calls.enter.push([name, ticket]);
			return answer(host.enter ?? { state: "refused" });
		},
		countView(name, path, token) {
			calls.countView.push([name, path, token]);
			const given = host.countView ?? { state: "counted", visit: true };
			return given instanceof Promise ? given : answer(given);
		},
		memberPass(name, pass) {
			calls.memberPass.push([name, pass]);
			return answer(host.memberPass ?? { state: "refused" });
		},
	};
	return { calls, store: siteStore };
}

function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, base = BASE): Request {
	return new Request(`${base}${path}`, {
		...init,
		headers: { "x-forwarded-host": "sites.qorpera.com", ...init.headers },
	});
}

/** The host each answer was asked on (x-forwarded-host), for the site host header checks. */
const askedOn = new WeakMap<Response, string>();

async function serve(
	req: Request,
	siteStore: SiteStore = store().store,
	origins?: readonly string[],
): Promise<Response> {
	const response = await handleSiteServe(req, {
		origin: ORIGIN,
		store: siteStore,
		...(origins ? { webOrigins: origins } : {}),
	});
	askedOn.set(response, req.headers.get("x-forwarded-host") ?? "");
	return response;
}

function post(slug: string, body: string, headers: Record<string, string> = {}): Request {
	return request(`/${slug}/.qorpera/unlock`, {
		method: "POST",
		body,
		headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, ...headers },
	});
}

function assertPage(response: Response, referrer = "no-referrer"): void {
	assert.equal(response.headers.get("content-security-policy"), PAGE_SECURITY_POLICY);
	assert.equal(response.headers.get("x-frame-options"), "DENY");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
	assert.equal(response.headers.get("referrer-policy"), referrer);
	// Every answer carries no-transform (D23, step 5.1): today's value before it was no-store.
	assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
	assert.equal(response.headers.get("access-control-allow-origin"), null);
}

function assertContent(response: Response, hash: string): void {
	assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
	assert.match(CONTENT_SECURITY_POLICY, /^sandbox /);
	assert.doesNotMatch(CONTENT_SECURITY_POLICY, /allow-same-origin|allow-top-navigation/);
	assert.equal(response.headers.get("x-frame-options"), "DENY");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	// Every answer carries no-transform (D23, step 5.1): today's value before it was private, no-cache.
	assert.equal(response.headers.get("cache-control"), "private, no-cache, no-transform");
	assert.equal(response.headers.get("etag"), `"${hash}"`);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.equal(response.headers.get("set-cookie"), null);
}

// --- An address of its own (step 5.1) ---------------------------------------------------------------------------------

const OWN = "look-shop.qorpera.com";
const NEXT = "look-shop--next.qorpera.com";
/** Look first's ticket: 43 characters of base64url. */
const TICKET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q";
const NOT_FOUND_HTML = "<!doctype html><title>Lost</title><p>Nothing here</p>";
const PGRST202 = {
	code: "PGRST202",
	details: "Searched for the function public.qorpera_site_serve_host with parameters p_etag, p_host, p_length",
	hint: null,
	message: "Could not find the function public.qorpera_site_serve_host in the schema cache",
};

/** The one host list of SQL test 1252 (step 5.1's cross-check): every reader of a site host runs its rows. A row is the
 * host, the slug and scope the rule reads, and the verdict (taken, name, shape, case, port, dot: 1252 says what each
 * means). */
function oneHostList(): { host: string; slug: string; scope: string; verdict: string }[] {
	const lines = readFileSync(new URL("../../tests/1252_site_hosts.test.sql", import.meta.url), "utf8").split("\n");
	const begin = lines.findIndex((line) => line.trim() === "-- the one host list: begin");
	const end = lines.findIndex((line) => line.trim() === "-- the one host list: end");
	assert.ok(begin > 0 && end > begin, "1252's one host list");
	const list = lines.slice(begin + 1, end).map((line) => {
		const row = /^\s*\('([^']*)', '([^']*)', '(site|next|)', '(taken|name|shape|case|port|dot)'\),?$/.exec(line);
		assert.ok(row, line);
		return { host: row[1] ?? "", slug: row[2] ?? "", scope: row[3] ?? "", verdict: row[4] ?? "" };
	});
	assert.ok(list.length >= 50, "1252's one host list holds its rows");
	for (const verdict of ["taken", "name", "shape", "case", "port", "dot"])
		assert.ok(
			list.some((row) => row.verdict === verdict),
			verdict,
		);
	return list;
}

/** Migration 20260930756000's text: what site-serve calls and reads must be there, as written. */
const MIGRATION = readFileSync(new URL("../../migrations/20260930756000_site_hosts.sql", import.meta.url), "utf8");

function hostRequest(host: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request {
	return new Request(`${BASE}${path}`, { ...init, headers: { "x-forwarded-host": host, ...init.headers } });
}

function unlockOn(host: string, body: string, headers: Record<string, string> = {}): Request {
	return hostRequest(host, "/.qorpera/unlock", {
		method: "POST",
		body,
		headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${host}`, ...headers },
	});
}

/** A file as qorpera_site_serve_host answers it for an own host's session. */
function hostFile(text: string, extra: Json = {}): Json {
	return { ...file(text), status: 200, scope: "site", public: false, ...extra };
}

/** A member's pass (V1): 43 characters of base64url. */
const MEMBER_PASS = "PqRsTuVwXyZ0123456789-_abcdefghijklmnopqrst";
const WEB = "https://app.qorpera.com";

/** The web's form posting a member's pass to an own host's member door, into its frame. */
function memberOn(host: string, body: string, headers: Record<string, string> = {}): Request {
	return hostRequest(host, MEMBER_PATH, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: WEB,
			"sec-fetch-site": "same-site",
			"sec-fetch-mode": "navigate",
			"sec-fetch-dest": "iframe",
			...headers,
		},
	});
}

const LOCKED = { state: "locked", scope: "site", public: false };
const NEXT_LOCKED = { state: "locked", scope: "next", public: false };
const WITH_SESSION = { cookie: `${HOST_COOKIE}=${TOKEN}` };
const CLEARED = `${HOST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** Everything a visitor's browser gets: status, every header and the bytes. */
async function snapshot(response: Response): Promise<{ status: number; headers: string[][]; body: string }> {
	return {
		status: response.status,
		headers: [...response.headers].sort(([a], [b]) => a.localeCompare(b)),
		body: Buffer.from(await response.arrayBuffer()).toString("base64"),
	};
}

/** Whether an answer of `serve` was asked on an own host (else a next host). */
function onOwnHost(response: Response): boolean {
	assert.ok(askedOn.has(response), "an answer of serve");
	return siteHost(askedOn.get(response) ?? null)?.scope === "site";
}

/** The headers every answer on a site host carries (C2 item 1 of the pre-check; D22, D23). An own host's may be framed
 * by the web (V1): frame-ancestors names the web's origins and there is no X-Frame-Options; a next host's keeps 'self'
 * with X-Frame-Options SAMEORIGIN. */
function assertHostHeaders(response: Response, what = "", origins: readonly string[] = DEFAULT_WEB_ORIGINS): void {
	const headers = response.headers;
	const own = onOwnHost(response);
	assert.equal(headers.get("x-content-type-options"), "nosniff", what);
	assert.equal(headers.get("x-frame-options"), own ? null : "SAMEORIGIN", what);
	assert.equal(headers.get("x-robots-tag"), "noindex, nofollow, noarchive", what);
	assert.equal(headers.get("cross-origin-resource-policy"), "same-origin", what);
	assert.equal(headers.get("cdn-cache-control"), "no-store", what);
	assert.equal(headers.get("strict-transport-security"), "max-age=31536000", what);
	assert.equal(headers.get("access-control-allow-origin"), null, what);
	assert.match(headers.get("cache-control") ?? "", /^(?:no-store|private, no-cache), no-transform$/, what);
	const csp = headers.get("content-security-policy") ?? "";
	const ancestors = own ? `frame-ancestors 'self' ${origins.join(" ")}` : "frame-ancestors 'self'";
	assert.ok(csp.split("; ").includes(ancestors), `${what}: ${csp}`);
	assert.equal(csp.match(/frame-ancestors/g)?.length, 1, what);
	assert.doesNotMatch(csp, /sandbox|frame-ancestors 'none'/, what);
	for (const cookie of headers.getSetCookie())
		assert.match(cookie, /^__Host-qorpera_site=[A-Za-z0-9_-]*; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/, what);
}

/** A platform page, redirect or robots.txt on a site host. */
function assertHostPage(
	response: Response,
	referrer = "no-referrer",
	origins: readonly string[] = DEFAULT_WEB_ORIGINS,
): void {
	assertHostHeaders(response, "", origins);
	assert.equal(
		response.headers.get("content-security-policy"),
		onOwnHost(response) ? ownPageSecurityPolicy(origins) : HOST_PAGE_SECURITY_POLICY,
	);
	assert.equal(response.headers.get("referrer-policy"), referrer);
	assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
}

function silenced<T>(run: (logged: string[]) => Promise<T>): Promise<T> {
	const logged: string[] = [];
	const original = console.error;
	console.error = (...items: unknown[]) => logged.push(items.map(String).join(" "));
	return run(logged).finally(() => {
		console.error = original;
	});
}

describe("site-serve: the host and the root", () => {
	it("serves only when x-forwarded-host is exactly the sites host, in any case", async () => {
		const { calls, store: siteStore } = store();
		for (const host of ["sites.qorpera.com", "SITES.Qorpera.COM", " sites.qorpera.com "]) {
			const response = await serve(
				request(`/shop/~${TOKEN}/`, { headers: { "x-forwarded-host": host } }),
				siteStore,
			);
			assert.equal(response.status, 200, host);
		}
		assert.equal(calls.serve.length, 3);
	});

	it("refuses every other forwarded host unasked: a list, a port, a trailing dot, a look-alike", async () => {
		const { calls, store: siteStore } = store();
		for (const host of [
			// Not a site host either (another level, another domain, no label): no database call at all.
			"a.api.qorpera.com",
			"api.qorpera.com.evil.example",
			"qorpera.com",
			"",
			// A list is never the front's: its sites host overwrites, its API host replaces a visitor's with its own Host.
			"sites.qorpera.com, api.qorpera.com",
			"api.qorpera.com, sites.qorpera.com",
			"sites.qorpera.com,sites.qorpera.com",
			// The front takes these to its API host, which passes the Host it was asked for: never the sites host.
			"sites.qorpera.com:443",
			"sites.qorpera.com:8080",
			"sites.qorpera.com.",
			// Only the spaces and tabs HTTP allows around a value are dropped (by Headers), nothing else.
			"\u00a0sites.qorpera.com",
			"sites.qorpera.com\u00a0",
			"sites.qorpera.com.evil.example",
			"evil.example/sites.qorpera.com",
			"https://sites.qorpera.com",
		]) {
			const response = await serve(
				request(`/shop/~${TOKEN}/`, { headers: { "x-forwarded-host": host } }),
				siteStore,
			);
			assert.equal(response.status, 404, host);
			assertPage(response);
		}
		// Two headers arrive joined as a list.
		const twice = new Headers({ "x-forwarded-host": "sites.qorpera.com" });
		twice.append("x-forwarded-host", "sites.qorpera.com");
		assert.equal((await serve(new Request(`${BASE}/shop/~${TOKEN}/`, { headers: twice }), siteStore)).status, 404);
		assert.equal(calls.serve.length, 0);
		assert.equal(calls.serveHost.length, 0);
	});

	it("leaves a first-level name under qorpera.com to the database: the API's and the app's names have no site", async () => {
		// The front never sends api, app or any name with a record of its own here; past a broken front, the one host rule
		// takes them as site hosts and SQL's name rule (reserved names) answers none: the password page, as for any name
		// with no site, and never a file.
		for (const host of ["api.qorpera.com", "app.qorpera.com", "xsites.qorpera.com"]) {
			const { calls, store: siteStore } = store();
			const response = await serve(request("/shop/", { headers: { "x-forwarded-host": host } }), siteStore);
			assert.equal(response.status, 401, host);
			assert.match(await response.text(), /<form method="post" action="\/\.qorpera\/unlock">/);
			assert.equal(calls.serve.length, 0);
			assert.deepEqual(calls.serveHost, [[host, "shop/", null, null, 0, MAX_FILE_BYTES]], host);
			// A session's path of the old form is no path of a site host: refused unasked.
			const old = await serve(request(`/shop/~${TOKEN}/`, { headers: { "x-forwarded-host": host } }), siteStore);
			assert.equal(old.status, 404, host);
			assert.equal(calls.serveHost.length, 1);
			// Before the migration (PGRST202), today's answer: 404.
			const before = store(undefined, undefined, { serveHost: new MissingFunction("qorpera_site_serve_host") });
			const today = await serve(request("/shop/", { headers: { "x-forwarded-host": host } }), before.store);
			assert.equal(today.status, 404, host);
			assertPage(today);
		}
	});

	it("never takes Host for the sites host: without x-forwarded-host nothing is served", async () => {
		const { calls, store: siteStore } = store();
		for (const host of ["sites.qorpera.com", "app.qorpera.com"]) {
			const bare = new Request(`${BASE}/shop/~${TOKEN}/`, { headers: { host } });
			assert.equal((await serve(bare, siteStore)).status, 404, host);
			const unlock = new Request(`${BASE}/shop/.qorpera/unlock`, {
				method: "POST",
				body: "password=pw",
				headers: { host, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			});
			assert.equal((await serve(unlock, siteStore)).status, 404, host);
		}
		assert.equal(calls.serve.length, 0);
		assert.equal(calls.unlock.length, 0);
	});

	it("takes the origin's own port when it names one", async () => {
		const answer = (host: string) =>
			handleSiteServe(request(`/shop/~${TOKEN}/`, { headers: { "x-forwarded-host": host } }), {
				origin: "https://sites.example.test:8443",
				store: store().store,
			});
		assert.equal((await answer("sites.example.test:8443")).status, 200);
		assert.equal((await answer("sites.example.test")).status, 404);
		assert.equal(
			onSitesHost(request("/", { headers: { "x-forwarded-host": "sites.qorpera.com" } }), new URL(ORIGIN)),
			true,
		);
	});

	it("takes the path with or without /functions/v1, and nothing else", async () => {
		const plain = await serve(request(`/shop/~${TOKEN}/`, {}, "https://functions.internal:9000/site-serve"));
		assert.equal(plain.status, 200);
		const other = await serve(request("/x", {}, "https://project.example.test/functions/v1/mail-outbox"));
		assert.equal(other.status, 404);
		const prefixed = await serve(request("/x", {}, "https://project.example.test/functions/v1/site-serve-x"));
		assert.equal(prefixed.status, 404);
	});

	it("answers robots.txt, nothing at the root and no favicon", async () => {
		const robots = await serve(request("/robots.txt"));
		assert.equal(robots.status, 200);
		assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
		assertPage(robots);
		assert.equal((await serve(request("/"))).status, 404);
		assert.equal((await serve(request(""))).status, 404);
		assert.equal((await serve(request("/favicon.ico"))).status, 404);
		const posted = await serve(request("/robots.txt", { method: "POST", body: "x" }));
		assert.equal(posted.status, 405);
		assert.equal(posted.headers.get("allow"), "GET, HEAD");
	});

	it("refuses a name that is no site name without asking the database", async () => {
		const { calls, store: siteStore } = store();
		for (const path of ["/Shop/", "/ab/", "/-shop/", "/shop-/", "/sh_op/", `/${"a".repeat(49)}/`, "/%73hop/"])
			assert.equal((await serve(request(path), siteStore)).status, 404, path);
		assert.equal(calls.serve.length, 0);
		assert.equal(calls.serveHost.length, 0);
	});

	it("adds a site's and a session's slash, keeping the query", async () => {
		const site = await serve(request("/shop?ref=1"));
		assert.equal(site.status, 308);
		assert.equal(site.headers.get("location"), "/shop/?ref=1");
		const session = await serve(request(`/shop/~${TOKEN}`));
		assert.equal(session.status, 308);
		assert.equal(session.headers.get("location"), `/shop/~${TOKEN}/`);
		assertPage(session);
	});
});

describe("site-serve: a session's files", () => {
	it("serves a file with the site's sandbox and no cookie", async () => {
		const { calls, store: siteStore } = store();
		const response = await serve(request(`/shop/~${TOKEN}/`), siteStore);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(response.headers.get("accept-ranges"), "bytes");
		assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(HTML)));
		assertContent(response, sha(HTML));
		assert.equal(await response.text(), HTML);
		assert.deepEqual(calls.serve, [["shop", "", TOKEN, null, 0, MAX_FILE_BYTES]]);
	});

	it("decodes each segment and hands the database the site path, folders with their slash", async () => {
		const { calls, store: siteStore } = store();
		await serve(request(`/shop/~${TOKEN}/img/logo-2.png`), siteStore);
		await serve(request(`/shop/~${TOKEN}/products/`), siteStore);
		await serve(request(`/shop/~${TOKEN}/%61bout.html?x=1`), siteStore);
		assert.deepEqual(
			calls.serve.map((call) => call[1]),
			["img/logo-2.png", "products/", "about.html"],
		);
	});

	it("serves binary bytes exactly, and refuses bytes that are not the file's", async () => {
		const bytes = new Uint8Array([0, 255, 1, 254, 137, 80, 78, 71]);
		const answer = {
			state: "file",
			path: "a.png",
			contentType: "image/png",
			bytes: bytes.byteLength,
			sha256: sha(bytes),
			content: Buffer.from(bytes).toString("base64"),
		};
		const response = await serve(request(`/shop/~${TOKEN}/a.png`), store(answer).store);
		assert.equal(response.status, 200);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
		for (const wrong of [
			{ ...answer, sha256: "0".repeat(64) },
			{ ...answer, bytes: 9 },
		]) {
			const refused = await serve(request(`/shop/~${TOKEN}/a.png`), store(wrong).store);
			assert.equal(refused.status, 503);
		}
	});

	it("answers 304 to a visitor who holds the file", async () => {
		const hash = sha(HTML);
		const { calls, store: siteStore } = store(file(HTML, { content: null }));
		const response = await serve(
			request(`/shop/~${TOKEN}/`, { headers: { "if-none-match": `W/"${hash}"` } }),
			siteStore,
		);
		assert.equal(response.status, 304);
		assert.equal(response.headers.get("etag"), `"${hash}"`);
		assert.equal(await response.text(), "");
		assert.deepEqual(calls.serve, [["shop", "", TOKEN, hash, 0, MAX_FILE_BYTES]]);
		// Content left out for another hash than the visitor's is no answer.
		const other = await serve(
			request(`/shop/~${TOKEN}/`, { headers: { "if-none-match": `"${"1".repeat(64)}"` } }),
			store(file(HTML, { content: null })).store,
		);
		assert.equal(other.status, 503);
	});

	it("serves one byte range, asking the database for those bytes only, and refuses one past the end", async () => {
		const text = "0123456789";
		const { calls, store: siteStore } = store(file(text, { path: "v.mp4", contentType: "video/mp4" }));
		const first = await serve(request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=2-5" } }), siteStore);
		assert.equal(first.status, 206);
		assert.equal(first.headers.get("content-range"), "bytes 2-5/10");
		assert.equal(first.headers.get("content-length"), "4");
		assert.equal(await first.text(), "2345");
		assert.deepEqual(calls.serve.at(-1)?.slice(4), [2, 4]);
		const suffix = await serve(request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=-3" } }), siteStore);
		assert.equal(await suffix.text(), "789");
		// The last bytes: the size first, then just them.
		assert.deepEqual(
			calls.serve.slice(-2).map((call) => call.slice(4)),
			[
				[0, 0],
				[7, 3],
			],
		);
		const open = await serve(request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=8-" } }), siteStore);
		assert.equal(open.headers.get("content-range"), "bytes 8-9/10");
		const past = await serve(request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=10-12" } }), siteStore);
		assert.equal(past.status, 416);
		assert.equal(past.headers.get("content-range"), "bytes */10");
		const several = await serve(request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=0-1,3-4" } }), siteStore);
		assert.equal(several.status, 200);
		assert.equal(await several.text(), text);
		const stale = await serve(
			request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=0-1", "if-range": '"old"' } }),
			siteStore,
		);
		assert.equal(stale.status, 200);
		assert.deepEqual(rangeRequest("bytes=2-5"), { offset: 2, length: 4 });
		assert.deepEqual(rangeRequest("bytes=8-"), { offset: 8, length: MAX_FILE_BYTES });
		assert.deepEqual(rangeRequest("bytes=-3"), { suffix: 3 });
		assert.equal(rangeRequest("bytes=5-2"), undefined);
		assert.deepEqual(byteRange("bytes=5-2", 10), undefined);
		assert.deepEqual(byteRange("bytes=0-99", 10), { start: 0, end: 9 });
		assert.equal(byteRange("bytes=-0", 10), "unsatisfiable");
		assert.equal(byteRange("items=0-1", 10), undefined);
	});

	it("answers HEAD with the headers and no body, asking the database for no bytes", async () => {
		const { calls, store: siteStore } = store();
		const response = await serve(request(`/shop/~${TOKEN}/`, { method: "HEAD" }), siteStore);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(HTML)));
		assertContent(response, sha(HTML));
		assert.equal(await response.text(), "");
		assert.deepEqual(calls.serve, [["shop", "", TOKEN, null, 0, 0]]);
	});

	it("redirects a folder to its slash, says a missing page is not part of the site, and sends an ended session to the password", async () => {
		const directory = await serve(
			request(`/shop/~${TOKEN}/products?p=2`),
			store({ state: "directory", path: "products/" }).store,
		);
		assert.equal(directory.status, 308);
		assert.equal(directory.headers.get("location"), `/shop/~${TOKEN}/products/?p=2`);
		const missing = await serve(
			request(`/shop/~${TOKEN}/gone.html`, { headers: { "accept-language": "da-DK,da;q=0.9,en;q=0.8" } }),
			store({ state: "missing" }).store,
		);
		assert.equal(missing.status, 404);
		assertPage(missing);
		assert.match(await missing.text(), /Denne side hører ikke til sitet\./);
		const ended = await serve(request(`/shop/~${TOKEN}/a/b.html?q=1`), store({ state: "locked" }).store);
		assert.equal(ended.status, 303);
		assert.equal(ended.headers.get("location"), "/shop/a/b.html?q=1");
		assert.equal(ended.headers.get("set-cookie"), null);
	});

	it("refuses traversal, escaped separators, hidden names, control characters and odd tokens unasked", async () => {
		const { calls, store: siteStore } = store();
		for (const path of [
			`/shop/~${TOKEN}/a%2Fb.html`,
			`/shop/~${TOKEN}/a%2fb.html`,
			`/shop/~${TOKEN}/%2e%2e%2fsecret`,
			`/shop/~${TOKEN}/a%5Cb`,
			`/shop/~${TOKEN}/a%00b`,
			`/shop/~${TOKEN}/.env`,
			`/shop/~${TOKEN}/.qorpera/unlock`,
			`/shop/~${TOKEN}/a//b.html`,
			`/shop/~${TOKEN}/%E0%A4%A`,
			`/shop/~${TOKEN}/a b.html`,
			`/shop/~${TOKEN}/${"a/".repeat(17)}x`,
			`/shop/~${TOKEN}/${"a".repeat(201)}`,
			`/shop/~${TOKEN.slice(1)}/`,
			"/shop/~/",
			`/shop/~${TOKEN}!/`,
			"/shop/a%2Fb.html",
			"/shop/.git/config",
			"/shop/.qorpera/other",
		]) {
			const response = await serve(request(path), siteStore);
			assert.equal(response.status, 404, path);
			assertPage(response);
		}
		assert.equal(calls.serve.length, 0);
		assert.equal(isSitePath("a/../b"), false);
		assert.equal(isSitePath("a/./b"), false);
		assert.equal(isSitePath("dir/"), true);
		assert.equal(isSitePath("/abs"), false);
	});

	it("answers 503 when the database fails or answers what it never would, logging no token", async () => {
		const logged: string[] = [];
		const original = console.error;
		console.error = (...items: unknown[]) => logged.push(items.join(" "));
		try {
			for (const answer of [
				new Error(`boom ${TOKEN}`),
				{ state: "file" },
				{ state: "locked", extra: 1 },
				{ state: "teapot" },
				{ ...file(HTML), path: "../x" },
				null,
			]) {
				const response = await serve(request(`/shop/~${TOKEN}/`), store(answer).store);
				assert.equal(response.status, 503);
				assert.equal(response.headers.get("retry-after"), "30");
				assertPage(response);
			}
		} finally {
			console.error = original;
		}
		assert.ok(logged.length > 0);
		assert.ok(
			logged.every((line) => !line.includes(TOKEN)),
			logged.join("\n"),
		);
	});

	it("answers a CORS preflight on a session's path, and refuses other methods", async () => {
		const { calls, store: siteStore } = store();
		const preflight = await serve(request(`/shop/~${TOKEN}/data.json`, { method: "OPTIONS" }), siteStore);
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
		assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD");
		assert.equal(preflight.headers.get("access-control-allow-headers"), "Range, If-None-Match");
		assert.equal(preflight.headers.get("cache-control"), "no-store, no-transform");
		const posted = await serve(request(`/shop/~${TOKEN}/x`, { method: "POST", body: "x" }), siteStore);
		assert.equal(posted.status, 405);
		assert.equal(posted.headers.get("allow"), "GET, HEAD, OPTIONS");
		assert.equal(calls.serve.length, 0);
	});
});

describe("site-serve: the plain URL", () => {
	it("shows the password page for any site, without asking the database", async () => {
		const { calls, store: siteStore } = store();
		const response = await serve(request("/shop/products/"), siteStore);
		assert.equal(response.status, 401);
		assert.equal(response.headers.get("www-authenticate"), null);
		assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
		// The form's POST carries its origin under same-origin; a plain URL holds no token.
		assertPage(response, "same-origin");
		const html = await response.text();
		assert.match(html, /<h1>Private site<\/h1>/);
		assert.match(html, /<form method="post" action="\/shop\/\.qorpera\/unlock">/);
		assert.match(html, /<input type="hidden" name="next" value="products\/">/);
		assert.match(html, /name="robots" content="noindex,nofollow"/);
		// Its own policy in the page too: a no-referrer meta would make the form's POST say `Origin: null`, which the
		// unlock refuses (as it refuses a sandboxed site's).
		assert.match(html, /<meta name="referrer" content="same-origin">/);
		assert.doesNotMatch(html, /content="no-referrer"/);
		assert.equal(calls.serve.length, 0);
		const danish = await serve(request("/shop/", { headers: { "accept-language": "da" } }), siteStore);
		assert.match(await danish.text(), /<html lang="da">[\s\S]*Privat side/);
	});

	it("reloads a cross-site navigation once, so a SameSite=Strict cookie comes along", async () => {
		const cross = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
		const reload = await serve(request("/shop/", { headers: cross }));
		assert.equal(reload.status, 200);
		assertPage(reload);
		const reloadHtml = await reload.text();
		assert.match(reloadHtml, /<meta http-equiv="refresh" content="0">/);
		assert.match(reloadHtml, /<meta name="referrer" content="no-referrer">/);
		// The reload is same-origin: the password page, no loop.
		const again = await serve(request("/shop/", { headers: { ...cross, "sec-fetch-site": "same-origin" } }));
		assert.equal(again.status, 401);
		const subresource = await serve(request("/shop/a.png", { headers: { ...cross, "sec-fetch-mode": "no-cors" } }));
		assert.equal(subresource.status, 401);
		const head = await serve(request("/shop/", { method: "HEAD", headers: cross }));
		assert.equal(head.status, 401);
	});

	it("sends a visitor with a live session's cookie into its path, keeping the page and query", async () => {
		const { calls, store: siteStore } = store();
		const response = await serve(
			request("/shop/products/item.html?id=7", { headers: { cookie: `other=1; qorpera_site=${TOKEN}` } }),
			siteStore,
		);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), `/shop/~${TOKEN}/products/item.html?id=7`);
		// A check only: no bytes.
		assert.deepEqual(calls.serve, [["shop", "products/item.html", TOKEN, null, 0, 0]]);
		for (const answer of [{ state: "missing" }, { state: "directory", path: "products/" }]) {
			const other = await serve(
				request("/shop/products", { headers: { cookie: `qorpera_site=${TOKEN}` } }),
				store(answer).store,
			);
			assert.equal(other.status, 303);
		}
	});

	it("tries each session cookie the browser sent, at most three, so a wider cookie never hides the site's own", async () => {
		const { calls, store: siteStore } = store((path: string) => (path === "" ? { state: "locked" } : file(HTML)));
		const answers: unknown[] = [{ state: "locked" }, file(HTML)];
		const twoCookies = store(() => answers.shift());
		const response = await serve(
			request("/shop/", { headers: { cookie: `qorpera_site=${TOKEN}; qorpera_site=${NEW_TOKEN}` } }),
			twoCookies.store,
		);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), `/shop/~${NEW_TOKEN}/`);
		assert.deepEqual(
			twoCookies.calls.serve.map((call) => call[2]),
			[TOKEN, NEW_TOKEN],
		);
		const many = Array.from({ length: 5 }, (_, n) => `qorpera_site=${String(n).repeat(32)}`).join("; ");
		await serve(request("/shop/", { headers: { cookie: many } }), siteStore);
		assert.equal(calls.serve.length, 3);
	});

	it("clears an ended session's cookie and asks for the password", async () => {
		const response = await serve(
			request("/shop/", { headers: { cookie: `qorpera_site=${TOKEN}` } }),
			store({ state: "locked" }).store,
		);
		assert.equal(response.status, 401);
		assert.equal(
			response.headers.get("set-cookie"),
			"qorpera_site=; Path=/shop/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
		);
		const { calls, store: siteStore } = store();
		const malformed = await serve(request("/shop/", { headers: { cookie: "qorpera_site=short" } }), siteStore);
		assert.equal(malformed.status, 401);
		assert.equal(calls.serve.length, 0);
	});

	it("refuses methods other than GET and HEAD", async () => {
		const response = await serve(request("/shop/x.html", { method: "PUT", body: "x" }));
		assert.equal(response.status, 405);
		assert.equal(response.headers.get("allow"), "GET, HEAD");
	});
});

describe("site-serve: the password form", () => {
	it("opens a session: a Strict, HttpOnly, path-scoped cookie and the session's path", async () => {
		const { calls, store: siteStore } = store();
		const response = await serve(
			post("shop", "password=k7mq-x2pa-9fhd&next=products%2Fitem.html", { "cf-connecting-ip": "203.0.113.9" }),
			siteStore,
		);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), `/shop/~${NEW_TOKEN}/products/item.html`);
		assert.equal(
			response.headers.get("set-cookie"),
			`qorpera_site=${NEW_TOKEN}; Path=/shop/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`,
		);
		assertPage(response);
		assert.deepEqual(calls.unlock, [["shop", "k7mq-x2pa-9fhd", "203.0.113.9"]]);
	});

	it("keeps the redirect inside the site whatever next says", async () => {
		for (const next of [
			"https://evil.example/",
			"//evil.example",
			"../other/",
			"/abs",
			"a/../../b",
			".qorpera/unlock",
		]) {
			const response = await serve(post("shop", `password=pw&next=${encodeURIComponent(next)}`));
			assert.equal(response.headers.get("location"), `/shop/~${NEW_TOKEN}/`, next);
		}
		const { calls, store: siteStore } = store();
		await serve(post("shop", "password=pw"), siteStore);
		assert.deepEqual(calls.unlock, [["shop", "pw", ""]]);
	});

	it("answers a wrong password, too many tries and an empty password with the form again", async () => {
		const wrong = await serve(post("shop", "password=nope&next=a.html"), store(undefined, { state: "wrong" }).store);
		assert.equal(wrong.status, 401);
		assertPage(wrong, "same-origin");
		const html = await wrong.text();
		assert.match(html, /That password is not right\. Try again\./);
		assert.match(html, /name="next" value="a\.html"/);
		assert.equal(wrong.headers.get("set-cookie"), null);
		const limited = await serve(
			post("shop", "password=nope", { "accept-language": "da" }),
			store(undefined, { state: "limited", retryAfter: 125 }).store,
		);
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("retry-after"), "125");
		assert.match(await limited.text(), /Prøv igen om 3 minutter\./);
		const { calls, store: siteStore } = store();
		const empty = await serve(post("shop", "password=&next="), siteStore);
		assert.equal(empty.status, 401);
		const long = await serve(post("shop", `password=${"x".repeat(1025)}`), siteStore);
		assert.equal(long.status, 401);
		assert.equal(calls.unlock.length, 0);
	});

	it("refuses another origin, another body type and a body over 4 KiB unasked", async () => {
		const { calls, store: siteStore } = store();
		for (const origin of ["https://evil.example", "null", "https://app.qorpera.com"])
			assert.equal((await serve(post("shop", "password=pw", { origin }), siteStore)).status, 403, origin);
		const json = await serve(post("shop", '{"password":"pw"}', { "content-type": "application/json" }), siteStore);
		assert.equal(json.status, 415);
		const big = await serve(post("shop", `password=${"x".repeat(MAX_UNLOCK_BODY_BYTES)}`), siteStore);
		assert.equal(big.status, 413);
		// Streamed with no length: cut while reading.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(1024).fill(120));
				controller.close();
			},
		});
		// A streamed body needs duplex "half" in Node's fetch.
		const streamed = new Request(`${BASE}/shop/.qorpera/unlock`, {
			method: "POST",
			body: stream,
			duplex: "half",
			headers: { "x-forwarded-host": "sites.qorpera.com", "content-type": "application/x-www-form-urlencoded" },
		} as RequestInit);
		assert.equal((await serve(streamed, siteStore)).status, 413);
		assert.equal(calls.unlock.length, 0);
		// No Origin at all (an older browser): allowed.
		const bare = await serve(
			request("/shop/.qorpera/unlock", {
				method: "POST",
				body: "password=pw",
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
			siteStore,
		);
		assert.equal(bare.status, 303);
	});

	it("keys the limits on CF-Connecting-IP only, and only when it holds one address", async () => {
		const cases: [Record<string, string>, string][] = [
			[{ "cf-connecting-ip": "203.0.113.9" }, "203.0.113.9"],
			// The database counts an IPv6 address's /64; any spelling of it is one address.
			[{ "cf-connecting-ip": "2001:DB8:0:0:0:0:0:1" }, "2001:db8::1"],
			[{ "cf-connecting-ip": "::ffff:203.0.113.9" }, "203.0.113.9"],
			// Headers a visitor sets, which Cloudflare passes on or appends to: never a key.
			[
				{
					"cf-connecting-ip": "203.0.113.9",
					"x-forwarded-for": "198.51.100.1",
					"x-real-ip": "198.51.100.2",
					"true-client-ip": "198.51.100.3",
					forwarded: "for=198.51.100.4",
				},
				"203.0.113.9",
			],
			[
				{
					"x-forwarded-for": "198.51.100.1",
					"x-real-ip": "198.51.100.2",
					"true-client-ip": "198.51.100.3",
					forwarded: "for=198.51.100.4",
				},
				"",
			],
			// Not one address: one key shared by every such request, never a fresh one per spelling.
			[{ "cf-connecting-ip": "203.0.113.9, 198.51.100.1" }, ""],
			[{ "cf-connecting-ip": `guess-${"x".repeat(40)}` }, ""],
		];
		for (const [headers, client] of cases) {
			const { calls, store: siteStore } = store(undefined, { state: "wrong" });
			await serve(post("shop", "password=pw", headers), siteStore);
			assert.deepEqual(calls.unlock, [["shop", "pw", client]], JSON.stringify(headers));
		}
		for (const value of [
			"203.0.113.9:443",
			"203.0.113.9/8",
			"203.0.113.09",
			"256.0.0.1",
			"203.0.113",
			"fe80::1%eth0",
			"[2001:db8::1]",
			"2001:db8::1/64",
			"2001:db8::1::2",
			"1:2:3:4:5:6:7:8:9",
			"localhost",
			"",
		])
			assert.equal(clientAddress(value), "", value);
		assert.equal(clientAddress(null), "");
		assert.equal(clientAddress("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb:1:2:3:4");
		assert.equal(clientAddress("0:0:0:0:0:ffff:c000:0201"), "192.0.2.1");
		assert.equal(clientAddress("::"), "::");
	});

	it("keeps one counter a slug: another case or an escaped letter is no site name and reaches no limit", async () => {
		const { calls, store: siteStore } = store();
		// The front decodes an escaped letter (normalize_path) before the function sees it, so /%73hop/ arrives as /shop/;
		// one that still arrives escaped is refused, as is any capital.
		for (const slug of ["Shop", "SHOP", "%73hop", "sh%6Fp", "shop%2D1"]) {
			const response = await serve(
				request(`/${slug}/.qorpera/unlock`, {
					method: "POST",
					body: "password=pw",
					headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
				}),
				siteStore,
			);
			assert.equal(response.status, 404, slug);
		}
		assert.equal(calls.unlock.length, 0);
	});

	it("sends GET of the form's address to the site, and refuses other methods", async () => {
		const response = await serve(request("/shop/.qorpera/unlock"));
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/shop/");
		const put = await serve(request("/shop/.qorpera/unlock", { method: "PUT", body: "x" }));
		assert.equal(put.status, 405);
		assert.equal(put.headers.get("allow"), "POST");
	});

	it("answers 503 when the database fails or answers oddly", async () => {
		const original = console.error;
		console.error = () => {};
		try {
			for (const answer of [
				new Error("down"),
				{ state: "open", token: "short", maxAge: 60 },
				{ state: "open", token: NEW_TOKEN, maxAge: 0 },
				{ state: "limited" },
				{ state: "wrong", token: NEW_TOKEN },
			]) {
				const response = await serve(post("shop", "password=pw"), store(undefined, answer).store);
				assert.equal(response.status, 503, JSON.stringify(answer instanceof Error ? "error" : answer));
				assert.equal(response.headers.get("set-cookie"), null);
			}
		} finally {
			console.error = original;
		}
	});
});

describe("site-serve: helpers", () => {
	it("escapes what a page echoes", () => {
		assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	});

	it("picks Danish only when the visitor prefers it to English", () => {
		assert.equal(language(null), "en");
		assert.equal(language("da"), "da");
		assert.equal(language("da-DK,da;q=0.9,en-US;q=0.8"), "da");
		assert.equal(language("en-GB,en;q=0.9,da;q=0.8"), "en");
		assert.equal(language("de-DE,da;q=0.5"), "da");
		assert.equal(language("en;q=0.2,da;q=0.6"), "da");
		assert.equal(language("da;q=0,en"), "en");
	});

	it("reads the hash an If-None-Match names", () => {
		const hash = "a".repeat(64);
		assert.equal(requestedEtag(`"${hash}"`), hash);
		assert.equal(requestedEtag(`W/"${hash}"`), hash);
		assert.equal(requestedEtag(`"x", "${hash}"`), hash);
		assert.equal(requestedEtag("*"), null);
		assert.equal(requestedEtag(null), null);
	});

	it("takes a database answer only in its exact shape", () => {
		const whole = { length: MAX_FILE_BYTES };
		assert.equal(parseServeAnswer({ state: "locked" }, null, whole).state, "locked");
		assert.throws(() => parseServeAnswer({ state: "directory", path: "a" }, null, whole));
		assert.throws(() => parseServeAnswer({ ...file(HTML), content: "not base64!" }, null, whole));
		// The offset is the file's, from 0 to its size; no content only when none was asked for, the visitor holds the
		// file, or the bytes asked for start at its end.
		assert.throws(() => parseServeAnswer(file(HTML), null, whole));
		assert.throws(() => parseServeAnswer(file(HTML, { offset: -1 }), null, whole));
		assert.throws(() => parseServeAnswer(file(HTML, { offset: Buffer.byteLength(HTML) + 1 }), null, whole));
		assert.throws(() => parseServeAnswer(file(HTML, { offset: 0, content: null }), null, whole));
		assert.equal(parseServeAnswer(file(HTML, { offset: 0, content: null }), null, { length: 0 }).state, "file");
		assert.equal(parseServeAnswer(file(HTML, { offset: 0, content: null }), sha(HTML), whole).state, "file");
		assert.equal(
			parseServeAnswer(file(HTML, { offset: Buffer.byteLength(HTML), content: null }), null, whole).state,
			"file",
		);
		assert.equal(
			(
				parseServeAnswer(file(HTML, { offset: 0, contentType: "text/html; charset=latin1" }), null, whole) as {
					contentType: string;
				}
			).contentType,
			"application/octet-stream",
		);
	});
});

describe("site-serve: the database through PostgREST", () => {
	function fetcher(responses: Response[]) {
		const sent: { url: string; init: RequestInit }[] = [];
		const fake = (async (url: string | URL | Request, init?: RequestInit) => {
			sent.push({ url: String(url), init: init ?? {} });
			const next = responses.shift();
			if (!next) throw new Error("no answer");
			return next;
		}) as typeof fetch;
		return { sent, fake };
	}

	it("calls the two RPCs with the service key, no redirect and a deadline", async () => {
		const { sent, fake } = fetcher([Response.json({ state: "locked" }), Response.json({ state: "wrong" })]);
		const siteStore = new PostgrestSiteStore("https://project.example.test/", "sb_secret_0123456789abcdefghij", fake);
		assert.deepEqual(await siteStore.serve("shop", "a.html", TOKEN, null, 3, 7), { state: "locked" });
		assert.deepEqual(await siteStore.unlock("shop", "pw", "203.0.113.9"), { state: "wrong" });
		assert.equal(sent[0]?.url, "https://project.example.test/rest/v1/rpc/qorpera_site_serve");
		assert.equal(sent[1]?.url, "https://project.example.test/rest/v1/rpc/qorpera_site_unlock");
		assert.deepEqual(JSON.parse(String(sent[0]?.init.body)), {
			p_slug: "shop",
			p_path: "a.html",
			p_token: TOKEN,
			p_etag: null,
			p_offset: 3,
			p_length: 7,
		});
		assert.deepEqual(JSON.parse(String(sent[1]?.init.body)), {
			p_slug: "shop",
			p_password: "pw",
			p_client: "203.0.113.9",
		});
		for (const call of sent) {
			assert.equal(call.init.method, "POST");
			assert.equal(call.init.redirect, "error");
			assert.ok(call.init.signal instanceof AbortSignal);
			assert.deepEqual(call.init.headers, {
				apikey: "sb_secret_0123456789abcdefghij",
				"content-type": "application/json",
			});
		}
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"service_role"}').toString("base64url")}.c2ln`;
		assert.deepEqual(serviceHeaders(jwt), { apikey: jwt, authorization: `Bearer ${jwt}` });
	});

	it("throws on an error status, a declared or streamed answer over 16 MiB, and invalid JSON", async () => {
		const huge = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
				controller.close();
			},
		});
		const { fake } = fetcher([
			new Response("{}", { status: 500 }),
			new Response("{}", { headers: { "content-length": String(MAX_STORE_ANSWER_BYTES + 1) } }),
			new Response(huge),
			new Response("not json"),
		]);
		const siteStore = new PostgrestSiteStore("https://project.example.test", "sb_secret_0123456789abcdefghij", fake);
		for (let i = 0; i < 4; i++) await assert.rejects(siteStore.serve("shop", "", null, null, 0, 0));
	});

	it("calls the site host RPCs with the service key, no redirect and a deadline", async () => {
		const { sent, fake } = fetcher([
			Response.json({ state: "none" }),
			Response.json({ state: "wrong" }),
			Response.json({ state: "refused" }),
		]);
		const siteStore = new PostgrestSiteStore("https://project.example.test/", "sb_secret_0123456789abcdefghij", fake);
		assert.deepEqual(await siteStore.serveHost(OWN, "a.html", TOKEN, null, 3, 7), { state: "none" });
		assert.deepEqual(await siteStore.unlockHost(OWN, "pw", "203.0.113.9"), { state: "wrong" });
		assert.deepEqual(await siteStore.enter(NEXT, TICKET), { state: "refused" });
		assert.deepEqual(
			sent.map((call) => call.url),
			[
				"https://project.example.test/rest/v1/rpc/qorpera_site_serve_host",
				"https://project.example.test/rest/v1/rpc/qorpera_site_unlock_host",
				"https://project.example.test/rest/v1/rpc/qorpera_site_enter",
			],
		);
		assert.deepEqual(JSON.parse(String(sent[0]?.init.body)), {
			p_host: OWN,
			p_path: "a.html",
			p_token: TOKEN,
			p_etag: null,
			p_offset: 3,
			p_length: 7,
		});
		assert.deepEqual(JSON.parse(String(sent[1]?.init.body)), {
			p_host: OWN,
			p_password: "pw",
			p_client: "203.0.113.9",
		});
		assert.deepEqual(JSON.parse(String(sent[2]?.init.body)), { p_host: NEXT, p_ticket: TICKET });
		for (const call of sent) {
			assert.equal(call.init.method, "POST");
			assert.equal(call.init.redirect, "error");
			assert.ok(call.init.signal instanceof AbortSignal);
			assert.deepEqual(call.init.headers, {
				apikey: "sb_secret_0123456789abcdefghij",
				"content-type": "application/json",
			});
		}
	});

	it("reads only PostgREST's 404 PGRST202 as a function the database does not have yet", async () => {
		const { fake } = fetcher([
			new Response(JSON.stringify(PGRST202), { status: 404, headers: { "content-type": "application/json" } }),
			// Any other error stays an error: another code, no JSON, a body over 4 KiB, another status, no body.
			new Response(JSON.stringify({ ...PGRST202, code: "PGRST205" }), { status: 404 }),
			new Response("not json", { status: 404 }),
			new Response(JSON.stringify({ ...PGRST202, details: "x".repeat(5000) }), { status: 404 }),
			new Response(JSON.stringify(PGRST202), { status: 500 }),
			new Response(JSON.stringify(PGRST202), { status: 400 }),
			new Response(null, { status: 404 }),
		]);
		const siteStore = new PostgrestSiteStore("https://project.example.test", "sb_secret_0123456789abcdefghij", fake);
		await assert.rejects(siteStore.serveHost(OWN, "", null, null, 0, 0), MissingFunction);
		for (let i = 0; i < 6; i++)
			await assert.rejects(
				siteStore.serveHost(OWN, "", null, null, 0, 0),
				(error: unknown) => error instanceof Error && !(error instanceof MissingFunction),
			);
	});

	it("answers as today on every host when the database has no site host calls yet (installed before its migration)", async () => {
		// PostgREST with today's two calls only.
		const routes = (url: string): Response => {
			if (url.endsWith("/qorpera_site_serve")) return Response.json({ state: "locked" });
			if (url.endsWith("/qorpera_site_unlock")) return Response.json({ state: "wrong" });
			return new Response(JSON.stringify(PGRST202), { status: 404 });
		};
		const sent: string[] = [];
		const fake = (async (url: string | URL | Request) => {
			sent.push(String(url).replace(/^.*\/rpc\//, ""));
			return routes(String(url));
		}) as typeof fetch;
		const siteStore = new PostgrestSiteStore("https://project.example.test", "sb_secret_0123456789abcdefghij", fake);
		const plain = await serve(request("/look-shop/"), siteStore);
		assert.equal(plain.status, 401);
		assertPage(plain, "same-origin");
		assert.match(await plain.text(), /action="\/look-shop\/\.qorpera\/unlock"/);
		const session = await serve(request(`/look-shop/~${TOKEN}/a.html`), siteStore);
		assert.equal(session.status, 303);
		assert.equal(session.headers.get("location"), "/look-shop/a.html");
		const unlock = await serve(post("look-shop", "password=pw"), siteStore);
		assert.equal(unlock.status, 401);
		assert.deepEqual(sent, [
			"qorpera_site_serve_host",
			"qorpera_site_serve_host",
			"qorpera_site_serve",
			"qorpera_site_serve_host",
			"qorpera_site_unlock",
		]);
		// A site host: today's 404, as before the front sent site hosts here.
		sent.length = 0;
		for (const make of [
			() => hostRequest(OWN, "/", { headers: { cookie: `${HOST_COOKIE}=${TOKEN}` } }),
			() => hostRequest(NEXT, "/products/"),
			() => unlockOn(OWN, "password=pw"),
			() => hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`),
		]) {
			const response = await serve(make(), siteStore);
			assert.equal(response.status, 404);
			assertPage(response);
			assert.match(await response.text(), /There is no page at this address\./);
		}
		assert.deepEqual(sent, [
			"qorpera_site_serve_host",
			"qorpera_site_serve_host",
			"qorpera_site_unlock_host",
			"qorpera_site_enter",
		]);
	});
});

describe("site-serve: the one host rule", () => {
	it("reads an own host and a next host as SQL's pinned cases do", () => {
		assert.deepEqual(siteHost("look-shop.qorpera.com"), { host: OWN, slug: "look-shop", scope: "site" });
		assert.deepEqual(siteHost("webshop--next.qorpera.com"), {
			host: "webshop--next.qorpera.com",
			slug: "webshop",
			scope: "next",
		});
		// The rule's part only: shop is a reserved name, which SQL refuses (none).
		assert.deepEqual(siteHost("shop--next.qorpera.com")?.slug, "shop");
		assert.deepEqual(siteHost("shop-next.qorpera.com"), {
			host: "shop-next.qorpera.com",
			slug: "shop-next",
			scope: "site",
		});
		assert.deepEqual(siteHost("shop-next--next.qorpera.com"), {
			host: "shop-next--next.qorpera.com",
			slug: "shop-next",
			scope: "next",
		});
		const longest = "a".repeat(48);
		assert.equal(siteHost(`${longest}.qorpera.com`)?.slug, longest);
		assert.equal(siteHost(`${longest}--next.qorpera.com`)?.scope, "next");
		assert.equal(siteHost(`${"a".repeat(3)}.qorpera.com`)?.slug, "aaa");
		// Callers lower-case: the front passes the name as the browser sent it.
		assert.deepEqual(siteHost("Look-Shop.QORPERA.com"), { host: OWN, slug: "look-shop", scope: "site" });
	});

	it("is no site host for anything else", () => {
		for (const host of [
			`${"a".repeat(49)}.qorpera.com`,
			`${"a".repeat(49)}--next.qorpera.com`,
			"ab.qorpera.com",
			"ab--next.qorpera.com",
			"a--b.qorpera.com",
			"--next.qorpera.com",
			"-next.qorpera.com",
			"shop---next.qorpera.com",
			"x--next--next.qorpera.com",
			"-shop.qorpera.com",
			"shop-.qorpera.com",
			"sh_op.qorpera.com",
			"xn--bcher-kva.qorpera.com",
			"xn--next.qorpera.com",
			"a.look-shop.qorpera.com",
			"look-shop.qorpera.com.",
			"look-shop.qorpera.com:443",
			"look-shop.qorpera.co",
			"look-shop.qorpera.com.evil.example",
			"look-shop.example.com",
			"look-shop.qorpera.com, other-shop.qorpera.com",
			"https://look-shop.qorpera.com",
			"qorpera.com",
			".qorpera.com",
			"",
		])
			assert.equal(siteHost(host), null, host);
		assert.equal(siteHost(null), null);
	});

	it("takes and refuses every host of the one host list (SQL test 1252) as SQL does, leaving the name rule to SQL", async () => {
		const list = oneHostList();
		for (const { host, slug, scope, verdict } of list) {
			// taken and case: the host (lower-cased) by the rule. name: the rule's shape reads slug and scope, and SQL refuses
			// the name (none). shape: no site host. port and dot: refused as written (the front drops both before it sends the
			// name on, so site-serve never sees them).
			if (verdict === "taken" || verdict === "case" || verdict === "name")
				assert.deepEqual(siteHost(host), { host: host.toLowerCase(), slug, scope }, host);
			else assert.equal(siteHost(host), null, host);
		}
		// A name the rule refuses shows what any host with no site shows (SQL answers none for it), byte for byte: on the
		// own host the password page, on the next host "Not live yet". The old host's name (sites) is the old host first.
		const none = store(undefined, undefined, { serveHost: { state: "none" } });
		const answers = {
			site: await snapshot(await serve(hostRequest(OWN, "/"), none.store)),
			next: await snapshot(await serve(hostRequest(NEXT, "/"), none.store)),
		};
		assert.equal(answers.site.status, 401);
		assert.equal(answers.next.status, 401);
		for (const { host, scope } of list.filter((row) => row.verdict === "name" && row.host !== "sites.qorpera.com")) {
			const { calls, store: siteStore } = store(undefined, undefined, { serveHost: { state: "none" } });
			assert.deepEqual(
				await snapshot(await serve(hostRequest(host, "/"), siteStore)),
				answers[scope as "site" | "next"],
				host,
			);
			assert.deepEqual(calls.serveHost, [[host, "", null, null, 0, MAX_FILE_BYTES]], host);
		}
	});
});

describe("site-serve: a site's own host", () => {
	it("serves the live version's file at the top to a visitor's session: its own origin, no sandbox", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML) });
		const response = await serve(hostRequest(OWN, "/", { headers: WITH_SESSION }), siteStore);
		assert.equal(response.status, 200);
		assertHostHeaders(response);
		assert.equal(response.headers.get("content-security-policy"), ownContentSecurityPolicy(DEFAULT_WEB_ORIGINS));
		assert.equal(ownContentSecurityPolicy(DEFAULT_WEB_ORIGINS), "frame-ancestors 'self' https://app.qorpera.com");
		assert.equal(response.headers.get("cache-control"), "private, no-cache, no-transform");
		assert.equal(response.headers.get("etag"), `"${sha(HTML)}"`);
		assert.equal(response.headers.get("referrer-policy"), "same-origin");
		assert.equal(response.headers.get("accept-ranges"), "bytes");
		assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(response.headers.get("set-cookie"), null);
		assert.equal(await response.text(), HTML);
		assert.deepEqual(calls.serveHost, [[OWN, "", TOKEN, null, 0, MAX_FILE_BYTES]]);
		assert.equal(calls.serve.length, 0);
	});

	it("hands the database the host lower-cased and the path in the site, each segment decoded", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML) });
		for (const path of ["/img/logo-2.png", "/products/", "/%61bout.html?x=1"])
			await serve(hostRequest("Look-Shop.Qorpera.COM", path, { headers: WITH_SESSION }), siteStore);
		assert.deepEqual(
			calls.serveHost.map((call) => call.slice(0, 2)),
			[
				[OWN, "img/logo-2.png"],
				[OWN, "products/"],
				[OWN, "about.html"],
			],
		);
	});

	it("answers 304 to a visitor who holds the file, one byte range, past the end 416, and HEAD", async () => {
		const hash = sha(HTML);
		const held = store(undefined, undefined, { serveHost: hostFile(HTML) });
		const unchanged = await serve(
			hostRequest(OWN, "/", { headers: { ...WITH_SESSION, "if-none-match": `"${hash}"` } }),
			held.store,
		);
		assert.equal(unchanged.status, 304);
		assertHostHeaders(unchanged);
		assert.equal(unchanged.headers.get("etag"), `"${hash}"`);
		assert.equal(await unchanged.text(), "");
		assert.deepEqual(held.calls.serveHost, [[OWN, "", TOKEN, hash, 0, MAX_FILE_BYTES]]);
		const video = hostFile("0123456789", { path: "v.mp4", contentType: "video/mp4" });
		const ranged = store(undefined, undefined, { serveHost: video });
		const part = await serve(
			hostRequest(OWN, "/v.mp4", { headers: { ...WITH_SESSION, range: "bytes=2-5" } }),
			ranged.store,
		);
		assert.equal(part.status, 206);
		assertHostHeaders(part);
		assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
		assert.equal(await part.text(), "2345");
		assert.deepEqual(ranged.calls.serveHost.at(-1)?.slice(4), [2, 4]);
		const suffix = await serve(
			hostRequest(OWN, "/v.mp4", { headers: { ...WITH_SESSION, range: "bytes=-3" } }),
			ranged.store,
		);
		assert.equal(await suffix.text(), "789");
		const past = await serve(
			hostRequest(OWN, "/v.mp4", { headers: { ...WITH_SESSION, range: "bytes=10-12" } }),
			ranged.store,
		);
		assert.equal(past.status, 416);
		assertHostHeaders(past);
		const head = await serve(hostRequest(OWN, "/", { method: "HEAD", headers: WITH_SESSION }), held.store);
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(HTML)));
		assert.equal(await head.text(), "");
		assert.deepEqual(held.calls.serveHost.at(-1)?.slice(4), [0, 0]);
	});

	it("tries each __Host- session cookie the browser sent, at most three, and never the old host's cookie", async () => {
		const answer = (_host: string, _path: string, token: string | null) =>
			token === NEW_TOKEN ? hostFile(HTML) : LOCKED;
		const two = store(undefined, undefined, { serveHost: answer });
		const response = await serve(
			hostRequest(OWN, "/", { headers: { cookie: `${HOST_COOKIE}=${TOKEN}; ${HOST_COOKIE}=${NEW_TOKEN}` } }),
			two.store,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(
			two.calls.serveHost.map((call) => call[2]),
			[TOKEN, NEW_TOKEN],
		);
		const many = store(undefined, undefined, { serveHost: LOCKED });
		const cookie = Array.from({ length: 5 }, (_, n) => `${HOST_COOKIE}=${String(n).repeat(32)}`).join("; ");
		assert.equal((await serve(hostRequest(OWN, "/", { headers: { cookie } }), many.store)).status, 401);
		assert.equal(many.calls.serveHost.length, 3);
		const old = store(undefined, undefined, { serveHost: LOCKED });
		await serve(hostRequest(OWN, "/", { headers: { cookie: `qorpera_site=${TOKEN}; ${HOST_COOKIE}=short` } }), old.store);
		assert.deepEqual(old.calls.serveHost, [[OWN, "", null, null, 0, MAX_FILE_BYTES]]);
	});

	it("shows the same password page for a locked site and for a name with no site, and drops a session cookie either way", async () => {
		for (const headers of [{}, WITH_SESSION, { ...WITH_SESSION, "accept-language": "da" }]) {
			const pages = [];
			for (const answer of [LOCKED, { state: "none" }]) {
				const response = await serve(
					hostRequest(OWN, "/products/", { headers }),
					store(undefined, undefined, { serveHost: answer }).store,
				);
				assert.equal(response.status, 401);
				assert.equal(response.headers.get("www-authenticate"), null);
				assertHostPage(response, "same-origin");
				assert.equal(response.headers.get("set-cookie"), "cookie" in headers ? CLEARED : null);
				pages.push(await snapshot(response));
			}
			assert.deepEqual(pages[1], pages[0]);
		}
		const html = await (
			await serve(hostRequest(OWN, "/products/"), store(undefined, undefined, { serveHost: LOCKED }).store)
		).text();
		assert.match(html, /<h1>Private site<\/h1>/);
		assert.match(html, /<form method="post" action="\/\.qorpera\/unlock">/);
		assert.match(html, /<input type="hidden" name="next" value="products\/">/);
		assert.match(html, /<meta name="referrer" content="same-origin">/);
	});

	it("answers 410 for a site Qorpera took down, with a session or without", async () => {
		for (const headers of [{}, WITH_SESSION]) {
			const { calls, store: siteStore } = store(undefined, undefined, { serveHost: { state: "gone" } });
			const response = await serve(hostRequest(OWN, "/products/a.html", { headers }), siteStore);
			assert.equal(response.status, 410);
			assertHostPage(response);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.match(await response.text(), /<h1>This site is not available\.<\/h1>/);
			assert.equal(calls.serveHost.length, 1);
		}
		const danish = await serve(
			hostRequest(OWN, "/", { headers: { "accept-language": "da" } }),
			store(undefined, undefined, { serveHost: { state: "gone" } }).store,
		);
		assert.match(await danish.text(), /Siden er ikke tilgængelig\./);
		const head = await serve(
			hostRequest(OWN, "/", { method: "HEAD" }),
			store(undefined, undefined, { serveHost: { state: "gone" } }).store,
		);
		assert.equal(head.status, 410);
		assert.equal(await head.text(), "");
	});

	it("redirects a folder to its slash, keeping the query, and says a missing page is not part of the site", async () => {
		const folder = await serve(
			hostRequest(OWN, "/products?p=2", { headers: WITH_SESSION }),
			store(undefined, undefined, {
				serveHost: { state: "directory", path: "products/", scope: "site", public: false },
			}).store,
		);
		assert.equal(folder.status, 308);
		assert.equal(folder.headers.get("location"), "/products/?p=2");
		assertHostPage(folder);
		const missing = await serve(
			hostRequest(OWN, "/gone.html", { headers: WITH_SESSION }),
			store(undefined, undefined, { serveHost: { state: "missing", scope: "site", public: false } }).store,
		);
		assert.equal(missing.status, 404);
		assertHostPage(missing);
		assert.match(await missing.text(), /This page is not part of the site\./);
	});

	it("answers a missing path with the version's own 404.html: status 404, whole, never stored, no ETag", async () => {
		const lost = hostFile(NOT_FOUND_HTML, { status: 404, path: "404.html" });
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: lost });
		const response = await serve(hostRequest(OWN, "/nope.html", { headers: WITH_SESSION }), siteStore);
		assert.equal(response.status, 404);
		assertHostHeaders(response);
		assert.equal(response.headers.get("content-security-policy"), ownContentSecurityPolicy(DEFAULT_WEB_ORIGINS));
		assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
		assert.equal(response.headers.get("etag"), null);
		assert.equal(response.headers.get("accept-ranges"), null);
		assert.equal(await response.text(), NOT_FOUND_HTML);
		// The visitor's ETag never makes it a 304, and a range never a part of it.
		const held = await serve(
			hostRequest(OWN, "/nope.html", { headers: { ...WITH_SESSION, "if-none-match": `"${sha(NOT_FOUND_HTML)}"` } }),
			siteStore,
		);
		assert.equal(held.status, 404);
		assert.equal(await held.text(), NOT_FOUND_HTML);
		calls.serveHost.length = 0;
		const ranged = await serve(
			hostRequest(OWN, "/nope.html", { headers: { ...WITH_SESSION, range: "bytes=0-3" } }),
			siteStore,
		);
		assert.equal(ranged.status, 404);
		assert.equal(ranged.headers.get("content-range"), null);
		assert.equal(await ranged.text(), NOT_FOUND_HTML);
		assert.deepEqual(
			calls.serveHost.map((call) => call.slice(4)),
			[
				[0, 4],
				[0, MAX_FILE_BYTES],
			],
		);
		const head = await serve(hostRequest(OWN, "/nope.html", { method: "HEAD", headers: WITH_SESSION }), siteStore);
		assert.equal(head.status, 404);
		assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(NOT_FOUND_HTML)));
	});

	it("refuses what is no path of a site, the platform's other addresses and other methods, unasked", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML) });
		for (const path of [
			"/.env",
			"/.well-known/security.txt",
			"/a%2Fb.html",
			"/a//b.html",
			"/%2e%2e%2fsecret",
			`/~${TOKEN}/`,
			`/.qorpera/enter?t=${TICKET}`,
			"/.qorpera/other",
			"/.qorpera",
			"/.qorpera/unlock/x",
			`/${"a/".repeat(17)}x`,
		]) {
			const response = await serve(hostRequest(OWN, path, { headers: WITH_SESSION }), siteStore);
			assert.equal(response.status, 404, path);
			assertHostPage(response);
		}
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
			const response = await serve(
				hostRequest(OWN, "/a.html", { method, headers: WITH_SESSION, body: method === "OPTIONS" ? null : "x" }),
				siteStore,
			);
			assert.equal(response.status, 405, method);
			assert.equal(response.headers.get("allow"), "GET, HEAD");
			assertHostPage(response);
		}
		assert.equal(calls.serveHost.length, 0);
	});

	it("answers robots.txt itself on every site host: release 5.1's sites are all private", async () => {
		const { calls, store: siteStore } = store();
		for (const host of [OWN, NEXT]) {
			const robots = await serve(hostRequest(host, "/robots.txt"), siteStore);
			assert.equal(robots.status, 200);
			assertHostPage(robots);
			assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
			assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
			const posted = await serve(hostRequest(host, "/robots.txt", { method: "POST", body: "x" }), siteStore);
			assert.equal(posted.status, 405);
		}
		assert.equal(calls.serveHost.length, 0);
	});

	it("answers 503 when the database fails or answers what it never would, logging no token", async () => {
		const logged = await silenced(async (lines) => {
			for (const answer of [
				new Error(`boom ${TOKEN}`),
				{ state: "file" },
				null,
				{ state: "teapot" },
				// Another scope than the host's, a public answer (none in release 5.1), the old host's states.
				hostFile(HTML, { scope: "next" }),
				hostFile(HTML, { public: true }),
				{ state: "locked" },
				{ ...LOCKED, extra: 1 },
				{ state: "none", scope: "site" },
				{ state: "legacy" },
				{ state: "moved", url: `https://${OWN}/` },
				// A 404 that is not the version's 404.html, another status, bytes that are not the file's.
				hostFile(HTML, { status: 404 }),
				hostFile(HTML, { status: 500 }),
				hostFile(HTML, { sha256: "0".repeat(64) }),
				{ state: "directory", path: "products", scope: "site", public: false },
			]) {
				const response = await serve(
					hostRequest(OWN, "/", { headers: WITH_SESSION }),
					store(undefined, undefined, { serveHost: answer }).store,
				);
				assert.equal(response.status, 503, JSON.stringify(answer instanceof Error ? "error" : answer));
				assert.equal(response.headers.get("retry-after"), "30");
				assertHostPage(response);
			}
			return lines;
		});
		assert.ok(logged.length > 0);
		assert.ok(
			logged.every((line) => !line.includes(TOKEN)),
			logged.join("\n"),
		);
	});
});

describe("site-serve: the own host's password form", () => {
	it("opens a visitor's session: the __Host- cookie for the whole host, Lax, and the page asked for", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, {
			unlockHost: { state: "open", token: NEW_TOKEN, maxAge: 604800 },
		});
		const response = await serve(
			unlockOn(OWN, "password=k7mq-x2pa-9fhd&next=products%2Fitem.html", { "cf-connecting-ip": "203.0.113.9" }),
			siteStore,
		);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/products/item.html");
		assert.equal(
			response.headers.get("set-cookie"),
			`__Host-qorpera_site=${NEW_TOKEN}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`,
		);
		assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /domain/i);
		assertHostPage(response);
		assert.deepEqual(calls.unlockHost, [[OWN, "k7mq-x2pa-9fhd", "203.0.113.9"]]);
		assert.equal(calls.unlock.length, 0);
		assert.equal(calls.serveHost.length, 0);
	});

	it("keeps the redirect inside the site whatever next says", async () => {
		for (const next of ["https://evil.example/", "//evil.example", "../other/", "/abs", "a/../../b", ".qorpera/unlock"]) {
			const response = await serve(
				unlockOn(OWN, `password=pw&next=${encodeURIComponent(next)}`),
				store(undefined, undefined, { unlockHost: { state: "open", token: NEW_TOKEN, maxAge: 604800 } }).store,
			);
			assert.equal(response.headers.get("location"), "/", next);
		}
	});

	it("refuses a form from any other origin, another body type and a body over 4 KiB, unasked", async () => {
		const { calls, store: siteStore } = store();
		for (const origin of [
			"https://sites.qorpera.com",
			"https://other-shop.qorpera.com",
			`https://${NEXT}`,
			"https://app.qorpera.com",
			`http://${OWN}`,
			`https://${OWN}:8443`,
			"https://evil.example",
			"null",
		]) {
			const response = await serve(unlockOn(OWN, "password=pw", { origin }), siteStore);
			assert.equal(response.status, 403, origin);
			assertHostPage(response);
			assert.match(await response.text(), /This form can only be sent from the site&#39;s own password page\./);
		}
		assert.equal(
			(await serve(unlockOn(OWN, '{"password":"pw"}', { "content-type": "application/json" }), siteStore)).status,
			415,
		);
		assert.equal(
			(await serve(unlockOn(OWN, `password=${"x".repeat(MAX_UNLOCK_BODY_BYTES)}`), siteStore)).status,
			413,
		);
		assert.equal(calls.unlockHost.length, 0);
		// No Origin at all (an older browser): allowed.
		const bare = await serve(
			hostRequest(OWN, "/.qorpera/unlock", {
				method: "POST",
				body: "password=pw",
				headers: { "content-type": "application/x-www-form-urlencoded" },
			}),
			siteStore,
		);
		assert.equal(bare.status, 401);
		assert.equal(calls.unlockHost.length, 1);
	});

	it("answers a wrong password, too many tries and an empty one with the form again", async () => {
		const wrong = await serve(unlockOn(OWN, "password=nope&next=a.html"), store().store);
		assert.equal(wrong.status, 401);
		assertHostPage(wrong, "same-origin");
		const html = await wrong.text();
		assert.match(html, /That password is not right\. Try again\./);
		assert.match(html, /action="\/\.qorpera\/unlock"/);
		assert.match(html, /name="next" value="a\.html"/);
		assert.equal(wrong.headers.get("set-cookie"), null);
		const limited = await serve(
			unlockOn(OWN, "password=nope", { "accept-language": "da" }),
			store(undefined, undefined, { unlockHost: { state: "limited", retryAfter: 125 } }).store,
		);
		assert.equal(limited.status, 429);
		assertHostPage(limited, "same-origin");
		assert.equal(limited.headers.get("retry-after"), "125");
		assert.match(await limited.text(), /Prøv igen om 3 minutter\./);
		const { calls, store: siteStore } = store();
		assert.equal((await serve(unlockOn(OWN, "password=&next="), siteStore)).status, 401);
		assert.equal((await serve(unlockOn(OWN, `password=${"x".repeat(1025)}`), siteStore)).status, 401);
		assert.equal(calls.unlockHost.length, 0);
	});

	it("sends GET of the form's address to the top, and refuses other methods", async () => {
		const response = await serve(hostRequest(OWN, "/.qorpera/unlock"));
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/");
		assertHostPage(response);
		const put = await serve(hostRequest(OWN, "/.qorpera/unlock", { method: "PUT", body: "x" }));
		assert.equal(put.status, 405);
		assert.equal(put.headers.get("allow"), "POST");
	});

	it("never asks the database for a next host's password: it is no way in there", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, {
			unlockHost: { state: "open", token: NEW_TOKEN, maxAge: 604800 },
		});
		const response = await serve(unlockOn(NEXT, "password=pw"), siteStore);
		assert.equal(response.status, 401);
		assertHostPage(response);
		assert.equal(response.headers.get("set-cookie"), null);
		assert.match(await response.text(), /<h1>Not live yet<\/h1>/);
		assert.equal(calls.unlockHost.length + calls.unlock.length + calls.serveHost.length, 0);
	});

	it("answers 503 when the database fails or answers oddly, setting no cookie and logging no password", async () => {
		const logged = await silenced(async (lines) => {
			for (const answer of [
				new Error("down k7mq-x2pa-9fhd"),
				{ state: "open", token: "short", maxAge: 604800 },
				{ state: "open", token: NEW_TOKEN, maxAge: 0 },
				{ state: "limited" },
				{ state: "refused" },
			]) {
				const response = await serve(
					unlockOn(OWN, "password=k7mq-x2pa-9fhd"),
					store(undefined, undefined, { unlockHost: answer }).store,
				);
				assert.equal(response.status, 503);
				assertHostPage(response);
				assert.equal(response.headers.get("set-cookie"), null);
			}
			return lines;
		});
		assert.ok(logged.every((line) => !line.includes("k7mq-x2pa-9fhd")));
	});
});

describe("site-serve: Look first on the next host", () => {
	it("trades a ticket for a member's session: the __Host- cookie for 12 hours, then the top", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, {
			enter: { state: "open", token: NEW_TOKEN, maxAge: 43200 },
		});
		// The tab What's new opens: a navigation from the app, which is the same site.
		const response = await serve(
			hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, {
				headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
			}),
			siteStore,
		);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/");
		assert.equal(
			response.headers.get("set-cookie"),
			`__Host-qorpera_site=${NEW_TOKEN}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`,
		);
		assertHostPage(response);
		assert.deepEqual(calls.enter, [[NEXT, TICKET]]);
	});

	it("refuses a ticket used before or too old, with no cookie", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { enter: { state: "refused" } });
		for (const lang of ["en", "da"]) {
			const response = await serve(
				hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, { headers: { "accept-language": lang } }),
				siteStore,
			);
			assert.equal(response.status, 403);
			assertHostPage(response);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.match(
				await response.text(),
				lang === "en"
					? /This link has been used or is too old\. Open it again from What&#39;s new\./
					: /Linket er brugt eller for gammelt\. Åbn det igen fra Nyheder\./,
			);
		}
		assert.equal(calls.enter.length, 2);
	});

	it("never asks the database for a ticket of the wrong shape, from another origin, or by another method", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, {
			enter: { state: "open", token: NEW_TOKEN, maxAge: 43200 },
		});
		for (const query of [
			"",
			"?t=",
			`?t=${TICKET.slice(1)}`,
			`?t=${TICKET}A`,
			`?t=${TICKET.slice(1)}=`,
			`?t=${TICKET.slice(1)}%2B`,
			`?t=${TICKET}&t=${TICKET}`,
			`?T=${TICKET}`,
		]) {
			const response = await serve(hostRequest(NEXT, `/.qorpera/enter${query}`), siteStore);
			assert.equal(response.status, 403, query);
			assert.equal(response.headers.get("set-cookie"), null);
		}
		for (const origin of ["https://app.qorpera.com", `https://${OWN}`, "https://evil.example", "null"]) {
			const response = await serve(hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, { headers: { origin } }), siteStore);
			assert.equal(response.status, 403, origin);
		}
		for (const method of ["HEAD", "POST", "PUT"]) {
			const response = await serve(
				hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, { method, body: method === "HEAD" ? null : "x" }),
				siteStore,
			);
			assert.equal(response.status, 405, method);
			assert.equal(response.headers.get("allow"), "GET");
		}
		assert.equal(calls.enter.length, 0);
		// Its own origin passes.
		const own = await serve(
			hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, { headers: { origin: `https://${NEXT}` } }),
			siteStore,
		);
		assert.equal(own.status, 303);
		assert.equal(calls.enter.length, 1);
	});

	it("answers 503 when the database fails or answers oddly, logging no ticket", async () => {
		const logged = await silenced(async (lines) => {
			for (const answer of [
				new Error(`down ${TICKET}`),
				{ state: "open", token: "short", maxAge: 43200 },
				{ state: "refused", why: "used" },
				{ state: "wrong" },
			]) {
				const response = await serve(
					hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`),
					store(undefined, undefined, { enter: answer }).store,
				);
				assert.equal(response.status, 503);
				assert.equal(response.headers.get("set-cookie"), null);
			}
			return lines;
		});
		assert.ok(logged.length > 0);
		assert.ok(logged.every((line) => !line.includes(TICKET)));
	});

	it("serves the session's version's HTML whole with the bar appended: never stored, no ETag", async () => {
		const next = hostFile(HTML, { scope: "next" });
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: next });
		const response = await serve(
			hostRequest(NEXT, "/", { headers: { ...WITH_SESSION, "if-none-match": `"${sha(HTML)}"` } }),
			siteStore,
		);
		assert.equal(response.status, 200);
		assertHostHeaders(response);
		assert.equal(response.headers.get("content-security-policy"), HOST_CONTENT_SECURITY_POLICY);
		assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
		assert.equal(response.headers.get("etag"), null);
		assert.equal(response.headers.get("accept-ranges"), null);
		const body = await response.text();
		const bar = nextBar("en");
		assert.equal(body, HTML + bar);
		assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(HTML + bar)));
		assert.match(bar, /^\n<div lang="en" role="status" style="[^"]*">Not live yet &middot; only your team sees this<\/div>\n$/);
		for (const lang of ["en", "da"] as const) assert.ok([...nextBar(lang)].every((c) => c.charCodeAt(0) < 128), lang);
		// The visitor's ETag is never passed on: the next host's answers are always whole.
		assert.deepEqual(calls.serveHost, [[NEXT, "", TOKEN, null, 0, MAX_FILE_BYTES]]);
		const danish = await serve(hostRequest(NEXT, "/", { headers: { ...WITH_SESSION, "accept-language": "da" } }), siteStore);
		assert.ok((await danish.text()).endsWith("Ikke live endnu &middot; kun jeres team ser dette</div>\n"));
	});

	it("never serves a next host's HTML in parts, and counts the bar in HEAD's length", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML, { scope: "next" }) });
		const ranged = await serve(
			hostRequest(NEXT, "/", { headers: { ...WITH_SESSION, range: "bytes=2-5", "if-range": `"${sha(HTML)}"` } }),
			siteStore,
		);
		assert.equal(ranged.status, 200);
		assert.equal(ranged.headers.get("content-range"), null);
		assert.equal(await ranged.text(), HTML + nextBar("en"));
		assert.deepEqual(
			calls.serveHost.map((call) => call.slice(4)),
			[
				[2, 4],
				[0, MAX_FILE_BYTES],
			],
		);
		const head = await serve(hostRequest(NEXT, "/", { method: "HEAD", headers: WITH_SESSION }), siteStore);
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(HTML + nextBar("en"))));
		assert.equal(await head.text(), "");
	});

	it("serves other files of the next host as they are, in parts too, never stored and with no ETag", async () => {
		const video = hostFile("0123456789", { path: "v.mp4", contentType: "video/mp4", scope: "next" });
		const siteStore = store(undefined, undefined, { serveHost: video }).store;
		const part = await serve(hostRequest(NEXT, "/v.mp4", { headers: { ...WITH_SESSION, range: "bytes=2-5" } }), siteStore);
		assert.equal(part.status, 206);
		assertHostHeaders(part);
		assert.equal(part.headers.get("cache-control"), "no-store, no-transform");
		assert.equal(part.headers.get("etag"), null);
		assert.equal(await part.text(), "2345");
		const whole = await serve(hostRequest(NEXT, "/v.mp4", { headers: WITH_SESSION }), siteStore);
		assert.equal(await whole.text(), "0123456789");
	});

	it("answers its version's 404.html with the bar, status 404", async () => {
		const lost = hostFile(NOT_FOUND_HTML, { status: 404, path: "404.html", scope: "next" });
		const response = await serve(
			hostRequest(NEXT, "/nope.html", { headers: WITH_SESSION }),
			store(undefined, undefined, { serveHost: lost }).store,
		);
		assert.equal(response.status, 404);
		assertHostHeaders(response);
		assert.equal(await response.text(), NOT_FOUND_HTML + nextBar("en"));
	});

	it("shows the same Not live yet page without a session and for a name with no site, and 410 when taken down", async () => {
		const pages = [];
		for (const answer of [NEXT_LOCKED, { state: "none" }]) {
			const response = await serve(
				hostRequest(NEXT, "/", { headers: WITH_SESSION }),
				store(undefined, undefined, { serveHost: answer }).store,
			);
			assert.equal(response.status, 401);
			assertHostPage(response);
			assert.equal(response.headers.get("set-cookie"), CLEARED);
			pages.push(await snapshot(response));
		}
		assert.deepEqual(pages[1], pages[0]);
		const html = Buffer.from(pages[0]?.body ?? "", "base64").toString();
		assert.match(html, /<h1>Not live yet<\/h1><p>This address shows a project&#39;s next version to its team\./);
		assert.doesNotMatch(html, /<form/);
		const gone = await serve(
			hostRequest(NEXT, "/", { headers: WITH_SESSION }),
			store(undefined, undefined, { serveHost: { state: "gone" } }).store,
		);
		assert.equal(gone.status, 410);
		assertHostPage(gone);
		// An own host's locked answer on a next host is no answer for it.
		const wrongScope = await silenced(() =>
			serve(hostRequest(NEXT, "/", { headers: WITH_SESSION }), store(undefined, undefined, { serveHost: LOCKED }).store),
		);
		assert.equal(wrongScope.status, 503);
	});
});

describe("site-serve: every site host refuses other origins", () => {
	it("reads Fetch Metadata: the site's own pages, a typed address and a top-level navigation pass", () => {
		const passes = (headers: Record<string, string>) => fetchAllowed(new Headers(headers));
		assert.equal(passes({}), true);
		assert.equal(passes({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }), true);
		assert.equal(passes({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }), true);
		assert.equal(passes({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }), true);
		// What the browser itself starts (an address typed, a bookmark, a download) is no other origin's.
		assert.equal(passes({ "sec-fetch-site": "none", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" }), true);
		for (const site of ["cross-site", "same-site"])
			assert.equal(passes({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }), true);
		for (const headers of [
			{ "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
			{ "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style" },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "frame" },
			{ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
			{ "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" },
			{ "sec-fetch-site": "same-site", "sec-fetch-dest": "document" },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "nested-navigate", "sec-fetch-dest": "iframe" },
			{ "sec-fetch-site": "same-site", "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" },
			{ "sec-fetch-site": "Same-Origin" },
			{ "sec-fetch-site": "" },
			{ "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "iframe" },
		] as Record<string, string>[]) {
			assert.equal(passes(headers), false, JSON.stringify(headers));
			// The own host (framed) refuses each of these too.
			assert.equal(fetchAllowed(new Headers(headers), true), false, JSON.stringify(headers));
		}
		// A frame's navigation passes only where framed (an own host, V1): frame-ancestors decides there.
		for (const site of ["same-site", "cross-site"]) {
			const framed = { "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
			assert.equal(passes(framed), false, site);
			assert.equal(fetchAllowed(new Headers(framed), true), true, site);
		}
	});

	it("refuses a sibling's subresource or fetch on both hosts, and a frame on the next host, with 403 before any database call", async () => {
		const sibling = { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" };
		const framed = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
		const { calls, store: siteStore } = store(undefined, undefined, {
			serveHost: hostFile(HTML),
			unlockHost: { state: "open", token: NEW_TOKEN, maxAge: 604800 },
			enter: { state: "open", token: NEW_TOKEN, maxAge: 43200 },
			memberPass: { state: "open", token: NEW_TOKEN, maxAge: 43200 },
		});
		for (const make of [
			() => hostRequest(OWN, "/app.js", { headers: { ...WITH_SESSION, ...sibling } }),
			() => hostRequest(NEXT, "/app.js", { headers: { ...WITH_SESSION, ...sibling } }),
			() => hostRequest(OWN, "/robots.txt", { headers: sibling }),
			() => unlockOn(OWN, "password=pw", sibling),
			() => hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, { headers: sibling }),
			() => memberOn(OWN, `pass=${MEMBER_PASS}`, sibling),
			// A frame of the next host's (only its own pages frame it).
			() => hostRequest(NEXT, "/app.js", { headers: { ...WITH_SESSION, ...framed } }),
			() => hostRequest(NEXT, "/robots.txt", { headers: framed }),
			() => hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`, { headers: framed }),
		]) {
			const response = await serve(make(), siteStore);
			assert.equal(response.status, 403);
			assertHostPage(response);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.match(await response.text(), /This page can only be opened at its own address\./);
		}
		assert.equal(calls.serveHost.length + calls.unlockHost.length + calls.enter.length + calls.memberPass.length, 0);
		// The site's own loads pass: its document, its script, a typed address.
		for (const headers of [
			{ "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
			{ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
		])
			assert.equal((await serve(hostRequest(OWN, "/app.js", { headers: { ...WITH_SESSION, ...headers } }), siteStore)).status, 200);
	});

	it("refuses a service worker's script with 404 on both hosts, unasked", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile("self.onfetch = () => {};") });
		for (const host of [OWN, NEXT]) {
			for (const headers of [
				{ "service-worker": "script", "sec-fetch-site": "same-origin", "sec-fetch-dest": "serviceworker" },
				{ "service-worker": "script" },
				{ "sec-fetch-site": "same-origin", "sec-fetch-mode": "same-origin", "sec-fetch-dest": "serviceworker" },
			] as Record<string, string>[]) {
				const response = await serve(hostRequest(host, "/sw.js", { headers: { ...WITH_SESSION, ...headers } }), siteStore);
				assert.equal(response.status, 404);
				assertHostPage(response);
			}
		}
		assert.equal(calls.serveHost.length, 0);
	});

	it("puts every header of the pre-check's list on every answer of both hosts, whatever its status", async () => {
		const open = { state: "open", token: NEW_TOKEN, maxAge: 604800 };
		const video = hostFile("0123456789", { path: "v.mp4", contentType: "video/mp4" });
		const cases: [string, () => Request, HostAnswers][] = [
			["200 own", () => hostRequest(OWN, "/", { headers: WITH_SESSION }), { serveHost: hostFile(HTML) }],
			["200 next", () => hostRequest(NEXT, "/", { headers: WITH_SESSION }), { serveHost: hostFile(HTML, { scope: "next" }) }],
			["200 robots", () => hostRequest(OWN, "/robots.txt"), {}],
			["206", () => hostRequest(OWN, "/v.mp4", { headers: { ...WITH_SESSION, range: "bytes=0-1" } }), { serveHost: video }],
			[
				"304",
				() => hostRequest(OWN, "/", { headers: { ...WITH_SESSION, "if-none-match": `"${sha(HTML)}"` } }),
				{ serveHost: hostFile(HTML) },
			],
			["303 unlock", () => unlockOn(OWN, "password=pw"), { unlockHost: open }],
			["303 enter", () => hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`), { enter: { ...open, maxAge: 43200 } }],
			["303 unlock GET", () => hostRequest(OWN, "/.qorpera/unlock"), {}],
			[
				"308",
				() => hostRequest(OWN, "/products", { headers: WITH_SESSION }),
				{ serveHost: { state: "directory", path: "products/", scope: "site", public: false } },
			],
			[
				"400",
				() =>
					hostRequest(OWN, "/.qorpera/unlock", {
						method: "POST",
						// Not UTF-8.
						body: new Uint8Array([0x70, 0x3d, 0xff]),
						headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${OWN}` },
					}),
				{},
			],
			["401 own", () => hostRequest(OWN, "/", { headers: WITH_SESSION }), { serveHost: LOCKED }],
			["401 next", () => hostRequest(NEXT, "/"), { serveHost: NEXT_LOCKED }],
			["401 none", () => hostRequest(OWN, "/"), { serveHost: { state: "none" } }],
			["403 origin", () => unlockOn(OWN, "password=pw", { origin: "https://evil.example" }), {}],
			["403 ticket", () => hostRequest(NEXT, "/.qorpera/enter?t=x"), {}],
			["403 metadata", () => hostRequest(OWN, "/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" } }), {}],
			["404 path", () => hostRequest(OWN, "/.env"), {}],
			["404 worker", () => hostRequest(NEXT, "/sw.js", { headers: { "service-worker": "script" } }), {}],
			[
				"404 file",
				() => hostRequest(OWN, "/x", { headers: WITH_SESSION }),
				{ serveHost: hostFile(NOT_FOUND_HTML, { status: 404, path: "404.html" }) },
			],
			[
				"404 missing",
				() => hostRequest(OWN, "/x", { headers: WITH_SESSION }),
				{ serveHost: { state: "missing", scope: "site", public: false } },
			],
			["405", () => hostRequest(OWN, "/x", { method: "DELETE" }), {}],
			["410", () => hostRequest(NEXT, "/"), { serveHost: { state: "gone" } }],
			["413", () => unlockOn(OWN, `password=${"x".repeat(MAX_UNLOCK_BODY_BYTES)}`), {}],
			["415", () => unlockOn(OWN, "{}", { "content-type": "application/json" }), {}],
			["416", () => hostRequest(OWN, "/v.mp4", { headers: { ...WITH_SESSION, range: "bytes=10-" } }), { serveHost: video }],
			["429", () => unlockOn(OWN, "password=pw"), { unlockHost: { state: "limited", retryAfter: 60 } }],
			["503", () => hostRequest(OWN, "/", { headers: WITH_SESSION }), { serveHost: new Error("down") }],
			// The member's door (V1).
			["303 member", () => memberOn(OWN, `pass=${MEMBER_PASS}`), { memberPass: { ...open, maxAge: 43200 } }],
			["401 member", () => memberOn(OWN, `pass=${MEMBER_PASS}`), {}],
			["403 member", () => memberOn(OWN, `pass=${MEMBER_PASS}`, { origin: `https://${OWN}` }), {}],
			["404 member next", () => memberOn(NEXT, `pass=${MEMBER_PASS}`, { "sec-fetch-dest": "document" }), {}],
			["405 member", () => hostRequest(OWN, MEMBER_PATH), {}],
			[
				"200 framed",
				() =>
					hostRequest(OWN, "/", {
						headers: { ...WITH_SESSION, "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
					}),
				{ serveHost: hostFile(HTML) },
			],
		];
		const statuses = new Set<number>();
		await silenced(async () => {
			for (const [what, make, answers] of cases) {
				const response = await serve(make(), store(undefined, undefined, answers).store);
				assertHostHeaders(response, what);
				statuses.add(response.status);
			}
		});
		assert.deepEqual(
			[...statuses].sort((a, b) => a - b),
			[200, 206, 303, 304, 308, 400, 401, 403, 404, 405, 410, 413, 415, 416, 429, 503],
		);
	});
});

// --- Seen inside Qorpera: a member's pass and the web's frame (company views step 4, V1; 20260930774000) -------------

/** Migration 20260930774000's text: the redeem call site-serve makes must be there, as written. */
const PASS_MIGRATION = readFileSync(
	new URL("../../migrations/20260930774000_site_member_pass.sql", import.meta.url),
	"utf8",
);
const MEMBER_OPEN = { state: "open", token: NEW_TOKEN, maxAge: 43200 };

describe("site-serve: a member's pass on the own host (V1)", () => {
	it("reads the web's origins: exact https origins only, the production app when none", () => {
		assert.deepEqual(DEFAULT_WEB_ORIGINS, ["https://app.qorpera.com"]);
		assert.equal(webOrigins(undefined), DEFAULT_WEB_ORIGINS);
		for (const value of ["", "not json", "{}", '"https://app.qorpera.com"', "[]", "[42]", "null"])
			assert.equal(webOrigins(value), DEFAULT_WEB_ORIGINS, value);
		assert.deepEqual(webOrigins('["https://app.qorpera.com","https://staging.example.test"]'), [
			"https://app.qorpera.com",
			"https://staging.example.test",
		]);
		// Anything but an exact https origin is left out.
		assert.deepEqual(
			webOrigins(
				JSON.stringify([
					"http://localhost:5173",
					"https://app.qorpera.com/",
					"https://app.qorpera.com/x",
					"https://u:p@app.example.test",
					"https://app.example.test?x",
					"https://APP.example.test",
					"https://*.qorpera.com",
					"https://a.example.test https://evil.example",
					"https://a.example.test;",
					"https://a.example.test 'unsafe-inline'",
					"https://app.qorpera.com",
					"https://xn--bcher-kva.example",
					"https://app.example.test:443",
					"https://app.example.test:99999",
					"https://app.qorpera.com",
					"https://app.example.test:8443",
					7,
				]),
			),
			["https://app.qorpera.com", "https://xn--bcher-kva.example", "https://app.example.test:8443"],
		);
		assert.equal(webOrigins('["http://localhost:5173"]'), DEFAULT_WEB_ORIGINS);
		const many = Array.from({ length: 10 }, (_, index) => `https://web${index}.example.test`);
		assert.deepEqual(webOrigins(JSON.stringify(many)), many.slice(0, 8));
	});

	it("takes the web's form into its frame: one redeem, the session's cookie, 303 to the top, framable by the web", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { memberPass: MEMBER_OPEN });
		const response = await serve(memberOn("Look-Shop.Qorpera.COM", `pass=${MEMBER_PASS}`), siteStore);
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), "/");
		assert.equal(
			response.headers.get("set-cookie"),
			`${HOST_COOKIE}=${NEW_TOKEN}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`,
		);
		assertHostPage(response);
		assert.equal(response.headers.get("x-frame-options"), null);
		assert.deepEqual(calls.memberPass, [[OWN, MEMBER_PASS]]);
		assert.equal(calls.unlockHost.length + calls.serveHost.length + calls.countView.length, 0);
		// A top-level form (a new tab) is taken too.
		const top = await serve(
			memberOn(OWN, `pass=${MEMBER_PASS}`, { "sec-fetch-dest": "document" }),
			store(undefined, undefined, { memberPass: MEMBER_OPEN }).store,
		);
		assert.equal(top.status, 303);
	});

	it("answers 303 to the path the form names on this host only, else the top", async () => {
		const cases: [string, string][] = [
			["about/", "/about/"],
			["/about/", "/about/"],
			["shop/item.html", "/shop/item.html"],
			["", "/"],
			["/", "/"],
			["//evil.example/", "/"],
			["///evil.example", "/"],
			["https://evil.example/", "/"],
			["/\\evil.example", "/"],
			["../secret", "/"],
			["a/../b", "/"],
			["about?x=1", "/"],
			["about#x", "/"],
			[".env", "/"],
			["%2F%2Fevil.example", "/"],
		];
		for (const [path, location] of cases) {
			const response = await serve(
				memberOn(OWN, `pass=${MEMBER_PASS}&path=${encodeURIComponent(path)}`),
				store(undefined, undefined, { memberPass: MEMBER_OPEN }).store,
			);
			assert.equal(response.status, 303, path);
			assert.equal(response.headers.get("location"), location, path);
		}
	});

	it("refuses every Origin but exactly one of the web's, 403 before any database call", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { memberPass: MEMBER_OPEN });
		for (const origin of [
			null,
			"null",
			`https://${OWN}`,
			`https://${NEXT}`,
			"https://other-shop.qorpera.com",
			"https://evil.example",
			"https://app.qorpera.com.evil.example",
			"https://app.qorpera.com/",
			"https://APP.qorpera.com",
			"http://app.qorpera.com",
			"https://app.qorpera.com:8443",
			"",
		]) {
			const request = memberOn(OWN, `pass=${MEMBER_PASS}`);
			const headers = new Headers(request.headers);
			if (origin === null) headers.delete("origin");
			else headers.set("origin", origin);
			const response = await serve(
				hostRequest(OWN, MEMBER_PATH, { method: "POST", body: `pass=${MEMBER_PASS}`, headers: Object.fromEntries(headers) }),
				siteStore,
			);
			assert.equal(response.status, 403, String(origin));
			assertHostPage(response);
			assert.equal(response.headers.get("set-cookie"), null);
			assert.match(await response.text(), /This page can only be opened from Qorpera\./);
		}
		assert.equal(calls.memberPass.length, 0);
		// The deployment's own list decides: another web origin passes, the default one no longer does.
		const staging = ["https://staging.example.test"];
		const passed = await serve(
			memberOn(OWN, `pass=${MEMBER_PASS}`, { origin: "https://staging.example.test" }),
			siteStore,
			staging,
		);
		assert.equal(passed.status, 303);
		assertHostPage(passed, "no-referrer", staging);
		assert.equal((await serve(memberOn(OWN, `pass=${MEMBER_PASS}`), siteStore, staging)).status, 403);
		assert.equal(calls.memberPass.length, 1);
	});

	it("answers a pass that fails exactly as a wrong password, and asks the database only for one of the right shape", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { memberPass: { state: "refused" } });
		const wrongPassword = await snapshot(
			await serve(
				unlockOn(OWN, "password=pw&next=about%2F"),
				store(undefined, undefined, { unlockHost: { state: "wrong" } }).store,
			),
		);
		assert.equal(wrongPassword.status, 401);
		const refused = await serve(memberOn(OWN, `pass=${MEMBER_PASS}&path=about%2F`), siteStore);
		assert.deepEqual(await snapshot(refused), wrongPassword);
		assert.deepEqual(calls.memberPass, [[OWN, MEMBER_PASS]]);
		for (const body of [
			"",
			"pass=",
			`pass=${MEMBER_PASS.slice(1)}`,
			`pass=${MEMBER_PASS}A`,
			`pass=${MEMBER_PASS.slice(1)}=`,
			`pass=${MEMBER_PASS.slice(1)}.`,
			`pass=${MEMBER_PASS}&pass=${MEMBER_PASS}`,
			`password=${MEMBER_PASS}`,
		]) {
			const response = await serve(memberOn(OWN, `${body}&path=about%2F`), siteStore);
			assert.deepEqual(await snapshot(response), wrongPassword, body);
		}
		assert.equal(calls.memberPass.length, 1);
	});

	it("answers 415, 413 and 400 for a body that is no small form, 503 when the database fails, today's 404 before the migration", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { memberPass: MEMBER_OPEN });
		const json = await serve(memberOn(OWN, "{}", { "content-type": "application/json" }), siteStore);
		assert.equal(json.status, 415);
		assertHostPage(json);
		const big = await serve(memberOn(OWN, `pass=${MEMBER_PASS}&x=${"y".repeat(MAX_UNLOCK_BODY_BYTES)}`), siteStore);
		assert.equal(big.status, 413);
		const notUtf8 = await serve(
			hostRequest(OWN, MEMBER_PATH, {
				method: "POST",
				body: new Uint8Array([0x70, 0x3d, 0xff]),
				headers: { "content-type": "application/x-www-form-urlencoded", origin: WEB },
			}),
			siteStore,
		);
		assert.equal(notUtf8.status, 400);
		assert.equal(calls.memberPass.length, 0);
		await silenced(async (logged) => {
			const down = await serve(
				memberOn(OWN, `pass=${MEMBER_PASS}`),
				store(undefined, undefined, { memberPass: new Error("down") }).store,
			);
			assert.equal(down.status, 503);
			assertHostPage(down);
			assert.equal(down.headers.get("set-cookie"), null);
			assert.ok(logged.every((line) => !line.includes(MEMBER_PASS)));
			const invalid = await serve(
				memberOn(OWN, `pass=${MEMBER_PASS}`),
				store(undefined, undefined, { memberPass: { state: "open", token: "short", maxAge: 43200 } }).store,
			);
			assert.equal(invalid.status, 503);
		});
		const before = await serve(
			memberOn(OWN, `pass=${MEMBER_PASS}`),
			store(undefined, undefined, { memberPass: new MissingFunction("qorpera_site_member_pass_redeem") }).store,
		);
		assert.equal(before.status, 404);
	});

	it("answers 405 (Allow: POST) for every other method on the member's door, and never serves it from the site's files", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML), memberPass: MEMBER_OPEN });
		for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
			const response = await serve(hostRequest(OWN, MEMBER_PATH, { method, headers: WITH_SESSION }), siteStore);
			assert.equal(response.status, 405, method);
			assert.equal(response.headers.get("allow"), "POST", method);
			assertHostPage(response);
		}
		// The same path written another way is the same door.
		assert.equal((await serve(hostRequest(OWN, "/%5F_qorpera/member", { headers: WITH_SESSION }), siteStore)).status, 405);
		// The platform's folder holds nothing of a site's, on either host; the next host has no member's door.
		for (const [host, path, method] of [
			[OWN, "/__qorpera", "GET"],
			[OWN, "/__qorpera/", "GET"],
			[OWN, "/__qorpera/member/", "GET"],
			[OWN, "/__qorpera/index.html", "GET"],
			[OWN, "/__qorpera/member/index.html", "GET"],
			[NEXT, "/__qorpera/index.html", "GET"],
			[NEXT, MEMBER_PATH, "GET"],
		]) {
			const response = await serve(hostRequest(host ?? "", path ?? "", { method, headers: WITH_SESSION }), siteStore);
			assert.equal(response.status, 404, `${host}${path}`);
			assertHostPage(response);
		}
		const next = await serve(memberOn(NEXT, `pass=${MEMBER_PASS}`, { "sec-fetch-dest": "document" }), siteStore);
		assert.equal(next.status, 404);
		assert.equal(calls.serveHost.length + calls.memberPass.length, 0);
		// A site's own file whose name only looks like it is the site's.
		const near = await serve(hostRequest(OWN, "/__qorpera-member/index.html", { headers: WITH_SESSION }), siteStore);
		assert.equal(near.status, 200);
		assert.equal(calls.serveHost.length, 1);
	});

	it("lets the web frame every own-host answer and nothing else frame a next host's", async () => {
		const origins = ["https://a.example.test", "https://b.example.test"];
		assert.equal(ownContentSecurityPolicy(origins), "frame-ancestors 'self' https://a.example.test https://b.example.test");
		assert.equal(
			ownPageSecurityPolicy(origins),
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self' https://a.example.test https://b.example.test; base-uri 'none'",
		);
		const framed = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
		const own = await serve(
			hostRequest(OWN, "/", { headers: { ...WITH_SESSION, ...framed } }),
			store(undefined, undefined, { serveHost: hostFile(HTML) }).store,
			origins,
		);
		assert.equal(own.status, 200);
		assert.equal(own.headers.get("content-security-policy"), ownContentSecurityPolicy(origins));
		assert.equal(own.headers.get("x-frame-options"), null);
		assertHostHeaders(own, "own", origins);
		// The platform's own pages too: the password page a frame shows.
		const page = await serve(
			hostRequest(OWN, "/", { headers: WITH_SESSION }),
			store(undefined, undefined, { serveHost: LOCKED }).store,
			origins,
		);
		assert.equal(page.status, 401);
		assert.equal(page.headers.get("content-security-policy"), ownPageSecurityPolicy(origins));
		assert.equal(page.headers.get("x-frame-options"), null);
		for (const response of [
			await serve(hostRequest(NEXT, "/", { headers: WITH_SESSION }), store(undefined, undefined, {
				serveHost: hostFile(HTML, { scope: "next" }),
			}).store, origins),
			await serve(hostRequest(NEXT, "/"), store(undefined, undefined, { serveHost: NEXT_LOCKED }).store, origins),
		]) {
			assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
			assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'(?:;|$)/);
			assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /example\.test/);
		}
		// The old host keeps its own pages' headers.
		const old = await serve(request("/shop/"), store().store, origins);
		assert.equal(old.headers.get("x-frame-options"), "DENY");
		assert.equal(old.headers.get("content-security-policy"), PAGE_SECURITY_POLICY);
	});

	it("never counts a frame's page, whoever's session it is", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML) });
		const framed = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
		const response = await serveWith(hostRequest(OWN, "/", { headers: { ...WITH_SESSION, ...framed } }), siteStore);
		assert.equal(response.status, 200);
		assert.equal(calls.countView.length, 0);
	});

	it("calls qorpera_site_member_pass_redeem as migration 20260930774000 defines it, granted to the service role only", async () => {
		const made: [string, Json][] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			made.push([String(url).split("/rest/v1/rpc/")[1] ?? "", JSON.parse(String(init?.body)) as Json]);
			return new Response(JSON.stringify({ state: "refused" }), { status: 200 });
		}) as typeof fetch;
		const db = new PostgrestSiteStore("https://project.example.test", "sb_secret_fixture", fetcher);
		assert.deepEqual(await db.memberPass(OWN, MEMBER_PASS), { state: "refused" });
		assert.deepEqual(made, [["qorpera_site_member_pass_redeem", { p_host: OWN, p_pass: MEMBER_PASS }]]);
		assert.match(
			PASS_MIGRATION,
			/create function public\.qorpera_site_member_pass_redeem\(p_host text, p_pass text\)\nreturns jsonb /,
		);
		assert.match(
			PASS_MIGRATION,
			/grant execute on function public\.qorpera_site_member_pass_redeem\(text, text\) to service_role;/,
		);
		assert.doesNotMatch(PASS_MIGRATION, /grant execute on function public\.qorpera_site_member_pass_redeem[^;]*(anon|authenticated)/);
		// Its answers are the ticket's: open with a token for 12 hours, or refused.
		const start = PASS_MIGRATION.indexOf("create function public.qorpera_site_member_pass_redeem(");
		const redeem = PASS_MIGRATION.slice(start, PASS_MIGRATION.indexOf("\nend $$;", start));
		assert.deepEqual(
			[...new Set([...redeem.matchAll(/'\{"state":"([a-z]+)"\}'::jsonb/g)].map((match) => match[1]))],
			["refused"],
		);
		assert.match(redeem, /return jsonb_build_object\('state', 'open', 'token', v_token, 'maxAge', 43200\);/);
		assert.equal(parseEnterAnswer(MEMBER_OPEN).state, "open");
		assert.equal(parseEnterAnswer({ state: "refused" }).state, "refused");
		// The pass's shape is the ticket's, and the action the member's call names is this door.
		assert.match(redeem, /p_pass !~ '\^\[A-Za-z0-9_-\]\{43\}\$'/);
		assert.match(PASS_MIGRATION, /'action', 'https:\/\/' \|\| v_host \|\| '\/__qorpera\/member'/);
		assert.equal(MEMBER_PATH, "/__qorpera/member");
	});
});

describe("site-serve: the old host while sites have hosts of their own", () => {
	const MOVED = { state: "moved", url: `https://${OWN}/` };

	it("moves an old link to the own host by 308, never stored: the rest of the path without ~token, and the query", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: MOVED });
		const cases: [string, string][] = [
			[`/look-shop/~${TOKEN}/a/b.html?q=1`, `https://${OWN}/a/b.html?q=1`],
			["/look-shop", `https://${OWN}/`],
			["/look-shop?ref=mail", `https://${OWN}/?ref=mail`],
			["/look-shop/", `https://${OWN}/`],
			["/look-shop/products/", `https://${OWN}/products/`],
			["/look-shop/%61bout.html", `https://${OWN}/about.html`],
			[`/look-shop/~${TOKEN}`, `https://${OWN}/`],
			// What is no site path goes to the top.
			["/look-shop/a%2Fb.html", `https://${OWN}/`],
			["/look-shop/.git/config", `https://${OWN}/`],
		];
		for (const [path, location] of cases) {
			for (const method of ["GET", "HEAD"]) {
				const response = await serve(
					request(path, { method, headers: { cookie: `qorpera_site=${TOKEN}; ${HOST_COOKIE}=${TOKEN}` } }),
					siteStore,
				);
				assert.equal(response.status, 308, path);
				assert.equal(response.headers.get("location"), location, path);
				assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
				assert.equal(response.headers.get("cdn-cache-control"), "no-store");
				assert.equal(response.headers.get("set-cookie"), null);
				assert.equal(await response.text(), "");
			}
		}
		// The database hears the site's name only: never a token, a cookie or the rest of the path.
		assert.ok(calls.serveHost.every((call) => JSON.stringify(call) === JSON.stringify(["sites.qorpera.com", "look-shop/", null, null, 0, 0])));
		assert.equal(calls.serveHost.length, cases.length * 2);
		assert.equal(calls.serve.length + calls.unlock.length, 0);
	});

	it("sends the old password form and any other method to the own host's top by 303, so no password follows", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: MOVED });
		for (const make of [
			() => post("look-shop", "password=pw"),
			() => request("/look-shop/.qorpera/unlock"),
			() => request("/look-shop/a.html", { method: "PUT", body: "x" }),
			() => request(`/look-shop/~${TOKEN}/data.json`, { method: "OPTIONS" }),
			() => request("/look-shop/form", { method: "POST", body: "x" }),
		]) {
			const response = await serve(make(), siteStore);
			assert.equal(response.status, 303);
			assert.equal(response.headers.get("location"), `https://${OWN}/`);
			assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
		}
		assert.equal(calls.unlock.length, 0);
	});

	it("answers 410 for a site Qorpera took down, never stored", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: { state: "gone" } });
		for (const path of ["/look-shop/", `/look-shop/~${TOKEN}/a.html`, "/look-shop"]) {
			const response = await serve(request(path), siteStore);
			assert.equal(response.status, 410, path);
			assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
			assert.equal(response.headers.get("content-security-policy"), PAGE_SECURITY_POLICY);
			assert.match(await response.text(), /This site is not available\./);
		}
		const posted = await serve(post("look-shop", "password=pw"), siteStore);
		assert.equal(posted.status, 410);
		assert.equal(calls.serve.length + calls.unlock.length, 0);
	});

	it("never asks for the root, robots.txt or a path that names no site, and moves nowhere but the site's own host", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: MOVED });
		for (const path of ["/", "/robots.txt", "/Look-Shop/", "/ab/", "/favicon.ico", "/.qorpera/unlock"])
			assert.notEqual((await serve(request(path), siteStore)).status, 308, path);
		assert.equal(calls.serveHost.length, 0);
		await silenced(async () => {
			for (const url of [
				"https://evil.example/",
				"https://other-shop.qorpera.com/",
				`https://${OWN}/x`,
				`http://${OWN}/`,
				`https://${OWN}:8443/`,
				`https://${NEXT}/`,
				`https://${OWN}`,
			]) {
				const response = await serve(
					request("/look-shop/"),
					store(undefined, undefined, { serveHost: { state: "moved", url } }).store,
				);
				assert.equal(response.status, 503, url);
				assert.equal(response.headers.get("location"), null);
			}
			const failed = await serve(request("/look-shop/"), store(undefined, undefined, { serveHost: new Error("down") }).store);
			assert.equal(failed.status, 503);
			assertPage(failed);
		});
		assert.deepEqual(parseOldHostAnswer({ state: "moved", url: `https://${OWN}/` }, "look-shop"), {
			state: "moved",
			url: `https://${OWN}/`,
		});
		assert.throws(() => parseOldHostAnswer({ state: "none" }, "look-shop"));
		assert.throws(() => parseOldHostAnswer({ state: "legacy", url: "x" }, "look-shop"));
	});
});

describe("site-serve: while hosts are off, and before the migration", () => {
	/** Today's requests on the old host, each with what today's two calls answer. */
	const today: [string, () => Request, unknown?, unknown?][] = [
		["robots", () => request("/robots.txt")],
		["robots HEAD", () => request("/robots.txt", { method: "HEAD" })],
		["root", () => request("/")],
		["favicon", () => request("/favicon.ico")],
		["not a name", () => request("/Shop/")],
		["slash", () => request("/shop?ref=1")],
		["file", () => request(`/shop/~${TOKEN}/`)],
		["file HEAD", () => request(`/shop/~${TOKEN}/`, { method: "HEAD" })],
		[
			"range",
			() => request(`/shop/~${TOKEN}/v.mp4`, { headers: { range: "bytes=2-5" } }),
			file("0123456789", { path: "v.mp4", contentType: "video/mp4" }),
		],
		["held", () => request(`/shop/~${TOKEN}/`, { headers: { "if-none-match": `"${sha(HTML)}"` } })],
		["folder", () => request(`/shop/~${TOKEN}/products?p=2`), { state: "directory", path: "products/" }],
		["missing", () => request(`/shop/~${TOKEN}/gone.html`), { state: "missing" }],
		["ended", () => request(`/shop/~${TOKEN}/a.html?q=1`), { state: "locked" }],
		["failed", () => request(`/shop/~${TOKEN}/`), new Error("down")],
		["preflight", () => request(`/shop/~${TOKEN}/data.json`, { method: "OPTIONS" })],
		["post file", () => request(`/shop/~${TOKEN}/x`, { method: "POST", body: "x" })],
		["plain", () => request("/look-shop/products/")],
		["plain da", () => request("/shop/", { headers: { "accept-language": "da" } })],
		["reload", () => request("/shop/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })],
		["cookie", () => request("/shop/products/item.html?id=7", { headers: { cookie: `qorpera_site=${TOKEN}` } })],
		["cookie ended", () => request("/shop/", { headers: { cookie: `qorpera_site=${TOKEN}` } }), { state: "locked" }],
		["host cookie", () => request("/shop/", { headers: { cookie: `${HOST_COOKIE}=${TOKEN}` } })],
		["put", () => request("/shop/x.html", { method: "PUT", body: "x" })],
		["unlock", () => post("shop", "password=pw&next=a.html", { "cf-connecting-ip": "203.0.113.9" })],
		["unlock wrong", () => post("shop", "password=pw"), undefined, { state: "wrong" }],
		["unlock limited", () => post("shop", "password=pw", { "accept-language": "da" }), undefined, { state: "limited", retryAfter: 125 }],
		["unlock origin", () => post("shop", "password=pw", { origin: "https://evil.example" })],
		["unlock json", () => post("shop", "{}", { "content-type": "application/json" })],
		["unlock GET", () => request("/shop/.qorpera/unlock")],
		["unlock PUT", () => request("/shop/.qorpera/unlock", { method: "PUT", body: "x" })],
		["hidden", () => request("/shop/.git/config")],
		["another host", () => request("/shop/", { headers: { "x-forwarded-host": "sites.example.com" } })],
	];

	it("answers every one of today's requests on the old host byte for byte alike, with or without the migration", async () => {
		await silenced(async () => {
			for (const [what, make, serveAnswer, unlockAnswer] of today) {
				const off = store(serveAnswer ?? file(HTML), unlockAnswer ?? { state: "open", token: NEW_TOKEN, maxAge: 604800 });
				const before = store(serveAnswer ?? file(HTML), unlockAnswer ?? { state: "open", token: NEW_TOKEN, maxAge: 604800 }, {
					serveHost: new MissingFunction("qorpera_site_serve_host"),
				});
				const withHostsOff = await snapshot(await serve(make(), off.store));
				const withoutMigration = await snapshot(await serve(make(), before.store));
				assert.deepEqual(withoutMigration, withHostsOff, what);
				assert.deepEqual(before.calls.serve, off.calls.serve, what);
				assert.deepEqual(before.calls.unlock, off.calls.unlock, what);
				assert.ok(
					off.calls.serveHost.every((call) => call[0] === "sites.qorpera.com" && call[2] === null),
					what,
				);
				assert.equal(off.calls.unlockHost.length + off.calls.enter.length, 0, what);
			}
		});
	});

	it("gives every one of today's answers on the old host an explicit Cache-Control with no-transform (D23)", async () => {
		await silenced(async () => {
			for (const [what, make, serveAnswer, unlockAnswer] of today) {
				const { store: siteStore } = store(
					serveAnswer ?? file(HTML),
					unlockAnswer ?? { state: "open", token: NEW_TOKEN, maxAge: 604800 },
				);
				const response = await serve(make(), siteStore);
				assert.match(
					response.headers.get("cache-control") ?? "",
					/^(?:no-store|private, no-cache), no-transform$/,
					what,
				);
			}
		});
	});

	it("shows a site host's password page with hosts off, and opens nothing there", async () => {
		const { calls, store: siteStore } = store();
		const own = await serve(hostRequest(OWN, "/"), siteStore);
		assert.equal(own.status, 401);
		assertHostPage(own, "same-origin");
		const unlock = await serve(unlockOn(OWN, "password=pw"), siteStore);
		assert.equal(unlock.status, 401);
		assert.match(await unlock.text(), /That password is not right\./);
		const enter = await serve(hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`), siteStore);
		assert.equal(enter.status, 403);
		assert.deepEqual(calls.serveHost, [[OWN, "", null, null, 0, MAX_FILE_BYTES]]);
		assert.deepEqual(calls.unlockHost, [[OWN, "pw", ""]]);
		assert.deepEqual(calls.enter, [[NEXT, TICKET]]);
	});
});

describe("site-serve: the database's site host answers", () => {
	it("takes each in its exact shape for the host's scope", () => {
		const whole = { length: MAX_FILE_BYTES };
		assert.equal(parseHostAnswer({ state: "none" }, "site", null, whole).state, "none");
		assert.equal(parseHostAnswer({ state: "gone" }, "next", null, whole).state, "gone");
		assert.equal(parseHostAnswer(LOCKED, "site", null, whole).state, "locked");
		assert.equal(parseHostAnswer(NEXT_LOCKED, "next", null, whole).state, "locked");
		assert.throws(() => parseHostAnswer(NEXT_LOCKED, "site", null, whole));
		assert.throws(() => parseHostAnswer({ ...LOCKED, public: true }, "site", null, whole));
		assert.throws(() => parseHostAnswer({ state: "gone", scope: "site" }, "site", null, whole));
		const lost = { ...hostFile(NOT_FOUND_HTML, { status: 404, path: "404.html" }), offset: 0 };
		assert.equal(parseHostAnswer(lost, "site", null, whole).state, "file");
		// A 404.html is whole whatever ETag the visitor holds.
		assert.throws(() => parseHostAnswer({ ...lost, content: null }, "site", sha(NOT_FOUND_HTML), whole));
		const live = { ...hostFile(HTML), offset: 0 };
		assert.equal(parseHostAnswer({ ...live, content: null }, "site", sha(HTML), whole).state, "file");
		assert.throws(() => parseHostAnswer({ ...live, content: null }, "site", null, whole));
		assert.throws(() => parseHostAnswer({ ...live, status: 404 }, "site", null, whole));
		assert.deepEqual(parseEnterAnswer({ state: "refused" }), { state: "refused" });
		assert.deepEqual(parseEnterAnswer({ state: "open", token: NEW_TOKEN, maxAge: 43200 }), {
			state: "open",
			token: NEW_TOKEN,
			maxAge: 43200,
		});
		assert.throws(() => parseEnterAnswer({ state: "open", token: NEW_TOKEN }));
	});
});

describe("site-serve: migration 20260930756000's calls and answers, read from its text (step 5.1's cross-check)", () => {
	/** A function of the migration, from `create function public.<name>(` to its `end $$;`. */
	const body = (name: string): string => {
		const start = MIGRATION.indexOf(`create function public.${name}(`);
		assert.ok(start >= 0, name);
		const end = MIGRATION.indexOf("\nend $$;", start);
		assert.ok(end > start, name);
		return MIGRATION.slice(start, end);
	};
	/** A function's argument names, in order. */
	const parameters = (name: string): string[] => {
		const text = body(name);
		const open = text.indexOf("(");
		return text
			.slice(open + 1, text.indexOf(")", open))
			.split(",")
			.map((part) => part.trim().split(/\s+/)[0] ?? "");
	};
	/** Every answer a piece of a function's body gives, as its state and its keys: its JSON literals, and its
	 * jsonb_build_object calls that start with the state (the call's own arguments, every other one a key). */
	const answers = (text: string): { state: string; keys: string[]; literal?: Record<string, unknown> }[] => {
		const found: { state: string; keys: string[]; literal?: Record<string, unknown> }[] = [];
		for (const match of text.matchAll(/'(\{"state":[^']*\})'::jsonb/g)) {
			const literal = JSON.parse(match[1] ?? "") as Record<string, unknown>;
			found.push({ state: String(literal.state), keys: Object.keys(literal), literal });
		}
		for (const match of text.matchAll(/jsonb_build_object\('state', /g)) {
			const args: string[] = [];
			let depth = 0;
			let quoted = false;
			let current = "";
			for (const character of text.slice((match.index ?? 0) + "jsonb_build_object(".length)) {
				if (quoted || character === "'") {
					if (character === "'") quoted = !quoted;
					current += character;
					continue;
				}
				if (character === ")" && depth === 0) break;
				if (character === "(") depth++;
				if (character === ")") depth--;
				if (character === "," && depth === 0) {
					args.push(current.trim());
					current = "";
				} else current += character;
			}
			args.push(current.trim());
			const unquoted = (value = "") => value.replace(/^'(.*)'$/s, "$1");
			found.push({
				state: unquoted(args[1]),
				keys: args.filter((_, index) => index % 2 === 0).map((key) => unquoted(key)),
			});
		}
		return found;
	};
	/** An answer with exactly these keys, each with a value of the kind SQL writes there. */
	const sample = (state: string, keys: string[], scope: "site" | "next"): Record<string, unknown> => {
		const values: Record<string, unknown> = {
			state,
			url: `https://look-shop.qorpera.com/`,
			scope,
			public: false,
			path: state === "directory" ? "products/" : "index.html",
			status: 200,
			contentType: "text/html; charset=utf-8",
			bytes: Buffer.byteLength(HTML),
			sha256: sha(HTML),
			offset: 0,
			content: Buffer.from(HTML).toString("base64"),
			token: NEW_TOKEN,
			maxAge: 43200,
		};
		return Object.fromEntries(keys.map((key) => [key, key in values ? values[key] : `unknown key ${key}`]));
	};

	it("calls only functions it defines, with exactly their argument names, granted to the service role", async () => {
		const made: [string, string[]][] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			made.push([String(url).split("/rest/v1/rpc/")[1] ?? "", Object.keys(JSON.parse(String(init?.body)))]);
			return new Response(JSON.stringify({ state: "none" }), { status: 200 });
		}) as typeof fetch;
		const db = new PostgrestSiteStore("https://project.example.test", "sb_secret_fixture", fetcher);
		await db.serveHost(OWN, "", TOKEN, null, 0, 0);
		await db.unlockHost(OWN, "pw", "");
		await db.enter(NEXT, TICKET);
		assert.deepEqual(
			made.map(([name]) => name),
			["qorpera_site_serve_host", "qorpera_site_unlock_host", "qorpera_site_enter"],
		);
		for (const [name, keys] of made) {
			assert.deepEqual(keys, parameters(name), name);
			assert.match(
				MIGRATION,
				new RegExp(`grant execute on function [^;]*public\\.${name}\\([^;]*to service_role;`),
				name,
			);
		}
	});

	it("reads every answer qorpera_site_serve_host gives, on the old host and on a site host, and none it never gives", () => {
		const text = body("qorpera_site_serve_host");
		const legacy = `return '{"state":"legacy"}'::jsonb;`;
		const split = text.indexOf(legacy) + legacy.length;
		assert.ok(split > legacy.length, "the old host's part ends in legacy");
		const old = answers(text.slice(0, split));
		const host = answers(text.slice(split));
		assert.deepEqual([...new Set(old.map((answer) => answer.state))].sort(), ["gone", "legacy", "moved"]);
		assert.deepEqual([...new Set(host.map((answer) => answer.state))].sort(), [
			"directory",
			"file",
			"gone",
			"locked",
			"missing",
			"none",
		]);
		for (const { state, keys } of old)
			assert.equal(parseOldHostAnswer(sample(state, keys, "site"), "look-shop").state, state, state);
		for (const { state, keys, literal } of host)
			for (const scope of ["site", "next"] as const) {
				// A literal names its own scope (locked); a built answer names the host's.
				if (literal && "scope" in literal && literal.scope !== scope) continue;
				const value = literal ?? sample(state, keys, scope);
				assert.equal(
					parseHostAnswer(value, scope, null, { length: MAX_FILE_BYTES }).state,
					state,
					`${state} ${scope}`,
				);
			}
		// Both scopes' locked answers are there.
		assert.deepEqual(
			host.filter((answer) => answer.state === "locked").map((answer) => answer.literal?.scope),
			["site", "next"],
		);
	});

	it("reads every answer of the own host's password and the next host's ticket", () => {
		const unlock = body("qorpera_site_unlock_host");
		assert.deepEqual(answers(unlock), [{ state: "wrong", keys: ["state"], literal: { state: "wrong" } }]);
		assert.equal(parseUnlockAnswer({ state: "wrong" }).state, "wrong");
		// Any other answer is today's password's (qorpera_site_unlock: open, wrong, limited), which site-serve reads already.
		assert.match(unlock, /return public\.qorpera_site_unlock\(v_host_of ->> 'slug', p_password, p_client\);/);
		const enter = answers(body("qorpera_site_enter"));
		assert.deepEqual([...new Set(enter.map((answer) => answer.state))].sort(), ["open", "refused"]);
		for (const { state, keys, literal } of enter)
			assert.equal(parseEnterAnswer(literal ?? sample(state, keys, "next")).state, state, state);
		// The next session's 12 hours, within what site-serve sets a cookie for.
		assert.match(
			body("qorpera_site_enter"),
			/jsonb_build_object\('state', 'open', 'token', v_token, 'maxAge', 43200\)/,
		);
	});
});

// --- A page view's count (the company's numbers, door site; 20260930768000) -------------------------------------------

/** Migration 20260930768000's text: the count call site-serve makes must be there, as written. */
const COUNT_MIGRATION = readFileSync(
	new URL("../../migrations/20260930768000_company_numbers_site.sql", import.meta.url),
	"utf8",
);

async function serveWith(req: Request, siteStore: SiteStore, waitUntil?: (work: Promise<unknown>) => void) {
	const response = await handleSiteServe(req, { origin: ORIGIN, store: siteStore, ...(waitUntil ? { waitUntil } : {}) });
	askedOn.set(response, req.headers.get("x-forwarded-host") ?? "");
	return response;
}

describe("site-serve: a page view's count", () => {
	it("counts a page of the live version on the own host: the host, the file's path and the session's token", async () => {
		const pages: Record<string, Json> = {
			"": hostFile(HTML),
			"about.html": hostFile(HTML, { path: "about.html" }),
			"shop/": hostFile(HTML, { path: "shop/index.html" }),
		};
		const { calls, store: siteStore } = store(undefined, undefined, {
			serveHost: (_host: string, path: string) => pages[path] ?? { state: "missing", scope: "site", public: false },
		});
		for (const path of ["/", "/about.html", "/shop/"])
			assert.equal((await serve(hostRequest("Look-Shop.Qorpera.com", path, { headers: WITH_SESSION }), siteStore)).status, 200);
		// A visitor who holds the page (304), and a navigation from another site.
		const held = await serve(
			hostRequest(OWN, "/", { headers: { ...WITH_SESSION, "if-none-match": `"${sha(HTML)}"` } }),
			siteStore,
		);
		assert.equal(held.status, 304);
		const navigated = await serve(
			hostRequest(OWN, "/", {
				headers: {
					...WITH_SESSION,
					"sec-fetch-site": "cross-site",
					"sec-fetch-mode": "navigate",
					"sec-fetch-dest": "document",
				},
			}),
			siteStore,
		);
		assert.equal(navigated.status, 200);
		assert.deepEqual(calls.countView, [
			[OWN, "index.html", TOKEN],
			[OWN, "about.html", TOKEN],
			[OWN, "shop/index.html", TOKEN],
			[OWN, "index.html", TOKEN],
			[OWN, "index.html", TOKEN],
		]);
	});

	it("counts with the session cookie the page was read with", async () => {
		const { calls, store: siteStore } = store(undefined, undefined, {
			serveHost: (_host: string, _path: string, token: string | null) => (token === NEW_TOKEN ? hostFile(HTML) : LOCKED),
		});
		const response = await serve(
			hostRequest(OWN, "/", { headers: { cookie: `${HOST_COOKIE}=${TOKEN}; ${HOST_COOKIE}=${NEW_TOKEN}` } }),
			siteStore,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(calls.countView, [[OWN, "index.html", NEW_TOKEN]]);
	});

	it("counts nothing on a site host but a page view of the live version", async () => {
		const css = hostFile("body{}", { path: "a.css", contentType: "text/css; charset=utf-8" });
		const image = hostFile("png", { path: "logo.png", contentType: "image/png" });
		const lost = hostFile(NOT_FOUND_HTML, { path: "404.html", status: 404 });
		const sameOrigin = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" };
		const cases: [string, Request, unknown][] = [
			["HEAD", hostRequest(OWN, "/", { method: "HEAD", headers: WITH_SESSION }), hostFile(HTML)],
			["a range", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, range: "bytes=0-3" } }), hostFile(HTML)],
			["a suffix range", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, range: "bytes=-4" } }), hostFile(HTML)],
			["a style sheet", hostRequest(OWN, "/a.css", { headers: WITH_SESSION }), css],
			["an image", hostRequest(OWN, "/logo.png", { headers: WITH_SESSION }), image],
			["the version's 404.html", hostRequest(OWN, "/gone.html", { headers: WITH_SESSION }), lost],
			["a missing page", hostRequest(OWN, "/gone.html", { headers: WITH_SESSION }), { state: "missing", scope: "site", public: false }],
			["a folder", hostRequest(OWN, "/shop", { headers: WITH_SESSION }), { state: "directory", path: "shop/", scope: "site", public: false }],
			["the password page", hostRequest(OWN, "/"), LOCKED],
			["an ended session", hostRequest(OWN, "/", { headers: WITH_SESSION }), LOCKED],
			["no site", hostRequest(OWN, "/", { headers: WITH_SESSION }), { state: "none" }],
			["taken down", hostRequest(OWN, "/", { headers: WITH_SESSION }), { state: "gone" }],
			["the next host", hostRequest(NEXT, "/", { headers: WITH_SESSION }), hostFile(HTML, { scope: "next" })],
			["an image's load", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, ...sameOrigin, "sec-fetch-dest": "image" } }), hostFile(HTML)],
			["a frame", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, ...sameOrigin, "sec-fetch-dest": "iframe" } }), hostFile(HTML)],
			["a fetch", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, ...sameOrigin, "sec-fetch-dest": "empty" } }), hostFile(HTML)],
			["a prefetch", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, "sec-purpose": "prefetch" } }), hostFile(HTML)],
			["a prerender", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, "sec-purpose": "prefetch;prerender" } }), hostFile(HTML)],
			["an older prefetch", hostRequest(OWN, "/", { headers: { ...WITH_SESSION, purpose: "prefetch" } }), hostFile(HTML)],
			[
				"a sibling's load",
				hostRequest(OWN, "/", {
					headers: { ...WITH_SESSION, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" },
				}),
				hostFile(HTML),
			],
			["robots.txt", hostRequest(OWN, "/robots.txt", { headers: WITH_SESSION }), hostFile(HTML)],
			["a POST", hostRequest(OWN, "/", { method: "POST", body: "x", headers: WITH_SESSION }), hostFile(HTML)],
			["the password form", unlockOn(OWN, "password=pw"), hostFile(HTML)],
			["Look first's ticket", hostRequest(NEXT, `/.qorpera/enter?t=${TICKET}`), hostFile(HTML)],
		];
		for (const [what, made, answer] of cases) {
			const { calls, store: siteStore } = store(undefined, undefined, {
				serveHost: answer,
				unlockHost: { state: "open", token: NEW_TOKEN, maxAge: 604800 },
				enter: { state: "open", token: NEW_TOKEN, maxAge: 43200 },
			});
			await serve(made, siteStore);
			assert.deepEqual(calls.countView, [], what);
		}
	});

	it("counts the old host's session pages, the site's name first, and nothing else there", async () => {
		const pages: Record<string, Json> = {
			"": file(HTML),
			"products/item.html": file(HTML, { path: "products/item.html" }),
			"a.css": file("body{}", { path: "a.css", contentType: "text/css; charset=utf-8" }),
		};
		const { calls, store: siteStore } = store((path: string) => pages[path] ?? { state: "missing" });
		for (const path of [`/shop/~${TOKEN}/`, `/shop/~${TOKEN}/products/item.html?id=7`])
			assert.equal((await serve(request(path), siteStore)).status, 200);
		const held = await serve(request(`/shop/~${TOKEN}/`, { headers: { "if-none-match": `"${sha(HTML)}"` } }), siteStore);
		assert.equal(held.status, 304);
		assert.deepEqual(calls.countView, [
			["sites.qorpera.com", "shop/index.html", TOKEN],
			["sites.qorpera.com", "shop/products/item.html", TOKEN],
			["sites.qorpera.com", "shop/index.html", TOKEN],
		]);
		calls.countView.length = 0;
		for (const made of [
			request(`/shop/~${TOKEN}/`, { method: "HEAD" }),
			request(`/shop/~${TOKEN}/`, { headers: { range: "bytes=0-3" } }),
			request(`/shop/~${TOKEN}/a.css`),
			request(`/shop/~${TOKEN}/gone.html`),
			request(`/shop/~${TOKEN}/products`, {}),
			request(`/shop/~${TOKEN}/`, { headers: { "sec-fetch-dest": "iframe" } }),
			request(`/shop/~${TOKEN}/`, { headers: { "sec-purpose": "prefetch" } }),
			request("/shop/", { headers: { cookie: `qorpera_site=${TOKEN}` } }),
			request("/shop/"),
			post("shop", "password=pw"),
			request(`/shop/~${TOKEN}/data.json`, { method: "OPTIONS" }),
		])
			await serve(made, siteStore);
		assert.deepEqual(calls.countView, []);
		// An ended session's path goes back to the password: nothing counts.
		const ended = store({ state: "locked" });
		assert.equal((await serve(request(`/shop/~${TOKEN}/`), ended.store)).status, 303);
		assert.deepEqual(ended.calls.countView, []);
		// While hosts are on, the old host's links move: nothing is served there, nothing counts.
		const moved = store(file(HTML), undefined, { serveHost: { state: "moved", url: "https://shop.qorpera.com/" } });
		assert.equal((await serve(request(`/shop/~${TOKEN}/`), moved.store)).status, 308);
		assert.deepEqual(moved.calls.countView, []);
	});

	it("never changes an answer: counted, refused, failed, missing or never answering, the same bytes", async () => {
		const never = new Promise<unknown>(() => undefined);
		const made: [string, () => Request, HostAnswers, unknown?][] = [
			["own page", () => hostRequest(OWN, "/", { headers: WITH_SESSION }), { serveHost: hostFile(HTML) }],
			[
				"own held",
				() => hostRequest(OWN, "/", { headers: { ...WITH_SESSION, "if-none-match": `"${sha(HTML)}"` } }),
				{ serveHost: hostFile(HTML) },
			],
			["old page", () => request(`/shop/~${TOKEN}/`), {}, file(HTML)],
			["old held", () => request(`/shop/~${TOKEN}/`, { headers: { "if-none-match": `"${sha(HTML)}"` } }), {}, file(HTML)],
		];
		await silenced(async () => {
			for (const [what, make, host, serveAnswer] of made) {
				const counted = await snapshot(await serveWith(make(), store(serveAnswer, undefined, host).store));
				for (const countView of [
					{ state: "skipped" },
					{ state: "busy" },
					new Error("down"),
					new MissingFunction("qorpera_site_count_view"),
					"not an answer",
				]) {
					const other = await snapshot(await serveWith(make(), store(serveAnswer, undefined, { ...host, countView }).store));
					assert.deepEqual(other, counted, `${what}: ${String(countView)}`);
				}
				const kept: Promise<unknown>[] = [];
				const later = await serveWith(make(), store(serveAnswer, undefined, { ...host, countView: never }).store, (work) =>
					kept.push(work),
				);
				assert.deepEqual(await snapshot(later), counted, `${what}: never answering`);
				assert.equal(kept.length, 1, what);
			}
		});
	});

	it("hands the count to waitUntil, the edge runtime's when it has one, and the answer never waits for it", async () => {
		const never = new Promise<unknown>(() => undefined);
		const kept: Promise<unknown>[] = [];
		const { calls, store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML), countView: never });
		let started = Date.now();
		const response = await serveWith(hostRequest(OWN, "/", { headers: WITH_SESSION }), siteStore, (work) => kept.push(work));
		assert.equal(response.status, 200);
		assert.ok(Date.now() - started < COUNT_WAIT_MS / 2, "the answer waited for the count");
		assert.equal(kept.length, 1);
		assert.equal(calls.countView.length, 1);
		// Supabase's edge runtime: EdgeRuntime.waitUntil, called on its object.
		const edge = { kept: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.kept.push(work); } };
		const global = globalThis as { EdgeRuntime?: unknown };
		global.EdgeRuntime = edge;
		try {
			started = Date.now();
			const viaEdge = await serve(hostRequest(OWN, "/", { headers: WITH_SESSION }), siteStore);
			assert.equal(viaEdge.status, 200);
			assert.ok(Date.now() - started < COUNT_WAIT_MS / 2, "the answer waited for the count");
			assert.equal(edge.kept.length, 1);
		} finally {
			Reflect.deleteProperty(global, "EdgeRuntime");
		}
	});

	it("without waitUntil, waits for the count at most 200 ms", async () => {
		const never = new Promise<unknown>(() => undefined);
		const { store: siteStore } = store(undefined, undefined, { serveHost: hostFile(HTML), countView: never });
		const started = Date.now();
		const response = await serve(hostRequest(OWN, "/", { headers: WITH_SESSION }), siteStore);
		const waited = Date.now() - started;
		assert.equal(response.status, 200);
		assert.equal(await response.text(), HTML);
		assert.ok(waited >= COUNT_WAIT_MS - 20 && waited < COUNT_WAIT_MS + 500, `waited ${waited} ms`);
		// A count that answers at once is not waited for longer.
		const quick = store(undefined, undefined, { serveHost: hostFile(HTML) });
		const begun = Date.now();
		await serve(hostRequest(OWN, "/", { headers: WITH_SESSION }), quick.store);
		assert.ok(Date.now() - begun < COUNT_WAIT_MS / 2);
	});

	it("logs a failed count by its kind only, never a token, a path or a host", async () => {
		await silenced(async (logged) => {
			const failing = store(undefined, undefined, {
				serveHost: hostFile(HTML),
				countView: new TypeError(`could not count ${OWN}/index.html for ${TOKEN}`),
			});
			assert.equal((await serve(hostRequest(OWN, "/", { headers: WITH_SESSION }), failing.store)).status, 200);
			const old = store(file(HTML), undefined, { countView: new Error(`sites.qorpera.com shop ${TOKEN}`) });
			assert.equal((await serve(request(`/shop/~${TOKEN}/`), old.store)).status, 200);
			assert.deepEqual(logged, [
				"site-serve: a view was not counted (TypeError)",
				"site-serve: a view was not counted (Error)",
			]);
		});
	});

	it("reads the request's side of a view", () => {
		const made = (headers: Record<string, string> = {}, method = "GET") => new Request(BASE, { method, headers });
		assert.equal(countsAsView(made(), 200), true);
		assert.equal(countsAsView(made(), 304), true);
		assert.equal(countsAsView(made({ "sec-fetch-dest": "document" }), 200), true);
		for (const status of [206, 301, 401, 404, 410, 416, 503]) assert.equal(countsAsView(made(), status), false, String(status));
		assert.equal(countsAsView(made({}, "HEAD"), 200), false);
		assert.equal(countsAsView(made({ range: "bytes=0-" }), 200), false);
		for (const dest of ["iframe", "image", "script", "style", "empty", "frame", "embed", "object"])
			assert.equal(countsAsView(made({ "sec-fetch-dest": dest }), 200), false, dest);
		assert.equal(countsAsView(made({ "sec-purpose": "prefetch" }), 200), false);
		assert.equal(countsAsView(made({ purpose: "prefetch" }), 200), false);
	});

	it("calls qorpera_site_count_view with the service key, its three arguments and a short deadline", async () => {
		const made: { url: string; body: Json; signal: AbortSignal | null | undefined; headers: Headers }[] = [];
		const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
			made.push({
				url: String(url),
				body: JSON.parse(String(init?.body)) as Json,
				signal: init?.signal,
				headers: new Headers(init?.headers),
			});
			return new Response(JSON.stringify({ state: "counted", visit: true }), { status: 200 });
		}) as typeof fetch;
		const db = new PostgrestSiteStore("https://project.example.test/", "sb_secret_fixture", fetcher);
		assert.deepEqual(await db.countView(OWN, "index.html", TOKEN), { state: "counted", visit: true });
		assert.equal(made[0]?.url, "https://project.example.test/rest/v1/rpc/qorpera_site_count_view");
		assert.deepEqual(made[0]?.body, { p_host: OWN, p_path: "index.html", p_token: TOKEN });
		assert.equal(made[0]?.headers.get("apikey"), "sb_secret_fixture");
		assert.ok(made[0]?.signal instanceof AbortSignal);
		// The migration defines it with exactly those arguments, for the service role only.
		const start = COUNT_MIGRATION.indexOf("create function public.qorpera_site_count_view(");
		assert.ok(start > 0);
		const head = COUNT_MIGRATION.slice(start, COUNT_MIGRATION.indexOf(")", start));
		assert.deepEqual(
			head
				.slice(head.indexOf("(") + 1)
				.split(",")
				.map((part) => part.trim().split(/\s+/)[0]),
			Object.keys(made[0]?.body ?? {}),
		);
		assert.match(COUNT_MIGRATION, /grant execute on function public\.qorpera_site_count_view\(text, text, text\) to service_role;/);
		assert.doesNotMatch(COUNT_MIGRATION, /grant execute on function public\.qorpera_site_count_view[^;]*(anon|authenticated)/);
		// A database without the call (installed before its migration): MissingFunction, as for the other calls.
		const missing = new PostgrestSiteStore("https://project.example.test", "sb_secret_fixture", (async () =>
			new Response(JSON.stringify(PGRST202), { status: 404 })) as typeof fetch);
		await assert.rejects(missing.countView(OWN, "index.html", TOKEN), MissingFunction);
	});
});
