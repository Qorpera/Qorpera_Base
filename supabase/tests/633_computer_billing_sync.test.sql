begin;
create function pg_temp.billing_conflict_envelope(p_message text,p_detail text) returns void language plpgsql as $$
begin
    if p_message::jsonb->>'code' is distinct from 'QRC01'
        or coalesce(p_message::jsonb->>'message','')=''
        or p_detail::jsonb is distinct from '{"status":409,"headers":{}}'::jsonb then
        raise exception 'Application conflict lost its non-retrying PostgREST envelope'; end if;
end $$;
insert into auth.users(id,email) values('63300000-0000-4000-8000-000000000001','billing-sync@example.test');
set local request.jwt.claims='{"role":"service_role"}';
select public.qorpera_map_computer_billing_customer('63300000-0000-4000-8000-000000000001','cus_sync');
select public.qorpera_map_computer_billing_customer('63300000-0000-4000-8000-000000000001','cus_sync');
do $$ declare conflict_message text; conflict_detail text; t timestamptz:=statement_timestamp()-interval '1 day'; p jsonb; first_claim jsonb; second_claim jsonb; begin
    p:=jsonb_build_object('subscriptionId','sub_sync','customerId','cus_sync','userId','63300000-0000-4000-8000-000000000001',
        'planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month');
    first_claim:=public.qorpera_begin_computer_billing_sync('evt_sync1','sub_sync',t,repeat('a',64));
    if first_claim->>'state'<>'claimed' then raise exception 'First sync did not claim'; end if;
    second_claim:=public.qorpera_begin_computer_billing_sync('evt_sync2','sub_sync',t,repeat('b',64));
    if second_claim->>'state'<>'busy' then raise exception 'Concurrent retrieval was admitted'; end if;
    begin
        perform public.qorpera_finish_computer_billing_sync('evt_sync2',(first_claim->>'leaseToken')::uuid,p);
        raise exception 'Another event borrowed active lease';
    exception when sqlstate 'PGRST' then
        get stacked diagnostics conflict_message=message_text,conflict_detail=pg_exception_detail;
        perform pg_temp.billing_conflict_envelope(conflict_message,conflict_detail); end;
    perform public.qorpera_finish_computer_billing_sync('evt_sync1',(first_claim->>'leaseToken')::uuid,p);
    if public.qorpera_begin_computer_billing_sync('evt_sync1','sub_sync',t,repeat('a',64))->>'state'<>'completed' then
        raise exception 'Lost success reply did not recover exact completed event'; end if;
    begin
        perform public.qorpera_begin_computer_billing_sync('evt_sync1','sub_sync',t,repeat('c',64));
        raise exception 'Conflicting webhook replay was accepted';
    exception when unique_violation then null; end;
    -- Same Stripe second: the second retrieval sees current cancellation.
    second_claim:=public.qorpera_begin_computer_billing_sync('evt_sync2','sub_sync',t,repeat('b',64));
    perform public.qorpera_finish_computer_billing_sync('evt_sync2',(second_claim->>'leaseToken')::uuid,p||'{"status":"canceled"}');
    if (select status from public.qorpera_computer_subscriptions where provider_subscription_id='sub_sync')<>'canceled' then
        raise exception 'Same-second canonical retrieval failed'; end if;
    -- An old webhook retrieves current state, never rewinds to its payload.
    first_claim:=public.qorpera_begin_computer_billing_sync('evt_syncold','sub_sync',t-interval '1 day',repeat('d',64));
    perform public.qorpera_finish_computer_billing_sync('evt_syncold',(first_claim->>'leaseToken')::uuid,p||'{"status":"canceled"}');
    if (select event_created_at from public.qorpera_computer_billing_inbox where event_id='evt_syncold')<>t-interval '1 day' then
        raise exception 'Original Stripe event time was lost'; end if;
    -- Provider failure gives its lease back and exact event can be retried.
    first_claim:=public.qorpera_begin_computer_billing_sync('evt_retry','sub_sync',t,repeat('e',64));
    perform public.qorpera_release_computer_billing_sync('evt_retry',(first_claim->>'leaseToken')::uuid);
    second_claim:=public.qorpera_begin_computer_billing_sync('evt_retry','sub_sync',t,repeat('e',64));
    if second_claim->>'state'<>'claimed' or second_claim->>'leaseToken'=first_claim->>'leaseToken' then raise exception 'Retry did not replace lease'; end if;
    begin
        perform public.qorpera_finish_computer_billing_sync('evt_retry',(first_claim->>'leaseToken')::uuid,p);
        raise exception 'Superseded lease committed';
    exception when sqlstate 'PGRST' then
        get stacked diagnostics conflict_message=message_text,conflict_detail=pg_exception_detail;
        perform pg_temp.billing_conflict_envelope(conflict_message,conflict_detail); end;
    update public.qorpera_computer_billing_syncs set lease_until=clock_timestamp()-interval '1 second' where subscription_id='sub_sync';
    begin
        perform public.qorpera_finish_computer_billing_sync('evt_retry',(second_claim->>'leaseToken')::uuid,p);
        raise exception 'Expired lease committed';
    exception when sqlstate 'PGRST' then
        get stacked diagnostics conflict_message=message_text,conflict_detail=pg_exception_detail;
        perform pg_temp.billing_conflict_envelope(conflict_message,conflict_detail); end;
    begin
        perform public.qorpera_map_computer_billing_customer('63300000-0000-4000-8000-000000000001','cus_other');
        raise exception 'Mapped owner customer was rebound';
    exception when unique_violation then null; end;
