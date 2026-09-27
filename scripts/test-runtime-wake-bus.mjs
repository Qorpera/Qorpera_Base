import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

// Disposable local verification. --integration also runs the real completion
// and effect entrypoints, without replacing shared enforcement helpers. It is
// intentionally nonzero until those main-owned integration gates pass.
// No external database URL, provider or desktop executor is accepted.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let integration = false;
let reportPath;
for (let index = 2; index < process.argv.length; index++) {
	const argument = process.argv[index];
	if (argument === "--integration" && !integration) integration = true;
	else if (argument === "--report" && !reportPath && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
		reportPath = resolve(process.argv[++index]);
	} else throw new Error("Usage: node scripts/test-runtime-wake-bus.mjs [--integration] [--report PATH]");
}
const report = {
	schema: "qorpera.wake-verification/v1",
	startedAt: new Date().toISOString(),
	node: process.version,
	postgresImage: POSTGRES_IMAGE,
	databaseCloneStrategy: "FILE_COPY",
	sequenceSnapshots: [],
	baselineUpgrade: { status: "not-run", checks: [] },
	component: { status: "not-run", checks: [] },
	databaseIntegration: { status: "not-run", appliedMigrations: [], regressions: { status: "not-run", checks: [] }, cases: [] },
	providerInvoked: false,
	deployedAcceptance: false,
	remainingExternalGates: ["cloud-room-membership-and-fanout", "native-hire-and-recovery-producers",
		"human-owned-autonomous-consent", "full-runtime-bundle", "native-host-tool-and-context-wiring", "deployed-cloud-acceptance"],
};
const container = `qorpera-wake-test-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${container}-data`;
const migrationName = "20260828020000_runtime_wake_bus.sql";
const migration = readFileSync(join(root, "supabase/migrations", migrationName), "utf8");
const policyMigrationName = "20260828020500_runtime_wake_policy_admission.sql";
const policyMigration = readFileSync(join(root, "supabase/migrations", policyMigrationName), "utf8");
report.componentMigrations = [
	{ name: migrationName, sha256: createHash("sha256").update(migration).digest("hex") },
	{ name: policyMigrationName, sha256: createHash("sha256").update(policyMigration).digest("hex") },
];
const componentTest = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8");
const marker = "-- END WAKE FIXTURE";
assert(componentTest.includes(marker), "Wake fixture marker missing");
const fixture = componentTest.slice(0, componentTest.indexOf(marker));
const helperStart = componentTest.indexOf("-- BEGIN WAKE HELPERS");
const helperEnd = componentTest.indexOf("-- END WAKE HELPERS");
assert(helperStart >= 0 && helperEnd > helperStart, "Wake helper markers missing");
const helpers = componentTest.slice(helperStart, helperEnd);
const storageHelperStart = componentTest.indexOf("create function pg_temp.path_claims");
const storageHelperEnd = componentTest.indexOf("select pg_temp.path_claims('service_role');");
const mutationHelperStart = componentTest.indexOf("create function pg_temp.path_plan");
assert(storageHelperStart >= 0 && storageHelperEnd > storageHelperStart && mutationHelperStart > storageHelperEnd,
	"Transaction fixture helper markers missing");
const transactionHelpers = componentTest.slice(storageHelperStart, storageHelperEnd) + componentTest.slice(mutationHelperStart, helperEnd);
const service = "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false);\n";
const environment = "30000000-0000-4000-8000-000000000020";
const profile = "30000000-0000-4000-8000-000000000010";
const bob = "30000000-0000-4000-8000-000000000031";
const carol = "30000000-0000-4000-8000-000000000032";
const humanBinding = `(select jsonb_build_object('leaseId',l.id,'runId',r.id,'jobId',r.job_id,'runnerId',l.runner_id,
 'assignmentId',l.assignment_id,'credentialCapsuleId',l.credential_capsule_id,'computeIdentityId',l.compute_identity_id,
 'provider','openai','nativeHarness','codex-cli','model',r.model_id)
 from public.qorpera_native_provider_connection_leases l join public.qorpera_execution_runs r on r.id=l.run_id
 where r.profile_id='${profile}' and r.source_kind='session_turn')`;
const transactionContext = transactionHelpers + `
select set_config('qorpera_test.wake_binding',${humanBinding}::text,false);
select set_config('qorpera_test.wake_sponsor',(select jsonb_build_object('binding_id',sponsor_binding_id)::text
 from public.qorpera_execution_runs where profile_id='${profile}' and source_kind='session_turn'),false);
`;

