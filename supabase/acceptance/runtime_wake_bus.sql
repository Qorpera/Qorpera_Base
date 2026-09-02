-- Run only through test-runtime-wake-bus.mjs --integration. The driver supplies
-- the existing 300 fixture and any post-wake migrations in this checkout.
-- Kept outside automatic component-test discovery: this checks the integration
-- contract and must not be mistaken for a passing test of the pinned baseline.
-- This is real database integration acceptance, not a replacement enforcement
-- implementation. Missing main-owned seams fail the command. No provider runs.

create function pg_temp.wake_acceptance_routine(p_reporting text)
returns jsonb language plpgsql as $$
declare v_routine jsonb; v_wake uuid; v_run uuid; v_binding jsonb;
begin
	-- Preserve a real conversation and nonzero transcript start. Removing the
	-- conversation to make zero-send completion pass would hide the integration gap.
	perform pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
		jsonb_build_object('id','tick','kind','schedule','intervalMinutes',5) ||
		case when p_reporting is null then '{}'::jsonb else jsonb_build_object('replyPolicy',p_reporting) end);
	v_wake := pg_temp.wake_schedule(v_routine,'acceptance-' || coalesce(p_reporting,'omitted'));
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = v_wake;
	perform pg_temp.wake_assert((select session_id is not null and transcript_start_sequence > 0
		from public.qorpera_execution_runs where id = v_run),'Routine retains its conversation and prior transcript');
	v_binding := pg_temp.wake_start(v_run);
	perform public.qorpera_read_native_wake(v_binding);
	-- A durable admission marker, not a real provider invocation.
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform set_config('qorpera_test.wake_binding',v_binding::text,true);
	return v_binding;
end
$$;

create function pg_temp.wake_acceptance_finish(p_binding jsonb,
	p_index uuid default '30000000-0000-4000-8000-000000000400',
	p_substrate uuid default '30000000-0000-4000-8000-000000000401')
returns jsonb language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_count integer; v_final uuid; v_result jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (p_binding ->> 'runId')::uuid;
	select count(*),max(event_id::text) filter(where phase='final') into v_count,v_final
	from public.qorpera_agent_sends where run_id = v_run.id and assignment_id = (p_binding ->> 'assignmentId')::uuid;
	v_result := public.qorpera_complete_runner_job_v6((p_binding ->> 'runnerId')::uuid,repeat('2',64),
		(p_binding ->> 'jobId')::uuid,repeat('3',64),p_index,p_substrate,null,jsonb_build_object(
			'schema','qorpera.runner-result/v1','runtime','company-path-v1','backend','native-company-runtime',
			'native_lease_id',p_binding ->> 'leaseId','substrate_version_id',v_run.substrate_version_id,
			'backend_result',jsonb_build_object('schema','qorpera.native-harness-result/v2','run_id',v_run.id,
				'message_count',v_count,'final_message_id',v_final,'provider_session_id','wake-fixture-' || v_run.id),
			'output_count',0,'output_bytes',0,'publication',null,
			'usage','{"schema":"qorpera.runner-usage/v1","execution_ms":1,"input_bytes":0,"output_bytes":0,"result_bytes":1024,
				"limits":{"wall_time_ms":60000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":64,
				"max_input_bytes":1048576,"max_output_bytes":1048576,"max_result_bytes":65536}}'::jsonb));
	perform pg_temp.wake_assert((select job.status='completed' and public.qorpera_execution_run_json(run) ->> 'status'='completed'
		and wake.status='completed'
		from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.job_id=job.id
		join public.qorpera_wake_occurrences wake on wake.run_id=run.id where run.id=v_run.id),
		'Completion durably terminalizes the existing job, run and occurrence');
	perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_execution_run_results
		where run_id=v_run.id and job_id=v_run.job_id and transcript_end_sequence >= v_run.transcript_start_sequence
		and (v_count > 0 or transcript_end_sequence=v_run.transcript_start_sequence)),
		'Completion stores one result without inventing a silent transcript event');
	perform pg_temp.wake_assert((select status<>'active' and released_at is not null
		from public.qorpera_native_provider_connection_leases where id=(p_binding ->> 'leaseId')::uuid),
		'Completion releases native authority');
	return v_result;
end
$$;

