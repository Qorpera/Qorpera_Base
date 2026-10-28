-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- WB-001 G1 b (20260930539000): in Agent notebooks mode a started run that is cut off resumes in the same task from its
-- own receipts. Test 924's run of Alice's is in Agent notebooks mode and keeps no run log. It starts, acknowledges,
-- completes two steps (one with the result the runtime stores, one with another result) and begins a third; then its
-- runner's lease runs out and the reconcile ends the attempt. The job is queued again with the open step's outcome
-- unknown. The next attempt, on the same run and job, reads the run's receipts: the completed steps (with the stored
-- result) and the unknown one. It begins no step, a replay neither, until it has recorded that it was told of the
-- unknown one. Then a completed step replays its stored result and does not run again, the unknown one never runs
-- again, other inputs under a key are refused, and a new step runs. A run in Agent tree mode with no log, a run out of
-- attempts, a refused run, a run at its usage limit, a narrow run and a coding session's turn keep today's path. The
-- cut-off of a run with a log is 991.

-- An attempt's native start, as the runner records it (as 991 does).
create function pg_temp.rr_begin(p_binding jsonb) returns jsonb language plpgsql as $$
declare v_identity jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	return public.qorpera_begin_native_company_execution_v2(p_binding,
		(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
			join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
		v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
		'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
		repeat('c', 64), 10);
end
$$;
-- A step: a tool operation that needs no company revision, with its inputs' hash.
create function pg_temp.rr_step(p_binding jsonb, p_receipt uuid, p_key text, p_input text default repeat('a', 64))
returns jsonb language sql as $$
	select public.qorpera_begin_native_tool_operation(p_binding, p_receipt, p_key, p_input, repeat('b', 64), false)
$$;
create function pg_temp.rr_step_done(p_binding jsonb, p_receipt uuid, p_result jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_complete_run_receipt(p_binding, p_receipt, repeat('a', 64), p_result, null)
$$;
-- The result the runtime stores for a completed tool call (cloud-native-tool-operations.ts).
create function pg_temp.rr_result(p_text text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.cloud-tool-operation-result/v1', 'inputSha256', repeat('a', 64),
		'content', jsonb_build_object('kind', 'text', 'value', p_text))
$$;
-- The attempt's runner lease runs out, and the orchestrator's reconcile ends the attempt.
create function pg_temp.rr_expire(p_job uuid) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = p_job;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
end
$$;
create function pg_temp.rr_fail(p_binding jsonb, p_error text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, false);
end
$$;
create function pg_temp.rr_events(p_run uuid, p_type text) returns bigint language sql as $$
	select count(*) from public.qorpera_execution_run_events where run_id = p_run and event_type = p_type
$$;
create function pg_temp.rr_read(p_binding jsonb) returns jsonb language sql as $$
	select public.qorpera_memory_run_resume_receipts(p_binding)
$$;
create function pg_temp.rr_record(p_binding jsonb, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_memory_run_resume_record(p_binding, p_request)
$$;
create function pg_temp.rr_run() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
-- A cut-off that keeps today's path: the job fails, and the run is not resumed.
create function pg_temp.rr_today(p_message text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs
		where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid)
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 0 and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 0,
		p_message);
end
$$;

-- 1. The receipts read is the service role's only; which run resumes from its receipts is nobody's to ask. The read is
--    a native host call through the run's binding. The run is in Agent notebooks mode with no log, and the gate is on.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_run_resumes_from_receipts(uuid)', 'EXECUTE')
			and has_function_privilege(v_role, 'public.qorpera_memory_run_resume_receipts(jsonb)', 'EXECUTE') = (v_role = 'service_role'),
			'the receipts read is open to ' || v_role);
	end loop;
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_native_host_calls
		where name = 'qorpera_memory_run_resume_receipts' and scope = 'binding'), 'the read is a binding host call');
	perform pg_temp.base_assert((select memory_mode is distinct from 'tree' from public.qorpera_execution_runs where id = pg_temp.rr_run())
		and not exists (select 1 from public.qorpera_memory_run_logs where run_id = pg_temp.rr_run()), 'the run has no log');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(pg_temp.rr_run()), 'a notebook run with no log resumes');
end
$$;

