-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A fresh usage reading of a ChatGPT login ends its usage wall in every company of that login (20260930724000).
-- Found live on 11 Nov 2026: the account's weekly limit was reset early and the login read 0 % used in Brooks, but an old
-- signal in another company of the login (on a since-revoked connection of the same account), kept alive by an older
-- full reading there, walled the login for six more days, so a waiting chat turn never went on.

-- The world's rows, written directly as test 1111 does: only the wall functions read them.
create function pg_temp.w_id(p_kind integer, p_n integer) returns uuid language sql immutable as $$
	select ('1219' || lpad(p_kind::text, 4, '0') || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.w_connection(p_n integer, p_company integer, p_owner integer, p_status text default 'active')
returns void language sql as $$
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, status,
		created_by_user_id)
	values (pg_temp.w_id(1, p_n), pg_temp.w_id(2, p_company), pg_temp.w_id(4, p_n), pg_temp.w_id(3, p_owner), 'openai',
		p_status, pg_temp.w_id(3, 1))
$$;
-- One version on its own credential capsule, linked to login 1 when asked.
create function pg_temp.w_version(p_n integer, p_login boolean) returns void language plpgsql as $$
declare v_connection public.qorpera_provider_connections;
begin
	select * into strict v_connection from public.qorpera_provider_connections where id = pg_temp.w_id(1, p_n);
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, billing_source, consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id,
		authorization_state, max_native_concurrency, quota_policy)
	values (v_connection.id, 1, 'native_subscription', 'codex-cli', null, 'personal-subscription', 'w-consent',
		pg_temp.w_id(3, 1), pg_temp.w_id(3, 1), pg_temp.w_id(5, p_n), 'active', 1,
		'{"monthly_microusd":1000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	if p_login then
		insert into public.qorpera_model_login_links(credential_capsule_id, login_id, profile_id, compute_identity_id, owner_user_id)
		values (pg_temp.w_id(5, p_n), pg_temp.w_id(6, 1), v_connection.profile_id, pg_temp.w_id(7, 1), v_connection.owner_user_id);
	end if;
end $$;
create function pg_temp.w_signal(p_n integer, p_ago interval, p_resets interval default null) returns void language sql as $$
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source, observed_at, resets_at)
	select connection.profile_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.w_id(8, 1), 1,
		connection.id, 1, 'openai', 'usage_limit', 'native_adapter', statement_timestamp() - p_ago,
		statement_timestamp() + p_resets
	from public.qorpera_provider_connections as connection where connection.id = pg_temp.w_id(1, p_n)
$$;
-- A reading of account 'a' (or another), p_ago old, with its one weekly window p_used full, resetting p_reset from now.
create function pg_temp.w_reading(p_n integer, p_ago interval, p_used numeric, p_reset interval,
	p_identity text default repeat('a', 64)) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity,
		provider_account_usage)
	values (pg_temp.w_id(1, p_n), 1, p_identity, jsonb_build_object('observedAt', statement_timestamp() - p_ago,
		'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Weekly', 'usedPercent', p_used,
			'resetAt', to_char((statement_timestamp() + p_reset) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'windowSeconds', 604800))))
	on conflict (connection_id, connection_version) do update
	set provider_account_identity = excluded.provider_account_identity, provider_account_usage = excluded.provider_account_usage
$$;
create function pg_temp.w_wall(p_n integer) returns timestamptz language sql as $$
	select public.qorpera_native_account_usage_limit_reset(pg_temp.w_id(1, p_n))
$$;
create function pg_temp.w_near(p_at timestamptz, p_from_now interval) returns boolean language sql as $$
	select p_at is not null and abs(extract(epoch from p_at - (statement_timestamp() + p_from_now))) < 2
$$;
create function pg_temp.w_text(p_at timestamptz) returns text language sql as $$
	select coalesce(p_at::text, 'none')
$$;

-- The world, as on production: member 1's login is connection 1 in company 1 (Brooks) and connection 2 in company 2.
-- Connection 3 is an old, revoked connection of the same account in company 2. Connection 4 is member 2's login of the
-- same account in company 1. Connection 5 is a revoked connection of member 1's login in company 3.
set local session_replication_role = replica;
select pg_temp.w_connection(1, 1, 1), pg_temp.w_connection(2, 2, 1), pg_temp.w_connection(3, 2, 1, 'revoked'),
	pg_temp.w_connection(4, 1, 2), pg_temp.w_connection(5, 3, 1, 'revoked') \g /dev/null
