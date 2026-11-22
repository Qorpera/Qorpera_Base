set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_session_messages') is not null then
		raise exception 'Surface Preview and Dispatch (20260930833000) is already applied';
	end if;
	if to_regclass('public.qorpera_surfaces') is null then
		raise exception 'Surface Preview and Dispatch (20260930833000) requires 20260930832000 first';
	end if;
end $$;

create table public.qorpera_surface_session_messages (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	author_kind text not null check (author_kind in ('member', 'session', 'system')),
	author_user_id uuid references auth.users(id) on delete set null,
	body text not null check (char_length(body) <= 16000),
	change_id uuid references public.qorpera_surface_changes(id) on delete set null,
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_surface_session_messages_session on public.qorpera_surface_session_messages(session_id, created_at asc);
alter table public.qorpera_surface_session_messages enable row level security;
revoke all on public.qorpera_surface_session_messages from public, anon, authenticated, service_role, qorpera_secret_broker;

-- WHY: Isolated --p<id> preview origins redeem passes through qorpera_company_site_member_passes using the same 43-char base64url pass grammar.
create function public.qorpera_surface_mint_preview_pass(p_site_id uuid, p_user_id uuid, p_host text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
	v_pass text;
	v_now timestamptz := clock_timestamp();
begin
	if p_site_id is null or p_user_id is null or p_host is null then
		return null;
	end if;
	v_pass := replace(replace(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+', '-'), '/', '_');
	delete from public.qorpera_company_site_member_passes
	where user_id = p_user_id and expires_at <= v_now;

	insert into public.qorpera_company_site_member_passes(pass_sha256, site_id, user_id, host, created_at, expires_at)
	values (encode(extensions.digest(v_pass, 'sha256'), 'hex'), p_site_id, p_user_id, lower(p_host), v_now, v_now + interval '60 seconds');
	return v_pass;
end $$;
revoke all on function public.qorpera_surface_mint_preview_pass(uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- WHY: Deterministic 8-character lowercase host id guarantees isolated preview origins per composition without DNS/TLS changes.
create function public.qorpera_surface_upsert_preview(
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
	select string_agg(ch.id::text || ':' || coalesce(ch.head_sha, ''), ',' order by array_position(p_selected_change_ids, ch.id))
	into v_key_input
	from public.qorpera_surface_changes ch
	where ch.id = any(coalesce(p_selected_change_ids, '{}'::uuid[]))
		and ch.surface_id = p_surface.id
		and ch.profile_id = p_surface.profile_id;

	v_comp_key := encode(
		extensions.digest(
			coalesce(p_base_sha, 'base') || '|' || coalesce(p_exploration_session_id::text, '') || '|' || coalesce(v_key_input, ''),
			'sha256'
		),
		'hex'
	);
	v_host_id := substr(v_comp_key, 1, 8);

	insert into public.qorpera_surface_previews(
		profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids, status, expires_at
	)
	values (
		p_surface.profile_id, p_surface.id, v_comp_key, v_host_id,
		coalesce(p_base_sha, repeat('0', 40)), coalesce(p_selected_change_ids, '{}'::uuid[]),
		'composing', clock_timestamp() + interval '24 hours'
	)
	on conflict (surface_id, composition_key) do update set
		expires_at = clock_timestamp() + interval '24 hours',
		status = case
			when public.qorpera_surface_previews.status = 'failed' then 'composing'
			else public.qorpera_surface_previews.status
		end
	returning * into v_row;

	return v_row;
end $$;
revoke all on function public.qorpera_surface_upsert_preview(public.qorpera_surfaces, text, uuid[], uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

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
		'explorationId', p_session.exploration_id,
		'explorationVariantLabel', p_session.exploration_variant_label,
		'hasActiveChat', p_session.has_active_chat,
		'question', p_session.question,
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
	left join lateral (
		select jsonb_agg(
			jsonb_build_object(
				'id', m.id,
				'sessionId', m.session_id,
				'authorKind', m.author_kind,
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

create or replace function public.qorpera_start_surface_session(
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
			coalesce(p_origin_kind, 'member'), p_origin_label, p_origin_ref, v_user_id, 'queued', v_surface.live_head_sha
		)
		returning * into v_session;

		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
		values (v_surface.profile_id, v_session.id, 'member', v_user_id, v_prompt);
	end if;

	return public.qorpera_surface_session_json(v_session);
end $$;

create or replace function public.qorpera_reply_surface_session(p_session_id uuid, p_message text, p_keep_open boolean default true)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_user_id uuid;
	v_body text := btrim(coalesce(p_message, ''));
begin
	if char_length(v_body) < 1 then
		raise exception 'Message cannot be empty' using errcode = '22023';
	end if;
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_session.profile_id, true);

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_session.profile_id, p_session_id, 'member', v_user_id, v_body);

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

create or replace function public.qorpera_set_preview_selection(
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
	v_site public.qorpera_company_sites%rowtype;
	v_user_id uuid;
	v_toggled uuid[] := coalesce(p_toggled_change_ids, '{}'::uuid[]);
	v_compare uuid[] := coalesce(p_compare_session_ids, '{}'::uuid[]);
	v_route text := coalesce(nullif(btrim(coalesce(p_active_route, '')), ''), '/');
	v_preview public.qorpera_surface_previews%rowtype;
	v_primary_host text;
	v_primary_pass text;
	v_compare_frames jsonb := '[]'::jsonb;
	v_cmp_session record;
	v_cmp_preview public.qorpera_surface_previews%rowtype;
	v_cmp_host text;
	v_cmp_pass text;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);

	if cardinality(v_compare) > 3 then
		raise exception 'Compare supports at most 3 variants' using errcode = '22023';
	end if;

	if cardinality(v_toggled) > 0 and exists (
		select 1 from unnest(v_toggled) as cid
		where not exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.id = cid and ch.surface_id = p_surface_id and ch.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Change does not belong to surface' using errcode = '42501';
	end if;

	if p_exploration_session_id is not null and not exists (
		select 1 from public.qorpera_surface_sessions s
		where s.id = p_exploration_session_id
			and s.surface_id = p_surface_id
			and s.profile_id = v_surface.profile_id
	) then
		raise exception 'Exploration session does not belong to surface' using errcode = '42501';
	end if;

	if cardinality(v_compare) > 0 and exists (
		select 1 from unnest(v_compare) as sid
		where not exists (
			select 1 from public.qorpera_surface_sessions s
			where s.id = sid and s.surface_id = p_surface_id and s.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Compare session does not belong to surface' using errcode = '42501';
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

	if v_surface.site_id is not null then
		select * into v_site from public.qorpera_company_sites where id = v_surface.site_id;
	end if;

	if cardinality(v_toggled) > 0 or p_exploration_session_id is not null then
		v_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, p_exploration_session_id);
		if v_site.id is not null and v_preview.status = 'ready' then
			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host);
		end if;
	end if;

	if cardinality(v_compare) >= 2 then
		for v_cmp_session in
			select s.id, coalesce(s.exploration_variant_label, s.title) as label
			from public.qorpera_surface_sessions s
			where s.id = any(v_compare) and s.surface_id = p_surface_id
			order by array_position(v_compare, s.id)
		loop
			v_cmp_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, v_cmp_session.id);
			v_cmp_host := null;
			v_cmp_pass := null;
			if v_site.id is not null and v_cmp_preview.status = 'ready' then
				v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.qorpera.com';
				v_cmp_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_cmp_host);
			end if;
			v_compare_frames := v_compare_frames || jsonb_build_array(
				jsonb_build_object(
					'sessionId', v_cmp_session.id,
					'label', v_cmp_session.label,
					'frame', jsonb_build_object(
						'previewId', v_cmp_preview.id,
						'status', v_cmp_preview.status,
						'doorActionUrl', case when v_cmp_host is not null then 'https://' || v_cmp_host || '/__qorpera/member' else null end,
						'memberPass', v_cmp_pass,
						'activeRoute', v_route,
						'toggledChangeIds', to_jsonb(v_toggled),
						'conflictReport', v_cmp_preview.conflict_report,
						'errorDetail', v_cmp_preview.error_detail
					)
				)
			);
		end loop;
	end if;

	return jsonb_build_object(
		'surfaceId', p_surface_id,
		'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,
		'primary', jsonb_build_object(
			'previewId', v_preview.id,
			'status', case
				when v_preview.id is not null then v_preview.status
				else 'live_baseline'
			end,
			'doorActionUrl', case when v_primary_host is not null then 'https://' || v_primary_host || '/__qorpera/member' else null end,
			'memberPass', v_primary_pass,
			'activeRoute', v_route,
			'toggledChangeIds', to_jsonb(v_toggled),
			'conflictReport', v_preview.conflict_report,
			'errorDetail', v_preview.error_detail
		),
		'compareFrames', v_compare_frames
	);
end $$;

create function public.qorpera_reconcile_surface_changes(p_surface_id uuid, p_change_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_titles text;
	v_paths text[];
	v_session public.qorpera_surface_sessions%rowtype;
	v_prompt text;
begin
	if p_change_ids is null or cardinality(p_change_ids) < 1 then
		raise exception 'At least one change id is required to reconcile' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);

	if exists (
		select 1 from unnest(p_change_ids) as cid
		where not exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.id = cid and ch.surface_id = p_surface_id and ch.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Change does not belong to surface' using errcode = '42501';
	end if;

	select
		string_agg(ch.title, ', ' order by ch.created_at asc),
		array(select distinct p from unnest(array_agg(coalesce(ch.conflict_paths, ch.affected_paths))) as arr(p))
	into v_titles, v_paths
	from public.qorpera_surface_changes ch
	where ch.surface_id = p_surface_id and ch.id = any(p_change_ids);

	v_prompt := 'Reconcile conflicting changes on ' || v_surface.title || ': ' || coalesce(v_titles, 'selected changes');

	insert into public.qorpera_surface_sessions(
		profile_id, surface_id, title, prompt, origin_kind, origin_label, origin_ref,
		created_by_user_id, state, base_sha
	)
	values (
		v_surface.profile_id, p_surface_id,
		left('Reconcile: ' || coalesce(v_titles, 'conflicts'), 160),
		v_prompt, 'member', 'Conflict reconciliation',
		jsonb_build_object('changeIds', to_jsonb(p_change_ids), 'paths', to_jsonb(coalesce(v_paths, '{}'::text[]))),
		v_user_id, 'reconciling', v_surface.live_head_sha
	)
	returning * into v_session;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_surface.profile_id, v_session.id, 'system', v_user_id, v_prompt);

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_reconcile_surface_changes(uuid, uuid[]) from public, anon;
grant execute on function public.qorpera_reconcile_surface_changes(uuid, uuid[]) to authenticated;

create function public.qorpera_surface_complete_preview(
	p_preview_id uuid,
	p_status text,
	p_composite_tree_sha text default null,
	p_site_version_id uuid default null,
	p_conflict_report jsonb default null,
	p_error_detail text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_row public.qorpera_surface_previews%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
begin
	if p_status not in ('ready', 'conflicted', 'failed') then
		raise exception 'Invalid preview completion status' using errcode = '22023';
	end if;

	select * into v_row from public.qorpera_surface_previews where id = p_preview_id for update;
	if v_row.id is null then raise exception 'Preview not found' using errcode = 'P0002'; end if;
	if v_row.status not in ('composing', 'building') then
		raise exception 'Preview is not active for completion' using errcode = '55000';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_row.surface_id;
	if p_site_version_id is not null and not exists (
		select 1 from public.qorpera_company_site_versions v
		where v.id = p_site_version_id and v.site_id = v_surface.site_id
	) then
		raise exception 'Site version does not belong to surface site' using errcode = '42501';
	end if;

	update public.qorpera_surface_previews
	set
		status = p_status,
		composite_tree_sha = coalesce(p_composite_tree_sha, composite_tree_sha),
		site_version_id = coalesce(p_site_version_id, site_version_id),
		conflict_report = p_conflict_report,
		error_detail = p_error_detail
	where id = p_preview_id
	returning * into v_row;

	return jsonb_build_object(
		'previewId', v_row.id,
		'status', v_row.status,
		'shortHostId', v_row.short_host_id,
		'compositeTreeSha', v_row.composite_tree_sha
	);
end $$;
revoke all on function public.qorpera_surface_complete_preview(uuid, text, text, uuid, jsonb, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_surface_complete_preview(uuid, text, text, uuid, jsonb, text)
	to service_role;

-- WHY: Gives runner-orchestrator one atomic pull queue for queued sessions, pending preview builds, and pending merges with machine hints.
create function public.qorpera_surface_claim_pending_jobs(p_limit integer default 16)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_cap integer := greatest(1, least(coalesce(p_limit, 16), 64));
	v_sessions jsonb;
	v_previews jsonb;
begin
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'sessionId', s.id,
				'surfaceId', s.surface_id,
				'profileId', s.profile_id,
				'state', s.state,
				'prompt', s.prompt,
				'originKind', s.origin_kind,
				'originRef', s.origin_ref,
				'repositoryKey', surf.repository_key,
				'placement', public.qorpera_surface_machine_placement_hint(s.profile_id, 6)
			)
			order by s.created_at asc
		),
		'[]'::jsonb
	)
	into v_sessions
	from (
		select *
		from public.qorpera_surface_sessions
		where state in ('queued', 'reconciling')
		order by created_at asc
		limit v_cap
	) s
	join public.qorpera_surfaces surf on surf.id = s.surface_id;

	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'previewId', p.id,
				'surfaceId', p.surface_id,
				'profileId', p.profile_id,
				'shortHostId', p.short_host_id,
				'baseSha', p.base_sha,
				'selectedChangeIds', to_jsonb(p.selected_change_ids),
				'repositoryKey', surf.repository_key
			)
			order by p.created_at asc
		),
		'[]'::jsonb
	)
	into v_previews
	from (
		select *
		from public.qorpera_surface_previews
		where status = 'composing' and expires_at > clock_timestamp()
		order by created_at asc
		limit v_cap
	) p
	join public.qorpera_surfaces surf on surf.id = p.surface_id;

	return jsonb_build_object('sessions', v_sessions, 'previews', v_previews);
end $$;
revoke all on function public.qorpera_surface_claim_pending_jobs(integer)
	from public, anon, authenticated;
grant execute on function public.qorpera_surface_claim_pending_jobs(integer)
	to service_role;

create or replace function public.qorpera_record_surface_change(
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

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body, change_id)
	values (
		v_session.profile_id, p_session_id, 'system',
		'Staged change: ' || v_change.title || case when char_length(v_change.summary) > 0 then ' — ' || v_change.summary else '' end,
		v_change.id
	);

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
