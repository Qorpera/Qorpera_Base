-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."

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
create function pg_temp.search(p_query text, p_limit integer default 50) returns jsonb language sql as $$
	select public.qorpera_member_folder_search('63000000-0000-4000-8000-000000000020', p_query, p_limit)
$$;
create function pg_temp.paths(p_answer jsonb) returns text language sql as $$
	select coalesce(string_agg(entry ->> 'path', ',' order by position), '')
	from jsonb_array_elements(p_answer -> 'entries') with ordinality as item(entry, position)
$$;
create function pg_temp.listed(p_member integer, p_query text) returns text language plpgsql as $$
declare v_entries jsonb;
begin
	perform pg_temp.claims('service_role');
	v_entries := public.qorpera_folder_list('63000000-0000-4000-8000-000000000020', pg_temp.member(p_member), null, null,
		1000, true) -> 'entries';
	perform pg_temp.as_member(p_member);
	return coalesce((select string_agg(entry ->> 'path', ',' order by entry ->> 'path')
		from jsonb_array_elements(v_entries) as entry
		where not exists (select 1 from regexp_split_to_table(lower(btrim(p_query)), '\s+') as word
			where strpos(lower(entry ->> 'path'), word) = 0)), '');
end $$;

insert into auth.users(id, email) values ('63000000-0000-4000-8000-000000000005', 'search-stranger@example.test');
do $$ begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'search-1', jsonb_build_array(jsonb_build_object(
		'op', 'write', 'path', 'locked/diary.txt', 'file', pg_temp.stage('dear diary')))), 1, 'saved');
end $$;

do $$ begin
	if not has_function_privilege('authenticated', 'public.qorpera_member_folder_search(uuid,text,integer)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_member_folder_search(uuid,text,integer)', 'EXECUTE') then
		raise exception 'qorpera_member_folder_search has the wrong grants'; end if;
end $$;

select pg_temp.as_member(3);
do $$
declare v jsonb;
begin
	v := pg_temp.search('SECRET');
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-search/v1', 'the schema');
	perform pg_temp.same(pg_temp.paths(v), 'notes/secret.txt', 'a name in any case');
	perform pg_temp.same(v ->> 'more', 'false', 'all found');
	perform pg_temp.same(pg_temp.paths(pg_temp.search('diary')), '', 'another member''s private file');
	perform pg_temp.same(pg_temp.paths(pg_temp.search('locked')), '', 'another member''s private folder');
	perform pg_temp.same(pg_temp.paths(pg_temp.search('big f0')), 'big/f01.txt,big/f02.txt,big/f03.txt,big/f04.txt,'
		|| 'big/f05.txt,big/f06.txt,big/f07.txt,big/f08.txt,big/f09.txt', 'every word, across the path');
	v := pg_temp.search('big', 3);
	perform pg_temp.same(pg_temp.paths(v), 'big,big/f01.txt,big/f02.txt', 'the folder named first, then the shortest');
	perform pg_temp.same(v ->> 'more', 'true', 'more than the limit');
	perform pg_temp.same((v -> 'entries' -> 1)::text,
		(public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', 'big/f01.txt') -> 'entry')::text,
		'an entry as the read gives it');
end $$;

select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(pg_temp.paths(pg_temp.search('locked')), 'locked,locked/diary.txt', 'the private folder''s owner');
	perform pg_temp.same(pg_temp.paths(pg_temp.search('diary')), 'locked/diary.txt', 'the owner''s own file');
end $$;

do $$
declare v_member integer; v_query text; v_found text;
begin
	foreach v_member in array array[2, 3] loop
		foreach v_query in array array['t', 'f1', '.txt', 'o', 'secret', 'locked', 'notes secret'] loop
			perform pg_temp.as_member(v_member);
			v_found := (select coalesce(string_agg(entry ->> 'path', ',' order by entry ->> 'path'), '')
				from jsonb_array_elements(pg_temp.search(v_query) -> 'entries') as entry);
			perform pg_temp.same(v_found, pg_temp.listed(v_member, v_query),
				format('member %s searching %L finds what the listing shows', v_member, v_query));
		end loop;
	end loop;
end $$;

select pg_temp.as_member(3);
do $$
declare v_call text;
begin
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.search(repeat('a', 200))$s$), 'ok', '200 characters');
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.search('a b c d e f g h')$s$), 'ok', 'eight words');
	foreach v_call in array array[
		$s$select pg_temp.search(null)$s$,
		$s$select pg_temp.search('   ')$s$,
		$s$select pg_temp.search(repeat('a', 201))$s$,
		$s$select pg_temp.search('a b c d e f g h i')$s$,
		$s$select pg_temp.search('notes', 0)$s$,
		$s$select pg_temp.search('notes', 51)$s$,
		$s$select pg_temp.search('notes', null)$s$] loop
		perform pg_temp.same(pg_temp.state_of(v_call), '22023 Search is invalid', v_call);
	end loop;
end $$;

select pg_temp.as_member(5);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.search('notes')$s$), '42501 Company folder is unavailable',
		'a non-member');
end $$;
select pg_temp.claims('anon');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.search('notes')$s$), '42501 Company folder is unavailable',
		'anon');
end $$;
select pg_temp.as_member(1);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_search(
		'63000000-0000-4000-8000-000000000021', 'notes', 10)$s$), '42501 Company folder is unavailable',
		'a snapshot-v1 company');
end $$;
select pg_temp.claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('63000000-0000-4000-8000-000000000010', '63000000-0000-4000-8000-000000000001');
select pg_temp.as_member(3);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.search('notes')$s$), '55000 Company is being deleted',
		'a company being deleted');
end $$;
select pg_temp.claims('service_role');