select pg_temp.w_version(1, true), pg_temp.w_version(2, true), pg_temp.w_version(3, false), pg_temp.w_version(4, false),
	pg_temp.w_version(5, true) \g /dev/null
select pg_temp.base_assert((select count(*) = 2 from public.qorpera_account_login_sibling_connections(pg_temp.w_id(1, 1))),
	'connection 1''s login has its two other companies: 2 and 5');

-- 1. Seven days ago the account hit its limit through connection 3 (no reset named). Company 2 read it full two hours ago,
-- to a reset six days ahead, and nothing newer has room: the login is walled to that reset, in both companies.
select pg_temp.w_reading(3, interval '6 days', 4, interval '1 day') \g /dev/null
select pg_temp.w_signal(3, interval '7 days') \g /dev/null
select pg_temp.w_reading(2, interval '2 hours', 100, interval '6 days') \g /dev/null
select pg_temp.w_reading(1, interval '3 hours', 100, interval '6 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(pg_temp.w_wall(1), interval '6 days') and pg_temp.w_near(pg_temp.w_wall(2), interval '6 days')
	and public.qorpera_native_account_remaining(pg_temp.w_id(1, 1), 1) = 0,
	'the limit does not hold the login: ' || pg_temp.w_text(pg_temp.w_wall(1)));

-- 2. The account's limit is reset early: Brooks reads it 0 % used a minute ago. The wall ends in every company, at once,
-- and the login has room (before 20260930724000 it stayed walled six more days).
select pg_temp.w_reading(1, interval '1 minute', 0, interval '7 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_wall(1) is null and pg_temp.w_wall(2) is null
	and public.qorpera_native_account_usage_limit_reset_company(pg_temp.w_id(1, 2)) is null
	and public.qorpera_native_account_wall_reading_reset(pg_temp.w_id(1, 2)) is null
	and public.qorpera_native_account_remaining(pg_temp.w_id(1, 1), 1) = 100,
	'a fresh reading with room in Brooks did not end the wall: ' || pg_temp.w_text(pg_temp.w_wall(1)) || ' / '
	|| pg_temp.w_text(pg_temp.w_wall(2)));

-- 3. A signal that names its own reset ends the same way: company 2's limit three hours ago, said to last five days,
-- ends with Brooks's later reading with room.
delete from public.qorpera_provider_connection_usage_signals where provider_connection_id::text like '12190001-%';
select pg_temp.w_signal(2, interval '3 hours', interval '5 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_wall(1) is null and pg_temp.w_wall(2) is null,
	'a reading with room in another company did not end a signal with its own reset: ' || pg_temp.w_text(pg_temp.w_wall(2)));

-- But a reading with room ends nothing once a newer reading of the account is full: company 2 reads it full again.
select pg_temp.w_reading(2, interval '30 seconds', 100, interval '6 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(pg_temp.w_wall(2), interval '5 days'),
	'a reading with room ended the wall after a newer full reading: ' || pg_temp.w_text(pg_temp.w_wall(2)));
select pg_temp.w_reading(2, interval '2 hours', 100, interval '6 days') \g /dev/null
-- A newer full reading whose window has reset since ends nothing: it is full no more.
select pg_temp.w_reading(2, interval '30 seconds', 100, interval '-10 seconds') \g /dev/null
select pg_temp.base_assert(pg_temp.w_wall(2) is null,
	'a full window that has reset since kept the wall: ' || pg_temp.w_text(pg_temp.w_wall(2)));
select pg_temp.w_reading(2, interval '2 hours', 100, interval '6 days') \g /dev/null
-- At the same time, room wins.
update public.qorpera_native_provider_account_metadata as full_reading
set provider_account_usage = jsonb_set(full_reading.provider_account_usage, '{observedAt}',
	room_reading.provider_account_usage -> 'observedAt')
