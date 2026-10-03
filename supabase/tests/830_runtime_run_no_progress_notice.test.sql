-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- A run that makes no progress for 15 minutes (session-buildup audit gap 4, migration 20260930002600): the agent's
-- activity row names the stall and its minutes, and a member is told once per run; nothing stops the run. Progress is
-- the run's newest observation, context view or assignment, or its job's start; never the lease. A tool call still in
-- flight is waiting, not stalled. Clocks are moved back by hand (the replica role skips the rows' guards).

-- Bob's own thread, reopened as in 586: his routine runs there. An admin joins the owner, contributor and viewer.
select pg_temp.path_claims('service_role');
insert into auth.users(id, email) values ('30000000-0000-4000-8000-000000000004', 'path-admin@example.test'),
	('30000000-0000-4000-8000-000000000005', 'path-poster@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000004', 'path-admin@example.test', 'Admin', 'admin'),
	('30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000005', 'path-poster@example.test', 'Poster',
		'contributor');
do $$
declare v_thread uuid; v_routine jsonb; v_wake uuid; v_run uuid;
begin
	update public.qorpera_shared_sessions set status = 'open'
	where environment_id = '30000000-0000-4000-8000-000000000020' and execution_scope ->> 'agentThread' = 'true'
		and staff_agent_id = '30000000-0000-4000-8000-000000000031' returning id into strict v_thread;
	v_routine := pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
		'{"id":"tick","kind":"schedule","intervalMinutes":60,"replyPolicy":"required"}');
	v_wake := pg_temp.wake_schedule(v_routine, 'stall-1');
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where id = v_wake and status = 'materialized' and session_id = v_thread;
	perform pg_temp.wake_start(v_run);
	perform set_config('qorpera_test.stall_run', v_run::text, true);
end
$$;

-- Bob's activity row, as the owner reads it.
create function pg_temp.bob() returns jsonb language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_row jsonb;
begin
	perform pg_temp.path_claims('authenticated', '30000000-0000-4000-8000-000000000001');
	select entry into v_row
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('30000000-0000-4000-8000-000000000020')) entry
	where entry ->> 'staff_agent_id' = '30000000-0000-4000-8000-000000000031';
	perform set_config('request.jwt.claims', v_claims, true);
	return v_row;
end
$$;
create function pg_temp.run() returns uuid language sql as $$
	select current_setting('qorpera_test.stall_run')::uuid
$$;
-- Moves the job's start and the run's assignments back.
create function pg_temp.age(p_minutes integer) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set started_at = started_at - make_interval(mins => p_minutes)
	where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.run());
	update public.qorpera_runner_assignments set created_at = created_at - make_interval(mins => p_minutes)
	where run_id = pg_temp.run();
	set local session_replication_role = origin;
end
$$;
-- One observation of the run, ingested p_minutes ago.
create function pg_temp.observe(p_operation text, p_phase text, p_minutes integer) returns void language sql as $$
	insert into public.qorpera_runtime_observations(run_id, attempt_id, phase, assignment_id, operation, observed_at,
		ingested_at, observation)
	values (pg_temp.run(), extensions.gen_random_uuid(), p_phase,
		(select client_lease_id from public.qorpera_runner_jobs
			where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.run())),
		p_operation, clock_timestamp() - make_interval(mins => p_minutes),
		clock_timestamp() - make_interval(mins => p_minutes), '{}')
$$;
-- The run's open notices, per member.
create function pg_temp.open_notices() returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(notice.user_id, notice.n), '{}') from (
		select user_id, count(*) as n from public.qorpera_member_notifications
		where kind = 'run_no_progress' and acknowledged_at is null and subject ->> 'runId' = pg_temp.run()::text
		group by user_id) notice
$$;
-- Deletes the run's observations ingested in the last minute (all of them with p_all), as if never made.
create function pg_temp.forget(p_all boolean default false) returns void language plpgsql as $$
begin
	delete from public.qorpera_runtime_observations
	where run_id = pg_temp.run() and (p_all or ingested_at > clock_timestamp() - interval '1 minute');
