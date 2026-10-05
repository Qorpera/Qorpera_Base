begin;

insert into auth.users (id, email) values
('16100000-0000-4000-8000-000000000001', 'owner@example.test'),
('16100000-0000-4000-8000-000000000002', 'coworker@example.test');
insert into public.qorpera_profiles (id, name, created_by_user_id) values
('16100000-0000-4000-8000-000000000010', 'Login display', '16100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role) values
('16100000-0000-4000-8000-000000000010', '16100000-0000-4000-8000-000000000001', 'owner@example.test', 'Owner', 'owner'),
('16100000-0000-4000-8000-000000000010', '16100000-0000-4000-8000-000000000002', 'coworker@example.test', 'Coworker', 'contributor');
-- A folder-v2 company (the company folder core).
insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id) values
('16100000-0000-4000-8000-000000000011', '16100000-0000-4000-8000-000000000010', 'Login display', 1, '16100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('16100000-0000-4000-8000-000000000011') \g /dev/null
do $$ begin
    if not public.qorpera_company_is_folder_v2('16100000-0000-4000-8000-000000000010') then
        raise exception 'the login display company is not a folder-v2 company'; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"16100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('qorpera_test.display_identity', public.qorpera_upsert_member_compute_identity(
    '16100000-0000-4000-8000-000000000010', '16100000-0000-4000-8000-000000000020',
    'Member identity', 'qorpera-member-linux', 'v1', '["agent_turn"]', '{}'
)::text, true);
select set_config('qorpera_test.display_login', public.qorpera_begin_native_provider_login(
    '16100000-0000-4000-8000-000000000010', '16100000-0000-4000-8000-000000000030',
    '16100000-0000-4000-8000-000000000031',
    (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid,
    'openai', 'codex-cli', repeat('a', 64), 900
)::text, true);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select set_config('qorpera_test.display_connection', public.qorpera_complete_native_provider_login(
    (current_setting('qorpera_test.display_login')::jsonb ->> 'login_id')::uuid,
    repeat('a', 64), '16100000-0000-4000-8000-000000000040',
    'object://native-capsules/display-fixture', repeat('b', 64),
    'codex-cli:opaque-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
    '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
    'provider-member@example.test'
)::text, true);

reset role;
select set_config('request.jwt.claims', '{"sub":"16100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
do $$
declare
    v_connections jsonb := public.qorpera_list_member_native_execution_connections('16100000-0000-4000-8000-000000000010') -> 'connections';
    v_connection jsonb := v_connections -> 0;
begin
    if jsonb_array_length(v_connections) <> 1
        or v_connection ->> 'client_connection_id' is distinct from '16100000-0000-4000-8000-000000000031'
        or v_connection ->> 'connection_id' is not distinct from v_connection ->> 'client_connection_id'
        or v_connection ->> 'connection_id' is distinct from current_setting('qorpera_test.display_connection')::jsonb ->> 'connection_id'
        or v_connection ->> 'provider_account_email' is distinct from 'provider-member@example.test'
        or v_connection ->> 'provider_account_reference' is distinct from 'codex-cli:opaque-account'
        or v_connection ->> 'authorization_state' is distinct from 'active' then
        raise exception 'completed login lost its correlation, provider email, or server connection identity';
    end if;
    if v_connection ?| array['capability_sha256', 'encrypted_capsule_reference', 'access_token', 'refresh_token'] then
        raise exception 'connection display leaked login credentials';
    end if;
end
$$;

select set_config('request.jwt.claims', '{"sub":"16100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
begin
    if public.qorpera_list_member_native_execution_connections('16100000-0000-4000-8000-000000000010') -> 'connections' <> '[]'::jsonb then
        raise exception 'coworker could see another member''s login correlation or email';
    end if;
end
$$;

rollback;
