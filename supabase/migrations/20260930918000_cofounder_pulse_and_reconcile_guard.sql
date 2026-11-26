set local lock_timeout = '3s';

do $$ begin
	if strpos(
		coalesce(pg_get_functiondef('public.qorpera_surface_trigger_automation(uuid)'::regprocedure), ''),
		'20260930918000'
	) > 0 then
		raise exception '20260930918000_cofounder_pulse_and_reconcile_guard is already applied';
	end if;
	if to_regprocedure('public.qorpera_surface_claim_due_automations(integer)') is null
		or to_regprocedure('public.qorpera_surface_trigger_automation(uuid)') is null
		or to_regprocedure('public.qorpera_toggle_automation(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_delete_surface_automation(uuid)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_compute_next_automation_run(text,timestamptz)') is null
		or to_regprocedure('public.qorpera_company_state_routine_sha(uuid,text,text,jsonb,text,uuid,bigint)') is null
		or to_regprocedure('public.qorpera_runtime_time_zone_name_valid(text)') is null
		or to_regprocedure('public.qorpera_folder_company_enter(uuid,uuid,jsonb,boolean)') is null
		or to_regprocedure('public.qorpera_folder_admit_wakes(uuid)') is null
		or to_regprocedure('public.qorpera_folder_wake_public_session(uuid,uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_company_at_zero(uuid,timestamptz)') is null
		or to_regprocedure('public.qorpera_wake_run_live(uuid)') is null then
		raise exception '20260930918000 requires earlier surface and routine migrations first';
	end if;
end $$;

create temp table cprg_before as
select oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc p
where p.pronamespace = 'public'::regnamespace
	and p.oid = any(array[
		'public.qorpera_surface_claim_due_automations(integer)'::regprocedure,
		'public.qorpera_surface_trigger_automation(uuid)'::regprocedure,
		'public.qorpera_toggle_automation(uuid,boolean)'::regprocedure,
		'public.qorpera_delete_surface_automation(uuid)'::regprocedure,
		'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure
	]);

create function pg_temp.cprg_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930918000 anchor found % time(s) in %, expected 1: %',
				v_found, p_target, left(p_edits[2 * i - 1], 100);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.cprg_patch(
	'public.qorpera_surface_claim_due_automations(integer)'::regprocedure,
	array[
$old$			next_run_at = public.qorpera_compute_next_automation_run(a.schedule_summary, v_now),$old$,
$new$			-- WHY: 20260930918000 enforces a 4-hour post-run cooldown on non-hourly schedules so an off-clock run (e.g. 08:53) never double-fires minutes later at 09:00.
			next_run_at = case
				when lower(btrim(coalesce(a.schedule_summary, ''))) ~ 'every\s+([0-9]{1,2})\s+hours?|every\s+hour|hourly'
					then public.qorpera_compute_next_automation_run(a.schedule_summary, v_now)
				when public.qorpera_compute_next_automation_run(a.schedule_summary, v_now) < v_now + interval '4 hours'
					then public.qorpera_compute_next_automation_run(a.schedule_summary, v_now + interval '4 hours')
				else public.qorpera_compute_next_automation_run(a.schedule_summary, v_now)
			end,$new$
	]
);