from public.qorpera_native_provider_account_metadata as room_reading
where full_reading.connection_id = pg_temp.w_id(1, 2) and room_reading.connection_id = pg_temp.w_id(1, 1);
select pg_temp.base_assert(pg_temp.w_wall(2) is null,
	'a full reading at the same time as the reading with room kept the wall: ' || pg_temp.w_text(pg_temp.w_wall(2)));
select pg_temp.w_reading(2, interval '2 hours', 100, interval '6 days') \g /dev/null

-- 4. What still holds the wall:
-- a reading with room older than the signal;
select pg_temp.w_reading(1, interval '4 hours', 0, interval '7 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(pg_temp.w_wall(1), interval '5 days'),
	'a reading older than the signal ended it: ' || pg_temp.w_text(pg_temp.w_wall(1)));
-- another member's login of the same account (member 2's in Brooks), however fresh;
select pg_temp.w_reading(4, interval '1 minute', 0, interval '7 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(pg_temp.w_wall(2), interval '5 days'),
	'another member''s reading ended the wall: ' || pg_temp.w_text(pg_temp.w_wall(2)));
-- another account of the same member;
select pg_temp.w_reading(1, interval '1 minute', 0, interval '7 days', repeat('b', 64)) \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(pg_temp.w_wall(2), interval '5 days'),
	'a reading of another account ended the wall: ' || pg_temp.w_text(pg_temp.w_wall(2)));
-- a revoked connection of the login.
select pg_temp.w_reading(1, interval '4 hours', 0, interval '7 days') \g /dev/null
select pg_temp.w_reading(5, interval '1 minute', 0, interval '7 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(pg_temp.w_wall(2), interval '5 days'),
	'a revoked connection''s reading ended the wall: ' || pg_temp.w_text(pg_temp.w_wall(2)));

-- 5. A full window counts toward a wall only while no newer reading of the login, on a live login, has room. The login's
-- room was read before the full window here: the full window counts, and a revoked connection's newer reading with room
-- overtakes nothing.
delete from public.qorpera_provider_connection_usage_signals where provider_connection_id::text like '12190001-%';
select pg_temp.w_reading(1, interval '3 hours', 0, interval '7 days') \g /dev/null
select pg_temp.w_reading(2, interval '2 hours', 100, interval '6 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(public.qorpera_native_account_wall_reading_reset(pg_temp.w_id(1, 2)), interval '6 days'),
	'a revoked connection''s newer reading overtook a full window');
-- Brooks reads room after the full window: the full window no longer counts. The account then hits its limit again, with
-- no reset named: the wall is the 6 hours, not the old window's reset six days ahead (as it was before 20260930724000).
select pg_temp.w_reading(1, interval '1 hour', 0, interval '7 days') \g /dev/null
select pg_temp.w_signal(3, interval '30 minutes') \g /dev/null
select pg_temp.base_assert(public.qorpera_native_account_wall_reading_reset(pg_temp.w_id(1, 2)) is null
	and pg_temp.w_near(pg_temp.w_wall(2), interval '5 hours 30 minutes')
	and pg_temp.w_near(pg_temp.w_wall(1), interval '5 hours 30 minutes'),
	'an overtaken full window still held the wall: ' || pg_temp.w_text(pg_temp.w_wall(2)));
-- A full reading newer than the room counts again, and holds the wall to its reset.
select pg_temp.w_reading(2, interval '30 seconds', 100, interval '6 days') \g /dev/null
select pg_temp.base_assert(pg_temp.w_near(public.qorpera_native_account_wall_reading_reset(pg_temp.w_id(1, 1)), interval '6 days')
	and pg_temp.w_near(pg_temp.w_wall(1), interval '6 days'),
	'a full reading newer than the room did not hold the wall: ' || pg_temp.w_text(pg_temp.w_wall(1)));

-- The two functions keep their rights: the database's own.
select pg_temp.base_assert(not has_function_privilege(role_name, 'public.qorpera_native_account_wall_reading_reset(uuid)', 'execute')
	and not has_function_privilege(role_name, 'public.qorpera_native_account_usage_limit_reset_company(uuid)', 'execute'),
	role_name || ' may call a wall function')
from unnest(array['anon', 'authenticated']) as role_name;

rollback;
