-- 20260930446300: step 5b, part 3 of 4: git's leases and publish on the folder (deploy/first-node/RUNTIME-FOLDER-CODING-
-- MACHINES.md, "Code areas and git"; RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount", as amended there).
-- git takes a shared file X (refs/**, packed-refs, shallow) by creating X.lock and publishes it by renaming X.lock over X.
-- The folder program (step 5d) maps them to these calls, which take a coding session's or a code host's view:
-- 1. qorpera_folder_git_lease_take: the lease on X. A lease is a row, never an entry; it lives as long as its view (renew
--    keeps it, a close or an expiry ends it). Another view's live lease answers 'busy'; a rule answers 'refused', and
--    a session takes no lease on another worker's branch, refs/heads/qorpera/coding/<workerId> ('git_other_worker').
-- 2. qorpera_folder_git_publish: one commit of the session's objects, then X and its reflog logs/X, which land together
--    or not at all. The commit lets the lease's own X and logs/X through 'git_lease_required', and if either one's
--    version moved, both are 'version_changed'. The version check is the correctness rule; the lease only spares a lost
--    race. Missing folders above each unit are made first. A publish ends the lease.
-- 3. qorpera_folder_git_lease_release (X.lock unlinked, perhaps publishing a delete or a reflog) and
--    qorpera_folder_git_leases_drop (a command's end: every lease the view holds).
-- 4. qorpera_folder_git_gc_begin and _end: a code host's block on a repository's new leases while git gc runs.
-- Every patched body names this migration (20260930446300), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.s5b_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5b anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. Leases. -----------------------------------------------------------------------------------------------------------

-- A lease on a shared file ('file'), or a code host's block on a repository's new leases while gc runs ('maintenance',
-- keyed on the repository's repo.git). Its holder's view is its clock: a lease whose view is no longer valid counts for
-- nothing, and the next take on its key deletes it.
create table public.qorpera_folder_git_leases (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	view_id uuid not null references public.qorpera_folder_views(id) on delete cascade,
	kind text not null check (kind in ('file','maintenance')),
	path text not null,
	key_sha256 bytea not null,
	repository_key text not null,
	created_at timestamptz not null default clock_timestamp(),
	unique (environment_id, key_sha256)
);
create index qorpera_folder_git_leases_view on public.qorpera_folder_git_leases(view_id);
create index qorpera_folder_git_leases_repository on public.qorpera_folder_git_leases(environment_id, repository_key);
alter table public.qorpera_folder_git_leases enable row level security;
revoke all on public.qorpera_folder_git_leases from public, anon, authenticated, service_role;

-- The view a git call names: a coding session's or a code host's, valid, and locked as the commit locks it.
create function public.qorpera_folder_git_view(p_environment_id uuid, p_actor jsonb)
returns public.qorpera_folder_views language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_view public.qorpera_folder_views%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'view' then
		raise exception 'Folder git calls take a view' using errcode = '42501'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_folder_view_resolve(p_environment_id, v_profile, p_actor);
	select * into v_view from public.qorpera_folder_views where id = (p_actor ->> 'viewId')::uuid for key share;
	if not coalesce(public.qorpera_folder_view_valid(v_view), false) then raise exception 'Folder view has ended' using errcode = '42501'; end if;
	if v_view.kind not in ('coding_session','code_host') then
		raise exception 'Folder git calls take a coding or code host view' using errcode = '42501'; end if;
	return v_view;
end $$;

-- A repository's key (code/<owner>/<name>) when p_key is a shared file in its repo.git, X of a lease; else null.
create function public.qorpera_folder_git_shared_repository(p_key text)
returns text language sql immutable set search_path = '' as $$
	select case when p_key ~ '^code/[^/]+/[^/]+/repo\.git/(packed-refs|shallow|refs/.+)$'
		then substring(p_key from '^(code/[^/]+/[^/]+)/repo\.git/') end
$$;

-- X's reflog key: logs/ before X's name in its repo.git.
create function public.qorpera_folder_git_reflog_key(p_key text)
returns text language sql immutable set search_path = '' as $$
	select regexp_replace(p_key, '^(code/[^/]+/[^/]+/repo\.git)/', '\1/logs/')
$$;

-- A file's version as text, or null when no file is at the key.
create function public.qorpera_folder_git_version(p_environment_id uuid, p_key text)
returns text language sql stable security definer set search_path = '' as $$
	select version::text from public.qorpera_folder_entries
	where environment_id = p_environment_id and key_sha256 = extensions.digest(p_key, 'sha256') and kind = 'file'
$$;

-- A repository's leases and its gc block are taken one way round: take holds this lock shared, gc_begin exclusive.
create function public.qorpera_folder_git_repository_lock(p_environment_id uuid, p_repository text, p_exclusive boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if p_exclusive then
		perform pg_advisory_xact_lock(hashtextextended('qorpera.folder-git:' || p_environment_id::text || ':' || p_repository, 0));
	else
		perform pg_advisory_xact_lock_shared(hashtextextended('qorpera.folder-git:' || p_environment_id::text || ':' || p_repository, 0));
	end if;
end $$;

-- 2. Take. -------------------------------------------------------------------------------------------------------------

-- The lease on X, a shared file in a repo.git (p_path is X, not X.lock). Held: the lease, with the versions git reads
-- under it (X, its reflog logs/X, packed-refs; null when no file is there). Busy: another valid view holds X, or a
-- code host's gc blocks the repository's new leases ('maintenance'). Refused: a git rule, or 'denied' when the view
-- may not write X. Taking a lease the view holds answers it again, under a gc block too.
create function public.qorpera_folder_git_lease_take(p_environment_id uuid, p_actor jsonb, p_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_view public.qorpera_folder_views%rowtype; v_holder public.qorpera_folder_views%rowtype;
	v_lease public.qorpera_folder_git_leases%rowtype; v_key text; v_repository text; v_reason text; v_profile uuid;
begin
	v_view := public.qorpera_folder_git_view(p_environment_id, p_actor);
	if p_path is null or not public.qorpera_company_path_valid(p_path) then
		raise exception 'Folder git path is invalid' using errcode = '22023'; end if;
	v_key := public.qorpera_folder_key(p_path);
	if v_view.kind = 'coding_session' then
		v_reason := public.qorpera_folder_git_refusal(v_key, 'write', 'session', v_view.worker_id);
		-- A worker's branch, refs/heads/qorpera/coding/<workerId>, is its own session's to move.
		if v_reason = 'git_lease_required' and v_key ~ '^code/[^/]+/[^/]+/repo\.git/refs/heads/qorpera/coding(/|$)'
			and (string_to_array(v_key, '/'))[9] is distinct from v_view.worker_id::text then
			v_reason := 'git_other_worker'; end if;
		if v_reason <> 'git_lease_required' then
			return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','refused','reason',v_reason); end if;
	end if;
	v_repository := public.qorpera_folder_git_shared_repository(v_key);
	if v_repository is null then raise exception 'Folder git lease path is not a shared file' using errcode = '22023'; end if;
	-- X is the view's to write, as the commit's authority decides it: a repository it may not write gets no lease and no
	-- versions.
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if not public.qorpera_folder_actor_allowed(p_environment_id, v_profile,
		public.qorpera_folder_view_resolve(p_environment_id, v_profile, p_actor) - 'lockTargets' - 'attribution', p_path, 'write') then
		return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','refused','reason','denied'); end if;

	perform public.qorpera_folder_git_repository_lock(p_environment_id, v_repository, false);
	select h.* into v_holder from public.qorpera_folder_git_leases l join public.qorpera_folder_views h on h.id = l.view_id
	where l.environment_id = p_environment_id and l.key_sha256 = extensions.digest(v_repository || '/repo.git', 'sha256')
		and l.kind = 'maintenance' and l.view_id <> v_view.id;
	if found and public.qorpera_folder_view_valid(v_holder) and not exists (select 1 from public.qorpera_folder_git_leases
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and view_id = v_view.id) then
		return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','busy','leaseUntil',v_holder.lease_until,
			'reason','maintenance');
	end if;
	loop
		insert into public.qorpera_folder_git_leases(environment_id, view_id, kind, path, key_sha256, repository_key)
		values (p_environment_id, v_view.id, 'file', p_path, extensions.digest(v_key, 'sha256'), v_repository)
		on conflict (environment_id, key_sha256) do nothing returning * into v_lease;
		exit when v_lease.id is not null;
		select * into v_lease from public.qorpera_folder_git_leases
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') for update;
		if found then
			exit when v_lease.view_id = v_view.id;
			select * into v_holder from public.qorpera_folder_views where id = v_lease.view_id;
			if public.qorpera_folder_view_valid(v_holder) then
				return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','busy','leaseUntil',v_holder.lease_until,
					'reason',null);
			end if;
			-- Its view has ended: the lease ended with it.
			delete from public.qorpera_folder_git_leases where id = v_lease.id;
		end if;
		v_lease := null;
	end loop;
	return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','held','leaseId',v_lease.id,'path',v_lease.path,
		'versions',jsonb_build_object('file',public.qorpera_folder_git_version(p_environment_id, v_key),
			'reflog',public.qorpera_folder_git_version(p_environment_id, public.qorpera_folder_git_reflog_key(v_key)),
			'packedRefs',public.qorpera_folder_git_version(p_environment_id, v_repository || '/repo.git/packed-refs')));
end $$;

-- A command's end: drops every lease the view holds and answers their paths (X, not X.lock).
create function public.qorpera_folder_git_leases_drop(p_environment_id uuid, p_actor jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype; v_paths jsonb;
begin
	v_view := public.qorpera_folder_git_view(p_environment_id, p_actor);
	with d as (delete from public.qorpera_folder_git_leases
		where view_id = v_view.id and environment_id = p_environment_id and kind = 'file' returning path)
	select coalesce(jsonb_agg(path order by path collate "C"), '[]') into v_paths from d;
	return v_paths;
end $$;

-- 3. The gc block. -----------------------------------------------------------------------------------------------------

-- The repository's key, code/<owner>/<name>, from its path as stored; 22023 for anything else.
create function public.qorpera_folder_git_repository(p_repository text)
returns text language plpgsql immutable set search_path = '' as $$
begin
	if p_repository is null or not public.qorpera_company_path_valid(p_repository)
		or public.qorpera_folder_key(p_repository) !~ '^code/[^/]+/[^/]+$' then
		raise exception 'Folder git repository is invalid' using errcode = '22023'; end if;
	return public.qorpera_folder_key(p_repository);
end $$;

-- A code host's block on a repository's new leases while git gc runs (step 5e). Leases already held go on; held counts
-- other views' and the code host polls until it is 0. The block lives as long as the code host's view.
create function public.qorpera_folder_git_gc_begin(p_environment_id uuid, p_actor jsonb, p_repository text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_view public.qorpera_folder_views%rowtype; v_holder public.qorpera_folder_views%rowtype;
	v_lease public.qorpera_folder_git_leases%rowtype; v_repository text; v_held integer;
begin
	v_view := public.qorpera_folder_git_view(p_environment_id, p_actor);
	if v_view.kind <> 'code_host' then raise exception 'Only a code host blocks a repository' using errcode = '42501'; end if;
	v_repository := public.qorpera_folder_git_repository(p_repository);
	perform public.qorpera_folder_git_repository_lock(p_environment_id, v_repository, true);
	select * into v_lease from public.qorpera_folder_git_leases
	where environment_id = p_environment_id and key_sha256 = extensions.digest(v_repository || '/repo.git', 'sha256') for update;
	if found and v_lease.view_id <> v_view.id then
		select * into v_holder from public.qorpera_folder_views where id = v_lease.view_id;
		if public.qorpera_folder_view_valid(v_holder) then
			return jsonb_build_object('schema','qorpera.folder-git-gc/v1','state','busy','until',v_holder.lease_until); end if;
		delete from public.qorpera_folder_git_leases where id = v_lease.id;
		v_lease := null;
	end if;
	if v_lease.id is null then
		insert into public.qorpera_folder_git_leases(environment_id, view_id, kind, path, key_sha256, repository_key)
		values (p_environment_id, v_view.id, 'maintenance', p_repository || '/repo.git',
			extensions.digest(v_repository || '/repo.git', 'sha256'), v_repository);
	end if;
	select count(*) into v_held from public.qorpera_folder_git_leases l join public.qorpera_folder_views h on h.id = l.view_id
	where l.environment_id = p_environment_id and l.repository_key = v_repository and l.kind = 'file' and l.view_id <> v_view.id
		and public.qorpera_folder_view_valid(h);
	return jsonb_build_object('schema','qorpera.folder-git-gc/v1','state','blocking','held',v_held,'until',v_view.lease_until);
end $$;

create function public.qorpera_folder_git_gc_end(p_environment_id uuid, p_actor jsonb, p_repository text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype; v_repository text;
begin
	v_view := public.qorpera_folder_git_view(p_environment_id, p_actor);
	if v_view.kind <> 'code_host' then raise exception 'Only a code host blocks a repository' using errcode = '42501'; end if;
	v_repository := public.qorpera_folder_git_repository(p_repository);
	delete from public.qorpera_folder_git_leases
	where environment_id = p_environment_id and key_sha256 = extensions.digest(v_repository || '/repo.git', 'sha256')
		and kind = 'maintenance' and view_id = v_view.id;
	return jsonb_build_object('schema','qorpera.folder-git-gc/v1','state','ended');
end $$;

-- 4. The commit. -------------------------------------------------------------------------------------------------------

select pg_temp.s5b_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$v_git_class text; v_git_worker uuid; v_unchanged boolean; -- 20260930446200$old$,
	$new$v_git_class text; v_git_worker uuid; v_unchanged boolean; -- 20260930446200
	v_git_request jsonb; v_git_lease public.qorpera_folder_git_leases%rowtype; v_git_group text[];
	v_git_moved boolean := false; -- 20260930446300$new$,
	$old$	v_git_worker := case when v_view.kind = 'coding_session' then v_view.worker_id end;
$old$,
	$new$	v_git_worker := case when v_view.kind = 'coding_session' then v_view.worker_id end;
	-- 20260930446300 (step 5b): a git publish or lock removal (qorpera_folder_git_land) names its lease, which must be
	-- this view's; the lease's X and logs/X are its group. A replay was answered at step 0.
	if coalesce(current_setting('qorpera.folder_git', true), '') <> '' then
		v_git_request := current_setting('qorpera.folder_git', true)::jsonb;
		if v_git_request ->> 'environmentId' is distinct from p_environment_id::text
			or v_git_request ->> 'operationKey' is distinct from p_operation_key then
			raise exception 'Folder git request does not match this commit' using errcode = '55000'; end if;
		select * into v_git_lease from public.qorpera_folder_git_leases
		where id = (v_git_request ->> 'leaseId')::uuid and environment_id = p_environment_id for update;
		if not found or v_git_lease.view_id is distinct from v_view.id or v_git_lease.kind <> 'file' then
			raise exception 'Folder git lease is unavailable' using errcode = '42501'; end if;
		v_git_group := array[public.qorpera_folder_key(v_git_lease.path),
			public.qorpera_folder_git_reflog_key(public.qorpera_folder_key(v_git_lease.path))];
	end if;
$new$,
	$old$			v_reason := public.qorpera_folder_git_unit_refusal(p_environment_id, v_unit, v_key, v_to_key, v_git_class, v_git_worker);
			v_ok := v_reason is null;
		end if;
$old$,
	$new$			v_reason := public.qorpera_folder_git_unit_refusal(p_environment_id, v_unit, v_key, v_to_key, v_git_class, v_git_worker);
			-- 20260930446300: the lease's own X and logs/X, a file written or deleted, need no other lease.
			if v_reason = 'git_lease_required' and v_key = any(v_git_group) and (v_op = 'write' or (v_op = 'delete' and v_row.kind = 'file')) then
				v_reason := null; end if;
			v_ok := v_reason is null;
		end if;
		-- 20260930446300 (step 5b): X and logs/X land together. If either one's version moved, both are 'version_changed'.
		if v_ok and v_git_moved and v_key = any(v_git_group) then
			v_ok := false; v_reason := 'version_changed'; end if;
		-- They land only on all of the publish's objects, which come first (qorpera_folder_git_land): if a unit before
		-- them was not saved, both are 'git_objects_unsaved'. The objects that were saved stay.
		if v_git_group is not null and v_ok and v_key = any(v_git_group) and exists (select 1 from jsonb_array_elements(v_outcomes) o
			where o ->> 'outcome' <> 'saved' and public.qorpera_folder_key(o ->> 'path') <> all(v_git_group)) then
			v_ok := false; v_reason := 'git_objects_unsaved'; end if;
$new$,
	$old$	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is$old$,
	$new$	-- 20260930446300 (step 5b): a git publish's X and logs/X, checked on the locked rows before any unit is decided.
	if v_git_group is not null then
		v_git_moved := exists (select 1 from jsonb_array_elements(p_units) u
			where u ->> 'op' in ('write','delete') and public.qorpera_folder_key(u ->> 'path') = any(v_git_group)
				and public.qorpera_folder_git_version(p_environment_id, public.qorpera_folder_key(u ->> 'path'))
					is distinct from u ->> 'expectedVersion');
	end if;

	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is$new$
]);

-- 5. Publish and release. ----------------------------------------------------------------------------------------------

-- One commit under a lease: the folders above the caller's units, below repo.git, that are missing (each made, or saved
-- as it stands when there: 20260930446200), then the caller's objects, then X's and logs/X's units, with
-- qorpera.folder_git naming the lease for the commit. A publish's units are objects of the lease's repository, written,
-- and X written, with logs/X if git wrote it; a release's are X's and logs/X's, written or deleted. The answer is the
-- commit's with the caller's units only, in the caller's order, and published: X's and logs/X's units all saved. A
-- publish that saves them ends the lease; a release always does. One saved without the other (a refusal that is not
-- a version's or an object's) raises, and nothing lands.
create function public.qorpera_folder_git_land(p_environment_id uuid, p_actor jsonb, p_lease_id uuid, p_operation_key text,
	p_units jsonb, p_release boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_view public.qorpera_folder_views%rowtype; v_lease public.qorpera_folder_git_leases%rowtype; v_replay boolean := false;
	v_key text; v_group text[]; v_dirs jsonb; v_n integer; v_sorted jsonb; v_order integer[]; v_result jsonb; v_units jsonb;
	v_saved integer; v_ref_units integer;
begin
	-- A replay answers as the first time, also once the view has ended, the company is paused or the lease is gone: as
	-- at the commit's step 0, the view's pass and the operation key find it before anything live is checked.
	if auth.role() = 'service_role' and jsonb_typeof(p_actor) = 'object' and p_actor ->> 'kind' = 'view' then
		v_replay := exists (select 1 from public.qorpera_folder_views v join public.qorpera_folder_operation_keys k
				on k.environment_id = v.environment_id and k.scope_id = v.id and k.operation_key = p_operation_key
			where v.id = (p_actor ->> 'viewId')::uuid and v.environment_id = p_environment_id
				and v.pass_sha256 = extensions.digest(coalesce(p_actor ->> 'pass', ''), 'sha256'));
	end if;
	if not v_replay then v_view := public.qorpera_folder_git_view(p_environment_id, p_actor); end if;
	if p_lease_id is null or jsonb_typeof(p_units) is distinct from 'array' or jsonb_array_length(p_units) = 0
		or exists (select 1 from jsonb_array_elements(p_units) u where jsonb_typeof(u) <> 'object'
			or jsonb_typeof(u -> 'path') is distinct from 'string' or not public.qorpera_company_path_valid(u ->> 'path')) then
		raise exception 'Folder git units are invalid' using errcode = '22023'; end if;
	if coalesce(current_setting('qorpera.folder_git', true), '') <> '' then
		raise exception 'A git request is already set in this transaction' using errcode = '55000'; end if;
	if not v_replay then
		select * into v_lease from public.qorpera_folder_git_leases where id = p_lease_id and environment_id = p_environment_id for update;
		if found and (v_lease.view_id <> v_view.id or v_lease.kind <> 'file') then
			raise exception 'Folder git lease is unavailable' using errcode = '42501'; end if;
		-- With no lease row the commit decides: a replay, or 42501.
		if found then
			v_key := public.qorpera_folder_key(v_lease.path);
			v_group := array[v_key, public.qorpera_folder_git_reflog_key(v_key)];
			-- The lease's repository is matched literally: '_' and '%' are valid in its name.
			if exists (select 1 from jsonb_array_elements(p_units) u where not (
					(public.qorpera_folder_key(u ->> 'path') = any(v_group) and (u ->> 'op' = 'write' or (p_release and u ->> 'op' = 'delete')))
					or (not p_release and u ->> 'op' = 'write' and public.qorpera_folder_git_object(public.qorpera_folder_key(u ->> 'path'))
						and starts_with(public.qorpera_folder_key(u ->> 'path'), v_lease.repository_key || '/repo.git/objects/'))))
				or (select count(distinct public.qorpera_folder_key(u ->> 'path')) from jsonb_array_elements(p_units) u)
					<> jsonb_array_length(p_units)
				or (not p_release and not exists (select 1 from jsonb_array_elements(p_units) u
					where public.qorpera_folder_key(u ->> 'path') = v_key)) then
				raise exception 'Folder git units are invalid' using errcode = '22023'; end if;
		end if;
	end if;
	-- The objects go first, so X and logs/X are decided on their outcomes; v_order maps the commit's units back.
	select coalesce(jsonb_agg(u.value order by public.qorpera_folder_git_object(public.qorpera_folder_key(u.value ->> 'path')) is not true, u.n), '[]'),
		array_agg(u.n::integer order by public.qorpera_folder_git_object(public.qorpera_folder_key(u.value ->> 'path')) is not true, u.n)
	into v_sorted, v_order from jsonb_array_elements(p_units) with ordinality u(value, n);
	select coalesce(jsonb_agg(jsonb_build_object('op','mkdir','path',d.path) order by d.key collate "C"), '[]') into v_dirs
	from (select distinct on (public.qorpera_folder_key(a.path)) public.qorpera_folder_key(a.path) as key, a.path
		from jsonb_array_elements(p_units) u,
			lateral (select array_to_string((string_to_array(u ->> 'path', '/'))[1:i], '/') as path
				from generate_series(5, cardinality(string_to_array(u ->> 'path', '/')) - 1) i) a
		order by public.qorpera_folder_key(a.path), a.path collate "C") d;
	v_n := jsonb_array_length(v_dirs);

	if not v_replay then
		perform set_config('qorpera.folder_git', jsonb_build_object('environmentId', p_environment_id::text,
			'operationKey', p_operation_key, 'leaseId', p_lease_id::text)::text, true);
	end if;
	v_result := public.qorpera_folder_commit(p_environment_id, p_actor, p_operation_key, v_dirs || v_sorted, null, null);
	perform set_config('qorpera.folder_git', '', true);

	select coalesce(jsonb_agg(o || jsonb_build_object('unit', v_order[(o ->> 'unit')::integer - v_n])
		order by v_order[(o ->> 'unit')::integer - v_n]), '[]')
	into v_units from jsonb_array_elements(v_result -> 'units') o where (o ->> 'unit')::integer > v_n;
	-- X's and logs/X's units: the caller's units that are not objects.
	select count(*) filter (where o ->> 'outcome' = 'saved'), count(*) into v_saved, v_ref_units
	from jsonb_array_elements(v_units) o join jsonb_array_elements(p_units) with ordinality u(value, n) on u.n = (o ->> 'unit')::integer
	where not public.qorpera_folder_git_object(public.qorpera_folder_key(u.value ->> 'path'));
	if v_saved > 0 and v_saved < v_ref_units then
		raise exception 'Folder git publish would land a ref without its reflog' using errcode = '22023'; end if;
	if p_release or (v_ref_units > 0 and v_saved = v_ref_units) then
		delete from public.qorpera_folder_git_leases where id = p_lease_id and view_id = (p_actor ->> 'viewId')::uuid;
	end if;
	return v_result || jsonb_build_object('units', v_units, 'published', v_ref_units > 0 and v_saved = v_ref_units);
end $$;

-- git renamed X.lock over X: the session's objects, then X and logs/X under the lease.
create function public.qorpera_folder_git_publish(p_environment_id uuid, p_actor jsonb, p_lease_id uuid, p_operation_key text,
	p_units jsonb)
returns jsonb language sql security definer set search_path = '' as $$
	select public.qorpera_folder_git_land(p_environment_id, p_actor, p_lease_id, p_operation_key, p_units, false)
$$;

-- git unlinked X.lock: the lease ends. With units, X's and logs/X's writes or deletes land first (a delete of X, a
-- reflog expire), under the operation key 'git-release:<leaseId>'. With none, a lease already gone is released too.
create function public.qorpera_folder_git_lease_release(p_environment_id uuid, p_actor jsonb, p_lease_id uuid,
	p_units jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype; v_lease public.qorpera_folder_git_leases%rowtype;
begin
	if p_units is not null and p_units <> 'null'::jsonb then
		return public.qorpera_folder_git_land(p_environment_id, p_actor, p_lease_id, 'git-release:' || p_lease_id::text, p_units, true);
	end if;
	v_view := public.qorpera_folder_git_view(p_environment_id, p_actor);
	if p_lease_id is null then raise exception 'Folder git lease is invalid' using errcode = '22023'; end if;
	select * into v_lease from public.qorpera_folder_git_leases where id = p_lease_id and environment_id = p_environment_id for update;
	if found and (v_lease.view_id <> v_view.id or v_lease.kind <> 'file') then
		raise exception 'Folder git lease is unavailable' using errcode = '42501'; end if;
	delete from public.qorpera_folder_git_leases where id = p_lease_id and view_id = v_view.id;
	return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','released');
end $$;

-- Grants ----------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_git_view(uuid, jsonb),
	public.qorpera_folder_git_shared_repository(text),
	public.qorpera_folder_git_reflog_key(text),
	public.qorpera_folder_git_version(uuid, text),
	public.qorpera_folder_git_repository_lock(uuid, text, boolean),
	public.qorpera_folder_git_repository(text),
	public.qorpera_folder_git_land(uuid, jsonb, uuid, text, jsonb, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_folder_git_lease_take(uuid, jsonb, text),
	public.qorpera_folder_git_leases_drop(uuid, jsonb),
	public.qorpera_folder_git_publish(uuid, jsonb, uuid, text, jsonb),
	public.qorpera_folder_git_lease_release(uuid, jsonb, uuid, jsonb),
	public.qorpera_folder_git_gc_begin(uuid, jsonb, text),
	public.qorpera_folder_git_gc_end(uuid, jsonb, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_folder_git_lease_take(uuid, jsonb, text),
	public.qorpera_folder_git_leases_drop(uuid, jsonb),
	public.qorpera_folder_git_publish(uuid, jsonb, uuid, text, jsonb),
	public.qorpera_folder_git_lease_release(uuid, jsonb, uuid, jsonb),
	public.qorpera_folder_git_gc_begin(uuid, jsonb, text),
	public.qorpera_folder_git_gc_end(uuid, jsonb, text)
	to service_role;
