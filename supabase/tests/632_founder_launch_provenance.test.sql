-- @fixture 631_company_founding.test.sql until "-- Noncreator launch queued; provenance/materialization tests extend this fixture."
-- Continue the real two-founder launch through materialization and the native
-- context source. No paid provider execution or credentials are used.
select pg_temp.org_claims('service_role');
set local role service_role;
select public.qorpera_materialize_session_turn_requests(64);
reset role;
do $$
declare v_receipt jsonb := current_setting('qorpera_test.founding_launch')::jsonb -> 'launch';
    v_request public.qorpera_session_turn_requests%rowtype; v_run public.qorpera_execution_runs%rowtype;
    v_source jsonb; v_startup jsonb; v_policy jsonb;
begin
    select * into strict v_request from public.qorpera_session_turn_requests where id = (v_receipt ->> 'turnRequestId')::uuid;
    if v_request.status <> 'materialized' then raise exception 'Noncreator launch did not materialize: %',v_request.status; end if;
    select * into strict v_run from public.qorpera_execution_runs where id = v_request.run_id;
    if v_run.requested_by_user_id <> '31000000-0000-4000-8000-000000000002'::uuid
        or v_run.sponsored_by_user_id <> v_run.requested_by_user_id then
        raise exception 'Launch changed the model sponsor'; end if;
    if not public.qorpera_founding_kickoff_requested_by(v_run.profile_id,v_request.input_id,v_request.id,v_request.requested_by_user_id)
        or public.qorpera_founding_kickoff_requested_by(v_run.profile_id,v_request.input_id,v_request.id,
            '31000000-0000-4000-8000-000000000001')
        or public.qorpera_founding_kickoff_requested_by(v_run.profile_id,extensions.gen_random_uuid(),v_request.id,v_request.requested_by_user_id)
        or public.qorpera_founding_kickoff_requested_by(v_run.profile_id,v_request.input_id,extensions.gen_random_uuid(),v_request.requested_by_user_id)
        or public.qorpera_founding_kickoff_requested_by(extensions.gen_random_uuid(),v_request.input_id,v_request.id,v_request.requested_by_user_id) then
        raise exception 'Founding exception did not bind the exact company/input/request/requester'; end if;
    v_policy := public.qorpera_runtime_wake_policy_internal(v_run.id);
    if v_policy ->> 'kind' <> 'first-run' then raise exception 'First-run wake policy was lost: %',v_policy; end if;
    if not exists(select 1 from public.qorpera_wake_occurrences where run_id = v_run.id
        and wake_kind = 'first-run' and requested_by_user_id = v_request.requested_by_user_id) then
        raise exception 'First-run wake did not retain launcher provenance'; end if;
    v_source := public.qorpera_company_context_source(v_run,'input',v_request.input_id);
    v_startup := (v_source ->> 'text')::jsonb;
    if v_source ->> 'authorUserId' <> '31000000-0000-4000-8000-000000000001'
        or v_source ->> 'kind' <> 'private_startup'
        or v_startup ->> 'schema' <> 'qorpera.founding-startup/v1'
        or v_startup -> 'founding' is distinct from v_receipt
        or v_startup #>> '{founding,description}' <> 'Build useful company software'
        or jsonb_array_length(v_startup #> '{founding,roster}') <> 2
        or exists(select 1 from jsonb_array_elements(v_startup #> '{founding,roster}') founder
            where nullif(btrim(founder ->> 'displayName'),'') is null) then
        raise exception 'Runtime did not receive the agreed founding context with original authorship: %',v_source; end if;
    if has_function_privilege('authenticated','public.qorpera_founding_kickoff_requested_by(uuid,uuid,uuid,uuid)','EXECUTE')
        or has_function_privilege('service_role','public.qorpera_founding_kickoff_requested_by(uuid,uuid,uuid,uuid)','EXECUTE') then
        raise exception 'Founding provenance helper exposed as API authority'; end if;
end $$;

-- The second open company from631 lets a joined founder accept Computer Usage
-- responsibility without granting company ownership before Start.
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_invite_company_founder(
    (current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id')::uuid,
    (public.qorpera_read_company_founding((current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id')::uuid) ->> 'revision')::bigint,
    '31000000-0000-4000-8000-000000000002');
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_respond_company_founding((current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id')::uuid,true);
select public.qorpera_accept_computer_usage_ownership((current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id')::uuid,
    '31000000-0000-4000-8000-000000000001');
select pg_temp.founding_denied(format('select public.qorpera_leave_hosted_profile(%L)',
    current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id'),'42501');
reset role;
do $$ begin
    if (select role from public.qorpera_profile_members where profile_id =
        (current_setting('qorpera_test.founding_retry')::jsonb ->> 'profile_id')::uuid
        and user_id = '31000000-0000-4000-8000-000000000002') <> 'contributor' then
        raise exception 'Usage responsibility silently promoted company owner'; end if;
end $$;
set constraints all immediate;
rollback;
