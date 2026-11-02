-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 3. Today's path"
-- Release PR #1390 review F1 (20260930547000): a run in Agent notebooks mode that has sent its final message no longer
-- resumes from its receipts. Test 466's run keeps no log; its first attempt has acknowledged ('rr-ack'), completed two
-- steps and begun a third. Here it completes the third, and with no final it would still be cut off and queued again
-- (as 466). Then it sends its final, and before its job completes its runner dies: its lease runs out, it reports a
-- retryable failure, or it fails at its login's usage limit. Each time the run takes v190's path: its job fails, it is
-- neither cut off nor paused, and it waits for review. It is never queued again, so no next attempt is left that could
-- neither send (the run's final is sent) nor complete (the completion counts only that attempt's sends). Not cut off,
-- it completes as before. A resumed attempt that has recorded its resume and sent its final takes the same path when
-- cut off, and completes as before when not.

-- The runner's own failure, retryable or not.
create function pg_temp.af_fail(p_binding jsonb, p_error text, p_retryable boolean) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_fail_runner_job((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), p_error, p_retryable);
end
$$;
-- v190's path for the attempt: its job fails, the run has only the cut-offs before it and no pause, and the attempt
-- waits for review.
create function pg_temp.af_today(p_binding jsonb, p_cut_offs bigint, p_message text) returns void language plpgsql as $$
declare v_status text := (select status from public.qorpera_runner_jobs where id = (p_binding ->> 'jobId')::uuid);
begin
	perform pg_temp.base_assert(v_status = 'failed'
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = p_cut_offs and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 0
		and exists (select 1 from public.qorpera_execution_run_events where run_id = pg_temp.rr_run() and event_type = 'review_pending'
			and payload ->> 'reason' = 'native_execution_uncertain' and payload ->> 'assignment_id' = p_binding ->> 'assignmentId'),
		p_message || ': the job is ' || coalesce(v_status, 'gone'));
end
$$;
-- The attempt completes its job, naming its own sends (as 466's 11).
create function pg_temp.af_complete(p_binding jsonb) returns jsonb language plpgsql as $$
declare v_sends integer; v_final text;
begin
	perform pg_temp.base_claims('service_role');
	select count(*), max(send.event_id::text) filter (where send.phase = 'final') into v_sends, v_final
	from public.qorpera_agent_sends as send
	where send.run_id = (p_binding ->> 'runId')::uuid and send.assignment_id = (p_binding ->> 'assignmentId')::uuid;
	return public.qorpera_complete_runner_job_v6((p_binding ->> 'runnerId')::uuid, repeat('2', 64), (p_binding ->> 'jobId')::uuid,
		repeat('3', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), null,
		jsonb_build_object('schema', 'qorpera.runner-result/v1', 'runtime', 'company-path-v1', 'backend', 'native-company-runtime',
			'native_lease_id', p_binding ->> 'leaseId', 'substrate_version_id', null,
			'output_count', 0, 'output_bytes', 0, 'publication', null,
			'backend_result', jsonb_build_object('schema', 'qorpera.native-harness-result/v2', 'run_id', p_binding ->> 'runId',
				'message_count', v_sends, 'final_message_id', v_final, 'provider_session_id', 'resume-fixture'),
			'usage', '{"schema":"qorpera.runner-usage/v1","execution_ms":50,"input_bytes":0,"output_bytes":0,"result_bytes":300,
				"limits":{"wall_time_ms":1000,"memory_bytes":67108864,"cpu_millis":1000,"max_pids":16,
					"max_input_bytes":1048576,"max_output_bytes":0,"max_result_bytes":4096}}'::jsonb));
end
$$;

-- 1. The check keeps its name, argument, result, language, volatility, settings, owner and grants (nobody may call it),
--    and names both migrations.
do $$
declare v_shape text;
begin
	select format('result=%s;language=%s;volatility=%s;secdef=%s;config=%s;owner=%s;anon=%s;authenticated=%s;public=%s;service_role=%s',
		pg_get_function_result(p.oid), l.lanname, p.provolatile, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner),
		has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
		exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
			where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
		has_function_privilege('service_role', p.oid, 'EXECUTE'))
	into v_shape
	from pg_proc as p join pg_language as l on l.oid = p.prolang
	where p.oid = 'public.qorpera_run_resumes_from_receipts(uuid)'::regprocedure;
	perform pg_temp.base_assert(v_shape = 'result=boolean;language=sql;volatility=s;secdef=t;config={"search_path=\"\""};'
		|| 'owner=postgres;anon=f;authenticated=f;public=f;service_role=f', 'the check''s shape: ' || coalesce(v_shape, 'none'));
	perform pg_temp.base_assert((select count(*) = 1 from pg_proc
		where proname = 'qorpera_run_resumes_from_receipts' and pronamespace = 'public'::regnamespace), 'one check by that name');
	perform pg_temp.base_assert((select strpos(prosrc, '20260930539000') > 0 and strpos(prosrc, '20260930547000') > 0 from pg_proc
		where oid = 'public.qorpera_run_resumes_from_receipts(uuid)'::regprocedure), 'the check names both migrations');
end
$$;

-- 2. The open step completes. A progress message is no final: the run still resumes from its receipts, and cut off now,
--    it is queued again.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_assert(pg_temp.rr_step_done(v_binding, current_setting('qorpera_test.rr_b')::uuid,
		pg_temp.rr_result('Step B is done.')) ->> 'state' = 'completed', 'step B completes');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run())
		and public.qorpera_run_resumes_from_log(pg_temp.rr_run()), 'with no final the run resumes from its receipts');
