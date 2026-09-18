// Local disposable PostgreSQL only. No hosted credentials or production effects.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `qorpera-contention-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const children = new Set();
const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
const service = "set request.jwt.claims='{\"role\":\"service_role\"}'; set role service_role;";
const owner = "set request.jwt.claims='{\"role\":\"authenticated\",\"sub\":\"15000000-0000-4000-8000-000000000001\"}'; set role authenticated;";
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 ** 2 });
	assert(!result.error && result.status === 0, `${result.stderr || result.error}\n${result.stdout ?? ""}`);
	return result.stdout.trim();
}
const query = sql => docker(psql, sql);
function session(name) {
	const child = spawn("docker", psql); children.add(child);
	let output = "", error = "";
	child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	const done = new Promise((resolve, reject) => {
		child.on("error", reject); child.on("close", code => { clearTimeout(timer); children.delete(child); resolve({ code, output, error }); });
	});
	child.stdin.write(`set application_name=${sqlText(name)}; set statement_timeout='20s';\n`);
	return { child, done, output: () => output };
}
async function until(predicate) {
	const end = Date.now() + 8000;
	while (!predicate()) { assert(Date.now() < end, "SQL lock barrier timed out"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function waitsForLock(name) {
	await until(() => query(`select exists(select 1 from pg_stat_activity where application_name=${sqlText(name)} and wait_event_type='Lock');`) === "t");
}
let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "--pull", "never", "-e", "POSTGRES_PASSWORD=disposable-only", "-e", "POSTGRES_DB=qorpera_test", POSTGRES_IMAGE]); started = true;
	let ready = 0;
	await until(() => { ready = spawnSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "qorpera_test", "-c", "select 1"], { timeout: 2000 }).status === 0 ? ready + 1 : 0; return ready >= 2; });
	query(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	for (const name of migrations) query(readFileSync(join(root, "supabase/migrations", name), "utf8"));
	console.log(`PASS ${migrations.length} migrations on network-disabled PostgreSQL`);
	query(readFileSync(join(root, "supabase/tests/361_runtime_conflict_fences.test.sql"), "utf8"));
	const fixture = readFileSync(join(root, "supabase/tests/150_runner_orchestrator.test.sql"), "utf8").split("select set_config(\n\t'qorpera_test.accepted_job',");
	assert.equal(fixture.length, 2);
	query(`${fixture[0]} commit;`);
	const runner = "15000000-0000-4000-8000-000000000090";
	const claim = "15000000-0000-4000-8000-000000000101";
	const assignment = "15000000-0000-4000-8000-000000000102";
	const job = query(`select job_id from public.qorpera_runner_assignments where id='${assignment}';`);
	const accept = `select public.qorpera_accept_runner_assignment('${runner}',repeat('d',64),'${assignment}','${job}',repeat('e',64));`;
	const assign = `select public.qorpera_assign_runner_job('15000000-0000-4000-8000-000000000100','${claim}','${runner}','15000000-0000-4000-8000-000000000999',repeat('a',64),120);`;
	const release = `select public.qorpera_release_runner_job_claim('15000000-0000-4000-8000-000000000100','${claim}','${assignment}','isolated rollback proof');`;
	for (const [name, call] of [["accept", accept], ["assign", assign], ["release", release]]) {
		const locker = session(`locker-${name}`);
		locker.child.stdin.write(`begin; select id from public.qorpera_runner_jobs where id='${job}' for update; select 'LOCKED';\n`);
		await until(() => locker.output().includes("LOCKED"));
		const worker = session(`worker-${name}`); worker.child.stdin.end(`begin; ${service} ${call} rollback;`);
		await waitsForLock(`worker-${name}`);
		// The old bodies held runner/claim/assignment while waiting for this job.
		// The job holder can now acquire all three, so the old cycle cannot close.
		locker.child.stdin.end(`select id from public.qorpera_runner_job_claims where id='${claim}' for update nowait; select id from public.qorpera_runners where id='${runner}' for update nowait; select id from public.qorpera_runner_assignments where id='${assignment}' for update nowait; rollback;`);
		assert.equal((await locker.done).code, 0, `${name} took a later lock before its job`);
		const result = await worker.done; assert.equal(result.code, 0, result.error);
		console.log(`PASS ${name}: blocked on job without holding claim, runner or assignment; completed after release`);
	}
	const runnerBeforeExpiry = JSON.parse(query(`select jsonb_build_object('computer',logical_computer_id,'expiry',session_expires_at) from public.qorpera_runners where id='${runner}'`));
	query(`update public.qorpera_runners set logical_computer_id=null, session_expires_at=statement_timestamp()-interval '2 hours' where id='${runner}';`);
	const staleLocker = session("stale-runner-locker");
	staleLocker.child.stdin.write(`begin; select id from public.qorpera_runners where id='${runner}' for update; select 'LOCKED';\n`);
	await until(() => staleLocker.output().includes("LOCKED"));
	const staleAssign = session("assign-stale-runner");
	staleAssign.child.stdin.end(`set statement_timeout='1s'; ${service} ${assign}`);
	const stale = await staleAssign.done;
	assert.notEqual(stale.code, 0); assert.match(stale.error, /55000/); assert.match(stale.error, /compatible runner is unavailable/); assert.doesNotMatch(stale.error, /57014/);
	staleLocker.child.stdin.end("rollback;"); assert.equal((await staleLocker.done).code, 0);
	query(`update public.qorpera_runners set logical_computer_id=${sqlText(runnerBeforeExpiry.computer)}::uuid, session_expires_at=${sqlText(runnerBeforeExpiry.expiry)}::timestamptz where id='${runner}';`);
	console.log("PASS expired assignment target: no wait on reconciler's stale runner lock");
	query(`${service} ${accept}`);
	for (const [name, call] of [
		["revoke", `select public.qorpera_revoke_runner('${runner}');`],
		["reissue", `select public.qorpera_reissue_runner_activation('${runner}',repeat('b',64));`],
	]) {
		const locker = session(`locker-${name}`); locker.child.stdin.write(`begin; select id from public.qorpera_runner_jobs where id='${job}' for update; select 'LOCKED';\n`);
		await until(() => locker.output().includes("LOCKED"));
		const worker = session(`worker-${name}`); worker.child.stdin.end(`begin; ${owner} ${call} rollback;`);
		await waitsForLock(`worker-${name}`);
		locker.child.stdin.end(`select id from public.qorpera_runners where id='${runner}' for share nowait; rollback;`);
		assert.equal((await locker.done).code, 0, `${name} held runner ahead of job`);
		const result = await worker.done; assert.equal(result.code, 0, result.error);
		console.log(`PASS ${name}: job holder can still acquire runner; administration completed after release`);
	}
	// A lease accepted between the admin's job scan and runner lock must fence
	// administration, not let it lock the new job in reverse order or miss it.
	const racedJob = "15000000-0000-4000-8000-000000000998";
	query(`insert into public.qorpera_runner_jobs (
		id, profile_id, environment_id, substrate_version_id, client_job_id,
		required_capability, job_type, payload, status, created_by_user_id
	) select '${racedJob}', profile_id, environment_id, substrate_version_id,
		'15000000-0000-4000-8000-000000000997', required_capability, job_type,
		payload, 'queued', created_by_user_id from public.qorpera_runner_jobs where id='${job}';`);
	for (const [name, call] of [
		["revoke-race", `select public.qorpera_revoke_runner('${runner}');`],
		["reissue-race", `select public.qorpera_reissue_runner_activation('${runner}',repeat('b',64));`],
	]) {
		const locker = session(`locker-${name}`);
		locker.child.stdin.write(`begin; select id from public.qorpera_runners where id='${runner}' for update; select 'LOCKED';\n`);
		await until(() => locker.output().includes("LOCKED"));
		const worker = session(`worker-${name}`); worker.child.stdin.end(`begin; ${owner} ${call} rollback;`);
		await waitsForLock(`worker-${name}`);
		locker.child.stdin.end(`update public.qorpera_runner_jobs set status='leased', runner_id='${runner}',
			client_lease_id='15000000-0000-4000-8000-000000000996', lease_token_sha256=repeat('c',64),
			lease_expires_at=statement_timestamp()+interval '2 minutes', attempt_count=1,
			started_at=statement_timestamp() where id='${racedJob}'; commit;`);
		const installed = await locker.done; assert.equal(installed.code, 0, installed.error);
		const raced = await worker.done; assert.notEqual(raced.code, 0); assert.match(raced.error, /QRC01/);
		assert.match(raced.error, /Runner leases changed before administration/);
		assert.equal(query(`select status from public.qorpera_runners where id='${runner}'`), "active");
		assert.equal(query(`select status from public.qorpera_runner_jobs where id='${job}'`), "leased");
		query(`update public.qorpera_runner_jobs set status='queued', runner_id=null, client_lease_id=null,
			lease_token_sha256=null, lease_expires_at=null where id='${racedJob}';`);
		console.log(`PASS ${name}: concurrent new lease fences administration without partial retirement`);
	}
	const rejected = session("fence");
	rejected.child.stdin.end(`${service} select public.qorpera_renew_runner_job('${runner}',repeat('d',64),'${job}',repeat('f',64));`);
	const fence = await rejected.done;
	assert.notEqual(fence.code, 0); assert.match(fence.error, /PGRST/); assert.match(fence.error, /"code": "QRC01"/); assert.match(fence.error, /"status":409/); assert.match(fence.error, /runner job lease is unavailable/); assert.doesNotMatch(fence.error, /40001/);
	assert.equal(query(`select status from public.qorpera_runner_jobs where id='${job}'`), "leased");
	console.log("PASS stale lease: QRC01/HTTP409 envelope, original message, no job mutation");
	query("create table public.contention_engine_probe(id integer primary key, value integer); insert into public.contention_engine_probe values(1,0);");
	const engine = session("engine"); engine.child.stdin.write("begin isolation level repeatable read; select value from public.contention_engine_probe; select 'SNAPSHOT';\n");
	await until(() => engine.output().includes("SNAPSHOT"));
	query("update public.contention_engine_probe set value=1 where id=1;");
	engine.child.stdin.end("update public.contention_engine_probe set value=2 where id=1; commit;");
	const genuine = await engine.done; assert.notEqual(genuine.code, 0); assert.match(genuine.error, /40001/); assert.doesNotMatch(genuine.error, /QRC01/);
	console.log("PASS actual repeatable-read engine conflict retains SQLSTATE40001");
} finally {
	for (const child of children) child.kill("SIGKILL");
	if (started) spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
}
