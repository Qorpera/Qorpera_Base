-- Uses the admitted activation from the real provider/startup driver. Physical
-- timestamps are deliberately backdated fixture measurements, not Linux proof.
begin;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare startup jsonb:=current_setting('qorpera_test.screen_startup')::jsonb;
 office public.qorpera_runtime_offices%rowtype; screen public.qorpera_runtime_office_screens%rowtype;
 binding jsonb; life uuid:=extensions.gen_random_uuid(); item record; event jsonb;
 at_time timestamptz:=clock_timestamp(); base timestamptz:=date_trunc('second',statement_timestamp())-interval '120 seconds';
 history jsonb; left_part jsonb; right_part jsonb; page jsonb; before_events jsonb; key text; allocated bigint;
begin
 select * into strict office from public.qorpera_runtime_offices where id=(startup#>>'{scope,companyComputerId}')::uuid;
 select * into strict screen from public.qorpera_runtime_office_screens where office_id=office.id order by ordinal limit 1;
 update public.qorpera_runtime_office_screens set power='open' where id=screen.id;
 binding:=public.qorpera_runtime_office_scope(office)||jsonb_build_object('computerGeneration',office.generation,
  'screenId',screen.id,'screenOrdinal',screen.ordinal,'screenGeneration',screen.generation,'staffAgentId',screen.staff_agent_id);
 for item in select * from (values
  (1,0,'requested','SCREEN_REQUESTED'),(2,5,'ready','DESKTOP_READY'),(3,10,'ready','SCREEN_HEARTBEAT'),
  (4,40,'ready','SCREEN_HEARTBEAT'),(5,50,'closing','SCREEN_DRAIN_REQUESTED'),
  (6,55,'failed','DESKTOP_DRAIN_UNCONFIRMED'),(7,70,'closed','DESKTOP_REAPED')) x(seq,offset_seconds,state,reason) loop
  event:=jsonb_build_object('lifetimeId',life,'eventId',extensions.gen_random_uuid(),'sequence',item.seq,
   'observedAt',to_char(at_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state',item.state,'reason',item.reason);
  perform public.qorpera_record_runtime_screen_event(startup,binding,'null',event);
  update public.qorpera_runtime_screen_events e set event=jsonb_set(e.event,'{observedAt}',to_jsonb(
   to_char((base+make_interval(secs=>item.offset_seconds)) at time zone 'UTC',
    case when item.seq%2=0 then 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' else 'YYYY-MM-DD"T"HH24:MI:SS"Z"' end)))
   where e.lifetime_id=life and e.sequence=item.seq;
 end loop;
 update public.qorpera_runtime_screen_lifetimes set observed_at=base+interval '70 seconds',closed_at=base+interval '70 seconds' where id=life;
 select jsonb_agg(to_jsonb(e) order by sequence) into before_events from public.qorpera_runtime_screen_events e where lifetime_id=life;
 select count(*) into allocated from public.qorpera_runtime_machine_allocations where released_at is null;
 history:=public.qorpera_runtime_screen_history(life,base-interval '10 seconds',base+interval '90 seconds');
 if abs((history#>>'{usage,observedLifetimeHours}')::numeric*3600-70)>0.000000001
  or abs((history#>>'{usage,estimatedReadyScreenHours}')::numeric*3600-30)>0.000000001
  or abs((history#>>'{usage,unknownScreenHours}')::numeric*3600-15)>0.000000001
  or abs((history#>>'{usage,requestedScreenHours}')::numeric*3600-5)>0.000000001
  or abs((history#>>'{usage,closingScreenHours}')::numeric*3600-5)>0.000000001
  or abs((history#>>'{usage,failedScreenHours}')::numeric*3600-15)>0.000000001 then
  raise exception 'Screen history arithmetic differs: %',history->'usage'; end if;
 if history->>'method'<>'guest_screen_heartbeat_hold' or (history->>'maximumSampleHoldSeconds')::integer<>15
  or history->'exactTransitionTimes'<>'false'::jsonb or history->'termination'<>'null'::jsonb
  or history->>'coverage'<>'registered_lifetime_only' or history->'startup'<>startup or history->'binding'<>binding then
  raise exception 'Screen history lost evidence semantics'; end if;
 if not exists(select 1 from jsonb_array_elements(history->'intervals') i where i->>'state'='unknown'
  and i->>'reason'='SCREEN_OBSERVATION_STALE' and i->'firstEventId'='null') then raise exception 'Heartbeat gap was hidden'; end if;
 left_part:=public.qorpera_runtime_screen_history(life,base-interval '10 seconds',base+interval '33 seconds');
 right_part:=public.qorpera_runtime_screen_history(life,base+interval '33 seconds',base+interval '90 seconds');
 for key in select jsonb_object_keys(history->'usage') loop
  if abs((history->'usage'->>key)::numeric-(left_part->'usage'->>key)::numeric-(right_part->'usage'->>key)::numeric)>0.000000001 then
   raise exception 'Screen history partition changed %',key; end if;
 end loop;
 left_part:=public.qorpera_runtime_screen_history(life,base+interval '12.5 seconds',base+interval '48 seconds');
 if abs((left_part#>>'{usage,estimatedReadyScreenHours}')::numeric*3600-20.5)>0.000000001
  or abs((left_part#>>'{usage,unknownScreenHours}')::numeric*3600-15)>0.000000001 then
  raise exception 'Fractional precision or clipped original heartbeat was refreshed'; end if;
 right_part:=public.qorpera_runtime_screen_history(life,base+interval '80 seconds',base+interval '90 seconds');
 if right_part->'intervals'<>'[]' or (right_part#>>'{usage,observedLifetimeHours}')::numeric<>0 then
  raise exception 'Confirmed closure continued accumulating screen time'; end if;
 page:=public.qorpera_runtime_screen_lifetimes((startup->>'allocationId')::uuid,null,1000);
 if not exists(select 1 from jsonb_array_elements(page->'lifetimes') l where l->>'lifetimeId'=life::text
  and l->>'kind'='shared' and l->>'recordedState'='closed' and not(l ? 'privacyChallenge'))
  or page->>'coverage'<>'registered_lifetimes_only' or page->'snapshotAcrossPages'<>'false' then
  raise exception 'Screen discovery identity or coverage differs'; end if;
 if has_function_privilege('service_role','public.qorpera_runtime_screen_termination(uuid)','execute')
  or has_function_privilege('authenticated','public.qorpera_runtime_screen_history(uuid,timestamptz,timestamptz)','execute')
  or has_function_privilege('anon','public.qorpera_runtime_screen_lifetimes(uuid,uuid,integer)','execute') then
  raise exception 'Screen history privilege leaked'; end if;
 begin perform public.qorpera_runtime_screen_history(life,base,base+interval '25 hours');
  raise exception 'Oversized window accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_runtime_screen_history(life,'-infinity',base);
  raise exception 'Infinite window accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_runtime_screen_history(life,base,clock_timestamp()+interval '10 seconds');
  raise exception 'Future window accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_runtime_screen_history(extensions.gen_random_uuid(),base,base+interval '1 second');
  raise exception 'Unknown lifetime accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_runtime_screen_lifetimes((startup->>'allocationId')::uuid,null,1001);
  raise exception 'Oversized discovery page accepted'; exception when invalid_parameter_value then null; end;
 begin
  insert into public.qorpera_runtime_screen_events(event_id,lifetime_id,sequence,event)
   select extensions.gen_random_uuid(),life,n,jsonb_build_object('observedAt',to_char((base+interval '42 seconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'state','ready','reason','SCREEN_HEARTBEAT')
   from generate_series(8,20010) n;
  perform public.qorpera_runtime_screen_history(life,base,base+interval '90 seconds');
  raise exception 'Unbounded screen observations accepted'; exception when program_limit_exceeded then null;
 end;
 begin
  insert into public.qorpera_runtime_screen_events(event_id,lifetime_id,sequence,event)
   select extensions.gen_random_uuid(),life,n+7,jsonb_build_object('observedAt',
    to_char((base+make_interval(secs=>n*0.003)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'state',case when n%2=0 then 'closing' else 'failed' end,
    'reason',case when n%2=0 then 'SCREEN_DRAIN_REQUESTED' else 'DESKTOP_DRAIN_UNCONFIRMED' end)
   from generate_series(1,19000) n;
  perform public.qorpera_runtime_screen_history(life,base,base+interval '90 seconds');
  raise exception 'Oversized screen response accepted';
 exception when program_limit_exceeded then
  if sqlerrm<>'Screen history response requires a smaller window' then raise; end if;
 end;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 begin perform public.qorpera_runtime_screen_history(life,base,base+interval '90 seconds');
  raise exception 'Member history accepted'; exception when insufficient_privilege then null; end;
 begin perform public.qorpera_runtime_screen_lifetimes((startup->>'allocationId')::uuid,null,1);
  raise exception 'Member discovery accepted'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 if (select jsonb_agg(to_jsonb(e) order by sequence) from public.qorpera_runtime_screen_events e where lifetime_id=life)<>before_events
  or (select count(*) from public.qorpera_runtime_machine_allocations where released_at is null)<>allocated then
  raise exception 'Screen history mutated evidence or capacity'; end if;
end
$$;
rollback;
