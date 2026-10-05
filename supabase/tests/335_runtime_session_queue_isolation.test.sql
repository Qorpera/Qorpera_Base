begin;

-- All identities and credentials below are disposable fixtures. No provider is invoked.
create function pg_temp.queue_id(p_company integer, p_item integer) returns uuid
language sql immutable as $$
 select (lpad(p_company::text, 3, '0') || '00000-0000-4000-8000-' || lpad(p_item::text, 12, '0'))::uuid
$$;
create function pg_temp.queue_auth(p_user uuid default null) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claims', case when p_user is null then '{"role":"service_role"}'
  else jsonb_build_object('role','authenticated','sub',p_user)::text end, true);
end $$;
-- LEGACY, for A1's removal sweep (after P06): P28 (20260930018000) took the legacy materializers out of the reconcile
-- RPC, and so out of the claim. These snapshot-v1 cases call them here, in the old order, until the sweep removes the
-- materializers and this test. Every call site is `pg_temp.queue_legacy_materialize()`.
create function pg_temp.queue_legacy_materialize() returns void language plpgsql as $$
begin
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_turn_requests(32);
 perform public.qorpera_materialize_session_execution_runs(32);
 perform public.qorpera_materialize_wake_execution_runs(32);
 perform public.qorpera_materialize_company_proposal_review_runs(32);
end $$;
create function pg_temp.queue_assert(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
 if p_ok is distinct from true then raise exception '%', p_message; end if;
end $$;
create function pg_temp.queue_company(p_company integer) returns jsonb language plpgsql as $$
declare
 p uuid := pg_temp.queue_id(p_company,10); o uuid := pg_temp.queue_id(p_company,1);
 m uuid := pg_temp.queue_id(p_company,2); e uuid := pg_temp.queue_id(p_company,20);
 w uuid := pg_temp.queue_id(p_company,30); snap uuid := pg_temp.queue_id(p_company,40);
 staff uuid := pg_temp.queue_id(p_company,54); s uuid := pg_temp.queue_id(p_company,55);
 priv uuid := pg_temp.queue_id(p_company,56); connection jsonb; sponsor jsonb;
 personal jsonb; identity jsonb; member_sponsor jsonb; member_identity jsonb;
 policy jsonb := '{"monthly_microusd":100000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}';
begin
 insert into auth.users(id,email) values(o,o::text||'@example.test'),(m,m::text||'@example.test');
 insert into public.qorpera_profiles(id,name,created_by_user_id) values(p,'Queue regression',o);
 insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
 values(p,o,o::text||'@example.test','Owner','owner'),(p,m,m::text||'@example.test','Member','contributor');
 perform pg_temp.queue_auth(o);
 insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
 values(e,p,'Queue environment',1,o);
 insert into public.qorpera_company_workspaces(id,profile_id,environment_id,client_workspace_id,name,created_by_user_id)
 values(w,p,e,w,'Queue workspace',o);
 insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
  tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
 values(snap,p,e,w,snap,repeat('a',64),2,3,0,0,o);
 insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,
  contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id)
 values(pg_temp.queue_id(p_company,50),p,e,snap,pg_temp.queue_id(p_company,50),1,0,0,repeat('b',64),o);
 update public.qorpera_company_files set canonical_workspace_id=w,head_snapshot_id=snap,state='ready',logical_bytes=0
 where environment_id=e;
 insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,
  appearance_shape,employment_status,lifecycle_state,model_provider,model_id,updated_by_user_id,created_at,updated_at)
 values(p,staff,'Queue operator','Operations','Execute queued work.','blue','round','active','active','openai','gpt-test',o,
  statement_timestamp(),statement_timestamp());
 insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
  created_by_user_id,company_snapshot_id,staff_agent_id,staff_version,execution_scope,audience_kind,audience_user_id)
 values(s,s,p,e,'Company queue','open',o,snap,staff,1,'{}','company',null),
  (priv,priv,p,e,'Private queue','open',m,snap,staff,1,'{}','member_private',m);
 connection := public.qorpera_register_provider_connection(p,pg_temp.queue_id(p_company,60),null,
  'openai','api_key','openai-responses','vault://queue/company','queue-company','queue-budget',
  'qorpera-provider-consent/v1',null,policy,true);
 sponsor := public.qorpera_create_execution_sponsor_binding(p,pg_temp.queue_id(p_company,61),
  'company_api_billing',(connection->>'connection_id')::uuid,1,true);
 perform public.qorpera_configure_staff_execution_authority(p,staff,(sponsor->>'binding_id')::uuid,1,null);
 perform public.qorpera_configure_session_execution(s,(sponsor->>'binding_id')::uuid,1,null,'agent_turn','agent_turn');
 perform public.qorpera_configure_session_execution(priv,(sponsor->>'binding_id')::uuid,1,null,'agent_turn','agent_turn');
 connection := public.qorpera_register_provider_connection(p,pg_temp.queue_id(p_company,62),o,
  'openai','api_key','openai-responses','vault://queue/personal','queue-personal','queue-personal-budget',
  'qorpera-provider-consent/v1',null,policy,false);
 personal := public.qorpera_create_execution_sponsor_binding(p,pg_temp.queue_id(p_company,63),
  'member_connection',(connection->>'connection_id')::uuid,1,false);
 identity := public.qorpera_upsert_member_compute_identity(p,pg_temp.queue_id(p_company,64),
  'Owner compute','qorpera-member-linux','v1','["agent_turn","company_substrate"]','{}');
 -- The member's own login: a member's turn is paid by that member (20260928230000).
 perform pg_temp.queue_auth(m);
 connection := public.qorpera_register_provider_connection(p,pg_temp.queue_id(p_company,65),m,
  'openai','api_key','openai-responses','vault://queue/member','queue-member','queue-member-budget',
  'qorpera-provider-consent/v1',null,policy,false);
 member_sponsor := public.qorpera_create_member_execution_sponsor(p,pg_temp.queue_id(p_company,66),
  (connection->>'connection_id')::uuid,1,false);
 member_identity := public.qorpera_upsert_member_compute_identity(p,pg_temp.queue_id(p_company,67),
  'Member compute','qorpera-member-linux','v1','["agent_turn","company_substrate"]','{}');
 perform pg_temp.queue_auth(o);
 return jsonb_build_object('profile',p,'owner',o,'member',m,'session',s,'privateSession',priv,'staff',staff,
  'sponsor',sponsor->>'binding_id','personalSponsor',personal->>'binding_id','identity',identity->>'compute_identity_id',
  'memberSponsor',member_sponsor->>'binding_id','memberIdentity',member_identity->>'compute_identity_id');
end $$;
create function pg_temp.queue_input(p_company jsonb, p_owner boolean default false, p_private boolean default false,
 p_client uuid default extensions.gen_random_uuid()) returns uuid language plpgsql as $$
declare result jsonb;
begin
 perform pg_temp.queue_auth((p_company->>case when p_owner then 'owner' else 'member' end)::uuid);
 result := public.qorpera_append_session_input((p_company->>case when p_private then 'privateSession' else 'session' end)::uuid,
  p_client,'user_message','{"schema":"qorpera.session-prompt/v1","text":"Queue regression","images":[]}');
 return (result->>'input_id')::uuid;
end $$;
-- The member's own turn with review publication. Until 20260928230000 this was a turn the owner
-- was asked to pay for; a member's turn is now paid by that member.
create function pg_temp.queue_request(p_company jsonb,
 p_client uuid default extensions.gen_random_uuid(), p_request uuid default extensions.gen_random_uuid())
