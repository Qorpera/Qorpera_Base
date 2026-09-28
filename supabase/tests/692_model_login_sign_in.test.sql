-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Stateless Compute step 1 (change 2B): a member signs in to the vault. For a switched company the
-- login gateway chooser names the company's broker; the broker (and only the broker) reads the
-- pending sign-in by its capability and completes it in one transaction. The recovery pin still
-- fences a recovering identity but asks no node key backup for a vault sign-in.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);

-- The company's broker, another company's broker, and an active recovery authority (a node
-- sign-in of this company now needs a verified key backup).
select set_config('qorpera_test.sign_in_company',
	(select profile_id::text from public.qorpera_member_compute_identities
	 where id = (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid), false);
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('69200000-0000-4000-8000-000000000010','Other company','16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69200000-0000-4000-8000-000000000041','69200000-0000-4000-8000-000000000010','https://other.qorpera.test','other-kek-1',repeat('d',64));
insert into public.qorpera_identity_recovery_authorities(id,profile_id,signing_public_key,wrapping_public_key,service_origin,capability_sha256)
values ('69200000-0000-4000-8000-000000000030',current_setting('qorpera_test.sign_in_company')::uuid,
	repeat('a',64),repeat('b',400),'https://recovery.qorpera.test',repeat('e',64));

-- Two pending Codex sign-ins of the member, made like the fixture's own.
do $$
declare v_columns text; v_base jsonb;
begin
	select string_agg(quote_ident(attname), ',' order by attnum) into v_columns from pg_attribute
	where attrelid = 'public.qorpera_native_provider_login_sessions'::regclass
		and attnum > 0 and not attisdropped and attgenerated = '';
	select to_jsonb(session) into v_base from public.qorpera_native_provider_login_sessions as session
	where session.compute_identity_id = (current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid
		and session.provider = 'openai' and session.native_harness = 'codex-cli'
	order by session.created_at limit 1;
	execute format('insert into public.qorpera_native_provider_login_sessions (%1$s) select %1$s from '
		|| 'jsonb_populate_record(null::public.qorpera_native_provider_login_sessions, $1)', v_columns)
	using v_base || jsonb_build_object('id','69200000-0000-4000-8000-000000000101',
		'client_login_id','69200000-0000-4000-8000-000000000102','client_connection_id','69200000-0000-4000-8000-000000000103',
		'capability_sha256',encode(sha256('sign-in-one'::bytea),'hex'),'status','pending','completed_at',null,
		'created_at',clock_timestamp(),'expires_at',clock_timestamp() + interval '10 minutes');
	execute format('insert into public.qorpera_native_provider_login_sessions (%1$s) select %1$s from '
		|| 'jsonb_populate_record(null::public.qorpera_native_provider_login_sessions, $1)', v_columns)
	using v_base || jsonb_build_object('id','69200000-0000-4000-8000-000000000201',
		'client_login_id','69200000-0000-4000-8000-000000000202','client_connection_id','69200000-0000-4000-8000-000000000203',
		'capability_sha256',encode(sha256('sign-in-two'::bytea),'hex'),'status','pending','completed_at',null,
		'created_at',clock_timestamp() + interval '1 second','expires_at',clock_timestamp() + interval '10 minutes');
end $$;
-- The second sign-in superseded the first (same member and identity): make both pending again.
update public.qorpera_native_provider_login_sessions set status = 'pending'
where id in ('69200000-0000-4000-8000-000000000101','69200000-0000-4000-8000-000000000201');

create function pg_temp.sign_in_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.sign_in_describe(p_authority uuid, p_capability text, p_login uuid, p_secret text)
returns text language plpgsql as $$
begin
	return public.qorpera_describe_model_login_sign_in(p_authority, p_capability, p_login,
		encode(sha256(p_secret::bytea),'hex')) ->> 'status';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.sign_in_complete(p_login uuid, p_secret text, p_model_login uuid, p_envelope bytea,
	p_key text default 'company-kek-1')
returns text language plpgsql as $$
declare v_result jsonb;
begin
	v_result := public.qorpera_complete_model_login_sign_in('69200000-0000-4000-8000-000000000040',repeat('c',64),
		p_login, encode(sha256(p_secret::bytea),'hex'), p_model_login, p_key, encode(p_envelope,'base64'),
		encode(sha256(p_envelope),'hex'), clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 days',
		'account-reference', 'member@example.test');
	perform set_config('qorpera_test.sign_in_result', v_result::text, false);
	return 'completed';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.sign_in_choose(p_secret text)
returns jsonb language sql as $$
	select public.qorpera_runtime_login_gateway_choose(encode(sha256(p_secret::bytea),'hex'))
$$;
create function pg_temp.sign_in_switch(p_enabled boolean)
returns text language plpgsql as $$
begin
	return public.qorpera_set_model_login_sign_in(current_setting('qorpera_test.sign_in_company')::uuid, p_enabled)::text;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.sign_in_expect(text,text,text), pg_temp.sign_in_describe(uuid,text,uuid,text),
	pg_temp.sign_in_complete(uuid,text,uuid,bytea,text), pg_temp.sign_in_switch(boolean)
	to qorpera_secret_broker, service_role, authenticated;
grant execute on function pg_temp.sign_in_choose(text) to service_role;

-- Privileges: the switch is the service role's; describe and complete are the broker's alone.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_describe_model_login_sign_in(uuid,text,uuid,text)','execute')
			or has_function_privilege(v_role,'public.qorpera_complete_model_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamptz,timestamptz,text,text)','execute') then
			raise exception 'Vault sign-in is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_set_model_login_sign_in(uuid,boolean)','execute') then
			raise exception 'Vault sign-in switch is exposed to %', v_role; end if;
	end loop;
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_model_login_sign_in_url(uuid)','execute') then
			raise exception 'Vault sign-in address is exposed to %', v_role; end if;
	end loop;
	if has_table_privilege('qorpera_secret_broker','public.qorpera_model_login_sign_in_companies','select')
		or has_table_privilege('service_role','public.qorpera_model_login_sign_in_companies','insert') then
		raise exception 'Vault sign-in companies are exposed'; end if;
end $$;

-- Before the switch: the chooser keeps the node path and the broker sees nothing.
set role service_role;
select pg_temp.sign_in_expect(case when pg_temp.sign_in_choose('sign-in-one') ->> 'reason' = 'MODEL_LOGIN_VAULT'
	then 'vault' else 'node' end, 'node', 'an unswitched company signs in on a node');
-- The company has no broker yet: it cannot be switched.
select pg_temp.sign_in_expect(pg_temp.sign_in_switch(true),
	'55000:company has no active cloud secret broker','a company without a broker');
reset role;
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69200000-0000-4000-8000-000000000040',current_setting('qorpera_test.sign_in_company')::uuid,
	 'https://secrets.qorpera.test','company-kek-1',repeat('c',64));
