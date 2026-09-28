-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Stateless Compute step 1 (change 2C): the vault reads the usage of the logins it keeps. The
-- account refresh chooser names the company's broker for an identity whose Codex login is in the
-- vault (a vault login, and no Codex login on a node; a Claude login stays on a node and does not
-- count), whether or not the company still takes new sign-ins in the vault; an identity still
-- moving (with a Codex login on a node) keeps the node path. The
-- broker (only) reads the refresh and the current version of that login under the refresh's
-- capability, records its display metadata, and completes the refresh.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
select set_config('qorpera_test.usage_company',
	(select profile_id::text from public.qorpera_member_compute_identities
	 where id = (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid), false);
select set_config('qorpera_test.usage_identity', current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id', false);
do $$
begin
	if to_regprocedure('public.qorpera_compute_identity_login_in_vault(uuid)') is null then
		create function public.qorpera_compute_identity_login_in_vault(p_compute_identity_id uuid)
		returns boolean language sql stable as 'select false';
	end if;
end $$;
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69300000-0000-4000-8000-000000000040',current_setting('qorpera_test.usage_company')::uuid,
	 'https://secrets.qorpera.test','company-kek-1',repeat('c',64));
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('69300000-0000-4000-8000-000000000010','Other company','16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69300000-0000-4000-8000-000000000041','69300000-0000-4000-8000-000000000010','https://other.qorpera.test','other-kek-1',repeat('d',64));

create function pg_temp.usage_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.usage_call(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	return v_result;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.usage_choose(p_secret text)
returns jsonb language sql as $$
	select public.qorpera_runtime_account_refresh_gateway_choose(encode(sha256(p_secret::bytea),'hex'))
$$;
grant execute on function pg_temp.usage_expect(text,text,text), pg_temp.usage_call(text)
	to qorpera_secret_broker, service_role, authenticated;
grant execute on function pg_temp.usage_choose(text) to service_role;

-- A pending account refresh of the member's identity.
insert into public.qorpera_native_account_refresh_requests(id,profile_id,client_request_id,compute_identity_id,
	requested_by_user_id,capability_sha256,compute_recovery_epoch,created_at,expires_at)
select '69300000-0000-4000-8000-000000000201', identity.profile_id, '69300000-0000-4000-8000-000000000202', identity.id,
	identity.owner_user_id, encode(sha256('refresh-one'::bytea),'hex'), identity.recovery_epoch,
	moment.at, moment.at + interval '4 minutes'
from public.qorpera_member_compute_identities identity, (select clock_timestamp() as at) moment
where identity.id = current_setting('qorpera_test.usage_identity')::uuid;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_describe_model_login_account_refresh(uuid,text,uuid,text)','execute')
			or has_function_privilege(v_role,'public.qorpera_record_model_login_account_metadata(uuid,text,uuid,text,uuid,uuid,bigint,text,jsonb,text)','execute')
			or has_function_privilege(v_role,'public.qorpera_complete_model_login_account_refresh(uuid,text,uuid,text)','execute') then
			raise exception 'Vault usage is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_model_login_account_refresh(uuid,text,uuid,text)','execute') then
			raise exception 'Vault refresh lookup is exposed to %', v_role; end if;
	end loop;
end $$;

-- No vault login yet (and the company not switched): the refresh stays on a node.
set role service_role;
select pg_temp.usage_expect(case when pg_temp.usage_choose('refresh-one') ->> 'reason' = 'MODEL_LOGIN_VAULT'
	then 'vault' else 'node' end, 'node', 'an identity without a vault login refreshes on a node');
select pg_temp.usage_expect(public.qorpera_set_model_login_sign_in(current_setting('qorpera_test.usage_company')::uuid, true)::text,
	'true', 'the operator switches the company');
select pg_temp.usage_expect(case when pg_temp.usage_choose('refresh-one') ->> 'reason' = 'MODEL_LOGIN_VAULT'
	then 'vault' else 'node' end, 'node', 'a switched company without a vault login still refreshes on a node');
reset role;

-- The member's vault login: pointer capsule, login version 1, and the connection version using it.
do $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_connection uuid;
	v_version bigint;
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = current_setting('qorpera_test.usage_identity')::uuid;
	insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
		owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
	values ('69300000-0000-4000-8000-000000000060',v_identity.profile_id,v_identity.id,v_identity.ownership_kind,
		v_identity.owner_user_id,v_identity.owner_scope_key,'openai','codex-cli','model-login/69300000-0000-4000-8000-000000000050',
		repeat('a',64),v_identity.owner_user_id);
	insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
		provider,native_harness,current_version,access_issued_at,access_expires_at)
	values ('69300000-0000-4000-8000-000000000050',v_identity.profile_id,v_identity.id,'69300000-0000-4000-8000-000000000060',
		'69300000-0000-4000-8000-000000000040','openai','codex-cli',1,clock_timestamp(),clock_timestamp() + interval '10 days');
	insert into public.qorpera_model_login_versions(login_id,version,broker_authority_id,key_id,encrypted_envelope,
		envelope_sha256,origin,access_issued_at,access_expires_at)
	values ('69300000-0000-4000-8000-000000000050',1,'69300000-0000-4000-8000-000000000040','company-kek-1','envelope-one'::bytea,
		encode(sha256('envelope-one'::bytea),'hex'),'sign_in',clock_timestamp(),clock_timestamp() + interval '10 days');
	select version.connection_id, version.version + 1 into v_connection, v_version
	from public.qorpera_provider_connection_versions version
	join public.qorpera_native_credential_capsules capsule on capsule.id = version.credential_capsule_id
	where capsule.compute_identity_id = v_identity.id and capsule.provider = 'openai'
	order by version.version desc limit 1;
	insert into public.qorpera_provider_connection_versions(connection_id,version,authentication_mode,native_harness,
		secret_reference,provider_account_reference,provider_account_email,billing_source,consent_version,
		consented_by_user_id,allow_autonomous,commercial_approval_reference,quota_policy,created_by_user_id,
		credential_capsule_id,authorization_state,max_native_concurrency)
	select v_connection, v_version, 'native_subscription','codex-cli',null,null,null,'personal_subscription',
		'qorpera-native-subscription-v1',v_identity.owner_user_id,false,previous.commercial_approval_reference,
		previous.quota_policy,v_identity.owner_user_id,'69300000-0000-4000-8000-000000000060','active',previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = v_connection and previous.version = v_version - 1;
	perform set_config('qorpera_test.usage_connection', v_connection::text, false);
	perform set_config('qorpera_test.usage_version', v_version::text, false);
