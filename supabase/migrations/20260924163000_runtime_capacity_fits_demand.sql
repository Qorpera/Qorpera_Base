-- Node capacity reports free CPU and memory, the numbers admission uses (bundle v96).
--
-- Admission already compares each machine's own size with what is left:
-- `qorpera_reserve_runtime_node_machine` admits a demand when its own
-- cpu_millis and memory_bytes fit in (configured - headroom - reserved,
-- unsuspended demands), under the node row lock, for every kind (runs, login
-- machines, company computers, coding VMs). The placement candidates' `fits`
-- is the same test. Nothing requires a whole free standard slot.
--
-- The capacity view reported only `admissibleSlots`: whole standard slots
-- (8 vCPU / 16 GiB on node 2). A node with 6 vCPU free showed 0 slots although
-- three more 2-vCPU coding VMs fit, which reads as "full" (2026-09-24).
--
-- The view now also reports `freeCpuMillis` and `freeMemoryBytes`: configured
-- resources minus headroom minus reserved, unsuspended demands, never below 0,
-- and 0 while the node is not eligible (as `admissibleSlots`). A machine of
-- size (cpu, memory) is admitted exactly when cpu <= freeCpuMillis and
-- memory <= freeMemoryBytes. `admissibleSlots` stays, unchanged, for the
-- fleet page and older readers; the schema name stays v1 (keys only added).
-- Restated from the current definition (20260908003900, patched by
-- 20260923060000 to skip suspended demands).

create or replace function public.qorpera_runtime_node_capacity(p_node_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_observation public.qorpera_runtime_node_observations%rowtype;
 v_cpu bigint; v_memory bigint; v_allocated bigint; v_pending bigint; v_companies bigint; v_eligible boolean; v_slots bigint;
 v_free_cpu bigint; v_free_memory bigint;
begin
 if auth.role() is distinct from 'service_role' or p_node_id is null then raise exception 'Operator authority required' using errcode='42501'; end if;
 select * into v_node from public.qorpera_runtime_nodes where id=p_node_id for share;
 if not found then return '{"schema":"qorpera.runtime-node-capacity/v1","state":"unconfigured","admissibleSlots":0,"freeCpuMillis":0,"freeMemoryBytes":0,"overflow":"unavailable"}'::jsonb; end if;
 select * into v_observation from public.qorpera_runtime_node_observations where node_id=p_node_id;
 select coalesce(sum(d.cpu_millis),0),coalesce(sum(d.memory_bytes),0),count(*),count(distinct a.profile_id)
  into v_cpu,v_memory,v_allocated,v_companies from public.qorpera_runtime_node_demands d
  join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  where d.node_id=p_node_id and d.reserved_at is not null and d.released_at is null and d.suspended_at is null;
 select count(*) into v_pending from public.qorpera_runtime_node_demands d
  join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  where d.node_id=p_node_id and d.reserved_at is null and a.released_at is null;
 v_eligible:=v_node.enabled and v_observation.observed_at>clock_timestamp()-interval '60 seconds'
  and v_observation.observed_at<=clock_timestamp()+interval '2 seconds' and v_observation.observation->>'state'='ready'
  and public.qorpera_runtime_node_inventory_ready(v_node.id,v_observation.observation_id,v_node.version)
  and (v_observation.observation->>'cpuMillis')::bigint>=v_node.cpu_millis
  and (v_observation.observation->>'memoryBytes')::bigint>=v_node.memory_bytes;
 v_free_cpu:=greatest(0,v_node.cpu_millis-v_node.headroom_cpu_millis-v_cpu);
 v_free_memory:=greatest(0,v_node.memory_bytes-v_node.headroom_memory_bytes-v_memory);
 v_slots:=least(v_free_cpu/v_node.standard_cpu_millis,v_free_memory/v_node.standard_memory_bytes);
 return jsonb_build_object('schema','qorpera.runtime-node-capacity/v1','nodeId',v_node.id,'label',v_node.label,'version',v_node.version,
  'state',case when coalesce(v_eligible,false) then 'eligible' else 'unavailable' end,
  'observedAt',v_observation.observed_at,'asOf',clock_timestamp(),'capacityBasis','configured resources minus headroom and unreleased reservations',
  'admissionBasis','a machine is admitted when its own CPU and memory fit in freeCpuMillis and freeMemoryBytes',
  'allocatedCpuMillis',v_cpu,'allocatedMemoryBytes',v_memory,'allocatedComputers',v_allocated,'allocatedCompanies',v_companies,
  'pendingRequests',v_pending,'standardCpuMillis',v_node.standard_cpu_millis,'standardMemoryBytes',v_node.standard_memory_bytes,
  'freeCpuMillis',case when coalesce(v_eligible,false) then v_free_cpu else 0 end,
  'freeMemoryBytes',case when coalesce(v_eligible,false) then v_free_memory else 0 end,
  'admissibleSlots',case when coalesce(v_eligible,false) then v_slots else 0 end,'overflow','unavailable',
  'physicalComputerStates','not supplied by this reservation view','activeUsers',null,'activeUserSource','not observed');
end
$$;
