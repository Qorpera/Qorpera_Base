-- @fixture 961_memory_message_erase_roots.test.sql until "-- 2. Step 1 under the new root"
-- Summary trees M3b (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10, GC; 20260930442000): the prune's regressions, on
-- 961's Nora, whose folder was renamed. Her block is rewritten at its new path; a member copies a partly filled version to
-- reports/, and a write of a later version's bytes to reports/ fails its version check and leaves a conflict copy. Eight
-- days on, the prune keeps the move_in and both copied versions; a message erase then erases the block's lives at both
-- paths and names both copies. Once the copy's path is erased, a version with its bytes is pruned as usual. Rolled back.

create function pg_temp.nora(p_text text) returns text language sql as $$
	select pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(2, 4), pg_temp.line0(3, 5), pg_temp.line0(4, 6),
		pg_temp.line0(5, 7), pg_temp.line(1, 0), pg_temp.line(1, 2), pg_temp.line(2, 0), pg_temp.line(3, 0, p_text)])
$$;
-- A memory commit of Nora's block, saved; its version after it.
create function pg_temp.put(p_key text, p_text text) returns uuid language plpgsql as $$
begin
	perform pg_temp.expect(pg_temp.memory(p_key, jsonb_build_array(pg_temp.block_file('agents/nora-skov/memory/thread/t0/00000000.jsonl',
		p_text, pg_temp.version('agents/nora-skov/memory/thread/t0/00000000.jsonl'))),
		array[pg_temp.thread('70000000-0000-4000-8000-0000000000a1')]), 1, 'saved');
	return pg_temp.version('agents/nora-skov/memory/thread/t0/00000000.jsonl');
end $$;
create function pg_temp.v(p_name text) returns uuid language sql as $$
	select nullif(current_setting('qorpera_test.' || p_name, true), '')::uuid
$$;
create function pg_temp.keep(p_name text, p_version uuid) returns void language sql as $$
	select set_config('qorpera_test.' || p_name, p_version::text, false)
$$;
create function pg_temp.left_of(p_names text[]) returns text[] language sql as $$
	select coalesce(array_agg(n order by o), '{}') from unnest(p_names) with ordinality x(n, o)
	where exists (select 1 from public.qorpera_folder_path_versions v where v.version = pg_temp.v(n))
$$;
create function pg_temp.held() returns text[] language sql as $$
	select coalesce(array_agg(x.n order by x.n), '{}') from public.qorpera_memory_tree_prune_held h
	cross join lateral (select n from unnest(array['w1','w2','w3','x1','x2']) n where pg_temp.v(n) = h.version) x
$$;
create function pg_temp.prune() returns jsonb language sql as $$
	select public.qorpera_memory_tree_prune(2000) - 'schema'
$$;
create function pg_temp.queued(p_manifest text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_object_gc where profile_id = '70000000-0000-4000-8000-000000000010'
		and sha256 = p_manifest)
$$;
-- Ages the folder's versions eight days and starts the prune from the beginning. The upload intents (which root their
-- objects for a day after they end) end with them.
create function pg_temp.age() returns void language plpgsql as $$
begin
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70000000-0000-4000-8000-000000000010';
	update public.qorpera_folder_path_versions set created_at = created_at - interval '8 days'
	where environment_id = '70000000-0000-4000-8000-000000000020';
	update public.qorpera_memory_tree_prune_cursor set created_at = '-infinity', version = '00000000-0000-0000-0000-000000000000';
end $$;

-- 1. The block rewritten three times at its new path; its first rewrite copied to reports/, its second's bytes left there
-- as a conflict copy -----------------------------------------------------------------------------------------------------

do $$
declare
	b constant text := 'agents/nora-skov/memory/thread/t0/00000000.jsonl'; r jsonb; v1 uuid;
begin
	perform pg_temp.service();
	perform pg_temp.keep('mi', pg_temp.version(b));
	perform pg_temp.keep('w1', pg_temp.put('m3b-copies-w1', pg_temp.nora('w1')));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'm3b-copies-copy', jsonb_build_array(jsonb_build_object('op','mkdir','path','reports'),
		jsonb_build_object('op','copy','from',b,'to','reports/w1.jsonl'))), 2, 'saved');
	perform pg_temp.keep('w2', pg_temp.put('m3b-copies-w2', pg_temp.nora('w2')));
	-- A file in reports/ written twice; a write of the second block version's bytes there, expecting its first version.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'm3b-copies-r1', jsonb_build_array(jsonb_build_object('op','write',
		'path','reports/r2.md','file',pg_temp.stage('r2 one')))), 1, 'saved');
	v1 := pg_temp.version('reports/r2.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'm3b-copies-r2', jsonb_build_array(jsonb_build_object('op','write',
		'path','reports/r2.md','file',pg_temp.stage('r2 two'),'expectedVersion',v1))), 1, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'm3b-copies-r3', jsonb_build_array(jsonb_build_object('op','write','path','reports/r2.md',
		'file',pg_temp.stage(pg_temp.nora('w2')),'expectedVersion',v1)));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if (select manifest_sha256 from public.qorpera_folder_conflict_copies where commit_id = (r ->> 'commitId')::uuid)
			is distinct from (select manifest_sha256 from public.qorpera_folder_path_versions where version = pg_temp.v('w2'))
		or (select manifest_sha256 from public.qorpera_folder_entries where environment_id = '70000000-0000-4000-8000-000000000020'
			and key_text = 'reports/w1.jsonl')
			is distinct from (select manifest_sha256 from public.qorpera_folder_path_versions where version = pg_temp.v('w1')) then
		raise exception 'The copy holds the first rewrite''s bytes, the conflict copy the second''s'; end if;
	perform pg_temp.keep('w3', pg_temp.put('m3b-copies-w3', pg_temp.nora('w3')));
	perform set_config('qorpera_test.m_w1', (select manifest_sha256 from public.qorpera_folder_path_versions where version = pg_temp.v('w1')),
		false);
