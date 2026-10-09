-- A confirmed power-off suspends the company computer's node demand; resume re-admits it (20260923060000).
-- Follows runtime-node-capacity-setup.sql: node 6000 mcpu, headroom 2000 (4000 allocatable), native 3000, office 2000.
-- The lifecycle transitions and the boot intent are synthetic rows (their activation/stop parents are provider-owned
-- history); every reservation, suspension and capacity call is the real RPC.
reset role;
set local session_replication_role = replica;
insert into public.qorpera_runtime_office_lifecycle_transitions(id,activation_id,office_id,computer_generation,allocation_id,request,revocation_revision,drains)
select t.id,t.activation,(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1,
 '34000000-0000-4000-8000-000000000088',jsonb_build_object('action',t.action),1,'[]'
from (values ('36600000-0000-4000-8000-000000000001'::uuid,'36600000-0000-4000-8000-000000000011'::uuid,'power_off',clock_timestamp()-interval '2 minutes'),
 ('36600000-0000-4000-8000-000000000002'::uuid,'36600000-0000-4000-8000-000000000012'::uuid,'reboot',clock_timestamp()-interval '3 minutes')) t(id,activation,action,at);
update public.qorpera_runtime_office_lifecycle_transitions set requested_at=clock_timestamp()-interval '3 minutes' where id='36600000-0000-4000-8000-000000000002';
set local session_replication_role = origin;
create function pg_temp.node_suspend(p_transition uuid,p_instance text default repeat('b',64)) returns jsonb language sql as $$
 select public.qorpera_suspend_runtime_node_machine('34000000-0000-4000-8000-000000000088','36000000-0000-4000-8000-000000000001',
  repeat('f',64),p_instance,repeat('c',64),p_transition)
$$;
set local role service_role;
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation());
select pg_temp.base_assert(pg_temp.node_reserve(true)->>'state'='reserved','the company computer holds its slot while running');
select pg_temp.base_assert(pg_temp.node_reserve()->>'reason'='NODE_CAPACITY_EXHAUSTED','a running computer and a native run do not both fit');
-- Only a confirmed explicit power-off of this exact computer suspends.
select pg_temp.base_error($q$select pg_temp.node_suspend('36600000-0000-4000-8000-000000000002')$q$,'42501');
select pg_temp.base_error($q$select pg_temp.node_suspend('36600000-0000-4000-8000-000000000001',repeat('e',64))$q$,'42501');
select pg_temp.base_error($q$select pg_temp.node_suspend('36600000-0000-4000-8000-000000000099')$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_suspend_runtime_node_machine(current_setting('qorpera_test.machine_id')::uuid,
 current_setting('qorpera_test.machine_provider'),repeat('f',64),repeat('a',64),repeat('c',64),'36600000-0000-4000-8000-000000000001')$q$,'42501');
select set_config('qorpera_test.suspension',pg_temp.node_suspend('36600000-0000-4000-8000-000000000001')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.suspension')::jsonb->>'state'='suspended','a confirmed power-off suspends the demand');
select pg_temp.base_assert(pg_temp.node_suspend('36600000-0000-4000-8000-000000000001')=current_setting('qorpera_test.suspension')::jsonb,'a replayed suspension is the same receipt');
select pg_temp.base_assert(pg_temp.node_capacity()->>'allocatedCpuMillis'='0','a suspended computer is not counted');
select pg_temp.base_assert(pg_temp.node_capacity()->>'allocatedComputers'='0','a suspended computer holds no slot');
-- The freed slot admits the waiting native run.
select pg_temp.base_assert(pg_temp.node_reserve()->>'state'='reserved','the freed slot admits a native run');
-- Resume while the node is full is refused and stays suspended; the lifecycle retries.
select pg_temp.base_assert(pg_temp.node_reserve(true)->>'reason'='NODE_CAPACITY_EXHAUSTED','resume waits for a free slot');
reset role;
select pg_temp.base_assert((select suspended_at is not null and reserved_at is not null and released_at is null from public.qorpera_runtime_node_demands
 where allocation_id='34000000-0000-4000-8000-000000000088'),'a refused resume keeps the demand suspended and placed');
set local role service_role;
select public.qorpera_release_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,current_setting('qorpera_test.machine_provider'),repeat('a',64));
select pg_temp.base_assert(pg_temp.node_reserve(true)->>'state'='reserved','resume is admitted once the slot is free');
reset role;
select pg_temp.base_assert((select suspended_at is null from public.qorpera_runtime_node_demands where allocation_id='34000000-0000-4000-8000-000000000088'),
 'admission clears the suspension');
set local role service_role;
select pg_temp.base_assert(pg_temp.node_capacity()->>'allocatedCpuMillis'='2000','the resumed computer is counted again');
-- A computer whose resume was already requested keeps its slot.
reset role;
set local session_replication_role = replica;
insert into public.qorpera_runtime_office_boot_intents(boot_intent_id,activation_id,transition_id,predecessor_activation_id,request,office_revision,privacy_state,privacy_version)
values ('36600000-0000-4000-8000-000000000021','36600000-0000-4000-8000-000000000022','36600000-0000-4000-8000-000000000001',
 '36600000-0000-4000-8000-000000000011','{}',1,'shared',1);
set local session_replication_role = origin;
set local role service_role;
select pg_temp.base_assert(pg_temp.node_suspend('36600000-0000-4000-8000-000000000001')->>'reason'='RESUME_PENDING','a requested resume keeps the slot');
select pg_temp.base_assert(pg_temp.node_capacity()->>'allocatedCpuMillis'='2000','no suspension after a resume request');
reset role;
-- Only office demands can be suspended, and only through the RPC.
select pg_temp.base_error($q$update public.qorpera_runtime_node_demands set suspended_at=clock_timestamp() where provider_kind='native'$q$,'23514');
do $$ declare v_role text;
begin
 foreach v_role in array array['anon','authenticated','qorpera_secret_broker'] loop
  perform pg_temp.base_assert(not has_function_privilege(v_role,'public.qorpera_suspend_runtime_node_machine(uuid,text,text,text,text,uuid)','EXECUTE'),
   'operator-only suspension: '||v_role);
 end loop;
end $$;
