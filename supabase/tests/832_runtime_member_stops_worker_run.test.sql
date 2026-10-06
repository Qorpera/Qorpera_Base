-- @fixture 385_runtime_workers_todos.test.sql until "-- 6. One durable report"
-- Members stop a worker's run (session-buildup audit gap 4b, migration 20260930002800). The fixture's worker
-- 'prices' is leased; its parent's run has ended. Who may stop it is the thread run's rule: owners, admins and the
-- member whose work dispatched it (the job's creator, a contributor). The stop is qorpera_cancel_runner_job's, and the
-- parent then hears "A member stopped the background work." A stalled worker run is told to its dispatching member too.

select pg_temp.path_claims('service_role');
insert into auth.users(id, email) values ('30000000-0000-4000-8000-000000000099', 'outsider@example.test');
create function pg_temp.child_run() returns uuid language sql as $$
	select run_id from public.qorpera_wake_occurrences where id = (pg_temp.worker_row('prices')).occurrence_id
$$;
create function pg_temp.child_job() returns public.qorpera_runner_jobs language sql as $$
	select job from public.qorpera_runner_jobs as job where job.run_id = pg_temp.child_run()
$$;
-- The member read, as p_user.
create function pg_temp.control(p_user uuid, p_run uuid default null) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	v_result := public.qorpera_get_worker_run_control(coalesce(p_run, pg_temp.child_run()));
	perform pg_temp.path_claims('service_role');
	return v_result;
end
$$;
-- The member Stop, as p_user.
create function pg_temp.stop(p_user uuid, p_run uuid default null) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	v_result := public.qorpera_cancel_worker_run(coalesce(p_run, pg_temp.child_run()));
	perform pg_temp.path_claims('service_role');
	return v_result;
end
$$;
-- Moves the worker run's start and assignments back, and makes p_creator its dispatching member (job and run).
create function pg_temp.stall_child(p_creator uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set started_at = started_at - interval '20 minutes', created_by_user_id = p_creator
	where id = (pg_temp.child_job()).id;
	update public.qorpera_runner_assignments set created_at = created_at - interval '20 minutes'
	where run_id = pg_temp.child_run();
	update public.qorpera_execution_runs set created_by_user_id = p_creator where id = pg_temp.child_run();
	set local session_replication_role = origin;
end
$$;

-- A. The read: every member who reads the company sees the worker run's state; only an owner or admin, or the
-- dispatching member, may stop it. Nobody reads a run that is not a worker's, and an outsider reads nothing.
do $$
declare v_owner jsonb := pg_temp.control('30000000-0000-4000-8000-000000000001');
begin
	perform pg_temp.wake_assert(v_owner = jsonb_build_object('run_id', pg_temp.child_run(), 'status', 'leased', 'can_cancel', true),
		'A: the owner may stop the leased worker run');
	perform pg_temp.wake_assert(pg_temp.control('30000000-0000-4000-8000-000000000002') ->> 'can_cancel' = 'false'
		and pg_temp.control('30000000-0000-4000-8000-000000000003') ->> 'can_cancel' = 'false',
		'A: a contributor who did not dispatch it, and a viewer, read it but may not stop it');
	perform pg_temp.wake_assert((pg_temp.child_job()).created_by_user_id = '30000000-0000-4000-8000-000000000001',
		'A: the fixture''s worker was dispatched by the owner''s work');
end
$$;
select pg_temp.wake_error($q$select pg_temp.control('30000000-0000-4000-8000-000000000099')$q$, '42501', 'worker run is unavailable');
select pg_temp.wake_error($q$select pg_temp.control('30000000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid)$q$, '42501', 'worker run is unavailable');
select pg_temp.wake_error($q$select public.qorpera_get_worker_run_control(pg_temp.child_run())$q$, '42501', 'worker run is unavailable');

-- B. A contributor who did not dispatch it, a viewer and an outsider cannot stop it, and are refused before anything
-- is locked with the same answer as for a run that is not a worker's; the run goes on.
select pg_temp.wake_error($q$select pg_temp.stop('30000000-0000-4000-8000-000000000002')$q$, '42501',
	'worker run is unavailable');
select pg_temp.wake_error($q$select pg_temp.stop('30000000-0000-4000-8000-000000000003')$q$, '42501',
	'worker run is unavailable');
select pg_temp.wake_error($q$select pg_temp.stop('30000000-0000-4000-8000-000000000099')$q$, '42501',
	'worker run is unavailable');
select pg_temp.wake_error($q$select pg_temp.stop('30000000-0000-4000-8000-000000000001', extensions.gen_random_uuid())$q$,
	'42501', 'worker run is unavailable');
select pg_temp.wake_error($q$select pg_temp.stop('30000000-0000-4000-8000-000000000001',
	(current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid)$q$, '42501', 'worker run is unavailable');
do $$
begin
	perform pg_temp.wake_assert((pg_temp.child_job()).status = 'leased', 'B: refused stops leave the run working');
end
$$;

-- C. The member whose work dispatched the worker (a contributor here) may stop it; and its stall reaches them as well
-- as the owners and admins, as a worker's (probed, then undone).
savepoint dispatching_member;
do $$
declare v_result jsonb; v_sweep jsonb;
begin
	perform pg_temp.stall_child('30000000-0000-4000-8000-000000000002');
	v_sweep := public.qorpera_notify_runs_without_progress();
	perform pg_temp.wake_assert((select array_agg(user_id::text order by user_id) from public.qorpera_member_notifications
			where kind = 'run_no_progress' and subject ->> 'runId' = pg_temp.child_run()::text)
			= array['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002']
		and (select bool_and(subject -> 'worker' = 'true' and subject -> 'sessionId' = 'null')
			from public.qorpera_member_notifications where kind = 'run_no_progress'),
		'C: a stalled worker run tells the owner and its dispatching contributor (not the viewer), as a worker''s');
	perform pg_temp.wake_assert(pg_temp.control('30000000-0000-4000-8000-000000000002') ->> 'can_cancel' = 'true',
		'C: the dispatching contributor may stop it');
	v_result := pg_temp.stop('30000000-0000-4000-8000-000000000002');
	perform pg_temp.wake_assert(v_result ->> 'status' = 'cancelled' and v_result ->> 'can_cancel' = 'false'
		and (pg_temp.child_job()).cancelled_by_user_id = '30000000-0000-4000-8000-000000000002',
		'C: the dispatching contributor stopped it, recorded as theirs');
end
$$;
rollback to dispatching_member;

-- C2. A viewer whose work dispatched it still may not stop it (a viewer stops nothing); a run that already ended
-- answers its state to a Stop, with nothing to cancel (probed, then undone).
savepoint viewer_and_ended;
do $$
declare v_result jsonb;
begin
	perform pg_temp.stall_child('30000000-0000-4000-8000-000000000003');
	perform pg_temp.wake_assert(pg_temp.control('30000000-0000-4000-8000-000000000003') ->> 'can_cancel' = 'false',
		'C2: a viewer who dispatched it may not stop it');
	perform pg_temp.wake_error($q$select pg_temp.stop('30000000-0000-4000-8000-000000000003')$q$, '42501',
		'worker run is unavailable');
	perform pg_temp.finish_job(pg_temp.child_run());
	v_result := pg_temp.stop('30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_assert(v_result = jsonb_build_object('run_id', pg_temp.child_run(), 'status', 'completed', 'can_cancel', false)
		and (pg_temp.child_job()).cancelled_by_user_id is null,
		'C2: a Stop of a run that already ended answers its state and cancels nothing: ' || v_result::text);
end
$$;
rollback to viewer_and_ended;

-- D. The owner stops it: the thread run's path, recorded; a second Stop answers the same.
do $$
declare v_result jsonb := pg_temp.stop('30000000-0000-4000-8000-000000000001'); v_job public.qorpera_runner_jobs := pg_temp.child_job();
begin
	perform pg_temp.wake_assert(v_result = jsonb_build_object('run_id', pg_temp.child_run(), 'status', 'cancelled', 'can_cancel', false)
		and v_job.status = 'cancelled' and v_job.cancelled_by_user_id = '30000000-0000-4000-8000-000000000001'
		and v_job.lease_token_sha256 is null,
		'D: the owner''s Stop cancels the job and records who');
	perform pg_temp.wake_assert(pg_temp.stop('30000000-0000-4000-8000-000000000001') = v_result, 'D: a second Stop answers the same');
end
$$;

-- E. The parent hears that a member stopped the work, not that it could not start.
do $$
declare v_worker public.qorpera_runtime_workers; v_wake public.qorpera_wake_occurrences;
	v_parent uuid := (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid;
begin
	perform public.qorpera_drain_worker_wakes(32);
	v_worker := pg_temp.worker_row('prices');
	perform pg_temp.wake_assert(v_worker.state = 'failed' and v_worker.result ->> 'reason' = 'member_stopped'
		and v_worker.result ->> 'summary' = 'A member stopped the background work.' and v_worker.completion_state = 'waiting',
		'E: the worker ends as stopped by a member: ' || coalesce(v_worker.result::text, 'none'));
	perform public.qorpera_drain_worker_wakes(32);
	select * into strict v_wake from public.qorpera_wake_occurrences
	where source_kind = 'worker-completion' and parent_run_id = v_parent;
	perform pg_temp.wake_assert(v_wake.payload::text like '%A member stopped the background work.%',
		'E: the parent is revived with it: ' || v_wake.payload::text);
end
$$;

-- F. The new functions: the read and the Stop are the members'; the rest is postgres-only.
do $$
begin
	perform pg_temp.wake_assert(has_function_privilege('authenticated', 'public.qorpera_get_worker_run_control(uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_cancel_worker_run(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_get_worker_run_control(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_cancel_worker_run(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_cancel_worker_run(uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_worker_run_member_stopped(uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_is_member_worker_run(public.qorpera_execution_runs)', 'execute'),
		'F: privileges');
end
$$;

rollback;
