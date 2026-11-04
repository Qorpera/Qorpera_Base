#!/usr/bin/env node
/* Company sites' and private app links' public names (rollout steps; the feature PR's "Rollout" and
 * APP-PREVIEW.md, section 4). Runs on the operator's Mac.
 *
 * Gives https://sites.qorpera.com/ and https://<slug>-preview.qorpera.com/ a way in through the self-hosted API's
 * Cloudflare tunnel `qorpera-dbhome` (remotely managed: its routes live in Cloudflare):
 *  - the ingress rule sites.qorpera.com -> http://api-front:8080, first (so no wildcard rule can shadow it), and the
 *    rule *.qorpera.com -> http://api-front:8080 after the exact rules, before the catch-all, every other rule kept
 *    exactly;
 *  - in the qorpera.com zone, a proxied CNAME sites and a proxied CNAME * -> <tunnel id>.cfargotunnel.com, so
 *    Cloudflare's Universal SSL (qorpera.com and *.qorpera.com) covers them. A name with its own record (api, app, ...)
 *    keeps it: a wildcard only answers for names that have none;
 *  - a Cache Rule (the zone's http_request_cache_settings phase, our rule found by its ref) that never caches an app
 *    host, made before the DNS records: Cloudflare's cache sits in front of the password, so nothing an app answers may
 *    be kept there. The relay's own `cdn-cache-control: no-store` on every forwarded answer is the first layer.
 * api-front (envoy-front-sites.yaml) then sends sites.qorpera.com to the site-serve function, *-preview.qorpera.com to
 * the app relay, and answers 404 for every other name under qorpera.com.
 *
 *   node deploy/sites/sites-route.mjs           dry run: reads, prints the plan (names, ids, the ingress before and
 *                                              after, the cache rule), changes nothing
 *   node deploy/sites/sites-route.mjs --apply   makes the changes; safe to run again (it changes only what differs)
 *   node deploy/sites/sites-route.mjs --check   read-only: the DNS records, the ingress rules, the cache rule, an
 *                                              HTTPS GET of https://sites.qorpera.com/robots.txt and one of an app
 *                                              host's /.qorpera/health; exit 1 unless all hold
 *
 * The token: CF_API_TOKEN, else the Mac Keychain item com.qorpera.dbhome.cf-token (Tunnel, Pages and DNS edit on
 * qorpera.com, and Cache Rules edit for the cache rule), read with `security`. It is never printed, never put on a
 * command line and never in an error. A token without Cache Rules permission: --apply makes everything else and says
 * plainly that the cache rule was not made (and how to make it by hand); --check says it could not check it, and fails.
 * It refuses, changing nothing, when another rule or record already holds a name (sites, or *). Note: the DB move's
 * `cf.py tunnel-ensure` writes the tunnel's whole ingress (api only); run this again after it. */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const API = "https://api.cloudflare.com/client/v4";
export const ZONE = "qorpera.com";
export const TUNNEL = "qorpera-dbhome";
export const HOST = "sites.qorpera.com";
export const SERVICE = "http://api-front:8080";
/** App links' names: the tunnel rule's hostname and the wildcard DNS record's name. */
export const APPS_HOST = "*.qorpera.com";
/** An app host's health, which the relay answers on every app host (no slug needs to exist). */
export const APP_HEALTH_URL = "https://qorpera-health-preview.qorpera.com/.qorpera/health";
export const CACHE_PHASE = "http_request_cache_settings";
/** The app links' cache rule: every app host bypasses Cloudflare's cache. `contains` (every plan has it) on the
 * suffix: inside the zone only <slug>-preview.qorpera.com names hold it. */
export const CACHE_RULE = Object.freeze({
	ref: "qorpera_app_links_no_cache",
	description: "App links (*-preview.qorpera.com): never cached (deploy/sites/sites-route.mjs)",
	expression: '(http.host contains "-preview.qorpera.com")',
	action: "set_cache_settings",
	action_parameters: { cache: false },
	enabled: true,
});
const CACHE_DENIED =
	"the token may not read or write Cache Rules (it needs Zone > Cache Rules: Edit on qorpera.com). Make the rule by " +
	`hand: Caching > Cache Rules, when ${CACHE_RULE.expression}, Bypass cache`;
const KEYCHAIN_ITEM = "com.qorpera.dbhome.cf-token";

/** A rule that matches everything: no hostname and no path. */
function catchAll(rule) {
	return Boolean(rule) && typeof rule === "object" && rule.hostname === undefined && rule.path === undefined;
}

/** The tunnel's configuration with the sites rule first, every other key and rule as they were. Throws
 * when the ingress has no catch-all last, or another rule already holds the name. */
