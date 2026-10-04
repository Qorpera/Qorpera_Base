-- @fixture 883_folder_core_erasure.test.sql until "-- 1. Refusals before anything changes"
-- Company folder core, P18d (migration 20260930045000; deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md §2.5, §13):
-- erasing a path erases its conflict copies (P17) with its versions. A copy lies at its commit's position, or after its
-- as_of_seq when the commit saved nothing; a live root keeps its current life's copies; a live root with only copies
-- before its life has something to erase; the copies warning sees copies on both sides; the step deletes them and
-- scrubs the units that named them. On 803's company; rolled back at the end.

create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A write that expects a version (a stale or a missing one) or none at a taken path: a conflict.
create function pg_temp.stale(p_path text, p_text text, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_strip_nulls(jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),'expectedVersion',p_expected))
$$;
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
	if not public.qorpera_folder_object_rooted('70700000-0000-4000-8000-000000000010', v_manifest) then
		raise exception 'Bytes another path still holds stay rooted'; end if;
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

-- 5. The new function's grants and the markers -----------------------------------------------------------------------------

do $$
declare v_fn regprocedure;
begin
	if has_function_privilege('service_role', 'public.qorpera_folder_erasure_copy_before(jsonb,bigint,bigint,integer)', 'execute') then
		raise exception 'No API role runs the copy position'; end if;
	foreach v_fn in array array['public.qorpera_folder_erase(uuid,jsonb,jsonb,text)',
			'public.qorpera_folder_erasure_step(integer,integer,integer)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_fn), '20260930045000') = 0 then raise exception 'Marker in %', v_fn; end if;
	end loop;
end $$;

rollback;
