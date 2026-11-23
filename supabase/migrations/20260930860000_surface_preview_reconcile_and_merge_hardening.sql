-- WHY: Harden Surface previews, merge serialization, conflict reconciliation, coding session enqueue,
-- active-worker replies, coding lease expiry, and site provisioning for approved proposed surfaces.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_session_run(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_expire_coding_sessions(timestamptz,integer)') is null then
		raise exception '20260930860000 requires 20260930855000 and 20260930857000';
	end if;
	if to_regprocedure('public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)') is not null then
		raise exception '20260930860000 is already applied';
	end if;
end $$;

create temporary table sprmh_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.sprmh_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930860000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930860000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

alter table public.qorpera_surface_previews
	add column if not exists attempts integer not null default 0 check (attempts >= 0),
	add column if not exists updated_at timestamptz not null default clock_timestamp();

-- WHY: Single source of truth for preview composition hashes across upsert and workspace reads so stale SHAs never collide.
create function public.qorpera_surface_preview_composition_key(
	p_surface_id uuid,
	p_base_sha text,
	p_selected_change_ids uuid[],
	p_exploration_session_id uuid default null
)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
	v_exp_head_sha text;
	v_key_input text;
begin
	if p_exploration_session_id is not null then
		select nullif(btrim(coalesce(s.branch_head_sha, '')), '')
		into v_exp_head_sha
		from public.qorpera_surface_sessions s
		where s.id = p_exploration_session_id
			and s.surface_id = p_surface_id;
	end if;

	select string_agg(
		ch.id::text || ':' || coalesce(ch.parent_sha, '') || ':' || coalesce(ch.head_sha, ''),
		',' order by u.ord
	)
	into v_key_input
	from unnest(coalesce(p_selected_change_ids, '{}'::uuid[])) with ordinality as u(cid, ord)
	join public.qorpera_surface_changes ch
		on ch.id = u.cid
		and ch.surface_id = p_surface_id;

	return encode(
		extensions.digest(
			coalesce(p_base_sha, 'base')
				|| '|' || coalesce(p_exploration_session_id::text, '') || ':' || coalesce(v_exp_head_sha, '')
				|| '|' || coalesce(v_key_input, ''),
			'sha256'
		),
		'hex'
	);
end $$;
revoke all on function public.qorpera_surface_preview_composition_key(uuid, text, uuid[], uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.sprmh_patch(
	'public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)'::regprocedure,
	array[
$old$declare
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
		lease_expires_at = case
			when public.qorpera_surface_previews.status = 'failed' then null
			else public.qorpera_surface_previews.lease_expires_at
		end,
		lease_token = case
			when public.qorpera_surface_previews.status = 'failed' then null
			else public.qorpera_surface_previews.lease_token
		end,
		status = case
			when public.qorpera_surface_previews.status = 'failed' then 'composing'
			else public.qorpera_surface_previews.status
		end
	returning * into v_row;

	return v_row;$old$,
$new$declare
	v_now timestamptz := clock_timestamp();
	v_comp_key text;
	v_host_id text;
	v_salt integer;
	v_row public.qorpera_surface_previews%rowtype;
begin
	-- WHY: 20260930860000 hashes exploration head_sha and change parent_sha:head_sha via shared helper so rebased/new commits never collide.
	v_comp_key := public.qorpera_surface_preview_composition_key(
		p_surface.id,
		p_base_sha,
		coalesce(p_selected_change_ids, '{}'::uuid[]),
		p_exploration_session_id
	);

	-- WHY: Prune expired unleased previews older than 1 hour so high-churn commit/rebase keys do not accumulate unboundedly.
	delete from public.qorpera_surface_previews p
	where p.surface_id = p_surface.id
		and p.composition_key <> v_comp_key
		and p.expires_at <= v_now - interval '1 hour'
		and (p.status <> 'building' or p.lease_expires_at is null or p.lease_expires_at <= v_now);

	select p.short_host_id
	into v_host_id
	from public.qorpera_surface_previews p
	where p.surface_id = p_surface.id
		and p.composition_key = v_comp_key;

	-- WHY: Salt short_host_id on 32-bit prefix collision with another composition so unique(surface_id, short_host_id) never fails selection.
	for v_salt in 0..31 loop
		if v_host_id is null then
			if v_salt = 0 then
				v_host_id := substr(v_comp_key, 1, 8);
			elsif v_salt < 31 then
				v_host_id := substr(
					encode(extensions.digest(v_comp_key || ':host:' || v_salt::text, 'sha256'), 'hex'),
					1,
					8
				);
			else
				v_host_id := substr(
					encode(extensions.digest(v_comp_key || ':host:' || extensions.gen_random_uuid()::text, 'sha256'), 'hex'),
					1,
					8
				);
			end if;
			if v_salt < 31 and exists (
				select 1
				from public.qorpera_surface_previews p
				where p.surface_id = p_surface.id
					and p.short_host_id = v_host_id
					and p.composition_key <> v_comp_key
			) then
				v_host_id := null;
				continue;
			end if;
		end if;

		begin
			insert into public.qorpera_surface_previews(
				profile_id, surface_id, composition_key, short_host_id, base_sha,
				selected_change_ids, exploration_session_id, status, expires_at, updated_at
			)
			values (
				p_surface.profile_id, p_surface.id, v_comp_key, v_host_id,
				coalesce(p_base_sha, repeat('0', 40)), coalesce(p_selected_change_ids, '{}'::uuid[]),
				p_exploration_session_id, 'composing', v_now + interval '24 hours', v_now
			)
			on conflict (surface_id, composition_key) do update set
				exploration_session_id = excluded.exploration_session_id,
				expires_at = v_now + interval '24 hours',
				error_detail = case
					when public.qorpera_surface_previews.status = 'failed' then null
					else public.qorpera_surface_previews.error_detail
				end,
				conflict_report = case
					when public.qorpera_surface_previews.status = 'failed' then null
					else public.qorpera_surface_previews.conflict_report
				end,
				lease_expires_at = case
					when public.qorpera_surface_previews.status = 'failed' then null
					else public.qorpera_surface_previews.lease_expires_at
				end,
				lease_token = case
					when public.qorpera_surface_previews.status = 'failed' then null
					else public.qorpera_surface_previews.lease_token
				end,
				attempts = case
					when public.qorpera_surface_previews.status = 'failed' then 0
					else public.qorpera_surface_previews.attempts
				end,
				created_at = case
					when public.qorpera_surface_previews.status = 'failed' then v_now
					else public.qorpera_surface_previews.created_at
				end,
				updated_at = v_now,
				status = case
					when public.qorpera_surface_previews.status = 'failed' then 'composing'
					else public.qorpera_surface_previews.status
				end
			returning * into v_row;
			exit;
		exception when unique_violation then
			if v_salt = 31 then
				raise;
			end if;
			v_host_id := null;
		end;
	end loop;

	if v_row.id is null then
		raise exception 'Unable to allocate preview host id' using errcode = '55000';
	end if;

	-- WHY: Expire obsolete unbuilt composing previews no member currently selects so bursty toggling skips stale work immediately.
	update public.qorpera_surface_previews p
	set expires_at = v_now, updated_at = v_now
	where p.surface_id = p_surface.id
		and p.id <> v_row.id
		and p.status = 'composing'
		and p.expires_at > v_now
		and not exists (
			select 1
			from public.qorpera_member_surface_state ms
			where ms.surface_id = p_surface.id
				and (
					(
						(cardinality(coalesce(ms.toggled_change_ids, '{}'::uuid[])) > 0 or ms.active_exploration_session_id is not null)
						and p.composition_key = public.qorpera_surface_preview_composition_key(
							p_surface.id,
							p_surface.live_head_sha,
							coalesce(ms.toggled_change_ids, '{}'::uuid[]),
							ms.active_exploration_session_id
						)
					)
					or exists (
						select 1
						from unnest(coalesce(ms.compare_session_ids, '{}'::uuid[])) as csid
						where cardinality(coalesce(ms.compare_session_ids, '{}'::uuid[])) >= 2
							and p.composition_key = public.qorpera_surface_preview_composition_key(
								p_surface.id,
								p_surface.live_head_sha,
								coalesce(ms.toggled_change_ids, '{}'::uuid[]),
								csid
							)
					)
				)
		);

	return v_row;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
	array[
$old$	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);
	perform public.qorpera_assert_surfaces_enabled();

	if cardinality(v_compare) > 3 then$old$,
$new$	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);
	perform public.qorpera_assert_surfaces_enabled();

	-- WHY: 20260930860000 serializes preview selection per surface so concurrent members never expire each other's fresh composing preview.
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.surface-preview:' || p_surface_id::text, 0));
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;

	if cardinality(v_compare) > 3 then$new$,
$old$	if cardinality(v_toggled) > 0 and exists (
		select 1 from unnest(v_toggled) as cid
		where not exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.id = cid and ch.surface_id = p_surface_id and ch.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Change does not belong to surface' using errcode = '42501';
	end if;$old$,
$new$	if cardinality(v_toggled) > 0 and exists (
		select 1 from unnest(v_toggled) as cid
		where not exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.id = cid and ch.surface_id = p_surface_id and ch.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Change does not belong to surface' using errcode = '42501';
	end if;

	-- WHY: 20260930860000 filters and deduplicates toggled changes to open staged/conflicted rows in input order.
	if cardinality(v_toggled) > 0 then
		select coalesce(array_agg(dedup.cid order by dedup.first_ord), '{}'::uuid[])
		into v_toggled
		from (
			select u.cid, min(u.ord) as first_ord
			from unnest(v_toggled) with ordinality as u(cid, ord)
			join public.qorpera_surface_changes ch
				on ch.id = u.cid
				and ch.surface_id = p_surface_id
				and ch.profile_id = v_surface.profile_id
				and ch.status in ('staged', 'conflicted')
			group by u.cid
		) dedup;
	end if;$new$,
$old$	if cardinality(v_compare) > 0 and exists (
		select 1 from unnest(v_compare) as sid
		where not exists (
			select 1 from public.qorpera_surface_sessions s
			where s.id = sid and s.surface_id = p_surface_id and s.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Compare session does not belong to surface' using errcode = '42501';
	end if;$old$,
$new$	if cardinality(v_compare) > 0 and exists (
		select 1 from unnest(v_compare) as sid
		where not exists (
			select 1 from public.qorpera_surface_sessions s
			where s.id = sid and s.surface_id = p_surface_id and s.profile_id = v_surface.profile_id
		)
	) then
		raise exception 'Compare session does not belong to surface' using errcode = '42501';
	end if;

	if cardinality(v_compare) > 0 then
		select coalesce(array_agg(dedup.sid order by dedup.first_ord), '{}'::uuid[])
		into v_compare
		from (
			select u.sid, min(u.ord) as first_ord
			from unnest(v_compare) with ordinality as u(sid, ord)
			group by u.sid
		) dedup;
	end if;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
	array[
$old$	v_toggled uuid[];
	v_route text;
	v_preview public.qorpera_surface_previews%rowtype;
	v_primary_host text;$old$,
$new$	v_toggled uuid[];
	v_compare uuid[];
	v_route text;
	v_comp_key text;
	v_preview public.qorpera_surface_previews%rowtype;
	v_primary_host text;
	v_compare_frames jsonb := '[]'::jsonb;
	v_cmp_session record;
	v_cmp_preview public.qorpera_surface_previews%rowtype;
	v_cmp_host text;$new$,
$old$	v_toggled := coalesce(v_member_state.toggled_change_ids, '{}'::uuid[]);
	v_route := coalesce(v_member_state.active_route, '/');$old$,
$new$	-- WHY: 20260930860000 ignores non-open changes when reading saved preview selections.
	v_toggled := coalesce(
		(
			select array_agg(dedup.cid order by dedup.first_ord)
			from (
				select u.cid, min(u.ord) as first_ord
				from unnest(coalesce(v_member_state.toggled_change_ids, '{}'::uuid[])) with ordinality as u(cid, ord)
				join public.qorpera_surface_changes ch
					on ch.id = u.cid
					and ch.surface_id = p_surface_id
					and ch.profile_id = v_surface.profile_id
					and ch.status in ('staged', 'conflicted')
				group by u.cid
			) dedup
		),
		'{}'::uuid[]
	);
	v_compare := coalesce(v_member_state.compare_session_ids, '{}'::uuid[]);
	v_route := coalesce(v_member_state.active_route, '/');$new$,
$old$	-- WHY: 20260930855000 only reads composite preview rows for code_repo surfaces.
	if v_surface.source_kind = 'code_repo' and (cardinality(v_toggled) > 0 or v_member_state.active_exploration_session_id is not null) then
		select p.* into v_preview
		from public.qorpera_surface_previews p
		where p.surface_id = p_surface_id
			and p.selected_change_ids = v_toggled
			and p.exploration_session_id is not distinct from v_member_state.active_exploration_session_id
			and p.expires_at > clock_timestamp()
		order by p.created_at desc
		limit 1;
		if v_site.id is not null and v_preview.id is not null and v_preview.status = 'ready' then
			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';
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
				'memberPass', null,
				'activeRoute', v_route,
				'toggledChangeIds', to_jsonb(v_toggled),
				'conflictReport', v_preview.conflict_report,
				'errorDetail', v_preview.error_detail
			),
			'compareFrames', '[]'::jsonb
		)
	);$old$,
$new$	-- WHY: 20260930855000 / 20260930860000 matches exact composition_key on code_repo surfaces so stale SHAs are never returned.
	if v_surface.source_kind = 'code_repo' and (cardinality(v_toggled) > 0 or v_member_state.active_exploration_session_id is not null) then
		v_comp_key := public.qorpera_surface_preview_composition_key(
			p_surface_id,
			v_surface.live_head_sha,
			v_toggled,
			v_member_state.active_exploration_session_id
		);
		select p.* into v_preview
		from public.qorpera_surface_previews p
		where p.surface_id = p_surface_id
			and p.composition_key = v_comp_key
			and p.expires_at > clock_timestamp()
		order by p.created_at desc
		limit 1;
		if v_site.id is not null and v_preview.id is not null and v_preview.status = 'ready' then
			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';
		end if;
	end if;

	if cardinality(v_compare) >= 2 then
		for v_cmp_session in
			select s.id, coalesce(s.exploration_variant_label, s.title) as label
			from public.qorpera_surface_sessions s
			where s.id = any(v_compare) and s.surface_id = p_surface_id
			order by array_position(v_compare, s.id)
		loop
			v_cmp_preview := null;
			v_cmp_host := null;
			if v_surface.source_kind = 'code_repo' then
				select p.* into v_cmp_preview
				from public.qorpera_surface_previews p
				where p.surface_id = p_surface_id
					and p.composition_key = public.qorpera_surface_preview_composition_key(
						p_surface_id,
						v_surface.live_head_sha,
						v_toggled,
						v_cmp_session.id
					)
					and p.expires_at > clock_timestamp()
				order by p.created_at desc
				limit 1;
				if v_site.id is not null and v_cmp_preview.id is not null and v_cmp_preview.status = 'ready' then
					v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.qorpera.com';
				end if;
			end if;
			v_compare_frames := v_compare_frames || jsonb_build_array(
				jsonb_build_object(
					'sessionId', v_cmp_session.id,
					'label', v_cmp_session.label,
					'frame', jsonb_build_object(
						'previewId', v_cmp_preview.id,
						'status', coalesce(v_cmp_preview.status, 'live_baseline'),
						'doorActionUrl', case when v_cmp_host is not null then 'https://' || v_cmp_host || '/__qorpera/member' else null end,
						'memberPass', null,
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
		'surface', public.qorpera_surface_summary_json(v_surface),
		'briefSummary', v_surface.brief_summary,
		'activeSessions', v_active_sessions,
		'recentHistory', v_history_sessions,
		'explorations', v_explorations,
		'previewState', jsonb_build_object(
			'surfaceId', p_surface_id,
			'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,
			'primary', jsonb_build_object(
				'previewId', v_preview.id,
				'status', case when v_preview.id is not null then v_preview.status else 'live_baseline' end,
				'doorActionUrl', case when v_primary_host is not null then 'https://' || v_primary_host || '/__qorpera/member' else null end,
				'memberPass', null,
				'activeRoute', v_route,
				'toggledChangeIds', to_jsonb(v_toggled),
				'conflictReport', v_preview.conflict_report,
				'errorDetail', v_preview.error_detail
			),
			'compareFrames', v_compare_frames
		)
	);$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
	array[
$old$		'publishStatus', p_surface.publish_status,
		'liveUrl', case when site.slug is not null then 'https://' || site.slug || '.qorpera.com/' else null end,$old$,
$new$		'publishStatus', p_surface.publish_status,
		'lastPublishError', p_surface.last_publish_error,
		'liveHeadSha', p_surface.live_head_sha,
		'liveUrl', case when site.slug is not null then 'https://' || site.slug || '.qorpera.com/' else null end,$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
	array[
$old$		'explorationId', p_session.exploration_id,
		'explorationVariantLabel', p_session.exploration_variant_label,
		'hasActiveChat', p_session.has_active_chat,$old$,
$new$		'explorationId', p_session.exploration_id,
		'explorationVariantLabel', p_session.exploration_variant_label,
		'branchHeadSha', p_session.branch_head_sha,
		'hasActiveChat', p_session.has_active_chat,$new$,
$old$					'undoBatchSize', case
						when ch.kind = 'folder_patch'
							and ch.status = 'merged'
							and jsonb_typeof(ch.pre_merge_snapshot -> 'changeIds') = 'array'
						then greatest(1, jsonb_array_length(ch.pre_merge_snapshot -> 'changeIds'))
						else 1
					end,$old$,
$new$					'undoBatchSize', case
						when ch.kind = 'folder_patch'
							and ch.status = 'merged'
							and jsonb_typeof(ch.pre_merge_snapshot -> 'changeIds') = 'array'
						then greatest(1, jsonb_array_length(ch.pre_merge_snapshot -> 'changeIds'))
						when ch.kind = 'git_range'
							and ch.status = 'merged'
							and ch.landed_main_before is not null
							and ch.landed_main_after is not null
						then greatest(1, (
							select count(*)::integer
							from public.qorpera_surface_changes bch
							where bch.surface_id = ch.surface_id
								and bch.session_id = ch.session_id
								and bch.kind = 'git_range'
								and bch.status = 'merged'
								and bch.landed_main_before = ch.landed_main_before
								and bch.landed_main_after = ch.landed_main_after
						))
						else 1
					end,$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$		update public.qorpera_surface_previews p
		set status = 'composing', lease_expires_at = null, lease_token = null
		from expired_previews
		where p.id = expired_previews.id;$old$,
$new$		-- WHY: 20260930860000 caps preview lease expiry retries at 3 attempts so stuck builds fail cleanly instead of looping for 24h.
		update public.qorpera_surface_previews p
		set
			attempts = p.attempts + 1,
			status = case when p.attempts + 1 >= 3 then 'failed' else 'composing' end,
			error_detail = case
				when p.attempts + 1 >= 3 then 'Preview worker lease expired repeatedly'
				else p.error_detail
			end,
			lease_expires_at = null,
			lease_token = null,
			updated_at = v_now
		from expired_previews
		where p.id = expired_previews.id;$new$,
$old$			where p.status = 'composing'
				and surf.source_kind = 'code_repo'
				and p.expires_at > v_now
				and (p.lease_expires_at is null or p.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(p.profile_id)
			order by p.created_at asc
			limit v_cap
			for update of p skip locked
		),
		claimed as (
			update public.qorpera_surface_previews p
			set
				status = 'building',
				lease_expires_at = v_lease,
				lease_token = extensions.gen_random_uuid()$old$,
$new$			where p.status = 'composing'
				and surf.source_kind = 'code_repo'
				and p.expires_at > v_now
				and (p.lease_expires_at is null or p.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(p.profile_id)
			order by p.created_at desc, p.id desc
			limit v_cap
			for update of p skip locked
		),
		claimed as (
			update public.qorpera_surface_previews p
			set
				status = 'building',
				lease_expires_at = v_lease,
				lease_token = extensions.gen_random_uuid(),
				updated_at = v_now$new$,
$old$				order by p.created_at asc
			),
			'[]'::jsonb
		)
		into v_previews$old$,
$new$				order by p.created_at desc, p.id desc
			),
			'[]'::jsonb
		)
		into v_previews$new$,
$old$	with picked as (
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
	),$old$,
$new$	-- WHY: 20260930860000 serializes merge/undo claims per surface_id to prevent concurrent CODE_HOST_LAND_STALE races.
	with candidate_surfaces as materialized (
		select distinct on (j.surface_id) j.id, j.surface_id, j.created_at
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
			and not exists (
				select 1 from public.qorpera_surface_jobs running_j
				where running_j.surface_id = j.surface_id
					and running_j.kind in ('land_change', 'undo_change')
					and running_j.status = 'running'
			)
		order by j.surface_id, j.created_at asc, j.id asc
	),
	picked as (
		select j.id
		from candidate_surfaces cs
		join public.qorpera_surface_jobs j on j.id = cs.id
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		where j.status = 'queued'
			and not exists (
				select 1 from public.qorpera_surface_jobs running_j
				where running_j.surface_id = j.surface_id
					and running_j.kind in ('land_change', 'undo_change')
					and running_j.status = 'running'
			)
		order by cs.created_at asc, j.id asc
		limit v_cap
		for update of j, surf skip locked
	),$new$,
$old$						from public.qorpera_surface_changes ch
						where ch.id in (
							select x::uuid
							from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
						)
							and ch.surface_id = j.surface_id
							and ch.profile_id = j.profile_id
					),
					'[]'::jsonb
				),
				'siblingRemainingChanges',$old$,
$new$						from public.qorpera_surface_changes ch
						where ch.id in (
							select x::uuid
							from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
						)
							and ch.surface_id = j.surface_id
							and ch.profile_id = j.profile_id
							and (j.kind <> 'land_change' or ch.status = 'merging')
					),
					'[]'::jsonb
				),
				'siblingRemainingChanges',$new$,
$old$						where peer.surface_id = j.surface_id
							and peer.id is distinct from j.session_id
							and peer.worker_id is not null
							and peer.state not in ('completed', 'discarded')
					),
					'[]'::jsonb
				)$old$,
$new$						where peer.surface_id = j.surface_id
							and peer.id is distinct from j.session_id
							and peer.worker_id is not null
							and peer.state not in ('completed', 'discarded', 'running', 'reconciling_running')
							and not exists (
								select 1 from public.qorpera_coding_sessions pcs
								where pcs.worker_id = peer.worker_id
									and pcs.phase in ('preparing', 'running', 'publishing')
							)
					),
					'[]'::jsonb
				)$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_approve_surface_change(uuid,boolean)'::regprocedure,
	array[
$old$	if coalesce(p_include_dependencies, true) and cardinality(v_change.depends_on_change_ids) > 0 then
		v_target_ids := array_append(v_change.depends_on_change_ids, v_change.id);
	else
		v_target_ids := array[v_change.id];
	end if;

	v_needs_worker := (
		(v_change.kind = 'git_range' and v_surface.repository_key is not null and v_change.head_sha is not null)
		or (v_change.kind in ('folder_patch', 'ops_action') and v_change.patch_manifest is not null)
	);$old$,
$new$	-- WHY: 20260930860000 resolves transitive open dependencies safely with a depth/cycle guard and excludes merged/discarded rows.
	if coalesce(p_include_dependencies, true) and cardinality(v_change.depends_on_change_ids) > 0 then
		with recursive deps(cid, depth, visited) as (
			select v_change.id, 0, array[v_change.id]
			union all
			select dep_id, d.depth + 1, d.visited || dep_id
			from deps d
			join public.qorpera_surface_changes ch
				on ch.id = d.cid
				and ch.surface_id = v_change.surface_id
				and ch.session_id = v_change.session_id
			cross join lateral unnest(coalesce(ch.depends_on_change_ids, '{}'::uuid[])) as dep_id
			where d.depth < 32
				and not (dep_id = any(d.visited))
		)
		select coalesce(array_agg(ch.id order by ch.seq asc, ch.id asc), array[v_change.id])
		into v_target_ids
		from (select distinct cid from deps) u
		join public.qorpera_surface_changes ch
			on ch.id = u.cid
			and ch.surface_id = v_change.surface_id
			and ch.session_id = v_change.session_id
			and ch.status in ('staged', 'conflicted');
	else
		v_target_ids := array[v_change.id];
	end if;

	if exists (
		select 1 from public.qorpera_surface_jobs j
		where j.surface_id = v_change.surface_id
			and j.kind in ('land_change', 'undo_change')
			and j.status in ('queued', 'running')
			and (
				(j.payload ? 'changeId' and (j.payload ->> 'changeId')::uuid = any(v_target_ids))
				or exists (
					select 1
					from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
					where x::uuid = any(v_target_ids)
				)
			)
	) then
		raise exception 'A merge or rollback job is already active for this change' using errcode = '55000';
	end if;

	select coalesce(bool_or(
		(ch.kind = 'git_range' and v_surface.repository_key is not null and ch.head_sha is not null)
		or (ch.kind in ('folder_patch', 'ops_action') and ch.patch_manifest is not null)
	), false)
	into v_needs_worker
	from public.qorpera_surface_changes ch
	where ch.id = any(v_target_ids)
		and ch.session_id = v_change.session_id
		and ch.status in ('staged', 'conflicted');$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_approve_session_all(uuid)'::regprocedure,
	array[
$old$	if cardinality(v_change_ids) > 0 and coalesce(v_needs_worker, false) then$old$,
$new$	if cardinality(v_change_ids) > 0 and exists (
		select 1 from public.qorpera_surface_jobs j
		where j.surface_id = v_session.surface_id
			and j.kind in ('land_change', 'undo_change')
			and j.status in ('queued', 'running')
			and (
				(j.payload ? 'changeId' and (j.payload ->> 'changeId')::uuid = any(v_change_ids))
				or exists (
					select 1
					from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
					where x::uuid = any(v_change_ids)
				)
			)
	) then
		raise exception 'A merge or rollback job is already active for this session' using errcode = '55000';
	end if;

	if cardinality(v_change_ids) > 0 and coalesce(v_needs_worker, false) then$new$,
$old$	update public.qorpera_surface_sessions
	set has_active_chat = false, updated_at = clock_timestamp()
	where id = p_session_id;$old$,
$new$	-- WHY: 20260930860000 strips newly approved changes from member preview selections just like single-change approval.
	if cardinality(v_change_ids) > 0 then
		update public.qorpera_member_surface_state
		set toggled_change_ids = array(
			select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_change_ids))
		)
		where surface_id = v_session.surface_id;
	end if;

	update public.qorpera_surface_sessions
	set has_active_chat = false, updated_at = clock_timestamp()
	where id = p_session_id;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
	array[
$old$		elsif p_status = 'conflicted' then
			update public.qorpera_surface_changes
			set
				status = case when id = p_conflict_change_id then 'conflicted' else 'staged' end,
				conflict_paths = case when id = p_conflict_change_id then p_conflict_paths else null end
			where id = any(v_change_ids) and surface_id = v_job.surface_id and status = 'merging';
		else
			update public.qorpera_surface_changes
			set status = 'staged'
			where id = any(v_change_ids) and surface_id = v_job.surface_id and status = 'merging';
		end if;$old$,
$new$		elsif p_status = 'conflicted' then
			update public.qorpera_surface_changes
			set
				status = case when id = p_conflict_change_id then 'conflicted' else 'staged' end,
				conflict_paths = case when id = p_conflict_change_id then p_conflict_paths else null end
			where id = any(v_change_ids) and surface_id = v_job.surface_id and status = 'merging';

			-- WHY: 20260930860000 surfaces merge conflicts in session chat so failures are never silently swallowed.
			insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body, change_id)
			select distinct
				v_job.profile_id,
				affected.sid,
				'system',
				left(
					'Merge conflicted'
						|| case when coalesce(cardinality(p_conflict_paths), 0) > 0
							then ' on ' || array_to_string(p_conflict_paths, ', ')
							else '' end
						|| case when nullif(btrim(coalesce(p_error_detail, '')), '') is not null
							then ': ' || btrim(p_error_detail)
							else '. Reconcile to resolve.' end,
					1000
				),
				(select ch.id from public.qorpera_surface_changes ch where ch.id = p_conflict_change_id and ch.surface_id = v_job.surface_id)
			from (
				select v_job.session_id as sid where v_job.session_id is not null
				union
				select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
			) affected;
		else
			update public.qorpera_surface_changes
			set status = 'staged'
			where id = any(v_change_ids) and surface_id = v_job.surface_id and status = 'merging';

			insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
			select distinct
				v_job.profile_id,
				affected.sid,
				'system',
				left(
					'Merge failed'
						|| case when nullif(btrim(coalesce(p_error_detail, '')), '') is not null
							then ': ' || btrim(p_error_detail)
							else '. Retry approving the change.' end,
					1000
				)
			from (
				select v_job.session_id as sid where v_job.session_id is not null
				union
				select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
			) affected;
		end if;$new$,
