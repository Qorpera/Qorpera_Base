-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ssr_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_silent_reconciliation: %', p_message;
	end if;
end $$;

create function pg_temp.ssr_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.ssr_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.ssr_leased_run(p_run uuid)
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
		v_runner, v_run.profile_id, v_runner, 'SSR runner', '["agent_turn"]', 'active',
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
		v_runner, 'SSR orchestrator', 'fixture',
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

create function pg_temp.ssr_admit_and_bind(p_binding jsonb)
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

create function pg_temp.ssr_complete_job(p_binding jsonb)
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

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_outsider constant uuid := '13700000-0000-4000-8000-000000000099';
	v_exec_owner constant uuid := '13700000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13700000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13700000-0000-4000-8000-000000000021';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_folder_surface_id uuid;
	v_code_surface_id uuid;
	v_fs1 uuid;
	v_fs2 uuid;
	v_fc1 uuid;
	v_fc2 uuid;
	v_rec1 jsonb;
	v_rec2 jsonb;
	v_rec_id uuid;
	v_hidden_sess uuid;
	v_hidden_lease uuid;
	v_turn jsonb;
	v_ws jsonb;
	v_claimed jsonb;
	v_merge_job jsonb;
	v_merge_job_id uuid;
	v_merge_lease uuid;
	v_undo_job jsonb;
	v_cs1 uuid;
	v_cs2 uuid;
	v_cc1 uuid;
	v_cc2 uuid;
	v_preview_id uuid;
	v_preview_lease uuid;
	v_code_rec_id uuid;
	v_code_hidden_sess uuid;
	v_code_hidden_lease uuid;
	v_code_worker uuid;
	v_code_rec_retry jsonb;
	v_code_hidden_sess_2 uuid;
	v_code_hidden_lease_2 uuid;
	v_preview_claim jsonb;
	v_cs3 uuid;
	v_cc3 uuid;
	v_land_job_id uuid;
	v_land_lease uuid;
	v_auto_rec_id uuid;
	v_auto_sess_id uuid;
	v_auto_land_job_id uuid;
	v_auto_land_lease uuid;
	v_cs_rebase uuid;
	v_cc_rebase uuid;
	v_enq jsonb;
	v_mat jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_binding jsonb;
	v_done jsonb;
	v_stale_result jsonb;
	v_retry_land_job_id uuid;
	v_retry_land_lease uuid;
	v_cofounder uuid;
	v_first_job uuid;
	v_errcode text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select staff_agent_id into strict v_cofounder from public.qorpera_company_cofounders where profile_id = v_company_a;
	perform pg_temp.ssr_materialize(v_company_a, 16);
	select job_id into strict v_first_job
	from public.qorpera_execution_runs
	where profile_id = v_company_a and staff_agent_id = v_cofounder
	order by created_at asc limit 1;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'completed', lease_token_sha256 = null, lease_expires_at = null,
		result = '{}'::jsonb, finished_at = clock_timestamp() - interval '10 minutes'
	where id = v_first_job;
	set local session_replication_role = origin;

	insert into auth.users(id, email) values (v_outsider, 'outsider-1370@example.test');
	insert into auth.users(id, email) values (v_exec_owner, 'exec-owner-1370@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SSR Exec Co', v_exec_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SSR Exec Env', 1, v_exec_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1370', true, array['codex', 'claude-code']);

	perform pg_temp.ssr_assert(
		not has_table_privilege('anon', 'public.qorpera_surface_reconciliations', 'SELECT')
		and not has_table_privilege('authenticated', 'public.qorpera_surface_reconciliations', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_reconciliations', 'SELECT')
		and not has_function_privilege('anon', 'public.qorpera_surface_reconciliation_key(public.qorpera_surfaces,uuid[])', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_reconciliation_key(public.qorpera_surfaces,uuid[])', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_reconciliation_key(public.qorpera_surfaces,uuid[])', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_ensure_surface_reconciliation(uuid,uuid[],text[],boolean)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_ensure_surface_reconciliation(uuid,uuid[],text[],boolean)', 'EXECUTE'),
		'reconciliation table and helpers are locked down while ensure_surface_reconciliation is authenticated-only'
	);

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_folder_surface_id := (public.qorpera_create_surface(
		v_company_a, 'Identity', 'identity', 'studio', 'identity', 'palette', '#1a56db', 'identity', null, false
	) ->> 'id')::uuid;
	v_code_surface_id := (public.qorpera_create_surface(
		v_company_a, 'Storefront', 'storefront', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_code_surface_id;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_fs1 := (public.qorpera_start_surface_session(v_folder_surface_id, 'Add buyer journey diagram', 'Buyer journey') ->> 'id')::uuid;
	v_fs2 := (public.qorpera_start_surface_session(v_folder_surface_id, 'Lighter blue accent on dark backgrounds', 'Lighter blue') ->> 'id')::uuid;
	reset role;

	v_fc1 := (public.qorpera_record_surface_change(
		v_fs1, 'Buyer journey section', 'Adds journey diagram to guide', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/guide.md', 'identity/journey.svg'], null,
		jsonb_build_object(
			'ops', jsonb_build_array(
				jsonb_build_object('op', 'write_text', 'path', 'identity/guide.md', 'content', E'# Brand\nJourney copy'),
				jsonb_build_object('op', 'write_text', 'path', 'identity/journey.svg', 'content', '<svg>journey</svg>')
			),
			'baseFiles', jsonb_build_object('identity/guide.md', E'# Brand\nOriginal copy')
		),
		true
	) ->> 'changeId')::uuid;

	v_fc2 := (public.qorpera_record_surface_change(
		v_fs2, 'Lighter blue guide update', 'Updates blue guidance', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/guide.md'], null,
		jsonb_build_object(
			'ops', jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'identity/guide.md', 'content', E'# Brand\nLighter blue copy')),
			'baseFiles', jsonb_build_object('identity/guide.md', E'# Brand\nOriginal copy')
		),
		true
	) ->> 'changeId')::uuid;

	perform pg_temp.ssr_assert(
		(select jsonb_typeof(patch_manifest) = 'array' and base_files ->> 'identity/guide.md' = E'# Brand\nOriginal copy'
			from public.qorpera_surface_changes where id = v_fc1)
		and (select (public.qorpera_surface_session_json(s) #>> '{changes,0,baseFiles,identity/guide.md}') = E'# Brand\nOriginal copy'
			from public.qorpera_surface_sessions s where s.id = v_fs1),
		'record_surface_change unwraps folder_patch ops and baseFiles and exposes baseFiles in session JSON'
	);

	v_errcode := null;
	perform pg_temp.ssr_as(v_outsider);
	set local role authenticated;
	begin
		perform public.qorpera_ensure_surface_reconciliation(v_folder_surface_id, array[v_fc1, v_fc2], array['identity/guide.md'], false);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.ssr_assert(v_errcode = '42501', 'outsider refused by qorpera_ensure_surface_reconciliation');

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_rec1 := public.qorpera_ensure_surface_reconciliation(v_folder_surface_id, array[v_fc2, v_fc1], array['identity/guide.md'], false);
	v_rec2 := public.qorpera_ensure_surface_reconciliation(v_folder_surface_id, array[v_fc1, v_fc2], array['identity/guide.md'], false);
	v_ws := public.qorpera_get_surface_workspace(v_folder_surface_id);
	reset role;

	v_rec_id := (v_rec1 ->> 'id')::uuid;
	select session_id into strict v_hidden_sess from public.qorpera_surface_reconciliations where id = v_rec_id;

	perform pg_temp.ssr_assert(
		v_rec1 ->> 'status' = 'queued'
		and v_rec2 ->> 'id' = v_rec1 ->> 'id'
		and (select origin_kind = 'member' from public.qorpera_surface_sessions where id = v_hidden_sess)
		and (select conflict_paths = array['identity/guide.md'] from public.qorpera_surface_reconciliations where id = v_rec_id)
		and (select count(*) from public.qorpera_surface_sessions where surface_id = v_folder_surface_id and is_internal) = 1
		and (v_ws #>> '{surface,folderRevision}')::bigint = 0
		and (v_ws #>> '{surface,activeSessionCount}')::integer = 2
		and (v_ws #>> '{surface,needsAttentionCount}')::integer = 0
		and not exists (
			select 1 from jsonb_array_elements(v_ws -> 'activeSessions') s where (s ->> 'id')::uuid = v_hidden_sess
		)
		and jsonb_array_length(v_ws -> 'reconciliations') = 1
		and (v_ws #>> '{reconciliations,0,id}')::uuid = v_rec_id,
		'ensure_surface_reconciliation deduplicates idempotently, keeps conflict_paths exact, marks member origin, hides internal session from workspace, and exposes reconciliation'
	);

	update public.qorpera_surface_sessions set state = 'ready' where id in (v_fs1, v_fs2);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_hidden_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_hidden_sess;

	v_enq := public.qorpera_surface_enqueue_session_run(v_hidden_sess, v_hidden_lease);
	v_turn := public.qorpera_native_surface_read_session_turn(v_company_a, v_hidden_sess, v_hidden_lease);
	reset role;

	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	v_mat := pg_temp.ssr_materialize(v_company_a, 16);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.ssr_assert(v_wake.run_id is not null, 'internal folder reconciliation wake materializes into an execution run');
	v_binding := pg_temp.ssr_leased_run(v_wake.run_id);
	perform pg_temp.ssr_admit_and_bind(v_binding);

	perform pg_temp.ssr_assert(
		(select status = 'running' and attempts = 1 from public.qorpera_surface_reconciliations where id = v_rec_id)
		and (v_turn ->> 'isInternal')::boolean = true
		and (v_turn ->> 'folderRevision')::bigint = 0
		and jsonb_array_length(v_turn -> 'conflictDetails') = 2
		and (v_turn #>> '{conflictDetails,0,prompt}') = 'Add buyer journey diagram'
		and jsonb_typeof(v_turn #> '{conflictDetails,0,patchManifest}') = 'array'
		and (v_turn #>> '{conflictDetails,0,baseFiles,identity/guide.md}') = E'# Brand\nOriginal copy',
		'claiming internal folder reconciliation marks running and turn read includes isInternal, prompt, patchManifest, and baseFiles'
	);

	-- WHY: Verify SQL refuses an incomplete reconciled folder manifest missing a required conflict path.
	v_errcode := null;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		perform public.qorpera_native_surface_record_change(
			v_company_a, v_hidden_sess, 'Incomplete update', 'Missing guide.md', 'folder_patch',
			null, null, '{}'::uuid[], array['identity/other.md'], null,
			jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'identity/other.md', 'content', 'wrong')),
			true, v_hidden_lease
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.ssr_assert(v_errcode = '22023', 'internal folder record rejects manifest missing required conflict path');

	-- WHY: Record through qorpera_native_surface_record_change inside a real wake and confirm wake_id + wake authority survive through qorpera_complete_runner_job_v6.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_native_surface_record_change(
		v_company_a, v_hidden_sess, 'Combined guide update', 'Preserves journey and lighter blue', 'folder_patch',
		null, null, '{}'::uuid[], array['identity/guide.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'identity/guide.md', 'content', E'# Brand\nJourney copy\nLighter blue copy')),
		true, v_hidden_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'ready' and jsonb_typeof(reconciled_patch_manifest) = 'array' from public.qorpera_surface_reconciliations where id = v_rec_id)
		and (select state = 'reconciling_running' and wake_id = v_wake.id and lease_token = v_hidden_lease from public.qorpera_surface_sessions where id = v_hidden_sess)
		and public.qorpera_folder_wake_authorized(v_wake),
		'internal record keeps session state, lease, and wake_id intact so post-record tools stay authorized'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_native_surface_complete_turn(
		v_company_a, v_hidden_sess, 'ready', 'Combined overlapping updates cleanly.', null, null, null, v_hidden_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select state = 'completed' and wake_id = v_wake.id from public.qorpera_surface_sessions where id = v_hidden_sess)
		and public.qorpera_folder_wake_authorized(v_wake)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_fc1)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_fc2),
		'completing internal folder reconciliation closes session while keeping wake_id intact for runner job completion and without discarding original changes'
	);

	perform pg_temp.as_service();
	v_done := pg_temp.ssr_complete_job(v_binding);
	perform pg_temp.ssr_assert(
		v_done ->> 'status' = 'completed',
		'runner job completes cleanly after internal folder reconciliation'
	);

	-- WHY: Queue a multi-change folder land job matching the ready reconciliation and verify claim attaches reconciledPatchManifest + baseFiles.
	update public.qorpera_surface_changes set status = 'merging' where id in (v_fc1, v_fc2);
	insert into public.qorpera_surface_jobs(profile_id, surface_id, session_id, kind, payload, requested_by_user_id)
	values (
		v_company_a, v_folder_surface_id, v_fs1, 'land_change',
		jsonb_build_object('changeIds', jsonb_build_array(v_fc1, v_fc2), 'autoPublish', false),
		v_owner
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'folder');
	select elem into strict v_merge_job
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_folder_surface_id;
	v_merge_job_id := (v_merge_job ->> 'jobId')::uuid;
	v_merge_lease := (v_merge_job ->> 'leaseToken')::uuid;
	reset role;

	perform pg_temp.ssr_assert(
		jsonb_typeof(v_merge_job -> 'reconciledPatchManifest') = 'array'
		and v_merge_job -> 'reconciledConflictPaths' = '["identity/guide.md"]'::jsonb
		and (v_merge_job #>> '{approvedChanges,0,baseFiles,identity/guide.md}') = E'# Brand\nOriginal copy',
		'folder merge claim attaches reconciledPatchManifest, reconciledConflictPaths, and per-change baseFiles'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_merge_job_id, 'landed', null, null, null, null, null,
		jsonb_build_object('snapshotId', repeat('a', 64), 'folderRoot', 'identity', 'filesBefore', jsonb_build_object('identity/guide.md', E'# Brand\nOriginal copy')),
		v_merge_lease
	);
	reset role;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_folder_surface_id);
	reset role;

	perform pg_temp.ssr_assert(
		(v_ws #>> '{surface,folderRevision}')::bigint = 1
		and jsonb_array_length(v_ws -> 'reconciliations') = 0,
		'folder land increments folderRevision and drops stale reconciliations from workspace'
	);

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_fc1);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'folder');
	select elem into strict v_undo_job
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_folder_surface_id and elem ->> 'kind' = 'undo_change';
	perform public.qorpera_surface_complete_merge(
		(v_undo_job ->> 'jobId')::uuid, 'landed', null, null, null, null, null, null, (v_undo_job ->> 'leaseToken')::uuid
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select folder_revision from public.qorpera_surfaces where id = v_folder_surface_id) = 2,
		'folder undo increments folderRevision'
	);

	-- WHY: Verify code_repo preview conflict -> silent reconciling -> failure -> explicit retry -> ready -> composing with reconciledCommitSha.
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_cs1 := (public.qorpera_start_surface_session(v_code_surface_id, 'Update pricing hero', 'Hero A') ->> 'id')::uuid;
	v_cs2 := (public.qorpera_start_surface_session(v_code_surface_id, 'Update pricing subtitle', 'Hero B') ->> 'id')::uuid;
	reset role;

	v_cc1 := (public.qorpera_record_surface_change(
		v_cs1, 'Pricing hero', 'Hero title', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	) ->> 'changeId')::uuid;
	v_cc2 := (public.qorpera_record_surface_change(
		v_cs2, 'Pricing subtitle', 'Hero subtitle', 'git_range',
		repeat('1', 40), repeat('3', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_preview_id := (public.qorpera_set_preview_selection(v_code_surface_id, array[v_cc1, v_cc2], null, '{}'::uuid[], '/') #>> '{primary,previewId}')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'leaseToken')::uuid into strict v_preview_lease
	from jsonb_array_elements(v_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = v_preview_id;

	perform public.qorpera_surface_complete_preview(
		v_preview_id, 'conflicted', null, null,
		jsonb_build_object('paths', jsonb_build_array('src/pricing.tsx'), 'changeIds', jsonb_build_array(v_cc1, v_cc2)),
		null, v_preview_lease
	);
	reset role;

	select id, session_id into strict v_code_rec_id, v_code_hidden_sess
	from public.qorpera_surface_reconciliations
	where surface_id = v_code_surface_id;

	perform pg_temp.ssr_assert(
		(select status = 'reconciling' and conflict_report is null from public.qorpera_surface_previews where id = v_preview_id)
		and (select status = 'queued' from public.qorpera_surface_reconciliations where id = v_code_rec_id)
		and (select origin_kind = 'cofounder' from public.qorpera_surface_sessions where id = v_code_hidden_sess),
		'code_repo preview conflict transitions preview to reconciling and enqueues system-triggered cofounder reconciliation'
	);

	update public.qorpera_surface_sessions set state = 'ready' where id in (v_cs1, v_cs2);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_code_hidden_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_code_hidden_sess;

	v_code_worker := (public.qorpera_surface_enqueue_session_run(v_code_hidden_sess, v_code_hidden_lease) ->> 'workerId')::uuid;
	reset role;

	perform pg_temp.ssr_assert(
		v_code_worker is not null
		and position('Never call coding_ask.' in (select dispatch ->> 'goal' from public.qorpera_runtime_workers where id = v_code_worker)) > 0
		and position('Never call coding_ask.' in (select dispatch ->> 'definitionOfDone' from public.qorpera_runtime_workers where id = v_code_worker)) > 0,
		'internal code_repo reconciliation enqueues non-interactive coding worker'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_session_turn(
		v_code_hidden_sess, 'needs_input', 'Asked a question anyway', null, null, null, v_code_hidden_lease
	);
	reset role;
	perform pg_temp.ssr_assert(
		(select state = 'reconciling' and retry_count = 1 from public.qorpera_surface_sessions where id = v_code_hidden_sess)
		and (select status = 'queued' from public.qorpera_surface_reconciliations where id = v_code_rec_id),
		'first incomplete internal reconciliation turn retries automatically'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_code_hidden_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_code_hidden_sess;
	perform public.qorpera_surface_complete_session_turn(
		v_code_hidden_sess, 'failed', 'Second attempt failed', null, null, null, v_code_hidden_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'failed' from public.qorpera_surface_reconciliations where id = v_code_rec_id)
		and (select status = 'failed' from public.qorpera_surface_previews where id = v_preview_id),
		'exhausted internal reconciliation fails both reconciliation row and waiting reconciling preview'
	);

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_code_rec_retry := public.qorpera_ensure_surface_reconciliation(v_code_surface_id, array[v_cc1, v_cc2], array['src/pricing.tsx'], true);
	reset role;

	select session_id into strict v_code_hidden_sess_2 from public.qorpera_surface_reconciliations where id = v_code_rec_id;
	perform pg_temp.ssr_assert(
		v_code_rec_retry ->> 'status' = 'queued'
		and v_code_hidden_sess_2 <> v_code_hidden_sess
		and (select origin_kind = 'member' from public.qorpera_surface_sessions where id = v_code_hidden_sess_2)
		and (select status = 'reconciling' from public.qorpera_surface_previews where id = v_preview_id),
		'explicit retry resets failed reconciliation to queued with member origin and restores waiting preview to reconciling'
	);

	-- WHY: Verify a stale superseded internal session cannot mark a newer retry ready.
	v_stale_result := public.qorpera_record_surface_change(
		v_code_hidden_sess, 'Stale late record', 'Should be ignored', 'git_range',
		repeat('1', 40), repeat('7', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	);
	perform pg_temp.ssr_assert(
		(v_stale_result ->> 'stale')::boolean = true
		and (select status = 'queued' and session_id = v_code_hidden_sess_2 and reconciled_commit_sha is null
			from public.qorpera_surface_reconciliations where id = v_code_rec_id),
		'superseded internal session cannot flip active retry reconciliation to ready'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_code_hidden_lease_2
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_code_hidden_sess_2;
	reset role;

	perform public.qorpera_record_surface_change(
		v_code_hidden_sess_2, 'Reconciled pricing', 'Combined hero and subtitle', 'git_range',
		repeat('1', 40), repeat('9', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, true
	);

	perform pg_temp.ssr_assert(
		(select status = 'ready' and reconciled_commit_sha = repeat('9', 40) from public.qorpera_surface_reconciliations where id = v_code_rec_id)
		and (select status = 'composing' from public.qorpera_surface_previews where id = v_preview_id)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_cc1)
		and (select status = 'staged' from public.qorpera_surface_changes where id = v_cc2),
		'ready code_repo reconciliation flips preview back to composing without discarding original changes'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select elem into strict v_preview_claim
	from jsonb_array_elements(v_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = v_preview_id;
	reset role;

	perform pg_temp.ssr_assert(
		v_preview_claim ->> 'reconciledCommitSha' = repeat('9', 40),
		'code_repo preview claim attaches reconciledCommitSha'
	);

	-- WHY: Verify merge conflict -> auto_approve_after silent reconciliation -> automatic land_change re-queue, and no infinite loop if that retry conflicts.
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_cs3 := (public.qorpera_start_surface_session(v_code_surface_id, 'Update checkout copy', 'Checkout') ->> 'id')::uuid;
	reset role;

	v_cc3 := (public.qorpera_record_surface_change(
		v_cs3, 'Checkout copy', 'Checkout wording', 'git_range',
		repeat('1', 40), repeat('4', 40), '{}'::uuid[], array['src/checkout.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_cc3, false);
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_land_job_id, v_land_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_code_surface_id;

	perform public.qorpera_surface_complete_merge(
		v_land_job_id, 'conflicted', repeat('1', 40), null, v_cc3, array['src/checkout.tsx'], 'Merge conflict', null, v_land_lease
	);
	reset role;

	select id, session_id into strict v_auto_rec_id, v_auto_sess_id
	from public.qorpera_surface_reconciliations
	where surface_id = v_code_surface_id and v_cc3 = any(selected_change_ids);

	perform pg_temp.ssr_assert(
		(select status = 'staged' from public.qorpera_surface_changes where id = v_cc3)
		and (select auto_approve_after = true and status = 'queued' from public.qorpera_surface_reconciliations where id = v_auto_rec_id),
		'merge conflict keeps change staged and queues auto_approve_after silent reconciliation'
	);

	perform public.qorpera_record_surface_change(
		v_auto_sess_id, 'Reconciled checkout', 'Clean checkout commit', 'git_range',
		repeat('1', 40), repeat('8', 40), '{}'::uuid[], array['src/checkout.tsx'], null, null, true
	);

	perform pg_temp.ssr_assert(
		(select status = 'merging' from public.qorpera_surface_changes where id = v_cc3)
		and exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_code_surface_id
				and j.kind = 'land_change'
				and j.status = 'queued'
				and (j.payload ->> 'reconciliationId')::uuid = v_auto_rec_id
		),
		'completing auto_approve_after reconciliation automatically re-queues land_change with reconciliationId'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_auto_land_job_id, v_auto_land_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_code_surface_id and elem ->> 'reconciledCommitSha' = repeat('8', 40);

	perform public.qorpera_surface_complete_merge(
		v_auto_land_job_id, 'conflicted', repeat('1', 40), null, v_cc3, array['src/checkout.tsx'], 'Still conflicted', null, v_auto_land_lease
	);
	reset role;

	perform pg_temp.ssr_assert(
		not exists (
			select 1 from public.qorpera_surface_jobs j
			where j.surface_id = v_code_surface_id and j.kind = 'land_change' and j.status in ('queued', 'running')
		)
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_cs3 and m.author_kind = 'system' and m.body = 'Could not apply this change automatically. Try approving again.'
		),
		'conflicted retry carrying reconciliationId does not loop and posts plain retry message'
	);

	-- WHY: Verify a fresh member approval after failure retries the reconciliation instead of reusing the stale row.
	perform public.qorpera_surface_fail_reconciliation(v_auto_rec_id, 'Failed earlier');
	update public.qorpera_surface_reconciliations set status = 'failed' where id = v_auto_rec_id;
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_cc3, false);
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_retry_land_job_id, v_retry_land_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_code_surface_id;
	perform public.qorpera_surface_complete_merge(
		v_retry_land_job_id, 'conflicted', repeat('1', 40), null, v_cc3, array['src/checkout.tsx'], 'Conflict again', null, v_retry_land_lease
	);
	reset role;
	perform pg_temp.ssr_assert(
		(select status = 'queued' and session_id <> v_auto_sess_id and auto_approve_after = true
			from public.qorpera_surface_reconciliations where id = v_auto_rec_id),
		'fresh member approval retries failed reconciliation instead of reusing stale failure'
	);

	-- WHY: Verify rebase conflict keeps change staged and queues system-triggered cofounder reconciliation.
	perform pg_temp.ssr_as(v_owner);
	set local role authenticated;
	v_cs_rebase := (public.qorpera_start_surface_session(v_code_surface_id, 'Update footer text', 'Footer') ->> 'id')::uuid;
	reset role;
	v_cc_rebase := (public.qorpera_record_surface_change(
		v_cs_rebase, 'Footer text', 'Footer copy', 'git_range',
		repeat('1', 40), repeat('5', 40), '{}'::uuid[], array['src/footer.tsx'], null, null, true
	) ->> 'changeId')::uuid;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_update_rebased_changes(
		v_code_surface_id, v_cs_rebase, null, '[]'::jsonb, v_cc_rebase, array['src/footer.tsx']
	);
	reset role;

	perform pg_temp.ssr_assert(
		(select status = 'staged' and conflict_paths is null from public.qorpera_surface_changes where id = v_cc_rebase)
		and exists (
			select 1 from public.qorpera_surface_reconciliations r
			join public.qorpera_surface_sessions s on s.id = r.session_id
			where r.surface_id = v_code_surface_id
				and v_cc_rebase = any(r.selected_change_ids)
				and s.origin_kind = 'cofounder'
		),
		'rebase conflict keeps change staged and enqueues system-triggered cofounder silent reconciliation'
	);
end $$;
