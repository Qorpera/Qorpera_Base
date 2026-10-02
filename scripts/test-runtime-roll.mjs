// Local PostgreSQL only: rehearses one rolling update with the packets of scripts/runtime-roll.mjs on two
// registered nodes, from the active bundle N to a fixture N+1, and checks that no company is paused, that
// N runs stay on node B while node A takes N+1 runs, and that the emergency packets reverse the switch.
// No hosted database, provider or node is touched: the hosted-db suite's disposable PostgreSQL (every migration),
// or with QORPERA_ROLL_LOCAL_PORT=<port> a local cluster's qorpera_tpl template.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DRY_RUN_ONLY, rollPackets } from "./runtime-roll.mjs";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localPort = process.env.QORPERA_ROLL_LOCAL_PORT;
let database;
let hosted = null;
let psqlArgs;
function run(command, args, input) {
	return spawnSync(command, args, { input, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
}
function sql(text) {
	const result = run(localPort ? "psql" : "docker", psqlArgs, text);
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-2000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
function fails(text) {
	const result = run(localPort ? "psql" : "docker", psqlArgs, text);
	assert.notEqual(result.status, 0, `expected a refusal:\n${result.stdout}`);
	return result.stderr;
}
const read = (path) => readFileSync(join(root, path), "utf8");
/** The packet runner: dry-run is BEGIN + body + ROLLBACK, commit is the packet as written. */
const dryRun = (text) => sql(text.replace(/commit;\n$/, "rollback;\n"));
const lastJson = (output) => JSON.parse(output.split("\n").filter((line) => line.startsWith("{")).at(-1));
const service = `set request.jwt.claims='{"role":"service_role"}';`;
const literal = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

const nodeA = "79600000-0000-4000-8000-00000000000a";
const nodeB = "79600000-0000-4000-8000-00000000000b";
const orchestratorA = "30000000-0000-4000-8000-000000000092"; // the wake fixture's orchestrator (adapter 'process')
const orchestratorB = "79600000-0000-4000-8000-0000000000b1";
const policy = (id, label, machine) => ({
	schema: "qorpera.runtime-node-policy/v1", nodeId: id, machineIdSha256: machine, label, cpuMillis: 32000, memoryBytes: 68719476736,
	headroomCpuMillis: 8000, headroomMemoryBytes: 17179869184, standardCpuMillis: 4000, standardMemoryBytes: 8589934592, enabled: true,
});
const observe = (id, machine) => `select public.qorpera_test_observe_runtime_node(${literal({
	schema: "qorpera.runtime-node-observation/v1", nodeId: id, machineIdSha256: machine, observationId: randomUUID(),
	observedAt: new Date().toISOString(), cpuMillis: 32000, memoryBytes: 68719476736, state: "ready" })});`;
const observeBoth = () => sql(`${service} ${observe(nodeA, "a".repeat(64))} ${observe(nodeB, "b".repeat(64))}`);
const heartbeat = () =>
	sql(`update public.qorpera_runner_orchestrators set last_heartbeat_at = clock_timestamp() where id in ('${orchestratorA}','${orchestratorB}');`);
// A queued run of the fixture conversation, of the active bundle (the wake fixture's own helper, by base run).
const newRun = () =>
	sql(`create function pg_temp.roll_run() returns uuid language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_id uuid := extensions.gen_random_uuid(); v_job uuid; v_input uuid := extensions.gen_random_uuid();
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (select claim.run_id from public.qorpera_runner_job_claims claim where claim.orchestrator_id = '30000000-0000-4000-8000-000000000092'
		order by claim.created_at, claim.id limit 1);
	insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
	values(v_input,'30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'user_message',v_base.requested_by_user_id,
		'{"schema":"qorpera.session-prompt/v1","text":"Work","images":[]}');
	insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
		required_capability,job_type,payload,created_by_user_id)
	values(v_base.profile_id,v_base.environment_id,'30000000-0000-4000-8000-000000000042',v_base.substrate_version_id,
		v_id,'agent_turn','agent_turn','{}',v_base.requested_by_user_id) returning id into v_job;
	insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
		substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
		required_capability,job_type,payload_sha256,compute_identity_id,transcript_start_sequence,created_by_user_id)
	values(v_id,v_base.profile_id,v_base.environment_id,'session_turn',v_id,'30000000-0000-4000-8000-000000000042',v_job,
		v_base.substrate_version_id,v_base.company_snapshot_id,'30000000-0000-4000-8000-000000000031',1,array[v_input],
		v_base.sponsor_binding_id,v_base.sponsor_version,'agent_turn','agent_turn',repeat('e',64),v_base.compute_identity_id,0,v_base.requested_by_user_id);
	update public.qorpera_runner_jobs set run_id = v_id where id = v_job;
	if not public.qorpera_reserve_execution_sponsor_authority(v_id) then raise exception 'The fixture sponsor is unavailable'; end if;
	update public.qorpera_session_inputs set execution_run_id = v_id where id = v_input;
	return v_id;
end $$;
select pg_temp.roll_run();`);
const claim = (orchestrator) =>
	JSON.parse(sql(`${service} select public.qorpera_claim_runner_job_for_orchestrator('${orchestrator}','${randomUUID()}',120);`));
// A run's work ends (as its runner would end it): its job is settled and its claims are released.
const finish = (run) =>
	sql(`update public.qorpera_runner_job_claims set status = 'released', released_at = clock_timestamp(), release_reason = 'roll rehearsal'
		where run_id = '${run}' and status in ('claimed','assigned','accepted');
	update public.qorpera_runner_jobs set status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by_user_id = created_by_user_id,
		lease_token_sha256 = null, lease_expires_at = null
		where run_id = '${run}' and status in ('queued','leased');`);
const paused = () => Number(sql("select count(*) from public.qorpera_company_execution_pauses;"));
const active = () => sql("select b.version || ' ' || b.sha256 from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;").split(" ");

/** One whole roll on a fresh database: `empty` is the packets' --empty (runs only, or the full switch). */
async function rehearse(empty, path = "roll") {
	let started = false;
	database = localPort ? `roll_${randomBytes(4).toString("hex")}` : `roll_${empty}_${path}`;
	psqlArgs = ["-X", "-qAt", "-h", "localhost", "-p", localPort, "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"];
	hosted = null;
	try {
		if (localPort) {
			const created = run("psql", ["-X", "-q", "-h", "localhost", "-p", localPort, "-U", "postgres", "-d", "postgres", "-c", `create database ${database} template qorpera_tpl`]);
			assert.equal(created.status, 0, created.stderr);
			started = true;
		} else {
			hosted = await hostedDatabase(database);
			psqlArgs = hosted.cluster.psqlArgs(database, ["-qAt"]);
		}
		sql("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);");
		sql(read("supabase/tests/fixtures/runtime-node-inventory-observer.sql"));
		const wake = read("supabase/tests/300_runtime_wake_bus.test.sql").split("-- END WAKE FIXTURE");
		assert.equal(wake.length, 2);
		sql(`${wake[0]}\ncommit;`);
		// Two nodes: node A runs the fixture orchestrator's adapter, node B a fast host.
		sql(`${service} set role service_role;
			select public.qorpera_configure_runtime_node(${literal(policy(nodeA, "node-a", "a".repeat(64)))},0);
			select public.qorpera_configure_runtime_node(${literal(policy(nodeB, "node-b", "b".repeat(64)))},0);
			select public.qorpera_enroll_runtime_node_provider('${nodeA}','${"a".repeat(64)}','native','process',repeat('1',64),4000,8589934592);
			select public.qorpera_enroll_runtime_node_provider('${nodeB}','${"b".repeat(64)}','native','native-b',repeat('2',64),4000,8589934592);
			select public.qorpera_register_runner_orchestrator('${orchestratorB}','Node B fast host','native-b',repeat('4',64),3600);`);
		observeBoth();
		heartbeat();

		// N is the active bundle; N+1 is a fixture bundle with an activation shaped like the generator's.
		const [fromVersion, fromSha] = active();
		const from = { version: Number(fromVersion), sha: fromSha };
		// N's manifest, marked; a bundle's digest is the digest of its manifest (as PostgreSQL prints the jsonb).
		const manifest = sql(`select (b.manifest || '{"rollFixture":true}'::jsonb)::text from public.qorpera_active_runtime_bundle a
			join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id where a.singleton;`).replaceAll("'", "''");
		const toSha = sql(`select encode(extensions.digest(convert_to(('${manifest}'::jsonb)::text,'utf8'),'sha256'),'hex');`);
		const to = { version: from.version + 1, sha: toSha };
		const activation = {
			name: "20260929999990_runtime_bundle_activation_roll_fixture.sql",
			text: `-- Fixture activation (scripts/test-runtime-roll.mjs).
	do $$ begin
		perform 1 from public.qorpera_active_runtime_bundle where singleton for update;
		if not exists (select 1 from public.qorpera_active_runtime_bundle a join public.qorpera_runtime_bundles b on b.id=a.runtime_bundle_id and b.sha256=a.runtime_bundle_sha256
			where a.singleton and b.bundle_key='qorpera.cloud-runtime' and b.version=${from.version} and b.sha256='${from.sha}')
		then raise exception 'Activation requires exact active runtime v${from.version}' using errcode='55000'; end if;
	insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
	values ('qorpera.cloud-runtime',${to.version},'${manifest}','${to.sha}');
	update public.qorpera_active_runtime_bundle set runtime_bundle_id = bundle.id, runtime_bundle_sha256 = bundle.sha256, activated_at = statement_timestamp()
	from public.qorpera_runtime_bundles bundle where singleton and bundle.bundle_key = 'qorpera.cloud-runtime' and bundle.version = ${to.version};
	end $$;
	`,
		};
		const migration = { name: "20260929999000_roll_fixture_probe.sql", text: "begin;\ncreate table public.qorpera_roll_fixture_probe(id integer);\ncommit;\n" };
		const reason = "roll rehearsal";
		const packets = rollPackets({ activation, migrations: [migration], from, to, nodeA, nodeB, reason, empty });
		const ready = empty === "full" ? "readyForUpdate" : "readyForNodeRelease";
		const p = (name) => packets[name];
		const commit = (name) => {
			dryRun(p(name));
			return sql(p(name));
		};

		// 00: the preflight passes and records N's pending inputs; dry-run only packets never commit anything.
		const check = lastJson(dryRun(p("00-check.sql")));
		assert.equal(check.ok, true, JSON.stringify(check.failures));
		for (const name of DRY_RUN_ONLY) assert(p(name), name);

		// A queued N run before the roll; node B's fast host will take it.
		const runN = newRun();
		const runN2 = newRun(); // a second N run, still queued when node B is about to leave N
		// 10, 20: the release migration and node B declared N.
		commit(`10-migration-${migration.name}`);
		assert.equal(sql("select count(*) from supabase_migrations.schema_migrations where version = '20260929999000';"), "1");
		assert.match(fails(p(`10-migration-${migration.name}`)), /already recorded/);
		commit("20-declare-b.sql");
		// 30: node A takes no runs; its orchestrator claims nothing, node B's takes the N run. Node B must
		// be able to claim first: with its orchestrator silent, 30 refuses.
		const stale = (orchestrator) =>
			sql(`update public.qorpera_runner_orchestrators set last_heartbeat_at = clock_timestamp() - interval '5 minutes' where id = '${orchestrator}';`);
		stale(orchestratorB);
		assert.match(fails(p("30-runs-off-a.sql")), /node B is not running/);
		heartbeat();
		observeBoth(); // 30 needs node B observed within the last minute
		commit("30-runs-off-a.sql");
		assert.equal(claim(orchestratorA), null, "node A claims nothing while its runs are off");
		assert.equal(claim(orchestratorB).work.run_id, runN, "node B takes the N run");
		// The fixture's own run on node A ends; node A is then empty of runs.
		finish(sql(`select run_id from public.qorpera_runner_job_claims where orchestrator_id = '${orchestratorA}' order by created_at, id limit 1;`));
		assert.equal(lastJson(dryRun(p("31-drain-a.sql"))).status[ready], true);
		// 40: the switch refuses while node A's orchestrator looks dead, then switches in one transaction.
		stale(orchestratorA);
		assert.match(fails(p("40-switch.sql")), /node A is not running/);
		assert.deepEqual(active(), [String(from.version), from.sha], "a refused switch changes nothing");
		heartbeat();
		observeBoth();
		const switched = lastJson(commit("40-switch.sql"));
		assert.equal(switched.nodeBServes, true, "the switch reports node B still serving N");
		assert.deepEqual(active(), [String(to.version), to.sha]);
		assert.equal(paused(), 0, "no company was paused");
		// N+1 work goes to node A only; node B still runs N.
		const runNext = newRun();
		assert.equal(sql(`select runtime_bundle_sha256 from public.qorpera_execution_runs where id = '${runNext}';`), to.sha);
		assert.equal(claim(orchestratorA).work.run_id, runNext, "node A takes the N+1 run");
		const checkN = lastJson(dryRun(p("50-check-n.sql")));
		assert(checkN.rollStatus.bundles.some((b) => b.sha256 === from.sha && b.runningRuns + b.queuedRuns >= 1), JSON.stringify(checkN.rollStatus));
		if (path === "emergency") {
			// After the switch N+1 misbehaves: pause every company with work still running, reverse, roll the
			// nodes back (by hand), clear the declarations, resume.
			const pausable = () =>
				Number(sql(`select count(*) from public.qorpera_profiles p where not public.qorpera_company_deleting(p.id) and exists (select 1 from public.qorpera_profile_members m where m.profile_id = p.id and m.role in ('owner','admin'));`));
			assert.match(fails(p("91-reverse.sql")), /paused first/);
			const pausedNow = lastJson(commit("90-pause-now.sql"));
			assert.equal(paused(), pausable(), "every company that can be paused is paused: " + JSON.stringify(pausedNow));
			commit("91-reverse.sql");
			assert.deepEqual(active(), [String(from.version), from.sha], "the active bundle is N again");
			const runBack = newRun();
			assert.equal(sql(`select runtime_bundle_sha256 from public.qorpera_execution_runs where id = '${runBack}';`), from.sha);
			assert.equal(claim(orchestratorA), null, "node A (still declared N+1, still on N+1 code) takes no N run");
			commit("92-clear-declarations.sql");
			assert.equal(sql("select count(*) from public.qorpera_runner_orchestrators where runtime_bundle_sha256 is not null;"), "0");
			const resumed = lastJson(commit("93-resume.sql"));
			assert.equal(paused(), 0, "the companies resume: " + JSON.stringify(resumed));
		} else {
			// 60: node B may not leave N while N work is queued; once it takes it, it empties and returns as N+1.
			assert.match(fails(p("60-runs-off-b.sql")), /still queued/);
			assert.equal(claim(orchestratorB).work.run_id, runN2, "node B takes the queued N run");
			// A job node B holds is running, though still queued until its runner accepts it: 60 lets B go.
			heartbeat();
			observeBoth();
			dryRun(p("60-runs-off-b.sql"));
			assert.match(fails(p("70-return-b.sql")), /not emptied of runs/);
			finish(runN);
			finish(runN2);
			// Node A must be able to claim before node B leaves.
			stale(orchestratorA);
			assert.match(fails(p("60-runs-off-b.sql")), /node A is not running/);
			heartbeat();
			observeBoth(); // 60 needs node A observed within the last minute
			commit("60-runs-off-b.sql");
			assert.equal(lastJson(dryRun(p("61-drain-b.sql"))).status[ready], true);
			heartbeat();
			observeBoth();
			commit("70-return-b.sql");
			assert.equal(sql(`select count(*) from public.qorpera_runner_orchestrators where runtime_bundle_sha256 = '${to.sha}';`), "2");
			// 80: declarations cleared, both nodes serve runs.
			finish(runNext);
			const finished = lastJson(commit("80-finish.sql"));
			assert.equal(finished.oldBundleWorkLeft, 0);
			assert.equal(sql("select count(*) from public.qorpera_runner_orchestrators where runtime_bundle_sha256 is not null;"), "0");
			assert.equal(sql(`select bool_and(enabled and runs_enabled) from public.qorpera_runtime_nodes where id in ('${nodeA}','${nodeB}');`), "t");
			assert.equal(paused(), 0, "the whole roll paused no company");
			if (path === "late") {
				// N+1 misbehaves after the finish: nothing is declared, both nodes run N+1. 91 declares both
				// N+1 so that neither takes an N run until it is rolled back.
				lastJson(commit("90-pause-now.sql"));
				commit("91-reverse.sql");
				assert.equal(sql(`select count(*) from public.qorpera_runner_orchestrators where runtime_bundle_sha256 = '${to.sha}';`), "2");
				newRun();
				heartbeat();
				assert.equal(claim(orchestratorA), null, "node A (N+1 code) takes no N run");
				assert.equal(claim(orchestratorB), null, "node B (N+1 code) takes no N run");
				const clearing = JSON.parse(dryRun(p("92-clear-declarations.sql")).split("\n").find((line) => line.startsWith('{"declaredNext"')));
				assert.equal(clearing.declaredNext.length, 2, JSON.stringify(clearing));
				commit("92-clear-declarations.sql");
				const resumed = lastJson(commit("93-resume.sql"));
				assert.equal(paused(), 0, "the companies resume: " + JSON.stringify(resumed));
				assert.deepEqual(resumed.runsOn, { a: true, b: true });
			}
		}
		console.log(JSON.stringify({ schema: "qorpera.runtime-roll-rehearsal/v1", empty, path, from: from.version, to: to.version, packets: Object.keys(packets).length, paused: 0, passed: true }));
	} finally {
		if (started)
			run("psql", ["-X", "-q", "-h", "localhost", "-p", localPort, "-U", "postgres", "-d", "postgres", "-c", `drop database if exists ${database} with (force)`]);
		hosted?.close();
	}
}

await rehearse("runs");
await rehearse("full");
await rehearse("runs", "emergency");
await rehearse("runs", "late");
