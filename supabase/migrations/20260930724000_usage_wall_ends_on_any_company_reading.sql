-- A fresh usage reading of a ChatGPT login ends its usage wall in every company of that login (found live 11 Nov 2026).
--
-- A member's login is one ChatGPT account, used in all the member's companies, and its usage is the account's, wherever
-- it is read. On 11 Nov 2026 the account's weekly limit was reset early. At 15:25Z the login read 0 % used in two of its
-- six companies, yet stayed walled until 17 Nov 08:29Z, so a waiting chat turn never went on and Settings showed
-- "Usage limit reached · resets in 5d 17h" over a full bar. Two rules held it:
-- 1. A later reading with room ended a wall only when it was taken in the wall's own company. One company had a usage
--    signal from 4 Nov (on a since-revoked connection of the same account) and no reading since 13:37Z, so its wall held,
--    and a login's wall is the latest of its companies' walls.
-- 2. A signal with no reset of its own holds (for 8 days) to the reset a full window names in any reading of the login
--    (20260930577000), however old that reading is and whatever newer readings say. The 13:37Z and 14:35Z readings, full
--    to 17 Nov, kept that 4 Nov signal alive after the 15:25Z readings showed room.
-- Now:
-- 1. A later reading with room ends a wall when it is a reading of the same account by the same member on a live login,
--    in any company (before: in the wall's company only), and no newer reading of the account in that set is full (a
--    reading at the same time with room wins; a full window whose reset has passed is full no more). The other rules of a reading with room stay as they were.
-- 2. A full window holds a signal only while no newer reading of the login, on a live login, shows room.
-- Nothing else changes: the signals that can hold a connection, the 6 hours, the 8 days, siblings, the ACLs.
-- The bodies keep the markers 20260930577000 and 20260930611000 that the activation guards look for.
-- Undo: restore the two functions' text from 20260930611000.

set local lock_timeout = '3s';

do $$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930611000') = 0 then
		raise exception '20260930724000 needs 20260930611000'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930724000') > 0 then
		raise exception '20260930724000 is already applied'; end if;
end $$;

-- The latest reset still ahead of a full window in a usage reading of this login that no newer reading with room has
-- overtaken.
create or replace function public.qorpera_native_account_wall_reading_reset(p_connection_id uuid)
returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v_reset timestamptz;
begin
	-- 20260930577000; 20260930611000: PL/pgSQL, so the session keeps the plan; 20260930724000: a newer reading with room
	-- on a live login of the login overtakes a full window.
	with login as materialized (
		select current_version.connection_id, current_version.version as connection_version
		from (select v.connection_id, v.version from public.qorpera_provider_connection_versions as v
			where v.connection_id = p_connection_id order by v.version desc limit 1) as current_version
		union all
		select sibling.connection_id, sibling.connection_version
		from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling
	), reading as materialized (
		select m.provider_account_usage as usage, login.connection_id, login.connection_version
		from login
		join public.qorpera_native_provider_account_metadata as m on m.connection_id = login.connection_id
			and m.connection_version = login.connection_version
	), room as (
		-- The newest reading with room, by the rule a wall's own room check uses.
		select max((reading.usage ->> 'observedAt')::timestamptz) as observed_at
		from reading
		join public.qorpera_provider_connections as room_connection on room_connection.id = reading.connection_id
		join public.qorpera_provider_connection_versions as room_version on room_version.connection_id = reading.connection_id
			and room_version.version = reading.connection_version
		where room_connection.status = 'active' and room_version.authorization_state = 'active'
			and room_version.authentication_mode = 'native_subscription'
			and jsonb_typeof(reading.usage -> 'observedAt') = 'string'
			and (reading.usage ->> 'observedAt')::timestamptz <= statement_timestamp()
			and jsonb_typeof(reading.usage -> 'windows') = 'array'
			and jsonb_array_length(reading.usage -> 'windows') > 0
			and not exists (select 1 from jsonb_array_elements(reading.usage -> 'windows') as w
				where (w ->> 'usedPercent')::numeric is null or (w ->> 'usedPercent')::numeric < 0
					or (w ->> 'usedPercent')::numeric >= 100
					or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz
						<= (reading.usage ->> 'observedAt')::timestamptz))
	)
	select max((w.value ->> 'resetAt')::timestamptz) into v_reset
	from reading
	cross join room
	cross join lateral jsonb_array_elements(case when jsonb_typeof(reading.usage -> 'windows') = 'array'
		then reading.usage -> 'windows' else '[]'::jsonb end) as w
	where jsonb_typeof(w.value -> 'usedPercent') = 'number' and (w.value ->> 'usedPercent')::numeric >= 100
		and jsonb_typeof(w.value -> 'resetAt') = 'string'
		and (w.value ->> 'resetAt')::timestamptz > clock_timestamp()
		and (w.value ->> 'resetAt')::timestamptz < clock_timestamp() + interval '90 days'
		-- A full window with no time of its own is kept, as before.
		and (room.observed_at is null or jsonb_typeof(reading.usage -> 'observedAt') is distinct from 'string'
			or (reading.usage ->> 'observedAt')::timestamptz > room.observed_at);
	return v_reset;
