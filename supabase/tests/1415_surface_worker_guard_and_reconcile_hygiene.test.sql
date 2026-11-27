-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.swgrh_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_worker_guard_and_reconcile_hygiene: %', p_message;
	end if;
end $$;

create function pg_temp.swgrh_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_profile uuid := (v_claim ->> 'profileId')::uuid;
	v_env_id uuid;
	v_staff_id uuid;
	v_cofounder public.qorpera_profile_staff%rowtype;
	v_agent_folder text;
	v_todo_id uuid := extensions.gen_random_uuid();
	v_sponsor_binding_id uuid;
	v_sponsor_version bigint;
	v_run_id uuid;
	v_actor jsonb;
	v_rule jsonb;
	v_overload_count integer;
	v_code_surface uuid;
	v_custom_repo_surface uuid;
	v_folder_surface uuid;
	v_s1 uuid;
	v_s2 uuid;
	v_s3 uuid;
	v_c1 uuid;
	v_c2 uuid;
	v_c3 uuid;
	v_rec1 public.qorpera_surface_reconciliations%rowtype;
	v_rec2 public.qorpera_surface_reconciliations%rowtype;
	v_rec3 public.qorpera_surface_reconciliations%rowtype;
	v_rec_lease uuid;
	v_rec_session public.qorpera_surface_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding public.qorpera_coding_sessions%rowtype;
	v_sync_session uuid;
	v_sync_change public.qorpera_surface_changes%rowtype;
	v_errcode text;
	v_sup_s1 uuid;
	v_sup_s2 uuid;
	v_sup_c1 uuid;
	v_sup_c2 uuid;
	v_sup_s1_json jsonb;
	v_sup_s2_json jsonb;
	v_toggled uuid[];
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	select count(*) into v_overload_count
	from pg_proc p
	where p.pronamespace = 'public'::regnamespace
		and p.proname in (
			'qorpera_start_surface_session',
			'qorpera_service_start_surface_session',
			'qorpera_native_surface_start_session',
			'qorpera_record_surface_change',
			'qorpera_native_surface_record_change'
		);
	perform pg_temp.swgrh_assert(v_overload_count = 5, 'Exactly one overload must remain for each updated surface RPC');

	select environment_id, staff_agent_id into strict v_env_id, v_staff_id
	from public.qorpera_company_cofounders
	where profile_id = v_profile
	limit 1;

	select sv.binding_id, sv.version
	into strict v_sponsor_binding_id, v_sponsor_version
	from public.qorpera_execution_sponsor_versions sv
	join public.qorpera_execution_sponsor_bindings sb on sb.id = sv.binding_id
	where sb.profile_id = v_profile
	order by sv.version desc
	limit 1;

	perform pg_temp.swgrh_as(v_owner);
	set local role authenticated;
	v_code_surface := (public.qorpera_create_surface(
		v_profile, 'Web App', 'web-app', 'live_build', 'web_app', 'monitor', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_folder_surface := (public.qorpera_create_surface(
		v_profile, 'Server Analytics', 'server-analytics', 'studio', 'dashboard', 'bars', '#1a56db', 'surfaces/server-analytics', null, false
	) ->> 'id')::uuid;
	reset role;

	insert into public.qorpera_surfaces(
		profile_id, slug, title, surface_group, archetype, source_kind, repository_key, live_head_sha, status
	)
	values (
		v_profile, 'platform-portal', 'Platform Portal', 'products', 'live_build', 'code_repo', 'qorpera/portal-app', repeat('a', 40), 'active'
	)
	returning id into v_custom_repo_surface;

	update public.qorpera_surfaces set live_head_sha = repeat('1', 40) where id = v_code_surface;

	select * into strict v_cofounder
	from public.qorpera_profile_staff
	where profile_id = v_profile and folder_environment_id = v_env_id and folder_retired_at is null and deleted_at is null
	order by created_at asc
	limit 1;
	v_agent_folder := public.qorpera_folder_key(public.qorpera_folder_parent_path(v_cofounder.folder_path));

	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform public.qorpera_folder_materialize_company(v_profile, 16);
	reset role;

	select r.id into strict v_run_id
	from public.qorpera_execution_runs r
	where r.profile_id = v_profile and r.staff_agent_id = v_cofounder.staff_agent_id
	order by r.created_at asc
	limit 1;

	insert into public.qorpera_runtime_agent_todos(
		id, profile_id, environment_id, staff_agent_id, todo_key, title, state,
		folder_environment_id, folder_path, folder_path_version, folder_commit_id
	)
	values (
		v_todo_id, v_profile, v_env_id, v_cofounder.staff_agent_id, 'sync-todo', 'Sync todo', 'open',
		v_env_id, v_agent_folder || '/todos/sync-todo.md', v_cofounder.folder_path_version, v_cofounder.folder_commit_id
	);

	v_actor := jsonb_build_object(
		'staffAgentId', v_cofounder.staff_agent_id,
		'runId', v_run_id,
		'requesterUserId', v_owner,
		'audience', jsonb_build_object('kind', 'company')
	);

	perform set_config(
		'qorpera.folder_worker',
		jsonb_build_object(
			'action', 'dispatch',
			'species', 'coding',
			'harness', 'codex',
			'access', 'read',
			'revival', 'each',
			'title', 'Direct surface write',
			'goal', 'Write directly to surface repo',
			'doneWhen', 'Done',
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'surfaces', 'name', 'web-app', 'baseBranch', 'main')
		)::text,
		true
	);
	v_rule := public.qorpera_company_state_worker_rules(
		v_env_id,
		v_profile,
		v_actor,
		null,
		v_agent_folder || '/todos/sync-todo/direct-surface/brief.md',
		jsonb_build_object(
			'kind', 'worker-brief',
			'id', '14150000-0000-4000-8000-000000000001',
			'species', 'coding',
			'harness', 'codex',
			'access', 'read',
			'revival', 'each',
			'title', 'Direct surface write',
			'goal', 'Write directly to surface repo',
			'doneWhen', 'Done',
			'context', null,
			'sources', '[]'::jsonb,
			'followUps', '0',
			'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'surfaces', 'name', 'web-app', 'baseBranch', 'main')
		) || public.qorpera_company_state_worker_standing('coding', 'read', 'each'),
		'{}'::jsonb
	);
	perform pg_temp.swgrh_assert(
		v_rule ->> 'ok' = 'false' and position('start_surface_session' in coalesce(v_rule -> 'problems' -> 0 ->> 'message', '')) > 0,
		'worker rules must refuse manage_worker coding dispatch targeting surfaces/* repository: ' || coalesce(v_rule::text, 'null')
	);

	perform set_config(
		'qorpera.folder_worker',
		jsonb_build_object(
			'action', 'dispatch',
			'species', 'coding',
			'harness', 'codex',
			'access', 'read',
			'revival', 'each',
			'title', 'Direct bound surface write',
			'goal', 'Write directly to bound surface repo',
			'doneWhen', 'Done',
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'qorpera', 'name', 'portal-app', 'baseBranch', 'main')
		)::text,
		true
	);
	v_rule := public.qorpera_company_state_worker_rules(
		v_env_id,
		v_profile,
		v_actor,
		null,
		v_agent_folder || '/todos/sync-todo/direct-bound-surface/brief.md',
		jsonb_build_object(
			'kind', 'worker-brief',
			'id', '14150000-0000-4000-8000-000000000002',
			'species', 'coding',
			'harness', 'codex',
			'access', 'read',
			'revival', 'each',
			'title', 'Direct bound surface write',
			'goal', 'Write directly to bound surface repo',
			'doneWhen', 'Done',
			'context', null,
			'sources', '[]'::jsonb,
			'followUps', '0',
			'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'repository', jsonb_build_object('host', 'qorpera', 'owner', 'qorpera', 'name', 'portal-app', 'baseBranch', 'main')
		) || public.qorpera_company_state_worker_standing('coding', 'read', 'each'),
		'{}'::jsonb
	);
	perform pg_temp.swgrh_assert(
		v_rule ->> 'ok' = 'false' and position('start_surface_session' in coalesce(v_rule -> 'problems' -> 0 ->> 'message', '')) > 0,
		'worker rules must refuse manage_worker coding dispatch targeting any active code_repo surface repository_key: ' || coalesce(v_rule::text, 'null')
	);

	perform pg_temp.swgrh_as(v_owner);
	set local role authenticated;
	v_s1 := (public.qorpera_start_surface_session(v_folder_surface, 'Pass 1', 'Pass 1') ->> 'id')::uuid;
	v_s2 := (public.qorpera_start_surface_session(v_folder_surface, 'Pass 2', 'Pass 2') ->> 'id')::uuid;
	v_s3 := (public.qorpera_start_surface_session(v_folder_surface, 'Pass 3', 'Pass 3') ->> 'id')::uuid;
	reset role;

	v_c1 := (public.qorpera_record_surface_change(
		v_s1, 'Metrics A', 'Adds CPU chart', 'folder_patch', null, null, '{}'::uuid[],
		array['layout.json'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'layout.json', 'content', '{"v":1}')),
		false
	) ->> 'changeId')::uuid;
	v_c2 := (public.qorpera_record_surface_change(
		v_s2, 'Metrics B', 'Adds memory chart', 'folder_patch', null, null, '{}'::uuid[],
		array['layout.json'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'layout.json', 'content', '{"v":2}')),
		false
	) ->> 'changeId')::uuid;
	v_c3 := (public.qorpera_record_surface_change(
		v_s3, 'Metrics C', 'Adds disk chart', 'folder_patch', null, null, '{}'::uuid[],
		array['layout.json'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'layout.json', 'content', '{"v":3}')),
		false
	) ->> 'changeId')::uuid;

	v_rec1 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_folder_surface, array[v_c1, v_c2], array['layout.json'], v_owner, false, false
	);
	v_rec_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_rec1.id;
	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = v_rec_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_rec1.session_id;

	perform public.qorpera_record_surface_change(
		v_s1, 'Metrics A v2', 'Refined CPU chart', 'folder_patch', null, null, '{}'::uuid[],
		array['layout.json'], null,
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'layout.json', 'content', '{"v":11}')),
		false, null, null, v_c1
	);

	perform pg_temp.swgrh_assert(
		(select status = 'failed' and error_detail = 'Change updated' and expires_at <= clock_timestamp()
			from public.qorpera_surface_reconciliations where id = v_rec1.id)
		and (select state = 'discarded' and lease_token is null
			from public.qorpera_surface_sessions where id = v_rec1.session_id),
		'in-place change update invalidates active reconciliation and discards its internal session'
	);

	v_rec2 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_folder_surface, array[v_c1, v_c2], array['layout.json'], v_owner, false, false
	);
	v_rec_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_rec2.id;
	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = v_rec_lease, lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_rec2.session_id;

	update public.qorpera_surface_reconciliations
	set status = 'failed', expires_at = clock_timestamp(), error_detail = 'Change updated'
	where id = v_rec2.id;

	perform public.qorpera_surface_complete_session_turn(
		v_rec2.session_id, 'ready', 'Late worker reply after invalidation', null, null, null, v_rec_lease
	);
	select * into strict v_rec_session from public.qorpera_surface_sessions where id = v_rec2.session_id;
	perform pg_temp.swgrh_assert(
		v_rec_session.state = 'completed' and v_rec_session.retry_count = 0,
		'completing turn for an already-invalidated reconciliation completes cleanly without retrying or failing'
	);

	v_rec3 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_folder_surface, array[v_c1, v_c3], array['layout.json'], v_owner, false, false
	);
	v_rec_lease := extensions.gen_random_uuid();
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_rec3.id;
	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = v_rec_lease, lease_expires_at = clock_timestamp() + interval '10 minutes', retry_count = 1
	where id = v_rec3.session_id;

	perform public.qorpera_surface_complete_session_turn(
		v_rec3.session_id, 'ready', 'Forgot to call stage_surface_patch', null, null, null, v_rec_lease
	);
	perform pg_temp.swgrh_assert(
		(select status = 'failed'
			and position('Reconciliation turn completed without staging a valid resolution' in coalesce(error_detail, '')) = 1
			and position('Forgot to call stage_surface_patch' in coalesce(error_detail, '')) > 0
			from public.qorpera_surface_reconciliations where id = v_rec3.id),
		'reconciliation turn finishing ready without staging preserves explicit diagnostic error detail'
	);

	v_rec2 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_folder_surface, array[v_c2, v_c3], array['layout.json'], v_owner, false, false
	);
	update public.qorpera_surface_reconciliations set status = 'running' where id = v_rec2.id;
	update public.qorpera_surface_sessions
	set state = 'reconciling_running', lease_token = extensions.gen_random_uuid(), lease_expires_at = clock_timestamp() + interval '10 minutes'
	where id = v_rec2.session_id;

	v_rec3 := public.qorpera_surface_enqueue_silent_reconciliation(
		v_folder_surface, array[v_c1, v_c2, v_c3], array['layout.json'], v_owner, false, false
	);
	perform pg_temp.swgrh_assert(
		not exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec2.id)
		and (select state = 'discarded' and lease_token is null from public.qorpera_surface_sessions where id = v_rec2.session_id)
		and exists (select 1 from public.qorpera_surface_reconciliations where id = v_rec3.id and status = 'queued'),
		'newer member preview reconciliation supersedes running prior member preview reconciliation too'
	);

	v_sup_s1 := (public.qorpera_service_start_surface_session(
		v_profile, v_code_surface, 'Sync latest upstream commits (run 1)', 'Refresh Web App 1',
		'automation', 'GitHub Sync', null, null, null, 'github-sync'
	) ->> 'sessionId')::uuid;
	update public.qorpera_surface_sessions set state = 'ready' where id = v_sup_s1;

	v_sup_c1 := (public.qorpera_record_surface_change(
		v_sup_s1, 'Sync run 1', 'First sync snapshot', 'git_range',
		repeat('1', 40), repeat('2', 40), '{}'::uuid[], array['src/app.ts'],
		jsonb_build_object('filesChanged', 1, 'additions', 10, 'deletions', 2), null, true
	) ->> 'changeId')::uuid;

	perform pg_temp.swgrh_as(v_owner);
	set local role authenticated;
	perform public.qorpera_set_preview_selection(v_code_surface, array[v_sup_c1], null, '{}'::uuid[], '/');
	reset role;

	v_sup_s2 := (public.qorpera_service_start_surface_session(
		v_profile, v_code_surface, 'Sync latest upstream commits (run 2)', 'Refresh Web App 2',
		'automation', 'GitHub Sync', null, null, null, 'github-sync'
	) ->> 'sessionId')::uuid;
	v_sup_c2 := (public.qorpera_record_surface_change(
		v_sup_s2, 'Sync run 2', 'Second sync snapshot', 'git_range',
		repeat('1', 40), repeat('3', 40), '{}'::uuid[], array['src/app.ts', 'src/nav.ts'],
		jsonb_build_object('filesChanged', 2, 'additions', 25, 'deletions', 5), null, true
	) ->> 'changeId')::uuid;

	select toggled_change_ids into v_toggled
	from public.qorpera_member_surface_state
	where surface_id = v_code_surface and user_id = v_owner;

	select public.qorpera_surface_session_json(s) into v_sup_s1_json from public.qorpera_surface_sessions s where s.id = v_sup_s1;
	select public.qorpera_surface_session_json(s) into v_sup_s2_json from public.qorpera_surface_sessions s where s.id = v_sup_s2;

	perform pg_temp.swgrh_assert(
		(select status = 'discarded' and supersede_key = 'github-sync' from public.qorpera_surface_changes where id = v_sup_c1)
		and (select status = 'staged' and supersede_key = 'github-sync' from public.qorpera_surface_changes where id = v_sup_c2)
		and (select state = 'discarded' from public.qorpera_surface_sessions where id = v_sup_s1)
		and v_toggled = array[v_sup_c2]
		and v_sup_s2_json ->> 'supersedeKey' = 'github-sync'
		and v_sup_s2_json #>> '{changes,0,supersedeKey}' = 'github-sync'
		and exists (
			select 1 from public.qorpera_surface_session_messages m
			where m.session_id = v_sup_s1 and m.change_id = v_sup_c1 and m.body = 'Superseded by newer update: Sync run 2'
		),
		'supersede_key discards prior open change, transitions superseded session, swaps toggled preview selection, and exposes supersedeKey in JSON'
	);

	perform pg_temp.swgrh_as(v_owner);
	set local role authenticated;
	v_sync_session := (public.qorpera_start_surface_session(v_code_surface, 'Fallback staged diff stats', 'Fallback diff') ->> 'id')::uuid;
	reset role;

	insert into public.qorpera_runtime_workers(
		profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
		access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
		owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
		surface_backed, surface_session_id
	)
	values (
		v_profile, v_env_id, v_staff_id, null,
		'surface-' || replace(v_sync_session::text, '-', ''), 'coding', 'Fallback diff',
		'read', 'each', jsonb_build_object('goal', 'Fallback diff'), 'active', 1, v_owner, null,
		v_owner, v_sponsor_binding_id, v_sponsor_version,
		true, v_sync_session
	)
	returning * into v_worker;

	insert into public.qorpera_coding_sessions(
		worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha,
		phase, surface_session_id
	)
	values (
		v_worker.id, v_profile, v_env_id, null, 'codex',
		jsonb_build_object('host', 'qorpera', 'owner', 'surfaces', 'name', 'web-app', 'baseBranch', 'main'),
		'qorpera/coding/' || v_worker.id::text, repeat('1', 40), 'running', v_sync_session
	)
	returning * into v_coding;

	insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text)
	values (v_worker.id, 1, 'dispatch', null);

	update public.qorpera_surface_sessions
	set worker_id = v_worker.id, state = 'running', lease_token = extensions.gen_random_uuid(), base_sha = repeat('1', 40)
	where id = v_sync_session;

	perform public.qorpera_surface_sync_coding_completion(
		v_coding, v_worker, 'succeeded', 'Added navigation bar.', null, null,
		jsonb_build_array(jsonb_build_object(
			'kind', 'staged',
			'branch', v_coding.branch,
			'baseSha', repeat('1', 40),
			'headSha', repeat('4', 40),
			'affectedPaths', jsonb_build_array('src/nav.tsx', 'src/nav.css'),
			'diffStats', jsonb_build_object('filesChanged', 2, 'additions', 42, 'deletions', 7)
		)),
		null
	);

	select * into strict v_sync_change
	from public.qorpera_surface_changes
	where session_id = v_sync_session
	order by seq desc limit 1;

	perform pg_temp.swgrh_assert(
		v_sync_change.affected_paths = array['src/nav.tsx', 'src/nav.css']
		and v_sync_change.diff_stats = jsonb_build_object('filesChanged', 2, 'additions', 42, 'deletions', 7),
		'fallback coding completion sync populates affected_paths and diff_stats from staged artifact'
	);

	update public.qorpera_surface_sessions
	set state = 'discarded', lease_token = null, lease_expires_at = null
	where id = v_sync_session;
	update public.qorpera_runtime_workers set state = 'active' where id = v_worker.id;

	perform public.qorpera_surface_expire_coding_sessions(clock_timestamp(), 16);
	perform pg_temp.swgrh_assert(
		(select state = 'cancelled' from public.qorpera_runtime_workers where id = v_worker.id),
		'expire_coding_sessions sweeps and cancels active coding workers of discarded surface sessions'
	);

	begin
		perform public.qorpera_service_start_surface_session(
			v_profile, v_code_surface, 'Bad key', 'Bad key', 'automation', 'Sync', null, null, null, 'BAD KEY!'
		);
		perform pg_temp.swgrh_assert(false, 'invalid supersedeKey must be refused');
	exception when others then
		get stacked diagnostics v_errcode = returned_sqlstate;
		perform pg_temp.swgrh_assert(v_errcode = '22023', 'invalid supersedeKey must raise 22023, got ' || coalesce(v_errcode, 'null'));
	end;
end $$;

rollback;
