-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Stateless Compute step 1, vault upkeep, on folder-v2: the vault renews idle logins itself, and only its own company's
-- broker takes one. The service role cannot take a login or its idle lock; a forged capability is refused; another
-- company's broker gets no login of this company, nor the lock; a login is taken only while it is behind an active
-- pointer to itself on an active, authorized connection of its own company (a revoked pointer, a disabled or revoked
-- connection, a revoked connection version, a pointer naming another login or a connection of another company are no
-- candidates). The logins belong to 924's owner (ported from snapshot-v1 in the legacy sweep).

insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('69400000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test',
	'company-kek-2', repeat('c', 64));
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('69400000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('69400000-0000-4000-8000-000000000041', '69400000-0000-4000-8000-000000000010', 'https://other.qorpera.test', 'other-kek-1', repeat('d', 64));

create function pg_temp.mk_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
-- The owner's vault login `p_login` (its own pointer capsule and connection, as a sign-in makes them, copied from the
-- owner's node connection), `p_used` into a pass that has `p_left` to run; answers the new connection.
create function pg_temp.mk_login(p_login uuid, p_capsule uuid, p_client_connection uuid, p_broker uuid,
	p_used interval, p_left interval)
returns uuid language plpgsql as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_connection uuid;
	v_now timestamptz := clock_timestamp();
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
		owner_scope_key, provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values (p_capsule, v_identity.profile_id, v_identity.id, v_identity.ownership_kind, v_identity.owner_user_id,
		v_identity.owner_scope_key, 'openai', 'codex-cli', 'model-login/' || p_login::text, repeat('a', 64), v_identity.owner_user_id);
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at)
	values (p_login, v_identity.profile_id, v_identity.id, p_capsule, p_broker, 'openai', 'codex-cli', 1, v_now - p_used, v_now + p_left);
	insert into public.qorpera_model_login_versions(login_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, origin, access_issued_at, access_expires_at)
	values (p_login, 1, p_broker, 'company-kek-1', convert_to('envelope-' || p_login::text, 'utf8'),
		encode(sha256(convert_to('envelope-' || p_login::text, 'utf8')), 'hex'), 'sign_in', v_now - p_used, v_now + p_left);
	insert into public.qorpera_provider_connections(profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
	values (v_identity.profile_id, p_client_connection, v_identity.owner_user_id, 'openai', v_identity.owner_user_id)
	returning id into v_connection;
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, provider_account_reference, provider_account_email, billing_source, consent_version,
		consented_by_user_id, allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency)
	select v_connection, 1, 'native_subscription', 'codex-cli', null, null, null, 'personal_subscription',
		'qorpera-native-subscription-v1', v_identity.owner_user_id, false, previous.commercial_approval_reference,
		previous.quota_policy, v_identity.owner_user_id, p_capsule, 'active', previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
	order by previous.version desc limit 1;
	return v_connection;
end $$;
create function pg_temp.mk_take(p_authority uuid, p_capability text)
returns text language plpgsql as $$
begin
	return public.qorpera_take_idle_model_login_renewal(p_authority, p_capability)::text;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.mk_taken()
returns text language sql as $$
	select coalesce(pg_temp.mk_take('69400000-0000-4000-8000-000000000040', repeat('c', 64))::jsonb ->> 'loginId', 'none')
$$;
grant execute on function pg_temp.mk_expect(text,text,text), pg_temp.mk_take(uuid,text), pg_temp.mk_taken()
	to qorpera_secret_broker, service_role;

