-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- What the usage-wall check costs, and that it still answers the same (20260930611000). Measured on production, 3 to 7 Nov
-- 2026: 193,463 of the materializer's 193,994 calls fell in the day one login's wall held and answered 'idle', at 170 ms
-- each, because the due list did not know the wall and one check ran up to 72 company walls for a login in 8 companies.
-- 2. Cases the rewritten wall must keep, each with its answer: company logins with no owner, a later reading of a revoked
-- connection, of an old version or of another member, a reading at exactly the signal's time, and a connection on this
-- one's credential capsule, which closes it through a sibling.
-- 3. One check works out each company's wall once.
-- 4. The due list agrees with the company's scan: work at a wall is not due.
-- 5. The due list's check is last, and one that fails stops only its own company.
-- 6. Work paid by another login or another sponsor version is due beside it, and it goes on once its login has room.

-- The world's rows, written directly: only these functions read them, and no other row refers to them.
create function pg_temp.d1_id(p_kind integer, p_n integer) returns uuid language sql immutable as $$
	select ('1111' || lpad(p_kind::text, 4, '0') || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.d1_connection(p_n integer, p_company integer, p_owner integer, p_provider text default 'openai',
	p_status text default 'active') returns void language sql as $$
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, status,
		created_by_user_id)
	values (pg_temp.d1_id(1, p_n), pg_temp.d1_id(2, p_company), pg_temp.d1_id(4, p_n), pg_temp.d1_id(3, p_owner), p_provider,
		p_status, pg_temp.d1_id(3, 1))
$$;
-- One version on a credential capsule, linked to a login when one is named; with no capsule, an API-key version.
create function pg_temp.d1_version(p_n integer, p_version bigint, p_capsule integer, p_login integer default null,
	p_state text default 'active') returns void language plpgsql as $$
declare v_connection public.qorpera_provider_connections;
begin
	select * into strict v_connection from public.qorpera_provider_connections where id = pg_temp.d1_id(1, p_n);
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, billing_source, consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id,
		authorization_state, max_native_concurrency, quota_policy)
	values (v_connection.id, p_version, case when p_capsule is null then 'api_key' else 'native_subscription' end, 'codex-cli',
		case when p_capsule is null then 'object://d1-key' end, 'personal-subscription', 'd1-consent', pg_temp.d1_id(3, 1),
		pg_temp.d1_id(3, 1), pg_temp.d1_id(5, p_capsule), p_state, case when p_capsule is not null then 1 end,
		'{"monthly_microusd":1000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	if p_login is not null then
		insert into public.qorpera_model_login_links(credential_capsule_id, login_id, profile_id, compute_identity_id, owner_user_id)
		values (pg_temp.d1_id(5, p_capsule), pg_temp.d1_id(6, p_login), v_connection.profile_id, pg_temp.d1_id(7, 1),
			v_connection.owner_user_id);
	end if;
end $$;
create function pg_temp.d1_signal(p_n integer, p_version bigint, p_observed timestamptz, p_resets timestamptz default null,
	p_kind text default 'usage_limit') returns void language sql as $$
	insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, provider, signal_kind, source, observed_at, resets_at)
	values (pg_temp.d1_id(2, 1), extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.d1_id(8, 1), 1,
		pg_temp.d1_id(1, p_n), p_version, 'openai', p_kind, 'native_adapter', p_observed, p_resets)
