-- Display-only metadata is separate from immutable credential versions. Only
-- the current identity host may hydrate it; member reads stay owner-scoped.
create table public.qorpera_native_provider_account_metadata (
    connection_id uuid not null,
    connection_version bigint not null,
    provider_account_email text,
    provider_account_usage jsonb,
    provider_account_identity text check (provider_account_identity ~ '^[0-9a-f]{64}$'),
    checked_at timestamptz not null default clock_timestamp(),
    primary key (connection_id, connection_version),
    foreign key (connection_id, connection_version)
        references public.qorpera_provider_connection_versions(connection_id, version) on delete cascade
);
alter table public.qorpera_native_provider_account_metadata enable row level security;
revoke all on public.qorpera_native_provider_account_metadata from public, anon, authenticated, service_role;

create function public.qorpera_list_native_provider_account_refreshes(p_compute_identity_id uuid, p_recovery_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    if auth.role() is distinct from 'service_role' or not exists (
        select 1 from public.qorpera_member_compute_identities i where i.id = p_compute_identity_id
          and i.status = 'active' and i.recovery_pending_id is null and i.recovery_epoch = p_recovery_epoch
    ) then raise exception 'Account metadata identity unavailable' using errcode = '42501'; end if;
    return coalesce((select jsonb_agg(to_jsonb(candidate)) from (
        select c.id as connection_id, v.version as connection_version, capsule.id as credential_capsule_id,
            capsule.encrypted_capsule_reference, v.native_harness
        from public.qorpera_provider_connections c
        join lateral (select * from public.qorpera_provider_connection_versions latest
            where latest.connection_id = c.id order by latest.version desc limit 1) v on true
        join public.qorpera_native_credential_capsules capsule on capsule.id = v.credential_capsule_id
        left join public.qorpera_native_provider_account_metadata m on m.connection_id = c.id and m.connection_version = v.version
        where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
          and c.status = 'active' and v.authorization_state = 'active' and v.authentication_mode = 'native_subscription'
          and c.provider = 'openai' and v.native_harness = 'codex-cli'
          and (m.checked_at is null or m.checked_at < statement_timestamp() - interval '60 seconds')
        order by m.checked_at nulls first, c.id limit 20
    ) candidate), '[]'::jsonb);
end $$;

create function public.qorpera_record_native_provider_account_metadata(
    p_compute_identity_id uuid, p_recovery_epoch bigint,
    p_connection_id uuid, p_connection_version bigint, p_credential_capsule_id uuid,
    p_provider_account_email text, p_provider_account_usage jsonb, p_provider_account_identity text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_window jsonb; v_observed timestamptz;
begin
    if auth.role() is distinct from 'service_role' then
        raise exception 'Account metadata requires host authority' using errcode = '42501'; end if;
    perform 1 from public.qorpera_member_compute_identities i where i.id = p_compute_identity_id
      and i.status = 'active' and i.recovery_pending_id is null and i.recovery_epoch = p_recovery_epoch for share;
    if not found then raise exception 'Account metadata identity unavailable' using errcode = '42501'; end if;
    perform 1 from public.qorpera_provider_connections c
      join public.qorpera_provider_connection_versions v on v.connection_id = c.id and v.version = p_connection_version
      join public.qorpera_native_credential_capsules capsule on capsule.id = v.credential_capsule_id
      where c.id = p_connection_id and c.status = 'active' and v.authorization_state = 'active'
        and c.provider = 'openai' and v.native_harness = 'codex-cli' and v.authentication_mode = 'native_subscription'
        and capsule.id = p_credential_capsule_id and capsule.status = 'active'
        and capsule.compute_identity_id = p_compute_identity_id
        and not exists(select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = c.id and newer.version > v.version)
      for share of c, v, capsule;
    if not found then raise exception 'Account metadata connection unavailable' using errcode = '42501'; end if;
    if p_provider_account_email is not null and (
        char_length(p_provider_account_email) not between 3 and 254
        or p_provider_account_email <> btrim(p_provider_account_email)
        or p_provider_account_email !~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+\.[^[:space:]@[:cntrl:]]+$'
    ) then raise exception 'Account email invalid' using errcode = '22023'; end if;
    if p_provider_account_identity is not null and p_provider_account_identity !~ '^[0-9a-f]{64}$' then
        raise exception 'Account identity invalid' using errcode = '22023'; end if;
    if p_provider_account_usage is not null then
        if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
          or p_provider_account_usage - array['observedAt','windows'] <> '{}'::jsonb
          or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
          or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then
            raise exception 'Account usage invalid' using errcode = '22023'; end if;
        v_observed := (p_provider_account_usage ->> 'observedAt')::timestamptz;
        if v_observed not between clock_timestamp() - interval '5 minutes' and clock_timestamp() + interval '30 seconds'
          or jsonb_array_length(p_provider_account_usage -> 'windows') not between 1 and 2 then
            raise exception 'Account usage observation invalid' using errcode = '22023'; end if;
        for v_window in select value from jsonb_array_elements(p_provider_account_usage -> 'windows') loop
            if jsonb_typeof(v_window) <> 'object'
              or v_window - array['id','label','usedPercent','resetAt','windowSeconds'] <> '{}'::jsonb
              or coalesce(v_window ->> 'id','') not in ('primary','secondary')
              or jsonb_typeof(v_window -> 'label') is distinct from 'string'
              or char_length(v_window ->> 'label') not between 1 and 80
              or jsonb_typeof(v_window -> 'usedPercent') is distinct from 'number'
              or (v_window ->> 'usedPercent')::numeric not between 0 and 100
              or (v_window ? 'windowSeconds' and (jsonb_typeof(v_window -> 'windowSeconds') <> 'number'
                or (v_window ->> 'windowSeconds')::numeric not between 1 and 31536000)) then
                raise exception 'Account usage window invalid' using errcode = '22023'; end if;
            if v_window ? 'resetAt' and (jsonb_typeof(v_window -> 'resetAt') <> 'string'
              or (v_window ->> 'resetAt')::timestamptz not between v_observed - interval '1 day' and v_observed + interval '366 days') then
                raise exception 'Account usage reset invalid' using errcode = '22023'; end if;
        end loop;
        if (select count(distinct value ->> 'id') from jsonb_array_elements(p_provider_account_usage -> 'windows'))
          <> jsonb_array_length(p_provider_account_usage -> 'windows') then
            raise exception 'Duplicate usage window' using errcode = '22023'; end if;
    end if;
    insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_email, provider_account_usage, provider_account_identity)
    values (p_connection_id, p_connection_version, p_provider_account_email, p_provider_account_usage, p_provider_account_identity)
    on conflict (connection_id, connection_version) do update set
      provider_account_identity = coalesce(excluded.provider_account_identity, qorpera_native_provider_account_metadata.provider_account_identity),
      provider_account_email = coalesce(excluded.provider_account_email, qorpera_native_provider_account_metadata.provider_account_email),
      provider_account_usage = case when excluded.provider_account_usage is not null
        and (qorpera_native_provider_account_metadata.provider_account_usage is null
          or (excluded.provider_account_usage ->> 'observedAt')::timestamptz >= (qorpera_native_provider_account_metadata.provider_account_usage ->> 'observedAt')::timestamptz)
        then excluded.provider_account_usage else qorpera_native_provider_account_metadata.provider_account_usage end,
      checked_at = clock_timestamp();
end $$;

revoke all on function public.qorpera_list_native_provider_account_refreshes(uuid,bigint) from public,anon,authenticated;
revoke all on function public.qorpera_record_native_provider_account_metadata(uuid,bigint,uuid,bigint,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.qorpera_list_native_provider_account_refreshes(uuid,bigint) to service_role;
grant execute on function public.qorpera_record_native_provider_account_metadata(uuid,bigint,uuid,bigint,uuid,text,jsonb,text) to service_role;

-- Two logins to the same provider account share its real allowance. Scope
-- identity matching to the same member/company; never use an email as a key.
create function public.qorpera_native_account_usage_limit_reset(p_connection_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
    select max(coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours'))
    from public.qorpera_provider_connection_usage_signals blocked
    join public.qorpera_provider_connections current_connection on current_connection.id = p_connection_id
    join lateral (select v.version from public.qorpera_provider_connection_versions v
        where v.connection_id = p_connection_id order by v.version desc limit 1) current_version on true
    where blocked.signal_kind = 'usage_limit'
      and coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours') > statement_timestamp()
      and ((blocked.provider_connection_id = p_connection_id
        and blocked.provider_connection_version = current_version.version) or exists (
        select 1 from public.qorpera_native_provider_account_metadata own
        join public.qorpera_native_provider_account_metadata other
          on other.provider_account_identity = own.provider_account_identity
        join public.qorpera_provider_connections other_connection on other_connection.id = other.connection_id
        where own.connection_id = p_connection_id and other.connection_id = blocked.provider_connection_id
          and own.connection_version = current_version.version
          and other.connection_version = blocked.provider_connection_version
          and other_connection.profile_id = current_connection.profile_id
          and other_connection.owner_user_id is not distinct from current_connection.owner_user_id
          and other_connection.provider = current_connection.provider
      ))
$$;
revoke all on function public.qorpera_native_account_usage_limit_reset(uuid) from public,anon,authenticated,service_role;

do $$
declare definition text := pg_get_functiondef('public.qorpera_list_member_native_execution_connections(uuid)'::regprocedure);
    old_email text := '''provider_account_email'', version.provider_account_email,';
    old_join text := 'join public.qorpera_native_credential_capsules as capsule';
begin
    if strpos(definition,old_email)=0 or strpos(definition,old_join)=0 then
        raise exception 'Account projection migration source differs'; end if;
    definition := replace(definition, old_email,
        '''provider_account_email'', coalesce(metadata.provider_account_email, version.provider_account_email),
                ''provider_account_usage'', metadata.provider_account_usage,
                ''usage_limit_reset_at'', public.qorpera_native_account_usage_limit_reset(connection.id),');
    definition := replace(definition,old_join,
        'left join public.qorpera_native_provider_account_metadata as metadata
                on metadata.connection_id = connection.id and metadata.connection_version = version.version
            join public.qorpera_native_credential_capsules as capsule');
    if strpos(definition, 'and sponsor_version.sponsor_kind = ''member_connection''') = 0 then
        raise exception 'Account sponsor projection differs'; end if;
    definition := replace(definition, 'and sponsor_version.sponsor_kind = ''member_connection''',
        'and sponsor_version.sponsor_kind = ''member_connection''
                    and not exists (select 1 from public.qorpera_execution_sponsor_versions newer_sponsor
                        where newer_sponsor.binding_id = sponsor_version.binding_id and newer_sponsor.version > sponsor_version.version)');
    execute definition;
end $$;

-- Rank by the tightest provider window. Unknown/stale observations rank below
-- known available accounts and are never treated as a full allowance.
create function public.qorpera_native_account_remaining(p_connection_id uuid, p_connection_version bigint)
returns numeric language sql stable security definer set search_path = '' as $$
    select case when public.qorpera_native_account_usage_limit_reset(p_connection_id) is not null then 0
      else coalesce((select min(100 - (w.value ->> 'usedPercent')::numeric)
        from public.qorpera_native_provider_account_metadata m,
          lateral jsonb_array_elements(m.provider_account_usage -> 'windows') w
        where m.connection_id = p_connection_id and m.connection_version = p_connection_version
          and (m.provider_account_usage ->> 'observedAt')::timestamptz > statement_timestamp() - interval '5 minutes'
          and (not (w.value ? 'resetAt') or (w.value ->> 'resetAt')::timestamptz > statement_timestamp())), -1) end
$$;
revoke all on function public.qorpera_native_account_remaining(uuid,bigint) from public,anon,authenticated,service_role;

-- Keep all existing authority, continuation and effect fences; only change the
-- replacement's ranking after an authoritative usage-limit signal.
do $$
declare definition text := pg_get_functiondef('public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure);
    ordering text := 'order by connection.created_at, connection.id limit 1;';
begin
    if strpos(definition, ordering) = 0 then raise exception 'Sponsor handoff ordering differs'; end if;
    if strpos(definition, 'where blocked.provider_connection_id = connection.id and blocked.signal_kind = ''usage_limit''') = 0 then
        raise exception 'Sponsor handoff usage predicate differs'; end if;
    definition := replace(definition,
        'where blocked.provider_connection_id = connection.id and blocked.signal_kind = ''usage_limit''',
        'where blocked.provider_connection_id = connection.id and blocked.provider_connection_version = version.version
            and blocked.signal_kind = ''usage_limit''');
    execute replace(definition, ordering,
        'and public.qorpera_native_account_remaining(connection.id, version.version) <> 0
    order by public.qorpera_native_account_remaining(connection.id, version.version) desc,
        connection.created_at, connection.id limit 1;');
end $$;
