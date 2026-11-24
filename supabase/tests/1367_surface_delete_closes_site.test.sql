-- @fixture 1252_site_hosts.test.sql until "-- 1. Rights, the columns and their rules, the markers"
create function pg_temp.dcs_site(p_slug text, p_public boolean) returns uuid language plpgsql as $$
declare
	v_site uuid;
	v_version uuid;
begin
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
	values (pg_temp.rel_company(), '92400000-0000-4000-8000-000000000020', p_slug, 'sites/web',
		'92400000-0000-4000-8000-000000000030')
	returning id into v_site;
	insert into public.qorpera_company_site_secrets (site_id, password) values (v_site, p_slug || '-password');
	insert into public.qorpera_company_site_versions (
		site_id, state, run_id, call_id, staff_agent_id, first_publish, title, source_path, manifest_sha256,
		file_count, total_bytes, published_at
	) values (
		v_site, 'live', extensions.gen_random_uuid(), 'call-' || extensions.gen_random_uuid()::text,
		'92400000-0000-4000-8000-000000000030', false, null, 'sites/web', repeat('d', 64), 1, 32, clock_timestamp()
	) returning id into v_version;
	insert into public.qorpera_company_site_files (version_id, path, bytes, sha256, content_type, content)
	values (v_version, 'index.html', octet_length(convert_to('<h1>' || p_slug || '</h1>', 'utf8')),
		pg_temp.sh_sha('<h1>' || p_slug || '</h1>'), 'text/html; charset=utf-8', convert_to('<h1>' || p_slug || '</h1>', 'utf8'));
	update public.qorpera_company_sites set current_version_id = v_version, is_public = p_public where id = v_site;
	return v_site;
end $$;

create function pg_temp.dcs_surface(p_slug text, p_site uuid, p_status text default 'active') returns uuid language sql as $$
	insert into public.qorpera_surfaces (profile_id, slug, title, surface_group, archetype, status, source_kind, site_id, preview_mode)
	values (pg_temp.rel_company(), p_slug, initcap(p_slug), 'products', 'live_build', p_status, 'code_repo', p_site,
		case when p_site is null then 'none' else 'static_site' end)
	returning id
$$;

create function pg_temp.dcs_delete(p_surface uuid, p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_archive_surface(%L)', p_surface))
$$;

create function pg_temp.dcs_row(p_site uuid) returns jsonb language sql as $$
	select jsonb_build_object('is_public', site.is_public, 'password_version', site.password_version,
		'updated_at', site.updated_at, 'ctid', site.ctid::text, 'app_auth_mode', site.app_auth_mode)
	from public.qorpera_company_sites as site where site.id = p_site
$$;

create function pg_temp.dcs_snap(p_site uuid) returns jsonb language sql as $$
	select s from jsonb_array_elements(pg_temp.rel_exec('public.qorpera_web_edge_snapshot()') -> 'sites') as s
	where s ->> 'id' = p_site::text
$$;

update public.qorpera_site_settings
set enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true, public_enabled = true,
	domains_enabled = true, apps_enabled = true;
update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

do $$
declare v_role text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay',
		'qorpera_web_router'] loop
		perform pg_temp.base_assert(
			not has_function_privilege(v_role, 'public.qorpera_surface_site_close(uuid)', 'EXECUTE'),
			'the site close is closed to ' || v_role);
	end loop;
	perform pg_temp.base_assert(
		(select prosecdef from pg_proc where oid = 'public.qorpera_surface_site_close(uuid)'::regprocedure),
		'the site close is security definer');
	perform pg_temp.base_assert((
		select count(*) = 1 from pg_trigger as trg
		where trg.tgrelid = 'public.qorpera_company_sites'::regclass
			and trg.tgname = 'qorpera_web_notify_sites'
			and trg.tgfoid = 'public.qorpera_web_notify_route_change()'::regprocedure
			and trg.tgtype = 28
			and trg.tgenabled = 'O'
	), 'a change to a site tells the router: after insert, update or delete, once a statement');
	perform pg_temp.base_assert(
		strpos(pg_get_functiondef('public.qorpera_surface_remove(uuid,boolean)'::regprocedure),
			'perform public.qorpera_surface_site_close(v_surface.site_id);') > 0,
		'the delete closes the site');
