// Real native authority in fresh, network-disabled PostgreSQL. No hosted URLs,
// credentials, provider calls or substituted production functions are used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-native-locks-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "native_locks",
	"-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const service = `set request.jwt.claims='{"role":"service_role"}'; set role service_role;`;
const children = new Set();
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 ** 2 });
	assert(!result.error && result.status === 0, `${result.stderr || result.error}\n${result.stdout ?? ""}`);
	return result.stdout.trim();
}
const query = (input) => docker(psql, input);
function session() {
	const child = spawn("docker", psql);
	children.add(child);
	let output = "", error = "";
	child.stdout.on("data", (bytes) => { output += bytes; });
	child.stderr.on("data", (bytes) => { error += bytes; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timer); children.delete(child); resolve({ code, output: output.trim(), error }); });
	});
	return { child, done, output: () => output };
}
async function until(check) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert(Date.now() < deadline, "Native authority SQL barrier timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "--pull", "never",
		"-e", "POSTGRES_PASSWORD=disposable-native-locks-only", "-e", "POSTGRES_DB=native_locks", POSTGRES_IMAGE]);
	started = true;
	let consecutive = 0;
	for (let attempt = 0; attempt < 60 && consecutive < 2; attempt++) {
		const ready = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "native_locks"], { timeout: 2000 });
		consecutive = ready.status === 0 ? consecutive + 1 : 0;
		if (consecutive < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(consecutive, 2);
	query(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) query(readFileSync(join(root, "supabase/migrations", name), "utf8"));
	console.log(`PASS: ${migrations.length} migrations in network-disabled disposable PostgreSQL`);
	const fixture = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8").split("-- END WAKE FIXTURE");
	assert.equal(fixture.length, 2);
	const office = readFileSync(join(root, "supabase/tests/fixtures/runtime-office-registry-cases.sql"), "utf8")
		.split("set local role service_role;\nselect set_config('qorpera_test.office_lease'");
	assert.equal(office.length, 2);
	const setup = JSON.parse(query(`${fixture[0]} ${office[0]}
		select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
		select jsonb_build_object('binding',current_setting('qorpera_test.wake_binding')::jsonb,
		'scope',current_setting('qorpera_test.office_scope')::jsonb); commit;`).split("\n").at(-1));
	const binding = setup.binding;
	const validate = (value = binding) => `select public.qorpera_validate_native_provider_execution_lease(${[
		value.leaseId, value.runId, value.jobId, value.runnerId, value.assignmentId,
		value.credentialCapsuleId, value.computeIdentityId, value.provider, value.nativeHarness,
	].map(literal).join(",")});`;
	const describe = `select public.qorpera_describe_native_tool_authority(${json(binding)});`;
	const send = `select public.qorpera_send_native_agent_message(${[
		binding.leaseId, binding.runId, binding.jobId, binding.runnerId, binding.assignmentId,
		binding.credentialCapsuleId, binding.computeIdentityId, binding.provider, binding.nativeHarness,
		"native-lock-public-send", "Checking retained authority.", "progress",
	].map(literal).join(",")});`;
	assert.equal(JSON.parse(query(`${service} ${validate()}`)).lease_id, binding.leaseId);
	assert.equal(JSON.parse(query(`${service} ${describe}`)).identity.runId, binding.runId);

	// Pause the tool transaction immediately after its existing first job lock.
	// The direct host validator must wait there WITHOUT holding the profile.
	// Before the fix it holds profile while waiting for job, and the real tool
	// call below completes the inverse edge. No SQL function body is mocked.
	for (const [kind, operation] of [["tool", `${describe} ${describe}`], ["public-send", send]]) {
		const tool = session();
		tool.child.stdin.write(`begin; set application_name='native-lock-tool'; set deadlock_timeout='2s';
			select id from public.qorpera_runner_jobs where id=${literal(binding.jobId)} for update;
			select 'TOOL_JOB_LOCKED';\n`);
		await until(() => tool.output().includes("TOOL_JOB_LOCKED"));
		const host = session();
		host.child.stdin.end(`set application_name='native-lock-host'; set deadlock_timeout='2s'; ${service} ${validate()}`);
		await until(() => query("select count(*) from pg_stat_activity where application_name='native-lock-host' and wait_event_type='Lock';") === "1");
		assert.equal(query("select count(*) from pg_stat_activity h,pg_stat_activity t where h.application_name='native-lock-host' and t.application_name='native-lock-tool' and t.pid=any(pg_blocking_pids(h.pid));"), "1");
		tool.child.stdin.end(`${service} ${operation} commit;`);
		const overlap = await Promise.all([tool.done, host.done]);
		console.log("NATIVE_AUTHORITY_OVERLAP=" + JSON.stringify({ kind, overlap }));
		for (const result of overlap) assert.equal(result.code, 0, result.error);
	}
	console.log("PASS: actual host validation overlaps repeated native helpers and public send without a profile/job deadlock");

	// Member recovery must also select job before run. Its normal callers may
	// already own job, but the RPC is independently callable, including against
	// an active run it will refuse. (The control-plane sponsor handoff is gone
	// since 20260930048000.)
	for (const [kind, actor, operation, expectedState] of [
		["recovery", `set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;`,
			`select public.qorpera_resolve_failed_execution_run(${literal(binding.runId)},'discard');`, "55000"],
	]) {
		const holder = session();
		holder.child.stdin.write(`begin; set application_name='native-lock-holder'; set deadlock_timeout='2s';
			select id from public.qorpera_runner_jobs where id=${literal(binding.jobId)} for update; select 'TERMINAL_JOB_LOCKED';\n`);
		await until(() => holder.output().includes("TERMINAL_JOB_LOCKED"));
		const terminal = session();
		terminal.child.stdin.end(`set application_name='native-lock-terminal'; set deadlock_timeout='2s'; ${actor} ${operation}`);
		await until(() => query("select count(*) from pg_stat_activity where application_name='native-lock-terminal' and wait_event_type='Lock';") === "1");
		assert.equal(query("select count(*) from pg_stat_activity t,pg_stat_activity h where t.application_name='native-lock-terminal' and h.application_name='native-lock-holder' and h.pid=any(pg_blocking_pids(t.pid));"), "1");
		holder.child.stdin.end(`${service} ${validate()} commit;`);
		const results = await Promise.all([holder.done, terminal.done]);
		console.log("NATIVE_TERMINAL_OVERLAP=" + JSON.stringify({ kind, results }));
		assert.equal(results[0].code, 0, results[0].error);
		if (expectedState) {
			assert.notEqual(results[1].code, 0);
			assert.match(results[1].error, new RegExp(expectedState));
			assert.doesNotMatch(results[1].error, /40P01/);
		} else {
			assert.equal(results[1].code, 0, results[1].error);
			assert.equal(results[1].output, "");
		}
	}
	console.log("PASS: member recovery overlaps host job ownership while preserving its active-run refusal");

	// Concurrent ordinary renewals plus native/office readers all execute their
	// real entry points, retaining the same original admitted authority tuple.
	const lease = JSON.parse(query(`${service} select public.qorpera_native_office_screen(${json(binding)},${json(setup.scope)},'acquire',null);`)).lease;
	const concurrent = [
		validate(), describe,
		`select public.qorpera_renew_native_provider_connection_lease(${literal(binding.leaseId)},${literal(binding.runnerId)},repeat('2',64),${literal(binding.jobId)},repeat('3',64),120);`,
		`select public.qorpera_renew_runner_job(${literal(binding.runnerId)},repeat('2',64),${literal(binding.jobId)},repeat('3',64));`,
		`select public.qorpera_native_office_screen(${json(binding)},${json(setup.scope)},'renew',${json(lease)});`,
		`select public.qorpera_check_runtime_office_shared_surface(${json(lease.binding)});`,
		`select public.qorpera_runtime_office_supervisor_status(${json(setup.scope)},${lease.binding.computerGeneration});`,
	].map((sql) => { const next = session(); next.child.stdin.end(`${service} ${sql}`); return next.done; });
	for (const result of await Promise.all(concurrent)) assert.equal(result.code, 0, result.error);
	console.log("PASS: host/tool, runner/native renewals, screen renewal, shared surface and supervisor remain callable together");

	// A mismatched run must not borrow another job's lock. A valid validator
	// waiting for that job must then observe a revocation committed meanwhile.
	const holder = session();
	holder.child.stdin.write(`begin; select id from public.qorpera_runner_jobs where id=${literal(binding.jobId)} for update; select 'REVOCATION_JOB_LOCKED';\n`);
	await until(() => holder.output().includes("REVOCATION_JOB_LOCKED"));
	const mismatch = session();
	mismatch.child.stdin.end(`set statement_timeout='1s'; ${service} ${validate({ ...binding, runId: randomUUID() })}`);
	const mismatchResult = await mismatch.done;
	assert.match(mismatchResult.error, /42501/);
	assert.doesNotMatch(mismatchResult.error, /57014/);
	const unauthorizedRecovery = session();
	unauthorizedRecovery.child.stdin.end(`set statement_timeout='1s';
		set request.jwt.claims='{"role":"authenticated","sub":"${randomUUID()}"}'; set role authenticated;
		select public.qorpera_resolve_failed_execution_run(${literal(binding.runId)},'discard');`);
	const unauthorizedResult = await unauthorizedRecovery.done;
	assert.match(unauthorizedResult.error, /42501/);
	assert.doesNotMatch(unauthorizedResult.error, /57014/);
	const waiting = session();
	waiting.child.stdin.end(`set application_name='native-lock-revocation'; ${service} ${validate()}`);
	await until(() => query("select count(*) from pg_stat_activity where application_name='native-lock-revocation' and wait_event_type='Lock';") === "1");
	query(`set statement_timeout='1s'; update public.qorpera_member_compute_identities set status='disabled' where id=${literal(binding.computeIdentityId)};`);
	holder.child.stdin.end("commit;");
	assert.equal((await holder.done).code, 0);
	const revokedAfterWait = await waiting.done;
	assert.notEqual(revokedAfterWait.code, 0);
	assert.match(revokedAfterWait.error, /42501/);
	assert.match(revokedAfterWait.error, /fenced for recovery/);
	query(`update public.qorpera_member_compute_identities set status='active' where id=${literal(binding.computeIdentityId)};`);
	console.log("PASS: mismatched tuple cannot lock another job; waiting host observes concurrently committed identity revocation");

	for (const key of ["leaseId", "runId", "jobId", "runnerId", "assignmentId", "credentialCapsuleId", "computeIdentityId", "provider", "nativeHarness"]) {
		const next = session();
		next.child.stdin.end(`${service} ${validate({ ...binding, [key]: key.endsWith("Id") ? randomUUID() : "wrong" })}`);
		const result = await next.done;
		assert.notEqual(result.code, 0, `${key} substitution was accepted`);
		assert.match(result.error, /42501/);
	}
	for (const [name, mutation] of [
		["revoked lease", `update public.qorpera_native_provider_connection_leases set status='revoked',released_at=clock_timestamp() where id=${literal(binding.leaseId)};`],
		["expired job", `update public.qorpera_runner_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${literal(binding.jobId)};`],
		["disabled identity", `update public.qorpera_member_compute_identities set status='disabled' where id=${literal(binding.computeIdentityId)};`],
		["stale recovery epoch", `update public.qorpera_member_compute_identities set recovery_epoch=recovery_epoch+1 where id=${literal(binding.computeIdentityId)};`],
	]) {
		const next = session();
		next.child.stdin.end(`begin; ${mutation} ${service} ${validate()} rollback;`);
		const result = await next.done;
		assert.notEqual(result.code, 0, `${name} was accepted`);
		assert.match(result.error, /42501/);
	}
	assert.equal(JSON.parse(query(`${service} ${validate()}`)).lease_id, binding.leaseId);
	const privileges = JSON.parse(query(`select jsonb_object_agg(role,has_function_privilege(role,
		'public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE'))
		from unnest(array['service_role','anon','authenticated','qorpera_secret_broker']) role;`));
	assert.deepEqual(privileges, { service_role: true, anon: false, authenticated: false, qorpera_secret_broker: false });
	const terminalPrivileges = JSON.parse(query(`select jsonb_build_object(
		'handoffGone',to_regprocedure('public.qorpera_handoff_run_sponsor(uuid,text)') is null,
		'recoveryMember',has_function_privilege('authenticated','public.qorpera_resolve_failed_execution_run(uuid,text)','EXECUTE'));`));
	assert.deepEqual(terminalPrivileges, { handoffGone: true, recoveryMember: true });
	const recovered = JSON.parse(query(`begin;
		set request.jwt.claims='{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'; set role authenticated;
		select public.qorpera_cancel_runner_job(${literal(binding.jobId)});
		select public.qorpera_resolve_failed_execution_run(${literal(binding.runId)},'discard'); rollback;`).split("\n").at(-1));
	assert.deepEqual(recovered, { run_id: binding.runId, action: "discard", resolved: true });
	console.log("PASS: member cancellation and successful terminal recovery preserve their exact run result and execute grants");
	console.log(`PASS: nine substituted bindings and four revoked/stale principals remain denied after ${migrations.length} migrations`);
} finally {
	for (const child of children) child.kill("SIGKILL");
	if (started) docker(["rm", "-f", "-v", container]);
}
