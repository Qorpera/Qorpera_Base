import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// This driver never reads a deployment URL, account credential, or provider key.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-runtime-provenance-${randomBytes(6).toString("hex")}`;
const volume = `${container}-data`;
const environmentId = "29000000-0000-4000-8000-000000000020";
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const upgradePsql = psql.map((value) => value === "qorpera_test" ? "qorpera_upgrade_provenance" : value);
const authorityPsql = psql.map((value) => value === "qorpera_test" ? "qorpera_upgrade_authority" : value);
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const claims = `set local "request.jwt.claims" = '{"role":"service_role"}';`;
// Split-owner path helper grants, keyed by the migration that (re)creates the helper.
const laterPathHelpers = new Map([
	["20260920001000_", ["qorpera_agent_creatable_path_kind(text)", "qorpera_company_path_allowed(jsonb,text,text)"]],
	["20260922170000_", ["qorpera_company_path_allowed(jsonb,text,text)"]],
	["20260924020000_", ["qorpera_company_path_allowed(jsonb,text,text)"]],
	["20260926035000_", ["qorpera_assert_agent_default_delegation(uuid,uuid)"]],
]);

function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
	if (result.error || result.status !== 0) throw new Error(`Disposable provenance database command failed: ${result.error ?? result.stderr}`);
	return result.stdout;
}
const sql = (body) => docker(psql, body);
const native = (body) => `begin; ${claims} set local role service_role; ${body} commit;`;
const nativeJson = (body) => JSON.parse(sql(native(body)).trim());

async function ready() {
	let consecutive = 0;
	for (let attempt = 0; attempt < 60 && consecutive < 2; attempt++) {
		const result = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "qorpera_test"], { timeout: 2000 });
		consecutive = result.status === 0 ? consecutive + 1 : 0;
		if (consecutive < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(consecutive, 2, "Disposable PostgreSQL must become ready");
}

function concurrent(body, connection = psql) {
	const child = spawn("docker", connection, { stdio: ["pipe", "pipe", "pipe"] });
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	let output = "";
	let error = "";
	return new Promise((resolve, reject) => {
		child.stdout.on("data", (bytes) => { output += bytes.toString(); });
		child.stderr.on("data", (bytes) => { error += bytes.toString(); });
		child.on("error", reject);
		child.on("close", (status) => status === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(error)));
		child.stdin.end(body);
	}).finally(() => clearTimeout(timer));
}

