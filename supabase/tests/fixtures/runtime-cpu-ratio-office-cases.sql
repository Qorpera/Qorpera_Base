-- Requires runtime-office-fleet-cases.sql through its fleet_staged savepoint.
-- Both original offers2CPU: nodeA has1 physical CPU after host reserve; nodeB disabled.
select public.qorpera_configure_runtime_node((select policy||'{"headroomCpuMillis":5000,"standardCpuMillis":1000}'
 from public.qorpera_runtime_node_policies where node_id='60300000-0000-4000-8000-000000000010' and version=1),1);
select public.qorpera_configure_runtime_node((select policy||'{"enabled":false}'
 from public.qorpera_runtime_node_policies where node_id='60300000-0000-4000-8000-000000000020' and version=1),1);
create function pg_temp.office_ratio_observe() returns jsonb language sql as $$
 select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
  'nodeId','60300000-0000-4000-8000-000000000010','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
  public.qorpera_runtime_node_inventory_context('60300000-0000-4000-8000-000000000010')->>'contextSha256',
  jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb))
$$;
select pg_temp.office_ratio_observe();
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='unplaced','Office waits at1:1');
select public.qorpera_configure_runtime_node((select policy||'{"cpuAllocationRatio":2}'
 from public.qorpera_runtime_node_policies where node_id='60300000-0000-4000-8000-000000000010' and version=2),2);
select pg_temp.wake_assert(pg_temp.office_fleet_place()->>'state'='unplaced','Ratio cannot bypass complete inventory for office');
select pg_temp.office_ratio_observe();
select pg_temp.wake_assert(pg_temp.office_fleet_place()#>>'{offer,nodeId}'='60300000-0000-4000-8000-000000000010',
 'Exact office fleet offer admits beyond physical remainder only with2:1');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_node_demands where reserved_at is not null)
 and (select sum(cpu_millis)=2000 from public.qorpera_runtime_node_demands where reserved_at is not null),
 'Office places one exact reservation under the doubledCPU budget');