set local session authorization qorpera_secret_broker;
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000040',repeat('c',64),
	'69200000-0000-4000-8000-000000000101','sign-in-one'),
	'42501:model login sign-in is unavailable','the broker of an unswitched company');
reset session authorization;
set role authenticated;
select pg_temp.sign_in_expect(pg_temp.sign_in_switch(true),
	'42501:permission denied for function qorpera_set_model_login_sign_in','a member cannot switch');
reset role;
set role service_role;
select pg_temp.sign_in_expect(pg_temp.sign_in_switch(true),'true','the operator switches the company');

-- After the switch: the chooser names the company's vault for a Codex sign-in.
select pg_temp.sign_in_expect(pg_temp.sign_in_choose('sign-in-one') ->> 'url',
	'https://secrets.qorpera.test/v1/model-logins/' || current_setting('qorpera_test.sign_in_company') || '/',
	'the chooser names the vault');
select pg_temp.sign_in_expect(pg_temp.sign_in_choose('sign-in-one') ->> 'reason','MODEL_LOGIN_VAULT','the vault reason');
reset role;

set local session authorization qorpera_secret_broker;
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000040',repeat('c',64),
	'69200000-0000-4000-8000-000000000101','sign-in-one'),'pending','the broker reads a pending sign-in');
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000040',repeat('c',64),
	'69200000-0000-4000-8000-000000000101','sign-in-two'),
	'42501:model login sign-in is unavailable','another sign-in''s capability');
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000041',repeat('d',64),
	'69200000-0000-4000-8000-000000000101','sign-in-one'),
	'42501:model login sign-in is unavailable','another company''s broker');
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000040',repeat('0',64),
	'69200000-0000-4000-8000-000000000101','sign-in-one'),
	'42501:cloud secret broker authority is unavailable','a wrong broker capability');
select pg_temp.sign_in_expect(pg_temp.sign_in_complete('69200000-0000-4000-8000-000000000101','sign-in-one',
	'69200000-0000-4000-8000-000000000150','envelope-one'::bytea,'other-kek-1'),
	'22023:model login sign-in completion is invalid','a key the broker does not hold');

-- Completion: pointer capsule, vault login v1, connection version; the recovery pin asks no
-- node key backup of a vault sign-in.
select pg_temp.sign_in_expect(pg_temp.sign_in_complete('69200000-0000-4000-8000-000000000101','sign-in-one',
	'69200000-0000-4000-8000-000000000150','envelope-one'::bytea),'completed','the broker completes the sign-in');
select pg_temp.sign_in_expect(pg_temp.sign_in_complete('69200000-0000-4000-8000-000000000101','sign-in-one',
	'69200000-0000-4000-8000-000000000150','envelope-one'::bytea),'completed','a repeat after a lost answer');
