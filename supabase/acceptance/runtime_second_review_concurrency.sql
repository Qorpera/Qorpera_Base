-- After fixture/helpers: prepare RPC arguments, then commit for independent
-- database connections. Every concurrent action uses a normal entrypoint.
create temp table review2_concurrent_schedule as
select pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
 '{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}') r from generate_series(1,4);
select set_config('qorpera_test.review2_concurrent_binding',pg_temp.review2_start('routine')::text,true);
select pg_temp.handoff_begin(current_setting('qorpera_test.review2_concurrent_binding')::jsonb,repeat('c',64));
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select public.qorpera_set_company_execution_ceiling('30000000-0000-4000-8000-000000000010',250000000,100000000,0,
 public.qorpera_company_wakes_last_hour('30000000-0000-4000-8000-000000000010')+1);
select pg_temp.path_claims('service_role');
select jsonb_build_object(
 'connection',(current_setting('qorpera_test.wake_connection')::jsonb->>'connection_id'),
 'schedule',(select jsonb_agg(format('select public.qorpera_enqueue_routine_wake(%L,1,%L,%L,''tick'',%L,null,%L,''{}'');',
  r->>'routine_id',extensions.gen_random_uuid(),'review2-concurrent-'||(r->>'routine_id'),clock_timestamp()-interval '5 minutes',clock_timestamp()))
  from review2_concurrent_schedule),
 'pause',(select format('select public.qorpera_upsert_cloud_routine(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,false,%L,%L,%L);',
  v.environment_id,r.client_routine_id,extensions.gen_random_uuid(),v.staff_agent_id,v.title,v.prompt,
  v.triggers,v.effort,v.sponsor_binding_id,v.sponsor_version,v.logical_computer_id,v.required_capability,
  v.job_type,v.publication_mode,v.review_policy_key,v.reviewer_staff_ids)
  from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id=v.routine_id
  where v.routine_id=(current_setting('qorpera_test.review2_routine')::jsonb->>'routine_id')::uuid and v.version=1),
 'effect',(select format('select public.qorpera_send_native_agent_message(%L,%L,%L,%L,%L,%L,%L,''openai'',''codex-cli'',''review2-effect'',''Completed governed work.'',''progress'');',
  b->>'leaseId',b->>'runId',b->>'jobId',b->>'runnerId',b->>'assignmentId',b->>'credentialCapsuleId',b->>'computeIdentityId')
  from (select current_setting('qorpera_test.review2_concurrent_binding')::jsonb b) binding)
);
commit;
