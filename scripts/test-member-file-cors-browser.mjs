// Chromium against the real member object gateway and disk store on another
// origin. SQL authority/RPC responses are fixtures; hosted TLS/NAS are unproved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.env.QORPERA_FILE_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_FILE_TEST_BROWSER to an existing Chromium executable");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bytes = Buffer.from([0, 255, 128, 13, 10, 1]), fileSha256 = sha(bytes), path = "documents/æble.bin";
const manifest = Buffer.from(JSON.stringify({ schema: "qorpera.cloud-file-manifest/v1", fileSha256, bytes: bytes.length,
	mediaType: "application/octet-stream", chunks: [{ sha256: fileSha256, bytes: bytes.length }] }));
const manifestSha256 = sha(manifest);
const directory = await mkdtemp(join(tmpdir(), "qorpera-member-browser-"));
const servers = [], failures = [], requests = [];
let browser;
const state = { version: id(3), revoked: false, revokeDuringRead: false, corrupt: false };
let reads = 0, describes = 0, authorizations = 0;
const listen = async server => {
	servers.push(server);
	await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
	return `http://127.0.0.1:${server.address().port}`;
};
try {
	const bundle = await build({ absWorkingDir: root, entryPoints: ["packages/cloud-client/src/cloud-member-company-file.ts"], bundle: true, write: false,
		platform: "browser", format: "iife", globalName: "QorperaMemberFiles", target: "es2022" });
	const modulePath = join(directory, "gateway.mjs");
	await build({ absWorkingDir: root, stdin: { contents: [
		'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
		'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
		'export {ObjectDependencyError} from "./packages/object-gateway/src/dependency.ts";',
	].join("\n"), resolveDir: root }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: modulePath });
	const { createObjectGatewayHandler, FileSystemObjectStore, ObjectDependencyError } = await import(pathToFileURL(modulePath).href);
	const store = new FileSystemObjectStore(join(directory, "objects"));
	await store.put(id(1), manifestSha256, manifest); await store.put(id(1), fileSha256, bytes);
	const get = store.get.bind(store);
	store.get = async (...args) => {
		reads++; const result = await get(...args);
		if (state.revokeDuringRead) state.revoked = true;
		return state.corrupt ? Buffer.alloc(result.length, 1) : result;
	};
	const memberObjects = {
		async authorizeMemberCompanyObject(token, identity) {
			authorizations++;
			if (state.revoked || token !== "member-token") throw new ObjectDependencyError(403);
			assert.equal(identity.environmentId, id(2)); assert.equal(identity.path, path); assert.equal(identity.version, id(3));
			assert([manifestSha256, fileSha256].includes(identity.sha256));
			return { ...identity, schema: "qorpera.member-company-object/v2", companyId: id(1), actorUserId: id(4), resourceId: id(5),
				resourceVersion: id(6), bytes: identity.sha256 === manifestSha256 ? manifest.length : bytes.length, backend: "nas-object-gateway" };
		},
		async readLegacyObject() { throw new Error("Unexpected fallback"); },
	};
	const clientHandler = (req, res) => { void (async () => {
		if (req.method === "GET" && req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
		if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end('<!doctype html><script src="/client.js"></script>'); return; }
		if (req.method === "GET" && req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
		assert.equal(req.method, "POST"); assert.equal(req.url, "/rest/v1/rpc/qorpera_read_company_path");
		assert.equal(req.headers.authorization, "Bearer member-token"); assert.equal(req.headers.apikey, "publishable-fixture");
		let text = ""; for await (const chunk of req) { text += chunk; assert(text.length < 32768); }
		assert.deepEqual(JSON.parse(text), { p_environment_id: id(2), p_binding: null, p_path: path }); describes++;
		res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify({ companyId: id(1), path, version: state.version, entry: { path, kind: "file", executable: false,
			file: { manifestSha256, fileSha256, bytes: bytes.length, mediaType: "application/octet-stream" } }, manifestBytes: manifest.length }));
	})().catch(error => { failures.push(error.message); res.writeHead(500); res.end(); }); };
	const origin = await listen(createServer(clientHandler)), untrustedOrigin = await listen(createServer(clientHandler));
	const handler = createObjectGatewayHandler({ store, memberObjects, authority: {}, controlToken: "fixture-control", verifierToken: "fixture-verifier", memberClientOrigins: [origin] });
	const objectOrigin = await listen(createServer((req, res) => {
		const request = { method: req.method, url: req.url, origin: req.headers.origin };
		res.once("finish", () => requests.push({ ...request, status: res.statusCode }));
		handler(req, res);
	}));
	assert.notEqual(origin, objectOrigin);
	browser = await chromium.launch({ executablePath, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
	const context = await browser.newContext({ serviceWorkers: "block" });
	// Request interception can suppress Chromium's native preflight. Observe
	// traffic without routing it so this actually exercises browser CORS.
	context.on("request", request => { if (![origin, objectOrigin, untrustedOrigin].includes(new URL(request.url()).origin)) failures.push("Unexpected non-fixture network request"); });
	const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message)); await page.goto(origin);
	const selection = { realm: "company_file", path, version: id(3) };
	const execute = () => page.evaluate(async ({ objectOrigin, companyId, environmentId, selection }) => {
		if (typeof Buffer !== "undefined" || typeof process !== "undefined" || !crypto.subtle) throw new Error("Native browser APIs required");
		const reader = new QorperaMemberFiles.CloudMemberCompanyFileReader({ companyId, environmentId, supabaseUrl: location.origin,
			objectGatewayUrl: objectOrigin, publishableKey: "publishable-fixture", accessToken: async () => "member-token" });
		try { const result = await reader.download(selection, new AbortController().signal); return { ok: true, source: result.source, bytes: Array.from(result.bytes) }; }
		catch (error) { return { ok: false, message: error.message }; }
	}, { objectOrigin, companyId: id(1), environmentId: id(2), selection });
	const result = await execute(); assert.equal(result.ok, true, JSON.stringify({ result, failures })); assert.deepEqual(result.bytes, Array.from(bytes));
	assert.deepEqual(result.source, { ...selection, companyId: id(1), environmentId: id(2), sha256: fileSha256, manifestSha256 });
	assert.equal(reads, 2); assert.equal(describes, 2); assert.equal(authorizations, 4);
	assert.equal(requests.filter(r => r.method === "OPTIONS" && r.status === 204).length, 2);
	const exposed = await page.evaluate(async ({ objectOrigin, route, encodedPath }) => {
		const response = await fetch(objectOrigin + route, { headers: { authorization: "Bearer member-token", "x-qorpera-company-path": encodedPath }, credentials: "omit" });
		await response.arrayBuffer(); return { mode: response.headers.get("x-qorpera-access-mode"), etag: response.headers.get("etag") };
	}, { objectOrigin, route: `/v1/member-company-objects/${id(2)}/${id(3)}/${manifestSha256}`, encodedPath: Buffer.from(path).toString("base64url") });
	assert.deepEqual(exposed, { mode: "live-path-authority", etag: `"sha256-${manifestSha256}"` });
	const beforeStale = reads; state.version = id(7); const stale = await execute(); assert.equal(stale.ok, false); assert.match(stale.message, /version changed/); assert.equal(reads, beforeStale);
	state.version = id(3); state.corrupt = true; const corrupt = await execute(); assert.equal(corrupt.ok, false); assert.match(corrupt.message, /503/);
	state.corrupt = false; state.revokeDuringRead = true; const revoked = await execute(); assert.equal(revoked.ok, false); assert.match(revoked.message, /403/);
	state.revokeDuringRead = false; state.revoked = false;
	const beforeDenied = authorizations; await page.goto(untrustedOrigin); const denied = await execute(); assert.equal(denied.ok, false); assert.match(denied.message, /fetch/i); assert.equal(authorizations, beforeDenied);
	assert(requests.some(r => r.origin === untrustedOrigin && r.method === "OPTIONS" && r.status === 403));
	await page.goto(origin);
	const privateBlocked = await page.evaluate(async url => { try { await fetch(url, { headers: { authorization: "Bearer fixture-verifier" } }); return false; } catch { return true; } }, `${objectOrigin}/v1/profile-objects/${id(1)}/${fileSha256}`);
	assert.equal(privateBlocked, true); assert.equal(authorizations, beforeDenied);
	assert.deepEqual(failures, []); assert.deepEqual(errors, []);
	console.log(JSON.stringify({ schema: "qorpera.member-file-browser-cors-proof/v1", browser: browser.version(), binaryBytes: bytes.length,
		nodeGlobals: false, actualHttp: true, actualGateway: true, actualDiskStore: true, crossOrigin: true, preflights: true,
		webCrypto: true, exactVersion: true, sourceHashes: true, exposedHeaders: true, staleRejected: true, corruptRejected: true,
		revokedDuringReadRejected: true, untrustedOriginRejected: true, privateRouteRejected: true, authority: "fixture",
		hosted: false, hostedCors: false, nas: false, memberFilesystemAccess: false }));
} finally {
	await browser?.close();
	for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
	await rm(directory, { recursive: true, force: true });
}
