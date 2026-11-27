-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.snep_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_native_edge_previews: %', p_message;
	end if;
end $$;

create function pg_temp.snep_as(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create function pg_temp.snep_service(p_sql text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_result;
	reset role;
	return v_result;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_viewer constant uuid := '13980000-0000-4000-8000-000000000003';
	v_other_owner constant uuid := '13980000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13980000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13980000-0000-4000-8000-000000000021';
	v_env_a uuid;
	v_surface uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_s1 uuid;
	v_s2 uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_p1 uuid;
	v_p2 uuid;
	v_sel jsonb;
	v_ws jsonb;
	v_mint jsonb;
	v_claimed jsonb;
	v_lease uuid;
	v_req jsonb;
	v_build_id uuid;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding_claim jsonb;
	v_b_lease uuid;
	v_begun jsonb;
	v_manifest jsonb;
	v_manifest_sha text := repeat('a', 64);
	v_manifest_sha2 text := repeat('b', 64);
	v_recipe constant jsonb := '{"run":"npm run build","cwd":".","folder":"dist","timeoutSeconds":180}';
	v_redeem jsonb;
	v_snap jsonb;
	v_site_snap jsonb;
	v_pub_job uuid;
	v_pub_lease uuid;
	v_err text;
begin
	perform pg_temp.snep_assert(
		has_function_privilege('service_role', 'public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_surface_site_deployment_register(uuid,text,text,jsonb,integer,bigint,boolean,boolean,text,text,text,text,integer,text,integer,integer,numeric,text,jsonb,boolean)', 'EXECUTE')
		and has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_redeem_member_pass(text,text)', 'EXECUTE')
		and has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_tls_allow(text)', 'EXECUTE')
		and has_function_privilege('qorpera_web_router', 'public.qorpera_web_edge_snapshot()', 'EXECUTE'),
		'permissions and qorpera_web_router grants preserved'
	);

	update public.qorpera_site_settings set enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true;
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform pg_temp.snep_assert(
		public.qorpera_site_preview_domain() = 'qorpera.site'
		and public.qorpera_site_host('atelier-nord--p0.qorpera.site') = '{"slug":"atelier-nord","scope":"preview","previewSlot":0}'::jsonb
		and public.qorpera_site_host('atelier-nord--p7.qorpera.site') = '{"slug":"atelier-nord","scope":"preview","previewSlot":7}'::jsonb
		and public.qorpera_site_host('atelier-nord--p8.qorpera.site') is null
		and public.qorpera_site_host('atelier-nord--pab12cd34.qorpera.com') is null
		and public.qorpera_site_host('atelier-nord--pab12cd34.qorpera.site') is null,
		'preview host parser accepts --p0..--p7 on hosts_domain only'
	);

	select environment_id into strict v_env_a from public.qorpera_company_cofounders where profile_id = v_company;
	insert into auth.users(id, email) values (v_viewer, 'viewer-1398@example.test'), (v_other_owner, 'owner-1398-b@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_viewer, 'viewer-1398@example.test', 'Viewer', 'viewer');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SNEP Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SNEP Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1398', true, array['codex']);

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company, 'Storefront', 'storefront', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_s1 := (public.qorpera_start_surface_session(v_surface, 'Variant A', 'Variant A') ->> 'id')::uuid;
	v_s2 := (public.qorpera_start_surface_session(v_surface, 'Variant B', 'Variant B') ->> 'id')::uuid;
	reset role;

	select site.* into strict v_site
	from public.qorpera_surfaces sf join public.qorpera_company_sites site on site.id = sf.site_id
	where sf.id = v_surface;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface;

	perform pg_temp.snep_assert(
		(public.qorpera_web_edge_tls_allow(v_site.slug || '--p0.qorpera.site') ->> 'allowed')::boolean = true
		and (public.qorpera_web_edge_tls_allow(v_site.slug || '--p3.qorpera.site') ->> 'allowed')::boolean = true
		and (public.qorpera_web_edge_tls_allow(v_site.slug || '--p8.qorpera.site') ->> 'allowed')::boolean = false,
		'edge TLS allows --p0..--p7 for active site and rejects --p8'
	);

	v_c1 := (public.qorpera_record_surface_change(v_s1, 'Hero A', 'Hero A', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(v_s2, 'Hero B', 'Hero B', 'git_range',
		repeat('1', 40), repeat('3', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false) ->> 'changeId')::uuid;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13980000-0000-4000-8000-0000000000d1', 'member', v_company, v_env_a, v_owner, 'exec-1398', repeat('9', 64), '{}');
	set local session_replication_role = origin;

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface, array[v_c1], null, '{}'::uuid[], '/');
	reset role;
	v_p1 := (v_sel #>> '{primary,previewId}')::uuid;

	v_claimed := pg_temp.snep_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'previews') elem where (elem ->> 'previewId')::uuid = v_p1;

	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'preview', v_p1, v_lease, repeat('2', 40), repeat('a', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	perform pg_temp.snep_assert(v_req ->> 'state' = 'waiting', 'build parks preview: ' || v_req::text);

	select * into strict v_builder from public.qorpera_surface_preview_builders where surface_id = v_surface and member_user_id = v_owner;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;

	v_coding_claim := pg_temp.snep_service($q$select public.qorpera_claim_coding_session('exec-1398', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_begun := pg_temp.snep_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));
	perform pg_temp.snep_assert(
		v_begun ->> 'state' = 'build'
		and v_begun #>> '{build,surfaceTitle}' = 'Storefront'
		and jsonb_typeof(v_begun #> '{build,productFolderRoots}') = 'array',
		'begin_surface_preview_build returns surfaceTitle and productFolderRoots: ' || v_begun::text
	);

	v_manifest := jsonb_build_object(
		'files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', repeat('1', 64), 'bytes', 64, 'content_type', 'text/html; charset=utf-8', 'immutable', false),
			'assets/app-12345678.js', jsonb_build_object('sha256', repeat('2', 64), 'bytes', 2048, 'content_type', 'application/javascript; charset=utf-8', 'immutable', true)
		),
		'redirects', '[]'::jsonb,
		'headers', '[]'::jsonb,
		'spa_fallback', 'index.html',
		'not_found_page', null
	);

	perform pg_temp.snep_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 2, 2112, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', v_manifest_sha, v_manifest::text
	));

	perform pg_temp.snep_assert(
		(select status = 'ready' and site_version_id is not null and lease_token is null from public.qorpera_surface_previews where id = v_p1)
		and (select count(*) from public.qorpera_company_site_files f join public.qorpera_surface_previews p on p.site_version_id = f.version_id where p.id = v_p1) = 0
		and exists (
			select 1 from public.qorpera_company_site_deployments d
			join public.qorpera_surface_previews p on p.site_version_id = d.version_id
			where p.id = v_p1 and d.manifest_sha256 = v_manifest_sha and d.file_count = 2 and d.total_bytes = 2112
		),
		'direct manifest build settles parked preview straight to ready with zero Pass 2 and zero bytea file rows'
	);

	perform pg_temp.snep_as(v_viewer);
	set local role authenticated;
	v_mint := public.qorpera_mint_surface_preview_pass(v_p1);
	reset role;
	perform pg_temp.snep_assert(
		v_mint ->> 'doorActionUrl' = 'https://' || v_site.slug || '--p0.qorpera.site/__qorpera/member'
		and v_mint ->> 'memberPass' is not null,
		'primary preview mints --p0 slot on hosts_domain: ' || v_mint::text
	);

	v_redeem := pg_temp.snep_service(format(
		'select public.qorpera_web_edge_redeem_member_pass(%L, %L)',
		v_site.slug || '--p0.qorpera.site', v_mint ->> 'memberPass'
	));
	perform pg_temp.snep_assert(
		v_redeem ->> 'state' = 'open'
		and (v_redeem ->> 'site_id')::uuid = v_site.id
		and (v_redeem ->> 'version_id')::uuid = (select site_version_id from public.qorpera_surface_previews where id = v_p1),
		'edge member pass redemption returns version_id for --p0 preview host: ' || v_redeem::text
	);

	v_snap := public.qorpera_web_edge_snapshot();
	select elem into strict v_site_snap
	from jsonb_array_elements(v_snap -> 'sites') elem where (elem ->> 'id')::uuid = v_site.id;
	perform pg_temp.snep_assert(
		v_site_snap -> 'preview_deployments' ? (select site_version_id::text from public.qorpera_surface_previews where id = v_p1),
		'edge snapshot exposes active preview deployment under preview_deployments'
	);

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	v_sel := public.qorpera_set_preview_selection(v_surface, '{}'::uuid[], null, array[v_s1, v_s2], '/');
	reset role;
	v_p1 := (v_sel #>> '{compareFrames,0,frame,previewId}')::uuid;
	v_p2 := (v_sel #>> '{compareFrames,1,frame,previewId}')::uuid;

	update public.qorpera_surface_previews
	set status = 'ready', site_version_id = (select id from public.qorpera_company_site_versions where site_id = v_site.id limit 1)
	where id in (v_p1, v_p2);

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	v_ws := public.qorpera_get_surface_workspace(v_surface);
	reset role;
	perform pg_temp.snep_assert(
		v_ws #>> '{previewState,compareFrames,0,frame,doorActionUrl}' = 'https://' || v_site.slug || '--p1.qorpera.site/__qorpera/member'
		and v_ws #>> '{previewState,compareFrames,1,frame,doorActionUrl}' = 'https://' || v_site.slug || '--p2.qorpera.site/__qorpera/member',
		'compare mode assigns --p1 and --p2 slots in workspace: ' || (v_ws -> 'previewState')::text
	);

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	v_mint := public.qorpera_mint_surface_preview_pass(v_p2);
	reset role;
	perform pg_temp.snep_assert(
		v_mint ->> 'doorActionUrl' = 'https://' || v_site.slug || '--p2.qorpera.site/__qorpera/member',
		'mint_surface_preview_pass assigns --p2 for compare column 2: ' || v_mint::text
	);

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.snep_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_pub_job, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;

	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'publish', v_pub_job, v_pub_lease, repeat('2', 40), repeat('a', 40), v_recipe
	));
	perform pg_temp.snep_assert(
		v_req ->> 'state' = 'built'
		and v_req ->> 'manifestSha256' = v_manifest_sha
		and (v_req ->> 'fileCount')::integer = 2,
		'publish reuses cached manifest from preview build: ' || v_req::text
	);

	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L, %L)',
		'publish', v_pub_job, v_pub_lease, repeat('2', 40), repeat('a', 40), v_recipe, v_manifest_sha
	));
	perform pg_temp.snep_assert(
		v_req ->> 'state' = 'waiting',
		'passing stale manifestSha256 forces rebuild: ' || v_req::text
	);

	v_coding_claim := pg_temp.snep_service($q$select public.qorpera_claim_coding_session('exec-1398', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.snep_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));
	perform pg_temp.snep_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 2, 2112, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', v_manifest_sha2, v_manifest::text
	));
	perform pg_temp.snep_assert(
		(select status = 'completed' from public.qorpera_surface_jobs where id = v_pub_job)
		and (select publish_status = 'idle' and published_head_sha = repeat('2', 40) from public.qorpera_surfaces where id = v_surface)
		and (select live_deployment_id is not null and storage_mode = 'blob' from public.qorpera_company_sites where id = v_site.id),
		'parked publish job settles directly to published live blob deployment without Pass 2'
	);

	update public.qorpera_company_sites set is_public = true where id = v_site.id;
	begin
		perform pg_temp.snep_service(format(
			'select public.qorpera_surface_site_deployment_register(%L, %L, %L, %L::jsonb, 2, 2112, true, true, %L, null)',
			v_surface, repeat('a', 40), repeat('f', 64), v_manifest::text, repeat('2', 40)
		));
		raise exception 'expected credential input refusal';
	exception when others then
		v_err := sqlerrm;
	end;
	perform pg_temp.snep_assert(v_err = 'SITE_CONTAINS_CREDENTIAL_INPUTS', 'public live promotion refuses credential inputs: ' || v_err);

	update public.qorpera_company_sites set is_public = false where id = v_site.id;
	update public.qorpera_surfaces
	set live_head_sha = repeat('4', 40), published_head_sha = repeat('2', 40), unpublished_change_count = 1
	where id = v_surface;

	insert into public.qorpera_surface_previews (
		surface_id, profile_id, requested_by_user_id, composition_key, short_host_id,
		base_sha, selected_change_ids, status, lease_token, lease_expires_at, expires_at
	) values (
		v_surface, v_company, v_owner, 'shared-tree-test', 'shrdtree',
		repeat('3', 40), '{}'::uuid[], 'building', gen_random_uuid(), clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 hour'
	)
	returning id, lease_token into strict v_p1, v_lease;

	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'preview', v_p1, v_lease, repeat('3', 40), repeat('b', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	perform pg_temp.snep_assert(v_req ->> 'state' = 'waiting', 'preview queues shared build on tree b');

	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.snep_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_pub_job, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;

	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'publish', v_pub_job, v_pub_lease, repeat('4', 40), repeat('b', 40), v_recipe
	));
	perform pg_temp.snep_assert(
		v_req ->> 'state' = 'waiting' and (v_req ->> 'buildId')::uuid = v_build_id,
		'publish attaches to running preview build with same tree but distinct commit sha'
	);

	v_coding_claim := pg_temp.snep_service($q$select public.qorpera_claim_coding_session('exec-1398', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.snep_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));
	perform pg_temp.snep_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 2, 2112, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', repeat('9', 64), v_manifest::text
	));
	perform pg_temp.snep_assert(
		(select status = 'completed' from public.qorpera_surface_jobs where id = v_pub_job)
		and (select published_head_sha = repeat('4', 40) from public.qorpera_surfaces where id = v_surface),
		'direct publish settle uses publish job requestedHeadSha instead of preview composite commit_sha'
	);

	update public.qorpera_company_sites set is_public = true where id = v_site.id;
	update public.qorpera_surfaces
	set live_head_sha = repeat('5', 40), published_head_sha = repeat('4', 40), unpublished_change_count = 1
	where id = v_surface;
	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.snep_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_pub_job, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;
	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'publish', v_pub_job, v_pub_lease, repeat('5', 40), repeat('c', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	v_coding_claim := pg_temp.snep_service($q$select public.qorpera_claim_coding_session('exec-1398', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.snep_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));
	perform pg_temp.snep_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 2, 2112, true)',
		v_worker.id, v_b_lease, v_build_id, 'built', repeat('8', 64), v_manifest::text
	));
	perform pg_temp.snep_assert(
		(select publish_status = 'failed' and split_part(last_publish_error, E'\n', 1) = 'PREVIEW_BUILD_FAILED' from public.qorpera_surfaces where id = v_surface)
		and (select state = 'failed' and split_part(error_detail, E'\n', 1) = 'PREVIEW_BUILD_FAILED' from public.qorpera_surface_preview_builds where id = v_build_id),
		'settle register refusal wraps error with PREVIEW_BUILD_FAILED header and fails build for hand-back'
	);

	update public.qorpera_company_sites
	set taken_down_at = clock_timestamp(), taken_down_reason = 'test takedown'
	where id = v_site.id;
	update public.qorpera_surfaces
	set live_head_sha = repeat('6', 40), published_head_sha = repeat('4', 40), unpublished_change_count = 1, publish_status = 'idle'
	where id = v_surface;
	perform pg_temp.snep_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.snep_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_pub_job, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;
	v_req := pg_temp.snep_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'publish', v_pub_job, v_pub_lease, repeat('6', 40), repeat('d', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	v_coding_claim := pg_temp.snep_service($q$select public.qorpera_claim_coding_session('exec-1398', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.snep_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));
	perform pg_temp.snep_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 2, 2112, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', repeat('7', 64), v_manifest::text
	));
	perform pg_temp.snep_assert(
		(select publish_status = 'failed' and split_part(last_publish_error, E'\n', 1) = 'PREVIEW_BUILD_FAILED' from public.qorpera_surfaces where id = v_surface)
		and (select state = 'built' and manifest_sha256 = repeat('7', 64) from public.qorpera_surface_preview_builds where id = v_build_id)
		and not exists (select 1 from public.qorpera_surface_build_handbacks where build_id = v_build_id),
		'non-code refusal (SITE_TAKEN_DOWN) fails publish job without wiping built manifest or handing back to session'
	);
end $$;

rollback;