create temporary table wake_acceptance_results(name text primary key,passed boolean not null,sqlstate text,error text);
create function pg_temp.wake_acceptance_case(p_name text,p_sql text)
returns void language plpgsql as $$
declare v_passed boolean := false; v_state text; v_error text;
begin
	-- Roll back every case, including successes, to the same admitted fixture.
	-- Record the result outside that subtransaction; do not hide failed gates.
	begin
		execute p_sql;
		raise sqlstate 'QW001';
	exception when sqlstate 'QW001' then v_passed := true;
	when others then get stacked diagnostics v_state=returned_sqlstate,v_error=message_text;
	end;
	insert into wake_acceptance_results values(p_name,v_passed,v_state,left(v_error,512));
end
$$;

select pg_temp.wake_acceptance_case('trusted_context_and_native_start_before_human_ack',$test$
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
begin
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) ->> 'kind'='human','Human context before acknowledgement');
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
end $$;
$test$);

select pg_temp.wake_acceptance_case('human_mutation_requires_initial_ack',$test$
do $$ begin
	perform pg_temp.wake_error($q$select pg_temp.path_commit(pg_temp.path_plan('before-ack','before-ack.md',
		pg_temp.path_stage_file('before-ack.md','Must not publish before acknowledgement')))$q$,'55000');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_company_path_revisions),'Denied work leaves no live revision');
end $$;
$test$);

select pg_temp.wake_acceptance_case('human_final_send_requires_initial_ack',$test$
do $$ begin
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,''final'')',
		current_setting('qorpera_test.wake_binding')),'55000');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends),'Denied final leaves no delivery');
end $$;
$test$);

select pg_temp.wake_acceptance_case('human_ack_final_completion_and_receipt_replay',$test$
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_first jsonb; v_replay jsonb;
begin
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform pg_temp.wake_public_send(v_binding,'final');
	v_first := pg_temp.wake_acceptance_finish(v_binding);
	v_replay := pg_temp.wake_acceptance_finish(v_binding);
	perform pg_temp.wake_assert(v_first=v_replay,'Completion replay returns the same durable receipt');
	perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L,%L)',v_binding,extensions.gen_random_uuid()),'23505');
end $$;
$test$);

select pg_temp.wake_acceptance_case('optional_routine_zero_send_durable_completion',$test$
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.wake_acceptance_routine('optional');
	perform pg_temp.wake_acceptance_finish(v_binding);
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends
		where run_id=(v_binding ->> 'runId')::uuid),'Optional routine completed without a send');
end $$;
$test$);

select pg_temp.wake_acceptance_case('first_run_ack_final_durable_completion_fixture',$test$
do $$
declare v_input uuid; v_run uuid; v_binding jsonb;
begin
	-- Native hire/input production remains a gate. This is the same explicit
	-- canonical claim/reservation fixture used by the component tests.
	insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
	values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff',
		'30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}') returning id into v_input;
	v_run := pg_temp.wake_input_run(array[v_input]);
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) ->> 'kind'='first-run','Typed kickoff context');
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',v_binding),'55000');
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',v_binding),'55000');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform pg_temp.wake_acceptance_finish(v_binding);
	perform pg_temp.wake_assert((select completed_at is not null from public.qorpera_session_inputs where id=v_input),
		'Completion closes the canonical kickoff claim');
end $$;
$test$);

select pg_temp.wake_acceptance_case('silent_routine_zero_send_durable_completion',$test$
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.wake_acceptance_routine('silent');
	perform pg_temp.wake_acceptance_finish(v_binding);
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends
		where run_id=(v_binding ->> 'runId')::uuid),'Silent routine completed without a send');
end $$;
$test$);

select pg_temp.wake_acceptance_case('required_routine_zero_send_denied_then_final_completes',$test$
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.wake_acceptance_routine('required');
	perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',v_binding),'55000');
	perform pg_temp.wake_assert((select status='leased' from public.qorpera_runner_jobs where id=(v_binding ->> 'jobId')::uuid)
		and not exists(select 1 from public.qorpera_execution_run_results where run_id=(v_binding ->> 'runId')::uuid),
		'Denied completion is atomic and leaves the attempt active');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform pg_temp.wake_acceptance_finish(v_binding);
end $$;
$test$);

