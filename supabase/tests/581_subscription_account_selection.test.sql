-- @fixture 163_member_session_account_selection.test.sql until "set local role authenticated;"
-- Both already-open conversations keep A, also once it is exhausted (20260930059000: the payer never changes without
-- the member) and after it recovers; only a new conversation starts on B, the account with room left.
set local role authenticated;
do $$
declare session_id uuid;
begin
    foreach session_id in array array['16300000-0000-4000-8000-000000000030'::uuid,'16300000-0000-4000-8000-000000000032'::uuid] loop
        if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010',session_id)
          is distinct from current_setting('qorpera_test.selection_connection_1')::uuid then
            raise exception 'Existing conversation did not start on A'; end if;
    end loop;
end $$;
reset role;
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','100')
where connection_id = current_setting('qorpera_test.selection_connection_1')::uuid;
set local role authenticated;
do $$
declare session_id uuid;
begin
    foreach session_id in array array['16300000-0000-4000-8000-000000000030'::uuid,'16300000-0000-4000-8000-000000000032'::uuid] loop
        if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010',session_id)
          is distinct from current_setting('qorpera_test.selection_connection_1')::uuid then
            raise exception 'An exhausted saved account was replaced'; end if;
    end loop;
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000034')
      is distinct from current_setting('qorpera_test.selection_connection_2')::uuid then
        raise exception 'A new conversation did not start on the account with room'; end if;
end $$;
reset role;
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','0')
where connection_id = current_setting('qorpera_test.selection_connection_1')::uuid;
set local role authenticated;
do $$
declare session_id uuid;
begin
    foreach session_id in array array['16300000-0000-4000-8000-000000000030'::uuid,'16300000-0000-4000-8000-000000000032'::uuid] loop
        if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010',session_id)
          is distinct from current_setting('qorpera_test.selection_connection_1')::uuid then
            raise exception 'Recovery displaced a sticky account'; end if;
    end loop;
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000034')
      is distinct from current_setting('qorpera_test.selection_connection_2')::uuid then
        raise exception 'Recovery displaced the new conversation''s account'; end if;
end $$;
reset role;

-- A real connected Claude subscription remains available to its own supported
-- surfaces, but must not enter the governed Codex execution candidate pool.
-- Since 20260930564000 a Claude sign-in is the vault's and makes no provider connection: this one is an older
-- per-node Claude connection (none ever completed in production), its rows written as that path wrote them.
do $$
declare identity_id uuid; capsule_id uuid := extensions.gen_random_uuid(); v_connection uuid := extensions.gen_random_uuid();
begin
    select id into strict identity_id from public.qorpera_member_compute_identities
    where profile_id = '16300000-0000-4000-8000-000000000010';
    insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
        provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
    values (capsule_id, '16300000-0000-4000-8000-000000000010', identity_id, 'member', '16300000-0000-4000-8000-000000000001',
        'anthropic', 'claude-code', 'object://selection/claude', repeat('d', 64), '16300000-0000-4000-8000-000000000001');
    insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider,
        created_by_user_id)
    values (v_connection, '16300000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
        '16300000-0000-4000-8000-000000000001', 'anthropic', '16300000-0000-4000-8000-000000000001');
    insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
        billing_source, consent_version, consented_by_user_id, allow_autonomous, quota_policy, created_by_user_id,
        credential_capsule_id, authorization_state, max_native_concurrency)
    values (v_connection, 1, 'native_subscription', 'claude-code', 'personal_subscription',
        'qorpera-native-provider-consent/v1', '16300000-0000-4000-8000-000000000001', false,
        '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
        '16300000-0000-4000-8000-000000000001', capsule_id, 'active', 1);
    perform set_config('request.jwt.claims','{"sub":"16300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
    perform public.qorpera_create_member_execution_sponsor('16300000-0000-4000-8000-000000000010',
        extensions.gen_random_uuid(),v_connection,1,false);
    if exists(select 1 from public.qorpera_eligible_member_accounts('16300000-0000-4000-8000-000000000010',
        '16300000-0000-4000-8000-000000000001') as eligible where eligible.connection_id = v_connection) then
        raise exception 'Unsupported governed harness was eligible'; end if;
end $$;
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_set(provider_account_usage,'{windows,0,usedPercent}','100');
set local role authenticated;
do $$ begin
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010',
        '16300000-0000-4000-8000-000000000030') is distinct from current_setting('qorpera_test.selection_connection_1')::uuid then
        raise exception 'An exhausted Codex conversation left its account'; end if;
end $$;
reset role;
-- A conversation with no account yet: nothing to start on, and never the Claude login.
delete from public.qorpera_member_session_accounts where session_id = '16300000-0000-4000-8000-000000000034';
set local role authenticated;
do $$ begin
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010',
        '16300000-0000-4000-8000-000000000034') is not null then
        raise exception 'Exhausted Codex accounts caused a fallback to Claude'; end if;
end $$;
reset role;
do $$ begin
    if public.qorpera_member_first_run_sponsor('16300000-0000-4000-8000-000000000010',
        '16300000-0000-4000-8000-000000000001') is not null then
        raise exception 'First run selected an unsupported governed harness'; end if;
end $$;
set constraints all immediate;
rollback;
