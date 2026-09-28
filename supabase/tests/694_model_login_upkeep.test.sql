-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Stateless Compute step 1, vault upkeep: the vault renews idle logins itself. The broker takes
-- the renewal lock of its company's most urgent login that is past half its pass, with the same
-- conditions a run's renewal uses (no renewal running, the failure back-off passed), and only for
-- a login still behind an active pointer of an active connection. It saves and gives back the
-- lock with the existing commit and release.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
select set_config('qorpera_test.upkeep_identity', current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id', false);
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
select '69400000-0000-4000-8000-000000000040', identity.profile_id, 'https://secrets.qorpera.test', 'company-kek-2', repeat('c',64)
from public.qorpera_member_compute_identities identity
where identity.id = current_setting('qorpera_test.upkeep_identity')::uuid;
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('69400000-0000-4000-8000-000000000010','Other company','16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69400000-0000-4000-8000-000000000041','69400000-0000-4000-8000-000000000010','https://other.qorpera.test','other-kek-1',repeat('d',64));

create function pg_temp.upkeep_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
-- The member's vault login `p_login` (its own pointer capsule and connection, as a sign-in makes
-- them), `p_used` into a pass that has `p_left` to run.
create function pg_temp.upkeep_login(p_login uuid, p_capsule uuid, p_client_connection uuid, p_broker uuid,
	p_used interval, p_left interval)
returns uuid language plpgsql as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_connection uuid;
	v_node_connection uuid;
	v_now timestamptz := clock_timestamp();
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = current_setting('qorpera_test.upkeep_identity')::uuid;
	insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
		owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
	values (p_capsule,v_identity.profile_id,v_identity.id,v_identity.ownership_kind,v_identity.owner_user_id,
		v_identity.owner_scope_key,'openai','codex-cli','model-login/' || p_login::text,repeat('a',64),v_identity.owner_user_id);
	insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
		provider,native_harness,current_version,access_issued_at,access_expires_at)
	values (p_login,v_identity.profile_id,v_identity.id,p_capsule,p_broker,'openai','codex-cli',1,v_now - p_used,v_now + p_left);
	insert into public.qorpera_model_login_versions(login_id,version,broker_authority_id,key_id,encrypted_envelope,
		envelope_sha256,origin,access_issued_at,access_expires_at)
	values (p_login,1,p_broker,'company-kek-1',convert_to('envelope-' || p_login::text,'utf8'),
		encode(sha256(convert_to('envelope-' || p_login::text,'utf8')),'hex'),'sign_in',v_now - p_used,v_now + p_left);
	select version.connection_id into strict v_node_connection
	from public.qorpera_provider_connection_versions version
	join public.qorpera_native_credential_capsules capsule on capsule.id = version.credential_capsule_id
	where capsule.compute_identity_id = v_identity.id and capsule.provider = 'openai'
		and capsule.encrypted_capsule_reference !~ '^model-login/'
	order by version.version desc limit 1;
	insert into public.qorpera_provider_connections(profile_id, client_connection_id, owner_user_id, provider, created_by_user_id)
	values (v_identity.profile_id, p_client_connection, v_identity.owner_user_id, 'openai', v_identity.owner_user_id)
	returning id into v_connection;
	insert into public.qorpera_provider_connection_versions(connection_id,version,authentication_mode,native_harness,
		secret_reference,provider_account_reference,provider_account_email,billing_source,consent_version,
		consented_by_user_id,allow_autonomous,commercial_approval_reference,quota_policy,created_by_user_id,
		credential_capsule_id,authorization_state,max_native_concurrency)
	select v_connection, 1, 'native_subscription','codex-cli',null,null,null,'personal_subscription',
		'qorpera-native-subscription-v1',v_identity.owner_user_id,false,previous.commercial_approval_reference,
		previous.quota_policy,v_identity.owner_user_id,p_capsule,'active',previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = v_node_connection
	order by previous.version desc limit 1;
	return v_connection;
end $$;
create function pg_temp.upkeep_take(p_authority uuid, p_capability text)
returns text language plpgsql as $$
begin
	return public.qorpera_take_idle_model_login_renewal(p_authority, p_capability)::text;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.upkeep_taken(p_authority uuid default '69400000-0000-4000-8000-000000000040')
returns text language sql as $$
	select coalesce(pg_temp.upkeep_take(p_authority, repeat('c',64))::jsonb ->> 'loginId', 'none')
$$;
grant execute on function pg_temp.upkeep_expect(text,text,text), pg_temp.upkeep_take(uuid,text),
	pg_temp.upkeep_taken(uuid) to qorpera_secret_broker, service_role, authenticated;

-- Only the broker's own database login may take a login.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_take_idle_model_login_renewal(uuid,text)','execute') then
			raise exception 'Idle renewal is exposed to %', v_role; end if;
	end loop;
	if not has_function_privilege('qorpera_secret_broker','public.qorpera_take_idle_model_login_renewal(uuid,text)','execute') then
		raise exception 'The broker cannot take idle renewals'; end if;
