-- @fixture 883_folder_core_erasure.test.sql until "-- 1. Refusals before anything changes"
-- Company folder core, P18d (migration 20260930045000; deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md §2.5, §13):
-- erasing a path erases its conflict copies (P17) with its versions. A copy lies at its commit's position, or at its
-- commit's time when the commit saved nothing (never its as_of_seq); a live root keeps its current life's copies; a
-- live root with only copies before its life has something to erase; the copies warning sees copies on both sides; the
-- step deletes them by commit, unit and file, scrubs the units that named them, and phase 5 enqueues the bytes nothing
-- else holds. On 803's company; rolled back at the end.

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A write that expects a version (a stale or a missing one) or none at a taken path: a conflict.
create function pg_temp.stale(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_strip_nulls(jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),'expectedVersion',p_expected))
$$;
create function pg_temp.fx2(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;
create function pg_temp.copies_at(p_key text) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_conflict_copies where environment_id = '70700000-0000-4000-8000-000000000020'
		and key_text = p_key
$$;
create function pg_temp.conflict(p_key text, p_unit jsonb) returns jsonb language plpgsql as $$
declare r jsonb := pg_temp.commit(pg_temp.owner(), p_key, jsonb_build_array(p_unit));
begin
	if r -> 'units' -> 0 ->> 'outcome' <> 'conflict' then raise exception 'Expected a conflict: %', r; end if;
	return r;
end $$;

-- 1. A deleted path: its versions and its copy, by a commit that saved nothing ------------------------------------------

do $$
declare r jsonb; c jsonb; v_one uuid; e public.qorpera_folder_erasures; v_manifest text;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-dir', jsonb_build_array(pg_temp.mkdir('cc'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-a-1', jsonb_build_array(pg_temp.put('cc/a.md', 'one'))), 1, 'saved');
	v_one := pg_temp.version('cc/a.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-a-2', jsonb_build_array(pg_temp.put('cc/a.md', 'two'))), 1, 'saved');
	c := pg_temp.conflict('p18d-cc-a-3', pg_temp.stale('cc/a.md', 'mine, kept', v_one));
	v_manifest := (select manifest_sha256 from public.qorpera_folder_conflict_copies where commit_id = (c ->> 'commitId')::uuid);
	if c ->> 'seq' is not null or pg_temp.copies_at('cc/a.md') <> 1 then raise exception 'A copy, kept by a commit with no seq: %', c; end if;
	-- The same bytes saved elsewhere: the copies warning names that path.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-f-1', jsonb_build_array(pg_temp.put('cc/f.md', 'mine, kept'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-a-4', jsonb_build_array(pg_temp.del('cc/a.md'))), 1, 'saved');
	r := pg_temp.erase(array['cc/a.md'], 'erase-cc-a');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'versions', '3', 'the two writes and the delete');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '1', 'and the copy');
	if not r -> 'copies' @> '[{"path":"cc/f.md","live":true}]' then raise exception 'The copy''s bytes, saved elsewhere: %', r; end if;
	e := pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.same(pg_temp.copies_at('cc/a.md')::text, '0', 'the copy is erased');
	perform pg_temp.same(e.counts ->> 'conflictCopies', '1', 'and counted');
	perform pg_temp.same((select units -> 0 ->> 'path' from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid), '',
		'the conflicting change set no longer names the path');
	-- Folder GC does not serve this company yet (§13 runs phase 5 with it on): the copy's bytes wait in the hash table.
	if not exists (select 1 from public.qorpera_folder_erasure_hashes where erasure_id = e.id and sha256 = v_manifest)
		or not e.bytes_pending then
		raise exception 'The copy''s bytes wait for GC: %', to_jsonb(e); end if;
end $$;

-- 2. A live root keeps its current life's copies; a copy before the life is erased --------------------------------------

