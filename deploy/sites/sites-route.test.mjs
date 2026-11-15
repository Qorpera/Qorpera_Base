import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	API,
	API_HOST,
	APP_HEALTH_URL,
	APPS_HOST,
	CACHE_RULE,
	Cloudflare,
	describeIngress,
	dnsPlan,
	HOST,
	lastGroupDisallowsAll,
	lockedSitePage,
	main,
	probeName,
	RELAY_PROBE_URL,
	readToken,
	SERVICE,
	WEB_MARKER,
	WEB_ORIGIN,
	withAppsIngress,
	withSitesIngress,
} from "./sites-route.mjs";

const TOKEN = "cf-test-token-0123456789abcdef";
const TUNNEL_ID = "6e2a0000-0000-4000-8000-0000000000aa";
const API_RULE = {
	hostname: "api.qorpera.com",
	service: "http://api-front:8080",
	originRequest: { noTLSVerify: false },
};
const CATCH_ALL = { service: "http_status:404" };
const SITES_RULE = { hostname: HOST, service: SERVICE };
const APPS_RULE = { hostname: APPS_HOST, service: SERVICE };
/** The made-up site name a check run probes (a new random one in real runs). */
const PROBE = "zz-check-test";
/** site-serve's page for a site host without a session, as release 5.1 answers it. */
const LOCKED = {
	status: 401,
	headers: {
		"content-type": "text/html; charset=utf-8",
		"x-robots-tag": "noindex, nofollow, noarchive",
		"cache-control": "private, no-cache, no-transform",
	},
	text: "<!doctype html><title>Private site</title>",
};
/** The live web once E1a is live: its marker in one of the scripts web-deployment.json lists (build5/E1a.md). */
const WEB_LIVE = {
	"index.html": "<script src=build/main-A.js></script>",
	"build/chunk-B.js": "export {};",
	"build/main-A.js": `const bj=/^([a-z0-9]+(?:-[a-z0-9]+)*)${WEB_MARKER}/;`,
};
/** What Cloudflare's managed robots.txt puts before the origin's own file (its shape, 13 Nov 2026). */
const MANAGED_ROBOTS =
	"# As a condition of accessing this website, you agree to abide by the following content signals:\n" +
	"User-agent: *\nContent-Signal: search=yes,ai-train=no\nAllow: /\n\n" +
	"User-agent: Amazonbot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\n";

/** A fake Cloudflare: the zone, the tunnel, its configuration, the DNS records (listed by name) and the zone's cache
 * rules ruleset, as the API answers them, for a token that may edit, only read or not touch Cache Rules; and the two
 * public answers --check reads. */