$$;
create function pg_temp.d1_window(p_used numeric, p_reset interval default null) returns jsonb language sql stable as $$
	select jsonb_strip_nulls(jsonb_build_object('id', 'primary', 'label', 'Week', 'usedPercent', p_used,
		'resetAt', to_char((statement_timestamp() + p_reset) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
$$;
create function pg_temp.d1_reading(p_n integer, p_version bigint, p_identity text, p_usage jsonb) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity,
		provider_account_usage)
	values (pg_temp.d1_id(1, p_n), p_version, p_identity, p_usage)
	on conflict (connection_id, connection_version) do update
	set provider_account_identity = excluded.provider_account_identity, provider_account_usage = excluded.provider_account_usage
$$;
-- A usage reading as the vault's check records it: one of the shapes that decide a wall or the room.
create function pg_temp.d1_usage(p_shape integer) returns jsonb language sql stable as $$
	select case p_shape
		when 0 then null
		when 1 then jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
			'windows', jsonb_build_array(pg_temp.d1_window(30)))
		when 2 then jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
			'windows', jsonb_build_array(pg_temp.d1_window(100, interval '2 days')))
		when 3 then jsonb_build_object('observedAt', statement_timestamp() - interval '2 hours',
			'windows', jsonb_build_array(pg_temp.d1_window(100, interval '2 days'), pg_temp.d1_window(10)))
		when 4 then jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
			'windows', jsonb_build_array(pg_temp.d1_window(130)))
		when 5 then jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
			'windows', jsonb_build_array(pg_temp.d1_window(20, interval '-1 minute')))
		when 6 then jsonb_build_object('observedAt', statement_timestamp() - interval '10 minutes',
			'windows', jsonb_build_array(pg_temp.d1_window(40, interval '1 hour')))
		when 7 then jsonb_build_object('observedAt', statement_timestamp() - interval '1 hour', 'windows', '[]'::jsonb)
		when 8 then jsonb_build_object('observedAt', statement_timestamp() + interval '1 hour',
			'windows', jsonb_build_array(pg_temp.d1_window(10)))
		when 9 then jsonb_build_object('observedAt', statement_timestamp() - interval '9 days',
			'windows', jsonb_build_array(pg_temp.d1_window(100, interval '1 day')))
		when 10 then jsonb_build_object('observedAt', statement_timestamp() - interval '1 hour',
			'windows', jsonb_build_array(pg_temp.d1_window(100, interval '100 days')))
		when 11 then jsonb_build_object('observedAt', statement_timestamp() - interval '2 minutes',
			'windows', jsonb_build_array(pg_temp.d1_window(50, interval '1 hour'), pg_temp.d1_window(101, interval '1 hour')))
		else jsonb_build_object('observedAt', statement_timestamp() - interval '4 hours',
			'windows', jsonb_build_array(pg_temp.d1_window(60))) end
$$;
-- The checks start here.
-- 1. The world: four companies, two members, three logins. Connection 1's version 2 is on capsule 1, and connection 8 holds
-- the same capsule; connection 12 holds connection 2's. Connection 6 is another provider's and 9 an API key's, 7 is
-- revoked and 10's version too. Connection 13 holds connection 6's capsule, which no login links. Connections 14 and 15 are
-- company logins, with no owner, and 16 is a revoked connection of the first member in the first company, and 17 one with
-- its version's authorization revoked.
set local session_replication_role = replica;
select pg_temp.d1_connection(1, 1, 1), pg_temp.d1_connection(2, 2, 1), pg_temp.d1_connection(3, 1, 1), pg_temp.d1_connection(4, 2, 1),
	pg_temp.d1_connection(5, 1, 2), pg_temp.d1_connection(6, 1, 1, 'anthropic'), pg_temp.d1_connection(7, 3, 1, 'openai', 'revoked'),
	pg_temp.d1_connection(8, 1, 1), pg_temp.d1_connection(9, 1, 1), pg_temp.d1_connection(10, 4, 1), pg_temp.d1_connection(11, 4, 1),
	pg_temp.d1_connection(12, 2, 1), pg_temp.d1_connection(13, 1, 1, 'anthropic'), pg_temp.d1_connection(14, 1, null),
	pg_temp.d1_connection(15, 1, null), pg_temp.d1_connection(16, 1, 1, 'openai', 'revoked'), pg_temp.d1_connection(17, 1, 1) \g /dev/null
select pg_temp.d1_version(1, 1, 101), pg_temp.d1_version(1, 2, 1, 1), pg_temp.d1_version(2, 1, 2, 1), pg_temp.d1_version(3, 1, 3, 2),
	pg_temp.d1_version(4, 1, 4, 2), pg_temp.d1_version(5, 1, 5, 3), pg_temp.d1_version(6, 1, 6), pg_temp.d1_version(7, 1, 7, 1),
	pg_temp.d1_version(8, 1, 1), pg_temp.d1_version(9, 1, null), pg_temp.d1_version(10, 1, 10, 1, 'revoked'),
	pg_temp.d1_version(11, 1, 11, 2), pg_temp.d1_version(12, 1, 2), pg_temp.d1_version(13, 1, 6), pg_temp.d1_version(14, 1, 14),
	pg_temp.d1_version(15, 1, 15), pg_temp.d1_version(16, 1, 16), pg_temp.d1_version(17, 1, 17, null, 'revoked') \g /dev/null
