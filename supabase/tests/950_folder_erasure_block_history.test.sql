-- @fixture 883_folder_core_erasure.test.sql until "-- 1. Refusals before anything changes"
-- Agent memory tree, W1a (migration 20260930120000; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10 step 3): a
-- block-history request erases one block's versions before the delete that cut it, as the platform's request for the
-- member who asked. Its refusals and its reserved key; the cutoff at the block's delete, the current life kept, past
-- its versions phase from phase 2; a replay before and after done (digest, copies and what it was for kept); a delete
-- erased already (asked again while that erasure runs, then nothing left); partners through a renamed folder, added by
-- the wrapper; more than 20 paths, 21 named in one round; a life that moved on to a live path left alone; every copy
-- named; no cutoff (every life; a live block, or one restored and renamed to a live path, refused, naming the live path,
-- the key's newest life and the delete before it; a reused name asked again with that delete and life, refused once a
-- newer life began and, with no live path left, asked with no cutoff; or naming no delete once a member's erasure took
-- it, asked again while that erasure is in its versions phase; an older life that moved on left alone;
-- another member's private path); nothing left (no erasure); no run noted; the grants. On 803's company; rolled back at
-- the end.

create function pg_temp.w1a_key(p_table text, p_id text, p_path text) returns text language sql as $$
	select 'memtree:' || encode(extensions.digest(convert_to(p_table || ':' || p_id || ':' || public.qorpera_folder_key(p_path),
		'utf8'), 'sha256'), 'hex')
$$;
-- The newest version of an op at a path: {seq, unit}.
create function pg_temp.w1a_at(p_path text, p_op text default 'delete') returns jsonb language sql as $$
	select jsonb_build_object('seq', c.seq, 'unit', v.unit_no) from public.qorpera_folder_path_versions v
	join public.qorpera_folder_commits c on c.id = v.commit_id
	where v.environment_id = '70700000-0000-4000-8000-000000000020' and public.qorpera_folder_key(v.path) = public.qorpera_folder_key(p_path)
		and v.op = p_op
	order by c.seq desc, v.unit_no desc limit 1
$$;
-- The key's newest life's start: {seq, unit}.
create function pg_temp.w1a_life(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('seq', s.seq, 'unit', s.unit_no)
	from public.qorpera_folder_erasure_life_start('70700000-0000-4000-8000-000000000020', public.qorpera_folder_key(p_path)) s
$$;
create function pg_temp.w1a_block(p_path text, p_at jsonb, p_id uuid, p_table text default 'qorpera_memory_message_erases')
returns jsonb language sql as $$
	select jsonb_strip_nulls(jsonb_build_object('path', p_path, 'cutoffSeq', p_at -> 'seq', 'cutoffUnit', p_at -> 'unit',
		'for', jsonb_build_object('table', p_table, 'id', p_id)))
$$;
create function pg_temp.w1a_ask(p_block jsonb, p_key text default null,
	p_user uuid default '70700000-0000-4000-8000-000000000001') returns jsonb language sql as $$
	select public.qorpera_folder_erase_block_history('70700000-0000-4000-8000-000000000020', p_user,
		coalesce(p_key, pg_temp.w1a_key(p_block -> 'for' ->> 'table', p_block -> 'for' ->> 'id', p_block ->> 'path')), p_block)
$$;
-- Drained to done: the upload intents (which root their objects for a day after they end) made older than that first.
create function pg_temp.w1a_drain(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
begin
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	return pg_temp.drain(p_id);
end $$;
create function pg_temp.w1a_put(p_key text, p_path text, p_text text) returns void language sql as $$
	select pg_temp.expect(pg_temp.commit(pg_temp.owner(), p_key, jsonb_build_array(pg_temp.put(p_path, p_text))), 1, 'saved')
$$;
create function pg_temp.w1a_del(p_key text, p_path text) returns void language sql as $$
	select pg_temp.expect(pg_temp.commit(pg_temp.owner(), p_key, jsonb_build_array(pg_temp.del(p_path))), 1, 'saved')
$$;

-- 0. Folder GC serves the company (so an erasure's bytes do not wait), and the folder --------------------------------------

do $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-docs', jsonb_build_array(pg_temp.mkdir('docs'))), 1, 'saved');
end $$;

-- 1. Refusals -------------------------------------------------------------------------------------------------------------

do $$
declare b jsonb;
begin
	-- Another path with history before docs/a.md's delete (3).
	perform pg_temp.w1a_put('w1a-b-01', 'docs/b.md', 'w1a b one');
	perform pg_temp.w1a_put('w1a-a-01', 'docs/a.md', 'w1a a one');
	perform pg_temp.w1a_put('w1a-a-02', 'docs/a.md', 'w1a a two');
	perform pg_temp.w1a_del('w1a-a-03', 'docs/a.md');
	perform pg_temp.w1a_put('w1a-a-04', 'docs/a.md', 'w1a a rewritten');
	b := pg_temp.w1a_block('docs/a.md', pg_temp.w1a_at('docs/a.md'), '95000000-0000-4000-8000-0000000000a1');
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.w1a_ask(%L)', b)), '42501', 'only the service role asks');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform pg_temp.is(pg_temp.message(format($q$select pg_temp.erase(array['docs/a.md'], %L)$q$, 'memtree:' || repeat('0', 64))),
		'Operation key is reserved for block-history requests', 'a member''s request never takes the memtree: prefix');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L, %L)', b,
			pg_temp.w1a_key('qorpera_memory_message_erases', '95000000-0000-4000-8000-0000000000a1', 'docs/b.md'))),
		'Operation key does not match the block-history request', 'the key is the erase row''s and the block''s');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"extra":1}')),
		'Block-history request is invalid', 'a key the block does not have');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b - 'cutoffUnit')),
		'Block-history request is invalid', 'half a cutoff');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || jsonb_build_object('cutoffSeq', b ->> 'cutoffSeq'))),
		'Block-history request is invalid', 'a cutoff as a string');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"cutoffUnit":0}')),
		'Block-history request is invalid', 'a unit below 1');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"lifeSeq":1}')),
		'Block-history request is invalid', 'half a life');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', (b - 'cutoffSeq' - 'cutoffUnit')
			|| '{"lifeSeq":1,"lifeUnit":1}')),
		'Block-history request is invalid', 'a life with no cutoff');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"lifeSeq":"1","lifeUnit":1}')),
		'Block-history request is invalid', 'a life as a string');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)',
			pg_temp.w1a_block('docs/a.md', pg_temp.w1a_at('docs/a.md'), '95000000-0000-4000-8000-0000000000a1', 'qorpera_folder_erasures'))),
		'Block-history request is invalid', 'an erase row of another table');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)',
			jsonb_set(b, '{for,id}', '"95000000-0000-4000-8000-0000000000A1"'))),
		'Block-history request is invalid', 'an erase row id not as Postgres spells it');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"path":"docs/../a.md"}')),
		'Erasure path is invalid', 'the block''s path');
	perform pg_temp.is(pg_temp.message($q$select pg_temp.erase(array(select 'docs/p' || i || '.md' from generate_series(1, 21) i),
		'w1a-21-paths')$q$), 'Erasure paths are invalid', 'a member still names at most 20 paths');
	if exists (select 1 from public.qorpera_folder_erasures) then raise exception 'A refusal recorded an erasure'; end if;
