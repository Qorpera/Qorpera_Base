-- @fixture 961_memory_message_erase_roots.test.sql until "-- 2. Step 1 under the new root"
-- Summary trees M3b (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10, GC; 20260930442000): the 7-day prune of
-- replaced tree versions, on 961's Nora (her folder renamed, so her tree's files start at the new root with a move_in).
-- A block version replaced by a write at least 7 days old is pruned with its bytes. Kept: the current version, one
-- replaced less than 7 days ago, a life's first version (here the move_in), the last version before a delete, both rows
-- of the move, the notebook's versions, and a version a file outside every tree holds, until that file is erased. Then
-- a company being deleted, the erasure step's shared bytes step, and the grants. Rolled back at the end.

create function pg_temp.nora(p_text text) returns text language sql as $$
	select pg_temp.block(array[pg_temp.line0(0, 1), pg_temp.line0(1, 3), pg_temp.line0(2, 4), pg_temp.line0(3, 5), pg_temp.line0(4, 6),
		pg_temp.line0(5, 7), pg_temp.line(1, 0), pg_temp.line(1, 2), pg_temp.line(2, 0), pg_temp.line(3, 0, p_text)])
$$;
-- A memory commit of one unit in Nora's thread, saved; the path's version after it.
create function pg_temp.put(p_key text, p_unit jsonb) returns uuid language plpgsql as $$
begin
	perform pg_temp.expect(pg_temp.memory(p_key, jsonb_build_array(p_unit), array[pg_temp.thread('70000000-0000-4000-8000-0000000000a1')]),
		1, 'saved');
	return pg_temp.version(p_unit ->> 'path');
end $$;
-- A member's commit, each unit saved.
create function pg_temp.member_put(p_key text, p_units jsonb) returns void language plpgsql as $$
declare r jsonb := pg_temp.commit(pg_temp.owner(), p_key, p_units); i integer;
begin
	for i in 1..jsonb_array_length(p_units) loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;
create function pg_temp.v(p_name text) returns uuid language sql as $$
	select nullif(current_setting('qorpera_test.' || p_name, true), '')::uuid
$$;
create function pg_temp.keep(p_name text, p_version uuid) returns void language sql as $$
	select set_config('qorpera_test.' || p_name, p_version::text, false)
$$;
-- Which of these named versions remain.
create function pg_temp.left_of(p_names text[]) returns text[] language sql as $$
	select coalesce(array_agg(n order by o), '{}') from unnest(p_names) with ordinality x(n, o)
	where exists (select 1 from public.qorpera_folder_path_versions v where v.version = pg_temp.v(n))
$$;
create function pg_temp.held() returns text[] language sql as $$
	select coalesce(array_agg(x.n order by x.n), '{}') from public.qorpera_memory_tree_prune_held h
	cross join lateral (select n from unnest(array['b1','b2','b3','b4','t1','t2','c0','c1','c2','n1']) n where pg_temp.v(n) = h.version) x
$$;
create function pg_temp.prune() returns jsonb language sql as $$
	select public.qorpera_memory_tree_prune(2000) - 'schema'
$$;
create function pg_temp.manifest(p_name text) returns text language sql as $$
	select manifest_sha256 from public.qorpera_folder_path_versions where version = pg_temp.v(p_name)
$$;
create function pg_temp.queued(p_manifest text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_object_gc where profile_id = '70000000-0000-4000-8000-000000000010'
		and sha256 = p_manifest)
$$;

-- 1. Nora's tree rewritten: the block four times (its second version copied to reports/ by a member), tree.toml twice, a
-- tier-1 block written three times and deleted, the notebook three times; the block's last write comes last -----------

do $$
declare
	root constant text := 'agents/nora-skov/memory/thread'; old constant text := 'agents/nora-dahl/memory/thread';
	b constant text := root || '/t0/00000000.jsonl'; c constant text := root || '/t1/00000000.jsonl';
	t constant text := root || '/tree.toml'; n constant text := 'agents/nora-skov/memory/profile.md';
