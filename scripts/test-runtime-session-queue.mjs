// Disposable PostgreSQL regressions for the session queue ownership and revocation.
// No external database URL, credentials or provider process is accepted.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { hash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--report"), "Usage: node scripts/test-runtime-session-queue.mjs [--report PATH]");
const container = `qorpera-session-queue-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${container}-data`;
const report = { schema: "qorpera.session-queue-regressions/v1", startedAt: new Date().toISOString(),
	network: "none", providerInvoked: false, deployedAcceptance: false, migrations: [], cases: [], concurrency: [], passed: false };
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "review"];
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
		if (file === "20260907000857_runtime_session_queue_isolation.sql") {
			sql("create database queue_upgrade template review;");
		}
		const bytes = readFileSync(join(root, "supabase/migrations", file)); sql(bytes);
		report.migrations.push({ file, sha256: hash("sha256", bytes) });
	}
	const component = readFileSync(join(root, "supabase/tests/335_runtime_session_queue_isolation.test.sql"), "utf8");
	report.componentSha256 = hash("sha256", component);
	report.cases = JSON.parse(sql(component).split("\n").at(-1)).cases;
	for (const item of report.cases) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}${item.error ? `: ${item.error}` : ""}`);
	assert(report.cases.every((item) => item.passed), "Queue regression failed");
	assert.equal(component.split("-- END QUEUE FIXTURE").length, 2);
	const fixture = component.split("-- END QUEUE FIXTURE")[0];
	const upgradeSql = (query) => docker([...psql.slice(0, -1), "queue_upgrade"], query);
	const legacy = JSON.parse(upgradeSql(fixture + `
select jsonb_build_object('a',current_setting('queue.a')::jsonb,'b',current_setting('queue.b')::jsonb,
 'pending',pg_temp.queue_request(current_setting('queue.a')::jsonb),
 'approved',pg_temp.queue_request(current_setting('queue.b')::jsonb,true)); commit;`).split("\n").at(-1));
	upgradeSql(readFileSync(join(root, "supabase/migrations/20260907000857_runtime_session_queue_isolation.sql"), "utf8"));
	assert.equal(upgradeSql(`select initial_execution_selection = jsonb_build_object('sponsor_binding_id',null,
 'sponsor_version',null,'compute_identity_id',null,'logical_computer_id',null,'worker_class','managed_sandbox')
 and status='pending_sponsorship' from public.qorpera_session_turn_requests where id='${legacy.pending.turn_request_id}';`), "t");
	assert.equal(upgradeSql(`select initial_execution_selection is null and status='queued' and publication_mode='review'
 and sponsor_binding_id='${legacy.b.personalSponsor}' and compute_identity_id='${legacy.b.identity}'
 from public.qorpera_session_turn_requests where id='${legacy.approved.turn_request_id}';`), "t");
	// Historical approved rows retain strict comparison with their recorded pins;
	// the migration does not invent an original placement it cannot reconstruct.
	const legacyClientIds = JSON.parse(upgradeSql(`select jsonb_build_object('input',input.client_input_id,'request',request.client_request_id)
 from public.qorpera_session_turn_requests request join public.qorpera_session_inputs input on input.id=request.input_id
 where request.id='${legacy.approved.turn_request_id}';`));
	const legacyReplay = JSON.parse(upgradeSql(`set request.jwt.claims='{"role":"authenticated","sub":"${legacy.b.member}"}';
set role authenticated;
select public.qorpera_request_session_turn_v2('${legacy.b.session}','${legacyClientIds.input}','${legacyClientIds.request}',
 '{"schema":"qorpera.session-prompt/v1","text":"Queue regression","images":[]}',
 'sponsorship_request','${legacy.b.personalSponsor}',1,'${legacy.b.owner}','${legacy.b.identity}',null,
 'managed_sandbox','agent_turn','agent_turn','review','queue-review',array['${legacy.b.staff}'::uuid]);`));
	assert.equal(legacyReplay.turn_request_id, legacy.approved.turn_request_id);
	assert.equal(legacyReplay.status, "queued");
	report.upgrade = ["pending_requests_backfilled_with_original_selection", "approved_requests_preserve_authority_pins",
		"legacy_approved_replay_retains_strict_stored_pin_comparison"];
	for (const name of report.upgrade) console.log(`PASS ${name}`);
	const setup = JSON.parse(sql(fixture + `
select set_config('queue.i',pg_temp.queue_company(343)::text,true);
select set_config('queue.j',pg_temp.queue_company(344)::text,true);
select jsonb_build_object('a',current_setting('queue.a')::jsonb,'b',current_setting('queue.b')::jsonb,
 'c',pg_temp.queue_company(337),'d',pg_temp.queue_company(338),'e',pg_temp.queue_company(339),
 'f',pg_temp.queue_company(340),'g',pg_temp.queue_company(341),'h',pg_temp.queue_company(342),
 'i',current_setting('queue.i')::jsonb,'j',current_setting('queue.j')::jsonb,
 'iReview',pg_temp.queue_review(current_setting('queue.i')::jsonb),
 'jReview',pg_temp.queue_review(current_setting('queue.j')::jsonb));
