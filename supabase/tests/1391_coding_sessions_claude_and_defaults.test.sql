-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ccd_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'coding_sessions_claude_and_defaults: %', p_message;
	end if;
end $$;

create function pg_temp.ccd_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.ccd_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.ccd_start_run(p_orchestrator uuid, p_run uuid)
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
	perform pg_temp.ccd_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'ccd-fixture');
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

create function pg_temp.ccd_open_claude(p_authority uuid, p_capability text, p_binding jsonb)
returns jsonb language sql security definer set search_path = pg_catalog, public as $$
	select public.qorpera_open_claude_login_for_run(p_authority, p_capability, p_binding)
$$;
grant execute on function pg_temp.ccd_open_claude(uuid, text, jsonb) to qorpera_secret_broker;

create function pg_temp.ccd_set_claude_bundle(p_enabled boolean)
returns void language plpgsql as $$
declare
	v_active public.qorpera_runtime_bundles%rowtype;
	v_manifest jsonb;
	v_bundle public.qorpera_runtime_bundles%rowtype;
begin
	select b.* into strict v_active
	from public.qorpera_active_runtime_bundle a
	join public.qorpera_runtime_bundles b on b.id = a.runtime_bundle_id
	where a.singleton;
	v_manifest := v_active.manifest;
	if p_enabled then
		v_manifest := jsonb_set(
			v_manifest,
			'{implementation,packages/runtime/src/cloud-claude-mcp-bridge.ts}',
			to_jsonb(repeat('b', 64))
		);
	else
		v_manifest := v_manifest #- '{implementation,packages/runtime/src/cloud-claude-mcp-bridge.ts}';
	end if;
	insert into public.qorpera_runtime_bundles(bundle_key, version, manifest, sha256)
	select v_active.bundle_key, max(version) + 1, v_manifest,
		encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex')
	from public.qorpera_runtime_bundles where bundle_key = v_active.bundle_key
	returning * into strict v_bundle;
	update public.qorpera_active_runtime_bundle
	set runtime_bundle_id = v_bundle.id, runtime_bundle_sha256 = v_bundle.sha256
	where singleton;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_orch constant uuid := '13900000-0000-4000-8000-000000000092';
	v_other_owner constant uuid := '13900000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13900000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13900000-0000-4000-8000-000000000021';
	v_principal constant uuid := '13900000-0000-4000-8000-000000000050';
	v_authority constant uuid := '13900000-0000-4000-8000-000000000040';
	v_claude_login_1 constant uuid := '13900000-0000-4000-8000-0000000000c1';
	v_claude_login_2 constant uuid := '13900000-0000-4000-8000-0000000000c2';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_surface uuid;
	v_session_1 uuid;
	v_session_2 uuid;
	v_session_gpt uuid;
	v_session_revoked uuid;
	v_claimed jsonb;
	v_lease_1 uuid;
	v_lease_2 uuid;
	v_lease_gpt uuid;
	v_lease_revoked uuid;
	v_enq_1 jsonb;
	v_enq_2 jsonb;
	v_enq_gpt jsonb;
	v_enq_revoked jsonb;
	v_worker_1 public.qorpera_runtime_workers%rowtype;
	v_worker_2 public.qorpera_runtime_workers%rowtype;
	v_worker_gpt public.qorpera_runtime_workers%rowtype;
	v_cs_1 public.qorpera_coding_sessions%rowtype;
	v_cs_gpt public.qorpera_coding_sessions%rowtype;
	v_coding_claim_1 jsonb;
	v_coding_claim_2 jsonb;
	v_begin_1 jsonb;
	v_begin_2 jsonb;
	v_defer_2 jsonb;
	v_wake_1 public.qorpera_wake_occurrences%rowtype;
	v_binding_1 jsonb;
	v_auth_1 jsonb;
	v_usage_res jsonb;
	v_problem text;
	v_payer record;
	v_sponsor jsonb;
	v_rules jsonb;
	v_cofounder public.qorpera_profile_staff%rowtype;
	v_seed_run uuid;
	v_todo_id uuid := '13900000-0000-4000-8000-0000000000f1';
	v_agent_folder text;
	v_errcode text;
	v_role text;
	v_fn text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env_a
	from public.qorpera_company_cofounders
	where profile_id = v_company_a;

	insert into auth.users(id, email) values (v_other_owner, 'owner-ccd-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Executor Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Executor Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1390', true, array['codex', 'claude-code']);
	perform public.qorpera_register_runner_orchestrator(v_orch, 'CCD fixture', 'process', repeat('0', 64), 3600);
	insert into public.qorpera_execution_host_principals(host_id, provider_adapter, orchestrator_id, credential_sha256)
	values ('ccd-shared-host', 'process', v_orch, repeat('e', 64));

	insert into public.qorpera_cloud_secret_broker_principals(
		id, service_origin, key_id, capability_sha256, registers_companies_created_after
	)
	values (v_principal, 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64), '2099-01-01 00:00:00+00');
	insert into public.qorpera_cloud_secret_broker_authorities(
		id, profile_id, service_origin, key_id, capability_sha256, principal_id
	)
	values (v_authority, v_company_a, 'https://vault.qorpera.test', 'vault-root-1', repeat('c', 64), v_principal);
	insert into public.qorpera_model_login_sign_in_companies(profile_id) values (v_company_a)
	on conflict (profile_id) do nothing;
	update public.qorpera_account_model_login_settings set enabled = true;
	insert into public.qorpera_claude_sign_in_members(user_id) values (v_owner) on conflict (user_id) do nothing;

	v_problem := public.qorpera_coding_owner_problem(v_company_a, v_owner, 'claude-code', null);
	perform pg_temp.ccd_assert(
		v_problem = 'The session owner has no active anthropic account connected for claude-code',
		'without Claude login legacy problem holds: ' || coalesce(v_problem, 'null')
	);

	insert into public.qorpera_claude_logins(
		id, owner_user_id, principal_id, client_connection_id, key_id,
		encrypted_envelope, envelope_sha256, provider_account_email, in_use
	)
	values (
		v_claude_login_1, v_owner, v_principal, extensions.gen_random_uuid(), 'vault-root-1',
		convert_to('canary-ccd-1', 'UTF8'),
		encode(extensions.digest(convert_to('canary-ccd-1', 'UTF8'), 'sha256'), 'hex'),
		'owner@example.test', true
	);

	v_problem := public.qorpera_coding_owner_problem(v_company_a, v_owner, 'claude-code', null);
	perform pg_temp.ccd_assert(v_problem is null, 'Claude login clears coding owner problem: ' || coalesce(v_problem, 'null'));
	select * into v_payer from public.qorpera_coding_owner_payer(v_company_a, v_owner, 'claude-code', null);
	perform pg_temp.ccd_assert(v_payer.binding_id is not null, 'Claude coding owner payer returns execution sponsor');

	select * into strict v_cofounder
	from public.qorpera_profile_staff
	where profile_id = v_company_a and folder_environment_id = v_env_a and folder_retired_at is null and deleted_at is null
	order by created_at asc
	limit 1;
	v_agent_folder := public.qorpera_folder_key(public.qorpera_folder_parent_path(v_cofounder.folder_path));
	perform pg_temp.ccd_materialize(v_company_a, 16);
	select r.id into strict v_seed_run
	from public.qorpera_execution_runs r
	where r.profile_id = v_company_a and r.staff_agent_id = v_cofounder.staff_agent_id
	order by r.created_at asc
	limit 1;
	insert into public.qorpera_runtime_agent_todos(
		id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
		folder_environment_id, folder_path, folder_path_version, folder_commit_id
	)
	values (
		v_todo_id, v_company_a, v_env_a, v_cofounder.staff_agent_id, 'coding-check', 'Coding default check', 'open',
		v_env_a, v_agent_folder || '/todos/coding-check.md', v_cofounder.folder_path_version, v_cofounder.folder_commit_id
	);

	perform pg_temp.ccd_set_claude_bundle(false);
	perform pg_temp.ccd_assert(
		not public.qorpera_coding_claude_driver_ready(),
		'bundle without cloud-claude-mcp-bridge reports Claude coding driver not ready'
	);
	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(v_company_a, v_env_a, v_owner, true, null, false);
	perform pg_temp.ccd_assert(
		v_sponsor ->> 'status' = 'ok' and v_sponsor ->> 'harness' = 'codex' and v_sponsor ->> 'model' = 'gpt-6.2-sol',
		'before Claude coding bundle activates, implicit member with Claude login stays on codex: ' || v_sponsor::text
	);

	insert into public.qorpera_member_default_models(user_id, coding_model, coding_effort)
	values (v_owner, 'claude-opus-5-5', 'high')
	on conflict (user_id) do update set coding_model = excluded.coding_model, coding_effort = excluded.coding_effort;
	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(v_company_a, v_env_a, v_owner, true, null, false);
	perform pg_temp.ccd_assert(
		v_sponsor ->> 'status' = 'no_coding_executor',
		'before Claude coding bundle activates, explicit Claude Coding & working fails closed with no_coding_executor: ' || v_sponsor::text
	);

	perform set_config(
		'qorpera.folder_worker',
		jsonb_build_object(
			'action', 'dispatch',
			'species', 'coding',
			'harness', 'claude-code',
			'access', 'read',
			'revival', 'each',
			'title', 'Try Claude before bundle',
			'goal', 'Check driver readiness',
			'doneWhen', 'Done',
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'app', 'name', 'web', 'baseBranch', 'main')
		)::text,
		true
	);
	v_rules := public.qorpera_company_state_worker_rules(
		v_env_a,
		v_company_a,
		jsonb_build_object(
			'staffAgentId', v_cofounder.staff_agent_id,
			'runId', v_seed_run,
			'requesterUserId', v_owner,
			'audience', jsonb_build_object('kind', 'company')
		),
		null,
		v_agent_folder || '/todos/coding-check/w-pre-bundle/brief.md',
		jsonb_build_object(
			'kind', 'worker-brief',
			'id', '13900000-0000-4000-8000-0000000000f2',
			'species', 'coding',
			'harness', 'claude-code',
			'access', 'read',
			'revival', 'each',
			'title', 'Try Claude before bundle',
			'goal', 'Check driver readiness',
			'doneWhen', 'Done',
			'context', null,
			'sources', '[]'::jsonb,
			'followUps', '0',
			'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'app', 'name', 'web', 'baseBranch', 'main')
		) || public.qorpera_company_state_worker_standing('coding', 'read', 'each'),
		'{}'::jsonb
	);
	perform pg_temp.ccd_assert(
		v_rules ->> 'ok' = 'false' and v_rules -> 'problems' -> 0 ->> 'message' like '%not active on this runtime bundle%',
		'worker rules refuse claude-code coding dispatch before Claude coding bundle activates: ' || coalesce(v_rules::text, 'null')
	);

	perform pg_temp.ccd_set_claude_bundle(true);
	perform pg_temp.ccd_assert(
		public.qorpera_coding_claude_driver_ready(),
		'bundle with cloud-claude-mcp-bridge activates Claude coding driver'
	);

	delete from public.qorpera_member_default_models where user_id = v_owner;
	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(v_company_a, v_env_a, v_owner, true, null, false);
	perform pg_temp.ccd_assert(
		v_sponsor ->> 'status' = 'ok'
			and v_sponsor ->> 'harness' = 'claude-code'
			and v_sponsor ->> 'claudeModel' = 'claude-opus-5-5',
		'with Claude coding bundle active, implicit member with Claude login resolves to claude-code: ' || v_sponsor::text
	);

	insert into public.qorpera_member_default_models(user_id, coding_model, coding_effort)
	values (v_owner, 'claude-opus-5-5', 'high')
	on conflict (user_id) do update set coding_model = excluded.coding_model, coding_effort = excluded.coding_effort;

	perform set_config(
		'qorpera.folder_worker',
		jsonb_build_object(
			'action', 'dispatch',
			'species', 'coding',
			'harness', 'codex',
			'access', 'read',
			'revival', 'each',
			'title', 'Try Codex over explicit Claude',
			'goal', 'Must be refused',
			'doneWhen', 'Done',
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'app', 'name', 'web', 'baseBranch', 'main')
		)::text,
		true
	);
	v_rules := public.qorpera_company_state_worker_rules(
		v_env_a,
		v_company_a,
		jsonb_build_object(
			'staffAgentId', v_cofounder.staff_agent_id,
			'runId', v_seed_run,
			'requesterUserId', v_owner,
			'audience', jsonb_build_object('kind', 'company')
		),
		null,
		v_agent_folder || '/todos/coding-check/w-codex-override/brief.md',
		jsonb_build_object(
			'kind', 'worker-brief',
			'id', '13900000-0000-4000-8000-0000000000f3',
			'species', 'coding',
			'harness', 'codex',
			'access', 'read',
			'revival', 'each',
			'title', 'Try Codex over explicit Claude',
			'goal', 'Must be refused',
			'doneWhen', 'Done',
			'context', null,
			'sources', '[]'::jsonb,
			'followUps', '0',
			'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'app', 'name', 'web', 'baseBranch', 'main')
		) || public.qorpera_company_state_worker_standing('coding', 'read', 'each'),
		'{}'::jsonb
	);
	perform pg_temp.ccd_assert(
		v_rules ->> 'ok' = 'false' and v_rules -> 'problems' -> 0 ->> 'message' like '%chose Claude Code%',
		'worker rules refuse agent coding dispatch on codex when member explicitly chose Claude: ' || coalesce(v_rules::text, 'null')
	);
	perform set_config('qorpera.folder_worker', '', true);

	perform pg_temp.ccd_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company_a, 'Claude Site', 'claude-site', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session_1 := (public.qorpera_start_surface_session(v_surface, 'Build the Claude site', 'Claude build 1') ->> 'id')::uuid;
	v_session_2 := (public.qorpera_start_surface_session(v_surface, 'Build second Claude page', 'Claude build 2') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_1
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_1;
	select (elem ->> 'leaseToken')::uuid into strict v_lease_2
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_2;
	v_enq_1 := public.qorpera_surface_enqueue_session_run(v_session_1, v_lease_1);
	v_enq_2 := public.qorpera_surface_enqueue_session_run(v_session_2, v_lease_2);
	reset role;

	perform pg_temp.ccd_assert(v_enq_1 ->> 'status' = 'enqueued' and v_enq_2 ->> 'status' = 'enqueued',
		'both Claude surface sessions enqueue: ' || v_enq_1::text || ' / ' || v_enq_2::text);
	select * into strict v_worker_1 from public.qorpera_runtime_workers where id = (v_enq_1 ->> 'workerId')::uuid;
	select * into strict v_worker_2 from public.qorpera_runtime_workers where id = (v_enq_2 ->> 'workerId')::uuid;
	select * into strict v_cs_1 from public.qorpera_coding_sessions where worker_id = v_worker_1.id;

	perform pg_temp.ccd_assert(
		v_worker_1.harness = 'claude-code'
			and v_worker_1.claude_login_id = v_claude_login_1
			and v_worker_1.claude_model = 'claude-opus-5-5'
			and v_worker_1.claude_effort = 'high'
			and v_cs_1.harness = 'claude-code'
			and v_cs_1.model = 'claude-opus-5-5',
		'Claude default model and login pinned on coding worker and session: ' || to_jsonb(v_worker_1)::text
	);
	perform pg_temp.ccd_assert(
		(select harnesses from public.qorpera_coding_executors where environment_id = v_env_a) = array['codex', 'claude-code'],
		'enrolled executor inherits both codex and claude-code'
	);
	perform pg_temp.ccd_assert(
		public.qorpera_coding_session_login_state(v_worker_1) = 'ready',
		'active Claude coding session login state is ready'
	);

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13900000-0000-4000-8000-0000000000d1', 'member', v_company_a, v_env_a, v_owner, 'exec-1390', repeat('8', 64), '{}');
	set local session_replication_role = origin;

	perform pg_temp.as_service();
	set local role service_role;
	perform public.qorpera_set_claude_parallel_cap(1::smallint, null);
	v_coding_claim_1 := public.qorpera_claim_coding_session('exec-1390', 60);
	v_coding_claim_2 := public.qorpera_claim_coding_session('exec-1390', 60);
	reset role;

	perform pg_temp.ccd_assert(
		v_coding_claim_1 is not null
			and (v_coding_claim_1 ->> 'workerId')::uuid = v_worker_1.id
			and v_coding_claim_1 ->> 'harness' = 'claude-code'
			and v_coding_claim_1 ->> 'model' = 'claude-opus-5-5'
			and v_coding_claim_1 -> 'claude' = jsonb_build_object('model', 'claude-opus-5-5', 'effort', 'high'),
		'claim JSON exposes claude choice: ' || coalesce(v_coding_claim_1::text, 'null')
	);
	perform pg_temp.ccd_assert(
		v_coding_claim_2 is null,
		'second Claude coding session cannot be claimed while first is preparing under cap 1: ' || coalesce(v_coding_claim_2::text, 'null')
	);

	perform pg_temp.as_service();
	set local role service_role;
	perform public.qorpera_set_claude_parallel_cap(2::smallint, null);
	v_coding_claim_2 := public.qorpera_claim_coding_session('exec-1390', 60);
	perform pg_temp.ccd_assert(
		v_coding_claim_2 is not null and (v_coding_claim_2 ->> 'workerId')::uuid = v_worker_2.id,
		'second Claude coding session claims when cap is raised to 2: ' || coalesce(v_coding_claim_2::text, 'null')
	);
	perform public.qorpera_set_claude_parallel_cap(1::smallint, null);
	perform public.qorpera_record_coding_progress(
		v_worker_1.id, (v_coding_claim_1 ->> 'leaseToken')::uuid, 'preparing', 'Preparing Claude repo', null, '[]'::jsonb,
		null, repeat('a', 40), null, null, null
	);
	v_begin_2 := public.qorpera_begin_coding_turn(v_worker_2.id, (v_coding_claim_2 ->> 'leaseToken')::uuid, '{}'::jsonb);
	perform pg_temp.ccd_assert(
		v_begin_2 = '{"state":"refused","reason":"CLAUDE_PARALLEL_LIMIT_REACHED"}'::jsonb,
		'begin returns deferrable refusal when cap was lowered while another session is preparing: ' || coalesce(v_begin_2::text, 'null')
	);
	v_defer_2 := public.qorpera_defer_coding_session(
		v_worker_2.id, (v_coding_claim_2 ->> 'leaseToken')::uuid, 'CLAUDE_PARALLEL_LIMIT_REACHED'
	);
	perform pg_temp.ccd_assert(
		v_defer_2 ->> 'phase' = 'queued' and v_defer_2 ->> 'lastStep' = 'Waiting for a Claude Code slot',
		'deferred Claude session returns to queue with slot step: ' || coalesce(v_defer_2::text, 'null')
	);
	v_begin_1 := public.qorpera_begin_coding_turn(v_worker_1.id, (v_coding_claim_1 ->> 'leaseToken')::uuid, '{}'::jsonb);
	v_coding_claim_2 := public.qorpera_claim_coding_session('exec-1390', 60);
	reset role;

	perform pg_temp.ccd_assert(
		v_coding_claim_2 is null,
		'second Claude coding session waits while first holds the single Claude slot: ' || coalesce(v_coding_claim_2::text, 'null')
	);

	select * into strict v_wake_1 from public.qorpera_wake_occurrences where id = (v_begin_1 ->> 'occurrenceId')::uuid;
	perform pg_temp.ccd_assert(
		v_wake_1.payload ->> 'harness' = 'claude-code'
			and v_wake_1.payload -> 'claude' = jsonb_build_object('model', 'claude-opus-5-5', 'effort', 'high')
			and v_wake_1.payload #>> '{coding,harness}' = 'claude-code',
		'Claude coding wake carries harness and claude choice: ' || v_wake_1.payload::text
	);

	perform pg_temp.ccd_materialize(v_company_a, 16);
	select * into strict v_wake_1 from public.qorpera_wake_occurrences where id = v_wake_1.id;
	perform pg_temp.ccd_assert(v_wake_1.run_id is not null, 'Claude coding wake materialized into a run');
	v_binding_1 := pg_temp.ccd_start_run(v_orch, v_wake_1.run_id);
	update public.qorpera_coding_sessions
	set vm_allocation_id = '13900000-0000-4000-8000-0000000000d2'
	where worker_id = v_worker_1.id;

	perform pg_temp.as_service();
	set local role service_role;
	v_auth_1 := public.qorpera_authorize_coding_turn(v_binding_1);
	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_1, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_record_change"},{"name":"coding_finish"},{"name":"coding_ask"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.ccd_assert(
		v_errcode is null or v_errcode not like '42501:Coding catalog must contain only coding tools%',
		'Claude coding execution admits compact MCP coding catalog: ' || coalesce(v_errcode, 'ok')
	);
	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_1, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_finish"},{"name":"not_a_coding_tool"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ccd_assert(v_errcode = '42501', 'Claude coding execution still rejects non-coding tools');
	v_usage_res := public.qorpera_record_claude_run_usage(
		v_binding_1,
		jsonb_build_object(
			'observedAt', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'windows', jsonb_build_array(jsonb_build_object('id', 'five_hour', 'label', '5 hours', 'usedPercent', 12))
		)
	);
	reset role;

	perform pg_temp.ccd_assert(
		v_auth_1 #>> '{coding,harness}' = 'claude-code'
			and v_auth_1 #>> '{coding,model}' = 'claude-opus-5-5'
			and v_auth_1 #> '{coding,claude}' = jsonb_build_object('model', 'claude-opus-5-5', 'effort', 'high'),
		'authorize_coding_turn exposes claude model and effort: ' || v_auth_1::text
	);
	perform pg_temp.ccd_assert(v_usage_res ->> 'recorded' = 'true', 'Claude coding run records usage');
	perform set_config('qorpera_test.ccd_binding', (v_binding_1 - array['provider', 'nativeHarness', 'model'])::text, false);
	perform set_config('qorpera_test.ccd_state', jsonb_build_object(
		'surface', v_surface,
		'worker1', v_worker_1.id,
		'worker2', v_worker_2.id,
		'wake1', v_wake_1.id,
		'envA', v_env_a
	)::text, false);