select pg_temp.sign_in_expect(pg_temp.sign_in_complete('69200000-0000-4000-8000-000000000101','sign-in-one',
	'69200000-0000-4000-8000-000000000151','envelope-other'::bytea),
	'55000:model login sign-in is already complete','a second login for the same sign-in');
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000040',repeat('c',64),
	'69200000-0000-4000-8000-000000000101','sign-in-one'),'completed','the sign-in is complete');
reset session authorization;

do $$
declare v_result jsonb := current_setting('qorpera_test.sign_in_result')::jsonb;
	v_login public.qorpera_model_logins%rowtype;
begin
	select * into strict v_login from public.qorpera_model_logins where id = '69200000-0000-4000-8000-000000000150';
	if v_login.sign_in_session_id <> '69200000-0000-4000-8000-000000000101' or v_login.current_version <> 1
		or v_login.status <> 'active' or v_login.broker_authority_id <> '69200000-0000-4000-8000-000000000040'
		or v_login.credential_capsule_id <> (v_result ->> 'credentialCapsuleId')::uuid then
		raise exception 'vault login row is wrong: %', to_jsonb(v_login); end if;
	if not exists (select 1 from public.qorpera_model_login_versions where login_id = v_login.id and version = 1
		and origin = 'sign_in' and key_id = 'company-kek-1' and encrypted_envelope = 'envelope-one'::bytea) then
		raise exception 'vault login version 1 is missing'; end if;
	if not exists (select 1 from public.qorpera_native_credential_capsules where id = v_login.credential_capsule_id
		and status = 'active' and encrypted_capsule_reference = 'model-login/' || v_login.id::text
		and compute_identity_id = v_login.compute_identity_id) then
		raise exception 'pointer capsule is missing'; end if;
	if not exists (select 1 from public.qorpera_provider_connection_versions version
		join public.qorpera_provider_connections connection on connection.id = version.connection_id
		where version.credential_capsule_id = v_login.credential_capsule_id and version.authorization_state = 'active'
			and connection.client_connection_id = '69200000-0000-4000-8000-000000000103'
			and version.provider_account_email = 'member@example.test'
			and connection.id = (v_result ->> 'connectionId')::uuid
			and version.version = (v_result ->> 'connectionVersion')::bigint) then
		raise exception 'connection version is missing'; end if;
	if not exists (select 1 from public.qorpera_native_provider_login_sessions
		where id = '69200000-0000-4000-8000-000000000101' and status = 'completed') then
		raise exception 'sign-in is not completed'; end if;
end $$;

-- A node sign-in of the same company still needs its key backup: the recovery pin is unchanged.
do $$
begin
	update public.qorpera_native_provider_login_sessions set status = 'completed', completed_at = clock_timestamp()
	where id = '69200000-0000-4000-8000-000000000201';
	raise exception 'a node sign-in completed without a key backup';
exception when sqlstate '42501' then
	if sqlerrm <> 'Native login requires a verified recovery backup' then raise; end if;
end $$;

-- A Claude sign-in never goes to the vault.
update public.qorpera_native_provider_login_sessions set native_harness = 'claude-code'
where id = '69200000-0000-4000-8000-000000000201';
set role service_role;
select pg_temp.sign_in_expect(case when pg_temp.sign_in_choose('sign-in-two') ->> 'reason' = 'MODEL_LOGIN_VAULT'
	then 'vault' else 'node' end, 'node', 'a Claude sign-in stays on a node');
reset role;
set local session authorization qorpera_secret_broker;
select pg_temp.sign_in_expect(pg_temp.sign_in_describe('69200000-0000-4000-8000-000000000040',repeat('c',64),
	'69200000-0000-4000-8000-000000000201','sign-in-two'),
	'42501:model login sign-in is unavailable','the broker refuses a Claude sign-in');
reset session authorization;

-- Switched back: new sign-ins go to nodes again, and an open vault sign-in cannot complete.
update public.qorpera_native_provider_login_sessions set native_harness = 'codex-cli'
where id = '69200000-0000-4000-8000-000000000201';
set role service_role;
select pg_temp.sign_in_expect(pg_temp.sign_in_switch(false),'false','the operator switches the company back');
select pg_temp.sign_in_expect(case when pg_temp.sign_in_choose('sign-in-two') ->> 'reason' = 'MODEL_LOGIN_VAULT'
	then 'vault' else 'node' end, 'node', 'a switched-back company signs in on a node');
reset role;
set local session authorization qorpera_secret_broker;
select pg_temp.sign_in_expect(pg_temp.sign_in_complete('69200000-0000-4000-8000-000000000201','sign-in-two',
	'69200000-0000-4000-8000-000000000250','envelope-two'::bytea),
	'55000:model login sign-in is unavailable','a sign-in after the switch back');
reset session authorization;

rollback;
