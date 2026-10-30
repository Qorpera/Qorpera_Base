-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A failure no longer stands for its agent once the agent has newer work (stale failure card, 29 October 2026;
-- 20260930542000). The agent activity list keeps one current row per agent and ranks an undismissed failure above work,
-- so a member who wrote to an agent after its run failed saw the old failure as the agent's state while the new run did
-- its work. Now the agent's current row is its newer run, waiting, then working, and the failure is listed after it,
-- apart, with 'superseded': true; once that run is done no failure comes back as the agent's state. Unchanged: a failure
-- with no newer run of the same agent's (another agent's run does not count), one whose own Company File proposal is
-- open, and dismissing, which still drops a failure out, one at a time. The runs are real: the owner's posts in Bob's
-- thread, each made a run by the folder materializer, one started on a real runner with a native lease. A conversation
-- runs one run at a time (20260930538000), so each post comes once the run before it has ended.

-- The owner's post in an agent's thread, made a run by one materializer pass; answers the queued run.
create function pg_temp.sf_post(p_staff uuid, p_text text) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', p_staff, p_text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1 and (select run.source_kind = 'room_delivery'
		and run.staff_agent_id = p_staff and run.session_id = (select session_id from public.qorpera_company_rooms
			where id = pg_temp.base_thread(p_staff)) and job.status = 'queued'
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = (v_pass -> 'run_ids' ->> 0)::uuid), 'Fixture: the post is a queued run in the thread: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
-- The run's job fails, as a lost attempt's would. Called in a statement of its own, so a run the next statement makes is
-- newer than the failure.
create function pg_temp.sf_fail(p_run uuid) returns void language plpgsql as $$
begin
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(),
		last_error = 'Runner lease expired before durable completion', lease_token_sha256 = null, lease_expires_at = null
	where run_id = p_run and status in ('queued', 'leased');
	if not found then raise exception 'Fixture: run % is not live', p_run; end if;
end $$;
-- A leased run reports and completes (as 465's oc_done).
create function pg_temp.sf_done(p_binding jsonb) returns void language plpgsql as $$
begin
	perform pg_temp.base_public_send(p_binding, 'progress');
	perform pg_temp.base_public_send(p_binding, 'final');
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = clock_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null
	where run_id = (p_binding ->> 'runId')::uuid and status = 'leased';
	if not found then raise exception 'Fixture: run % is not leased', p_binding ->> 'runId'; end if;
end $$;
-- The owner dismisses a failed run, as the web's Dismiss does.
create function pg_temp.sf_acknowledge(p_run text) returns void language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_resolve_failed_execution_run(p_run::uuid, 'acknowledge');
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform pg_temp.base_assert(v_result ->> 'resolved' = 'true', 'Fixture: the owner dismisses the run: ' || v_result::text);
end $$;
-- What a member (the viewer) sees of Bob: his rows in the list's order, without their times, phase and agent.
create function pg_temp.sf_bob() returns jsonb language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_rows jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
	set local role authenticated;
	select coalesce(jsonb_agg(list.entry - 'updated_at' - 'phase' - 'staff_agent_id' order by list.n), '[]'::jsonb) into v_rows
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020'))
		with ordinality as list(entry, n)
	where list.entry ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000031';
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_rows;
end $$;
create function pg_temp.sf_row(p_run text, p_status text, p_activity text) returns jsonb language sql as $$
	select jsonb_build_object('run_id', p_run, 'source_kind', 'room_delivery', 'job_status', p_status, 'activity', p_activity)
$$;
-- A failure listed apart, as the agent's earlier one.
create function pg_temp.sf_earlier(p_run text) returns jsonb language sql as $$
	select pg_temp.sf_row(p_run, 'failed', 'needs_attention') || '{"superseded":true}'::jsonb
$$;
select pg_temp.base_claims('service_role');

-- 1. The list is still the members' read only, and keeps the stop's ranking the activation guards check for.
select pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not exists (select 1 from pg_proc, aclexplode(proacl) acl
		where pg_proc.oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure and acl.grantee = 0),
	'The activity list keeps its grants');
select pg_temp.base_assert(position('when job.cancelled_by_user_id is not null then 0' in
	pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0,
	'The activity list keeps the stop''s ranking');

-- 2. A failure with no newer run of Bob's still stands for him, as before: his one row, without the key. Another agent's
--    newer run does not change that.
select set_config('qorpera_test.sf_first', pg_temp.sf_post('92400000-0000-4000-8000-000000000031', 'Look at the numbers.')::text,
	true) \g /dev/null
select pg_temp.sf_fail(current_setting('qorpera_test.sf_first')::uuid);
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(pg_temp.sf_row(current_setting('qorpera_test.sf_first'), 'failed',
	'needs_attention')), 'A failure with no newer run stands for the agent, as before: ' || pg_temp.sf_bob()::text);
