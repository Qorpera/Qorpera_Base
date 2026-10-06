-- Company folder core, slice P17: conflict copies on receipts, with their GC root (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-CORE.md §3 step 8, §8; contract 5.6 item 4: "a conflicting version never overwrites the live
-- file. It is kept as an immutable object on the run's receipt").
-- * A write or new folder whose version check failed keeps each of its files as a row of qorpera_folder_conflict_copies,
--   keyed by its commit (the receipt) and unit, under the path it would have been stored at.
-- * A conflict is decided before the unit's bytes are checked, so a copy is kept only when the whole unit's files would
--   have passed the commit's own byte checks (qorpera_folder_file_bytes_problem with the objects step 6 locked: the
--   proof in the catalog and unmarked, and the actor's possession). Otherwise an unchecked reference would root bytes its
--   actor does not hold.
-- * qorpera_folder_object_rooted counts a conflict copy as a root (core §8), and qorpera_folder_object_readable lets an
--   actor read one as it reads an old version of the path.
-- * The commit's units JSON is unchanged: the clients parse it closed, and erasure scrubs its paths. Erasure deletes a
--   path's conflict copies (the folder GC + erasure session adds that to qorpera_folder_erase).
-- * A commit that saved nothing but kept copies publishes bytes, so it no longer returns early: it passes the anchor
--   step and step 11's authority check under the clock (FOR NO KEY UPDATE), as a saving commit does, and then stops
--   without a seq. A narrowing journaled after it started deciding refuses it, and its copies go with it.
-- No new kind of lock: step 6 already takes every object a write or new folder names FOR KEY SHARE, whatever the
-- outcome; the rows' foreign keys take KEY SHARE on the commit row this transaction inserted and on the clock row the
-- commit row's own foreign key holds; the clock is taken last, as every saving commit takes it. Every patched body
-- carries the marker 20260930042000 for the deploy guard.

set local lock_timeout = '3s';

-- 1. The table -------------------------------------------------------------------------------------------------------

-- One row per kept file: a write's file is file 1, a new folder's files are numbered by their place in its contents.
-- Rows are never updated. Erasure deletes them with their path, and the company's purge with its environment. A copy
-- holds its commit row as a path version does (RESTRICT): removing one without recording when its roots ended (C1D
-- §9.4) would leave its bytes uncollected. The key index serves erasure's cover test, the manifest index the root and
-- read checks.
create table public.qorpera_folder_conflict_copies (
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	commit_id uuid not null references public.qorpera_folder_commits(id) on delete restrict,
	unit_no integer not null check (unit_no >= 1),
	file_no integer not null check (file_no >= 1),
	path text collate "C" not null check (public.qorpera_company_path_valid(path)),
	key_text text collate "C" generated always as (public.qorpera_folder_key(path)) stored,
	manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes >= 0),
	media_type text not null check (media_type ~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'),
	executable boolean not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (commit_id, unit_no, file_no)
);
create index qorpera_folder_conflict_copies_key_text on public.qorpera_folder_conflict_copies(environment_id, key_text);
create index qorpera_folder_conflict_copies_manifest on public.qorpera_folder_conflict_copies(environment_id, manifest_sha256);
alter table public.qorpera_folder_conflict_copies enable row level security;
revoke all on public.qorpera_folder_conflict_copies from public, anon, authenticated, service_role;

-- 2. Keeping them ----------------------------------------------------------------------------------------------------

-- The conflict copies of one unit whose version check failed: a write's file, or every file of a new folder, at the
-- path the unit would have stored it at (p_path, the commit's effective path). Kept only when the whole unit would have
-- passed the commit's checks of its files: for a new folder, contents the commit accepts (no duplicate keys, each kind
-- a file or a folder, each parent a folder inside the unit); file references of the commit's shape; paths within the
-- path bound and keys within the key bound (2600 bytes, which the key index holds); and, in a statement of its own once
-- the references are well formed, qorpera_folder_file_bytes_problem with the objects step 6 locked. Otherwise nothing
-- is kept. Returns how many were kept.
create function public.qorpera_folder_keep_conflict_copies(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_auth jsonb, p_commit_id uuid, p_unit_no integer, p_path text, p_unit jsonb, p_locked text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare v_files jsonb; v_invalid boolean; v_kept integer; v_one jsonb;
begin
	if p_unit ->> 'op' = 'write' then
		v_files := jsonb_build_array(jsonb_build_object('no', 1, 'path', p_path, 'file', p_unit -> 'file'));
	elsif p_unit ->> 'op' = 'new_folder' and jsonb_typeof(p_unit -> 'contents') = 'array' then
		with c as materialized (
			select value ->> 'kind' as kind, public.qorpera_folder_key(value ->> 'path') as key,
				public.qorpera_folder_key(public.qorpera_folder_parent_path(value ->> 'path')) as parent_key
			from jsonb_array_elements(p_unit -> 'contents')
		)
		select exists (select 1 from c group by key having count(*) > 1)
			or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file')
			or exists (select parent_key from c where parent_key is not null except select key from c where kind = 'folder')
		into v_invalid;
		if v_invalid then return 0; end if;
		select coalesce(jsonb_agg(jsonb_build_object('no', s.ord, 'path', s.path, 'file', s.file) order by s.ord), '[]')
		into v_files from public.qorpera_folder_spelled_contents(p_path, p_unit -> 'contents') s where s.kind = 'file';
	else
		return 0;
	end if;
	if exists (select 1 from jsonb_array_elements(v_files) f
		where jsonb_typeof(f -> 'file') is distinct from 'object'
			or jsonb_typeof(f -> 'file' -> 'executable') is distinct from 'boolean'
			or coalesce(f -> 'file' ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
			or coalesce(f -> 'file' ->> 'bytes', '') !~ '^[0-9]{1,15}$'
			or not public.qorpera_company_path_valid(f ->> 'path')
			or octet_length(public.qorpera_folder_key(f ->> 'path')) > 2600) then
		return 0; end if;
	-- One file at a time, as plain PL/pgSQL expressions: the locked set passes by reference, never copied per file.
	for v_one in select value from jsonb_array_elements(v_files) loop
		if public.qorpera_folder_file_bytes_problem(p_environment_id, p_profile_id, p_actor, p_auth, v_one -> 'file', p_locked)
			is not null then
			return 0; end if;
	end loop;
	insert into public.qorpera_folder_conflict_copies(environment_id, commit_id, unit_no, file_no, path, manifest_sha256,
		file_sha256, bytes, media_type, executable)
	select p_environment_id, p_commit_id, p_unit_no, (f ->> 'no')::integer, f ->> 'path', f -> 'file' ->> 'manifestSha256',
		f -> 'file' ->> 'fileSha256', (f -> 'file' ->> 'bytes')::bigint, f -> 'file' ->> 'mediaType',
		(f -> 'file' ->> 'executable')::boolean
	from jsonb_array_elements(v_files) f;
	get diagnostics v_kept = row_count;
	return v_kept;
end $$;

revoke all on function public.qorpera_folder_keep_conflict_copies(uuid, uuid, jsonb, jsonb, uuid, integer, text, jsonb, text[])
	from public, anon, authenticated, service_role;

-- 3. The patches -----------------------------------------------------------------------------------------------------

create function pg_temp.p17_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P17 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The count of kept copies (declared before the patches that use it).
select pg_temp.p17_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_longest_path integer; v_longest_key integer;
$old$,
	$new$	v_longest_path integer; v_longest_key integer;
	v_kept integer := 0; -- 20260930042000 (P17)
$new$);

-- The commit, step 8: after a unit is decided, before its outcome is recorded. Every conflict a write or new folder
-- can have is a failed version check (a changed or missing expected version, or a path already taken).
select pg_temp.p17_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			v_saved := v_saved + 1;
		end if;
$old$,
	$new$			v_saved := v_saved + 1;
		end if;
		-- 20260930042000 (P17): a write or new folder that conflicted keeps its files on the receipt as conflict copies
		-- (core §3 step 8), when its bytes would have passed (qorpera_folder_keep_conflict_copies).
		if not v_ok and v_op in ('write','new_folder') and v_reason in ('version_changed','exists','unseen_change','missing') then
			v_kept := v_kept + public.qorpera_folder_keep_conflict_copies(p_environment_id, v_file.profile_id, p_actor,
				v_auth_actor, v_commit_id, v_no, v_eff_path, v_unit, v_objects);
		end if;
$new$);

-- A commit that saved nothing but kept copies publishes bytes too, so it does not return early: it passes the anchor
-- step and step 11's authority check under the clock, as a saving commit does (a narrowing journaled after it started
-- deciding refuses it, and the copies go with it). Then it stops before the clock moves: it changed no path.
select pg_temp.p17_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_saved = 0 then
		update public.qorpera_folder_commits set units = v_outcomes where id = v_commit_id;
