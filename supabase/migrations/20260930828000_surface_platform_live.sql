set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_jobs') is not null then
		raise exception 'Surface Platform Live (20260930828000) is already applied';
	end if;
	if to_regclass('public.qorpera_surfaces') is null then
		raise exception 'Surface Platform Live (20260930828000) requires 20260930825000 first';
	end if;
	if to_regclass('public.qorpera_surface_session_messages') is null then
		raise exception 'Surface Platform Live (20260930828000) requires 20260930826000 first';
	end if;
end $$;

alter table public.qorpera_surfaces
	add column surface_kind text not null default 'custom' check (surface_kind in (
		'identity', 'website', 'web_app', 'mobile_app', 'desktop_app',
		'database', 'dashboard', 'brand', 'product', 'report', 'custom',
		'inbox', 'money', 'members', 'data', 'files'
	)),
	add column accent_hex text check (accent_hex is null or accent_hex ~ '^#[0-9a-fA-F]{6}$'),
	add column is_global boolean not null default false,
	add column publish_status text not null default 'idle' check (publish_status in ('idle', 'publishing', 'failed')),
	add column last_publish_error text check (last_publish_error is null or char_length(last_publish_error) <= 1000);

update public.qorpera_surfaces
set
	surface_kind = case
		when slug = 'identity' then 'identity'
		when slug = 'inbox' then 'inbox'
		when slug = 'money' then 'money'
		when slug = 'members' then 'members'
		when slug = 'data' then 'data'
		when slug = 'files' then 'files'
		when archetype = 'live_build' then 'website'
		when archetype = 'studio' then 'product'
		else 'custom'
	end,
	is_global = (slug = 'identity');

alter table public.qorpera_surface_explorations
	add column owner_label text check (owner_label is null or char_length(owner_label) <= 160),
	add column note_paths text[] not null default '{}'::text[];

alter table public.qorpera_surface_sessions
	add column note_paths text[] not null default '{}'::text[],
	add column lease_expires_at timestamptz,
	add column retry_count integer not null default 0 check (retry_count >= 0);

-- WHY: Wraps qorpera_company_execution_paused safely so surface claims never execute work for paused or deleting companies.
create function public.qorpera_surface_company_paused(p_company_id uuid)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
	if to_regprocedure('public.qorpera_company_execution_paused(uuid)') is null then
		return false;
	end if;
	return public.qorpera_company_execution_paused(p_company_id);
