-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.scae_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_coding_activity_exclusion: %', p_message;
	end if;
end $$;

create function pg_temp.scae_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.scae_activity(p_user uuid, p_env uuid)
returns jsonb language plpgsql as $$
declare
	v_rows jsonb;
begin
	perform pg_temp.scae_as(p_user);
	set local role authenticated;
	v_rows := public.qorpera_list_staff_execution_activity(p_env);
	reset role;
	return v_rows;
end $$;

create function pg_temp.scae_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.scae_start_run(p_orchestrator uuid, p_run uuid)
returns jsonb language plpgsql as $$
declare
	v_claim jsonb;
	v_runner jsonb;
	v_assignment jsonb;
	v_lease jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_try integer;
begin
	perform pg_temp.as_service();
	for v_try in 1..8 loop
		v_claim := public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator, extensions.gen_random_uuid(), 120);
		exit when v_claim is null or v_claim #>> '{work,run_id}' = p_run::text;
	end loop;
	perform pg_temp.scae_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'scae-fixture');
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
	select * into strict v_run from public.qorpera_execution_runs where id = p_run;
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
	v_orch constant uuid := '13640000-0000-4000-8000-000000000092';
	v_other_owner constant uuid := '13640000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13640000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13640000-0000-4000-8000-000000000021';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_cofounder uuid;
	v_first_run uuid;
	v_first_job uuid;
	v_code_surface uuid;
	v_surf_session uuid;
	v_claimed jsonb;
	v_surf_lease uuid;
	v_enq jsonb;
	v_surf_worker_id uuid;
	v_surf_worker public.qorpera_runtime_workers%rowtype;
	v_coding_claim jsonb;
	v_coding_lease uuid;
	v_begin jsonb;
	v_surf_wake public.qorpera_wake_occurrences%rowtype;
	v_surf_binding jsonb;
	v_activity jsonb;
	v_chat_todo_id uuid := '13640000-0000-4000-8000-0000000001a0';
	v_chat_worker_id uuid := '13640000-0000-4000-8000-0000000001b0';
	v_chat_worker public.qorpera_runtime_workers%rowtype;
	v_chat_claim jsonb;
	v_chat_lease uuid;
	v_chat_begin jsonb;
	v_chat_wake public.qorpera_wake_occurrences%rowtype;
	v_chat_binding jsonb;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id, staff_agent_id into strict v_env, v_cofounder
	from public.qorpera_company_cofounders
	where profile_id = v_company;

	perform pg_temp.scae_materialize(v_company, 16);
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

	insert into auth.users(id, email) values (v_other_owner, 'owner-scae-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Executor Template Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Executor Template Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1364', true, array['codex', 'claude-code']);
	perform public.qorpera_register_runner_orchestrator(v_orch, 'Surface coding activity fixture', 'process', repeat('0', 64), 3600);

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13640000-0000-4000-8000-0000000000d1', 'member', v_company, v_env, v_owner, 'exec-1364', repeat('8', 64), '{}');
	set local session_replication_role = origin;

	perform pg_temp.scae_as(v_owner);
	set local role authenticated;
	v_code_surface := (public.qorpera_create_surface(
		v_company, 'Brooks', 'brooks', 'live_build', 'product', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_surf_session := (public.qorpera_start_surface_session(
		v_code_surface, 'Build the Brooks preview', 'First build'
	) ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_surf_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_surf_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_surf_session, v_surf_lease);
	perform pg_temp.scae_assert(
		v_enq ->> 'status' = 'enqueued' and (v_enq ->> 'workerId') is not null,
		'code_repo surface enqueue creates coding worker: ' || v_enq::text
	);
	v_surf_worker_id := (v_enq ->> 'workerId')::uuid;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1364', 60);
	perform pg_temp.scae_assert(
		v_coding_claim ->> 'workerId' = v_surf_worker_id::text,
		'coding executor claims surface coding worker: ' || coalesce(v_coding_claim::text, 'null')
	);
	v_coding_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_begin := public.qorpera_begin_coding_turn(v_surf_worker_id, v_coding_lease, '{}');
	reset role;

	select * into strict v_surf_worker from public.qorpera_runtime_workers where id = v_surf_worker_id;
	perform pg_temp.scae_assert(
		v_surf_worker.surface_backed and v_surf_worker.staff_agent_id = v_cofounder,
		'surface coding worker is surface_backed and owned by Co-Founder'
	);

	perform pg_temp.scae_materialize(v_company, 16);
	select * into strict v_surf_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.scae_assert(
		v_surf_wake.source_kind = 'worker-dispatch' and v_surf_wake.status = 'materialized' and v_surf_wake.run_id is not null,
		'surface coding turn materializes as worker-dispatch wake run'
	);

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_surf_wake.run_id
		),
		'queued surface-backed coding run does not appear in Co-Founder activity: ' || coalesce(v_activity::text, 'null')
	);

	v_surf_binding := pg_temp.scae_start_run(v_orch, v_surf_wake.run_id);

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_surf_wake.run_id
		),
		'leased surface-backed coding run does not appear in Co-Founder activity: ' || coalesce(v_activity::text, 'null')
	);

	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'failed', lease_token_sha256 = null, lease_expires_at = null, result = null,
		last_error = 'Simulated Co-Founder failure', finished_at = clock_timestamp() - interval '5 minutes'
	where id = v_first_job;
	set local session_replication_role = origin;

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_first_run
				and coalesce((item ->> 'superseded')::boolean, false) = false
		),
		'newer surface-backed coding run does not supersede an earlier Co-Founder failure: ' || coalesce(v_activity::text, 'null')
	);

	set local session_replication_role = replica;
	update public.qorpera_runner_jobs
	set status = 'failed', lease_token_sha256 = null, lease_expires_at = null, result = null,
		last_error = 'Simulated surface coding failure', finished_at = clock_timestamp()
	where id = (v_surf_binding ->> 'jobId')::uuid;
	update public.qorpera_wake_occurrences
	set status = 'failed', finished_at = clock_timestamp(), blocked_reason = 'simulated failure'
	where id = v_surf_wake.id;
	delete from public.qorpera_coding_session_turns where occurrence_id = v_surf_wake.id;
	set local session_replication_role = origin;

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_surf_wake.run_id
		),
		'failed surface-backed worker-dispatch wake without ambiguous receipts stays out of Co-Founder activity'
	);

	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(
		id, run_id, job_id, assignment_id, operation_kind, logical_operation_key,
		input_sha256, downstream_idempotency_sha256, status, requires_company_revision, completed_at
	)
	values (
		extensions.gen_random_uuid(),
		v_surf_wake.run_id, (v_surf_binding ->> 'jobId')::uuid, (v_surf_binding ->> 'assignmentId')::uuid,
		'cloud_tool', 'surface_coding:ambig-check', repeat('1', 64), repeat('2', 64), 'ambiguous', false, clock_timestamp()
	);
	set local session_replication_role = origin;

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_surf_wake.run_id and item ->> 'activity' = 'needs_attention'
		),
		'failed surface-backed worker-dispatch wake with an ambiguous receipt stays visible for recovery'
	);

	set local session_replication_role = replica;
	update public.qorpera_run_operation_receipts
	set status = 'completed', result = '{}'::jsonb
	where run_id = v_surf_wake.run_id;
	update public.qorpera_runtime_workers
	set state = 'failed',
		result = jsonb_build_object('outcome', 'failed', 'summary', 'Simulated failure', 'needs', null, 'outputs', '[]'::jsonb, 'runId', null, 'sequence', sequence),
		reported_at = clock_timestamp(),
		completion_state = 'suppressed'
	where id = v_surf_worker_id;
	update public.qorpera_coding_sessions
	set phase = 'failed', finished_at = clock_timestamp(), lease_owner = null, lease_token = null, lease_until = null
	where worker_id = v_surf_worker_id;
	insert into public.qorpera_runtime_agent_todos(
		id, profile_id, environment_id, staff_agent_id, todo_key, title,
		requested_by_user_id, created_by_run_id, updated_by_run_id
	)
	values (
		v_chat_todo_id, v_company, v_env, v_cofounder, 'chat-coding-task', 'Chat coding task',
		v_owner, v_first_run, v_first_run
	);
	insert into public.qorpera_runtime_workers(
		id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
		access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
		owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
		surface_backed, surface_session_id
	)
	values (
		v_chat_worker_id, v_company, v_env, v_cofounder, v_chat_todo_id, 'chat-coding-1', 'coding', 'Chat coding task',
		'read', 'each', '{"goal":"Implement feature","definitionOfDone":"Tests pass"}'::jsonb, 'active', 1, v_owner, v_first_run,
		v_owner, v_surf_worker.owner_sponsor_binding_id, v_surf_worker.owner_sponsor_version,
		false, null
	);
	insert into public.qorpera_coding_sessions(
		worker_id, profile_id, environment_id, harness, repository, branch, phase, surface_session_id
	)
	values (
		v_chat_worker_id, v_company, v_env, 'codex',
		'{"host":"qorpera","owner":"surfaces","name":"brooks","baseBranch":"main"}'::jsonb,
		'qorpera/coding/' || v_chat_worker_id::text, 'queued', null
	);
	set local session_replication_role = origin;

	select * into strict v_chat_worker from public.qorpera_runtime_workers where id = v_chat_worker_id;
	perform pg_temp.as_service();
	perform public.qorpera_coding_session_queue(v_chat_worker, 'dispatch', null, null);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_chat_claim := public.qorpera_claim_coding_session('exec-1364', 60);
	perform pg_temp.scae_assert(
		v_chat_claim ->> 'workerId' = v_chat_worker_id::text,
		'coding executor claims chat-dispatched coding worker: ' || coalesce(v_chat_claim::text, 'null')
	);
	v_chat_lease := (v_chat_claim ->> 'leaseToken')::uuid;
	v_chat_begin := public.qorpera_begin_coding_turn(v_chat_worker_id, v_chat_lease, '{}');
	reset role;

	perform pg_temp.scae_materialize(v_company, 16);
	select * into strict v_chat_wake from public.qorpera_wake_occurrences where id = (v_chat_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.scae_assert(
		v_chat_wake.source_kind = 'worker-dispatch' and v_chat_wake.status = 'materialized' and v_chat_wake.run_id is not null,
		'chat-dispatched coding turn materializes as worker-dispatch wake run'
	);

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_chat_wake.run_id and item ->> 'activity' = 'waiting'
		) and exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_first_run and (item ->> 'superseded')::boolean = true
		),
		'queued chat-dispatched coding turn remains visible in Co-Founder activity and supersedes earlier failure: ' || coalesce(v_activity::text, 'null')
	);

	v_chat_binding := pg_temp.scae_start_run(v_orch, v_chat_wake.run_id);

	v_activity := pg_temp.scae_activity(v_owner, v_env);
	perform pg_temp.scae_assert(
		exists (
			select 1 from jsonb_array_elements(coalesce(v_activity, '[]'::jsonb)) item
			where (item ->> 'run_id')::uuid = v_chat_wake.run_id and item ->> 'activity' = 'working'
		),
		'leased chat-dispatched coding turn remains visible as working in Co-Founder activity: ' || coalesce(v_activity::text, 'null')
	);

	perform pg_temp.scae_assert(
		has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		and not exists (
			select 1 from pg_proc, aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
			where pg_proc.oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure and acl.grantee = 0
		),
		'qorpera_list_staff_execution_activity preserves its grants'
	);
end $$;
