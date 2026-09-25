-- Standard-computer microseconds. A subscription period has ONE global balance,
-- regardless of how many companies its member participates in. This kernel is
-- deliberately not an admission switch: runtime reserve/renew/stop must be wired
-- before computer_billing_readiness can be enabled.
create table public.qorpera_computer_allowance_buckets (
    id uuid primary key default extensions.gen_random_uuid(),
    invoice_id text not null unique check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
    subscription_id text not null references public.qorpera_computer_subscriptions(provider_subscription_id),
    user_id uuid not null references auth.users(id) on delete restrict,
    plan_key text not null,
    plan_version bigint not null,
    period_start timestamptz not null check(isfinite(period_start)),
    period_end timestamptz not null check(isfinite(period_end) and period_end>period_start),
    issued_us bigint not null check(issued_us>0),
    reserved_us bigint not null default 0 check(reserved_us>=0),
    debited_us bigint not null default 0 check(debited_us>=0),
    payment_proof jsonb not null,
    created_at timestamptz not null default clock_timestamp(),
    unique(subscription_id,period_start),
    foreign key(plan_key,plan_version) references public.qorpera_computer_plan_versions(plan_key,version),
    check(reserved_us::numeric+debited_us<=issued_us)
);
create table public.qorpera_computer_allowance_cursors (
    allocation_id uuid not null,
    epoch uuid not null,
    settled_sequence bigint not null default 0,
    settled_standard_us bigint not null default 0 check(settled_standard_us>=0),
    primary key(allocation_id,epoch),
    foreign key(allocation_id,epoch) references public.qorpera_computer_usage_streams(allocation_id,epoch)
);
create index qorpera_computer_allowance_member_period on public.qorpera_computer_allowance_buckets(user_id,period_end);
create table public.qorpera_computer_allowance_reservations (
    id uuid primary key,
    profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
    requested_by_user_id uuid references auth.users(id) on delete restrict,
    preferred_user_id uuid references auth.users(id) on delete restrict,
    allocation_id uuid not null,
    epoch uuid not null,
    from_sequence bigint not null,
    from_standard_us bigint not null check(from_standard_us>=0),
    reserved_us bigint not null check(reserved_us>0),
    deadline timestamptz not null check(isfinite(deadline)),
    created_at timestamptz not null default clock_timestamp(),
    settled_at timestamptz,
    foreign key(allocation_id,epoch) references public.qorpera_computer_usage_streams(allocation_id,epoch)
);
create unique index qorpera_computer_allowance_one_reservation on public.qorpera_computer_allowance_reservations(allocation_id,epoch) where settled_at is null;
create table public.qorpera_computer_allowance_holds (
    reservation_id uuid not null references public.qorpera_computer_allowance_reservations(id),
    bucket_id uuid not null references public.qorpera_computer_allowance_buckets(id),
    draw_order integer not null,
    amount_us bigint not null check(amount_us>0),
    primary key(reservation_id,bucket_id),
    unique(reservation_id,draw_order)
);
create table public.qorpera_computer_allowance_settlements (
    reservation_id uuid primary key references public.qorpera_computer_allowance_reservations(id),
    allocation_id uuid not null,
    epoch uuid not null,
    through_sequence bigint not null,
    total_standard_us bigint not null check(total_standard_us>=0),
    debited_us bigint not null check(debited_us>=0),
    released_us bigint not null check(released_us>=0),
    created_at timestamptz not null default clock_timestamp(),
    foreign key(allocation_id,epoch,through_sequence) references public.qorpera_computer_usage_receipts(allocation_id,epoch,sequence)
);
create table public.qorpera_computer_allowance_debits (
    reservation_id uuid not null references public.qorpera_computer_allowance_settlements(reservation_id),
    bucket_id uuid not null references public.qorpera_computer_allowance_buckets(id),
    debited_us bigint not null check(debited_us>=0),
    released_us bigint not null check(released_us>=0),
    primary key(reservation_id,bucket_id),
    foreign key(reservation_id,bucket_id) references public.qorpera_computer_allowance_holds(reservation_id,bucket_id)
);

