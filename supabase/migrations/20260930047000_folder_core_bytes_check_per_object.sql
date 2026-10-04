-- Company folder core, P24d (from the review of P17; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §4,
-- RUNTIME-COMPANY-FOLDER-CORE.md §9): a file reference's byte check costs the same whatever the company stores.
--
-- qorpera_folder_file_bytes_problem decides each file a write or a new folder references (and each conflict copy P17
-- keeps): every object of the file's proof must be among the objects step 6 locked, and in the catalog with its size.
-- It checked both in one statement over the proof's objects, and each check cost what the company stores:
-- * the catalog lookup was a correlated NOT EXISTS, which the planner hashed: it expects a set-returning function to
--   return 100 rows, so one pass over the company's catalog looked cheaper than 100 probes. Every file read every object
--   the company stores;
-- * the locked test (`= any` over the commit's array of every object it locked) flattened or hashed the whole array for
--   every object.
-- A new folder of 10,000 new files took 87 s (5.3 s for 1,000).
-- * The check walks the proof's objects one by one (a manifest and up to 64 chunks). Locked: a binary search of the
--   array, which the commit sorts collate "C", then a scan only if that misses, so an unsorted array costs time and
--   never changes the answer; outside any statement, so the array is not copied. Then the catalog row, by its primary key.
-- * A new folder's files are checked by qorpera_folder_contents_bytes_problem, a loop the commit calls with its own array:
--   each check reads that array where it is, rather than a copy that a statement would make once per file.
-- The answers are unchanged. No new lock. Each patched body carries the marker 20260930047000.

create function pg_temp.p24d_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P24d anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. One file's check ----------------------------------------------------------------------------------------------------

-- The variables first: PL/pgSQL checks each intermediate body.
select pg_temp.p24d_replace('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])',
	$old$declare v_proof public.qorpera_verified_company_file_objects%rowtype;$old$,
	$new$declare v_proof public.qorpera_verified_company_file_objects%rowtype;
	v_object jsonb; v_sha text; v_low integer; v_high integer; v_mid integer; v_locked boolean; -- P24d (20260930047000)$new$);
select pg_temp.p24d_replace('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])',
	$old$	if exists (select 1 from jsonb_array_elements(v_proof.objects) o
		where not (o ->> 'sha256' = any (p_locked))
			or not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = o ->> 'sha256' and s.bytes = (o ->> 'bytes')::bigint)) then
		return 'bytes_unverified'; end if;$old$,
	$new$	-- P24d (20260930047000): object by object. Locked: a binary search of p_locked (sorted collate "C" by the commit), then
	-- a scan only if it misses; never inside a statement, which would copy the array. Then the catalog row by primary key.
	for v_object in select o from jsonb_array_elements(v_proof.objects) o loop
		v_sha := v_object ->> 'sha256';
		v_low := 1; v_high := coalesce(cardinality(p_locked), 0); v_locked := false;
		while v_low <= v_high and not v_locked loop
			v_mid := (v_low + v_high) / 2;
			if p_locked[v_mid] = v_sha then v_locked := true;
			elsif p_locked[v_mid] collate "C" < v_sha collate "C" then v_low := v_mid + 1;
			else v_high := v_mid - 1; end if;
		end loop;
		if not v_locked and not (v_sha = any (p_locked)) then return 'bytes_unverified'; end if;
		if not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = v_sha and s.bytes = (v_object ->> 'bytes')::bigint) then
			return 'bytes_unverified'; end if;
	end loop;$new$);

-- 2. A new folder's files ------------------------------------------------------------------------------------------------

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
revoke all on function public.qorpera_folder_contents_bytes_problem(uuid, uuid, jsonb, jsonb, jsonb, text[])
	from public, anon, authenticated, service_role;

-- 3. The commit's new folder ---------------------------------------------------------------------------------------------

do $$
declare v_commit regprocedure;
begin
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit') <> 1 then
		raise exception 'P24d expects exactly one qorpera_folder_commit'; end if;
	select oid::regprocedure into v_commit from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit';
	perform pg_temp.p24d_replace(v_commit,
		E'\t\t\telsif exists (select 1 from jsonb_array_elements(v_unit -> ''contents'') c where c.value ->> ''kind'' = ''file''\n'
		|| E'\t\t\t\tand public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,\n'
		|| E'\t\t\t\t\tc.value -> ''file'', v_objects) is not null) then\n',
		E'\t\t\t-- P24d (20260930047000): one call, which checks each file with v_objects as the commit holds it.\n'
		|| E'\t\t\telsif public.qorpera_folder_contents_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,\n'
		|| E'\t\t\t\tv_unit -> ''contents'', v_objects) is not null then\n');
end $$;
