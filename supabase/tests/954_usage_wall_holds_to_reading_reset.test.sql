-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A usage-limit wall with no reset of its own holds until the reset its login's newest usage reading names
-- (20260930577000). Found live on 5 Nov 2026: a limit hit before any reading names no reset, the daily check then reads a
-- full window until days later, and the 6-hour wall used to end anyway, so the waiting work ran into the limit again.

create function pg_temp.p934_a() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
$$;
create function pg_temp.p934_reading(p_observed timestamptz, p_used numeric, p_reset timestamptz) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values (pg_temp.p934_a(), 2, jsonb_build_object('observedAt', p_observed, 'windows', jsonb_build_array(
		jsonb_strip_nulls(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char(p_reset at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;
create function pg_temp.p934_wall() returns timestamptz language sql as $$
	select public.qorpera_native_account_usage_limit_reset(pg_temp.p934_a())
$$;

-- 1. A reaches its usage limit with no reading yet: the signal names no reset, so the wall is the 6 hours.
delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.p934_a();
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.p934_signal', public.qorpera_record_provider_usage_signal(
	current_setting('qorpera_test.base_binding')::jsonb,'usage_limit')::text, true) \g /dev/null
reset role;
select pg_temp.base_assert(current_setting('qorpera_test.p934_signal')::jsonb ->> 'resetsAt' is null
	and abs(extract(epoch from pg_temp.p934_wall() - (statement_timestamp() + interval '6 hours'))) < 2,
	'the first wall is not the 6 hours: ' || current_setting('qorpera_test.p934_signal'));

-- 2. Seven hours later, with no reading, the wall has ended (as before).
update public.qorpera_provider_connection_usage_signals set observed_at = statement_timestamp() - interval '7 hours'
where provider_connection_id = pg_temp.p934_a() and signal_kind = 'usage_limit';
select pg_temp.base_assert(pg_temp.p934_wall() is null, 'the 6-hour wall did not end without a reading');

-- 3. The daily check read A an hour ago: its window is full for two more days. The wall holds until that reset, and work
-- paid by A waits.
select pg_temp.p934_reading(statement_timestamp() - interval '1 hour', 100, statement_timestamp() + interval '2 days');
select pg_temp.base_assert(abs(extract(epoch from pg_temp.p934_wall() - (statement_timestamp() + interval '2 days'))) < 2
	and public.qorpera_native_account_remaining(pg_temp.p934_a(), 2) = 0
	and public.qorpera_sponsor_waits_for_usage_limit((current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1),
	'the wall does not hold to the reading''s reset: ' || coalesce(pg_temp.p934_wall()::text, 'none'));

-- 4. A reading more than a day old names no reset: the wall is the 6 hours again (the daily check reads it anew first).
select pg_temp.p934_reading(statement_timestamp() - interval '25 hours', 100, statement_timestamp() + interval '2 days');
select pg_temp.base_assert(pg_temp.p934_wall() is null, 'a reading older than a day held the wall');

-- 5. A signal older than 8 days never looks at a reading.
select pg_temp.p934_reading(statement_timestamp() - interval '1 hour', 100, statement_timestamp() + interval '2 days');
update public.qorpera_provider_connection_usage_signals set observed_at = statement_timestamp() - interval '9 days'
where provider_connection_id = pg_temp.p934_a() and signal_kind = 'usage_limit';
select pg_temp.base_assert(pg_temp.p934_wall() is null, 'a signal older than 8 days held a wall');

-- 6. A reading after the limit that shows room ends the wall at once (20260930575000), also with a reading's reset.
update public.qorpera_provider_connection_usage_signals set observed_at = statement_timestamp() - interval '7 hours'
where provider_connection_id = pg_temp.p934_a() and signal_kind = 'usage_limit';
select pg_temp.p934_reading(statement_timestamp() - interval '1 minute', 30, null);
select pg_temp.base_assert(pg_temp.p934_wall() is null
	and not public.qorpera_sponsor_waits_for_usage_limit((current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1),
	'a reading with room did not end the wall');

rollback;
