-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
-- Interfaces C6a, which pages a company shows (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §4): only Mailbox and
-- Members, both off until an owner or admin switches one on. Every member reads them; a contributor, a viewer, someone
-- who is not a member, another company's owner and a company being deleted switch nothing; no other page can be
-- switched. Switching changes no data: the folder, its commits, the areas' consents and offers, the members and who
-- pays stay as they were.

-- Calls as a signed-in member, then as the service again; an error answers its SQLSTATE.
create function pg_temp.c6_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
	execute p_sql into r;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return r;
exception when others then
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end $$;
-- 634's users by number: 1 owner, 2 and 4 contributors, 3 viewer, 5 admin; 99 is nobody's. 68800000-…-01 owns the
-- second company.
create function pg_temp.c6_user(p_n integer) returns uuid language sql immutable as $$
	select case when p_n = 101 then '68800000-0000-4000-8000-000000000001'::uuid
		else ('63400000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid end
$$;
create function pg_temp.c6_list(p_by integer, p_env uuid default '63400000-0000-4000-8000-000000000020') returns jsonb
language sql as $$
	select pg_temp.c6_call(pg_temp.c6_user(p_by), format('select public.qorpera_member_interface_pages(%L)', p_env))
$$;
create function pg_temp.c6_set(p_by integer, p_page text, p_on boolean,
	p_env uuid default '63400000-0000-4000-8000-000000000020') returns jsonb language sql as $$
	select pg_temp.c6_call(pg_temp.c6_user(p_by), format('select public.qorpera_set_interface_page(%L, %L, %L)',
		p_env, p_page, p_on))
$$;
create function pg_temp.c6_error(p_answer jsonb, p_state text) returns void language plpgsql as $$
begin
	if p_answer ->> 'error' is distinct from p_state then
		raise exception 'Expected SQLSTATE %, got %', p_state, p_answer using errcode = 'QTF01'; end if;
end $$;
-- The answer for Mailbox and Members on or off.
create function pg_temp.c6_pages(p_mailbox boolean, p_members boolean, p_may boolean) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.member-interface-pages/v1', 'pages', jsonb_build_array(
		jsonb_build_object('page', 'mailbox', 'on', p_mailbox), jsonb_build_object('page', 'members', 'on', p_members)),
		'mayChange', p_may)
$$;
-- Everything a switch must leave alone, for 634's company: its folder and commits, the areas' consents and offers,
-- its members, its notifications, and who pays.
create function pg_temp.c6_data() returns text language sql as $$
	select md5(concat_ws('|',
		(select jsonb_agg(to_jsonb(e) order by e.key_text, e.kind, e.version) from public.qorpera_folder_entries e
			where e.environment_id = '63400000-0000-4000-8000-000000000020')::text,
		(select jsonb_agg(to_jsonb(c) order by c.id) from public.qorpera_folder_commits c
			where c.environment_id = '63400000-0000-4000-8000-000000000020')::text,
		(select jsonb_agg(to_jsonb(s) order by s.id) from public.qorpera_interface_supervisions s)::text,
		(select jsonb_agg(to_jsonb(o) order by o.id) from public.qorpera_interface_offers o)::text,
		(select jsonb_agg(to_jsonb(m) order by m.user_id) from public.qorpera_profile_members m
			where m.profile_id = '63400000-0000-4000-8000-000000000010')::text,
		(select jsonb_agg(to_jsonb(n) order by n.id) from public.qorpera_member_notifications n)::text,
		(select jsonb_agg(to_jsonb(b) order by b.id) from public.qorpera_execution_sponsor_bindings b
			where b.profile_id = '63400000-0000-4000-8000-000000000010')::text))
$$;

-- 0. The grants: members call the two; the answer's helper and the table are the platform's own.
do $$
declare f text;
begin
	foreach f in array array['public.qorpera_member_interface_pages(uuid)',
		'public.qorpera_set_interface_page(uuid,text,boolean)'] loop
		if not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
			or has_function_privilege('service_role', f, 'execute') then raise exception 'The grants of %', f; end if;
	end loop;
	if has_function_privilege('authenticated', 'public.qorpera_interface_pages_json(uuid,uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_interface_pages_json(uuid,uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_interface_pages_json(uuid,uuid)', 'execute') then
		raise exception 'The grants of the answer''s helper'; end if;
	if has_table_privilege('authenticated', 'public.qorpera_interface_pages', 'select,insert,update,delete')
		or has_table_privilege('anon', 'public.qorpera_interface_pages', 'select,insert,update,delete')
		or has_table_privilege('service_role', 'public.qorpera_interface_pages', 'select,insert,update,delete') then
		raise exception 'The pages table''s grants'; end if;