end $$;
revoke all on function public.qorpera_surface_company_paused(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_company_paused(uuid) to service_role;

-- WHY: Resolves the paying founder sponsor binding for a surface session or automation without failing when sponsor tables are absent.
create function public.qorpera_surface_resolve_sponsor(p_company_id uuid, p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_uid uuid := p_user_id;
	v_sponsor jsonb;
begin
	if to_regprocedure('public.qorpera_member_first_run_sponsor(uuid,uuid)') is null then
		return null;
	end if;
	if v_uid is null and to_regclass('public.qorpera_company_cofounders') is not null then
		select created_by_user_id into v_uid
		from public.qorpera_company_cofounders
		where profile_id = p_company_id
		limit 1;
	end if;
	if v_uid is null then
		return null;
	end if;
	v_sponsor := public.qorpera_member_first_run_sponsor(p_company_id, v_uid);
	return v_sponsor;
exception when others then
	return null;
end $$;
revoke all on function public.qorpera_surface_resolve_sponsor(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_resolve_sponsor(uuid, uuid) to service_role;

-- WHY: Reserves a qorpera_company_sites row and password for greenfield live_build surfaces so previews and live sharing work from Minute 1.
create function public.qorpera_surface_ensure_site(p_surface_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_cofounder record;
	v_company_name text;
	v_prefix text;
	v_base_slug text;
	v_slug text;
	v_suffix integer := 0;
	v_site_id uuid;
	v_password text;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null or v_surface.archetype <> 'live_build' then
		return null;
	end if;
	if v_surface.site_id is not null then
		return v_surface.site_id;
	end if;
	if to_regclass('public.qorpera_company_sites') is null or to_regclass('public.qorpera_company_cofounders') is null then
		return null;
	end if;

	select environment_id, staff_agent_id into v_cofounder
	from public.qorpera_company_cofounders
	where profile_id = v_surface.profile_id
	limit 1;
	if v_cofounder.environment_id is null or v_cofounder.staff_agent_id is null then
		return null;
	end if;

	select name into v_company_name from public.qorpera_profiles where id = v_surface.profile_id;
	v_prefix := left(btrim(lower(regexp_replace(coalesce(v_company_name, ''), '[^a-zA-Z0-9]+', '-', 'g')), '-'), 20);
	if v_prefix <> '' and v_surface.slug <> v_prefix then
		v_base_slug := left(btrim(v_prefix || '-' || v_surface.slug, '-'), 42);
	else
		v_base_slug := left(btrim(v_surface.slug, '-'), 42);
	end if;
	if char_length(v_base_slug) < 3 then
		v_base_slug := v_base_slug || '-app';
	end if;
	v_base_slug := btrim(regexp_replace(v_base_slug, '-+', '-', 'g'), '-');
	v_slug := v_base_slug;
	while exists (select 1 from public.qorpera_company_sites where slug = v_slug) loop
		v_suffix := v_suffix + 1;
		v_slug := left(v_base_slug, 38) || '-' || v_suffix::text;
	end loop;

	insert into public.qorpera_company_sites(
		profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id
	)
	values (
		v_surface.profile_id,
		v_cofounder.environment_id,
		v_slug,
		left(v_surface.title, 120),
		coalesce(v_surface.repository_key, 'surfaces/' || v_surface.slug),
		v_cofounder.staff_agent_id
	)
	returning id into v_site_id;

	if to_regclass('public.qorpera_company_site_secrets') is not null then
		v_password := substr(encode(extensions.gen_random_bytes(16), 'hex'), 1, 16);
		insert into public.qorpera_company_site_secrets(site_id, password)
		values (v_site_id, v_password)
		on conflict (site_id) do nothing;
	end if;

	update public.qorpera_surfaces
	set site_id = v_site_id, updated_at = clock_timestamp()
	where id = p_surface_id;

	return v_site_id;
exception when others then
	return v_surface.site_id;
end $$;
revoke all on function public.qorpera_surface_ensure_site(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_ensure_site(uuid) to service_role;

alter table public.qorpera_surface_changes
	add column published_at timestamptz,
	add column approved_by_user_id uuid references auth.users(id) on delete set null,
	add column published_by_user_id uuid references auth.users(id) on delete set null;

alter table public.qorpera_surface_previews
	add column exploration_session_id uuid references public.qorpera_surface_sessions(id) on delete set null,
	add column lease_expires_at timestamptz;

create or replace function public.qorpera_surface_upsert_preview(
	p_surface public.qorpera_surfaces,
	p_base_sha text,
	p_selected_change_ids uuid[],
	p_exploration_session_id uuid default null
)
returns public.qorpera_surface_previews
language plpgsql security definer set search_path = '' as $$
declare
	v_key_input text;
	v_comp_key text;
	v_host_id text;
	v_row public.qorpera_surface_previews%rowtype;
begin
	if p_surface.archetype = 'live_build' and p_surface.site_id is null then
		perform public.qorpera_surface_ensure_site(p_surface.id);
	end if;

	select string_agg(ch.id::text || ':' || coalesce(ch.head_sha, ''), ',' order by array_position(p_selected_change_ids, ch.id))
	into v_key_input
	from public.qorpera_surface_changes ch
	where ch.id = any(coalesce(p_selected_change_ids, '{}'::uuid[]));

	v_comp_key := encode(
		extensions.digest(
			coalesce(p_base_sha, 'base') || '|' || coalesce(p_exploration_session_id::text, '') || '|' || coalesce(v_key_input, ''),
			'sha256'
		),
		'hex'
	);
	v_host_id := substr(v_comp_key, 1, 8);

	insert into public.qorpera_surface_previews(
		profile_id, surface_id, composition_key, short_host_id, base_sha,
		selected_change_ids, exploration_session_id, status, expires_at
	)
	values (
		p_surface.profile_id, p_surface.id, v_comp_key, v_host_id,
		coalesce(p_base_sha, repeat('0', 40)), coalesce(p_selected_change_ids, '{}'::uuid[]),
		p_exploration_session_id, 'composing', clock_timestamp() + interval '24 hours'
	)
	on conflict (surface_id, composition_key) do update set
		exploration_session_id = excluded.exploration_session_id,
		expires_at = clock_timestamp() + interval '24 hours',
		status = case
			when public.qorpera_surface_previews.status = 'failed' then 'composing'
			else public.qorpera_surface_previews.status
		end
	returning * into v_row;

	return v_row;
end $$;

create table public.qorpera_surface_jobs (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	session_id uuid references public.qorpera_surface_sessions(id) on delete cascade,
	kind text not null check (kind in ('land_change', 'undo_change', 'publish_surface')),
	status text not null check (status in ('queued', 'running', 'completed', 'failed')) default 'queued',
	payload jsonb not null default '{}'::jsonb,
	requested_by_user_id uuid references auth.users(id) on delete set null,
	attempts integer not null default 0 check (attempts >= 0),
	lease_expires_at timestamptz,
	error_detail text check (error_detail is null or char_length(error_detail) <= 1000),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	completed_at timestamptz
);
create index qorpera_surface_jobs_claim on public.qorpera_surface_jobs(status, lease_expires_at, created_at)
	where status in ('queued', 'running');
create index qorpera_surface_jobs_surface on public.qorpera_surface_jobs(surface_id, kind, status);
alter table public.qorpera_surface_jobs enable row level security;
revoke all on public.qorpera_surface_jobs from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_automations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	key text not null check (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(key) <= 80),
	title text not null check (char_length(btrim(title)) between 1 and 120),
	prompt text not null check (char_length(btrim(prompt)) between 1 and 16000),
	schedule_summary text not null default 'Every day · 09:00' check (char_length(btrim(schedule_summary)) between 1 and 160),
	target_surface_slug text check (target_surface_slug is null or (target_surface_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(target_surface_slug) <= 64)),
	output_mode text not null default 'surface_session' check (output_mode in ('surface_session', 'decision_card', 'silent_note')),
	enabled boolean not null default true,
	status text not null default 'idle' check (status in ('idle', 'running', 'needs_attention', 'paused')),
	routine_id uuid references public.qorpera_cloud_routines(id) on delete set null,
	last_run_at timestamptz,
	last_outcome_summary text check (last_outcome_summary is null or char_length(last_outcome_summary) <= 500),
	next_run_at timestamptz,
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (profile_id, key)
);
create index qorpera_surface_automations_profile on public.qorpera_surface_automations(profile_id, updated_at desc);
alter table public.qorpera_surface_automations enable row level security;
revoke all on public.qorpera_surface_automations from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_surface_summary_json(p_surface public.qorpera_surfaces)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'id', p_surface.id,
		'slug', p_surface.slug,
		'title', p_surface.title,
		'group', p_surface.surface_group,
		'archetype', p_surface.archetype,
		'kind', p_surface.surface_kind,
		'accentHex', p_surface.accent_hex,
		'isGlobal', p_surface.is_global,
		'status', p_surface.status,
		'icon', p_surface.icon,
		'sourceKind', p_surface.source_kind,
		'repositoryKey', p_surface.repository_key,
		'folderRoot', p_surface.folder_root,
		'siteSlug', site.slug,
		'previewMode', p_surface.preview_mode,
		'autoPublish', p_surface.auto_publish,
		'publishStatus', p_surface.publish_status,
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

create or replace function public.qorpera_surface_session_json(p_session public.qorpera_surface_sessions)
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
		'createdByUserId', p_session.created_by_user_id,
		'explorationId', p_session.exploration_id,
		'explorationVariantLabel', p_session.exploration_variant_label,
		'hasActiveChat', p_session.has_active_chat,
		'question', p_session.question,
		'notePaths', to_jsonb(coalesce(p_session.note_paths, '{}'::text[])),
		'changes', coalesce(changes_agg.items, '[]'::jsonb),
		'messages', coalesce(messages_agg.items, '[]'::jsonb),
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
					'patchManifest', ch.patch_manifest,
					'diffStats', ch.diff_stats,
					'conflictPaths', case when ch.conflict_paths is null then null else to_jsonb(ch.conflict_paths) end,
					'landedChangeNumber', ch.landed_change_number,
					'canUndo', (ch.status = 'merged' and ch.published_at is null and ch.resolved_at is not null),
					'publishedAt', ch.published_at,
					'approvedByUserId', ch.approved_by_user_id,
					'createdAt', ch.created_at,
					'resolvedAt', ch.resolved_at
				)
				order by ch.seq asc
			) as items,
			count(*) filter (where ch.status in ('staged', 'merging', 'conflicted'))::integer as open_count
		from public.qorpera_surface_changes ch
		where ch.session_id = p_session.id
	) changes_agg on true
	left join lateral (
		select jsonb_agg(
			jsonb_build_object(
				'id', m.id,
				'sessionId', m.session_id,
				'authorKind', m.author_kind,
				'authorUserId', m.author_user_id,
				'text', m.body,
				'changeId', m.change_id,
				'createdAt', m.created_at
			)
			order by m.created_at asc
		) as items
		from public.qorpera_surface_session_messages m
		where m.session_id = p_session.id
	) messages_agg on true
$$;

create or replace function public.qorpera_get_surface_workspace(p_surface_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_user_id uuid;
	v_member_state public.qorpera_member_surface_state%rowtype;
	v_active_sessions jsonb;
	v_history_sessions jsonb;
	v_explorations jsonb;
	v_toggled uuid[];
	v_route text;
	v_preview public.qorpera_surface_previews%rowtype;
	v_primary_host text;
	v_primary_pass text;
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
				'ownerLabel', e.owner_label,
				'notePaths', to_jsonb(coalesce(e.note_paths, '{}'::text[])),
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
	where e.surface_id = p_surface_id
		and (e.status = 'open' or (e.status = 'chosen' and e.resolved_at >= clock_timestamp() - interval '7 days'));

	if v_surface.site_id is not null then
		select * into v_site from public.qorpera_company_sites where id = v_surface.site_id;
	end if;

	if cardinality(v_toggled) > 0 or v_member_state.active_exploration_session_id is not null then
		v_preview := public.qorpera_surface_upsert_preview(
			v_surface,
			v_surface.live_head_sha,
			v_toggled,
			v_member_state.active_exploration_session_id
		);
		if v_site.id is not null and v_preview.status = 'ready' then
			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host);
		end if;
	end if;

	return jsonb_build_object(
		'surface', public.qorpera_surface_summary_json(v_surface),
		'briefSummary', v_surface.brief_summary,
		'activeSessions', v_active_sessions,
		'recentHistory', v_history_sessions,
		'explorations', v_explorations,
		'previewState', jsonb_build_object(
			'surfaceId', p_surface_id,
			'mode', 'single',
			'primary', jsonb_build_object(
				'previewId', v_preview.id,
				'status', case when v_preview.id is not null then v_preview.status else 'live_baseline' end,
				'doorActionUrl', case when v_primary_host is not null then 'https://' || v_primary_host || '/__qorpera/member' else null end,
				'memberPass', v_primary_pass,
				'activeRoute', v_route,
				'toggledChangeIds', to_jsonb(v_toggled),
				'conflictReport', v_preview.conflict_report,
				'errorDetail', v_preview.error_detail
			),
			'compareFrames', '[]'::jsonb
		)
	);
end $$;

create function public.qorpera_create_surface(
	p_company_id uuid,
	p_title text,
	p_slug text default null,
	p_archetype text default 'live_build',
	p_kind text default 'custom',
	p_icon text default 'globe',
	p_accent_hex text default null,
	p_folder_root text default null,
	p_brief_summary text default null,
	p_is_global boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid;
	v_title text := btrim(coalesce(p_title, ''));
	v_slug text;
	v_base_slug text;
	v_suffix integer := 1;
	v_source_kind text;
	v_preview_mode text;
	v_folder_root text;
	v_sort_order integer;
	v_surface public.qorpera_surfaces%rowtype;
begin
	v_user_id := public.qorpera_assert_surface_member(p_company_id, true);
	if char_length(v_title) < 1 or char_length(v_title) > 80 then
		raise exception 'Title must be 1..80 characters' using errcode = '22023';
	end if;
	if p_archetype not in ('live_build', 'studio', 'ops') then
		raise exception 'Invalid archetype' using errcode = '22023';
	end if;

	v_base_slug := lower(regexp_replace(coalesce(nullif(btrim(coalesce(p_slug, '')), ''), v_title), '[^a-zA-Z0-9]+', '-', 'g'));
	v_base_slug := left(btrim(v_base_slug, '-'), 56);
	if v_base_slug = '' then
		v_base_slug := 'surface';
	end if;
	v_slug := v_base_slug;
	while exists (select 1 from public.qorpera_surfaces where profile_id = p_company_id and slug = v_slug) loop
		v_suffix := v_suffix + 1;
		v_slug := left(v_base_slug, 52) || '-' || v_suffix::text;
	end loop;

	v_source_kind := case
		when p_archetype = 'ops' then 'native_ops'
		when p_archetype = 'studio' then 'folder'
		else 'code_repo'
	end;
	v_preview_mode := case
		when p_archetype = 'ops' then 'none'
		when p_archetype = 'studio' then 'studio_overlay'
		else 'static_site'
	end;
	v_folder_root := case
		when p_archetype = 'studio' then coalesce(nullif(btrim(coalesce(p_folder_root, ''), '/ '), ''), v_slug)
		else nullif(btrim(coalesce(p_folder_root, ''), '/ '), '')
	end;

	select coalesce(max(sort_order), 0) + 10 into v_sort_order
	from public.qorpera_surfaces
	where profile_id = p_company_id and surface_group = case when p_archetype = 'ops' then 'operations' else 'products' end;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, accent_hex, is_global,
		status, icon, source_kind, repository_key, folder_root, preview_mode, brief_summary, sort_order, created_by_user_id
	)
	values (
		p_company_id, v_slug, v_title,
		case when p_archetype = 'ops' then 'operations' else 'products' end,
		p_archetype, coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'custom'),
		nullif(btrim(coalesce(p_accent_hex, '')), ''),
		coalesce(p_is_global, false) or p_kind = 'identity',
		'active', coalesce(nullif(btrim(coalesce(p_icon, '')), ''), 'globe'),
		v_source_kind,
		case when p_archetype = 'live_build' then 'surfaces/' || v_slug else null end,
		v_folder_root, v_preview_mode,
		nullif(btrim(coalesce(p_brief_summary, '')), ''),
		v_sort_order, v_user_id
	)
	returning * into v_surface;

	if v_surface.archetype = 'live_build' and v_surface.site_id is null then
		perform public.qorpera_surface_ensure_site(v_surface.id);
		select * into v_surface from public.qorpera_surfaces where id = v_surface.id;
	end if;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_create_surface(uuid, text, text, text, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.qorpera_create_surface(uuid, text, text, text, text, text, text, text, text, boolean) to authenticated;

-- WHY: Computes the next scheduled fire timestamp from a plain human schedule summary so Scheduled Agents fire deterministically.
create function public.qorpera_compute_next_automation_run(
	p_schedule_summary text,
	p_from timestamptz default clock_timestamp()
)
returns timestamptz
language plpgsql immutable set search_path = '' as $$
declare
	v_raw text := lower(btrim(coalesce(p_schedule_summary, '')));
	v_from timestamptz := coalesce(p_from, clock_timestamp());
	v_hours integer;
	v_time_match text[];
	v_hour integer := 9;
	v_minute integer := 0;
	v_target_dow integer;
	v_current_dow integer;
	v_days_ahead integer;
	v_candidate timestamptz;
begin
	if v_raw ~ 'every\s+([0-9]{1,2})\s+hours?' then
		v_hours := greatest(1, least(168, (regexp_match(v_raw, 'every\s+([0-9]{1,2})\s+hours?'))[1]::integer));
		return v_from + make_interval(hours => v_hours);
	end if;
	if v_raw ~ 'every\s+hour|hourly' then
		return v_from + interval '1 hour';
	end if;

	v_time_match := regexp_match(v_raw, '([01]?[0-9]|2[0-3]):([0-5][0-9])');
	if v_time_match is not null then
		v_hour := v_time_match[1]::integer;
		v_minute := v_time_match[2]::integer;
	end if;

	v_target_dow := case
		when v_raw ~ '\msunday\M' then 0
		when v_raw ~ '\mmonday\M' then 1
		when v_raw ~ '\mtuesday\M' then 2
		when v_raw ~ '\mwednesday\M' then 3
		when v_raw ~ '\mthursday\M' then 4
		when v_raw ~ '\mfriday\M' then 5
		when v_raw ~ '\msaturday\M' then 6
		else null
	end;

	v_candidate := date_trunc('day', v_from at time zone 'UTC') + make_interval(hours => v_hour, mins => v_minute);
	v_candidate := v_candidate at time zone 'UTC';

	if v_target_dow is not null then
		v_current_dow := extract(dow from v_from at time zone 'UTC')::integer;
		v_days_ahead := (v_target_dow - v_current_dow + 7) % 7;
		v_candidate := v_candidate + make_interval(days => v_days_ahead);
		if v_candidate <= v_from then
			v_candidate := v_candidate + interval '7 days';
		end if;
		return v_candidate;
	end if;

	if v_raw ~ 'weekly' then
		return v_from + interval '7 days';
	end if;

	if v_candidate <= v_from then
		v_candidate := v_candidate + interval '1 day';
	end if;

	if v_raw ~ 'weekday' then
		while extract(dow from v_candidate at time zone 'UTC')::integer in (0, 6) loop
			v_candidate := v_candidate + interval '1 day';
		end loop;
	end if;

	return v_candidate;
end $$;
revoke all on function public.qorpera_compute_next_automation_run(text, timestamptz) from public, anon, authenticated;
grant execute on function public.qorpera_compute_next_automation_run(text, timestamptz) to service_role;

-- WHY: Idempotently seeds Identity, core Ops surfaces, and the Day-1/2 Co-Founder Pulse at company creation before Turn 1 runs.
create function public.qorpera_service_bootstrap_company_surfaces(
	p_company_id uuid,
	p_creator_user_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, is_global,
		status, icon, source_kind, folder_root, preview_mode, brief_summary, sort_order, created_by_user_id
	)
	values (
		p_company_id, 'identity', 'Identity', 'products', 'studio', 'identity', true,
		'active', 'spark', 'folder', 'identity', 'studio_overlay',
		'Global brand, voice, design tokens, and philosophy applied across every surface.',
		0, p_creator_user_id
	)
	on conflict (profile_id, slug) do nothing;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind,
		status, icon, source_kind, preview_mode, sort_order, created_by_user_id
	)
	values
		(p_company_id, 'inbox', 'Inbox', 'operations', 'ops', 'inbox', 'active', 'mail', 'native_ops', 'none', 100, p_creator_user_id),
		(p_company_id, 'money', 'Money', 'operations', 'ops', 'money', 'active', 'coin', 'native_ops', 'none', 110, p_creator_user_id),
		(p_company_id, 'members', 'Members', 'operations', 'ops', 'members', 'active', 'members', 'native_ops', 'none', 120, p_creator_user_id),
		(p_company_id, 'data', 'Databases', 'operations', 'ops', 'data', 'active', 'database', 'native_ops', 'none', 130, p_creator_user_id),
		(p_company_id, 'files', 'Files', 'operations', 'ops', 'files', 'active', 'drawers', 'native_ops', 'none', 140, p_creator_user_id)
	on conflict (profile_id, slug) do nothing;

	insert into public.qorpera_surface_automations(
		profile_id, key, title, prompt, schedule_summary, target_surface_slug,
		output_mode, enabled, status, last_outcome_summary, next_run_at, created_by_user_id
	)
	values (
		p_company_id,
		'cofounder-pulse',
		'Co-Founder Pulse',
		'Review senses.surfaces for open changes, newly approved Identity tokens to propagate downstream, conflicted sessions, and unpublished approved work. Act on concrete next surface improvements and message founders only when previewable work or a real decision awaits.',
		'Every morning · 09:00',
		null,
		'decision_card',
		true,
		'idle',
		'Checks active surfaces and launches next concrete steps.',
		clock_timestamp() + interval '4 hours',
		p_creator_user_id
	)
	on conflict (profile_id, key) do nothing;

	return jsonb_build_object('bootstrapped', true, 'companyId', p_company_id);
