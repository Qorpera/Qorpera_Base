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
	v_env uuid := (v_claim ->> 'environmentId')::uuid;
	v_next timestamptz;
	v_pulse public.qorpera_surface_automations%rowtype;
	v_hourly_id uuid;
	v_claimed jsonb;
	v_trigger jsonb;
	v_trigger2 jsonb;
	v_trigger_paused jsonb;
	v_trigger_zero jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_run_id uuid;
	v_job_id uuid;
	v_admissions_before bigint;
	v_admissions_after bigint;
	v_list jsonb;
	v_surface uuid;
	v_code_surface uuid;
	v_s1 uuid;
	v_s2 uuid;
	v_s3 uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_cs1 uuid;
	v_cs2 uuid;
	v_cs3 uuid;
	v_cc1 uuid;
	v_cc2 uuid;
	v_cc3 uuid;
	v_preview_id uuid;
	v_rec1 public.qorpera_surface_reconciliations%rowtype;
	v_rec2 public.qorpera_surface_reconciliations%rowtype;
	v_rec_auto public.qorpera_surface_reconciliations%rowtype;
	v_rec_sys public.qorpera_surface_reconciliations%rowtype;
	v_rec_code1 public.qorpera_surface_reconciliations%rowtype;
	v_rec_code2 public.qorpera_surface_reconciliations%rowtype;
	v_sessions_before integer;
	v_soon_hour integer;
	v_soon_min integer;
	v_soon_schedule text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	v_next := public.qorpera_compute_next_automation_run('Every morning · 09:00', '2026-11-26 05:30:00+00'::timestamptz);
	perform pg_temp.cprg_assert(
		v_next = '2026-11-26 09:00:00+00'::timestamptz,
		'creating or updating a daily schedule at 05:30 still targets today 09:00: ' || v_next::text
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_service_bootstrap_company_surfaces(v_company, v_anna);
	reset role;

	select * into strict v_pulse
	from public.qorpera_surface_automations
	where profile_id = v_company and key = 'cofounder-pulse';

	v_soon_hour := extract(hour from (clock_timestamp() + interval '10 minutes') at time zone 'UTC')::integer;
	v_soon_min := extract(minute from (clock_timestamp() + interval '10 minutes') at time zone 'UTC')::integer;
	v_soon_schedule := 'Every morning · ' || lpad(v_soon_hour::text, 2, '0') || ':' || lpad(v_soon_min::text, 2, '0');

	update public.qorpera_surface_automations
	set schedule_summary = v_soon_schedule, next_run_at = clock_timestamp() - interval '1 minute'
	where id = v_pulse.id;

	insert into public.qorpera_surface_automations(
		profile_id, key, title, schedule_summary, prompt, enabled, next_run_at, owner_user_id
	)
	values (
		v_company, 'hourly-check', 'Hourly check', 'Every 2 hours', 'Check status', true,
		clock_timestamp() - interval '1 minute', v_anna
	)
	returning id into v_hourly_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_due_automations(16);
	reset role;

	select * into strict v_pulse from public.qorpera_surface_automations where id = v_pulse.id;
	perform pg_temp.cprg_assert(
		v_pulse.next_run_at >= clock_timestamp() + interval '4 hours',
		'claim_due_automations enforces >=4h post-run cooldown on non-hourly schedules: ' || v_pulse.next_run_at::text
	);
	perform pg_temp.cprg_assert(
		(select next_run_at from public.qorpera_surface_automations where id = v_hourly_id)
			between clock_timestamp() + interval '1 hour 55 minutes' and clock_timestamp() + interval '2 hours 5 minutes',
		'claim_due_automations keeps hourly intervals unchanged'
	);

	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values (v_company, v_anna, 'Test pause');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_trigger_paused := public.qorpera_surface_trigger_automation(v_pulse.id);
	reset role;
	perform pg_temp.cprg_assert(
		v_trigger_paused ->> 'status' = 'skipped' and v_trigger_paused ->> 'reason' = 'paused',
		'paused company skips cofounder-pulse wake admission: ' || v_trigger_paused::text
	);
	delete from public.qorpera_company_execution_pauses where profile_id = v_company;

	update public.qorpera_computer_hour_billing
	set live_since = clock_timestamp() - interval '1 minute',
		zero_rule_since = clock_timestamp() - interval '1 minute';
	insert into public.qorpera_computer_hour_usage(profile_id, metered_at, run_seconds, standard_seconds)
	values (v_company, clock_timestamp(), 20000, 20000);
	insert into public.qorpera_computer_hour_zero_state(profile_id, ran_out_at)
	values (v_company, clock_timestamp() - interval '1 minute')
	on conflict (profile_id) do update set ran_out_at = excluded.ran_out_at;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_trigger_zero := public.qorpera_surface_trigger_automation(v_pulse.id);
	reset role;
	perform pg_temp.cprg_assert(
		v_trigger_zero ->> 'status' = 'skipped' and v_trigger_zero ->> 'reason' = 'no_hours',
		'company at zero computer hours skips cofounder-pulse wake admission: ' || v_trigger_zero::text
	);
	delete from public.qorpera_computer_hour_zero_state where profile_id = v_company;
	update public.qorpera_computer_hour_billing set live_since = null, zero_rule_since = null;

	select count(*) into v_sessions_before from public.qorpera_surface_sessions where profile_id = v_company;
	select coalesce((select admitted from public.qorpera_folder_admissions where profile_id = v_company), 0)
	into v_admissions_before;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_trigger := public.qorpera_surface_trigger_automation(v_pulse.id);
	reset role;

	select coalesce((select admitted from public.qorpera_folder_admissions where profile_id = v_company), 0)
	into v_admissions_after;

	perform pg_temp.cprg_assert(
		v_trigger ->> 'status' = 'started'
			and v_trigger -> 'session' = 'null'::jsonb
			and nullif(v_trigger ->> 'wakeId', '') is not null
			and nullif(v_trigger ->> 'routineId', '') is not null
			and v_admissions_after = v_admissions_before + 1
			and (select count(*) from public.qorpera_surface_sessions where profile_id = v_company) = v_sessions_before,
		'cofounder-pulse admits wake through qorpera_folder_admit_wakes without spawning an identity session: ' || v_trigger::text
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
		'duplicate cofounder-pulse trigger is skipped while prior wake is queued: ' || v_trigger2::text
	);

	v_run_id := extensions.gen_random_uuid();
	v_job_id := extensions.gen_random_uuid();
	set local session_replication_role = replica;
	insert into public.qorpera_runner_jobs(
		id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id,
		lease_token_sha256, lease_expires_at, run_id
	)
	values (
		v_job_id, v_company, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn',
		'agent_turn', '{}'::jsonb, v_anna, 'leased', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		repeat('a', 64), clock_timestamp() + interval '5 minutes', v_run_id
	);
	insert into public.qorpera_execution_runs(
		id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version,
		required_capability, job_type, payload_sha256, transcript_start_sequence,
		created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids
	)
	values (
		v_run_id, v_company, v_env, 'wake', v_wake.id, v_job_id, extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), v_cofounder, 1, v_wake.sponsor_binding_id, v_wake.sponsor_version,
		'agent_turn', 'agent_turn', repeat('c', 64), 0, v_anna, v_anna, 'openai', 'gpt-test',
		'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), v_wake.session_id, '{}'::uuid[]
	);
	update public.qorpera_wake_occurrences
	set status = 'materialized', run_id = v_run_id
	where id = v_wake.id;
	set local session_replication_role = origin;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_trigger2 := public.qorpera_surface_trigger_automation(v_pulse.id);
	reset role;
	perform pg_temp.cprg_assert(
		v_trigger2 ->> 'status' = 'skipped' and v_trigger2 ->> 'reason' = 'already_running',
		'duplicate cofounder-pulse trigger is skipped while materialized run is still live: ' || v_trigger2::text
	);

	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set status = 'queued', run_id = null where id = v_wake.id;
	delete from public.qorpera_execution_runs where id = v_run_id;
	delete from public.qorpera_runner_jobs where id = v_job_id;
	set local session_replication_role = origin;

	perform pg_temp.cprg_as(v_anna);
	set local role authenticated;
	perform public.qorpera_toggle_automation(v_pulse.id, false);
	reset role;
	perform pg_temp.cprg_assert(
		(select status = 'paused' and pause_reason = 'member' from public.qorpera_cloud_routines where id = (v_trigger ->> 'routineId')::uuid),
		'pausing automation pauses its backing routine with pause_reason = member'
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
	v_rec_sys := public.qorpera_surface_enqueue_silent_reconciliation(
		v_surface, array[v_c2, v_c3], array['identity/tokens.json'], null, false, false
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
			and exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec_auto.id and status = 'queued')
			and exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec_sys.id and status = 'queued'),
		'newer member preview reconciliation supersedes only older member preview ones without touching auto_approve_after or system-queued reconciliations'
	);

	perform pg_temp.cprg_as(v_anna);
	set local role authenticated;
	v_code_surface := (public.qorpera_create_surface(v_company, 'Site', 'site', 'live_build', 'website', 'globe', '#0a84ff', null, null, false) ->> 'id')::uuid;
	reset role;

	insert into public.qorpera_surface_sessions(profile_id, surface_id, title, prompt, origin_kind, created_by_user_id, state)
	values
		(v_company, v_code_surface, 'CS1', 'Code 1', 'member', v_anna, 'completed'),
		(v_company, v_code_surface, 'CS2', 'Code 2', 'member', v_anna, 'completed'),
		(v_company, v_code_surface, 'CS3', 'Code 3', 'member', v_anna, 'completed');
	select id into strict v_cs1 from public.qorpera_surface_sessions where surface_id = v_code_surface and title = 'CS1';
	select id into strict v_cs2 from public.qorpera_surface_sessions where surface_id = v_code_surface and title = 'CS2';
	select id into strict v_cs3 from public.qorpera_surface_sessions where surface_id = v_code_surface and title = 'CS3';

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, status, affected_paths)
	values
		(v_company, v_code_surface, v_cs1, 1, 'CC1', 'staged', array['src/app.tsx']),
		(v_company, v_code_surface, v_cs2, 1, 'CC2', 'staged', array['src/app.tsx']),
		(v_company, v_code_surface, v_cs3, 1, 'CC3', 'staged', array['src/app.tsx']);
	select id into strict v_cc1 from public.qorpera_surface_changes where session_id = v_cs1;
	select id into strict v_cc2 from public.qorpera_surface_changes where session_id = v_cs2;
	select id into strict v_cc3 from public.qorpera_surface_changes where session_id = v_cs3;

	v_rec_code1 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_code_surface, array[v_cc1, v_cc2], array['src/app.tsx'], v_anna, false, false
	);
	insert into public.qorpera_surface_previews(
		profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids, status, expires_at
	)
	values (
		v_company, v_code_surface, repeat('d', 64), 'cprg0001', repeat('0', 40), array[v_cc1, v_cc2], 'reconciling', clock_timestamp() + interval '1 hour'
	)
	returning id into v_preview_id;

	v_rec_code2 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_code_surface, array[v_cc1, v_cc2, v_cc3], array['src/app.tsx'], v_anna, false, false
	);

	perform pg_temp.cprg_assert(
		not exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec_code1.id)
			and (select status from public.qorpera_surface_previews where id = v_preview_id) = 'failed'
			and exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec_code2.id and status = 'queued'),
		'superseding a member reconciliation fails matching code_repo reconciling previews so they do not spin forever'
	);
end $$;

rollback;