$old$,
	$new$	if v_saved = 0 and v_kept = 0 then -- 20260930042000 (P17): kept copies go on to the checks below
		update public.qorpera_folder_commits set units = v_outcomes where id = v_commit_id;
$new$);
select pg_temp.p17_replace('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	update public.qorpera_folder_clocks set last_seq = v_seq where environment_id = p_environment_id;
$old$,
	$new$	-- 20260930042000 (P17): a commit that kept copies and saved nothing has passed the authority check; it takes no seq.
	if v_saved = 0 then
		update public.qorpera_folder_commits set units = v_outcomes where id = v_commit_id;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',null,'replay',false,
			'units',v_outcomes);
	end if;
	update public.qorpera_folder_clocks set last_seq = v_seq where environment_id = p_environment_id;
$new$);

-- The roots (core §8): a conflict copy's manifest in any folder-v2 environment of the company, and its chunks through
-- the chunk index, as a path version's.
select pg_temp.p17_replace('public.qorpera_folder_object_rooted(uuid,text,uuid)'::regprocedure,
	$old$				or exists (select 1 from public.qorpera_folder_path_versions v
					where v.environment_id = f.environment_id and v.manifest_sha256 = m.manifest))
$old$,
	$new$				or exists (select 1 from public.qorpera_folder_path_versions v
					where v.environment_id = f.environment_id and v.manifest_sha256 = m.manifest)
				-- 20260930042000 (P17): a conflict copy on a receipt.
				or exists (select 1 from public.qorpera_folder_conflict_copies k
					where k.environment_id = f.environment_id and k.manifest_sha256 = m.manifest))
$new$);

-- Reading one: an actor who may read the copy's path now reads it, as it reads an old version of that path. So the
-- writer, or a member, can fetch it and commit it again (its possession check is this one). P24c (20260930039500) checks
-- a few live paths first and then every path that names the object at once; a copy joins that second list.
select pg_temp.p17_replace('public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)'::regprocedure,
	$old$					select v.path from public.qorpera_folder_path_versions v
					where v.environment_id = p_environment_id and v.manifest_sha256 = m.manifest) named)) decided), false);
$old$,
	$new$					select v.path from public.qorpera_folder_path_versions v
					where v.environment_id = p_environment_id and v.manifest_sha256 = m.manifest
					-- 20260930042000 (P17): a conflict copy, read as an old version of its path.
					union all
					select k.path from public.qorpera_folder_conflict_copies k
					where k.environment_id = p_environment_id and k.manifest_sha256 = m.manifest) named)) decided), false);
$new$);

-- The deploy guard: every patched body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array['public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_folder_object_rooted(uuid,text,uuid)', 'public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)']::regprocedure[]
	loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930042000') = 0 then
			raise exception 'P17 did not reach %', v_function; end if;
	end loop;
end $guard$;
