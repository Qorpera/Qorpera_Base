-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A run a member stopped is not a failure, on folder-v2 (ported from snapshot-v1 in the legacy sweep; 20260926192436).
-- The agent activity list keeps one run per agent and ranks an undismissed failure above work, so a stopped message used
-- to stand for the agent as failed and hid the run it was still working on (and with it the composer's Stop). Now a
-- stopped run drops out: a stopped post or member turn never hides the agent's working run, a failure still does, and
-- once every run is stopped the agent is idle. The runs are real: Bob's routine run, started on a real runner with a
-- native lease, the contributor's posts in his thread and the owner's start of his first run, each made a run by the
-- folder materializer. (The snapshot-v1 cases of a stop that left a Company File proposal go with the proposals.)

-- The contributor's own native login and member sponsor, as the base makes the owner's: a post spends only the
-- poster's own login. Answers the sponsor's binding.
create function pg_temp.ss_member_binding() returns uuid language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_identity jsonb; v_login jsonb; v_connection jsonb;
	v_sponsor jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity('92400000-0000-4000-8000-000000000010',
		'58600000-0000-4000-8000-000000000050', 'Member identity', 'qorpera-member-linux', 'v1', '["agent_turn"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login('92400000-0000-4000-8000-000000000010',
		'58600000-0000-4000-8000-000000000051', '58600000-0000-4000-8000-000000000052',
		(v_identity ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('c', 64), 900);
	reset role;
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat('c', 64),
		'58600000-0000-4000-8000-000000000060', 'object://native-capsules/58600000-0000-4000-8000-000000000060', repeat('d', 64),
		'fixture-member-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
	set local role authenticated;
	v_sponsor := public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
		'58600000-0000-4000-8000-000000000061', (v_connection ->> 'connection_id')::uuid, 1, false);
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return (v_sponsor ->> 'binding_id')::uuid;
end $$;
-- An agent's thread conversation.
create function pg_temp.ss_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '92400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
-- A routine's parse as the TS parser returns it (as 708 writes one).
create function pg_temp.ss_routine_parse(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', 'Tick', 'status', 'active',
		'trigger', jsonb_build_object('when', 'every', 'minutes', 60, 'starts', null), 'timezone', null, 'ends', null, 'runs', null,
		'quiet', null, 'effort', 'low', 'reply', 'required', 'conclusion', null, 'instructions', 'Examine the authorized change.')
$$;
-- The contributor's post in Bob's thread, made a run by one materializer pass; answers the run.
create function pg_temp.ss_post(p_text text) returns uuid language plpgsql as $$
declare v_pass jsonb;
begin
	perform pg_temp.base_post('92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000031', p_text,
		current_setting('qorpera_test.ss_member_binding')::uuid);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1 and (select run.source_kind = 'room_delivery'
		and run.session_id = current_setting('qorpera_test.ss_thread')::uuid and job.status = 'queued'
		and job.created_by_user_id = '92400000-0000-4000-8000-000000000002'
		from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = (v_pass -> 'run_ids' ->> 0)::uuid), 'Fixture: the post is a queued run in Bob''s thread: ' || v_pass::text);
	return (v_pass -> 'run_ids' ->> 0)::uuid;
end $$;
create function pg_temp.ss_job(p_run uuid) returns uuid language sql security definer as $$
	select job_id from public.qorpera_execution_runs where id = p_run
