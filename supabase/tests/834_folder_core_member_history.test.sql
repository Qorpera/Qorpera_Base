-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."
-- Company folder core, C4 slice P27a (20260930013000; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §2
-- "History"): a member's history and changes. A path's versions come newest first with who and when, and a move names
-- the other path only when the member may read it; the change sets come newest first with the paths in them the member
-- may read; the feed carries each change set's attribution. Nothing the member may not read shows.
--
-- The fixture (636): seq 1 platform mkdir docs, notes; seq 2 member 1 writes docs/a.txt; seq 3 platform new folder big
-- with 25 files; seq 4 platform mkdir locked (member 2's private folder) and locked/secret.txt; seq 5 platform moves
-- docs to papers; seq 6 platform moves locked/secret.txt to notes/secret.txt; seq 7 an authority row; seq 8 member 1
-- deletes papers/a.txt.

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
create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A path's history as 'seq:op[ from <path>][ to <path>]', newest first.
create function pg_temp.path_history(p_path text, p_before uuid default null, p_limit integer default 100)
returns jsonb language sql as $$
	select public.qorpera_member_folder_path_history('63000000-0000-4000-8000-000000000020', p_path, p_before, p_limit)
$$;
create function pg_temp.steps(p_history jsonb) returns text language sql as $$
	select coalesce(string_agg(concat(i.value ->> 'seq', ':', i.value ->> 'op', ' from ' || (i.value ->> 'from'),
		' to ' || (i.value ->> 'to')), ',' order by i.position), '')
	from jsonb_array_elements(p_history -> 'items') with ordinality as i(value, position)
$$;
create function pg_temp.history(p_before bigint default null, p_limit integer default 50) returns jsonb language sql as $$
	select public.qorpera_member_folder_history('63000000-0000-4000-8000-000000000020', p_before, p_limit)
$$;
create function pg_temp.seqs(p_history jsonb) returns text language sql as $$
	select coalesce(string_agg(i.value ->> 'seq', ',' order by i.position), '')
	from jsonb_array_elements(p_history -> 'items') with ordinality as i(value, position)
$$;

-- A path's versions, newest first, with who changed it; a move's other path only for a member who may read it.
select pg_temp.as_member(1);
do $$
declare v jsonb;
begin
	v := pg_temp.path_history('papers/a.txt');
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-path-history/v1', 'the schema');
	perform pg_temp.same(v ->> 'asOfSeq', '8', 'asOfSeq');
	perform pg_temp.same(pg_temp.steps(v), '8:delete,5:move_in from docs/a.txt', 'a moved, then deleted file');
	perform pg_temp.same(v -> 'items' -> 0 -> 'by', '{"kind":"member","userId":"63000000-0000-4000-8000-000000000001"}',
		'the member who deleted it');
	perform pg_temp.same(v -> 'items' -> 1 -> 'by', '{"kind":"platform"}', 'the platform moved it');
	perform pg_temp.same(((v -> 'items' -> 0 ->> 'at')::timestamptz = (select created_at from public.qorpera_folder_commits
		where environment_id = '63000000-0000-4000-8000-000000000020' and seq = 8))::text, 'true', 'when');
	perform pg_temp.same(pg_temp.steps(pg_temp.path_history('docs/a.txt')), '5:move_out to papers/a.txt,2:write',
		'the source of a move');
	perform pg_temp.same(pg_temp.path_history('docs/a.txt') -> 'items' -> 1 ->> 'fileSha256',
		(select file_sha256 from public.qorpera_folder_path_versions where environment_id = '63000000-0000-4000-8000-000000000020'
			and path = 'docs/a.txt' and op = 'write'), 'what the content was');
	perform pg_temp.same(pg_temp.steps(pg_temp.path_history('nowhere.txt')), '', 'a path with no history');
	perform pg_temp.same(pg_temp.path_history('nowhere.txt') ->> 'next', null, 'no next page');
end $$;
select pg_temp.as_member(3);
do $$ begin
	perform pg_temp.same(pg_temp.steps(pg_temp.path_history('notes/secret.txt')), '6:move_in',
		'a move out of a private folder, for another member');
	perform pg_temp.same(pg_temp.steps(pg_temp.path_history('locked/secret.txt')), '',
		'another member''s private file has no history for them');
end $$;
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(pg_temp.steps(pg_temp.path_history('notes/secret.txt')), '6:move_in from locked/secret.txt',
		'the private folder''s owner sees where it came from');
	perform pg_temp.same(pg_temp.steps(pg_temp.path_history('locked/secret.txt')), '6:move_out to notes/secret.txt,4:write',
		'and its private history');
end $$;

-- Pages: newest first, `next` is the last version of a full page, and an older page continues from it.
select pg_temp.claims('service_role');
do $$
declare v_version uuid;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'member-history-1', jsonb_build_array(jsonb_build_object(
		'op', 'write', 'path', 'notes/log.txt', 'file', pg_temp.stage('log 1')))), 1, 'saved');
	for i in 2..3 loop
		v_version := (pg_temp.read('notes/log.txt') -> 'entry' ->> 'version')::uuid;
		perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'member-history-' || i, jsonb_build_array(
			jsonb_build_object('op', 'write', 'path', 'notes/log.txt', 'file', pg_temp.stage('log ' || i),
				'expectedVersion', v_version))), 1, 'saved');
	end loop;
