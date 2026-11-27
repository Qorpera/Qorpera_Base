set local lock_timeout = '3s';

alter table public.qorpera_surface_sessions
	add column turn_member_initiated boolean;

alter table public.qorpera_surface_session_messages
	add column author_label text check (author_label is null or char_length(author_label) <= 120),
	drop constraint qorpera_surface_session_messages_author_kind_check,
	add constraint qorpera_surface_session_messages_author_kind_check
		check (author_kind in ('member', 'session', 'system', 'note', 'agent'));

create table public.qorpera_surface_escalations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	reason text not null check (reason in ('needs_input', 'failed', 'conflict')),
	summary text not null check (char_length(summary) <= 4000),
	question jsonb,
	wake_id uuid references public.qorpera_wake_occurrences(id) on delete set null,
	resolved_at timestamptz,
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_surface_escalations_session_idx
	on public.qorpera_surface_escalations(session_id, created_at desc);
alter table public.qorpera_surface_escalations enable row level security;
revoke all on public.qorpera_surface_escalations
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check' and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	if not ('surface-session' = any (v_kinds)) or 'surface-escalation' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format('alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
		check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality) from unnest(v_kinds || array['surface-escalation'])
			with ordinality as listed(kind, ordinality)));
end $$;

-- WHY: Gate new surface-escalation wakes on active runtime bundle support so older live runners never receive an unparseable wake source kind.
create function public.qorpera_surface_escalation_ready()
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton
			and bundle.manifest -> 'implementation' ? 'packages/runtime/src/cloud-surface-escalation-wake.ts'
	)
$$;
revoke all on function public.qorpera_surface_escalation_ready()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_emit_cofounder_escalation(
	p_session_id uuid,
	p_reason text,
	p_summary text,
	p_question jsonb default null
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_cofounder public.qorpera_company_cofounders%rowtype;
	v_esc public.qorpera_surface_escalations%rowtype;
	v_wake_id uuid;
	v_now timestamptz := clock_timestamp();
	v_text text := left(coalesce(nullif(btrim(coalesce(p_summary, '')), ''), 'Surface session needs guidance.'), 4000);
begin
	if p_reason not in ('needs_input', 'failed', 'conflict') then
		return null;
	end if;
	if not public.qorpera_surface_escalation_ready() then
		return null;
	end if;
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null or not public.qorpera_company_is_folder_v2(v_session.profile_id) then
		return null;
	end if;
	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id and profile_id = v_session.profile_id;
	select * into v_cofounder from public.qorpera_company_cofounders where profile_id = v_session.profile_id limit 1;
	if v_surface.id is null or v_cofounder.staff_agent_id is null then
		return null;
	end if;

	insert into public.qorpera_surface_escalations(profile_id, surface_id, session_id, reason, summary, question)
	values (v_session.profile_id, v_surface.id, v_session.id, p_reason, v_text, p_question)
	returning * into v_esc;

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
			'surface-escalation',
			v_esc.id,
			'surface-escalation',
			'surface-escalation:' || v_esc.id::text,
			v_now,
			v_now
		)
		returning id into v_wake_id;

		update public.qorpera_surface_escalations
		set wake_id = v_wake_id
		where id = v_esc.id;
	exception when others then
		raise warning 'qorpera_surface_emit_cofounder_escalation failed for escalation %: % (%)', v_esc.id, sqlerrm, sqlstate;
		return v_esc.id;
	end;

	return v_esc.id;
