-- Disposable infrastructure enrollment and provider discovery only.
reset role;
update public.qorpera_runtime_offices set state='provisioning';
create function pg_temp.provider_set(p_version bigint,p_enabled boolean,p_provider uuid default '36000000-0000-4000-8000-000000000001',p_policy text default repeat('f',64))
returns jsonb language sql as $$
	select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,1,p_provider,p_policy,p_version,p_enabled)
$$;
create function pg_temp.provider_status(p_provider uuid default '36000000-0000-4000-8000-000000000001',p_policy text default repeat('f',64))
returns jsonb language sql as $$
	select public.qorpera_runtime_office_provider_status(current_setting('qorpera_test.office_scope')::jsonb,1,p_provider,p_policy)
$$;
create function pg_temp.provider_reserve(p_provider uuid default '36000000-0000-4000-8000-000000000001',p_policy text default repeat('f',64))
returns jsonb language sql as $$
	select public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
		'36000000-0000-4000-8000-000000000002','36000000-0000-4000-8000-000000000003',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),p_provider,p_policy)
$$;
create function pg_temp.provider_check() returns jsonb language sql as $$
	select public.qorpera_check_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,
		'36000000-0000-4000-8000-000000000002','36000000-0000-4000-8000-000000000003',repeat('c',64),repeat('d',64),
		'36000000-0000-4000-8000-000000000001',repeat('f',64))
$$;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.provider_status()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_reserve()$q$,'42501');
reset role;
savepoint preexisting_provider_allocation;
set local role service_role;
select public.qorpera_reserve_runtime_machine('36000000-0000-4000-8000-000000000099','lxd',repeat('c',64),null,null,
	(current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId')::uuid,1);
select pg_temp.wake_error($q$select pg_temp.provider_set(0,true)$q$,'42501');
reset role;
rollback to savepoint preexisting_provider_allocation;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.provider_set(0,true)$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_status()$q$,'42501');
select public.qorpera_request_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'36000000-0000-4000-8000-000000000002');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.provider_set(0,true)='{"providerId":"36000000-0000-4000-8000-000000000001","policySha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","computerGeneration":1,"version":1,"preparationEnabled":true}'::jsonb,'infrastructure enrollment');
select pg_temp.wake_error($q$select pg_temp.provider_set(0,true)$q$,'40001');
select pg_temp.wake_error($q$select pg_temp.provider_set(1,true,'36000000-0000-4000-8000-000000000090')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_set(1,true,'36000000-0000-4000-8000-000000000001',repeat('e',64))$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_status('36000000-0000-4000-8000-000000000090')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_reserve('36000000-0000-4000-8000-000000000090')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_reserve('36000000-0000-4000-8000-000000000001',repeat('e',64))$q$,'42501');
select pg_temp.wake_assert(pg_temp.provider_status()=jsonb_build_object(
	'schema','qorpera.office-provider-status/v1','scope',current_setting('qorpera_test.office_scope')::jsonb,
	'computerGeneration',1,'officeState','provisioning','providerId','36000000-0000-4000-8000-000000000001',
	'providerPolicySha256',repeat('f',64),'providerVersion',1,'preparationEnabled',true,'imageSha256',repeat('a',64),'bootstrapSha256',repeat('b',64),
	'intent',jsonb_build_object('schema','qorpera.office-start-intent/v1','intentId','36000000-0000-4000-8000-000000000002',
		'companyComputerId',current_setting('qorpera_test.office_scope')::jsonb->>'companyComputerId','computerGeneration',1,'state','requested'),
	'reservation',null),'closed exact discovery metadata');
select pg_temp.wake_assert(pg_temp.provider_reserve()->>'state'='reserved','assigned provider reserves');
select pg_temp.wake_assert(pg_temp.provider_check()->>'state'='authorized','assigned provider prepares');
select pg_temp.wake_assert(pg_temp.provider_status()#>>'{reservation,allocationId}'='36000000-0000-4000-8000-000000000003','reservation survives provider restart discovery');
select pg_temp.provider_set(1,false);
select pg_temp.wake_error($q$select pg_temp.provider_check()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.provider_reserve()$q$,'42501');
select pg_temp.wake_assert(pg_temp.provider_status()->'preparationEnabled'='false'::jsonb
	and pg_temp.provider_status()#>>'{reservation,allocationId}'='36000000-0000-4000-8000-000000000003','disabled provider still discovers retained allocation');
select pg_temp.provider_set(2,true);
select pg_temp.wake_assert(pg_temp.provider_check()->>'state'='authorized','explicit reenable keeps exact host and policy');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_cancel_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,1,'36000000-0000-4000-8000-000000000002');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.provider_status()#>>'{intent,state}'='cancelled'
	and pg_temp.provider_status()#>>'{reservation,allocationId}'='36000000-0000-4000-8000-000000000003','cancelled demand remains discoverable for physical reconciliation');
select pg_temp.wake_error($q$select pg_temp.provider_check()$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_machine_allocations where released_at is null),'disable/cancel never frees capacity');
update public.qorpera_runtime_offices set generation=2;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.provider_status()$q$,'42501');
reset role;
do $$
declare v_role text; v_function regprocedure;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		perform pg_temp.wake_assert(not has_table_privilege(v_role,'public.qorpera_runtime_office_providers','SELECT,INSERT,UPDATE,DELETE'),'private provider table');
		for v_function in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
			and proname in ('qorpera_assert_runtime_office_provider','qorpera_reserve_runtime_office_start_unbound','qorpera_check_runtime_office_start_unbound') loop
			perform pg_temp.wake_assert(not has_function_privilege(v_role,v_function,'EXECUTE'),'old unbound authority is private');
		end loop;
	end loop;
end
$$;
