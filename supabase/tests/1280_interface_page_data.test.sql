-- @fixture 865_folder_state_tables.test.sql until "-- 1. The port of parseTableRows"
create function pg_temp.pd_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
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
create function pg_temp.pd_user(p_n integer) returns uuid language sql immutable as $$
	select ('63400000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.pd_list(p_by integer) returns jsonb language sql as $$
	select pg_temp.pd_call(pg_temp.pd_user(p_by),
		'select public.qorpera_member_interface_pages(''63400000-0000-4000-8000-000000000020'')')
$$;
create function pg_temp.pd_set(p_by integer, p_page text, p_on boolean) returns jsonb language sql as $$
	select pg_temp.pd_call(pg_temp.pd_user(p_by), format(
		'select public.qorpera_set_interface_page(''63400000-0000-4000-8000-000000000020'', %L, %L)', p_page, p_on))
$$;
create function pg_temp.pd_hide(p_by integer, p_page text, p_hidden boolean) returns jsonb language sql as $$
	select pg_temp.pd_call(pg_temp.pd_user(p_by), format(
		'select public.qorpera_set_interface_page_hidden(''63400000-0000-4000-8000-000000000020'', %L, %L)', p_page, p_hidden))
$$;
create function pg_temp.pd_data(p_answer jsonb) returns jsonb language sql as $$
	select page from jsonb_array_elements(p_answer -> 'pages') as page where page ->> 'page' = 'data'
$$;
create function pg_temp.pd_error(p_answer jsonb, p_state text) returns void language plpgsql as $$
begin
	if p_answer ->> 'error' is distinct from p_state then
		raise exception 'Expected SQLSTATE %, got %', p_state, p_answer using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.pd_layout(p_key text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.member-app-layout/v1',
		'places', jsonb_build_object(p_key, jsonb_build_object('group', null, 'after', 'page:bank', 'at', 1)),
		'groups', '{}'::jsonb,
		'colours', jsonb_build_object(p_key, 'teal'),
		'emblems', jsonb_build_object(p_key, 'box'))
$$;

do $$
declare n integer; v jsonb;
begin
	foreach n in array array[1, 2, 3, 4, 5] loop
		v := pg_temp.pd_list(n);
		if jsonb_path_query_array(v, '$.pages[*].page') is distinct from '["mailbox","members","bank","data"]'::jsonb then
			raise exception 'Member %''s pages, in their order: %', n, v; end if;
		if pg_temp.pd_data(v) is distinct from '{"page":"data","on":true,"hidden":false}'::jsonb then
			raise exception 'Data is on for member % from the start: %', n, v; end if;
	end loop;
	if exists (select 1 from public.qorpera_interface_pages) then raise exception 'Reading wrote a switch'; end if;
end $$;

do $$
declare v_page text; v jsonb;
begin
	perform pg_temp.pd_error(pg_temp.pd_set(2, 'data', false), '42501');
	perform pg_temp.pd_error(pg_temp.pd_set(3, 'data', false), '42501');
	perform pg_temp.pd_error(pg_temp.pd_set(99, 'data', false), '42501');
	foreach v_page in array array['Data', 'data ', 'datas', 'database', 'tables'] loop
		perform pg_temp.pd_error(pg_temp.pd_set(1, v_page, false), '22023');
		perform pg_temp.pd_error(pg_temp.pd_hide(3, v_page, true), '22023');
	end loop;
	if pg_temp.pd_data(pg_temp.pd_set(5, 'data', false)) is distinct from '{"page":"data","on":false,"hidden":false}'::jsonb
		or pg_temp.pd_data(pg_temp.pd_list(3)) ->> 'on' is distinct from 'false' then
		raise exception 'The admin switches Data off for the company'; end if;
	v := pg_temp.pd_set(1, 'data', true);
	if pg_temp.pd_data(v) ->> 'on' is distinct from 'true'
		or (select changed_by_user_id from public.qorpera_interface_pages where page = 'data') is distinct from pg_temp.pd_user(1) then
		raise exception 'The owner switches Data on again: %', v; end if;
end $$;

do $$
begin
	if pg_temp.pd_data(pg_temp.pd_hide(3, 'data', true)) is distinct from '{"page":"data","on":true,"hidden":true}'::jsonb
		or pg_temp.pd_data(pg_temp.pd_hide(3, 'data', true)) ->> 'hidden' is distinct from 'true' then
		raise exception 'The viewer hides Data, twice'; end if;
	if pg_temp.pd_data(pg_temp.pd_list(1)) ->> 'hidden' is distinct from 'false'
		or pg_temp.pd_data(pg_temp.pd_list(2)) ->> 'hidden' is distinct from 'false' then
		raise exception 'Another member sees the viewer''s hidden Data'; end if;
	perform pg_temp.pd_error(pg_temp.pd_hide(99, 'data', true), '42501');
	if pg_temp.pd_data(pg_temp.pd_hide(3, 'data', false)) ->> 'hidden' is distinct from 'false' then
		raise exception 'The viewer shows Data again'; end if;
	if exists (select 1 from public.qorpera_member_hidden_interface_pages where page = 'data') then
		raise exception 'Shown again, the row stays'; end if;
end $$;

do $$
begin
	insert into public.qorpera_member_hidden_interface_pages (environment_id, user_id, page)
	values ('63400000-0000-4000-8000-000000000020', pg_temp.pd_user(2), 'data');
	begin
		insert into public.qorpera_member_hidden_interface_pages (environment_id, user_id, page)
		values ('63400000-0000-4000-8000-000000000020', pg_temp.pd_user(2), 'pulse');
		raise exception 'A hidden page that is no page' using errcode = 'QTF02';
	exception when check_violation then null;
	end;
	begin
		insert into public.qorpera_interface_pages (environment_id, page, enabled, changed_by_user_id)
		values ('63400000-0000-4000-8000-000000000020', 'pulse', true, pg_temp.pd_user(1));
		raise exception 'A switch for a page that is no page' using errcode = 'QTF02';
	exception when check_violation then null;
	end;
end $$;

do $$
declare v_key text;
begin
	if not public.qorpera_member_app_layout_valid(pg_temp.pd_layout('page:data')) then
		raise exception 'A member places, colours and picks an icon for Data in their own drawer'; end if;
	foreach v_key in array array['page:mailbox', 'page:bank', 'app:data', 'sites'] loop
		if not public.qorpera_member_app_layout_valid(pg_temp.pd_layout(v_key)) then
			raise exception 'The drawer key % as before', v_key; end if;
	end loop;
	foreach v_key in array array['page:pulse', 'page:Data', 'page:datas', 'data'] loop
		if public.qorpera_member_app_layout_valid(pg_temp.pd_layout(v_key)) then
			raise exception 'No drawer key: %', v_key; end if;
	end loop;
end $$;
