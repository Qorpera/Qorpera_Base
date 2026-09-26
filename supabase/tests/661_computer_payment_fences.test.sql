-- @fixture 635_computer_allowance_ledger.test.sql until "-- CONCURRENCY_FIXTURE_READY: prefix up to here can be committed in a disposable DB."
-- Real ledger/funding kernels; Stripe HTTP objects are covered separately.
insert into public.qorpera_computer_billing_keys(key_sha256,label)
    values(encode(extensions.digest(convert_to(repeat('F',64),'UTF8'),'sha256'),'hex'),'payment fence fixture');
insert into public.qorpera_profiles(id,name,created_by_user_id)
    values('66100000-0000-4000-8000-000000000010','Fence readiness','63500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
    values('66100000-0000-4000-8000-000000000010','63500000-0000-4000-8000-000000000001','ledger-one@example.test','Founder','owner');
insert into public.qorpera_company_computer_billing_modes(profile_id,mode) values('66100000-0000-4000-8000-000000000010','paid');
set local request.jwt.claims='{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000001"}';
select public.qorpera_set_company_computer_pool('66100000-0000-4000-8000-000000000010',true);
select pg_temp.assert_ledger((public.qorpera_company_computer_usage_status('66100000-0000-4000-8000-000000000010')->>'canStart')::boolean,'Paid fixture not ready before reversal');
set local request.jwt.claims='{"role":"service_role"}';

do $$ declare r uuid:='66100000-0000-4000-8000-000000000050'; p uuid:='63500000-0000-4000-8000-000000000010';
    u uuid:='63500000-0000-4000-8000-000000000001'; a uuid:='63500000-0000-4000-8000-000000000030';
    e uuid:='63500000-0000-4000-8000-000000000040'; deadline timestamptz:=statement_timestamp()+interval '10 minutes';
    proof jsonb:='{"invoiceId":"in_ledger1","subscriptionId":"sub_ledger1","customerId":"cus_ledger1","sourceId":"re_partial","reason":"refund"}';
    args jsonb; before jsonb; out jsonb; paid jsonb;
begin
    before:=public.qorpera_reserve_computer_allowance(r,p,u,null,a,e,1000000,deadline);
    args:=jsonb_build_object('p_event_id','evt_refund','p_body_sha256',repeat('f',64),'p_proof',proof);
    perform public.qorpera_computer_billing_rpc('qorpera_fence_computer_payment',args,repeat('F',64));
    perform public.qorpera_computer_billing_rpc('qorpera_fence_computer_payment',args,repeat('F',64));
    perform pg_temp.assert_ledger((select count(*)=1 from public.qorpera_computer_payment_fence_events),'Fence replay duplicated evidence');
    perform pg_temp.assert_ledger((select payment_fenced and reserved_us=1000000 and debited_us=0 and issued_us=74::bigint*3600000000
        from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1'),'Reversal mutated issued credit or existing hold');
    perform pg_temp.assert_ledger(before=public.qorpera_reserve_computer_allowance(r,p,u,null,a,e,1000000,deadline),'Existing hold replay was broken');
    perform pg_temp.assert_ledger(not (public.qorpera_company_computer_usage_status('66100000-0000-4000-8000-000000000010')->>'canStart')::boolean,'Founding counted reversed allowance');
    perform pg_temp.ledger_error(format('select public.qorpera_computer_billing_rpc(%L,%L,%L)','qorpera_fence_computer_payment',
        args||jsonb_build_object('p_body_sha256',repeat('a',64)),repeat('F',64)),'23505');
    perform pg_temp.ledger_error(format('select public.qorpera_computer_billing_rpc(%L,%L,%L)','qorpera_fence_computer_payment',
        args||jsonb_build_object('p_event_id','evt_other','p_proof',proof||'{"customerId":"cus_ledger2"}'),repeat('F',64)),'42501');
    -- A different company cannot draw the refunded member's remaining time.
    perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,null,%L,%L,1,%L)',
        '66100000-0000-4000-8000-000000000051','63500000-0000-4000-8000-000000000011',u,'63500000-0000-4000-8000-000000000031',e,deadline),'P0001');
    -- Settle real covered usage from the already-authorized hold, even after refund.
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,1,500,500,statement_timestamp()+interval '1 second',false,'coding_machine',repeat('e',64));
    out:=public.qorpera_settle_computer_allowance(r,1);
    perform pg_temp.assert_ledger(out='{"debitedUs":"500000","releasedUs":"500000"}'::jsonb,'Existing hold settlement was lost');
    perform pg_temp.assert_ledger(out=public.qorpera_settle_computer_allowance(r,1),'Settlement replay double charged');
    select payment_proof into paid from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1';
    perform public.qorpera_fund_computer_invoice(paid);
    perform pg_temp.assert_ledger((select payment_fenced and reserved_us=0 and debited_us=500000 from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1'),'Delayed paid replay revived reversed balance');
    perform pg_temp.ledger_error($q$update public.qorpera_computer_allowance_buckets set payment_fenced=false where invoice_id='in_ledger1'$q$,'42501');
    -- A cofounder can still supply genuinely funded pooled allowance.
    perform set_config('request.jwt.claims','{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000002"}',true);
    perform public.qorpera_set_company_computer_pool(p,true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    perform public.qorpera_reserve_computer_allowance('66100000-0000-4000-8000-000000000052',p,u,null,a,e,100,deadline);
    perform pg_temp.assert_ledger((select bucket.invoice_id='in_ledger2' from public.qorpera_computer_allowance_holds hold
        join public.qorpera_computer_allowance_buckets bucket on bucket.id=hold.bucket_id where hold.reservation_id='66100000-0000-4000-8000-000000000052'),'Pool fallback used reversed invoice');
end $$;

do $$ declare payload jsonb; proof jsonb; t timestamptz:=statement_timestamp()-interval '1 day'; claim jsonb; reason text; source text; i int:=0; begin
    -- Adverse event arrives before subscription or invoice funding. It must
    -- survive a later fresh paid event and every provider response retry.
    foreach reason in array array['dispute','credit_note','charge_adverse'] loop
        i:=i+1; source:=case reason when 'dispute' then 'du_' when 'credit_note' then 'cn_' else 'ch_' end||'future'||i;
        perform public.qorpera_fence_computer_payment('evt_future'||i,repeat('a',64),jsonb_build_object(
            'invoiceId','in_future'||i,'subscriptionId','sub_future'||i,'customerId','cus_ledger1','sourceId',source,'reason',reason));
        payload:=jsonb_build_object('subscriptionId','sub_future'||i,'customerId','cus_ledger1','userId','63500000-0000-4000-8000-000000000001',
            'planKey','basis','planVersion',1,'status','canceled','periodStart',t,'periodEnd',t+interval '1 month');
        proof:=jsonb_build_object('invoiceId','in_future'||i,'subscriptionId','sub_future'||i,'customerId','cus_ledger1','planKey','basis','planVersion',1,
            'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_cycle','status','paid','currency','dkk');
        claim:=public.qorpera_begin_computer_billing_sync('evt_paidFuture'||i,'sub_future'||i,t,repeat('b',64));
        perform public.qorpera_finish_computer_billing_sync('evt_paidFuture'||i,(claim->>'leaseToken')::uuid,payload,proof);
        perform pg_temp.assert_ledger((select payment_fenced from public.qorpera_computer_allowance_buckets where invoice_id='in_future'||i),'Delayed invoice funded past durable adverse fence');
    end loop;
    -- Cancellation alone is not a payment reversal; the paid period remains usable.
    select jsonb_build_object('subscriptionId',provider_subscription_id,'customerId',provider_customer_id,'userId',user_id,
        'planKey',plan_key,'planVersion',plan_version,'status','canceled','periodStart',period_start,'periodEnd',period_end)
        into payload from public.qorpera_computer_subscriptions where provider_subscription_id='sub_ledger2';
    perform public.qorpera_reconcile_computer_subscription('evt_cancel2',clock_timestamp(),payload);
    perform pg_temp.assert_ledger((select not payment_fenced and issued_us-reserved_us-debited_us>0 from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger2'),'Cancellation destroyed paid period');
end $$;
set local request.jwt.claims='{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000001"}';
select pg_temp.assert_ledger(public.qorpera_my_computer_usage()#>>'{balance,availableUs}'='0','Private balance advertised fenced time');
select pg_temp.assert_ledger(not has_function_privilege('service_role','public.qorpera_fence_computer_payment(text,text,jsonb)','EXECUTE')
    and not has_table_privilege('service_role','public.qorpera_computer_payment_fences','INSERT,UPDATE,DELETE'),'Guest can manipulate payment truth');
set local request.jwt.claims='{"role":"service_role"}';
set local role service_role;
do $$ begin
    begin perform public.qorpera_computer_billing_rpc('qorpera_fence_computer_payment','{}',repeat('X',64));
        raise exception 'Unauthenticated billing bridge accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