select pg_temp.base_assert((select count(*) = 4 from public.qorpera_account_login_sibling_connections(pg_temp.d1_id(1, 1))),
	'connection 1 has the login''s other companies: 2 and 12 on capsule 2, and 7 and 10');

create function pg_temp.d1_clear() returns void language sql as $$
	delete from public.qorpera_native_provider_account_metadata where connection_id::text like '11110001-%';
	delete from public.qorpera_provider_connection_usage_signals where provider_connection_id::text like '11110001-%';
$$;
-- A reading at p_at: with room, or with its one window full.
create function pg_temp.d1_read(p_n integer, p_version bigint, p_identity text, p_at timestamptz, p_used numeric) returns void
language sql as $$
	select pg_temp.d1_reading(p_n, p_version, p_identity, jsonb_build_object('observedAt', p_at,
		'windows', jsonb_build_array(pg_temp.d1_window(p_used))))
$$;
create function pg_temp.d1_expect(p_n integer, p_held boolean, p_case text) returns void language plpgsql as $$
declare v_new timestamptz := public.qorpera_native_account_usage_limit_reset_company(pg_temp.d1_id(1, p_n));
begin
	perform pg_temp.base_assert((v_new is not null) = p_held, p_case || ': the wall is ' || coalesce(v_new::text, 'none'));
end $$;
create function pg_temp.d1_blocked(p_n integer, p_version bigint, p_at timestamptz) returns void language sql as $$
	select pg_temp.d1_signal(p_n, p_version, p_at, statement_timestamp() + interval '1 hour')