end $$;

-- 1. Both pages start off, for every member; only the owner and the admin may switch them. Someone who is not a member
-- reads nothing.
do $$
declare n integer;
begin
	foreach n in array array[1, 2, 3, 4, 5] loop
		if pg_temp.c6_list(n) is distinct from pg_temp.c6_pages(false, false, n in (1, 5)) then
			raise exception 'Member %''s first list: %', n, pg_temp.c6_list(n); end if;
	end loop;
	perform pg_temp.c6_error(pg_temp.c6_list(99), '42501');
end $$;

-- 2. A contributor, a viewer and someone who is not a member switch nothing; nor does anyone switch a page that is not
-- Mailbox or Members (Pulse, a custom page, a name in another case), or switch to nothing.
do $$
declare v_page text;
begin
	perform pg_temp.c6_error(pg_temp.c6_set(2, 'members', true), '42501');
	perform pg_temp.c6_error(pg_temp.c6_set(4, 'mailbox', true), '42501');
	perform pg_temp.c6_error(pg_temp.c6_set(3, 'members', true), '42501');
	perform pg_temp.c6_error(pg_temp.c6_set(99, 'members', true), '42501');
	foreach v_page in array array['pulse', 'numbers', 'my-board', 'Mailbox', 'members ', ''] loop
		perform pg_temp.c6_error(pg_temp.c6_set(1, v_page, true), '22023');
	end loop;
	perform pg_temp.c6_error(pg_temp.c6_set(1, null, true), '22023');
	perform pg_temp.c6_error(pg_temp.c6_set(1, 'members', null), '22023');
	if exists (select 1 from public.qorpera_interface_pages) then raise exception 'A refused switch left a row'; end if;
end $$;

-- 3. Business data on the areas: member 2 takes Sales's supervisor (agent A in it), a live consent. The owner turns
-- Members on and the admin Mailbox; every member sees both on. The same switch again changes nothing. The owner turns
-- Mailbox off and on again. None of it touches the data.
do $$
declare v_data text; r jsonb; v_at timestamptz;
	c_m constant text := '63400000-0000-4000-8000-000000000002';
	c_a1 constant text := '63400000-0000-4000-8000-0000000000a1'; c_a2 constant text := '63400000-0000-4000-8000-0000000000a2';
begin
	perform pg_temp.expect(pg_temp.save_rows(pg_temp.member(2), 'c6-pages-0001', 'tables/areas/rows.csv',
		pg_temp.rows(array['area','owner','supervisor','agents','shared'],
			array[array['Sales','',c_m,c_a1,'no'], array['Ops','','',c_a2,'no']])), 1, 'saved');
	if (select count(*) from public.qorpera_interface_supervisions where state = 'live') is distinct from 1 then
		raise exception 'The consent to keep'; end if;
	v_data := pg_temp.c6_data();

	r := pg_temp.c6_set(1, 'members', true);
	if r is distinct from pg_temp.c6_pages(false, true, true) then raise exception 'The owner turns Members on: %', r; end if;
	r := pg_temp.c6_set(5, 'mailbox', true);
	if r is distinct from pg_temp.c6_pages(true, true, true) then raise exception 'The admin turns Mailbox on: %', r; end if;
	if pg_temp.c6_list(3) is distinct from pg_temp.c6_pages(true, true, false)
		or pg_temp.c6_list(2) is distinct from pg_temp.c6_pages(true, true, false) then
		raise exception 'The members see: %', pg_temp.c6_list(3); end if;
	if (select changed_by_user_id from public.qorpera_interface_pages where page = 'mailbox') is distinct from pg_temp.c6_user(5)
		then raise exception 'Who turned Mailbox on'; end if;

	select changed_at into v_at from public.qorpera_interface_pages where page = 'members';
	r := pg_temp.c6_set(5, 'members', true);
	if r is distinct from pg_temp.c6_pages(true, true, true)
		or (select (changed_at, changed_by_user_id) from public.qorpera_interface_pages where page = 'members')
			is distinct from (v_at, pg_temp.c6_user(1)) then
		raise exception 'The same switch again: %', r; end if;

	if pg_temp.c6_set(1, 'mailbox', false) is distinct from pg_temp.c6_pages(false, true, true) then
		raise exception 'The owner turns Mailbox off'; end if;
	if pg_temp.c6_data() is distinct from v_data then raise exception 'Switching changed the company''s data'; end if;
	if pg_temp.c6_set(1, 'mailbox', true) is distinct from pg_temp.c6_pages(true, true, true)
		or pg_temp.c6_set(1, 'members', false) is distinct from pg_temp.c6_pages(true, false, true)
		or pg_temp.c6_set(1, 'members', true) is distinct from pg_temp.c6_pages(true, true, true) then
		raise exception 'Off and on again'; end if;
	if pg_temp.c6_data() is distinct from v_data then raise exception 'Off and on again changed the company''s data'; end if;
	if (select count(*) from public.qorpera_interface_supervisions where state = 'live') is distinct from 1 then
		raise exception 'The consent after the switches'; end if;
