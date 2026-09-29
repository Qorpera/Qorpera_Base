import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { DEFAULT_CLOUD_CONFIG, parseCloudConfig } from "../src/cloud/deployment-config.ts";
import { longCachedDirectories, prepareDeployment } from "./deployment.mjs";
// What the build splits main.js into, and what it preloads and checksums, is
// checked beside the deployment it ships in (keeps this change inside packages/web).
import "./bundle.test.mjs";

const headersTemplate = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const config = { ...DEFAULT_CLOUD_CONFIG, officeViewerOrigin: "wss://office.example.invalid:8443" };

function fixture(t, value = config) {
	const dir = mkdtempSync(join(tmpdir(), "qorpera-web-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, "public.json");
	writeFileSync(configPath, JSON.stringify(value));
	return { configPath, headersTemplate, release: true };
}

test("release configuration and CSP admit the same exact HTTPS/WSS origins", t => {
	const deployment = prepareDeployment(fixture(t));
	assert.deepEqual(deployment.config, config);
	assert.equal(deployment.manifest.configOverrideAllowed, false);
	const sources = deployment.headers.match(/; connect-src ([^;]+);/)[1].split(" ");
	assert.deepEqual(sources, ["'self'", config.projectUrl, config.projectUrl.replace("https:", "wss:"), config.objectGatewayUrl, config.officeViewerOrigin]);
	assert.equal(deployment.manifest.headersSha256, createHash("sha256").update(deployment.headers).digest("hex"));
	assert.ok(!deployment.headers.includes("__QORPERA"));
});

test("release rejects an absent config, absent viewer, or development server", t => {
	assert.throws(() => prepareDeployment({ headersTemplate, release: true }), /requires QORPERA_WEB_CONFIG/);
	assert.throws(() => prepareDeployment(fixture(t, DEFAULT_CLOUD_CONFIG)), /requires the office viewer/);
	assert.throws(() => prepareDeployment({ ...fixture(t), serve: true }), /development server/);
});

test("preview retains default origins without inventing a viewer", () => {
	const deployment = prepareDeployment({ headersTemplate });
	assert.deepEqual(deployment.config, DEFAULT_CLOUD_CONFIG);
	assert.equal(deployment.manifest.configOverrideAllowed, false);
	assert.equal(deployment.manifest.release, false);
	assert.ok(!deployment.headers.includes("office.example"));
});

test("config rejects credential fields, nonpublic keys and oversized documents", t => {
	assert.throws(() => prepareDeployment(fixture(t, { ...config, secretKey: "do-not-emit" })), /Unknown/);
	assert.throws(() => prepareDeployment(fixture(t, { ...config, publishableKey: "sb_secret_do-not-emit" })), /publishable key/);
	const input = fixture(t);
	writeFileSync(input.configPath, " ".repeat(8193));
	assert.throws(() => prepareDeployment(input), /8192/);
});

test("secure origin validation refuses CSP injection and ambiguous URL normalization", () => {
	for (const value of [
		"ws://viewer.invalid", "wss://user:password@viewer.invalid", "wss://viewer.invalid/path",
		"wss://viewer.invalid/?ticket=secret", "wss://viewer.invalid/#secret", "wss://*.invalid",
		"wss://viewer.invalid;", "wss://viewer.invalid 'unsafe-eval'", "wss://viewer.invalid\n",
		"wss://viewer.invalid/..", "wss://viewer.invalid\\", "wss:viewer.invalid", "wss://VIEWER.invalid",
	]) assert.throws(() => parseCloudConfig({ ...config, officeViewerOrigin: value }), undefined, value);
	assert.equal(parseCloudConfig({ ...config, officeViewerOrigin: `${config.officeViewerOrigin}/` }).officeViewerOrigin, config.officeViewerOrigin);
	for (const field of ["projectUrl", "objectGatewayUrl"])
		assert.throws(() => parseCloudConfig({ ...config, [field]: "http://unsafe.invalid" }));
});

test("header generation fails if the template drops or duplicates its binding", t => {
	const input = fixture(t);
	assert.throws(() => prepareDeployment({ ...input, headersTemplate: "connect-src *" }), /one connect-src marker/);
	assert.throws(() => prepareDeployment({ ...input, headersTemplate: headersTemplate + headersTemplate }), /one connect-src marker/);
});

test("explicit login bridge base is locked into configuration and matching CSP", t => {
	const nativeProviderLoginUrl = "https://login.example.invalid/functions/v1/native-provider-login/";
	const deployment = prepareDeployment(fixture(t, { ...config, nativeProviderLoginUrl }));
	assert.equal(deployment.config.nativeProviderLoginUrl, nativeProviderLoginUrl);
	assert.ok(deployment.headers.includes("https://login.example.invalid"));
	assert.ok(!deployment.headers.includes(nativeProviderLoginUrl));
	assert.equal(parseCloudConfig(config).nativeProviderLoginUrl, undefined);
	for (const value of [
		"http://login.invalid/", "https://user:secret@login.invalid/", "https://login.invalid/login",
		"https://login.invalid/?token=x", "https://login.invalid/#x", "https://login.invalid/a/../",
		"https://login.invalid/%2e%2e/", "https://LOGIN.invalid/", "https://login.invalid/ 'unsafe-eval'",
	]) assert.throws(() => parseCloudConfig({ ...config, nativeProviderLoginUrl: value }), undefined, value);
});

test("member gateway activation requires the exact configured project bridge", t => {
	const memberCompanyGatewayUrl = `${config.projectUrl}/functions/v1/member-company-gateway`;
	const deployment = prepareDeployment(fixture(t, { ...config, memberCompanyGatewayUrl }));
	assert.equal(deployment.config.memberCompanyGatewayUrl, memberCompanyGatewayUrl);
	assert.equal(deployment.manifest.config.memberCompanyGatewayUrl, memberCompanyGatewayUrl);
	assert.equal(parseCloudConfig(config).memberCompanyGatewayUrl, undefined);
	assert.equal(DEFAULT_CLOUD_CONFIG.memberCompanyGatewayUrl, undefined);
	for (const value of [
		"https://other-project.supabase.co/functions/v1/member-company-gateway",
		`${memberCompanyGatewayUrl}/`, `${memberCompanyGatewayUrl}?upstream=other`,
		`${config.projectUrl}/functions/v1/other`, "https://user:secret@project.invalid/",
		true, null, "",
	]) assert.throws(() => parseCloudConfig({ ...config, memberCompanyGatewayUrl: value }), /exact project member gateway/);
});

test("compiled builds use their own endpoints and never read browser storage", async t => {
	for (const [deployment, expected] of [
		[prepareDeployment(fixture(t)), config],
		[prepareDeployment({ headersTemplate }), DEFAULT_CLOUD_CONFIG],
	]) {
		const result = await build({
			entryPoints: [new URL("../src/cloud/config.ts", import.meta.url).pathname],
			bundle: true, platform: "browser", format: "iife", globalName: "clientConfig", write: false,
			define: deployment.define,
		});
		// A value saved by the old Settings form must not steer the build.
		const stale = JSON.stringify({ ...DEFAULT_CLOUD_CONFIG, projectUrl: "https://stale.example.invalid" });
		let reads = 0;
		const context = { URL, localStorage: { getItem() { reads++; return stale; } } };
		runInNewContext(result.outputFiles[0].text, context);
		assert.deepEqual(JSON.parse(JSON.stringify(context.clientConfig.resolveCloudConfig())), expected);
		assert.equal(reads, 0);
	}
});


test("Pages environment configuration binds release CSP without writing source files", () => {
 const configJson = JSON.stringify({ projectUrl: "https://project.example.invalid", publishableKey: "sb_publishable_fixture123", objectGatewayUrl: "https://objects.example.invalid", officeViewerOrigin: "wss://viewer.example.invalid:8443", nativeProviderLoginUrl: "https://project.example.invalid/functions/v1/native-provider-login/" });
 const deployment = prepareDeployment({ configJson, release: true, headersTemplate });
 assert.equal(deployment.manifest.release, true);
 assert.deepEqual(deployment.config, JSON.parse(configJson));
 assert.ok(deployment.headers.includes("wss://viewer.example.invalid:8443"));
 assert.throws(() => prepareDeployment({ configPath: "/missing/config.json", configJson, release: true, headersTemplate }), /not both/);
 for (const invalid of ["", "{", "null", JSON.stringify({ ...JSON.parse(configJson), serviceRoleKey: "forbidden" }), "é".repeat(4097)]) {
  assert.throws(() => prepareDeployment({ configJson: invalid, release: true, headersTemplate }));
 }
 assert.throws(() => prepareDeployment({ configJson: JSON.stringify({ ...JSON.parse(configJson), officeViewerOrigin: undefined }), release: true, headersTemplate }), /viewer/);
});

test("every long-cached directory gets a 404 page, so a missing file there is never kept as the app page", t => {
	assert.deepEqual(prepareDeployment(fixture(t)).notFoundPages, ["assets/404.html", "build/404.html"]);
	assert.deepEqual(prepareDeployment({ headersTemplate }).notFoundPages, ["assets/404.html", "build/404.html"]);
	const rules = (path, value, name = "Cache-Control") => `/*\n  ${name}: public, max-age=0, must-revalidate\n${path}\n  ! ${name}\n  ${name}: ${value}\n`;
	assert.deepEqual(longCachedDirectories(rules("/build/*", "public, max-age=31536000, immutable")), ["build"]);
	assert.deepEqual(longCachedDirectories(rules("/assets/avatars/*", "s-maxage=60")), ["assets/avatars"]);
	assert.deepEqual(longCachedDirectories(rules("/fonts/*", 'max-age="600"')), ["fonts"]);
	assert.deepEqual(longCachedDirectories("/build/*\n\tCache-Control : max-age=60\r\n"), ["build"]);
	// Pages ignores indentation: a header may start the line, and an indented path is still a rule.
	assert.deepEqual(longCachedDirectories("/build/*\nCache-Control: max-age=31536000\n"), ["build"]);
	assert.deepEqual(longCachedDirectories("/assets/*\n  Cache-Control: max-age=60\n  /build/*\n  Cache-Control: max-age=31536000\n"), ["assets", "build"]);
	assert.deepEqual(longCachedDirectories(rules("/build/*", "no-store")), []);
	assert.deepEqual(longCachedDirectories(rules("/build/*", "public, max-age=00, must-revalidate")), []);
	for (const path of ["/*", "/*.css", "/build/app.css", "/build/:name", "https://app.qorpera.com/build/*", "/../*", "/./*", "/build/../*"])
		assert.throws(() => longCachedDirectories(rules(path, "public, max-age=86400")), /must cover one directory/, path);
	// A 404 keeps these, and the edge obeys CDN-Cache-Control over the no-store Pages sets.
	for (const name of ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control", "Surrogate-Control", "Expires"])
		assert.throws(() => longCachedDirectories(`/build/*\n  ${name}: max-age=0\n`), /keeps .+ on a 404/, name);
	assert.throws(() => prepareDeployment({ headersTemplate: `${headersTemplate}/build/*\n  CDN-Cache-Control: max-age=31536000\n` }), /keeps CDN-Cache-Control on a 404/);
});
