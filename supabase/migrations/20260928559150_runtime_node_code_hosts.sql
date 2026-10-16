-- 20260930397000: step 5e-3a, the code hosts in a node's inventory (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
-- "The code host"). Each company with a code host on a node has its own LXD project there, qorpera-codehost-<company
-- id without dashes>, holding one virtual machine, code-host, that the coding executor makes and starts on the
-- company's first coding job and stops when its jobs are done (runner-orchestrator code-host.ts). It is no allocation:
-- the node holds its room back the way it holds the build space back.
-- 1. qorpera_enroll_runtime_node_inventory accepts an optional `codeHosts {imageFingerprint, storagePool, cpus,
--    memoryBytes, rootDiskBytes, running}` (cpus and running 1-64, memory 1-1024 GiB and the root disk 10-2048 GiB in
--    whole GiB) and reserves running x cpus and running x memoryBytes against the node's headroom, whether any code
--    host runs or not. Neither an infrastructure entry nor the build space may sit in a code host project.
-- 2. qorpera_observe_runtime_node_inventory accepts the category `code-host` (the observer reports one only for a VM
--    exactly as the executor makes it under the policy: no NIC, no device but its root disk, devlxd off, the
--    project's company marker, the policy's image and limits) and the reason CODE_HOST_SPACE_EXCEEDED. A code host is
--    never an allocation, has the policy's size, sits in a code host project under the name code-host, and needs the
--    policy's codeHosts; at most `running` of them are not stopped. Anything else in a code host project is reported
--    unmanaged, and the node is unavailable.
-- Policies without codeHosts, and observers that report no code-host entries, behave exactly as before. An observer
-- without this change refuses a policy with codeHosts (unknown field), so the node stays unavailable rather than
-- half-checked. Patched bodies are patched in place from their live text, so their headers, grants and other
-- migrations' changes stay; each anchor must occur exactly once. Every patched body names this migration
-- (20260930397000), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.s5e_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5e anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. Enrollment. ------------------------------------------------------------------------------------------------------

select pg_temp.s5e_patch('public.qorpera_enroll_runtime_node_inventory(jsonb)'::regprocedure, array[
$a$'infrastructure','buildSpace']<>'{}'::jsonb$a$,
$b$'infrastructure','buildSpace','codeHosts']<>'{}'::jsonb$b$,

$a$<>6+(p_policy ? 'buildSpace')::integer$a$,
$b$<>6+(p_policy ? 'buildSpace')::integer+(p_policy ? 'codeHosts')::integer$b$,

$a$
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-inventory-policy/v1' then$a$,
$b$
  -- The node's code hosts (20260930397000): the image, the pool, each one's size, and how many may run at once.
  or (p_policy ? 'codeHosts' and (jsonb_typeof(p_policy->'codeHosts') is distinct from 'object'
   or (p_policy->'codeHosts')-array['imageFingerprint','storagePool','cpus','memoryBytes','rootDiskBytes','running']<>'{}'::jsonb
   or (select count(*) from jsonb_object_keys(p_policy->'codeHosts'))<>6
   or jsonb_typeof(p_policy->'codeHosts'->'imageFingerprint') is distinct from 'string'
   or coalesce(p_policy->'codeHosts'->>'imageFingerprint','') !~ '^[0-9a-f]{64}$'
   or jsonb_typeof(p_policy->'codeHosts'->'storagePool') is distinct from 'string'
   or coalesce(p_policy->'codeHosts'->>'storagePool','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'
   or exists(select 1 from (values ('cpus',1::numeric,64::numeric,1::numeric),
     ('memoryBytes',1073741824,1099511627776,1073741824),('rootDiskBytes',10737418240,2199023255552,1073741824),
     ('running',1,64,1)) b(k,low,high,unit)
    where jsonb_typeof(p_policy->'codeHosts'->b.k) is distinct from 'number'
     or case when coalesce(p_policy->'codeHosts'->>b.k,'') ~ '^[1-9][0-9]{0,15}$'
      then (p_policy->'codeHosts'->>b.k)::numeric not between b.low and b.high or mod((p_policy->'codeHosts'->>b.k)::numeric,b.unit)<>0
      else true end)))
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-inventory-policy/v1' then$b$,

$a$ v_memory:=v_memory+coalesce((p_policy->'buildSpace'->>'memoryBytes')::numeric,0);$a$,
$b$ v_memory:=v_memory+coalesce((p_policy->'buildSpace'->>'memoryBytes')::numeric,0);
 -- And `running` code hosts of the policy's size (20260930397000).
 v_cpu:=v_cpu+coalesce((p_policy->'codeHosts'->>'running')::numeric*(p_policy->'codeHosts'->>'cpus')::numeric*1000,0);
 v_memory:=v_memory+coalesce((p_policy->'codeHosts'->>'running')::numeric*(p_policy->'codeHosts'->>'memoryBytes')::numeric,0);$b$,

$a$ where i->>'project'=p_policy->'buildSpace'->>'project') then$a$,
$b$ where i->>'project'=p_policy->'buildSpace'->>'project')
  -- A code host project holds its code host and nothing else (20260930397000).
  or exists(select 1 from jsonb_array_elements(p_policy->'infrastructure') i where i->>'project' ~ '^qorpera-codehost-[0-9a-f]{32}$')
  or coalesce(p_policy->'buildSpace'->>'project','') ~ '^qorpera-codehost-[0-9a-f]{32}$' then$b$
]);

