-- Reversal is monotonic invoice authority, independent of subscription status.
-- A cancellation does not revoke paid time. A refund (including partial),
-- dispute or issued credit note prevents NEW holds from that invoice. Existing
-- holds still settle, so physical usage and financial conservation stay intact.
create table public.qorpera_computer_payment_fences (
    invoice_id text primary key check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
    subscription_id text not null check(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
    customer_id text not null references public.qorpera_computer_billing_customers(customer_id),
    created_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_computer_payment_fence_events (
    event_id text not null check(event_id ~ '^evt_[A-Za-z0-9]+$'),
    invoice_id text not null references public.qorpera_computer_payment_fences(invoice_id),
    source_id text not null check(source_id ~ '^(ch|re|du|cn|in)_[A-Za-z0-9]+$'),
    body_sha256 text not null check(body_sha256 ~ '^[0-9a-f]{64}$'),
    proof jsonb not null,
    created_at timestamptz not null default clock_timestamp(),
    primary key(event_id,invoice_id,source_id)
);
alter table public.qorpera_computer_allowance_buckets add column payment_fenced boolean not null default false;

create function public.qorpera_fence_computer_payment(p_event_id text,p_body_sha256 text,p_proof jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare f public.qorpera_computer_payment_fences%rowtype; prior jsonb;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$' or p_body_sha256 is null or p_body_sha256 !~ '^[0-9a-f]{64}$'
        or p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>4096
        or (select count(*) from jsonb_object_keys(p_proof))<>5
        or not p_proof ?& array['invoiceId','subscriptionId','customerId','sourceId','reason']
        or exists(select 1 from jsonb_each(p_proof) e where jsonb_typeof(e.value)<>'string')
        or p_proof->>'invoiceId' !~ '^in_[A-Za-z0-9]+$' or p_proof->>'subscriptionId' !~ '^sub_[A-Za-z0-9]+$'
        or p_proof->>'customerId' !~ '^cus_[A-Za-z0-9]+$'
        or p_proof->>'reason' not in ('charge_adverse','refund','dispute','credit_note')
        or p_proof->>'sourceId' !~ (case p_proof->>'reason' when 'charge_adverse' then '^ch_[A-Za-z0-9]+$'
            when 'refund' then '^re_[A-Za-z0-9]+$' when 'dispute' then '^du_[A-Za-z0-9]+$' else '^(cn|in)_[A-Za-z0-9]+$' end) then
        raise exception 'Verified adverse payment required' using errcode='22023'; end if;
    -- Use the same event namespace as the existing billing inbox. One event may
    -- affect multiple invoices, but cannot be rebound to different signed bytes.
    perform pg_advisory_xact_lock(hashtextextended('computer-billing-inbox:'||p_event_id,0));
    if exists(select 1 from public.qorpera_computer_payment_fence_events where event_id=p_event_id and body_sha256<>p_body_sha256)
        or exists(select 1 from public.qorpera_computer_billing_inbox where event_id=p_event_id and body_sha256<>p_body_sha256) then
        raise exception 'Payment event replay differs' using errcode='23505'; end if;
    perform pg_advisory_xact_lock(hashtextextended('computer-invoice:'||(p_proof->>'invoiceId'),0));
    if not exists(select 1 from public.qorpera_computer_billing_customers where customer_id=p_proof->>'customerId')
        or exists(select 1 from public.qorpera_computer_subscriptions where provider_subscription_id=p_proof->>'subscriptionId'
            and provider_customer_id<>p_proof->>'customerId')
        or exists(select 1 from public.qorpera_computer_allowance_buckets where invoice_id=p_proof->>'invoiceId'
            and (subscription_id<>p_proof->>'subscriptionId' or payment_proof->>'customerId'<>p_proof->>'customerId')) then
        raise exception 'Payment customer or subscription differs' using errcode='42501'; end if;
    insert into public.qorpera_computer_payment_fences(invoice_id,subscription_id,customer_id)
        values(p_proof->>'invoiceId',p_proof->>'subscriptionId',p_proof->>'customerId') on conflict do nothing;
    select * into strict f from public.qorpera_computer_payment_fences where invoice_id=p_proof->>'invoiceId';
    if row(f.subscription_id,f.customer_id) is distinct from row(p_proof->>'subscriptionId',p_proof->>'customerId') then
        raise exception 'Invoice fence identity differs' using errcode='23505'; end if;
    select proof into prior from public.qorpera_computer_payment_fence_events
        where event_id=p_event_id and invoice_id=f.invoice_id and source_id=p_proof->>'sourceId';
    if found and prior is distinct from p_proof then raise exception 'Payment proof replay differs' using errcode='23505'; end if;
    insert into public.qorpera_computer_payment_fence_events(event_id,invoice_id,source_id,body_sha256,proof)
        values(p_event_id,f.invoice_id,p_proof->>'sourceId',p_body_sha256,p_proof) on conflict do nothing;
    -- The bucket row lock serializes with pooled reservation selection. A hold
    -- that committed first retains its settlement authority; later holds refuse.
    update public.qorpera_computer_allowance_buckets set payment_fenced=true where invoice_id=f.invoice_id and not payment_fenced;
end $$;

create function public.qorpera_computer_bucket_payment_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare f public.qorpera_computer_payment_fences%rowtype;
begin
    if tg_op='INSERT' then
        -- Also covers adverse webhook arrival before the first paid webhook.
        perform pg_advisory_xact_lock(hashtextextended('computer-invoice:'||new.invoice_id,0));
        select * into f from public.qorpera_computer_payment_fences where invoice_id=new.invoice_id;
        if found then
            if f.subscription_id<>new.subscription_id or f.customer_id is distinct from new.payment_proof->>'customerId' then
                raise exception 'Invoice fence identity differs' using errcode='23505'; end if;
            new.payment_fenced:=true;
        end if;
    elsif old.payment_fenced and (not new.payment_fenced or new.reserved_us>old.reserved_us) then
        raise exception 'Reversed payment cannot authorize new usage' using errcode='42501';
    end if;
    return new;
end $$;
create trigger qorpera_computer_bucket_payment_guard before insert or update on public.qorpera_computer_allowance_buckets
    for each row execute function public.qorpera_computer_bucket_payment_guard();

alter table public.qorpera_computer_payment_fences enable row level security;
alter table public.qorpera_computer_payment_fence_events enable row level security;
revoke all on public.qorpera_computer_payment_fences,public.qorpera_computer_payment_fence_events from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_fence_computer_payment(text,text,jsonb),public.qorpera_computer_bucket_payment_guard() from public,anon,authenticated,service_role,qorpera_secret_broker;

create or replace function public.qorpera_reserve_computer_allowance_internal(p_reservation_id uuid,p_profile_id uuid,p_requested_by_user_id uuid,
    p_preferred_user_id uuid,p_allocation_id uuid,p_epoch uuid,p_amount_us bigint,p_deadline timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_computer_allowance_reservations%rowtype; s public.qorpera_computer_usage_streams%rowtype;
    c public.qorpera_computer_allowance_cursors%rowtype; a public.qorpera_runtime_machine_allocations%rowtype;
    b record; v_left bigint:=p_amount_us; v_take bigint; v_order integer:=0; v_requester uuid; v_preferred uuid; v_candidates uuid[]:='{}';
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Runtime service required' using errcode='42501'; end if;
    if num_nonnulls(p_reservation_id,p_profile_id,p_allocation_id,p_epoch,p_amount_us,p_deadline)<>6 or p_amount_us<=0
        or not isfinite(p_deadline) then raise exception 'Reservation identity, finite amount and deadline required' using errcode='22023'; end if;
    select computer_usage_owner_user_id into v_preferred from public.qorpera_profiles where id=p_profile_id for update;
    if not found then raise exception 'Company missing' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtextextended('computer-reservation:'||p_reservation_id::text,0));
    select * into r from public.qorpera_computer_allowance_reservations where id=p_reservation_id;
    if found then
        if row(r.profile_id,r.requested_by_user_id,r.preferred_user_id,r.allocation_id,r.epoch,r.reserved_us,r.deadline)
            is distinct from row(p_profile_id,p_requested_by_user_id,p_preferred_user_id,p_allocation_id,p_epoch,p_amount_us,p_deadline) then
            raise exception 'Reservation replay differs' using errcode='23505'; end if;
        return jsonb_build_object('reservationId',r.id,'reservedUs',r.reserved_us::text,'settled',r.settled_at is not null);
    end if;
    if p_deadline<=clock_timestamp() then raise exception 'Reservation deadline elapsed' using errcode='22023'; end if;
    if p_requested_by_user_id is not null and not exists(select 1 from public.qorpera_profile_members where profile_id=p_profile_id
        and user_id=p_requested_by_user_id and role in ('owner','admin','contributor')) then raise exception 'Requester no longer a company member' using errcode='42501'; end if;
    select * into a from public.qorpera_runtime_machine_allocations where id=p_allocation_id and profile_id=p_profile_id and released_at is null for update;
    if not found then raise exception 'Company allocation unavailable' using errcode='42501'; end if;
    if a.run_id is not null then
        select requested_by_user_id into strict v_requester from public.qorpera_execution_runs where id=a.run_id;
    elsif a.coding_machine_id is not null then
        select member_user_id into strict v_requester from public.qorpera_coding_machines where id=a.coding_machine_id;
    end if;
    if p_requested_by_user_id is distinct from v_requester or (p_preferred_user_id is not null and p_preferred_user_id is distinct from v_preferred) then
        raise exception 'Computer usage attribution differs from allocation' using errcode='42501'; end if;
    select * into strict s from public.qorpera_computer_usage_streams where allocation_id=p_allocation_id and epoch=p_epoch for update;
    if s.closed or s.resource_shape is null or s.resource_kind='login_helper' then raise exception 'Metered computer stream required' using errcode='55000'; end if;
    if not exists(select 1 from public.qorpera_runtime_machine_allocations where id=p_allocation_id and instance_sha256=s.instance_sha256) then
        raise exception 'Metered instance differs' using errcode='42501'; end if;
    insert into public.qorpera_computer_allowance_cursors(allocation_id,epoch) values(p_allocation_id,p_epoch) on conflict do nothing;
    select * into strict c from public.qorpera_computer_allowance_cursors where allocation_id=p_allocation_id and epoch=p_epoch for update;
    if s.last_sequence<>c.settled_sequence then raise exception 'Unreserved usage needs reconciliation' using errcode='55000'; end if;
    -- Lock all candidate GLOBAL buckets in one canonical order before choosing
    -- preferred contributors. Different companies cannot deadlock or clone funds.
    for b in select ab.id from public.qorpera_computer_allowance_buckets ab
        join public.qorpera_profile_members m on m.user_id=ab.user_id and m.profile_id=p_profile_id and m.role in ('owner','admin','contributor')
        left join public.qorpera_company_computer_pool_members pm on pm.profile_id=m.profile_id and pm.user_id=m.user_id
        where (m.user_id=p_requested_by_user_id or pm.enabled) and not ab.payment_fenced and ab.period_start<=clock_timestamp() and ab.period_end>=p_deadline
        order by ab.id for update of ab loop
        v_candidates:=array_append(v_candidates,b.id);
    end loop;
    insert into public.qorpera_computer_allowance_reservations(id,profile_id,requested_by_user_id,preferred_user_id,allocation_id,epoch,from_sequence,from_standard_us,reserved_us,deadline)
        values(p_reservation_id,p_profile_id,p_requested_by_user_id,p_preferred_user_id,p_allocation_id,p_epoch,c.settled_sequence,c.settled_standard_us,p_amount_us,p_deadline);
    for b in select ab.* from public.qorpera_computer_allowance_buckets ab
        join public.qorpera_profile_members m on m.user_id=ab.user_id and m.profile_id=p_profile_id and m.role in ('owner','admin','contributor')
        left join public.qorpera_company_computer_pool_members pm on pm.profile_id=m.profile_id and pm.user_id=m.user_id
        where ab.id=any(v_candidates) and (m.user_id=p_requested_by_user_id or pm.enabled) and not ab.payment_fenced and ab.period_start<=clock_timestamp() and ab.period_end>=p_deadline
        and ab.issued_us-ab.reserved_us-ab.debited_us>0
        order by (ab.user_id=p_requested_by_user_id) desc nulls last,(ab.user_id=p_preferred_user_id) desc nulls last,ab.period_end,ab.id loop
        v_take:=least(v_left,b.issued_us-b.reserved_us-b.debited_us); v_order:=v_order+1;
        insert into public.qorpera_computer_allowance_holds values(p_reservation_id,b.id,v_order,v_take);
        update public.qorpera_computer_allowance_buckets set reserved_us=reserved_us+v_take where id=b.id;
        v_left:=v_left-v_take; exit when v_left=0;
    end loop;
    if v_left<>0 then raise exception 'Insufficient pooled computer allowance' using errcode='P0001'; end if;
    return jsonb_build_object('reservationId',p_reservation_id,'reservedUs',p_amount_us::text,'settled',false);
end $$;

create or replace function public.qorpera_my_computer_usage()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_balance jsonb; v_subscriptions jsonb; r public.qorpera_computer_billing_readiness%rowtype;
    t public.qorpera_computer_tariff_versions%rowtype;
begin
    if v_user is null or auth.role() is distinct from 'authenticated' then raise exception 'Member sign-in required' using errcode='42501'; end if;
    select * into strict r from public.qorpera_computer_billing_readiness where singleton;
    select * into strict t from public.qorpera_computer_tariff_versions where version=r.tariff_version;
    select jsonb_build_object('unit','standard_computer_microsecond','issuedUs',coalesce(sum(issued_us),0)::text,
        'reservedUs',coalesce(sum(reserved_us),0)::text,'debitedUs',coalesce(sum(debited_us),0)::text,
        'availableUs',coalesce(sum(case when payment_fenced then 0 else issued_us-reserved_us-debited_us end),0)::text) into v_balance
        from public.qorpera_computer_allowance_buckets where user_id=v_user and period_start<=now() and period_end>now();
    select coalesce(jsonb_agg(jsonb_build_object('planKey',plan_key,'planVersion',plan_version,'status',status,
        'periodStart',period_start,'periodEnd',period_end) order by period_end desc),'[]'::jsonb) into v_subscriptions
        from public.qorpera_computer_subscriptions where user_id=v_user;
    return jsonb_build_object('schema','qorpera.my-computer-usage/v1','meterMode','shadow',
        'checkoutAvailable',r.checkout_enabled and r.runtime_accounting_ready,'runtimeAccountingReady',r.runtime_accounting_ready,
        'portalAvailable',exists(select 1 from public.qorpera_computer_billing_customers where user_id=v_user),
        'subscriptions',v_subscriptions,'balance',v_balance,'standardComputer',jsonb_build_object('cpuMillis',t.reference_cpu_millis,
            'memoryBytes',t.reference_memory_bytes,'tariffVersion',t.version));
end $$;

create or replace function public.qorpera_computer_billing_rpc(p_method text,p_args jsonb,p_billing_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_key uuid; v_allowed text[];
begin
    if auth.role() is distinct from 'service_role' or p_billing_secret is null or length(p_billing_secret) not between 32 and 512 then
        raise exception 'Billing bridge authority required' using errcode='42501'; end if;
    -- Hold a row share lock until transaction completion so revocation cannot
    -- race past this authorization check and permit a later financial commit.
    select id into v_key from public.qorpera_computer_billing_keys
        where key_sha256=encode(extensions.digest(convert_to(p_billing_secret,'UTF8'),'sha256'),'hex') and revoked_at is null for share;
    if v_key is null then raise exception 'Billing bridge authority required' using errcode='42501'; end if;
    if p_args is null or jsonb_typeof(p_args)<>'object' or octet_length(p_args::text)>16384 then
        raise exception 'Invalid billing arguments' using errcode='22023'; end if;
    v_allowed:=case p_method
        when 'qorpera_fence_computer_payment' then array['p_event_id','p_body_sha256','p_proof']
        when 'qorpera_computer_plan_catalog' then array[]::text[]
        when 'qorpera_computer_billing_customer' then array['p_user_id','p_customer_id']
        when 'qorpera_begin_computer_billing_command' then array['p_user_id','p_kind','p_request_id','p_payload']
        when 'qorpera_finish_computer_billing_command' then array['p_command_id','p_lease_token','p_result']
        when 'qorpera_release_computer_billing_command' then array['p_command_id','p_lease_token']
        when 'qorpera_begin_computer_billing_sync' then array['p_event_id','p_subscription_id','p_event_created_at','p_body_sha256']
        when 'qorpera_finish_computer_billing_sync' then array['p_event_id','p_lease_token','p_payload','p_paid_invoice']
        when 'qorpera_release_computer_billing_sync' then array['p_event_id','p_lease_token']
        else null end;
    if v_allowed is null then raise exception 'Billing method unavailable' using errcode='42501'; end if;
    if exists(select 1 from jsonb_object_keys(p_args) as k(name) where not(name=any(v_allowed))) then
        raise exception 'Unexpected billing argument' using errcode='22023'; end if;
    -- Explicit typed dispatch only: neither function names nor SQL come from the
    -- caller. Direct funding/reconciliation are deliberately not capabilities.
    case p_method
    when 'qorpera_fence_computer_payment' then
        perform public.qorpera_fence_computer_payment(p_args->>'p_event_id',p_args->>'p_body_sha256',p_args->'p_proof');
    when 'qorpera_computer_plan_catalog' then return public.qorpera_computer_plan_catalog();
    when 'qorpera_computer_billing_customer' then
        return public.qorpera_computer_billing_customer((p_args->>'p_user_id')::uuid,p_args->>'p_customer_id');
    when 'qorpera_begin_computer_billing_command' then
        return public.qorpera_begin_computer_billing_command((p_args->>'p_user_id')::uuid,p_args->>'p_kind',(p_args->>'p_request_id')::uuid,p_args->'p_payload');
    when 'qorpera_finish_computer_billing_command' then
        perform public.qorpera_finish_computer_billing_command((p_args->>'p_command_id')::uuid,(p_args->>'p_lease_token')::uuid,p_args->'p_result');
    when 'qorpera_release_computer_billing_command' then
        perform public.qorpera_release_computer_billing_command((p_args->>'p_command_id')::uuid,(p_args->>'p_lease_token')::uuid);
    when 'qorpera_begin_computer_billing_sync' then
        return public.qorpera_begin_computer_billing_sync(p_args->>'p_event_id',p_args->>'p_subscription_id',(p_args->>'p_event_created_at')::timestamptz,p_args->>'p_body_sha256');
    when 'qorpera_finish_computer_billing_sync' then
        perform public.qorpera_finish_computer_billing_sync(p_args->>'p_event_id',(p_args->>'p_lease_token')::uuid,p_args->'p_payload',nullif(p_args->'p_paid_invoice','null'::jsonb));
    when 'qorpera_release_computer_billing_sync' then
        perform public.qorpera_release_computer_billing_sync(p_args->>'p_event_id',(p_args->>'p_lease_token')::uuid);
    end case;
    return null;
end $$;

create or replace function public.qorpera_company_computer_usage_status(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_granted boolean; v_members bigint; v_paid boolean; v_available numeric:=0;
    v_now timestamptz:=statement_timestamp(); v_initial_window interval:=interval '330 seconds';
    v_initial_standard_us bigint:=330000000;
begin
    if auth.role() is distinct from 'service_role' and
        (auth.role() is distinct from 'authenticated' or auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id)) then
        raise exception 'Company usage access denied' using errcode='42501'; end if;
    v_paid:=public.qorpera_company_paid_computer_mode(p_profile_id);
    select count(*) into v_members from public.qorpera_company_computer_pool_members pool
        join public.qorpera_profile_members member using(profile_id,user_id)
        where pool.profile_id=p_profile_id and pool.enabled and member.role in ('owner','admin','contributor');
    if v_paid then
        -- No direct-member exception for the shared company: being its creator,
        -- launcher or Computer Usage owner does not itself authorize pooling.
        -- Match the allowance kernel's current membership, consent, period and
        -- unheld/unspent balance predicates. The initial standard-computer
        -- window includes its stop margin; actual shape remains permit-owned.
        select coalesce(sum(bucket.issued_us-bucket.reserved_us-bucket.debited_us),0) into v_available
        from public.qorpera_computer_allowance_buckets bucket
        join public.qorpera_profile_members member on member.user_id=bucket.user_id and member.profile_id=p_profile_id
        join public.qorpera_company_computer_pool_members pool on pool.profile_id=member.profile_id and pool.user_id=member.user_id
        where member.role in ('owner','admin','contributor') and pool.enabled
            and not bucket.payment_fenced and bucket.period_start<=v_now and bucket.period_end>=v_now+v_initial_window;
        v_granted:=v_available>=v_initial_standard_us;
    else
        select exists(select 1 from public.qorpera_company_computer_entitlements where profile_id=p_profile_id
            and revoked_at is null and expires_at>v_now) into v_granted;
        v_granted:=v_granted or exists(select 1 from public.qorpera_company_computer_pool_members pool
            join public.qorpera_profile_members member using(profile_id,user_id)
            join public.qorpera_account_entitlements entitlement using(user_id)
            where pool.profile_id=p_profile_id and pool.enabled and member.role in ('owner','admin','contributor')
                and entitlement.plan_key='internal' and entitlement.billing_mode='complimentary');
    end if;
    return jsonb_build_object('schema','qorpera.company-computer-usage/v1','canStart',v_granted,
        'reason',case when v_granted and v_paid then 'paid_allowance' when v_granted then 'complimentary_entitlement'
            when v_paid then 'insufficient_pooled_allowance' else 'computer_plan_required' end,
        'meterMode',case when v_paid then 'paid' else 'shadow' end,
        'checkoutAvailable',(select checkout_enabled and runtime_accounting_ready from public.qorpera_computer_billing_readiness),
        'poolMembers',v_members,
        'poolEnabled',coalesce((select enabled from public.qorpera_company_computer_pool_members
            where profile_id=p_profile_id and user_id=auth.uid()),false),
        'availableAllowance',case when v_paid then jsonb_build_object('unit','standard_computer_microsecond','availableUs',v_available::text) else null end,
        'tariffPublished',true,'tariffVersion',(select tariff_version from public.qorpera_computer_billing_readiness));
end $$;

-- Preserve event-body identity across both reconciliation lanes.
create or replace function public.qorpera_begin_computer_billing_sync(p_event_id text,p_subscription_id text,p_event_created_at timestamptz,p_body_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_sync public.qorpera_computer_billing_syncs%rowtype; v_event public.qorpera_computer_billing_inbox%rowtype;
    v_token uuid:=extensions.gen_random_uuid();
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    if p_event_id is null or p_subscription_id is null or p_event_created_at is null or not isfinite(p_event_created_at)
        or p_body_sha256 is null then raise exception 'Billing event identity required' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('computer-billing-inbox:'||p_event_id,0));
    if exists(select 1 from public.qorpera_computer_payment_fence_events where event_id=p_event_id and body_sha256<>p_body_sha256) then
        raise exception 'Billing webhook replay differs' using errcode='23505'; end if;
    insert into public.qorpera_computer_billing_syncs(subscription_id) values(p_subscription_id) on conflict do nothing;
    select * into strict v_sync from public.qorpera_computer_billing_syncs where subscription_id=p_subscription_id for update;
    select * into v_event from public.qorpera_computer_billing_inbox where event_id=p_event_id;
    if found then
        if row(v_event.subscription_id,v_event.event_created_at,v_event.body_sha256)
            is distinct from row(p_subscription_id,p_event_created_at,p_body_sha256) then
            raise exception 'Billing webhook replay differs' using errcode='23505'; end if;
        if v_event.completed_at is not null then return '{"state":"completed"}'::jsonb; end if;
    else
        insert into public.qorpera_computer_billing_inbox(event_id,subscription_id,event_created_at,body_sha256)
            values(p_event_id,p_subscription_id,p_event_created_at,p_body_sha256);
    end if;
    if v_sync.lease_until>clock_timestamp() then return '{"state":"busy"}'::jsonb; end if;
    update public.qorpera_computer_billing_syncs set lease_token=v_token,active_event_id=p_event_id,lease_until=clock_timestamp()+interval '60 seconds',
        snapshot_started_at=greatest(clock_timestamp(),snapshot_started_at+interval '1 microsecond') where subscription_id=p_subscription_id;
    return jsonb_build_object('state','claimed','leaseToken',v_token);
end $$;
