-- @fixture 163_member_session_account_selection.test.sql until "set local role authenticated;"
-- Both already-open conversations keep A, also once it is exhausted (20260930048000: the payer never changes without
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
do $$
declare identity_id uuid; login jsonb; connection jsonb;
begin
    select id into strict identity_id from public.qorpera_member_compute_identities
    where profile_id = '16300000-0000-4000-8000-000000000010';
    login := public.qorpera_begin_native_provider_login('16300000-0000-4000-8000-000000000010',
        extensions.gen_random_uuid(),extensions.gen_random_uuid(),identity_id,'anthropic','claude-code',repeat('c',64),900);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    connection := public.qorpera_complete_native_provider_login((login ->> 'login_id')::uuid,repeat('c',64),
        extensions.gen_random_uuid(),'object://selection/claude',repeat('d',64),'claude-account',
        'personal-subscription','qorpera-native-provider-consent/v1',
        '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
    perform set_config('request.jwt.claims','{"sub":"16300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
    perform public.qorpera_create_member_execution_sponsor('16300000-0000-4000-8000-000000000010',
        extensions.gen_random_uuid(),(connection ->> 'connection_id')::uuid,1,false);
    if exists(select 1 from public.qorpera_eligible_member_accounts('16300000-0000-4000-8000-000000000010',
        '16300000-0000-4000-8000-000000000001') where connection_id = (connection ->> 'connection_id')::uuid) then
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