export function withSitesIngress(config) {
	if (!config || typeof config !== "object" || !Array.isArray(config.ingress) || !catchAll(config.ingress.at(-1)))
		throw new Error("The tunnel's ingress does not end with a catch-all rule; nothing changed");
	const held = config.ingress.filter((rule) => rule?.hostname === HOST);
	if (held.length === 1 && held[0].service === SERVICE && held[0].path === undefined)
		return { config, changed: false };
	if (held.length > 0) throw new Error(`Another ingress rule already holds ${HOST}; nothing changed`);
	// First: a wildcard rule earlier in the list (*.qorpera.com) can never take the name from it.
	const ingress = [{ hostname: HOST, service: SERVICE }, ...config.ingress];
	return { config: { ...config, ingress }, changed: true };
}

/** The tunnel's configuration with the app links' wildcard rule after the exact rules, before the catch-all, every
 * other key and rule as they were. Throws when the ingress has no catch-all last, or another rule already holds it. */
export function withAppsIngress(config) {
	if (!config || typeof config !== "object" || !Array.isArray(config.ingress) || !catchAll(config.ingress.at(-1)))
		throw new Error("The tunnel's ingress does not end with a catch-all rule; nothing changed");
	const held = config.ingress.filter((rule) => rule?.hostname === APPS_HOST);
	if (held.length === 1 && held[0].service === SERVICE && held[0].path === undefined)
		return { config, changed: false };
	if (held.length > 0) throw new Error(`Another ingress rule already holds ${APPS_HOST}; nothing changed`);
	const ingress = [...config.ingress.slice(0, -1), { hostname: APPS_HOST, service: SERVICE }, config.ingress.at(-1)];
	return { config: { ...config, ingress }, changed: true };
}

const DNS_COMMENTS = {
	[HOST]: "Company sites: the self-hosted API's tunnel (deploy/sites/sites-route.mjs)",
	[APPS_HOST]: "App links (*-preview): the self-hosted API's tunnel (deploy/sites/sites-route.mjs)",
};

/** What a DNS name (sites, or the wildcard) needs: nothing, a new proxied CNAME, or proxying switched on. Throws when
 * another record holds it. */
export function dnsPlan(records, tunnelId, name = HOST) {
	const content = `${tunnelId}.cfargotunnel.com`;
	if (!Array.isArray(records)) throw new Error("The DNS listing is invalid");
	if (records.length === 0)
		return { action: "create", body: { type: "CNAME", name, content, proxied: true, comment: DNS_COMMENTS[name] } };
	const [record] = records;
	if (records.length !== 1 || record.type !== "CNAME" || record.content !== content)
		throw new Error(`${name} already has ${records.length} other DNS record(s); nothing changed there`);
	return record.proxied === true
		? { action: "none", id: record.id }
		: { action: "proxy", id: record.id, body: { proxied: true } };
}

/** The ingress as lines: hostname, path, service. No secrets live there. */
export function describeIngress(ingress) {
	return ingress.map(
		(rule) => `${rule.hostname ?? "*"}${rule.path ? ` path ${rule.path}` : ""} -> ${rule.service ?? "?"}`,
	);
}

/** A refused Cloudflare call: its HTTP status and Cloudflare's error codes ride along. */
export class CloudflareError extends Error {
	constructor(message, status, codes) {
		super(message);
		this.status = status;
		this.codes = codes;
	}
}

/** Whether a refusal is the token's permissions. */
function denied(error) {
	return (
		error instanceof CloudflareError && (error.status === 401 || error.status === 403 || error.codes.includes(10000))
	);
}

/** The Cloudflare API with the token as the bearer. An error names the method, the path and Cloudflare's codes; the
 * token is taken out of anything it says. */
export class Cloudflare {
	#token;
	#fetch;
	constructor(token, fetcher = fetch) {
		if (typeof token !== "string" || token.length < 20 || /\s/.test(token))
			throw new Error("The Cloudflare token is missing or malformed");
		this.#token = token;
		this.#fetch = fetcher;
	}

	#clean(text) {
		return String(text).split(this.#token).join("<token>");
	}

