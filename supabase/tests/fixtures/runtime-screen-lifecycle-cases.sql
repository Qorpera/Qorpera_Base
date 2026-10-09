-- Actual admitted office invocation comes from the provider/startup SQL proof.
-- Desired desktop state and physical event measurements are explicit fixtures;
-- this rolled-back transaction does not claim a running Linux desktop.
begin;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare startup jsonb:=current_setting('qorpera_test.screen_startup')::jsonb;
 office public.qorpera_runtime_offices%rowtype; screen public.qorpera_runtime_office_screens%rowtype;
 binding jsonb; life uuid:=extensions.gen_random_uuid(); event jsonb; receipt jsonb; first_receipt jsonb; history jsonb;
 at_time timestamptz:=clock_timestamp(); state text; reason text; seq integer:=0; first_event jsonb;
 privacy jsonb; drain jsonb; browser_profile uuid:=extensions.gen_random_uuid();
begin
 select * into strict office from public.qorpera_runtime_offices where id=(startup#>>'{scope,companyComputerId}')::uuid;
 select * into strict screen from public.qorpera_runtime_office_screens where office_id=office.id order by ordinal limit 1;
 update public.qorpera_runtime_office_screens set power='open',staff_agent_id='92400000-0000-4000-8000-000000000030',drain_pending=false
  where id=screen.id returning * into screen;
 binding:=public.qorpera_runtime_office_scope(office)||jsonb_build_object('computerGeneration',office.generation,
  'screenId',screen.id,'screenOrdinal',screen.ordinal,'screenGeneration',screen.generation,'staffAgentId',screen.staff_agent_id);
 for state,reason in select * from (values('requested','SCREEN_REQUESTED'),('ready','DESKTOP_READY'),('ready','SCREEN_HEARTBEAT')) x(s,r) loop
  seq:=seq+1;
  event:=jsonb_build_object('lifetimeId',life,'eventId',extensions.gen_random_uuid(),'sequence',seq,'observedAt',
   to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state',state,'reason',reason);
  receipt:=public.qorpera_record_runtime_screen_event(startup,binding,'null',event);
  if receipt->>'state'<>state or (receipt->>'sequence')::integer<>seq or receipt->>'eventId'<>event->>'eventId' then
   raise exception 'Screen event acknowledgement differs'; end if;
  if receipt<>public.qorpera_record_runtime_screen_event(startup,binding,'null',event) then raise exception 'Screen replay refreshed acknowledgement'; end if;
  if seq=1 then first_receipt:=receipt;first_event:=event;end if;
 end loop;
 if (select count(*) from public.qorpera_runtime_screen_lifetimes where id=life)<>1
  or (select count(*) from public.qorpera_runtime_screen_events where lifetime_id=life)<>3 then
  raise exception 'Screen replay duplicated history'; end if;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event||jsonb_build_object('reason','DESKTOP_READY'));
  raise exception 'Changed event replay accepted'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',first_event||jsonb_build_object('lifetimeId',extensions.gen_random_uuid(),'eventId',extensions.gen_random_uuid()));
  raise exception 'Duplicate physical screen accepted'; exception when unique_violation then null; end;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding||'{"screenGeneration":999}'::jsonb,'null',event);
  raise exception 'Changed lifetime binding accepted'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_record_runtime_screen_event(startup||jsonb_build_object('serviceInvocationId',repeat('f',32)),binding,'null',event);
  raise exception 'Changed service invocation accepted'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event||jsonb_build_object('eventId',extensions.gen_random_uuid(),'sequence',5));
  raise exception 'Sequence gap accepted'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event||jsonb_build_object('eventId',extensions.gen_random_uuid(),'sequence',4,'state','closed','reason','DESKTOP_REAPED'));
  raise exception 'Ready screen skipped closing'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event||jsonb_build_object('eventId',extensions.gen_random_uuid(),'sequence',4,'reason','raw secret exception'));
  raise exception 'Unbounded diagnostic accepted'; exception when invalid_parameter_value then null; end;
 -- Revoking shared authority prevents new readiness but cannot suppress exact
 -- historical acknowledgements or independently confirmed physical cleanup.
 update public.qorpera_runtime_office_access set state='revoked' where office_id=office.id and staff_agent_id=screen.staff_agent_id;
 if public.qorpera_record_runtime_screen_event(startup,binding,'null',first_event)<>first_receipt then raise exception 'Historical replay needs live authority'; end if;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event||jsonb_build_object('eventId',extensions.gen_random_uuid(),'sequence',4));
  raise exception 'Revoked screen reported ready'; exception when insufficient_privilege then null; end;
 for state,reason in select * from (values('closing','AUTHORITY_LOST'),('failed','DESKTOP_DRAIN_UNCONFIRMED'),('closed','DESKTOP_REAPED')) x(s,r) loop
  seq:=seq+1;
  event:=jsonb_build_object('lifetimeId',life,'eventId',extensions.gen_random_uuid(),'sequence',seq,'observedAt',
   to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state',state,'reason',reason);
  perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event);
 end loop;
 history:=public.qorpera_runtime_screen_events(life,0,2);
 if jsonb_array_length(history->'events')<>2 or (history->>'nextSequence')::integer<>2
  or (history->>'lastSequence')::integer<>6 or history->>'state'<>'closed'
  or history->>'kind'<>'shared' or history->'startup'<>startup or history->'binding'<>binding then
  raise exception 'Paginated screen history differs'; end if;
 history:=public.qorpera_runtime_screen_events(life,2,1000);
 if jsonb_array_length(history->'events')<>4 or (history->>'nextSequence')::integer<>6 then raise exception 'Screen cursor skipped events'; end if;
 if jsonb_array_length(public.qorpera_runtime_screen_events(life,6,1000)->'events')<>0 then raise exception 'Screen cursor repeated events'; end if;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event||jsonb_build_object('eventId',extensions.gen_random_uuid(),'sequence',7,'state','closing','reason','SCREEN_DRAIN_REQUESTED'));
  raise exception 'Closed lifetime revived'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_runtime_screen_events(life,0,1001);
  raise exception 'Unbounded history page accepted'; exception when invalid_parameter_value then null; end;
 -- Private sign-in is a distinct physical lifetime on the same screen. Use
 -- actual owner registration/privacy authority and explicit synthetic drains.
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',office.created_by_user_id)::text,true);
 perform public.qorpera_register_runtime_browser_profile(startup->'scope',browser_profile);
 privacy:=public.qorpera_request_runtime_office_privacy(startup->'scope',browser_profile,screen.id,office.privacy_version,true);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 for drain in select value from jsonb_array_elements(privacy->'drains') loop
  perform public.qorpera_ack_runtime_office_drain(startup->'scope',(drain#>>'{binding,screenId}')::uuid,
   (drain#>>'{binding,computerGeneration}')::bigint,(drain#>>'{binding,screenGeneration}')::bigint,
   (drain->>'epoch')::bigint,(drain->>'drainId')::uuid);
 end loop;
 select d->'binding' into strict binding from jsonb_array_elements(privacy->'drains') d where d#>>'{binding,screenId}'=screen.id::text;
 life:=extensions.gen_random_uuid();seq:=0;at_time:=clock_timestamp();
 for state,reason in select * from (values('requested','SCREEN_REQUESTED'),('ready','DESKTOP_READY'),('ready','SCREEN_HEARTBEAT')) x(s,r) loop
  seq:=seq+1;
  event:=jsonb_build_object('lifetimeId',life,'eventId',extensions.gen_random_uuid(),'sequence',seq,'observedAt',
   to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state',state,'reason',reason);
  perform public.qorpera_record_runtime_screen_event(startup,binding,privacy,event);
 end loop;
 if public.qorpera_runtime_screen_events(life,0,10)->>'kind'<>'private' then raise exception 'Private lifetime was counted as shared'; end if;
 history:=public.qorpera_runtime_screen_history(life,statement_timestamp()-interval '1 hour',statement_timestamp());
 if history->>'kind'<>'private' or history ? 'privacyChallenge' or history ? 'privacy_challenge' then
  raise exception 'Private usage kind or challenge visibility differs'; end if;
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,privacy||jsonb_build_object('challengeId',extensions.gen_random_uuid()),event);
  raise exception 'Private challenge replay changed'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',office.created_by_user_id)::text,true);
 perform public.qorpera_request_runtime_office_privacy(startup->'scope',browser_profile,screen.id,(privacy->>'version')::bigint,false);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,privacy,event||jsonb_build_object('eventId',extensions.gen_random_uuid(),'sequence',4));
  raise exception 'Cancelled private surface reported ready'; exception when insufficient_privilege then null; end;
 for state,reason in select * from (values('closing','PRIVACY_FENCE'),('closed','DESKTOP_REAPED')) x(s,r) loop
  seq:=seq+1;
  event:=jsonb_build_object('lifetimeId',life,'eventId',extensions.gen_random_uuid(),'sequence',seq,'observedAt',
   to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state',state,'reason',reason);
  perform public.qorpera_record_runtime_screen_event(startup,binding,privacy,event);
 end loop;
 if (select count(*) from public.qorpera_runtime_screen_lifetimes l where l.office_id=office.id and l.state='closed')<>2 then
  raise exception 'Shared/private physical lifetime identity collapsed'; end if;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 begin perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event);
  raise exception 'Member published physical evidence'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_runtime_screen_events(life,0,10);
  raise exception 'Member read operator evidence'; exception when insufficient_privilege then null; end;
 if exists(select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) role_name
  where has_table_privilege(role_name,'public.qorpera_runtime_screen_lifetimes','select,insert,update,delete')
   or has_table_privilege(role_name,'public.qorpera_runtime_screen_events','select,insert,update,delete')) then
  raise exception 'Raw screen evidence is not private'; end if;
end
$$;
rollback;