end $$;

-- 2. The block cut at its delete; a replay before and after done ------------------------------------------------------------

do $$
declare b jsonb; r jsonb; v_at jsonb := pg_temp.w1a_at('docs/a.md'); v_id uuid; v public.qorpera_folder_erasures%rowtype;
begin
	b := pg_temp.w1a_block('docs/a.md', v_at, '95000000-0000-4000-8000-0000000000a1');
	r := pg_temp.w1a_ask(b);
	v_id := (r ->> 'erasureId')::uuid;
	perform pg_temp.is(r ->> 'kind', 'block-history', 'the reply''s kind');
	if r -> 'for' <> jsonb_build_object('table', 'qorpera_memory_message_erases', 'id', '95000000-0000-4000-8000-0000000000a1',
			'path', 'docs/a.md') then raise exception 'The reply names what it was for: %', r; end if;
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '2', 'the two writes before the delete');
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'cutoffSeq', v_at ->> 'seq', 'cut at the delete');
	perform pg_temp.is(r -> 'copies' #>> '{}', '[]', 'no copies');
	select * into v from public.qorpera_folder_erasures where id = v_id;
	if v.block_history <> b or v.requested_by_user_id <> '70700000-0000-4000-8000-000000000001' then
		raise exception 'The row keeps the request: %', to_jsonb(v); end if;
	if public.qorpera_folder_erasure_past_versions(v_id) then raise exception 'Not past its versions phase yet'; end if;
	for p in 2..7 loop
		update public.qorpera_folder_erasures set phase = p where id = v_id;
		if not public.qorpera_folder_erasure_past_versions(v_id) then raise exception 'Past its versions phase in phase %', p; end if;
	end loop;
	update public.qorpera_folder_erasures set phase = 1 where id = v_id;
	if pg_temp.w1a_ask(b) is distinct from r then raise exception 'A replay answers the same'; end if;
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"cutoffUnit":7}')),
		'Operation key was used for another erasure', 'the same erase row and block with another cutoff');
	v := pg_temp.w1a_drain(v_id);
	perform pg_temp.is(v.state, 'done', 'drained');
	perform pg_temp.is(pg_temp.versions_at('docs/a.md')::text, '2', 'the delete and the rewrite stay');
	if not exists (select 1 from public.qorpera_folder_entries where environment_id = '70700000-0000-4000-8000-000000000020'
			and key_text = 'docs/a.md' and kind = 'file') then raise exception 'The block stays'; end if;
	-- Done: the digest, the copies and what it was for stay; the roots go.
	if v.request_sha256 is null or v.block_history <> b or v.reply ? 'roots' or v.reply -> 'copies' <> '[]'::jsonb
			or v.reply ->> 'kind' <> 'block-history' or v.reply -> 'for' <> r -> 'for' then
		raise exception 'A done request keeps its digest, copies and for: %', to_jsonb(v); end if;
	if pg_temp.w1a_ask(b) is distinct from v.reply then raise exception 'A replay after done answers the stored reply'; end if;
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b || '{"cutoffUnit":7}')),
		'Operation key was used for another erasure', 'and after done');
	if not public.qorpera_folder_erasure_past_versions(v_id) or not public.qorpera_folder_erasure_past_versions(null)
			or not public.qorpera_folder_erasure_past_versions(extensions.gen_random_uuid()) then
		raise exception 'Past its versions phase: done, or no erasure'; end if;
	-- Asked again for another erase row: nothing is left, and no erasure is made.
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/a.md', v_at, '95000000-0000-4000-8000-0000000000a2'));
	if r ->> 'erasureId' is not null or r ->> 'kind' <> 'block-history' or r -> 'roots' -> 0 ->> 'versions' <> '0'
			or r -> 'for' ->> 'id' <> '95000000-0000-4000-8000-0000000000a2' then
		raise exception 'Nothing left: %', r; end if;
	if exists (select 1 from public.qorpera_folder_erasures where operation_key = pg_temp.w1a_key('qorpera_memory_message_erases',
			'95000000-0000-4000-8000-0000000000a2', 'docs/a.md'))
		or exists (select 1 from public.qorpera_folder_entries where environment_id = '70700000-0000-4000-8000-000000000020'
			and kind = 'claim') then raise exception 'Nothing left makes no row and leaves no claim'; end if;
