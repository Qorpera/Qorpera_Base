-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ssoc_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_studio_ops_coding_sessions: %', p_message;
	end if;
end $$;

create function pg_temp.ssoc_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.ssoc_materialize(p_profile uuid, p_limit integer default 16)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_materialize_company(p_profile, p_limit);
end $$;

create function pg_temp.ssoc_start_run(p_orchestrator uuid, p_run uuid)
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
	perform pg_temp.ssoc_assert(
		v_claim #>> '{work,run_id}' = p_run::text,
		'expected runner job for run ' || p_run::text || ', got ' || coalesce(v_claim::text, 'null')
	);
	v_runner := public.qorpera_provision_execution_runner(p_run, extensions.gen_random_uuid(), 'process', repeat('1', 64));
	perform public.qorpera_activate_runner((v_runner ->> 'runner_id')::uuid, repeat('1', 64), repeat('2', 64), 'linux', 'ssoc-fixture');
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

create function pg_temp.ssoc_set_bundles(p_claude boolean, p_surface_coding boolean)
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
	if p_claude then
		v_manifest := jsonb_set(
			v_manifest,
			'{implementation,packages/runtime/src/cloud-claude-mcp-bridge.ts}',
			to_jsonb(repeat('b', 64))
		);
	else
		v_manifest := v_manifest #- '{implementation,packages/runtime/src/cloud-claude-mcp-bridge.ts}';
	end if;
	if p_surface_coding then
		v_manifest := jsonb_set(
			v_manifest,
			'{implementation,packages/runtime/src/cloud-surface-coding-tools.ts}',
			to_jsonb(repeat('c', 64))
		);
	else
		v_manifest := v_manifest #- '{implementation,packages/runtime/src/cloud-surface-coding-tools.ts}';
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
	v_orch constant uuid := '13920000-0000-4000-8000-000000000092';
	v_other_owner constant uuid := '13920000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13920000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13920000-0000-4000-8000-000000000021';
	v_principal constant uuid := '13920000-0000-4000-8000-000000000050';
	v_authority constant uuid := '13920000-0000-4000-8000-000000000040';
	v_claude_login constant uuid := '13920000-0000-4000-8000-0000000000c1';
	v_machine_id constant uuid := '13920000-0000-4000-8000-0000000000d1';
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_studio_surface uuid;
	v_ops_surface uuid;
	v_legacy_session uuid;
	v_studio_session uuid;
	v_ops_session uuid;
	v_revoked_session uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_studio_lease uuid;
	v_ops_lease uuid;
	v_enq jsonb;
	v_studio_enq jsonb;
	v_ops_enq jsonb;
	v_worker_studio public.qorpera_runtime_workers%rowtype;
	v_worker_ops public.qorpera_runtime_workers%rowtype;
	v_cs_studio public.qorpera_coding_sessions%rowtype;
	v_cs_ops public.qorpera_coding_sessions%rowtype;
	v_machine public.qorpera_coding_machines%rowtype;
	v_claim_studio jsonb;
	v_claim_ops jsonb;
	v_begin_studio jsonb;
	v_begin_ops jsonb;
	v_wake_studio public.qorpera_wake_occurrences%rowtype;
	v_wake_ops public.qorpera_wake_occurrences%rowtype;
	v_binding_studio jsonb;
	v_binding_ops jsonb;
	v_auth_studio jsonb;
	v_auth_ops jsonb;
	v_submit_studio jsonb;
	v_submit_ops jsonb;
	v_complete_studio jsonb;
	v_complete_ops jsonb;
	v_surf_row public.qorpera_surface_sessions%rowtype;
	v_view_id uuid := '13920000-0000-4000-8000-0000000000e1';
	v_commit_res jsonb;
	v_refusal text;
	v_payer_problem text;
	v_errcode text;
	v_role text;
	v_fn text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env_a
	from public.qorpera_company_cofounders
	where profile_id = v_company_a;

	insert into auth.users(id, email) values (v_other_owner, 'owner-ssoc-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SSOC Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SSOC Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1392', true, array['codex', 'claude-code']);
	perform public.qorpera_register_runner_orchestrator(v_orch, 'SSOC fixture', 'process', repeat('0', 64), 3600);
	insert into public.qorpera_execution_host_principals(host_id, provider_adapter, orchestrator_id, credential_sha256)
	values ('ssoc-shared-host', 'process', v_orch, repeat('e', 64));

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
	insert into public.qorpera_claude_logins(
		id, owner_user_id, principal_id, client_connection_id, key_id,
		encrypted_envelope, envelope_sha256, provider_account_email, in_use
	)
	values (
		v_claude_login, v_owner, v_principal, extensions.gen_random_uuid(), 'vault-root-1',
		convert_to('canary-ssoc-1', 'UTF8'),
		encode(extensions.digest(convert_to('canary-ssoc-1', 'UTF8'), 'sha256'), 'hex'),
		'owner@example.test', true
	);

	perform pg_temp.ssoc_as(v_owner);
	set local role authenticated;
	v_studio_surface := (public.qorpera_create_surface(
		v_company_a, 'Brand Studio', 'brand-studio', 'studio', 'custom', 'palette', '#0a84ff', 'surfaces/brand-studio', 'Brand workspace', false
	) ->> 'id')::uuid;
	v_ops_surface := (public.qorpera_create_surface(
		v_company_a, 'Operations', 'ops-desk', 'ops', 'custom', 'inbox', '#0a84ff', null, 'Ops workspace', false
	) ->> 'id')::uuid;
	reset role;

	perform pg_temp.ssoc_set_bundles(true, false);
	perform pg_temp.ssoc_assert(
		not public.qorpera_surface_studio_ops_coding_ready(),
		'bundle without cloud-surface-coding-tools reports Studio/Ops coding not ready'
	);

	perform pg_temp.ssoc_as(v_owner);
	set local role authenticated;
	v_legacy_session := (public.qorpera_start_surface_session(v_studio_surface, 'Legacy studio turn', 'Legacy Studio') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_legacy_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_legacy_session, v_lease);
	reset role;
	perform pg_temp.ssoc_assert(
		v_enq ->> 'status' = 'enqueued' and (v_enq ->> 'workerId') is null and (v_enq ->> 'wakeId') is not null,
		'before bundle activation, folder surface stays on legacy surface-session wake: ' || coalesce(v_enq::text, 'null')
	);

	perform pg_temp.ssoc_set_bundles(true, true);
	perform pg_temp.ssoc_assert(
		public.qorpera_surface_studio_ops_coding_ready(),
		'bundle with cloud-surface-coding-tools activates Studio/Ops coding'
	);

	insert into public.qorpera_member_default_models(user_id, coding_model, coding_effort)
	values (v_owner, 'claude-opus-5-5', 'high')
	on conflict (user_id) do update set coding_model = excluded.coding_model, coding_effort = excluded.coding_effort;

	perform pg_temp.ssoc_as(v_owner);
	set local role authenticated;
	v_studio_session := (public.qorpera_start_surface_session(v_studio_surface, 'Design new brand overview', 'Brand Overview') ->> 'id')::uuid;
	v_ops_session := (public.qorpera_start_surface_session(v_ops_surface, 'Prepare vendor outreach', 'Vendor Outreach') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_studio_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_studio_session;
	select (elem ->> 'leaseToken')::uuid into strict v_ops_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_ops_session;
	v_studio_enq := public.qorpera_surface_enqueue_session_run(v_studio_session, v_studio_lease);
	v_ops_enq := public.qorpera_surface_enqueue_session_run(v_ops_session, v_ops_lease);
	reset role;

	perform pg_temp.ssoc_assert(
		v_studio_enq ->> 'status' = 'enqueued' and (v_studio_enq ->> 'workerId') is not null,
		'Studio session enqueues onto coding worker: ' || coalesce(v_studio_enq::text, 'null')
	);
	perform pg_temp.ssoc_assert(
		v_ops_enq ->> 'status' = 'enqueued' and (v_ops_enq ->> 'workerId') is not null,
		'Ops session enqueues onto coding worker: ' || coalesce(v_ops_enq::text, 'null')
	);

	select * into strict v_worker_studio from public.qorpera_runtime_workers where id = (v_studio_enq ->> 'workerId')::uuid;
	select * into strict v_worker_ops from public.qorpera_runtime_workers where id = (v_ops_enq ->> 'workerId')::uuid;
	select * into strict v_cs_studio from public.qorpera_coding_sessions where worker_id = v_worker_studio.id;
	select * into strict v_cs_ops from public.qorpera_coding_sessions where worker_id = v_worker_ops.id;

	perform pg_temp.ssoc_assert(
		v_cs_studio.workspace_kind = 'surface_folder'
			and v_cs_studio.repository is null
			and v_cs_studio.harness = 'claude-code'
			and v_cs_studio.model = 'claude-opus-5-5'
			and v_worker_studio.claude_login_id = v_claude_login
			and v_worker_studio.claude_model = 'claude-opus-5-5'
			and v_worker_studio.claude_effort = 'high',
		'Studio coding session stores workspace_kind=surface_folder, null repository, and Claude choice: ' || to_jsonb(v_cs_studio)::text
	);
	perform pg_temp.ssoc_assert(
		v_cs_ops.workspace_kind = 'surface_ops'
			and v_cs_ops.repository is null
			and v_cs_ops.harness = 'claude-code'
			and v_cs_ops.model = 'claude-opus-5-5'
			and v_worker_ops.claude_login_id = v_claude_login,
		'Ops coding session stores workspace_kind=surface_ops, null repository, and Claude choice: ' || to_jsonb(v_cs_ops)::text
	);
	perform pg_temp.ssoc_assert(
		public.qorpera_coding_session_machine_repository(v_cs_studio) = 'qorpera/surface-workspace'
			and public.qorpera_coding_session_machine_repository(v_cs_ops) = 'qorpera/surface-workspace',
		'Studio and Ops share one machine repository key'
	);
	perform pg_temp.ssoc_assert(
		not public.qorpera_coding_repository_valid(
			jsonb_build_object('host', 'github.com', 'owner', 'Qorpera', 'name', 'surface-workspace', 'baseBranch', 'main')
		)
			and not public.qorpera_coding_repository_valid(
				jsonb_build_object('host', 'qorpera', 'owner', 'qorpera', 'name', 'surface-workspace', 'baseBranch', 'main')
			)
			and public.qorpera_coding_repository_valid(
				jsonb_build_object('host', 'qorpera', 'owner', 'qorpera', 'name', 'other-repo', 'baseBranch', 'main')
			),
		'qorpera/surface-workspace sentinel is reserved in qorpera_coding_repository_valid'
	);

	v_errcode := null;
	begin
		update public.qorpera_coding_sessions
		set repository = jsonb_build_object('host', 'qorpera', 'owner', 'a', 'name', 'b', 'baseBranch', 'main')
		where worker_id = v_cs_studio.worker_id;
	exception when check_violation then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ssoc_assert(v_errcode = '23514', 'surface_folder rejects non-null repository');

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(
		id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, repository, binding
	)
	values (
		v_machine_id, 'member', v_company_a, v_env_a, v_owner, 'exec-1392', repeat('8', 64),
		'qorpera/surface-workspace', '{}'::jsonb
	);
	set local session_replication_role = origin;
	select * into strict v_machine from public.qorpera_coding_machines where id = v_machine_id;

	perform pg_temp.as_service();
	set local role service_role;
	perform public.qorpera_set_claude_parallel_cap(4::smallint, null);
	v_claim_studio := public.qorpera_claim_coding_session('exec-1392', 60);
	v_claim_ops := public.qorpera_claim_coding_session('exec-1392', 60);
	reset role;

	if (v_claim_studio ->> 'workerId')::uuid = v_worker_ops.id then
		v_enq := v_claim_studio;
		v_claim_studio := v_claim_ops;
		v_claim_ops := v_enq;
	end if;
	perform pg_temp.ssoc_assert(
		(v_claim_studio ->> 'workerId')::uuid = v_worker_studio.id
			and v_claim_studio ->> 'workspaceKind' = 'surface_folder'
			and (v_claim_studio -> 'repository') = 'null'::jsonb
			and v_claim_studio #>> '{surfaceSession,sessionId}' = v_studio_session::text,
		'Studio claim JSON exposes workspaceKind=surface_folder and null repository: ' || coalesce(v_claim_studio::text, 'null')
	);
	perform pg_temp.ssoc_assert(
		(v_claim_ops ->> 'workerId')::uuid = v_worker_ops.id
			and v_claim_ops ->> 'workspaceKind' = 'surface_ops'
			and (v_claim_ops -> 'repository') = 'null'::jsonb
			and v_claim_ops #>> '{surfaceSession,sessionId}' = v_ops_session::text,
		'Ops claim JSON exposes workspaceKind=surface_ops and null repository: ' || coalesce(v_claim_ops::text, 'null')
	);

	update public.qorpera_coding_sessions
	set attached_machine_id = v_machine_id, attachment_token = extensions.gen_random_uuid(),
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = v_worker_studio.sequence, attached_at = clock_timestamp()
	where worker_id = v_worker_studio.id
	returning * into strict v_cs_studio;

	v_refusal := public.qorpera_coding_attachment_refusal(v_cs_studio, v_worker_studio, v_machine);
	perform pg_temp.ssoc_assert(v_refusal is null, 'active surface_folder attachment has no refusal: ' || coalesce(v_refusal, 'null'));

	update public.qorpera_surfaces set status = 'archived' where id = v_studio_surface;
	v_refusal := public.qorpera_coding_attachment_refusal(v_cs_studio, v_worker_studio, v_machine);
	perform pg_temp.ssoc_assert(
		v_refusal = 'REPOSITORY_WITHDRAWN',
		'archived surface triggers REPOSITORY_WITHDRAWN refusal: ' || coalesce(v_refusal, 'null')
	);
	update public.qorpera_surfaces set status = 'active' where id = v_studio_surface;

	insert into public.qorpera_folder_views(
		id, environment_id, profile_id, kind, staff_agent_id, member_user_id,
		worker_id, attachment_token, node_id, machine_id, pass_sha256, lease_until
	)
	values (
		v_view_id, v_env_a, v_company_a, 'coding_session', v_worker_studio.staff_agent_id, v_owner,
		v_worker_studio.id, v_cs_studio.attachment_token, 'node-1392', v_machine_id,
		extensions.digest(repeat('A', 43), 'sha256'),
		clock_timestamp() + interval '10 minutes'
	);
	perform pg_temp.as_service();
	set local role service_role;
	v_commit_res := public.qorpera_folder_commit(
		v_env_a,
		jsonb_build_object('kind', 'view', 'viewId', v_view_id, 'pass', repeat('A', 43)),
		'direct-vm-write-denied',
		jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'surfaces/brand-studio/direct-hack')),
		null,
		null
	);
	reset role;
	perform pg_temp.ssoc_assert(
		v_commit_res #>> '{units,0,outcome}' = 'denied' and v_commit_res #>> '{units,0,reason}' = 'denied'
			and (v_commit_res -> 'seq') = 'null'::jsonb,
		'VM FUSE coding_session view writes are denied on surface_folder: ' || coalesce(v_commit_res::text, 'null')
	);

	v_errcode := null;
	perform pg_temp.as_service();
	set local role service_role;
	begin
		perform public.qorpera_machine_data_pass(
			v_env_a,
			jsonb_build_object('kind', 'view', 'viewId', v_view_id, 'pass', repeat('A', 43)),
			null
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.ssoc_assert(
		v_errcode = '42501',
		'non-git surface coding view cannot obtain a company-data machine pass: ' || coalesce(v_errcode, 'none')
	);

	insert into public.qorpera_data_passes(
		pass_sha256, kind, environment_id, view_id, machine_id, staff_agent_id,
		requester_user_id, database, files, expires_at
	)
	values (
		extensions.digest(repeat('B', 43), 'sha256'), 'machine', v_env_a, v_view_id, v_machine_id,
		v_worker_studio.staff_agent_id, v_owner, null, '[]'::jsonb, clock_timestamp() + interval '60 seconds'
	);
	perform pg_temp.ssoc_assert(
		public.qorpera_data_pass_redeem(repeat('B', 43)) is null,
		'non-git surface coding view data pass cannot be redeemed'
	);

	perform pg_temp.as_service();
	set local role service_role;
	perform public.qorpera_record_coding_progress(
		v_worker_studio.id, (v_claim_studio ->> 'leaseToken')::uuid, 'preparing', 'Workspace ready', null, '[]'::jsonb,
		null, null, null, null, null
	);
	v_begin_studio := public.qorpera_begin_coding_turn(
		v_worker_studio.id, (v_claim_studio ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId', v_machine_id, 'turnId', extensions.gen_random_uuid())
	);
	reset role;

	select * into strict v_wake_studio from public.qorpera_wake_occurrences where id = (v_begin_studio ->> 'occurrenceId')::uuid;
	perform pg_temp.ssoc_assert(
		v_wake_studio.payload #>> '{coding,workspaceKind}' = 'surface_folder'
			and (v_wake_studio.payload #> '{coding,repository}') = 'null'::jsonb,
		'Studio coding wake carries workspaceKind=surface_folder and null repository: ' || v_wake_studio.payload::text
	);

	perform pg_temp.ssoc_materialize(v_company_a, 16);
	select * into strict v_wake_studio from public.qorpera_wake_occurrences where id = v_wake_studio.id;
	v_binding_studio := pg_temp.ssoc_start_run(v_orch, v_wake_studio.run_id);

	perform pg_temp.as_service();
	set local role service_role;
	perform public.qorpera_record_coding_progress(
		v_worker_ops.id, (v_claim_ops ->> 'leaseToken')::uuid, 'preparing', 'Workspace ready', null, '[]'::jsonb,
		null, null, null, null, null
	);
	v_begin_ops := public.qorpera_begin_coding_turn(
		v_worker_ops.id, (v_claim_ops ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId', v_machine_id, 'turnId', extensions.gen_random_uuid())
	);
	reset role;

	select * into strict v_wake_ops from public.qorpera_wake_occurrences where id = (v_begin_ops ->> 'occurrenceId')::uuid;
	perform pg_temp.ssoc_assert(
		v_wake_ops.payload #>> '{coding,workspaceKind}' = 'surface_ops'
			and (v_wake_ops.payload #> '{coding,repository}') = 'null'::jsonb,
		'Ops coding wake carries workspaceKind=surface_ops and null repository: ' || v_wake_ops.payload::text
	);

	perform pg_temp.ssoc_materialize(v_company_a, 16);
	select * into strict v_wake_ops from public.qorpera_wake_occurrences where id = v_wake_ops.id;
	v_binding_ops := pg_temp.ssoc_start_run(v_orch, v_wake_ops.run_id);

	update public.qorpera_coding_sessions
	set vm_allocation_id = v_machine_id
	where worker_id in (v_worker_studio.id, v_worker_ops.id);

	perform pg_temp.as_service();
	set local role service_role;
	v_auth_studio := public.qorpera_authorize_coding_turn(v_binding_studio);
	v_auth_ops := public.qorpera_authorize_coding_turn(v_binding_ops);
	perform pg_temp.ssoc_assert(
		v_auth_studio #>> '{coding,workspaceKind}' = 'surface_folder' and (v_auth_studio #> '{coding,repository}') = 'null'::jsonb,
		'authorize_coding_turn exposes surface_folder: ' || v_auth_studio::text
	);
	perform pg_temp.ssoc_assert(
		v_auth_ops #>> '{coding,workspaceKind}' = 'surface_ops' and (v_auth_ops #> '{coding,repository}') = 'null'::jsonb,
		'authorize_coding_turn exposes surface_ops: ' || v_auth_ops::text
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_studio, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"stage_surface_patch"},{"name":"narrate_explainer"},{"name":"make_picture"},{"name":"company_read"},{"name":"company_list"},{"name":"company_write"},{"name":"company_edit"},{"name":"company_mkdir"},{"name":"read_skill"},{"name":"search_skills"},{"name":"coding_finish"},{"name":"coding_ask"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.ssoc_assert(
		v_errcode is null or v_errcode not like '42501:Coding catalog must contain only coding tools%',
		'surface_folder admits full Studio MCP catalog: ' || coalesce(v_errcode, 'ok')
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_studio, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_record_change"},{"name":"coding_finish"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ssoc_assert(v_errcode = '42501', 'surface_folder rejects coding_record_change in catalog');

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_ops, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"stage_surface_ops_action"},{"name":"company_read"},{"name":"company_list"},{"name":"coding_finish"},{"name":"coding_ask"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.ssoc_assert(
		v_errcode is null or v_errcode not like '42501:Coding catalog must contain only coding tools%',
		'surface_ops admits Ops MCP catalog: ' || coalesce(v_errcode, 'ok')
	);

	v_errcode := null;
	begin
		perform public.qorpera_begin_native_coding_execution(
			v_binding_ops, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"stage_surface_patch"},{"name":"coding_finish"}]}',
			repeat('d', 64), 100
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ssoc_assert(v_errcode = '42501', 'surface_ops rejects stage_surface_patch in catalog');

	v_errcode := null;
	begin
		perform public.qorpera_record_coding_context_view(
			v_binding_studio,
			jsonb_build_object(
				'schema', 'qorpera.native-context-view/v1',
				'requestId', 'req-cap',
				'threadId', 'thr-cap',
				'turnId', null,
				'purpose', 'model',
				'outputs', jsonb_build_array(jsonb_build_object('callId', 'c1', 'kind', 'function_call_output', 'readId', null, 'capture', jsonb_build_object('sha256', repeat('a', 64))))
			)
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ssoc_assert(v_errcode = '42501', 'surface_folder context view still rejects capture');

	perform public.qorpera_native_surface_record_change(
		v_company_a, v_studio_session, 'Update overview', 'Staged brand overview', 'folder_patch',
		null, null, '{}'::uuid[], array['brief.md'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'brief.md', 'content', '# Brand')),
		false, v_studio_lease
	);
	perform public.qorpera_native_surface_record_change(
		v_company_a, v_ops_session, 'Draft outreach', 'Staged vendor email', 'ops_action',
		null, null, '{}'::uuid[], '{}'::text[], null,
		jsonb_build_object('actionKind', 'draft_email', 'actionPayload', jsonb_build_object('to', 'vendor@example.test')),
		false, v_ops_lease
	);

	v_errcode := null;
	begin
		perform public.qorpera_submit_coding_turn(
			v_binding_studio,
			jsonb_build_object('kind', 'finish', 'operationKey', 'bad-sha', 'summary', 'No sha allowed', 'headSha', repeat('a', 40))
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ssoc_assert(v_errcode = '22023', 'surface_folder submit rejects non-null headSha');

	v_errcode := null;
	begin
		perform public.qorpera_submit_coding_turn(
			v_binding_studio,
			jsonb_build_object('kind', 'finish', 'operationKey', 'bad-note', 'summary', 'Bad note path', 'notePaths', jsonb_build_array('../escape.md'))
		);
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.ssoc_assert(v_errcode = '22023', 'surface_folder submit rejects traversal notePaths');

	v_submit_studio := public.qorpera_submit_coding_turn(
		v_binding_studio,
		jsonb_build_object(
			'kind', 'finish',
			'operationKey', 'studio-fin-1',
			'summary', 'Staged brand overview in Studio.',
			'notePaths', jsonb_build_array('QorperaOS/surfaces/brand-studio/notes/summary.md')
		)
	);
	v_submit_ops := public.qorpera_submit_coding_turn(
		v_binding_ops,
		jsonb_build_object(
			'kind', 'finish',
			'operationKey', 'ops-fin-1',
			'summary', 'Staged vendor outreach email action.'
		)
	);
	perform pg_temp.ssoc_assert(
		v_submit_studio ->> 'state' = 'submitted'
			and (v_submit_studio -> 'headSha') = 'null'::jsonb
			and v_submit_studio -> 'notePaths' = jsonb_build_array('QorperaOS/surfaces/brand-studio/notes/summary.md'),
		'Studio submit stores null headSha and notePaths: ' || v_submit_studio::text
	);
	perform pg_temp.ssoc_assert(
		v_submit_ops ->> 'state' = 'submitted' and (v_submit_ops -> 'headSha') = 'null'::jsonb,
		'Ops submit stores null headSha: ' || v_submit_ops::text
	);

	v_complete_studio := public.qorpera_complete_coding_turn(
		v_worker_studio.id, (v_claim_studio ->> 'leaseToken')::uuid, 'succeeded', 'Staged brand overview in Studio.',
		null, null, null, null, null, null, null
	);
	v_complete_ops := public.qorpera_complete_coding_turn(
		v_worker_ops.id, (v_claim_ops ->> 'leaseToken')::uuid, 'succeeded', 'Staged vendor outreach email action.',
		null, null, null, null, null, null, null
	);
	reset role;

	select * into strict v_surf_row from public.qorpera_surface_sessions where id = v_studio_session;
	perform pg_temp.ssoc_assert(
		v_surf_row.state = 'ready'
			and exists (
				select 1 from public.qorpera_surface_session_messages m
				where m.session_id = v_studio_session and m.author_kind = 'session'
					and m.body = 'Staged brand overview in Studio.'
			)
			and v_surf_row.note_paths = array['QorperaOS/surfaces/brand-studio/notes/summary.md']
			and (select count(*) from public.qorpera_surface_changes where session_id = v_studio_session and kind = 'folder_patch') = 1,
		'Studio completion syncs ready state, reply, note_paths, and preserves folder_patch: ' || to_jsonb(v_surf_row)::text
	);

	select * into strict v_surf_row from public.qorpera_surface_sessions where id = v_ops_session;
	perform pg_temp.ssoc_assert(
		v_surf_row.state = 'ready'
			and exists (
				select 1 from public.qorpera_surface_session_messages m
				where m.session_id = v_ops_session and m.author_kind = 'session'
					and m.body = 'Staged vendor outreach email action.'
			)
			and (select count(*) from public.qorpera_surface_changes where session_id = v_ops_session and kind = 'ops_action') = 1,
		'Ops completion syncs ready state, reply, and preserves ops_action: ' || to_jsonb(v_surf_row)::text
	);

	perform pg_temp.ssoc_as(v_owner);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_studio_session, 'Refine the color palette');
	reset role;
	select * into strict v_surf_row from public.qorpera_surface_sessions where id = v_studio_session;
	perform pg_temp.ssoc_assert(
		v_surf_row.state = 'queued' and v_surf_row.worker_id = v_worker_studio.id,
		'Studio follow-up reply queues onto existing coding worker: ' || to_jsonb(v_surf_row)::text
	);

	v_payer_problem := public.qorpera_surface_automation_payer_problem(v_company_a, v_owner, 'brand-studio');
	perform pg_temp.ssoc_assert(
		v_payer_problem is null,
		'automation payer problem is null while Claude login is active: ' || coalesce(v_payer_problem, 'null')
	);

	update public.qorpera_claude_logins
	set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null, in_use = false
	where id = v_claude_login;

	v_errcode := null;
	perform pg_temp.ssoc_as(v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_reply_surface_session(v_ops_session, 'Must fail on Claude reply');
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.ssoc_assert(
		v_errcode = '42501',
		'Ops follow-up reply rejects when explicit Claude login is revoked without GPT fallback: ' || coalesce(v_errcode, 'null')
	);

	perform pg_temp.ssoc_as(v_owner);
	set local role authenticated;
	v_revoked_session := (public.qorpera_start_surface_session(v_studio_surface, 'Must fail on Claude', 'No GPT fallback') ->> 'id')::uuid;
	reset role;

	perform pg_temp.as_service();
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_revoked_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_revoked_session, v_lease);
	reset role;
	perform pg_temp.ssoc_assert(
		v_enq ->> 'status' = 'unavailable' and v_enq ->> 'reason' = 'no_sponsor',
		'Studio session fails closed without GPT fallback when explicit Claude login is revoked: ' || coalesce(v_enq::text, 'null')
	);

	v_payer_problem := public.qorpera_surface_automation_payer_problem(v_company_a, v_owner, 'brand-studio');
	perform pg_temp.ssoc_assert(
		v_payer_problem = 'no_login',
		'automation payer problem enforces Claude login without GPT fallback for Studio surface: ' || coalesce(v_payer_problem, 'null')
	);

	foreach v_fn in array array[
		'public.qorpera_surface_studio_ops_coding_ready()',
		'public.qorpera_coding_session_machine_repository(public.qorpera_coding_sessions)',
		'public.qorpera_coding_attachment_refusal(public.qorpera_coding_sessions,public.qorpera_runtime_workers,public.qorpera_coding_machines)',
		'public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions,public.qorpera_runtime_workers)',
		'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb,text[])'
	] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			perform pg_temp.ssoc_assert(
				not has_function_privilege(v_role, v_fn, 'execute'),
				v_role || ' must not execute ' || v_fn
			);
		end loop;
	end loop;
end $$;
