set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_folder_snapshots') is not null then
		raise exception 'Surface Host Wiring (20260930844000) is already applied';
	end if;
	if to_regclass('public.qorpera_surface_jobs') is null
		or to_regprocedure('public.qorpera_surface_renew_lease(text,uuid,uuid,integer)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs(integer)') is null then
		raise exception 'Surface Host Wiring (20260930844000) requires 20260930843000 first';
	end if;
	if to_regclass('public.qorpera_native_host_calls') is null then
		raise exception 'Surface Host Wiring (20260930844000) requires 20260928409985 first';
	end if;
end $$;

alter table public.qorpera_surface_sessions
	add column if not exists wake_id uuid references public.qorpera_wake_occurrences(id) on delete set null;

create index if not exists qorpera_surface_sessions_wake_idx
	on public.qorpera_surface_sessions(wake_id)
	where wake_id is not null;

-- WHY: Registers 'surface-session' on qorpera_wake_occurrences so surface session turns run through Qorpera's governed wake materialization and folder-v2 authority checks.
do $$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check' and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	if not ('light-ask' = any (v_kinds) and 'room' = any (v_kinds)) or 'surface-session' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format('alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
		check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality) from unnest(v_kinds || array['surface-session'])
			with ordinality as listed(kind, ordinality)));
end $$;

create function pg_temp.shw_replace(p_function regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('surface-session' in v_definition) > 0 then
		raise exception '20260930844000 is already in %', p_function; end if;
	for v_index in 1 .. array_length(p_pairs, 1) loop
		if p_pairs[v_index][1] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index][1], '')))
				/ length(p_pairs[v_index][1]) <> 1 then
			raise exception '20260930844000 anchor differs in %: %', p_function, left(p_pairs[v_index][1], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index][1], p_pairs[v_index][2]);
	end loop;
	execute v_definition;
end $$;

create table public.qorpera_surface_folder_snapshots (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	snapshot_id text not null check (char_length(btrim(snapshot_id)) between 1 and 128),
	folder_root text not null check (char_length(folder_root) <= 256),
	change_ids uuid[] not null default '{}',
	files_before jsonb not null,
	versions_after jsonb,
	after_content_sha256 jsonb,
	created_at timestamptz not null default clock_timestamp(),
	unique (profile_id, surface_id, snapshot_id)
);

create index qorpera_surface_folder_snapshots_lookup_idx
	on public.qorpera_surface_folder_snapshots(profile_id, surface_id, created_at desc);

alter table public.qorpera_surface_folder_snapshots enable row level security;
revoke all on table public.qorpera_surface_folder_snapshots from public, anon, authenticated;

-- WHY: Prunes old code-site and surface-site versions while keeping live releases, unexpired surface previews, and the three newest ready versions.
create or replace function public.qorpera_code_site_prune(p_site_id uuid)
returns integer language plpgsql volatile set search_path = '' as $$
declare v_site public.qorpera_company_sites%rowtype; v_repository public.qorpera_code_repositories%rowtype;
	v_live public.qorpera_code_releases%rowtype; v_keep uuid[] := '{}'; v_count integer;
begin
	select * into v_site from public.qorpera_company_sites where id = p_site_id;
	if v_site.id is null then return 0; end if;
	if v_site.code_owner is null then
		if not exists (select 1 from public.qorpera_surfaces sf where sf.site_id = p_site_id) then
			return 0;
		end if;
	else
		select * into v_repository from public.qorpera_code_repositories
		where environment_id = v_site.environment_id and owner = v_site.code_owner and name = v_site.code_name;
		v_live := public.qorpera_code_release_live(v_repository);
		if v_live.n is not null then
			with recursive chain(prior, version_id, depth) as (
				select release.prior, release.version_id, 1 from public.qorpera_code_releases release
				where release.environment_id = v_repository.environment_id and release.owner = v_repository.owner
					and release.name = v_repository.name and release.n = v_live.prior
				union all
				select release.prior, release.version_id, chain.depth + 1 from chain
				join public.qorpera_code_releases release on release.environment_id = v_repository.environment_id
					and release.owner = v_repository.owner and release.name = v_repository.name and release.n = chain.prior
				where chain.depth < 5)
			select coalesce(array_agg(chain.version_id) filter (where chain.version_id is not null), '{}') into v_keep from chain;
		end if;
	end if;
	delete from public.qorpera_company_site_versions version
	where version.site_id = p_site_id and version.state in ('ready','kept')
		and version.id is distinct from v_site.current_version_id and not (version.id = any(v_keep))
		and not exists (
			select 1 from public.qorpera_surface_previews sp
			where sp.site_version_id = version.id and sp.expires_at > clock_timestamp()
		)
		and version.id not in (select newest.id from public.qorpera_company_site_versions newest
			where newest.site_id = p_site_id and newest.state = 'ready'
			order by newest.created_at desc, newest.id desc limit 3);
	get diagnostics v_count = row_count;
	return v_count;
end $$;

