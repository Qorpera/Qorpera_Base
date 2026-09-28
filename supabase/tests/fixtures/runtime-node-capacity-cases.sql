set local role service_role;
select pg_temp.wake_assert(pg_temp.node_capacity()->>'admissibleSlots'='0','no health means no admission');
select pg_temp.wake_assert(pg_temp.node_reserve()->>'reason'='NODE_OBSERVATION_UNAVAILABLE','missing observation retains demand');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'pendingRequests'='1','waiting requests are visible');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.node_policy(),0)$q$,'PGRST');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.node_policy()||'{"unexpected":true}',1)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.node_policy()||'{"cpuMillis":"6000"}',1)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.node_policy()||'{"headroomCpuMillis":6000}',1)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.node_policy()||jsonb_build_object('machineIdSha256',repeat('d',64)),1)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_enroll_runtime_node_provider('36000000-0000-4000-8000-000000000010',repeat('c',64),
 'native',current_setting('qorpera_test.machine_provider'),repeat('f',64),2000,2147483648)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_enroll_runtime_node_provider('36000000-0000-4000-8000-000000000010',repeat('d',64),
 'native','different',repeat('f',64),2000,2147483648)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_reserve_runtime_node_machine(current_setting('qorpera_test.machine_id')::uuid,
 'office','36000000-0000-4000-8000-000000000001',repeat('f',64),repeat('a',64),repeat('c',64),2000,2147483648)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_reserve_runtime_node_machine(current_setting('qorpera_test.machine_id')::uuid,
 'native',current_setting('qorpera_test.machine_provider'),repeat('f',64),repeat('b',64),repeat('c',64),3000,2147483648)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_reserve_runtime_node_machine(current_setting('qorpera_test.machine_id')::uuid,
 'native',current_setting('qorpera_test.machine_provider'),repeat('f',64),repeat('a',64),repeat('c',64),2000,2147483648)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_test_observe_runtime_node(pg_temp.node_observation()||'{"observedAt":"infinity"}')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_test_observe_runtime_node(pg_temp.node_observation()||'{"cpuMillis":0}')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_test_observe_runtime_node(pg_temp.node_observation()||'{"extra":true}')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_test_observe_runtime_node(pg_temp.node_observation()||jsonb_build_object('machineIdSha256',repeat('e',64)))$q$,'42501');
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation('unavailable'));
select pg_temp.wake_assert(pg_temp.node_reserve()->>'reason'='NODE_OBSERVATION_UNAVAILABLE','explicit unavailable host');
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation('ready',4000));
select pg_temp.wake_assert(pg_temp.node_reserve()->>'reason'='NODE_HARDWARE_CHANGED','configured total must exist physically');
select set_config('qorpera_test.node_observation',pg_temp.node_observation()::text,true);
select public.qorpera_test_observe_runtime_node(current_setting('qorpera_test.node_observation')::jsonb);
select pg_temp.wake_assert(pg_temp.node_capacity()->>'admissibleSlots'='2','whole slots after CPU/RAM headroom');
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation());
select set_config('qorpera_test.current_node_measurement',pg_temp.node_capacity()->>'observedAt',true);
select public.qorpera_test_observe_runtime_node(current_setting('qorpera_test.node_observation')::jsonb);
select pg_temp.wake_assert(pg_temp.node_capacity()->>'observedAt'=current_setting('qorpera_test.current_node_measurement'),'replayed older receipt neither replaces nor refreshes the current observation');
select pg_temp.wake_error($q$select public.qorpera_test_observe_runtime_node(current_setting('qorpera_test.node_observation')::jsonb||(pg_temp.node_observation()-'observationId'))$q$,'42501');
select pg_temp.wake_assert(pg_temp.node_reserve()->>'state'='reserved','native reserves three CPU cores before provisioning');
select pg_temp.wake_assert(pg_temp.node_reserve()->>'state'='reserved','exact retry is idempotent');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'allocatedComputers'='1','one native allocation despite replay');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'admissibleSlots'='0','fractional CPU slot is not admissible');
select pg_temp.wake_assert(pg_temp.node_reserve(true)->>'reason'='NODE_CAPACITY_EXHAUSTED','office and native share node budget');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'pendingRequests'='1','capacity refusal remains waiting');
select pg_temp.wake_error($q$select public.qorpera_configure_runtime_node(pg_temp.node_policy()||'{"cpuMillis":4000}',1)$q$,'55000');
select public.qorpera_configure_runtime_node(pg_temp.node_policy(false),1);
-- A new policy version (here: disabled) fences every admission, an existing restart included, until a fresh receipt.
select pg_temp.wake_assert(pg_temp.node_reserve()->>'reason'='NODE_OBSERVATION_UNAVAILABLE','a new node policy fences even an existing restart until the next receipt');
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation());
-- Switched off (20260928180700): the reservation the node holds, reserved and awake, is admitted again; a new one is not.
select pg_temp.wake_assert(pg_temp.node_reserve()->>'state'='reserved','a disabled node keeps the reservation it holds');
select pg_temp.wake_assert(pg_temp.node_reserve(true)->>'reason'='NODE_DISABLED','a disabled node admits no new reservation');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'allocatedCpuMillis'='3000','disabled node retains allocated CPU');
select public.qorpera_configure_runtime_node(pg_temp.node_policy(),2);
reset role;
-- Explicit stale measurement fixture, not elapsed-time physical evidence.
update public.qorpera_runtime_node_observations set observed_at=clock_timestamp()-interval '61 seconds';
update public.qorpera_runtime_node_demands set reserved_at=clock_timestamp()-interval '1 year' where reserved_at is not null;
set local role service_role;
select pg_temp.wake_assert(pg_temp.node_reserve()->>'reason'='NODE_OBSERVATION_UNAVAILABLE','stale observation cannot restart allocation');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'allocatedComputers'='1','missing host and elapsed time do not free reservation');
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation());
select pg_temp.wake_error($q$select public.qorpera_release_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,
 current_setting('qorpera_test.machine_provider'),repeat('e',64))$q$,'42501');
