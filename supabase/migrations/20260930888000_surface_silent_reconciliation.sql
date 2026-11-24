-- WHY: Replaces founder-facing surface conflict/reconcile prompts with cached non-destructive reconciliation overlays
-- backed by hidden internal sessions across folder and code_repo surfaces.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)') is null
		or to_regprocedure('public.qorpera_surface_remove(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)') is null then
		raise exception '20260930888000 requires 20260930860000, 20260930862000 and 20260930875000';
	end if;
	if to_regclass('public.qorpera_surface_reconciliations') is not null then
		raise exception '20260930888000 is already applied';
	end if;
end $$;

create temporary table ssr_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.ssr_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930888000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930888000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surfaces
	add column folder_revision bigint not null default 0 check (folder_revision >= 0);

alter table public.qorpera_surface_changes
	add column base_files jsonb;

alter table public.qorpera_surface_sessions
	add column is_internal boolean not null default false;

create index qorpera_surface_sessions_visible
	on public.qorpera_surface_sessions(surface_id, state, updated_at desc)
	where not is_internal;

do $$
declare
	v_con name;
begin
	for v_con in
		select c.conname
		from pg_constraint c
		where c.conrelid = 'public.qorpera_surface_previews'::regclass
			and c.contype = 'c'
			and pg_get_constraintdef(c.oid) like '%composing%'
			and pg_get_constraintdef(c.oid) like '%conflicted%'
	loop
		execute format('alter table public.qorpera_surface_previews drop constraint %I', v_con);
	end loop;
end $$;

alter table public.qorpera_surface_previews
	add constraint qorpera_surface_previews_status_check
	check (status in ('composing', 'reconciling', 'building', 'ready', 'conflicted', 'failed'));

create table public.qorpera_surface_reconciliations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	composition_key text not null check (char_length(composition_key) between 1 and 128),
	base_fingerprint text not null check (char_length(base_fingerprint) between 1 and 128),
	selected_change_ids uuid[] not null check (cardinality(selected_change_ids) >= 1),
	status text not null check (status in ('queued', 'running', 'ready', 'failed')) default 'queued',
	session_id uuid references public.qorpera_surface_sessions(id) on delete set null,
	reconciled_patch_manifest jsonb,
	reconciled_commit_sha text check (reconciled_commit_sha is null or reconciled_commit_sha ~ '^[0-9a-f]{40}$'),
	reconciled_tree_sha text check (reconciled_tree_sha is null or reconciled_tree_sha ~ '^[0-9a-f]{40}$'),
	conflict_paths text[] not null default '{}'::text[],
	error_detail text check (error_detail is null or char_length(error_detail) <= 1000),
	attempts integer not null default 0 check (attempts >= 0),
	auto_approve_after boolean not null default false,
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
	unique (surface_id, composition_key)
);

create index qorpera_surface_reconciliations_surface_status
	on public.qorpera_surface_reconciliations(surface_id, base_fingerprint, status, updated_at desc);
create index qorpera_surface_reconciliations_session
	on public.qorpera_surface_reconciliations(session_id)
	where session_id is not null;
create index qorpera_surface_reconciliations_expires
	on public.qorpera_surface_reconciliations(expires_at);

alter table public.qorpera_surface_reconciliations enable row level security;
revoke all on public.qorpera_surface_reconciliations from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_base_fingerprint(p_surface public.qorpera_surfaces)
returns text
language sql immutable set search_path = '' as $$
	select case
		when p_surface.source_kind = 'folder' then 'folder-rev:' || coalesce(p_surface.folder_revision, 0)::text
		else coalesce(nullif(btrim(coalesce(p_surface.live_head_sha, '')), ''), 'base')
	end
$$;

create function public.qorpera_surface_reconciliation_json(p_rec public.qorpera_surface_reconciliations)
returns jsonb
language sql immutable set search_path = '' as $$
	select jsonb_build_object(
		'id', p_rec.id,
		'surfaceId', p_rec.surface_id,
		'compositionKey', p_rec.composition_key,
		'baseFingerprint', p_rec.base_fingerprint,
		'selectedChangeIds', to_jsonb(p_rec.selected_change_ids),
		'status', p_rec.status,
		'patchManifest', p_rec.reconciled_patch_manifest,
		'commitSha', p_rec.reconciled_commit_sha,
		'treeSha', p_rec.reconciled_tree_sha,
		'errorDetail', p_rec.error_detail,
		'updatedAt', p_rec.updated_at
	)
$$;

