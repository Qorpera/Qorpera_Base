-- @fixture 707_folder_state_todos.test.sql until "-- 1. The company, two agents, and a todo"
-- An account's downgrade to the metered allocation counts its folder-v2 companies' stored bytes (migration
-- 20260930068000): qorpera_set_account_entitlement refuses it while a company the account owns stores more than its
-- allowance by the folder quota's own count (qorpera_folder_storage_usage against the smallest limit of the company's
-- files), and allows it at the allowance. A company the account only belongs to does not count. On 707's folder-v2
-- company (owner …01, contributor …02); rolled back at the end.

create function pg_temp.downgrade(p_user uuid) returns text language plpgsql as $$
begin
	perform public.qorpera_set_account_entitlement(p_user, 'freemium', 'free', 'standard', 'metered', 'test-suite',
		'Downgrade to the metered allocation');
	return 'downgraded';
exception when check_violation then
	return sqlerrm;
end $$;
create function pg_temp.upgrade(p_user uuid) returns void language sql as $$
	select public.qorpera_set_account_entitlement(p_user, 'internal', 'complimentary', 'all', 'unlimited', 'test-suite',
		'Complimentary access')
$$;
create function pg_temp.store(p_bytes bigint) returns void language sql as $$
	insert into public.qorpera_folder_storage_usage(profile_id, bytes, objects)
	values ('70700000-0000-4000-8000-000000000010', p_bytes, 1)
	on conflict (profile_id) do update set bytes = excluded.bytes
$$;
create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;

do $$
declare v_limit bigint;
begin
	-- The company's allowance, as the folder quota reads it; a second, smaller limit on another file row would win.
	select min(storage_limit_bytes) into v_limit from public.qorpera_company_files
	where profile_id = '70700000-0000-4000-8000-000000000010';
	if v_limit is null or not public.qorpera_company_is_folder_v2('70700000-0000-4000-8000-000000000010') then
		raise exception 'Fixture: a folder-v2 company with a storage limit'; end if;
	-- The owner on complimentary access stores one byte more than the metered allowance: no downgrade.
	perform pg_temp.upgrade('70700000-0000-4000-8000-000000000001');
	perform pg_temp.store(v_limit + 1);
	perform pg_temp.is(pg_temp.downgrade('70700000-0000-4000-8000-000000000001'),
		'account storage exceeds the requested metered allocation', 'a folder-v2 company over the allowance');
	if (select storage_allocation from public.qorpera_account_entitlements
			where user_id = '70700000-0000-4000-8000-000000000001') is distinct from 'unlimited'
		or (select count(*) from public.qorpera_account_entitlement_changes
			where user_id = '70700000-0000-4000-8000-000000000001') <> 1 then
		raise exception 'A refused downgrade changes and records nothing'; end if;
	-- The snapshot-v1 count is not read: a company file row's own count says nothing.
	update public.qorpera_company_files set storage_used_bytes = 0 where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.downgrade('70700000-0000-4000-8000-000000000001'),
		'account storage exceeds the requested metered allocation', 'whatever the company file row says');
	-- A contributor's account is not held by a company it does not own.
	perform pg_temp.upgrade('70700000-0000-4000-8000-000000000002');
	perform pg_temp.is(pg_temp.downgrade('70700000-0000-4000-8000-000000000002'), 'downgraded', 'a member who does not own it');
	-- At the allowance, the owner's downgrade goes through, and is recorded.
	perform pg_temp.store(v_limit);
	perform pg_temp.is(pg_temp.downgrade('70700000-0000-4000-8000-000000000001'), 'downgraded', 'at the allowance');
	if (select storage_allocation from public.qorpera_account_entitlements
			where user_id = '70700000-0000-4000-8000-000000000001') is distinct from 'metered'
		or (select count(*) from public.qorpera_account_entitlement_changes
			where user_id = '70700000-0000-4000-8000-000000000001') <> 2 then
		raise exception 'The downgrade is saved and recorded'; end if;
end $$;

-- Only the service changes an entitlement.
do $$
declare v_state text;
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70700000-0000-4000-8000-000000000001"}', true);
	begin
		perform pg_temp.upgrade('70700000-0000-4000-8000-000000000001');
		v_state := 'allowed';
	exception when insufficient_privilege then v_state := '42501';
	end;
	perform pg_temp.is(v_state, '42501', 'a member never sets their own entitlement');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if has_function_privilege('authenticated', 'public.qorpera_set_account_entitlement(uuid,text,text,text,text,text,text)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_set_account_entitlement(uuid,text,text,text,text,text,text)',
			'execute') then
		raise exception 'Grants of the entitlement setter'; end if;
end $$;

rollback;
