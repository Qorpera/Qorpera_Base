-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Computer hours, build step 6c part 3b (20260928259270_runtime_computer_hours_finish_window), on the folder-v2 runtime base
-- (ported from snapshot-v1 in the legacy sweep): running work may finish for one hour at zero. Then the orchestrator
-- heartbeat ends the company's leased jobs (failed, no retry) and fails its queued ones, with "Out of computer hours
-- [code=COMPUTER_HOURS_EXHAUSTED]"; an in-house worker so ended reports "out of computer hours" through the folder worker
-- drain. Within the hour, once the company is no longer at zero, or when another company is past its hour, nothing is
-- ended. A started native turn ends for review, its reason kept; the worker is not cancelled, and its parent's revival
-- waits for hours like other new work.

select pg_temp.base_claims('service_role');
create function pg_temp.fw_job(p_run uuid) returns public.qorpera_runner_jobs language sql as $$
	select job from public.qorpera_runner_jobs job where job.run_id = p_run
$$;
create function pg_temp.fw_heartbeat() returns jsonb language sql as $$
	select public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns('92400000-0000-4000-8000-000000000092')
$$;
create function pg_temp.fw_backdate(p_minutes integer) returns void language sql as $$
	update public.qorpera_computer_hour_zero_state set ran_out_at = clock_timestamp() - make_interval(mins => p_minutes)
	where profile_id = '92400000-0000-4000-8000-000000000010'
$$;
-- One pass of the folder worker drain for the company, as its own transaction would start it.
create function pg_temp.fw_drain() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	perform set_config('qorpera.folder_wake_admission', '', true);
	return public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
end
$$;
create function pg_temp.fw_worker() returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where profile_id = '92400000-0000-4000-8000-000000000010' and worker_key = 'scan'
$$;

select pg_temp.base_assert(not has_function_privilege(role_name, function_name, 'EXECUTE'),
	function_name || ' is not callable by ' || role_name)
from unnest(array['anon', 'authenticated', 'service_role']) role_name,
	unnest(array['public.qorpera_computer_hour_finish_window_over(uuid,timestamp with time zone)',
		'public.qorpera_computer_hour_wake_ended_out_of_hours(uuid)']) function_name;

-- Alice's run (the parent) acknowledges its wake. The owner gives Alice a todo, and the run dispatches an in-house worker on
-- it: the todo's folder and the worker's folder with its brief, staged by the run itself, under the run's allowed review.
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'hours-ack') \g /dev/null
select pg_temp.base_commit(pg_temp.base_owner(), 'hours-todo', jsonb_build_array(pg_temp.base_write('agents/alice/todos/hours-scan.md',
	'todo', E'---\nid: 72400000-0000-4000-8000-0000000000d1\ntitle: Scan\nstatus: open\n---\nScan the market.\n',
	'{"kind":"todo","id":"72400000-0000-4000-8000-0000000000d1","title":"Scan","status":"open","requestedBy":null,"detail":"Scan the market."}'))) \g /dev/null
do $$
declare
	b jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_actor jsonb := jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId');
	v_folder constant text := 'agents/alice/todos/hours-scan/scan';
	v_brief jsonb := jsonb_build_object('kind', 'worker-brief', 'id', '72400000-0000-4000-8000-0000000000e1', 'title', 'Scan',
		'species', 'in-house', 'access', 'read', 'revival', 'each',
		'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUps', 0,
		'followedUpAt', null, 'goal', 'Scan the market.', 'doneWhen', 'A list.', 'context', null, 'sources', '[]'::jsonb,
		'followUp', null) || public.qorpera_company_state_worker_standing('in-house', 'read', 'each');
	v_seal jsonb; v_units jsonb; v_review uuid; v_result jsonb; v_worker public.qorpera_runtime_workers;
begin
	v_seal := pg_temp.base_seal(v_actor, pg_temp.base_manifest(v_brief::text));
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'The run stages the brief: ' || v_seal::text);
	v_units := jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'agents/alice/todos/hours-scan'),
		jsonb_build_object('op', 'new_folder', 'path', v_folder,
			'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file', 'file', v_seal -> 'file')),
			'structured', jsonb_build_array(jsonb_build_object('path', v_folder || '/brief.md', 'kind', 'worker-brief',
				'text', v_brief::text, 'parse', v_brief, 'parserVersion', 1))));
	-- The run's change set with an allowed review, as its own allow of the manage_worker call leaves it.
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('92400000-0000-4000-8000-000000000020', (b ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(v_units),
		array[1, 2], 'allow')
	returning id into v_review;
	v_result := public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', v_actor, 'hours-dispatch', v_units,
		jsonb_build_object('action', 'dispatch', 'folder', v_folder, 'title', 'Scan', 'goal', 'Scan the market.',
			'doneWhen', 'A list.', 'context', null, 'sources', '[]'::jsonb, 'access', 'read', 'revival', 'each'), v_review);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u ->> 'outcome' <> 'saved'),
		'The dispatch saves: ' || v_result::text);
	v_worker := pg_temp.fw_worker();
	perform pg_temp.base_assert(v_worker.state = 'active' and v_worker.species = 'in-house' and v_worker.occurrence_id is null
		and v_worker.steering_run_id = (b ->> 'runId')::uuid, 'The worker waits for the drain: ' || to_jsonb(v_worker)::text);
