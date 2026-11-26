-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.scpl_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_session_completion_and_preview_lane: %', p_message;
	end if;
end $$;

create function pg_temp.scpl_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.scpl_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.scpl_leased_run(p_run uuid)
returns jsonb language plpgsql as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_capsule uuid;
	v_runner uuid := extensions.gen_random_uuid();
	v_assignment uuid := extensions.gen_random_uuid();
	v_lease uuid := extensions.gen_random_uuid();
begin
	select * into strict v_run from public.qorpera_execution_runs where id = p_run;
	select * into strict v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = v_run.sponsor_binding_id and version = v_run.sponsor_version;
	select credential_capsule_id into strict v_capsule from public.qorpera_provider_connection_versions
	where connection_id = v_sponsor.provider_connection_id and version = v_sponsor.provider_connection_version;
	set local session_replication_role = replica;
	insert into public.qorpera_runners(
		id, profile_id, client_runner_id, display_name, capabilities, status,
		activation_token_sha256, activation_expires_at, activated_at,
		session_token_sha256, session_expires_at, registered_by_user_id, compute_identity_id
	)
	values (
		v_runner, v_run.profile_id, v_runner, 'Surface runner', '["agent_turn"]', 'active',
		repeat('e', 64), clock_timestamp() + interval '1 hour', clock_timestamp(),
		repeat('f', 64), clock_timestamp() + interval '1 hour', v_run.created_by_user_id, v_run.compute_identity_id
	);
	update public.qorpera_runner_jobs
	set status = 'leased', runner_id = v_runner, client_lease_id = v_assignment,
		lease_token_sha256 = repeat('a', 64), lease_expires_at = clock_timestamp() + interval '1 hour'
	where id = v_run.job_id;
	insert into public.qorpera_runner_orchestrators(
		id, display_name, provider_adapter, control_token_sha256, control_token_expires_at
	)
	values (
		v_runner, 'Surface orchestrator', 'fixture',
		encode(extensions.digest(v_runner::text, 'sha256'), 'hex'), clock_timestamp() + interval '1 hour'
	);
	insert into public.qorpera_runner_job_claims(
		id, orchestrator_id, client_claim_id, job_id, run_id, status, lease_expires_at
	)
	values (v_lease, v_runner, v_lease, v_run.job_id, v_run.id, 'accepted', clock_timestamp() + interval '1 hour');
	insert into public.qorpera_runner_assignments(
		id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at
	)
	values (
		v_assignment, v_lease, v_run.job_id, v_run.id, v_runner, repeat('e', 64),
		'accepted', clock_timestamp() + interval '1 hour', clock_timestamp()
	);
	insert into public.qorpera_native_provider_connection_leases(
		id, run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at
	)
	values (
		v_lease, v_run.id, v_run.job_id, v_sponsor.provider_connection_id, v_sponsor.provider_connection_version,
		v_capsule, v_run.compute_identity_id, v_runner, v_assignment, repeat('d', 64), clock_timestamp() + interval '1 hour'
	);
	set local session_replication_role = origin;
	return jsonb_build_object(
		'leaseId', v_lease, 'runId', v_run.id, 'jobId', v_run.job_id, 'runnerId', v_runner,
		'assignmentId', v_assignment, 'credentialCapsuleId', v_capsule, 'computeIdentityId', v_run.compute_identity_id,
		'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', v_run.model_id
	);
end $$;

create function pg_temp.scpl_admit_and_bind(p_binding jsonb)
returns void language plpgsql as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
begin
	perform pg_temp.as_service();
	select * into strict v_run from public.qorpera_execution_runs where id = (p_binding ->> 'runId')::uuid;
	perform public.qorpera_begin_native_company_execution_v3(
		p_binding,
		public.qorpera_execution_runtime_manifest(v_run) ->> 'nativeBinarySha256',
		v_run.runtime_bundle_sha256,
		v_run.reasoning_policy_sha256,
		'{"type":"namespace","name":"qorpera","description":"Surface tools","tools":[{"type":"function","name":"surface_reply","description":"Reply","inputSchema":{"type":"object","additionalProperties":false}}]}'
	);
	perform public.qorpera_bind_native_company_context(p_binding, repeat('c', 64), 120);
end $$;