-- 2. The run starts and acknowledges. Its original attempt is not a resume: the read is null and nothing fences its steps.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.rr_begin(v_binding);
	perform pg_temp.base_public_send(v_binding, 'progress', 'rr-ack');
	perform pg_temp.base_assert(pg_temp.rr_read(v_binding) is null, 'the original attempt reads nothing');
end
$$;
-- Each step in its own statement, so the receipts' times order them.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_assert(pg_temp.rr_step(v_binding, v_receipt, 'g1b-step-a') ->> 'state' = 'executing', 'step A begins');
	perform pg_temp.base_assert(pg_temp.rr_step_done(v_binding, v_receipt, pg_temp.rr_result('The note says: ship on Friday.'))
		->> 'state' = 'completed', 'step A completes');
	perform set_config('qorpera_test.rr_a', v_receipt::text, true);
end
$$;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.rr_step(v_binding, v_receipt, 'g1b-step-o');
	perform pg_temp.base_assert(pg_temp.rr_step_done(v_binding, v_receipt, '{"ok":true}') ->> 'state' = 'completed',
		'step O completes with another result');
	perform set_config('qorpera_test.rr_o', v_receipt::text, true);
end
$$;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_assert(pg_temp.rr_step(v_binding, v_receipt, 'g1b-step-b') ->> 'state' = 'executing', 'step B begins');
	perform set_config('qorpera_test.rr_b', v_receipt::text, true);
end
$$;

-- 3. Today's path, for each run the receipts do not resume.
-- A run in Agent tree mode with no log: it fails, its open step is ambiguous, and it waits for review.
savepoint rr_tree;
set local session_replication_role = replica;
update public.qorpera_execution_runs set memory_mode = 'tree' where id = pg_temp.rr_run();
set local session_replication_role = origin;
do $$
begin
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(pg_temp.rr_run()) is false, 'a tree run with no log does not resume');
	perform pg_temp.rr_expire((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid);
	perform pg_temp.rr_today('a tree run with no log fails when cut off');
	perform pg_temp.base_assert((select status = 'ambiguous' from public.qorpera_run_operation_receipts
		where id = current_setting('qorpera_test.rr_b')::uuid), 'its open step is ambiguous');
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') > 0, 'it waits for review');
end
$$;
rollback to savepoint rr_tree;

-- A run out of attempts (8).
savepoint rr_attempts;
set local session_replication_role = replica;
update public.qorpera_runner_jobs set attempt_count = 8
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
set local session_replication_role = origin;
select pg_temp.rr_expire((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid) \g /dev/null
select pg_temp.rr_today('a run out of attempts does not resume') \g /dev/null
rollback to savepoint rr_attempts;

-- A refused run: the runner reports a failure that is not retryable.
savepoint rr_refused;
select pg_temp.rr_fail(current_setting('qorpera_test.base_binding')::jsonb, 'Native provider bridge request failed (422)') \g /dev/null
select pg_temp.rr_today('a refused run does not resume') \g /dev/null
rollback to savepoint rr_refused;

-- A run at its login's usage limit ends as before: no pause, and its lease running out after the limit neither.
savepoint rr_limit;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(v_binding, 'usage_limit', clock_timestamp() + interval '30 hours');
	perform pg_temp.rr_fail(v_binding, 'Native provider bridge request failed (429) [usage limit]');
	perform pg_temp.rr_today('a run at its usage limit fails');
end
$$;
rollback to savepoint rr_limit;
savepoint rr_limit_cut_off;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(v_binding, 'usage_limit', clock_timestamp() + interval '30 hours');
	perform pg_temp.rr_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.rr_today('a run cut off after its usage limit fails');
end
$$;
rollback to savepoint rr_limit_cut_off;

-- A run its machine made narrow.
savepoint rr_narrow;
create or replace function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$ select true $$;
select pg_temp.base_assert(public.qorpera_run_resumes_from_log(pg_temp.rr_run()) is false, 'a narrow run does not resume') \g /dev/null
select pg_temp.rr_expire((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid) \g /dev/null
select pg_temp.rr_today('a narrow run fails when cut off') \g /dev/null
rollback to savepoint rr_narrow;

-- A coding session's turn (its worker's dispatch wake of the coding species) never reads a resume.
savepoint rr_coding;
set local session_replication_role = replica;
update public.qorpera_wake_occurrences set source_kind = 'worker-dispatch', payload = payload || '{"species":"coding"}'
where run_id = pg_temp.rr_run();
set local session_replication_role = origin;
select pg_temp.base_assert(public.qorpera_run_resumes_from_log(pg_temp.rr_run()) is false, 'a coding turn does not resume') \g /dev/null
rollback to savepoint rr_coding;

-- 4. The cut-off: the job is queued again, the attempt counts, the completed steps stay completed, the open step's
--    outcome is unknown, one run_cut_off event names the attempt, and nothing waits for review.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_job public.qorpera_runner_jobs;
begin
	perform pg_temp.rr_expire((v_binding ->> 'jobId')::uuid);
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid;
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.attempt_count = 1 and v_job.run_id = pg_temp.rr_run(),
		'the cut-off run is queued again: ' || to_jsonb(v_job)::text);
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 1
		and (select payload ->> 'assignmentId' = v_binding ->> 'assignmentId' from public.qorpera_execution_run_events
			where run_id = pg_temp.rr_run() and event_type = 'run_cut_off'), 'one run_cut_off event names the attempt');
	perform pg_temp.base_assert((select array_agg(status order by created_at) from public.qorpera_run_operation_receipts
		where run_id = pg_temp.rr_run()) = array['completed', 'completed', 'outcome_unknown'], 'the open step''s outcome is unknown');
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') = 0
		and not exists (select 1 from public.qorpera_wake_occurrences where run_id = pg_temp.rr_run() and status = 'requires_review'),
		'a resumed run does not wait for review');