-- Called only inside the serialized webhook transaction after canonical Stripe
-- invoice retrieval. Active subscription status alone never issues allowance.
create function public.qorpera_fund_computer_invoice(p_proof jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare b public.qorpera_computer_allowance_buckets%rowtype; s public.qorpera_computer_subscriptions%rowtype;
    p public.qorpera_computer_plan_versions%rowtype; v_start timestamptz; v_end timestamptz; v_us numeric;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>4096
        or (select count(*) from jsonb_object_keys(p_proof))<>11
        or coalesce(p_proof->>'invoiceId','') !~ '^in_[A-Za-z0-9]+$'
        or p_proof->>'status' is distinct from 'paid' or p_proof->>'currency' is distinct from 'dkk'
        or p_proof->>'billingReason' not in ('subscription_create','subscription_cycle')
        or num_nonnulls(p_proof->>'subscriptionId',p_proof->>'customerId',p_proof->>'planKey',p_proof->>'planVersion',
            p_proof->>'periodStart',p_proof->>'periodEnd',p_proof->>'amountPaid',p_proof->>'billingReason')<>8
        or (p_proof->>'amountPaid')::bigint<0 then raise exception 'Verified paid invoice required' using errcode='22023'; end if;
    select * into strict s from public.qorpera_computer_subscriptions where provider_subscription_id=p_proof->>'subscriptionId' for update;
    perform pg_advisory_xact_lock(hashtextextended('computer-invoice:'||(p_proof->>'invoiceId'),0));
    select * into b from public.qorpera_computer_allowance_buckets where invoice_id=p_proof->>'invoiceId';
    if found then
        if b.payment_proof is distinct from p_proof then raise exception 'Invoice replay differs' using errcode='23505'; end if;
        return b.id;
    end if;
    if s.provider_customer_id is distinct from p_proof->>'customerId' or not exists(select 1 from public.qorpera_computer_billing_customers
        where user_id=s.user_id and customer_id=s.provider_customer_id) then raise exception 'Invoice customer differs' using errcode='42501'; end if;
    select * into strict p from public.qorpera_computer_plan_versions where plan_key=p_proof->>'planKey' and version=(p_proof->>'planVersion')::bigint;
    v_start:=(p_proof->>'periodStart')::timestamptz; v_end:=(p_proof->>'periodEnd')::timestamptz;
    if not isfinite(v_start) or not isfinite(v_end) or v_end<=v_start then raise exception 'Invoice period invalid' using errcode='22023'; end if;
    if exists(select 1 from public.qorpera_computer_allowance_buckets where subscription_id=s.provider_subscription_id
        and period_start<v_end and period_end>v_start) then raise exception 'Subscription period already funded' using errcode='23505'; end if;
    v_us:=case when p.allowance_kind='calendar_month' then extract(epoch from v_end-v_start)*1000000 else p.advertised_hours::numeric*3600000000 end;
    insert into public.qorpera_computer_allowance_buckets(invoice_id,subscription_id,user_id,plan_key,plan_version,period_start,period_end,issued_us,payment_proof)
        values(p_proof->>'invoiceId',s.provider_subscription_id,s.user_id,p.plan_key,p.version,v_start,v_end,v_us::bigint,p_proof) returning id into b.id;
    return b.id;
end $$;

create function public.qorpera_reserve_computer_allowance(p_reservation_id uuid,p_profile_id uuid,p_requested_by_user_id uuid,
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
        where (m.user_id=p_requested_by_user_id or pm.enabled) and ab.period_start<=clock_timestamp() and ab.period_end>=p_deadline
        order by ab.id for update of ab loop
        v_candidates:=array_append(v_candidates,b.id);
    end loop;
    insert into public.qorpera_computer_allowance_reservations(id,profile_id,requested_by_user_id,preferred_user_id,allocation_id,epoch,from_sequence,from_standard_us,reserved_us,deadline)
        values(p_reservation_id,p_profile_id,p_requested_by_user_id,p_preferred_user_id,p_allocation_id,p_epoch,c.settled_sequence,c.settled_standard_us,p_amount_us,p_deadline);
    for b in select ab.* from public.qorpera_computer_allowance_buckets ab
        join public.qorpera_profile_members m on m.user_id=ab.user_id and m.profile_id=p_profile_id and m.role in ('owner','admin','contributor')
        left join public.qorpera_company_computer_pool_members pm on pm.profile_id=m.profile_id and pm.user_id=m.user_id
        where ab.id=any(v_candidates) and (m.user_id=p_requested_by_user_id or pm.enabled) and ab.period_start<=clock_timestamp() and ab.period_end>=p_deadline
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

create function public.qorpera_settle_computer_allowance(p_reservation_id uuid,p_through_sequence bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_computer_allowance_reservations%rowtype; d public.qorpera_computer_allowance_settlements%rowtype;
    s public.qorpera_computer_usage_streams%rowtype; cp public.qorpera_computer_usage_receipts%rowtype;
    t public.qorpera_computer_tariff_versions%rowtype; h record; v_normal jsonb; v_total bigint; v_cost bigint; v_left bigint; v_take bigint; v_profile uuid;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Runtime service required' using errcode='42501'; end if;
    select profile_id into v_profile from public.qorpera_computer_allowance_reservations where id=p_reservation_id;
    perform 1 from public.qorpera_profiles where id=v_profile for update;
    select * into strict r from public.qorpera_computer_allowance_reservations where id=p_reservation_id for update;
    select * into d from public.qorpera_computer_allowance_settlements where reservation_id=r.id;
    if found then
        if d.through_sequence is distinct from p_through_sequence then raise exception 'Settlement replay differs' using errcode='23505'; end if;
        return jsonb_build_object('debitedUs',d.debited_us::text,'releasedUs',d.released_us::text);
    end if;
    select * into strict s from public.qorpera_computer_usage_streams where allocation_id=r.allocation_id and epoch=r.epoch for update;
    select * into strict cp from public.qorpera_computer_usage_receipts where allocation_id=r.allocation_id and epoch=r.epoch and sequence=p_through_sequence;
    if p_through_sequence<r.from_sequence or cp.observed_at>r.deadline then raise exception 'Usage exceeds reservation window' using errcode='55000'; end if;
    select * into strict t from public.qorpera_computer_tariff_versions where version=s.tariff_version;
    v_normal:=public.qorpera_standard_computer_time(cp.active_ms,(s.resource_shape->>'cpuMillis')::bigint,(s.resource_shape->>'memoryBytes')::bigint,
        s.resource_kind,t.reference_cpu_millis,t.reference_memory_bytes);
    if v_normal is null then raise exception 'Unknown shape cannot be billed' using errcode='55000'; end if;
    -- Round cumulative total once, then subtract previous cumulative settlement.
    -- Checkpoint frequency cannot increase the bill.
    v_total:=ceil((v_normal->>'numerator')::numeric*1000/(v_normal->>'denominator')::numeric)::bigint;
    v_cost:=v_total-r.from_standard_us;
    if v_cost<0 or v_cost>r.reserved_us then raise exception 'Usage exceeds reserved allowance; reconcile before continuing' using errcode='55000'; end if;
    perform 1 from public.qorpera_computer_allowance_buckets b join public.qorpera_computer_allowance_holds hold_row on hold_row.bucket_id=b.id
        where hold_row.reservation_id=r.id order by b.id for update of b;
    insert into public.qorpera_computer_allowance_settlements values(r.id,r.allocation_id,r.epoch,p_through_sequence,v_total,v_cost,r.reserved_us-v_cost,clock_timestamp());
    v_left:=v_cost;
    for h in select * from public.qorpera_computer_allowance_holds where reservation_id=r.id order by draw_order loop
        v_take:=least(v_left,h.amount_us);
        update public.qorpera_computer_allowance_buckets set reserved_us=reserved_us-h.amount_us,debited_us=debited_us+v_take where id=h.bucket_id;
        insert into public.qorpera_computer_allowance_debits values(r.id,h.bucket_id,v_take,h.amount_us-v_take);
        v_left:=v_left-v_take;
    end loop;
    update public.qorpera_computer_allowance_cursors set settled_sequence=p_through_sequence,settled_standard_us=v_total where allocation_id=r.allocation_id and epoch=r.epoch;
    update public.qorpera_computer_allowance_reservations set settled_at=clock_timestamp() where id=r.id;
    return jsonb_build_object('debitedUs',v_cost::text,'releasedUs',(r.reserved_us-v_cost)::text);
end $$;

create function public.qorpera_my_computer_usage()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_balance jsonb; v_subscriptions jsonb; r public.qorpera_computer_billing_readiness%rowtype;
    t public.qorpera_computer_tariff_versions%rowtype;
begin
    if v_user is null or auth.role() is distinct from 'authenticated' then raise exception 'Member sign-in required' using errcode='42501'; end if;
    select * into strict r from public.qorpera_computer_billing_readiness where singleton;
    select * into strict t from public.qorpera_computer_tariff_versions where version=r.tariff_version;
    select jsonb_build_object('unit','standard_computer_microsecond','issuedUs',coalesce(sum(issued_us),0)::text,
        'reservedUs',coalesce(sum(reserved_us),0)::text,'debitedUs',coalesce(sum(debited_us),0)::text,
        'availableUs',coalesce(sum(issued_us-reserved_us-debited_us),0)::text) into v_balance
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

do $$ declare t text; begin
    foreach t in array array['qorpera_computer_allowance_buckets','qorpera_computer_allowance_cursors','qorpera_computer_allowance_reservations',
        'qorpera_computer_allowance_holds','qorpera_computer_allowance_settlements','qorpera_computer_allowance_debits'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    end loop;
end $$;
revoke all on function public.qorpera_fund_computer_invoice(jsonb),public.qorpera_reserve_computer_allowance(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz),
    public.qorpera_settle_computer_allowance(uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_fund_computer_invoice(jsonb),public.qorpera_reserve_computer_allowance(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz),
    public.qorpera_settle_computer_allowance(uuid,bigint) to service_role;
revoke all on function public.qorpera_my_computer_usage() from public,anon,authenticated,service_role;
grant execute on function public.qorpera_my_computer_usage() to authenticated;
