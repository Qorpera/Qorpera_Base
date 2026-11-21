set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surfaces') is not null then
		raise exception 'Surface-First Harness (20260930825000) is already applied';
	end if;
end $$;

create table public.qorpera_surfaces (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 64),
	title text not null check (char_length(btrim(title)) between 1 and 80),
	surface_group text not null check (surface_group in ('products', 'operations')),
	archetype text not null check (archetype in ('live_build', 'studio', 'ops')),
	status text not null check (status in ('proposed', 'active', 'archived')) default 'active',
	icon text not null default 'page' check (char_length(btrim(icon)) between 1 and 40),
	source_kind text not null check (source_kind in ('code_repo', 'folder', 'native_ops')),
	repository_key text check (repository_key is null or char_length(repository_key) <= 200),
	folder_root text check (folder_root is null or char_length(folder_root) <= 256),
	site_id uuid references public.qorpera_company_sites(id) on delete set null,
	preview_mode text not null check (preview_mode in ('static_site', 'app_proxy', 'studio_overlay', 'none')) default 'none',
	auto_publish boolean not null default false,
	brief_summary text check (brief_summary is null or char_length(brief_summary) <= 4000),
	live_head_sha text check (live_head_sha is null or char_length(live_head_sha) <= 64),
	published_head_sha text check (published_head_sha is null or char_length(published_head_sha) <= 64),
	unpublished_change_count integer not null default 0 check (unpublished_change_count >= 0),
	sort_order integer not null default 0,
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (profile_id, slug)
);
create index qorpera_surfaces_profile_status on public.qorpera_surfaces(profile_id, status, sort_order);
alter table public.qorpera_surfaces enable row level security;
revoke all on public.qorpera_surfaces from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_explorations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	title text not null check (char_length(btrim(title)) between 1 and 160),
	status text not null check (status in ('open', 'chosen', 'discarded')) default 'open',
	chosen_session_id uuid,
	created_by_kind text not null check (created_by_kind in ('member', 'cofounder', 'automation')) default 'member',
	created_at timestamptz not null default clock_timestamp(),
	resolved_at timestamptz
);
create index qorpera_surface_explorations_surface on public.qorpera_surface_explorations(surface_id, status);
alter table public.qorpera_surface_explorations enable row level security;
revoke all on public.qorpera_surface_explorations from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_sessions (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	worker_id uuid references public.qorpera_runtime_workers(id) on delete set null,
	machine_id uuid references public.qorpera_company_machines(id) on delete set null,
	exploration_id uuid references public.qorpera_surface_explorations(id) on delete set null,
	exploration_variant_label text check (exploration_variant_label is null or char_length(exploration_variant_label) <= 80),
	title text not null check (char_length(btrim(title)) between 1 and 160),
	prompt text not null check (char_length(prompt) <= 16000),
	origin_kind text not null check (origin_kind in ('member', 'cofounder', 'automation', 'point_to_change', 'cross_surface')) default 'member',
	origin_label text check (origin_label is null or char_length(origin_label) <= 160),
	origin_ref jsonb,
	created_by_user_id uuid references auth.users(id) on delete set null,
	state text not null check (state in (
		'queued', 'running', 'needs_input', 'ready', 'reconciling', 'completed', 'discarded', 'failed'
	)) default 'queued',
	question jsonb,
	base_sha text check (base_sha is null or char_length(base_sha) <= 64),
	branch_head_sha text check (branch_head_sha is null or char_length(branch_head_sha) <= 64),
	has_active_chat boolean not null default false,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	closed_at timestamptz
);
create index qorpera_surface_sessions_surface_state on public.qorpera_surface_sessions(surface_id, state, updated_at desc);
create index qorpera_surface_sessions_machine_active on public.qorpera_surface_sessions(profile_id, machine_id)
	where state in ('queued', 'running', 'reconciling');
