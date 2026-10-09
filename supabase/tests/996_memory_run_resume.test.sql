-- @fixture 991_runtime_run_resume_cut_off.test.sql until "-- The run starts, acknowledges and begins its first step."
-- W5b-2: the real cut-off and usage-limit transitions, their binding-scoped context and once-per-attempt observation.

-- The calls alone are service-role entry points; the table and helper cannot bypass a run check.
do $$
declare v_role text; v_name text; v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_memory_run_resumes', 'INSERT')
			and not has_table_privilege(v_role, 'public.qorpera_memory_run_resumes', 'UPDATE')
			and not has_table_privilege(v_role, 'public.qorpera_memory_run_resumes', 'DELETE'), 'resume table writer: ' || v_role);
		perform pg_temp.base_assert(not has_function_privilege(v_role,
			'public.qorpera_memory_run_resume_of(uuid,uuid,uuid)', 'EXECUTE'), 'resume helper open: ' || v_role);
		foreach v_name in array array['public.qorpera_memory_run_resume(jsonb)',
			'public.qorpera_memory_run_resume_record(jsonb,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_name, 'EXECUTE') = (v_role = 'service_role'),
				'resume RPC privilege: ' || v_role || ' ' || v_name);
		end loop;
	end loop;
	perform pg_temp.base_assert((select count(*) = 2 from public.qorpera_native_host_calls
		where name in ('qorpera_memory_run_resume', 'qorpera_memory_run_resume_record') and scope = 'binding'), 'binding calls');
	perform pg_temp.base_assert(public.qorpera_memory_run_resume(v_binding) is null, 'a pristine attempt is not resumed');
	perform pg_temp.base_error(format('select public.qorpera_memory_run_resume_record(%L, %L)', v_binding,
		'{"stepsRead":0,"unknownCalls":[]}'), '55000', 'Run is not resumed');
end $$;

-- An indexed log has one finished step, one pending call, and one erased placeholder. Receipts have no call/step
-- mapping, so its unknown operation must remain a separate warning even if it might have been the same action.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_run public.qorpera_execution_runs;
	v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.rc_begin(v_binding);
	perform pg_temp.base_public_send(v_binding, 'progress', 'resume-record-ack');
	perform pg_temp.rc_step(v_binding, v_receipt, 'resume-operation');
	perform set_config('qorpera_test.resume_receipt', v_receipt::text, true);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	update public.qorpera_memory_run_logs set step_count = 3 where run_id = v_run.id;
	insert into public.qorpera_memory_run_steps(environment_id, run_id, j, tool, call_id, narrow, erased, finished,
		line_sha256, fixed_sha256, block_path, block_key, block_path_version, commit_id)
	select v_run.environment_id, v_run.id, j, 'company_read', 'resume-call-' || j, false, j = 2, j = 0,
		repeat('a', 64), repeat('b', 64), 'agents/alice/runs/' || v_run.id || '/log/00000000.jsonl',
		'agents/alice/runs/' || v_run.id || '/log/00000000.jsonl', extensions.gen_random_uuid(), extensions.gen_random_uuid()
	from generate_series(0, 2) j;
	perform pg_temp.rc_expire((v_binding ->> 'jobId')::uuid);
	perform set_config('qorpera_test.resume_next', pg_temp.base_start(v_run.id)::text, true);
	perform set_config('qorpera_test.resume_request', jsonb_build_object('stepsRead', 3, 'unknownCalls', jsonb_build_array(
		jsonb_build_object('call', 'resume-call-1', 'step', 1, 'receiptId', null),
		jsonb_build_object('call', null, 'step', null, 'receiptId', v_receipt)))::text, true);
end $$;

-- The old binding is fenced before malformed input is inspected. The next one reads the same source on either
-- side of its native start; the reason is server-derived, never supplied by the runtime.
do $$
declare v_old jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_next jsonb := current_setting('qorpera_test.resume_next')::jsonb; v_before jsonb;
begin
	perform pg_temp.base_error(format('select public.qorpera_memory_run_resume(%L)', v_old), '42501');
	perform pg_temp.base_error(format('select public.qorpera_memory_run_resume_record(%L, null)', v_old), '42501');
	v_before := public.qorpera_memory_run_resume(v_next);
	perform pg_temp.base_assert(v_before = jsonb_build_object('schema', 'qorpera.memory-run-resume/v1', 'why', 'restart',
		'unknownReceipts', jsonb_build_array(jsonb_build_object('receiptId', current_setting('qorpera_test.resume_receipt')::uuid,
			'logicalOperationKey', 'resume-operation'))), 'trusted resume context: ' || v_before);
	perform pg_temp.rc_begin(v_next);
	perform pg_temp.base_assert(public.qorpera_memory_run_resume(v_next) = v_before, 'same context after native start');
end $$;

-- Closed shapes, integer limits, distinct identifiers and complete unknown sets.
do $$
declare v_next jsonb := current_setting('qorpera_test.resume_next')::jsonb;
	v_request jsonb := current_setting('qorpera_test.resume_request')::jsonb; v_bad jsonb;
