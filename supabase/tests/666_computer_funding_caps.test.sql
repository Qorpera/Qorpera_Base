-- @fixture 635_computer_allowance_ledger.test.sql until "-- CONCURRENCY_FIXTURE_READY: prefix up to here can be committed in a disposable DB."
insert into public.qorpera_computer_billing_keys(key_sha256,label)
 values(encode(extensions.digest(convert_to(repeat('C',64),'UTF8'),'sha256'),'hex'),'canonical cap fixture');
create function pg_temp.cap(event text, reversed bigint, held boolean default false) returns void language plpgsql as $$
declare claim jsonb; begin
 claim:=public.qorpera_begin_computer_billing_sync(event,'sub_ledger1',statement_timestamp(),repeat('c',64));
 perform public.qorpera_computer_billing_rpc('qorpera_apply_computer_invoice_funding',jsonb_build_object(
  'p_event_id',event,'p_lease_token',claim->>'leaseToken','p_complete',true,'p_snapshot',jsonb_build_object(
  'evidence','{}','schema','qorpera.invoice-funding/v1','invoiceId','in_ledger1','subscriptionId','sub_ledger1','customerId','cus_ledger1',
  'currency','dkk','basisMinor',18500,'reversedMinor',reversed,'held',held,'evidenceSha256',encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'))),repeat('C',64));
end $$;

do $$ declare i bigint:=74::bigint*3600000000; p uuid:='63500000-0000-4000-8000-000000000010';
 u uuid:='63500000-0000-4000-8000-000000000001'; a uuid:='63500000-0000-4000-8000-000000000030'; e uuid:='63500000-0000-4000-8000-000000000040';
 r uuid:='66600000-0000-4000-8000-000000000050'; deadline timestamptz:=statement_timestamp()+interval '10 minutes';
 original jsonb; payment jsonb; out jsonb;
begin
 select jsonb_build_object('issued',issued_us,'start',period_start,'end',period_end,'proof',payment_proof),payment_proof into original,payment
  from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1';
 perform public.qorpera_reserve_computer_allowance(r,p,u,null,a,e,1000000,deadline);
 perform pg_temp.cap('evt_half',9250);
 perform pg_temp.assert_ledger((select issued_us=i and funded_us=i/2 and reserved_us=1000000 and debited_us=0 and not payment_fenced
  from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1'),'Partial refund did not preserve original issuance and hold');
 -- A concurrent company gets only the globally remaining cap, not another copy.
 perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,null,%L,%L,%s,%L)',
  '66600000-0000-4000-8000-000000000051','63500000-0000-4000-8000-000000000011',u,'63500000-0000-4000-8000-000000000031',e,i/2,deadline),'P0001');
 perform pg_temp.cap('evt_full',18500);
 perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,1,500,500,statement_timestamp()+interval '1 second',false,'coding_machine',repeat('e',64));
 out:=public.qorpera_settle_computer_allowance(r,1);
 perform pg_temp.assert_ledger(out='{"debitedUs":"500000","releasedUs":"500000"}'::jsonb,'Reduced cap broke an existing hold settlement');
 perform pg_temp.assert_ledger(out=public.qorpera_settle_computer_allowance(r,1),'Settlement replay double charged');
 perform set_config('request.jwt.claims','{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000001"}',true);
 perform pg_temp.assert_ledger(public.qorpera_my_computer_usage()#>>'{balance,availableUs}'='0','Reversal after consumption made negative availability');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.cap('evt_failedRefund',0);
 perform pg_temp.assert_ledger((select funded_us=i and debited_us=500000 and reserved_us=0 from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1'),'Failed refund did not restore only unused original credit');
 perform pg_temp.cap('evt_disputeOpen',0,true);
 perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,null,%L,%L,1,%L)',
  '66600000-0000-4000-8000-000000000052',p,u,a,e,deadline),'P0001');
 perform pg_temp.cap('evt_disputeWon',0,false);
 perform public.qorpera_fund_computer_invoice(payment);
 perform pg_temp.assert_ledger((select jsonb_build_object('issued',issued_us,'start',period_start,'end',period_end,'proof',payment_proof)=original
  and funded_us=i and debited_us=500000 and not payment_fenced from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1'),'Restoration changed period, issued amount, original proof or measured debit');
 perform public.qorpera_reserve_computer_allowance('66600000-0000-4000-8000-000000000053',p,u,null,a,e,100,deadline);
 perform pg_temp.assert_ledger((select count(*)=5 from public.qorpera_computer_invoice_funding_events),'Funding history lost');
end $$;

do $$ declare first jsonb; next jsonb; snapshot jsonb; args jsonb; old_end timestamptz; failure_detail text; begin
 snapshot:=jsonb_build_object('evidence','{}','schema','qorpera.invoice-funding/v1','invoiceId','in_ledger1','subscriptionId','sub_ledger1','customerId','cus_ledger1',
  'currency','dkk','basisMinor',18500,'reversedMinor',1,'held',false,'evidenceSha256',encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'));
 first:=public.qorpera_begin_computer_billing_sync('evt_stale','sub_ledger1',statement_timestamp(),repeat('a',64));
 update public.qorpera_computer_billing_syncs set lease_until=clock_timestamp()-interval '1 second' where subscription_id='sub_ledger1';
 next:=public.qorpera_begin_computer_billing_sync('evt_fresh','sub_ledger1',statement_timestamp(),repeat('b',64));
 args:=jsonb_build_object('p_event_id','evt_stale','p_lease_token',first->>'leaseToken','p_snapshot',snapshot,'p_complete',true);
 begin
  perform public.qorpera_computer_billing_rpc('qorpera_apply_computer_invoice_funding',args,repeat('C',64));
  raise exception 'Stale funding lease accepted';
 exception when sqlstate 'PGRST' then
  get stacked diagnostics failure_detail=pg_exception_detail;
  perform pg_temp.assert_ledger(sqlerrm::jsonb->>'code'='QRC01'
   and sqlerrm::jsonb->>'message'='Billing retrieval lease unavailable'
   and failure_detail::jsonb='{"status":409,"headers":{}}'::jsonb,'Stale funding lease lost application conflict identity');
 end;
 args:=args||jsonb_build_object('p_event_id','evt_fresh','p_lease_token',next->>'leaseToken');
 perform public.qorpera_computer_billing_rpc('qorpera_apply_computer_invoice_funding',args,repeat('C',64));
 perform pg_temp.assert_ledger((select funded_us=floor(issued_us::numeric*18499/18500) from public.qorpera_computer_allowance_buckets where invoice_id='in_ledger1'),'Cumulative cap rounding differs');
 first:=public.qorpera_begin_computer_billing_sync('evt_rebase','sub_ledger1',statement_timestamp(),repeat('e',64));
 args:=args||jsonb_build_object('p_event_id','evt_rebase','p_lease_token',first->>'leaseToken','p_snapshot',snapshot||'{"basisMinor":37000}');
 perform pg_temp.ledger_error(format('select public.qorpera_computer_billing_rpc(%L,%L,%L)','qorpera_apply_computer_invoice_funding',args,repeat('C',64)),'23505');
 perform public.qorpera_release_computer_billing_sync('evt_rebase',(first->>'leaseToken')::uuid);
end $$;

-- Reversal/restoration can be recorded before invoice.paid creates its bucket.
do $$ declare c jsonb; paid jsonb; sub jsonb; t timestamptz:=statement_timestamp()-interval '1 day'; begin
 c:=public.qorpera_begin_computer_billing_sync('evt_prepaid','sub_future666',t,repeat('6',64));
 perform public.qorpera_apply_computer_invoice_funding('evt_prepaid',(c->>'leaseToken')::uuid,jsonb_build_object(
  'evidence','{}','schema','qorpera.invoice-funding/v1','invoiceId','in_future666','subscriptionId','sub_future666','customerId','cus_ledger1',
  'currency','dkk','basisMinor',18500,'reversedMinor',9250,'held',false,'evidenceSha256',encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex')),true);
 sub:=jsonb_build_object('subscriptionId','sub_future666','customerId','cus_ledger1','userId','63500000-0000-4000-8000-000000000001',
  'planKey','basis','planVersion',1,'status','canceled','periodStart',t,'periodEnd',t+interval '1 month');
 paid:=jsonb_build_object('invoiceId','in_future666','subscriptionId','sub_future666','customerId','cus_ledger1','planKey','basis','planVersion',1,
  'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_cycle','status','paid','currency','dkk');
 c:=public.qorpera_begin_computer_billing_sync('evt_paid666','sub_future666',t,repeat('7',64));
 perform public.qorpera_finish_computer_billing_sync('evt_paid666',(c->>'leaseToken')::uuid,sub,paid);
 perform pg_temp.assert_ledger((select funded_us=issued_us/2 and not payment_fenced from public.qorpera_computer_allowance_buckets where invoice_id='in_future666'),'Late paid webhook bypassed canonical cap');
end $$;
select pg_temp.assert_ledger(not has_function_privilege('service_role','public.qorpera_apply_computer_invoice_funding(text,uuid,jsonb,boolean)','EXECUTE')
 and not has_table_privilege('service_role','public.qorpera_computer_invoice_funding','INSERT,UPDATE,DELETE'),'Shared runtime can restore financial authority');
select pg_temp.ledger_error($q$update public.qorpera_computer_invoice_funding_events set snapshot='{}'$q$,'42501');
select pg_temp.ledger_error($q$delete from public.qorpera_computer_invoice_funding_events$q$,'42501');
select pg_temp.ledger_error($q$update public.qorpera_computer_allowance_buckets set period_end=period_end+interval '1 day' where invoice_id='in_ledger1'$q$,'42501');
select pg_temp.ledger_error($q$update public.qorpera_computer_allowance_buckets set plan_key='standard' where invoice_id='in_ledger1'$q$,'42501');
rollback;
