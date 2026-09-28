-- @fixture 630_folder_core_foundation.test.sql until "-- The flag: snapshot-v1 by default"
-- Company folder core, C1f (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §6, §11): the feed follows the
-- journal in seq order with the paths each change set touched, filtered by read authority; a reader that
-- continues from `next` never skips or repeats a change; the clock is service_role's to poll, never published.

select public.qorpera_folder_enable('63000000-0000-4000-8000-000000000020');

create function pg_temp.feed(p_actor jsonb, p_after bigint, p_limit integer, p_cursor jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_folder_feed('63000000-0000-4000-8000-000000000020', p_actor, p_after, p_limit, p_cursor)
$$;
create function pg_temp.platform() returns jsonb language sql as $$ select '{"kind":"platform"}'::jsonb $$;

-- Follows the feed from p_after to the clock, p_limit per page. Returns every change (and authority row)
-- as 'seq:op:path' in delivery order, and checks each page's shape on the way.
create function pg_temp.follow(p_actor jsonb, p_after bigint, p_limit integer) returns text[] language plpgsql as $$
declare v_page jsonb; v_after bigint := p_after; v_cursor jsonb; v_out text[] := '{}'; v_event jsonb; v_change jsonb;
	v_pages integer := 0; v_last bigint;
begin
	loop
		v_page := pg_temp.feed(p_actor, v_after, p_limit, v_cursor);
		v_pages := v_pages + 1;
		if v_page ->> 'schema' <> 'qorpera.folder-feed/v1' or (v_page ->> 'resync')::boolean then
			raise exception 'Feed page is invalid: %', v_page; end if;
		if (select count(*) from jsonb_array_elements(v_page -> 'events') e, jsonb_array_elements(coalesce(e.value -> 'changes',
			'[]')) c) + (select count(*) from jsonb_array_elements(v_page -> 'events') e where e.value ->> 'kind' = 'authority') > p_limit then
			raise exception 'A page held more than its limit: %', v_page; end if;
		for v_event in select value from jsonb_array_elements(v_page -> 'events') loop
			if (v_event ->> 'seq')::bigint <= v_after or (v_event ->> 'seq')::bigint > (v_page ->> 'asOfSeq')::bigint then
				raise exception 'An event lies outside the page: %', v_page; end if;
			if v_event ->> 'kind' = 'authority' then
				v_out := v_out || ((v_event ->> 'seq') || ':authority:');
			else
				for v_change in select value from jsonb_array_elements(v_event -> 'changes') loop
					v_out := v_out || ((v_event ->> 'seq') || ':' || (v_change ->> 'op') || ':' || (v_change ->> 'path'));
				end loop;
			end if;
		end loop;
		v_last := (v_page ->> 'asOfSeq')::bigint;
		exit when not (v_page ->> 'more')::boolean;
		v_after := (v_page -> 'next' ->> 'afterSeq')::bigint;
		v_cursor := v_page -> 'next' -> 'cursor';
		if v_pages > 10000 then raise exception 'The feed does not advance'; end if;
	end loop;
	if (v_page -> 'next' ->> 'afterSeq')::bigint <> v_last or v_page -> 'next' -> 'cursor' <> 'null'::jsonb then
		raise exception 'A caught-up page must point at asOfSeq: %', v_page; end if;
	return v_out;
end $$;

-- Invalid calls, and an empty folder.
do $$
declare v jsonb;
begin
	v := pg_temp.feed(pg_temp.platform(), 0, 10);
	if v ->> 'asOfSeq' <> '0' or v -> 'events' <> '[]'::jsonb or (v ->> 'more')::boolean or (v ->> 'resync')::boolean
		or v -> 'next' <> '{"afterSeq":0,"cursor":null}'::jsonb then
		raise exception 'An empty folder must give an empty, caught-up page: %', v; end if;
	begin perform pg_temp.feed(pg_temp.platform(), 0, 0); raise exception 'A zero limit was accepted';
	exception when invalid_parameter_value then null; end;
	begin perform pg_temp.feed(pg_temp.platform(), 0, 1001); raise exception 'A limit over 1000 was accepted';
	exception when invalid_parameter_value then null; end;
	begin perform pg_temp.feed(pg_temp.platform(), -1, 10); raise exception 'A negative position was accepted';
	exception when invalid_parameter_value then null; end;
	begin perform pg_temp.feed(pg_temp.platform(), 0, 10, '{"unitNo":0,"version":"63000000-0000-4000-8000-000000000001"}');
		raise exception 'A malformed cursor was accepted';
	exception when invalid_parameter_value then null; end;
	begin perform pg_temp.feed('{"kind":"staff_agent","staffAgentId":"63000000-0000-4000-8000-000000000001"}', 0, 10);
		raise exception 'A staff_agent actor was accepted (only member, run and platform read the feed)';
	exception when invalid_parameter_value then null; end;
	begin perform pg_temp.feed('{"kind":"member","userId":"63000000-0000-4000-8000-0000000000ff"}', 0, 10);
		raise exception 'A non-member read the feed';
	exception when insufficient_privilege then null; end;
	begin perform public.qorpera_folder_feed('63000000-0000-4000-8000-000000000021', pg_temp.platform(), 0, 10);
		raise exception 'A snapshot-v1 company has a feed';
	exception when insufficient_privilege then null; end;
	perform pg_temp.claims('authenticated');
	begin perform pg_temp.feed(pg_temp.platform(), 0, 10); raise exception 'A client read the feed';
	exception when insufficient_privilege then null; end;
	perform pg_temp.claims('service_role');
end $$;

-- A history: seq 1 folders; seq 2 a member's file; seq 3 a new folder with 25 files (26 changes);
-- seq 4 a private folder of member 2 with a file; seq 5 a move of docs to papers (move_out and move_in for
-- both paths); seq 6 a file moved out of the private folder; seq 7 an authority row; seq 8 a delete.
do $$
declare v jsonb; v_docs uuid; v_file uuid; v_big jsonb := '[]'; v_secret uuid; v_papers uuid;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'feed-key-1', '[{"op":"mkdir","path":"docs"},{"op":"mkdir","path":"notes"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'feed-key-2', jsonb_build_array(jsonb_build_object('op','write',
		'path','docs/a.txt','file',pg_temp.stage('alpha')))), 1, 'saved');
	for i in 1..25 loop
		v_big := v_big || jsonb_build_array(jsonb_build_object('path','f' || lpad(i::text, 2, '0') || '.txt','kind','file',
			'file',pg_temp.stage('big ' || i)));
	end loop;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'feed-key-3', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','big','contents',v_big))), 1, 'saved');
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values ('63000000-0000-4000-8000-000000000020','locked','subtree','member_private','63000000-0000-4000-8000-000000000002',
		'normal','63000000-0000-4000-8000-000000000001');
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'feed-key-4', jsonb_build_array(jsonb_build_object('op','mkdir','path','locked'),
		jsonb_build_object('op','write','path','locked/secret.txt','file',pg_temp.stage('secret')))), 2, 'saved');
	v_docs := (pg_temp.read('docs') -> 'entry' ->> 'version')::uuid;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'feed-key-5', jsonb_build_array(jsonb_build_object('op','move',
		'from','docs','to','papers','expectedVersion',v_docs,'asOfSeq',pg_temp.seq()))), 1, 'saved');
	v_secret := (pg_temp.read('locked/secret.txt') -> 'entry' ->> 'version')::uuid;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'feed-key-6', jsonb_build_array(jsonb_build_object('op','move',
		'from','locked/secret.txt','to','notes/secret.txt','expectedVersion',v_secret))), 1, 'saved');
	-- C1b writes authority rows. Here one goes in by hand, in one transaction: the journal row, then the clock.
	insert into public.qorpera_folder_journal(environment_id, seq, kind)
	select environment_id, last_seq + 1, 'authority' from public.qorpera_folder_clocks
	where environment_id = '63000000-0000-4000-8000-000000000020';
	update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = '63000000-0000-4000-8000-000000000020';
	v_file := (pg_temp.read('papers/a.txt') -> 'entry' ->> 'version')::uuid;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'feed-key-8', jsonb_build_array(jsonb_build_object('op','delete',
		'path','papers/a.txt','expectedVersion',v_file))), 1, 'saved');
	if pg_temp.seq() <> 8 then raise exception 'Expected 8 seqs, got %', pg_temp.seq(); end if;