commit;`).split("\n").at(-1));
	const service = "set request.jwt.claims='{\"role\":\"service_role\"}'; set role service_role;";
	const auth = (user) => `set request.jwt.claims='{"role":"authenticated","sub":"${user}"}'; set role authenticated;`;
	const body = "'{\"schema\":\"qorpera.session-prompt/v1\",\"text\":\"Queue regression\",\"images\":[]}'";
	const id = () => sql("select extensions.gen_random_uuid();");
	const append = (company, client = id(), privateSession = false) => `${auth(company.member)}
select public.qorpera_append_session_input('${privateSession ? company.privateSession : company.session}','${client}','user_message',${body});`;
	const request = (company, client = id(), requestId = id()) => `${auth(company.member)}
select public.qorpera_request_session_turn_v2('${company.session}','${client}','${requestId}',${body},
 'sponsorship_request',null,null,'${company.owner}',null,null,'managed_sandbox','agent_turn','agent_turn',
 'review','queue-review',array['${company.staff}'::uuid]);`;
	const remove = (company) => `${auth(company.owner)} select public.qorpera_remove_profile_member('${company.profile}','${company.member}');`;
	const pause = (company, paused) => `${auth(company.owner)} select public.qorpera_set_company_execution_pause('${company.profile}',${paused},'Queue concurrency');`;
	const materialize = `${service} select public.qorpera_materialize_session_execution_runs(32);`;
	const sponsored = `${service} select public.qorpera_materialize_session_turn_requests(32);`;
	const check = (query) => assert.equal(sql(query), "t", query);
	const passed = (name) => { report.concurrency.push(name); console.log(`PASS ${name}`); };
	// Request creation holds the profile/session before its input and request commit.
	// A preexisting ordinary input ensures the other materializer really visits it.
	const ordinaryA = JSON.parse(sql(append(setup.a))).input_id;
	sql(append(setup.b));
	const producer = await begin(request(setup.a));
	const pending = JSON.parse(producer.output().split("\n").find((line) => line.startsWith("{")));
	sql(materialize);
	check(`select execution_run_id is null from public.qorpera_session_inputs where id='${ordinaryA}';`);
	check(`select count(*)=1 from public.qorpera_execution_runs where profile_id='${setup.b.profile}';`);
	await commit(producer);
	sql(materialize);
	check(`select execution_run_id is null from public.qorpera_session_inputs where id='${pending.input_id}';`);
	check(`select input_ids=array['${ordinaryA}'::uuid] from public.qorpera_execution_runs where profile_id='${setup.a.profile}';`);
	passed("request_creation_defers_contended_session_and_preserves_request_ownership");
	// Ordinary admission wins the opposite race. Attaching a new request must fail
	// after waiting for the session; the claimed input cannot gain a second owner.
	const clientC = id();
	sql(append(setup.c, clientC));
	const admitted = await begin(materialize);
	const adopting = session();
	adopting.child.stdin.end(`\\set VERBOSITY verbose\nset application_name='queue-adoption'; ${request(setup.c, clientC)}`);
	await waitLock("queue-adoption");
	await commit(admitted);
	const adoption = await adopting.done;
	assert.notEqual(adoption.code, 0); assert.match(adoption.error, /23505/);
	check(`select count(*)=0 from public.qorpera_session_turn_requests where profile_id='${setup.c.profile}';`);
	passed("ordinary_admission_wins_before_new_request_adoption");
	// Revocation holds the member row and closes the private session. Queue work
	// skips this company without mistaking lock contention for revoked authority.
	const inputD = JSON.parse(sql(append(setup.d))).input_id;
	sql(append(setup.d, id(), true));
	sql(append(setup.e));
	const revoking = await begin(remove(setup.d));
	sql(materialize);
	check(`select failed_at is null and execution_run_id is null from public.qorpera_session_inputs where id='${inputD}';`);
	check(`select count(*)=1 from public.qorpera_execution_runs where profile_id='${setup.e.profile}';`);
	await commit(revoking);
	sql(materialize);
	check(`select failed_at is not null and execution_run_id is null from public.qorpera_session_inputs where id='${inputD}';`);
	check(`select status='closed' from public.qorpera_shared_sessions where id='${setup.d.privateSession}';`);
	passed("concurrent_removal_defers_then_retires_input_without_blocking_other_company");
	// Admission winning first holds member access through its commit. Removal
	// waits, then takes effect; an admitted run still carries its original author.
	sql(append(setup.f));
	const admittedFirst = await begin(materialize);
	const removing = session();
	removing.child.stdin.end(`set application_name='queue-remove'; ${remove(setup.f)}`);
	await waitLock("queue-remove");
	await commit(admittedFirst);
	const removed = await removing.done;
	assert.equal(removed.code, 0, removed.error);
	check(`select requested_by_user_id='${setup.f.member}' from public.qorpera_execution_runs where profile_id='${setup.f.profile}';`);
	passed("admission_holds_author_access_until_commit_before_removal");
	// Approved sponsored work and an ordinary input compete for the same session.
	const approved = JSON.parse(sql(request(setup.g)));
	sql(`${auth(setup.g.owner)} select public.qorpera_approve_session_turn_sponsorship('${approved.turn_request_id}',
 '${setup.g.personalSponsor}',1,'${setup.g.identity}');`);
	const ordinaryG = JSON.parse(sql(append(setup.g))).input_id;
	const sponsorAdmission = await begin(sponsored);
	sql(materialize);
	await commit(sponsorAdmission);
	sql(sponsored);
	check(`select count(*)=1 and bool_and(id='${approved.turn_request_id}' and publication_mode='review'
 and sponsor_binding_id='${setup.g.personalSponsor}' and compute_identity_id='${setup.g.identity}')
 from public.qorpera_execution_runs where profile_id='${setup.g.profile}';`);
	check(`select execution_run_id is null from public.qorpera_session_inputs where id='${ordinaryG}';`);
	passed("concurrent_sponsored_and_ordinary_materializers_keep_one_run_and_exact_pins");
	// A stop in progress is contention, then a durable pause; neither fails input.
	const inputH = JSON.parse(sql(append(setup.h))).input_id;
	const stopping = await begin(pause(setup.h, true));
	sql(materialize);
	await commit(stopping);
	sql(materialize);
	check(`select execution_run_id is null and failed_at is null from public.qorpera_session_inputs where id='${inputH}';`);
	sql(pause(setup.h, false));
	sql(materialize);
	check(`select execution_run_id is not null and failed_at is null from public.qorpera_session_inputs where id='${inputH}';`);
	passed("concurrent_founder_pause_defers_input_until_resume");
	// Review admission shares the company stop fence. A contended review must
	// remain queued while another company's review can be materialized.
	const reviewMaterialize = `${service} select public.qorpera_materialize_company_proposal_review_runs(32);`;
	const reviewStopping = await begin(pause(setup.i, true));
	sql(reviewMaterialize);
	check(`select status='queued' and run_id is null from public.qorpera_company_proposal_review_assignments where proposal_id='${setup.iReview}';`);
	check(`select status='running' and run_id is not null from public.qorpera_company_proposal_review_assignments where proposal_id='${setup.jReview}';`);
	await commit(reviewStopping);
	sql(reviewMaterialize);
	check(`select status='queued' and run_id is null from public.qorpera_company_proposal_review_assignments where proposal_id='${setup.iReview}';`);
	sql(pause(setup.i, false));
	const reviewAdmitted = await begin(reviewMaterialize);
	const reviewStopAfter = session();
	reviewStopAfter.child.stdin.end(`set application_name='review-stop-after'; ${pause(setup.i, true)}`);
	await waitLock("review-stop-after");
	await commit(reviewAdmitted);
	const reviewStopped = await reviewStopAfter.done;
	assert.equal(reviewStopped.code, 0, reviewStopped.error);
	check(`select run_id is not null from public.qorpera_company_proposal_review_assignments where proposal_id='${setup.iReview}';`);
	passed("review_pause_defers_contended_company_and_preserves_other_company_progress");
	passed("review_admission_holds_company_fence_until_commit_before_stop");
	const catalog = sql(`select jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,
 'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) order by p.oid::regprocedure::text)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'qorpera_%';`);
	report.catalogSha256 = hash("sha256", catalog);
	if (args.length) writeFileSync(resolve(args[1]).replace(/\.json$/, ".functions.json"), `${catalog}\n`, { flag: "wx" });
	report.passed = true;
} catch (error) {
	report.error = error.message; process.exitCode = 1; console.error(report.error);
} finally {
	for (const child of sessions) child.kill("SIGTERM");
	if (started) docker(["rm", "--force", container]);
	if (volumeCreated) docker(["volume", "rm", volume]);
	report.cleanupConfirmed = true; report.finishedAt = new Date().toISOString();
	if (args.length) writeFileSync(resolve(args[1]), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
	console.log(JSON.stringify({ passed: report.passed, migrations: report.migrations.length, cases: report.cases.length,
		concurrency: report.concurrency, cleanupConfirmed: report.cleanupConfirmed }));
}
