-- Founding is a control-plane admission boundary, separate from bootstrap,
-- formation prose, model sponsorship and paid computer usage.
create table public.qorpera_company_founding (
    profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
    phase text not null default 'open' check (phase in ('open','launched','cancelled')),
    revision bigint not null default 1 check (revision > 0),
    description text not null default '' check (octet_length(description) <= 16384),
    created_by_user_id uuid not null references auth.users(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    launch_receipt jsonb check (launch_receipt is null or jsonb_typeof(launch_receipt) = 'object'),
    check ((phase = 'launched') = (launch_receipt is not null))
);
create table public.qorpera_company_founder_seats (
    profile_id uuid not null references public.qorpera_company_founding(profile_id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete restrict,
    invited_by_user_id uuid not null references auth.users(id) on delete restrict,
    state text not null check (state in ('invited','joined','declined')),
    role_description text not null default '' check (octet_length(role_description) <= 4096),
    ready_revision bigint check (ready_revision > 0),
    joined_at timestamptz,
    primary key (profile_id,user_id),
    check (ready_revision is null or state = 'joined')
);
alter table public.qorpera_company_founding enable row level security;
alter table public.qorpera_company_founder_seats enable row level security;
revoke all on public.qorpera_company_founding,public.qorpera_company_founder_seats
    from public,anon,authenticated,service_role;

-- Every public cloud-creation entry point uses the same founding boundary.
-- The low-level profile constructor is now an internal helper; otherwise a
-- caller could manufacture a "legacy" company and bypass paid usage/Ready.
revoke execute on function public.qorpera_create_hosted_profile(text,text,integer) from authenticated;
do $$ declare v text; old text := E'\t\tv_cofounder := public.qorpera_seed_company_cofounder((v_profile ->> ''profile_id'')::uuid,v_user_id);'; begin
    v := pg_get_functiondef('public.qorpera_create_cloud_company(uuid,text,integer)'::regprocedure);
    if (length(v)-length(replace(v,old,'')))/length(old) <> 1 then
        raise exception 'Canonical company founding anchor differs'; end if;
    execute replace(v,old,$new$        insert into public.qorpera_company_founding(profile_id,created_by_user_id)
            values((v_profile ->> 'profile_id')::uuid,v_user_id);
        insert into public.qorpera_company_founder_seats(profile_id,user_id,invited_by_user_id,state,joined_at)
            values((v_profile ->> 'profile_id')::uuid,v_user_id,v_user_id,'joined',clock_timestamp());
$new$ || old);
end $$;

-- Absence means a pre-existing company. It must never be put back into setup.
create function public.qorpera_company_founding_open(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists(select 1 from public.qorpera_company_founding
        where profile_id = p_profile_id and phase <> 'launched')
$$;
revoke all on function public.qorpera_company_founding_open(uuid) from public,anon,authenticated,service_role;

create function public.qorpera_founding_execution_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_phase text;
begin
    -- Serialize admission with launch/cancellation; login/provisioning machines
    -- are not execution runs and stay available during setup.
    select phase into v_phase from public.qorpera_company_founding
        where profile_id = new.profile_id for share;
    if v_phase is not null and v_phase <> 'launched' then
        raise exception 'Company founding has not launched' using errcode = '55000'; end if;
    return new;
end $$;
create trigger qorpera_founding_turn_gate before insert or update on public.qorpera_session_turn_requests
    for each row execute function public.qorpera_founding_execution_gate();
create trigger qorpera_founding_run_gate before insert or update on public.qorpera_execution_runs
    for each row execute function public.qorpera_founding_execution_gate();
create trigger qorpera_founding_wake_gate before insert or update on public.qorpera_wake_occurrences
    for each row execute function public.qorpera_founding_execution_gate();
revoke all on function public.qorpera_founding_execution_gate() from public,anon,authenticated,service_role;

create function public.qorpera_founding_profile_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.name is distinct from old.name or new.computer_usage_owner_user_id is distinct from old.computer_usage_owner_user_id then
        update public.qorpera_company_founding set revision = revision+1 where profile_id = new.id and phase = 'open';
    end if;
    return new;
end $$;
create trigger qorpera_founding_profile_revision after update of name,computer_usage_owner_user_id on public.qorpera_profiles
    for each row execute function public.qorpera_founding_profile_changed();

create function public.qorpera_founding_membership_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if exists(select 1 from public.qorpera_company_founding where profile_id = old.profile_id and phase = 'open')
        and exists(select 1 from public.qorpera_company_founder_seats where profile_id = old.profile_id
            and user_id = old.user_id and state = 'joined') then
        if old.user_id is distinct from auth.uid() then
            raise exception 'A joined founder must leave their own seat' using errcode = '42501'; end if;
        if tg_op = 'DELETE' then
            update public.qorpera_company_founder_seats set state = 'declined',ready_revision = null
                where profile_id = old.profile_id and user_id = old.user_id;
        else
            update public.qorpera_company_founder_seats set ready_revision = null
                where profile_id = old.profile_id and user_id = old.user_id;
        end if;
        update public.qorpera_company_founding set revision = revision+1 where profile_id = old.profile_id;
    end if;
    return old;
end $$;
create trigger qorpera_founding_member_left after delete on public.qorpera_profile_members
    for each row execute function public.qorpera_founding_membership_changed();
create trigger qorpera_founding_member_demoted after update of role on public.qorpera_profile_members
    for each row when (new.role is distinct from old.role and new.role = 'viewer')
    execute function public.qorpera_founding_membership_changed();

create function public.qorpera_founding_receipt_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if old.phase = 'launched' and new is distinct from old then
        if new.phase <> 'launched' or (to_jsonb(new)-'launch_receipt') is distinct from (to_jsonb(old)-'launch_receipt')
            or (new.launch_receipt-'turnRequestId') is distinct from (old.launch_receipt-'turnRequestId')
            or old.launch_receipt ->> 'turnRequestId' is not null or new.launch_receipt ->> 'turnRequestId' is null then
            raise exception 'Company launch receipt is immutable' using errcode = '42501'; end if;
    end if;
    return new;
end $$;
create trigger qorpera_founding_immutable before update on public.qorpera_company_founding
    for each row execute function public.qorpera_founding_receipt_immutable();
revoke all on function public.qorpera_founding_profile_changed(),public.qorpera_founding_membership_changed(),
    public.qorpera_founding_receipt_immutable() from public,anon,authenticated,service_role;

-- Bootstrap still seeds its one kickoff but does not release it before Start.
do $$ declare v text; old text := E'begin\n\tselect * into v_first'; begin
    v := pg_get_functiondef('public.qorpera_queue_agent_first_run(uuid,uuid,jsonb)'::regprocedure);
    if (length(v)-length(replace(v,old,'')))/length(old) <> 1 then
        raise exception 'First-run queue founding gate anchor differs'; end if;
    execute replace(v,old,E'begin\n\tif public.qorpera_company_founding_open(p_profile_id) then return null; end if;\n\tselect * into v_first');
end $$;

create function public.qorpera_begin_company_founding(
    p_client_creation_id uuid,p_company_name text,p_contract_version integer default 2
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_profile uuid; v_existing uuid;
begin
    if auth.uid() is null or not public.qorpera_current_email_verified() then
        raise exception 'A verified account is required' using errcode = '42501'; end if;
    -- The original creator/request identity remains the only company creator.
    select profile_id into v_existing from public.qorpera_company_creation_requests
        where created_by_user_id = auth.uid() and client_creation_id = p_client_creation_id;
    v_result := public.qorpera_create_cloud_company(p_client_creation_id,p_company_name,p_contract_version);
    v_profile := (v_result ->> 'profile_id')::uuid;
    if v_existing is not null and not exists(select 1 from public.qorpera_company_founding where profile_id = v_profile) then
        raise exception 'Existing company cannot re-enter founding' using errcode = '23505'; end if;
    insert into public.qorpera_company_founding(profile_id,created_by_user_id)
        values(v_profile,auth.uid()) on conflict(profile_id) do nothing;
    insert into public.qorpera_company_founder_seats(profile_id,user_id,invited_by_user_id,state,joined_at)
        values(v_profile,auth.uid(),auth.uid(),'joined',clock_timestamp()) on conflict do nothing;
    return v_result;
end $$;

create function public.qorpera_read_company_founding(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype; v_p public.qorpera_profiles%rowtype;
    v_env uuid; v_bootstrap text; v_seats jsonb; v_usage jsonb;
begin
    if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
        raise exception 'Company founding is unavailable' using errcode = '42501'; end if;
    select * into strict v_p from public.qorpera_profiles where id = p_profile_id;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id;
    select id into v_env from public.qorpera_company_environments where profile_id = p_profile_id order by created_at,id limit 1;
    select state into v_bootstrap from public.qorpera_company_bootstrap_jobs where profile_id = p_profile_id;
    select coalesce(jsonb_agg(jsonb_build_object('userId',seat.user_id,
        'displayName',left(coalesce(member.display_name,nullif(account.raw_user_meta_data ->> 'full_name',''),
            nullif(account.raw_user_meta_data ->> 'name',''),split_part(account.email,'@',1)),256),
        'email',account.email,'state',seat.state,'roleDescription',seat.role_description,
        'readyRevision',seat.ready_revision,'computerPoolEnabled',coalesce((select enabled
            from public.qorpera_company_computer_pool_members where profile_id = seat.profile_id and user_id = seat.user_id),false),
        'modelAccountReady',exists(select 1 from public.qorpera_eligible_member_accounts(p_profile_id,seat.user_id)))
        order by seat.joined_at nulls last,seat.user_id),'[]'::jsonb) into v_seats
        from public.qorpera_company_founder_seats seat join auth.users account on account.id = seat.user_id
        left join public.qorpera_profile_members member on member.profile_id = seat.profile_id and member.user_id = seat.user_id
        where seat.profile_id = p_profile_id;
    v_usage := public.qorpera_company_computer_usage_status(p_profile_id);
    return jsonb_build_object('schema','qorpera.company-founding/v1','profileId',p_profile_id,
        'environmentId',v_env,'companyName',v_p.name,'description',coalesce(v_f.description,''),
        'phase',coalesce(v_f.phase,'launched'),'revision',coalesce(v_f.revision,0),
        'bootstrapState',coalesce(v_bootstrap,'completed'),'computerUsageOwnerUserId',v_p.computer_usage_owner_user_id,
        'seats',v_seats,'computerUsage',v_usage,'launch',v_f.launch_receipt,
        'canManage',coalesce(public.qorpera_member_role(p_profile_id) = 'owner',false));
end $$;

create function public.qorpera_update_company_founding(
    p_profile_id uuid,p_expected_revision bigint,p_name text,p_description text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype;
begin
    perform 1 from public.qorpera_profiles where id = p_profile_id for update;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id for update;
    if auth.uid() is null or public.qorpera_member_role(p_profile_id) is distinct from 'owner' then
        raise exception 'Founding owner required' using errcode = '42501'; end if;
    if v_f.phase is distinct from 'open' or p_expected_revision is distinct from v_f.revision then
        raise exception 'Founding changed; refresh and try again' using errcode = 'PT412'; end if;
    if p_name is null or char_length(btrim(p_name)) not between 1 and 120
        or p_description is null or octet_length(p_description) > 16384 then
        raise exception 'Company details are invalid' using errcode = '22023'; end if;
    if v_f.description is distinct from p_description or
        (select name from public.qorpera_profiles where id = p_profile_id) is distinct from btrim(p_name) then
        update public.qorpera_profiles set name = btrim(p_name) where id = p_profile_id;
        update public.qorpera_company_founding set description = p_description,
            revision = revision + (description is distinct from p_description)::integer where profile_id = p_profile_id;
    end if;
    return public.qorpera_read_company_founding(p_profile_id);
end $$;

create function public.qorpera_invite_company_founder(p_profile_id uuid,p_expected_revision bigint,p_friend_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype;
begin
    perform 1 from public.qorpera_profiles where id = p_profile_id for update;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id for update;
    if auth.uid() is null or public.qorpera_member_role(p_profile_id) is distinct from 'owner' then
        raise exception 'Founding owner required' using errcode = '42501'; end if;
    if v_f.phase is distinct from 'open' or p_expected_revision is distinct from v_f.revision then
        raise exception 'Founding changed; refresh and try again' using errcode = 'PT412'; end if;
    if not exists(select 1 from public.qorpera_friendships where user_low = least(auth.uid(),p_friend_user_id)
        and user_high = greatest(auth.uid(),p_friend_user_id) and status = 'accepted') then
        raise exception 'Invite an accepted friend' using errcode = '42501'; end if;
    insert into public.qorpera_company_founder_seats(profile_id,user_id,invited_by_user_id,state)
        values(p_profile_id,p_friend_user_id,auth.uid(),'invited')
        on conflict(profile_id,user_id) do update set state = 'invited',invited_by_user_id = excluded.invited_by_user_id
        where qorpera_company_founder_seats.state = 'declined';
    -- Pending invitations do not alter the joined roster. Joining invalidates Ready.
    return public.qorpera_read_company_founding(p_profile_id);
end $$;

create function public.qorpera_list_company_founding_invitations()
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object('profileId',seat.profile_id,'companyName',profile.name,
        'invitedByDisplayName',inviter.display_name) order by founding.created_at,seat.profile_id),'[]'::jsonb)
    from public.qorpera_company_founder_seats seat
    join public.qorpera_company_founding founding on founding.profile_id = seat.profile_id and founding.phase = 'open'
    join public.qorpera_profiles profile on profile.id = seat.profile_id
    join public.qorpera_profile_members inviter on inviter.profile_id = seat.profile_id and inviter.user_id = seat.invited_by_user_id
    where seat.user_id = auth.uid() and seat.state = 'invited' and public.qorpera_current_email_verified()
$$;

create function public.qorpera_respond_company_founding(p_profile_id uuid,p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype; v_seat public.qorpera_company_founder_seats%rowtype;
    v_account auth.users%rowtype;
begin
    perform 1 from public.qorpera_profiles where id = p_profile_id for update;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id for update;
    if auth.uid() is null or not public.qorpera_current_email_verified() or p_accept is null then
        raise exception 'Verified founder account required' using errcode = '42501'; end if;
    select * into v_seat from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = auth.uid();
    if v_seat.state = 'joined' and p_accept then return public.qorpera_read_company_founding(p_profile_id); end if;
    if v_f.phase is distinct from 'open' or v_seat.state is distinct from 'invited' then
        raise exception 'Founding invitation is unavailable' using errcode = '42501'; end if;
    if not p_accept then
        update public.qorpera_company_founder_seats set state = 'declined' where profile_id = p_profile_id and user_id = auth.uid();
        return jsonb_build_object('state','declined','profileId',p_profile_id);
    end if;
    select * into strict v_account from auth.users where id = auth.uid();
    insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
        values(p_profile_id,auth.uid(),lower(v_account.email),left(coalesce(nullif(v_account.raw_user_meta_data ->> 'full_name',''),
            nullif(v_account.raw_user_meta_data ->> 'name',''),split_part(v_account.email,'@',1)),256),'contributor')
        on conflict(profile_id,user_id) do nothing;
    update public.qorpera_company_founder_seats set state = 'joined',joined_at = clock_timestamp(),ready_revision = null
        where profile_id = p_profile_id and user_id = auth.uid();
    update public.qorpera_company_founding set revision = revision+1 where profile_id = p_profile_id;
    return public.qorpera_read_company_founding(p_profile_id);
end $$;

create function public.qorpera_set_founder_ready(
    p_profile_id uuid,p_expected_revision bigint,p_ready boolean,p_role_description text default ''
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype;
begin
    perform 1 from public.qorpera_profiles where id = p_profile_id for update;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id for update;
    if auth.uid() is null or not public.qorpera_current_email_verified() or not public.qorpera_can_write_profile(p_profile_id) or not exists(
        select 1 from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = auth.uid() and state = 'joined') then
        raise exception 'Joined founder required' using errcode = '42501'; end if;
    if v_f.phase is distinct from 'open' or p_expected_revision is distinct from v_f.revision then
        raise exception 'Founding changed; refresh and try again' using errcode = 'PT412'; end if;
    if p_ready is null or p_role_description is null or octet_length(p_role_description) > 4096 then
        raise exception 'Founder readiness is invalid' using errcode = '22023'; end if;
    if p_ready and not exists(select 1 from public.qorpera_eligible_member_accounts(p_profile_id,auth.uid())) then
        raise exception 'Connect your own usable model account before getting ready' using errcode = '55000'; end if;
    update public.qorpera_company_founder_seats set ready_revision = case when p_ready then v_f.revision end,
        role_description = p_role_description where profile_id = p_profile_id and user_id = auth.uid();
    return public.qorpera_read_company_founding(p_profile_id);
end $$;

create function public.qorpera_remove_company_founder(p_profile_id uuid,p_expected_revision bigint,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype; v_state text;
begin
    perform 1 from public.qorpera_profiles where id = p_profile_id for update;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id for update;
    if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
        raise exception 'Founding access required' using errcode = '42501'; end if;
    if v_f.phase is distinct from 'open' or p_expected_revision is distinct from v_f.revision then
        raise exception 'Founding changed; refresh and try again' using errcode = 'PT412'; end if;
    select state into v_state from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = p_user_id;
    if p_user_id = v_f.created_by_user_id or v_state is null or
        (p_user_id is distinct from auth.uid() and (v_state = 'joined' or public.qorpera_member_role(p_profile_id) is distinct from 'owner')) then
        raise exception 'Only your own joined seat or an invitation can be removed' using errcode = '42501'; end if;
    delete from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = p_user_id;
    if v_state = 'joined' then
        perform public.qorpera_leave_hosted_profile(p_profile_id);
        update public.qorpera_company_founding set revision = revision+1 where profile_id = p_profile_id;
        return jsonb_build_object('state','left','profileId',p_profile_id);
    end if;
    return public.qorpera_read_company_founding(p_profile_id);
end $$;

create function public.qorpera_launch_company_founding(p_profile_id uuid,p_expected_revision bigint,p_client_launch_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_f public.qorpera_company_founding%rowtype; v_first public.qorpera_company_first_runs%rowtype;
    v_sponsor jsonb; v_request uuid; v_roster jsonb; v_receipt jsonb; v_input public.qorpera_session_inputs%rowtype;
begin
    -- Global lock order agrees with owner leave/reassignment.
    perform 1 from public.qorpera_profiles where id = p_profile_id for update;
    select * into v_f from public.qorpera_company_founding where profile_id = p_profile_id for update;
    if auth.uid() is null or not public.qorpera_current_email_verified() or not public.qorpera_can_write_profile(p_profile_id) or not exists(
        select 1 from public.qorpera_company_founder_seats where profile_id = p_profile_id and user_id = auth.uid() and state = 'joined') then
        raise exception 'Joined founder required' using errcode = '42501'; end if;
    if v_f.phase = 'launched' then return public.qorpera_read_company_founding(p_profile_id); end if;
    if v_f.phase is distinct from 'open' or p_expected_revision is distinct from v_f.revision or p_client_launch_id is null then
        raise exception 'Founding changed; refresh and try again' using errcode = 'PT412'; end if;
    if exists(select 1 from public.qorpera_company_founder_seats seat
        left join public.qorpera_profile_members member on member.profile_id = seat.profile_id and member.user_id = seat.user_id
        where seat.profile_id = p_profile_id and seat.state = 'joined'
            and (seat.ready_revision is distinct from v_f.revision or member.role is null or member.role = 'viewer')) then
        raise exception 'Every joined founder must be ready for this company revision' using errcode = '55000'; end if;
    if exists(select 1 from public.qorpera_company_founder_seats seat
        where seat.profile_id = p_profile_id and seat.state = 'joined' and not exists(
            select 1 from public.qorpera_eligible_member_accounts(p_profile_id,seat.user_id))) then
        raise exception 'Every joined founder needs their own usable model account' using errcode = '55000'; end if;
    if not exists(select 1 from public.qorpera_company_bootstrap_jobs where profile_id = p_profile_id and state = 'completed') then
        raise exception 'Company preparation is not complete' using errcode = '55000'; end if;
    if not coalesce((public.qorpera_company_computer_usage_status(p_profile_id) ->> 'canStart')::boolean,false) then
        raise exception 'Company computer usage is not available' using errcode = '55000'; end if;
    -- Only the launcher supplies the model account. Computer-pool contributors
    -- never become model sponsors by supplying paid computer capacity.
    v_sponsor := public.qorpera_member_first_run_sponsor(p_profile_id,auth.uid());
    if v_sponsor is null then raise exception 'Your model account is unavailable' using errcode = '55000'; end if;
    select * into strict v_first from public.qorpera_company_first_runs where profile_id = p_profile_id;
    select * into strict v_input from public.qorpera_session_inputs where id = v_first.input_id for update;
    if v_input.execution_run_id is not null or v_input.completed_at is not null or v_input.failed_at is not null then
        raise exception 'Company kickoff is already resolved' using errcode = '55000'; end if;
    select jsonb_agg(jsonb_build_object('userId',seat.user_id,'displayName',member.display_name,
        'roleDescription',seat.role_description) order by seat.user_id)
        into v_roster from public.qorpera_company_founder_seats seat
        join public.qorpera_profile_members member using(profile_id,user_id)
        where seat.profile_id = p_profile_id and seat.state = 'joined';
    v_receipt := jsonb_build_object('receiptId',extensions.gen_random_uuid(),'clientLaunchId',p_client_launch_id,
        'revision',v_f.revision,'launchedByUserId',auth.uid(),'launchedAt',clock_timestamp(),
        'roster',v_roster,'description',v_f.description,'companyName',(select name from public.qorpera_profiles where id = p_profile_id),
        'computerPoolMembers',coalesce((select jsonb_agg(user_id order by user_id)
            from public.qorpera_company_computer_pool_members where profile_id = p_profile_id and enabled),'[]'::jsonb),
        'computerUsageOwnerUserId',(select computer_usage_owner_user_id from public.qorpera_profiles where id = p_profile_id),
        'kickoffInputId',v_first.input_id,'turnRequestId',null);
    update public.qorpera_company_founding set phase = 'launched',launch_receipt = v_receipt where profile_id = p_profile_id;
    update public.qorpera_profile_members member set role = 'owner' where profile_id = p_profile_id and exists(
        select 1 from public.qorpera_company_founder_seats seat where seat.profile_id = member.profile_id
            and seat.user_id = member.user_id and seat.state = 'joined');
    -- Same canonical kickoff and queue shape as queue_agent_first_run, with
    -- explicit launch requester rather than rewriting historical input authors.
    insert into public.qorpera_session_turn_requests(profile_id,session_id,client_request_id,input_id,
        requested_by_user_id,sponsor_mode,sponsor_binding_id,sponsor_version,sponsored_by_user_id,compute_identity_id,
        worker_class,required_capability,job_type,publication_mode,status,sponsored_at,initial_execution_selection)
    values(p_profile_id,v_input.session_id,v_input.id,v_input.id,auth.uid(),'member_connection',
        (v_sponsor ->> 'sponsorBindingId')::uuid,(v_sponsor ->> 'sponsorVersion')::bigint,auth.uid(),
        (v_sponsor ->> 'computeIdentityId')::uuid,'managed_sandbox','agent_turn','agent_turn','automatic','queued',
        clock_timestamp(),jsonb_build_object('sponsor_binding_id',v_sponsor -> 'sponsorBindingId',
            'sponsor_version',v_sponsor -> 'sponsorVersion','compute_identity_id',v_sponsor -> 'computeIdentityId',
            'logical_computer_id',null,'worker_class','managed_sandbox','reason','company_founding')) returning id into v_request;
    update public.qorpera_company_founding set launch_receipt = launch_receipt || jsonb_build_object('turnRequestId',v_request)
        where profile_id = p_profile_id;
    return public.qorpera_read_company_founding(p_profile_id);
end $$;

revoke all on function public.qorpera_begin_company_founding(uuid,text,integer),
    public.qorpera_read_company_founding(uuid),public.qorpera_update_company_founding(uuid,bigint,text,text),
    public.qorpera_invite_company_founder(uuid,bigint,uuid),public.qorpera_list_company_founding_invitations(),
    public.qorpera_respond_company_founding(uuid,boolean),public.qorpera_set_founder_ready(uuid,bigint,boolean,text),
    public.qorpera_launch_company_founding(uuid,bigint,uuid),public.qorpera_remove_company_founder(uuid,bigint,uuid)
    from public,anon,authenticated,service_role;
grant execute on function public.qorpera_begin_company_founding(uuid,text,integer),
    public.qorpera_read_company_founding(uuid),public.qorpera_update_company_founding(uuid,bigint,text,text),
    public.qorpera_invite_company_founder(uuid,bigint,uuid),public.qorpera_list_company_founding_invitations(),
    public.qorpera_respond_company_founding(uuid,boolean),public.qorpera_set_founder_ready(uuid,bigint,boolean,text),
    public.qorpera_launch_company_founding(uuid,bigint,uuid),public.qorpera_remove_company_founder(uuid,bigint,uuid) to authenticated;
