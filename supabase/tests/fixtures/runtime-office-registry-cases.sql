-- Runs after 924's folder-v2 runtime base (its part before "-- The checks start here"; ported from snapshot-v1 in the
-- legacy sweep): the owner registers the company's computer and Alice's live run (qorpera_test.base_binding) uses it.
-- test-runtime-node-capacity.mjs and test-runtime-office-delete-disposition.mjs read its first part.
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
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.base_assert(public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.office_lease')::jsonb->'binding')->>'state'='authorized','open shared screen has independent physical lifetime authority');
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_shared_surface(jsonb_set(current_setting('qorpera_test.office_lease')::jsonb->'binding','{screenGeneration}','999'))$q$,'42501');
select pg_temp.base_assert((current_setting('qorpera_test.office_lease')::jsonb->>'validForMs')::integer between 1 and 30000,'bounded screen lease');
select pg_temp.base_assert(public.qorpera_runtime_office_screen_appearance(current_setting('qorpera_test.office_lease')::jsonb->'binding')
	='{"creature":null,"templateId":null}'::jsonb,'open shared screen reads exactly the agent appearance fields');
select pg_temp.base_error($q$select public.qorpera_runtime_office_screen_appearance(jsonb_set(current_setting('qorpera_test.office_lease')::jsonb->'binding','{screenGeneration}','999'))$q$,'42501');
select pg_temp.base_assert(not has_function_privilege('authenticated','public.qorpera_runtime_office_screen_appearance(jsonb)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_runtime_office_screen_appearance(jsonb)','EXECUTE'),'screen appearance is broker only');
select pg_temp.base_assert(pg_temp.office_call('acquire')='{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb,'one driver per screen');
select pg_temp.base_assert(pg_temp.office_call('check',current_setting('qorpera_test.office_lease')::jsonb)->>'state'='admitted','current exact lease');
select pg_temp.base_assert(pg_temp.office_call('renew',current_setting('qorpera_test.office_lease')::jsonb)#>>'{lease,leaseId}'
	=current_setting('qorpera_test.office_lease')::jsonb->>'leaseId','renew preserves identity');
select pg_temp.base_error($q$select pg_temp.office_call('renew',jsonb_set(current_setting('qorpera_test.office_lease')::jsonb,
	'{epoch}','999'))$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_native_office_screen(current_setting('qorpera_test.base_binding')::jsonb,
	jsonb_set(current_setting('qorpera_test.office_scope')::jsonb,'{companyId}','"34000000-0000-4000-8000-000000000099"'),
	'acquire')$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_native_office_screen(
	jsonb_set(current_setting('qorpera_test.base_binding')::jsonb,'{runnerId}','"34000000-0000-4000-8000-000000000099"'),
	current_setting('qorpera_test.office_scope')::jsonb,'acquire')$q$,'42501');
reset role;

-- The workbench is not permitted to become an execution computer or gain
-- provider identity/raw-mount authority by editing its logical computer row.
select pg_temp.base_error($q$update public.qorpera_logical_computers set capabilities='["agent_turn"]'
	where id=(current_setting('qorpera_test.office_scope')::jsonb->>'logicalComputerId')::uuid$q$,'42501');
select pg_temp.base_error($q$update public.qorpera_logical_computers set policy=jsonb_set(policy,'{canonicalMount}','true')
	where id=(current_setting('qorpera_test.office_scope')::jsonb->>'logicalComputerId')::uuid$q$,'42501');
select pg_temp.base_error($q$update public.qorpera_logical_computers set compute_identity_id=
	(current_setting('qorpera_test.base_binding')::jsonb->>'computeIdentityId')::uuid
	where id=(current_setting('qorpera_test.office_scope')::jsonb->>'logicalComputerId')::uuid$q$,'42501');

-- Revocation prevents renew/result release; exact cleanup remains possible.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid,
	'92400000-0000-4000-8000-000000000030',2,false);
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select pg_temp.office_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.office_lease')::jsonb->'binding')$q$,'42501');
select pg_temp.base_error($q$select pg_temp.office_call('renew',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.base_assert(pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb)='{"state":"released"}'::jsonb,'cleanup after grant revocation');
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_runtime_office_access((current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid,
	'92400000-0000-4000-8000-000000000030',3,true);
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease_2',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.base_assert(current_setting('qorpera_test.office_lease')::jsonb->>'leaseId'<>
	current_setting('qorpera_test.office_lease_2')::jsonb->>'leaseId','fresh claim identity');
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
select pg_temp.base_assert(pg_temp.office_call('check',current_setting('qorpera_test.office_lease_2')::jsonb)->>'state'='admitted','old cleanup preserves replacement');
reset role;
update public.qorpera_runtime_office_screens set lease_expires_at=clock_timestamp()-interval '1 second';
set local role service_role;
select pg_temp.base_error($q$select pg_temp.office_call('renew',current_setting('qorpera_test.office_lease_2')::jsonb)$q$,'42501');
select pg_temp.base_assert(pg_temp.office_call('acquire')='{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb,'expiry is not drain proof');
reset role;
-- Expire the native lease too: exact cleanup cannot depend on live native work.
update public.qorpera_native_provider_connection_leases set expires_at=clock_timestamp()
where id=(current_setting('qorpera_test.base_binding')::jsonb->>'leaseId')::uuid;
set local role service_role;
select pg_temp.base_assert(pg_temp.office_call('release',current_setting('qorpera_test.office_lease_2')::jsonb)='{"state":"released"}'::jsonb,'cleanup after native expiry');
select pg_temp.base_error($q$select pg_temp.office_call('acquire')$q$,'42501');
reset role;

do $$
declare v_role text; v_table text; v_function regprocedure;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		foreach v_table in array array['qorpera_runtime_offices','qorpera_runtime_office_access','qorpera_runtime_office_screens'] loop
			perform pg_temp.base_assert(not has_table_privilege(v_role,'public.'||v_table,'SELECT,INSERT,UPDATE,DELETE'),v_role||' has raw office table access');
		end loop;
		for v_function in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
			and proname in ('qorpera_runtime_office_matches','qorpera_runtime_office_policy','qorpera_guard_runtime_office_binding',
				'qorpera_runtime_office_scope','qorpera_runtime_office_screen_lease') loop
			perform pg_temp.base_assert(not has_function_privilege(v_role,v_function,'EXECUTE'),v_role||' has internal office function access');
		end loop;
	end loop;
end
$$;
