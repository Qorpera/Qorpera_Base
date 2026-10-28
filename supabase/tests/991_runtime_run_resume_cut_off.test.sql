-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Context tree W5a-1 (20260930170000): a started run that is cut off goes on from its run log. Test 924's run of Alice's
-- holds a real native lease; it records its native start, acknowledges in her thread and begins a step. Then its runner's
-- lease runs out, as when the machine dies, and the orchestrator's reconcile ends the attempt. Without a run log (W5a-2's
-- gate, 990), in Agent tree mode, that is today's path: the run fails and waits for review (in Agent notebooks mode it
-- resumes from its receipts, 466). With a log, the open step's outcome becomes
-- unknown, the attempt's native lease goes to history, a run_cut_off event supersedes the start, and the job is queued
-- again. The next attempt is fenced from nothing but the old one's lease: it starts once, on the same login only, sees the
-- step as outcome unknown, does a new step and completes. A run that never started, a run with an ambiguous step and a
-- run out of attempts keep today's path. The pause at a usage limit is 992.

-- An attempt's native start, as the runner records it (as 715 does).
create function pg_temp.rc_begin(p_binding jsonb) returns jsonb language plpgsql as $$
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
-- A step: a tool operation that needs no company revision.
create function pg_temp.rc_step(p_binding jsonb, p_receipt uuid, p_key text) returns jsonb language sql as $$
	select public.qorpera_begin_native_tool_operation(p_binding, p_receipt, p_key, repeat('a', 64), repeat('b', 64), false)
$$;
create function pg_temp.rc_step_done(p_binding jsonb, p_receipt uuid) returns jsonb language sql as $$
	select public.qorpera_folder_complete_run_receipt(p_binding, p_receipt, repeat('a', 64), '{"ok":true}', null)
$$;
-- The attempt's runner lease runs out, and the orchestrator's reconcile ends the attempt.
create function pg_temp.rc_expire(p_job uuid) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = p_job;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
end
$$;
create function pg_temp.rc_events(p_run uuid, p_type text) returns bigint language sql as $$
	select count(*) from public.qorpera_execution_run_events where run_id = p_run and event_type = p_type
$$;

-- 1. The resume and its gate are nobody's to call, and a run with no log resumes only in Agent notebooks mode, from its
--    receipts (466).
do $$
declare v_role text; v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_run_resumes_from_log(uuid)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_resume_run_from_log(uuid,text,boolean)', 'EXECUTE'),
			'the resume is open to ' || v_role);
	end loop;
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_log(v_run), 'a notebook run with no log resumes from its receipts');
end
$$;

-- 2. With no log, in Agent tree mode, the gate is off: a started run that is cut off takes today's path. It fails, its
--    open step is ambiguous, and it waits for review.
savepoint rc_gate_off;
set local session_replication_role = replica;
update public.qorpera_execution_runs set memory_mode = 'tree'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
set local session_replication_role = origin;
select pg_temp.base_assert(public.qorpera_run_resumes_from_log((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid)
	is false, 'a tree run with no log does not resume') \g /dev/null
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.rc_begin(v_binding);
	perform pg_temp.base_public_send(v_binding, 'progress', 'rc-ack');
	perform pg_temp.rc_step(v_binding, v_receipt, 'w5-step-1');
	perform pg_temp.rc_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid),
		'with the gate off a cut-off run fails');
	perform pg_temp.base_assert((select status = 'ambiguous' from public.qorpera_run_operation_receipts where id = v_receipt),
		'with the gate off its open step is ambiguous');
	perform pg_temp.base_assert(pg_temp.rc_events((v_binding ->> 'runId')::uuid, 'review_pending') > 0
		and pg_temp.rc_events((v_binding ->> 'runId')::uuid, 'run_cut_off') = 0, 'with the gate off it waits for review');
end
$$;
rollback to savepoint rc_gate_off;

-- The run gets a log, as its runtime's first batch indexes runs/<run>/run.toml, and the gate is on for it.
insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
select run.environment_id, run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || run.id, 'qorperaos/agents/alice/runs/' || run.id,
	extensions.gen_random_uuid(), extensions.gen_random_uuid()
from public.qorpera_execution_runs as run where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
select pg_temp.base_assert(public.qorpera_run_resumes_from_log((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid),
	'a run with a log resumes') \g /dev/null

-- 3. A run that never started is retried as before: queued for a new attempt, with no resume.
savepoint rc_not_started;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.rc_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid),
		'a cut-off before the start is a pristine retry');
	perform pg_temp.base_assert(pg_temp.rc_events((v_binding ->> 'runId')::uuid, 'run_cut_off') = 0, 'a run that never started does not resume');
end
$$;
rollback to savepoint rc_not_started;

