-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.uw_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_turn_waits_on_usage: %', p_message;
	end if;
end $$;

create function pg_temp.uw_company() returns uuid language sql as $$
	select (current_setting('qorpera_test.claim')::jsonb ->> 'profileId')::uuid
$$;
create function pg_temp.uw_anna() returns uuid language sql as $$ select '85600000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.uw_bo() returns uuid language sql as $$ select '85600000-0000-4000-8000-000000000002'::uuid $$;

create function pg_temp.uw_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.uw_usage(p_user_id uuid, p_used numeric)
returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	select c.id, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
		'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Week', 'usedPercent', p_used,
			'resetAt', to_char((statement_timestamp() + interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
	from public.qorpera_provider_connections c
	where c.profile_id = pg_temp.uw_company() and c.owner_user_id = p_user_id
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;

create function pg_temp.uw_payer(p_binding uuid) returns uuid language sql as $$
	select created_by_user_id from public.qorpera_execution_sponsor_bindings where id = p_binding
$$;

create function pg_temp.uw_session(p_session uuid) returns public.qorpera_surface_sessions language sql as $$
	select * from public.qorpera_surface_sessions where id = p_session
$$;

create function pg_temp.uw_claim(p_session uuid)
returns uuid language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;
	select (elem ->> 'leaseToken')::uuid into v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = p_session;
	return v_lease;
end $$;

create function pg_temp.uw_enqueue(p_session uuid, p_lease uuid)
returns jsonb language plpgsql as $$
declare
	v_result jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_enqueue_session_run(p_session, p_lease);
	reset role;
	return v_result;
end $$;

create function pg_temp.uw_turn(p_session uuid)
returns jsonb language plpgsql as $$
declare
	v_lease uuid := pg_temp.uw_claim(p_session);
begin
	perform pg_temp.uw_assert(v_lease is not null, 'the session is claimed for its turn');
	return pg_temp.uw_enqueue(p_session, v_lease);
end $$;

create function pg_temp.uw_reply(p_user_id uuid, p_session uuid, p_text text)
returns void language plpgsql as $$
begin
	perform pg_temp.uw_as(p_user_id);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(p_session, p_text, true);
	reset role;
end $$;

create function pg_temp.uw_json(p_user_id uuid, p_session uuid)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.uw_as(p_user_id);
	return public.qorpera_surface_session_json(pg_temp.uw_session(p_session));
end $$;

create function pg_temp.uw_due(p_session uuid)
returns void language sql as $$
	update public.qorpera_surface_sessions set lease_expires_at = clock_timestamp() - interval '1 second' where id = p_session
$$;

create function pg_temp.uw_wakes_not_paid_by(p_session uuid, p_user_id uuid)
returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences w
	where w.source_kind = 'surface-session' and w.source_id = p_session
		and pg_temp.uw_payer(w.sponsor_binding_id) is distinct from p_user_id
$$;

create function pg_temp.uw_failed_lines(p_session uuid)
returns bigint language sql as $$
	select count(*) from public.qorpera_surface_session_messages
	where session_id = p_session and author_kind = 'system'
$$;

create function pg_temp.uw_materialize()
returns void language plpgsql as $$
begin
	perform pg_temp.as_service();
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform public.qorpera_folder_materialize_company(pg_temp.uw_company(), 16);
end $$;

create function pg_temp.uw_login(p_capsule_n integer) returns uuid language sql as $$
	select version.connection_id from public.qorpera_provider_connection_versions as version
	where version.credential_capsule_id = ('85600000-0000-4000-8000-000000000a' || lpad(to_hex(p_capsule_n), 2, '0'))::uuid
	limit 1
$$;

create function pg_temp.uw_login_usage(p_connection uuid, p_used numeric)
returns void language sql as $$
	update public.qorpera_native_provider_account_metadata
	set provider_account_usage = jsonb_set(jsonb_set(provider_account_usage, '{windows,0,usedPercent}', to_jsonb(p_used)),
		'{observedAt}', to_jsonb(statement_timestamp() - interval '1 minute'))
	where connection_id = p_connection and connection_version = 2
$$;

create function pg_temp.uw_second_login(p_user uuid, p_identity_n integer, p_n integer)
returns void language plpgsql as $$
declare v_identity jsonb; v_login jsonb; v_connection jsonb; v_hex text := lpad(to_hex(p_n), 2, '0');
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity(pg_temp.uw_company(),
		('85600000-0000-4000-8000-0000000007' || lpad(to_hex(p_identity_n), 2, '0'))::uuid,
		'My model account', 'qorpera-member-linux', 'v1', '["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login(pg_temp.uw_company(), ('85600000-0000-4000-8000-0000000008' || v_hex)::uuid,
		('85600000-0000-4000-8000-0000000009' || v_hex)::uuid, (v_identity ->> 'compute_identity_id')::uuid,
		'openai', 'codex-cli', repeat(v_hex, 32), 900);
	reset role;
	perform pg_temp.as_service();
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid, repeat(v_hex, 32),
		('85600000-0000-4000-8000-000000000a' || v_hex)::uuid,
		'object://native-capsules/85600000-0000-4000-8000-000000000a' || v_hex, repeat('d', 64), 'openai-' || v_hex,
		'personal-subscription', 'qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions v
	where connection_id = (v_connection ->> 'connection_id')::uuid and version = 1;
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	perform public.qorpera_create_member_execution_sponsor(pg_temp.uw_company(), ('85600000-0000-4000-8000-000000000b' || v_hex)::uuid,
		(v_connection ->> 'connection_id')::uuid, 2, true);
	reset role;
end $$;

create function pg_temp.uw_paid_with(p_binding uuid) returns uuid language sql as $$
	select provider_connection_id from public.qorpera_execution_sponsor_versions
	where binding_id = p_binding order by version desc limit 1
$$;

do $$
declare
	v_surface uuid;
	v_session uuid;
	v_enq jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform pg_temp.uw_as(pg_temp.uw_anna());
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(pg_temp.uw_company(), 'Identity', 'identity', 'studio', 'identity', 'spark',
		'#7c5cff', 'identity', null, true) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Warm the accent', 'Accent') ->> 'id')::uuid;
	reset role;
	perform set_config('uw.surface', v_surface::text, false);
	perform set_config('uw.session', v_session::text, false);
	update public.qorpera_surface_sessions set state = 'ready' where id = v_session;

	perform pg_temp.uw_reply(pg_temp.uw_bo(), v_session, 'Make it a little darker');
	v_enq := pg_temp.uw_turn(v_session);
	perform pg_temp.uw_assert(v_enq ->> 'status' = 'enqueued', 'Bo''s turn starts while his login has room: ' || v_enq::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.uw_assert(pg_temp.uw_payer(v_wake.sponsor_binding_id) = pg_temp.uw_bo(), 'Bo''s turn is paid by Bo');
	perform pg_temp.uw_materialize();
	perform pg_temp.uw_assert(
		(select status from public.qorpera_wake_occurrences where id = v_wake.id) = 'materialized',
		'Bo''s turn runs'
	);
	perform set_config('uw.lease', (pg_temp.uw_session(v_session)).lease_token::text, false);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 100);

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	perform pg_temp.uw_assert(
		public.qorpera_native_account_remaining(
			(select id from public.qorpera_provider_connections where profile_id = pg_temp.uw_company() and owner_user_id = pg_temp.uw_bo()),
			2) = 0,
		'the fixture puts Bo''s only login at its limit'
	);
	perform pg_temp.uw_due(v_session);
	perform pg_temp.uw_claim(v_session);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'running' and v_row.retry_count = 0 and v_row.wake_id is not null
			and v_row.lease_token = current_setting('uw.lease')::uuid
			and v_row.lease_expires_at > clock_timestamp()
			and v_row.waiting_on_usage_user_id = pg_temp.uw_bo()
			and abs(extract(epoch from v_row.waiting_on_usage_until - (clock_timestamp() + interval '2 hours'))) < 300
			and pg_temp.uw_failed_lines(v_session) = 0,
		'the claim lane''s sweep leaves a paused turn on its full login running and records the wait: ' || to_jsonb(v_row)::text
	);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 30);

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	perform pg_temp.uw_due(v_session);
	perform pg_temp.uw_claim(v_session);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'running' and v_row.retry_count = 0 and v_row.lease_token = current_setting('uw.lease')::uuid
			and v_row.lease_expires_at > clock_timestamp() + interval '9 minutes'
			and (select status from public.qorpera_wake_occurrences where id = v_row.wake_id) = 'materialized'
			and pg_temp.uw_failed_lines(v_session) = 0
			and pg_temp.uw_json(pg_temp.uw_anna(), v_session) -> 'waitingOnUsage' = 'null'::jsonb,
		'at the reset the sweep gives the paused turn a grace lease instead of expiring it: ' || to_jsonb(v_row)::text
	);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 100);

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_row public.qorpera_surface_sessions%rowtype := pg_temp.uw_session(current_setting('uw.session')::uuid);
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_session_turn(v_session, 'failed', 'The login reached its usage limit.',
		null, null, null, v_row.lease_token);
	reset role;
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'queued' and v_row.retry_count = 0 and v_row.wake_id is null and v_row.lease_token is null
			and v_row.lease_expires_at > clock_timestamp()
			and v_row.waiting_on_usage_user_id = pg_temp.uw_bo()
			and pg_temp.uw_failed_lines(v_session) = 0,
		'a turn that stops at the limit waits instead of failing or spending its retry: ' || to_jsonb(v_row)::text
	);
	perform pg_temp.uw_assert(pg_temp.uw_claim(v_session) is null, 'a waiting turn is not claimed before its recheck');