end $$;
revoke all on function public.qorpera_service_bootstrap_company_surfaces(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_service_bootstrap_company_surfaces(uuid, uuid) to service_role;

create function public.qorpera_bootstrap_company_surfaces(p_company_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid;
begin
	v_user_id := public.qorpera_assert_surface_member(p_company_id, true);
	perform public.qorpera_service_bootstrap_company_surfaces(p_company_id, v_user_id);
	return public.qorpera_list_surfaces(p_company_id);
end $$;
revoke all on function public.qorpera_bootstrap_company_surfaces(uuid) from public, anon;
grant execute on function public.qorpera_bootstrap_company_surfaces(uuid) to authenticated;

drop function if exists public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text);
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
	p_brief_summary text default null,
	p_kind text default 'custom',
	p_accent_hex text default null,
	p_is_global boolean default false,
	p_activate_immediately boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_slug text := lower(btrim(p_slug));
	v_repo_key text := nullif(btrim(coalesce(p_repository_key, '')), '');
	v_status text := case when coalesce(p_activate_immediately, false) then 'active' else 'proposed' end;
begin
	if p_archetype = 'live_build' and v_repo_key is null and v_slug <> '' then
		v_repo_key := 'surfaces/' || v_slug;
	end if;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, surface_kind, accent_hex, is_global,
		status, icon, source_kind, repository_key, folder_root, preview_mode, brief_summary
	)
	values (
		p_company_id, v_slug, btrim(p_title), p_group, p_archetype,
		coalesce(nullif(btrim(coalesce(p_kind, '')), ''), 'custom'),
		nullif(btrim(coalesce(p_accent_hex, '')), ''),
		coalesce(p_is_global, false) or p_kind = 'identity',
		v_status,
		coalesce(nullif(btrim(coalesce(p_icon, '')), ''), 'page'),
		p_source_kind, v_repo_key, p_folder_root, coalesce(p_preview_mode, 'none'), p_brief_summary
	)
	on conflict (profile_id, slug) do update set
		title = excluded.title,
		surface_kind = coalesce(excluded.surface_kind, public.qorpera_surfaces.surface_kind),
		accent_hex = coalesce(excluded.accent_hex, public.qorpera_surfaces.accent_hex),
		is_global = public.qorpera_surfaces.is_global or excluded.is_global,
		repository_key = coalesce(public.qorpera_surfaces.repository_key, excluded.repository_key),
		status = case when excluded.status = 'active' then 'active' else public.qorpera_surfaces.status end,
		brief_summary = coalesce(excluded.brief_summary, public.qorpera_surfaces.brief_summary),
		updated_at = clock_timestamp()
	returning * into v_surface;

	if v_surface.archetype = 'live_build' and v_surface.status = 'active' and v_surface.site_id is null then
		perform public.qorpera_surface_ensure_site(v_surface.id);
		select * into v_surface from public.qorpera_surfaces where id = v_surface.id;
	end if;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean)
	from public, anon, authenticated;
