-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Stateless Compute step 1 (change 2C) on folder-v2: the vault reads the usage of the logins it keeps, under an account
-- refresh's capability, through its company's broker alone. The service role cannot call the usage functions. Another
-- capability or another company's broker reads nothing; the broker records usage only for the connection version that
-- uses the login; a completed refresh hands out no login, and an expired refresh or a requester demoted to viewer reads
-- nothing. The login is a vault login of 924's owner's identity (ported from snapshot-v1 in the legacy sweep).

insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('69300000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('69300000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test', 'company-kek-1', repeat('c', 64)),
	('69300000-0000-4000-8000-000000000041', '69300000-0000-4000-8000-000000000010', 'https://other.qorpera.test', 'other-kek-1', repeat('d', 64));

create function pg_temp.mu_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.mu_call(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	return v_result;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.mu_expect(text,text,text), pg_temp.mu_call(text) to qorpera_secret_broker;

-- A pending account refresh of the owner's identity.
insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
	requested_by_user_id, capability_sha256, compute_recovery_epoch, created_at, expires_at)
select '69300000-0000-4000-8000-000000000201', identity.profile_id, '69300000-0000-4000-8000-000000000202', identity.id,
	identity.owner_user_id, encode(sha256('refresh-one'::bytea), 'hex'), identity.recovery_epoch,
	moment.at, moment.at + interval '4 minutes'
from public.qorpera_member_compute_identities identity, (select clock_timestamp() as at) moment
where identity.id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;

-- The owner's vault login: pointer capsule, login version 1, and a new connection whose version 1 uses it.
do $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_connection uuid;
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
		owner_scope_key, provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values ('69300000-0000-4000-8000-000000000060', v_identity.profile_id, v_identity.id, v_identity.ownership_kind,
		v_identity.owner_user_id, v_identity.owner_scope_key, 'openai', 'codex-cli', 'model-login/69300000-0000-4000-8000-000000000050',
		repeat('a', 64), v_identity.owner_user_id);
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at)
	values ('69300000-0000-4000-8000-000000000050', v_identity.profile_id, v_identity.id, '69300000-0000-4000-8000-000000000060',
		'69300000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '10 days');
	insert into public.qorpera_model_login_versions(login_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, origin, access_issued_at, access_expires_at)
	values ('69300000-0000-4000-8000-000000000050', 1, '69300000-0000-4000-8000-000000000040', 'company-kek-1', 'envelope-one'::bytea,
		encode(sha256('envelope-one'::bytea), 'hex'), 'sign_in', clock_timestamp(), clock_timestamp() + interval '10 days');
	insert into public.qorpera_provider_connections(profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
	values (v_identity.profile_id, '69300000-0000-4000-8000-000000000080', v_identity.owner_user_id, 'openai', v_identity.owner_user_id)
	returning id into v_connection;
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, provider_account_reference, provider_account_email, billing_source, consent_version,
		consented_by_user_id, allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency)
	select v_connection, 1, 'native_subscription', 'codex-cli', null, null, null, 'personal_subscription',
		'qorpera-native-subscription-v1', v_identity.owner_user_id, false, previous.commercial_approval_reference,
		previous.quota_policy, v_identity.owner_user_id, '69300000-0000-4000-8000-000000000060', 'active', previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
	order by previous.version desc limit 1;
	perform set_config('qorpera_test.mu_connection', v_connection::text, true);
end $$;

-- 1. Privileges: the service role calls none of the usage functions.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_describe_model_login_account_refresh(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_record_model_login_account_metadata(uuid,text,uuid,text,uuid,uuid,bigint,text,jsonb,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_complete_model_login_account_refresh(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_model_login_account_refresh(uuid,text,uuid,text)', 'execute') then
		raise exception 'Vault usage is exposed to service_role'; end if;
end $$;

-- 2. The broker reads the login's current version under the refresh's capability; another capability and another
-- company's broker read nothing. It records usage for the connection version that uses the login, not for another
-- version, and completes the refresh; a completed refresh hands out no login.
set local session authorization qorpera_secret_broker;
select pg_temp.mu_expect(pg_temp.mu_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea), 'hex')) -> 'logins' -> 0 ->> 'encryptedEnvelopeBase64'$q$),
	encode('envelope-one'::bytea, 'base64'), 'the broker reads the login''s current version');
