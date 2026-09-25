-- Computer subscriptions are separate from members' model accounts. This is
-- a shadow meter: raw resource time is never converted to charges or credits.
-- Checkout stays disabled until paid runtime admission and enforcement ship.
create table public.qorpera_computer_plan_versions (
    plan_key text not null,
    version bigint not null check (version > 0),
    display_name text not null,
    currency text not null check (currency = 'DKK'),
    monthly_price_minor bigint not null check (monthly_price_minor >= 0),
    advertised_hours integer check (advertised_hours > 0),
    allowance_kind text not null check (allowance_kind in ('hours','calendar_month')),
    active_for_checkout boolean not null default false,
    created_at timestamptz not null default clock_timestamp(),
    primary key (plan_key,version),
    check ((allowance_kind = 'hours') = (advertised_hours is not null))
);
insert into public.qorpera_computer_plan_versions
    (plan_key,version,display_name,currency,monthly_price_minor,advertised_hours,allowance_kind)
values ('basis',1,'Basis','DKK',18500,74,'hours'),
    ('standard',1,'Standard','DKK',63000,286,'hours'),
    ('dedicated',1,'Dedicated','DKK',159200,null,'calendar_month');

-- One standard computer is 4 vCPU / 8 GiB. Resource size uses the dominant
-- reserved CPU or RAM ratio, not measured utilization or concurrent agent count.
create table public.qorpera_computer_tariff_versions (
    version bigint primary key check(version>0),
    reference_cpu_millis bigint not null check(reference_cpu_millis>0),
    reference_memory_bytes bigint not null check(reference_memory_bytes>0),
    normalization text not null check(normalization='dominant_reserved_resource'),
    published_at timestamptz not null default clock_timestamp()
);
insert into public.qorpera_computer_tariff_versions(version,reference_cpu_millis,reference_memory_bytes,normalization)
    values(1,4000,8589934592,'dominant_reserved_resource');
create table public.qorpera_computer_billing_readiness (
    singleton boolean primary key default true check(singleton),
    tariff_version bigint not null references public.qorpera_computer_tariff_versions(version),
    runtime_accounting_ready boolean not null default false,
    checkout_enabled boolean not null default false,
    check(not checkout_enabled or runtime_accounting_ready)
);
insert into public.qorpera_computer_billing_readiness(singleton,tariff_version) values(true,1);

-- Pure exact arithmetic. A rational result avoids rounding every checkpoint;
-- eventual settlement must difference cumulative values, never sum checkpoints.
create function public.qorpera_standard_computer_time(p_active_ms bigint,p_cpu_millis bigint,p_memory_bytes bigint,
    p_resource_kind text,p_reference_cpu_millis bigint,p_reference_memory_bytes bigint)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_numerator numeric; v_denominator numeric;
begin
    if p_active_ms is null or p_active_ms<0 or p_resource_kind is null or p_resource_kind not in
        ('agent_sandbox','company_computer','coding_machine','login_helper') then
        raise exception 'Invalid computer time' using errcode='22023'; end if;
    if p_resource_kind='login_helper' or p_active_ms=0 then
        return '{"numerator":"0","denominator":"1","unit":"standard_computer_millisecond"}'::jsonb; end if;
    if p_cpu_millis is null or p_memory_bytes is null then return null; end if;
    if p_cpu_millis<=0 or p_memory_bytes<=0 or p_reference_cpu_millis is null or p_reference_cpu_millis<=0
        or p_reference_memory_bytes is null or p_reference_memory_bytes<=0 then
        raise exception 'Invalid computer resource shape' using errcode='22023'; end if;
    v_numerator:=p_active_ms::numeric*greatest(p_cpu_millis::numeric*p_reference_memory_bytes,p_memory_bytes::numeric*p_reference_cpu_millis);
    v_denominator:=p_reference_cpu_millis::numeric*p_reference_memory_bytes;
    return jsonb_build_object('numerator',v_numerator::text,'denominator',v_denominator::text,'unit','standard_computer_millisecond');
end $$;