end $$;

-- A: 6 of 10 days used (due). B: more urgent, but its pointer is revoked (the member
-- disconnected it). C: fresh. D: due and more urgent than A, but its connection is disabled.
-- E: due, but another broker's.
select set_config('qorpera_test.upkeep_a', pg_temp.upkeep_login('69400000-0000-4000-8000-0000000000a1',
	'69400000-0000-4000-8000-0000000000a2','69400000-0000-4000-8000-0000000000a3','69400000-0000-4000-8000-000000000040',
	interval '6 days', interval '4 days')::text, false);
select set_config('qorpera_test.upkeep_b', pg_temp.upkeep_login('69400000-0000-4000-8000-0000000000b1',
	'69400000-0000-4000-8000-0000000000b2','69400000-0000-4000-8000-0000000000b3','69400000-0000-4000-8000-000000000040',
	interval '8 days', interval '2 days')::text, false);
select set_config('qorpera_test.upkeep_c', pg_temp.upkeep_login('69400000-0000-4000-8000-0000000000c1',
	'69400000-0000-4000-8000-0000000000c2','69400000-0000-4000-8000-0000000000c3','69400000-0000-4000-8000-000000000040',
	interval '1 hour', interval '10 days')::text, false);
select set_config('qorpera_test.upkeep_d', pg_temp.upkeep_login('69400000-0000-4000-8000-0000000000d1',
	'69400000-0000-4000-8000-0000000000d2','69400000-0000-4000-8000-0000000000d3','69400000-0000-4000-8000-000000000040',
	interval '7 days', interval '3 days')::text, false);
select set_config('qorpera_test.upkeep_e', pg_temp.upkeep_login('69400000-0000-4000-8000-0000000000e1',
	'69400000-0000-4000-8000-0000000000e2','69400000-0000-4000-8000-0000000000e3','69400000-0000-4000-8000-000000000041',
	interval '9 days', interval '1 day')::text, false);
update public.qorpera_native_credential_capsules set status = 'revoked', revoked_at = clock_timestamp()
where id = '69400000-0000-4000-8000-0000000000b2';
update public.qorpera_provider_connections set status = 'disabled'
where id = current_setting('qorpera_test.upkeep_d')::uuid;

set local session authorization qorpera_secret_broker;
select pg_temp.upkeep_expect(pg_temp.upkeep_take('69400000-0000-4000-8000-000000000040', repeat('e',64)),
	'42501:cloud secret broker authority is unavailable', 'a forged capability');
select pg_temp.upkeep_expect(pg_temp.upkeep_take('69400000-0000-4000-8000-000000000041', repeat('d',64)),
	'{"schema": "qorpera.model-login-idle-renewal/v1", "renewal": null}',
	'a login of another company is not that company''s broker''s');
select set_config('qorpera_test.upkeep_taken', pg_temp.upkeep_take('69400000-0000-4000-8000-000000000040', repeat('c',64)), false);
reset session authorization;
select pg_temp.upkeep_expect(current_setting('qorpera_test.upkeep_taken')::jsonb ->> 'loginId',
	'69400000-0000-4000-8000-0000000000a1', 'the most urgent due login behind an active pointer and connection');
select pg_temp.upkeep_expect(
	(select jsonb_build_object('version', taken ->> 'version', 'keyId', taken ->> 'keyId',
		'envelope', convert_from(decode(taken ->> 'encryptedEnvelopeBase64','base64'),'utf8'),
		'sha', taken ->> 'envelopeSha256' = encode(sha256(decode(taken ->> 'encryptedEnvelopeBase64','base64')),'hex'),
		'company', taken ->> 'companyId' = login.profile_id::text,
		'identity', taken ->> 'computeIdentityId' = login.compute_identity_id::text,
		'renewal', (taken -> 'renewal') - 'token',
		'token', taken #>> '{renewal,token}' = login.renewal_token::text,
		'lock', login.renewal_until between clock_timestamp() + interval '4 minutes' and clock_timestamp() + interval '5 minutes',
		'used', login.last_issued_at is null)::text
	 from public.qorpera_model_logins login, (select current_setting('qorpera_test.upkeep_taken')::jsonb as taken) answer
	 where login.id = '69400000-0000-4000-8000-0000000000a1'),
	jsonb_build_object('version','1','keyId','company-kek-1','envelope','envelope-69400000-0000-4000-8000-0000000000a1',
		'sha',true,'company',true,'identity',true,'renewal',jsonb_build_object('baseVersion',1,'keyId','company-kek-2'),
		'token',true,'lock',true,'used',true)::text,
	'the current version with the lock, sealed for the broker''s key; the login is not marked used');