end
$$;
-- The parent reports and its own run ends.
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'final', 'hours-final') \g /dev/null
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;

-- The folder worker drain starts the worker (its dispatch wake), the materializer makes its run, and the run starts (leased).
do $$
declare v_drain jsonb := pg_temp.fw_drain(); v_pass jsonb; v_child jsonb;
begin
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'started')::integer = 1, 'The drain starts the worker: ' || v_drain::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'The worker''s run: ' || v_pass::text);
	v_child := pg_temp.base_start(null);
	perform set_config('qorpera_test.child_run', v_child ->> 'runId', true);
	perform pg_temp.base_assert((pg_temp.fw_job((v_child ->> 'runId')::uuid)).status = 'leased'
		and exists (select 1 from public.qorpera_wake_occurrences wake where wake.id = (pg_temp.fw_worker()).occurrence_id
			and wake.source_kind = 'worker-dispatch' and wake.run_id = (v_child ->> 'runId')::uuid),
		'The worker''s child run is running');
end
$$;
-- A running run that has not started its native turn: Bob's, answering the owner's post, leased.
do $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031', 'Look at the numbers.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'Bob''s run: ' || v_pass::text);
	perform set_config('qorpera_test.leased_run', pg_temp.base_start(null) ->> 'runId', true);
	perform pg_temp.base_assert(current_setting('qorpera_test.leased_run') = v_pass -> 'run_ids' ->> 0, 'Bob''s run starts');
end
$$;
-- A queued run made before the company ran out: Carol's, answering another post.
do $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032', 'Write it up.');
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'Carol''s run: ' || v_pass::text);
	perform set_config('qorpera_test.queued_run', v_pass -> 'run_ids' ->> 0, true);
end
$$;
select pg_temp.base_assert((pg_temp.fw_job(current_setting('qorpera_test.queued_run')::uuid)).status = 'queued'
	and (pg_temp.fw_job(current_setting('qorpera_test.leased_run')::uuid)).status = 'leased', 'A queued run and a running one');

-- The worker's child had started its native turn, as most running work has (only the start event
-- matters to the path that ends it).
insert into public.qorpera_execution_run_events (run_id, event_type, payload)
values (current_setting('qorpera_test.child_run')::uuid, 'runner_started',
	'{"schema":"qorpera.native-company-execution-start/v1"}');

-- Another folder-v2 company, with another founder, which will be past its hour at zero.
insert into auth.users(id,email) values ('72400000-0000-4000-8000-000000000002','other-founder@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('72400000-0000-4000-8000-000000000020','Other company','72400000-0000-4000-8000-000000000002');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('72400000-0000-4000-8000-000000000020','72400000-0000-4000-8000-000000000002','other-founder@example.test','Other','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('72400000-0000-4000-8000-000000000021','72400000-0000-4000-8000-000000000020','Environment',1,
	'72400000-0000-4000-8000-000000000002');
select pg_temp.base_claims('service_role');
select public.qorpera_folder_enable('72400000-0000-4000-8000-000000000021') \g /dev/null

-- Live, the company used more than its free hours, the zero rule on: it ran out now.
update public.qorpera_computer_hour_billing set live_since = clock_timestamp() - interval '1 second';
insert into public.qorpera_computer_hour_usage (profile_id, metered_at, run_seconds, standard_seconds)
values ('92400000-0000-4000-8000-000000000010', clock_timestamp(), 20000, 20000),
	('72400000-0000-4000-8000-000000000020', clock_timestamp(), 20000, 20000);
update public.qorpera_computer_hour_billing set zero_rule_since = clock_timestamp() - interval '1 second';
select pg_temp.base_assert(public.qorpera_computer_hour_zero_sweep(clock_timestamp()) ->> 'ranOut' = '2', 'Both at zero');
update public.qorpera_computer_hour_zero_state set ran_out_at = clock_timestamp() - interval '2 hours'
where profile_id = '72400000-0000-4000-8000-000000000020';

-- 1. Within the hour, running work finishes: nothing is ended.
select pg_temp.fw_backdate(59);
select pg_temp.fw_heartbeat() \g /dev/null
select pg_temp.base_assert((pg_temp.fw_job(current_setting('qorpera_test.child_run')::uuid)).status = 'leased'
	and (pg_temp.fw_job(current_setting('qorpera_test.leased_run')::uuid)).status = 'leased'
	and (pg_temp.fw_job(current_setting('qorpera_test.queued_run')::uuid)).status = 'queued', 'Within the hour: left alone');

-- 2. Past the hour but no longer at zero (the record not yet swept), while another company is past
-- its hour at zero: nothing of this company is ended.
select pg_temp.fw_backdate(61);
insert into public.qorpera_account_entitlements (user_id, plan_key, billing_mode, feature_set, storage_allocation, operator_reference, reason)
values ('92400000-0000-4000-8000-000000000001', 'internal', 'complimentary', 'all', 'unlimited', 'test', 'Company41 staff');
select pg_temp.fw_heartbeat() \g /dev/null
select pg_temp.base_assert((pg_temp.fw_job(current_setting('qorpera_test.child_run')::uuid)).status = 'leased'
	and (pg_temp.fw_job(current_setting('qorpera_test.leased_run')::uuid)).status = 'leased'
	and (pg_temp.fw_job(current_setting('qorpera_test.queued_run')::uuid)).status = 'queued', 'No longer at zero: left alone');
delete from public.qorpera_account_entitlements where user_id = '92400000-0000-4000-8000-000000000001';

-- 3. Past the hour and still at zero: both end, failed, with the reason, and nothing is retried.
select pg_temp.fw_heartbeat() \g /dev/null
select pg_temp.base_assert((pg_temp.fw_job(current_setting('qorpera_test.child_run')::uuid)).status = 'failed'
	and (pg_temp.fw_job(current_setting('qorpera_test.child_run')::uuid)).last_error like 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]%',
	'The running job ended out of computer hours: ' || coalesce((pg_temp.fw_job(current_setting('qorpera_test.child_run')::uuid)).last_error, 'no error'));
