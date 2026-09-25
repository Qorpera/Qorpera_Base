begin;
create function pg_temp.assert_ledger(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.ledger_error(p_sql text,p_state text) returns void language plpgsql as $$
begin
    begin execute p_sql; exception when others then if sqlstate=p_state then return; end if; raise; end;
    raise exception 'Expected %: %',p_state,p_sql;
end $$;
insert into auth.users(id,email) values
    ('63500000-0000-4000-8000-000000000001','ledger-one@example.test'),
    ('63500000-0000-4000-8000-000000000002','ledger-two@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id,computer_usage_owner_user_id) values
    ('63500000-0000-4000-8000-000000000010','Ledger one','63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002'),
    ('63500000-0000-4000-8000-000000000011','Ledger two','63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
    select p.id,u.id,u.email,'Member',(case when u.id='63500000-0000-4000-8000-000000000001'::uuid then 'owner' else 'contributor' end)::public.qorpera_profile_role
    from public.qorpera_profiles p cross join auth.users u where p.id in ('63500000-0000-4000-8000-000000000010','63500000-0000-4000-8000-000000000011')
        and u.id in ('63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002');
update public.qorpera_profiles set computer_usage_owner_user_id='63500000-0000-4000-8000-000000000002'
    where id in ('63500000-0000-4000-8000-000000000010','63500000-0000-4000-8000-000000000011');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
    ('63500000-0000-4000-8000-000000000020','63500000-0000-4000-8000-000000000010','One',1,'63500000-0000-4000-8000-000000000001'),
    ('63500000-0000-4000-8000-000000000021','63500000-0000-4000-8000-000000000011','Two',1,'63500000-0000-4000-8000-000000000001');
insert into public.qorpera_coding_machines(id,kind,profile_id,environment_id,member_user_id,owner,machine_id_sha256,binding,instance_sha256) values
    ('63500000-0000-4000-8000-000000000030','member','63500000-0000-4000-8000-000000000010','63500000-0000-4000-8000-000000000020','63500000-0000-4000-8000-000000000001','test',repeat('a',64),'{}',repeat('b',64)),
    ('63500000-0000-4000-8000-000000000031','member','63500000-0000-4000-8000-000000000011','63500000-0000-4000-8000-000000000021','63500000-0000-4000-8000-000000000001','test',repeat('a',64),'{}',repeat('c',64));
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_machine_id,provider_adapter,instance_sha256)
    select id,profile_id,id,'coding',instance_sha256 from public.qorpera_coding_machines where id in ('63500000-0000-4000-8000-000000000030','63500000-0000-4000-8000-000000000031');
set local request.jwt.claims='{"role":"service_role"}';
select public.qorpera_map_computer_billing_customer('63500000-0000-4000-8000-000000000001','cus_ledger1');
select public.qorpera_map_computer_billing_customer('63500000-0000-4000-8000-000000000002','cus_ledger2');
do $$ declare i integer; p jsonb; proof jsonb; t timestamptz:=statement_timestamp()-interval '1 day'; id uuid; claim jsonb; begin
    for i in 1..2 loop
        p:=jsonb_build_object('subscriptionId','sub_ledger'||i,'customerId','cus_ledger'||i,'userId','63500000-0000-4000-8000-00000000000'||i,
            'planKey',case when i=1 then 'basis' else 'standard' end,'planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month');
        claim:=public.qorpera_begin_computer_billing_sync('evt_ledger'||i,'sub_ledger'||i,t,repeat('a',64));
        proof:=jsonb_build_object('invoiceId','in_ledger'||i,'subscriptionId','sub_ledger'||i,'customerId','cus_ledger'||i,
            'planKey',p->>'planKey','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,
            'billingReason','subscription_cycle','status','paid','currency','dkk');
        perform public.qorpera_finish_computer_billing_sync('evt_ledger'||i,(claim->>'leaseToken')::uuid,p,proof);
        id:=public.qorpera_fund_computer_invoice(proof);
        perform pg_temp.assert_ledger(id=public.qorpera_fund_computer_invoice(proof),'Exact invoice replay issued duplicate allowance');
        perform pg_temp.ledger_error(format('select public.qorpera_fund_computer_invoice(%L)',proof||'{"amountPaid":1}'),'23505');
        perform pg_temp.ledger_error(format('select public.qorpera_fund_computer_invoice(%L)',proof||jsonb_build_object('invoiceId','in_duplicate'||i)),'23505');
    end loop;
    -- Calendar-month plan issues actual period duration, including short months.
    p:=p||jsonb_build_object('subscriptionId','sub_dedicated','planKey','dedicated','periodStart','2026-02-01T00:00:00Z','periodEnd','2026-03-01T00:00:00Z');
    perform public.qorpera_reconcile_computer_subscription('evt_dedicated',t,p);
    proof:=proof||jsonb_build_object('invoiceId','in_dedicated','subscriptionId','sub_dedicated','planKey','dedicated','periodStart','2026-02-01T00:00:00Z','periodEnd','2026-03-01T00:00:00Z');
    id:=public.qorpera_fund_computer_invoice(proof);
    perform pg_temp.assert_ledger((select issued_us=28::bigint*24*3600000000 from public.qorpera_computer_allowance_buckets where invoice_id='in_dedicated'),'Dedicated must use exact February period');
end $$;

do $$ declare a uuid; e uuid:='63500000-0000-4000-8000-000000000040'; t timestamptz:=statement_timestamp(); begin
    foreach a in array array['63500000-0000-4000-8000-000000000030'::uuid,'63500000-0000-4000-8000-000000000031'::uuid] loop
        perform public.qorpera_record_computer_usage_checkpoint(a,case when a='63500000-0000-4000-8000-000000000030'::uuid then repeat('b',64) else repeat('c',64) end,e,0,0,0,t,false,'coding_machine',repeat('d',64));
    end loop;
    -- Fixture supplies admitted trusted shape. The kernel never defaults it.
    update public.qorpera_computer_usage_streams set resource_shape='{"cpuMillis":4000,"memoryBytes":8589934592}' where epoch=e;
end $$;
-- CONCURRENCY_FIXTURE_READY: prefix up to here can be committed in a disposable DB.
do $$ declare r uuid:='63500000-0000-4000-8000-000000000050'; p uuid:='63500000-0000-4000-8000-000000000010';
    u uuid:='63500000-0000-4000-8000-000000000001'; v uuid:='63500000-0000-4000-8000-000000000002';
    a uuid:='63500000-0000-4000-8000-000000000030'; e uuid:='63500000-0000-4000-8000-000000000040'; deadline timestamptz:=statement_timestamp()+interval '10 minutes';
    basis bigint:=74::bigint*3600000000; out jsonb; begin
    perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,%L,%L,%L,%L,%L)',r,p,u,v,a,e,basis+10,deadline),'P0001');
    perform pg_temp.assert_ledger((select sum(reserved_us)=0 from public.qorpera_computer_allowance_buckets),'Failed pool reservation leaked partial debit');
    perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,%L,%L,%L,10,%L)',r,p,v,v,a,e,deadline),'42501');
    -- Usage owner is a contact, not consent. Explicit self opt-in is required.
    perform set_config('request.jwt.claims','{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000002"}',true);
    perform public.qorpera_set_company_computer_pool(p,true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    out:=public.qorpera_reserve_computer_allowance(r,p,u,v,a,e,basis+10,deadline);
    perform pg_temp.assert_ledger(out=public.qorpera_reserve_computer_allowance(r,p,u,v,a,e,basis+10,deadline),'Reservation exact replay differs');
    perform pg_temp.assert_ledger((select h.amount_us=basis from public.qorpera_computer_allowance_holds h join public.qorpera_computer_allowance_buckets b on b.id=h.bucket_id where h.reservation_id=r and h.draw_order=1 and b.user_id=u),'Direct member allowance was not drawn first');
    perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,%L,%L,%L,%L,%L)',r,p,u,v,a,e,basis+11,deadline),'23505');
    -- The same owner cannot reuse their reserved allowance in a second company.
    perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,null,%L,%L,1,%L)',
        '63500000-0000-4000-8000-000000000051','63500000-0000-4000-8000-000000000011',u,'63500000-0000-4000-8000-000000000031',e,deadline),'P0001');
    perform set_config('request.jwt.claims','{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000002"}',true);
    perform public.qorpera_set_company_computer_pool('63500000-0000-4000-8000-000000000011',true);
    perform public.qorpera_set_company_computer_pool(p,false);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    perform public.qorpera_reserve_computer_allowance('63500000-0000-4000-8000-000000000051','63500000-0000-4000-8000-000000000011',u,null,'63500000-0000-4000-8000-000000000031',e,100,deadline);
    -- Revocation stops new reservations, but already authorized usage settles.
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,1,1000,1000,statement_timestamp()+interval '1 second',false,'coding_machine',repeat('e',64));
    out:=public.qorpera_settle_computer_allowance(r,1);
    perform pg_temp.assert_ledger(out->>'debitedUs'='1000000' and (out->>'releasedUs')::bigint=basis+10-1000000,'Settlement did not debit exact physical elapsed standard time');
    perform pg_temp.assert_ledger(out=public.qorpera_settle_computer_allowance(r,1),'Settlement exact retry double charged');
    perform pg_temp.ledger_error(format('select public.qorpera_settle_computer_allowance(%L,0)',r),'23505');
    perform pg_temp.assert_ledger((select sum(debited_us)=1000000 and sum(reserved_us)=100 from public.qorpera_computer_allowance_buckets),'Global conservation failed');
    perform pg_temp.ledger_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,%L,%L,%L,%L,%L)',extensions.gen_random_uuid(),p,u,v,a,e,basis,deadline),'P0001');
    -- Runtime must stop within its bounded hold. An overrun neither silently
    -- overdrafts nor refunds funds while the incident remains unresolved.
    perform public.qorpera_reserve_computer_allowance('63500000-0000-4000-8000-000000000052',p,u,v,a,e,1,deadline);
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,2,2000,2000,statement_timestamp()+interval '2 seconds',false,'coding_machine',repeat('f',64));
    perform pg_temp.ledger_error($q$select public.qorpera_settle_computer_allowance('63500000-0000-4000-8000-000000000052',2)$q$,'55000');
    perform pg_temp.assert_ledger((select sum(debited_us)=1000000 and sum(reserved_us)=101 from public.qorpera_computer_allowance_buckets),'Overrun consumed unreserved allowance');
    -- A finite hold is not freed by timeout: physical stop/settlement is required.
    update public.qorpera_computer_allowance_reservations set deadline=statement_timestamp()-interval '1 second' where id='63500000-0000-4000-8000-000000000051';
    perform pg_temp.assert_ledger((select sum(reserved_us)=101 from public.qorpera_computer_allowance_buckets),'Timeout silently refunded an unconfirmed computer');
end $$;
set local request.jwt.claims='{"role":"authenticated","sub":"63500000-0000-4000-8000-000000000001"}';
select pg_temp.assert_ledger(public.qorpera_my_computer_usage()#>>'{balance,issuedUs}'=(74::bigint*3600000000)::text,'Private balance includes another member allowance');
select pg_temp.assert_ledger(public.qorpera_my_computer_usage()->>'checkoutAvailable'='false','Ledger accidentally enabled paid Checkout');
select pg_temp.assert_ledger(not has_function_privilege('authenticated','public.qorpera_reserve_computer_allowance(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz)','EXECUTE')
    and not has_table_privilege('service_role','public.qorpera_computer_allowance_buckets','UPDATE'),'Untrusted caller can manufacture or move balance');
rollback;
