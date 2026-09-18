-- Operator projection of retained physical evidence. This does not create
-- authority, release resources, or interpret screen/agent counts as computers.
create index qorpera_runtime_node_receipts_by_time
 on public.qorpera_runtime_node_observation_receipts(node_id,observed_at,observation_id);

create function public.qorpera_runtime_computer_history(p_allocation_id uuid,p_from timestamptz,p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_allocation public.qorpera_runtime_machine_allocations%rowtype;
 v_demand public.qorpera_runtime_node_demands%rowtype; v_binding jsonb;
 v_from timestamptz; v_until timestamptz; v_count bigint; v_intervals jsonb:='[]'; v_usage jsonb;
 v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Computer history requires operator authority' using errcode='42501'; end if;
 if p_allocation_id is null or p_from is null or p_until is null or not isfinite(p_from) or not isfinite(p_until)
  or p_from>=p_until or p_until-p_from>interval '24 hours' or p_until>statement_timestamp() then
  raise exception 'Computer history requires a finite past window of at most 24 hours' using errcode='22023'; end if;
 select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id;
 select * into v_demand from public.qorpera_runtime_node_demands where allocation_id=p_allocation_id;
 if v_allocation.id is null or v_demand.allocation_id is null then
  raise exception 'Computer placement history is unavailable' using errcode='22023'; end if;
 select binding into v_binding from public.qorpera_runtime_node_instance_bindings where allocation_id=p_allocation_id;
 v_from:=greatest(p_from,v_demand.reserved_at);
 v_until:=least(p_until,coalesce(v_demand.released_at,p_until));
 if v_demand.reserved_at is not null and v_from<v_until then
  -- A pathological publisher cannot make an unbounded operator response.
  -- Refuse the whole request; callers can partition the explicit time window.
  select count(*) into v_count from (select 1 from public.qorpera_runtime_node_observation_receipts
   where node_id=v_demand.node_id and observed_at>=v_from-interval '60 seconds' and observed_at<v_until
   limit 20001) r;
  if v_count>20000 then raise exception 'Computer history window has too many observations' using errcode='54000'; end if;
  with samples as materialized (
   select r.observed_at at,r.observation_id,i.inventory->>'bootId' boot_id,
    case when r.observation->>'state'='ready' and i.observation_id is not null
     and e.entry->>'category'='managed' and e.entry->'reason'='null'::jsonb
     and e.entry->'cpuMillis'=to_jsonb(v_demand.cpu_millis) and e.entry->'memoryBytes'=to_jsonb(v_demand.memory_bytes)
     and jsonb_build_object('project',e.entry->'project','name',e.entry->'name','physicalId',e.entry->'physicalId',
       'configurationSha256',e.entry->'configurationSha256')=v_binding
     then e.entry->>'state' else 'unknown' end state,
    case when r.observation->>'state'<>'ready' then 'NODE_UNAVAILABLE'
     when i.observation_id is null then 'INVENTORY_UNAVAILABLE'
     when e.entry is null then 'INSTANCE_NOT_OBSERVED'
     when e.entry->>'category'<>'managed' or e.entry->'reason'<>'null'::jsonb
      or e.entry->'cpuMillis' is distinct from to_jsonb(v_demand.cpu_millis)
      or e.entry->'memoryBytes' is distinct from to_jsonb(v_demand.memory_bytes)
      or jsonb_build_object('project',e.entry->'project','name',e.entry->'name','physicalId',e.entry->'physicalId',
       'configurationSha256',e.entry->'configurationSha256') is distinct from v_binding then 'INSTANCE_AUTHORITY_UNCONFIRMED'
     else 'PHYSICAL_INVENTORY_OBSERVATION' end reason
   from public.qorpera_runtime_node_observation_receipts r
   left join public.qorpera_runtime_node_inventory_receipts i using(node_id,observation_id)
   left join lateral (select entry from jsonb_array_elements(i.inventory->'entries') entry
    where entry#>>'{allocation,allocationId}'=p_allocation_id::text) e on true
   where r.node_id=v_demand.node_id and r.observed_at>=v_from-interval '60 seconds' and r.observed_at<v_until
  ), ordered as (
   select *,lead(at,1,v_until) over(order by at,observation_id) next_at from samples
  ), pieces as (
   select greatest(v_from,at) starts_at,least(v_until,next_at,at+interval '60 seconds') ends_at,
    state,reason,boot_id,observation_id from ordered
   union all
   select greatest(v_from,at+interval '60 seconds'),least(v_until,next_at),'unknown','OBSERVATION_STALE',null,null
    from ordered where at+interval '60 seconds'<least(v_until,next_at)
   union all
   select v_from,least(v_until,coalesce((select min(at) from samples),v_until)),
    'unknown','OBSERVATION_MISSING',null,null
  ), valid as (
   select * from pieces where starts_at<ends_at
  ), boundaries as (
   select *,case when row(state,reason,boot_id) is distinct from
    row(lag(state) over w,lag(reason) over w,lag(boot_id) over w) then 1 else 0 end boundary
    from valid window w as (order by starts_at)
  ), numbered as (
   select *,sum(boundary) over(order by starts_at) segment from boundaries
  ), merged as (
   select min(starts_at) starts_at,max(ends_at) ends_at,state,reason,boot_id,
    (array_agg(observation_id order by starts_at))[1] first_observation_id,
    (array_agg(observation_id order by starts_at desc))[1] last_observation_id
   from numbered group by segment,state,reason,boot_id
  ) select coalesce(jsonb_agg(jsonb_build_object('from',starts_at,'until',ends_at,'state',state,'reason',reason,
    'nodeBootId',boot_id,'firstObservationId',first_observation_id,'lastObservationId',last_observation_id,
    'seconds',extract(epoch from ends_at-starts_at)) order by starts_at),'[]') into v_intervals from merged;
 end if;
 select jsonb_build_object(
  'reservedHours',coalesce(sum((i->>'seconds')::numeric),0)/3600,
  'estimatedRunningComputerHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='running'),0)/3600,
  'estimatedSuspendedComputerHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='suspended'),0)/3600,
  'estimatedStartingHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='starting'),0)/3600,
  'estimatedStoppingHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='stopping'),0)/3600,
  'failedOrUnavailableHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state' in ('failed','unavailable')),0)/3600,
  'unknownHours',coalesce(sum((i->>'seconds')::numeric) filter(where i->>'state'='unknown'),0)/3600
 ) into v_usage from jsonb_array_elements(v_intervals) i;
 v_result:=jsonb_build_object('schema','qorpera.runtime-computer-history/v1','allocationId',p_allocation_id,
  'profileId',v_allocation.profile_id,'officeId',v_allocation.office_id,'runId',v_allocation.run_id,
  'loginSessionId',v_allocation.login_session_id,'computerGeneration',v_allocation.computer_generation,
  'placement',jsonb_build_object('source','local','nodeId',v_demand.node_id,'providerKind',v_demand.provider_kind,
   'providerId',v_demand.provider_id,'policySha256',v_demand.policy_sha256,'cpuMillis',v_demand.cpu_millis,
   'memoryBytes',v_demand.memory_bytes,'physical',v_binding),
  'requestedAt',v_demand.requested_at,'companyReservedAt',v_allocation.reserved_at,'nodeReservedAt',v_demand.reserved_at,
  'resourcesReleasedAt',v_demand.released_at,'from',p_from,'until',p_until,
  'method','physical_inventory_sample_hold','maximumSampleHoldSeconds',60,'exactTransitionTimes',false,
  'usage',v_usage,'intervals',v_intervals,'screenUsage',null);
 if octet_length(v_result::text)>4194304 then
  raise exception 'Computer history response requires a smaller window' using errcode='54000'; end if;
 return v_result;
end
$$;
revoke all on function public.qorpera_runtime_computer_history(uuid,timestamptz,timestamptz)
 from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_computer_history(uuid,timestamptz,timestamptz) to service_role;
