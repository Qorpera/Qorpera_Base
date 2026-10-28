-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- An attempt whose runner activated but never started, and whose machine was released, moves on (20260930535000,
-- WB-002 F2). Production, 2026-10-28: node B's machine came up, its runner activated and was offered the assignment,
-- it never accepted, node inventory released the machine and the claim expired. Every retry was the same attempt, so
-- the providers asked for the same active runner and failed, until the run failed after eight. Now the claim release
-- revokes that runner (with its sessions) and moves the job to its next attempt, which gets a new runner.
-- Nodes as in 721: node A (fast host ...092, adapter 'process', holds the fixture run) and node B (fast host ...b1,
-- adapter 'native-b'). The run is the owner's post in Bob's thread, turned into a run by the folder materializer.
select pg_temp.base_claims('service_role');
reset role;
create function pg_temp.un_claim(p_orchestrator uuid) returns jsonb language sql as $$
	select public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator,extensions.gen_random_uuid(),120)
$$;
create function pg_temp.un_release(p_orchestrator uuid,p_claim jsonb,p_error text) returns jsonb language sql as $$
	select public.qorpera_release_runner_job_claim(p_orchestrator,(p_claim ->> 'claim_id')::uuid,extensions.gen_random_uuid(),p_error)
$$;
create function pg_temp.un_run(p_text text) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000031',p_text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,'The post is a run: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
-- Every wait over: the job may be claimed by whoever asks.
create function pg_temp.un_ready(p_run uuid) returns void language sql as $$
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
		dispatch_deferred_until = null, dispatch_refused_by = null
	where run_id = p_run
$$;
create function pg_temp.un_policy(p_node uuid,p_machine text,p_label text) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId',p_node,'machineIdSha256',p_machine,
		'label',p_label,'cpuMillis',32000,'memoryBytes',68719476736,'headroomCpuMillis',8000,'headroomMemoryBytes',17179869184,
		'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true)
$$;
create function pg_temp.un_job() returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job where job.run_id = current_setting('qorpera_test.un_run')::uuid
$$;
create function pg_temp.un_runner(p_setting text) returns public.qorpera_runners language sql as $$
	select runner.* from public.qorpera_runners runner where runner.id = current_setting(p_setting)::uuid
$$;

select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_configure_runtime_node(pg_temp.un_policy('59800000-0000-4000-8000-00000000000a',repeat('a',64),'node-a'),0) \g /dev/null
select public.qorpera_configure_runtime_node(pg_temp.un_policy('59800000-0000-4000-8000-00000000000b',repeat('b',64),'node-b'),0) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('59800000-0000-4000-8000-00000000000a',repeat('a',64),'native','process',repeat('1',64),4000,8589934592) \g /dev/null
select public.qorpera_enroll_runtime_node_provider('59800000-0000-4000-8000-00000000000b',repeat('b',64),'native','native-b',repeat('2',64),4000,8589934592) \g /dev/null
select public.qorpera_register_runner_orchestrator('59800000-0000-4000-8000-0000000000b1','Node B fast host','native-b',repeat('4',64),3600) \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('92400000-0000-4000-8000-000000000092','fast') \g /dev/null
select public.qorpera_set_runner_orchestrator_dispatch_role('59800000-0000-4000-8000-0000000000b1','fast') \g /dev/null
reset role;
select set_config('qorpera_test.un_run',pg_temp.un_run('Work')::text,true);
select set_config('qorpera_test.un_job',(pg_temp.un_job()).id::text,true);
select set_config('qorpera_test.un_first',public.qorpera_run_attempt_acquisition_id(current_setting('qorpera_test.un_run')::uuid,1)::text,true);
select set_config('qorpera_test.un_second',public.qorpera_run_attempt_acquisition_id(current_setting('qorpera_test.un_run')::uuid,2)::text,true);
select set_config('qorpera_test.un_eighth',public.qorpera_run_attempt_acquisition_id(current_setting('qorpera_test.un_run')::uuid,8)::text,true);

-- 1. WB-002 up to the retries: attempt 1 on node B gets its runner and machine, the runner activates and is offered
-- the assignment, it never accepts, and the reconcile lets the offer and the claim expire (which moves nothing).
select pg_temp.un_ready(current_setting('qorpera_test.un_run')::uuid);
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('59800000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.un_claim')::jsonb #>> '{work,attempt}' = '1'
	and current_setting('qorpera_test.un_claim')::jsonb #>> '{work,job_id}' = current_setting('qorpera_test.un_job'),
	'Node B''s fast host claims attempt 1');