end
$$;

-- 5. The old attempt is fenced: it can neither begin a step nor read the receipts.
create function pg_temp.rr_old_fenced() returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select pg_temp.rr_step(%L, %L, %L)', v_binding, extensions.gen_random_uuid(), 'g1b-old'),
		'42501', 'Run is unavailable');
	perform pg_temp.base_error(format('select pg_temp.rr_read(%L)', v_binding), '42501');
end
$$;
select pg_temp.rr_old_fenced() \g /dev/null

-- The next attempt, in the same run and job, on the same login, through the real contracts; it starts.
do $$
declare v_next jsonb := pg_temp.base_start(pg_temp.rr_run()); v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_assert(v_next ->> 'runId' = v_binding ->> 'runId' and v_next ->> 'jobId' = v_binding ->> 'jobId'
		and v_next ->> 'assignmentId' <> v_binding ->> 'assignmentId', 'the next attempt is the same run and job: ' || v_next::text);
	perform pg_temp.base_assert(pg_temp.rr_begin(v_next) ->> 'leaseId' = v_next ->> 'leaseId', 'the next attempt starts');
	perform set_config('qorpera_test.rr_next', v_next::text, true);
end
$$;
select pg_temp.rr_old_fenced() \g /dev/null

-- 6. Before it has recorded what it was told, the next attempt begins no step: no new one and no replay.
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb; v_key text;
begin
	perform pg_temp.base_claims('service_role');
	foreach v_key in array array['g1b-step-c', 'g1b-step-a', 'g1b-step-b'] loop
		perform pg_temp.base_error(format('select pg_temp.rr_step(%L, %L, %L)', v_next, extensions.gen_random_uuid(), v_key),
			'55000', 'Run resume is not recorded');
	end loop;
	perform pg_temp.base_assert(public.qorpera_memory_run_resume(v_next) = jsonb_build_object('schema', 'qorpera.memory-run-resume/v1',
		'why', 'restart', 'unknownReceipts', jsonb_build_array(jsonb_build_object('receiptId', current_setting('qorpera_test.rr_b'),
			'logicalOperationKey', 'g1b-step-b'))), 'the resume names the unknown step');
end
$$;

