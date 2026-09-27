-- Read-only provider metadata refresh has its own short-lived authority.
-- It never creates a login, a credential version, a model job or a sponsor.
create table public.qorpera_native_account_refresh_requests (
    id uuid primary key default extensions.gen_random_uuid(),
    profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
    client_request_id uuid not null,
    compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
    requested_by_user_id uuid not null references auth.users(id) on delete restrict,
    capability_sha256 text not null check(capability_sha256 ~ '^[0-9a-f]{64}$'),
    compute_recovery_epoch bigint not null,
    provider text not null default 'openai' check(provider='openai'),
    native_harness text not null default 'codex-cli' check(native_harness='codex-cli'),
    status text not null default 'pending' check(status in ('pending','completed','expired','cancelled')),
    created_at timestamptz not null default clock_timestamp(),
    expires_at timestamptz not null default clock_timestamp()+interval '5 minutes',
    completed_at timestamptz,
    unique(profile_id,requested_by_user_id,client_request_id),
    check(expires_at>created_at and expires_at<=created_at+interval '5 minutes')
);
create unique index qorpera_native_account_refresh_pending on public.qorpera_native_account_refresh_requests(compute_identity_id)
    where status='pending';
alter table public.qorpera_native_account_refresh_requests enable row level security;
revoke all on public.qorpera_native_account_refresh_requests from public,anon,authenticated,service_role;