begin
	perform pg_temp.service();
	if not public.qorpera_folder_gc_company('70000000-0000-4000-8000-000000000010') then
		raise exception 'Folder GC serves the company'; end if;
	perform pg_temp.keep('mi', pg_temp.version(b)); perform pg_temp.keep('ti', pg_temp.version(t));
	perform pg_temp.keep('a0', (select version from public.qorpera_folder_path_versions where public.qorpera_folder_key(path) = old || '/t0/00000000.jsonl'
		and op = 'write'));
	perform pg_temp.keep('mo', (select version from public.qorpera_folder_path_versions where public.qorpera_folder_key(path) = old || '/t0/00000000.jsonl'
		and op = 'move_out'));
	if (select array_agg(op order by created_at) from public.qorpera_folder_path_versions where version in (pg_temp.v('mi'), pg_temp.v('ti'),
			pg_temp.v('a0'), pg_temp.v('mo'))) is distinct from array['write','move_in','move_in','move_out'] then
		raise exception 'The rename: a block and tree.toml start at the new root with a move_in: %', (select jsonb_agg(jsonb_build_array(path, op,
			created_at, version, prior_version) order by created_at) from public.qorpera_folder_path_versions
			where environment_id = '70000000-0000-4000-8000-000000000020' and path like 'agents/nora%'); end if;
	perform pg_temp.keep('b1', pg_temp.put('m3b-prune-b1', pg_temp.block_file(b, pg_temp.nora('b1'), pg_temp.version(b))));
	perform pg_temp.keep('b2', pg_temp.put('m3b-prune-b2', pg_temp.block_file(b, pg_temp.nora('b2'), pg_temp.version(b))));
	perform pg_temp.member_put('m3b-prune-copy', jsonb_build_array(jsonb_build_object('op','mkdir','path','reports'),
		jsonb_build_object('op','mkdir','path','reports/m3b'), jsonb_build_object('op','copy','from',b,'to','reports/m3b/b2.jsonl')));
	if (select manifest_sha256 from public.qorpera_folder_entries where environment_id = '70000000-0000-4000-8000-000000000020'
			and key_text = 'reports/m3b/b2.jsonl') is distinct from pg_temp.manifest('b2') then
		raise exception 'The copy holds the second version''s bytes'; end if;
	perform pg_temp.keep('b3', pg_temp.put('m3b-prune-b3', pg_temp.block_file(b, pg_temp.nora('b3'), pg_temp.version(b))));
	perform pg_temp.keep('t1', pg_temp.put('m3b-prune-t1', pg_temp.toml_file(t, pg_temp.toml(pg_temp.thread('70000000-0000-4000-8000-0000000000a1'), 512),
		pg_temp.version(t))));
	perform pg_temp.keep('t2', pg_temp.put('m3b-prune-t2', pg_temp.toml_file(t, pg_temp.toml(pg_temp.thread('70000000-0000-4000-8000-0000000000a1'), 256),
		pg_temp.version(t))));
	perform pg_temp.put('m3b-prune-t1-dir', jsonb_build_object('op','mkdir','path',root || '/t1'));
	perform pg_temp.keep('c0', pg_temp.put('m3b-prune-c0', pg_temp.block_file(c, pg_temp.block(array[pg_temp.line(4, 0, 'c0')]))));
	perform pg_temp.keep('c1', pg_temp.put('m3b-prune-c1', pg_temp.block_file(c, pg_temp.block(array[pg_temp.line(4, 0, 'c1')]), pg_temp.version(c))));
	perform pg_temp.keep('c2', pg_temp.put('m3b-prune-c2', pg_temp.block_file(c, pg_temp.block(array[pg_temp.line(4, 0, 'c2')]), pg_temp.version(c))));
	perform pg_temp.expect(pg_temp.memory('m3b-prune-c-del', jsonb_build_array(jsonb_build_object('op','delete','path',c,'expectedVersion',
		pg_temp.version(c))), array[pg_temp.thread('70000000-0000-4000-8000-0000000000a1')]), 1, 'saved');
	perform pg_temp.member_put('m3b-prune-n0', jsonb_build_array(jsonb_build_object('op','write','path',n,'file',pg_temp.stage('n0'))));
	perform pg_temp.keep('n0', pg_temp.version(n));
	perform pg_temp.member_put('m3b-prune-n1', jsonb_build_array(jsonb_build_object('op','write','path',n,'file',pg_temp.stage('n1'),
		'expectedVersion',pg_temp.version(n))));
	perform pg_temp.keep('n1', pg_temp.version(n));
	perform pg_temp.member_put('m3b-prune-n2', jsonb_build_array(jsonb_build_object('op','write','path',n,'file',pg_temp.stage('n2'),
		'expectedVersion',pg_temp.version(n))));
	perform pg_temp.keep('b4', pg_temp.put('m3b-prune-b4', pg_temp.block_file(b, pg_temp.nora('b4'), pg_temp.version(b))));
	if pg_temp.left_of(array['mi','b1','b2','b3','b4','ti','t1','t2','c0','c1','c2','n0','n1']) is distinct from
			array['mi','b1','b2','b3','b4','ti','t1','t2','c0','c1','c2','n0','n1'] then
		raise exception 'The versions are written'; end if;
end $$;

