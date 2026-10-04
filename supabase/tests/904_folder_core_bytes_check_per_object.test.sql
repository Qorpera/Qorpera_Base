-- @fixture 634_folder_core_authority.test.sql until "-- Mutators: owners and admins"
-- Company folder core, P24d (migration 20260930047000): the commit's byte checks cost the same whatever the company
-- stores. The patched qorpera_folder_file_bytes_problem answers what the old one answered (rebuilt here by undoing the
-- patch) for the platform, a member and a run, with sorted, unsorted, partial and odd locked arrays, and so do the
-- commit's new loops over a new folder's files and a copy's objects; the sorted lookup finds every element of a sorted
-- array and nothing else; over a catalog of 6,000 objects, under the planner's defaults, the old body read the whole
-- catalog on every call (the hashed shape) and the new one reads a file's own rows, with custom and generic plans; and a
-- new folder of 1,000 new files, and its copy, read the catalog in proportion to their files. 634's fixture, rolled back.

-- 3,000 distinct verified files, as an upload leaves them: a manifest object and one chunk in the catalog, a version-2
-- proof naming both in hash order, and the chunk row. Rows go in directly (staging 3,000 uploads would be most of the
-- test's time).
create temp table bulk_files(n integer primary key, file jsonb not null);
do $$
declare v_profile uuid := '63400000-0000-4000-8000-000000000010';
begin
	set local session_replication_role = replica;
	insert into bulk_files
	select n, jsonb_build_object('manifestSha256', encode(extensions.digest('p24d manifest ' || n, 'sha256'), 'hex'),
		'fileSha256', encode(extensions.digest('p24d chunk ' || n, 'sha256'), 'hex'), 'bytes', 10, 'mediaType', 'text/plain',
		'executable', false)
	from generate_series(1, 3000) n;
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes)
	select v_profile, file ->> 'manifestSha256', 200 from bulk_files
	union all select v_profile, file ->> 'fileSha256', 10 from bulk_files;
	insert into public.qorpera_verified_company_file_objects(profile_id, manifest_sha256, verifier_version, manifest_bytes,
		file_sha256, bytes, media_type, executable, objects)
	select v_profile, file ->> 'manifestSha256', 2, 200, file ->> 'fileSha256', 10, 'text/plain', false,
		(select jsonb_agg(o order by o ->> 'sha256' collate "C") from (values (jsonb_build_object('sha256', file ->> 'manifestSha256', 'bytes', 200)),
			(jsonb_build_object('sha256', file ->> 'fileSha256', 'bytes', 10))) v(o))
	from bulk_files;
	insert into public.qorpera_folder_file_chunks(profile_id, chunk_sha256, manifest_sha256)
	select v_profile, file ->> 'fileSha256', file ->> 'manifestSha256' from bulk_files;
	set local session_replication_role = origin;
	analyze public.qorpera_profile_objects;
	analyze public.qorpera_verified_company_file_objects;
end $$;

