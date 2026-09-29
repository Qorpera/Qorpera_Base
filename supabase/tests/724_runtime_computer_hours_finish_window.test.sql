-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Computer hours, build step 6c part 3b (20260929270000_runtime_computer_hours_finish_window): running
-- work may finish for one hour at zero. Then the orchestrator heartbeat ends the company's leased
-- jobs (failed, no retry) and fails its queued ones, with "Out of computer hours
-- [code=COMPUTER_HOURS_EXHAUSTED]"; an in-house worker so ended reports "out of computer hours".
-- Within the hour, once the company is no longer at zero, or when another company is past its
-- hour, nothing is ended. A started native turn ends for review, its reason kept; the worker is
-- not cancelled, and its parent's revival waits for hours like other new work.

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.parent_binding', current_setting('qorpera_test.wake_binding'), true);
create function pg_temp.job(p_run uuid) returns public.qorpera_runner_jobs language sql as $$
	select job from public.qorpera_runner_jobs job where job.run_id = p_run
$$;
create function pg_temp.heartbeat() returns jsonb language sql as $$
	select public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns('30000000-0000-4000-8000-000000000092')
$$;
create function pg_temp.backdate(p_minutes integer) returns void language sql as $$
	update public.qorpera_computer_hour_zero_state set ran_out_at = clock_timestamp() - make_interval(mins => p_minutes)
	where profile_id = '30000000-0000-4000-8000-000000000010'
$$;

select pg_temp.wake_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_computer_hour_finish_window_over(uuid,timestamp with time zone)',
		'public.qorpera_computer_hour_wake_ended_out_of_hours(uuid)']) function_name;

-- The parent acknowledges its wake, keeps a todo and dispatches an in-house worker; the parent's own
-- run ends and the worker's child run starts (leased).
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb, 'progress', 'hours-ack');
select public.qorpera_manage_agent_todo(current_setting('qorpera_test.parent_binding')::jsonb,
	'{"action":"upsert","operationKey":"hours-todo","todoKey":"hours-scan","title":"Scan","detail":"Scan the market."}');
select public.qorpera_manage_agent_worker(current_setting('qorpera_test.parent_binding')::jsonb,
	'{"action":"dispatch","operationKey":"hours-d1","todoKey":"hours-scan","workerKey":"scan","title":"Scan",
		"goal":"Scan the market.","definitionOfDone":"A list.","access":"read"}');
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb, 'final', 'hours-final');
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid;
select public.qorpera_materialize_wake_execution_runs(8);
select set_config('qorpera_test.child', pg_temp.wake_start(null)::text, true);
select set_config('qorpera_test.child_run', current_setting('qorpera_test.child')::jsonb ->> 'runId', true);
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.child_run')::uuid)).status = 'leased'
	and exists (select 1 from public.qorpera_runtime_workers worker join public.qorpera_wake_occurrences wake
		on wake.id = worker.occurrence_id where worker.worker_key = 'scan'
		and wake.run_id = current_setting('qorpera_test.child_run')::uuid),
	'The worker''s child run is running');
-- A running run that has not started its native turn: another agent's routine wake, leased.
select set_config('qorpera_test.routine', pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
	'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}')::text, true);
select set_config('qorpera_test.routine_wake',
	pg_temp.wake_schedule(current_setting('qorpera_test.routine')::jsonb, 'hours-leased')::text, true);
select public.qorpera_materialize_wake_execution_runs(8);
select set_config('qorpera_test.leased_run', (select run_id::text from public.qorpera_wake_occurrences
	where id = current_setting('qorpera_test.routine_wake')::uuid), true);
select pg_temp.wake_start(current_setting('qorpera_test.leased_run')::uuid);
-- A queued run made before the company ran out: a third agent's routine wake.
select set_config('qorpera_test.routine2', pg_temp.wake_routine('30000000-0000-4000-8000-000000000032',
	'{"id":"tick","kind":"schedule","intervalMinutes":5,"replyPolicy":"optional"}')::text, true);
select set_config('qorpera_test.routine2_wake',
	pg_temp.wake_schedule(current_setting('qorpera_test.routine2')::jsonb, 'hours-queued')::text, true);
select public.qorpera_materialize_wake_execution_runs(8);
select set_config('qorpera_test.queued_run', (select run_id::text from public.qorpera_wake_occurrences
	where id = current_setting('qorpera_test.routine2_wake')::uuid), true);
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.queued_run')::uuid)).status = 'queued'
	and (pg_temp.job(current_setting('qorpera_test.leased_run')::uuid)).status = 'leased', 'A queued run and a running one');

-- The worker's child had started its native turn, as most running work has (only the start event
-- matters to the path that ends it).
insert into public.qorpera_execution_run_events (run_id, event_type, payload)
values (current_setting('qorpera_test.child_run')::uuid, 'runner_started',
	'{"schema":"qorpera.native-company-execution-start/v1"}');

