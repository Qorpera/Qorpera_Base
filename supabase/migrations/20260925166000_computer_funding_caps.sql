-- Original issuance and measured debits are immutable financial history. A
-- canonical reversal changes only the funded cap, never existing stop custody.
create table public.qorpera_computer_invoice_funding (
 invoice_id text primary key, subscription_id text not null, customer_id text not null,
 basis_minor bigint not null check(basis_minor>=0), reversed_minor bigint not null check(reversed_minor>=0 and reversed_minor<=basis_minor),
 held boolean not null, snapshot jsonb not null, snapshot_started_at timestamptz not null, reconciled_at timestamptz not null
);
create table public.qorpera_computer_invoice_funding_events (
 event_id text not null references public.qorpera_computer_billing_inbox(event_id), lease_token uuid not null,
 invoice_id text not null, snapshot jsonb not null, snapshot_started_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(), primary key(event_id,lease_token,invoice_id)
);
alter table public.qorpera_computer_allowance_buckets add column funded_us bigint;
update public.qorpera_computer_allowance_buckets set funded_us=issued_us;
alter table public.qorpera_computer_allowance_buckets alter column funded_us set not null;
alter table public.qorpera_computer_allowance_buckets add constraint qorpera_computer_funded_cap check(funded_us>=0 and funded_us<=issued_us);

create or replace function public.qorpera_computer_bucket_payment_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare f public.qorpera_computer_invoice_funding%rowtype; legacy public.qorpera_computer_payment_fences%rowtype; expected bigint;
begin
 if tg_op='INSERT' then
  perform pg_advisory_xact_lock(hashtextextended('computer-invoice:'||new.invoice_id,0));
 else
  if row(new.invoice_id,new.subscription_id,new.user_id,new.plan_key,new.plan_version,new.period_start,new.period_end,new.issued_us,new.payment_proof)
    is distinct from row(old.invoice_id,old.subscription_id,old.user_id,old.plan_key,old.plan_version,old.period_start,old.period_end,old.issued_us,old.payment_proof) then
   raise exception 'Original allowance identity is immutable' using errcode='42501'; end if;
 end if;
 select * into f from public.qorpera_computer_invoice_funding where invoice_id=new.invoice_id;
 if tg_op='UPDATE' and old.payment_fenced and not new.payment_fenced and (not found or f.held or
  exists(select 1 from public.qorpera_computer_payment_fence_events where invoice_id=new.invoice_id and created_at>f.reconciled_at)) then
  raise exception 'Canonical funding restoration required' using errcode='42501'; end if;
 if found then
  if f.subscription_id<>new.subscription_id or f.customer_id is distinct from new.payment_proof->>'customerId' then
   raise exception 'Funding snapshot identity differs' using errcode='23505'; end if;
  expected:=case when f.basis_minor=0 then new.issued_us else floor(new.issued_us::numeric*(f.basis_minor-f.reversed_minor)/f.basis_minor)::bigint end;
  if tg_op='UPDATE' and new.funded_us<>old.funded_us and new.funded_us<>expected then
   raise exception 'Canonical funding cap required' using errcode='42501'; end if;
  new.funded_us:=expected;
  if f.held or exists(select 1 from public.qorpera_computer_payment_fence_events where invoice_id=new.invoice_id and created_at>f.reconciled_at) then
   new.payment_fenced:=true;
  end if;
 else
  if tg_op='UPDATE' and new.funded_us<>old.funded_us then raise exception 'Canonical funding cap required' using errcode='42501'; end if;
  new.funded_us:=new.issued_us;
 end if;
 select * into legacy from public.qorpera_computer_payment_fences where invoice_id=new.invoice_id;
 if found then
  if legacy.subscription_id<>new.subscription_id or legacy.customer_id is distinct from new.payment_proof->>'customerId' then
   raise exception 'Invoice fence identity differs' using errcode='23505'; end if;
  if f.invoice_id is null then new.payment_fenced:=true; end if;
 end if;
 if tg_op='UPDATE' then
  if old.payment_fenced and not new.payment_fenced and (f.invoice_id is null or f.held or
    exists(select 1 from public.qorpera_computer_payment_fence_events where invoice_id=new.invoice_id and created_at>f.reconciled_at)) then
   raise exception 'Canonical funding restoration required' using errcode='42501'; end if;
  if new.reserved_us>old.reserved_us and (new.payment_fenced or new.reserved_us::numeric+new.debited_us>new.funded_us) then
   raise exception 'Unfunded allowance cannot authorize new usage' using errcode='42501'; end if;
 end if;
 return new;
