-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"

insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('13320000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker-1332.example.test',
	'company-kek-1332', repeat('a', 64));

create function pg_temp.t1332_secret(p_id uuid, p_owner uuid, p_name text, p_plaintext text) returns void
language sql as $$
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
	values (p_id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'13320000-0000-4000-8000-000000000040', case when p_owner is null then 'company' else 'member' end,
		p_owner, 'environment', p_name, 'Test secret ' || p_name, 1,
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (p_id, 1, '13320000-0000-4000-8000-000000000040', 'company-kek-1332', convert_to(p_plaintext, 'UTF8'),
		encode(extensions.digest(convert_to(p_plaintext, 'UTF8'), 'sha256'), 'hex'),
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
$$;

create function pg_temp.t1332_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || coalesce(v::text, 'null');
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.t1332_try(text) to authenticated, qorpera_secret_broker;

create function pg_temp.t1332_as_member(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.t1332_try(p_sql);
	reset role;
	return v;
end $$;

create function pg_temp.t1332_as_broker(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform set_config('request.jwt.claims', '{}', true);
	execute 'set local session authorization qorpera_secret_broker';
	v := pg_temp.t1332_try(p_sql);
	execute 'reset session authorization';
	return v;
end $$;

do $$
declare
	v_name text;
	v_res text;
begin
	foreach v_name in array array['openai_api_key', 'openai_base_url', 'anthropic_api_key', 'anthropic_version', 'stripe_secret_key'] loop
		perform pg_temp.base_assert(public.qorpera_coding_environment_name_allowed(v_name), 'should allow ' || v_name);
	end loop;
	foreach v_name in array array['qorpera_token', 'ld_preload', 'dyld_insert_libraries', 'git_dir', 'ssh_auth_sock',
		'lc_all', 'xdg_config_home', 'docker_host', 'claude_code_oauth_token', 'codex_home', 'home', 'path'] loop
		perform pg_temp.base_assert(not public.qorpera_coding_environment_name_allowed(v_name), 'should refuse ' || v_name);
	end loop;

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, null, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
			'company', 'environment', 'openai_api_key', 'Company OpenAI API key'));
	perform pg_temp.base_assert(v_res like 'ok:%', 'capture openai_api_key allowed: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, null, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
			'company', 'environment', 'anthropic_api_key', 'Company Anthropic API key'));
	perform pg_temp.base_assert(v_res like 'ok:%', 'capture anthropic_api_key allowed: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, null, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
			'company', 'environment', 'qorpera_internal', 'Refused prefix'));
	perform pg_temp.base_assert(v_res = '22023:That name is not available for an environment variable', 'refuse qorpera_internal: ' || v_res);
end $$;

do $$
declare
	v_alice jsonb := pg_temp.c3_alice();
	v_worker uuid := '13320000-0000-4000-8000-0000000000b1';
	v_sec_openai uuid := '13320000-0000-4000-8000-000000000071';
	v_sec_anthropic uuid := '13320000-0000-4000-8000-000000000072';
	v_sec_member uuid := '13320000-0000-4000-8000-000000000073';
	v_sec_runtime_only uuid := '13320000-0000-4000-8000-000000000074';
	v_sec_ungranted uuid := '13320000-0000-4000-8000-000000000075';
	v_claim jsonb;
	v_pass jsonb;
	v_binding jsonb;
	v_context jsonb;
	v_auth text;
	v_grant_res text;
	v_runtime_grant_id uuid;
