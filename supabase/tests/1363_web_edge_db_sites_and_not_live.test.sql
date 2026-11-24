-- @fixture 1252_site_hosts.test.sql until "-- 1. Rights, the columns and their rules, the markers"
create function pg_temp.wf_file(p_version uuid, p_path text, p_text text, p_type text default 'text/html; charset=utf-8')
returns void language sql as $$
	insert into public.qorpera_company_site_files (version_id, path, bytes, sha256, content_type, content)
	values (p_version, p_path, octet_length(convert_to(p_text, 'utf8')), pg_temp.sh_sha(p_text), p_type, convert_to(p_text, 'utf8'))
$$;

create function pg_temp.wf_version(p_site uuid, p_state text, p_files integer) returns uuid language sql as $$
	insert into public.qorpera_company_site_versions (
		site_id, state, run_id, call_id, staff_agent_id, first_publish, title, source_path, manifest_sha256,
		file_count, total_bytes, published_at
	) values (
		p_site, p_state, extensions.gen_random_uuid(), 'call-' || extensions.gen_random_uuid()::text,
		'92400000-0000-4000-8000-000000000030', false, null, 'sites/web', repeat('d', 64), p_files, 64,
		case when p_state in ('live', 'kept') then clock_timestamp() end
	) returning id
$$;

create function pg_temp.wf_ready(p_site uuid, p_tree text) returns uuid language sql as $$
	insert into public.qorpera_company_site_versions (
		site_id, state, first_publish, title, source_path, manifest_sha256, file_count, total_bytes, tree, change, main_sha, listed
	) values (
		p_site, 'ready', false, null, 'sites/web', repeat('e', 64), 1, 32, p_tree, 1, repeat('f', 40), true
	) returning id
$$;

create function pg_temp.wf_site(p_slug text) returns uuid language sql as $$
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_slug, 'sites/web',
		'92400000-0000-4000-8000-000000000030')
	returning id
$$;

create function pg_temp.wf_as(p_role text, p_site uuid, p_version uuid, p_path text) returns bytea language plpgsql as $$
declare v bytea;
begin
	if p_role = 'service_role' then
		perform pg_temp.base_claims('service_role');
	else
		perform set_config('request.jwt.claims', '{}', true);
	end if;
	execute format('set local role %I', p_role);
	execute format('select public.qorpera_web_edge_site_file(%L::uuid, %L::uuid, %L)', p_site, p_version, p_path) into v;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;

create function pg_temp.wf_snap_site(p_slug text) returns jsonb language sql as $$
	select s from jsonb_array_elements(pg_temp.rel_exec('public.qorpera_web_edge_snapshot()') -> 'sites') as s
	where s ->> 'slug' = p_slug
$$;

update public.qorpera_site_settings
set enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true, public_enabled = true,
	domains_enabled = true, apps_enabled = true;

insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
values ('13630000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'notch-box', 'Runs the app', '92400000-0000-4000-8000-000000000030',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000001', 2, 4294967296, 21474836480, 'standard', 'always-on');
insert into public.qorpera_company_sites (id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id, kind, machine_id,
	app_port, published_at, published_by_staff_agent_id)
values ('13630000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'notch-app-link', 'notch-box', '92400000-0000-4000-8000-000000000030', 'app', '13630000-0000-4000-8000-0000000000a1', 3000,
	clock_timestamp(), '92400000-0000-4000-8000-000000000030');
insert into public.qorpera_company_site_secrets (site_id, password)
values ('13630000-0000-4000-8000-000000000030', 'notch-app-link-password');

do $$
declare v_role text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay',
		'qorpera_web_router'] loop
		perform pg_temp.base_assert(
			has_function_privilege(v_role, 'public.qorpera_web_edge_site_file(uuid,uuid,text)', 'EXECUTE')
				= (v_role in ('service_role', 'qorpera_web_router')),
			'site file execute privilege mismatch for ' || v_role);
		perform pg_temp.base_assert(
			not has_function_privilege(v_role, 'public.qorpera_web_edge_db_servable(uuid,uuid)', 'EXECUTE')
				and not has_function_privilege(v_role, 'public.qorpera_web_edge_db_manifest(uuid)', 'EXECUTE'),
			'helpers closed to ' || v_role);
	end loop;
	perform pg_temp.base_assert(
		(select prosecdef from pg_proc where oid = 'public.qorpera_web_edge_site_file(uuid,uuid,text)'::regprocedure)
			and not (select prosecdef from pg_proc where oid = 'public.qorpera_web_edge_db_servable(uuid,uuid)'::regprocedure)
			and not (select prosecdef from pg_proc where oid = 'public.qorpera_web_edge_db_manifest(uuid)'::regprocedure),
		'only the RPC is security definer');
	perform pg_temp.base_assert(
		strpos(pg_get_functiondef('public.qorpera_web_edge_site_file(uuid,uuid,text)'::regprocedure),
			$g$auth.role() is distinct from 'service_role' and session_user not in ('postgres', 'service_role', 'qorpera_web_router')$g$) > 0,
		'the RPC has the edge RPCs'' guard');
