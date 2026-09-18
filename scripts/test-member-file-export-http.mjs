import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Called after a real native/Linux office export, import and Company File
// write have closed their office session. Member claims use disposable SQL;
// object bytes, HTTP, browser fetch/CORS and WebCrypto are real.
export async function testMemberFileExportHttp({ root, query, store, replication, companyId, environmentId, asset, bytes }) {
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-member-export-http-"));
	let gateway, control, browser;
	const userId = "30000000-0000-4000-8000-000000000003";
	const methods = new Set(["qorpera_member_file_export_source", "qorpera_list_member_file_exports"]);
	const literal = value => value === null ? "null" : `'${(typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'${typeof value === "object" ? "::jsonb" : ""}`;
	const rpc = (method, args) => {
		assert(methods.has(method));
		const parameters = Object.entries(args).map(([name, value]) => { assert(/^p_[a-z][a-z0-9_]*$/.test(name)); return `${name}=>${literal(value)}`; });
		return JSON.parse(query(`set request.jwt.claims='{"role":"authenticated","sub":"${userId}"}'; set role authenticated;
		 select to_jsonb(public.${method}(${parameters.join(",")}));`));
	};
	const listen = server => new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
	const close = server => server && new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
	const get = store.get.bind(store);
	const grants = JSON.parse(query(`select coalesce(jsonb_agg(jsonb_build_object('id',grant_id,'state',state)),'[]'::jsonb) from public.qorpera_runtime_office_access where office_id=${literal(asset.source.companyComputerId)}::uuid;`));
	const member = JSON.parse(query(`select to_jsonb(m) from public.qorpera_profile_members m where profile_id=${literal(companyId)}::uuid and user_id='${userId}';`));
	try {
		const modulePath = join(scratch, "gateway.mjs");
		await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: [
			'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
			'export {SupabaseObjectAuthority} from "./packages/object-gateway/src/supabase-authority.ts";',
			'export {ObjectDependencyError} from "./packages/object-gateway/src/dependency.ts";',
			'export {CloudMemberFileExports} from "./packages/cloud-client/src/cloud-member-file-exports.ts";',
			'export {saveSelectedMemberExport} from "./packages/shell/src/member-file-download.ts";',
		].join("\n") }, platform: "node", format: "esm", target: "node22", bundle: true, outfile: modulePath });
		const code = await import(pathToFileURL(modulePath).href);
		const clientBundle = await build({ absWorkingDir: root, entryPoints: ["packages/cloud-client/src/cloud-member-file-exports.ts"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "QorperaExports", target: "es2022" });
		const uiFiles = new Map();
		for (const [name, mime] of [["company-file.html", "text/html"], ["company-file.js", "text/javascript"], ["company-file.css", "text/css"]])
			uiFiles.set(`/${name}`, { bytes: await readFile(join(root, "packages/shell/userland", name)), mime });
		let authorizations = 0, preflights = 0;
		const authority = { async member(method, token, args) {
			assert.equal(token, "member-export-fixture"); authorizations++;
			try { return rpc(method, args); } catch { throw new code.ObjectDependencyError(403); }
		}, async publisher() { throw new Error("Unexpected export mutation"); } };
		control = createServer(async (request, response) => {
			if (request.method === "GET" && uiFiles.has(request.url)) { const file = uiFiles.get(request.url); response.writeHead(200, { "content-type": file.mime }); response.end(file.bytes); }
			else if (request.method === "GET" && request.url === "/client.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(clientBundle.outputFiles[0].text); }
			else if (request.method === "GET" && request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><script src="/client.js"></script>'); }
			else if (request.method === "POST" && methods.has(request.url?.slice("/rest/v1/rpc/".length)) && request.url.startsWith("/rest/v1/rpc/")) {
				try {
					assert.equal(request.headers.authorization, "Bearer member-export-fixture"); assert.equal(request.headers.apikey, "fixture-public");
					let body = ""; for await (const chunk of request) { body += chunk; assert(body.length <= 4096); }
					const result = rpc(request.url.slice("/rest/v1/rpc/".length), JSON.parse(body));
					response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(result));
				} catch { response.writeHead(403); response.end(); }
			} else { response.writeHead(404); response.end(); }
		});
		await listen(control);
		const controlOrigin = `http://127.0.0.1:${control.address().port}`;
		const objectAuthority = new code.SupabaseObjectAuthority({ projectUrl: "https://fixture.invalid", publishableKey: "fixture-public", secretKey: "fixture-secret", fetch: async () => { throw new Error("Unexpected external request"); } });
		const handler = code.createObjectGatewayHandler({ store, replication, authority: objectAuthority, memberFiles: authority,
			controlToken: "fixture-control", verifierToken: "fixture-verifier", memberClientOrigins: [controlOrigin] });
		gateway = createServer((request, response) => { response.once("finish", () => { if (request.method === "OPTIONS" && response.statusCode === 204) preflights++; }); handler(request, response); });
		await listen(gateway);
		const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`;
		const options = { companyId, environmentId, supabaseUrl: controlOrigin, objectGatewayUrl: gatewayOrigin, publishableKey: "fixture-public" };
		const selection = { realm: "object_storage", assetId: asset.assetId, sha256: asset.sha256 };
		// Revoking the original office grant cannot revoke company-owned exports.
		query(`update public.qorpera_runtime_office_access set state='revoked' where office_id=${literal(asset.source.companyComputerId)}::uuid;`);
		const client = new code.CloudMemberFileExports({ ...options, accessToken: async () => "member-export-fixture" });
		assert.deepEqual((await client.list(new AbortController().signal)).items, [asset]);
		assert.deepEqual(Buffer.from((await client.download(selection, new AbortController().signal)).bytes), Buffer.from(bytes));
		let browserProof = null;
		if (process.env.QORPERA_FILE_TEST_BROWSER) {
			browser = await chromium.launch({ executablePath: process.env.QORPERA_FILE_TEST_BROWSER, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
			const page = await browser.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
			await page.goto(controlOrigin);
			const result = await page.evaluate(async ({ options, selection }) => {
				if (typeof process !== "undefined" || typeof require !== "undefined" || typeof Buffer !== "undefined") throw new Error("Node globals leaked");
				const client = new QorperaExports.CloudMemberFileExports({ ...options, accessToken: async () => "member-export-fixture" });
				const list = await client.list(new AbortController().signal), downloaded = await client.download(selection, new AbortController().signal);
				return { list, asset: downloaded.asset, source: downloaded.source, bytes: Array.from(downloaded.bytes) };
			}, { options, selection });
			assert.deepEqual(result.list.items, [asset]); assert.deepEqual(result.asset, asset);
			assert.deepEqual(result.source, { ...selection, companyId, environmentId }); assert.deepEqual(result.bytes, Array.from(bytes));
			assert(preflights > 0); assert.deepEqual(errors, []);
			const requests = [], destination = join(scratch, "member-chosen.bin");
			let cancelled = true;
			await page.exposeFunction("fixtureExportRequest", async input => {
				requests.push(input);
				let result;
				if (input.method === "info") result = { title: "Export fixture", canWrite: false };
				else if (input.method === "list") result = { snapshotId: asset.assetId, items: [], hasMore: false, nextAfter: null };
				else if (input.method === "reviews") result = { items: [], nextAfter: null };
				else if (input.method === "exports") result = await client.list(new AbortController().signal, input.after);
				else if (input.method === "downloadExport") result = await code.saveSelectedMemberExport({ selection: input.selection, name: asset.source.path,
					signal: new AbortController().signal, current: () => true, download: (selection, signal) => client.download(selection, signal),
					chooseDestination: async () => cancelled ? null : destination });
				else throw new Error(`Unexpected export UI action: ${input.method}`);
				assert(!JSON.stringify(result).includes(scratch)); return { ok: true, result };
			});
			await page.addInitScript(() => { window.companyFile = { request: input => window.fixtureExportRequest(input) }; });
			await page.goto(`${controlOrigin}/company-file.html`);
			await page.waitForFunction(() => document.getElementById("status").textContent === "Connected with read-only company access.");
			await page.locator("#listExports").click(); await page.locator("#exports .download").waitFor();
			assert((await page.locator("#exports").textContent()).includes(asset.source.path));
			const beforeCancel = authorizations;
			await page.locator("#exports .download").click(); await page.waitForFunction(() => document.getElementById("status").textContent === "Download cancelled.");
			assert.equal(authorizations, beforeCancel); await assert.rejects(readFile(destination), { code: "ENOENT" });
			cancelled = false; await page.locator("#exports .download").click();
			await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Downloaded shared export"));
			assert.deepEqual(await readFile(destination), Buffer.from(bytes));
			assert(requests.filter(request => request.method === "downloadExport").every(request => JSON.stringify(request.selection) === JSON.stringify(selection)));
			assert(!JSON.stringify(requests).includes(scratch)); assert.deepEqual(errors, []);
			browserProof = { version: browser.version(), crossOrigin: true, nativePreflights: preflights, webCrypto: true, nodeGlobals: false,
				actualDom: true, actualNativeSave: true, cancelledBeforeRead: true, readOnlyDownload: true, rendererPaths: false, rendererBytes: false, preload: "fixture", chooser: "fixture" };
		}
		const before = authorizations;
		store.get = async (...args) => {
			const result = await get(...args);
			query(`delete from public.qorpera_profile_members where profile_id=${literal(companyId)}::uuid and user_id='${userId}';`);
			return result;
		};
		const refused = await fetch(`${gatewayOrigin}/v1/member-file-exports/${environmentId}/${asset.assetId}/${asset.sha256}`, { headers: { authorization: "Bearer member-export-fixture" } });
		assert.equal(refused.status, 403); assert.notDeepEqual(Buffer.from(await refused.arrayBuffer()), Buffer.from(bytes));
		assert.equal(authorizations - before, 2);
		await assert.rejects(client.list(new AbortController().signal));
		console.log(JSON.stringify({ schema: "qorpera.member-file-export-http/v1", actualSql: true, nativeExportReceipt: true, physicalObjectBytes: bytes.length,
			closedOfficeConnection: true, revokedOfficeGrant: true, sharedMemberDownload: true, revokedMemberDuringReadDenied: true,
			browser: browserProof, sqlTransport: "fixture", hosted: false, nas: false }));
	} finally {
		store.get = get;
		await browser?.close(); await Promise.all([close(gateway), close(control)]); await rm(scratch, { recursive: true, force: true });
		for (const grant of grants) query(`update public.qorpera_runtime_office_access set state=${literal(grant.state)} where grant_id=${literal(grant.id)}::uuid;`);
		query(`insert into public.qorpera_profile_members select * from jsonb_populate_record(null::public.qorpera_profile_members,${literal(member)}) on conflict do nothing;`);
	}
}
