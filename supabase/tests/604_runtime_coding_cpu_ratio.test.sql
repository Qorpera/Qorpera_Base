-- @fixture 602_runtime_coding_fleet.test.sql until "-- BEGIN FLEET PLACEMENT ASSERTIONS"
-- A2CPU coding VM fits only with the explicit2:1 customerCPU policy.
select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-other',false,array['codex']);
select public.qorpera_configure_runtime_node((select policy||'{"cpuMillis":3000,"headroomCpuMillis":2000,"standardCpuMillis":1000}'
 from public.qorpera_runtime_node_policies where node_id='30000000-0000-4000-8000-000000000310' and version=1),1);
create function pg_temp.coding_ratio_observe() returns jsonb language sql as $$
 select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
  'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'cpuMillis',3000,'memoryBytes',8589934592,'state','ready'),
  public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310')->>'contextSha256',
  jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb))
$$;
select pg_temp.coding_ratio_observe();
select pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'1:1 budget leaves2CPU coding work queued');
select public.qorpera_configure_runtime_node((select policy||'{"cpuAllocationRatio":2}'
 from public.qorpera_runtime_node_policies where node_id='30000000-0000-4000-8000-000000000310' and version=2),2);
select pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'Changing ratio does not bypass fresh inventory');
select pg_temp.coding_ratio_observe();
-- Provider admission uses the same budget as the actual placement.
select public.qorpera_enroll_runtime_node_provider('30000000-0000-4000-8000-000000000310',repeat('c',64),'coding','ratio-extra',repeat('f',64),2000,2147483648);
do $$
declare claim jsonb; plan jsonb;
begin
 claim:=public.qorpera_claim_coding_session('exec-test',60);
 perform pg_temp.wake_assert(claim is not null,'2:1 candidate can claim the queued coding member');
 plan:=public.qorpera_plan_coding_machine((claim->>'workerId')::uuid,(claim->>'leaseToken')::uuid,repeat('c',64));
 perform pg_temp.wake_assert(plan->>'state'='planned' and plan#>>'{binding,providerId}'='coding-a',
  'Coding plan atomically reserves beyond physical remainder within doubled budget');
 perform pg_temp.wake_assert((select cpu_millis=2000 and reserved_at is not null from public.qorpera_runtime_node_demands
  where allocation_id=(plan->>'machineId')::uuid) and not exists(select 1 from public.qorpera_coding_storage_volumes),
  'Reservation costs remain exact and planning does not invent NAS custody');
end $$;
rollback;