begin
	perform pg_temp.t1332_secret(v_sec_openai, null, 'openai_api_key', 'sk-proj-secret-openai-value-1332');
	perform pg_temp.t1332_secret(v_sec_anthropic, null, 'anthropic_api_key', 'sk-ant-secret-anthropic-value-1332');
	perform pg_temp.t1332_secret(v_sec_member, '92400000-0000-4000-8000-000000000001', 'npm_token', 'npm_member_secret_1332');
	perform pg_temp.t1332_secret(v_sec_runtime_only, null, 'prod_jwt_secret', 'prod_jwt_runtime_only_1332');
	perform pg_temp.t1332_secret(v_sec_ungranted, null, 'ungranted_secret', 'never_shown_1332');

	v_grant_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_coding_environment_secret(%L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_openai, 'Qorpera/Qorpera_Base'));
	perform pg_temp.base_assert(v_grant_res like 'ok:%', 'grant openai: ' || v_grant_res);

	v_grant_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_coding_environment_secret(%L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_anthropic, 'Qorpera/Qorpera_Base'));
	perform pg_temp.base_assert(v_grant_res like 'ok:%', 'grant anthropic: ' || v_grant_res);

	v_grant_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_coding_environment_secret(%L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_runtime_only, 'Qorpera/Qorpera_Base'));
	v_runtime_grant_id := (substring(v_grant_res from 4)::jsonb ->> 'grantId')::uuid;
	update public.qorpera_coding_environment_grants set scope = 'runtime' where id = v_runtime_grant_id;

	perform pg_temp.base_claims('service_role');
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-1332', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'w6c-dispatch', 'QorperaOS/agents/alice/todos/fix-login/session-1332',
		pg_temp.c3_brief(v_worker)) -> 'units' -> 0 ->> 'outcome' = 'saved', 'dispatch session');

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding, instance_sha256)
	values ('13320000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-1332',
		repeat('7', 64), '{}'::jsonb, encode(extensions.digest(convert_to('{}', 'utf8'), 'sha256'), 'hex'));
	set local session_replication_role = origin;

	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1332', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = v_worker::text,
		'claimed worker: claim=' || coalesce(v_claim::text, 'null') || ' session=' || coalesce(to_jsonb(pg_temp.c3_session(v_worker))::text, 'null'));
	perform public.qorpera_begin_coding_turn(v_worker, (pg_temp.c3_session(v_worker)).lease_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_binding := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	update public.qorpera_coding_sessions set vm_allocation_id = '13320000-0000-4000-8000-0000000000d1'
	where worker_id = v_worker;

	perform pg_temp.base_claims('service_role');
	v_context := public.qorpera_read_coding_turn_context(v_binding);
	perform pg_temp.base_assert(
		v_context -> 'secretNames' = '["ANTHROPIC_API_KEY","NPM_TOKEN","OPENAI_API_KEY"]'::jsonb,
		'secretNames sorted and scoped: ' || coalesce(v_context -> 'secretNames', 'null'::jsonb)::text
	);
	perform pg_temp.base_assert(
		position('sk-proj-secret' in v_context::text) = 0
		and position('sk-ant-secret' in v_context::text) = 0
		and position('npm_member_secret' in v_context::text) = 0
		and position('PROD_JWT_SECRET' in v_context::text) = 0
		and position('UNGRANTED_SECRET' in v_context::text) = 0,
		'turn context leaks zero secret values or excluded names'
	);

	v_auth := pg_temp.t1332_as_broker(format(
		'select public.qorpera_authorize_coding_environment(%L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_worker,
		(pg_temp.c3_session(v_worker)).lease_token, 'exec-1332'));
	perform pg_temp.base_assert(v_auth like 'ok:%', 'coding env broker auth: ' || v_auth);
	perform pg_temp.base_assert(
		(select array_agg(s ->> 'name' order by s ->> 'name')
			from jsonb_array_elements(substring(v_auth from 4)::jsonb -> 'secrets') as s)
		= array['ANTHROPIC_API_KEY', 'NPM_TOKEN', 'OPENAI_API_KEY'],
		'coding broker excludes runtime-only grant: ' || v_auth
	);

	perform pg_temp.base_assert(
		pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000002',
			format('select public.qorpera_set_coding_environment_grant_scope(%L, %L, %L, %L, null)',
				'92400000-0000-4000-8000-000000000010',
				(select id from public.qorpera_coding_environment_grants where secret_id = '13320000-0000-4000-8000-000000000072' limit 1),
				'build', 'prod')) like '42501:%',
		'contributor cannot change coding grant scope'
	);

	v_auth := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_set_coding_environment_grant_scope(%L, %L, %L, %L, null)',
			'92400000-0000-4000-8000-000000000010',
			(select id from public.qorpera_coding_environment_grants where secret_id = '13320000-0000-4000-8000-000000000072' limit 1),
			'build', 'prod'));
	perform pg_temp.base_assert(v_auth like 'ok:%' and substring(v_auth from 4)::jsonb ->> 'targetEnv' = 'prod',
		'owner scopes coding grant to prod: ' || v_auth);

	perform pg_temp.base_claims('service_role');
	v_context := public.qorpera_read_coding_turn_context(v_binding);
	perform pg_temp.base_assert(
		v_context -> 'secretNames' = '["NPM_TOKEN","OPENAI_API_KEY"]'::jsonb,
		'prod-targeted coding grant excluded from secretNames: ' || coalesce(v_context -> 'secretNames', 'null'::jsonb)::text
	);
end $$;

do $$
declare
	v_site uuid := '13320000-0000-4000-8000-000000000090';
	v_sec_openai uuid := '13320000-0000-4000-8000-000000000071';
	v_sec_anthropic uuid := '13320000-0000-4000-8000-000000000072';
	v_sec_member uuid := '13320000-0000-4000-8000-000000000073';
	v_sec_build uuid := '13320000-0000-4000-8000-000000000076';
	v_res text;
	v_res2 text;
	v_grant_prod uuid;
	v_grant_admin uuid;
	v_ver1 uuid := '13320000-0000-4000-8000-000000000093';
	v_ver2 uuid := '13320000-0000-4000-8000-000000000094';
	v_dep uuid := '13320000-0000-4000-8000-000000000095';
	v_dep2 uuid := '13320000-0000-4000-8000-000000000096';
	v_machine_sha text := repeat('c', 64);
	v_list jsonb;
	v_auth jsonb;
	v_lookup jsonb;
	v_switch jsonb;