-- The old body: the patch undone, as pg_temp.old_bytes_problem.
create function pg_temp.swap(p_text text, p_old text, p_new text) returns text language plpgsql as $$
begin
	if (length(p_text) - length(replace(p_text, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'The patch to undo is not there exactly once: %', left(p_old, 80); end if;
	return replace(p_text, p_old, p_new);
end $$;
do $$
declare v text := pg_get_functiondef('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])'::regprocedure);
begin
	v := pg_temp.swap(v, $new$	-- P24d (20260930047000): object by object. Locked: the sorted lookup, then a scan only if it misses; never inside a
	-- statement, which would copy p_locked. Then the catalog row by primary key.
	for v_object in select o from jsonb_array_elements(v_proof.objects) o loop
		v_sha := v_object ->> 'sha256';
		if public.qorpera_folder_sorted_position(p_locked, v_sha) is null and not (v_sha = any (p_locked)) then
			return 'bytes_unverified'; end if;
		if not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = v_sha and s.bytes = (v_object ->> 'bytes')::bigint) then
			return 'bytes_unverified'; end if;
	end loop;$new$, $old$	if exists (select 1 from jsonb_array_elements(v_proof.objects) o
		where not (o ->> 'sha256' = any (p_locked))
			or not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = o ->> 'sha256' and s.bytes = (o ->> 'bytes')::bigint)) then
		return 'bytes_unverified'; end if;$old$);
	v := pg_temp.swap(v, E'\n\tv_object jsonb; v_sha text; -- P24d (20260930047000)', '');
	v := pg_temp.swap(v, 'FUNCTION public.qorpera_folder_file_bytes_problem(', 'FUNCTION pg_temp.old_bytes_problem(');
	execute v;
end $$;

-- A call's answer, or the SQLSTATE it raised. The actor's authority as the commit passes it: none for the platform, the
-- member itself, a run as qorpera_folder_run_resolve resolves it with the fence's revision.
create function pg_temp.auth(p_actor jsonb) returns jsonb language sql as $$
	select case p_actor ->> 'kind' when 'member' then p_actor
		when 'run' then (public.qorpera_folder_run_resolve('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			p_actor) - 'lockTargets' - 'attribution') || jsonb_build_object('fenceRevision', (select revision from public.qorpera_folder_fences
			where profile_id = '63400000-0000-4000-8000-000000000010')) end
$$;
create function pg_temp.answer(p_old boolean, p_actor jsonb, p_file jsonb, p_locked text[]) returns text language plpgsql as $$
begin
	if p_old then
		return coalesce(pg_temp.old_bytes_problem('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
			p_actor, pg_temp.auth(p_actor), p_file, p_locked), 'ok');
	end if;
	return coalesce(public.qorpera_folder_file_bytes_problem('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010',
		p_actor, pg_temp.auth(p_actor), p_file, p_locked), 'ok');
exception when others then
	return sqlstate;
end $$;
-- The catalog rows this transaction has read so far (sequential and index fetches).
create function pg_temp.catalog_rows() returns bigint language sql as $$
	select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0)::bigint from pg_stat_xact_user_tables
	where relid = 'public.qorpera_profile_objects'::regclass
$$;

