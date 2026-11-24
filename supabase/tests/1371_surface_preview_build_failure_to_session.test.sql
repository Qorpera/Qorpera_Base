-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sbf_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_preview_build_failure_to_session: %', p_message;
	end if;
end $$;

create function pg_temp.sbf_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sbf_member(p_user uuid, p_sql text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.sbf_as(p_user);
	set local role authenticated;
	execute p_sql into v_result;
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return v_result;
end $$;

create function pg_temp.sbf_service(p_sql text)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	execute p_sql into v_result;
	reset role;
	return v_result;
end $$;

create function pg_temp.sbf_select(p_user uuid, p_surface uuid, p_changes uuid[])
returns uuid language sql as $$
	select (pg_temp.sbf_member(p_user, format(
		'select public.qorpera_set_preview_selection(%L, %L::uuid[], null, ''{}''::uuid[], ''/'')', p_surface, p_changes
	)) #>> '{primary,previewId}')::uuid
$$;

create function pg_temp.sbf_frame(p_user uuid, p_surface uuid)
returns jsonb language sql as $$
	select pg_temp.sbf_member(p_user, format('select public.qorpera_get_surface_workspace(%L)', p_surface)) #> '{previewState,primary}'
$$;

create function pg_temp.sbf_lane(p_lane text default 'code_repo')
returns jsonb language sql as $$
	select pg_temp.sbf_service(format('select public.qorpera_surface_claim_pending_jobs_for_lane(16, %L)', p_lane))
$$;

create function pg_temp.sbf_lease(p_claimed jsonb, p_preview uuid)
returns uuid language sql as $$
	select (elem ->> 'leaseToken')::uuid
	from jsonb_array_elements(p_claimed -> 'previews') elem
	where (elem ->> 'previewId')::uuid = p_preview
$$;

create function pg_temp.sbf_request(p_kind text, p_id uuid, p_lease uuid, p_tree text, p_recipe jsonb)
returns jsonb language sql as $$
	select pg_temp.sbf_service(format(
		'select public.qorpera_surface_request_build(%L, %L, %L, %L, %L, %L)', p_kind, p_id, p_lease, repeat('c', 40), p_tree, p_recipe
	))
$$;

create function pg_temp.sbf_turn(p_session uuid)
returns jsonb language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
begin
	v_claimed := pg_temp.sbf_lane('sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = p_session;
	v_enq := pg_temp.sbf_service(format('select public.qorpera_surface_enqueue_session_run(%L, %L)', p_session, v_lease));
	if v_enq ->> 'status' <> 'enqueued' then
		raise exception 'surface_preview_build_failure_to_session: enqueue failed: %', v_enq;
	end if;
	return v_enq;
end $$;

create function pg_temp.sbf_finish(p_worker uuid, p_head text)
returns void language plpgsql as $$
declare v_claim jsonb;
begin
	v_claim := pg_temp.sbf_service($q$select public.qorpera_claim_coding_session('exec-1371', 60)$q$);
	if v_claim ->> 'workerId' is distinct from p_worker::text then
		raise exception 'surface_preview_build_failure_to_session: expected to claim %, got %', p_worker, v_claim;
	end if;
	perform pg_temp.sbf_service(format(
		'select to_jsonb(public.qorpera_complete_coding_turn(p_worker_id => %L, p_lease_token => %L, p_outcome => %L, p_summary => %L, p_artifacts => %L))',
		p_worker, v_claim ->> 'leaseToken', 'succeeded', 'Done.',
		jsonb_build_array(jsonb_build_object(
			'kind', 'staged', 'branch', 'qorpera/coding/' || p_worker::text, 'baseSha', repeat('1', 40), 'headSha', p_head
		))
	));
end $$;

create function pg_temp.sbf_build(p_result text, p_detail text default null)
returns uuid language plpgsql as $$
declare
	v_claim jsonb;
	v_lease uuid;
	v_worker uuid;
	v_begin jsonb;
begin
	v_claim := pg_temp.sbf_service($q$select public.qorpera_claim_coding_session('exec-1371', 60)$q$);
	v_worker := (v_claim ->> 'workerId')::uuid;
	v_lease := (v_claim ->> 'leaseToken')::uuid;
	v_begin := pg_temp.sbf_service(format('select public.qorpera_begin_surface_preview_build(%L, %L)', v_worker, v_lease));
	if v_begin ->> 'state' <> 'build' then
		raise exception 'surface_preview_build_failure_to_session: expected a build, got % from %', v_begin, v_claim;
	end if;
	perform pg_temp.sbf_service(format(
		'select public.qorpera_complete_surface_preview_build(%L, %L, %L, %L, %L, %L)',
		v_worker, v_lease, v_begin #>> '{build,buildId}', p_result,
		case when p_result = 'built' then repeat('9', 40) end, p_detail
	));
	return (v_begin #>> '{build,buildId}')::uuid;
end $$;

create function pg_temp.sbf_fail(p_surface uuid, p_tree text, p_changes uuid[], p_user uuid, p_detail text)
returns uuid language plpgsql as $$
declare
	v_build uuid;
	v_surface public.qorpera_surfaces%rowtype;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	select * into strict v_surface from public.qorpera_surfaces where id = p_surface;
	insert into public.qorpera_surface_preview_builds(
		profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256,
		state, error_detail, finished_at
	)
	select v_surface.profile_id, v_surface.id, b.id, 'surfaces/shop', repeat('c', 40), p_tree,
		'{"run":"npm ci && npm run build","cwd":".","folder":"dist","timeoutSeconds":180}', repeat('0', 64),
		'failed', p_detail, clock_timestamp()
	from public.qorpera_surface_preview_builders b where b.surface_id = p_surface limit 1
	returning id into strict v_build;
	insert into public.qorpera_surface_previews(
		profile_id, surface_id, composition_key, short_host_id, base_sha, selected_change_ids, status, error_detail,
		build_id, requested_by_user_id
	)
	values (
		v_surface.profile_id, v_surface.id, 'test-' || p_tree, substr(p_tree, 1, 8), repeat('1', 40), p_changes, 'failed',
		p_detail, v_build, p_user
	);
	perform public.qorpera_surface_build_hand_back(v_build);
	return v_build;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_other_owner constant uuid := '13710000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13710000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13710000-0000-4000-8000-000000000021';
	v_recipe constant jsonb := '{"run":"npm ci && npm run build","cwd":".","folder":"dist","timeoutSeconds":180}';
	v_detail constant text := E'PREVIEW_BUILD_FAILED\nThe build "npm ci && npm run build" in "." exited with code 2 after 41 s. Full log: code/surfaces/shop/_check-runs/r1/preview.log. End of its output:\nsrc/cart.tsx(4,8): error TS2307: Cannot find module ''./price''';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_function text;
	v_surface uuid;
	v_site public.qorpera_company_sites%rowtype;
	v_s1 uuid;
	v_s2 uuid;
	v_w1 uuid;
	v_w2 uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_p1 uuid;
	v_p2 uuid;
	v_b2 uuid;
	v_b uuid;
	v_claimed jsonb;
	v_result jsonb;
	v_frame jsonb;
	v_handback public.qorpera_surface_build_handbacks%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_expected text;
	v_job uuid;
	v_job_lease uuid;
	v_fix integer;
	v_b3 uuid;
	v_lease uuid;
begin
	foreach v_function in array array[
		'public.qorpera_surface_build_hand_back(uuid)',
		'public.qorpera_surface_build_handbacks_deliver(timestamptz)',
		'public.qorpera_surface_build_fix_take(public.qorpera_surface_sessions,uuid,integer)',
		'public.qorpera_surface_build_handback_open(public.qorpera_surface_build_handbacks)',
		'public.qorpera_surface_preview_being_fixed(public.qorpera_surface_previews)',
		'public.qorpera_surface_preview_kept_frame(public.qorpera_surface_previews,uuid,public.qorpera_company_sites)'
	] loop
		perform pg_temp.sbf_assert(
			not has_function_privilege('service_role', v_function, 'EXECUTE')
			and not has_function_privilege('authenticated', v_function, 'EXECUTE')
			and not has_function_privilege('anon', v_function, 'EXECUTE'),
			v_function || ' is no API role''s'
		);
	end loop;
	perform pg_temp.sbf_assert(
		not has_table_privilege('authenticated', 'public.qorpera_surface_build_handbacks', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_build_handbacks', 'SELECT'),
		'no API role reads the hand-backs table'
	);

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env from public.qorpera_company_cofounders where profile_id = v_company;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	select v_company, v_bo, 'bo@example.test', 'Bo', 'contributor'
	where not exists (select 1 from public.qorpera_profile_members where profile_id = v_company and user_id = v_bo);
	insert into auth.users(id, email) values (v_other_owner, 'owner-sbf-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'SBF Executor Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'SBF Executor Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1371', true, array['codex', 'claude-code']);
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('13710000-0000-4000-8000-0000000000d1', 'member', v_company, v_env, v_anna, 'exec-1371', repeat('8', 64), '{}');
	set local session_replication_role = origin;

	v_surface := (pg_temp.sbf_member(v_anna, format(
		'select public.qorpera_create_surface(%L, %L, %L, %L, %L, %L, %L, null, null, false)',
		v_company, 'Shop', 'shop', 'live_build', 'website', 'globe', '#0a84ff'
	)) ->> 'id')::uuid;
	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_surface;
	select site.* into strict v_site
	from public.qorpera_surfaces s join public.qorpera_company_sites site on site.id = s.site_id
	where s.id = v_surface;

	v_s1 := (pg_temp.sbf_member(v_anna, format(
		'select public.qorpera_start_surface_session(%L, %L, %L)', v_surface, 'Make a hero', 'Hero'
	)) ->> 'id')::uuid;
	v_w1 := (pg_temp.sbf_turn(v_s1) ->> 'workerId')::uuid;
	v_c1 := (public.qorpera_record_surface_change(v_s1, 'Hero', 'Hero', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/hero.tsx'], null, null, false) ->> 'changeId')::uuid;
	perform pg_temp.sbf_finish(v_w1, repeat('2', 40));

	v_s2 := (pg_temp.sbf_member(v_anna, format(
		'select public.qorpera_start_surface_session(%L, %L, %L)', v_surface, 'Add a cart', 'Cart'
	)) ->> 'id')::uuid;
	v_w2 := (pg_temp.sbf_turn(v_s2) ->> 'workerId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(v_s2, 'Cart', 'Cart', 'git_range',
		repeat('1', 40), repeat('5', 40), '{}'::uuid[], array['src/cart.tsx'], null, null, false) ->> 'changeId')::uuid;
	perform pg_temp.sbf_finish(v_w2, repeat('5', 40));
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_sessions where id = v_s1) = 'ready'
		and (select state from public.qorpera_surface_sessions where id = v_s2) = 'ready'
		and (select sequence from public.qorpera_runtime_workers where id = v_w2) = 1,
		'two sessions staged a change each and finished their turns'
	);

	v_p1 := pg_temp.sbf_select(v_anna, v_surface, array[v_c1]);
	v_claimed := pg_temp.sbf_lane();
	v_result := pg_temp.sbf_request('preview', v_p1, pg_temp.sbf_lease(v_claimed, v_p1), repeat('a', 40), v_recipe);
	perform pg_temp.sbf_assert(v_result ->> 'state' = 'waiting', 'the hero preview waits on a build: ' || v_result::text);
	perform pg_temp.sbf_build('built');
	v_claimed := pg_temp.sbf_lane();
	v_result := pg_temp.sbf_request('preview', v_p1, pg_temp.sbf_lease(v_claimed, v_p1), repeat('a', 40), v_recipe);
	perform pg_temp.sbf_service(format(
		'select public.qorpera_surface_complete_preview(%L, %L, %L, null, null, null, %L)',
		v_p1, 'ready', repeat('a', 40), pg_temp.sbf_lease(v_claimed, v_p1)
	));
	perform pg_temp.sbf_assert(
		(select status from public.qorpera_surface_previews where id = v_p1) = 'ready',
		'the hero preview built and is ready: ' || v_result::text
	);

	v_p2 := pg_temp.sbf_select(v_anna, v_surface, array[v_c1, v_c2]);
	v_claimed := pg_temp.sbf_lane();
	v_result := pg_temp.sbf_request('preview', v_p2, pg_temp.sbf_lease(v_claimed, v_p2), repeat('b', 40), v_recipe);
	v_b2 := pg_temp.sbf_build('failed', v_detail);
	perform pg_temp.sbf_assert((v_result ->> 'buildId')::uuid = v_b2, 'the cart preview''s build ran and failed');
	select * into strict v_handback from public.qorpera_surface_build_handbacks where build_id = v_b2;
	v_expected := 'The platform could not build the interface preview with your staged change "Cart" in it, so members keep seeing the last preview that built.'
		|| E'\n\nWhat the build reported:\n' || v_detail
		|| E'\n\nFix the build in this session: change the code on your branch until the project''s preview recipe in .qorpera/checks.json builds (run it yourself to check), commit, stage the fix with coding_record_change, and finish with coding_finish. This is automatic fix 1 of 3.';
	perform pg_temp.sbf_assert(
		v_handback.session_id = v_s2 and v_handback.change_id = v_c2 and v_handback.kind = 'preview'
		and v_handback.state = 'pending' and v_handback.fix_number = 1 and v_handback.followup = v_expected,
		'a failed build goes to the session of the one change the last built preview did not hold, with the build''s end: '
			|| row_to_json(v_handback)::text
	);
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_sessions where id = v_s2) = 'ready',
		'nothing wakes inside the build''s own completion'
	);

	v_frame := pg_temp.sbf_frame(v_anna, v_surface);
	perform pg_temp.sbf_assert(
		v_frame ->> 'status' = 'failed' and (v_frame ->> 'previewId')::uuid = v_p2
		and (v_frame #>> '{kept,previewId}')::uuid = v_p1
		and v_frame #>> '{kept,doorActionUrl}' = 'https://' || v_site.slug || '--p'
			|| (select short_host_id from public.qorpera_surface_previews where id = v_p1) || '.qorpera.com/__qorpera/member'
		and v_frame -> 'kept' -> 'memberPass' = 'null'::jsonb
		and (v_frame ->> 'fixing')::boolean,
		'the member''s frame keeps the last preview that built and says a fix is coming: ' || v_frame::text
	);
	insert into public.qorpera_member_surface_state(user_id, surface_id, toggled_change_ids)
	values (v_bo, v_surface, array[v_c1, v_c2]);
	v_frame := pg_temp.sbf_frame(v_bo, v_surface);
	perform pg_temp.sbf_assert(
		(v_frame ->> 'previewId')::uuid = v_p2 and v_frame -> 'kept' = 'null'::jsonb and (v_frame ->> 'fixing')::boolean,
		'a member with no preview of their own that built keeps nothing and sees the failure: ' || v_frame::text
	);

	perform pg_temp.sbf_lane();
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_build_handbacks where build_id = v_b2) = 'queued'
		and (select state = 'queued' and lease_token is null from public.qorpera_surface_sessions where id = v_s2),
		'the code lane hands the failure to the finished session: it is queued like a reply'
	);
	perform pg_temp.sbf_turn(v_s2);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_w2;
	select * into strict v_handback from public.qorpera_surface_build_handbacks where build_id = v_b2;
	perform pg_temp.sbf_assert(
		v_worker.state = 'active' and v_worker.sequence = 2 and v_worker.dispatch ->> 'followUp' = v_expected
		and exists (
			select 1 from public.qorpera_coding_session_turns t
			where t.worker_id = v_w2 and t.sequence = 2 and t.input_from = 'agent' and t.input_text = v_expected
				and t.input_user_id is null
		)
		and exists (
			select 1 from public.qorpera_runtime_worker_events e
			where e.worker_id = v_w2 and e.sequence = 2 and e.kind = 'followup' and e.body ->> 'text' = v_expected
				and not e.body ? 'byUserId'
		)
		and v_handback.state = 'delivered' and v_handback.worker_id = v_w2 and v_handback.worker_sequence = 2,
		'the session''s next turn is the platform''s follow-up with the build''s end, not a member message'
	);
	perform pg_temp.sbf_assert((pg_temp.sbf_frame(v_anna, v_surface) ->> 'fixing')::boolean, 'while the fix turn runs it is being fixed');
	perform pg_temp.sbf_finish(v_w2, repeat('5', 40));
	v_frame := pg_temp.sbf_frame(v_anna, v_surface);
	perform pg_temp.sbf_assert(
		not (v_frame ->> 'fixing')::boolean and (v_frame #>> '{kept,previewId}')::uuid = v_p1,
		'a fix turn that ended keeps the last preview but no longer says it is being fixed: ' || v_frame::text
	);

	v_p2 := pg_temp.sbf_select(v_anna, v_surface, array[v_c1, v_c2]);
	v_claimed := pg_temp.sbf_lane();
	v_result := pg_temp.sbf_request('preview', v_p2, pg_temp.sbf_lease(v_claimed, v_p2), repeat('b', 40), v_recipe);
	perform pg_temp.sbf_assert(
		(pg_temp.sbf_build('failed', v_detail)) = v_b2,
		'retrying the same tree runs the same build again: ' || v_result::text
	);
	perform pg_temp.sbf_lane();
	perform pg_temp.sbf_assert(
		(select count(*) from public.qorpera_surface_build_handbacks where session_id = v_s2) = 1
		and (select state from public.qorpera_surface_sessions where id = v_s2) = 'ready'
		and (select sequence from public.qorpera_runtime_workers where id = v_w2) = 2,
		'the same failed build never wakes its session twice'
	);

	foreach v_fix in array array[2, 3] loop
		v_b := pg_temp.sbf_fail(v_surface, repeat(v_fix::text, 40), array[v_c1, v_c2], v_anna, v_detail);
		perform pg_temp.sbf_assert(
			(select state = 'pending' and fix_number = v_fix and session_id = v_s2
				and followup like '%This is automatic fix ' || v_fix || ' of 3.'
				from public.qorpera_surface_build_handbacks where build_id = v_b),
			'fix turn ' || v_fix || ' of 3 is counted'
		);
		perform pg_temp.sbf_lane();
		perform pg_temp.sbf_turn(v_s2);
		perform pg_temp.sbf_finish(v_w2, repeat('5', 40));
	end loop;
	v_b := pg_temp.sbf_fail(v_surface, repeat('4', 40), array[v_c1, v_c2], v_anna, v_detail);
	perform pg_temp.sbf_lane();
	perform pg_temp.sbf_assert(
		(select state = 'capped' and fix_number = 4 from public.qorpera_surface_build_handbacks where build_id = v_b)
		and (select state from public.qorpera_surface_sessions where id = v_s2) = 'ready'
		and (select sequence from public.qorpera_runtime_workers where id = v_w2) = 4
		and not (pg_temp.sbf_frame(v_anna, v_surface) ->> 'fixing')::boolean,
		'after three fix turns in a row the failure stays as it is and the session is left alone'
	);

	perform pg_temp.sbf_member(v_anna, format(
		'select public.qorpera_reply_surface_session(%L, %L)', v_s2, 'Use a simpler price list.'
	));
	perform pg_temp.sbf_turn(v_s2);
	perform pg_temp.sbf_assert(
		exists (select 1 from public.qorpera_coding_session_turns t
			where t.worker_id = v_w2 and t.sequence = 5 and t.input_from = 'member' and t.input_text = 'Use a simpler price list.'),
		'the member''s own turn runs as the member''s'
	);
	perform pg_temp.sbf_finish(v_w2, repeat('5', 40));
	v_b := pg_temp.sbf_fail(v_surface, repeat('6', 40), array[v_c1, v_c2], v_anna, v_detail);
	perform pg_temp.sbf_assert(
		(select state = 'pending' and fix_number = 1 from public.qorpera_surface_build_handbacks where build_id = v_b),
		'a turn the member started counts the fix turns from one again'
	);
	delete from public.qorpera_surface_build_handbacks where build_id = v_b;

	v_c3 := (public.qorpera_record_surface_change(v_s1, 'Footer', 'Footer', 'git_range',
		repeat('2', 40), repeat('7', 40), '{}'::uuid[], array['src/footer.tsx'], null, null, false) ->> 'changeId')::uuid;
	v_b := pg_temp.sbf_fail(v_surface, repeat('d', 40), array[v_c2, v_c3], v_anna, v_detail);
	perform pg_temp.sbf_assert(
		(select session_id = v_s1 and change_id = v_c3 from public.qorpera_surface_build_handbacks where build_id = v_b),
		'with two changes new since the last preview that built, the newest of them is taken'
	);
	delete from public.qorpera_surface_build_handbacks where build_id = v_b;
	v_b := pg_temp.sbf_fail(v_surface, repeat('e', 40), array[v_c1], v_anna, v_detail);
	perform pg_temp.sbf_assert(
		(select session_id = v_s1 and change_id = v_c1 from public.qorpera_surface_build_handbacks where build_id = v_b),
		'with nothing new since the last preview that built, the newest change in the composition is taken'
	);
	delete from public.qorpera_surface_build_handbacks where build_id = v_b;
	v_b := pg_temp.sbf_fail(v_surface, repeat('f', 40), array[v_c1, v_c2], v_anna,
		E'PREVIEW_BUILD_NO_MACHINE\nNo coding machine could be had for the build within ten minutes.');
	perform pg_temp.sbf_assert(
		not exists (select 1 from public.qorpera_surface_build_handbacks where build_id = v_b),
		'a build that never ran for want of a machine goes to no session'
	);
	v_b := pg_temp.sbf_fail(v_surface, repeat('0', 40), array[v_c1, v_c2], v_anna,
		E'PREVIEW_BUILD_TOO_LARGE\nThe build''s output in "dist" has more than 500 web files.');
	perform pg_temp.sbf_assert(
		(select session_id = v_s2 and state = 'pending' from public.qorpera_surface_build_handbacks where build_id = v_b),
		'a build whose output is too large goes back like a failed one'
	);
	perform public.qorpera_record_surface_change(v_s2, 'Price list', 'Price list', 'git_range',
		repeat('5', 40), repeat('8', 40), '{}'::uuid[], array['src/price.ts'], null, null, false);
	perform pg_temp.sbf_lane();
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_build_handbacks where build_id = v_b) = 'stale'
		and (select state from public.qorpera_surface_sessions where id = v_s2) = 'ready',
		'a hand-back whose session staged something new since is dropped, not delivered'
	);

	v_b := pg_temp.sbf_fail(v_surface, repeat('ab', 20), array[v_c1, v_c2], v_anna, v_detail);
	perform pg_temp.sbf_lane();
	v_claimed := pg_temp.sbf_lane('sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_s2;
	v_b3 := pg_temp.sbf_fail(v_surface, repeat('ac', 20), array[v_c1, v_c2], v_anna,
		E'PREVIEW_BUILD_TOO_LARGE\nThe build''s output in "dist" has more than 500 web files.');
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_sessions where id = v_s2) = 'running'
		and (select state from public.qorpera_surface_build_handbacks where build_id = v_b) = 'superseded'
		and (select state from public.qorpera_surface_build_handbacks where build_id = v_b3) = 'queued'
		and (select count(*) from public.qorpera_surface_build_handbacks
			where session_id = v_s2 and state in ('pending', 'queued')) = 1,
		'a second failure while the session is claimed for the first replaces it in the queue, not behind it'
	);
	v_result := pg_temp.sbf_service(format('select public.qorpera_surface_enqueue_session_run(%L, %L)', v_s2, v_lease));
	perform pg_temp.sbf_assert(
		v_result ->> 'status' = 'enqueued'
		and exists (
			select 1 from public.qorpera_coding_session_turns t
			where t.worker_id = v_w2 and t.sequence = 6 and t.input_from = 'agent'
				and t.input_text = (select followup from public.qorpera_surface_build_handbacks where build_id = v_b3)
				and t.input_text like E'%PREVIEW_BUILD_TOO_LARGE\n%'
		)
		and (select state = 'delivered' and worker_sequence = 6 from public.qorpera_surface_build_handbacks where build_id = v_b3),
		'the claimed session''s turn is the newer failure''s fix: ' || v_result::text
	);
	perform pg_temp.sbf_finish(v_w2, repeat('8', 40));

	v_b := pg_temp.sbf_fail(v_surface, repeat('ad', 20), array[v_c1, v_c2], v_anna, v_detail);
	v_b3 := pg_temp.sbf_fail(v_surface, repeat('ae', 20), array[v_c1, v_c2], v_anna, v_detail);
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_build_handbacks where build_id = v_b) = 'superseded'
		and (select state = 'pending' and fix_number = 2 from public.qorpera_surface_build_handbacks where build_id = v_b3)
		and (select count(*) from public.qorpera_surface_build_handbacks
			where session_id = v_s2 and state in ('pending', 'queued')) = 1,
		'two failures for one session leave one open hand-back'
	);
	perform pg_temp.sbf_lane();
	update public.qorpera_surface_build_handbacks set queued_at = clock_timestamp() - interval '2 days' where build_id = v_b3;
	update public.qorpera_surface_session_messages set created_at = created_at - interval '3 days' where session_id = v_s2;
	v_claimed := pg_temp.sbf_lane('sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_s2;
	v_result := pg_temp.sbf_service(format('select public.qorpera_surface_enqueue_session_run(%L, %L)', v_s2, v_lease));
	perform pg_temp.sbf_assert(
		v_result = '{"status": "unavailable", "reason": "lease_lost"}'::jsonb
		and (select state = 'ready' and lease_token is null from public.qorpera_surface_sessions where id = v_s2)
		and (select sequence from public.qorpera_runtime_workers where id = v_w2) = 6
		and not exists (select 1 from public.qorpera_coding_session_turns where worker_id = v_w2 and sequence = 7)
		and (select state from public.qorpera_surface_build_handbacks where build_id = v_b3) = 'stale',
		'a hand-back that aged in the queue opens no turn and replays nothing: ' || v_result::text
	);

	v_b := pg_temp.sbf_fail(v_surface, repeat('af', 20), array[v_c1, v_c2], v_anna, v_detail);
	perform pg_temp.sbf_lane();
	perform public.qorpera_record_surface_change(v_s2, 'Tax', 'Tax', 'git_range',
		repeat('8', 40), repeat('9', 40), '{}'::uuid[], array['src/tax.ts'], null, null, false);
	v_claimed := pg_temp.sbf_lane('sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem where (elem ->> 'sessionId')::uuid = v_s2;
	v_result := pg_temp.sbf_service(format('select public.qorpera_surface_enqueue_session_run(%L, %L)', v_s2, v_lease));
	perform pg_temp.sbf_assert(
		v_result ->> 'reason' = 'lease_lost'
		and (select state from public.qorpera_surface_sessions where id = v_s2) = 'ready'
		and (select sequence from public.qorpera_runtime_workers where id = v_w2) = 6
		and (select state from public.qorpera_surface_build_handbacks where build_id = v_b) = 'stale',
		'a queued hand-back whose session staged something since opens no turn: ' || v_result::text
	);

	update public.qorpera_surface_changes
	set status = 'merged', landed_change_number = 1, resolved_at = clock_timestamp(), published_at = null
	where id = v_c1;
	perform pg_temp.sbf_member(v_anna, format('select public.qorpera_publish_surface(%L)', v_surface));
	v_claimed := pg_temp.sbf_lane();
	select (elem ->> 'jobId')::uuid, (elem ->> 'leaseToken')::uuid into strict v_job, v_job_lease
	from jsonb_array_elements(v_claimed -> 'publishes') elem where (elem ->> 'surfaceId')::uuid = v_surface;
	v_result := pg_temp.sbf_request('publish', v_job, v_job_lease, repeat('3', 39) || 'a', v_recipe);
	v_b := pg_temp.sbf_build('failed', v_detail);
	select * into strict v_handback from public.qorpera_surface_build_handbacks where build_id = v_b;
	perform pg_temp.sbf_assert(
		v_handback.kind = 'publish' and v_handback.session_id = v_s1 and v_handback.change_id = v_c1
		and v_handback.state = 'pending'
		and v_handback.followup = 'The platform could not build the interface to publish it after your change "Hero" landed on main, so the live site still shows the version published before.'
			|| E'\n\nWhat the build reported:\n' || v_detail
			|| E'\n\nFix the build in this session: change the code on your branch until the project''s preview recipe in .qorpera/checks.json builds on top of the current main (run it yourself to check), commit, stage the fix with coding_record_change, and finish with coding_finish. This is automatic fix 1 of 3.'
		and (select publish_status from public.qorpera_surfaces where id = v_surface) = 'failed'
		and (select (public.qorpera_surface_summary_json(s) ->> 'publishBeingFixed')::boolean
			from public.qorpera_surfaces s where s.id = v_surface),
		'a failed publish goes to the session whose change landed last, and the surface says it is being fixed: '
			|| row_to_json(v_handback)::text
	);

	perform pg_temp.sbf_lane();
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_build_handbacks where build_id = v_b) = 'queued',
		'the publish failure is queued on its finished session'
	);
	perform pg_temp.sbf_member(v_anna, format(
		'select public.qorpera_reply_surface_session(%L, %L)', v_s1, 'Make the hero blue.'
	));
	perform pg_temp.sbf_turn(v_s1);
	perform pg_temp.sbf_assert(
		(select state from public.qorpera_surface_build_handbacks where build_id = v_b) = 'superseded'
		and exists (select 1 from public.qorpera_coding_session_turns t
			where t.worker_id = v_w1 and t.sequence = 2 and t.input_from = 'member' and t.input_text = 'Make the hero blue.')
		and not (select (public.qorpera_surface_summary_json(s) ->> 'publishBeingFixed')::boolean
			from public.qorpera_surfaces s where s.id = v_surface),
		'a member who writes before the fix turn starts is answered instead, and nothing claims a fix'
	);
end $$;

rollback;
