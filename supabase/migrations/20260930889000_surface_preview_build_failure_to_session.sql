-- WHY: A preview or publish build of a code interface that failed in the code (not for hours or a machine) goes back
-- to the session whose change broke it, as an agent follow-up turn through the normal surface session wake, at most
-- three times in a row; the member keeps the last preview that built, marked as being fixed.

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_preview_builds') is null
		or to_regprocedure('public.qorpera_complete_surface_preview_build(uuid,uuid,uuid,text,text,text)') is null
		or to_regprocedure('public.qorpera_surface_preview_builds_sweep(timestamptz)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_session_run(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_get_surface_workspace(uuid)') is null
		or to_regprocedure('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)') is null
		or to_regprocedure('public.qorpera_surface_summary_json(public.qorpera_surfaces)') is null
		or to_regprocedure('public.qorpera_site_preview_domain()') is null
		or to_regprocedure('public.qorpera_surface_utf8_left(text,integer)') is null then
		raise exception 'Surface preview build failure to session (20260930889000) requires 20260930876000 and 20260930878000 first';
	end if;
	if to_regclass('public.qorpera_surface_build_handbacks') is not null then
		raise exception 'Surface preview build failure to session (20260930889000) is already applied';
	end if;
end $$;

create function pg_temp.sbfs_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930889000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930889000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create table public.qorpera_surface_build_handbacks (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	build_id uuid not null unique references public.qorpera_surface_preview_builds(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	change_id uuid references public.qorpera_surface_changes(id) on delete set null,
	kind text not null check (kind in ('preview', 'publish')),
	state text not null check (state in ('pending', 'queued', 'delivered', 'superseded', 'capped', 'stale')),
	fix_number smallint not null check (fix_number between 1 and 4),
	followup text not null check (octet_length(followup) between 1 and 4000),
	worker_id uuid,
	worker_sequence integer,
	created_at timestamptz not null default clock_timestamp(),
	queued_at timestamptz,
	delivered_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	check ((state = 'capped') = (fix_number = 4)),
	check ((state = 'delivered') = (worker_sequence is not null and worker_id is not null and delivered_at is not null)),
	check (state not in ('queued', 'delivered') or queued_at is not null)
);
create index qorpera_surface_build_handbacks_session on public.qorpera_surface_build_handbacks(session_id, state);
create index qorpera_surface_build_handbacks_open on public.qorpera_surface_build_handbacks(surface_id, kind)
	where state in ('pending', 'queued', 'delivered');
alter table public.qorpera_surface_build_handbacks enable row level security;
revoke all on public.qorpera_surface_build_handbacks from public, anon, authenticated, service_role, qorpera_secret_broker;

-- WHY: Who broke a failed build: for a preview, the newest open change in its composition that the member's last
-- preview that built did not hold; for a publish, the change that landed last since the site was published. Its
-- session gets the build once (one row per build), unless three fix turns in a row already went to it.
create function public.qorpera_surface_build_hand_back(p_build_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_preview public.qorpera_surface_previews%rowtype;
	v_ready public.qorpera_surface_previews%rowtype;
	v_job public.qorpera_surface_jobs%rowtype;
	v_change public.qorpera_surface_changes%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_kind text;
	v_fix integer;
	v_state text;
	v_now timestamptz := clock_timestamp();
begin
	select * into v_build from public.qorpera_surface_preview_builds where id = p_build_id;
	if v_build.id is null or v_build.state <> 'failed'
		or split_part(coalesce(v_build.error_detail, ''), E'\n', 1) not in ('PREVIEW_BUILD_FAILED', 'PREVIEW_BUILD_TOO_LARGE')
		or exists (select 1 from public.qorpera_surface_build_handbacks h where h.build_id = v_build.id) then
		return;
	end if;

	select * into v_preview from public.qorpera_surface_previews p
	where p.build_id = v_build.id and p.status = 'failed'
	order by p.updated_at desc, p.id
	limit 1;
	if v_preview.id is not null then
		v_kind := 'preview';
		select * into v_ready from public.qorpera_surface_previews r
		where r.surface_id = v_preview.surface_id and r.status = 'ready' and r.id <> v_preview.id
			and r.requested_by_user_id is not distinct from v_preview.requested_by_user_id
		order by r.updated_at desc, r.id
		limit 1;
		select c.* into v_change
		from public.qorpera_surface_changes c
		where c.surface_id = v_preview.surface_id
			and c.status in ('staged', 'conflicted')
			and (c.id = any(v_preview.selected_change_ids) or c.session_id = v_preview.exploration_session_id)
		order by c.id = any(coalesce(v_ready.selected_change_ids, '{}'::uuid[])), c.created_at desc, c.seq desc
		limit 1;
	else
		select * into v_job from public.qorpera_surface_jobs j
		where j.build_id = v_build.id and j.kind = 'publish_surface' and j.status = 'failed'
		order by j.updated_at desc, j.id
		limit 1;
		if v_job.id is null then
			return;
		end if;
		v_kind := 'publish';
		select c.* into v_change
		from public.qorpera_surface_changes c
		where c.surface_id = v_job.surface_id and c.status = 'merged' and c.published_at is null
		order by c.landed_change_number desc nulls last, c.resolved_at desc nulls last, c.created_at desc
		limit 1;
	end if;
	if v_change.id is null then
		return;
	end if;
	select * into v_session from public.qorpera_surface_sessions where id = v_change.session_id for update;
	if v_session.worker_id is null or v_session.state = 'discarded' then
		return;
	end if;

	select least(count(*) + 1, 4) into v_fix
	from public.qorpera_surface_build_handbacks h
	where h.session_id = v_session.id and h.state = 'delivered'
		and h.worker_sequence > coalesce((
			select max(t.sequence)
			from public.qorpera_coding_session_turns t
			where t.worker_id = v_session.worker_id
				and not exists (
					select 1 from public.qorpera_surface_build_handbacks f
					where f.session_id = v_session.id and f.state = 'delivered'
						and f.worker_id = t.worker_id and f.worker_sequence = t.sequence
				)
		), 0);

	if v_fix > 3 then
		v_state := 'capped';
	else
		v_state := case
			when v_session.state in ('queued', 'running') and exists (
				select 1 from public.qorpera_surface_build_handbacks h where h.session_id = v_session.id and h.state = 'queued'
			) then 'queued'
			else 'pending'
		end;
		perform 1 from public.qorpera_surface_build_handbacks h
		where h.session_id = v_session.id and h.state in ('pending', 'queued')
		order by h.id
		for update;
		update public.qorpera_surface_build_handbacks
		set state = 'superseded', updated_at = v_now
		where session_id = v_session.id and state in ('pending', 'queued');
	end if;

	insert into public.qorpera_surface_build_handbacks(
		profile_id, surface_id, build_id, session_id, change_id, kind, state, fix_number, followup, queued_at
	)
	values (
		v_build.profile_id, v_build.surface_id, v_build.id, v_session.id, v_change.id, v_kind, v_state, v_fix,
		public.qorpera_surface_utf8_left(
			case v_kind
				when 'preview' then 'The platform could not build the interface preview with your staged change "'
					|| v_change.title || '" in it, so members keep seeing the last preview that built.'
				else 'The platform could not build the interface to publish it after your change "'
					|| v_change.title || '" landed on main, so the live site still shows the version published before.'
			end
			|| E'\n\nWhat the build reported:\n' || v_build.error_detail
			|| E'\n\nFix the build in this session: change the code on your branch until the project''s preview recipe in '
			|| case v_kind when 'publish' then '.qorpera/checks.json builds on top of the current main' else '.qorpera/checks.json builds' end
			|| ' (run it yourself to check), commit, stage the fix with coding_record_change, and finish with coding_finish. '
			|| 'This is automatic fix ' || least(v_fix, 3) || ' of 3.',
			3900
		),
		case when v_state = 'queued' then v_now end
	);
end $$;

-- WHY: A waiting hand-back reaches its session once the session's own turn is over (never mid-turn, never over a
-- question the member has not answered): the session is queued like a member reply, and the sessions lane wakes it.
create function public.qorpera_surface_build_handbacks_deliver(p_now timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_handback public.qorpera_surface_build_handbacks%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
begin
	for v_handback in
		select * from public.qorpera_surface_build_handbacks h
		where h.state = 'pending'
		order by h.created_at, h.id
		limit 8
		for update skip locked
	loop
		begin
			v_session := null;
			v_worker := null;
			select * into v_session from public.qorpera_surface_sessions where id = v_handback.session_id for update skip locked;
			if v_session.id is null then
				continue;
			end if;
			select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
			if v_session.state = 'discarded'
				or v_worker.id is null
				or v_worker.sequence >= 64
				or v_handback.created_at <= p_now - interval '1 day'
				or exists (
					select 1 from public.qorpera_surface_changes c
					where c.session_id = v_session.id and c.created_at > v_handback.created_at
				)
				or (v_handback.kind = 'preview' and not exists (
					select 1 from public.qorpera_surface_changes c
					where c.id = v_handback.change_id and c.status in ('staged', 'conflicted')
				))
				or (v_handback.kind = 'publish' and not exists (
					select 1 from public.qorpera_surfaces s where s.id = v_handback.surface_id and s.publish_status = 'failed'
				)) then
				update public.qorpera_surface_build_handbacks set state = 'stale', updated_at = p_now where id = v_handback.id;
				continue;
			end if;
			if v_session.state not in ('ready', 'failed', 'completed') or v_worker.state = 'active' then
				continue;
			end if;
			update public.qorpera_surface_sessions
			set
				state = 'queued',
				question = null,
				closed_at = null,
				lease_expires_at = null,
				lease_token = null,
				wake_id = null,
				retry_count = 0,
				updated_at = p_now
			where id = v_session.id;
			update public.qorpera_surface_build_handbacks
			set state = 'queued', queued_at = p_now, updated_at = p_now
			where id = v_handback.id;
		exception when others then
			null;
		end;
	end loop;
end $$;

-- WHY: The session's turn takes the newest queued hand-back as its follow-up ({followup}); a member who wrote since or
-- a reconciliation goes first (null: the turn runs as before). A hand-back gone stale while queued gives {dropped}
-- when no member message waits, so the session was queued for the fix alone and no turn may open.
create function public.qorpera_surface_build_fix_take(
	p_session public.qorpera_surface_sessions,
	p_worker_id uuid,
	p_sequence integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_handback public.qorpera_surface_build_handbacks%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	perform 1 from public.qorpera_surface_build_handbacks h
	where h.session_id = p_session.id and h.state = 'queued'
	order by h.id
	for update;
	select * into v_handback from public.qorpera_surface_build_handbacks h
	where h.session_id = p_session.id and h.state = 'queued'
	order by h.queued_at desc, h.id desc
	limit 1;
	if v_handback.id is null then
		return null;
	end if;
	if p_session.state = 'reconciling_running'
		or exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = p_session.id and m.author_kind = 'member' and m.created_at > v_handback.queued_at
		) then
		update public.qorpera_surface_build_handbacks
		set state = 'superseded', updated_at = v_now
		where session_id = p_session.id and state = 'queued';
		return null;
	end if;
	update public.qorpera_surface_build_handbacks
	set state = 'superseded', updated_at = v_now
	where session_id = p_session.id and state = 'queued' and id <> v_handback.id;
	if v_handback.queued_at <= v_now - interval '1 day'
		or exists (
			select 1 from public.qorpera_surface_changes c
			where c.session_id = p_session.id and c.created_at > v_handback.queued_at
		)
		or (v_handback.kind = 'preview' and not exists (
			select 1 from public.qorpera_surface_changes c
			where c.id = v_handback.change_id and c.status in ('staged', 'conflicted')
		))
		or (v_handback.kind = 'publish' and not exists (
			select 1 from public.qorpera_surfaces s where s.id = v_handback.surface_id and s.publish_status = 'failed'
		)) then
		update public.qorpera_surface_build_handbacks set state = 'stale', updated_at = v_now where id = v_handback.id;
		if exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = p_session.id and m.author_kind = 'member'
				and m.created_at > coalesce((
					select max(t.created_at) from public.qorpera_coding_session_turns t where t.worker_id = p_worker_id
				), '-infinity'::timestamptz)
		) then
			return null;
		end if;
		return jsonb_build_object('dropped', true);
	end if;
	update public.qorpera_surface_build_handbacks
	set state = 'delivered', worker_id = p_worker_id, worker_sequence = p_sequence, delivered_at = v_now, updated_at = v_now
	where id = v_handback.id;
	return jsonb_build_object('followup', v_handback.followup);
end $$;

create function public.qorpera_surface_build_handback_open(p_handback public.qorpera_surface_build_handbacks)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_handback.state = 'pending' or (
		p_handback.state in ('queued', 'delivered') and exists (
			select 1
			from public.qorpera_surface_sessions s
			join public.qorpera_runtime_workers w on w.id = s.worker_id
			where s.id = p_handback.session_id
				and s.state in ('queued', 'running')
				and (p_handback.state = 'queued' or (w.id = p_handback.worker_id and w.sequence = p_handback.worker_sequence))
		)
	)
$$;

create function public.qorpera_surface_preview_being_fixed(p_preview public.qorpera_surface_previews)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce(p_preview.status = 'failed', false) and exists (
		select 1
		from public.qorpera_surface_build_handbacks h
		where h.surface_id = p_preview.surface_id and h.kind = 'preview'
			and h.state in ('pending', 'queued', 'delivered')
			and public.qorpera_surface_build_handback_open(h)
			and exists (
				select 1 from public.qorpera_surface_changes c
				where c.session_id = h.session_id
					and (c.id = any(p_preview.selected_change_ids) or c.session_id = p_preview.exploration_session_id)
			)
	)
$$;

create function public.qorpera_surface_preview_kept_frame(
	p_preview public.qorpera_surface_previews,
	p_user_id uuid,
	p_site public.qorpera_company_sites
)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'previewId', kept.id,
		'doorActionUrl', 'https://' || p_site.slug || '--p' || kept.short_host_id || '.' || public.qorpera_site_preview_domain()
			|| '/__qorpera/member',
		'memberPass', null
	)
	from public.qorpera_surface_previews kept
	where p_preview.status = 'failed' and p_site.id is not null
		and kept.surface_id = p_preview.surface_id and kept.id <> p_preview.id
		and kept.status = 'ready' and kept.expires_at > clock_timestamp()
		and kept.requested_by_user_id = p_user_id
	order by kept.updated_at desc, kept.id
	limit 1
