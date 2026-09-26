-- @fixture 631_company_founding.test.sql until "-- Computer capacity supplied by A;"
reset role;
create function pg_temp.assert_rollout(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.founding_denied(format('select public.qorpera_enroll_founding_paid_computers(%L)',pg_temp.founding_profile()),'42501');
select public.qorpera_read_company_founding(pg_temp.founding_profile());
reset role;
select pg_temp.assert_rollout(not public.qorpera_company_paid_computer_mode(pg_temp.founding_profile()),'Default flags enrolled paid mode');
-- Explicit operator shadow mode must remain an intentional hold during rollout.
insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values((current_setting('qorpera_test.founding_retry')::jsonb->>'profile_id')::uuid,'shadow');
update public.qorpera_computer_billing_readiness set runtime_accounting_ready=true where singleton;
set local role authenticated;
select public.qorpera_read_company_founding(pg_temp.founding_profile());
reset role;
select pg_temp.assert_rollout(not public.qorpera_company_paid_computer_mode(pg_temp.founding_profile()),'Runtime readiness alone published paid founding');
update public.qorpera_computer_billing_readiness set checkout_enabled=true where singleton;
-- An uninvited user cannot make a denied read persist rollout enrollment.
insert into auth.users(id,email,email_confirmed_at) values
    ('66200000-0000-4000-8000-000000000003','rollout-outsider@example.test',now());
select pg_temp.org_claims('authenticated','66200000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.founding_denied(format('select public.qorpera_read_company_founding(%L)',pg_temp.founding_profile()),'42501');
reset role;
select pg_temp.assert_rollout(not public.qorpera_company_paid_computer_mode(pg_temp.founding_profile()),'Unauthorized read changed paid mode');
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_read_company_founding(pg_temp.founding_profile());
select public.qorpera_read_company_founding((current_setting('qorpera_test.founding_retry')::jsonb->>'profile_id')::uuid);
select set_config('qorpera_test.rollout_new',public.qorpera_begin_company_founding(
    '66200000-0000-4000-8000-000000000001','Published paid setup',2)::text,true);
reset role;
select pg_temp.assert_rollout(public.qorpera_company_paid_computer_mode(pg_temp.founding_profile()),'Pre-rollout open setup stayed shadow on authorized refresh');
select pg_temp.assert_rollout(public.qorpera_company_paid_computer_mode((current_setting('qorpera_test.rollout_new')::jsonb->>'profile_id')::uuid),
    'New production creation did not enroll paid mode');
select pg_temp.assert_rollout(not public.qorpera_company_paid_computer_mode((current_setting('qorpera_test.founding_retry')::jsonb->>'profile_id')::uuid),
    'Explicit operator shadow mode was overwritten');
select pg_temp.assert_rollout(not (public.qorpera_company_computer_usage_status(pg_temp.founding_profile())->>'canStart')::boolean,
    'Rollout enabled company startup without paid invoice and pool consent');
select pg_temp.assert_rollout(not exists(select 1 from public.qorpera_company_computer_pool_members where profile_id=pg_temp.founding_profile() and enabled),
    'Rollout fabricated founder pool consent');
-- Closing purchases must never turn an enrolled paid computer into free runtime.
update public.qorpera_computer_billing_readiness set checkout_enabled=false,runtime_accounting_ready=false where singleton;
set local role authenticated;
select public.qorpera_read_company_founding(pg_temp.founding_profile());
select set_config('qorpera_test.rollout_disabled',public.qorpera_begin_company_founding(
    '66200000-0000-4000-8000-000000000002','Unpublished setup',2)::text,true);
reset role;
select pg_temp.assert_rollout(public.qorpera_company_paid_computer_mode(pg_temp.founding_profile()),'Rollout disablement silently removed paid enforcement');
select pg_temp.assert_rollout(not public.qorpera_company_paid_computer_mode((current_setting('qorpera_test.rollout_disabled')::jsonb->>'profile_id')::uuid),
    'Unpublished creation still enrolled paid mode');
-- A cancelled setup cannot be reclassified by later rollout refresh.
update public.qorpera_company_founding set phase='cancelled'
    where profile_id=(current_setting('qorpera_test.rollout_disabled')::jsonb->>'profile_id')::uuid;
update public.qorpera_computer_billing_readiness set checkout_enabled=true,runtime_accounting_ready=true where singleton;
set local role authenticated;
select public.qorpera_read_company_founding((current_setting('qorpera_test.rollout_disabled')::jsonb->>'profile_id')::uuid);
reset role;
select pg_temp.assert_rollout(not public.qorpera_company_paid_computer_mode((current_setting('qorpera_test.rollout_disabled')::jsonb->>'profile_id')::uuid),
    'Cancelled setup was enrolled');
set constraints all immediate;
rollback;
