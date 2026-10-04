-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."
-- Company folder core, C4 slice P27a (20260930013000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §2):
-- members read their company's folder through authenticated functions. A member reads, lists and fetches the bytes of
-- what they may read, and nothing else looks present; a non-member, a snapshot-v1 company and a company being deleted
-- serve nothing. The core's read, list, feed and byte check take an authenticated member's own actor, and no other
-- actor from an authenticated caller; they stay closed to authenticated.
--
-- The fixture (636): member 2 owns the private folder `locked`; members 1–4 belong to the company; seq 8 is the last.

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
create function pg_temp.names(p_list jsonb) returns text language sql as $$
	select coalesce(string_agg(e.value ->> 'path', ',' order by e.value ->> 'path'), '')
	from jsonb_array_elements(p_list -> 'entries') e
$$;

-- A file in member 2's private folder, and a non-member.
insert into auth.users(id, email) values ('63000000-0000-4000-8000-000000000005', 'folder-stranger@example.test');
do $$ begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'member-reads-1', jsonb_build_array(jsonb_build_object(
		'op', 'write', 'path', 'locked/diary.txt', 'file', pg_temp.stage('dear diary')))), 1, 'saved');
end $$;

-- Who may call what: the member functions are authenticated's; the core stays closed to authenticated; the helpers are
-- nobody's.
do $$
declare v_function text;
begin
	foreach v_function in array array['qorpera_member_folder_read(uuid,text)',
		'qorpera_member_folder_list(uuid,text,text,integer)', 'qorpera_member_folder_changes(uuid,bigint,integer,jsonb)',
		'qorpera_member_folder_object(uuid,text)', 'qorpera_member_folder_path_history(uuid,text,uuid,integer)',
		'qorpera_member_folder_history(uuid,bigint,integer)'] loop
		if not has_function_privilege('authenticated', 'public.' || v_function, 'EXECUTE')
			or has_function_privilege('anon', 'public.' || v_function, 'EXECUTE') then
			raise exception '% has the wrong grants', v_function; end if;
	end loop;
	foreach v_function in array array['qorpera_folder_read(uuid,jsonb,text)',
		'qorpera_folder_list(uuid,jsonb,text,text,integer,boolean)', 'qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)',
		'qorpera_folder_authorize_object_download(uuid,jsonb,text)'] loop
		if has_function_privilege('authenticated', 'public.' || v_function, 'EXECUTE')
			or has_function_privilege('anon', 'public.' || v_function, 'EXECUTE')
			or not has_function_privilege('service_role', 'public.' || v_function, 'EXECUTE') then
			raise exception '% has the wrong grants', v_function; end if;
		if strpos(pg_get_functiondef(('public.' || v_function)::regprocedure), 'C4 P27a (20260930013000)') = 0 then
			raise exception '% has no body marker', v_function; end if;
	end loop;
	foreach v_function in array array['qorpera_folder_caller_allowed(jsonb)', 'qorpera_member_folder_actor(uuid)',
		'qorpera_folder_commit_by(public.qorpera_folder_commits)'] loop
		if has_function_privilege('authenticated', 'public.' || v_function, 'EXECUTE')
			or has_function_privilege('anon', 'public.' || v_function, 'EXECUTE')
			or has_function_privilege('service_role', 'public.' || v_function, 'EXECUTE') then
			raise exception '% is exposed', v_function; end if;
		if strpos(pg_get_functiondef(('public.' || v_function)::regprocedure), 'C4 P27a (20260930013000)') = 0 then
			raise exception '% has no body marker', v_function; end if;
	end loop;
end $$;

-- The core's caller check, as an authenticated member reaches it (this test runs as the database owner, so EXECUTE is
-- not what stops the call): only the member's own actor passes.
select pg_temp.as_member(3);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_folder_read('63000000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63000000-0000-4000-8000-000000000003"}', 'notes')$s$), 'ok', 'a member''s own actor');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_folder_read('63000000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63000000-0000-4000-8000-000000000002"}', 'locked/diary.txt')$s$),
		'42501 Folder core authority is required', 'another member''s actor');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_folder_list('63000000-0000-4000-8000-000000000020',
		'{"kind":"platform"}', '', null, 10)$s$), '42501 Folder core authority is required', 'the platform''s actor');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_folder_feed('63000000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63000000-0000-4000-8000-000000000003","x":1}', 0, 10)$s$),
		'42501 Folder core authority is required', 'an actor with more keys');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_folder_authorize_object_download(
		'63000000-0000-4000-8000-000000000020', '{"kind":"platform"}', repeat('a', 64))$s$),
		'42501 Folder core authority is required', 'the byte check with the platform''s actor');
end $$;
select pg_temp.claims('anon');
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_folder_read('63000000-0000-4000-8000-000000000020',
		'{"kind":"member","userId":"63000000-0000-4000-8000-000000000003"}', 'notes')$s$),
		'42501 Folder core authority is required', 'anon with a member''s actor');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read(
		'63000000-0000-4000-8000-000000000020', 'notes')$s$), '42501 Company folder is unavailable', 'anon');
end $$;

-- Read: a member sees what they may read, and the rest looks absent.
select pg_temp.as_member(3);
do $$
declare v jsonb;
begin
	v := public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', 'notes/secret.txt');
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-read/v1', 'the read''s schema');
	perform pg_temp.same(v ->> 'found', 'true', 'a readable file');
	perform pg_temp.same(v ->> 'asOfSeq', '9', 'asOfSeq');
	perform pg_temp.same((v -> 'entry' ? 'authority')::text, 'false', 'no receipt for a member');
	perform pg_temp.same(public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', 'locked/diary.txt')
		->> 'found', 'false', 'another member''s private file');
	perform pg_temp.same(public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', 'locked') ->> 'found',
		'false', 'another member''s private folder');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read(
		'63000000-0000-4000-8000-000000000020', '../x')$s$), '22023 Path is invalid', 'an invalid path');