$old$	elsif v_job.kind = 'undo_change' then
		if p_status = 'landed' and p_main_after is not null then
			update public.qorpera_surfaces
			set live_head_sha = p_main_after, updated_at = clock_timestamp()
			where id = v_job.surface_id;
		elsif p_status in ('conflicted', 'failed') then
			-- WHY: When an undo is refused or fails without modifying disk, keep the database merged status aligned with disk.
			if jsonb_typeof(v_job.payload -> 'changeIds') = 'array' then
				select coalesce(array_agg(x::uuid), '{}'::uuid[])
				into v_change_ids
				from jsonb_array_elements_text(v_job.payload -> 'changeIds') as x;
			elsif v_job.payload ? 'changeId' then
				v_change_ids := array[(v_job.payload ->> 'changeId')::uuid];
			else
				v_change_ids := '{}'::uuid[];
			end if;

			update public.qorpera_surface_changes
			set status = 'merged', resolved_at = coalesce(resolved_at, clock_timestamp())
			where id = any(v_change_ids)
				and surface_id = v_job.surface_id
				and status = 'staged';
			get diagnostics v_merged_count = row_count;

			if v_merged_count > 0 then
				update public.qorpera_surfaces
				set
					unpublished_change_count = unpublished_change_count + v_merged_count,
					updated_at = clock_timestamp()
				where id = v_job.surface_id;
			end if;

			if v_job.session_id is not null then
				perform public.qorpera_evaluate_surface_session_lifecycle(v_job.session_id);
			end if;
		end if;
	end if;$old$,
