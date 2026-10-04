-- @fixture 761_folder_core_bytes.test.sql until "-- 1. The version-2 manifest"
-- Company folder core, slice P17: conflict copies on receipts, with their GC root (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-CORE.md §3 step 8, §8). What a write or a new folder that conflicted keeps, and only when its
-- bytes would have passed; the receipt's units unchanged; the root, through the sweep and the claim; reading a copy and
-- committing it again; the replay; the lock text and the grants.

create function pg_temp.copies(p_commit jsonb) returns setof public.qorpera_folder_conflict_copies language sql as $$
	select * from public.qorpera_folder_conflict_copies where commit_id = (p_commit ->> 'commitId')::uuid order by unit_no, file_no
$$;
create function pg_temp.rooted(p_sha text) returns boolean language sql as $$
	select public.qorpera_folder_object_rooted('63400000-0000-4000-8000-000000000010', p_sha)
$$;
-- The live entry at a key, and the folder's last sequence number.
create function pg_temp.entry(p_key text) returns public.qorpera_folder_entries language sql as $$
	select * from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'
$$;
create function pg_temp.write(p_path text, p_file jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('op','write','path',p_path,'file',p_file,'expectedVersion',p_expected)))
$$;
create function pg_temp.claimed(p_result jsonb) returns text[] language sql as $$
	select coalesce(array_agg(o ->> 'sha256' order by o ->> 'sha256'), '{}') from jsonb_array_elements(p_result -> 'objects') o
$$;

-- 1. A write that conflicts keeps its file -------------------------------------------------------------------------------
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_first uuid; v_theirs jsonb; v_mine jsonb; r jsonb; v_copy public.qorpera_folder_conflict_copies;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p17-seed-01', '[{"op":"mkdir","path":"Plans"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-first-01',
		pg_temp.write('Plans/q3.md', pg_temp.stage_v2(pg_temp.member(1), array['first']))), 1, 'saved');
	v_first := (pg_temp.entry('plans/q3.md')).version;
	-- The owner saves a new version; agent A, which read the first, then saves its own over the first.
	v_theirs := pg_temp.stage_v2(pg_temp.member(1), array['theirs']);
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-theirs-01', pg_temp.write('Plans/q3.md', v_theirs, v_first)),
		1, 'saved');
	v_mine := pg_temp.stage_v2(a, array['mine ', 'and more'], 'text/plain', true);
	r := pg_temp.commit(a, 'p17-mine-01', pg_temp.write('plans/Q3.md', v_mine, v_first));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	-- Nothing was saved, so the commit has no seq; the copy is kept all the same, at the path the write would have stored
	-- (its parent's spelling), with the whole file reference.
	select * into v_copy from pg_temp.copies(r);
	if r ->> 'seq' is not null or (select count(*) from pg_temp.copies(r)) <> 1
		or v_copy.environment_id <> c_env or v_copy.unit_no <> 1 or v_copy.file_no <> 1
		or v_copy.path <> 'Plans/Q3.md' or v_copy.key_text <> 'plans/q3.md'
		or v_copy.manifest_sha256 <> v_mine ->> 'manifestSha256' or v_copy.file_sha256 <> v_mine ->> 'fileSha256'
		or v_copy.bytes <> 13 or v_copy.media_type <> 'text/plain' or not v_copy.executable then
		raise exception 'A conflicting write keeps its file: % %', r, to_jsonb(v_copy); end if;
	-- The live file is the owner's, and the receipt's unit has the fields it always had.
	if (pg_temp.entry('plans/q3.md')).manifest_sha256 <> v_theirs ->> 'manifestSha256'
		or (select array_agg(k order by k) from jsonb_object_keys(r -> 'units' -> 0) k) <> array['op','outcome','path','reason','unit'] then
		raise exception 'The live file stays, and the units are unchanged: %', r; end if;

	-- A new file at a path that is taken (no expected version): kept too, beside a unit that saves.
	r := pg_temp.commit(a, 'p17-exists-01', pg_temp.write('Plans/q3.md', pg_temp.stage_v2(a, array['taken'])) ||
		pg_temp.write('Plans/q4.md', pg_temp.stage_v2(a, array['q4'])));
	perform pg_temp.expect(r, 1, 'conflict', 'exists'); perform pg_temp.expect(r, 2, 'saved');
	if r ->> 'seq' is null or (select array_agg(unit_no) from pg_temp.copies(r)) is distinct from array[1]
		or (select manifest_sha256 from pg_temp.copies(r)) is distinct from pg_temp.hash(pg_temp.manifest(array['taken'])) then
		raise exception 'A write onto a taken path keeps its file: %', r; end if;

	-- A file deleted, folder and all, while its writer worked: kept at the path the writer asked for.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p17-gone-01', '[{"op":"mkdir","path":"Gone"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(a, 'p17-gone-02', pg_temp.write('Gone/old.md', pg_temp.stage_v2(a, array['old']))), 1, 'saved');
	v_first := (pg_temp.entry('gone/old.md')).version;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-gone-03', jsonb_build_array(jsonb_build_object('op','delete',
		'path','Gone','expectedVersion',(pg_temp.entry('gone')).version,'asOfSeq',pg_temp.seq()))), 1, 'saved');
	r := pg_temp.commit(a, 'p17-gone-04', pg_temp.write('gone/Old.md', pg_temp.stage_v2(a, array['old, edited']), v_first));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if (select array_agg(path) from pg_temp.copies(r)) is distinct from array['gone/Old.md'] then
		raise exception 'A write to a deleted file keeps its file: %', r; end if;
