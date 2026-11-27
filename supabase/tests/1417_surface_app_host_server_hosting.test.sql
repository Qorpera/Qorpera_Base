-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create or replace function pg_temp.sahs_assert(p_ok boolean, p_msg text)
returns void language plpgsql as $$
begin
	if not coalesce(p_ok, false) then
		raise exception '1417_surface_app_host_server_hosting failed: %', p_msg;
	end if;
end $$;

create or replace function pg_temp.sahs_as(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create or replace function pg_temp.sahs_service(p_sql text)
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
	v_other_owner constant uuid := '14170000-0000-4000-8000-000000000002';
	v_company_b constant uuid := '14170000-0000-4000-8000-000000000012';
	v_env_a uuid;
	v_env_b constant uuid := '14170000-0000-4000-8000-000000000022';
	v_surface uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_s1 uuid;
	v_c1 uuid;
	v_sel jsonb;
	v_p1 uuid;
	v_claimed jsonb;
	v_lease uuid;
	v_req jsonb;
	v_build_id uuid;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding_claim jsonb;
	v_b_lease uuid;
	v_manifest jsonb;
	v_empty_manifest jsonb := '{"files":{},"redirects":[],"headers":[],"spa_fallback":null,"not_found_page":null}'::jsonb;
	v_recipe constant jsonb := '{"run":"npm run build","cwd":".","folder":"dist","timeoutSeconds":180}';
	v_reg_live_1 jsonb;
	v_reg_live_2 jsonb;
	v_reg_preview_1 jsonb;
	v_reg_preview_2 jsonb;
	v_set_up jsonb;
	v_due jsonb;
	v_stopped jsonb;
	v_snap jsonb;
	v_site_snap jsonb;
	v_dep_live_1 uuid;
	v_dep_live_2 uuid;
	v_dep_prev_1 uuid;
	v_dep_prev_2 uuid;
	v_ver_prev_1 uuid;
	v_img_1 text := '127.0.0.1:5000/qorpera-apps/demo@sha256:' || repeat('1', 64);
	v_img_2 text := '127.0.0.1:5000/qorpera-apps/demo@sha256:' || repeat('2', 64);
	v_img_prev text := '127.0.0.1:5000/qorpera-apps/demo@sha256:' || repeat('3', 64);
	v_function text;
begin
	foreach v_function in array array[
		'public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)',
		'public.qorpera_surface_site_deployment_set_upstream(uuid,text)',
		'public.qorpera_surface_stale_app_deployments_due(integer)',
		'public.qorpera_surface_app_deployment_mark_stopped(uuid,text,boolean,boolean,boolean)',
		'public.qorpera_surface_request_build(text,uuid,uuid,text,text,jsonb,text,boolean)'
	] loop
		perform pg_temp.sahs_assert(
			has_function_privilege('service_role', v_function, 'EXECUTE')
			and not has_function_privilege('authenticated', v_function, 'EXECUTE')
			and not has_function_privilege('anon', v_function, 'EXECUTE'),
			v_function || ' must be service_role only'
		);
	end loop;

	update public.qorpera_site_settings set enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true;
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select environment_id into strict v_env_a from public.qorpera_company_cofounders where profile_id = v_company;
	insert into auth.users(id, email) values (v_other_owner, 'owner-1417-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1417', true, array['codex']);

	perform pg_temp.sahs_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company, 'Portal App', 'portal-app', 'live_build', 'web_app', 'monitor', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_s1 := (public.qorpera_start_surface_session(v_surface, 'API update', 'API update') ->> 'id')::uuid;
	reset role;

	select site.* into strict v_site
	from public.qorpera_surfaces sf join public.qorpera_company_sites site on site.id = sf.site_id
	where sf.id = v_surface;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface;

	v_reg_live_1 := pg_temp.sahs_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 0, 0, false, false, %L, null, 'server', %L, 3000, '/health', 900, 512, 1.0, null, '{"PORT":"3000"}'::jsonb)$q$,
		v_surface, repeat('a', 40), repeat('a', 64), v_empty_manifest::text, repeat('1', 40), v_img_1
	));
	v_dep_live_1 := (v_reg_live_1 ->> 'deploymentId')::uuid;
	perform pg_temp.sahs_assert(
		v_reg_live_1 ->> 'kind' = 'server'
		and v_reg_live_1 ->> 'state' = 'ready'
		and (select preview_mode from public.qorpera_surfaces where id = v_surface) = 'app_proxy'
		and (select live_deployment_id from public.qorpera_company_sites where id = v_site.id) is null,
		'server deployment step 1 registers ready deployment without promoting live: ' || v_reg_live_1::text
	);

	v_reg_live_1 := pg_temp.sahs_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 0, 0, false, true, %L, null, 'server', %L, 3000, '/health', 900, 512, 1.0, '127.0.0.1:41001', '{"PORT":"3000"}'::jsonb)$q$,
		v_surface, repeat('a', 40), repeat('a', 64), v_empty_manifest::text, repeat('1', 40), v_img_1
	));
	perform pg_temp.sahs_assert(
		(v_reg_live_1 ->> 'deploymentId')::uuid = v_dep_live_1
		and v_reg_live_1 ->> 'state' = 'live'
		and (select live_deployment_id = v_dep_live_1 and deployment_kind = 'server' from public.qorpera_company_sites where id = v_site.id)
		and (select upstream_addr = '127.0.0.1:41001' and state = 'live' and oci_image_ref = v_img_1 from public.qorpera_company_site_deployments where id = v_dep_live_1),
		'server deployment step 2 promotes same deployment row to live with upstream_addr: ' || v_reg_live_1::text
	);

	v_reg_preview_1 := pg_temp.sahs_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 0, 0, false, false, %L, 'Preview p1', 'server', %L, 3000, '/health', 900, 512, 1.0, null, '{"PORT":"3000"}'::jsonb)$q$,
		v_surface, repeat('b', 40), repeat('a', 64), v_empty_manifest::text, repeat('2', 40), v_img_prev
	));
	v_dep_prev_1 := (v_reg_preview_1 ->> 'deploymentId')::uuid;
	v_ver_prev_1 := (v_reg_preview_1 ->> 'versionId')::uuid;
	perform pg_temp.sahs_assert(
		v_dep_prev_1 <> v_dep_live_1
		and (select live_deployment_id from public.qorpera_company_sites where id = v_site.id) = v_dep_live_1,
		'distinct server OCI image gets its own deploymentId even with identical empty manifest_sha256'
	);

	v_set_up := pg_temp.sahs_service(format(
		$q$select public.qorpera_surface_site_deployment_set_upstream(%L, '127.0.0.1:41002')$q$,
		v_dep_prev_1
	));
	perform pg_temp.sahs_assert(
		v_set_up ->> 'upstreamAddr' = '127.0.0.1:41002'
		and (select upstream_addr from public.qorpera_company_site_deployments where id = v_dep_prev_1) = '127.0.0.1:41002',
		'set_upstream writes preview container upstream address'
	);

	v_snap := public.qorpera_web_edge_snapshot();
	select elem into strict v_site_snap
	from jsonb_array_elements(v_snap -> 'sites') elem where (elem ->> 'id')::uuid = v_site.id;
	perform pg_temp.sahs_assert(
		v_site_snap #>> '{live_deployment,id}' = v_dep_live_1::text
		and v_site_snap #>> '{live_deployment,upstream_addr}' = '127.0.0.1:41001'
		and v_site_snap #>> array['preview_deployments', v_ver_prev_1::text, 'id'] = v_dep_prev_1::text
		and v_site_snap #>> array['preview_deployments', v_ver_prev_1::text, 'upstream_addr'] = '127.0.0.1:41002',
		'edge snapshot exposes both live and preview server deployments with distinct upstreams'
	);

	v_reg_live_2 := pg_temp.sahs_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 0, 0, false, true, %L, null, 'server', %L, 3000, '/health', 900, 512, 1.0, '127.0.0.1:41003', '{"PORT":"3000"}'::jsonb)$q$,
		v_surface, repeat('c', 40), repeat('c', 64), v_empty_manifest::text, repeat('3', 40), v_img_2
	));
	v_dep_live_2 := (v_reg_live_2 ->> 'deploymentId')::uuid;
	perform pg_temp.sahs_assert(
		v_dep_live_2 <> v_dep_live_1
		and not exists (
			select 1 from public.qorpera_company_site_deployments
			where id = v_dep_live_1 and (state = 'live' or upstream_addr is not null)
		)
		and (select live_deployment_id = v_dep_live_2 from public.qorpera_company_sites where id = v_site.id),
		'promoting new server live deployment clears previous live server deployment and upstream'
	);

	v_c1 := (public.qorpera_record_surface_change(v_s1, 'Hybrid route', 'Hybrid route', 'git_range',
		repeat('1', 40), repeat('4', 40), '{}'::uuid[], array['server.js'], null, null, false) ->> 'changeId')::uuid;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('14170000-0000-4000-8000-0000000000d1', 'member', v_company, v_env_a, v_owner, 'exec-1417', repeat('9', 64), '{}');
	set local session_replication_role = origin;

	perform pg_temp.sahs_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface, array[v_c1], null, '{}'::uuid[], '/');
	reset role;
	v_p1 := (v_sel #>> '{primary,previewId}')::uuid;

	v_claimed := pg_temp.sahs_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'previews') elem where (elem ->> 'previewId')::uuid = v_p1;

	v_req := pg_temp.sahs_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L, null, true)',
		'preview', v_p1, v_lease, repeat('4', 40), repeat('d', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	perform pg_temp.sahs_assert(
		v_req ->> 'state' = 'waiting'
		and (select defer_settle from public.qorpera_surface_preview_builds where id = v_build_id),
		'defer_settle build parks hybrid preview with defer_settle=true'
	);

	select * into strict v_builder from public.qorpera_surface_preview_builders where surface_id = v_surface and member_user_id = v_owner;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;

	v_coding_claim := pg_temp.sahs_service($q$select public.qorpera_claim_coding_session('exec-1417', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.sahs_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));

	v_manifest := jsonb_build_object(
		'files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', repeat('5', 64), 'bytes', 64, 'content_type', 'text/html; charset=utf-8', 'immutable', false)
		),
		'redirects', '[]'::jsonb,
		'headers', '[]'::jsonb,
		'spa_fallback', 'index.html',
		'not_found_page', null
	);
	perform pg_temp.sahs_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 1, 64, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', repeat('e', 64), v_manifest::text
	));

	perform pg_temp.sahs_assert(
		(select status = 'composing' and site_version_id is null and build_id = v_build_id from public.qorpera_surface_previews where id = v_p1),
		'defer_settle=true returns hybrid preview to composing for Pass 2 instead of settling as static'
	);

	update public.qorpera_surface_previews set status = 'ready', site_version_id = v_ver_prev_1, expires_at = clock_timestamp() + interval '1 hour' where id = v_p1;
	v_due := pg_temp.sahs_service('select public.qorpera_surface_stale_app_deployments_due(16)');
	perform pg_temp.sahs_assert(
		not exists (select 1 from jsonb_array_elements(v_due) elem where (elem ->> 'deploymentId')::uuid in (v_dep_prev_1, v_dep_live_2)),
		'unexpired preview and live deployment are not returned as stale: ' || v_due::text
	);

	update public.qorpera_company_site_deployments set updated_at = clock_timestamp() - interval '3 minutes' where id = v_dep_prev_1;
	update public.qorpera_surface_previews set expires_at = clock_timestamp() - interval '1 minute' where id = v_p1;
	v_due := pg_temp.sahs_service('select public.qorpera_surface_stale_app_deployments_due(16)');
	perform pg_temp.sahs_assert(
		exists (select 1 from jsonb_array_elements(v_due) elem where (elem ->> 'deploymentId')::uuid = v_dep_prev_1)
		and not exists (select 1 from jsonb_array_elements(v_due) elem where (elem ->> 'deploymentId')::uuid = v_dep_live_2),
		'expired preview deployment becomes due for stop while live deployment is excluded: ' || v_due::text
	);

	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L, %L, false, false, true)', v_dep_prev_1, '127.0.0.1:41002'));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'claimed')::boolean = true and (v_stopped ->> 'stopped')::boolean = false,
		'claim_only atomically claims stale deployment before app-host stop: ' || v_stopped::text
	);
	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L, %L, false, false, true)', v_dep_prev_1, '127.0.0.1:41002'));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'claimed')::boolean = false,
		'second concurrent claim_only is refused while first stop claim holds backoff window: ' || v_stopped::text
	);
	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L, null, true, false, true)', v_dep_live_2));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'claimed')::boolean = false and (v_stopped ->> 'isLive')::boolean = true,
		'forced claim_only reports isLive=true for active live deployment: ' || v_stopped::text
	);
	update public.qorpera_company_site_deployments set last_stop_attempt_at = null where id = v_dep_prev_1;

	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L, %L, false, true)', v_dep_prev_1, '127.0.0.1:41002'));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'stopped')::boolean = false and (v_stopped ->> 'backedOff')::boolean = true,
		'failed stop attempt records backoff without marking stopped: ' || v_stopped::text
	);
	v_due := pg_temp.sahs_service('select public.qorpera_surface_stale_app_deployments_due(16)');
	perform pg_temp.sahs_assert(
		not exists (select 1 from jsonb_array_elements(v_due) elem where (elem ->> 'deploymentId')::uuid = v_dep_prev_1),
		'backed-off failing stop is temporarily skipped by stale sweep: ' || v_due::text
	);
	update public.qorpera_company_site_deployments set last_stop_attempt_at = clock_timestamp() - interval '6 minutes' where id = v_dep_prev_1;

	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L, %L)', v_dep_prev_1, '127.0.0.1:9999'));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'stopped')::boolean = false
		and (select state from public.qorpera_company_site_deployments where id = v_dep_prev_1) = 'ready',
		'mark_stopped refuses mismatched expected upstream_addr'
	);

	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L)', v_dep_live_2));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'stopped')::boolean = false
		and (select state from public.qorpera_company_site_deployments where id = v_dep_live_2) = 'live',
		'mark_stopped refuses to stop the active live deployment'
	);

	v_stopped := pg_temp.sahs_service(format('select public.qorpera_surface_app_deployment_mark_stopped(%L, %L)', v_dep_prev_1, '127.0.0.1:41002'));
	perform pg_temp.sahs_assert(
		(v_stopped ->> 'stopped')::boolean = true
		and (select state = 'stopped' and upstream_addr is null from public.qorpera_company_site_deployments where id = v_dep_prev_1),
		'mark_stopped transitions expired preview deployment to stopped and clears upstream'
	);

	v_snap := public.qorpera_web_edge_snapshot();
	select elem into strict v_site_snap
	from jsonb_array_elements(v_snap -> 'sites') elem where (elem ->> 'id')::uuid = v_site.id;
	perform pg_temp.sahs_assert(
		not (v_site_snap -> 'preview_deployments' ? v_ver_prev_1::text),
		'edge snapshot excludes stopped preview deployments'
	);

	v_reg_preview_2 := pg_temp.sahs_service(format(
		$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 0, 0, false, false, %L, 'Preview p1 again', 'server', %L, 3000, '/health', 900, 512, 1.0, '127.0.0.1:41009', '{"PORT":"3000"}'::jsonb)$q$,
		v_surface, repeat('b', 40), repeat('a', 64), v_empty_manifest::text, repeat('2', 40), v_img_prev
	));
	v_dep_prev_2 := (v_reg_preview_2 ->> 'deploymentId')::uuid;
	perform pg_temp.sahs_assert(
		v_dep_prev_2 = v_dep_prev_1
		and (select state = 'ready' and upstream_addr = '127.0.0.1:41009' and stopped_at is null from public.qorpera_company_site_deployments where id = v_dep_prev_1),
		're-registering a previously stopped preview deployment reactivates it cleanly'
	);
	v_due := pg_temp.sahs_service('select public.qorpera_surface_stale_app_deployments_due(16)');
	perform pg_temp.sahs_assert(
		not exists (select 1 from jsonb_array_elements(v_due) elem where (elem ->> 'deploymentId')::uuid = v_dep_prev_1),
		'freshly re-registered preview deployment gets a new 2-minute grace window despite old expired preview'
	);

	begin
		update public.qorpera_company_sites set is_public = true where id = v_site.id;
		perform pg_temp.sahs_service(format(
			$q$select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 1, 64, true, false, %L, null, 'hybrid', %L, 3000, '/health', 900, 512, 1.0, null, '{"PORT":"3000"}'::jsonb, true)$q$,
			v_surface, repeat('e', 40), repeat('f', 64), v_manifest::text, repeat('4', 40), v_img_2
		));
		raise exception 'expected SITE_CONTAINS_CREDENTIAL_INPUTS on p_check_public_promote pre-check';
	exception when others then
		perform pg_temp.sahs_assert(sqlerrm = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'pre-check refused with: ' || sqlerrm);
	end;
	update public.qorpera_company_sites set is_public = false where id = v_site.id;

	update public.qorpera_company_site_deployments set version_id = null where id = v_dep_prev_1;
	v_due := pg_temp.sahs_service('select public.qorpera_surface_stale_app_deployments_due(16)');
	perform pg_temp.sahs_assert(
		exists (select 1 from jsonb_array_elements(v_due) elem where (elem ->> 'deploymentId')::uuid = v_dep_prev_1),
		'orphaned running preview deployment with pruned version_id is immediately due for stop'
	);
end $$;

rollback;
