-- Company folder core, P24d (from the review of P17; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §4,
-- RUNTIME-COMPANY-FOLDER-CORE.md §9): the commit's byte checks cost the same whatever the company stores.
--
-- Step 6 locks every object a change set newly references and keeps the array of them (v_objects); a unit is refused
-- bytes_unverified if an object it needs is not among them. Each check cost what the company stores:
-- * qorpera_folder_file_bytes_problem, for each file a write or a new folder references (and each conflict copy P17
--   keeps), checked its proof's objects in one statement. Its catalog lookup was a correlated NOT EXISTS, which the
--   planner hashed (it expects a set-returning function to return 100 rows): every file read every object the company
--   stores. Its locked test (`= any` over the array) flattened or hashed the whole array for every object.
-- * A copy's check (`not (h = any (v_objects))` over the objects it references) flattened the array once per object
--   under a generic plan.
-- A new folder of 10,000 new files took 87 s (5.3 s for 1,000).
-- * qorpera_folder_sorted_position: a binary search of a sorted array. Both checks look an object up with it, and scan
--   only if it misses, so an unsorted array costs time and never changes an answer; never inside a statement, which
--   would copy the array. The commit's array is sorted collate "C" explicitly now (C1d-2's filter kept step 6's order
--   only by how PostgreSQL runs it).
-- * qorpera_folder_file_bytes_problem walks the proof's objects one by one: locked, then the catalog row by primary key.
-- * qorpera_folder_contents_bytes_problem checks a new folder's files and qorpera_folder_unit_objects_unlocked a copy's
--   objects: loops the commit calls with its own array, so each lookup reads that array where it is.
-- The answers are unchanged. No new lock. Each patched body carries the marker 20260930047000.

create function pg_temp.p24d_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P24d anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A sorted array's lookup ---------------------------------------------------------------------------------------------

-- The position of p_value in p_sorted (sorted collate "C", from 1), by binary search; null if it is not found that way.
-- Callers scan the array when it misses: a value an unsorted array holds is then still found.
create function public.qorpera_folder_sorted_position(p_sorted text[], p_value text)
returns integer language plpgsql immutable set search_path = '' as $$
declare v_low integer := 1; v_high integer := coalesce(cardinality(p_sorted), 0); v_mid integer;
begin
	-- P24d (20260930047000). An array a caller holds in a variable reaches here by reference; each subscript is then
	-- constant time.
	while v_low <= v_high loop
		v_mid := (v_low + v_high) / 2;
		if p_sorted[v_mid] = p_value then return v_mid; end if;
		if p_sorted[v_mid] collate "C" < p_value collate "C" then v_low := v_mid + 1; else v_high := v_mid - 1; end if;
	end loop;
	return null;
end $$;

-- 2. One file's check ----------------------------------------------------------------------------------------------------

-- The variables first: PL/pgSQL checks each intermediate body.
select pg_temp.p24d_replace('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])',
	$old$declare v_proof public.qorpera_verified_company_file_objects%rowtype;$old$,
	$new$declare v_proof public.qorpera_verified_company_file_objects%rowtype;
	v_object jsonb; v_sha text; -- P24d (20260930047000)$new$);
select pg_temp.p24d_replace('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])',
	$old$	if exists (select 1 from jsonb_array_elements(v_proof.objects) o
		where not (o ->> 'sha256' = any (p_locked))
			or not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = o ->> 'sha256' and s.bytes = (o ->> 'bytes')::bigint)) then
		return 'bytes_unverified'; end if;$old$,
	$new$	-- P24d (20260930047000): object by object. Locked: the sorted lookup, then a scan only if it misses; never inside a
	-- statement, which would copy p_locked. Then the catalog row by primary key.
	for v_object in select o from jsonb_array_elements(v_proof.objects) o loop
		v_sha := v_object ->> 'sha256';
		if public.qorpera_folder_sorted_position(p_locked, v_sha) is null and not (v_sha = any (p_locked)) then
			return 'bytes_unverified'; end if;
		if not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = v_sha and s.bytes = (v_object ->> 'bytes')::bigint) then
			return 'bytes_unverified'; end if;
	end loop;$new$);

