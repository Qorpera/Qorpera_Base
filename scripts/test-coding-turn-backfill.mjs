// Local PostgreSQL only. Coding sessions recorded before 20260925113000 get one
// turn row per turn, with their inputs, outcomes and the one submission the
// session held; a session already stuck in the state of review finding #8 (its
// next sequence carrying the lost turn's submission) runs its retry after the
// migration, and the context that retry reads is exactly the committed sample
// the native runtime's parser is tested with
// (packages/runtime/test/fixtures/coding-turn-context-backfilled.json).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTestFixture, POSTGRES_IMAGE, sortMigrationNames } from "./test-hosted-db.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migration = "20260925113000_runtime_coding_turn_continuity.sql";
const sample = "packages/runtime/test/fixtures/coding-turn-context-backfilled.json";
const container = `qorpera-coding-turn-backfill-${randomBytes(6).toString("hex")}`;
const psql = ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "qorpera_test", "-v", "ON_ERROR_STOP=1"];
const read = (path) => readFileSync(join(root, path), "utf8");
function docker(args, input) {
	const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
	assert(!result.error && result.status === 0, `${result.stderr}\n${result.stdout?.slice(-4000) ?? ""}\n${result.error ?? ""}`);
	return result.stdout.trim();
}
const sql = (text) => docker(psql, text);

// Seed against the historical schema. The current executor fixture requires
// fleet admission, which is introduced only after this migration boundary.
const seed = `${read("scripts/fixtures/coding-turn-pre-continuity.sql")}
create function pg_temp.observe() returns void language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
	select null::void
$$;
create function pg_temp.begin_turn(p_claim jsonb) returns jsonb language plpgsql as $$
declare v_worker uuid := (p_claim ->> 'workerId')::uuid; v_turn jsonb; v_run uuid;
begin
	perform pg_temp.observe();
	perform public.qorpera_plan_coding_machine(v_worker,(p_claim ->> 'leaseToken')::uuid,repeat('c',64));
	perform public.qorpera_authorize_coding_machine_run(v_worker,(p_claim ->> 'leaseToken')::uuid,
		current_setting('qorpera_test.coding_binding'),current_setting('qorpera_test.coding_storage')::jsonb,repeat('c',64));
	v_turn := public.qorpera_begin_coding_turn(v_worker,(p_claim ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId',current_setting('qorpera_test.coding_vm'),'turnId',public.qorpera_coding_turn_id(v_worker,(p_claim ->> 'sequence')::int)));
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_turn ->> 'occurrenceId')::uuid;
	return jsonb_build_object('run',v_run,'binding',pg_temp.wake_start(v_run));
end
$$;
create function pg_temp.answer(p_text text,p_request uuid) returns void language plpgsql as $$
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session((pg_temp.worker_row('fix-send')).id,p_text,p_request);
	perform pg_temp.path_claims('service_role');
end
$$;
do $$
declare v_worker uuid := (pg_temp.worker_row('fix-send')).id; v_claim jsonb := current_setting('qorpera_test.coding_claim')::jsonb; v_turn jsonb;
begin
	-- Turn 1 finishes with draft PR 204.
	v_turn := pg_temp.begin_turn(v_claim);
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','finish','operationKey','done',
		'summary','Composer posts first.','headSha','b4d8f9f1c0b6e5a2d3c4b5a69788776655443322'));
	perform pg_temp.finish_job((v_turn ->> 'run')::uuid,'completed');
	perform public.qorpera_complete_coding_turn(v_worker,(v_claim ->> 'leaseToken')::uuid,'succeeded','Composer posts first.',null,
		'{"url":"https://github.com/Qorpera/Qorpera_Base/pull/204","number":204,"headSha":"b4d8f9f1c0b6e5a2d3c4b5a69788776655443322"}',
		null,null,null,null,null);
	-- Turn 2 (the owner's follow-up) ends with a question and its choices.
	perform pg_temp.answer('Also fix the group chat composer.','30000000-0000-4000-8000-000000000401');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_turn := pg_temp.begin_turn(v_claim);
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','ask','operationKey','poll',
		'summary','Composer fixed.','question','Keep 250 ms, or raise to 500 ms?','options',jsonb_build_array('Keep 250 ms','Raise to 500 ms')));
	perform pg_temp.finish_job((v_turn ->> 'run')::uuid,'completed');
	perform public.qorpera_complete_coding_turn(v_worker,(v_claim ->> 'leaseToken')::uuid,'blocked','Composer fixed.',
		'Keep 250 ms, or raise to 500 ms?',null,null,null,null,null,'["Keep 250 ms","Raise to 500 ms"]');
	-- Turn 3 (the answer) asks again, and its executor is lost; the next poll fails the session.
	perform pg_temp.answer('Raise it.','30000000-0000-4000-8000-000000000402');
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	v_turn := pg_temp.begin_turn(v_claim);
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','ask','operationKey','backoff',
		'summary','The poll interval is 500 ms now.','question','Should the poll also back off after errors?','options',jsonb_build_array('Yes','No')));
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = v_worker;
	perform public.qorpera_claim_coding_session('exec-test',60);
	-- The owner retries: turn 4 is queued with turn 3's submission still on the session (#8).
	perform pg_temp.answer('Yes, back off.','30000000-0000-4000-8000-000000000403');
	perform pg_temp.wake_assert((select (submission ->> 'sequence')::int from public.qorpera_coding_sessions where worker_id = v_worker) = 3
		and (pg_temp.worker_row('fix-send')).sequence = 4,'The seed reproduces the stuck retry');
end $$;
commit;
`;

