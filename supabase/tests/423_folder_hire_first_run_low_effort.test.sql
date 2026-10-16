-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A hire's first run starts at low effort (launch checklist L04.1; contract section 21 item 4: "starts on the resolved
-- low-effort thread policy"). The owner hires Dana through Dana's agent.md, with no effort named, as the product writes
-- it; the follow-up queue queues the kickoff and one materializer pass makes it a run. The run is pinned to the active
-- runtime bundle at that bundle's default effort, low, with the hash of the bundle's model policy, and the runner's
-- authority reads the same; an effort chosen in another conversation does not carry over; the pin cannot change later;
-- a second pass makes no second run.

-- The owner chose high effort in Alice's thread: a choice of that conversation only.
insert into public.qorpera_session_models(session_id, reasoning_effort, version, updated_by_user_id)
select room.session_id, 'high', 1, '92400000-0000-4000-8000-000000000001' from public.qorpera_company_rooms room
where room.id = pg_temp.base_thread('92400000-0000-4000-8000-000000000030');

select pg_temp.base_commit(pg_temp.base_owner(), 'first-run-effort-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null

-- 1. The first run: the kickoff's first-run wake, pinned at the active bundle's default effort, low.
do $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run public.qorpera_execution_runs; v_wake public.qorpera_wake_occurrences;
	v_bundle public.qorpera_runtime_bundles; v_policy text; v_identity jsonb;
begin
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1,
		'Dana''s first run: ' || v_pass::text);
	select * into strict v_run from public.qorpera_execution_runs where id = (v_pass -> 'run_ids' ->> 0)::uuid;
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	perform pg_temp.base_assert(v_wake.wake_kind = 'first-run' and v_wake.staff_agent_id = '92400000-0000-4000-8000-000000000034'
		and v_wake.source_id = (select input_id from public.qorpera_agent_first_runs
			where profile_id = '92400000-0000-4000-8000-000000000010' and staff_agent_id = '92400000-0000-4000-8000-000000000034'),
		'the run is the kickoff''s first-run wake: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(v_run.session_id = (select session_id from public.qorpera_company_rooms
		where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000034'))
		and not exists (select 1 from public.qorpera_session_models where session_id = v_run.session_id),
		'the run is in Dana''s new thread, which has no chosen effort');
	select bundle.* into strict v_bundle from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id where active.singleton;
	perform pg_temp.base_assert(v_bundle.manifest #>> '{modelPolicy,effort}' = 'low', 'fixture: the active bundle''s default effort is low');
	v_policy := encode(extensions.digest(convert_to((v_bundle.manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex');
	perform pg_temp.base_assert(v_run.runtime_bundle_id = v_bundle.id and v_run.runtime_bundle_sha256 = v_bundle.sha256
		and v_run.reasoning_effort = 'low' and v_run.reasoning_policy_sha256 = v_policy,
		'the first run is pinned to the active bundle at low effort: ' || jsonb_build_object('bundle', v_run.runtime_bundle_id,
			'effort', v_run.reasoning_effort, 'policy', v_run.reasoning_policy_sha256)::text);
	-- The runner reads the same pin from its authority once the run holds its lease.
	v_identity := public.qorpera_describe_native_tool_authority(pg_temp.base_start(v_run.id)) -> 'identity';
	perform pg_temp.base_assert(v_identity ->> 'runId' = v_run.id::text and v_identity ->> 'reasoningEffort' = 'low'
		and v_identity ->> 'reasoningPolicySha256' = v_policy, 'the runner reads low effort: ' || v_identity::text);
	perform set_config('qorpera_test.first_run', v_run.id::text, true);
end
$$;

-- 2. The pin cannot change after the run is made, and a second pass makes no second run for the hire.
do $$
declare v_run uuid := current_setting('qorpera_test.first_run')::uuid; v_session uuid;
begin
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set reasoning_effort = %L where id = %L', 'high', v_run),
		'42501', 'Execution reasoning policy is immutable');
	perform pg_temp.base_error(format('update public.qorpera_execution_runs set reasoning_policy_sha256 = %L where id = %L',
		repeat('0', 64), v_run), '42501', 'Execution reasoning policy is immutable');
	perform pg_temp.base_materialize();
	select session_id into strict v_session from public.qorpera_execution_runs where id = v_run;
	perform pg_temp.base_assert((select count(*) from public.qorpera_execution_runs where session_id = v_session) = 1
		and (select count(*) from public.qorpera_wake_occurrences where staff_agent_id = '92400000-0000-4000-8000-000000000034') = 1,
		'one run and one wake for the hire');
	perform pg_temp.base_assert((select reasoning_effort from public.qorpera_execution_runs where id = v_run) = 'low',
		'the first run stays low');
end
$$;

rollback;
