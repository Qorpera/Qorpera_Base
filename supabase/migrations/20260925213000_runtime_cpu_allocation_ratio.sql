-- Customer vCPU allocation is explicit policy, not physical hardware inventory.
-- Only the budget remaining after operating/infrastructure headroom is multiplied.
-- Memory, physical observations, VM costs, writer custody and infrastructure
-- headroom remain unchanged. Default 1 preserves admission until an operator
-- changes the versioned policy; this migration does not activate overcommit.
alter table public.qorpera_runtime_nodes add column cpu_allocation_ratio smallint not null default 1
 check(cpu_allocation_ratio in (1,2));

create function public.qorpera_runtime_node_cpu_budget(p_node public.qorpera_runtime_nodes)
returns bigint language sql immutable strict set search_path='' as $$
 select (p_node.cpu_millis-p_node.headroom_cpu_millis)*p_node.cpu_allocation_ratio
$$;
revoke all on function public.qorpera_runtime_node_cpu_budget(public.qorpera_runtime_nodes)
 from public,anon,authenticated,service_role;

-- The existing node-row lock/CAS also serializes ratio changes with admissions.
-- Lowering either budget is refused when occupied reservations no longer fit.
CREATE OR REPLACE FUNCTION public.qorpera_configure_runtime_node(p_policy jsonb, p_expected_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_node public.qorpera_runtime_nodes%rowtype; v_id uuid; v_cpu bigint; v_memory bigint; v_ratio smallint;
begin
 if auth.role() is distinct from 'service_role' or p_expected_version is null or p_expected_version not between 0 and 9007199254740990
  or jsonb_typeof(p_policy) is distinct from 'object'
  or p_policy-array['schema','nodeId','machineIdSha256','label','cpuMillis','memoryBytes','headroomCpuMillis','headroomMemoryBytes','standardCpuMillis','standardMemoryBytes','enabled','cpuAllocationRatio']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_policy))<>(case when p_policy ? 'cpuAllocationRatio' then 12 else 11 end)
  or (p_policy ? 'cpuAllocationRatio' and (jsonb_typeof(p_policy->'cpuAllocationRatio') is distinct from 'number'
   or p_policy->>'cpuAllocationRatio' not in ('1','2')))
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-policy/v1'
  or jsonb_typeof(p_policy->'enabled') is distinct from 'boolean' then
  raise exception 'Invalid node policy' using errcode='42501'; end if;
 begin
  v_id:=(p_policy->>'nodeId')::uuid;
  if v_id is null or coalesce(p_policy->>'machineIdSha256','') !~ '^[0-9a-f]{64}$'
   or coalesce(p_policy->>'label','') !~ '^[a-z][a-z0-9-]{0,62}$' then raise check_violation; end if;
  if exists(select 1 from unnest(array['cpuMillis','memoryBytes','headroomCpuMillis','headroomMemoryBytes','standardCpuMillis','standardMemoryBytes']) k
   where jsonb_typeof(p_policy->k) is distinct from 'number' or p_policy->>k !~ '^(0|[1-9][0-9]*)$') then raise check_violation; end if;
 exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node policy' using errcode='42501'; end;
 -- Serialize first registration as well as later edits; no company lock is
 -- taken from this node-only configuration path.
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||v_id::text,0));
 select * into v_node from public.qorpera_runtime_nodes where id=v_id for update;
 if (found and v_node.version<>p_expected_version) or (not found and p_expected_version<>0) then
  raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node policy version changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 if v_node.id is not null and v_node.machine_id_sha256<>p_policy->>'machineIdSha256' then
  raise exception 'Node host identity is immutable' using errcode='42501'; end if;
 -- Omission must not silently reset an operator's explicit ratio.
 v_ratio:=coalesce((p_policy->>'cpuAllocationRatio')::smallint,v_node.cpu_allocation_ratio,1);
 p_policy:=p_policy||jsonb_build_object('cpuAllocationRatio',v_ratio);
 select coalesce(sum(cpu_millis),0),coalesce(sum(memory_bytes),0) into v_cpu,v_memory
  from public.qorpera_runtime_node_demands where node_id=v_id and reserved_at is not null and released_at is null and suspended_at is null;
 begin
  if v_cpu>((p_policy->>'cpuMillis')::bigint-(p_policy->>'headroomCpuMillis')::bigint)*v_ratio
   or v_memory>(p_policy->>'memoryBytes')::bigint-(p_policy->>'headroomMemoryBytes')::bigint then
   raise exception 'Node policy would discard occupied capacity' using errcode='55000'; end if;
  insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,
   headroom_cpu_millis,headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled,cpu_allocation_ratio)
  values(v_id,p_policy->>'machineIdSha256',p_policy->>'label',p_expected_version+1,(p_policy->>'cpuMillis')::bigint,
   (p_policy->>'memoryBytes')::bigint,(p_policy->>'headroomCpuMillis')::bigint,(p_policy->>'headroomMemoryBytes')::bigint,
   (p_policy->>'standardCpuMillis')::bigint,(p_policy->>'standardMemoryBytes')::bigint,(p_policy->>'enabled')::boolean,v_ratio)
  on conflict(id) do update set label=excluded.label,version=excluded.version,cpu_millis=excluded.cpu_millis,
   memory_bytes=excluded.memory_bytes,headroom_cpu_millis=excluded.headroom_cpu_millis,headroom_memory_bytes=excluded.headroom_memory_bytes,
   standard_cpu_millis=excluded.standard_cpu_millis,standard_memory_bytes=excluded.standard_memory_bytes,
   enabled=excluded.enabled,cpu_allocation_ratio=excluded.cpu_allocation_ratio,updated_at=clock_timestamp() returning * into v_node;
 exception when numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node policy limits' using errcode='42501'; end;
 insert into public.qorpera_runtime_node_policies(node_id,version,policy) values(v_id,v_node.version,p_policy);
 return jsonb_build_object('nodeId',v_id,'version',v_node.version);
