-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930602000: a run a member is waiting for is claimed before an older wake, and a fast host that is full looks at it
-- again after 2 s instead of 15. On the folder-v2 runtime base: Alice's run messages Bob (a wake run, the older job), then
-- the owner posts in Carol's thread (room_delivery), or starts Carol's first run: a session turn whose only input is a
-- kickoff, which no member waits on, and the same turn with a member's message. The bound attempt: test 563. The overflow's
-- window: tests 643 and 810.

select pg_temp.base_claims('service_role');
create function pg_temp.mf_claim() returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
		extensions.gen_random_uuid(), 120)
$$;
create function pg_temp.mf_refuse(p_claim jsonb, p_reason text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim('92400000-0000-4000-8000-000000000092',
		(p_claim ->> 'claim_id')::uuid, extensions.gen_random_uuid(), 'ADMISSION_REFUSED:' || p_reason)
$$;
-- The wait the last release set: both times come from one statement, so a slow machine cannot change the answer.
create function pg_temp.mf_wait(p_run uuid) returns interval language sql as $$
	select job.dispatch_deferred_until - claim.released_at from public.qorpera_runner_jobs job
	join public.qorpera_runner_job_claims claim on claim.job_id = job.id
	where job.run_id = p_run and claim.released_at is not null order by claim.released_at desc limit 1
$$;
-- The run's wait is still running, however slow the machine is.
create function pg_temp.mf_hold(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp() + interval '1 minute' where run_id = p_run
$$;
-- The waits have passed.
create function pg_temp.mf_waits_over() returns void language sql as $$
	update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp() - interval '1 second'
	where status = 'queued'
$$;

-- The wake: the older job.
do $$
declare v_alice jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_send jsonb; v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_public_send(v_alice, 'progress');
	v_send := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000031', 'mf-ask-1', 'Could you check the note?');
	v_pass := pg_temp.base_materialize();
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert((select source_kind = 'wake' from public.qorpera_execution_runs where id = v_run),
		'Fixture: Alice''s message is a wake run: ' || v_pass::text);
	update public.qorpera_runner_jobs set created_at = created_at - interval '1 minute', queued_at = queued_at - interval '1 minute'
	where run_id = v_run;
	perform set_config('qorpera_test.mf_wake', v_run::text, true);
end $$;

savepoint wake_queued;

-- 1. With no member's run queued, the wake is claimed as before.
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(pg_temp.mf_claim() #>> '{work,run_id}' = current_setting('qorpera_test.mf_wake'),
	'The wake is claimed while no member is waiting');
rollback to savepoint wake_queued;

-- 2. The owner's post in Carol's thread: a newer job, claimed first.
do $$
declare v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032', 'Work');
	v_pass := pg_temp.base_materialize();
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert((select source_kind = 'room_delivery' from public.qorpera_execution_runs where id = v_run),
		'Fixture: the post is a room delivery: ' || v_pass::text);
	perform set_config('qorpera_test.mf_post', v_run::text, true);
end $$;
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mf_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.mf_post'),
	'The member''s newer run goes before the older wake: ' || current_setting('qorpera_test.mf_claim'));

-- A full fast host: the member's run comes back after 2 s, and nothing counts as a failure.
select pg_temp.base_assert((pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'SANDBOX_CAPACITY_EXHAUSTED') ->> 'deferred')::boolean,
	'A capacity refusal defers the member''s run');
select pg_temp.base_assert(pg_temp.mf_wait(current_setting('qorpera_test.mf_post')::uuid) = interval '2 seconds',
	'The member''s run waits 2 s: ' || pg_temp.mf_wait(current_setting('qorpera_test.mf_post')::uuid));
select pg_temp.base_assert((select dispatch_failure_count = 0 from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.mf_post')::uuid),
	'The refusal is not a dispatch failure');

-- While it waits the wake may go, and a wake's refusal keeps its 15 s.
select pg_temp.mf_hold(current_setting('qorpera_test.mf_post')::uuid);
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mf_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.mf_wake'),
	'The wake is claimed while the member''s run waits: ' || current_setting('qorpera_test.mf_claim'));
select pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'SANDBOX_CAPACITY_EXHAUSTED') \g /dev/null
select pg_temp.base_assert(pg_temp.mf_wait(current_setting('qorpera_test.mf_wake')::uuid) = interval '15 seconds',
	'A wake still waits 15 s: ' || pg_temp.mf_wait(current_setting('qorpera_test.mf_wake')::uuid));

-- A node's refusal of a fresh VM keeps its 15 s for a member's run too (a whole acquire, and the overflow's own window); so
-- does a node preference its 5 s.
select pg_temp.mf_waits_over();
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mf_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.mf_post'),
	'Once both waits are over the member''s run is first again');
select pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'NODE_CAPACITY_EXHAUSTED') \g /dev/null
select pg_temp.base_assert(pg_temp.mf_wait(current_setting('qorpera_test.mf_post')::uuid) = interval '15 seconds',
	'A full node keeps its 15 s for a member''s run: ' || pg_temp.mf_wait(current_setting('qorpera_test.mf_post')::uuid));
select pg_temp.mf_waits_over();
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'NODE_NOT_PREFERRED') \g /dev/null
select pg_temp.base_assert(pg_temp.mf_wait(current_setting('qorpera_test.mf_post')::uuid) = interval '5 seconds',
	'A node preference keeps its 5 s: ' || pg_temp.mf_wait(current_setting('qorpera_test.mf_post')::uuid));
rollback to savepoint wake_queued;

-- 3. The owner starts Carol's first run: a session turn whose only input is a kickoff. No member waits on it, so the older
-- wake goes first and the kickoff keeps 15 s.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_assert(public.qorpera_start_agent_first_run('92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000032') ->> 'state' = 'started', 'The owner starts Carol''s first run');
reset role;
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid := (v_pass -> 'run_ids' ->> 0)::uuid;
begin
	perform pg_temp.base_assert((select source_kind = 'session_turn' from public.qorpera_execution_runs where id = v_run)
		and (select bool_and(input.kind = 'kickoff') from public.qorpera_execution_runs run
			join public.qorpera_session_inputs input on input.id = any(run.input_ids) where run.id = v_run),
		'Fixture: the start is a session turn with only a kickoff: ' || v_pass::text);
	perform set_config('qorpera_test.mf_turn', v_run::text, true);
end $$;
savepoint kickoff_queued;
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mf_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.mf_wake'),
	'The older wake goes before a kickoff: ' || current_setting('qorpera_test.mf_claim'));
select pg_temp.mf_hold(current_setting('qorpera_test.mf_wake')::uuid);
select pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'SANDBOX_CAPACITY_EXHAUSTED') \g /dev/null
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mf_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.mf_turn'),
	'Then the kickoff: ' || current_setting('qorpera_test.mf_claim'));
select pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'SANDBOX_CAPACITY_EXHAUSTED') \g /dev/null
select pg_temp.base_assert(pg_temp.mf_wait(current_setting('qorpera_test.mf_turn')::uuid) = interval '15 seconds',
	'A kickoff waits 15 s: ' || pg_temp.mf_wait(current_setting('qorpera_test.mf_turn')::uuid));
rollback to savepoint kickoff_queued;

-- 4. The same turn with a member's message goes first, and a retiring host looks at it again after 2 s. (The fixture has
-- no path to such a turn on folder-v2, so the input is relabelled; the check reads only the kinds.)
set local session_replication_role = replica;
update public.qorpera_session_inputs set kind = 'user_message', actor_kind = 'human'
where id in (select unnest(input_ids) from public.qorpera_execution_runs where id = current_setting('qorpera_test.mf_turn')::uuid);
set local session_replication_role = origin;
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.mf_claim', pg_temp.mf_claim()::text, true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.mf_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.mf_turn'),
	'A turn with a member''s message goes before the older wake: ' || current_setting('qorpera_test.mf_claim'));
select pg_temp.mf_refuse(current_setting('qorpera_test.mf_claim')::jsonb, 'SANDBOX_RETIRING') \g /dev/null
select pg_temp.base_assert(pg_temp.mf_wait(current_setting('qorpera_test.mf_turn')::uuid) = interval '2 seconds',
	'A retiring host looks at the member''s turn again after 2 s: ' || pg_temp.mf_wait(current_setting('qorpera_test.mf_turn')::uuid));

rollback;
