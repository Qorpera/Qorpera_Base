-- Arithmetic fixtures for retained historical samples. Only this rolled-back,
-- disposable-DB fixture writes old timestamps directly; production publication
-- still requires current observations and immutable physical authority.
begin;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare a uuid; n uuid; e jsonb; i record; observation uuid; at_time timestamptz;
 t timestamptz:='2020-01-01T00:00:00Z'; result jsonb; partial jsonb; second_half jsonb;
begin
 select d.allocation_id,d.node_id into strict a,n from public.qorpera_runtime_node_demands d
  join public.qorpera_runtime_machine_allocations m on m.id=d.allocation_id where m.runner_id is not null;
 select entry into e from public.qorpera_runtime_node_inventory_receipts r,
  lateral jsonb_array_elements(r.inventory->'entries') entry
  where entry#>>'{allocation,allocationId}'=a::text and entry->>'category'='managed' and entry->'reason'='null'::jsonb limit 1;
 if e is null then raise exception 'Actual publisher fixture required'; end if;
 update public.qorpera_runtime_node_demands set requested_at=t-interval '20 seconds',reserved_at=t,released_at=t+interval '360 seconds' where allocation_id=a;
 update public.qorpera_runtime_machine_allocations set reserved_at=t-interval '10 seconds',released_at=t+interval '360 seconds' where id=a;
 for i in select * from (values (10,'running','managed'),(30,'running','managed'),(80,'suspended','managed'),
  (100,'suspended','managed'),(200,'running','managed'),(240,'running','hardware'),(260,'running','unavailable'),
  (300,'running','absent'),(320,'running','substituted')) x(seconds,state,kind) loop
  observation:=extensions.gen_random_uuid(); at_time:=t+make_interval(secs=>i.seconds);
  insert into public.qorpera_runtime_node_observation_receipts(node_id,observation_id,observed_at,observation)
   values(n,observation,at_time,jsonb_build_object('state',case when i.kind='unavailable' then 'unavailable' else 'ready' end));
  if i.kind not in ('hardware','unavailable') then
   insert into public.qorpera_runtime_node_inventory_receipts(node_id,observation_id,node_version,policy_sha256,context_sha256,inventory)
   values(n,observation,1,repeat('c',64),repeat('d',64),jsonb_build_object('bootId','36000000-0000-4000-8000-000000000111',
    'entries',case when i.kind='absent' then '[]'::jsonb else jsonb_build_array(e||jsonb_build_object('state',i.state)||
     case when i.kind='substituted' then jsonb_build_object('physicalId',extensions.gen_random_uuid()) else '{}'::jsonb end) end));
  end if;
 end loop;
 result:=public.qorpera_runtime_computer_history(a,t-interval '30 seconds',t+interval '420 seconds');
 if (result#>>'{usage,reservedHours}')::numeric<>0.1
  or abs((result#>>'{usage,estimatedRunningComputerHours}')::numeric*3600-110)>0.000001
  or abs((result#>>'{usage,estimatedSuspendedComputerHours}')::numeric*3600-80)>0.000001
  or abs((result#>>'{usage,unknownHours}')::numeric*3600-170)>0.000001
  or (result->>'resourcesReleasedAt')::timestamptz<>t+interval '360 seconds'
  or result->>'method'<>'physical_inventory_sample_hold' or result->'exactTransitionTimes'<>'false'::jsonb
  or result->'screenUsage'<>'null'::jsonb then raise exception 'Computer usage arithmetic differs: %',result; end if;
 if (select array_agg(x->>'reason' order by (x->>'from')::timestamptz) from jsonb_array_elements(result->'intervals') x)
  <>array['OBSERVATION_MISSING','PHYSICAL_INVENTORY_OBSERVATION','PHYSICAL_INVENTORY_OBSERVATION','OBSERVATION_STALE',
   'PHYSICAL_INVENTORY_OBSERVATION','INVENTORY_UNAVAILABLE','NODE_UNAVAILABLE','INSTANCE_NOT_OBSERVED','INSTANCE_AUTHORITY_UNCONFIRMED'] then
  raise exception 'Unknown intervals were hidden'; end if;
 partial:=public.qorpera_runtime_computer_history(a,t+interval '20 seconds',t+interval '90 seconds');
 if abs((partial#>>'{usage,estimatedRunningComputerHours}')::numeric*3600-60)>0.000001
  or abs((partial#>>'{usage,estimatedSuspendedComputerHours}')::numeric*3600-10)>0.000001 then
  raise exception 'Window-edge sample was not clipped correctly'; end if;
 partial:=public.qorpera_runtime_computer_history(a,t,t+interval '180 seconds');
 second_half:=public.qorpera_runtime_computer_history(a,t+interval '180 seconds',t+interval '360 seconds');
 if abs(((partial#>>'{usage,estimatedRunningComputerHours}')::numeric+(second_half#>>'{usage,estimatedRunningComputerHours}')::numeric)*3600-110)>0.000001
  then raise exception 'Partitioned windows double counted a computer'; end if;
 if public.qorpera_runtime_computer_history(a,t-interval '60 seconds',t)->'intervals'<>'[]'::jsonb
  or public.qorpera_runtime_computer_history(a,t+interval '360 seconds',t+interval '500 seconds')->'intervals'<>'[]'::jsonb
  then raise exception 'Usage escaped resource reservation/release'; end if;
 begin perform public.qorpera_runtime_computer_history(a,t,t+interval '25 hours');
  raise exception 'Oversized history window accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_runtime_computer_history(a,t,'infinity');
  raise exception 'Infinite history window accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.qorpera_runtime_computer_history(a,clock_timestamp(),clock_timestamp()+interval '1 hour');
  raise exception 'Future history window accepted'; exception when invalid_parameter_value then null; end;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 begin perform public.qorpera_runtime_computer_history(a,t,t+interval '1 hour');
  raise exception 'Member read operator history'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.qorpera_runtime_node_demands set released_at=null where allocation_id=a;
 result:=public.qorpera_runtime_computer_history(a,t+interval '1 day',t+interval '25 hours');
 if (result#>>'{usage,unknownHours}')::numeric<>1 or (result#>>'{usage,estimatedRunningComputerHours}')::numeric<>0
  then raise exception 'Missing history became zero usage'; end if;
 update public.qorpera_runtime_node_demands set reserved_at=null where allocation_id=a;
 if (public.qorpera_runtime_computer_history(a,t,t+interval '1 hour')#>>'{usage,reservedHours}')::numeric<>0
  then raise exception 'Pending demand became node reservation time'; end if;
 update public.qorpera_runtime_node_demands set reserved_at=t where allocation_id=a;
 insert into public.qorpera_runtime_node_observation_receipts(node_id,observation_id,observed_at,observation)
  select n,extensions.gen_random_uuid(),t+interval '1 day'+make_interval(secs=>s::double precision/10),'{"state":"unavailable"}'::jsonb
   from generate_series(1,20001) s;
 begin perform public.qorpera_runtime_computer_history(a,t+interval '1 day',t+interval '25 hours');
  raise exception 'Unbounded observation scan accepted'; exception when program_limit_exceeded then null; end;
 if exists(select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r
  where has_function_privilege(r,'public.qorpera_runtime_computer_history(uuid,timestamptz,timestamptz)','execute')) then
  raise exception 'Computer history leaked to a non-operator role'; end if;
end
$$;
rollback;
