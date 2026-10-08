-- @fixture 840_folder_state_worker_files.test.sql until "-- 3. A write worker's report"
-- Context tree W4a-1 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §12, §14 W4): a worker starts from its parent's
-- views by reference. manage_worker's dispatch and follow-up name the parent's step and views; the index keeps them per
-- worker sequence; the worker's own run reads them back (qorpera_folder_worker_parent); and
-- qorpera_memory_view_reference_check answers whether the reference still stands. 840's fixture leaves Ada's run with
-- an open todo, plan-the-trip, that has no folder yet. Ada's conversation gets a summary tree here by hand: its row and
-- two block versions in one platform commit. The same commit saves a group chat's block for §1.

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
-- A reference to Ada's conversation (or another) at this folder clock and generation.
create function pg_temp.w4_view(p_as_of bigint, p_generation bigint, p_blocks jsonb, p_session uuid default null) returns jsonb
language sql as $$
	select jsonb_build_object('asOfSeq', p_as_of, 'conversations', jsonb_build_array(jsonb_build_object(
		'sessionId', coalesce(p_session, current_setting('qorpera_test.w4_session')::uuid), 'generation', p_generation, 'through', 12,
		'blocks', p_blocks)))
$$;
-- Ada's block 1 (t0) or 2 (t1), at the version the fixture saved.
create function pg_temp.w4_block(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('path', format('agents/ada/memory/thread/t%s/00000000.jsonl', p_n - 1),
		'version', current_setting('qorpera_test.w4_v' || p_n))
$$;
create function pg_temp.w4_check(p_view jsonb) returns text language sql as $$
	select public.qorpera_memory_view_reference_check('63400000-0000-4000-8000-000000000020', p_view)
$$;
create function pg_temp.w4_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then
		raise exception '%: expected %, got %', p_what, p_want, p_got using errcode = 'QTF01'; end if;
end $$;
-- An open folder erasure (or a done one) with these roots, accepted now.
create function pg_temp.w4_erasure(p_roots jsonb, p_state text default 'working') returns uuid language sql as $$
	insert into public.qorpera_folder_erasures(environment_id, profile_id, operation_key, request_sha256, requested_by_user_id,
		as_of_seq, as_of_at, roots, state, reply, done_at)
	values ('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
		'w4-erase-' || left(extensions.gen_random_uuid()::text, 8), repeat('e', 64), '63400000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.w4_seq')::bigint, clock_timestamp(), p_roots, p_state, '{}',
		case when p_state = 'done' then clock_timestamp() end)
	returning id
$$;
-- An erasure root whose cutoff is the fixture's commit at this unit: the versions before that unit are erased.
create function pg_temp.w4_root(p_key text, p_unit integer) returns jsonb language sql as $$
	select jsonb_build_object('key', p_key, 'cutoffSeq', current_setting('qorpera_test.w4_seq')::bigint, 'cutoffUnit', p_unit,
		'cutoffAt', clock_timestamp())
$$;
create function pg_temp.w4_row(p_worker uuid, p_sequence integer) returns public.qorpera_runtime_worker_parents language sql as $$
	select * from public.qorpera_runtime_worker_parents where worker_id = p_worker and sequence = p_sequence
$$;
create function pg_temp.w4_parent(p_actor jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_worker_parent('63400000-0000-4000-8000-000000000020', p_actor)
$$;
-- The wake of a worker's run (840's worker_run) names the sequence it started, as the drain's payload does.
create function pg_temp.w4_wake_sequence(p_run jsonb, p_sequence integer) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_wake_occurrences set payload = %L where run_id = %L',
		jsonb_build_object('sequence', p_sequence), p_run -> 'actor' ->> 'runId'))
$$;