end $$;
revoke all on function public.qorpera_surface_emit_cofounder_escalation(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_native_surface_steer_session(
	p_profile_id uuid,
	p_session_id uuid,
	p_message text,
	p_origin_label text default 'Co-Founder',
	p_change_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_body text := btrim(coalesce(p_message, ''));
	v_origin_label text := left(coalesce(nullif(btrim(coalesce(p_origin_label, '')), ''), 'Co-Founder'), 120);
begin
	if p_profile_id is null or p_session_id is null or char_length(v_body) < 1 or char_length(v_body) > 16000 then
		raise exception 'Surface session steering requires sessionId and message (1..16000 chars)' using errcode = '22023';
	end if;

	select * into v_peek
	from public.qorpera_surface_sessions
	where id = p_session_id and profile_id = p_profile_id;
	if v_peek.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	if v_peek.state = 'discarded' or coalesce(v_peek.is_internal, false) then
		raise exception 'Cannot steer a discarded or internal surface session' using errcode = '55000';
	end if;
	if v_peek.state not in ('needs_input', 'failed')
		and not exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.session_id = v_peek.id and ch.status = 'conflicted'
		)
		and not exists (
			select 1 from public.qorpera_surface_escalations e
			where e.session_id = v_peek.id and e.resolved_at is null
		) then
		raise exception 'Only paused, failed, or conflicted surface sessions can be steered' using errcode = '55000';
	end if;

	if v_peek.worker_id is not null then
		perform public.qorpera_surface_cancel_coding_workers(array[p_session_id], 'surface_superseded');
	end if;

	select * into v_session
	from public.qorpera_surface_sessions
	where id = p_session_id and profile_id = p_profile_id
	for update;
	if v_session.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	if v_session.state = 'discarded' or coalesce(v_session.is_internal, false) then
		raise exception 'Cannot steer a discarded or internal surface session' using errcode = '55000';
	end if;
	if v_session.state not in ('needs_input', 'failed')
		and not exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.session_id = v_session.id and ch.status = 'conflicted'
		)
		and not exists (
			select 1 from public.qorpera_surface_escalations e
			where e.session_id = v_session.id and e.resolved_at is null
		) then
		raise exception 'Only paused, failed, or conflicted surface sessions can be steered' using errcode = '55000';
	end if;

	if p_change_id is not null and not exists (
		select 1 from public.qorpera_surface_changes ch
		where ch.id = p_change_id
			and ch.session_id = p_session_id
			and ch.profile_id = v_session.profile_id
	) then
		raise exception 'Surface change not found in session' using errcode = '22023';
	end if;

	insert into public.qorpera_surface_session_messages(
		profile_id, session_id, author_kind, author_user_id, author_label, body, change_id
	)
	values (v_session.profile_id, p_session_id, 'agent', null, v_origin_label, v_body, p_change_id);

	update public.qorpera_surface_escalations
	set resolved_at = clock_timestamp()
	where session_id = p_session_id and resolved_at is null;

	update public.qorpera_surface_sessions
	set
		state = 'queued',
		question = null,
		closed_at = null,
		lease_expires_at = null,
		lease_token = null,
		wake_id = case when worker_id is not null then null else wake_id end,
		turn_requested_by_user_id = null,
		turn_member_initiated = false,
		retry_count = 0,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_native_surface_steer_session(uuid, uuid, text, text, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_steer_session(uuid, uuid, text, text, uuid)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_native_surface_steer_session', 'profile')
on conflict (name) do nothing;

create temp table surf_esc_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
		'public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)'::regprocedure,
		'public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions)'::regprocedure,
		'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
		'public.qorpera_reply_surface_session(uuid,text,boolean,uuid)'::regprocedure,
		'public.qorpera_surface_reply_target_change_id(uuid)'::regprocedure,
		'public.qorpera_surface_build_fix_take(public.qorpera_surface_sessions,uuid,integer)'::regprocedure,
		'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
		'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
		'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
		'public.qorpera_pin_wake_occurrence()'::regprocedure,
		'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
		'public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
		'public.qorpera_folder_read_wake(jsonb)'::regprocedure,
		'public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
		'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure
	]);