-- Eight days pass, six for the block's last write; the fixture's upload intents (which root their objects for a day after
-- they end) end with them. The prune starts from the beginning.
update public.qorpera_folder_path_versions set created_at = created_at - interval '8 days'
where environment_id = '70000000-0000-4000-8000-000000000020' and version <> pg_temp.v('b4');
update public.qorpera_folder_path_versions set created_at = created_at - interval '6 days' where version = pg_temp.v('b4');
update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
where profile_id = '70000000-0000-4000-8000-000000000010';
update public.qorpera_memory_tree_prune_cursor set created_at = '-infinity', version = '00000000-0000-0000-0000-000000000000';
delete from public.qorpera_memory_tree_prune_held;

-- 2. The first prune reads the seven later writes old enough. It prunes the version each replaced, except a life's first
-- version (the move_in, the tier-1 block's first write), and holds the block's second version, which the reports/ copy
-- holds. The block's third version stays: the write that replaced it is six days old. The bytes go to the GC queue. ----

do $$
declare r jsonb; n text;
begin
	foreach n in array array['b1','b2','b3','t1','c1'] loop
		perform set_config('qorpera_test.m_' || n, pg_temp.manifest(n), false); end loop;
	r := pg_temp.prune();
	if r - 'released' is distinct from '{"checked":0,"read":7,"pruned":3,"held":1,"more":false}'::jsonb
			or (r ->> 'released')::integer < 3 then
		raise exception 'The first prune: %', r; end if;
	if pg_temp.left_of(array['mi','b1','b2','b3','b4','ti','t1','t2','c0','c1','c2','n0','n1','a0','mo'])
			is distinct from array['mi','b2','b3','b4','ti','t2','c0','c2','n0','n1','a0','mo'] then
		raise exception 'Pruned: the replaced versions, not the kept ones: %',
			pg_temp.left_of(array['mi','b1','b2','b3','b4','ti','t1','t2','c0','c1','c2','n0','n1','a0','mo']); end if;
	if (select count(*) from public.qorpera_folder_path_versions where environment_id = '70000000-0000-4000-8000-000000000020'
			and public.qorpera_folder_key(path) = 'agents/nora-skov/memory/thread/t1/00000000.jsonl' and op = 'delete') <> 1 then
		raise exception 'The delete stays'; end if;
	if pg_temp.held() is distinct from array['b2'] then raise exception 'Held: %', pg_temp.held(); end if;
	if not pg_temp.queued(current_setting('qorpera_test.m_b1')) or not pg_temp.queued(current_setting('qorpera_test.m_t1'))
			or not pg_temp.queued(current_setting('qorpera_test.m_c1')) or pg_temp.queued(current_setting('qorpera_test.m_b2'))
			or pg_temp.queued(current_setting('qorpera_test.m_b3')) then
		raise exception 'The pruned versions'' bytes are queued, the held and kept ones'' not'; end if;
	if (select (created_at, version) from public.qorpera_memory_tree_prune_cursor)
			is distinct from (select (created_at, version) from public.qorpera_folder_path_versions where version in (pg_temp.v('b1'),
				pg_temp.v('b2'), pg_temp.v('b3'), pg_temp.v('t1'), pg_temp.v('t2'), pg_temp.v('c1'), pg_temp.v('c2'))
			order by created_at desc, version desc limit 1) then
		raise exception 'The cursor stops at the last write read'; end if;

	-- The second checks the held version again and reads nothing new.
	r := pg_temp.prune();
	if r is distinct from '{"checked":1,"read":0,"pruned":0,"held":0,"released":0,"more":false}'::jsonb then
		raise exception 'The second prune: %', r; end if;
	if pg_temp.held() is distinct from array['b2'] or pg_temp.left_of(array['b2','b3']) is distinct from array['b2','b3'] then
		raise exception 'The held version stays held'; end if;
end $$;


-- 3. Two more days: the block's last write is now old enough, and the third prune prunes the version it replaced. ---------

update public.qorpera_folder_path_versions set created_at = created_at - interval '2 days' where version = pg_temp.v('b4');

do $$
declare r jsonb;
begin
	r := pg_temp.prune();
	if r - 'released' is distinct from '{"checked":1,"read":1,"pruned":1,"held":0,"more":false}'::jsonb
			or (r ->> 'released')::integer < 1 then
		raise exception 'The third prune: %', r; end if;
	if pg_temp.left_of(array['mi','b2','b3','b4']) is distinct from array['mi','b2','b4'] or pg_temp.held() is distinct from array['b2']
			or not pg_temp.queued(current_setting('qorpera_test.m_b3')) then
		raise exception 'The third version is pruned, the second still held'; end if;
end $$;

-- 4. The member deletes the copy and erases it (P18). Its history goes, so nothing holds the block's second version: the
-- fourth prune checks it, prunes it, and queues its bytes (the erasure kept them while the tree version rooted them). ------

do $$
declare r jsonb;
begin
	perform pg_temp.member_put('m3b-prune-copy-gone', jsonb_build_array(jsonb_build_object('op','delete','path','reports/m3b/b2.jsonl',
		'expectedVersion',pg_temp.version('reports/m3b/b2.jsonl'))));
	r := public.qorpera_folder_erase('70000000-0000-4000-8000-000000000020', pg_temp.owner(), '["reports/m3b/b2.jsonl"]', 'm3b-prune-erase-copy');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if (select state from public.qorpera_folder_erasures where id = (r ->> 'erasureId')::uuid) is distinct from 'done'
			or exists (select 1 from public.qorpera_folder_path_versions where environment_id = '70000000-0000-4000-8000-000000000020'
				and public.qorpera_folder_key(path) = 'reports/m3b/b2.jsonl')
			or pg_temp.queued(current_setting('qorpera_test.m_b2')) then
		raise exception 'The copy is erased, its bytes kept for the tree''s version: %', r; end if;
	r := pg_temp.prune();
	if r - 'released' is distinct from '{"checked":1,"read":0,"pruned":1,"held":0,"more":false}'::jsonb
			or (r ->> 'released')::integer < 1 then
		raise exception 'The fourth prune: %', r; end if;
	if pg_temp.left_of(array['mi','b2','b4']) is distinct from array['mi','b4'] or pg_temp.held() <> '{}'
			or not pg_temp.queued(current_setting('qorpera_test.m_b2')) then
		raise exception 'The second version is pruned once nothing holds it'; end if;
end $$;

-- 5. A company being deleted is passed over: the prune reads its later writes and prunes none, and drops its held rows
-- (the deletion purges the folder). ---------------------------------------------------------------------------------------

do $$
declare r jsonb;
begin
	perform pg_temp.keep('b5', pg_temp.put('m3b-prune-b5', pg_temp.block_file('agents/nora-skov/memory/thread/t0/00000000.jsonl',
		pg_temp.nora('b5'), pg_temp.version('agents/nora-skov/memory/thread/t0/00000000.jsonl'))));
	update public.qorpera_folder_path_versions set created_at = created_at - interval '8 days' where version = pg_temp.v('b5');
	insert into public.qorpera_memory_tree_prune_held(version, environment_id, profile_id)
	values (pg_temp.v('b4'), '70000000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000010');
	set local session_replication_role = replica;
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('70000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000001');
	set local session_replication_role = origin;
	r := pg_temp.prune();
	if r is distinct from '{"checked":1,"read":1,"pruned":0,"held":0,"released":0,"more":false}'::jsonb then
		raise exception 'A company being deleted: %', r; end if;
	if pg_temp.left_of(array['b4','b5']) is distinct from array['b4','b5'] or exists (select 1 from public.qorpera_memory_tree_prune_held)
			or (select version from public.qorpera_memory_tree_prune_cursor) is distinct from pg_temp.v('b5') then
		raise exception 'Passed over: nothing pruned, the held row dropped, the cursor past its write'; end if;
end $$;

-- 6. P18's phase 5 calls the shared bytes step; the grants. ----------------------------------------------------------------

do $$
declare v_fn regprocedure; v_role text;
begin
	if pg_get_functiondef('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure)
			not like '%perform public.qorpera_folder_object_release(v_erasure.profile_id, v_hashes);%'
		or pg_get_functiondef('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure)
			like '%insert into public.qorpera_folder_object_gc%' then
		raise exception 'Phase 5 releases bytes through qorpera_folder_object_release'; end if;
	foreach v_fn in array array['public.qorpera_memory_tree_prune(integer)', 'public.qorpera_memory_tree_version_held(uuid,text)',
		'public.qorpera_folder_object_release(uuid,text[])', 'public.qorpera_schedule_memory_tree_prune()']::regprocedure[] loop
		-- The schedule runs as the migration's owner, as the other schedules do.
		if (select prosecdef from pg_proc where oid = v_fn) is distinct from (v_fn <> 'public.qorpera_schedule_memory_tree_prune()'::regprocedure) then
			raise exception '% security definer, the schedule not', v_fn; end if;
		foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
			if (v_role = 'public' and exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
					where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE'))
				or (v_role <> 'public' and has_function_privilege(v_role, v_fn, 'execute')) then
				raise exception '% runs for %', v_fn, v_role; end if;
		end loop;
	end loop;
	if exists (select 1 from pg_class where oid in ('public.qorpera_memory_tree_prune_cursor'::regclass,
			'public.qorpera_memory_tree_prune_held'::regclass) and not relrowsecurity) then
		raise exception 'Row level security on the prune''s tables'; end if;
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		if has_table_privilege(v_role, 'public.qorpera_memory_tree_prune_cursor', 'select,insert,update,delete')
				or has_table_privilege(v_role, 'public.qorpera_memory_tree_prune_held', 'select,insert,update,delete') then
			raise exception 'The prune''s tables are closed to %', v_role; end if;
	end loop;
end $$;

rollback;