$$;
-- What a member sees of Bob: his one activity row, or null when he is idle.
create function pg_temp.ss_bob() returns jsonb language sql as $$
	select entry - 'updated_at' - 'phase' - 'staff_agent_id'
	from jsonb_array_elements(public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020')) entry
	where entry ->> 'staff_agent_id' = '92400000-0000-4000-8000-000000000031'
$$;
create function pg_temp.ss_row(p_run text, p_kind text, p_status text, p_activity text) returns jsonb language sql as $$
	select jsonb_build_object('run_id', p_run, 'source_kind', p_kind, 'job_status', p_status, 'activity', p_activity)
$$;

-- Bob's routine, saved by the owner in his folder: the scheduler queues its slot into his thread, and its run is working.
select pg_temp.base_commit(pg_temp.base_owner(), 'ss-routine-0001', jsonb_build_array(pg_temp.base_write('agents/bob/routines/tick.md',
	'routine', E'---\n' || pg_temp.ss_routine_parse('58600000-0000-4000-8000-0000000000e1')::text || E'\n---\n',
	pg_temp.ss_routine_parse('58600000-0000-4000-8000-0000000000e1')))) \g /dev/null
do $$
declare v_slot timestamptz := clock_timestamp(); v_enqueued jsonb; v_run uuid;
begin
	perform set_config('qorpera_test.ss_thread', pg_temp.ss_session('92400000-0000-4000-8000-000000000031')::text, true);
	perform pg_temp.base_claims('service_role');
	v_enqueued := public.qorpera_enqueue_routine_wake('58600000-0000-4000-8000-0000000000e1', 1, '58600000-0000-4000-8000-0000000000f1',
		'ss-1', 'file', v_slot, null, v_slot + interval '1 hour');
	perform pg_temp.base_assert(v_enqueued ->> 'status' = 'queued', 'Fixture: the routine''s slot is queued: ' || v_enqueued::text);
	perform pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where id = '58600000-0000-4000-8000-0000000000f1' and status = 'materialized' and session_id = current_setting('qorpera_test.ss_thread')::uuid;
	perform pg_temp.base_start(v_run);
	perform set_config('qorpera_test.ss_routine_run', v_run::text, true);
end $$;
select set_config('qorpera_test.ss_member_binding', pg_temp.ss_member_binding()::text, true) \g /dev/null
select pg_temp.base_claims('service_role');

-- 1. The list is still the members' read only; the patch kept its grants.
select pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute')
	and not exists (select 1 from pg_proc, aclexplode(proacl) acl
		where pg_proc.oid = 'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure and acl.grantee = 0),
	'The activity list keeps its grants');

-- 2. The reported case: while the routine run works, the contributor posts in Bob's thread and stops their own message.
select set_config('qorpera_test.ss_post', pg_temp.ss_post('Also check the invoices.')::text, true) \g /dev/null
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.base_assert(public.qorpera_cancel_runner_job(pg_temp.ss_job(current_setting('qorpera_test.ss_post')::uuid))
	->> 'status' = 'cancelled', 'The contributor stops their own message');
reset role;
select pg_temp.base_assert((select cancelled_by_user_id = '92400000-0000-4000-8000-000000000002' from public.qorpera_runner_jobs
	where run_id = current_setting('qorpera_test.ss_post')::uuid), 'Fixture: the Stop records the member');
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.base_assert(pg_temp.ss_bob() = pg_temp.ss_row(current_setting('qorpera_test.ss_routine_run'), 'wake', 'leased', 'working'),
	'A stopped message does not hide the run the agent is working on');
select pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(
	public.qorpera_list_staff_execution_activity('92400000-0000-4000-8000-000000000020')) entry
	where entry ->> 'run_id' = current_setting('qorpera_test.ss_post')), 'The stopped message is not listed at all');
reset role;

-- 3. A failure still stands for the agent above its work until it is dismissed.
savepoint ss_failure;
select set_config('qorpera_test.ss_failed', pg_temp.ss_post('And the receipts.')::text, true) \g /dev/null
update public.qorpera_runner_jobs set status = 'failed', finished_at = statement_timestamp(),
	last_error = 'Runner lease expired before durable completion'
where run_id = current_setting('qorpera_test.ss_failed')::uuid;
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(pg_temp.ss_bob() = pg_temp.ss_row(current_setting('qorpera_test.ss_failed'), 'room_delivery', 'failed',
	'needs_attention'), 'A failed message still reads as a failure above live work');
reset role;
rollback to savepoint ss_failure;

-- 4. The same for a member turn: the owner starts Bob's first run (a turn in his thread) and stops it there.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.ss_first', public.qorpera_start_agent_first_run('92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000031')::text, true) \g /dev/null
reset role;
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid := (v_pass -> 'run_ids' ->> 0)::uuid;
begin
	perform pg_temp.base_assert(current_setting('qorpera_test.ss_first')::jsonb ->> 'state' = 'started'
		and jsonb_array_length(v_pass -> 'run_ids') = 1 and (select run.source_kind = 'session_turn'
			and run.session_id = current_setting('qorpera_test.ss_thread')::uuid and job.status = 'queued'
			and job.created_by_user_id = '92400000-0000-4000-8000-000000000001'
			from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id where run.id = v_run),
		'Fixture: the first run is the owner''s queued turn in Bob''s thread: ' || v_pass::text);
	perform set_config('qorpera_test.ss_turn', v_run::text, true);
end $$;
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_cancel_session_run(current_setting('qorpera_test.ss_thread')::uuid,
	current_setting('qorpera_test.ss_turn')::uuid) ->> 'status' = 'cancelled', 'The owner stops their own turn');
select pg_temp.base_assert(pg_temp.ss_bob() = pg_temp.ss_row(current_setting('qorpera_test.ss_routine_run'), 'wake', 'leased', 'working'),
	'A stopped member turn does not hide the run the agent is working on');

-- 5. The owner stops the routine run too: with every run stopped, Bob is idle, and the routine's occurrence ended
--    cancelled.
select pg_temp.base_assert(public.qorpera_cancel_runner_job(pg_temp.ss_job(current_setting('qorpera_test.ss_routine_run')::uuid))
	->> 'status' = 'cancelled', 'The owner stops the routine run');
select pg_temp.base_assert(pg_temp.ss_bob() is null, 'With every run stopped, Bob is idle');
reset role;
select pg_temp.base_assert((select status = 'cancelled' from public.qorpera_wake_occurrences where id = '58600000-0000-4000-8000-0000000000f1'),
	'Fixture: the stopped routine occurrence ended cancelled');

rollback;
