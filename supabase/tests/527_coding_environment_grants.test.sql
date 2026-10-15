-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- F3 step 5j-1 (migration 20260930438000): environment secrets and their repository grants, on 924's folder-v2 company.
-- The secret rows stand in for completed captures (sealed version 1 by the company's broker).
-- 1. The names: which variable names an environment secret may have; a capture under any other is refused (22023)
--    before anything is written, for the company and for a member alike, while another connector's secret keeps any
--    name.
-- 2. Grants: an owner or administrator gives a company environment secret to one repository (owner/name, kept in lower
--    case); giving it again returns the same grant; everyone else, a malformed repository and any other secret are
--    refused. The members' list shows names, owners and live grants, never a value.
-- 3. Withdrawal by an owner or administrator; a withdrawn grant stays withdrawn.
-- 4. The issuer's demotion and removal end its grants for good: a later promotion revives none.
-- 5. Disconnect ends the secret's grants with the secret; a used environment secret always names its coding worker.
-- 6. The bodies: each patched function names the migration, and the locks keep rank 8's order.
-- The broker's read is 528's, and its races 529's.

insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('52700000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));

-- A sealed secret: the company's when p_owner is null, else that member's.
create function pg_temp.env_secret(p_n text, p_owner uuid, p_connector text, p_name text) returns void
language sql as $$
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
	values (('52700000-0000-4000-8000-0000000000' || p_n)::uuid, '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '52700000-0000-4000-8000-000000000040',
		case when p_owner is null then 'company' else 'member' end, p_owner, p_connector, p_name, 'Secret ' || p_n, 1,
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (('52700000-0000-4000-8000-0000000000' || p_n)::uuid, 1, '52700000-0000-4000-8000-000000000040',
		'company-kek-1', convert_to('sealed ' || p_n, 'UTF8'),
		encode(extensions.digest(convert_to('sealed ' || p_n, 'UTF8'), 'sha256'), 'hex'),
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
$$;
select pg_temp.env_secret('71', null, 'environment', 'npm_token') \g /dev/null
select pg_temp.env_secret('72', null, 'environment', 'sentry_dsn') \g /dev/null
select pg_temp.env_secret('73', null, 'gmail', 'notes') \g /dev/null
select pg_temp.env_secret('74', '92400000-0000-4000-8000-000000000001', 'environment', 'npm_token') \g /dev/null
-- A name no capture gives (written directly): no grant may serve it.
select pg_temp.env_secret('75', null, 'environment', 'path') \g /dev/null
select pg_temp.env_secret('76', null, 'environment', 'deploy_key') \g /dev/null

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.env_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.env_try(text) to authenticated;
create function pg_temp.env_answer(p_result text) returns jsonb language sql as $$
	select case when p_result like 'ok:%' then substring(p_result from 4)::jsonb end
$$;
create function pg_temp.env_member(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.env_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.env_capture(p_user uuid, p_owner_kind text, p_connector text, p_name text) returns text
language sql as $$
	select pg_temp.env_member(p_user, format(
		'select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, %L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_owner_kind,
		case when p_owner_kind = 'member' then p_user end, p_connector, p_name, 'A coding variable'))
$$;
create function pg_temp.env_grant(p_user uuid, p_secret uuid, p_repository text) returns text language sql as $$
	select pg_temp.env_member(p_user, format('select public.qorpera_grant_coding_environment_secret(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', p_secret, p_repository))
$$;
create function pg_temp.env_withdraw(p_user uuid, p_grant uuid) returns text language sql as $$
	select pg_temp.env_member(p_user, format('select public.qorpera_revoke_coding_environment_grant(%L, %L)',
		'92400000-0000-4000-8000-000000000010', p_grant))
$$;
-- The list as one line: NAME/owner[repositories] per entry, in the list's order.
create function pg_temp.env_list(p_user uuid) returns text language plpgsql as $$
declare v_result text := pg_temp.env_member(p_user, format('select public.qorpera_list_coding_environment(%L, %L)',
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020'));
begin
	if v_result not like 'ok:%' then return v_result; end if;
	return coalesce((select string_agg(format('%s/%s[%s]', e ->> 'name', e ->> 'ownerKind',
			(select coalesce(string_agg(g ->> 'repository', ',' order by o), '')
			from jsonb_array_elements(e -> 'grants') with ordinality as x(g, o))), ' ' order by n)
		from jsonb_array_elements(pg_temp.env_answer(v_result)) with ordinality as l(e, n)), '');
end $$;
create function pg_temp.env_audits(p_type text, p_grant uuid default null) returns bigint language sql as $$
	select count(*) from public.qorpera_cloud_secret_audit_events
	where profile_id = '92400000-0000-4000-8000-000000000010' and event_type = p_type
		and (p_grant is null or grant_id = p_grant)
$$;
create function pg_temp.env_status(p_grant uuid) returns text language sql as $$
	select status || '/' || coalesce(revoked_by_user_id::text, '-') from public.qorpera_coding_environment_grants
	where id = p_grant
$$;

-- 1. The names -------------------------------------------------------------------------------------------------------
do $$
declare
	v_name text;
	v_result text;
	v_role text;
	v_refused text := '22023:That name is not available for an environment variable';
begin
	foreach v_name in array array['npm_token', 'sentry_dsn', 'a', 'node_env', 'github_token', 'dockerhub_token', 'lcd',
		'database_url', 'x' || repeat('1', 63)] loop
		perform pg_temp.base_assert(public.qorpera_coding_environment_name_allowed(v_name), 'allowed: ' || v_name);
	end loop;
	-- What the machine sets itself, a harness's login or provider, and what is not a lower-case variable name.
	foreach v_name in array array['home', 'path', 'tmpdir', 'user', 'shell', 'pwd', 'lang', 'tz', 'bash_env', 'ifs',
		'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'ssl_cert_file', 'node_extra_ca_certs', 'lc_all', 'git_dir',
		'ld_preload', 'dyld_insert_libraries', 'ssh_auth_sock', 'xdg_config_home', 'docker_host', 'qorpera_token',
		'anthropic_api_key', 'claude_code_oauth_token', 'codex_home', 'openai_api_key', 'NPM_TOKEN', 'npm-token', '1abc',
		'_x', '', 'x' || repeat('1', 64)] loop
		perform pg_temp.base_assert(not public.qorpera_coding_environment_name_allowed(v_name), 'refused: ' || v_name);
	end loop;
	perform pg_temp.base_assert(not public.qorpera_coding_environment_name_allowed(null), 'refused: null');
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role,
				'public.qorpera_coding_environment_name_allowed(text)', 'execute')
			and not has_function_privilege(v_role,
				'public.qorpera_revoke_coding_environment_grants_on_membership_change()', 'execute')
			and not has_table_privilege(v_role, 'public.qorpera_coding_environment_grants', 'select'),
			'the helpers and the table are the database''s own: ' || v_role);
	end loop;

	-- A capture under a refused name: the company's (the owner) and a member's own (the contributor); nothing written.
	v_result := pg_temp.env_capture('92400000-0000-4000-8000-000000000001', 'company', 'environment', 'ld_preload');
	perform pg_temp.base_assert(v_result = v_refused, 'the company''s ld_preload: ' || v_result);
	v_result := pg_temp.env_capture('92400000-0000-4000-8000-000000000002', 'member', 'environment', 'home');
	perform pg_temp.base_assert(v_result = v_refused, 'the member''s home: ' || v_result);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_cloud_secret_capture_tickets
		where profile_id = '92400000-0000-4000-8000-000000000010' and secret_name in ('ld_preload', 'home')),
		'a refused capture writes no ticket');
	-- Controls: an allowed name for the environment, and a Gmail secret named home.
	v_result := pg_temp.env_capture('92400000-0000-4000-8000-000000000001', 'company', 'environment', 'deploy_token');
	perform pg_temp.base_assert(pg_temp.env_answer(v_result) ->> 'schema' = 'qorpera.cloud-secret-capture/v1',
		'the company''s deploy_token: ' || v_result);
	v_result := pg_temp.env_capture('92400000-0000-4000-8000-000000000002', 'member', 'gmail', 'home');
	perform pg_temp.base_assert(pg_temp.env_answer(v_result) ->> 'schema' = 'qorpera.cloud-secret-capture/v1',
		'the member''s Gmail home: ' || v_result);
end $$;

-- 2. Grants ----------------------------------------------------------------------------------------------------------
do $$
declare
	v_result text;
	v_grant jsonb;
	v_again jsonb;
	v_user uuid;
	v_repository text;
	v_secret uuid;
	v_denied text := '42501:coding environment grants need an owner or administrator';
begin
	-- The owner gives npm_token to Qorpera/Qorpera_Base: kept in lower case, with one audit row.
	v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52700000-0000-4000-8000-000000000071',
		'Qorpera/Qorpera_Base');
	v_grant := pg_temp.env_answer(v_result);
	perform pg_temp.base_assert(v_grant ->> 'schema' = 'qorpera.coding-environment-grant/v1'
		and v_grant ->> 'secretId' = '52700000-0000-4000-8000-000000000071'
		and v_grant ->> 'repository' = 'qorpera/qorpera_base'
		and v_grant ->> 'issuedByUserId' = '92400000-0000-4000-8000-000000000001'
		and v_grant ->> 'status' = 'active' and v_grant ? 'createdAt', 'the owner''s grant: ' || v_result);
	perform set_config('qorpera_test.env_owner_grant', v_grant ->> 'grantId', true);
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
		where grant_id = (v_grant ->> 'grantId')::uuid and event_type = 'environment_grant_issued'
			and secret_id = '52700000-0000-4000-8000-000000000071' and secret_version = 1
			and actor_user_id = '92400000-0000-4000-8000-000000000001' and connector_id = 'environment'
			and coding_worker_id is null) = 1, 'the grant''s audit row');
	-- Giving it again, in any case, returns the live grant and writes nothing.
	v_again := pg_temp.env_answer(pg_temp.env_grant('92400000-0000-4000-8000-000000000001',
		'52700000-0000-4000-8000-000000000071', 'qorpera/qorpera_base'));
	perform pg_temp.base_assert(v_again = v_grant, 'the same grant again: ' || coalesce(v_again::text, 'none'));
	perform pg_temp.base_assert(pg_temp.env_audits('environment_grant_issued') = 1, 'no second audit row');

	-- The administrator gives sentry_dsn to the same repository and npm_token to another.
	v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000004', '52700000-0000-4000-8000-000000000072',
		'Qorpera/Qorpera_Base');
	perform pg_temp.base_assert(
		pg_temp.env_answer(v_result) ->> 'issuedByUserId' = '92400000-0000-4000-8000-000000000004',
		'the administrator''s sentry_dsn grant: ' || v_result);
	perform set_config('qorpera_test.env_admin_sentry', pg_temp.env_answer(v_result) ->> 'grantId', true);
	v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000004', '52700000-0000-4000-8000-000000000071',
		'qorpera/other-repo');
	perform pg_temp.base_assert(pg_temp.env_answer(v_result) ->> 'repository' = 'qorpera/other-repo',
		'the administrator''s npm_token grant: ' || v_result);
	perform set_config('qorpera_test.env_admin_npm', pg_temp.env_answer(v_result) ->> 'grantId', true);

	-- The contributor, the viewer and the outsider may not give one.
	foreach v_user in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000005']::uuid[] loop
		v_result := pg_temp.env_grant(v_user, '52700000-0000-4000-8000-000000000076', 'qorpera/qorpera_base');
		perform pg_temp.base_assert(v_result = v_denied, v_user || ' gives a grant: ' || v_result);
	end loop;
	-- A repository is owner/name, nothing else.
	foreach v_repository in array array['qorpera', 'qorpera/qorpera_base/extra', 'https://github.com/qorpera/x',
		'-bad/x', 'qorpera/', '/x', 'qor pera/x', ''] loop
		v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52700000-0000-4000-8000-000000000076',
			v_repository);
		perform pg_temp.base_assert(v_result = '22023:A repository is named owner/name',
			'repository ' || quote_literal(v_repository) || ': ' || v_result);
	end loop;
	v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52700000-0000-4000-8000-000000000076', null);
	perform pg_temp.base_assert(v_result = '22023:A repository is named owner/name', 'no repository: ' || v_result);
	-- Only a company environment secret under an allowed name: not a Gmail secret, a member's, PATH, or none.
	foreach v_secret in array array['52700000-0000-4000-8000-000000000073', '52700000-0000-4000-8000-000000000074',
		'52700000-0000-4000-8000-000000000075', '52700000-0000-4000-8000-0000000000ff']::uuid[] loop
		v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000001', v_secret, 'qorpera/qorpera_base');
		perform pg_temp.base_assert(v_result = '42501:company environment secret is unavailable',
			'secret ' || v_secret || ': ' || v_result);
	end loop;
	perform pg_temp.base_assert((select count(*) from public.qorpera_coding_environment_grants) = 3
		and pg_temp.env_audits('environment_grant_issued') = 3, 'only the three grants were written');

	-- The list: the company's environment secrets and the caller's own, with their live grants; never a value.
	v_result := pg_temp.env_list('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(v_result = 'DEPLOY_KEY/company[] '
		'NPM_TOKEN/company[qorpera/other-repo,qorpera/qorpera_base] NPM_TOKEN/member[] PATH/company[] '
		'SENTRY_DSN/company[qorpera/qorpera_base]', 'the owner''s list: ' || v_result);
	v_result := pg_temp.env_list('92400000-0000-4000-8000-000000000003');
	perform pg_temp.base_assert(v_result = 'DEPLOY_KEY/company[] '
		'NPM_TOKEN/company[qorpera/other-repo,qorpera/qorpera_base] PATH/company[] '
		'SENTRY_DSN/company[qorpera/qorpera_base]', 'the viewer''s list: ' || v_result);
	v_result := pg_temp.env_list('92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_assert(v_result = '', 'the outsider''s list: ' || v_result);
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_list_coding_environment(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020'));
	perform pg_temp.base_assert((select bool_and(array(select jsonb_object_keys(e) order by 1)
			= array['createdAt', 'grants', 'name', 'ownerKind', 'purpose', 'schema', 'secretId', 'updatedAt', 'version'])
			and bool_and(e ->> 'schema' = 'qorpera.coding-environment-secret/v1')
		from jsonb_array_elements(pg_temp.env_answer(v_result)) as e), 'the entries'' keys: ' || v_result);
	perform pg_temp.base_assert((select bool_and(array(select jsonb_object_keys(g) order by 1)
			= array['createdAt', 'grantId', 'issuedByUserId', 'repository'])
		from jsonb_array_elements(pg_temp.env_answer(v_result)) as e, jsonb_array_elements(e -> 'grants') as g),
		'the grants'' keys: ' || v_result);
end $$;

-- 3. Withdrawal ------------------------------------------------------------------------------------------------------
do $$
declare
	v_grant uuid := current_setting('qorpera_test.env_admin_sentry')::uuid;
	v_result text;
begin
	v_result := pg_temp.env_withdraw('92400000-0000-4000-8000-000000000002', v_grant);
	perform pg_temp.base_assert(v_result = '42501:coding environment grants need an owner or administrator',
		'the contributor withdraws: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_status(v_grant) = 'active/-', 'still live');
	v_result := pg_temp.env_withdraw('92400000-0000-4000-8000-000000000001', v_grant);
	perform pg_temp.base_assert(pg_temp.env_answer(v_result) ->> 'status' = 'revoked'
		and pg_temp.env_answer(v_result) ->> 'grantId' = v_grant::text, 'the owner withdraws: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_status(v_grant) = 'revoked/92400000-0000-4000-8000-000000000001',
		'withdrawn by the owner: ' || pg_temp.env_status(v_grant));
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
		where grant_id = v_grant and event_type = 'environment_grant_revoked'
			and actor_user_id = '92400000-0000-4000-8000-000000000001'
			and secret_id = '52700000-0000-4000-8000-000000000072' and connector_id = 'environment') = 1,
		'the withdrawal''s audit row');
	-- Again: the same answer, nothing more written.
	v_result := pg_temp.env_withdraw('92400000-0000-4000-8000-000000000004', v_grant);
	perform pg_temp.base_assert(pg_temp.env_answer(v_result) ->> 'status' = 'revoked', 'withdrawn again: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_audits('environment_grant_revoked') = 1, 'one revocation row');
	v_result := pg_temp.env_withdraw('92400000-0000-4000-8000-000000000001', '52700000-0000-4000-8000-0000000000ff');
	perform pg_temp.base_assert(v_result = '42501:coding environment grant is unavailable',
		'no such grant: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_list('92400000-0000-4000-8000-000000000003') like '%SENTRY_DSN/company[]',
		'the list drops the withdrawn grant');
end $$;

-- 4. The issuer's demotion and removal -------------------------------------------------------------------------------
do $$
declare
	v_owner_grant uuid := current_setting('qorpera_test.env_owner_grant')::uuid;
	v_admin_npm uuid := current_setting('qorpera_test.env_admin_npm')::uuid;
	v_regrant uuid;
	v_result text;
begin
	-- The owner makes the administrator a contributor: the administrator's live grant ends, the owner's stays.
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'contributor'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the demotion: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_status(v_admin_npm) = 'revoked/92400000-0000-4000-8000-000000000001',
		'the demoted administrator''s grant: ' || pg_temp.env_status(v_admin_npm));
	perform pg_temp.base_assert(pg_temp.env_audits('environment_grant_revoked', v_admin_npm) = 1
		and (select actor_user_id from public.qorpera_cloud_secret_audit_events
			where grant_id = v_admin_npm and event_type = 'environment_grant_revoked')
			= '92400000-0000-4000-8000-000000000001', 'the demotion''s audit row names the owner');
	perform pg_temp.base_assert(pg_temp.env_status(v_owner_grant) = 'active/-', 'the owner''s grant stays');
	-- Made an administrator again: nothing revives.
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'admin'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the promotion: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_status(v_admin_npm) like 'revoked/%', 'a promotion revives nothing');
	-- A new grant is a new one; the administrator's removal ends it.
	v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000004', '52700000-0000-4000-8000-000000000071',
		'qorpera/other-repo');
	v_regrant := (pg_temp.env_answer(v_result) ->> 'grantId')::uuid;
	perform pg_temp.base_assert(v_regrant is not null and v_regrant <> v_admin_npm, 'a new grant: ' || v_result);
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_remove_profile_member(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the removal: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_status(v_regrant) = 'revoked/92400000-0000-4000-8000-000000000001'
		and pg_temp.env_audits('environment_grant_revoked', v_regrant) = 1, 'the removed administrator''s grant');
	perform pg_temp.base_assert(pg_temp.env_status(v_owner_grant) = 'active/-', 'the owner''s grant still stays');