-- A. The same answers. Files: one in the folder (the platform writes it at p24d-a/whole.md); one only staged; one whose
-- chunk the catalog lacks; one whose chunk the catalog holds at another size; a reference no proof matches; one whose
-- media type disagrees with its proof (22023). Locked sets: both objects, the manifest only, the chunk only, none, null
-- (the commit never passes null; both bodies then skip the locked check). Actors: the platform, the owner and agent A's
-- run, each with its authority as the commit passes it; then the run again after it sealed the staged file itself.
do $$
declare
	v_profile uuid := '63400000-0000-4000-8000-000000000010';
	v_whole jsonb := (select file from bulk_files where n = 1); v_staged jsonb := (select file from bulk_files where n = 6);
	v_lacking jsonb := (select file from bulk_files where n = 2); v_resized jsonb := (select file from bulk_files where n = 3);
	v_unproven jsonb := jsonb_set((select file from bulk_files where n = 4), '{bytes}', '11');
	v_mistyped jsonb := jsonb_set((select file from bulk_files where n = 5), '{mediaType}', '"text/markdown"');
	v_run jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	v_platform jsonb := '{"kind":"platform"}'; v_file jsonb; v_locked text[]; v_actor jsonb; v_old text; v_new text;
	v_cases integer := 0; v_catalog text[]; v_catalog_unsorted text[]; v_contents jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(v_platform, 'p24d-case-a', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'p24d-a'),
		jsonb_build_object('op', 'write', 'path', 'p24d-a/whole.md', 'file', v_whole))), 2, 'saved');
	set local session_replication_role = replica;
	delete from public.qorpera_folder_file_chunks where profile_id = v_profile and chunk_sha256 = v_lacking ->> 'fileSha256';
	delete from public.qorpera_profile_objects where profile_id = v_profile and sha256 = v_lacking ->> 'fileSha256';
	update public.qorpera_profile_objects set bytes = 12 where profile_id = v_profile and sha256 = v_resized ->> 'fileSha256';
	set local session_replication_role = origin;
	-- The commit's own locked set (every catalog object, sorted collate "C"), and the same set out of order.
	select array_agg(sha256 order by sha256 collate "C"), array_agg(sha256 order by md5(sha256)) into v_catalog, v_catalog_unsorted
	from public.qorpera_profile_objects where profile_id = v_profile;
	for v_file in select unnest(array[v_whole, v_staged, v_lacking, v_resized, v_unproven, v_mistyped]) loop
		for v_locked in select l from (values (array(select x from unnest(array[v_file ->> 'manifestSha256', v_file ->> 'fileSha256']) x order by x collate "C")),
				(array(select x from unnest(array[v_file ->> 'manifestSha256', v_file ->> 'fileSha256']) x order by x collate "C" desc)),
				(array[v_file ->> 'manifestSha256']), (array[v_file ->> 'fileSha256']), ('{}'::text[]), (null::text[]),
				(v_catalog), (v_catalog_unsorted),
				-- Odd arrays the commit never passes: a null element, a duplicate, nulls only, a lower bound of 0.
				(array[null, v_file ->> 'manifestSha256']), (array[v_file ->> 'fileSha256', v_file ->> 'fileSha256', v_file ->> 'manifestSha256']),
				(array[null]::text[]), (('[0:1]={' || (v_file ->> 'manifestSha256') || ',' || (v_file ->> 'fileSha256') || '}')::text[])) x(l) loop
			foreach v_actor in array array[v_platform, pg_temp.member(1), v_run] loop
				v_old := pg_temp.answer(true, v_actor, v_file, v_locked);
				v_new := pg_temp.answer(false, v_actor, v_file, v_locked);
				if v_old is distinct from v_new then
					raise exception 'A: % for %, % locked: the old answer %, the new %', v_actor, v_file, v_locked, v_old, v_new; end if;
				v_cases := v_cases + 1;
			end loop;
		end loop;
	end loop;
	if v_cases <> 216 then raise exception 'A: % cases, expected 216', v_cases; end if;
	-- A copy's check, the old statement against the new loop: a copy of p24d-a (the whole file), with every object locked
	-- (sorted, unsorted), one missing, or none.
	for v_locked in select l from (values (v_catalog), (v_catalog_unsorted), (array_remove(v_catalog, v_whole ->> 'fileSha256')),
			('{}'::text[])) x(l) loop
		v_old := exists (select 1 from public.qorpera_folder_unit_objects('63400000-0000-4000-8000-000000000020', v_profile,
			jsonb_build_array(jsonb_build_object('op', 'copy', 'from', 'p24d-a', 'to', 'p24d-a2'))) h where not (h = any (v_locked)))::text;
		v_new := public.qorpera_folder_unit_objects_unlocked('63400000-0000-4000-8000-000000000020', v_profile,
			jsonb_build_object('op', 'copy', 'from', 'p24d-a', 'to', 'p24d-a2'), v_locked)::text;
		if v_old is distinct from v_new then
			raise exception 'A: a copy''s check with % locked: the old statement %, the loop %', cardinality(v_locked), v_old, v_new; end if;
	end loop;
	if not public.qorpera_folder_unit_objects_unlocked('63400000-0000-4000-8000-000000000020', v_profile,
			jsonb_build_object('op', 'copy', 'from', 'p24d-a', 'to', 'p24d-a2'), array_remove(v_catalog, v_whole ->> 'fileSha256'))
		or public.qorpera_folder_unit_objects_unlocked('63400000-0000-4000-8000-000000000020', v_profile,
			jsonb_build_object('op', 'copy', 'from', 'p24d-a', 'to', 'p24d-a2'), v_catalog) then
		raise exception 'A: a copy''s check finds the one object not locked, and only it'; end if;
	-- The commit's loop over a new folder's files answers as its old statement did: the first file's problem, folders
	-- skipped.
	foreach v_contents in array array[
			jsonb_build_array(jsonb_build_object('path', 'd', 'kind', 'folder'), jsonb_build_object('path', 'd/a.md', 'kind', 'file', 'file', v_whole),
				jsonb_build_object('path', 'b.md', 'kind', 'file', 'file', v_staged)),
			jsonb_build_array(jsonb_build_object('path', 'a.md', 'kind', 'file', 'file', v_whole),
				jsonb_build_object('path', 'b.md', 'kind', 'file', 'file', v_lacking)),
			jsonb_build_array(jsonb_build_object('path', 'd', 'kind', 'folder')), '[]'::jsonb] loop
		foreach v_actor in array array[v_platform, pg_temp.member(1), v_run] loop
			v_old := coalesce((select pg_temp.old_bytes_problem('63400000-0000-4000-8000-000000000020', v_profile, v_actor, pg_temp.auth(v_actor),
				c -> 'file', v_catalog) from jsonb_array_elements(v_contents) c where c ->> 'kind' = 'file'
				and pg_temp.old_bytes_problem('63400000-0000-4000-8000-000000000020', v_profile, v_actor, pg_temp.auth(v_actor), c -> 'file', v_catalog)
					is not null limit 1), 'ok');
			v_new := coalesce(public.qorpera_folder_contents_bytes_problem('63400000-0000-4000-8000-000000000020', v_profile, v_actor,
				pg_temp.auth(v_actor), v_contents, v_catalog), 'ok');
			if v_old is distinct from v_new then
				raise exception 'A: contents % for %: the old statement %, the loop %', v_contents, v_actor, v_old, v_new; end if;
		end loop;
	end loop;
	if public.qorpera_folder_contents_bytes_problem('63400000-0000-4000-8000-000000000020', v_profile, v_platform, null,
			jsonb_build_array(jsonb_build_object('path', 'a.md', 'kind', 'file', 'file', v_whole),
				jsonb_build_object('path', 'b.md', 'kind', 'file', 'file', v_lacking)), v_catalog) is distinct from 'bytes_unverified'
		or public.qorpera_folder_contents_bytes_problem('63400000-0000-4000-8000-000000000020', v_profile, v_platform, null,
			jsonb_build_array(jsonb_build_object('path', 'd', 'kind', 'folder'), jsonb_build_object('path', 'd/a.md', 'kind', 'file', 'file', v_whole)),
			v_catalog) is not null then
		raise exception 'A: the loop over a new folder''s files'; end if;
	-- What the cases answer, for the platform, and for the run before and after it sealed the staged file.
	v_locked := array[v_staged ->> 'manifestSha256', v_staged ->> 'fileSha256'];
	if pg_temp.answer(false, v_platform, v_whole, array[v_whole ->> 'manifestSha256', v_whole ->> 'fileSha256']) <> 'ok'
		or pg_temp.answer(false, v_platform, v_whole, v_catalog) <> 'ok' or pg_temp.answer(false, v_platform, v_whole, v_catalog_unsorted) <> 'ok'
		or pg_temp.answer(false, v_platform, v_staged, v_locked) <> 'ok'
		or pg_temp.answer(false, v_platform, v_staged, array[v_staged ->> 'manifestSha256']) <> 'bytes_unverified'
		or pg_temp.answer(false, v_platform, v_lacking, array[v_lacking ->> 'manifestSha256', v_lacking ->> 'fileSha256']) <> 'bytes_unverified'
		or pg_temp.answer(false, v_platform, v_resized, array[v_resized ->> 'manifestSha256', v_resized ->> 'fileSha256']) <> 'bytes_unverified'
		or pg_temp.answer(false, v_platform, v_unproven, array[v_unproven ->> 'manifestSha256', v_unproven ->> 'fileSha256']) <> 'bytes_unverified'
		or pg_temp.answer(false, v_platform, v_mistyped, array[v_mistyped ->> 'manifestSha256', v_mistyped ->> 'fileSha256']) <> '22023'
		or pg_temp.answer(false, v_run, v_staged, v_locked) <> 'bytes_unverified' then
		raise exception 'A: the answers are not the old rule''s'; end if;
	insert into public.qorpera_folder_upload_intents(environment_id, profile_id, actor_kind, scope_id, manifest_sha256, manifest_text,
		file_sha256, bytes, media_type, executable, state, expires_at, sealed_at)
	select '63400000-0000-4000-8000-000000000020', v_profile, 'run', public.qorpera_folder_upload_scope(v_run),
		v_staged ->> 'manifestSha256', '{}', v_staged ->> 'fileSha256', 10, 'text/plain', false, 'sealed',
		clock_timestamp() + interval '1 hour', clock_timestamp();
	if pg_temp.answer(true, v_run, v_staged, v_locked) <> 'ok' or pg_temp.answer(false, v_run, v_staged, v_locked) <> 'ok' then
		raise exception 'A: a run references what it sealed itself'; end if;
