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

select pg_temp.wake_acceptance_case('public_sends_have_no_count_at_admission',$test$
do $$
declare v_binding jsonb; v_count integer;
begin
	-- Runtime v92: no send limit per wake (was 64).
	v_binding := pg_temp.wake_acceptance_routine('optional');
	for v_count in 1..70 loop perform pg_temp.wake_public_send(v_binding,'progress','many-' || v_count); end loop;
	perform pg_temp.wake_public_send(v_binding,'final');
	perform pg_temp.wake_assert((select count(*)=71 from public.qorpera_agent_sends
		where run_id=(v_binding ->> 'runId')::uuid),'Seventy progress messages and a final are admitted');
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

select pg_temp.wake_acceptance_case('room_post_fans_out_sends_and_silent_completion',$test$
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
	-- First agent: a room wake has no send limit (runtime v92); four progress messages and a final are admitted.
	v_first := pg_temp.wake_start(null);
	v_wake := public.qorpera_read_native_wake(v_first);
	perform pg_temp.wake_assert(v_wake ->> 'kind' = 'room' and v_wake -> 'policy' -> 'maxPublicSends' = 'null'::jsonb
		and (v_wake #>> '{payload,roomId}') = v_room::text and (v_wake #>> '{audience,sessionId}') = v_post ->> 'sessionId','Room envelope');
	perform public.qorpera_begin_native_company_execution(v_first,repeat('7',64));
	perform pg_temp.wake_public_send(v_first,'progress','room-1');
	perform pg_temp.wake_public_send(v_first,'progress','room-2');
	perform pg_temp.wake_public_send(v_first,'progress','room-3');
	perform pg_temp.wake_public_send(v_first,'progress','room-4');
	perform pg_temp.wake_public_send(v_first,'final','room-5');
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

select pg_temp.wake_acceptance_case('no_wake_ceiling_and_operator_stop',$test$
do $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_base public.qorpera_execution_runs%rowtype;
	v_first jsonb; v_second jsonb; v_notifications bigint;
begin
	select * into strict v_base from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform pg_temp.wake_public_send(v_binding,'progress');
	-- There is no company wake ceiling (2026-09-24): back-to-back delegations are both admitted.
	v_first := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031','ceiling-1','First delegation.');
	perform pg_temp.wake_assert(v_first ->> 'status' = 'queued' and (select status = 'queued' from public.qorpera_wake_occurrences
		where id = (v_first ->> 'occurrenceId')::uuid),'First autonomous wake admitted');
	v_second := public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000032','ceiling-2','Second delegation.');
	perform pg_temp.wake_assert((select status = 'queued' from public.qorpera_wake_occurrences
		where id = (v_second ->> 'occurrenceId')::uuid),'Second autonomous wake admitted without a company ceiling');
	select count(*) into v_notifications from public.qorpera_member_notifications where profile_id = v_base.profile_id;
	-- The operator stop (an operator session with a founder's claims): running work is fenced at its next
	-- effect, new turns and posts are refused, and no member is notified.
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
	perform pg_temp.wake_assert((select count(*) from public.qorpera_member_notifications
		where profile_id = v_base.profile_id) = v_notifications,'The stop notifies no member');
	-- Resume: work continues.
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_execution_pause(v_base.profile_id,false,null);
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((pg_temp.path_commit(pg_temp.path_plan('resumed-work','resumed.md',
		pg_temp.path_stage_file('resumed.md','Applies after resume'))) ->> 'state') = 'applied','Work resumes after the stop is lifted');
end $$;
$test$);

-- Exercise the same v2 launch-provenance entrypoint as the signed native host.
-- The older v1 admission marker never inserts or replaces a launch row.
create function pg_temp.handoff_begin(p_binding jsonb,p_context_sha text)
returns jsonb language plpgsql as $$
declare v_identity jsonb := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	v_binary text;
begin
	select manifest ->> 'nativeBinarySha256' into strict v_binary from public.qorpera_runtime_bundles
	where id = (v_identity ->> 'runtimeBundleId')::uuid;
	return public.qorpera_begin_native_company_execution_v2(p_binding,v_binary,
		v_identity ->> 'runtimeBundleSha256',v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic handoff fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		p_context_sha,10);
end $$;

-- Second-connection and capacity fixtures use real login, member admission, runner
-- assignment and lease entrypoints in this disposable database. No provider
-- process or production credential participates. (The sponsor handoff they were
-- written for is gone since 20260930048000; later reviews still use them.)
create function pg_temp.handoff_connection()
returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_login jsonb; v_connection jsonb; v_capsule uuid := extensions.gen_random_uuid();
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	-- Login pins a one-slot connection. Restore the original global policy
	-- afterward so the already-admitted source connection remains authorized.
	perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
		'supported','enabled',1,null,'handoff-capacity-fixture');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	execute 'set local role authenticated';
	v_login := public.qorpera_begin_native_provider_login(v_base.profile_id,extensions.gen_random_uuid(),
		extensions.gen_random_uuid(),v_base.compute_identity_id,'openai','codex-cli',repeat('c',64),900);
	execute 'reset role';
	perform pg_temp.path_claims('service_role');
	execute 'set local role service_role';
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat('c',64),
		v_capsule,'object://native-capsules/' || v_capsule::text,repeat('d',64),
		'fixture-handoff-account-' || v_capsule::text,'personal-subscription','qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
	execute 'reset role';
	perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
		'supported','enabled',32,null,'wake-component-fixture');
	return v_connection;
end $$;

create function pg_temp.handoff_competing_assignment(p_connection jsonb,p_acquire boolean)
returns jsonb language plpgsql as $$
declare v_base public.qorpera_execution_runs%rowtype; v_sponsor jsonb; v_request jsonb;
	v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_lease jsonb; v_run uuid;
begin
	select * into strict v_base from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	execute 'set local role authenticated';
	v_sponsor := public.qorpera_create_member_execution_sponsor(v_base.profile_id,extensions.gen_random_uuid(),
		(p_connection ->> 'connection_id')::uuid,(p_connection ->> 'version')::bigint,false);
	v_request := public.qorpera_request_session_turn_v2('30000000-0000-4000-8000-000000000042',
		extensions.gen_random_uuid(),extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"Hold this independently admitted capacity slot.","images":[]}',
		'member_connection',(v_sponsor ->> 'binding_id')::uuid,(v_sponsor ->> 'version')::bigint,null,
		v_base.compute_identity_id,null,'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}');
	execute 'reset role';
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_materialize_session_turn_requests(32);
	v_run := (v_request ->> 'turn_request_id')::uuid;
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('30000000-0000-4000-8000-000000000092',extensions.gen_random_uuid(),120);
	perform pg_temp.wake_assert(v_claim #>> '{work,run_id}' = v_run::text,'Competing run is admitted through its own member request');
	v_runner := public.qorpera_provision_execution_runner(v_run,extensions.gen_random_uuid(),'process',repeat('1',64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid,repeat('1',64),repeat('2',64),'linux','handoff-capacity-fixture');
	v_assignment := public.qorpera_assign_runner_job('30000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		(v_runner ->> 'runner_id')::uuid,extensions.gen_random_uuid(),repeat('3',64),120);
	perform public.qorpera_accept_runner_assignment((v_runner ->> 'runner_id')::uuid,repeat('2',64),
		(v_assignment ->> 'assignment_id')::uuid,(v_claim #>> '{work,job_id}')::uuid,repeat('3',64));
	if p_acquire then
		v_lease := public.qorpera_acquire_native_provider_connection_lease(v_run,(v_runner ->> 'runner_id')::uuid,repeat('2',64),
			(v_assignment ->> 'assignment_id')::uuid,repeat('3',64),120);
	end if;
	return jsonb_build_object('runId',v_run,'jobId',v_claim #>> '{work,job_id}','runnerId',v_runner ->> 'runner_id',
		'assignmentId',v_assignment ->> 'assignment_id','leaseId',v_lease ->> 'lease_id');
end $$;

create function pg_temp.non_quota_failure(p_kind text)
returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_version bigint;
begin
	select sponsor_version into strict v_version from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform pg_temp.handoff_connection();
	perform public.qorpera_begin_native_company_execution(v_binding,repeat('7',64));
	perform public.qorpera_record_provider_usage_signal(v_binding,p_kind,null);
	perform public.qorpera_fail_runner_job((v_binding ->> 'runnerId')::uuid,repeat('2',64),(v_binding ->> 'jobId')::uuid,
		repeat('3',64),'Native harness failed (' || p_kind || ')',false);
	perform pg_temp.wake_assert((select sponsor_version = v_version from public.qorpera_execution_runs
		where id = (v_binding ->> 'runId')::uuid),'Non-quota failure leaves the sponsor unchanged');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_execution_sponsor_handoffs
		where run_id = (v_binding ->> 'runId')::uuid),'Non-quota failure records no handoff');
	perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_member_notifications
		where kind in ('provider_usage_limit','sponsor_handoff')),'No quota or handoff notification is invented');
	perform pg_temp.wake_assert((select status = 'failed' from public.qorpera_runner_jobs
		where id = (v_binding ->> 'jobId')::uuid),'Nonretryable failure terminates the job');
	perform pg_temp.wake_assert((select status <> 'active' and released_at is not null
		from public.qorpera_native_provider_connection_leases where id = (v_binding ->> 'leaseId')::uuid),
		'Non-quota failure releases native authority');
end $$;

select pg_temp.wake_acceptance_case('rate_limit_is_not_a_usage_limit',
	$test$select pg_temp.non_quota_failure('rate_limited');$test$);
select pg_temp.wake_acceptance_case('provider_outage_is_not_a_usage_limit',
	$test$select pg_temp.non_quota_failure('provider_outage');$test$);

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
