-- Following the real wake and office registration fixture. Physical readiness
-- and hardware measurements are synthetic; all reservation RPCs are real.
reset role;
update public.qorpera_runtime_offices set state='provisioning'
 where id=(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,
 '36000000-0000-4000-8000-000000000001',repeat('f',64),0,true);
reset role;
select set_config('qorpera_test.machine_id',(select client_runner_id::text from public.qorpera_runners
 where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
select set_config('qorpera_test.machine_provider',(select provider_adapter from public.qorpera_runners
 where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
create function pg_temp.node_policy(p_enabled boolean default true) returns jsonb language sql as $$
 select jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId','36000000-0000-4000-8000-000000000010',
  'machineIdSha256',repeat('c',64),'label','node-fixture','cpuMillis',6000,'memoryBytes',8589934592,
  'headroomCpuMillis',2000,'headroomMemoryBytes',1073741824,'standardCpuMillis',2000,'standardMemoryBytes',2147483648,'enabled',p_enabled)
$$;
create function pg_temp.node_observation(p_state text default 'ready',p_cpu bigint default 6000,p_memory bigint default 8589934592)
 returns jsonb language sql as $$
 select jsonb_build_object('schema','qorpera.runtime-node-observation/v1','nodeId','36000000-0000-4000-8000-000000000010',
  'machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
  'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'cpuMillis',p_cpu,'memoryBytes',p_memory,'state',p_state)
$$;
create function pg_temp.node_reserve(p_office boolean default false) returns jsonb language sql as $$
 select public.qorpera_reserve_runtime_node_machine(
  case when p_office then '34000000-0000-4000-8000-000000000088'::uuid else current_setting('qorpera_test.machine_id')::uuid end,
  case when p_office then 'office' else 'native' end,
  case when p_office then '36000000-0000-4000-8000-000000000001' else current_setting('qorpera_test.machine_provider') end,
  repeat('f',64),case when p_office then repeat('b',64) else repeat('a',64) end,repeat('c',64),case when p_office then 2000 else 3000 end,2147483648)
$$;
create function pg_temp.node_capacity() returns jsonb language sql as $$
 select public.qorpera_runtime_node_capacity('36000000-0000-4000-8000-000000000010')
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,current_setting('qorpera_test.machine_provider'),repeat('a',64),
 (current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid,(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid);
select public.qorpera_reserve_runtime_machine('34000000-0000-4000-8000-000000000088','lxd',repeat('b',64),null,null,
 (current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1);
select pg_temp.wake_assert(pg_temp.node_reserve()->>'reason'='NODE_PROVIDER_UNCONFIGURED','company allocation does not imply node admission');
select public.qorpera_configure_runtime_node(pg_temp.node_policy(),0);
select public.qorpera_enroll_runtime_node_provider('36000000-0000-4000-8000-000000000010',repeat('c',64),
 'native',current_setting('qorpera_test.machine_provider'),repeat('f',64),3000,2147483648);
select public.qorpera_enroll_runtime_node_provider('36000000-0000-4000-8000-000000000010',repeat('c',64),
 'office','36000000-0000-4000-8000-000000000001',repeat('f',64),2000,2147483648);
reset role;