do $$
declare r jsonb; c1 jsonb; c2 jsonb; v_old uuid;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-b-1', jsonb_build_array(pg_temp.put('cc/b.md', 'b first'))), 1, 'saved');
	v_old := pg_temp.version('cc/b.md');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-b-2', jsonb_build_array(pg_temp.put('cc/b.md', 'b second'))), 1, 'saved');
	c1 := pg_temp.conflict('p18d-cc-b-3', pg_temp.stale('cc/b.md', 'b stale in the first life', v_old));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-b-4', jsonb_build_array(pg_temp.del('cc/b.md'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-b-5', jsonb_build_array(pg_temp.put('cc/b.md', 'b again'))), 1, 'saved');
	-- A stale write in the current life (its version check saw the new life): kept by the erasure.
	c2 := pg_temp.conflict('p18d-cc-b-6', pg_temp.stale('cc/b.md', 'b stale in the second life', v_old));
	r := pg_temp.erase(array['cc/b.md'], 'erase-cc-b');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'versions', '3', 'the first life''s two writes and its delete');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '1', 'the first life''s copy only');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if exists (select 1 from public.qorpera_folder_conflict_copies where commit_id = (c1 ->> 'commitId')::uuid)
		or not exists (select 1 from public.qorpera_folder_conflict_copies where commit_id = (c2 ->> 'commitId')::uuid) then
		raise exception 'The first life''s copy goes, the current life''s stays'; end if;
	perform pg_temp.same((select units -> 0 ->> 'path' from public.qorpera_folder_commits where id = (c2 ->> 'commitId')::uuid),
		'cc/b.md', 'the current life''s conflicting change set keeps the path');
end $$;

-- 3. A live root whose only past is a copy: a write that expected a version at a path that had none ---------------------

do $$
declare r jsonb; c jsonb;
begin
	c := pg_temp.conflict('p18d-cc-c-1', pg_temp.stale('cc/c.md', 'c expected', extensions.gen_random_uuid()));
	if pg_temp.versions_at('cc/c.md') <> 0 or pg_temp.copies_at('cc/c.md') <> 1 then
		raise exception 'A copy at a path that never had a version: %', c; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-c-2', jsonb_build_array(pg_temp.put('cc/c.md', 'c live'))), 1, 'saved');
	r := pg_temp.erase(array['cc/c.md'], 'erase-cc-c');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'versions', '0', 'no version before the life');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '1', 'but a copy');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.same(pg_temp.copies_at('cc/c.md')::text, '0', 'the copy is erased');
	perform pg_temp.same(pg_temp.versions_at('cc/c.md')::text, '1', 'the live file stays');
	-- With neither, a live root still has nothing to erase.
	perform pg_temp.same(pg_temp.message($q$select pg_temp.erase(array['cc/c.md'], 'erase-cc-c-again')$q$),
		'Nothing to erase at cc/c.md', 'nothing left to erase');
end $$;

-- 4. A deleted folder's copies under it; the copies warning sees a copy elsewhere holding erased bytes -------------------

do $$
declare r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-g-1', jsonb_build_array(pg_temp.mkdir('cc/g'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-g-2', jsonb_build_array(pg_temp.put('cc/g/x.md', 'shared bytes'))), 1, 'saved');
	-- A file already at cc/e.md: a new file there conflicts (exists), and keeps the same bytes as cc/g/x.md.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-e-1', jsonb_build_array(pg_temp.put('cc/e.md', 'e live'))), 1, 'saved');
	perform pg_temp.conflict('p18d-cc-e-2', pg_temp.stale('cc/e.md', 'shared bytes'));
	-- And a copy under the folder itself.
	perform pg_temp.conflict('p18d-cc-g-3', pg_temp.stale('cc/g/x.md', 'x stale', extensions.gen_random_uuid()));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-g-4', jsonb_build_array(
		jsonb_build_object('op','delete','path','cc/g','expectedVersion',pg_temp.version('cc/g'),'asOfSeq',pg_temp.seq()))), 1, 'saved');
	r := pg_temp.erase(array['cc/g'], 'erase-cc-g');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '1', 'the copy under the folder');
	if not r -> 'copies' @> '[{"path":"cc/e.md","live":true}]' then
		raise exception 'A conflict copy elsewhere with erased bytes is named: %', r; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.same(pg_temp.copies_at('cc/g/x.md')::text, '0', 'erased with the folder');
	perform pg_temp.same(pg_temp.copies_at('cc/e.md')::text, '1', 'the copy elsewhere stays until named');
end $$;