select pg_temp.cprg_patch(
	'public.qorpera_surface_trigger_automation(uuid)'::regprocedure,
	array[
$old$	v_session jsonb;
	v_problem text;
begin$old$,
$new$	v_session jsonb;
	v_problem text;
	v_cofounder public.qorpera_company_cofounders%rowtype;
	v_requester uuid;
	v_sponsor jsonb;
	v_sponsor_binding uuid;
	v_sponsor_version bigint;
	v_time_zone text;
	v_now timestamptz := clock_timestamp();
	v_routine_id uuid;
	v_next_version bigint;
	v_triggers jsonb;
	v_sha text;
	v_public_session uuid;
	v_wake_id uuid;
	v_wake_session uuid;
begin$new$,
$old$	if v_auto.id is null or not v_auto.enabled then
		return jsonb_build_object('status', 'skipped', 'reason', 'not_found_or_disabled');
	end if;
	if public.qorpera_surface_company_paused(v_auto.profile_id) then$old$,
$new$	if v_auto.id is null or not v_auto.enabled then
		return jsonb_build_object('status', 'skipped', 'reason', 'not_found_or_disabled');
	end if;

	-- WHY: 20260930918000 routes company-wide automations (target_surface_slug is null, including cofounder-pulse) to the Co-Founder directly under folder-v2 wake admission.
	if v_auto.target_surface_slug is null then
		select * into v_cofounder
		from public.qorpera_company_cofounders
		where profile_id = v_auto.profile_id
		limit 1;
		if v_cofounder.staff_agent_id is null then
			return jsonb_build_object('status', 'skipped', 'reason', 'no_cofounder');
		end if;

		select m.user_id into v_requester
		from public.qorpera_profile_members m
		where m.profile_id = v_auto.profile_id
			and m.user_id = v_auto.owner_user_id
			and m.role <> 'viewer';
		if v_requester is null then
			return jsonb_build_object(
				'status', 'skipped',
				'reason', coalesce(public.qorpera_surface_automation_payer_problem(v_auto.profile_id, v_auto.owner_user_id, null), 'no_owner')
			);
		end if;

		begin
			perform public.qorpera_folder_company_enter(
				v_cofounder.environment_id,
				v_auto.profile_id,
				jsonb_build_array(
					jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
						'key', v_auto.profile_id::text || ':' || v_requester::text, 'mode', 'keyshare', 'required', true),
					jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
						'key', v_auto.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false),
					jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
						'key', v_auto.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false)
				),
				true
			);
		exception when sqlstate '55000' then
			return jsonb_build_object('status', 'skipped', 'reason', 'paused');
		end;

		select * into v_auto
		from public.qorpera_surface_automations
		where id = p_automation_id
		for update;
		if v_auto.id is null or not v_auto.enabled or v_auto.target_surface_slug is not null then
			return jsonb_build_object('status', 'skipped', 'reason', 'not_found_or_disabled');
		end if;
		if public.qorpera_surface_company_paused(v_auto.profile_id) then
			return jsonb_build_object('status', 'skipped', 'reason', 'paused');
		end if;
		if public.qorpera_company_at_zero(v_auto.profile_id, v_now) then
			return jsonb_build_object('status', 'skipped', 'reason', 'no_hours');
		end if;
		v_problem := public.qorpera_surface_automation_payer_problem(v_auto.profile_id, v_auto.owner_user_id, null);
		if v_problem is not null then
			return jsonb_build_object('status', 'skipped', 'reason', v_problem);
		end if;

		v_routine_id := v_auto.routine_id;
		if v_routine_id is null then
			select id into v_routine_id
			from public.qorpera_cloud_routines
			where profile_id = v_auto.profile_id and client_routine_id = v_auto.id;
		end if;

		if v_routine_id is not null then
			select current_version + 1 into strict v_next_version
			from public.qorpera_cloud_routines
			where id = v_routine_id
			for no key update;

			if exists (
				select 1
				from public.qorpera_wake_occurrences w
				where w.routine_id = v_routine_id
					and w.wake_kind = 'routine'
					and (
						w.status = 'queued'
						or (w.status = 'materialized' and public.qorpera_wake_run_live(w.run_id))
					)
			) then
				return jsonb_build_object('status', 'skipped', 'reason', 'already_running');
			end if;
		end if;

		v_sponsor := public.qorpera_surface_resolve_sponsor(v_auto.profile_id, v_requester);
		v_sponsor_binding := nullif(v_sponsor ->> 'sponsorBindingId', '')::uuid;
		v_sponsor_version := nullif(v_sponsor ->> 'sponsorVersion', '')::bigint;
		if v_sponsor_binding is null or v_sponsor_version is null then
			return jsonb_build_object('status', 'skipped', 'reason', 'no_login');
		end if;

		select case
			when p.time_zone is not null and public.qorpera_runtime_time_zone_name_valid(p.time_zone) then p.time_zone
			else 'UTC'
		end into v_time_zone
		from public.qorpera_profiles p
		where p.id = v_auto.profile_id;
		v_time_zone := coalesce(v_time_zone, 'UTC');

		begin
			if v_routine_id is null then
				insert into public.qorpera_cloud_routines(
					profile_id, environment_id, client_routine_id, current_version, status, created_by_user_id
				)
				values (
					v_auto.profile_id, v_cofounder.environment_id, v_auto.id, 0, 'active', v_requester
				)
				on conflict (profile_id, client_routine_id) do update
					set updated_at = v_now
				returning id into v_routine_id;

				select current_version + 1 into strict v_next_version
				from public.qorpera_cloud_routines
				where id = v_routine_id
				for no key update;
			end if;

			v_triggers := jsonb_build_array(
				jsonb_build_object(
					'id', 'pulse',
					'kind', 'once',
					'at', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
					'timeZone', v_time_zone,
					'replyPolicy', 'optional'
				)
			);
			v_sha := public.qorpera_company_state_routine_sha(
				v_cofounder.staff_agent_id, left(v_auto.title, 160), v_auto.prompt,
				v_triggers, 'medium', v_sponsor_binding, v_sponsor_version
			);

			v_public_session := public.qorpera_folder_wake_public_session(
				v_auto.profile_id, v_cofounder.environment_id,
				v_cofounder.staff_agent_id, v_requester
			);
			if v_public_session is not null then
				perform 1 from public.qorpera_shared_sessions where id = v_public_session for key share;
			end if;

			insert into public.qorpera_cloud_routine_versions(
				routine_id, version, client_version_id, profile_id, environment_id,
				staff_agent_id, title, prompt, triggers, effort,
				sponsor_binding_id, sponsor_version, logical_computer_id,
				required_capability, job_type, publication_mode,
				review_policy_key, reviewer_staff_ids, content_sha256, created_by_user_id
			)
			values (
				v_routine_id, v_next_version, extensions.gen_random_uuid(),
				v_auto.profile_id, v_cofounder.environment_id,
				v_cofounder.staff_agent_id, left(v_auto.title, 160), v_auto.prompt, v_triggers, 'medium',
				v_sponsor_binding, v_sponsor_version, null,
				'agent_turn', 'agent_turn', 'automatic',
				null, '{}'::uuid[], v_sha, v_requester
			);

			update public.qorpera_cloud_routines
			set current_version = v_next_version, status = 'active', pause_reason = null, updated_at = v_now
			where id = v_routine_id;

			update public.qorpera_surface_automations
			set routine_id = v_routine_id, updated_at = v_now
			where id = v_auto.id and routine_id is distinct from v_routine_id;

			perform public.qorpera_folder_admit_wakes(v_auto.profile_id);
			insert into public.qorpera_wake_occurrences(
				id, profile_id, environment_id, routine_id, routine_version,
				wake_kind, source_kind, trigger_id, source_id, occurrence_key,
				scheduled_for, not_before, payload
			)
			values (
				extensions.gen_random_uuid(), v_auto.profile_id, v_cofounder.environment_id,
				v_routine_id, v_next_version,
				'routine', 'schedule', 'pulse', v_routine_id,
				'surface-automation:' || v_auto.id::text || ':' || v_next_version::text,
				v_now, v_now, '{}'::jsonb
			)
			returning id, session_id into v_wake_id, v_wake_session;

			if v_wake_session is distinct from v_public_session then
				raise exception 'Wake public session changed during admission' using errcode = '55000';
			end if;
		exception
			when sqlstate '55000' then
				return jsonb_build_object('status', 'skipped', 'reason', 'paused');
			when insufficient_privilege then
				return jsonb_build_object('status', 'skipped', 'reason', 'unauthorized');
		end;

		return jsonb_build_object(
			'status', 'started',
			'session', null,
			'wakeId', v_wake_id,
			'routineId', v_routine_id
		);
	end if;

	if public.qorpera_surface_company_paused(v_auto.profile_id) then$new$,