end $$;

-- B. Reads. 300 files with the commit's locked set (every object of the catalog, in hash order). The old body read the
-- company's whole catalog on every call (the planner hashed it, expecting the proof's objects to be 100 rows); the new one
-- reads each file's two rows, with custom plans and with generic ones. The plan cache is reset for each.
create function pg_temp.reads(p_old boolean) returns bigint language plpgsql as $$
declare v_locked text[]; v_rows bigint; v_bad integer;
begin
	select array_agg(sha256 order by sha256 collate "C") into v_locked from public.qorpera_profile_objects
	where profile_id = '63400000-0000-4000-8000-000000000010';
	v_rows := pg_temp.catalog_rows();
	select count(*) into v_bad from bulk_files where n between 101 and 400 and pg_temp.answer(p_old, '{"kind":"platform"}', file, v_locked) <> 'ok';
	if v_bad <> 0 then raise exception 'B: % of 300 whole files refused', v_bad; end if;
	return pg_temp.catalog_rows() - v_rows;
end $$;
create temp table b_reads(body text, plans text, catalog_rows bigint);
set plan_cache_mode = force_custom_plan;
discard plans;
insert into b_reads select 'old', 'custom', pg_temp.reads(true);
insert into b_reads select 'new', 'custom', pg_temp.reads(false);
set plan_cache_mode = force_generic_plan;
discard plans;
insert into b_reads select 'new', 'generic', pg_temp.reads(false);
reset plan_cache_mode;
discard plans;
do $$
begin
	if (select catalog_rows from b_reads where body = 'old') < 300 * 3000 then
		raise exception 'B: the old body must read the catalog on every call here: %', (select jsonb_agg(b) from b_reads b); end if;
	if exists (select 1 from b_reads where body = 'new' and catalog_rows > 300 * 2) then
		raise exception 'B: the new body reads at most a file''s two catalog rows: %', (select jsonb_agg(b) from b_reads b); end if;