grant execute on function public.qorpera_propose_surface(uuid, text, text, text, text, text, text, text, text, text, text, text, text, boolean, boolean)
	to service_role;

drop function if exists public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text);
create function public.qorpera_start_surface_session(
	p_surface_id uuid,
	p_prompt text,
	p_title text default null,
	p_origin_kind text default 'member',
	p_origin_label text default null,
	p_origin_ref jsonb default null,
	p_exploration_count integer default null,
	p_exploration_title text default null,
	p_variant_labels text[] default null
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
	v_variant_label text;
	v_owner_label text;
begin
	if char_length(v_prompt) < 1 or char_length(v_prompt) > 16000 then
		raise exception 'Prompt must be 1..16000 characters' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);

	v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''), left(v_prompt, 80));
	v_owner_label := nullif(btrim(coalesce(p_origin_label, '')), '');
	v_placement := public.qorpera_surface_machine_placement_hint(v_surface.profile_id, 6);
	v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;

	if p_exploration_count is not null and p_exploration_count between 2 and 3 then
		v_count := p_exploration_count;
		insert into public.qorpera_surface_explorations(profile_id, surface_id, title, owner_label, created_by_kind)
		values (
			v_surface.profile_id, p_surface_id,
			coalesce(nullif(btrim(coalesce(p_exploration_title, '')), ''), v_title),
			coalesce(v_owner_label, 'Co-Founder'),
			case when coalesce(p_origin_kind, 'member') in ('cofounder', 'automation') then p_origin_kind else 'member' end
		)
		returning id into v_exploration_id;

		for v_idx in 1..v_count loop
			v_variant_label := coalesce(
				nullif(btrim(coalesce(p_variant_labels[v_idx], '')), ''),
				'Direction ' || v_idx::text
			);
			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
			)
			values (
				v_surface.profile_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, coalesce(p_origin_kind, 'member'), coalesce(v_owner_label, 'Co-Founder'), p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
			)
			returning * into v_session;

			insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
			values (v_surface.profile_id, v_session.id, 'member', v_user_id, v_prompt);
		end loop;
	else
		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, origin_ref, created_by_user_id, state, base_sha
		)
		values (
			v_surface.profile_id, p_surface_id, v_machine_id, v_title, v_prompt,
			coalesce(p_origin_kind, 'member'), v_owner_label, p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
		)
		returning * into v_session;

		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
		values (v_surface.profile_id, v_session.id, 'member', v_user_id, v_prompt);
	end if;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text, text[]) from public, anon;
grant execute on function public.qorpera_start_surface_session(uuid, text, text, text, text, jsonb, integer, text, text[]) to authenticated;

create function public.qorpera_service_start_surface_session(
	p_company_id uuid,
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
	v_surface public.qorpera_surfaces%rowtype;
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_title text;
	v_exploration_id uuid;
	v_session public.qorpera_surface_sessions%rowtype;
	v_placement jsonb;
	v_machine_id uuid;
	v_idx integer;
	v_count integer;
	v_variant_label text;
	v_owner_label text := coalesce(nullif(btrim(coalesce(p_origin_label, '')), ''), 'Co-Founder');
begin
	if char_length(v_prompt) < 1 or char_length(v_prompt) > 16000 then
		raise exception 'Prompt must be 1..16000 characters' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id and profile_id = p_company_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;

	v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''), left(v_prompt, 80));
	v_placement := public.qorpera_surface_machine_placement_hint(p_company_id, 6);
	v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;

	if p_exploration_count is not null and p_exploration_count between 2 and 3 then
		v_count := p_exploration_count;
		insert into public.qorpera_surface_explorations(profile_id, surface_id, title, owner_label, created_by_kind)
		values (
			p_company_id, p_surface_id,
			coalesce(nullif(btrim(coalesce(p_exploration_title, '')), ''), v_title),
			v_owner_label,
			case when coalesce(p_origin_kind, 'cofounder') = 'automation' then 'automation' else 'cofounder' end
		)
		returning id into v_exploration_id;

		for v_idx in 1..v_count loop
			v_variant_label := coalesce(
				nullif(btrim(coalesce(p_variant_labels[v_idx], '')), ''),
				'Direction ' || v_idx::text
			);
			insert into public.qorpera_surface_sessions(
				profile_id, surface_id, machine_id, exploration_id, exploration_variant_label,
				title, prompt, origin_kind, origin_label, state, base_sha
			)
			values (
				p_company_id, p_surface_id, v_machine_id, v_exploration_id,
				left(v_variant_label, 80),
				left(v_variant_label, 160),
				v_prompt, coalesce(p_origin_kind, 'cofounder'), v_owner_label, 'queued', v_surface.live_head_sha
			)
			returning * into v_session;

			insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
			values (p_company_id, v_session.id, 'system', v_prompt);
		end loop;
	else
		insert into public.qorpera_surface_sessions(
			profile_id, surface_id, machine_id, title, prompt,
			origin_kind, origin_label, state, base_sha
		)
		values (
			p_company_id, p_surface_id, v_machine_id, v_title, v_prompt,
			coalesce(p_origin_kind, 'cofounder'), v_owner_label, 'queued', v_surface.live_head_sha
		)
		returning * into v_session;

		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
		values (p_company_id, v_session.id, 'system', v_prompt);
	end if;

	return jsonb_build_object(
		'sessionId', v_session.id,
		'explorationId', v_exploration_id,
		'session', public.qorpera_surface_session_json(v_session)
	);
end $$;
revoke all on function public.qorpera_service_start_surface_session(uuid, uuid, text, text, text, text, integer, text, text[])
	from public, anon, authenticated;
grant execute on function public.qorpera_service_start_surface_session(uuid, uuid, text, text, text, text, integer, text, text[])
	to service_role;

create function public.qorpera_discard_exploration(p_exploration_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_exploration public.qorpera_surface_explorations%rowtype;
begin
	select * into v_exploration from public.qorpera_surface_explorations where id = p_exploration_id for update;
	if v_exploration.id is null then raise exception 'Exploration not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_exploration.profile_id, true);

	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = clock_timestamp()
	where session_id in (
		select id from public.qorpera_surface_sessions where exploration_id = p_exploration_id
	) and status in ('staged', 'conflicted');

	update public.qorpera_surface_sessions
	set state = 'discarded', has_active_chat = false, closed_at = clock_timestamp(), updated_at = clock_timestamp()
	where exploration_id = p_exploration_id;

	update public.qorpera_surface_explorations
	set status = 'discarded', resolved_at = clock_timestamp()
	where id = p_exploration_id
	returning * into v_exploration;

	update public.qorpera_member_surface_state
	set active_exploration_session_id = null, compare_session_ids = '{}'::uuid[]
	where surface_id = v_exploration.surface_id;

	return jsonb_build_object(
		'id', v_exploration.id,
		'surfaceId', v_exploration.surface_id,
		'status', v_exploration.status,
		'resolvedAt', v_exploration.resolved_at
	);
end $$;
revoke all on function public.qorpera_discard_exploration(uuid) from public, anon;
grant execute on function public.qorpera_discard_exploration(uuid) to authenticated;

create or replace function public.qorpera_approve_surface_change(p_change_id uuid, p_include_dependencies boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_change public.qorpera_surface_changes%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_user_id uuid;
	v_target_ids uuid[];
	v_needs_worker boolean := false;
	v_merged_count integer;
begin
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_change.profile_id, true);

	if v_change.status not in ('staged', 'conflicted') then
		raise exception 'Change is not open for approval' using errcode = '22023';
	end if;

	if coalesce(p_include_dependencies, true) and cardinality(v_change.depends_on_change_ids) > 0 then
		v_target_ids := array_append(v_change.depends_on_change_ids, v_change.id);
	else
		v_target_ids := array[v_change.id];
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_change.surface_id for update;

	v_needs_worker := (
		(v_change.kind = 'git_range' and v_surface.repository_key is not null and v_change.head_sha is not null)
		or (v_change.kind in ('folder_patch', 'ops_action') and v_change.patch_manifest is not null)
	);

	if v_needs_worker then
		update public.qorpera_surface_changes
		set
			status = 'merging',
			conflict_paths = null,
			approved_by_user_id = v_user_id
		where id = any(v_target_ids)
			and session_id = v_change.session_id
			and status in ('staged', 'conflicted');

		insert into public.qorpera_surface_jobs(
			profile_id, surface_id, session_id, kind, payload, requested_by_user_id
		)
		values (
			v_change.profile_id, v_change.surface_id, v_change.session_id, 'land_change',
			jsonb_build_object('changeIds', to_jsonb(v_target_ids), 'autoPublish', v_surface.auto_publish),
			v_user_id
		);
	else
		update public.qorpera_surface_changes
		set
			status = 'merged',
			conflict_paths = null,
			approved_by_user_id = v_user_id,
			published_at = case when v_surface.auto_publish then clock_timestamp() else null end,
			published_by_user_id = case when v_surface.auto_publish then v_user_id else null end,
			resolved_at = clock_timestamp()
		where id = any(v_target_ids)
			and session_id = v_change.session_id
			and status in ('staged', 'conflicted');
		get diagnostics v_merged_count = row_count;

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
	end if;

	update public.qorpera_member_surface_state
	set toggled_change_ids = array(
		select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_target_ids))
	)
	where surface_id = v_change.surface_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;

