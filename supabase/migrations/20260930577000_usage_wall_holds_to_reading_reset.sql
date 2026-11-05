-- A usage-limit wall with no reset of its own holds until the reset its login's usage reading names (5 Nov 2026).
--
-- Found live right after 20260930575000: the founder's account login reached its weekly limit at 10:52–11:01Z, before
-- 575000, so its signals name no reset and their wall ends 6 hours after the last one (17:01Z). The vault's daily check
-- read the login at 11:27Z: its window is full until 7 Nov 10:12Z. Once the 6 hours pass, that reading is more than 5
-- minutes old, so the login counts as having room (qorpera_native_account_remaining), the waiting work goes on, and each
-- of its runs fails at the limit again. The same happens after every first limit with no reading yet: the signal names no
-- reset, the daily check then reads one, and the 6-hour wall ignores it.
--
-- Now a signal with no reset of its own holds its wall until the latest reset of a full window in the login's newest
-- reading, when that is later than the 6 hours (qorpera_native_account_reading_reset: a reading of the last day, the
-- signal's version and the same account login's links). The daily check reads a login at its limit again once its reading
-- is a day old, so a long wall keeps its reading fresh. A later reading with room still ends the wall at once (575000).
-- Only signals of the last 8 days look at a reading (a weekly window at most), so old signals cost nothing.

set local lock_timeout = '3s';

do $$
begin
	if to_regprocedure('public.qorpera_native_account_reading_reset(uuid,bigint)') is null then
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

select pg_temp.as577_patch('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	$old$coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours')$old$,
	$new$coalesce(blocked.resets_at, greatest(blocked.observed_at + interval '6 hours',
      /* 20260930577000: else the reset its login's newest reading names */
      case when blocked.observed_at > statement_timestamp() - interval '8 days'
        then public.qorpera_native_account_reading_reset(blocked.provider_connection_id, blocked.provider_connection_version) end))$new$,
	2);

do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure),
		'20260930577000') = 0 then
		raise exception '20260930577000 marker is missing'; end if;
end $guard$;