end $$;

-- C. A new folder of 1,000 new files, as the platform: the commit reads the catalog in proportion to its files (step 6's
-- lock may scan the catalog once), not 1,000 times. Its copy passes the copy's check against the commit's own array.
do $$
declare v_rows bigint := pg_temp.catalog_rows();
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24d-case-c', jsonb_build_array(jsonb_build_object('op', 'new_folder',
		'path', 'p24d', 'contents', (select jsonb_agg(jsonb_build_object('path', 'f' || n || '.md', 'kind', 'file', 'file', file))
			from bulk_files where n between 1001 and 2000)))), 1, 'saved');
	v_rows := pg_temp.catalog_rows() - v_rows;
	if v_rows > 6000 + 4 * 1000 then
		raise exception 'C: a new folder of 1,000 files read % catalog rows; expected at most 10,000', v_rows; end if;
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p24d-case-c-copy', jsonb_build_array(jsonb_build_object('op', 'copy',
		'from', 'p24d', 'to', 'p24d-copy'))), 1, 'saved');
end $$;

-- D. The sorted lookup: on the company's catalog sorted collate "C", each element's position by binary search alone, and
-- no position for a value it does not hold, a null, or an empty or null array.
do $$
declare v_sorted text[]; v_bad integer;
begin
	select array_agg(sha256 order by sha256 collate "C") into v_sorted from public.qorpera_profile_objects
	where profile_id = '63400000-0000-4000-8000-000000000010';
	select count(*) into v_bad from generate_subscripts(v_sorted, 1) i
	where public.qorpera_folder_sorted_position(v_sorted, v_sorted[i]) is distinct from i;
	if v_bad <> 0 or cardinality(v_sorted) < 5000 then
		raise exception 'D: % of % elements not found at their place', v_bad, cardinality(v_sorted); end if;
	select count(*) into v_bad from generate_series(1, 500) n
	where public.qorpera_folder_sorted_position(v_sorted, encode(extensions.digest('absent ' || n, 'sha256'), 'hex')) is not null;
	if v_bad <> 0 or public.qorpera_folder_sorted_position(v_sorted, null) is not null
		or public.qorpera_folder_sorted_position('{}', v_sorted[1]) is not null
		or public.qorpera_folder_sorted_position(null, v_sorted[1]) is not null then
		raise exception 'D: a value the array does not hold has no position'; end if;
