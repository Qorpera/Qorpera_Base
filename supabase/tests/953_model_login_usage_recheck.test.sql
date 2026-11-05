-- @fixture 693_model_login_usage.test.sql until "-- 1. Privileges: the service role calls none of the usage functions."
-- The vault's daily usage check (20260930575000, founder decision 2026-11-05). Once a day, and once a known reset has
-- passed, the broker's upkeep asks for a login at its usage limit that is due a reading
-- (qorpera_begin_model_login_usage_recheck): it gets an account refresh of that member's identity, under its own
-- capability, and runs it as Settings → Refresh's (describe, record, complete). A login with room, or one read in the last
-- hour, is not due; another company's broker gets nothing; only the broker may ask. A reading with room ends the login's
-- wall. The fixture is 693's: a vault login (connection mu_connection, version 1) of 924's owner's identity, and a
-- pending refresh of that identity that has not ended.

create function pg_temp.rc_begin(p_authority uuid, p_capability text, p_secret text) returns text language plpgsql as $$
declare v_result text;
begin
	v_result := public.qorpera_begin_model_login_usage_recheck(p_authority, p_capability,
		encode(sha256(p_secret::bytea), 'hex'))::text;
	return v_result;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.rc_begin(uuid,text,text) to qorpera_secret_broker;
create function pg_temp.rc_usage(p_used numeric, p_observed interval, p_reset interval default null) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	values (current_setting('qorpera_test.mu_connection')::uuid, 1, jsonb_build_object('observedAt',
		statement_timestamp() - p_observed, 'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Weekly',
			'usedPercent', p_used) || case when p_reset is null then '{}'::jsonb
				else jsonb_build_object('resetAt', statement_timestamp() + p_reset) end)))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;

-- 0. Only the broker may ask; neither API role can.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_begin_model_login_usage_recheck(uuid,text,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_begin_model_login_usage_recheck(uuid,text,text)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_begin_model_login_usage_recheck(uuid,text,text)', 'execute')
		or not has_function_privilege('qorpera_secret_broker', 'public.qorpera_begin_model_login_usage_recheck(uuid,text,text)', 'execute') then
		raise exception 'The usage recheck is not the broker''s alone'; end if;
end $$;
select pg_temp.mu_expect(pg_temp.rc_begin('69300000-0000-4000-8000-000000000040', repeat('c', 64), 'recheck-0'),
	'42501:cloud secret broker authority is required', 'the owner of the tables is no broker');

-- The fixture's refresh of the identity ended long ago (so it is no refresh of the last hour); its row's guard is off
-- while it is moved back.
set local session_replication_role = replica;
update public.qorpera_native_account_refresh_requests set status = 'completed', created_at = clock_timestamp() - interval '2 hours',
	expires_at = clock_timestamp() - interval '2 hours' + interval '4 minutes', completed_at = clock_timestamp() - interval '2 hours'
where id = '69300000-0000-4000-8000-000000000201';
set local session_replication_role = origin;

-- 1. A login with room is not due.
select pg_temp.rc_usage(40, interval '3 days');
set local session authorization qorpera_secret_broker;
select pg_temp.mu_expect(pg_temp.rc_begin('69300000-0000-4000-8000-000000000040', repeat('c', 64), 'recheck-1')::jsonb ->> 'request',
	null, 'a login with room is due a reading');
reset session authorization;

-- 2. At its limit with a reading two days old: due. The broker gets a pending refresh of the owner's identity under its own
-- capability; another company's broker and a wrong capability get nothing; asking again within the hour gets nothing.
select pg_temp.rc_usage(100, interval '2 days', interval '3 days');
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.rc_request', pg_temp.rc_begin('69300000-0000-4000-8000-000000000040', repeat('c', 64),
	'recheck-2'), true);
select pg_temp.mu_expect(pg_temp.rc_begin('69300000-0000-4000-8000-000000000041', repeat('d', 64), 'recheck-3')::jsonb ->> 'request',
	null, 'another company''s broker');
