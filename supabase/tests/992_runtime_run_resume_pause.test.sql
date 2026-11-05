-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Context tree W5a-1 (20260930170000): a started run whose login reaches its usage limit pauses, and goes on from its
-- run log on the same login after the limit resets; never on another login, and never at once. Test 924's run of
-- Alice's records its native start and acknowledges; the native host records the usage limit for the attempt, and the
-- runner reports the run failed. With a run log (W5a-2's gate, 990), the job is queued again but held until the
-- reset, the pause is not an attempt, and its day in the queue counts from the reset. The next attempt still has a new
-- number (its machine's name). It starts on the same login and may reach the limit again: its own signal pauses it
-- again, also when its lease runs out after the signal, and a reset time already past or only moments away never
-- re-queues it at once. A member may still stop a paused run, and a paused run whose login is gone fails. The
-- cut-off is 991.

create function pg_temp.rp_begin(p_binding jsonb) returns jsonb language plpgsql as $$
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
-- The native host's usage-limit signal for the binding's attempt.
create function pg_temp.rp_signal(p_binding jsonb, p_resets_at timestamptz) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_record_provider_usage_signal(p_binding, 'usage_limit', p_resets_at);
end
$$;
create function pg_temp.rp_fail(p_binding jsonb, p_error text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, false);
end
$$;
create function pg_temp.rp_reconcile() returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
end
$$;
create function pg_temp.rp_events(p_run uuid, p_type text) returns bigint language sql as $$
	select count(*) from public.qorpera_execution_run_events where run_id = p_run and event_type = p_type
$$;

-- The run has a log, as its runtime's first batch indexes runs/<run>/run.toml, and the gate is on for it.
insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, run_path, run_key, toml_path_version, commit_id)
select run.environment_id, run.id, extensions.gen_random_uuid(), 'QorperaOS/agents/alice/runs/' || run.id, 'qorperaos/agents/alice/runs/' || run.id,
	extensions.gen_random_uuid(), extensions.gen_random_uuid()
from public.qorpera_execution_runs as run where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
select pg_temp.base_assert(public.qorpera_run_resumes_from_log((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid),
	'a run with a log resumes') \g /dev/null

-- 1. The run starts and acknowledges; its login reaches its usage limit, which resets in 30 hours, and the runner
--    reports the run failed. The run pauses: queued again but held until the reset, on the same sponsor version, with
--    the attempt not counted, nothing waiting for review, and the member told about the limit.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_run public.qorpera_execution_runs;
	v_job public.qorpera_runner_jobs; v_event jsonb; v_reset timestamptz := date_trunc('second', clock_timestamp() + interval '30 hours');
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	perform pg_temp.rp_begin(v_binding);
	perform pg_temp.base_public_send(v_binding, 'progress', 'rp-ack');
	perform pg_temp.base_assert(pg_temp.rp_signal(v_binding, v_reset) ->> 'replayed' = 'false', 'the usage limit is recorded');
	perform pg_temp.rp_fail(v_binding, 'Native provider bridge request failed (429) [usage limit]');
	select * into strict v_job from public.qorpera_runner_jobs where id = v_run.job_id;
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.runner_id is null and v_job.client_lease_id is null
		and v_job.attempt_count = 0 and v_job.queued_at = v_reset and v_job.dispatch_deferred_until = v_reset
		and v_job.last_error = 'Native provider bridge request failed (429) [usage limit]',
		'the run is held until the reset: ' || to_jsonb(v_job)::text);
	perform pg_temp.base_assert(pg_temp.rp_events(v_run.id, 'run_paused') = 1 and pg_temp.rp_events(v_run.id, 'run_cut_off') = 0
		and pg_temp.rp_events(v_run.id, 'review_pending') = 0, 'the run pauses and waits for no review');
	select payload into strict v_event from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'run_paused';
	perform pg_temp.base_assert(v_event - 'resetsAt' = jsonb_build_object('schema', 'qorpera.run-resume/v1',
		'assignmentId', v_binding ->> 'assignmentId', 'reason', 'Native provider bridge request failed (429) [usage limit]',
		'sponsorVersion', v_run.sponsor_version,
		'providerConnectionId', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id', 'providerConnectionVersion', 2)
		and (v_event ->> 'resetsAt')::timestamptz = v_reset, 'the run_paused event names the login and its reset: ' || v_event::text);
	perform pg_temp.base_assert((select sponsor_version = v_run.sponsor_version from public.qorpera_execution_runs where id = v_run.id)
		and not exists (select 1 from public.qorpera_execution_sponsor_versions version
			where version.binding_id = v_run.sponsor_binding_id and version.version > v_run.sponsor_version),
		'a paused run keeps its login');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_member_notifications
		where kind = 'provider_usage_limit' and user_id = '92400000-0000-4000-8000-000000000001' and subject ->> 'runId' = v_run.id::text),
		'the member is told about the limit');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_runner_audit_receipts
		where job_id = v_job.id and runner_id = (v_binding ->> 'runnerId')::uuid and event_type = 'job_requeued'
			and payload = '{"attempt_count":0,"resumed":"paused"}'::jsonb), 'the runner audit names the pause');
	perform pg_temp.rp_reconcile();
	perform pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where id = v_run.job_id),
		'the reconcile keeps a paused run queued');
