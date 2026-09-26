begin;
create function pg_temp.recovery_assert(p_ok boolean,p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.recovery_denied(p_sql text,p_state text) returns void language plpgsql as $$
begin begin execute p_sql; exception when others then if sqlstate=p_state then return; end if; raise; end;
raise exception 'Expected recovery refusal %',p_state; end $$;
insert into auth.users(id,email) values('66400000-0000-4000-8000-000000000001','billing-recovery@example.test');
insert into public.qorpera_computer_billing_keys(key_sha256,label) values
    (encode(extensions.digest(repeat('r',43),'sha256'),'hex'),'Recovery test');
set local request.jwt.claims='{"role":"service_role"}';
select set_config('recovery.customer',public.qorpera_begin_computer_billing_command(
    '66400000-0000-4000-8000-000000000001','customer','66400000-0000-4000-8000-000000000002','{}')::text,true);
update public.qorpera_computer_billing_commands set created_at=now()-interval '25 hours',lease_token=null,lease_until=null;
select set_config('recovery.customer_proof',jsonb_build_object('schema','qorpera.billing-command-recovery/v1','kind','customer',
    'userId','66400000-0000-4000-8000-000000000001','providerObjectId','cus_recovered','providerRequestKey',current_setting('recovery.customer')::jsonb->>'idempotencyKey',
    'customerId','cus_recovered','priceId',null,'returnUrl',null,'providerState','present','result',jsonb_build_object('customerId','cus_recovered'),
    'objectSha256',repeat('a',64),'eventId',null,'eventSha256',null,'verifiedAt',clock_timestamp())::text,true);
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_recover_computer_billing_command(%L,%L)',
    current_setting('recovery.customer')::jsonb->>'commandId',current_setting('recovery.customer_proof')),'42501');
select pg_temp.recovery_denied(format('select public.qorpera_computer_billing_rpc(''qorpera_describe_computer_billing_command'',%L,%L)',
    jsonb_build_object('p_command_id',current_setting('recovery.customer')::jsonb->>'commandId'),repeat('x',43)),'42501');
select pg_temp.recovery_denied(format('select public.qorpera_computer_billing_rpc(''qorpera_recover_computer_billing_command'',%L,%L)',
    jsonb_build_object('p_command_id',current_setting('recovery.customer')::jsonb->>'commandId','p_proof',current_setting('recovery.customer_proof')::jsonb||'{"providerRequestKey":"wrong"}'),repeat('r',43)),'22023');
select public.qorpera_computer_billing_rpc('qorpera_recover_computer_billing_command',jsonb_build_object(
    'p_command_id',current_setting('recovery.customer')::jsonb->>'commandId','p_proof',current_setting('recovery.customer_proof')::jsonb),repeat('r',43));
-- Lost reply: replay the frozen positive proof, not a new request/provider key.
select public.qorpera_computer_billing_rpc('qorpera_recover_computer_billing_command',jsonb_build_object(
    'p_command_id',current_setting('recovery.customer')::jsonb->>'commandId','p_proof',current_setting('recovery.customer_proof')::jsonb),repeat('r',43));
select pg_temp.recovery_denied(format('select public.qorpera_computer_billing_rpc(''qorpera_recover_computer_billing_command'',%L,%L)',
    jsonb_build_object('p_command_id',current_setting('recovery.customer')::jsonb->>'commandId','p_proof',current_setting('recovery.customer_proof')::jsonb||jsonb_build_object('objectSha256',repeat('b',64))),repeat('r',43)),'23505');
reset role;
select pg_temp.recovery_assert((select count(*)=1 from public.qorpera_computer_billing_command_recoveries),'Recovery replay duplicated receipt');
select pg_temp.recovery_assert((select created_at<now()-interval '23 hours' from public.qorpera_computer_billing_commands limit 1),'Recovery reset command age');
update public.qorpera_computer_billing_readiness set runtime_accounting_ready=true,checkout_enabled=true;
update public.qorpera_computer_plan_versions set active_for_checkout=true where plan_key='basis';
select set_config('recovery.checkout_intent','{"planKey":"basis","version":1,"tariffVersion":1,"priceId":"price_basis","returnUrl":"https://example.test/usage"}',true);
select set_config('recovery.checkout',public.qorpera_begin_computer_billing_command('66400000-0000-4000-8000-000000000001','checkout',
    '66400000-0000-4000-8000-000000000003',current_setting('recovery.checkout_intent')::jsonb)::text,true);
update public.qorpera_computer_billing_commands set created_at=now()-interval '25 hours',lease_token=null,lease_until=null where kind='checkout';
select pg_temp.recovery_assert(public.qorpera_begin_computer_billing_command('66400000-0000-4000-8000-000000000001','checkout',
    '66400000-0000-4000-8000-000000000003',current_setting('recovery.checkout_intent')::jsonb)->>'state'='reconciliation_required','Aged checkout reissued provider command');
select set_config('recovery.checkout_proof',(current_setting('recovery.customer_proof')::jsonb||jsonb_build_object('kind','checkout',
    'providerObjectId','cs_closed','providerRequestKey',current_setting('recovery.checkout')::jsonb->>'idempotencyKey','priceId','price_basis',
    'returnUrl','https://example.test/usage','providerState','expired','result',null))::text,true);
set local role service_role;
select public.qorpera_computer_billing_rpc('qorpera_recover_computer_billing_command',jsonb_build_object(
    'p_command_id',current_setting('recovery.checkout')::jsonb->>'commandId','p_proof',current_setting('recovery.checkout_proof')::jsonb),repeat('r',43));
reset role;
select pg_temp.recovery_assert(public.qorpera_begin_computer_billing_command('66400000-0000-4000-8000-000000000001','checkout',
    '66400000-0000-4000-8000-000000000003',current_setting('recovery.checkout_intent')::jsonb)->>'state'='recovered_terminal','Terminal command was rearmed');
select pg_temp.recovery_assert(public.qorpera_begin_computer_billing_command('66400000-0000-4000-8000-000000000001','checkout',
    '66400000-0000-4000-8000-000000000004',current_setting('recovery.checkout_intent')::jsonb)->>'state'='claimed','Confirmed closed checkout permanently blocked new purchase');
select pg_temp.recovery_denied('update public.qorpera_computer_billing_command_recoveries set proof=''{}''','42501');
select pg_temp.recovery_assert(not exists(select 1 from public.qorpera_computer_allowance_buckets),'Command recovery minted paid usage');
update public.qorpera_computer_billing_keys set revoked_at=now();
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_computer_billing_rpc(''qorpera_describe_computer_billing_command'',%L,%L)',
    jsonb_build_object('p_command_id',current_setting('recovery.customer')::jsonb->>'commandId'),repeat('r',43)),'42501');
reset role;
rollback;
