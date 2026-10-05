-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A run that makes no progress for 15 minutes (session-buildup audit gap 4, migration 20260930002600), on a folder-v2
-- company (ported from snapshot-v1 in the legacy sweep): the agent's activity row names the stall and its minutes, and a
-- member is told once per run; nothing stops the run. Progress is the run's newest observation, context view or
-- assignment, or its job's start; never the lease. A tool call still in flight is no exception (20260930051000). Clocks
-- are moved back by hand (the replica role skips the rows' guards).

-- Bob's routine, a routine file in his folder saved by the owner; its slot fires, the folder materializer turns the
-- wake into a run in Bob's thread, and the run starts on a real runner with a lease (Alice's run of 924 holds a lease
-- too). A contributor who posts joins the owner, contributor, viewer and admin of 924.
insert into auth.users(id, email) values ('92400000-0000-4000-8000-000000000006', 'base-poster@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000006', 'base-poster@example.test', 'Poster',
		'contributor');
select pg_temp.base_commit(pg_temp.base_owner(), 'stall-routine', jsonb_build_array(
	pg_temp.base_write('agents/bob/routines/tick.md', 'routine', E'---\ntitle: Tick\n---\nLook at the numbers.\n',
		jsonb_build_object('kind', 'routine', 'id', '83000000-0000-4000-8000-0000000000e1', 'title', 'Tick', 'status', 'active',
			'trigger', jsonb_build_object('when', 'every', 'minutes', 60, 'starts', null), 'timezone', null, 'ends', null,
			'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'required', 'conclusion', null,
			'instructions', 'Look at the numbers.')))) \g /dev/null
do $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_wake jsonb; v_pass jsonb; v_run uuid;
	v_at timestamptz := date_trunc('milliseconds', clock_timestamp()) - interval '1 minute';
begin
	perform pg_temp.base_claims('service_role');
	select * into strict v_routine from public.qorpera_cloud_routines where id = '83000000-0000-4000-8000-0000000000e1'
		and owner_staff_agent_id = '92400000-0000-4000-8000-000000000031';
	v_wake := public.qorpera_enqueue_routine_wake(v_routine.id, v_routine.current_version, extensions.gen_random_uuid(),
		'stall-1', 'file', v_at, null, v_at + interval '1 hour');
	perform pg_temp.base_assert(v_wake ->> 'status' = 'queued', 'Bob''s routine slot is queued: ' || v_wake::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'Bob''s routine slot is materialized: ' || v_pass::text);
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_wake_occurrences
		where id = (v_wake ->> 'occurrence_id')::uuid and status = 'materialized' and run_id = v_run
			and session_id = (select session_id from public.qorpera_company_rooms where id = pg_temp.base_thread(
				'92400000-0000-4000-8000-000000000031'))), 'Bob''s routine runs in his thread');
	perform pg_temp.base_start(v_run);
	perform set_config('qorpera_test.stall_run', v_run::text, true);
end
$$;
select pg_temp.base_claims('service_role');

-- Bob's activity row, as the owner reads it.
create function pg_temp.st_bob() returns jsonb language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_row jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	select entry into v_row
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020')) entry
	where entry ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000031';
	perform set_config('request.jwt.claims', v_claims, true);
	return v_row;
end
$$;
create function pg_temp.st_run() returns uuid language sql as $$
	select current_setting('qorpera_test.stall_run')::uuid
$$;
-- Moves the job's start and the run's assignments back.
create function pg_temp.st_age(p_minutes integer) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set started_at = started_at - make_interval(mins => p_minutes)
	where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.st_run());
	update public.qorpera_runner_assignments set created_at = created_at - make_interval(mins => p_minutes)
	where run_id = pg_temp.st_run();
	set local session_replication_role = origin;
end
$$;
-- One observation of the run, ingested p_minutes ago.
create function pg_temp.st_observe(p_operation text, p_phase text, p_minutes integer) returns void language sql as $$
	insert into public.qorpera_runtime_observations(run_id, attempt_id, phase, assignment_id, operation, observed_at,
		ingested_at, observation)
	values (pg_temp.st_run(), extensions.gen_random_uuid(), p_phase,
		(select client_lease_id from public.qorpera_runner_jobs
			where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.st_run())),
		p_operation, clock_timestamp() - make_interval(mins => p_minutes),
		clock_timestamp() - make_interval(mins => p_minutes), '{}')
$$;
-- The run's open notices, per member.
create function pg_temp.st_open_notices() returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(notice.user_id, notice.n), '{}') from (
		select user_id, count(*) as n from public.qorpera_member_notifications
		where kind = 'run_no_progress' and acknowledged_at is null and subject ->> 'runId' = pg_temp.st_run()::text
		group by user_id) notice
$$;
-- Deletes the run's observations ingested in the last minute (all of them with p_all), as if never made.
create function pg_temp.st_forget(p_all boolean default false) returns void language plpgsql as $$
begin
	delete from public.qorpera_runtime_observations
	where run_id = pg_temp.st_run() and (p_all or ingested_at > clock_timestamp() - interval '1 minute');