-- The run starts, acknowledges and begins its first step.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.rc_begin(v_binding);
	perform pg_temp.base_public_send(v_binding, 'progress', 'rc-ack');
	perform pg_temp.base_assert(pg_temp.rc_step(v_binding, v_receipt, 'w5-step-1') ->> 'state' = 'executing', 'the first step begins');
	perform set_config('qorpera_test.rc_receipt', v_receipt::text, true);
end
$$;

-- 4. A step whose outcome was already ambiguous keeps today's path: nobody can tell the next attempt what it did.
savepoint rc_ambiguous;
set local session_replication_role = replica;
update public.qorpera_run_operation_receipts set status = 'ambiguous', completed_at = statement_timestamp()
where id = current_setting('qorpera_test.rc_receipt')::uuid;
set local session_replication_role = origin;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.rc_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid)
		and pg_temp.rc_events((v_binding ->> 'runId')::uuid, 'run_cut_off') = 0, 'a run with an ambiguous step does not resume');
end
$$;
rollback to savepoint rc_ambiguous;

-- 5. A run out of attempts (8) keeps today's path.
savepoint rc_attempts;
set local session_replication_role = replica;
update public.qorpera_runner_jobs set attempt_count = 8
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
set local session_replication_role = origin;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.rc_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid)
		and pg_temp.rc_events((v_binding ->> 'runId')::uuid, 'run_cut_off') = 0, 'a run out of attempts does not resume');
end
$$;
rollback to savepoint rc_attempts;

-- 6. The cut-off: the job is queued again as a pristine retry is, the attempt counts, the open step's outcome is unknown,
--    the old lease is in history, and one run_cut_off event names the attempt and the login the run pays with. Nothing
--    waits for review, and the start is superseded.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_run public.qorpera_execution_runs;
	v_job public.qorpera_runner_jobs; v_event jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform pg_temp.rc_expire((v_binding ->> 'jobId')::uuid);
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.runner_id is null and v_job.client_lease_id is null
		and v_job.attempt_count = 1 and v_job.last_error = 'Runner lease expired before durable completion'
		and v_job.lease_token_sha256 is null and v_job.lease_expires_at is null
		and v_job.terminal_lease_token_sha256 = repeat('3', 64), 'the cut-off run is queued again: ' || to_jsonb(v_job)::text);
	perform pg_temp.base_assert(pg_temp.rc_events(v_run.id, 'run_cut_off') = 1, 'one run_cut_off event');
	select payload into strict v_event from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'run_cut_off';
	perform pg_temp.base_assert(v_event = jsonb_build_object('schema', 'qorpera.run-resume/v1', 'assignmentId', v_binding ->> 'assignmentId',
		'reason', 'Runner lease expired before durable completion', 'sponsorVersion', v_run.sponsor_version,
		'providerConnectionId', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id', 'providerConnectionVersion', 2),
		'the run_cut_off event names the attempt and the login: ' || v_event::text);
	perform pg_temp.base_assert((select status = 'outcome_unknown' and completed_at is not null and result is null
		from public.qorpera_run_operation_receipts where id = current_setting('qorpera_test.rc_receipt')::uuid),
		'the open step''s outcome is unknown');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_native_provider_connection_leases where run_id = v_run.id)
		and (select status = 'revoked' from public.qorpera_native_provider_connection_lease_history
			where lease_id = (v_binding ->> 'leaseId')::uuid), 'the old lease is in history');
	perform pg_temp.base_assert(pg_temp.rc_events(v_run.id, 'review_pending') = 0
		and not exists (select 1 from public.qorpera_wake_occurrences where run_id = v_run.id and status = 'requires_review'),
		'a resumed run does not wait for review');
	perform pg_temp.base_assert(public.qorpera_run_native_start_superseded(v_run.id), 'the cut-off supersedes the start');
end
$$;

-- 7. The old attempt is fenced: it can neither begin a step nor speak in the thread, before the next attempt starts and
--    after.
create function pg_temp.rc_old_fenced() returns void language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select pg_temp.rc_step(%L, %L, %L)', v_binding, extensions.gen_random_uuid(), 'w5-old-step'),
		'42501', 'Run is unavailable');
	perform pg_temp.base_error(format('select pg_temp.base_public_send(%L, %L, %L)', v_binding, 'progress', 'rc-old'), '42501');
end
$$;
select pg_temp.rc_old_fenced() \g /dev/null