end $$;

-- 2. A new folder that conflicts keeps every file ------------------------------------------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_one jsonb := pg_temp.stage_v2(a, array['part one']); v_two jsonb := pg_temp.stage_v2(a, array['part two']); r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p17-folder-01',
		'[{"op":"mkdir","path":"Work"},{"op":"mkdir","path":"Work/Report"}]'), 1, 'saved');
	r := pg_temp.commit(a, 'p17-folder-02', jsonb_build_array(jsonb_build_object('op','new_folder','path','work/report','contents',
		jsonb_build_array(jsonb_build_object('kind','folder','path','Parts'),
			jsonb_build_object('kind','file','path','parts/one.md','file',v_one),
			jsonb_build_object('kind','file','path','two.md','file',v_two)))));
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	-- Numbered by their place in the contents, each spelled as the new folder would have stored it.
	if (select jsonb_agg(jsonb_build_array(file_no, path, manifest_sha256) order by file_no) from pg_temp.copies(r))
		is distinct from jsonb_build_array(jsonb_build_array(2, 'Work/report/Parts/one.md', v_one ->> 'manifestSha256'),
			jsonb_build_array(3, 'Work/report/two.md', v_two ->> 'manifestSha256')) then
		raise exception 'A conflicting new folder keeps every file: % %', r, (select jsonb_agg(to_jsonb(c)) from pg_temp.copies(r) c); end if;
end $$;