-- Another company, with another founder, which will be past its hour at zero.
insert into auth.users(id,email) values ('72400000-0000-4000-8000-000000000002','other-founder@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('72400000-0000-4000-8000-000000000020','Other company','72400000-0000-4000-8000-000000000002');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('72400000-0000-4000-8000-000000000020','72400000-0000-4000-8000-000000000002','other-founder@example.test','Other','owner');

-- Live, the company used more than its free hours, the zero rule on: it ran out now.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('30000000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000),
	('72400000-0000-4000-8000-000000000020', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.wake_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '2', 'Both at zero');
update public.qorpera_computer_hour_zero_state set ran_out_at = clock_timestamp() - interval '2 hours'
where profile_id = '72400000-0000-4000-8000-000000000020';

-- 1. Within the hour, running work finishes: nothing is ended.
select pg_temp.backdate(59);
select pg_temp.heartbeat();
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.child_run')::uuid)).status = 'leased'
	and (pg_temp.job(current_setting('qorpera_test.leased_run')::uuid)).status = 'leased'
	and (pg_temp.job(current_setting('qorpera_test.queued_run')::uuid)).status = 'queued', 'Within the hour: left alone');

-- 2. Past the hour but no longer at zero (the record not yet swept), while another company is past
-- its hour at zero: nothing of this company is ended.
select pg_temp.backdate(61);
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('30000000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.heartbeat();
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.child_run')::uuid)).status = 'leased'
	and (pg_temp.job(current_setting('qorpera_test.leased_run')::uuid)).status = 'leased'
	and (pg_temp.job(current_setting('qorpera_test.queued_run')::uuid)).status = 'queued', 'No longer at zero: left alone');
delete from public.qorpera_account_entitlements where user_id = '30000000-0000-4000-8000-000000000001';

-- 3. Past the hour and still at zero: both end, failed, with the reason, and nothing is retried.
select pg_temp.heartbeat();
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.child_run')::uuid)).status = 'failed'
	and (pg_temp.job(current_setting('qorpera_test.child_run')::uuid)).last_error like 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]%',
	'The running job ended out of computer hours: ' || coalesce((pg_temp.job(current_setting('qorpera_test.child_run')::uuid)).last_error, 'no error'));
select pg_temp.wake_assert((select status = 'requires_review' from public.qorpera_wake_occurrences
	where run_id = current_setting('qorpera_test.child_run')::uuid), 'A started native turn ends for review');
-- A run that had not started its turn ends failed too, and is not put back in the queue.
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.leased_run')::uuid)).status = 'failed'
	and (pg_temp.job(current_setting('qorpera_test.leased_run')::uuid)).last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]'
	and (select status = 'failed' from public.qorpera_wake_occurrences
		where run_id = current_setting('qorpera_test.leased_run')::uuid),
	'A running job that had not started ends failed, not retried: ' || (select row(job.status, job.last_error, wake.status)::text
		from public.qorpera_runner_jobs job join public.qorpera_wake_occurrences wake on wake.run_id = job.run_id
		where job.run_id = current_setting('qorpera_test.leased_run')::uuid));
select pg_temp.wake_assert((pg_temp.job(current_setting('qorpera_test.queued_run')::uuid)).status = 'failed'
	and (pg_temp.job(current_setting('qorpera_test.queued_run')::uuid)).last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]',
	'The queued job failed out of computer hours');
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_runner_jobs job
	where job.run_id in (current_setting('qorpera_test.child_run')::uuid, current_setting('qorpera_test.queued_run')::uuid,
		current_setting('qorpera_test.leased_run')::uuid)
		and job.status in ('queued', 'leased')), 'No retry');

-- 4. The worker, not cancelled, tells its parent why; the parent's revival waits for hours.
select public.qorpera_materialize_wake_execution_runs(8);
select public.qorpera_materialize_wake_execution_runs(8);
select pg_temp.wake_assert((select worker.state = 'failed' and worker.result ->> 'reason' = 'out_of_computer_hours'
		and worker.result ->> 'summary' = 'The background work was stopped because the company is out of computer hours.'
	from public.qorpera_runtime_workers worker where worker.worker_key = 'scan'),
	'The worker reports out of computer hours: ' || (select worker.result::text from public.qorpera_runtime_workers worker
		where worker.worker_key = 'scan'));
select pg_temp.wake_assert(exists (select 1 from public.qorpera_wake_occurrences wake
	where wake.source_kind = 'worker-completion'
		and wake.parent_run_id = (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid
		and wake.status = 'queued' and wake.blocked_reason = 'Waiting for computer hours'),
	'The parent''s revival waits for computer hours: ' || coalesce((select string_agg(wake.status || '/' || coalesce(wake.blocked_reason, '-'), ', ')
		from public.qorpera_wake_occurrences wake where wake.source_kind = 'worker-completion'), 'none'));
rollback;