-- A held lock is not taken again; nothing else is due.
set local session authorization qorpera_secret_broker;
select pg_temp.upkeep_expect(pg_temp.upkeep_taken(), 'none', 'a login whose renewal runs is not taken twice');
-- The broker saves the renewal with the existing commit: the login is fresh again.
select pg_temp.upkeep_expect(public.qorpera_commit_model_login_renewal('69400000-0000-4000-8000-000000000040',repeat('c',64),
	'69400000-0000-4000-8000-0000000000a1',(current_setting('qorpera_test.upkeep_taken')::jsonb #>> '{renewal,token}')::uuid,1,
	'company-kek-2',encode('renewed-a'::bytea,'base64'),encode(sha256('renewed-a'::bytea),'hex'),
	clock_timestamp(),clock_timestamp() + interval '10 days') ->> 'version', '2', 'the renewal is saved');
select pg_temp.upkeep_expect(pg_temp.upkeep_taken(), 'none', 'a renewed login is fresh');
reset session authorization;

-- D's connection is active again: it is due and taken. A transient failure backs it off.
update public.qorpera_provider_connections set status = 'active'
where id = current_setting('qorpera_test.upkeep_d')::uuid;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.upkeep_taken', pg_temp.upkeep_take('69400000-0000-4000-8000-000000000040', repeat('c',64)), false);
select pg_temp.upkeep_expect(current_setting('qorpera_test.upkeep_taken')::jsonb ->> 'loginId',
	'69400000-0000-4000-8000-0000000000d1', 'a due login whose connection is active again');
select pg_temp.upkeep_expect(public.qorpera_release_model_login_renewal('69400000-0000-4000-8000-000000000040',repeat('c',64),
	'69400000-0000-4000-8000-0000000000d1',(current_setting('qorpera_test.upkeep_taken')::jsonb #>> '{renewal,token}')::uuid,
	1,false,'helper_busy') ->> 'status', 'active', 'a transient failure gives the lock back');
select pg_temp.upkeep_expect(pg_temp.upkeep_taken(), 'none', 'a login that just failed waits for its back-off');
reset session authorization;
update public.qorpera_model_logins set renewal_failed_at = clock_timestamp() - interval '61 seconds'
where id = '69400000-0000-4000-8000-0000000000d1';
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.upkeep_taken', pg_temp.upkeep_take('69400000-0000-4000-8000-000000000040', repeat('c',64)), false);
select pg_temp.upkeep_expect(current_setting('qorpera_test.upkeep_taken')::jsonb ->> 'loginId',
	'69400000-0000-4000-8000-0000000000d1', 'after its back-off the login is taken again');
-- The provider refuses: the login needs a new sign-in and is never taken again.
select pg_temp.upkeep_expect(public.qorpera_release_model_login_renewal('69400000-0000-4000-8000-000000000040',repeat('c',64),
	'69400000-0000-4000-8000-0000000000d1',(current_setting('qorpera_test.upkeep_taken')::jsonb #>> '{renewal,token}')::uuid,
	1,true,'refresh_token_reused') ->> 'status', 'needs_sign_in', 'a refused renewal asks for a new sign-in');
reset session authorization;
update public.qorpera_model_logins set renewal_failed_at = clock_timestamp() - interval '2 hours'
where id = '69400000-0000-4000-8000-0000000000d1';
set local session authorization qorpera_secret_broker;
select pg_temp.upkeep_expect(pg_temp.upkeep_taken(), 'none', 'a login that needs a new sign-in is not renewed');
reset session authorization;

-- A run's renewal and the idle one share the lock: a login a run is renewing is skipped.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days',
	renewal_token = '69400000-0000-4000-8000-0000000000c9', renewal_until = clock_timestamp() + interval '3 minutes'
where id = '69400000-0000-4000-8000-0000000000c1';
set local session authorization qorpera_secret_broker;
select pg_temp.upkeep_expect(pg_temp.upkeep_taken(), 'none', 'a login a run is renewing is not taken');
reset session authorization;
-- A lapsed lock (its holder gone) is taken over with a new token.
update public.qorpera_model_logins set renewal_until = clock_timestamp() - interval '1 second'
where id = '69400000-0000-4000-8000-0000000000c1';
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.upkeep_taken', pg_temp.upkeep_take('69400000-0000-4000-8000-000000000040', repeat('c',64)), false);
reset session authorization;
select pg_temp.upkeep_expect((select jsonb_build_object('login', current_setting('qorpera_test.upkeep_taken')::jsonb ->> 'loginId',
		'new', login.renewal_token <> '69400000-0000-4000-8000-0000000000c9')::text
	from public.qorpera_model_logins login where login.id = '69400000-0000-4000-8000-0000000000c1'),
	jsonb_build_object('login','69400000-0000-4000-8000-0000000000c1','new',true)::text,
	'a lapsed lock is taken over');

-- A member who left: their connections are revoked, and their login is left to lapse.
update public.qorpera_model_logins set renewal_token = null, renewal_until = null
where id = '69400000-0000-4000-8000-0000000000c1';
update public.qorpera_provider_connections set status = 'revoked'
where id = current_setting('qorpera_test.upkeep_c')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.upkeep_expect(pg_temp.upkeep_taken(), 'none', 'a login whose connection is revoked is not renewed');
reset session authorization;
