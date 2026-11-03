import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	API,
	APP_HEALTH_URL,
	APPS_HOST,
	Cloudflare,
	describeIngress,
	dnsPlan,
	HOST,
	main,
	readToken,
	SERVICE,
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

/** A fake Cloudflare: the zone, the tunnel, its configuration and the DNS records (listed by name), as the API answers
 * them; and the two public answers --check reads. */
function cloudflare({
	ingress = [API_RULE, CATCH_ALL],
	records = [],
	robots = { status: 200, text: "User-agent: *\nDisallow: /\n" },
	health = { status: 200, text: "ok\n" },
} = {}) {
	const state = {
		config: { ingress, "warp-routing": { enabled: false } },
		records: records.map((record) => ({ ...record })),
	};
	const sent = [];
	const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
	const fetcher = async (input, init = {}) => {
		const url = String(input);
		sent.push({ url, method: init.method ?? "GET", body: init.body, authorization: init.headers?.authorization });
		if (url === `https://${HOST}/robots.txt`) return new Response(robots.text, { status: robots.status });
		if (url === APP_HEALTH_URL) return new Response(health.text, { status: health.status });
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
	const code = await main(argv, { env, fetcher: fake.fetcher, log: (line) => lines.push(line) });
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
		const writes = fake.sent.filter((call) => call.method !== "GET").length;
		const again = await run(["--apply"], fake);
		assert.equal(again.code, 0);
		assert.equal(fake.sent.filter((call) => call.method !== "GET").length, writes, "a second apply writes nothing");
		assert.match(again.output, /is there already/);
		const check = await run(["--check"], fake);
		assert.equal(check.code, 0);
		assert.match(check.output, /check: PASS/);
		// The check makes no change.
		assert.equal(fake.sent.filter((call) => call.method !== "GET").length, writes);
	});

	it("fails the check before the rollout and when the public name does not answer", async () => {
		assert.equal((await run(["--check"], cloudflare())).code, 1);
		const fake = cloudflare();
		await run(["--apply"], fake);
		const down = cloudflare({
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			robots: { status: 404, text: "" },
		});
		const result = await run(["--check"], down);
		assert.equal(result.code, 1);
		assert.match(result.output, /robots\.txt: 404/);
		const relayDown = cloudflare({
			ingress: fake.state.config.ingress,
			records: fake.state.records,
			health: { status: 502, text: "" },
		});
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
		const posts = fake.sent.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body).name);
		assert.deepEqual(posts, [APPS_HOST]);
		assert.equal((await run(["--check"], fake)).code, 0);
	});

	it("changes nothing when another record holds *", async () => {
		const fake = cloudflare({
			records: [{ id: "x", name: APPS_HOST, type: "CNAME", content: "elsewhere.example", proxied: true }],
		});
		await assert.rejects(run(["--apply"], fake), /\*\.qorpera\.com already has 1 other DNS record/);
		assert.equal(fake.sent.filter((call) => call.method !== "GET").length, 0);
	});

	it("changes nothing when another record holds the name", async () => {
		const fake = cloudflare({ records: [{ id: "x", name: HOST, type: "A", content: "192.0.2.1", proxied: true }] });
		await assert.rejects(run(["--apply"], fake), /other DNS record/);
		assert.equal(fake.sent.filter((call) => call.method !== "GET").length, 0);
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
