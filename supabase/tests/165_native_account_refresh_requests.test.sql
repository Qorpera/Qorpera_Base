begin;

insert into auth.users (id, email) values
('16500000-0000-4000-8000-000000000001', 'owner@example.test'),
('16500000-0000-4000-8000-000000000002', 'coworker@example.test');
insert into public.qorpera_profiles (id, name, created_by_user_id) values
('16500000-0000-4000-8000-000000000010', 'Login display', '16500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role) values
('16500000-0000-4000-8000-000000000010', '16500000-0000-4000-8000-000000000001', 'owner@example.test', 'Owner', 'owner'),
('16500000-0000-4000-8000-000000000010', '16500000-0000-4000-8000-000000000002', 'coworker@example.test', 'Coworker', 'contributor');
-- A folder-v2 company (the company folder core): the refresh machine's reservation takes the folder fence.
insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id) values
('16500000-0000-4000-8000-000000000011', '16500000-0000-4000-8000-000000000010', 'Login display', 1, '16500000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('16500000-0000-4000-8000-000000000011') \g /dev/null
do $$ begin
    if not public.qorpera_company_is_folder_v2('16500000-0000-4000-8000-000000000010') then
        raise exception 'the refresh company is not a folder-v2 company'; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"16500000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select set_config('qorpera_test.display_identity', public.qorpera_upsert_member_compute_identity(
    '16500000-0000-4000-8000-000000000010', '16500000-0000-4000-8000-000000000020',
    'Member identity', 'qorpera-member-linux', 'v1', '["agent_turn"]', '{}'
)::text, true);
select set_config('qorpera_test.display_login', public.qorpera_begin_native_provider_login(
    '16500000-0000-4000-8000-000000000010', '16500000-0000-4000-8000-000000000030',
    '16500000-0000-4000-8000-000000000031',
    (current_setting('qorpera_test.display_identity')::jsonb ->> 'compute_identity_id')::uuid,
    'openai', 'codex-cli', repeat('a', 64), 900
)::text, true);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select set_config('qorpera_test.display_connection', public.qorpera_complete_native_provider_login(
    (current_setting('qorpera_test.display_login')::jsonb ->> 'login_id')::uuid,
    repeat('a', 64), '16500000-0000-4000-8000-000000000040',
    'object://native-capsules/display-fixture', repeat('b', 64),
    'codex-cli:opaque-account', 'personal-subscription', 'qorpera-native-provider-consent/v1',
    '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}',
    'provider-member@example.test'
)::text, true);


reset role;
select set_config('qorpera_test.refresh_login_count',(select count(*)::text from public.qorpera_native_provider_login_sessions
    where profile_id='16500000-0000-4000-8000-000000000010'),true);