alter table public.qorpera_surface_sessions enable row level security;
revoke all on public.qorpera_surface_sessions from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_changes (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	seq smallint not null check (seq >= 1),
	title text not null check (char_length(btrim(title)) between 1 and 160),
	summary text not null default '' check (char_length(summary) <= 2000),
	kind text not null check (kind in ('git_range', 'folder_patch', 'ops_action')) default 'git_range',
	parent_sha text check (parent_sha is null or char_length(parent_sha) <= 64),
	head_sha text check (head_sha is null or char_length(head_sha) <= 64),
	depends_on_change_ids uuid[] not null default '{}'::uuid[],
	patch_manifest jsonb,
	affected_paths text[] not null default '{}'::text[],
	diff_stats jsonb,
	status text not null check (status in (
		'staged', 'merging', 'merged', 'conflicted', 'discarded', 'reverted'
	)) default 'staged',
	conflict_paths text[],
	landed_change_number integer check (landed_change_number is null or landed_change_number >= 1),
	landed_main_before text check (landed_main_before is null or char_length(landed_main_before) <= 64),
	landed_main_after text check (landed_main_after is null or char_length(landed_main_after) <= 64),
	created_at timestamptz not null default clock_timestamp(),
	resolved_at timestamptz,
	unique (session_id, seq)
);
create index qorpera_surface_changes_session on public.qorpera_surface_changes(session_id, seq);
create index qorpera_surface_changes_surface_status on public.qorpera_surface_changes(surface_id, status);
alter table public.qorpera_surface_changes enable row level security;
revoke all on public.qorpera_surface_changes from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_previews (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	composition_key text not null check (char_length(composition_key) between 1 and 128),
	short_host_id text not null check (short_host_id ~ '^[a-z0-9]{8}$'),
	base_sha text not null check (char_length(base_sha) <= 64),
	selected_change_ids uuid[] not null default '{}'::uuid[],
	composite_tree_sha text check (composite_tree_sha is null or char_length(composite_tree_sha) <= 64),
	site_version_id uuid references public.qorpera_company_site_versions(id) on delete set null,
	status text not null check (status in ('composing', 'building', 'ready', 'conflicted', 'failed')) default 'composing',
	conflict_report jsonb,
	error_detail text check (error_detail is null or char_length(error_detail) <= 1000),
	expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
	created_at timestamptz not null default clock_timestamp(),
	unique (surface_id, composition_key),
	unique (surface_id, short_host_id)
);
create index qorpera_surface_previews_expires on public.qorpera_surface_previews(expires_at);
alter table public.qorpera_surface_previews enable row level security;
revoke all on public.qorpera_surface_previews from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_member_surface_state (
	user_id uuid not null references auth.users(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	active_exploration_session_id uuid references public.qorpera_surface_sessions(id) on delete set null,
	toggled_change_ids uuid[] not null default '{}'::uuid[],
	compare_session_ids uuid[] not null default '{}'::uuid[],
	active_route text not null default '/' check (char_length(active_route) between 1 and 512),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (user_id, surface_id)
);
alter table public.qorpera_member_surface_state enable row level security;
revoke all on public.qorpera_member_surface_state from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_migrations (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	applied_by_user_id uuid references auth.users(id) on delete set null,
	applied_at timestamptz not null default clock_timestamp(),
	archived_board_names text[] not null default '{}'::text[],
	agent_decisions jsonb not null default '[]'::jsonb
);
alter table public.qorpera_surface_migrations enable row level security;
revoke all on public.qorpera_surface_migrations from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_assert_surface_member(p_profile_id uuid, p_require_editor boolean default false)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
begin
	if v_user_id is null then
		raise exception 'Authentication required' using errcode = '42501';
	end if;
	select member.role into v_role
	from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null then
		raise exception 'Company membership required' using errcode = '42501';
	end if;
	if p_require_editor and v_role = 'viewer' then
		raise exception 'Editor membership required' using errcode = '42501';
	end if;
	return v_user_id;
end $$;
revoke all on function public.qorpera_assert_surface_member(uuid, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- WHY: Horizontal machine scaling selects the least-loaded running VM under target turn density or requests an overflow VM with no hard member cap.
create function public.qorpera_surface_machine_placement_hint(p_profile_id uuid, p_target_density integer default 6)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_density integer := greatest(1, coalesce(p_target_density, 6));
	v_machine record;
begin
	select machine.id, count(session.id)::integer as active_turns
	into v_machine
	from public.qorpera_company_machines machine
	left join public.qorpera_surface_sessions session
		on session.machine_id = machine.id
		and session.state in ('queued', 'running', 'reconciling')
	where machine.profile_id = p_profile_id
		and machine.status = 'running'
	group by machine.id
	having count(session.id) < v_density
	order by count(session.id) asc, machine.created_at asc
	limit 1;

	if found then
		return jsonb_build_object(
			'strategy', 'reuse_machine',
			'machineId', v_machine.id,
			'activeTurns', v_machine.active_turns,
			'targetDensity', v_density
		);
	end if;

	return jsonb_build_object(
		'strategy', 'spawn_overflow_machine',
		'machineId', null,
		'activeTurns', 0,
		'targetDensity', v_density
	);
end $$;
revoke all on function public.qorpera_surface_machine_placement_hint(uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_summary_json(p_surface public.qorpera_surfaces)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'id', p_surface.id,
		'slug', p_surface.slug,
		'title', p_surface.title,
		'group', p_surface.surface_group,
		'archetype', p_surface.archetype,
		'status', p_surface.status,
		'icon', p_surface.icon,
		'sourceKind', p_surface.source_kind,
		'repositoryKey', p_surface.repository_key,
		'folderRoot', p_surface.folder_root,
		'siteSlug', site.slug,
		'previewMode', p_surface.preview_mode,
		'autoPublish', p_surface.auto_publish,
		'liveUrl', case when site.slug is not null then 'https://' || site.slug || '.qorpera.com/' else null end,
		'hasUnpublishedChanges', (
			p_surface.unpublished_change_count > 0
			or (p_surface.live_head_sha is not null and p_surface.live_head_sha is distinct from p_surface.published_head_sha)
		),
		'unpublishedChangeCount', p_surface.unpublished_change_count,
		'activeSessionCount', coalesce(stats.active_sessions, 0),
		'runningSessionCount', coalesce(stats.running_sessions, 0),
		'pendingChangeCount', coalesce(change_stats.pending_changes, 0),
		'needsAttentionCount', coalesce(stats.attention_sessions, 0) + coalesce(change_stats.conflicted_changes, 0),
		'sortOrder', p_surface.sort_order
	)
	from (select 1) as dummy
	left join public.qorpera_company_sites site on site.id = p_surface.site_id
	left join lateral (
		select
			count(*) filter (where session.state not in ('completed', 'discarded'))::integer as active_sessions,
			count(*) filter (where session.state in ('queued', 'running', 'reconciling'))::integer as running_sessions,
			count(*) filter (where session.state in ('needs_input', 'failed'))::integer as attention_sessions
		from public.qorpera_surface_sessions session
		where session.surface_id = p_surface.id
	) stats on true
	left join lateral (
		select
			count(*) filter (where change.status in ('staged', 'merging', 'conflicted'))::integer as pending_changes,
			count(*) filter (where change.status = 'conflicted')::integer as conflicted_changes
		from public.qorpera_surface_changes change
		where change.surface_id = p_surface.id
	) change_stats on true
$$;
revoke all on function public.qorpera_surface_summary_json(public.qorpera_surfaces)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_session_json(p_session public.qorpera_surface_sessions)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'id', p_session.id,
		'surfaceId', p_session.surface_id,
		'workerId', p_session.worker_id,
		'title', p_session.title,
		'prompt', p_session.prompt,
		'state', p_session.state,
		'originKind', p_session.origin_kind,
		'originLabel', p_session.origin_label,
		'explorationId', p_session.exploration_id,
		'explorationVariantLabel', p_session.exploration_variant_label,
		'hasActiveChat', p_session.has_active_chat,
		'question', p_session.question,
		'changes', coalesce(changes_agg.items, '[]'::jsonb),
		'openChangeCount', coalesce(changes_agg.open_count, 0),
		'createdAt', p_session.created_at,
		'updatedAt', p_session.updated_at,
		'closedAt', p_session.closed_at
	)
	from (select 1) as dummy
	left join lateral (
		select
			jsonb_agg(
				jsonb_build_object(
					'id', ch.id,
					'sessionId', ch.session_id,
					'surfaceId', ch.surface_id,
					'seq', ch.seq,
					'title', ch.title,
					'summary', ch.summary,
					'kind', ch.kind,
					'status', ch.status,
					'parentSha', ch.parent_sha,
					'headSha', ch.head_sha,
					'dependsOnChangeIds', to_jsonb(ch.depends_on_change_ids),
					'affectedPaths', to_jsonb(ch.affected_paths),
					'diffStats', ch.diff_stats,
					'conflictPaths', case when ch.conflict_paths is null then null else to_jsonb(ch.conflict_paths) end,
					'landedChangeNumber', ch.landed_change_number,
					'canUndo', (ch.status = 'merged' and ch.resolved_at is not null),
					'createdAt', ch.created_at,
					'resolvedAt', ch.resolved_at
				)
				order by ch.seq asc
			) as items,
			count(*) filter (where ch.status in ('staged', 'merging', 'conflicted'))::integer as open_count
		from public.qorpera_surface_changes ch
		where ch.session_id = p_session.id
	) changes_agg on true
$$;
revoke all on function public.qorpera_surface_session_json(public.qorpera_surface_sessions)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- WHY: Enforces the multi-change auto-close invariant atomically inside Postgres so sessions never vanish while sibling changes remain open.
create function public.qorpera_evaluate_surface_session_lifecycle(p_session_id uuid)
returns public.qorpera_surface_sessions
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_open_count integer;
	v_total_count integer;
	v_merged_count integer;
	v_next_state text;
begin
	select * into v_session
	from public.qorpera_surface_sessions
	where id = p_session_id
	for update;

	if v_session.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;

	if v_session.state in ('queued', 'running', 'reconciling', 'needs_input', 'failed') then
		return v_session;
	end if;

	select
		count(*)::integer,
		count(*) filter (where status in ('staged', 'merging', 'conflicted'))::integer,
		count(*) filter (where status = 'merged')::integer
	into v_total_count, v_open_count, v_merged_count
	from public.qorpera_surface_changes
	where session_id = p_session_id;

	if v_open_count > 0 or v_session.has_active_chat then
		v_next_state := 'ready';
	elsif v_total_count = 0 then
		v_next_state := v_session.state;
	elsif v_merged_count > 0 then
		v_next_state := 'completed';
	else
		v_next_state := 'discarded';
	end if;

	if v_next_state is distinct from v_session.state then
		update public.qorpera_surface_sessions
		set
			state = v_next_state,
			closed_at = case when v_next_state in ('completed', 'discarded') then clock_timestamp() else null end,
			updated_at = clock_timestamp()
		where id = p_session_id
		returning * into v_session;
	end if;

	return v_session;
end $$;
revoke all on function public.qorpera_evaluate_surface_session_lifecycle(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_list_surfaces(p_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	perform public.qorpera_assert_surface_member(p_company_id, false);
	return coalesce(
		(
			select jsonb_agg(public.qorpera_surface_summary_json(surface) order by surface.surface_group asc, surface.sort_order asc, surface.created_at asc)
			from public.qorpera_surfaces surface
			where surface.profile_id = p_company_id
				and surface.status in ('active', 'proposed')
		),
		'[]'::jsonb
	);
end $$;
revoke all on function public.qorpera_list_surfaces(uuid) from public, anon;
grant execute on function public.qorpera_list_surfaces(uuid) to authenticated;

create function public.qorpera_get_surface_workspace(p_surface_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_member_state public.qorpera_member_surface_state%rowtype;
	v_active_sessions jsonb;
	v_history_sessions jsonb;
	v_explorations jsonb;
	v_toggled uuid[];
	v_compare uuid[];
	v_route text;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);

	select * into v_member_state
	from public.qorpera_member_surface_state
	where user_id = v_user_id and surface_id = p_surface_id;

	v_toggled := coalesce(v_member_state.toggled_change_ids, '{}'::uuid[]);
	v_compare := coalesce(v_member_state.compare_session_ids, '{}'::uuid[]);
	v_route := coalesce(v_member_state.active_route, '/');

	select coalesce(jsonb_agg(public.qorpera_surface_session_json(s) order by s.updated_at desc), '[]'::jsonb)
	into v_active_sessions
	from public.qorpera_surface_sessions s
	where s.surface_id = p_surface_id and s.state not in ('completed', 'discarded');

	select coalesce(jsonb_agg(public.qorpera_surface_session_json(s) order by s.closed_at desc nulls last), '[]'::jsonb)
	into v_history_sessions
	from (
		select *
		from public.qorpera_surface_sessions s
		where s.surface_id = p_surface_id and s.state in ('completed', 'discarded')
		order by s.closed_at desc nulls last
		limit 30
	) s;

	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'id', e.id,
				'surfaceId', e.surface_id,
				'title', e.title,
				'status', e.status,
				'chosenSessionId', e.chosen_session_id,
				'variantSessionIds', coalesce(
					(select jsonb_agg(vs.id order by vs.created_at asc) from public.qorpera_surface_sessions vs where vs.exploration_id = e.id),
					'[]'::jsonb
				),
				'createdAt', e.created_at,
				'resolvedAt', e.resolved_at
			)
			order by e.created_at desc
		),
		'[]'::jsonb
	)
	into v_explorations
	from public.qorpera_surface_explorations e
	where e.surface_id = p_surface_id and e.status = 'open';

	return jsonb_build_object(
		'surface', public.qorpera_surface_summary_json(v_surface),
		'briefSummary', v_surface.brief_summary,
		'activeSessions', v_active_sessions,
		'recentHistory', v_history_sessions,
		'explorations', v_explorations,
		'previewState', jsonb_build_object(
			'surfaceId', p_surface_id,
			'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,
			'primary', jsonb_build_object(
				'previewId', null,
				'status', case when cardinality(v_toggled) > 0 then 'ready' else 'live_baseline' end,
				'doorActionUrl', null,
				'memberPass', null,
				'activeRoute', v_route,
				'toggledChangeIds', to_jsonb(v_toggled),
				'conflictReport', null,
				'errorDetail', null
			),
			'compareFrames', '[]'::jsonb
		)
	);
