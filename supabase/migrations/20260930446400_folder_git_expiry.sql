-- 20260930446400: step 5b, part 4 of 4: git's old objects and the history view (deploy/first-node/RUNTIME-FOLDER-CODING-
-- MACHINES.md, "Code areas and git": old versions of repo.git/objects/** kept 7 days, not forever, and the history view
-- folding git's own changes into one line per publish).
-- 1. qorpera_folder_git_versions_expire: a version under code/<owner>/<name>/repo.git/objects/ goes 7 days after it
--    ended, and the bytes nothing roots any more wait for the folder's GC, as an erasure's do. Only the platform and a
--    code host delete or move an object (part 2), so these are the code host's gc: its prunes and its repacks. pg_cron
--    runs it every minute.
-- 2. qorpera_member_folder_history: a change set's paths under a repository's repo.git are one line, the folder
--    code/<owner>/<name>/repo.git. The feed and a path's own history still list each version.
-- A member never restores a single object: part 2 already refuses a member's write or delete under objects/.
-- Every patched body names this migration (20260930446400), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result (as 20260930446300).
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

-- 1. Old objects. ------------------------------------------------------------------------------------------------------

-- How far the expiry has got. Each version under objects/ is looked at once, 7 days after it was made.
create table public.qorpera_folder_git_expiry (
	singleton boolean primary key default true check (singleton),
	after_at timestamptz not null default '-infinity',
	after_version uuid not null default '00000000-0000-0000-0000-000000000000'
);
insert into public.qorpera_folder_git_expiry default values;
alter table public.qorpera_folder_git_expiry enable row level security;
revoke all on table public.qorpera_folder_git_expiry from public, anon, authenticated, service_role;

create index qorpera_folder_path_versions_git_objects on public.qorpera_folder_path_versions(created_at, version)
	where path ~ '^code/[^/]+/[^/]+/repo\.git/objects/';

-- One batch, oldest first. A version ends when the next one on its key names it (a write over it, a delete, a move away);
-- a delete and a move's leaving end themselves, since nothing comes after them on the key. 7 days after the end the
-- version goes. In a statement after the deletes, so the roots no longer count them, the bytes nothing roots wait for the
-- folder's GC where it serves the company, as an erasure's do (20260928469200). Where it does not (the company is
-- being deleted, and its deletion takes the bytes), nothing is queued.
create function public.qorpera_folder_git_versions_expire(p_limit integer default 1000)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cutoff timestamptz := clock_timestamp() - interval '7 days'; v_cursor public.qorpera_folder_git_expiry%rowtype;
	v_events uuid[]; v_times timestamptz[]; v_scanned integer; v_ended uuid[]; v_expired integer := 0; v_gone jsonb;
	v_queued integer := 0;
begin
	if p_limit is null or p_limit not between 1 and 10000 then
		raise exception 'The expiry''s limit is invalid' using errcode = '22023'; end if;
	select * into v_cursor from public.qorpera_folder_git_expiry for update;
	select array_agg(event.version order by event.created_at, event.version),
		array_agg(event.created_at order by event.created_at, event.version)
	into v_events, v_times
	from (select version.version, version.created_at from public.qorpera_folder_path_versions as version
		where version.path ~ '^code/[^/]+/[^/]+/repo\.git/objects/' and version.created_at < v_cutoff
			and (version.created_at, version.version) > (v_cursor.after_at, v_cursor.after_version)
		order by version.created_at, version.version
		limit p_limit) as event;
	v_scanned := coalesce(cardinality(v_events), 0);
	if v_scanned > 0 then
		update public.qorpera_folder_git_expiry set after_at = v_times[v_scanned], after_version = v_events[v_scanned];
		-- A move's arrival or a copy names its source, on another key: the source's own leaving ends it.
		select coalesce(array_agg(distinct ended.version), '{}') into v_ended from (
			select prior.version from public.qorpera_folder_path_versions as event
			join public.qorpera_folder_path_versions as prior on prior.version = event.prior_version
				and prior.environment_id = event.environment_id and prior.key_sha256 = event.key_sha256
			where event.version = any(v_events)
			union all
			select event.version from public.qorpera_folder_path_versions as event
			where event.version = any(v_events) and event.op in ('delete', 'move_out')) as ended;
		with gone as (
			delete from public.qorpera_folder_path_versions as version
			where version.version = any(v_ended) and not exists (select 1 from public.qorpera_folder_entries as entry
				where entry.environment_id = version.environment_id and entry.version = version.version)
			returning version.environment_id, version.manifest_sha256)
		select count(*)::integer, coalesce(jsonb_agg(distinct jsonb_build_object('profile', file.profile_id,
				'manifest', gone.manifest_sha256))
			filter (where gone.manifest_sha256 is not null and file.profile_id is not null), '[]')
		into v_expired, v_gone
		from gone left join public.qorpera_company_files as file on file.environment_id = gone.environment_id;
		insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
		select hash.profile_id, hash.sha256, clock_timestamp() from (
			select (gone ->> 'profile')::uuid as profile_id, gone ->> 'manifest' as sha256
			from jsonb_array_elements(v_gone) as gone
			union
			select chunk.profile_id, chunk.chunk_sha256 from jsonb_array_elements(v_gone) as gone
			join public.qorpera_folder_file_chunks as chunk on chunk.profile_id = (gone ->> 'profile')::uuid
				and chunk.manifest_sha256 = gone ->> 'manifest') as hash
		where public.qorpera_folder_gc_company(hash.profile_id)
			and exists (select 1 from public.qorpera_profile_objects as object where object.profile_id = hash.profile_id
				and object.sha256 = hash.sha256)
			and not public.qorpera_folder_object_rooted(hash.profile_id, hash.sha256)
		order by hash.profile_id, hash.sha256 collate "C"
		on conflict (profile_id, sha256) do update
		set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
		get diagnostics v_queued = row_count;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-git-expiry/v1', 'scanned', v_scanned, 'expired', v_expired,
		'queued', v_queued);
end $$;

-- Every minute through pg_cron, with its run log kept a day, as the folder erasure (20260928469190).
create function public.qorpera_schedule_folder_git_expiry()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The expiry of git''s old objects was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.folder-git-expiry-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-folder-git-expiry', '* * * * *', 'select public.qorpera_folder_git_versions_expire()');
		v_clean := cron.schedule('qorpera-folder-git-expiry-log', '41 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-folder-git-expiry')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The expiry of git''s old objects was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.folder-git-expiry-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.folder-git-expiry-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

-- 2. The history view. -------------------------------------------------------------------------------------------------

select pg_temp.s5b_patch('public.qorpera_member_folder_history(uuid,bigint,integer)', array[
	$old$v_seen integer; v_found integer; v_cap integer; v_budget integer := 10000; v_oldest bigint;$old$,
	$new$v_seen integer; v_found integer; v_cap integer; v_budget integer := 10000; v_oldest bigint;
	v_repo text; v_repos text[]; -- 20260930446400$new$,
	$old$v_seen := 0; v_found := 0; v_paths := '[]';$old$,
	$new$v_seen := 0; v_found := 0; v_paths := '[]'; v_repos := '{}';$new$,
	$old$			if public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, v_version.path, 'read') then
				v_found := v_found + 1;
				exit when v_found > 20;
				v_paths := v_paths || jsonb_build_array(jsonb_build_object('path', v_version.path, 'op', v_version.op,
					'kind', v_version.kind, 'version', v_version.version));
			end if;$old$,
	$new$			-- 20260930446400 (step 5b): git's own changes, everything in a repository's repo.git, are one line: the
			-- folder, at its first readable version in this change set.
			v_repo := substring(v_version.path from '^(code/[^/]+/[^/]+/repo\.git)(?:/|$)');
			if (v_repo is null or not v_repo = any(v_repos))
					and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, v_version.path, 'read') then
				v_found := v_found + 1;
				exit when v_found > 20;
				if v_repo is null then
					v_paths := v_paths || jsonb_build_array(jsonb_build_object('path', v_version.path, 'op', v_version.op,
						'kind', v_version.kind, 'version', v_version.version));
				else
					v_repos := v_repos || v_repo;
					v_paths := v_paths || jsonb_build_array(jsonb_build_object('path', v_repo, 'op', 'write', 'kind', 'folder',
						'version', v_version.version));
				end if;
			end if;$new$
]);

-- Privileges. ----------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_git_versions_expire(integer) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_schedule_folder_git_expiry() from public, anon, authenticated, service_role;
select public.qorpera_schedule_folder_git_expiry();
