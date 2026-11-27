-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sirah_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_inspect_receipt_and_activity_hygiene: %', p_message;
	end if;
end $$;

create function pg_temp.sirah_raises_like(p_sql text, p_sqlstate text, p_message text)
returns void language plpgsql as $$
declare
	v_state text;
	v_err text;
begin
	execute p_sql;
	raise exception 'surface_inspect_receipt_and_activity_hygiene: expected SQLSTATE % (%)', p_sqlstate, p_message;
exception when others then
	get stacked diagnostics v_state = returned_sqlstate, v_err = message_text;
	if v_state is distinct from p_sqlstate or position(p_message in coalesce(v_err, '')) = 0 then
		raise exception 'surface_inspect_receipt_and_activity_hygiene: expected [%] containing %, got [%] %',
			p_sqlstate, p_message, v_state, v_err;
	end if;
end $$;

create function pg_temp.sirah_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sirah_activity(p_user uuid, p_env uuid)
returns jsonb language plpgsql as $$
declare
	v_rows jsonb;
begin
	perform pg_temp.sirah_as(p_user);
	set local role authenticated;
	v_rows := public.qorpera_list_staff_execution_activity(p_env);
	reset role;
	return v_rows;
end $$;

create function pg_temp.sirah_clear_hints() returns void language sql as $$
	delete from realtime.messages where topic like 'qorpera-live-%';
	select set_config('qorpera.live_hints_sent', '', true)::void;
	select set_config('qorpera.live_hints_failed', '', true)::void;
$$;

create function pg_temp.sirah_flush_hints() returns void language plpgsql as $$
begin
	set constraints qorpera_activity_hint, qorpera_activity_hint_status immediate;
	set constraints qorpera_activity_hint, qorpera_activity_hint_status deferred;
end $$;

create function pg_temp.sirah_activity_hints(p_company uuid) returns integer language sql as $$
	select count(*)::integer
	from realtime.messages
	where topic like 'qorpera-live-' || p_company::text || '-%'
		and event = 'activity'
		and extension = 'broadcast'
		and private = true
		and payload = '{"schema":"qorpera.live-hint/v1"}'::jsonb
$$;

create function pg_temp.sirah_start_run(p_orchestrator uuid, p_run uuid)
returns jsonb language plpgsql as $$
declare
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
	v_lease jsonb;
	v_try integer;