end $$;

do $$
declare
	v_web uuid := pg_temp.wf_site('notch-db-web');
	v_open uuid := pg_temp.wf_site('notch-db-open');
	v_dep uuid := pg_temp.wf_site('notch-dep-web');
	v_bare uuid := pg_temp.wf_site('notch-bare-web');
	v_live uuid; v_kept uuid; v_ready uuid; v_upload uuid; v_open_live uuid; v_dep_ver uuid;
begin
	insert into public.qorpera_company_site_secrets (site_id, password) values
		(v_web, 'notch-web-password'), (v_open, 'notch-open-password'), (v_dep, 'notch-dep-password'), (v_bare, 'notch-bare-password');

	v_live := pg_temp.wf_version(v_web, 'live', 3);
	perform pg_temp.wf_file(v_live, 'index.html', '<h1>live</h1>');
	perform pg_temp.wf_file(v_live, '404.html', '<h1>none here</h1>');
	perform pg_temp.wf_file(v_live, 'data.bin', 'raw', 'Weird Type');
	v_kept := pg_temp.wf_version(v_web, 'kept', 1);
	perform pg_temp.wf_file(v_kept, 'index.html', '<h1>kept</h1>');
	v_ready := pg_temp.wf_ready(v_web, repeat('7', 40));
	perform pg_temp.wf_file(v_ready, 'index.html', '<h1>next</h1>');
	v_upload := pg_temp.wf_version(v_web, 'uploading', 1);
	insert into public.qorpera_company_site_files (version_id, path, bytes, sha256, content_type, content)
	values (v_upload, 'index.html', 4, repeat('a', 64), 'text/html; charset=utf-8', null);
	update public.qorpera_company_sites set current_version_id = v_live where id = v_web;

	v_open_live := pg_temp.wf_version(v_open, 'live', 1);
	perform pg_temp.wf_file(v_open_live, 'index.html', '<h1>open</h1>');
	update public.qorpera_company_sites set current_version_id = v_open_live, is_public = true where id = v_open;

	v_dep_ver := pg_temp.wf_version(v_dep, 'live', 1);
	perform pg_temp.wf_file(v_dep_ver, 'index.html', '<h1>deployed</h1>');
	insert into public.qorpera_company_site_deployments (
		site_id, profile_id, version_number, version_id, kind, state, manifest_sha256, manifest_json, file_count, total_bytes,
		has_credential_inputs
	) values (
		v_dep, '92400000-0000-4000-8000-000000000010', 1, v_dep_ver, 'static', 'ready', repeat('c', 64),
		jsonb_build_object('files', jsonb_build_object('index.html', jsonb_build_object(
			'sha256', pg_temp.sh_sha('<h1>deployed</h1>'), 'bytes', 17, 'content_type', 'text/html; charset=utf-8'))),
		1, 17, false
	);
	update public.qorpera_company_sites set current_version_id = v_dep_ver where id = v_dep;
	perform pg_temp.base_assert((select live_deployment_id is not null from public.qorpera_company_sites where id = v_dep),
		'the deployment is live');

	perform set_config('qorpera_test.wf_web', v_web::text, true);
	perform set_config('qorpera_test.wf_open', v_open::text, true);
	perform set_config('qorpera_test.wf_dep', v_dep::text, true);
	perform set_config('qorpera_test.wf_bare', v_bare::text, true);
	perform set_config('qorpera_test.wf_live', v_live::text, true);
	perform set_config('qorpera_test.wf_kept', v_kept::text, true);
	perform set_config('qorpera_test.wf_ready', v_ready::text, true);
	perform set_config('qorpera_test.wf_upload', v_upload::text, true);
	perform set_config('qorpera_test.wf_open_live', v_open_live::text, true);
	perform set_config('qorpera_test.wf_dep_ver', v_dep_ver::text, true);
end $$;

