-- Company folder core, slice P18d: erasure of P17's conflict copies (deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md
-- §2.5, §13; P17 is 20260930042000, the coordinator ships both in one release). A conflict copy is a file a write or new
-- folder kept on its receipt when its version check failed, at the path it would have stored (P17). It holds bytes of
-- that path's history as a version does, so erasing a path erases its copies too:
-- * a copy lies at its commit's position (seq, unit); a commit that saved nothing has no seq, and its copies were decided
--   against the folder as of its as_of_seq, so they come after every row of that seq
--   (qorpera_folder_erasure_copy_before). Under a root, a copy before the root's cutoff is erased; a live root's current
--   life keeps its own;
-- * the request counts each root's copies beside its versions (a live root with neither has nothing to erase), and its
--   copies warning also lists the erased copies' manifests and the copies elsewhere that hold an erased manifest;
-- * the step's phase 1 erases them after the versions, in the same budget: their manifests and chunks into the hash
--   table (phase 5 collects what nothing else roots), their root's spellings into the needles, their commits' runs
--   noted for phase 4, then the rows deleted. Commit rows are never deleted, so the copies' RESTRICT key never trips.
-- No new lock. A copy's commit locked its unit's path FOR UPDATE and that path's ancestors KEY SHARE, as a saved unit
-- does, so it serialized with the request's root and ancestor locks (§2.2's argument holds for copies: a new folder's
-- copies under a root lie under the folder's own path, which is the root, an ancestor the request holds KEY SHARE, or a
-- path under the root). Every patched body carries the marker 20260930045000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.p18d_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P18d anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A copy's position ---------------------------------------------------------------------------------------------------

-- Whether a conflict copy lies strictly before a root's cutoff: at its commit's (seq, unit) when the commit saved
-- something; otherwise after every row of the commit's as_of_seq (the state its version check saw).
create function public.qorpera_folder_erasure_copy_before(p_root jsonb, p_seq bigint, p_as_of_seq bigint, p_unit integer)
returns boolean language sql immutable set search_path = '' as $$
	select case when p_seq is not null then public.qorpera_folder_erasure_before(p_root, p_seq, p_unit)
		else public.qorpera_folder_erasure_before(p_root, coalesce(p_as_of_seq, 0), 2147483646) end
$$;
revoke all on function public.qorpera_folder_erasure_copy_before(jsonb, bigint, bigint, integer)
	from public, anon, authenticated, service_role;

-- 2. The request ---------------------------------------------------------------------------------------------------------

select pg_temp.p18d_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$v_counts jsonb := '[]'::jsonb; v_versions bigint; v_copies jsonb;$old$,
	$new$v_counts jsonb := '[]'::jsonb; v_versions bigint; v_copies jsonb; v_conflict bigint;$new$);

-- Each root's copies, counted beside its versions: a live root with neither has nothing to erase.
select pg_temp.p18d_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$			and public.qorpera_folder_erasure_before(v_root, c.seq, v.unit_no);
		if (v_root ->> 'live')::boolean and v_versions = 0 then
			raise exception 'Nothing to erase at %', v_spellings ->> (v_root ->> 'key') using errcode = '22023'; end if;
		v_counts := v_counts || jsonb_build_array(jsonb_build_object('path', v_spellings ->> (v_root ->> 'key'),
			'cutoffSeq', (v_root ->> 'cutoffSeq')::bigint, 'cutoffUnit', (v_root ->> 'cutoffUnit')::integer, 'versions', v_versions));$old$,
	$new$			and public.qorpera_folder_erasure_before(v_root, c.seq, v.unit_no);
		-- 20260930045000 (P18d): and its conflict copies before the cutoff.
		select count(*) into v_conflict from public.qorpera_folder_conflict_copies cc
		join public.qorpera_folder_commits c on c.id = cc.commit_id
		where cc.environment_id = p_environment_id
			and cc.key_text >= (v_root ->> 'key') collate "C" and cc.key_text < ((v_root ->> 'key') || '0') collate "C"
			and public.qorpera_folder_erasure_covers(v_root ->> 'key', cc.key_text)
			and public.qorpera_folder_erasure_copy_before(v_root, c.seq, c.as_of_seq, cc.unit_no);
		if (v_root ->> 'live')::boolean and v_versions = 0 and v_conflict = 0 then
			raise exception 'Nothing to erase at %', v_spellings ->> (v_root ->> 'key') using errcode = '22023'; end if;
		v_counts := v_counts || jsonb_build_array(jsonb_build_object('path', v_spellings ->> (v_root ->> 'key'),
			'cutoffSeq', (v_root ->> 'cutoffSeq')::bigint, 'cutoffUnit', (v_root ->> 'cutoffUnit')::integer, 'versions', v_versions,
			'conflictCopies', v_conflict));$new$);

