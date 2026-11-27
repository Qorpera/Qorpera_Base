-- @fixture 1274_company_numbers_orders.test.sql until "-- The checks start here."

do $$
declare
	v_profile uuid := '92400000-0000-4000-8000-000000000010';
	v_env uuid := '92400000-0000-4000-8000-000000000020';
	v_owner uuid := '92400000-0000-4000-8000-000000000001';
	v_member uuid := '92400000-0000-4000-8000-000000000002';
	v_outsider uuid := '12740000-0000-4000-8000-000000000006';
	v_agent uuid := '92400000-0000-4000-8000-000000000030';
	v_created jsonb;
	v_token text;
	v_token_id uuid;
	v_token_sha text;
	v_listed jsonb;
	v_verified jsonb;
	v_push jsonb;
	v_revoked jsonb;
	v_err text;
	v_surface_id uuid := '14220000-0000-4000-8000-000000000001';
	v_session_id uuid := '14220000-0000-4000-8000-000000000002';
	v_change_noop uuid := '14220000-0000-4000-8000-000000000003';
	v_change_block uuid := '14220000-0000-4000-8000-000000000004';
	v_change_bad uuid := '14220000-0000-4000-8000-000000000005';
	v_change_discarded uuid := '14220000-0000-4000-8000-000000000021';
	v_change_git uuid := '14220000-0000-4000-8000-000000000022';
	v_change_unlisted uuid := '14220000-0000-4000-8000-000000000023';
	v_change_mail_ok uuid := '14220000-0000-4000-8000-000000000024';
	v_change_mail_paused uuid := '14220000-0000-4000-8000-000000000025';
	v_change_mail_self uuid := '14220000-0000-4000-8000-000000000026';
	v_change_mail_limit uuid := '14220000-0000-4000-8000-000000000027';
	v_change_mail_qorpera uuid := '14220000-0000-4000-8000-000000000028';
	v_job_id uuid := '14220000-0000-4000-8000-000000000006';
	v_pub_job_id uuid := '14220000-0000-4000-8000-000000000029';
	v_lease_token uuid := '14220000-0000-4000-8000-000000000030';
	v_wrong_lease uuid := '14220000-0000-4000-8000-000000000031';
	v_hook_active uuid := '14220000-0000-4000-8000-000000000032';
	v_hook_paused uuid := '14220000-0000-4000-8000-000000000033';
	v_box_active uuid := '14220000-0000-4000-8000-000000000034';
	v_box_paused uuid := '14220000-0000-4000-8000-000000000035';
	v_ops_res jsonb;
	v_ops_replay jsonb;
	v_mail_row public.qorpera_company_mail_outbox%rowtype;
	v_site_id uuid := '14220000-0000-4000-8000-000000000010';
	v_dep_id uuid := '14220000-0000-4000-8000-000000000011';
	v_ingested integer;
	v_hour_unix bigint := extract(epoch from date_trunc('hour', clock_timestamp(), 'UTC'))::bigint;
	v_health jsonb;
	v_latency jsonb;
	v_errors jsonb;
	v_sha_a text := repeat('a', 40);
	v_sha_b text := repeat('b', 40);
	v_sha_c text := repeat('c', 40);
