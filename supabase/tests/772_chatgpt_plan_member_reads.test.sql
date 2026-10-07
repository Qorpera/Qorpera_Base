-- @fixture 764_chatgpt_plan_login.test.sql until "-- The plan login's own checks start here"
-- Who may record a ChatGPT plan's first-routine card on folder-v2 (ported from snapshot-v1 in the legacy sweep; Sign in
-- with ChatGPT, slice 5a, 20260928369970): a member records it through the one call, and nobody reads or writes its
-- table directly; it is refused for someone outside the company, for the plan named under another company, for a
-- member who left, and in a company being deleted. Test 764's fixture leaves the owner with a plan login.
reset role;
do $$
declare v_plan uuid;
begin
	select version.connection_id into strict v_plan from public.qorpera_provider_connection_versions as version
	join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
	where login.id = '76400000-0000-4000-8000-000000000150' and version.version = 1;
	perform set_config('qorpera_test.r772_plan', v_plan::text, false);
	if has_function_privilege('anon', 'public.qorpera_record_chatgpt_plan_routine_offer(uuid,uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_record_chatgpt_plan_routine_offer(uuid,uuid)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_record_chatgpt_plan_routine_offer(uuid,uuid)', 'execute') then
		raise exception 'the offer record has the wrong callers'; end if;
	if exists (select 1 from unnest(array['anon','authenticated','service_role']) as role(name)
		where has_table_privilege(role.name, 'public.qorpera_chatgpt_plan_routine_offers', 'select,insert,update,delete')) then
		raise exception 'the offers table is open to the API'; end if;
end $$;
create function pg_temp.r772_record(p_user text, p_profile text) returns text language plpgsql as $$
begin
	perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, false);
	set local role authenticated;
	return pg_temp.plan764_try(format('select public.qorpera_record_chatgpt_plan_routine_offer(%L,%L)::text', p_profile,
		current_setting('qorpera_test.r772_plan')));
end $$;

-- Refused for someone outside the company, and for the plan named under another company (the owner is in that one too).
set local session_replication_role = replica;
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('76400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001',
	'base-owner@example.test', 'Owner', 'contributor');
set local session_replication_role = origin;
select pg_temp.plan764_expect(pg_temp.r772_record('92400000-0000-4000-8000-000000000005',
	'92400000-0000-4000-8000-000000000010'), '42501:ChatGPT plan login is unavailable', 'someone outside the company');
reset role;
select pg_temp.plan764_expect(pg_temp.r772_record('92400000-0000-4000-8000-000000000001',
	'76400000-0000-4000-8000-000000000010'), '42501:ChatGPT plan login is unavailable', 'the plan named under another company');
reset role;
-- The member's own card is recorded...
select pg_temp.plan764_expect(pg_temp.r772_record('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000010'), 'ok', 'the member''s card is shown');
reset role;
-- ...but not by a member who left, or in a company being deleted.
savepoint r772_left;
set local session_replication_role = replica;
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
select pg_temp.plan764_expect(pg_temp.r772_record('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000010'), '42501:ChatGPT plan login is unavailable', 'a member who left');
reset role;
rollback to savepoint r772_left;
savepoint r772_deleting;
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
select pg_temp.plan764_expect(pg_temp.r772_record('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000010'), '42501:ChatGPT plan login is unavailable', 'a company being deleted');
reset role;
rollback to savepoint r772_deleting;

rollback;
