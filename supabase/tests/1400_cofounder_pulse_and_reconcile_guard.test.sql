-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.cprg_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'cofounder_pulse_and_reconcile_guard: %', p_message;
	end if;
end $$;

create function pg_temp.cprg_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid;
	v_next timestamptz;
	v_pulse public.qorpera_surface_automations%rowtype;
	v_trigger jsonb;
	v_trigger2 jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_list jsonb;
	v_surface uuid;
	v_s1 uuid;
	v_s2 uuid;
	v_s3 uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_rec1 public.qorpera_surface_reconciliations%rowtype;
	v_rec2 public.qorpera_surface_reconciliations%rowtype;
	v_rec_auto public.qorpera_surface_reconciliations%rowtype;
	v_sessions_before integer;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	v_next := public.qorpera_compute_next_automation_run('Every morning · 09:00', '2026-11-26 08:53:40+00'::timestamptz);
	perform pg_temp.cprg_assert(
		v_next = '2026-11-27 09:00:00+00'::timestamptz,
		'daily schedule enforces >=4h cooldown so 08:53 does not double-fire at 09:00: ' || v_next::text
	);

	v_next := public.qorpera_compute_next_automation_run('Every morning · 09:00', '2026-11-26 04:00:00+00'::timestamptz);
	perform pg_temp.cprg_assert(
		v_next = '2026-11-26 09:00:00+00'::timestamptz,
		'daily schedule keeps same-day slot when >=4h away: ' || v_next::text
	);

	v_next := public.qorpera_compute_next_automation_run('Every 2 hours', '2026-11-26 08:53:40+00'::timestamptz);
	perform pg_temp.cprg_assert(
		v_next = '2026-11-26 10:53:40+00'::timestamptz,
		'hourly interval schedules remain unchanged: ' || v_next::text
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_service_bootstrap_company_surfaces(v_company, v_anna);
	reset role;

	select * into strict v_pulse
	from public.qorpera_surface_automations
	where profile_id = v_company and key = 'cofounder-pulse';

	perform pg_temp.cprg_assert(
		v_pulse.next_run_at >= clock_timestamp() + interval '3 hours 59 minutes'
			and extract(hour from v_pulse.next_run_at at time zone 'UTC') = 9
			and extract(minute from v_pulse.next_run_at at time zone 'UTC') = 0,
		'bootstrapped cofounder-pulse aligns to 09:00 UTC with >=4h lead time: ' || v_pulse.next_run_at::text
	);

	select count(*) into v_sessions_before from public.qorpera_surface_sessions where profile_id = v_company;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_trigger := public.qorpera_surface_trigger_automation(v_pulse.id);
	reset role;

	perform pg_temp.cprg_assert(
		v_trigger ->> 'status' = 'started'
			and v_trigger -> 'session' = 'null'::jsonb
			and nullif(v_trigger ->> 'wakeId', '') is not null
			and nullif(v_trigger ->> 'routineId', '') is not null
			and (select count(*) from public.qorpera_surface_sessions where profile_id = v_company) = v_sessions_before,
		'cofounder-pulse wakes Co-Founder directly without spawning an identity surface session: ' || v_trigger::text
	);

	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_trigger ->> 'wakeId')::uuid;
	perform pg_temp.cprg_assert(
		v_wake.wake_kind = 'routine'
			and v_wake.source_kind = 'schedule'
			and v_wake.staff_agent_id = v_cofounder
			and v_wake.requested_by_user_id = v_anna
			and public.qorpera_folder_wake_authorized(v_wake),
		'cofounder-pulse wake targets Co-Founder and passes wake authorization'
	);

	perform pg_temp.cprg_as(v_anna);
	set local role authenticated;
	v_list := public.qorpera_list_automations(v_company);
	reset role;
	perform pg_temp.cprg_assert(
		(select count(*) from jsonb_array_elements(v_list) elem where elem ->> 'id' = (v_trigger ->> 'routineId')) = 0
			and (select count(*) from jsonb_array_elements(v_list) elem where elem ->> 'id' = v_pulse.id::text) = 1,
		'linked backing routine is hidden from duplicate listing in qorpera_list_automations'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_trigger2 := public.qorpera_surface_trigger_automation(v_pulse.id);
	reset role;
	perform pg_temp.cprg_assert(
		v_trigger2 ->> 'status' = 'skipped' and v_trigger2 ->> 'reason' = 'already_running',
		'duplicate cofounder-pulse trigger is skipped while prior wake is queued/running: ' || v_trigger2::text
	);

	perform pg_temp.cprg_as(v_anna);
	set local role authenticated;
	perform public.qorpera_toggle_automation(v_pulse.id, false);
	reset role;
	perform pg_temp.cprg_assert(
		(select status from public.qorpera_cloud_routines where id = (v_trigger ->> 'routineId')::uuid) = 'paused',
		'pausing automation pauses its backing routine'
	);

	perform pg_temp.cprg_as(v_anna);
	set local role authenticated;
	perform public.qorpera_delete_surface_automation(v_pulse.id);
	reset role;
	perform pg_temp.cprg_assert(
		(select status from public.qorpera_cloud_routines where id = (v_trigger ->> 'routineId')::uuid) = 'retired'
			and (select status from public.qorpera_wake_occurrences where id = v_wake.id) = 'cancelled',
		'deleting automation retires backing routine and cancels queued wake'
	);

	select id into strict v_surface
	from public.qorpera_surfaces
	where profile_id = v_company and slug = 'identity';

	insert into public.qorpera_surface_sessions(profile_id, surface_id, title, prompt, origin_kind, created_by_user_id, state)
	values
		(v_company, v_surface, 'S1', 'Change 1', 'member', v_anna, 'completed'),
		(v_company, v_surface, 'S2', 'Change 2', 'member', v_anna, 'completed'),
		(v_company, v_surface, 'S3', 'Change 3', 'member', v_anna, 'completed');
	select id into strict v_s1 from public.qorpera_surface_sessions where surface_id = v_surface and title = 'S1';
	select id into strict v_s2 from public.qorpera_surface_sessions where surface_id = v_surface and title = 'S2';
	select id into strict v_s3 from public.qorpera_surface_sessions where surface_id = v_surface and title = 'S3';

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, status, affected_paths)
	values
		(v_company, v_surface, v_s1, 1, 'C1', 'staged', array['identity/tokens.json']),
		(v_company, v_surface, v_s2, 1, 'C2', 'staged', array['identity/tokens.json']),
		(v_company, v_surface, v_s3, 1, 'C3', 'staged', array['identity/tokens.json']);
	select id into strict v_c1 from public.qorpera_surface_changes where session_id = v_s1;
	select id into strict v_c2 from public.qorpera_surface_changes where session_id = v_s2;
	select id into strict v_c3 from public.qorpera_surface_changes where session_id = v_s3;

	v_rec_auto := public.qorpera_surface_enqueue_silent_reconciliation(
		v_surface, array[v_c1, v_c3], array['identity/tokens.json'], v_anna, true, false
	);
	v_rec1 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_surface, array[v_c1, v_c2], array['identity/tokens.json'], v_anna, false, false
	);
	v_rec2 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_surface, array[v_c1, v_c2, v_c3], array['identity/tokens.json'], v_anna, false, false
	);

	perform pg_temp.cprg_assert(
		not exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec1.id)
			and (select state from public.qorpera_surface_sessions where id = v_rec1.session_id) = 'discarded'
			and exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec2.id and status = 'queued')
			and exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec_auto.id and status = 'queued'),
		'newer member preview reconciliation supersedes older unstarted queued one without touching auto_approve_after'
	);
end $$;

rollback;
