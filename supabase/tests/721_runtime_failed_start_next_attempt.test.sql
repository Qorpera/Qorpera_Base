-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A run's attempt whose machine failed to start moves on (20260928249240), on a folder-v2 company
-- (ported from snapshot-v1 in the legacy sweep). Production, 2026-09-29: node 1 reserved a machine for a vault run's
-- attempt, the start failed, and every retry asked for the same runner until the run failed. Now the claim release
-- revokes a reserved, never activated runner whose machine was released, raises the attempt, and the placement ranks
-- the failed node last.
-- Nodes as in 643: node A (fast host ...092, adapter 'process', busier: it holds the fixture run, Alice's) and
-- node B (fast host ...b1, adapter 'native-b'). The run is the owner's post in Bob's thread, turned into a run by the
-- folder materializer.
select pg_temp.base_claims('service_role');
reset role;
create function pg_temp.fa_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.fa_release(p_orchestrator uuid,p_claim jsonb,p_error text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim(p_orchestrator,(p_claim ->> 'claim_id')::uuid,extensions.gen_random_uuid(),p_error)
$$;
-- The owner's post in Bob's thread, and the materializer pass that makes it a queued run. Call it with the role reset.
create function pg_temp.fa_run(p_text text) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000031',p_text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,'The post is a run: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
create function pg_temp.fa_placement(p_run uuid) returns jsonb language sql as $$
	select public.qorpera_runtime_run_placement(job,run) from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.id = job.run_id where run.id = p_run
$$;
-- Every wait over: the job may be claimed by whoever asks (head starts and deferrals are 643's subject).
create function pg_temp.fa_ready(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
		dispatch_deferred_until = null, dispatch_refused_by = null
	where run_id = p_run
$$;
create function pg_temp.fa_policy(p_node uuid,p_machine text,p_label text,p_enabled boolean default true) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',p_enabled)
$$;
create function pg_temp.fa_acquisition(p_run uuid,p_attempt integer) returns uuid language sql as $$
	select public.qorpera_run_attempt_acquisition_id(p_run,p_attempt)
$$;
grant execute on function pg_temp.fa_acquisition(uuid,integer) to service_role;

-- The SQL twin of runAttemptAcquisitionId gives the providers' ids (computed by provider-shared.ts).
select pg_temp.base_assert(pg_temp.fa_acquisition('b3e04bac-a25a-4224-886f-4c658a6e77e5',1) = 'b3e04bac-a25a-4224-886f-4c658a6e77e5'
	and pg_temp.fa_acquisition('b3e04bac-a25a-4224-886f-4c658a6e77e5',2) = 'ba9d61db-0032-8137-adac-446933e77a51'
	and pg_temp.fa_acquisition('b3e04bac-a25a-4224-886f-4c658a6e77e5',3) = 'e9fdb7a2-2e27-81b2-b762-b37856a920a7'
	and pg_temp.fa_acquisition('8ee00db9-d019-460a-bb83-a9c8c5dbd5d8',2) = '2bcd9570-5554-8a23-b0cb-2516e31fd4c3',
	'The acquisition ids match the providers''');
select pg_temp.base_assert(not has_function_privilege(role_name,'public.qorpera_run_attempt_acquisition_id(uuid,integer)','EXECUTE')
	and not has_table_privilege(role_name,'public.qorpera_runtime_run_start_failures','SELECT,INSERT,UPDATE,DELETE'),
	'Internal for ' || role_name) from unnest(array['anon','authenticated','service_role']) role_name;

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.fa_policy('72100000-0000-4000-8000-00000000000a',repeat('a',64),'node-a'),0) \g /dev/null
select public.qorpera_configure_runtime_node(pg_temp.fa_policy('72100000-0000-4000-8000-00000000000b',repeat('b',64),'node-b'),0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('72100000-0000-4000-8000-00000000000a',repeat('a',64),'native','process',repeat('1',64),4000,8589934592) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('72100000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592) \g /dev/null
select public.qorpera_register_runner_orchestrator('72100000-0000-4000-8000-0000000000b1','Node B fast host','native-b',repeat('4',64),3600) \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('72100000-0000-4000-8000-0000000000b1','fast') \g /dev/null
reset role;
select set_config('qorpera_test.fa_run',pg_temp.fa_run('Work')::text,true);
select set_config('qorpera_test.fa_first',pg_temp.fa_acquisition(current_setting('qorpera_test.fa_run')::uuid,1)::text,true);
select set_config('qorpera_test.fa_second',pg_temp.fa_acquisition(current_setting('qorpera_test.fa_run')::uuid,2)::text,true);
select pg_temp.base_assert(pg_temp.fa_placement(current_setting('qorpera_test.fa_run')::uuid) ->> 'nodeId' = '72100000-0000-4000-8000-00000000000b',
	'Node B is the least busy: the first attempt goes there');

-- Attempt 1 on node B: the fast host provisions the attempt's runner and reserves its machine.
select pg_temp.fa_ready(current_setting('qorpera_test.fa_run')::uuid);
set local role service_role;
select set_config('qorpera_test.fa_claim',pg_temp.fa_claim('72100000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.fa_claim')::jsonb #>> '{work,attempt}' = '1','The first claim is attempt 1');
select set_config('qorpera_test.fa_runner1',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.fa_run')::uuid,
	current_setting('qorpera_test.fa_first')::uuid,'native-b',repeat('1',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert(public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.fa_first')::uuid,'native-b',repeat('7',64),
	current_setting('qorpera_test.fa_run')::uuid,current_setting('qorpera_test.fa_runner1')::uuid) ->> 'state' = 'reserved',
	'Attempt 1''s machine is reserved on node B');

-- 1. A refusal never moves the attempt and never revokes, even with a reserved machine.
select pg_temp.fa_release('72100000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fa_claim')::jsonb,'ADMISSION_REFUSED:SANDBOX_CAPACITY_EXHAUSTED') \g /dev/null
reset role;
select pg_temp.base_assert((select job.attempt_count = 0 and runner.status = 'pending'
	from public.qorpera_runner_jobs job, public.qorpera_runners runner
	where job.run_id = current_setting('qorpera_test.fa_run')::uuid and runner.id = current_setting('qorpera_test.fa_runner1')::uuid),
	'A refusal leaves the attempt and its runner alone');

-- 2a. A start that failed while its machine is still reserved (the provider has not released it yet):
-- counted as an infrastructure failure only, the runner stays with its machine.
select pg_temp.fa_ready(current_setting('qorpera_test.fa_run')::uuid);
set local role service_role;
select set_config('qorpera_test.fa_claim',pg_temp.fa_claim('72100000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert((pg_temp.fa_release('72100000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fa_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'attempt_abandoned')::boolean = false,
	'A failure while the machine is still reserved does not abandon the attempt');
reset role;
select pg_temp.base_assert((select job.attempt_count = 0 and job.dispatch_failure_count = 1 and runner.status = 'pending'
		and job.dispatch_refused_by is null and job.dispatch_deferred_until > statement_timestamp() + interval '10 seconds'
	from public.qorpera_runner_jobs job, public.qorpera_runners runner
	where job.run_id = current_setting('qorpera_test.fa_run')::uuid and runner.id = current_setting('qorpera_test.fa_runner1')::uuid),
	'The machine may still exist: everyone waits for its provider, and the attempt stays');

-- 2b. The provider released the machine (its start failed).
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = current_setting('qorpera_test.fa_first')::uuid;
-- A refusal still never moves the attempt, even now.
select pg_temp.fa_ready(current_setting('qorpera_test.fa_run')::uuid);
set local role service_role;
select set_config('qorpera_test.fa_claim',pg_temp.fa_claim('72100000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.fa_release('72100000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fa_claim')::jsonb,'ADMISSION_REFUSED:NODE_NOT_PREFERRED') \g /dev/null
reset role;
select pg_temp.base_assert((select job.attempt_count = 0 and runner.status = 'pending'
	from public.qorpera_runner_jobs job, public.qorpera_runners runner
	where job.run_id = current_setting('qorpera_test.fa_run')::uuid and runner.id = current_setting('qorpera_test.fa_runner1')::uuid),
	'A refusal after the release leaves the attempt and its runner alone');
-- A runner that activated and never accepted is revoked too, with its session (20260930535000, test 598).
savepoint activated;
update public.qorpera_runners set status = 'active', activated_at = clock_timestamp(), session_token_sha256 = repeat('6',64),
	session_expires_at = clock_timestamp() + interval '1 hour'
where id = current_setting('qorpera_test.fa_runner1')::uuid;
select pg_temp.fa_ready(current_setting('qorpera_test.fa_run')::uuid);
set local role service_role;
select set_config('qorpera_test.fa_claim',pg_temp.fa_claim('72100000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert((pg_temp.fa_release('72100000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fa_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'attempt_abandoned')::boolean,
	'An activated runner''s attempt that never started is abandoned');
reset role;
select pg_temp.base_assert((select status = 'revoked' and session_token_sha256 is null
	from public.qorpera_runners where id = current_setting('qorpera_test.fa_runner1')::uuid),
	'The activated runner is revoked and loses its session');
rollback to savepoint activated;
-- The next infrastructure failure abandons the attempt.
select pg_temp.fa_ready(current_setting('qorpera_test.fa_run')::uuid);
set local role service_role;
select set_config('qorpera_test.fa_claim',pg_temp.fa_claim('72100000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.fa_claim')::jsonb #>> '{work,attempt}' = '1','Still attempt 1');
select pg_temp.base_assert((pg_temp.fa_release('72100000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.fa_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'attempt_abandoned')::boolean,
	'A failed start after the machine was released abandons the attempt');
reset role;
select pg_temp.base_assert((select job.attempt_count = 1 and job.dispatch_failure_count = 2 and job.status = 'queued'
		and job.queued_at >= statement_timestamp() - interval '1 second'
		and runner.status = 'revoked' and runner.revoked_by_user_id = runner.registered_by_user_id
	from public.qorpera_runner_jobs job, public.qorpera_runners runner
	where job.run_id = current_setting('qorpera_test.fa_run')::uuid and runner.id = current_setting('qorpera_test.fa_runner1')::uuid),
	'The runner is revoked and the job moves to attempt 2');
select pg_temp.base_assert((select attempt = 1 and allocation_id = current_setting('qorpera_test.fa_first')::uuid
		and node_id = '72100000-0000-4000-8000-00000000000b'
	from public.qorpera_runtime_run_start_failures where run_id = current_setting('qorpera_test.fa_run')::uuid),
	'The failed node is recorded for the run');
select pg_temp.base_assert((select payload ->> 'attempt_abandoned' = '1' and payload ->> 'start_failed_node_id' = '72100000-0000-4000-8000-00000000000b'
	from public.qorpera_execution_run_events where run_id = current_setting('qorpera_test.fa_run')::uuid and event_type = 'infrastructure_retry'
	order by created_at desc, id desc limit 1),'The retry event names the abandoned attempt and its node');
select pg_temp.base_assert((select count(*) = 1 from public.qorpera_runner_audit_receipts
	where runner_id = current_setting('qorpera_test.fa_runner1')::uuid and event_type = 'runner_revoked'
		and payload ->> 'reason' = 'attempt_start_failed' and payload ->> 'attempt' = '1'),'The revocation has its receipt');
-- A late activation of the revoked runner is refused (activation needs a pending runner).
select pg_temp.base_assert((select status from public.qorpera_runners where id = current_setting('qorpera_test.fa_runner1')::uuid) = 'revoked',
	'Nothing can activate it');

-- 4. The failed node ranks last: node B is still the least busy, node A is chosen.
select pg_temp.base_assert(pg_temp.fa_placement(current_setting('qorpera_test.fa_run')::uuid) ->> 'nodeId' = '72100000-0000-4000-8000-00000000000a'
	and pg_temp.fa_placement(current_setting('qorpera_test.fa_run')::uuid) ->> 'reason' = 'LEAST_BUSY',
	'Attempt 2 goes to node A: ' || pg_temp.fa_placement(current_setting('qorpera_test.fa_run')::uuid)::text);
-- It is a ranking, not a ban: with node A disabled, node B still takes the run.
savepoint only_b;
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.fa_policy('72100000-0000-4000-8000-00000000000a',repeat('a',64),'node-a',false),1) \g /dev/null
reset role;
select pg_temp.base_assert(pg_temp.fa_placement(current_setting('qorpera_test.fa_run')::uuid) ->> 'nodeId' = '72100000-0000-4000-8000-00000000000b',
	'The failed node still takes the run when it is the only one');
rollback to savepoint only_b;

-- 3 and 6. Attempt 2 through the claim turn on node A: a new runner, a new allocation and a new placement row.
-- The attempt was queued again, so the head start is node A's: the failed node's fast host gets no turn. The wait
-- after the failure (20260930537000) is over, and the job is queued again from its end.
update public.qorpera_runner_jobs set dispatch_deferred_until = statement_timestamp(), queued_at = statement_timestamp()
where run_id = current_setting('qorpera_test.fa_run')::uuid;
set local role service_role;
select pg_temp.base_assert(pg_temp.fa_claim('72100000-0000-4000-8000-0000000000b1') = 'null'::jsonb,
	'The failed node''s fast host leaves attempt 2 to node A during the head start');
select set_config('qorpera_test.fa_claim',pg_temp.fa_claim('92400000-0000-4000-8000-000000000092')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.fa_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.fa_run')
	and current_setting('qorpera_test.fa_claim')::jsonb #>> '{work,attempt}' = '2','Node A''s fast host claims attempt 2');
-- A pending runner with no machine (the provider's refusal path) is left to the rebind of 20260928235000.
savepoint unreserved;
select set_config('qorpera_test.fa_runner2',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.fa_run')::uuid,
	current_setting('qorpera_test.fa_second')::uuid,'process',repeat('2',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert((pg_temp.fa_release('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.fa_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'attempt_abandoned')::boolean = false,
	'A runner without a reserved machine is not abandoned');
reset role;
select pg_temp.base_assert((select status = 'pending' from public.qorpera_runners where id = current_setting('qorpera_test.fa_runner2')::uuid),
	'It stays pending for the rebind');
set local role service_role;
rollback to savepoint unreserved;
select set_config('qorpera_test.fa_runner2',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.fa_run')::uuid,
	current_setting('qorpera_test.fa_second')::uuid,'process',repeat('2',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.fa_runner2') <> current_setting('qorpera_test.fa_runner1'),'Attempt 2 has its own runner');
select pg_temp.base_assert(public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.fa_second')::uuid,'process',repeat('8',64),
	current_setting('qorpera_test.fa_run')::uuid,current_setting('qorpera_test.fa_runner2')::uuid) ->> 'state' = 'reserved',
	'Attempt 2''s machine is reserved');
reset role;
select pg_temp.base_assert((select count(*) = 2 and bool_and(attempts = 1)
		and count(*) filter (where allocation_id = current_setting('qorpera_test.fa_first')::uuid and node_id = '72100000-0000-4000-8000-00000000000b') = 1
		and count(*) filter (where allocation_id = current_setting('qorpera_test.fa_second')::uuid and node_id = '72100000-0000-4000-8000-00000000000a'
			and reason like 'CLAIM_TURN%') = 1
	from public.qorpera_runtime_node_placements
	where allocation_id in (current_setting('qorpera_test.fa_first')::uuid, current_setting('qorpera_test.fa_second')::uuid)),
	'Each attempt has its own placement row; the first is not overwritten');

-- The attempt budget: an abandoned last attempt fails the job at once instead of leaving it unclaimable.
savepoint cap;
update public.qorpera_runner_jobs set attempt_count = 7 where run_id = current_setting('qorpera_test.fa_run')::uuid;
select set_config('qorpera_test.fa_eighth',pg_temp.fa_acquisition(current_setting('qorpera_test.fa_run')::uuid,8)::text,true);
set local role service_role;
select set_config('qorpera_test.fa_runner8',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.fa_run')::uuid,
	current_setting('qorpera_test.fa_eighth')::uuid,'process',repeat('3',64)) ->> 'runner_id'),true) \g /dev/null
reset role;
insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,runner_id,provider_adapter,instance_sha256,released_at)
select current_setting('qorpera_test.fa_eighth')::uuid, runner.profile_id, current_setting('qorpera_test.fa_run')::uuid, runner.id,
	'process', repeat('9',64), clock_timestamp()
from public.qorpera_runners runner where runner.id = current_setting('qorpera_test.fa_runner8')::uuid;
set local role service_role;
select pg_temp.base_assert((pg_temp.fa_release('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.fa_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'terminal')::boolean,'The eighth attempt''s failed start is final');
reset role;
select pg_temp.base_assert((select status = 'failed' and attempt_count = 8 and last_error like 'Runner failed to start on its final attempt:%'
	from public.qorpera_runner_jobs where run_id = current_setting('qorpera_test.fa_run')::uuid),'The job fails with the reason');
rollback to savepoint cap;
rollback;