end $$;
revoke all on function public.qorpera_get_surface_workspace(uuid) from public, anon;
grant execute on function public.qorpera_get_surface_workspace(uuid) to authenticated;

create function public.qorpera_approve_proposed_surface(p_surface_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);

	update public.qorpera_surfaces
	set status = 'active', updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_approve_proposed_surface(uuid) from public, anon;
grant execute on function public.qorpera_approve_proposed_surface(uuid) to authenticated;

create function public.qorpera_archive_surface(p_surface_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);

	update public.qorpera_surfaces
	set status = 'archived', updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_archive_surface(uuid) from public, anon;
grant execute on function public.qorpera_archive_surface(uuid) to authenticated;

create function public.qorpera_set_surface_auto_publish(p_surface_id uuid, p_auto_publish boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);

	update public.qorpera_surfaces
	set auto_publish = coalesce(p_auto_publish, false), updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_set_surface_auto_publish(uuid, boolean) from public, anon;
grant execute on function public.qorpera_set_surface_auto_publish(uuid, boolean) to authenticated;

create function public.qorpera_start_surface_session(
	p_surface_id uuid,
	p_prompt text,
	p_title text default null,
	p_origin_kind text default 'member',
	p_origin_label text default null,
	p_origin_ref jsonb default null,
	p_exploration_count integer default null,
	p_exploration_title text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_title text;
	v_exploration_id uuid;
	v_session public.qorpera_surface_sessions%rowtype;
	v_placement jsonb;
	v_machine_id uuid;
	v_idx integer;
	v_count integer;
begin
	if char_length(v_prompt) < 1 or char_length(v_prompt) > 16000 then
		raise exception 'Prompt must be 1..16000 characters' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);

	v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''), left(v_prompt, 80));
	v_placement := public.qorpera_surface_machine_placement_hint(v_surface.profile_id, 6);
	v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;

	if p_exploration_count is not null and p_exploration_count between 2 and 3 then
		v_count := p_exploration_count;
		insert into public.qorpera_surface_explorations(profile_id, surface_id, title, created_by_kind)
		values (v_surface.profile_id, p_surface_id, coalesce(nullif(btrim(coalesce(p_exploration_title, '')), ''), v_title), 'member')
		returning id into v_exploration_id;

		for v_idx in 1..v_count loop
			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
			)
			values (
				v_surface.profile_id, p_surface_id, v_machine_id, v_exploration_id,
				'Direction ' || v_idx::text,
				v_title || ' (' || v_idx::text || ')',
				v_prompt, coalesce(p_origin_kind, 'member'), p_origin_label, p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
			)
			returning * into v_session;
		end loop;
	else
		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
		)
		values (
			v_surface.profile_id, p_surface_id, v_machine_id, v_title, v_prompt,
			coalesce(p_origin_kind, 'member'), p_origin_label, p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
		)
		returning * into v_session;
	end if;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text) from public, anon;
