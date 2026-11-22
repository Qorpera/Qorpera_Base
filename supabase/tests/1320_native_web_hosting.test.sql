-- @fixture 1252_site_hosts.test.sql until "-- 1. Rights, the columns and their rules, the markers"
do $$
declare v_role text; v_fn text;
	v_site_id uuid;
	v_dep1 uuid;
	v_dep_cred uuid;
	v_dom_apex uuid;
	v_dom_www uuid;
	v_res jsonb;
	v_snap jsonb;
	v_env_id uuid;
	v_ver1 uuid;
	v_ver2 uuid;
	v_tree1 text := repeat('1', 40);
	v_tree2 text := repeat('2', 40);
	v_ticket text;
	v_pass text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay'] loop
		foreach v_fn in array array[
			'public.qorpera_company_site_hosting(uuid)',
			'public.qorpera_set_company_site_public(uuid,boolean)',
			'public.qorpera_add_company_site_domain(uuid,text,boolean)',
			'public.qorpera_remove_company_site_domain(uuid)',
			'public.qorpera_set_primary_site_domain(uuid)',
			'public.qorpera_recheck_company_site_domain(uuid)'
		] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_fn, 'EXECUTE') = (v_role = 'authenticated'),
				v_fn || ' execute privilege mismatch for ' || v_role);
		end loop;
		foreach v_fn in array array[
			'public.qorpera_web_edge_snapshot()',
			'public.qorpera_web_edge_tls_allow(text)',
			'public.qorpera_web_domain_mark_checked(uuid,text,text)',
			'public.qorpera_web_deployment_create(uuid,text,text,jsonb,integer,bigint,text,integer,text,integer,boolean)',
			'public.qorpera_web_deployment_promote(uuid,uuid,text,uuid)',
			'public.qorpera_web_deployment_set_upstream(uuid,text)',
			'public.qorpera_web_edge_redeem_ticket(text,text)',
			'public.qorpera_web_edge_redeem_member_pass(text,text)',
			'public.qorpera_web_code_deployment_register(text,text,uuid,text,text,integer,text,text,jsonb,integer,bigint,text,integer,text,integer,integer,numeric,boolean,text,jsonb)'
		] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_fn, 'EXECUTE') = (v_role = 'service_role'),
				v_fn || ' execute privilege mismatch for ' || v_role);
		end loop;
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_company_site_domains', 'SELECT,INSERT,UPDATE,DELETE'),
			'domains table closed to ' || v_role);
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_company_site_deployments', 'SELECT,INSERT,UPDATE,DELETE'),
			'deployments table closed to ' || v_role);
	end loop;

	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_company_site_domains'::regclass), 'domains RLS');
	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_company_site_deployments'::regclass), 'deployments RLS');

	update public.qorpera_site_settings
	set enabled = true,
		hosts_domain = 'qorpera.site',
		hosts_enabled = true,
		public_enabled = true,
		domains_enabled = true,
		edge_ipv4 = '93.164.62.162'::inet,
		edge_cname_target = 'sites.qorpera.site';

	select env.id into v_env_id
	from public.qorpera_company_environments as env
	where env.profile_id = pg_temp.rel_company()
	limit 1;

	perform pg_temp.base_assert(
		public.qorpera_code_site_valid(jsonb_build_object(
			'schema', 'qorpera.code-site/v2',
			'kind', 'server',
			'tree', v_tree1,
			'files', 0,
			'bytes', 0,
			'folder', '.',
			'name', 'native-webapp',
			'title', 'Native Webapp',
			'port', 3000,
			'healthPath', '/api/health',
			'dockerfile', 'Dockerfile',
			'idleTimeoutSec', 600,
			'memoryMb', 512,
			'vcpuLimit', 1.0
		)),
		'code-site v2 server schema accepted'
	);

	perform pg_temp.base_assert(
		not public.qorpera_code_site_valid(jsonb_build_object(
			'schema', 'qorpera.code-site/v2',
			'kind', 'static',
			'tree', v_tree1,
			'files', 0,
			'bytes', 0,
			'folder', 'dist',
			'name', null,
			'title', null
		)),
		'code-site v2 static requires at least 1 file'
	);

	insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, code_owner, code_name)
	values (pg_temp.rel_company(), v_env_id, 'native-shop', 'Native Shop', 'code/company/h-look', 'company', 'h-look')
	returning id into v_site_id;
	perform pg_temp.base_assert(v_site_id is not null, 'native-shop created');
	insert into public.qorpera_company_site_secrets (site_id, password) values (v_site_id, 'test-pass-1234');
	update public.qorpera_code_repositories
	set site_id = v_site_id
	where environment_id = v_env_id and owner = 'company' and name = 'h-look';

	v_res := pg_temp.rel_exec(format(
		'public.qorpera_web_deployment_create(%L, %L, %L, %L::jsonb, 2, 1024, %L, 3000, %L, 900, false)',
		v_site_id,
		'hybrid',
		repeat('a', 64),
		'{"files":{"index.html":{"sha256":"' || repeat('a', 64) || '","bytes":100,"content_type":"text/html; charset=utf-8"}}}',
		'registry.qorpera.internal/sites/look-shop@sha256:' || repeat('b', 64),
		'/health'
	));
	v_dep1 := (v_res ->> 'id')::uuid;
	perform pg_temp.base_assert((v_res ->> 'versionNumber')::integer = 1 and v_res ->> 'kind' = 'hybrid', 'deployment created');

	v_res := pg_temp.rel_exec(format(
		'public.qorpera_web_deployment_promote(%L, %L, %L, %L)',
		v_site_id, v_dep1, '127.0.0.1:41001', pg_temp.req_owner()
	));
	perform pg_temp.base_assert(v_res ->> 'state' = 'live', 'deployment promoted');

	insert into public.qorpera_company_site_versions (
		site_id, state, first_publish, title, source_path, manifest_sha256,
		file_count, total_bytes, tree, change, main_sha, listed
	) values (
		v_site_id, 'ready', false, 'Native Webapp v2', 'code/company/h-look', repeat('d', 64),
		0, 0, v_tree2, 1, repeat('e', 40), true
	) returning id into v_ver2;

	insert into public.qorpera_company_site_deployments (
		site_id, profile_id, version_number, version_id, kind, state, manifest_sha256, manifest_json,
		file_count, total_bytes, oci_image_ref, app_port, health_path, idle_timeout_sec, has_credential_inputs,
		upstream_addr
	) values (
		v_site_id, pg_temp.rel_company(), 2, v_ver2, 'server', 'ready', repeat('d', 64), '{}'::jsonb,
		0, 0, 'registry.qorpera.internal/sites/native-shop@sha256:' || repeat('f', 64), 3000, '/health', 900, false,
		'127.0.0.1:41002'
	);

	v_snap := pg_temp.rel_exec('public.qorpera_web_edge_snapshot()');
	perform pg_temp.base_assert(exists (
		select 1 from jsonb_array_elements(v_snap -> 'sites') as s
		where s ->> 'slug' = 'native-shop'
			and s -> 'preview_deployments' -> (v_ver2::text) ->> 'kind' = 'server'
	), 'snapshot exposes preview deployment keyed by version_id');

	v_ticket := public.qorpera_site_new_secret();
	insert into public.qorpera_company_site_tickets (ticket_sha256, site_id, version_id, user_id, expires_at)
	values (public.qorpera_site_sha256(v_ticket), v_site_id, v_ver2, pg_temp.req_owner(), clock_timestamp() + interval '2 minutes');

	v_res := pg_temp.rel_exec(format('public.qorpera_web_edge_redeem_ticket(%L, %L)', 'native-shop--next.qorpera.site', v_ticket));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open' and v_res ->> 'version_id' = v_ver2::text, 'preview ticket redeemed for qorpera.site');
	v_res := pg_temp.rel_exec(format('public.qorpera_web_edge_redeem_ticket(%L, %L)', 'native-shop--next.qorpera.site', v_ticket));
	perform pg_temp.base_assert(v_res ->> 'state' = 'refused', 'preview ticket is single-use');

	update public.qorpera_company_sites set current_version_id = v_ver2 where id = v_site_id;
	perform pg_temp.base_assert(exists (
		select 1 from public.qorpera_company_sites as s
		join public.qorpera_company_site_deployments as d on d.id = s.live_deployment_id
		where s.id = v_site_id and d.version_id = v_ver2 and d.state = 'live' and s.deployment_kind = 'server'
	), 'current_version_id switch auto-promotes paired deployment');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_site_member_pass(%L)', v_site_id));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open' and v_res ->> 'host' = 'native-shop.qorpera.site', 'member pass issued for qorpera.site');
	v_pass := v_res ->> 'pass';
	v_res := pg_temp.rel_exec(format('public.qorpera_web_edge_redeem_member_pass(%L, %L)', 'native-shop.qorpera.site', v_pass));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open' and v_res ->> 'site_id' = v_site_id::text, 'member pass redeemed for qorpera.site');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_set_company_site_public(%L, true)', v_site_id));
	perform pg_temp.base_assert((v_res ->> 'isPublic')::boolean, 'owner enables public');

	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.rel_viewer(), format('public.qorpera_set_company_site_public(%L, false)', v_site_id)),
		'42501'
	);

	v_dep_cred := (pg_temp.rel_exec(format(
		'public.qorpera_web_deployment_create(%L, %L, %L, %L::jsonb, 1, 50, null, null, %L, 900, true)',
		v_site_id, 'static', repeat('c', 64), '{}', '/'
	)) ->> 'id')::uuid;
	perform pg_temp.base_error(
		format('select pg_temp.rel_exec(%L)', format('public.qorpera_web_deployment_promote(%L, %L, null, %L)', v_site_id, v_dep_cred, pg_temp.req_owner())),
		'22023'
	);

	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_add_company_site_domain(%L, %L, false)', v_site_id, 'evil.qorpera.site')),
		'22023'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_add_company_site_domain(%L, %L, true)', v_site_id, 'minbutik.dk'));
	v_dom_apex := (v_res ->> 'id')::uuid;
	perform pg_temp.base_assert(v_res ->> 'status' = 'pending_dns' and v_res -> 'dns' ->> 'ipv4' = '93.164.62.162', 'apex domain created');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_recheck_company_site_domain(%L)', v_dom_apex));
	perform pg_temp.base_assert(v_res ->> 'schema' = 'qorpera.company-site-domain-recheck/v1' and v_res ->> 'hostname' = 'minbutik.dk', 'owner triggers immediate DNS recheck');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_add_company_site_domain(%L, %L, false)', v_site_id, 'www.minbutik.dk'));
	v_dom_www := (v_res ->> 'id')::uuid;

	perform pg_temp.base_assert((pg_temp.rel_exec('public.qorpera_web_edge_tls_allow(''minbutik.dk'')') ->> 'allowed')::boolean = false, 'pending domain denied TLS');
	perform pg_temp.base_assert((pg_temp.rel_exec('public.qorpera_web_edge_tls_allow(''native-shop.qorpera.site'')') ->> 'allowed')::boolean = true, 'own host allowed TLS');

	perform pg_temp.rel_exec(format('public.qorpera_web_domain_mark_checked(%L, %L, null)', v_dom_apex, 'dns_verified'));
	perform pg_temp.base_assert((pg_temp.rel_exec('public.qorpera_web_edge_tls_allow(''minbutik.dk'')') ->> 'allowed')::boolean = true, 'verified domain allowed TLS');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_set_primary_site_domain(%L)', v_dom_apex));
	perform pg_temp.base_assert(v_res ->> 'hostname' = 'minbutik.dk', 'primary domain set');

	v_snap := pg_temp.rel_exec('public.qorpera_web_edge_snapshot()');
	perform pg_temp.base_assert(v_snap ->> 'hosts_domain' = 'qorpera.site', 'snapshot hosts_domain');
	perform pg_temp.base_assert(exists (
		select 1 from jsonb_array_elements(v_snap -> 'sites') as s
		where s ->> 'slug' = 'native-shop'
			and (s ->> 'is_public')::boolean
			and s ->> 'primary_custom_domain' = 'minbutik.dk'
			and s -> 'live_deployment' ->> 'upstream_addr' = '127.0.0.1:41002'
	), 'snapshot carries live server deployment and primary domain');

	v_res := pg_temp.req_as(pg_temp.rel_viewer(), format('public.qorpera_company_site_hosting(%L)', pg_temp.rel_company()));
	perform pg_temp.base_assert(v_res ->> 'schema' = 'qorpera.company-site-hosting/v1' and v_res ->> 'hostsDomain' = 'qorpera.site', 'viewer reads hosting state');

	perform public.qorpera_site_take_down('native-shop', 'test takedown');
	perform pg_temp.base_assert((pg_temp.rel_exec('public.qorpera_web_edge_tls_allow(''minbutik.dk'')') ->> 'allowed')::boolean = false, 'taken-down domain denied TLS');
	perform public.qorpera_site_restore('native-shop');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_remove_company_site_domain(%L)', v_dom_www));
	perform pg_temp.base_assert((v_res ->> 'removed')::boolean, 'domain removed');

	perform pg_temp.base_assert(
		exists (
			select 1 from pg_roles
			where rolname = 'qorpera_web_router'
				and not rolsuper and not rolcreatedb and not rolcreaterole
				and not rolinherit and not rolreplication and not rolbypassrls
		),
		'qorpera_web_router role exists with least-privilege attributes'
	);
	perform pg_temp.base_assert(
		has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_snapshot()', 'EXECUTE')
			and has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_tls_allow(text)', 'EXECUTE')
			and has_function_privilege('qorpera_web_router', 'public.qorpera_web_domain_mark_checked(uuid,text,text)', 'EXECUTE')
			and has_function_privilege('qorpera_web_router', 'public.qorpera_web_deployment_set_upstream(uuid,text)', 'EXECUTE')
			and has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_redeem_ticket(text,text)', 'EXECUTE')
			and has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_redeem_member_pass(text,text)', 'EXECUTE')
			and not has_function_privilege('qorpera_web_router', 'public.qorpera_web_deployment_create(uuid,text,text,jsonb,integer,bigint,text,integer,text,integer,boolean)', 'EXECUTE')
			and not has_table_privilege('qorpera_web_router', 'public.qorpera_profiles', 'SELECT')
			and not has_table_privilege('qorpera_web_router', 'public.qorpera_company_sites', 'SELECT')
			and not has_table_privilege('qorpera_web_router', 'public.qorpera_company_site_domains', 'SELECT'),
		'qorpera_web_router may only execute the six edge RPCs'
	);
end $$;