-- 0. Ada's conversation with a summary tree: two blocks saved by one platform commit ------------------------------------
do $$
declare
	env uuid := '63400000-0000-4000-8000-000000000020'; ada jsonb := current_setting('qorpera_test.ada')::jsonb;
	s uuid := (select session_id from public.qorpera_execution_runs where id = (ada -> 'actor' ->> 'runId')::uuid);
	n bigint := (select last_seq + 1 from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020');
	c uuid := extensions.gen_random_uuid(); v1 uuid := extensions.gen_random_uuid(); v2 uuid := extensions.gen_random_uuid();
	v3 uuid := extensions.gen_random_uuid();
begin
	if s is null then raise exception 'Ada''s run has no conversation'; end if;
	set local session_replication_role = replica;
	insert into public.qorpera_folder_commits(id, environment_id, seq, operation_key, actor_kind, units)
	values (c, env, n, 'w4-memory-0001', 'platform', '[]');
	insert into public.qorpera_folder_journal(environment_id, seq, kind, commit_id) values (env, n, 'change_set', c);
	update public.qorpera_folder_clocks set last_seq = n where environment_id = env;
	insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, op, kind, commit_id, unit_no)
	select b.version, env, b.path, extensions.digest(public.qorpera_folder_key(b.path), 'sha256'), 'write', 'file', c, b.unit
	from (values (v1, 'agents/ada/memory/thread/t0/00000000.jsonl', 1), (v2, 'agents/ada/memory/thread/t1/00000000.jsonl', 2),
		(v3, 'agents/groups/trip/memory/t0/00000000.jsonl', 3)) b(version, path, unit);
	insert into public.qorpera_memory_trees(environment_id, session_id, root_path, root_key, owner_kind, owner_id, node_bytes,
		toml_path_version, commit_id)
	values (env, s, 'agents/ada/memory/thread', 'agents/ada/memory/thread', 'agent', '84000000-0000-4000-8000-0000000000e1', 1024,
		extensions.gen_random_uuid(), c);
	set local session_replication_role = origin;
	perform set_config('qorpera_test.w4_session', s::text, false);
	perform set_config('qorpera_test.w4_seq', n::text, false);
	perform set_config('qorpera_test.w4_v1', v1::text, false);
	perform set_config('qorpera_test.w4_v2', v2::text, false);
	perform set_config('qorpera_test.w4_v3', v3::text, false);
end $$;

-- 1. The check's answers: ok, then generation_moved before block_gone before erasure_covers ------------------------------
do $$
declare
	s uuid := current_setting('qorpera_test.w4_session')::uuid; n bigint := current_setting('qorpera_test.w4_seq')::bigint;
	ben uuid := (select session_id from public.qorpera_execution_runs
		where id = (current_setting('qorpera_test.ben')::jsonb -> 'actor' ->> 'runId')::uuid);
	b1 jsonb := pg_temp.w4_block(1); b2 jsonb := pg_temp.w4_block(2);
	gone jsonb := jsonb_build_object('path', 'agents/ada/memory/thread/t0/00000000.jsonl', 'version', extensions.gen_random_uuid());
	g jsonb := jsonb_build_object('path', 'agents/groups/trip/memory/t0/00000000.jsonl', 'version', current_setting('qorpera_test.w4_v3'));
	e uuid;