-- 3. A new folder's files, and a copy's objects --------------------------------------------------------------------------

-- The first problem among the files of a new folder's contents (qorpera_folder_file_bytes_problem), or null.
create function public.qorpera_folder_contents_bytes_problem(p_environment_id uuid, p_profile_id uuid, p_actor jsonb,
	p_auth jsonb, p_contents jsonb, p_locked text[])
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_item jsonb; v_problem text;
begin
	-- P24d (20260930047000): a loop, so each check gets p_locked as the caller holds it.
	for v_item in select c from jsonb_array_elements(p_contents) c where c ->> 'kind' = 'file' loop
		v_problem := public.qorpera_folder_file_bytes_problem(p_environment_id, p_profile_id, p_actor, p_auth, v_item -> 'file',
			p_locked);
		if v_problem is not null then return v_problem; end if;
	end loop;
	return null;
end $$;

-- Whether a unit references an object (qorpera_folder_unit_objects) that is not among p_locked.
create function public.qorpera_folder_unit_objects_unlocked(p_environment_id uuid, p_profile_id uuid, p_unit jsonb,
	p_locked text[])
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_hash text;
begin
	-- P24d (20260930047000): the sorted lookup, then a scan only if it misses, outside any statement.
	for v_hash in select h from public.qorpera_folder_unit_objects(p_environment_id, p_profile_id, jsonb_build_array(p_unit)) h loop
		if public.qorpera_folder_sorted_position(p_locked, v_hash) is null and not (v_hash = any (p_locked)) then
			return true; end if;
	end loop;
	return false;
end $$;

revoke all on function public.qorpera_folder_sorted_position(text[], text),
	public.qorpera_folder_contents_bytes_problem(uuid, uuid, jsonb, jsonb, jsonb, text[]),
	public.qorpera_folder_unit_objects_unlocked(uuid, uuid, jsonb, text[])
	from public, anon, authenticated, service_role;

-- 4. The commit ----------------------------------------------------------------------------------------------------------

do $$
declare v_commit regprocedure;
begin
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit') <> 1 then
		raise exception 'P24d expects exactly one qorpera_folder_commit'; end if;
	select oid::regprocedure into v_commit from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit';
	-- The locked array, sorted for the lookups.
	perform pg_temp.p24d_replace(v_commit,
		E'\tselect coalesce(array_agg(s.sha256), ''{}'') into v_objects from unnest(v_objects) s(sha256)\n',
		E'\t-- P24d (20260930047000): sorted collate "C", which the byte checks'' lookups use.\n'
		|| E'\tselect coalesce(array_agg(s.sha256 order by s.sha256 collate "C"), ''{}'') into v_objects from unnest(v_objects) s(sha256)\n');
	-- A new folder's files.
	perform pg_temp.p24d_replace(v_commit,
		E'\t\t\telsif exists (select 1 from jsonb_array_elements(v_unit -> ''contents'') c where c.value ->> ''kind'' = ''file''\n'
		|| E'\t\t\t\tand public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,\n'
		|| E'\t\t\t\t\tc.value -> ''file'', v_objects) is not null) then\n',
		E'\t\t\t-- P24d (20260930047000): one call, which checks each file with v_objects as the commit holds it.\n'
		|| E'\t\t\telsif public.qorpera_folder_contents_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,\n'
		|| E'\t\t\t\tv_unit -> ''contents'', v_objects) is not null then\n');
	-- A copy's objects.
	perform pg_temp.p24d_replace(v_commit,
		E'\t\tif v_ok and v_op = ''copy'' and exists (select 1\n'
		|| E'\t\t\tfrom public.qorpera_folder_unit_objects(p_environment_id, v_file.profile_id, jsonb_build_array(v_unit)) h\n'
		|| E'\t\t\twhere not (h = any (v_objects))) then\n',
		E'\t\t-- P24d (20260930047000): one call, which looks each object up in v_objects as the commit holds it.\n'
		|| E'\t\tif v_ok and v_op = ''copy''\n'
		|| E'\t\t\tand public.qorpera_folder_unit_objects_unlocked(p_environment_id, v_file.profile_id, v_unit, v_objects) then\n');
end $$;
