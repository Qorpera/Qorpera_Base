-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sdwc_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_discard_worktree_cleanup: %', p_message;
	end if;
end $$;

create function pg_temp.sdwc_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sdwc_turn(p_session uuid)
returns jsonb language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
begin
	select lease_token into v_lease
	from public.qorpera_surface_sessions
	where id = p_session and state = 'running' and lease_token is not null;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	if v_lease is null then
		v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
		select (elem ->> 'leaseToken')::uuid into strict v_lease
		from jsonb_array_elements(v_claimed -> 'sessions') elem
		where (elem ->> 'sessionId')::uuid = p_session;
	end if;
	v_enq := public.qorpera_surface_enqueue_session_run(p_session, v_lease);
	reset role;
	if v_enq ->> 'status' <> 'enqueued' then
		raise exception 'surface_discard_worktree_cleanup: enqueue failed: %', v_enq;
	end if;
	return v_enq;
end $$;

create function pg_temp.sdwc_settle_worker_idle(p_worker uuid)
returns void language plpgsql as $$
begin
	update public.qorpera_runtime_workers
	set state = 'succeeded', result = '{"summary":"Done"}'::jsonb, reported_at = clock_timestamp(),
		completion_state = 'suppressed', updated_at = clock_timestamp()
	where id = p_worker;
	update public.qorpera_coding_sessions
	set phase = 'completed', finished_at = coalesce(finished_at, clock_timestamp()),
		lease_owner = null, lease_token = null, lease_until = null, vm_allocation_id = null
	where worker_id = p_worker;
	update public.qorpera_coding_session_turns
	set outcome = coalesce(outcome, '{"state":"completed"}'::jsonb), settled_at = coalesce(settled_at, clock_timestamp())
	where worker_id = p_worker and outcome is null;
end $$;

