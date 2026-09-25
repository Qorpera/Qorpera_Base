-- @fixture 396_runtime_coding_executor.test.sql until "-- 4. Control plane only."
-- Offline physical-permit tests. No guest or provider is started by this file.
select pg_temp.path_claims('service_role');
select public.qorpera_authorize_coding_machine_custody(current_setting('qorpera_test.coding_vm')::uuid,'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64),'stop');
select public.qorpera_suspend_coding_machine(current_setting('qorpera_test.coding_vm')::uuid,'exec-test',current_setting('qorpera_test.coding_binding'),repeat('c',64));
update public.qorpera_runtime_machine_allocations set released_at=clock_timestamp() where profile_id='30000000-0000-4000-8000-000000000010'
    and coding_machine_id is null and released_at is null;
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','paid-permit-parent-final');
select pg_temp.finish_job(run_id,'completed') from public.qorpera_runner_jobs where profile_id='30000000-0000-4000-8000-000000000010' and status in ('leased','running');
update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp()-interval '10 seconds'
    where allocation_id=current_setting('qorpera_test.coding_vm')::uuid;
insert into public.qorpera_company_computer_billing_modes(profile_id,mode) values('30000000-0000-4000-8000-000000000010','paid');
-- Test-only setup of a fresh, already-admitted physical VM attempt. The native
-- model harness remains unavailable in paid mode; this tests physical custody.
update public.qorpera_runtime_workers set state='active',result=null where id=(pg_temp.worker_row('fix-send')).id;
update public.qorpera_coding_sessions set phase='preparing',lease_owner='exec-test',lease_token='63700000-0000-4000-8000-000000000001',lease_until=clock_timestamp()+interval '5 minutes'
    where worker_id=(pg_temp.worker_row('fix-send')).id;
update public.qorpera_runtime_node_demands set suspended_at=null,last_checked_at=clock_timestamp(),last_refusal=null
    where allocation_id=current_setting('qorpera_test.coding_vm')::uuid;
insert into public.qorpera_computer_executor_keys(environment_id,owner,machine_id_sha256,key_sha256)
    values('30000000-0000-4000-8000-000000000020','exec-test',repeat('c',64),encode(extensions.digest(convert_to(repeat('K',64),'UTF8'),'sha256'),'hex'));
select public.qorpera_map_computer_billing_customer('30000000-0000-4000-8000-000000000001','cus_permits');
do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
    perform public.qorpera_reconcile_computer_subscription('evt_permits',t,jsonb_build_object('subscriptionId','sub_permits','customerId','cus_permits',
        'userId','30000000-0000-4000-8000-000000000001','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
    perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_permits','subscriptionId','sub_permits','customerId','cus_permits',
        'planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk'));
end $$;
insert into public.qorpera_runtime_node_instance_bindings(allocation_id,node_id,physical_id,binding)
    values(current_setting('qorpera_test.coding_vm')::uuid,'30000000-0000-4000-8000-000000000310','63700000-0000-4000-8000-000000000002','{}')
    on conflict(allocation_id) do update set physical_id=excluded.physical_id;

do $$ declare request jsonb; receipt jsonb; again jsonb; sample jsonb; checkpoint jsonb; renewal jsonb; terminal jsonb;
    id uuid:='63700000-0000-4000-8000-000000000010'; machine uuid:=current_setting('qorpera_test.coding_vm')::uuid;
    e uuid; t timestamptz; before_balance bigint; v_issue bigint; v_sequence bigint;
begin
    request:=jsonb_build_object('schema','qorpera.coding-computer-prepare/v1','requestId',id,'workerId',(pg_temp.worker_row('fix-send')).id,
        'leaseToken','63700000-0000-4000-8000-000000000001','machineId',machine,'owner','exec-test','bindingText',current_setting('qorpera_test.coding_binding'),
        'machineIdSha256',repeat('c',64),'hostBootId','63700000-0000-4000-8000-000000000003','windowMs',300000,'stopReserveMs',30000);
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',request,repeat('X',64)),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',request||jsonb_build_object('leaseToken',extensions.gen_random_uuid()),repeat('K',64)),'42501');
    receipt:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64)); e:=(receipt->>'epoch')::uuid;
    perform pg_temp.wake_assert(receipt->>'state'='prepared' and receipt->>'generation'='1' and receipt->'guestBootId'='null'::jsonb
        and (receipt->>'validForMs')::bigint between 1 and 330000,'Prestart hold has a bounded immutable permit with no invented boot');
    before_balance:=(select sum(reserved_us) from public.qorpera_computer_allowance_buckets);
    begin
        -- Isolate the protected-hold fence from ordinary machine capacity:
        -- even a sleeping demand cannot discard an unresolved paid permit.
        update public.qorpera_runtime_node_demands set suspended_at=clock_timestamp(),last_checked_at=clock_timestamp()-interval '10 seconds' where allocation_id=machine;
        update public.qorpera_company_computer_billing_modes set mode='shadow' where profile_id='30000000-0000-4000-8000-000000000010';
        raise exception 'Mode switch discarded an active paid hold';
    exception when object_not_in_prerequisite_state then null; end;
    perform pg_sleep(0.002);
    again:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
    perform pg_temp.wake_assert(again->>'issuedAt'=receipt->>'issuedAt' and again->>'deadline'=receipt->>'deadline'
        and (again->>'validForMs')::bigint<=(receipt->>'validForMs')::bigint
        and (select sum(reserved_us)=before_balance from public.qorpera_computer_allowance_buckets),'Prepare retry neither extends time nor duplicates funds');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',request||'{"windowMs":30000}',repeat('K',64)),'23505');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',request||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('K',64)),'55000');
    perform pg_temp.wake_error(format('select public.qorpera_settle_computer_allowance(%L,0)',id),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,null,%L,%L,1,now()+interval ''1 minute'')',
        extensions.gen_random_uuid(),'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001',machine,e),'42501');
    perform pg_temp.wake_error(format('select public.qorpera_record_computer_usage_checkpoint(%L,%L,%L,1,0,0,now(),true,%L,%L)',
        machine,receipt->>'instanceSha256',e,'coding_machine',repeat('a',64)),'42501');
    perform pg_temp.wake_assert(public.qorpera_observe_computer_usage(jsonb_build_object('allocationId',machine,'observationId',extensions.gen_random_uuid()))->>'reason'='paid_meter_owned',
        'Shadow observer must not own the paid epoch');
    -- Advance only the fixture's zero-observation baseline into the past so
    -- measured sample intervals can be tested without sleeping the test suite.
    t:=clock_timestamp()-interval '5 seconds';
    update public.qorpera_computer_usage_streams set observed_at=t-interval '1 second' where allocation_id=machine and epoch=e;
    update public.qorpera_computer_usage_receipts set observed_at=t-interval '1 second' where allocation_id=machine and epoch=e and sequence=0;
    sample:=jsonb_build_object('observationId','63700000-0000-4000-8000-000000000020','previousObservationId',null,
        'hostBootId','63700000-0000-4000-8000-000000000003','hostUptimeMs',1000000,'physicalId','63700000-0000-4000-8000-000000000002',
        'guestBootId','63700000-0000-4000-8000-000000000004','guestUptimeMs',100000,'observedAt',t,'state','running','evidenceSha256',repeat('a',64));
    checkpoint:=jsonb_build_object('permitId',id,'generation',1,'sample',sample);
    again:=public.qorpera_bind_coding_computer_permit(checkpoint,repeat('K',64));
    perform pg_temp.wake_assert(again#>>'{permit,state}'='bound' and (select active_ms=0 from public.qorpera_computer_usage_streams where allocation_id=machine and epoch=e),'Bind never backfills VM uptime');
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),'hostUptimeMs',1000100,'guestUptimeMs',100100,'observedAt',t+interval '100 milliseconds');
    checkpoint:=checkpoint||jsonb_build_object('sample',sample);
    again:=public.qorpera_checkpoint_coding_computer_permit(checkpoint,repeat('K',64));
    v_sequence:=(again->>'sequence')::bigint;
    perform pg_temp.wake_assert((public.qorpera_checkpoint_coding_computer_permit(checkpoint,repeat('K',64))->>'sequence')::bigint=v_sequence
        and (select active_ms=100 from public.qorpera_computer_usage_streams where allocation_id=machine and epoch=e),'Exact sample retries bill a measured interval once');
    perform pg_temp.wake_error(format('select public.qorpera_checkpoint_coding_computer_permit(%L,%L)',checkpoint||jsonb_build_object('sample',sample||'{"guestUptimeMs":100101}'),repeat('K',64)),'23505');
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),'hostUptimeMs',1020100,'guestUptimeMs',120100,'observedAt',t+interval '200 milliseconds');
    checkpoint:=checkpoint||jsonb_build_object('sample',sample);
    perform public.qorpera_checkpoint_coding_computer_permit(checkpoint,repeat('K',64));
    perform pg_temp.wake_assert((select active_ms=100 from public.qorpera_computer_usage_streams where allocation_id=machine and epoch=e),'Clock/observation gap cannot invent billable time');
    renewal:=jsonb_build_object('requestId','63700000-0000-4000-8000-000000000030','permitId',id,'generation',1,'sample',sample,'windowMs',300000,'stopReserveMs',30000);
    select issued_us into v_issue from public.qorpera_computer_allowance_buckets where invoice_id='in_permits';
    update public.qorpera_computer_allowance_buckets set issued_us=reserved_us+debited_us where invoice_id='in_permits';
    perform pg_temp.wake_error(format('select public.qorpera_renew_coding_computer_permit(%L,%L)',renewal,repeat('K',64)),'P0001');
    perform pg_temp.wake_assert((select permit.generation=1 from public.qorpera_coding_computer_permits permit where permit.id='63700000-0000-4000-8000-000000000010')
        and (select sum(debited_us)=0 from public.qorpera_computer_allowance_buckets),'Failed renewal released old hold or partially debited');
    update public.qorpera_computer_allowance_buckets set issued_us=v_issue where invoice_id='in_permits';
    receipt:=public.qorpera_renew_coding_computer_permit(renewal,repeat('K',64));
    again:=public.qorpera_renew_coding_computer_permit(renewal,repeat('K',64));
    perform pg_temp.wake_assert(receipt->>'generation'='2' and again->>'deadline'=receipt->>'deadline'
        and (again->>'validForMs')::bigint<=(receipt->>'validForMs')::bigint
        and (select sum(debited_us)=50000 from public.qorpera_computer_allowance_buckets),'Atomic renewal did not settle half-size known time exactly once');
    sample:=sample||jsonb_build_object('previousObservationId',sample->'observationId','observationId',extensions.gen_random_uuid(),
        'hostUptimeMs',1020200,'guestUptimeMs',null,'observedAt',t+interval '300 milliseconds','state','stopped');
    terminal:=jsonb_build_object('requestId','63700000-0000-4000-8000-000000000040','permitId',id,'generation',2,'sample',sample,'guardClosed',true);
    perform pg_temp.wake_error(format('select public.qorpera_finish_coding_computer_permit(%L,%L)',terminal||'{"guardClosed":false}',repeat('K',64)),'42501');
    receipt:=public.qorpera_finish_coding_computer_permit(terminal,repeat('K',64));
    perform pg_temp.wake_assert(receipt->>'state'='closed' and receipt->>'validForMs'='0'
        and public.qorpera_finish_coding_computer_permit(terminal,repeat('K',64))=receipt
        and (select sum(reserved_us)=0 and sum(debited_us)=50000 from public.qorpera_computer_allowance_buckets),
        'Verified stop/retry must settle once and release only unused holds');
    -- A failed create never acquired a guest boot; trusted absent/terminal proof
    -- can close its zero-usage reservation without manufacturing a measurement.
    request:=request||jsonb_build_object('requestId','63700000-0000-4000-8000-000000000050');
    update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp() where allocation_id=machine;
    receipt:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
    sample:=sample||jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,'physicalId',null,'guestBootId',null,
        'hostUptimeMs',1020300,'observedAt',clock_timestamp(),'state','absent');
    terminal:=jsonb_build_object('requestId',extensions.gen_random_uuid(),'permitId',receipt->'permitId','generation',1,'sample',sample,'guardClosed',true);
    perform public.qorpera_finish_coding_computer_permit(terminal,repeat('K',64));
    perform pg_temp.wake_assert((select sum(reserved_us)=0 and sum(debited_us)=50000 from public.qorpera_computer_allowance_buckets),'Never-started VM consumed allowance');
end $$;
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_computer_executor_keys','INSERT,UPDATE,DELETE')
    and not has_function_privilege('service_role','public.qorpera_record_computer_usage_checkpoint_internal(uuid,text,uuid,bigint,bigint,bigint,timestamptz,boolean,text,text)','EXECUTE')
    and not has_function_privilege('service_role','public.qorpera_reserve_computer_allowance_internal(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz)','EXECUTE')
    and not has_function_privilege('service_role','public.qorpera_settle_computer_allowance_internal(uuid,bigint)','EXECUTE'),
    'Guest service-role credentials cannot enroll executor authority or bypass managed accounting');
rollback;