create table public.qorpera_computer_subscriptions (
    provider_subscription_id text primary key check (length(provider_subscription_id) between 1 and 255),
    provider_customer_id text not null check (length(provider_customer_id) between 1 and 255),
    user_id uuid not null references auth.users(id) on delete restrict,
    plan_key text not null,
    plan_version bigint not null,
    status text not null check (status in ('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')),
    period_start timestamptz not null,
    period_end timestamptz not null,
    last_event_id text not null,
    last_event_created_at timestamptz not null,
    updated_at timestamptz not null default clock_timestamp(),
    foreign key (plan_key,plan_version) references public.qorpera_computer_plan_versions(plan_key,version),
    check (isfinite(period_start) and isfinite(period_end) and period_start < period_end)
);
create table public.qorpera_computer_subscription_events (
    event_id text primary key check (length(event_id) between 1 and 255),
    event_created_at timestamptz not null check (isfinite(event_created_at)),
    payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
    received_at timestamptz not null default clock_timestamp(),
    applied boolean not null
);
create table public.qorpera_company_computer_pool_members (
    profile_id uuid not null,
    user_id uuid not null,
    enabled boolean not null,
    updated_at timestamptz not null default clock_timestamp(),
    primary key(profile_id,user_id),
    foreign key(profile_id,user_id) references public.qorpera_profile_members(profile_id,user_id) on delete cascade
);
create table public.qorpera_company_computer_entitlements (
    grant_key text primary key check (length(grant_key) between 1 and 255),
    profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
    expires_at timestamptz not null check (isfinite(expires_at)),
    reason text not null check (length(reason) between 1 and 500),
    granted_at timestamptz not null default clock_timestamp(),
    revoked_at timestamptz
);

-- A stream measures one allocation's awake epoch, never a sum of its runs.
-- Initial receipt must be (sequence=0,elapsed=0,active=0). Missing checkpoints
-- remain explicit; cumulative monotonic time can recover their duration.
create table public.qorpera_computer_usage_streams (
    allocation_id uuid not null references public.qorpera_runtime_machine_allocations(id) on delete restrict,
    epoch uuid not null,
    instance_sha256 text not null check (instance_sha256 ~ '^[0-9a-f]{64}$'),
    resource_kind text not null check (resource_kind in ('agent_sandbox','company_computer','coding_machine','login_helper')),
    -- Immutable admitted resource shape at epoch start. Null means unknown,
    -- never a default machine size or permission to turn this into a charge.
    resource_shape jsonb check (resource_shape is null or jsonb_typeof(resource_shape)='object'),
    tariff_version bigint not null references public.qorpera_computer_tariff_versions(version),
    last_sequence bigint not null check (last_sequence >= 0),
    elapsed_ms bigint not null check (elapsed_ms >= 0),
    active_ms bigint not null check (active_ms >= 0 and active_ms <= elapsed_ms),
    observed_at timestamptz not null,
    closed boolean not null,
    primary key(allocation_id,epoch)
);
create unique index qorpera_computer_usage_one_open_epoch
    on public.qorpera_computer_usage_streams(allocation_id) where not closed;
create table public.qorpera_computer_usage_receipts (
    allocation_id uuid not null,
    epoch uuid not null,
    sequence bigint not null check (sequence >= 0),
    elapsed_ms bigint not null,
    active_ms bigint not null,
    observed_at timestamptz not null,
    closed boolean not null,
    evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
    missing_checkpoints bigint not null check (missing_checkpoints >= 0),
    received_at timestamptz not null default clock_timestamp(),
    primary key(allocation_id,epoch,sequence),
    foreign key(allocation_id,epoch) references public.qorpera_computer_usage_streams(allocation_id,epoch)
);

