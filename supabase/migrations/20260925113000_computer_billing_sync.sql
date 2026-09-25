-- Canonical Stripe reconciliation is serialized before retrieval. Event order
-- is not subscription state order: Stripe may deliver old events last.
create table public.qorpera_computer_billing_customers (
    user_id uuid primary key references auth.users(id) on delete restrict,
    customer_id text not null unique check (customer_id ~ '^cus_[A-Za-z0-9]+$'),
    created_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_computer_billing_syncs (
    subscription_id text primary key check (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
    lease_token uuid,
    active_event_id text,
    lease_until timestamptz,
    snapshot_started_at timestamptz not null default clock_timestamp(),
    check ((lease_token is null) = (lease_until is null) and (lease_token is null) = (active_event_id is null))
);
create table public.qorpera_computer_billing_inbox (
    event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]+$'),
    subscription_id text not null references public.qorpera_computer_billing_syncs(subscription_id),
    event_created_at timestamptz not null check (isfinite(event_created_at)),
    body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
    received_at timestamptz not null default clock_timestamp(),
    completed_at timestamptz
);
create table public.qorpera_computer_billing_commands (
    id uuid primary key default extensions.gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete restrict,
    kind text not null check(kind in ('customer','checkout')),
    request_id uuid not null,
    payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=4096),
    result jsonb check(result is null or (jsonb_typeof(result)='object' and octet_length(result::text)<=4096)),
    lease_token uuid,
    lease_until timestamptz,
    created_at timestamptz not null default clock_timestamp(),
    unique(user_id,kind,request_id),
    check((lease_token is null)=(lease_until is null))
);
create unique index qorpera_computer_customer_command_once on public.qorpera_computer_billing_commands(user_id) where kind='customer';

