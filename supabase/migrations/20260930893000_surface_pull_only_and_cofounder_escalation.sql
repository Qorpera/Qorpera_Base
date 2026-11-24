set local lock_timeout = '3s';

create table public.qorpera_surface_escalations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	reason text not null check (reason in ('needs_input', 'failed', 'conflict')),
	summary text not null check (char_length(summary) <= 4000),
	question jsonb,
	wake_id uuid references public.qorpera_wake_occurrences(id) on delete set null,
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
	exception when insufficient_privilege then
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
	p_origin_label text default 'Co-Founder'
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_body text := btrim(coalesce(p_message, ''));
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
	if v_peek.state = 'discarded' then
		raise exception 'Cannot steer a discarded surface session' using errcode = '55000';
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

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_session.profile_id, p_session_id, 'member', null, v_body);

	update public.qorpera_surface_sessions
	set
		state = 'queued',
		question = null,
		closed_at = null,
		lease_expires_at = null,
		lease_token = null,
		wake_id = case when worker_id is not null then null else wake_id end,
		retry_count = 0,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_native_surface_steer_session(uuid, uuid, text, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_steer_session(uuid, uuid, text, text)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_native_surface_steer_session', 'profile')
on conflict (name) do nothing;

create or replace function pg_temp.surf_esc_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930893000' in v_definition) > 0 then
		raise exception '20260930893000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930893000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 100); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.surf_esc_patch('public.qorpera_surface_summary_json(public.qorpera_surfaces)', array[
	$old$		'needsAttentionCount', coalesce(stats.attention_sessions, 0),$old$,
	$new$		'needsAttentionCount', 0 /* 20260930893000 */,$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)', array[
	$old$	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);$old$,
	$new$	returning * into v_session;

	if v_next_state in ('needs_input', 'failed') and not coalesce(v_session.is_internal, false) then
		/* 20260930893000 */
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
				/* 20260930893000 */
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
	v_surf_esc public.qorpera_surface_escalations%rowtype; /* 20260930893000 */$new$,
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
			/* 20260930893000 */
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
				or not exists (select 1 from public.qorpera_surface_escalations e where e.id = v_wake.source_id and e.profile_id = v_wake.profile_id))) /* 20260930893000 */
			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$new$,
	$old$					'human-task','machine-checkin','light-ask','surface-session'))))) -- 20260930098000$old$,
	$new$					'human-task','machine-checkin','light-ask','surface-session','surface-escalation'))))) -- 20260930098000$new$,
	$old$	if v_wake.source_kind = 'human-task' and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$old$,
	$new$	if v_wake.source_kind in ('human-task','surface-escalation') and v_wake.session_id is not null then v_reporting := 'continuation'; end if;$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_folder_read_wake(jsonb)', array[
	$old$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask','surface-session') then '{}'::jsonb$old$,
	$new$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask','surface-session','surface-escalation') /* 20260930893000 */ then '{}'::jsonb$new$
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
						or (v_wake.source_kind = 'surface-escalation' /* 20260930893000 */
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
			and w.source_kind = 'surface-escalation' and w.profile_id = p_run.profile_id /* 20260930893000 */
			and coalesce((w.payload ->> 'memberInitiated')::boolean, false)
			and w.requested_by_user_id is not null
			and w.requested_by_user_id = p_run.requested_by_user_id
	) then return true; end if;$new$
]);

select pg_temp.surf_esc_patch('public.qorpera_record_runtime_observation(uuid,jsonb)', array[
	$old$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',$old$,
	$new$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',/* 20260930893000 */'steer_surface_session',$new$
]);

drop function pg_temp.surf_esc_patch(regprocedure, text[]);