-- 3. Nothing is kept unless the unit's bytes would have passed -----------------------------------------------------------
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_stale uuid; v_a_only jsonb; v_held jsonb; v_marked jsonb; r jsonb; v_before bigint;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p17-none-01', '[{"op":"mkdir","path":"Kept"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-none-02',
		pg_temp.write('Kept/k.md', pg_temp.stage_v2(pg_temp.member(1), array['k one'])) ||
		jsonb_build_array(jsonb_build_object('op','mkdir','path','Kept/Box'))), 1, 'saved');
	v_stale := (pg_temp.entry('kept/k.md')).version;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-none-03',
		pg_temp.write('Kept/k.md', pg_temp.stage_v2(pg_temp.member(1), array['k two']), v_stale)), 1, 'saved');
	select count(*) into v_before from public.qorpera_folder_conflict_copies;

	-- An actor that does not hold the bytes: agent B names a file only A staged. The conflict is reported as before.
	v_a_only := pg_temp.stage_v2(a, array['only A has this']);
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-04', pg_temp.write('Kept/k.md', v_a_only, v_stale)), 1, 'conflict', 'version_changed');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, v_a_only ->> 'manifestSha256'), '42501');
	-- A reference to bytes the company never stored.
	perform pg_temp.expect(pg_temp.commit(a, 'p17-none-05', pg_temp.write('Kept/k.md', jsonb_build_object('manifestSha256', repeat('c', 64),
		'fileSha256', repeat('d', 64), 'bytes', 1, 'mediaType', 'text/plain', 'executable', false), v_stale)), 1, 'conflict', 'version_changed');
	-- A reference of the wrong shape: no error, no copy.
	perform pg_temp.expect(pg_temp.commit(a, 'p17-none-06', pg_temp.write('Kept/k.md', (pg_temp.stage_v2(a, array['bad shape']))
		|| '{"bytes":"x"}', v_stale)), 1, 'conflict', 'version_changed');
	-- An object GC holds for deletion is not among step 6's locked objects (G1, G3).
	v_marked := pg_temp.stage_v2(a, array['marked chunk']);
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since, lease_id, lease_expires_at)
	values ('63400000-0000-4000-8000-000000000010', pg_temp.hash('marked chunk'), clock_timestamp() - interval '2 days',
		extensions.gen_random_uuid(), clock_timestamp() + interval '10 minutes');
	perform pg_temp.expect(pg_temp.commit(a, 'p17-none-07', pg_temp.write('Kept/k.md', v_marked, v_stale)), 1, 'conflict', 'version_changed');
	delete from public.qorpera_folder_object_gc where profile_id = '63400000-0000-4000-8000-000000000010' and sha256 = pg_temp.hash('marked chunk');
	-- A new folder is kept whole or not at all: one file B does not hold, beside one it does.
	v_held := pg_temp.stage_v2(b, array['b holds this']);
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-08', jsonb_build_array(jsonb_build_object('op','new_folder','path','Kept/Box',
		'contents', jsonb_build_array(jsonb_build_object('kind','file','path','held.md','file',v_held),
			jsonb_build_object('kind','file','path','not-held.md','file',v_a_only))))), 1, 'conflict', 'exists');
	-- Contents the commit would refuse (a duplicate name; a file under a folder the unit does not make).
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-09', jsonb_build_array(jsonb_build_object('op','new_folder','path','Kept/Box',
		'contents', jsonb_build_array(jsonb_build_object('kind','file','path','held.md','file',v_held),
			jsonb_build_object('kind','file','path','HELD.md','file',v_held))))), 1, 'conflict', 'exists');
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-10', jsonb_build_array(jsonb_build_object('op','new_folder','path','Kept/Box',
		'contents', jsonb_build_array(jsonb_build_object('kind','file','path','sub/held.md','file',v_held))))), 1, 'conflict', 'exists');
	-- A file whose key would pass the key bound (2600 bytes), though its path is valid.
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-11', jsonb_build_array(jsonb_build_object('op','new_folder','path','Kept/Box',
		'contents', jsonb_build_array(jsonb_build_object('kind','file','path',repeat('f', 2700) || '.md','file',v_held))))),
		1, 'conflict', 'exists');
	-- A unit refused for any other reason: a viewer's write, and a write under a folder that is not there.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(3), 'p17-none-12', pg_temp.write('Kept/k.md', v_held, v_stale)),
		1, 'denied', 'denied');
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-13', pg_temp.write('Nowhere/n.md', v_held)), 1, 'refused', 'parent_missing');
	-- A copy whose target is taken: its source's bytes are a live file's already.
	perform pg_temp.expect(pg_temp.commit(b, 'p17-none-14', jsonb_build_array(jsonb_build_object('op','copy','from','Kept/k.md',
		'to','Plans/q3.md'))), 1, 'conflict', 'exists');
	if (select count(*) from public.qorpera_folder_conflict_copies) <> v_before then
		raise exception 'Only a unit whose bytes would have passed keeps a copy: %',
			(select jsonb_agg(to_jsonb(c)) from public.qorpera_folder_conflict_copies c); end if;

	-- A reference that disagrees with its own proof is malformed (22023), conflicting or not, and the change set keeps
	-- nothing: the copy of the unit before it goes with it.
	perform pg_temp.raises(format('select pg_temp.commit(%L, %L, %L)', a, 'p17-none-15',
		pg_temp.write('Plans/q3.md', pg_temp.stage_v2(a, array['before it'])) ||
		pg_temp.write('Kept/k.md', pg_temp.stage_v2(a, array['wrong type']) || '{"mediaType":"image/png"}', v_stale)), '22023');
	if (select count(*) from public.qorpera_folder_conflict_copies) <> v_before then
		raise exception 'A change set that raises keeps nothing'; end if;
end $$;