create function public.qorpera_surface_reconciliation_key(
	p_surface public.qorpera_surfaces,
	p_change_ids uuid[]
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
	v_base_fp text := public.qorpera_surface_base_fingerprint(p_surface);
	v_ordered_ids uuid[];
	v_key_input text;
begin
	select
		coalesce(array_agg(ch.id order by ch.created_at asc, ch.seq asc, ch.id asc), '{}'::uuid[]),
		string_agg(
			ch.id::text || ':' || case
				when ch.kind = 'folder_patch' then encode(extensions.digest(coalesce(ch.patch_manifest::text, ''), 'sha256'), 'hex')
				else coalesce(ch.parent_sha, '') || ':' || coalesce(ch.head_sha, '')
			end,
			',' order by ch.created_at asc, ch.seq asc, ch.id asc
		)
	into v_ordered_ids, v_key_input
	from public.qorpera_surface_changes ch
	where ch.surface_id = p_surface.id
		and ch.profile_id = p_surface.profile_id
		and ch.id = any(coalesce(p_change_ids, '{}'::uuid[]))
		and ch.status in ('staged', 'conflicted', 'merging');

	if coalesce(cardinality(v_ordered_ids), 0) = 0 then
		return null;
	end if;

	return jsonb_build_object(
		'baseFingerprint', v_base_fp,
		'orderedChangeIds', to_jsonb(v_ordered_ids),
		'compositionKey', encode(extensions.digest(v_base_fp || '|' || coalesce(v_key_input, ''), 'sha256'), 'hex')
	);
end $$;

create function public.qorpera_surface_fail_reconciliation(
	p_reconciliation_id uuid,
	p_error_detail text default null
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
	v_rec public.qorpera_surface_reconciliations%rowtype;
	v_had_auto_approve boolean := false;
	v_now timestamptz := clock_timestamp();
	v_detail text := left(coalesce(nullif(btrim(coalesce(p_error_detail, '')), ''), 'Couldn''t update preview'), 1000);
begin
	select r.auto_approve_after
	into v_had_auto_approve
	from public.qorpera_surface_reconciliations r
	where r.id = p_reconciliation_id
		and r.status in ('queued', 'running')
	for update;

	if not found then
		return;
	end if;

	update public.qorpera_surface_reconciliations
	set
		status = 'failed',
		error_detail = v_detail,
		auto_approve_after = false,
		updated_at = v_now
	where id = p_reconciliation_id
		and status in ('queued', 'running')
	returning * into v_rec;

	if v_rec.id is null then
		return;
	end if;

	if coalesce(v_had_auto_approve, false) then
		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
		select distinct
			v_rec.profile_id,
			ch.session_id,
			'system',
			'Could not apply this change automatically. Try approving again.'
		from public.qorpera_surface_changes ch
		where ch.surface_id = v_rec.surface_id
			and ch.id = any(v_rec.selected_change_ids);
	end if;

	update public.qorpera_surface_previews p
	set
		status = 'failed',
		conflict_report = null,
		error_detail = v_detail,
		lease_expires_at = null,
		lease_token = null,
		updated_at = v_now
	where p.surface_id = v_rec.surface_id
		and p.status = 'reconciling'
		and (
			select array_agg(x order by x) from unnest(p.selected_change_ids) as x
		) = (
			select array_agg(y order by y) from unnest(v_rec.selected_change_ids) as y
		);
end $$;

create function public.qorpera_surface_enqueue_silent_reconciliation(
	p_surface_id uuid,
	p_change_ids uuid[],
	p_conflict_paths text[] default '{}'::text[],
	p_requester_user_id uuid default null,
	p_auto_approve_after boolean default false,
	p_retry_failed boolean default false
)
returns public.qorpera_surface_reconciliations
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_key_info jsonb;
	v_comp_key text;
	v_base_fp text;
	v_ordered_ids uuid[];
	v_existing public.qorpera_surface_reconciliations%rowtype;
	v_rec public.qorpera_surface_reconciliations%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_requester uuid;
	v_titles text;
	v_changes jsonb;
	v_paths text[];
	v_prompt text;
	v_now timestamptz := clock_timestamp();
begin
	perform pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('qorpera.surface-reconcile:' || p_surface_id::text, 0)
	);

	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	if v_surface.status <> 'active' then
		raise exception 'Surface is not active' using errcode = '55000';
	end if;

	v_key_info := public.qorpera_surface_reconciliation_key(v_surface, p_change_ids);
	if v_key_info is null then
		raise exception 'No open changes found to reconcile' using errcode = '22023';
	end if;

	v_comp_key := v_key_info ->> 'compositionKey';
	v_base_fp := v_key_info ->> 'baseFingerprint';
	select array_agg(x::uuid order by ord)
	into v_ordered_ids
	from jsonb_array_elements_text(v_key_info -> 'orderedChangeIds') with ordinality as u(x, ord);

	select * into v_existing
	from public.qorpera_surface_reconciliations r
	where r.surface_id = p_surface_id
		and r.composition_key = v_comp_key
	for update;

	if v_existing.id is not null and v_existing.expires_at > v_now then
		if v_existing.status = 'ready' then
			update public.qorpera_surface_reconciliations
			set expires_at = v_now + interval '24 hours'
			where id = v_existing.id
			returning * into v_rec;
			return v_rec;
		elsif v_existing.status in ('queued', 'running') then
			update public.qorpera_surface_reconciliations
			set
				auto_approve_after = auto_approve_after or coalesce(p_auto_approve_after, false),
				expires_at = v_now + interval '24 hours',
				updated_at = v_now
			where id = v_existing.id
			returning * into v_rec;
			return v_rec;
		elsif v_existing.status = 'failed' and not coalesce(p_retry_failed, false) then
			return v_existing;
		end if;
	end if;

	if p_requester_user_id is not null and exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.user_id = p_requester_user_id
	) then
		v_requester := p_requester_user_id;
	else
		select coalesce(
			(
				select coalesce(s.turn_requested_by_user_id, s.created_by_user_id)
				from public.qorpera_surface_changes ch
				join public.qorpera_surface_sessions s on s.id = ch.session_id
				join public.qorpera_profile_members m
					on m.profile_id = v_surface.profile_id
					and m.user_id = coalesce(s.turn_requested_by_user_id, s.created_by_user_id)
				where ch.id = any(v_ordered_ids)
				order by ch.created_at desc, ch.seq desc
				limit 1
			),
			(
				select c.created_by_user_id
				from public.qorpera_company_cofounders c
				where c.profile_id = v_surface.profile_id
				limit 1
			),
			(
				select m.user_id
				from public.qorpera_profile_members m
				where m.profile_id = v_surface.profile_id
				order by (m.role = 'owner') desc, m.joined_at asc
				limit 1
			)
		) into v_requester;
	end if;

	select
		string_agg(ch.title, ', ' order by ch.created_at asc, ch.seq asc, ch.id asc),
		coalesce(
			jsonb_agg(
				jsonb_build_object(
					'changeId', ch.id,
					'title', ch.title,
					'summary', ch.summary,
					'kind', ch.kind,
					'prompt', s.prompt,
					'createdAt', ch.created_at,
					'sessionId', ch.session_id,
					'branch', cs.branch,
					'parentSha', ch.parent_sha,
					'headSha', ch.head_sha,
					'patchManifest', ch.patch_manifest,
					'baseFiles', ch.base_files,
					'affectedPaths', to_jsonb(coalesce(ch.affected_paths, '{}'::text[])),
					'conflictPaths', to_jsonb(coalesce(ch.conflict_paths, '{}'::text[]))
				)
				order by ch.created_at asc, ch.seq asc, ch.id asc
			),
			'[]'::jsonb
		)
	into v_titles, v_changes
	from public.qorpera_surface_changes ch
	join public.qorpera_surface_sessions s on s.id = ch.session_id
	left join public.qorpera_coding_sessions cs on cs.worker_id = s.worker_id
	where ch.surface_id = p_surface_id and ch.id = any(v_ordered_ids);

	select coalesce(array_agg(distinct p order by p), '{}'::text[])
	into v_paths
	from (
		select p from unnest(coalesce(p_conflict_paths, '{}'::text[])) as p
		where nullif(btrim(p), '') is not null
		union
		select p
		from public.qorpera_surface_changes ch
		cross join lateral unnest(coalesce(nullif(ch.conflict_paths, '{}'::text[]), ch.affected_paths, '{}'::text[])) as p
		where ch.surface_id = p_surface_id and ch.id = any(v_ordered_ids)
			and nullif(btrim(p), '') is not null
	) combined;

	delete from public.qorpera_surface_reconciliations
	where surface_id = p_surface_id
		and composition_key <> v_comp_key
		and expires_at <= v_now - interval '1 hour'
		and status <> 'running';

	if v_existing.id is not null then
		update public.qorpera_surface_reconciliations
		set
			selected_change_ids = v_ordered_ids,
			status = 'queued',
			session_id = null,
			reconciled_patch_manifest = null,
			reconciled_commit_sha = null,
			reconciled_tree_sha = null,
			conflict_paths = v_paths,
			error_detail = null,
			attempts = 0,
			auto_approve_after = auto_approve_after or coalesce(p_auto_approve_after, false),
			created_by_user_id = coalesce(v_requester, created_by_user_id),
			updated_at = v_now,
			expires_at = v_now + interval '24 hours'
		where id = v_existing.id
		returning * into v_rec;
	else
		insert into public.qorpera_surface_reconciliations(
			profile_id, surface_id, composition_key, base_fingerprint,
			selected_change_ids, status, conflict_paths, auto_approve_after,
			created_by_user_id, updated_at, expires_at
		)
		values (
			v_surface.profile_id, p_surface_id, v_comp_key, v_base_fp,
			v_ordered_ids, 'queued', v_paths, coalesce(p_auto_approve_after, false),
			v_requester, v_now, v_now + interval '24 hours'
		)
		returning * into v_rec;
	end if;

	v_prompt := 'Silently combine overlapping staged changes on ' || v_surface.title || ': ' || coalesce(v_titles, 'selected changes');

	insert into public.qorpera_surface_sessions(
		profile_id, surface_id, title, prompt, origin_kind, origin_label, origin_ref,
		created_by_user_id, turn_requested_by_user_id, state, base_sha, has_active_chat, is_internal
	)
	values (
		v_surface.profile_id, p_surface_id,
		left('Silent reconcile: ' || coalesce(v_titles, 'changes'), 160),
		v_prompt,
		case when v_requester is not null then 'member' else 'cofounder' end,
		'Silent reconciliation',
		jsonb_build_object(
			'reconciliationId', v_rec.id,
			'silent', true,
			'compositionKey', v_comp_key,
			'baseFingerprint', v_base_fp,
			'changeIds', to_jsonb(v_ordered_ids),
			'paths', to_jsonb(v_paths),
			'mainSha', v_surface.live_head_sha,
			'folderRevision', v_surface.folder_revision,
			'changes', coalesce(v_changes, '[]'::jsonb)
		),
		v_requester, v_requester, 'reconciling', v_surface.live_head_sha, false, true
	)
	returning * into v_session;

	update public.qorpera_surface_reconciliations
	set session_id = v_session.id, updated_at = v_now
	where id = v_rec.id
	returning * into v_rec;

	if coalesce(p_retry_failed, false) and v_surface.source_kind = 'code_repo' then
		update public.qorpera_surface_previews p
		set
			status = 'reconciling',
			conflict_report = null,
			error_detail = null,
			lease_expires_at = null,
			lease_token = null,
			attempts = 0,
			updated_at = v_now
		where p.surface_id = p_surface_id
			and p.status in ('failed', 'conflicted')
			and (
				select array_agg(x order by x) from unnest(p.selected_change_ids) as x
			) = (
				select array_agg(y order by y) from unnest(v_ordered_ids) as y
			);
	end if;

	return v_rec;
