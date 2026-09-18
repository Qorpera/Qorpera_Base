-- Current operator evidence, independent of admission and estimated usage.
-- A live job lease is recorded activity, not CPU utilization. Unconfirmed
-- resources/drains prevent a computer from being classified as without work.
create index qorpera_runtime_node_computer_page on public.qorpera_runtime_node_demands(node_id,allocation_id);
create function public.qorpera_runtime_computer_job_activity(
 p_allocation public.qorpera_runtime_machine_allocations,p_as_of timestamptz)
returns jsonb language sql stable set search_path = '' as $$
 with links as (
  select p_allocation.run_id run_id,true current_link where p_allocation.run_id is not null
  union all
  select s.run_id,coalesce(s.lease_id is not null and s.lease_expires_at>p_as_of and not s.drain_pending,false)
   from public.qorpera_runtime_office_screens s join public.qorpera_runtime_offices o on o.id=s.office_id
   where s.office_id=p_allocation.office_id and o.generation=p_allocation.computer_generation and s.run_id is not null
  union all
  select r.run_id,r.state='active' and r.expires_at>p_as_of
   from public.qorpera_runtime_office_resources r where r.office_id=p_allocation.office_id and r.state<>'drained'
    and r.screen_lease#>>'{binding,computerGeneration}'=p_allocation.computer_generation::text
 ), runs as (
  select run_id,bool_or(current_link) current_link from links group by run_id
 ), jobs as (
  select j.id,j.status,
   coalesce(r.current_link and j.status in ('leased','running') and j.lease_expires_at>p_as_of
    and (p_allocation.runner_id is null or j.runner_id=p_allocation.runner_id),false) active,
   j.id is null or (j.status in ('leased','running') and
    (not r.current_link or j.lease_expires_at is null or j.lease_expires_at<=p_as_of
     or (p_allocation.runner_id is not null and j.runner_id is distinct from p_allocation.runner_id))) uncertain
   from runs r left join public.qorpera_execution_runs e on e.id=r.run_id
   left join public.qorpera_runner_jobs j on j.id=e.job_id
 ), unresolved as (
  select (select count(*) from public.qorpera_runtime_office_resources r
   where r.office_id=p_allocation.office_id and r.state<>'drained'
    and r.screen_lease#>>'{binding,computerGeneration}'=p_allocation.computer_generation::text
    and (r.state<>'active' or r.expires_at<=p_as_of))
   +(select count(*) from public.qorpera_runtime_office_screens s join public.qorpera_runtime_offices o on o.id=s.office_id
    where s.office_id=p_allocation.office_id and o.generation=p_allocation.computer_generation
     and (s.drain_pending or (s.run_id is not null and (s.lease_expires_at is null or s.lease_expires_at<=p_as_of)))) n
 ), totals as (
  select count(*) filter(where active) active,count(*) filter(where uncertain)+(select n from unresolved) uncertain from jobs
 ) select jsonb_build_object('state',case when active>0 then 'active' when uncertain>0 then 'unknown' else 'none_recorded' end,
  'knownActiveJobCount',active,'countComplete',uncertain=0,'uncertainRecordCount',uncertain,
  'source','job_leases_and_office_screen_resource_records','asOf',p_as_of,
  'measuredCpuIdle',null) from totals
$$;
revoke all on function public.qorpera_runtime_computer_job_activity(public.qorpera_runtime_machine_allocations,timestamptz)
 from public,anon,authenticated,service_role;

