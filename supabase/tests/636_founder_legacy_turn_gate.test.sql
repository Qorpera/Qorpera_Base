-- @fixture 310_company_organization_kernel.test.sql until "-- A coworker is created, archived"
-- A real canonical kickoff must remain untouched if an older desktop client
-- tries to claim it before Ready/Start. The multiplayer launch and runtime provenance are exercised separately in632.
reset role;
select set_config('qorpera_test.unlaunched_kickoff',(
    select jsonb_build_object('input',to_jsonb(input),'snapshotId',file.head_snapshot_id,
        'staffVersion',staff.version)::text
    from public.qorpera_company_first_runs first_run
    join public.qorpera_session_inputs input on input.id = first_run.input_id
    join public.qorpera_company_files file on file.profile_id = first_run.profile_id
    join public.qorpera_profile_staff staff on staff.profile_id = first_run.profile_id
        and staff.staff_agent_id = first_run.cofounder_staff_agent_id
    where first_run.profile_id = (current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid
),true);
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare v_fixture jsonb := current_setting('qorpera_test.unlaunched_kickoff')::jsonb; begin
    if v_fixture is null then raise exception 'Missing canonical prelaunch kickoff fixture'; end if;
    begin
        perform public.qorpera_claim_session_turn((v_fixture #>> '{input,session_id}')::uuid,
            extensions.gen_random_uuid(),60,(v_fixture ->> 'snapshotId')::uuid,(v_fixture ->> 'staffVersion')::bigint);
        raise exception 'Legacy desktop claimed an unlaunched kickoff';
    exception when sqlstate '55000' then
        if sqlerrm <> 'Company founding has not launched' then raise; end if;
    end;
end $$;
reset role;
do $$ declare v_fixture jsonb := current_setting('qorpera_test.unlaunched_kickoff')::jsonb; begin
    if (select to_jsonb(input) from public.qorpera_session_inputs input
        where id = (v_fixture #>> '{input,id}')::uuid) is distinct from v_fixture -> 'input'
        or exists(select 1 from public.qorpera_session_turns
            where session_id = (v_fixture #>> '{input,session_id}')::uuid) then
        raise exception 'Denied desktop claim modified the kickoff or admitted a turn'; end if;
end $$;
rollback;