grant execute on function public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text) to authenticated;

create function public.qorpera_reply_surface_session(p_session_id uuid, p_message text, p_keep_open boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
begin
	if char_length(btrim(coalesce(p_message, ''))) < 1 then
		raise exception 'Message cannot be empty' using errcode = '22023';
	end if;
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, true);

	update public.qorpera_surface_sessions
	set
		state = 'queued',
		question = null,
		has_active_chat = coalesce(p_keep_open, true),
		closed_at = null,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_reply_surface_session(uuid, text, boolean) from public, anon;
grant execute on function public.qorpera_reply_surface_session(uuid, text, boolean) to authenticated;

create function public.qorpera_set_session_chat_open(p_session_id uuid, p_open boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, true);

	update public.qorpera_surface_sessions
	set has_active_chat = coalesce(p_open, false), updated_at = clock_timestamp()
	where id = p_session_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_set_session_chat_open(uuid, boolean) from public, anon;
grant execute on function public.qorpera_set_session_chat_open(uuid, boolean) to authenticated;

create function public.qorpera_approve_surface_change(p_change_id uuid, p_include_dependencies boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_change public.qorpera_surface_changes%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_target_ids uuid[];
	v_merged_count integer;
begin
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_change.profile_id, true);

	if v_change.status not in ('staged', 'conflicted') then
		raise exception 'Change is not open for approval' using errcode = '22023';
	end if;

	if coalesce(p_include_dependencies, true) and cardinality(v_change.depends_on_change_ids) > 0 then
		v_target_ids := array_append(v_change.depends_on_change_ids, v_change.id);
	else
		v_target_ids := array[v_change.id];
	end if;

	update public.qorpera_surface_changes
	set
		status = 'merged',
		conflict_paths = null,
		resolved_at = clock_timestamp()
	where id = any(v_target_ids)
		and session_id = v_change.session_id
		and status in ('staged', 'conflicted');
	get diagnostics v_merged_count = row_count;

	select * into v_surface from public.qorpera_surfaces where id = v_change.surface_id for update;
	if v_surface.auto_publish then
		update public.qorpera_surfaces
		set
			live_head_sha = coalesce(v_change.head_sha, live_head_sha),
			published_head_sha = coalesce(v_change.head_sha, published_head_sha),
			unpublished_change_count = 0,
			updated_at = clock_timestamp()
		where id = v_change.surface_id;
	else
		update public.qorpera_surfaces
		set
			live_head_sha = coalesce(v_change.head_sha, live_head_sha),
			unpublished_change_count = unpublished_change_count + greatest(v_merged_count, 1),
			updated_at = clock_timestamp()
		where id = v_change.surface_id;
	end if;

	update public.qorpera_member_surface_state
	set toggled_change_ids = array(
		select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_target_ids))
	)
	where surface_id = v_change.surface_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_approve_surface_change(uuid, boolean) from public, anon;