select public.qorpera_release_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,
 current_setting('qorpera_test.machine_provider'),repeat('a',64));
select pg_temp.wake_error($q$select pg_temp.node_reserve()$q$,'42501');
select pg_temp.wake_assert(pg_temp.node_reserve(true)->>'state'='reserved','confirmed deletion frees node and company resources');
-- RAM, independently of CPU, must constrain the next standard slot.
select public.qorpera_configure_runtime_node(pg_temp.node_policy()||'{"memoryBytes":4294967296}',3);
select pg_temp.wake_assert(pg_temp.node_capacity()->>'admissibleSlots'='0','fractional RAM slot is not admissible');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'overflow'='unavailable','unconfigured overflow never becomes spare capacity');
select pg_temp.wake_assert(pg_temp.node_capacity()->'activeUsers'='null','membership is not measured activity');
reset role;
select pg_temp.wake_assert((select d.released_at=a.released_at from public.qorpera_runtime_node_demands d
 join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id where d.provider_kind='native'),'one exact release timestamp');
select pg_temp.wake_assert((select count(*)=4 from public.qorpera_runtime_node_policies),'policy changes retained');
do $$ declare v_role text; v_table text; v_function regprocedure;
begin
 foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
  foreach v_table in array array['nodes','node_policies','node_providers','node_observations','node_observation_receipts','node_demands'] loop
   perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_runtime_'||v_table,'SELECT,INSERT,UPDATE,DELETE'),'private node tables: '||v_role);
  end loop;
  if v_role='service_role' then continue; end if;
  for v_function in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
   ('qorpera_configure_runtime_node','qorpera_enroll_runtime_node_provider','qorpera_observe_runtime_node','qorpera_reserve_runtime_node_machine','qorpera_runtime_node_capacity') loop
   perform pg_temp.wake_assert(not has_function_privilege(v_role,v_function,'EXECUTE'),'operator-only node RPCs: '||v_role);
  end loop;
 end loop;
end $$;
