-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 3. Today's path"
-- 20260930703000: a run in Agent notebooks mode waits at its login's usage limit, on the same login, and goes on from its
-- receipts; the member whose login pays may move it to another of their logins, and it goes on there at once.
-- Test 466's run of Alice's (the owner's post in her thread) is in Agent notebooks mode with no log: it started, completed
-- two steps and began a third. Its login reaches its usage limit. Before, the run ended there and waited for review; now
-- it pauses until the reset, the open step's outcome unknown, and the agents' activity says so. Only the owner, whose login
-- pays, may move it, only to another login of theirs that can pay now; the run, its wake and its reservation move together,
-- the move is recorded, and the next attempt starts at once on the chosen login and goes on from the run's receipts. The
-- old login's release never brings it back. A worker's notice whose run stopped says so.

create function pg_temp.np_job() returns public.qorpera_runner_jobs language sql as $$
	select * from public.qorpera_runner_jobs where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid
$$;
create function pg_temp.np_move(p_user uuid, p_connection uuid) returns jsonb language plpgsql as $$
declare v_answer jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_answer := public.qorpera_move_paused_run(pg_temp.rr_run(), p_connection);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_answer;
end
$$;
-- Alice's row of the agents' activity, as a member reads it.
create function pg_temp.np_activity(p_user uuid) returns jsonb language plpgsql as $$
declare v_rows jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v_rows := public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020');
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return (select row from jsonb_array_elements(v_rows) as row
		where row ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000030' and row ->> 'run_id' = pg_temp.rr_run()::text);
end
$$;

-- The checks start here.

-- 1. The usage limit: the run pauses on its login until the reset, instead of failing and waiting for review.
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_reset timestamptz := clock_timestamp() + interval '30 hours';
	v_job public.qorpera_runner_jobs; v_pause jsonb;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_record_provider_usage_signal(v_binding, 'usage_limit', v_reset);
	perform pg_temp.rr_fail(v_binding, 'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]');
	v_job := pg_temp.np_job();
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.attempt_count = 0
		and v_job.dispatch_deferred_until between v_reset - interval '1 second' and v_reset + interval '1 second',
		'the run waits for the reset: ' || to_jsonb(v_job)::text);
	select payload into strict v_pause from public.qorpera_execution_run_events where run_id = pg_temp.rr_run() and event_type = 'run_paused';
	perform pg_temp.base_assert(v_pause ->> 'assignmentId' = v_binding ->> 'assignmentId'
		and v_pause ->> 'providerConnectionId' = current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id',
		'one pause names the attempt and its own login: ' || v_pause::text);
	perform pg_temp.base_assert(pg_temp.rr_events(pg_temp.rr_run(), 'run_cut_off') = 0
		and pg_temp.rr_events(pg_temp.rr_run(), 'review_pending') = 0
		and not exists (select 1 from public.qorpera_wake_occurrences where run_id = pg_temp.rr_run() and status = 'requires_review'),
		'nothing waits for review');
	perform pg_temp.base_assert((select array_agg(status order by created_at) from public.qorpera_run_operation_receipts
		where run_id = pg_temp.rr_run()) = array['completed', 'completed', 'outcome_unknown'], 'the open step''s outcome is unknown');
	perform pg_temp.base_assert(public.qorpera_run_usage_pause(pg_temp.rr_run()) = v_job.dispatch_deferred_until, 'the pause is in force');
end
$$;

-- 2. Every member who reads the company sees that Alice waits, until when, and whose login pays.
do $$
declare v_row jsonb; v_user uuid;
begin
	foreach v_user in array array['92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000003']::uuid[] loop
		v_row := pg_temp.np_activity(v_user);
		perform pg_temp.base_assert(v_row ->> 'job_status' = 'queued'
			and (v_row ->> 'paused_until')::timestamptz = (pg_temp.np_job()).dispatch_deferred_until
			and v_row ->> 'sponsor_binding_id' = current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id'
			and v_row ->> 'requested_by_user_id' = '92400000-0000-4000-8000-000000000001'
			and v_row -> 'paid_by_chatgpt_plan' = 'false' and v_row -> 'paid_while_away' = 'true' and v_row -> 'movable' = 'true',
			'the activity says the run waits: ' || coalesce(v_row::text, 'none'));
	end loop;
	perform pg_temp.base_assert(not has_function_privilege('authenticated', 'public.qorpera_run_usage_pause(uuid)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_run_usage_pause_json(uuid)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_move_paused_run(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_move_paused_run(uuid,uuid)', 'EXECUTE')
		and not has_table_privilege('authenticated', 'public.qorpera_execution_run_payer_moves', 'SELECT'),
		'only the move is a member''s call');
end
$$;

-- A run that no longer resumes (made narrow by its machine) waits, but is not to be moved: the activity says so.
savepoint np_narrow;
create or replace function public.qorpera_memory_run_machine_narrow(p_environment_id uuid, p_run_id uuid)
returns boolean language sql stable set search_path = '' as $$ select true $$;
select pg_temp.base_assert(pg_temp.np_activity('92400000-0000-4000-8000-000000000001') -> 'movable' = 'false',
	'a narrow run is not movable') \g /dev/null
rollback to savepoint np_narrow;

-- 3. The owner's second login, signed in as the first was and consented for unattended work, with its own sponsor.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.np_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000119451', '92400000-0000-4000-8000-000000119452',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('d', 64), 900)::text,
	true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.np_connection', public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.np_login')::jsonb ->> 'login_id')::uuid, repeat('d', 64), '92400000-0000-4000-8000-000000119460',
	'object://native-capsules/92400000-0000-4000-8000-000000119460', repeat('e', 64), 'fixture-openai-account-two',
	'personal-subscription', 'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,
	true) \g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.np_sponsor', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000119461',
	(current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id')::uuid, 2, true)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

-- 4. Refusals. Another member, a viewer and an outsider may not move it; nor may the owner to the login that pays, to an
--    unknown login, or to a login at its usage limit; a ChatGPT plan's run is never moved; a run that no longer waits is
--    not moved. Nothing changes.
do $$
declare v_second uuid := (current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id')::uuid;
	v_first uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid; v_user uuid;
begin
	foreach v_user in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000004']::uuid[] loop
		perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', v_user, v_second), '42501',
			'Only the member whose login pays for this work can move it');
	end loop;
	foreach v_user in array array['92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000005']::uuid[] loop
		perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', v_user, v_second), '42501', 'Waiting work is unavailable');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', '92400000-0000-4000-8000-000000000001', v_first), '22023',
		'This login cannot pay for this work now');
	perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', '92400000-0000-4000-8000-000000000001',
		extensions.gen_random_uuid()), '22023', 'This login cannot pay for this work now');
	perform pg_temp.base_assert((select sponsor_binding_id::text from public.qorpera_execution_runs where id = pg_temp.rr_run())
		= current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id'
		and not exists (select 1 from public.qorpera_execution_run_payer_moves), 'nothing moved');
