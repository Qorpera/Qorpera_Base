begin;
create function pg_temp.computer_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.computer_error(p_sql text,p_state text) returns void language plpgsql as $$
begin
    begin execute p_sql; exception when others then
        if sqlstate=p_state then return; end if; raise; end;
    raise exception 'Expected %: %',p_state,p_sql;
end $$;
do $$ declare r jsonb; begin
    r:=public.qorpera_standard_computer_time(3600000,4000,8589934592,'company_computer',4000,8589934592);
    perform pg_temp.computer_assert((r->>'numerator')::numeric/(r->>'denominator')::numeric=3600000,'Standard awake hour is one standard hour');
    r:=public.qorpera_standard_computer_time(3600000,2000,4294967296,'coding_machine',4000,8589934592);
    perform pg_temp.computer_assert((r->>'numerator')::numeric/(r->>'denominator')::numeric=1800000,'Half-sized computer consumes half standard time');
    r:=public.qorpera_standard_computer_time(3600000,4000,17179869184,'company_computer',4000,8589934592);
    perform pg_temp.computer_assert((r->>'numerator')::numeric/(r->>'denominator')::numeric=7200000,'Memory-dominant size counts full reserved ratio');
    perform pg_temp.computer_assert(public.qorpera_standard_computer_time(1000,null,null,'coding_machine',4000,8589934592) is null,'Unknown resource shape is not billed');
    perform pg_temp.computer_assert(public.qorpera_standard_computer_time(1000,null,null,'login_helper',4000,8589934592)->>'numerator'='0','Login helpers consume zero standard time');
    perform pg_temp.computer_assert(public.qorpera_standard_computer_time(0,4000,8589934592,'company_computer',4000,8589934592)->>'numerator'='0','Sleeping time consumes zero');
    r:=public.qorpera_standard_computer_time(9223372036854775807,8000,17179869184,'company_computer',4000,8589934592);
    perform pg_temp.computer_assert((r->>'numerator')::numeric/(r->>'denominator')::numeric=18446744073709551614::numeric,'Normalization cannot overflow bigint multiplication');