grant execute on function public.qorpera_approve_surface_change(uuid, boolean) to authenticated;

create function public.qorpera_approve_session_all(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_merged_count integer;
	v_last_sha text;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, true);

	select head_sha into v_last_sha
	from public.qorpera_surface_changes
	where session_id = p_session_id and status in ('staged', 'conflicted')
	order by seq desc
	limit 1;

	update public.qorpera_surface_changes
	set status = 'merged', conflict_paths = null, resolved_at = clock_timestamp()
	where session_id = p_session_id and status in ('staged', 'conflicted');
	get diagnostics v_merged_count = row_count;

	if v_merged_count > 0 then
		select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id for update;
		update public.qorpera_surfaces
		set
			live_head_sha = coalesce(v_last_sha, live_head_sha),
			published_head_sha = case when v_surface.auto_publish then coalesce(v_last_sha, published_head_sha) else published_head_sha end,
			unpublished_change_count = case when v_surface.auto_publish then 0 else unpublished_change_count + v_merged_count end,
			updated_at = clock_timestamp()
		where id = v_session.surface_id;
	end if;

	update public.qorpera_surface_sessions
	set has_active_chat = false, updated_at = clock_timestamp()
	where id = p_session_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_approve_session_all(uuid) from public, anon;
grant execute on function public.qorpera_approve_session_all(uuid) to authenticated;

