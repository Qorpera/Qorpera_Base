-- The operator's views show a company's machines and each node's machines by state (launch checklist L28.2; the gap
-- test 424 found).
--
-- qorpera_runtime_compute_requests lists a company's office starts, logins, native jobs and refusals. It now also lists
-- the company's machines, as kind 'machine' (between 'login' and 'native' in its (kind, id) order):
--  * each folder-v2 company machine that is not removed (qorpera_company_machines; a coding machine started in the
--    folder is one of them), in the state the company sees (waiting, starting, running, stopping, stopped, deleting):
--    its request id is the machine id; while it waits, its place in line and what it waits for (NODE_CAPACITY_EXHAUSTED,
--    or COMPUTER_HOURS_EXHAUSTED), read from the same qorpera_company_machine_view members read;
--  * each unreleased coding machine allocation (coding_worker_id or coding_machine_id): its request id is the
--    allocation id; it is unassigned before it asks a node, requested, refused with the node's reason, reserved or
--    released.
-- A machine's placements hold its current node allocation and its node, in the same shape as the other kinds; a
-- machine waiting in line has none (no node). Every existing kind, record and field stays as it was;
-- 'machineCoverage' says what the new kind covers. The machines are found through the existing indexes
-- qorpera_company_machines_name (profile_id, name) where removed_at is null and qorpera_runtime_machine_occupied
-- (profile_id) where released_at is null; a placement is read by its allocation's primary key.
--
-- qorpera_runtime_node_capacity said 'physicalComputerStates': 'not supplied by this reservation view'. It now counts
-- the node's managed machines by state (starting, running, stopping, suspended, failed or unavailable) as the node's
-- newest inventory reports them, with that observation's id and time. The newest observation is the node's one row in
-- qorpera_runtime_node_observations (primary key node_id); its inventory is the one receipt read through
-- qorpera_runtime_node_inventory_receipts_pkey (node_id, observation_id), the lookup qorpera_runtime_node_computers
-- and the capacity view's own readiness check already make. No older receipt is read and no index is added. It is
-- null while the newest observation has no inventory. pendingRequests still counts node reservations only.
--
-- Both functions are patched in place from their live definitions (as 20260925213000 did), so security definer,
-- volatility, search_path and grants (the service role only) stay exactly as they are. Each patch must match once.
do $operator_views$
declare v_signature text; v_definition text; v_patch text[];
begin
 foreach v_signature in array array['public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)',
  'public.qorpera_runtime_node_capacity(uuid)'] loop
  v_definition:=pg_get_functiondef(v_signature::regprocedure);
  foreach v_patch slice 1 in array case v_signature when 'public.qorpera_runtime_node_capacity(uuid)' then array[
   [$o$'physicalComputerStates','not supplied by this reservation view'$o$,
    $n$'physicalComputerStates',(select jsonb_build_object('source','newest_node_inventory','observationId',i.observation_id,
   'observedAt',v_observation.observed_at,'allocations',count(e.entry),
   'starting',count(*) filter(where e.entry->>'state'='starting'),'running',count(*) filter(where e.entry->>'state'='running'),
   'stopping',count(*) filter(where e.entry->>'state'='stopping'),'suspended',count(*) filter(where e.entry->>'state'='suspended'),
   'failedOrUnavailable',count(*) filter(where e.entry->>'state' in ('failed','unavailable')))
  from public.qorpera_runtime_node_inventory_receipts i
  left join lateral jsonb_array_elements(i.inventory->'entries') e(entry) on e.entry->>'category'='managed'
  where i.node_id=v_node.id and i.observation_id=v_observation.observation_id group by i.observation_id)$n$]]
  else array[
   [$o$'native','login','capacity_refusal')) then$o$, $n$'native','login','capacity_refusal','machine')) then$n$],
   [$o$  where j.profile_id=p_company_id
 ), page as materialized ($o$, $n$  where j.profile_id=p_company_id
  union all
  select 'machine'::text,m.id,m.created_at,v.machine->>'state',
   jsonb_build_object('machineSource','company_machine','machineId',m.id,'allocationId',v.placement_id,'name',m.name,
    'codingWorkerId',m.repository_worker_id,'cpuMillis',m.cpus::bigint*1000,'memoryBytes',m.memory_bytes,'diskBytes',m.disk_bytes,
    'lifetime',m.lifetime,'desiredState',m.desired_state,'wantedAt',m.wanted_at,'startedByRunId',m.started_by_run_id,
    'queuePosition',v.machine->'queuePosition','reason',v.machine->'waitingFor','lastError',m.last_error)
  from public.qorpera_company_machines m
  cross join lateral (select public.qorpera_company_machine_view(m) machine,(public.qorpera_company_machine_placement(m.id)).id placement_id) v
  where m.profile_id=p_company_id and m.removed_at is null
  union all
  select 'machine'::text,a.id,a.reserved_at,
   case when d.allocation_id is null then 'unassigned' when d.released_at is not null then 'released'
    when d.reserved_at is not null then 'reserved' when d.last_refusal is not null then 'refused' else 'requested' end,
   jsonb_build_object('machineSource','coding_machine','machineId',a.coding_machine_id,'allocationId',a.id,'name',null,
    'codingWorkerId',a.coding_worker_id,'cpuMillis',d.cpu_millis,'memoryBytes',d.memory_bytes,'diskBytes',null,
    'lifetime',null,'desiredState',null,'wantedAt',d.requested_at,'startedByRunId',null,
    'queuePosition',null,'reason',case when d.reserved_at is null then d.last_refusal end,'lastError',null)
  from public.qorpera_runtime_machine_allocations a left join public.qorpera_runtime_node_demands d on d.allocation_id=a.id
  where a.profile_id=p_company_id and a.released_at is null and (a.coding_worker_id is not null or a.coding_machine_id is not null)
 ), page as materialized ($n$],
   [$o$'placements',public.qorpera_runtime_request_placements(kind,id),$o$,
    $n$'placements',case when kind='machine' then (select coalesce(jsonb_agg(jsonb_build_object('allocationId',a.id,
    'instanceSha256',a.instance_sha256,'providerAdapter',a.provider_adapter,'companyReservedAt',a.reserved_at,
    'companyReleasedAt',a.released_at,'nodeId',d.node_id,'source',case when d.node_id is not null then 'local' else null end,
    'providerKind',d.provider_kind,'providerId',d.provider_id,'policySha256',d.policy_sha256,'nodeRequestedAt',d.requested_at,
    'nodeReservedAt',d.reserved_at,'nodeReleasedAt',d.released_at,'lastAdmissionCheckAt',d.last_checked_at,
    'lastAdmissionRefusal',d.last_refusal,'nodePlacementState',case when d.node_id is null then 'unassigned'
     when d.reserved_at is null then 'requested' when d.released_at is null then 'reserved' else 'released' end,
    'physicalProvisioningOutcome',null,'physicalStateQuery','qorpera_runtime_node_computers')),'[]'::jsonb)
    from public.qorpera_runtime_machine_allocations a left join public.qorpera_runtime_node_demands d on d.allocation_id=a.id
    where a.id=(details->>'allocationId')::uuid)
    else public.qorpera_runtime_request_placements(kind,id) end,$n$],
   [$o$'coverage','retained_office_intents_login_sessions_native_jobs_and_unallocated_company_refusals',$o$,
    $n$'coverage','retained_office_intents_login_sessions_native_jobs_and_unallocated_company_refusals',
  'machineCoverage','current_company_machines_and_unreleased_coding_machines',$n$]] end loop
   if (length(v_definition)-length(replace(v_definition,v_patch[1],'')))/length(v_patch[1])<>1 then
    raise exception 'Operator view % differs from its expected definition at: %',v_signature,v_patch[1];
   end if;
   v_definition:=replace(v_definition,v_patch[1],v_patch[2]);
  end loop;
  execute v_definition;
 end loop;
end
$operator_views$;