end $$;

-- 4. Another company: its pages are its own. 634's owner neither reads nor switches them; its owner switches its pages
-- without touching 634's.
insert into auth.users(id, email) values ('68800000-0000-4000-8000-000000000001', 'pages-other-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('68800000-0000-4000-8000-000000000010', 'Pages fixture', '68800000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('68800000-0000-4000-8000-000000000010', '68800000-0000-4000-8000-000000000001', 'pages-other-owner@example.test',
		'Other owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('68800000-0000-4000-8000-000000000020', '68800000-0000-4000-8000-000000000010', 'Environment', 1,
		'68800000-0000-4000-8000-000000000001');
select public.qorpera_folder_enable('68800000-0000-4000-8000-000000000020') \g /dev/null

do $$
declare c_other constant uuid := '68800000-0000-4000-8000-000000000020';
begin
	if pg_temp.c6_list(101, c_other) is distinct from pg_temp.c6_pages(false, false, true) then
		raise exception 'The other company''s first list: %', pg_temp.c6_list(101, c_other); end if;
	perform pg_temp.c6_error(pg_temp.c6_list(1, c_other), '42501');
	perform pg_temp.c6_error(pg_temp.c6_set(1, 'mailbox', true, c_other), '42501');
	perform pg_temp.c6_error(pg_temp.c6_set(101, 'mailbox', false), '42501');
	if pg_temp.c6_set(101, 'mailbox', true, c_other) is distinct from pg_temp.c6_pages(true, false, true) then
		raise exception 'The other owner turns Mailbox on'; end if;
	if pg_temp.c6_set(101, 'mailbox', false, c_other) is distinct from pg_temp.c6_pages(false, false, true)
		or pg_temp.c6_list(1) is distinct from pg_temp.c6_pages(true, true, true) then
		raise exception 'The other company''s switch reached 634''s: %', pg_temp.c6_list(1); end if;
end $$;

-- 5. An admin made a contributor switches nothing more; an owner of a company being deleted neither. The list still
-- answers, and the pages stay as they were.
do $$
begin
	update public.qorpera_profile_members set role = 'contributor'
	where profile_id = '63400000-0000-4000-8000-000000000010' and user_id = pg_temp.c6_user(5);
	perform pg_temp.c6_error(pg_temp.c6_set(5, 'members', false), '42501');
	if pg_temp.c6_list(5) is distinct from pg_temp.c6_pages(true, true, false) then
		raise exception 'The former admin''s list: %', pg_temp.c6_list(5); end if;
	insert into public.qorpera_company_deletions(profile_id) values ('63400000-0000-4000-8000-000000000010');
	perform pg_temp.c6_error(pg_temp.c6_set(1, 'members', false), '55000');
	if pg_temp.c6_list(1) is distinct from pg_temp.c6_pages(true, true, true) then
		raise exception 'The list while deleting: %', pg_temp.c6_list(1); end if;
end $$;