end $$;

-- E. The functions: markers; the helpers are definer-rights (the two that read tables) or pure, with an empty search path,
-- for no API role, and take no lock (761's rule); the commit sorts its array and calls the two loops, not statements.
do $$
declare v_commit text := (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit');
	v_fn record;
begin
	if position('20260930047000' in pg_get_functiondef('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])'::regprocedure)) = 0
		or position('20260930047000' in v_commit) = 0 then
		raise exception 'E: a patched body lacks its marker'; end if;
	for v_fn in select p.oid::regprocedure as f, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prosrc from pg_proc p
		where p.pronamespace = 'public'::regnamespace and p.proname in ('qorpera_folder_sorted_position',
			'qorpera_folder_contents_bytes_problem', 'qorpera_folder_unit_objects_unlocked') loop
		if position('20260930047000' in v_fn.prosrc) = 0 or v_fn.proconfig is distinct from array['search_path=""']
			or v_fn.prosecdef is distinct from (v_fn.proname <> 'qorpera_folder_sorted_position')
			or v_fn.provolatile <> (case when v_fn.proname = 'qorpera_folder_sorted_position' then 'i' else 's' end)
			or has_function_privilege('service_role', v_fn.f, 'execute') or has_function_privilege('authenticated', v_fn.f, 'execute')
			or has_function_privilege('anon', v_fn.f, 'execute')
			or v_fn.prosrc ~* '(for update|for share\M|nowait|for no key update|for key share|lock_profile_gc_fence|qorpera_folder_fences|qorpera_runner_jobs)' then
			raise exception 'E: % is not as P24d makes it', v_fn.f; end if;
	end loop;
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('qorpera_folder_sorted_position',
			'qorpera_folder_contents_bytes_problem', 'qorpera_folder_unit_objects_unlocked')) <> 3 then
		raise exception 'E: the three helpers exist once each'; end if;
	if position('array_agg(s.sha256 order by s.sha256 collate "C")' in v_commit) = 0
		or position('elsif public.qorpera_folder_contents_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,' in v_commit) = 0
		or position('and public.qorpera_folder_unit_objects_unlocked(p_environment_id, v_file.profile_id, v_unit, v_objects) then' in v_commit) = 0
		or position('c.value -> ''file'', v_objects) is not null) then' in v_commit) > 0
		or position('where not (h = any (v_objects))' in v_commit) > 0 then
		raise exception 'E: the commit sorts its array and checks new folders and copies through the loops'; end if;
end $$;

rollback;
