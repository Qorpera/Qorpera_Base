-- Operator projection of retained complete-host observations, including
-- infrastructure and unmanaged instances that have no company allocation.
-- Historical/rejected/stale observations remain evidence, never spare capacity.
create function public.qorpera_runtime_host_inventory(
 p_node_id uuid,p_observation_id uuid default null,p_after_project text default null,
 p_after_name text default null,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare n public.qorpera_runtime_nodes%rowtype; latest public.qorpera_runtime_node_observations%rowtype;
 o public.qorpera_runtime_node_observation_receipts%rowtype; i public.qorpera_runtime_node_inventory_receipts%rowtype;
 v_at timestamptz:=statement_timestamp(); v_reason text; v_id uuid; v_records jsonb; v_more boolean;
 v_next_project text; v_next_name text; v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Operator authority required' using errcode='42501'; end if;
 if p_node_id is null or p_limit is null or p_limit not between 1 and 1000
  or (p_after_project is null)<>(p_after_name is null)
  or (p_after_project is not null and (p_observation_id is null
   or p_after_project !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' or p_after_name !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$')) then
  raise exception 'Invalid host inventory page' using errcode='22023'; end if;
 select * into n from public.qorpera_runtime_nodes where id=p_node_id;
 if not found then raise exception 'Node is not configured' using errcode='22023'; end if;
 select * into latest from public.qorpera_runtime_node_observations where node_id=n.id;
 v_id:=coalesce(p_observation_id,latest.observation_id);
 select * into o from public.qorpera_runtime_node_observation_receipts where node_id=n.id and observation_id=v_id;
 if p_observation_id is not null and o.node_id is null then
  raise exception 'Observation is unavailable for this node' using errcode='22023'; end if;
 select * into i from public.qorpera_runtime_node_inventory_receipts where node_id=n.id and observation_id=v_id;
 if o.node_id is null then v_reason:='OBSERVATION_MISSING';
 elsif o.observation_id is distinct from latest.observation_id then v_reason:='OBSERVATION_SUPERSEDED';
 elsif o.observed_at<=v_at-interval '60 seconds' then v_reason:='OBSERVATION_STALE';
 elsif o.observed_at>v_at+interval '2 seconds' then v_reason:='OBSERVATION_TIME_UNCONFIRMED';
 elsif i.node_id is null then v_reason:='INVENTORY_MISSING';
 elsif not public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version) then v_reason:='INVENTORY_POLICY_CHANGED';
 elsif o.observation->>'state'<>'ready' then v_reason:='NODE_UNAVAILABLE';
 elsif (o.observation->>'cpuMillis')::bigint<n.cpu_millis or (o.observation->>'memoryBytes')::bigint<n.memory_bytes then
  v_reason:='NODE_HARDWARE_CHANGED'; end if;
 with page as materialized (
  select entry,entry->>'project' project,entry->>'name' name from jsonb_array_elements(i.inventory->'entries') entry
  where p_after_project is null or (entry->>'project',entry->>'name')>(p_after_project,p_after_name)
  order by entry->>'project',entry->>'name' limit p_limit+1
 ), selected as (
  select *,row_number() over(order by project,name) ordinal from page
 ), records as (
  select project,name,jsonb_build_object('project',project,'name',name,'physicalId',entry->'physicalId',
   'type',entry->'type','category',entry->'category','reportedState',entry->'state','reportedReason',entry->'reason',
   'currentState',case when v_reason is null and entry->'reason'='null'::jsonb then entry->>'state' else 'unknown' end,
   'currentStateReason',coalesce(v_reason,entry->>'reason','PHYSICAL_INVENTORY_OBSERVATION'),
   'configurationSha256',entry->'configurationSha256','cpuMillis',entry->'cpuMillis','memoryBytes',entry->'memoryBytes',
   'recordedAllocation',entry->'allocation','companyId',a.profile_id,
   'jobActivity',null,'jobActivityQuery','qorpera_runtime_node_computers','resourceReleaseInferred',false) record
  from selected left join public.qorpera_runtime_machine_allocations a on a.id=(entry#>>'{allocation,allocationId}')::uuid
  where ordinal<=p_limit
 ) select coalesce(jsonb_agg(record order by project,name),'[]'),(select count(*)>p_limit from page),
  (array_agg(project order by project desc,name desc))[1],(array_agg(name order by project desc,name desc))[1]
  into v_records,v_more,v_next_project,v_next_name from records;
 v_result:=jsonb_build_object('schema','qorpera.runtime-host-inventory/v1','nodeId',n.id,'source','local','asOf',v_at,
  'nodeEnabled',n.enabled,'machineIdSha256',n.machine_id_sha256,'observationId',o.observation_id,'observedAt',o.observed_at,
  'receivedAt',o.received_at,'bootId',i.inventory->'bootId','nodeVersion',i.node_version,'policySha256',i.policy_sha256,
  'reportedNodeState',o.observation->'state','currentStateReason',v_reason,'currentStateAvailable',v_reason is null,
  'entries',v_records,'reportedEntryCount',case when i.node_id is not null then jsonb_array_length(i.inventory->'entries') else null end,
  'coverage',case when i.node_id is not null and o.observation->>'state'='ready' then 'complete_host_observation' else 'unconfirmed_observation_entries' end,
  'hasMore',v_more,'nextProject',case when v_more then v_next_project else null end,'nextName',case when v_more then v_next_name else null end,
  'entrySnapshotAcrossPages',true,'currentStateRecheckedPerPage',true,'admissionCapacityQuery','qorpera_runtime_node_capacity',
  'allocatedComputersQuery','qorpera_runtime_node_computers','healthQuery','qorpera_runtime_node_health','overflow','unavailable',
  'observerPackageSha256',null,'observerPackageSource','not_recorded_in_inventory_receipt','resourceReleaseInferred',false);
 if octet_length(v_result::text)>4194304 then raise exception 'Host inventory page requires a smaller limit' using errcode='54000'; end if;
 return v_result;
end
$$;
revoke all on function public.qorpera_runtime_host_inventory(uuid,uuid,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_host_inventory(uuid,uuid,text,text,integer) to service_role;