create function public.qorpera_native_account_refresh_fresh(p_compute_identity_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
    with accounts as (
        select v.connection_id,v.version,m.provider_account_usage as usage
        from public.qorpera_native_credential_capsules capsule
        join public.qorpera_provider_connection_versions v on v.credential_capsule_id=capsule.id
        join public.qorpera_provider_connections c on c.id=v.connection_id
        left join public.qorpera_native_provider_account_metadata m on m.connection_id=c.id and m.connection_version=v.version
        where capsule.compute_identity_id=p_compute_identity_id and capsule.status='active'
          and c.status='active' and c.provider='openai' and v.native_harness='codex-cli'
          and v.authentication_mode='native_subscription' and v.authorization_state='active'
          and not exists(select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id=v.connection_id and newer.version>v.version)
    ) select exists(select 1 from accounts) and not exists(select 1 from accounts
        where usage is null or (usage->>'observedAt')::timestamptz<=statement_timestamp()-interval '60 seconds'
          or (usage->>'observedAt')::timestamptz>statement_timestamp()+interval '30 seconds'
          or exists(select 1 from jsonb_array_elements(usage->'windows') w
            where w ? 'resetAt' and (w->>'resetAt')::timestamptz<=statement_timestamp()))
$$;
revoke all on function public.qorpera_native_account_refresh_fresh(uuid) from public,anon,authenticated,service_role;

create function public.qorpera_native_account_refresh_json(p_request public.qorpera_native_account_refresh_requests)
returns jsonb language sql immutable set search_path='' as $$
    select jsonb_build_object('request_id',p_request.id,'profile_id',p_request.profile_id,
        'compute_identity_id',p_request.compute_identity_id,'requested_by_user_id',p_request.requested_by_user_id,
        'expires_at',p_request.expires_at,'status',p_request.status)
$$;
revoke all on function public.qorpera_native_account_refresh_json(public.qorpera_native_account_refresh_requests)
    from public,anon,authenticated,service_role;

create function public.qorpera_pin_account_refresh_recovery_epoch()
returns trigger language plpgsql security definer set search_path='' as $$
declare identity public.qorpera_member_compute_identities%rowtype;
begin
    if tg_op='UPDATE' and (new.profile_id,new.client_request_id,new.compute_identity_id,new.requested_by_user_id,
        new.capability_sha256,new.created_at,new.expires_at) is distinct from
        (old.profile_id,old.client_request_id,old.compute_identity_id,old.requested_by_user_id,
        old.capability_sha256,old.created_at,old.expires_at) then
        raise exception 'Account refresh identity is immutable' using errcode='42501'; end if;
    if tg_op='UPDATE' and new.compute_recovery_epoch<>old.compute_recovery_epoch
      and current_setting('qorpera.account_refresh_recovery_repin',true) is distinct from new.id::text then
        raise exception 'Account refresh generation is immutable' using errcode='42501'; end if;
    if new.status in ('cancelled','expired') then return new; end if;
    select * into identity from public.qorpera_member_compute_identities where id=new.compute_identity_id
        and profile_id=new.profile_id for share;
    if not found or identity.status<>'active' or identity.ownership_kind<>'member'
      or identity.owner_user_id is distinct from new.requested_by_user_id or identity.recovery_pending_id is not null
      or not exists(select 1 from public.qorpera_profile_members where profile_id=new.profile_id
        and user_id=new.requested_by_user_id and role in ('owner','admin','contributor'))
      or (tg_op='UPDATE' and new.compute_recovery_epoch<>identity.recovery_epoch) then
        raise exception 'Account refresh identity unavailable' using errcode='42501'; end if;
    if tg_op='INSERT' then new.compute_recovery_epoch:=identity.recovery_epoch; end if;
    return new;
end $$;

revoke all on function public.qorpera_pin_account_refresh_recovery_epoch() from public,anon,authenticated,service_role;
create trigger qorpera_pin_account_refresh_recovery_epoch before insert or update
    on public.qorpera_native_account_refresh_requests for each row execute function public.qorpera_pin_account_refresh_recovery_epoch();

create function public.qorpera_begin_native_account_refresh(p_profile_id uuid,p_client_request_id uuid,p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare identity public.qorpera_member_compute_identities%rowtype;
    request public.qorpera_native_account_refresh_requests%rowtype; fresh boolean; created timestamptz; cached_at timestamptz;
begin
    if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_profile_id is null
      or p_client_request_id is null or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$' then
        raise exception 'Account refresh requires member authority' using errcode='42501'; end if;
    select * into identity from public.qorpera_member_compute_identities where profile_id=p_profile_id
        and ownership_kind='member' and owner_user_id=auth.uid() and status='active' and recovery_pending_id is null for share;
    if not found or not exists(select 1 from public.qorpera_profile_members where profile_id=p_profile_id
      and user_id=auth.uid() and role in ('owner','admin','contributor'))
      or not public.qorpera_provider_execution_enabled('openai','native_subscription','codex-cli')
      or public.qorpera_company_execution_paused(p_profile_id) then
        raise exception 'Account refresh unavailable' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtextextended('qorpera.account_refresh:'||identity.id::text,0));
    select * into request from public.qorpera_native_account_refresh_requests
        where profile_id=p_profile_id and requested_by_user_id=auth.uid() and client_request_id=p_client_request_id;
    if found then
        if request.capability_sha256 is distinct from p_capability_sha256 or request.compute_identity_id<>identity.id then
            raise exception 'Account refresh request already bound' using errcode='23505'; end if;
        if request.expires_at<=clock_timestamp() or request.status not in ('pending','completed') then
            raise exception 'Account refresh expired' using errcode='55000'; end if;
        return public.qorpera_native_account_refresh_json(request);
    end if;
    if not exists(select 1 from public.qorpera_native_credential_capsules capsule
      join public.qorpera_provider_connection_versions v on v.credential_capsule_id=capsule.id
      join public.qorpera_provider_connections c on c.id=v.connection_id
      where capsule.compute_identity_id=identity.id and capsule.status='active' and c.status='active' and c.provider='openai'
        and v.authorization_state='active' and v.authentication_mode='native_subscription' and v.native_harness='codex-cli'
        and not exists(select 1 from public.qorpera_provider_connection_versions newer where newer.connection_id=c.id and newer.version>v.version)) then
        raise exception 'No account available to refresh' using errcode='55000'; end if;
    -- An unavailable provider does not disable healthy accounts or repeatedly
    -- boot machines. A recently completed bounded attempt is cached briefly;
    -- the observation's own timestamp still decides whether usage is known.
    fresh:=public.qorpera_native_account_refresh_fresh(identity.id);
    if not fresh then
        select max(previous.completed_at) into cached_at from public.qorpera_native_account_refresh_requests previous
        where previous.compute_identity_id=identity.id and previous.compute_recovery_epoch=identity.recovery_epoch
          and previous.status='completed' and previous.completed_at>clock_timestamp()-interval '45 seconds';
        fresh:=cached_at is not null;
    end if;
    update public.qorpera_native_account_refresh_requests set status='expired'
        where compute_identity_id=identity.id and status='pending' and expires_at<=clock_timestamp();
    if exists(select 1 from public.qorpera_native_account_refresh_requests where compute_identity_id=identity.id and status='pending') then
        raise exception 'Account refresh already in progress' using errcode='55000'; end if;
    created:=clock_timestamp();
    insert into public.qorpera_native_account_refresh_requests(profile_id,client_request_id,compute_identity_id,
        requested_by_user_id,capability_sha256,compute_recovery_epoch,status,created_at,expires_at,completed_at)
    values(p_profile_id,p_client_request_id,identity.id,auth.uid(),p_capability_sha256,identity.recovery_epoch,
        case when fresh then 'completed' else 'pending' end,created,created+interval '5 minutes',case when fresh then coalesce(cached_at,created) end)
    returning * into request;
    return public.qorpera_native_account_refresh_json(request);
end $$;

create function public.qorpera_describe_native_account_refresh_route(p_request_id uuid,p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare request public.qorpera_native_account_refresh_requests%rowtype;
begin
    if auth.role() is distinct from 'service_role' or p_request_id is null
      or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$' then
        raise exception 'Account refresh host required' using errcode='42501'; end if;
    select * into request from public.qorpera_native_account_refresh_requests
        where id=p_request_id and capability_sha256=p_capability_sha256 and expires_at>clock_timestamp()
          and status in ('pending','completed');
    if not found or not exists(select 1 from public.qorpera_member_compute_identities i
      join public.qorpera_profile_members member on member.profile_id=i.profile_id and member.user_id=request.requested_by_user_id
      where i.id=request.compute_identity_id and i.profile_id=request.profile_id and i.status='active'
        and i.ownership_kind='member' and i.owner_user_id=request.requested_by_user_id
        and member.role in ('owner','admin','contributor')) then
        raise exception 'Account refresh unavailable' using errcode='42501'; end if;
    return public.qorpera_native_account_refresh_json(request);
end $$;

-- Another tab can wait for the bounded attempt without receiving its raw
-- capability or taking ownership of its guest. It then admits its own receipt.
create function public.qorpera_get_native_account_refresh(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare request public.qorpera_native_account_refresh_requests%rowtype;
begin
    if auth.role() is distinct from 'authenticated' or auth.uid() is null
      or not exists(select 1 from public.qorpera_profile_members where profile_id=p_profile_id
        and user_id=auth.uid() and role in ('owner','admin','contributor')) then
        raise exception 'Account refresh requires member authority' using errcode='42501'; end if;
    select r.* into request from public.qorpera_native_account_refresh_requests r
        join public.qorpera_member_compute_identities i on i.id=r.compute_identity_id
        where r.profile_id=p_profile_id and r.requested_by_user_id=auth.uid()
          and i.status='active' and i.ownership_kind='member' and i.owner_user_id=auth.uid()
          and r.expires_at>statement_timestamp() and r.status in ('pending','completed')
        order by r.created_at desc,r.id limit 1;
    if not found then return null; end if;
    return public.qorpera_native_account_refresh_json(request);
end $$;

create function public.qorpera_complete_native_account_refresh(p_request_id uuid,p_capability_sha256 text,p_recovery_epoch bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare request public.qorpera_native_account_refresh_requests%rowtype;
begin
    perform public.qorpera_describe_native_account_refresh_route(p_request_id,p_capability_sha256);
    select * into strict request from public.qorpera_native_account_refresh_requests where id=p_request_id for update;
    if request.expires_at<=clock_timestamp() or request.status not in ('pending','completed')
      or request.compute_recovery_epoch is distinct from p_recovery_epoch then
        raise exception 'Account refresh authority expired' using errcode='42501'; end if;
    perform 1 from public.qorpera_member_compute_identities where id=request.compute_identity_id and status='active'
        and recovery_pending_id is null and recovery_epoch=p_recovery_epoch for share;
    if not found then raise exception 'Account refresh generation unavailable' using errcode='42501'; end if;
    -- The identity host calls this only after its scoped bounded metadata
    -- attempt settles. Completion is not a claim that every provider answered.
    update public.qorpera_native_account_refresh_requests set status='completed',completed_at=coalesce(completed_at,clock_timestamp())
        where id=p_request_id;
    return true;
end $$;
revoke all on function public.qorpera_begin_native_account_refresh(uuid,uuid,text),
    public.qorpera_get_native_account_refresh(uuid),public.qorpera_describe_native_account_refresh_route(uuid,text),
    public.qorpera_complete_native_account_refresh(uuid,text,bigint)
    from public,anon,authenticated,service_role;
grant execute on function public.qorpera_begin_native_account_refresh(uuid,uuid,text),public.qorpera_get_native_account_refresh(uuid) to authenticated;
grant execute on function public.qorpera_describe_native_account_refresh_route(uuid,text),
    public.qorpera_complete_native_account_refresh(uuid,text,bigint) to service_role;

-- The same identity disk cannot be attached to jobs, logins and refreshes at
-- once. Keep the existing occupied-identity index and profile/node fences.
alter table public.qorpera_runtime_machine_allocations
    add column account_refresh_request_id uuid unique references public.qorpera_native_account_refresh_requests(id) on delete restrict,
    drop constraint qorpera_runtime_machine_allocation_source,
    add constraint qorpera_runtime_machine_allocation_source check(
      (run_id is not null and runner_id is not null and office_id is null and computer_generation is null
        and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
      or (run_id is null and runner_id is null and office_id is not null and computer_generation is not null and computer_generation>0
        and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
      or (run_id is null and runner_id is null and office_id is null and computer_generation is null
        and num_nonnulls(login_session_id,account_refresh_request_id)=1 and login_compute_identity_id is not null));
create table public.qorpera_runtime_account_refresh_machine_requests (
    allocation_id uuid primary key,
    account_refresh_request_id uuid not null unique references public.qorpera_native_account_refresh_requests(id) on delete restrict,
    profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
    compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
    provider_adapter text not null check(provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
    instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$'),
    requested_at timestamptz not null default clock_timestamp(),last_checked_at timestamptz not null default clock_timestamp(),
    released_at timestamptz,
    last_refusal text check(last_refusal in ('COMPANY_PAUSED','MACHINE_CAPACITY_EXHAUSTED','COMPUTE_IDENTITY_OCCUPIED',
        'COMPUTE_IDENTITY_RELEASING','NODE_NOT_PREFERRED','NODE_IDENTITY_ELSEWHERE')),
    unique(provider_adapter,instance_sha256)
);
alter table public.qorpera_runtime_account_refresh_machine_requests enable row level security;
revoke all on public.qorpera_runtime_account_refresh_machine_requests from public,anon,authenticated,service_role;

-- Copy the currently deployed fenced lifecycle, including later amendments;
-- only the source table/identifier changes. Existing login RPCs stay intact.
do $$
declare source text; target text; definition text; signatures text[][]:=array[
    ['qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)','qorpera_reserve_runtime_account_refresh_machine'],
    ['qorpera_describe_runtime_login_machine(uuid,text,text)','qorpera_describe_runtime_account_refresh_machine'],
    ['qorpera_release_runtime_login_machine(uuid,text,text,uuid)','qorpera_release_runtime_account_refresh_machine'],
    ['qorpera_runtime_login_journal_orphaned(uuid,uuid)','qorpera_runtime_account_refresh_journal_orphaned'],
    ['qorpera_request_login_identity_recovery(uuid,uuid,uuid,text)','qorpera_request_account_refresh_identity_recovery'],
    ['qorpera_repin_login_recovery_epoch(uuid)','qorpera_repin_account_refresh_recovery_epoch'],
    ['qorpera_runtime_login_gateway_choose(text)','qorpera_runtime_account_refresh_gateway_choose']
]; pair text[];
begin
    foreach pair slice 1 in array signatures loop
        source:=pair[1]; target:=pair[2]; definition:=pg_get_functiondef(('public.'||source)::regprocedure);
        if strpos(definition,'public.qorpera_native_provider_login_sessions')=0 then
            raise exception 'Account refresh lifecycle source differs: %',source; end if;
        definition:=replace(definition,split_part(source,'(',1),target);
        definition:=replace(definition,'public.qorpera_native_provider_login_sessions','public.qorpera_native_account_refresh_requests');
        definition:=replace(definition,'public.qorpera_runtime_login_machine_requests','public.qorpera_runtime_account_refresh_machine_requests');
        definition:=replace(definition,'login_session_id','account_refresh_request_id');
        definition:=replace(definition,'p_login_id','p_request_id');
        definition:=replace(definition,'qorpera.login_recovery_repin','qorpera.account_refresh_recovery_repin');
        if target='qorpera_reserve_runtime_account_refresh_machine' then
            if strpos(definition,'if not found or not ((v_identity.ownership_kind')=0 then
                raise exception 'Refresh reservation membership fence differs'; end if;
            definition:=replace(definition,'if not found or not ((v_identity.ownership_kind',
                'if not found or v_role not in (''owner'',''admin'',''contributor'') or not ((v_identity.ownership_kind');
        elsif target='qorpera_describe_runtime_account_refresh_machine' then
            if strpos(definition,'and ((i.ownership_kind')=0 then raise exception 'Refresh description membership fence differs'; end if;
            definition:=replace(definition,'and ((i.ownership_kind','and m.role in (''owner'',''admin'',''contributor'') and ((i.ownership_kind');
        elsif target='qorpera_request_account_refresh_identity_recovery' then
            if strpos(definition,'v_user:=v_session.requested_by_user_id;')=0 then raise exception 'Refresh recovery requester differs'; end if;
            definition:=replace(definition,'v_user:=v_session.requested_by_user_id;',
                'v_user:=v_session.requested_by_user_id;
                if not exists(select 1 from public.qorpera_profile_members where profile_id=v_session.profile_id
                  and user_id=v_user and role in (''owner'',''admin'',''contributor'')) then
                    raise exception ''Refresh member unavailable'' using errcode=''42501''; end if;');
        end if;
        -- Journal wire IDs are opaque; preserve loginId in physical supervisor
        -- receipts to keep the already-fenced machine adapter contract exact.
        execute definition;
        execute 'revoke all on function public.'||target||substring(source from position('(' in source))||' from public,anon,authenticated,service_role';
        execute 'grant execute on function public.'||target||substring(source from position('(' in source))||' to service_role';
    end loop;
end $$;

-- Expired refreshes are real occupants until physical deletion is confirmed,
-- just like completed logins. Their replacements may wait for that cleanup.
create or replace function public.qorpera_login_identity_releasing(p_profile_id uuid,p_compute_identity_id uuid,p_allocation_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
    select not exists(select 1 from public.qorpera_runtime_machine_allocations a
        left join public.qorpera_runners r on r.id=a.runner_id
        left join public.qorpera_native_provider_login_sessions l on l.id=a.login_session_id
        left join public.qorpera_native_account_refresh_requests refresh on refresh.id=a.account_refresh_request_id
        where a.profile_id=p_profile_id and a.released_at is null and a.id<>p_allocation_id
          and (a.login_compute_identity_id=p_compute_identity_id or r.compute_identity_id=p_compute_identity_id)
          and not (a.login_compute_identity_id=p_compute_identity_id and
            ((l.id is not null and (l.status<>'pending' or l.expires_at<=clock_timestamp()))
              or (refresh.id is not null and (refresh.status<>'pending' or refresh.expires_at<=clock_timestamp())))))
$$;

do $$
declare definition text:=pg_get_functiondef('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure);
    source text:='v_allocation.login_session_id is null';
begin
    if strpos(definition,source)=0 then raise exception 'Node machine source fence differs'; end if;
    execute replace(definition,source,'(v_allocation.login_session_id is null and v_allocation.account_refresh_request_id is null)');
end $$;

-- A completed identity-host refresh establishes the same usable identity home
-- as a completed login. Merely reserving or booting a guest establishes none.
create function public.qorpera_runtime_identity_home_allocation(p_allocation public.qorpera_runtime_machine_allocations)
returns boolean language sql stable security definer set search_path='' as $$
    select exists(select 1 from public.qorpera_native_provider_login_sessions
        where id=p_allocation.login_session_id and status='completed')
      or exists(select 1 from public.qorpera_native_account_refresh_requests
        where id=p_allocation.account_refresh_request_id and status='completed')
$$;
revoke all on function public.qorpera_runtime_identity_home_allocation(public.qorpera_runtime_machine_allocations)
    from public,anon,authenticated,service_role;

do $$
declare definition text; source text; target regprocedure;
begin
    foreach target in array array[
        'public.qorpera_runtime_login_identity_homes(uuid)'::regprocedure,
        'public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)'::regprocedure
    ] loop
        definition:=pg_get_functiondef(target);
        source:='join public.qorpera_native_provider_login_sessions s on s.id=a.login_session_id and s.status=''completed''';
        if strpos(definition,source)=0 then raise exception 'Identity home source differs: %',target; end if;
        execute replace(definition,source,
            'join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(a)) identity_home on true');
    end loop;
    target:='public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure;
    definition:=pg_get_functiondef(target);
    source:='join public.qorpera_native_provider_login_sessions as login on login.id = home.login_session_id and login.status = ''completed''';
    if (length(definition)-length(replace(definition,source,'')))/length(source)<>2 then
        raise exception 'Claim identity home source differs'; end if;
    execute replace(definition,source,
        'join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(home)) identity_home on true');
end $$;