savepoint sf_other_agent;
select pg_temp.sf_post('92400000-0000-4000-8000-000000000032', 'Check the invoices.') \g /dev/null
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(pg_temp.sf_row(current_setting('qorpera_test.sf_first'), 'failed',
	'needs_attention')), 'Another agent''s newer run leaves the failure standing: ' || pg_temp.sf_bob()::text);
rollback to savepoint sf_other_agent;

-- 3. The reported case: the owner writes to Bob again. While the new run is queued, then leased, it is Bob's current row,
--    waiting, then working, and the failure is listed after it, apart.
select set_config('qorpera_test.sf_newer', pg_temp.sf_post('92400000-0000-4000-8000-000000000031', 'Once more, please.')::text,
	true) \g /dev/null
select pg_temp.base_assert((select newer.created_at > failed.finished_at
	from public.qorpera_execution_runs newer, public.qorpera_runner_jobs failed
	where newer.id = current_setting('qorpera_test.sf_newer')::uuid and failed.run_id = current_setting('qorpera_test.sf_first')::uuid),
	'Fixture: the new run was made after the failure ended');
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(
		pg_temp.sf_row(current_setting('qorpera_test.sf_newer'), 'queued', 'waiting'),
		pg_temp.sf_earlier(current_setting('qorpera_test.sf_first'))),
	'A queued new run is the agent''s current row, and the failure is listed apart: ' || pg_temp.sf_bob()::text);
select set_config('qorpera_test.sf_newer_binding', pg_temp.base_start(current_setting('qorpera_test.sf_newer')::uuid)::text, true)
\g /dev/null
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(
		pg_temp.sf_row(current_setting('qorpera_test.sf_newer'), 'leased', 'working'),
		pg_temp.sf_earlier(current_setting('qorpera_test.sf_first'))),
	'A leased new run is the agent''s work, and the failure is listed apart: ' || pg_temp.sf_bob()::text);

-- 4. A failure whose own Company File proposal is open still asks for that decision first, above the new run's work, and
--    is not listed apart. (Proposals are snapshot-v1's; the row is written as the old runtime left one.)
savepoint sf_proposal;
set local session_replication_role = replica;
insert into public.qorpera_company_proposals (profile_id, environment_id, client_proposal_id, proposal_snapshot_id,
	execution_kind, execution_id, execution_claimant_id, trail_end_sequence, reason, title, created_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
	extensions.gen_random_uuid(), 'run', current_setting('qorpera_test.sf_first')::uuid, extensions.gen_random_uuid(), 0,
	'recovery', 'The numbers', '92400000-0000-4000-8000-000000000001');
set local session_replication_role = origin;
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(pg_temp.sf_row(current_setting('qorpera_test.sf_first'), 'failed',
	'needs_attention')), 'A failure with an open proposal still ranks first: ' || pg_temp.sf_bob()::text);
rollback to savepoint sf_proposal;

-- 5. The new run is done: no failure comes back as Bob's state; the earlier one is still listed, apart.
select pg_temp.sf_done(current_setting('qorpera_test.sf_newer_binding')::jsonb);
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(pg_temp.sf_earlier(current_setting('qorpera_test.sf_first'))),
	'Once the new run is done, only the earlier failure is listed, apart: ' || pg_temp.sf_bob()::text);

-- 6. The next run fails too, with nothing newer: it stands for Bob, and the earlier failure stays listed apart.
select set_config('qorpera_test.sf_second', pg_temp.sf_post('92400000-0000-4000-8000-000000000031', 'And the receipts.')::text,
	true) \g /dev/null
select pg_temp.sf_fail(current_setting('qorpera_test.sf_second')::uuid);
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(
		pg_temp.sf_row(current_setting('qorpera_test.sf_second'), 'failed', 'needs_attention'),
		pg_temp.sf_earlier(current_setting('qorpera_test.sf_first'))),
	'The newest failure stands for the agent, the earlier one apart: ' || pg_temp.sf_bob()::text);

-- 7. Dismissed, each drops out as before: the newest failure first, then the earlier one, and Bob is idle.
select pg_temp.sf_acknowledge(current_setting('qorpera_test.sf_second'));
select pg_temp.base_assert(pg_temp.sf_bob() = jsonb_build_array(pg_temp.sf_earlier(current_setting('qorpera_test.sf_first'))),
	'With the newest failure dismissed, the earlier one is still listed apart: ' || pg_temp.sf_bob()::text);
select pg_temp.sf_acknowledge(current_setting('qorpera_test.sf_first'));
select pg_temp.base_assert(pg_temp.sf_bob() = '[]'::jsonb, 'With both dismissed, Bob is idle: ' || pg_temp.sf_bob()::text);

rollback;