create or replace function pg_temp.surf_esc_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930922000' in v_definition) > 0 then
		raise exception '20260930922000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930922000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 100); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.surf_esc_patch('public.qorpera_record_runtime_observation(uuid,jsonb)', array[
	$old$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',/* 20260930913000 */'inspect_surface','stage_surface_artifact','compose_surface_layout',$old$,
	$new$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',/* 20260930913000 */'inspect_surface','stage_surface_artifact','compose_surface_layout',/* WHY: 20260930922000 admits Co-Founder surface steering tool observations */'steer_surface_session',$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)', array[
	$old$select coalesce(p_session.turn_requested_by_user_id, p_session.created_by_user_id)$old$,
	$new$select case
		when p_session.turn_member_initiated is false then null::uuid /* WHY: 20260930922000 clears member requester on agent-steered turns */
		else coalesce(p_session.turn_requested_by_user_id, p_session.created_by_user_id)
	end$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions)', array[
	$old$	select p_session.id is not null and (
		p_session.turn_requested_by_user_id is not null
		or (p_session.origin_kind in ('member', 'point_to_change', 'cross_surface') and p_session.created_by_user_id is not null)
	)$old$,
	$new$	select p_session.id is not null and (
		case
			when p_session.turn_member_initiated is not null then p_session.turn_member_initiated /* WHY: 20260930922000 honors explicit agent-steered vs member-reply turns */
			else p_session.turn_requested_by_user_id is not null
				or (p_session.origin_kind in ('member', 'point_to_change', 'cross_surface') and p_session.created_by_user_id is not null)
		end
	)$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_session_json(public.qorpera_surface_sessions)', array[
	$old$				'authorUserId', m.author_user_id,$old$,
	$new$				'authorUserId', m.author_user_id,
				'authorLabel', m.author_label, /* WHY: 20260930922000 exposes agent steering attribution */$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_reply_surface_session(uuid,text,boolean,uuid)', array[
	$old$		wake_id = case when worker_id is not null then null else wake_id end,
		turn_requested_by_user_id = v_user_id,
$old$,
	$new$		wake_id = case when worker_id is not null then null else wake_id end,
		turn_requested_by_user_id = v_user_id,
		turn_member_initiated = true, /* WHY: 20260930922000 restores member-initiated status on member replies */