$$;
create function pg_temp.d1_cases() returns void language plpgsql as $$
declare v_at timestamptz := date_trunc('second', statement_timestamp()) - interval '10 minutes';
begin
	-- Company logins have no owner: a signal on one holds the other of the same account in the company.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(14, 1, repeat('d', 64), v_at, 100);
	perform pg_temp.d1_read(15, 1, repeat('d', 64), v_at, 100);
	perform pg_temp.d1_blocked(15, 1, v_at - interval '1 hour');
	perform pg_temp.d1_expect(14, true, 'a company login''s signal on the other company login of its account');
	-- And a later reading with room on the other company login of the account ends it.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(14, 1, repeat('d', 64), v_at, 100);
	perform pg_temp.d1_read(15, 1, repeat('d', 64), v_at, 30);
	perform pg_temp.d1_blocked(14, 1, v_at - interval '1 hour');
	perform pg_temp.d1_expect(14, false, 'a later reading with room of the other company login');
	-- A later reading with room on a revoked connection ends nothing.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at, 100);
	perform pg_temp.d1_read(16, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_blocked(3, 1, v_at - interval '1 hour');
	perform pg_temp.d1_expect(3, true, 'a later reading of a revoked connection');
	-- Nor does one on a version whose authorization is revoked, or on an API key's connection.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at, 100);
	perform pg_temp.d1_read(17, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_blocked(3, 1, v_at - interval '1 hour');
	perform pg_temp.d1_expect(3, true, 'a later reading of a revoked version');
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at, 100);
	perform pg_temp.d1_read(9, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_blocked(3, 1, v_at - interval '1 hour');
	perform pg_temp.d1_expect(3, true, 'a later reading of an API key''s connection');
	-- Nor does one on another member's login of the account.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at, 100);
	perform pg_temp.d1_read(5, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_blocked(3, 1, v_at - interval '1 hour');
	perform pg_temp.d1_expect(3, true, 'a later reading of another member''s login');
	-- Nor one on a version the connection has moved on from.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(1, 2, repeat('e', 64), v_at, 100);
	perform pg_temp.d1_read(1, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_blocked(1, 2, v_at - interval '1 hour');
	perform pg_temp.d1_expect(1, true, 'a later reading of an old version');
	-- A reading at exactly the signal's time is not later: the wall holds. A microsecond later it ends.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_blocked(3, 1, v_at);
	perform pg_temp.d1_expect(3, true, 'a reading at the signal''s time');
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at + interval '1 microsecond', 30);
	perform pg_temp.d1_expect(3, false, 'a reading just after the signal');
	-- Two signals around a reading with room: the older ended, the newer holds, to its own reset.
	perform pg_temp.d1_clear();
	perform pg_temp.d1_read(3, 1, repeat('e', 64), v_at, 30);
	perform pg_temp.d1_signal(3, 1, v_at - interval '1 hour', statement_timestamp() + interval '5 hours');
	perform pg_temp.d1_signal(3, 1, v_at + interval '1 minute', statement_timestamp() + interval '1 hour');
	perform pg_temp.base_assert(public.qorpera_native_account_usage_limit_reset_company(pg_temp.d1_id(1, 3))
			= statement_timestamp() + interval '1 hour',
		'the reading ended the wrong signal');
end $$;
select pg_temp.d1_cases() \g /dev/null

-- Connection 8 holds connection 1's capsule, so it is no sibling of connection 1, but it is one of connection 2, which
-- is. Its wall alone sets connection 2's, and so closes connection 1 through it, with no wall of connection 1's own.
select pg_temp.d1_clear() \g /dev/null
select pg_temp.d1_signal(8, 1, statement_timestamp() - interval '1 minute', statement_timestamp() + interval '1 day') \g /dev/null
select pg_temp.base_assert(public.qorpera_native_account_usage_limit_reset(pg_temp.d1_id(1, 1)) is null
	and public.qorpera_native_account_usage_limit_reset(pg_temp.d1_id(1, 2)) is not null
	and public.qorpera_native_account_remaining(pg_temp.d1_id(1, 1), 2) = 0,
	'a sibling''s wall through the shared capsule did not close the login');
-- A connection with no sibling is not closed by its capsule's other holder: connection 13's wall leaves connection 6 alone.
delete from public.qorpera_provider_connection_usage_signals where provider_connection_id::text like '11110001-%';
select pg_temp.d1_signal(13, 1, statement_timestamp() - interval '1 minute', statement_timestamp() + interval '1 day') \g /dev/null
select pg_temp.base_assert(public.qorpera_native_account_usage_limit_reset(pg_temp.d1_id(1, 13)) is not null
	and public.qorpera_native_account_remaining(pg_temp.d1_id(1, 6), 1) = -1,
	'a capsule''s other holder closed a connection with no sibling');

-- 3. A login in 8 companies, as on production. With no wall in force (no reading names a reset, and the signals, 13 to 165
-- hours old with none of their own, have run out) each company's wall is worked out once, not 72 times.
do $$
declare v_n integer; v_i integer;
begin
	for v_n in 21 .. 28 loop
		perform pg_temp.d1_connection(v_n, v_n, 1);
		perform pg_temp.d1_version(v_n, 1, v_n, 9);
		perform pg_temp.d1_reading(v_n, 1, repeat('c', 64), pg_temp.d1_usage(12));
		for v_i in 1 .. 20 loop
			perform pg_temp.d1_signal(v_n, 1, statement_timestamp() - interval '5 hours' - v_i * interval '8 hours');
		end loop;
	end loop;
end $$;
set local session_replication_role = origin;
select pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.d1_id(1, 21), 1) = -1,
	'the login''s room is ' || public.qorpera_native_account_remaining(pg_temp.d1_id(1, 21), 1));
select pg_temp.d1_reading(21, 1, repeat('c', 64), pg_temp.d1_usage(3)) \g /dev/null
select pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.d1_id(1, 21), 1) = 0, 'the login at its wall has room');

-- 4. The due list and the scan. Login A's fresh reading is full, so it has no room. Dana's kickoff (a turn request) and the
-- owner's two posts in Bob's thread (wakes) wait on it: the company's scan is idle, so the due list does not name the company,
-- and it checks A's sponsor version once.
create function pg_temp.d1_due() returns jsonb language plpgsql as $$
declare v_due jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_due := public.qorpera_folder_materialize_due(null, 100);
	reset role;
	return v_due -> 'items';
