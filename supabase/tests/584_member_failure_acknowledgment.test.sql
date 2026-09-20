-- @fixture 320_runtime_operational_observability.test.sql until "-- Order 1 (contract section 17):"
reset role;

-- The real admitted run has an ambiguous operation, matching the live symptom.
insert into public.qorpera_run_operation_receipts(id,run_id,job_id,assignment_id,
	logical_operation_key,operation_kind,input_sha256,downstream_idempotency_sha256,status,completed_at)
select '58400000-0000-4000-8000-000000000001',
	(b ->> 'runId')::uuid,(b ->> 'jobId')::uuid,(b ->> 'assignmentId')::uuid,
	'uncertain-computer-open','computer_open',repeat('a',64),repeat('b',64),'ambiguous',clock_timestamp()
from (select current_setting('qorpera_test.path_binding')::jsonb b) fixture;
select pg_temp.path_claims('service_role');
select public.qorpera_terminalize_runner_attempt(
	(current_setting('qorpera_test.path_binding')::jsonb ->> 'jobId')::uuid,'failed','Unconfirmed operation',false);

-- Capture canonical state after terminalization: acknowledgment must be a read
-- receipt only, including for ambiguous work whose discard would be rejected.
create temporary table failure_before as select
	(select jsonb_agg(to_jsonb(r)) from public.qorpera_execution_runs r) runs,
	(select jsonb_agg(to_jsonb(j)) from public.qorpera_runner_jobs j) jobs,
	(select jsonb_agg(to_jsonb(o)) from public.qorpera_run_operation_receipts o) operations,
	(select jsonb_agg(to_jsonb(i)) from public.qorpera_session_inputs i) inputs,
	(select jsonb_agg(to_jsonb(e)) from public.qorpera_execution_run_events e) events;

select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
	v_env uuid := '29000000-0000-4000-8000-000000000020';
begin
	if public.qorpera_list_staff_execution_activity(v_env) #>> '{0,run_id}' is distinct from v_run::text then
		raise exception 'unseen failed run was not visible'; end if;
	if public.qorpera_acknowledge_execution_run_failure(v_run) is distinct from v_run
		or public.qorpera_acknowledge_execution_run_failure(v_run) is distinct from v_run then
		raise exception 'failure acknowledgment was not exact and idempotent'; end if;
	if public.qorpera_list_staff_execution_activity(v_env) <> '[]'::jsonb then
		raise exception 'acknowledged ambiguous failure still masks current activity'; end if;
	if public.qorpera_get_execution_run_recovery(v_run) #>> '{operations,0,status}' <> 'ambiguous' then
		raise exception 'viewing the error removed its unresolved recovery'; end if;
	begin
		perform public.qorpera_resolve_failed_execution_run(v_run,'discard');
		raise exception 'seen acknowledgment weakened unresolved operation protection';
	exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
do $$ begin
	if exists (select 1 from failure_before before where
		before.runs is distinct from (select jsonb_agg(to_jsonb(r)) from public.qorpera_execution_runs r)
		or before.jobs is distinct from (select jsonb_agg(to_jsonb(j)) from public.qorpera_runner_jobs j)
		or before.operations is distinct from (select jsonb_agg(to_jsonb(o)) from public.qorpera_run_operation_receipts o)
		or before.inputs is distinct from (select jsonb_agg(to_jsonb(i)) from public.qorpera_session_inputs i)
		or before.events is distinct from (select jsonb_agg(to_jsonb(e)) from public.qorpera_execution_run_events e)) then
		raise exception 'acknowledgment mutated operational state'; end if;
	if (select count(*) from public.qorpera_execution_run_failure_acknowledgments) <> 1 then
		raise exception 'duplicate acknowledgment stored'; end if;
end $$;