select pg_temp.mu_expect(pg_temp.rc_begin('69300000-0000-4000-8000-000000000040', repeat('e', 64), 'recheck-4'),
	'42501:cloud secret broker authority is unavailable', 'a wrong broker capability');
select pg_temp.mu_expect(pg_temp.rc_begin('69300000-0000-4000-8000-000000000040', repeat('c', 64), 'recheck-5')::jsonb ->> 'request',
	null, 'asked again within the hour');
reset session authorization;
do $$
declare v_request jsonb := current_setting('qorpera_test.rc_request')::jsonb -> 'request';
	v_row public.qorpera_native_account_refresh_requests%rowtype;
begin
	if v_request is null or v_request = 'null'::jsonb then
		raise exception 'a login at its limit with an old reading was not due: %', current_setting('qorpera_test.rc_request'); end if;
	select * into strict v_row from public.qorpera_native_account_refresh_requests where id = (v_request ->> 'request_id')::uuid;
	if v_row.status <> 'pending' or v_row.compute_identity_id <> (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid
		or v_row.requested_by_user_id <> '92400000-0000-4000-8000-000000000001'
		or v_row.capability_sha256 <> encode(sha256('recheck-2'::bytea), 'hex')
		or v_row.expires_at > clock_timestamp() + interval '5 minutes' or v_request ->> 'status' <> 'pending' then
		raise exception 'the recheck''s refresh is wrong: %', to_jsonb(v_row); end if;
end $$;

-- 3. The broker runs it as Settings → Refresh's: it reads the login under the refresh's capability, records usage with room
-- and completes; the login is no longer due.
set local session authorization qorpera_secret_broker;
select pg_temp.mu_expect(pg_temp.mu_call(format($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), %L::uuid, encode(sha256('recheck-2'::bytea), 'hex'))
	-> 'logins' -> 0 ->> 'encryptedEnvelopeBase64'$q$, current_setting('qorpera_test.rc_request')::jsonb #>> '{request,request_id}')),
	encode('envelope-one'::bytea, 'base64'), 'the broker reads the login for the recheck');
select pg_temp.mu_expect(pg_temp.mu_call(format($q$select public.qorpera_record_model_login_account_metadata(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), %L::uuid, encode(sha256('recheck-2'::bytea), 'hex'),
	'69300000-0000-4000-8000-000000000050', %L::uuid, 1, 'member@example.test', jsonb_build_object('observedAt', clock_timestamp(),
		'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Weekly', 'usedPercent', 30))), repeat('e', 64))::text$q$,
	current_setting('qorpera_test.rc_request')::jsonb #>> '{request,request_id}', current_setting('qorpera_test.mu_connection'))),
	'true', 'the broker records the login''s usage');
select pg_temp.mu_expect(pg_temp.mu_call(format($q$select public.qorpera_complete_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), %L::uuid, encode(sha256('recheck-2'::bytea), 'hex'))::text$q$,
	current_setting('qorpera_test.rc_request')::jsonb #>> '{request,request_id}')), 'true', 'the broker completes the recheck');
reset session authorization;
select pg_temp.mu_expect(public.qorpera_native_account_usage_recheck_due(current_setting('qorpera_test.mu_connection')::uuid, 1)::text,
	'false', 'a login read with room is still due');

-- 4. At its limit with a fresh reading whose reset has not come: not due. Once that reset passed: due (an hour after the
-- last refresh).
select pg_temp.rc_usage(100, interval '1 minute', interval '2 hours');
select pg_temp.mu_expect(public.qorpera_native_account_usage_recheck_due(current_setting('qorpera_test.mu_connection')::uuid, 1)::text,
	'false', 'a fresh full reading before its reset');
select pg_temp.rc_usage(100, interval '3 hours', interval '-1 hour');
select pg_temp.mu_expect(public.qorpera_native_account_usage_recheck_due(current_setting('qorpera_test.mu_connection')::uuid, 1)::text,
	'true', 'a full reading whose reset passed');

rollback;