end $$;

-- 3. A cutoff that is not the block's delete ------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', pg_temp.w1a_block('docs/a.md', pg_temp.w1a_at('docs/a.md', 'write'),
			'95000000-0000-4000-8000-0000000000a3', 'qorpera_memory_step_erases'))),
		'Block-history cutoff is not the block''s delete', 'a write');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', pg_temp.w1a_block('docs/a.md',
			jsonb_build_object('seq', pg_temp.seq() + 5, 'unit', 1), '95000000-0000-4000-8000-0000000000a3', 'qorpera_memory_step_erases'))),
		'Block-history cutoff is not the block''s delete', 'a commit not yet made');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', pg_temp.w1a_block('docs/b.md', pg_temp.w1a_at('docs/a.md'),
			'95000000-0000-4000-8000-0000000000a3', 'qorpera_memory_step_erases'))),
		'Block-history cutoff is not the block''s delete', 'another path''s delete');
end $$;

-- 4. A delete erased already: asked again while that erasure runs its versions phase, nothing left after; never refused ------

do $$
declare b1 jsonb; b2 jsonb; r jsonb; v_at jsonb; v_id uuid;
begin
	-- A later cutoff's request for the same block (another message erase of the conversation) takes the first delete.
	perform pg_temp.w1a_put('w1a-g-01', 'docs/g.md', 'w1a g one');
	perform pg_temp.w1a_del('w1a-g-02', 'docs/g.md');
	v_at := pg_temp.w1a_at('docs/g.md');
	perform pg_temp.w1a_put('w1a-g-03', 'docs/g.md', 'w1a g two');
	perform pg_temp.w1a_del('w1a-g-04', 'docs/g.md');
	perform pg_temp.w1a_put('w1a-g-05', 'docs/g.md', 'w1a g rewritten');
	b1 := pg_temp.w1a_block('docs/g.md', v_at, '95000000-0000-4000-8000-0000000000a4');
	b2 := pg_temp.w1a_block('docs/g.md', pg_temp.w1a_at('docs/g.md'), '95000000-0000-4000-8000-0000000000a5');
	r := pg_temp.w1a_ask(b2);
	v_id := (r ->> 'erasureId')::uuid;
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '3', 'both writes and the first delete');
	-- As if its versions phase had erased the first delete in a batch, and not yet the write before it.
	delete from public.qorpera_folder_path_versions v using public.qorpera_folder_commits c
	where c.id = v.commit_id and v.environment_id = '70700000-0000-4000-8000-000000000020' and v.path = 'docs/g.md'
		and c.seq = (v_at ->> 'seq')::bigint and v.unit_no = (v_at ->> 'unit')::integer;
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.w1a_ask(%L)', b1)), '55006', 'asked again while it runs');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)', b1)), 'Block history is being erased; ask again',
		'its message');
	perform pg_temp.is((pg_temp.w1a_drain(v_id)).state, 'done', 'drained');
	r := pg_temp.w1a_ask(b1);
	if r ->> 'erasureId' is not null or r -> 'roots' -> 0 ->> 'versions' <> '0' then raise exception 'Nothing left after: %', r; end if;
	-- A member's erasure of the deleted path takes every life, the delete with them.
	perform pg_temp.w1a_put('w1a-h-01', 'docs/h.md', 'w1a h one');
	perform pg_temp.w1a_del('w1a-h-02', 'docs/h.md');
	v_at := pg_temp.w1a_at('docs/h.md');
	perform pg_temp.w1a_put('w1a-h-03', 'docs/h.md', 'w1a h rewritten');
	perform pg_temp.w1a_del('w1a-h-04', 'docs/h.md');
	perform pg_temp.is((pg_temp.w1a_drain((pg_temp.erase(array['docs/h.md'], 'w1a-h-member') ->> 'erasureId')::uuid)).state,
		'done', 'the member''s erasure drained');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/h.md', v_at, '95000000-0000-4000-8000-0000000000a6'));
	if r ->> 'erasureId' is not null or r -> 'roots' -> 0 ->> 'versions' <> '0' then
		raise exception 'Nothing left after a member''s erasure: %', r; end if;
