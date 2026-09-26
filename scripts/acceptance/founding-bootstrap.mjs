import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { CompanyBootstrapProvisioner } from "../../packages/object-gateway/src/company-bootstrap.ts";
import { ObjectGatewayJournal } from "../../packages/object-gateway/src/journal.ts";
import { SupabaseMemberCompanyAuthority } from "../../packages/object-gateway/src/member-company-authority.ts";
import { FileSystemObjectStore } from "../../packages/object-gateway/src/object-store.ts";
import { ObjectGatewayReplication } from "../../packages/object-gateway/src/replication.ts";
import { createObjectGatewayHandler } from "../../packages/object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../../packages/object-gateway/src/supabase-authority.ts";
import { closeServer, listenLoopback } from "./founding-services.mjs";
import { sqlUuid } from "./founding-fixtures.mjs";

/** Route actual authority HTTP to the private PostgREST listener. No canned
 * response, Storage metadata insertion, member claim or permission override. */
export function bootstrapAuthorityTransport(origin, restPort, transport = fetch) {
	assert.equal(new URL(origin).origin, origin);
	assert(Number.isSafeInteger(restPort) && restPort > 0 && restPort < 65536);
	return (input, init) => {
		const url = new URL(String(input));
		assert(
			url.origin === origin && /^\/rest\/v1\/rpc\/qorpera_[a-z_]+$/.test(url.pathname) && !url.search && !url.hash,
			"Bootstrap acceptance allows only its own actual PostgREST RPC transport",
		);
		return transport(`http://127.0.0.1:${restPort}${url.pathname.slice("/rest/v1".length)}`, {
			...init,
			redirect: "error",
		});
	};
}

export async function prepareFoundingBootstrap({ cluster, gateway, publicKey, jwtSecret, restPort, privateRoot }) {
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const head = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role: "service_role", aud: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
	const serviceJwt = `${head}.${createHmac("sha256", jwtSecret).update(head).digest("base64url")}`;
	const options = {
		projectUrl: gateway.origin,
		publishableKey: publicKey,
		secretKey: serviceJwt,
		fetch: bootstrapAuthorityTransport(gateway.origin, restPort),
	};
	const authority = new SupabaseObjectAuthority(options);
	const publisher = new SupabaseMemberCompanyAuthority(options);
	const store = new FileSystemObjectStore(join(privateRoot, "bootstrap-objects"));
	const journal = new ObjectGatewayJournal(join(privateRoot, "bootstrap-journal"));
	const replication = new ObjectGatewayReplication(journal, store, authority);
	const provisioner = new CompanyBootstrapProvisioner({
		workerId: randomUUID(),
		authority: publisher,
		store,
		replication,
		authorizeServiceDownload: (profileId, sha) => authority.authorizeServiceDownload(profileId, sha),
		readLegacyObject: (profileId, sha) => authority.readLegacyObject(profileId, sha),
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			memberObjects: authority,
			controlToken: randomBytes(32).toString("base64url"),
			verifierToken: randomBytes(32).toString("base64url"),
		}),
	);
	const port = await listenLoopback(server);
	const publications = new Map();
	return {
		boundary:
			"Actual CompanyBootstrapProvisioner, durable filesystem objects/journal, live PostgREST staging/verification/publication and real member-authorized HTTP byte reads. Local NAS-compatible filesystem only; physical NFS and remote Storage replication are not exercised.",
		close: () => closeServer(server),
		async provision(profileId) {
			sqlUuid(profileId);
			for (let attempt = 0; attempt < 10; attempt++) {
				const state = await cluster.query(
					`select state from public.qorpera_company_bootstrap_jobs where profile_id=${sqlUuid(profileId)};`,
				);
				if (state === "completed") break;
				assert(await provisioner.provisionOne(), "Production bootstrap worker did not claim the created company");
			}
			const metadata = JSON.parse(
				await cluster.query(`select jsonb_build_object('state',job.state,'environmentId',job.environment_id,
				'snapshotId',job.output_snapshot_id,'treeSha256',snapshot.tree_manifest_sha256,'treeBytes',snapshot.tree_manifest_bytes,
				'published',publication.status,'closureVerified',graph.closure_verified,'graphStatus',graph.status)
				from public.qorpera_company_bootstrap_jobs job
				join public.qorpera_company_snapshots snapshot on snapshot.id=job.output_snapshot_id
				join public.qorpera_company_snapshot_publications publication on publication.snapshot_id=snapshot.id
				join public.qorpera_object_reachability_graphs graph on graph.root_kind='company_snapshot' and graph.root_id=snapshot.id
				where job.profile_id=${sqlUuid(profileId)};`),
			);
			assert.equal(metadata.state, "completed");
			assert.equal(metadata.published, "published");
			assert.equal(metadata.closureVerified, true);
			assert.equal(metadata.graphStatus, "complete");
			const objects = JSON.parse(
				await cluster.query(
					`select jsonb_agg(jsonb_build_object('sha256',sha256,'bytes',bytes,'backend',backend)) from public.qorpera_profile_objects where profile_id=${sqlUuid(profileId)};`,
				),
			);
			assert.equal(objects.length, 5, "Fresh formation, agent, manifests and tree must have real bytes");
			for (const object of objects) {
				assert.equal(object.backend, "nas-object-gateway");
				const bytes = await store.get(profileId, object.sha256, object.bytes);
				assert.equal(createHash("sha256").update(bytes).digest("hex"), object.sha256);
			}
			assert.equal(
				await cluster.query(
					`select count(*) from storage.objects where bucket_id='qorpera-profile-objects' and name like ${sqlUuid(profileId)}::text || '/%';`,
				),
				"0",
				"Real bootstrap must not seed Storage metadata",
			);
			const tree = JSON.parse(
				Buffer.from(await store.get(profileId, metadata.treeSha256, metadata.treeBytes)).toString("utf8"),
			);
			const files = tree.entries.filter((entry) => entry.kind === "file");
			assert.equal(files.length, 2);
			publications.set(profileId, { ...metadata, files });
			return { ...metadata, objects: objects.length, files: files.map((file) => file.path) };
		},
		async verifyMemberReads(profileId, memberTokens, deniedToken) {
			const publication = publications.get(profileId);
			assert(publication);
			let reads = 0;
			for (const file of publication.files) {
				const url = `http://127.0.0.1:${port}/v1/member-company-snapshot-objects/${publication.environmentId}/${publication.snapshotId}/${file.file.fileSha256}`;
				const headers = (token) => ({
					authorization: `Bearer ${token}`,
					"x-qorpera-company-path": Buffer.from(file.path).toString("base64url"),
				});
				if (deniedToken) {
					const response = await fetch(url, { headers: headers(deniedToken), signal: AbortSignal.timeout(10000) });
					assert.equal(response.status, 403, "Nonmember could read published company bytes");
					await response.body?.cancel();
				}
				for (const token of memberTokens) {
					const response = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(10000) });
					assert.equal(response.status, 200, "Member could not read the actual published company bytes");
					assert.equal(response.headers.get("x-qorpera-access-mode"), "live-path-authority");
					const bytes = new Uint8Array(await response.arrayBuffer());
					assert.equal(bytes.length, file.file.bytes);
					assert.equal(createHash("sha256").update(bytes).digest("hex"), file.file.fileSha256);
					JSON.parse(Buffer.from(bytes).toString("utf8"));
					reads++;
				}
			}
			return { memberCount: memberTokens.length, verifiedReads: reads, nonmemberDenied: Boolean(deniedToken) };
		},
	};
}