let started = false;
let createdVolume = false;
try {
	const bundle = await generateCloudRuntimeBundle(true);
	docker(["volume", "create", "--label", "qorpera.test=runtime-provenance", volume]);
	createdVolume = true;
	docker(["run", "-d", "--rm", "--name", container, "--label", "qorpera.test=runtime-provenance",
		"-e", "POSTGRES_PASSWORD=qorpera-test-only", "-e", "POSTGRES_DB=qorpera_test",
		"--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, POSTGRES_IMAGE]);
	started = true;
	await ready();
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	const fixture = readFileSync(join(root, "supabase/tests/290_company_file_path_gateway.test.sql"), "utf8");
	const admissionMarker = "-- Admission is durable across hosts";
	assert.equal(fixture.split(admissionMarker).length, 2, "Real native admission setup marker must be unique");
	const privateMarker = "select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');\nset local role authenticated;\nselect set_config('qorpera_test.path_identity'";
	const nativeSetup = fixture.split(admissionMarker)[0];
	assert.equal(nativeSetup.split(privateMarker).length, 2, "Private audience must be set before canonical input admission");
	const privateSetup = nativeSetup.replace(privateMarker, () => `
		update public.qorpera_shared_sessions set audience_kind='member_private',audience_user_id='29000000-0000-4000-8000-000000000001'
		where id='29000000-0000-4000-8000-000000000040';
			${privateMarker}`);
	const grantMarker = "-- Shared reads have an explicit, revocable default grant (20260828020700).";
	const denialMarker = "set local role service_role;\ndo $$\nbegin\n\tbegin\n\t\tperform public.qorpera_read_company_path";
	assert.equal(privateSetup.split(grantMarker).length, 2, "Default grant setup marker must be unique");
	assert.equal(privateSetup.split(denialMarker).length, 2, "Grant denial setup marker must be unique");
	const defaultGrantSetup = privateSetup.slice(privateSetup.indexOf(grantMarker), privateSetup.indexOf(denialMarker));
	// The current fixture proves the default read and revokes it through the
	// owner RPC before testing denial. Before 20700 there is no default grant:
	// omit only its read/revocation setup, retaining the same denial and explicit
	// grant assertions when admitting the historical pre-19700 private run.
	const historicalPrivateSetup = privateSetup.replace(defaultGrantSetup, "select pg_temp.path_claims('service_role');\n");
	const acknowledge = `
		create function pg_temp.path_ack(p_binding jsonb) returns jsonb language sql as $$
			select public.qorpera_send_native_agent_message((p_binding->>'leaseId')::uuid,(p_binding->>'runId')::uuid,
				(p_binding->>'jobId')::uuid,(p_binding->>'runnerId')::uuid,(p_binding->>'assignmentId')::uuid,
				(p_binding->>'credentialCapsuleId')::uuid,(p_binding->>'computeIdentityId')::uuid,
				'openai','codex-cli','provenance-ack','Checking the authorized company state.','progress')
		$$;
		set local role service_role;
		select pg_temp.path_ack(current_setting('qorpera_test.path_binding')::jsonb);
		reset role;
	`;
	// SQL 290 now owns both human-turn acknowledgements and their exact send
	// counts. The private prefix ends before that send, so supply just its ack.
	const currentPrivateSetup = privateSetup + acknowledge;
	let upgradeReady = false;
	let authorityReady = false;
	for (const migration of migrations) {
		if (migration.startsWith("20260905000400_")) {
			sql("create role runtime_timezone_validator_owner nologin;");
			const owners = `grant usage on schema public to runtime_timezone_validator_owner;
				grant execute on all functions in schema public to runtime_timezone_validator_owner;
				alter function public.qorpera_cloud_routine_trigger_valid(jsonb) owner to runtime_timezone_validator_owner;
				alter function public.qorpera_cloud_routine_trigger_before_wake_bus(jsonb) owner to runtime_timezone_validator_owner;`;
			sql(owners);
			docker(upgradePsql, owners);
			docker(authorityPsql, owners);
		}
		if (migration.startsWith("20260828018200_")) {
			docker(["exec", container, "createdb", "-U", "postgres", "-T", "qorpera_test", "qorpera_upgrade_authority"]);
			const authorityFixture = readFileSync(join(root, "supabase/tests/307_cloud_secret_member_authority.test.sql"), "utf8");
			const marker = "-- Current member authority:";
			assert.equal(authorityFixture.split(marker).length, 2);
			docker(authorityPsql, `${authorityFixture.split(marker)[0]}
				insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
					connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
				values ('30700000-0000-4000-8000-000000000090','30700000-0000-4000-8000-000000000010',
					'30700000-0000-4000-8000-000000000020','30700000-0000-4000-8000-000000000050',
					'30700000-0000-4000-8000-000000000030','linear','issue_create',1,'linear_issue_create',
					'30700000-0000-4000-8000-000000000003');
				insert into public.qorpera_cloud_secret_capture_tickets(id,profile_id,environment_id,broker_authority_id,key_id,
					secret_id,target_version,owner_kind,connector_id,secret_name,purpose,capture_capability_sha256,created_by_user_id,expires_at)
				values ('30700000-0000-4000-8000-000000000091','30700000-0000-4000-8000-000000000010',
					'30700000-0000-4000-8000-000000000020','30700000-0000-4000-8000-000000000040','fixture-key',
					'30700000-0000-4000-8000-000000000092',1,'company','linear','outsider_capture','Pre-correction capture',
					repeat('c',64),'30700000-0000-4000-8000-000000000003',clock_timestamp()+interval '10 minutes');
				commit;`);
			authorityReady = true;
		}
		if (migration.startsWith("20260828019700_")) {
			// Preserve real v1 admitted work, then prove that additive migration
			// does not invent an effort or rewrite its historical bundle/input.
			docker(["exec", container, "createdb", "-U", "postgres", "-T", "qorpera_test", "qorpera_upgrade_provenance"]);
			docker(upgradePsql, `${historicalPrivateSetup}
				create table public.qorpera_test_provenance_history as
				select current_setting('qorpera_test.path_binding')::jsonb as binding,to_jsonb(run) as run,
					(select jsonb_agg(to_jsonb(input) order by input.id) from public.qorpera_session_inputs input
					 where input.id = any(run.input_ids)) as inputs
				from public.qorpera_execution_runs run where run.id = (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
				commit;`);
			upgradeReady = true;
		}
		if (migration.startsWith("20260828019850_")) {
			// Existing definer owners can differ from the applying migration role.
			// New helpers must receive exact owner grants, not PUBLIC execution.
			sql("create role runtime_path_owner nologin bypassrls;");
			const owners = `grant usage on schema public,auth,extensions to runtime_path_owner;
				grant all on all tables in schema public to runtime_path_owner;
				grant usage on all sequences in schema public to runtime_path_owner;
				grant execute on all functions in schema public,auth,extensions to runtime_path_owner;
				alter function public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb) owner to runtime_path_owner;
				alter function public.qorpera_commit_company_path_mutation(uuid,jsonb,jsonb,uuid,text) owner to runtime_path_owner;
				alter function public.qorpera_get_company_path_proposal(uuid) owner to runtime_path_owner;
				alter function public.qorpera_list_company_path_proposals(uuid,uuid,integer) owner to runtime_path_owner;
				alter function public.qorpera_review_company_path_proposal(uuid,text,text) owner to runtime_path_owner;
				alter function public.qorpera_company_path_approved_actor(uuid,text) owner to runtime_path_owner;`;
			sql(owners);
			docker(upgradePsql, owners);
			docker(authorityPsql, owners);
		}
		try {
			const body = readFileSync(join(root, "supabase/migrations", migration), "utf8");
			sql(body);
			if (upgradeReady) docker(upgradePsql, body);
			if (authorityReady) docker(authorityPsql, body);
		}
		catch (error) { throw new Error(`Migration ${migration} failed`, { cause: error }); }
		if (migration.startsWith("20260828005000_")) {
			// Stable read-retention entrypoint and later helpers have distinct owners.
			sql(`create role runtime_retention_owner nologin; grant usage on schema public,extensions to runtime_retention_owner;
				grant select on all tables in schema public to runtime_retention_owner;
				alter default privileges in schema public grant select on tables to runtime_retention_owner;
				alter function public.qorpera_company_retained_object_hashes(uuid) owner to runtime_retention_owner;
				grant execute on function public.qorpera_company_additional_retained_object_hashes(uuid) to runtime_retention_owner;`);
		}
		// These later migrations (re)create a path helper, revoke PUBLIC execution and
		// grant no other owner. Production keeps one owner (postgres) for every definer
		// that calls them, so only the split path owner above needs the grant, given
		// right after the migration that creates each one: a later re-creation that
		// drops it again still fails here.
		const pathHelpers = laterPathHelpers.get(migration.slice(0, 15));
		if (pathHelpers) {
			const grant = `grant execute on function ${pathHelpers.map((name) => `public.${name}`).join(",")} to runtime_path_owner;`;
			sql(grant);
			docker(upgradePsql, grant);
			docker(authorityPsql, grant);
		}
	}
	assert.equal(sql("select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle;").trim(), bundle.sha256);
	assert.deepEqual(JSON.parse(sql(`select bundle.manifest from public.qorpera_runtime_bundles bundle
		join public.qorpera_active_runtime_bundle active on active.runtime_bundle_id=bundle.id
			and active.runtime_bundle_sha256=bundle.sha256;`).trim()), bundle.manifest);
	console.log(`PASS: ${migrations.length} migrations, source/SQL manifest parity, split-owner retention grants`);
	assert.equal(authorityReady, true);
	assert.equal(docker(authorityPsql, `select grant_row.status='revoked' and secret.status='active'
		and grant_row.issued_by_user_id='30700000-0000-4000-8000-000000000003'
		and (select count(*)=1 from public.qorpera_cloud_secret_audit_events where grant_id=grant_row.id and event_type='grant_revoked')
		from public.qorpera_cloud_secret_operation_grants grant_row join public.qorpera_cloud_secrets secret on secret.id=grant_row.secret_id
		where grant_row.id='30700000-0000-4000-8000-000000000090';`).trim(), "t");
	assert.equal(docker(authorityPsql, `select status from public.qorpera_cloud_secret_capture_tickets
		where id='30700000-0000-4000-8000-000000000091';`).trim(), "cancelled");
	console.log("PASS: upgrade quarantines outsider-issued grants and capture tickets without changing custody or audit identity");
	for (const kind of ["grant", "capture"]) {
		docker(authorityPsql, "update public.qorpera_profile_members set role='admin' where user_id='30700000-0000-4000-8000-000000000005';");
		const create = kind === "grant"
			? `public.qorpera_grant_cloud_secret_operation('30700000-0000-4000-8000-000000000010',
				'30700000-0000-4000-8000-000000000020','30700000-0000-4000-8000-000000000050',
				'30700000-0000-4000-8000-000000000030','linear','issue_create',1) ->> 'grantId'`
			: `public.qorpera_begin_cloud_secret_capture('30700000-0000-4000-8000-000000000010',
				'30700000-0000-4000-8000-000000000020','company',null,'linear','concurrent_capture','Concurrent capture') ->> 'ticketId'`;
		const writer = concurrent(`begin;
			set local "request.jwt.claims"='{"role":"authenticated","sub":"30700000-0000-4000-8000-000000000005"}';
			set local role authenticated; select jsonb_build_object('id',${create}); reset role;
			select pg_advisory_xact_lock(18200,307); select pg_sleep(1.5); commit;`, authorityPsql);
		// Handle rejection while checking the independent lock barrier; await it
		// below so a failed writer is never mistaken for a concurrency proof.
		writer.catch(() => undefined);
		let atBarrier = false;
		// A loaded Docker host can take seconds to start the writer's psql.
		for (let attempt = 0; attempt < 200 && !atBarrier; attempt++) {
			atBarrier = sql("select exists(select 1 from pg_locks where locktype='advisory' and classid=18200 and objid=307 and granted);").trim() === "t";
			if (!atBarrier) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(atBarrier, true, "Writer must hold its membership lock before concurrent revocation");
		const revoke = concurrent(`begin; set local lock_timeout='3s';
			set local "request.jwt.claims"='{"role":"authenticated","sub":"30700000-0000-4000-8000-000000000001"}';
			set local role authenticated;
			select public.qorpera_update_profile_member_role('30700000-0000-4000-8000-000000000010',
				'30700000-0000-4000-8000-000000000005','contributor'); commit;`, authorityPsql);
		const [created] = await Promise.all([writer, revoke]);
		const table = kind === "grant" ? "qorpera_cloud_secret_operation_grants" : "qorpera_cloud_secret_capture_tickets";
		assert.equal(docker(authorityPsql, `select status from public.${table} where id=${literal(created.id)};`).trim(),
			kind === "grant" ? "revoked" : "cancelled");
	}
	console.log("PASS: concurrent grant/capture issuance and member downgrade serialize without surviving authority");
	assert.equal(upgradeReady, true);
	docker(upgradePsql, `select set_config('qorpera_test.expected_runtime_bundle',${literal(bundle.sha256)},false);\n${
		readFileSync(join(root, "supabase/tests/fixtures/runtime-provenance-upgrade.sql"), "utf8")}`);
	console.log("PASS: historical private v1 run/input preservation, unknown effort retained, incompatible execution denied, member removal");
	for (const file of ["305_cloud_secret_custody.test.sql", "306_governed_company_computer_privileges.test.sql",
		"307_cloud_secret_member_authority.test.sql", "310_company_organization_kernel.test.sql", "315_runtime_step0_staff_lifecycle.test.sql",
		"325_runtime_time_zone_catalog.test.sql"]) {
		sql(readFileSync(join(root, "supabase/tests", file), "utf8"));
		console.log(`PASS: ${file}`);
	}
	sql(`${currentPrivateSetup}\n${readFileSync(join(root, "supabase/tests/fixtures/runtime-audience-cases.sql"), "utf8")}`);
	console.log("PASS: private native reads, explicit publication consent, private draft visibility, membership removal and preserved history");
	const marker = "-- Human content reads bind a current path/version";
	assert.equal(fixture.split(marker).length, 2, "Real path fixture integration marker must be unique");
	const cases = readFileSync(join(root, "supabase/tests/fixtures/runtime-provenance-cases.sql"), "utf8");
	assert.match(fixture, /rollback;\s*$/i);
	sql(fixture.replace(marker, () => `${cases}\n${marker}`).replace(/rollback;\s*$/i, `
		create table public.qorpera_test_provenance_binding as select current_setting('qorpera_test.path_binding')::jsonb as binding;
		commit;`));
	console.log("PASS: real admission, incompatible-bundle/binary/effort rejection, exact reads, CAS, privacy, context views and completion");
	const binding = JSON.parse(sql("select binding from public.qorpera_test_provenance_binding;").trim());
	const argument = `${literal(environmentId)}::uuid,${json(binding)}`;
	const catalog = { type: "namespace", name: "qorpera", description: "Synthetic restart proof", tools: [{
		type: "function", name: "company_read", description: "Synthetic read", inputSchema: { type: "object", additionalProperties: false },
	}] };
	nativeJson(`select public.qorpera_begin_native_company_execution_v2(${json(binding)},${literal(bundle.manifest.nativeBinarySha256)},
		${literal(bundle.sha256)},${literal(bundle.modelPolicySha256)},${literal(JSON.stringify(catalog))},${literal("c".repeat(64))},10);`);
	const read = nativeJson(`select public.qorpera_read_company_path_v2(${literal(environmentId)},'note.md',0,16,${json(binding)});`);
	nativeJson(`select public.qorpera_confirm_company_path_read(${argument},${literal(read.readObservationId)}::uuid,4,${literal("a".repeat(64))});`);
	const view = { schema: "qorpera.native-context-view/v1", requestId: "restart-view", threadId: "thread", turnId: "turn", purpose: "turn", outputs: [{
		callId: "read", kind: "function_call_output", sha256: "b".repeat(64), bytes: 700,
		readId: read.readObservationId, readSha256: "a".repeat(64), includedBytes: 4, includedSha256: "d".repeat(64),
	}] };
	const statement = `select public.qorpera_record_native_context_view(${argument},${json(view)});`;
	const [first, second] = await Promise.all([concurrent(native(statement)), concurrent(native(statement))]);
	assert.deepEqual(first, second, "Concurrent identical requests must return one durable context receipt");
	docker(["restart", container]);
	await ready();
	assert.deepEqual(nativeJson(statement), first, "PostgreSQL restart must preserve the exact context receipt");
	assert.equal(sql(`select count(*) from public.qorpera_native_context_views where run_id=${literal(binding.runId)};`).trim(), "1");
	const compacted = nativeJson(`select public.qorpera_record_native_context_view(${argument},${json({ ...view, requestId: "after-restart", purpose: "compaction", outputs: [] })});`);
	assert.equal(compacted.ordinal, 2);
	assert.equal(sql(`select parent_id from public.qorpera_native_context_views where id=${literal(compacted.viewId)};`).trim(), first.viewId);
	console.log("PASS: concurrent context receipt deduplication, database restart, replay and compaction ancestry");
} finally {
	if (started) docker(["rm", "-f", container]);
	if (createdVolume) docker(["volume", "rm", volume]);
	console.log(started || createdVolume
		? `Removed disposable provenance database and its test-only volume: ${container}`
		: "No disposable provenance resources were created.");
}
