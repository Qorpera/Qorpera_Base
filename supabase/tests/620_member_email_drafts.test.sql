-- @fixture 150_runner_orchestrator.test.sql until "select public.qorpera_configure_session_execution("
select public.qorpera_configure_session_execution(
 '15000000-0000-4000-8000-000000000055',
 (current_setting('qorpera_test.sponsor')::jsonb ->> 'binding_id')::uuid, 1,
 '15000000-0000-4000-8000-000000000080','agent_turn','agent_turn','automatic',null,'{}');
reset role;
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values('62000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000010','https://broker.example.test','test',repeat('a',64));
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,current_version,created_by_user_id,account_label)
values('62000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000010','15000000-0000-4000-8000-000000000020','62000000-0000-4000-8000-000000000001','company','gmail','primary','Email',1,'15000000-0000-4000-8000-000000000001','sender@example.test');
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,envelope_sha256,created_by_user_id)
values('62000000-0000-4000-8000-000000000002',1,'62000000-0000-4000-8000-000000000001','test',decode('abcd','hex'),repeat('b',64),'15000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(profile_id,environment_id,secret_id,staff_agent_id,connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '15000000-0000-4000-8000-000000000010','15000000-0000-4000-8000-000000000020','62000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000054','gmail',operation_id,version,tool_name,'15000000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations where connector_id='gmail' and status='active';
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
values('15000000-0000-4000-8000-000000000055',2,'62000000-0000-4000-8000-000000000003','interaction_request','15000000-0000-4000-8000-000000000001',
'{"entry":{"data":{"schema":"qorpera.interaction/v1","surface":"draft","title":"New email","payload":{"platform":"email","connectorId":"gmail","from":"sender@example.test","to":["before@example.test"],"subject":"Before","body":"Before"}}}}',repeat('c',64),statement_timestamp());
select set_config('request.jwt.claims','{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
do $$ declare v jsonb; begin
 v:=public.qorpera_get_email_draft('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000003');
 if v->>'from'<>'sender@example.test' or v->>'status'<>'ready' then raise exception 'wrong initial state %',v; end if;
 begin
  perform public.qorpera_answer_interaction('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000011','62000000-0000-4000-8000-000000000003','sent','{}');
  raise exception 'fabricated sent accepted';
 exception when insufficient_privilege then null; end;
 v:=public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000004','send','{"to":["edited@example.test"],"cc":[],"subject":"Edited","body":"Edited body"}',repeat('d',64));
 if v->>'status'<>'sending' then raise exception 'not pending %',v; end if;
 begin
  perform public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000005','send','{"to":["edited@example.test"],"cc":[],"subject":"Edited","body":"Edited body"}',repeat('e',64));
  raise exception 'concurrent send accepted';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 begin
  perform public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000004',repeat('e',64));
  raise exception 'bad capability accepted';
 exception when insufficient_privilege then null; end;
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000004',repeat('d',64));
 if v->'execute'<>'true'::jsonb or v#>>'{content,body}'<>'Edited body' then raise exception 'wrong claim %',v; end if;
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000004',repeat('d',64));
 if v->'execute'<>'false'::jsonb or v?'encryptedEnvelopeBase64' then raise exception 'second send allowed %',v; end if;
 v:=public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000004',repeat('d',64),'{"message_id":"gmail1"}');
 if v->>'status'<>'sent' or v->>'messageId'<>'gmail1' then raise exception 'wrong sent receipt %',v; end if;
 v:=public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000004',repeat('d',64),'{"message_id":"gmail1"}');
end $$;
reset session authorization;
do $$ begin
 if (select count(*) from public.qorpera_session_inputs where body->>'interactionId'='62000000-0000-4000-8000-000000000003')<>1
  or not exists(select 1 from public.qorpera_session_inputs where body#>>'{answer,content,body}'='Edited body' and body#>>'{answer,messageId}'='gmail1') then raise exception 'truthful terminal answer missing'; end if;
end $$;
-- Another member can read a company card, but cannot send it on its owner's behalf.
select set_config('request.jwt.claims','{"sub":"15000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
do $$ declare v jsonb; begin
 v:=public.qorpera_get_email_draft('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000003');
 if v->>'status'<>'sent' then raise exception 'reader cannot see receipt'; end if;
 begin
  perform public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000005','send','{"to":["edited@example.test"],"cc":[],"subject":"Edited","body":"Edited body"}',repeat('e',64));
  raise exception 'other member send accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- A saved draft can be edited and sent; an expired ticket is never executed.
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
select session_id,3,'62000000-0000-4000-8000-000000000012','interaction_request',actor_user_id,body,repeat('e',64),created_at
from public.qorpera_session_events where event_id='62000000-0000-4000-8000-000000000003';
select set_config('request.jwt.claims','{"sub":"15000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000012','62000000-0000-4000-8000-000000000013','save','{"to":["save@example.test"],"cc":[],"subject":"Saved","body":"Saved"}',repeat('1',64));
reset role;
update public.qorpera_member_email_actions set expires_at=statement_timestamp()-interval '1 minute' where id='62000000-0000-4000-8000-000000000013';
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000013',repeat('1',64));
 if v->'execute'<>'false'::jsonb or v#>>'{state,status}'<>'ready' or v#>>'{state,phase}'<>'failed' then raise exception 'expired pending action unsafe %',v; end if;
end $$;
reset session authorization;
set role authenticated;
select public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000012','62000000-0000-4000-8000-000000000014','save','{"to":["save@example.test"],"cc":[],"subject":"Saved","body":"Saved"}',repeat('2',64));
do $$ begin
 begin
  perform public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000012','62000000-0000-4000-8000-000000000013','save','{"to":["save@example.test"],"cc":[],"subject":"Saved","body":"Saved"}',repeat('1',64));
  raise exception 'old ticket returned a new capability target';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
set session authorization qorpera_secret_broker;
select public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000014',repeat('2',64));
select public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000014',repeat('2',64),'{"draft_id":"draft1"}');
reset session authorization;
set role authenticated;
select public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000012','62000000-0000-4000-8000-000000000015','send','{"to":["new@example.test"],"cc":[],"subject":"New","body":"New edits"}',repeat('3',64));
reset role;
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000015',repeat('3',64));
 if v->>'draftId'<>'draft1' or v#>>'{content,body}'<>'New edits' then raise exception 'saved draft did not bind latest edits'; end if;
 v:=public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000015',repeat('3',64),'{"status":"unconfirmed"}');
 if v->>'status'<>'unconfirmed' then raise exception 'uncertainty hidden'; end if;
 begin
  perform public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000014',repeat('2',64),'{"draft_id":"draft1"}');
  raise exception 'stale save overwrote subsequent send';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset session authorization;
set role authenticated;
do $$ begin
 begin
  perform public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000012','62000000-0000-4000-8000-000000000016','send','{"to":["new@example.test"],"cc":[],"subject":"New","body":"New edits"}',repeat('4',64));
  raise exception 'ambiguous send retried';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
-- A Gmail success survives temporary wake/sponsor failure. Replaying the
-- provider receipt later publishes the answer without claiming Gmail again.
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
select session_id,4,'62000000-0000-4000-8000-000000000020','interaction_request',actor_user_id,body,repeat('f',64),created_at
from public.qorpera_session_events where event_id='62000000-0000-4000-8000-000000000003';
create temp table email_test_binding as select * from public.qorpera_session_execution_bindings where session_id='15000000-0000-4000-8000-000000000055';
delete from public.qorpera_session_execution_bindings where session_id='15000000-0000-4000-8000-000000000055';
set role authenticated;
select public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000020','62000000-0000-4000-8000-000000000021','send','{"to":["new@example.test"],"cc":[],"subject":"New","body":"New edits"}',repeat('5',64));
reset role;
set session authorization qorpera_secret_broker;
select public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000021',repeat('5',64));
do $$ declare v jsonb; begin
 v:=public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000021',repeat('5',64),'{"message_id":"gmail2"}');
 if v->>'status'<>'sent' or v->'notificationPending'<>'true'::jsonb then raise exception 'wake failure lost provider success %',v; end if;
end $$;
reset session authorization;
insert into public.qorpera_session_execution_bindings select * from email_test_binding;
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000021',repeat('5',64));
 if v->'execute'<>'false'::jsonb or v#>'{state,notificationPending}'<>'false'::jsonb or v#>>'{state,status}'<>'sent' then raise exception 'wake retry resent or did not deliver %',v; end if;
end $$;
reset session authorization;
-- In an agent's shared thread, the card's requester owns it, even when the
-- conversation was created by another member. Edits do not block Discard.
update public.qorpera_company_rooms set bound_staff_agent_id=null,source_path_version='62000000-0000-4000-8000-000000000031',source_snapshot_id='15000000-0000-4000-8000-000000000040',source_file_sha256=repeat('f',64)
where profile_id='15000000-0000-4000-8000-000000000010' and bound_staff_agent_id='15000000-0000-4000-8000-000000000054';
insert into public.qorpera_company_rooms(id,profile_id,environment_id,room_key,name,purpose,status,session_id,version,source_path,source_path_version,source_snapshot_id,source_file_sha256,created_by_user_id,bound_staff_agent_id)
values('62000000-0000-4000-8000-000000000030','15000000-0000-4000-8000-000000000010','15000000-0000-4000-8000-000000000020','agent-email','Email agent','Draft review','active','15000000-0000-4000-8000-000000000055',1,'organization/rooms/agent-email.json','62000000-0000-4000-8000-000000000031','15000000-0000-4000-8000-000000000040',repeat('f',64),'15000000-0000-4000-8000-000000000001','15000000-0000-4000-8000-000000000054');
insert into public.qorpera_company_room_members(room_id,principal_kind,principal_id,status,source_path_version)
values('62000000-0000-4000-8000-000000000030','member','15000000-0000-4000-8000-000000000002','active','62000000-0000-4000-8000-000000000031');
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
select session_id,5,'62000000-0000-4000-8000-000000000032','interaction_request','15000000-0000-4000-8000-000000000002',body,repeat('e',64),created_at
from public.qorpera_session_events where event_id='62000000-0000-4000-8000-000000000003';
set role authenticated;
do $$ begin
 begin
  perform public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000032','62000000-0000-4000-8000-000000000033','discard','{"to":[],"cc":[],"subject":"Edited before discard","body":""}',repeat('6',64));
  raise exception 'thread creator answered another members card';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"15000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
select public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000032','62000000-0000-4000-8000-000000000033','discard','{"to":[],"cc":[],"subject":"Edited before discard","body":""}',repeat('6',64));
reset role;
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000033',repeat('6',64));
 if v->'execute'<>'true'::jsonb or v->>'action'<>'discard' then raise exception 'contributor requester cannot discard %',v; end if;
 v:=public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000033',repeat('6',64),'{"deleted":true}');
 if v->>'status'<>'discarded' then raise exception 'discard not confirmed'; end if;
end $$;
reset session authorization;
-- A broker crash after claim cannot leave Sending visible forever or unlock a
-- second send. A late, authenticated provider receipt can still resolve it.
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
select session_id,6,'62000000-0000-4000-8000-000000000040','interaction_request','15000000-0000-4000-8000-000000000002',body,repeat('d',64),created_at
from public.qorpera_session_events where event_id='62000000-0000-4000-8000-000000000003';
set role authenticated;
select public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000040','62000000-0000-4000-8000-000000000041','send','{"to":["new@example.test"],"cc":[],"subject":"Crash regression","body":"Exact body"}',repeat('7',64));
reset role;
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000041',repeat('7',64));
 if v->'execute'<>'true'::jsonb then raise exception 'crash fixture was not claimed'; end if;
end $$;
reset session authorization;
update public.qorpera_member_email_actions set expires_at=statement_timestamp()-interval '1 minute' where id='62000000-0000-4000-8000-000000000041';
set role authenticated;
do $$ declare v jsonb; begin
 v:=public.qorpera_get_email_draft('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000040');
 if v->>'status'<>'unconfirmed' or v->>'phase'<>'unconfirmed' or v->>'error' is null then raise exception 'crashed send still looks active %',v; end if;
 begin
  perform public.qorpera_prepare_email_draft_action('15000000-0000-4000-8000-000000000055','62000000-0000-4000-8000-000000000040','62000000-0000-4000-8000-000000000042','send','{"to":["new@example.test"],"cc":[],"subject":"Crash regression","body":"Exact body"}',repeat('8',64));
  raise exception 'expired execution allowed a new send';
 exception when object_not_in_prerequisite_state then null; end;
end $$;
reset role;
set session authorization qorpera_secret_broker;
do $$ declare v jsonb; begin
 v:=public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000041',repeat('7',64));
 if v->'execute'<>'false'::jsonb or v#>>'{state,status}'<>'unconfirmed' or v?'encryptedEnvelopeBase64' then raise exception 'expired claim replay can resend %',v; end if;
 v:=public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001',repeat('a',64),'62000000-0000-4000-8000-000000000041',repeat('7',64),'{"message_id":"late-receipt"}');
 if v->>'status'<>'sent' or v->>'messageId'<>'late-receipt' then raise exception 'late provider receipt lost %',v; end if;
end $$;
reset session authorization;
rollback;