end $$;
create function pg_temp.d1_listed() returns boolean language sql as $$
	select pg_temp.d1_due() @> '[{"profile_id":"92400000-0000-4000-8000-000000000010"}]'
$$;
create function pg_temp.d1_a() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
$$;
create function pg_temp.d1_a_binding() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
$$;
create function pg_temp.d1_b() returns uuid language sql as $$
	select (current_setting('qorpera_test.d1_connection')::jsonb ->> 'connection_id')::uuid
$$;
create function pg_temp.d1_b_binding() returns uuid language sql as $$
	select (current_setting('qorpera_test.d1_sponsor')::jsonb ->> 'binding_id')::uuid
$$;
create function pg_temp.d1_wake(p_setting text) returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.' || p_setting)::uuid
$$;
-- This company's work is the only work, whatever earlier tests in this database left, so the counts below are exact.
set local session_replication_role = replica;
delete from public.qorpera_wake_occurrences where status = 'queued' and profile_id <> '92400000-0000-4000-8000-000000000010';
delete from public.qorpera_session_turn_requests where status = 'queued' and profile_id <> '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.d1_a(), 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(pg_temp.d1_window(100, interval '2 days'))))
on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
select pg_temp.base_assert(not pg_temp.d1_listed(), 'something is due before the work is queued: ' || pg_temp.d1_due()::text);
select pg_temp.base_commit(pg_temp.base_owner(), 'd1-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
select set_config('qorpera_test.d1_post_1', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000031', 'Are the numbers in?') ->> 0, true) \g /dev/null
select set_config('qorpera_test.d1_post_2', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000031', 'And the costs?') ->> 0, true) \g /dev/null
do $$
declare v_listed boolean; v_pass jsonb;
begin
	perform pg_temp.base_assert((pg_temp.d1_wake('d1_post_1')).status = 'queued' and (pg_temp.d1_wake('d1_post_2')).status = 'queued'
		and (pg_temp.d1_wake('d1_post_1')).sponsor_binding_id = pg_temp.d1_a_binding()
		and (pg_temp.d1_wake('d1_post_2')).sponsor_binding_id = pg_temp.d1_a_binding()
		and (select count(*) = 1 from public.qorpera_session_turn_requests
			where profile_id = '92400000-0000-4000-8000-000000000010' and status = 'queued'
				and sponsor_binding_id = pg_temp.d1_a_binding()),
		'the work is not queued on A');
	v_listed := pg_temp.d1_listed();
	perform pg_temp.base_assert(not v_listed, 'work at its login''s limit is due: ' || pg_temp.d1_due()::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'idle', 'the scan took work at its login''s limit: ' || v_pass::text);
end $$;

-- 5. The check is last. Companies 901 and 902 have a wake due on a sponsor of their own, and so do 903, paused, 904, with no
-- company file, and 905, whose company file is on snapshot-v1; they sort before this company, whose only sponsor is at its
-- limit.
create function pg_temp.d1_company(p_n integer, p_file boolean, p_paused boolean, p_snapshot boolean default false)
returns void language plpgsql as $$
declare v_wake public.qorpera_wake_occurrences := pg_temp.d1_wake('d1_post_1'); v_profile uuid := pg_temp.d1_id(2, p_n);
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_wake_occurrences
	select (jsonb_populate_record(null::public.qorpera_wake_occurrences, to_jsonb(v_wake) || jsonb_build_object(
		'id', extensions.gen_random_uuid(), 'profile_id', v_profile, 'sponsor_binding_id', pg_temp.d1_id(8, p_n),
		'session_id', null, 'occurrence_key', 'd1-' || p_n))).*;
	if p_file then
		insert into public.qorpera_company_files
		select (jsonb_populate_record(null::public.qorpera_company_files, to_jsonb(file) || jsonb_build_object(
			'environment_id', extensions.gen_random_uuid(), 'profile_id', v_profile,
			'canonical_workspace_id', extensions.gen_random_uuid())
			|| case when p_snapshot then jsonb_build_object('core', 'snapshot-v1', 'head_snapshot_id', extensions.gen_random_uuid())
				else '{}'::jsonb end)).*
		from public.qorpera_company_files as file where file.profile_id = '92400000-0000-4000-8000-000000000010';
	end if;
	if p_paused then
		insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
		values (v_profile, '92400000-0000-4000-8000-000000000001');
	end if;
	perform set_config('session_replication_role', 'origin', true);
end $$;
create function pg_temp.d1_page(p_after uuid, p_limit integer) returns jsonb language plpgsql as $$
declare v_due jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v_due := public.qorpera_folder_materialize_due(p_after, p_limit);
	reset role;
	return v_due;
end $$;
create function pg_temp.d1_items(p_companies integer[]) returns jsonb language sql immutable as $$
	select coalesce(jsonb_agg(jsonb_build_object('profile_id', pg_temp.d1_id(2, n)) order by n), '[]'::jsonb) from unnest(p_companies) as n
$$;
select pg_temp.d1_company(901, true, false), pg_temp.d1_company(902, true, false), pg_temp.d1_company(903, true, true),
	pg_temp.d1_company(904, false, false), pg_temp.d1_company(905, true, false, true) \g /dev/null
do $$
declare v_page jsonb;
begin
	-- The paused company and the two not on folder-v2 are not named and cost nothing.
	v_page := pg_temp.d1_page(null, 100);
	perform pg_temp.base_assert(v_page -> 'items' = pg_temp.d1_items(array[901, 902]),
		'a whole page: ' || v_page::text);
	-- A page of one stops when it knows there is more, before this company's sponsor.
	v_page := pg_temp.d1_page(null, 1);
	perform pg_temp.base_assert(v_page -> 'items' = pg_temp.d1_items(array[901]) and (v_page ->> 'has_more')::boolean
		and v_page ->> 'next_after_profile_id' = pg_temp.d1_id(2, 901)::text,
		'a page of one: ' || v_page::text);
	-- Companies before the cursor cost nothing.
	v_page := pg_temp.d1_page(pg_temp.d1_id(2, 902), 100);
	perform pg_temp.base_assert(v_page -> 'items' = '[]'::jsonb,
		'a page after the cursor: ' || v_page::text);
end $$;

-- A check that fails stops only its own company. No writer lets in a reading whose windows are no array; this one is written
-- by hand. The check itself still fails, the list does not: it names the company, whose own call fails alone with the
-- check's error, and the others stay listed.
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_build_object('observedAt', statement_timestamp(), 'windows', '"x"'::jsonb)
where connection_id = pg_temp.d1_a() and connection_version = 2;
do $$
declare v_page jsonb; v_pass jsonb; v_error text;
begin
	begin
		perform public.qorpera_sponsor_waits_for_usage_limit(pg_temp.d1_a_binding(), 1);
		raise exception 'the check did not fail on the bad reading';
	exception when sqlstate '22023' then null;
	end;
	v_page := pg_temp.d1_page(null, 100);
	perform pg_temp.base_assert(v_page -> 'items' @> pg_temp.d1_items(array[901, 902]) and pg_temp.d1_listed(),
		'a failing check stopped the list or hid its company: ' || v_page::text);
	begin
		v_pass := pg_temp.base_materialize();
		raise exception 'the company''s own call did not fail: %', v_pass;
	exception when sqlstate '22023' then v_error := sqlerrm;
	end;
	perform pg_temp.base_assert(v_error is not null, 'the company''s own call did not fail with the check''s error');
end $$;
-- As the orchestrator may run it, in a read-only transaction.
savepoint d1_read_only;
set local transaction_read_only = on;
select pg_temp.base_assert(pg_temp.d1_listed(), 'a failing check stopped the list in a read-only transaction');
rollback to savepoint d1_read_only;
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(pg_temp.d1_window(100, interval '2 days')))
where connection_id = pg_temp.d1_a() and connection_version = 2;
select pg_temp.base_assert(not pg_temp.d1_listed(), 'the mended reading has room');

-- 6. A wake paid by login B, with room, is due though A's work waits in the same company, and only it goes on.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.d1_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','11110009-0000-4000-8000-000000000051','11110009-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.d1_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.d1_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'11110009-0000-4000-8000-000000000060',
	'object://native-capsules/11110009-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = pg_temp.d1_b() and version = 1;
select set_config('qorpera_test.d1_thread', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000032')), true) \g /dev/null
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.d1_sponsor', public.qorpera_create_member_execution_sponsor('92400000-0000-4000-8000-000000000010',
	'11110009-0000-4000-8000-000000000061',pg_temp.d1_b(),2,true)::text, true) \g /dev/null
select pg_temp.base_assert(public.qorpera_choose_member_session_account('92400000-0000-4000-8000-000000000010',
	current_setting('qorpera_test.d1_thread')::uuid, pg_temp.d1_b()) = pg_temp.d1_b(), 'the owner could not pick B');
reset role;
insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
values (pg_temp.d1_b(), 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(pg_temp.d1_window(20))));
-- The check is of the sponsor version, not of the binding: a wake on a second version of A's binding, paid by B, is due while
-- the first version's work waits.
set local session_replication_role = replica;
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
	provider_connection_version, allow_autonomous, created_by_user_id)