-- 4. The root (core §8), through the sweep and the claim -----------------------------------------------------------------
do $$
declare
	v_manifest text := pg_temp.hash(pg_temp.manifest(array['mine ', 'and more'], 'text/plain', true));
	v_objects text[] := array[v_manifest, pg_temp.hash('mine '), pg_temp.hash('and more')];
	v_lease uuid := extensions.gen_random_uuid(); v_claim jsonb; v_swept integer;
begin
	-- Agent A's sealed intent for its file expired long ago: only the copy roots the manifest and its chunks.
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days' where manifest_sha256 = v_manifest;
	if exists (select 1 from unnest(v_objects) h where not pg_temp.rooted(h))
		or exists (select 1 from public.qorpera_folder_entries where manifest_sha256 = v_manifest)
		or exists (select 1 from public.qorpera_folder_path_versions where manifest_sha256 = v_manifest) then
		raise exception 'A conflict copy roots its manifest and its chunks'; end if;
	-- The sweep removes the intent and records no loss of roots for them.
	v_swept := public.qorpera_folder_sweep_upload_intents(100);
	if v_swept < 1 or exists (select 1 from public.qorpera_folder_upload_intents where manifest_sha256 = v_manifest)
		or exists (select 1 from public.qorpera_folder_object_gc where sha256 = any (v_objects)) then
		raise exception 'The sweep leaves a conflict copy''s objects alone: % % %', v_swept,
			(select jsonb_agg(to_jsonb(i)) from public.qorpera_folder_upload_intents i where manifest_sha256 = v_manifest),
			(select jsonb_agg(to_jsonb(g)) from public.qorpera_folder_object_gc g); end if;
	-- A GC row past grace (left from before the copy) is dropped by the claim, which marks nothing.
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	select '63400000-0000-4000-8000-000000000010', h, clock_timestamp() - interval '2 days' from unnest(v_objects) h;
	v_claim := public.qorpera_folder_claim_object_gc(100, v_lease);
	if v_claim -> 'objects' <> '[]'::jsonb or exists (select 1 from public.qorpera_folder_object_gc where sha256 = any (v_objects)) then
		raise exception 'The claim drops a conflict copy''s objects: %', v_claim; end if;
	-- Once the copy goes (as erasure removes it), nothing roots them, and the claim marks all three.
	delete from public.qorpera_folder_conflict_copies where manifest_sha256 = v_manifest;
	if exists (select 1 from unnest(v_objects) h where pg_temp.rooted(h)) then
		raise exception 'The copy was the root'; end if;
	insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
	select '63400000-0000-4000-8000-000000000010', h, clock_timestamp() - interval '2 days' from unnest(v_objects) h;
	v_claim := public.qorpera_folder_claim_object_gc(100, v_lease);
	if pg_temp.claimed(v_claim) is distinct from (select array_agg(h order by h) from unnest(v_objects) h) then
		raise exception 'Without the copy the claim marks them: %', v_claim; end if;
	update public.qorpera_folder_object_gc set lease_id = null, lease_expires_at = null where sha256 = any (v_objects);
end $$;