end $$;
select pg_temp.as_member(3);
do $$
declare v jsonb; v_more jsonb;
begin
	v := pg_temp.path_history('notes/log.txt', null, 2);
	perform pg_temp.same(pg_temp.steps(v), '11:write,10:write', 'the newest page');
	perform pg_temp.same(v ->> 'next', v -> 'items' -> 1 ->> 'version', 'next names the page''s last version');
	v_more := pg_temp.path_history('notes/log.txt', (v ->> 'next')::uuid, 2);
	perform pg_temp.same(pg_temp.steps(v_more), '9:write', 'the older page');
	perform pg_temp.same(v_more ->> 'next', null, 'the last page');
	perform pg_temp.same(pg_temp.state_of(format('select pg_temp.path_history(%L, %L)', 'notes/log.txt',
		(select version from public.qorpera_folder_path_versions where environment_id = '63000000-0000-4000-8000-000000000020'
			and path = 'big/f01.txt'))), '22023 History request is invalid', 'a version of another path');
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.path_history('notes/log.txt', null, 101)$s$),
		'22023 History request is invalid', 'a limit over 100');
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.path_history(null)$s$), '22023 History request is invalid',
		'no path');
end $$;

-- The change sets, newest first, each with the paths in it the member may read; none for a change set with no
-- readable path; never an authority row.
do $$
declare v jsonb; v_big jsonb;
begin
	v := pg_temp.history();
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-history/v1', 'the schema');
	perform pg_temp.same(pg_temp.seqs(v), '11,10,9,8,6,5,3,2,1', 'another member''s change sets');
	perform pg_temp.same(v ->> 'next', null, 'all of them');
	perform pg_temp.same((select string_agg(p.value ->> 'op' || ':' || (p.value ->> 'path'), ',' order by p.position)
		from jsonb_array_elements(v -> 'items' -> 4 -> 'paths') with ordinality as p(value, position)),
		'move_in:notes/secret.txt', 'only the readable side of a move out of a private folder');
	v_big := (select i.value from jsonb_array_elements(v -> 'items') as i(value) where i.value ->> 'seq' = '3');
	perform pg_temp.same(jsonb_array_length(v_big -> 'paths')::text, '20', 'at most 20 paths');
	perform pg_temp.same(v_big ->> 'more', 'true', 'and more');
	perform pg_temp.same(v -> 'items' -> 0 ->> 'more', 'false', 'a change set shown whole');
	perform pg_temp.same(v -> 'items' -> 3 -> 'by', '{"kind":"member","userId":"63000000-0000-4000-8000-000000000001"}',
		'who made it');
	-- Pages: p_limit change sets examined, readable or not; next is the oldest examined.
	v := pg_temp.history(null, 4);
	perform pg_temp.same(pg_temp.seqs(v) || ' next ' || (v ->> 'next'), '11,10,9,8 next 8', 'the first page');
	v := pg_temp.history(8, 2);
	perform pg_temp.same(pg_temp.seqs(v) || ' next ' || (v ->> 'next'), '6,5 next 5', 'the second page');
	v := pg_temp.history(5, 2);
	perform pg_temp.same(pg_temp.seqs(v) || ' next ' || (v ->> 'next'), '3 next 3',
		'a page whose private change set is left out');
	v := pg_temp.history(2, 2);
	perform pg_temp.same(pg_temp.seqs(v) || ' next ' || coalesce(v ->> 'next', 'none'), '1 next none', 'the last page');
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.history(null, 51)$s$), '22023 History request is invalid',
		'a limit over 50');
	perform pg_temp.same(pg_temp.state_of($s$select pg_temp.history(0, 5)$s$), '22023 History request is invalid',
		'a position below 1');