end $$;

-- The platform sees everything, seq by seq (within a unit the order is only stable, not meaningful: a unit
-- is one atomic path set), and every page size delivers the same list in the same order.
do $$
declare v_all text[]; v_page text[]; v_expected text[];
begin
	v_all := pg_temp.follow(pg_temp.platform(), 0, 1000);
	v_expected := array['1:mkdir:docs','1:mkdir:notes','2:write:docs/a.txt','3:mkdir:big']
		|| array(select '3:write:big/f' || lpad(i::text, 2, '0') || '.txt' from generate_series(1, 25) i)
		|| array['4:mkdir:locked','4:write:locked/secret.txt','5:move_out:docs','5:move_out:docs/a.txt','5:move_in:papers',
			'5:move_in:papers/a.txt','6:move_out:locked/secret.txt','6:move_in:notes/secret.txt','7:authority:',
			'8:delete:papers/a.txt'];
	if array(select x from unnest(v_all) x order by x) <> array(select x from unnest(v_expected) x order by x) then
		raise exception 'The platform feed is wrong: %', v_all; end if;
	if exists (select 1 from unnest(v_all) with ordinality a(x, n) join unnest(v_all) with ordinality b(y, m) on m = n + 1
		where split_part(y, ':', 1)::bigint < split_part(x, ':', 1)::bigint) then
		raise exception 'The feed went back in seq: %', v_all; end if;
	-- Units keep their order inside a change set.
	if array_position(v_all, '1:mkdir:docs') > array_position(v_all, '1:mkdir:notes')
		or array_position(v_all, '4:mkdir:locked') > array_position(v_all, '4:write:locked/secret.txt') then
		raise exception 'Units are out of order: %', v_all; end if;
	for n in 1..27 loop
		v_page := pg_temp.follow(pg_temp.platform(), 0, n);
		if v_page <> v_all then raise exception 'Pages of % give a different feed: %', n, v_page; end if;
	end loop;