function cloudflare({
	ingress = [API_RULE, CATCH_ALL],
	records = [],
	cacheRuleset = null,
	cacheAccess = "edit",
	robots = { status: 200, text: "User-agent: *\nDisallow: /\n" },
	health = { status: 200, text: "ok\n" },
	relay = {
		status: 403,
		headers: { "cache-control": "no-store" },
		text: "<!doctype html><title>Sent from another site</title>",
	},
	siteHost = LOCKED,
	apiSite = { status: 404, headers: {}, text: "" },
	web = WEB_LIVE,
} = {}) {
	const state = {
		config: { ingress, "warp-routing": { enabled: false } },
		records: records.map((record) => ({ ...record })),
		cacheRuleset: structuredClone(cacheRuleset),
	};
	const sent = [];
	const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
	const refused = (status, code, message) =>
		new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
	const cache = (method, path, body) => {
		const entrypoint = path === "/zones/zone1/rulesets/phases/http_request_cache_settings/entrypoint";
		const ruleset = state.cacheRuleset;
		const rules = ruleset && path === `/zones/zone1/rulesets/${ruleset.id}/rules`;
		const rule = ruleset?.rules.find((item) => path === `/zones/zone1/rulesets/${ruleset.id}/rules/${item.id}`);
		const create = path === "/zones/zone1/rulesets" && method === "POST";
		if (!entrypoint && !rules && !rule && !create) return null;
		if (cacheAccess === "none" || (cacheAccess === "read" && method !== "GET"))
			return refused(403, 10000, "Authentication error");
		if (entrypoint && method === "GET")
			return ruleset ? ok(ruleset) : refused(404, 10003, "could not find entrypoint ruleset in the phase");
		if (create) {
			state.cacheRuleset = {
				id: "rs1",
				kind: body.kind,
				phase: body.phase,
				rules: body.rules.map((item, index) => ({ id: `r${index + 1}`, ...item })),
			};
			return ok(state.cacheRuleset);
		}
		if (rules && method === "POST") {
			ruleset.rules.push({ id: `r${ruleset.rules.length + 1}`, ...body });
			return ok(ruleset);
		}
		if (rule && method === "PATCH") {
			Object.assign(rule, body);
			return ok(ruleset);
		}
		return null;
	};
	const fetcher = async (input, init = {}) => {
		const url = String(input);
		sent.push({
			url,
			method: init.method ?? "GET",
			body: init.body,
			authorization: init.headers?.authorization,
			forwardedHost: init.headers?.["x-forwarded-host"],
			origin: init.headers?.origin,
		});
		if (url === `https://${HOST}/robots.txt`) return new Response(robots.text, { status: robots.status });
		if (url === APP_HEALTH_URL) return new Response(health.text, { status: health.status });
		const answer = ({ status, headers, text }) => new Response(text, { status, headers });
		if (url === RELAY_PROBE_URL) return answer(relay);
		for (const host of [`${PROBE}.qorpera.com`, `${PROBE}--next.qorpera.com`])
			if (url === `https://${host}/` || url === `https://${host}/rest/v1/`)
				return answer(typeof siteHost === "function" ? siteHost(url) : siteHost);
		if (url === `https://${API_HOST}/functions/v1/site-serve/`) return answer(apiSite);
		if (url === `${WEB_ORIGIN}/web-deployment.json`)
			return web === null
				? new Response("", { status: 404 })
				: Response.json({
						version: 1,
						sourceCommit: "e1a0000",
						files: Object.fromEntries(Object.keys(web).map((file) => [file, { sha256: "x" }])),
					});
		if (url.startsWith(`${WEB_ORIGIN}/`) && Object.hasOwn(web, url.slice(WEB_ORIGIN.length + 1)))
			return new Response(web[url.slice(WEB_ORIGIN.length + 1)]);
		assert.ok(url.startsWith(API), url);
		const path = url.slice(API.length);
		if (path === "/zones?name=qorpera.com")
			return ok([{ id: "zone1", name: "qorpera.com", account: { id: "acc1" } }]);
		if (path === "/accounts/acc1/cfd_tunnel?name=qorpera-dbhome&is_deleted=false")
			return ok([{ id: TUNNEL_ID, name: "qorpera-dbhome" }]);
		if (path === `/accounts/acc1/cfd_tunnel/${TUNNEL_ID}/configurations`) {
			if (init.method === "PUT") {
				state.config = JSON.parse(init.body).config;
				return ok({ config: state.config });
			}
			return ok({ tunnel_id: TUNNEL_ID, version: 3, config: state.config, source: "cloudflare" });
		}
		const cached = cache(init.method ?? "GET", path, init.body === undefined ? undefined : JSON.parse(init.body));
		if (cached) return cached;
		const listed = /^\/zones\/zone1\/dns_records\?name=(.+)$/.exec(path)?.[1];
		if (listed === HOST || listed === APPS_HOST) return ok(state.records.filter((record) => record.name === listed));
		if (path === "/zones/zone1/dns_records" && init.method === "POST") {
			const record = { id: `rec${state.records.length + 1}`, ...JSON.parse(init.body) };
			state.records.push(record);
			return ok(record);
		}
		const patched = state.records.find((record) => path === `/zones/zone1/dns_records/${record.id}`);
		if (patched && init.method === "PATCH") {
			Object.assign(patched, JSON.parse(init.body));
			return ok(patched);
		}
		return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${TOKEN}` }] }), {
			status: 404,
		});
	};
	return { state, sent, fetcher };
}

async function run(argv, fake, env = { CF_API_TOKEN: TOKEN }) {
	const lines = [];
	const code = await main(argv, { env, fetcher: fake.fetcher, log: (line) => lines.push(line), siteName: PROBE });
	return { code, output: lines.join("\n") };
}

describe("sites-route: the ingress", () => {
	it("adds the sites rule first, so no wildcard shadows it, and keeps every other rule and key exactly", () => {
		const config = { ingress: [API_RULE, CATCH_ALL], "warp-routing": { enabled: false } };
		const { config: next, changed } = withSitesIngress(config);
		assert.equal(changed, true);
		assert.deepEqual(next.ingress, [{ hostname: HOST, service: SERVICE }, API_RULE, CATCH_ALL]);
		assert.deepEqual(next["warp-routing"], { enabled: false });
		assert.deepEqual(config.ingress, [API_RULE, CATCH_ALL], "the original is not changed");
		assert.deepEqual(withSitesIngress(next), { config: next, changed: false });
	});

	it("refuses an ingress without a catch-all last, or a rule that already holds the name differently", () => {
		assert.throws(() => withSitesIngress({ ingress: [API_RULE] }), /catch-all/);
		assert.throws(() => withSitesIngress({}), /catch-all/);
		assert.throws(() => withSitesIngress({ ingress: [{ path: "/x", service: "http_status:404" }] }), /catch-all/);
		assert.throws(
			() => withSitesIngress({ ingress: [{ hostname: HOST, service: "http://other:80" }, CATCH_ALL] }),
			/already holds/,
		);
		assert.throws(
			() => withSitesIngress({ ingress: [{ hostname: HOST, service: SERVICE, path: "/a" }, CATCH_ALL] }),
			/already holds/,
		);
	});

	it("adds the app links' wildcard rule after the exact rules and before the catch-all, once", () => {
		const config = { ingress: [SITES_RULE, API_RULE, CATCH_ALL], "warp-routing": { enabled: false } };
		const { config: next, changed } = withAppsIngress(config);
		assert.equal(changed, true);
		assert.deepEqual(next.ingress, [SITES_RULE, API_RULE, APPS_RULE, CATCH_ALL]);
		assert.deepEqual(next["warp-routing"], { enabled: false });
		assert.deepEqual(config.ingress, [SITES_RULE, API_RULE, CATCH_ALL], "the original is not changed");
		assert.deepEqual(withAppsIngress(next), { config: next, changed: false });
		// The sites rule still goes first, before the wildcard, whichever comes first.
		assert.deepEqual(withSitesIngress(withAppsIngress({ ingress: [API_RULE, CATCH_ALL] }).config).config.ingress, [
			SITES_RULE,
			API_RULE,
			APPS_RULE,
			CATCH_ALL,
		]);
	});

	it("refuses a wildcard rule that is not the app links' own, and an ingress without a catch-all", () => {
		assert.throws(() => withAppsIngress({ ingress: [API_RULE] }), /catch-all/);
		assert.throws(
			() => withAppsIngress({ ingress: [{ hostname: APPS_HOST, service: "http://other:80" }, CATCH_ALL] }),
			/already holds \*\.qorpera\.com/,
		);
		assert.throws(() => withAppsIngress({ ingress: [{ ...APPS_RULE, path: "/x" }, CATCH_ALL] }), /already holds/);
		assert.throws(() => withAppsIngress({ ingress: [APPS_RULE, APPS_RULE, CATCH_ALL] }), /already holds/);
	});

	it("describes rules without anything secret", () => {
		assert.deepEqual(
			describeIngress([API_RULE, { hostname: "x.test", path: "/p", service: "http://s" }, CATCH_ALL]),
			["api.qorpera.com -> http://api-front:8080", "x.test path /p -> http://s", "* -> http_status:404"],
		);
	});
});

describe("sites-route: the DNS record", () => {
	it("makes a proxied CNAME to the tunnel, proxies one that is not, and leaves a right one", () => {
		const made = dnsPlan([], TUNNEL_ID);
		assert.equal(made.action, "create");
		assert.deepEqual(
			{ ...made.body, comment: undefined },
			{
				type: "CNAME",
				name: HOST,
				content: `${TUNNEL_ID}.cfargotunnel.com`,
				proxied: true,
				comment: undefined,
			},
		);
		const right = { id: "r", type: "CNAME", content: `${TUNNEL_ID}.cfargotunnel.com`, proxied: true };
		assert.deepEqual(dnsPlan([right], TUNNEL_ID), { action: "none", id: "r" });
		assert.deepEqual(dnsPlan([{ ...right, proxied: false }], TUNNEL_ID), {
			action: "proxy",
			id: "r",
			body: { proxied: true },
		});
	});

	it("plans the wildcard name the same way, with its own comment", () => {
		const made = dnsPlan([], TUNNEL_ID, APPS_HOST);
		assert.equal(made.action, "create");
		assert.equal(made.body.name, "*.qorpera.com");
		assert.equal(made.body.content, `${TUNNEL_ID}.cfargotunnel.com`);
		assert.equal(made.body.proxied, true);
		assert.match(made.body.comment, /App links/);
		assert.throws(
			() => dnsPlan([{ id: "w", type: "A", content: "192.0.2.1", proxied: true }], TUNNEL_ID, APPS_HOST),
			/\*\.qorpera\.com already has 1 other DNS record/,
		);
	});

	it("refuses a name another record holds", () => {
		assert.throws(
			() => dnsPlan([{ id: "r", type: "A", content: "192.0.2.1", proxied: true }], TUNNEL_ID),
			/other DNS record/,
		);
		assert.throws(() => dnsPlan([{ id: "r", type: "CNAME", content: "other.example", proxied: true }], TUNNEL_ID));
		assert.throws(() => dnsPlan([{ type: "CNAME" }, { type: "CNAME" }], TUNNEL_ID));
	});
});

describe("sites-route: what --check reads of the site hosts and robots.txt", () => {
	it("takes site-serve's page for a site without a session, and nothing else", () => {
		const headers = (extra = {}) => new Headers({ ...LOCKED.headers, ...extra });
		assert.equal(lockedSitePage(401, headers()), true);
		assert.equal(lockedSitePage(401, headers({ "content-type": "TEXT/HTML" })), true);
		assert.equal(lockedSitePage(401, headers({ "cache-control": "no-transform, no-store" })), true);
		assert.equal(lockedSitePage(401, headers({ "x-robots-tag": "noindex" })), true);
		for (const [label, status, extra] of [
			["envoy's 404", 404, { "content-type": "" }],
			["a page", 200, {}],
			["the password limit", 429, {}],
			["JSON", 401, { "content-type": "application/json" }],
			["an HTML-ish type", 401, { "content-type": "text/htmlx" }],
			["no robots tag", 401, { "x-robots-tag": "" }],
			["another robots word", 401, { "x-robots-tag": "noindexed, nofollow" }],
			["no cache-control", 401, { "cache-control": "" }],
			["no no-transform", 401, { "cache-control": "private, no-cache" }],
			["a longer word", 401, { "cache-control": "private, no-transformed" }],
		])
			assert.equal(lockedSitePage(status, headers(extra)), false, label);
	});

	it("makes a made-up name that passes the name rule, a new one each run", () => {
		const names = new Set(Array.from({ length: 20 }, () => probeName()));
		assert.ok(names.size > 1);
		for (const name of names) {
			assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
			assert.ok(name.length >= 3 && name.length <= 48 - "--next".length, name);
			assert.ok(!name.includes("qorpera") && !name.endsWith("-preview"), name);
		}
		assert.equal(
			probeName(() => Buffer.from([0, 1, 254, 255])),
			"zz-check-0001feff",
		);
	});

	it("makes probe names whose own and next hosts the one host rule takes, as the migration writes the rule (1252's list)", () => {
		// The rule as migration 20260930756000 writes it: its one regex (qorpera_site_host_pattern, for qorpera.com), the
		// length, and the name rule (no qorpera, no -preview ending, none of its reserved names).
		const migration = readFileSync(
			new URL("../../supabase/migrations/20260930756000_site_hosts.sql", import.meta.url),
			"utf8",
		);
		assert.ok(
			migration.includes(
				String.raw`select '^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.' || replace(p_domain, '.', '\.') || '$'`,
			),
		);
		const pattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$/;
		const reserved = new Set(
			(
				/qorpera_site_reserved_names\(\) returns text[^\n]*\n\t-- 20260930756000\n\tselect '([a-z0-9 -]+)'::text/.exec(
					migration,
				)?.[1] ?? ""
			).split(" "),
		);
		assert.equal(reserved.size, 118);
		const rule = (host) => {
			const match = pattern.exec(host);
			const slug = match?.[1] ?? "";
			return match &&
				slug.length >= 3 &&
				slug.length <= 48 &&
				!slug.endsWith("-preview") &&
				!slug.includes("qorpera") &&
				!reserved.has(slug)
				? { slug, scope: match[2] ? "next" : "site" }
				: null;
		};
		// That rule gives every host of the one host list its verdict (a host as written; 1252 says what each means).
		const lines = readFileSync(
			new URL("../../supabase/tests/1252_site_hosts.test.sql", import.meta.url),
			"utf8",
		).split("\n");
		const begin = lines.findIndex((line) => line.trim() === "-- the one host list: begin");
		const end = lines.findIndex((line) => line.trim() === "-- the one host list: end");
		assert.ok(begin > 0 && end > begin + 50, "1252's one host list");
		for (const line of lines.slice(begin + 1, end)) {
			const entry = /^\s*\('([^']*)', '([^']*)', '(site|next|)', '(taken|name|shape|case|port|dot)'\),?$/.exec(line);
			assert.ok(entry, line);
			const [, host, slug, scope, verdict] = entry;
			assert.deepEqual(rule(host), verdict === "taken" ? { slug, scope } : null, host);
		}
		// --check's made-up names: their own host and next host are site hosts (the locked page answers them), every one.
		const names = [
			...Array.from({ length: 50 }, () => probeName()),
			probeName(() => Buffer.from([0, 0, 0, 0])),
			probeName(() => Buffer.from([255, 255, 255, 255])),
		];
		for (const name of names) {
			assert.deepEqual(rule(`${name}.qorpera.com`), { slug: name, scope: "site" }, name);
			assert.deepEqual(rule(`${name}--next.qorpera.com`), { slug: name, scope: "next" }, name);
		}
	});

	it("reads robots.txt's last group: only '*' and only Disallow: /", () => {
		assert.equal(lastGroupDisallowsAll("User-agent: *\nDisallow: /\n"), true);
		assert.equal(lastGroupDisallowsAll(`${MANAGED_ROBOTS}User-agent: *\nDisallow: /\n`), true);
		assert.equal(lastGroupDisallowsAll("# a comment\r\nuser-agent:*\r\ndisallow:/ # all\r\n\r\n"), true);
		for (const text of [
			"",
			"Disallow: /",
			MANAGED_ROBOTS,
			`${MANAGED_ROBOTS}User-agent: *\nAllow: /\n`,
			"User-agent: *\nAllow: /\n",
			"User-agent: *\nDisallow: /\nAllow: /\n",
			"User-agent: *\nDisallow: /private\n",
			"User-agent: *\nUser-agent: GPTBot\nDisallow: /\n",
			"User-agent: *\n",
			"User-agent: *\nDisallow: /\nUser-agent: GPTBot\n",
		])
			assert.equal(lastGroupDisallowsAll(text), false, JSON.stringify(text));
	});
});

describe("sites-route: the script", () => {
	it("dry-runs by default: reads only, and prints the plan without the token", async () => {
		const fake = cloudflare();
		const { code, output } = await run([], fake);
		assert.equal(code, 0);
		assert.deepEqual(new Set(fake.sent.map((call) => call.method)), new Set(["GET"]));
		assert.match(
			output,
			/ingress after:\n {2}sites\.qorpera\.com -> http:\/\/api-front:8080\n {2}api\.qorpera\.com -> http:\/\/api-front:8080\n {2}\*\.qorpera\.com -> http:\/\/api-front:8080\n {2}\* -> http_status:404/,
		);
		assert.match(output, /dns sites\.qorpera\.com: a proxied CNAME to .* is to be made/);
		assert.match(output, /dns \*\.qorpera\.com: a proxied CNAME to .* is to be made/);
		assert.match(output, /cache rule qorpera_app_links_no_cache: to be made \(with the zone's cache rules ruleset\)/);
		assert.match(output, /dry run: nothing changed/);
		assert.ok(!output.includes(TOKEN));
		assert.ok(
			fake.sent.every((call) => call.authorization === `Bearer ${TOKEN}` || call.url.startsWith(`https://${HOST}`)),
		);
	});

	it("applies once, then finds nothing to change, and checks", async () => {
		const fake = cloudflare();
		assert.equal((await run(["--apply"], fake)).code, 0);
		assert.deepEqual(fake.state.config.ingress, [SITES_RULE, API_RULE, APPS_RULE, CATCH_ALL]);
		assert.deepEqual(fake.state.config["warp-routing"], { enabled: false });
		assert.deepEqual(
			fake.state.records.map((record) => [record.name, record.type, record.content, record.proxied]),
			[
				[HOST, "CNAME", `${TUNNEL_ID}.cfargotunnel.com`, true],
				[APPS_HOST, "CNAME", `${TUNNEL_ID}.cfargotunnel.com`, true],
			],
		);
		// The cache rule, in a ruleset of the cache phase, before any app host has a name.
		assert.equal(fake.state.cacheRuleset.phase, "http_request_cache_settings");
		assert.equal(fake.state.cacheRuleset.kind, "zone");
		assert.deepEqual(fake.state.cacheRuleset.rules, [{ id: "r1", ...CACHE_RULE }]);
		const order = fake.sent
			.filter((call) => call.method !== "GET" && call.url.startsWith(API))
			.map((call) => call.url.slice(API.length));
		assert.ok(order.indexOf("/zones/zone1/rulesets") < order.indexOf("/zones/zone1/dns_records"), order.join(" "));
		const writes = fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length;
		const again = await run(["--apply"], fake);
		assert.equal(again.code, 0);
		assert.equal(
			fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length,
			writes,
			"a second apply writes nothing",
		);
		assert.match(again.output, /is there already/);
		const before = fake.sent.length;
		const check = await run(["--check"], fake);
		assert.equal(check.code, 0);
		assert.match(check.output, /\ncheck: PASS$/);
		// The check makes no change at Cloudflare (its one POST is the relay's probe, refused before anything).
		assert.equal(fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length, writes);
		// The site hosts: a made-up name's own and next host and its /rest/v1/ are site-serve's locked page; the API name
		// answers 404 for site-serve with that name forged. Nothing but Cloudflare's API ever gets the token.
		for (const line of [
			`site hosts, own host: https://${PROBE}.qorpera.com/: 401 ok`,
			`site hosts, next host: https://${PROBE}--next.qorpera.com/: 401 ok`,
			`site hosts, the API's path on a site host: https://${PROBE}.qorpera.com/rest/v1/: 401 ok`,
			`site hosts, site-serve on the API name, X-Forwarded-Host forged: https://api.qorpera.com/functions/v1/site-serve/: 404 ok`,
		])
			assert.ok(check.output.split("\n").includes(line), line);
		assert.ok(
			check.output
				.split("\n")
				.includes(
					"https://app.qorpera.com, the Sites page takes a site's own host (E1a): source e1a0000, marker 1 time(s) in 2 script(s)",
				),
		);
		const probes = fake.sent.slice(before).filter((call) => !call.url.startsWith(API));
		assert.equal(probes.length, 6 + 3 + 1);
		// GETs, but the relay's probe (a POST with another site's Origin, refused before anything); never the token.
		assert.ok(probes.every((call) => call.authorization === undefined));
		assert.deepEqual(
			probes.filter((call) => call.method !== "GET").map((call) => [call.method, call.url, call.origin]),
			[["POST", RELAY_PROBE_URL, "https://probe.example"]],
		);
		assert.deepEqual(
			probes.filter((call) => call.forwardedHost !== undefined).map((call) => [call.url, call.forwardedHost]),
			[[`https://${API_HOST}/functions/v1/site-serve/`, `${PROBE}.qorpera.com`]],
		);
	});

	it("fails the check while a site host is not site-serve's: the 404 of before, the API, a page served, no no-transform", async () => {
		const fake = cloudflare();
		await run(["--apply"], fake);
		const done = {
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			cacheRuleset: fake.state.cacheRuleset,
		};
		const html = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow, noarchive" };
		for (const [label, siteHost, line] of [
			// api-front before 5.1: its others host's empty 404.
			["envoy's 404", { status: 404, headers: {}, text: "" }, "own host"],
			// The front changed, the function not yet: the old site-serve's not-found page.
			[
				"the old site-serve",
				{ status: 404, headers: { ...html, "cache-control": "no-store" }, text: "<h1>" },
				"own host",
			],
			// The API behind a site host: Kong's key refusal.
			[
				"the API",
				(url) =>
					url.endsWith("/rest/v1/")
						? {
								status: 401,
								headers: { "content-type": "application/json" },
								text: '{"message":"No API key found"}',
							}
						: LOCKED,
				"the API's path on a site host",
			],
			["a page served", { status: 200, headers: { ...LOCKED.headers }, text: "<h1>shop</h1>" }, "own host"],
			[
				"no no-transform (D23)",
				{ status: 401, headers: { ...html, "cache-control": "no-store" }, text: "" },
				"own host",
			],
			[
				"not noindex",
				{ status: 401, headers: { ...LOCKED.headers, "x-robots-tag": "none-at-all" }, text: "" },
				"own host",
			],
			[
				"a next host served",
				(url) => (url.includes("--next.") ? { status: 200, headers: LOCKED.headers, text: "" } : LOCKED),
				"next host",
			],
		]) {
			const result = await run(["--check"], cloudflare({ ...done, siteHost }));
			assert.equal(result.code, 1, label);
			assert.match(result.output, /\ncheck: FAILED$/, label);
			assert.match(
				result.output,
				new RegExp(
					`site hosts, ${line}: [^\\n]*: \\d+ NOT site-serve's page for a site without a session \\(401, HTML, noindex, no-transform\\)`,
				),
				label,
			);
		}
		// The API name serving site-serve for a forged name.
		const served = await run(["--check"], cloudflare({ ...done, apiSite: LOCKED }));
		assert.equal(served.code, 1);
		assert.match(
			served.output,
			/site hosts, site-serve on the API name, X-Forwarded-Host forged: \S+: 401 NOT 404\n/,
		);
		// No answer at all.
		const gone = cloudflare({ ...done });
		const unreachable = async (input, init) => {
			if (String(input).includes(PROBE)) throw new TypeError("fetch failed");
			return gone.fetcher(input, init);
		};
		const lines = [];
		assert.equal(
			await main(["--check"], {
				env: { CF_API_TOKEN: TOKEN },
				fetcher: unreachable,
				log: (line) => lines.push(line),
				siteName: PROBE,
			}),
			1,
		);
		assert.ok(
			lines.includes(
				`site hosts, own host: https://${PROBE}.qorpera.com/: TypeError NOT site-serve's page for a site without a session (401, HTML, noindex, no-transform)`,
			),
		);
	});

	it("fails the check until the relay refuses a change from another site (P1): 403, never stored", async () => {
		const fake = cloudflare();
		await run(["--apply"], fake);
		const done = {
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			cacheRuleset: fake.state.cacheRuleset,
		};
		const live = cloudflare(done);
		const passed = await run(["--check"], live);
		assert.equal(passed.code, 0, passed.output);
		assert.match(passed.output, /\/forged-post-probe, a change from another site \(P1\): 403\n/);
		// One POST with another site's Origin: nothing a session or an app sees (the relay refuses it before the gate).
		assert.deepEqual(
			live.sent.filter((request) => request.url === RELAY_PROBE_URL),
			[
				{
					url: RELAY_PROBE_URL,
					method: "POST",
					body: "x=1",
					authorization: undefined,
					forwardedHost: undefined,
					origin: "https://probe.example",
				},
			],
		);
		for (const [label, relay] of [
			// Before P1 the relay passes it on to the gate: its password page.
			["the gate's password page", { status: 401, headers: { "cache-control": "no-store" }, text: "" }],
			["403 that may be kept", { status: 403, headers: { "cache-control": "private, no-cache" }, text: "" }],
			["403 with no Cache-Control", { status: 403, headers: {}, text: "" }],
			["the app's own answer", { status: 200, headers: {}, text: "ok" }],
		]) {
			const before = await run(["--check"], cloudflare({ ...done, relay }));
			assert.equal(before.code, 1, label);
			assert.match(before.output, /\(P1\): \d+: NOT refused \(403, no-store\)\n/, label);
			assert.match(before.output, /\ncheck: FAILED$/, label);
		}
	});

	it("fails the check until the live web takes a site's own host (E1a's marker)", async () => {
		const fake = cloudflare();
		await run(["--apply"], fake);
		const done = {
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			cacheRuleset: fake.state.cacheRuleset,
		};
		const before = await run(
			["--check"],
			cloudflare({ ...done, web: { ...WEB_LIVE, "build/main-A.js": "const bj=/^x$/;" } }),
		);
		assert.equal(before.code, 1);
		assert.match(before.output, /\(E1a\): source e1a0000, marker 0 time\(s\) in 2 script\(s\): NOT live\n/);
		assert.match(before.output, /\ncheck: FAILED$/);
		// In a chunk of its own, not the main script: found.
		const chunk = await run(["--check"], cloudflare({ ...done, web: { "build/chunk-C.js": `x=/${WEB_MARKER}/` } }));
		assert.equal(chunk.code, 0, chunk.output);
		// The deployment file unreadable: not live.
		const unread = await run(["--check"], cloudflare({ ...done, web: {} }));
		assert.match(unread.output, /\(E1a\): source e1a0000, marker 0 time\(s\) in 0 script\(s\): NOT live/);
		assert.equal(unread.code, 1);
		const none = await run(["--check"], cloudflare({ ...done, web: null }));
		assert.match(none.output, /\(E1a\): not read \(web-deployment\.json: 404\): NOT live\n/);
		assert.equal(none.code, 1);
	});

	it("reads robots.txt's last group, the origin's own file, not Cloudflare's groups before it", async () => {
		const fake = cloudflare();
		await run(["--apply"], fake);
		const done = {
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			cacheRuleset: fake.state.cacheRuleset,
		};
		const managed = await run(
			["--check"],
			cloudflare({ ...done, robots: { status: 200, text: `${MANAGED_ROBOTS}User-agent: *\nDisallow: /\n` } }),
		);
		assert.equal(managed.code, 0, managed.output);
		// The origin answered nothing of its own: Cloudflare's file alone holds Disallow lines, none for every crawler.
		const alone = await run(["--check"], cloudflare({ ...done, robots: { status: 200, text: MANAGED_ROBOTS } }));
		assert.equal(alone.code, 1);
		assert.match(alone.output, /robots\.txt: 200\n/);
	});

	it("fails the check before the rollout and when the public name does not answer", async () => {
		assert.equal((await run(["--check"], cloudflare())).code, 1);
		const fake = cloudflare();
		await run(["--apply"], fake);
		const done = {
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			cacheRuleset: fake.state.cacheRuleset,
		};
		assert.equal((await run(["--check"], cloudflare(done))).code, 0);
		const down = cloudflare({ ...done, robots: { status: 404, text: "" } });
		const result = await run(["--check"], down);
		assert.equal(result.code, 1);
		assert.match(result.output, /robots\.txt: 404/);
		const relayDown = cloudflare({ ...done, health: { status: 502, text: "" } });
		const noRelay = await run(["--check"], relayDown);
		assert.equal(noRelay.code, 1);
		assert.match(noRelay.output, /qorpera-health-preview\.qorpera\.com\/\.qorpera\/health: 502/);
		assert.match(noRelay.output, /check: FAILED/);
	});

	it("adds only what is missing on a tunnel that has the sites rule and record already", async () => {
		const sites = { id: "s1", name: HOST, type: "CNAME", content: `${TUNNEL_ID}.cfargotunnel.com`, proxied: true };
		const fake = cloudflare({ ingress: [SITES_RULE, API_RULE, CATCH_ALL], records: [sites] });
		assert.equal((await run(["--apply"], fake)).code, 0);
		assert.deepEqual(fake.state.config.ingress, [SITES_RULE, API_RULE, APPS_RULE, CATCH_ALL]);
		const posts = fake.sent
			.filter((call) => call.method === "POST" && call.url.endsWith("/dns_records"))
			.map((call) => JSON.parse(call.body).name);
		assert.deepEqual(posts, [APPS_HOST]);
		assert.equal((await run(["--check"], fake)).code, 0);
	});

	it("adds the cache rule to the zone's own cache rules, keeping theirs, and sets a changed one right", async () => {
		const theirs = {
			id: "x1",
			ref: "theirs",
			expression: '(http.host eq "www.qorpera.com")',
			action: "set_cache_settings",
			action_parameters: { cache: true },
		};
		const fake = cloudflare({
			cacheRuleset: { id: "rs9", kind: "zone", phase: "http_request_cache_settings", rules: [theirs] },
		});
		const dry = await run([], fake);
		assert.match(dry.output, /cache rule qorpera_app_links_no_cache: to be made\n/);
		assert.equal((await run(["--apply"], fake)).code, 0);
		assert.deepEqual(fake.state.cacheRuleset.rules, [theirs, { id: "r2", ...CACHE_RULE }]);
		// Someone switched it off, or made it cache: it is set right again, in place.
		Object.assign(fake.state.cacheRuleset.rules[1], { enabled: false, action_parameters: { cache: true } });
		const check = await run(["--check"], fake);
		assert.equal(check.code, 1);
		assert.match(check.output, /cache rule qorpera_app_links_no_cache: to be set right/);
		assert.equal((await run(["--apply"], fake)).code, 0);
		assert.deepEqual(fake.state.cacheRuleset.rules, [theirs, { id: "r2", ...CACHE_RULE }]);
		assert.ok(fake.sent.some((call) => call.method === "PATCH" && call.url.endsWith("/rulesets/rs9/rules/r2")));
		const writes = fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length;
		assert.equal((await run(["--check"], fake)).code, 0);
		await run(["--apply"], fake);
		assert.equal(fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length, writes);
	});

	it("makes everything else, and says so plainly, when the token may not touch Cache Rules; the check warns", async () => {
		for (const cacheAccess of ["none", "read"]) {
			const fake = cloudflare({ cacheAccess });
			const applied = await run(["--apply"], fake);
			assert.equal(applied.code, 0, cacheAccess);
			assert.match(
				applied.output,
				/cache rule: NOT MADE: the token may not read or write Cache Rules \(it needs Zone > Cache Rules: Edit on qorpera\.com\)\. Make the rule by hand: Caching > Cache Rules, when \(http\.host contains "-preview\.qorpera\.com"\), Bypass cache/,
			);
			assert.equal(fake.state.records.length, 2, cacheAccess);
			assert.deepEqual(fake.state.config.ingress, [SITES_RULE, API_RULE, APPS_RULE, CATCH_ALL]);
			assert.equal(fake.state.cacheRuleset, null);
			assert.ok(!applied.output.includes(TOKEN));
		}
		// Before the rollout the check fails for the rest; the cache rule's line says it was not readable.
		const before = await run(["--check"], cloudflare({ cacheAccess: "none" }));
		assert.equal(before.code, 1);
		assert.match(before.output, /cache rule: not readable: the token may not read or write Cache Rules/);
		assert.match(before.output, /\ncheck: FAILED$/);
		// After it, with the rule made by hand: a warning in the result, never a silent pass, and not a failure alone.
		const fake = cloudflare({ cacheAccess: "none" });
		await run(["--apply"], fake);
		const check = await run(["--check"], fake);
		assert.equal(check.code, 0, check.output);
		assert.match(check.output, /cache rule: not readable: the token may not read or write Cache Rules/);
		assert.match(check.output, /\ncheck: PASS, with a warning: the cache rule was not readable$/);
		// A warning hides no failure.
		const down = cloudflare({
			cacheAccess: "none",
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			siteHost: { status: 404, headers: {}, text: "" },
		});
		const failed = await run(["--check"], down);
		assert.equal(failed.code, 1);
		assert.match(failed.output, /\ncheck: FAILED$/);
		// A token that may read Cache Rules and finds the rule: no warning.
		const read = cloudflare({
			cacheAccess: "read",
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			cacheRuleset: {
				id: "rs1",
				kind: "zone",
				phase: "http_request_cache_settings",
				rules: [{ id: "r1", ...CACHE_RULE }],
			},
		});
		assert.match((await run(["--check"], read)).output, /\ncheck: PASS$/);
	});

	it("changes nothing when another record holds *", async () => {
		const fake = cloudflare({
			records: [{ id: "x", name: APPS_HOST, type: "CNAME", content: "elsewhere.example", proxied: true }],
		});
		await assert.rejects(run(["--apply"], fake), /\*\.qorpera\.com already has 1 other DNS record/);
		assert.equal(fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length, 0);
	});

	it("changes nothing when another record holds the name", async () => {
		const fake = cloudflare({ records: [{ id: "x", name: HOST, type: "A", content: "192.0.2.1", proxied: true }] });
		await assert.rejects(run(["--apply"], fake), /other DNS record/);
		assert.equal(fake.sent.filter((call) => call.method !== "GET" && call.url.startsWith(API)).length, 0);
	});

	it("keeps the token out of errors, and refuses unknown arguments", async () => {
		const cf = new Cloudflare(TOKEN, cloudflare().fetcher);
		await assert.rejects(cf.call("GET", "/nowhere"), (error) => {
			assert.ok(!error.message.includes(TOKEN), error.message);
			assert.match(error.message, /GET \/nowhere failed: 7003 no route <token>/);
			return true;
		});
		await assert.rejects(run(["--apply", "--check"], cloudflare()), /Usage/);
		await assert.rejects(run(["--force"], cloudflare()), /Usage/);
	});

	it("reads the token from the environment, else from the Keychain item, never from a command line", () => {
		assert.equal(readToken({ CF_API_TOKEN: ` ${TOKEN} ` }), TOKEN);
		const calls = [];
		const spawn = (command, args) => {
			calls.push([command, args]);
			return { status: 0, stdout: `${TOKEN}\n` };
		};
		assert.equal(readToken({}, spawn), TOKEN);
		assert.deepEqual(calls, [
			["/usr/bin/security", ["find-generic-password", "-s", "com.qorpera.dbhome.cf-token", "-w"]],
		]);
		assert.throws(() => readToken({}, () => ({ status: 44, stdout: "" })), /Keychain item/);
		assert.throws(() => new Cloudflare("short"), /missing or malformed/);
	});
});
