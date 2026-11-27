-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spms_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception '1414_surface_publish_merge_serialization failed: %', p_message;
	end if;
end $$;

create function pg_temp.spms_as(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create function pg_temp.spms_service(p_sql text)
returns jsonb language plpgsql as $$
declare
	v_out jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_out;
	reset role;
	return v_out;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_other_owner constant uuid := '14140000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '14140000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '14140000-0000-4000-8000-000000000021';
	v_env_a uuid;
	v_surface uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_session1 uuid;
	v_session2 uuid;
	v_c0 uuid := '14140000-0000-4000-8000-000000000020';
	v_c1 uuid;
	v_c2 uuid := '14140000-0000-4000-8000-000000000022';
	v_c3 uuid := '14140000-0000-4000-8000-000000000023';
	v_c5 uuid;
	v_sha0 text := repeat('0', 40);
	v_sha1 text := repeat('1', 40);
	v_sha2 text := repeat('2', 40);
	v_sha3 text := repeat('3', 40);
	v_sha4 text := repeat('4', 40);
	v_claimed jsonb;
	v_merge_job uuid;
	v_merge_lease uuid;
	v_pub_job uuid;
	v_pub_lease uuid;
	v_pub_job2 uuid;
	v_pub_lease2 uuid;
	v_pub_elem jsonb;
	v_recipe constant jsonb := '{"run":"npm run build","cwd":".","folder":"dist","timeoutSeconds":60}';
	v_req jsonb;
	v_build_id uuid;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding_claim jsonb;
	v_b_lease uuid;
	v_manifest jsonb := jsonb_build_object(
		'files', jsonb_build_object(
			'index.html', jsonb_build_object('sha256', repeat('a', 64), 'bytes', 64, 'content_type', 'text/html; charset=utf-8', 'immutable', false)
		),
		'redirects', '[]'::jsonb,
		'headers', '[]'::jsonb,
		'spa_fallback', null,
		'not_found_page', null
	);
begin
	perform pg_temp.spms_assert(
		not has_function_privilege('public', 'public.qorpera_surface_finalize_publish(public.qorpera_surface_jobs,text,timestamptz)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_surface_finalize_publish(public.qorpera_surface_jobs,text,timestamptz)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_surface_finalize_publish(public.qorpera_surface_jobs,text,timestamptz)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_surface_finalize_publish(public.qorpera_surface_jobs,text,timestamptz)', 'execute'),
		'qorpera_surface_finalize_publish is revoked from public, anon, authenticated, and service_role'
	);

	update public.qorpera_site_settings set enabled = true, hosts_domain = 'qorpera.site', hosts_enabled = true;
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select environment_id into strict v_env_a from public.qorpera_company_cofounders where profile_id = v_company;
	insert into auth.users(id, email) values (v_other_owner, 'owner-1414-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SPMS Exec Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SPMS Exec Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1414', true, array['codex']);

	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company, 'Brooks site', 'brooks-site', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session1 := (public.qorpera_start_surface_session(v_surface, 'Prior session', 'Prior') ->> 'id')::uuid;
	v_session2 := (public.qorpera_start_surface_session(v_surface, 'Big redesign', 'Redesign') ->> 'id')::uuid;
	reset role;

	update public.qorpera_surfaces
	set
		live_head_sha = v_sha1,
		published_head_sha = v_sha0,
		unpublished_change_count = 1,
		auto_publish = false,
		publish_status = 'idle'
	where id = v_surface;

	select site.* into strict v_site
	from public.qorpera_surfaces sf join public.qorpera_company_sites site on site.id = sf.site_id
	where sf.id = v_surface;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('14140000-0000-4000-8000-0000000000d1', 'member', v_company, v_env_a, v_owner, 'exec-1414', repeat('9', 64), '{}');
	set local session_replication_role = origin;

	insert into public.qorpera_surface_changes (
		id, profile_id, surface_id, session_id, seq, title, kind, parent_sha, head_sha, status,
		landed_main_before, landed_main_after, resolved_at, approved_by_user_id
	) values
		(v_c0, v_company, v_surface, v_session1, 1, 'Earlier unpublished header change', 'git_range', v_sha0, v_sha1, 'merged', v_sha0, v_sha1, clock_timestamp() - interval '1 hour', v_owner);
	update public.qorpera_surface_sessions set state = 'completed', closed_at = clock_timestamp() where id = v_session1;

	v_c1 := (public.qorpera_record_surface_change(
		v_session2, 'Brooks PriceRunner redesign', 'Redesign', 'git_range',
		v_sha1, v_sha2, '{}'::uuid[], array['index.html'], null, null, false
	) ->> 'changeId')::uuid;

	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_c1, true);
	perform public.qorpera_publish_surface(v_surface);
	perform public.qorpera_publish_surface(v_surface);
	reset role;

	perform pg_temp.spms_assert(
		(select count(*) from public.qorpera_surface_jobs where surface_id = v_surface and kind = 'publish_surface' and status = 'queued') = 1,
		'repeated publish_surface calls coalesce into one queued job'
	);
	perform pg_temp.spms_assert(
		(select not (payload ? 'liveHeadSha') from public.qorpera_surface_jobs where surface_id = v_surface and kind = 'publish_surface' and status = 'queued'),
		'publish_surface does not freeze pre-merge liveHeadSha at enqueue time'
	);

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into v_merge_job, v_merge_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;

	perform pg_temp.spms_assert(v_merge_job is not null, 'land_change is claimed first');
	perform pg_temp.spms_assert(
		not exists (
			select 1 from jsonb_array_elements(v_claimed -> 'publishes') elem
			where (elem ->> 'surfaceId')::uuid = v_surface
		),
		'publish_surface is NOT claimed in the same pass while land_change is queued/running'
	);

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	perform pg_temp.spms_assert(
		not exists (
			select 1 from jsonb_array_elements(v_claimed -> 'publishes') elem
			where (elem ->> 'surfaceId')::uuid = v_surface
		),
		'second worker cannot claim publish_surface while land_change is still running'
	);

	perform pg_temp.spms_service(format(
		'select public.qorpera_surface_complete_merge(%L, %L, %L, %L, null, null, null, null, %L)',
		v_merge_job, 'landed', v_sha1, v_sha2, v_merge_lease
	));

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select elem into v_pub_elem
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;
	v_pub_job := (v_pub_elem ->> 'jobId')::uuid;
	v_pub_lease := (v_pub_elem ->> 'leaseToken')::uuid;

	perform pg_temp.spms_assert(
		v_pub_job is not null
		and v_pub_elem ->> 'liveHeadSha' = v_sha2
		and v_pub_elem #>> '{payload,liveHeadSha}' = v_sha2
		and (v_pub_elem #> '{payload,includedChangeIds}') @> jsonb_build_array(v_c0::text, v_c1::text),
		'publish_surface claims post-merge SHA and exact includedChangeIds once land_change finishes: ' || coalesce(v_pub_elem::text, 'null')
	);

	perform pg_temp.spms_service(format(
		'select public.qorpera_surface_complete_publish(%L, %L, %L, null, %L)',
		v_pub_job, 'published', v_sha2, v_pub_lease
	));
	perform pg_temp.spms_assert(
		(select published_head_sha = v_sha2 and live_head_sha = v_sha2 and unpublished_change_count = 0 and publish_status = 'idle'
		 from public.qorpera_surfaces where id = v_surface)
		and (select count(*) = 2 from public.qorpera_surface_changes where id in (v_c0, v_c1) and published_at is not null),
		'up-to-date publish marks both changes published and resets count to 0'
	);

	insert into public.qorpera_surface_changes (
		id, profile_id, surface_id, session_id, seq, title, kind, parent_sha, head_sha, status,
		landed_main_before, landed_main_after, resolved_at, approved_by_user_id
	) values
		(v_c2, v_company, v_surface, v_session2, 2, 'Change published in wave 1', 'git_range', v_sha2, v_sha3, 'merged', v_sha2, v_sha3, clock_timestamp(), v_owner);
	update public.qorpera_surfaces
	set live_head_sha = v_sha3, unpublished_change_count = 1
	where id = v_surface;

	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_pub_job, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;

	insert into public.qorpera_surface_changes (
		id, profile_id, surface_id, session_id, seq, title, kind, parent_sha, head_sha, status,
		landed_main_before, landed_main_after, resolved_at, approved_by_user_id
	) values
		(v_c3, v_company, v_surface, v_session2, 3, 'Newer change landed during publish', 'git_range', v_sha3, v_sha4, 'merged', v_sha3, v_sha4, clock_timestamp() + interval '1 second', v_owner);
	update public.qorpera_surfaces
	set live_head_sha = v_sha4, unpublished_change_count = 2
	where id = v_surface;

	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	perform pg_temp.spms_assert(
		not exists (
			select 1 from jsonb_array_elements(v_claimed -> 'publishes') elem
			where (elem ->> 'surfaceId')::uuid = v_surface
		),
		'second publish_surface waits while first publish_surface is still running'
	);

	perform pg_temp.spms_service(format(
		'select public.qorpera_surface_complete_publish(%L, %L, %L, null, %L)',
		v_pub_job, 'published', v_sha3, v_pub_lease
	));
	perform pg_temp.spms_assert(
		(select published_head_sha = v_sha3 and live_head_sha = v_sha4 and unpublished_change_count = 1 and publish_status = 'publishing'
		 from public.qorpera_surfaces where id = v_surface)
		and (select published_at is not null from public.qorpera_surface_changes where id = v_c2)
		and (select published_at is null from public.qorpera_surface_changes where id = v_c3),
		'completing publish for SHA3 marks only c2 published, keeps c3 unpublished, preserves count=1 and queued publish status'
	);

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select elem into v_pub_elem
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;
	v_pub_job2 := (v_pub_elem ->> 'jobId')::uuid;
	v_pub_lease2 := (v_pub_elem ->> 'leaseToken')::uuid;

	perform pg_temp.spms_assert(
		v_pub_job2 is not null
		and v_pub_elem ->> 'liveHeadSha' = v_sha4
		and (v_pub_elem #> '{payload,includedChangeIds}') = jsonb_build_array(v_c3::text),
		'queued follow-up publish claims SHA4 with c3 once first publish finishes: ' || coalesce(v_pub_elem::text, 'null')
	);

	v_req := pg_temp.spms_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'publish', v_pub_job2, v_pub_lease2, v_sha4, repeat('b', 40), v_recipe
	));
	v_build_id := (v_req ->> 'buildId')::uuid;
	perform pg_temp.spms_assert(v_req ->> 'state' = 'waiting', 'publish build parks waiting on builder');

	update public.qorpera_surfaces
	set live_head_sha = repeat('5', 40), unpublished_change_count = 2
	where id = v_surface;
	insert into public.qorpera_surface_changes (
		profile_id, surface_id, session_id, seq, title, kind, parent_sha, head_sha, status,
		landed_main_before, landed_main_after, resolved_at, approved_by_user_id
	) values (
		v_company, v_surface, v_session2, 4, 'Change landed during parked build', 'git_range', v_sha4, repeat('5', 40), 'merged',
		v_sha4, repeat('5', 40), clock_timestamp() + interval '2 seconds', v_owner
	);

	select * into strict v_builder from public.qorpera_surface_preview_builders where surface_id = v_surface and member_user_id = v_owner;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;

	v_coding_claim := pg_temp.spms_service($q$select public.qorpera_claim_coding_session('exec-1414', 60)$q$);
	v_b_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.spms_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_b_lease));
	perform pg_temp.spms_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, null, %L, %L::jsonb, 1, 64, false)',
		v_worker.id, v_b_lease, v_build_id, 'built', repeat('c', 64), v_manifest::text
	));

	perform pg_temp.spms_assert(
		(select status = 'completed' from public.qorpera_surface_jobs where id = v_pub_job2)
		and (select published_head_sha = v_sha4 and live_head_sha = repeat('5', 40) and unpublished_change_count = 1 and publish_status = 'idle'
		     from public.qorpera_surfaces where id = v_surface)
		and (select published_at is not null from public.qorpera_surface_changes where id = v_c3)
		and (select published_at is null from public.qorpera_surface_changes where surface_id = v_surface and seq = 4),
		'parked build settle for SHA4 marks only c3 published and keeps seq 4 unpublished with count=1'
	);

	update public.qorpera_surfaces
	set auto_publish = true, live_head_sha = repeat('5', 40), published_head_sha = v_sha4, unpublished_change_count = 1, publish_status = 'idle'
	where id = v_surface;
	insert into public.qorpera_surface_changes (
		profile_id, surface_id, session_id, seq, title, kind, parent_sha, head_sha, status
	) values (
		v_company, v_surface, v_session2, 5, 'Auto-publish merge', 'git_range', repeat('5', 40), repeat('6', 40), 'staged'
	) returning id into v_c5;
	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_c5, true);
	perform public.qorpera_publish_surface(v_surface);
	reset role;

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_merge_job, v_merge_lease
	from jsonb_array_elements(v_claimed -> 'merges') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;
	perform pg_temp.spms_service(format(
		'select public.qorpera_surface_complete_merge(%L, %L, %L, %L, null, null, null, null, %L)',
		v_merge_job, 'landed', repeat('5', 40), repeat('6', 40), v_merge_lease
	));

	perform pg_temp.spms_assert(
		(select count(*) = 1 from public.qorpera_surface_jobs where surface_id = v_surface and kind = 'publish_surface' and status = 'queued')
		and (select publish_status = 'publishing' from public.qorpera_surfaces where id = v_surface),
		'autoPublish merge coalesces into existing queued publish_surface job and keeps publish_status=publishing'
	);

	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid
	into strict v_pub_job, v_pub_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;

	update public.qorpera_surfaces set live_head_sha = repeat('7', 40) where id = v_surface;
	perform pg_temp.spms_service(format(
		'select public.qorpera_surface_complete_publish(%L, %L, %L, null, %L)',
		v_pub_job, 'published', repeat('6', 40), v_pub_lease
	));
	perform pg_temp.spms_assert(
		(select published_head_sha = repeat('6', 40) and live_head_sha = repeat('7', 40) and unpublished_change_count = 1
		 from public.qorpera_surfaces where id = v_surface),
		'head drift with zero remaining unpublished change rows still preserves unpublished_change_count=1'
	);

	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid into strict v_pub_job
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;
	perform pg_temp.spms_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	perform public.qorpera_surface_build_waiter_fail('publish', v_pub_job, E'PREVIEW_BUILD_NO_HOURS\nNo computer hours left.');
	perform pg_temp.spms_assert(
		(select publish_status = 'publishing' from public.qorpera_surfaces where id = v_surface),
		'waiter_fail preserves publishing status when another publish_surface is queued'
	);
	v_claimed := pg_temp.spms_service($q$select public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo')$q$);
	select (elem ->> 'jobId')::uuid into strict v_pub_job2
	from jsonb_array_elements(v_claimed -> 'publishes') elem
	where (elem ->> 'surfaceId')::uuid = v_surface;
	perform public.qorpera_surface_build_waiter_fail('publish', v_pub_job2, E'PREVIEW_BUILD_NO_HOURS\nNo computer hours left.');
	perform pg_temp.spms_assert(
		(select publish_status = 'failed' from public.qorpera_surfaces where id = v_surface),
		'waiter_fail sets failed status when no other publish_surface is queued'
	);
end $$;

rollback;