$$;

select pg_temp.sbfs_patch('public.qorpera_complete_surface_preview_build(uuid,uuid,uuid,text,text,text)'::regprocedure, array[
$old$			perform public.qorpera_surface_preview_build_fail(v_build.id, p_error_detail);$old$,
$new$			perform public.qorpera_surface_preview_build_fail(v_build.id, p_error_detail);
			perform public.qorpera_surface_build_hand_back(v_build.id);$new$
]);

select pg_temp.sbfs_patch('public.qorpera_surface_preview_builds_sweep(timestamptz)'::regprocedure, array[
$old$	for v_build in
		select * from public.qorpera_surface_preview_builds b
		where b.state = 'queued' and b.queued_at <= p_now - interval '10 minutes'$old$,
$new$	perform public.qorpera_surface_build_handbacks_deliver(p_now);

	for v_build in
		select * from public.qorpera_surface_preview_builds b
		where b.state = 'queued' and b.queued_at <= p_now - interval '10 minutes'$new$
]);

select pg_temp.sbfs_patch('public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure, array[
$old$	v_followup text;
$old$,
$new$	v_followup text;
	v_build_fix jsonb;
$new$,
$old$			v_followup := public.qorpera_surface_utf8_left(v_followup, 2000);

			update public.qorpera_runtime_workers$old$,
$new$			v_followup := public.qorpera_surface_utf8_left(v_followup, 2000);
			v_build_fix := public.qorpera_surface_build_fix_take(v_session, v_worker.id, v_worker.sequence + 1);
			if v_build_fix ? 'dropped' then
				-- WHY: The session was queued for a fix that went stale; it opens no turn, and lease_lost ends the job quietly.
				update public.qorpera_surface_sessions
				set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null, updated_at = v_now
				where id = v_session.id;
				return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
			end if;
			if v_build_fix ? 'followup' then
				v_followup := v_build_fix ->> 'followup';
				v_member_initiated := false;
			end if;

			update public.qorpera_runtime_workers$new$
]);

