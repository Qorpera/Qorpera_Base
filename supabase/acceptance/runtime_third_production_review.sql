-- Review three: actual custody/admission RPCs in the disposable wake fixture.
-- Dummy ciphertext only; no provider or connector network request is made.
create function pg_temp.review3_broker(p_kind text,p_denial text default null)
returns void language plpgsql as $$
declare b jsonb:=pg_temp.review2_start(p_kind); v_run public.qorpera_execution_runs%rowtype;
 v_authority uuid:=extensions.gen_random_uuid(); v_ticket jsonb; v_grant jsonb; v_descriptor jsonb;
 v_receipt uuid:=extensions.gen_random_uuid(); v_cap text; v_envelope text; v_sha text; v_state text;
begin
 select * into strict v_run from public.qorpera_execution_runs where id=(b->>'runId')::uuid;
 perform set_config('qorpera_test.wake_binding',b::text,true);
 perform pg_temp.handoff_begin(b,repeat('c',64));
 if p_kind in ('human','first-run') then perform pg_temp.wake_public_send(b,'progress'); end if;
 insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
 values(v_authority,v_run.profile_id,'https://review-broker.example.test','review-key',repeat('a',64));
 insert into public.qorpera_cloud_connector_operations(connector_id,operation_id,version,tool_name,description,
  input_schema,destination_origin,credential_name,adapter_sha256)
 values('review_three','probe',1,'review_three_probe','Isolated review probe.',
  '{"type":"object","properties":{},"additionalProperties":false}','https://review-effect.example.test','token',repeat('b',64));
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 v_ticket:=public.qorpera_begin_cloud_secret_capture(v_run.profile_id,v_run.environment_id,
  'company',null,'review_three','probe','Review fixture');
 v_cap:=encode(extensions.digest(v_ticket->>'captureCapability','sha256'),'hex');
 v_envelope:=encode(extensions.gen_random_bytes(256),'base64');
 v_sha:=encode(extensions.digest(decode(v_envelope,'base64'),'sha256'),'hex');
 perform set_config('request.jwt.claims','{}',true);
 execute 'set local session authorization qorpera_secret_broker';
 v_descriptor:=public.qorpera_complete_cloud_secret_capture(v_authority,repeat('a',64),
  (v_ticket->>'ticketId')::uuid,v_cap,v_envelope,v_sha);
 execute 'reset session authorization';
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 -- Bundle v88: sealing a company connection already granted it to every agent.
 select jsonb_build_object('grantId',grant_row.id) into strict v_grant
 from public.qorpera_cloud_secret_operation_grants grant_row
 where grant_row.secret_id=(v_descriptor->>'secretId')::uuid and grant_row.staff_agent_id=v_run.staff_agent_id
  and grant_row.status='active';
 perform pg_temp.path_claims('service_role');
 perform public.qorpera_assert_native_connector_operation(b,(v_grant->>'grantId')::uuid,
  'review_three','probe',1,repeat('b',64),'https://review-effect.example.test');
 perform public.qorpera_begin_native_tool_operation(b,v_receipt,
  'review_three_probe:'||(v_grant->>'grantId')||':one',repeat('d',64),repeat('e',64),false);
 if p_denial='standing_authority' then
  perform pg_temp.review2_change_authority(p_kind);
 elsif p_denial='founder_stop' then
  perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
  perform public.qorpera_set_company_execution_pause(v_run.profile_id,true,'Test broker stop');
 elsif p_denial='consent' then
  perform pg_temp.review_consent(false);
 elsif p_denial='final' then
  perform pg_temp.wake_public_send(b,'final');
 elsif p_denial is not null then raise exception 'Unknown broker denial'; end if;
 perform set_config('request.jwt.claims','{}',true);
 execute 'set local session authorization qorpera_secret_broker';
 begin
  v_descriptor:=public.qorpera_authorize_cloud_secret_operation(v_authority,repeat('a',64),b,
   v_receipt,repeat('d',64),repeat('e',64),(v_grant->>'grantId')::uuid,
   'review_three','probe',1,repeat('b',64),'https://review-effect.example.test');
 exception when others then get stacked diagnostics v_state=RETURNED_SQLSTATE;
 end;
 execute 'reset session authorization';
 perform pg_temp.path_claims('service_role');
 if p_denial is null then
  perform pg_temp.wake_assert(v_state is null and v_descriptor->>'schema'='qorpera.cloud-secret-operation-authorization/v1',
   'Restricted broker authorizes the valid native wake without service claims');
  perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_cloud_secret_audit_events
   where receipt_id=v_receipt and event_type='effect_authorized'),'Successful authorization is audited once');
 else
  perform pg_temp.wake_assert(v_state in ('42501','55000'),'Revoked or stopped authority fences the broker');
  perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_cloud_secret_audit_events
   where receipt_id=v_receipt and event_type='effect_authorized'),'Denied broker operation emits no authorization');
 end if;
end $$;
select pg_temp.wake_acceptance_case('restricted_broker_authorizes_'||kind,
 format('select pg_temp.review3_broker(%L)',kind))
from unnest(array['human','first-run','routine','agent','room']) kind;
select pg_temp.wake_acceptance_case('restricted_broker_fences_'||kind||'_'||denial,
 format('select pg_temp.review3_broker(%L,%L)',kind,denial))
from (values('routine','standing_authority'),('agent','standing_authority'),
 ('routine','consent'),('human','founder_stop'),('human','final')) denial_cases(kind,denial);

