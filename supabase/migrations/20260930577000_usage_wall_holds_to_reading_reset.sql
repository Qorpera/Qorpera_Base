-- A usage-limit wall with no reset of its own holds until the reset its login's usage reading names (5 Nov 2026).
--
-- Found live right after 20260930575000: the founder's account login reached its weekly limit at 10:52–11:01Z, before
-- 575000, so its signals name no reset and their wall ends 6 hours after the last one (17:01Z). The vault's daily check
-- read the login at 11:27Z: its window is full until 7 Nov 10:12Z. Once the 6 hours pass, that reading is more than 5
-- minutes old, so the login counts as having room (qorpera_native_account_remaining), the waiting work goes on, and each
-- of its runs fails at the limit again. The same happens after every first limit with no reading yet: the signal names no
-- reset, the daily check then reads one, and the 6-hour wall ignores it.
--
-- Now a signal with no reset of its own holds its wall until the latest reset still ahead of a full window in a usage
-- reading of the login (the current version's, and the same account login's links in the member's other companies;
-- qorpera_native_account_wall_reading_reset), when that is later than the 6 hours. The reading's age does not matter: a
-- full window with its reset still ahead is the evidence, and a later reading with room still ends the wall at once
-- (575000). The daily check reads a login at its limit again once its reading is a day old, so a wrong reading lasts a
-- day at most. The reset is worked out once per call, for the login asked about, and only signals of the last 8 days
-- look at it (a weekly window at most).

set local lock_timeout = '3s';

do $$
begin
	if to_regprocedure('public.qorpera_account_login_sibling_connections(uuid)') is null
		or to_regprocedure('public.qorpera_native_account_reading_reset(uuid,bigint)') is null then
		raise exception '20260930577000 needs 20260930575000'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930577000') > 0 then
		raise exception '20260930577000 is already applied'; end if;
end $$;

create function pg_temp.as577_patch(p_target regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception '20260930577000 anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80);
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The latest reset still ahead of a full window in a usage reading of this login, of any age.
create function public.qorpera_native_account_wall_reading_reset(p_connection_id uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
	-- 20260930577000
	select max((w.value ->> 'resetAt')::timestamptz)
	from (select current_version.connection_id, current_version.version as connection_version
		from (select v.connection_id, v.version from public.qorpera_provider_connection_versions as v
			where v.connection_id = p_connection_id order by v.version desc limit 1) as current_version
		union all
		select sibling.connection_id, sibling.connection_version
		from public.qorpera_account_login_sibling_connections(p_connection_id) as sibling) as login
	join public.qorpera_native_provider_account_metadata as m on m.connection_id = login.connection_id
		and m.connection_version = login.connection_version
	cross join lateral jsonb_array_elements(case when jsonb_typeof(m.provider_account_usage -> 'windows') = 'array'
		then m.provider_account_usage -> 'windows' else '[]'::jsonb end) as w
	where jsonb_typeof(w.value -> 'usedPercent') = 'number' and (w.value ->> 'usedPercent')::numeric >= 100
		and jsonb_typeof(w.value -> 'resetAt') = 'string'
		and (w.value ->> 'resetAt')::timestamptz > clock_timestamp()
		and (w.value ->> 'resetAt')::timestamptz < clock_timestamp() + interval '90 days'
$$;
revoke all on function public.qorpera_native_account_wall_reading_reset(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The scalar subquery names only the parameter, so it runs once per call (an init plan), not per signal row.
select pg_temp.as577_patch('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	$old$coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours')$old$,
	$new$coalesce(blocked.resets_at, greatest(blocked.observed_at + interval '6 hours',
      /* 20260930577000: else the reset a usage reading of this login names */
      case when blocked.observed_at > statement_timestamp() - interval '8 days'
        then (select public.qorpera_native_account_wall_reading_reset(p_connection_id)) end))$new$,
	2);

do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930577000') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_wall_reading_reset(uuid)'::regprocedure),
		'20260930577000') = 0 then
		raise exception '20260930577000 marker is missing'; end if;
end $guard$;