end $$;

set local session authorization qorpera_secret_broker;
do $$
declare
	v_open jsonb;
begin
	v_open := pg_temp.ccd_open_claude(
		'13900000-0000-4000-8000-000000000040',
		repeat('c', 64),
		current_setting('qorpera_test.ccd_binding')::jsonb
	);
	if v_open ->> 'state' <> 'open' or v_open ->> 'claudeLoginId' <> '13900000-0000-4000-8000-0000000000c1' then
		raise exception 'coding_sessions_claude_and_defaults: expected open Claude login for coding session, got %', v_open;
	end if;
end $$;
reset session authorization;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_state jsonb := current_setting('qorpera_test.ccd_state')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_principal constant uuid := '13900000-0000-4000-8000-000000000050';
	v_claude_login_1 constant uuid := '13900000-0000-4000-8000-0000000000c1';
	v_claude_login_2 constant uuid := '13900000-0000-4000-8000-0000000000c2';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid := (v_state ->> 'envA')::uuid;
	v_surface uuid := (v_state ->> 'surface')::uuid;
	v_worker_1 public.qorpera_runtime_workers%rowtype;
	v_worker_2_id uuid := (v_state ->> 'worker2')::uuid;
	v_wake_1_id uuid := (v_state ->> 'wake1')::uuid;
	v_session_gpt uuid;
	v_session_revoked uuid;
	v_claimed jsonb;
	v_lease_gpt uuid;
	v_lease_revoked uuid;
	v_enq_gpt jsonb;
	v_enq_revoked jsonb;
	v_worker_gpt public.qorpera_runtime_workers%rowtype;
	v_cs_gpt public.qorpera_coding_sessions%rowtype;
	v_coding_claim_2 jsonb;
	v_sponsor jsonb;
	v_role text;
	v_fn text;