end
$$;
create function pg_temp.st_sweep() returns jsonb language sql as $$
	select public.qorpera_notify_runs_without_progress()
$$;

-- A. A run that just started is working, with no stall, and nobody is told.
do $$
declare v_row jsonb := pg_temp.st_bob(); v_sweep jsonb;
begin
	if v_row ->> 'run_id' is distinct from pg_temp.st_run()::text or v_row ->> 'activity' <> 'working'
		or v_row ? 'no_progress_since' then
		raise exception 'A: a fresh run is working without a stall: %', v_row; end if;
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'opened' <> '0' or pg_temp.st_open_notices() <> '{}' then
		raise exception 'A: nobody is told of a fresh run: %', v_sweep; end if;
end
$$;

-- B. Twenty minutes with nothing: the row names the stall from the run's last progress (its assignment, here), and a
-- routine run's stall is told to the owner and the admin, once each.
select pg_temp.st_age(20);
do $$
declare v_row jsonb := pg_temp.st_bob(); v_since timestamptz; v_sweep jsonb; v_notice public.qorpera_member_notifications%rowtype;
begin
	select greatest(job.started_at, (select max(assignment.created_at) from public.qorpera_runner_assignments as assignment
		where assignment.run_id = pg_temp.st_run())) into v_since
	from public.qorpera_runner_jobs as job where job.id = (select job_id from public.qorpera_execution_runs where id = pg_temp.st_run());
	if v_row ->> 'activity' <> 'working' or (v_row ->> 'no_progress_since')::timestamptz is distinct from v_since
		or v_row -> 'no_progress_minutes' <> '15' or public.qorpera_run_stall_minutes() <> 15 then
		raise exception 'B: the stall is named from the last progress %, with its minutes: %', v_since, v_row; end if;
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'opened' <> '2' or pg_temp.st_open_notices()
		<> '{"92400000-0000-4000-8000-000000000001": 1, "92400000-0000-4000-8000-000000000004": 1}' then
		raise exception 'B: the owner and the admin are told, and only they: % %', v_sweep, pg_temp.st_open_notices(); end if;
	select * into strict v_notice from public.qorpera_member_notifications
	where kind = 'run_no_progress' and subject ->> 'runId' = pg_temp.st_run()::text
		and user_id = '92400000-0000-4000-8000-000000000001';
	if v_notice.subject ->> 'schema' <> 'qorpera.member-notification.run-no-progress/v1'
		or v_notice.subject ->> 'staffAgentId' <> '92400000-0000-4000-8000-000000000031'
		or (v_notice.subject ->> 'since')::timestamptz <> v_since or v_notice.subject ->> 'sessionId' is null
		or v_notice.subject -> 'minutes' <> '15' or v_notice.dedupe_key <> pg_temp.st_run()::text then
		raise exception 'B: the notice names the run, the agent, the thread and the stall: %', v_notice.subject; end if;
	-- Again: the same run is not told twice.
	if pg_temp.st_sweep() ->> 'opened' <> '0' or pg_temp.st_open_notices()
		<> '{"92400000-0000-4000-8000-000000000001": 1, "92400000-0000-4000-8000-000000000004": 1}' then
		raise exception 'B: a stall is told once'; end if;
end
$$;

-- C. A dismissed notice is not sent again for the same run.
do $$
declare v_notice public.qorpera_member_notifications;
begin
	for v_notice in select * from public.qorpera_member_notifications
		where kind = 'run_no_progress' and subject ->> 'runId' = pg_temp.st_run()::text and acknowledged_at is null loop
		perform pg_temp.base_claims('authenticated', v_notice.user_id);
		perform public.qorpera_acknowledge_member_notification(v_notice.id);
	end loop;
	perform pg_temp.base_claims('service_role');
	if pg_temp.st_sweep() ->> 'opened' <> '0' or pg_temp.st_open_notices() <> '{}' then
		raise exception 'C: a dismissed stall stays dismissed'; end if;
end
$$;

-- D. Progress: a model request's result fence now ends the stall. When the run stalls again (its newest progress 16
-- minutes old), the row names the new stall, but the run's member was told once already: no second notice.
select pg_temp.st_observe('native_result_fence', 'finish', 0);
do $$
begin
	if pg_temp.st_bob() ? 'no_progress_since' then raise exception 'D: fresh progress is no stall'; end if;
	if pg_temp.st_sweep() ->> 'opened' <> '0' then raise exception 'D: nobody is told while the run progresses'; end if;
	perform pg_temp.st_forget();
	perform pg_temp.st_observe('native_result_fence', 'finish', 16);
	if (pg_temp.st_bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.st_run()) then
		raise exception 'D: the stall runs from the newest observation: %', pg_temp.st_bob(); end if;
	if pg_temp.st_sweep() ->> 'opened' <> '0' or pg_temp.st_open_notices() <> '{}' then
		raise exception 'D: one notice per member and run'; end if;
end
$$;