begin
	if ben is null or ben = s then raise exception 'Ben''s run has its own conversation'; end if;
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1, b2))), 'ok', 'Both blocks');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, '[]')), 'ok', 'No blocks');
	perform pg_temp.w4_same(pg_temp.w4_check(jsonb_build_object('asOfSeq', n, 'conversations',
		(pg_temp.w4_view(n, 0, jsonb_build_array(b1)) -> 'conversations') || (pg_temp.w4_view(n, 0, '[]', ben) -> 'conversations'))),
		'ok', 'A branch with no tree');
	-- An erase raised Ada's generation since: the reference is stale, whatever its blocks; one above it was never read.
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set memory_generation = 1 where id = %L', s));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'generation_moved', 'An erase since');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 1, jsonb_build_array(b1))), 'ok', 'The generation now');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n, 2, jsonb_build_array(b1))), '22023');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(gone))), 'generation_moved',
		'A moved generation comes first');
	perform pg_temp.fx(format('update public.qorpera_shared_sessions set memory_generation = 0 where id = %L', s));
	-- A version no longer kept; a block of another conversation's tree; a retired tree; a tree renamed since.
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1, gone))), 'block_gone', 'A pruned version');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1), ben)), 'block_gone',
		'Ada''s block under Ben''s conversation');
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = clock_timestamp() where session_id = %L', s));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'block_gone', 'A retired tree');
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = null where session_id = %L', s));
	perform pg_temp.fx(format('update public.qorpera_memory_trees set root_path = %L, root_key = %L where session_id = %L',
		'agents/ada-2/memory/thread', 'agents/ada-2/memory/thread', s));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'block_gone', 'A renamed tree');
	perform pg_temp.fx(format('update public.qorpera_memory_trees set root_path = %L, root_key = %L where session_id = %L',
		'agents/ada/memory/thread', 'agents/ada/memory/thread', s));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1, b2))), 'ok', 'The tree back');
	-- An open erasure of the tree with its cutoff at unit 2: block 1 is erased, block 2 (the root's current life) is not.
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/ada/memory/thread', 2)));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'erasure_covers', 'An open erasure');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b2))), 'ok', 'After the cutoff');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(gone, b1))), 'block_gone',
		'A gone block comes before an erased one');
	delete from public.qorpera_folder_erasures where id = e;
	-- A root above the tree covers it; a sibling root does not; a done erasure and another company's are not counted.
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/ada', 2)));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'erasure_covers', 'The agent''s root');
	delete from public.qorpera_folder_erasures where id = e;
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/ada/todos', 2), pg_temp.w4_root('agents/ada/memory/thread/t0x', 2)));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'ok', 'Sibling roots');
	delete from public.qorpera_folder_erasures where id = e;
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/ada/memory/thread', 2)), 'done');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'ok', 'A done erasure');
	delete from public.qorpera_folder_erasures where id = e;
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/ada/memory/thread', 2)));
	perform pg_temp.fx(format('update public.qorpera_folder_erasures set environment_id = %L where id = %L',
		'63400000-0000-4000-8000-0000000000ff', e));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(b1))), 'ok', 'Another company''s erasure');
	perform pg_temp.fx(format('delete from public.qorpera_folder_erasures where id = %L', e));
	-- A group chat's tree (agents/groups/<chat>/memory, its blocks one level down) counts as an agent's does. Ben's
	-- conversation stands in for the chat: the check reads only the conversation's tree row.
	perform pg_temp.fx(format('insert into public.qorpera_memory_trees(environment_id, session_id, root_path, root_key, owner_kind,
		owner_id, node_bytes, toml_path_version, commit_id) values (%L, %L, %L, %L, %L, %L, 1024, %L, %L)',
		'63400000-0000-4000-8000-000000000020', ben, 'agents/groups/trip/memory', 'agents/groups/trip/memory', 'group',
		extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid()));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(g), ben)), 'ok', 'A group chat''s block');
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(g))), 'block_gone',
		'A group chat''s block under Ada''s conversation');
	e := pg_temp.w4_erasure(jsonb_build_array(pg_temp.w4_root('agents/groups/trip', 4)));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(g), ben)), 'erasure_covers',
		'An erasure of the group chat');
	delete from public.qorpera_folder_erasures where id = e;
	perform pg_temp.fx(format('update public.qorpera_memory_trees set retired_at = clock_timestamp() where session_id = %L', ben));
	perform pg_temp.w4_same(pg_temp.w4_check(pg_temp.w4_view(n, 0, jsonb_build_array(g), ben)), 'block_gone', 'A retired group chat');
	perform pg_temp.fx(format('delete from public.qorpera_memory_trees where session_id = %L', ben));
end $$;

-- 2. A reference no parent could have composed: its shape, then the folder -----------------------------------------------
do $$
declare
	n bigint := current_setting('qorpera_test.w4_seq')::bigint; b1 jsonb := pg_temp.w4_block(1); b2 jsonb := pg_temp.w4_block(2);
	base jsonb := pg_temp.w4_view(n, 0, jsonb_build_array(b1)); c jsonb := base -> 'conversations' -> 0; v jsonb; i integer := 0;