end $$;
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', 'locked/diary.txt')
		->> 'found', 'true', 'the private folder''s owner');
end $$;

-- List: one folder, in folder-key order, a page at a time; the private folder only for its owner.
select pg_temp.as_member(3);
do $$
declare v jsonb;
begin
	v := public.qorpera_member_folder_list('63000000-0000-4000-8000-000000000020', null, null, 100);
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-list/v1', 'the list''s schema');
	perform pg_temp.same(pg_temp.names(v), 'big,notes,papers', 'the root for another member');
	v := public.qorpera_member_folder_list('63000000-0000-4000-8000-000000000020', 'big', null, 10);
	perform pg_temp.same(jsonb_array_length(v -> 'entries')::text, '10', 'a page');
	perform pg_temp.same(v ->> 'next', 'big/f10.txt', 'the next page starts after');
	v := public.qorpera_member_folder_list('63000000-0000-4000-8000-000000000020', 'big', v ->> 'next', 100);
	perform pg_temp.same(jsonb_array_length(v -> 'entries')::text, '15', 'the rest');
	perform pg_temp.same(coalesce(v ->> 'next', 'none'), 'none', 'the last page');
	perform pg_temp.same(pg_temp.names(public.qorpera_member_folder_list('63000000-0000-4000-8000-000000000020', 'locked',
		null, 100)), '', 'another member''s private folder lists nothing');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_list(
		'63000000-0000-4000-8000-000000000020', null, null, 1001)$s$), '22023 Listing is invalid', 'a limit over 1000');
end $$;
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(pg_temp.names(public.qorpera_member_folder_list('63000000-0000-4000-8000-000000000020', null,
		null, 100)), 'big,locked,notes,papers', 'the root for the private folder''s owner');
end $$;

-- Bytes: the byte check answers for an object of a file the member may read, and refuses the private file's.
select pg_temp.claims('service_role');
select set_config('qorpera_test.diary', pg_temp.read('locked/diary.txt') -> 'entry' ->> 'manifestSha256', true),
	set_config('qorpera_test.secret', pg_temp.read('notes/secret.txt') -> 'entry' ->> 'manifestSha256', true);
select pg_temp.as_member(3);
do $$
declare v jsonb;
begin
	v := public.qorpera_member_folder_object('63000000-0000-4000-8000-000000000020', current_setting('qorpera_test.secret'));
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-object-download/v1', 'a readable file''s manifest');
	perform pg_temp.same(v ->> 'profileId', '63000000-0000-4000-8000-000000000010', 'its company');
	perform pg_temp.same(pg_temp.state_of(format('select public.qorpera_member_folder_object(%L, %L)',
		'63000000-0000-4000-8000-000000000020', current_setting('qorpera_test.diary'))), '42501 Object is unavailable',
		'another member''s private file''s manifest');
	perform pg_temp.same(pg_temp.state_of(format('select public.qorpera_member_folder_object(%L, %L)',
		'63000000-0000-4000-8000-000000000020', 'nothex')), '22023 Object hash is invalid', 'an invalid hash');
end $$;
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(public.qorpera_member_folder_object('63000000-0000-4000-8000-000000000020',
		current_setting('qorpera_test.diary')) ->> 'profileId', '63000000-0000-4000-8000-000000000010',
		'the owner fetches the private file');
end $$;

-- No folder: a non-member, a snapshot-v1 company, and a company being deleted.
select pg_temp.as_member(5);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_list(
		'63000000-0000-4000-8000-000000000020', null, null, 10)$s$), '42501 Company folder is unavailable', 'a non-member');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_changes(
		'63000000-0000-4000-8000-000000000020', 0, 10)$s$), '42501 Company folder is unavailable',
		'a non-member''s changes');
end $$;
select pg_temp.as_member(1);
do $$ begin
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_read(
		'63000000-0000-4000-8000-000000000021', 'notes')$s$), '42501 Company folder is unavailable', 'a snapshot-v1 company');
end $$;
savepoint member_reads_deleting;
select pg_temp.claims('service_role');
insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
values ('63000000-0000-4000-8000-000000000010', '63000000-0000-4000-8000-000000000001');
select pg_temp.as_member(3);
do $$
declare v_call text;
begin
	foreach v_call in array array[
		$s$select public.qorpera_member_folder_read('63000000-0000-4000-8000-000000000020', 'notes')$s$,
		$s$select public.qorpera_member_folder_list('63000000-0000-4000-8000-000000000020', null, null, 10)$s$,
		$s$select public.qorpera_member_folder_changes('63000000-0000-4000-8000-000000000020', 0, 10)$s$,
		$s$select public.qorpera_member_folder_path_history('63000000-0000-4000-8000-000000000020', 'notes', null, 10)$s$,
		$s$select public.qorpera_member_folder_history('63000000-0000-4000-8000-000000000020', null, 10)$s$,
		format('select public.qorpera_member_folder_object(%L, %L)', '63000000-0000-4000-8000-000000000020',
			current_setting('qorpera_test.secret'))] loop
		perform pg_temp.same(pg_temp.state_of(v_call), '55000 Company is being deleted', v_call);
	end loop;
end $$;
rollback to savepoint member_reads_deleting;
select pg_temp.claims('service_role');