create or replace function public.qorpera_approve_session_all(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_change_ids uuid[];
	v_needs_worker boolean := false;
	v_merged_count integer;
	v_last_sha text;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_session.profile_id, true);

	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id for update;

	select
		coalesce(array_agg(ch.id order by ch.seq asc), '{}'::uuid[]),
		bool_or(
			(ch.kind = 'git_range' and v_surface.repository_key is not null and ch.head_sha is not null)
			or (ch.kind in ('folder_patch', 'ops_action') and ch.patch_manifest is not null)
		)
	into v_change_ids, v_needs_worker
	from public.qorpera_surface_changes ch
	where ch.session_id = p_session_id and ch.status in ('staged', 'conflicted');

	if cardinality(v_change_ids) > 0 and coalesce(v_needs_worker, false) then
		update public.qorpera_surface_changes
		set status = 'merging', conflict_paths = null, approved_by_user_id = v_user_id
		where id = any(v_change_ids);

		insert into public.qorpera_surface_jobs(
			profile_id, surface_id, session_id, kind, payload, requested_by_user_id
		)
		values (
			v_session.profile_id, v_session.surface_id, p_session_id, 'land_change',
			jsonb_build_object('changeIds', to_jsonb(v_change_ids), 'autoPublish', v_surface.auto_publish),
			v_user_id
		);
	elsif cardinality(v_change_ids) > 0 then
		select head_sha into v_last_sha
		from public.qorpera_surface_changes
		where id = any(v_change_ids)
		order by seq desc
		limit 1;

		update public.qorpera_surface_changes
		set
			status = 'merged',
			conflict_paths = null,
			approved_by_user_id = v_user_id,
			published_at = case when v_surface.auto_publish then clock_timestamp() else null end,
			published_by_user_id = case when v_surface.auto_publish then v_user_id else null end,
			resolved_at = clock_timestamp()
		where id = any(v_change_ids);
		get diagnostics v_merged_count = row_count;

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

create or replace function public.qorpera_undo_surface_change(p_change_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_change public.qorpera_surface_changes%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_user_id uuid;
begin
	select * into v_change from public.qorpera_surface_changes where id = p_change_id for update;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_change.profile_id, true);

	if v_change.status not in ('merged', 'discarded') then
		raise exception 'Change cannot be undone from current status' using errcode = '22023';
	end if;
	if v_change.published_at is not null then
		raise exception 'Published change cannot be rolled back before release; start a new change instead' using errcode = '22023';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_change.surface_id for update;
	select * into v_session from public.qorpera_surface_sessions where id = v_change.session_id for update;

	if v_change.status = 'merged' then
		update public.qorpera_surfaces
		set
			unpublished_change_count = greatest(0, unpublished_change_count - 1),
			updated_at = clock_timestamp()
		where id = v_change.surface_id;

		if (v_change.kind = 'git_range' and v_surface.repository_key is not null and v_change.landed_main_after is not null)
			or (v_change.kind = 'folder_patch' and v_change.patch_manifest is not null) then
			insert into public.qorpera_surface_jobs(
				profile_id, surface_id, session_id, kind, payload, requested_by_user_id
			)
			values (
				v_change.profile_id, v_change.surface_id, v_change.session_id, 'undo_change',
				jsonb_build_object(
					'changeId', v_change.id,
					'landedMainBefore', v_change.landed_main_before,
					'landedMainAfter', v_change.landed_main_after
				),
				v_user_id
			);
		end if;
	end if;

	-- WHY: Rolling back a chosen exploration variant must re-open the full exploration so siblings can be reconsidered.
	if v_session.exploration_id is not null then
		update public.qorpera_surface_explorations
		set status = 'open', chosen_session_id = null, resolved_at = null
		where id = v_session.exploration_id and status = 'chosen';

		update public.qorpera_surface_changes
		set status = 'staged', resolved_at = null, approved_by_user_id = null
		where session_id in (
			select id from public.qorpera_surface_sessions where exploration_id = v_session.exploration_id
		) and published_at is null;

		update public.qorpera_surface_sessions
		set state = 'ready', closed_at = null, updated_at = clock_timestamp()
		where exploration_id = v_session.exploration_id and state in ('completed', 'discarded');
	else
		update public.qorpera_surface_changes
		set status = 'staged', resolved_at = null, approved_by_user_id = null
		where id = p_change_id;

		update public.qorpera_surface_sessions
		set state = 'ready', closed_at = null, updated_at = clock_timestamp()
		where id = v_change.session_id and state in ('completed', 'discarded');
	end if;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;

create or replace function public.qorpera_publish_surface(p_surface_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);

	if v_surface.source_kind = 'code_repo' and v_surface.repository_key is not null then
		if v_surface.site_id is null then
			perform public.qorpera_surface_ensure_site(p_surface_id);
			select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
		end if;
		update public.qorpera_surfaces
		set
			publish_status = 'publishing',
			last_publish_error = null,
			updated_at = clock_timestamp()
		where id = p_surface_id
		returning * into v_surface;

		insert into public.qorpera_surface_jobs(
			profile_id, surface_id, kind, payload, requested_by_user_id
		)
		values (
			v_surface.profile_id, p_surface_id, 'publish_surface',
			jsonb_build_object('liveHeadSha', v_surface.live_head_sha, 'repositoryKey', v_surface.repository_key),
			v_user_id
		);
	else
		update public.qorpera_surface_changes
		set published_at = clock_timestamp(), published_by_user_id = v_user_id
		where surface_id = p_surface_id and status = 'merged' and published_at is null;

		update public.qorpera_surfaces
		set
			published_head_sha = live_head_sha,
			unpublished_change_count = 0,
			publish_status = 'idle',
			last_publish_error = null,
			updated_at = clock_timestamp()
		where id = p_surface_id
		returning * into v_surface;
	end if;

	return public.qorpera_surface_summary_json(v_surface);
end $$;

