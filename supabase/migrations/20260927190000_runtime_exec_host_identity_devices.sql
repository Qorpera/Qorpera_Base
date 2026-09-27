-- Shared execution host identity devices (2026-09-27).
--
-- Node 2's shared execution host (deploy/shared-execution) reads each member
-- login from a disk device identity-<uuid> that mounts the Compute Identity
-- volume <prefix><uuid> at /var/lib/qorpera/identities/<uuid>. Until now an
-- operator attached each new volume by hand, and the attach changed the host's
-- configuration digest, which the node inventory pins exactly: node 2 was
-- unavailable for all work until the inventory policy was re-enrolled. The
-- node's login gateway now attaches the volume itself (runner-orchestrator
-- lxd-execution-host-identity.ts).
--
-- An inventory policy's infrastructure entry may now declare identityVolumes
-- {pool, sourcePrefix} (virtual machines only). For such an entry the node
-- observer leaves devices of exactly the identity shape out of the digest and
-- reports their identities, sorted and distinct, as the entry's `identities`.
-- Everything else about the entry stays exact. The registry accepts a reported
-- identity only when this node reserved a login (or account refresh) machine
-- for it: the login gateway creates an identity volume only after that
-- reservation, so the check admits exactly the volumes the gateway can have
-- made. It does not depend on the identity's current home or status, so a
-- recovery in progress or a retired member never takes the node out. An
-- identity report the policy does not declare is refused outright; an
-- unexplained identity makes the node unavailable, like any other difference.
-- Policies without identityVolumes and observers that send no `identities`
-- behave exactly as before.

