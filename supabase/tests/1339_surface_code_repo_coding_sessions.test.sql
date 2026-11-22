-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.scrcs_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_code_repo_coding_sessions: %', p_message;
	end if;
end $$;

create function pg_temp.scrcs_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.scrcs_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.scrcs_start_run(p_orchestrator uuid, p_run uuid)
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
	perform pg_temp.scrcs_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'scrcs-fixture');
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
		'assignmentId', v_assignment ->> 'assignment_id',
		'credentialCapsuleId', v_lease ->> 'credential_capsule_id',
		'computeIdentityId', v_lease ->> 'compute_identity_id',
		'provider', v_run.model_provider,
		'nativeHarness', 'codex-cli',
		'model', v_run.model_id
	);
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_member constant uuid := '85600000-0000-4000-8000-000000000002';
	v_orch constant uuid := '13390000-0000-4000-8000-000000000092';
	v_other_owner constant uuid := '13390000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13390000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13390000-0000-4000-8000-000000000021';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_cofounder_agent uuid;
	v_code_surface_id uuid;
	v_session_member uuid;
	v_session_cofounder uuid;
	v_lease_member uuid;
	v_lease_turn2 uuid;
	v_lease_cofounder uuid;
	v_claimed jsonb;
	v_enq jsonb;
	v_worker_id uuid;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding public.qorpera_coding_sessions%rowtype;
	v_surf_session public.qorpera_surface_sessions%rowtype;
	v_coding_claim jsonb;
	v_coding_lease uuid;
	v_hb timestamptz;
	v_before_lease timestamptz;
	v_begin jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_mat jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_binding jsonb;
	v_auth jsonb;
	v_drain jsonb;
	v_change_1 uuid;
	v_completed jsonb;
	v_errcode text;
	v_big_prompt text := repeat('w', 16000);
	v_cofounder_worker_id uuid;
	v_cofounder_coding_lease uuid;
	v_exp_id uuid;
	v_var_a uuid;
	v_var_b uuid;
	v_lease_a uuid;
	v_lease_b uuid;
	v_worker_a uuid;
	v_worker_b uuid;
	v_coding_lease_a uuid;
	v_coding_lease_b uuid;
	v_exp2_id uuid;
	v_var_c uuid;
	v_lease_c uuid;
	v_worker_c uuid;
	v_session_timeout uuid;
	v_lease_timeout uuid;
	v_worker_timeout uuid;
	v_prev_title text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id, staff_agent_id into strict v_env_a, v_cofounder_agent
	from public.qorpera_company_cofounders
	where profile_id = v_company_a;

	insert into auth.users(id, email) values (v_other_owner, 'owner-scrcs-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Executor Template Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Executor Template Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1339', true, array['codex', 'claude-code']);

	perform public.qorpera_register_runner_orchestrator(v_orch, 'Surface coding fixture', 'process', repeat('0', 64), 3600);

	perform pg_temp.scrcs_assert(
		not has_function_privilege('anon', 'public.qorpera_surface_resolve_coding_sponsor(uuid,uuid,uuid,boolean,text,boolean)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_resolve_coding_sponsor(uuid,uuid,uuid,boolean,text,boolean)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_resolve_coding_sponsor(uuid,uuid,uuid,boolean,text,boolean)', 'EXECUTE'),
		'internal surface coding helpers are revoked from all API roles'
	);

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	v_code_surface_id := (public.qorpera_create_surface(
		v_company_a, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session_member := (public.qorpera_start_surface_session(
		v_code_surface_id, v_big_prompt, 'Build landing preview'
	) ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_member
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_member;

	v_enq := public.qorpera_surface_enqueue_session_run(v_session_member, v_lease_member);
	perform pg_temp.scrcs_assert(
		v_enq ->> 'status' = 'enqueued'
		and (v_enq ->> 'wakeId') is null
		and (v_enq ->> 'workerId') is not null,
		'code_repo enqueue creates a coding worker without a surface-session wake: ' || v_enq::text
	);
	v_worker_id := (v_enq ->> 'workerId')::uuid;

	perform pg_temp.scrcs_assert(
		public.qorpera_surface_enqueue_session_run(v_session_member, v_lease_member) ->> 'workerId' = v_worker_id::text,
		're-enqueuing an active code_repo session returns the existing workerId'
	);
	reset role;

	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	select * into strict v_coding from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select * into strict v_surf_session from public.qorpera_surface_sessions where id = v_session_member;
	perform pg_temp.scrcs_assert(
		v_worker.surface_backed
		and v_worker.surface_session_id = v_session_member
		and v_worker.species = 'coding'
		and v_worker.todo_id is null
		and v_worker.steering_run_id is null
		and v_worker.folder_path is null
		and octet_length(v_worker.dispatch ->> 'goal') <= 2000
		and v_coding.surface_session_id = v_session_member
		and v_coding.phase = 'queued'
		and v_coding.branch = 'qorpera/coding/' || v_worker_id::text
		and v_coding.repository = '{"host":"qorpera","owner":"surfaces","name":"website","baseBranch":"main"}'::jsonb
		and v_surf_session.worker_id = v_worker_id
		and v_surf_session.wake_id is null,
		'worker, coding session, and surface session rows are cleanly linked'
	);
	perform pg_temp.scrcs_assert(
		exists (
			select 1 from public.qorpera_coding_executors e
			where e.environment_id = v_env_a and e.owner = 'exec-1339' and e.enabled and v_coding.harness = any(e.harnesses)
		) and exists (
			select 1 from public.qorpera_coding_repository_grants g
			where g.environment_id = v_env_a and g.staff_agent_id = v_cofounder_agent
				and g.repository = v_coding.repository and g.enabled
		),
		'enqueue auto-enrolls the company coding executor and grants the surface repository'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_drain := public.qorpera_folder_workers_company(v_env_a, 32);
	perform pg_temp.scrcs_assert(v_drain ->> 'state' = 'idle', 'folder worker drain stays idle for surface-backed coding worker: ' || v_drain::text);
	reset role;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13390000-0000-4000-8000-0000000000d1', 'member', v_company_a, v_env_a, v_owner, 'exec-1339', repeat('8', 64), '{}');
	update public.qorpera_execution_sponsor_versions
	set allow_autonomous = false
	where binding_id in (select id from public.qorpera_execution_sponsor_bindings where profile_id = v_company_a);
	update public.qorpera_provider_connection_versions
	set allow_autonomous = false
	where connection_id in (select id from public.qorpera_provider_connections where profile_id = v_company_a);
	set local session_replication_role = origin;

	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	perform pg_temp.scrcs_assert(
		public.qorpera_coding_session_login_state(v_worker) = 'ready',
		'member-initiated surface coding worker stays login_state=ready even when allow_autonomous = false'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1339', 60);
	perform pg_temp.scrcs_assert(
		v_coding_claim ->> 'workerId' = v_worker_id::text
		and v_coding_claim #>> '{surfaceSession,sessionId}' = v_session_member::text
		and v_coding_claim #>> '{surfaceSession,surfaceId}' = v_code_surface_id::text
		and v_coding_claim #>> '{surfaceSession,slug}' = 'website',
		'qorpera_claim_coding_session returns surfaceSession metadata: ' || coalesce(v_coding_claim::text, 'null')
	);
	v_coding_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	reset role;

	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp() - interval '10 minutes'
	where id = v_session_member;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;
	perform pg_temp.scrcs_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_member) = 'running'
		and (select retry_count from public.qorpera_surface_sessions where id = v_session_member) = 0,
		'sessions lane sweep skips coding-backed surface sessions while executor holds live lease'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_record_coding_progress(
		v_worker_id, v_coding_lease, 'preparing', 'Preparing starter repo', null, '[]'::jsonb, null, repeat('a', 40), null, null, null
	);
	reset role;
	perform pg_temp.scrcs_assert(
		(select base_sha from public.qorpera_surface_sessions where id = v_session_member) = repeat('a', 40)
		and (select live_head_sha from public.qorpera_surfaces where id = v_code_surface_id) = repeat('a', 40),
		'qorpera_record_coding_progress syncs base_sha to surface session and surface live_head_sha'
	);

	update public.qorpera_surface_sessions set lease_expires_at = clock_timestamp() where id = v_session_member;
	select lease_expires_at into strict v_before_lease from public.qorpera_surface_sessions where id = v_session_member;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_hb := public.qorpera_heartbeat_coding_session(v_worker_id, v_coding_lease, 120);
	reset role;
	perform pg_temp.scrcs_assert(
		(select lease_expires_at from public.qorpera_surface_sessions where id = v_session_member) > v_before_lease,
		'qorpera_heartbeat_coding_session extends linked surface session lease'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_begin := public.qorpera_begin_coding_turn(v_worker_id, v_coding_lease, '{}');
	reset role;
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.scrcs_assert(
		v_wake.status = 'queued'
		and v_wake.source_kind = 'worker-dispatch'
		and v_wake.parent_run_id is null
		and v_wake.payload #>> '{surfaceSession,sessionId}' = v_session_member::text
		and v_wake.payload #>> '{surfaceSession,surfaceSlug}' = 'website'
		and v_wake.payload #>> '{surfaceSession,leaseToken}' = v_lease_member::text
		and public.qorpera_folder_wake_authorized(v_wake)
		and (select wake_id from public.qorpera_surface_sessions where id = v_session_member) = v_wake.id,
		'qorpera_begin_coding_turn pins a valid root worker-dispatch wake with surfaceSession payload'
	);

	v_mat := pg_temp.scrcs_materialize(v_company_a, 16);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	perform pg_temp.scrcs_assert(
		v_mat ->> 'state' = 'done' and v_wake.status = 'materialized' and v_wake.run_id is not null,
		'member-initiated surface coding wake materializes under allow_autonomous = false: ' || v_mat::text
	);
	select * into strict v_run from public.qorpera_execution_runs where id = v_wake.run_id;
	perform pg_temp.scrcs_assert(
		public.qorpera_run_autonomous_authority(v_run)
		and not public.qorpera_run_autonomous_authority(
			jsonb_populate_record(v_run, jsonb_build_object('requested_by_user_id', v_member))
		),
		'qorpera_run_autonomous_authority admits member-initiated surface coding turn only for its requester'
	);

	v_binding := pg_temp.scrcs_start_run(v_orch, v_run.id);
	update public.qorpera_coding_sessions
	set vm_allocation_id = '13390000-0000-4000-8000-0000000000d2'
	where worker_id = v_worker_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_auth := public.qorpera_authorize_coding_turn(v_binding);
	perform pg_temp.scrcs_assert(
		v_auth #>> '{coding,workerId}' = v_worker_id::text
		and v_auth #>> '{coding,surfaceSessionId}' = v_session_member::text,
		'qorpera_authorize_coding_turn exposes coding.surfaceSessionId: ' || v_auth::text
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"coding_finish"},{"name":"coding_ask"},{"name":"not_a_coding_tool"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.scrcs_assert(v_errcode = '42501', 'qorpera_begin_native_coding_execution rejects non-coding tool even on surface sessions');

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"coding_finish"},{"name":"coding_ask"},{"name":"coding_record_change"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.scrcs_assert(
		v_errcode is null or v_errcode not like '42501:Coding catalog must contain only coding tools%',
		'qorpera_begin_native_coding_execution accepts coding_record_change for surface coding sessions (got ' || coalesce(v_errcode, 'ok') || ')'
	);

	v_change_1 := (public.qorpera_native_surface_record_change(
		v_company_a, v_session_member, 'Hero section', 'Adds hero HTML and CSS', 'git_range',
		null, repeat('b', 40), '{}', array['index.html', 'styles.css'], null, null, false, v_lease_member
	) ->> 'changeId')::uuid;
	perform pg_temp.scrcs_assert(v_change_1 is not null, 'explicit git_range change recorded during coding turn');

	v_errcode := null;
	begin
		perform public.qorpera_complete_coding_turn(
			p_worker_id => v_worker_id,
			p_lease_token => v_coding_lease,
			p_outcome => 'succeeded',
			p_summary => 'Should not land main',
			p_artifacts => jsonb_build_array(jsonb_build_object(
				'kind', 'landed', 'state', 'fast-forward', 'branch', 'main',
				'headSha', repeat('c', 40), 'mainSha', repeat('c', 40)
			))
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.scrcs_assert(v_errcode = '22023', 'surface coding turn rejects landed artifact');

	v_completed := public.qorpera_complete_coding_turn(
		p_worker_id => v_worker_id,
		p_lease_token => v_coding_lease,
		p_outcome => 'succeeded',
		p_summary => 'Staged the landing page preview.',
		p_artifacts => jsonb_build_array(jsonb_build_object(
			'kind', 'staged',
			'branch', 'qorpera/coding/' || v_worker_id::text,
			'baseSha', repeat('a', 40),
			'headSha', repeat('c', 40)
		))
	);
	reset role;

	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	select * into strict v_surf_session from public.qorpera_surface_sessions where id = v_session_member;
	perform pg_temp.scrcs_assert(
		v_worker.state = 'succeeded'
		and v_worker.completion_state = 'suppressed'
		and v_worker.result #>> '{staged,headSha}' = repeat('c', 40)
		and position('Qorpera landed' in coalesce(v_worker.result ->> 'summary', '')) = 0
		and v_surf_session.state = 'ready'
		and v_surf_session.branch_head_sha = repeat('c', 40)
		and v_surf_session.wake_id is null,
		'staged coding completion suppresses worker revival, omits landed sentence, and marks surface session ready'
	);
	perform pg_temp.scrcs_assert(
		(select count(*) from public.qorpera_surface_changes where session_id = v_session_member and kind = 'git_range') = 2
		and exists (
			select 1 from public.qorpera_surface_changes
			where session_id = v_session_member and parent_sha = repeat('b', 40) and head_sha = repeat('c', 40)
		),
		'unrecorded commits between last explicit change and staged headSha are auto-staged as a git_range ChangeUnit'
	);

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_session_member, 'Add a pricing section as well.');
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_turn2
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_member;

	v_enq := public.qorpera_surface_enqueue_session_run(v_session_member, v_lease_turn2);
	perform pg_temp.scrcs_assert(
		v_enq ->> 'status' = 'enqueued' and (v_enq ->> 'workerId')::uuid = v_worker_id,
		'turn 2 reuses the existing coding worker: ' || v_enq::text
	);
	reset role;

	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker_id;
	select * into strict v_coding from public.qorpera_coding_sessions where worker_id = v_worker_id;
	perform pg_temp.scrcs_assert(
		v_worker.sequence = 2 and v_worker.state = 'active' and v_coding.phase = 'input_ready'
		and exists (
			select 1 from public.qorpera_coding_session_turns t
			where t.worker_id = v_worker_id and t.sequence = 2 and t.input_from = 'member'
		),
		'turn 2 advances sequence to 2, transitions coding session to input_ready, and opens turn row'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1339', 60);
	perform pg_temp.scrcs_assert(
		v_coding_claim ->> 'workerId' = v_worker_id::text and (v_coding_claim ->> 'sequence')::integer = 2,
		'coding executor claims turn 2'
	);
	v_coding_lease := (v_coding_claim ->> 'leaseToken')::uuid;

	perform public.qorpera_complete_coding_turn(
		p_worker_id => v_worker_id,
		p_lease_token => v_coding_lease,
		p_outcome => 'blocked',
		p_summary => 'Need direction on pricing layout.',
		p_needs => 'Which layout should I build?',
		p_options => '["Single tier","Three tiers"]'::jsonb
	);
	reset role;

	select * into strict v_surf_session from public.qorpera_surface_sessions where id = v_session_member;
	perform pg_temp.scrcs_assert(
		v_surf_session.state = 'needs_input'
		and v_surf_session.question = '{"text":"Which layout should I build?","options":["Single tier","Three tiers"]}'::jsonb,
		'blocked coding completion transitions surface session to needs_input with {text, options}: ' || coalesce(v_surf_session.question::text, 'null')
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_session_cofounder := (public.qorpera_native_surface_start_session(
		v_company_a, v_code_surface_id, 'Draft footer links', 'Footer pass', 'cofounder', 'Co-Founder'
	) ->> 'sessionId')::uuid;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_cofounder
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_cofounder;

	v_enq := public.qorpera_surface_enqueue_session_run(v_session_cofounder, v_lease_cofounder);
	perform pg_temp.scrcs_assert(
		v_enq ->> 'status' = 'unavailable' and v_enq ->> 'reason' = 'no_sponsor',
		'cofounder code_repo session refuses enqueue when allow_autonomous = false: ' || v_enq::text
	);
	reset role;

	set local session_replication_role = replica;
	update public.qorpera_execution_sponsor_versions
	set allow_autonomous = true
	where binding_id in (select id from public.qorpera_execution_sponsor_bindings where profile_id = v_company_a);
	update public.qorpera_provider_connection_versions
	set allow_autonomous = true
	where connection_id in (select id from public.qorpera_provider_connections where profile_id = v_company_a);
	set local session_replication_role = origin;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_enq := public.qorpera_surface_enqueue_session_run(v_session_cofounder, v_lease_cofounder);
	perform pg_temp.scrcs_assert(
		v_enq ->> 'status' = 'enqueued' and (v_enq ->> 'workerId') is not null,
		'cofounder code_repo session enqueues once allow_autonomous = true: ' || v_enq::text
	);
	v_cofounder_worker_id := (v_enq ->> 'workerId')::uuid;

	v_coding_claim := public.qorpera_claim_coding_session('exec-1339', 60);
	perform pg_temp.scrcs_assert(
		v_coding_claim ->> 'workerId' = v_cofounder_worker_id::text,
		'coding executor claims cofounder code_repo coding session'
	);
	reset role;

	update public.qorpera_coding_sessions
	set lease_until = clock_timestamp() - interval '1 minute'
	where worker_id = v_cofounder_worker_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_claim_coding_session('exec-1339', 60);
	reset role;

	select * into strict v_surf_session from public.qorpera_surface_sessions where id = v_session_cofounder;
	perform pg_temp.scrcs_assert(
		(select completion_state from public.qorpera_runtime_workers where id = v_cofounder_worker_id) = 'suppressed'
		and v_surf_session.state = 'queued'
		and v_surf_session.retry_count = 1,
		'expired coding lease suppresses worker revival and triggers surface session retry'
	);

	perform pg_temp.scrcs_assert(
		position('''coding_record_change''' in pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)) > 0,
		'qorpera_record_runtime_observation allows coding_record_change'
	);

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	v_var_a := (public.qorpera_start_surface_session(
		v_code_surface_id, 'Explore hero layouts', 'Hero exploration', 'member', null, null, 2, 'Hero directions'
	) ->> 'id')::uuid;
	reset role;
	select exploration_id into strict v_exp_id from public.qorpera_surface_sessions where id = v_var_a;
	select id into strict v_var_b from public.qorpera_surface_sessions where exploration_id = v_exp_id and id <> v_var_a;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_a
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_var_a;
	select (elem ->> 'leaseToken')::uuid into strict v_lease_b
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_var_b;
	v_worker_a := (public.qorpera_surface_enqueue_session_run(v_var_a, v_lease_a) ->> 'workerId')::uuid;
	v_worker_b := (public.qorpera_surface_enqueue_session_run(v_var_b, v_lease_b) ->> 'workerId')::uuid;

	reset role;
	select title into strict v_prev_title from public.qorpera_surfaces where id = v_code_surface_id;
	update public.qorpera_surfaces set title = repeat('🌟', 80) where id = v_code_surface_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_coding_claim := public.qorpera_claim_coding_session('exec-1339', 60);
	perform pg_temp.scrcs_assert(
		octet_length(convert_to(v_coding_claim #>> '{surfaceSession,title}', 'utf8')) = 320,
		'80-emoji surface title fits in coding claim JSON without truncation below 320 bytes'
	);
	if (v_coding_claim ->> 'workerId')::uuid = v_worker_a then
		v_coding_lease_a := (v_coding_claim ->> 'leaseToken')::uuid;
		v_coding_claim := public.qorpera_claim_coding_session('exec-1339', 60);
		v_coding_lease_b := (v_coding_claim ->> 'leaseToken')::uuid;
	else
		v_coding_lease_b := (v_coding_claim ->> 'leaseToken')::uuid;
		v_coding_claim := public.qorpera_claim_coding_session('exec-1339', 60);
		v_coding_lease_a := (v_coding_claim ->> 'leaseToken')::uuid;
	end if;
	perform pg_temp.scrcs_assert(
		v_coding_lease_a is not null and v_coding_lease_b is not null,
		'both exploration variant coding sessions claimed'
	);

	perform public.qorpera_complete_coding_turn(
		p_worker_id => v_worker_a,
		p_lease_token => v_coding_lease_a,
		p_outcome => 'succeeded',
		p_summary => 'Variant A ready.',
		p_artifacts => jsonb_build_array(jsonb_build_object(
			'kind', 'staged',
			'branch', 'qorpera/coding/' || v_worker_a::text,
			'baseSha', repeat('1', 40),
			'headSha', repeat('4', 40)
		))
	);
	reset role;
	update public.qorpera_surfaces set title = v_prev_title where id = v_code_surface_id;

	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp() - interval '1 minute'
	where id = v_var_b;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;
	perform pg_temp.scrcs_assert(
		(select state from public.qorpera_surface_sessions where id = v_var_b) = 'running'
		and (select state from public.qorpera_runtime_workers where id = v_worker_b) = 'active',
		'surface lease sweep exempts coding session with live executor lease'
	);

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	perform public.qorpera_choose_exploration(v_exp_id, v_var_a);
	reset role;

	perform pg_temp.scrcs_assert(
		(select state from public.qorpera_surface_sessions where id = v_var_b) = 'discarded'
		and (select lease_token from public.qorpera_surface_sessions where id = v_var_b) is null
		and (select state from public.qorpera_runtime_workers where id = v_worker_b) = 'cancelled'
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker_b) = 'cancelled',
		'qorpera_choose_exploration cancels active coding worker of discarded sibling'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_errcode := null;
	begin
		perform public.qorpera_heartbeat_coding_session(v_worker_b, v_coding_lease_b, 60);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.scrcs_assert(
		v_errcode = '55000',
		'cancelled sibling coding worker fails next heartbeat with 55000, got ' || coalesce(v_errcode, 'ok')
	);

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	v_var_c := (public.qorpera_start_surface_session(
		v_code_surface_id, 'Discardable exploration', 'Discard test', 'member', null, null, 2, 'Discard directions'
	) ->> 'id')::uuid;
	reset role;
	select exploration_id into strict v_exp2_id from public.qorpera_surface_sessions where id = v_var_c;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_c
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_var_c;
	v_worker_c := (public.qorpera_surface_enqueue_session_run(v_var_c, v_lease_c) ->> 'workerId')::uuid;
	reset role;

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	perform public.qorpera_discard_exploration(v_exp2_id);
	reset role;

	perform pg_temp.scrcs_assert(
		(select state from public.qorpera_runtime_workers where id = v_worker_c) = 'cancelled'
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker_c) = 'cancelled',
		'qorpera_discard_exploration cancels active coding workers'
	);

	perform pg_temp.scrcs_as(v_owner);
	set local role authenticated;
	v_session_timeout := (public.qorpera_start_surface_session(
		v_code_surface_id, 'Build when executor is offline', 'Offline executor test'
	) ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_timeout
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_session_timeout;
	v_worker_timeout := (public.qorpera_surface_enqueue_session_run(v_session_timeout, v_lease_timeout) ->> 'workerId')::uuid;
	reset role;

	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp() - interval '1 minute'
	where id = v_session_timeout;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;

	select (elem ->> 'leaseToken')::uuid into v_lease_timeout
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_session_timeout;
	perform pg_temp.scrcs_assert(
		v_lease_timeout is not null
		and (select retry_count from public.qorpera_surface_sessions where id = v_session_timeout) = 1
		and (select state from public.qorpera_runtime_workers where id = v_worker_timeout) = 'cancelled'
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker_timeout) = 'cancelled',
		'unclaimed queued coding session expires on timeout, cancels worker, and retries once'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_enqueue_session_run(v_session_timeout, v_lease_timeout);
	reset role;

	perform pg_temp.scrcs_assert(
		(select phase from public.qorpera_coding_sessions where worker_id = v_worker_timeout) = 'input_ready'
		and (select state from public.qorpera_runtime_workers where id = v_worker_timeout) = 'active',
		'retry turn re-activates worker in input_ready phase'
	);

	update public.qorpera_surface_sessions
	set lease_expires_at = clock_timestamp() - interval '1 minute'
	where id = v_session_timeout;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;

	perform pg_temp.scrcs_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_timeout) = 'failed'
		and (select state from public.qorpera_runtime_workers where id = v_worker_timeout) = 'cancelled'
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker_timeout) = 'cancelled'
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_session_timeout and m.body like 'Session timed out after worker retry%'
		),
		'second unclaimed timeout cancels worker and transitions surface session to failed with readable message'
	);
end $$;