end
$$;
savepoint af_no_final;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.rr_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid)
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 1, 'cut off with no final, the run is queued again');
end
$$;
rollback to savepoint af_no_final;

-- 3. The final commits; the runner dies before the job completes. The run no longer resumes from its receipts, and each
--    way the attempt ends takes v190's path.
savepoint af_final;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_public_send(v_binding, 'final', 'af-final');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run()) is false
		and public.qorpera_run_resumes_from_log(pg_temp.rr_run()) is false, 'after its final the run does not resume');
end
$$;
-- Its lease runs out.
savepoint af_expired;
select pg_temp.rr_expire((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid) \g /dev/null
select pg_temp.af_today(current_setting('qorpera_test.base_binding')::jsonb, 0, 'cut off after its final, the run fails') \g /dev/null
rollback to savepoint af_expired;
-- Its runner restarted and reports a retryable failure.
savepoint af_retryable;
select pg_temp.af_fail(current_setting('qorpera_test.base_binding')::jsonb, 'The runner process restarted', true) \g /dev/null
select pg_temp.af_today(current_setting('qorpera_test.base_binding')::jsonb, 0,
	'a retryable failure after its final fails the run') \g /dev/null
rollback to savepoint af_retryable;
-- It fails at its login's usage limit: no pause.
savepoint af_limit;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(v_binding, 'usage_limit', clock_timestamp() + interval '30 hours');
	perform pg_temp.af_fail(v_binding, 'Native provider bridge request failed (429) [usage limit]', false);
	perform pg_temp.af_today(v_binding, 0, 'a run at its usage limit after its final fails');
end
$$;
rollback to savepoint af_limit;
-- Not cut off, it completes as before, and no resume was ever recorded.
do $$
declare v_done jsonb := pg_temp.af_complete(current_setting('qorpera_test.base_binding')::jsonb);
begin
	perform pg_temp.base_assert(v_done ->> 'status' = 'completed', 'the run completes after its final: ' || v_done::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_memory_run_resumes where run_id = pg_temp.rr_run()),
		'no resume is recorded');
end
$$;
rollback to savepoint af_final;

-- 4. Cut off with no final, the run resumes. Its next attempt records its resume (no step is unknown) and sends its
--    final; cut off then, it takes v190's path, and not cut off it completes as before.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_next jsonb;
begin
	perform pg_temp.rr_expire((v_binding ->> 'jobId')::uuid);
	perform pg_temp.base_assert((select status = 'queued' from public.qorpera_runner_jobs where id = (v_binding ->> 'jobId')::uuid)
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 1, 'cut off with no final, the run is queued again');
	v_next := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.rr_begin(v_next);
	perform pg_temp.rr_record(v_next, '{"stepsRead":0,"unknownCalls":[]}');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run())
		and exists (select 1 from public.qorpera_memory_run_resumes where run_id = pg_temp.rr_run()),
		'the next attempt resumes from its receipts and has recorded it');
	perform pg_temp.base_public_send(v_next, 'final', 'af-next-final');
	perform pg_temp.base_assert(public.qorpera_run_resumes_from_receipts(pg_temp.rr_run()) is false,
		'after its final the run no longer resumes');
	perform set_config('qorpera_test.af_next', v_next::text, true);
end
$$;
savepoint af_next_expired;
select pg_temp.rr_expire((current_setting('qorpera_test.af_next')::jsonb ->> 'jobId')::uuid) \g /dev/null
select pg_temp.af_today(current_setting('qorpera_test.af_next')::jsonb, 1, 'the resumed attempt cut off after its final fails') \g /dev/null
rollback to savepoint af_next_expired;
do $$
declare v_done jsonb := pg_temp.af_complete(current_setting('qorpera_test.af_next')::jsonb);
begin
	perform pg_temp.base_assert(v_done ->> 'status' = 'completed', 'the resumed attempt completes after its final: ' || v_done::text);
end
$$;

set constraints all immediate;
rollback;
