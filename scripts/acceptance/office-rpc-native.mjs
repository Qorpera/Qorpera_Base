import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isAbsolute, join, resolve } from "node:path";
import { startNativePostgres } from "./native-postgres.mjs";
import { OFFICE_PROVIDER_RPCS, startOfficeRpcServer } from "./office-rpc-server.mjs";

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === "--bin" && args[2] === "--out", "Usage: office-rpc-native.mjs --bin <PostgreSQL17-bin> --out <new-evidence-directory>");
const binDirectory = args[1], out = args[3];
assert(isAbsolute(out) && resolve(out) === out && out !== "/", "Canonical output directory required");
await mkdir(out, { recursive: true, mode: 0o700 });
const output = await lstat(out);
assert(output.isDirectory() && output.uid === process.getuid() && (output.mode & 0o022) === 0 && await realpath(out) === out, "Unsafe output directory");
const evidence = { schema: "qorpera.office-rpc-native-acceptance/v1", commit: process.env.GITHUB_SHA ?? null,
	scope: "Real native PostgreSQL migrations, production office RPC and actual service_role through authenticated TLS. No LXD, paid admission or office recovery claim.", passed: false, checks: {}, cleanup: false };
let cluster, server, invocationCount = 0, startupCleanupUnconfirmed = false;
try {
	cluster = await startNativePostgres({ binDirectory });
	evidence.postgresVersion = cluster.postgresVersion; evidence.migrationCount = cluster.migrationCount;
	const [userId, profileId, environmentId, officeId, logicalId, clientId] = Array.from({ length: 6 }, () => randomUUID());
	// Database-owner setup is confined to a new private cluster. These are read
	// fixtures, not fabricated activation, physical readiness or paid receipts.
	await cluster.query(`begin;
 insert into auth.users(id,email) values('${userId}','office-rpc-acceptance@example.test');
 insert into public.qorpera_profiles(id,name,created_by_user_id) values('${profileId}','Office RPC acceptance','${userId}');
 insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values('${environmentId}','${profileId}','Office RPC acceptance',1,'${userId}');
 insert into public.qorpera_runtime_offices(id,profile_id,environment_id,logical_computer_id,client_computer_id,image_sha256,bootstrap_sha256,max_screens,created_by_user_id)
 values('${officeId}','${profileId}','${environmentId}','${logicalId}','${clientId}',repeat('a',64),repeat('b',64),1,'${userId}');
 insert into public.qorpera_logical_computers(id,profile_id,client_computer_id,display_name,template_key,template_version,capabilities,policy,computer_class,created_by_user_id)
 values('${logicalId}','${profileId}','${clientId}','Office RPC acceptance','qorpera-shared-office','v1','["company_substrate"]',public.qorpera_runtime_office_policy(),'company_computer','${userId}');
 commit;`);
	const certFile = join(cluster.root, "rpc-cert.pem"), keyFile = join(cluster.root, "rpc-key.pem");
	const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
		"-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { encoding: "utf8", timeout: 15000 });
	assert.equal(certificate.status, 0, "Ephemeral TLS certificate creation failed");
	const cert = await readFile(certFile), key = await readFile(keyFile);
	const tokens = { guest: randomBytes(32).toString("base64url"), provider: randomBytes(32).toString("base64url") };
	server = await startOfficeRpcServer({ query: (sql, options) => { if (!sql.includes("from pg_catalog.pg_proc")) invocationCount++; return cluster.query(sql, options); },
		tls: { cert, key }, tokens, listen: { host: "127.0.0.1", port: 0 } });
	evidence.checks.productionSignatures = server.signatures.size;
	assert.equal(server.signatures.size, OFFICE_PROVIDER_RPCS.length);
	const scope = { companyId: profileId, environmentId, companyComputerId: officeId, logicalComputerId: logicalId };
	const call = (method, body, token = tokens.guest) => new Promise((resolveCall, reject) => {
		const req = request({ hostname: "127.0.0.1", port: server.address.port, path: `/rest/v1/rpc/${method}`, method: "POST", ca: cert,
			headers: { apikey: token, authorization: `Bearer ${token}`, "content-type": "application/json" }, timeout: 5000 }, (response) => {
			const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
			response.once("end", () => resolveCall({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
		});
		req.once("error", reject); req.once("timeout", () => req.destroy(new Error("TLS request timed out"))); req.end(JSON.stringify(body));
	});
	const successful = await call("qorpera_runtime_office_supervisor_status", { p_scope: scope, p_computer_generation: 1 });
	assert.equal(successful.status, 200); assert.deepEqual(successful.body.scope, scope);
	assert.equal(successful.body.state, "provisioning"); assert.equal(successful.body.privacyState, "shared"); assert.deepEqual(successful.body.drains, []);
	evidence.checks.actualServiceRoleSupervisor = true;
	const privacy = await call("qorpera_runtime_office_privacy_status", { p_scope: scope });
	assert.equal(privacy.status, 200); assert.equal(privacy.body.state, "shared");
	evidence.checks.productionPrivacyRead = true;
	const before = invocationCount;
	assert.equal((await call("qorpera_runtime_office_privacy_status", { p_scope: scope }, randomBytes(32).toString("base64url"))).status, 401);
	assert.equal((await call("qorpera_prepare_runtime_computer_permit", { p_request: {}, p_executor_secret: "forged" })).status, 403);
	assert.equal(invocationCount, before);
	evidence.checks.badTokenAndGuestHostRpcRejectedBeforeSql = true;
	const denied = await call("qorpera_runtime_office_privacy_status", { p_scope: { ...scope, companyId: randomUUID() } });
	assert.equal(denied.status, 503); assert.deepEqual(denied.body, { error: "RPC unavailable" });
	evidence.checks.realSqlScopeDenialRedacted = true;
	evidence.passed = true;
} catch (error) {
	startupCleanupUnconfirmed = !cluster && error instanceof AggregateError;
	evidence.error = "Native office RPC acceptance failed; credentials and SQL diagnostics withheld";
	process.exitCode = 1;
} finally {
	try { await server?.close(); await cluster?.close(); evidence.cleanup = !startupCleanupUnconfirmed; }
	catch { evidence.cleanup = false; evidence.passed = false; process.exitCode = 1; }
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	console.log(JSON.stringify(evidence));
}