$new$	elsif v_job.kind = 'undo_change' then
		if jsonb_typeof(v_job.payload -> 'changeIds') = 'array' then
			select coalesce(array_agg(x::uuid), '{}'::uuid[])
			into v_change_ids
			from jsonb_array_elements_text(v_job.payload -> 'changeIds') as x;
		elsif v_job.payload ? 'changeId' then
			v_change_ids := array[(v_job.payload ->> 'changeId')::uuid];
		else
			v_change_ids := '{}'::uuid[];
		end if;

		if p_status = 'landed' then
			if p_main_after is not null then
				update public.qorpera_surfaces
				set live_head_sha = p_main_after, updated_at = clock_timestamp()
				where id = v_job.surface_id;
			end if;

			update public.qorpera_surface_changes
			set landed_main_before = null, landed_main_after = null
			where id = any(v_change_ids)
				and surface_id = v_job.surface_id;
		elsif p_status in ('conflicted', 'failed') then
			-- WHY: When an undo is refused or fails without modifying disk, keep the database merged status aligned with disk.
			update public.qorpera_surface_changes
			set status = 'merged', resolved_at = coalesce(resolved_at, clock_timestamp())
			where id = any(v_change_ids)
				and surface_id = v_job.surface_id
				and status = 'staged';
			get diagnostics v_merged_count = row_count;

			if v_merged_count > 0 then
				update public.qorpera_surfaces
				set
					unpublished_change_count = unpublished_change_count + v_merged_count,
					updated_at = clock_timestamp()
				where id = v_job.surface_id;
			end if;

			insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
			select distinct
				v_job.profile_id,
				affected.sid,
				'system',
				left(
					case when p_status = 'conflicted' then 'Undo conflicted' else 'Undo failed' end
						|| case when coalesce(cardinality(p_conflict_paths), 0) > 0
							then ' on ' || array_to_string(p_conflict_paths, ', ')
							else '' end
						|| case when nullif(btrim(coalesce(p_error_detail, '')), '') is not null
							then ': ' || btrim(p_error_detail)
							else '. The merged change was kept on main.' end,
					1000
				)
			from (
				select v_job.session_id as sid where v_job.session_id is not null
				union
				select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
			) affected;

			if v_job.session_id is not null then
				perform public.qorpera_evaluate_surface_session_lifecycle(v_job.session_id);
			end if;
		end if;
	end if;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_undo_surface_change(uuid)'::regprocedure,
	array[
$old$			if cardinality(v_batch_ids) > 0 then
				v_undo_change_ids := v_batch_ids;
			end if;
		end if;

		update public.qorpera_surfaces$old$,
$new$			if cardinality(v_batch_ids) > 0 then
				v_undo_change_ids := v_batch_ids;
			end if;
		elsif v_change.kind = 'git_range'
			and v_change.landed_main_before is not null
			and v_change.landed_main_after is not null then
			-- WHY: 20260930860000 expands multi-change git_range undo to all merged changes sharing the same batch range.
			select coalesce(array_agg(ch.id order by ch.seq asc), array[p_change_id]),
				coalesce(bool_or(ch.published_at is not null), false)
			into v_batch_ids, v_batch_published
			from public.qorpera_surface_changes ch
			where ch.surface_id = v_change.surface_id
				and ch.session_id = v_session.id
				and ch.kind = 'git_range'
				and ch.landed_main_before = v_change.landed_main_before
				and ch.landed_main_after = v_change.landed_main_after
				and (ch.id = p_change_id or ch.status = 'merged');

			if v_batch_published then
				raise exception 'Published change cannot be rolled back before release; start a new change instead' using errcode = '22023';
			end if;
			if cardinality(v_batch_ids) > 0 then
				v_undo_change_ids := v_batch_ids;
			end if;
		end if;

		if exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_change.surface_id
				and j.kind in ('land_change', 'undo_change')
				and j.status in ('queued', 'running')
				and (
					(j.payload ? 'changeId' and (j.payload ->> 'changeId')::uuid = any(v_undo_change_ids))
					or exists (
						select 1
						from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
						where x::uuid = any(v_undo_change_ids)
					)
				)
		) then
			raise exception 'A merge or rollback job is already active for this change' using errcode = '55000';
		end if;

		update public.qorpera_surfaces$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_update_rebased_changes(uuid,uuid,text,jsonb,uuid,text[])'::regprocedure,
	array[
$old$declare
	v_item jsonb;
	v_updated integer := 0;
	v_now timestamptz := clock_timestamp();$old$,
$new$declare
	v_surface public.qorpera_surfaces%rowtype;
	v_item jsonb;
	v_updated integer := 0;
	v_now timestamptz := clock_timestamp();$new$,
$old$	perform 1
	from public.qorpera_surfaces sf
	where sf.id = p_surface_id
	for update;$old$,
$new$	select * into v_surface
	from public.qorpera_surfaces sf
	where sf.id = p_surface_id
	for update;$new$,
$old$	if p_branch_head_sha is not null and btrim(p_branch_head_sha) <> '' then
		update public.qorpera_surface_sessions s
		set
			branch_head_sha = btrim(p_branch_head_sha),
			updated_at = v_now
		where s.id = p_session_id and s.surface_id = p_surface_id;
	end if;$old$,
$new$	-- WHY: 20260930860000 advances surface session base_sha on clean rebases without touching coding_sessions.base_sha.
	if p_branch_head_sha is not null and btrim(p_branch_head_sha) <> '' then
		update public.qorpera_surface_sessions s
		set
			branch_head_sha = btrim(p_branch_head_sha),
			base_sha = case
				when v_updated > 0 and p_conflicted_change_id is null
				then coalesce(v_surface.live_head_sha, s.base_sha)
				else s.base_sha
			end,
			updated_at = v_now
		where s.id = p_session_id and s.surface_id = p_surface_id;
	end if;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure,
	array[
$old$				(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
					where c.session_id = p_session_id and c.head_sha is not null
					order by c.seq desc limit 1),$old$,
$new$				(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
					where c.session_id = p_session_id and c.head_sha is not null
						and c.status in ('staged', 'conflicted')
					order by c.seq desc limit 1),$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure,
	array[
$old$			select nullif(btrim(c.head_sha), '') into v_prev_sha
			from public.qorpera_surface_changes c
			where c.session_id = v_surf_session.id and c.head_sha is not null
			order by c.seq desc
			limit 1;$old$,
$new$			select nullif(btrim(c.head_sha), '') into v_prev_sha
			from public.qorpera_surface_changes c
			where c.session_id = v_surf_session.id and c.head_sha is not null
				and c.status in ('staged', 'conflicted')
			order by c.seq desc
			limit 1;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure,
	array[
$old$declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_next_seq smallint;
	v_change public.qorpera_surface_changes%rowtype;$old$,
$new$declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_next_seq smallint;
	v_change public.qorpera_surface_changes%rowtype;
	v_superseded_ids uuid[];
	v_affected_session_ids uuid[];
	v_affected_sid uuid;$new$,
$old$	update public.qorpera_surface_sessions
	set
		branch_head_sha = coalesce(p_head_sha, branch_head_sha),
		state = case when p_finish_session then 'ready' else state end,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;$old$,
$new$	-- WHY: 20260930860000 discards superseded conflicted changes once a reconciliation session records a resolved change.
	if (
		v_session.state in ('reconciling', 'reconciling_running')
		or v_session.origin_label = 'Conflict reconciliation'
	) and jsonb_typeof(v_session.origin_ref -> 'changeIds') = 'array' then
		-- WHY: Lock superseded sessions in canonical id order before updating their changes so approve/undo cannot deadlock (40P01).
		perform 1
		from public.qorpera_surface_sessions s
		where s.surface_id = v_session.surface_id
			and s.profile_id = v_session.profile_id
			and s.id <> p_session_id
			and s.id in (
				select ch.session_id
				from public.qorpera_surface_changes ch
				where ch.surface_id = v_session.surface_id
					and ch.profile_id = v_session.profile_id
					and ch.id <> v_change.id
					and ch.id in (
						select x::uuid
						from jsonb_array_elements_text(v_session.origin_ref -> 'changeIds') as x
					)
			)
		order by s.id asc
		for update;

		with resolved as (
			update public.qorpera_surface_changes ch
			set
				status = 'discarded',
				conflict_paths = null,
				resolved_at = clock_timestamp()
			where ch.surface_id = v_session.surface_id
				and ch.profile_id = v_session.profile_id
				and ch.id <> v_change.id
				and ch.status = 'conflicted'
				and ch.id in (
					select x::uuid
					from jsonb_array_elements_text(v_session.origin_ref -> 'changeIds') as x
				)
			returning ch.id, ch.session_id
		)
		select
			coalesce(array_agg(distinct id), '{}'::uuid[]),
			coalesce(array_agg(distinct session_id order by session_id), '{}'::uuid[])
		into v_superseded_ids, v_affected_session_ids
		from resolved;

		if cardinality(v_superseded_ids) > 0 then
			update public.qorpera_member_surface_state
			set toggled_change_ids = array(
				select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_superseded_ids))
			)
			where surface_id = v_session.surface_id;

			foreach v_affected_sid in array v_affected_session_ids loop
				if v_affected_sid <> p_session_id then
					perform public.qorpera_evaluate_surface_session_lifecycle(v_affected_sid);
				end if;
			end loop;
		end if;
	end if;

	update public.qorpera_surface_sessions
	set
		branch_head_sha = coalesce(p_head_sha, branch_head_sha),
		state = case when p_finish_session then 'ready' else state end,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_reconcile_surface_changes(uuid,uuid[])'::regprocedure,
	array[
$old$	v_titles text;
	v_paths text[];
	v_session public.qorpera_surface_sessions%rowtype;
	v_prompt text;$old$,
$new$	v_titles text;
	v_paths text[];
	v_changes jsonb;
	v_session public.qorpera_surface_sessions%rowtype;
	v_prompt text;$new$,
$old$	select
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
	)$old$,
$new$	-- WHY: 20260930860000 avoids 2202E array_agg(text[]) failures on ragged conflict arrays and stores structured conflict metadata.
	select
		string_agg(ch.title, ', ' order by ch.created_at asc, ch.id asc),
		coalesce(
			jsonb_agg(
				jsonb_build_object(
					'changeId', ch.id,
					'title', ch.title,
					'sessionId', ch.session_id,
					'branch', cs.branch,
					'parentSha', ch.parent_sha,
					'headSha', ch.head_sha,
					'conflictPaths', to_jsonb(coalesce(ch.conflict_paths, '{}'::text[]))
				)
				order by ch.created_at asc, ch.id asc
			),
			'[]'::jsonb
		)
	into v_titles, v_changes
	from public.qorpera_surface_changes ch
	join public.qorpera_surface_sessions s on s.id = ch.session_id
	left join public.qorpera_coding_sessions cs on cs.worker_id = s.worker_id
	where ch.surface_id = p_surface_id and ch.id = any(p_change_ids);

	select coalesce(array_agg(distinct p order by p), '{}'::text[])
	into v_paths
	from public.qorpera_surface_changes ch
	cross join lateral unnest(coalesce(nullif(ch.conflict_paths, '{}'::text[]), ch.affected_paths, '{}'::text[])) as p
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
		jsonb_build_object(
			'changeIds', to_jsonb(p_change_ids),
			'paths', to_jsonb(coalesce(v_paths, '{}'::text[])),
			'mainSha', v_surface.live_head_sha,
			'changes', coalesce(v_changes, '[]'::jsonb)
		),
		v_user_id, 'reconciling', v_surface.live_head_sha
	)$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$	select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
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
	);$old$,