select pg_temp.mu_expect(pg_temp.mu_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-two'::bytea), 'hex'))::text$q$),
	'42501:model login account refresh is unavailable', 'another capability');
select pg_temp.mu_expect(pg_temp.mu_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000041', repeat('d', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea), 'hex'))::text$q$),
	'42501:model login account refresh is unavailable', 'another company''s broker');
select pg_temp.mu_expect(pg_temp.mu_call(format($q$select public.qorpera_record_model_login_account_metadata(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea), 'hex'), '69300000-0000-4000-8000-000000000050', %L::uuid, 1,
	'member@example.test', jsonb_build_object('observedAt', clock_timestamp(), 'windows', jsonb_build_array(
		jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', 42))), repeat('e', 64))::text$q$,
	current_setting('qorpera_test.mu_connection'))),
	'true', 'the broker records the login''s usage');
select pg_temp.mu_expect(pg_temp.mu_call(format($q$select public.qorpera_record_model_login_account_metadata(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea), 'hex'), '69300000-0000-4000-8000-000000000050', %L::uuid, 0,
	'member@example.test', null, null)::text$q$, current_setting('qorpera_test.mu_connection'))),
	'42501:model login account metadata connection unavailable', 'an older connection version');
select pg_temp.mu_expect(pg_temp.mu_call($q$select public.qorpera_complete_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea), 'hex'))::text$q$), 'true', 'the broker completes the refresh');
select pg_temp.mu_expect(pg_temp.mu_call($q$select (public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea), 'hex')) ->> 'logins')$q$), '[]', 'a completed refresh reads no login');
reset session authorization;

-- 3. Two more refreshes of the same identity: a live one, and a completed one that has expired. The expired one reads
-- nothing; the live one reads the login until its requester is demoted to viewer. (The requester is the only owner, who
-- cannot step down while others remain, so a second owner joins first.)
insert into public.qorpera_native_account_refresh_requests(id, profile_id, client_request_id, compute_identity_id,
	requested_by_user_id, capability_sha256, compute_recovery_epoch, status, created_at, expires_at, completed_at)
select refresh.id, identity.profile_id, refresh.client_id, identity.id, identity.owner_user_id,
	encode(sha256(refresh.secret::bytea), 'hex'), identity.recovery_epoch, refresh.status, moment.at + refresh.created,
	moment.at + refresh.expires, moment.at + refresh.completed
from public.qorpera_member_compute_identities identity, (select clock_timestamp() as at) moment,
	(values ('69300000-0000-4000-8000-000000000301'::uuid, '69300000-0000-4000-8000-000000000302'::uuid, 'refresh-two',
		'pending', interval '0', interval '4 minutes', null::interval),
		('69300000-0000-4000-8000-000000000401'::uuid, '69300000-0000-4000-8000-000000000402'::uuid, 'refresh-three',
		'completed', interval '-10 minutes', interval '-6 minutes', interval '-9 minutes'))
		as refresh(id, client_id, secret, status, created, expires, completed)
where identity.id = (current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mu_expect(pg_temp.mu_call($q$select jsonb_array_length(public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000301',
	encode(sha256('refresh-two'::bytea), 'hex')) -> 'logins')::text$q$), '1', 'the broker reads the live refresh');
select pg_temp.mu_expect(pg_temp.mu_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000401',
	encode(sha256('refresh-three'::bytea), 'hex'))::text$q$),
	'42501:model login account refresh is unavailable', 'an expired refresh');
reset session authorization;
insert into auth.users(id, email) values ('69300000-0000-4000-8000-0000000000f1', 'usage-cofounder@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('92400000-0000-4000-8000-000000000010', '69300000-0000-4000-8000-0000000000f1', 'usage-cofounder@example.test',
	'Co-owner', 'owner');
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '92400000-0000-4000-8000-000000000001';
set local session authorization qorpera_secret_broker;
select pg_temp.mu_expect(pg_temp.mu_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040', repeat('c', 64), '69300000-0000-4000-8000-000000000301',
	encode(sha256('refresh-two'::bytea), 'hex'))::text$q$),
	'42501:model login account refresh is unavailable', 'a requester demoted to viewer');
reset session authorization;

rollback;