begin
	foreach v in array array[
		base,
		jsonb_build_object('asOfSeq', 0, 'conversations', jsonb_build_array(c || '{"generation":0,"through":0,"blocks":[]}'::jsonb)),
		-- A thousand conversations (about 200 KiB): the size is the only bound on their number.
		jsonb_build_object('asOfSeq', n, 'conversations', (select jsonb_agg(c || jsonb_build_object('sessionId', extensions.gen_random_uuid()))
			from generate_series(1, 1000))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || jsonb_build_object('path', repeat('a', 1024)))))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			(select jsonb_agg(b1 || jsonb_build_object('path', repeat('a', 1000))) from generate_series(1, 200)))))
	] loop
		i := i + 1;
		if not public.qorpera_memory_view_reference_valid(v) then
			raise exception 'Valid reference % refused: %', i, left(v::text, 300) using errcode = 'QTF01'; end if;
	end loop;
	i := 0;
	foreach v in array array[
		'[]'::jsonb, '"x"'::jsonb, 'null'::jsonb, base - 'asOfSeq', base || '{"extra":1}'::jsonb,
		base || '{"asOfSeq":"5"}'::jsonb, base || '{"asOfSeq":-1}'::jsonb, base || '{"asOfSeq":1.5}'::jsonb,
		base || '{"asOfSeq":1234567890123456789}'::jsonb, base || '{"conversations":{}}'::jsonb,
		base || '{"conversations":[]}'::jsonb,
		-- 1400 conversations: over 256 KiB.
		jsonb_build_object('asOfSeq', n, 'conversations', (select jsonb_agg(c || jsonb_build_object('sessionId', extensions.gen_random_uuid()))
			from generate_series(1, 1400))),
		jsonb_build_object('asOfSeq', n, 'conversations', '["x"]'::jsonb),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"extra":1}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c - 'through')),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"sessionId":"ABCDEF00-0000-4000-8000-000000000001"}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"sessionId":"not-a-uuid"}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"generation":-1}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"generation":null}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"through":"12"}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"blocks":{}}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || '{"blocks":["x"]}'::jsonb)),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || '{"extra":1}'::jsonb)))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 - 'version')))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || '{"path":""}'::jsonb)))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || jsonb_build_object('path', repeat('a', 1025)))))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || '{"path":7}'::jsonb)))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || '{"version":"x"}'::jsonb)))),
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			jsonb_build_array(b1 || '{"version":"ABCDEF00-0000-4000-8000-000000000002"}'::jsonb)))),
		-- One conversation named twice.
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c, c || '{"blocks":[]}'::jsonb)),
		-- Over 256 KiB.
		jsonb_build_object('asOfSeq', n, 'conversations', jsonb_build_array(c || jsonb_build_object('blocks',
			(select jsonb_agg(b1 || jsonb_build_object('path', repeat('a', 1000))) from generate_series(1, 300)))))
	] loop
		i := i + 1;
		if public.qorpera_memory_view_reference_valid(v) then
			raise exception 'Invalid reference % passed: %', i, left(v::text, 300) using errcode = 'QTF01'; end if;
	end loop;
	-- The check refuses each, and a well-formed reference the folder never held: a clock ahead of the company's, another
	-- company, a conversation that is not one, a generation above the conversation's, a block saved after asOfSeq, a
	-- version that is not a tree block, and a version under another block's path.
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', base - 'asOfSeq'), '22023');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n + 1, 0, '[]')), '22023');
	perform pg_temp.raises(format('select public.qorpera_memory_view_reference_check(%L, %L)', '63400000-0000-4000-8000-0000000000ff',
		base), '22023');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n, 0, '[]', extensions.gen_random_uuid())), '22023');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n, 1, '[]')), '22023');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n - 1, 0, jsonb_build_array(b1))), '22023');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n, 0, jsonb_build_array(jsonb_build_object(
		'path', 'agents/ada/todos/call-the-bank.md', 'version', pg_temp.f2_version('agents/ada/todos/call-the-bank.md'))))), '22023');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', pg_temp.w4_view(n, 0, jsonb_build_array(
		b1 || jsonb_build_object('path', b2 ->> 'path')))), '22023');
	-- Only the platform's service calls it.
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000002');
	perform pg_temp.raises(format('select pg_temp.w4_check(%L)', base), '42501');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.w4_same(pg_temp.w4_check(base), 'ok', 'The service role again');
end $$;

-- 3. A dispatch names its parent's step and views; the index keeps them ------------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; p jsonb := ada -> 'actor'; n bigint := current_setting('qorpera_test.w4_seq')::bigint;
	v jsonb := pg_temp.w4_view(n, 0, jsonb_build_array(pg_temp.w4_block(1), pg_temp.w4_block(2)));
	f text := 'agents/ada/todos/plan-the-trip/scout'; b jsonb := pg_temp.brief('99300000-0000-4000-8000-000000000001');
	u jsonb := pg_temp.dispatch_units(p, f, b); q jsonb; r jsonb; w public.qorpera_runtime_worker_parents%rowtype; x jsonb;
	stale jsonb; i integer := 0;