create function public.qorpera_begin_computer_billing_command(p_user_id uuid,p_kind text,p_request_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.qorpera_computer_billing_commands%rowtype; v_token uuid:=extensions.gen_random_uuid(); v_customer text;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    if p_user_id is null or p_request_id is null or p_kind is null or p_kind not in ('customer','checkout') or p_payload is null then
        raise exception 'Invalid billing command' using errcode='22023'; end if;
    perform 1 from auth.users where id=p_user_id for update;
    if not found then raise exception 'Billing user missing' using errcode='42501'; end if;
    if p_kind='customer' then
        if p_payload<>'{}'::jsonb then raise exception 'Customer command payload differs' using errcode='22023'; end if;
        select customer_id into v_customer from public.qorpera_computer_billing_customers where user_id=p_user_id;
        if found then return jsonb_build_object('state','completed','result',jsonb_build_object('customerId',v_customer)); end if;
        select * into c from public.qorpera_computer_billing_commands where user_id=p_user_id and kind='customer';
    else
        if not exists(select 1 from public.qorpera_computer_billing_readiness r
            join public.qorpera_computer_plan_versions plan on plan.plan_key=p_payload->>'planKey'
                and plan.version=(p_payload->>'version')::bigint
            where r.runtime_accounting_ready and r.checkout_enabled and plan.active_for_checkout
                and r.tariff_version=(p_payload->>'tariffVersion')::bigint) then
            raise exception 'Computer checkout is not published' using errcode='55000'; end if;
        if exists(select 1 from public.qorpera_computer_subscriptions where user_id=p_user_id
            and status not in ('canceled','incomplete_expired') and period_end>clock_timestamp()) then
            raise exception 'A computer subscription already exists' using errcode='55000'; end if;
        select * into c from public.qorpera_computer_billing_commands where user_id=p_user_id and kind='checkout' and request_id=p_request_id;
        if c.id is null then
            -- A member cannot open two payable checkout sessions concurrently,
            -- nor evade that fence merely by generating another request UUID.
            select * into c from public.qorpera_computer_billing_commands where user_id=p_user_id and kind='checkout'
                and (result is null or (result->>'expiresAt')::timestamptz>clock_timestamp()) order by created_at desc limit 1;
        end if;
    end if;
    if c.id is not null and c.payload is distinct from p_payload then
        raise exception 'Billing command intent differs' using errcode='23505'; end if;
    if c.result is not null then return jsonb_build_object('state','completed','result',c.result); end if;
    if c.id is not null and c.created_at<=clock_timestamp()-interval '23 hours' then
        -- Stripe may forget idempotency keys after24h. Never retry an ambiguous
        -- create past that window; operator/provider reconciliation must settle it.
        return '{"state":"reconciliation_required"}'::jsonb; end if;
    if c.lease_until>clock_timestamp() then return '{"state":"busy"}'::jsonb; end if;
    if c.id is null then
        insert into public.qorpera_computer_billing_commands(user_id,kind,request_id,payload)
            values(p_user_id,p_kind,p_request_id,p_payload) returning * into c;
    end if;
    update public.qorpera_computer_billing_commands set lease_token=v_token,lease_until=clock_timestamp()+interval '60 seconds' where id=c.id;
    return jsonb_build_object('state','claimed','commandId',c.id,'leaseToken',v_token,'idempotencyKey','qorpera-computer-'||c.id::text);
end $$;

create function public.qorpera_finish_computer_billing_command(p_command_id uuid,p_lease_token uuid,p_result jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare c public.qorpera_computer_billing_commands%rowtype; v_user uuid;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    select user_id into v_user from public.qorpera_computer_billing_commands where id=p_command_id;
    perform 1 from auth.users where id=v_user for update;
    select * into c from public.qorpera_computer_billing_commands where id=p_command_id for update;
    if not found or p_lease_token is null or c.lease_token is distinct from p_lease_token or c.lease_until<=clock_timestamp()
        or c.lease_until is null then raise exception 'Billing command lease unavailable' using errcode='40001'; end if;
    if p_result is null or jsonb_typeof(p_result)<>'object' then raise exception 'Billing command result missing' using errcode='22023'; end if;
    if c.kind='customer' then
        if p_result->>'customerId' is null or (select count(*) from jsonb_object_keys(p_result))<>1 then
            raise exception 'Customer result differs' using errcode='22023'; end if;
        perform public.qorpera_map_computer_billing_customer(c.user_id,p_result->>'customerId');
    else
        if coalesce(p_result->>'sessionId','') !~ '^cs_[A-Za-z0-9_]+$'
            or coalesce(p_result->>'url','') !~ '^https://checkout[.]stripe[.]com/'
            or p_result->>'expiresAt' is null or not isfinite((p_result->>'expiresAt')::timestamptz)
            or (select count(*) from jsonb_object_keys(p_result))<>3 then
            raise exception 'Checkout result differs' using errcode='22023'; end if;
    end if;
    update public.qorpera_computer_billing_commands set result=p_result,lease_token=null,lease_until=null where id=c.id;
end $$;
create function public.qorpera_release_computer_billing_command(p_command_id uuid,p_lease_token uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    update public.qorpera_computer_billing_commands set lease_token=null,lease_until=null where id=p_command_id and lease_token=p_lease_token;
end $$;

create function public.qorpera_map_computer_billing_customer(p_user_id uuid,p_customer_id text)
returns void language plpgsql security definer set search_path='' as $$
declare v_customer text;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    insert into public.qorpera_computer_billing_customers(user_id,customer_id) values(p_user_id,p_customer_id)
        on conflict(user_id) do nothing;
    select customer_id into v_customer from public.qorpera_computer_billing_customers where user_id=p_user_id;
    if v_customer is distinct from p_customer_id then raise exception 'Customer mapping cannot be rebound' using errcode='23505'; end if;
end $$;
create function public.qorpera_computer_billing_customer(p_user_id uuid default null,p_customer_id text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
    if auth.role() is distinct from 'service_role' or num_nonnulls(p_user_id,p_customer_id)<>1 then
        raise exception 'Billing service mapping required' using errcode='42501'; end if;
    return (select jsonb_build_object('userId',user_id,'customerId',customer_id) from public.qorpera_computer_billing_customers
        where (p_user_id is not null and user_id=p_user_id) or (p_customer_id is not null and customer_id=p_customer_id));
end $$;

create function public.qorpera_begin_computer_billing_sync(p_event_id text,p_subscription_id text,p_event_created_at timestamptz,p_body_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_sync public.qorpera_computer_billing_syncs%rowtype; v_event public.qorpera_computer_billing_inbox%rowtype;
    v_token uuid:=extensions.gen_random_uuid();
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    if p_event_id is null or p_subscription_id is null or p_event_created_at is null or not isfinite(p_event_created_at)
        or p_body_sha256 is null then raise exception 'Billing event identity required' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('computer-billing-inbox:'||p_event_id,0));
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

create function public.qorpera_finish_computer_billing_sync(p_event_id text,p_lease_token uuid,p_payload jsonb,p_paid_invoice jsonb default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_sync public.qorpera_computer_billing_syncs%rowtype; v_event public.qorpera_computer_billing_inbox%rowtype;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    select * into v_event from public.qorpera_computer_billing_inbox where event_id=p_event_id;
    if not found then raise exception 'Billing event missing' using errcode='42501'; end if;
    select * into strict v_sync from public.qorpera_computer_billing_syncs where subscription_id=v_event.subscription_id for update;
    if p_lease_token is null or v_sync.lease_token is distinct from p_lease_token or v_sync.active_event_id is distinct from p_event_id or v_sync.lease_until<=clock_timestamp()
        or v_sync.lease_until is null or p_payload->>'subscriptionId' is distinct from v_event.subscription_id then
        raise exception 'Billing retrieval lease unavailable' using errcode='40001'; end if;
    if not exists(select 1 from public.qorpera_computer_billing_customers where customer_id=p_payload->>'customerId'
        and user_id=(p_payload->>'userId')::uuid) then raise exception 'Billing customer differs' using errcode='42501'; end if;
    -- Legacy reconciliation timestamp now orders serialized canonical retrievals.
    -- The original Stripe event timestamp remains immutable in the inbox.
    perform public.qorpera_reconcile_computer_subscription(p_event_id,v_sync.snapshot_started_at,p_payload);
    if p_paid_invoice is not null then
        if p_paid_invoice->>'subscriptionId' is distinct from p_payload->>'subscriptionId'
            or p_paid_invoice->>'customerId' is distinct from p_payload->>'customerId' then
            raise exception 'Paid invoice identity differs' using errcode='42501'; end if;
        -- Defined in116. This and the event completion are one transaction;
        -- a failed funding write leaves the webhook retryable.
        perform public.qorpera_fund_computer_invoice(p_paid_invoice);
    end if;
    update public.qorpera_computer_billing_inbox set completed_at=clock_timestamp() where event_id=p_event_id;
    update public.qorpera_computer_billing_syncs set lease_token=null,active_event_id=null,lease_until=null where subscription_id=v_event.subscription_id;
end $$;
create function public.qorpera_release_computer_billing_sync(p_event_id text,p_lease_token uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
    update public.qorpera_computer_billing_syncs set lease_token=null,active_event_id=null,lease_until=null
        where subscription_id=(select subscription_id from public.qorpera_computer_billing_inbox where event_id=p_event_id)
            and lease_token=p_lease_token and active_event_id=p_event_id;
end $$;
do $$ declare t text; begin
    foreach t in array array['qorpera_computer_billing_customers','qorpera_computer_billing_syncs','qorpera_computer_billing_inbox','qorpera_computer_billing_commands'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    end loop;
end $$;
revoke all on function public.qorpera_map_computer_billing_customer(uuid,text),public.qorpera_computer_billing_customer(uuid,text),
    public.qorpera_begin_computer_billing_command(uuid,text,uuid,jsonb),public.qorpera_finish_computer_billing_command(uuid,uuid,jsonb),
    public.qorpera_release_computer_billing_command(uuid,uuid),
    public.qorpera_begin_computer_billing_sync(text,text,timestamptz,text),public.qorpera_finish_computer_billing_sync(text,uuid,jsonb,jsonb),
    public.qorpera_release_computer_billing_sync(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_map_computer_billing_customer(uuid,text),public.qorpera_computer_billing_customer(uuid,text),
    public.qorpera_begin_computer_billing_command(uuid,text,uuid,jsonb),public.qorpera_finish_computer_billing_command(uuid,uuid,jsonb),
    public.qorpera_release_computer_billing_command(uuid,uuid),
    public.qorpera_begin_computer_billing_sync(text,text,timestamptz,text),public.qorpera_finish_computer_billing_sync(text,uuid,jsonb,jsonb),
    public.qorpera_release_computer_billing_sync(text,uuid) to service_role;
grant execute on function public.qorpera_computer_plan_catalog() to service_role;