returns jsonb language plpgsql as $$
begin
 perform pg_temp.queue_auth((p_company->>'member')::uuid);
 return public.qorpera_request_session_turn_v2((p_company->>'session')::uuid,p_client,p_request,
  '{"schema":"qorpera.session-prompt/v1","text":"Queue regression","images":[]}',
  'member_connection',(p_company->>'memberSponsor')::uuid,1,null,(p_company->>'memberIdentity')::uuid,null,
  'managed_sandbox','agent_turn','agent_turn','review','queue-review',array[(p_company->>'staff')::uuid]);
end $$;
select set_config('queue.a',pg_temp.queue_company(335)::text,true);
select set_config('queue.b',pg_temp.queue_company(336)::text,true);
select pg_temp.queue_auth();
-- This deployment runs API-billed company accounts, so they may pay when a starter's login cannot.
select public.qorpera_set_provider_execution_policy('openai','api_key','openai-responses','supported','enabled',8,null,
 'API-billed fixture');
select public.qorpera_register_runner_orchestrator(pg_temp.queue_id(335,90),'Queue regression','process',repeat('c',64),86400);
create function pg_temp.native_sponsor(p_company jsonb) returns jsonb language plpgsql as $$
declare login jsonb; connection jsonb; sponsor jsonb; capsule uuid:=extensions.gen_random_uuid();
begin
 perform pg_temp.queue_auth();
 perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
  'supported','enabled',8,null,'production review fixture');
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 login:=public.qorpera_begin_native_provider_login((p_company->>'profile')::uuid,extensions.gen_random_uuid(),
  extensions.gen_random_uuid(),(p_company->>'identity')::uuid,'openai','codex-cli',repeat('d',64),900);
 execute 'reset role';
 perform pg_temp.queue_auth();
 execute 'set local role service_role';
 connection:=public.qorpera_complete_native_provider_login((login->>'login_id')::uuid,repeat('d',64),capsule,
  'object://native-capsules/'||capsule::text,repeat('e',64),'review-native-account','personal_subscription',
  'qorpera-native-subscription-v1',
  '{"monthly_microusd":1,"reservation_microusd":1,"max_calls_per_run":128,"max_input_tokens_per_run":100000000,"max_output_tokens_per_run":100000000,"max_concurrent_runs":8}');
 execute 'reset role';
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 perform public.qorpera_consent_provider_connection_autonomous((p_company->>'profile')::uuid,(connection->>'connection_id')::uuid,true);
 sponsor:=public.qorpera_create_member_execution_sponsor((p_company->>'profile')::uuid,extensions.gen_random_uuid(),
  (connection->>'connection_id')::uuid,2,true);
 execute 'reset role';
 return sponsor;
end $$;

create function pg_temp.queue_review(p_company jsonb, p_native boolean default false,
 p_sponsor uuid default null, p_computer uuid default null) returns uuid language plpgsql as $$
declare sponsor jsonb; origin public.qorpera_execution_runs%rowtype; proposed uuid:=extensions.gen_random_uuid();
 proposal uuid:=extensions.gen_random_uuid(); reviewer uuid:=extensions.gen_random_uuid();
begin
 perform pg_temp.queue_input(p_company,true);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_execution_runs(32);
 select * into strict origin from public.qorpera_execution_runs where profile_id=(p_company->>'profile')::uuid;
 sponsor:=case when p_native then pg_temp.native_sponsor(p_company)
  else jsonb_build_object('binding_id',coalesce(p_sponsor,(p_company->>'sponsor')::uuid),'version',1) end;
 insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,
  appearance_shape,employment_status,lifecycle_state,model_provider,model_id,updated_by_user_id,created_at,updated_at)
 values(origin.profile_id,reviewer,'Queue reviewer','Reviewer','Review proposed work.','blue','round','active','active',
  'openai','gpt-test',(p_company->>'owner')::uuid,statement_timestamp(),statement_timestamp());
 -- A standing authority names a company account only (20260928230000); a native review is
 -- paid by the member who started the change, through their own login (set below).
 if not p_native then
  perform pg_temp.queue_auth((p_company->>'owner')::uuid);
  execute 'set local role authenticated';
  perform public.qorpera_configure_staff_execution_authority(origin.profile_id,reviewer,
   (sponsor->>'binding_id')::uuid,1,p_computer);
  execute 'reset role';
 end if;
 insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
  tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
 values(proposed,origin.profile_id,origin.environment_id,
  (select workspace_id from public.qorpera_company_snapshots where id=origin.company_snapshot_id),proposed,
  repeat('f',64),2,3,0,0,(p_company->>'owner')::uuid);
 insert into public.qorpera_company_proposals(id,profile_id,environment_id,client_proposal_id,base_snapshot_id,
  proposal_snapshot_id,execution_kind,execution_id,execution_claimant_id,session_id,trail_end_sequence,
  reason,policy_key,title,reviewer_staff_ids,created_by_user_id)
 values(proposal,origin.profile_id,origin.environment_id,proposal,origin.company_snapshot_id,proposed,
  'run',origin.id,extensions.gen_random_uuid(),origin.session_id,0,'policy','queue-review','Review fixture',
  array[reviewer],(p_company->>'owner')::uuid);
 -- A native review follows a change made on the owner's own login (20260930059000: a review stays on the login of
 -- the run whose change it reviews). This fixture's change ran on the company account, so the review's payer is set
 -- to the owner's login here.
 if p_native then
  update public.qorpera_company_proposal_review_assignments set reviewer_sponsor_binding_id=(sponsor->>'binding_id')::uuid,
   reviewer_sponsor_version=(sponsor->>'version')::bigint where proposal_id=proposal;
 end if;
 return proposal;
end $$;
create function pg_temp.queue_claim_healthy() returns void language plpgsql as $$
declare b jsonb:=current_setting('queue.b')::jsonb; i integer;
begin
 perform pg_temp.queue_input(b);
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 execute 'set local role service_role';
 for i in 1..3 loop
  perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),extensions.gen_random_uuid(),300);
 end loop;
 execute 'reset role';
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims claim
  join public.qorpera_runner_jobs job on job.id=claim.job_id where job.profile_id=(b->>'profile')::uuid),
  'unrelated company could not be claimed');
