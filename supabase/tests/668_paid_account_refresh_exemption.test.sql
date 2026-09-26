-- @fixture 165_native_account_refresh_requests.test.sql until "-- A refresh reservation shares the same company and identity occupancy as a"
-- A genuine refresh request/allocation is exempt in paid mode. Source and
-- checkpoints are SQL fixtures; no provider login, VM or payment is claimed.
reset role;
set local request.jwt.claims='{"role":"service_role"}';
insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
values('16500000-0000-4000-8000-000000000010','paid');
set local role service_role;
select public.qorpera_reserve_runtime_account_refresh_machine('66800000-0000-4000-8000-000000000060',
    'refresh-test',repeat('f',64),(current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid,repeat('e',64));
reset role;
do $$ declare
    allocation uuid:='66800000-0000-4000-8000-000000000060'; meter_epoch uuid:='66800000-0000-4000-8000-000000000061';
    normalized jsonb;
begin
    if not exists(select 1 from public.qorpera_runtime_machine_allocations where id=allocation
        and account_refresh_request_id=(current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid
        and login_session_id is null and run_id is null and office_id is null and coding_machine_id is null
        and released_at is null) then raise exception 'Paid refresh did not retain its own exempt source'; end if;
    perform public.qorpera_record_computer_usage_checkpoint(allocation,repeat('f',64),meter_epoch,0,0,0,clock_timestamp(),false,'login_helper',repeat('a',64));
    -- Explicit fixture shape ensures the refusal below comes from helper
    -- exemption, not merely from missing metering dimensions.
    update public.qorpera_computer_usage_streams set resource_shape='{"cpuMillis":8000,"memoryBytes":17179869184}'
        where allocation_id=allocation and epoch=meter_epoch;
    perform public.qorpera_record_computer_usage_checkpoint(allocation,repeat('f',64),meter_epoch,1,10000,10000,clock_timestamp(),false,'login_helper',repeat('b',64));
    normalized:=public.qorpera_standard_computer_time(10000,8000,17179869184,'login_helper',4000,8589934592);
    if normalized->>'numerator'<>'0' then raise exception 'Awake refresh helper consumed standard time'; end if;
    begin
        perform public.qorpera_record_computer_usage_checkpoint(allocation,repeat('f',64),meter_epoch,2,20000,20000,clock_timestamp(),false,'agent_sandbox',repeat('c',64));
        raise exception 'Refresh allocation accepted a paid sandbox label';
    exception when insufficient_privilege then null; end;
    begin
        perform public.qorpera_reserve_computer_allowance('66800000-0000-4000-8000-000000000062',
            '16500000-0000-4000-8000-000000000010',null,null,allocation,meter_epoch,1,clock_timestamp()+interval '5 minutes');
        raise exception 'Account refresh acquired a paid allowance hold';
    exception when object_not_in_prerequisite_state then null; end;
    if exists(select 1 from public.qorpera_coding_computer_permits where allocation_id=allocation)
        or exists(select 1 from public.qorpera_computer_allowance_reservations where allocation_id=allocation) then
        raise exception 'Exempt refresh created paid accounting custody'; end if;
end $$;
set local role service_role;
select public.qorpera_release_runtime_account_refresh_machine('66800000-0000-4000-8000-000000000060',
    'refresh-test',repeat('f',64),(current_setting('qorpera_test.refresh_request2')::jsonb->>'request_id')::uuid);
rollback;
