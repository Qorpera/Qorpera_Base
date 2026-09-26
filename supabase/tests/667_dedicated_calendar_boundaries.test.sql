-- Actual funding/reservation/settlement kernels with explicitly synthetic invoice
-- proofs and admitted checkpoints. This is calendar/accounting evidence, not a
-- Stripe payment or physical VM observation. No production clock is replaced.
begin;
set local timezone='UTC';
set local request.jwt.claims='{"role":"service_role"}';
create function pg_temp.calendar_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.calendar_error(p_sql text,p_state text) returns void language plpgsql as $$
begin
    begin execute p_sql; exception when others then if sqlstate=p_state then return; end if; raise; end;
    raise exception 'Expected %: %',p_state,p_sql;
end $$;
insert into auth.users(id,email) values('66700000-0000-4000-8000-000000000001','dedicated-calendar@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
    ('66700000-0000-4000-8000-000000000010','Dedicated calendar','66700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
    ('66700000-0000-4000-8000-000000000010','66700000-0000-4000-8000-000000000001','dedicated-calendar@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
    ('66700000-0000-4000-8000-000000000020','66700000-0000-4000-8000-000000000010','Calendar',1,'66700000-0000-4000-8000-000000000001');
insert into public.qorpera_coding_machines(id,kind,profile_id,environment_id,member_user_id,owner,machine_id_sha256,binding,instance_sha256) values
    ('66700000-0000-4000-8000-000000000030','member','66700000-0000-4000-8000-000000000010','66700000-0000-4000-8000-000000000020',
     '66700000-0000-4000-8000-000000000001','calendar-test',repeat('a',64),'{}',repeat('b',64));
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_machine_id,provider_adapter,instance_sha256) values
    ('66700000-0000-4000-8000-000000000030','66700000-0000-4000-8000-000000000010','66700000-0000-4000-8000-000000000030','coding',repeat('b',64));
select public.qorpera_map_computer_billing_customer('66700000-0000-4000-8000-000000000001','cus_Calendar667');
create function pg_temp.calendar_fund(p_label text,p_start timestamptz,p_end timestamptz) returns uuid language plpgsql as $$
declare payload jsonb; proof jsonb; bucket uuid;
begin
    payload:=jsonb_build_object('subscriptionId','sub_Calendar667','customerId','cus_Calendar667',
        'userId','66700000-0000-4000-8000-000000000001','planKey','dedicated','planVersion',1,'status','active','periodStart',p_start,'periodEnd',p_end);
    perform public.qorpera_reconcile_computer_subscription('evt_Calendar667'||p_label,clock_timestamp(),payload);
    proof:=jsonb_build_object('invoiceId','in_Calendar667'||p_label,'subscriptionId','sub_Calendar667','customerId','cus_Calendar667',
        'planKey','dedicated','planVersion',1,'periodStart',p_start,'periodEnd',p_end,'amountPaid',159200,
        'billingReason','subscription_cycle','status','paid','currency','dkk');
    bucket:=public.qorpera_fund_computer_invoice(proof);
    perform pg_temp.calendar_assert(bucket=public.qorpera_fund_computer_invoice(proof),'Exact Dedicated invoice replay issued twice');
    perform pg_temp.calendar_error(format('select public.qorpera_fund_computer_invoice(%L)',proof||jsonb_build_object('invoiceId','in_Calendar667Duplicate'||p_label)),'23505');
    return bucket;
end $$;
do $$ declare item record; bucket uuid; begin
    for item in select * from (values
        ('LeapFebruary','2024-02-01T00:00:00Z'::timestamptz,'2024-03-01T00:00:00Z'::timestamptz,29*24),
        ('February','2025-02-01T00:00:00Z'::timestamptz,'2025-03-01T00:00:00Z'::timestamptz,28*24),
        ('April','2025-04-01T00:00:00Z'::timestamptz,'2025-05-01T00:00:00Z'::timestamptz,30*24),
        ('May','2025-05-01T00:00:00Z'::timestamptz,'2025-06-01T00:00:00Z'::timestamptz,31*24),
        ('OffsetSpring','2023-03-01T00:00:00+01'::timestamptz,'2023-04-01T00:00:00+02'::timestamptz,31*24-1)
    ) as cases(label,starts,ends,hours) loop
        bucket:=pg_temp.calendar_fund(item.label,item.starts,item.ends);
        perform pg_temp.calendar_assert((select issued_us=item.hours::bigint*3600000000 and reserved_us=0 and debited_us=0
            from public.qorpera_computer_allowance_buckets where id=bucket),'Dedicated grant must equal exact invoice seconds: '||item.label);
    end loop;
end $$;
-- Isolate the live boundary from fixed calendar examples even if this test is
-- rerun during one of those historical periods. The second subscription uses a
-- separate responsible member, with no pool consent to the calendar buckets.
insert into auth.users(id,email) values('66700000-0000-4000-8000-000000000002','dedicated-boundary@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
    ('66700000-0000-4000-8000-000000000010','66700000-0000-4000-8000-000000000002','dedicated-boundary@example.test','Boundary owner','contributor');
update public.qorpera_coding_machines set member_user_id='66700000-0000-4000-8000-000000000002'
    where id='66700000-0000-4000-8000-000000000030';
select public.qorpera_map_computer_billing_customer('66700000-0000-4000-8000-000000000002','cus_Boundary667');
do $$ declare
    boundary timestamptz:=clock_timestamp()+interval '2 seconds';
    allocation uuid:='66700000-0000-4000-8000-000000000030'; meter_epoch uuid:='66700000-0000-4000-8000-000000000040';
    company uuid:='66700000-0000-4000-8000-000000000010'; member_id uuid:='66700000-0000-4000-8000-000000000002';
    reservation uuid:='66700000-0000-4000-8000-000000000050'; successor uuid:='66700000-0000-4000-8000-000000000051';
    payload jsonb; proof jsonb; old_bucket uuid; new_bucket uuid; item integer; result jsonb; starts timestamptz; ends timestamptz;
begin
    for item in 1..2 loop
        starts:=case when item=1 then boundary-interval '1 month' else boundary end;
        ends:=case when item=1 then boundary else boundary+interval '1 month' end;
        payload:=jsonb_build_object('subscriptionId','sub_Boundary667','customerId','cus_Boundary667','userId',member_id,
            'planKey','dedicated','planVersion',1,'status','active','periodStart',starts,'periodEnd',ends);
        perform public.qorpera_reconcile_computer_subscription('evt_Boundary667'||item,clock_timestamp(),payload);
        proof:=jsonb_build_object('invoiceId','in_Boundary667'||item,'subscriptionId','sub_Boundary667','customerId','cus_Boundary667',
            'planKey','dedicated','planVersion',1,'periodStart',starts,'periodEnd',ends,'amountPaid',159200,
            'billingReason','subscription_cycle','status','paid','currency','dkk');
        if item=1 then old_bucket:=public.qorpera_fund_computer_invoice(proof); else new_bucket:=public.qorpera_fund_computer_invoice(proof); end if;
    end loop;
    perform public.qorpera_record_computer_usage_checkpoint(allocation,repeat('b',64),meter_epoch,0,0,0,clock_timestamp(),false,'coding_machine',repeat('c',64));
    -- Explicitly admitted standard-size fixture; no physical observation claimed.
    update public.qorpera_computer_usage_streams set resource_shape='{"cpuMillis":4000,"memoryBytes":8589934592}' where allocation_id=allocation and epoch=meter_epoch;
    -- Neither the expiring bucket nor a paid future bucket funds a window that
    -- crosses the boundary. Refusal must leave no partial hold/reservation.
    perform pg_temp.calendar_error(format('select public.qorpera_reserve_computer_allowance(%L,%L,%L,null,%L,%L,1000000,%L)',
        reservation,company,member_id,allocation,meter_epoch,boundary+interval '1 second'),'P0001');
    perform pg_temp.calendar_assert(not exists(select 1 from public.qorpera_computer_allowance_reservations where id=reservation),
        'Cross-period refusal left a reservation');
    result:=public.qorpera_reserve_computer_allowance(reservation,company,member_id,null,allocation,meter_epoch,1000000,boundary);
    perform pg_temp.calendar_assert((select bucket_id=old_bucket and amount_us=1000000 from public.qorpera_computer_allowance_holds where reservation_id=reservation),
        'A deadline exactly at period end must draw only the active old bucket');
    perform pg_temp.calendar_assert((select reserved_us=0 from public.qorpera_computer_allowance_buckets where id=new_bucket),
        'Future paid period was spendable early');
    -- Keep a genuine wall-clock boundary crossing: no updates of timestamps,
    -- fabricated now() function or production-clock injection.
    perform pg_sleep(greatest(0,extract(epoch from boundary-clock_timestamp()))+0.02);
    perform pg_temp.calendar_assert(result=public.qorpera_reserve_computer_allowance(reservation,company,member_id,null,allocation,meter_epoch,1000000,boundary),
        'Exact authorized reservation replay changed after expiry');
    perform pg_temp.calendar_assert(public.qorpera_settle_computer_allowance(reservation,0)='{"debitedUs":"0","releasedUs":"1000000"}'::jsonb,
        'Existing old-period hold could not settle its proven pre-boundary checkpoint');
    perform public.qorpera_reserve_computer_allowance(successor,company,member_id,null,allocation,meter_epoch,1000000,clock_timestamp()+interval '5 minutes');
    perform pg_temp.calendar_assert((select bucket_id=new_bucket from public.qorpera_computer_allowance_holds where reservation_id=successor),
        'Next window did not use newly active paid period');
    perform pg_temp.calendar_assert((select reserved_us=0 and debited_us=0 from public.qorpera_computer_allowance_buckets where id=old_bucket),
        'Expired bucket was reused or debited without usage');
    perform public.qorpera_settle_computer_allowance(successor,0);
    perform pg_temp.calendar_assert((select sum(reserved_us)=0 and sum(debited_us)=0 from public.qorpera_computer_allowance_buckets where user_id=member_id),
        'Period transition leaked a hold or charged synthetic awake time');
end $$;
rollback;