function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || result.stdout);
	return result.stdout.trim();
}
function psqlArgs(database) {
	return ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database];
}
function sql(database, query) {
	return docker(psqlArgs(database), query);
}
async function ready() {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "wake_baseline"], { stdio: "ignore" }).status === 0) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error("Disposable PostgreSQL did not start");
}
function concurrentSql(database, query) {
	return new Promise((resolveResult, reject) => {
		const child = spawn("docker", psqlArgs(database));
		let output = "";
		let error = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { error += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolveResult(output.trim()) : reject(new Error([output, error].filter(Boolean).join("\n"))));
		child.stdin.end(query);
	});
}
async function waitForLock(database, application) {
	const deadline = Date.now() + 3_000;
	do {
		if (sql(database, `select count(*) from pg_stat_activity where datname='${database}'
 and application_name='${application}' and wait_event_type='Lock';`) === "1") return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	} while (Date.now() < deadline);
	throw new Error(`Expected ${application} to block at the transaction barrier`);
}
async function barrierTransaction(database, query, whileOpen, finish = "interrupt") {
	const application = `wake-crash-${randomBytes(4).toString("hex")}`;
	const child = spawn("docker", psqlArgs(database));
	let error = "";
	const finished = new Promise((resolveExit) => child.on("close", resolveExit));
	child.stderr.on("data", (chunk) => { error += chunk.toString(); });
	try {
		await new Promise((resolveReady, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Crash fixture did not reach its barrier: ${error}`)), 10_000);
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (output.includes("WAKE_TRANSACTION_READY")) { clearTimeout(timeout); resolveReady(); }
			});
			child.on("error", (cause) => { clearTimeout(timeout); reject(cause); });
			child.on("close", (code) => {
				clearTimeout(timeout);
				if (!output.includes("WAKE_TRANSACTION_READY")) reject(new Error(error || `Barrier process exited early (${code})`));
			});
			child.stdin.write(`begin; set application_name='${application}';\n${service}${query}\nselect 'WAKE_TRANSACTION_READY';\n`);
		});
		if (whileOpen) await whileOpen();
		if (finish === "commit") {
			child.stdin.end("commit;\n");
			if (await finished !== 0) throw new Error(error || "Barrier transaction did not commit");
		} else {
			// Terminate the exact uncommitted backend to prove atomic rollback.
			assert.equal(sql(database, `select pg_terminate_backend(pid) from pg_stat_activity where application_name='${application}';`), "t");
		}
	} finally {
		if (!child.stdin.writableEnded) child.stdin.end();
		if (child.exitCode === null) child.kill("SIGTERM");
		await finished;
	}
}
function clone(database, template) {
	// Avoid PostgreSQL 17 WAL_LOG template cloning losing copied sequence state
	// on restart. FILE_COPY affects fixture creation only; no sequence is reset.
	// https://www.postgresql.org/message-id/CAEVT6c9mOHUR9N4UPryq%3Dj997Az00SFO3zjgD5-a4R500tDCkA%40mail.gmail.com
	docker(["exec", container, "createdb", "-U", "postgres", "--strategy=FILE_COPY", "--template", template, database]);
}
const sequenceDiagnosticQuery = `select jsonb_build_object(
 'database',current_database(),'postmasterStart',pg_postmaster_start_time(),
 'committedEvents',(select jsonb_build_object('count',count(*),'minId',min(id)::text,'maxId',max(id)::text)
  from public.qorpera_execution_run_events),
 'lastValue',s.last_value::text,'logCount',s.log_cnt,'isCalled',s.is_called,
 'cacheSize',q.seqcache,'persistence',c.relpersistence,
 'notBehindCommittedEvents',s.is_called and s.last_value >= coalesce((select max(id) from public.qorpera_execution_run_events),0))
 from public.qorpera_execution_run_events_id_seq s
 join pg_class c on c.oid='public.qorpera_execution_run_events_id_seq'::regclass
 join pg_sequence q on q.seqrelid=c.oid`;
function sequenceDiagnostic(database, label) {
	const diagnostic = { label, ...JSON.parse(sql(database, `${sequenceDiagnosticQuery};`)) };
	report.sequenceSnapshots.push(diagnostic);
	assert.equal(diagnostic.persistence, "p", "Recovery event sequence must remain logged");
	assert.equal(diagnostic.notBehindCommittedEvents, true, `Event sequence trails committed IDs: ${JSON.stringify(diagnostic)}`);
}
function pass(target, label) {
	target.checks.push(label);
	console.log(`PASS ${label}`);
}

async function verifyDatabase(database, target) {
	const fairAdmission = sql(database, "select strpos(pg_get_functiondef('public.qorpera_drain_company_file_wakes(integer)'::regprocedure),'exception when lock_not_available')>0;") === "t";
	target.status = "running";
	const recovery = `${database}_recovery`;
	console.log(`Verifying component contracts, concurrency and recovery against ${database}`);
	sql(database, componentTest);
	pass(target, "300_runtime_wake_bus.test.sql");
	const policies = JSON.parse(readFileSync(join(root, "packages/runtime/test/fixtures/wake-policies.json"), "utf8"));
	for (const { scenario, policy, reporting: fixed } of policies) {
		// A worker-completion continuation is the one policy the kernel selects by source, not by reply policy.
		const reporting =
			fixed ?? (policy.final === "forbidden" ? "silent" : policy.final === "required" ? "required" : "optional");
		const kind = policy.kind === null ? "null" : `'${policy.kind}'`;
		const actual = JSON.parse(sql(database, `select public.qorpera_wake_policy_value(${kind},'${reporting}')::text;`));
		assert.deepEqual(actual, policy, `SQL / TypeScript fixture drift: ${scenario}`);
	}
	pass(target, "SQL / TypeScript policy fixtures match for all five kinds and closed fallback");

	const envelopes = [];
	for (const name of ["human", "first-run", "routine-default", "routine-optional", "routine-required", "routine-silent", "company-file", "agent"]) {
		let prepare = "";
		if (name === "first-run") prepare = `
 insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
 values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff',
  '30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}') returning id into v_id;
 v_run := pg_temp.wake_input_run(array[v_id]);
 v_binding := pg_temp.wake_start(v_run);`;
		else if (name.startsWith("routine-")) {
			const trigger = { id: "tick", kind: "schedule", intervalMinutes: 5 };
			if (name !== "routine-default") trigger.replyPolicy = name.slice("routine-".length);
			prepare = `
 v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030','${JSON.stringify(trigger)}');
 v_id := pg_temp.wake_schedule(v_routine,'envelope-${name}');
 perform public.qorpera_materialize_wake_execution_runs(1);
 select run_id into strict v_run from public.qorpera_wake_occurrences where id=v_id;
 v_binding := pg_temp.wake_start(v_run);`;
		} else if (name === "company-file") prepare = `
 perform pg_temp.wake_public_send(v_binding,'progress');
 v_routine := pg_temp.wake_routine('${bob}',
  '{"id":"changes","kind":"listener","source":"company-file","path":"note.md","match":"exact","timeZone":"UTC","replyPolicy":"optional"}');
 v_result := pg_temp.path_commit(pg_temp.path_plan('envelope-file','note.md',pg_temp.path_stage_file('note.md','Authorized event')));
 perform public.qorpera_materialize_wake_execution_runs(1);
 select run_id into strict v_run from public.qorpera_wake_occurrences
  where routine_id=(v_routine->>'routine_id')::uuid and file_event_id=(v_result->>'snapshotId')::uuid;
 v_binding := pg_temp.wake_start(v_run);`;
		else if (name === "agent") prepare = `
 perform pg_temp.wake_public_send(v_binding,'progress');
 v_result := public.qorpera_send_coworker_message(v_binding,'${bob}','envelope-agent','Authorized coworker message');
 perform public.qorpera_materialize_wake_execution_runs(1);
 select run_id into strict v_run from public.qorpera_wake_occurrences where id=(v_result->>'occurrenceId')::uuid;
 v_binding := pg_temp.wake_start(v_run);`;
		const output = sql(database, fixture + `
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
 v_id uuid; v_run uuid; v_routine jsonb; v_result jsonb;
begin
 ${prepare}
 perform set_config('qorpera_test.envelope_probe',jsonb_build_object('name','${name}','binding',v_binding,
  'authority',public.qorpera_describe_native_tool_authority(v_binding),
  'envelope',public.qorpera_read_native_wake(v_binding))::text,true);
end $$;
select current_setting('qorpera_test.envelope_probe');
rollback;`);
		envelopes.push(JSON.parse(output.split("\n").at(-1)));
	}
	const probe = spawnSync(process.execPath, [join(root, "scripts/test-runtime-wake-envelope.mjs")], {
		cwd: root, input: JSON.stringify(envelopes), encoding: "utf8", maxBuffer: 1024 * 1024,
	});
	if (probe.error || probe.status !== 0) throw new Error(probe.stderr || probe.error?.message || probe.stdout);
	pass(target, probe.stdout.trim());

	const delivery = `${database}_coworker`;
	clone(delivery, database);
	sql(delivery, fixture + `
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
commit;`);
	const duplicateQuery = service + `select public.qorpera_send_coworker_message(${humanBinding},'${bob}','concurrent-message','One durable message');`;
	const duplicates = await Promise.all([concurrentSql(delivery, duplicateQuery), concurrentSql(delivery, duplicateQuery)]);
	const receipts = duplicates.map((output) => JSON.parse(output.split("\n").at(-1)));
	assert.deepEqual(receipts[0], receipts[1]);
	assert.equal(receipts[0].status, "queued");
	assert.equal(sql(delivery, "select count(*) from public.qorpera_run_operation_receipts where logical_operation_key='coworker:concurrent-message';"), "1");
	assert.equal(sql(delivery, `select count(*) from public.qorpera_wake_occurrences where id='${receipts[0].occurrenceId}' and payload->>'receiptId'='${receipts[0].receiptId}';`), "1");
	const interruptedQuery = `select public.qorpera_send_coworker_message(${humanBinding},'${bob}','interrupted-message','Atomic interrupted message');`;
	await barrierTransaction(delivery, interruptedQuery);
	assert.equal(sql(delivery, "select count(*) from public.qorpera_run_operation_receipts where logical_operation_key='coworker:interrupted-message';"), "0");
	assert.equal(sql(delivery, "select count(*) from public.qorpera_wake_occurrences where wake_kind='agent';"), "1");
	const retried = JSON.parse(sql(delivery, service + interruptedQuery).split("\n").at(-1));
	const replayed = JSON.parse(sql(delivery, service + interruptedQuery).split("\n").at(-1));
	assert.deepEqual(retried, replayed);
	assert.equal(retried.status, "queued");
	assert.equal(sql(delivery, "select count(*) from public.qorpera_run_operation_receipts where logical_operation_key='coworker:interrupted-message';"), "1");
	assert.equal(sql(delivery, "select count(*) from public.qorpera_wake_occurrences where wake_kind='agent';"), "2");
	pass(target, "concurrent same-key coworker sends share one receipt/occurrence; interrupted send rolls back both before stable-key replay");

	const contention = `${database}_contention`;
	clone(contention, database);
	sql(contention, fixture + `
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select pg_temp.wake_routine('${bob}','{"id":"changes","kind":"listener","source":"company-file","path":"note.md","match":"exact","timeZone":"UTC","replyPolicy":"required"}');
select pg_temp.path_commit(pg_temp.path_plan('locked-audience','note.md',pg_temp.path_stage_file('note.md','One pending event')));
commit;`);
	const cursorBefore = sql(contention, "select to_jsonb(c)-'last_scanned_at' from public.qorpera_company_file_wake_cursors c;");
	await barrierTransaction(contention,
		"select id from public.qorpera_shared_sessions where id='30000000-0000-4000-8000-000000000042' for update;", () => {
			// Current fair admission skips contention; the historical component
			// raises 55P03. Neither may advance delivery or record a denial.
			if (fairAdmission) assert.equal(JSON.parse(sql(contention, service + "set statement_timeout='2s'; select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1)).admitted, 0);
			else sql(contention, service + helpers + `
set statement_timeout='2s';
select pg_temp.wake_error('select public.qorpera_drain_company_file_wakes(1)','55P03');`);
			assert.equal(sql(contention, "select to_jsonb(c)-'last_scanned_at' from public.qorpera_company_file_wake_cursors c;"), cursorBefore);
			assert.equal(sql(contention, "select count(*) from public.qorpera_company_file_wake_claims;"), "0");
			assert.equal(sql(contention, "select count(*) from public.qorpera_wake_occurrences;"), "1");
		});
	const afterRelease = JSON.parse(sql(contention, service + "select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1));
	assert.equal(afterRelease.admitted, 1);
	assert.equal(sql(contention, "select count(*) from public.qorpera_company_file_wake_claims where outcome='admitted';"), "1");
	assert.equal(sql(contention, "select count(*) from public.qorpera_wake_occurrences where source_kind='company-file';"), "1");
	assert.equal(JSON.parse(sql(contention, service + "select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1)).examined, 0);
	pass(target, `audience row contention ${fairAdmission ? "skips fairly" : "raises retryable 55P03"} without advancement; releasing the lock admits the same event once`);

	const activation = `${database}_activation`;
	clone(activation, database);
	sql(activation, fixture + `
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
commit;`);
	const listenerClient = "30000000-0000-4000-8000-000000000201";
	const listenerTrigger = '{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}';
	let pendingListener;
	await barrierTransaction(activation, transactionContext + `
select pg_temp.path_commit(pg_temp.path_plan('before-activation','before.md',pg_temp.path_stage_file('before.md','Before listener creation')));`, async () => {
		const application = `${activation}-listener`;
		pendingListener = concurrentSql(activation, `set application_name='${application}'; set statement_timeout='5s';\n` + service + transactionContext +
			`select pg_temp.wake_routine('${bob}','${listenerTrigger}','${listenerClient}');`);
		// Await the original promise after releasing the barrier; attach a handler
		// now so a failing contender cannot become an unhandled rejection.
		void pendingListener.catch(() => undefined);
		await waitForLock(activation, application);
		assert.equal(sql(activation, "select count(*) from public.qorpera_company_file_wake_cursors;"), "0");
	}, "commit");
	const listener = JSON.parse((await pendingListener).split("\n").at(-1));
	const headAtActivation = sql(activation, `select head_snapshot_id from public.qorpera_company_files where environment_id='${environment}';`);
	assert.equal(sql(activation, "select activation_head from public.qorpera_company_file_wake_cursors where active;"), headAtActivation);
	assert.equal(JSON.parse(sql(activation, service + "select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1)).examined, 0);
	let pendingPublication;
	await barrierTransaction(activation, transactionContext + `select pg_temp.wake_routine('${bob}','${listenerTrigger}','${listenerClient}');`, async () => {
		const application = `${activation}-publisher`;
		pendingPublication = concurrentSql(activation, `set application_name='${application}'; set statement_timeout='5s';\n` + service + transactionContext + `
select pg_temp.path_commit(pg_temp.path_plan('after-edit','after.md',pg_temp.path_stage_file('after.md','After listener edit')));`);
		void pendingPublication.catch(() => undefined);
		await waitForLock(activation, application);
		assert.equal(sql(activation, `select head_snapshot_id from public.qorpera_company_files where environment_id='${environment}';`), headAtActivation);
	}, "commit");
	const publishedAfterEdit = JSON.parse((await pendingPublication).split("\n").at(-1));
	assert.equal(sql(activation, "select activation_head from public.qorpera_company_file_wake_cursors where active;"), headAtActivation);
	assert.equal(JSON.parse(sql(activation, service + "select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1)).admitted, 1);
	assert.equal(sql(activation, `select count(*) from public.qorpera_company_file_wake_claims
 where routine_id='${listener.routine_id}' and routine_version=2 and event_id='${publishedAfterEdit.snapshotId}' and outcome='admitted';`), "1");
	assert.equal(sql(activation, "select count(*) from public.qorpera_company_file_wake_claims;"), "1");
	assert.equal(JSON.parse(sql(activation, service + "select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1)).examined, 0);
	pass(target, "File-lock ordering makes creation future-only and delivers publication after listener edit exactly once");

	for (const phase of ["drain", "materialization", "context"]) {
		for (const revoked of ["recipient", "path"]) {
			const revocation = `${database}_${phase}_${revoked}`;
			clone(revocation, database);
			let setup = fixture + `
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select pg_temp.wake_routine('${bob}','${listenerTrigger}');
select pg_temp.path_commit(pg_temp.path_plan('revocation-event','note.md',pg_temp.path_stage_file('note.md','Authorized before revocation')));
`;
			if (phase !== "drain") setup += "select public.qorpera_drain_company_file_wakes(1);\n";
			if (phase === "context") setup += `
select public.qorpera_materialize_wake_execution_runs(1);
select set_config('qorpera_test.recipient_binding',pg_temp.wake_start((select run_id
 from public.qorpera_wake_occurrences where source_kind='company-file'))::text,true);
select public.qorpera_read_native_wake(current_setting('qorpera_test.recipient_binding')::jsonb);
select current_setting('qorpera_test.recipient_binding');
`;
			const prepared = sql(revocation, setup + "commit;");
			const recipientBinding = phase === "context" ? JSON.parse(prepared.split("\n").at(-1)) : null;
			const revoke = revoked === "recipient" ? `
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
update public.qorpera_profile_staff set employment_status='archived'
 where profile_id='${profile}' and staff_agent_id='${bob}';
select pg_temp.path_claims('service_role');
` : `
do $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_grant uuid;
begin
 select * into strict v_resource from public.qorpera_company_path_resources where environment_id='${environment}' and path='';
 -- Every active grant of the recipient on the root, including the default agent read grant (20260828020700).
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 for v_grant in select id from public.qorpera_company_path_grants
  where resource_id=v_resource.id and principal_id='${bob}' and revoked_at is null loop
  perform public.qorpera_revoke_company_path(v_resource.id,v_resource.version,v_grant);
 end loop;
 perform pg_temp.path_claims('service_role');
end $$;
`;
			const operation = phase === "drain" ? "select public.qorpera_drain_company_file_wakes(1);"
				: phase === "materialization" ? "select public.qorpera_materialize_wake_execution_runs(1);"
					: `select pg_temp.wake_error($read$select public.qorpera_read_native_wake('${JSON.stringify(recipientBinding)}'::jsonb)$read$,'42501');`;
			let pendingOperation;
			await barrierTransaction(revocation, transactionContext + revoke + `
select environment_id from public.qorpera_company_files where environment_id='${environment}' for update;`, async () => {
				const application = `${revocation}-reader`;
				pendingOperation = concurrentSql(revocation, `set application_name='${application}'; set statement_timeout='5s';\n` +
					service + transactionContext + operation);
				void pendingOperation.catch(() => undefined);
				if (fairAdmission && phase !== "context") {
					const pending = JSON.parse((await pendingOperation).split("\n").at(-1));
					if (phase === "drain") assert.equal(pending.admitted, 0);
					else assert.deepEqual(pending, []);
				} else await waitForLock(revocation, application);
			}, "commit");
			const output = fairAdmission && phase !== "context" ? sql(revocation, service + transactionContext + operation) : await pendingOperation;
			if (phase === "drain") {
				assert.equal(JSON.parse(output.split("\n").at(-1)).admitted, 0);
				assert.equal(sql(revocation, "select count(*) from public.qorpera_company_file_wake_claims where outcome='denied';"), "1");
				assert.equal(sql(revocation, "select count(*) from public.qorpera_wake_occurrences;"), "1");
				assert.equal(JSON.parse(sql(revocation, service + "select public.qorpera_drain_company_file_wakes(1);").split("\n").at(-1)).examined, 0);
			} else if (phase === "materialization") {
				assert.deepEqual(JSON.parse(output.split("\n").at(-1)), []);
				assert.equal(sql(revocation, "select count(*) from public.qorpera_wake_occurrences where source_kind='company-file' and status='cancelled' and run_id is null;"), "1");
				assert.equal(sql(revocation, "select count(*) from public.qorpera_execution_runs;"), "1");
				assert.equal(sql(revocation, "select count(*) from public.qorpera_runner_jobs;"), "1");
				assert.equal(sql(revocation, "select count(*) from public.qorpera_execution_sponsor_reservations;"), "1");
			} else {
				// The exact error assertion above proves that a previously readable,
				// admitted native context was withheld after the committed revocation.
				assert.equal(sql(revocation, `select count(*) from public.qorpera_wake_occurrences
 where source_kind='company-file' and run_id='${recipientBinding.runId}';`), "1");
			}
			pass(target, `committed ${revoked} revocation is rechecked after ${phase} ${fairAdmission && phase !== "context" ? "contention retry" : "lock wait"}`);
		}
	}

	sequenceDiagnostic(database, "recovery-template-before-clone");
	clone(recovery, database);
	sequenceDiagnostic(recovery, "recovery-clone-before-fixture");
	sql(recovery, fixture + `
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select pg_temp.wake_routine('${bob}','{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}');
select pg_temp.wake_routine('${carol}','{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","timeZone":"UTC","replyPolicy":"optional"}');
select pg_temp.path_commit(pg_temp.path_plan('restart-event','note.md',pg_temp.path_stage_file('note.md','Persistent fixture event')));
select public.qorpera_send_coworker_message(current_setting('qorpera_test.wake_binding')::jsonb,'${bob}','restart-message','Durable message');
commit;`);
	sequenceDiagnostic(recovery, "recovery-fixture-committed");
	await barrierTransaction(recovery, "select public.qorpera_drain_company_file_wakes(1);");
	assert.equal(sql(recovery, "select count(*) from public.qorpera_company_file_wake_claims;"), "0");
	assert.equal(sql(recovery, "select count(*) from public.qorpera_company_file_wake_cursors where processed_head <> activation_head;"), "0");
	const drains = await Promise.all([
		concurrentSql(recovery, service + "select public.qorpera_drain_company_file_wakes(1);"),
		concurrentSql(recovery, service + "select public.qorpera_drain_company_file_wakes(1);"),
	]);
	// Same-company consumers may skip one another's profile fence. A fresh
	// bounded poll must deliver the remaining event without duplicating one.
	if (fairAdmission) drains.push(sql(recovery, service + "select public.qorpera_drain_company_file_wakes(2);"));
	assert.equal(drains.map((output) => JSON.parse(output.split("\n").at(-1)).admitted).reduce((a, b) => a + b), 2);
	assert.equal(sql(recovery, "select count(*) from public.qorpera_company_file_wake_claims where outcome='admitted';"), "2");
	pass(target, "interrupted drain rolls back atomically; concurrent consumers deliver each event/listener once");
	await barrierTransaction(recovery, "select public.qorpera_materialize_wake_execution_runs(1);");
	assert.equal(sql(recovery, "select count(*) from public.qorpera_wake_occurrences where status='queued';"), "3");
	assert.equal(sql(recovery, "select count(*) from public.qorpera_execution_runs;"), "1");
	sequenceDiagnostic(recovery, "recovery-materialization-interrupted-before-restart");

	// Restart the database process and use fresh consumer connections. The
	// task-owned volume is deleted in finally; no persistent infra is created.
	docker(["restart", container]);
	await ready();
	sequenceDiagnostic(recovery, "recovery-after-first-restart");
	const occurrenceBefore = sql(recovery, "select id from public.qorpera_wake_occurrences where wake_kind='agent';");
	const replay = JSON.parse(sql(recovery, service + `select public.qorpera_send_coworker_message(${humanBinding},'${bob}','restart-message','Durable message');`).split("\n").at(-1));
	assert.equal(replay.occurrenceId, occurrenceBefore);
	const materializers = await Promise.allSettled([
		concurrentSql(recovery, service + "select public.qorpera_materialize_wake_execution_runs(32);"),
		concurrentSql(recovery, service + "select public.qorpera_materialize_wake_execution_runs(32);"),
	]);
	for (const result of materializers) if (result.status === "rejected") throw result.reason;
	if (fairAdmission) sql(recovery, service + "select public.qorpera_materialize_wake_execution_runs(32);");
	sequenceDiagnostic(recovery, "recovery-after-concurrent-materialization");
	assert.equal(sql(recovery, "select count(*) from public.qorpera_wake_occurrences where status='materialized' and run_id is not null;"), "4");
	assert.equal(sql(recovery, `select count(*) from public.qorpera_execution_runs where environment_id='${environment}';`), "4");
	assert.equal(sql(recovery, service + "select public.qorpera_materialize_wake_execution_runs(32);").split("\n").at(-1), "[]");
	pass(target, "database/consumer restart preserves delivery identity, queue recovery and exactly-once materialization");

	// A durable native-start admission is deliberately not called a running
	// provider process. After restart it must reconcile, never become a pristine
	// retry, even with no public sends or effects from that admitted attempt.
	const admitted = JSON.parse(sql(recovery, service + helpers + `
begin;
select set_config('qorpera_test.recovery_binding',pg_temp.wake_start(null)::text,true);
select public.qorpera_begin_native_company_execution(current_setting('qorpera_test.recovery_binding')::jsonb,repeat('7',64));
select current_setting('qorpera_test.recovery_binding');
commit;`).split("\n").at(-1));
	sequenceDiagnostic(recovery, "native-start-committed-before-second-restart");
	docker(["restart", container]);
	await ready();
	sequenceDiagnostic(recovery, "native-start-after-second-restart");
	sql(recovery, service + helpers + `
select public.qorpera_terminalize_runner_attempt('${admitted.jobId}','failed','Disposable worker-loss fixture',true);
select public.qorpera_terminalize_runner_attempt('${admitted.jobId}','failed','Disposable worker-loss fixture',true);
do $$ begin
 perform pg_temp.wake_assert((select status='failed' from public.qorpera_runner_jobs where id='${admitted.jobId}'),'Started job does not requeue');
 perform pg_temp.wake_assert((select status='requires_review' and run_id='${admitted.runId}' from public.qorpera_wake_occurrences
  where run_id='${admitted.runId}'),'Started occurrence retains its identity for review');
 perform pg_temp.wake_assert((select status<>'active' and released_at is not null from public.qorpera_native_provider_connection_leases
  where id='${admitted.leaseId}'),'Terminalized attempt releases native authority');
 perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_execution_run_events where run_id='${admitted.runId}'
  and event_type='review_pending' and payload->>'reason'='native_execution_uncertain'),'Repeated recovery retains one review decision');
 perform pg_temp.wake_assert(public.qorpera_materialize_wake_execution_runs(32)='[]'::jsonb,'Recovery creates no second attempt');
 perform pg_temp.wake_error('select public.qorpera_read_native_wake(''${JSON.stringify(admitted)}''::jsonb)','42501');
end $$;`);
	pass(target, "admitted native-start survives restart, releases authority and requires reconciliation without automatic replay");
	target.status = "passed";
}

let started = false;
let volumeCreated = false;
try {
	report.baselineUpgrade.status = "running";
	docker(["volume", "create", volume]);
	volumeCreated = true;
	docker(["run", "--detach", "--name", container, "--network", "none", "--env", "POSTGRES_PASSWORD=wake-test-only",
		"--env", "POSTGRES_DB=wake_baseline", "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, POSTGRES_IMAGE]);
	started = true;
	await ready();
	sql("wake_baseline", readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const before = sortMigrationNames(readdirSync(join(root, "supabase/migrations"))).filter((name) => name < migrationName);
	for (const name of before) sql("wake_baseline", readFileSync(join(root, "supabase/migrations", name), "utf8"));
	console.log(`Applied ${before.length} baseline migrations to isolated PostgreSQL`);

	clone("wake_upgrade", "wake_baseline");
	sql("wake_upgrade", fixture + `
do $$
declare v_routine jsonb; v_bound uuid; v_pending uuid; v_base public.qorpera_execution_runs%rowtype;
 v_job uuid; v_id uuid := extensions.gen_random_uuid();
begin
 v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030','{"id":"tick","kind":"schedule","intervalMinutes":1440,"weekdays":["friday"],"localTime":"09:00","timeZone":"Europe/Copenhagen"}');
 v_bound := pg_temp.wake_schedule(v_routine,'upgrade-bound',now()-interval '10 minutes');
 v_pending := pg_temp.wake_schedule(v_routine,'upgrade-pending',now()-interval '5 minutes');
 select * into strict v_base from public.qorpera_execution_runs where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
 insert into public.qorpera_runner_jobs(profile_id,environment_id,substrate_version_id,client_job_id,required_capability,job_type,payload,created_by_user_id)
 values(v_base.profile_id,v_base.environment_id,v_base.substrate_version_id,v_id,'agent_turn','agent_turn','{}',v_base.created_by_user_id) returning id into v_job;
 insert into public.qorpera_execution_runs
 select (jsonb_populate_record(null::public.qorpera_execution_runs,to_jsonb(v_base)||jsonb_build_object(
  'id',v_id,'job_id',v_job,'source_kind','wake','source_id',v_bound,'session_id',v_base.session_id,'input_ids','[]'::jsonb,'transcript_start_sequence',0))).*;
 update public.qorpera_runner_jobs set run_id=v_id where id=v_job;
 update public.qorpera_wake_occurrences set run_id=v_id,status='materialized' where id=v_bound;
end $$;
commit;`);
	sql("wake_upgrade", `begin;\n${migration}\ncommit;`);
	sql("wake_upgrade", service + `do $$ begin
 if (select count(*) from public.qorpera_wake_occurrences where occurrence_key in ('upgrade-bound','upgrade-pending')
  and staff_agent_id='30000000-0000-4000-8000-000000000030' and staff_version=1 and requested_by_user_id='30000000-0000-4000-8000-000000000001'
  and sponsor_binding_id is not null and sponsor_version=1 and causal_root_id=id and cardinality(causal_agent_ids)=1) <> 2
 then raise exception 'Upgrade lost the pending occurrence beside an admitted one'; end if;
 if (select count(*) from public.qorpera_wake_occurrences where occurrence_key in ('upgrade-bound','upgrade-pending')
  and time_zone='Europe/Copenhagen') <> 2 then raise exception 'Upgrade lost the immutable routine timezone'; end if;
end $$;`);
	pass(report.baselineUpgrade, "baseline upgrade: pending and materialized occurrences retain bindings and immutable routine timezone");
	sql("wake_upgrade", `begin;\n${policyMigration}\ncommit;`);
	sql("wake_upgrade", service + `do $$ begin
 if public.qorpera_materialize_wake_execution_runs(1) <> '[]'::jsonb then
  raise exception 'Historical required-report wake acquired compute without a pinned audience'; end if;
 if not exists(select 1 from public.qorpera_wake_occurrences where occurrence_key='upgrade-pending'
  and status='cancelled' and run_id is null and session_id is null and time_zone='Europe/Copenhagen'
  and staff_agent_id='30000000-0000-4000-8000-000000000030' and staff_version=1
  and causal_root_id=id and cardinality(causal_agent_ids)=1) then
  raise exception 'Historical unbound wake did not retain its identity on conservative cancellation'; end if;
 if not exists(select 1 from public.qorpera_wake_occurrences where occurrence_key='upgrade-bound'
  and status='materialized' and run_id is not null and session_id='30000000-0000-4000-8000-000000000040') then
  raise exception 'Forward policy migration altered the bound occurrence identity'; end if;
 if (select count(*) from public.qorpera_execution_runs) <> 2 then
  raise exception 'Conservative cancellation created another execution run'; end if;
end $$;`);
	pass(report.baselineUpgrade, "forward policy upgrade cancels historical unbound required reports without inventing an audience or losing identity");

	// Seed the historical state through the old admission function, not by
	// disabling a guard or editing immutable occurrence/receipt identities.
	clone("wake_audience_upgrade", "wake_baseline");
	sql("wake_audience_upgrade", `begin;\n${migration}\ncommit;`);
	sql("wake_audience_upgrade", fixture + `
update public.qorpera_shared_sessions set status='closed' where id='30000000-0000-4000-8000-000000000042';
do $$
declare v_routine jsonb;
begin
 v_routine := pg_temp.wake_routine('${bob}','{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"required"}');
 perform pg_temp.wake_schedule(v_routine,'audience-upgrade-required');
 v_routine := pg_temp.wake_routine('${bob}','{"id":"tick","kind":"schedule","intervalMinutes":5}');
 perform pg_temp.wake_schedule(v_routine,'audience-upgrade-omitted');
 perform pg_temp.wake_assert((select count(*)=2 from public.qorpera_wake_occurrences
  where occurrence_key in ('audience-upgrade-required','audience-upgrade-omitted')
  and status='queued' and run_id is null and session_id is null),'Old admission permits unbound reporting wakes');
end $$;
commit;`);
	const priorPolicy = JSON.parse(sql("wake_audience_upgrade", "select public.qorpera_wake_policy_value('routine');"));
	assert.equal(priorPolicy.final, "optional");
	report.baselineUpgrade.priorBehavior = { omittedRoutineFinal: priorPolicy.final, queuedReportingWakesWithoutAudience: 2 };
	sql("wake_audience_upgrade", `begin;\n${policyMigration}\ncommit;`);
	sql("wake_audience_upgrade", service + `do $$ begin
 if public.qorpera_wake_policy_value('routine')->>'final' <> 'required' then
  raise exception 'Forward policy correction did not retain required reporting'; end if;
 if public.qorpera_materialize_wake_execution_runs(32) <> '[]'::jsonb then
  raise exception 'Historical reporting wakes acquired compute without an audience'; end if;
 if (select count(*) from public.qorpera_wake_occurrences
  where occurrence_key in ('audience-upgrade-required','audience-upgrade-omitted')
  and status='cancelled' and run_id is null and session_id is null) <> 2 then
  raise exception 'Forward policy correction failed to cancel both historical reporting wakes'; end if;
 if (select count(*) from public.qorpera_execution_runs) <> 1
  or (select count(*) from public.qorpera_runner_jobs) <> 1
  or (select count(*) from public.qorpera_execution_sponsor_reservations) <> 1 then
  raise exception 'Historical cancellation created a run, job or sponsor reservation'; end if;
end $$;`);
	pass(report.baselineUpgrade, "old required/omitted no-audience admissions cancel before compute under the forward correction");
	report.baselineUpgrade.status = "passed";

	clone("wake_component", "wake_baseline");
	sql("wake_component", `begin;\n${migration}\n${policyMigration}\ncommit;`);
	await verifyDatabase("wake_component", report.component);

	if (integration) {
		report.databaseIntegration.status = "running";
		clone("wake_integration", "wake_component");
		const after = sortMigrationNames(readdirSync(join(root, "supabase/migrations"))).filter((name) => name > policyMigrationName);
		for (const name of after) {
			const source = readFileSync(join(root, "supabase/migrations", name), "utf8");
			sql("wake_integration", source);
			report.databaseIntegration.appliedMigrations.push({ name, sha256: createHash("sha256").update(source).digest("hex") });
		}
		try {
			await verifyDatabase("wake_integration", report.databaseIntegration.regressions);
		} catch (error) {
			report.databaseIntegration.regressions.status = "failed";
			report.databaseIntegration.regressions.error = error instanceof Error ? error.message : String(error);
			console.error(report.databaseIntegration.regressions.error);
		}
		const acceptance = readFileSync(join(root, "supabase/acceptance/runtime_wake_bus.sql"), "utf8");
		const results = JSON.parse(sql("wake_integration", fixture + acceptance).split("\n").at(-1));
		assert.equal(results.schema, "qorpera.wake-integration-acceptance/v1");
		assert(results.cases.length > 0 && new Set(results.cases.map((test) => test.name)).size === results.cases.length);
		report.databaseIntegration.cases = results.cases;
		for (const test of results.cases) console.log(`${test.passed ? "PASS" : "FAIL"} integration: ${test.name}${test.error ? ` (${test.sqlstate}: ${test.error})` : ""}`);
		report.databaseIntegration.status = report.databaseIntegration.regressions.status === "passed" && results.cases.every((test) => test.passed) ? "passed" : "failed";
		if (report.databaseIntegration.status === "failed") process.exitCode = 1;
	} else console.log("NOT RUN database integration acceptance (requires --integration)");
} catch (error) {
	if (report.baselineUpgrade.status === "running") report.baselineUpgrade.status = "failed";
	if (report.component.status === "running") report.component.status = "failed";
	if (report.databaseIntegration.status === "running") report.databaseIntegration.status = "failed";
	report.error = error instanceof Error ? error.message : String(error);
	console.error(report.error);
	process.exitCode = 1;
} finally {
	for (const args of [started && ["rm", "--force", container], volumeCreated && ["volume", "rm", volume]].filter(Boolean)) {
		try { docker(args); } catch (error) {
			report.cleanupError = error instanceof Error ? error.message : String(error);
			console.error(report.cleanupError);
			process.exitCode = 1;
		}
	}
	report.completedAt = new Date().toISOString();
	if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