begin
	if jsonb_array_length(u) <> 2 then raise exception 'The todo''s folder is made with the first dispatch'; end if;
	r := pg_temp.wc(p, 'w4-dispatch-0001', u, pg_temp.dispatch_request(f, b) || jsonb_build_object('parentStep', 3, 'view', v),
		pg_temp.reviewed(ada, 'w4-call-0001', u));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	w := pg_temp.w4_row('99300000-0000-4000-8000-000000000001', 1);
	if w.parent_run_id is distinct from (p ->> 'runId')::uuid or w.parent_step is distinct from 3 or w.parent_view is distinct from v
		or (pg_temp.worker_row(f)).sequence is distinct from 1 then
		raise exception 'The dispatch''s parent: %', to_jsonb(w); end if;
	-- Both settings are cleared after the commit.
	if coalesce(current_setting('qorpera.folder_worker_view', true), '') <> '' or public.qorpera_folder_worker_request() is not null then
		raise exception 'The request outlived its commit'; end if;
	-- A step alone; neither (no row); a stale reference (a block gone) is kept: the worker composes fresh from it.
	f := 'agents/ada/todos/plan-the-trip/second'; b := pg_temp.brief('99300000-0000-4000-8000-000000000002');
	u := pg_temp.dispatch_units(p, f, b);
	perform pg_temp.expect(pg_temp.wc(p, 'w4-dispatch-0002', u, pg_temp.dispatch_request(f, b) || '{"parentStep":0}'::jsonb,
		pg_temp.reviewed(ada, 'w4-call-0002', u)), 1, 'saved');
	w := pg_temp.w4_row('99300000-0000-4000-8000-000000000002', 1);
	if w.parent_run_id is distinct from (p ->> 'runId')::uuid or w.parent_step is distinct from 0 or w.parent_view is not null then
		raise exception 'The step-only parent: %', to_jsonb(w); end if;
	f := 'agents/ada/todos/plan-the-trip/plain'; b := pg_temp.brief('99300000-0000-4000-8000-000000000003');
	u := pg_temp.dispatch_units(p, f, b);
	perform pg_temp.expect(pg_temp.wc(p, 'w4-dispatch-0003', u, pg_temp.dispatch_request(f, b),
		pg_temp.reviewed(ada, 'w4-call-0003', u)), 1, 'saved');
	if exists (select 1 from public.qorpera_runtime_worker_parents where worker_id = '99300000-0000-4000-8000-000000000003') then
		raise exception 'A dispatch that named no parent kept one'; end if;
	stale := pg_temp.w4_view(n, 0, jsonb_build_array(jsonb_build_object('path', 'agents/ada/memory/thread/t0/00000000.jsonl',
		'version', extensions.gen_random_uuid())));
	perform pg_temp.w4_same(pg_temp.w4_check(stale), 'block_gone', 'The stale reference');
	f := 'agents/ada/todos/plan-the-trip/stale'; b := pg_temp.brief('99300000-0000-4000-8000-000000000004');
	u := pg_temp.dispatch_units(p, f, b);
	perform pg_temp.expect(pg_temp.wc(p, 'w4-dispatch-0004', u, pg_temp.dispatch_request(f, b) || jsonb_build_object('view', stale),
		pg_temp.reviewed(ada, 'w4-call-0004', u)), 1, 'saved');
	w := pg_temp.w4_row('99300000-0000-4000-8000-000000000004', 1);
	if w.parent_step is not null or w.parent_view is distinct from stale then raise exception 'The stale parent: %', to_jsonb(w); end if;
	-- Without the review of the call: denied, and nothing kept.
	f := 'agents/ada/todos/plan-the-trip/unreviewed'; b := pg_temp.brief('99300000-0000-4000-8000-000000000005');
	u := pg_temp.dispatch_units(p, f, b);
	perform pg_temp.expect(pg_temp.wc(p, 'w4-unreviewed-0001', u, pg_temp.dispatch_request(f, b)
		|| jsonb_build_object('parentStep', 1, 'view', v)), 1, 'denied', 'review_required');
	if exists (select 1 from public.qorpera_runtime_worker_parents where worker_id = '99300000-0000-4000-8000-000000000005') then
		raise exception 'A denied dispatch kept a parent'; end if;
	-- The request: a step is an integer from 0 (9 digits at most), a view has the shape and stands in the folder; only a
	-- dispatch or a follow-up names either.
	q := pg_temp.dispatch_request(f, b);
	foreach x in array array[
		q || '{"parentStep":-1}'::jsonb, q || '{"parentStep":1.5}'::jsonb, q || '{"parentStep":"3"}'::jsonb,
		q || '{"parentStep":1234567890}'::jsonb, q || '{"parentStep":null}'::jsonb, q || '{"parentStep":[3]}'::jsonb,
		q || '{"view":[]}'::jsonb, q || '{"view":null}'::jsonb, q || jsonb_build_object('view', v - 'asOfSeq'),
		q || jsonb_build_object('view', pg_temp.w4_view(n, 0, '[]', extensions.gen_random_uuid())),
		q || jsonb_build_object('view', pg_temp.w4_view(n + 100, 0, '[]')),
		q || jsonb_build_object('view', pg_temp.w4_view(n, 0, jsonb_build_array(pg_temp.w4_block(1) || jsonb_build_object('path',
			pg_temp.w4_block(2) ->> 'path')))),
		q || '{"parentSessionId":"63400000-0000-4000-8000-000000000020"}'::jsonb,
		jsonb_build_object('action','followup','folder','agents/ada/todos/call-the-bank/price-check','text','More.',
			'resultsVersion',null,'parentStep',-1),
		jsonb_build_object('action','followup','folder','agents/ada/todos/call-the-bank/price-check','text','More.',
			'resultsVersion',null,'view','{}'::jsonb),
		jsonb_build_object('action','decide','folder','agents/ada/todos/call-the-bank/price-check','decision','accepted','note',null,
			'parentStep',1),
		jsonb_build_object('action','report','folder',f,'parentStep',1),
		jsonb_build_object('action','report','folder',f,'view',v)
	] loop
		i := i + 1;
		perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L)', p, 'w4-bad-' || lpad(i::text, 4, '0'), u, x), '22023');
	end loop;
	-- A view already set in this transaction (as only trusted SQL could) stops the commit.
	perform set_config('qorpera.folder_worker_view', v::text, true);
	perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L, %L)', p, 'w4-nested-0001', u, q,
		pg_temp.reviewed(ada, 'w4-call-0005', u)), '55000');
	perform set_config('qorpera.folder_worker_view', '', true);
	if exists (select 1 from public.qorpera_runtime_workers where id = '99300000-0000-4000-8000-000000000005') then
		raise exception 'A refused request dispatched a worker'; end if;