end $$;

-- 5. Disconnect ------------------------------------------------------------------------------------------------------
do $$
declare
	v_owner_grant uuid := current_setting('qorpera_test.env_owner_grant')::uuid;
	v_revoked bigint := pg_temp.env_audits('environment_grant_revoked');
	v_result text;
begin
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_revoke_cloud_secret(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'52700000-0000-4000-8000-000000000071'));
	perform pg_temp.base_assert(pg_temp.env_answer(v_result) ->> 'status' = 'revoked', 'Disconnect: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_status(v_owner_grant) = 'revoked/92400000-0000-4000-8000-000000000001',
		'the grant ends with its secret: ' || pg_temp.env_status(v_owner_grant));
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_coding_environment_grants
		where secret_id = '52700000-0000-4000-8000-000000000071' and status = 'active'), 'no grant of it is live');
	perform pg_temp.base_assert(pg_temp.env_audits('environment_grant_revoked') = v_revoked
		and (select count(*) from public.qorpera_cloud_secret_audit_events
			where secret_id = '52700000-0000-4000-8000-000000000071' and event_type = 'secret_revoked') = 1,
		'Disconnect is recorded as the secret''s revocation');
	v_result := pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52700000-0000-4000-8000-000000000071',
		'qorpera/qorpera_base');
	perform pg_temp.base_assert(v_result = '42501:company environment secret is unavailable',
		'a disconnected secret is given to no repository: ' || v_result);
	-- A used environment secret names its coding worker; no other environment event does.
	perform pg_temp.base_error($q$insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id,
		secret_id, secret_version, event_type, connector_id) values ('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '52700000-0000-4000-8000-000000000072', 1, 'environment_secret_used',
		'environment')$q$, '23514', 'new row for relation "qorpera_cloud_secret_audit_events" violates check constraint '
		'"qorpera_cloud_secret_audit_events_coding_worker"');
	perform pg_temp.base_error($q$insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id,
		secret_id, secret_version, event_type, connector_id, coding_worker_id) values (
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'52700000-0000-4000-8000-000000000072', 1, 'environment_grant_issued', 'environment',
		'52700000-0000-4000-8000-0000000000ee')$q$, '23514', 'new row for relation "qorpera_cloud_secret_audit_events" '
		'violates check constraint "qorpera_cloud_secret_audit_events_coding_worker"');
