-- @fixture 631_company_founding.test.sql until "-- Computer capacity supplied by A;"
-- Two verified, independently sponsored founders are already Ready. No
-- complimentary grant, founding receipt, ownership or execution is fabricated.
reset role;
create function pg_temp.assert_paid_founding(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
select pg_temp.org_claims('service_role');
select public.qorpera_map_computer_billing_customer('31000000-0000-4000-8000-000000000001','cus_foundingpaid1');
select public.qorpera_map_computer_billing_customer('31000000-0000-4000-8000-000000000002','cus_foundingpaid2');
do $$ declare i integer; payload jsonb; claim jsonb; t timestamptz:=statement_timestamp()-interval '1 day'; begin
    for i in 1..2 loop
        payload:=jsonb_build_object('subscriptionId','sub_foundingpaid'||i,'customerId','cus_foundingpaid'||i,
            'userId','31000000-0000-4000-8000-00000000000'||i,'planKey',case when i=1 then 'basis' else 'standard' end,
            'planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month');
        claim:=public.qorpera_begin_computer_billing_sync('evt_foundingpaid'||i,'sub_foundingpaid'||i,t,repeat('a',64));
        perform public.qorpera_finish_computer_billing_sync('evt_foundingpaid'||i,(claim->>'leaseToken')::uuid,payload,
            jsonb_build_object('invoiceId','in_foundingpaid'||i,'subscriptionId','sub_foundingpaid'||i,'customerId','cus_foundingpaid'||i,
                'planKey',payload->>'planKey','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month',
                'amountPaid',case when i=1 then 18500 else 63000 end,'billingReason','subscription_cycle','status','paid','currency','dkk'));
    end loop;
end $$;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),true);
select pg_temp.assert_paid_founding(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Paid invoices must not bypass explicit paid runtime mode');
select pg_temp.founding_denied(format('select public.qorpera_launch_company_founding(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),extensions.gen_random_uuid()),'55000');
reset role;
insert into public.qorpera_company_computer_billing_modes(profile_id,mode) values(pg_temp.founding_profile(),'paid');
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),true);
select pg_temp.assert_paid_founding(public.qorpera_company_computer_usage_status(pg_temp.founding_profile())#>>'{availableAllowance,availableUs}'=
    (360::bigint*3600000000)::text,'Two consenting plans do not expose their one global spendable balance');
select pg_temp.assert_paid_founding(public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'checkoutAvailable'='false',
    'Paid company status enabled checkout');
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),false);
reset role;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),false);
select pg_temp.assert_paid_founding(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Computer Usage owner or launcher bypassed explicit pool consent');
select pg_temp.founding_denied(format('select public.qorpera_launch_company_founding(%L,%s,%L)',
    pg_temp.founding_profile(),pg_temp.founding_revision(),extensions.gen_random_uuid()),'55000');
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),true);
reset role;
-- Exercise unavailable buckets through controlled operator fixtures, without
-- pretending to reserve a physical allocation that is not part of this test.
update public.qorpera_computer_allowance_buckets set reserved_us=issued_us where invoice_id='in_foundingpaid1';
set local role authenticated;
select pg_temp.assert_paid_founding(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Fully reserved allowance was promised to a new company');
reset role;
update public.qorpera_computer_allowance_buckets set reserved_us=0,period_end=statement_timestamp()-interval '1 minute' where invoice_id='in_foundingpaid1';
set local role authenticated;
select pg_temp.assert_paid_founding(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Expired invoice period admitted founding');
reset role;
update public.qorpera_computer_allowance_buckets set period_end=statement_timestamp()+interval '60 seconds' where invoice_id='in_foundingpaid1';
set local role authenticated;
select pg_temp.assert_paid_founding(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Period cannot cover first guarded start window');
reset role;
update public.qorpera_computer_allowance_buckets set period_end=statement_timestamp()+interval '1 month',reserved_us=issued_us-329999999 where invoice_id='in_foundingpaid1';
set local role authenticated;
select pg_temp.assert_paid_founding(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Less than first standard window should not promise startup');
reset role;
update public.qorpera_computer_allowance_buckets set reserved_us=0 where invoice_id='in_foundingpaid1';
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_set_company_computer_pool(pg_temp.founding_profile(),true);
select set_config('qorpera_test.paid_founding_launch',public.qorpera_launch_company_founding(
    pg_temp.founding_profile(),pg_temp.founding_revision(),'66000000-0000-4000-8000-000000000099')::text,true);
reset role;
do $$ declare request public.qorpera_session_turn_requests%rowtype; begin
    select * into strict request from public.qorpera_session_turn_requests where id=
        (current_setting('qorpera_test.paid_founding_launch')::jsonb#>>'{launch,turnRequestId}')::uuid;
    perform pg_temp.assert_paid_founding(request.requested_by_user_id='31000000-0000-4000-8000-000000000002'::uuid
        and request.sponsored_by_user_id=request.requested_by_user_id,'Paid pool changed member-bound model sponsor');
    perform pg_temp.assert_paid_founding((select count(*)=2 from public.qorpera_profile_members where profile_id=pg_temp.founding_profile() and role='owner'),
        'Paid noncreator launch did not produce two co-founders');
    perform pg_temp.assert_paid_founding((select sum(reserved_us)=0 and sum(debited_us)=0 from public.qorpera_computer_allowance_buckets
        where invoice_id in ('in_foundingpaid1','in_foundingpaid2')),'Founding status debited capacity without physical permit');
end $$;
set constraints all immediate;
rollback;