end $$;

do $$
declare
	v_site uuid := pg_temp.dcs_site('dcs-open-web', true);
	v_surface uuid := pg_temp.dcs_surface('dcs-open', v_site);
	v_token text := repeat('D', 32);
	v_before jsonb;
	v_after jsonb;
	v_snap jsonb;
	v_result jsonb;
begin
	insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at)
	values (pg_temp.sh_sha(v_token), v_site, (select password_version from public.qorpera_company_sites where id = v_site),
		clock_timestamp() + interval '1 day');
	perform pg_temp.base_assert(pg_temp.sh_serve('dcs-open-web.qorpera.site', '', v_token) ->> 'state' = 'file',
		'the visitor''s session opens it before the delete: ' || pg_temp.sh_serve('dcs-open-web.qorpera.site', '', v_token)::text);
	perform pg_temp.base_assert((pg_temp.dcs_snap(v_site) ->> 'is_public')::boolean, 'the router serves it to everyone');
	v_before := pg_temp.dcs_row(v_site);

	v_result := pg_temp.dcs_delete(v_surface);
	v_after := pg_temp.dcs_row(v_site);
	v_snap := pg_temp.dcs_snap(v_site);
	perform pg_temp.base_assert(v_result ->> 'status' = 'archived', 'the interface is deleted: ' || v_result::text);
	perform pg_temp.base_assert(not (v_after ->> 'is_public')::boolean
		and (v_after ->> 'password_version')::integer = (v_before ->> 'password_version')::integer + 1
		and (v_after ->> 'updated_at')::timestamptz > (v_before ->> 'updated_at')::timestamptz,
		'its website is not public, its sessions end once: ' || v_before::text || ' ' || v_after::text);
	perform pg_temp.base_assert(not (v_snap ->> 'is_public')::boolean and v_snap -> 'password_sha256' = 'null'
		and (v_snap ->> 'password_version')::integer = (v_after ->> 'password_version')::integer,
		'the router''s snapshot: not public, no password, the new version: ' || v_snap::text);
	perform pg_temp.base_assert(pg_temp.sh_serve('dcs-open-web.qorpera.site', '', v_token) ->> 'state' = 'locked',
		'a visitor''s session from before is refused: ' || pg_temp.sh_serve('dcs-open-web.qorpera.site', '', v_token)::text);
	perform pg_temp.base_assert(
		exists (select 1 from public.qorpera_company_sites where id = v_site and slug = 'dcs-open-web' and current_version_id is not null)
			and exists (select 1 from public.qorpera_company_site_versions where site_id = v_site)
			and exists (select 1 from public.qorpera_company_site_secrets where site_id = v_site),
		'the site, its versions and its name stay');

	v_before := v_after;
	v_result := pg_temp.dcs_delete(v_surface);
	perform pg_temp.base_assert(v_result ->> 'status' = 'archived' and pg_temp.dcs_row(v_site) = v_before,
		'deleting it again writes nothing more: ' || pg_temp.dcs_row(v_site)::text);
end $$;

do $$
declare
	v_site uuid := pg_temp.dcs_site('dcs-closed-web', false);
	v_surface uuid := pg_temp.dcs_surface('dcs-closed', v_site);
	v_token text := repeat('E', 32);
	v_before jsonb;
begin
	insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at)
	values (pg_temp.sh_sha(v_token), v_site, (select password_version from public.qorpera_company_sites where id = v_site),
		clock_timestamp() + interval '1 day');
	v_before := pg_temp.dcs_row(v_site);
	perform pg_temp.base_assert(pg_temp.dcs_delete(v_surface) ->> 'status' = 'archived', 'the interface is deleted');
	perform pg_temp.base_assert(pg_temp.dcs_row(v_site) = v_before,
		'a website that was not public is not written: ' || v_before::text || ' ' || pg_temp.dcs_row(v_site)::text);
	perform pg_temp.base_assert(pg_temp.sh_serve('dcs-closed-web.qorpera.site', '', v_token) ->> 'state' = 'file',
		'its sessions are as they were');
