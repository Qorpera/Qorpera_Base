begin;
insert into auth.users(id,email) values('63900000-0000-4000-8000-000000000001','billing-authority@example.test');
insert into public.qorpera_computer_billing_keys(key_sha256,label)
    values(encode(extensions.digest(convert_to(repeat('B',64),'UTF8'),'sha256'),'hex'),'offline test');
set local request.jwt.claims='{"role":"service_role"}';
-- Assert the ACL, not just a JWT claim check while running as database owner.
do $$ declare f record; t record; begin
    for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname=any(array[
        'qorpera_set_account_entitlement','qorpera_map_computer_billing_customer','qorpera_computer_billing_customer','qorpera_begin_computer_billing_command',
        'qorpera_finish_computer_billing_command','qorpera_release_computer_billing_command','qorpera_begin_computer_billing_sync',
        'qorpera_finish_computer_billing_sync','qorpera_release_computer_billing_sync','qorpera_reconcile_computer_subscription',
        'qorpera_fund_computer_invoice','qorpera_grant_computer_entitlement','qorpera_revoke_computer_entitlement',
        'qorpera_reserve_computer_allowance','qorpera_settle_computer_allowance','qorpera_reserve_computer_allowance_internal',
        'qorpera_settle_computer_allowance_internal']) loop
        if has_function_privilege('service_role',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE') or has_function_privilege('qorpera_secret_broker',f.signature,'EXECUTE') then
            raise exception 'Unprotected billing capability: %',f.signature; end if;
    end loop;
    for t in select oid::regclass as name,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r'
        and (relname like 'qorpera_computer_%' or relname in ('qorpera_company_computer_entitlements','qorpera_company_computer_pool_members')) loop
        if not t.relrowsecurity or has_table_privilege('service_role',t.name,'INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('qorpera_secret_broker',t.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
            raise exception 'Unprotected computer billing table: %',t.name; end if;
    end loop;
end $$;
set local role service_role;
do $$ declare c jsonb; again jsonb; sync_args jsonb; finish_args jsonb; payload jsonb; proof jsonb;
    t timestamptz:=clock_timestamp()-interval '1 day'; secret text:=repeat('B',64);
    command_args jsonb:='{"p_user_id":"63900000-0000-4000-8000-000000000001","p_kind":"customer","p_request_id":"63900000-0000-4000-8000-000000000002","p_payload":{}}';
begin
    begin perform public.qorpera_set_account_entitlement('63900000-0000-4000-8000-000000000001','internal','complimentary','all','unlimited','forged','forged'); raise exception 'Guest minted legacy complimentary credit'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_fund_computer_invoice('{}'); raise exception 'Guest minted credit'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_map_computer_billing_customer('63900000-0000-4000-8000-000000000001','cus_forged'); raise exception 'Guest mapped customer'; exception when insufficient_privilege then null; end;
    begin update public.qorpera_computer_billing_readiness set checkout_enabled=true; raise exception 'Guest published billing'; exception when insufficient_privilege then null; end;
    begin insert into public.qorpera_computer_billing_keys(key_sha256,label) values(repeat('f',64),'forged'); raise exception 'Guest enrolled key'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_computer_billing_rpc('qorpera_computer_plan_catalog','{}',null); raise exception 'Missing key accepted'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_computer_billing_rpc('qorpera_computer_plan_catalog','{}',repeat('X',64)); raise exception 'Wrong key accepted'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_computer_billing_rpc('qorpera_fund_computer_invoice','{}',secret); raise exception 'Direct mint dispatcher accepted'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_computer_billing_rpc('qorpera_reconcile_computer_subscription','{}',secret); raise exception 'Raw reconciliation dispatcher accepted'; exception when insufficient_privilege then null; end;
    begin perform public.qorpera_computer_billing_rpc('qorpera_computer_plan_catalog','{"unexpected":true}',secret); raise exception 'Extra arguments accepted'; exception when invalid_parameter_value then null; end;
    c:=public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_command',command_args,secret);
    if c->>'state'<>'claimed' then raise exception 'Trusted bridge could not claim'; end if;
    perform public.qorpera_computer_billing_rpc('qorpera_finish_computer_billing_command',jsonb_build_object(
        'p_command_id',c->'commandId','p_lease_token',c->'leaseToken','p_result',jsonb_build_object('customerId','cus_authority')),secret);
    again:=public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_command',command_args,secret);
    if again#>>'{result,customerId}'<>'cus_authority' then raise exception 'Command retry lost mapping'; end if;
    if public.qorpera_computer_billing_rpc('qorpera_computer_billing_customer','{"p_customer_id":"cus_authority"}',secret)->>'userId'<>'63900000-0000-4000-8000-000000000001' then
        raise exception 'Trusted customer lookup failed'; end if;
    begin
        perform public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_command',command_args||'{"p_kind":"checkout","p_payload":{"planKey":"basis","version":1,"tariffVersion":1}}',secret);
        raise exception 'Bridge bypassed unpublished checkout';
    exception when object_not_in_prerequisite_state then null; end;
    sync_args:=jsonb_build_object('p_event_id','evt_authority','p_subscription_id','sub_authority','p_event_created_at',t,'p_body_sha256',repeat('a',64));
    c:=public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_sync',sync_args,secret);
    payload:=jsonb_build_object('subscriptionId','sub_authority','customerId','cus_authority','userId','63900000-0000-4000-8000-000000000001',
        'planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month');
    proof:=jsonb_build_object('invoiceId','in_authority','subscriptionId','sub_authority','customerId','cus_authority',
        'planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk');
    finish_args:=jsonb_build_object('p_event_id','evt_authority','p_lease_token',c->'leaseToken','p_payload',payload,'p_paid_invoice',proof);
    begin perform public.qorpera_computer_billing_rpc('qorpera_finish_computer_billing_sync',finish_args||jsonb_build_object('p_paid_invoice',proof||'{"customerId":"cus_other"}'),secret);
        raise exception 'Mismatched invoice funded'; exception when insufficient_privilege then null; end;
    -- Failure must roll back the subscription mutation as well as funding. The
    -- same original lease can retry the verified proof atomically.
    perform public.qorpera_computer_billing_rpc('qorpera_finish_computer_billing_sync',finish_args,secret);
    if public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_sync',sync_args,secret)->>'state'<>'completed' then raise exception 'Webhook replay not completed'; end if;
    begin perform public.qorpera_computer_billing_rpc('qorpera_begin_computer_billing_sync',sync_args||jsonb_build_object('p_body_sha256',repeat('b',64)),secret);
        raise exception 'Conflicting event replay accepted'; exception when unique_violation then null; end;
end $$;
reset role;
do $$ begin
    if (select count(*) from public.qorpera_computer_allowance_buckets where invoice_id='in_authority')<>1
        or (select issued_us from public.qorpera_computer_allowance_buckets where invoice_id='in_authority')<>74::bigint*3600000000 then
        raise exception 'Verified bridge invoice did not fund exactly once'; end if;
    if exists(select 1 from public.qorpera_computer_billing_readiness where runtime_accounting_ready or checkout_enabled)
        or exists(select 1 from public.qorpera_computer_plan_versions where active_for_checkout) then raise exception 'Test enabled production checkout'; end if;
end $$;
update public.qorpera_computer_billing_keys set revoked_at=clock_timestamp();
set local role service_role;
do $$ begin
    begin perform public.qorpera_computer_billing_rpc('qorpera_computer_plan_catalog','{}',repeat('B',64)); raise exception 'Revoked bridge key accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role qorpera_secret_broker;
do $$ begin
    begin perform public.qorpera_computer_billing_rpc('qorpera_computer_plan_catalog','{}',repeat('B',64)); raise exception 'Secret broker accessed billing dispatcher'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