select pg_temp.sbfs_patch('public.qorpera_get_surface_workspace(uuid)'::regprocedure, array[
$old$'errorDetail', v_preview.error_detail$old$,
$new$'errorDetail', v_preview.error_detail,
				'kept', public.qorpera_surface_preview_kept_frame(v_preview, v_user_id, v_site),
				'fixing', public.qorpera_surface_preview_being_fixed(v_preview)$new$
]);

select pg_temp.sbfs_patch('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure, array[
$old$'errorDetail', v_preview.error_detail$old$,
$new$'errorDetail', v_preview.error_detail,
			'kept', public.qorpera_surface_preview_kept_frame(v_preview, v_user_id, v_site),
			'fixing', public.qorpera_surface_preview_being_fixed(v_preview)$new$
]);

select pg_temp.sbfs_patch('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure, array[
$old$		'lastPublishError', p_surface.last_publish_error,$old$,
$new$		'lastPublishError', p_surface.last_publish_error,
		'publishBeingFixed', coalesce(p_surface.publish_status = 'failed', false) and exists (
			select 1 from public.qorpera_surface_build_handbacks h
			where h.surface_id = p_surface.id and h.kind = 'publish' and h.state in ('pending', 'queued', 'delivered')
				and public.qorpera_surface_build_handback_open(h)
		),$new$
]);