create function public.qorpera_runtime_node_computers(p_node_id uuid,p_after_allocation_id uuid default null,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare n public.qorpera_runtime_nodes%rowtype; o public.qorpera_runtime_node_observations%rowtype;
 i public.qorpera_runtime_node_inventory_receipts%rowtype;
 v_at timestamptz:=statement_timestamp(); v_reason text; v_computers jsonb; v_more boolean; v_next uuid; v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Operator authority required' using errcode='42501'; end if;
 if p_node_id is null or p_limit is null or p_limit not between 1 and 1000 then
  raise exception 'Invalid node computer page' using errcode='22023'; end if;
 select * into n from public.qorpera_runtime_nodes where id=p_node_id;
 if not found then raise exception 'Node is not configured' using errcode='22023'; end if;
 select * into o from public.qorpera_runtime_node_observations where node_id=n.id;
 select * into i from public.qorpera_runtime_node_inventory_receipts where node_id=n.id and observation_id=o.observation_id;
 if o.node_id is null then v_reason:='OBSERVATION_MISSING';
 elsif o.observed_at<=v_at-interval '60 seconds' then v_reason:='OBSERVATION_STALE';
 elsif o.observed_at>v_at+interval '2 seconds' then v_reason:='OBSERVATION_TIME_UNCONFIRMED';
 elsif o.observation->>'state'<>'ready' then v_reason:='NODE_UNAVAILABLE';
 elsif not public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version) then v_reason:='INVENTORY_UNAVAILABLE';
 elsif (o.observation->>'cpuMillis')::bigint<n.cpu_millis or (o.observation->>'memoryBytes')::bigint<n.memory_bytes
  then v_reason:='NODE_HARDWARE_CHANGED'; end if;
 with page as materialized (
  select a,d.reserved_at node_reserved_at,d.released_at node_released_at,d.requested_at,d.last_checked_at,d.last_refusal,
   d.provider_kind,d.provider_id,d.policy_sha256,d.cpu_millis,d.memory_bytes,b.binding,
   public.qorpera_runtime_computer_job_activity(a,v_at) activity
  from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  left join public.qorpera_runtime_node_instance_bindings b on b.allocation_id=a.id and b.node_id=d.node_id
  where d.node_id=n.id and (a.released_at is null or (d.reserved_at is not null and d.released_at is null))
   and (p_after_allocation_id is null or a.id>p_after_allocation_id)
  order by a.id limit p_limit+1
 ), selected as (
  select *,row_number() over(order by (a).id) ordinal from page
 ), physical as (
  select p.*,e.entry,
   case when v_reason is not null then v_reason
    when p.node_reserved_at is null then 'NODE_CAPACITY_PENDING'
    when e.entry is null then 'INSTANCE_NOT_OBSERVED'
    when e.entry->>'category'<>'managed' or e.entry->'reason'<>'null'::jsonb
     or e.entry->'cpuMillis' is distinct from to_jsonb(p.cpu_millis) or e.entry->'memoryBytes' is distinct from to_jsonb(p.memory_bytes)
     or jsonb_build_object('project',e.entry->'project','name',e.entry->'name','physicalId',e.entry->'physicalId',
      'configurationSha256',e.entry->'configurationSha256') is distinct from p.binding then 'INSTANCE_AUTHORITY_UNCONFIRMED'
    else null end physical_reason
  from selected p left join lateral (select entry from jsonb_array_elements(i.inventory->'entries') entry
   where entry#>>'{allocation,allocationId}'=(p.a).id::text) e on true where ordinal<=p_limit
 ), records as (
  select (a).id id,jsonb_build_object('allocationId',(a).id,'companyId',(a).profile_id,'officeId',(a).office_id,
   'runId',(a).run_id,'loginSessionId',(a).login_session_id,'computerGeneration',(a).computer_generation,
   'source','local','nodeId',n.id,'providerKind',provider_kind,'providerId',provider_id,'policySha256',policy_sha256,
   'instanceSha256',(a).instance_sha256,'physicalBinding',binding,
   'companyReservedAt',(a).reserved_at,'companyReleasedAt',(a).released_at,
   'nodeRequestedAt',requested_at,'nodeReservedAt',node_reserved_at,'nodeReleasedAt',node_released_at,
   'nodeAllocationState',case when node_reserved_at is null then 'pending' when node_released_at is null then 'reserved' else 'released' end,
   'lastAdmissionCheckAt',last_checked_at,'lastAdmissionRefusal',last_refusal,'cpuMillis',cpu_millis,'memoryBytes',memory_bytes,
   'physicalState',case when physical_reason is null then entry->>'state' else 'unknown' end,
   'physicalStateReason',coalesce(physical_reason,'PHYSICAL_INVENTORY_OBSERVATION'),
   'observationId',o.observation_id,'observedAt',o.observed_at,'jobActivity',activity,
   'runningWorkState',case when physical_reason is not null or entry->>'state'<>'running' then 'not_classified'
    when activity->>'state'='active' then 'with_active_jobs'
    when activity->>'state'='none_recorded' then 'without_recorded_active_jobs' else 'unknown' end,
   'capacityReleaseInferredFromActivity',false) record from physical
 ) select coalesce(jsonb_agg(record order by id),'[]'),(select count(*)>p_limit from page),
  (array_agg(id order by id desc))[1] into v_computers,v_more,v_next from records;
 v_result:=jsonb_build_object('schema','qorpera.runtime-node-computers/v1','nodeId',n.id,'asOf',v_at,
  'computers',v_computers,'hasMore',v_more,'nextAllocationId',case when v_more then v_next else null end,
  'snapshotAcrossPages',false,'coverage','unreleased_company_or_node_allocations_with_node_demand',
  'observationId',o.observation_id,'observedAt',o.observed_at,'observationUnavailableReason',v_reason,
  'admissionCapacityQuery','qorpera_runtime_node_capacity','overflow','unavailable',
  'cpuUtilization',null,'memoryUtilization',null,'freeDiskBytes',null,'healthMeasurements','separate diagnostic query',
  'healthQuery','qorpera_runtime_node_health',
  'humanActivity',null,'humanActivitySource','separate operator query','humanActivityQuery','qorpera_runtime_compute_users');
 if octet_length(v_result::text)>4194304 then raise exception 'Node computer page requires a smaller limit' using errcode='54000'; end if;
 return v_result;
end
$$;
revoke all on function public.qorpera_runtime_node_computers(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_node_computers(uuid,uuid,integer) to service_role;