select pg_temp.wake_acceptance_case('omitted_routine_policy_requires_final_durable_completion',$test$
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.wake_acceptance_routine(null);
	perform pg_temp.wake_assert(public.qorpera_runtime_wake_policy((v_binding ->> 'runId')::uuid) =
		public.qorpera_wake_policy_value('routine','required'),'Omitted immutable reporting policy cannot authorize silence');
	perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',v_binding),'55000');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform pg_temp.wake_acceptance_finish(v_binding);
end $$;
$test$);

select pg_temp.wake_acceptance_case('optional_progress_only_denied_then_final_completes',$test$
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.wake_acceptance_routine('optional');
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',v_binding),'55000');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform pg_temp.wake_acceptance_finish(v_binding);
end $$;
$test$);

select pg_temp.wake_acceptance_case('silent_routine_public_send_admission_denied',$test$
do $$
declare v_binding jsonb; v_phase text;
begin
	v_binding := pg_temp.wake_acceptance_routine('silent');
	foreach v_phase in array array['progress','final'] loop
		perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L)',v_binding,v_phase),'55000');
	end loop;
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends
		where run_id=(v_binding ->> 'runId')::uuid),'Silent policy rejects at admission, not only completion');
end $$;
$test$);

select pg_temp.wake_acceptance_case('public_send_budget_enforced_at_admission',$test$
do $$
declare v_binding jsonb; v_count integer;
begin
	v_binding := pg_temp.wake_acceptance_routine('optional');
	for v_count in 1..64 loop perform pg_temp.wake_public_send(v_binding,'progress','bounded-' || v_count); end loop;
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,''final'')',v_binding),'55000');
	perform pg_temp.wake_assert((select count(*)=64 from public.qorpera_agent_sends
		where run_id=(v_binding ->> 'runId')::uuid),'Budget denial does not append a 65th event');
end $$;
$test$);

select pg_temp.wake_acceptance_case('routine_file_mutation_then_final_and_completion',$test$
do $$
declare v_binding jsonb; v_change jsonb; v_result jsonb;
begin
	-- Advance the File through an earlier authorized run. The routine then pins
	-- the new head while its existing conversation still pins the prior head.
	-- This is a real publication, not a fabricated session/run mismatch.
	v_binding := current_setting('qorpera_test.wake_binding')::jsonb;
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform pg_temp.path_commit(pg_temp.path_plan('earlier-work','earlier-work.md',
		pg_temp.path_stage_file('earlier-work.md','An earlier authorized publication')));
	v_binding := pg_temp.wake_acceptance_routine('optional');
	perform pg_temp.wake_assert((select session.company_snapshot_id is not null
		and session.company_snapshot_id <> run.company_snapshot_id
		from public.qorpera_execution_runs run join public.qorpera_shared_sessions session on session.id=run.session_id
		where run.id=(v_binding ->> 'runId')::uuid),'Published File head has advanced beyond the existing conversation pin');
	v_change := pg_temp.path_commit(pg_temp.path_plan('routine-result','routine-result.md',
		pg_temp.path_stage_file('routine-result.md','Completed governed work')));
	perform pg_temp.wake_assert(v_change ->> 'state'='applied','Governed mutation commits before the report');
	perform pg_temp.wake_public_send(v_binding,'final');
	v_result := pg_temp.wake_acceptance_finish(v_binding);
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_execution_run_results
		where run_id=(v_binding ->> 'runId')::uuid and output_snapshot_id=(v_change ->> 'snapshotId')::uuid
		and company_disposition='published'),'Completion references the applied revision');
end $$;
$test$);

select pg_temp.wake_acceptance_case('final_delivery_closes_further_company_file_work',$test$
do $$
declare v_binding jsonb;
begin
	v_binding := pg_temp.wake_acceptance_routine('optional');
	perform pg_temp.wake_public_send(v_binding,'final');
	perform pg_temp.wake_error($q$select pg_temp.path_commit(pg_temp.path_plan('after-final','after-final.md',
		pg_temp.path_stage_file('after-final.md','Must not publish after final')))$q$,'55000');
end $$;
$test$);

