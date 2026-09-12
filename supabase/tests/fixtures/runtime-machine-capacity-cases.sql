select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select public.qorpera_set_company_machine_limit('30000000-0000-4000-8000-000000000010',1,0)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_machine_limit('30000000-0000-4000-8000-000000000010',1,0);
select pg_temp.wake_error($q$select public.qorpera_set_company_machine_limit('30000000-0000-4000-8000-000000000010',1,0)$q$,'PGRST');
reset role;
select set_config('qorpera_test.machine_id',(select client_runner_id::text from public.qorpera_runners
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
select set_config('qorpera_test.machine_provider',(select provider_adapter from public.qorpera_runners
	where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid),true);
create function pg_temp.native_machine() returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,current_setting('qorpera_test.machine_provider'),repeat('a',64),
		(current_setting('qorpera_test.wake_binding')::jsonb->>'runId')::uuid,(current_setting('qorpera_test.wake_binding')::jsonb->>'runnerId')::uuid)
$$;
create function pg_temp.office_machine() returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_machine('34000000-0000-4000-8000-000000000088','lxd',repeat('b',64),null,null,
		(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1)
$$;
create function pg_temp.office_guest(p_generation bigint default 1,p_instance text default repeat('b',64),
	p_image text default repeat('a',64),p_bootstrap text default repeat('b',64)) returns jsonb language sql as $$
	select public.qorpera_check_runtime_office_guest_binding(current_setting('qorpera_test.office_scope')::jsonb,
		p_generation,'34000000-0000-4000-8000-000000000088',p_instance,p_image,p_bootstrap)
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.native_machine()->>'state'='reserved','native computer consumes one machine');
select pg_temp.wake_error($q$select pg_temp.office_guest()$q$,'42501');
select pg_temp.wake_assert(pg_temp.native_machine()->>'state'='reserved','reservation replay consumes no extra capacity');
select pg_temp.wake_assert(pg_temp.office_machine()='{"state":"refused","reason":"MACHINE_CAPACITY_EXHAUSTED"}'::jsonb,'office and native execution share one ceiling');
select pg_temp.office_machine();
select pg_temp.wake_error($q$select public.qorpera_release_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,
	current_setting('qorpera_test.machine_provider'),repeat('c',64))$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_refusals),'durable deduplicated refusal');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_member_notifications where subject->>'dimension'='machines'),'founder notified once');
-- Time does not free reserved, suspended, missing or uncertain machines.
update public.qorpera_runtime_machine_allocations set reserved_at=clock_timestamp()-interval '1 year';
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_machine()->>'state'='refused','no TTL release of physical occupancy');
select public.qorpera_release_runtime_machine(current_setting('qorpera_test.machine_id')::uuid,current_setting('qorpera_test.machine_provider'),repeat('a',64));
select pg_temp.wake_error($q$select pg_temp.native_machine()$q$,'42501');
select pg_temp.wake_assert(pg_temp.office_machine()->>'state'='reserved','capacity reused only after physical deletion');
select pg_temp.wake_assert(pg_temp.office_guest()='{"state":"authorized","computerGeneration":1,"validForMs":5000}'::jsonb,'guest requires current exact office machine allocation');
select pg_temp.wake_error($q$select pg_temp.office_guest(2)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_guest(1,repeat('c',64))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_guest(1,repeat('b',64),repeat('c',64))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.office_guest(1,repeat('b',64),repeat('a',64),repeat('c',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_guest_binding(
	jsonb_set(current_setting('qorpera_test.office_scope')::jsonb,'{companyId}','"34000000-0000-4000-8000-000000000099"'),
	1,'34000000-0000-4000-8000-000000000088',repeat('b',64),repeat('a',64),repeat('b',64))$q$,'42501');
reset role;
update public.qorpera_runtime_offices set state='maintenance';
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_guest()$q$,'42501');
reset role;
update public.qorpera_runtime_offices set state='active';
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(public.qorpera_company_machine_capacity('30000000-0000-4000-8000-000000000010')->>'allocatedMachines'='1','one machine regardless of screens');
select public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010',true,'fixture');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_machine()='{"state":"refused","reason":"COMPANY_PAUSED"}'::jsonb,'founder stop fences even an existing reservation restart');
select pg_temp.wake_error($q$select pg_temp.office_guest()$q$,'42501');
select public.qorpera_release_runtime_machine('34000000-0000-4000-8000-000000000088','lxd',repeat('b',64));
reset role;
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_machine_allocations where released_at is null),'cleanup survives founder stop');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_machine_allocations','SELECT,INSERT,UPDATE,DELETE'),'private capacity authority');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_release_runtime_machine(uuid,text,text)','EXECUTE'),'members cannot claim physical deletion');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)','EXECUTE'),'members cannot read guest allocation authority');
select pg_temp.wake_assert(not has_function_privilege('anon','public.qorpera_check_runtime_office_guest_binding(jsonb,bigint,uuid,text,text,text)','EXECUTE'),'anonymous callers cannot read guest authority');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_execution_pause('30000000-0000-4000-8000-000000000010',false,'fixture');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_guest()$q$,'42501');
reset role;