-- 5. A copy's place is its commit's time, not the clock it read first ---------------------------------------------------------

do $$
declare r jsonb; c jsonb; v_id uuid; e public.qorpera_folder_erasures;
begin
	-- A live file whose only other row is a copy its life already held: the copy's commit read the clock before the life
	-- began (as a commit that lost the race to create the path does), but took the path after it. Nothing to erase.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-h-1', jsonb_build_array(pg_temp.put('cc/h.md', 'h live'))), 1, 'saved');
	c := pg_temp.conflict('p18d-cc-h-2', pg_temp.stale('cc/h.md', 'h lost the race'));
	perform pg_temp.fx2(format($q$update public.qorpera_folder_commits set as_of_seq = as_of_seq - 1 where id = %L$q$, c ->> 'commitId'));
	perform pg_temp.same(pg_temp.message($q$select pg_temp.erase(array['cc/h.md'], 'erase-cc-h')$q$),
		'Nothing to erase at cc/h.md', 'a copy of the current life is no past');
	-- A deleted path: a stale write after the request, before the drain, keeps its copy (the reply counted none).
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-k-1', jsonb_build_array(pg_temp.put('cc/k.md', 'k'))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-k-2', jsonb_build_array(pg_temp.del('cc/k.md'))), 1, 'saved');
	r := pg_temp.erase(array['cc/k.md'], 'erase-cc-k');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '0', 'no copy yet');
	c := pg_temp.conflict('p18d-cc-k-3', pg_temp.stale('cc/k.md', 'k after the request', extensions.gen_random_uuid()));
	e := pg_temp.drain((r ->> 'erasureId')::uuid);
	if not exists (select 1 from public.qorpera_folder_conflict_copies where commit_id = (c ->> 'commitId')::uuid) then
		raise exception 'A copy made after the request stays'; end if;
	perform pg_temp.same((select units -> 0 ->> 'path' from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid),
		'cc/k.md', 'and its change set keeps the path');
end $$;

-- 6. A change set that saves one unit and keeps a copy of another; a new folder's files, one erased -----------------------

do $$
declare r jsonb; c jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-m-1', jsonb_build_array(pg_temp.put('cc/m2.md', 'm2'))), 1, 'saved');
	c := pg_temp.commit(pg_temp.owner(), 'p18d-cc-m-2', jsonb_build_array(pg_temp.put('cc/m1.md', 'm1'),
		pg_temp.stale('cc/m2.md', 'm2 mixed', extensions.gen_random_uuid())));
	perform pg_temp.expect(c, 1, 'saved'); perform pg_temp.expect(c, 2, 'conflict', 'version_changed');
	if c ->> 'seq' is null or not exists (select 1 from public.qorpera_folder_conflict_copies
			where commit_id = (c ->> 'commitId')::uuid and unit_no = 2) then
		raise exception 'A saved change set keeps the copy of its other unit: %', c; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-m-3', jsonb_build_array(pg_temp.del('cc/m2.md'))), 1, 'saved');
	r := pg_temp.erase(array['cc/m2.md'], 'erase-cc-m2');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '1', 'placed at its change set''s seq and unit');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.same(pg_temp.copies_at('cc/m2.md')::text, '0', 'erased');
	perform pg_temp.same(pg_temp.versions_at('cc/m1.md')::text, '1', 'the saved unit''s file stays');
	-- A new folder over a taken path keeps each of its files; erasing one file's path takes that file only.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-n-1', jsonb_build_array(pg_temp.mkdir('cc/n'))), 1, 'saved');
	c := pg_temp.conflict('p18d-cc-n-2', jsonb_build_object('op','new_folder','path','cc/n','contents', jsonb_build_array(
		jsonb_build_object('kind','file','path','a.md','file',pg_temp.stage('n a')),
		jsonb_build_object('kind','file','path','b.md','file',pg_temp.stage('n b')))));
	if (select array_agg(file_no order by file_no) from public.qorpera_folder_conflict_copies where commit_id = (c ->> 'commitId')::uuid)
		<> array[1, 2] then raise exception 'A new folder keeps its two files: %', c; end if;
	r := pg_temp.erase(array['cc/n/a.md'], 'erase-cc-n-a');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'versions', '0', 'a path that never had a version');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '1', 'holds one copy');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if (select array_agg(file_no order by file_no) from public.qorpera_folder_conflict_copies where commit_id = (c ->> 'commitId')::uuid)
		<> array[2] then raise exception 'Only the erased file''s copy goes'; end if;