end $$;
create function pg_temp.recovery_native_sponsor(p_company jsonb) returns jsonb language plpgsql as $$
declare login jsonb; connection jsonb; sponsor jsonb; capsule uuid:=extensions.gen_random_uuid(); authority uuid:=extensions.gen_random_uuid(); target uuid:=extensions.gen_random_uuid();
begin
 insert into public.qorpera_identity_recovery_authorities(id,profile_id,signing_public_key,wrapping_public_key,service_origin,capability_sha256)
 values(authority,(p_company->>'profile')::uuid,repeat('A',59),repeat('A',550),'https://recovery.example.test',repeat('c',64));
 perform pg_temp.queue_auth();
 perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
  'supported','enabled',8,null,'production review fixture');
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 login:=public.qorpera_begin_native_provider_login((p_company->>'profile')::uuid,extensions.gen_random_uuid(),
  extensions.gen_random_uuid(),(p_company->>'identity')::uuid,'openai','codex-cli',repeat('d',64),900);
 execute 'reset role';
 perform pg_temp.queue_auth();
 execute 'set local role service_role';
 perform public.qorpera_prepare_identity_key_backup(authority,repeat('c',64),(login->>'login_id')::uuid,repeat('d',64),repeat('a',64));
 perform public.qorpera_complete_identity_key_backup(authority,repeat('c',64),(login->>'login_id')::uuid,repeat('d',64),repeat('a',64),1,repeat('b',64),1024);
 perform public.qorpera_register_identity_recovery_target(authority,repeat('c',64),target,
  (p_company->>'identity')::uuid,extensions.gen_random_uuid(),repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64));
 connection:=public.qorpera_complete_native_provider_login((login->>'login_id')::uuid,repeat('d',64),capsule,
  'object://native-capsules/'||capsule::text,repeat('e',64),'review-native-account','personal_subscription',
  'qorpera-native-subscription-v1',
  '{"monthly_microusd":1,"reservation_microusd":1,"max_calls_per_run":128,"max_input_tokens_per_run":100000000,"max_output_tokens_per_run":100000000,"max_concurrent_runs":8}');
 execute 'reset role';
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 perform public.qorpera_consent_provider_connection_autonomous((p_company->>'profile')::uuid,(connection->>'connection_id')::uuid,true);
 sponsor:=public.qorpera_create_member_execution_sponsor((p_company->>'profile')::uuid,extensions.gen_random_uuid(),
  (connection->>'connection_id')::uuid,2,true);
 execute 'reset role';
 return sponsor||jsonb_build_object('target',target,'authority',authority);
end $$;



create function pg_temp.queue_recovery_work(p_company jsonb,p_lane text) returns jsonb language plpgsql as $$
declare sponsor jsonb:=pg_temp.recovery_native_sponsor(p_company); request jsonb; routine jsonb;
 cursor public.qorpera_cloud_routine_schedule_cursors%rowtype; input uuid; wake uuid; environment uuid;
begin
 select environment_id into strict environment from public.qorpera_shared_sessions where id=(p_company->>'session')::uuid;
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 if p_lane='ordinary' then
  perform public.qorpera_configure_session_execution((p_company->>'session')::uuid,(sponsor->>'binding_id')::uuid,
   1,null,'agent_turn','agent_turn');
 elsif p_lane='sponsored' then
  request:=public.qorpera_request_session_turn_v2((p_company->>'session')::uuid,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
   '{"schema":"qorpera.session-prompt/v1","text":"Recovery regression","images":[]}',
   'member_connection',(sponsor->>'binding_id')::uuid,1,null,(p_company->>'identity')::uuid,null,
   'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}');
  input:=(request->>'input_id')::uuid;
 elsif p_lane='wake' then
  routine:=public.qorpera_upsert_cloud_routine(environment,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
   (p_company->>'staff')::uuid,'Recovery wake','Check recovery.',
   '[{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}]',
   'low',(sponsor->>'binding_id')::uuid,1,null,'agent_turn','agent_turn',true,'automatic',null,'{}');
 else raise exception 'Unknown recovery lane'; end if;
 execute 'reset role';
 -- The owner writes: the owner's login pays only for the owner's messages (20260928230000).
 if p_lane='ordinary' then input:=pg_temp.queue_input(p_company,true); end if;
 if p_lane='wake' then
  select * into strict cursor from public.qorpera_cloud_routine_schedule_cursors where routine_id=(routine->>'routine_id')::uuid;
  wake:=extensions.gen_random_uuid();
  perform pg_temp.queue_auth();
  execute 'set local role service_role';
  perform public.qorpera_enqueue_routine_wake(cursor.routine_id,cursor.routine_version,wake,'recovery-tick',cursor.trigger_id,
   statement_timestamp()-interval '5 minutes',cursor.last_scheduled_for,statement_timestamp(),'{}');
  execute 'reset role';
 end if;
 return p_company||jsonb_build_object('binding',sponsor->>'binding_id','authority',sponsor->>'authority',
  'target',sponsor->>'target','input',input,'request',request->>'turn_request_id','wake',wake,'lane',p_lane);
end $$;
create function pg_temp.queue_begin_recovery(p_work jsonb) returns jsonb language plpgsql as $$
declare result jsonb;
begin
 perform pg_temp.queue_auth((p_work->>'owner')::uuid);
 execute 'set local role authenticated';
 result:=public.qorpera_request_identity_recovery((p_work->>'identity')::uuid,(p_work->>'target')::uuid,
  extensions.gen_random_uuid(),1,repeat('b',64),'nas');
 execute 'reset role';
 return result;
end $$;
create function pg_temp.queue_finish_recovery(p_work jsonb,p_recovery jsonb) returns void language plpgsql as $$
begin
 -- Advance only the disposable not-before clock; admission and completion
 -- still use the actual recovery service RPCs and all generation guards.
 update public.qorpera_identity_recoveries set not_before=clock_timestamp()-interval '1 second'
  where id=(p_recovery->>'recoveryId')::uuid;
 perform pg_temp.queue_auth();
 execute 'set local role service_role';
 perform public.qorpera_prepare_identity_key_release((p_work->>'authority')::uuid,repeat('c',64),
  (p_recovery->>'recoveryId')::uuid,repeat('3',64));
 perform public.qorpera_commit_identity_key_release((p_work->>'authority')::uuid,repeat('c',64),
  (p_recovery->>'recoveryId')::uuid,repeat('3',64),repeat('4',64),1024);
 perform public.qorpera_complete_identity_recovery((p_work->>'authority')::uuid,repeat('c',64),
  (p_recovery->>'recoveryId')::uuid,repeat('3',64),repeat('4',64),repeat('5',64));
 execute 'reset role';
end $$;
-- Real admission RPCs with disposable session/routine scaffolding.
create function pg_temp.queue_more_work(p_work jsonb,p_lane text,p_same_session boolean default false) returns jsonb language plpgsql as $$
declare s uuid:=extensions.gen_random_uuid(); staff uuid:=extensions.gen_random_uuid(); result jsonb; routine jsonb;
 cursor public.qorpera_cloud_routine_schedule_cursors%rowtype; environment uuid; wake uuid:=extensions.gen_random_uuid();