end
$function$;

-- Every CPU budget consumer uses the same formula. Physical eligibility
-- comparisons intentionally continue to use the real cpu_millis field.
do $cpu_budget$
declare v_patch record; v_definition text;
begin
 for v_patch in select * from (values
  ('public.qorpera_enroll_runtime_node_provider(uuid,text,text,text,text,bigint,bigint)', 'v_node.cpu_millis-v_node.headroom_cpu_millis', 'public.qorpera_runtime_node_cpu_budget(v_node)', 1),
  ('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)', 'v_node.cpu_millis-v_node.headroom_cpu_millis', 'public.qorpera_runtime_node_cpu_budget(v_node)', 1),
  ('public.qorpera_runtime_node_capacity(uuid)', 'v_node.cpu_millis-v_node.headroom_cpu_millis', 'public.qorpera_runtime_node_cpu_budget(v_node)', 1),
  ('public.qorpera_runtime_node_capacity(uuid)', '''capacityBasis'',''configured resources minus headroom and unreleased reservations''', '''capacityBasis'',''CPU: (physical minus headroom) times allocation ratio minus reservations; memory: physical minus headroom minus reservations'',
  ''physicalCpuMillis'',v_node.cpu_millis,''headroomCpuMillis'',v_node.headroom_cpu_millis,
  ''cpuAllocationRatio'',v_node.cpu_allocation_ratio,''allocatableCpuMillis'',public.qorpera_runtime_node_cpu_budget(v_node)', 1),
  ('public.qorpera_runtime_node_placement_candidates(text)', 'n.cpu_millis-n.headroom_cpu_millis', 'public.qorpera_runtime_node_cpu_budget(n)', 2),
  ('public.qorpera_coding_executor_pick(uuid)', 'node.cpu_millis - node.headroom_cpu_millis', 'public.qorpera_runtime_node_cpu_budget(node)', 2),
  ('public.qorpera_place_runtime_office_fleet(jsonb,bigint)', 'n.cpu_millis-n.headroom_cpu_millis', 'public.qorpera_runtime_node_cpu_budget(n)', 1)
 ) as patches(signature,old_text,new_text,expected_count) loop
  v_definition:=pg_get_functiondef(v_patch.signature::regprocedure);
  if (length(v_definition)-length(replace(v_definition,v_patch.old_text,'')))/length(v_patch.old_text)<>v_patch.expected_count then
   raise exception 'CPU allocation ratio function differs: %',v_patch.signature;
  end if;
  execute replace(v_definition,v_patch.old_text,v_patch.new_text);
 end loop;
end
$cpu_budget$;
