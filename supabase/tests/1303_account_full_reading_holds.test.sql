-- @fixture 992_runtime_run_resume_pause.test.sql until "-- A usage reading of the login after its limit that shows room"

create function pg_temp.ah_id(p_kind integer, p_n integer) returns uuid language sql immutable as $$
	select ('1303' || lpad(p_kind::text, 4, '0') || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.ah_b() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
$$;
create function pg_temp.ah_binding() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
$$;
create function pg_temp.ah_identity() returns uuid language sql as $$
	select (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid
$$;
create function pg_temp.ah_connection(p_n integer) returns uuid language sql as $$
	select case when p_n = 0 then pg_temp.ah_b() else pg_temp.ah_id(1, p_n) end
$$;
create function pg_temp.ah_company_a(p_n integer, p_linked boolean default true) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, status,
		created_by_user_id)
	values (pg_temp.ah_id(1, p_n), pg_temp.ah_id(2, p_n), pg_temp.ah_id(4, p_n), '92400000-0000-4000-8000-000000000001',
		'openai', 'active', '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, billing_source, consent_version, consented_by_user_id, created_by_user_id, credential_capsule_id,
		authorization_state, max_native_concurrency, quota_policy)
	values (pg_temp.ah_id(1, p_n), 1, 'native_subscription', 'codex-cli', null, 'personal-subscription', 'ah-consent',
		'92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000001', pg_temp.ah_id(5, p_n), 'active', 1,
		'{"monthly_microusd":1000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	insert into public.qorpera_model_login_links(credential_capsule_id, login_id, profile_id, compute_identity_id, owner_user_id)
	select pg_temp.ah_id(5, p_n), pg_temp.ah_id(6, 1), pg_temp.ah_id(2, p_n), pg_temp.ah_id(7, p_n),
		'92400000-0000-4000-8000-000000000001'
	where p_linked;
	set local session_replication_role = origin;
end $$;
create function pg_temp.ah_delete_company_a(p_n integer) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	delete from public.qorpera_provider_connection_usage_signals where provider_connection_id = pg_temp.ah_id(1, p_n);
	delete from public.qorpera_native_provider_account_metadata where connection_id = pg_temp.ah_id(1, p_n);
	delete from public.qorpera_model_login_links where credential_capsule_id = pg_temp.ah_id(5, p_n);
	delete from public.qorpera_provider_connection_versions where connection_id = pg_temp.ah_id(1, p_n);
	delete from public.qorpera_provider_connections where id = pg_temp.ah_id(1, p_n);
	set local session_replication_role = origin;
end $$;
create function pg_temp.ah_reading(p_n integer, p_ago interval, p_used numeric, p_reset interval,
	p_identity text default repeat('e', 64)) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity,
		provider_account_usage)
	values (pg_temp.ah_connection(p_n), case when p_n = 0 then 2 else 1 end, p_identity,
		jsonb_build_object('observedAt', statement_timestamp() - p_ago,
		'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Weekly', 'usedPercent', p_used,
			'resetAt', to_char((statement_timestamp() + p_reset) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			'windowSeconds', 604800))))
	on conflict (connection_id, connection_version) do update
	set provider_account_identity = excluded.provider_account_identity, provider_account_usage = excluded.provider_account_usage
$$;
create function pg_temp.ah_wall() returns timestamptz language sql as $$
	select public.qorpera_native_account_usage_limit_reset(pg_temp.ah_b())
$$;
create function pg_temp.ah_near(p_at timestamptz, p_from_now interval) returns boolean language sql as $$
	select p_at is not null and abs(extract(epoch from p_at - (statement_timestamp() + p_from_now))) < 2
$$;
create function pg_temp.ah_text(p_at timestamptz) returns text language sql as $$
	select coalesce(p_at::text, 'none')
$$;
create function pg_temp.ah_held(p_from_now interval) returns boolean language sql as $$
	select pg_temp.ah_near(pg_temp.ah_wall(), p_from_now)
		and public.qorpera_native_account_remaining(pg_temp.ah_b(), 2) = 0
		and public.qorpera_sponsor_waits_for_usage_limit(pg_temp.ah_binding(), 1)
$$;
create function pg_temp.ah_free() returns boolean language sql as $$
	select pg_temp.ah_wall() is null and public.qorpera_native_account_remaining(pg_temp.ah_b(), 2) <> 0
		and not public.qorpera_sponsor_waits_for_usage_limit(pg_temp.ah_binding(), 1)
$$;
create function pg_temp.ah_post() returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.ah_post')::uuid
$$;

set local session_replication_role = replica;
insert into public.qorpera_model_login_links(credential_capsule_id, login_id, profile_id, compute_identity_id, owner_user_id)
select version.credential_capsule_id, pg_temp.ah_id(6, 1), '92400000-0000-4000-8000-000000000010', pg_temp.ah_identity(),
	'92400000-0000-4000-8000-000000000001'
from public.qorpera_provider_connection_versions as version where version.connection_id = pg_temp.ah_b() and version.version = 2;
update public.qorpera_provider_connection_usage_signals
set observed_at = statement_timestamp() - interval '1 hour', resets_at = null
where provider_connection_id = pg_temp.ah_b();
set local session_replication_role = origin;
select pg_temp.ah_company_a(1) \g /dev/null
set local session_replication_role = replica;
update public.qorpera_provider_connection_usage_signals
set provider_connection_id = pg_temp.ah_id(1, 1), provider_connection_version = 1
where provider_connection_id = pg_temp.ah_b();
set local session_replication_role = origin;
select pg_temp.base_assert((select count(*) = 1 from public.qorpera_account_login_sibling_connections(pg_temp.ah_b())),
	'B''s login has company A beside it');