begin
 select environment_id into strict environment from public.qorpera_shared_sessions where id=(p_work->>'session')::uuid;
 perform pg_temp.queue_auth((p_work->>'owner')::uuid);
 if p_lane in ('ordinary','sponsored') then
  if p_same_session then s:=(p_work->>'session')::uuid;
  else
   insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,
    employment_status,lifecycle_state,model_provider,model_id,updated_by_user_id,created_at,updated_at)
   select profile_id,staff,'Backlogged agent','Operations',charter,appearance_color,appearance_shape,
    employment_status,lifecycle_state,model_provider,model_id,updated_by_user_id,created_at,updated_at
   from public.qorpera_profile_staff where profile_id=(p_work->>'profile')::uuid and staff_agent_id=(p_work->>'staff')::uuid;
   insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
    created_by_user_id,company_snapshot_id,staff_agent_id,staff_version,execution_scope,audience_kind,audience_user_id)
   select s,s,profile_id,environment_id,'Backlogged session','open',created_by_user_id,
    company_snapshot_id,staff,1,execution_scope,audience_kind,audience_user_id
   from public.qorpera_shared_sessions where id=(p_work->>'session')::uuid;
   set local role authenticated;
   perform public.qorpera_configure_session_execution(s,(p_work->>'binding')::uuid,1,null,'agent_turn','agent_turn');
   reset role;
  end if;
  if p_lane='ordinary' then
   return p_work||jsonb_build_object('session',s,'input',pg_temp.queue_input(p_work||jsonb_build_object('session',s),true));
  end if;
  set local role authenticated;
  result:=public.qorpera_request_session_turn_v2(s,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
   '{"schema":"qorpera.session-prompt/v1","text":"Backlogged sponsored input","images":[]}',
   'member_connection',(p_work->>'binding')::uuid,1,null,(p_work->>'identity')::uuid,null,
   'managed_sandbox','agent_turn','agent_turn','automatic',null,'{}');
  reset role;
  return p_work||jsonb_build_object('session',s,'input',result->>'input_id','request',result->>'turn_request_id');
 end if;
 set local role authenticated;
 routine:=public.qorpera_upsert_cloud_routine(environment,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
  (p_work->>'staff')::uuid,'Backlogged wake','Check pending work.',
  '[{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}]',
  'low',(p_work->>'binding')::uuid,1,null,'agent_turn','agent_turn',true,'automatic',null,'{}');
 reset role;
 select * into strict cursor from public.qorpera_cloud_routine_schedule_cursors where routine_id=(routine->>'routine_id')::uuid;
 perform pg_temp.queue_auth();
 set local role service_role;
 perform public.qorpera_enqueue_routine_wake(cursor.routine_id,cursor.routine_version,wake,
  'backlog',cursor.trigger_id,statement_timestamp()-interval '5 minutes',cursor.last_scheduled_for,statement_timestamp(),'{}');
 reset role;
 return p_work||jsonb_build_object('wake',wake);
end $$;
create function pg_temp.queue_fair_setup(p_lane text,p_count integer) returns jsonb language plpgsql as $$
declare a jsonb:=current_setting('queue.a')::jsonb; b jsonb:=current_setting('queue.b')::jsonb;
 work jsonb; healthy jsonb; i integer; table_name text;
begin
 work:=pg_temp.queue_recovery_work(a,p_lane);
 for i in 2..p_count loop perform pg_temp.queue_more_work(work,p_lane); end loop;
 healthy:=pg_temp.queue_recovery_work(b,p_lane);
 table_name:=case p_lane when 'ordinary' then 'qorpera_session_execution_bindings'
  when 'sponsored' then 'qorpera_session_turn_requests' else 'qorpera_wake_occurrences' end;
 -- Set only operational queue order. All authority and wake identity pins
 -- remain those captured by the real admission RPCs.
 execute format('update public.%I set admission_scan_at=statement_timestamp()-interval ''1 hour'' where profile_id=$1',table_name)
  using (a->>'profile')::uuid;
 return jsonb_build_object('work',work,'healthy',healthy);
end $$;
create function pg_temp.queue_fair_case(p_lane text,p_count integer,p_limit integer) returns void language plpgsql as $$
declare fixture jsonb:=pg_temp.queue_fair_setup(p_lane,p_count); work jsonb:=fixture->'work'; healthy jsonb:=fixture->'healthy';
 recovery jsonb; original_inputs jsonb; original_wakes jsonb; original_requests jsonb;
 i integer; table_name text; materializer text; scanned bigint; scan_start timestamptz;
begin
 recovery:=pg_temp.queue_begin_recovery(work);
 perform pg_temp.queue_assert(recovery->>'status'='approved','recovery did not activate');
 select jsonb_agg(to_jsonb(input) order by input.id) into original_inputs from public.qorpera_session_inputs input
  join public.qorpera_shared_sessions session on session.id=input.session_id where session.profile_id=(work->>'profile')::uuid;
 select jsonb_agg(to_jsonb(wake)-array['blocked_reason','admission_scan_at'] order by wake.id) into original_wakes
  from public.qorpera_wake_occurrences wake where profile_id=(work->>'profile')::uuid;
 select jsonb_agg(to_jsonb(request)-'admission_scan_at' order by request.id) into original_requests
  from public.qorpera_session_turn_requests request where profile_id=(work->>'profile')::uuid;
 table_name:=case p_lane when 'ordinary' then 'qorpera_session_execution_bindings'
  when 'sponsored' then 'qorpera_session_turn_requests' else 'qorpera_wake_occurrences' end;
 materializer:=case p_lane when 'ordinary' then 'qorpera_materialize_session_execution_runs'
  when 'sponsored' then 'qorpera_materialize_session_turn_requests' else 'qorpera_materialize_wake_execution_runs' end;
 perform pg_temp.queue_auth();
 for i in 1..ceil((p_count+1)::numeric/p_limit)::integer loop
  scan_start:=clock_timestamp();
  set local role service_role;
  execute format('select public.%I($1)',materializer) using p_limit;
  reset role;
  execute format('select count(*) from public.%I where admission_scan_at >= $1',table_name) into scanned using scan_start;
  perform pg_temp.queue_assert(scanned between 1 and p_limit,'scan exceeded its candidate limit');
 end loop;
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_execution_runs where profile_id=(healthy->>'profile')::uuid),
  'healthy work starved behind recovering backlog');
 perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_execution_runs where profile_id=(work->>'profile')::uuid),
  'recovering work executed');
 perform pg_temp.queue_assert((select jsonb_agg(to_jsonb(input) order by input.id) is not distinct from original_inputs
  from public.qorpera_session_inputs input join public.qorpera_shared_sessions session on session.id=input.session_id
  where session.profile_id=(work->>'profile')::uuid),'rotation changed recovering inputs');
 perform pg_temp.queue_assert((select jsonb_agg(to_jsonb(wake)-array['blocked_reason','admission_scan_at'] order by wake.id)
  is not distinct from original_wakes from public.qorpera_wake_occurrences wake where profile_id=(work->>'profile')::uuid),
  'rotation changed recovering wake identity');
 perform pg_temp.queue_assert((select jsonb_agg(to_jsonb(request)-'admission_scan_at' order by request.id)
  is not distinct from original_requests from public.qorpera_session_turn_requests request where profile_id=(work->>'profile')::uuid),
  'rotation changed sponsorship pins');
 perform pg_temp.queue_legacy_materialize();
 set local role service_role;
 for i in 1..3 loop
  perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),extensions.gen_random_uuid(),300);
 end loop;
 reset role;
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims claim join public.qorpera_execution_runs run on run.id=claim.run_id
  where run.profile_id=(healthy->>'profile')::uuid),'healthy work did not reach exactly one actual claim');
end $$;

-- END QUEUE FIXTURE

create temporary table queue_results(name text primary key, passed boolean not null, error text);
create function pg_temp.queue_case(p_name text, p_body text) returns void language plpgsql as $$
declare v_error text;
begin
 begin
  execute p_body;
  raise exception using errcode='ZQ001',message='rollback successful case';
 exception when sqlstate 'ZQ001' then null;
 when others then v_error := sqlstate || ': ' || sqlerrm;
 end;
 insert into queue_results values(p_name,v_error is null,v_error);
end $$;

select pg_temp.queue_case('a member cannot ask another member to pay for a turn', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; rejected boolean := false;
begin
 perform pg_temp.queue_auth((a->>'member')::uuid);
 begin
  perform public.qorpera_request_session_turn_v2((a->>'session')::uuid,extensions.gen_random_uuid(),extensions.gen_random_uuid(),
   '{"schema":"qorpera.session-prompt/v1","text":"Queue regression","images":[]}',
   'sponsorship_request',null,null,(a->>'owner')::uuid,null,null,
   'managed_sandbox','agent_turn','agent_turn','review','queue-review',array[(a->>'staff')::uuid]);
 exception when invalid_parameter_value then rejected := true;
 end;
 perform pg_temp.queue_assert(rejected,'a member asked another member to pay for a turn');
 perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_session_turn_requests),'the refused request left a row');