$old$	-- WHY: 20260930875000: a scheduled agent whose own interface is gone does not run on another one.
	if v_surface.id is null and v_auto.target_surface_slug is null then
		select * into v_surface
		from public.qorpera_surfaces s
		where s.profile_id = v_auto.profile_id and s.status = 'active'
		order by s.sort_order asc, s.created_at asc
		limit 1;
	end if;$old$,
$new$	-- WHY: Company-wide automations (target_surface_slug is null) already returned above via Co-Founder wake admission.$new$
	]
);

select pg_temp.cprg_patch(
	'public.qorpera_toggle_automation(uuid,boolean)'::regprocedure,
	array[
$old$		where id = p_automation_id
		returning * into v_auto;

		return public.qorpera_surface_automation_json(v_auto);$old$,
$new$		where id = p_automation_id
		returning * into v_auto;

		if v_auto.routine_id is not null then
			update public.qorpera_cloud_routines
			set
				status = case when v_auto.enabled then 'active' else 'paused' end,
				pause_reason = case when v_auto.enabled then null else 'member' end,
				updated_at = clock_timestamp()
			where id = v_auto.routine_id and status <> 'retired';
		end if;

		return public.qorpera_surface_automation_json(v_auto);$new$
	]
);

select pg_temp.cprg_patch(
	'public.qorpera_delete_surface_automation(uuid)'::regprocedure,
	array[
$old$	delete from public.qorpera_surface_automations where id = p_automation_id;
	return true;$old$,
$new$	if v_row.routine_id is not null then
		update public.qorpera_cloud_routines
		set status = 'retired', pause_reason = null, updated_at = clock_timestamp()
		where id = v_row.routine_id and status <> 'retired';
		update public.qorpera_wake_occurrences
		set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'Scheduled agent was deleted'
		where routine_id = v_row.routine_id and wake_kind = 'routine' and status = 'queued';
	end if;
	delete from public.qorpera_surface_automations where id = p_automation_id;
	return true;$new$
	]
);

