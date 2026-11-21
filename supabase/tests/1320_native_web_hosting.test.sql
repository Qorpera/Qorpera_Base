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
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay'] loop
		foreach v_fn in array array[
			'public.qorpera_company_site_hosting(uuid)',
			'public.qorpera_set_company_site_public(uuid,boolean)',
			'public.qorpera_add_company_site_domain(uuid,text,boolean)',
			'public.qorpera_remove_company_site_domain(uuid)',
			'public.qorpera_set_primary_site_domain(uuid)'
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
			'public.qorpera_web_deployment_set_upstream(uuid,text)'
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

	insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, code_owner, code_name)
	select pg_temp.rel_company(), env.id, 'native-shop', 'Native Shop', 'code/company/h-look', 'company', 'h-look'
	from public.qorpera_company_environments as env
	where env.profile_id = pg_temp.rel_company()
	limit 1
	returning id into v_site_id;
	perform pg_temp.base_assert(v_site_id is not null, 'native-shop created');

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
			and s -> 'live_deployment' ->> 'upstream_addr' = '127.0.0.1:41001'
	), 'snapshot carries live hybrid deployment and primary domain');

	v_res := pg_temp.req_as(pg_temp.rel_viewer(), format('public.qorpera_company_site_hosting(%L)', pg_temp.rel_company()));
	perform pg_temp.base_assert(v_res ->> 'schema' = 'qorpera.company-site-hosting/v1' and v_res ->> 'hostsDomain' = 'qorpera.site', 'viewer reads hosting state');

	perform public.qorpera_site_take_down('native-shop', 'test takedown');
	perform pg_temp.base_assert((pg_temp.rel_exec('public.qorpera_web_edge_tls_allow(''minbutik.dk'')') ->> 'allowed')::boolean = false, 'taken-down domain denied TLS');
	perform public.qorpera_site_restore('native-shop');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_remove_company_site_domain(%L)', v_dom_www));
	perform pg_temp.base_assert((v_res ->> 'removed')::boolean, 'domain removed');
end $$;