end
$$;
create function pg_temp.sweep() returns jsonb language sql as $$
	select public.qorpera_notify_runs_without_progress()
$$;

-- A. A run that just started is working, with no stall, and nobody is told.
do $$
declare v_row jsonb := pg_temp.bob(); v_sweep jsonb;
begin
	if v_row ->> 'run_id' is distinct from pg_temp.run()::text or v_row ->> 'activity' <> 'working'
		or v_row ? 'no_progress_since' then
		raise exception 'A: a fresh run is working without a stall: %', v_row; end if;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'opened' <> '0' or pg_temp.open_notices() <> '{}' then
		raise exception 'A: nobody is told of a fresh run: %', v_sweep; end if;
end
$$;

-- B. Twenty minutes with nothing: the row names the stall from the run's last progress (its assignment, here), and a
-- routine run's stall is told to the owner and the admin, once each.
select pg_temp.age(20);
do $$
declare v_row jsonb := pg_temp.bob(); v_since timestamptz; v_sweep jsonb; v_notice public.qorpera_member_notifications%rowtype;
begin
	select greatest(job.started_at, (select max(assignment.created_at) from public.qorpera_runner_assignments as assignment
		where assignment.run_id = pg_temp.run())) into v_since
	from public.qorpera_runner_jobs as job where job.id = (select job_id from public.qorpera_execution_runs where id = pg_temp.run());
	if v_row ->> 'activity' <> 'working' or (v_row ->> 'no_progress_since')::timestamptz is distinct from v_since
		or v_row -> 'no_progress_minutes' <> '15' or public.qorpera_run_stall_minutes() <> 15 then
		raise exception 'B: the stall is named from the last progress %, with its minutes: %', v_since, v_row; end if;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'opened' <> '2' or pg_temp.open_notices()
		<> '{"30000000-0000-4000-8000-000000000001": 1, "30000000-0000-4000-8000-000000000004": 1}' then
		raise exception 'B: the owner and the admin are told, and only they: % %', v_sweep, pg_temp.open_notices(); end if;
	select * into strict v_notice from public.qorpera_member_notifications
	where kind = 'run_no_progress' and subject ->> 'runId' = pg_temp.run()::text
		and user_id = '30000000-0000-4000-8000-000000000001';
	if v_notice.subject ->> 'schema' <> 'qorpera.member-notification.run-no-progress/v1'
		or v_notice.subject ->> 'staffAgentId' <> '30000000-0000-4000-8000-000000000031'
		or (v_notice.subject ->> 'since')::timestamptz <> v_since or v_notice.subject ->> 'sessionId' is null
		or v_notice.subject -> 'minutes' <> '15' or v_notice.dedupe_key <> pg_temp.run()::text then
		raise exception 'B: the notice names the run, the agent, the thread and the stall: %', v_notice.subject; end if;
	-- Again: the same run is not told twice.
	if pg_temp.sweep() ->> 'opened' <> '0' or pg_temp.open_notices()
		<> '{"30000000-0000-4000-8000-000000000001": 1, "30000000-0000-4000-8000-000000000004": 1}' then
		raise exception 'B: a stall is told once'; end if;
end
$$;

-- C. A dismissed notice is not sent again for the same run.
do $$
declare v_notice public.qorpera_member_notifications;
begin
	for v_notice in select * from public.qorpera_member_notifications
		where kind = 'run_no_progress' and subject ->> 'runId' = pg_temp.run()::text and acknowledged_at is null loop
		perform pg_temp.path_claims('authenticated', v_notice.user_id);
		perform public.qorpera_acknowledge_member_notification(v_notice.id);
	end loop;
	perform pg_temp.path_claims('service_role');
	if pg_temp.sweep() ->> 'opened' <> '0' or pg_temp.open_notices() <> '{}' then
		raise exception 'C: a dismissed stall stays dismissed'; end if;
end
$$;

