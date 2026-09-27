-- @fixture 300_runtime_wake_bus.test.sql until "create function pg_temp.path_plan"
-- The fixture supplies a real admitted run, accepted assignment and native
-- lease on A. B previously exhausted without a reset and has now recovered.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
do $$
declare login jsonb; connection jsonb; sponsor jsonb;
begin
    login := public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010',
        extensions.gen_random_uuid(),extensions.gen_random_uuid(),
        (current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,
        'openai','codex-cli',repeat('c',64),900);
    perform pg_temp.path_claims('service_role');
    connection := public.qorpera_complete_native_provider_login((login ->> 'login_id')::uuid,repeat('c',64),
        extensions.gen_random_uuid(),'object://recovered-handoff/account-b',repeat('d',64),'account-b','personal-subscription',
        'qorpera-native-provider-consent/v1',
        '{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
    perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
    sponsor := public.qorpera_create_member_execution_sponsor('30000000-0000-4000-8000-000000000010',
        extensions.gen_random_uuid(),(connection ->> 'connection_id')::uuid,1,false);
    perform set_config('qorpera_test.recovered_connection',connection::text,true);
    perform set_config('qorpera_test.recovered_sponsor',sponsor::text,true);
end $$;
-- Historical run identities only anchor B's old signal; no live provider or
-- substituted authority helpers participate in the handoff below.
insert into public.qorpera_runner_jobs(id,profile_id,environment_id,substrate_version_id,client_job_id,job_type,required_capability,payload,created_by_user_id)
values ('58300000-0000-4000-8000-000000000070','30000000-0000-4000-8000-000000000010',
    '30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000025',
    '58300000-0000-4000-8000-000000000070','agent_turn','agent_turn','{}','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,job_id,
    substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,sponsor_binding_id,sponsor_version,
    required_capability,job_type,payload_sha256,transcript_start_sequence,created_by_user_id,compute_identity_id)
values ('58300000-0000-4000-8000-000000000071','30000000-0000-4000-8000-000000000010',
    '30000000-0000-4000-8000-000000000020','system','58300000-0000-4000-8000-000000000071',
    '58300000-0000-4000-8000-000000000070','30000000-0000-4000-8000-000000000025',
    '30000000-0000-4000-8000-000000000023','30000000-0000-4000-8000-000000000030',1,
    (current_setting('qorpera_test.recovered_sponsor')::jsonb ->> 'binding_id')::uuid,1,
    'agent_turn','agent_turn',repeat('a',64),0,'30000000-0000-4000-8000-000000000001',
    (current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid);
insert into public.qorpera_provider_connection_usage_signals(profile_id,run_id,job_id,sponsor_binding_id,sponsor_version,
    provider_connection_id,provider_connection_version,provider,signal_kind,source,observed_at)
values ('30000000-0000-4000-8000-000000000010','58300000-0000-4000-8000-000000000071',
    '58300000-0000-4000-8000-000000000070',(current_setting('qorpera_test.recovered_sponsor')::jsonb ->> 'binding_id')::uuid,1,
    (current_setting('qorpera_test.recovered_connection')::jsonb ->> 'connection_id')::uuid,1,'openai','usage_limit','native_adapter',
    statement_timestamp()-interval '2 minutes');
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_record_provider_usage_signal(current_setting('qorpera_test.wake_binding')::jsonb,'usage_limit');
reset role;
do $$ begin
    if public.qorpera_handoff_run_sponsor((current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid,
        'usage_limit') is not null then raise exception 'Handoff selected a still exhausted candidate'; end if;
end $$;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values ((current_setting('qorpera_test.recovered_connection')::jsonb ->> 'connection_id')::uuid,1,
    jsonb_build_object('observedAt',statement_timestamp()-interval '1 second','windows',jsonb_build_array(
        jsonb_build_object('id','primary','label','5 hours','usedPercent',20))));
do $$
declare result jsonb; v_run_id uuid := (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid;
begin
    result := public.qorpera_handoff_run_sponsor(v_run_id,'usage_limit');
    if result is null then raise exception 'Recovered replacement account was blocked by its historical signal'; end if;
    if not exists(select 1 from public.qorpera_execution_runs r
        join public.qorpera_execution_sponsor_versions s on s.binding_id = r.sponsor_binding_id and s.version = r.sponsor_version
        join public.qorpera_runner_jobs j on j.id = r.job_id
        where r.id = v_run_id and s.provider_connection_id = (current_setting('qorpera_test.recovered_connection')::jsonb ->> 'connection_id')::uuid
          and j.status = 'queued') then raise exception 'Handoff did not requeue the existing run on recovered B'; end if;
end $$;
set constraints all immediate;
rollback;