end $$;

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_enq jsonb;
	v_row public.qorpera_surface_sessions%rowtype;
	v_json jsonb;
	v_wakes bigint := (select count(*) from public.qorpera_wake_occurrences where source_kind = 'surface-session' and source_id = v_session);
	v_errcode text;
begin
	perform pg_temp.uw_reply(pg_temp.uw_bo(), v_session, 'Can the prices be bold on mobile too?');
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'queued' and v_row.turn_requested_by_user_id = pg_temp.uw_bo() and v_row.waiting_on_usage_user_id is null
			and exists (select 1 from public.qorpera_surface_session_messages
				where session_id = v_session and author_user_id = pg_temp.uw_bo() and body = 'Can the prices be bold on mobile too?'),
		'a member whose only login is full can still reply, and the reply is kept'
	);

	v_enq := pg_temp.uw_turn(v_session);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_enq ->> 'status' = 'deferred' and v_enq ->> 'reason' = 'usage_limit'
			and abs(extract(epoch from (v_enq ->> 'resetsAt')::timestamptz - (clock_timestamp() + interval '2 hours'))) < 300
			and (v_enq ->> 'retryAfterSeconds')::integer between 59 and 901,
		'the enqueue defers for the usage limit with the reset time: ' || v_enq::text
	);
	perform pg_temp.uw_assert(
		v_row.state = 'queued' and v_row.wake_id is null and v_row.lease_token is null and v_row.retry_count = 0
			and v_row.lease_expires_at > clock_timestamp()
			and v_row.waiting_on_usage_user_id = pg_temp.uw_bo() and v_row.waiting_on_usage_until is not null,
		'the session records that it waits on Bo''s login: ' || to_jsonb(v_row)::text
	);
	perform pg_temp.uw_assert(
		(select count(*) from public.qorpera_wake_occurrences where source_kind = 'surface-session' and source_id = v_session) = v_wakes
			and pg_temp.uw_wakes_not_paid_by(v_session, pg_temp.uw_bo()) = 0,
		'no wake is made for the waiting turn and no wake of Bo''s turns is paid by anyone else'
	);

	v_json := pg_temp.uw_json(pg_temp.uw_bo(), v_session);
	perform pg_temp.uw_assert(
		(v_json -> 'waitingOnUsage' ->> 'userId')::uuid = pg_temp.uw_bo()
			and (v_json -> 'waitingOnUsage' ->> 'until')::timestamptz = v_row.waiting_on_usage_until
			and v_json -> 'waitingOnUsage' -> 'continueWith' = 'null'::jsonb,
		'the session JSON shows Bo the wait, with no other login to continue on: ' || coalesce(v_json -> 'waitingOnUsage', 'null')::text
	);
	v_json := pg_temp.uw_json(pg_temp.uw_anna(), v_session);
	perform pg_temp.uw_assert(
		(v_json -> 'waitingOnUsage' ->> 'userId')::uuid = pg_temp.uw_bo()
			and v_json -> 'waitingOnUsage' -> 'continueWith' = 'null'::jsonb,
		'Anna sees that the session waits on Bo, with nothing to continue'
	);

	v_errcode := null;
	perform pg_temp.uw_as(pg_temp.uw_bo());
	set local role authenticated;
	begin
		perform public.qorpera_surface_session_continue(v_session);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.uw_assert(v_errcode = '55000', 'Bo cannot continue while none of his logins has room');
	v_errcode := null;
	perform pg_temp.uw_as(pg_temp.uw_anna());
	set local role authenticated;
	begin
		perform public.qorpera_surface_session_continue(v_session);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	perform pg_temp.uw_assert(v_errcode = '42501', 'only the waiting member may continue the session');

	perform pg_temp.uw_due(v_session);
	v_enq := pg_temp.uw_turn(v_session);
	perform pg_temp.uw_assert(
		v_enq ->> 'reason' = 'usage_limit' and pg_temp.uw_wakes_not_paid_by(v_session, pg_temp.uw_bo()) = 0,
		'at its recheck the turn waits again, still on Bo''s login: ' || v_enq::text
	);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'queued' and v_row.retry_count = 0 and pg_temp.uw_failed_lines(v_session) = 0,
		'waiting never spends the retry or posts a failure: ' || to_jsonb(v_row)::text
	);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 30);

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_enq jsonb;
	v_row public.qorpera_surface_sessions%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.uw_assert((pg_temp.uw_session(v_session)).waiting_on_usage_user_id = pg_temp.uw_bo(), 'the turn still waits before its recheck');
	perform pg_temp.uw_due(v_session);
	v_enq := pg_temp.uw_turn(v_session);
	perform pg_temp.uw_assert(v_enq ->> 'status' = 'enqueued', 'after the reset the waiting turn starts with no click: ' || v_enq::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		pg_temp.uw_payer(v_wake.sponsor_binding_id) = pg_temp.uw_bo() and v_wake.requested_by_user_id = pg_temp.uw_bo()
			and v_row.waiting_on_usage_user_id is null and v_row.waiting_on_usage_until is null
			and pg_temp.uw_json(pg_temp.uw_anna(), v_session) -> 'waitingOnUsage' = 'null'::jsonb
			and pg_temp.uw_wakes_not_paid_by(v_session, pg_temp.uw_bo()) = 0,
		'the turn runs on Bo''s own login and the wait is gone'
	);
	update public.qorpera_wake_occurrences
	set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'turn settled by the test'
	where id = v_wake.id and status = 'queued';
	update public.qorpera_surface_sessions
	set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null
	where id = v_session;
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 100);