end $$;

-- One connection's wall. The rules are 20260930575000's and 20260930577000's, with 20260930724000's change:
-- * a usage-limit signal holds this connection if it is on the connection's current version, or on a login of the same
--   provider account of the same member in the same company at the version that reading names;
-- * it holds until its reset, or, naming none, until 6 hours after it or (for 8 days) the reset a usage reading names;
-- * a later reading of that account by the same member, in any company, on a live login, showing room in every window,
--   ends it at once, unless a newer such reading of the account is full.
create or replace function public.qorpera_native_account_usage_limit_reset_company(p_connection_id uuid)
returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v_reset timestamptz;
begin
	-- 20260930575000; 20260930577000; 20260930611000: from the signals that can hold it, not from all of them;
	-- 20260930724000: a reading with room ends it from any company of the member.
	with login as (
		select connection.profile_id, connection.owner_user_id, connection.provider, current_version.version
		from public.qorpera_provider_connections as connection
		cross join lateral (select v.version from public.qorpera_provider_connection_versions as v
			where v.connection_id = connection.id order by v.version desc limit 1) as current_version
		where connection.id = p_connection_id
	), signal as materialized (
		select blocked.provider_connection_id, blocked.provider_connection_version, blocked.observed_at,
			coalesce(blocked.resets_at, greatest(blocked.observed_at + interval '6 hours',
				/* 20260930577000: else the reset a usage reading of this login names; an init plan, run at most once */
				case when blocked.observed_at > statement_timestamp() - interval '8 days'
					then (select public.qorpera_native_account_wall_reading_reset(p_connection_id)) end)) as held_until
		from (
			select own_signal.provider_connection_id, own_signal.provider_connection_version, own_signal.observed_at,
				own_signal.resets_at
			from login
			join public.qorpera_provider_connection_usage_signals as own_signal
				on own_signal.provider_connection_id = p_connection_id
				and own_signal.provider_connection_version = login.version
			where own_signal.signal_kind = 'usage_limit'
			union all
			select other_signal.provider_connection_id, other_signal.provider_connection_version, other_signal.observed_at,
				other_signal.resets_at
			from login
			join public.qorpera_native_provider_account_metadata as own
				on own.connection_id = p_connection_id and own.connection_version = login.version
			join public.qorpera_native_provider_account_metadata as other
				on other.provider_account_identity = own.provider_account_identity
			join public.qorpera_provider_connections as other_connection on other_connection.id = other.connection_id
				and other_connection.profile_id = login.profile_id
				and other_connection.owner_user_id is not distinct from login.owner_user_id
				and other_connection.provider = login.provider
			join public.qorpera_provider_connection_usage_signals as other_signal
				on other_signal.provider_connection_id = other.connection_id
				and other_signal.provider_connection_version = other.connection_version
			where other_signal.signal_kind = 'usage_limit'
		) as blocked
	), blocked_login as materialized (
		select distinct signal.provider_connection_id, signal.provider_connection_version
		from signal where signal.held_until > statement_timestamp()
	), room as materialized (
		-- 20260930575000: the newest reading with room, with or without a reset time, however old the reading;
		-- 20260930724000: in any company of the member, as the account's usage is the same in all of them, and only while
		-- no newer reading of the account is full (a reading at the same time with room wins).
		select blocked_login.provider_connection_id, blocked_login.provider_connection_version,
			case when seen.full_at is null or seen.room_at >= seen.full_at then seen.room_at end as observed_at
		from blocked_login cross join login
		cross join lateral (
			select max(reading.observed_at) filter (where reading.has_room) as room_at,
				max(reading.observed_at) filter (where reading.is_full) as full_at
			from (
				select (recovered.provider_account_usage ->> 'observedAt')::timestamptz as observed_at,
					case when jsonb_typeof(recovered.provider_account_usage -> 'windows') = 'array'
						then jsonb_array_length(recovered.provider_account_usage -> 'windows') > 0
							and not exists (select 1 from jsonb_array_elements(recovered.provider_account_usage -> 'windows') as w
								where (w ->> 'usedPercent')::numeric is null or (w ->> 'usedPercent')::numeric < 0
									or (w ->> 'usedPercent')::numeric >= 100
									or (w ? 'resetAt' and (w ->> 'resetAt')::timestamptz
										<= (recovered.provider_account_usage ->> 'observedAt')::timestamptz))
						else false end as has_room,
					case when jsonb_typeof(recovered.provider_account_usage -> 'windows') = 'array'
						then exists (select 1 from jsonb_array_elements(recovered.provider_account_usage -> 'windows') as w
							where jsonb_typeof(w -> 'usedPercent') = 'number' and (w ->> 'usedPercent')::numeric >= 100
								-- a window that had reset when read, or has reset since, is full no more
								and not (w ? 'resetAt' and ((w ->> 'resetAt')::timestamptz
									<= (recovered.provider_account_usage ->> 'observedAt')::timestamptz
									or (w ->> 'resetAt')::timestamptz <= statement_timestamp())))
						else false end as is_full
				from public.qorpera_native_provider_account_metadata as recovered
				join public.qorpera_provider_connections as recovered_connection
					on recovered_connection.id = recovered.connection_id
				join public.qorpera_provider_connection_versions as recovered_version
					on recovered_version.connection_id = recovered.connection_id
					and recovered_version.version = recovered.connection_version
				left join public.qorpera_native_provider_account_metadata as blocked_metadata
					on blocked_metadata.connection_id = blocked_login.provider_connection_id
					and blocked_metadata.connection_version = blocked_login.provider_connection_version
				where recovered_connection.owner_user_id is not distinct from login.owner_user_id
					and recovered_connection.provider = login.provider
					and recovered_connection.status = 'active' and recovered_version.authorization_state = 'active'
					and recovered_version.authentication_mode = 'native_subscription'
					and not exists (select 1 from public.qorpera_provider_connection_versions as newer
						where newer.connection_id = recovered.connection_id and newer.version > recovered.connection_version)
					and ((recovered.connection_id = blocked_login.provider_connection_id
						and recovered.connection_version = blocked_login.provider_connection_version)
						or recovered.provider_account_identity = blocked_metadata.provider_account_identity)
					and (recovered.provider_account_usage ->> 'observedAt')::timestamptz <= statement_timestamp()
			) as reading
		) as seen
	)
	select max(signal.held_until) into v_reset
	from signal
	join room on room.provider_connection_id = signal.provider_connection_id
		and room.provider_connection_version = signal.provider_connection_version
	where signal.held_until > statement_timestamp()
		and (room.observed_at is null or room.observed_at <= signal.observed_at);
	return v_reset;
end $$;