$new$	-- WHY: 20260930860000 unions origin_ref paths and exposes conflictDetails/mainSha so newly spawned reconciling sessions see full context.
	select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
	from (
		select p
		from public.qorpera_surface_changes c
		cross join lateral unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
		where c.session_id = v_session.id and c.status = 'conflicted'
		union
		select x as p
		from jsonb_array_elements_text(
			case
				when jsonb_typeof(v_session.origin_ref -> 'paths') = 'array' then v_session.origin_ref -> 'paths'
				else '[]'::jsonb
			end
		) as x
		where nullif(btrim(x), '') is not null
	) combined;
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
		'mainSha', v_surface.live_head_sha,
		'conflictPaths', to_jsonb(coalesce(v_conflict_paths, '{}'::text[])),
		'conflictDetails', case
			when jsonb_typeof(v_session.origin_ref -> 'changes') = 'array' then v_session.origin_ref -> 'changes'
			else '[]'::jsonb
		end
	);$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
	array[
$old$declare
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
		lease_expires_at = null,
		lease_token = null,
		retry_count = 0,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;$old$,
$new$declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_user_id uuid;
	v_body text := btrim(coalesce(p_message, ''));
begin
	if char_length(v_body) < 1 then
		raise exception 'Message cannot be empty' using errcode = '22023';
	end if;
	select * into v_peek from public.qorpera_surface_sessions where id = p_session_id;
	if v_peek.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user_id := public.qorpera_assert_surface_member(v_peek.profile_id, true);

	-- WHY: 20260930860000 cancels active coding workers before locking surface_sessions so replies supersede running turns cleanly.
	if v_peek.worker_id is not null then
		perform public.qorpera_surface_cancel_coding_workers(array[p_session_id], 'surface_superseded');
	end if;

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_session.profile_id, p_session_id, 'member', v_user_id, v_body);

	update public.qorpera_surface_sessions
	set
		state = 'queued',
		question = null,
		has_active_chat = coalesce(p_keep_open, true),
		closed_at = null,
		lease_expires_at = null,
		lease_token = null,
		wake_id = case when worker_id is not null then null else wake_id end,
		retry_count = 0,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
	array[
$old$	v_dispatch jsonb;
	v_followup text;
	v_conflict_paths text[];$old$,
$new$	v_dispatch jsonb;
	v_followup text;
	v_context text;
	v_reconcile_summary text;
	v_conflict_paths text[];$new$,
$old$		if v_worker.id is not null and v_coding_session.worker_id is not null
			and v_coding_session.phase in ('queued', 'input_ready', 'preparing', 'running', 'publishing')
			and v_worker.state = 'active' then
			return jsonb_build_object(
				'status', 'enqueued',
				'wakeId', v_session.wake_id,
				'runId', null,
				'workerId', v_worker.id
			);
		end if;$old$,
$new$		-- WHY: 20260930860000 refuses to short-circuit an active worker when a newer member reply superseded it.
		if v_worker.id is not null and v_coding_session.worker_id is not null
			and v_coding_session.phase in ('queued', 'input_ready', 'preparing', 'running', 'publishing')
			and v_worker.state = 'active'
			and not exists (
				select 1 from public.qorpera_surface_session_messages m
				where m.session_id = v_session.id
					and m.author_kind = 'member'
					and m.created_at > v_worker.updated_at
			) then
			return jsonb_build_object(
				'status', 'enqueued',
				'wakeId', v_session.wake_id,
				'runId', null,
				'workerId', v_worker.id
			);
		end if;$new$,
$old$		if v_worker.id is null then
			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.',
				'context', public.qorpera_surface_utf8_left(coalesce(v_surface.brief_summary, ''), 500),
				'sources', '[]'::jsonb,
				'followUp', null,
				'authority', 'Work only inside this Surface repository worktree on the session branch.',
				'output', 'Stage changes on the session branch via coding_record_change and finish with coding_finish.',
				'cancellation', 'Stop if the Surface session is cancelled or superseded.',
				'completion', 'Sync staged commits and summary back to the Surface session.'
			);

			insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				surface_backed, surface_session_id
			)
			values (
				v_session.profile_id, v_cofounder.environment_id, v_cofounder.staff_agent_id, null,
				'surface-' || replace(v_session.id::text, '-', ''), 'coding', v_title,
				'read', 'each', v_dispatch, 'active', 1, v_requester, null,
				v_requester, (v_coding_sponsor ->> 'bindingId')::uuid, (v_coding_sponsor ->> 'version')::bigint,
				true, v_session.id
			)
			returning * into v_worker;

			insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
			values (v_worker.id, 1, 'dispatched', null, jsonb_build_object('surfaceSessionId', v_session.id));

			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness, v_repo,
				'qorpera/coding/' || v_worker.id::text, v_session.base_sha,
				'queued', v_session.id
			)
			returning * into v_coding_session;

			perform public.qorpera_coding_session_queue(v_worker, 'dispatch', null, null);
		else
			if v_worker.sequence >= 64 then
				return jsonb_build_object('status', 'unavailable', 'reason', 'session_turn_limit');
			end if;
			if v_worker.state = 'active' then
				perform public.qorpera_cancel_worker(v_worker, null, 'surface_superseded');
				select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
			end if;

			if v_session.state = 'reconciling_running' then
				select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
				from public.qorpera_surface_changes c, unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
				where c.session_id = v_session.id and c.status = 'conflicted';
				v_followup := 'Reconcile overlapping changes on the session branch'
					|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
						then ' across: ' || array_to_string(v_conflict_paths, ', ')
						else '' end
					|| '. Commit the clean resolution, record the updated change, and call coding_finish.';
			else
				select btrim(m.body) into v_followup
				from public.qorpera_surface_session_messages m
				where m.session_id = v_session.id and m.author_kind = 'member'
				order by m.created_at desc, m.id desc
				limit 1;
				if nullif(v_followup, '') is null then
					v_followup := 'Continue and complete the requested surface changes.';
				end if;
			end if;$old$,
