-- Before SQL004: construct accepted-but-unmaterialized history through old admission.
do $$
declare
 base public.qorpera_execution_runs%rowtype;
 room uuid:=extensions.gen_random_uuid(); path text; document text; receipt jsonb;
begin
 select * into strict base from public.qorpera_execution_runs where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid;
 path:='organization/rooms/'||room::text||'.json';
 document:=jsonb_build_object('schema','qorpera.company-room/v1','roomId',room,'key','legacy-history-room',
  'name','Legacy history','purpose','Previously accepted human input.','status','active','projectId',null,'version',1,
  'members',jsonb_build_array(jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001')))::text;
 perform public.qorpera_project_organization_document(jsonb_build_object('companyId',base.profile_id,
  'environmentId',base.environment_id,'userId',base.requested_by_user_id,'audience','human'),
  jsonb_build_object('path',path,'entry',pg_temp.path_stage_file(path,document)),document,base.company_snapshot_id,extensions.gen_random_uuid());
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 receipt:=public.qorpera_post_company_room_message(room,extensions.gen_random_uuid(),
  '{"schema":"qorpera.session-prompt/v1","text":"Accepted before upgrade"}',base.sponsor_binding_id,base.sponsor_version);
 perform pg_temp.wake_assert(receipt->'occurrenceIds'='[]'::jsonb and public.qorpera_read_session_events((receipt->>'sessionId')::uuid)='[]'::jsonb,
  'Historical fixture reproduces accepted room input missing from canonical history');
 perform set_config('qorpera_test.legacy_room_receipt',receipt::text,true);
 update public.qorpera_shared_sessions set status='closed' where id=(receipt->>'sessionId')::uuid;
 perform pg_temp.path_claims('service_role');
 -- Existing explicit sends acquire metadata through the upgrade without body rewrites.
 perform pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','pre-upgrade-speaker');
 perform set_config('qorpera_test.legacy_send_events',(select jsonb_agg(to_jsonb(event))::text
  from public.qorpera_session_events event where event.execution_id=base.id),true);
end $$;
-- Later migrations carry their own begin/commit (20260920011000 onward). The first one
-- commits this fixture and drops its transaction-local settings, so the checks
-- after the upgrade read every fixture setting from the session instead. (pg_settings
-- hides custom placeholder settings, so they are listed.)
select set_config(name,current_setting(name),false) from unnest(array['qorpera_test.wake_tree',
 'qorpera_test.wake_identity','qorpera_test.wake_login','qorpera_test.wake_connection','qorpera_test.wake_sponsor',
 'qorpera_test.wake_turn','qorpera_test.wake_binding','qorpera_test.legacy_room_receipt',
 'qorpera_test.legacy_send_events']) name;