-- 2. Observation. -----------------------------------------------------------------------------------------------------

select pg_temp.s5e_patch('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)'::regprocedure, array[
$a$ v_build_cpu numeric:=0; v_build_memory numeric:=0;$a$,
$b$ v_build_cpu numeric:=0; v_build_memory numeric:=0; v_code_hosts integer:=0;$b$,

$a$+coalesce((v_policy->'buildSpace'->>'cpuMillis')::numeric,0)>(v_context->>'headroomCpuMillis')::numeric$a$,
$b$+coalesce((v_policy->'buildSpace'->>'cpuMillis')::numeric,0)
   +coalesce((v_policy->'codeHosts'->>'running')::numeric*(v_policy->'codeHosts'->>'cpus')::numeric*1000,0)>(v_context->>'headroomCpuMillis')::numeric$b$,

$a$+coalesce((v_policy->'buildSpace'->>'memoryBytes')::numeric,0)>(v_context->>'headroomMemoryBytes')::numeric$a$,
$b$+coalesce((v_policy->'buildSpace'->>'memoryBytes')::numeric,0)
   +coalesce((v_policy->'codeHosts'->>'running')::numeric*(v_policy->'codeHosts'->>'memoryBytes')::numeric,0)>(v_context->>'headroomMemoryBytes')::numeric$b$,

$a$'infrastructure','build','unmanaged')$a$,
$b$'infrastructure','build','code-host','unmanaged')$b$,

$a$'BUILD_SPACE_EXCEEDED','INSTANCE_IMAGE_NOT_RELEASED'))$a$,
$b$'BUILD_SPACE_EXCEEDED','INSTANCE_IMAGE_NOT_RELEASED','CODE_HOST_SPACE_EXCEEDED'))$b$,

$a$'Node inventory mixes the build space with other instances' using errcode='42501'; end if;$a$,
$b$'Node inventory mixes the build space with other instances' using errcode='42501'; end if;
  -- A code host project holds only its code host, and a code host is a policy's code host (20260930397000).
  if (v_item->>'project' ~ '^qorpera-codehost-[0-9a-f]{32}$' and v_item->>'category' not in ('code-host','unmanaged'))
   or (v_item->>'category'='code-host' and (v_item->>'project' !~ '^qorpera-codehost-[0-9a-f]{32}$'
    or v_item->>'name' is distinct from 'code-host' or not v_policy ? 'codeHosts')) then
   raise exception 'Node inventory mixes the code hosts with other instances' using errcode='42501'; end if;$b$,

$a$   v_build_memory:=v_build_memory+coalesce((v_item->>'memoryBytes')::numeric,0);$a$,
$b$   v_build_memory:=v_build_memory+coalesce((v_item->>'memoryBytes')::numeric,0);
  elsif v_item->>'category'='code-host' then
   -- A company's code host (20260930397000): never an allocation; a virtual machine of the policy's size.
   if v_item->'allocation'<>'null'::jsonb then raise exception 'A code host cannot claim an allocation' using errcode='42501'; end if;
   if v_item->>'type' is distinct from 'virtual-machine'
    or v_item->'cpuMillis' is distinct from to_jsonb((v_policy->'codeHosts'->>'cpus')::numeric*1000)
    or v_item->'memoryBytes' is distinct from v_policy->'codeHosts'->'memoryBytes' then v_ready:=false; end if;
   if v_item->>'state'<>'suspended' then v_code_hosts:=v_code_hosts+1; end if;$b$,

$a$  or v_build_memory>coalesce((v_policy->'buildSpace'->>'memoryBytes')::numeric,0) then v_ready:=false; end if;$a$,
$b$  or v_build_memory>coalesce((v_policy->'buildSpace'->>'memoryBytes')::numeric,0) then v_ready:=false; end if;
 -- At most `running` code hosts are not stopped (20260930397000).
 if v_code_hosts>coalesce((v_policy->'codeHosts'->>'running')::integer,0) then v_ready:=false; end if;$b$
]);