begin
	update public.qorpera_coding_executors
	set nas_machine_id_sha256 = v_machine_sha
	where environment_id = '92400000-0000-4000-8000-000000000020' and owner = 'exec-1332';
	perform pg_temp.t1332_secret(v_sec_build, null, 'build_cache_token', 'build_token_secret_1332');
	insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id, deployment_kind)
	values (v_site, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'billing-app', 'Billing App', 'apps/billing', '92400000-0000-4000-8000-000000000030', 'server');
	insert into public.qorpera_company_site_versions(
		id, site_id, state, first_publish, title, source_path, manifest_sha256, file_count, total_bytes, tree, change, main_sha, listed, published_at
	) values
		(v_ver1, v_site, 'live', true, 'Billing App', 'code/qorpera/qorpera_base', repeat('1', 64), 0, 0, repeat('a', 40), 1, repeat('a', 40), true, clock_timestamp()),
		(v_ver2, v_site, 'ready', false, 'Billing App v2', 'code/qorpera/qorpera_base', repeat('2', 64), 0, 0, repeat('b', 40), 2, repeat('b', 40), true, null);
	insert into public.qorpera_company_site_deployments(
		id, site_id, profile_id, version_number, version_id, kind, state, oci_image_ref, app_port, health_path, change_number, main_sha
	) values
		(v_dep, v_site, '92400000-0000-4000-8000-000000000010', 1, v_ver1, 'server', 'live',
			'127.0.0.1:5000/qorpera-apps/billing-app@sha256:' || repeat('d', 64), 3000, '/health', 1, repeat('a', 40)),
		(v_dep2, v_site, '92400000-0000-4000-8000-000000000010', 2, v_ver2, 'server', 'ready',
			'127.0.0.1:5000/qorpera-apps/billing-app@sha256:' || repeat('e', 64), 3000, '/health', 2, repeat('b', 40));
	update public.qorpera_company_sites set current_version_id = v_ver1, live_deployment_id = v_dep where id = v_site;
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, site_id)
	values ('92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010', 'qorpera', 'qorpera_base', v_site)
	on conflict (environment_id, owner, name) do update set site_id = excluded.site_id;
	insert into public.qorpera_code_changes(
		environment_id, owner, name, n, profile_id, kind, state, how, main_before, main_after, head_sha,
		worker_id, sequence, title, site_state, site
	) values
		('92400000-0000-4000-8000-000000000020', 'qorpera', 'qorpera_base', 2, '92400000-0000-4000-8000-000000000010',
			'landing', 'landed', 'fast-forward', repeat('a', 40), repeat('b', 40), repeat('b', 40),
			'13320000-0000-4000-8000-0000000000b9', 1, 'Deploy server v2', 'made',
			jsonb_build_object('schema', 'qorpera.code-site/v2', 'kind', 'server', 'tree', repeat('b', 40),
				'files', 0, 'bytes', 0, 'folder', '.', 'name', 'billing-app', 'title', 'Billing App v2', 'port', 3000, 'healthPath', '/health')),
		('92400000-0000-4000-8000-000000000020', 'qorpera', 'qorpera_base', 3, '92400000-0000-4000-8000-000000000010',
			'landing', 'landed', 'fast-forward', repeat('b', 40), repeat('c', 40), repeat('c', 40),
			'13320000-0000-4000-8000-0000000000b9', 2, 'Deploy static v3', 'made',
			jsonb_build_object('schema', 'qorpera.code-site/v1', 'tree', repeat('c', 40),
				'files', 1, 'bytes', 10, 'folder', 'dist', 'name', 'billing-app', 'title', 'Static'));

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000002',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_openai, v_site, 'runtime', 'prod'));
	perform pg_temp.base_assert(v_res = '42501:app secret grants need an owner or administrator', 'contributor refused: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_member, v_site, 'runtime', 'prod'));
	perform pg_temp.base_assert(v_res = '42501:company environment secret is unavailable', 'member secret refused: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_openai, v_site, 'invalid', 'prod'));
	perform pg_temp.base_assert(v_res like '22023:%', 'bad scope refused: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_openai, v_site, 'runtime', 'prod'));
	perform pg_temp.base_assert(v_res like 'ok:%', 'grant runtime prod: ' || v_res);
	v_grant_prod := (substring(v_res from 4)::jsonb ->> 'grantId')::uuid;

	v_res2 := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_openai, v_site, 'runtime', 'prod'));
	perform pg_temp.base_assert((substring(v_res2 from 4)::jsonb ->> 'grantId')::uuid = v_grant_prod, 'idempotent app grant');

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000004',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_anthropic, v_site, 'runtime', 'dev'));
	perform pg_temp.base_assert(v_res like 'ok:%', 'admin grant runtime dev: ' || v_res);
	v_grant_admin := (substring(v_res from 4)::jsonb ->> 'grantId')::uuid;

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_grant_app_secret(%L, %L, %L, %L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_build, v_site, 'build', 'prod'));
	perform pg_temp.base_assert(v_res like 'ok:%', 'grant build prod: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000003',
		format('select public.qorpera_list_app_secrets(%L, %L)', '92400000-0000-4000-8000-000000000010', v_site));
	v_list := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(jsonb_array_length(v_list) = 3 and position('sk-proj-secret' in v_list::text) = 0,
		'viewer sees 3 secret names with zero values: ' || v_list::text);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000005',
		format('select public.qorpera_list_app_secrets(%L, %L)', '92400000-0000-4000-8000-000000000010', v_site));
	perform pg_temp.base_assert(substring(v_res from 4)::jsonb = '[]'::jsonb, 'outsider sees empty list');

	perform pg_temp.base_assert(
		not has_function_privilege('authenticated', 'public.qorpera_authorize_app_secrets(uuid,text,uuid,text,text,text,text,uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_authorize_app_secrets(uuid,text,uuid,text,text,text,text,uuid)', 'execute')
		and has_function_privilege('qorpera_secret_broker', 'public.qorpera_authorize_app_secrets(uuid,text,uuid,text,text,text,text,uuid)', 'execute'),
		'authorize_app_secrets is broker-only'
	);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'runtime', 'prod', 'other-exec', v_machine_sha, v_dep));
	perform pg_temp.base_assert(v_res like '42501:%', 'non-custody executor refused app secrets: ' || v_res);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L, %L, %L, null)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'runtime', 'prod', 'exec-1332', v_machine_sha));
	perform pg_temp.base_assert(v_res like '42501:%', 'runtime secrets without deployment proof refused: ' || v_res);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'runtime', 'prod', 'exec-1332', v_machine_sha, v_dep));
	perform pg_temp.base_assert(v_res like 'ok:%', 'broker runtime prod: ' || v_res);
	v_auth := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(
		jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth -> 'secrets' -> 0 ->> 'name' = 'OPENAI_API_KEY'
		and v_auth -> 'secrets' -> 0 ->> 'scope' = 'runtime'
		and v_auth -> 'secrets' -> 0 ->> 'targetEnv' = 'prod',
		'runtime prod returns only OPENAI_API_KEY: ' || v_auth::text
	);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'build', 'prod', 'exec-1332', v_machine_sha, v_dep));
	v_auth := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(
		jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth -> 'secrets' -> 0 ->> 'name' = 'BUILD_CACHE_TOKEN',
		'build prod returns only BUILD_CACHE_TOKEN: ' || v_auth::text
	);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'runtime', 'dev', 'exec-1332', v_machine_sha, v_dep));
	v_auth := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(
		jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth -> 'secrets' -> 0 ->> 'name' = 'ANTHROPIC_API_KEY',
		'runtime dev returns only ANTHROPIC_API_KEY: ' || v_auth::text
	);

	perform pg_temp.base_claims('service_role');
	v_lookup := public.qorpera_code_site_for_auto_redeploy(
		'exec-1332', v_machine_sha, '92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 2);
	perform pg_temp.base_assert(
		(v_lookup ->> 'found')::boolean
		and (v_lookup ->> 'siteId')::uuid = v_site
		and (v_lookup ->> 'currentDeploymentId')::uuid = v_dep
		and (v_lookup ->> 'existingDeploymentId')::uuid = v_dep2
		and v_lookup ->> 'kind' = 'server'
		and v_lookup ->> 'slug' = 'billing-app',
		'auto-redeploy site lookup returns live server site and existing built deployment: ' || v_lookup::text
	);
	v_lookup := public.qorpera_code_site_for_auto_redeploy(
		'exec-1332', v_machine_sha, '92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 3);
	perform pg_temp.base_assert(not (v_lookup ->> 'found')::boolean, 'static site change refused for auto-redeploy');
	v_lookup := public.qorpera_code_site_for_auto_redeploy(
		'other-exec', v_machine_sha, '92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 2);
	perform pg_temp.base_assert(not (v_lookup ->> 'found')::boolean, 'non-holder executor gets found=false');

	v_switch := public.qorpera_code_site_auto_redeploy_switch(
		'other-exec', v_machine_sha, '92400000-0000-4000-8000-000000000020', v_site, v_dep2, '127.0.0.1:41234');
	perform pg_temp.base_assert(v_switch ->> 'state' = 'lost', 'non-holder cannot switch live deployment: ' || v_switch::text);

	v_switch := public.qorpera_code_site_auto_redeploy_switch(
		'exec-1332', v_machine_sha, '92400000-0000-4000-8000-000000000020', v_site, v_dep2, '127.0.0.1:41234');
	perform pg_temp.base_assert(
		v_switch ->> 'state' = 'live'
		and (v_switch ->> 'deploymentId')::uuid = v_dep2
		and (select live_deployment_id from public.qorpera_company_sites where id = v_site) = v_dep2
		and (select current_version_id from public.qorpera_company_sites where id = v_site) = v_ver2
		and (select upstream_addr from public.qorpera_company_site_deployments where id = v_dep2) = '127.0.0.1:41234',
		'auto-redeploy switch promotes new server deployment live: ' || v_switch::text
	);

	v_switch := public.qorpera_code_site_auto_redeploy_switch(
		'exec-1332', v_machine_sha, '92400000-0000-4000-8000-000000000020', v_site, v_dep, '127.0.0.1:41230');
	perform pg_temp.base_assert(
		v_switch ->> 'state' = 'live'
		and (select live_deployment_id from public.qorpera_company_sites where id = v_site) = v_dep
		and (select current_version_id from public.qorpera_company_sites where id = v_site) = v_ver1
		and (select upstream_addr from public.qorpera_company_site_deployments where id = v_dep) = '127.0.0.1:41230'
		and (select upstream_addr from public.qorpera_company_site_deployments where id = v_dep2) is null,
		'auto-redeploy switch rolls back live deployment and clears old upstream: ' || v_switch::text
	);

	perform pg_temp.base_assert(
		(select count(*) from public.qorpera_cloud_secret_audit_events
			where profile_id = '92400000-0000-4000-8000-000000000010' and event_type = 'app_secret_used') = 3,
		'3 app_secret_used audit events written'
	);

	update public.qorpera_profile_members set role = 'contributor'
	where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000004';
	perform pg_temp.base_assert(
		(select status from public.qorpera_app_secret_grants where id = v_grant_admin) = 'revoked',
		'demoting issuer revokes app secret grant'
	);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_revoke_app_secret_grant(%L, %L)',
			'92400000-0000-4000-8000-000000000010', v_grant_prod));
	perform pg_temp.base_assert(v_res like 'ok:%' and substring(v_res from 4)::jsonb ->> 'status' = 'revoked',
		'revoke grant: ' || v_res);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_revoke_cloud_secret(%L, %L)',
			'92400000-0000-4000-8000-000000000010', v_sec_build));
	perform pg_temp.base_assert(v_res like 'ok:%', 'revoke cloud secret: ' || v_res);
	perform pg_temp.base_assert(
		not exists (select 1 from public.qorpera_app_secret_grants where secret_id = v_sec_build and status = 'active'),
		'revoking secret revokes app grants'
	);