end
$$;

-- A usage reading of the login after its limit that shows room (the vault's daily check, or Settings → Refresh, through the
-- refresh's completion) brings the paused run back at once (20260930575000); while the wall stands, nothing comes back.
savepoint rp_release;
do $$
declare v_job uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
	v_identity uuid := (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
begin
	perform pg_temp.base_assert(public.qorpera_release_paused_runs_with_room(v_identity) = 0, 'a run came back at its limit');
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	values ((current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid, 2,
		jsonb_build_object('observedAt', statement_timestamp(), 'windows', jsonb_build_array(
			jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 10))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
	perform pg_temp.base_assert(public.qorpera_release_paused_runs_with_room(v_identity) = 1, 'the paused run did not come back');
	perform pg_temp.base_assert((select status = 'queued' and dispatch_deferred_until <= clock_timestamp()
		and queued_at <= clock_timestamp() from public.qorpera_runner_jobs where id = v_job), 'the paused run is still held');
end
$$;
rollback to savepoint rp_release;

-- No orchestrator takes a paused run before the reset.
savepoint rp_no_claim;
do $$
declare v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid; v_claim jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120);
	perform pg_temp.base_assert(v_claim is null or v_claim = 'null'::jsonb or v_claim #>> '{work,run_id}' <> v_run::text,
		'a paused run is not claimed before the reset: ' || coalesce(v_claim::text, ''));
end
$$;
rollback to savepoint rp_no_claim;

-- 2. A day in the queue after the reset fails the run, as for any queued run.
savepoint rp_day;
update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '24 hours 1 second',
	dispatch_deferred_until = statement_timestamp() - interval '24 hours 1 second'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
select pg_temp.rp_reconcile() \g /dev/null
select pg_temp.base_assert((select status = 'failed' and last_error = 'No computer could start the run within a day'
	from public.qorpera_runner_jobs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid),
	'a paused run fails a day after its reset') \g /dev/null
rollback to savepoint rp_day;

-- 3. The member may stop a paused run.
savepoint rp_stop;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001') \g /dev/null
select pg_temp.base_assert(public.qorpera_cancel_runner_job((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid)
	->> 'status' = 'cancelled', 'the member stops a paused run') \g /dev/null
rollback to savepoint rp_stop;

-- 4. A paused run whose login is gone fails; it never moves to another login.
savepoint rp_login_gone;
update public.qorpera_provider_connections set status = 'disabled'
where id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
select pg_temp.rp_reconcile() \g /dev/null
select pg_temp.base_assert((select status = 'failed' from public.qorpera_runner_jobs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid), 'a paused run whose login is gone fails') \g /dev/null
rollback to savepoint rp_login_gone;

-- 5. After the reset the claim gives attempt 2, not the paused attempt's 1 again: the number names the attempt's
--    machine and runner, and attempt 1's are spent. A start that fails on attempt 2's released machine moves the run
--    past attempt 2.
savepoint rp_number;
update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
	dispatch_deferred_until = statement_timestamp() - interval '1 minute'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
do $$
declare v_run uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid; v_claim jsonb; v_runner jsonb;
	v_release jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120);
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = v_run::text and v_claim #>> '{work,attempt}' = '2',
		'the attempt after the pause has a new number: ' || coalesce(v_claim::text, 'none'));
	v_runner := public.qorpera_provision_execution_runner(v_run, public.qorpera_run_attempt_acquisition_id(v_run, 2), 'process', repeat('1', 64));
	insert into public.qorpera_runtime_machine_allocations (id, profile_id, run_id, runner_id, provider_adapter, instance_sha256, released_at)
	select public.qorpera_run_attempt_acquisition_id(v_run, 2), run.profile_id, run.id, (v_runner ->> 'runner_id')::uuid, 'process',
		repeat('9', 64), clock_timestamp()
	from public.qorpera_execution_runs as run where run.id = v_run;
	v_release := public.qorpera_release_runner_job_claim('92400000-0000-4000-8000-000000000092', (v_claim ->> 'claim_id')::uuid,
		extensions.gen_random_uuid(), 'Runner provider request failed (422) [code=PROVIDER_ACQUIRE]');
	perform pg_temp.base_assert((v_release ->> 'attempt_abandoned')::boolean
		and (select attempt_count = 1 and status = 'queued' from public.qorpera_runner_jobs where run_id = v_run)
		and (select status = 'revoked' from public.qorpera_runners where id = (v_runner ->> 'runner_id')::uuid)
		and (select payload ->> 'attempt_abandoned' = '2' from public.qorpera_execution_run_events
			where run_id = v_run and event_type = 'infrastructure_retry' order by id desc limit 1),
		'the release finds attempt 2''s machine and moves on: ' || v_release::text);
	perform pg_temp.base_assert(public.qorpera_run_attempt_number(v_run, 1) = 3, 'the attempt after that is attempt 3');
end
$$;
rollback to savepoint rp_number;

-- 6. The limit resets: the next attempt is claimed and starts on the same login.
update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
	dispatch_deferred_until = statement_timestamp() - interval '1 minute'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
do $$
declare v_next jsonb; v_start jsonb;
begin
	v_next := pg_temp.base_start((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
	perform set_config('qorpera_test.rp_next', v_next::text, true);
	perform pg_temp.base_assert((select attempt_count = 1 from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid),
		'the pause did not count as an attempt');
	perform pg_temp.base_assert((select provider_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		and provider_connection_version = 2 from public.qorpera_native_provider_connection_leases where id = (v_next ->> 'leaseId')::uuid),
		'the next attempt holds the same login');
	v_start := pg_temp.rp_begin(v_next);
	perform pg_temp.base_assert(v_start ->> 'leaseId' = v_next ->> 'leaseId', 'the next attempt starts: ' || v_start::text);
end
$$;

-- 7. A reset time already past is no reset time (6 hours from the signal), and one only moments away still holds the
--    run a minute: a pause never queues the run again at once, to reach the limit again.
savepoint rp_past;
do $$
declare v_next jsonb := current_setting('qorpera_test.rp_next')::jsonb; v_signal jsonb; v_job public.qorpera_runner_jobs;
begin
	v_signal := pg_temp.rp_signal(v_next, clock_timestamp() - interval '1 hour');
	perform pg_temp.rp_fail(v_next, 'Native provider bridge request failed (429) [usage limit, reset past]');
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid;
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.dispatch_deferred_until = v_job.queued_at
		and v_job.queued_at = (select observed_at + interval '6 hours' from public.qorpera_provider_connection_usage_signals
			where id = (v_signal ->> 'signalId')::uuid), 'a reset time already past holds the run 6 hours: ' || to_jsonb(v_job)::text);
end
$$;
rollback to savepoint rp_past;
savepoint rp_soon;
do $$
declare v_next jsonb := current_setting('qorpera_test.rp_next')::jsonb; v_job public.qorpera_runner_jobs;
begin
	perform pg_temp.rp_signal(v_next, clock_timestamp() + interval '5 seconds');
	perform pg_temp.rp_fail(v_next, 'Native provider bridge request failed (429) [usage limit, reset soon]');
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid;
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.dispatch_deferred_until = v_job.queued_at
		and v_job.queued_at = statement_timestamp() + interval '1 minute', 'a reset moments away holds the run a minute: ' || to_jsonb(v_job)::text);
end
$$;
rollback to savepoint rp_soon;

-- 8. The next attempt reaches the limit again, with no reset time: its own signal (not a replay of the first), and a
--    pause of 6 hours.
do $$
declare v_next jsonb := current_setting('qorpera_test.rp_next')::jsonb; v_signal jsonb;
begin
	v_signal := pg_temp.rp_signal(v_next, null);
	perform pg_temp.base_assert(v_signal ->> 'replayed' = 'false' and (select count(*) = 2 from public.qorpera_provider_connection_usage_signals
		where run_id = (v_next ->> 'runId')::uuid and signal_kind = 'usage_limit'), 'the next attempt''s limit is its own signal');
	perform set_config('qorpera_test.rp_signal', v_signal ->> 'signalId', true);
end
$$;
savepoint rp_again;
do $$
declare v_next jsonb := current_setting('qorpera_test.rp_next')::jsonb; v_job public.qorpera_runner_jobs;
begin
	perform pg_temp.rp_fail(v_next, 'Native provider bridge request failed (429) [usage limit again]');
	select * into strict v_job from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid;
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.attempt_count = 0 and v_job.dispatch_deferred_until = v_job.queued_at
		and v_job.queued_at = (select observed_at + interval '6 hours' from public.qorpera_provider_connection_usage_signals
			where id = current_setting('qorpera_test.rp_signal')::uuid), 'an unknown reset holds the run 6 hours: ' || to_jsonb(v_job)::text);
	perform pg_temp.base_assert(pg_temp.rp_events((v_next ->> 'runId')::uuid, 'run_paused') = 2, 'the run pauses again');
end
$$;
rollback to savepoint rp_again;

-- 9. A lease that runs out after the signal is a pause too, not a cut-off.
savepoint rp_expired;
do $$
declare v_next jsonb := current_setting('qorpera_test.rp_next')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = (v_next ->> 'jobId')::uuid;
	perform public.qorpera_reconcile_runner_orchestrator('92400000-0000-4000-8000-000000000092');
	perform pg_temp.base_assert((select status = 'queued' and attempt_count = 0 and dispatch_deferred_until > statement_timestamp()
		from public.qorpera_runner_jobs where id = (v_next ->> 'jobId')::uuid)
		and pg_temp.rp_events((v_next ->> 'runId')::uuid, 'run_paused') = 2
		and pg_temp.rp_events((v_next ->> 'runId')::uuid, 'run_cut_off') = 0, 'a lease run out after the limit is a pause');
end
$$;
rollback to savepoint rp_expired;

-- 10. The resumed run answers and completes on the same login.
do $$
declare v_next jsonb := current_setting('qorpera_test.rp_next')::jsonb; v_done jsonb; v_sends integer; v_final text;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_public_send(v_next, 'final', 'rp-final');
	select count(*), max(send.event_id::text) filter (where send.phase = 'final') into v_sends, v_final
	from public.qorpera_agent_sends as send
	where send.run_id = (v_next ->> 'runId')::uuid and send.assignment_id = (v_next ->> 'assignmentId')::uuid;
	v_done := public.qorpera_complete_runner_job_v6((v_next ->> 'runnerId')::uuid, repeat('2', 64), (v_next ->> 'jobId')::uuid,
		repeat('3', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), null,
		jsonb_build_object('schema', 'qorpera.runner-result/v1', 'runtime', 'company-path-v1', 'backend', 'native-company-runtime',
			'native_lease_id', v_next ->> 'leaseId', 'substrate_version_id', null,
			'output_count', 0, 'output_bytes', 0, 'publication', null,
			'backend_result', jsonb_build_object('schema', 'qorpera.native-harness-result/v2', 'run_id', v_next ->> 'runId',
				'message_count', v_sends, 'final_message_id', v_final, 'provider_session_id', 'pause-fixture'),
			'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
	perform pg_temp.base_assert(v_done ->> 'status' = 'completed', 'the resumed run completes: ' || v_done::text);
end
$$;

set constraints all immediate;
rollback;