create function public.qorpera_discard_surface_change(p_change_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_change public.qorpera_surface_changes%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
begin
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_change.profile_id, true);

	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = clock_timestamp()
	where id = p_change_id and status in ('staged', 'conflicted');

	update public.qorpera_member_surface_state
	set toggled_change_ids = array_remove(toggled_change_ids, p_change_id)
	where surface_id = v_change.surface_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_discard_surface_change(uuid) from public, anon;
grant execute on function public.qorpera_discard_surface_change(uuid) to authenticated;

create function public.qorpera_undo_surface_change(p_change_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_change public.qorpera_surface_changes%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
begin
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_change.profile_id, true);

	if v_change.status not in ('merged', 'discarded') then
		raise exception 'Change cannot be undone from current status' using errcode = '22023';
	end if;

	if v_change.status = 'merged' then
		update public.qorpera_surfaces
		set
			unpublished_change_count = greatest(0, unpublished_change_count - 1),
			updated_at = clock_timestamp()
		where id = v_change.surface_id;
	end if;

	update public.qorpera_surface_changes
	set status = 'staged', resolved_at = null
	where id = p_change_id;

	update public.qorpera_surface_sessions
	set state = 'ready', closed_at = null, updated_at = clock_timestamp()
	where id = v_change.session_id and state in ('completed', 'discarded');

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_undo_surface_change(uuid) from public, anon;
grant execute on function public.qorpera_undo_surface_change(uuid) to authenticated;