end $$;

-- 5. Partners through a renamed folder, added by the wrapper; the member who asked need not erase ---------------------------

do $$
declare b jsonb; r jsonb; v public.qorpera_folder_erasures%rowtype;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-f-01', jsonb_build_array(pg_temp.mkdir('docs/f1'),
		pg_temp.put('docs/f1/b.md', 'w1a f one'))), 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-f-02', jsonb_build_array(pg_temp.mv('docs/f1', 'docs/f2'))), 1, 'saved');
	perform pg_temp.w1a_del('w1a-f-03', 'docs/f2/b.md');
	perform pg_temp.w1a_put('w1a-f-04', 'docs/f2/b.md', 'w1a f rewritten');
	b := pg_temp.w1a_block('docs/f2/b.md', pg_temp.w1a_at('docs/f2/b.md'), '95000000-0000-4000-8000-0000000000b1',
		'qorpera_memory_step_erases');
	r := pg_temp.w1a_ask(b, null, '70700000-0000-4000-8000-000000000002');
	if jsonb_array_length(r -> 'roots') <> 2 or r -> 'roots' -> 0 ->> 'path' <> 'docs/f1/b.md' or r -> 'roots' -> 0 ->> 'versions' <> '2'
			or r -> 'roots' -> 1 ->> 'path' <> 'docs/f2/b.md' or r -> 'roots' -> 1 ->> 'versions' <> '1' then
		raise exception 'The old name is erased with the block: %', r; end if;
	if pg_temp.w1a_ask(b, null, '70700000-0000-4000-8000-000000000002') is distinct from r then
		raise exception 'A replay of the widened request answers the same'; end if;
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state, 'done', 'drained');
	perform pg_temp.is(v.requested_by_user_id::text, '70700000-0000-4000-8000-000000000002', 'for the member who asked');
	perform pg_temp.is(pg_temp.versions_at('docs/f1/b.md')::text || pg_temp.versions_at('docs/f2/b.md')::text, '02',
		'the old name''s history goes; the delete and the rewrite stay');
	perform pg_temp.is(pg_temp.versions_at('docs/f1')::text, '2', 'the folder''s own history is not the block''s');
end $$;

-- 6. More than 20 paths: a block renamed 21 times, its 21 partners named in one round --------------------------------------

do $$
declare b jsonb; r jsonb; d jsonb; v public.qorpera_folder_erasures%rowtype;
begin
	perform pg_temp.w1a_put('w1a-z-00', 'docs/z00.md', 'w1a z one');
	for i in 1..21 loop
		perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-z-' || lpad(i::text, 2, '0'), jsonb_build_array(pg_temp.mv(
			format('docs/z%s.md', lpad((i - 1)::text, 2, '0')), format('docs/z%s.md', lpad(i::text, 2, '0'))))), 1, 'saved');
	end loop;
	perform pg_temp.w1a_del('w1a-z-22', 'docs/z21.md');
	perform pg_temp.w1a_put('w1a-z-23', 'docs/z21.md', 'w1a z rewritten');
	b := pg_temp.w1a_block('docs/z21.md', pg_temp.w1a_at('docs/z21.md'), '95000000-0000-4000-8000-0000000000b2');
	d := pg_temp.detail(format('select public.qorpera_folder_erase(%L, %L, %L, %L)', '70700000-0000-4000-8000-000000000020',
		jsonb_build_object('kind', 'memtree', 'userId', '70700000-0000-4000-8000-000000000001', 'block', b), '["docs/z21.md"]',
		pg_temp.w1a_key('qorpera_memory_message_erases', '95000000-0000-4000-8000-0000000000b2', 'docs/z21.md')));
	perform pg_temp.is(jsonb_array_length(d -> 'add')::text, '21', 'every partner in one round, past the member''s 20');
	r := pg_temp.w1a_ask(b);
	perform pg_temp.is(jsonb_array_length(r -> 'roots')::text, '22', 'the block and its 21 old names');
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	for i in 1..60 loop
		select * into v from public.qorpera_folder_erasures where id = (r ->> 'erasureId')::uuid;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step();
	end loop;
	perform pg_temp.is(v.state, 'done', 'drained');
	perform pg_temp.is((select sum(pg_temp.versions_at(format('docs/z%s.md', lpad(i::text, 2, '0')))) from generate_series(0, 20) i)::text
		|| pg_temp.versions_at('docs/z21.md'), '02', 'every old name''s history goes; the delete and the rewrite stay');