select pg_temp.wake_acceptance_case('wake_policy_helper_is_private_and_broker_surface_stays_three',$q$
do $$ declare v_role text; begin
 foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
  perform pg_temp.wake_assert(not has_function_privilege(v_role,'public.qorpera_runtime_wake_policy_internal(uuid)','execute'),
   'Policy helper is not directly callable by an API role');
 end loop;
 -- Exact signatures (as 306): capture description, both capture completions
 -- (Step 7 label), operation authorization, and the coding repository
 -- credential (bundle v88).
 perform pg_temp.wake_assert((select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text collate "C")
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'qorpera_%'
  and has_function_privilege('qorpera_secret_broker',p.oid,'execute')) is not distinct from array[
  'qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)',
  'qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)',
  'qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)',
  'qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)',
  'qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)']::text[],'Broker still has exactly its fixed custody RPCs');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 perform pg_temp.wake_error(format('select public.qorpera_runtime_wake_policy(%L)',
  current_setting('qorpera_test.wake_binding')::jsonb->>'runId'),'42501','Wake policy authority is required');
end $$;
$q$);

create function pg_temp.review3_native_quota()
returns void language plpgsql as $$
declare v_login jsonb; v_connection jsonb; v_sponsor jsonb; v_routine jsonb; v_wakes uuid[]:='{}';
 v_capsule uuid:=extensions.gen_random_uuid(); v_connection_id uuid; i integer;
begin
 perform pg_temp.path_claims('service_role');
 perform public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
  'supported','enabled',64,null,'review3-native-concurrency');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 execute 'set local role authenticated';
 v_login:=public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010',
  extensions.gen_random_uuid(),extensions.gen_random_uuid(),
  (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,
  'openai','codex-cli',repeat('c',64),900);
 execute 'reset role';
 perform pg_temp.path_claims('service_role');
 execute 'set local role service_role';
 -- Keep these values equal to SupabaseNativeProviderControlPlane.completeLogin.
 v_connection:=public.qorpera_complete_native_provider_login((v_login->>'login_id')::uuid,
  repeat('c',64),v_capsule,'object://native-capsules/'||v_capsule::text,repeat('d',64),
  'review3-native-account-'||v_capsule::text,'personal_subscription','qorpera-native-subscription-v1',
  '{"monthly_microusd":1,"reservation_microusd":1,"max_calls_per_run":128,"max_input_tokens_per_run":100000000,"max_output_tokens_per_run":100000000,"max_concurrent_runs":64}');
 execute 'reset role';
 v_connection_id:=(v_connection->>'connection_id')::uuid;
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 execute 'set local role authenticated';
 perform public.qorpera_consent_provider_connection_autonomous('30000000-0000-4000-8000-000000000010',v_connection_id,true);
 v_sponsor:=public.qorpera_create_member_execution_sponsor('30000000-0000-4000-8000-000000000010',
  extensions.gen_random_uuid(),v_connection_id,2,true);
 execute 'reset role';
 perform set_config('qorpera_test.wake_sponsor',v_sponsor::text,true);
 perform pg_temp.path_claims('service_role');
 for i in 1..65 loop
  v_routine:=pg_temp.wake_routine('30000000-0000-4000-8000-000000000030',
   '{"id":"review3","kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}');
  v_wakes:=array_append(v_wakes,pg_temp.wake_schedule(v_routine,'review3-native-'||i));
 end loop;
 perform public.qorpera_materialize_wake_execution_runs(64);
 perform public.qorpera_materialize_wake_execution_runs(1);
 perform pg_temp.wake_assert((select count(*)=64 from public.qorpera_wake_occurrences
  where id=any(v_wakes) and status='materialized'),'64 native wakes materialize despite the monetary sentinel');
 perform pg_temp.wake_assert((select count(*)=1 from public.qorpera_wake_occurrences
  where id=any(v_wakes) and status='queued' and blocked_reason='Execution sponsor authority or quota is unavailable'),
  'The 65th wake is still blocked by the configured concurrency limit');
 perform pg_temp.wake_assert((select count(*)=64 from public.qorpera_execution_sponsor_reservations
  where provider_connection_id=v_connection_id and status='reserved'),'Exactly 64 reservations occupy the connection');
end $$;
select pg_temp.wake_acceptance_case('native_login_policy_allows_64_runs_and_blocks_the_65th',$q$select pg_temp.review3_native_quota()$q$);

select pg_temp.wake_acceptance_case('founder_stop_fences_native_work_and_direct_runner_sends',$q$
do $$ declare b jsonb:=current_setting('qorpera_test.wake_binding')::jsonb; begin
 perform pg_temp.handoff_begin(b,repeat('c',64));
 perform pg_temp.wake_public_send(b,'progress');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 perform public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010',true,'Test effect stop');
 perform pg_temp.path_claims('service_role');
 perform pg_temp.wake_error(format('select public.qorpera_describe_native_tool_authority(%L)',b),'55000','Company execution is paused');
 perform pg_temp.wake_error(format('select public.qorpera_begin_native_tool_operation(%L,%L,%L,%L,%L,false)',
  b,extensions.gen_random_uuid(),'stopped-operation',repeat('d',64),repeat('e',64)),'55000','Company execution is paused');
 perform pg_temp.wake_error(format('select public.qorpera_send_runner_agent_message(%L,%L,%L,%L,%L,%L,%L,%L)',
  b->>'runnerId',repeat('2',64),b->>'jobId',repeat('3',64),b->>'assignmentId',
  'stopped-direct-send','Must not deliver','progress'),'55000','Company execution is paused');
 perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends
  where idempotency_key='stopped-direct-send'),'No direct public send after stop');
 perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_run_operation_receipts
  where logical_operation_key='stopped-operation'),'No new operation after stop');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 perform public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010',false,'Test resume');
 perform pg_temp.path_claims('service_role');
 perform pg_temp.wake_public_send(b,'final');
 perform pg_temp.wake_acceptance_finish(b);
end $$;
$q$);
