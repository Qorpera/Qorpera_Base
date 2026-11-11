-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."
-- A member reads several paths of their company's folder in one call (20260930722000): each answer is what the path's
-- own qorpera_member_folder_read answers, in the order asked; a path the member may not read looks absent; the call
-- refuses what the single read refuses, and more than 64 paths, none or a null one.
--
-- The fixture (636): member 2 owns the private folder `locked`; members 1–4 belong to the company.

create function pg_temp.as_member(p_n integer) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '63000000-0000-4000-8000-00000000000' || p_n)::text, true)::text::void
$$;
create function pg_temp.state_of(p_statement text) returns text language plpgsql as $$
begin
	execute p_statement;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;

insert into auth.users(id, email) values ('63000000-0000-4000-8000-000000000005', 'read-many-stranger@example.test');
do $$ begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'read-many-1', jsonb_build_array(jsonb_build_object(
		'op', 'write', 'path', 'locked/diary.txt', 'file', pg_temp.stage('dear diary')))), 1, 'saved');
end $$;

-- Who may call it: authenticated, never anon.
do $$ begin
	if not has_function_privilege('authenticated', 'public.qorpera_member_folder_read_many(uuid,text[])', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_member_folder_read_many(uuid,text[])', 'EXECUTE') then
		raise exception 'qorpera_member_folder_read_many has the wrong grants'; end if;
end $$;

-- Each answer is the single read's, in the order asked; another member's private file looks absent.
select pg_temp.as_member(3);
do $$
declare v jsonb; v_paths text[] := array['notes/secret.txt', 'locked/diary.txt', 'nothing/here.txt', 'notes',
	'notes/secret.txt'];
begin
	v := public.qorpera_member_folder_read_many('63000000-0000-4000-8000-000000000020', v_paths);
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-read-many/v1', 'the schema');
	perform pg_temp.same(jsonb_array_length(v -> 'reads')::text, '5', 'one answer a path');
	for i in 1 .. 5 loop
		perform pg_temp.same((v -> 'reads' -> (i - 1))::text,
			public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', v_paths[i])::text,
			'the single read of ' || v_paths[i]);
	end loop;
	perform pg_temp.same(v -> 'reads' -> 0 ->> 'found', 'true', 'a readable file');
	perform pg_temp.same(v -> 'reads' -> 1 ->> 'found', 'false', 'another member''s private file');
	perform pg_temp.same(v -> 'reads' -> 3 -> 'entry' ->> 'kind', 'folder', 'a folder');
end $$;
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(public.qorpera_member_folder_read_many('63000000-0000-4000-8000-000000000020',
		array['locked/diary.txt']) -> 'reads' -> 0 ->> 'found', 'true', 'the private folder''s owner');
end $$;

-- What it refuses.
select pg_temp.as_member(3);
do $$
declare v_call text;
begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read_many(
		'63000000-0000-4000-8000-000000000020', array(select 'notes/f' || n from generate_series(1, 64) as n))$s$),
		'ok', '64 paths');
	foreach v_call in array array[
		$s$select public.qorpera_member_folder_read_many('63000000-0000-4000-8000-000000000020',
			array(select 'notes/f' || n from generate_series(1, 65) as n))$s$,
		$s$select public.qorpera_member_folder_read_many('63000000-0000-4000-8000-000000000020', '{}'::text[])$s$,
		$s$select public.qorpera_member_folder_read_many('63000000-0000-4000-8000-000000000020', null)$s$,
		$s$select public.qorpera_member_folder_read_many('63000000-0000-4000-8000-000000000020',
			array['notes', null])$s$] loop
		perform pg_temp.same(pg_temp.state_of(v_call), '22023 Read request is invalid', v_call);
	end loop;
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read_many(
		'63000000-0000-4000-8000-000000000020', array['notes', '../x'])$s$), '22023 Path is invalid', 'an invalid path');
end $$;

-- No folder: a non-member, anon, a snapshot-v1 company, a company being deleted.
select pg_temp.as_member(5);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read_many(
		'63000000-0000-4000-8000-000000000020', array['notes'])$s$), '42501 Company folder is unavailable', 'a non-member');
end $$;
select pg_temp.claims('anon');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read_many(
		'63000000-0000-4000-8000-000000000020', array['notes'])$s$), '42501 Company folder is unavailable', 'anon');
end $$;
select pg_temp.as_member(1);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read_many(
		'63000000-0000-4000-8000-000000000021', array['notes'])$s$), '42501 Company folder is unavailable',
		'a snapshot-v1 company');
end $$;
select pg_temp.claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('63000000-0000-4000-8000-000000000010', '63000000-0000-4000-8000-000000000001');
select pg_temp.as_member(3);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read_many(
		'63000000-0000-4000-8000-000000000020', array['notes'])$s$), '55000 Company is being deleted',
		'a company being deleted');
end $$;
select pg_temp.claims('service_role');