end $body$;
$case$);

select pg_temp.queue_case('own request keeps sponsor compute and review pins exactly once', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; request jsonb;
begin
 request := pg_temp.queue_request(a);
 perform pg_temp.queue_auth();
 perform pg_temp.queue_assert(public.qorpera_materialize_session_execution_runs(32)='[]','ordinary materializer stole queued request');
 perform public.qorpera_materialize_session_turn_requests(32);
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_reconcile_runner_orchestrator(pg_temp.queue_id(335,90));
 perform pg_temp.queue_assert((select count(*)=1 and bool_and(id=(request->>'turn_request_id')::uuid
  and sponsor_binding_id=(a->>'memberSponsor')::uuid and sponsor_version=1
  and compute_identity_id=(a->>'memberIdentity')::uuid and requested_by_user_id=(a->>'member')::uuid
  and sponsored_by_user_id=(a->>'member')::uuid and publication_mode='review' and review_policy_key='queue-review'
  and reviewer_staff_ids=array[(a->>'staff')::uuid] and input_ids=array[(request->>'input_id')::uuid])
  from public.qorpera_execution_runs),'own request authority pins changed');
 perform pg_temp.queue_assert((select status='materialized' and run_id=id from public.qorpera_session_turn_requests
  where id=(request->>'turn_request_id')::uuid),'request not materialized');
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_wake_occurrences),'duplicate wake');
end $body$;
$case$);

select pg_temp.queue_case('terminal request inputs cannot reenter ordinary queue', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; request jsonb; terminal text;
begin
 foreach terminal in array array['failed','cancelled'] loop
  request := pg_temp.queue_request(a);
  update public.qorpera_session_turn_requests set status=terminal,
   failure_reason=case when terminal='failed' then 'Fixture terminal request' else null end
   where id=(request->>'turn_request_id')::uuid;
 end loop;
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_reconcile_runner_orchestrator(pg_temp.queue_id(335,90));
 perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_execution_runs),'terminal request was reclaimed');
end $body$;
$case$);

select pg_temp.queue_case('removed author is retired and another company can be claimed', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; b jsonb := current_setting('queue.b')::jsonb; input uuid;
begin
 input := pg_temp.queue_input(a);
 perform pg_temp.queue_input(b);
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_remove_profile_member((a->>'profile')::uuid,(a->>'member')::uuid);
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),pg_temp.queue_id(335,91),300);
 perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),pg_temp.queue_id(335,91),300);
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims c join public.qorpera_execution_runs r
  on r.id=c.run_id where r.profile_id=(b->>'profile')::uuid),'healthy company claim was blocked');
 perform pg_temp.queue_assert((select failed_at is not null and failure_reason='The input author no longer has session write access'
  and execution_run_id is null and author_user_id=(a->>'member')::uuid and body->>'text'='Queue regression'
  from public.qorpera_session_inputs where id=input),'stale input history or terminal state incorrect');
 perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_execution_runs where profile_id=(a->>'profile')::uuid),
  'removed author created a run');
end $body$;
$case$);

select pg_temp.queue_case('demoted author does not borrow owner authority', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; input uuid; good uuid;
begin
 input := pg_temp.queue_input(a);
 good := pg_temp.queue_input(a,true);
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_update_profile_member_role((a->>'profile')::uuid,(a->>'member')::uuid,'viewer');
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_execution_runs(32);
 perform public.qorpera_materialize_session_execution_runs(32);
 perform pg_temp.queue_assert((select failed_at is not null and execution_run_id is null from public.qorpera_session_inputs where id=input),
  'demoted author remained runnable');
 perform pg_temp.queue_assert((select count(*)=1 and bool_and(input_ids=array[good] and requested_by_user_id=(a->>'owner')::uuid)
  from public.qorpera_execution_runs),'next valid author did not progress');
end $body$;
$case$);

select pg_temp.queue_case('removed requester cannot block healthy company', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; b jsonb := current_setting('queue.b')::jsonb; request jsonb;
begin
 request := pg_temp.queue_request(a);
 perform pg_temp.queue_input(b);
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_remove_profile_member((a->>'profile')::uuid,(a->>'member')::uuid);
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),pg_temp.queue_id(335,91),300);
 perform pg_temp.queue_assert((select status='failed' and run_id is null from public.qorpera_session_turn_requests
  where id=(request->>'turn_request_id')::uuid),'removed requester was not retired');
 perform pg_temp.queue_assert((select failed_at is not null and execution_run_id is null from public.qorpera_session_inputs
  where id=(request->>'input_id')::uuid),'removed requester input was not retired');
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims),'healthy claim blocked');
end $body$;
$case$);

select pg_temp.queue_case('paused ordinary input survives and resumes without blocking others', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; b jsonb := current_setting('queue.b')::jsonb; input uuid;
begin
 input := pg_temp.queue_input(a);
 perform pg_temp.queue_input(b);
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_set_company_execution_pause((a->>'profile')::uuid,true,'Queue regression');
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),pg_temp.queue_id(335,91),300);
 perform pg_temp.queue_assert((select execution_run_id is null and failed_at is null from public.qorpera_session_inputs where id=input),
  'paused input changed');
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims),'paused company blocked healthy claim');
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_set_company_execution_pause((a->>'profile')::uuid,false,'Queue regression');
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_execution_runs(32);
 perform pg_temp.queue_assert((select execution_run_id is not null and failed_at is null from public.qorpera_session_inputs where id=input),
  'resumed input did not progress');
end $body$;
$case$);

select pg_temp.queue_case('paused request retains its pins until resume', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; request jsonb;
begin
 request := pg_temp.queue_request(a);
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_set_company_execution_pause((a->>'profile')::uuid,true,'Queue regression');
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_reconcile_runner_orchestrator(pg_temp.queue_id(335,90));
 perform pg_temp.queue_assert((select status='queued' and run_id is null from public.qorpera_session_turn_requests
  where id=(request->>'turn_request_id')::uuid),'pause consumed the request');
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_set_company_execution_pause((a->>'profile')::uuid,false,'Queue regression');
 perform pg_temp.queue_auth();
 perform pg_temp.queue_legacy_materialize();
 perform public.qorpera_reconcile_runner_orchestrator(pg_temp.queue_id(335,90));
 perform pg_temp.queue_assert((select publication_mode='review' and sponsor_binding_id=(a->>'memberSponsor')::uuid
  from public.qorpera_execution_runs where id=(request->>'turn_request_id')::uuid),'resume changed the request pins');
end $body$;
$case$);

select pg_temp.queue_case('private input uses its member and closes on removal', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; input uuid;
begin
 input := pg_temp.queue_input(a,false,true);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_execution_runs(32);
 perform pg_temp.queue_assert((select audience_kind='member_private' and audience_user_id=(a->>'member')::uuid
  and requested_by_user_id=(a->>'member')::uuid from public.qorpera_execution_runs where input=any(input_ids)),
  'private audience was widened');
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_remove_profile_member((a->>'profile')::uuid,(a->>'member')::uuid);
 perform pg_temp.queue_assert((select status='closed' from public.qorpera_shared_sessions where id=(a->>'privateSession')::uuid),
  'removed private session remained open');
end $body$;
$case$);

