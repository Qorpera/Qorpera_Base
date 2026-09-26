-- Founding readiness is a shared-company capacity check, not a reservation or
-- permission to dispatch a computer. Paid permits still atomically reserve the
-- actual admitted machine shape before every physical start/renewal.
-- An operator must opt the company into paid enforcement first. Checkout and
-- global readiness stay disabled; complimentary shadow companies keep their
-- existing admission behavior.
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
            and bucket.period_start<=v_now and bucket.period_end>=v_now+v_initial_window;
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
revoke all on function public.qorpera_company_computer_usage_status(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_company_computer_usage_status(uuid) to authenticated,service_role;