-- 7. The read: every receipt of the run, oldest first; a completed one with the content of the result the runtime
--    stored for it (null for another result), an unknown one with none.
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb; v_read jsonb;
begin
	v_read := pg_temp.rr_read(v_next);
	perform pg_temp.base_assert(v_read = jsonb_build_object('schema', 'qorpera.memory-run-resume-receipts/v1', 'why', 'restart',
		'receipts', jsonb_build_array(
			jsonb_build_object('receiptId', current_setting('qorpera_test.rr_a'), 'logicalOperationKey', 'g1b-step-a',
				'status', 'completed', 'content', pg_temp.rr_result('The note says: ship on Friday.') -> 'content'),
			jsonb_build_object('receiptId', current_setting('qorpera_test.rr_o'), 'logicalOperationKey', 'g1b-step-o',
				'status', 'completed', 'content', null),
			jsonb_build_object('receiptId', current_setting('qorpera_test.rr_b'), 'logicalOperationKey', 'g1b-step-b',
				'status', 'outcome_unknown', 'content', null)),
		'completedOmitted', 0), 'the read names both steps: ' || v_read::text);
end
$$;

-- The read's limits: the newest 64 completed receipts (older ones only counted), with content newest first up to
-- 64 KiB; every unknown one. Seventy older completed receipts of 2000 bytes each, as the run's earlier work.
savepoint rr_limits;
set local session_replication_role = replica;
insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
	input_sha256, downstream_idempotency_sha256, status, result, created_at, completed_at)
select extensions.gen_random_uuid(), run.id, run.job_id, (current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId')::uuid,
	'g1b-old-' || i, 'cloud_tool', repeat('a', 64), repeat('b', 64), 'completed', pg_temp.rr_result(repeat('x', 2000)),
	oldest.created - i * interval '1 second', oldest.created - i * interval '1 second'
from public.qorpera_execution_runs as run, generate_series(1, 70) as i,
	(select min(created_at) as created from public.qorpera_run_operation_receipts where run_id = pg_temp.rr_run()) as oldest
where run.id = pg_temp.rr_run();
set local session_replication_role = origin;
do $$
declare v_read jsonb := pg_temp.rr_read(current_setting('qorpera_test.rr_next')::jsonb); v_bytes bigint; v_cut integer;
	v_last_null integer; v_first_content integer;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_read -> 'receipts') = 65 and (v_read ->> 'completedOmitted')::integer = 8
		and v_read #>> '{receipts,64,logicalOperationKey}' = 'g1b-step-b' and v_read #>> '{receipts,64,status}' = 'outcome_unknown'
		and v_read #> '{receipts,63,content}' = 'null' and v_read #>> '{receipts,62,logicalOperationKey}' = 'g1b-step-a'
		and jsonb_typeof(v_read #> '{receipts,62,content}') = 'object',
		'the newest 64 completed and the unknown one: ' || left(v_read::text, 400));
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_read -> 'receipts') r
		where r ->> 'logicalOperationKey' in ('g1b-old-63', 'g1b-old-64', 'g1b-old-65', 'g1b-old-66', 'g1b-old-67', 'g1b-old-68',
			'g1b-old-69', 'g1b-old-70')), 'the oldest 8 are only counted');
	select sum(octet_length((r -> 'content')::text)) filter (where jsonb_typeof(r -> 'content') = 'object'),
		max(n) filter (where jsonb_typeof(r -> 'content') <> 'object' and r ->> 'logicalOperationKey' like 'g1b-old-%'),
		min(n) filter (where jsonb_typeof(r -> 'content') = 'object' and r ->> 'logicalOperationKey' like 'g1b-old-%')
	into v_bytes, v_last_null, v_first_content
	from jsonb_array_elements(v_read -> 'receipts') with ordinality as e(r, n);
	select octet_length((result -> 'content')::text)::integer into v_cut from public.qorpera_run_operation_receipts
	where run_id = pg_temp.rr_run() and logical_operation_key = v_read #>> array['receipts', (v_last_null - 1)::text, 'logicalOperationKey'];
	perform pg_temp.base_assert(v_bytes <= 65536 and v_last_null < v_first_content and v_bytes + v_cut > 65536,
		format('content runs newest first up to 64 KiB: %s bytes, the newest without at %s, the oldest with at %s',
			v_bytes, v_last_null, v_first_content));
end
$$;
rollback to savepoint rr_limits;