select pg_temp.queue_case('new request cannot adopt a claimed ordinary input', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; client uuid := extensions.gen_random_uuid(); rejected boolean := false;
begin
 perform pg_temp.queue_input(a,false,false,client);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_execution_runs(32);
 begin
  perform pg_temp.queue_request(a,client);
 exception when unique_violation then rejected := true;
 end;
 perform pg_temp.queue_assert(rejected,'claimed input gained a pending request');
 perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_session_turn_requests),'failed adoption left a request');
end $body$;
$case$);

select pg_temp.queue_case('existing request replay remains idempotent after materialization', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; client uuid := extensions.gen_random_uuid(); request_id uuid := extensions.gen_random_uuid(); first jsonb; replay jsonb;
begin
 first := pg_temp.queue_request(a,client,request_id);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_turn_requests(32);
 replay := pg_temp.queue_request(a,client,request_id);
 perform pg_temp.queue_assert(replay->>'turn_request_id'=first->>'turn_request_id' and replay->>'status'='materialized',
  'materialized request retry rejected');
end $body$;
$case$);

select pg_temp.queue_case('changed retry selection is rejected', $case$
do $body$
declare a jsonb := current_setting('queue.a')::jsonb; client uuid := extensions.gen_random_uuid(); request_id uuid := extensions.gen_random_uuid(); rejected boolean := false;
begin
 perform pg_temp.queue_request(a,client,request_id);
 perform pg_temp.queue_auth((a->>'member')::uuid);
 begin
  perform public.qorpera_request_session_turn_v2((a->>'session')::uuid,client,request_id,
   '{"schema":"qorpera.session-prompt/v1","text":"Queue regression","images":[]}',
   'member_connection',(a->>'memberSponsor')::uuid,1,null,(a->>'memberIdentity')::uuid,null,'company_computer',
   'agent_turn','agent_turn','review','queue-review',array[(a->>'staff')::uuid]);
 exception when unique_violation then rejected := true;
 end;
 perform pg_temp.queue_assert(rejected,'different original placement was silently accepted');
 perform pg_temp.queue_assert((select status='queued' and worker_class='managed_sandbox' and publication_mode='review'
  from public.qorpera_session_turn_requests where client_request_id=request_id),'retry changed the request');
end $body$;
$case$);


select pg_temp.queue_case('bundle activation and rollback preserve ordered homogeneous batches', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; original public.qorpera_active_runtime_bundle%rowtype;
 ids uuid[]:='{}'; i integer; run public.qorpera_execution_runs%rowtype; expected uuid[];
begin
 select * into strict original from public.qorpera_active_runtime_bundle where singleton;
 for i in 1..5 loop
  update public.qorpera_active_runtime_bundle active set runtime_bundle_id=bundle.id,runtime_bundle_sha256=bundle.sha256
  from public.qorpera_runtime_bundles bundle where active.singleton and bundle.version=case when i in(1,2,5) then 13 else 14 end;
  ids:=array_append(ids,pg_temp.queue_input(a));
 end loop;
 update public.qorpera_active_runtime_bundle set runtime_bundle_id=original.runtime_bundle_id,
  runtime_bundle_sha256=original.runtime_bundle_sha256 where singleton;
 perform pg_temp.queue_claim_healthy();
 for i in 1..3 loop
  perform pg_temp.queue_auth();
  perform public.qorpera_materialize_session_execution_runs(32);
  select r.* into strict run from public.qorpera_execution_runs r join public.qorpera_runner_jobs job on job.id=r.job_id
  where r.profile_id=(a->>'profile')::uuid and job.status='queued';
  expected:=case i when 1 then ids[1:2] when 2 then ids[3:4] else ids[5:5] end;
  perform pg_temp.queue_assert(run.input_ids=expected,'batch crossed a provenance boundary or reordered inputs');
  perform pg_temp.queue_assert((select bool_and(input.runtime_bundle_id=run.runtime_bundle_id
   and input.runtime_bundle_sha256=run.runtime_bundle_sha256) from public.qorpera_session_inputs input
   where input.id=any(expected)),'run relabeled an input bundle');
  perform public.qorpera_terminalize_runner_attempt(run.job_id,'failed','Boundary progression fixture',false);
 end loop;
 perform pg_temp.queue_assert((select array_agg(bundle.version order by input.position)=array[13,13,14,14,13]::bigint[]
  from public.qorpera_session_inputs input join public.qorpera_runtime_bundles bundle on bundle.id=input.runtime_bundle_id
  where input.id=any(ids)),'input history was relabeled');
end $body$;
$case$);

select pg_temp.queue_case('unsupported native review fails once without a job or global claim failure', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid; review public.qorpera_company_proposal_review_assignments%rowtype;
begin
 proposal:=pg_temp.queue_review(a,true);
 perform pg_temp.queue_claim_healthy();
 select * into strict review from public.qorpera_company_proposal_review_assignments where proposal_id=proposal;
 perform pg_temp.queue_assert(review.status='failed' and review.run_id is null and review.completed_at is not null
  and review.failure_reason='The selected reviewer runtime does not support proposal_review jobs',
  'unsupported review did not retain an actionable terminal failure');
 perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_execution_runs where source_kind='proposal_review'),
  'unsupported native job or reservation was created');
 perform pg_temp.queue_assert((select status='open' from public.qorpera_company_proposals where id=proposal),
  'unsupported runtime changed the proposal decision');
end $body$;
$case$);

select pg_temp.queue_case('API review retains exact assignment and continues to real orchestrator claim', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid;
begin
 proposal:=pg_temp.queue_review(a);
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select review.status='running' and run.source_kind='proposal_review'
  and run.sponsor_binding_id=review.reviewer_sponsor_binding_id and run.sponsor_version=review.reviewer_sponsor_version
  and run.staff_agent_id=review.reviewer_staff_agent_id and run.compute_identity_id is null
  and run.worker_class='managed_sandbox' and run.input_ids='{}'
  from public.qorpera_company_proposal_review_assignments review join public.qorpera_execution_runs run on run.id=review.run_id
  where review.proposal_id=proposal),'supported review did not preserve its authority');
 perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims claim
  join public.qorpera_company_proposal_review_assignments review on review.run_id=claim.run_id
  where review.proposal_id=proposal),'supported review was not claimable');
end $body$;
$case$);

select pg_temp.queue_case('review runtime rejects path gateway instead of creating an incompatible job', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid;
begin
 proposal:=pg_temp.queue_review(a);
 update public.qorpera_company_files set path_gateway_version=1,path_index_snapshot_id=head_snapshot_id
  where profile_id=(a->>'profile')::uuid;
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select status='failed' and run_id is null
  and failure_reason='The selected reviewer runtime does not support proposal_review jobs'
  from public.qorpera_company_proposal_review_assignments where proposal_id=proposal),'unsupported path runtime admitted');
end $body$;
$case$);

select pg_temp.queue_case('revoked reviewer connection cannot poison another company', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid; connection uuid;
begin
 proposal:=pg_temp.queue_review(a);
 select provider_connection_id into strict connection from public.qorpera_execution_sponsor_versions where binding_id=(a->>'sponsor')::uuid and version=1;
 update public.qorpera_provider_connections set status='revoked' where id=connection;
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select status='failed' and run_id is null
  and failure_reason='Reviewer sponsor or current autonomous consent is unavailable'
  from public.qorpera_company_proposal_review_assignments where proposal_id=proposal),'unavailable authority created a review run');