// Test 300's own helpers, for a session after the migration.
const helpers = [...read("supabase/tests/300_runtime_wake_bus.test.sql").matchAll(/create function pg_temp\.(path_claims|wake_assert|wake_start)\([\s\S]*?\n\$\$;\n/g)]
	.map((match) => match[0])
	.join("");
assert.equal((helpers.match(/create function/g) ?? []).length, 3, "Test 300's helpers are available");

let started = false;
try {
	docker(["run", "-d", "--rm", "--name", container, "--network", "none", "-e", "POSTGRES_PASSWORD=qorpera-test-only",
		"-e", "POSTGRES_DB=qorpera_test", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g", POSTGRES_IMAGE]);
	started = true;
	let ready = 0;
	for (let attempt = 0; attempt < 60 && ready < 2; attempt++) {
		const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres", "-d", "qorpera_test"], { timeout: 2000 });
		ready = probe.status === 0 ? ready + 1 : 0;
		if (ready < 2) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.equal(ready, 2, "Disposable database must start");
	sql(read("supabase/tests/bootstrap.sql"));
	const migrations = sortMigrationNames(readdirSync(join(root, "supabase/migrations")));
	assert(migrations.includes(migration), `${migration} is in the migration chain`);
	for (const name of migrations.filter((name) => name < migration)) sql(read(`supabase/migrations/${name}`));
	sql(expandTestFixture("seed", (name) => (name === "seed" ? seed : read(`supabase/tests/${name}`))));
	for (const name of migrations.filter((name) => name >= migration)) sql(read(`supabase/migrations/${name}`));

	// Every turn has its row; the stuck submission is back in the turn that made it.
	const turns = JSON.parse(sql(`select jsonb_agg(jsonb_build_object('key',w.worker_key,'sequence',t.sequence,'from',t.input_from,'text',t.input_text,
		'submitted',t.submission ->> 'kind','question',t.submission ->> 'question','state',t.outcome ->> 'state','reason',t.outcome ->> 'reason',
		'needs',t.outcome ->> 'needs','pr',t.outcome #>> '{pullRequest,number}',
		'settledAtEvent',t.settled_at is not null and t.settled_at < (select min(later.created_at) from public.qorpera_coding_session_turns later
			where later.worker_id = t.worker_id and later.sequence > t.sequence))
		order by w.worker_key, t.sequence)
		from public.qorpera_coding_session_turns t join public.qorpera_runtime_workers w on w.id = t.worker_id;`));
	assert.deepEqual(
		turns.map(({ key, sequence, from, text, submitted, question, state, reason, needs, pr }) => [
			key, sequence, from, text, submitted, question, state, reason, needs, pr,
		]),
		[
			["fix-send", 1, "dispatch", null, null, null, "succeeded", null, null, "204"],
			["fix-send", 2, "member", "Also fix the group chat composer.", null, null, "blocked", null, "Keep 250 ms, or raise to 500 ms?", "204"],
			["fix-send", 3, "member", "Raise it.", "ask", "Should the poll also back off after errors?", "failed", "executor-lease-expired", null, null],
			["fix-send", 4, "member", "Yes, back off.", null, null, null, null, null, null],
			["fix-send-2", 1, "dispatch", null, null, null, "cancelled", "parent_cancelled", null, null],
		],
	);
	assert(turns.filter((turn) => turn.key === "fix-send" && turn.sequence < 4).every((turn) => turn.settledAtEvent),
		"Backfilled turns settle at their recorded times, before the next turn started");

	// The stuck retry runs, and reads the lost question as the one its reply answers.
	const context = JSON.parse(sql(`begin;
${helpers}
select pg_temp.path_claims('service_role');
select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
	'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
	'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
	public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
	jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb)) is not null;
create function pg_temp.retry() returns jsonb language plpgsql as $$
declare v_worker uuid := (select id from public.qorpera_runtime_workers where worker_key = 'fix-send'); v_claim jsonb; v_plan jsonb;
	v_turn jsonb; v_run uuid; v_binding jsonb; v_context jsonb;
begin
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert((v_claim ->> 'sequence')::int = 4,'The retry is claimed');
	v_plan := public.qorpera_plan_coding_machine(v_worker,(v_claim ->> 'leaseToken')::uuid,repeat('c',64));
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_machine_run(v_worker,(v_claim ->> 'leaseToken')::uuid,(v_plan -> 'binding')::text,
		(select binding from public.qorpera_coding_storage_volumes where worker_id = v_worker),repeat('c',64)) ->> 'intent' = 'run','The retry has its machine');
	v_turn := public.qorpera_begin_coding_turn(v_worker,(v_claim ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId',v_plan ->> 'machineId','turnId',public.qorpera_coding_turn_id(v_worker,4)));
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_turn ->> 'occurrenceId')::uuid;
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_turn(v_binding) #> '{coding,submission}' = 'null'::jsonb,
		'The retry inherits no submission');
	v_context := public.qorpera_read_coding_turn_context(v_binding);
	perform pg_temp.wake_assert(public.qorpera_submit_coding_turn(v_binding,jsonb_build_object('kind','finish','operationKey','retry',
		'summary','Backs off.','headSha',repeat('d',40))) ->> 'sequence' = '4','The retry records its own submission');
	return jsonb_set(v_context,'{workerId}','"00000000-0000-4000-8000-000000000000"');
end
$$;
select pg_temp.retry()::text;
rollback;`).split("\n").at(-1));
	// QORPERA_WRITE_CODING_TURN_SAMPLE=1 rewrites the sample after a deliberate change of the context's shape.
	if (process.env.QORPERA_WRITE_CODING_TURN_SAMPLE === "1") writeFileSync(join(root, sample), `${JSON.stringify(context, null, "\t")}\n`);
	assert.deepEqual(context, JSON.parse(read(sample)), "The retry reads the committed sample context");
	process.stdout.write("Coding turn backfill: turns recorded, the stuck retry runs, context matches the sample\n");
} finally {
	if (started) spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
}
