-- Review two: real entrypoints in the same disposable fixture. No provider.
create function pg_temp.review2_start(p_kind text)
returns jsonb language plpgsql as $$
declare b jsonb:=current_setting('qorpera_test.wake_binding')::jsonb; r jsonb; w uuid; v_run uuid; v_input uuid;
 v_base public.qorpera_execution_runs%rowtype; v_room uuid:=extensions.gen_random_uuid(); v_path text; v_doc text;
begin
 if p_kind='human' then return b; end if;
 if p_kind='routine' then
  r:=pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
   '{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}');
  perform set_config('qorpera_test.review2_routine',r::text,true);
  w:=pg_temp.wake_schedule(r,'review2');
 elsif p_kind='agent' then
  perform pg_temp.wake_public_send(b,'progress');
  r:=public.qorpera_send_coworker_message(b,'30000000-0000-4000-8000-000000000031','review2','Examine this note.');
  w:=(r->>'occurrenceId')::uuid;
 elsif p_kind='first-run' then
  -- Same canonical kickoff claim fixture as the original wake acceptance.
  insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
  values('30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff',
   '30000000-0000-4000-8000-000000000001','{"schema":"qorpera.staff-kickoff/v1"}') returning id into v_input;
  return pg_temp.wake_start(pg_temp.wake_input_run(array[v_input]));
 elsif p_kind='room' then
  select * into strict v_base from public.qorpera_execution_runs where id=(b->>'runId')::uuid;
  v_path:='organization/rooms/'||v_room::text||'.json';
  v_doc:=jsonb_build_object('schema','qorpera.company-room/v1','roomId',v_room,'key','review2-room','name','Review room',
   'purpose','Review governed work.','status','active','projectId',null,'version',1,'members',jsonb_build_array(
    jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001'),
    jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031')))::text;
  -- Same room projection fixture as the original wake acceptance.
  perform public.qorpera_project_organization_document(jsonb_build_object('companyId',v_base.profile_id,
   'environmentId',v_base.environment_id,'userId',v_base.requested_by_user_id,'audience','human'),
   jsonb_build_object('path',v_path,'entry',pg_temp.path_stage_file(v_path,v_doc)),v_doc,v_base.company_snapshot_id,extensions.gen_random_uuid());
  perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
  r:=public.qorpera_post_company_room_message(v_room,extensions.gen_random_uuid(),
   '{"schema":"qorpera.session-prompt/v1","text":"Review this work."}',v_base.sponsor_binding_id,v_base.sponsor_version);
  perform pg_temp.path_claims('service_role');
  w:=(r#>>'{occurrenceIds,0}')::uuid;
 else raise exception 'Unknown test wake'; end if;
 perform public.qorpera_materialize_wake_execution_runs(1);
 select run_id into strict v_run from public.qorpera_wake_occurrences where id=w;
 return pg_temp.wake_start(v_run);
end $$;

create function pg_temp.review2_change_authority(p_kind text)
returns void language plpgsql as $$
declare v_version public.qorpera_cloud_routine_versions%rowtype; v_client uuid; v_connection uuid;
begin
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 if p_kind='routine' then
  select * into strict v_version from public.qorpera_cloud_routine_versions
  where routine_id=(current_setting('qorpera_test.review2_routine')::jsonb->>'routine_id')::uuid and version=1;
  select client_routine_id into strict v_client from public.qorpera_cloud_routines where id=v_version.routine_id;
  perform public.qorpera_upsert_cloud_routine(v_version.environment_id,v_client,extensions.gen_random_uuid(),v_version.staff_agent_id,
   v_version.title,v_version.prompt,v_version.triggers,v_version.effort,v_version.sponsor_binding_id,v_version.sponsor_version,
   v_version.logical_computer_id,v_version.required_capability,v_version.job_type,false,v_version.publication_mode,
   v_version.review_policy_key,v_version.reviewer_staff_ids);
 else
  -- An agent's run is paid by the member who started its chain, not by a standing authority
  -- (20260928230000): that member withdrawing agent work on the login paying for it now is the change.
  select sponsor.provider_connection_id into strict v_connection
  from public.qorpera_execution_runs as run join public.qorpera_execution_sponsor_versions as sponsor
   on sponsor.binding_id=run.sponsor_binding_id and sponsor.version=run.sponsor_version
  where run.id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
  perform public.qorpera_consent_provider_connection_autonomous('30000000-0000-4000-8000-000000000010',v_connection,false);
 end if;
 perform pg_temp.path_claims('service_role');
end $$;

create function pg_temp.review2_handoff(p_kind text,p_revoke boolean default false,p_repeat boolean default false)
returns void language plpgsql as $$
declare b jsonb; v_first jsonb; c jsonb; v_plan jsonb; v_result jsonb; v_old jsonb; v_context jsonb; i integer;
begin
 b:=pg_temp.review2_start(p_kind);
 perform set_config('qorpera_test.wake_binding',b::text,true);
 perform pg_temp.wake_assert(public.qorpera_read_native_wake(b)->>'kind'=p_kind,'Initial wake kind');
 perform pg_temp.handoff_begin(b,repeat('c',64));
 if p_kind in ('human','first-run') then perform pg_temp.wake_public_send(b,'progress'); end if;
 v_plan:=pg_temp.path_plan('review2-before-quota','review2-before.md',pg_temp.path_stage_file('review2-before.md','Completed once'));
 v_result:=pg_temp.path_commit(v_plan);
 select to_jsonb(receipt) into strict v_old from public.qorpera_run_operation_receipts receipt where id=(v_result->>'receiptId')::uuid;
 for i in 1..case when p_repeat then 2 else 1 end loop
  c:=pg_temp.handoff_connection();
  perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
  perform public.qorpera_consent_provider_connection_autonomous('30000000-0000-4000-8000-000000000010',(c->>'connection_id')::uuid,true);
  perform pg_temp.path_claims('service_role');
  v_first:=b;
  perform public.qorpera_record_provider_usage_signal(b,'usage_limit',clock_timestamp()+interval '2 hours');
  perform pg_temp.wake_assert((public.qorpera_record_provider_usage_signal(b,'usage_limit',clock_timestamp()+interval '2 hours')->>'replayed')::boolean,
   'Signal retry deduplicates within the current sponsor version');
  perform pg_temp.wake_assert((select count(*)=i from public.qorpera_provider_connection_usage_signals where run_id=(b->>'runId')::uuid),
   'Each exhausted sponsor retains its own signal');
  -- The failure report no longer hands off (20260928349910): call the handoff function directly.
  perform public.qorpera_handoff_run_sponsor((b->>'runId')::uuid,'Native harness failed (provider allowance unavailable)');
  perform pg_temp.wake_assert((select j.status='queued' and r.sponsor_version=i+1 from public.qorpera_execution_runs r
   join public.qorpera_runner_jobs j on j.id=r.job_id where r.id=(b->>'runId')::uuid),'Handoff queues the same logical run');
  b:=pg_temp.wake_start((b->>'runId')::uuid);
  perform set_config('qorpera_test.wake_binding',b::text,true);
  perform pg_temp.wake_assert(b->>'assignmentId'<>v_first->>'assignmentId','Fresh assignment');
  perform pg_temp.wake_assert(public.qorpera_read_native_wake(b)->>'kind'=p_kind,'Replacement retains wake policy');
  v_context:=public.qorpera_describe_company_run_context(b);
  perform pg_temp.wake_assert(v_context->'continuation' is not null,'Replacement has confirmed-work context');
  perform pg_temp.handoff_begin(b,repeat('d',64));
  perform pg_temp.wake_assert(pg_temp.path_commit(v_plan)=v_result,'Receipt replay returns the original effect');
  perform pg_temp.wake_assert((select to_jsonb(receipt)=v_old from public.qorpera_run_operation_receipts receipt
   where id=(v_result->>'receiptId')::uuid),'Original receipt stays immutable');
 end loop;
 if p_revoke then
  perform pg_temp.review2_change_authority(p_kind);
  perform pg_temp.wake_error(format('select public.qorpera_describe_company_run_context(%L)',b),'42501');
  perform pg_temp.wake_error(format('select pg_temp.path_commit(%L)',v_plan),'42501');
  perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',b),'42501');
 else
  perform pg_temp.path_commit(pg_temp.path_plan('review2-unfinished','review2-after.md',pg_temp.path_stage_file('review2-after.md','New work')));
  if p_kind<>'agent' then perform pg_temp.wake_public_send(b,'final'); end if;
  perform pg_temp.wake_acceptance_finish(b);
  perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_company_path_revisions where receipt_id=(v_result->>'receiptId')::uuid),'No duplicate effect');
 end if;
end $$;
select pg_temp.wake_acceptance_case('human_confirmed_work_handoff',$q$select pg_temp.review2_handoff('human')$q$);
select pg_temp.wake_acceptance_case('first_run_confirmed_work_handoff',$q$select pg_temp.review2_handoff('first-run')$q$);
select pg_temp.wake_acceptance_case('routine_confirmed_work_handoff',$q$select pg_temp.review2_handoff('routine')$q$);
select pg_temp.wake_acceptance_case('agent_confirmed_work_handoff',$q$select pg_temp.review2_handoff('agent')$q$);
select pg_temp.wake_acceptance_case('room_confirmed_work_handoff',$q$select pg_temp.review2_handoff('room')$q$);
select pg_temp.wake_acceptance_case('routine_two_recorded_handoffs',$q$select pg_temp.review2_handoff('routine',false,true)$q$);
select pg_temp.wake_acceptance_case('agent_two_recorded_handoffs',$q$select pg_temp.review2_handoff('agent',false,true)$q$);
select pg_temp.wake_acceptance_case('routine_pause_after_handoff_fences_effects',$q$select pg_temp.review2_handoff('routine',true)$q$);
select pg_temp.wake_acceptance_case('agent_authority_change_after_handoff_fences_effects',$q$select pg_temp.review2_handoff('agent',true)$q$);

create function pg_temp.review2_revocation(p_kind text)
returns void language plpgsql as $$
declare b jsonb; v_plan jsonb;
begin
 b:=pg_temp.review2_start(p_kind);
 perform set_config('qorpera_test.wake_binding',b::text,true);
 perform public.qorpera_read_native_wake(b);
 perform pg_temp.handoff_begin(b,repeat('c',64));
 v_plan:=pg_temp.path_plan('revoked-work','review2-blocked.md',pg_temp.path_stage_file('review2-blocked.md','Must not publish'));
 perform pg_temp.review2_change_authority(p_kind);
 perform pg_temp.wake_error(format('select public.qorpera_read_native_wake(%L)',b),'42501');
 perform pg_temp.wake_error(format('select pg_temp.path_commit(%L)',v_plan),'42501');
 perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,''revoked-send'',''Must not deliver'')',b,
  '30000000-0000-4000-8000-000000000032'),'42501');
 if p_kind='routine' then perform pg_temp.wake_error(format('select pg_temp.wake_public_send(%L,''final'')',b),'42501'); end if;
 perform pg_temp.wake_error(format('select pg_temp.wake_acceptance_finish(%L)',b),'42501');
 perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_company_path_revisions where run_id=(b->>'runId')::uuid),'Denied effect creates no revision');
end $$;
select pg_temp.wake_acceptance_case('routine_pause_after_context_fences_all_effects',$q$select pg_temp.review2_revocation('routine')$q$);
select pg_temp.wake_acceptance_case('agent_authority_change_after_context_fences_all_effects',$q$select pg_temp.review2_revocation('agent')$q$);