end $body$;
$case$);

select pg_temp.queue_case('withdrawn reviewer autonomous consent cannot poison another company', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid; connection uuid;
begin
 proposal:=pg_temp.queue_review(a,true);
 select sponsor.provider_connection_id into strict connection from public.qorpera_execution_sponsor_versions sponsor
  join public.qorpera_company_proposal_review_assignments review
  on review.reviewer_sponsor_binding_id=sponsor.binding_id and review.reviewer_sponsor_version=sponsor.version
  where review.proposal_id=proposal;
 perform pg_temp.queue_auth((a->>'owner')::uuid);
  perform public.qorpera_consent_provider_connection_autonomous((a->>'profile')::uuid,connection,false);
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select status='failed' and run_id is null
  and failure_reason='Reviewer sponsor or current autonomous consent is unavailable'
  from public.qorpera_company_proposal_review_assignments where proposal_id=proposal),'unavailable authority created a review run');
end $body$;
$case$);

select pg_temp.queue_case('paused review remains queued and resumes with exact pins', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid;
begin
 proposal:=pg_temp.queue_review(a);
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_set_company_execution_pause((a->>'profile')::uuid,true,'Review fixture');
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select status='queued' and run_id is null from public.qorpera_company_proposal_review_assignments
  where proposal_id=proposal),'paused review consumed');
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 perform public.qorpera_set_company_execution_pause((a->>'profile')::uuid,false,'Review fixture');
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_company_proposal_review_runs(32);
 perform pg_temp.queue_assert((select status='running' and run_id is not null from public.qorpera_company_proposal_review_assignments
  where proposal_id=proposal),'resumed review did not progress');
end $body$;
$case$);

select pg_temp.queue_case('review pins exact managed compute identity and recovery epoch', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid; identity jsonb; computer jsonb;
begin
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 identity:=public.qorpera_upsert_scoped_compute_identity((a->>'profile')::uuid,extensions.gen_random_uuid(),
  'company',null,'Review compute','qorpera-company-linux','v1','["agent_turn"]','{}');
 computer:=public.qorpera_upsert_logical_computer((a->>'profile')::uuid,extensions.gen_random_uuid(),
  'Review computer','qorpera-company-linux','v1','["agent_turn"]','{}');
 update public.qorpera_logical_computers set compute_identity_id=(identity->>'compute_identity_id')::uuid
  where id=(computer->>'logical_computer_id')::uuid;
 proposal:=pg_temp.queue_review(a,false,null,(computer->>'logical_computer_id')::uuid);
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select review.status='running'
  and run.compute_identity_id=(identity->>'compute_identity_id')::uuid
  and run.logical_computer_id=(computer->>'logical_computer_id')::uuid and run.worker_class='managed_sandbox'
  and run.compute_recovery_epoch=compute.recovery_epoch
  from public.qorpera_company_proposal_review_assignments review join public.qorpera_execution_runs run on run.id=review.run_id
  join public.qorpera_member_compute_identities compute on compute.id=run.compute_identity_id
  where review.proposal_id=proposal),'review compute provenance was not pinned');
end $body$;
$case$);

select pg_temp.queue_case('mismatched review compute ownership cannot abort global claims', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; proposal uuid; computer jsonb;
begin
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 computer:=public.qorpera_upsert_logical_computer((a->>'profile')::uuid,extensions.gen_random_uuid(),
  'Review computer','qorpera-member-linux','v1','["agent_turn"]','{}');
 update public.qorpera_logical_computers set compute_identity_id=(a->>'identity')::uuid
  where id=(computer->>'logical_computer_id')::uuid;
 proposal:=pg_temp.queue_review(a,false,null,(computer->>'logical_computer_id')::uuid);
 perform pg_temp.queue_claim_healthy();
 perform pg_temp.queue_assert((select status='failed' and run_id is null
  and failure_reason='Reviewer logical computer or compute identity is unavailable'
  from public.qorpera_company_proposal_review_assignments where proposal_id=proposal),'review borrowed another ownership scope');
end $body$;
$case$);


create function pg_temp.queue_recovery_case(p_lane text,p_action text) returns void language plpgsql as $$
declare a jsonb:=current_setting('queue.a')::jsonb; work jsonb; recovery jsonb; before_input jsonb; before_wake jsonb;
 run public.qorpera_execution_runs%rowtype; i integer;
begin
 work:=pg_temp.queue_recovery_work(a,p_lane);
 select to_jsonb(input) into before_input from public.qorpera_session_inputs input where id=(work->>'input')::uuid;
 select to_jsonb(wake)-array['blocked_reason','admission_scan_at'] into before_wake from public.qorpera_wake_occurrences wake where id=(work->>'wake')::uuid;
 if p_action<>'active' then
  recovery:=pg_temp.queue_begin_recovery(work);
  perform pg_temp.queue_assert(recovery->>'status'='approved','recovery did not activate');
  if p_action='cancelled' then
   perform pg_temp.queue_auth((a->>'owner')::uuid);
   perform public.qorpera_cancel_identity_recovery((recovery->>'recoveryId')::uuid);
  elsif p_action='expired' then
   update public.qorpera_identity_recoveries set expires_at=created_at+interval '1 millisecond',
    not_before=created_at where id=(recovery->>'recoveryId')::uuid;
  end if;
 end if;
 perform pg_temp.queue_claim_healthy();
 if p_action<>'active' then
  perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_execution_runs where profile_id=(a->>'profile')::uuid),
   'recovery created a run');
  perform pg_temp.queue_assert(not exists(select 1 from public.qorpera_runner_jobs where profile_id=(a->>'profile')::uuid),
   'recovery reserved a runner job');
  if before_input is not null then
   perform pg_temp.queue_assert((select to_jsonb(input)=before_input from public.qorpera_session_inputs input
    where id=(work->>'input')::uuid),'recovery consumed or changed queued input');
  end if;
  if before_wake is not null then
   perform pg_temp.queue_assert((select to_jsonb(wake)-array['blocked_reason','admission_scan_at']=before_wake and status='queued'
    and blocked_reason='Compute identity is unavailable or recovering'
    from public.qorpera_wake_occurrences wake where id=(work->>'wake')::uuid),'recovery changed wake pins or lost its reason');
  end if;
  if p_lane='sponsored' then
   perform pg_temp.queue_assert((select status='queued' and run_id is null and sponsor_binding_id=(work->>'binding')::uuid
    and compute_identity_id=(work->>'identity')::uuid from public.qorpera_session_turn_requests
    where id=(work->>'request')::uuid),'recovery changed sponsorship approval');
  end if;
 end if;
 if p_action='completed' then
  perform pg_temp.queue_finish_recovery(work,recovery);
  perform pg_temp.queue_auth();
  perform pg_temp.queue_legacy_materialize();
  for i in 1..3 loop
   perform public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),extensions.gen_random_uuid(),300);
  end loop;
 end if;
 if p_action in ('active','completed') then
  select * into strict run from public.qorpera_execution_runs where profile_id=(a->>'profile')::uuid;
  perform pg_temp.queue_assert(run.compute_identity_id=(work->>'identity')::uuid
   and run.sponsor_binding_id=(work->>'binding')::uuid and run.sponsor_version=1
   and run.compute_recovery_epoch=case when p_action='completed' then 1 else 0 end,
   'admission changed sponsor or recovery provenance');
  perform pg_temp.queue_assert((select count(*)=1 from public.qorpera_runner_job_claims where run_id=run.id),
   'admitted work did not reach a real claim exactly once');
  if before_input is not null then
   perform pg_temp.queue_assert(run.input_ids=array[(work->>'input')::uuid]
    and run.runtime_bundle_id=(before_input->>'runtime_bundle_id')::uuid
    and run.runtime_bundle_sha256=before_input->>'runtime_bundle_sha256','resumed input changed its bundle');
  else
   perform pg_temp.queue_assert((select status='materialized' and run_id=run.id and blocked_reason is null
    and to_jsonb(wake)-array['status','run_id','blocked_reason','admission_scan_at']=before_wake-array['status','run_id']
    from public.qorpera_wake_occurrences wake where id=(work->>'wake')::uuid),'resumed wake lost its identity');
  end if;
 end if;
