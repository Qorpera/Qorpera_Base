-- Governed company execution currently has a Codex adapter. A connected
-- account for another harness must not be chosen for one of these runs.
do $$
declare definition text := pg_get_functiondef('public.qorpera_eligible_member_accounts(uuid,uuid)'::regprocedure);
    predicate text := 'and public.qorpera_provider_execution_enabled(connection.provider,''native_subscription'',version.native_harness)';
begin
    if strpos(definition,predicate) = 0 then raise exception 'Member account eligibility source differs'; end if;
    execute replace(definition,predicate,
        'and connection.provider = ''openai'' and version.native_harness = ''codex-cli''
        ' || predicate);
end $$;

-- A provider reset is authoritative. When no reset was supplied, the fallback
-- wall may be superseded by a newer, fresh positive observation from the same
-- current credential version or a verified duplicate of that provider account.
create or replace function public.qorpera_native_account_usage_limit_reset(p_connection_id uuid)
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
      and (blocked.resets_at is not null or not exists (
        select 1 from public.qorpera_native_provider_account_metadata recovered
        join public.qorpera_provider_connections recovered_connection on recovered_connection.id = recovered.connection_id
        join public.qorpera_provider_connection_versions recovered_version
          on recovered_version.connection_id = recovered.connection_id
          and recovered_version.version = recovered.connection_version
        left join public.qorpera_native_provider_account_metadata blocked_metadata
          on blocked_metadata.connection_id = blocked.provider_connection_id
          and blocked_metadata.connection_version = blocked.provider_connection_version
        where recovered_connection.profile_id = current_connection.profile_id
          and recovered_connection.owner_user_id is not distinct from current_connection.owner_user_id
          and recovered_connection.provider = current_connection.provider
          and recovered_connection.status = 'active' and recovered_version.authorization_state = 'active'
          and recovered_version.authentication_mode = 'native_subscription'
          and not exists (select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = recovered.connection_id and newer.version > recovered.connection_version)
          and ((recovered.connection_id = blocked.provider_connection_id
            and recovered.connection_version = blocked.provider_connection_version)
            or recovered.provider_account_identity = blocked_metadata.provider_account_identity)
          and (recovered.provider_account_usage ->> 'observedAt')::timestamptz > blocked.observed_at
          and (recovered.provider_account_usage ->> 'observedAt')::timestamptz > statement_timestamp() - interval '5 minutes'
          and (recovered.provider_account_usage ->> 'observedAt')::timestamptz <= statement_timestamp()
          and jsonb_array_length(recovered.provider_account_usage -> 'windows') > 0
          and not exists (select 1 from jsonb_array_elements(recovered.provider_account_usage -> 'windows') w
            where (w ->> 'usedPercent')::numeric is null or (w ->> 'usedPercent')::numeric < 0
              or (w ->> 'usedPercent')::numeric >= 100
              or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz <= statement_timestamp()))
      ))
$$;

-- Handoff must use the same reconciled wall as attended selection. Retain the
-- existing allowance ranking, capacity, authority and continuation fences.
do $$
declare definition text := pg_get_functiondef('public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure);
    predicate text := E'and not exists (select 1 from public.qorpera_provider_connection_usage_signals blocked\n\t\t\twhere blocked.provider_connection_id = connection.id and blocked.provider_connection_version = version.version\n            and blocked.signal_kind = ''usage_limit''\n\t\t\t\tand coalesce(blocked.resets_at, blocked.observed_at + interval ''6 hours'') > clock_timestamp())';
begin
    if strpos(definition,predicate) = 0
      or strpos(definition,'and public.qorpera_native_account_remaining(connection.id, version.version) <> 0') = 0 then
        raise exception 'Sponsor handoff allowance source differs'; end if;
    execute replace(definition,predicate,'');
end $$;