select set_config('request.jwt.claims','{"sub":"16500000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
select set_config('qorpera_test.refresh_request',public.qorpera_begin_native_account_refresh(
    '16500000-0000-4000-8000-000000000010','16500000-0000-4000-8000-000000000050',repeat('c',64))::text,true);
do $$
declare request jsonb:=current_setting('qorpera_test.refresh_request')::jsonb;
begin
    if request->>'status' is distinct from 'pending'
      or request-array['request_id','profile_id','compute_identity_id','requested_by_user_id','expires_at','status']<>'{}'::jsonb
      or request->>'requested_by_user_id'<>'16500000-0000-4000-8000-000000000001' then
        raise exception 'Refresh admission returned an invalid projection'; end if;
    if public.qorpera_begin_native_account_refresh('16500000-0000-4000-8000-000000000010',
      '16500000-0000-4000-8000-000000000050',repeat('c',64)) is distinct from request then
        raise exception 'Refresh admission is not idempotent'; end if;
    if public.qorpera_get_native_account_refresh('16500000-0000-4000-8000-000000000010') is distinct from request then
        raise exception 'Another tab cannot observe its member refresh progress'; end if;
    begin
        perform public.qorpera_begin_native_account_refresh('16500000-0000-4000-8000-000000000010',
          '16500000-0000-4000-8000-000000000050',repeat('d',64));
        raise exception 'Request capability could be rebound';
    exception when unique_violation then null; end;
    begin
        perform public.qorpera_begin_native_account_refresh('16500000-0000-4000-8000-000000000010',
          '16500000-0000-4000-8000-000000000051',repeat('d',64));
        raise exception 'Concurrent refresh escaped its bound';
    exception when object_not_in_prerequisite_state then null; end;
    begin
        perform 1 from public.qorpera_native_account_refresh_requests;
        raise exception 'Member could read refresh capabilities';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_complete_native_account_refresh((request->>'request_id')::uuid,repeat('c',64),0);
        raise exception 'Member could complete their own refresh';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$
declare request_id uuid:=(current_setting('qorpera_test.refresh_request')::jsonb->>'request_id')::uuid;
begin
    if public.qorpera_describe_native_account_refresh_route(request_id,repeat('c',64))
      is distinct from current_setting('qorpera_test.refresh_request')::jsonb then
        raise exception 'Host did not receive exact refresh identity'; end if;
    begin
        perform public.qorpera_describe_native_account_refresh_route(request_id,repeat('d',64));
        raise exception 'Wrong refresh capability accepted';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_complete_native_account_refresh(request_id,repeat('c',64),1);
        raise exception 'Wrong refresh epoch accepted';
    exception when insufficient_privilege then null; end;
    if not public.qorpera_complete_native_account_refresh(request_id,repeat('c',64),0) then
        raise exception 'Unavailable usage blocks bounded attempt completion'; end if;
    perform public.qorpera_record_native_provider_account_metadata(
        (current_setting('qorpera_test.display_identity')::jsonb->>'compute_identity_id')::uuid,0,
        (current_setting('qorpera_test.display_connection')::jsonb->>'connection_id')::uuid,1,
        '16500000-0000-4000-8000-000000000040','provider-member@example.test',
        jsonb_build_object('observedAt',clock_timestamp(),'windows',jsonb_build_array(
            jsonb_build_object('id','primary','label','5 hours','usedPercent',30,'resetAt',clock_timestamp()+interval '2 hours'))),repeat('a',64));
    if not public.qorpera_complete_native_account_refresh(request_id,repeat('c',64),0) then
        raise exception 'Fresh usage could not complete'; end if;
    if public.qorpera_describe_native_account_refresh_route(request_id,repeat('c',64))->>'status' is distinct from 'completed' then
        raise exception 'Refresh completion not durable'; end if;
end $$;
reset role;
select set_config('request.jwt.claims','{"sub":"16500000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
    if public.qorpera_begin_native_account_refresh('16500000-0000-4000-8000-000000000010',
      '16500000-0000-4000-8000-000000000052',repeat('d',64))->>'status' is distinct from 'completed' then
        raise exception 'Fresh cache booted another machine'; end if;
end $$;
reset role;
update public.qorpera_native_provider_account_metadata set provider_account_usage=jsonb_set(provider_account_usage,
    '{observedAt}',to_jsonb(clock_timestamp()-interval '2 minutes'))
where connection_id=(current_setting('qorpera_test.display_connection')::jsonb->>'connection_id')::uuid;
select set_config('qorpera_test.refresh_attempt_at',(select max(completed_at)::text
    from public.qorpera_native_account_refresh_requests where profile_id='16500000-0000-4000-8000-000000000010'),true);
set local role authenticated;
do $$ begin
    if public.qorpera_begin_native_account_refresh('16500000-0000-4000-8000-000000000010',
      '16500000-0000-4000-8000-000000000055',repeat('d',64))->>'status' is distinct from 'completed' then
        raise exception 'Unavailable usage immediately booted another refresh'; end if;
end $$;
reset role;
do $$ begin
    if (select max(completed_at) from public.qorpera_native_account_refresh_requests
      where profile_id='16500000-0000-4000-8000-000000000010') is distinct from
      current_setting('qorpera_test.refresh_attempt_at')::timestamptz then
        raise exception 'Cached receipts extended the refresh attempt throttle'; end if;
end $$;
update public.qorpera_native_account_refresh_requests set completed_at=clock_timestamp()-interval '1 minute'
where profile_id='16500000-0000-4000-8000-000000000010' and status='completed';
set local role authenticated;
select set_config('qorpera_test.refresh_request2',public.qorpera_begin_native_account_refresh(
    '16500000-0000-4000-8000-000000000010','16500000-0000-4000-8000-000000000053',repeat('e',64))::text,true);
reset role;
do $$ begin
    if current_setting('qorpera_test.refresh_request2')::jsonb->>'status' is distinct from 'pending' then
        raise exception 'Stale cache was certified fresh'; end if;
end $$;

-- A refresh reservation shares the same company and identity occupancy as a
-- login, but its source FK names only the refresh. The unbound test provider
-- still exercises the real company reservation and permanent release fences.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$
declare request_id uuid:=(current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid;
    result jsonb;
begin
    result:=public.qorpera_repin_account_refresh_recovery_epoch(request_id);
    if result->>'loginId' is distinct from request_id::text or (result->>'repinned')::boolean then
        raise exception 'Current refresh epoch was changed by a replay'; end if;
    begin
        perform public.qorpera_repin_account_refresh_recovery_epoch(
            (current_setting('qorpera_test.refresh_request')::jsonb->>'request_id')::uuid);
        raise exception 'Completed refresh acquired recovery authority';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_request_account_refresh_identity_recovery(request_id,
            '16500000-0000-4000-8000-000000000099','16500000-0000-4000-8000-000000000098','nas');
        raise exception 'Refresh recovery accepted a missing target and backup';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_request_account_refresh_identity_recovery(
            (current_setting('qorpera_test.refresh_request')::jsonb->>'request_id')::uuid,
            '16500000-0000-4000-8000-000000000099','16500000-0000-4000-8000-000000000098','nas');
        raise exception 'Completed refresh acquired a recovery request';
    exception when insufficient_privilege then null; end;
    result:=public.qorpera_reserve_runtime_account_refresh_machine('16500000-0000-4000-8000-000000000060',
        'refresh-test',repeat('f',64),request_id,repeat('e',64));
    if result->>'state' is distinct from 'reserved' then raise exception 'Refresh machine not reserved: %',result; end if;
    result:=public.qorpera_describe_runtime_account_refresh_machine('16500000-0000-4000-8000-000000000060',
        'refresh-test',repeat('f',64));
    if (result->>'cleanupRequired')::boolean or result->>'loginId' is distinct from request_id::text then
        raise exception 'Refresh machine journal lost authority'; end if;
    if public.qorpera_runtime_account_refresh_journal_orphaned('16500000-0000-4000-8000-000000000060',request_id) then
        raise exception 'Reserved refresh machine marked orphan'; end if;
    perform public.qorpera_release_runtime_account_refresh_machine('16500000-0000-4000-8000-000000000060',
        'refresh-test',repeat('f',64),request_id);
    begin
        perform public.qorpera_reserve_runtime_account_refresh_machine('16500000-0000-4000-8000-000000000060',
            'refresh-test',repeat('f',64),request_id,repeat('e',64));
        raise exception 'Released refresh allocation revived';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
    if (select public.qorpera_runtime_identity_home_allocation(a) from public.qorpera_runtime_machine_allocations a
      where id='16500000-0000-4000-8000-000000000060') then
        raise exception 'Uncompleted refresh guest became an identity home'; end if;
    if not exists(select 1 from public.qorpera_runtime_machine_allocations
      where id='16500000-0000-4000-8000-000000000060' and login_session_id is null
        and account_refresh_request_id=(current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid
        and released_at is not null) then raise exception 'Refresh borrowed login allocation authority'; end if;
    if (select count(*) from public.qorpera_native_provider_login_sessions
      where profile_id='16500000-0000-4000-8000-000000000010')<>current_setting('qorpera_test.refresh_login_count')::bigint then
        raise exception 'Refresh created a fake login'; end if;
end $$;
set local role service_role;
select public.qorpera_complete_native_account_refresh(
    (current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid,repeat('e',64),0);
reset role;
do $$ begin
    if not (select public.qorpera_runtime_identity_home_allocation(a) from public.qorpera_runtime_machine_allocations a
      where id='16500000-0000-4000-8000-000000000060') then
        raise exception 'Completed refresh host did not establish an identity home'; end if;
end $$;
-- A recovery moves the identity and raises its epoch: the host of an earlier epoch holds a stale
-- copy and is no home, until something completes there at the current epoch again.
do $$ declare v_identity uuid; begin
    select compute_identity_id into strict v_identity from public.qorpera_native_account_refresh_requests
    where id=(current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid;
    update public.qorpera_member_compute_identities set recovery_epoch=recovery_epoch+1 where id=v_identity;
    if (select public.qorpera_runtime_identity_home_allocation(a) from public.qorpera_runtime_machine_allocations a
      where id='16500000-0000-4000-8000-000000000060') then
        raise exception 'A host of an earlier recovery epoch stayed an identity home'; end if;
    update public.qorpera_member_compute_identities set recovery_epoch=recovery_epoch-1 where id=v_identity;
    if not (select public.qorpera_runtime_identity_home_allocation(a) from public.qorpera_runtime_machine_allocations a
      where id='16500000-0000-4000-8000-000000000060') then
        raise exception 'The current epoch host lost its identity home'; end if;
end $$;
select set_config('request.jwt.claims','{"sub":"16500000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
    if public.qorpera_get_native_account_refresh('16500000-0000-4000-8000-000000000010') is not null then
        raise exception 'Coworker could inspect owner refresh progress'; end if;
    begin
        perform public.qorpera_begin_native_account_refresh('16500000-0000-4000-8000-000000000010',
            '16500000-0000-4000-8000-000000000054',repeat('e',64));
        raise exception 'Coworker refreshed owner identity';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
set constraints all immediate;
rollback;