end $$;

create function public.qorpera_apply_computer_invoice_funding(p_event_id text,p_lease_token uuid,p_snapshot jsonb,p_complete boolean)
returns void language plpgsql security definer set search_path='' as $$
declare e public.qorpera_computer_billing_inbox%rowtype; s public.qorpera_computer_billing_syncs%rowtype;
 f public.qorpera_computer_invoice_funding%rowtype; prior jsonb; basis bigint; reversed bigint;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Billing service required' using errcode='42501'; end if;
 if p_complete is null or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object' or octet_length(p_snapshot::text)>8192
  or (select count(*) from jsonb_object_keys(p_snapshot))<>10
  or not p_snapshot ?& array['invoiceId','subscriptionId','customerId','currency','basisMinor','reversedMinor','held','evidenceSha256','schema','evidence']
  or p_snapshot->>'schema' is distinct from 'qorpera.invoice-funding/v1' or p_snapshot->>'currency' is distinct from 'dkk'
  or coalesce(p_snapshot->>'invoiceId','') !~ '^in_[A-Za-z0-9]+$' or coalesce(p_snapshot->>'subscriptionId','') !~ '^sub_[A-Za-z0-9]+$'
  or coalesce(p_snapshot->>'customerId','') !~ '^cus_[A-Za-z0-9]+$' or coalesce(p_snapshot->>'evidenceSha256','') !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(p_snapshot->'evidence') is distinct from 'string'
  or jsonb_typeof(p_snapshot->'held') is distinct from 'boolean'
  or jsonb_typeof(p_snapshot->'basisMinor') is distinct from 'number' or jsonb_typeof(p_snapshot->'reversedMinor') is distinct from 'number'
  or p_snapshot->>'basisMinor' !~ '^[0-9]{1,15}$' or p_snapshot->>'reversedMinor' !~ '^[0-9]{1,15}$' then
  raise exception 'Canonical invoice funding snapshot required' using errcode='22023'; end if;
 -- Preserve exact sanitized JSON bytes: jsonb reordering must not change the
 -- evidence digest or make an audit impossible to reproduce.
 if jsonb_typeof((p_snapshot->>'evidence')::jsonb) is distinct from 'object' or
  encode(extensions.digest(convert_to(p_snapshot->>'evidence','UTF8'),'sha256'),'hex') is distinct from p_snapshot->>'evidenceSha256' then
  raise exception 'Funding evidence digest differs' using errcode='22023'; end if;
 basis:=(p_snapshot->>'basisMinor')::bigint; reversed:=(p_snapshot->>'reversedMinor')::bigint;
 if reversed>basis then raise exception 'Reversal exceeds original funding' using errcode='22023'; end if;
 select * into e from public.qorpera_computer_billing_inbox where event_id=p_event_id;
 if not found or e.subscription_id is distinct from p_snapshot->>'subscriptionId' then raise exception 'Billing event differs' using errcode='42501'; end if;
 select * into strict s from public.qorpera_computer_billing_syncs where subscription_id=e.subscription_id for update;
 if p_lease_token is null or s.lease_token is distinct from p_lease_token or s.active_event_id is distinct from p_event_id
  or s.lease_until is null or s.lease_until<=clock_timestamp() or e.completed_at is not null then
  raise exception 'Billing retrieval lease unavailable' using errcode='40001'; end if;
 perform pg_advisory_xact_lock(hashtextextended('computer-invoice:'||(p_snapshot->>'invoiceId'),0));
 if not exists(select 1 from public.qorpera_computer_billing_customers where customer_id=p_snapshot->>'customerId')
  or exists(select 1 from public.qorpera_computer_subscriptions where provider_subscription_id=e.subscription_id and provider_customer_id<>p_snapshot->>'customerId')
  or exists(select 1 from public.qorpera_computer_allowance_buckets where invoice_id=p_snapshot->>'invoiceId'
   and (subscription_id<>e.subscription_id or payment_proof->>'customerId'<>p_snapshot->>'customerId')) then
  raise exception 'Invoice funding identity differs' using errcode='42501'; end if;
 select * into f from public.qorpera_computer_invoice_funding where invoice_id=p_snapshot->>'invoiceId';
 if found and (row(f.subscription_id,f.customer_id,f.basis_minor) is distinct from row(e.subscription_id,p_snapshot->>'customerId',basis)
  or f.snapshot_started_at>s.snapshot_started_at) then raise exception 'Invoice funding basis or ordering differs' using errcode='23505'; end if;
 select snapshot into prior from public.qorpera_computer_invoice_funding_events where event_id=p_event_id and lease_token=p_lease_token and invoice_id=p_snapshot->>'invoiceId';
 if found and prior is distinct from p_snapshot then raise exception 'Funding snapshot replay differs' using errcode='23505'; end if;
 insert into public.qorpera_computer_invoice_funding_events(event_id,lease_token,invoice_id,snapshot,snapshot_started_at)
  values(p_event_id,p_lease_token,p_snapshot->>'invoiceId',p_snapshot,s.snapshot_started_at) on conflict do nothing;
 insert into public.qorpera_computer_invoice_funding values(p_snapshot->>'invoiceId',e.subscription_id,p_snapshot->>'customerId',basis,reversed,
  (p_snapshot->>'held')::boolean,p_snapshot,s.snapshot_started_at,clock_timestamp())
 on conflict(invoice_id) do update set reversed_minor=excluded.reversed_minor,held=excluded.held,snapshot=excluded.snapshot,
  snapshot_started_at=excluded.snapshot_started_at,reconciled_at=excluded.reconciled_at;
 -- Lock and adjust the GLOBAL bucket, not a per-company copy. Already committed
 -- holds remain payable even when their sum now exceeds the reduced cap.
 update public.qorpera_computer_allowance_buckets set funded_us=case when basis=0 then issued_us else floor(issued_us::numeric*(basis-reversed)/basis)::bigint end,
  payment_fenced=(p_snapshot->>'held')::boolean where invoice_id=p_snapshot->>'invoiceId';
 if p_complete then
  update public.qorpera_computer_billing_inbox set completed_at=clock_timestamp() where event_id=p_event_id;
  update public.qorpera_computer_billing_syncs set lease_token=null,active_event_id=null,lease_until=null where subscription_id=e.subscription_id;
 end if;