end $$;

create function public.qorpera_ensure_surface_reconciliation(
	p_surface_id uuid,
	p_change_ids uuid[],
	p_conflict_paths text[] default '{}'::text[],
	p_retry boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_key_info jsonb;
	v_existing public.qorpera_surface_reconciliations%rowtype;
	v_rec public.qorpera_surface_reconciliations%rowtype;
begin
	perform public.qorpera_assert_surfaces_enabled();
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);

	if coalesce(cardinality(p_change_ids), 0) = 0 then
		raise exception 'At least one change is required' using errcode = '22023';
	end if;

	v_key_info := public.qorpera_surface_reconciliation_key(v_surface, p_change_ids);
	if v_key_info is null then
		raise exception 'No open changes found to reconcile' using errcode = '22023';
	end if;

	if not coalesce(p_retry, false) then
		select * into v_existing
		from public.qorpera_surface_reconciliations r
		where r.surface_id = p_surface_id
			and r.composition_key = (v_key_info ->> 'compositionKey')
			and r.expires_at > clock_timestamp();
		if v_existing.id is not null then
			return public.qorpera_surface_reconciliation_json(v_existing);
		end if;
	end if;

	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, true);
	v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
		p_surface_id, p_change_ids, p_conflict_paths, v_user_id, false, coalesce(p_retry, false)
	);
	return public.qorpera_surface_reconciliation_json(v_rec);
