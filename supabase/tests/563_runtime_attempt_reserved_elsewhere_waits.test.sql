-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A release by an orchestrator whose provider cannot serve the attempt, because another provider holds the attempt's
-- machine reservation, defers that orchestrator instead of counting (20260930563000). Production, 2026-11-04 (run
-- dfa2fd28): node 1's provider reserved the attempt's machine and was refused by its node (NODE_CAPACITY_EXHAUSTED);
-- the shared execution host's acquires of the same attempt then failed with a plain 422, each counted, until the run
-- failed after eight.
-- Nodes as in 598: node A (fast host ...092, adapter 'process', holds the fixture run) and node B (fast host ...b1,
-- adapter 'native-b'), and node C (fast host ...c1, adapter 'native-c'). Node A's provider holds the reservation;
-- nodes B and C cannot serve the attempt.
select pg_temp.base_claims('service_role');
reset role;
create function pg_temp.re_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.re_release(p_orchestrator uuid,p_claim jsonb,p_error text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim(p_orchestrator,(p_claim ->> 'claim_id')::uuid,extensions.gen_random_uuid(),p_error)
$$;
create function pg_temp.re_run(p_text text) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000031',p_text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,'The post is a run: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
-- Every wait over: the job may be claimed by whoever asks.
create function pg_temp.re_ready(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
		dispatch_deferred_until = null, dispatch_refused_by = null
	where run_id = p_run
$$;
create function pg_temp.re_policy(p_node uuid,p_machine text,p_label text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true)
$$;
create function pg_temp.re_job() returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job where job.run_id = current_setting('qorpera_test.re_run')::uuid
$$;
-- One claim by p_orchestrator for attempt 1, released with a plain provider failure; the release's answer.
create function pg_temp.re_fail(p_orchestrator uuid) returns jsonb language plpgsql as $$
declare v_claim jsonb;
begin
	reset role;
	perform pg_temp.re_ready(current_setting('qorpera_test.re_run')::uuid);
	set local role service_role;
	v_claim := pg_temp.re_claim(p_orchestrator);
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = current_setting('qorpera_test.re_run')
		and v_claim #>> '{work,attempt}' = '1','The claim is attempt 1: ' || coalesce(v_claim::text, 'none'));
	return pg_temp.re_release(p_orchestrator,v_claim,'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]');
end $$;
-- The run's job as p_orchestrator's next claim, without ending any wait: whether it may claim it now.
create function pg_temp.re_claims_run(p_orchestrator uuid) returns boolean language plpgsql as $$
declare v_claim jsonb;
begin
	reset role;
	set local role service_role;
	v_claim := pg_temp.re_claim(p_orchestrator);
	reset role;
	return coalesce(v_claim #>> '{work,run_id}', '') = current_setting('qorpera_test.re_run');
end $$;
-- One claim by p_orchestrator for attempt 1, without ending any wait, released with a plain provider failure.
create function pg_temp.re_fail_now(p_orchestrator uuid) returns jsonb language plpgsql as $$
declare v_claim jsonb;
begin
	reset role;
	set local role service_role;
	v_claim := pg_temp.re_claim(p_orchestrator);
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = current_setting('qorpera_test.re_run')
		and v_claim #>> '{work,attempt}' = '1','The claim is attempt 1: ' || coalesce(v_claim::text, 'none'));
	v_claim := pg_temp.re_release(p_orchestrator,v_claim,'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]');
	reset role;
	return v_claim;
end $$;
create function pg_temp.re_deferrals() returns bigint language sql as $$
	select count(*) from public.qorpera_execution_run_events
	where run_id = current_setting('qorpera_test.re_run')::uuid and event_type = 'placement_deferred'
		and payload ->> 'reason' = 'ATTEMPT_RESERVED_ELSEWHERE'
$$;

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.re_policy('56300000-0000-4000-8000-00000000000a',repeat('a',64),'node-a'),0) \g /dev/null
select public.qorpera_configure_runtime_node(pg_temp.re_policy('56300000-0000-4000-8000-00000000000b',repeat('b',64),'node-b'),0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('56300000-0000-4000-8000-00000000000a',repeat('a',64),'native','process',repeat('1',64),4000,8589934592) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('56300000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592) \g /dev/null
select public.qorpera_register_runner_orchestrator('56300000-0000-4000-8000-0000000000b1','Node B fast host','native-b',repeat('4',64),3600) \g /dev/null
select public.qorpera_configure_runtime_node(pg_temp.re_policy('56300000-0000-4000-8000-00000000000c',repeat('c',64),'node-c'),0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('56300000-0000-4000-8000-00000000000c',repeat('c',64),'native','native-c',repeat('3',64),4000,8589934592) \g /dev/null
select public.qorpera_register_runner_orchestrator('56300000-0000-4000-8000-0000000000c1','Node C fast host','native-c',repeat('5',64),3600) \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('56300000-0000-4000-8000-0000000000c1','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('56300000-0000-4000-8000-0000000000b1','fast') \g /dev/null
reset role;
select set_config('qorpera_test.re_run',pg_temp.re_run('Work')::text,true);
select set_config('qorpera_test.re_job',(pg_temp.re_job()).id::text,true);
select set_config('qorpera_test.re_first',public.qorpera_run_attempt_acquisition_id(current_setting('qorpera_test.re_run')::uuid,1)::text,true);

-- 1. Node A's provider provisions attempt 1's runner and reserves its machine, then its node refuses it: the release
-- is a typed refusal and is deferred, as before. The runner stays pending and the reservation stays.
select pg_temp.re_ready(current_setting('qorpera_test.re_run')::uuid);
set local role service_role;
select set_config('qorpera_test.re_claim',pg_temp.re_claim('92400000-0000-4000-8000-000000000092')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.re_claim')::jsonb #>> '{work,attempt}' = '1','Node A''s fast host claims attempt 1');
select set_config('qorpera_test.re_runner',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.re_run')::uuid,
	current_setting('qorpera_test.re_first')::uuid,'process',repeat('1',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert(public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.re_first')::uuid,'process',repeat('7',64),
	current_setting('qorpera_test.re_run')::uuid,current_setting('qorpera_test.re_runner')::uuid) ->> 'state' = 'reserved',
	'Attempt 1''s machine is reserved by node A''s provider');
select pg_temp.base_assert((pg_temp.re_release('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.re_claim')::jsonb,
	'ADMISSION_REFUSED:NODE_CAPACITY_EXHAUSTED') ->> 'deferred')::boolean,'Node A''s capacity refusal is deferred');
reset role;
select pg_temp.base_assert((pg_temp.re_job()).dispatch_failure_count = 0 and (pg_temp.re_job()).attempt_count = 0
	and (select status = 'pending' from public.qorpera_runners where id = current_setting('qorpera_test.re_runner')::uuid)
	and (select released_at is null and provider_adapter = 'process' from public.qorpera_runtime_machine_allocations
		where id = current_setting('qorpera_test.re_first')::uuid),
	'Nothing is counted; the pending runner keeps node A''s reservation');

-- 2. The fix: node B's provider cannot provision the attempt (its runner is bound to node A's reservation) and its
-- release is deferred for node B only, counting nothing.
select set_config('qorpera_test.re_result',pg_temp.re_fail('56300000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
reset role;
select pg_temp.base_assert((current_setting('qorpera_test.re_result')::jsonb ->> 'deferred')::boolean
	and not (current_setting('qorpera_test.re_result')::jsonb ->> 'terminal')::boolean
	and (current_setting('qorpera_test.re_result')::jsonb ->> 'dispatch_failure_count')::integer = 0,
	'Node B''s failure is a deferral: ' || current_setting('qorpera_test.re_result'));
select pg_temp.base_assert((pg_temp.re_job()).status = 'queued' and (pg_temp.re_job()).dispatch_failure_count = 0
	and (pg_temp.re_job()).attempt_count = 0
	and (pg_temp.re_job()).dispatch_refused_by = '56300000-0000-4000-8000-0000000000b1'
	and (pg_temp.re_job()).dispatch_deferred_until > statement_timestamp()
	and (pg_temp.re_job()).last_error = 'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]',
	'The job waits, refused by node B only, with nothing counted');
select pg_temp.base_assert((select count(*) = 1 from public.qorpera_execution_run_events
	where run_id = current_setting('qorpera_test.re_run')::uuid and event_type = 'placement_deferred'
		and payload ->> 'reason' = 'ATTEMPT_RESERVED_ELSEWHERE' and payload ->> 'reserved_by' = 'process'
		and payload ->> 'refused_by' = '56300000-0000-4000-8000-0000000000b1'
		and payload ->> 'error' = 'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]'
		and (payload ->> 'dispatch_failure_count')::integer = 0),
	'The deferral is recorded with its reason, the holder and the provider''s failure');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_execution_run_events
	where run_id = current_setting('qorpera_test.re_run')::uuid and event_type = 'infrastructure_retry'),
	'No infrastructure retry is recorded');
select pg_temp.base_assert((select status = 'pending' from public.qorpera_runners where id = current_setting('qorpera_test.re_runner')::uuid),
	'The holder''s runner is left alone');

-- 2b. While node B waits it cannot claim the job; the holder can.
savepoint waits;
select pg_temp.base_assert(not pg_temp.re_claims_run('56300000-0000-4000-8000-0000000000b1'),'Node B cannot claim the job while it waits');
select pg_temp.base_assert(pg_temp.re_claims_run('92400000-0000-4000-8000-000000000092'),'Node A, the holder, claims the job at once');
rollback to savepoint waits;

-- 2c. Two non-holders never hand the job back and forth: node C claims while node B waits, fails the same way, and
-- then every orchestrator waits (as a node-local typed refusal does, 20260928180700).
savepoint two;
select set_config('qorpera_test.re_result',pg_temp.re_fail_now('56300000-0000-4000-8000-0000000000c1')::text,true) \g /dev/null
select pg_temp.base_assert((current_setting('qorpera_test.re_result')::jsonb ->> 'deferred')::boolean
	and (pg_temp.re_job()).dispatch_failure_count = 0 and (pg_temp.re_job()).dispatch_refused_by is null
	and (pg_temp.re_job()).dispatch_deferred_until > statement_timestamp() and pg_temp.re_deferrals() = 2,
	'Node C''s failure is deferred too, and now every orchestrator waits: ' || current_setting('qorpera_test.re_result'));
select pg_temp.base_assert(not pg_temp.re_claims_run('56300000-0000-4000-8000-0000000000b1')
	and not pg_temp.re_claims_run('56300000-0000-4000-8000-0000000000c1')
	and not pg_temp.re_claims_run('92400000-0000-4000-8000-000000000092'),'No orchestrator claims the job until the wait ends');
rollback to savepoint two;

-- 2d. The bound: a reservation older than 15 minutes (its holder may be gone and never release it) is counted again.
savepoint old;
update public.qorpera_runtime_machine_allocations set reserved_at = clock_timestamp() - interval '16 minutes'
where id = current_setting('qorpera_test.re_first')::uuid;
select set_config('qorpera_test.re_result',pg_temp.re_fail('56300000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
reset role;
select pg_temp.base_assert(not coalesce((current_setting('qorpera_test.re_result')::jsonb ->> 'deferred')::boolean,false)
	and (current_setting('qorpera_test.re_result')::jsonb ->> 'dispatch_failure_count')::integer = 1
	and (pg_temp.re_job()).dispatch_failure_count = 1 and pg_temp.re_deferrals() = 1,
	'A failure against a reservation older than 15 minutes is counted: ' || current_setting('qorpera_test.re_result'));
rollback to savepoint old;

-- 3. Eight such releases still fail nothing.
do $$ begin
	for i in 1..8 loop perform pg_temp.re_fail('56300000-0000-4000-8000-0000000000b1'); end loop;
end $$;
reset role;
select pg_temp.base_assert((pg_temp.re_job()).status = 'queued' and (pg_temp.re_job()).dispatch_failure_count = 0
	and pg_temp.re_deferrals() = 9,'Nine deferrals later the job is still queued with nothing counted');

-- 4. Counted as before: a release by the holder's own adapter.
savepoint holder;
select set_config('qorpera_test.re_result',pg_temp.re_fail('92400000-0000-4000-8000-000000000092')::text,true) \g /dev/null
reset role;
select pg_temp.base_assert(not coalesce((current_setting('qorpera_test.re_result')::jsonb ->> 'deferred')::boolean,false)
	and (current_setting('qorpera_test.re_result')::jsonb ->> 'dispatch_failure_count')::integer = 1
	and not (current_setting('qorpera_test.re_result')::jsonb ->> 'attempt_abandoned')::boolean
	and (pg_temp.re_job()).dispatch_failure_count = 1 and pg_temp.re_deferrals() = 9,
	'The holder''s own failure is counted: ' || current_setting('qorpera_test.re_result'));
rollback to savepoint holder;

-- 5. Counted as before: the runner is no longer pending (it activated on node A's machine).
savepoint active;
set local role service_role;
select public.qorpera_activate_runner(current_setting('qorpera_test.re_runner')::uuid,repeat('1',64),repeat('2',64),'linux','re-fixture') \g /dev/null
reset role;
select set_config('qorpera_test.re_result',pg_temp.re_fail('56300000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
reset role;
select pg_temp.base_assert(not coalesce((current_setting('qorpera_test.re_result')::jsonb ->> 'deferred')::boolean,false)
	and (pg_temp.re_job()).dispatch_failure_count = 1 and pg_temp.re_deferrals() = 9,
	'A failure while the runner is active is counted: ' || current_setting('qorpera_test.re_result'));
rollback to savepoint active;

-- 6. Counted as before: node A's provider released the reservation. The failure moves the job to attempt 2
-- (20260928249240), which any node can take.
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = current_setting('qorpera_test.re_first')::uuid;
select set_config('qorpera_test.re_result',pg_temp.re_fail('56300000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
reset role;
select pg_temp.base_assert(not coalesce((current_setting('qorpera_test.re_result')::jsonb ->> 'deferred')::boolean,false)
	and (current_setting('qorpera_test.re_result')::jsonb ->> 'attempt_abandoned')::boolean
	and not (current_setting('qorpera_test.re_result')::jsonb ->> 'terminal')::boolean,
	'With the reservation released the failure is counted and abandons the attempt: ' || current_setting('qorpera_test.re_result'));
select pg_temp.base_assert((pg_temp.re_job()).status = 'queued' and (pg_temp.re_job()).dispatch_failure_count = 1
	and (pg_temp.re_job()).attempt_count = 1 and pg_temp.re_deferrals() = 9
	and (select status = 'revoked' from public.qorpera_runners where id = current_setting('qorpera_test.re_runner')::uuid),
	'The job moves to attempt 2 and the old runner is revoked');
rollback;
