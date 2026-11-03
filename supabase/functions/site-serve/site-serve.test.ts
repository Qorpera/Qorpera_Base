import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	byteRange,
	CONTENT_SECURITY_POLICY,
	escapeHtml,
	handleSiteServe,
	isSitePath,
	language,
	MAX_FILE_BYTES,
	MAX_STORE_ANSWER_BYTES,
	MAX_UNLOCK_BODY_BYTES,
	PAGE_SECURITY_POLICY,
	PostgrestSiteStore,
	parseServeAnswer,
	rangeRequest,
	requestedEtag,
	type SiteStore,
	serviceHeaders,
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
	const content =
		answer.content === null || etag === answer.sha256 || count === 0
			? null
			: Buffer.from(answer.content, "base64").subarray(at, at + count).toString("base64");
	return { ...answer, offset: at, content };
}

function store(serve: unknown = file(HTML), unlock: unknown = { state: "open", token: NEW_TOKEN, maxAge: 604800 }) {
	const calls: Calls = { serve: [], unlock: [] };
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
	};
	return { calls, store: siteStore };
}

function request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, base = BASE): Request {
	return new Request(`${base}${path}`, {
		...init,
		headers: { "x-forwarded-host": "sites.qorpera.com", ...init.headers },
	});
}

async function serve(req: Request, siteStore: SiteStore = store().store): Promise<Response> {
	return handleSiteServe(req, { origin: ORIGIN, store: siteStore });
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
	assert.equal(response.headers.get("cache-control"), "no-store");
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
	assert.equal(response.headers.get("cache-control"), "private, no-cache");
	assert.equal(response.headers.get("etag"), `"${hash}"`);
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.equal(response.headers.get("set-cookie"), null);
}

describe("site-serve: the host and the root", () => {
	it("serves only on the sites host, from x-forwarded-host or else Host", async () => {
		const { calls, store: siteStore } = store();
		for (const headers of [{ "x-forwarded-host": "api.qorpera.com" }, { "x-forwarded-host": "" }]) {
			const response = await serve(request(`/shop/~${TOKEN}/`, { headers }), siteStore);
			assert.equal(response.status, 404);
			assertPage(response);
		}
		const noForwarded = new Request(`${BASE}/shop/~${TOKEN}/`, { headers: { host: "app.qorpera.com" } });
		assert.equal((await serve(noForwarded, siteStore)).status, 404);
		assert.equal(calls.serve.length, 0);
		// No x-forwarded-host: Host decides.
		const byHost = new Request(`${BASE}/shop/~${TOKEN}/`, { headers: { host: "sites.qorpera.com" } });
		assert.equal((await serve(byHost, siteStore)).status, 200);
		// A comma list: its first entry.
		calls.serve.length = 0;
		const listed = await serve(
			request(`/shop/~${TOKEN}/`, { headers: { "x-forwarded-host": "SITES.qorpera.com, api.qorpera.com" } }),
			siteStore,
		);
		assert.equal(listed.status, 200);
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
		for (let i = 0; i < 4; i++) await assert.rejects(siteStore.serve("shop", "", null, null));
	});
});