end $$;

create function public.qorpera_computer_funding_audit_immutable() returns trigger
language plpgsql set search_path='' as $$ begin raise exception 'Funding audit is immutable' using errcode='42501'; end $$;
create trigger qorpera_computer_funding_audit_immutable before update or delete on public.qorpera_computer_invoice_funding_events
 for each row execute function public.qorpera_computer_funding_audit_immutable();
revoke all on function public.qorpera_computer_funding_audit_immutable() from public,anon,authenticated,service_role,qorpera_secret_broker;

alter table public.qorpera_computer_invoice_funding enable row level security;
alter table public.qorpera_computer_invoice_funding_events enable row level security;
revoke all on public.qorpera_computer_invoice_funding,public.qorpera_computer_invoice_funding_events from public,anon,authenticated,service_role,qorpera_secret_broker;
revoke all on function public.qorpera_apply_computer_invoice_funding(text,uuid,jsonb,boolean) from public,anon,authenticated,service_role,qorpera_secret_broker;

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
        and ab.funded_us-ab.reserved_us-ab.debited_us>0
        order by (ab.user_id=p_requested_by_user_id) desc nulls last,(ab.user_id=p_preferred_user_id) desc nulls last,ab.period_end,ab.id loop
        v_take:=least(v_left,b.funded_us-b.reserved_us-b.debited_us); v_order:=v_order+1;
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
        'availableUs',coalesce(sum(case when payment_fenced then 0 else greatest(0,funded_us-reserved_us-debited_us) end),0)::text) into v_balance
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
        select coalesce(sum(greatest(0,bucket.funded_us-bucket.reserved_us-bucket.debited_us)),0) into v_available
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

-- Extend the explicit bridge after165, retaining command-recovery methods.
do $$ declare definition text; anchor text; begin
 definition:=pg_get_functiondef('public.qorpera_computer_billing_rpc(text,jsonb,text)'::regprocedure);
 anchor:='    v_allowed:=case p_method';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Funding bridge allowlist differs'; end if;
 definition:=replace(definition,anchor,anchor||E'\n        when ''qorpera_apply_computer_invoice_funding'' then array[''p_event_id'',''p_lease_token'',''p_snapshot'',''p_complete'']');
 anchor:='    case p_method';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Funding bridge dispatch differs'; end if;
 execute replace(definition,anchor,anchor||E'\n    when ''qorpera_apply_computer_invoice_funding'' then perform public.qorpera_apply_computer_invoice_funding(p_args->>''p_event_id'',(p_args->>''p_lease_token'')::uuid,p_args->''p_snapshot'',(p_args->>''p_complete'')::boolean);');
end $$;
