-- @fixture 1252_site_hosts.test.sql until "-- 1. Rights, the columns and their rules, the markers"
do $$
declare
	v_role text;
	v_fn text;
	v_env_id uuid;
	v_site_id uuid;
	v_other_site_id uuid;
	v_abandoned_site_id uuid;
	v_app_site_id uuid;
	v_res jsonb;
	v_snap jsonb;
	v_repo_index_before integer;
	v_repo_index_after integer;
	v_pass_count integer;
	v_ticket_count integer;
	v_session_count integer;
	v_hint_count integer;
	v_staff_id uuid;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay', 'qorpera_web_router'] loop
		foreach v_fn in array array[
			'public.qorpera_check_company_site_slug(uuid,text)',
			'public.qorpera_set_company_site_slug(uuid,text)'
		] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_fn, 'EXECUTE') = (v_role = 'authenticated'),
				v_fn || ' execute privilege mismatch for ' || v_role);
		end loop;
	end loop;

	update public.qorpera_site_settings
	set enabled = true,
		hosts_domain = 'qorpera.site',
		hosts_enabled = true,
		public_enabled = true,
		domains_enabled = true;

	select env.id into v_env_id
	from public.qorpera_company_environments as env
	where env.profile_id = pg_temp.rel_company()
	limit 1;

	select staff.staff_agent_id into v_staff_id
	from public.qorpera_profile_staff as staff
	where staff.profile_id = pg_temp.rel_company()
	limit 1;

	insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, code_owner, code_name, created_by_staff_agent_id)
	values (pg_temp.rel_company(), v_env_id, 'old-brand', 'Old Brand', 'code/company/h-look', 'company', 'h-look', v_staff_id)
	returning id into v_site_id;
	insert into public.qorpera_company_site_secrets (site_id, password) values (v_site_id, 'test-pass-1234');
	update public.qorpera_code_repositories
	set site_id = v_site_id
	where environment_id = v_env_id and owner = 'company' and name = 'h-look';

	insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values (pg_temp.rel_company(), v_env_id, 'taken-brand', 'Taken Brand', 'sites/taken-brand', v_staff_id)
	returning id into v_other_site_id;

	insert into public.qorpera_company_sites (profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id, updated_at)
	values (pg_temp.rel_company(), v_env_id, 'stale-brand', 'Stale Brand', 'sites/stale-brand', v_staff_id, clock_timestamp() - interval '2 days')
	returning id into v_abandoned_site_id;

	insert into public.qorpera_company_sites (profile_id, environment_id, kind, slug, title, source_path, created_by_staff_agent_id, app_port)
	values (pg_temp.rel_company(), v_env_id, 'app', 'preview-app', 'Preview App', 'machine-1', v_staff_id, 3000)
	returning id into v_app_site_id;

	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.rel_viewer(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'fresh-brand')),
		'42501'
	);
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.rel_viewer(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'fresh-brand')),
		'42501'
	);
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_app_site_id, 'fresh-brand')),
		'22023'
	);
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_app_site_id, 'fresh-brand')),
		'22023'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, '  Old-Brand  '));
	perform pg_temp.base_assert(
		v_res ->> 'schema' = 'qorpera.company-site-slug-check/v1'
			and (v_res ->> 'available')::boolean
			and v_res ->> 'reason' = 'current'
			and v_res ->> 'slug' = 'old-brand',
		'current slug check returns current'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'Fresh-Brand'));
	perform pg_temp.base_assert(
		(v_res ->> 'available')::boolean and v_res ->> 'reason' = 'available' and v_res ->> 'slug' = 'fresh-brand',
		'free slug check returns available'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'taken-brand'));
	perform pg_temp.base_assert(
		not (v_res ->> 'available')::boolean and v_res ->> 'reason' = 'taken',
		'taken slug check returns taken'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'stale-brand'));
	perform pg_temp.base_assert(
		(v_res ->> 'available')::boolean and v_res ->> 'reason' = 'available',
		'abandoned slug check returns available'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'shop'));
	perform pg_temp.base_assert(
		not (v_res ->> 'available')::boolean and v_res ->> 'reason' = 'reserved',
		'reserved word check returns reserved'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'my-qorpera'));
	perform pg_temp.base_assert(
		not (v_res ->> 'available')::boolean and v_res ->> 'reason' = 'reserved',
		'qorpera word check returns reserved'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'ab'));
	perform pg_temp.base_assert(
		not (v_res ->> 'available')::boolean and v_res ->> 'reason' = 'invalid',
		'too short slug returns invalid'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_check_company_site_slug(%L, %L)', v_site_id, 'bad--name'));
	perform pg_temp.base_assert(
		not (v_res ->> 'available')::boolean and v_res ->> 'reason' = 'invalid',
		'double hyphen slug returns invalid'
	);

	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'taken-brand')),
		'23505'
	);
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'shop')),
		'22023'
	);
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'bad--name')),
		'22023'
	);

	insert into public.qorpera_company_site_member_passes (pass_sha256, site_id, user_id, host, expires_at)
	values (repeat('1', 64), v_site_id, pg_temp.req_owner(), 'old-brand.qorpera.site', clock_timestamp() + interval '1 minute');
	insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at, scope)
	values (repeat('2', 64), v_site_id, 1, clock_timestamp() + interval '1 hour', 'site');

	select repo.index_version into v_repo_index_before
	from public.qorpera_code_repositories as repo
	where repo.site_id = v_site_id;

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, '  Fresh-Brand  '));
	perform pg_temp.base_assert(
		v_res ->> 'schema' = 'qorpera.company-site-slug/v1'
			and v_res ->> 'siteId' = v_site_id::text
			and v_res ->> 'slug' = 'fresh-brand'
			and v_res ->> 'url' = 'https://fresh-brand.qorpera.site/',
		'owner renames site slug and receives updated url'
	);

	select count(*) into v_pass_count from public.qorpera_company_site_member_passes where site_id = v_site_id;
	select count(*) into v_ticket_count from public.qorpera_company_site_tickets where site_id = v_site_id;
	select count(*) into v_session_count from public.qorpera_company_site_sessions where site_id = v_site_id;
	perform pg_temp.base_assert(v_pass_count = 0 and v_ticket_count = 0 and v_session_count = 0, 'rename clears stale passes, tickets, and sessions');

	select repo.index_version into v_repo_index_after
	from public.qorpera_code_repositories as repo
	where repo.site_id = v_site_id;
	perform pg_temp.base_assert(v_repo_index_after = v_repo_index_before + 1, 'rename bumps linked code repository index_version');

	v_snap := pg_temp.rel_exec('public.qorpera_web_edge_snapshot()');
	perform pg_temp.base_assert(
		exists (select 1 from jsonb_array_elements(v_snap -> 'sites') as s where s ->> 'id' = v_site_id::text and s ->> 'slug' = 'fresh-brand')
			and not exists (select 1 from jsonb_array_elements(v_snap -> 'sites') as s where s ->> 'slug' = 'old-brand'),
		'edge snapshot immediately reflects renamed slug'
	);

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'fresh-brand'));
	perform pg_temp.base_assert(v_res ->> 'slug' = 'fresh-brand', 'no-op rename to same slug succeeds');

	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'stale-brand'));
	perform pg_temp.base_assert(
		v_res ->> 'slug' = 'stale-brand'
			and not exists (select 1 from public.qorpera_company_sites where id = v_abandoned_site_id),
		'rename reclaims abandoned site slug'
	);

	perform public.qorpera_site_take_down('stale-brand', 'policy test');
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(), format('public.qorpera_set_company_site_slug(%L, %L)', v_site_id, 'after-down')),
		'42501'
	);
	perform public.qorpera_site_restore('stale-brand');

	select count(*) into v_hint_count
	from pg_trigger as trg
	where trg.tgrelid = 'public.qorpera_company_sites'::regclass
		and trg.tgname = 'qorpera_live_hint_site_slug';
	perform pg_temp.base_assert(v_hint_count = 1, 'surfaces live-hint trigger installed on qorpera_company_sites');
end $$;
