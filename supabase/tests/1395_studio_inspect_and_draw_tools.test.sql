-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sidt_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'studio_inspect_and_draw_tools: %', p_message;
	end if;
end $$;

create function pg_temp.sidt_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sidt_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.sidt_start_run(p_orchestrator uuid, p_run uuid)
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
	for v_try in 1..12 loop
		v_claim := public.qorpera_claim_runner_job_for_orchestrator(p_orchestrator, extensions.gen_random_uuid(), 120);
		exit when v_claim is null or v_claim #>> '{work,run_id}' = p_run::text;
	end loop;
	perform pg_temp.sidt_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'sidt-fixture');
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
		'nativeHarness', case when v_run.model_provider = 'anthropic' then 'claude-code' else 'codex-cli' end,
		'model', v_run.model_id
	);
end $$;

create function pg_temp.sidt_enable_bundles()
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
	v_manifest := jsonb_set(
		jsonb_set(
			v_active.manifest,
			'{implementation,packages/runtime/src/cloud-claude-mcp-bridge.ts}',
			to_jsonb(repeat('b', 64))
		),
		'{implementation,packages/runtime/src/cloud-surface-coding-tools.ts}',
		to_jsonb(repeat('c', 64))
	);
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
	v_orch constant uuid := '13950000-0000-4000-8000-000000000095';
	v_other_owner constant uuid := '13950000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13950000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13950000-0000-4000-8000-000000000021';
	v_machine_id constant uuid := '13950000-0000-4000-8000-0000000000d1';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_studio_surface uuid;
	v_ops_surface uuid;
	v_code_surface uuid;
	v_studio_session uuid;
	v_ops_session uuid;
	v_code_session uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
	v_worker_studio_id uuid;
	v_worker_ops_id uuid;
	v_worker_code_id uuid;
	v_claim_w jsonb;
	v_begin_w jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_binding_studio jsonb;
	v_binding_ops jsonb;
	v_binding_code jsonb;
	v_auth_studio jsonb;
	v_auth_ops jsonb;
	v_auth_code jsonb;
	v_errcode text;
	v_obs_fn text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env_a
	from public.qorpera_company_cofounders
	where profile_id = v_company_a;

	insert into auth.users(id, email) values (v_other_owner, 'owner-sidt-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SIDT Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SIDT Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1395', true, array['codex', 'claude-code']);
	perform public.qorpera_register_runner_orchestrator(v_orch, 'SIDT fixture', 'process', repeat('0', 64), 3600);
	insert into public.qorpera_execution_host_principals(host_id, provider_adapter, orchestrator_id, credential_sha256)
	values ('sidt-shared-host', 'process', v_orch, repeat('e', 64));
	perform pg_temp.sidt_enable_bundles();

	perform pg_temp.sidt_as(v_owner);
	set local role authenticated;
	v_studio_surface := (public.qorpera_create_surface(
		v_company_a, 'Design Lab', 'design-lab', 'studio', 'custom', 'figure:compass', '#0a84ff', 'surfaces/design-lab', 'Visual lab', false
	) ->> 'id')::uuid;
	v_ops_surface := (public.qorpera_create_surface(
		v_company_a, 'Ops Queue', 'ops-queue', 'ops', 'custom', 'inbox', '#0a84ff', null, 'Ops queue', false
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_code_surface := (public.qorpera_propose_surface(
		v_company_a, 'site', 'Website', 'products', 'live_build', 'code_repo',
		'globe', 'surfaces/site', null, 'static_site', 'Public site', 'website', null, false, true
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.sidt_as(v_owner);
	set local role authenticated;
	v_studio_session := (public.qorpera_start_surface_session(v_studio_surface, 'Draw pricing chart', 'Design Lab') ->> 'id')::uuid;
	v_ops_session := (public.qorpera_start_surface_session(v_ops_surface, 'Send update', 'Ops Queue') ->> 'id')::uuid;
	v_code_session := (public.qorpera_start_surface_session(v_code_surface, 'Polish hero', 'Website') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');

	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_studio_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_studio_session, v_lease);
	v_worker_studio_id := (v_enq ->> 'workerId')::uuid;
	perform pg_temp.sidt_assert(v_worker_studio_id is not null, 'studio enqueue returned workerId');

	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_ops_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_ops_session, v_lease);
	v_worker_ops_id := (v_enq ->> 'workerId')::uuid;
	perform pg_temp.sidt_assert(v_worker_ops_id is not null, 'ops enqueue returned workerId');

	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_code_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_code_session, v_lease);
	v_worker_code_id := (v_enq ->> 'workerId')::uuid;
	perform pg_temp.sidt_assert(v_worker_code_id is not null, 'code enqueue returned workerId');

	reset role;
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(
		id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, repository, binding
	)
	values (
		v_machine_id, 'member', v_company_a, v_env_a, v_owner, 'exec-1395', repeat('8', 64),
		'qorpera/surface-workspace', '{}'::jsonb
	), (
		'13950000-0000-4000-8000-0000000000d2'::uuid, 'member', v_company_a, v_env_a, v_owner, 'exec-1395', repeat('9', 64),
		(select public.qorpera_coding_session_machine_repository(s) from public.qorpera_coding_sessions s where s.worker_id = v_worker_code_id),
		'{}'::jsonb
	);
	set local session_replication_role = origin;
	perform pg_temp.as_service();
	set local role service_role;

	for v_try in 1..3 loop
		v_claim_w := public.qorpera_claim_coding_session('exec-1395', 120);
		perform pg_temp.sidt_assert(v_claim_w is not null, 'claim ' || v_try || ' returned coding session');
		perform public.qorpera_record_coding_progress(
			(v_claim_w ->> 'workerId')::uuid, (v_claim_w ->> 'leaseToken')::uuid, 'preparing', 'Ready', null, '[]'::jsonb,
			null, null, null, null, null
		);
		v_begin_w := public.qorpera_begin_coding_turn(
			(v_claim_w ->> 'workerId')::uuid, (v_claim_w ->> 'leaseToken')::uuid,
			jsonb_build_object('vmId', v_machine_id, 'turnId', extensions.gen_random_uuid())
		);
		reset role;
		select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin_w ->> 'occurrenceId')::uuid;
		perform pg_temp.sidt_materialize(v_company_a, 16);
		select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
		if (v_claim_w ->> 'workerId')::uuid = v_worker_studio_id then
			v_binding_studio := pg_temp.sidt_start_run(v_orch, v_wake.run_id);
		elsif (v_claim_w ->> 'workerId')::uuid = v_worker_ops_id then
			v_binding_ops := pg_temp.sidt_start_run(v_orch, v_wake.run_id);
		elsif (v_claim_w ->> 'workerId')::uuid = v_worker_code_id then
			v_binding_code := pg_temp.sidt_start_run(v_orch, v_wake.run_id);
		end if;
		perform pg_temp.as_service();
		set local role service_role;
	end loop;

	reset role;
	update public.qorpera_coding_sessions
	set vm_allocation_id = v_machine_id
	where worker_id in (v_worker_studio_id, v_worker_ops_id, v_worker_code_id);
	perform pg_temp.as_service();
	set local role service_role;

	v_auth_studio := public.qorpera_authorize_coding_turn(v_binding_studio);
	v_auth_ops := public.qorpera_authorize_coding_turn(v_binding_ops);
	v_auth_code := public.qorpera_authorize_coding_turn(v_binding_code);
	perform pg_temp.sidt_assert(
		v_auth_studio #>> '{coding,workspaceKind}' = 'surface_folder'
			and v_auth_ops #>> '{coding,workspaceKind}' = 'surface_ops'
			and v_auth_code #>> '{coding,workspaceKind}' = 'git_repo',
		'authorize_coding_turn succeeds for studio, ops, and code bindings'
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_studio, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"stage_surface_patch"},{"name":"compose_surface_layout"},{"name":"stage_surface_artifact"},{"name":"inspect_surface"},{"name":"narrate_explainer"},{"name":"make_picture"},{"name":"coding_view_attachment"},{"name":"company_read"},{"name":"company_list"},{"name":"company_search"},{"name":"company_write"},{"name":"company_edit"},{"name":"company_mkdir"},{"name":"data_describe"},{"name":"data_query"},{"name":"read_skill"},{"name":"search_skills"},{"name":"coding_finish"},{"name":"coding_ask"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.sidt_assert(
		v_errcode is null
			or (v_errcode <> '42501:Coding catalog must contain only coding tools'
				and v_errcode <> '42501:Coding turn authority unavailable'),
		'surface_folder admits all 22 tools including inspect_surface, stage_surface_artifact, compose_surface_layout: ' || coalesce(v_errcode, 'ok')
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_ops, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"inspect_surface"},{"name":"coding_finish"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.sidt_assert(
		v_errcode = '42501:Coding catalog must contain only coding tools',
		'surface_ops refuses inspect_surface: ' || coalesce(v_errcode, 'ok')
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_code, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"stage_surface_artifact"},{"name":"coding_finish"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.sidt_assert(
		v_errcode = '42501:Coding catalog must contain only coding tools',
		'git_repo refuses stage_surface_artifact: ' || coalesce(v_errcode, 'ok')
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_code, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"compose_surface_layout"},{"name":"coding_finish"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.sidt_assert(
		v_errcode = '42501:Coding catalog must contain only coding tools',
		'git_repo refuses compose_surface_layout: ' || coalesce(v_errcode, 'ok')
	);

	reset role;
	v_obs_fn := pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure);
	perform pg_temp.sidt_assert(
		strpos(v_obs_fn, '''inspect_surface''') > 0
			and strpos(v_obs_fn, '''stage_surface_artifact''') > 0
			and strpos(v_obs_fn, '''compose_surface_layout''') > 0,
		'qorpera_record_runtime_observation includes all three new studio tools'
	);
end $$;