-- D. Progress: a model request's result fence now ends the stall. When the run stalls again (its newest progress 16
-- minutes old), the row names the new stall, but the run's member was told once already: no second notice.
select pg_temp.observe('native_result_fence', 'finish', 0);
do $$
begin
	if pg_temp.bob() ? 'no_progress_since' then raise exception 'D: fresh progress is no stall'; end if;
	if pg_temp.sweep() ->> 'opened' <> '0' then raise exception 'D: nobody is told while the run progresses'; end if;
	perform pg_temp.forget();
	perform pg_temp.observe('native_result_fence', 'finish', 16);
	if (pg_temp.bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.run()) then
		raise exception 'D: the stall runs from the newest observation: %', pg_temp.bob(); end if;
	if pg_temp.sweep() ->> 'opened' <> '0' or pg_temp.open_notices() <> '{}' then
		raise exception 'D: one notice per member and run'; end if;
end
$$;

-- E. A tool call in flight for 18 minutes is waiting on that tool, not stalled; once it finished (17 minutes ago), the
-- stall counts. A model request in flight is no tool call: it stalls.
do $$
begin
	perform pg_temp.forget(true);
	perform pg_temp.observe('computer_shell', 'start', 18);
	if pg_temp.bob() ? 'no_progress_since' or pg_temp.sweep() ->> 'opened' <> '0' then
		raise exception 'E: a tool call in flight is no stall: %', pg_temp.bob(); end if;
	perform pg_temp.observe('computer_shell', 'finish', 17);
	if (pg_temp.bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.run()) then
		raise exception 'E: a finished tool call is the last progress: %', pg_temp.bob(); end if;
	perform pg_temp.observe('model_request', 'start', 16);
	if not pg_temp.bob() ? 'no_progress_since' then
		raise exception 'E: a model request in flight is no tool call: %', pg_temp.bob(); end if;
	-- "Writing" pulses come every 5 s on the runner's own timer until the reply ends: a reply hung for good keeps
	-- pulsing, so pulses are no progress. The stall still runs from the model request's start.
	perform pg_temp.observe('message_composition', 'start', 0);
	perform pg_temp.observe('message_composition', 'finish', 0);
	perform pg_temp.observe('message_composition', 'start', 0);
	if (pg_temp.bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.run() and operation <> 'message_composition') then
		raise exception 'E: writing pulses are no progress: %', pg_temp.bob(); end if;
	-- Both halves read the same rows: a tool call in flight behind later pulses is still waited on.
	perform pg_temp.forget(true);
	perform pg_temp.observe('computer_shell', 'start', 18);
	perform pg_temp.observe('message_composition', 'start', 0);
	if pg_temp.bob() ? 'no_progress_since' then
		raise exception 'E: a tool call in flight behind pulses is no stall: %', pg_temp.bob(); end if;
end
$$;

