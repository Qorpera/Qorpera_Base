// Disposable PostgreSQL regressions for recovery admission and queue isolation.
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
assert(
	args.length === 0 || (args.length === 2 && args[0] === "--report"),
	"Usage: node scripts/test-runtime-recovery-admission.mjs [--report PATH]",
);
const container = `qorpera-recovery-admission-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${container}-data`;
const report = {
	schema: "qorpera.recovery-admission-regressions/v1",
	startedAt: new Date().toISOString(),
	network: "none",
	providerInvoked: false,
	deployedAcceptance: false,
	driverSha256: hash("sha256", readFileSync(fileURLToPath(import.meta.url))),
	migrations: [],
	concurrency: [],
	passed: false,
};
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "review"];
const sessions = new Set();
function docker(argumentsValue, input) {
	const result = spawnSync("docker", argumentsValue, {
		input,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || result.stdout);
	return result.stdout.trim();
}
const sql = (query) => docker(psql, "set statement_timeout='5s';\n" + query);
function session() {
	const child = spawn("docker", psql);
	sessions.add(child);
	let output = "",
		error = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		error += chunk;
	});
	const done = new Promise((resolveDone, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			sessions.delete(child);
			resolveDone({ code, output: output.trim(), error });
		});
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
	await until(
		() => current.output().includes("REVIEW_READY") || current.child.exitCode !== null,
		"transaction barrier",
	);
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
	await until(
		() =>
			sql(
				`select count(*) from pg_stat_activity where application_name='${application}' and wait_event_type='Lock';`,
			) === "1",
		"competing consent lock",
	);
}
let started = false,
	volumeCreated = false;