end $$;

select pg_temp.age();
delete from public.qorpera_memory_tree_prune_held;

-- 2. Eight days on, the prune reads the three rewrites: the first replaced the move_in (a life's first version), and the
-- copy and the conflict copy hold the two it replaced ------------------------------------------------------------------

do $$
declare r jsonb := pg_temp.prune();
begin
	if r is distinct from '{"checked":0,"read":3,"pruned":0,"held":2,"released":0,"more":false}'::jsonb then
		raise exception 'The prune: %', r; end if;
	if pg_temp.left_of(array['mi','w1','w2','w3']) is distinct from array['mi','w1','w2','w3']
			or pg_temp.held() is distinct from array['w1','w2'] then
		raise exception 'Kept: the move_in and both copied versions'; end if;
end $$;

-- 3. A message erase erases the block's lives at both paths (961 §2) and names both copies; the copies stay -------------

do $$
declare
	s uuid := pg_temp.thread('70000000-0000-4000-8000-0000000000a1'); eid uuid; r jsonb;
	old constant text := 'agents/nora-dahl/memory/thread/t0/00000000.jsonl'; b constant text := 'agents/nora-skov/memory/thread/t0/00000000.jsonl';
begin
	r := public.qorpera_memory_message_erase_request('70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000001',
		s, (pg_temp.event(s, 7)).event_id);
	eid := (r ->> 'eraseId')::uuid;
	perform pg_temp.same(public.qorpera_memory_message_erase_open('70000000-0000-4000-8000-000000000020', eid) -> 'state', '"open"', 'Step 1');
	perform pg_temp.same(pg_temp.rewrite(eid) -> 'state', '"rewritten"', 'Step 2');
	perform pg_temp.same(pg_temp.ask_all(eid) -> 'state', '"requested"', 'Step 3');
	perform pg_temp.same((select jsonb_agg(c order by c ->> 'path') from (select distinct c from public.qorpera_memory_message_erase_blocks x
			cross join jsonb_array_elements(x.copies) c where x.erase_id = eid) d),
		jsonb_build_array(jsonb_build_object('environmentId', '70000000-0000-4000-8000-000000000020', 'path', 'reports/r2.md', 'live', true),
			jsonb_build_object('environmentId', '70000000-0000-4000-8000-000000000020', 'path', 'reports/w1.jsonl', 'live', true)),
		'The erase names the copy and the conflict copy');
	perform pg_temp.same(jsonb_build_array(pg_temp.versions_at(old), pg_temp.versions_at(b)), '[0, 1]', 'The block''s lives at both paths');
	if pg_temp.left_of(array['mi','w1','w2','w3']) <> '{}' or pg_temp.version('reports/w1.jsonl') is null
			or not exists (select 1 from public.qorpera_folder_conflict_copies where environment_id = '70000000-0000-4000-8000-000000000020'
				and key_text = 'reports/r2.md') then
		raise exception 'The erase takes the held versions; the copies stay'; end if;

	-- The prune drops the held rows of the versions gone.
	r := pg_temp.prune();
	if r is distinct from '{"checked":2,"read":0,"pruned":0,"held":0,"released":0,"more":false}'::jsonb or pg_temp.held() <> '{}' then
		raise exception 'The prune after the erase: %', r; end if;
end $$;

-- 4. The block written again, first with the copy's bytes: held by the copy until the member deletes and erases it (P18),
-- then pruned as usual ----------------------------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.keep('x1', pg_temp.put('m3b-copies-x1', pg_temp.nora('w1')));
	perform pg_temp.keep('x2', pg_temp.put('m3b-copies-x2', pg_temp.nora('x2')));
	if (select manifest_sha256 from public.qorpera_folder_path_versions where version = pg_temp.v('x1'))
			is distinct from current_setting('qorpera_test.m_w1') then
		raise exception 'The same bytes, the same manifest'; end if;
end $$;
select pg_temp.age();

do $$
declare r jsonb := pg_temp.prune(); e jsonb;
begin
	if r - 'read' is distinct from '{"checked":0,"pruned":0,"held":1,"released":0,"more":false}'::jsonb then
		raise exception 'The copy holds the version with its bytes: %', r; end if;
	if pg_temp.held() is distinct from array['x1'] then raise exception 'Held: %', pg_temp.held(); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'm3b-copies-gone', jsonb_build_array(jsonb_build_object('op','delete',
		'path','reports/w1.jsonl','expectedVersion',pg_temp.version('reports/w1.jsonl')))), 1, 'saved');
	e := public.qorpera_folder_erase('70000000-0000-4000-8000-000000000020', pg_temp.owner(), '["reports/w1.jsonl"]', 'm3b-copies-erase');
	perform pg_temp.drain((e ->> 'erasureId')::uuid);
	if (select state from public.qorpera_folder_erasures where id = (e ->> 'erasureId')::uuid) is distinct from 'done'
			or pg_temp.queued(current_setting('qorpera_test.m_w1')) then
		raise exception 'The copy erased, its bytes kept for the block''s version: %', e; end if;
	r := pg_temp.prune();
	if r - 'released' is distinct from '{"checked":1,"read":0,"pruned":1,"held":0,"more":false}'::jsonb
			or (r ->> 'released')::integer < 1 or pg_temp.left_of(array['x1','x2']) is distinct from array['x2'] or pg_temp.held() <> '{}'
			or not pg_temp.queued(current_setting('qorpera_test.m_w1')) then
		raise exception 'Pruned once nothing holds it: %', r; end if;
end $$;

rollback;