create function public.qorpera_choose_exploration(p_exploration_id uuid, p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_exploration public.qorpera_surface_explorations%rowtype;
	v_winner jsonb;
begin
	select * into v_exploration from public.qorpera_surface_explorations where id = p_exploration_id for update;
	if v_exploration.id is null then raise exception 'Exploration not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_exploration.profile_id, true);

	v_winner := public.qorpera_approve_session_all(p_session_id);

	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = clock_timestamp()
	where session_id in (
		select id from public.qorpera_surface_sessions
		where exploration_id = p_exploration_id and id <> p_session_id
	) and status in ('staged', 'conflicted');

	update public.qorpera_surface_sessions
	set state = 'discarded', closed_at = clock_timestamp(), updated_at = clock_timestamp()
	where exploration_id = p_exploration_id and id <> p_session_id;

	update public.qorpera_surface_explorations
	set status = 'chosen', chosen_session_id = p_session_id, resolved_at = clock_timestamp()
	where id = p_exploration_id;

	update public.qorpera_member_surface_state
	set active_exploration_session_id = null, compare_session_ids = '{}'::uuid[]
	where surface_id = v_exploration.surface_id;

	return v_winner;
end $$;
revoke all on function public.qorpera_choose_exploration(uuid, uuid) from public, anon;
grant execute on function public.qorpera_choose_exploration(uuid, uuid) to authenticated;

create function public.qorpera_set_preview_selection(
	p_surface_id uuid,
	p_toggled_change_ids uuid[] default '{}'::uuid[],
	p_exploration_session_id uuid default null,
	p_compare_session_ids uuid[] default '{}'::uuid[],
	p_active_route text default '/'
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_toggled uuid[] := coalesce(p_toggled_change_ids, '{}'::uuid[]);
	v_compare uuid[] := coalesce(p_compare_session_ids, '{}'::uuid[]);
	v_route text := coalesce(nullif(btrim(coalesce(p_active_route, '')), ''), '/');
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);

	if cardinality(v_compare) > 3 then
		raise exception 'Compare supports at most 3 variants' using errcode = '22023';
	end if;

	insert into public.qorpera_member_surface_state(
		user_id, surface_id, active_exploration_session_id, toggled_change_ids, compare_session_ids, active_route, updated_at
	)
	values (v_user_id, p_surface_id, p_exploration_session_id, v_toggled, v_compare, v_route, clock_timestamp())
	on conflict (user_id, surface_id) do update set
		active_exploration_session_id = excluded.active_exploration_session_id,
		toggled_change_ids = excluded.toggled_change_ids,
		compare_session_ids = excluded.compare_session_ids,
		active_route = excluded.active_route,
		updated_at = clock_timestamp();

	return jsonb_build_object(
		'surfaceId', p_surface_id,
		'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,
		'primary', jsonb_build_object(
			'previewId', null,
			'status', case when cardinality(v_toggled) > 0 then 'ready' else 'live_baseline' end,
			'doorActionUrl', null,
			'memberPass', null,
			'activeRoute', v_route,
			'toggledChangeIds', to_jsonb(v_toggled),
			'conflictReport', null,
			'errorDetail', null
		),
		'compareFrames', '[]'::jsonb
	);
end $$;
revoke all on function public.qorpera_set_preview_selection(uuid, uuid[], uuid, uuid[], text) from public, anon;
grant execute on function public.qorpera_set_preview_selection(uuid, uuid[], uuid, uuid[], text) to authenticated;

create function public.qorpera_publish_surface(p_surface_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);

	update public.qorpera_surfaces
	set
		published_head_sha = live_head_sha,
		unpublished_change_count = 0,
		updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_publish_surface(uuid) from public, anon;
grant execute on function public.qorpera_publish_surface(uuid) to authenticated;

create function public.qorpera_list_automations(p_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	perform public.qorpera_assert_surface_member(p_company_id, false);
	return coalesce(
		(
			select jsonb_agg(
				jsonb_build_object(
					'id', r.id,
					'key', r.client_routine_id::text,
					'title', coalesce(rv.title, 'Routine'),
					'scheduleSummary', coalesce(rv.triggers -> 0 ->> 'kind', 'scheduled'),
					'targetSurfaceSlug', null,
					'outputMode', 'surface_session',
					'enabled', (r.status = 'active'),
					'status', case when r.status = 'active' then 'idle' else 'paused' end,
					'lastRunAt', r.updated_at,
					'lastOutcomeSummary', null,
					'nextRunAt', null
				)
				order by r.updated_at desc
			)
			from public.qorpera_cloud_routines r
			left join public.qorpera_cloud_routine_versions rv
				on rv.routine_id = r.id and rv.version = r.current_version
			where r.profile_id = p_company_id and r.status <> 'retired'
		),
		'[]'::jsonb
	);
end $$;
revoke all on function public.qorpera_list_automations(uuid) from public, anon;
grant execute on function public.qorpera_list_automations(uuid) to authenticated;

create function public.qorpera_toggle_automation(p_automation_id uuid, p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_routine public.qorpera_cloud_routines%rowtype;
	v_title text;
begin
	select * into v_routine from public.qorpera_cloud_routines where id = p_automation_id for update;
	if v_routine.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_routine.profile_id, true);

	update public.qorpera_cloud_routines
	set status = case when coalesce(p_enabled, false) then 'active' else 'paused' end, updated_at = clock_timestamp()
	where id = p_automation_id
	returning * into v_routine;

	select rv.title into v_title
	from public.qorpera_cloud_routine_versions rv
	where rv.routine_id = v_routine.id and rv.version = v_routine.current_version;

	return jsonb_build_object(
		'id', v_routine.id,
		'key', v_routine.client_routine_id::text,
		'title', coalesce(v_title, 'Routine'),
		'scheduleSummary', 'scheduled',
		'targetSurfaceSlug', null,
		'outputMode', 'surface_session',
		'enabled', (v_routine.status = 'active'),
		'status', case when v_routine.status = 'active' then 'idle' else 'paused' end,
		'lastRunAt', v_routine.updated_at,
		'lastOutcomeSummary', null,
		'nextRunAt', null
	);
end $$;
revoke all on function public.qorpera_toggle_automation(uuid, boolean) from public, anon;
grant execute on function public.qorpera_toggle_automation(uuid, boolean) to authenticated;

-- WHY: Implements the founder-approved 1-click migration checklist so legacy specialist agents fold into Automations and Surface briefs safely.
create function public.qorpera_surface_migration_checklist(p_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_migrated boolean;
	v_sites jsonb;
	v_agents jsonb;
begin
	perform public.qorpera_assert_surface_member(p_company_id, false);
	select exists (select 1 from public.qorpera_surface_migrations where profile_id = p_company_id) into v_migrated;

	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'slug', s.slug,
				'title', coalesce(s.title, initcap(replace(s.slug, '-', ' '))),
				'group', 'products',
				'archetype', 'live_build',
				'sourceKind', 'code_repo',
				'sourceRef', s.source_path
			)
			order by s.created_at asc
		),
		'[]'::jsonb
	)
	into v_sites
	from public.qorpera_company_sites s
	where s.profile_id = p_company_id;

	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'agentId', st.staff_agent_id,
				'handle', lower(regexp_replace(st.display_name, '[^a-zA-Z0-9]+', '-', 'g')),
				'name', st.display_name,
				'role', st.role,
				'routineCount', coalesce(rc.cnt, 0),
				'recommendedAction', case when coalesce(rc.cnt, 0) > 0 then 'fold_to_automation' else 'fold_to_surface_brief' end,
				'recommendedTargetSurfaceSlug', null
			)
			order by st.created_at asc
		),
		'[]'::jsonb
	)
	into v_agents
	from public.qorpera_profile_staff st
	left join lateral (
		select count(*)::integer as cnt
		from public.qorpera_cloud_routines r
		join public.qorpera_cloud_routine_versions rv
			on rv.routine_id = r.id and rv.version = r.current_version
		where r.profile_id = p_company_id and r.status <> 'retired' and rv.staff_agent_id = st.staff_agent_id
	) rc on true
	where st.profile_id = p_company_id
		and st.employment_status = 'active'
		and coalesce(st.template_id, '') <> 'co-founder';

	return jsonb_build_object(
		'companyId', p_company_id,
		'alreadyMigrated', v_migrated,
		'proposedSurfaces', v_sites || jsonb_build_array(
			jsonb_build_object('slug', 'inbox', 'title', 'Inbox', 'group', 'operations', 'archetype', 'ops', 'sourceKind', 'native_ops', 'sourceRef', 'mailbox'),
			jsonb_build_object('slug', 'money', 'title', 'Money', 'group', 'operations', 'archetype', 'ops', 'sourceKind', 'native_ops', 'sourceRef', 'bank'),
			jsonb_build_object('slug', 'files', 'title', 'Files', 'group', 'operations', 'archetype', 'ops', 'sourceKind', 'native_ops', 'sourceRef', 'folder')
		),
		'specialistAgents', v_agents,
		'legacyBoards', '[]'::jsonb
	);