end $$;
select pg_temp.queue_case('ordinary recovery active', 'select pg_temp.queue_recovery_case(''ordinary'',''active'')');
select pg_temp.queue_case('ordinary recovery pending', 'select pg_temp.queue_recovery_case(''ordinary'',''pending'')');
select pg_temp.queue_case('ordinary recovery cancelled', 'select pg_temp.queue_recovery_case(''ordinary'',''cancelled'')');
select pg_temp.queue_case('ordinary recovery expired', 'select pg_temp.queue_recovery_case(''ordinary'',''expired'')');
select pg_temp.queue_case('ordinary recovery completed', 'select pg_temp.queue_recovery_case(''ordinary'',''completed'')');
select pg_temp.queue_case('sponsored recovery active', 'select pg_temp.queue_recovery_case(''sponsored'',''active'')');
select pg_temp.queue_case('sponsored recovery pending', 'select pg_temp.queue_recovery_case(''sponsored'',''pending'')');
select pg_temp.queue_case('sponsored recovery cancelled', 'select pg_temp.queue_recovery_case(''sponsored'',''cancelled'')');
select pg_temp.queue_case('sponsored recovery expired', 'select pg_temp.queue_recovery_case(''sponsored'',''expired'')');
select pg_temp.queue_case('sponsored recovery completed', 'select pg_temp.queue_recovery_case(''sponsored'',''completed'')');
select pg_temp.queue_case('wake recovery active', 'select pg_temp.queue_recovery_case(''wake'',''active'')');
select pg_temp.queue_case('wake recovery pending', 'select pg_temp.queue_recovery_case(''wake'',''pending'')');
select pg_temp.queue_case('wake recovery cancelled', 'select pg_temp.queue_recovery_case(''wake'',''cancelled'')');
select pg_temp.queue_case('wake recovery expired', 'select pg_temp.queue_recovery_case(''wake'',''expired'')');
select pg_temp.queue_case('wake recovery completed', 'select pg_temp.queue_recovery_case(''wake'',''completed'')');
select pg_temp.queue_case('identity admission helper remains private', $case$
do $body$ declare role_name text; begin
 foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
  perform pg_temp.queue_assert(not has_function_privilege(role_name,
   'public.qorpera_try_lock_execution_identity(uuid,uuid)','EXECUTE'),'identity lock helper exposed to API role');
 end loop;
end $body$;
$case$);

select pg_temp.queue_case('sponsored rotation preserves the earlier eligible request', $case$
do $body$
declare a jsonb:=current_setting('queue.a')::jsonb; first jsonb; second jsonb; recovery jsonb; i integer;
begin
 first:=pg_temp.queue_recovery_work(a,'sponsored');
 second:=pg_temp.queue_more_work(first,'sponsored',true);
 update public.qorpera_session_turn_requests set created_at=statement_timestamp()-interval '1 hour'
  where id=(first->>'request')::uuid;
 recovery:=pg_temp.queue_begin_recovery(first);
 perform pg_temp.queue_auth();
 for i in 1..3 loop perform public.qorpera_materialize_session_turn_requests(1); end loop;
 perform pg_temp.queue_assert((select a.admission_scan_at>b.admission_scan_at and a.status='queued' and b.status='queued'
  from public.qorpera_session_turn_requests a,public.qorpera_session_turn_requests b
  where a.id=(first->>'request')::uuid and b.id=(second->>'request')::uuid),'later request overtook the recovering head');
 perform pg_temp.queue_finish_recovery(first,recovery);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_session_turn_requests(1);
 perform pg_temp.queue_assert((select count(*)=1 and bool_and(id=(first->>'request')::uuid and compute_recovery_epoch=1)
  from public.qorpera_execution_runs),'resumed sponsorship executed out of order');
 perform public.qorpera_terminalize_runner_attempt(job_id,'failed','FIFO progression fixture',false)
  from public.qorpera_execution_runs where id=(first->>'request')::uuid;
 perform public.qorpera_materialize_session_turn_requests(1);
 perform pg_temp.queue_assert((select status='materialized' and run_id=id from public.qorpera_session_turn_requests
  where id=(second->>'request')::uuid),'second request failed to progress after first');
end $body$;
$case$);

select pg_temp.queue_case('ordinary fair backlog 31 limit 32', 'select pg_temp.queue_fair_case(''ordinary'',31,32)');

select pg_temp.queue_case('ordinary fair backlog 32 limit 32', 'select pg_temp.queue_fair_case(''ordinary'',32,32)');

select pg_temp.queue_case('ordinary fair backlog 65 limit 32', 'select pg_temp.queue_fair_case(''ordinary'',65,32)');

select pg_temp.queue_case('ordinary fair backlog 5 limit 1', 'select pg_temp.queue_fair_case(''ordinary'',5,1)');

select pg_temp.queue_case('ordinary fair backlog 65 limit 64', 'select pg_temp.queue_fair_case(''ordinary'',65,64)');

select pg_temp.queue_case('sponsored fair backlog 31 limit 32', 'select pg_temp.queue_fair_case(''sponsored'',31,32)');

select pg_temp.queue_case('sponsored fair backlog 32 limit 32', 'select pg_temp.queue_fair_case(''sponsored'',32,32)');

select pg_temp.queue_case('sponsored fair backlog 65 limit 32', 'select pg_temp.queue_fair_case(''sponsored'',65,32)');

select pg_temp.queue_case('sponsored fair backlog 5 limit 1', 'select pg_temp.queue_fair_case(''sponsored'',5,1)');

select pg_temp.queue_case('sponsored fair backlog 65 limit 64', 'select pg_temp.queue_fair_case(''sponsored'',65,64)');

select pg_temp.queue_case('wake fair backlog 31 limit 32', 'select pg_temp.queue_fair_case(''wake'',31,32)');

select pg_temp.queue_case('wake fair backlog 32 limit 32', 'select pg_temp.queue_fair_case(''wake'',32,32)');

select pg_temp.queue_case('wake fair backlog 65 limit 32', 'select pg_temp.queue_fair_case(''wake'',65,32)');

select pg_temp.queue_case('wake fair backlog 5 limit 1', 'select pg_temp.queue_fair_case(''wake'',5,1)');

select pg_temp.queue_case('wake fair backlog 65 limit 64', 'select pg_temp.queue_fair_case(''wake'',65,64)');

select jsonb_build_object('cases',jsonb_agg(to_jsonb(result) order by name)) from queue_results result;
do $$ begin
 if exists(select 1 from queue_results where not passed) then
  raise exception 'queue regressions failed: %',(select jsonb_agg(to_jsonb(result)) from queue_results result where not passed);
 end if;
end $$;
rollback;
