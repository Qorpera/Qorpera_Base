import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DEFAULT_CLOUD_CONFIG, cloudConnectSources, parseCloudConfig } from "../src/cloud/deployment-config.ts";

export function prepareDeployment({ configPath, configJson, release = false, serve = false, headersTemplate }) {
	if (release && serve) throw new Error("A release build cannot use the development server");
	if (configPath !== undefined && configJson !== undefined) throw new Error("Choose QORPERA_WEB_CONFIG or QORPERA_WEB_CONFIG_JSON, not both");
	if (release && configPath === undefined && configJson === undefined) throw new Error("A release build requires QORPERA_WEB_CONFIG or QORPERA_WEB_CONFIG_JSON");
	if (configJson !== undefined && (typeof configJson !== "string" || Buffer.byteLength(configJson, "utf8") > 8192))
		throw new Error("Public cloud configuration must contain at most 8192 UTF8 bytes");
	if (configPath && (!statSync(configPath).isFile() || statSync(configPath).size > 8192))
		throw new Error("Public cloud configuration must be a file of at most 8192 bytes");
	const configured = configPath !== undefined || configJson !== undefined;
	const source = configPath !== undefined ? readFileSync(configPath, "utf8") : configJson;
	const config = parseCloudConfig(configured ? JSON.parse(source) : DEFAULT_CLOUD_CONFIG, release);
	const marker = "__QORPERA_WEB_CONNECT_SRC__";
	if (headersTemplate.split(marker).length !== 2) throw new Error("Expected one connect-src marker in the header template");
	const headers = headersTemplate.replace(marker, cloudConnectSources(config));
	return {
		config,
		headers,
		notFoundPages: longCachedDirectories(headers).map(directory => `${directory}/404.html`),
		define: {
			__QORPERA_WEB_CLOUD_CONFIG__: JSON.stringify(config),
		},
		manifest: {
			schema: "qorpera.web-deployment/v1",
			release,
			config,
			// Kept for deploy checks that read it: no build takes endpoints from the browser.
			configOverrideAllowed: false,
			headersSha256: createHash("sha256").update(headers).digest("hex"),
		},
	};
}

// Pages answers a missing file with the app's index.html (200, text/html) and
// gives it the path's _headers, so a request that reached an edge before a new
// file did was kept as HTML for the rule's whole max-age (2026-09-25: the
// stylesheet under /build/*, an unstyled app). With a 404.html in the file's
// directory, Pages answers 404 instead and replaces any Cache-Control with
// no-store. Returns every directory a rule lets caches keep, for that page.
// Pages leaves other caching headers on a 404, and the edge obeys
// CDN-Cache-Control over Cache-Control, so those are refused outright.
export function longCachedDirectories(headers) {
	const directories = new Set();
	let rule;
	for (const line of headers.split(/\r?\n/)) {
		if (/^\s*(#|$)/.test(line)) continue;
		if (!/^\s/.test(line)) {
			rule = line.trim();
			continue;
		}
		const [, name = "", value = ""] = line.match(/^\s+([^:\s]+)\s*:(.*)$/) ?? [];
		if (/^(?:(?:cloudflare-)?cdn-cache-control|surrogate-control|expires)$/i.test(name))
			throw new Error(`Pages keeps ${name} on a 404, so set Cache-Control instead: ${rule}`);
		if (!/^cache-control$/i.test(name) || !/\b(?:max-age|s-maxage)="?0*[1-9]/i.test(value)) continue;
		const directory = rule?.match(/^\/((?:[\w.-]+\/)*[\w.-]+)\/\*$/)?.[1];
		if (!directory || directory.split("/").some(part => /^\.+$/.test(part)))
			throw new Error(`A long-cached header rule must cover one directory, so a 404.html can guard it: ${rule}`);
		directories.add(directory);
	}
	return [...directories];
}