end $$;

-- A page that fills up inside a change set stops there: next.afterSeq stays below the seq, so the change set
-- is not yet whole, and the next page resumes after the cursor and completes it.
do $$
declare v jsonb; w jsonb;
begin
	v := pg_temp.feed(pg_temp.platform(), 2, 10);
	if jsonb_array_length(v -> 'events') <> 1 or v -> 'events' -> 0 ->> 'seq' <> '3'
		or jsonb_array_length(v -> 'events' -> 0 -> 'changes') <> 10 or v -> 'next' ->> 'afterSeq' <> '2'
		or v -> 'next' -> 'cursor' ->> 'unitNo' <> '1' or not (v ->> 'more')::boolean then
		raise exception 'A page inside a change set is wrong: %', v; end if;
	w := pg_temp.feed(pg_temp.platform(), 2, 16, v -> 'next' -> 'cursor');
	if jsonb_array_length(w -> 'events' -> 0 -> 'changes') <> 16
		or w -> 'events' -> 0 ->> 'seq' <> '3' or w -> 'next' <> '{"afterSeq":3,"cursor":null}'::jsonb then
		raise exception 'The rest of the change set is wrong: %', w; end if;
	if exists (select 1 from jsonb_array_elements(v -> 'events' -> 0 -> 'changes') a,
		jsonb_array_elements(w -> 'events' -> 0 -> 'changes') b where a.value ->> 'version' = b.value ->> 'version') then
		raise exception 'A change was delivered twice'; end if;
	-- Changes carry what a mount needs to refresh without another read.
	if exists (select 1 from jsonb_array_elements((v -> 'events' -> 0 -> 'changes') || (w -> 'events' -> 0 -> 'changes')) c
			where c.value ->> 'kind' = 'file' and not (c.value ->> 'manifestSha256' ~ '^[0-9a-f]{64}$' and c.value ? 'bytes'
				and c.value ? 'mediaType' and c.value ? 'executable' and c.value ? 'updatedAt' and c.value ? 'version'))
		or (select count(*) from jsonb_array_elements((v -> 'events' -> 0 -> 'changes') || (w -> 'events' -> 0 -> 'changes')) c
			where c.value ->> 'kind' = 'file') <> 25 then
		raise exception 'File changes lack their attributes: %', w; end if;
	-- A current version's time is its entry's, exactly as read and list report it.
	if exists (select 1 from jsonb_array_elements(w -> 'events' -> 0 -> 'changes') c
		where c.value ->> 'kind' = 'file'
			and (c.value ->> 'updatedAt')::timestamptz <> (pg_temp.read(c.value ->> 'path') -> 'entry' ->> 'updatedAt')::timestamptz) then
		raise exception 'The feed''s file times differ from reads: %', w; end if;
