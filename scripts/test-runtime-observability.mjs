import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Disposable local PostgreSQL only. No deployment URL, real credentials,
// provider calls, runtime-bundle regeneration, or production schema writes.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-runtime-observability-${randomBytes(6).toString("hex")}`;
const volume = `${container}-data`;
const migrationName = "20260828019970_runtime_operational_observability.sql";
const memberMigrationName = "20260828019971_member_object_observation_identity.sql";
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"];
const upgradePsql = psql.map((value) => value === "qorpera_test" ? "qorpera_observability_upgrade" : value);
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const claims = `set local "request.jwt.claims"='{"role":"service_role"}'; set local role service_role;`;

function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
	if (result.error || result.status !== 0) throw new Error(`Disposable observability database command failed: ${result.error ?? result.stderr}`);
	return result.stdout;
}
const sql = (body) => docker(psql, body);
const upgradeSql = (body) => docker(upgradePsql, body);
const native = (body) => `begin; set local statement_timeout='10s'; ${claims} ${body} commit;`;
const nativeJson = (body) => JSON.parse(sql(native(body)).trim());

async function ready() {
	let consecutive = 0;
	for (let attempt = 0; attempt < 60 && consecutive < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "qorpera_test"], { timeout: 2000 });
		consecutive = result.status === 0 ? consecutive + 1 : 0;
		if (consecutive < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(consecutive, 2, "Final PostgreSQL TCP listener must be ready");
}

function concurrent(body) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", psql, { stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		let error = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.length > 1_048_576) child.kill("SIGKILL"); });
		child.stderr.on("data", (bytes) => { error += bytes.toString(); if (error.length > 1_048_576) child.kill("SIGKILL"); });
		child.on("error", (failure) => { clearTimeout(timer); reject(failure); });
		child.on("close", (status) => {
			clearTimeout(timer);
			if (status !== 0) { reject(new Error(`Concurrent diagnostic fixture failed: ${error}`)); return; }
			try { resolve(JSON.parse(output.trim())); } catch (failure) { reject(failure); }
		});
		child.stdin.end(body);
	});
}

function event(binding, changes = {}) {
	return {
		schema: "qorpera.runtime-observation/v1", attemptId: randomUUID(), parentAttemptId: null,
		assignmentId: binding.assignmentId, phase: "start", operation: "model_turn", logicalOperationSha256: null,
		observedAt: "2026-08-31T12:00:00.000Z", durationMs: null, status: "started", errorCategory: null,
		receiptId: null, readId: null, inputBytes: null, outputBytes: null, inputTokens: null, outputTokens: null,
		cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null, totalTokens: null, ...changes,
	};
}

