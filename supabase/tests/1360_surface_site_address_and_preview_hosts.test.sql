-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ssap_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_site_address_and_preview_hosts: %', p_message;
	end if;
end $$;

create function pg_temp.ssap_as(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create function pg_temp.ssap_hosts(p_domain text, p_on boolean)
returns void language sql as $$
	update public.qorpera_site_settings set enabled = true, hosts_domain = p_domain, hosts_enabled = p_on
$$;

create function pg_temp.ssap_live_url(p_surface uuid)
returns text language sql as $$
	select public.qorpera_surface_summary_json(surface) ->> 'liveUrl' from public.qorpera_surfaces surface where surface.id = p_surface
$$;

create function pg_temp.ssap_mint(p_user uuid, p_preview uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.ssap_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_mint_surface_preview_pass(p_preview);
	reset role;
	return v_result;
end $$;

create function pg_temp.ssap_mint_errcode(p_user uuid, p_preview uuid)
returns text language plpgsql as $$
begin
	perform pg_temp.ssap_as(p_user);
	set local role authenticated;
	begin
		perform public.qorpera_mint_surface_preview_pass(p_preview);
	exception when others then
		reset role;
		return sqlstate;
	end;
	reset role;
	return null;
end $$;

create function pg_temp.ssap_edge_redeem(p_host text, p_pass text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_web_edge_redeem_member_pass(p_host, p_pass);
	reset role;
	return v_result;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_vic constant uuid := '13600000-0000-4000-8000-000000000003';
	v_out constant uuid := '13600000-0000-4000-8000-000000000004';
	v_web uuid;
	v_shop uuid;
	v_note uuid;
	v_web_site public.qorpera_company_sites%rowtype;
	v_shop_site public.qorpera_company_sites%rowtype;
	v_web_version uuid := extensions.gen_random_uuid();
	v_shop_version uuid := extensions.gen_random_uuid();
	v_web_preview uuid := extensions.gen_random_uuid();
	v_shop_preview uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.ssap_assert(
		not has_function_privilege('anon', 'public.qorpera_site_preview_domain()', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_site_preview_domain()', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_site_preview_domain()', 'EXECUTE'),
		'the preview domain helper stays closed to every API role'
	);

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into auth.users(id, email) values (v_vic, 'vic-ssap@example.test'), (v_out, 'out-ssap@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_vic, 'vic-ssap@example.test', 'Vic', 'viewer');

	perform pg_temp.ssap_as(v_anna);
	set local role authenticated;
	v_web := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_shop := (public.qorpera_create_surface(
		v_company, 'Storefront', 'storefront', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_note := (public.qorpera_create_surface(
		v_company, 'Launch Note', 'launch-note', 'studio', 'report', 'figure:book', null, 'surfaces/launch-note', null, false
	) ->> 'id')::uuid;
	reset role;

	select site.* into strict v_web_site
	from public.qorpera_surfaces surface join public.qorpera_company_sites site on site.id = surface.site_id
	where surface.id = v_web;
	select site.* into strict v_shop_site
	from public.qorpera_surfaces surface join public.qorpera_company_sites site on site.id = surface.site_id
	where surface.id = v_shop;
	perform pg_temp.ssap_assert(
		v_web_site.id <> v_shop_site.id
		and (select site_id from public.qorpera_surfaces where id = v_note) is null,
		'two website interfaces with a site each, and a studio with none'
	);

	insert into public.qorpera_company_site_versions(
		id, site_id, run_id, call_id, staff_agent_id, first_publish, source_path,
		manifest_sha256, file_count, total_bytes, state, published_at
	)
	values
		(
			v_web_version, v_web_site.id, extensions.gen_random_uuid(), 'ssap-web', extensions.gen_random_uuid(), true,
			'surfaces/website', repeat('c', 64), 1, 16, 'live', clock_timestamp()
		),
		(
			v_shop_version, v_shop_site.id, extensions.gen_random_uuid(), 'ssap-shop', extensions.gen_random_uuid(), true,
			'surfaces/storefront', repeat('d', 64), 1, 16, 'live', clock_timestamp()
		);
	insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type, content)
	select version_id, 'index.html', 16, encode(extensions.digest('<h1>Preview</h1>', 'sha256'), 'hex'),
		'text/html; charset=utf-8', convert_to('<h1>Preview</h1>', 'utf8')
	from unnest(array[v_web_version, v_shop_version]) as version_id;
	update public.qorpera_company_sites set current_version_id = v_web_version where id = v_web_site.id;

	insert into public.qorpera_surface_previews(
		id, profile_id, surface_id, composition_key, short_host_id, base_sha, status, site_version_id, expires_at
	)
	values
		(v_web_preview, v_company, v_web, 'ssap-web', 'ab12cd34', repeat('0', 40), 'ready', v_web_version,
			clock_timestamp() + interval '1 hour'),
		(v_shop_preview, v_company, v_shop, 'ssap-shop', 'ef56ab78', repeat('0', 40), 'ready', v_shop_version,
			clock_timestamp() + interval '1 hour');

	perform set_config('qorpera_test.ssap', jsonb_build_object(
		'company', v_company, 'anna', v_anna, 'vic', v_vic, 'out', v_out,
		'web', v_web, 'shop', v_shop, 'note', v_note,
		'webSite', v_web_site.id, 'webSlug', v_web_site.slug, 'shopSite', v_shop_site.id, 'shopSlug', v_shop_site.slug,
		'webVersion', v_web_version, 'shopVersion', v_shop_version,
		'webPreview', v_web_preview, 'shopPreview', v_shop_preview
	)::text, true);
end $$;

do $$
declare
	v jsonb := current_setting('qorpera_test.ssap')::jsonb;
	v_web_slug text := v ->> 'webSlug';
	v_shop_slug text := v ->> 'shopSlug';
	v_vic uuid := (v ->> 'vic')::uuid;
	v_host text := (v ->> 'webSlug') || '--p0.qorpera.site';
	v_shop_host text := (v ->> 'shopSlug') || '--p0.qorpera.site';
	v_mint jsonb;
	v_pass text;
	v_open jsonb;
	v_workspace jsonb;
begin
	perform pg_temp.ssap_hosts('qorpera.site', true);

	perform pg_temp.ssap_assert(
		public.qorpera_site_preview_domain() = 'qorpera.site'
		and pg_temp.ssap_live_url((v ->> 'web')::uuid) = 'https://' || v_web_slug || '.qorpera.site/'
		and pg_temp.ssap_live_url((v ->> 'web')::uuid) = public.qorpera_site_url(v_web_slug)
		and pg_temp.ssap_live_url((v ->> 'note')::uuid) is null,
		'liveUrl and preview domain follow hosts_domain on qorpera.site'
	);
	perform pg_temp.ssap_as(v_vic);
	set local role authenticated;
	v_workspace := public.qorpera_get_surface_workspace((v ->> 'web')::uuid);
	reset role;
	perform pg_temp.ssap_assert(
		v_workspace -> 'surface' ->> 'liveUrl' = 'https://' || v_web_slug || '.qorpera.site/',
		'a member''s workspace carries the same liveUrl'
	);

	perform pg_temp.ssap_assert(
		public.qorpera_site_host('look-shop--p0.qorpera.site')
			= jsonb_build_object('slug', 'look-shop', 'scope', 'preview', 'previewSlot', 0)
		and public.qorpera_site_host('look-shop--p7.qorpera.site')
			= jsonb_build_object('slug', 'look-shop', 'scope', 'preview', 'previewSlot', 7)
		and public.qorpera_site_host('look-shop--p8.qorpera.site') is null
		and public.qorpera_site_host('look-shop--pab12cd34.qorpera.com') is null
		and public.qorpera_site_host('look-shop--pab12cd34.qorpera.site') is null
		and public.qorpera_site_host('look-shop.qorpera.com') is null
		and public.qorpera_site_host('look-shop--next.qorpera.com') is null
		and public.qorpera_site_host('look-shop--next--p0.qorpera.site') is null
		and public.qorpera_site_host('a.look-shop--p0.qorpera.site') is null
		and public.qorpera_site_host('shop--p0.qorpera.site') is null
		and public.qorpera_site_host('look-shop.qorpera.site') = jsonb_build_object('slug', 'look-shop', 'scope', 'site')
		and public.qorpera_site_host('look-shop--next.qorpera.site') = jsonb_build_object('slug', 'look-shop', 'scope', 'next'),
		'under qorpera.site the host rule takes own, next and --p0..--p7 hosts on qorpera.site only'
	);

	v_mint := pg_temp.ssap_mint(v_vic, (v ->> 'webPreview')::uuid);
	v_pass := v_mint ->> 'memberPass';
	perform pg_temp.ssap_assert(
		v_pass is not null and v_mint ->> 'doorActionUrl' = 'https://' || v_host || '/__qorpera/member',
		'a viewer gets a pass for --p0 on qorpera.site: ' || v_mint::text
	);
	v_open := pg_temp.ssap_edge_redeem(v_host, v_pass);
	perform pg_temp.ssap_assert(
		v_open ->> 'state' = 'open'
		and (v_open ->> 'max_age')::integer = 43200
		and (v_open ->> 'site_id')::uuid = (v ->> 'webSite')::uuid
		and (v_open ->> 'version_id')::uuid = (v ->> 'webVersion')::uuid,
		'the pass opens the preview version on the native web router: ' || v_open::text
	);
	perform pg_temp.ssap_assert(pg_temp.ssap_edge_redeem(v_host, v_pass) ->> 'state' = 'refused', 'a used pass is refused');

	perform pg_temp.ssap_assert(
		pg_temp.ssap_edge_redeem(v_web_slug || '.qorpera.com',
			public.qorpera_surface_mint_preview_pass((v ->> 'webSite')::uuid, v_vic, v_web_slug || '.qorpera.com')) ->> 'state' = 'refused'
		and pg_temp.ssap_edge_redeem(v_host,
			public.qorpera_surface_mint_preview_pass((v ->> 'webSite')::uuid, v_vic, v_host, null)) ->> 'state' = 'refused'
		and pg_temp.ssap_edge_redeem(v_web_slug || '.qorpera.site',
			public.qorpera_surface_mint_preview_pass((v ->> 'webSite')::uuid, v_vic, v_web_slug || '.qorpera.site')) ->> 'state' = 'open',
		'a preview pass requires a version_id and an own-host pass opens qorpera.site'
	);

	v_pass := public.qorpera_surface_mint_preview_pass((v ->> 'shopSite')::uuid, v_vic, v_host, (v ->> 'shopVersion')::uuid);
	perform pg_temp.ssap_assert(
		pg_temp.ssap_edge_redeem(v_host, v_pass) ->> 'state' = 'refused'
		and pg_temp.ssap_edge_redeem(v_shop_host, (pg_temp.ssap_mint(v_vic, (v ->> 'webPreview')::uuid) ->> 'memberPass')) ->> 'state' = 'refused',
		'a pass of another site is refused'
	);
	v_pass := pg_temp.ssap_mint(v_vic, (v ->> 'shopPreview')::uuid) ->> 'memberPass';
	perform pg_temp.ssap_assert(
		pg_temp.ssap_edge_redeem(v_host, v_pass) ->> 'state' = 'refused'
		and pg_temp.ssap_edge_redeem(v_shop_host, v_pass) ->> 'state' = 'open',
		'a pass refused on another site''s preview host is not spent there'
	);

	v_pass := pg_temp.ssap_mint(v_vic, (v ->> 'webPreview')::uuid) ->> 'memberPass';
	update public.qorpera_company_site_member_passes
	set created_at = clock_timestamp() - interval '3 minutes', expires_at = clock_timestamp() - interval '1 minute'
	where pass_sha256 = public.qorpera_site_sha256(v_pass);
	perform pg_temp.ssap_assert(pg_temp.ssap_edge_redeem(v_host, v_pass) ->> 'state' = 'refused', 'an expired pass is refused');

	update public.qorpera_surface_previews set expires_at = clock_timestamp() - interval '1 minute'
	where id = (v ->> 'shopPreview')::uuid;
	v_pass := public.qorpera_surface_mint_preview_pass((v ->> 'shopSite')::uuid, v_vic, v_shop_host, (v ->> 'shopVersion')::uuid);
	perform pg_temp.ssap_assert(
		pg_temp.ssap_edge_redeem(v_shop_host, v_pass) ->> 'state' = 'refused'
		and pg_temp.ssap_mint_errcode(v_vic, (v ->> 'shopPreview')::uuid) = '55000',
		'a preview past its time opens nothing'
	);
	update public.qorpera_surface_previews set expires_at = clock_timestamp() + interval '1 hour'
	where id = (v ->> 'shopPreview')::uuid;

	perform pg_temp.ssap_assert(
		pg_temp.ssap_mint_errcode((v ->> 'out')::uuid, (v ->> 'webPreview')::uuid) = '42501',
		'someone outside the company gets no pass'
	);
	v_pass := pg_temp.ssap_mint(v_vic, (v ->> 'webPreview')::uuid) ->> 'memberPass';
	delete from public.qorpera_profile_members where profile_id = (v ->> 'company')::uuid and user_id = v_vic;
	perform pg_temp.ssap_assert(
		pg_temp.ssap_edge_redeem(v_host, v_pass) ->> 'state' = 'refused',
		'a pass of someone who left the company is refused'
	);

	perform pg_temp.ssap_assert(
		(public.qorpera_web_edge_tls_allow(v_host) ->> 'allowed')::boolean = true
		and (public.qorpera_web_edge_tls_allow(v_web_slug || '--p7.qorpera.site') ->> 'allowed')::boolean = true
		and (public.qorpera_web_edge_tls_allow(v_web_slug || '--p8.qorpera.site') ->> 'allowed')::boolean = false
		and (public.qorpera_web_edge_tls_allow(v_web_slug || '--pab12cd34.qorpera.site') ->> 'allowed')::boolean = false
		and (public.qorpera_web_edge_tls_allow(v_web_slug || '.qorpera.site') ->> 'allowed')::boolean = true
		and (public.qorpera_web_edge_tls_allow(v_web_slug || '.qorpera.com') ->> 'allowed')::boolean = false,
		'the web router allows --p0..--p7 on hosts_domain and refuses legacy random preview hosts'
	);
end $$;

do $$
declare
	v jsonb := current_setting('qorpera_test.ssap')::jsonb;
	v_web_slug text := v ->> 'webSlug';
	v_anna uuid := (v ->> 'anna')::uuid;
	v_host text := (v ->> 'webSlug') || '--p0.qorpera.com';
	v_mint jsonb;
	v_open jsonb;
begin
	perform pg_temp.ssap_hosts('qorpera.com', true);

	perform pg_temp.ssap_assert(
		public.qorpera_site_preview_domain() = 'qorpera.com'
		and pg_temp.ssap_live_url((v ->> 'web')::uuid) = 'https://' || v_web_slug || '.qorpera.com/'
		and pg_temp.ssap_live_url((v ->> 'note')::uuid) is null,
		'liveUrl and preview domain follow qorpera.com when configured'
	);
	v_mint := pg_temp.ssap_mint(v_anna, (v ->> 'webPreview')::uuid);
	perform pg_temp.ssap_assert(
		v_mint ->> 'doorActionUrl' = 'https://' || v_host || '/__qorpera/member',
		'the preview door follows hosts_domain: ' || v_mint::text
	);
	v_open := pg_temp.ssap_edge_redeem(v_host, v_mint ->> 'memberPass');
	perform pg_temp.ssap_assert(v_open ->> 'state' = 'open', 'edge redemption works on configured hosts_domain');

	perform pg_temp.ssap_assert(
		strpos(pg_get_functiondef('public.qorpera_get_surface_workspace(uuid)'::regprocedure), '''.qorpera.com''') = 0
		and strpos(pg_get_functiondef('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure), '''.qorpera.com''') = 0
		and strpos(pg_get_functiondef('public.qorpera_mint_surface_preview_pass(uuid)'::regprocedure), '''.qorpera.com''') = 0
		and strpos(pg_get_functiondef('public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure), '.qorpera.com') = 0,
		'no surface preview or live address hardcodes qorpera.com'
	);

	perform pg_temp.ssap_hosts('qorpera.com', false);
	perform pg_temp.ssap_assert(
		pg_temp.ssap_live_url((v ->> 'web')::uuid) = public.qorpera_site_url(v_web_slug)
		and pg_temp.ssap_live_url((v ->> 'web')::uuid) = 'https://sites.qorpera.com/' || v_web_slug || '/',
		'with hosts off liveUrl is the site list''s link'
	);
end $$;

rollback;