select set_config('qorpera_test.un_runner1',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.un_run')::uuid,
	current_setting('qorpera_test.un_first')::uuid,'native-b',repeat('1',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert(public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.un_first')::uuid,'native-b',repeat('7',64),
	current_setting('qorpera_test.un_run')::uuid,current_setting('qorpera_test.un_runner1')::uuid) ->> 'state' = 'reserved',
	'Attempt 1''s machine is reserved on node B');
select public.qorpera_activate_runner(current_setting('qorpera_test.un_runner1')::uuid,repeat('1',64),repeat('2',64),'linux','wb002-fixture') \g /dev/null
select set_config('qorpera_test.un_assignment1',public.qorpera_assign_runner_job('59800000-0000-4000-8000-0000000000b1',
	(current_setting('qorpera_test.un_claim')::jsonb ->> 'claim_id')::uuid,current_setting('qorpera_test.un_runner1')::uuid,
	extensions.gen_random_uuid(),repeat('3',64),120) ->> 'assignment_id',true) \g /dev/null
reset role;
update public.qorpera_runner_assignments set expires_at = clock_timestamp() - interval '1 minute'
where id = current_setting('qorpera_test.un_assignment1')::uuid;
update public.qorpera_runner_job_claims set lease_expires_at = clock_timestamp() - interval '1 minute'
where id = (current_setting('qorpera_test.un_claim')::jsonb ->> 'claim_id')::uuid;
set local role service_role;
select public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092') \g /dev/null
reset role;
select pg_temp.base_assert((select claim.status = 'released' and claim.release_reason = 'Orchestrator claim expired before runner acceptance'
		and assignment.status = 'expired' and assignment.accepted_at is null
		and (pg_temp.un_job()).attempt_count = 0 and (pg_temp.un_job()).dispatch_failure_count = 0
		and (pg_temp.un_job()).status = 'queued' and (pg_temp.un_runner('qorpera_test.un_runner1')).status = 'active'
	from public.qorpera_runner_job_claims claim, public.qorpera_runner_assignments assignment
	where claim.id = (current_setting('qorpera_test.un_claim')::jsonb ->> 'claim_id')::uuid
		and assignment.id = current_setting('qorpera_test.un_assignment1')::uuid),
	'The expired claim moves nothing: the job waits for attempt 1 again, its runner is active');

-- 2. While the machine is still allocated, a failed start counts and leaves the active runner alone.
select pg_temp.un_ready(current_setting('qorpera_test.un_run')::uuid);
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('59800000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.un_claim')::jsonb #>> '{work,attempt}' = '1','The retry is attempt 1');
select pg_temp.base_assert((pg_temp.un_release('59800000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.un_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'attempt_abandoned')::boolean = false,
	'A runner whose machine is still allocated is never taken');
reset role;
select pg_temp.base_assert((pg_temp.un_job()).attempt_count = 0 and (pg_temp.un_job()).dispatch_failure_count = 1
	and (pg_temp.un_runner('qorpera_test.un_runner1')).status = 'active'
	and (pg_temp.un_runner('qorpera_test.un_runner1')).session_token_sha256 = repeat('2',64),
	'The failure is counted; the runner keeps its machine and its session');

-- 3. Node inventory releases the machine. A refusal is placement: it moves nothing and revokes nothing.
update public.qorpera_runtime_machine_allocations set released_at = clock_timestamp()
where id = current_setting('qorpera_test.un_first')::uuid;
select pg_temp.un_ready(current_setting('qorpera_test.un_run')::uuid);
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('59800000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.un_release('59800000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.un_claim')::jsonb,'ADMISSION_REFUSED:SANDBOX_RETIRING') \g /dev/null
reset role;
select pg_temp.base_assert((pg_temp.un_job()).attempt_count = 0 and (pg_temp.un_job()).dispatch_failure_count = 1
	and (pg_temp.un_runner('qorpera_test.un_runner1')).status = 'active','A refusal leaves the attempt and its runner alone');

-- 4. A runner that accepted an assignment of the run is never taken, even with its machine released.
savepoint accepted;
update public.qorpera_runner_assignments set status = 'failed', accepted_at = clock_timestamp() - interval '30 seconds',
	finished_at = clock_timestamp()
where id = current_setting('qorpera_test.un_assignment1')::uuid;
select pg_temp.un_ready(current_setting('qorpera_test.un_run')::uuid);
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('59800000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert((pg_temp.un_release('59800000-0000-4000-8000-0000000000b1',current_setting('qorpera_test.un_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'attempt_abandoned')::boolean = false,
	'A runner that accepted is not abandoned');
reset role;
select pg_temp.base_assert((pg_temp.un_job()).attempt_count = 0 and (pg_temp.un_runner('qorpera_test.un_runner1')).status = 'active',
	'A runner that accepted keeps its attempt');
rollback to savepoint accepted;

-- 5. The fix: the next counted failure revokes the active runner that never started, with its session, and moves the
-- job to attempt 2.
select pg_temp.un_ready(current_setting('qorpera_test.un_run')::uuid);
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('59800000-0000-4000-8000-0000000000b1')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.un_claim')::jsonb #>> '{work,attempt}' = '1','Still attempt 1');
select set_config('qorpera_test.un_result',pg_temp.un_release('59800000-0000-4000-8000-0000000000b1',
	current_setting('qorpera_test.un_claim')::jsonb,'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]')::text,true) \g /dev/null
reset role;
select pg_temp.base_assert((current_setting('qorpera_test.un_result')::jsonb ->> 'attempt_abandoned')::boolean
	and not (current_setting('qorpera_test.un_result')::jsonb ->> 'terminal')::boolean,
	'The failed start of an active runner that never started abandons the attempt: ' || current_setting('qorpera_test.un_result'));
select pg_temp.base_assert((select status = 'revoked' and session_token_sha256 is null and session_expires_at is null
		and previous_session_token_sha256 is null and previous_session_expires_at is null and last_renewal_id is null
		and revoked_by_user_id = registered_by_user_id and revoked_at is not null
	from public.qorpera_runners where id = current_setting('qorpera_test.un_runner1')::uuid),
	'The runner is revoked and has no session');
select pg_temp.base_assert((pg_temp.un_job()).attempt_count = 1 and (pg_temp.un_job()).dispatch_failure_count = 2
	and (pg_temp.un_job()).status = 'queued' and (pg_temp.un_job()).runner_id is null
	and (pg_temp.un_job()).queued_at >= statement_timestamp() - interval '1 second',
	'The job is queued for attempt 2; the caps count one attempt and one dispatch failure');
select pg_temp.base_assert((select attempt = 1 and allocation_id = current_setting('qorpera_test.un_first')::uuid
		and node_id = '59800000-0000-4000-8000-00000000000b'
	from public.qorpera_runtime_run_start_failures where run_id = current_setting('qorpera_test.un_run')::uuid),
	'The failed node is recorded for the run');
select pg_temp.base_assert((select count(*) = 1 from public.qorpera_runner_audit_receipts
	where runner_id = current_setting('qorpera_test.un_runner1')::uuid and event_type = 'runner_revoked'
		and payload ->> 'reason' = 'attempt_start_failed' and payload ->> 'attempt' = '1'
		and payload ->> 'runner_status' = 'active'),'The revocation has its receipt, naming the active runner');

-- 6. The old runner and its machine can never start the run: its acceptance, heartbeat, activation and provisioning
-- are refused.
set local role service_role;
do $$
declare v_runner uuid := current_setting('qorpera_test.un_runner1')::uuid;
begin
	perform pg_temp.base_error(format('select public.qorpera_accept_runner_assignment(%L, %L, %L, %L, %L)', v_runner, repeat('2',64),
		current_setting('qorpera_test.un_assignment1'), current_setting('qorpera_test.un_job'), repeat('3',64)), '42501');
	perform pg_temp.base_error(format('select public.qorpera_heartbeat_runner(%L, %L, %L, %L)', v_runner, repeat('2',64),
		repeat('5',64), extensions.gen_random_uuid()), '42501');
	perform pg_temp.base_error(format('select public.qorpera_activate_runner(%L, %L, %L, %L, %L)', v_runner, repeat('1',64),
		repeat('2',64), 'linux', 'wb002-fixture'), '42501');
	perform pg_temp.base_error(format('select public.qorpera_provision_execution_runner(%L, %L, %L, %L)',
		current_setting('qorpera_test.un_run'), current_setting('qorpera_test.un_first'), 'native-b', repeat('1',64)), '55000');
end $$;
reset role;

-- 7. The attempt limit: an active runner that never started on the eighth attempt fails the job with the reason.
savepoint cap;
update public.qorpera_runner_jobs set attempt_count = 7 where id = current_setting('qorpera_test.un_job')::uuid;
select pg_temp.un_ready(current_setting('qorpera_test.un_run')::uuid);
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('92400000-0000-4000-8000-000000000092')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.un_claim')::jsonb #>> '{work,attempt}' = '8','The claim is attempt 8');
select set_config('qorpera_test.un_runner8',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.un_run')::uuid,
	current_setting('qorpera_test.un_eighth')::uuid,'process',repeat('3',64)) ->> 'runner_id'),true) \g /dev/null
select public.qorpera_activate_runner(current_setting('qorpera_test.un_runner8')::uuid,repeat('3',64),repeat('4',64),'linux','wb002-fixture') \g /dev/null
reset role;
insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,runner_id,provider_adapter,instance_sha256,released_at)
select current_setting('qorpera_test.un_eighth')::uuid, runner.profile_id, current_setting('qorpera_test.un_run')::uuid, runner.id,
	'process', repeat('9',64), clock_timestamp()