-- The check looks up login machines by identity; only login rows carry one.
create index qorpera_runtime_login_identity_allocations on public.qorpera_runtime_machine_allocations(login_compute_identity_id)
 where login_compute_identity_id is not null;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_enroll_runtime_node_inventory(jsonb)'::regprocedure), 'sha256'), 'hex') <> 'b6237b539b6547073c48494d63deb9c82d53f4113c864b47be9dd7b4fe1aeb9b' then
		raise exception 'Reviewed function definition changed: qorpera_enroll_runtime_node_inventory';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_enroll_runtime_node_inventory(p_policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_node public.qorpera_runtime_nodes%rowtype; v_previous jsonb; v_id uuid; v_host jsonb; v_item jsonb;
 v_cpu numeric; v_memory numeric; v_hash text;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_policy) is distinct from 'object'
  or p_policy-array['schema','nodeId','host','operatingCpuMillis','operatingMemoryBytes','infrastructure']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_policy))<>6
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-inventory-policy/v1' then
  raise exception 'Invalid node inventory policy' using errcode='42501'; end if;
 v_host:=p_policy->'host';
 if jsonb_typeof(v_host) is distinct from 'object'
  or v_host-array['machineIdSha256','socketPath','socketGid','certificateSha256','serverName','serverVersion','architecture']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(v_host))<>7
  or coalesce(v_host->>'machineIdSha256','') !~ '^[0-9a-f]{64}$' or coalesce(v_host->>'certificateSha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(v_host->>'serverName','') !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$'
  or coalesce(v_host->>'serverVersion','') !~ '^[A-Za-z0-9][A-Za-z0-9.+~-]{0,63}$'
  or coalesce(v_host->>'architecture','') not in ('x86_64','aarch64')
  or jsonb_typeof(v_host->'socketPath') is distinct from 'string' or left(v_host->>'socketPath',1)<>'/'
  or length(v_host->>'socketPath') not between 2 and 4096
  or jsonb_typeof(v_host->'socketGid') is distinct from 'number' or coalesce(v_host->>'socketGid','') !~ '^(0|[1-9][0-9]{0,9})$'
  or (v_host->>'socketGid')::numeric>4294967294
  or jsonb_typeof(p_policy->'infrastructure') is distinct from 'array' or jsonb_array_length(p_policy->'infrastructure')>256
  or exists(select 1 from unnest(array['operatingCpuMillis','operatingMemoryBytes']) k
   where jsonb_typeof(p_policy->k) is distinct from 'number' or coalesce(p_policy->>k,'') !~ '^[1-9][0-9]{0,15}$') then
  raise exception 'Invalid node inventory policy' using errcode='42501'; end if;
 begin v_id:=(p_policy->>'nodeId')::uuid;
 exception when invalid_text_representation then raise exception 'Invalid node inventory identity' using errcode='42501'; end;
 select * into v_node from public.qorpera_runtime_nodes where id=v_id for update;
 if not found or v_node.machine_id_sha256 is distinct from v_host->>'machineIdSha256' then
  raise exception 'Node inventory host differs' using errcode='42501'; end if;
 v_cpu:=(p_policy->>'operatingCpuMillis')::numeric; v_memory:=(p_policy->>'operatingMemoryBytes')::numeric;
 for v_item in select value from jsonb_array_elements(p_policy->'infrastructure') loop
  if jsonb_typeof(v_item) is distinct from 'object'
   or v_item-array['project','name','physicalId','type','configurationSha256','cpuMillis','memoryBytes','identityVolumes']<>'{}'::jsonb
   or (select count(*) from jsonb_object_keys(v_item))<>7+(v_item ? 'identityVolumes')::integer
   or (v_item ? 'identityVolumes' and (v_item->>'type' is distinct from 'virtual-machine'
    or jsonb_typeof(v_item->'identityVolumes') is distinct from 'object'
    or (v_item->'identityVolumes')-array['pool','sourcePrefix']<>'{}'::jsonb
    or (select count(*) from jsonb_object_keys(v_item->'identityVolumes'))<>2
    or jsonb_typeof(v_item->'identityVolumes'->'pool') is distinct from 'string'
    or jsonb_typeof(v_item->'identityVolumes'->'sourcePrefix') is distinct from 'string'
    or coalesce(v_item->'identityVolumes'->>'pool','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
    or coalesce(v_item->'identityVolumes'->>'sourcePrefix','') !~ '^[a-z][a-z0-9-]{0,31}$'))
   or coalesce(v_item->>'project','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' or coalesce(v_item->>'name','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
   or coalesce(v_item->>'physicalId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or coalesce(v_item->>'type','') not in ('virtual-machine','container') or coalesce(v_item->>'configurationSha256','') !~ '^[0-9a-f]{64}$'
   or exists(select 1 from unnest(array['cpuMillis','memoryBytes']) k where jsonb_typeof(v_item->k) is distinct from 'number'
    or coalesce(v_item->>k,'') !~ '^[1-9][0-9]{0,15}$') then raise exception 'Invalid infrastructure inventory policy' using errcode='42501'; end if;
  v_cpu:=v_cpu+(v_item->>'cpuMillis')::numeric; v_memory:=v_memory+(v_item->>'memoryBytes')::numeric;
 end loop;
 if v_cpu>v_node.headroom_cpu_millis or v_memory>v_node.headroom_memory_bytes
  or exists(select 1 from jsonb_array_elements(p_policy->'infrastructure') i group by i->>'project',i->>'name' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_policy->'infrastructure') i group by i->>'physicalId' having count(*)>1) then
  raise exception 'Infrastructure exceeds reserved headroom or duplicates identity' using errcode='42501'; end if;
 v_hash:=encode(extensions.digest(p_policy::text,'sha256'),'hex');
 insert into public.qorpera_runtime_node_inventory_policies(node_id,policy,policy_sha256) values(v_id,p_policy,v_hash) on conflict(node_id) do nothing;
 select policy into strict v_previous from public.qorpera_runtime_node_inventory_policies where node_id=v_id;
 if v_previous<>p_policy then raise exception 'Node inventory policy is immutable' using errcode='42501'; end if;
 return jsonb_build_object('nodeId',v_id,'policySha256',v_hash);
end
$function$;

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)'::regprocedure), 'sha256'), 'hex') <> '23440c8ba4b51cfc1ddc65e362df1eca8f44c0a6bdb14f695fd9b55b3714a58c' then
		raise exception 'Reviewed function definition changed: qorpera_observe_runtime_node_inventory';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_observe_runtime_node_inventory(p_observation jsonb, p_context_sha256 text, p_inventory jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid; v_observation uuid; v_context jsonb; v_old public.qorpera_runtime_node_inventory_receipts%rowtype;
 v_result jsonb; v_item jsonb; v_expected jsonb; v_binding jsonb; v_ready boolean:=true; v_policy jsonb; v_policy_hash text;
begin
 if auth.role() is distinct from 'service_role' or coalesce(p_context_sha256,'') !~ '^[0-9a-f]{64}$'
  or jsonb_typeof(p_inventory) is distinct from 'object' or p_inventory-array['schema','bootId','entries']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_inventory))<>3 or p_inventory->>'schema' is distinct from 'qorpera.runtime-node-inventory/v1'
  or coalesce(p_inventory->>'bootId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or jsonb_typeof(p_inventory->'entries') is distinct from 'array' or jsonb_array_length(p_inventory->'entries')>4096
  or octet_length(p_inventory::text)>4194304 then raise exception 'Invalid node inventory' using errcode='42501'; end if;
 begin v_id:=(p_observation->>'nodeId')::uuid; v_observation:=(p_observation->>'observationId')::uuid;
 exception when invalid_text_representation then raise exception 'Invalid node inventory identity' using errcode='42501'; end;
 perform 1 from public.qorpera_runtime_nodes where id=v_id for update;
 if not found then raise exception 'Node inventory host unconfigured' using errcode='42501'; end if;
 select * into v_old from public.qorpera_runtime_node_inventory_receipts where node_id=v_id and observation_id=v_observation;
 if found then
  if v_old.inventory<>p_inventory or v_old.context_sha256<>p_context_sha256 then raise exception 'Node inventory identity changed' using errcode='42501'; end if;
  return public.qorpera_observe_runtime_node(p_observation);
 end if;
 -- Never convert a historical hardware-only receipt into inventory authority.
 if exists(select 1 from public.qorpera_runtime_node_observation_receipts where node_id=v_id and observation_id=v_observation) then
  raise exception 'Existing hardware observation has no inventory authority' using errcode='42501'; end if;
 v_context:=public.qorpera_runtime_node_inventory_context(v_id);
 if v_context->>'contextSha256'<>p_context_sha256 then raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Node inventory ledger changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
 v_policy:=v_context->'policy';
 select policy_sha256 into strict v_policy_hash from public.qorpera_runtime_node_inventory_policies where node_id=v_id;
 if (v_policy->>'operatingCpuMillis')::numeric+coalesce((select sum((i->>'cpuMillis')::numeric) from jsonb_array_elements(v_policy->'infrastructure') i),0)>(v_context->>'headroomCpuMillis')::numeric
  or (v_policy->>'operatingMemoryBytes')::numeric+coalesce((select sum((i->>'memoryBytes')::numeric) from jsonb_array_elements(v_policy->'infrastructure') i),0)>(v_context->>'headroomMemoryBytes')::numeric then v_ready:=false; end if;
 for v_item in select value from jsonb_array_elements(p_inventory->'entries') loop
  if jsonb_typeof(v_item) is distinct from 'object'
   or v_item-array['project','name','physicalId','type','state','configurationSha256','cpuMillis','memoryBytes','allocation','category','reason','identities']<>'{}'::jsonb
   or (select count(*) from jsonb_object_keys(v_item))<>11+(v_item ? 'identities')::integer
   or (v_item ? 'identities' and (v_item->>'category' is distinct from 'infrastructure'
    or jsonb_typeof(v_item->'identities') is distinct from 'array' or jsonb_array_length(v_item->'identities')>4096
    or exists(select 1 from jsonb_array_elements(v_item->'identities') x where jsonb_typeof(x) is distinct from 'string'
     or x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or v_item->'identities'<>(select coalesce(jsonb_agg(x order by x#>>'{}' collate "C"),'[]'::jsonb)
     from (select distinct x from jsonb_array_elements(v_item->'identities') x) d)))
   or coalesce(v_item->>'project','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$' or coalesce(v_item->>'name','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
   or (v_item->'physicalId'<>'null'::jsonb and coalesce(v_item->>'physicalId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
   or coalesce(v_item->>'type','') not in ('virtual-machine','container')
   or coalesce(v_item->>'state','') not in ('starting','running','stopping','suspended','failed','unavailable')
   or coalesce(v_item->>'configurationSha256','') !~ '^[0-9a-f]{64}$'
   or coalesce(v_item->>'category','') not in ('managed','infrastructure','unmanaged')
   or (v_item->'reason'<>'null'::jsonb and coalesce(v_item->>'reason','') not in ('UNREGISTERED_INSTANCE','INSTANCE_AUTHORITY_DIFFERS','INSTANCE_STATE_UNAVAILABLE'))
   or exists(select 1 from unnest(array['cpuMillis','memoryBytes']) k where v_item->k<>'null'::jsonb and
    (jsonb_typeof(v_item->k) is distinct from 'number' or coalesce(v_item->>k,'') !~ '^[1-9][0-9]{0,15}$')) then
   raise exception 'Invalid node inventory entry' using errcode='42501'; end if;
  if v_item->>'category'='managed' then
   select a into v_expected from jsonb_array_elements(v_context->'allocations') a where a=v_item->'allocation';
   if not found or v_item->>'type'<>'virtual-machine' then raise exception 'Node inventory allocation differs' using errcode='42501'; end if;
   if v_item->'cpuMillis' is distinct from v_expected->'cpuMillis' or v_item->'memoryBytes' is distinct from v_expected->'memoryBytes' then v_ready:=false; end if;
   v_binding:=jsonb_build_object('project',v_item->'project','name',v_item->'name','physicalId',v_item->'physicalId','configurationSha256',v_item->'configurationSha256');
   if v_expected->'physical'<>'null'::jsonb and v_expected->'physical'<>v_binding then v_ready:=false;
   elsif v_item->'reason'='null'::jsonb and v_item->'physicalId'<>'null'::jsonb and v_item->>'state'<>'unavailable'
    and v_item->'cpuMillis'=v_expected->'cpuMillis' and v_item->'memoryBytes'=v_expected->'memoryBytes' then
    insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
     values((v_expected->>'allocationId')::uuid,v_id,(v_item->>'physicalId')::uuid,v_binding) on conflict(allocation_id) do nothing;
   end if;
  elsif v_item->>'category'='infrastructure' then
   if v_item->'allocation'<>'null'::jsonb then raise exception 'Infrastructure cannot hide an allocation' using errcode='42501'; end if;
   select i into v_expected from jsonb_array_elements(v_policy->'infrastructure') i where i->>'project'=v_item->>'project' and i->>'name'=v_item->>'name';
   if v_item ? 'identities' and (not found or not v_expected ? 'identityVolumes') then
    raise exception 'Node inventory reports identity devices its policy does not declare' using errcode='42501'; end if;
   if not found or v_expected ? 'identityVolumes' <> v_item ? 'identities'
    or v_expected-'identityVolumes'<>(v_item-array['state','allocation','category','reason','identities']) then v_ready:=false;
   -- An identity device mounts a volume only this node's login gateway creates, right after this
   -- node reserved a login or account-refresh machine for that identity. Nothing else is accepted.
   elsif v_item ? 'identities' and exists(select 1 from jsonb_array_elements_text(v_item->'identities') x(id)
    where not exists(select 1 from public.qorpera_runtime_machine_allocations a
     join public.qorpera_runtime_node_demands d on d.allocation_id=a.id
     where a.login_compute_identity_id=x.id::uuid and d.node_id=v_id and d.provider_kind='login' and d.reserved_at is not null)) then
    v_ready:=false;
   end if;
  else
   if v_item->'allocation'<>'null'::jsonb then raise exception 'Unmanaged instance cannot claim an allocation' using errcode='42501'; end if;
   v_ready:=false;
  end if;
  if v_item->'physicalId'='null'::jsonb or v_item->'cpuMillis'='null'::jsonb or v_item->'memoryBytes'='null'::jsonb
   or v_item->>'state'='unavailable' or v_item->'reason'<>'null'::jsonb then v_ready:=false; end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_inventory->'entries') i group by i->>'project',i->>'name' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_inventory->'entries') i where i->'physicalId'<>'null'::jsonb group by i->>'physicalId' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_inventory->'entries') i where i->'allocation'<>'null'::jsonb group by i->'allocation'->>'allocationId' having count(*)>1) then
  raise exception 'Node inventory duplicates identity' using errcode='42501'; end if;
 if p_observation->>'state'='ready' and not v_ready then raise exception 'Node inventory is not ready' using errcode='42501'; end if;
 v_result:=public.qorpera_observe_runtime_node(p_observation);
 insert into public.qorpera_runtime_node_inventory_receipts(node_id,observation_id,node_version,policy_sha256,context_sha256,inventory)
 values(v_id,v_observation,(v_context->>'nodeVersion')::bigint,v_policy_hash,p_context_sha256,p_inventory);
 return v_result;
end
$function$;