do $$
declare
	v_web jsonb := pg_temp.wf_snap_site('notch-db-web');
	v_open jsonb := pg_temp.wf_snap_site('notch-db-open');
	v_dep jsonb := pg_temp.wf_snap_site('notch-dep-web');
	v_bare jsonb := pg_temp.wf_snap_site('notch-bare-web');
	v_app jsonb := pg_temp.wf_snap_site('notch-app-link');
	v_live text := current_setting('qorpera_test.wf_live');
	v_kept text := current_setting('qorpera_test.wf_kept');
	v_ready text := current_setting('qorpera_test.wf_ready');
	v_open_live text := current_setting('qorpera_test.wf_open_live');
	v_snap jsonb := pg_temp.rel_exec('public.qorpera_web_edge_snapshot()');
begin
	perform pg_temp.base_assert(v_web -> 'password_sha256' = 'null' and v_dep -> 'password_sha256' = 'null'
		and v_bare -> 'password_sha256' = 'null', 'a website that is not public has no hash');
	perform pg_temp.base_assert(v_open ->> 'password_sha256' = pg_temp.sh_sha('notch-open-password'), 'a public website keeps its hash');
	perform pg_temp.base_assert(v_app ->> 'password_sha256' = pg_temp.sh_sha('notch-app-link-password'), 'an app link keeps its hash');
	perform pg_temp.base_assert(not exists (
		select 1 from jsonb_array_elements(v_snap -> 'sites') as s
		join public.qorpera_company_sites as site on site.id = (s ->> 'id')::uuid
		where site.kind = 'files' and not site.is_public and s ->> 'password_sha256' is not null
	), 'no website that is not public has a hash');
	perform pg_temp.base_assert(pg_temp.sh_sha('notch-web-password') is distinct from v_web ->> 'password_sha256'
		and pg_temp.sh_sha('notch-app-link-password') = v_app ->> 'password_sha256',
		'the right old password matches nothing for the website, still the app link''s hash');

	perform pg_temp.base_assert(v_web -> 'db_live' = jsonb_build_object(
		'id', 'db:' || v_live,
		'kind', 'static',
		'manifest', jsonb_build_object('files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', pg_temp.sh_sha('<h1>live</h1>'), 'bytes', 13, 'content_type', 'text/html; charset=utf-8'),
			'404.html', jsonb_build_object('sha256', pg_temp.sh_sha('<h1>none here</h1>'), 'bytes', 18, 'content_type', 'text/html; charset=utf-8'),
			'data.bin', jsonb_build_object('sha256', pg_temp.sh_sha('raw'), 'bytes', 3, 'content_type', 'application/octet-stream')))
	), 'db_live is the current version''s files: ' || coalesce((v_web -> 'db_live')::text, 'null'));
	perform pg_temp.base_assert(
		(select array_agg(k order by k) from jsonb_object_keys(v_web -> 'db_previews') as k)
			= (select array_agg(k order by k) from unnest(array[v_live, v_kept, v_ready]) as k),
		'db_previews: the live, kept and ready versions, never one uploading: ' || (v_web -> 'db_previews')::text);
	perform pg_temp.base_assert(v_web -> 'db_previews' -> v_ready = jsonb_build_object(
		'id', 'db:' || v_ready,
		'kind', 'static',
		'manifest', jsonb_build_object('files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', pg_temp.sh_sha('<h1>next</h1>'), 'bytes', 13, 'content_type', 'text/html; charset=utf-8')))
	), 'the next version''s files');
	perform pg_temp.base_assert(v_web -> 'live_deployment' = 'null' and v_web -> 'preview_deployments' = '{}', 'no deployment');
	perform pg_temp.base_assert(v_open -> 'db_live' ->> 'id' = 'db:' || v_open_live, 'a public website stored in the database');

	perform pg_temp.base_assert(v_dep -> 'db_live' = 'null' and v_dep -> 'db_previews' = '{}'
		and v_dep -> 'live_deployment' ->> 'kind' = 'static'
		and v_dep -> 'live_deployment' -> 'manifest' -> 'files' ? 'index.html', 'a site with a deployment: unchanged');
	perform pg_temp.base_assert(v_bare -> 'db_live' = 'null' and v_bare -> 'db_previews' = '{}'
		and v_bare -> 'live_deployment' = 'null', 'a site with neither');
	perform pg_temp.base_assert(v_app -> 'db_live' = 'null' and v_app -> 'db_previews' = '{}', 'an app link: none');
end $$;