from public.qorpera_runners runner where runner.id = current_setting('qorpera_test.un_runner8')::uuid;
set local role service_role;
select pg_temp.base_assert((pg_temp.un_release('92400000-0000-4000-8000-000000000092',current_setting('qorpera_test.un_claim')::jsonb,
	'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]') ->> 'terminal')::boolean,'The eighth attempt''s failed start is final');
reset role;
select pg_temp.base_assert((pg_temp.un_job()).status = 'failed' and (pg_temp.un_job()).attempt_count = 8
	and (pg_temp.un_job()).dispatch_failure_count = 3
	and (pg_temp.un_job()).last_error like 'Runner failed to start on its final attempt:%'
	and (pg_temp.un_runner('qorpera_test.un_runner8')).status = 'revoked','The job fails with the reason');
rollback to savepoint cap;

-- 8. Attempt 2 on node A: a new runner and machine, which accepts and is the only runner holding the job.
set local role service_role;
select set_config('qorpera_test.un_claim',pg_temp.un_claim('92400000-0000-4000-8000-000000000092')::text,true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.un_claim')::jsonb #>> '{work,run_id}' = current_setting('qorpera_test.un_run')
	and current_setting('qorpera_test.un_claim')::jsonb #>> '{work,attempt}' = '2','Node A''s fast host claims attempt 2');
select set_config('qorpera_test.un_runner2',(public.qorpera_provision_execution_runner(current_setting('qorpera_test.un_run')::uuid,
	current_setting('qorpera_test.un_second')::uuid,'process',repeat('2',64)) ->> 'runner_id'),true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.un_runner2') <> current_setting('qorpera_test.un_runner1'),'Attempt 2 has its own runner');
select pg_temp.base_assert(public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.un_second')::uuid,'process',repeat('8',64),
	current_setting('qorpera_test.un_run')::uuid,current_setting('qorpera_test.un_runner2')::uuid) ->> 'state' = 'reserved',
	'Attempt 2''s machine is reserved');
select public.qorpera_activate_runner(current_setting('qorpera_test.un_runner2')::uuid,repeat('2',64),repeat('6',64),'linux','wb002-fixture') \g /dev/null
select set_config('qorpera_test.un_assignment2',public.qorpera_assign_runner_job('92400000-0000-4000-8000-000000000092',
	(current_setting('qorpera_test.un_claim')::jsonb ->> 'claim_id')::uuid,current_setting('qorpera_test.un_runner2')::uuid,
	extensions.gen_random_uuid(),repeat('3',64),120) ->> 'assignment_id',true) \g /dev/null
select public.qorpera_accept_runner_assignment(current_setting('qorpera_test.un_runner2')::uuid,repeat('6',64),
	current_setting('qorpera_test.un_assignment2')::uuid,current_setting('qorpera_test.un_job')::uuid,repeat('3',64)) \g /dev/null
select pg_temp.base_error(format('select public.qorpera_accept_runner_assignment(%L, %L, %L, %L, %L)',
	current_setting('qorpera_test.un_runner1'), repeat('2',64), current_setting('qorpera_test.un_assignment1'),
	current_setting('qorpera_test.un_job'), repeat('3',64)), '42501');
reset role;
select pg_temp.base_assert((pg_temp.un_job()).status = 'leased' and (pg_temp.un_job()).attempt_count = 2
	and (pg_temp.un_job()).runner_id = current_setting('qorpera_test.un_runner2')::uuid
	and (select count(*) = 1 from public.qorpera_runner_assignments
		where run_id = current_setting('qorpera_test.un_run')::uuid and status = 'accepted'),
	'Attempt 2''s runner holds the job, and it is the only accepted assignment of the run');
rollback;