end $$;
revoke all on function public.qorpera_surface_migration_checklist(uuid) from public, anon;
grant execute on function public.qorpera_surface_migration_checklist(uuid) to authenticated;

create function public.qorpera_apply_surface_migration(
	p_company_id uuid,
	p_activate_surface_slugs text[] default '{}'::text[],
	p_agent_decisions jsonb default '[]'::jsonb,
	p_archive_board_names text[] default '{}'::text[]
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid;
	v_site record;
	v_order integer := 10;
begin
	v_user_id := public.qorpera_assert_surface_member(p_company_id, true);

	for v_site in
		select s.id, s.slug, coalesce(s.title, initcap(replace(s.slug, '-', ' '))) as title
		from public.qorpera_company_sites s
		where s.profile_id = p_company_id
			and (cardinality(coalesce(p_activate_surface_slugs, '{}'::text[])) = 0 or s.slug = any(p_activate_surface_slugs))
		order by s.created_at asc
	loop
		insert into public.qorpera_surfaces(
			profile_id, slug, title, surface_group, archetype, status, icon,
			source_kind, site_id, preview_mode, sort_order, created_by_user_id
		)
		values (
			p_company_id, v_site.slug, left(v_site.title, 80), 'products', 'live_build', 'active', 'globe',
			'code_repo', v_site.id, 'static_site', v_order, v_user_id
		)
		on conflict (profile_id, slug) do update set status = 'active', updated_at = clock_timestamp();
		v_order := v_order + 10;
	end loop;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, status, icon,
		source_kind, preview_mode, sort_order, created_by_user_id
	)
	values
		(p_company_id, 'inbox', 'Inbox', 'operations', 'ops', 'active', 'mail', 'native_ops', 'none', 100, v_user_id),
		(p_company_id, 'money', 'Money', 'operations', 'ops', 'active', 'coin', 'native_ops', 'none', 110, v_user_id),
		(p_company_id, 'files', 'Files', 'operations', 'ops', 'active', 'book', 'native_ops', 'none', 120, v_user_id)
	on conflict (profile_id, slug) do nothing;

	insert into public.qorpera_surface_migrations(profile_id, applied_by_user_id, archived_board_names, agent_decisions)
	values (p_company_id, v_user_id, coalesce(p_archive_board_names, '{}'::text[]), coalesce(p_agent_decisions, '[]'::jsonb))
	on conflict (profile_id) do update set
		applied_by_user_id = excluded.applied_by_user_id,
		applied_at = clock_timestamp(),
		archived_board_names = excluded.archived_board_names,
		agent_decisions = excluded.agent_decisions;

	return public.qorpera_list_surfaces(p_company_id);
end $$;
revoke all on function public.qorpera_apply_surface_migration(uuid, text[], jsonb, text[]) from public, anon;
grant execute on function public.qorpera_apply_surface_migration(uuid, text[], jsonb, text[]) to authenticated;

-- WHY: Runtime sessions call this service RPC via coding_record_change and staged coding_finish to stage atomic ChangeUnits without landing main.
create function public.qorpera_record_surface_change(
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
	p_finish_session boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_next_seq smallint;
	v_change public.qorpera_surface_changes%rowtype;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;

	select coalesce(max(seq), 0)::smallint + 1 into v_next_seq
	from public.qorpera_surface_changes
	where session_id = p_session_id;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, affected_paths, diff_stats, patch_manifest, status
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, p_patch_manifest, 'staged'
	)
	returning * into v_change;

	update public.qorpera_surface_sessions
	set
		branch_head_sha = coalesce(p_head_sha, branch_head_sha),
		state = case when p_finish_session then 'ready' else state end,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	return jsonb_build_object(
		'changeId', v_change.id,
		'seq', v_change.seq,
		'session', public.qorpera_surface_session_json(v_session)
	);
end $$;
revoke all on function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean)
	from public, anon, authenticated;
grant execute on function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean)
	to service_role;

-- WHY: Co-Founder proposes new surfaces in proposed state so no agent can unilaterally clutter primary sidebar navigation.
create function public.qorpera_propose_surface(
	p_company_id uuid,
	p_slug text,
	p_title text,
	p_group text,
	p_archetype text,
	p_source_kind text,
	p_icon text default 'page',
	p_repository_key text default null,
	p_folder_root text default null,
	p_preview_mode text default 'none',
	p_brief_summary text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
begin
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, status, icon,
		source_kind, repository_key, folder_root, preview_mode, brief_summary
	)
	values (
		p_company_id, lower(btrim(p_slug)), btrim(p_title), p_group, p_archetype, 'proposed',
		coalesce(nullif(btrim(coalesce(p_icon, '')), ''), 'page'),
		p_source_kind, p_repository_key, p_folder_root, coalesce(p_preview_mode, 'none'), p_brief_summary
	)
	on conflict (profile_id, slug) do update set
		title = excluded.title,
		brief_summary = coalesce(excluded.brief_summary, public.qorpera_surfaces.brief_summary),
		updated_at = clock_timestamp()
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text)
	to service_role;
