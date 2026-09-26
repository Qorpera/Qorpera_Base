-- Once operators have explicitly published paid runtime readiness and checkout,
-- new/open founding companies use the protected paid runtime automatically.
-- This persists enforcement, not a purchase or authorization to share funds.
-- Existing explicit modes and already launched/legacy companies are untouched.
create function public.qorpera_enroll_founding_paid_computers(p_profile_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
    if not exists(select 1 from public.qorpera_computer_billing_readiness
        where singleton and runtime_accounting_ready and checkout_enabled) then return; end if;
    perform public.qorpera_lock_profile_gc_fence(p_profile_id);
    if not exists(select 1 from public.qorpera_company_founding where profile_id=p_profile_id and phase='open') then return; end if;
    if exists(select 1 from public.qorpera_company_computer_billing_modes where profile_id=p_profile_id) then return; end if;
    -- The existing mode trigger checks that physical execution is quiet. A
    -- conflicting allocation must remain held, never silently become unmetered.
    insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
        values(p_profile_id,'paid') on conflict(profile_id) do nothing;
end $$;
revoke all on function public.qorpera_enroll_founding_paid_computers(uuid)
    from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_founding_paid_rollout_created()
returns trigger language plpgsql security definer set search_path='' as $$
begin
    perform public.qorpera_enroll_founding_paid_computers(new.profile_id);
    return new;
end $$;
revoke all on function public.qorpera_founding_paid_rollout_created()
    from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_founding_paid_rollout_created after insert on public.qorpera_company_founding
    for each row execute function public.qorpera_founding_paid_rollout_created();

-- A setup opened before rollout must become usable on ordinary client refresh;
-- requiring another creation or an operator's per-company SQL insert strands
-- already verified founders. Authorization runs before the private helper.
do $$ declare definition text; anchor text:=$old$    select * into strict v_p from public.qorpera_profiles where id = p_profile_id;$old$; begin
    definition:=pg_get_functiondef('public.qorpera_read_company_founding(uuid)'::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
        raise exception 'Founding paid rollout read anchor differs'; end if;
    execute replace(definition,anchor,E'    perform public.qorpera_enroll_founding_paid_computers(p_profile_id);\n'||anchor);
end $$;
alter function public.qorpera_read_company_founding(uuid) volatile;

comment on function public.qorpera_enroll_founding_paid_computers(uuid) is
    'Private rollout policy for open founding only. Both operator readiness flags required; no consent, purchase, checkout or physical dispatch authority is created.';