end $$;

-- 4. The worker's own run reads its parent, step and views; nobody else does ----------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; n bigint := current_setting('qorpera_test.w4_seq')::bigint;
	s uuid := current_setting('qorpera_test.w4_session')::uuid;
	x jsonb := pg_temp.worker_run(ada, '99300000-0000-4000-8000-000000000001'); y jsonb; got jsonb;
begin
	perform pg_temp.w4_wake_sequence(x, 1);
	perform set_config('qorpera_test.w4_scout', x::text, false);
	got := pg_temp.w4_parent(x -> 'actor');
	if got is distinct from jsonb_build_object('schema','qorpera.folder-worker-parent/v1','workerId','99300000-0000-4000-8000-000000000001',
		'sequence',1,'parentRunId',ada -> 'actor' ->> 'runId','parentStep',3,'parentSessionId',s,
		'view',pg_temp.w4_view(n, 0, jsonb_build_array(pg_temp.w4_block(1), pg_temp.w4_block(2)))) then
		raise exception 'The scout''s parent: %', got; end if;
	-- A worker whose dispatch named none: its parent run and conversation, no step, no views.
	y := pg_temp.worker_run(ada, '99300000-0000-4000-8000-000000000003');
	perform pg_temp.w4_wake_sequence(y, 1);
	got := pg_temp.w4_parent(y -> 'actor');
	if got ->> 'parentRunId' is distinct from ada -> 'actor' ->> 'runId' or got ->> 'parentSessionId' is distinct from s::text
		or got -> 'parentStep' is distinct from 'null'::jsonb or got -> 'view' is distinct from 'null'::jsonb
		or got ->> 'workerId' is distinct from '99300000-0000-4000-8000-000000000003' then
		raise exception 'The plain worker''s parent: %', got; end if;
	-- Not the parent's run, a member, the platform, another company, or an API caller.
	perform pg_temp.raises(format('select pg_temp.w4_parent(%L)', ada -> 'actor'), '42501');
	perform pg_temp.raises(format('select pg_temp.w4_parent(%L)', pg_temp.member(2)), '42501');
	perform pg_temp.raises('select pg_temp.w4_parent(''{"kind":"platform"}'')', '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_worker_parent(%L, %L)', '63400000-0000-4000-8000-0000000000ff',
		x -> 'actor'), '42501');
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000002');
	perform pg_temp.raises(format('select pg_temp.w4_parent(%L)', x -> 'actor'), '42501');
	perform pg_temp.path_claims('service_role');