begin
	for v_bad in select value from jsonb_array_elements(jsonb_build_array(null, '[]'::jsonb, '{}'::jsonb,
		v_request || '{"why":"limit_reset"}', v_request || '{"stepsRead":-1}', v_request || '{"stepsRead":1.5}',
		v_request || '{"stepsRead":2147483648}', v_request || '{"unknownCalls":null}',
		v_request || '{"unknownCalls":[null]}', v_request || '{"unknownCalls":[{}]}',
		v_request || '{"unknownCalls":[{"call":null,"step":null,"receiptId":null}]}',
		v_request || '{"unknownCalls":[{"call":"x","step":3,"receiptId":null}]}',
		v_request || '{"unknownCalls":[{"call":"x","step":-1,"receiptId":null}]}',
		v_request || '{"unknownCalls":[{"call":"x","step":null,"receiptId":null}]}',
		v_request || '{"unknownCalls":[{"call":null,"step":null,"receiptId":"bad"}]}',
		jsonb_set(v_request, '{unknownCalls,1,step}', '1'),
		jsonb_set(v_request, '{unknownCalls}', (v_request -> 'unknownCalls') || (v_request -> 'unknownCalls')),
		jsonb_set(v_request, '{unknownCalls,0,call}', '"wrong-call"'),
		jsonb_set(v_request, '{unknownCalls,0,step}', '0'),
		jsonb_set(v_request, '{unknownCalls,0}', '{"call":"resume-call-2","step":2,"receiptId":null}'),
		jsonb_set(v_request, '{unknownCalls,1,receiptId}', to_jsonb(extensions.gen_random_uuid())),
		jsonb_set(v_request, '{unknownCalls}', jsonb_build_array(v_request #> '{unknownCalls,0}')),
		jsonb_set(v_request, '{unknownCalls}', jsonb_build_array(v_request #> '{unknownCalls,1}')))) loop
		perform pg_temp.base_error(format('select public.qorpera_memory_run_resume_record(%L, %L)', v_next, v_bad), '22023');
	end loop;
	perform pg_temp.base_error(format('select public.qorpera_memory_run_resume_record(%L, %L)', v_next,
		v_request || '{"stepsRead":4}'), '55000', 'Run resume log is unavailable or changed');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_memory_run_resumes), 'refusals record nothing');
end $$;

-- One durable observation, exact replay, and no recomputation after the live log changes.
do $$
declare v_next jsonb := current_setting('qorpera_test.resume_next')::jsonb;
	v_request jsonb := current_setting('qorpera_test.resume_request')::jsonb; v_answer jsonb;
begin
	v_answer := public.qorpera_memory_run_resume_record(v_next, v_request);
	perform pg_temp.base_assert(v_answer = jsonb_build_object('schema', 'qorpera.memory-run-resume-record/v1',
		'why', 'restart', 'stepsRead', 3, 'unknownCalls', jsonb_build_array(
			(v_request #> '{unknownCalls,0}') || '{"logicalOperationKey":null}',
			(v_request #> '{unknownCalls,1}') || '{"logicalOperationKey":"resume-operation"}')), 'record enriches only receipt key');
	perform pg_temp.base_assert(public.qorpera_memory_run_resume_record(v_next, v_request) = v_answer, 'same request replays');
	perform pg_temp.base_error(format('select public.qorpera_memory_run_resume_record(%L, %L)', v_next,
		v_request || '{"stepsRead":4}'), '23505', 'Run resume was recorded otherwise');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_memory_run_resumes), 'one observation');
end $$;
savepoint resume_after_append;
update public.qorpera_memory_run_logs set step_count = 4 where run_id = (current_setting('qorpera_test.resume_next')::jsonb ->> 'runId')::uuid;
select pg_temp.base_assert(public.qorpera_memory_run_resume_record(current_setting('qorpera_test.resume_next')::jsonb,
	current_setting('qorpera_test.resume_request')::jsonb) ->> 'stepsRead' = '3', 'replay preserves original read count') \g /dev/null
rollback to savepoint resume_after_append;

-- Another attempt on the same login after a real usage-limit pause records separately with limit_reset. The older
-- receipt stays unknown; it is not lost merely because this attempt had no new open operation.
do $$
declare v_next jsonb := current_setting('qorpera_test.resume_next')::jsonb; v_after jsonb; v_answer jsonb;
begin
	perform public.qorpera_record_provider_usage_signal(v_next, 'usage_limit', clock_timestamp() + interval '1 hour');
	perform public.qorpera_fail_runner_job((v_next ->> 'runnerId')::uuid, repeat('2', 64), (v_next ->> 'jobId')::uuid,
		repeat('3', 64), 'Native provider bridge request failed (429) [usage limit]', false);
	update public.qorpera_runner_jobs set queued_at = statement_timestamp() - interval '1 minute',
		dispatch_deferred_until = statement_timestamp() - interval '1 minute' where id = (v_next ->> 'jobId')::uuid;
	v_after := pg_temp.base_start((v_next ->> 'runId')::uuid);
	perform pg_temp.rc_begin(v_after);
	perform pg_temp.base_assert(public.qorpera_memory_run_resume(v_after) ->> 'why' = 'limit_reset', 'real usage-limit reason');
	v_answer := public.qorpera_memory_run_resume_record(v_after, current_setting('qorpera_test.resume_request')::jsonb);
	perform pg_temp.base_assert(v_answer ->> 'why' = 'limit_reset' and jsonb_array_length(v_answer -> 'unknownCalls') = 2,
		'new attempt keeps both unknown sources');
	perform pg_temp.base_assert((select count(*) = 2 from public.qorpera_memory_run_resumes), 'one row per attempt');
	perform pg_temp.base_error(format('select public.qorpera_memory_run_resume_record(%L, null)', v_next), '42501');
end $$;

set constraints all immediate;
rollback;