-- 1. The service role can neither take an idle renewal nor its lock.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_take_idle_model_login_renewal(uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_model_login_take_idle_lock(uuid,uuid)', 'execute') then
		raise exception 'Idle renewal is exposed to service_role'; end if;
end $$;

-- 2. A: 6 of 10 days used (due). B: more urgent, but its pointer is revoked (the member disconnected it). D: more urgent
-- than A, but its connection is disabled. E: the most urgent, but another company's broker's.
select set_config('qorpera_test.mk_a', pg_temp.mk_login('69400000-0000-4000-8000-0000000000a1',
	'69400000-0000-4000-8000-0000000000a2', '69400000-0000-4000-8000-0000000000a3', '69400000-0000-4000-8000-000000000040',
	interval '6 days', interval '4 days')::text, true);
select set_config('qorpera_test.mk_b', pg_temp.mk_login('69400000-0000-4000-8000-0000000000b1',
	'69400000-0000-4000-8000-0000000000b2', '69400000-0000-4000-8000-0000000000b3', '69400000-0000-4000-8000-000000000040',
	interval '8 days', interval '2 days')::text, true);
select set_config('qorpera_test.mk_d', pg_temp.mk_login('69400000-0000-4000-8000-0000000000d1',
	'69400000-0000-4000-8000-0000000000d2', '69400000-0000-4000-8000-0000000000d3', '69400000-0000-4000-8000-000000000040',
	interval '7 days', interval '3 days')::text, true);
select set_config('qorpera_test.mk_e', pg_temp.mk_login('69400000-0000-4000-8000-0000000000e1',
	'69400000-0000-4000-8000-0000000000e2', '69400000-0000-4000-8000-0000000000e3', '69400000-0000-4000-8000-000000000041',
	interval '9 days', interval '1 day')::text, true);
update public.qorpera_native_credential_capsules set status = 'revoked', revoked_at = clock_timestamp()
where id = '69400000-0000-4000-8000-0000000000b2';
update public.qorpera_provider_connections set status = 'disabled'
where id = current_setting('qorpera_test.mk_d')::uuid;

set local session authorization qorpera_secret_broker;
select pg_temp.mk_expect(pg_temp.mk_take('69400000-0000-4000-8000-000000000040', repeat('e', 64)),
	'42501:cloud secret broker authority is unavailable', 'a forged capability');
select pg_temp.mk_expect(pg_temp.mk_take('69400000-0000-4000-8000-000000000041', repeat('d', 64)),
	'{"schema": "qorpera.model-login-idle-renewal/v1", "renewal": null}',
	'a login of another company is not that company''s broker''s');
select pg_temp.mk_expect(pg_temp.mk_taken(), '69400000-0000-4000-8000-0000000000a1',
	'the most urgent due login behind an active pointer and connection');
reset session authorization;

-- 3. A is now locked for its renewal. H: due, then shown no candidate for four reasons, each repaired before the next:
-- its connection is revoked (the member left); its connection version is no longer authorized; its pointer names
-- another login; its connection belongs to another company. Repaired, it is taken.
select set_config('qorpera_test.mk_h', pg_temp.mk_login('69400000-0000-4000-8000-0000000000f1',
	'69400000-0000-4000-8000-0000000000f2', '69400000-0000-4000-8000-0000000000f3', '69400000-0000-4000-8000-000000000040',
	interval '8 days', interval '2 days')::text, true);
update public.qorpera_provider_connections set status = 'revoked' where id = current_setting('qorpera_test.mk_h')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mk_expect(pg_temp.mk_taken(), 'none', 'a login whose connection is revoked');
reset session authorization;
update public.qorpera_provider_connections set status = 'active' where id = current_setting('qorpera_test.mk_h')::uuid;
update public.qorpera_provider_connection_versions set authorization_state = 'revoked'
where connection_id = current_setting('qorpera_test.mk_h')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mk_expect(pg_temp.mk_taken(), 'none', 'a login whose connection version is not authorized');
reset session authorization;
update public.qorpera_provider_connection_versions set authorization_state = 'active'
where connection_id = current_setting('qorpera_test.mk_h')::uuid;
update public.qorpera_native_credential_capsules
set encrypted_capsule_reference = 'model-login/69400000-0000-4000-8000-0000000000ff'
where id = '69400000-0000-4000-8000-0000000000f2';
set local session authorization qorpera_secret_broker;
select pg_temp.mk_expect(pg_temp.mk_taken(), 'none', 'a pointer that names another login');
reset session authorization;
update public.qorpera_native_credential_capsules
set encrypted_capsule_reference = 'model-login/69400000-0000-4000-8000-0000000000f1'
where id = '69400000-0000-4000-8000-0000000000f2';
update public.qorpera_provider_connections set profile_id = '69400000-0000-4000-8000-000000000010'
where id = current_setting('qorpera_test.mk_h')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mk_expect(pg_temp.mk_taken(), 'none', 'a connection of another company');
reset session authorization;
update public.qorpera_provider_connections set profile_id = '92400000-0000-4000-8000-000000000010'
where id = current_setting('qorpera_test.mk_h')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mk_expect(pg_temp.mk_taken(), '69400000-0000-4000-8000-0000000000f1', 'repaired, the login is taken');
reset session authorization;

-- 4. The lock itself, as the take re-checks it on the row: another company's broker never takes it; the login's own
-- broker gets a new token for a free, due login.
update public.qorpera_model_logins set renewal_token = null, renewal_until = null
where id = '69400000-0000-4000-8000-0000000000f1';
select pg_temp.mk_expect(public.qorpera_model_login_take_idle_lock('69400000-0000-4000-8000-0000000000f1',
	'69400000-0000-4000-8000-000000000041')::text, null, 'another company''s broker never takes the lock');
select set_config('qorpera_test.mk_lock', coalesce(public.qorpera_model_login_take_idle_lock(
	'69400000-0000-4000-8000-0000000000f1', '69400000-0000-4000-8000-000000000040')::text, 'none'), true);
select pg_temp.mk_expect((select renewal_token::text from public.qorpera_model_logins
	where id = '69400000-0000-4000-8000-0000000000f1'), current_setting('qorpera_test.mk_lock'),
	'a free, due login gets a new token from its own broker');

rollback;
