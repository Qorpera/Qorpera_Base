-- @fixture 1210_code_change_record.test.sql until "-- The checks start here"

update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-1170';
update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

do $$
declare
	v_profile constant uuid := '92400000-0000-4000-8000-000000000010';
	v_env constant uuid := '92400000-0000-4000-8000-000000000020';
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_alice constant uuid := '92400000-0000-4000-8000-000000000030';
	v_viewer constant uuid := '93800000-0000-4000-8000-000000000003';
	v_outsider constant uuid := '93800000-0000-4000-8000-000000000004';
	v_broker constant uuid := '93800000-0000-4000-8000-000000000040';
	v_secret constant uuid := '93800000-0000-4000-8000-000000000050';
	v_hook constant uuid := '93800000-0000-4000-8000-000000000060';
	v_non_gh_hook constant uuid := '93800000-0000-4000-8000-000000000061';
	v_envelope constant bytea := decode(repeat('ab', 64), 'hex');
	v_surface_id uuid;
	v_session_a uuid;
	v_session_b uuid;
	v_delivery_id uuid;
	v_delivery_row public.qorpera_event_deliveries%rowtype;
	v_linked jsonb;
	v_res jsonb;
	v_claim jsonb;
	v_req_id uuid;
	v_token uuid;
	v_auth jsonb;
	v_fin jsonb;
	v_errcode text;
	v_sha_1 constant text := repeat('1', 40);
	v_sha_2 constant text := repeat('2', 40);
	v_sha_3 constant text := repeat('3', 40);
	v_sha_4 constant text := repeat('4', 40);
	v_msg_count integer;