do $$
declare
	v_web uuid := current_setting('qorpera_test.wf_web')::uuid;
	v_open uuid := current_setting('qorpera_test.wf_open')::uuid;
	v_dep uuid := current_setting('qorpera_test.wf_dep')::uuid;
	v_bare uuid := current_setting('qorpera_test.wf_bare')::uuid;
	v_live uuid := current_setting('qorpera_test.wf_live')::uuid;
	v_kept uuid := current_setting('qorpera_test.wf_kept')::uuid;
	v_ready uuid := current_setting('qorpera_test.wf_ready')::uuid;
	v_upload uuid := current_setting('qorpera_test.wf_upload')::uuid;
	v_open_live uuid := current_setting('qorpera_test.wf_open_live')::uuid;
	v_dep_ver uuid := current_setting('qorpera_test.wf_dep_ver')::uuid;
	v_role text;
begin
	perform pg_temp.base_assert(
		pg_temp.wf_as('qorpera_web_router', v_web, v_live, 'index.html') = convert_to('<h1>live</h1>', 'utf8')
			and pg_temp.wf_as('service_role', v_web, v_live, '404.html') = convert_to('<h1>none here</h1>', 'utf8')
			and pg_temp.wf_as('qorpera_web_router', v_web, v_kept, 'index.html') = convert_to('<h1>kept</h1>', 'utf8')
			and pg_temp.wf_as('qorpera_web_router', v_web, v_ready, 'index.html') = convert_to('<h1>next</h1>', 'utf8')
			and pg_temp.wf_as('qorpera_web_router', v_open, v_open_live, 'index.html') = convert_to('<h1>open</h1>', 'utf8'),
		'the router reads a stored website''s files');
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker', 'qorpera_site_relay'] loop
		perform pg_temp.base_error(format('select pg_temp.wf_as(%L, %L, %L, %L)', v_role, v_web, v_live, 'index.html'), '42501');
	end loop;
	perform pg_temp.base_error(
		format('select pg_temp.req_as(%L, %L)', pg_temp.req_owner(),
			format('public.qorpera_web_edge_site_file(%L, %L, %L)::text::jsonb', v_web, v_live, 'index.html')),
		'42501');
	perform pg_temp.base_assert(
		pg_temp.wf_as('qorpera_web_router', v_web, v_live, 'nothing.html') is null
			and pg_temp.wf_as('qorpera_web_router', v_web, v_live, '/index.html') is null
			and pg_temp.wf_as('qorpera_web_router', v_web, v_live, null) is null
			and pg_temp.wf_as('qorpera_web_router', v_web, v_upload, 'index.html') is null
			and pg_temp.wf_as('qorpera_web_router', v_open, v_live, 'index.html') is null
			and pg_temp.wf_as('qorpera_web_router', v_web, v_open_live, 'index.html') is null
			and pg_temp.wf_as('qorpera_web_router', v_dep, v_dep_ver, 'index.html') is null
			and pg_temp.wf_as('qorpera_web_router', v_bare, v_live, 'index.html') is null
			and pg_temp.wf_as('qorpera_web_router', '13630000-0000-4000-8000-000000000030', v_live, 'index.html') is null,
		'nothing for a path, version or site the router does not serve');

	perform public.qorpera_site_take_down('notch-db-web', 'Reported.');
	perform pg_temp.base_assert(pg_temp.wf_as('qorpera_web_router', v_web, v_live, 'index.html') is null
		and pg_temp.wf_snap_site('notch-db-web') -> 'db_live' = 'null'
		and pg_temp.wf_snap_site('notch-db-web') -> 'db_previews' = '{}'
		and (pg_temp.wf_snap_site('notch-db-web') ->> 'taken_down')::boolean, 'taken down: nothing');
	perform public.qorpera_site_restore('notch-db-web');
	perform pg_temp.base_assert(pg_temp.wf_as('qorpera_web_router', v_web, v_live, 'index.html') is not null
		and pg_temp.wf_snap_site('notch-db-web') -> 'db_live' ->> 'id' = 'db:' || v_live, 'restored');

	begin
		insert into public.qorpera_company_deletions (profile_id) values (pg_temp.rel_company());
		perform pg_temp.base_assert(pg_temp.wf_as('qorpera_web_router', v_web, v_live, 'index.html') is null
			and pg_temp.wf_snap_site('notch-db-web') -> 'db_live' = 'null', 'a company being deleted: nothing');
		raise exception 'undo' using errcode = 'QWF01';
	exception when sqlstate 'QWF01' then null;
	end;

	update public.qorpera_company_site_files set content = null where version_id = v_kept;
	perform pg_temp.base_assert(pg_temp.wf_as('qorpera_web_router', v_web, v_kept, 'index.html') is null
		and not (pg_temp.wf_snap_site('notch-db-web') -> 'db_previews' ? v_kept::text), 'a version missing bytes is not served');
	update public.qorpera_company_site_files set content = convert_to('<h1>kept</h1>', 'utf8') where version_id = v_kept;