end $$;

-- A version that is no longer current carries no time: the reader asks for the entry instead.
do $$
declare v jsonb;
begin
	v := pg_temp.feed(pg_temp.platform(), 1, 1);
	if v -> 'events' -> 0 -> 'changes' -> 0 ->> 'path' <> 'docs/a.txt' or v -> 'events' -> 0 -> 'changes' -> 0 ? 'updatedAt' then
		raise exception 'A superseded version carries a time: %', v; end if;
end $$;

-- A member sees only what it may read. The owner of the private folder sees it; another member sees the
-- move out of it only as a new file, never the private names, and the private change set not at all.
do $$
declare v_owner text[]; v_other text[]; v jsonb;
begin
	v_owner := pg_temp.follow(pg_temp.member(2), 0, 1000);
	v_other := pg_temp.follow(pg_temp.member(3), 0, 1000);
	if not v_owner @> array['4:mkdir:locked','4:write:locked/secret.txt','6:move_out:locked/secret.txt','6:move_in:notes/secret.txt'] then
		raise exception 'The private folder''s owner misses its changes: %', v_owner; end if;
	if exists (select 1 from unnest(v_other) x where x like '%locked%') or not v_other @> array['6:move_in:notes/secret.txt'] then
		raise exception 'Another member saw private names: %', v_other; end if;
	if cardinality(v_other) <> cardinality(v_owner) - 3 then
		raise exception 'Another member''s feed has the wrong size: % vs %', v_other, v_owner; end if;
	for n in 1..5 loop
		if pg_temp.follow(pg_temp.member(3), 0, n) <> v_other then
			raise exception 'A member''s feed depends on the page size (%)', n; end if;
	end loop;
	-- The private change set is left out, and the position still moves past it.
	v := pg_temp.feed(pg_temp.member(3), 3, 2);
	if exists (select 1 from jsonb_array_elements(v -> 'events') e where e.value ->> 'seq' = '4')
		or (v -> 'next' ->> 'afterSeq')::bigint < 4 then
		raise exception 'A member''s page stalls on a change set it may not read: %', v; end if;
	if not v_other @> array['7:authority:'] then raise exception 'Members miss authority rows: %', v_other; end if;
	-- A move out of a private folder shows the source's version only to a member who may read the source.
	v := pg_temp.feed(pg_temp.member(3), 5, 10);
	if not exists (select 1 from jsonb_array_elements(v -> 'events') e, jsonb_array_elements(e.value -> 'changes') c
			where c.value ->> 'op' = 'move_in' and c.value ->> 'path' = 'notes/secret.txt')
		or exists (select 1 from jsonb_array_elements(v -> 'events') e, jsonb_array_elements(e.value -> 'changes') c
			where c.value ->> 'path' = 'notes/secret.txt' and c.value ? 'priorVersion') then
		raise exception 'A member sees a private source''s version: %', v; end if;
	v := pg_temp.feed(pg_temp.member(2), 5, 10);
	if not exists (select 1 from jsonb_array_elements(v -> 'events') e, jsonb_array_elements(e.value -> 'changes') c
		where c.value ->> 'op' = 'move_in' and c.value ->> 'path' = 'notes/secret.txt' and c.value ? 'priorVersion') then
		raise exception 'The source''s owner misses the prior version: %', v; end if;
end $$;

