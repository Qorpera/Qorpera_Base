-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.mw_may(p_user uuid, p_path text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_result := public.qorpera_member_folder_may_write('92400000-0000-4000-8000-000000000020', p_path);
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.mw_write(p_user uuid, p_path text) returns boolean language sql as $$
	select (pg_temp.mw_may(p_user, p_path) ->> 'write')::boolean
$$;
create function pg_temp.mw_refused(p_user uuid, p_path text, p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.mw_may(p_user, p_path);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected % for %, got % (%)', p_code, p_path, sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_path;
end $$;

do $$
declare v jsonb;
begin
	if has_function_privilege('anon', 'public.qorpera_member_folder_may_write(uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_member_folder_may_write(uuid,text)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_member_folder_may_write(uuid,text)', 'execute') then
		raise exception 'the grants'; end if;

	v := pg_temp.mw_may('92400000-0000-4000-8000-000000000001', 'data/shop/');
	if v is distinct from '{"schema":"qorpera.member-folder-may-write/v1","path":"data/shop/","write":true}'::jsonb then
		raise exception 'the owner''s answer: %', v; end if;
	if not pg_temp.mw_write('92400000-0000-4000-8000-000000000004', 'data/shop')
		or not pg_temp.mw_write('92400000-0000-4000-8000-000000000002', 'data/shop/tables/001-a.sql') then
		raise exception 'an admin and a contributor write the shared work'; end if;
	if pg_temp.mw_write('92400000-0000-4000-8000-000000000003', 'data/shop') then
		raise exception 'a viewer reads and does not write'; end if;

	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
		created_by_user_id)
	values ('92400000-0000-4000-8000-000000000020', 'data/mine', 'subtree', 'member_private',
		'92400000-0000-4000-8000-000000000002', 'normal', '92400000-0000-4000-8000-000000000002');
	if not pg_temp.mw_write('92400000-0000-4000-8000-000000000002', 'data/mine/')
		or pg_temp.mw_write('92400000-0000-4000-8000-000000000004', 'data/mine/') then
		raise exception 'a private folder is written by its owner alone'; end if;

	if pg_temp.mw_write('92400000-0000-4000-8000-000000000001', 'trail/x') then
		raise exception 'a name the folder never holds is no write'; end if;
	perform pg_temp.mw_refused('92400000-0000-4000-8000-000000000005', 'data/shop', '42501');
	foreach v in array array[to_jsonb(''::text), to_jsonb('/data'::text), to_jsonb('data//shop'::text),
			to_jsonb('data/../x'::text), to_jsonb('data/./x'::text), to_jsonb(E'data\\shop'::text),
			to_jsonb(repeat('a', 4097)), to_jsonb('data/a:b'::text), to_jsonb('data/x.'::text), to_jsonb('data/'::text || repeat('é', 2100))] loop
		perform pg_temp.mw_refused('92400000-0000-4000-8000-000000000001', v #>> '{}', '22023');
	end loop;
	perform pg_temp.mw_refused('92400000-0000-4000-8000-000000000001', null, '22023');

	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.mw_refused('92400000-0000-4000-8000-000000000001', 'data/shop', '55000');
end $$;

rollback;
