-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spbns_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_preview_build_no_sponsor: %', p_message;
	end if;
end $$;

create function pg_temp.spbns_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.spbns_select(p_user uuid, p_surface uuid, p_changes uuid[])
returns uuid language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.spbns_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_set_preview_selection(p_surface, p_changes, null, '{}'::uuid[], '/');
	reset role;
	return (v_result #>> '{primary,previewId}')::uuid;
end $$;

create function pg_temp.spbns_lane(p_lane text default 'code_repo')
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_claim_pending_jobs_for_lane(16, p_lane);
	reset role;
	return v_result;
end $$;

create function pg_temp.spbns_lease(p_claimed jsonb, p_preview uuid)
returns uuid language sql as $$
	select (elem ->> 'leaseToken')::uuid
	from jsonb_array_elements(p_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = p_preview
$$;

create function pg_temp.spbns_request(
	p_kind text, p_id uuid, p_lease uuid, p_tree text, p_recipe jsonb, p_stale text default null
)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_request_build(p_kind, p_id, p_lease, repeat('c', 40), p_tree, p_recipe, p_stale);
	reset role;
	return v_result;
end $$;

create function pg_temp.spbns_service(p_sql text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_result;
	reset role;
	return v_result;
end $$;

create function pg_temp.spbns_refused_as(p_role text, p_user uuid, p_sql text, p_state text)
returns void language plpgsql as $$
begin
	if p_role = 'authenticated' then
		perform pg_temp.spbns_as(p_user);
		set local role authenticated;
	elsif p_role = 'service_role' then
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
	end if;
	begin
		execute p_sql;
	exception when others then
		if p_role is not null then
			reset role;
		end if;
		if sqlstate is distinct from p_state then
			raise exception 'surface_preview_build_no_sponsor: expected %, got % (%) from %', p_state, sqlstate, sqlerrm, p_sql;
		end if;
		return;
	end;
	if p_role is not null then
		reset role;
	end if;
	raise exception 'surface_preview_build_no_sponsor: expected % from %', p_state, p_sql;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_contributor constant uuid := '13610000-0000-4000-8000-000000000003';
	v_viewer constant uuid := '13610000-0000-4000-8000-000000000004';
	v_other_owner constant uuid := '13610000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13610000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13610000-0000-4000-8000-000000000021';
	v_recipe constant jsonb := '{"run":"npm ci && npm run build","cwd":".","folder":"dist","timeoutSeconds":180}';
	v_t1 constant text := repeat('a', 40);
	v_t2 constant text := repeat('b', 40);
	v_t3 constant text := repeat('d', 40);
	v_t4 constant text := repeat('f', 40);
	v_built1 constant text := repeat('e', 40);
	v_built2 constant text := repeat('7', 40);
	v_built3 constant text := repeat('8', 40);
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_staff_a uuid;
	v_surface uuid;
	v_surface2 uuid;
	v_session uuid;
	v_session_no_login uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_p1 uuid;
	v_p2 uuid;
	v_p3 uuid;
	v_p4 uuid;
	v_claimed jsonb;
	v_result jsonb;
	v_b1 uuid;
	v_b2 uuid;
	v_b3 uuid;
	v_b_demoted uuid;
	v_kick text;
	v_seq_before integer;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_owner_builder public.qorpera_surface_preview_builders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding public.qorpera_coding_sessions%rowtype;
	v_coding_claim jsonb;
	v_lease uuid;
	v_job uuid;
	v_job_lease uuid;
	v_session_lease uuid;
	v_enq jsonb;
	v_existing_binding uuid;
	v_existing_version bigint;
	v_existing_conn uuid;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id, staff_agent_id into strict v_env_a, v_staff_a
	from public.qorpera_company_cofounders where profile_id = v_company_a;

	insert into auth.users(id, email) values
		(v_contributor, 'contrib-1361@example.test'),
		(v_viewer, 'viewer-1361@example.test'),
		(v_other_owner, 'owner-1361-b@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		(v_company_a, v_contributor, 'contrib-1361@example.test', 'Clara', 'contributor'),
		(v_company_a, v_viewer, 'viewer-1361@example.test', 'Viktor', 'viewer');

	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SPBNS Executor Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SPBNS Executor Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1361', true, array['codex', 'claude-code']);

	select sv.binding_id, sv.version, sv.provider_connection_id
	into strict v_existing_binding, v_existing_version, v_existing_conn
	from public.qorpera_execution_sponsor_versions sv
	join public.qorpera_execution_sponsor_bindings sb on sb.id = sv.binding_id
	where sb.profile_id = v_company_a
	limit 1;

	perform pg_temp.spbns_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company_a, 'Store', 'store', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Build store', 'Store') ->> 'id')::uuid;
	reset role;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface;
	v_c1 := (public.qorpera_record_surface_change(v_session, 'Hero', 'Hero', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(v_session, 'Pricing', 'Pricing', 'git_range',
		repeat('2', 40), repeat('3', 40), '{}'::uuid[], array['src/pricing.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_c3 := (public.qorpera_record_surface_change(v_session, 'About', 'About', 'git_range',
		repeat('1', 40), repeat('4', 40), '{}'::uuid[], array['src/about.tsx'], null, null, false) ->> 'changeId')::uuid;

	perform pg_temp.spbns_assert(
		not exists (select 1 from public.qorpera_provider_connections where profile_id = v_company_a and owner_user_id = v_contributor),
		'contributor starts with zero AI logins'
	);

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding) values
		('13610000-0000-4000-8000-0000000000d1', 'member', v_company_a, v_env_a, v_owner, 'exec-1361', repeat('8', 64), '{}'),
		('13610000-0000-4000-8000-0000000000d2', 'member', v_company_a, v_env_a, v_contributor, 'exec-1361', repeat('9', 64), '{}');
	set local session_replication_role = origin;

	v_p1 := pg_temp.spbns_select(v_contributor, v_surface, array[v_c1]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p1, pg_temp.spbns_lease(v_claimed, v_p1), v_t1, v_recipe);
	v_b1 := (v_result ->> 'buildId')::uuid;
	select * into strict v_builder from public.qorpera_surface_preview_builders
	where surface_id = v_surface and member_user_id = v_contributor;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;
	select * into strict v_coding from public.qorpera_coding_sessions where worker_id = v_worker.id;

	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'waiting'
		and v_worker.species = 'coding'
		and v_worker.surface_backed
		and v_worker.surface_session_id is null
		and v_worker.owner_user_id = v_contributor
		and v_worker.owner_sponsor_binding_id is null
		and v_worker.owner_sponsor_version is null
		and v_worker.dispatch ->> 'kind' = 'surface-preview-build'
		and v_coding.harness = 'codex'
		and public.qorpera_coding_session_login_state(v_worker) is null
		and not public.qorpera_coding_session_waits_for_usage_limit(v_worker.id),
		'contributor with zero logins opens a sponsorless preview builder: ' || v_result::text
	);

	v_coding_claim := pg_temp.spbns_service($q$select public.qorpera_claim_coding_session('exec-1361', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.spbns_assert(
		v_coding_claim ->> 'workerId' = v_worker.id::text
		and v_coding_claim #>> '{dispatch,kind}' = 'surface-preview-build'
		and (v_coding_claim -> 'sponsor' ->> 'bindingId') is null
		and (v_coding_claim -> 'sponsor' ->> 'version') is null,
		'claimed sponsorless builder emits null sponsor fields: ' || coalesce(v_coding_claim::text, 'null')
	);

	perform pg_temp.spbns_refused_as(
		'service_role', null,
		format('select public.qorpera_begin_coding_turn(%L, %L, ''{}''::jsonb)', v_worker.id, v_lease),
		'42501'
	);
	perform pg_temp.spbns_assert(
		not exists (select 1 from public.qorpera_wake_occurrences where source_id = v_worker.id),
		'refused model turn on preview builder leaves no wake occurrence'
	);

	perform pg_temp.spbns_assert(
		pg_temp.spbns_service(format('select public.qorpera_check_surface_preview_build(%L, %L)', v_worker.id, v_lease)) ->> 'state' = 'go',
		'sponsorless builder passes check before preparing machine'
	);
	v_result := pg_temp.spbns_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'build' and v_result #>> '{build,buildId}' = v_b1::text,
		'sponsorless builder begins preview build: ' || v_result::text
	);
	perform pg_temp.spbns_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, %L, null)',
		v_worker.id, v_lease, v_b1, 'built', v_built1
	));
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p1, pg_temp.spbns_lease(v_claimed, v_p1), v_t1, v_recipe);
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'built' and v_result ->> 'builtTreeSha' = v_built1,
		'woken preview receives built tree from sponsorless builder: ' || v_result::text
	);
	perform pg_temp.spbns_service(format(
		'select public.qorpera_surface_complete_preview(%L, %L, %L, null, null, null, %L)',
		v_p1, 'ready', v_t1, pg_temp.spbns_lease(v_claimed, v_p1)
	));

	perform pg_temp.spbns_refused_as(
		'authenticated', v_contributor,
		format('select public.qorpera_answer_coding_session(%L, ''hi'', %L)', v_worker.id, extensions.gen_random_uuid()),
		'42501'
	);
	perform pg_temp.spbns_refused_as(
		'authenticated', v_contributor,
		format('select public.qorpera_delegate_coding_session(%L, %L)', v_worker.id, extensions.gen_random_uuid()),
		'42501'
	);
	perform pg_temp.spbns_refused_as(
		'authenticated', v_contributor,
		format('select public.qorpera_archive_coding_session(%L, %L)', v_worker.id, extensions.gen_random_uuid()),
		'42501'
	);
	perform pg_temp.spbns_refused_as(
		'authenticated', v_contributor,
		format('select public.qorpera_list_coding_session_logins(%L)', v_worker.id),
		'42501'
	);
	perform pg_temp.spbns_refused_as(
		'authenticated', v_contributor,
		format('select public.qorpera_choose_coding_session_login(%L, %L)', v_worker.id, v_existing_conn),
		'42501'
	);

	perform pg_temp.spbns_refused_as(
		null, null,
		format(
			'update public.qorpera_runtime_workers set owner_sponsor_binding_id = %L, owner_sponsor_version = %s where id = %L',
			v_existing_binding, v_existing_version, v_worker.id
		),
		'23514'
	);
	perform pg_temp.spbns_refused_as(
		null, null,
		format(
			$q$insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				surface_backed, surface_session_id
			) values (
				%L, %L, %L, null, 'bad-surface-session-no-sponsor', 'coding', 'Bad session',
				'read', 'each', '{"goal":"test"}'::jsonb, 'active', 1, %L, null,
				%L, null, null, true, %L
			)$q$,
			v_company_a, v_env_a, v_staff_a, v_contributor, v_contributor, v_session
		),
		'23514'
	);
	perform pg_temp.spbns_refused_as(
		null, null,
		format(
			$q$insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				surface_backed, surface_session_id
			) values (
				%L, %L, %L, null, 'bad-surface-kind-no-sponsor', 'coding', 'Bad kind',
				'read', 'each', '{"kind":"other","goal":"test"}'::jsonb, 'active', 1, %L, null,
				%L, null, null, true, null
			)$q$,
			v_company_a, v_env_a, v_staff_a, v_contributor, v_contributor
		),
		'23514'
	);

	update public.qorpera_provider_connections
	set status = 'revoked'
	where profile_id = v_company_a;

	perform pg_temp.spbns_as(v_contributor);
	set local role authenticated;
	v_session_no_login := (public.qorpera_start_surface_session(v_surface, 'Need model', 'Model') ->> 'id')::uuid;
	reset role;
	v_claimed := pg_temp.spbns_lane('sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_session_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = v_session_no_login;
	v_enq := pg_temp.spbns_service(format(
		'select public.qorpera_surface_enqueue_session_run(%L, %L)',
		v_session_no_login, v_session_lease
	));
	perform pg_temp.spbns_assert(
		v_enq ->> 'status' = 'unavailable' and v_enq ->> 'reason' = 'no_sponsor',
		'LLM surface coding session still requires a sponsor when company has zero logins: ' || v_enq::text
	);

	update public.qorpera_coding_executors
	set harnesses = array['claude-code'], updated_at = clock_timestamp()
	where environment_id = v_env_a;

	perform pg_temp.spbns_as(v_contributor);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.spbns_lane();
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_job, v_job_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;
	v_result := pg_temp.spbns_request('publish', v_job, v_job_lease, v_t2, v_recipe);
	v_b2 := (v_result ->> 'buildId')::uuid;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;
	select * into strict v_coding from public.qorpera_coding_sessions where worker_id = v_worker.id;
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'waiting'
		and v_worker.state = 'active'
		and v_worker.sequence = 2
		and v_worker.owner_sponsor_binding_id is null
		and v_worker.owner_sponsor_version is null
		and v_coding.harness = 'claude-code'
		and v_coding.phase = 'input_ready',
		'publish build wakes idle sponsorless builder with zero company logins and follows executor harness: ' || v_result::text
	);
	v_coding_claim := pg_temp.spbns_service($q$select public.qorpera_claim_coding_session('exec-1361', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.spbns_assert(
		v_coding_claim ->> 'workerId' = v_worker.id::text and v_coding_claim ->> 'harness' = 'claude-code',
		'claimed woken builder uses updated executor harness: ' || coalesce(v_coding_claim::text, 'null')
	);
	v_result := pg_temp.spbns_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spbns_assert(v_result #>> '{build,buildId}' = v_b2::text, 'woken builder begins publish build');
	perform pg_temp.spbns_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, %L, null)',
		v_worker.id, v_lease, v_b2, 'built', v_built2
	));
	perform pg_temp.spbns_assert(
		(select status from public.qorpera_surface_jobs where id = v_job) = 'queued',
		'publish job wakes once sponsorless publish build completes'
	);
	v_claimed := pg_temp.spbns_lane();
	select (elem ->> 'leaseToken')::uuid into strict v_job_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'jobId')::uuid = v_job;
	v_result := pg_temp.spbns_request('publish', v_job, v_job_lease, v_t2, v_recipe);
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'built' and v_result ->> 'builtTreeSha' = v_built2,
		'woken publish job reads built tree: ' || v_result::text
	);
	perform pg_temp.spbns_service(format(
		'select public.qorpera_surface_complete_publish(%L, %L, %L, null, %L)',
		v_job, 'published', repeat('1', 40), v_job_lease
	));

	v_p2 := pg_temp.spbns_select(v_viewer, v_surface, array[v_c1, v_c2]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p2, pg_temp.spbns_lease(v_claimed, v_p2), v_t3, v_recipe);
	v_b3 := (v_result ->> 'buildId')::uuid;
	select * into strict v_owner_builder from public.qorpera_surface_preview_builders
	where surface_id = v_surface and member_user_id = v_owner;
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'waiting'
		and not exists (select 1 from public.qorpera_surface_preview_builders where surface_id = v_surface and member_user_id = v_viewer)
		and (select builder_id from public.qorpera_surface_preview_builds where id = v_b3) = v_owner_builder.id
		and (select owner_user_id = v_owner and owner_sponsor_binding_id is null and owner_sponsor_version is null
			from public.qorpera_runtime_workers where id = v_owner_builder.worker_id),
		'viewer preview falls back to a contributor/admin/owner sponsorless builder: ' || v_result::text
	);
	v_coding_claim := pg_temp.spbns_service($q$select public.qorpera_claim_coding_session('exec-1361', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_result := pg_temp.spbns_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_owner_builder.worker_id, v_lease));
	perform pg_temp.spbns_assert(v_result #>> '{build,buildId}' = v_b3::text, 'fallback builder begins viewer preview build');
	perform pg_temp.spbns_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, %L)',
		v_owner_builder.worker_id, v_lease, v_b3, 'failed', E'PREVIEW_BUILD_FAILED\nnpm run build exited 1.'
	));
	perform pg_temp.spbns_assert(
		(select state = 'failed' and error_detail = E'PREVIEW_BUILD_FAILED\nnpm run build exited 1.'
			from public.qorpera_surface_preview_builds where id = v_b3)
		and (select status = 'failed' and error_detail = E'PREVIEW_BUILD_FAILED\nnpm run build exited 1.'
			from public.qorpera_surface_previews where id = v_p2)
		and (select state = 'failed' and result ->> 'summary' = 'The interface preview build failed.'
			and coalesce(result ->> 'reason', '') not like 'login_%'
			from public.qorpera_runtime_workers where id = v_owner_builder.worker_id),
		'failed build on sponsorless builder keeps its failure summary without any login error'
	);

	v_p2 := pg_temp.spbns_select(v_viewer, v_surface, array[v_c1, v_c2]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p2, pg_temp.spbns_lease(v_claimed, v_p2), v_t3, v_recipe);
	v_coding_claim := pg_temp.spbns_service($q$select public.qorpera_claim_coding_session('exec-1361', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_result := pg_temp.spbns_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_owner_builder.worker_id, v_lease));
	perform pg_temp.spbns_assert(v_result #>> '{build,buildId}' = v_b3::text, 'retried viewer preview build runs on fallback builder');
	perform pg_temp.spbns_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, %L, null)',
		v_owner_builder.worker_id, v_lease, v_b3, 'built', v_built3
	));
	perform pg_temp.spbns_assert(
		(select state = 'built' and built_tree_sha = v_built3 from public.qorpera_surface_preview_builds where id = v_b3)
		and (select status = 'composing' from public.qorpera_surface_previews where id = v_p2),
		'viewer preview wakes once fallback builder finishes'
	);

	select sequence into strict v_seq_before from public.qorpera_runtime_workers where id = v_worker.id;
	insert into public.qorpera_surface_preview_builds(
		profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256
	)
	values (
		v_company_a, v_surface, v_builder.id, 'surfaces/store', repeat('c', 40), repeat('9', 40), v_recipe, repeat('0', 64)
	)
	returning id into v_b_demoted;
	update public.qorpera_profile_members set role = 'viewer' where profile_id = v_company_a and user_id = v_contributor;
	v_kick := public.qorpera_surface_preview_builder_kick(v_builder.id);
	perform pg_temp.spbns_assert(
		v_kick = 'no_member'
		and (select sequence = v_seq_before and state = 'succeeded' from public.qorpera_runtime_workers where id = v_worker.id),
		'demoted contributor builder kick refuses with no_member without advancing worker sequence: ' || coalesce(v_kick, 'null')
	);
	perform pg_temp.spbns_lane();
	perform pg_temp.spbns_assert(
		(select state = 'failed'
			and error_detail = E'PREVIEW_BUILD_FAILED\nNo member who can build this interface is available, so no machine could be opened for the build.'
			from public.qorpera_surface_preview_builds where id = v_b_demoted)
		and (select sequence = v_seq_before and state = 'succeeded' from public.qorpera_runtime_workers where id = v_worker.id),
		'sweep fails queued build on demoted contributor builder with no_member detail and keeps worker idle'
	);
	delete from public.qorpera_surface_preview_builds where id = v_b_demoted;
	update public.qorpera_profile_members set role = 'contributor' where profile_id = v_company_a and user_id = v_contributor;

	update public.qorpera_coding_executors set enabled = false, updated_at = clock_timestamp() where environment_id = v_env_a;
	v_p3 := pg_temp.spbns_select(v_contributor, v_surface, array[v_c3]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p3, pg_temp.spbns_lease(v_claimed, v_p3), v_t4, v_recipe);
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'failed'
		and v_result ->> 'errorDetail' like E'PREVIEW_BUILD_FAILED\nNo coding service runs for this company%',
		'disabled coding executor fails cleanly without mentioning sponsor: ' || v_result::text
	);
	update public.qorpera_coding_executors set enabled = true, updated_at = clock_timestamp() where environment_id = v_env_a;

	v_p3 := pg_temp.spbns_select(v_contributor, v_surface, array[v_c3]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p3, pg_temp.spbns_lease(v_claimed, v_p3), v_t4, v_recipe);
	v_b3 := (v_result ->> 'buildId')::uuid;
	v_coding_claim := pg_temp.spbns_service($q$select public.qorpera_claim_coding_session('exec-1361', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.spbns_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spbns_as(v_owner);
	set local role authenticated;
	perform public.qorpera_archive_surface(v_surface);
	reset role;
	perform pg_temp.spbns_assert(
		(select state = 'dropped' from public.qorpera_surface_preview_builds where id = v_b3)
		and (select state = 'cancelled' from public.qorpera_runtime_workers where id = v_worker.id)
		and (select phase = 'cancelled' from public.qorpera_coding_sessions where worker_id = v_worker.id)
		and (select status = 'failed' and error_detail = 'The interface was deleted' from public.qorpera_surface_previews where id = v_p3),
		'archiving interface cancels sponsorless builder and drops running build'
	);

	perform pg_temp.spbns_as(v_owner);
	set local role authenticated;
	v_surface2 := (public.qorpera_create_surface(
		v_company_a, 'Docs', 'docs', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface2, 'Make docs', 'Docs') ->> 'id')::uuid;
	reset role;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface2;
	v_c1 := (public.qorpera_record_surface_change(v_session, 'Guide', 'Guide', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/guide.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(v_session, 'Api', 'Api', 'git_range',
		repeat('1', 40), repeat('3', 40), '{}'::uuid[], array['src/api.tsx'], null, null, false) ->> 'changeId')::uuid;

	v_p3 := pg_temp.spbns_select(v_contributor, v_surface2, array[v_c1]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p3, pg_temp.spbns_lease(v_claimed, v_p3), v_t1, v_recipe);
	select * into strict v_builder from public.qorpera_surface_preview_builders
	where surface_id = v_surface2 and member_user_id = v_contributor;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'waiting' and v_worker.owner_sponsor_binding_id is null,
		'sponsorless build waits before hours run out: ' || v_result::text
	);

	update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
	insert into public.qorpera_computer_hour_usage(profile_id, metered_at, run_seconds, standard_seconds)
	values (v_company_a, clock_timestamp(), 100000000, 100000000);
	update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
	perform public.qorpera_computer_hour_zero_sweep(clock_timestamp());
	update public.qorpera_computer_hour_billing set coding_zero_rule_since = clock_timestamp() - interval '1 second';
	perform pg_temp.spbns_assert(public.qorpera_company_coding_at_zero(v_company_a, clock_timestamp()), 'company is at zero hours');

	v_coding_claim := pg_temp.spbns_service($q$select public.qorpera_claim_coding_session('exec-1361', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_result := pg_temp.spbns_service(format('select public.qorpera_check_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'none'
		and (select state = 'failed' and error_detail like E'PREVIEW_BUILD_NO_HOURS\n%'
			from public.qorpera_surface_preview_builds where builder_id = v_builder.id)
		and (select status = 'failed' and error_detail like E'PREVIEW_BUILD_NO_HOURS\n%'
			from public.qorpera_surface_previews where id = v_p3),
		'sponsorless builder fails waiting build with PREVIEW_BUILD_NO_HOURS at zero hours: ' || v_result::text
	);

	v_p4 := pg_temp.spbns_select(v_contributor, v_surface2, array[v_c2]);
	v_claimed := pg_temp.spbns_lane();
	v_result := pg_temp.spbns_request('preview', v_p4, pg_temp.spbns_lease(v_claimed, v_p4), v_t2, v_recipe);
	perform pg_temp.spbns_assert(
		v_result ->> 'state' = 'failed'
		and v_result ->> 'errorDetail' like E'PREVIEW_BUILD_NO_HOURS\n%'
		and (select status = 'failed' and error_detail like E'PREVIEW_BUILD_NO_HOURS\n%'
			from public.qorpera_surface_previews where id = v_p4),
		'sponsorless build request fails immediately with PREVIEW_BUILD_NO_HOURS at zero hours: ' || v_result::text
	);
end $$;
