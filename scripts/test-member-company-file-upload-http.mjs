import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Real SQL + HTTP gateway + disk store and replication journal. The RPC
// transport supplies fixture member claims, never a production credential.
export async function testMemberUploadHttp({ root, query, seed }) {
	query(seed);
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-member-upload-http-"));
	let server, clientServer, browser;
	try {
		const modulePath = join(scratch, "gateway.mjs");
		await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: [
			'export {createObjectGatewayHandler} from "./packages/object-gateway/src/service.ts";',
			'export {FileSystemObjectStore} from "./packages/object-gateway/src/object-store.ts";',
			'export {ObjectGatewayReplication} from "./packages/object-gateway/src/replication.ts";',
			'export {ObjectGatewayJournal} from "./packages/object-gateway/src/journal.ts";',
			'export {SupabaseObjectAuthority} from "./packages/object-gateway/src/supabase-authority.ts";',
			'export {ObjectDependencyError} from "./packages/object-gateway/src/dependency.ts";',
		].join("\n") }, platform: "node", format: "esm", target: "node22", bundle: true, outfile: modulePath });
		const { createObjectGatewayHandler, FileSystemObjectStore, ObjectGatewayReplication, ObjectGatewayJournal, SupabaseObjectAuthority, ObjectDependencyError } = await import(pathToFileURL(modulePath).href);
		const companyId = "29500000-0000-4000-8000-000000000010", environmentId = "29500000-0000-4000-8000-000000000020", userId = "29500000-0000-4000-8000-000000000001";
		const sha = bytes => createHash("sha256").update(bytes).digest("hex");
		const sql = value => value === null ? "null" : typeof value === "object" ? `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb` : `'${String(value).replaceAll("'", "''")}'`;
		const memberMethods = new Set(["qorpera_begin_member_company_file_upload", "qorpera_begin_member_company_path_command", "qorpera_get_member_company_path_command", "qorpera_review_member_company_path_command", "qorpera_authorize_member_company_command_object"]);
		const publisherMethods = new Set(["qorpera_stage_member_company_path_object", "qorpera_verify_company_path_file", "qorpera_prepare_member_company_path_command", "qorpera_verify_company_path_tree", "qorpera_apply_member_company_path_command_v3"]);
		const rpc = (method, args, role) => {
			assert((role === "authenticated" ? memberMethods : publisherMethods).has(method));
			const values = Object.entries(args).map(([name, value]) => { assert(/^p_[a-z][a-z0-9_]*$/.test(name)); return `${name}=>${sql(value)}`; });
			return JSON.parse(query(`set request.jwt.claims='${JSON.stringify({ role, ...(role === "authenticated" ? { sub: userId } : {}) })}'; set role ${role}; select to_jsonb(public.${method}(${values.join(",")}));`) || "null");
		};
		let loseApplied = false, lostApplied = 0, writes = 0;
		const authority = {
			async member(method, token, args) { assert.equal(token, "member-upload-fixture"); return rpc(method, args, "authenticated"); },
			async publisher(method, args) { const result = rpc(method, args, "service_role"); if (loseApplied && method === "qorpera_apply_member_company_path_command_v3") { loseApplied = false; lostApplied++; throw new ObjectDependencyError(503); } return result; },
		};
		const store = new FileSystemObjectStore(join(scratch, "objects"));
		const objectAuthority = new SupabaseObjectAuthority({ projectUrl: "https://fixture.invalid", publishableKey: "fixture-public", secretKey: "fixture-secret", fetch: async () => { throw new Error("Unexpected external object request"); } });
		const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(scratch, "journal")), store, objectAuthority);
		const uploadWithAuthority = replication.uploadWithAuthority.bind(replication);
		replication.uploadWithAuthority = async (...args) => { writes++; return uploadWithAuthority(...args); };
		let browserOrigin;
		if (process.env.QORPERA_FILE_TEST_BROWSER) {
			const clientBundle = await build({ absWorkingDir: root, entryPoints: ["packages/cloud-client/src/cloud-member-company-editor.ts"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "QorperaMember", target: "es2022" });
			clientServer = createServer((request, response) => {
				if (request.url === "/client.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(clientBundle.outputFiles[0].text); }
				else if (request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><script src="/client.js"></script>'); }
				else { response.writeHead(404); response.end(); }
			});
			await new Promise((accept, reject) => { clientServer.once("error", reject); clientServer.listen(0, "127.0.0.1", accept); });
			browserOrigin = `http://127.0.0.1:${clientServer.address().port}`;
		}
		let preflights = 0;
		const handler = createObjectGatewayHandler({ store, authority: objectAuthority, replication, memberFiles: authority, controlToken: "fixture-control", verifierToken: "fixture-verifier", memberClientOrigins: browserOrigin ? [browserOrigin] : [] });
		server = createServer((request, response) => { response.once("finish", () => { if (request.method === "OPTIONS" && response.statusCode === 204) preflights++; }); handler(request, response); });
		await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
		const origin = `http://127.0.0.1:${server.address().port}/v1/member-company-file/${environmentId}`;
		const cases = [];
		for (const size of [0, 6, 4194307, 8388608]) {
			const bytes = Buffer.alloc(size, 128); if (size) bytes[size - 1] = 255;
			const path = `selected-${size}.bin`, chunks = [];
			for (let offset = 0; offset < bytes.length; offset += 4194304) { const chunk = bytes.subarray(offset, offset + 4194304); chunks.push({ sha256: sha(chunk), bytes: chunk.length }); }
			const source = { realm: "member_file", name: path, sha256: sha(bytes), bytes: size, mediaType: "application/octet-stream" };
			const manifest = { schema: "qorpera.cloud-file-manifest/v1", fileSha256: source.sha256, bytes: size, mediaType: "application/octet-stream", chunks };
			const input = { schema: "qorpera.member-file-upload/v1", operationKey: `upload-${size}`, path, expectedVersion: null, source, manifest };
			const headers = { authorization: "Bearer member-upload-fixture", "content-type": "application/octet-stream", "x-qorpera-company-upload": Buffer.from(JSON.stringify(input)).toString("base64url") };
			if (size === 8388608) query(`set request.jwt.claims='${JSON.stringify({ role: "authenticated", sub: userId })}'; set role authenticated; select public.qorpera_set_company_path_resource('${environmentId}','${path}','exact','company_shared','protected');`);
			loseApplied = size === 6;
			let response = await fetch(`${origin}/uploads`, { method: "PUT", headers, body: bytes });
			if (size === 6) { assert.equal(response.status, 503, await response.text()); const priorWrites = writes; response = await fetch(`${origin}/uploads`, { method: "PUT", headers, body: bytes }); assert.equal(writes, priorWrites); }
			assert.equal(response.status, 200, await response.clone().text()); let result = await response.json();
			if (size === 8388608) {
				assert.equal(result.state, "review_required");
				const pending = await fetch(`${origin}/edits/${result.commandId}/file`, { headers: { authorization: "Bearer member-upload-fixture" } });
				assert.equal(pending.status, 200, await pending.clone().text());
				assert.equal(pending.headers.get("x-qorpera-plan-sha256"), result.planSha256);
				assert.deepEqual(Buffer.from(await pending.arrayBuffer()), bytes);
				assert.equal(query(`select count(*) from public.qorpera_company_path_entries where environment_id='${environmentId}' and path='${path}' and entry is not null;`), "0");
				const review = await fetch(`${origin}/edits/${result.commandId}/review`, { method: "POST", headers: { authorization: "Bearer member-upload-fixture", "content-type": "application/json" }, body: JSON.stringify({ planSha256: result.planSha256, decision: "approve" }) });
				assert.equal(review.status, 200, await review.clone().text()); result = await review.json();
			}
			assert.equal(result.state, "applied"); assert.equal(result.plan.path, path);
			const storedManifest = await store.get(companyId, result.plan.entry.file.manifestSha256, Buffer.byteLength(JSON.stringify(manifest)));
			assert.deepEqual(JSON.parse(Buffer.from(storedManifest).toString()), manifest);
			assert.deepEqual(Buffer.concat(await Promise.all(chunks.map(chunk => store.get(companyId, chunk.sha256, chunk.bytes)))), bytes);
			const retained = JSON.parse(query(`select jsonb_build_object('source',u.source,'result',c.result) from public.qorpera_member_company_file_uploads u join public.qorpera_member_company_path_commands c on c.id=u.command_id where c.id='${result.commandId}';`));
			assert.deepEqual(retained.source, source); assert.deepEqual(retained.result, result.result);
			const revisions = query(`select count(*) from public.qorpera_company_path_revisions where environment_id='${environmentId}' and change#>>'{plan,path}'='${path}';`);
			assert.equal(revisions, "1"); const priorWrites = writes;
			const replay = await fetch(`${origin}/uploads`, { method: "PUT", headers, body: bytes }); assert.equal(replay.status, 200, await replay.clone().text());
			assert.deepEqual(await replay.json(), result); assert.equal(writes, priorWrites);
			assert.equal(query(`select count(*) from public.qorpera_company_path_revisions where environment_id='${environmentId}' and change#>>'{plan,path}'='${path}';`), "1");
			cases.push({ bytes: size, chunks: chunks.length, protected: size === 8388608, revisions: 1, replayWrites: 0 });
		}
		assert.equal(lostApplied, 1);
		let browserProof = null;
		if (browserOrigin) {
			query(`set request.jwt.claims='${JSON.stringify({ role: "authenticated", sub: userId })}'; set role authenticated; select public.qorpera_set_company_path_resource('${environmentId}','browser-upload.bin','exact','company_shared','protected');`);
			browser = await chromium.launch({ executablePath: process.env.QORPERA_FILE_TEST_BROWSER, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
			const page = await browser.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
			await page.goto(browserOrigin);
			const result = await page.evaluate(async ({ companyId, environmentId, objectOrigin }) => {
				if (typeof Buffer !== "undefined" || typeof process !== "undefined" || !crypto.subtle) throw new Error("Browser-native client required");
				const client = new QorperaMember.CloudMemberCompanyFileClient({ companyId, environmentId, supabaseUrl: location.origin, objectGatewayUrl: objectOrigin, publishableKey: "public-fixture", accessToken: async () => "member-upload-fixture" });
				const uploaded = await client.upload({ operationKey: "browser-upload", path: "browser-upload.bin", expectedVersion: null, name: "browser-æ.bin", mediaType: "application/octet-stream", bytes: Uint8Array.from([0, 255, 128, 13, 10, 1]) }, new AbortController().signal);
				if (uploaded.command.state !== "review_required") throw new Error("Protected upload must wait for approval");
				const pending = await client.pendingFile(uploaded.command, new AbortController().signal);
				if (Array.from(pending.bytes).join() !== "0,255,128,13,10,1") throw new Error("Proposed binary bytes changed");
				const reviewed = await client.review(uploaded.command, "approve", new AbortController().signal);
				const edited = await client.edit({ operation: "write", operationKey: "browser-text", path: "browser-note.md", expectedVersion: null, text: "Browser text æ" }, new AbortController().signal);
				return { uploaded, edited, reviewed };
			}, { companyId, environmentId, objectOrigin: new URL(origin).origin });
			assert.equal(result.uploaded.command.state, "review_required"); assert.equal(result.reviewed.state, "applied"); assert.equal(result.edited.state, "applied");
			assert.equal(result.uploaded.source.sha256, sha(Buffer.from([0, 255, 128, 13, 10, 1])));
			assert(preflights >= 4); assert.deepEqual(errors, []);
			browserProof = { browser: browser.version(), binaryUpload: true, pendingBinaryDownload: true, exactProtectedApproval: true, textEdit: true, webCrypto: true, nativePreflights: preflights, nodeGlobals: false, crossOrigin: true };
		}
		console.log(JSON.stringify({ schema: "qorpera.member-company-file-upload-http/v1", actualSql: true, actualHttp: true, actualGateway: true, diskStore: true, replicationJournal: true,
			cases, exactSource: true, lostReplyRecovered: true, humanProtectedApproval: true, pendingMultiChunkDownload: true, browser: browserProof, sqlTransport: "fixture", initialSnapshotStorage: "catalog-fixture", hosted: false, nas: false }));
	} finally {
		await browser?.close();
		if (clientServer) { clientServer.closeAllConnections(); await new Promise(accept => clientServer.close(accept)); }
		if (server) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
		await rm(scratch, { recursive: true, force: true });
	}
}