end $$;

-- 6. The bodies ------------------------------------------------------------------------------------------------------
do $$
declare
	v_begin text := pg_get_functiondef(
		'public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure);
	v_revoke text := pg_get_functiondef('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure);
	v_enter text := pg_get_functiondef('public.qorpera_folder_member_change_enter(uuid,uuid,text)'::regprocedure);
	v_broker text := pg_get_functiondef(
		'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure);
	v_names integer := position('qorpera_coding_environment_name_allowed' in v_begin);
	v_lock integer;
begin
	perform pg_temp.base_assert(position('20260930438000' in v_begin) > 0 and position('20260930438000' in v_revoke) > 0
		and position('20260930438000' in v_enter) > 0, 'each patched body names the migration');
	-- The capture refuses a name before any lock.
	select min(nullif(position(l in v_begin), 0)) into v_lock
	from unnest(array[' for share', ' for key share', ' for update', ' for no key update']) as l;
	perform pg_temp.base_assert(v_names > position('event_hook' in v_begin) and v_names < v_lock,
		'the capture''s name check comes before its locks');
	-- Rank 8: the operation grants, the repository grants, then the member's secrets.
	perform pg_temp.base_assert(position('order by grant_row.id for no key update' in v_enter)
			< position('qorpera_coding_environment_grants' in v_enter)
		and position('qorpera_coding_environment_grants' in v_enter)
			< position('perform 1 from public.qorpera_cloud_secrets where profile_id = p_profile_id' in v_enter)
		and position('order by grant_row.id for no key update' in v_enter) > 0, 'rank 8''s order');
	-- Disconnect: the repository grants before the secret; one created meanwhile NOWAIT, after the operation grants.
	perform pg_temp.base_assert(position('qorpera_coding_environment_grants' in v_revoke)
			< position('select secret.* into v_secret' in v_revoke)
		and position('order by environment_grant.id for update nowait' in v_revoke)
			> position('update public.qorpera_cloud_secret_operation_grants' in v_revoke)
		and position('update public.qorpera_cloud_secret_operation_grants' in v_revoke) > 0, 'Disconnect''s order');
	-- The broker only reads: it shares the repository's grants, then the secrets and their versions, and updates
	-- nothing (529 races it).
	perform pg_temp.base_assert(position('order by environment_grant.id for share' in v_broker) > 0
		and position('order by environment_grant.id for share' in v_broker) < position('for share of secret' in v_broker)
		and position('for update' in v_broker) = 0 and position('for no key update' in v_broker) = 0,
		'the broker''s read shares the grants before the secrets, and takes share locks only');
end $$;

rollback;
