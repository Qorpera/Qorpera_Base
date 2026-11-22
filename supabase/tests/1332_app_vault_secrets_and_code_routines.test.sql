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
	v_list jsonb;
	v_auth jsonb;
begin
	perform pg_temp.t1332_secret(v_sec_build, null, 'build_cache_token', 'build_token_secret_1332');
	insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values (v_site, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'billing-app', 'Billing App', 'apps/billing', '92400000-0000-4000-8000-000000000030');

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
		not has_function_privilege('authenticated', 'public.qorpera_authorize_app_secrets(uuid,text,uuid,text,text)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_authorize_app_secrets(uuid,text,uuid,text,text)', 'execute')
		and has_function_privilege('qorpera_secret_broker', 'public.qorpera_authorize_app_secrets(uuid,text,uuid,text,text)', 'execute'),
		'authorize_app_secrets is broker-only'
	);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'runtime', 'prod'));
	perform pg_temp.base_assert(v_res like 'ok:%', 'broker runtime prod: ' || v_res);
	v_auth := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(
		jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth -> 'secrets' -> 0 ->> 'name' = 'OPENAI_API_KEY'
		and v_auth -> 'secrets' -> 0 ->> 'scope' = 'runtime'
		and v_auth -> 'secrets' -> 0 ->> 'targetEnv' = 'prod',
		'runtime prod returns only OPENAI_API_KEY: ' || v_auth::text
	);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'build', 'prod'));
	v_auth := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(
		jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth -> 'secrets' -> 0 ->> 'name' = 'BUILD_CACHE_TOKEN',
		'build prod returns only BUILD_CACHE_TOKEN: ' || v_auth::text
	);

	v_res := pg_temp.t1332_as_broker(format('select public.qorpera_authorize_app_secrets(%L, %L, %L, %L, %L)',
		'13320000-0000-4000-8000-000000000040', repeat('a', 64), v_site, 'runtime', 'dev'));
	v_auth := substring(v_res from 4)::jsonb;
	perform pg_temp.base_assert(
		jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth -> 'secrets' -> 0 ->> 'name' = 'ANTHROPIC_API_KEY',
		'runtime dev returns only ANTHROPIC_API_KEY: ' || v_auth::text
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

	v_parse_bad := jsonb_set(v_parse_app, '{checkBeforeWake}',
		jsonb_build_object('kind', 'http_probe', 'url', 'https://billing.example.test/health'));
	perform pg_temp.base_assert(
		(public.qorpera_company_state_routine_rules(
			'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000010',
			v_owner_actor, 'qorperaos/agents/alice/routines/bad.md', v_parse_bad, false)) -> 'problems' -> 0 ->> 'message'
		= 'checkBeforeWake is only supported on scheduled or dynamic routines',
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
		jsonb_build_object('change', 'chg-1', 'mainBefore', repeat('1', 40), 'mainAfter', repeat('2', 40),
			'workerId', '13320000-0000-4000-8000-0000000000b1',
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
		'92400000-0000-4000-8000-000000000020', v_site,
		jsonb_build_object('incidentKey', 'inc-1', 'status', 'crash_loop', 'restartCount', 5, 'error', 'ECONNREFUSED'));
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
end $$;

do $$
declare
	v_plan_conn uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	v_other_binding uuid := '13320000-0000-4000-8000-000000000202';
	v_res text;
	v_problem text;
	v_payer record;
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

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000002',
		format('select public.qorpera_set_routine_coding_dispatch(%L, %L, true)',
			'92400000-0000-4000-8000-000000000010', v_plan_conn));
	perform pg_temp.base_assert(v_res = '42501:routine coding dispatch consent requires the connection owner',
		'non-owner refused: ' || v_res);

	v_problem := public.qorpera_coding_owner_problem(
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'codex', v_other_binding);
	perform pg_temp.base_assert(
		v_problem = 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it',
		'default lockout still active: ' || coalesce(v_problem, 'null')
	);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_set_routine_coding_dispatch(%L, %L, true)',
			'92400000-0000-4000-8000-000000000010', v_plan_conn));
	perform pg_temp.base_assert(
		v_res like 'ok:%'
		and (substring(v_res from 4)::jsonb ->> 'allow_routine_coding_dispatch')::boolean
		and (substring(v_res from 4)::jsonb ->> 'changed')::boolean,
		'owner opts in to routine coding dispatch: ' || v_res
	);

	v_problem := public.qorpera_coding_owner_problem(
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'codex', v_other_binding);
	perform pg_temp.base_assert(v_problem is null, 'opt-in lifts lockout: ' || coalesce(v_problem, 'null'));

	select * into v_payer from public.qorpera_coding_owner_payer(
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001', 'codex', v_other_binding);
	perform pg_temp.base_assert(v_payer.binding_id is not null, 'payer resolves with opt-in');

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_consent_provider_connection_autonomous(%L, %L, false)',
			'92400000-0000-4000-8000-000000000010', v_plan_conn));
	perform pg_temp.base_assert(v_res like 'ok:%', 'turning off allow_autonomous resets routine coding dispatch cleanly: ' || v_res);

	perform pg_temp.base_assert(
		not (select allow_routine_coding_dispatch from public.qorpera_provider_connection_versions
			where connection_id = v_plan_conn order by version desc limit 1),
		'allow_routine_coding_dispatch reset to false when allow_autonomous withdrawn'
	);

	v_res := pg_temp.t1332_as_member('92400000-0000-4000-8000-000000000001',
		format('select public.qorpera_set_routine_coding_dispatch(%L, %L, true)',
			'92400000-0000-4000-8000-000000000010', v_plan_conn));
	perform pg_temp.base_assert(
		v_res = '55000:Turn on background work for this login before allowing routine coding dispatch',
		'requires allow_autonomous first: ' || v_res
	);
end $$;

rollback;
