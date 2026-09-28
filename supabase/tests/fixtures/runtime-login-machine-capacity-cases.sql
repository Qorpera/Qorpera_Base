-- Composed after the real wake/office/node fixtures. VM presence/deletion and
-- identity ownership are explicit fixture facts; all admission functions run.
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.capacity_login',public.qorpera_begin_native_provider_login(
 '30000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000001','38000000-0000-4000-8000-000000000002',
 (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,'openai','codex-cli',repeat('8',64),900)::text,true);
reset role;
create function pg_temp.login_machine_reserve() returns jsonb language sql as $$
 select public.qorpera_reserve_runtime_login_machine('38000000-0000-4000-8000-000000000003','lxd',repeat('7',64),
 (current_setting('qorpera_test.capacity_login')::jsonb->>'login_id')::uuid,repeat('8',64))
$$;
create function pg_temp.login_machine_describe() returns jsonb language sql as $$
 select public.qorpera_describe_runtime_login_machine('38000000-0000-4000-8000-000000000003','lxd',repeat('7',64))
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.login_machine_reserve()->>'reason'='COMPUTE_IDENTITY_OCCUPIED','login cannot attach a native job identity disk');
reset role;
select pg_temp.wake_assert((select count(*)=1 and max(last_refusal)='COMPUTE_IDENTITY_OCCUPIED' from public.qorpera_runtime_login_machine_requests),'refused login request retained');
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_machine_allocations where login_session_id is not null),'no physical login allocation on refusal');
set local role service_role;
select public.qorpera_release_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,current_setting('qorpera_test.machine_provider'),repeat('a',64));
select pg_temp.wake_assert(pg_temp.login_machine_reserve()->>'state'='reserved','confirmed native VM deletion permits login allocation');
select pg_temp.wake_assert(pg_temp.login_machine_reserve()->>'state'='reserved','exact login admission replays one allocation');
select pg_temp.wake_assert(pg_temp.login_machine_describe()->>'cleanupRequired'='false','live authorized login remains usable');
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,current_setting('qorpera_test.machine_provider'),repeat('a',64),
 (current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid,(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid)->>'reason'='COMPUTE_IDENTITY_OCCUPIED',
 'native physical dispatch refuses an occupied login identity');
select public.qorpera_enroll_runtime_node_provider('36000000-0000-4000-8000-000000000010',repeat('c',64),'login','lxd',repeat('9',64),1000,1073741824);
select public.qorpera_test_observe_runtime_node(pg_temp.node_observation());
select pg_temp.wake_assert(public.qorpera_reserve_runtime_node_machine('38000000-0000-4000-8000-000000000003','login','lxd',repeat('9',64),repeat('7',64),repeat('c',64),1000,1073741824)->>'state'='reserved','login consumes the shared host budget');
select pg_temp.wake_assert(pg_temp.node_reserve(true)->>'state'='reserved','office and login share one node budget');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'allocatedComputers'='2' and pg_temp.node_capacity()->>'allocatedCpuMillis'='3000','two physical computers, three charged cores');
select public.qorpera_enroll_runtime_node_provider('36000000-0000-4000-8000-000000000010',repeat('c',64),'native','lxd',repeat('9',64),1000,1073741824);
select pg_temp.wake_error($q$select public.qorpera_reserve_runtime_node_machine('38000000-0000-4000-8000-000000000003','native','lxd',repeat('9',64),repeat('7',64),repeat('c',64),1000,1073741824)$q$,'42501');

savepoint membership_revoked;
reset role;
-- The last founder cannot leave while others remain (20260929030000): a second founder joins first.
insert into auth.users(id,email) values ('30000000-0000-4000-8000-0000000000f3','capacity-cofounder@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-0000000000f3','capacity-cofounder@example.test','Co-founder','owner');
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.wake_error('select pg_temp.login_machine_reserve()','42501');
select pg_temp.wake_assert(pg_temp.login_machine_describe()->>'cleanupRequired'='true','membership revocation requests cleanup');
rollback to membership_revoked;

savepoint login_expired;
reset role;
update public.qorpera_native_provider_login_sessions set status='expired' where id=(current_setting('qorpera_test.capacity_login')::jsonb->>'login_id')::uuid;
set local role service_role;
select pg_temp.wake_error('select pg_temp.login_machine_reserve()','42501');
select pg_temp.wake_assert(pg_temp.login_machine_describe()->>'cleanupRequired'='true','expired login remains available to cleanup');
select pg_temp.wake_assert(pg_temp.node_capacity()->>'allocatedComputers'='2','expiry never frees a physical VM');
rollback to login_expired;

savepoint provider_disabled;
reset role;
set local role service_role;
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli','supported','disabled',32,'login-capacity-fixture','login-capacity-fixture');
select pg_temp.wake_error('select pg_temp.login_machine_reserve()','42501');
select pg_temp.wake_assert(pg_temp.login_machine_describe()->>'cleanupRequired'='true','provider disable requests cleanup');
select public.qorpera_release_runtime_login_machine('38000000-0000-4000-8000-000000000003','lxd',repeat('7',64),
 (current_setting('qorpera_test.capacity_login')::jsonb->>'login_id')::uuid);
select pg_temp.wake_assert(pg_temp.node_capacity()->>'allocatedComputers'='1','only exact physical deletion frees login budget');
reset role;
select pg_temp.wake_assert((select d.released_at=a.released_at from public.qorpera_runtime_node_demands d join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
 where a.id='38000000-0000-4000-8000-000000000003'),'login and node share one release timestamp');
rollback to provider_disabled;

set local role service_role;
select public.qorpera_release_runtime_login_machine('38000000-0000-4000-8000-000000000003','lxd',repeat('7',64),
 (current_setting('qorpera_test.capacity_login')::jsonb->>'login_id')::uuid);
select pg_temp.wake_error('select pg_temp.login_machine_reserve()','42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.capacity_login',public.qorpera_begin_native_provider_login(
 '30000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000011','38000000-0000-4000-8000-000000000012',
 (current_setting('qorpera_test.wake_identity')::jsonb->>'compute_identity_id')::uuid,'openai','codex-cli',repeat('8',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
-- No reservation committed: confirmed absence still permanently closes this
-- specific physical intent, so an earlier delayed request cannot revive it.
select public.qorpera_release_runtime_login_machine('38000000-0000-4000-8000-000000000013','lxd',repeat('6',64),
 (current_setting('qorpera_test.capacity_login')::jsonb->>'login_id')::uuid);
select pg_temp.wake_error($q$select public.qorpera_reserve_runtime_login_machine('38000000-0000-4000-8000-000000000013','lxd',repeat('6',64),
 (current_setting('qorpera_test.capacity_login')::jsonb->>'login_id')::uuid,repeat('8',64))$q$,'42501');
reset role;
do $$ declare v_role text;
begin
 foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
  perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_runtime_login_machine_requests','SELECT,INSERT,UPDATE,DELETE'),'login request records are private');
  if v_role='service_role' then continue; end if;
  perform pg_temp.wake_assert(not has_function_privilege(v_role,'public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)','EXECUTE'),'login capacity requires supervisor');
  perform pg_temp.wake_assert(not has_function_privilege(v_role,'public.qorpera_describe_runtime_login_machine(uuid,text,text)','EXECUTE'),'login cleanup records require supervisor');
  perform pg_temp.wake_assert(not has_function_privilege(v_role,'public.qorpera_release_runtime_login_machine(uuid,text,text,uuid)','EXECUTE'),'login closure requires supervisor');
 end loop;
end $$;