end $$;

select pg_temp.ssr_patch(
	'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
	array[
$old$		'liveHeadSha', p_surface.live_head_sha,$old$,
$new$		'liveHeadSha', p_surface.live_head_sha,
		'folderRevision', p_surface.folder_revision,$new$,
$old$		'needsAttentionCount', coalesce(stats.attention_sessions, 0) + coalesce(change_stats.conflicted_changes, 0),$old$,
$new$		'needsAttentionCount', coalesce(stats.attention_sessions, 0),$new$,
$old$		from public.qorpera_surface_sessions session
		where session.surface_id = p_surface.id$old$,
$new$		from public.qorpera_surface_sessions session
		where session.surface_id = p_surface.id
			and not session.is_internal$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
	array[
$old$					'patchManifest', ch.patch_manifest,$old$,
$new$					'patchManifest', ch.patch_manifest,
					'baseFiles', ch.base_files,$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
	array[
$old$	v_explorations jsonb;
	v_toggled uuid[];$old$,
$new$	v_explorations jsonb;
	v_reconciliations jsonb;
	v_toggled uuid[];$new$,
$old$	from public.qorpera_surface_sessions s
	where s.surface_id = p_surface_id and s.state not in ('completed', 'discarded');$old$,
$new$	from public.qorpera_surface_sessions s
	where s.surface_id = p_surface_id and not s.is_internal and s.state not in ('completed', 'discarded');$new$,
$old$		from public.qorpera_surface_sessions s
		where s.surface_id = p_surface_id and s.state in ('completed', 'discarded')$old$,
$new$		from public.qorpera_surface_sessions s
		where s.surface_id = p_surface_id and not s.is_internal and s.state in ('completed', 'discarded')$new$,
$old$	return jsonb_build_object(
		'surface', public.qorpera_surface_summary_json(v_surface),
		'briefSummary', v_surface.brief_summary,
		'activeSessions', v_active_sessions,
		'recentHistory', v_history_sessions,
		'explorations', v_explorations,
		'previewState', jsonb_build_object($old$,
$new$	select coalesce(
		jsonb_agg(public.qorpera_surface_reconciliation_json(r) order by r.updated_at desc),
		'[]'::jsonb
	)
	into v_reconciliations
	from (
		select *
		from public.qorpera_surface_reconciliations r
		where r.surface_id = p_surface_id
			and r.base_fingerprint = public.qorpera_surface_base_fingerprint(v_surface)
			and r.expires_at > clock_timestamp()
		order by r.updated_at desc
		limit 32
	) r;

	return jsonb_build_object(
		'surface', public.qorpera_surface_summary_json(v_surface),
		'briefSummary', v_surface.brief_summary,
		'activeSessions', v_active_sessions,
		'recentHistory', v_history_sessions,
		'explorations', v_explorations,
		'reconciliations', v_reconciliations,
		'previewState', jsonb_build_object($new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$		'mainSha', v_surface.live_head_sha,$old$,
$new$		'isInternal', v_session.is_internal,
		'folderRevision', v_surface.folder_revision,
		'mainSha', v_surface.live_head_sha,$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure,
	array[
$old$	v_superseded_ids uuid[];
	v_affected_session_ids uuid[];
	v_affected_sid uuid;$old$,
$new$	v_superseded_ids uuid[];
	v_affected_session_ids uuid[];
	v_affected_sid uuid;
	v_patch_manifest jsonb;
	v_base_files jsonb;
	v_rec_id uuid;
	v_rec public.qorpera_surface_reconciliations%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_target_session_id uuid;
	v_now timestamptz := clock_timestamp();$new$,
$old$	select coalesce(max(seq), 0)::smallint + 1 into v_next_seq
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
	returning * into v_change;$old$,
$new$	if coalesce(p_kind, 'git_range') = 'folder_patch'
		and jsonb_typeof(p_patch_manifest) = 'object'
		and jsonb_typeof(p_patch_manifest -> 'ops') = 'array' then
		v_patch_manifest := p_patch_manifest -> 'ops';
		v_base_files := case
			when jsonb_typeof(p_patch_manifest -> 'baseFiles') = 'object' then p_patch_manifest -> 'baseFiles'
			else null
		end;
	else
		v_patch_manifest := p_patch_manifest;
		v_base_files := null;
	end if;

	if v_session.is_internal and v_session.origin_ref ? 'reconciliationId' then
		v_rec_id := (v_session.origin_ref ->> 'reconciliationId')::uuid;
		select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id for update;
		update public.qorpera_surface_reconciliations
		set
			status = 'ready',
			reconciled_patch_manifest = case when coalesce(p_kind, 'git_range') = 'folder_patch' then v_patch_manifest else reconciled_patch_manifest end,
			reconciled_commit_sha = case when coalesce(p_kind, 'git_range') = 'git_range' then p_head_sha else reconciled_commit_sha end,
			error_detail = null,
			updated_at = v_now,
			expires_at = v_now + interval '24 hours'
		where id = v_rec_id
			and surface_id = v_session.surface_id
		returning * into v_rec;

		if v_rec.id is null then
			raise exception 'Surface reconciliation not found' using errcode = 'P0002';
		end if;

		update public.qorpera_surface_sessions
		set
			branch_head_sha = coalesce(p_head_sha, branch_head_sha),
			state = 'completed',
			wake_id = null,
			closed_at = coalesce(closed_at, v_now),
			lease_expires_at = null,
			lease_token = null,
			updated_at = v_now
		where id = p_session_id
		returning * into v_session;

		if v_surface.source_kind = 'code_repo' and v_rec.reconciled_commit_sha is not null then
			update public.qorpera_surface_previews p
			set
				status = 'composing',
				conflict_report = null,
				error_detail = null,
				lease_expires_at = null,
				lease_token = null,
				attempts = 0,
				updated_at = v_now
			where p.surface_id = v_session.surface_id
				and p.status in ('reconciling', 'conflicted')
				and (
					select array_agg(x order by x) from unnest(p.selected_change_ids) as x
				) = (
					select array_agg(y order by y) from unnest(v_rec.selected_change_ids) as y
				);
		end if;

		if v_rec.auto_approve_after
			and v_rec.base_fingerprint = public.qorpera_surface_base_fingerprint(v_surface)
			and not exists (
				select 1 from public.qorpera_surface_jobs j
				where j.surface_id = v_session.surface_id
					and j.kind in ('land_change', 'undo_change')
					and j.status in ('queued', 'running')
					and exists (
						select 1
						from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
						where x::uuid = any(v_rec.selected_change_ids)
					)
			) then
			if (
				select count(*) from public.qorpera_surface_changes ch
				where ch.surface_id = v_session.surface_id
					and ch.id = any(v_rec.selected_change_ids)
					and ch.status in ('staged', 'conflicted')
			) = cardinality(v_rec.selected_change_ids) then
				select ch.session_id into v_target_session_id
				from public.qorpera_surface_changes ch
				where ch.id = v_rec.selected_change_ids[1];

				update public.qorpera_surface_changes
				set status = 'merging', conflict_paths = null
				where surface_id = v_session.surface_id
					and id = any(v_rec.selected_change_ids)
					and status in ('staged', 'conflicted');

				insert into public.qorpera_surface_jobs(
					profile_id, surface_id, session_id, kind, payload, requested_by_user_id
				)
				values (
					v_session.profile_id,
					v_session.surface_id,
					v_target_session_id,
					'land_change',
					jsonb_build_object(
						'changeIds', to_jsonb(v_rec.selected_change_ids),
						'reconciliationId', v_rec.id,
						'autoPublish', v_surface.auto_publish
					),
					v_rec.created_by_user_id
				);
			end if;
		end if;

		return jsonb_build_object(
			'changeId', v_rec.id,
			'seq', 1,
			'reconciled', true,
			'session', public.qorpera_surface_session_json(v_session)
		);
	end if;

	select coalesce(max(seq), 0)::smallint + 1 into v_next_seq
	from public.qorpera_surface_changes
	where session_id = p_session_id;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, affected_paths, diff_stats, patch_manifest, base_files, status
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, v_patch_manifest, v_base_files, 'staged'
	)
	returning * into v_change;$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
	array[
$old$	v_next_state text := p_state;
	v_retry_increment integer := 0;$old$,
$new$	v_next_state text := p_state;
	v_retry_increment integer := 0;
	v_rec_id uuid;
	v_rec_ready boolean := false;$new$,
$old$	if v_session.state not in ('running', 'reconciling_running') then
		raise exception 'Surface session is not running' using errcode = '55000';
	end if;$old$,
$new$	if v_session.is_internal and v_session.origin_ref ? 'reconciliationId' then
		v_rec_id := (v_session.origin_ref ->> 'reconciliationId')::uuid;
		select exists (
			select 1 from public.qorpera_surface_reconciliations r
			where r.id = v_rec_id and r.status = 'ready'
		) into v_rec_ready;
		if v_rec_ready and v_session.state = 'completed' then
			return public.qorpera_surface_session_json(v_session);
		end if;
	end if;
	if v_session.state not in ('running', 'reconciling_running') then
		raise exception 'Surface session is not running' using errcode = '55000';
	end if;$new$,
$old$	if p_state = 'failed' and v_session.retry_count < 1 then$old$,
$new$	if v_rec_id is not null then
		if v_rec_ready then
			v_next_state := 'completed';
		elsif v_session.retry_count < 1 then
			v_next_state := 'reconciling';
			v_retry_increment := 1;
		else
			v_next_state := 'failed';
			perform public.qorpera_surface_fail_reconciliation(v_rec_id, p_reply_text);
		end if;
	elsif p_state = 'failed' and v_session.retry_count < 1 then$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_complete_preview(uuid,text,text,uuid,jsonb,text,uuid)'::regprocedure,
	array[
$old$	v_row public.qorpera_surface_previews%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
begin$old$,
$new$	v_row public.qorpera_surface_previews%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_rec public.qorpera_surface_reconciliations%rowtype;
	v_conflict_paths text[];
	v_next_status text := p_status;
	v_next_conflict jsonb := p_conflict_report;
	v_next_error text := p_error_detail;
begin$new$,
$old$	update public.qorpera_surface_previews
	set
		status = p_status,
		composite_tree_sha = coalesce(p_composite_tree_sha, composite_tree_sha),
		site_version_id = coalesce(p_site_version_id, site_version_id),
		conflict_report = p_conflict_report,
		error_detail = p_error_detail,
		lease_expires_at = null,
		lease_token = null
	where id = p_preview_id
	returning * into v_row;$old$,
$new$	if p_status = 'conflicted'
		and v_surface.source_kind = 'code_repo'
		and v_surface.status = 'active'
		and coalesce(cardinality(v_row.selected_change_ids), 0) >= 1 then
		select coalesce(array_agg(distinct x order by x), '{}'::text[])
		into v_conflict_paths
		from jsonb_array_elements_text(
			case
				when jsonb_typeof(p_conflict_report -> 'paths') = 'array' then p_conflict_report -> 'paths'
				else '[]'::jsonb
			end
		) as x
		where nullif(btrim(x), '') is not null;

		begin
			v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
				v_row.surface_id, v_row.selected_change_ids, v_conflict_paths, null, false, false
			);
			if v_rec.status = 'ready' and v_rec.reconciled_commit_sha is not null and coalesce(v_row.attempts, 0) <= 1 then
				v_next_status := 'composing';
				v_next_conflict := null;
				v_next_error := null;
			elsif v_rec.status in ('queued', 'running') then
				v_next_status := 'reconciling';
				v_next_conflict := null;
				v_next_error := null;
			else
				v_next_status := 'failed';
				v_next_conflict := null;
				v_next_error := coalesce(v_rec.error_detail, 'Couldn''t update preview');
			end if;
		exception when others then
			v_next_status := 'failed';
			v_next_conflict := null;
			v_next_error := 'Couldn''t update preview';
		end;
	end if;

	update public.qorpera_surface_previews
	set
		status = v_next_status,
		composite_tree_sha = coalesce(p_composite_tree_sha, composite_tree_sha),
		site_version_id = coalesce(p_site_version_id, site_version_id),
		conflict_report = v_next_conflict,
		error_detail = v_next_error,
		lease_expires_at = null,
		lease_token = null,
		updated_at = clock_timestamp()
	where id = p_preview_id
	returning * into v_row;$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (
					v_expired_session.profile_id,
					v_expired_session.id,
					'system',
					'Session timed out after worker retry. Reply to retry.'
				);
			end if;$old$,
$new$				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				values (
					v_expired_session.profile_id,
					v_expired_session.id,
					'system',
					'Session timed out after worker retry. Reply to retry.'
				);
				if v_expired_session.is_internal and v_expired_session.origin_ref ? 'reconciliationId' then
					perform public.qorpera_surface_fail_reconciliation(
						(v_expired_session.origin_ref ->> 'reconciliationId')::uuid,
						'Couldn''t update preview'
					);
				end if;
			end if;$new$,
$old$		into v_sessions
		from claimed c
		join public.qorpera_surfaces surf on surf.id = c.surface_id
		left join public.qorpera_company_sites site on site.id = surf.site_id;
	end if;$old$,
$new$		into v_sessions
		from claimed c
		join public.qorpera_surfaces surf on surf.id = c.surface_id
		left join public.qorpera_company_sites site on site.id = surf.site_id;

		if jsonb_array_length(v_sessions) > 0 then
			update public.qorpera_surface_reconciliations r
			set
				status = 'running',
				attempts = r.attempts + 1,
				updated_at = v_now
			where r.status = 'queued'
				and r.session_id in (
					select (elem ->> 'sessionId')::uuid
					from jsonb_array_elements(v_sessions) as elem
				);
		end if;
	end if;$new$,
$old$					'repositoryKey', surf.repository_key,
					'leaseToken', p.lease_token,$old$,
$new$					'repositoryKey', surf.repository_key,
					'leaseToken', p.lease_token,
					'reconciledCommitSha', (
						select r.reconciled_commit_sha
						from public.qorpera_surface_reconciliations r
						where r.surface_id = p.surface_id
							and r.status = 'ready'
							and r.reconciled_commit_sha is not null
							and r.base_fingerprint = public.qorpera_surface_base_fingerprint(surf)
							and r.expires_at > v_now
							and (
								select array_agg(x order by x) from unnest(r.selected_change_ids) as x
							) = (
								select array_agg(y order by y) from unnest(p.selected_change_ids) as y
							)
						order by r.updated_at desc
						limit 1
					),$new$,
$old$								'patchManifest', ch.patch_manifest,
								'affectedPaths', to_jsonb(ch.affected_paths)$old$,
$new$								'patchManifest', ch.patch_manifest,
								'baseFiles', ch.base_files,
								'affectedPaths', to_jsonb(ch.affected_paths)$new$,
$old$				'approvedChanges', coalesce($old$,
$new$				'reconciledPatchManifest', (
					select r.reconciled_patch_manifest
					from public.qorpera_surface_reconciliations r
					where j.kind = 'land_change'
						and surf.source_kind = 'folder'
						and r.surface_id = j.surface_id
						and r.status = 'ready'
						and r.reconciled_patch_manifest is not null
						and r.base_fingerprint = public.qorpera_surface_base_fingerprint(surf)
						and r.expires_at > v_now
						and (
							select array_agg(x order by x) from unnest(r.selected_change_ids) as x
						) = (
							select array_agg(y::uuid order by y::uuid)
							from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as y
						)
					order by r.updated_at desc
					limit 1
				),
				'reconciledCommitSha', (
					select r.reconciled_commit_sha
					from public.qorpera_surface_reconciliations r
					where j.kind = 'land_change'
						and surf.source_kind = 'code_repo'
						and r.surface_id = j.surface_id
						and r.status = 'ready'
						and r.reconciled_commit_sha is not null
						and r.base_fingerprint = public.qorpera_surface_base_fingerprint(surf)
						and r.expires_at > v_now
						and (
							select array_agg(x order by x) from unnest(r.selected_change_ids) as x
						) = (
							select array_agg(y::uuid order by y::uuid)
							from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as y
						)
					order by r.updated_at desc
					limit 1
				),
				'approvedChanges', coalesce($new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
	array[
$old$	v_change_ids uuid[];
	v_merged_count integer := 0;$old$,
$new$	v_change_ids uuid[];
	v_merged_count integer := 0;
	v_rec public.qorpera_surface_reconciliations%rowtype;$new$,
$old$			update public.qorpera_surfaces
			set
				live_head_sha = coalesce(p_main_after, live_head_sha),
				unpublished_change_count = unpublished_change_count + greatest(v_merged_count, 0),
				updated_at = clock_timestamp()
			where id = v_job.surface_id;$old$,
$new$			update public.qorpera_surfaces
			set
				live_head_sha = coalesce(p_main_after, live_head_sha),
				folder_revision = case when source_kind = 'folder' then folder_revision + 1 else folder_revision end,
				unpublished_change_count = unpublished_change_count + greatest(v_merged_count, 0),
				updated_at = clock_timestamp()
			where id = v_job.surface_id;$new$,
$old$		elsif p_status = 'conflicted' then
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
			) affected;$old$,
$new$		elsif p_status = 'conflicted' then
			update public.qorpera_surface_changes
			set
				status = 'staged',
				conflict_paths = null
			where id = any(v_change_ids) and surface_id = v_job.surface_id and status = 'merging';

			if v_surface.status = 'active'
				and v_surface.source_kind in ('folder', 'code_repo')
				and coalesce(cardinality(v_change_ids), 0) > 0
				and not (v_job.payload ? 'reconciliationId') then
				begin
					v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
						v_job.surface_id, v_change_ids, coalesce(p_conflict_paths, '{}'::text[]),
						v_job.requested_by_user_id, true, false
					);
				exception when others then
					v_rec := null;
				end;
				if v_rec.id is not null and v_rec.status = 'ready' and v_rec.updated_at > v_job.created_at then
					update public.qorpera_surface_changes
					set status = 'merging', conflict_paths = null
					where surface_id = v_job.surface_id
						and id = any(v_change_ids)
						and status = 'staged';

					insert into public.qorpera_surface_jobs(
						profile_id, surface_id, session_id, kind, payload, requested_by_user_id
					)
					values (
						v_job.profile_id,
						v_job.surface_id,
						v_job.session_id,
						'land_change',
						jsonb_build_object(
							'changeIds', to_jsonb(v_change_ids),
							'reconciliationId', v_rec.id,
							'autoPublish', coalesce((v_job.payload ->> 'autoPublish')::boolean, v_surface.auto_publish)
						),
						v_job.requested_by_user_id
					);
				elsif v_rec.id is null or v_rec.status in ('failed', 'ready') then
					insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
					select distinct
						v_job.profile_id,
						affected.sid,
						'system',
						'Could not apply this change automatically. Try approving again.'
					from (
						select v_job.session_id as sid where v_job.session_id is not null
						union
						select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
					) affected;
				end if;
			else
				insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
				select distinct
					v_job.profile_id,
					affected.sid,
					'system',
					'Could not apply this change automatically. Try approving again.'
				from (
					select v_job.session_id as sid where v_job.session_id is not null
					union
					select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
				) affected;
			end if;$new$,
$old$		if p_status = 'landed' then
			if p_main_after is not null then
				update public.qorpera_surfaces
				set live_head_sha = p_main_after, updated_at = clock_timestamp()
				where id = v_job.surface_id;
			end if;$old$,
$new$		if p_status = 'landed' then
			if p_main_after is not null or v_surface.source_kind = 'folder' then
				update public.qorpera_surfaces
				set
					live_head_sha = coalesce(p_main_after, live_head_sha),
					folder_revision = case when source_kind = 'folder' then folder_revision + 1 else folder_revision end,
					updated_at = clock_timestamp()
				where id = v_job.surface_id;
			end if;$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_update_rebased_changes(uuid,uuid,text,jsonb,uuid,text[])'::regprocedure,
	array[
$old$	if p_conflicted_change_id is not null then
		update public.qorpera_surface_changes c
		set
			status = 'conflicted',
			conflict_paths = coalesce(p_conflict_paths, '{}')
		where c.id = p_conflicted_change_id
			and c.surface_id = p_surface_id
			and c.session_id = p_session_id
			and c.status in ('staged', 'conflicted');
	end if;$old$,
$new$	if p_conflicted_change_id is not null then
		update public.qorpera_surface_changes c
		set
			status = 'staged',
			conflict_paths = null
		where c.id = p_conflicted_change_id
			and c.surface_id = p_surface_id
			and c.session_id = p_session_id
			and c.status in ('staged', 'conflicted');
		if v_surface.status = 'active' then
			begin
				perform public.qorpera_surface_enqueue_silent_reconciliation(
					p_surface_id, array[p_conflicted_change_id], coalesce(p_conflict_paths, '{}'::text[]), null, false, false
				);
			exception when others then
				null;
			end;
		end if;
	end if;$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
	array[
$old$			if v_session.state = 'reconciling_running' or v_session.origin_label = 'Conflict reconciliation' then$old$,
$new$			if v_session.state = 'reconciling_running' or v_session.origin_label in ('Conflict reconciliation', 'Silent reconciliation') then$new$,
$old$			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.',$old$,
$new$			if v_session.is_internal and v_session.origin_ref ? 'reconciliationId' then
				v_goal := public.qorpera_surface_utf8_left(
					v_goal || E'\nNon-interactive automatic reconciliation: preserve all compatible changes from every listed change. If two changes directly contradict on the exact same choice, prefer the newer change. Never call coding_ask.',
					2000
				);
			end if;
			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', case
					when v_session.is_internal and v_session.origin_ref ? 'reconciliationId'
					then 'Integrate all listed staged changes onto main cleanly (newer intent wins on direct contradictions), verify builds/checks, commit once, call coding_record_change, and finish with coding_finish. Never call coding_ask.'
					else 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.'
				end,$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_reconcile_surface_changes(uuid,uuid[])'::regprocedure,
	array[
$old$					'changeId', ch.id,
					'title', ch.title,
					'sessionId', ch.session_id,
					'branch', cs.branch,
					'parentSha', ch.parent_sha,
					'headSha', ch.head_sha,
					'conflictPaths', to_jsonb(coalesce(ch.conflict_paths, '{}'::text[]))$old$,
$new$					'changeId', ch.id,
					'title', ch.title,
					'summary', ch.summary,
					'kind', ch.kind,
					'prompt', s.prompt,
					'createdAt', ch.created_at,
					'sessionId', ch.session_id,
					'branch', cs.branch,
					'parentSha', ch.parent_sha,
					'headSha', ch.head_sha,
					'patchManifest', ch.patch_manifest,
					'baseFiles', ch.base_files,
					'affectedPaths', to_jsonb(coalesce(ch.affected_paths, '{}'::text[])),
					'conflictPaths', to_jsonb(coalesce(ch.conflict_paths, '{}'::text[]))$new$
	]
);

select pg_temp.ssr_patch(
	'public.qorpera_surface_remove(uuid,boolean)'::regprocedure,
	array[
$old$	delete from public.qorpera_surface_publish_asks where surface_id = p_surface_id;$old$,
$new$	update public.qorpera_surface_reconciliations
	set status = 'failed', error_detail = 'The interface was deleted', updated_at = v_now
	where surface_id = p_surface_id and status in ('queued', 'running');

	delete from public.qorpera_surface_publish_asks where surface_id = p_surface_id;$new$
	]
);

do $$ begin
	if to_regprocedure('public.qorpera_live_hint_internal()') is not null then
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_reconciliations
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
	end if;
end $$;

revoke all on function
	public.qorpera_surface_base_fingerprint(public.qorpera_surfaces),
	public.qorpera_surface_reconciliation_json(public.qorpera_surface_reconciliations),
	public.qorpera_surface_reconciliation_key(public.qorpera_surfaces, uuid[]),
	public.qorpera_surface_fail_reconciliation(uuid, text),
	public.qorpera_surface_enqueue_silent_reconciliation(uuid, uuid[], text[], uuid, boolean, boolean),
	public.qorpera_ensure_surface_reconciliation(uuid, uuid[], text[], boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_ensure_surface_reconciliation(uuid, uuid[], text[], boolean)
	to authenticated;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
			'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
			'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
			'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
			'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)'::regprocedure,
			'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
			'public.qorpera_surface_complete_preview(uuid,text,text,uuid,jsonb,text,uuid)'::regprocedure,
			'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
			'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
			'public.qorpera_surface_update_rebased_changes(uuid,uuid,text,jsonb,uuid,text[])'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
			'public.qorpera_reconcile_surface_changes(uuid,uuid[])'::regprocedure,
			'public.qorpera_surface_remove(uuid,boolean)'::regprocedure,
			'public.qorpera_ensure_surface_reconciliation(uuid,uuid[],text[],boolean)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Silent reconciliation function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_base_fingerprint(public.qorpera_surfaces), public.qorpera_surface_reconciliation_json(public.qorpera_surface_reconciliations), public.qorpera_surface_reconciliation_key(public.qorpera_surfaces, uuid[]), public.qorpera_surface_fail_reconciliation(uuid, text), public.qorpera_surface_enqueue_silent_reconciliation(uuid, uuid[], text[], uuid, boolean, boolean) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join ssr_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930888000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.ssr_patch(regprocedure, text[]);
drop table ssr_before;