end $$;

-- 7. A life that moved on to a live path is another block: left alone, not refused ------------------------------------------

do $$
declare b jsonb; r jsonb; d jsonb; v_y uuid;
begin
	perform pg_temp.w1a_put('w1a-x-01', 'docs/x.md', 'w1a x one');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-x-02', jsonb_build_array(pg_temp.mv('docs/x.md', 'docs/y.md'))), 1, 'saved');
	perform pg_temp.w1a_put('w1a-x-03', 'docs/x.md', 'w1a x two');
	perform pg_temp.w1a_del('w1a-x-04', 'docs/x.md');
	perform pg_temp.w1a_put('w1a-x-05', 'docs/x.md', 'w1a x rewritten');
	v_y := pg_temp.version('docs/y.md');
	d := pg_temp.detail($q$select pg_temp.erase(array['docs/x.md'], 'w1a-x-member')$q$);
	if d -> 'live' <> '["docs/y.md"]'::jsonb then raise exception 'A member''s request is refused with the live path: %', d; end if;
	b := pg_temp.w1a_block('docs/x.md', pg_temp.w1a_at('docs/x.md'), '95000000-0000-4000-8000-0000000000c1');
	r := pg_temp.w1a_ask(b);
	if jsonb_array_length(r -> 'roots') <> 1 or r -> 'roots' -> 0 ->> 'versions' <> '3' or r -> 'copies' <> jsonb_build_array(
			jsonb_build_object('environmentId', '70700000-0000-4000-8000-000000000020', 'path', 'docs/y.md', 'live', true)) then
		raise exception 'Both lives before the cutoff, the live path named as a copy: %', r; end if;
	perform pg_temp.is((pg_temp.w1a_drain((r ->> 'erasureId')::uuid)).state, 'done', 'drained');
	perform pg_temp.is(pg_temp.versions_at('docs/x.md')::text || pg_temp.versions_at('docs/y.md')::text, '21',
		'the block''s delete and rewrite stay, and the live path keeps its history');
	if pg_temp.version('docs/y.md') is distinct from v_y then raise exception 'The live path keeps its version'; end if;
end $$;

-- 8. Every copy named, kept after done -----------------------------------------------------------------------------------------

do $$
declare r jsonb; v_units jsonb; v public.qorpera_folder_erasures%rowtype;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-c-00', jsonb_build_array(pg_temp.mkdir('docs/c'),
		pg_temp.put('docs/cb.md', 'w1a copied'))), 2, 'saved');
	for n in 0..1 loop
		select jsonb_agg(pg_temp.put(format('docs/c/c%s.md', lpad(i::text, 2, '0')), 'w1a copied') order by i) into v_units
		from generate_series(n * 11 + 1, n * 11 + 11) i;
		perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-c-0' || (n + 1), v_units), 11, 'saved');
	end loop;
	perform pg_temp.w1a_del('w1a-c-03', 'docs/cb.md');
	perform pg_temp.w1a_put('w1a-c-04', 'docs/cb.md', 'w1a cb rewritten');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/cb.md', pg_temp.w1a_at('docs/cb.md'), '95000000-0000-4000-8000-0000000000d1'));
	perform pg_temp.is(jsonb_array_length(r -> 'copies')::text, '22', 'every copy, past the member''s 20');
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state || jsonb_array_length(v.reply -> 'copies'), 'done22', 'kept after done');
end $$;

-- 9. No cutoff: every life of a block not live; a live block, or one restored and renamed to a live path, refused -------------

do $$
declare r jsonb; b jsonb; v_user uuid := extensions.gen_random_uuid(); v public.qorpera_folder_erasures%rowtype; v_at jsonb;
	v_id uuid; c_private constant text := 'members/70700000-0000-4000-8000-000000000002/private/w1a.md';
