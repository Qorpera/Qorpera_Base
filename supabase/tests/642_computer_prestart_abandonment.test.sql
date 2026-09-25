-- @fixture 637_coding_computer_permits.test.sql until "do $$ declare request jsonb; receipt jsonb;"
-- Only fake host journal receipts; SQL uses real allocation, funding and custody.
create function pg_temp.abandon_request(p_prepare jsonb) returns jsonb language plpgsql as $$
declare r jsonb:=pg_temp.prestart_request(p_prepare); begin
    return jsonb_build_object('schema','qorpera.computer-abandon/v1','requestId',extensions.gen_random_uuid(),
        'permitId',r->'requestId','generation',1,'prepareRequestText',r->'prepareRequestText',
        'abandonment',jsonb_build_object('schema','qorpera.computer-prestart-abandonment/v1','permitId',r->'requestId',
            'allocationId',r->'machineId','instanceSha256',encode(extensions.digest(convert_to(r->>'bindingText','UTF8'),'sha256'),'hex'),
            'hostMachineIdSha256',r->'machineIdSha256','hostBootId',r->'hostBootId',
            'prepareSha256',r#>'{prestart,prepareSha256}','guardIncarnationId',r#>'{prestart,guardIncarnationId}'));
end $$;
-- A second consenting founder contributes to the same original reservation.
select public.qorpera_map_computer_billing_customer('30000000-0000-4000-8000-000000000002','cus_prestartpool');
do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
    perform public.qorpera_reconcile_computer_subscription('evt_prestartpool',t,jsonb_build_object('subscriptionId','sub_prestartpool','customerId','cus_prestartpool',
        'userId','30000000-0000-4000-8000-000000000002','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
    perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_prestartpool','subscriptionId','sub_prestartpool','customerId','cus_prestartpool',
        'planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk'));
    perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
    perform public.qorpera_set_company_computer_pool('30000000-0000-4000-8000-000000000010',true);
    perform pg_temp.path_claims('service_role');
end $$;
update public.qorpera_computer_allowance_buckets set issued_us=100000000 where invoice_id='in_permits';
do $$ declare request jsonb; cancellation jsonb; result jsonb; receipt jsonb; sample jsonb; baseline jsonb; held bigint;
    first_cancel_id uuid; machine uuid:=current_setting('qorpera_test.coding_vm')::uuid; attempt uuid:='64200000-0000-4000-8000-000000000010';
begin
    request:=pg_temp.prestart_request(jsonb_build_object('schema','qorpera.coding-computer-prepare/v2','requestId',attempt,
        'workerId',(pg_temp.worker_row('fix-send')).id,'leaseToken','63700000-0000-4000-8000-000000000001',
        'machineId',machine,'owner','exec-test','bindingText',current_setting('qorpera_test.coding_binding'),
        'machineIdSha256',repeat('c',64),'hostBootId','64200000-0000-4000-8000-000000000011','windowMs',300000,'stopReserveMs',30000));
    cancellation:=pg_temp.abandon_request(request); first_cancel_id:=(cancellation->>'requestId')::uuid;
    perform pg_temp.wake_assert(public.qorpera_describe_coding_computer_prestart(request-'leaseToken',repeat('K',64))->>'state'='absent', 'Unknown intent recovery invented a hold');
    perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',cancellation,repeat('X',64)),'42501');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_computer_prestart_attempts),'Wrong key created cancellation authority');
    result:=public.qorpera_abandon_coding_computer_permit(cancellation,repeat('K',64));
    perform pg_temp.wake_assert(result->>'state'='abandoned_before_dispatch' and result->'reservationReleased'='false'
        and result->>'releasedUs'='0' and public.qorpera_abandon_coding_computer_permit(cancellation,repeat('K',64))=result,
        'Absent prepare abandonment must be durable and idempotent');
    perform pg_temp.wake_assert(public.qorpera_describe_coding_computer_prestart(request-'leaseToken',repeat('K',64))->'closure'=result, 'Absent prepare tombstone was not discoverable');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',request,repeat('K',64)),'55000');
    perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',
        cancellation||jsonb_build_object('requestId',extensions.gen_random_uuid()),repeat('K',64)),'23505');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_coding_computer_permits),'Delayed prepare escaped cancellation tombstone');
    request:=pg_temp.prestart_request(request||jsonb_build_object('requestId','64200000-0000-4000-8000-000000000020'));
    attempt:=(request->>'requestId')::uuid; cancellation:=pg_temp.abandon_request(request);
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',
        (request-'prestart'-'prepareRequestText')||'{"schema":"qorpera.coding-computer-prepare/v1"}',repeat('K',64)),'22023');
    select jsonb_agg(jsonb_build_array(id,issued_us,reserved_us,debited_us) order by id) into baseline from public.qorpera_computer_allowance_buckets;
    receipt:=public.qorpera_prepare_coding_computer_permit(request,repeat('K',64));
    perform pg_temp.wake_assert(receipt->>'schema'='qorpera.computer-usage-permit/v2' and receipt->'prestart'=request->'prestart',
        'Prepared receipt lost durable guard identity');
    perform pg_temp.wake_assert(public.qorpera_describe_coding_computer_prestart(request-'leaseToken',repeat('K',64))->>'state'='prepared', 'Exact intent could not recover a lost prepare reply');
    select sum(amount_us) into held from public.qorpera_computer_allowance_holds where reservation_id=attempt;
    perform pg_temp.wake_assert((select count(*)=2 from public.qorpera_computer_allowance_holds where reservation_id=attempt),'Fixture did not reserve both founders');
    -- Reusing a cancellation command ID for another attempt fails atomically.
    perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',
        cancellation||jsonb_build_object('requestId',first_cancel_id),repeat('K',64)),'23505');
    perform pg_temp.wake_assert((select settled_at is null from public.qorpera_computer_allowance_reservations where id=attempt), 'Conflicting command partially returned a hold');
    -- Legacy holds may not manufacture missing journal history.
    begin
        delete from public.qorpera_computer_prestart_attempts where permit_id=attempt;
        perform pg_temp.wake_error(format('select public.qorpera_describe_coding_computer_prestart(%L,%L)',request-'leaseToken',repeat('K',64)),'55000');
        perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',cancellation,repeat('K',64)),'55000');
        raise exception using errcode='QT642';
    exception when sqlstate 'QT642' then null; end;
    perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',
        jsonb_set(cancellation,'{abandonment,guardIncarnationId}',to_jsonb(extensions.gen_random_uuid())),repeat('K',64)),'23505');
    perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',cancellation||'{"generation":2}',repeat('K',64)),'22023');
    -- Even a zero-use first bound observation makes abandonment inadmissible.
    begin
        sample:=jsonb_build_object('observationId',extensions.gen_random_uuid(),'previousObservationId',null,
            'hostBootId',request->'hostBootId','hostUptimeMs',1000,'physicalId','63700000-0000-4000-8000-000000000002',
            'guestBootId',extensions.gen_random_uuid(),'guestUptimeMs',100,'observedAt',clock_timestamp(),'state','running','evidenceSha256',repeat('a',64));
        perform public.qorpera_bind_coding_computer_permit(jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('K',64));
        perform pg_temp.wake_error(format('select public.qorpera_abandon_coding_computer_permit(%L,%L)',cancellation,repeat('K',64)),'55000');
        raise exception using errcode='QT642';
    exception when sqlstate 'QT642' then null; end;
    -- Expiry is irrelevant: retain the original valid zero checkpoint while
    -- moving only this test's initial window into the past.
    update public.qorpera_computer_usage_streams set observed_at=clock_timestamp()-interval '2 hours' where allocation_id=machine;
    update public.qorpera_computer_usage_receipts set observed_at=clock_timestamp()-interval '2 hours' where allocation_id=machine;
    update public.qorpera_coding_computer_windows set issued_at=clock_timestamp()-interval '2 hours',deadline=clock_timestamp()-interval '1 hour' where permit_id=attempt;
    update public.qorpera_computer_allowance_reservations set deadline=clock_timestamp()-interval '1 hour' where id=attempt;
    perform pg_temp.wake_assert((select settled_at is null from public.qorpera_computer_allowance_reservations where id=attempt),'Expiry refunded a hold automatically');
    result:=public.qorpera_abandon_coding_computer_permit(cancellation,repeat('K',64));
    perform pg_temp.wake_assert(result->'reservationReleased'='true' and result->>'debitedUs'='0' and (result->>'releasedUs')::bigint=held
        and public.qorpera_abandon_coding_computer_permit(cancellation,repeat('K',64))=result,'Zero-use closure must release once');
    perform pg_temp.wake_assert((select jsonb_agg(jsonb_build_array(id,issued_us,reserved_us,debited_us) order by id)=baseline from public.qorpera_computer_allowance_buckets),
        'Cancellation transferred or minted pooled allowance');
    perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_computer_allowance_debits debit
        join public.qorpera_computer_allowance_holds hold using(reservation_id,bucket_id)
        where debit.reservation_id=attempt and (debit.debited_us<>0 or debit.released_us<>hold.amount_us)), 'Original source holds did not return exactly');
    perform pg_temp.wake_assert((select state='closed' and last_sample is null and physical_id is null from public.qorpera_coding_computer_permits where id=attempt)
        and (select closed and last_sequence=0 and active_ms=0 from public.qorpera_computer_usage_streams where allocation_id=machine)
        and not exists(select 1 from public.qorpera_coding_computer_samples where permit_id=attempt)
        and (select released_at is null from public.qorpera_runtime_machine_allocations where id=machine)
        and (select released_at is null from public.qorpera_runtime_node_demands where allocation_id=machine), 'Cancellation fabricated usage or discarded physical custody');
    perform pg_temp.wake_error(format('select public.qorpera_prepare_coding_computer_permit(%L,%L)',request,repeat('K',64)),'55000');
    perform pg_temp.wake_error(format('select public.qorpera_bind_coding_computer_permit(%L,%L)',
        jsonb_build_object('permitId',attempt,'generation',1,'sample',sample),repeat('K',64)),'PGRST');
    receipt:=public.qorpera_describe_coding_computer_permit(request||jsonb_build_object('permitId',attempt),repeat('K',64));
    perform pg_temp.wake_assert(receipt#>'{permit,closure}'=result and receipt#>>'{permit,validForMs}'='0','Lost reply recovery omitted terminal decision');
    receipt:=public.qorpera_describe_coding_computer_prestart(request-'leaseToken',repeat('K',64));
    perform pg_temp.wake_assert(receipt->>'state'='abandoned' and receipt->'closure'=result,'Exact coding intent did not recover terminal closure');
end $$;
do $$ declare role_name text; v_caller regprocedure; v_helper regprocedure; begin
    foreach role_name in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(role_name,'public.qorpera_computer_prestart_attempts','SELECT,INSERT,UPDATE,DELETE'), 'Guard tombstone exposed');
        foreach v_helper in array array['public.qorpera_abandon_computer_prestart(jsonb,text,text)'::regprocedure,
            'public.qorpera_describe_computer_prestart(jsonb,text,text)'::regprocedure,
            'public.qorpera_register_computer_prestart(jsonb,text,text)'::regprocedure,'public.qorpera_computer_prestart_identity(jsonb,text,text)'::regprocedure,
            'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure,'public.qorpera_computer_permit_receipt_before_prestart(uuid,bigint)'::regprocedure] loop
            perform pg_temp.wake_assert(not has_function_privilege(role_name,v_helper,'EXECUTE'), 'Private prestart helper exposed');
        end loop;
    end loop;
    foreach v_caller in array array['public.qorpera_prepare_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_describe_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_checkpoint_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_renew_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_runtime_computer_receipt(uuid,bigint)'::regprocedure] loop
        perform pg_temp.wake_assert((select prosecdef and has_function_privilege(proowner,'public.qorpera_computer_permit_receipt(uuid,bigint)','EXECUTE')
            from pg_proc where oid=v_caller), 'Receipt wrapper lost trusted caller access');
    end loop;
    foreach v_caller in array array['public.qorpera_prepare_coding_computer_permit(jsonb,text)'::regprocedure,
        'public.qorpera_prepare_runtime_computer_permit(jsonb,text)'::regprocedure] loop
        perform pg_temp.wake_assert((select prosecdef and has_function_privilege(proowner,'public.qorpera_register_computer_prestart(jsonb,text,text)','EXECUTE')
            from pg_proc where oid=v_caller), 'Prepare owner lost registration access');
    end loop;
    perform pg_temp.wake_assert((select has_function_privilege(proowner,'public.qorpera_computer_permit_receipt_before_prestart(uuid,bigint)','EXECUTE')
        from pg_proc where oid='public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure), 'Receipt wrapper lost predecessor access');
end $$;
rollback;