select pg_temp.wake_acceptance_case('agent_delivery_zero_public_send_durable_completion',$test$
do $$
declare v_source jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_send jsonb; v_run uuid; v_binding jsonb;
begin
	perform pg_temp.wake_public_send(v_source,'progress');
	v_send := public.qorpera_send_coworker_message(v_source,'30000000-0000-4000-8000-000000000031','acceptance-agent','Examine this note.');
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id=(v_send ->> 'occurrenceId')::uuid;
	v_binding := pg_temp.wake_start(v_run);
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_binding) ->> 'kind'='agent','Fresh coworker admission');
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_acceptance_finish(v_binding);
end $$;
$test$);

select pg_temp.wake_acceptance_case('room_post_fans_out_bounded_sends_and_silent_completion',$test$
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_base public.qorpera_execution_runs%rowtype;
	v_room uuid := '30000000-0000-4000-8000-000000000080'; v_path text; v_doc text; v_entry jsonb; v_post jsonb;
	v_first jsonb; v_second jsonb; v_wake jsonb;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	-- Fixture: the room document is projected as the member command path projects
	-- it after publication (20260828019200); the publication route itself is not
	-- under test here.
	v_path := 'organization/rooms/' || v_room::text || '.json';
	v_doc := jsonb_build_object('schema','qorpera.company-room/v1','roomId',v_room,'key','launch-room','name','Launch room',
		'purpose','Coordinate the launch.','status','active','projectId',null,'version',1,'members',jsonb_build_array(
			jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001'),
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031'),
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000032')))::text;
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	perform public.qorpera_project_organization_document(jsonb_build_object('companyId',v_base.profile_id,
		'environmentId',v_base.environment_id,'userId',v_base.requested_by_user_id,'audience','human'),
		jsonb_build_object('path',v_path,'entry',v_entry),v_doc,v_base.company_snapshot_id,extensions.gen_random_uuid());
	perform pg_temp.wake_assert((select status = 'active' and session_id is not null from public.qorpera_company_rooms where id = v_room),
		'Room projected with its conversation');
	perform pg_temp.wake_assert((select count(*) = 3 from public.qorpera_company_room_members where room_id = v_room and status = 'active'),
		'Room members projected');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_post := public.qorpera_post_company_room_message(v_room,extensions.gen_random_uuid(),
		jsonb_build_object('schema','qorpera.session-prompt/v1','text','Team, what is the launch status?'),
		v_base.sponsor_binding_id,v_base.sponsor_version);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert(jsonb_array_length(v_post -> 'occurrenceIds') = 2,'One room wake per agent member');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_materialize_wake_execution_runs(4)) = 2,'Both room wakes materialize');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_events
		where session_id = (v_post ->> 'sessionId')::uuid and session_input_id = (v_post ->> 'inputId')::uuid),
		'The post enters the room conversation once');
	-- First agent: the room policy bounds public sends to three; a fourth is refused at admission.
	v_first := pg_temp.wake_start(null);
	v_wake := public.qorpera_read_native_wake(v_first);
	perform pg_temp.wake_assert(v_wake ->> 'kind' = 'room' and (v_wake #>> '{policy,maxPublicSends}') = '3'
		and (v_wake #>> '{payload,roomId}') = v_room::text and (v_wake #>> '{audience,sessionId}') = v_post ->> 'sessionId','Room envelope');
	perform public.qorpera_begin_native_company_execution(v_first,repeat('7',64));
	perform pg_temp.wake_public_send(v_first,'progress','room-1');
	perform pg_temp.wake_public_send(v_first,'progress','room-2');
	perform pg_temp.wake_public_send(v_first,'final','room-3');
	perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,''progress'',''room-4'')',v_first),'55000');
	perform pg_temp.wake_acceptance_finish(v_first);
	-- Second agent: silence is a valid room result.
	v_second := pg_temp.wake_start(null);
	perform pg_temp.wake_assert((v_second ->> 'runId') <> (v_first ->> 'runId'),'Second room run');
	perform public.qorpera_read_native_wake(v_second);
	perform public.qorpera_begin_native_company_execution(v_second,repeat('7',64));
	perform pg_temp.wake_acceptance_finish(v_second);
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends where run_id = (v_second ->> 'runId')::uuid),
		'Silent room completion');
end $$;
$test$);