$new$,
	$old$	return public.qorpera_surface_session_json(v_session);$old$,
	$new$	update public.qorpera_surface_escalations
	set resolved_at = clock_timestamp()
	where session_id = p_session_id and resolved_at is null;

	return public.qorpera_surface_session_json(v_session);$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_reply_target_change_id(uuid)', array[
	$old$	from public.qorpera_surface_session_messages m
	where m.session_id = p_session_id
		and m.author_kind = 'member'$old$,
	$new$	from public.qorpera_surface_session_messages m
	where m.session_id = p_session_id
		and m.author_kind in ('member', 'agent') /* WHY: 20260930922000 honors agent steering change targeting */$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_build_fix_take(public.qorpera_surface_sessions,uuid,integer)', array[
	$old$where m.session_id = p_session.id and m.author_kind = 'member' and m.created_at > v_handback.queued_at$old$,
	$new$where m.session_id = p_session.id and m.author_kind in ('member', 'agent') /* WHY: 20260930922000 lets agent steering supersede queued build fixes */ and m.created_at > v_handback.queued_at$new$,
	$old$			where m.session_id = p_session.id and m.author_kind = 'member'
				and m.created_at > coalesce(($old$,
	$new$			where m.session_id = p_session.id and m.author_kind in ('member', 'agent')
				and m.created_at > coalesce(($new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_enqueue_session_run(uuid,uuid)', array[
	$old$	else
		v_requester := coalesce(
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id),$old$,
	$new$	else
		v_requester := coalesce(
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id and m.user_id = public.qorpera_surface_turn_requester(v_peek)), /* WHY: 20260930922000 avoids billing the prior member on agent-steered turns */$new$,
	$old$				where m.session_id = v_session.id
					and m.author_kind = 'member'
					and m.created_at > v_worker.updated_at$old$,
	$new$				where m.session_id = v_session.id
					and m.author_kind in ('member', 'agent')
					and m.created_at > v_worker.updated_at$new$,
	$old$			where m.session_id = v_session.id
				and m.author_kind = 'member'
				and ($old$,
	$new$			where m.session_id = v_session.id
				and m.author_kind in ('member', 'agent')
				and ($new$,
	$old$				where m.session_id = v_session.id and m.author_kind = 'member'
				order by m.created_at desc, m.id desc$old$,
	$new$				where m.session_id = v_session.id and m.author_kind in ('member', 'agent')
				order by m.created_at desc, m.id desc$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)', array[
	$old$'sponsor', public.qorpera_surface_resolve_sponsor(c.profile_id, coalesce(c.turn_requested_by_user_id, c.created_by_user_id)),$old$,
	$new$'sponsor', public.qorpera_surface_resolve_sponsor(c.profile_id, case when c.turn_member_initiated is false then null::uuid else coalesce(c.turn_requested_by_user_id, c.created_by_user_id) end), /* WHY: 20260930922000 avoids billing the prior member on agent-steered turns */$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)', array[
	$old$select m.id, m.created_at, m.author_kind, m.author_user_id, m.profile_id, btrim(m.body) as body,$old$,
	$new$select m.id, m.created_at, m.author_kind, m.author_user_id, m.author_label, m.profile_id, btrim(m.body) as body,$new$,
	$old$				and (
					m.author_kind in ('member', 'session')$old$,
	$new$				and (
					m.author_kind in ('member', 'agent', 'session') /* WHY: 20260930922000 includes agent steering messages in session context */$new$,
	$old$				case
					when s.author_kind = 'session' then 'You'
					when s.author_kind = 'system' then 'System'
					else coalesce(nullif(left(regexp_replace(btrim(coalesce(pm.display_name, '')), '\s+', ' ', 'g'), 80), ''),
						'A teammate')
				end$old$,
	$new$				case
					when s.author_kind = 'session' then 'You'
					when s.author_kind = 'system' then 'System'
					when s.author_kind = 'agent' then coalesce(nullif(left(regexp_replace(btrim(coalesce(s.author_label, '')), '\s+', ' ', 'g'), 80), ''), 'Co-Founder')
					else coalesce(nullif(left(regexp_replace(btrim(coalesce(pm.display_name, '')), '\s+', ' ', 'g'), 80), ''),
						'A teammate')
				end$new$,
	$old$Act on the newest member message; the request above is where the session began.$old$,
	$new$Act on the newest member or agent message; the request above is where the session began.$new$,
	$old$		'originKind', v_session.origin_kind,$old$,
	$new$		'originKind', v_session.origin_kind,
		'memberInitiated', public.qorpera_surface_turn_member_initiated(v_session),$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_summary_json(public.qorpera_surfaces)', array[
	$old$		'needsAttentionCount', coalesce(stats.attention_sessions, 0),$old$,
	$new$		'needsAttentionCount', 0 /* WHY: 20260930922000 keeps agent blockers off the rail; teammate publish asks are layered by the client */,$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)', array[
	$old$	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);$old$,
	$new$	returning * into v_session;

	if v_next_state in ('needs_input', 'failed') and not coalesce(v_session.is_internal, false) then
		-- WHY: 20260930922000 routes genuine Surface session blockers and terminal failures to the Co-Founder.
		perform public.qorpera_surface_emit_cofounder_escalation(
			v_session.id,
			v_next_state,
			coalesce(
				nullif(btrim(coalesce(p_reply_text, '')), ''),
				v_session.question ->> 'text',
				case when v_next_state = 'failed' then 'Surface session failed after retry.' else 'Surface session paused for guidance.' end
			),
			v_session.question
		);
	end if;

	return public.qorpera_surface_session_json(v_session);$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)', array[
	$old$				from (
					select v_job.session_id as sid where v_job.session_id is not null
					union
					select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
				) affected;
			end if;
		else
			update public.qorpera_surface_changes
			set status = 'staged'$old$,
	$new$				from (
					select v_job.session_id as sid where v_job.session_id is not null
					union
					select ch.session_id as sid from public.qorpera_surface_changes ch where ch.id = any(v_change_ids)
				) affected;
			end if;

			if ((v_job.payload ? 'reconciliationId')
				or v_rec.id is null
				or v_rec.status = 'failed'
				or (v_rec.status = 'ready' and v_rec.updated_at <= v_job.created_at))
				and coalesce(
					v_job.session_id,
					(select ch.session_id from public.qorpera_surface_changes ch where ch.id = p_conflict_change_id and ch.surface_id = v_job.surface_id)
				) is not null then
				-- WHY: 20260930922000 escalates merge conflicts to the Co-Founder only when silent reconciliation did not take over or failed.
				perform public.qorpera_surface_emit_cofounder_escalation(
					coalesce(
						v_job.session_id,
						(select ch.session_id from public.qorpera_surface_changes ch where ch.id = p_conflict_change_id and ch.surface_id = v_job.surface_id)
					),
					'conflict',
					left(
						'Merge conflicted'
							|| case when coalesce(cardinality(p_conflict_paths), 0) > 0
								then ' on ' || array_to_string(p_conflict_paths, ', ')
								else '' end
							|| case when nullif(btrim(coalesce(p_error_detail, '')), '') is not null
								then ': ' || btrim(p_error_detail)
								else '' end,
						1000
					),
					null
				);
			end if;
		else
			update public.qorpera_surface_changes
			set status = 'staged'$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_pin_wake_occurrence()', array[
	$old$	v_surf_worker public.qorpera_runtime_workers%rowtype;$old$,
	$new$	v_surf_worker public.qorpera_runtime_workers%rowtype;
	v_surf_esc public.qorpera_surface_escalations%rowtype; /* WHY: 20260930922000 pins surface-escalation wakes */$new$,
	$old$		else
			new.requested_by_user_id := coalesce(
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id and m.user_id = v_surf_session.created_by_user_id),$old$,
	$new$		else
			new.requested_by_user_id := coalesce(
				(select m.user_id from public.qorpera_profile_members m
					where m.profile_id = new.profile_id and m.user_id = public.qorpera_surface_turn_requester(v_surf_session)),$new$,
	$old$	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$old$,
	$new$	elsif new.wake_kind = 'agent' and new.source_kind = 'surface-escalation' then
		select * into v_surf_esc from public.qorpera_surface_escalations e
		where e.id = new.source_id and e.profile_id = new.profile_id and e.wake_id is null;
		select * into v_surf_session from public.qorpera_surface_sessions s
		where s.id = v_surf_esc.session_id and s.profile_id = new.profile_id;
		select * into v_surf from public.qorpera_surfaces surf
		where surf.id = v_surf_esc.surface_id and surf.profile_id = new.profile_id;
		select * into v_surf_cofounder from public.qorpera_company_cofounders c
		where c.profile_id = new.profile_id and c.environment_id = new.environment_id;
		if not public.qorpera_company_is_folder_v2(new.profile_id)
			or v_surf_esc.id is null or v_surf_session.id is null or v_surf.id is null or v_surf_cofounder.staff_agent_id is null
			or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null then
			raise exception 'Wake surface escalation is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := v_surf_cofounder.staff_agent_id;
		v_surf_member_initiated := public.qorpera_surface_turn_member_initiated(v_surf_session);
		new.requested_by_user_id := coalesce(
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = new.profile_id and m.user_id = public.qorpera_surface_turn_requester(v_surf_session)),
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = new.profile_id and m.user_id = v_surf_cofounder.created_by_user_id),
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = new.profile_id order by (m.role = 'owner') desc, m.joined_at asc limit 1)
		);
		if new.requested_by_user_id is null then
			raise exception 'Wake surface escalation requester is unavailable' using errcode = '42501'; end if;
		new.trigger_id := 'surface-escalation';
		new.occurrence_key := 'surface-escalation:' || v_surf_esc.id::text;
		new.payload := jsonb_build_object(
			'schema', 'qorpera.surface-escalation-wake/v1',
			'escalationId', v_surf_esc.id,
			'surfaceSessionId', v_surf_session.id,
			'surfaceId', v_surf.id,
			'surfaceSlug', v_surf.slug,
			'surfaceTitle', v_surf.title,
			'sessionTitle', v_surf_session.title,
			'reason', v_surf_esc.reason,
			'summary', left(v_surf_esc.summary, 2000),
			'question', v_surf_esc.question,
			'memberInitiated', v_surf_member_initiated
		);
		v_surf_sponsor := public.qorpera_surface_resolve_sponsor(new.profile_id, new.requested_by_user_id);
		if v_surf_sponsor is null
			or nullif(v_surf_sponsor ->> 'sponsorBindingId', '') is null
			or nullif(v_surf_sponsor ->> 'sponsorVersion', '') is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		new.sponsor_binding_id := (v_surf_sponsor ->> 'sponsorBindingId')::uuid;
		new.sponsor_version := (v_surf_sponsor ->> 'sponsorVersion')::integer;
		new.logical_computer_id := null;
		new.session_id := public.qorpera_folder_wake_public_session(
			new.profile_id, new.environment_id, new.staff_agent_id, new.requested_by_user_id
		);
		v_actor := null;
	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)', array[
	$old$		if p_wake.source_kind = 'human-task' then$old$,
	$new$		if p_wake.source_kind = 'surface-escalation' then
			-- WHY: 20260930922000 authorizes surface-escalation wakes against their escalation row and causal root.
			if p_wake.parent_run_id is not null
				or not exists (
					select 1 from public.qorpera_surface_escalations e
					where e.id = p_wake.source_id
						and e.profile_id = p_wake.profile_id
						and (e.wake_id is null or e.wake_id = p_wake.id)
				) then
				return false; end if;
			v_ancestry := public.qorpera_wake_ancestry(null, null, p_wake.staff_agent_id, p_wake.id);
			return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
				and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
		end if;
		if p_wake.source_kind = 'human-task' then$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_runtime_wake_policy_internal(uuid)', array[
	$old$			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$old$,
	$new$			or (v_wake.source_kind = 'surface-escalation' and (v_wake.parent_run_id is not null
				or not exists (select 1 from public.qorpera_surface_escalations e where e.id = v_wake.source_id and e.profile_id = v_wake.profile_id))) /* WHY: 20260930922000 */
			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$new$,
	$old$					'human-task','machine-checkin','light-ask','surface-session'))))) -- 20260930098000$old$,
	$new$					'human-task','machine-checkin','light-ask','surface-session','surface-escalation'))))) -- 20260930098000$new$,
	$old$	if v_wake.source_kind = 'human-task' and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$old$,
	$new$	if v_wake.source_kind in ('human-task','surface-escalation') and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_folder_read_wake(jsonb)', array[
	$old$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask','surface-session') then '{}'::jsonb$old$,
	$new$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask','surface-session','surface-escalation') /* WHY: 20260930922000 */ then '{}'::jsonb$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_folder_materialize_company(uuid,integer)', array[
	$old$						or (v_wake.source_kind = 'surface-session'
							and coalesce((v_wake.payload ->> 'memberInitiated')::boolean, false)
							and v_wake.requested_by_user_id is not null
							and exists (
								select 1 from public.qorpera_surface_sessions s
								where s.id = v_wake.source_id and s.profile_id = v_wake.profile_id
							))$old$,
	$new$						or (v_wake.source_kind = 'surface-session'
							and coalesce((v_wake.payload ->> 'memberInitiated')::boolean, false)
							and v_wake.requested_by_user_id is not null
							and exists (
								select 1 from public.qorpera_surface_sessions s
								where s.id = v_wake.source_id and s.profile_id = v_wake.profile_id
							))
						or (v_wake.source_kind = 'surface-escalation' /* WHY: 20260930922000 */
							and coalesce((v_wake.payload ->> 'memberInitiated')::boolean, false)
							and v_wake.requested_by_user_id is not null
							and exists (
								select 1 from public.qorpera_surface_escalations e
								where e.id = v_wake.source_id and e.profile_id = v_wake.profile_id
							))$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)', array[
	$old$			and coalesce((w.payload ->> 'memberInitiated')::boolean, false)
			and w.requested_by_user_id is not null
			and w.requested_by_user_id = p_run.requested_by_user_id
	) then return true; end if;$old$,
	$new$			and coalesce((w.payload ->> 'memberInitiated')::boolean, false)
			and w.requested_by_user_id is not null
			and w.requested_by_user_id = p_run.requested_by_user_id
	) then return true; end if;
	if p_run.source_kind = 'wake' and exists (
		select 1 from public.qorpera_wake_occurrences w
		join public.qorpera_surface_escalations e on e.id = w.source_id and e.profile_id = w.profile_id
		where w.id = p_run.source_id and (w.run_id is null or w.run_id = p_run.id) and w.wake_kind = 'agent'
			and w.source_kind = 'surface-escalation' and w.profile_id = p_run.profile_id /* WHY: 20260930922000 */
			and coalesce((w.payload ->> 'memberInitiated')::boolean, false)
			and w.requested_by_user_id is not null
			and w.requested_by_user_id = p_run.requested_by_user_id
	) then return true; end if;$new$
]);

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_reply_surface_session(uuid,text,boolean,uuid)'::regprocedure,
			'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
			'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
			'public.qorpera_pin_wake_occurrence()'::regprocedure,
			'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
			'public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
			'public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
			'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930922000: patched function has an API owner: %', v_owner;
		end if;
		execute format('grant select, update on public.qorpera_surface_escalations to %I', v_owner);
		execute format(
			'grant execute on function public.qorpera_surface_escalation_ready(), '
			|| 'public.qorpera_surface_emit_cofounder_escalation(uuid, text, text, jsonb) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc p
	join surf_esc_before b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930922000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.surf_esc_patch(regprocedure, text[]);
drop table surf_esc_before;