-- E. A tool call open for 18 minutes is a stall like any other, from its start (20260930051000: no built-in tool keeps a
-- call open that long); once it finished (17 minutes ago), from its finish. A model request in flight stalls too.
do $$
begin
	perform pg_temp.st_forget(true);
	perform pg_temp.st_observe('computer_shell', 'start', 18);
	if (pg_temp.st_bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.st_run()) then
		raise exception 'E: a tool call open for 18 minutes is a stall from its start: %', pg_temp.st_bob(); end if;
	perform pg_temp.st_observe('computer_shell', 'finish', 17);
	if (pg_temp.st_bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.st_run()) then
		raise exception 'E: a finished tool call is the last progress: %', pg_temp.st_bob(); end if;
	perform pg_temp.st_observe('model_request', 'start', 16);
	if not pg_temp.st_bob() ? 'no_progress_since' then
		raise exception 'E: a model request in flight stalls: %', pg_temp.st_bob(); end if;
	-- "Writing" pulses come every 5 s on the runner's own timer until the reply ends: a reply hung for good keeps
	-- pulsing, so pulses are no progress. The stall still runs from the model request's start.
	perform pg_temp.st_observe('message_composition', 'start', 0);
	perform pg_temp.st_observe('message_composition', 'finish', 0);
	perform pg_temp.st_observe('message_composition', 'start', 0);
	if (pg_temp.st_bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.st_run() and operation <> 'message_composition') then
		raise exception 'E: writing pulses are no progress: %', pg_temp.st_bob(); end if;
	-- A tool call open behind later pulses stalls from its start.
	perform pg_temp.st_forget(true);
	perform pg_temp.st_observe('computer_shell', 'start', 18);
	perform pg_temp.st_observe('message_composition', 'start', 0);
	if (pg_temp.st_bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.st_run() and operation <> 'message_composition') then
		raise exception 'E: a tool call open behind pulses stalls from its start: %', pg_temp.st_bob(); end if;
end
$$;

-- F. Who is told: a member-private run's member; a turn's sender in a company thread; a post's poster in the agent's
-- thread; otherwise owners and admins (a contributor and a viewer were not told of a routine run, B). A notice closes
-- itself once the run progresses.
do $$
declare v_sweep jsonb;
begin
	perform pg_temp.st_forget(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set audience_kind = 'member_private',
		audience_user_id = '92400000-0000-4000-8000-000000000002' where id = pg_temp.st_run();
	set local session_replication_role = origin;
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'opened' <> '1' or pg_temp.st_open_notices() <> '{"92400000-0000-4000-8000-000000000002": 1}' then
		raise exception 'F: a member-private run tells its member only: % %', v_sweep, pg_temp.st_open_notices(); end if;
	perform pg_temp.st_observe('company_read', 'finish', 0);
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'closed' <> '1' or v_sweep ->> 'opened' <> '0' or pg_temp.st_open_notices() <> '{}' then
		raise exception 'F: the notice closes itself on progress: %', v_sweep; end if;
	perform pg_temp.st_forget(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set audience_kind = 'company', audience_user_id = null,
		source_kind = 'session_turn', input_ids = array[extensions.gen_random_uuid()],
		created_by_user_id = '92400000-0000-4000-8000-000000000003' where id = pg_temp.st_run();
	set local session_replication_role = origin;
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'opened' <> '1' or pg_temp.st_open_notices() <> '{"92400000-0000-4000-8000-000000000003": 1}' then
		raise exception 'F: a turn tells its sender (a viewer here): % %', v_sweep, pg_temp.st_open_notices(); end if;
	-- A member's post in the agent's own thread is a room delivery: it tells the member who posted, not the owner and
	-- admin (a member who has not been told of this run yet).
	perform pg_temp.st_observe('company_read', 'finish', 0);
	if pg_temp.st_sweep() ->> 'closed' <> '1' then raise exception 'F: progress closes the sender''s notice'; end if;
	perform pg_temp.st_forget(true);
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set source_kind = 'room_delivery', input_ids = '{}',
		created_by_user_id = '92400000-0000-4000-8000-000000000006' where id = pg_temp.st_run();
	set local session_replication_role = origin;
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'opened' <> '1' or pg_temp.st_open_notices() <> '{"92400000-0000-4000-8000-000000000006": 1}' then
		raise exception 'F: a post in the agent''s thread tells its poster: % %', v_sweep, pg_temp.st_open_notices(); end if;
end
$$;

-- G. A run that ended closes its notice; the job's row was never changed by the sweep.
do $$
declare v_job public.qorpera_runner_jobs%rowtype; v_sweep jsonb;
begin
	select * into strict v_job from public.qorpera_runner_jobs
	where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.st_run());
	perform pg_temp.st_sweep();
	if (select row(job.*)::text from public.qorpera_runner_jobs as job where job.id = v_job.id) <> row(v_job.*)::text then
		raise exception 'G: the sweep changes no job'; end if;
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = 'cancelled', cancelled_at = clock_timestamp(),
		cancelled_by_user_id = '92400000-0000-4000-8000-000000000001', lease_token_sha256 = null, lease_expires_at = null
	where id = v_job.id;
	set local session_replication_role = origin;
	v_sweep := pg_temp.st_sweep();
	if v_sweep ->> 'closed' <> '1' or pg_temp.st_open_notices() <> '{}' then
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