select pg_temp.wake_acceptance_case('wake_rate_ceiling_and_founder_stop',$test$
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_base public.qorpera_execution_runs%rowtype;
	v_first jsonb; v_second jsonb; v_occurrence public.qorpera_wake_occurrences%rowtype; v_used bigint;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_public_send(v_binding,'progress');
	-- The founder sets the wake ceiling to one more autonomous wake than this hour already holds.
	v_used := public.qorpera_company_wakes_last_hour(v_base.profile_id);
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_ceiling(v_base.profile_id,250000000,100000000,0,v_used + 1);
	perform pg_temp.path_claims('service_role');
	v_first := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','ceiling-1','First delegation.');
	perform pg_temp.wake_assert(v_first ->> 'status' = 'queued' and (select status = 'queued' from public.qorpera_wake_occurrences
		where id = (v_first ->> 'occurrenceId')::uuid),'First autonomous wake admitted');
	v_second := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000032','ceiling-2','Second delegation.');
	select * into strict v_occurrence from public.qorpera_wake_occurrences where id = (v_second ->> 'occurrenceId')::uuid;
	perform pg_temp.wake_assert(v_occurrence.status = 'cancelled' and v_occurrence.blocked_reason = 'Company wake ceiling tripped',
		'Second wake stopped at the ceiling without agent cooperation');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_company_ceiling_trips where profile_id = v_base.profile_id
		and dimension = 'wakes' and run_id = v_occurrence.id),'Ceiling trip recorded');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_member_notifications where profile_id = v_base.profile_id
		and user_id = '30000000-0000-4000-8000-000000000001' and kind = 'company_ceiling_tripped' and subject ->> 'dimension' = 'wakes'),
		'Founder notified from the control plane');
	-- The founder stop: running work is fenced at its next effect, new turns and posts are refused.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_pause(v_base.profile_id,true,'Acceptance stop');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_error($q$select pg_temp.path_commit(pg_temp.path_plan('paused-work','paused.md',
		pg_temp.path_stage_file('paused.md','Must not apply while paused')))$q$,'55000');
	perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,%L,%L)',v_binding,
		'30000000-0000-4000-8000-000000000031','ceiling-3','Paused delegation.'),'55000');
	v_second := public.qorpera_materialize_wake_execution_runs(4);
	perform pg_temp.wake_assert(v_second = '[]'::jsonb,'Nothing materializes while paused');
	perform pg_temp.wake_assert((select blocked_reason = 'Company execution is paused' and status = 'queued'
		from public.qorpera_wake_occurrences where id = (v_first ->> 'occurrenceId')::uuid),'Queued wakes wait while paused');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_member_notifications where profile_id = v_base.profile_id
		and kind = 'company_execution_paused'),'Founders notified of the stop');
	-- Resume: work continues.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_pause(v_base.profile_id,false,null);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((pg_temp.path_commit(pg_temp.path_plan('resumed-work','resumed.md',
		pg_temp.path_stage_file('resumed.md','Applies after resume'))) ->> 'state') = 'applied','Work resumes after the stop is lifted');
end $$;
$test$);