create or replace function public.qorpera_list_automations(p_company_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	perform public.qorpera_assert_surface_member(p_company_id, false);
	return coalesce(
		(
			select jsonb_agg(item order by sort_ts desc)
			from (
				select
					jsonb_build_object(
						'id', a.id,
						'key', a.key,
						'title', a.title,
						'prompt', a.prompt,
						'scheduleSummary', a.schedule_summary,
						'targetSurfaceSlug', a.target_surface_slug,
						'outputMode', a.output_mode,
						'enabled', a.enabled,
						'status', case when a.enabled then a.status else 'paused' end,
						'lastRunAt', a.last_run_at,
						'lastOutcomeSummary', a.last_outcome_summary,
						'nextRunAt', a.next_run_at
					) as item,
					a.updated_at as sort_ts
				from public.qorpera_surface_automations a
				where a.profile_id = p_company_id

				union all

				select
					jsonb_build_object(
						'id', r.id,
						'key', r.client_routine_id::text,
						'title', coalesce(rv.title, 'Routine'),
						'prompt', rv.prompt,
						'scheduleSummary', coalesce(rv.triggers -> 0 ->> 'kind', 'scheduled'),
						'targetSurfaceSlug', null,
						'outputMode', 'surface_session',
						'enabled', (r.status = 'active'),
						'status', case when r.status = 'active' then 'idle' else 'paused' end,
						'lastRunAt', r.updated_at,
						'lastOutcomeSummary', null,
						'nextRunAt', null
					) as item,
					r.updated_at as sort_ts
				from public.qorpera_cloud_routines r
				left join public.qorpera_cloud_routine_versions rv
					on rv.routine_id = r.id and rv.version = r.current_version
				where r.profile_id = p_company_id
					and r.status <> 'retired'
					and not exists (
						select 1 from public.qorpera_surface_automations sa
						where sa.routine_id = r.id
					)
			) combined
		),
		'[]'::jsonb
	);
end $$;

create function public.qorpera_create_surface_automation(
	p_company_id uuid,
	p_title text,
	p_prompt text,
	p_schedule_summary text default 'Every day · 09:00',
	p_target_surface_slug text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid;
	v_title text := btrim(coalesce(p_title, ''));
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_schedule text := coalesce(nullif(btrim(coalesce(p_schedule_summary, '')), ''), 'Every day · 09:00');
	v_target text := nullif(lower(btrim(coalesce(p_target_surface_slug, ''))), '');
	v_base_key text;
	v_key text;
	v_suffix integer := 1;
	v_row public.qorpera_surface_automations%rowtype;
begin
	v_user_id := public.qorpera_assert_surface_member(p_company_id, true);
	if char_length(v_title) < 1 or char_length(v_title) > 120 then
		raise exception 'Title must be 1..120 characters' using errcode = '22023';
	end if;
	if char_length(v_prompt) < 1 or char_length(v_prompt) > 16000 then
		raise exception 'Prompt must be 1..16000 characters' using errcode = '22023';
	end if;

	v_base_key := left(btrim(lower(regexp_replace(v_title, '[^a-zA-Z0-9]+', '-', 'g')), '-'), 70);
	if v_base_key = '' then v_base_key := 'agent'; end if;
	v_key := v_base_key;
	while exists (select 1 from public.qorpera_surface_automations where profile_id = p_company_id and key = v_key) loop
		v_suffix := v_suffix + 1;
		v_key := left(v_base_key, 66) || '-' || v_suffix::text;
	end loop;

	insert into public.qorpera_surface_automations(
		profile_id, key, title, prompt, schedule_summary, target_surface_slug,
		output_mode, enabled, status, last_outcome_summary, next_run_at, created_by_user_id
	)
	values (
		p_company_id, v_key, v_title, v_prompt, v_schedule, v_target,
		case when v_target is not null then 'surface_session' else 'decision_card' end,
		true, 'idle', left(v_prompt, 120),
		public.qorpera_compute_next_automation_run(v_schedule, clock_timestamp()),
		v_user_id
	)
	returning * into v_row;

	return jsonb_build_object(
		'id', v_row.id,
		'key', v_row.key,
		'title', v_row.title,
		'prompt', v_row.prompt,
		'scheduleSummary', v_row.schedule_summary,
		'targetSurfaceSlug', v_row.target_surface_slug,
		'outputMode', v_row.output_mode,
		'enabled', v_row.enabled,
		'status', v_row.status,
		'lastRunAt', v_row.last_run_at,
		'lastOutcomeSummary', v_row.last_outcome_summary,
		'nextRunAt', v_row.next_run_at
	);
end $$;
revoke all on function public.qorpera_create_surface_automation(uuid, text, text, text, text) from public, anon;
grant execute on function public.qorpera_create_surface_automation(uuid, text, text, text, text) to authenticated;

create function public.qorpera_update_surface_automation(
	p_automation_id uuid,
	p_title text default null,
	p_prompt text default null,
	p_schedule_summary text default null,
	p_target_surface_slug text default null,
	p_clear_target boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_row public.qorpera_surface_automations%rowtype;
	v_target text;
begin
	select * into v_row from public.qorpera_surface_automations where id = p_automation_id for update;
	if v_row.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_row.profile_id, true);

	v_target := case
		when coalesce(p_clear_target, false) then null
		when p_target_surface_slug is not null then nullif(lower(btrim(p_target_surface_slug)), '')
		else v_row.target_surface_slug
	end;

	update public.qorpera_surface_automations
	set
		title = coalesce(nullif(btrim(coalesce(p_title, '')), ''), title),
		prompt = coalesce(nullif(btrim(coalesce(p_prompt, '')), ''), prompt),
		schedule_summary = coalesce(nullif(btrim(coalesce(p_schedule_summary, '')), ''), schedule_summary),
		target_surface_slug = v_target,
		output_mode = case when v_target is not null then 'surface_session' else 'decision_card' end,
		next_run_at = case
			when enabled then public.qorpera_compute_next_automation_run(
				coalesce(nullif(btrim(coalesce(p_schedule_summary, '')), ''), schedule_summary),
				clock_timestamp()
			)
			else null
		end,
		updated_at = clock_timestamp()
	where id = p_automation_id
	returning * into v_row;

	return jsonb_build_object(
		'id', v_row.id,
		'key', v_row.key,
		'title', v_row.title,
		'prompt', v_row.prompt,
		'scheduleSummary', v_row.schedule_summary,
		'targetSurfaceSlug', v_row.target_surface_slug,
		'outputMode', v_row.output_mode,
		'enabled', v_row.enabled,
		'status', case when v_row.enabled then v_row.status else 'paused' end,
		'lastRunAt', v_row.last_run_at,
		'lastOutcomeSummary', v_row.last_outcome_summary,
		'nextRunAt', v_row.next_run_at
	);
end $$;
revoke all on function public.qorpera_update_surface_automation(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.qorpera_update_surface_automation(uuid, text, text, text, text, boolean) to authenticated;

create function public.qorpera_delete_surface_automation(p_automation_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
	v_row public.qorpera_surface_automations%rowtype;
begin
	select * into v_row from public.qorpera_surface_automations where id = p_automation_id for update;
	if v_row.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_row.profile_id, true);

	delete from public.qorpera_surface_automations where id = p_automation_id;
	return true;
end $$;
revoke all on function public.qorpera_delete_surface_automation(uuid) from public, anon;
grant execute on function public.qorpera_delete_surface_automation(uuid) to authenticated;

create or replace function public.qorpera_toggle_automation(p_automation_id uuid, p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_auto public.qorpera_surface_automations%rowtype;
	v_routine public.qorpera_cloud_routines%rowtype;
	v_title text;
	v_prompt text;
begin
	select * into v_auto from public.qorpera_surface_automations where id = p_automation_id for update;
	if v_auto.id is not null then
		perform public.qorpera_assert_surface_member(v_auto.profile_id, true);
		update public.qorpera_surface_automations
		set
			enabled = coalesce(p_enabled, false),
			status = case when coalesce(p_enabled, false) then 'idle' else 'paused' end,
			next_run_at = case
				when coalesce(p_enabled, false) then public.qorpera_compute_next_automation_run(schedule_summary, clock_timestamp())
				else null
			end,
			updated_at = clock_timestamp()
		where id = p_automation_id
		returning * into v_auto;

		return jsonb_build_object(
			'id', v_auto.id,
			'key', v_auto.key,
			'title', v_auto.title,
			'prompt', v_auto.prompt,
			'scheduleSummary', v_auto.schedule_summary,
			'targetSurfaceSlug', v_auto.target_surface_slug,
			'outputMode', v_auto.output_mode,
			'enabled', v_auto.enabled,
			'status', v_auto.status,
			'lastRunAt', v_auto.last_run_at,
			'lastOutcomeSummary', v_auto.last_outcome_summary,
			'nextRunAt', v_auto.next_run_at
		);
	end if;

	select * into v_routine from public.qorpera_cloud_routines where id = p_automation_id for update;
	if v_routine.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_routine.profile_id, true);

	update public.qorpera_cloud_routines
	set status = case when coalesce(p_enabled, false) then 'active' else 'paused' end, updated_at = clock_timestamp()
	where id = p_automation_id
	returning * into v_routine;

	select rv.title, rv.prompt into v_title, v_prompt
	from public.qorpera_cloud_routine_versions rv
	where rv.routine_id = v_routine.id and rv.version = v_routine.current_version;

	return jsonb_build_object(
		'id', v_routine.id,
		'key', v_routine.client_routine_id::text,
		'title', coalesce(v_title, 'Routine'),
		'prompt', v_prompt,
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

-- WHY: Claims due Scheduled Agents, advances their next_run_at, and spawns queued surface sessions for surface-targeted automations.
create function public.qorpera_surface_claim_due_automations(p_limit integer default 16)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_cap integer := greatest(1, least(coalesce(p_limit, 16), 64));
	v_now timestamptz := clock_timestamp();
	v_auto record;
	v_surface public.qorpera_surfaces%rowtype;
	v_placement jsonb;
	v_machine_id uuid;
	v_session_id uuid;
	v_results jsonb := '[]'::jsonb;
begin
	for v_auto in
		with picked as (
			select a.id
			from public.qorpera_surface_automations a
			where a.enabled = true
				and a.next_run_at is not null
				and a.next_run_at <= v_now
				and not public.qorpera_surface_company_paused(a.profile_id)
			order by a.next_run_at asc
			limit v_cap
			for update skip locked
		)
		update public.qorpera_surface_automations a
		set
			last_run_at = v_now,
			next_run_at = public.qorpera_compute_next_automation_run(a.schedule_summary, v_now),
			status = 'idle',
			updated_at = v_now
		from picked
		where a.id = picked.id
		returning a.*
	loop
		v_session_id := null;
		v_surface := null;
		if v_auto.target_surface_slug is not null then
			select * into v_surface
			from public.qorpera_surfaces s
			where s.profile_id = v_auto.profile_id
				and s.slug = v_auto.target_surface_slug
				and s.status = 'active'
			limit 1;

			if v_surface.id is not null then
				v_placement := public.qorpera_surface_machine_placement_hint(v_auto.profile_id, 6);
				v_machine_id := case when v_placement ->> 'machineId' is not null then (v_placement ->> 'machineId')::uuid else null end;

				insert into public.qorpera_surface_sessions(
					profile_id, surface_id, machine_id, title, prompt,
					origin_kind, origin_label, state, base_sha
				)
				values (
					v_auto.profile_id, v_surface.id, v_machine_id, left(v_auto.title, 160), v_auto.prompt,
					'automation', v_auto.title, 'queued', v_surface.live_head_sha
				)
				returning id into v_session_id;

				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (v_auto.profile_id, v_session_id, 'system', v_auto.prompt);
			end if;
		end if;

		v_results := v_results || jsonb_build_array(
			jsonb_build_object(
				'automationId', v_auto.id,
				'profileId', v_auto.profile_id,
				'key', v_auto.key,
				'title', v_auto.title,
				'prompt', v_auto.prompt,
				'targetSurfaceSlug', v_auto.target_surface_slug,
				'outputMode', v_auto.output_mode,
				'sessionId', v_session_id,
				'surfaceId', v_surface.id
			)
		);
	end loop;

	return v_results;
end $$;
revoke all on function public.qorpera_surface_claim_due_automations(integer) from public, anon, authenticated;
grant execute on function public.qorpera_surface_claim_due_automations(integer) to service_role;

create or replace function public.qorpera_surface_claim_pending_jobs(p_limit integer default 16)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_cap integer := greatest(1, least(coalesce(p_limit, 16), 64));
	v_now timestamptz := clock_timestamp();
	v_lease timestamptz := v_now + interval '5 minutes';
	v_automations jsonb;
	v_sessions jsonb;
	v_previews jsonb;
	v_merges jsonb;
	v_publishes jsonb;
begin
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
			state = case when s.state = 'queued' then 'running' else s.state end,
			lease_expires_at = v_lease,
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
				'state', case when c.state = 'reconciling' then 'reconciling' else 'queued' end,
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
		set status = 'building', lease_expires_at = v_lease
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
				'shortHostId', p.short_host_id,
				'baseSha', p.base_sha,
				'selectedChangeIds', to_jsonb(p.selected_change_ids),
				'repositoryKey', surf.repository_key,
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
	left join public.qorpera_surface_sessions exp_sess on exp_sess.id = p.exploration_session_id;

	with picked as (
		select j.id
		from public.qorpera_surface_jobs j
		where j.kind in ('land_change', 'undo_change')
			and (
				j.status = 'queued'
				or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= v_now)
			)
			and not public.qorpera_surface_company_paused(j.profile_id)
		order by j.created_at asc
		limit v_cap
		for update skip locked
	),
	claimed as (
		update public.qorpera_surface_jobs j
		set status = 'running', attempts = j.attempts + 1, lease_expires_at = v_lease, updated_at = v_now
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
				'sourceKind', surf.source_kind,
				'repositoryKey', surf.repository_key,
				'folderRoot', surf.folder_root,
				'autoPublish', surf.auto_publish,
				'expectMainSha', surf.live_head_sha,
				'sessionWorkerId', sess.worker_id,
				'sessionState', sess.state,
				'sessionHasActiveChat', coalesce(sess.has_active_chat, false),
				'payload', j.payload,
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
	left join public.qorpera_surface_sessions sess on sess.id = j.session_id;

	with picked as (
		select j.id
		from public.qorpera_surface_jobs j
		where j.kind = 'publish_surface'
			and (
				j.status = 'queued'
				or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= v_now)
			)
			and not public.qorpera_surface_company_paused(j.profile_id)
		order by j.created_at asc
		limit v_cap
		for update skip locked
	),
	claimed as (
		update public.qorpera_surface_jobs j
		set status = 'running', attempts = j.attempts + 1, lease_expires_at = v_lease, updated_at = v_now
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
				'repositoryKey', surf.repository_key,
				'siteId', surf.site_id,
				'payload', j.payload
			)
			order by j.created_at asc
		),
		'[]'::jsonb
	)
	into v_publishes
	from claimed j
	join public.qorpera_surfaces surf on surf.id = j.surface_id;

	return jsonb_build_object(
		'sessions', v_sessions,
		'previews', v_previews,
		'merges', v_merges,
		'publishes', v_publishes,
		'automations', v_automations
	);
end $$;

create function public.qorpera_surface_complete_session_turn(
	p_session_id uuid,
	p_state text,
	p_reply_text text default null,
	p_question jsonb default null,
	p_note_paths text[] default null,
	p_branch_head_sha text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_next_state text := p_state;
	v_retry_increment integer := 0;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;

	if p_state = 'failed' and v_session.retry_count < 1 then
		v_next_state := 'queued';
		v_retry_increment := 1;
		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
		values (
			v_session.profile_id,
			p_session_id,
			'system',
			coalesce(
				nullif(btrim(coalesce(p_reply_text, '')), ''),
				'Previous attempt failed; retrying automatically.'
			)
		);
	elsif p_reply_text is not null and char_length(btrim(p_reply_text)) > 0 then
		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
		values (v_session.profile_id, p_session_id, 'session', btrim(p_reply_text));
	end if;

	update public.qorpera_surface_sessions
	set
		state = v_next_state,
		retry_count = retry_count + v_retry_increment,
		question = case when v_next_state = 'queued' then null else p_question end,
		note_paths = case when p_note_paths is not null then p_note_paths else note_paths end,
		branch_head_sha = coalesce(p_branch_head_sha, branch_head_sha),
		lease_expires_at = null,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_surface_complete_session_turn(uuid, text, text, jsonb, text[], text)
	from public, anon, authenticated;
grant execute on function public.qorpera_surface_complete_session_turn(uuid, text, text, jsonb, text[], text)
	to service_role;

create function public.qorpera_surface_complete_merge(
	p_job_id uuid,
	p_status text,
	p_main_before text default null,
	p_main_after text default null,
	p_conflict_change_id uuid default null,
	p_conflict_paths text[] default null,
	p_error_detail text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_surface_jobs%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_change_ids uuid[];
	v_merged_count integer := 0;
begin
	select * into v_job from public.qorpera_surface_jobs where id = p_job_id for update;
	if v_job.id is null then raise exception 'Surface job not found' using errcode = 'P0002'; end if;

	select * into v_surface from public.qorpera_surfaces where id = v_job.surface_id for update;

	if v_job.kind = 'land_change' then
		select coalesce(array_agg(x::uuid), '{}'::uuid[])
		into v_change_ids
		from jsonb_array_elements_text(coalesce(v_job.payload -> 'changeIds', '[]'::jsonb)) as x;

		if p_status = 'landed' then
			update public.qorpera_surface_changes
			set
				status = 'merged',
				conflict_paths = null,
				landed_main_before = coalesce(p_main_before, landed_main_before),
				landed_main_after = coalesce(p_main_after, landed_main_after),
				resolved_at = clock_timestamp()
			where id = any(v_change_ids) and status in ('merging', 'staged', 'conflicted');
			get diagnostics v_merged_count = row_count;

			update public.qorpera_surfaces
			set
				live_head_sha = coalesce(p_main_after, live_head_sha),
				unpublished_change_count = unpublished_change_count + greatest(v_merged_count, 0),
				updated_at = clock_timestamp()
			where id = v_job.surface_id;

			if coalesce((v_job.payload ->> 'autoPublish')::boolean, false) then
				insert into public.qorpera_surface_jobs(
					profile_id, surface_id, kind, payload, requested_by_user_id
				)
				values (
					v_job.profile_id, v_job.surface_id, 'publish_surface',
					jsonb_build_object('liveHeadSha', coalesce(p_main_after, v_surface.live_head_sha), 'repositoryKey', v_surface.repository_key),
					v_job.requested_by_user_id
				);
			end if;
		elsif p_status = 'conflicted' then
			update public.qorpera_surface_changes
			set
				status = case when id = p_conflict_change_id then 'conflicted' else 'staged' end,
				conflict_paths = case when id = p_conflict_change_id then p_conflict_paths else null end
			where id = any(v_change_ids) and status = 'merging';
		else
			update public.qorpera_surface_changes
			set status = 'staged'
			where id = any(v_change_ids) and status = 'merging';
		end if;

		if v_job.session_id is not null then
			perform public.qorpera_evaluate_surface_session_lifecycle(v_job.session_id);
		end if;
	elsif v_job.kind = 'undo_change' and p_status = 'landed' and p_main_after is not null then
		update public.qorpera_surfaces
		set live_head_sha = p_main_after, updated_at = clock_timestamp()
		where id = v_job.surface_id;
	end if;

	update public.qorpera_surface_jobs
	set
		status = case when p_status in ('landed', 'conflicted') then 'completed' else 'failed' end,
		error_detail = p_error_detail,
		lease_expires_at = null,
		completed_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = p_job_id;

	return jsonb_build_object('jobId', p_job_id, 'status', p_status);
end $$;
revoke all on function public.qorpera_surface_complete_merge(uuid, text, text, text, uuid, text[], text)
	from public, anon, authenticated;
grant execute on function public.qorpera_surface_complete_merge(uuid, text, text, text, uuid, text[], text)
	to service_role;

create function public.qorpera_surface_complete_publish(
	p_job_id uuid,
	p_status text,
	p_published_head_sha text default null,
	p_error_detail text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_job public.qorpera_surface_jobs%rowtype;
begin
	select * into v_job from public.qorpera_surface_jobs where id = p_job_id for update;
	if v_job.id is null then raise exception 'Surface job not found' using errcode = 'P0002'; end if;

	if p_status = 'published' then
		update public.qorpera_surface_changes
		set
			published_at = clock_timestamp(),
			published_by_user_id = v_job.requested_by_user_id
		where surface_id = v_job.surface_id and status = 'merged' and published_at is null;

		update public.qorpera_surfaces
		set
			published_head_sha = coalesce(p_published_head_sha, live_head_sha),
			unpublished_change_count = 0,
			publish_status = 'idle',
			last_publish_error = null,
			updated_at = clock_timestamp()
		where id = v_job.surface_id;
	else
		update public.qorpera_surfaces
		set
			publish_status = 'failed',
			last_publish_error = p_error_detail,
			updated_at = clock_timestamp()
		where id = v_job.surface_id;
	end if;

	update public.qorpera_surface_jobs
	set
		status = case when p_status = 'published' then 'completed' else 'failed' end,
		error_detail = p_error_detail,
		lease_expires_at = null,
		completed_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = p_job_id;

	return jsonb_build_object('jobId', p_job_id, 'status', p_status);
end $$;
revoke all on function public.qorpera_surface_complete_publish(uuid, text, text, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_surface_complete_publish(uuid, text, text, text)
	to service_role;

create function public.qorpera_surface_describe_company_senses(p_company_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'surfaces', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'id', s.id,
						'slug', s.slug,
						'title', s.title,
						'kind', s.surface_kind,
						'archetype', s.archetype,
						'status', s.status,
						'isGlobal', s.is_global,
						'sourceKind', s.source_kind,
						'repositoryKey', s.repository_key,
						'folderRoot', s.folder_root,
						'unpublishedChangeCount', s.unpublished_change_count,
						'publishStatus', s.publish_status,
						'activeSessions', coalesce(sess.items, '[]'::jsonb)
					)
					order by s.surface_group asc, s.sort_order asc, s.created_at asc
				)
				from public.qorpera_surfaces s
				left join lateral (
					select jsonb_agg(
						jsonb_build_object(
							'id', ss.id,
							'title', ss.title,
							'state', ss.state,
							'explorationId', ss.exploration_id,
							'openChangeCount', (
								select count(*)::integer
								from public.qorpera_surface_changes ch
								where ch.session_id = ss.id and ch.status in ('staged', 'merging', 'conflicted')
							),
							'hasConflict', exists (
								select 1 from public.qorpera_surface_changes ch
								where ch.session_id = ss.id and ch.status = 'conflicted'
							)
						)
						order by ss.updated_at desc
					) as items
					from public.qorpera_surface_sessions ss
					where ss.surface_id = s.id and ss.state not in ('completed', 'discarded')
				) sess on true
				where s.profile_id = p_company_id and s.status in ('active', 'proposed')
			),
			'[]'::jsonb
		),
		'automations', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'id', a.id,
						'key', a.key,
						'title', a.title,
						'scheduleSummary', a.schedule_summary,
						'targetSurfaceSlug', a.target_surface_slug,
						'enabled', a.enabled,
						'status', a.status
					)
					order by a.updated_at desc
				)
				from public.qorpera_surface_automations a
				where a.profile_id = p_company_id
			),
			'[]'::jsonb
		)
	)