-- The copies warning (§2.3) with the conflict copies on both sides: the manifests erased with them, and the copies
-- elsewhere that hold an erased manifest.
select pg_temp.p18d_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	select coalesce(jsonb_agg(jsonb_build_object('environmentId', t.environment_id, 'path', t.path, 'live', t.live)
			order by t.environment_id, t.path), '[]'::jsonb) into v_copies
	from (
		select d.environment_id, d.path, exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = d.environment_id and e.key_sha256 = extensions.digest(d.key, 'sha256') and e.kind <> 'claim') as live
		from (
			select distinct on (o.environment_id, public.qorpera_folder_key(o.path)) o.environment_id, o.path,
				public.qorpera_folder_key(o.path) as key
			from (
				select distinct v.manifest_sha256 from jsonb_array_elements(v_roots) r
				join public.qorpera_folder_path_versions v on v.environment_id = p_environment_id
					and public.qorpera_folder_key(v.path) collate "C" >= (r ->> 'key') collate "C"
					and public.qorpera_folder_key(v.path) collate "C" < ((r ->> 'key') || '0') collate "C"
					and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v.path))
				join public.qorpera_folder_commits c on c.id = v.commit_id
				where v.manifest_sha256 is not null and v.bytes > 0 and public.qorpera_folder_erasure_before(r, c.seq, v.unit_no)) m
			join public.qorpera_company_files f on f.profile_id = v_profile and f.core = 'folder-v2'
			join public.qorpera_folder_path_versions o on o.environment_id = f.environment_id and o.manifest_sha256 = m.manifest_sha256
			where not (o.environment_id = p_environment_id and exists (select 1 from jsonb_array_elements(v_roots) r2
				where public.qorpera_folder_erasure_covers(r2 ->> 'key', public.qorpera_folder_key(o.path))))
			order by o.environment_id, public.qorpera_folder_key(o.path), o.created_at desc) d
		order by d.environment_id, d.path
		limit 20) t;
$old$,
	$new$	select coalesce(jsonb_agg(jsonb_build_object('environmentId', t.environment_id, 'path', t.path, 'live', t.live)
			order by t.environment_id, t.path), '[]'::jsonb) into v_copies
	from (
		select d.environment_id, d.path, exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = d.environment_id and e.key_sha256 = extensions.digest(d.key, 'sha256') and e.kind <> 'claim') as live
		from (
			select distinct on (o.environment_id, o.key) o.environment_id, o.path, o.key
			from (
				select distinct v.manifest_sha256 from jsonb_array_elements(v_roots) r
				join public.qorpera_folder_path_versions v on v.environment_id = p_environment_id
					and public.qorpera_folder_key(v.path) collate "C" >= (r ->> 'key') collate "C"
					and public.qorpera_folder_key(v.path) collate "C" < ((r ->> 'key') || '0') collate "C"
					and public.qorpera_folder_erasure_covers(r ->> 'key', public.qorpera_folder_key(v.path))
				join public.qorpera_folder_commits c on c.id = v.commit_id
				where v.manifest_sha256 is not null and v.bytes > 0 and public.qorpera_folder_erasure_before(r, c.seq, v.unit_no)
				-- 20260930045000 (P18d): and the conflict copies erased with them (P17).
				union
				select cc.manifest_sha256 from jsonb_array_elements(v_roots) r
				join public.qorpera_folder_conflict_copies cc on cc.environment_id = p_environment_id
					and cc.key_text >= (r ->> 'key') collate "C" and cc.key_text < ((r ->> 'key') || '0') collate "C"
					and public.qorpera_folder_erasure_covers(r ->> 'key', cc.key_text)
				join public.qorpera_folder_commits c on c.id = cc.commit_id
				where cc.bytes > 0 and public.qorpera_folder_erasure_copy_before(r, c.seq, c.as_of_seq, cc.unit_no)) m
			join public.qorpera_company_files f on f.profile_id = v_profile and f.core = 'folder-v2'
			-- The other holders: versions, and conflict copies (P18d), at paths not under a root here.
			cross join lateral (
				select ov.environment_id, ov.path, public.qorpera_folder_key(ov.path) as key, ov.created_at
				from public.qorpera_folder_path_versions ov where ov.environment_id = f.environment_id and ov.manifest_sha256 = m.manifest_sha256
				union all
				select oc.environment_id, oc.path collate "default", oc.key_text collate "default", oc.created_at
				from public.qorpera_folder_conflict_copies oc
				where oc.environment_id = f.environment_id and oc.manifest_sha256 = m.manifest_sha256) o
			where not (o.environment_id = p_environment_id and exists (select 1 from jsonb_array_elements(v_roots) r2
				where public.qorpera_folder_erasure_covers(r2 ->> 'key', o.key)))
			order by o.environment_id, o.key, o.created_at desc) d
		order by d.environment_id, d.path
		limit 20) t;
$new$);

-- 3. The step ------------------------------------------------------------------------------------------------------------

select pg_temp.p18d_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$v_batch jsonb; v_rows integer := 0;$old$,
	$new$v_batch jsonb; v_rows integer := 0; v_copy_batch jsonb; v_copy_rows integer := 0;$new$);