let started = false;
let createdVolume = false;
try {
	docker(["volume", "create", "--label", "qorpera.test=runtime-observability", volume]);
	createdVolume = true;
	docker(["run", "-d", "--rm", "--name", container, "--label", "qorpera.test=runtime-observability",
		"-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=qorpera_test",
		"--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, POSTGRES_IMAGE]);
	started = true;
	await ready();
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	assert.equal(migrations.filter((name) => name === migrationName).length, 1);
	const fixture = readFileSync(join(root, "supabase/tests/290_company_file_path_gateway.test.sql"), "utf8");
	const marker = "-- Human content reads bind a current path/version";
	assert.equal(fixture.split(marker).length, 2, "Real admission/first-mutation fixture boundary must be unique");
	const originalSetup = fixture.split(marker)[0];
	// The older single-company fixture's two graph SELECTs assume a globally
	// unique empty-tree cache row. These tests deliberately admit three companies.
	const cachePredicate = "where sha256 = current_setting('qorpera_test.path_tree');";
	assert.equal(originalSetup.split(cachePredicate).length, 3);
	const setup = originalSetup.replaceAll(cachePredicate,
		"where sha256 = current_setting('qorpera_test.path_tree') and profile_id='29000000-0000-4000-8000-000000000010';");
	const keep = (prefix) => `${setup.replaceAll("29000000-", `${prefix}00000-`)}
		insert into public.qorpera_test_observability_bindings(label,binding)
		values (${literal(prefix)},current_setting('qorpera_test.path_binding')::jsonb); commit;`;
	let history;
	let upgradeReady = false;
	let memberIdentityChecked = false;
	const canonicalHistory = "select jsonb_build_object('runs',count(*),'events',(select count(*) from public.qorpera_execution_run_events),'receipts',(select count(*) from public.qorpera_run_operation_receipts)) from public.qorpera_execution_runs;";
	const memberFunctionIdentity = `select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig)
		from pg_proc where oid='public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text)'::regprocedure;`;
	for (const migration of migrations) {
		if (migration === migrationName) {
			sql("create table public.qorpera_test_observability_bindings(label text primary key,binding jsonb not null);");
			// Keep the primary pristine for the exact standalone SQL290 test.
			// Its historical fixture intentionally assumes one company per database.
			docker(["exec", container, "createdb", "-U", "postgres", "-T", "qorpera_test", "qorpera_observability_upgrade"]);
			upgradeReady = true;
			upgradeSql(keep("292"));
			history = upgradeSql(canonicalHistory);
		}
		const memberBefore = migration === memberMigrationName ? [sql(memberFunctionIdentity), upgradeSql(memberFunctionIdentity)] : null;
		try {
			const body = readFileSync(join(root, "supabase/migrations", migration), "utf8");
			sql(body);
			if (upgradeReady) upgradeSql(body);
		}
		catch (failure) { throw new Error(`Migration ${migration} failed`, { cause: failure }); }
		if (memberBefore) {
			assert.deepEqual([sql(memberFunctionIdentity), upgradeSql(memberFunctionIdentity)], memberBefore,
				"Member observation metadata must preserve exact authority OID/owner/ACL/proconfig in both databases");
			memberIdentityChecked = true;
		}
	}
	assert.equal(upgradeReady, true);
	assert.equal(memberIdentityChecked, true);
	assert.equal(upgradeSql(canonicalHistory), history);
	assert.equal(upgradeSql("select count(*) from public.qorpera_runtime_observations;").trim(), "0");
	assert.equal(sql("select count(*) from public.qorpera_runtime_observations;").trim(), "0");
	assert.equal(sql("select count(*) from public.qorpera_object_reachability_graphs where id='29000000-0000-4000-8000-000000000027';").trim(), "0", "Upgrade fixture must use its separate graph identity");
	console.log(`PASS: ${migrations.length} migrations; upgrade preserves existing run/events/receipts without invented diagnostics`);
	console.log("PASS: member object authority OID/owner/ACL/proconfig preserved through 19971 in pristine and admitted-run databases");
	for (const name of ["290_company_file_path_gateway.test.sql", "320_runtime_operational_observability.test.sql",
		"306_governed_company_computer_privileges.test.sql", "321_member_object_observation_identity.test.sql",
		"330_company_execution_no_ceilings.test.sql"]) {
		sql(readFileSync(join(root, "supabase/tests", name), "utf8"));
		console.log(`PASS: ${name}`);
	}
	sql(keep("290"));
	sql(keep("291"));
	const bindings = Object.fromEntries(JSON.parse(sql("select jsonb_agg(jsonb_build_array(label,binding) order by label) from public.qorpera_test_observability_bindings;").trim()));
	const first = bindings["290"];
	const second = bindings["291"];
	const record = (run, observation) => `select public.qorpera_record_runtime_observation(${literal(run)},${json(observation)});`;
	const observation = event(first);
	const results = await Promise.all(Array.from({ length: 4 }, () => concurrent(native(record(first.runId, observation)))));
	assert.equal(results.filter((value) => value.replayed === false).length, 1);
	for (const result of results) assert.deepEqual({ ...result, replayed: false }, { ...results[0], replayed: false });
	assert.equal(sql(`select count(*) from public.qorpera_runtime_observations where run_id=${literal(first.runId)};`).trim(), "1");
	console.log("PASS: four concurrent deliveries create one immutable event and one server-ingest timestamp");
	const rollbackEvent = event(first);
	sql(`begin; ${claims} ${record(first.runId, rollbackEvent)} rollback;`);
	assert.equal(sql(`select count(*) from public.qorpera_runtime_observations where attempt_id=${literal(rollbackEvent.attemptId)};`).trim(), "0");
	assert.equal(nativeJson(record(first.runId, rollbackEvent)).replayed, false);
	const finishFirst = event(first, { phase: "finish", status: "failed", errorCategory: "transport_unavailable", durationMs: 19 });
	const finishReceipt = nativeJson(record(first.runId, finishFirst));
	const start = { ...finishFirst, phase: "start", status: "started", errorCategory: null, durationMs: null };
	nativeJson(record(first.runId, start));
	docker(["restart", container]);
	await ready();
	assert.deepEqual(nativeJson(record(first.runId, finishFirst)), { ...finishReceipt, replayed: true });
	console.log("PASS: interrupted transaction leaves no event; finish-before-start and exact replay survive PostgreSQL restart");
	const receiptId = sql(`select id from public.qorpera_run_operation_receipts where run_id=${literal(first.runId)} limit 1;`).trim();
	const read = nativeJson(`select public.qorpera_read_company_path_v2('29000000-0000-4000-8000-000000000020','note.md',0,8,${json(first)});`);
	for (const [field, id] of [["assignmentId", first.assignmentId], ["receiptId", receiptId], ["readId", read.readObservationId]]) {
		const cross = event(second, { [field]: id });
		sql(native(`do $$ begin begin
			perform public.qorpera_record_runtime_observation(${literal(second.runId)},${json(cross)});
			raise exception 'Cross-run diagnostic reference accepted'; exception when insufficient_privilege then null; end; end $$;`));
	}
	assert.equal(sql(`select count(*) from public.qorpera_runtime_observations where run_id=${literal(second.runId)};`).trim(), "0");
	console.log("PASS: real other-run assignment, operation receipt, and read observation references are rejected");
	const query = nativeJson(`select public.qorpera_get_runtime_operational_run(${literal(first.runId)},1);`);
	assert.equal(query.sections.diagnostics.truncated, true);
	assert.equal(query.coverage.providerRequestTiming, "unavailable");
	assert.equal(query.identity.companyId, "29000000-0000-4000-8000-000000000010");
	console.log("PASS: bounded operator projection retains missing/unknown/provider-timing limitations");
} finally {
	if (started) docker(["rm", "-f", container]);
	if (createdVolume) docker(["volume", "rm", volume]);
	console.log(started || createdVolume
		? `Removed disposable observability database and its test-only volume: ${container}`
		: "No disposable observability resources were created.");
}
