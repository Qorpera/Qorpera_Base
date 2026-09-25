-- Real member RPCs, with privileged fixture insertion only to represent the
-- ownership grant that the separate founding launch flow will commit.
begin;
insert into auth.users(id,email,email_confirmed_at) values
	('62900000-0000-4000-8000-000000000001','founder-a629@example.test',now()),
	('62900000-0000-4000-8000-000000000002','founder-b629@example.test',now()),
	('62900000-0000-4000-8000-000000000003','member-c629@example.test',now());
create function pg_temp.founder_claims(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id=p_user),'user_metadata','{}'::jsonb)::text,true)::void
$$;
create function pg_temp.founder_denied(p_sql text,p_code text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_code then return; end if; raise;
	end;
	raise exception 'Expected %: %',p_code,p_sql;
end
$$;
-- Legacy company fixture creation is privileged. New public creation must use
-- the founding boundary; this suite independently tests membership invariants.
create function pg_temp.multiowner_fixture_profile(p_name text,p_environment text,p_contract integer)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_create_hosted_profile(p_name,p_environment,p_contract)
$$;
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.multiowner',
	pg_temp.multiowner_fixture_profile('Multiple founders','main',2)->>'profile_id',true);
reset role;
select public.qorpera_seed_company_cofounder(current_setting('qorpera_test.multiowner')::uuid,
	'62900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	(current_setting('qorpera_test.multiowner')::uuid,'62900000-0000-4000-8000-000000000002','founder-b629@example.test','B','owner'),
	(current_setting('qorpera_test.multiowner')::uuid,'62900000-0000-4000-8000-000000000003','member-c629@example.test','C','contributor');

-- Entitlements remain assigned to the explicit responsible account, with no
-- model-account or storage pooling. An unrelated owner's plan cannot win.
insert into public.qorpera_account_entitlements(user_id,plan_key,billing_mode,feature_set,storage_allocation,operator_reference,reason)
values ('62900000-0000-4000-8000-000000000002','internal','complimentary','all','unlimited','fixture','ownership isolation');
do $$ begin
	if public.qorpera_profile_entitlement_json(current_setting('qorpera_test.multiowner')::uuid)->>'plan_key' <> 'freemium' then
		raise exception 'Company inherited an unrelated co-founder entitlement'; end if;
	if public.qorpera_company_owner_user_id(current_setting('qorpera_test.multiowner')::uuid) <>
		'62900000-0000-4000-8000-000000000001'::uuid then raise exception 'Creator attribution changed'; end if;
end $$;
set local role authenticated;
select pg_temp.founder_denied(format('select public.qorpera_leave_hosted_profile(%L)',current_setting('qorpera_test.multiowner')),'42501');
select pg_temp.founder_denied(format('select public.qorpera_delete_hosted_profile(%L)',current_setting('qorpera_test.multiowner')),'42501');
select pg_temp.founder_denied(format('select public.qorpera_remove_profile_member(%L,%L)',current_setting('qorpera_test.multiowner'),
	'62900000-0000-4000-8000-000000000002'),'42501');
select pg_temp.founder_denied(format('select public.qorpera_update_profile_member_role(%L,%L,''owner'')',current_setting('qorpera_test.multiowner'),
	'62900000-0000-4000-8000-000000000003'),'22023');
select pg_temp.founder_denied(format('select public.qorpera_invite_profile_member(%L,''extra629@example.test'',''owner'')',
	current_setting('qorpera_test.multiowner')),'22023');
reset role;

-- Contributor departure used to fail in the thread trigger's scalar owner
-- lookup whenever two founders remained.
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.founder_denied(format('select public.qorpera_accept_computer_usage_ownership(%L,%L)',
	current_setting('qorpera_test.multiowner'),'62900000-0000-4000-8000-000000000001'),'42501');
select public.qorpera_leave_hosted_profile(current_setting('qorpera_test.multiowner')::uuid);
reset role;

-- The recipient explicitly accepts the responsibility; stale requests fail.
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_accept_computer_usage_ownership(current_setting('qorpera_test.multiowner')::uuid,
	'62900000-0000-4000-8000-000000000001');
select pg_temp.founder_denied(format('select public.qorpera_accept_computer_usage_ownership(%L,%L)',
	current_setting('qorpera_test.multiowner'),'62900000-0000-4000-8000-000000000001'),'40001');
reset role;
do $$ begin
	if public.qorpera_profile_entitlement_json(current_setting('qorpera_test.multiowner')::uuid)->>'plan_key' <> 'internal' then
		raise exception 'Explicit usage owner entitlement missing'; end if;
end $$;
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_leave_hosted_profile(current_setting('qorpera_test.multiowner')::uuid);
reset role;
do $$ begin
	if public.qorpera_company_owner_user_id(current_setting('qorpera_test.multiowner')::uuid) <>
		'62900000-0000-4000-8000-000000000002'::uuid then raise exception 'Current founder attribution missing'; end if;
	if (select created_by_user_id from public.qorpera_profiles where id=current_setting('qorpera_test.multiowner')::uuid) <>
		'62900000-0000-4000-8000-000000000001'::uuid then raise exception 'Creator provenance was reassigned'; end if;
end $$;
select pg_temp.founder_denied('delete from auth.users where id=''62900000-0000-4000-8000-000000000001''','23503');
select pg_temp.founder_denied(format('delete from public.qorpera_profile_members where profile_id=%L',current_setting('qorpera_test.multiowner')),'42501');

-- Bootstrap retries retain the creator even after another owner joins.
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.multiowner_bootstrap',public.qorpera_create_cloud_company(
	'62900000-0000-4000-8000-000000000010','Bootstrap with founders',2)->>'profile_id',true);
reset role;
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	(current_setting('qorpera_test.multiowner_bootstrap')::uuid,'62900000-0000-4000-8000-000000000002','founder-b629@example.test','B','owner');
do $$ declare v_job public.qorpera_company_bootstrap_jobs%rowtype; begin
	v_job := public.qorpera_enqueue_company_bootstrap(current_setting('qorpera_test.multiowner_bootstrap')::uuid,true);
	if v_job.created_by_user_id <> '62900000-0000-4000-8000-000000000001'::uuid then
		raise exception 'Bootstrap changed its creator'; end if;
end $$;
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_accept_computer_usage_ownership(current_setting('qorpera_test.multiowner_bootstrap')::uuid,
	'62900000-0000-4000-8000-000000000001');
reset role;
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.founder_denied(format('select public.qorpera_leave_hosted_profile(%L)',current_setting('qorpera_test.multiowner_bootstrap')),'42501');
reset role;
-- Sole-owner deletion remains available and may cascade its last membership.
select pg_temp.founder_claims('62900000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.multiowner_solo',pg_temp.multiowner_fixture_profile('Solo deletion','main',2)->>'profile_id',true);
select public.qorpera_delete_hosted_profile(current_setting('qorpera_test.multiowner_solo')::uuid);
reset role;
do $$ begin
	if exists(select 1 from public.qorpera_profiles where id=current_setting('qorpera_test.multiowner_solo')::uuid) then
		raise exception 'Sole-owner company deletion was blocked'; end if;
	if has_function_privilege('anon','public.qorpera_accept_computer_usage_ownership(uuid,uuid)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_accept_computer_usage_ownership(uuid,uuid)','EXECUTE') then
		raise exception 'Computer Usage ownership entry point is exposed'; end if;
end $$;
rollback;
