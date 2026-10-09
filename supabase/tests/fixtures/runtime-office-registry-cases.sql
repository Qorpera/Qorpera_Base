-- Runs after 924's folder-v2 runtime base (its part before "-- The checks start here"; ported from snapshot-v1 in the
-- legacy sweep): the owner registers the company's computer and Alice's live run (qorpera_test.base_binding) uses it.
-- test-runtime-node-capacity.mjs reads all of it; test-runtime-office-delete-disposition.mjs reads it up to the
-- synthetic readiness line.
-- Only physical readiness is synthetic; native authorization is not replaced.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.base_error($q$select public.qorpera_register_runtime_office(
	'92400000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)$q$,'42501');
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.office',public.qorpera_register_runtime_office(
	'92400000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.office')::jsonb->>'state'='provisioning','registration is not physical readiness');
select pg_temp.base_assert(public.qorpera_register_runtime_office(
	'92400000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)
	=current_setting('qorpera_test.office')::jsonb,'registration replay');
select pg_temp.base_error($q$select public.qorpera_register_runtime_office(
	'92400000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('c',64),repeat('b',64),2)$q$,'23505');
select set_config('qorpera_test.office_scope',(current_setting('qorpera_test.office')::jsonb-'state')::text,true);
-- Every active agent already holds the default grant (version 1, 2026-09-17 amendment); the owner's
-- explicit configuration is therefore the second version, and a replay of the first is stale.
select set_config('qorpera_test.office_grant',public.qorpera_set_runtime_office_access(
	(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid,
	'92400000-0000-4000-8000-000000000030',1,true)::text,true);
select pg_temp.base_error($q$select public.qorpera_set_runtime_office_access(
	(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid,
	'92400000-0000-4000-8000-000000000030',0,true)$q$,'PGRST');
reset role;

create function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_native_office_screen(current_setting('qorpera_test.base_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease)
$$;
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select pg_temp.office_call('acquire')$q$,'42501');
reset role;
-- Synthetic guest readiness only. This is not a provider or Linux test.
update public.qorpera_runtime_offices set state='active'
where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid;
