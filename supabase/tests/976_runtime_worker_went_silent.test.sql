-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A worker the platform ended for going silent (20260930618000) tells its parent so: the report's reason is went_silent
-- and its summary says no member asked for this. A member's Stop of the same run stays member_stopped, which the parent
-- may take as the member's wish. Seen live on 7 November 2026: a Stop made the Co-Founder pause everything and wait.
-- 832's base: Alice's run dispatches a worker, the drain starts it, and its run is leased.

select pg_temp.base_claims('service_role');

create function pg_temp.ws_child() returns jsonb language sql as $$
	select current_setting('qorpera_test.ws_child')::jsonb
$$;
create function pg_temp.ws_run() returns uuid language sql as $$
	select (pg_temp.ws_child() ->> 'runId')::uuid
$$;
create function pg_temp.ws_job() returns public.qorpera_runner_jobs language sql as $$
	select job from public.qorpera_runner_jobs job where job.run_id = pg_temp.ws_run()
$$;
create function pg_temp.ws_worker() returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where profile_id = '92400000-0000-4000-8000-000000000010' and worker_key = 'scan'
$$;
-- A dispatch by a run (its actor from a binding) of a worker at p_folder: the brief staged by the run, the run's allowed
-- review of exactly these units, then the folder worker commit.
create function pg_temp.ws_dispatch(p_binding jsonb, p_key text, p_folder text, p_id uuid, p_mkdir boolean) returns jsonb
language plpgsql as $$
declare
	v_actor jsonb := jsonb_build_object('kind', 'run', 'runId', p_binding ->> 'runId', 'jobId', p_binding ->> 'jobId',
		'runnerId', p_binding ->> 'runnerId', 'assignmentId', p_binding ->> 'assignmentId');
	v_brief jsonb := jsonb_build_object('kind', 'worker-brief', 'id', p_id, 'title', 'Scan', 'species', 'in-house', 'access', 'write',
		'revival', 'each', 'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUps', 0,
		'followedUpAt', null, 'goal', 'Scan the market.', 'doneWhen', 'A list.', 'context', null, 'sources', '[]'::jsonb,
		'followUp', null) || public.qorpera_company_state_worker_standing('in-house', 'write', 'each');
	v_seal jsonb; v_units jsonb; v_review uuid;
begin
	v_seal := pg_temp.base_seal(v_actor, pg_temp.base_manifest(v_brief::text));
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'The run stages the brief: ' || v_seal::text);
	v_units := case when p_mkdir then jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/alice/todos/stop-scan'))
		else '[]'::jsonb end
		|| jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', p_folder,
			'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file', 'file', v_seal -> 'file')),
			'structured', jsonb_build_array(jsonb_build_object('path', p_folder || '/brief.md', 'kind', 'worker-brief',
				'text', v_brief::text, 'parse', v_brief, 'parserVersion', 1))));
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('92400000-0000-4000-8000-000000000020', (p_binding ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(v_units),
		array(select generate_series(1, jsonb_array_length(v_units))), 'allow')
	returning id into v_review;
	return public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', v_actor, p_key, v_units,
		jsonb_build_object('action', 'dispatch', 'folder', p_folder, 'title', 'Scan', 'goal', 'Scan the market.',
			'doneWhen', 'A list.', 'context', null, 'sources', '[]'::jsonb, 'access', 'write', 'revival', 'each'), v_review);
end
$$;

-- Alice's run (the parent) acknowledges its wake; the owner gives Alice a todo, and the run dispatches an in-house worker
-- on it. The parent reports and its own run ends; the drain starts the worker, the materializer makes its run, and the run
-- starts (leased).
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'stop-ack') \g /dev/null
select pg_temp.base_commit(pg_temp.base_owner(), 'stop-todo', jsonb_build_array(pg_temp.base_write('QorperaOS/agents/alice/todos/stop-scan.md',
	'todo', E'---\nid: 97600000-0000-4000-8000-0000000000d1\ntitle: Scan\nstatus: open\n---\nScan the market.\n',
	'{"kind":"todo","id":"97600000-0000-4000-8000-0000000000d1","title":"Scan","status":"open","requestedBy":null,"detail":"Scan the market."}'))) \g /dev/null