	async call(method, path, body) {
		let response;
		try {
			response = await this.#fetch(`${API}${path}`, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(60_000),
				headers: {
					authorization: `Bearer ${this.#token}`,
					"content-type": "application/json",
					"user-agent": "qorpera-sites-route/1",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			throw new Error(
				this.#clean(`${method} ${path.split("?")[0]} failed: ${error instanceof Error ? error.message : error}`),
			);
		}
		let answer;
		try {
			answer = await response.json();
		} catch {
			answer = { success: false, errors: [{ code: response.status, message: `HTTP ${response.status}` }] };
		}
		if (!answer?.success) {
			const errors = (answer?.errors ?? [])
				.map((item) => `${item?.code} ${String(item?.message).slice(0, 120)}`)
				.join("; ");
			throw new CloudflareError(
				this.#clean(`${method} ${path.split("?")[0]} failed: ${errors || `HTTP ${response.status}`}`),
				response.status,
				(answer?.errors ?? []).map((item) => item?.code),
			);
		}
		return answer.result;
	}
}

/** Whether our cache rule is there as it must be. */
function cacheRuleHolds(rule) {
	return (
		rule.expression === CACHE_RULE.expression &&
		rule.action === CACHE_RULE.action &&
		rule.action_parameters?.cache === false &&
		rule.enabled !== false
	);
}

/** What the cache rule needs: nothing, a new entrypoint ruleset holding it, the rule added to the zone's, the rule set
 * right again, or "unknown" when the token may not read Cache Rules. */
export async function cachePlan(cf, zoneId) {
	let ruleset;
	try {
		ruleset = await cf.call("GET", `/zones/${zoneId}/rulesets/phases/${CACHE_PHASE}/entrypoint`);
	} catch (error) {
		if (error instanceof CloudflareError && error.status === 404) return { action: "create-ruleset" };
		if (denied(error)) return { action: "unknown", reason: CACHE_DENIED };
		throw error;
	}
	const rules = Array.isArray(ruleset?.rules) ? ruleset.rules : [];
	const ours = rules.find((rule) => rule?.ref === CACHE_RULE.ref);
	if (!ours) return { action: "add", rulesetId: ruleset.id };
	return { action: cacheRuleHolds(ours) ? "none" : "update", rulesetId: ruleset.id, ruleId: ours.id };
}

/** Makes the cache rule; a token that may not is said plainly, and the rest goes on. */
export async function applyCache(cf, zoneId, cache) {
	try {
		if (cache.action === "create-ruleset")
			await cf.call("POST", `/zones/${zoneId}/rulesets`, {
				name: "default",
				description: "Cache rules",
				kind: "zone",
				phase: CACHE_PHASE,
				rules: [CACHE_RULE],
			});
		if (cache.action === "add")
			await cf.call("POST", `/zones/${zoneId}/rulesets/${cache.rulesetId}/rules`, CACHE_RULE);
		if (cache.action === "update")
			await cf.call("PATCH", `/zones/${zoneId}/rulesets/${cache.rulesetId}/rules/${cache.ruleId}`, CACHE_RULE);
		return { made: cache.action !== "unknown", reason: cache.reason };
	} catch (error) {
		if (denied(error)) return { made: false, reason: CACHE_DENIED };
		throw error;
	}
}

/** Reads what the rollout touches and what it would change. */
export async function plan(cf) {
	const zones = await cf.call("GET", `/zones?name=${ZONE}`);
	if (!Array.isArray(zones) || zones.length !== 1 || !zones[0]?.account?.id)
		throw new Error(`Zone ${ZONE} is not visible to the token`);
	const zoneId = zones[0].id;
	const accountId = zones[0].account.id;
	const tunnels = await cf.call("GET", `/accounts/${accountId}/cfd_tunnel?name=${TUNNEL}&is_deleted=false`);
	if (!Array.isArray(tunnels) || tunnels.length !== 1)
		throw new Error(`Expected one tunnel named ${TUNNEL}, found ${tunnels?.length ?? 0}`);
	const tunnel = tunnels[0];
	const current = await cf.call("GET", `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`);
	const before = current?.config;
	const sites = withSitesIngress(before);
	const apps = withAppsIngress(sites.config);
	const records = await cf.call("GET", `/zones/${zoneId}/dns_records?name=${HOST}`);
	const wildcard = await cf.call("GET", `/zones/${zoneId}/dns_records?name=${APPS_HOST}`);
	return {
		zoneId,
		accountId,
		tunnel,
		before,
		after: apps.config,
		ingressChanged: sites.changed || apps.changed,
		dns: dnsPlan(records, tunnel.id, HOST),
		appsDns: dnsPlan(wildcard, tunnel.id, APPS_HOST),
		cache: await cachePlan(cf, zoneId),
	};
}

/** Makes the planned changes: the whole configuration back with the rules added, the cache rule (before any app host
 * has a name), then the DNS records. Says whether the cache rule was made. */
export async function apply(cf, planned) {
	if (planned.ingressChanged)
		await cf.call("PUT", `/accounts/${planned.accountId}/cfd_tunnel/${planned.tunnel.id}/configurations`, {
			config: planned.after,
		});
	const cache = await applyCache(cf, planned.zoneId, planned.cache);
	for (const dns of [planned.dns, planned.appsDns]) {
		if (dns.action === "create") await cf.call("POST", `/zones/${planned.zoneId}/dns_records`, dns.body);
		if (dns.action === "proxy") await cf.call("PATCH", `/zones/${planned.zoneId}/dns_records/${dns.id}`, dns.body);
	}
	return { cache };
}

/** The public name answers: robots.txt from the site-serve function, over HTTPS. */
export async function robotsAnswer(fetcher = fetch) {
	try {
		const response = await fetcher(`https://${HOST}/robots.txt`, {
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		return { ok: response.status === 200 && /Disallow: \//.test(text), status: response.status };
	} catch (error) {
		return { ok: false, status: error instanceof Error ? error.name : "error" };
	}
}

/** An app host answers: the app relay's health, over HTTPS (through the wildcard name, rule and the apps host). */
export async function appHealthAnswer(fetcher = fetch) {
	try {
		const response = await fetcher(APP_HEALTH_URL, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
		const text = await response.text();
		return { ok: response.status === 200 && text.trim() === "ok", status: response.status };
	} catch (error) {
		return { ok: false, status: error instanceof Error ? error.name : "error" };
	}
}

/** The token: CF_API_TOKEN, else the Keychain item, read by `security` (the value only on its stdout). */
export function readToken(env = process.env, spawn = spawnSync) {
	if (env.CF_API_TOKEN?.trim()) return env.CF_API_TOKEN.trim();
	const result = spawn("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_ITEM, "-w"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const token = result.status === 0 ? String(result.stdout ?? "").trim() : "";
	if (!token) throw new Error(`No CF_API_TOKEN and no Keychain item ${KEYCHAIN_ITEM}`);
	return token;
}

export async function main(argv, { env = process.env, fetcher = fetch, log = console.log, spawn = spawnSync } = {}) {
	const modes = argv.filter((item) => ["--apply", "--check"].includes(item));
	if (modes.length > 1 || argv.some((item) => !["--apply", "--check"].includes(item)))
		throw new Error("Usage: sites-route.mjs [--apply | --check]");
	const mode = modes[0]?.slice(2) ?? "dry-run";
	const cf = new Cloudflare(readToken(env, spawn), fetcher);
	const planned = await plan(cf);
	log(`zone ${ZONE}: ${planned.zoneId}; account ${planned.accountId}; tunnel ${TUNNEL}: ${planned.tunnel.id}`);
	log(`ingress now:\n  ${describeIngress(planned.before.ingress).join("\n  ")}`);
	log(
		planned.ingressChanged
			? `ingress after:\n  ${describeIngress(planned.after.ingress).join("\n  ")}`
			: `ingress: ${HOST} and ${APPS_HOST} -> ${SERVICE} are there already`,
	);
	for (const [name, dns] of [
		[HOST, planned.dns],
		[APPS_HOST, planned.appsDns],
	])
		log(
			dns.action === "create"
				? `dns ${name}: a proxied CNAME to ${planned.tunnel.id}.cfargotunnel.com is to be made`
				: dns.action === "proxy"
					? `dns ${name}: the CNAME to this tunnel is to be proxied`
					: `dns ${name}: the proxied CNAME to this tunnel is there already`,
		);
	const cache = planned.cache;
	log(
		cache.action === "unknown"
			? `cache rule: not checked: ${cache.reason}`
			: cache.action === "none"
				? `cache rule ${CACHE_RULE.ref}: there already (${CACHE_RULE.expression}: bypass)`
				: `cache rule ${CACHE_RULE.ref}: to be ${cache.action === "update" ? "set right" : "made"}${cache.action === "create-ruleset" ? " (with the zone's cache rules ruleset)" : ""}`,
	);
	if (mode === "check") {
		const robots = await robotsAnswer(fetcher);
		log(`https://${HOST}/robots.txt: ${robots.status}`);
		const health = await appHealthAnswer(fetcher);
		log(`${APP_HEALTH_URL}: ${health.status}`);
		const ok =
			!planned.ingressChanged &&
			planned.dns.action === "none" &&
			planned.appsDns.action === "none" &&
			cache.action === "none" &&
			robots.ok &&
			health.ok;
		log(`check: ${ok ? "PASS" : "FAILED"}`);
		return ok ? 0 : 1;
	}
	if (mode === "dry-run") {
		log("dry run: nothing changed (--apply makes the changes)");
		return 0;
	}
	const applied = await apply(cf, planned);
	if (!applied.cache.made) log(`cache rule: NOT MADE: ${applied.cache.reason}`);
	log(
		`applied: ingress ${planned.ingressChanged ? "changed" : "unchanged"}; cache rule ${applied.cache.made ? cache.action : "not made"}; dns ${HOST} ${planned.dns.action}, ${APPS_HOST} ${planned.appsDns.action}`,
	);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(`sites-route: ${error instanceof Error ? error.message : "failed"}`);
			process.exit(1);
		},
	);