end $$;
insert into auth.users(id,email) values('63300000-0000-4000-8000-000000000002','billing-command@example.test');
do $$ declare conflict_message text; conflict_detail text; u uuid:='63300000-0000-4000-8000-000000000002'; q uuid:='63300000-0000-4000-8000-000000000020';
    c jsonb; r jsonb; p jsonb:='{"planKey":"basis","version":1,"tariffVersion":1,"priceId":"price_basis","returnUrl":"https://qorpera.test"}'; begin
    c:=public.qorpera_begin_computer_billing_command(u,'customer',q,'{}');
    if c->>'state'<>'claimed' then raise exception 'Customer command was not claimed'; end if;
    if public.qorpera_begin_computer_billing_command(u,'customer',extensions.gen_random_uuid(),'{}')->>'state'<>'busy' then
        raise exception 'New UUID created second concurrent customer'; end if;
    perform public.qorpera_release_computer_billing_command((c->>'commandId')::uuid,(c->>'leaseToken')::uuid);
    r:=public.qorpera_begin_computer_billing_command(u,'customer',q,'{}');
    if r->>'idempotencyKey'<>c->>'idempotencyKey' then raise exception 'Retry changed provider customer key'; end if;
    perform public.qorpera_finish_computer_billing_command((r->>'commandId')::uuid,(r->>'leaseToken')::uuid,'{"customerId":"cus_commands"}');
    if public.qorpera_begin_computer_billing_command(u,'customer',q,'{}')#>>'{result,customerId}'<>'cus_commands' then
        raise exception 'Completed customer reply lost'; end if;
    begin
        perform public.qorpera_begin_computer_billing_command(u,'checkout',q,p);
        raise exception 'Checkout bypassed runtime publication gate';
    exception when object_not_in_prerequisite_state then null; end;
    -- Test-only publication; transaction rolls it back.
    update public.qorpera_computer_billing_readiness set runtime_accounting_ready=true,checkout_enabled=true;
    update public.qorpera_computer_plan_versions set active_for_checkout=true where plan_key='basis';
    c:=public.qorpera_begin_computer_billing_command(u,'checkout',q,p);
    if public.qorpera_begin_computer_billing_command(u,'checkout',extensions.gen_random_uuid(),p)->>'state'<>'busy' then
        raise exception 'New UUID created second payable session'; end if;
    begin
        perform public.qorpera_begin_computer_billing_command(u,'checkout',q,p||'{"priceId":"price_other"}');
        raise exception 'Command accepted changed intent';
    exception when unique_violation then null; end;
    perform public.qorpera_release_computer_billing_command((c->>'commandId')::uuid,(c->>'leaseToken')::uuid);
    r:=public.qorpera_begin_computer_billing_command(u,'checkout',q,p);
    if r->>'idempotencyKey'<>c->>'idempotencyKey' then raise exception 'Retry changed checkout provider key'; end if;
    begin
        perform public.qorpera_finish_computer_billing_command((c->>'commandId')::uuid,(c->>'leaseToken')::uuid,'{}');
        raise exception 'Old command lease committed';
    exception when sqlstate 'PGRST' then
        get stacked diagnostics conflict_message=message_text,conflict_detail=pg_exception_detail;
        perform pg_temp.billing_conflict_envelope(conflict_message,conflict_detail); end;
    update public.qorpera_computer_billing_commands set created_at=clock_timestamp()-interval '23 hours',lease_until=null,lease_token=null where id=(r->>'commandId')::uuid;
    if public.qorpera_begin_computer_billing_command(u,'checkout',q,p)->>'state'<>'reconciliation_required' then
        raise exception 'Ambiguous command retried beyond safe provider idempotency window'; end if;
end $$;
set local request.jwt.claims='{"role":"authenticated","sub":"63300000-0000-4000-8000-000000000001"}';
do $$ begin
    begin
        perform public.qorpera_begin_computer_billing_sync('evt_forged','sub_sync',now(),repeat('a',64));
        raise exception 'Member reconciled subscription';
    exception when insufficient_privilege then null; end;
    if has_function_privilege('authenticated','public.qorpera_map_computer_billing_customer(uuid,text)','EXECUTE') then
        raise exception 'Member can map Stripe customer'; end if;
end $$;
rollback;