-- WHY: Tenant-scoped native host wrappers allow sandboxed runs to invoke surface RPCs through qorpera_native_host_call without holding a service key.
create function public.qorpera_native_surface_describe_senses(p_profile_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_surface_describe_company_senses(p_profile_id);
end $$;
revoke all on function public.qorpera_native_surface_describe_senses(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_describe_senses(uuid) to service_role;

create function public.qorpera_native_surface_propose(
	p_profile_id uuid,
	p_slug text,
	p_title text,
	p_group text,
	p_archetype text,
	p_source_kind text,
	p_icon text default 'page',
	p_repository_key text default null,
	p_folder_root text default null,
	p_preview_mode text default 'none',
	p_brief_summary text default null,
	p_kind text default 'custom',
	p_accent_hex text default null,
	p_is_global boolean default false,
	p_activate_immediately boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	return public.qorpera_propose_surface(
		p_profile_id, p_slug, p_title, p_group, p_archetype, p_source_kind,
		p_icon, p_repository_key, p_folder_root, p_preview_mode, p_brief_summary,
		p_kind, p_accent_hex, p_is_global, p_activate_immediately
	);
end $$;
revoke all on function public.qorpera_native_surface_propose(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_propose(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean) to service_role;

create function public.qorpera_native_surface_start_session(
	p_profile_id uuid,
	p_surface_id uuid,
	p_prompt text,
	p_title text default null,
	p_origin_kind text default 'cofounder',
	p_origin_label text default 'Co-Founder',
	p_exploration_count integer default null,
	p_exploration_title text default null,
	p_variant_labels text[] default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_origin_kind text := coalesce(nullif(lower(btrim(p_origin_kind)), ''), 'cofounder');
begin
	if v_origin_kind not in ('cofounder', 'automation') then
		raise exception 'Native surface session start only accepts cofounder or automation origin' using errcode = '42501';
	end if;
	return public.qorpera_service_start_surface_session(
		p_profile_id, p_surface_id, p_prompt, p_title, v_origin_kind, p_origin_label,
		p_exploration_count, p_exploration_title, p_variant_labels
	);
end $$;
revoke all on function public.qorpera_native_surface_start_session(uuid, uuid, text, text, text, text, integer, text, text[]) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_start_session(uuid, uuid, text, text, text, text, integer, text, text[]) to service_role;

create function public.qorpera_native_surface_manage_automation(
	p_profile_id uuid,
	p_action text,
	p_automation_id uuid default null,
	p_title text default null,
	p_prompt text default null,
	p_schedule_summary text default null,
	p_target_surface_slug text default null,
	p_enabled boolean default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	return public.qorpera_service_manage_surface_automation(
		p_profile_id, p_action, p_automation_id, p_title, p_prompt, p_schedule_summary, p_target_surface_slug, p_enabled
	);
end $$;
revoke all on function public.qorpera_native_surface_manage_automation(uuid, text, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_manage_automation(uuid, text, uuid, text, text, text, text, boolean) to service_role;

create function public.qorpera_native_surface_record_change(
	p_profile_id uuid,
	p_session_id uuid,
	p_title text,
	p_summary text,
	p_kind text default 'git_range',
	p_parent_sha text default null,
	p_head_sha text default null,
	p_depends_on_change_ids uuid[] default '{}'::uuid[],
	p_affected_paths text[] default '{}'::text[],
	p_diff_stats jsonb default null,
	p_patch_manifest jsonb default null,
	p_finish_session boolean default false,
	p_lease_token uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_parent_sha text := nullif(btrim(coalesce(p_parent_sha, '')), '');
	v_head_sha text := nullif(btrim(coalesce(p_head_sha, '')), '');
	v_result jsonb;
begin
	if p_lease_token is null then
		raise exception 'Surface change recording requires lease token' using errcode = '42501';
	end if;
	select * into v_session
	from public.qorpera_surface_sessions s
	where s.id = p_session_id and s.profile_id = p_profile_id
	for update;
	if v_session.id is null then
		raise exception 'Surface session does not belong to profile' using errcode = '42501';
	end if;
	if v_session.state not in ('running', 'reconciling_running') or v_session.lease_token is distinct from p_lease_token then
		raise exception 'Surface session lease is not active' using errcode = '42501';
	end if;
	if coalesce(p_kind, 'git_range') = 'git_range' then
		if v_parent_sha is null then
			select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
			v_parent_sha := coalesce(
				(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
					where c.session_id = p_session_id and c.head_sha is not null
					order by c.seq desc limit 1),
				nullif(btrim(coalesce(v_session.branch_head_sha, '')), ''),
				nullif(btrim(coalesce(v_session.base_sha, '')), ''),
				nullif(btrim(coalesce(v_surface.live_head_sha, '')), '')
			);
		end if;
		if v_parent_sha is null or v_parent_sha !~ '^[0-9a-f]{40}$'
			or v_head_sha is null or v_head_sha !~ '^[0-9a-f]{40}$' then
			raise exception 'Git range change requires valid 40-hex parent and head commit SHAs' using errcode = '22023';
		end if;
	end if;
	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session
	);
	if coalesce(p_finish_session, false) then
		update public.qorpera_surface_sessions
		set wake_id = null
		where id = p_session_id;
	end if;
	return v_result;
end $$;
revoke all on function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid) to service_role;

create function public.qorpera_native_surface_read_session_turn(
	p_profile_id uuid,
	p_session_id uuid,
	p_lease_token uuid
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_conflict_paths text[];
begin
	if p_lease_token is null then
		raise exception 'Surface session turn read requires lease token' using errcode = '42501';
	end if;
	select * into v_session
	from public.qorpera_surface_sessions s
	where s.id = p_session_id and s.profile_id = p_profile_id;
	if v_session.id is null then
		raise exception 'Surface session does not belong to profile' using errcode = '42501';
	end if;
	if v_session.state not in ('running', 'reconciling_running') or v_session.lease_token is distinct from p_lease_token then
		raise exception 'Surface session lease is not active' using errcode = '42501';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id and profile_id = p_profile_id;
	if v_surface.id is null then
		raise exception 'Surface not found for profile' using errcode = 'P0002';
	end if;
	select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
	from public.qorpera_surface_changes c, unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
	where c.session_id = v_session.id and c.status = 'conflicted';
	return jsonb_build_object(
		'sessionId', v_session.id,
		'surfaceId', v_surface.id,
		'surfaceSlug', v_surface.slug,
		'surfaceTitle', v_surface.title,
		'sourceKind', v_surface.source_kind,
		'prompt', v_session.prompt,
		'state', case when v_session.state = 'reconciling_running' then 'reconciling' else 'queued' end,
		'repositoryKey', v_surface.repository_key,
		'folderRoot', v_surface.folder_root,
		'briefSummary', v_surface.brief_summary,
		'explorationVariantLabel', v_session.exploration_variant_label,
		'originKind', v_session.origin_kind,
		'originRef', v_session.origin_ref,
		'baseSha', v_session.base_sha,
		'branchHeadSha', v_session.branch_head_sha,
		'conflictPaths', to_jsonb(coalesce(v_conflict_paths, '{}'::text[]))
	);
end $$;
revoke all on function public.qorpera_native_surface_read_session_turn(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_read_session_turn(uuid, uuid, uuid) to service_role;

create function public.qorpera_native_surface_complete_turn(
	p_profile_id uuid,
	p_session_id uuid,
	p_state text,
	p_reply_text text default null,
	p_question jsonb default null,
	p_note_paths text[] default null,
	p_branch_head_sha text default null,
	p_lease_token uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_result jsonb;
begin
	if p_lease_token is null then
		raise exception 'Surface session completion requires lease token' using errcode = '42501';
	end if;
	if not exists (
		select 1 from public.qorpera_surface_sessions s
		where s.id = p_session_id and s.profile_id = p_profile_id
	) then
		raise exception 'Surface session does not belong to profile' using errcode = '42501';
	end if;
	v_result := public.qorpera_surface_complete_session_turn(
		p_session_id, p_state, p_reply_text, p_question, p_note_paths, p_branch_head_sha, p_lease_token
	);
	update public.qorpera_surface_sessions
	set wake_id = null
	where id = p_session_id;
	return v_result;
end $$;
revoke all on function public.qorpera_native_surface_complete_turn(uuid, uuid, text, text, jsonb, text[], text, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_complete_turn(uuid, uuid, text, text, jsonb, text[], text, uuid) to service_role;

create function public.qorpera_native_surface_renew_lease(
	p_profile_id uuid,
	p_session_id uuid,
	p_lease_token uuid,
	p_extend_seconds integer default 300
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	if not exists (
		select 1 from public.qorpera_surface_sessions s
		where s.id = p_session_id and s.profile_id = p_profile_id
	) then
		raise exception 'Surface session does not belong to profile' using errcode = '42501';
	end if;
	return public.qorpera_surface_renew_lease('session', p_session_id, p_lease_token, p_extend_seconds);
end $$;
revoke all on function public.qorpera_native_surface_renew_lease(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_renew_lease(uuid, uuid, uuid, integer) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_native_surface_describe_senses', 'profile'),
	('qorpera_native_surface_propose', 'profile'),
	('qorpera_native_surface_start_session', 'profile'),
	('qorpera_native_surface_manage_automation', 'profile'),
	('qorpera_native_surface_record_change', 'profile'),
	('qorpera_native_surface_read_session_turn', 'profile'),
	('qorpera_native_surface_complete_turn', 'profile'),
	('qorpera_native_surface_renew_lease', 'profile')
on conflict (name) do nothing;

create function public.qorpera_surface_save_folder_snapshot(
	p_profile_id uuid,
	p_surface_id uuid,
	p_snapshot_id text,
	p_folder_root text,
	p_change_ids uuid[],
	p_files_before jsonb,
	p_versions_after jsonb default null,
	p_after_content_sha256 jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	if p_profile_id is null or p_surface_id is null or nullif(btrim(coalesce(p_snapshot_id, '')), '') is null
		or p_files_before is null or jsonb_typeof(p_files_before) <> 'object' then
		raise exception 'Invalid folder snapshot payload' using errcode = '22023';
	end if;
	if not exists (
		select 1 from public.qorpera_surfaces s
		where s.id = p_surface_id and s.profile_id = p_profile_id
	) then
		raise exception 'Surface not found for profile' using errcode = 'P0002';
	end if;
	insert into public.qorpera_surface_folder_snapshots(
		profile_id, surface_id, snapshot_id, folder_root, change_ids,
		files_before, versions_after, after_content_sha256
	)
	values (
		p_profile_id, p_surface_id, btrim(p_snapshot_id), coalesce(p_folder_root, ''),
		coalesce(p_change_ids, '{}'), p_files_before, p_versions_after, p_after_content_sha256
	)
	on conflict (profile_id, surface_id, snapshot_id) do update
	set
		change_ids = excluded.change_ids,
		files_before = excluded.files_before,
		versions_after = coalesce(excluded.versions_after, public.qorpera_surface_folder_snapshots.versions_after),
		after_content_sha256 = coalesce(excluded.after_content_sha256, public.qorpera_surface_folder_snapshots.after_content_sha256);

	return jsonb_build_object('saved', true, 'snapshotId', btrim(p_snapshot_id));
end $$;
revoke all on function public.qorpera_surface_save_folder_snapshot(uuid, uuid, text, text, uuid[], jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_surface_save_folder_snapshot(uuid, uuid, text, text, uuid[], jsonb, jsonb, jsonb) to service_role;

create function public.qorpera_surface_load_folder_snapshot(
	p_profile_id uuid,
	p_surface_id uuid,
	p_change_id uuid default null,
	p_snapshot_id text default null
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_row public.qorpera_surface_folder_snapshots%rowtype;
begin
	if p_snapshot_id is not null and btrim(p_snapshot_id) <> '' then
		select * into v_row
		from public.qorpera_surface_folder_snapshots s
		where s.profile_id = p_profile_id
			and s.surface_id = p_surface_id
			and s.snapshot_id = btrim(p_snapshot_id)
		limit 1;
	elsif p_change_id is not null then
		select * into v_row
		from public.qorpera_surface_folder_snapshots s
		where s.profile_id = p_profile_id
			and s.surface_id = p_surface_id
			and p_change_id = any(s.change_ids)
		order by s.created_at desc
		limit 1;
	end if;
	if v_row.id is null then
		return null;
	end if;
	return jsonb_build_object(
		'snapshotId', v_row.snapshot_id,
		'surfaceId', v_row.surface_id,
		'profileId', v_row.profile_id,
		'folderRoot', v_row.folder_root,
		'changeIds', to_jsonb(v_row.change_ids),
		'filesBefore', v_row.files_before,
		'versionsAfter', v_row.versions_after,
		'afterContentSha256', v_row.after_content_sha256
	);
end $$;
revoke all on function public.qorpera_surface_load_folder_snapshot(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.qorpera_surface_load_folder_snapshot(uuid, uuid, uuid, text) to service_role;

create function public.qorpera_surface_update_rebased_changes(
	p_surface_id uuid,
	p_session_id uuid,
	p_branch_head_sha text default null,
	p_rebased_changes jsonb default '[]'::jsonb,
	p_conflicted_change_id uuid default null,
	p_conflict_paths text[] default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_item jsonb;
	v_updated integer := 0;
	v_now timestamptz := clock_timestamp();
begin
	if p_surface_id is null or p_session_id is null then
		raise exception 'Surface and session IDs are required' using errcode = '22023';
	end if;
	-- WHY: Lock session -> surface -> changes (by seq) to match qorpera_approve_surface_change and avoid 40P01 deadlocks.
	perform 1
	from public.qorpera_surface_sessions s
	where s.id = p_session_id and s.surface_id = p_surface_id
	for update;
	if not found then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	perform 1
	from public.qorpera_surfaces sf
	where sf.id = p_surface_id
	for update;
	perform 1
	from public.qorpera_surface_changes c
	where c.surface_id = p_surface_id and c.session_id = p_session_id
	order by c.seq asc
	for update;

	for v_item in
		select elem from jsonb_array_elements(coalesce(p_rebased_changes, '[]'::jsonb)) elem
	loop
		update public.qorpera_surface_changes c
		set
			parent_sha = coalesce(nullif(v_item ->> 'parentSha', ''), c.parent_sha),
			head_sha = coalesce(nullif(v_item ->> 'headSha', ''), c.head_sha),
			status = case when c.status = 'conflicted' then 'staged' else c.status end,
			conflict_paths = case when c.status = 'conflicted' then '{}' else c.conflict_paths end
		where c.id = (v_item ->> 'changeId')::uuid
			and c.surface_id = p_surface_id
			and c.session_id = p_session_id
			and c.status in ('staged', 'conflicted');
		if found then
			v_updated := v_updated + 1;
		end if;
	end loop;

	if p_conflicted_change_id is not null then
		update public.qorpera_surface_changes c
		set
			status = 'conflicted',
			conflict_paths = coalesce(p_conflict_paths, '{}')
		where c.id = p_conflicted_change_id
			and c.surface_id = p_surface_id
			and c.session_id = p_session_id
			and c.status in ('staged', 'conflicted');
	end if;

	if p_branch_head_sha is not null and btrim(p_branch_head_sha) <> '' then
		update public.qorpera_surface_sessions s
		set
			branch_head_sha = btrim(p_branch_head_sha),
			updated_at = v_now
		where s.id = p_session_id and s.surface_id = p_surface_id;
	end if;

	perform public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return jsonb_build_object('updated', v_updated, 'sessionId', p_session_id);
end $$;
revoke all on function public.qorpera_surface_update_rebased_changes(uuid, uuid, text, jsonb, uuid, text[]) from public, anon, authenticated;
grant execute on function public.qorpera_surface_update_rebased_changes(uuid, uuid, text, jsonb, uuid, text[]) to service_role;

create function public.qorpera_surface_site_version_begin(
	p_surface_id uuid,
	p_tree text,
	p_main_sha text,
	p_manifest_sha256 text,
	p_file_count integer,
	p_total_bytes bigint,
	p_title text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site_id uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_version public.qorpera_company_site_versions%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if p_surface_id is null
		or coalesce(p_tree, '') !~ '^[0-9a-f]{40}$'
		or coalesce(p_main_sha, '') !~ '^[0-9a-f]{40}$'
		or coalesce(p_manifest_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_file_count is null or p_file_count not between 1 and 500
		or p_total_bytes is null or p_total_bytes not between 0 and 104857600 then
		raise exception 'Invalid surface site version begin arguments' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	v_site_id := coalesce(v_surface.site_id, public.qorpera_surface_ensure_site(p_surface_id));
	if v_site_id is null then
		raise exception 'Surface site could not be provisioned' using errcode = '55000';
	end if;
	select * into v_site from public.qorpera_company_sites where id = v_site_id for update;
	if v_site.id is null or v_site.taken_down_at is not null then
		return jsonb_build_object('state', 'refused', 'code', 'SITE_TAKEN_DOWN');
	end if;

	select * into v_version
	from public.qorpera_company_site_versions
	where site_id = v_site.id and tree = p_tree
	for update;

	if found then
		if v_version.manifest_sha256 <> p_manifest_sha256
			or v_version.file_count <> p_file_count
			or v_version.total_bytes <> p_total_bytes then
			if v_version.state = 'uploading' then
				delete from public.qorpera_company_site_versions where id = v_version.id;
				v_version := null;
			else
				return jsonb_build_object('state', 'refused', 'code', 'SITE_TREE_DIFFERS');
			end if;
		end if;
	end if;

	if v_version.id is null then
		insert into public.qorpera_company_site_versions(
			site_id, first_publish, title, source_path, manifest_sha256,
			file_count, total_bytes, tree, change, main_sha, listed
		)
		values (
			v_site.id,
			v_site.current_version_id is null,
			coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_surface.title),
			v_site.source_path,
			p_manifest_sha256,
			p_file_count,
			p_total_bytes,
			p_tree,
			1,
			p_main_sha,
			false
		)
		returning * into v_version;
		update public.qorpera_company_sites set updated_at = v_now where id = v_site.id;
	end if;

	return jsonb_build_object(
		'state', v_version.state,
		'versionId', v_version.id,
		'siteId', v_site.id,
		'siteSlug', v_site.slug,
		'listed', v_version.listed
	);
end $$;
revoke all on function public.qorpera_surface_site_version_begin(uuid, text, text, text, integer, bigint, text) from public, anon, authenticated;
grant execute on function public.qorpera_surface_site_version_begin(uuid, text, text, text, integer, bigint, text) to service_role;

create function public.qorpera_surface_site_version_list(p_version_id uuid, p_files jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_version public.qorpera_company_site_versions%rowtype;
	v_item jsonb;
	v_file public.qorpera_company_site_files%rowtype;
	v_refusal jsonb;
	v_count integer;
	v_total bigint;
	v_manifest text;
begin
	if p_version_id is null or jsonb_typeof(p_files) is distinct from 'object'
		or not p_files ?& array['files', 'last']
		or jsonb_typeof(p_files -> 'last') is distinct from 'boolean'
		or jsonb_typeof(p_files -> 'files') is distinct from 'array'
		or jsonb_array_length(p_files -> 'files') > 150 then
		raise exception 'Invalid surface site version list payload' using errcode = '22023';
	end if;
	select * into v_version from public.qorpera_company_site_versions where id = p_version_id for update;
	if v_version.id is null then
		return jsonb_build_object('state', 'lost');
	end if;
	if v_version.listed or v_version.state <> 'uploading' then
		return jsonb_build_object(
			'state', 'listed',
			'missing', (select count(*) from public.qorpera_company_site_files f where f.version_id = v_version.id and f.content is null)
		);
	end if;

	for v_item in
		select item.value from jsonb_array_elements(p_files -> 'files') with ordinality item(value, place)
		order by item.place
	loop
		if not public.qorpera_site_path_valid(v_item ->> 'path')
			or public.qorpera_site_content_type(v_item ->> 'path') is null
			or (case when v_item ->> 'bytes' ~ '^[0-9]{1,8}$' then (v_item ->> 'bytes')::integer > 10485760 else true end)
			or coalesce(v_item ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
			v_refusal := jsonb_build_object('code', 'SITE_FILE_REFUSED', 'path', v_item ->> 'path');
			exit;
		end if;
		insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type)
		values (
			v_version.id,
			v_item ->> 'path',
			(v_item ->> 'bytes')::integer,
			v_item ->> 'sha256',
			public.qorpera_site_content_type(v_item ->> 'path')
		)
		on conflict (version_id, path) do nothing;
		select * into v_file from public.qorpera_company_site_files f
		where f.version_id = v_version.id and f.path = v_item ->> 'path';
		if v_file.bytes <> (v_item ->> 'bytes')::integer or v_file.sha256 <> v_item ->> 'sha256' then
			v_refusal := jsonb_build_object('code', 'SITE_FILE_REFUSED', 'path', v_item ->> 'path');
			exit;
		end if;
	end loop;

	select count(*), coalesce(sum(file.bytes), 0), encode(
		extensions.digest(
			convert_to(
				string_agg(file.path || chr(9) || file.sha256 || chr(9) || file.bytes::text, chr(10) order by file.path collate "C"),
				'utf8'
			),
			'sha256'
		),
		'hex'
	)
	into v_count, v_total, v_manifest
	from public.qorpera_company_site_files file
	where file.version_id = v_version.id;

	if v_refusal is null and (
		v_count > v_version.file_count
		or ((p_files -> 'last')::boolean and (
			v_count <> v_version.file_count
			or v_total <> v_version.total_bytes
			or v_manifest is distinct from v_version.manifest_sha256
			or not exists (
				select 1 from public.qorpera_company_site_files file
				where file.version_id = v_version.id and file.path = 'index.html'
			)
		))
	) then
		v_refusal := jsonb_build_object('code', 'SITE_MANIFEST_DIFFERS', 'path', null);
	end if;

	if v_refusal is not null then
		delete from public.qorpera_company_site_files where version_id = v_version.id;
		return jsonb_build_object('state', 'refused') || v_refusal;
	end if;

	if (p_files -> 'last')::boolean then
		update public.qorpera_company_site_files file set content = source.content
		from (
			select distinct on (other.sha256, other.bytes) other.sha256, other.bytes, other.version_id, other.path
			from public.qorpera_company_site_files other
			join public.qorpera_company_site_versions ver on ver.id = other.version_id
			where ver.site_id = v_version.site_id and ver.id <> v_version.id and other.content is not null
			order by other.sha256, other.bytes, other.version_id
		) kept
		join public.qorpera_company_site_files source on source.version_id = kept.version_id and source.path = kept.path
		where file.version_id = v_version.id
			and file.content is null
			and kept.sha256 = file.sha256
			and kept.bytes = file.bytes;
		update public.qorpera_company_site_versions set listed = true where id = v_version.id;
	end if;

	return jsonb_build_object(
		'state', case when (p_files -> 'last')::boolean then 'listed' else 'listing' end,
		'missing', (select count(*) from public.qorpera_company_site_files file where file.version_id = v_version.id and file.content is null)
	);
end $$;
revoke all on function public.qorpera_surface_site_version_list(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_surface_site_version_list(uuid, jsonb) to service_role;

create function public.qorpera_surface_site_version_put(p_version_id uuid, p_parts jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_version public.qorpera_company_site_versions%rowtype;
	v_item jsonb;
	v_file public.qorpera_company_site_files%rowtype;
	v_content bytea;
	v_part integer;
	v_of integer;
	v_have integer;
	v_size bigint;
	v_filed integer := 0;
begin
	if p_version_id is null or jsonb_typeof(p_parts) is distinct from 'object'
		or jsonb_typeof(p_parts -> 'parts') is distinct from 'array'
		or jsonb_array_length(p_parts -> 'parts') not between 1 and 500 then
		raise exception 'Invalid surface site version put payload' using errcode = '22023';
	end if;
	select * into v_version from public.qorpera_company_site_versions where id = p_version_id for update;
	if v_version.id is null then
		return jsonb_build_object('state', 'lost');
	end if;
	if v_version.state <> 'uploading' then
		return jsonb_build_object('state', 'kept', 'filed', 0);
	end if;

	for v_item in
		select item.value from jsonb_array_elements(p_parts -> 'parts') with ordinality item(value, place)
		order by item.place
	loop
		begin
			v_content := decode(v_item ->> 'contentBase64', 'base64');
		exception when others then
			raise exception 'Invalid base64 content in surface site version put' using errcode = '22023';
		end;
		if octet_length(v_content) > 131072 then
			raise exception 'Part exceeds 128 KiB limit' using errcode = '22023';
		end if;
		v_part := (v_item ->> 'part')::integer;
		v_of := (v_item ->> 'of')::integer;
		if v_of not between 1 and 128 or v_part < 0 or v_part >= v_of then
			raise exception 'Invalid part indices' using errcode = '22023';
		end if;

		v_file := null;
		select * into v_file from public.qorpera_company_site_files file
		where file.version_id = v_version.id and file.path = v_item ->> 'path';
		if v_file.path is null then
			return jsonb_build_object('state', 'refused', 'code', 'SITE_FILE_DIFFERS', 'path', v_item ->> 'path');
		end if;
		continue when v_file.content is not null;

		if not exists (
			select 1 from public.qorpera_company_site_file_parts kept
			where kept.version_id = v_version.id and kept.path = v_file.path and kept.of <> v_of
		) then
			insert into public.qorpera_company_site_file_parts(version_id, path, part, of, content)
			values (v_version.id, v_file.path, v_part, v_of, v_content)
			on conflict (version_id, path, part) do nothing;
			select count(*), coalesce(sum(octet_length(kept.content)), 0)
			into v_have, v_size
			from public.qorpera_company_site_file_parts kept
			where kept.version_id = v_version.id and kept.path = v_file.path;
		end if;
		if v_have is null or v_size > v_file.bytes then
			delete from public.qorpera_company_site_file_parts kept
			where kept.version_id = v_version.id and kept.path = v_file.path;
			return jsonb_build_object('state', 'refused', 'code', 'SITE_FILE_DIFFERS', 'path', v_file.path);
		end if;
		if v_have = v_of then
			select string_agg(kept.content, ''::bytea order by kept.part) into v_content
			from public.qorpera_company_site_file_parts kept
			where kept.version_id = v_version.id and kept.path = v_file.path;
			delete from public.qorpera_company_site_file_parts kept
			where kept.version_id = v_version.id and kept.path = v_file.path;
			if octet_length(v_content) <> v_file.bytes
				or encode(extensions.digest(v_content, 'sha256'), 'hex') <> v_file.sha256 then
				return jsonb_build_object('state', 'refused', 'code', 'SITE_FILE_DIFFERS', 'path', v_file.path);
			end if;
			update public.qorpera_company_site_files file
			set content = v_content
			where file.version_id = v_version.id and file.path = v_file.path;
			v_filed := v_filed + 1;
		end if;
		v_have := null;
		v_size := null;
	end loop;

	return jsonb_build_object('state', 'kept', 'filed', v_filed);
end $$;
revoke all on function public.qorpera_surface_site_version_put(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_surface_site_version_put(uuid, jsonb) to service_role;

create function public.qorpera_surface_site_version_finish(
	p_version_id uuid,
	p_promote_live boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_version public.qorpera_company_site_versions%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if p_version_id is null then
		raise exception 'Version id is required' using errcode = '22023';
	end if;
	select * into v_version from public.qorpera_company_site_versions where id = p_version_id for update;
	if v_version.id is null then
		return jsonb_build_object('state', 'lost');
	end if;
	select * into v_site from public.qorpera_company_sites where id = v_version.site_id for update;
	if v_site.id is null or v_site.taken_down_at is not null then
		return jsonb_build_object('state', 'refused', 'code', 'SITE_TAKEN_DOWN');
	end if;

	if v_version.state = 'uploading' then
		if not v_version.listed or exists (
			select 1 from public.qorpera_company_site_files file
			where file.version_id = v_version.id and file.content is null
		) then
			return jsonb_build_object('state', 'refused', 'code', 'SITE_UPLOAD_INCOMPLETE');
		end if;
		update public.qorpera_company_site_versions set state = 'ready' where id = v_version.id;
		v_version.state := 'ready';
	end if;

	if coalesce(p_promote_live, false) and v_version.state <> 'live' then
		update public.qorpera_company_site_versions
		set state = 'kept'
		where site_id = v_site.id and state = 'live' and id <> v_version.id;

		update public.qorpera_company_site_versions
		set state = 'live', published_at = coalesce(published_at, v_now)
		where id = v_version.id;
		v_version.state := 'live';

		update public.qorpera_company_sites
		set
			current_version_id = v_version.id,
			title = v_version.title,
			published_at = v_now,
			published_by_user_id = null,
			published_by_staff_agent_id = v_site.created_by_staff_agent_id,
			updated_at = v_now
		where id = v_site.id;
	end if;

	perform public.qorpera_code_site_prune(v_site.id);

	return jsonb_build_object(
		'state', v_version.state,
		'versionId', v_version.id,
		'siteId', v_site.id,
		'siteSlug', v_site.slug
	);
end $$;
revoke all on function public.qorpera_surface_site_version_finish(uuid, boolean) from public, anon, authenticated;
grant execute on function public.qorpera_surface_site_version_finish(uuid, boolean) to service_role;

-- WHY: Enqueues a governed 'surface-session' wake occurrence for a leased surface session so turns materialize and run inside Qorpera's standard isolated sandbox with sponsor billing and zero service key exposure.
create function public.qorpera_surface_enqueue_session_run(
	p_session_id uuid,
	p_lease_token uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_existing_wake public.qorpera_wake_occurrences%rowtype;
	v_cofounder public.qorpera_company_cofounders%rowtype;
	v_requester uuid;
	v_sponsor jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_member_initiated boolean;
	v_reason text;
	v_now timestamptz := clock_timestamp();
begin
	if not public.qorpera_surfaces_enabled() then
		return jsonb_build_object('status', 'unavailable', 'reason', 'surfaces_disabled');
	end if;
	if p_session_id is null or p_lease_token is null then
		raise exception 'Session ID and lease token are required' using errcode = '22023';
	end if;

	-- WHY: Read session metadata without locking and enter the folder fence before locking qorpera_surface_sessions to prevent deadlocks with company deletion purge.
	select * into v_peek
	from public.qorpera_surface_sessions
	where id = p_session_id;
	if v_peek.id is null or v_peek.state not in ('running', 'reconciling_running')
		or v_peek.lease_token is distinct from p_lease_token then
		return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
	end if;

	select * into v_cofounder
	from public.qorpera_company_cofounders
	where profile_id = v_peek.profile_id
	limit 1;
	if v_cofounder.profile_id is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_cofounder');
	end if;

	if not public.qorpera_company_is_folder_v2(v_peek.profile_id) then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_substrate');
	end if;

	v_member_initiated := v_peek.origin_kind in ('member', 'point_to_change', 'cross_surface')
		and v_peek.created_by_user_id is not null;
	if v_member_initiated then
		select m.user_id into v_requester
		from public.qorpera_profile_members m
		where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id;
	else
		v_requester := coalesce(
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id),
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id and m.user_id = v_cofounder.created_by_user_id),
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id order by (m.role = 'owner') desc, m.joined_at asc limit 1)
		);
	end if;
	if v_requester is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_member');
	end if;

	begin
		perform public.qorpera_folder_company_enter(
			v_cofounder.environment_id,
			v_peek.profile_id,
			jsonb_build_array(
				jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
					'key', v_peek.profile_id::text || ':' || v_requester::text, 'mode', 'keyshare', 'required', true),
				jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
					'key', v_peek.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false),
				jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
					'key', v_peek.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false)
			),
			true
		);
	exception when sqlstate '55000' then
		update public.qorpera_surface_sessions
		set
			state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
			lease_token = null,
			wake_id = null,
			lease_expires_at = v_now + interval '15 seconds',
			updated_at = v_now
		where id = p_session_id
			and state in ('running', 'reconciling_running')
			and lease_token = p_lease_token;
		return jsonb_build_object('status', 'deferred', 'reason', 'paused', 'retryAfterSeconds', 15);
	end;

	select * into v_session
	from public.qorpera_surface_sessions
	where id = p_session_id
	for update;
	if v_session.id is null or v_session.state not in ('running', 'reconciling_running')
		or v_session.lease_token is distinct from p_lease_token then
		return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
	end if;

	if public.qorpera_surface_company_paused(v_session.profile_id) then
		update public.qorpera_surface_sessions
		set
			state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
			lease_token = null,
			wake_id = null,
			lease_expires_at = v_now + interval '15 seconds',
			updated_at = v_now
		where id = v_session.id;
		return jsonb_build_object('status', 'deferred', 'reason', 'paused', 'retryAfterSeconds', 15);
	end if;

	if v_session.wake_id is not null then
		select * into v_existing_wake from public.qorpera_wake_occurrences where id = v_session.wake_id;
		if v_existing_wake.id is not null and v_existing_wake.status in ('queued', 'materialized') then
			return jsonb_build_object(
				'status', 'enqueued',
				'wakeId', v_existing_wake.id,
				'runId', v_existing_wake.run_id
			);
		end if;
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
	if v_surface.id is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'surface_missing');
	end if;

	v_sponsor := public.qorpera_surface_resolve_sponsor(v_session.profile_id, v_requester);
	if v_sponsor is null
		or nullif(v_sponsor ->> 'sponsorBindingId', '') is null
		or nullif(v_sponsor ->> 'sponsorVersion', '') is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_sponsor');
	end if;

	begin
		perform public.qorpera_folder_admit_wakes(v_session.profile_id);
		insert into public.qorpera_wake_occurrences(
			id, profile_id, environment_id, wake_kind, source_kind, source_id,
			trigger_id, occurrence_key, scheduled_for, not_before
		)
		values (
			extensions.gen_random_uuid(),
			v_session.profile_id,
			v_cofounder.environment_id,
			'agent',
			'surface-session',
			v_session.id,
			'surface-session',
			'surface-session:' || v_session.id::text || ':' || p_lease_token::text,
			v_now,
			v_now
		)
		returning * into v_wake;
	exception when insufficient_privilege then
		v_reason := case
			when sqlerrm = 'No model account can pay for this work' then 'no_sponsor'
			when sqlerrm = 'Wake surface session requester is unavailable' then 'no_member'
			when sqlerrm = 'Wake surface session is unavailable' then 'session_unavailable'
			else 'unavailable'
		end;
		return jsonb_build_object('status', 'unavailable', 'reason', v_reason);
	end;

	if v_wake.status <> 'queued' then
		update public.qorpera_surface_sessions
		set
			state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
			lease_token = null,
			wake_id = null,
			lease_expires_at = v_now + interval '15 seconds',
			updated_at = v_now
		where id = v_session.id;
		return jsonb_build_object('status', 'deferred', 'reason', 'paused', 'retryAfterSeconds', 15);
	end if;

	update public.qorpera_surface_sessions
	set
		wake_id = v_wake.id,
		lease_expires_at = greatest(coalesce(lease_expires_at, v_now), v_now + interval '10 minutes'),
		updated_at = v_now
	where id = v_session.id;

	return jsonb_build_object(
		'status', 'enqueued',
		'wakeId', v_wake.id,
		'runId', v_wake.run_id
	);
end $$;
revoke all on function public.qorpera_surface_enqueue_session_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_enqueue_session_run(uuid, uuid) to service_role;

select pg_temp.shw_replace('public.qorpera_pin_wake_occurrence()'::regprocedure, array[
	array[$old$	v_la_ask public.qorpera_light_asks%rowtype;$old$,
		$new$	v_la_ask public.qorpera_light_asks%rowtype;
	v_surf_session public.qorpera_surface_sessions%rowtype; v_surf public.qorpera_surfaces%rowtype;
	v_surf_cofounder public.qorpera_company_cofounders%rowtype; v_surf_sponsor jsonb;
	v_surf_member_initiated boolean;$new$],
	array[$old$	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$old$,
		$new$	elsif new.wake_kind = 'agent' and new.source_kind = 'surface-session' then
		-- WHY: 20260930844000 pins surface session turn wake with fixed-size metadata; full prompt and brief are fetched through qorpera_native_surface_read_session_turn.
		select * into v_surf_session from public.qorpera_surface_sessions s
		where s.id = new.source_id and s.profile_id = new.profile_id
			and s.state in ('running', 'reconciling_running') and s.lease_token is not null;
		select * into v_surf from public.qorpera_surfaces surf
		where surf.id = v_surf_session.surface_id and surf.profile_id = new.profile_id;
		select * into v_surf_cofounder from public.qorpera_company_cofounders c
		where c.profile_id = new.profile_id and c.environment_id = new.environment_id;
		if not public.qorpera_company_is_folder_v2(new.profile_id)
			or v_surf_session.id is null or v_surf.id is null or v_surf_cofounder.staff_agent_id is null
			or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null then
			raise exception 'Wake surface session is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := v_surf_cofounder.staff_agent_id;
		v_surf_member_initiated := v_surf_session.origin_kind in ('member', 'point_to_change', 'cross_surface')
			and v_surf_session.created_by_user_id is not null;
		if v_surf_member_initiated then
			select m.user_id into new.requested_by_user_id
			from public.qorpera_profile_members m
			where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id;
		else
			new.requested_by_user_id := coalesce(
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id),
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id and m.user_id = v_surf_cofounder.created_by_user_id),
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id order by (m.role = 'owner') desc, m.joined_at asc limit 1)
			);
		end if;
		if new.requested_by_user_id is null then
			raise exception 'Wake surface session requester is unavailable' using errcode = '42501'; end if;
		new.trigger_id := 'surface-session';
		new.occurrence_key := 'surface-session:' || v_surf_session.id::text || ':' || v_surf_session.lease_token::text;
		new.payload := jsonb_build_object(
			'schema', 'qorpera.surface-session-wake/v1',
			'surfaceSessionId', v_surf_session.id,
			'surfaceId', v_surf.id,
			'profileId', v_surf_session.profile_id,
			'surfaceSlug', v_surf.slug,
			'sourceKind', v_surf.source_kind,
			'originKind', v_surf_session.origin_kind,
			'memberInitiated', v_surf_member_initiated,
			'leaseToken', v_surf_session.lease_token
		);
		v_surf_sponsor := public.qorpera_surface_resolve_sponsor(new.profile_id, new.requested_by_user_id);
		if v_surf_sponsor is null
			or nullif(v_surf_sponsor ->> 'sponsorBindingId', '') is null
			or nullif(v_surf_sponsor ->> 'sponsorVersion', '') is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		new.sponsor_binding_id := (v_surf_sponsor ->> 'sponsorBindingId')::uuid;
		new.sponsor_version := (v_surf_sponsor ->> 'sponsorVersion')::integer;
		new.logical_computer_id := null;
		new.session_id := null;
		v_actor := null;
	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$new$]
]);

select pg_temp.shw_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure, array[
	array[$old$		if p_wake.source_kind = 'human-task' then$old$,
		$new$		-- WHY: 20260930844000 authorizes wake against its leased surface session.
		if p_wake.source_kind = 'surface-session' then
			if p_wake.parent_run_id is not null or p_wake.session_id is not null
				or not exists (
					select 1 from public.qorpera_surface_sessions s
					where s.id = p_wake.source_id
						and s.profile_id = p_wake.profile_id
						and s.wake_id = p_wake.id
						and (p_wake.run_id is not null or s.state in ('running', 'reconciling_running'))
				) then
				return false; end if;
			v_ancestry := public.qorpera_wake_ancestry(null, null, p_wake.staff_agent_id, p_wake.id);
			return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
				and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
		end if;
		if p_wake.source_kind = 'human-task' then$new$]
]);

select pg_temp.shw_replace('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure, array[
	array[$old$			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$old$,
		$new$			-- WHY: 20260930844000 requires linked surface session, no parent and no conversation.
			or (v_wake.source_kind = 'surface-session' and (v_wake.parent_run_id is not null or v_wake.session_id is not null
				or not exists (select 1 from public.qorpera_surface_sessions s where s.id = v_wake.source_id and s.wake_id = v_wake.id)))
			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$new$],
	array[$old$					'human-task','machine-checkin','light-ask'))))) -- 20260930098000$old$,
		$new$					'human-task','machine-checkin','light-ask','surface-session'))))) -- 20260930098000$new$]
]);

select pg_temp.shw_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure, array[
	array[$old$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask') /* 20260930761000 */ then '{}'::jsonb$old$,
		$new$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask','surface-session') then '{}'::jsonb$new$]
]);

select pg_temp.shw_replace('public.qorpera_folder_materialize_company(uuid, integer)'::regprocedure, array[
	array[$old$					and (v_wake.wake_kind = 'room' or v_wake.source_kind = 'light-ask'
						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($old$,
		$new$					and (v_wake.wake_kind = 'room' or v_wake.source_kind = 'light-ask'
						or (v_wake.source_kind = 'surface-session'
							and coalesce(v_wake.payload ->> 'originKind', '') in ('member', 'point_to_change', 'cross_surface')
							and coalesce((v_wake.payload ->> 'memberInitiated')::boolean, false)
							and exists (
								select 1 from public.qorpera_surface_sessions s
								where s.id = v_wake.source_id and s.profile_id = v_wake.profile_id
									and s.origin_kind in ('member', 'point_to_change', 'cross_surface')
									and s.created_by_user_id is not null
									and s.created_by_user_id = v_wake.requested_by_user_id
							))
						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($new$]
]);

select pg_temp.shw_replace('public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure, array[
	array[$old$	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;$old$,
		$new$	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;
	-- WHY: 20260930844000 only member-initiated surface sessions with matching requester bypass unattended autonomy requirements.
	if p_run.source_kind = 'wake' and exists (
		select 1 from public.qorpera_wake_occurrences w
		join public.qorpera_surface_sessions s on s.id = w.source_id and s.profile_id = w.profile_id
		where w.id = p_run.source_id and (w.run_id is null or w.run_id = p_run.id) and w.wake_kind = 'agent'
			and w.source_kind = 'surface-session' and w.profile_id = p_run.profile_id
			and s.origin_kind in ('member', 'point_to_change', 'cross_surface')
			and s.created_by_user_id is not null
			and s.created_by_user_id = p_run.requested_by_user_id
	) then return true; end if;$new$]
]);

create function public.qorpera_surface_trigger_automation(p_automation_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_auto public.qorpera_surface_automations%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_session jsonb;
begin
	if not public.qorpera_surfaces_enabled() then
		return jsonb_build_object('status', 'skipped', 'reason', 'surfaces_disabled');
	end if;
	if p_automation_id is null then
		raise exception 'Automation ID is required' using errcode = '22023';
	end if;
	select * into v_auto from public.qorpera_surface_automations where id = p_automation_id;
	if v_auto.id is null or not v_auto.enabled then
		return jsonb_build_object('status', 'skipped', 'reason', 'not_found_or_disabled');
	end if;
	if public.qorpera_surface_company_paused(v_auto.profile_id) then
		return jsonb_build_object('status', 'skipped', 'reason', 'paused');
	end if;

	if v_auto.target_surface_slug is not null then
		select * into v_surface
		from public.qorpera_surfaces s
		where s.profile_id = v_auto.profile_id
			and s.slug = v_auto.target_surface_slug
			and s.status = 'active'
		limit 1;
	end if;
	if v_surface.id is null then
		select * into v_surface
		from public.qorpera_surfaces s
		where s.profile_id = v_auto.profile_id and s.status = 'active'
		order by s.sort_order asc, s.created_at asc
		limit 1;
	end if;
	if v_surface.id is null then
		return jsonb_build_object('status', 'skipped', 'reason', 'no_target_surface');
	end if;

	v_session := public.qorpera_service_start_surface_session(
		v_auto.profile_id,
		v_surface.id,
		v_auto.prompt,
		v_auto.title,
		'automation',
		v_auto.title,
		null,
		null,
		null
	);
	return jsonb_build_object('status', 'started', 'session', v_session);
end $$;
revoke all on function public.qorpera_surface_trigger_automation(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_trigger_automation(uuid) to service_role;

-- WHY: Splits surface job claiming by host trust lane (sessions, folder, code_repo, or all) so orchestrator, object-gateway, and coding-executor only claim work they can execute without cross-host credentials.
create function public.qorpera_surface_claim_pending_jobs_for_lane(
	p_limit integer default 16,
	p_lane text default 'all'
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_cap integer := greatest(1, least(coalesce(p_limit, 16), 64));
	v_lane text := lower(btrim(coalesce(p_lane, 'all')));
	v_now timestamptz := clock_timestamp();
	v_lease timestamptz := v_now + interval '5 minutes';
	v_expired_session record;
	v_expired_job record;
	v_automations jsonb := '[]'::jsonb;
	v_sessions jsonb := '[]'::jsonb;
	v_previews jsonb := '[]'::jsonb;
	v_merges jsonb := '[]'::jsonb;
	v_publishes jsonb := '[]'::jsonb;
begin
	if v_lane not in ('all', 'sessions', 'folder', 'code_repo') then
		raise exception 'Invalid surface claim lane: %', v_lane using errcode = '22023';
	end if;
	if not public.qorpera_surfaces_enabled() then
		return jsonb_build_object(
			'sessions', '[]'::jsonb,
			'previews', '[]'::jsonb,
			'merges', '[]'::jsonb,
			'publishes', '[]'::jsonb,
			'automations', '[]'::jsonb
		);
	end if;

	if v_lane in ('all', 'sessions') then
		for v_expired_session in
			select s.*
			from public.qorpera_surface_sessions s
			left join public.qorpera_wake_occurrences wk on wk.id = s.wake_id
			where s.state in ('running', 'reconciling_running')
				and (
					(s.wake_id is null and s.lease_expires_at is not null and s.lease_expires_at <= v_now)
					or (s.wake_id is not null and (
						wk.id is null
						or wk.status in ('failed', 'cancelled', 'completed', 'requires_review')
						or (wk.status = 'materialized' and s.lease_expires_at is not null and s.lease_expires_at <= v_now)
						or (wk.status = 'queued' and wk.created_at <= v_now - interval '30 minutes')
					))
				)
			order by coalesce(s.lease_expires_at, s.updated_at) asc
			limit v_cap
			for update of s skip locked
		loop
			if v_expired_session.retry_count < 1 then
				update public.qorpera_surface_sessions
				set
					state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
					retry_count = retry_count + 1,
					lease_expires_at = null,
					lease_token = null,
					wake_id = null,
					updated_at = v_now
				where id = v_expired_session.id;

				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (
					v_expired_session.profile_id,
					v_expired_session.id,
					'system',
					'Worker lease expired; automatically retrying session turn.'
				);
			else
				update public.qorpera_surface_sessions
				set
					state = 'failed',
					lease_expires_at = null,
					lease_token = null,
					wake_id = null,
					updated_at = v_now
				where id = v_expired_session.id;

				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (
					v_expired_session.profile_id,
					v_expired_session.id,
					'system',
					'Session timed out after worker retry. Reply to retry.'
				);
			end if;
		end loop;
	end if;

	if v_lane in ('all', 'code_repo') then
		with expired_previews as (
			select p.id
			from public.qorpera_surface_previews p
			where p.status = 'building'
				and p.lease_expires_at is not null
				and p.lease_expires_at <= v_now
				and p.expires_at > v_now
			order by p.lease_expires_at asc
			limit v_cap
			for update skip locked
		)
		update public.qorpera_surface_previews p
		set status = 'composing', lease_expires_at = null, lease_token = null
		from expired_previews
		where p.id = expired_previews.id;
	end if;

	for v_expired_job in
		select j.*
		from public.qorpera_surface_jobs j
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.status = 'running'
			and j.lease_expires_at is not null
			and j.lease_expires_at <= v_now
			and (
				v_lane = 'all'
				or (v_lane = 'sessions' and surf.source_kind = 'native_ops')
				or (v_lane = 'folder' and surf.source_kind = 'folder')
				or (v_lane = 'code_repo' and surf.source_kind = 'code_repo')
			)
		order by j.lease_expires_at asc
		limit v_cap
		for update of j skip locked
	loop
		if v_expired_job.attempts >= 3 then
			update public.qorpera_surface_jobs
			set
				status = 'failed',
				error_detail = coalesce(error_detail, 'Worker lease expired after max attempts'),
				lease_expires_at = null,
				lease_token = null,
				completed_at = v_now,
				updated_at = v_now
			where id = v_expired_job.id;

			if v_expired_job.kind = 'land_change' then
				update public.qorpera_surface_changes
				set status = 'staged'
				where id in (
					select x::uuid
					from jsonb_array_elements_text(coalesce(v_expired_job.payload -> 'changeIds', '[]'::jsonb)) as x
				) and surface_id = v_expired_job.surface_id and status = 'merging';

				if v_expired_job.session_id is not null then
					perform public.qorpera_evaluate_surface_session_lifecycle(v_expired_job.session_id);
				end if;
			elsif v_expired_job.kind = 'undo_change' then
				if v_expired_job.session_id is not null then
					insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
					values (
						v_expired_job.profile_id,
						v_expired_job.session_id,
						'system',
						'Rollback worker lease expired after max attempts. Verify surface state or re-apply the staged change.'
					);
					perform public.qorpera_evaluate_surface_session_lifecycle(v_expired_job.session_id);
				end if;
			elsif v_expired_job.kind = 'publish_surface' then
				update public.qorpera_surfaces
				set
					publish_status = 'failed',
					last_publish_error = 'Publish worker lease expired',
					updated_at = v_now
				where id = v_expired_job.surface_id;
			end if;
		else
			update public.qorpera_surface_jobs
			set
				status = 'queued',
				lease_expires_at = null,
				lease_token = null,
				updated_at = v_now
			where id = v_expired_job.id;
		end if;
	end loop;

	if v_lane in ('all', 'sessions') then
		v_automations := public.qorpera_surface_claim_due_automations(v_cap);

		with picked as (
			select s.id
			from public.qorpera_surface_sessions s
			where s.state in ('queued', 'reconciling')
				and (s.lease_expires_at is null or s.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(s.profile_id)
			order by s.created_at asc
			limit v_cap
			for update skip locked
		),
		claimed as (
			update public.qorpera_surface_sessions s
			set
				state = case when s.state = 'reconciling' then 'reconciling_running' else 'running' end,
				lease_expires_at = v_lease,
				lease_token = extensions.gen_random_uuid(),
				wake_id = null,
				updated_at = v_now
			from picked
			where s.id = picked.id
			returning s.*
		)
		select coalesce(
			jsonb_agg(
				jsonb_build_object(
					'sessionId', c.id,
					'surfaceId', c.surface_id,
					'profileId', c.profile_id,
					'state', case when c.state = 'reconciling_running' then 'reconciling' else 'queued' end,
					'leaseToken', c.lease_token,
					'prompt', c.prompt,
					'originKind', c.origin_kind,
					'originRef', c.origin_ref,
					'explorationId', c.exploration_id,
					'explorationVariantLabel', c.exploration_variant_label,
					'retryCount', c.retry_count,
					'sponsor', public.qorpera_surface_resolve_sponsor(c.profile_id, c.created_by_user_id),
					'repositoryKey', surf.repository_key,
					'folderRoot', surf.folder_root,
					'surfaceSlug', surf.slug,
					'surfaceTitle', surf.title,
					'surfaceArchetype', surf.archetype,
					'surfaceSourceKind', surf.source_kind,
					'surfaceKind', surf.surface_kind,
					'siteSlug', site.slug,
					'identityFolderRoot', 'identity',
					'briefSummary', surf.brief_summary,
					'placement', public.qorpera_surface_machine_placement_hint(c.profile_id, 6)
				)
				order by c.created_at asc
			),
			'[]'::jsonb
		)
		into v_sessions
		from claimed c
		join public.qorpera_surfaces surf on surf.id = c.surface_id
		left join public.qorpera_company_sites site on site.id = surf.site_id;
	end if;

	if v_lane in ('all', 'code_repo') then
		with picked as (
			select p.id
			from public.qorpera_surface_previews p
			where p.status = 'composing'
				and p.expires_at > v_now
				and (p.lease_expires_at is null or p.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(p.profile_id)
			order by p.created_at asc
			limit v_cap
			for update skip locked
		),
		claimed as (
			update public.qorpera_surface_previews p
			set
				status = 'building',
				lease_expires_at = v_lease,
				lease_token = extensions.gen_random_uuid()
			from picked
			where p.id = picked.id
			returning p.*
		)
		select coalesce(
			jsonb_agg(
				jsonb_build_object(
					'previewId', p.id,
					'surfaceId', p.surface_id,
					'profileId', p.profile_id,
					'environmentId', cof.environment_id,
					'shortHostId', p.short_host_id,
					'baseSha', p.base_sha,
					'selectedChangeIds', to_jsonb(p.selected_change_ids),
					'repositoryKey', surf.repository_key,
					'leaseToken', p.lease_token,
					'exploration', case
						when exp_sess.id is not null and exp_sess.base_sha is not null and exp_sess.branch_head_sha is not null then
							jsonb_build_object(
								'sessionId', exp_sess.id,
								'baseSha', exp_sess.base_sha,
								'headSha', exp_sess.branch_head_sha
							)
						else null
					end,
					'changes', coalesce(
						(
							select jsonb_agg(
								jsonb_build_object(
									'changeId', ch.id,
									'parentSha', ch.parent_sha,
									'headSha', ch.head_sha,
									'title', ch.title
								)
								order by array_position(p.selected_change_ids, ch.id)
							)
							from public.qorpera_surface_changes ch
							where ch.id = any(p.selected_change_ids)
								and ch.surface_id = p.surface_id
								and ch.profile_id = p.profile_id
								and ch.parent_sha is not null
								and ch.head_sha is not null
						),
						'[]'::jsonb
					)
				)
				order by p.created_at asc
			),
			'[]'::jsonb
		)
		into v_previews
		from claimed p
		join public.qorpera_surfaces surf on surf.id = p.surface_id
		left join public.qorpera_company_cofounders cof on cof.profile_id = p.profile_id
		left join public.qorpera_surface_sessions exp_sess
			on exp_sess.id = p.exploration_session_id
			and exp_sess.surface_id = p.surface_id
			and exp_sess.profile_id = p.profile_id;
	end if;

	with picked as (
		select j.id
		from public.qorpera_surface_jobs j
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.kind in ('land_change', 'undo_change')
			and j.status = 'queued'
			and not public.qorpera_surface_company_paused(j.profile_id)
			and (
				v_lane = 'all'
				or (v_lane = 'sessions' and surf.source_kind = 'native_ops')
				or (v_lane = 'folder' and surf.source_kind = 'folder')
				or (v_lane = 'code_repo' and surf.source_kind = 'code_repo')
			)
		order by j.created_at asc
		limit v_cap
		for update of j skip locked
	),
	claimed as (
		update public.qorpera_surface_jobs j
		set
			status = 'running',
			attempts = j.attempts + 1,
			lease_expires_at = v_lease,
			lease_token = extensions.gen_random_uuid(),
			updated_at = v_now
		from picked
		where j.id = picked.id
		returning j.*
	)
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'jobId', j.id,
				'kind', j.kind,
				'surfaceId', j.surface_id,
				'sessionId', j.session_id,
				'profileId', j.profile_id,
				'environmentId', cof.environment_id,
				'leaseToken', j.lease_token,
				'sourceKind', surf.source_kind,
				'repositoryKey', surf.repository_key,
				'folderRoot', surf.folder_root,
				'autoPublish', surf.auto_publish,
				'expectMainSha', surf.live_head_sha,
				'sessionWorkerId', sess.worker_id,
				'sessionState', case when sess.state = 'reconciling_running' then 'reconciling' else sess.state end,
				'sessionHasActiveChat', coalesce(sess.has_active_chat, false),
				'payload', j.payload,
				'preMergeSnapshot', (
					select ch.pre_merge_snapshot
					from public.qorpera_surface_changes ch
					where j.kind = 'undo_change'
						and j.payload ? 'changeId'
						and ch.id = (j.payload ->> 'changeId')::uuid
						and ch.surface_id = j.surface_id
						and ch.profile_id = j.profile_id
				),
				'allSessionChangeStatuses', coalesce(
					(
						select jsonb_agg(
							jsonb_build_object('changeId', ch.id, 'status', ch.status)
							order by ch.seq asc
						)
						from public.qorpera_surface_changes ch
						where ch.session_id = j.session_id
					),
					'[]'::jsonb
				),
				'approvedChanges', coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'changeId', ch.id,
								'kind', ch.kind,
								'parentSha', ch.parent_sha,
								'headSha', ch.head_sha,
								'title', ch.title,
								'summary', ch.summary,
								'patchManifest', ch.patch_manifest,
								'affectedPaths', to_jsonb(ch.affected_paths)
							)
							order by ch.seq asc
						)
						from public.qorpera_surface_changes ch
						where ch.id in (
							select x::uuid
							from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
						)
							and ch.surface_id = j.surface_id
							and ch.profile_id = j.profile_id
					),
					'[]'::jsonb
				),
				'siblingRemainingChanges', coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'changeId', ch.id,
								'parentSha', ch.parent_sha,
								'headSha', ch.head_sha,
								'title', ch.title
							)
							order by ch.seq asc
						)
						from public.qorpera_surface_changes ch
						where ch.session_id = j.session_id
							and ch.status in ('staged', 'conflicted')
							and ch.parent_sha is not null
							and ch.head_sha is not null
							and not (ch.id in (
								select x::uuid
								from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
							))
					),
					'[]'::jsonb
				),
				'peerSessions', coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'sessionId', peer.id,
								'workerId', peer.worker_id,
								'remainingChanges', coalesce(peer_changes.items, '[]'::jsonb)
							)
							order by peer.created_at asc
						)
						from public.qorpera_surface_sessions peer
						join lateral (
							select jsonb_agg(
								jsonb_build_object(
									'changeId', pch.id,
									'parentSha', pch.parent_sha,
									'headSha', pch.head_sha,
									'title', pch.title
								)
								order by pch.seq asc
							) as items
							from public.qorpera_surface_changes pch
							where pch.session_id = peer.id
								and pch.status in ('staged', 'conflicted')
								and pch.parent_sha is not null
								and pch.head_sha is not null
						) peer_changes on peer_changes.items is not null
						where peer.surface_id = j.surface_id
							and peer.id is distinct from j.session_id
							and peer.worker_id is not null
							and peer.state not in ('completed', 'discarded')
					),
					'[]'::jsonb
				)
			)
			order by j.created_at asc
		),
		'[]'::jsonb
	)
	into v_merges
	from claimed j
	join public.qorpera_surfaces surf on surf.id = j.surface_id
	left join public.qorpera_company_cofounders cof on cof.profile_id = j.profile_id
	left join public.qorpera_surface_sessions sess on sess.id = j.session_id;

	with picked as (
		select j.id
		from public.qorpera_surface_jobs j
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.kind = 'publish_surface'
			and j.status = 'queued'
			and not public.qorpera_surface_company_paused(j.profile_id)
			and (
				v_lane = 'all'
				or (v_lane = 'sessions' and surf.source_kind = 'native_ops')
				or (v_lane = 'folder' and surf.source_kind = 'folder')
				or (v_lane = 'code_repo' and surf.source_kind = 'code_repo')
			)
		order by j.created_at asc
		limit v_cap
		for update of j skip locked
	),
	claimed as (
		update public.qorpera_surface_jobs j
		set
			status = 'running',
			attempts = j.attempts + 1,
			lease_expires_at = v_lease,
			lease_token = extensions.gen_random_uuid(),
			updated_at = v_now
		from picked
		where j.id = picked.id
		returning j.*
	)
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'jobId', j.id,
				'surfaceId', j.surface_id,
				'profileId', j.profile_id,
				'environmentId', cof.environment_id,
				'leaseToken', j.lease_token,
				'sourceKind', surf.source_kind,
				'folderRoot', surf.folder_root,
				'repositoryKey', surf.repository_key,
				'siteId', surf.site_id,
				'liveHeadSha', surf.live_head_sha,
				'payload', j.payload
			)
			order by j.created_at asc
		),
		'[]'::jsonb
	)
	into v_publishes
	from claimed j
	join public.qorpera_surfaces surf on surf.id = j.surface_id
	left join public.qorpera_company_cofounders cof on cof.profile_id = j.profile_id;

	return jsonb_build_object(
		'sessions', v_sessions,
		'previews', v_previews,
		'merges', v_merges,
		'publishes', v_publishes,
		'automations', v_automations
	);
end $$;
revoke all on function public.qorpera_surface_claim_pending_jobs_for_lane(integer, text) from public, anon, authenticated;
grant execute on function public.qorpera_surface_claim_pending_jobs_for_lane(integer, text) to service_role;

create or replace function public.qorpera_surface_claim_pending_jobs(p_limit integer default 16)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	return public.qorpera_surface_claim_pending_jobs_for_lane(p_limit, 'all');
end $$;
