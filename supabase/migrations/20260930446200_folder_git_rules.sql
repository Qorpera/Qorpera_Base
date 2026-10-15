-- 20260930446200: step 5b, part 2 of 4: git's rules in the folder's commit (deploy/first-node/RUNTIME-FOLDER-CODING-
-- MACHINES.md, "Code areas and git"; RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount" and §7 item 9, as amended there).
-- A repository is code/<owner>/<name>/: repo.git/ (bare), main/ (the default branch) and worktrees/<workerId>/.
-- 1. qorpera_folder_git_refusal: the rule a key breaks. The platform, a code host's view included, has none. A member
--    (a restore) may write any worktree and the shared files with no lease. Every other actor is a session, and only a
--    coding view names its worker: only that worker writes under worktrees/<workerId>/ and repo.git/worktrees/<workerId>/
--    ('git_other_worker'), and repo.git/worktrees/main/ is main/'s, the platform's. In repo.git a session may write
--    objects and their folders but never remove one ('git_object_delete'; a move's source is removed, as a delete's is),
--    its own worktree's files but config.worktree, the shared files' folders, and the shared files themselves (refs/**,
--    packed-refs, shallow, logs/refs/**) only under a lease ('git_lease_required'; part 3 adds the publish). refs/stash
--    and its reflog are refused ('git_stash'), objects/pack/*.keep too ('git_keep_file'); main/**, the session-local
--    files and everything else in repo.git are the platform's ('git_platform_only'), and so is every key a move, copy or
--    new folder produces in repo.git.
-- 2. The commit checks every key a unit removes or produces, right after the reserved names.
-- 3. Under repo.git, a write of an object onto its own bytes and a mkdir onto a folder are saved as they stand, with no
--    change (git writes what it already has). An object with other bytes is refused for all but the platform
--    ('git_object_delete'). A conflict there keeps no conflict copy.
-- Every patched body names this migration (20260930446200), and every earlier marker in it stays.

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

-- 1. The rules. --------------------------------------------------------------------------------------------------------

-- A published git object: a loose object (SHA-1 or SHA-256) or a pack's own file, by its key.
create function public.qorpera_folder_git_object(p_key text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_key ~ ('^code/[^/]+/[^/]+/repo\.git/objects/([0-9a-f]{2}/[0-9a-f]{38}([0-9a-f]{24})?'
		|| '|pack/pack-[0-9a-f]{40}([0-9a-f]{24})?\.(pack|idx|rev|bitmap|mtimes|promisor))$'), false)
$$;

-- The git rule a key breaks, or null. p_op is what happens at the key: 'write' (a file), 'symlink' (a link, 20260930380000),
-- 'mkdir', 'delete' (a file or a link), 'rmdir', or 'move' (a key a move, copy or new folder produces, carried whole). A
-- link is a file's write, but git writes none under repo.git: there it is the platform's. p_class is 'platform', 'member' or
-- 'session'; p_worker is a coding view's worker (keys are case-folded, as a uuid's text is).
create function public.qorpera_folder_git_refusal(p_key text, p_op text, p_class text, p_worker uuid)
returns text language plpgsql immutable set search_path = '' as $$
declare v_part text[] := string_to_array(p_key, '/'); v_n integer; v_rest text; v_folder boolean := p_op in ('mkdir','rmdir');
begin
	v_n := cardinality(v_part);
	if p_class = 'platform' or v_part[1] is distinct from 'code' or v_n < 4 then return null; end if;
	if v_part[4] = 'main' then return 'git_platform_only'; end if;
	if v_part[4] = 'worktrees' then
		return case when v_n >= 5 and p_class = 'session' and v_part[5] is distinct from p_worker::text then 'git_other_worker' end;
	end if;
	if v_part[4] <> 'repo.git' then return null; end if;
	if v_n = 4 or p_op in ('move','symlink') then return 'git_platform_only'; end if;
	v_rest := array_to_string(v_part[5:v_n], '/');
	if v_rest ~ '^(logs/)?refs/stash(/|$)' then return 'git_stash'; end if;
	if v_rest ~ '^objects/pack/[^/]*\.keep$' then return 'git_keep_file'; end if;
	if v_rest ~ '^objects(/|$)' then
		if (v_folder and v_rest !~ '^objects(/[0-9a-f]{2}|/pack)?$') or (not v_folder and not public.qorpera_folder_git_object(p_key)) then
			return 'git_platform_only'; end if;
		if p_op in ('delete','rmdir') then return 'git_object_delete'; end if;
		return case when p_class = 'member' then 'git_platform_only' end;
	end if;
	if v_rest ~ '^worktrees(/|$)' then
		if v_n = 5 then return case when p_op <> 'mkdir' then 'git_platform_only' end; end if;
		-- main/'s own (the code host's git runs main/ with it as its git directory).
		if v_part[6] = 'main' then return 'git_platform_only'; end if;
		if p_class = 'session' and v_part[6] is distinct from p_worker::text then return 'git_other_worker'; end if;
		return case when v_n = 7 and v_part[7] = 'config.worktree' then 'git_platform_only' end;
	end if;
	if v_rest in ('packed-refs','shallow') then
		return case when v_folder then 'git_platform_only' when p_class = 'session' then 'git_lease_required' end;
	end if;
	if v_rest ~ '^(logs/)?refs(/|$)' then
		return case when not v_folder and p_class = 'session' then 'git_lease_required' end;
	end if;
	return case when v_rest = 'logs' and p_op = 'mkdir' then null else 'git_platform_only' end;
end
$$;

-- The first git rule a unit breaks, in key order, over every key it removes or produces: a write's or mkdir's own; a
-- delete's or move's source and every key below it, as removed; a move's or copy's target and every key below it, as
-- produced; a new folder and its contents. Null when it breaks none.
create function public.qorpera_folder_git_unit_refusal(p_environment_id uuid, p_unit jsonb, p_key text, p_to_key text,
	p_class text, p_worker uuid)
returns text language sql stable security definer set search_path = '' as $$
	select k.reason from (
		select p_key as key, public.qorpera_folder_git_refusal(p_key, p_unit ->> 'op', p_class, p_worker) as reason
		where p_unit ->> 'op' in ('write','symlink','mkdir')
		union all
		select e.key_text, public.qorpera_folder_git_refusal(e.key_text,
			case when e.kind = 'folder' then 'rmdir' else 'delete' end, p_class, p_worker)
		from public.qorpera_folder_entries e
		where p_unit ->> 'op' in ('delete','move') and e.environment_id = p_environment_id and e.kind <> 'claim'
			and (e.key_text = p_key or e.key_text like public.qorpera_folder_under(p_key))
		union all
		select p_to_key, public.qorpera_folder_git_refusal(p_to_key, 'move', p_class, p_worker)
		where p_unit ->> 'op' in ('move','copy')
		union all
		select t.key, public.qorpera_folder_git_refusal(t.key, 'move', p_class, p_worker)
		from (select p_to_key || substr(e.key_text, char_length(p_key) + 1) as key from public.qorpera_folder_entries e
			where p_unit ->> 'op' in ('move','copy') and e.environment_id = p_environment_id and e.kind <> 'claim'
				and e.key_text like public.qorpera_folder_under(p_key)) t
		union all
		select p_key, public.qorpera_folder_git_refusal(p_key, 'move', p_class, p_worker)
		where p_unit ->> 'op' = 'new_folder'
		union all
		select c.key, public.qorpera_folder_git_refusal(c.key, 'move', p_class, p_worker)
		from (select public.qorpera_folder_key((p_unit ->> 'path') || '/' || (value ->> 'path')) as key
			from jsonb_array_elements(case when p_unit ->> 'op' = 'new_folder' then p_unit -> 'contents' else '[]'::jsonb end)) c
	) k
	where k.reason is not null
	order by k.key collate "C"
	limit 1
$$;

-- 2. and 3. The commit. ------------------------------------------------------------------------------------------------

select pg_temp.s5b_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$v_view_agent boolean := false; v_turn_run uuid;$old$,
	$new$v_view_agent boolean := false; v_turn_run uuid;
	v_git_class text; v_git_worker uuid; v_unchanged boolean; -- 20260930446200$new$,
	$old$	else
		v_hook_actor := p_actor;
	end if;

	-- The lock set:$old$,
	$new$	else
		v_hook_actor := p_actor;
	end if;
	-- 20260930446200 (step 5b): who git's rules see (qorpera_folder_git_refusal). The platform and a code host's view
	-- have none; a member restores; every other actor is a session, and only a coding view names its worker.
	v_git_class := case when v_actor_kind = 'platform' or v_view.kind = 'code_host' then 'platform'
		when v_actor_kind = 'member' then 'member' else 'session' end;
	v_git_worker := case when v_view.kind = 'coding_session' then v_view.worker_id end;

	-- The lock set:$new$,
	$old$			v_ok := false; v_reason := 'reserved';
		end if;
$old$,
	$new$			v_ok := false; v_reason := 'reserved';
		end if;

		-- 20260930446200 (step 5b): git's rules in code areas, on every key the unit removes or produces.
		if v_ok and v_git_class <> 'platform'
			and (split_part(v_key, '/', 1) = 'code' or split_part(coalesce(v_to_key, ''), '/', 1) = 'code') then
			v_reason := public.qorpera_folder_git_unit_refusal(p_environment_id, v_unit, v_key, v_to_key, v_git_class, v_git_worker);
			v_ok := v_reason is null;
		end if;
$new$,
	$old$		if v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion'$old$,
	$new$		-- 20260930446200 (step 5b): under repo.git, an object written onto its own bytes and a mkdir onto a folder are
		-- saved as they stand, with no change (git writes what it already has). An object with other bytes is refused
		-- for all but the platform.
		v_unchanged := false;
		if v_ok and v_row.kind is not null and v_key ~ '^code/[^/]+/[^/]+/repo\.git/' then
			if v_op = 'mkdir' and v_row.kind = 'folder' then
				v_unchanged := true;
			elsif v_op = 'write' and public.qorpera_folder_git_object(v_key) then
				if v_row.kind = 'file' and v_row.manifest_sha256 = v_unit -> 'file' ->> 'manifestSha256' then
					v_unchanged := true;
				elsif v_git_class <> 'platform' then
					v_ok := false; v_reason := 'git_object_delete';
				end if;
			end if;
		end if;
		if v_unchanged then
			null;
		elsif v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion'$new$,
	$old$		if v_ok then
			v_version := public.qorpera_folder_apply_unit($old$,
	$new$		if v_ok and v_unchanged then
			v_version := v_row.version; -- 20260930446200: saved as it stands
		elsif v_ok then
			v_version := public.qorpera_folder_apply_unit($new$,
	$old$		if not v_ok and v_op in ('write','new_folder','symlink') and v_reason in ('version_changed','exists','unseen_change','missing') then$old$,
	$new$		if not v_ok and v_op in ('write','new_folder','symlink') and v_reason in ('version_changed','exists','unseen_change','missing')
			and v_key !~ '^code/[^/]+/[^/]+/repo\.git(/|$)' then -- 20260930446200: none under repo.git$new$
]);

-- Grants ----------------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_git_object(text),
	public.qorpera_folder_git_refusal(text, text, text, uuid),
	public.qorpera_folder_git_unit_refusal(uuid, jsonb, text, text, text, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