-- A viewer sees and acknowledges independently from the owner.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$
declare v_run uuid := (current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid;
begin
	if public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020')
		#>> '{0,run_id}' is distinct from v_run::text then
		raise exception 'owner acknowledgment leaked into another member'; end if;
	perform public.qorpera_acknowledge_execution_run_failure(v_run);
	if public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020') <> '[]'::jsonb then
		raise exception 'viewer could not acknowledge a seen failure'; end if;
end $$;
reset role;

-- Admit real later work. The old ambiguous run must not mask this queued run,
-- and its acknowledgment must not suppress a distinct later failure.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.next_seen_turn',public.qorpera_request_session_turn_v2(
	'29000000-0000-4000-8000-000000000040','58400000-0000-4000-8000-000000000070','58400000-0000-4000-8000-000000000071',
	'{"schema":"qorpera.session-prompt/v1","text":"New independent question.","images":[]}','member_connection',
	(current_setting('qorpera_test.path_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,
	(current_setting('qorpera_test.path_identity')::jsonb ->> 'compute_identity_id')::uuid,
	null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_run uuid := (current_setting('qorpera_test.next_seen_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_activity jsonb := public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020') -> 0;
begin
	if v_activity ->> 'run_id' is distinct from v_run::text or v_activity ->> 'job_status' <> 'queued' then
		raise exception 'seen failed run masks later active work'; end if;
	begin
		perform public.qorpera_acknowledge_execution_run_failure(v_run);
		raise exception 'active work was acknowledged before it failed';
	exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
select pg_temp.path_claims('service_role');
select public.qorpera_terminalize_runner_attempt((select job_id from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.next_seen_turn')::jsonb ->> 'turn_request_id')::uuid),
	'failed','New failure',false);
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
	if public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020') #>> '{0,run_id}'
		is distinct from current_setting('qorpera_test.next_seen_turn')::jsonb ->> 'turn_request_id' then
		raise exception 'old read receipt suppressed a new failed run'; end if;
end $$;
reset role;

-- A proposal created later remains actionable even if its failure was seen.
insert into public.qorpera_company_proposals(profile_id,environment_id,client_proposal_id,
	proposal_snapshot_id,execution_kind,execution_id,execution_claimant_id,session_id,
	trail_end_sequence,reason,title,created_by_user_id)
values ('29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020',
	'58400000-0000-4000-8000-000000000080','29000000-0000-4000-8000-000000000023','run',
	(current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid,
	(current_setting('qorpera_test.path_binding')::jsonb ->> 'assignmentId')::uuid,
	'29000000-0000-4000-8000-000000000040',0,'recovery','Review earlier changes',
	'29000000-0000-4000-8000-000000000001');
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_acknowledge_execution_run_failure(
	(current_setting('qorpera_test.next_seen_turn')::jsonb ->> 'turn_request_id')::uuid);
do $$ begin
	if public.qorpera_list_staff_execution_activity('29000000-0000-4000-8000-000000000020') #>> '{0,run_id}'
		is distinct from current_setting('qorpera_test.path_binding')::jsonb ->> 'runId' then
		raise exception 'read receipt hid open proposal work'; end if;
end $$;
reset role;

-- Neither a nonmember nor direct table access can acknowledge another user.
select pg_temp.path_claims('authenticated','58400000-0000-4000-8000-000000000099');
set local role authenticated;
do $$ begin
	begin
		perform public.qorpera_acknowledge_execution_run_failure(
			(current_setting('qorpera_test.path_binding')::jsonb ->> 'runId')::uuid);
		raise exception 'nonmember acknowledged company work';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
	if has_function_privilege('anon','public.qorpera_acknowledge_execution_run_failure(uuid)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_acknowledge_execution_run_failure(uuid)','EXECUTE')
		or has_table_privilege('authenticated','public.qorpera_execution_run_failure_acknowledgments','SELECT,INSERT,UPDATE,DELETE')
		or has_table_privilege('service_role','public.qorpera_execution_run_failure_acknowledgments','SELECT,INSERT,UPDATE,DELETE') then
		raise exception 'acknowledgment boundary grants direct or nonmember access'; end if;
end $$;
rollback;