$$;
revoke all on function public.qorpera_surface_describe_company_senses(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_surface_describe_company_senses(uuid) to service_role;

create function public.qorpera_service_manage_surface_automation(
	p_company_id uuid,
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
declare
	v_row public.qorpera_surface_automations%rowtype;
	v_title text := btrim(coalesce(p_title, ''));
	v_prompt text := btrim(coalesce(p_prompt, ''));
	v_schedule text := coalesce(nullif(btrim(coalesce(p_schedule_summary, '')), ''), 'Every day · 09:00');
	v_target text := nullif(lower(btrim(coalesce(p_target_surface_slug, ''))), '');
	v_base_key text;
	v_key text;
	v_suffix integer := 1;
begin
	if p_action = 'create' then
		if char_length(v_title) < 1 or char_length(v_title) > 120 then
			raise exception 'Title must be 1..120 characters' using errcode = '22023';
		end if;
		if char_length(v_prompt) < 1 or char_length(v_prompt) > 16000 then
			raise exception 'Prompt must be 1..16000 characters' using errcode = '22023';
		end if;
		v_base_key := left(btrim(lower(regexp_replace(v_title, '[^a-zA-Z0-9]+', '-', 'g')), '-'), 70);
		if v_base_key = '' then v_base_key := 'agent'; end if;
		v_key := v_base_key;
		while exists (select 1 from public.qorpera_surface_automations where profile_id = p_company_id and key = v_key) loop
			v_suffix := v_suffix + 1;
			v_key := left(v_base_key, 66) || '-' || v_suffix::text;
		end loop;
		insert into public.qorpera_surface_automations(
			profile_id, key, title, prompt, schedule_summary, target_surface_slug,
			output_mode, enabled, status, last_outcome_summary, next_run_at
		)
		values (
			p_company_id, v_key, v_title, v_prompt, v_schedule, v_target,
			case when v_target is not null then 'surface_session' else 'decision_card' end,
			coalesce(p_enabled, true), case when coalesce(p_enabled, true) then 'idle' else 'paused' end, left(v_prompt, 120),
			case when coalesce(p_enabled, true) then public.qorpera_compute_next_automation_run(v_schedule, clock_timestamp()) else null end
		)
		returning * into v_row;
	elsif p_action = 'update' then
		select * into v_row from public.qorpera_surface_automations where id = p_automation_id and profile_id = p_company_id for update;
		if v_row.id is null then raise exception 'Automation not found' using errcode = 'P0002'; end if;
		update public.qorpera_surface_automations
		set
			title = coalesce(nullif(v_title, ''), title),
			prompt = coalesce(nullif(v_prompt, ''), prompt),
			schedule_summary = coalesce(nullif(btrim(coalesce(p_schedule_summary, '')), ''), schedule_summary),
			target_surface_slug = coalesce(v_target, target_surface_slug),
			enabled = coalesce(p_enabled, enabled),
			status = case when coalesce(p_enabled, enabled) then 'idle' else 'paused' end,
			next_run_at = case
				when coalesce(p_enabled, enabled) then public.qorpera_compute_next_automation_run(
					coalesce(nullif(btrim(coalesce(p_schedule_summary, '')), ''), schedule_summary),
					clock_timestamp()
				)
				else null
			end,
			updated_at = clock_timestamp()
		where id = p_automation_id
		returning * into v_row;
	elsif p_action = 'delete' then
		delete from public.qorpera_surface_automations where id = p_automation_id and profile_id = p_company_id;
		return jsonb_build_object('deleted', true, 'id', p_automation_id);
	else
		raise exception 'Invalid automation action' using errcode = '22023';
	end if;

	return jsonb_build_object(
		'id', v_row.id,
		'key', v_row.key,
		'title', v_row.title,
		'prompt', v_row.prompt,
		'scheduleSummary', v_row.schedule_summary,
		'targetSurfaceSlug', v_row.target_surface_slug,
		'enabled', v_row.enabled,
		'status', v_row.status
	);
end $$;
revoke all on function public.qorpera_service_manage_surface_automation(uuid, text, uuid, text, text, text, text, boolean)
	from public, anon, authenticated;
grant execute on function public.qorpera_service_manage_surface_automation(uuid, text, uuid, text, text, text, text, boolean)
	to service_role;

create index if not exists qorpera_surface_automations_due
	on public.qorpera_surface_automations(next_run_at asc)
	where enabled = true and next_run_at is not null;

-- WHY: Seeds Identity, Ops surfaces, and Co-Founder Pulse atomically when a company's Co-Founder is created so Turn 1 never races the browser.
create function public.qorpera_bootstrap_surfaces_on_cofounder_insert()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_service_bootstrap_company_surfaces(new.profile_id, null);
	return new;
end $$;
revoke all on function public.qorpera_bootstrap_surfaces_on_cofounder_insert() from public, anon, authenticated;

do $$ begin
	if to_regclass('public.qorpera_company_cofounders') is not null then
		drop trigger if exists qorpera_company_cofounders_bootstrap_surfaces on public.qorpera_company_cofounders;
		create trigger qorpera_company_cofounders_bootstrap_surfaces
			after insert on public.qorpera_company_cofounders
			for each row execute function public.qorpera_bootstrap_surfaces_on_cofounder_insert();
	end if;

	if to_regprocedure('public.qorpera_live_hint_internal()') is not null then
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surfaces
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_explorations
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_sessions
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_changes
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_previews
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_session_messages
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_automations
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
	end if;

	if to_regprocedure('public.qorpera_wake_runner_orchestrators_internal()') is not null then
		create trigger qorpera_surface_sessions_wake_orchestrators
			after insert or update of state on public.qorpera_surface_sessions
			for each row when (new.state in ('queued', 'reconciling'))
			execute function public.qorpera_wake_runner_orchestrators_internal();
		create trigger qorpera_surface_previews_wake_orchestrators
			after insert or update of status on public.qorpera_surface_previews
			for each row when (new.status = 'composing')
			execute function public.qorpera_wake_runner_orchestrators_internal();
		create trigger qorpera_surface_jobs_wake_orchestrators
			after insert or update of status on public.qorpera_surface_jobs
			for each row when (new.status = 'queued')
			execute function public.qorpera_wake_runner_orchestrators_internal();
	end if;
end $$;
