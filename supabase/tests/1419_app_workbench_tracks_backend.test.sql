-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.awtb_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'app_workbench_tracks_backend: %', p_message;
	end if;
end $$;

create function pg_temp.awtb_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_contrib constant uuid := '93700000-0000-4000-8000-000000000002';
	v_viewer constant uuid := '93700000-0000-4000-8000-000000000003';
	v_outsider constant uuid := '93700000-0000-4000-8000-000000000004';
	v_exec_owner constant uuid := '93700000-0000-4000-8000-000000000098';
	v_exec_company constant uuid := '93700000-0000-4000-8000-000000000011';
	v_exec_env constant uuid := '93700000-0000-4000-8000-000000000021';
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env_id uuid;
	v_staff_id uuid;
	v_app_id uuid;
	v_website_id uuid;
	v_identity_id uuid;
	v_track_a uuid;
	v_track_b uuid;
	v_track_c uuid;
	v_track_d uuid;
	v_track_guard uuid;
	v_track_dep uuid;
	v_track_sup uuid;
	v_track_ready_retry uuid;
	v_track_stop uuid;
	v_track_empty uuid;
	v_track_internal uuid;
	v_web_session uuid;
	v_id_session uuid;
	v_lease_a uuid := extensions.gen_random_uuid();
	v_lease_b uuid := extensions.gen_random_uuid();
	v_lease_c uuid := extensions.gen_random_uuid();
	v_lease_d uuid := extensions.gen_random_uuid();
	v_lease_guard uuid := extensions.gen_random_uuid();
	v_lease_dep uuid := extensions.gen_random_uuid();
	v_lease_sup uuid := extensions.gen_random_uuid();
	v_lease_ready_retry uuid := extensions.gen_random_uuid();
	v_lease_stop uuid := extensions.gen_random_uuid();
	v_lease_resume uuid := extensions.gen_random_uuid();
	v_lease_id_stop uuid := extensions.gen_random_uuid();
	v_coding_lease uuid := extensions.gen_random_uuid();
	v_ch_a1 uuid;
	v_ch_a2 uuid;
	v_ch_a3 uuid;
	v_ch_b1 uuid;
	v_ch_c1 uuid;
	v_ch_d1 uuid;
	v_ch_guard uuid;
	v_ch_dep uuid;
	v_ch_sup uuid;
	v_ch_ready_retry uuid;
	v_art jsonb;
	v_art_v2 jsonb;
	v_art_full jsonb;
	v_prog jsonb;
	v_sess_json jsonb;
	v_preview jsonb;
	v_ws jsonb;
	v_ship jsonb;
	v_comb jsonb;
	v_comb_job_id uuid;
	v_comb_lease uuid := extensions.gen_random_uuid();
	v_rec_id uuid;
	v_rec_session_id uuid;
	v_rec_lease uuid := extensions.gen_random_uuid();
	v_sup_rec_id uuid;
	v_sup_rec_session_id uuid;
	v_sup_rec_lease uuid := extensions.gen_random_uuid();
	v_retry_rec_id uuid;
	v_ready_rec_id uuid;
	v_ready_rec_session_id uuid;
	v_ready_rec_lease uuid := extensions.gen_random_uuid();
	v_ready_job_payload jsonb;
	v_dep_job_id uuid;
	v_dep_job_lease uuid := extensions.gen_random_uuid();
	v_dep_job_payload jsonb;
	v_synth_job_id uuid;
	v_stopped jsonb;
	v_summary jsonb;
	v_surface_row public.qorpera_surfaces%rowtype;
	v_worker_id uuid;
	v_wake_id uuid;
	v_enq jsonb;
	v_enq_resume jsonb;
	v_vm_id uuid := extensions.gen_random_uuid();
	v_vol_id uuid := extensions.gen_random_uuid();
	v_epoch_before integer;
	v_epoch_after integer;
	v_worker_state text;
	v_worker_seq integer;
	v_coding_phase text;
	v_coding_archived timestamptz;
	v_coding_branch text;
	v_expected_branch text;
	v_coding_vm uuid;
	v_coding_vol uuid;
	v_turn_state text;
	v_wake_status text;
	v_msg_count integer;
	v_errcode text;
	v_i integer;
	v_sha_base constant text := repeat('a', 40);
	v_sha_1 constant text := repeat('1', 40);
	v_sha_2 constant text := repeat('2', 40);
	v_sha_3 constant text := repeat('3', 40);
	v_sha_4 constant text := repeat('4', 40);
	v_sha_5 constant text := repeat('5', 40);
	v_sha_6 constant text := repeat('6', 40);
	v_sha_7 constant text := repeat('7', 40);
	v_sha_8 constant text := repeat('8', 40);
	v_host_call_count integer;
	v_obs_check boolean;
	v_begin_check boolean;
	v_cancel_guard_check boolean;
	v_land_payload jsonb;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select count(*) into v_host_call_count
	from public.qorpera_native_host_calls
	where name in ('qorpera_native_surface_upsert_artifact', 'qorpera_native_surface_report_progress')
		and scope = 'profile';
	perform pg_temp.awtb_assert(v_host_call_count = 2, 'Both workbench native RPCs must be registered in qorpera_native_host_calls');

	perform pg_temp.awtb_assert(
		(select relrowsecurity from pg_class where oid = 'public.qorpera_surface_session_artifacts'::regclass),
		'qorpera_surface_session_artifacts must have RLS enabled'
	);
	perform pg_temp.awtb_assert(
		not has_table_privilege('anon', 'public.qorpera_surface_session_artifacts', 'SELECT')
		and not has_table_privilege('authenticated', 'public.qorpera_surface_session_artifacts', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_session_artifacts', 'SELECT'),
		'qorpera_surface_session_artifacts must revoke direct API table access'
	);

	select environment_id, staff_agent_id into strict v_env_id, v_staff_id
	from public.qorpera_company_cofounders
	where profile_id = v_profile
	limit 1;

	insert into auth.users(id, email) values
		(v_contrib, 'contrib-937@example.test'),
		(v_viewer, 'viewer-937@example.test'),
		(v_outsider, 'outsider-937@example.test'),
		(v_exec_owner, 'exec-owner-937@example.test')
	on conflict (id) do nothing;

	insert into public.qorpera_profiles(id, name, created_by_user_id)
	values (v_exec_company, 'Executor Template Co 937', v_exec_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_exec_env, v_exec_company, 'Executor Template Env 937', 1, v_exec_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_exec_env, 'exec-1419', true, array['codex', 'claude-code']);
	reset role;

	insert into public.qorpera_profile_members(profile_id, user_id, email, role, display_name) values
		(v_profile, v_contrib, 'contrib-937@example.test', 'contributor', 'Contributor'),
		(v_profile, v_viewer, 'viewer-937@example.test', 'viewer', 'Viewer')
	on conflict (profile_id, user_id) do update set role = excluded.role;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	v_app_id := (public.qorpera_create_surface(
		v_profile, 'Core Web App', 'core-web-app', 'live_build', 'web_app', 'monitor', null, null, null, false
	) ->> 'id')::uuid;
	v_website_id := (public.qorpera_create_surface(
		v_profile, 'Public Site', 'public-site', 'live_build', 'website', 'globe', null, null, null, false
	) ->> 'id')::uuid;
	v_identity_id := (public.qorpera_create_surface(
		v_profile, 'Brand Identity', 'brand-identity', 'studio', 'identity', 'palette', null, 'brand-id', null, false
	) ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces
	set live_head_sha = v_sha_base
	where id in (v_app_id, v_website_id);

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	v_track_a := (public.qorpera_start_surface_session(v_app_id, 'Redesign billing settings', 'Billing settings') ->> 'id')::uuid;
	v_track_b := (public.qorpera_start_surface_session(v_app_id, 'Add keyboard shortcuts', 'Keyboard shortcuts') ->> 'id')::uuid;
	v_track_c := (public.qorpera_start_surface_session(v_app_id, 'Improve onboarding flow', 'Onboarding flow') ->> 'id')::uuid;
	v_track_d := (public.qorpera_start_surface_session(v_app_id, 'Export CSV reports', 'CSV export') ->> 'id')::uuid;
	v_track_guard := (public.qorpera_start_surface_session(v_app_id, 'Guard active merge job', 'Active job guard') ->> 'id')::uuid;
	v_track_dep := (public.qorpera_start_surface_session(v_app_id, 'Add CSV charts on top of CSV export', 'CSV charts') ->> 'id')::uuid;
	v_track_sup := (public.qorpera_start_surface_session(v_app_id, 'Add CSV filters on top of CSV export', 'CSV filters') ->> 'id')::uuid;
	v_track_ready_retry := (public.qorpera_start_surface_session(v_app_id, 'Add CSV summary on top of CSV export', 'CSV summary') ->> 'id')::uuid;
	v_track_stop := (public.qorpera_start_surface_session(v_app_id, 'Refactor auth middleware', 'Auth refactor') ->> 'id')::uuid;
	v_track_empty := (public.qorpera_start_surface_session(v_app_id, 'Discuss roadmap only', 'Roadmap chat') ->> 'id')::uuid;
	v_web_session := (public.qorpera_start_surface_session(v_website_id, 'Update hero copy', 'Hero copy') ->> 'id')::uuid;
	v_id_session := (public.qorpera_start_surface_session(v_identity_id, 'Tune palette', 'Tune palette') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_a, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-a'
	where id = v_track_a;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_b, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-b'
	where id = v_track_b;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_c, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-c'
	where id = v_track_c;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_d, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-d'
	where id = v_track_d;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_guard, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-guard'
	where id = v_track_guard;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_dep, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-dep'
	where id = v_track_dep;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_sup, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-sup'
	where id = v_track_sup;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_ready_retry, lease_expires_at = clock_timestamp() + interval '10 minutes',
		track_branch = 'qorpera/coding/track-ready-retry'
	where id = v_track_ready_retry;
	update public.qorpera_surface_sessions
	set state = 'ready', has_active_chat = true, lease_token = null
	where id = v_track_empty;

	perform pg_temp.as_service();
	v_art := public.qorpera_native_surface_upsert_artifact(
		v_profile, v_track_a, v_lease_a, 'mockup', 'Billing-Mockup', 'Billing layout v1',
		'First mockup proposal', 'html', '<main><h1>Billing v1</h1></main>', null, null
	);
	perform pg_temp.awtb_assert(v_art ->> 'artifactKey' = 'billing-mockup', 'artifactKey must normalize lowercase');
	perform pg_temp.awtb_assert((v_art ->> 'revision')::integer = 1, 'Initial artifact revision must be 1');

	v_art_v2 := public.qorpera_native_surface_upsert_artifact(
		v_profile, v_track_a, v_lease_a, 'mockup', 'billing-mockup', 'Billing layout v2',
		'Refined mockup', 'html', '<main><h1>Billing v2</h1></main>', null, null
	);
	perform pg_temp.awtb_assert((v_art_v2 ->> 'id')::uuid = (v_art ->> 'id')::uuid, 'Upsert on same key must keep id');
	perform pg_temp.awtb_assert((v_art_v2 ->> 'revision')::integer = 2, 'Upsert on same key must increment revision to 2');

	perform public.qorpera_native_surface_upsert_artifact(
		v_profile, v_track_a, v_lease_a, 'mockup', 'billing-shot', 'Screenshot',
		null, 'image_ref', null,
		jsonb_build_object('sha256', repeat('b', 64), 'bytes', 2048, 'mediaType', 'image/png'), null
	);

	begin
		perform public.qorpera_native_surface_upsert_artifact(
			v_profile, v_track_a, v_lease_a, 'mockup', 'bad-img-str', 'Bad',
			null, 'image_ref', null,
			jsonb_build_object('sha256', repeat('b', 64), 'bytes', '2048', 'mediaType', 'image/png'), null
		);
		perform pg_temp.awtb_assert(false, 'String imageRef.bytes must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '22023', 'Expected 22023 for string imageRef.bytes, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_native_surface_upsert_artifact(
			v_profile, v_track_a, v_lease_a, 'mockup', 'bad-img-big', 'Bad',
			null, 'image_ref', null,
			jsonb_build_object('sha256', repeat('b', 64), 'bytes', 9000000, 'mediaType', 'image/png'), null
		);
		perform pg_temp.awtb_assert(false, 'Oversized imageRef.bytes must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '22023', 'Expected 22023 for oversized imageRef.bytes, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_native_surface_upsert_artifact(
			v_profile, v_track_a, extensions.gen_random_uuid(), 'plan', 'unauth', 'Bad lease',
			null, 'markdown', '# Plan', null, null
		);
		perform pg_temp.awtb_assert(false, 'Wrong lease token must raise 42501');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '42501', 'Expected 42501 for bad lease token, got ' || v_errcode);
	end;

	for v_i in 1..30 loop
		perform public.qorpera_native_surface_upsert_artifact(
			v_profile, v_track_a, v_lease_a, 'report', 'cap-' || v_i::text, 'Cap ' || v_i::text,
			null, 'markdown', 'Body ' || v_i::text, null, null
		);
	end loop;
	begin
		perform public.qorpera_native_surface_upsert_artifact(
			v_profile, v_track_a, v_lease_a, 'report', 'cap-overflow', 'Overflow',
			null, 'markdown', 'Too many', null, null
		);
		perform pg_temp.awtb_assert(false, '33rd artifact in session must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for 32-artifact cap, got ' || v_errcode);
	end;

	v_prog := public.qorpera_native_surface_report_progress(
		v_profile, v_track_a, v_lease_a,
		'Running billing unit tests',
		jsonb_build_array(
			jsonb_build_object('id', 's1', 'label', 'Design mockup', 'status', 'done'),
			jsonb_build_object('id', 's2', 'label', 'Wire billing API', 'status', 'in_progress', 'detail', 'Updating invoices')
		),
		jsonb_build_object(
			'status', 'passed',
			'summary', '12 tests passed',
			'commands', jsonb_build_array(jsonb_build_object('name', 'vitest', 'status', 'passed', 'durationMs', 1420))
		)
	);
	perform pg_temp.awtb_assert(v_prog ->> 'currentActivity' = 'Running billing unit tests', 'currentActivity must persist');
	perform pg_temp.awtb_assert(jsonb_array_length(v_prog -> 'progressSteps') = 2, 'progressSteps must persist');
	perform pg_temp.awtb_assert(v_prog #>> '{checksSummary,status}' = 'passed', 'checksSummary must persist');

	v_prog := public.qorpera_native_surface_report_progress(v_profile, v_track_a, v_lease_a, '', null, null);
	perform pg_temp.awtb_assert(v_prog ->> 'currentActivity' is null, 'Empty string must clear currentActivity');
	perform pg_temp.awtb_assert(jsonb_array_length(v_prog -> 'progressSteps') = 2, 'Null progressSteps must preserve existing steps');

	perform public.qorpera_native_surface_report_progress(v_profile, v_track_a, v_lease_a, 'Wrapping up', null, null);

	begin
		perform public.qorpera_native_surface_report_progress(
			v_profile, v_track_a, v_lease_a, null,
			jsonb_build_array(jsonb_build_object('id', 's1', 'label', 'Bad', 'status', 'unknown_status')),
			null
		);
		perform pg_temp.awtb_assert(false, 'Invalid progress step status must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '22023', 'Expected 22023 for invalid progress step status, got ' || v_errcode);
	end;

	v_ch_a1 := (public.qorpera_native_surface_record_change(
		v_profile, v_track_a, 'Billing form core', 'Core billing form', 'git_range',
		v_sha_base, v_sha_1, '{}'::uuid[], array['src/billing.ts'], null, null, false, v_lease_a
	) ->> 'changeId')::uuid;
	v_ch_a2 := (public.qorpera_native_surface_record_change(
		v_profile, v_track_a, 'Compact card option', 'Compact layout', 'git_range',
		v_sha_1, v_sha_2, '{}'::uuid[], array['src/billing-card.ts'], null, null, false, v_lease_a,
		'billing-card-style', 'Card style'
	) ->> 'changeId')::uuid;
	v_ch_a3 := (public.qorpera_native_surface_record_change(
		v_profile, v_track_a, 'Spacious card option', 'Spacious layout', 'git_range',
		v_sha_1, v_sha_3, '{}'::uuid[], array['src/billing-card.ts'], null, null, false, v_lease_a,
		'billing-card-style', 'Card style'
	) ->> 'changeId')::uuid;

	v_ch_b1 := (public.qorpera_native_surface_record_change(
		v_profile, v_track_b, 'Shortcut palette', 'Adds cmd-k', 'git_range',
		v_sha_base, v_sha_4, '{}'::uuid[], array['src/shortcuts.ts'], null, null, false, v_lease_b
	) ->> 'changeId')::uuid;
	v_ch_c1 := (public.qorpera_native_surface_record_change(
		v_profile, v_track_c, 'Onboarding checklist', 'Adds steps', 'git_range',
		v_sha_base, v_sha_5, '{}'::uuid[], array['src/onboarding.ts'], null, null, false, v_lease_c
	) ->> 'changeId')::uuid;
	v_ch_d1 := (public.qorpera_native_surface_record_change(
		v_profile, v_track_d, 'CSV exporter', 'Adds export', 'git_range',
		v_sha_base, v_sha_6, '{}'::uuid[], array['src/csv.ts'], null, null, false, v_lease_d
	) ->> 'changeId')::uuid;
	v_ch_guard := (public.qorpera_native_surface_record_change(
		v_profile, v_track_guard, 'Guard check', 'Checks active job guard', 'git_range',
		v_sha_base, v_sha_7, '{}'::uuid[], array['src/guard.ts'], null, null, false, v_lease_guard
	) ->> 'changeId')::uuid;
	v_ch_dep := (public.qorpera_native_surface_record_change(
		v_profile, v_track_dep, 'CSV charts', 'Depends on CSV export preview', 'git_range',
		v_sha_6, v_sha_8, '{}'::uuid[], array['src/csv-charts.ts'], null, null, false, v_lease_dep
	) ->> 'changeId')::uuid;
	v_ch_sup := (public.qorpera_native_surface_record_change(
		v_profile, v_track_sup, 'CSV filters', 'Depends on CSV export preview', 'git_range',
		v_sha_6, repeat('c', 40), '{}'::uuid[], array['src/csv-filters.ts'], null, null, false, v_lease_sup
	) ->> 'changeId')::uuid;
	v_ch_ready_retry := (public.qorpera_native_surface_record_change(
		v_profile, v_track_ready_retry, 'CSV summary', 'Depends on CSV export preview', 'git_range',
		v_sha_6, repeat('d', 40), '{}'::uuid[], array['src/csv-summary.ts'], null, null, false, v_lease_ready_retry
	) ->> 'changeId')::uuid;
	update public.qorpera_surface_changes
	set preview_base_change_ids = array[v_ch_d1]
	where id in (v_ch_dep, v_ch_sup, v_ch_ready_retry);

	perform public.qorpera_surface_complete_session_turn(v_track_a, 'ready', 'Billing mockup and changes ready.', null, null, null, v_lease_a);
	perform public.qorpera_surface_complete_session_turn(v_track_b, 'ready', 'Shortcuts ready.', null, null, null, v_lease_b);
	perform public.qorpera_surface_complete_session_turn(v_track_c, 'ready', 'Onboarding ready.', null, null, null, v_lease_c);
	perform public.qorpera_surface_complete_session_turn(v_track_d, 'ready', 'CSV ready.', null, null, null, v_lease_d);
	perform public.qorpera_surface_complete_session_turn(v_track_guard, 'ready', 'Guard ready.', null, null, null, v_lease_guard);
	perform public.qorpera_surface_complete_session_turn(v_track_dep, 'ready', 'Charts ready.', null, null, null, v_lease_dep);
	perform public.qorpera_surface_complete_session_turn(v_track_sup, 'ready', 'Filters ready.', null, null, null, v_lease_sup);
	perform public.qorpera_surface_complete_session_turn(v_track_ready_retry, 'ready', 'Summary ready.', null, null, null, v_lease_ready_retry);

	select public.qorpera_surface_session_json(s) into v_sess_json
	from public.qorpera_surface_sessions s where s.id = v_track_a;
	perform pg_temp.awtb_assert(v_sess_json ->> 'trackBranch' = 'qorpera/coding/track-a', 'session JSON must expose trackBranch');
	perform pg_temp.awtb_assert(v_sess_json ->> 'currentActivity' is null, 'complete_session_turn must clear currentActivity');
	perform pg_temp.awtb_assert(jsonb_array_length(v_sess_json -> 'progressSteps') = 2, 'complete_session_turn must retain progressSteps');
	perform pg_temp.awtb_assert(v_sess_json #>> '{checksSummary,status}' = 'passed', 'complete_session_turn must retain checksSummary');
	perform pg_temp.awtb_assert(jsonb_array_length(v_sess_json -> 'artifacts') = 32, 'session JSON must expose all session artifacts');
	perform pg_temp.awtb_assert(
		(v_sess_json -> 'artifacts' -> 0 ->> 'contentText') is null,
		'session JSON must omit inline artifact contentText to prevent payload bloat'
	);
	reset role;

	perform pg_temp.awtb_as(v_viewer);
	set local role authenticated;
	v_art_full := public.qorpera_get_surface_session_artifact((v_art_v2 ->> 'id')::uuid);
	perform pg_temp.awtb_assert(
		v_art_full ->> 'contentText' = '<main><h1>Billing v2</h1></main>' and (v_art_full ->> 'revision')::integer = 2,
		'qorpera_get_surface_session_artifact must return full contentText to company members'
	);
	reset role;

	perform pg_temp.awtb_as(v_outsider);
	set local role authenticated;
	begin
		perform public.qorpera_get_surface_session_artifact((v_art_v2 ->> 'id')::uuid);
		perform pg_temp.awtb_assert(false, 'Non-member must not read surface session artifact');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '42501', 'Expected 42501 for non-member artifact read, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	v_preview := public.qorpera_select_surface_track_preview(v_app_id, v_track_a, null, '/billing');
	perform pg_temp.awtb_assert(v_preview ->> 'previewScope' = 'track', 'Single track selection must set previewScope = track');
	perform pg_temp.awtb_assert((v_preview ->> 'selectedSessionId')::uuid = v_track_a, 'selectedSessionId must match track A');
	perform pg_temp.awtb_assert(
		jsonb_array_length(v_preview #> '{primary,toggledChangeIds}') = 2
		and (v_preview #> '{primary,toggledChangeIds}') ? v_ch_a1::text
		and (v_preview #> '{primary,toggledChangeIds}') ? v_ch_a2::text
		and not ((v_preview #> '{primary,toggledChangeIds}') ? v_ch_a3::text)
		and not ((v_preview #> '{primary,toggledChangeIds}') ? v_ch_b1::text),
		'Single track preview must isolate track A, pick first option per group, and never bleed track B'
	);

	v_ws := public.qorpera_get_surface_workspace(v_app_id);
	perform pg_temp.awtb_assert(v_ws #>> '{previewState,previewScope}' = 'track', 'Workspace must return persisted previewScope');
	perform pg_temp.awtb_assert((v_ws #>> '{previewState,selectedSessionId}')::uuid = v_track_a, 'Workspace must return persisted selectedSessionId');

	v_preview := public.qorpera_select_surface_track_preview(v_app_id, null, array[v_track_b, v_track_c], '/');
	perform pg_temp.awtb_assert(v_preview ->> 'previewScope' = 'explicit', 'Combine preview must set previewScope = explicit');
	perform pg_temp.awtb_assert(v_preview ->> 'selectedSessionId' is null, 'Combine preview must clear selectedSessionId');
	perform pg_temp.awtb_assert(
		jsonb_array_length(v_preview #> '{primary,toggledChangeIds}') = 2
		and (v_preview #> '{primary,toggledChangeIds}') ? v_ch_b1::text
		and (v_preview #> '{primary,toggledChangeIds}') ? v_ch_c1::text
		and not ((v_preview #> '{primary,toggledChangeIds}') ? v_ch_d1::text),
		'Combine preview must include only selected tracks'
	);

	v_preview := public.qorpera_set_preview_selection(v_app_id, array[v_ch_b1], null, '{}'::uuid[], '/');
	perform pg_temp.awtb_assert(v_preview ->> 'previewScope' = 'combined', 'Legacy set_preview_selection must reset previewScope = combined');
	perform pg_temp.awtb_assert(v_preview ->> 'selectedSessionId' is null, 'Legacy set_preview_selection must reset selectedSessionId');

	v_preview := public.qorpera_select_surface_track_preview(v_app_id, null, null, '/');
	perform pg_temp.awtb_assert(v_preview #>> '{primary,status}' = 'live_baseline', 'Null track selection must show live_baseline');
	perform pg_temp.awtb_assert(jsonb_array_length(v_preview #> '{primary,toggledChangeIds}') = 0, 'Null track selection must clear toggledChangeIds');

	begin
		perform public.qorpera_select_surface_track_preview(v_app_id, v_track_a, array[v_track_a, v_track_b], '/');
		perform pg_temp.awtb_assert(false, 'Passing both sessionId and combineSessionIds must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '22023', 'Expected 22023 for both sessionId and combineSessionIds, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_select_surface_track_preview(v_app_id, v_web_session, null, '/');
		perform pg_temp.awtb_assert(false, 'Cross-surface track preview must raise 42501');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '42501', 'Expected 42501 for cross-surface track, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_ship_surface_track(v_track_a, false);
		perform pg_temp.awtb_assert(false, 'Shipping track with unresolved option group must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for unresolved option group, got ' || v_errcode);
	end;

	begin
		perform public.qorpera_ship_surface_track(v_track_empty, false);
		perform pg_temp.awtb_assert(false, 'Shipping track with no open changes and publish=false must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for empty track ship, got ' || v_errcode);
	end;

	perform public.qorpera_choose_surface_change_option(v_ch_a2);
	perform public.qorpera_select_surface_track_preview(v_app_id, v_track_a, null, '/billing');
	reset role;

	perform pg_temp.awtb_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_ship_surface_track(v_track_a, false);
		perform pg_temp.awtb_assert(false, 'Viewer must not ship a track');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '42501', 'Expected 42501 for viewer ship, got ' || v_errcode);
	end;
	v_comb := public.qorpera_combine_surface_tracks(v_app_id, array[v_track_b, v_track_c], false);
	perform pg_temp.awtb_assert(v_comb ->> 'mode' = 'preview', 'Viewer may preview combined tracks');
	begin
		perform public.qorpera_combine_surface_tracks(v_app_id, array[v_track_b, v_track_c], true);
		perform pg_temp.awtb_assert(false, 'Viewer must not combine and land tracks');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '42501', 'Expected 42501 for viewer combine+land, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	v_ship := public.qorpera_ship_surface_track(v_track_a, true);
	perform pg_temp.awtb_assert((v_ship ->> 'id')::uuid = v_track_a, 'Ship must return track A JSON');
	reset role;

	select payload into v_land_payload
	from public.qorpera_surface_jobs
	where session_id = v_track_a and kind = 'land_change'
	order by created_at desc limit 1;
	perform pg_temp.awtb_assert((v_land_payload ->> 'autoPublish')::boolean = true, 'Ship with publish=true must set autoPublish=true');
	perform pg_temp.awtb_assert((v_land_payload ->> 'trackSessionId')::uuid = v_track_a, 'Ship job must record trackSessionId');
	perform pg_temp.awtb_assert(
		(select status from public.qorpera_surface_changes where id = v_ch_a1) = 'merging'
		and (select status from public.qorpera_surface_changes where id = v_ch_a2) = 'merging'
		and (select status from public.qorpera_surface_changes where id = v_ch_b1) = 'staged',
		'Shipping track A must only merge track A and leave track B staged'
	);
	perform pg_temp.awtb_assert(
		(select selected_session_id is null and preview_scope = 'combined'
		 from public.qorpera_member_surface_state
		 where user_id = v_owner and surface_id = v_app_id),
		'Shipping selected track must clear selected_session_id and reset preview_scope'
	);

	perform pg_temp.awtb_as(v_contrib);
	set local role authenticated;
	v_comb := public.qorpera_combine_surface_tracks(v_app_id, array[v_track_b, v_track_c], true);
	perform pg_temp.awtb_assert(v_comb ->> 'mode' = 'land', 'Combine with land=true must return mode=land');
	v_comb_job_id := (v_comb ->> 'jobId')::uuid;
	perform pg_temp.awtb_assert(v_comb_job_id is not null, 'Combine land must enqueue a surface job');
	perform pg_temp.awtb_assert(jsonb_array_length(v_comb -> 'changeIds') = 2, 'Combine land must include changes from B and C');
	reset role;

	perform pg_temp.awtb_assert(
		(select status from public.qorpera_surface_changes where id = v_ch_b1) = 'merging'
		and (select status from public.qorpera_surface_changes where id = v_ch_c1) = 'merging'
		and (select status from public.qorpera_surface_changes where id = v_ch_d1) = 'staged',
		'Combining B+C must leave unselected track D staged'
	);

	update public.qorpera_surface_jobs
	set status = 'running', lease_token = v_comb_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_comb_job_id;
	perform pg_temp.as_service();
	perform public.qorpera_surface_complete_merge(
		v_comb_job_id, 'landed', v_sha_base, v_sha_5, null, null, null, null, v_comb_lease
	);
	reset role;
	perform pg_temp.awtb_assert(
		(select state from public.qorpera_surface_sessions where id = v_track_b) = 'completed'
		and (select state from public.qorpera_surface_sessions where id = v_track_c) = 'completed',
		'Completing a combined land_change job must evaluate and close every combined track'
	);

	insert into public.qorpera_surface_jobs(
		profile_id, surface_id, session_id, kind, status, payload, requested_by_user_id
	)
	values (
		v_profile, v_app_id, v_track_guard, 'land_change', 'queued',
		jsonb_build_object('changeIds', jsonb_build_array(v_ch_guard)),
		v_owner
	)
	returning id into v_synth_job_id;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_ship_surface_track(v_track_guard, false);
		perform pg_temp.awtb_assert(false, 'Shipping track with active land_change job must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for active job guard on ship, got ' || v_errcode);
	end;
	begin
		perform public.qorpera_combine_surface_tracks(v_app_id, array[v_track_guard, v_track_d], true);
		perform pg_temp.awtb_assert(false, 'Combining track with active land_change job must raise 55000');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for active job guard on combine, got ' || v_errcode);
	end;
	reset role;
	delete from public.qorpera_surface_jobs where id = v_synth_job_id;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_select_surface_track_preview(v_app_id, v_track_dep, null, '/charts');
	perform public.qorpera_ship_surface_track(v_track_dep, true);
	reset role;
	perform pg_temp.awtb_assert(
		(select status from public.qorpera_surface_changes where id = v_ch_dep) = 'staged',
		'Shipping track with omitted preview base change must defer merge to silent reconciliation'
	);
	perform pg_temp.awtb_assert(
		(select selected_session_id is null and preview_scope = 'combined' and v_ch_dep = any(toggled_change_ids)
		 from public.qorpera_member_surface_state
		 where user_id = v_owner and surface_id = v_app_id),
		'Deferred track ship must unpin selected_session_id while preserving toggled_change_ids'
	);
	select r.id, r.session_id into v_rec_id, v_rec_session_id
	from public.qorpera_surface_reconciliations r
	where r.surface_id = v_app_id
		and r.status in ('queued', 'running')
		and v_ch_dep = any(r.selected_change_ids)
	limit 1;
	perform pg_temp.awtb_assert(
		v_rec_id is not null and v_rec_session_id is not null
		and (select auto_approve_after and auto_publish_after from public.qorpera_surface_reconciliations where id = v_rec_id),
		'Deferred track ship with publish=true must persist auto_approve_after and auto_publish_after on reconciliation'
	);

	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = v_rec_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_rec_session_id;
	perform pg_temp.as_service();
	perform public.qorpera_native_surface_record_change(
		v_profile, v_rec_session_id, 'Standalone CSV charts', 'Reconciled without CSV export base', 'git_range',
		v_sha_5, repeat('9', 40), '{}'::uuid[], array['src/csv-charts.ts'], null, null, false, v_rec_lease
	);
	reset role;

	select j.id, j.payload into v_dep_job_id, v_dep_job_payload
	from public.qorpera_surface_jobs j
	where j.surface_id = v_app_id
		and j.kind = 'land_change'
		and j.status = 'queued'
		and (j.payload -> 'changeIds') ? v_ch_dep::text
	order by j.created_at desc
	limit 1;
	perform pg_temp.awtb_assert(
		v_dep_job_id is not null and coalesce((v_dep_job_payload ->> 'autoPublish')::boolean, false) = true,
		'Reconciliation completion must carry deferred publish intent into land_change.autoPublish'
	);
	perform pg_temp.awtb_assert(
		(select not auto_approve_after and not auto_publish_after from public.qorpera_surface_reconciliations where id = v_rec_id),
		'Reconciliation completion must clear auto_approve_after and auto_publish_after'
	);

	update public.qorpera_surface_jobs
	set status = 'running', lease_token = v_dep_job_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_dep_job_id;
	perform pg_temp.as_service();
	perform public.qorpera_surface_complete_merge(
		v_dep_job_id, 'landed', v_sha_5, repeat('9', 40), null, null, null, null, v_dep_job_lease
	);
	reset role;
	perform pg_temp.awtb_assert(
		(select state from public.qorpera_surface_sessions where id = v_track_dep) = 'completed'
		and exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_app_id and j.kind = 'publish_surface' and j.status = 'queued'
		),
		'Completing deferred land_change with carried publish intent must close track and queue publish_surface'
	);
	delete from public.qorpera_surface_jobs where surface_id = v_app_id and kind = 'publish_surface';
	update public.qorpera_surfaces set publish_status = 'idle', site_id = null where id = v_app_id;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_ship_surface_track(v_track_sup, true);
	reset role;
	update public.qorpera_surfaces set live_head_sha = repeat('e', 40) where id = v_app_id;
	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	v_sup_rec_id := (public.qorpera_ensure_surface_reconciliation(v_app_id, array[v_ch_sup], '{}'::text[], false) ->> 'id')::uuid;
	reset role;
	select session_id into strict v_sup_rec_session_id from public.qorpera_surface_reconciliations where id = v_sup_rec_id;
	perform pg_temp.awtb_assert(
		(select auto_approve_after and auto_publish_after from public.qorpera_surface_reconciliations where id = v_sup_rec_id),
		'Superseding a queued deferred-publish reconciliation must preserve auto_approve_after and auto_publish_after'
	);

	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = v_sup_rec_lease, lease_expires_at = clock_timestamp() + interval '5 minutes'
	where id = v_sup_rec_session_id;
	update public.qorpera_surfaces set live_head_sha = repeat('f', 40) where id = v_app_id;
	perform pg_temp.as_service();
	perform public.qorpera_native_surface_record_change(
		v_profile, v_sup_rec_session_id, 'Standalone CSV filters', 'Reconciled against older head', 'git_range',
		repeat('e', 40), repeat('0', 40), '{}'::uuid[], array['src/csv-filters.ts'], null, null, false, v_sup_rec_lease
	);
	reset role;
	select r.id into v_retry_rec_id
	from public.qorpera_surface_reconciliations r
	where r.surface_id = v_app_id
		and r.status in ('queued', 'running')
		and v_ch_sup = any(r.selected_change_ids)
		and r.id <> v_sup_rec_id
	order by r.created_at desc
	limit 1;
	perform pg_temp.awtb_assert(
		v_retry_rec_id is not null
		and (select auto_approve_after and auto_publish_after from public.qorpera_surface_reconciliations where id = v_retry_rec_id),
		'Queued reconciliation retry after head moved must preserve auto_publish_after'
	);

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_ship_surface_track(v_track_ready_retry, true);
	reset role;
	select r.id, r.session_id into strict v_ready_rec_id, v_ready_rec_session_id
	from public.qorpera_surface_reconciliations r
	where r.surface_id = v_app_id
		and r.status in ('queued', 'running')
		and v_ch_ready_retry = any(r.selected_change_ids)
	limit 1;
	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = v_ready_rec_lease, lease_expires_at = clock_timestamp() + interval '5 minutes',
		origin_ref = origin_ref - 'omittedBaseChanges'
	where id = v_ready_rec_session_id;
	update public.qorpera_surfaces set live_head_sha = repeat('b', 40) where id = v_app_id;
	select * into strict v_surface_row from public.qorpera_surfaces where id = v_app_id;
	insert into public.qorpera_surface_reconciliations(
		profile_id, surface_id, composition_key, base_fingerprint,
		selected_change_ids, status, conflict_paths, auto_approve_after, auto_publish_after,
		reconciled_commit_sha, created_by_user_id, updated_at, expires_at
	)
	values (
		v_profile, v_app_id,
		(public.qorpera_surface_reconciliation_key(v_surface_row, array[v_ch_ready_retry]) ->> 'compositionKey'),
		public.qorpera_surface_base_fingerprint(v_surface_row),
		array[v_ch_ready_retry], 'ready', '{}'::text[], false, false,
		repeat('7', 40), v_owner, clock_timestamp(), clock_timestamp() + interval '1 hour'
	);
	perform pg_temp.as_service();
	perform public.qorpera_native_surface_record_change(
		v_profile, v_ready_rec_session_id, 'Standalone CSV summary', 'Reconciled against older head', 'git_range',
		repeat('f', 40), repeat('1', 40), '{}'::uuid[], array['src/csv-summary.ts'], null, null, false, v_ready_rec_lease
	);
	reset role;
	select j.payload into v_ready_job_payload
	from public.qorpera_surface_jobs j
	where j.surface_id = v_app_id
		and j.kind = 'land_change'
		and j.status = 'queued'
		and (j.payload -> 'changeIds') ? v_ch_ready_retry::text
	order by j.created_at desc
	limit 1;
	perform pg_temp.awtb_assert(
		v_ready_job_payload is not null
		and (v_ready_job_payload ->> 'reconciliationId') is not null
		and coalesce((v_ready_job_payload ->> 'autoPublish')::boolean, false) = true,
		'Immediate ready-retry reconciliation hit after head moved must carry auto_publish_after into land_change.autoPublish'
	);

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_ship_surface_track(v_track_empty, true);
	reset role;
	perform pg_temp.awtb_assert(
		(select publish_status = 'publishing' and site_id is not null from public.qorpera_surfaces where id = v_app_id)
		and exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_app_id and j.kind = 'publish_surface' and j.status = 'queued'
		),
		'Shipping an empty track with publish=true must delegate to qorpera_publish_surface and ensure site provisioning'
	);

	update public.qorpera_surface_sessions
	set
		state = 'running',
		lease_token = v_lease_stop,
		lease_expires_at = clock_timestamp() + interval '10 minutes',
		current_activity = 'Editing auth middleware'
	where id = v_track_stop;

	perform pg_temp.as_service();
	v_enq := public.qorpera_surface_enqueue_session_run(v_track_stop, v_lease_stop);
	reset role;
	perform pg_temp.awtb_assert(v_enq ->> 'status' = 'enqueued', 'enqueue_session_run must enqueue coding turn: ' || v_enq::text);
	v_worker_id := (v_enq ->> 'workerId')::uuid;
	select branch into strict v_expected_branch from public.qorpera_coding_sessions where worker_id = v_worker_id;
	perform pg_temp.awtb_assert(
		(select track_branch from public.qorpera_surface_sessions where id = v_track_stop) = v_expected_branch,
		'qorpera_surface_enqueue_session_run must backfill track_branch from coding session branch'
	);

	update public.qorpera_coding_sessions
	set
		phase = 'running',
		vm_allocation_id = v_vm_id,
		storage_volume_id = v_vol_id,
		lease_owner = 'runner-1',
		lease_token = v_coding_lease,
		lease_until = clock_timestamp() + interval '5 minutes'
	where worker_id = v_worker_id;

	select epoch into v_epoch_before from public.qorpera_runtime_workers where id = v_worker_id;

	perform pg_temp.awtb_as(v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_cancel_surface_session_turn(v_track_stop);
		perform pg_temp.awtb_assert(false, 'Viewer must not stop a running track turn');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '42501', 'Expected 42501 for viewer stop, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.awtb_as(v_contrib);
	set local role authenticated;
	v_stopped := public.qorpera_cancel_surface_session_turn(v_track_stop);
	perform pg_temp.awtb_assert(v_stopped ->> 'state' = 'ready', 'Stopping a turn must move session to ready');
	perform pg_temp.awtb_assert((v_stopped ->> 'hasActiveChat')::boolean = true, 'Stopping a turn must keep chat active');
	perform pg_temp.awtb_assert(v_stopped ->> 'currentActivity' is null, 'Stopping a turn must clear currentActivity');
	reset role;

	select state, epoch into v_worker_state, v_epoch_after from public.qorpera_runtime_workers where id = v_worker_id;
	select phase, archived_at, branch, vm_allocation_id, storage_volume_id
	into v_coding_phase, v_coding_archived, v_coding_branch, v_coding_vm, v_coding_vol
	from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select outcome ->> 'state' into v_turn_state
	from public.qorpera_coding_session_turns where worker_id = v_worker_id and sequence = 1;

	perform pg_temp.awtb_assert(v_worker_state = 'cancelled', 'Non-destructive stop must cancel active worker turn');
	perform pg_temp.awtb_assert(v_epoch_after = v_epoch_before + 1, 'Non-destructive stop must bump worker epoch');
	perform pg_temp.awtb_assert(v_turn_state = 'cancelled', 'Non-destructive stop must settle open coding turn as cancelled');
	perform pg_temp.awtb_assert(v_coding_phase = 'cancelled' and v_coding_archived is null, 'Non-destructive stop must cancel turn without archiving coding session');
	perform pg_temp.awtb_assert(
		v_coding_branch = v_expected_branch and v_coding_vm = v_vm_id and v_coding_vol = v_vol_id,
		'Non-destructive stop must preserve branch, VM allocation, and storage volume'
	);

	perform pg_temp.as_service();
	begin
		perform public.qorpera_coding_leased_session(v_worker_id, v_coding_lease);
		perform pg_temp.awtb_assert(false, 'Stopped coding lease must be rejected as cancelled');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for cancelled coding lease, got ' || v_errcode);
	end;
	reset role;

	select count(*) into v_msg_count
	from public.qorpera_surface_session_messages
	where session_id = v_track_stop and author_kind = 'system' and body = 'Stopped by member.';
	perform pg_temp.awtb_assert(v_msg_count = 1, 'Stopping turn must append Stopped by member. system message');

	perform pg_temp.awtb_as(v_contrib);
	set local role authenticated;
	perform public.qorpera_cancel_surface_session_turn(v_track_stop);
	reset role;
	select count(*) into v_msg_count
	from public.qorpera_surface_session_messages
	where session_id = v_track_stop and author_kind = 'system' and body = 'Stopped by member.';
	perform pg_temp.awtb_assert(v_msg_count = 1, 'Stopping an idle session must be idempotent');

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_track_stop, 'Use session cookies instead', true);
	reset role;
	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_resume, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_track_stop;
	perform pg_temp.as_service();
	v_enq_resume := public.qorpera_surface_enqueue_session_run(v_track_stop, v_lease_resume);
	reset role;
	perform pg_temp.awtb_assert(
		v_enq_resume ->> 'status' = 'enqueued' and (v_enq_resume ->> 'workerId')::uuid = v_worker_id,
		'Replying after non-destructive stop must resume the same coding worker: ' || v_enq_resume::text
	);
	select state, sequence into v_worker_state, v_worker_seq from public.qorpera_runtime_workers where id = v_worker_id;
	select phase, archived_at, branch, vm_allocation_id, storage_volume_id
	into v_coding_phase, v_coding_archived, v_coding_branch, v_coding_vm, v_coding_vol
	from public.qorpera_coding_sessions where worker_id = v_worker_id;
	perform pg_temp.awtb_assert(
		v_worker_state = 'active' and v_worker_seq = 2 and v_coding_phase = 'input_ready' and v_coding_archived is null
		and v_coding_branch = v_expected_branch and v_coding_vm = v_vm_id and v_coding_vol = v_vol_id
		and exists (
			select 1 from public.qorpera_coding_session_turns t
			where t.worker_id = v_worker_id and t.sequence = 2 and t.outcome is null
		),
		'Resuming a stopped track must open turn 2 on the same branch, VM allocation, and storage volume'
	);

	perform pg_temp.awtb_as(v_contrib);
	set local role authenticated;
	perform public.qorpera_cancel_surface_session_turn(v_track_stop);
	reset role;

	update public.qorpera_surface_sessions
	set state = 'running', lease_token = v_lease_id_stop, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_id_session;
	perform public.qorpera_folder_admit_wakes(v_profile);
	insert into public.qorpera_wake_occurrences(
		id, profile_id, environment_id, wake_kind, source_kind, source_id,
		trigger_id, occurrence_key, scheduled_for, not_before
	)
	values (
		extensions.gen_random_uuid(),
		v_profile,
		v_env_id,
		'agent',
		'surface-session',
		v_id_session,
		'surface-session',
		'surface-session:' || v_id_session::text || ':' || v_lease_id_stop::text,
		clock_timestamp(),
		clock_timestamp()
	)
	returning id into v_wake_id;
	update public.qorpera_surface_sessions set wake_id = v_wake_id where id = v_id_session;
	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_cancel_surface_session_turn(v_id_session);
	reset role;
	select status into v_wake_status from public.qorpera_wake_occurrences where id = v_wake_id;
	perform pg_temp.awtb_assert(v_wake_status = 'cancelled', 'Stopping a wake-backed session turn must cancel its queued wake');

	insert into public.qorpera_surface_sessions(
		profile_id, surface_id, title, prompt, state, origin_kind, is_internal
	)
	values (v_profile, v_app_id, 'Internal reconcile', 'Reconcile', 'reconciling_running', 'member', true)
	returning id into v_track_internal;
	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_cancel_surface_session_turn(v_track_internal);
		perform pg_temp.awtb_assert(false, 'Internal reconciliation session must not be cancelled by member');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.awtb_assert(v_errcode = '55000', 'Expected 55000 for internal session cancel, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.awtb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_select_surface_track_preview(v_app_id, v_track_d, null, '/');
	perform public.qorpera_discard_surface_session(v_track_d);
	reset role;
	perform pg_temp.awtb_assert(
		(select selected_session_id is null
		 from public.qorpera_member_surface_state
		 where user_id = v_owner and surface_id = v_app_id),
		'Discarding selected session must clear selected_session_id'
	);

	update public.qorpera_surface_sessions set state = 'needs_input' where id in (v_track_stop, v_web_session, v_id_session);
	update public.qorpera_surface_changes set status = 'conflicted' where id = v_ch_guard;
	select * into strict v_surface_row from public.qorpera_surfaces where id = v_app_id;
	v_summary := public.qorpera_surface_summary_json(v_surface_row);
	perform pg_temp.awtb_assert(
		(v_summary ->> 'needsAttentionCount')::integer = 1,
		'web_app summary must count attention sessions without double-counting conflicted changes'
	);

	select * into strict v_surface_row from public.qorpera_surfaces where id = v_website_id;
	v_summary := public.qorpera_surface_summary_json(v_surface_row);
	perform pg_temp.awtb_assert((v_summary ->> 'needsAttentionCount')::integer = 0, 'website summary must keep needsAttentionCount = 0');

	select * into strict v_surface_row from public.qorpera_surfaces where id = v_identity_id;
	v_summary := public.qorpera_surface_summary_json(v_surface_row);
	perform pg_temp.awtb_assert((v_summary ->> 'needsAttentionCount')::integer = 0, 'identity summary must keep needsAttentionCount = 0');

	select strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure), '''coding_publish_artifact'',''coding_report_progress''') > 0
	into v_obs_check;
	perform pg_temp.awtb_assert(v_obs_check, 'qorpera_record_runtime_observation must admit both new workbench tools');

	select strpos(pg_get_functiondef('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure), '''coding_publish_artifact'', ''coding_report_progress''') > 0
		and strpos(pg_get_functiondef('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure), 'case when v_is_surface then 11 else 7 end') > 0
	into v_begin_check;
	perform pg_temp.awtb_assert(v_begin_check, 'qorpera_begin_native_coding_execution must allow up to 11 tools with both workbench tools on surface runs');

	select strpos(pg_get_functiondef('public.qorpera_cancel_surface_session_turn(uuid)'::regprocedure), 'v_session.worker_id is distinct from v_peek.worker_id') > 0
	into v_cancel_guard_check;
	perform pg_temp.awtb_assert(v_cancel_guard_check, 'qorpera_cancel_surface_session_turn must guard against concurrent worker_id changes');
end $$;