do $$
declare
	v_session uuid;
	v_enq jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.uw_as(pg_temp.uw_anna());
	set local role authenticated;
	v_session := (public.qorpera_start_surface_session(current_setting('uw.surface')::uuid, 'Tighten the spacing', 'Spacing') ->> 'id')::uuid;
	reset role;
	update public.qorpera_surface_sessions set state = 'ready' where id = v_session;
	perform pg_temp.uw_reply(pg_temp.uw_anna(), v_session, 'A bit more');
	v_enq := pg_temp.uw_turn(v_session);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.uw_assert(
		v_enq ->> 'status' = 'enqueued' and pg_temp.uw_payer(v_wake.sponsor_binding_id) = pg_temp.uw_anna()
			and (pg_temp.uw_session(v_session)).waiting_on_usage_user_id is null
			and pg_temp.uw_json(pg_temp.uw_anna(), v_session) -> 'waitingOnUsage' = 'null'::jsonb,
		'a member with a payable login is unaffected: ' || v_enq::text
	);
	update public.qorpera_wake_occurrences
	set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'turn settled by the test'
	where id = v_wake.id and status = 'queued';
	update public.qorpera_surface_sessions
	set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null
	where id = v_session;
end $$;

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_enq jsonb;
begin
	perform pg_temp.uw_reply(pg_temp.uw_bo(), v_session, 'And the yearly plan');
	v_enq := pg_temp.uw_turn(v_session);
	perform pg_temp.uw_assert(
		v_enq ->> 'reason' = 'usage_limit'
			and pg_temp.uw_json(pg_temp.uw_bo(), v_session) -> 'waitingOnUsage' -> 'continueWith' = 'null'::jsonb,
		'with every login full there is nothing to continue on: ' || v_enq::text
	);
