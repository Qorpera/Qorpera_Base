-- A member's conversation retains its own account across tabs and reloads.
-- This is selection metadata, never execution or credential authority.
create table public.qorpera_member_session_accounts (
    profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
    session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    connection_id uuid not null references public.qorpera_provider_connections(id),
    sponsor_binding_id uuid not null references public.qorpera_execution_sponsor_bindings(id),
    selected_at timestamptz not null default clock_timestamp(),
    primary key (profile_id, session_id, user_id)
);
alter table public.qorpera_member_session_accounts enable row level security;
revoke all on public.qorpera_member_session_accounts from public,anon,authenticated,service_role;

-- Shared candidate rules for attended selection and the first-run wake.
create function public.qorpera_eligible_member_accounts(p_profile_id uuid,p_user_id uuid)
returns table(connection_id uuid,binding_id uuid,sponsor_version bigint,compute_identity_id uuid,remaining numeric)
language sql stable security definer set search_path = '' as $$
    select connection.id,sponsor.binding_id,sponsor.version,identity.id,
        public.qorpera_native_account_remaining(connection.id,version.version)
    from public.qorpera_member_compute_identities identity
    join public.qorpera_native_credential_capsules capsule on capsule.compute_identity_id = identity.id
        and capsule.status = 'active' and capsule.ownership_kind = 'member' and capsule.owner_user_id = p_user_id
    join public.qorpera_provider_connection_versions version on version.credential_capsule_id = capsule.id
        and version.authentication_mode = 'native_subscription' and version.authorization_state = 'active'
        and not exists (select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = version.connection_id and newer.version > version.version)
    join public.qorpera_provider_connections connection on connection.id = version.connection_id
        and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id and connection.status = 'active'
    join lateral (
        select candidate.* from public.qorpera_execution_sponsor_versions candidate
        join public.qorpera_execution_sponsor_bindings binding on binding.id = candidate.binding_id
            and binding.profile_id = p_profile_id and binding.created_by_user_id = p_user_id and binding.status = 'active'
        where candidate.provider_connection_id = connection.id and candidate.provider_connection_version = version.version
            and candidate.sponsor_kind = 'member_connection'
            and not exists (select 1 from public.qorpera_execution_sponsor_versions newer
                where newer.binding_id = candidate.binding_id and newer.version > candidate.version)
        order by candidate.created_at desc,candidate.version desc limit 1
    ) sponsor on true
    where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
        and identity.owner_user_id = p_user_id and identity.status = 'active' and identity.recovery_pending_id is null
        and public.qorpera_provider_execution_enabled(connection.provider,'native_subscription',version.native_harness)
        and exists (select 1 from public.qorpera_profile_members member where member.profile_id = p_profile_id
            and member.user_id = p_user_id and member.role in ('owner','admin','contributor'))
        and public.qorpera_native_account_remaining(connection.id,version.version) <> 0
$$;
revoke all on function public.qorpera_eligible_member_accounts(uuid,uuid) from public,anon,authenticated,service_role;

create function public.qorpera_select_member_session_account(p_profile_id uuid,p_session_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_saved public.qorpera_member_session_accounts%rowtype; v_choice record;
    v_handed_off uuid;
begin
    if auth.role() is distinct from 'authenticated' or v_user is null
        or not public.qorpera_can_read_session(p_session_id) then
        raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    -- Serialize initial selection and replacement across this conversation's tabs.
    perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id for update;
    if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    select * into v_saved from public.qorpera_member_session_accounts
        where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
    select version.provider_connection_id into v_handed_off from public.qorpera_execution_sponsor_versions version
        where version.binding_id = v_saved.sponsor_binding_id order by version.version desc limit 1;
    select * into v_choice from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
        order by (candidate.connection_id = v_handed_off) desc nulls last,
            (candidate.connection_id = v_saved.connection_id) desc nulls last,
            candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1;
    if not found then return null; end if;
    insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
        values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
        on conflict(profile_id,session_id,user_id) do update set
            connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
            selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
    return v_choice.connection_id;
end $$;
revoke all on function public.qorpera_select_member_session_account(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_select_member_session_account(uuid,uuid) to authenticated;

-- First-run work has no previous conversation choice. Use the same eligible
-- member accounts and prefer the greatest known allowance; unknown sorts last.
create or replace function public.qorpera_member_first_run_sponsor(p_profile_id uuid,p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object('sponsorBindingId',candidate.binding_id,'sponsorVersion',candidate.sponsor_version,
        'computeIdentityId',candidate.compute_identity_id)
    from public.qorpera_eligible_member_accounts(p_profile_id,p_user_id) candidate
    order by candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1
$$;