begin
	perform pg_temp.w1a_put('w1a-n-01', 'docs/n.md', 'w1a n one');
	perform pg_temp.w1a_del('w1a-n-02', 'docs/n.md');
	perform pg_temp.w1a_put('w1a-n-03', 'docs/n.md', 'w1a n two');
	perform pg_temp.w1a_del('w1a-n-04', 'docs/n.md');
	-- The member who asked may have left the company.
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/n.md', null, '95000000-0000-4000-8000-0000000000e1'), null, v_user);
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '4', 'both lives');
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state || pg_temp.versions_at('docs/n.md'), 'done0', 'every life goes');
	perform pg_temp.is(v.requested_by_user_id::text, v_user::text, 'for the member who asked');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/n.md', null, '95000000-0000-4000-8000-0000000000e2'));
	if r ->> 'erasureId' is not null then raise exception 'Nothing left: %', r; end if;
	perform pg_temp.w1a_put('w1a-l-01', 'docs/l2.md', 'w1a l one');
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/l2.md', null, '95000000-0000-4000-8000-0000000000e3'))), '55000', 'a live block');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/l2.md', null, '95000000-0000-4000-8000-0000000000e3'))), 'Block is live again', 'its message');
	-- Restored and renamed since step 1 deleted it: the same block, live at another path (through one rename, then two).
	perform pg_temp.w1a_put('w1a-m-01', 'docs/m.md', 'w1a m one');
	perform pg_temp.w1a_del('w1a-m-02', 'docs/m.md');
	perform pg_temp.w1a_put('w1a-m-03', 'docs/m.md', 'w1a m restored');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-m-04', jsonb_build_array(pg_temp.mv('docs/m.md', 'docs/m2.md'))), 1, 'saved');
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/m.md', null, '95000000-0000-4000-8000-0000000000e4'))), '55000', 'restored and renamed');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-m-05', jsonb_build_array(pg_temp.mv('docs/m2.md', 'docs/m3.md'))), 1, 'saved');
	perform pg_temp.is(pg_temp.message(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/m.md', null, '95000000-0000-4000-8000-0000000000e4'))), 'Block is live again', 'and renamed again');
	-- The detail names the live path, the key's newest life and the delete before that life (none for a block never
	-- deleted).
	perform pg_temp.is(pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/l2.md', null, '95000000-0000-4000-8000-0000000000e3')))::text,
		jsonb_build_object('live', 'docs/l2.md', 'life', pg_temp.w1a_life('docs/l2.md'), 'delete', null)::text,
		'a live block''s detail');
	perform pg_temp.is(pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/m.md', null, '95000000-0000-4000-8000-0000000000e4')))::text,
		jsonb_build_object('live', 'docs/m3.md', 'life', pg_temp.w1a_life('docs/m.md'), 'delete', pg_temp.w1a_at('docs/m.md'))::text,
		'the end of the renames');
	-- Another tree's block at a name reused since the delete: asked again with that delete as the cutoff, the old life
	-- goes and the new one stays (kept at its name, or renamed).
	perform pg_temp.w1a_put('w1a-q-01', 'docs/q.md', 'w1a q old tree');
	perform pg_temp.w1a_del('w1a-q-02', 'docs/q.md');
	perform pg_temp.w1a_put('w1a-q-03', 'docs/q.md', 'w1a q new tree');
	r := pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/q.md', null, '95000000-0000-4000-8000-0000000000e7')));
	perform pg_temp.is(r::text, jsonb_build_object('live', 'docs/q.md', 'life', pg_temp.w1a_life('docs/q.md'),
		'delete', pg_temp.w1a_at('docs/q.md'))::text, 'a reused name''s detail');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/q.md', r -> 'delete', '95000000-0000-4000-8000-0000000000e7')
		|| jsonb_build_object('lifeSeq', r #> '{life,seq}', 'lifeUnit', r #> '{life,unit}'));
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state || pg_temp.versions_at('docs/q.md'), 'done2', 'the old life goes, the new one stays');
	-- The life it names ended since: that tree's block deleted and the old one restored before the carrier asked again.
	-- Refused under the path lock, naming the new life; with no live path left, asked with no cutoff, every life goes.
	perform pg_temp.w1a_put('w1a-t-01', 'docs/t.md', 'w1a t old tree');
	perform pg_temp.w1a_del('w1a-t-02', 'docs/t.md');
	perform pg_temp.w1a_put('w1a-t-03', 'docs/t.md', 'w1a t new tree');
	r := pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/t.md', null, '95000000-0000-4000-8000-0000000000eb')));
	b := pg_temp.w1a_block('docs/t.md', r -> 'delete', '95000000-0000-4000-8000-0000000000eb')
		|| jsonb_build_object('lifeSeq', r #> '{life,seq}', 'lifeUnit', r #> '{life,unit}');
	perform pg_temp.w1a_del('w1a-t-04', 'docs/t.md');
	perform pg_temp.w1a_put('w1a-t-05', 'docs/t.md', 'w1a t old tree restored');
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.w1a_ask(%L)', b)), '55000', 'a newer life since');
	perform pg_temp.is(pg_temp.detail(format('select pg_temp.w1a_ask(%L)', b))::text,
		jsonb_build_object('live', 'docs/t.md', 'life', pg_temp.w1a_life('docs/t.md'), 'delete', pg_temp.w1a_at('docs/t.md'))::text,
		'the newer life named');
	v_at := pg_temp.w1a_at('docs/t.md');
	perform pg_temp.w1a_del('w1a-t-06', 'docs/t.md');
	perform pg_temp.is(pg_temp.detail(format('select pg_temp.w1a_ask(%L)', b))::text,
		jsonb_build_object('live', null, 'life', pg_temp.w1a_life('docs/t.md'), 'delete', v_at)::text, 'no live path left');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/t.md', null, '95000000-0000-4000-8000-0000000000eb'));
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '6', 'every life, asked with no cutoff');
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state || pg_temp.versions_at('docs/t.md'), 'done0', 'nothing left at the name');
	perform pg_temp.w1a_put('w1a-q2-01', 'docs/q2.md', 'w1a q2 old tree');
	perform pg_temp.w1a_del('w1a-q2-02', 'docs/q2.md');
	perform pg_temp.w1a_put('w1a-q2-03', 'docs/q2.md', 'w1a q2 new tree');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-q2-04', jsonb_build_array(pg_temp.mv('docs/q2.md', 'docs/q3.md'))), 1, 'saved');
	r := pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/q2.md', null, '95000000-0000-4000-8000-0000000000e8')));
	perform pg_temp.is(r::text, jsonb_build_object('live', 'docs/q3.md', 'life', pg_temp.w1a_life('docs/q2.md'),
		'delete', pg_temp.w1a_at('docs/q2.md'))::text, 'a reused name renamed since');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/q2.md', r -> 'delete', '95000000-0000-4000-8000-0000000000e8'));
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state || pg_temp.versions_at('docs/q2.md') || pg_temp.versions_at('docs/q3.md'), 'done31',
		'the old life goes; the renamed life keeps its history');
	-- A reused name after a member's erasure took the old life and its delete: asked again while that erasure is in its
	-- versions phase, then no delete is named, as nothing of the old block is left at the name (kept or renamed).
	perform pg_temp.w1a_put('w1a-s-01', 'docs/s.md', 'w1a s old tree');
	perform pg_temp.w1a_del('w1a-s-02', 'docs/s.md');
	v_at := pg_temp.w1a_at('docs/s.md');
	perform pg_temp.w1a_put('w1a-s-03', 'docs/s.md', 'w1a s new tree');
	v_id := (pg_temp.erase(array['docs/s.md'], 'w1a-s-member') ->> 'erasureId')::uuid;
	-- As if its versions phase had erased the delete in a batch, and not yet the write before it.
	delete from public.qorpera_folder_path_versions pv using public.qorpera_folder_commits c
	where c.id = pv.commit_id and pv.environment_id = '70700000-0000-4000-8000-000000000020' and pv.path = 'docs/s.md'
		and c.seq = (v_at ->> 'seq')::bigint and pv.unit_no = (v_at ->> 'unit')::integer;
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/s.md', null, '95000000-0000-4000-8000-0000000000e9'))), '55006', 'asked again while it runs');
	perform pg_temp.is((pg_temp.w1a_drain(v_id)).state, 'done', 'the member''s erasure drained');
	perform pg_temp.is(pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/s.md', null, '95000000-0000-4000-8000-0000000000e9')))::text,
		jsonb_build_object('live', 'docs/s.md', 'life', pg_temp.w1a_life('docs/s.md'), 'delete', null)::text,
		'a reused name with nothing old left');
	perform pg_temp.is(pg_temp.versions_at('docs/s.md')::text, '1', 'the new life stays');
	perform pg_temp.w1a_put('w1a-s2-01', 'docs/s2.md', 'w1a s2 old tree');
	perform pg_temp.w1a_del('w1a-s2-02', 'docs/s2.md');
	perform pg_temp.is((pg_temp.w1a_drain((pg_temp.erase(array['docs/s2.md'], 'w1a-s2-member') ->> 'erasureId')::uuid)).state,
		'done', 'the member''s erasure of the deleted name drained');
	perform pg_temp.w1a_put('w1a-s2-03', 'docs/s2.md', 'w1a s2 new tree');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-s2-04', jsonb_build_array(pg_temp.mv('docs/s2.md', 'docs/s3.md'))), 1, 'saved');
	perform pg_temp.is(pg_temp.detail(format('select pg_temp.w1a_ask(%L)',
		pg_temp.w1a_block('docs/s2.md', null, '95000000-0000-4000-8000-0000000000ea')))::text,
		jsonb_build_object('live', 'docs/s3.md', 'life', pg_temp.w1a_life('docs/s2.md'), 'delete', null)::text,
		'and renamed since');
	-- An older life that moved on to a live path is another tree's block: left alone.
	perform pg_temp.w1a_put('w1a-o-01', 'docs/o.md', 'w1a o one');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-o-02', jsonb_build_array(pg_temp.mv('docs/o.md', 'docs/o2.md'))), 1, 'saved');
	perform pg_temp.w1a_put('w1a-o-03', 'docs/o.md', 'w1a o two');
	perform pg_temp.w1a_del('w1a-o-04', 'docs/o.md');
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/o.md', null, '95000000-0000-4000-8000-0000000000e5'));
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '4', 'both lives');
	v := pg_temp.w1a_drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(v.state || pg_temp.versions_at('docs/o.md') || pg_temp.versions_at('docs/o2.md'), 'done01',
		'every life goes; the live path keeps its history');
	-- Another member's private path does not stop the platform's request (a member's is refused).
	perform pg_temp.is(pg_temp.fails(format('select pg_temp.erase(array[%L], %L)', c_private, 'w1a-p-member')), '42501',
		'a member''s request');
	r := pg_temp.w1a_ask(pg_temp.w1a_block(c_private, null, '95000000-0000-4000-8000-0000000000e6'));
	if r ->> 'erasureId' is not null or r -> 'roots' -> 0 ->> 'path' <> c_private then
		raise exception 'Another member''s private path: %', r; end if;
end $$;

-- 10. No run noted: a member's erasure notes the run that wrote a file; a block-history request does not ---------------------

do $$
declare r jsonb; v_member uuid; v_block uuid; v public.qorpera_folder_erasures%rowtype; v_run uuid := '95000000-0000-4000-8000-0000000000f1';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'w1a-r-01', jsonb_build_array(pg_temp.put('docs/r.md', 'w1a r one'),
		pg_temp.put('docs/r2.md', 'w1a r2 one'))), 2, 'saved');
	-- As if Nora's run had saved them (the run does not exist, so a member's erasure waits for it).
	update public.qorpera_folder_commits set actor_kind = 'staff_agent', actor_id = '70700000-0000-4000-8000-0000000000a1',
		run_id = v_run, session_kind = 'in_house'
	where environment_id = '70700000-0000-4000-8000-000000000020' and operation_key = 'w1a-r-01';
	perform pg_temp.w1a_del('w1a-r-02', 'docs/r.md');
	perform pg_temp.w1a_del('w1a-r-03', 'docs/r2.md');
	perform pg_temp.w1a_put('w1a-r-04', 'docs/r.md', 'w1a r rewritten');
	v_member := (pg_temp.erase(array['docs/r2.md'], 'w1a-r-member') ->> 'erasureId')::uuid;
	r := pg_temp.w1a_ask(pg_temp.w1a_block('docs/r.md', pg_temp.w1a_at('docs/r.md'), '95000000-0000-4000-8000-0000000000f2'));
	v_block := (r ->> 'erasureId')::uuid;
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	for i in 1..120 loop
		perform public.qorpera_folder_erasure_step(3, 3, 3);
		if exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = v_block) then
			raise exception 'A block-history request notes no run'; end if;
		select * into v from public.qorpera_folder_erasures where id = v_block;
		exit when v.state <> 'working';
	end loop;
	perform pg_temp.is(v.state, 'done', 'the block-history request is done');
	perform pg_temp.is(pg_temp.versions_at('docs/r.md')::text, '2', 'its versions before the cutoff are gone');
	if not exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = v_member and run_id = v_run) then
		raise exception 'A member''s erasure notes the run: %', (select to_jsonb(e) from public.qorpera_folder_erasures e where id = v_member);
	end if;
end $$;

-- 11. Grants -----------------------------------------------------------------------------------------------------------------

do $$
declare v_fn regprocedure;
begin
	foreach v_fn in array array['public.qorpera_folder_erase_block_history(uuid,uuid,text,jsonb)',
			'public.qorpera_folder_erasure_past_versions(uuid)']::regprocedure[] loop
		if not has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute') then raise exception 'Grants of %', v_fn; end if;
	end loop;
	foreach v_fn in array array['public.qorpera_folder_erasure_moved_live(uuid,text)',
			'public.qorpera_folder_erasure_live_again(uuid,text,text)']::regprocedure[] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('anon', v_fn, 'execute')
			or has_function_privilege('authenticated', v_fn, 'execute') then raise exception 'Grants of %', v_fn; end if;
	end loop;
end $$;

rollback;