end $$;

do $$
declare
	v_web uuid := current_setting('qorpera_test.wf_web')::uuid;
	v_ready uuid := current_setting('qorpera_test.wf_ready')::uuid;
	v_res jsonb;
	v_ticket text := public.qorpera_site_new_secret();
begin
	v_res := pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_site_member_pass(%L)', v_web));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open' and v_res ->> 'host' = 'notch-db-web.qorpera.site', 'a member''s pass: ' || v_res::text);
	v_res := pg_temp.rel_exec(format('public.qorpera_web_edge_redeem_member_pass(%L, %L)', 'notch-db-web.qorpera.site', v_res ->> 'pass'));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open' and v_res ->> 'site_id' = v_web::text
		and (v_res ->> 'password_version')::integer = (pg_temp.sh_site('notch-db-web')).password_version, 'it opens: ' || v_res::text);

	insert into public.qorpera_company_site_tickets (ticket_sha256, site_id, version_id, user_id, expires_at)
	values (public.qorpera_site_sha256(v_ticket), v_web, v_ready, pg_temp.req_owner(), clock_timestamp() + interval '2 minutes');
	v_res := pg_temp.rel_exec(format('public.qorpera_web_edge_redeem_ticket(%L, %L)', 'notch-db-web--next.qorpera.site', v_ticket));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open' and v_res ->> 'version_id' = v_ready::text, 'Look first opens: ' || v_res::text);
	perform pg_temp.base_assert(pg_temp.wf_snap_site('notch-db-web') -> 'db_previews' ? v_ready::text, 'and the router has its files');

	v_res := pg_temp.rel_exec(format('public.qorpera_site_app_unlock(%L, %L, %L)', 'notch-app-link', 'notch-app-link-password', '192.0.2.63'));
	perform pg_temp.base_assert(v_res ->> 'state' = 'open', 'the app link''s password opens it: ' || v_res::text);
end $$;

do $$
declare
	v_before jsonb := (select jsonb_object_agg(slug, password_version) from public.qorpera_company_sites
		where slug in ('notch-db-web', 'notch-db-open', 'notch-dep-web', 'notch-bare-web', 'notch-app-link'));
	v_after jsonb;
	v_token text := repeat('W', 32);
begin
	insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at)
	values (pg_temp.sh_sha(v_token), current_setting('qorpera_test.wf_web')::uuid, (v_before ->> 'notch-db-web')::integer,
		clock_timestamp() + interval '1 day');
	perform pg_temp.base_assert(pg_temp.sh_serve('notch-db-web.qorpera.site', '', v_token) ->> 'state' = 'file',
		'the session opens it before the bump: ' || pg_temp.sh_serve('notch-db-web.qorpera.site', '', v_token)::text);

	update public.qorpera_company_sites as site
	set password_version = site.password_version + 1
	where site.kind = 'files'
		and not (site.is_public and coalesce((
			select settings.enabled and settings.public_enabled from public.qorpera_site_settings as settings limit 1
		), false));

	v_after := (select jsonb_object_agg(slug, password_version) from public.qorpera_company_sites
		where slug in ('notch-db-web', 'notch-db-open', 'notch-dep-web', 'notch-bare-web', 'notch-app-link'));
	perform pg_temp.base_assert((v_after ->> 'notch-db-web')::integer = (v_before ->> 'notch-db-web')::integer + 1
		and (v_after ->> 'notch-dep-web')::integer = (v_before ->> 'notch-dep-web')::integer + 1
		and (v_after ->> 'notch-bare-web')::integer = (v_before ->> 'notch-bare-web')::integer + 1
		and v_after -> 'notch-db-open' = v_before -> 'notch-db-open'
		and v_after -> 'notch-app-link' = v_before -> 'notch-app-link', 'the bump: ' || v_before::text || ' ' || v_after::text);
	perform pg_temp.base_assert((pg_temp.wf_snap_site('notch-db-web') ->> 'password_version')::integer
		= (v_after ->> 'notch-db-web')::integer, 'the router reads the new version');
	perform pg_temp.base_assert(pg_temp.sh_serve('notch-db-web.qorpera.site', '', v_token) ->> 'state' = 'locked',
		'a session from before the bump is refused: ' || pg_temp.sh_serve('notch-db-web.qorpera.site', '', v_token)::text);
end $$;