begin
	perform pg_temp.o_clean();

	insert into public.qorpera_code_repositories (environment_id, profile_id, owner, name, main_sha, last_main)
	values (v_env, v_profile, 'acme', 'demo', v_sha_a, v_sha_a)
	on conflict (environment_id, owner, name) do nothing;

	perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);
	v_created := public.qorpera_create_code_git_token(v_env, 'Laptop push key', 'write', 'acme', 'demo', 14);
	v_token := v_created ->> 'token';
	v_token_id := (v_created ->> 'id')::uuid;
	if v_token is null or left(v_token, 5) <> 'qgit_' or (v_created ->> 'scope') <> 'write' then
		raise exception 'Expected created Git token with qgit_ prefix and write scope, got %', v_created;
	end if;

	v_listed := public.qorpera_list_code_git_tokens(v_env);
	if jsonb_array_length(v_listed) <> 1 or (v_listed -> 0) ? 'token' or (v_listed -> 0) ? 'token_sha256' then
		raise exception 'Listed Git tokens must omit secret material, got %', v_listed;
	end if;

	begin
		perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_outsider::text)::text, true);
		perform public.qorpera_list_code_git_tokens(v_env);
		raise exception 'Outsider should not list company Git tokens';
	exception when sqlstate '42501' then
		null;
	end;

	v_token_sha := encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex');
	perform pg_temp.base_claims('service_role');
	v_verified := public.qorpera_verify_code_git_token(v_token_sha, v_profile, 'acme', 'demo', 'write');
	if coalesce((v_verified ->> 'allowed')::boolean, false) is not true
		or (v_verified ->> 'tokenId')::uuid <> v_token_id
		or (v_verified ->> 'defaultBranch') <> 'main' then
		raise exception 'Expected valid write token verification, got %', v_verified;
	end if;

	begin
		perform public.qorpera_verify_code_git_token(v_token_sha, v_profile, 'acme', 'other', 'read');
		raise exception 'Repo-scoped token should be refused for another repo';
	exception when sqlstate '42501' then
		null;
	end;

	v_push := public.qorpera_record_git_http_push(
		v_env, 'acme', 'demo', v_token_id, v_sha_b, v_sha_c, '["refs/heads/main"]'::jsonb
	);
	if coalesce((v_push ->> 'recorded')::boolean, false) is not true
		or (v_push ->> 'changeNumber')::integer <> 2 then
		raise exception 'Expected gap filler + push changeNumber 2, got %', v_push;
	end if;
	if not exists (
		select 1 from public.qorpera_code_changes
		where environment_id = v_env and owner = 'acme' and name = 'demo' and n = 1 and kind = 'found'
	) or not exists (
		select 1 from public.qorpera_code_changes
		where environment_id = v_env and owner = 'acme' and name = 'demo' and n = 2 and kind = 'push' and main_after = v_sha_c
	) then
		raise exception 'Expected found(1) and push(2) change rows in qorpera_code_changes';
	end if;

	perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);
	v_revoked := public.qorpera_revoke_code_git_token(v_token_id);
	if (v_revoked ->> 'revokedAt') is null then
		raise exception 'Expected revokedAt timestamp on revoked token, got %', v_revoked;
	end if;

	perform pg_temp.base_claims('service_role');
	begin
		perform public.qorpera_verify_code_git_token(v_token_sha, v_profile, 'acme', 'demo', 'read');
		raise exception 'Revoked token must be refused';
	exception when sqlstate '42501' then
		null;
	end;

	insert into public.qorpera_surfaces (id, profile_id, slug, title, surface_group, archetype, source_kind)
	values (v_surface_id, v_profile, 'ops-test', 'Ops Test', 'operations', 'ops', 'native_ops');

	insert into public.qorpera_surface_sessions (id, profile_id, surface_id, title, prompt, state, created_by_user_id)
	values (v_session_id, v_profile, v_surface_id, 'Ops run', 'Handle ops actions', 'ready', v_owner);

	insert into public.qorpera_surface_changes (id, profile_id, surface_id, session_id, seq, title, kind, status, patch_manifest)
	values
		(v_change_noop, v_profile, v_surface_id, v_session_id, 1, 'Noop', 'ops_action', 'merging', '{"actionKind":"noop","actionPayload":{}}'::jsonb),
		(v_change_block, v_profile, v_surface_id, v_session_id, 2, 'Block spam', 'ops_action', 'merging', '{"actionKind":"mail.block_sender","actionPayload":{"sender":"spam@example.com","trashExisting":false}}'::jsonb),
		(v_change_bad, v_profile, v_surface_id, v_session_id, 3, 'Unsupported', 'ops_action', 'merging', '{"actionKind":"unknown.kind","actionPayload":{}}'::jsonb),
		(v_change_discarded, v_profile, v_surface_id, v_session_id, 4, 'Discarded', 'ops_action', 'discarded', '{"actionKind":"noop","actionPayload":{}}'::jsonb),
		(v_change_git, v_profile, v_surface_id, v_session_id, 5, 'Git change', 'git_range', 'merging', '{"actionKind":"noop","actionPayload":{}}'::jsonb),
		(v_change_unlisted, v_profile, v_surface_id, v_session_id, 6, 'Unlisted', 'ops_action', 'merging', '{"actionKind":"noop","actionPayload":{}}'::jsonb),
		(v_change_mail_ok, v_profile, v_surface_id, v_session_id, 7, 'Send update', 'ops_action', 'merging',
			jsonb_build_object('actionKind', 'mail.send', 'actionPayload', jsonb_build_object('mailboxId', v_box_active, 'to', jsonb_build_array('customer@example.org'), 'subject', 'Weekly update', 'body', 'Hello customer.'))),
		(v_change_mail_paused, v_profile, v_surface_id, v_session_id, 8, 'Send paused', 'ops_action', 'merging',
			jsonb_build_object('actionKind', 'mail.send', 'actionPayload', jsonb_build_object('mailboxId', v_box_paused, 'to', jsonb_build_array('customer@example.org'), 'subject', 'Paused', 'body', 'Should refuse.'))),
		(v_change_mail_self, v_profile, v_surface_id, v_session_id, 9, 'Send self', 'ops_action', 'merging',
			jsonb_build_object('actionKind', 'mail.send', 'actionPayload', jsonb_build_object('mailboxId', v_box_active, 'to', jsonb_build_array('active1422@nordlys.example'), 'subject', 'Self', 'body', 'Should refuse.'))),
		(v_change_mail_limit, v_profile, v_surface_id, v_session_id, 10, 'Send limit', 'ops_action', 'merging',
			jsonb_build_object('actionKind', 'mail.send', 'actionPayload', jsonb_build_object('mailboxId', v_box_active, 'to', jsonb_build_array('second@example.org'), 'subject', 'Over cap', 'body', 'Should hit limit.'))),
		(v_change_mail_qorpera, v_profile, v_surface_id, v_session_id, 11, 'Send qorpera name', 'ops_action', 'merging',
			jsonb_build_object('actionKind', 'mail.send', 'actionPayload', jsonb_build_object('mailboxId', v_box_active, 'to', jsonb_build_array('third@example.org'), 'subject', 'Brand check', 'body', 'Should refuse Qorpera name.')));

	insert into public.qorpera_surface_jobs (id, profile_id, surface_id, session_id, kind, status, requested_by_user_id, lease_token, payload)
	values
		(v_job_id, v_profile, v_surface_id, v_session_id, 'land_change', 'running', v_owner, v_lease_token,
			jsonb_build_object('changeIds', jsonb_build_array(
				v_change_noop, v_change_block, v_change_bad, v_change_discarded, v_change_git,
				v_change_mail_ok, v_change_mail_paused, v_change_mail_self, v_change_mail_limit, v_change_mail_qorpera
			))),
		(v_pub_job_id, v_profile, v_surface_id, v_session_id, 'publish_surface', 'running', v_owner, v_lease_token,
			jsonb_build_object('changeIds', jsonb_build_array(v_change_noop)));

	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_noop, v_wrong_lease);
		raise exception 'Wrong lease token must be refused';
	exception when sqlstate '55000' then null;
	end;
	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_pub_job_id, v_change_noop, v_lease_token);
		raise exception 'Non-land_change job must be refused';
	exception when sqlstate '22023' then null;
	end;
	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_unlisted, v_lease_token);
		raise exception 'Unapproved change not in job payload must be refused';
	exception when sqlstate '42501' then null;
	end;
	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_discarded, v_lease_token);
		raise exception 'Discarded change must be refused';
	exception when sqlstate '55000' then null;
	end;
	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_git, v_lease_token);
		raise exception 'Non-ops_action change must be refused';
	exception when sqlstate '22023' then null;
	end;

	v_ops_res := public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_noop, v_lease_token);
	if (v_ops_res ->> 'status') <> 'landed' or coalesce((v_ops_res ->> 'replayed')::boolean, true) is not false then
		raise exception 'Expected landed non-replayed noop ops result, got %', v_ops_res;
	end if;
	v_ops_replay := public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_noop, v_lease_token);
	if coalesce((v_ops_replay ->> 'replayed')::boolean, false) is not true then
		raise exception 'Expected idempotent replay for duplicate ops change, got %', v_ops_replay;
	end if;

	v_ops_res := public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_block, v_lease_token);
	if (v_ops_res ->> 'status') <> 'landed'
		or not exists (
			select 1 from public.qorpera_mail_blocked_senders
			where profile_id = v_profile and environment_id = v_env and sender = 'spam@example.com'
		) then
		raise exception 'Expected mail.block_sender ops action to persist blocked sender, got %', v_ops_res;
	end if;

	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_bad, v_lease_token);
		raise exception 'Unsupported ops action kind should fail';
	exception when sqlstate '22023' then
		null;
	end;

	update public.qorpera_mail_settings
	set enabled = true, sending = true, domain = 'nordlys.example',
		company_hourly_recipients = 1, company_daily_recipients = 10;
	insert into public.qorpera_event_hooks (id, profile_id, environment_id, name, purpose, proof, address, status, created_by_user_id) values
		(v_hook_active, v_profile, v_env, 'mail-1422-a', 'active mailbox', 'mail', repeat('a', 43), 'active', v_owner),
		(v_hook_paused, v_profile, v_env, 'mail-1422-p', 'paused mailbox', 'mail', repeat('b', 43), 'paused', v_owner);
	insert into public.qorpera_company_mailboxes (id, hook_id, profile_id, environment_id, local_part, created_by_user_id) values
		(v_box_active, v_hook_active, v_profile, v_env, 'active1422', v_owner),
		(v_box_paused, v_hook_paused, v_profile, v_env, 'paused1422', v_owner);

	update auth.users set raw_user_meta_data = '{"display_name":"jane@example.com"}' where id = v_owner;

	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_mail_paused, v_lease_token);
		raise exception 'Paused mailbox send must be refused';
	exception when sqlstate '0A000' then null;
	end;

	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_mail_self, v_lease_token);
		raise exception 'Self-mailbox send must be refused';
	exception when sqlstate '42501' then null;
	end;

	v_ops_res := public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_mail_ok, v_lease_token);
	select * into v_mail_row from public.qorpera_company_mail_outbox where id = (v_ops_res -> 'receipt' ->> 'outboxId')::uuid;
	if v_mail_row.id is null
		or v_mail_row.from_name <> 'A member at Folder runtime base'
		or position('Drafted by an AI agent' in v_mail_row.body) = 0
		or not exists (select 1 from public.qorpera_mail_threads where id = v_mail_row.thread) then
		raise exception 'Expected guarded ops mail row with non-email from_name, AI line, and thread note; got %', row_to_json(v_mail_row);
	end if;

	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_mail_limit, v_lease_token);
		raise exception 'Company hourly recipient limit must be enforced';
	exception when sqlstate '54000' then null;
	end;

	update public.qorpera_mail_settings set company_hourly_recipients = 10;
	update auth.users set raw_user_meta_data = '{"display_name":"Q0rpera Support"}' where id = v_owner;
	begin
		perform public.qorpera_execute_surface_ops_action(v_profile, v_job_id, v_change_mail_qorpera, v_lease_token);
		raise exception 'Qorpera-impersonating sender display name must be refused';
	exception when sqlstate '42501' then null;
	end;
	update auth.users set raw_user_meta_data = '{"display_name":"Olivia Owner"}' where id = v_owner;

	perform pg_temp.o_same(
		pg_temp.o_refused('app-health', '{}', v_owner, v_env),
		'55000 Not connected: app server metrics appear once the company deploys a server or hybrid app',
		'app-health not connected without server deployment'
	);

	insert into public.qorpera_company_sites (
		id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id,
		deployment_kind, storage_mode
	) values (
		v_site_id, v_profile, v_env, 'api-app', 'API App', 'web', v_agent, 'server', 'blob'
	);

	insert into public.qorpera_company_site_deployments (
		id, site_id, profile_id, version_number, kind, state, oci_image_ref, app_port
	) values (
		v_dep_id, v_site_id, v_profile, 1, 'server', 'live', 'registry.internal/app:v1', 3000
	);

	update public.qorpera_company_sites
	set live_deployment_id = v_dep_id
	where id = v_site_id;

	perform pg_temp.base_claims('service_role');
	v_ingested := public.qorpera_ingest_app_telemetry(jsonb_build_array(
		jsonb_build_object(
			'siteId', v_site_id,
			'deploymentId', v_dep_id,
			'hourUnix', v_hour_unix,
			'requests', 100,
			'status2xx', 90,
			'status3xx', 3,
			'status4xx', 5,
			'status5xx', 2,
			'latencySumMs', 4500,
			'latencyP50Ms', 35,
			'latencyP95Ms', 120,
			'latencyMaxMs', 240
		),
		jsonb_build_object(
			'siteId', v_site_id,
			'deploymentId', '14220000-0000-4000-8000-999999999999',
			'hourUnix', v_hour_unix,
			'requests', 50
		)
	));
	if v_ingested <> 1 then
		raise exception 'Expected 1 valid ingested telemetry bucket (ignoring unknown deployment), got %', v_ingested;
	end if;

	v_ingested := public.qorpera_ingest_app_telemetry(jsonb_build_array(
		jsonb_build_object(
			'siteId', v_site_id,
			'deploymentId', v_dep_id,
			'hourUnix', v_hour_unix,
			'requests', 100,
			'status2xx', 96,
			'status3xx', 0,
			'status4xx', 2,
			'status5xx', 2,
			'latencySumMs', 5500,
			'latencyP50Ms', 45,
			'latencyP95Ms', 160,
			'latencyMaxMs', 300
		)
	));
	if v_ingested <> 1 then
		raise exception 'Expected additive telemetry upsert to return 1, got %', v_ingested;
	end if;

	v_health := pg_temp.o_member(v_owner, 'app-health', jsonb_build_object('site', 'api-app'), v_env);
	if (v_health -> 'rows' -> 0 ->> 0) <> 'api-app'
		or (v_health -> 'rows' -> 0 ->> 1) <> 'server'
		or (v_health -> 'rows' -> 0 ->> 2) <> 'live'
		or (v_health -> 'rows' -> 0 ->> 3)::bigint <> 200
		or (v_health -> 'rows' -> 0 ->> 4)::numeric <> 2.00
		or (v_health -> 'rows' -> 0 ->> 5)::integer <> 50
		or (v_health -> 'rows' -> 0 ->> 6)::integer <> 140 then
		raise exception 'Unexpected app-health result: %', v_health;
	end if;

	v_latency := pg_temp.o_member(v_owner, 'app-latency', jsonb_build_object('site', 'api-app'), v_env);
	if jsonb_array_length(v_latency -> 'rows') <> 48 then
		raise exception 'Expected 48 hourly rows from default app-latency, got %', jsonb_array_length(v_latency -> 'rows');
	end if;

	v_errors := pg_temp.o_member(v_owner, 'app-errors', jsonb_build_object('site', 'api-app'), v_env);
	if jsonb_array_length(v_errors -> 'rows') <> 48
		or (v_errors -> 'rows' -> 47 ->> 3)::bigint <> 200
		or (v_errors -> 'rows' -> 47 ->> 6)::bigint <> 4 then
		raise exception 'Unexpected app-errors result: %', v_errors -> 'rows' -> 47;
	end if;

	if not has_function_privilege('qorpera_web_router', 'public.qorpera_ingest_app_telemetry(jsonb)', 'EXECUTE') then
		raise exception 'qorpera_web_router must have EXECUTE on qorpera_ingest_app_telemetry';
	end if;
	if has_function_privilege('authenticated', 'public.qorpera_ingest_app_telemetry(jsonb)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_verify_code_git_token(text,uuid,text,text,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_queue_surface_ops_mail(uuid,uuid,uuid,uuid,jsonb)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_execute_surface_ops_action(uuid,uuid,uuid,uuid)', 'EXECUTE') then
		raise exception 'Internal functions must not be executable by authenticated';
	end if;
end $$;