try {
	docker(["volume", "create", volume]);
	volumeCreated = true;
	docker([
		"run",
		"--detach",
		"--name",
		container,
		"--network",
		"none",
		"--env",
		"POSTGRES_PASSWORD=review-disposable-only",
		"--env",
		"POSTGRES_DB=review",
		"--mount",
		`type=volume,source=${volume},target=/var/lib/postgresql/data`,
		POSTGRES_IMAGE,
	]);
	started = true;
	await until(
		() =>
			spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "review"], {
				stdio: "ignore",
			}).status === 0,
		"PostgreSQL startup",
	);
	sql(readFileSync(join(root, "supabase/tests/bootstrap.sql"), "utf8"));
	for (const file of sortMigrationNames(readdirSync(join(root, "supabase/migrations")))) {
		const bytes = readFileSync(join(root, "supabase/migrations", file));
		sql(bytes);
		report.migrations.push({ file, sha256: hash("sha256", bytes) });
	}

	const component = readFileSync(join(root, "supabase/tests/335_runtime_session_queue_isolation.test.sql"), "utf8");
	report.componentSha256 = hash("sha256", component);
	const fixture = component.split("-- END QUEUE FIXTURE")[0];
	const helpers = [...fixture.matchAll(/^create function pg_temp[\s\S]+?\$\$;/gm)].map((match) => match[0]).join("\n");
	assert(helpers.includes("queue_finish_recovery"));
	const setup = JSON.parse(
		sql(
			fixture +
				`
select set_config('recovery.ordinary',pg_temp.queue_recovery_work(current_setting('queue.a')::jsonb,'ordinary')::text,true);
select set_config('recovery.sponsored',pg_temp.queue_recovery_work(pg_temp.queue_company(347),'sponsored')::text,true);
select set_config('recovery.wake',pg_temp.queue_recovery_work(pg_temp.queue_company(348),'wake')::text,true);
-- Seed the empty File projection; this test exercises listener admission and
-- contention, not storage verification or gateway cutover.
update public.qorpera_company_files set path_gateway_version=1,path_index_snapshot_id=head_snapshot_id
 where environment_id=pg_temp.queue_id(348,20);
insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,policy,created_by_user_id)
 values(pg_temp.queue_id(348,20),'','subtree','company_shared','normal',pg_temp.queue_id(348,1));
select set_config('recovery.root',jsonb_build_object('id',id,'version',version)::text,true)
 from public.qorpera_company_path_resources where environment_id=pg_temp.queue_id(348,20) and path='';
select pg_temp.queue_auth((current_setting('recovery.wake')::jsonb->>'owner')::uuid);
set local role authenticated;
select public.qorpera_grant_company_path((current_setting('recovery.root')::jsonb->>'id')::uuid,
 (current_setting('recovery.root')::jsonb->>'version')::uuid,'staff_agent',pg_temp.queue_id(348,54),array['read']);
select public.qorpera_upsert_cloud_routine(pg_temp.queue_id(348,20),extensions.gen_random_uuid(),extensions.gen_random_uuid(),
 (current_setting('recovery.wake')::jsonb->>'staff')::uuid,'Recovery listener','Observe file changes.',
 '[{"id":"changes","kind":"listener","source":"company-file","path":"","match":"subtree","replyPolicy":"silent","timeZone":"UTC"}]',
 'low',(current_setting('recovery.wake')::jsonb->>'binding')::uuid,1,null,'agent_turn','agent_turn',true,'automatic',null,'{}');
reset role;
select jsonb_build_object('ordinary',current_setting('recovery.ordinary')::jsonb,
 'sponsored',current_setting('recovery.sponsored')::jsonb,'wake',current_setting('recovery.wake')::jsonb,
 'healthy',current_setting('queue.b')::jsonb); commit;`,
		)
			.split("\n")
			.at(-1),
	);
	const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
	const literal = (value) => quote(JSON.stringify(value)) + "::jsonb";
	const service = 'set request.jwt.claims=\'{"role":"service_role"}\'; set role service_role;';
	const auth = (user) => `set request.jwt.claims='{"role":"authenticated","sub":"${user}"}'; set role authenticated;`;
	const cases = [setup.ordinary, setup.sponsored, setup.wake];
	const profiles = cases.map((item) => quote(item.profile)).join(",");
	const identities = cases.map((item) => quote(item.identity)).join(",");
	const claim =
		service +
		"select public.qorpera_claim_runner_job_for_orchestrator('33500000-0000-4000-8000-000000000090',extensions.gen_random_uuid(),300);";
	const claimThree = () => sql(claim + claim + claim);
	const check = (query) => assert.equal(sql(query), "t", query);
	const passed = (name) => {
		report.concurrency.push(name);
		console.log("PASS " + name);
	};
	const pending = () => {
		check(`select count(*)=0 from public.qorpera_execution_runs where profile_id in(${profiles});`);
		check(
			`select execution_run_id is null and failed_at is null from public.qorpera_session_inputs where id='${setup.ordinary.input}';`,
		);
		check(
			`select status='queued' and run_id is null from public.qorpera_session_turn_requests where id='${setup.sponsored.request}';`,
		);
		check(
			`select status='queued' and run_id is null from public.qorpera_wake_occurrences where id='${setup.wake.wake}';`,
		);
	};
	const claimHealthy = () => {
		sql(
			service +
				`select public.qorpera_terminalize_runner_attempt(id,'failed','Healthy queue fixture progression',false)
   from public.qorpera_runner_jobs where profile_id='${setup.healthy.profile}' and status in('queued','leased');`,
		);
		const input = JSON.parse(
			sql(
				auth(setup.healthy.member) +
					`select public.qorpera_append_session_input('${setup.healthy.session}',extensions.gen_random_uuid(),
   'user_message','{"schema":"qorpera.session-prompt/v1","text":"Unaffected company","images":[]}');`,
			),
		).input_id;
		claimThree();
		check(`select count(*)=1 from public.qorpera_runner_job_claims c join public.qorpera_execution_runs r on r.id=c.run_id
   where r.profile_id='${setup.healthy.profile}' and '${input}'=any(r.input_ids);`);
	};
	const held = await begin(
		`select id from public.qorpera_member_compute_identities where id in(${identities}) for update;`,
	);
	claimHealthy();
	pending();
	await commit(held);
	passed("identity_lock_contention_defers_all_three_queues_without_blocking_healthy_claim");
	const recovering = await begin(
		helpers +
			"\nselect jsonb_build_object(" +
			cases.map((item) => quote(item.lane) + ",pg_temp.queue_begin_recovery(" + literal(item) + ")").join(",") +
			");",
	);
	const recovery = JSON.parse(
		recovering
			.output()
			.split("\n")
			.find((line) => line.startsWith("{")),
	);
	claimHealthy();
	pending();
	check("select count(*)=1 from public.qorpera_company_file_wake_cursors where active;");
	await commit(recovering);
	claimHealthy();
	pending();
	passed("recovery_holding_profile_and_identity_defers_inputs_sponsorship_wakes_and_file_listener");
	passed("committed_recovery_keeps_all_three_queues_pending_across_repeated_global_claims");
	sql(
		"begin;\n" +
			helpers +
			"\n" +
			cases
				.map(
					(item) =>
						"select pg_temp.queue_finish_recovery(" + literal(item) + "," + literal(recovery[item.lane]) + ");",
				)
				.join("\n") +
			"commit;",
	);
	claimThree();
	for (const item of cases) {
		check(`select count(*)=1 and bool_and(compute_recovery_epoch=1 and compute_identity_id='${item.identity}' and sponsor_binding_id='${item.binding}' and sponsor_version=1)
   from public.qorpera_execution_runs where profile_id='${item.profile}';`);
		check(
			`select count(*)=1 from public.qorpera_runner_job_claims c join public.qorpera_execution_runs r on r.id=c.run_id where r.profile_id='${item.profile}';`,
		);
	}
	passed("completed_recovery_resumes_each_original_work_item_once_with_new_epoch");
	const item = setup.ordinary;
	const registerTarget = () => {
		const target = sql("select extensions.gen_random_uuid();");
		sql(
			service +
				`select public.qorpera_register_identity_recovery_target('${item.authority}',repeat('c',64),'${target}','${item.identity}',
   extensions.gen_random_uuid(),repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64));`,
		);
		return target;
	};
	const requestTarget = (target) =>
		auth(item.owner) +
		`select public.qorpera_request_identity_recovery('${item.identity}','${target}',extensions.gen_random_uuid(),1,repeat('b',64),'nas');`;
	const nextInput = () => {
		sql(
			service +
				`select public.qorpera_terminalize_runner_attempt(id,'failed','Recovery concurrency fixture',false) from public.qorpera_runner_jobs
   where profile_id='${item.profile}' and status in('queued','leased');`,
		);
		return JSON.parse(
			sql(
				auth(item.member) +
					`select public.qorpera_append_session_input('${item.session}',extensions.gen_random_uuid(),
   'user_message','{"schema":"qorpera.session-prompt/v1","text":"Next recovery race","images":[]}');`,
			),
		).input_id;
	};
	const input = nextInput();
	const target = registerTarget();
	const admitting = await begin(service + "select public.qorpera_materialize_session_execution_runs(32);");
	const after = session();
	after.child.stdin.end("set application_name='recovery-after-admission';" + requestTarget(target));
	await waitLock("recovery-after-admission");
	await commit(admitting);
	const afterResult = await after.done;
	assert.equal(afterResult.code, 0, afterResult.error);
	const nextRecovery = JSON.parse(afterResult.output);
	check(
		`select r.compute_recovery_epoch=1 and not public.qorpera_execution_compute_available(r) from public.qorpera_execution_runs r where '${input}'=any(r.input_ids);`,
	);
	passed("admission_holds_identity_until_commit_then_recovery_fences_the_admitted_run");
	sql(
		"begin;\n" +
			helpers +
			"\nselect pg_temp.queue_finish_recovery(" +
			literal({ ...item, target }) +
			"," +
			literal(nextRecovery) +
			");commit;",
	);
	const staleInput = nextInput();
	const staleTarget = registerTarget();
	const stale = session();
	stale.child.stdin.write(`\\set VERBOSITY verbose
begin isolation level repeatable read;
select recovery_epoch from public.qorpera_member_compute_identities where id='${item.identity}';
select 'REVIEW_READY';\n`);
	await until(() => stale.output().includes("REVIEW_READY"), "stale snapshot barrier");
	sql(requestTarget(staleTarget));
	stale.child.stdin.end(claim + "commit;");
	const staleResult = await stale.done;
	assert.notEqual(staleResult.code, 0);
	assert.match(staleResult.error, /40001/);
	check(
		`select execution_run_id is null and failed_at is null from public.qorpera_session_inputs where id='${staleInput}';`,
	);
	passed("stale_repeatable_read_claim_rejects_recovery_changed_after_snapshot");
	const catalog = sql(
		"select jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'qorpera_%';",
	);
	report.catalogSha256 = hash("sha256", catalog);
	if (args.length)
		writeFileSync(resolve(args[1]).replace(/\.json$/, ".functions.json"), catalog + "\n", { flag: "wx" });

	report.passed = true;
} catch (error) {
	report.error = error.message;
	process.exitCode = 1;
	console.error(report.error);
} finally {
	for (const child of sessions) child.kill("SIGTERM");
	if (started) docker(["rm", "--force", container]);
	if (volumeCreated) docker(["volume", "rm", volume]);
	report.cleanupConfirmed = true;
	report.finishedAt = new Date().toISOString();
	if (args.length) writeFileSync(resolve(args[1]), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
	console.log(
		JSON.stringify({
			passed: report.passed,
			migrations: report.migrations.length,
			concurrency: report.concurrency.length,
			cleanupConfirmed: true,
		}),
	);
}