begin
	perform pg_temp.as_service();
	for v_try in 1..12 loop
		v_claim := public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator, extensions.gen_random_uuid(), 120);
		exit when v_claim is null or v_claim #>> '{work,run_id}' = p_run::text;
	end loop;
	perform pg_temp.sirah_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'sirah-fixture');
	v_assignment := public.qorpera_assign_runner_job(
		p_orchestrator, (v_claim ->> 'claim_id')::uuid, (v_runner ->> 'runner_id')::uuid,
		extensions.gen_random_uuid(), repeat('3', 64), 120
	);
	perform public.qorpera_accept_runner_assignment(
		(v_runner ->> 'runner_id')::uuid, repeat('2', 64), (v_assignment ->> 'assignment_id')::uuid,
		(v_claim #>> '{work,job_id}')::uuid, repeat('3', 64)
	);
	v_lease := public.qorpera_acquire_native_provider_connection_lease(
		p_run, (v_runner ->> 'runner_id')::uuid, repeat('2', 64),
		(v_assignment ->> 'assignment_id')::uuid, repeat('3', 64), 120
	);
	return jsonb_build_object(
		'leaseId', v_lease ->> 'lease_id',
		'runId', p_run,
		'jobId', v_claim #>> '{work,job_id}',
		'runnerId', v_runner ->> 'runner_id',
		'assignmentId', v_assignment ->> 'assignment_id'
	);
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_orch constant uuid := '14210000-0000-4000-8000-000000000090';
	v_other_owner constant uuid := '14210000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '14210000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '14210000-0000-4000-8000-000000000021';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_cofounder uuid;
	v_first_run uuid;
	v_first_job uuid;
	v_studio_surface uuid;
	v_studio_session uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
	v_studio_worker_id uuid;
	v_coding_claim jsonb;
	v_coding_lease uuid;
	v_begin jsonb;
	v_studio_wake_id uuid;
	v_studio_wake public.qorpera_wake_occurrences%rowtype;
	v_start jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_conn_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_binding jsonb;
	v_activity jsonb;
	v_inspect_receipt_id uuid := extensions.gen_random_uuid();
	v_finish_receipt_id uuid := extensions.gen_random_uuid();
	v_other_receipt_id uuid := extensions.gen_random_uuid();
	v_rev_inspect_id uuid := extensions.gen_random_uuid();
	v_begin_res jsonb;
	v_substrate_id uuid;
	v_complete_result jsonb;
	v_studio_surface_2 uuid;
	v_studio_session_2 uuid;
	v_worker_2_id uuid;
	v_wake_2_id uuid;
	v_wake_2 public.qorpera_wake_occurrences%rowtype;
	v_start_2 jsonb;
	v_run_2 public.qorpera_execution_runs%rowtype;
	v_job_2 public.qorpera_runner_jobs%rowtype;
	v_role text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id, staff_agent_id into strict v_env, v_cofounder
	from public.qorpera_company_cofounders
	where profile_id = v_company;

	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform public.qorpera_folder_materialize_company(v_company, 16);
	select id, job_id into strict v_first_run, v_first_job
	from public.qorpera_execution_runs
	where profile_id = v_company and staff_agent_id = v_cofounder
	order by created_at desc
	limit 1;

	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'failed', finished_at = clock_timestamp() - interval '2 minutes',
		lease_token_sha256 = null, lease_expires_at = null,
		last_error = '[code=PROVIDER_UNAVAILABLE] earlier cofounder failure'
	where id = v_first_job;
	update public.qorpera_wake_occurrences
	set status = 'failed', finished_at = clock_timestamp() - interval '2 minutes'
	where run_id = v_first_run;
	set local session_replication_role = origin;

	insert into auth.users(id, email) values (v_other_owner, 'owner-sirah-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SIRAH Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SIRAH Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1421', true, array['codex']);
	perform public.qorpera_register_runner_orchestrator(v_orch, 'SIRAH fixture', 'process', repeat('0', 64), 3600);

	perform pg_temp.sirah_as(v_owner);
	set local role authenticated;
	v_studio_surface := (public.qorpera_create_surface(
		v_company, 'Strategy', 'strategy-test', 'studio', 'custom', 'compass', '#0a84ff', 'surfaces/strategy-test', 'Strategy workspace', false
	) ->> 'id')::uuid;
	v_studio_session := (public.qorpera_start_surface_session(
		v_studio_surface, 'Refresh competitive positioning', 'Refresh strategy'
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_studio_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_studio_session, v_lease);
	reset role;
	v_studio_worker_id := (v_enq ->> 'workerId')::uuid;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(
		id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding
	)
	values (
		'14210000-0000-4000-8000-0000000000d1', 'member', v_company, v_env, v_owner, 'exec-1421', repeat('8', 64), '{}'
	);
	set local session_replication_role = origin;

	perform pg_temp.as_service();
	set local role service_role;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1421', 60);
	v_coding_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_begin := public.qorpera_begin_coding_turn(v_studio_worker_id, v_coding_lease, '{}');
	reset role;
	v_studio_wake_id := (v_begin ->> 'occurrenceId')::uuid;

	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform public.qorpera_folder_materialize_company(v_company, 16);
	select * into strict v_studio_wake from public.qorpera_wake_occurrences where id = v_studio_wake_id;
	v_start := pg_temp.sirah_start_run(v_orch, v_studio_wake.run_id);

	select * into strict v_run from public.qorpera_execution_runs where id = v_studio_wake.run_id;
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_start ->> 'jobId')::uuid;
	select * into strict v_conn_lease from public.qorpera_native_provider_connection_leases where id = (v_start ->> 'leaseId')::uuid;

	v_binding := jsonb_build_object(
		'leaseId', v_conn_lease.id::text,
		'runId', v_run.id::text,
		'jobId', v_job.id::text,
		'runnerId', v_start ->> 'runnerId',
		'assignmentId', v_start ->> 'assignmentId',
		'credentialCapsuleId', v_conn_lease.credential_capsule_id::text,
		'computeIdentityId', v_run.compute_identity_id::text,
		'provider', 'openai',
		'nativeHarness', 'codex-cli',
		'model', v_run.model_id
	);

	perform pg_temp.as_service();
	v_begin_res := public.qorpera_folder_begin_run_receipt(
		v_binding, v_inspect_receipt_id, 'coding_run_command:studio-inspect:0085510ef7ba057e8926:init',
		repeat('1', 64), repeat('2', 64), false
	);
	perform pg_temp.sirah_assert(
		v_begin_res ->> 'state' = 'executing',
		'studio-inspect receipt starts as executing: ' || coalesce(v_begin_res::text, 'null')
	);

	v_begin_res := public.qorpera_folder_begin_run_receipt(
		v_binding, v_finish_receipt_id, 'coding-finish:1',
		repeat('3', 64), repeat('4', 64), false
	);
	perform pg_temp.sirah_assert(
		v_begin_res ->> 'state' = 'executing',
		'unrelated non-revision studio-inspect executing receipt does not block subsequent begin_run_receipt: '
			|| coalesce(v_begin_res::text, 'null')
	);
	perform public.qorpera_folder_complete_run_receipt(
		v_binding, v_finish_receipt_id, repeat('3', 64), '{"ok":true}'::jsonb, null
	);

	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision
	)
	values (
		v_other_receipt_id, v_run.id, v_job.id, (v_start ->> 'assignmentId')::uuid,
		'coding_run_command:other-cmd:1', 'cloud_tool', repeat('5', 64), repeat('6', 64), 'executing', false
	);
	perform pg_temp.sirah_raises_like(
		format(
			'select public.qorpera_folder_begin_run_receipt(%L::jsonb, %L::uuid, %L, %L, %L, false)',
			v_binding, extensions.gen_random_uuid(), 'coding-after-other:1', repeat('7', 64), repeat('8', 64)
		),
		'55000',
		'run has an unresolved operation'
	);
	delete from public.qorpera_run_operation_receipts where id = v_other_receipt_id;

	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision
	)
	values (
		v_rev_inspect_id, v_run.id, v_job.id, (v_start ->> 'assignmentId')::uuid,
		'coding_run_command:studio-inspect:rev-check', 'cloud_tool', repeat('5', 64), repeat('6', 64), 'executing', true
	);
	perform pg_temp.sirah_raises_like(
		format(
			'select public.qorpera_folder_begin_run_receipt(%L::jsonb, %L::uuid, %L, %L, %L, false)',
			v_binding, extensions.gen_random_uuid(), 'coding-after-rev:1', repeat('7', 64), repeat('8', 64)
		),
		'55000',
		'run has an unresolved operation'
	);
	delete from public.qorpera_run_operation_receipts where id = v_rev_inspect_id;

	update public.qorpera_run_operation_receipts
	set status = 'ambiguous', completed_at = clock_timestamp()
	where id = v_inspect_receipt_id;

	v_substrate_id := coalesce(v_job.substrate_version_id, extensions.gen_random_uuid());
	if v_job.substrate_version_id is null then
		set local session_replication_role = replica;
		insert into public.qorpera_company_substrate_versions(
			id, profile_id, environment_id, company_snapshot_id, client_version_id,
			contract_version, operation_sequence, operation_count, content_sha256, created_by_user_id
		)
		values (
			v_substrate_id, v_company, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			1, 0, 0, repeat('a', 64), v_owner
		);
		update public.qorpera_runner_jobs set substrate_version_id = v_substrate_id where id = v_job.id;
		set local session_replication_role = origin;
	end if;
	insert into public.qorpera_execution_run_events(run_id, event_type, payload)
	values (
		v_run.id, 'runner_started',
		jsonb_build_object(
			'schema', 'qorpera.native-company-execution-start/v1',
			'runId', v_run.id, 'jobId', v_job.id, 'leaseId', v_conn_lease.id, 'binarySha256', repeat('9', 64)
		)
	);
	update public.qorpera_runtime_workers
	set state = 'succeeded',
		result = jsonb_build_object(
			'outcome', 'completed', 'summary', 'Completed via inspect retry', 'needs', null,
			'outputs', '[]'::jsonb, 'runId', v_run.id, 'sequence', sequence
		),
		reported_at = clock_timestamp()
	where id = v_studio_worker_id;

	v_complete_result := jsonb_build_object(
		'schema', 'qorpera.runner-result/v1',
		'runtime', 'company-path-v1',
		'backend', 'native-company-runtime',
		'native_lease_id', v_conn_lease.id,
		'substrate_version_id', v_substrate_id,
		'backend_result', jsonb_build_object(
			'schema', 'qorpera.native-harness-result/v2',
			'run_id', v_run.id,
			'message_count', 0,
			'final_message_id', null,
			'provider_session_id', 'sirah-provider-session'
		),
		'output_count', 0,
		'output_bytes', 0,
		'publication', null,
		'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb
	);

	perform pg_temp.as_service();
	perform public.qorpera_folder_complete_run_job(
		(v_start ->> 'runnerId')::uuid, repeat('2', 64), v_job.id, repeat('3', 64),
		extensions.gen_random_uuid(), v_substrate_id, null, v_complete_result
	);
	select * into strict v_job from public.qorpera_runner_jobs where id = v_job.id;
	perform pg_temp.sirah_assert(
		v_job.status = 'completed',
		'qorpera_folder_complete_run_job completes cleanly despite ambiguous non-revision studio-inspect receipt'
	);

	perform pg_temp.sirah_as(v_owner);
	set local role authenticated;
	v_studio_surface_2 := (public.qorpera_create_surface(
		v_company, 'Strategy 2', 'strategy-test-2', 'studio', 'custom', 'compass', '#0a84ff', 'surfaces/strategy-test-2', 'Strategy workspace 2', false
	) ->> 'id')::uuid;
	v_studio_session_2 := (public.qorpera_start_surface_session(
		v_studio_surface_2, 'Refresh competitive positioning again', 'Refresh strategy 2'
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_studio_session_2;
	v_enq := public.qorpera_surface_enqueue_session_run(v_studio_session_2, v_lease);
	v_worker_2_id := (v_enq ->> 'workerId')::uuid;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1421', 60);
	v_coding_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_begin := public.qorpera_begin_coding_turn(v_worker_2_id, v_coding_lease, '{}');
	reset role;
	v_wake_2_id := (v_begin ->> 'occurrenceId')::uuid;

	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform public.qorpera_folder_materialize_company(v_company, 16);
	select * into strict v_wake_2 from public.qorpera_wake_occurrences where id = v_wake_2_id;
	v_start_2 := pg_temp.sirah_start_run(v_orch, v_wake_2.run_id);
	select * into strict v_run_2 from public.qorpera_execution_runs where id = v_wake_2.run_id;
	select * into strict v_job_2 from public.qorpera_runner_jobs where id = (v_start_2 ->> 'jobId')::uuid;

	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision, completed_at
	)
	values (
		extensions.gen_random_uuid(), v_run_2.id, v_job_2.id, (v_start_2 ->> 'assignmentId')::uuid,
		'coding_run_command:studio-inspect:0085510ef7ba057e8926:init', 'cloud_tool',
		repeat('1', 64), repeat('2', 64), 'ambiguous', false, clock_timestamp()
	);

	perform pg_temp.sirah_flush_hints();
	perform pg_temp.sirah_clear_hints();
	update public.qorpera_runner_jobs
	set status = 'failed', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null,
		last_error = '[code=CODING_TURN_ENDED_WITHOUT_SUBMISSION] Coding session ended before calling coding_finish.'
	where id = v_job_2.id;
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set status = 'failed', finished_at = clock_timestamp() where id = v_wake_2.id;
	set local session_replication_role = origin;
	perform pg_temp.sirah_flush_hints();

	perform pg_temp.sirah_assert(
		pg_temp.sirah_activity_hints(v_company) = 0,
		'failed surface coding run with ambiguous studio-inspect receipt emits zero activity hints'
	);
	v_activity := pg_temp.sirah_activity(v_owner, v_env);
	perform pg_temp.sirah_assert(
		jsonb_array_length(coalesce(v_activity, '[]'::jsonb)) = 1
		and (v_activity -> 0 ->> 'run_id')::uuid = v_first_run
		and v_activity -> 0 ->> 'activity' = 'needs_attention'
		and coalesce((v_activity -> 0 ->> 'superseded')::boolean, false) = false,
		'failed surface coding run with ambiguous studio-inspect receipt stays out of Co-Founder activity: '
			|| coalesce(v_activity::text, 'null')
	);

	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision, completed_at
	)
	values (
		v_other_receipt_id, v_run_2.id, v_job_2.id, (v_start_2 ->> 'assignmentId')::uuid,
		'coding_run_command:other-cmd:1', 'cloud_tool', repeat('a', 64), repeat('b', 64), 'ambiguous', false, clock_timestamp()
	);
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'leased', finished_at = null,
		lease_token_sha256 = repeat('3', 64), lease_expires_at = clock_timestamp() + interval '2 minutes'
	where id = v_job_2.id;
	set local session_replication_role = origin;
	perform pg_temp.sirah_flush_hints();
	perform pg_temp.sirah_clear_hints();
	update public.qorpera_runner_jobs
	set status = 'failed', finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where id = v_job_2.id;
	perform pg_temp.sirah_flush_hints();

	perform pg_temp.sirah_assert(
		pg_temp.sirah_activity_hints(v_company) > 0,
		'failed surface coding run with ambiguous non-inspect coding_run_command receipt still emits activity hint for recovery'
	);
	v_activity := pg_temp.sirah_activity(v_owner, v_env);
	perform pg_temp.sirah_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_run_2.id
				and item ->> 'activity' = 'needs_attention'
		),
		'failed surface coding run with ambiguous non-inspect coding_run_command receipt surfaces in Co-Founder activity: '
			|| coalesce(v_activity::text, 'null')
	);

	perform pg_temp.sirah_assert(
		has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute'),
		'qorpera_list_staff_execution_activity preserves grants'
	);
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.sirah_assert(
			not has_function_privilege(v_role, 'public.qorpera_activity_hint()', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_folder_complete_run_job(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)', 'EXECUTE'),
			'internal trigger and folder functions stay revoked for ' || v_role
		);
	end loop;
end $$;