end
$$;
savepoint np_limit;
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_second uuid := (current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id')::uuid;
begin
	-- The second login reaches its limit too (a run of its own recorded it).
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source, resets_at, assignment_id)
	select run.profile_id, run.id, run.job_id, run.sponsor_binding_id, run.sponsor_version, v_second, 2, 'openai', 'usage_limit',
		'native_adapter', clock_timestamp() + interval '2 hours', extensions.gen_random_uuid()
	from public.qorpera_execution_runs as run where run.id = pg_temp.rr_run();
	perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', '92400000-0000-4000-8000-000000000001', v_second), '22023',
		'This login cannot pay for this work now');
end
$$;
rollback to savepoint np_limit;
savepoint np_plan;
create or replace function public.qorpera_connection_is_chatgpt_plan(p_connection_id uuid)
returns boolean language sql stable set search_path = '' as $$ select true $$;
select pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', '92400000-0000-4000-8000-000000000001',
	current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id'), '22023', 'This login cannot pay for this work now')
\g /dev/null
rollback to savepoint np_plan;
savepoint np_released;
do $$
begin
	-- The reset came (a reading showed room): the run no longer waits, so there is nothing to move.
	update public.qorpera_runner_jobs set dispatch_deferred_until = clock_timestamp(), queued_at = clock_timestamp()
	where id = (pg_temp.np_job()).id;
	perform pg_temp.base_assert(public.qorpera_run_usage_pause(pg_temp.rr_run()) is null
		and pg_temp.np_activity('92400000-0000-4000-8000-000000000001') ->> 'paused_until' is null, 'a released run no longer waits');
	perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', '92400000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id'), '55000', 'This work is not waiting for a usage limit');
