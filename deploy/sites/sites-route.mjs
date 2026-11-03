#!/usr/bin/env node
/* Company sites' public name (rollout step; the feature PR's "Rollout"). Runs on the operator's Mac.
 *
 * Gives https://sites.qorpera.com/ a way in: the self-hosted API's Cloudflare tunnel `qorpera-dbhome` (remotely
 * managed: its routes live in Cloudflare) gets the ingress rule sites.qorpera.com -> http://api-front:8080, before its
 * catch-all, with every other rule kept exactly; and the qorpera.com zone gets a proxied CNAME sites ->
 * <tunnel id>.cfargotunnel.com, so Cloudflare's Universal SSL (qorpera.com and *.qorpera.com) covers it. api-front's
 * `sites` virtual host (envoy-front-sites.yaml) then sends every path to the site-serve function.
 *
 *   node deploy/sites/sites-route.mjs           dry run: reads, prints the plan (names, ids, the ingress before and
 *                                              after), changes nothing
 *   node deploy/sites/sites-route.mjs --apply   makes the changes; safe to run again (it changes only what differs)
 *   node deploy/sites/sites-route.mjs --check   read-only: the DNS record, the ingress rule and an HTTPS GET of
 *                                              https://sites.qorpera.com/robots.txt; exit 1 unless all three hold
 *
 * The token: CF_API_TOKEN, else the Mac Keychain item com.qorpera.dbhome.cf-token (Tunnel, Pages and DNS edit on
 * qorpera.com), read with `security`. It is never printed, never put on a command line and never in an error.
 * It refuses, changing nothing, when another rule or record already holds the name. Note: the DB move's
 * `cf.py tunnel-ensure` writes the tunnel's whole ingress (api only); run this again after it. */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const API = "https://api.cloudflare.com/client/v4";
export const ZONE = "qorpera.com";
export const TUNNEL = "qorpera-dbhome";
export const HOST = "sites.qorpera.com";
export const SERVICE = "http://api-front:8080";
const KEYCHAIN_ITEM = "com.qorpera.dbhome.cf-token";

/** A rule that matches everything: no hostname and no path. */
function catchAll(rule) {
	return Boolean(rule) && typeof rule === "object" && rule.hostname === undefined && rule.path === undefined;
}

/** The tunnel's configuration with the sites rule before its catch-all, every other key and rule as they were. Throws
 * when the ingress has no catch-all last, or another rule already holds the name. */
export function withSitesIngress(config) {
	if (!config || typeof config !== "object" || !Array.isArray(config.ingress) || !catchAll(config.ingress.at(-1)))
		throw new Error("The tunnel's ingress does not end with a catch-all rule; nothing changed");
	const held = config.ingress.filter((rule) => rule?.hostname === HOST);
	if (held.length === 1 && held[0].service === SERVICE && held[0].path === undefined)
		return { config, changed: false };
	if (held.length > 0) throw new Error(`Another ingress rule already holds ${HOST}; nothing changed`);
	const ingress = [...config.ingress.slice(0, -1), { hostname: HOST, service: SERVICE }, config.ingress.at(-1)];
	return { config: { ...config, ingress }, changed: true };
}

/** What the DNS name needs: nothing, a new proxied CNAME, or proxying switched on. Throws when another record holds it. */
export function dnsPlan(records, tunnelId) {
	const content = `${tunnelId}.cfargotunnel.com`;
	if (!Array.isArray(records)) throw new Error("The DNS listing is invalid");
	if (records.length === 0)
		return {
			action: "create",
			body: {
				type: "CNAME",
				name: HOST,
				content,
				proxied: true,
				comment: "Company sites: the self-hosted API's tunnel (deploy/sites/sites-route.mjs)",
			},
		};
	const [record] = records;
	if (records.length !== 1 || record.type !== "CNAME" || record.content !== content)
		throw new Error(`${HOST} already has ${records.length} other DNS record(s); nothing changed there`);
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
			throw new Error(this.#clean(`${method} ${path.split("?")[0]} failed: ${errors || `HTTP ${response.status}`}`));
		}
		return answer.result;
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
	const ingress = withSitesIngress(before);
	const records = await cf.call("GET", `/zones/${zoneId}/dns_records?name=${HOST}`);
	return {
		zoneId,
		accountId,
		tunnel,
		before,
		after: ingress.config,
		ingressChanged: ingress.changed,
		dns: dnsPlan(records, tunnel.id),
	};
}

/** Makes the planned changes: the whole configuration back with the one rule added, then the DNS record. */
export async function apply(cf, planned) {
	if (planned.ingressChanged)
		await cf.call("PUT", `/accounts/${planned.accountId}/cfd_tunnel/${planned.tunnel.id}/configurations`, {
			config: planned.after,
		});
	if (planned.dns.action === "create") await cf.call("POST", `/zones/${planned.zoneId}/dns_records`, planned.dns.body);
	if (planned.dns.action === "proxy")
		await cf.call("PATCH", `/zones/${planned.zoneId}/dns_records/${planned.dns.id}`, planned.dns.body);
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
			: `ingress: ${HOST} -> ${SERVICE} is there already`,
	);
	log(
		planned.dns.action === "create"
			? `dns ${HOST}: a proxied CNAME to ${planned.tunnel.id}.cfargotunnel.com is to be made`
			: planned.dns.action === "proxy"
				? `dns ${HOST}: the CNAME to this tunnel is to be proxied`
				: `dns ${HOST}: the proxied CNAME to this tunnel is there already`,
	);
	if (mode === "check") {
		const robots = await robotsAnswer(fetcher);
		log(`https://${HOST}/robots.txt: ${robots.status}`);
		const ok = !planned.ingressChanged && planned.dns.action === "none" && robots.ok;
		log(`check: ${ok ? "PASS" : "FAILED"}`);
		return ok ? 0 : 1;
	}
	if (mode === "dry-run") {
		log("dry run: nothing changed (--apply makes the changes)");
		return 0;
	}
	await apply(cf, planned);
	log(`applied: ingress ${planned.ingressChanged ? "changed" : "unchanged"}; dns ${planned.dns.action}`);
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