select pg_temp.base_assert((select status = 'requires_review' from public.qorpera_wake_occurrences
	where run_id = current_setting('qorpera_test.child_run')::uuid), 'A started native turn ends for review');
-- A run that had not started its turn ends failed too, and is not put back in the queue.
select pg_temp.base_assert((pg_temp.fw_job(current_setting('qorpera_test.leased_run')::uuid)).status = 'failed'
	and (pg_temp.fw_job(current_setting('qorpera_test.leased_run')::uuid)).last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]'
	and (select status = 'failed' from public.qorpera_wake_occurrences
		where run_id = current_setting('qorpera_test.leased_run')::uuid),
	'A running job that had not started ends failed, not retried: ' || (select row(job.status, job.last_error, wake.status)::text
		from public.qorpera_runner_jobs job join public.qorpera_wake_occurrences wake on wake.run_id = job.run_id
		where job.run_id = current_setting('qorpera_test.leased_run')::uuid));
select pg_temp.base_assert((pg_temp.fw_job(current_setting('qorpera_test.queued_run')::uuid)).status = 'failed'
	and (pg_temp.fw_job(current_setting('qorpera_test.queued_run')::uuid)).last_error = 'Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]',
	'The queued job failed out of computer hours');
select pg_temp.base_assert(not exists (select 1 from public.qorpera_runner_jobs job
	where job.run_id in (current_setting('qorpera_test.child_run')::uuid, current_setting('qorpera_test.queued_run')::uuid,
		current_setting('qorpera_test.leased_run')::uuid)
		and job.status in ('queued', 'leased')), 'No retry');

-- 4. The worker, not cancelled, tells its parent why (the folder worker drain); the parent's revival waits for hours: the
-- company is not due and its materializer answers at_zero, so the revival stays queued with no run.
do $$
declare v_drain jsonb := pg_temp.fw_drain(); v_worker public.qorpera_runtime_workers := pg_temp.fw_worker(); v_pass jsonb;
	v_revival public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'failed')::integer = 1
		and v_worker.state = 'failed' and v_worker.result ->> 'reason' = 'out_of_computer_hours'
		and v_worker.result ->> 'summary' = 'The background work was stopped because the company is out of computer hours.',
		'The worker reports out of computer hours: ' || v_drain::text || ' ' || coalesce(v_worker.result::text, 'no result'));
	v_drain := pg_temp.fw_drain();
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'revivals')::integer = 1,
		'The parent is revived with the report: ' || v_drain::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass = '{"state":"at_zero"}', 'At zero the revival starts nothing: ' || v_pass::text);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(public.qorpera_folder_materialize_due(null, 500) -> 'items') i
		where i ->> 'profile_id' = '92400000-0000-4000-8000-000000000010'), 'At zero the company is not due');
	select * into v_revival from public.qorpera_wake_occurrences wake
	where wake.source_kind = 'worker-completion'
		and wake.parent_run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.base_assert(v_revival.status = 'queued' and v_revival.run_id is null,
		'The parent''s revival waits for computer hours: ' || coalesce(to_jsonb(v_revival)::text, 'none'));
end
$$;
rollback;