end
$$;
rollback to savepoint np_released;

-- The wake's identity stays immutable without a recorded move of this transaction.
savepoint np_wake;
select pg_temp.base_error(format('update public.qorpera_wake_occurrences set sponsor_binding_id = %L, sponsor_version = 1 where run_id = %L',
	current_setting('qorpera_test.np_sponsor')::jsonb ->> 'binding_id', pg_temp.rr_run()), '42501', 'Admitted wake identity is immutable')
\g /dev/null
rollback to savepoint np_wake;

-- 5. The owner moves it to their second login: the run, its wake and its reservation pay with it, the move is recorded,
--    the pause names the new login and ends now.
do $$
declare v_second uuid := (current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id')::uuid;
	v_to_binding uuid := (current_setting('qorpera_test.np_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_answer jsonb; v_pause jsonb; v_run public.qorpera_execution_runs;
begin
	v_answer := pg_temp.np_move('92400000-0000-4000-8000-000000000001', v_second);
	perform pg_temp.base_assert(v_answer = jsonb_build_object('schema', 'qorpera.paused-run-move/v1', 'runId', pg_temp.rr_run(),
		'connectionId', v_second), 'the move answers: ' || v_answer::text);
	select * into strict v_run from public.qorpera_execution_runs where id = pg_temp.rr_run();
	perform pg_temp.base_assert(v_run.sponsor_binding_id = v_to_binding
		and exists (select 1 from public.qorpera_wake_occurrences where run_id = v_run.id
			and sponsor_binding_id = v_run.sponsor_binding_id and sponsor_version = v_run.sponsor_version)
		and exists (select 1 from public.qorpera_execution_sponsor_reservations where run_id = v_run.id
			and binding_id = v_to_binding and provider_connection_id = v_second and status = 'reserved'),
		'the run, its wake and its reservation pay with the second login');
	perform pg_temp.base_assert((select count(*) = 1 and bool_and(moved_by_user_id = '92400000-0000-4000-8000-000000000001'
			and from_connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
			and to_connection_id = v_second and to_binding_id = v_to_binding)
		from public.qorpera_execution_run_payer_moves where run_id = v_run.id), 'the move is recorded');
	select payload into strict v_pause from public.qorpera_execution_run_events where run_id = v_run.id and event_type = 'run_paused'
	order by id desc limit 1;
	perform pg_temp.base_assert(v_pause ->> 'providerConnectionId' = v_second::text
		and (v_pause ->> 'sponsorVersion')::bigint = v_run.sponsor_version
		and v_pause ->> 'assignmentId' = current_setting('qorpera_test.base_binding')::jsonb ->> 'assignmentId'
		and (pg_temp.np_job()).dispatch_deferred_until <= clock_timestamp()
		and public.qorpera_run_usage_pause(v_run.id) is null
		and pg_temp.np_activity('92400000-0000-4000-8000-000000000001') ->> 'paused_until' is null,
		'the pause names the second login and ends now: ' || v_pause::text);
	-- A second move finds nothing waiting.
	perform pg_temp.base_error(format('select pg_temp.np_move(%L, %L)', '92400000-0000-4000-8000-000000000001',
		current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'), '55000', 'This work is not waiting for a usage limit');
end
$$;

-- 6. The next attempt starts at once on the second login, is told the run's receipts as a resume after the limit, and goes
--    on: a completed step replays, a new one runs.
do $$
declare v_next jsonb := pg_temp.base_start(pg_temp.rr_run()); v_read jsonb; v_receipt uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.base_assert(v_next ->> 'runId' = pg_temp.rr_run()::text
		and (select provider_connection_id::text from public.qorpera_native_provider_connection_leases where id = (v_next ->> 'leaseId')::uuid)
			= current_setting('qorpera_test.np_connection')::jsonb ->> 'connection_id', 'the next attempt holds the second login');
	perform pg_temp.base_assert(pg_temp.rr_begin(v_next) ->> 'leaseId' = v_next ->> 'leaseId', 'the next attempt starts');
	v_read := pg_temp.rr_read(v_next);
	perform pg_temp.base_assert(v_read ->> 'why' = 'limit_reset'
		and (select array_agg((r ->> 'logicalOperationKey') || ':' || (r ->> 'status') order by n)
			from jsonb_array_elements(v_read -> 'receipts') with ordinality as e(r, n))
			= array['g1b-step-a:completed', 'g1b-step-o:completed', 'g1b-step-b:outcome_unknown'],
		'it is told the run''s receipts: ' || v_read::text);
	perform pg_temp.rr_record(v_next, jsonb_build_object('stepsRead', 0, 'unknownCalls', jsonb_build_array(
		jsonb_build_object('call', null, 'step', null, 'receiptId', current_setting('qorpera_test.rr_b')))));
	perform pg_temp.base_assert(pg_temp.rr_step(v_next, extensions.gen_random_uuid(), 'g1b-step-a') ->> 'state' = 'completed',
		'a completed step replays');
	perform pg_temp.base_assert(pg_temp.rr_step(v_next, v_receipt, 'g1b-step-c') ->> 'state' = 'executing', 'a new step begins');
	perform set_config('qorpera_test.np_next', v_next::text, true);
end
$$;

-- 7. The first login's release never brings it back: it is no longer that login's work.
do $$
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(public.qorpera_release_paused_runs_with_room(
		(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid) = 0
		and (pg_temp.np_job()).status = 'leased', 'the release finds nothing of it');
end
$$;

-- 8. The usage-limit notice of section 1 says whether its run stopped: this one goes on; a run that ended says so. No other
--    notice says it.
do $$
declare v_list jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_list := public.qorpera_list_member_notifications('92400000-0000-4000-8000-000000000010', 50);
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v_list) as item
			where item ->> 'kind' = 'provider_usage_limit' and item #>> '{subject,runId}' = pg_temp.rr_run()::text)
		and (select bool_and(item -> 'run_stopped' = 'false') from jsonb_array_elements(v_list) as item
			where item ->> 'kind' = 'provider_usage_limit'), 'a run that goes on did not stop: ' || v_list::text);
	perform pg_temp.base_claims('service_role');
end
$$;
savepoint np_stopped;
-- The resumed attempt is refused for another reason: the run ends.
select pg_temp.rr_fail(current_setting('qorpera_test.np_next')::jsonb, 'Native provider bridge request failed (422)') \g /dev/null
select pg_temp.base_assert((pg_temp.np_job()).status = 'failed', 'the run ended') \g /dev/null
do $$
declare v_list jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	v_list := public.qorpera_list_member_notifications('92400000-0000-4000-8000-000000000010', 50);
	perform pg_temp.base_assert((select bool_and(item -> 'run_stopped' = 'true') from jsonb_array_elements(v_list) as item
		where item ->> 'kind' = 'provider_usage_limit'), 'a run that ended says so: ' || v_list::text);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_list) as item
		where item ->> 'kind' <> 'provider_usage_limit' and item ? 'run_stopped'), 'only a usage-limit notice says it');
	perform pg_temp.base_claims('service_role');
end
$$;
rollback to savepoint np_stopped;

set constraints all immediate;
rollback;
