// Disposable PostgreSQL regressions for the production review findings.
// No external database URL, credentials or provider process is accepted.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { hash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCloudNativeCompanyContext, composeCloudNativeCompanyPrompt } from "../packages/runtime/src/cloud-native-company-context.ts";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--report"), "Usage: node scripts/test-runtime-production-review.mjs [--report PATH]");
const container = `qorpera-production-review-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${container}-data`;
const report = { schema: "qorpera.production-review-regressions/v1", startedAt: new Date().toISOString(),
	network: "none", providerInvoked: false, deployedAcceptance: false, migrations: [], cases: [], concurrency: [], passed: false };
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "review"];
const profile = "30000000-0000-4000-8000-000000000010";
const owner = "30000000-0000-4000-8000-000000000001";
const sessions = new Set();
function docker(argumentsValue, input) {
	const result = spawnSync("docker", argumentsValue, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || result.stdout);
	return result.stdout.trim();
}
const sql = (query) => docker(psql, query);
function session() {
	const child = spawn("docker", psql);
	sessions.add(child);
	let output = "", error = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { error += chunk; });
	const done = new Promise((resolveDone, reject) => {
		child.on("error", reject);
		child.on("close", (code) => { sessions.delete(child); resolveDone({ code, output: output.trim(), error }); });
	});
	return { child, done, output: () => output, error: () => error };
}
async function until(predicate, description) {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}
async function begin(query) {
	const current = session();
	current.child.stdin.write(`begin;\n${query}\nselect 'REVIEW_READY';\n`);
	await until(() => current.output().includes("REVIEW_READY") || current.child.exitCode !== null, "transaction barrier");
	assert(current.output().includes("REVIEW_READY"), current.error());
	return current;
}
async function commit(current) {
	current.child.stdin.end("commit;\n");
	const result = await current.done;
	assert.equal(result.code, 0, result.error);
	return result;
}
async function waitLock(application) {
	await until(() => sql(`select count(*) from pg_stat_activity where application_name='${application}' and wait_event_type='Lock';`) === "1", "competing consent lock");
}
let started = false, volumeCreated = false;
try {
	docker(["volume", "create", volume]); volumeCreated = true;
	docker(["run", "--detach", "--name", container, "--network", "none", "--env", "POSTGRES_PASSWORD=review-disposable-only",
		"--env", "POSTGRES_DB=review", "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, POSTGRES_IMAGE]); started = true;
	await until(() => spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "review"], { stdio: "ignore" }).status === 0, "PostgreSQL startup");
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	for (const file of sortMigrationNames(readdirSync(join(root, "supabase/migrations")))) {
		const bytes = readFileSync(join(root, "supabase/migrations", file)); sql(bytes);
		report.migrations.push({ file, sha256: hash("sha256", bytes) });
	}
	const component = readFileSync(join(root, "supabase/tests/300_runtime_wake_bus.test.sql"), "utf8");
	assert.equal(component.split("-- END WAKE FIXTURE").length, 2);
	const fixture = component.split("-- END WAKE FIXTURE")[0];
	const original = readFileSync(join(root, "supabase/acceptance/runtime_wake_bus.sql"), "utf8");
	const regression = readFileSync(join(root, "supabase/acceptance/runtime_production_review.sql"), "utf8")
		+ readFileSync(join(root, "supabase/acceptance/runtime_second_production_review.sql"), "utf8")
		+ readFileSync(join(root, "supabase/acceptance/runtime_third_production_review.sql"), "utf8")
		+ readFileSync(join(root, "supabase/acceptance/runtime_session_stop_authority.sql"), "utf8");
	const end = original.indexOf("select jsonb_build_object('schema','qorpera.wake-integration-acceptance/v1'");
	assert(end > 0);
	const acceptance = original.slice(0, end) + regression + original.slice(end);
	report.acceptanceSha256 = hash("sha256", acceptance);
	report.cases = JSON.parse(sql(fixture + acceptance).split("\n").at(-1)).cases;
	for (const item of report.cases) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}${item.error ? `: ${item.error}` : ""}`);
	assert(report.cases.every((item) => item.passed), "Database regression failed");
	const projection = JSON.parse(sql(fixture + original.slice(0, end) + regression +
		"\nselect pg_temp.review_completed_handoff();\nrollback;\n").split("\n").at(-1));
	const context = parseCloudNativeCompanyContext(projection.context, projection.binding);
	assert.equal(context.continuation?.kind, "completed_work");
	assert.equal(JSON.parse(composeCloudNativeCompanyPrompt(context)).continuation.id, projection.binding.runId);
	report.contextParity = true;
	console.log("PASS real continuation SQL -> production TypeScript parser -> native prompt");
	const parallelSetup = JSON.parse(sql(fixture + original.slice(0, end) + regression
		+ readFileSync(join(root, "supabase/acceptance/runtime_second_review_concurrency.sql"), "utf8")).split("\n").at(-1));
	const connection = parallelSetup.connection;
	const auth = `set request.jwt.claims='{"role":"authenticated","sub":"${owner}"}'; set role authenticated;`;
	const service = "set request.jwt.claims='{\"role\":\"service_role\"}';";
	// The pause is an operator brake: the operator session acts with the founder's claims.
	const companyStop = (paused) => `${auth} reset role; select public.qorpera_set_company_execution_pause('${profile}',${paused},'Review stop');`;
	const stopEffect = (key) => parallelSetup.effect.replace("'review2-effect'", `'${key}'`);
	const beforeStop = await begin(service + stopEffect("review3-before-stop"));
	const oldSnapshot = await begin("set transaction isolation level repeatable read; select count(*) from public.qorpera_company_execution_pauses;");
	const stopping = session();
	stopping.child.stdin.end(`set application_name='review-founder-stop'; ${companyStop(true)}`);
	await waitLock("review-founder-stop");
	await commit(beforeStop);
	const stopped = await stopping.done;
	assert.equal(stopped.code, 0, stopped.error); assert.equal(JSON.parse(stopped.output).paused, true);
	report.concurrency.push("founder_stop_waits_for_already_admitted_effect");
	oldSnapshot.child.stdin.end(`\\set VERBOSITY verbose\n${service} ${stopEffect("review3-stale-stop")}\ncommit;`);
	const staleStop = await oldSnapshot.done;
	assert.notEqual(staleStop.code, 0); assert.match(staleStop.error, /40001/);
	assert.equal(sql("select count(*) from public.qorpera_agent_sends where idempotency_key='review3-stale-stop';"), "0");
	report.concurrency.push("stale_repeatable_read_effect_fails_after_founder_stop");
	sql(companyStop(false));
	const stopFirst = await begin(companyStop(true));
	const waitingEffect = session();
	waitingEffect.child.stdin.end(`\\set VERBOSITY verbose\nset application_name='review-stopped-effect'; ${service} ${stopEffect("review3-waiting-stop")}`);
	await waitLock("review-stopped-effect");
	await commit(stopFirst);
	const refused = await waitingEffect.done;
	assert.notEqual(refused.code, 0); assert.match(refused.error, /55000/);
	assert.equal(sql("select count(*) from public.qorpera_agent_sends where idempotency_key='review3-waiting-stop';"), "0");
	report.concurrency.push("waiting_read_committed_effect_observes_founder_stop");
	const beforeResume = await begin("set transaction isolation level repeatable read; select count(*) from public.qorpera_company_execution_pauses;");
	sql(companyStop(false));
	beforeResume.child.stdin.end(`\\set VERBOSITY verbose\n${service} ${stopEffect("review3-stale-resume")}\ncommit;`);
	const staleResume = await beforeResume.done;
	assert.notEqual(staleResume.code, 0); assert.match(staleResume.error, /40001/);
	report.concurrency.push("stale_repeatable_read_effect_retries_after_founder_resume");
	sql(service + stopEffect("review3-resumed"));
	assert.equal(sql("select count(*) from public.qorpera_agent_sends where idempotency_key='review3-resumed';"), "1");
	report.concurrency.push("fresh_effect_succeeds_after_founder_resume");
	console.log("PASS founder stop/resume serializes effects and rejects stale snapshots");
	const firstWake = await begin(service + parallelSetup.schedule[0]);
	const secondWake = session();
	secondWake.child.stdin.end(`set application_name='review-wake-budget'; ${service} ${parallelSetup.schedule[1]}`);
	await waitLock("review-wake-budget");
	await commit(firstWake);
	const secondAdmission = await secondWake.done;
	assert.equal(secondAdmission.code, 0, secondAdmission.error);
	// There is no company wake ceiling (2026-09-24): the serialized second admission is queued too.
	assert.equal(JSON.parse(secondAdmission.output).status, "queued");
	report.concurrency.push("concurrent_schedule_admissions_serialize_without_a_company_wake_ceiling");
	console.log("PASS concurrent schedule admissions serialize and both are admitted");
	const staleWake = await begin("set transaction isolation level repeatable read; select count(*) from public.qorpera_company_wake_admission_fences;");
	assert.equal(JSON.parse(sql(service + parallelSetup.schedule[2])).status, "queued");
	staleWake.child.stdin.end(`\\set VERBOSITY verbose\n${service} ${parallelSetup.schedule[3]}\ncommit;`);
	const staleAdmission = await staleWake.done;
	assert.notEqual(staleAdmission.code, 0); assert.match(staleAdmission.error, /40001/);
	report.concurrency.push("stale_repeatable_read_wake_admission_fails_serialization");
	console.log("PASS stale repeatable-read wake admission fails serialization");
	const admittedEffect = await begin(service + parallelSetup.effect);
	const staleSource = await begin("set transaction isolation level repeatable read; select count(*) from public.qorpera_cloud_routines;");
	const sourcePause = session();
	sourcePause.child.stdin.end(`set application_name='review-source-pause'; ${auth} ${parallelSetup.pause}`);
	await waitLock("review-source-pause");
	await commit(admittedEffect);
	const pauseResult = await sourcePause.done; assert.equal(pauseResult.code, 0, pauseResult.error);
	report.concurrency.push("routine_pause_waits_for_already_admitted_public_effect");
	console.log("PASS routine pause waits for an already admitted public effect");
	staleSource.child.stdin.end(`\\set VERBOSITY verbose\n${service} ${parallelSetup.effect.replace("'review2-effect'", "'review2-stale'")}\ncommit;`);
	const staleEffect = await staleSource.done;
	assert.notEqual(staleEffect.code, 0); assert.match(staleEffect.error, /40001/);
	report.concurrency.push("stale_repeatable_read_effect_cannot_reuse_paused_routine");
	console.log("PASS stale repeatable-read effect fails after routine pause");
	const revokedEffect = session();
	revokedEffect.child.stdin.end(`\\set VERBOSITY verbose\n${service} ${parallelSetup.effect.replace("'review2-effect'", "'review2-revoked'")}`);
	const deniedEffect = await revokedEffect.done;
	assert.notEqual(deniedEffect.code, 0); assert.match(deniedEffect.error, /42501/);
	report.concurrency.push("committed_routine_pause_fences_the_next_public_effect");
	console.log("PASS committed routine pause fences the next public effect");
	const consent = (allow) => `${auth} select public.qorpera_consent_provider_connection_autonomous('${profile}','${connection}',${allow});`;
	const authority = (version) => `select public.qorpera_provider_autonomous_authority('${connection}',${version});`;
	// An effect admitted first holds a shared lock until commit. Withdrawal waits.
	const admitted = await begin(authority(2));
	assert(admitted.output().includes("t\nREVIEW_READY"));
	const withdrawal = session();
	withdrawal.child.stdin.end(`set application_name='review-withdraw'; ${consent(false)}`);
	await waitLock("review-withdraw");
	await commit(admitted);
	assert.equal((await withdrawal.done).code, 0);
	assert.equal(sql(authority(2)), "f");
	report.concurrency.push("withdrawal_waits_for_already_admitted_effect_transaction");
	console.log("PASS withdrawal waits for an already admitted effect transaction");
	const fresh = JSON.parse(sql(consent(true))).version;
	// Withdrawal wins: a concurrent reader waits, then sees the new fence.
	const withdrawing = await begin(consent(false));
	const reader = session();
	reader.child.stdin.end(`set application_name='review-reader'; ${authority(fresh)}`);
	await waitLock("review-reader");
	await commit(withdrawing);
	const read = await reader.done;
	assert.equal(read.code, 0, read.error); assert.equal(read.output, "f");
	report.concurrency.push("waiting_read_committed_admission_observes_withdrawal");
	console.log("PASS admission waiting behind withdrawal observes the new fence");
	const latest = JSON.parse(sql(consent(true))).version;
	const stale = await begin(`set transaction isolation level repeatable read; select count(*) from public.qorpera_provider_connection_versions;`);
	sql(consent(false));
	stale.child.stdin.end(`\\set VERBOSITY verbose\n${authority(latest)}\ncommit;`);
	const rejected = await stale.done;
	assert.notEqual(rejected.code, 0); assert.match(rejected.error, /40001/);
	report.concurrency.push("repeatable_read_snapshot_cannot_reuse_withdrawn_consent");
	console.log("PASS stale repeatable-read admission fails serialization after withdrawal");
	report.passed = true;
} catch (error) {
	report.error = error.message; process.exitCode = 1; console.error(report.error);
} finally {
	for (const child of sessions) child.kill("SIGTERM");
	if (started) docker(["rm", "--force", container]);
	if (volumeCreated) docker(["volume", "rm", volume]);
	report.cleanupConfirmed = true; report.finishedAt = new Date().toISOString();
	if (args.length) writeFileSync(resolve(args[1]), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	console.log(JSON.stringify({ passed: report.passed, migrations: report.migrations.length, cases: report.cases.length, concurrency: report.concurrency, cleanupConfirmed: report.cleanupConfirmed }));
}