end $$;

-- Still moving: the member's node login is active beside the vault login, so the node reads it.
set role service_role;
select pg_temp.usage_expect(case when pg_temp.usage_choose('refresh-one') ->> 'reason' = 'MODEL_LOGIN_VAULT'
	then 'vault' else 'node' end, 'node', 'an identity still moving refreshes on a node');
reset role;
-- Moved: the member's old node account is gone.
update public.qorpera_native_credential_capsules set status = 'disabled'
where compute_identity_id = current_setting('qorpera_test.usage_identity')::uuid
	and status = 'active' and encrypted_capsule_reference not like 'model-login/%';
set role service_role;
select pg_temp.usage_expect(pg_temp.usage_choose('refresh-one') ->> 'url',
	'https://secrets.qorpera.test/v1/model-logins/' || current_setting('qorpera_test.usage_company') || '/',
	'an identity whose login is in the vault refreshes in its vault');
reset role;
-- A Claude login stays on a node (nodes never read its usage): the Codex usage is still the vault's.
insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
	owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
select '69300000-0000-4000-8000-000000000070', capsule.profile_id, capsule.compute_identity_id, capsule.ownership_kind,
	capsule.owner_user_id, capsule.owner_scope_key, 'anthropic', 'claude-code',
	'native-capsule/69300000-0000-4000-8000-000000000070', capsule.attestation_policy_sha256, capsule.created_by_user_id