create function public.qorpera_reconcile_computer_subscription(p_event_id text,p_event_created_at timestamptz,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.qorpera_computer_subscription_events%rowtype;
    v_subscription public.qorpera_computer_subscriptions%rowtype; v_apply boolean;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Payment service authority required' using errcode='42501'; end if;
    if p_event_id is null or length(p_event_id) not between 1 and 255 or p_event_created_at is null
        or not isfinite(p_event_created_at) or p_event_created_at > clock_timestamp()+interval '5 minutes'
        or p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 8192
        or not (p_payload ?& array['subscriptionId','customerId','userId','planKey','planVersion','status','periodStart','periodEnd'])
        or exists(select 1 from jsonb_each_text(p_payload) field where field.value is null or field.value='')
        or exists(select 1 from jsonb_object_keys(p_payload) k where k not in
            ('subscriptionId','customerId','userId','planKey','planVersion','status','periodStart','periodEnd')) then
        raise exception 'Invalid subscription event' using errcode='22023'; end if;
    -- Global event key plus subscription lock prevents replay/reordering races.
    perform pg_advisory_xact_lock(hashtextextended('computer-payment-event:'||p_event_id,0));
    select * into v_old from public.qorpera_computer_subscription_events where event_id=p_event_id;
    if found then
        if v_old.payload is distinct from p_payload or v_old.event_created_at is distinct from p_event_created_at then
            raise exception 'Subscription event replay differs' using errcode='23505'; end if;
        return jsonb_build_object('eventId',p_event_id,'applied',v_old.applied);
    end if;
    perform pg_advisory_xact_lock(hashtextextended('computer-subscription:'||(p_payload->>'subscriptionId'),0));
    select * into v_subscription from public.qorpera_computer_subscriptions where provider_subscription_id=p_payload->>'subscriptionId' for update;
    if found and (v_subscription.user_id is distinct from (p_payload->>'userId')::uuid
        or v_subscription.provider_customer_id is distinct from p_payload->>'customerId') then
        raise exception 'Subscription ownership cannot be rebound' using errcode='42501'; end if;
    -- Stripe event timestamps have second precision. An equal-time conflicting
    -- event requires the bridge to re-fetch canonical state; never guess order.
    if v_subscription.provider_subscription_id is not null and p_event_created_at=v_subscription.last_event_created_at then
        raise exception 'Subscription event ordering is ambiguous' using errcode='40001'; end if;
    v_apply := v_subscription.provider_subscription_id is null or p_event_created_at>v_subscription.last_event_created_at;
    if v_apply then
        insert into public.qorpera_computer_subscriptions(provider_subscription_id,provider_customer_id,user_id,plan_key,plan_version,
            status,period_start,period_end,last_event_id,last_event_created_at)
        values(p_payload->>'subscriptionId',p_payload->>'customerId',(p_payload->>'userId')::uuid,p_payload->>'planKey',
            (p_payload->>'planVersion')::bigint,p_payload->>'status',(p_payload->>'periodStart')::timestamptz,
            (p_payload->>'periodEnd')::timestamptz,p_event_id,p_event_created_at)
        on conflict(provider_subscription_id) do update set plan_key=excluded.plan_key,plan_version=excluded.plan_version,
            status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,
            last_event_id=excluded.last_event_id,last_event_created_at=excluded.last_event_created_at,updated_at=clock_timestamp();
    end if;
    insert into public.qorpera_computer_subscription_events(event_id,event_created_at,payload,applied)
        values(p_event_id,p_event_created_at,p_payload,v_apply);
    return jsonb_build_object('eventId',p_event_id,'applied',v_apply);
end $$;

create function public.qorpera_set_company_computer_pool(p_profile_id uuid,p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
    if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_enabled is null then
        raise exception 'Member authority required' using errcode='42501'; end if;
    perform 1 from public.qorpera_profiles where id=p_profile_id for update;
    perform 1 from public.qorpera_profile_members where profile_id=p_profile_id and user_id=auth.uid()
        and role in ('owner','admin','contributor') for share;
    if not found then raise exception 'Current company membership required' using errcode='42501'; end if;
    insert into public.qorpera_company_computer_pool_members(profile_id,user_id,enabled) values(p_profile_id,auth.uid(),p_enabled)
        on conflict(profile_id,user_id) do update set enabled=excluded.enabled,updated_at=clock_timestamp();
end $$;

create function public.qorpera_computer_plan_catalog()
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('schema','qorpera.computer-plan-catalog/v1','meterMode','shadow','plans',
        jsonb_agg(jsonb_build_object('planKey',plan_key,'version',version,'name',display_name,'currency',currency,
            'monthlyPriceMinor',monthly_price_minor,'advertisedHours',advertised_hours,'allowanceKind',allowance_kind,
            'activeForCheckout',active_for_checkout and (select checkout_enabled and runtime_accounting_ready from public.qorpera_computer_billing_readiness),
            'tariffVersion',(select tariff_version from public.qorpera_computer_billing_readiness)) order by monthly_price_minor))
    from public.qorpera_computer_plan_versions
$$;

create function public.qorpera_grant_computer_entitlement(p_profile_id uuid,p_expires_at timestamptz,p_reason text,p_grant_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_grant public.qorpera_company_computer_entitlements%rowtype;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Computer entitlement operator required' using errcode='42501'; end if;
    perform 1 from public.qorpera_profiles where id=p_profile_id for update;
    if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at<=clock_timestamp() then
        raise exception 'Future entitlement expiry required' using errcode='22023'; end if;
    insert into public.qorpera_company_computer_entitlements(grant_key,profile_id,expires_at,reason)
        values(p_grant_key,p_profile_id,p_expires_at,p_reason) on conflict(grant_key) do nothing;
    select * into strict v_grant from public.qorpera_company_computer_entitlements where grant_key=p_grant_key;
    if v_grant.profile_id is distinct from p_profile_id or v_grant.expires_at is distinct from p_expires_at
        or v_grant.reason is distinct from p_reason then raise exception 'Entitlement replay differs' using errcode='23505'; end if;
end $$;
create function public.qorpera_revoke_computer_entitlement(p_grant_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Computer entitlement operator required' using errcode='42501'; end if;
    select profile_id into v_profile from public.qorpera_company_computer_entitlements where grant_key=p_grant_key;
    perform 1 from public.qorpera_profiles where id=v_profile for update;
    update public.qorpera_company_computer_entitlements set revoked_at=coalesce(revoked_at,clock_timestamp()) where grant_key=p_grant_key;
end $$;

create function public.qorpera_company_computer_usage_status(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_granted boolean; v_members bigint;
begin
    if auth.role() is distinct from 'service_role' and
        (auth.role() is distinct from 'authenticated' or auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id)) then
        raise exception 'Company usage access denied' using errcode='42501'; end if;
    select exists(select 1 from public.qorpera_company_computer_entitlements where profile_id=p_profile_id
        and revoked_at is null and expires_at>statement_timestamp()) into v_granted;
    v_granted:=v_granted or exists(select 1 from public.qorpera_company_computer_pool_members pool
        join public.qorpera_profile_members member using(profile_id,user_id)
        join public.qorpera_account_entitlements entitlement using(user_id)
        where pool.profile_id=p_profile_id and pool.enabled and member.role in ('owner','admin','contributor')
            and entitlement.plan_key='internal' and entitlement.billing_mode='complimentary');
    select count(*) into v_members from public.qorpera_company_computer_pool_members pool
        join public.qorpera_profile_members member using(profile_id,user_id)
        where pool.profile_id=p_profile_id and pool.enabled and member.role in ('owner','admin','contributor');
    return jsonb_build_object('schema','qorpera.company-computer-usage/v1','canStart',v_granted,
        'reason',case when v_granted then 'complimentary_entitlement' else 'computer_plan_required' end,
        'meterMode','shadow','checkoutAvailable',false,'poolMembers',v_members,
        'poolEnabled',coalesce((select enabled from public.qorpera_company_computer_pool_members
            where profile_id=p_profile_id and user_id=auth.uid()),false),
        'availableAllowance',null,'tariffPublished',true,
        'tariffVersion',(select tariff_version from public.qorpera_computer_billing_readiness));
end $$;

create function public.qorpera_record_computer_usage_checkpoint(p_allocation_id uuid,p_instance_sha256 text,p_epoch uuid,
    p_sequence bigint,p_elapsed_ms bigint,p_active_ms bigint,p_observed_at timestamptz,p_closed boolean,p_resource_kind text,p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_allocation public.qorpera_runtime_machine_allocations%rowtype;
    v_stream public.qorpera_computer_usage_streams%rowtype; v_receipt public.qorpera_computer_usage_receipts%rowtype;
    v_kind text; v_missing bigint:=0; v_shape jsonb;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Trusted computer observer required' using errcode='42501'; end if;
    if p_epoch is null or p_sequence is null or p_sequence<0 or p_elapsed_ms is null or p_elapsed_ms<0
        or p_active_ms is null or p_active_ms<0 or p_active_ms>p_elapsed_ms or p_closed is null
        or p_observed_at is null or not isfinite(p_observed_at) or p_observed_at>clock_timestamp()+interval '2 seconds'
        or coalesce(p_evidence_sha256,'') !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid computer checkpoint' using errcode='22023'; end if;
    select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
    if not found or v_allocation.instance_sha256 is distinct from p_instance_sha256 then
        raise exception 'Computer allocation identity differs' using errcode='42501'; end if;
    v_kind:=case when v_allocation.office_id is not null then 'company_computer'
        when v_allocation.coding_machine_id is not null or v_allocation.coding_worker_id is not null then 'coding_machine'
        when v_allocation.run_id is not null then 'agent_sandbox' else 'login_helper' end;
    if p_resource_kind is distinct from v_kind then raise exception 'Computer resource kind differs' using errcode='42501'; end if;
    select * into v_stream from public.qorpera_computer_usage_streams where allocation_id=p_allocation_id and epoch=p_epoch for update;
    if found and (v_stream.instance_sha256 is distinct from p_instance_sha256 or v_stream.resource_kind is distinct from v_kind) then
        raise exception 'Computer epoch identity differs' using errcode='42501'; end if;
    select * into v_receipt from public.qorpera_computer_usage_receipts where allocation_id=p_allocation_id and epoch=p_epoch and sequence=p_sequence;
    if found then
        if row(v_receipt.elapsed_ms,v_receipt.active_ms,v_receipt.observed_at,v_receipt.closed,v_receipt.evidence_sha256)
            is distinct from row(p_elapsed_ms,p_active_ms,p_observed_at,p_closed,p_evidence_sha256) then
            raise exception 'Computer checkpoint replay differs' using errcode='23505'; end if;
        return jsonb_build_object('recorded',true,'missingCheckpoints',v_receipt.missing_checkpoints,'charged',false);
    end if;
    if v_stream.allocation_id is null then
        if p_sequence<>0 or p_elapsed_ms<>0 or p_active_ms<>0 or p_closed or v_allocation.released_at is not null
            or exists(select 1 from public.qorpera_computer_usage_streams where allocation_id=p_allocation_id and observed_at>=p_observed_at) then
            raise exception 'Computer epoch must start from zero after the preceding epoch' using errcode='22023'; end if;
        select jsonb_build_object('source','admitted_node_demand','nodeId',node_id,'providerKind',provider_kind,
            'policySha256',policy_sha256,'cpuMillis',cpu_millis,'memoryBytes',memory_bytes) into v_shape
            from public.qorpera_runtime_node_demands where allocation_id=p_allocation_id and reserved_at is not null;
        insert into public.qorpera_computer_usage_streams(allocation_id,epoch,instance_sha256,resource_kind,resource_shape,tariff_version,
            last_sequence,elapsed_ms,active_ms,observed_at,closed)
            values(p_allocation_id,p_epoch,p_instance_sha256,v_kind,v_shape,
                (select tariff_version from public.qorpera_computer_billing_readiness),0,0,0,p_observed_at,false);
    else
        if v_stream.closed or p_sequence<=v_stream.last_sequence or p_elapsed_ms<v_stream.elapsed_ms or p_active_ms<v_stream.active_ms
            or p_active_ms-v_stream.active_ms>p_elapsed_ms-v_stream.elapsed_ms or p_observed_at<v_stream.observed_at then
            raise exception 'Computer checkpoint is not monotonic' using errcode='22023'; end if;
        v_missing:=p_sequence-v_stream.last_sequence-1;
        update public.qorpera_computer_usage_streams set last_sequence=p_sequence,elapsed_ms=p_elapsed_ms,active_ms=p_active_ms,
            observed_at=p_observed_at,closed=p_closed where allocation_id=p_allocation_id and epoch=p_epoch;
    end if;
    insert into public.qorpera_computer_usage_receipts values(p_allocation_id,p_epoch,p_sequence,p_elapsed_ms,p_active_ms,
        p_observed_at,p_closed,p_evidence_sha256,v_missing,clock_timestamp());
    return jsonb_build_object('recorded',true,'missingCheckpoints',v_missing,'charged',false);
end $$;

do $$ declare t text; begin
    foreach t in array array['qorpera_computer_plan_versions','qorpera_computer_tariff_versions','qorpera_computer_billing_readiness','qorpera_computer_subscriptions','qorpera_computer_subscription_events',
        'qorpera_company_computer_pool_members','qorpera_company_computer_entitlements','qorpera_computer_usage_streams','qorpera_computer_usage_receipts'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    end loop;
end $$;
revoke all on function public.qorpera_reconcile_computer_subscription(text,timestamptz,jsonb),
    public.qorpera_standard_computer_time(bigint,bigint,bigint,text,bigint,bigint),
    public.qorpera_computer_plan_catalog(),
    public.qorpera_set_company_computer_pool(uuid,boolean),public.qorpera_grant_computer_entitlement(uuid,timestamptz,text,text),
    public.qorpera_revoke_computer_entitlement(text),public.qorpera_company_computer_usage_status(uuid),
    public.qorpera_record_computer_usage_checkpoint(uuid,text,uuid,bigint,bigint,bigint,timestamptz,boolean,text,text)
    from public,anon,authenticated,service_role;
grant execute on function public.qorpera_set_company_computer_pool(uuid,boolean),public.qorpera_company_computer_usage_status(uuid),
    public.qorpera_computer_plan_catalog() to authenticated;
grant execute on function public.qorpera_reconcile_computer_subscription(text,timestamptz,jsonb),
    public.qorpera_standard_computer_time(bigint,bigint,bigint,text,bigint,bigint),
    public.qorpera_grant_computer_entitlement(uuid,timestamptz,text,text),public.qorpera_revoke_computer_entitlement(text),
    public.qorpera_company_computer_usage_status(uuid),
    public.qorpera_record_computer_usage_checkpoint(uuid,text,uuid,bigint,bigint,bigint,timestamptz,boolean,text,text) to service_role;