begin
	perform pg_temp.base_assert(
		(select count(*) = 6
		 from public.qorpera_cloud_connector_operations
		 where connector_id = 'github'
			and operation_id in (
				'list_pull_requests', 'create_pull_request', 'update_pull_request',
				'list_pull_request_reviews', 'list_check_runs', 'list_branches'
			)
			and status = 'active'
			and version = 1),
		'All six new GitHub connector operations must be active in catalog'
	);

	perform pg_temp.base_assert(
		exists (
			select 1 from public.qorpera_native_host_calls
			where name = 'qorpera_folder_code_github_sync' and scope = 'binding'
		),
		'qorpera_folder_code_github_sync must be registered in qorpera_native_host_calls'
	);

	perform pg_temp.base_assert(
		position(
			'where authority.id = p_broker_authority_id) for key share;'
			in pg_get_functiondef('public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)'::regprocedure)
		) > 0,
		'qorpera_authorize_coding_repository_credential must preserve lock-order anchor'
	);

	perform pg_temp.base_assert(
		(select relrowsecurity from pg_class where oid = 'public.qorpera_surface_github_webhook_receipts'::regclass)
		and not has_table_privilege('anon', 'public.qorpera_surface_github_webhook_receipts', 'SELECT')
		and not has_table_privilege('authenticated', 'public.qorpera_surface_github_webhook_receipts', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_github_webhook_receipts', 'SELECT'),
		'qorpera_surface_github_webhook_receipts must have RLS enabled and revoke direct table access'
	);

	perform pg_temp.base_assert(
		has_function_privilege('authenticated', 'public.qorpera_link_surface_track_pr(uuid,jsonb,text)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_link_surface_track_pr(uuid,jsonb,text)', 'EXECUTE')
		and has_function_privilege('service_role', 'public.qorpera_folder_code_github_sync(jsonb,jsonb)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_folder_code_github_sync(jsonb,jsonb)', 'EXECUTE')
		and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_authorize_github_sync_credential(uuid,text,uuid,uuid,text,jsonb)', 'EXECUTE'),
		'Function execute privileges must match security boundary'
	);

	insert into auth.users(id, email) values
		(v_viewer, 'viewer-938@example.test'),
		(v_outsider, 'outsider-938@example.test')
	on conflict (id) do nothing;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		(v_profile, v_viewer, 'viewer-938@example.test', 'Viewer 938', 'viewer')
	on conflict (profile_id, user_id) do update set role = excluded.role;

	perform pg_temp.base_claims('authenticated', v_owner);
	set local role authenticated;
	v_surface_id := (public.qorpera_create_surface(
		v_profile, 'Shop App', 'shop-app', 'live_build', 'web_app', 'monitor', null, null, null, false
	) ->> 'id')::uuid;
	v_session_a := (public.qorpera_start_surface_session(v_surface_id, 'Redesign billing', 'Billing track') ->> 'id')::uuid;
	v_session_b := (public.qorpera_start_surface_session(v_surface_id, 'Add search filters', 'Search track') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces
	set source_kind = 'code_repo', repository_key = 'acme/shop'
	where id = v_surface_id;
	update public.qorpera_surface_sessions
	set track_branch = 'feat/billing', branch_head_sha = v_sha_1
	where id = v_session_a;
	update public.qorpera_surface_sessions
	set track_branch = 'feat/search', branch_head_sha = v_sha_2
	where id = v_session_b;

	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	begin
		perform public.qorpera_link_surface_track_pr(
			v_session_a,
			jsonb_build_object('provider', 'github', 'repository', 'acme/shop', 'number', 10, 'url', 'https://github.com/acme/shop/pull/10', 'state', 'open'),
			null
		);
		perform pg_temp.base_assert(false, 'Viewer must not link track PR');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.base_assert(v_errcode = '42501', 'Expected 42501 for viewer link PR, got ' || v_errcode);
	end;
	reset role;

	perform pg_temp.base_claims('authenticated', v_owner);
	set local role authenticated;
	begin
		perform public.qorpera_link_surface_track_pr(
			v_session_a,
			jsonb_build_object('provider', 'github', 'repository', 'not a repo', 'number', 10, 'url', 'http://insecure', 'state', 'open'),
			null
		);
		perform pg_temp.base_assert(false, 'Malformed externalPr must raise 22023');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.base_assert(v_errcode = '22023', 'Expected 22023 for invalid externalPr, got ' || v_errcode);
	end;

	v_linked := public.qorpera_link_surface_track_pr(
		v_session_b,
		jsonb_build_object(
			'provider', 'github',
			'repository', 'acme/shop',
			'number', 77,
			'url', 'https://github.com/acme/shop/pull/77',
			'state', 'open',
			'headBranch', 'feat/search-v2',
			'baseBranch', 'main',
			'title', 'Search v2',
			'headSha', v_sha_2,
			'draft', true,
			'checksStatus', 'pending'
		),
		null
	);
	perform pg_temp.base_assert(
		(v_linked #>> '{externalPr,number}')::integer = 77
		and v_linked ->> 'trackBranch' = 'feat/search-v2'
		and v_linked #>> '{externalPr,checksStatus}' = 'pending',
		'qorpera_link_surface_track_pr must persist externalPr and headBranch: ' || v_linked::text
	);

	v_linked := public.qorpera_link_surface_track_pr(v_session_b, null, null);
	perform pg_temp.base_assert(
		(v_linked -> 'externalPr') = 'null'::jsonb,
		'Unlinking PR must clear externalPr: ' || v_linked::text
	);
	reset role;

	insert into public.qorpera_event_hooks(id, profile_id, environment_id, name, purpose, proof, address, status, created_by_user_id)
	values
		(v_hook, v_profile, v_env, 'gh-shop', 'GitHub PR sync', 'github', repeat('a', 43), 'active', v_owner),
		(v_non_gh_hook, v_profile, v_env, 'plain-hook', 'Other events', 'address', repeat('b', 43), 'active', v_owner);

	v_delivery_id := extensions.gen_random_uuid();
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, status, event_type, content_type, body, body_bytes, body_sha256)
	values (
		v_delivery_id, v_hook, v_profile, 'received', 'pull_request.opened', 'application/json',
		convert_to(jsonb_build_object(
			'action', 'opened',
			'repository', jsonb_build_object('full_name', 'Acme/Shop'),
			'pull_request', jsonb_build_object(
				'number', 42,
				'state', 'open',
				'draft', false,
				'title', 'Billing redesign',
				'html_url', 'https://github.com/Acme/Shop/pull/42',
				'updated_at', '2026-11-27T12:00:00Z',
				'head', jsonb_build_object('ref', 'feat/billing', 'sha', v_sha_1),
				'base', jsonb_build_object('ref', 'main')
			)
		)::text, 'utf8'),
		100, repeat('a', 64)
	);
	perform pg_temp.base_assert(
		(select external_pr is null from public.qorpera_surface_sessions where id = v_session_a),
		'Unverified webhook delivery must not touch track'
	);

	update public.qorpera_event_deliveries
	set status = 'verified', verified_at = clock_timestamp(), delivery_key = 'gh-del-opened-1'
	where id = v_delivery_id;

	perform pg_temp.base_assert(
		(select (external_pr ->> 'number')::integer = 42
			and external_pr ->> 'repository' = 'acme/shop'
			and external_pr ->> 'state' = 'open'
			and external_pr ->> 'headSha' = v_sha_1
		 from public.qorpera_surface_sessions where id = v_session_a),
		'Verified pull_request.opened delivery must link PR onto matching track branch'
	);
	perform pg_temp.base_assert(
		(select matched_sessions = 1 from public.qorpera_surface_github_webhook_receipts where delivery_id = v_delivery_id),
		'Webhook receipt must record matched_sessions = 1'
	);

	select * into strict v_delivery_row from public.qorpera_event_deliveries where id = v_delivery_id;
	select count(*) into v_msg_count from public.qorpera_surface_session_messages where session_id = v_session_a;
	perform pg_temp.base_assert(
		public.qorpera_surface_apply_github_webhook_delivery(v_delivery_row) = 'duplicate'
		and (select count(*) from public.qorpera_surface_session_messages where session_id = v_session_a) = v_msg_count,
		'Re-applying a processed GitHub delivery must return duplicate without duplicate messages'
	);

	v_delivery_id := extensions.gen_random_uuid();
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, status, event_type, content_type, body, body_bytes, body_sha256)
	values (
		v_delivery_id, v_hook, v_profile, 'received', 'pull_request_review.submitted', 'application/json',
		convert_to(jsonb_build_object(
			'repository', jsonb_build_object('full_name', 'acme/shop'),
			'pull_request', jsonb_build_object('number', 42),
			'review', jsonb_build_object('state', 'approved', 'user', jsonb_build_object('login', 'jonas'), 'body', 'Ship it')
		)::text, 'utf8'),
		100, repeat('b', 64)
	);
	update public.qorpera_event_deliveries
	set status = 'verified', verified_at = clock_timestamp(), delivery_key = 'gh-del-review-1'
	where id = v_delivery_id;
	perform pg_temp.base_assert(
		exists (
			select 1 from public.qorpera_surface_session_messages
			where session_id = v_session_a and body like '%review by jonas (approved): Ship it%'
		),
		'Verified pull_request_review.submitted must append review message'
	);

	v_delivery_id := extensions.gen_random_uuid();
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, status, event_type, content_type, body, body_bytes, body_sha256)
	values (
		v_delivery_id, v_hook, v_profile, 'received', 'check_run.completed', 'application/json',
		convert_to(jsonb_build_object(
			'repository', jsonb_build_object('full_name', 'acme/shop'),
			'check_run', jsonb_build_object(
				'name', 'ci / build',
				'conclusion', 'success',
				'head_sha', v_sha_1,
				'pull_requests', jsonb_build_array(jsonb_build_object('number', 42))
			)
		)::text, 'utf8'),
		100, repeat('c', 64)
	);
	update public.qorpera_event_deliveries
	set status = 'verified', verified_at = clock_timestamp(), delivery_key = 'gh-del-check-1'
	where id = v_delivery_id;
	perform pg_temp.base_assert(
		(select checks_summary ->> 'status' = 'passed' and external_pr ->> 'checksStatus' = 'passed'
		 from public.qorpera_surface_sessions where id = v_session_a),
		'Verified check_run.completed success must update checks_summary and external_pr.checksStatus'
	);

	v_delivery_id := extensions.gen_random_uuid();
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, status, event_type, content_type, body, body_bytes, body_sha256)
	values (
		v_delivery_id, v_hook, v_profile, 'received', 'push', 'application/json',
		convert_to(jsonb_build_object(
			'repository', jsonb_build_object('full_name', 'acme/shop'),
			'ref', 'refs/heads/feat/billing',
			'after', v_sha_3,
			'head_commit', jsonb_build_object('message', 'Fix billing tax rounding')
		)::text, 'utf8'),
		100, repeat('d', 64)
	);
	update public.qorpera_event_deliveries
	set status = 'verified', verified_at = clock_timestamp(), delivery_key = 'gh-del-push-1'
	where id = v_delivery_id;
	perform pg_temp.base_assert(
		(select external_pr ->> 'headSha' = v_sha_3 from public.qorpera_surface_sessions where id = v_session_a),
		'Verified push webhook must update external_pr.headSha'
	);

	v_delivery_id := extensions.gen_random_uuid();
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, status, event_type, content_type, body, body_bytes, body_sha256)
	values (
		v_delivery_id, v_hook, v_profile, 'received', 'pull_request.closed', 'application/json',
		convert_to(jsonb_build_object(
			'action', 'closed',
			'repository', jsonb_build_object('full_name', 'acme/shop'),
			'pull_request', jsonb_build_object(
				'number', 42,
				'state', 'closed',
				'merged', true,
				'title', 'Billing redesign',
				'html_url', 'https://github.com/acme/shop/pull/42',
				'head', jsonb_build_object('ref', 'feat/billing', 'sha', v_sha_3),
				'base', jsonb_build_object('ref', 'main')
			)
		)::text, 'utf8'),
		100, repeat('e', 64)
	);
	update public.qorpera_event_deliveries
	set status = 'verified', verified_at = clock_timestamp(), delivery_key = 'gh-del-merged-1'
	where id = v_delivery_id;
	perform pg_temp.base_assert(
		(select external_pr ->> 'state' = 'merged' from public.qorpera_surface_sessions where id = v_session_a),
		'Verified pull_request.closed with merged=true must set external_pr.state to merged'
	);

	v_delivery_id := extensions.gen_random_uuid();
	insert into public.qorpera_event_deliveries(id, hook_id, profile_id, status, event_type, content_type, body, body_bytes, body_sha256)
	values (
		v_delivery_id, v_non_gh_hook, v_profile, 'received', 'push', 'application/json',
		convert_to(jsonb_build_object('repository', jsonb_build_object('full_name', 'acme/shop'), 'ref', 'refs/heads/feat/billing', 'after', v_sha_4)::text, 'utf8'),
		100, repeat('f', 64)
	);
	update public.qorpera_event_deliveries
	set status = 'verified', verified_at = clock_timestamp(), delivery_key = 'non-gh-del-1'
	where id = v_delivery_id;
	perform pg_temp.base_assert(
		(select external_pr ->> 'headSha' = v_sha_3 from public.qorpera_surface_sessions where id = v_session_a),
		'Non-github hook delivery must be ignored'
	);

	perform pg_temp.base_claims('service_role');
	v_res := public.qorpera_folder_code_github_sync(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'gh-no-conn',
			'op', 'sync',
			'owner', 'company',
			'name', 'shop',
			'github', 'acme/shop',
			'remoteBranch', 'main'
		)
	);
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'refused' and v_res ->> 'reason' = 'no_github_connection',
		'Without company GitHub connection, github_sync must refuse with no_github_connection: ' || v_res::text
	);

	insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
	values (v_broker, v_profile, 'https://secrets.qorpera.test', 'company-kek-1', repeat('c', 64));
	insert into public.qorpera_cloud_secrets(
		id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, current_version, created_by_user_id, available_to_all_agents
	)
	values (
		v_secret, v_profile, v_env, v_broker, 'company', null,
		'github', 'primary', 'Company GitHub', 1, v_owner, true
	);
	insert into public.qorpera_cloud_secret_versions(
		secret_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, created_by_user_id
	)
	values (
		v_secret, 1, v_broker, 'company-kek-1', v_envelope, encode(extensions.digest(v_envelope, 'sha256'), 'hex'), v_owner
	);
	insert into public.qorpera_cloud_secret_operation_grants(
		profile_id, environment_id, secret_id, staff_agent_id,
		connector_id, operation_id, operation_version, tool_name, issued_by_user_id
	)
	values
		(v_profile, v_env, v_secret, v_alice, 'github', 'get_pull_request', 1, 'github_get_pull_request', v_owner),
		(v_profile, v_env, v_secret, v_alice, 'github', 'create_issue', 1, 'github_create_issue', v_owner);

	perform pg_temp.base_assert(
		public.qorpera_backfill_connector_operation_grants('github', 'get_pull_request', 'list_pull_requests', 1) = 1
		and public.qorpera_backfill_connector_operation_grants('github', 'create_issue', 'create_pull_request', 1) = 1,
		'Grant backfill must propagate new GitHub PR operations to granted agents'
	);

	v_res := public.qorpera_folder_code_github_sync(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'gh-pull-1',
			'op', 'pull',
			'owner', 'company',
			'name', 'shop',
			'github', 'Acme/Shop',
			'remoteBranch', 'main'
		)
	);
	perform pg_temp.base_assert(v_res ->> 'state' = 'queued', 'Pull request must queue: ' || v_res::text);
	v_req_id := (v_res ->> 'requestId')::uuid;

	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 5, array['github_sync']);
	reset role;
	perform pg_temp.base_assert(
		jsonb_array_length(v_claim -> 'requests') = 1
		and v_claim -> 'requests' -> 0 ->> 'requestId' = v_req_id::text
		and v_claim -> 'requests' -> 0 ->> 'kind' = 'github_sync'
		and v_claim -> 'requests' -> 0 ->> 'op' = 'pull'
		and v_claim -> 'requests' -> 0 #>> '{githubSync,githubRepo}' = 'Acme/Shop',
		'Claim must return github_sync request payload: ' || v_claim::text
	);
	v_token := (v_claim -> 'requests' -> 0 ->> 'token')::uuid;

	set local session authorization qorpera_secret_broker;
	v_auth := public.qorpera_authorize_coding_repository_credential(
		v_broker, repeat('c', 64), v_req_id, v_token, 'exec-1170',
		jsonb_build_object('host', 'github.com', 'owner', 'acme', 'name', 'shop', 'baseBranch', 'main')
	);
	perform pg_temp.base_assert(
		v_auth ->> 'schema' = 'qorpera.coding-repository-credential-authorization/v1'
		and (v_auth ->> 'workerId')::uuid = v_req_id
		and v_auth ->> 'connectorId' = 'github',
		'Broker credential authorization must succeed for active github_sync lease: ' || v_auth::text
	);

	begin
		perform public.qorpera_authorize_coding_repository_credential(
			v_broker, repeat('c', 64), v_req_id, v_token, 'exec-1170',
			jsonb_build_object('host', 'github.com', 'owner', 'other', 'name', 'repo', 'baseBranch', 'main')
		);
		perform pg_temp.base_assert(false, 'Mismatched GitHub repo must raise 42501');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.base_assert(v_errcode = '42501', 'Expected 42501 for mismatched repo, got ' || v_errcode);
	end;
	reset session authorization;

	perform pg_temp.base_assert(
		exists (
			select 1 from public.qorpera_cloud_secret_audit_events
			where event_type = 'repository_credential_used' and coding_worker_id = v_req_id and secret_id = v_secret
		),
		'Broker github_sync credential authorization must write an audit event'
	);

	set local role service_role;
	v_fin := public.qorpera_code_request_finish(
		'exec-1170', repeat('5', 64), v_req_id, v_token,
		jsonb_build_object(
			'schema', 'qorpera.code-request-outcome/v1',
			'state', 'done',
			'result', 'pulled',
			'githubRepo', 'Acme/Shop',
			'remoteBranch', 'main',
			'mainBefore', v_sha_1,
			'mainAfter', v_sha_4,
			'remoteSha', v_sha_4,
			'mode', 'fast-forward',
			'commitsPulled', 3
		)
	);
	reset role;
	perform pg_temp.base_assert(v_fin ->> 'state' = 'recorded', 'Pull finish must record: ' || v_fin::text);
	perform pg_temp.base_assert(
		(select last_main = v_sha_4 and main_sha = v_sha_4
		 from public.qorpera_code_repositories
		 where environment_id = v_env and owner = 'company' and name = 'shop'),
		'Pulled finish must advance repository last_main and main_sha'
	);

	v_res := public.qorpera_folder_code_github_sync(
		pg_temp.c3_alice(),
		jsonb_build_object(
			'operationKey', 'gh-pr-1',
			'op', 'create_pr',
			'owner', 'company',
			'name', 'shop',
			'github', 'acme/shop',
			'head', 'feat/search-v3',
			'base', 'main',
			'title', 'Search filters v3',
			'body', 'Adds facet filters',
			'draft', false,
			'sessionId', v_session_b
		)
	);
	perform pg_temp.base_assert(v_res ->> 'state' = 'queued', 'create_pr must queue: ' || v_res::text);
	v_req_id := (v_res ->> 'requestId')::uuid;

	set local role service_role;
	v_claim := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), 5, array['github_sync']);
	v_token := (v_claim -> 'requests' -> 0 ->> 'token')::uuid;
	v_fin := public.qorpera_code_request_finish(
		'exec-1170', repeat('5', 64), v_req_id, v_token,
		jsonb_build_object(
			'schema', 'qorpera.code-request-outcome/v1',
			'state', 'done',
			'result', 'pr_created',
			'githubRepo', 'acme/shop',
			'number', 88,
			'url', 'https://github.com/acme/shop/pull/88',
			'prState', 'open',
			'headBranch', 'feat/search-v3',
			'baseBranch', 'main',
			'title', 'Search filters v3',
			'headSha', v_sha_4,
			'draft', false,
			'updatedAt', '2026-11-27T13:00:00Z',
			'sessionId', v_session_b
		)
	);
	reset role;
	perform pg_temp.base_assert(v_fin ->> 'state' = 'recorded', 'pr_created finish must record: ' || v_fin::text);
	perform pg_temp.base_assert(
		(select (external_pr ->> 'number')::integer = 88
			and external_pr ->> 'state' = 'open'
			and track_branch = 'feat/search-v3'
		 from public.qorpera_surface_sessions where id = v_session_b),
		'pr_created finish with sessionId must automatically link external_pr onto target surface track'
	);
end $$;
