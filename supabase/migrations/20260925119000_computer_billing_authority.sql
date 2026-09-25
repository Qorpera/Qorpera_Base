-- Runtime guests hold service-role credentials. Payment truth needs an
-- independently enrolled bridge credential; the service role alone is not proof.
create table public.qorpera_computer_billing_keys (
    id uuid primary key default extensions.gen_random_uuid(),
    key_sha256 text not null unique check(key_sha256 ~ '^[0-9a-f]{64}$'),
    label text not null check(length(label) between 1 and 200),
    created_at timestamptz not null default clock_timestamp(),
    revoked_at timestamptz
);
alter table public.qorpera_computer_billing_keys enable row level security;
revoke all on public.qorpera_computer_billing_keys from public,anon,authenticated,service_role,qorpera_secret_broker;

-- Reassert financial table isolation, including the unrelated secret broker.
do $$ declare t text; begin
    foreach t in array array['qorpera_computer_plan_versions','qorpera_computer_tariff_versions','qorpera_computer_billing_readiness',
        'qorpera_computer_subscriptions','qorpera_computer_subscription_events','qorpera_company_computer_pool_members',
        'qorpera_company_computer_entitlements','qorpera_computer_billing_customers','qorpera_computer_billing_syncs',
        'qorpera_computer_billing_inbox','qorpera_computer_billing_commands','qorpera_computer_allowance_buckets',
        'qorpera_computer_allowance_cursors','qorpera_computer_allowance_reservations','qorpera_computer_allowance_holds',
        'qorpera_computer_allowance_settlements','qorpera_computer_allowance_debits'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('revoke all on public.%I from public,anon,authenticated,service_role,qorpera_secret_broker',t);
    end loop;
end $$;

-- Keep these callable only from owner-controlled SECURITY DEFINER kernels.
-- No role reachable with a guest JWT can mint balances, replace customer
-- mappings, manipulate leases, or manufacture complimentary access.
revoke all on function
    public.qorpera_set_account_entitlement(uuid,text,text,text,text,text,text),
    public.qorpera_map_computer_billing_customer(uuid,text),
    public.qorpera_computer_billing_customer(uuid,text),
    public.qorpera_begin_computer_billing_command(uuid,text,uuid,jsonb),
    public.qorpera_finish_computer_billing_command(uuid,uuid,jsonb),
    public.qorpera_release_computer_billing_command(uuid,uuid),
    public.qorpera_begin_computer_billing_sync(text,text,timestamptz,text),
    public.qorpera_finish_computer_billing_sync(text,uuid,jsonb,jsonb),
    public.qorpera_release_computer_billing_sync(text,uuid),
    public.qorpera_reconcile_computer_subscription(text,timestamptz,jsonb),
    public.qorpera_fund_computer_invoice(jsonb),
    public.qorpera_grant_computer_entitlement(uuid,timestamptz,text,text),
    public.qorpera_revoke_computer_entitlement(text),
    public.qorpera_reserve_computer_allowance(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz),
    public.qorpera_settle_computer_allowance(uuid,bigint)
from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_computer_billing_rpc(p_method text,p_args jsonb,p_billing_secret text)
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
revoke all on function public.qorpera_computer_billing_rpc(text,jsonb,text) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_computer_billing_rpc(text,jsonb,text) to service_role;
