-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spb_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_preview_builds: %', p_message;
	end if;
end $$;

create function pg_temp.spb_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.spb_select(p_user uuid, p_surface uuid, p_changes uuid[])
returns uuid language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.spb_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_set_preview_selection(p_surface, p_changes, null, '{}'::uuid[], '/');
	reset role;
	return (v_result #>> '{primary,previewId}')::uuid;
end $$;

create function pg_temp.spb_lane()
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;
	return v_result;
end $$;

create function pg_temp.spb_lease(p_claimed jsonb, p_preview uuid)
returns uuid language sql as $$
	select (elem ->> 'leaseToken')::uuid
	from jsonb_array_elements(p_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = p_preview
$$;

create function pg_temp.spb_request(
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

create function pg_temp.spb_service(p_sql text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_result;
	reset role;
	return v_result;
end $$;

create function pg_temp.spb_refused(p_sql text, p_state text)
returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	begin
		execute p_sql;
	exception when others then
		reset role;
		if sqlstate is distinct from p_state then
			raise exception 'surface_preview_builds: expected %, got % (%) from %', p_state, sqlstate, sqlerrm, p_sql;
		end if;
		return;
	end;
	reset role;
	raise exception 'surface_preview_builds: expected % from %', p_state, p_sql;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_member constant uuid := '85600000-0000-4000-8000-000000000002';
	v_other_owner constant uuid := '13580000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13580000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13580000-0000-4000-8000-000000000021';
	v_recipe constant jsonb := '{"run":"npm ci && npm run build","cwd":".","folder":"dist","timeoutSeconds":180}';
	v_t1 constant text := repeat('a', 40);
	v_t3 constant text := repeat('b', 40);
	v_t4 constant text := repeat('d', 40);
	v_built constant text := repeat('e', 40);
	v_company_a uuid := (v_claim ->> 'profileId')::uuid;
	v_env_a uuid;
	v_surface uuid;
	v_session uuid;
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
	v_b3 uuid;
	v_b4 uuid;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding public.qorpera_coding_sessions%rowtype;
	v_coding_claim jsonb;
	v_lease uuid;
	v_job uuid;
	v_job_lease uuid;
	v_function text;
begin
	foreach v_function in array array[
		'public.qorpera_surface_request_build(text,uuid,uuid,text,text,jsonb,text)',
		'public.qorpera_begin_surface_preview_build(uuid,uuid)',
		'public.qorpera_complete_surface_preview_build(uuid,uuid,uuid,text,text,text)'
	] loop
		perform pg_temp.spb_assert(
			has_function_privilege('service_role', v_function, 'EXECUTE')
			and not has_function_privilege('authenticated', v_function, 'EXECUTE')
			and not has_function_privilege('anon', v_function, 'EXECUTE'),
			v_function || ' is the service role''s only'
		);
	end loop;
	foreach v_function in array array[
		'public.qorpera_surface_preview_builder_kick(uuid)',
		'public.qorpera_surface_preview_builds_sweep(timestamptz)',
		'public.qorpera_surface_preview_build_settle(uuid)',
		'public.qorpera_surface_preview_selected(uuid)'
	] loop
		perform pg_temp.spb_assert(
			not has_function_privilege('service_role', v_function, 'EXECUTE')
			and not has_function_privilege('authenticated', v_function, 'EXECUTE'),
			v_function || ' is no API role''s'
		);
	end loop;

	perform pg_temp.spb_assert(
		public.qorpera_surface_preview_recipe_valid(v_recipe)
		and public.qorpera_surface_preview_recipe_valid('{"run":"make","cwd":"web/app","folder":".","timeoutSeconds":600}')
		and not public.qorpera_surface_preview_recipe_valid('{"run":"make","cwd":".","folder":"../out","timeoutSeconds":60}')
		and not public.qorpera_surface_preview_recipe_valid('{"run":"make","cwd":"a//b","folder":"dist","timeoutSeconds":60}')
		and not public.qorpera_surface_preview_recipe_valid('{"run":"make","cwd":".","folder":"dist","timeoutSeconds":9}')
		and not public.qorpera_surface_preview_recipe_valid('{"run":"make","cwd":".","folder":"dist","timeoutSeconds":601}')
		and not public.qorpera_surface_preview_recipe_valid('{"run":" ","cwd":".","folder":"dist","timeoutSeconds":60}')
		and not public.qorpera_surface_preview_recipe_valid('{"run":"make","cwd":".","folder":"dist","timeoutSeconds":60,"env":{}}')
		and not public.qorpera_surface_preview_recipe_valid('["make"]'),
		'the recipe takes exactly run, cwd, folder and timeoutSeconds within their bounds'
	);

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env_a from public.qorpera_company_cofounders where profile_id = v_company_a;
	insert into auth.users(id, email) values (v_other_owner, 'owner-spb-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SPB Executor Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SPB Executor Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1358', true, array['codex', 'claude-code']);

	perform pg_temp.spb_as(v_owner);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(
		v_company_a, 'Shop', 'shop', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Make a shop', 'Shop') ->> 'id')::uuid;
	reset role;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface;
	v_c1 := (public.qorpera_record_surface_change(v_session, 'Hero', 'Hero', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(v_session, 'Footer', 'Footer', 'git_range',
		repeat('2', 40), repeat('3', 40), '{}'::uuid[], array['src/footer.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_c3 := (public.qorpera_record_surface_change(v_session, 'Cart', 'Cart', 'git_range',
		repeat('1', 40), repeat('5', 40), '{}'::uuid[], array['src/cart.tsx'], null, null, false) ->> 'changeId')::uuid;

	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13580000-0000-4000-8000-0000000000d1', 'member', v_company_a, v_env_a, v_owner, 'exec-1358', repeat('8', 64), '{}');
	set local session_replication_role = origin;

	v_p1 := pg_temp.spb_select(v_owner, v_surface, array[v_c1]);
	v_p2 := pg_temp.spb_select(v_member, v_surface, array[v_c1, v_c2]);
	perform pg_temp.spb_assert(
		(select requested_by_user_id from public.qorpera_surface_previews where id = v_p1) = v_owner
		and (select requested_by_user_id from public.qorpera_surface_previews where id = v_p2) = v_member,
		'each preview row names the member whose selection asked for it'
	);
	v_claimed := pg_temp.spb_lane();
	perform pg_temp.spb_refused(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'preview', v_p1, pg_temp.spb_lease(v_claimed, v_p1), repeat('c', 40), v_t1, '{"run":"make"}'
	), '22023');
	v_result := pg_temp.spb_request('preview', v_p1, pg_temp.spb_lease(v_claimed, v_p1), v_t1, v_recipe);
	v_b1 := (v_result ->> 'buildId')::uuid;
	select * into strict v_builder from public.qorpera_surface_preview_builders where surface_id = v_surface and member_user_id = v_owner;
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;
	select * into strict v_coding from public.qorpera_coding_sessions where worker_id = v_worker.id;
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'waiting'
		and (select state from public.qorpera_surface_preview_builds where id = v_b1) = 'queued'
		and (select builder_id from public.qorpera_surface_preview_builds where id = v_b1) = v_builder.id
		and (select status = 'building' and lease_token is null and lease_expires_at is null and build_id = v_b1
			from public.qorpera_surface_previews where id = v_p1),
		'a preview whose project needs a build parks on a queued build: ' || v_result::text
	);
	perform pg_temp.spb_assert(
		v_worker.surface_backed and v_worker.surface_session_id is null and v_worker.species = 'coding'
		and v_worker.state = 'active' and v_worker.owner_user_id = v_owner
		and v_worker.dispatch ->> 'kind' = 'surface-preview-build'
		and v_coding.phase = 'queued' and v_coding.surface_session_id is null
		and v_coding.repository = '{"host":"qorpera","owner":"surfaces","name":"shop","baseBranch":"main"}'::jsonb,
		'the asker''s builder is a coding session of its own on the interface''s repository'
	);
	perform pg_temp.spb_refused(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)',
		'preview', v_p1, pg_temp.spb_lease(v_claimed, v_p1), repeat('c', 40), v_t1, v_recipe
	), '55000');

	v_result := pg_temp.spb_request('preview', v_p2, pg_temp.spb_lease(v_claimed, v_p2), v_t1, v_recipe);
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'waiting' and (v_result ->> 'buildId')::uuid = v_b1
		and (select count(*) from public.qorpera_surface_preview_builds where surface_id = v_surface) = 1
		and (select build_id from public.qorpera_surface_previews where id = v_p2) = v_b1,
		'two preview rows of one tree and recipe share one build: ' || v_result::text
	);

	v_coding_claim := pg_temp.spb_service($q$select public.qorpera_claim_coding_session('exec-1358', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	perform pg_temp.spb_assert(
		v_coding_claim ->> 'workerId' = v_worker.id::text
		and v_coding_claim #>> '{dispatch,kind}' = 'surface-preview-build'
		and v_coding_claim -> 'surfaceSession' is null,
		'the builder is claimed like a coding session and says what it is: ' || coalesce(v_coding_claim::text, 'null')
	);
	v_result := pg_temp.spb_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'build' and v_result #>> '{build,buildId}' = v_b1::text
		and v_result #>> '{build,treeSha}' = v_t1 and v_result #> '{build,recipe}' = v_recipe
		and v_result #>> '{build,repositoryKey}' = 'surfaces/shop'
		and (select state from public.qorpera_surface_preview_builds where id = v_b1) = 'running',
		'the builder turn takes the queued build: ' || v_result::text
	);
	perform pg_temp.spb_refused(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, %L)',
		v_worker.id, v_lease, v_b1, 'failed', 'raw text without a code line'
	), '22023');
	perform pg_temp.spb_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, %L, null)',
		v_worker.id, v_lease, v_b1, 'built', v_built
	));
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	perform pg_temp.spb_assert(
		(select state = 'built' and built_tree_sha = v_built from public.qorpera_surface_preview_builds where id = v_b1)
		and (select status = 'composing' and lease_token is null and expires_at > clock_timestamp()
			from public.qorpera_surface_previews where id = v_p1)
		and (select status = 'composing' and expires_at > clock_timestamp() from public.qorpera_surface_previews where id = v_p2)
		and v_worker.state = 'succeeded' and v_worker.completion_state = 'suppressed'
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker.id) = 'completed',
		'a built build wakes both rows for the lane and the builder turn ends without waking any agent'
	);

	v_claimed := pg_temp.spb_lane();
	v_result := pg_temp.spb_request('preview', v_p1, pg_temp.spb_lease(v_claimed, v_p1), v_t1, v_recipe);
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'built' and v_result ->> 'builtTreeSha' = v_built
		and (select lease_token is not null from public.qorpera_surface_previews where id = v_p1),
		'the woken row finds the build made and keeps its lease to upload: ' || v_result::text
	);
	perform pg_temp.spb_service(format(
		'select public.qorpera_surface_complete_preview(%L, %L, %L, null, null, null, %L)',
		v_p1, 'ready', v_t1, pg_temp.spb_lease(v_claimed, v_p1)
	));

	perform pg_temp.spb_as(v_owner);
	set local role authenticated;
	perform public.qorpera_publish_surface(v_surface);
	reset role;
	v_claimed := pg_temp.spb_lane();
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_job, v_job_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;
	v_result := pg_temp.spb_request('publish', v_job, v_job_lease, v_t1, v_recipe);
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'built' and (v_result ->> 'buildId')::uuid = v_b1 and v_result ->> 'builtTreeSha' = v_built
		and (select status from public.qorpera_surface_jobs where id = v_job) = 'running',
		'publish of a tree already built for a preview reuses that build at once: ' || v_result::text
	);
	perform pg_temp.spb_service(format(
		'select public.qorpera_surface_complete_publish(%L, %L, %L, null, %L)', v_job, 'published', repeat('1', 40), v_job_lease
	));

	v_p3 := pg_temp.spb_select(v_owner, v_surface, array[v_c3]);
	v_claimed := pg_temp.spb_lane();
	v_result := pg_temp.spb_request('preview', v_p3, pg_temp.spb_lease(v_claimed, v_p3), v_t1, v_recipe, v_built);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'waiting' and (v_result ->> 'buildId')::uuid = v_b1
		and (select state = 'queued' and built_tree_sha is null from public.qorpera_surface_preview_builds where id = v_b1)
		and v_worker.state = 'active' and v_worker.sequence = 2
		and (select phase from public.qorpera_coding_sessions where worker_id = v_worker.id) = 'input_ready',
		'a build whose made tree is gone is queued again and the idle builder is woken for a new turn: ' || v_result::text
	);

	v_p4 := pg_temp.spb_select(v_owner, v_surface, array[v_c1, v_c3]);
	v_claimed := pg_temp.spb_lane();
	v_result := pg_temp.spb_request('preview', v_p4, pg_temp.spb_lease(v_claimed, v_p4), v_t4, v_recipe);
	v_b4 := (v_result ->> 'buildId')::uuid;
	perform pg_temp.spb_assert(
		v_result ->> 'state' = 'waiting'
		and (select state from public.qorpera_surface_preview_builds where id = v_b1) = 'dropped'
		and (select status = 'composing' and expires_at <= clock_timestamp() from public.qorpera_surface_previews where id = v_p3)
		and (select state from public.qorpera_surface_preview_builds where id = v_b4) = 'queued',
		'switching again drops the queued build no selection waits on and expires its row: ' || v_result::text
	);

	update public.qorpera_surface_preview_builds set queued_at = clock_timestamp() - interval '11 minutes' where id = v_b4;
	perform pg_temp.spb_lane();
	perform pg_temp.spb_assert(
		(select state from public.qorpera_surface_preview_builds where id = v_b4) = 'failed'
		and (select status = 'failed' and error_detail like E'PREVIEW_BUILD_NO_MACHINE\n%'
			from public.qorpera_surface_previews where id = v_p4),
		'a build that waited ten minutes for a machine fails its rows with the no-machine code'
	);

	v_p4 := pg_temp.spb_select(v_owner, v_surface, array[v_c1, v_c3]);
	v_claimed := pg_temp.spb_lane();
	v_result := pg_temp.spb_request('preview', v_p4, pg_temp.spb_lease(v_claimed, v_p4), v_t4, v_recipe);
	perform pg_temp.spb_assert(
		(v_result ->> 'buildId')::uuid = v_b4 and (select state from public.qorpera_surface_preview_builds where id = v_b4) = 'queued',
		'retrying a failed preview queues its build again: ' || v_result::text
	);
	v_coding_claim := pg_temp.spb_service($q$select public.qorpera_claim_coding_session('exec-1358', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	v_result := pg_temp.spb_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spb_assert(v_result #>> '{build,buildId}' = v_b4::text, 'the woken builder takes the retried build: ' || v_result::text);
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform pg_temp.spb_lane();
	perform pg_temp.spb_assert(
		(select state = 'queued' and worker_id is null and attempts = 1 from public.qorpera_surface_preview_builds where id = v_b4),
		'a running build whose builder lost its lease is queued again once'
	);

	perform pg_temp.spb_service($q$select public.qorpera_claim_coding_session('exec-1358', 60)$q$);
	perform pg_temp.spb_lane();
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	perform pg_temp.spb_assert(v_worker.state = 'active' and v_worker.sequence = 3, 'the sweep wakes the idle builder whose build waits');
	v_coding_claim := pg_temp.spb_service($q$select public.qorpera_claim_coding_session('exec-1358', 60)$q$);
	v_lease := (v_coding_claim ->> 'leaseToken')::uuid;
	insert into public.qorpera_surface_preview_builds(
		profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256,
		state, worker_id, worker_sequence, started_at
	)
	select v_company_a, v_surface, b.id, 'surfaces/shop', repeat('c', 40), repeat(x, 40), v_recipe, repeat('0', 64),
		'running', extensions.gen_random_uuid(), 1, clock_timestamp()
	from unnest(array['6', '7']) x
	join public.qorpera_surface_preview_builders b on b.surface_id = v_surface and b.member_user_id = v_member;
	v_result := pg_temp.spb_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spb_assert(v_result ->> 'state' = 'wait', 'a third build of a company waits: ' || v_result::text);
	delete from public.qorpera_surface_preview_builds where tree_sha in (repeat('6', 40), repeat('7', 40));
	v_result := pg_temp.spb_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker.id, v_lease));
	perform pg_temp.spb_assert(v_result #>> '{build,buildId}' = v_b4::text, 'with room the build runs: ' || v_result::text);
	perform pg_temp.spb_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, null, %L)',
		v_worker.id, v_lease, v_b4, 'failed', E'PREVIEW_BUILD_FAILED\nnpm run build exited 1.\nsrc/main.tsx: Cannot find module'
	));
	perform pg_temp.spb_assert(
		(select state from public.qorpera_surface_preview_builds where id = v_b4) = 'failed'
		and (select status = 'failed' and error_detail = E'PREVIEW_BUILD_FAILED\nnpm run build exited 1.\nsrc/main.tsx: Cannot find module'
			from public.qorpera_surface_previews where id = v_p4)
		and (select state from public.qorpera_runtime_workers where id = v_worker.id) = 'failed',
		'a failed build fails its rows with its bounded detail and ends its turn failed'
	);
end $$;

rollback;
