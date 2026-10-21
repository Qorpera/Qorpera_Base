-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Who may stop an in-house worker's run (qorpera_get_worker_run_control and qorpera_cancel_worker_run, 20260928459180), on the
-- folder-v2 runtime base (ported from snapshot-v1 in the legacy sweep). Alice's run dispatches a worker through the folder
-- worker commit, the folder worker drain starts it, and the worker's run is leased. The owner may stop it. A viewer, even
-- one whose work dispatched it, and someone outside the company (the owner of another company) may not: they are refused
-- with the answer a run that is not a worker's gets, and the run goes on. The worker's own run may not dispatch a worker
-- of its own (contract 13: only the agent's own run manages its workers).

select pg_temp.base_claims('service_role');
-- The outsider is the owner of another company.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('83200000-0000-4000-8000-000000000010', 'Another company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('83200000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000005', 'base-outsider@example.test', 'Outsider', 'owner');

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
-- The member read and the member Stop, as p_user.
create function pg_temp.ws_control(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v_result := public.qorpera_get_worker_run_control(pg_temp.ws_run());
	perform pg_temp.base_claims('service_role');
	return v_result;
end
$$;
create function pg_temp.ws_stop(p_user uuid) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v_result := public.qorpera_cancel_worker_run(pg_temp.ws_run());
	perform pg_temp.base_claims('service_role');
	return v_result;
end
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
	'todo', E'---\nid: 83200000-0000-4000-8000-0000000000d1\ntitle: Scan\nstatus: open\n---\nScan the market.\n',
	'{"kind":"todo","id":"83200000-0000-4000-8000-0000000000d1","title":"Scan","status":"open","requestedBy":null,"detail":"Scan the market."}'))) \g /dev/null
do $$
declare v_result jsonb := pg_temp.ws_dispatch(current_setting('qorpera_test.base_binding')::jsonb, 'stop-dispatch',
	'QorperaOS/agents/alice/todos/stop-scan/scan', '83200000-0000-4000-8000-0000000000e1', true);
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

-- 1. The owner may stop the leased worker run; a viewer reads it but may not.
do $$
begin
	perform pg_temp.base_assert(pg_temp.ws_control('92400000-0000-4000-8000-000000000001')
			= jsonb_build_object('run_id', pg_temp.ws_run(), 'status', 'leased', 'can_cancel', true),
		'The owner may stop the leased worker run: ' || pg_temp.ws_control('92400000-0000-4000-8000-000000000001')::text);
	perform pg_temp.base_assert(pg_temp.ws_control('92400000-0000-4000-8000-000000000003') ->> 'can_cancel' = 'false',
		'A viewer may not stop it');
end
$$;

-- 2. The viewer's Stop, and the outsider's read and Stop, are refused with the answer a run that is not a worker's gets;
--    the run goes on.
select pg_temp.base_error($q$select pg_temp.ws_stop('92400000-0000-4000-8000-000000000003')$q$, '42501', 'worker run is unavailable');
select pg_temp.base_error($q$select pg_temp.ws_control('92400000-0000-4000-8000-000000000005')$q$, '42501', 'worker run is unavailable');
select pg_temp.base_error($q$select pg_temp.ws_stop('92400000-0000-4000-8000-000000000005')$q$, '42501', 'worker run is unavailable');
select pg_temp.base_assert((pg_temp.ws_job()).status = 'leased' and (pg_temp.ws_job()).cancelled_by_user_id is null,
	'Refused stops leave the run working');

-- 3. A viewer whose work dispatched it still may not stop it (a viewer stops nothing; probed, then undone).
savepoint ws_viewer_dispatcher;
set local session_replication_role = replica;
update public.qorpera_runner_jobs set created_by_user_id = '92400000-0000-4000-8000-000000000003' where id = (pg_temp.ws_job()).id;
update public.qorpera_execution_runs set created_by_user_id = '92400000-0000-4000-8000-000000000003' where id = pg_temp.ws_run();
set local session_replication_role = origin;
select pg_temp.base_assert(pg_temp.ws_control('92400000-0000-4000-8000-000000000003') ->> 'can_cancel' = 'false',
	'A viewer who dispatched it may not stop it');
select pg_temp.base_error($q$select pg_temp.ws_stop('92400000-0000-4000-8000-000000000003')$q$, '42501', 'worker run is unavailable');
rollback to ws_viewer_dispatcher;

-- 4. The worker's own run cannot dispatch a worker of its own (moved here from 385 §4, which refused it on the old core).
do $$
declare v_result jsonb := pg_temp.ws_dispatch(pg_temp.ws_child(), 'stop-nested', 'QorperaOS/agents/alice/todos/stop-scan/helper',
	'83200000-0000-4000-8000-0000000000e2', false);
begin
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused' and v_result -> 'units' -> 0 ->> 'reason' = 'structured_rule'
		and v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = 'only the agent''s own run manages its workers',
		'A worker''s run dispatching a worker is refused: ' || v_result::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_runtime_workers
		where profile_id = '92400000-0000-4000-8000-000000000010' and worker_key = 'helper'), 'No worker of the worker''s');
end
$$;

-- 5. The owner stops it: the job is cancelled and records who.
do $$
declare v_result jsonb := pg_temp.ws_stop('92400000-0000-4000-8000-000000000001'); v_job public.qorpera_runner_jobs := pg_temp.ws_job();
begin
	perform pg_temp.base_assert(v_result = jsonb_build_object('run_id', pg_temp.ws_run(), 'status', 'cancelled', 'can_cancel', false)
		and v_job.status = 'cancelled' and v_job.cancelled_by_user_id = '92400000-0000-4000-8000-000000000001',
		'The owner''s Stop cancels the job and records who: ' || v_result::text);
end
$$;

rollback;