select pg_temp.wake_acceptance_case('usage_limit_sponsor_handoff_continues_the_run',$test$
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_base public.qorpera_execution_runs%rowtype;
	v_login jsonb; v_connection jsonb; v_second jsonb; v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	-- A second connection of the same member for the same compute identity (the fixture's login route).
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	execute 'set local role authenticated';
	v_login := public.qorpera_begin_native_provider_login(v_base.profile_id,'30000000-0000-4000-8000-000000000053',
		'30000000-0000-4000-8000-000000000054',v_base.compute_identity_id,'openai','codex-cli',repeat('c',64),900);
	execute 'reset role';
	perform pg_temp.path_claims('service_role');
	execute 'set local role service_role';
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat('c',64),
		'30000000-0000-4000-8000-000000000062','object://native-capsules/30000000-0000-4000-8000-000000000062',repeat('d',64),
		'fixture-openai-account-2','personal-subscription','qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	execute 'reset role';
	-- The first attempt acknowledges, then the sponsoring connection hits its usage limit.
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_public_send(v_binding,'progress');
	perform public.qorpera_record_provider_usage_signal(v_binding,'usage_limit',clock_timestamp() + interval '2 hours');
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid,repeat('2',64),(v_binding ->> 'jobId')::uuid,repeat('3',64),
		'Native harness failed (provider allowance unavailable)',false);
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	select * into strict v_run from public.qorpera_execution_runs where id = v_base.id;
	perform pg_temp.wake_assert(v_job.status = 'queued' and v_run.sponsor_version = v_base.sponsor_version + 1,
		'The run continues on a new sponsor version instead of failing');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_execution_sponsor_handoffs handoff
		where handoff.run_id = v_base.id and handoff.to_connection_id = (v_connection ->> 'connection_id')::uuid
			and handoff.reason = 'usage_limit' and handoff.actor = 'control_plane'),'Handoff recorded with full provenance');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_execution_run_events where run_id = v_base.id and event_type = 'sponsor_handoff'),
		'Handoff is a run event');
	perform pg_temp.wake_assert(exists(select 1 from public.qorpera_member_notifications where profile_id = v_base.profile_id
		and user_id = '30000000-0000-4000-8000-000000000001' and kind = 'sponsor_handoff'),'Member notified of the handoff');
	perform pg_temp.wake_assert((select status <> 'active' and released_at is not null from public.qorpera_native_provider_connection_leases
		where id = (v_binding ->> 'leaseId')::uuid),'Exhausted attempt released its native authority');
	-- The next attempt runs on the other connection with context rebuilt from the transcript.
	v_second := pg_temp.wake_start(null);
	perform pg_temp.wake_assert((v_second ->> 'runId') = v_base.id::text,'Same run, new attempt');
	perform pg_temp.wake_assert((select provider_connection_id = (v_connection ->> 'connection_id')::uuid
		from public.qorpera_native_provider_connection_leases where id = (v_second ->> 'leaseId')::uuid),'New attempt leases the other connection');
	perform pg_temp.wake_assert(public.qorpera_read_native_wake(v_second) ->> 'kind' = 'human','Same wake, same policy');
	perform public.qorpera_begin_native_company_execution(v_second,repeat('7',64));
	perform pg_temp.wake_public_send(v_second,'final','handoff-final');
	perform pg_temp.wake_acceptance_finish(v_second);
	perform pg_temp.wake_assert(public.qorpera_handoff_run_sponsor(v_base.id,'again') is null,'A completed run has no second handoff');
end $$;
$test$);

select pg_temp.wake_acceptance_case('member_consents_to_autonomous_work_on_own_connection',$test$
do $$
declare v_base public.qorpera_execution_runs%rowtype; v_connection uuid; v_consent jsonb; v_sponsor jsonb;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	v_connection := (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid;
	-- Another member cannot consent for this connection.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
	execute 'set local role authenticated';
	perform pg_temp.wake_error(format('select public.qorpera_consent_provider_connection_autonomous(%L,%L,true)',v_base.profile_id,v_connection),'42501');
	execute 'reset role';
	-- The owner withdraws and grants consent as new immutable versions; a sponsor may reference the consented one.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	execute 'set local role authenticated';
	v_consent := public.qorpera_consent_provider_connection_autonomous(v_base.profile_id,v_connection,false);
	perform pg_temp.wake_assert((v_consent ->> 'changed')::boolean and not (v_consent ->> 'allow_autonomous')::boolean,'Consent withdrawn as a new version');
	perform pg_temp.wake_error(format('select public.qorpera_create_member_execution_sponsor(%L,%L,%L,%s,true)',v_base.profile_id,
		extensions.gen_random_uuid(),v_connection,v_consent ->> 'version'),'42501');
	v_consent := public.qorpera_consent_provider_connection_autonomous(v_base.profile_id,v_connection,true);
	perform pg_temp.wake_assert((v_consent ->> 'changed')::boolean and (v_consent ->> 'allow_autonomous')::boolean,'Consent granted as a new version');
	v_sponsor := public.qorpera_create_member_execution_sponsor(v_base.profile_id,extensions.gen_random_uuid(),v_connection,(v_consent ->> 'version')::bigint,true);
	execute 'reset role';
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((select allow_autonomous from public.qorpera_execution_sponsor_versions
		where binding_id = (v_sponsor ->> 'binding_id')::uuid and version = (v_sponsor ->> 'version')::bigint),'Sponsor carries the consent');
end $$;
$test$);

select jsonb_build_object('schema','qorpera.wake-integration-acceptance/v1','cases',
	jsonb_agg(jsonb_build_object('name',name,'passed',passed,'sqlstate',sqlstate,'error',error) order by name))
from wake_acceptance_results;
rollback;