select pg_temp.cprg_patch(
	'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
	array[
$old$	v_now timestamptz := clock_timestamp();
begin$old$,
$new$	v_now timestamptz := clock_timestamp();
	v_sup record;
begin$new$,
$old$	delete from public.qorpera_surface_reconciliations
	where surface_id = p_surface_id
		and composition_key <> v_comp_key
		and expires_at <= v_now - interval '1 hour'
		and status <> 'running';$old$,
$new$	-- WHY: Supersede unstarted member-initiated preview reconciliations in session-then-reconciliation lock order so rapid toggles never fan out concurrent runs or strand reconciling previews.
	if v_explicit_member and not coalesce(p_auto_approve_after, false) then
		for v_sup in
			select r.id as rec_id, r.session_id, r.selected_change_ids
			from public.qorpera_surface_reconciliations r
			join public.qorpera_surface_sessions s on s.id = r.session_id
			where r.surface_id = p_surface_id
				and r.composition_key <> v_comp_key
				and r.status = 'queued'
				and r.auto_approve_after = false
				and r.created_by_user_id = v_requester
				and s.origin_kind = 'member'
				and s.state = 'reconciling'
				and s.lease_token is null
				and s.wake_id is null
				and s.worker_id is null
			order by r.created_at asc, r.id asc
		loop
			update public.qorpera_surface_sessions s
			set state = 'discarded', closed_at = v_now, updated_at = v_now
			where s.id = v_sup.session_id
				and s.origin_kind = 'member'
				and s.state = 'reconciling'
				and s.lease_token is null
				and s.wake_id is null
				and s.worker_id is null;
			if not found then
				continue;
			end if;

			delete from public.qorpera_surface_reconciliations r
			where r.id = v_sup.rec_id
				and r.session_id = v_sup.session_id
				and r.status = 'queued'
				and r.auto_approve_after = false;
			if not found then
				continue;
			end if;

			update public.qorpera_surface_previews p
			set
				status = 'failed',
				conflict_report = null,
				error_detail = 'Couldn''t update preview',
				lease_expires_at = null,
				lease_token = null,
				updated_at = v_now
			where p.surface_id = p_surface_id
				and p.status = 'reconciling'
				and (
					select array_agg(x order by x) from unnest(p.selected_change_ids) as x
				) = (
					select array_agg(y order by y) from unnest(v_sup.selected_change_ids) as y
				);
		end loop;
	end if;

	delete from public.qorpera_surface_reconciliations
	where surface_id = p_surface_id
		and composition_key <> v_comp_key
		and expires_at <= v_now - interval '1 hour'
		and status <> 'running';$new$
	]
);

update public.qorpera_surface_automations
set
	next_run_at = public.qorpera_compute_next_automation_run(
		schedule_summary,
		greatest(last_run_at, clock_timestamp()) + interval '4 hours'
	),
	updated_at = clock_timestamp()
where enabled = true
	and next_run_at is not null
	and last_run_at is not null
	and next_run_at < last_run_at + interval '4 hours'
	and lower(btrim(coalesce(schedule_summary, ''))) !~ 'every\s+([0-9]{1,2})\s+hours?|every\s+hour|hourly';

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_surface_trigger_automation(uuid)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930918000 function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_company_cofounders, public.qorpera_profiles, public.qorpera_profile_members, public.qorpera_shared_sessions to %I', v_owner);
		execute format('grant select, insert, update on public.qorpera_cloud_routines, public.qorpera_wake_occurrences to %I', v_owner);
		execute format('grant insert on public.qorpera_cloud_routine_versions to %I', v_owner);
		execute format('grant update on public.qorpera_surface_automations to %I', v_owner);
		execute format('grant execute on function public.qorpera_surface_resolve_sponsor(uuid,uuid), public.qorpera_runtime_time_zone_name_valid(text), public.qorpera_company_state_routine_sha(uuid,text,text,jsonb,text,uuid,bigint), public.qorpera_folder_company_enter(uuid,uuid,jsonb,boolean), public.qorpera_folder_admit_wakes(uuid), public.qorpera_folder_wake_public_session(uuid,uuid,uuid,uuid), public.qorpera_company_at_zero(uuid,timestamptz), public.qorpera_wake_run_live(uuid) to %I', v_owner);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid in (
			'public.qorpera_toggle_automation(uuid,boolean)'::regprocedure,
			'public.qorpera_delete_surface_automation(uuid)'::regprocedure
		)
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930918000 function has an API owner: %', v_owner;
		end if;
		execute format('grant update on public.qorpera_cloud_routines, public.qorpera_wake_occurrences to %I', v_owner);
	end loop;

	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = 'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930918000 function has an API owner: %', v_owner;
		end if;
		execute format('grant update on public.qorpera_surface_previews to %I', v_owner);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc p
	join cprg_before b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930918000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.cprg_patch(regprocedure, text[]);