-- A run that no longer resumes (here, made narrow by its machine) cannot be read.
savepoint rr_read_closed;
create or replace function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$ select true $$;
select pg_temp.base_error(format('select pg_temp.rr_read(%L)', current_setting('qorpera_test.rr_next')), '55000',
	'Run resume is unavailable') \g /dev/null
rollback to savepoint rr_read_closed;

-- 8. The record: the next attempt read no steps and was told of the unknown step. It may not leave the unknown one out,
--    name a completed one as unknown, claim steps read or name a log step. Its replay answers the same; another record
--    is refused.
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb; v_b text := current_setting('qorpera_test.rr_b');
	v_told jsonb := jsonb_build_object('stepsRead', 0, 'unknownCalls', jsonb_build_array(
		jsonb_build_object('call', null, 'step', null, 'receiptId', current_setting('qorpera_test.rr_b'))));
	v_answer jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select pg_temp.rr_record(%L, %L)', v_next, '{"stepsRead":0,"unknownCalls":[]}'),
		'22023', 'Run resume omits an unknown outcome');
	perform pg_temp.base_error(format('select pg_temp.rr_record(%L, %L)', v_next, jsonb_build_object('stepsRead', 0,
		'unknownCalls', (v_told -> 'unknownCalls') || jsonb_build_array(jsonb_build_object('call', null, 'step', null,
			'receiptId', current_setting('qorpera_test.rr_a'))))), '22023', 'Run resume receipt is unavailable');
	perform pg_temp.base_error(format('select pg_temp.rr_record(%L, %L)', v_next, jsonb_set(v_told, '{stepsRead}', '1')),
		'55000', 'Run resume log is unavailable or changed');
	perform pg_temp.base_error(format('select pg_temp.rr_record(%L, %L)', v_next, jsonb_build_object('stepsRead', 1,
		'unknownCalls', (v_told -> 'unknownCalls') || '[{"call":"call-1","step":0,"receiptId":null}]')),
		'55000', 'Run resume log is unavailable or changed');
	v_answer := pg_temp.rr_record(v_next, v_told);
	perform pg_temp.base_assert(v_answer = jsonb_build_object('schema', 'qorpera.memory-run-resume-record/v1', 'why', 'restart',
		'stepsRead', 0, 'unknownCalls', jsonb_build_array(jsonb_build_object('call', null, 'step', null, 'receiptId', v_b,
			'logicalOperationKey', 'g1b-step-b'))), 'the record names the unknown step: ' || v_answer::text);
	perform pg_temp.base_assert(pg_temp.rr_record(v_next, v_told) = v_answer, 'a replay answers the same');
	perform pg_temp.base_error(format('select pg_temp.rr_record(%L, %L)', v_next, '{"stepsRead":0,"unknownCalls":[]}'),
		'23505', 'Run resume was recorded otherwise');
	perform pg_temp.base_assert((select count(*) = 1 and bool_and(steps_read = 0 and why = 'restart')
		from public.qorpera_memory_run_resumes where run_id = pg_temp.rr_run()), 'one record, of no steps');
end
$$;

-- 9. Now a completed step's key with the same inputs replays its stored result and does not run again; the unknown
--    step's key says so and never runs; other inputs under a key are refused; a new step runs.
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb; v_replay jsonb; v_receipt uuid := extensions.gen_random_uuid();
	v_operations integer := (select operation_count from public.qorpera_execution_run_budgets where run_id = pg_temp.rr_run());
begin
	perform pg_temp.base_claims('service_role');
	v_replay := pg_temp.rr_step(v_next, extensions.gen_random_uuid(), 'g1b-step-a');
	perform pg_temp.base_assert(v_replay ->> 'state' = 'completed' and v_replay ->> 'receipt_id' = current_setting('qorpera_test.rr_a')
		and v_replay -> 'result' = pg_temp.rr_result('The note says: ship on Friday.'),
		'a completed step replays its stored result: ' || v_replay::text);
	v_replay := pg_temp.rr_step(v_next, extensions.gen_random_uuid(), 'g1b-step-b');
	perform pg_temp.base_assert(v_replay ->> 'state' = 'outcome_unknown' and v_replay ->> 'receipt_id' = current_setting('qorpera_test.rr_b'),
		'the unknown step stays unknown: ' || v_replay::text);
	perform pg_temp.base_error(format('select pg_temp.rr_step(%L, %L, %L, %L)', v_next, extensions.gen_random_uuid(), 'g1b-step-a',
		repeat('d', 64)), '23505', 'logical operation key is already bound to other work');
	perform pg_temp.base_assert((select count(*) from public.qorpera_run_operation_receipts where run_id = pg_temp.rr_run()) = 3
		and (select operation_count from public.qorpera_execution_run_budgets where run_id = pg_temp.rr_run()) = v_operations,
		'nothing ran again');
	perform pg_temp.base_assert(pg_temp.rr_step(v_next, v_receipt, 'g1b-step-c') ->> 'state' = 'executing', 'a new step begins');
	perform pg_temp.base_assert(pg_temp.rr_step_done(v_next, v_receipt, pg_temp.rr_result('Shipped.')) ->> 'state' = 'completed',
		'the new step completes');
