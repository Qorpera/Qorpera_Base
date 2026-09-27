-- A parked shared host outlives its run's company-capacity reservation. Keep
-- physical custody separately until the root supervisor confirms termination.
-- There is no TTL: an elapsed warm window is not evidence that systemd stopped.
create table public.qorpera_shared_host_custody (
    allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete cascade,
    profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
    identity jsonb not null check(jsonb_typeof(identity)='object'),
    created_at timestamptz not null default clock_timestamp(),
    closed_at timestamptz
);
create index qorpera_shared_host_custody_open on public.qorpera_shared_host_custody(profile_id) where closed_at is null;
alter table public.qorpera_shared_host_custody enable row level security;
revoke all on public.qorpera_shared_host_custody from public,anon,authenticated,service_role,qorpera_secret_broker;

-- Existing trusted profile/allocation deletion may collect terminal records,
-- but even a cascading delete cannot erase unresolved physical custody.
create function public.qorpera_guard_shared_host_custody_delete()
returns trigger language plpgsql security definer set search_path='' as $$
begin
    if old.closed_at is null then raise exception 'Stop and reconcile shared hosts before deletion' using errcode='55000'; end if;
    return old;
end $$;
revoke all on function public.qorpera_guard_shared_host_custody_delete() from public,anon,authenticated,service_role,qorpera_secret_broker;
create trigger qorpera_shared_host_custody_delete before delete on public.qorpera_shared_host_custody
for each row execute function public.qorpera_guard_shared_host_custody_delete();

create function public.qorpera_change_shared_host_custody(p_identity jsonb,p_close_secret text,p_close boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.qorpera_runtime_machine_allocations%rowtype;
    c public.qorpera_shared_host_custody%rowtype; v_profile uuid; v_keys text[];
begin
    if auth.role() is distinct from 'service_role' or p_close is null or p_identity is null
        or jsonb_typeof(p_identity)<>'object' or octet_length(p_identity::text)>2000 then
        raise exception 'Shared host supervisor authority required' using errcode='42501'; end if;
    select array_agg(key order by key) into v_keys from jsonb_object_keys(p_identity) key;
    if v_keys is distinct from array['allocationId','closeSecretSha256','hostSha256','instanceSha256','providerAdapter','workSha256']::text[]
        or exists(select 1 from jsonb_each(p_identity) field where jsonb_typeof(field.value)<>'string')
        or coalesce(p_identity->>'allocationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(p_identity->>'providerAdapter','') !~ '^[a-z][a-z0-9_-]{0,63}$'
        or coalesce(p_identity->>'instanceSha256','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_identity->>'hostSha256','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_identity->>'workSha256','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_identity->>'closeSecretSha256','') !~ '^[0-9a-f]{64}$' then
        raise exception 'Shared host custody identity differs' using errcode='42501'; end if;
    -- The allocation was reserved before native-host launch. Its immutable
    -- instance commits the physical identity and root-only closer capability;
    -- service credentials cannot replace either with a caller-chosen identity.
    if encode(extensions.digest(convert_to(concat_ws(E'\n','qorpera.shared-host/v1',p_identity->>'providerAdapter',
        p_identity->>'hostSha256',p_identity->>'closeSecretSha256',p_identity->>'workSha256'),'UTF8'),'sha256'),'hex')
        is distinct from p_identity->>'instanceSha256' then
        raise exception 'Shared host allocation commitment differs' using errcode='42501'; end if;
    -- Service-role credentials also exist inside the native host. They cannot
    -- close its fence: the independent random preimage stays in root custody.
    if p_close and (coalesce(p_close_secret,'') !~ '^[A-Za-z0-9_-]{43}$'
        or encode(extensions.digest(convert_to(p_close_secret,'UTF8'),'sha256'),'hex') is distinct from p_identity->>'closeSecretSha256') then
        raise exception 'Shared host closure authority differs' using errcode='42501'; end if;
    select profile_id into v_profile from public.qorpera_runtime_machine_allocations where id=(p_identity->>'allocationId')::uuid;
    if not found then raise exception 'Shared host allocation unavailable' using errcode='42501'; end if;
    -- Same profile -> allocation order as release and mode changes. Advance the
    -- persistent fence on mutation so an older repeatable-read snapshot fails.
    perform public.qorpera_lock_profile_gc_fence(v_profile);
    select * into strict a from public.qorpera_runtime_machine_allocations where id=(p_identity->>'allocationId')::uuid for update;
    if a.provider_adapter is distinct from p_identity->>'providerAdapter' or a.instance_sha256 is distinct from p_identity->>'instanceSha256'
        or a.run_id is null or a.runner_id is null or a.office_id is not null then
        raise exception 'Shared host allocation differs' using errcode='42501'; end if;
    select * into c from public.qorpera_shared_host_custody where allocation_id=a.id for update;
    if found then
        if c.profile_id<>v_profile or c.identity<>p_identity then
            raise exception 'Shared host custody replay differs' using errcode='23505'; end if;
        if p_close and c.closed_at is null then
            update public.qorpera_shared_host_custody set closed_at=clock_timestamp() where allocation_id=a.id returning * into c;
            update public.qorpera_company_wake_admission_fences set revision=revision+1 where profile_id=v_profile;
        end if;
    else
        if not p_close and (a.released_at is not null or public.qorpera_company_paid_computer_mode(v_profile)) then
            raise exception 'Shared host parking is not admitted' using errcode='55000'; end if;
        -- A close preceding an uncertain registration installs a tombstone;
        -- a late open can never revive it or authorize another parked host.
        insert into public.qorpera_shared_host_custody(allocation_id,profile_id,identity,closed_at)
        values(a.id,v_profile,p_identity,case when p_close then clock_timestamp() else null end) returning * into c;
        update public.qorpera_company_wake_admission_fences set revision=revision+1 where profile_id=v_profile;
    end if;
    return jsonb_build_object('state',case when c.closed_at is null then 'open' else 'closed' end,'identity',c.identity);
end $$;

create function public.qorpera_open_shared_host_custody(p_identity jsonb)
returns jsonb language sql security definer set search_path='' as $$
    select public.qorpera_change_shared_host_custody(p_identity,null,false)
$$;
create function public.qorpera_close_shared_host_custody(p_identity jsonb,p_close_secret text)
returns jsonb language sql security definer set search_path='' as $$
    select public.qorpera_change_shared_host_custody(p_identity,p_close_secret,true)
$$;
revoke all on function public.qorpera_change_shared_host_custody(jsonb,text,boolean),
    public.qorpera_open_shared_host_custody(jsonb),public.qorpera_close_shared_host_custody(jsonb,text)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_open_shared_host_custody(jsonb),public.qorpera_close_shared_host_custody(jsonb,text) to service_role;

do $$ declare definition text:=pg_get_functiondef('public.qorpera_guard_company_computer_billing_mode()'::regprocedure);
    old_gate text:='if v_previous is distinct from v_next then';
    old_permits text:='or exists(select 1 from public.qorpera_coding_computer_permits permit';
begin
    if (length(definition)-length(replace(definition,old_gate,'')))/length(old_gate)<>1
        or (length(definition)-length(replace(definition,old_permits,'')))/length(old_permits)<>1 then
        raise exception 'Shared host billing mode integration differs'; end if;
    definition:=replace(definition,old_gate,old_gate||E'\n        update public.qorpera_company_wake_admission_fences set revision=revision+1 where profile_id=v_profile;');
    definition:=replace(definition,old_permits,
        'or exists(select 1 from public.qorpera_shared_host_custody custody where custody.profile_id=v_profile and custody.closed_at is null) '||old_permits);
    execute definition;
end $$;