end $$;
select pg_temp.as_member(2);
do $$ begin
	perform pg_temp.same(pg_temp.seqs(pg_temp.history()), '11,10,9,8,6,5,4,3,2,1', 'the private folder''s owner');
end $$;

-- A change set larger than one call examines: its first 200 versions are examined, and `more` says there are others.
select pg_temp.claims('service_role');
do $$
declare v_contents jsonb := '[]';
begin
	for i in 1..205 loop
		v_contents := v_contents || jsonb_build_array(jsonb_build_object('path', 'w' || lpad(i::text, 3, '0') || '.txt',
			'kind', 'file', 'file', pg_temp.stage('wide ' || i)));
	end loop;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'member-history-wide', jsonb_build_array(jsonb_build_object(
		'op', 'new_folder', 'path', 'wide', 'contents', v_contents))), 1, 'saved');
end $$;
select pg_temp.as_member(3);
do $$
declare v jsonb := pg_temp.history(null, 1);
begin
	perform pg_temp.same(pg_temp.seqs(v), '12', 'the wide change set');
	perform pg_temp.same(jsonb_array_length(v -> 'items' -> 0 -> 'paths')::text || ' ' || (v -> 'items' -> 0 ->> 'more'),
		'20 true', 'twenty paths and more');
end $$;

-- The feed for a member: the core's events, each change set with who made it and when; authority rows as they are.
do $$
declare v jsonb; v_event jsonb;
begin
	v := public.qorpera_member_folder_changes('63000000-0000-4000-8000-000000000020', 0, 1000);
	perform pg_temp.same(v ->> 'schema', 'qorpera.folder-feed/v1', 'the schema');
	perform pg_temp.same((select string_agg(e.value ->> 'seq', ',' order by e.position)
		from jsonb_array_elements(v -> 'events') with ordinality as e(value, position)), '1,2,3,5,6,7,8,9,10,11,12',
		'another member''s events');
	for v_event in select e.value from jsonb_array_elements(v -> 'events') as e(value) loop
		if v_event ->> 'kind' = 'change_set' and (v_event -> 'by' is null or v_event -> 'at' is null) then
			raise exception 'A change set without attribution: %', v_event; end if;
		if v_event ->> 'kind' = 'authority' and (v_event ? 'by' or v_event ? 'at') then
			raise exception 'An authority row with attribution: %', v_event; end if;
	end loop;
	v_event := (select e.value from jsonb_array_elements(v -> 'events') as e(value) where e.value ->> 'seq' = '2');
	perform pg_temp.same(v_event -> 'by', '{"kind":"member","userId":"63000000-0000-4000-8000-000000000001"}',
		'who wrote seq 2');
	perform pg_temp.same(((v_event ->> 'at')::timestamptz = (select created_at from public.qorpera_folder_commits
		where environment_id = '63000000-0000-4000-8000-000000000020' and seq = 2))::text, 'true', 'when');
	-- Positions are the core's: a member continues from `next` as the core's readers do.
	v := public.qorpera_member_folder_changes('63000000-0000-4000-8000-000000000020', 2, 3);
	perform pg_temp.same(v -> 'next' ->> 'afterSeq', '2', 'a page that stops inside seq 3');
	perform pg_temp.same(public.qorpera_member_folder_changes('63000000-0000-4000-8000-000000000020', 2, 3, v -> 'next' -> 'cursor')
		-> 'events' -> 0 ->> 'seq', '3', 'continues inside it');
	perform pg_temp.same(pg_temp.state_of($s$select public.qorpera_member_folder_changes(
		'63000000-0000-4000-8000-000000000020', -1, 10)$s$), '22023 Feed position is invalid', 'an invalid position');