savepoint ah_world;
select pg_temp.ah_reading(0, interval '2 hours', 70, interval '3 days') \g /dev/null
select pg_temp.ah_reading(1, interval '30 minutes', 100, interval '3 days') \g /dev/null
select set_config('qorpera_test.ah_post', pg_temp.base_post('92400000-0000-4000-8000-000000000001',
	'92400000-0000-4000-8000-000000000031', 'Are the numbers in?') ->> 0, true) \g /dev/null
select pg_temp.base_materialize() \g /dev/null

select pg_temp.base_assert(pg_temp.ah_held(interval '3 days') and (pg_temp.ah_post()).status = 'queued'
	and public.qorpera_release_paused_runs_with_room(pg_temp.ah_identity()) = 0,
	'A''s limit does not hold B: ' || pg_temp.ah_text(pg_temp.ah_wall()));

select pg_temp.ah_delete_company_a(1) \g /dev/null
select pg_temp.base_materialize() \g /dev/null
select pg_temp.base_assert(pg_temp.ah_held(interval '3 days') and (pg_temp.ah_post()).status = 'queued'
	and public.qorpera_release_paused_runs_with_room(pg_temp.ah_identity()) = 0,
	'deleting company A freed B: ' || pg_temp.ah_text(pg_temp.ah_wall()));

select pg_temp.ah_reading(0, interval '10 minutes', 100, interval '2 days') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_held(interval '2 days'),
	'a full reading did not keep the hold: ' || pg_temp.ah_text(pg_temp.ah_wall()));

select pg_temp.ah_reading(0, interval '0 seconds', 10, interval '7 days') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free(), 'a reading with room did not end the hold: ' || pg_temp.ah_text(pg_temp.ah_wall()));
select pg_temp.base_assert(public.qorpera_release_paused_runs_with_room(pg_temp.ah_identity()) = 1,
	'the paused run did not come back');
select pg_temp.base_materialize() \g /dev/null
select pg_temp.base_assert((pg_temp.ah_post()).status = 'materialized'
	and (select run.sponsor_binding_id = pg_temp.ah_binding() from public.qorpera_execution_runs as run
		where run.id = (pg_temp.ah_post()).run_id), 'the post did not go on, on B: ' || to_jsonb(pg_temp.ah_post())::text);

select pg_temp.ah_reading(0, interval '10 minutes', 100, interval '2 days') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free(), 'an older full reading held B');
update public.qorpera_native_account_usage_marks set full_observed_at = room_observed_at
where owner_user_id = '92400000-0000-4000-8000-000000000001';
select pg_temp.base_assert(pg_temp.ah_free(), 'a full reading at the same time as the room held B');
rollback to savepoint ah_world;

select pg_temp.ah_reading(0, interval '2 hours', 70, interval '3 days') \g /dev/null
select pg_temp.ah_reading(1, interval '90 minutes', 90, interval '3 days') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_near(pg_temp.ah_wall(), interval '5 hours'),
	'the limit after a reading at 90 % does not hold B for 6 hours: ' || pg_temp.ah_text(pg_temp.ah_wall()));
select pg_temp.ah_delete_company_a(1) \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free(), 'a login never full was held: ' || pg_temp.ah_text(pg_temp.ah_wall()));

set local session_replication_role = replica;
insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id, sponsor_version,
	provider_connection_id, provider_connection_version, provider, signal_kind, source, observed_at)
select connection.profile_id, extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.ah_binding(), 1,
	connection.id, 2, 'openai', 'rate_limited', 'native_adapter', statement_timestamp() - interval '1 minute'
from public.qorpera_provider_connections as connection where connection.id = pg_temp.ah_b();
set local session_replication_role = origin;
select pg_temp.base_assert(pg_temp.ah_free(), 'a rate limit held B');
select pg_temp.ah_reading(0, interval '1 minute', 100, interval '-1 minute') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free(), 'a full window that has reset held B');
select pg_temp.ah_company_a(2, false) \g /dev/null
select pg_temp.ah_reading(2, interval '1 minute', 100, interval '3 days', repeat('f', 64)) \g /dev/null
select pg_temp.ah_reading(0, interval '30 seconds', 70, interval '3 days') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free(), 'another account''s full reading held B');
set local session_replication_role = replica;
update public.qorpera_provider_connections set owner_user_id = '92400000-0000-4000-8000-000000000002'
where id = pg_temp.ah_id(1, 2);
set local session_replication_role = origin;
select pg_temp.ah_reading(2, interval '10 seconds', 100, interval '3 days') \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free(), 'another member''s full reading held B');
rollback to savepoint ah_world;

select pg_temp.base_assert(pg_temp.ah_near(pg_temp.ah_wall(), interval '5 hours'), 'a signal with no reading does not hold 6 hours');
select pg_temp.ah_delete_company_a(1) \g /dev/null
select pg_temp.base_assert(pg_temp.ah_free() and not exists (select 1 from public.qorpera_native_account_usage_marks
		where provider_account_identity = repeat('e', 64)), 'a signal with no reading left a hold');

select pg_temp.base_assert(not has_table_privilege(role_name, 'public.qorpera_native_account_usage_marks', 'select')
	and not has_table_privilege(role_name, 'public.qorpera_native_account_usage_marks', 'insert')
	and not has_table_privilege(role_name, 'public.qorpera_native_account_usage_marks', 'update')
	and not has_function_privilege(role_name, 'public.qorpera_note_native_account_reading(uuid,bigint,text,jsonb)', 'execute')
	and not has_function_privilege(role_name, 'public.qorpera_native_account_full_reading_hold(uuid)', 'execute')
	and not has_function_privilege(role_name, 'public.qorpera_native_account_reading_noted()', 'execute'),
	role_name || ' may reach the account marks')
from unnest(array['anon', 'authenticated', 'service_role']) as role_name;

rollback;