end $$;

do $$
declare
	v_site uuid := '13320000-0000-4000-8000-000000000090';
	v_owner_actor jsonb := jsonb_build_object('kind', 'member', 'userId', '92400000-0000-4000-8000-000000000001');
	v_r_code uuid := '13320000-0000-4000-8000-000000000101';
	v_r_app uuid := '13320000-0000-4000-8000-000000000102';
	v_r_data uuid := '13320000-0000-4000-8000-000000000103';
	v_r_data_all uuid := '13320000-0000-4000-8000-000000000105';
	v_r_check uuid := '13320000-0000-4000-8000-000000000104';
	v_parse_code jsonb;
	v_parse_app jsonb;
	v_parse_data jsonb;
	v_parse_data_all jsonb;
	v_parse_check jsonb;
	v_parse_bad jsonb;
	v_commit jsonb;
	v_emit jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_chk jsonb;
begin
	perform pg_temp.base_assert(public.qorpera_listener_source('code-change'), 'code-change is listener source');
	perform pg_temp.base_assert(public.qorpera_listener_source('app-unhealthy'), 'app-unhealthy is listener source');
	perform pg_temp.base_assert(public.qorpera_listener_source('data-change'), 'data-change is listener source');

	perform pg_temp.base_assert(public.qorpera_glob_matches('src/**/*.ts', 'src/a/b/c.ts'), 'glob deep match');
	perform pg_temp.base_assert(public.qorpera_glob_matches('src/**/*.ts', 'src/index.ts'), 'glob zero-dir match');
	perform pg_temp.base_assert(not public.qorpera_glob_matches('src/**/*.ts', 'docs/index.ts'), 'glob non-match');
	perform pg_temp.base_assert(public.qorpera_glob_matches('a.b[0]+(1).ts', 'a.b[0]+(1).ts'), 'glob regex meta literal');
	perform pg_temp.base_assert(not public.qorpera_glob_matches('a.b[0]+(1).ts', 'axb0(1).ts'), 'glob dot escaped');

	v_parse_code := jsonb_build_object(
		'kind', 'routine', 'id', v_r_code, 'title', 'React to code land', 'status', 'active',
		'trigger', jsonb_build_object('when', 'code-change', 'repo', 'Qorpera/Qorpera_Base',
			'events', jsonb_build_array('landed', 'checks_failed'), 'paths', jsonb_build_array('src/**/*.ts')),
		'timezone', 'UTC', 'ends', null, 'runs', null, 'quiet', null,
		'effort', 'medium', 'reply', 'optional', 'conclusion', null, 'instructions', 'Review landed TypeScript changes.'
	);
	v_parse_app := jsonb_build_object(
		'kind', 'routine', 'id', v_r_app, 'title', 'Fix unhealthy app', 'status', 'active',
		'trigger', jsonb_build_object('when', 'app-unhealthy', 'site', 'billing-app'),
		'timezone', 'UTC', 'ends', null, 'runs', null, 'quiet', null,
		'effort', 'high', 'reply', 'optional', 'conclusion', null, 'instructions', 'Diagnose billing-app crash.'
	);
	v_parse_data := jsonb_build_object(
		'kind', 'routine', 'id', v_r_data, 'title', 'Invoice triage', 'status', 'active',
		'trigger', jsonb_build_object('when', 'data-change', 'database', 'billing',
			'tables', jsonb_build_array('invoices'), 'operations', jsonb_build_array('insert')),
		'timezone', 'UTC', 'ends', null, 'runs', null, 'quiet', null,
		'effort', 'low', 'reply', 'optional', 'conclusion', null, 'instructions', 'Process newly inserted invoices.'
	);
	v_parse_data_all := jsonb_build_object(
		'kind', 'routine', 'id', v_r_data_all, 'title', 'Invoice sync', 'status', 'active',
		'trigger', jsonb_build_object('when', 'data-change', 'database', 'billing',
			'tables', jsonb_build_array('invoices'), 'operations', null),
		'timezone', 'UTC', 'ends', null, 'runs', null, 'quiet', null,
		'effort', 'low', 'reply', 'optional', 'conclusion', null, 'instructions', 'Sync all invoice changes.'
	);
	v_parse_check := jsonb_build_object(
		'kind', 'routine', 'id', v_r_check, 'title', 'Health watchdog', 'status', 'active',
		'trigger', jsonb_build_object('when', 'every', 'minutes', 15, 'starts', null),
		'checkBeforeWake', jsonb_build_object('kind', 'http_probe', 'url', 'https://billing.example.test/health',
			'expectStatus', 200, 'timeoutMs', 5000),
		'timezone', null, 'ends', null, 'runs', null, 'quiet', null,
		'effort', 'low', 'reply', 'optional', 'conclusion', null, 'instructions', 'Investigate probe failure.'
	);

	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('routine', v_parse_code) = '[]'::jsonb, 'code-change valid');
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('routine', v_parse_app) = '[]'::jsonb, 'app-unhealthy valid');
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('routine', v_parse_data) = '[]'::jsonb, 'data-change valid');
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('routine', v_parse_check) = '[]'::jsonb, 'checkBeforeWake valid');

	perform pg_temp.base_assert(
		not public.qorpera_routine_check_before_wake_valid(
			jsonb_build_object('kind', 'http_probe', 'url', 'http://169.254.169.254/latest/meta-data')),
		'http_probe rejects plain http URL in SQL'
	);
	perform pg_temp.base_assert(
		not public.qorpera_cloud_routine_trigger_valid(jsonb_build_object(
			'id', 'file', 'kind', 'once', 'at', '2026-12-01T10:00:00Z', 'timeZone', 'UTC',
			'checkBeforeWake', jsonb_build_object('kind', 'http_probe', 'url', 'https://billing.example.test/health'))),
		'once/dynamic trigger refuses checkBeforeWake in SQL'
	);
	perform pg_temp.base_assert(
		(public.qorpera_company_state_routine_rules(
			'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010',
			v_owner_actor, 'qorperaos/agents/alice/routines/bad-once-check.md',
			jsonb_set(v_parse_check, '{trigger}', jsonb_build_object('when', 'once', 'at', '2026-12-01T10:00:00Z', 'after', null)), false))
			-> 'problems' -> 0 ->> 'message' = 'checkBeforeWake is only supported on recurring scheduled routines',
		'routine_rules refuses checkBeforeWake on once/dynamic routine'
	);

	perform pg_temp.base_assert(
		(public.qorpera_company_state_routine_rules(
			'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010',
			v_owner_actor, 'qorperaos/agents/alice/routines/bad-repo.md',
			jsonb_set(v_parse_code, '{trigger,repo}', '"other/ungranted"'::jsonb), false)) -> 'problems' -> 0 ->> 'message'
		like 'this routine''s agent does not have access to repository%',
		'ungranted repo refused on code-change save'
	);

	v_parse_bad := jsonb_set(v_parse_app, '{checkBeforeWake}',
		jsonb_build_object('kind', 'http_probe', 'url', 'https://billing.example.test/health'));
	perform pg_temp.base_assert(
		(public.qorpera_company_state_routine_rules(
			'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010',
			v_owner_actor, 'qorperaos/agents/alice/routines/bad.md', v_parse_bad, false)) -> 'problems' -> 0 ->> 'message'
		= 'checkBeforeWake is only supported on recurring scheduled routines',
		'checkBeforeWake refused on listener routine'
	);

	perform pg_temp.base_claims('service_role');
	v_commit := pg_temp.base_commit(v_owner_actor, 'w6c-routines', jsonb_build_array(
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/agents/alice/routines/code-watch.md',
			'file', (pg_temp.base_seal(v_owner_actor, pg_temp.base_manifest(v_parse_code::text))) -> 'file',
			'structured', jsonb_build_array(pg_temp.c3_entry('QorperaOS/agents/alice/routines/code-watch.md', v_parse_code))),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/agents/alice/routines/app-watch.md',
			'file', (pg_temp.base_seal(v_owner_actor, pg_temp.base_manifest(v_parse_app::text))) -> 'file',
			'structured', jsonb_build_array(pg_temp.c3_entry('QorperaOS/agents/alice/routines/app-watch.md', v_parse_app))),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/agents/alice/routines/data-watch.md',
			'file', (pg_temp.base_seal(v_owner_actor, pg_temp.base_manifest(v_parse_data::text))) -> 'file',
			'structured', jsonb_build_array(pg_temp.c3_entry('QorperaOS/agents/alice/routines/data-watch.md', v_parse_data))),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/agents/alice/routines/data-watch-all.md',
			'file', (pg_temp.base_seal(v_owner_actor, pg_temp.base_manifest(v_parse_data_all::text))) -> 'file',
			'structured', jsonb_build_array(pg_temp.c3_entry('QorperaOS/agents/alice/routines/data-watch-all.md', v_parse_data_all))),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/agents/alice/routines/probe-watch.md',
			'file', (pg_temp.base_seal(v_owner_actor, pg_temp.base_manifest(v_parse_check::text))) -> 'file',
			'structured', jsonb_build_array(pg_temp.c3_entry('QorperaOS/agents/alice/routines/probe-watch.md', v_parse_check)))
	));
	perform pg_temp.base_assert(
		v_commit -> 'units' -> 0 ->> 'outcome' = 'saved'
		and v_commit -> 'units' -> 1 ->> 'outcome' = 'saved'
		and v_commit -> 'units' -> 2 ->> 'outcome' = 'saved'
		and v_commit -> 'units' -> 3 ->> 'outcome' = 'saved'
		and v_commit -> 'units' -> 4 ->> 'outcome' = 'saved',
		'all 5 routines saved: ' || v_commit::text
	);

	v_emit := public.qorpera_emit_code_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 'landed',
		jsonb_build_object('change', 'chg-skip', 'paths', jsonb_build_array('docs/README.md')));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 0, 'non-matching path skipped: ' || v_emit::text);

	v_emit := public.qorpera_emit_code_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 'landed',
		jsonb_build_object('change', 'chg-own-worker', 'mainBefore', repeat('1', 40), 'mainAfter', repeat('2', 40),
			'workerId', '13320000-0000-4000-8000-0000000000b1',
			'paths', jsonb_build_array('src/api/server.ts')));
	perform pg_temp.base_assert(
		(v_emit ->> 'wakes')::integer = 0 and (v_emit ->> 'skipped')::integer = 1,
		'agent own coding worker landing fenced by causal ancestry: ' || v_emit::text
	);

	v_emit := public.qorpera_emit_code_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 'landed',
		jsonb_build_object('change', 'chg-1', 'mainBefore', repeat('1', 40), 'mainAfter', repeat('2', 40),
			'workerId', '13320000-0000-4000-8000-0000000000b2',
			'paths', jsonb_build_array('src/api/server.ts'), 'checks', jsonb_build_object('passed', true)));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 1, 'code-change wake emitted: ' || v_emit::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_emit -> 'wakeIds' ->> 0)::uuid;
	perform pg_temp.base_assert(
		v_wake.source_kind = 'code-change'
		and v_wake.payload ->> 'schema' = 'qorpera.code-change-wake/v1'
		and v_wake.payload ->> 'change' = 'chg-1'
		and v_wake.payload ->> 'kind' = 'landed'
		and public.qorpera_folder_wake_authorized(v_wake),
		'code-change wake authorized and carries metadata'
	);

	v_emit := public.qorpera_emit_code_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 'landed',
		jsonb_build_object('change', 'chg-1', 'paths', jsonb_build_array('src/api/server.ts')));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 0, 'duplicate code-change deduped');

	v_emit := public.qorpera_emit_app_unhealthy_routine_wakes(
		p_environment_id => '92400000-0000-4000-8000-000000000020',
		p_site_id => v_site,
		p_event => jsonb_build_object('incidentKey', 'inc-1', 'status', 'crash_loop', 'restartCount', 5, 'error', 'ECONNREFUSED'));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 1, 'app-unhealthy wake emitted: ' || v_emit::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_emit -> 'wakeIds' ->> 0)::uuid;
	perform pg_temp.base_assert(
		v_wake.source_kind = 'app-unhealthy'
		and v_wake.source_id = v_site
		and v_wake.payload ->> 'slug' = 'billing-app'
		and (v_wake.payload ->> 'restartCount')::integer = 5
		and v_wake.payload ->> 'error' = 'ECONNREFUSED'
		and public.qorpera_folder_wake_authorized(v_wake),
		'app-unhealthy wake authorized and carries metadata'
	);
	v_emit := public.qorpera_emit_app_unhealthy_routine_wakes(
		p_environment_id => '92400000-0000-4000-8000-000000000020',
		p_site_id => v_site,
		p_event => jsonb_build_object('status', 'deploy_failed', 'restartCount', 0, 'error', 'APP_HOST_DEPLOY_FAILED_503'));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 1, 'executor-shape app-unhealthy payload wakes: ' || v_emit::text);

	v_emit := public.qorpera_emit_data_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'billing',
		jsonb_build_object('table', 'users', 'operation', 'insert', 'rowId', 'u-1'));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 0, 'wrong table skipped');

	v_emit := public.qorpera_emit_data_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'billing',
		jsonb_build_object('table', 'invoices', 'operation', 'delete', 'rowId', 'inv-1'));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 1, 'only unfiltered routine wakes on delete: ' || v_emit::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_emit -> 'wakeIds' ->> 0)::uuid;
	perform pg_temp.base_assert(v_wake.routine_id = v_r_data_all, 'insert-only routine skipped on delete');

	v_emit := public.qorpera_emit_data_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'billing',
		jsonb_build_object('eventKey', 'dc-1', 'table', 'invoices', 'operation', 'insert', 'rowId', 'inv-42'));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 2, 'both data-change routines wake on insert: ' || v_emit::text);
	select * into strict v_wake from public.qorpera_wake_occurrences
	where routine_id = v_r_data and source_kind = 'data-change';
	perform pg_temp.base_assert(
		v_wake.source_kind = 'data-change'
		and v_wake.payload ->> 'database' = 'billing'
		and v_wake.payload ->> 'table' = 'invoices'
		and v_wake.payload ->> 'operation' = 'insert'
		and v_wake.payload ->> 'rowId' = 'inv-42'
		and public.qorpera_folder_wake_authorized(v_wake),
		'data-change wake authorized and carries metadata'
	);

	v_emit := public.qorpera_emit_data_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'billing',
		jsonb_build_object('eventKey', 'dc-batch-1', 'tables', jsonb_build_array('invoices', 'orders')));
	perform pg_temp.base_assert((v_emit ->> 'wakes')::integer = 1, 'batched W6-B tables wakes only unfiltered routine: ' || v_emit::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_emit -> 'wakeIds' ->> 0)::uuid;
	perform pg_temp.base_assert(v_wake.routine_id = v_r_data_all, 'batched event without operation skips insert-only routine');

	set local session_replication_role = replica;
	insert into public.qorpera_execution_runs (
		id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, company_seq, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version,
		required_capability, job_type, payload_sha256, transcript_start_sequence,
		created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids
	)
	select
		'13320000-0000-4000-8000-000000000501', v_wake.profile_id, v_wake.environment_id, 'wake', v_wake.id,
		extensions.gen_random_uuid(), r.substrate_version_id, r.company_snapshot_id, r.company_seq,
		v_wake.staff_agent_id, v_wake.staff_version, v_wake.sponsor_binding_id, v_wake.sponsor_version,
		r.required_capability, r.job_type, r.payload_sha256, 0,
		v_wake.requested_by_user_id, v_wake.requested_by_user_id, r.model_provider, r.model_id, r.model_selection,
		r.audience_kind, r.runtime_bundle_id, r.runtime_bundle_sha256, '{}'::uuid[]
	from public.qorpera_execution_runs r
	where r.profile_id = v_wake.profile_id
	limit 1;
	update public.qorpera_wake_occurrences set status = 'materialized', run_id = '13320000-0000-4000-8000-000000000501' where id = v_wake.id;
	set local session_replication_role = origin;
	v_emit := public.qorpera_emit_data_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'billing',
		jsonb_build_object('eventKey', 'dc-self-loop', 'table', 'invoices', 'operation', 'insert', 'rowId', 'inv-loop'),
		'13320000-0000-4000-8000-000000000501'::uuid);
	perform pg_temp.base_assert(
		(v_emit ->> 'wakes')::integer = 0 and (v_emit ->> 'skipped')::integer = 2,
		'data-change self-loop fenced by causal ancestry: ' || v_emit::text
	);

	v_emit := public.qorpera_emit_code_change_routine_wakes(
		'92400000-0000-4000-8000-000000000020', 'Qorpera', 'Qorpera_Base', 'landed',
		jsonb_build_object('change', 'chg-self-loop', 'paths', jsonb_build_array('src/api/server.ts'),
			'parentRunId', '13320000-0000-4000-8000-000000000501'));
	perform pg_temp.base_assert(
		(v_emit ->> 'wakes')::integer = 0 and (v_emit ->> 'skipped')::integer = 1,
		'code-change self-loop fenced by causal ancestry: ' || v_emit::text
	);

	v_chk := public.qorpera_record_routine_check_result(v_r_check, true, 'HTTP 200 OK');
	perform pg_temp.base_assert(not (v_chk ->> 'shouldWake')::boolean and not (v_chk ->> 'stateChanged')::boolean,
		'first healthy check does not wake: ' || v_chk::text);
	v_chk := public.qorpera_record_routine_check_result(v_r_check, true, 'HTTP 200 OK');
	perform pg_temp.base_assert(not (v_chk ->> 'shouldWake')::boolean, 'second healthy check does not wake');
	v_chk := public.qorpera_record_routine_check_result(v_r_check, false, 'HTTP 503', 'upstream timeout');
	perform pg_temp.base_assert((v_chk ->> 'shouldWake')::boolean and (v_chk ->> 'stateChanged')::boolean
		and (v_chk ->> 'consecutiveFailures')::integer = 1, 'first failure wakes: ' || v_chk::text);
	v_chk := public.qorpera_record_routine_check_result(v_r_check, false, 'HTTP 503', 'still down');
	perform pg_temp.base_assert((v_chk ->> 'shouldWake')::boolean and not (v_chk ->> 'stateChanged')::boolean
		and (v_chk ->> 'consecutiveFailures')::integer = 2, 'consecutive failure wakes');
	v_chk := public.qorpera_record_routine_check_result(v_r_check, true, 'HTTP 200 OK');
	perform pg_temp.base_assert((v_chk ->> 'shouldWake')::boolean and (v_chk ->> 'stateChanged')::boolean
		and (v_chk ->> 'consecutiveFailures')::integer = 0, 'recovery wakes once');
	v_chk := public.qorpera_record_routine_check_result(v_r_check, true, 'HTTP 200 OK');
	perform pg_temp.base_assert(not (v_chk ->> 'shouldWake')::boolean and not (v_chk ->> 'stateChanged')::boolean,
		'post-recovery healthy check stays quiet');

	v_chk := public.qorpera_skip_checked_routine_wake(
		v_r_check, 1, 'file',
		clock_timestamp(), null, clock_timestamp() + interval '15 minutes',
		true, 'HTTP 200 OK', null
	);
	perform pg_temp.base_assert(
		v_chk ->> 'status' = 'skipped' and not (v_chk ->> 'shouldWake')::boolean,
		'skip_checked_routine_wake advances healthy schedule without wake: ' || v_chk::text
	);
	v_chk := public.qorpera_skip_checked_routine_wake(
		v_r_check, 1, 'file',
		clock_timestamp() + interval '15 minutes',
		(select last_scheduled_for from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_r_check and trigger_id = 'file'),
		clock_timestamp() + interval '30 minutes',
		false, 'HTTP 503', 'backend unhealthy'
	);
	perform pg_temp.base_assert(
		v_chk ->> 'status' = 'wake_required' and (v_chk ->> 'shouldWake')::boolean,
		'skip_checked_routine_wake signals wake_required on failure: ' || v_chk::text
	);

	v_chk := public.qorpera_read_routine_code_checks(v_r_check, 'qorpera/qorpera_base');
	perform pg_temp.base_assert((v_chk ->> 'ok')::boolean, 'code_checks clean when no failed changes: ' || v_chk::text);
end $$;

do $$
declare
	v_plan_conn uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	v_other_binding uuid := '13320000-0000-4000-8000-000000000202';
	v_problem text;
begin
	set local session_replication_role = replica;
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider,
		native_harness, current_version, access_issued_at, access_expires_at, login_kind)
	select '13320000-0000-4000-8000-0000000002e1', '92400000-0000-4000-8000-000000000010',
		(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, v.credential_capsule_id,
		'13320000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '1 hour',
		'chatgpt_plan'
	from public.qorpera_provider_connection_versions v
	where v.connection_id = v_plan_conn and v.version = 2;
	set local session_replication_role = origin;

	v_problem := public.qorpera_coding_owner_problem(
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'codex', v_other_binding);
	perform pg_temp.base_assert(
		v_problem = 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it',
		'ChatGPT plan coding dispatch invariant preserved: ' || coalesce(v_problem, 'null')
	);
end $$;

rollback;