create function pg_temp.scpl_complete_job(p_binding jsonb)
returns jsonb language sql as $$
	select public.qorpera_complete_runner_job_v6(
		(p_binding ->> 'runnerId')::uuid,
		repeat('f', 64),
		(p_binding ->> 'jobId')::uuid,
		repeat('a', 64),
		extensions.gen_random_uuid(),
		extensions.gen_random_uuid(),
		null,
		jsonb_build_object(
			'schema', 'qorpera.runner-result/v1',
			'runtime', 'company-path-v1',
			'backend', 'native-company-runtime',
			'native_lease_id', p_binding ->> 'leaseId',
			'substrate_version_id', (select substrate_version_id from public.qorpera_runner_jobs where id = (p_binding ->> 'jobId')::uuid),
			'output_count', 0,
			'output_bytes', 0,
			'publication', null,
			'backend_result', jsonb_build_object(
				'schema', 'qorpera.native-harness-result/v2',
				'run_id', p_binding ->> 'runId',
				'message_count', 0,
				'final_message_id', null,
				'provider_session_id', 'surface-session:' || (p_binding ->> 'runId')
			),
			'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb
		)
	)
$$;

create function pg_temp.scpl_activity(p_user uuid, p_env uuid)
returns jsonb language plpgsql as $$
declare
	v_rows jsonb;