end $$;

-- 5. A follow-up: the sending run is the new parent, with its own step and views ------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; x jsonb := current_setting('qorpera_test.w4_scout')::jsonb;
	n bigint := current_setting('qorpera_test.w4_seq')::bigint; s uuid := current_setting('qorpera_test.w4_session')::uuid;
	f text := 'agents/ada/todos/plan-the-trip/scout'; v jsonb := pg_temp.w4_view(n, 0, jsonb_build_array(pg_temp.w4_block(2)));
	ada2 jsonb; base jsonb; next jsonb; u jsonb; q jsonb; r jsonb; w public.qorpera_runtime_worker_parents%rowtype; y jsonb; z jsonb;
	got jsonb;
begin
	perform pg_temp.expect(pg_temp.wc(x -> 'actor', 'w4-report-0001', jsonb_build_array(pg_temp.f2_write(x -> 'actor', f || '/results.md',
		pg_temp.results('blocked'))), jsonb_build_object('action','report','folder',f)), 1, 'saved');
	-- Ada's next run, in the same conversation.
	ada2 := pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1');
	if (select session_id from public.qorpera_execution_runs where id = (ada2 -> 'actor' ->> 'runId')::uuid) is distinct from s then
		raise exception 'Ada''s next run is in another conversation'; end if;
	base := (select pv.structured -> 'parse' from public.qorpera_folder_path_versions pv where pv.version = pg_temp.f2_version(f || '/brief.md'));
	next := base || jsonb_build_object('followUps', 1, 'followedUpAt', to_char(clock_timestamp() at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Look again.');
	u := jsonb_build_array(pg_temp.f2_write(ada2 -> 'actor', f || '/brief.md', next),
		jsonb_build_object('op','delete','path',f || '/results.md','expectedVersion',pg_temp.f2_version(f || '/results.md')));
	q := jsonb_build_object('action','followup','folder',f,'text','Look again.','resultsVersion',pg_temp.f2_version(f || '/results.md'),
		'parentStep',7,'view',v);
	r := pg_temp.wc(ada2 -> 'actor', 'w4-followup-0001', u, q, pg_temp.reviewed(ada2, 'w4-call-0010', u));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	w := pg_temp.w4_row('99300000-0000-4000-8000-000000000001', 2);
	if w.parent_run_id is distinct from (ada2 -> 'actor' ->> 'runId')::uuid or w.parent_step is distinct from 7 or w.parent_view is distinct from v
		or (pg_temp.worker_row(f)).sequence is distinct from 2 then
		raise exception 'The follow-up''s parent: %', to_jsonb(w); end if;
	-- The run of sequence 2 reads Ada's next run as its parent; the run of sequence 1 still reads its own.
	y := pg_temp.worker_run(ada2, '99300000-0000-4000-8000-000000000001');
	perform pg_temp.w4_wake_sequence(y, 2);
	got := pg_temp.w4_parent(y -> 'actor');
	if got ->> 'parentRunId' is distinct from ada2 -> 'actor' ->> 'runId' or got -> 'sequence' is distinct from '2'::jsonb
		or got -> 'parentStep' is distinct from '7'::jsonb or got -> 'view' is distinct from v or got ->> 'parentSessionId' is distinct from s::text then
		raise exception 'The followed-up worker''s parent: %', got; end if;
	got := pg_temp.w4_parent(x -> 'actor');
	if got ->> 'parentRunId' is distinct from ada -> 'actor' ->> 'runId' or got -> 'sequence' is distinct from '1'::jsonb
		or got -> 'parentStep' is distinct from '3'::jsonb
		or got -> 'view' is distinct from pg_temp.w4_view(n, 0, jsonb_build_array(pg_temp.w4_block(1), pg_temp.w4_block(2))) then
		raise exception 'The first run''s parent changed: %', got; end if;
	-- No count on follow-ups: the run of sequence 2 reports, the worker has had many follow-ups since (set by hand), and
	-- the next one, at the highest sequence a worker row holds, keeps its parent and reads it back.
	perform pg_temp.expect(pg_temp.wc(y -> 'actor', 'w4-report-0002', jsonb_build_array(pg_temp.f2_write(y -> 'actor', f || '/results.md',
		pg_temp.results('blocked'))), jsonb_build_object('action','report','folder',f)), 1, 'saved');
	perform pg_temp.fx(format('update public.qorpera_runtime_workers set sequence = 2147483646 where id = %L',
		'99300000-0000-4000-8000-000000000001'));
	base := (select pv.structured -> 'parse' from public.qorpera_folder_path_versions pv where pv.version = pg_temp.f2_version(f || '/brief.md'));
	next := base || jsonb_build_object('followUps', 2147483646, 'followedUpAt', to_char(clock_timestamp() at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Once more.');
	u := jsonb_build_array(pg_temp.f2_write(ada2 -> 'actor', f || '/brief.md', next),
		jsonb_build_object('op','delete','path',f || '/results.md','expectedVersion',pg_temp.f2_version(f || '/results.md')));
	q := jsonb_build_object('action','followup','folder',f,'text','Once more.','resultsVersion',pg_temp.f2_version(f || '/results.md'),
		'parentStep',9);
	perform pg_temp.expect(pg_temp.wc(ada2 -> 'actor', 'w4-followup-0002', u, q, pg_temp.reviewed(ada2, 'w4-call-0011', u)), 1, 'saved');
	w := pg_temp.w4_row('99300000-0000-4000-8000-000000000001', 2147483647);
	if w.parent_run_id is distinct from (ada2 -> 'actor' ->> 'runId')::uuid or w.parent_step is distinct from 9 or w.parent_view is not null
		or (pg_temp.worker_row(f)).sequence is distinct from 2147483647 then
		raise exception 'The last follow-up''s parent: %', to_jsonb(w); end if;
	z := pg_temp.worker_run(ada2, '99300000-0000-4000-8000-000000000001');
	perform pg_temp.w4_wake_sequence(z, 2147483647);
	got := pg_temp.w4_parent(z -> 'actor');
	if got -> 'sequence' is distinct from '2147483647'::jsonb or got -> 'parentStep' is distinct from '9'::jsonb
		or got -> 'view' is distinct from 'null'::jsonb or got ->> 'parentRunId' is distinct from ada2 -> 'actor' ->> 'runId' then
		raise exception 'The last follow-up''s run reads: %', got; end if;
end $$;

-- 6. Grants and the deploy guard's markers ---------------------------------------------------------------------------------
do $$
declare v_function text;
begin
	if not has_function_privilege('service_role', 'public.qorpera_memory_view_reference_check(uuid,jsonb)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_worker_parent(uuid,jsonb)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_memory_view_reference_valid(jsonb)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_worker_parent_keep(uuid,integer,uuid,jsonb)', 'execute')
		or exists (select 1 from unnest(array['anon','authenticated']) r(name), unnest(array[
				'public.qorpera_memory_view_reference_check(uuid,jsonb)', 'public.qorpera_folder_worker_parent(uuid,jsonb)',
				'public.qorpera_memory_view_reference_valid(jsonb)', 'public.qorpera_folder_worker_parent_keep(uuid,integer,uuid,jsonb)']) f(name)
			where has_function_privilege(r.name, f.name, 'execute'))
		or exists (select 1 from unnest(array['anon','authenticated','service_role']) r(name)
			where has_table_privilege(r.name, 'public.qorpera_runtime_worker_parents', 'select, insert, update, delete')) then
		raise exception 'The grants'; end if;
	-- No count on a worker's sequences (test 332 keeps it so).
	if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'qorpera_runtime_worker_parents_sequence_check')
		is distinct from 'CHECK ((sequence >= 1))' then
		raise exception 'The sequence check'; end if;
	foreach v_function in array array[
		'public.qorpera_memory_view_reference_valid(jsonb)', 'public.qorpera_memory_view_reference_check(uuid,jsonb)',
		'public.qorpera_folder_worker_parent_keep(uuid,integer,uuid,jsonb)', 'public.qorpera_folder_worker_parent(uuid,jsonb)',
		'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)',
		'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'] loop
		if position('20260930171000' in pg_get_functiondef(v_function::regprocedure)) = 0 then
			raise exception 'The marker is missing in %', v_function; end if;
	end loop;
end $$;

rollback;