$new$		if v_worker.id is null then
			v_followup := null;
			select nullif(btrim(m.body), '') into v_followup
			from public.qorpera_surface_session_messages m
			where m.session_id = v_session.id
				and m.author_kind = 'member'
				and (
					btrim(m.body) is distinct from btrim(coalesce(v_session.prompt, ''))
					or exists (
						select 1 from public.qorpera_surface_session_messages earlier
						where earlier.session_id = v_session.id
							and (earlier.created_at < m.created_at or (earlier.created_at = m.created_at and earlier.id < m.id))
					)
				)
			order by m.created_at desc, m.id desc
			limit 1;
			if v_followup is not null then
				v_followup := public.qorpera_surface_utf8_left(v_followup, 2000);
			end if;

			v_context := public.qorpera_surface_utf8_left(coalesce(v_surface.brief_summary, ''), 500);
			if v_session.state = 'reconciling_running' or v_session.origin_label = 'Conflict reconciliation' then
				select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
				from (
					select p
					from public.qorpera_surface_changes c
					cross join lateral unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
					where c.session_id = v_session.id and c.status = 'conflicted'
					union
					select x as p
					from jsonb_array_elements_text(
						case
							when jsonb_typeof(v_session.origin_ref -> 'paths') = 'array' then v_session.origin_ref -> 'paths'
							else '[]'::jsonb
						end
					) as x
					where nullif(btrim(x), '') is not null
				) combined;

				select string_agg(
					coalesce(nullif(btrim(item ->> 'title'), ''), item ->> 'changeId', 'change')
						|| case when nullif(btrim(coalesce(item ->> 'branch', '')), '') is not null
							then ' [branch ' || btrim(item ->> 'branch') || ']' else '' end
						|| case when nullif(btrim(coalesce(item ->> 'parentSha', '')), '') is not null
							and nullif(btrim(coalesce(item ->> 'headSha', '')), '') is not null
							then ' (' || left(btrim(item ->> 'parentSha'), 12) || '..' || left(btrim(item ->> 'headSha'), 12) || ')'
							when nullif(btrim(coalesce(item ->> 'headSha', '')), '') is not null
							then ' (' || left(btrim(item ->> 'headSha'), 12) || ')'
							else '' end
						|| case when jsonb_typeof(item -> 'conflictPaths') = 'array' and jsonb_array_length(item -> 'conflictPaths') > 0
							then ' paths: ' || (select string_agg(cp, ', ') from jsonb_array_elements_text(item -> 'conflictPaths') as cp)
							else '' end,
					'; '
				) into v_reconcile_summary
				from jsonb_array_elements(
					case
						when jsonb_typeof(v_session.origin_ref -> 'changes') = 'array' then v_session.origin_ref -> 'changes'
						else '[]'::jsonb
					end
				) as item;

				v_goal := public.qorpera_surface_utf8_left(
					v_goal
						|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
							then E'\nConflicted paths: ' || array_to_string(v_conflict_paths, ', ')
							else '' end
						|| case when nullif(btrim(coalesce(v_session.origin_ref ->> 'mainSha', v_surface.live_head_sha, '')), '') is not null
							then E'\nMain SHA: ' || btrim(coalesce(v_session.origin_ref ->> 'mainSha', v_surface.live_head_sha))
							else '' end
						|| case when nullif(btrim(coalesce(v_reconcile_summary, '')), '') is not null
							then E'\nConflicting commits: ' || v_reconcile_summary
							else '' end,
					2000
				);
				v_context := public.qorpera_surface_utf8_left(
					concat_ws(
						E'\n',
						nullif(v_context, ''),
						case when nullif(btrim(coalesce(v_session.origin_ref ->> 'mainSha', v_surface.live_head_sha, '')), '') is not null
							then 'Reconcile onto main ' || btrim(coalesce(v_session.origin_ref ->> 'mainSha', v_surface.live_head_sha)) end,
						case when coalesce(cardinality(v_conflict_paths), 0) > 0
							then 'Conflicted paths: ' || array_to_string(v_conflict_paths, ', ') end,
						case when nullif(btrim(coalesce(v_reconcile_summary, '')), '') is not null
							then 'Conflicting changes: ' || v_reconcile_summary end
					),
					1500
				);
			end if;

			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.',
				'context', v_context,
				'sources', '[]'::jsonb,
				'followUp', v_followup,
				'authority', 'Work only inside this Surface repository worktree on the session branch.',
				'output', 'Stage changes on the session branch via coding_record_change and finish with coding_finish.',
				'cancellation', 'Stop if the Surface session is cancelled or superseded.',
				'completion', 'Sync staged commits and summary back to the Surface session.'
			);

			insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				surface_backed, surface_session_id
			)
			values (
				v_session.profile_id, v_cofounder.environment_id, v_cofounder.staff_agent_id, null,
				'surface-' || replace(v_session.id::text, '-', ''), 'coding', v_title,
				'read', 'each', v_dispatch, 'active', 1, v_requester, null,
				v_requester, (v_coding_sponsor ->> 'bindingId')::uuid, (v_coding_sponsor ->> 'version')::bigint,
				true, v_session.id
			)
			returning * into v_worker;

			insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
			values (v_worker.id, 1, 'dispatched', null, jsonb_build_object('surfaceSessionId', v_session.id));

			-- WHY: 20260930860000 leaves coding_sessions.base_sha null on initial insert so coding-executor-host resolves current main.
			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness, v_repo,
				'qorpera/coding/' || v_worker.id::text, null,
				'queued', v_session.id
			)
			returning * into v_coding_session;

			perform public.qorpera_coding_session_queue(v_worker, 'dispatch', null, null);
		else
			if v_worker.sequence >= 64 then
				return jsonb_build_object('status', 'unavailable', 'reason', 'session_turn_limit');
			end if;
			if v_worker.state = 'active' then
				perform public.qorpera_cancel_worker(v_worker, null, 'surface_superseded');
				select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
			end if;

			if v_session.state = 'reconciling_running' then
				select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
				from (
					select p
					from public.qorpera_surface_changes c
					cross join lateral unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
					where c.session_id = v_session.id and c.status = 'conflicted'
					union
					select x as p
					from jsonb_array_elements_text(
						case
							when jsonb_typeof(v_session.origin_ref -> 'paths') = 'array' then v_session.origin_ref -> 'paths'
							else '[]'::jsonb
						end
					) as x
					where nullif(btrim(x), '') is not null
				) combined;
				v_followup := 'Reconcile overlapping changes on the session branch'
					|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
						then ' across: ' || array_to_string(v_conflict_paths, ', ')
						else '' end
					|| '. Commit the clean resolution, record the updated change, and call coding_finish.';
			else
				select btrim(m.body) into v_followup
				from public.qorpera_surface_session_messages m
				where m.session_id = v_session.id and m.author_kind = 'member'
				order by m.created_at desc, m.id desc
				limit 1;
				if nullif(v_followup, '') is null then
					v_followup := coalesce(nullif(btrim(v_session.prompt), ''), 'Continue and complete the requested surface changes.');
				end if;
			end if;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure,
	array[
$old$		and not exists (
			select 1 from public.qorpera_coding_sessions cs
			where cs.worker_id = s.worker_id
				and cs.phase in ('preparing', 'running', 'publishing')
				and cs.lease_until is not null
				and cs.lease_until > p_now
		)$old$,
$new$		-- WHY: 20260930860000 exempts healthy queued/input_ready coding sessions for 30 minutes so queue waits do not prematurely fail.
		and not exists (
			select 1 from public.qorpera_coding_sessions cs
			where cs.worker_id = s.worker_id
				and (
					(cs.phase in ('preparing', 'running', 'publishing')
						and cs.lease_until is not null
						and cs.lease_until > p_now)
					or (cs.phase in ('queued', 'input_ready')
						and coalesce(cs.updated_at, cs.created_at) > p_now - interval '30 minutes')
				)
		)$new$,
$old$			and not exists (
				select 1 from public.qorpera_coding_sessions cs
				where cs.worker_id = s.worker_id
					and cs.phase in ('preparing', 'running', 'publishing')
					and cs.lease_until is not null
					and cs.lease_until > p_now
			)$old$,
$new$			and not exists (
				select 1 from public.qorpera_coding_sessions cs
				where cs.worker_id = s.worker_id
					and (
						(cs.phase in ('preparing', 'running', 'publishing')
							and cs.lease_until is not null
							and cs.lease_until > p_now)
						or (cs.phase in ('queued', 'input_ready')
							and coalesce(cs.updated_at, cs.created_at) > p_now - interval '30 minutes')
					)
			)$new$,
$old$			if v_cs.worker_id is not null
				and v_cs.phase in ('preparing', 'running', 'publishing')
				and v_cs.lease_until is not null
				and v_cs.lease_until > p_now then
				continue;
			end if;$old$,
$new$			if v_cs.worker_id is not null
				and (
					(v_cs.phase in ('preparing', 'running', 'publishing')
						and v_cs.lease_until is not null
						and v_cs.lease_until > p_now)
					or (v_cs.phase in ('queued', 'input_ready')
						and coalesce(v_cs.updated_at, v_cs.created_at) > p_now - interval '30 minutes')
				) then
				continue;
			end if;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_surface_ensure_site(uuid)'::regprocedure,
	array[
$old$	if v_surface.id is null or v_surface.archetype <> 'live_build' then
		return null;
	end if;$old$,
$new$	-- WHY: 20260930860000 provisions sites for both live_build and code_repo surfaces.
	if v_surface.id is null or (v_surface.archetype <> 'live_build' and v_surface.source_kind <> 'code_repo') then
		return null;
	end if;$new$
	]
);