from public.qorpera_native_credential_capsules capsule where capsule.id = '69300000-0000-4000-8000-000000000060';
set role service_role;
select pg_temp.usage_expect(pg_temp.usage_choose('refresh-one') ->> 'reason','MODEL_LOGIN_VAULT',
	'a Claude login on a node keeps the Codex usage in the vault');
reset role;
-- A vault login that needs a new sign-in: the vault reads nothing, and no node machine boots.
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '69300000-0000-4000-8000-000000000050';
set role service_role;
select pg_temp.usage_expect(pg_temp.usage_choose('refresh-one') ->> 'reason','MODEL_LOGIN_VAULT',
	'a login that needs a new sign-in still refreshes in the vault');
reset role;
set local session authorization qorpera_secret_broker;
select pg_temp.usage_expect(pg_temp.usage_call($q$select (public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex')) ->> 'logins')$q$),'[]','the vault reads no login that needs a new sign-in');
reset session authorization;
update public.qorpera_model_logins set status = 'active' where id = '69300000-0000-4000-8000-000000000050';

set local session authorization qorpera_secret_broker;
-- The broker reads the refresh and its login's current version.
select pg_temp.usage_expect(pg_temp.usage_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex')) -> 'logins' -> 0 ->> 'encryptedEnvelopeBase64'$q$),
	encode('envelope-one'::bytea,'base64'),'the broker reads the login''s current version');
select pg_temp.usage_expect(pg_temp.usage_call($q$select (public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex')) -> 'logins' -> 0 ->> 'connectionVersion')$q$),
	current_setting('qorpera_test.usage_version'),'the connection version that uses the login');
select pg_temp.usage_expect(pg_temp.usage_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-two'::bytea),'hex'))::text$q$),
	'42501:model login account refresh is unavailable','another capability');
select pg_temp.usage_expect(pg_temp.usage_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000041',repeat('d',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex'))::text$q$),
	'42501:model login account refresh is unavailable','another company''s broker');
-- It records the display metadata for that connection version only, with a node's checks.
select pg_temp.usage_expect(pg_temp.usage_call(format($q$select public.qorpera_record_model_login_account_metadata(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex'),'69300000-0000-4000-8000-000000000050',%L::uuid,%s,
	'member@example.test',jsonb_build_object('observedAt',clock_timestamp(),'windows',jsonb_build_array(
		jsonb_build_object('id','primary','label','5 hours','usedPercent',42))),repeat('e',64))::text$q$,
	current_setting('qorpera_test.usage_connection'), current_setting('qorpera_test.usage_version'))),
	'true','the broker records the login''s usage');
select pg_temp.usage_expect(pg_temp.usage_call(format($q$select public.qorpera_record_model_login_account_metadata(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex'),'69300000-0000-4000-8000-000000000050',%L::uuid,%s,
	null,jsonb_build_object('observedAt',clock_timestamp(),'windows',jsonb_build_array(
		jsonb_build_object('id','primary','label','5 hours','usedPercent',142))),null)::text$q$,
	current_setting('qorpera_test.usage_connection'), current_setting('qorpera_test.usage_version'))),
	'22023:Account usage window invalid','an impossible reading');
select pg_temp.usage_expect(pg_temp.usage_call(format($q$select public.qorpera_record_model_login_account_metadata(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex'),'69300000-0000-4000-8000-000000000050',%L::uuid,%s,
	'member@example.test',null,null)::text$q$,
	current_setting('qorpera_test.usage_connection'), (current_setting('qorpera_test.usage_version')::bigint - 1)::text)),
	'42501:model login account metadata connection unavailable','an older connection version');
select pg_temp.usage_expect(pg_temp.usage_call($q$select public.qorpera_complete_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex'))::text$q$),'true','the broker completes the refresh');
reset session authorization;

do $$
begin
	if not exists (select 1 from public.qorpera_native_provider_account_metadata
		where connection_id = current_setting('qorpera_test.usage_connection')::uuid
			and connection_version = current_setting('qorpera_test.usage_version')::bigint
			and provider_account_email = 'member@example.test'
			and provider_account_usage -> 'windows' -> 0 ->> 'usedPercent' = '42'
			and provider_account_identity = repeat('e',64)) then
		raise exception 'vault usage was not recorded'; end if;
	if not exists (select 1 from public.qorpera_native_account_refresh_requests
		where id = '69300000-0000-4000-8000-000000000201' and status = 'completed') then
		raise exception 'refresh is not completed'; end if;
end $$;

-- A completed refresh hands out no login any more.
set local session authorization qorpera_secret_broker;
select pg_temp.usage_expect(pg_temp.usage_call($q$select (public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000201',
	encode(sha256('refresh-one'::bytea),'hex')) ->> 'logins')$q$),'[]','a completed refresh reads no login');
reset session authorization;

-- Two more refreshes of the same identity: a live one, and a completed one that has expired.
insert into public.qorpera_native_account_refresh_requests(id,profile_id,client_request_id,compute_identity_id,
	requested_by_user_id,capability_sha256,compute_recovery_epoch,status,created_at,expires_at,completed_at)
select refresh.id, identity.profile_id, refresh.client_id, identity.id, identity.owner_user_id,
	encode(sha256(refresh.secret::bytea),'hex'), identity.recovery_epoch, refresh.status, moment.at + refresh.created,
	moment.at + refresh.expires, moment.at + refresh.completed
from public.qorpera_member_compute_identities identity, (select clock_timestamp() as at) moment,
	(values ('69300000-0000-4000-8000-000000000301'::uuid,'69300000-0000-4000-8000-000000000302'::uuid,'refresh-two',
		'pending', interval '0', interval '4 minutes', null::interval),
		('69300000-0000-4000-8000-000000000401'::uuid,'69300000-0000-4000-8000-000000000402'::uuid,'refresh-three',
		'completed', interval '-10 minutes', interval '-6 minutes', interval '-9 minutes'))
		as refresh(id, client_id, secret, status, created, expires, completed)
where identity.id = current_setting('qorpera_test.usage_identity')::uuid;

-- New sign-ins switched back to nodes: the vault still reads the usage of the logins it keeps.
set role service_role;
select pg_temp.usage_expect(public.qorpera_set_model_login_sign_in(current_setting('qorpera_test.usage_company')::uuid, false)::text,
	'false','the operator switches new sign-ins back');
select pg_temp.usage_expect(pg_temp.usage_choose('refresh-two') ->> 'reason','MODEL_LOGIN_VAULT',
	'a vault login still refreshes in the vault');
reset role;
set local session authorization qorpera_secret_broker;
select pg_temp.usage_expect(pg_temp.usage_call($q$select jsonb_array_length(public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000301',
	encode(sha256('refresh-two'::bytea),'hex')) -> 'logins')::text$q$),'1','the broker still reads it');
-- An expired refresh is refused like on a node.
select pg_temp.usage_expect(pg_temp.usage_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000401',
	encode(sha256('refresh-three'::bytea),'hex'))::text$q$),
	'42501:model login account refresh is unavailable','an expired refresh');
reset session authorization;
-- So is a member who may no longer refresh.
update public.qorpera_profile_members set role = 'viewer'
where profile_id = current_setting('qorpera_test.usage_company')::uuid
	and user_id = (select requested_by_user_id from public.qorpera_native_account_refresh_requests
		where id = '69300000-0000-4000-8000-000000000301');
set local session authorization qorpera_secret_broker;
select pg_temp.usage_expect(pg_temp.usage_call($q$select public.qorpera_describe_model_login_account_refresh(
	'69300000-0000-4000-8000-000000000040',repeat('c',64),'69300000-0000-4000-8000-000000000301',
	encode(sha256('refresh-two'::bytea),'hex'))::text$q$),
	'42501:model login account refresh is unavailable','a member who may no longer refresh');
reset session authorization;

rollback;