-- The next attempt: claimed, provisioned, assigned and leased on the same login, through the real contracts.
do $$
begin
	perform set_config('qorpera_test.rc_next',
		pg_temp.base_start((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid)::text, true);
end
$$;
select pg_temp.rc_old_fenced() \g /dev/null

-- 8. An attempt cut off again before it starts resumes too: the run's log has the first attempt's steps.
savepoint rc_again;
do $$
declare v_next jsonb := current_setting('qorpera_test.rc_next')::jsonb;
begin
	perform pg_temp.rc_expire((v_next ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'queued' and attempt_count = 2 from public.qorpera_runner_jobs
		where id = (v_next ->> 'jobId')::uuid), 'a second cut-off queues the run again');
	perform pg_temp.base_assert(pg_temp.rc_events((v_next ->> 'runId')::uuid, 'run_cut_off') = 2, 'a second run_cut_off event');
end
$$;
rollback to savepoint rc_again;

-- 9. The next attempt's launch is accepted only on the login the cut-off named.
savepoint rc_other_login;
set local session_replication_role = replica;
update public.qorpera_execution_run_events set payload = jsonb_set(payload, '{providerConnectionVersion}', '1')
where id = (select max(id) from public.qorpera_execution_run_events
	where run_id = (current_setting('qorpera_test.rc_next')::jsonb ->> 'runId')::uuid and event_type = 'run_cut_off');
set local session_replication_role = origin;
select pg_temp.base_error(format('select pg_temp.rc_begin(%L)', current_setting('qorpera_test.rc_next')), '42501',
	'Native launch provenance is immutable') \g /dev/null
rollback to savepoint rc_other_login;

-- 10. The next attempt starts once.
do $$
declare v_next jsonb := current_setting('qorpera_test.rc_next')::jsonb; v_start jsonb;
begin
	v_start := pg_temp.rc_begin(v_next);
	perform pg_temp.base_assert(v_start ->> 'leaseId' = v_next ->> 'leaseId', 'the next attempt starts on its own lease: ' || v_start::text);
	perform pg_temp.base_error(format('select pg_temp.rc_begin(%L)', v_next), '55000', 'Earlier native execution requires reconciliation');
end
$$;

-- 11. A failed run with an unknown outcome is not retried from the thread: as with completed work, the member checks it.
savepoint rc_no_retry;
do $$
declare v_next jsonb := current_setting('qorpera_test.rc_next')::jsonb; v_run public.qorpera_execution_runs;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_next ->> 'runId')::uuid;
	perform public.qorpera_fail_runner_job((v_next ->> 'runnerId')::uuid, repeat('2', 64), (v_next ->> 'jobId')::uuid, repeat('3', 64),
		'Native provider bridge request failed (422)', false);
	perform pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs where id = v_run.job_id),
		'a run failed without a retry fails');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_retry_room_delivery(%L, %L, %s)', v_run.id, v_run.sponsor_binding_id,
		v_run.sponsor_version), '55000', 'execution recovery cannot retry work with a durable operation outcome or open proposal');
	perform pg_temp.base_claims('service_role');
end
$$;
rollback to savepoint rc_no_retry;

-- 12. The next attempt sees the first step as outcome unknown (a replay of its key says so, and the step cannot be
--     completed now); it does a new step under a new key, which an unknown outcome does not block.
do $$
declare v_next jsonb := current_setting('qorpera_test.rc_next')::jsonb; v_replay jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_claims('service_role');
	v_replay := pg_temp.rc_step(v_next, extensions.gen_random_uuid(), 'w5-step-1');
	perform pg_temp.base_assert(v_replay ->> 'state' = 'outcome_unknown' and v_replay ->> 'receipt_id' = current_setting('qorpera_test.rc_receipt'),
		'a replay of the cut-off step says its outcome is unknown: ' || v_replay::text);
	perform pg_temp.base_error(format('select pg_temp.rc_step_done(%L, %L)', v_next, current_setting('qorpera_test.rc_receipt')), 'PGRST');
	perform pg_temp.base_assert(pg_temp.rc_step(v_next, v_receipt, 'w5-step-2') ->> 'state' = 'executing', 'a new step begins');
	perform pg_temp.base_assert(pg_temp.rc_step_done(v_next, v_receipt) ->> 'state' = 'completed', 'the new step completes');
end
$$;

-- 13. The runner's own retryable failure after the start is a cut-off too, and its audit says so.
savepoint rc_runner_failure;
do $$
declare v_next jsonb := current_setting('qorpera_test.rc_next')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_fail_runner_job((v_next ->> 'runnerId')::uuid, repeat('2', 64), (v_next ->> 'jobId')::uuid, repeat('3', 64),
		'The runner process restarted', true);
	perform pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid)
		and pg_temp.rc_events((v_next ->> 'runId')::uuid, 'run_cut_off') = 2, 'a retryable runner failure is a cut-off');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_runner_audit_receipts
		where job_id = (v_next ->> 'jobId')::uuid and runner_id = (v_next ->> 'runnerId')::uuid and event_type = 'job_requeued'
			and payload = '{"attempt_count":2,"resumed":"cut_off"}'::jsonb), 'the runner audit names the resume');
end
$$;
rollback to savepoint rc_runner_failure;

-- 14. The next attempt answers and completes: its completion counts only its own messages.
do $$
declare v_next jsonb := current_setting('qorpera_test.rc_next')::jsonb; v_done jsonb; v_sends integer; v_final text;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_public_send(v_next, 'final', 'rc-final');
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
end
$$;

set constraints all immediate;
rollback;