select pg_temp.sprmh_patch(
	'public.qorpera_approve_proposed_surface(uuid)'::regprocedure,
	array[
$old$	update public.qorpera_surfaces
	set status = 'active', updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);$old$,
$new$	update public.qorpera_surfaces
	set status = 'active', updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	-- WHY: 20260930860000 provisions the company site when activating a proposed live_build/code_repo surface.
	if (v_surface.archetype = 'live_build' or v_surface.source_kind = 'code_repo') and v_surface.site_id is null then
		perform public.qorpera_surface_ensure_site(p_surface_id);
		select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	end if;

	return public.qorpera_surface_summary_json(v_surface);$new$
	]
);

do $$
declare
	v_expected_patched constant regprocedure[] := array[
		'public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)'::regprocedure,
		'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
		'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
		'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
		'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_approve_surface_change(uuid,boolean)'::regprocedure,
		'public.qorpera_approve_session_all(uuid)'::regprocedure,
		'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
		'public.qorpera_undo_surface_change(uuid)'::regprocedure,
		'public.qorpera_surface_update_rebased_changes(uuid,uuid,text,jsonb,uuid,text[])'::regprocedure,
		'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure,
		'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure,
		'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure,
		'public.qorpera_reconcile_surface_changes(uuid,uuid[])'::regprocedure,
		'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
		'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
		'public.qorpera_surface_expire_coding_sessions(timestamptz,integer)'::regprocedure,
		'public.qorpera_surface_ensure_site(uuid)'::regprocedure,
		'public.qorpera_approve_proposed_surface(uuid)'::regprocedure
	];
	v_expected_new constant regprocedure[] := array[
		'public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)'::regprocedure
	];
begin
	if (select count(*) from pg_temp.sprmh_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> cardinality(v_expected_patched)
		or exists (select 1 from pg_temp.sprmh_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and not (prior.oid = any(v_expected_patched))))
		or (select count(*) from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.sprmh_before as prior)) <> cardinality(v_expected_new)
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.sprmh_before as prior)
			and not (p.oid = any(v_expected_new))) then
		raise exception '20260930860000: catalog changed unexpectedly';
	end if;
end $$;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)'::regprocedure,
			'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
			'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
			'public.qorpera_approve_proposed_surface(uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface hardening function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_preview_composition_key(uuid, text, uuid[], uuid), public.qorpera_surface_cancel_coding_workers(uuid[], text), public.qorpera_surface_ensure_site(uuid) to %I', v_owner);
	end loop;
end $$;

drop function pg_temp.sprmh_patch(regprocedure, text[]);
drop table pg_temp.sprmh_before;
