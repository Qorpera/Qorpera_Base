-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 1. The receipts read"

create function pg_temp.rl_id(p_kind integer, p_n integer) returns uuid language sql immutable as $$
	select ('1289' || lpad(p_kind::text, 4, '0') || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.rl_job() returns public.qorpera_runner_jobs language sql as $$
	select * from public.qorpera_runner_jobs where run_id = pg_temp.rr_run()
$$;
create function pg_temp.rl_connection() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
$$;
create function pg_temp.rl_claim() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092',
		extensions.gen_random_uuid(), 120);
end
$$;
create function pg_temp.rl_turned_away(p_binding jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(p_binding, 'rate_limited');
	return pg_temp.rr_fail(p_binding,
		'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]');
end
$$;
create function pg_temp.rl_ready() returns void language plpgsql as $$
begin
	update public.qorpera_runner_jobs set dispatch_deferred_until = clock_timestamp() - interval '1 second',
		queued_at = clock_timestamp() - interval '1 second'
	where id = (pg_temp.rl_job()).id;
end
$$;
create function pg_temp.rl_as_member(p_sql text) returns jsonb language plpgsql as $$
declare v_answer jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_answer;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_answer;
end
$$;
create function pg_temp.rl_activity() returns jsonb language sql as $$
	select row from jsonb_array_elements(pg_temp.rl_as_member(
			'select public.qorpera_list_staff_execution_activity(''92400000-0000-4000-8000-000000000020'')')) as row
	where row ->> 'run_id' = pg_temp.rr_run()::text
$$;
create function pg_temp.rl_recovery() returns jsonb language sql as $$
	select pg_temp.rl_as_member(format('select public.qorpera_get_execution_run_recovery(%L)', pg_temp.rr_run()))
$$;

do $$
declare v_role text;
begin
	perform pg_temp.base_assert((select source_kind from public.qorpera_execution_runs where id = pg_temp.rr_run())
		in ('session_turn', 'room_delivery'), 'the base run is a member''s message');
	perform pg_temp.base_assert((select rate_limit_waits = 5 from public.qorpera_member_rate_limit_settings), 'five waits');
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(
			not has_function_privilege(v_role, 'public.qorpera_rate_limit_wait_until(uuid)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_run_rate_limited(uuid)', 'EXECUTE')
			and not has_function_privilege(v_role, 'public.qorpera_run_had_effect(uuid)', 'EXECUTE')
			and not has_table_privilege(v_role, 'public.qorpera_member_rate_limit_settings', 'UPDATE'),
			'nothing of it is ' || v_role || '''s to call');
	end loop;
end
$$;

savepoint rl_agent_run;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_job uuid := (pg_temp.rl_job()).id;
begin
	perform pg_temp.rr_begin(v_binding);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(v_binding, 'rate_limited');
	perform pg_temp.base_assert(public.qorpera_rate_limit_wait_until(v_job) is not null, 'a member''s message may wait');
	set local session_replication_role = replica;
	update public.qorpera_execution_runs set source_kind = 'wake' where id = pg_temp.rr_run();
	set local session_replication_role = origin;
	perform pg_temp.base_assert(public.qorpera_rate_limit_wait_until(v_job) is null, 'a run no member started never waits');
end
$$;
rollback to savepoint rl_agent_run;

savepoint rl_rollback_switch;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	update public.qorpera_member_rate_limit_settings set rate_limit_waits = 0;
	perform pg_temp.rr_begin(v_binding);
	perform pg_temp.rl_turned_away(v_binding);
	perform pg_temp.base_assert((pg_temp.rl_job()).status = 'failed' and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 0,
		'no waits restores today''s failure');
end
$$;
rollback to savepoint rl_rollback_switch;

savepoint rl_settings_gone;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	delete from public.qorpera_member_rate_limit_settings;
	perform pg_temp.rr_begin(v_binding);
	perform pg_temp.rl_turned_away(v_binding);
	perform pg_temp.base_assert((pg_temp.rl_job()).status = 'failed' and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 0,
		'without its settings row a run fails as before');
end
$$;
rollback to savepoint rl_settings_gone;

do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_job public.qorpera_runner_jobs;
	v_pause jsonb; v_activity jsonb;
begin
	perform pg_temp.rr_begin(v_binding);
	perform pg_temp.base_assert(not public.qorpera_run_had_effect(pg_temp.rr_run()), 'the run has had no effect yet');
	perform pg_temp.rl_turned_away(v_binding);
	v_job := pg_temp.rl_job();
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.attempt_count = 0
		and v_job.dispatch_deferred_until between statement_timestamp() + interval '48 seconds'
			and statement_timestamp() + interval '72 seconds',
		'the member''s message waits about a minute, not spending an attempt: ' || to_jsonb(v_job)::text);
	select payload into strict v_pause from public.qorpera_execution_run_events
	where run_id = pg_temp.rr_run() and event_type = 'run_paused';
	perform pg_temp.base_assert(v_pause ->> 'pausedFor' = 'rate_limited'
		and v_pause ->> 'assignmentId' = v_binding ->> 'assignmentId'
		and (v_pause ->> 'resetsAt')::timestamptz = v_job.dispatch_deferred_until
		and v_pause ->> 'providerConnectionId' = pg_temp.rl_connection()::text,
		'one rate-limit pause on its login: ' || v_pause::text);
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') = 0
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 0, 'nothing waits for review');
	v_activity := pg_temp.rl_activity();
	perform pg_temp.base_assert(v_activity ->> 'paused_for' = 'rate_limited'
		and (v_activity ->> 'paused_until')::timestamptz = v_job.dispatch_deferred_until
		and v_activity -> 'movable' = 'false', 'the activity says it waits for a rate limit: ' || coalesce(v_activity::text, 'none'));
	perform pg_temp.base_assert(public.qorpera_release_paused_runs_with_room(
			(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid) = 0
		and (pg_temp.rl_job()).dispatch_deferred_until = v_job.dispatch_deferred_until,
		'a usage reading with room does not end a rate-limit wait');
end
$$;
select pg_temp.base_error(format('select pg_temp.rl_as_member(%L)', format('select public.qorpera_move_paused_run(%L, %L)',
	pg_temp.rr_run(), pg_temp.rl_connection())), '55000', 'This work is not waiting for a usage limit') \g /dev/null

do $$
declare v_next jsonb;
begin
	perform pg_temp.base_assert(pg_temp.rl_claim() = 'null'::jsonb, 'the run waits out its pause');
	perform pg_temp.rl_ready();
	v_next := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.base_assert(pg_temp.rr_begin(v_next) ->> 'leaseId' = v_next ->> 'leaseId'
		and (select provider_connection_id from public.qorpera_native_provider_connection_leases
			where id = (v_next ->> 'leaseId')::uuid) = pg_temp.rl_connection(), 'the next attempt starts on the same login');
	perform pg_temp.base_assert(pg_temp.rr_read(v_next) ->> 'why' = 'limit_reset'
		and pg_temp.rr_read(v_next) -> 'receipts' = '[]'::jsonb, 'it is told it comes back after a wait, with nothing done');
	perform pg_temp.rr_record(v_next, jsonb_build_object('stepsRead', 0, 'unknownCalls', '[]'::jsonb));
	perform set_config('qorpera_test.rl_next', v_next::text, true);
end
$$;

savepoint rl_effect;
do $$
declare v_next jsonb := current_setting('qorpera_test.rl_next')::jsonb; v_recovery jsonb;
begin
	perform pg_temp.base_public_send(v_next, 'progress', 'rl-ack');
	perform pg_temp.base_assert(public.qorpera_run_had_effect(pg_temp.rr_run()), 'a progress message is an effect');
	perform pg_temp.rl_turned_away(v_next);
	perform pg_temp.base_assert((pg_temp.rl_job()).status = 'failed'
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 1
		and pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') > 0, 'a run with an effect keeps today''s path');
	v_recovery := pg_temp.rl_recovery();
	perform pg_temp.base_assert(v_recovery -> 'rate_limited' = 'true' and v_recovery -> 'usage_limit' = 'false',
		'its recovery says ChatGPT turned it away: ' || v_recovery::text);
end
$$;
rollback to savepoint rl_effect;

do $$
declare v_next jsonb := current_setting('qorpera_test.rl_next')::jsonb; v_job public.qorpera_runner_jobs;
begin
	perform pg_temp.rl_turned_away(v_next);
	v_job := pg_temp.rl_job();
	perform pg_temp.base_assert(v_job.status = 'queued'
		and v_job.dispatch_deferred_until between statement_timestamp() + interval '96 seconds'
			and statement_timestamp() + interval '144 seconds'
		and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 2,
		'the second wait is about two minutes: ' || to_jsonb(v_job)::text);
end
$$;

do $$
declare v_next jsonb; v_recovery jsonb;
begin
	update public.qorpera_member_rate_limit_settings set rate_limit_waits = 2;
	perform pg_temp.rl_ready();
	v_next := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.rr_begin(v_next);
	perform pg_temp.rl_turned_away(v_next);
	perform pg_temp.base_assert((pg_temp.rl_job()).status = 'failed' and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 2
		and pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') > 0, 'after its last wait the run fails as today');
	v_recovery := pg_temp.rl_recovery();
	perform pg_temp.base_assert(v_recovery -> 'rate_limited' = 'true' and v_recovery -> 'usage_limit' = 'false',
		'its recovery says ChatGPT turned it away: ' || v_recovery::text);
end
$$;

set constraints all immediate;
rollback;