select pg_temp.p18d_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$			update public.qorpera_folder_erasures set
				first_erased_at = least(coalesce(first_erased_at, 'infinity'::timestamptz),
					coalesce((select min((b ->> 'at')::timestamptz) from jsonb_array_elements(v_batch) b), 'infinity'::timestamptz)),
				phase = case when v_rows < p_versions then 2 else 1 end,
				counts = jsonb_set(counts, '{versions}', to_jsonb(coalesce((counts ->> 'versions')::bigint, 0) + v_rows))
			where id = v_erasure.id;
$old$,
	$new$			-- 20260930045000 (P18d): then, in the same budget, the conflict copies (P17) under each root before its cutoff:
			-- their hashes, their root's spellings and their commits' runs kept, as for versions, then the rows deleted.
			if v_rows < p_versions then
				select coalesce(jsonb_agg(jsonb_build_object('commitId', b.commit_id, 'unit', b.unit_no, 'file', b.file_no,
						'path', b.path, 'manifest', b.manifest_sha256, 'root', b.root)), '[]'::jsonb)
				into v_copy_batch from (
					select cc.commit_id, cc.unit_no, cc.file_no, cc.path, cc.manifest_sha256, r as root
					from jsonb_array_elements(v_erasure.roots) r
					join public.qorpera_folder_conflict_copies cc on cc.environment_id = v_erasure.environment_id
						and cc.key_text >= (r ->> 'key') collate "C" and cc.key_text < ((r ->> 'key') || '0') collate "C"
						and public.qorpera_folder_erasure_covers(r ->> 'key', cc.key_text)
					join public.qorpera_folder_commits c on c.id = cc.commit_id
					where public.qorpera_folder_erasure_copy_before(r, c.seq, c.as_of_seq, cc.unit_no)
					limit p_versions - v_rows) b;
				v_copy_rows := jsonb_array_length(v_copy_batch);
				insert into public.qorpera_folder_erasure_hashes(erasure_id, sha256)
				select distinct v_erasure.id, h from (
					select b ->> 'manifest' as h from jsonb_array_elements(v_copy_batch) b
					union
					select ch.chunk_sha256 from jsonb_array_elements(v_copy_batch) b
					join public.qorpera_folder_file_chunks ch on ch.profile_id = v_erasure.profile_id and ch.manifest_sha256 = b ->> 'manifest'
				) x
				on conflict do nothing;
				insert into public.qorpera_folder_erasure_needles(erasure_id, needle, cutoff_seq, cutoff_unit, cutoff_at)
				select distinct on (n.needle) v_erasure.id, n.needle, (b -> 'root' ->> 'cutoffSeq')::bigint,
					(b -> 'root' ->> 'cutoffUnit')::integer, (b -> 'root' ->> 'cutoffAt')::timestamptz
				from jsonb_array_elements(v_copy_batch) b
				cross join lateral (select array_to_string((string_to_array(b ->> 'path', '/'))
					[1:array_length(string_to_array(b -> 'root' ->> 'key', '/'), 1)], '/') as prefix) p
				cross join lateral (select case when public.qorpera_folder_key(p.prefix) = b -> 'root' ->> 'key' then p.prefix
					else b ->> 'path' end as spelling) w
				cross join lateral (values (w.spelling), (left(w.spelling, 100))) n(needle)
				order by n.needle
				on conflict do nothing;
				insert into public.qorpera_folder_erasure_runs(erasure_id, run_id)
				select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_copy_batch) b
				join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
				on conflict do nothing;
				delete from public.qorpera_folder_conflict_copies cc using jsonb_array_elements(v_copy_batch) b
				where cc.commit_id = (b ->> 'commitId')::uuid and cc.unit_no = (b ->> 'unit')::integer
					and cc.file_no = (b ->> 'file')::integer;
			end if;
			update public.qorpera_folder_erasures set
				first_erased_at = least(coalesce(first_erased_at, 'infinity'::timestamptz),
					coalesce((select min((b ->> 'at')::timestamptz) from jsonb_array_elements(v_batch) b), 'infinity'::timestamptz)),
				phase = case when v_rows + v_copy_rows < p_versions then 2 else 1 end,
				counts = jsonb_set(jsonb_set(counts, '{versions}', to_jsonb(coalesce((counts ->> 'versions')::bigint, 0) + v_rows)),
					'{conflictCopies}', to_jsonb(coalesce((counts ->> 'conflictCopies')::bigint, 0) + v_copy_rows))
			where id = v_erasure.id;
$new$);

-- 4. The deploy guard: every patched body carries the marker ------------------------------------------------------------

do $guard$
declare v_fn regprocedure;
begin
	foreach v_fn in array array['public.qorpera_folder_erase(uuid,jsonb,jsonb,text)',
			'public.qorpera_folder_erasure_step(integer,integer,integer)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_fn), '20260930045000') = 0 then
			raise exception 'P18d did not reach %', v_fn; end if;
	end loop;
end $guard$;