select binding_id, 2, sponsor_kind, pg_temp.d1_b(), 2, allow_autonomous, created_by_user_id
from public.qorpera_execution_sponsor_versions where binding_id = pg_temp.d1_a_binding() and version = 1;
update public.qorpera_wake_occurrences set sponsor_version = 2 where id = current_setting('qorpera_test.d1_post_2')::uuid;
set local session_replication_role = origin;
select pg_temp.base_assert(pg_temp.d1_listed(), 'the second sponsor version''s room did not count: ' || pg_temp.d1_due()::text);
set local session_replication_role = replica;
update public.qorpera_wake_occurrences set sponsor_version = 1 where id = current_setting('qorpera_test.d1_post_2')::uuid;
delete from public.qorpera_execution_sponsor_versions where binding_id = pg_temp.d1_a_binding() and version = 2;
set local session_replication_role = origin;
select pg_temp.base_assert(not pg_temp.d1_listed(), 'the first sponsor version''s work did not wait: ' || pg_temp.d1_due()::text);

select set_config('qorpera_test.d1_post_b', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000032', 'And yours?', pg_temp.d1_b_binding(), 1) ->> 0, true) \g /dev/null
do $$
declare v_pass jsonb;
begin
	perform pg_temp.base_assert(pg_temp.d1_listed(), 'work with room is not due beside work at a limit: ' || pg_temp.d1_due()::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert((pg_temp.d1_wake('d1_post_b')).status = 'materialized', 'the post on B did not go on: ' || v_pass::text);
	perform pg_temp.base_assert((pg_temp.d1_wake('d1_post_1')).status = 'queued' and (pg_temp.d1_wake('d1_post_2')).status = 'queued',
		'the posts on A did not wait');
	perform pg_temp.base_assert(not pg_temp.d1_listed(), 'work at a limit is due again: ' || pg_temp.d1_due()::text);
end $$;

-- A reading of A with room ends the wait: the company is due again and the waiting work goes on, on A.
update public.qorpera_native_provider_account_metadata
set provider_account_usage = jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
	'windows', jsonb_build_array(pg_temp.d1_window(35)))
where connection_id = pg_temp.d1_a() and connection_version = 2;
do $$
declare v_pass jsonb;
begin
	perform pg_temp.base_assert(pg_temp.d1_listed(), 'work on a login with room is not due: ' || pg_temp.d1_due()::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert((pg_temp.d1_wake('d1_post_1')).status = 'materialized'
		and (pg_temp.d1_wake('d1_post_1')).sponsor_binding_id = pg_temp.d1_a_binding()
		and not exists (select 1 from public.qorpera_session_turn_requests
			where profile_id = '92400000-0000-4000-8000-000000000010' and status = 'queued'
				and sponsor_binding_id = pg_temp.d1_a_binding()),
		'the waiting work did not go on: ' || v_pass::text);
end $$;

-- The new helpers are the database's own, as the others are.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_native_account_window_room(uuid,bigint)',
		'public.qorpera_folder_due_sponsor_waits(uuid,bigint)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and not has_function_privilege('service_role', v_fn, 'execute')
			and not has_function_privilege('qorpera_secret_broker', v_fn, 'execute'), v_fn || ' is postgres-only');
	end loop;
end $$;

rollback;