-- resync only for a position the feed cannot continue.
do $$
declare v jsonb; v_any uuid;
begin
	v := pg_temp.feed(pg_temp.platform(), 9, 10);
	if not (v ->> 'resync')::boolean or v ->> 'asOfSeq' <> '8' then raise exception 'A position past the clock: %', v; end if;
	v := pg_temp.feed(pg_temp.platform(), 2, 10, '{"unitNo":1,"version":"63000000-0000-4000-8000-000000000001"}');
	if not (v ->> 'resync')::boolean then raise exception 'A cursor naming no change: %', v; end if;
	v := pg_temp.feed(pg_temp.platform(), 6, 10, '{"unitNo":1,"version":"63000000-0000-4000-8000-000000000001"}');
	if not (v ->> 'resync')::boolean then raise exception 'A cursor inside an authority row: %', v; end if;
	select version into v_any from public.qorpera_folder_path_versions
	where commit_id = (select commit_id from public.qorpera_folder_journal where seq = 3
		and environment_id = '63000000-0000-4000-8000-000000000020') order by unit_no, version limit 1;
	v := pg_temp.feed(pg_temp.platform(), 1, 10, jsonb_build_object('unitNo',1,'version',v_any));
	if not (v ->> 'resync')::boolean then raise exception 'A cursor from another seq: %', v; end if;
	v := pg_temp.feed(pg_temp.platform(), 8, 10);
	if (v ->> 'resync')::boolean or v -> 'events' <> '[]'::jsonb or (v ->> 'more')::boolean then
		raise exception 'A caught-up reader: %', v; end if;
end $$;

-- A reader that stopped at asOfSeq picks up the next commit, and only it.
do $$
declare v jsonb; v_seen bigint;
begin
	v := pg_temp.feed(pg_temp.platform(), 0, 1000);
	v_seen := (v ->> 'asOfSeq')::bigint;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'feed-key-9', '[{"op":"mkdir","path":"later"}]'), 1, 'saved');
	v := pg_temp.feed(pg_temp.platform(), (v -> 'next' ->> 'afterSeq')::bigint, 1000);
	if jsonb_array_length(v -> 'events') <> 1 or (v -> 'events' -> 0 ->> 'seq')::bigint <> v_seen + 1
		or v -> 'events' -> 0 -> 'changes' -> 0 ->> 'path' <> 'later' then
		raise exception 'A follower missed or repeated a commit: %', v; end if;
	perform pg_temp.folder_invariants('63000000-0000-4000-8000-000000000020');
end $$;

-- The position reaches asOfSeq when the journal runs out below the limit, even past a clock tick that has
-- no journal row (a commit never makes one; this guards the loop, not the commit).
do $$
declare v jsonb; v_last bigint := pg_temp.seq();
begin
	update public.qorpera_folder_clocks set last_seq = last_seq + 1 where environment_id = '63000000-0000-4000-8000-000000000020';
	v := pg_temp.feed(pg_temp.platform(), v_last, 10);
	if (v ->> 'more')::boolean or (v -> 'next' ->> 'afterSeq')::bigint <> v_last + 1 then
		raise exception 'The feed stalls below its clock: %', v; end if;
	raise exception 'undo' using errcode = 'QTF09';
exception when sqlstate 'QTF09' then null;
end $$;

-- The clock: service_role reads it to poll; no client role can, and it is not published to Realtime (whose
-- apply_rls would send every subscriber that may not select it an "unauthorized" event per commit).
do $$
begin
	if not has_table_privilege('service_role', 'public.qorpera_folder_clocks', 'select')
		or has_table_privilege('authenticated', 'public.qorpera_folder_clocks', 'select')
		or has_table_privilege('anon', 'public.qorpera_folder_clocks', 'select')
		or has_table_privilege('service_role', 'public.qorpera_folder_clocks', 'update') then
		raise exception 'Clock privileges are wrong'; end if;
	if exists (select 1 from pg_catalog.pg_publication_tables where tablename = 'qorpera_folder_clocks') then
		raise exception 'The clock must not be published'; end if;
	if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.qorpera_folder_clocks'::regclass)
		or exists (select 1 from pg_catalog.pg_policy where polrelid = 'public.qorpera_folder_clocks'::regclass) then
		raise exception 'The clock must keep row-level security with no policy'; end if;
	-- STABLE: every statement the feed runs itself shares the calling query's snapshot.
	if (select provolatile from pg_catalog.pg_proc
		where oid = 'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)'::regprocedure) <> 's' then
		raise exception 'The feed must be STABLE'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)', 'execute') then
		raise exception 'Feed privileges are wrong'; end if;
	-- The feed pages a change set by index, not by sorting it.
	if not exists (select 1 from pg_catalog.pg_indexes where schemaname = 'public'
		and indexname = 'qorpera_folder_path_versions_commit'
		and indexdef like '%(commit_id, unit_no, version)%') then
		raise exception 'The commit order index is missing'; end if;
end $$;

rollback;
