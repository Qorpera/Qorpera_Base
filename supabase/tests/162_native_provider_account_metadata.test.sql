begin;

insert into auth.users (id, email) values
('16200000-0000-4000-8000-000000000001', 'owner@example.test'),
('16200000-0000-4000-8000-000000000002', 'coworker@example.test');
insert into public.qorpera_profiles (id, name, created_by_user_id) values
('16200000-0000-4000-8000-000000000010', 'Login display', '16200000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role) values
('16200000-0000-4000-8000-000000000010', '16200000-0000-4000-8000-000000000001', 'owner@example.test', 'Owner', 'owner'),
('16200000-0000-4000-8000-000000000010', '16200000-0000-4000-8000-000000000002', 'coworker@example.test', 'Coworker', 'contributor');

select set_config('request.jwt.claims', '{"sub":"16200000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('qorpera_test.display_identity', public.qorpera_upsert_member_compute_identity(
    '16200000-0000-4000-8000-000000000010', '16200000-0000-4000-8000-000000000020',
    'Member identity', 'qorpera-member-linux', 'v1', '["agent_turn"]', '{}'
)::text, true);
select set_config('qorpera_test.display_login', public.qorpera_begin_native_provider_login(
    '16200000-0000-4000-8000-000000000010', '16200000-0000-4000-8000-000000000030',
    '16200000-0000-4000-8000-000000000031',
    (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid,
    'openai', 'codex-cli', repeat('a', 64), 900
)::text, true);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select set_config('qorpera_test.display_connection', public.qorpera_complete_native_provider_login(
    (current_setting('qorpera_test.display_login')::jsonb ->> 'login_id')::uuid,
    repeat('a', 64), '16200000-0000-4000-8000-000000000040',
    'object://native-capsules/display-fixture', repeat('b', 64),
    'codex-cli:opaque-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
    '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
    'provider-member@example.test'
)::text, true);


do $$
declare identity_id uuid := (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid;
    connection_id uuid := (current_setting('qorpera_test.display_connection')::jsonb ->> 'connection_id')::uuid;
    usage jsonb := jsonb_build_object('observedAt',clock_timestamp(),'windows',jsonb_build_array(
        jsonb_build_object('id','primary','label','5 hours','usedPercent',20,'resetAt',clock_timestamp()+interval '2 hours','windowSeconds',18000),
        jsonb_build_object('id','secondary','label','Weekly','usedPercent',91,'resetAt',clock_timestamp()+interval '6 days','windowSeconds',604800)));
begin
    if jsonb_array_length(public.qorpera_list_native_provider_account_refreshes(identity_id,0)) <> 1 then
        raise exception 'Active account not discoverable by its host'; end if;
    perform public.qorpera_record_native_provider_account_metadata(identity_id,0,connection_id,1,
        '16200000-0000-4000-8000-000000000040','hydrated@example.test',usage);
    if public.qorpera_list_native_provider_account_refreshes(identity_id,0) <> '[]'::jsonb then
        raise exception 'Fresh metadata should not cause a busy refresh loop'; end if;
    -- Fetch failures retain the last known snapshot, with its original timestamp.
    perform public.qorpera_record_native_provider_account_metadata(identity_id,0,connection_id,1,
        '16200000-0000-4000-8000-000000000040',null,null);
    begin
        perform public.qorpera_record_native_provider_account_metadata(identity_id,1,connection_id,1,
            '16200000-0000-4000-8000-000000000040','wrong@example.test',usage);
        raise exception 'Stale host epoch accepted';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_record_native_provider_account_metadata(identity_id,0,connection_id,1,
            '16200000-0000-4000-8000-000000000099','wrong@example.test',usage);
        raise exception 'Wrong credential capsule accepted';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_record_native_provider_account_metadata(identity_id,0,connection_id,1,
            '16200000-0000-4000-8000-000000000040',null,usage || '{"access_token":"must-not-be-persisted"}'::jsonb);
        raise exception 'Unrecognized provider credential metadata accepted';
    exception when invalid_parameter_value then null; end;
    begin
        perform public.qorpera_record_native_provider_account_metadata(identity_id,0,connection_id,1,
            '16200000-0000-4000-8000-000000000040',null,jsonb_set(usage,'{windows,0,usedPercent}','101'));
        raise exception 'Impossible percentage accepted';
    exception when invalid_parameter_value then null; end;
end $$;
reset role;
do $$
declare connection_id uuid := (current_setting('qorpera_test.display_connection')::jsonb ->> 'connection_id')::uuid;
begin
    if public.qorpera_native_account_remaining(connection_id,1) <> 9 then
        raise exception 'Ranking must use the tightest limit, not average/maximum remaining'; end if;
    if public.qorpera_native_account_remaining('16200000-0000-4000-8000-000000000099',1) <> -1 then
        raise exception 'Missing usage was fabricated'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"16200000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare account jsonb := public.qorpera_list_member_native_execution_connections('16200000-0000-4000-8000-000000000010') -> 'connections' -> 0;
begin
    if account ->> 'provider_account_email' <> 'hydrated@example.test'
      or account -> 'provider_account_usage' -> 'windows' -> 1 ->> 'usedPercent' <> '91'
      or account ?| array['encrypted_capsule_reference','access_token','refresh_token'] then
        raise exception 'Member metadata projection is incorrect'; end if;
    begin
        perform public.qorpera_list_native_provider_account_refreshes(
            (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid,0);
        raise exception 'Member read credential refresh authority';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims', '{"sub":"16200000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$ begin
    if public.qorpera_list_member_native_execution_connections('16200000-0000-4000-8000-000000000010') -> 'connections' <> '[]'::jsonb then
        raise exception 'Coworker saw private account usage'; end if;
end $$;
reset role;
update public.qorpera_provider_connections set status='revoked'
where id=(current_setting('qorpera_test.display_connection')::jsonb ->> 'connection_id')::uuid;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$ begin
    begin
        perform public.qorpera_record_native_provider_account_metadata(
            (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid,0,
            (current_setting('qorpera_test.display_connection')::jsonb ->> 'connection_id')::uuid,1,
            '16200000-0000-4000-8000-000000000040',null,null);
        raise exception 'Revoked connection accepted metadata';
    exception when insufficient_privilege then null; end;
end $$;
rollback;