-- 5. Reading a copy, and committing it again -----------------------------------------------------------------------------
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	b jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a2', 'human', '63400000-0000-4000-8000-000000000001');
	v_draft jsonb := pg_temp.stage_v2(a, array['a draft ', 'of the memo']); v_second jsonb; v_stale uuid; r jsonb; v_res uuid;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p17-read-01', '[{"op":"mkdir","path":"Memos"}]'), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-read-02',
		pg_temp.write('Memos/memo.md', pg_temp.stage_v2(pg_temp.member(1), array['memo one']))), 1, 'saved');
	v_stale := (pg_temp.entry('memos/memo.md')).version;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p17-read-03',
		pg_temp.write('Memos/memo.md', pg_temp.stage_v2(pg_temp.member(1), array['memo two']), v_stale)), 1, 'saved');
	-- Before the conflict only A, which staged the draft, holds it.
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, v_draft ->> 'manifestSha256'), '42501');
	r := pg_temp.commit(a, 'p17-read-04', pg_temp.write('Memos/memo.md', v_draft, v_stale));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	-- The copy reads as an old version of its path: anyone who may read the path fetches it, manifest and chunk.
	if (pg_temp.download(b, v_draft ->> 'manifestSha256') ->> 'bytes')::bigint
			<> octet_length(convert_to(pg_temp.manifest(array['a draft ', 'of the memo']), 'utf8'))
		or (pg_temp.download(b, pg_temp.hash('of the memo')) ->> 'bytes')::bigint <> 11
		or pg_temp.download(pg_temp.member(3), pg_temp.hash('a draft ')) ->> 'profileId' <> '63400000-0000-4000-8000-000000000010' then
		raise exception 'A conflict copy reads as an old version of its path'; end if;
	-- So it may be committed again by whoever may read it (possession, C1D §3): B saves it as the memo.
	perform pg_temp.expect(pg_temp.commit(b, 'p17-read-05', pg_temp.write('Memos/memo.md', v_draft,
		(pg_temp.entry('memos/memo.md')).version)), 1, 'saved');
	-- A second draft that conflicts is only a copy. Narrowed to agent A, the path's copy is out of B's reach.
	v_second := pg_temp.stage_v2(a, array['a second draft']);
	perform pg_temp.expect(pg_temp.commit(a, 'p17-read-06', pg_temp.write('Memos/memo.md', v_second, v_stale)), 1, 'conflict',
		'version_changed');
	perform pg_temp.download(b, pg_temp.hash('a second draft'));
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'Memos', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
		array['read','write']);
	perform pg_temp.download(a, pg_temp.hash('a second draft'));
	perform pg_temp.download(pg_temp.member(1), v_second ->> 'manifestSha256');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, pg_temp.hash('a second draft')), '42501');
	perform pg_temp.raises(format('select pg_temp.download(%L, %L)', b, v_second ->> 'manifestSha256'), '42501');
end $$;

-- 6. A replay keeps one copy ---------------------------------------------------------------------------------------------
do $$
declare
	a jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000001');
	v_file jsonb := pg_temp.stage_v2(a, array['replayed']); r jsonb; v_again jsonb;
begin
	r := pg_temp.commit(a, 'p17-replay-01', pg_temp.write('Plans/q4.md', v_file));
	perform pg_temp.expect(r, 1, 'conflict', 'exists');
	v_again := pg_temp.commit(a, 'p17-replay-01', pg_temp.write('Plans/q4.md', v_file));
	if not (v_again ->> 'replay')::boolean or v_again ->> 'commitId' <> r ->> 'commitId' or v_again -> 'units' <> r -> 'units'
		or (select count(*) from public.qorpera_folder_conflict_copies where manifest_sha256 = v_file ->> 'manifestSha256') <> 1 then
		raise exception 'A replay answers the receipt and keeps one copy: % %', r, v_again; end if;
end $$;

-- 7. The lock text, the marker and the grants ----------------------------------------------------------------------------
do $$
declare v_fn regprocedure;
begin
	-- Keeping a copy takes no lock of its own: step 6's object locks and the rows' foreign keys are all it holds.
	if (select prosrc from pg_proc where oid = 'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])'::regprocedure)
		~* '(for (update|share|no key update|key share)|nowait|lock_profile_gc_fence|qorpera_folder_fences|lock table)' then
		raise exception 'Keeping a conflict copy takes a lock'; end if;
	foreach v_fn in array array['public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_folder_object_rooted(uuid,text,uuid)', 'public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_fn), '20260930033000') = 0 then
			raise exception 'The P17 marker is missing from %', v_fn; end if;
	end loop;
	if has_function_privilege('service_role', 'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_keep_conflict_copies(uuid,uuid,jsonb,jsonb,uuid,integer,text,jsonb,text[])', 'execute')
		or has_table_privilege('service_role', 'public.qorpera_folder_conflict_copies', 'select')
		or has_table_privilege('authenticated', 'public.qorpera_folder_conflict_copies', 'select')
		or has_function_privilege('service_role', 'public.qorpera_folder_object_rooted(uuid,text,uuid)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)', 'execute') then
		raise exception 'Conflict copies are the folder core''s alone'; end if;
	-- No deferred constraint (core §3 step 9).
	if exists (select 1 from pg_constraint where conrelid = 'public.qorpera_folder_conflict_copies'::regclass and condeferrable) then
		raise exception 'No deferred constraint on conflict copies'; end if;
end $$;

rollback;