end $$;

-- 7. Phase 5 with folder GC serving the company: an erased copy's own bytes are enqueued, bytes another copy holds are not --

do $$
declare r jsonb; v_unique text; v_shared text; e public.qorpera_folder_erasures;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-p-1', jsonb_build_array(pg_temp.put('cc/p.md', 'p'),
		pg_temp.put('cc/q.md', 'q'))), 1, 'saved');
	perform pg_temp.conflict('p18d-cc-p-2', pg_temp.stale('cc/p.md', 'p copy, only here'));
	perform pg_temp.conflict('p18d-cc-p-3', pg_temp.stale('cc/p.md', 'p copy, also at q'));
	perform pg_temp.conflict('p18d-cc-p-4', pg_temp.stale('cc/q.md', 'p copy, also at q'));
	select manifest_sha256 into v_unique from public.qorpera_folder_conflict_copies cc join public.qorpera_folder_commits c
		on c.id = cc.commit_id where c.operation_key = 'p18d-cc-p-2';
	select manifest_sha256 into v_shared from public.qorpera_folder_conflict_copies cc join public.qorpera_folder_commits c
		on c.id = cc.commit_id where c.operation_key = 'p18d-cc-p-3';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'p18d-cc-p-5', jsonb_build_array(pg_temp.del('cc/p.md'))), 1, 'saved');
	-- Folder GC serves the company once its other environment is on folder-v2; the staging intents, which root their
	-- objects for a day after they end, are made older than that (as 883 does).
	perform public.qorpera_folder_enable('70700000-0000-4000-8000-000000000022');
	update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 days'
	where profile_id = '70700000-0000-4000-8000-000000000010';
	r := pg_temp.erase(array['cc/p.md'], 'erase-cc-p');
	perform pg_temp.same(r -> 'roots' -> 0 ->> 'conflictCopies', '2', 'both copies at cc/p.md');
	e := pg_temp.drain((r ->> 'erasureId')::uuid);
	if e.state <> 'done' or not exists (select 1 from public.qorpera_folder_object_gc
			where profile_id = '70700000-0000-4000-8000-000000000010' and sha256 = v_unique)
		or exists (select 1 from public.qorpera_folder_object_gc
			where profile_id = '70700000-0000-4000-8000-000000000010' and sha256 = v_shared) then
		raise exception 'Only the bytes nothing else holds are enqueued: %', to_jsonb(e); end if;
end $$;

-- 8. The new function's grants and the markers -----------------------------------------------------------------------------

do $$
declare v_fn regprocedure;
begin
	if has_function_privilege('service_role', 'public.qorpera_folder_erasure_copy_before(jsonb,bigint,timestamptz,integer)', 'execute') then
		raise exception 'No API role runs the copy position'; end if;
	-- A copy's place by its commit's time, not its as_of_seq.
	if public.qorpera_folder_erasure_copy_before('{"cutoffSeq":5,"cutoffUnit":1,"cutoffAt":"2026-10-04T00:00:00Z"}', null,
			'2026-10-04T00:00:01Z', 1)
		or not public.qorpera_folder_erasure_copy_before('{"cutoffSeq":5,"cutoffUnit":1,"cutoffAt":"2026-10-04T00:00:00Z"}', null,
			'2026-10-03T23:59:59Z', 1)
		or not public.qorpera_folder_erasure_copy_before('{"cutoffSeq":5,"cutoffUnit":2,"cutoffAt":"2026-10-04T00:00:00Z"}', 5,
			'2026-10-05T00:00:00Z', 1) then
		raise exception 'The copy position rule'; end if;
	foreach v_fn in array array['public.qorpera_folder_erase(uuid,jsonb,jsonb,text)',
			'public.qorpera_folder_erasure_step(integer,integer,integer)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_fn), '20260930045000') = 0 then raise exception 'Marker in %', v_fn; end if;
	end loop;
end $$;

rollback;