end $$;

do $$
declare
	v_site uuid := pg_temp.dcs_site('dcs-shared-web', true);
	v_first uuid := pg_temp.dcs_surface('dcs-shared-one', v_site);
	v_second uuid := pg_temp.dcs_surface('dcs-shared-two', v_site);
	v_before jsonb := pg_temp.dcs_row(v_site);
begin
	perform pg_temp.dcs_delete(v_first);
	perform pg_temp.base_assert(pg_temp.dcs_row(v_site) = v_before
		and (pg_temp.dcs_snap(v_site) ->> 'is_public')::boolean,
		'another interface still shows the website: it stays as it was: ' || pg_temp.dcs_row(v_site)::text);
	perform pg_temp.dcs_delete(v_second);
	perform pg_temp.base_assert(not (pg_temp.dcs_row(v_site) ->> 'is_public')::boolean
		and (pg_temp.dcs_row(v_site) ->> 'password_version')::integer = (v_before ->> 'password_version')::integer + 1
		and not (pg_temp.dcs_snap(v_site) ->> 'is_public')::boolean,
		'deleting the last one closes it: ' || pg_temp.dcs_row(v_site)::text);
end $$;

do $$
declare
	v_surface uuid := pg_temp.dcs_surface('dcs-no-site', null);
	v_sites jsonb := (select jsonb_agg(pg_temp.dcs_row(site.id) order by site.id) from public.qorpera_company_sites as site);
	v_result jsonb;
begin
	v_result := pg_temp.dcs_delete(v_surface);
	perform pg_temp.base_assert(v_result ->> 'status' = 'archived'
		and (select status from public.qorpera_surfaces where id = v_surface) = 'archived',
		'an interface with no website is deleted as before: ' || v_result::text);
	perform pg_temp.base_assert(
		(select jsonb_agg(pg_temp.dcs_row(site.id) order by site.id) from public.qorpera_company_sites as site) = v_sites,
		'and no site is written');
end $$;

insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
values ('13670000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'dcs-box', 'Runs the app', '92400000-0000-4000-8000-000000000030',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000001', 2, 4294967296, 21474836480, 'standard', 'always-on');
insert into public.qorpera_company_sites (id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id, kind, machine_id,
	app_port, published_at, published_by_staff_agent_id, app_auth_mode, is_public)
values ('13670000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'dcs-app-link', 'dcs-box', '92400000-0000-4000-8000-000000000030', 'app', '13670000-0000-4000-8000-0000000000a1', 3000,
	clock_timestamp(), '92400000-0000-4000-8000-000000000030', 'public', true);
insert into public.qorpera_company_site_secrets (site_id, password)
values ('13670000-0000-4000-8000-000000000030', 'dcs-app-link-password');

do $$
declare
	v_app uuid := '13670000-0000-4000-8000-000000000030';
	v_surface uuid := pg_temp.dcs_surface('dcs-app', '13670000-0000-4000-8000-000000000030');
	v_before jsonb := pg_temp.dcs_row('13670000-0000-4000-8000-000000000030');
	v_ops uuid;
begin
	perform pg_temp.dcs_delete(v_surface);
	perform pg_temp.base_assert(pg_temp.dcs_row(v_app) = v_before and v_before ->> 'app_auth_mode' = 'public'
		and (v_before ->> 'is_public')::boolean,
		'an app link is left as it is: ' || pg_temp.dcs_row(v_app)::text);

	insert into public.qorpera_surfaces (profile_id, slug, title, surface_group, archetype, status, source_kind, preview_mode)
	values (pg_temp.rel_company(), 'dcs-ops', 'Ops', 'operations', 'ops', 'active', 'native_ops', 'none')
	returning id into v_ops;
	perform pg_temp.base_error(format('select pg_temp.dcs_delete(%L)', v_ops), '55000', 'A built-in interface cannot be deleted');
	perform pg_temp.base_error(format('select pg_temp.dcs_delete(%L, %L)', v_ops, pg_temp.rel_viewer()), '42501');
	perform pg_temp.base_assert((select status from public.qorpera_surfaces where id = v_ops) = 'active',
		'a built-in interface is still not deleted');
