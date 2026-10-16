-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- No agent receives a member-machine capability (launch checklist L16.1; contract section 21 item 16: "no agent
-- receives a member-machine capability"; "Qorpera has no member-machine agent tool in the launch kernel"). The owner
-- registers their own machine as a runner of the company, as the old local runner flow did, and the runner-control
-- function activates it with its token: an active 'local' runner. No call a member can make claims, assigns or
-- describes work for it; Qorpera's provisioning does not adopt it; and the database refuses to assign it a run of an
-- agent, whether the run carries its compute identity or (as no folder path makes one) not. The last refusal is
-- 20260930490000's: before it, the assignment guard checked nothing for a run with no compute identity.

-- The owner's own machine, registered and activated as a runner of the company.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.member_runner', public.qorpera_create_runner_registration('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000070', 'Owner laptop', '["agent_turn"]', 1, repeat('4', 64))::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select public.qorpera_activate_runner((current_setting('qorpera_test.member_runner')::jsonb ->> 'runner_id')::uuid, repeat('4', 64),
	repeat('5', 64), 'macos', 'member-machine') \g /dev/null
reset role;

-- 1. The machine is an active runner of the company, of the 'local' kind, with no compute identity.
do $$
declare v_runner public.qorpera_runners;
begin
	select * into strict v_runner from public.qorpera_runners
	where id = (current_setting('qorpera_test.member_runner')::jsonb ->> 'runner_id')::uuid;
	perform pg_temp.base_assert(v_runner.runner_kind = 'local' and v_runner.status = 'active'
		and v_runner.profile_id = '92400000-0000-4000-8000-000000000010' and v_runner.compute_identity_id is null
		and v_runner.registered_by_user_id = '92400000-0000-4000-8000-000000000001',
		'fixture: the owner''s machine is an active local runner: ' || to_jsonb(v_runner)::text);
end
$$;

-- 2. No call a member can make claims, assigns, provisions or describes work: each is refused to the member's own login,
--    the runner's self-claim is refused to every role, and the folder broker's description has no caller.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_runner uuid := (current_setting('qorpera_test.member_runner')::jsonb ->> 'runner_id')::uuid;
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	perform pg_temp.base_error(format('select public.qorpera_claim_runner_job(%L, %L, %L, %L)', v_runner, repeat('5', 64),
		extensions.gen_random_uuid(), repeat('6', 64)), '42501');
	perform pg_temp.base_error(format('select public.qorpera_claim_runner_job_for_orchestrator(%L, %L, 120)',
		'92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid()), '42501');
	perform pg_temp.base_error(format('select public.qorpera_assign_runner_job(%L, %L, %L, %L, %L, 120)',
		'92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), v_runner, extensions.gen_random_uuid(), repeat('3', 64)),
		'42501', 'runner assignment is invalid');
	perform pg_temp.base_error(format('select public.qorpera_provision_execution_runner(%L, %L, %L, %L)', v_binding ->> 'runId',
		'92400000-0000-4000-8000-000000000070', 'process', repeat('4', 64)), '42501');
	perform pg_temp.base_error(format('select public.qorpera_activate_runner(%L, %L, %L, %L, %L)', v_runner, repeat('4', 64),
		repeat('7', 64), 'macos', 'member-machine'), '42501', 'runner activation is invalid');
end
$$;
reset role;
do $$
begin
	perform pg_temp.base_assert(not has_function_privilege('service_role',
		'public.qorpera_claim_runner_job(uuid,text,uuid,text)', 'execute'), 'the runner self-claim is closed to the node host');
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_folder_runner_broker_describe(uuid,text,uuid,text)', 'execute'),
		'the folder broker description has no caller');
end
$$;

-- A second run: the owner's post in Bob's thread, claimed by the real orchestrator.
select pg_temp.base_claims('service_role');
do $$
declare v_wakes jsonb := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
	'Draft the weekly note.'); v_pass jsonb := pg_temp.base_materialize(); v_claim jsonb;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_wakes) = 1 and v_pass ->> 'state' = 'done'
		and jsonb_array_length(v_pass -> 'run_ids') = 1, 'fixture: Bob''s run: ' || v_pass::text);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_runner_job_for_orchestrator('92400000-0000-4000-8000-000000000092', extensions.gen_random_uuid(), 120);
	perform pg_temp.base_assert(v_claim #>> '{work,run_id}' = v_pass -> 'run_ids' ->> 0, 'fixture: Bob''s run is claimed: '
		|| coalesce(v_claim::text, 'none'));
	perform pg_temp.base_assert((select compute_identity_id from public.qorpera_execution_runs where id = (v_claim #>> '{work,run_id}')::uuid)
		= (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,
		'fixture: Bob''s run carries the owner''s compute identity');
	perform set_config('qorpera_test.member_claim', v_claim::text, true);
end
$$;

-- 3. Even the node host cannot hand the run to the member's machine: Qorpera's provisioning does not adopt the
--    machine's registration, and the assignment is refused, before and after the run loses its compute identity.
create function pg_temp.mm_assign() returns text language sql as $$
	select format('select public.qorpera_assign_runner_job(%L, %L, %L, %L, %L, 120)', '92400000-0000-4000-8000-000000000092',
		current_setting('qorpera_test.member_claim')::jsonb ->> 'claim_id', current_setting('qorpera_test.member_runner')::jsonb ->> 'runner_id',
		extensions.gen_random_uuid(), repeat('3', 64))
$$;
create function pg_temp.mm_provision(p_client uuid) returns text language sql as $$
	select format('select public.qorpera_provision_execution_runner(%L, %L, %L, %L)',
		current_setting('qorpera_test.member_claim')::jsonb #>> '{work,run_id}', p_client, 'process', repeat('4', 64))
$$;
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error(pg_temp.mm_provision('92400000-0000-4000-8000-000000000070'), '23505',
	'runner client id is already bound to other compute authority');
select pg_temp.base_error(pg_temp.mm_assign(), '42501', 'runner does not attest the execution compute identity');
reset role;
-- A run without a compute identity, which no folder path makes (the materializer cancels a wake without one): the
-- fixture clears it on Bob's run, skipping the triggers for this one row.
set local session_replication_role = replica;
update public.qorpera_execution_runs set compute_identity_id = null
where id = (current_setting('qorpera_test.member_claim')::jsonb #>> '{work,run_id}')::uuid;
set local session_replication_role = origin;
set local role service_role;
select pg_temp.base_error(pg_temp.mm_provision(extensions.gen_random_uuid()), '42501', 'execution compute authority is unavailable');
select pg_temp.base_error(pg_temp.mm_assign(), '42501', 'runner does not attest the execution compute identity');
reset role;

-- 4. No run of the company was ever assigned to a runner that is not a Qorpera computer.
do $$
begin
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_runner_assignments assignment
		join public.qorpera_runners runner on runner.id = assignment.runner_id
		where runner.profile_id = '92400000-0000-4000-8000-000000000010' and runner.runner_kind <> 'qorpera_computer'),
		'no assignment names a member''s machine');
end
$$;

rollback;