begin
	select * into strict v_worker_1 from public.qorpera_runtime_workers where id = (v_state ->> 'worker1')::uuid;

	update public.qorpera_wake_occurrences set status = 'completed', finished_at = clock_timestamp() where id = v_wake_1_id;
	update public.qorpera_coding_sessions
	set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null, finished_at = clock_timestamp()
	where worker_id = v_worker_1.id;
	update public.qorpera_coding_sessions set claim_after = null where worker_id = v_worker_2_id;
	perform pg_temp.as_service();
	set local role service_role;
	v_coding_claim_2 := public.qorpera_claim_coding_session('exec-1390', 60);
	reset role;
	perform pg_temp.ccd_assert(
		v_coding_claim_2 is not null and (v_coding_claim_2 ->> 'workerId')::uuid = v_worker_2_id,
		'second Claude coding session claims once first finishes: ' || coalesce(v_coding_claim_2::text, 'null')
	);

	update public.qorpera_member_default_models
	set coding_model = 'gpt-6-astra', coding_effort = 'medium', version = version + 1
	where user_id = v_owner;

	perform pg_temp.ccd_as(v_owner);
	set local role authenticated;
	v_session_gpt := (public.qorpera_start_surface_session(v_surface, 'Build GPT page', 'GPT build') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_gpt
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_gpt;
	v_enq_gpt := public.qorpera_surface_enqueue_session_run(v_session_gpt, v_lease_gpt);
	reset role;

	select * into strict v_worker_gpt from public.qorpera_runtime_workers where id = (v_enq_gpt ->> 'workerId')::uuid;
	select * into strict v_cs_gpt from public.qorpera_coding_sessions where worker_id = v_worker_gpt.id;
	perform pg_temp.ccd_assert(
		v_worker_gpt.harness is null
			and v_worker_gpt.claude_login_id is null
			and v_cs_gpt.harness = 'codex'
			and v_cs_gpt.model = 'gpt-6-astra',
		'explicit OpenAI Coding & working routes to codex even while Claude login is active: ' || to_jsonb(v_cs_gpt)::text
	);

	update public.qorpera_member_default_models
	set coding_model = 'claude-fable-5-2', coding_effort = 'max', version = version + 1
	where user_id = v_owner;
	update public.qorpera_claude_logins
	set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null, in_use = false
	where id = v_claude_login_1;

	perform pg_temp.ccd_assert(
		public.qorpera_coding_session_login_state(v_worker_1) = 'removed',
		'revoked Claude login marks coding session login state removed'
	);

	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(v_company_a, v_env_a, v_owner, true, null, false);
	perform pg_temp.ccd_assert(
		v_sponsor ->> 'status' = 'no_sponsor',
		'explicit Claude Coding & working never silently falls back to GPT/Codex: ' || v_sponsor::text
	);

	perform pg_temp.ccd_as(v_owner);
	set local role authenticated;
	v_session_revoked := (public.qorpera_start_surface_session(v_surface, 'Must fail on Claude', 'No GPT fallback') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease_revoked
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_revoked;
	v_enq_revoked := public.qorpera_surface_enqueue_session_run(v_session_revoked, v_lease_revoked);
	reset role;
	perform pg_temp.ccd_assert(
		v_enq_revoked ->> 'status' = 'unavailable' and v_enq_revoked ->> 'reason' = 'no_sponsor',
		'enqueue fails closed when Claude login is revoked: ' || v_enq_revoked::text
	);

	insert into public.qorpera_claude_logins(
		id, owner_user_id, principal_id, client_connection_id, key_id,
		encrypted_envelope, envelope_sha256, provider_account_email, in_use
	)
	values (
		v_claude_login_2, v_owner, v_principal, extensions.gen_random_uuid(), 'vault-root-1',
		convert_to('canary-ccd-2', 'UTF8'),
		encode(extensions.digest(convert_to('canary-ccd-2', 'UTF8'), 'sha256'), 'hex'),
		'owner@example.test', true
	);
	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(v_company_a, v_env_a, v_owner, true, null, false);
	perform pg_temp.ccd_assert(
		v_sponsor ->> 'status' = 'ok'
			and v_sponsor ->> 'harness' = 'claude-code'
			and v_sponsor ->> 'claudeModel' = 'claude-fable-5-2'
			and v_sponsor ->> 'claudeEffort' = 'max',
		're-signing in restores Claude Fable 5.2 / max: ' || v_sponsor::text
	);

	foreach v_fn in array array[
		'public.qorpera_coding_claude_driver_ready()',
		'public.qorpera_claude_worker_active_count(uuid,uuid)',
		'public.qorpera_coding_claude_login(uuid,uuid)',
		'public.qorpera_member_coding_default(uuid,uuid)',
		'public.qorpera_surface_resolve_coding_provider_binding(uuid,uuid,boolean,text)'
	] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			perform pg_temp.ccd_assert(
				not has_function_privilege(v_role, v_fn, 'execute'),
				v_role || ' must not execute ' || v_fn
			);
		end loop;
	end loop;
end $$;