do $$
declare v_result jsonb := pg_temp.ws_dispatch(current_setting('qorpera_test.base_binding')::jsonb, 'stop-dispatch',
	'QorperaOS/agents/alice/todos/stop-scan/scan', '97600000-0000-4000-8000-0000000000e1', true);
begin
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u ->> 'outcome' <> 'saved'),
		'The dispatch saves: ' || v_result::text);
end
$$;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'final', 'stop-final') \g /dev/null
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
do $$
declare v_drain jsonb; v_pass jsonb;
begin
	perform set_config('qorpera.folder_wake_admission', '', true);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'started')::integer = 1, 'The drain starts the worker: ' || v_drain::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'The worker''s run: ' || v_pass::text);
	perform set_config('qorpera_test.ws_child', pg_temp.base_start(null)::text, true);
	perform pg_temp.base_assert((pg_temp.ws_job()).status = 'leased'
		and exists (select 1 from public.qorpera_wake_occurrences wake where wake.id = (pg_temp.ws_worker()).occurrence_id
			and wake.source_kind = 'worker-dispatch' and wake.run_id = pg_temp.ws_run()),
		'The worker''s run is running');
end
$$;

-- 1. Silent for 40 minutes: the pass ends it, by nobody.
do $$
declare v_pass jsonb;
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set started_at = started_at - interval '40 minutes' where run_id = pg_temp.ws_run();
	update public.qorpera_runner_assignments set created_at = created_at - interval '40 minutes' where run_id = pg_temp.ws_run();
	update public.qorpera_native_context_views set created_at = created_at - interval '40 minutes' where run_id = pg_temp.ws_run();
	update public.qorpera_runtime_observations set ingested_at = ingested_at - interval '40 minutes' where run_id = pg_temp.ws_run();
	set local session_replication_role = origin;
	v_pass := public.qorpera_stop_runs_without_progress();
	perform pg_temp.base_assert((v_pass ->> 'stopped')::integer = 1, 'The pass stops the silent worker: ' || v_pass::text);
	perform pg_temp.base_assert((pg_temp.ws_job()).status = 'cancelled' and (pg_temp.ws_job()).cancelled_by_user_id is null,
		'Stopped by nobody: ' || (pg_temp.ws_job()).status);
end
$$;

-- 2. The drain ends the worker with the difference, and its parent's wake carries it.
do $$
declare v_drain jsonb; w public.qorpera_runtime_workers; v_payload jsonb;
begin
	perform set_config('qorpera.folder_wake_admission', '', true);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	w := pg_temp.ws_worker();
	perform pg_temp.base_assert(w.state = 'failed' and w.result ->> 'reason' = 'went_silent'
			and w.result ->> 'summary' like 'This worker went silent and the platform ended it; no member asked for this.%',
		'The worker says it went silent: ' || w.result::text);
	perform set_config('qorpera.folder_wake_admission', '', true);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	select wake.payload into v_payload from public.qorpera_wake_occurrences as wake
	where wake.profile_id = '92400000-0000-4000-8000-000000000010' and wake.source_kind = 'worker-completion'
	order by wake.created_at desc limit 1;
	perform pg_temp.base_assert(v_payload -> 'completions' -> 0 ->> 'summary' = w.result ->> 'summary',
		'The parent reads it: ' || coalesce(v_payload::text, 'no wake; ') || v_drain::text);
	perform pg_temp.base_assert(v_payload::text not like '%A member stopped%', 'The parent is not told a member stopped it');
end
$$;

-- 3. The same end by a member's Stop is the member's.
do $$
declare w public.qorpera_runtime_workers := pg_temp.ws_worker(); v_occurrence uuid := w.occurrence_id;
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set cancelled_by_user_id = '92400000-0000-4000-8000-000000000001' where run_id = pg_temp.ws_run();
	update public.qorpera_runtime_workers set state = 'active', result = null, reported_at = null where id = w.id;
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_worker_run_member_stopped(v_occurrence) and not public.qorpera_worker_run_went_silent(v_occurrence),
		'A member''s Stop is no silence');
	perform public.qorpera_folder_worker_ended(pg_temp.ws_worker(), v_occurrence, 'cancelled');
	w := pg_temp.ws_worker();
	perform pg_temp.base_assert(w.result ->> 'reason' = 'member_stopped' and w.result ->> 'summary' = 'A member stopped the background work.',
		'A member''s Stop says so: ' || w.result::text);
end
$$;
