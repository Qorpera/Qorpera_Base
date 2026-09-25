import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Called after a real native/Linux office export, import and Company File
// write have closed their office session. Member claims use disposable SQL;
// object bytes, the object gateway and HTTP are real. The member web app's
// browser download runs in test-member-web-exports-sql.mjs.
export async function testMemberFileExportGateway({ root, query, store, replication, companyId, environmentId, asset, bytes }) {
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-member-export-http-"));
	let gateway, control;
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
		].join("\n") }, platform: "node", format: "esm", target: "node22", bundle: true, outfile: modulePath });
		const code = await import(pathToFileURL(modulePath).href);
		let authorizations = 0;
		const authority = { async member(method, token, args) {
			assert.equal(token, "member-export-fixture"); authorizations++;
			try { return rpc(method, args); } catch { throw new code.ObjectDependencyError(403); }
		}, async publisher() { throw new Error("Unexpected export mutation"); } };
		control = createServer(async (request, response) => {
			if (request.method === "POST" && methods.has(request.url?.slice("/rest/v1/rpc/".length)) && request.url.startsWith("/rest/v1/rpc/")) {
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
		gateway = createServer(handler);
		await listen(gateway);
		const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`;
		const options = { companyId, environmentId, supabaseUrl: controlOrigin, objectGatewayUrl: gatewayOrigin, publishableKey: "fixture-public" };
		const selection = { realm: "object_storage", assetId: asset.assetId, sha256: asset.sha256 };
		// Revoking the original office grant cannot revoke company-owned exports.
		query(`update public.qorpera_runtime_office_access set state='revoked' where office_id=${literal(asset.source.companyComputerId)}::uuid;`);
		const client = new code.CloudMemberFileExports({ ...options, accessToken: async () => "member-export-fixture" });
		assert.deepEqual((await client.list(new AbortController().signal)).items, [asset]);
		assert.deepEqual(Buffer.from((await client.download(selection, new AbortController().signal)).bytes), Buffer.from(bytes));
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
		console.log(JSON.stringify({ schema: "qorpera.member-file-export-gateway/v1", actualSql: true, nativeExportReceipt: true, physicalObjectBytes: bytes.length,
			closedOfficeConnection: true, revokedOfficeGrant: true, sharedMemberDownload: true, revokedMemberDuringReadDenied: true,
			sqlTransport: "fixture", hosted: false, nas: false }));
	} finally {
		store.get = get;
		await Promise.all([close(gateway), close(control)]); await rm(scratch, { recursive: true, force: true });
		for (const grant of grants) query(`update public.qorpera_runtime_office_access set state=${literal(grant.state)} where grant_id=${literal(grant.id)}::uuid;`);
		query(`insert into public.qorpera_profile_members select * from jsonb_populate_record(null::public.qorpera_profile_members,${literal(member)}) on conflict do nothing;`);
	}
}