drop function pg_temp.sbfs_patch(regprocedure, text[]);

do $$ begin
	if to_regprocedure('public.qorpera_live_hint_internal()') is not null then
		create constraint trigger qorpera_live_hint after insert or update or delete on public.qorpera_surface_build_handbacks
			deferrable initially deferred for each row execute function public.qorpera_live_hint_internal('surfaces');
	end if;
end $$;

revoke all on function
	public.qorpera_surface_build_hand_back(uuid),
	public.qorpera_surface_build_handbacks_deliver(timestamptz),
	public.qorpera_surface_build_fix_take(public.qorpera_surface_sessions, uuid, integer),
	public.qorpera_surface_build_handback_open(public.qorpera_surface_build_handbacks),
	public.qorpera_surface_preview_being_fixed(public.qorpera_surface_previews),
	public.qorpera_surface_preview_kept_frame(public.qorpera_surface_previews, uuid, public.qorpera_company_sites)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_complete_surface_preview_build(uuid,uuid,uuid,text,text,text)'::regprocedure,
			'public.qorpera_surface_preview_builds_sweep(timestamptz)'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
			'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
			'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
			'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Patched surface build function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_build_hand_back(uuid), public.qorpera_surface_build_handbacks_deliver(timestamptz), public.qorpera_surface_build_fix_take(public.qorpera_surface_sessions, uuid, integer), public.qorpera_surface_build_handback_open(public.qorpera_surface_build_handbacks), public.qorpera_surface_preview_being_fixed(public.qorpera_surface_previews), public.qorpera_surface_preview_kept_frame(public.qorpera_surface_previews, uuid, public.qorpera_company_sites) to %I',
			v_owner
		);
	end loop;
end $$;
