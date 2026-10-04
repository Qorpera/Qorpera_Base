begin;
insert into auth.users(id,email) values
('16300000-0000-4000-8000-000000000001','selection-owner@example.test'),
('16300000-0000-4000-8000-000000000002','selection-other@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
('16300000-0000-4000-8000-000000000010','Selection fixture','16300000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000001','selection-owner@example.test','Owner','owner'),
('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000002','selection-other@example.test','Other','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
('16300000-0000-4000-8000-000000000020','16300000-0000-4000-8000-000000000010','Selection',1,'16300000-0000-4000-8000-000000000001');
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,created_by_user_id,audience_kind,audience_user_id) values
('16300000-0000-4000-8000-000000000030','16300000-0000-4000-8000-000000000031','16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000020','First','16300000-0000-4000-8000-000000000001','member_private','16300000-0000-4000-8000-000000000001'),
('16300000-0000-4000-8000-000000000032','16300000-0000-4000-8000-000000000033','16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000020','Second','16300000-0000-4000-8000-000000000001','company',null),
('16300000-0000-4000-8000-000000000034','16300000-0000-4000-8000-000000000035','16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000020','Third','16300000-0000-4000-8000-000000000001','member_private','16300000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims','{"sub":"16300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
do $$
declare identity_id uuid; login jsonb; connection jsonb; sponsor jsonb; idx integer;
begin
    identity_id := (public.qorpera_upsert_member_compute_identity('16300000-0000-4000-8000-000000000010',
        '16300000-0000-4000-8000-000000000040','Selection identity','qorpera-member-linux','v1','["agent_turn"]','{}') ->> 'compute_identity_id')::uuid;
    for idx in 1..2 loop
        login := public.qorpera_begin_native_provider_login('16300000-0000-4000-8000-000000000010',
            extensions.gen_random_uuid(),extensions.gen_random_uuid(),identity_id,'openai','codex-cli',repeat('a',64),900);
        perform set_config('request.jwt.claims','{"role":"service_role"}',true);
        connection := public.qorpera_complete_native_provider_login((login ->> 'login_id')::uuid,repeat('a',64),
            extensions.gen_random_uuid(),'object://selection/' || idx,repeat('b',64),'same-opaque-status-reference',
            'personal-subscription','qorpera-native-provider-consent/v1',
            '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
            'account' || idx || '@example.test');
        perform set_config('request.jwt.claims','{"sub":"16300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
        sponsor := public.qorpera_create_member_execution_sponsor('16300000-0000-4000-8000-000000000010',
            extensions.gen_random_uuid(),(connection ->> 'connection_id')::uuid,1,false);
        perform set_config('qorpera_test.selection_connection_' || idx,connection ->> 'connection_id',true);
        perform set_config('qorpera_test.selection_binding_' || idx,sponsor ->> 'binding_id',true);
        insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
        values((connection ->> 'connection_id')::uuid,1,jsonb_build_object('observedAt',clock_timestamp(),'windows',
            jsonb_build_array(jsonb_build_object('id','primary','label','5 hours','usedPercent',case when idx=1 then 20 else 50 end))));
    end loop;
end $$;

set local role authenticated;
do $$ begin
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000030')
        is distinct from current_setting('qorpera_test.selection_connection_1')::uuid then raise exception 'Highest allowance not selected'; end if;
    begin
        perform 1 from public.qorpera_member_session_accounts;
        raise exception 'Member accessed internal selection table';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000099','16300000-0000-4000-8000-000000000030');
        raise exception 'Mismatched company accepted';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.qorpera_native_provider_account_metadata set provider_account_usage=jsonb_set(provider_account_usage,'{windows,0,usedPercent}','0')
where connection_id=current_setting('qorpera_test.selection_connection_2')::uuid;
set local role authenticated;
do $$ begin
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000030')
        is distinct from current_setting('qorpera_test.selection_connection_1')::uuid then raise exception 'Sticky selection changed to higher quota'; end if;
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000032')
        is distinct from current_setting('qorpera_test.selection_connection_2')::uuid then raise exception 'New conversation did not select higher quota'; end if;
end $$;
reset role;
-- Signing in again moves the saved binding to the member's new connection (qorpera_move_member_login_pins). The
-- conversation follows its binding even when another binding still makes its original account eligible.
insert into public.qorpera_execution_sponsor_versions(binding_id,version,sponsor_kind,provider_connection_id,provider_connection_version,allow_autonomous,created_by_user_id)
values(current_setting('qorpera_test.selection_binding_1')::uuid,2,'member_connection',current_setting('qorpera_test.selection_connection_2')::uuid,1,false,'16300000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000030')
        is distinct from current_setting('qorpera_test.selection_connection_2')::uuid then raise exception 'Durable binding move not followed'; end if;
end $$;
reset role;
-- At their usage limits a conversation keeps its login (20260930059000), and a new one has nothing to start on.
update public.qorpera_native_provider_account_metadata set provider_account_usage=jsonb_set(provider_account_usage,'{windows,0,usedPercent}','100');
set local role authenticated;
do $$ begin
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000030')
        is distinct from current_setting('qorpera_test.selection_connection_2')::uuid then
        raise exception 'A conversation left its login at its usage limit'; end if;
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000034') is not null then
        raise exception 'A new conversation started on an exhausted account'; end if;
end $$;
reset role;
-- A stale observation is unknown, not permanent exhaustion or full allowance.
update public.qorpera_native_provider_account_metadata set provider_account_usage=jsonb_set(provider_account_usage,'{observedAt}',to_jsonb(clock_timestamp()-interval '10 minutes'));
do $$ begin
    if public.qorpera_member_first_run_sponsor('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000001') is null then
        raise exception 'Unknown allowance prevents first run'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"16300000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
    begin
        perform public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000030');
        raise exception 'Another member accessed private selection';
    exception when insufficient_privilege then null; end;
    if public.qorpera_select_member_session_account('16300000-0000-4000-8000-000000000010','16300000-0000-4000-8000-000000000032') is not null then
        raise exception 'Another member selected owner credentials'; end if;
end $$;
reset role;
rollback;
