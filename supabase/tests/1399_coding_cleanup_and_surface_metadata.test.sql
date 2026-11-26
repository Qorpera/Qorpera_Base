-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ccsm_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'coding_cleanup_and_surface_metadata: %', p_message;
	end if;
end $$;

create function pg_temp.ccsm_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_machine_id constant uuid := '13990000-0000-4000-8000-0000000000d1';
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid := (v_claim ->> 'environmentId')::uuid;
	v_cofounder uuid := (v_claim ->> 'cofounderId')::uuid;
	v_surface uuid;
	v_session uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
	v_worker uuid;
	v_tok uuid := extensions.gen_random_uuid();
	v_view jsonb;
	v_renew jsonb;
	v_service uuid := extensions.gen_random_uuid();
	v_req_id uuid;
	v_req_claim jsonb;
	v_req_token uuid;
	v_step jsonb;
	v_begin jsonb;
	v_version_id uuid;
	v_finish jsonb;
	v_site_id uuid;
	v_merge_job uuid;
	v_merge_lease uuid;
	v_sha_init constant text := repeat('1', 40);
	v_sha_landed constant text := repeat('2', 40);
	v_sha_undone constant text := repeat('3', 40);
	v_tree constant text := repeat('4', 40);
	v_file_sha constant text := encode(extensions.digest(convert_to('<h1>Hello</h1>', 'utf8'), 'sha256'), 'hex');
	v_manifest_sha constant text := encode(
		extensions.digest(convert_to('index.html' || chr(9) || v_file_sha || chr(9) || '14', 'utf8'), 'sha256'),
		'hex'
	);
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	insert into public.qorpera_coding_executors(environment_id, owner, enabled, nas_machine_id_sha256)
	values (v_env, 'exec-1399', true, repeat('9', 64))
	on conflict (environment_id, owner) do update set enabled = true, nas_machine_id_sha256 = repeat('9', 64);

	insert into public.qorpera_coding_machines(
		id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding
	)
	values (
		v_machine_id, 'member', v_profile, v_env, v_anna, 'exec-1399',
		encode(extensions.digest(v_machine_id::text, 'sha256'), 'hex'), '{}'::jsonb
	);

	insert into public.qorpera_runtime_machine_allocations(
		id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at
	)
	values (
		v_machine_id, v_profile, 'lxd', encode(extensions.digest('alloc-' || v_machine_id::text, 'sha256'), 'hex'),
		v_machine_id, clock_timestamp()
	);

	perform pg_temp.ccsm_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_profile, 'Marketing Site', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false) ->> 'id')::uuid;
	reset role;

	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, main_sha)
	values (v_env, v_profile, 'surfaces', 'website', v_sha_init)
	on conflict (environment_id, owner, name) do update set main_sha = excluded.main_sha;

	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values (v_env, v_cofounder, jsonb_build_object('host', 'qorpera', 'owner', 'surfaces', 'name', 'website', 'baseBranch', 'main'), true)
	on conflict do nothing;

	perform pg_temp.ccsm_as(v_anna);
	set local role authenticated;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Refresh hero', 'Hero') ->> 'id')::uuid;
	reset role;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session;
	v_enq := public.qorpera_surface_enqueue_session_run(v_session, v_lease);
	v_worker := (v_enq ->> 'workerId')::uuid;
	reset role;

	update public.qorpera_coding_sessions
	set
		vm_allocation_id = v_machine_id,
		attached_machine_id = v_machine_id,
		attachment_token = v_tok,
		attachment_until = clock_timestamp() + interval '60 seconds',
		attachment_turn = 1,
		attached_at = clock_timestamp()
	where worker_id = v_worker;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_view := public.qorpera_folder_view_open(
		v_env,
		jsonb_build_object('kind', 'platform'),
		'coding_session',
		jsonb_build_object('workerId', v_worker, 'attachmentToken', v_tok)
	);
	v_renew := public.qorpera_folder_view_renew((v_view ->> 'viewId')::uuid, v_view ->> 'pass', null, v_service);
	perform pg_temp.ccsm_assert(
		v_renew ->> 'state' = 'open' and v_renew ->> 'workerId' = v_worker::text,
		'coding_session view renewal returns workerId: ' || v_renew::text
	);

	v_view := public.qorpera_folder_view_open(v_env, jsonb_build_object('kind', 'platform'), 'code_host', '{}'::jsonb);
	v_renew := public.qorpera_folder_view_renew((v_view ->> 'viewId')::uuid, v_view ->> 'pass', null, v_service);
	perform pg_temp.ccsm_assert(
		v_renew ->> 'state' = 'open' and not (v_renew ? 'workerId'),
		'code_host view renewal omits workerId: ' || v_renew::text
	);
	reset role;

	perform pg_temp.ccsm_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_session(v_session);
	reset role;

	update public.qorpera_coding_sessions
	set
		attached_machine_id = null,
		attachment_token = null,
		attachment_until = null,
		attachment_turn = null,
		attached_at = null,
		lease_owner = null,
		lease_token = null,
		lease_until = null
	where worker_id = v_worker;
	update public.qorpera_coding_session_turns
	set outcome = coalesce(outcome, '{"state":"cancelled"}'::jsonb), settled_at = coalesce(settled_at, clock_timestamp())
	where worker_id = v_worker and outcome is null;

	perform pg_temp.ccsm_assert(
		(select vm_allocation_id from public.qorpera_coding_sessions where worker_id = v_worker) = v_machine_id,
		'historical vm_allocation_id remains populated after detach'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	perform pg_temp.ccsm_assert(
		jsonb_array_length(v_claimed -> 'cleanups') = 1
			and (v_claimed -> 'cleanups' -> 0 ->> 'workerId')::uuid = v_worker,
		'cleanup_session is claimed even when historical vm_allocation_id is non-null: ' || v_claimed::text
	);
	reset role;

	update public.qorpera_surface_jobs
	set status = 'queued', lease_token = null, lease_expires_at = null
	where session_id = v_session and kind = 'cleanup_session';
	update public.qorpera_coding_sessions
	set lease_owner = 'exec-1399', lease_token = extensions.gen_random_uuid(), lease_until = clock_timestamp() + interval '60 seconds'
	where worker_id = v_worker;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	perform pg_temp.ccsm_assert(
		jsonb_array_length(v_claimed -> 'cleanups') = 0,
		'active coding lease still prevents premature cleanup_session claim: ' || v_claimed::text
	);
	reset role;

	update public.qorpera_coding_sessions
	set lease_owner = null, lease_token = null, lease_until = null
	where worker_id = v_worker;

	insert into public.qorpera_code_requests(
		environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id
	)
	values (
		v_env, 'surfaces', 'website', v_profile, 'lifecycle',
		jsonb_build_object('op', 'prune', 'deleteMergedBranches', true),
		'member', v_anna
	)
	returning id into v_req_id;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_req_claim := public.qorpera_code_requests_claim('exec-1399', repeat('9', 64), 10, array['lifecycle']);
	select (elem ->> 'token')::uuid into strict v_req_token
	from jsonb_array_elements(v_req_claim -> 'requests') elem
	where (elem ->> 'requestId')::uuid = v_req_id;
	v_step := public.qorpera_code_request_step('exec-1399', repeat('9', 64), v_req_id, v_req_token, '{"step":"files"}'::jsonb);
	perform pg_temp.ccsm_assert(
		v_step ->> 'state' = 'go' and (v_step -> 'candidates') ? v_worker::text,
		'lifecycle prune includes archived worker with historical vm_allocation_id: ' || v_step::text
	);

	v_begin := public.qorpera_surface_site_version_begin(
		v_surface, v_tree, v_sha_init, v_manifest_sha, 1, 14, 'Preview 7b5f9cb4'
	);
	v_version_id := (v_begin ->> 'versionId')::uuid;
	v_site_id := (v_begin ->> 'siteId')::uuid;
	perform public.qorpera_surface_site_version_list(
		v_version_id,
		jsonb_build_object('last', true, 'files', jsonb_build_array(jsonb_build_object('path', 'index.html', 'bytes', 14, 'sha256', v_file_sha)))
	);
	perform public.qorpera_surface_site_version_put(
		v_version_id,
		jsonb_build_object('parts', jsonb_build_array(jsonb_build_object('path', 'index.html', 'part', 0, 'of', 1, 'contentBase64', encode(convert_to('<h1>Hello</h1>', 'utf8'), 'base64'))))
	);
	v_finish := public.qorpera_surface_site_version_finish(v_version_id, true);
	reset role;
	perform pg_temp.ccsm_assert(
		v_finish ->> 'state' = 'live'
			and (select title from public.qorpera_company_sites where id = v_site_id) = 'Marketing Site'
			and (select title from public.qorpera_company_site_versions where id = v_version_id) = 'Marketing Site',
		'promoting preview version preserves surface title instead of Preview <hex>: '
			|| coalesce((select title from public.qorpera_company_sites where id = v_site_id), '<null>')
	);

	v_merge_lease := extensions.gen_random_uuid();
	insert into public.qorpera_surface_jobs(profile_id, surface_id, kind, status, payload, lease_token, lease_expires_at)
	values (v_profile, v_surface, 'land_change', 'running', '{"changeIds":[]}'::jsonb, v_merge_lease, clock_timestamp() + interval '60 seconds')
	returning id into v_merge_job;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_merge_job, 'landed', v_sha_init, v_sha_landed, null, null, null, null, v_merge_lease
	);
	reset role;
	perform pg_temp.ccsm_assert(
		(select last_main = v_sha_landed and main_sha = v_sha_landed
			from public.qorpera_code_repositories
			where environment_id = v_env and owner = 'surfaces' and name = 'website'),
		'land_change updates qorpera_code_repositories last_main and main_sha'
	);

	v_merge_lease := extensions.gen_random_uuid();
	insert into public.qorpera_surface_jobs(profile_id, surface_id, kind, status, payload, lease_token, lease_expires_at)
	values (v_profile, v_surface, 'undo_change', 'running', '{"changeIds":[]}'::jsonb, v_merge_lease, clock_timestamp() + interval '60 seconds')
	returning id into v_merge_job;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_merge(
		v_merge_job, 'landed', v_sha_landed, v_sha_undone, null, null, null, null, v_merge_lease
	);
	reset role;
	perform pg_temp.ccsm_assert(
		(select last_main = v_sha_undone and main_sha = v_sha_undone
			from public.qorpera_code_repositories
			where environment_id = v_env and owner = 'surfaces' and name = 'website'),
		'undo_change updates qorpera_code_repositories last_main and main_sha'
	);
end $$;