end $$;
insert into auth.users(id,email) values
    ('63000000-0000-4000-8000-000000000001','computer-one@example.test'),
    ('63000000-0000-4000-8000-000000000002','computer-two@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
    values('63000000-0000-4000-8000-000000000010','Computer plans','63000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
    ('63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000001','computer-one@example.test','One','owner'),
    ('63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000002','computer-two@example.test','Two','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
    values('63000000-0000-4000-8000-000000000020','63000000-0000-4000-8000-000000000010','Computer plans',1,'63000000-0000-4000-8000-000000000001');
insert into public.qorpera_coding_machines(id,kind,profile_id,environment_id,member_user_id,owner,machine_id_sha256,binding,instance_sha256)
    values('63000000-0000-4000-8000-000000000030','member','63000000-0000-4000-8000-000000000010',
        '63000000-0000-4000-8000-000000000020','63000000-0000-4000-8000-000000000001','test',repeat('a',64),'{}',repeat('b',64));
insert into public.qorpera_runtime_machine_allocations(id,profile_id,coding_machine_id,provider_adapter,instance_sha256)
    values('63000000-0000-4000-8000-000000000030','63000000-0000-4000-8000-000000000010','63000000-0000-4000-8000-000000000030','coding',repeat('b',64));

set local request.jwt.claims='{"role":"authenticated","sub":"63000000-0000-4000-8000-000000000001"}';
select pg_temp.computer_assert((public.qorpera_company_computer_usage_status('63000000-0000-4000-8000-000000000010')->>'canStart')::boolean=false,
    'A company has no phantom free computer credits');
select pg_temp.computer_assert((select count(*)=3 and bool_and(not active_for_checkout) from public.qorpera_computer_plan_versions),'Three offers exist but cannot be sold');
select pg_temp.computer_assert((public.qorpera_computer_plan_catalog()#>>'{plans,0,monthlyPriceMinor}')::integer=18500,'Catalog prices use minor DKK');
select pg_temp.computer_error($q$select public.qorpera_grant_computer_entitlement('63000000-0000-4000-8000-000000000010',now()+interval '1 day','test','forged')$q$,'42501');
select public.qorpera_set_company_computer_pool('63000000-0000-4000-8000-000000000010',true);
insert into public.qorpera_account_entitlements(user_id,plan_key,billing_mode,feature_set,storage_allocation,operator_reference,reason)
    values('63000000-0000-4000-8000-000000000002','internal','complimentary','all','unlimited','test','explicit developer grant');
select pg_temp.computer_assert((public.qorpera_company_computer_usage_status('63000000-0000-4000-8000-000000000010')->>'canStart')::boolean=false,
    'Another member internal plan is unavailable without that member consent');
set local request.jwt.claims='{"role":"authenticated","sub":"63000000-0000-4000-8000-000000000002"}';
select public.qorpera_set_company_computer_pool('63000000-0000-4000-8000-000000000010',true);
select pg_temp.computer_assert((public.qorpera_company_computer_usage_status('63000000-0000-4000-8000-000000000010')->>'canStart')::boolean,'Explicit participating internal member permits setup');
select public.qorpera_set_company_computer_pool('63000000-0000-4000-8000-000000000010',false);
select pg_temp.computer_assert((public.qorpera_company_computer_usage_status('63000000-0000-4000-8000-000000000010')->>'canStart')::boolean=false,'Pool withdrawal takes effect immediately');

set local request.jwt.claims='{"role":"service_role"}';
do $$ declare p jsonb; t timestamptz:=statement_timestamp()-interval '10 minutes'; r jsonb; begin
    p:=jsonb_build_object('subscriptionId','sub_test','customerId','cus_test','userId','63000000-0000-4000-8000-000000000001',
        'planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month');
    r:=public.qorpera_reconcile_computer_subscription('evt_1',t,p);
    perform pg_temp.computer_assert(r=public.qorpera_reconcile_computer_subscription('evt_1',t,p),'Exact payment replay is idempotent');
    perform pg_temp.computer_error(format('select public.qorpera_reconcile_computer_subscription(%L,%L,%L)','evt_1',t,p||'{"status":"canceled"}'),'23505');
    perform pg_temp.computer_error(format('select public.qorpera_reconcile_computer_subscription(%L,%L,%L)','evt_null',t,p||'{"subscriptionId":null}'),'22023');
    perform public.qorpera_reconcile_computer_subscription('evt_2',t+interval '1 minute',p||'{"status":"canceled"}');
    r:=public.qorpera_reconcile_computer_subscription('evt_old',t-interval '1 minute',p);
    perform pg_temp.computer_assert(r->>'applied'='false' and (select status='canceled' from public.qorpera_computer_subscriptions where provider_subscription_id='sub_test'),
        'Out of order webhook never revives canceled subscription');
    perform pg_temp.computer_error(format('select public.qorpera_reconcile_computer_subscription(%L,%L,%L)','evt_rebind',t+interval '2 minutes',p||'{"userId":"63000000-0000-4000-8000-000000000002"}'),'42501');
    perform public.qorpera_grant_computer_entitlement('63000000-0000-4000-8000-000000000010',t+interval '1 day','test','grant_1');
    perform public.qorpera_grant_computer_entitlement('63000000-0000-4000-8000-000000000010',t+interval '1 day','test','grant_1');
    perform pg_temp.computer_assert((public.qorpera_company_computer_usage_status('63000000-0000-4000-8000-000000000010')->>'canStart')::boolean,'Explicit operator grant permits setup');
    perform public.qorpera_revoke_computer_entitlement('grant_1');
    perform pg_temp.computer_assert((public.qorpera_company_computer_usage_status('63000000-0000-4000-8000-000000000010')->>'canStart')::boolean=false,'Revoked grant is unavailable');
end $$;

do $$ declare a uuid:='63000000-0000-4000-8000-000000000030'; e uuid:='63000000-0000-4000-8000-000000000040';
    t timestamptz:=statement_timestamp()-interval '10 minutes'; r jsonb; begin
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,0,0,0,t,false,'coding_machine',repeat('c',64));
    perform pg_temp.computer_assert((select resource_shape is null from public.qorpera_computer_usage_streams where allocation_id=a and epoch=e),
        'Missing physical shape stays unknown and cannot manufacture billable resource units');
    r:=public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,1,10000,8000,t+interval '10 seconds',false,'coding_machine',repeat('d',64));
    perform pg_temp.computer_assert(r=public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,1,10000,8000,t+interval '10 seconds',false,'coding_machine',repeat('d',64)),'Checkpoint exact replay is idempotent');
    perform pg_temp.computer_error(format('select public.qorpera_record_computer_usage_checkpoint(%L,%L,%L,1,10000,9000,%L,false,%L,%L)',a,repeat('b',64),e,t+interval '10 seconds','coding_machine',repeat('d',64)),'23505');
    perform pg_temp.computer_error(format('select public.qorpera_record_computer_usage_checkpoint(%L,%L,%L,2,11000,10000,%L,false,%L,%L)',a,repeat('b',64),e,t+interval '11 seconds','coding_machine',repeat('d',64)),'22023');
    r:=public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),e,3,20000,15000,t+interval '20 seconds',true,'coding_machine',repeat('e',64));
    perform pg_temp.computer_assert(r->>'missingCheckpoints'='1' and r->>'charged'='false','Gap is explicit and shadow observation never charges');
    perform pg_temp.computer_assert((select active_ms=15000 from public.qorpera_computer_usage_streams where allocation_id=a),
        'Raw cumulative machine time is retained once, not summed checkpoints or concurrent sessions');
    perform pg_temp.computer_error(format('select public.qorpera_record_computer_usage_checkpoint(%L,%L,%L,4,30000,20000,%L,false,%L,%L)',a,repeat('b',64),e,t+interval '30 seconds','coding_machine',repeat('e',64)),'22023');
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),'63000000-0000-4000-8000-000000000041',0,0,0,t+interval '30 seconds',false,'coding_machine',repeat('e',64));
    perform pg_temp.computer_error(format('select public.qorpera_record_computer_usage_checkpoint(%L,%L,%L,0,0,0,%L,false,%L,%L)',a,repeat('b',64),'63000000-0000-4000-8000-000000000042',t+interval '31 seconds','coding_machine',repeat('e',64)),'23505');
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('b',64),'63000000-0000-4000-8000-000000000041',1,1000,0,t+interval '31 seconds',true,'coding_machine',repeat('e',64));
    -- A replacement identity cannot borrow an earlier epoch, even for replay.
    update public.qorpera_runtime_machine_allocations set instance_sha256=repeat('f',64) where id=a;
    perform pg_temp.computer_error(format('select public.qorpera_record_computer_usage_checkpoint(%L,%L,%L,0,0,0,%L,false,%L,%L)',a,repeat('f',64),e,t,'coding_machine',repeat('c',64)),'42501');
    perform public.qorpera_record_computer_usage_checkpoint(a,repeat('f',64),'63000000-0000-4000-8000-000000000042',0,0,0,t+interval '32 seconds',false,'coding_machine',repeat('e',64));
end $$;
select pg_temp.computer_assert(not has_table_privilege('authenticated','public.qorpera_computer_subscriptions','UPDATE')
    and not has_function_privilege('authenticated','public.qorpera_reconcile_computer_subscription(text,timestamptz,jsonb)','EXECUTE'),
    'Members cannot manufacture subscriptions');
rollback;