begin
	perform pg_temp.scpl_as(p_user);
	set local role authenticated;
	v_rows := public.qorpera_list_staff_execution_activity(p_env);
	reset role;
	return v_rows;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_cofounder uuid;
	v_folder_surface uuid;
	v_code_surface uuid;
	v_sess_1 uuid;
	v_sess_2 uuid;
	v_sess_fail uuid;
	v_sess_ambig uuid;
	v_sess_code uuid;
	v_lease_1 uuid;
	v_lease_1b uuid;
	v_lease_2 uuid;
	v_lease_fail uuid;
	v_lease_ambig uuid;
	v_lease_code uuid;
	v_claimed jsonb;
	v_enq jsonb;
	v_wake_1 public.qorpera_wake_occurrences%rowtype;
	v_wake_2 public.qorpera_wake_occurrences%rowtype;
	v_wake_fail public.qorpera_wake_occurrences%rowtype;
	v_wake_ambig public.qorpera_wake_occurrences%rowtype;
	v_binding_1 jsonb;
	v_binding_2 jsonb;
	v_binding_fail jsonb;
	v_binding_ambig jsonb;
	v_done jsonb;
	v_activity jsonb;
	v_change_folder uuid;
	v_change_code uuid;
	v_sel jsonb;
	v_ws jsonb;
	v_code_preview_id uuid;
	v_first_run uuid;
	v_first_job uuid;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	-- WHY: Exercise the pre-v284 wake-based surface session path tested by this suite.
	update public.qorpera_active_runtime_bundle a
	set runtime_bundle_id = b.id, runtime_bundle_sha256 = b.sha256
	from public.qorpera_runtime_bundles b
	where a.singleton and b.bundle_key = 'qorpera.cloud-runtime' and b.version = 283;
	select environment_id, staff_agent_id into strict v_env, v_cofounder
	from public.qorpera_company_cofounders where profile_id = v_company;

	perform pg_temp.scpl_materialize(v_company, 16);
	select id, job_id into strict v_first_run, v_first_job
	from public.qorpera_execution_runs
	where profile_id = v_company and staff_agent_id = v_cofounder
	order by created_at asc limit 1;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'completed', lease_token_sha256 = null, lease_expires_at = null,
		result = '{}'::jsonb, finished_at = clock_timestamp() - interval '10 minutes'
	where id = v_first_job;
	set local session_replication_role = origin;

	perform pg_temp.scpl_as(v_owner);
	set local role authenticated;
	v_folder_surface := (public.qorpera_create_surface(v_company, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true) ->> 'id')::uuid;
	v_code_surface := (public.qorpera_create_surface(v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false) ->> 'id')::uuid;
	v_sess_1 := (public.qorpera_start_surface_session(v_folder_surface, 'Refresh tokens', 'Identity pass 1') ->> 'id')::uuid;
	v_sess_2 := (public.qorpera_start_surface_session(v_folder_surface, 'Finish via record_change', 'Identity pass 2') ->> 'id')::uuid;
	v_sess_code := (public.qorpera_start_surface_session(v_code_surface, 'Hero update', 'Website pass 1') ->> 'id')::uuid;
	reset role;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_code_surface;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (e ->> 'leaseToken')::uuid into strict v_lease_1 from jsonb_array_elements(v_claimed -> 'sessions') e where (e ->> 'sessionId')::uuid = v_sess_1;
	select (e ->> 'leaseToken')::uuid into strict v_lease_2 from jsonb_array_elements(v_claimed -> 'sessions') e where (e ->> 'sessionId')::uuid = v_sess_2;
	select (e ->> 'leaseToken')::uuid into strict v_lease_code from jsonb_array_elements(v_claimed -> 'sessions') e where (e ->> 'sessionId')::uuid = v_sess_code;

	v_enq := public.qorpera_surface_enqueue_session_run(v_sess_1, v_lease_1);
	perform pg_temp.scpl_assert(v_enq ->> 'status' = 'enqueued', 'session 1 enqueues wake');
	v_wake_1.id := (v_enq ->> 'wakeId')::uuid;

	v_enq := public.qorpera_surface_enqueue_session_run(v_sess_2, v_lease_2);
	perform pg_temp.scpl_assert(v_enq ->> 'status' = 'enqueued', 'session 2 enqueues wake');
	v_wake_2.id := (v_enq ->> 'wakeId')::uuid;
	reset role;
	select * into strict v_wake_1 from public.qorpera_wake_occurrences where id = v_wake_1.id;
	select * into strict v_wake_2 from public.qorpera_wake_occurrences where id = v_wake_2.id;

	perform pg_temp.scpl_materialize(v_company, 16);
	select * into strict v_wake_1 from public.qorpera_wake_occurrences where id = v_wake_1.id;
	select * into strict v_wake_2 from public.qorpera_wake_occurrences where id = v_wake_2.id;
	perform pg_temp.scpl_assert(v_wake_1.run_id is not null and v_wake_2.run_id is not null, 'surface wakes materialize');

	v_activity := pg_temp.scpl_activity(v_owner, v_env);
	perform pg_temp.scpl_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid in (v_wake_1.run_id, v_wake_2.run_id)
		),
		'queued surface-session runs do not appear in Co-Founder staff execution activity'
	);

	v_binding_1 := pg_temp.scpl_leased_run(v_wake_1.run_id);
	v_binding_2 := pg_temp.scpl_leased_run(v_wake_2.run_id);

	v_activity := pg_temp.scpl_activity(v_owner, v_env);
	perform pg_temp.scpl_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid in (v_wake_1.run_id, v_wake_2.run_id)
		),
		'leased surface-session runs do not appear in Co-Founder staff execution activity'
	);

	perform pg_temp.scpl_admit_and_bind(v_binding_1);
	perform pg_temp.scpl_admit_and_bind(v_binding_2);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_change_folder := (public.qorpera_native_surface_record_change(
		v_company, v_sess_1, 'Tokens', 'Stage tokens', 'folder_patch',
		null, null, '{}', array['tokens.json'], null,
		'[{"op":"write_text","path":"tokens.json","content":"{}"}]'::jsonb,
		false, v_lease_1
	) ->> 'changeId')::uuid;
	perform public.qorpera_native_surface_complete_turn(
		v_company, v_sess_1, 'ready', 'Staged tokens', null, null, null, v_lease_1
	);
	perform public.qorpera_native_surface_record_change(
		v_company, v_sess_2, 'Tokens 2', 'Finish immediately', 'folder_patch',
		null, null, '{}', array['tokens.json'], null,
		'[{"op":"write_text","path":"tokens.json","content":"{}"}]'::jsonb,
		true, v_lease_2
	);
	reset role;

	perform pg_temp.scpl_assert(
		(select wake_id from public.qorpera_surface_sessions where id = v_sess_1) = v_wake_1.id
		and (select state from public.qorpera_surface_sessions where id = v_sess_1) = 'ready',
		'qorpera_native_surface_complete_turn preserves wake_id until runner job completion'
	);
	perform pg_temp.scpl_assert(
		(select wake_id from public.qorpera_surface_sessions where id = v_sess_2) = v_wake_2.id
		and (select state from public.qorpera_surface_sessions where id = v_sess_2) = 'ready',
		'qorpera_native_surface_record_change(p_finish_session=true) preserves wake_id until runner job completion'
	);

	perform pg_temp.scpl_as(v_owner);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_sess_1, 'Also tweak headings', true);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	perform pg_temp.scpl_assert(
		not exists (
			select 1 from jsonb_array_elements(v_claimed -> 'sessions') e
			where (e ->> 'sessionId')::uuid = v_sess_1
		),
		'sessions lane defers claiming a fast reply while the prior wake is still materialized'
	);
	reset role;

	perform pg_temp.as_service();
	v_done := pg_temp.scpl_complete_job(v_binding_1);
	perform pg_temp.scpl_assert(
		v_done ->> 'status' = 'completed'
		and (select status from public.qorpera_wake_occurrences where id = v_wake_1.id) = 'completed',
		'qorpera_complete_runner_job_v6 succeeds after qorpera_native_surface_complete_turn'
	);
	v_done := pg_temp.scpl_complete_job(v_binding_2);
	perform pg_temp.scpl_assert(
		v_done ->> 'status' = 'completed'
		and (select status from public.qorpera_wake_occurrences where id = v_wake_2.id) = 'completed',
		'qorpera_complete_runner_job_v6 succeeds after qorpera_native_surface_record_change(p_finish_session=true)'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (e ->> 'leaseToken')::uuid into v_lease_1b
	from jsonb_array_elements(v_claimed -> 'sessions') e
	where (e ->> 'sessionId')::uuid = v_sess_1;
	reset role;

	perform pg_temp.scpl_assert(
		v_lease_1b is not null and v_lease_1b <> v_lease_1
		and (select wake_id from public.qorpera_surface_sessions where id = v_sess_1) is null,
		'sessions lane claims follow-up reply once prior wake completes and resets wake_id'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_enq := public.qorpera_surface_enqueue_session_run(v_sess_1, v_lease_1b);
	reset role;

	perform pg_temp.scpl_assert(
		v_enq ->> 'status' = 'enqueued' and (v_enq ->> 'wakeId')::uuid <> v_wake_1.id,
		'follow-up turn enqueues a fresh wake after prior wake completes'
	);

	perform pg_temp.scpl_as(v_owner);
	set local role authenticated;
	v_sess_fail := (public.qorpera_start_surface_session(v_folder_surface, 'Will fail cleanly', 'Fail test') ->> 'id')::uuid;
	v_sess_ambig := (public.qorpera_start_surface_session(v_folder_surface, 'Will fail with ambiguous receipt', 'Ambig test') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (e ->> 'leaseToken')::uuid into strict v_lease_fail from jsonb_array_elements(v_claimed -> 'sessions') e where (e ->> 'sessionId')::uuid = v_sess_fail;
	select (e ->> 'leaseToken')::uuid into strict v_lease_ambig from jsonb_array_elements(v_claimed -> 'sessions') e where (e ->> 'sessionId')::uuid = v_sess_ambig;
	v_enq := public.qorpera_surface_enqueue_session_run(v_sess_fail, v_lease_fail);
	v_wake_fail.id := (v_enq ->> 'wakeId')::uuid;
	v_enq := public.qorpera_surface_enqueue_session_run(v_sess_ambig, v_lease_ambig);
	v_wake_ambig.id := (v_enq ->> 'wakeId')::uuid;
	reset role;
	select * into strict v_wake_fail from public.qorpera_wake_occurrences where id = v_wake_fail.id;
	select * into strict v_wake_ambig from public.qorpera_wake_occurrences where id = v_wake_ambig.id;

	perform pg_temp.scpl_materialize(v_company, 16);
	select * into strict v_wake_fail from public.qorpera_wake_occurrences where id = v_wake_fail.id;
	select * into strict v_wake_ambig from public.qorpera_wake_occurrences where id = v_wake_ambig.id;
	v_binding_fail := pg_temp.scpl_leased_run(v_wake_fail.run_id);
	v_binding_ambig := pg_temp.scpl_leased_run(v_wake_ambig.run_id);

	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'failed', lease_token_sha256 = null, lease_expires_at = null, result = null,
		last_error = 'Native provider bridge request failed (422) [code=NATIVE_COMPANY_CONTEXT:UNKNOWN]',
		finished_at = clock_timestamp()
	where id in ((v_binding_fail ->> 'jobId')::uuid, (v_binding_ambig ->> 'jobId')::uuid);
	update public.qorpera_wake_occurrences
	set status = 'failed', finished_at = clock_timestamp(), blocked_reason = 'simulated failure'
	where id in (v_wake_fail.id, v_wake_ambig.id);
	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, operation_kind, logical_operation_key,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision, completed_at
	)
	values (
		extensions.gen_random_uuid(),
		v_wake_ambig.run_id, (v_binding_ambig ->> 'jobId')::uuid, (v_binding_ambig ->> 'assignmentId')::uuid,
		'cloud_tool', 'machine_run:ambig-check', repeat('1', 64), repeat('2', 64), 'ambiguous', false, clock_timestamp()
	);
	set local session_replication_role = origin;

	v_activity := pg_temp.scpl_activity(v_owner, v_env);
	perform pg_temp.scpl_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_wake_fail.run_id
		),
		'failed surface-session wake without ambiguous receipts is excluded from Co-Founder chat activity'
	);
	perform pg_temp.scpl_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_wake_ambig.run_id and item ->> 'activity' = 'needs_attention'
		),
		'failed surface-session wake with an ambiguous receipt remains visible for operator/member recovery'
	);

	set local session_replication_role = replica;
	update public.qorpera_run_operation_receipts
	set status = 'completed', result = '{}'::jsonb
	where run_id = v_wake_ambig.run_id;
	update public.qorpera_runner_jobs
	set status = 'failed', lease_token_sha256 = null, lease_expires_at = null, result = null,
		last_error = 'Simulated Co-Founder failure', finished_at = clock_timestamp() - interval '5 minutes'
	where id = v_first_job;
	set local session_replication_role = origin;

	v_activity := pg_temp.scpl_activity(v_owner, v_env);
	perform pg_temp.scpl_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_first_run
				and coalesce((item ->> 'superseded')::boolean, false) = false
		),
		'newer surface-session wakes do not supersede a real Co-Founder failure'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_change_code := (public.qorpera_native_surface_record_change(
		v_company, v_sess_code, 'Hero', 'Hero change', 'git_range',
		null, repeat('2', 40), '{}', array['index.html'], null, null, false, v_lease_code
	) ->> 'changeId')::uuid;
	reset role;

	perform pg_temp.scpl_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_folder_surface, array[v_change_folder], null, array[v_sess_1, v_sess_2], '/');
	reset role;
	perform pg_temp.scpl_assert(
		v_sel -> 'primary' ->> 'previewId' is null
		and v_sel -> 'primary' ->> 'status' = 'live_baseline'
		and jsonb_array_length(v_sel -> 'compareFrames') = 2
		and v_sel -> 'compareFrames' -> 0 -> 'frame' ->> 'previewId' is null
		and v_sel -> 'compareFrames' -> 0 -> 'frame' ->> 'status' = 'live_baseline'
		and not exists (select 1 from public.qorpera_surface_previews where surface_id = v_folder_surface),
		'qorpera_set_preview_selection persists folder toggles/compare without inserting qorpera_surface_previews rows'
	);

	insert into public.qorpera_surface_previews(
		profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids,
		status, expires_at
	)
	values (
		v_company, v_folder_surface, repeat('a', 64), 'fld00001', repeat('0', 40), array[v_change_folder],
		'composing', clock_timestamp() + interval '1 hour'
	), (
		v_company, v_folder_surface, repeat('b', 64), 'fld00002', repeat('0', 40), array[v_change_folder],
		'building', clock_timestamp() + interval '1 hour'
	);
	update public.qorpera_surface_previews
	set lease_expires_at = clock_timestamp() - interval '1 minute', lease_token = extensions.gen_random_uuid()
	where short_host_id = 'fld00002';

	perform pg_temp.scpl_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_folder_surface);
	v_code_preview_id := (public.qorpera_set_preview_selection(v_code_surface, array[v_change_code], null, '{}'::uuid[], '/') -> 'primary' ->> 'previewId')::uuid;
	reset role;

	perform pg_temp.scpl_assert(
		v_ws -> 'previewState' -> 'primary' ->> 'previewId' is null
		and v_ws -> 'previewState' -> 'primary' ->> 'status' = 'live_baseline',
		'qorpera_get_surface_workspace ignores non-code_repo preview rows'
	);
	perform pg_temp.scpl_assert(v_code_preview_id is not null, 'code_repo preview selection creates preview row');

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;

	perform pg_temp.scpl_assert(
		jsonb_array_length(v_claimed -> 'previews') = 1
		and (v_claimed -> 'previews' -> 0 ->> 'previewId')::uuid = v_code_preview_id
		and (select status from public.qorpera_surface_previews where short_host_id = 'fld00001') = 'composing'
		and (select status from public.qorpera_surface_previews where short_host_id = 'fld00002') = 'building',
		'code_repo lane claims only code_repo previews and never resets or claims folder surface previews'
	);

	perform pg_temp.scpl_assert(
		has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)', 'execute'),
		'patched functions preserve their grants'
	);
end $$;
