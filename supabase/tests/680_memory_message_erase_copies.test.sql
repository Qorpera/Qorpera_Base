-- @fixture 965_memory_tree_prune_copies.test.sql until "-- 3. A message erase"
-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10; 20260930470000): the copies in a member's
-- answer, on 965's Nora, a version of whose block a copy and a conflict copy hold. A request and a status read name no
-- copy before step 3 and both after it, each by its environment and path once, live when any block found it live; a
-- duplicate erase of the message names the first erase's copies; the steps answer as before. Rolled back.

create function pg_temp.status(p_id uuid) returns jsonb language sql as $$
	select public.qorpera_memory_message_erase_status('70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001',
		p_id)
$$;
create function pg_temp.request() returns jsonb language sql as $$
	select public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001',
		pg_temp.thread('70000000-0000-4000-8000-0000000000a1'),
		(pg_temp.event(pg_temp.thread('70000000-0000-4000-8000-0000000000a1'), 7)).event_id)
$$;
create function pg_temp.copy(p_environment text, p_path text, p_live boolean) returns jsonb language sql as $$
	select jsonb_build_object('environmentId', '70000000-0000-4000-8000-0000000000' || p_environment, 'path', p_path, 'live', p_live)
$$;

-- 1. No copy before step 3; then both, in the status and in a request that joins the erase; the steps name none -

do $$
declare
	eid uuid; r jsonb; a jsonb;
	want constant jsonb := '[{"environmentId":"70000000-0000-4000-8000-000000000020","path":"reports/r2.md","live":true},'
		'{"environmentId":"70000000-0000-4000-8000-000000000020","path":"reports/w1.jsonl","live":true}]';
begin
	perform pg_temp.service();
	a := pg_temp.request();
	eid := (a ->> 'eraseId')::uuid;
	perform pg_temp.same(a -> 'copies', '[]', 'A request names no copy before step 3');
	perform pg_temp.same(pg_temp.status(eid), a, 'Its status');
	r := public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid);
	perform pg_temp.same(r, pg_temp.status(eid) - 'copies', 'Step 1 answers as before');
	r := pg_temp.rewrite(eid);
	perform pg_temp.same(r, pg_temp.status(eid) - 'copies', 'Step 2 answers as before');
	r := pg_temp.ask_all(eid) - 'waits';
	perform pg_temp.same(r, pg_temp.status(eid) - 'copies', 'Step 3 answers as before');
	perform pg_temp.same(r -> 'state', '"requested"', 'Step 3');
	perform pg_temp.same(pg_temp.status(eid), r || jsonb_build_object('copies', want), 'The status names both copies');
	perform pg_temp.same(pg_temp.request(), r || jsonb_build_object('copies', want), 'A request joins the erase and names them');
	-- A step called again answers where the erase stands, as before.
	perform pg_temp.same(public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid), r, 'Step 1 again');
	perform pg_temp.same(public.qorpera_memory_message_erase_ask('70000000-0000-4000-8000-000000000020', eid), r, 'Step 3 again');
end $$;

-- 2. Each copy once by environment and path, in byte order, live when any block found it live; a block not asked names
-- none; a duplicate erase of the message, written once this one is done, names this one's copies ------------------------

do $$
declare
	eid uuid := (pg_temp.request() ->> 'eraseId')::uuid; dup uuid; k text[];
	both_blocks jsonb := jsonb_build_array(pg_temp.copy('20', 'Zeta/notes.md', false), pg_temp.copy('20', 'reports/r2.md', true),
		pg_temp.copy('20', 'reports/w1.jsonl', true), pg_temp.copy('21', 'reports/r2.md', false));
begin
	k := (select array_agg(b.block_key order by b.block_key) from public.qorpera_memory_message_erase_blocks b where b.erase_id = eid);
	if cardinality(k) < 2 then raise exception 'The erase has two blocks: %', k; end if;
	update public.qorpera_memory_message_erase_blocks set copies = null where erase_id = eid and block_key <> all(k[1:2]);
	-- The first block found reports/r2.md gone, the second found it live; the second found the same path in another
	-- environment of the company, gone.
	update public.qorpera_memory_message_erase_blocks set copies = jsonb_build_array(pg_temp.copy('20', 'reports/w1.jsonl', true),
		pg_temp.copy('20', 'reports/r2.md', false))
	where erase_id = eid and block_key = k[1];
	update public.qorpera_memory_message_erase_blocks set copies = jsonb_build_array(pg_temp.copy('21', 'reports/r2.md', false),
		pg_temp.copy('20', 'reports/r2.md', true), pg_temp.copy('20', 'Zeta/notes.md', false))
	where erase_id = eid and block_key = k[2];
	perform pg_temp.same(pg_temp.status(eid) -> 'copies', both_blocks, 'Both blocks'' copies');
	-- A request that read the message before this erase's step 1 writes its row once this one is done; that erase ends
	-- done at its step 1 with no block. Its status, and a later request, which answers it, name this erase's copies.
	update public.qorpera_memory_message_erases set state = 'done', done_at = clock_timestamp() where id = eid;
	insert into public.qorpera_memory_message_erases(environment_id, profile_id, session_id, event_id, sequence, message_index,
		requested_by_user_id, state, done_at)
	select environment_id, profile_id, session_id, event_id, sequence, message_index, requested_by_user_id, 'done',
		clock_timestamp()
	from public.qorpera_memory_message_erases where id = eid
	returning id into dup;
	perform pg_temp.same(pg_temp.status(dup) -> 'copies', both_blocks, 'The duplicate''s status');
	perform pg_temp.same(pg_temp.request() - 'copies', pg_temp.status(dup) - 'copies', 'A later request answers the duplicate');
	perform pg_temp.same(pg_temp.request() -> 'copies', both_blocks, 'A later request names the first erase''s copies');
	-- The second not asked yet: the first block's copies alone.
	update public.qorpera_memory_message_erase_blocks set copies = null where erase_id = eid and block_key = k[2];
	perform pg_temp.same(pg_temp.status(dup) -> 'copies',
		jsonb_build_array(pg_temp.copy('20', 'reports/r2.md', false), pg_temp.copy('20', 'reports/w1.jsonl', true)),
		'The first block''s copies');
	update public.qorpera_memory_message_erase_blocks set copies = null where erase_id = eid;
	perform pg_temp.same(pg_temp.status(eid) -> 'copies', '[]', 'No block asked, no copy');
end $$;

-- 3. Callers: the answer is the request's and the status's own; the patched bodies carry the marker -------------------

do $$
declare
	v_answer constant regprocedure := 'public.qorpera_memory_message_erase_answer(uuid)'::regprocedure;
	v_member constant regprocedure[] := array['public.qorpera_memory_message_erase_request(uuid,uuid,uuid,uuid)',
		'public.qorpera_memory_message_erase_status(uuid,uuid,uuid)']::regprocedure[];
begin
	if exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) r
		where has_function_privilege(r, v_answer, 'execute')) then raise exception 'No one calls the answer itself'; end if;
	if (select p.prosecdef or p.provolatile <> 's' from pg_proc p where p.oid = v_answer) then
		raise exception 'The answer is stable and runs as its caller'; end if;
	if exists (select 1 from unnest(v_member) f where not has_function_privilege('service_role', f, 'execute')
			or has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')
			or pg_get_functiondef(f) not like '%20260930470000 (M3 copies)%qorpera_memory_message_erase_answer(%') then
		raise exception 'The request and the status: their callers and the marker'; end if;
end $$;

rollback;