end $$;

select pg_temp.uw_second_login(pg_temp.uw_bo(), 2, 31);

do $$
declare
	v_session uuid := current_setting('uw.session')::uuid;
	v_enq jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.uw_assert(
		pg_temp.uw_json(pg_temp.uw_bo(), v_session) -> 'waitingOnUsage' -> 'continueWith' <> 'null'::jsonb
			and pg_temp.uw_json(pg_temp.uw_anna(), v_session) -> 'waitingOnUsage' -> 'continueWith' = 'null'::jsonb,
		'Bo, and only Bo, is offered his login with room'
	);
	perform pg_temp.uw_as(pg_temp.uw_bo());
	set local role authenticated;
	perform public.qorpera_surface_session_continue(v_session);
	reset role;
	v_enq := pg_temp.uw_turn(v_session);
	perform pg_temp.uw_assert(v_enq ->> 'status' = 'enqueued', 'Continue lets the turn start at once: ' || v_enq::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.uw_assert(
		pg_temp.uw_payer(v_wake.sponsor_binding_id) = pg_temp.uw_bo()
			and pg_temp.uw_paid_with(v_wake.sponsor_binding_id) = pg_temp.uw_login(31),
		'the continued turn runs on Bo''s login with room'
	);
	update public.qorpera_wake_occurrences
	set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'turn settled by the test'
	where id = v_wake.id and status = 'queued';
	update public.qorpera_surface_sessions
	set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null
	where id = v_session;
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 100);

