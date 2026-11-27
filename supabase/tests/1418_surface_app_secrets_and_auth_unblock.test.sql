-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create or replace function pg_temp.sasa_assert(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
	if not coalesce(p_ok, false) then
		raise exception '1418_surface_app_secrets_and_auth_unblock failed: %', p_msg;
	end if;
end $$;

create or replace function pg_temp.sasa_as(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create or replace function pg_temp.sasa_service(p_sql text)
returns jsonb language plpgsql as $$
declare
	v_res jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_res;
	reset role;
	return v_res;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_member constant uuid := '14180000-0000-4000-8000-000000000002';
	v_outsider constant uuid := '14180000-0000-4000-8000-000000000003';
	v_broker_id constant uuid := '14180000-0000-4000-8000-000000000004';
	v_secret_id constant uuid := '14180000-0000-4000-8000-000000000005';
	v_env_id uuid;
	v_surface_static uuid;
	v_surface_server uuid;
	v_site_static public.qorpera_company_sites%rowtype;
	v_site_server public.qorpera_company_sites%rowtype;
	v_manifest jsonb;
	v_dep_static uuid;
	v_dep_server uuid;
	v_dom_pending uuid;
	v_dom_verified_1 uuid;
	v_dom_verified_2 uuid;
	v_cfg jsonb;
	v_svc_cfg jsonb;
	v_snapshot jsonb;
	v_grant jsonb;
	v_grant_id uuid;
	v_auth jsonb;
	v_broker_cap constant text := repeat('a', 64);
	v_machine_sha constant text := repeat('b', 64);
	v_img constant text := '127.0.0.1:5000/qorpera-apps/demo@sha256:' || repeat('7', 64);
begin
	perform pg_temp.sasa_assert(
		has_function_privilege('authenticated', 'public.qorpera_get_surface_app_runtime_config(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_get_surface_app_runtime_config(uuid)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_set_surface_app_runtime_config(uuid,jsonb,text)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_set_surface_app_runtime_config(uuid,jsonb,text)', 'EXECUTE')
		and has_function_privilege('service_role', 'public.qorpera_surface_site_runtime_config(uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_site_runtime_config(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_surface_site_runtime_config(uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_site_credential_inputs_blocked(uuid,text,boolean)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_site_credential_inputs_blocked(uuid,text,boolean)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_site_has_runtime_secrets(uuid,uuid,text)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_site_has_runtime_secrets(uuid,uuid,text)', 'EXECUTE'),
		'function privileges match security posture'
	);

	update public.qorpera_site_settings
	set enabled = true, public_enabled = true, domains_enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true;
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select environment_id into strict v_env_id from public.qorpera_company_cofounders where profile_id = v_company;

	insert into auth.users(id, email) values
		(v_member, 'member-1418@example.test'),
		(v_outsider, 'outsider-1418@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, role, display_name)
	values (v_company, v_member, 'member-1418@example.test', 'contributor', 'Contributor');

	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_id, 'exec-1418', true, array['codex']);
	insert into public.qorpera_cloud_secret_broker_authorities(
		id, profile_id, environment_id, display_name, capability_sha256, status, created_by_user_id
	) values (
		v_broker_id, v_company, v_env_id, 'Broker 1418', v_broker_cap, 'active', v_owner
	);
	insert into public.qorpera_cloud_secrets(
		id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, status, current_version, created_by_user_id
	) values (
		v_secret_id, v_company, v_env_id, v_broker_id, 'company', null,
		'environment', 'stripe_secret_key', 'Payments API', 'active', 1, v_owner
	);
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('14180000-0000-4000-8000-0000000000d1', 'member', v_company, v_env_id, v_owner, 'exec-1418', v_machine_sha, '{}');
	set local session_replication_role = origin;

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	v_surface_static := (public.qorpera_create_surface(
		v_company, 'Marketing Site', 'marketing-1418', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_surface_server := (public.qorpera_create_surface(
		v_company, 'Portal App', 'portal-1418', 'live_build', 'web_app', 'monitor', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	reset role;

	select site.* into strict v_site_static
	from public.qorpera_surfaces sf join public.qorpera_company_sites site on site.id = sf.site_id
	where sf.id = v_surface_static;
	select site.* into strict v_site_server
	from public.qorpera_surfaces sf join public.qorpera_company_sites site on site.id = sf.site_id
	where sf.id = v_surface_server;

	v_manifest := jsonb_build_object(
		'files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', repeat('1', 64), 'bytes', 64, 'content_type', 'text/html; charset=utf-8', 'immutable', false)
		),
		'redirects', '[]'::jsonb,
		'headers', '[]'::jsonb,
		'spa_fallback', 'index.html',
		'not_found_page', null
	);

	v_dep_static := (pg_temp.sasa_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 1, 64, true, true, %L, null, 'static')$q$,
		v_surface_static, repeat('a', 40), repeat('1', 64), v_manifest::text, repeat('a', 40)
	)) ->> 'deploymentId')::uuid;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_set_company_site_public(v_site_static.id, true);
		reset role;
		raise exception 'expected SITE_CONTAINS_CREDENTIAL_INPUTS on static qorpera.site';
	exception when others then
		reset role;
		perform pg_temp.sasa_assert(sqlerrm = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'static qorpera.site must refuse credential inputs: ' || sqlerrm);
	end;

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	v_dom_pending := (public.qorpera_add_company_site_domain(v_site_static.id, 'login.example.com', false) ->> 'id')::uuid;
	reset role;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_set_company_site_public(v_site_static.id, true);
		reset role;
		raise exception 'expected SITE_CONTAINS_CREDENTIAL_INPUTS while custom domain is still pending_dns';
	exception when others then
		reset role;
		perform pg_temp.sasa_assert(sqlerrm = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'pending custom domain must still refuse credential inputs: ' || sqlerrm);
	end;

	update public.qorpera_company_site_domains
	set status = 'tls_active', verified_at = clock_timestamp(), tls_active_at = clock_timestamp()
	where id = v_dom_pending;
	v_dom_verified_1 := v_dom_pending;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_set_company_site_public(v_site_static.id, true);
		reset role;
		raise exception 'expected SITE_CONTAINS_CREDENTIAL_INPUTS while verified domain is not primary';
	exception when others then
		reset role;
		perform pg_temp.sasa_assert(sqlerrm = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'non-primary verified domain must still refuse credential inputs: ' || sqlerrm);
	end;

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	perform public.qorpera_set_primary_site_domain(v_dom_verified_1);
	perform public.qorpera_set_company_site_public(v_site_static.id, true);
	reset role;
	perform pg_temp.sasa_assert(
		(select is_public from public.qorpera_company_sites where id = v_site_static.id),
		'static site with verified primary custom domain can publish credential inputs publicly'
	);

	v_snapshot := pg_temp.sasa_service('select public.qorpera_web_edge_snapshot()');
	perform pg_temp.sasa_assert(
		exists (
			select 1
			from jsonb_array_elements(v_snapshot -> 'sites') as s
			where (s ->> 'id')::uuid = v_site_static.id
				and (s #>> '{live_deployment,has_credential_inputs}')::boolean = true
		),
		'qorpera_web_edge_snapshot exposes has_credential_inputs on live_deployment'
	);

	perform pg_temp.sasa_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 1, 64, true, true, %L, null, 'static')$q$,
		v_surface_static, repeat('b', 40), repeat('2', 64), v_manifest::text, repeat('b', 40)
	));

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_remove_company_site_domain(v_dom_verified_1);
		reset role;
		raise exception 'expected SITE_CONTAINS_CREDENTIAL_INPUTS when removing primary verified domain of public credential site';
	exception when others then
		reset role;
		perform pg_temp.sasa_assert(sqlerrm = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'removing primary verified domain must refuse: ' || sqlerrm);
	end;

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	v_dom_verified_2 := (public.qorpera_add_company_site_domain(v_site_static.id, 'auth.example.com', false) ->> 'id')::uuid;
	reset role;
	update public.qorpera_company_site_domains
	set status = 'dns_verified', verified_at = clock_timestamp()
	where id = v_dom_verified_2;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_remove_company_site_domain(v_dom_verified_1);
		reset role;
		raise exception 'expected SITE_CONTAINS_CREDENTIAL_INPUTS when removing primary domain while second domain is non-primary';
	exception when others then
		reset role;
		perform pg_temp.sasa_assert(sqlerrm = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'removing primary domain with only non-primary backup must refuse: ' || sqlerrm);
	end;

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	perform public.qorpera_set_primary_site_domain(v_dom_verified_2);
	perform public.qorpera_remove_company_site_domain(v_dom_verified_1);
	perform public.qorpera_set_company_site_public(v_site_static.id, false);
	perform public.qorpera_remove_company_site_domain(v_dom_verified_2);
	reset role;

	v_dep_server := (pg_temp.sasa_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 1, 64, true, true, %L, null, 'hybrid', %L, 3000, '/health', 900, 512, 1.0, '127.0.0.1:41500', '{"PORT":"3000"}'::jsonb)$q$,
		v_surface_server, repeat('c', 40), repeat('3', 64), v_manifest::text, repeat('c', 40), v_img
	)) ->> 'deploymentId')::uuid;

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	perform public.qorpera_set_company_site_public(v_site_server.id, true);
	reset role;
	perform pg_temp.sasa_assert(
		(select is_public from public.qorpera_company_sites where id = v_site_server.id),
		'hybrid/server app can publish credential inputs publicly without custom domain'
	);

	perform pg_temp.sasa_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 1, 64, true, false, %L, null, 'hybrid', %L, 3000, '/health', 900, 512, 1.0, null, '{"PORT":"3000"}'::jsonb, true)$q$,
		v_surface_server, repeat('d', 40), repeat('4', 64), v_manifest::text, repeat('d', 40), v_img
	));

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	v_cfg := public.qorpera_set_surface_app_runtime_config(
		v_surface_server,
		'{"API_BASE_URL":"https://api.example.com","FEATURE_MODE":"beta"}'::jsonb,
		'shop_app'
	);
	v_grant := public.qorpera_grant_app_secret(v_company, v_secret_id, v_site_server.id, 'runtime', 'prod');
	v_grant_id := (v_grant ->> 'grantId')::uuid;
	v_cfg := public.qorpera_get_surface_app_runtime_config(v_surface_server);
	reset role;

	perform pg_temp.sasa_assert(
		v_cfg ->> 'schema' = 'qorpera.surface-app-runtime-config/v1'
		and (v_cfg ->> 'canManage')::boolean = true
		and v_cfg ->> 'linkedDatabaseName' = 'shop_app'
		and v_cfg #>> '{runtimeEnvConfig,API_BASE_URL}' = 'https://api.example.com'
		and jsonb_array_length(v_cfg -> 'grants') = 1
		and v_cfg #>> '{grants,0,name}' = 'STRIPE_SECRET_KEY'
		and jsonb_array_length(v_cfg -> 'availableSecrets') = 1
		and v_cfg #>> '{availableSecrets,0,name}' = 'STRIPE_SECRET_KEY',
		'owner runtime config read/write and secret grants work: ' || v_cfg::text
	);

	perform pg_temp.sasa_as(v_member);
	set local role authenticated;
	v_cfg := public.qorpera_get_surface_app_runtime_config(v_surface_server);
	reset role;
	perform pg_temp.sasa_assert(
		(v_cfg ->> 'canManage')::boolean = false and v_cfg ->> 'linkedDatabaseName' = 'shop_app',
		'contributor can read metadata with canManage=false: ' || v_cfg::text
	);

	begin
		perform pg_temp.sasa_as(v_member);
		set local role authenticated;
		perform public.qorpera_set_surface_app_runtime_config(v_surface_server, '{}'::jsonb, null);
		reset role;
		raise exception 'expected 42501 for contributor write';
	exception when insufficient_privilege then
		reset role;
	end;

	begin
		perform pg_temp.sasa_as(v_outsider);
		set local role authenticated;
		perform public.qorpera_get_surface_app_runtime_config(v_surface_server);
		reset role;
		raise exception 'expected 42501 for outsider read';
	exception when insufficient_privilege then
		reset role;
	end;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_set_surface_app_runtime_config(v_surface_server, '{"DATABASE_URL":"postgres://bad"}'::jsonb, null);
		reset role;
		raise exception 'expected 22023 for reserved DATABASE_URL key';
	exception when invalid_parameter_value then
		reset role;
	end;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_set_surface_app_runtime_config(v_surface_server, '{"PORT":"8080"}'::jsonb, null);
		reset role;
		raise exception 'expected 22023 for reserved PORT key';
	exception when invalid_parameter_value then
		reset role;
	end;

	begin
		perform pg_temp.sasa_as(v_owner);
		set local role authenticated;
		perform public.qorpera_set_surface_app_runtime_config(v_surface_server, '{}'::jsonb, 'qorpera');
		reset role;
		raise exception 'expected 22023 for reserved qorpera database name';
	exception when invalid_parameter_value then
		reset role;
	end;

	v_svc_cfg := pg_temp.sasa_service(format(
		'select public.qorpera_surface_site_runtime_config(%L)',
		v_surface_server
	));
	perform pg_temp.sasa_assert(
		(v_svc_cfg ->> 'found')::boolean = true
		and v_svc_cfg ->> 'linkedDatabaseName' = 'shop_app'
		and v_svc_cfg #>> '{runtimeEnvConfig,FEATURE_MODE}' = 'beta'
		and (v_svc_cfg ->> 'hasRuntimeProdSecrets')::boolean = true
		and (v_svc_cfg ->> 'hasRuntimeDevSecrets')::boolean = false,
		'service_role runtime config reports env, db, and active secret flags: ' || v_svc_cfg::text
	);

	perform set_config('request.jwt.claims', '{"role":"qorpera_secret_broker"}', true);
	set local role qorpera_secret_broker;
	v_auth := public.qorpera_authorize_app_secrets(
		v_broker_id, v_broker_cap, v_site_server.id, 'runtime', 'prod', 'exec-1418', v_machine_sha, v_dep_server
	);
	reset role;
	perform pg_temp.sasa_assert(
		v_auth ->> 'schema' = 'qorpera.app-secrets-authorized/v1'
		and jsonb_array_length(v_auth -> 'secrets') = 1
		and v_auth #>> '{secrets,0,name}' = 'STRIPE_SECRET_KEY',
		'qorpera_authorize_app_secrets authorizes surface deployment runtime secrets: ' || v_auth::text
	);

	perform pg_temp.sasa_as(v_owner);
	set local role authenticated;
	perform public.qorpera_revoke_app_secret_grant(v_company, v_grant_id);
	v_cfg := public.qorpera_set_surface_app_runtime_config(v_surface_server, '{}'::jsonb, null);
	reset role;
	perform pg_temp.sasa_assert(
		v_cfg ->> 'linkedDatabaseName' is null
		and v_cfg -> 'runtimeEnvConfig' = '{}'::jsonb
		and jsonb_array_length(v_cfg -> 'grants') = 0,
		'revoking grant and clearing runtime config works cleanly: ' || v_cfg::text
	);
end $$;

rollback;