create function pg_temp.sdwc_refused(p_user uuid, p_sql text, p_state text)
returns void language plpgsql as $$
begin
	if p_user is null then
		perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
		set local role service_role;
	else
		perform pg_temp.sdwc_as(p_user);
		set local role authenticated;
	end if;
	begin
		execute p_sql;
	exception when others then
		reset role;
		if sqlstate is distinct from p_state then
			raise exception 'surface_discard_worktree_cleanup: expected %, got % (%) from %',
				p_state, sqlstate, sqlerrm, p_sql;
		end if;
		return;
	end;
	reset role;
	raise exception 'surface_discard_worktree_cleanup: expected % from %', p_state, p_sql;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_other_owner constant uuid := '13800000-0000-4000-8000-000000000098';
	v_company_b constant uuid := '13800000-0000-4000-8000-000000000011';
	v_env_b constant uuid := '13800000-0000-4000-8000-000000000021';
	v_machine_id constant uuid := '13800000-0000-4000-8000-0000000000d1';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_env uuid;
	v_site uuid;
	v_site2 uuid;
	v_note uuid;
	v_session_a uuid;
	v_worker_a uuid;
	v_session_b uuid;
	v_worker_b uuid;
	v_change_b uuid;
	v_session_c uuid;
	v_worker_c uuid;
	v_change_c uuid;
	v_session_merged uuid;
	v_worker_merged uuid;
	v_note_session uuid;
	v_exp1 uuid;
	v_exp1_v1 uuid;
	v_exp1_v2 uuid;
	v_exp1_w1 uuid;
	v_exp1_w2 uuid;
	v_exp2 uuid;
	v_exp2_v1 uuid;
	v_exp2_v2 uuid;
	v_exp2_w1 uuid;
	v_exp2_w2 uuid;
	v_del_session uuid;
	v_del_worker uuid;
	v_opt_session uuid;
	v_opt_worker uuid;
	v_del_land_job uuid := '13800000-0000-4000-8000-000000000031';
	v_enq jsonb;
	v_claimed jsonb;
	v_cleanup jsonb;
	v_job_id uuid;
	v_lease uuid;
	v_count integer;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	select environment_id into strict v_env from public.qorpera_company_cofounders where profile_id = v_company limit 1;

	insert into auth.users(id, email) values (v_other_owner, 'owner-sdwc-b@example.test');
	insert into public.qorpera_profiles(id, name, created_by_user_id) values (v_company_b, 'Executor Template Co', v_other_owner);
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values (v_env_b, v_company_b, 'Executor Template Env', 1, v_other_owner);
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env_b, 'exec-1380', true, array['codex', 'claude-code']);

	perform pg_temp.sdwc_assert(
		has_function_privilege('service_role', 'public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)', 'EXECUTE')
			and not has_function_privilege('anon', 'public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)', 'EXECUTE')
			and not has_function_privilege('authenticated', 'public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)', 'EXECUTE')
			and not has_function_privilege('service_role', 'public.qorpera_surface_lock_coding_workers_for_sessions(uuid[])', 'EXECUTE')
			and not has_function_privilege('authenticated', 'public.qorpera_surface_lock_coding_workers_for_sessions(uuid[])', 'EXECUTE')
			and not has_function_privilege('service_role', 'public.qorpera_surface_archive_locked_coding_workers(uuid[],text)', 'EXECUTE')
			and not has_function_privilege('service_role', 'public.qorpera_surface_archive_coding_workers(uuid[],text)', 'EXECUTE')
			and not has_function_privilege('service_role', 'public.qorpera_surface_enqueue_session_cleanup(uuid,uuid)', 'EXECUTE'),
		'only service_role can call qorpera_surface_complete_cleanup and internal helpers are private'
	);

	perform pg_temp.sdwc_assert(
		not exists (select 1 from public.qorpera_code_repositories where not retire_enabled),
		'existing code repositories have retire_enabled backfilled to true'
	);

	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values (v_machine_id, 'member', v_company, v_env, v_anna, 'exec-1380', repeat('7', 64), '{}');

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_site := (public.qorpera_create_surface(
		v_company, 'Website', 'website', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_site2 := (public.qorpera_create_surface(
		v_company, 'Docs', 'docs', 'live_build', 'website', 'globe', '#0a84ff', null, null, false
	) ->> 'id')::uuid;
	v_note := (public.qorpera_create_surface(
		v_company, 'Launch Note', 'launch-note', 'studio', 'report', 'figure:book', null, 'surfaces/launch-note', null, false
	) ->> 'id')::uuid;
	v_session_a := (public.qorpera_start_surface_session(v_site, 'Build hero', 'Hero') ->> 'id')::uuid;
	v_note_session := (public.qorpera_start_surface_session(v_note, 'Write note', 'Note') ->> 'id')::uuid;
	reset role;

	v_enq := pg_temp.sdwc_turn(v_session_a);
	v_worker_a := (v_enq ->> 'workerId')::uuid;
	update public.qorpera_surface_sessions set branch_head_sha = repeat('a', 40) where id = v_session_a;
	update public.qorpera_coding_sessions
	set attached_machine_id = v_machine_id,
		attachment_token = extensions.gen_random_uuid(),
		attachment_until = clock_timestamp() + interval '60 seconds',
		attachment_turn = 1,
		attached_at = clock_timestamp()
	where worker_id = v_worker_a;

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_session(v_session_a);
	perform public.qorpera_discard_surface_session(v_note_session);
	reset role;

	perform pg_temp.sdwc_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_a) = 'discarded'
			and (select state from public.qorpera_runtime_workers where id = v_worker_a) = 'cancelled'
			and (select phase from public.qorpera_coding_sessions where worker_id = v_worker_a) = 'cancelled'
			and (select archived_at is not null and archived_by = 'kernel' and attachment_until <= clock_timestamp()
				from public.qorpera_coding_sessions where worker_id = v_worker_a),
		'discarding an active code_repo session cancels, archives, and expires VM attachment immediately'
	);
	perform pg_temp.sdwc_assert(
		(select count(*) from public.qorpera_surface_jobs
			where session_id = v_session_a and kind = 'cleanup_session' and status = 'queued'
				and payload ->> 'workerId' = v_worker_a::text) = 1
			and not exists (select 1 from public.qorpera_surface_jobs where session_id = v_note_session and kind = 'cleanup_session'),
		'cleanup_session job is queued for code_repo session and skipped for folder surface session'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;
	perform pg_temp.sdwc_assert(
		jsonb_array_length(v_claimed -> 'cleanups') = 0,
		'cleanup_session is NOT claimed while coding session is still attached to a VM'
	);

	update public.qorpera_coding_sessions
	set attached_machine_id = null, attachment_token = null, attachment_until = null, attachment_turn = null, attached_at = null
	where worker_id = v_worker_a;
	update public.qorpera_coding_session_turns
	set outcome = coalesce(outcome, '{"state":"cancelled"}'::jsonb), settled_at = coalesce(settled_at, clock_timestamp())
	where worker_id = v_worker_a and outcome is null;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform pg_temp.sdwc_assert(
		jsonb_array_length(public.qorpera_surface_claim_pending_jobs_for_lane(16, 'folder') -> 'cleanups') = 0
			and jsonb_array_length(public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions') -> 'cleanups') = 0,
		'non-code_repo lanes never claim cleanup_session jobs'
	);
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;
	perform pg_temp.sdwc_assert(
		jsonb_array_length(v_claimed -> 'cleanups') = 1,
		'cleanup_session is claimed once coding worker is detached and settled: ' || v_claimed::text
	);
	v_cleanup := v_claimed -> 'cleanups' -> 0;
	v_job_id := (v_cleanup ->> 'jobId')::uuid;
	v_lease := (v_cleanup ->> 'leaseToken')::uuid;
	perform pg_temp.sdwc_assert(
		(v_cleanup ->> 'sessionId')::uuid = v_session_a
			and (v_cleanup ->> 'workerId')::uuid = v_worker_a
			and (v_cleanup ->> 'sourceKind') = 'code_repo'
			and (v_cleanup ->> 'environmentId')::uuid = v_env,
		'claimed cleanup payload carries session, worker, repository, and environment metadata: ' || v_cleanup::text
	);

	perform pg_temp.sdwc_refused(
		v_anna,
		format('select public.qorpera_reply_surface_session(%L, %L, true)', v_session_a, 'Try again'),
		'55000'
	);
	perform pg_temp.sdwc_refused(
		null,
		format('select public.qorpera_surface_complete_cleanup(%L, %L, null, %L)',
			v_job_id, 'completed', extensions.gen_random_uuid()),
		'55000'
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_cleanup(v_job_id, 'completed', null, v_lease);
	reset role;
	perform pg_temp.sdwc_assert(
		(select status from public.qorpera_surface_jobs where id = v_job_id) = 'completed'
			and (select branch_head_sha is null from public.qorpera_surface_sessions where id = v_session_a),
		'completing cleanup marks job completed and clears branch_head_sha on discarded session'
	);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_session_a, 'Start over fresh', true);
	perform public.qorpera_discard_surface_session(v_session_a);
	reset role;
	perform pg_temp.sdwc_assert(
		(select count(*) from public.qorpera_surface_jobs
			where session_id = v_session_a and kind = 'cleanup_session' and status = 'queued') = 1,
		'reopening after completed cleanup and discarding again enqueues a fresh cleanup job'
	);
	delete from public.qorpera_surface_jobs where session_id = v_session_a and kind = 'cleanup_session' and status = 'queued';

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_session_b := (public.qorpera_start_surface_session(v_site, 'Update footer', 'Footer') ->> 'id')::uuid;
	reset role;
	v_worker_b := (pg_temp.sdwc_turn(v_session_b) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_settle_worker_idle(v_worker_b);
	update public.qorpera_surface_sessions
	set state = 'ready', has_active_chat = false, lease_token = null, lease_expires_at = null, branch_head_sha = repeat('b', 40)
	where id = v_session_b;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, status, parent_sha, head_sha)
	values (v_company, v_site, v_session_b, 1, 'Footer tweak', 'git_range', 'staged', repeat('0', 40), repeat('b', 40))
	returning id into v_change_b;

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_change_b);
	reset role;
	perform pg_temp.sdwc_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_b) = 'discarded'
			and (select archived_at is not null from public.qorpera_coding_sessions where worker_id = v_worker_b)
			and (select count(*) from public.qorpera_surface_jobs
				where session_id = v_session_b and kind = 'cleanup_session' and status = 'queued') = 1,
		'discarding the last change with chat closed archives the coding session and queues cleanup'
	);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_change_b);
	reset role;
	perform pg_temp.sdwc_assert(
		(select status from public.qorpera_surface_changes where id = v_change_b) = 'staged'
			and not exists (select 1 from public.qorpera_surface_jobs where session_id = v_session_b and kind = 'cleanup_session'),
		'undoing a discarded change before cleanup runs restores it and cancels the queued cleanup job'
	);

	update public.qorpera_coding_sessions set archived_at = null, archived_by = null where worker_id = v_worker_b;
	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_change_b);
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	v_job_id := (v_claimed -> 'cleanups' -> 0 ->> 'jobId')::uuid;
	v_lease := (v_claimed -> 'cleanups' -> 0 ->> 'leaseToken')::uuid;
	perform public.qorpera_surface_complete_cleanup(v_job_id, 'completed', null, v_lease);
	reset role;
	perform pg_temp.sdwc_refused(
		v_anna,
		format('select public.qorpera_undo_surface_change(%L)', v_change_b),
		'22023'
	);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_session_c := (public.qorpera_start_surface_session(v_site, 'Open chat draft', 'Chat draft') ->> 'id')::uuid;
	reset role;
	v_worker_c := (pg_temp.sdwc_turn(v_session_c) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_settle_worker_idle(v_worker_c);
	update public.qorpera_surface_sessions
	set state = 'ready', has_active_chat = true, lease_token = null, lease_expires_at = null
	where id = v_session_c;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, status, parent_sha, head_sha)
	values (v_company, v_site, v_session_c, 1, 'Chat tweak', 'git_range', 'staged', repeat('0', 40), repeat('c', 40))
	returning id into v_change_c;

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_change_c);
	reset role;
	perform pg_temp.sdwc_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_c) = 'ready'
			and (select archived_at is null from public.qorpera_coding_sessions where worker_id = v_worker_c)
			and not exists (select 1 from public.qorpera_surface_jobs where session_id = v_session_c and kind = 'cleanup_session'),
		'discarding the last change while chat drawer is open keeps coding session live until drawer closes'
	);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_set_session_chat_open(v_session_c, false);
	reset role;
	perform pg_temp.sdwc_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_c) = 'discarded'
			and (select archived_at is not null from public.qorpera_coding_sessions where worker_id = v_worker_c)
			and (select count(*) from public.qorpera_surface_jobs
				where session_id = v_session_c and kind = 'cleanup_session' and status = 'queued') = 1,
		'closing chat drawer on a session with only discarded changes archives coding session and queues cleanup'
	);
	delete from public.qorpera_surface_jobs where session_id = v_session_c and kind = 'cleanup_session';

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_session_merged := (public.qorpera_start_surface_session(v_site, 'Landed work', 'Landed') ->> 'id')::uuid;
	reset role;
	v_worker_merged := (pg_temp.sdwc_turn(v_session_merged) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_settle_worker_idle(v_worker_merged);
	update public.qorpera_surface_sessions
	set state = 'ready', has_active_chat = true, lease_token = null, lease_expires_at = null
	where id = v_session_merged;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, status)
	values
		(v_company, v_site, v_session_merged, 1, 'Already merged', 'git_range', 'merged'),
		(v_company, v_site, v_session_merged, 2, 'Extra staged', 'git_range', 'staged');
	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_session(v_session_merged);
	reset role;
	perform pg_temp.sdwc_assert(
		(select state from public.qorpera_surface_sessions where id = v_session_merged) = 'completed'
			and (select archived_at is null from public.qorpera_coding_sessions where worker_id = v_worker_merged)
			and not exists (select 1 from public.qorpera_surface_jobs where session_id = v_session_merged and kind = 'cleanup_session'),
		'dismissing a session that has a merged change completes it without queuing branch cleanup'
	);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_exp1_v1 := (public.qorpera_start_surface_session(
		v_site, 'Explore A vs B', 'Explore 1', 'member', null, null, 2, 'Explore 1'
	) ->> 'id')::uuid;
	reset role;
	select exploration_id into strict v_exp1 from public.qorpera_surface_sessions where id = v_exp1_v1;
	select id into strict v_exp1_v2 from public.qorpera_surface_sessions where exploration_id = v_exp1 and id <> v_exp1_v1;
	v_exp1_w1 := (pg_temp.sdwc_turn(v_exp1_v1) ->> 'workerId')::uuid;
	v_exp1_w2 := (pg_temp.sdwc_turn(v_exp1_v2) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_settle_worker_idle(v_exp1_w1);
	perform pg_temp.sdwc_settle_worker_idle(v_exp1_w2);
	update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id in (v_exp1_v1, v_exp1_v2);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_choose_exploration(v_exp1, v_exp1_v1);
	reset role;
	perform pg_temp.sdwc_assert(
		(select archived_at is null from public.qorpera_coding_sessions where worker_id = v_exp1_w1)
			and not exists (select 1 from public.qorpera_surface_jobs where session_id = v_exp1_v1 and kind = 'cleanup_session')
			and (select archived_at is not null from public.qorpera_coding_sessions where worker_id = v_exp1_w2)
			and (select count(*) from public.qorpera_surface_jobs
				where session_id = v_exp1_v2 and kind = 'cleanup_session' and status = 'queued') = 1,
		'choosing an exploration variant archives and queues cleanup only for losing variants'
	);
	delete from public.qorpera_surface_jobs where session_id = v_exp1_v2 and kind = 'cleanup_session';

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_exp2_v1 := (public.qorpera_start_surface_session(
		v_site, 'Explore C vs D', 'Explore 2', 'member', null, null, 2, 'Explore 2'
	) ->> 'id')::uuid;
	reset role;
	select exploration_id into strict v_exp2 from public.qorpera_surface_sessions where id = v_exp2_v1;
	select id into strict v_exp2_v2 from public.qorpera_surface_sessions where exploration_id = v_exp2 and id <> v_exp2_v1;
	v_exp2_w1 := (pg_temp.sdwc_turn(v_exp2_v1) ->> 'workerId')::uuid;
	v_exp2_w2 := (pg_temp.sdwc_turn(v_exp2_v2) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_exploration(v_exp2);
	reset role;
	perform pg_temp.sdwc_assert(
		(select count(*) from public.qorpera_coding_sessions where worker_id in (v_exp2_w1, v_exp2_w2) and archived_at is not null) = 2
			and (select count(*) from public.qorpera_surface_jobs
				where session_id in (v_exp2_v1, v_exp2_v2) and kind = 'cleanup_session' and status = 'queued') = 2,
		'discarding an exploration archives and queues cleanup for all variant sessions'
	);
	delete from public.qorpera_surface_jobs where session_id in (v_exp2_v1, v_exp2_v2) and kind = 'cleanup_session';

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_del_session := (public.qorpera_start_surface_session(v_site2, 'Build docs', 'Docs') ->> 'id')::uuid;
	reset role;
	v_del_worker := (pg_temp.sdwc_turn(v_del_session) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_settle_worker_idle(v_del_worker);
	update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null where id = v_del_session;
	insert into public.qorpera_surface_jobs(id, profile_id, surface_id, kind, status)
	values (v_del_land_job, v_company, v_site2, 'land_change', 'queued');

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_archive_surface(v_site2);
	perform public.qorpera_archive_surface(v_site2);
	reset role;

	perform pg_temp.sdwc_assert(
		(select status from public.qorpera_surface_jobs where id = v_del_land_job) = 'failed'
			and (select archived_at is not null from public.qorpera_coding_sessions where worker_id = v_del_worker)
			and (select count(*) from public.qorpera_surface_jobs
				where session_id = v_del_session and kind = 'cleanup_session' and status = 'queued') = 1,
		'deleting a code_repo surface fails non-cleanup jobs, archives sessions, and queues cleanup idempotently'
	);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'code_repo');
	reset role;
	select count(*) into v_count
	from jsonb_array_elements(v_claimed -> 'cleanups') elem
	where (elem ->> 'sessionId')::uuid = v_del_session;
	perform pg_temp.sdwc_assert(
		v_count = 1,
		'cleanup_session jobs on deleted (archived) code_repo surfaces are still claimed by code_repo lane'
	);

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	v_opt_session := (public.qorpera_start_surface_session(v_site, 'Try option group', 'Options') ->> 'id')::uuid;
	reset role;
	v_opt_worker := (pg_temp.sdwc_turn(v_opt_session) ->> 'workerId')::uuid;
	perform pg_temp.sdwc_settle_worker_idle(v_opt_worker);
	update public.qorpera_surface_sessions
	set state = 'ready', has_active_chat = false, lease_token = null, lease_expires_at = null
	where id = v_opt_session;
	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, kind, status, parent_sha, head_sha, option_group_key, option_group_title
	)
	values
		(v_company, v_site, v_opt_session, 1, 'Option A', 'git_range', 'staged', repeat('0', 40), repeat('d', 40), 'hero-style', 'Hero style'),
		(v_company, v_site, v_opt_session, 2, 'Option B', 'git_range', 'staged', repeat('0', 40), repeat('e', 40), 'hero-style', 'Hero style');

	perform pg_temp.sdwc_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_option_group(v_opt_session, 'hero-style');
	reset role;
	perform pg_temp.sdwc_assert(
		(select state from public.qorpera_surface_sessions where id = v_opt_session) = 'discarded'
			and (select archived_at is not null from public.qorpera_coding_sessions where worker_id = v_opt_worker)
			and (select count(*) from public.qorpera_surface_jobs
				where session_id = v_opt_session and kind = 'cleanup_session' and status = 'queued') = 1,
		'discarding the last option group with chat closed archives the coding session and queues cleanup'
	);
end $$;

rollback;
