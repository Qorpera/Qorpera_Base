-- @fixture 403_runtime_node_capacity_fits_demand.test.sql until "-- Four 2 vCPU"
-- A node's CPU allocation ratio, on a folder-v2 company's coding machines (ported from snapshot-v1 in the legacy sweep).
-- Real node admission and inventory RPCs; physical machines are fixture entries.
reset role;
create function pg_temp.ratio_policy(p_ratio integer default 2) returns jsonb language sql as $$
 select pg_temp.cap_policy(6000,68719476736,2000,34359738368)
  ||jsonb_build_object('standardCpuMillis',2000,'cpuAllocationRatio',p_ratio)
$$;
create function pg_temp.ratio_observe(p_cpu bigint default 6000) returns jsonb language plpgsql as $$
declare c jsonb; entries jsonb;
begin
 c:=public.qorpera_runtime_node_inventory_context('40300000-0000-4000-8000-000000000010');
 select coalesce(jsonb_agg(jsonb_build_object('project','coding','name','vm-'||(a->>'allocationId'),
  'physicalId',a->>'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('9',64),
  'cpuMillis',a->'cpuMillis','memoryBytes',a->'memoryBytes','allocation',a,'category','managed','reason',null)),'[]'::jsonb)
 into entries from jsonb_array_elements(c->'allocations') a;
 return public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
  'nodeId','40300000-0000-4000-8000-000000000010','machineIdSha256',repeat('4',64),'observationId',extensions.gen_random_uuid(),
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'cpuMillis',p_cpu,'memoryBytes',68719476736,'state','ready'),c->>'contextSha256',
  jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',entries));
end $$;
select pg_temp.base_assert((pg_temp.cap()->>'cpuAllocationRatio')::integer=1,'Default allocation ratio is one');
select public.qorpera_configure_runtime_node(pg_temp.ratio_policy(),1);
select pg_temp.base_assert(pg_temp.cap()->>'state'='unavailable' and pg_temp.cap_reserve(1)->>'reason'='NODE_OBSERVATION_UNAVAILABLE',
 'Ratio edit invalidates previous inventory before any reservation');
select pg_temp.ratio_observe();
select pg_temp.base_assert(pg_temp.cap()->>'state'='eligible' and (pg_temp.cap()->>'physicalCpuMillis')::bigint=6000
 and (pg_temp.cap()->>'allocatableCpuMillis')::bigint=8000 and (pg_temp.cap()->>'freeMemoryBytes')::bigint=34359738368,
 'Subtract physical headroom before doubling CPU; RAM stays physical');
select pg_temp.base_assert(pg_temp.cap_reserve(n)->>'state'='reserved','Overcommitted CPU reservation '||n) from generate_series(1,4) n;
select pg_temp.ratio_observe();
select pg_temp.base_assert(pg_temp.cap()->>'state'='eligible' and (pg_temp.cap()->>'allocatedCpuMillis')::bigint=8000
 and (pg_temp.cap()->>'freeCpuMillis')::bigint=0 and not pg_temp.cap_fits(),
 'Four managed running VMs use 8 vCPU on physical6; exact inventory remains ready and candidate is full');
select pg_temp.base_assert(pg_temp.cap_reserve(5)->>'reason'='NODE_CAPACITY_EXHAUSTED','CPU boundary is enforced');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy(1),2)$q$,'55000');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"headroomCpuMillis":3000}',2)$q$,'55000');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy(3),2)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"cpuAllocationRatio":null}',2)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"cpuAllocationRatio":"2"}',2)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"cpuAllocationRatio":1.5}',2)$q$,'42501');
select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()-'cpuAllocationRatio',2);
select pg_temp.base_assert((select cpu_allocation_ratio=2 and cpu_millis=6000 and version=3 from public.qorpera_runtime_nodes
 where id='40300000-0000-4000-8000-000000000010') and (select policy->>'cpuAllocationRatio'='2'
 from public.qorpera_runtime_node_policies where node_id='40300000-0000-4000-8000-000000000010' and version=3),
 'Existing callers preserve ratio, and normalized policy history records it');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy(),2)$q$,'PGRST');
select pg_temp.ratio_observe(5000);
select pg_temp.base_assert(pg_temp.cap()->>'state'='unavailable' and pg_temp.cap_reserve(5)->>'reason'='NODE_HARDWARE_CHANGED',
 'Hardware observations still compare with physical CPU, never the allocation budget');
-- More CPU cannot lend RAM: four existing VMs already fill the new 16GiB budget.
select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"cpuMillis":10000,"headroomMemoryBytes":51539607552}',3);
select pg_temp.ratio_observe(10000);
select pg_temp.base_assert((pg_temp.cap()->>'freeCpuMillis')::bigint=8000 and (pg_temp.cap()->>'freeMemoryBytes')::bigint=0
 and not pg_temp.cap_fits() and pg_temp.cap_reserve(5)->>'reason'='NODE_CAPACITY_EXHAUSTED','Memory remains a hard physical limit');
select pg_temp.base_error($q$select public.qorpera_configure_runtime_node(pg_temp.ratio_policy()||'{"headroomMemoryBytes":55834574848}',4)$q$,
 '55000');
select pg_temp.base_error($q$select public.qorpera_enroll_runtime_node_provider('40300000-0000-4000-8000-000000000010',repeat('4',64),
 'coding','too-much-memory',repeat('e',64),2000,17179869185)$q$,'42501');
select pg_temp.base_assert(not has_function_privilege(r,'public.qorpera_configure_runtime_node(jsonb,bigint)','EXECUTE')
 and not has_function_privilege(r,'public.qorpera_runtime_node_cpu_budget(public.qorpera_runtime_nodes)','EXECUTE'),
 'Ratio policy and internal helper are private: '||r) from unnest(array['anon','authenticated']) r;
-- BEGIN CPU RATIO RACE SETUP
rollback;