do $$
declare
	v_env uuid;
	v_surface uuid;
	v_session uuid;
	v_enq jsonb;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	select environment_id into strict v_env from public.qorpera_company_cofounders where profile_id = pg_temp.uw_company();
	perform pg_temp.as_service();
	perform public.qorpera_configure_coding_executor(v_env, 'exec-1355', true, array['codex', 'claude-code']);

	perform pg_temp.uw_as(pg_temp.uw_anna());
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(pg_temp.uw_company(), 'Website', 'website', 'live_build', 'website', 'globe',
		'#0a84ff', null, null, false) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Whole kroner prices', 'Prices') ->> 'id')::uuid;
	reset role;
	perform set_config('uw.code_session', v_session::text, false);
	update public.qorpera_surface_sessions set state = 'ready' where id = v_session;

	perform pg_temp.uw_reply(pg_temp.uw_bo(), v_session, 'Bold on mobile too');
	v_enq := pg_temp.uw_turn(v_session);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_enq ->> 'status' = 'deferred' and v_enq ->> 'reason' = 'usage_limit'
			and v_row.state = 'queued' and v_row.worker_id is null and v_row.waiting_on_usage_user_id = pg_temp.uw_bo()
			and not exists (select 1 from public.qorpera_runtime_workers where surface_session_id = v_session)
			and pg_temp.uw_json(pg_temp.uw_bo(), v_session) -> 'waitingOnUsage' -> 'continueWith' = 'null'::jsonb,
		'a coding turn on full logins waits before any worker starts: ' || v_enq::text
	);
end $$;

select pg_temp.uw_login_usage(pg_temp.uw_login(31), 30);

