-- After SQL004: missing closed-room input is repaired; existing sends are unchanged.
do $$
declare receipt jsonb:=current_setting('qorpera_test.legacy_room_receipt')::jsonb; events jsonb; old_event jsonb; current_event jsonb;
begin
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 events:=public.qorpera_read_session_events((receipt->>'sessionId')::uuid);
 perform pg_temp.wake_assert(jsonb_array_length(events)=1 and events#>>'{0,session_input_id}'=receipt->>'inputId'
  and events#>>'{0,body,entry,message,content,0,text}'='Accepted before upgrade','Upgrade repairs accepted closed-room history');
 for old_event in select value from jsonb_array_elements(current_setting('qorpera_test.legacy_send_events')::jsonb) loop
  select to_jsonb(event) into strict current_event from public.qorpera_session_events event where event.event_id=(old_event->>'event_id')::uuid;
  perform pg_temp.wake_assert(current_event=old_event,'Speaker upgrade never rewrites pre-existing event rows');
  perform pg_temp.wake_assert(exists(select 1 from public.qorpera_session_event_speakers speaker where speaker.event_id=(old_event->>'event_id')::uuid),
   'Upgrade projects existing explicit send provenance');
 end loop;
 perform pg_temp.path_claims('service_role');
end $$;

-- Consumed after the existing real wake fixture. Migrations with their own commit end
-- the fixture's transaction, so each block sets its own claims.
do $$
#variable_conflict use_variable
declare
 binding jsonb:=current_setting('qorpera_test.wake_binding')::jsonb;
 base public.qorpera_execution_runs%rowtype;
 room uuid:=extensions.gen_random_uuid(); client_input uuid:=extensions.gen_random_uuid();
 path text; document text; receipt jsonb; replay jsonb; events jsonb; stored_hash text; stored_body jsonb;
 input_id uuid; session_id uuid; run_id uuid; speaker jsonb; event_id uuid;
begin
 perform pg_temp.path_claims('service_role');
 select * into strict base from public.qorpera_execution_runs where id=(binding->>'runId')::uuid;
 path:='organization/rooms/'||room::text||'.json';
 document:=jsonb_build_object('schema','qorpera.company-room/v1','roomId',room,'key','history-room',
  'name','History room','purpose','Retain accepted human messages.','status','active','projectId',null,'version',1,
  'members',jsonb_build_array(jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001')))::text;
 perform public.qorpera_project_organization_document(jsonb_build_object('companyId',base.profile_id,
  'environmentId',base.environment_id,'userId',base.requested_by_user_id,'audience','human'),
  jsonb_build_object('path',path,'entry',pg_temp.path_stage_file(path,document)),document,base.company_snapshot_id,extensions.gen_random_uuid());
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 receipt:=public.qorpera_post_company_room_message(room,client_input,'{"schema":"qorpera.session-prompt/v1","text":"Accepted without staff"}',base.sponsor_binding_id,base.sponsor_version);
 input_id:=(receipt->>'inputId')::uuid; session_id:=(receipt->>'sessionId')::uuid;
 perform pg_temp.wake_assert(receipt->'occurrenceIds'='[]'::jsonb,'Zero recipient room accepts without wakes');
 events:=public.qorpera_read_session_events(session_id);
 perform pg_temp.wake_assert(jsonb_array_length(events)=1 and events#>>'{0,session_input_id}'=input_id::text
  and events#>>'{0,body,entry,message,content,0,text}'='Accepted without staff','Accepted room input immediately survives replacement caller read');
 stored_hash:=events#>>'{0,event_hash}'; stored_body:=events#>'{0,body}';
 perform pg_temp.wake_error(format('update public.qorpera_company_rooms set session_id=%L where id=%L; select public.qorpera_post_company_room_message(%L,%L,%L,%L,%s)',
  base.session_id,room,room,extensions.gen_random_uuid(),'{"schema":"qorpera.session-prompt/v1","text":"Wrong room target"}',base.sponsor_binding_id,base.sponsor_version),'42501');
 perform pg_temp.wake_assert(public.qorpera_read_session_events(session_id)=events,'Wrong room session binding rolls back the complete admission');
 replay:=public.qorpera_post_company_room_message(room,client_input,'{"schema":"qorpera.session-prompt/v1","text":"Accepted without staff"}',base.sponsor_binding_id,base.sponsor_version);
 perform pg_temp.wake_assert(replay=receipt and public.qorpera_read_session_events(session_id)=events,'Exact replay retains one input and original event hash');
 perform pg_temp.wake_error(format('select public.qorpera_post_company_room_message(%L,%L,%L,%L,%s)',room,client_input,
  '{"schema":"qorpera.session-prompt/v1","text":"Changed"}',base.sponsor_binding_id,base.sponsor_version),'23505');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
 perform pg_temp.wake_assert(public.qorpera_read_session_events(session_id)=events,'Room history retains its company audience');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000004');
 perform pg_temp.wake_error(format('select public.qorpera_read_session_events(%L)',session_id),'42501');
 perform pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_append_admitted_input_events(uuid,uuid[])','execute'),
  'Member cannot directly append canonical events');
 perform pg_temp.wake_assert(not has_table_privilege('authenticated','public.qorpera_session_event_speakers','select'),
  'Speaker table has no direct member projection bypass');
 -- Add Bob through the established organization projection, then leave the wake unmaterialized.
 perform pg_temp.path_claims('service_role');
 document:=jsonb_set(jsonb_set(document::jsonb,'{version}','2'),'{members}',jsonb_build_array(
  jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001'),
  jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031')))::text;
 perform public.qorpera_project_organization_document(jsonb_build_object('companyId',base.profile_id,
  'environmentId',base.environment_id,'userId',base.requested_by_user_id,'audience','human'),
  jsonb_build_object('path',path,'entry',pg_temp.path_stage_file(path,document)),document,base.company_snapshot_id,extensions.gen_random_uuid());
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 receipt:=public.qorpera_post_company_room_message(room,extensions.gen_random_uuid(),'{"schema":"qorpera.session-prompt/v1","text":"Bob, send a result"}',base.sponsor_binding_id,base.sponsor_version);
 perform pg_temp.wake_assert(jsonb_array_length(receipt->'occurrenceIds')=1 and jsonb_array_length(public.qorpera_read_session_events(session_id))=2,
  'Accepted input is canonical before wake materialization');
 perform pg_temp.path_claims('service_role');
 perform public.qorpera_materialize_wake_execution_runs(1);
 select occurrence.run_id into strict run_id from public.qorpera_wake_occurrences occurrence where occurrence.id=(receipt#>>'{occurrenceIds,0}')::uuid;
 binding:=pg_temp.wake_start(run_id);
 perform pg_temp.wake_assert((select count(*)=2 from public.qorpera_session_events event where event.session_id=session_id),
  'Materialization does not duplicate accepted input events');
 perform pg_temp.wake_public_send(binding,'final','history-result');
 perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
 events:=public.qorpera_read_session_events(session_id);
 select value->'staff_speaker',(value->>'event_id')::uuid into speaker,event_id from jsonb_array_elements(events)
 where value ? 'staff_speaker';
 perform pg_temp.wake_assert(speaker->>'staff_agent_id'='30000000-0000-4000-8000-000000000031'
  and speaker->>'run_id'=run_id::text and speaker->>'display_name'='Bob','Authorized transcript names actual speaking staff, not sponsor');
 perform pg_temp.wake_assert(events#>>'{0,event_hash}'=stored_hash and events#>'{0,body}'=stored_body,
  'Later sends and speaker projection leave earlier hash-chain content unchanged');
 update public.qorpera_profile_staff set display_name='Renamed Bob' where staff_agent_id='30000000-0000-4000-8000-000000000031';
 perform pg_temp.wake_assert((select value->'staff_speaker'=speaker from jsonb_array_elements(public.qorpera_read_session_events(session_id)) where value->>'event_id'=event_id::text),
  'Staff rename cannot relabel historical output');
 perform pg_temp.wake_error(format('update public.qorpera_session_event_speakers set display_name=%L where event_id=%L','Forged',event_id),'42501');
 -- The last founder cannot leave while others remain (20260928248100): a second founder joins first.
 insert into auth.users(id,email) values ('30000000-0000-4000-8000-0000000000f5','history-cofounder@example.test');
 insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
 values (base.profile_id,'30000000-0000-4000-8000-0000000000f5','history-cofounder@example.test','Co-founder','owner');
 delete from public.qorpera_profile_members where profile_id=base.profile_id and user_id='30000000-0000-4000-8000-000000000001';
 perform pg_temp.wake_error(format('select public.qorpera_read_session_events(%L)',session_id),'42501');
end $$;
