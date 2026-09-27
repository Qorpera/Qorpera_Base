-- Consumed after the real 300 fixture. Every case addresses Bob and uses the
-- production materializer, claim, assignment and native lease functions.
-- The room projection and input documents are test fixtures; no model runs.
create function pg_temp.wake_context_probe(p_kind text)
returns jsonb language plpgsql as $$
declare v_binding jsonb:=current_setting('qorpera_test.wake_binding')::jsonb;
	v_id uuid; v_run uuid; v_result jsonb; v_routine jsonb; v_room uuid:=extensions.gen_random_uuid();
	v_path text; v_doc text; v_base public.qorpera_execution_runs%rowtype; v_occurrences bigint;
	v_room_pin uuid; v_current_head uuid; v_index integer;
begin
	if p_kind in ('human','first-run') then
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
		values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),
			case when p_kind='human' then 'user_message' else 'kickoff' end,
			'30000000-0000-4000-8000-000000000001',case when p_kind='human' then
				'{"schema":"qorpera.session-prompt/v1","text":"Examine the current company state.","images":[]}'::jsonb
				else '{"schema":"qorpera.staff-kickoff/v1"}'::jsonb end) returning id into v_id;
		perform public.qorpera_materialize_session_execution_runs(4);
		select execution_run_id into strict v_run from public.qorpera_session_inputs where id=v_id;
		perform pg_temp.wake_assert(v_run is not null,'Real input producer admits native run');
		perform pg_temp.wake_assert(public.qorpera_materialize_session_execution_runs(4)='[]'::jsonb,
			'Repeated materialization never duplicates claimed inputs');
	elsif p_kind='routine' then
		v_routine:=pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
			'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}');
		v_id:=pg_temp.wake_schedule(v_routine,'context-silent');
		perform public.qorpera_materialize_wake_execution_runs(1);
		select run_id into strict v_run from public.qorpera_wake_occurrences where id=v_id;
	elsif p_kind='agent' then
		perform pg_temp.wake_public_send(v_binding,'progress');
		v_result:=public.qorpera_send_coworker_message(v_binding,'30000000-0000-4000-8000-000000000031',
			'context-agent','Examine the authorized company state.');
		perform public.qorpera_materialize_wake_execution_runs(1);
		select run_id into strict v_run from public.qorpera_wake_occurrences where id=(v_result->>'occurrenceId')::uuid;
	elsif p_kind in ('room','room-retry') then
		select * into strict v_base from public.qorpera_execution_runs where id=(v_binding->>'runId')::uuid;
		v_path:='organization/rooms/'||v_room::text||'.json';
		v_doc:=jsonb_build_object('schema','qorpera.company-room/v1','roomId',v_room,'key','context-room',
			'name','Context room','purpose','Coordinate authorized work.','status','active','projectId',null,'version',1,
			'members',jsonb_build_array(jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001'),
				jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031')))::text;
		perform public.qorpera_project_organization_document(jsonb_build_object('companyId',v_base.profile_id,
			'environmentId',v_base.environment_id,'userId',v_base.requested_by_user_id,'audience','human'),
			jsonb_build_object('path',v_path,'entry',pg_temp.path_stage_file(v_path,v_doc)),v_doc,
			v_base.company_snapshot_id,extensions.gen_random_uuid());
		-- A durable room outlives unrelated Company File changes. Exercise the
		-- actual successor chain before admitting the room's current-head run.
		perform pg_temp.wake_public_send(v_binding,'progress');
		perform pg_temp.path_commit(pg_temp.path_plan('before-room-wake','room-note.md',
			pg_temp.path_stage_file('room-note.md','A later Company File head.')));
		perform pg_temp.path_commit(pg_temp.path_plan('before-room-wake-again','room-status.md',
			pg_temp.path_stage_file('room-status.md','Another unrelated path change.')));
		perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
		v_result:=public.qorpera_post_company_room_message(v_room,extensions.gen_random_uuid(),
			'{"schema":"qorpera.session-prompt/v1","text":"Bob, what is the current status?"}',
			v_base.sponsor_binding_id,v_base.sponsor_version);
		perform pg_temp.path_claims('service_role');
		perform pg_temp.wake_assert(jsonb_array_length(v_result->'occurrenceIds')=1,'Exactly one room recipient');
		perform public.qorpera_materialize_wake_execution_runs(1);
		select run_id into strict v_run from public.qorpera_wake_occurrences where id=(v_result#>>'{occurrenceIds,0}')::uuid;
	else raise exception 'Unknown context case'; end if;
	v_binding:=pg_temp.wake_start(v_run);
	if p_kind='room-retry' then
		-- The first delivery fails the way a runner reports it; the author tries again. The
		-- retried wake must read exactly like a first delivery to the runner's parser.
		select * into strict v_base from public.qorpera_execution_runs where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
		perform public.qorpera_fail_runner_job((v_binding->>'runnerId')::uuid,repeat('2',64),(v_binding->>'jobId')::uuid,
			repeat('3',64),'Native provider bridge request failed (422)',false);
		perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
		v_result:=public.qorpera_retry_room_delivery(v_run,v_base.sponsor_binding_id,v_base.sponsor_version);
		perform pg_temp.path_claims('service_role');
		perform public.qorpera_materialize_wake_execution_runs(1);
		select run_id into strict v_run from public.qorpera_wake_occurrences where id=(v_result->>'occurrenceId')::uuid;
		v_binding:=pg_temp.wake_start(v_run);
	end if;
	if p_kind='room' then
		perform pg_temp.wake_assert((select r.source_kind='room_delivery'
			and r.company_snapshot_id<>s.company_snapshot_id from public.qorpera_execution_runs r
			join public.qorpera_shared_sessions s on s.id=r.session_id where r.id=v_run),
			'Room delivery pins a successor of the durable room session');
		select * into strict v_base from public.qorpera_execution_runs where id=v_run;
		select company_snapshot_id into strict v_room_pin from public.qorpera_shared_sessions where id=v_base.session_id;
		v_current_head:=v_base.company_snapshot_id;
		perform pg_temp.wake_assert(public.qorpera_run_head_follows_session_pin(v_base,v_room_pin),
			'Room ancestry accepts its real same-environment successor');
		v_base.environment_id:=extensions.gen_random_uuid();
		perform pg_temp.wake_assert(not public.qorpera_run_head_follows_session_pin(v_base,v_room_pin),
			'Room ancestry never crosses environments');
		v_base.environment_id:='30000000-0000-4000-8000-000000000020';
		v_base.source_kind:='session_turn';
		perform pg_temp.wake_assert(not public.qorpera_run_head_follows_session_pin(v_base,v_room_pin),
			'Ordinary session turns retain their exact snapshot pin');
		v_base.source_kind:='room_delivery';
		v_base.company_snapshot_id:=v_room_pin;
		perform pg_temp.wake_assert(not public.qorpera_run_head_follows_session_pin(v_base,v_current_head),
			'Room ancestry never accepts a backwards head');
		begin
			for v_index in 1..3 loop
				perform pg_temp.wake_public_send(v_binding,'progress','room-budget-'||v_index::text);
			end loop;
			perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L,%L)',
				v_binding,'progress','room-over-budget'),'55000','wake public send budget is exhausted');
			perform pg_temp.wake_assert((select count(*)=3 from public.qorpera_agent_sends where run_id=v_run),
				'Room send ceiling is enforced by the database');
			raise exception 'Roll back send-budget fixture' using errcode='PZ001';
		exception when sqlstate 'PZ001' then null; end;
		begin
			update public.qorpera_company_room_members set status='removed',removed_at=clock_timestamp()
			where room_id=v_room and principal_kind='staff_agent';
			perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,%L,%L)',
				v_binding,'final','room-removed'),'42501');
			raise exception 'Roll back member-revocation fixture' using errcode='PZ001';
		exception when sqlstate 'PZ001' then null; end;
		select count(*) into v_occurrences from public.qorpera_wake_occurrences;
		v_result:=pg_temp.wake_public_send(v_binding,'final','room-current-head');
		perform pg_temp.wake_assert(v_result=pg_temp.wake_public_send(v_binding,'final','room-current-head'),
			'Room send replays one receipt across advanced Company File heads');
		perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_agent_sends where run_id=v_run)
			and (select count(*)=v_occurrences from public.qorpera_wake_occurrences),
			'Public room output commits once without broadcasting more agent wakes');
	end if;
	return jsonb_build_object('binding',v_binding,'context',public.qorpera_describe_company_run_context(v_binding),
		'wake',public.qorpera_read_native_wake(v_binding));
end $$;

-- Missing native custody leaves the kickoff unclaimed and creates no job.
savepoint unavailable_capsule;
update public.qorpera_native_credential_capsules set status='revoked',revoked_at=clock_timestamp()
where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'credentialCapsuleId')::uuid;
insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff',
	'30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}');
select pg_temp.wake_assert(public.qorpera_materialize_session_execution_runs(4)='[]'::jsonb,'Unavailable custody admits no native run');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_session_inputs
	where session_id='30000000-0000-4000-8000-000000000042' and execution_run_id is not null),'Kickoff remains unclaimed');
rollback to savepoint unavailable_capsule;