end $$;

do $$
declare
	v_old uuid := pg_temp.dcs_site('dcs-old-web', true);
	v_kept uuid := pg_temp.dcs_site('dcs-kept-web', true);
	v_quiet uuid := pg_temp.dcs_site('dcs-quiet-web', false);
	v_old_before jsonb;
	v_kept_before jsonb;
	v_quiet_before jsonb;
	v_app_before jsonb := pg_temp.dcs_row('13670000-0000-4000-8000-000000000030');
	v_site_id uuid;
begin
	perform pg_temp.dcs_surface('dcs-old', v_old, 'archived');
	perform pg_temp.dcs_surface('dcs-kept-old', v_kept, 'archived');
	perform pg_temp.dcs_surface('dcs-kept-new', v_kept, 'proposed');
	perform pg_temp.dcs_surface('dcs-quiet', v_quiet, 'archived');
	v_old_before := pg_temp.dcs_row(v_old);
	v_kept_before := pg_temp.dcs_row(v_kept);
	v_quiet_before := pg_temp.dcs_row(v_quiet);

	for v_site_id in
		select distinct surface.site_id
		from public.qorpera_surfaces as surface
		where surface.status = 'archived' and surface.site_id is not null
		order by surface.site_id
	loop
		perform public.qorpera_surface_site_close(v_site_id);
	end loop;

	perform pg_temp.base_assert(not (pg_temp.dcs_row(v_old) ->> 'is_public')::boolean
		and (pg_temp.dcs_row(v_old) ->> 'password_version')::integer = (v_old_before ->> 'password_version')::integer + 1
		and not (pg_temp.dcs_snap(v_old) ->> 'is_public')::boolean,
		'the settling closes a public website of an interface deleted before: ' || pg_temp.dcs_row(v_old)::text);
	perform pg_temp.base_assert(pg_temp.dcs_row(v_kept) = v_kept_before,
		'a website another interface still points at stays: ' || pg_temp.dcs_row(v_kept)::text);
	perform pg_temp.base_assert(pg_temp.dcs_row(v_quiet) = v_quiet_before
		and pg_temp.dcs_row('13670000-0000-4000-8000-000000000030') = v_app_before,
		'a website that was not public and an app link are not written');
end $$;

create temporary table dcs_before as
select md5(pg_get_functiondef('public.qorpera_surface_remove(uuid,boolean)'::regprocedure)) as remove_def,
	md5(pg_get_functiondef('public.qorpera_surface_site_close(uuid)'::regprocedure)) as close_def;

\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\ir ../migrations/20260930885000_surface_delete_closes_site.sql
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.base_assert(
	:'LAST_ERROR_SQLSTATE' = 'P0001' and :'LAST_ERROR_MESSAGE' = '20260930885000 is already applied',
	'applied twice, the migration refuses: ' || :'LAST_ERROR_MESSAGE'
);
select pg_temp.base_assert(
	(select remove_def = md5(pg_get_functiondef('public.qorpera_surface_remove(uuid,boolean)'::regprocedure))
		and close_def = md5(pg_get_functiondef('public.qorpera_surface_site_close(uuid)'::regprocedure))
		from pg_temp.dcs_before),
	'and changes nothing'
);

drop function public.qorpera_surface_site_close(uuid);
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
\ir ../migrations/20260930885000_surface_delete_closes_site.sql
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
select pg_temp.base_assert(
	:'LAST_ERROR_SQLSTATE' = 'P0001'
	and :'LAST_ERROR_MESSAGE' like '20260930885000: anchor matched 0 time(s) in %qorpera_surface_remove(uuid,boolean):%',
	'a missing anchor refuses with its own error: ' || :'LAST_ERROR_MESSAGE'
);
select pg_temp.base_assert(
	(select remove_def = md5(pg_get_functiondef('public.qorpera_surface_remove(uuid,boolean)'::regprocedure)) from pg_temp.dcs_before)
		and to_regprocedure('public.qorpera_surface_site_close(uuid)') is null,
	'and changes nothing'
);

rollback;