-- F. Who is told: a member-private run's member; a turn's sender in a company thread; a post's poster in the agent's
-- thread; otherwise owners and admins (a contributor and a viewer were not told of a routine run, B). A notice closes
-- itself once the run progresses.
do $$
declare v_sweep jsonb;
begin
	perform pg_temp.forget(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set audience_kind = 'member_private',
		audience_user_id = '30000000-0000-4000-8000-000000000002' where id = pg_temp.run();
	set local session_replication_role = origin;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'opened' <> '1' or pg_temp.open_notices() <> '{"30000000-0000-4000-8000-000000000002": 1}' then
		raise exception 'F: a member-private run tells its member only: % %', v_sweep, pg_temp.open_notices(); end if;
	perform pg_temp.observe('company_read', 'finish', 0);
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'closed' <> '1' or v_sweep ->> 'opened' <> '0' or pg_temp.open_notices() <> '{}' then
		raise exception 'F: the notice closes itself on progress: %', v_sweep; end if;
	perform pg_temp.forget(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set audience_kind = 'company', audience_user_id = null,
		source_kind = 'session_turn', input_ids = array[extensions.gen_random_uuid()],
		created_by_user_id = '30000000-0000-4000-8000-000000000003' where id = pg_temp.run();
	set local session_replication_role = origin;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'opened' <> '1' or pg_temp.open_notices() <> '{"30000000-0000-4000-8000-000000000003": 1}' then
		raise exception 'F: a turn tells its sender (a viewer here): % %', v_sweep, pg_temp.open_notices(); end if;
	-- A member's post in the agent's own thread is a room delivery: it tells the member who posted, not the owner and
	-- admin (a member who has not been told of this run yet).
	perform pg_temp.observe('company_read', 'finish', 0);
	if pg_temp.sweep() ->> 'closed' <> '1' then raise exception 'F: progress closes the sender''s notice'; end if;
	perform pg_temp.forget(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set source_kind = 'room_delivery', input_ids = '{}',
		created_by_user_id = '30000000-0000-4000-8000-000000000005' where id = pg_temp.run();
	set local session_replication_role = origin;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'opened' <> '1' or pg_temp.open_notices() <> '{"30000000-0000-4000-8000-000000000005": 1}' then
		raise exception 'F: a post in the agent''s thread tells its poster: % %', v_sweep, pg_temp.open_notices(); end if;
end
$$;

-- G. A run that ended closes its notice; the job's row was never changed by the sweep.
do $$
declare v_job public.qorpera_runner_jobs%rowtype; v_sweep jsonb;
begin
	select * into strict v_job from public.qorpera_runner_jobs
	where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.run());
	perform pg_temp.sweep();
	if (select row(job.*)::text from public.qorpera_runner_jobs as job where job.id = v_job.id) <> row(v_job.*)::text then
		raise exception 'G: the sweep changes no job'; end if;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'cancelled', cancelled_at = clock_timestamp(),
		cancelled_by_user_id = '30000000-0000-4000-8000-000000000001', lease_token_sha256 = null, lease_expires_at = null
	where id = v_job.id;
	set local session_replication_role = origin;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'closed' <> '1' or pg_temp.open_notices() <> '{}' then
		raise exception 'G: an ended run closes its notice: %', v_sweep; end if;
end
$$;

-- H. The new functions are postgres-only; the notice kind is allowed; the activity row's text is master's but for its
-- two gap 4 lines.
do $$
declare v_text text;
begin
	if has_function_privilege('authenticated', 'public.qorpera_notify_runs_without_progress()', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_notify_runs_without_progress()', 'execute')
		or has_function_privilege('anon', 'public.qorpera_notify_runs_without_progress()', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_run_no_progress_since(uuid,timestamptz)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_run_no_progress_since(uuid,timestamptz)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_schedule_run_progress_notices()', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_run_last_progress_at(uuid,timestamptz)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_run_waiting_on_tool(uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_run_stall_minutes()', 'execute') then
		raise exception 'H: the gap 4 functions are postgres-only'; end if;
	v_text := replace(replace(pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure),
		E'job.lease_expires_at, job.started_at, -- gap 4 (20260930002600)\n', E'job.lease_expires_at,\n'),
		E'\t\t) || coalesce((select jsonb_build_object(''no_progress_since'', stall.since, -- gap 4 (20260930002600)\n'
		|| E'\t\t\t\t''no_progress_minutes'', public.qorpera_run_stall_minutes())\n'
		|| E'\t\t\tfrom (select public.qorpera_run_no_progress_since(activity.run_id, activity.started_at) as since) as stall\n'
		|| E'\t\t\twhere stall.since is not null), ''{}''::jsonb)\n'
		|| E'\t\telse ''{}''::jsonb end', E'\t\t) else ''{}''::jsonb end');
	if md5(v_text) <> 'b62fffee4806f0ae74410e9c27d511c4' then
		raise exception 'H: qorpera_list_staff_execution_activity''s text changed: %', md5(v_text); end if;
	if not has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute') then
		raise exception 'H: the activity read keeps its grants'; end if;
end
$$;

rollback;