do $$
declare
	v_session uuid := current_setting('uw.code_session')::uuid;
	v_enq jsonb;
	v_worker public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.uw_assert(
		pg_temp.uw_json(pg_temp.uw_bo(), v_session) -> 'waitingOnUsage' -> 'continueWith' <> 'null'::jsonb,
		'Bo is offered the coding login the next turn would pay with, now that it has room'
	);
	perform pg_temp.uw_as(pg_temp.uw_bo());
	set local role authenticated;
	perform public.qorpera_surface_session_continue(v_session);
	reset role;
	v_enq := pg_temp.uw_turn(v_session);
	select * into strict v_worker from public.qorpera_runtime_workers where id = (v_enq ->> 'workerId')::uuid;
	perform pg_temp.uw_assert(
		v_enq ->> 'status' = 'enqueued' and v_worker.owner_user_id = pg_temp.uw_bo()
			and pg_temp.uw_payer(v_worker.owner_sponsor_binding_id) = pg_temp.uw_bo()
			and pg_temp.uw_paid_with(v_worker.owner_sponsor_binding_id) = pg_temp.uw_login(31)
			and (pg_temp.uw_session(v_session)).waiting_on_usage_user_id is null,
		'Continue starts the coding turn on Bo''s login with room: ' || v_enq::text
	);
	perform set_config('uw.worker', v_worker.id::text, false);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 100);

do $$
declare
	v_session uuid := current_setting('uw.code_session')::uuid;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '31 minutes'
	where worker_id = current_setting('uw.worker')::uuid;
	set local session_replication_role = origin;
	perform pg_temp.uw_due(v_session);
	perform pg_temp.uw_claim(v_session);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'running' and v_row.retry_count = 0 and v_row.waiting_on_usage_user_id = pg_temp.uw_bo()
			and v_row.lease_expires_at > clock_timestamp()
			and (select state from public.qorpera_runtime_workers where id = current_setting('uw.worker')::uuid) = 'active'
			and pg_temp.uw_failed_lines(v_session) = 0,
		'the coding sweep leaves a worker waiting on its full login alone: ' || to_jsonb(v_row)::text
	);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 30);

do $$
declare
	v_session uuid := current_setting('uw.code_session')::uuid;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	perform pg_temp.uw_due(v_session);
	perform pg_temp.uw_claim(v_session);
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'running' and v_row.retry_count = 0
			and v_row.lease_expires_at > clock_timestamp() + interval '9 minutes'
			and (select state from public.qorpera_runtime_workers where id = current_setting('uw.worker')::uuid) = 'active'
			and pg_temp.uw_failed_lines(v_session) = 0,
		'at the reset the coding sweep gives the waiting worker a grace lease instead of cancelling it: ' || to_jsonb(v_row)::text
	);
end $$;

select pg_temp.uw_usage(pg_temp.uw_bo(), 100);

do $$
declare
	v_session uuid := current_setting('uw.code_session')::uuid;
	v_lease uuid;
	v_row public.qorpera_surface_sessions%rowtype;
begin
	perform pg_temp.uw_reply(pg_temp.uw_anna(), v_session, 'Use the new font as well');
	v_lease := pg_temp.uw_claim(v_session);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_surface_complete_session_turn(v_session, 'failed', 'Surface session could not start.',
		null, null, null, v_lease);
	reset role;
	v_row := pg_temp.uw_session(v_session);
	perform pg_temp.uw_assert(
		v_row.state = 'queued' and v_row.retry_count = 1 and v_row.waiting_on_usage_user_id is null
			and pg_temp.uw_failed_lines(v_session) = 1,
		'an earlier turn''s worker on a full login does not hold Anna''s failed turn: ' || to_jsonb(v_row)::text
	);
	perform pg_temp.uw_assert(
		not has_function_privilege('authenticated', 'public.qorpera_surface_hold_for_usage(uuid,jsonb,boolean)', 'execute')
			and not has_function_privilege('anon', 'public.qorpera_surface_turn_usage_wait(uuid,uuid,uuid)', 'execute')
			and not has_function_privilege('authenticated', 'public.qorpera_surface_usage_grace(uuid)', 'execute')
			and not has_function_privilege('authenticated',
				'public.qorpera_surface_continue_login(public.qorpera_surface_sessions,uuid)', 'execute')
			and not has_function_privilege('anon', 'public.qorpera_surface_session_continue(uuid)', 'execute'),
		'the wait helpers are not callable from the API'
	);
end $$;