end
$$;

-- 10. Cut off again, the run resumes again; its third attempt is told of every receipt, the unknown one still unknown,
--     and is fenced until it records. Its eighth attempt is its last: the cap of 8 still ends the run.
savepoint rr_again;
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb; v_third jsonb; v_read jsonb;
begin
	perform pg_temp.rr_expire((v_next ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'queued' and attempt_count = 2 from public.qorpera_runner_jobs
		where id = (v_next ->> 'jobId')::uuid) and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 2, 'a second cut-off resumes');
	v_third := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.rr_begin(v_third);
	v_read := pg_temp.rr_read(v_third);
	perform pg_temp.base_assert((select array_agg((r ->> 'logicalOperationKey') || ':' || (r ->> 'status') order by n)
		from jsonb_array_elements(v_read -> 'receipts') with ordinality as e(r, n))
		= array['g1b-step-a:completed', 'g1b-step-o:completed', 'g1b-step-b:outcome_unknown', 'g1b-step-c:completed'],
		'the third attempt is told of every receipt: ' || v_read::text);
	perform pg_temp.base_error(format('select pg_temp.rr_step(%L, %L, %L)', v_third, extensions.gen_random_uuid(), 'g1b-step-d'),
		'55000', 'Run resume is not recorded');
end
$$;
rollback to savepoint rr_again;
savepoint rr_cap;
set local session_replication_role = replica;
update public.qorpera_runner_jobs set attempt_count = 8 where id = (current_setting('qorpera_test.rr_next')::jsonb ->> 'jobId')::uuid;
set local session_replication_role = origin;
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb;
begin
	perform pg_temp.rr_expire((v_next ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid)
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 1, 'the cap of 8 ends the run');
end
$$;
rollback to savepoint rr_cap;

-- 11. The resumed attempt answers and completes the same task.
do $$
declare v_next jsonb := current_setting('qorpera_test.rr_next')::jsonb; v_done jsonb; v_sends integer; v_final text;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_public_send(v_next, 'final', 'rr-final');
	select count(*), max(send.event_id::text) filter (where send.phase = 'final') into v_sends, v_final
	from public.qorpera_agent_sends as send
	where send.run_id = (v_next ->> 'runId')::uuid and send.assignment_id = (v_next ->> 'assignmentId')::uuid;
	v_done := public.qorpera_complete_runner_job_v6((v_next ->> 'runnerId')::uuid, repeat('2', 64), (v_next ->> 'jobId')::uuid,
		repeat('3', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), null,
		jsonb_build_object('schema', 'qorpera.runner-result/v1', 'runtime', 'company-path-v1', 'backend', 'native-company-runtime',
			'native_lease_id', v_next ->> 'leaseId', 'substrate_version_id', null,
			'output_count', 0, 'output_bytes', 0, 'publication', null,
			'backend_result', jsonb_build_object('schema', 'qorpera.native-harness-result/v2', 'run_id', v_next ->> 'runId',
				'message_count', v_sends, 'final_message_id', v_final, 'provider_session_id', 'resume-fixture'),
			'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
	perform pg_temp.base_assert(v_done ->> 'status' = 'completed', 'the resumed run completes: ' || v_done::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_memory_run_logs where run_id = pg_temp.rr_run()),
		'the run kept no log');
end
$$;

set constraints all immediate;
rollback;