end $$;

-- An agent's commit names the agent, never the member who asked it.
select pg_temp.claims('service_role');
do $$ begin
	perform pg_temp.same(public.qorpera_folder_commit_by(jsonb_populate_record(null::public.qorpera_folder_commits,
		'{"actor_kind":"staff_agent","actor_id":"63000000-0000-4000-8000-0000000000a1","requester_kind":"member",
		"requester_id":"63000000-0000-4000-8000-000000000002"}')), '{"kind":"agent","staffAgentId":"63000000-0000-4000-8000-0000000000a1"}',
		'an agent''s commit');
end $$;

-- The shapes a member client parses with closed key sets (P27b): each answer's keys on the real functions.
create function pg_temp.shape(p jsonb, p_keys text, p_what text) returns void language plpgsql as $$
begin
	if jsonb_typeof(p) is distinct from 'object'
		or array(select k collate "C" from jsonb_object_keys(p) k order by 1)
			is distinct from array(select k collate "C" from unnest(string_to_array(p_keys, ',')) k order by 1) then
		raise exception 'The client reads % as {%}; SQL returned %', p_what, p_keys, p;
	end if;
end $$;
select pg_temp.as_member(2);
do $$
declare v jsonb; v_item jsonb;
begin
	v := pg_temp.path_history('notes/log.txt');
	perform pg_temp.shape(v, 'asOfSeq,items,next,schema', 'a path history page');
	perform pg_temp.shape(v -> 'items' -> 0,
		'at,by,bytes,executable,fileSha256,kind,manifestSha256,mediaType,op,path,seq,version', 'a file version');
	perform pg_temp.shape(pg_temp.path_history('notes/secret.txt') -> 'items' -> 0,
		'at,by,bytes,executable,fileSha256,from,kind,manifestSha256,mediaType,op,path,seq,version', 'a move in');
	perform pg_temp.shape(pg_temp.path_history('locked/secret.txt') -> 'items' -> 0,
		'at,by,bytes,executable,fileSha256,kind,manifestSha256,mediaType,op,path,seq,to,version', 'a move out');
	perform pg_temp.shape(pg_temp.path_history('papers/a.txt') -> 'items' -> 0, 'at,by,kind,op,path,seq,version',
		'a delete');
	perform pg_temp.shape(pg_temp.path_history('notes') -> 'items' -> 0, 'at,by,kind,op,path,seq,version', 'a mkdir');
	v := pg_temp.history(null, 3);
	perform pg_temp.shape(v, 'asOfSeq,items,next,schema', 'a history page');
	perform pg_temp.shape(v -> 'items' -> 0, 'at,by,more,paths,seq', 'a change set');
	perform pg_temp.shape(v -> 'items' -> 0 -> 'paths' -> 0, 'kind,op,path,version', 'a change set''s path');
	perform pg_temp.shape(v -> 'items' -> 0 -> 'by', 'kind', 'the platform');
	perform pg_temp.shape(pg_temp.history(11, 1) -> 'items' -> 0 -> 'by', 'kind,userId', 'a member');
	v := public.qorpera_member_folder_changes('63000000-0000-4000-8000-000000000020', 6, 2);
	perform pg_temp.shape(v, 'asOfSeq,events,more,next,resync,schema', 'a feed page');
	perform pg_temp.shape(v -> 'next', 'afterSeq,cursor', 'a feed position');
	for v_item in select e.value from jsonb_array_elements(v -> 'events') e loop
		if v_item ->> 'kind' = 'authority' then perform pg_temp.shape(v_item, 'kind,seq', 'an authority event');
		else perform pg_temp.shape(v_item, 'at,by,changes,commitId,kind,seq', 'a change set event'); end if;
	end loop;
	perform pg_temp.same((select count(*) from jsonb_array_elements(v -> 'events') e where e.value ->> 'kind' = 'authority')::text,
		'1', 'the page holds the authority row');
end $$;
select pg_temp.claims('service_role');
