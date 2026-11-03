-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Account-level model logins (20260930548000): a member's Codex login is kept once by the shared vault and linked into
-- every company of the member that the vault serves. Company A is 924's company: its owner's live run gets the owner's
-- account login through the link of the run's capsule. Company B has an older company vault login of the same account
-- (switched off by the vault's pass, its pins moved), company C gets its link when the owner joins, company D when the
-- vault registers it. Checked: only the vault calls the account functions; the run gets its login from its own
-- company's broker only, never for another member's run or link; the switch off is the old behaviour; joining and
-- registering link; leaving A or deleting D leaves the others working; one renewal lock across companies and the idle
-- pass; a usage limit in A blocks new work in B; account logins are Codex logins only; an account sign-in completes as
-- an account login and links everywhere; Stop using here sticks; Sign out everywhere ends every link.

-- The vault's principal and A's broker on it (before the switch is on, so nothing links yet).
insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
	registers_companies_created_after)
values ('68500000-0000-4000-8000-000000000050', 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64),
	'2099-01-01 00:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('68500000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://vault.qorpera.test',
	'vault-root-1', repeat('c', 64), '68500000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');

-- The owner's account login L (version 1), and the base run's capsule as its link in A.
insert into public.qorpera_model_logins(id, owner_user_id, principal_id, provider, native_harness, current_version,
	access_issued_at, access_expires_at, login_kind, provider_account_email)
values ('68500000-0000-4000-8000-000000000100', '92400000-0000-4000-8000-000000000001',
	'68500000-0000-4000-8000-000000000050', 'openai', 'codex-cli', 1, clock_timestamp() - interval '10 minutes',
	clock_timestamp() + interval '10 days', 'codex', 'base-owner@example.test');
insert into public.qorpera_model_login_versions(login_id, version, principal_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at)
select login.id, 1, login.principal_id, 'vault-root-1', 'account-envelope-v1'::bytea,
	encode(sha256('account-envelope-v1'::bytea), 'hex'), 'sign_in', login.access_issued_at,
	login.access_expires_at
from public.qorpera_model_logins as login where login.id = '68500000-0000-4000-8000-000000000100';
update public.qorpera_native_credential_capsules
set encrypted_capsule_reference = 'model-login/68500000-0000-4000-8000-000000000100'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
insert into public.qorpera_model_login_links(credential_capsule_id, login_id, profile_id, compute_identity_id, owner_user_id)
select capsule.id, '68500000-0000-4000-8000-000000000100', capsule.profile_id, capsule.compute_identity_id,
	capsule.owner_user_id
from public.qorpera_native_credential_capsules as capsule
where capsule.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
select set_config('qorpera_test.al_binding',
	(current_setting('qorpera_test.base_binding')::jsonb - 'provider' - 'nativeHarness' - 'model')::text, true);

-- Company B: the owner's older company vault login there, recorded as ChatGPT account X, and a binding paying with it.
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('68500000-0000-4000-8000-000000000011', 'Company B', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('68500000-0000-4000-8000-000000000041', '68500000-0000-4000-8000-000000000011', 'https://vault.qorpera.test',
	'vault-root-1', repeat('d', 64), '68500000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('68500000-0000-4000-8000-000000000011');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('68500000-0000-4000-8000-000000000011', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test',
	'Owner', 'owner');
insert into public.qorpera_member_compute_identities(id, profile_id, ownership_kind, owner_user_id, client_identity_id,
	display_name)
values ('68500000-0000-4000-8000-000000000021', '68500000-0000-4000-8000-000000000011', 'member',
	'92400000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), 'B identity');
insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
	provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
values ('68500000-0000-4000-8000-000000000031', '68500000-0000-4000-8000-000000000011',
	'68500000-0000-4000-8000-000000000021', 'member', '92400000-0000-4000-8000-000000000001', 'openai', 'codex-cli',
	'model-login/68500000-0000-4000-8000-000000000101', repeat('0', 64), '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
	provider, native_harness, current_version, access_issued_at, access_expires_at, account_identity, created_at)
values ('68500000-0000-4000-8000-000000000101', '68500000-0000-4000-8000-000000000011',
	'68500000-0000-4000-8000-000000000021', '68500000-0000-4000-8000-000000000031',
	'68500000-0000-4000-8000-000000000041', 'openai', 'codex-cli', 1, clock_timestamp() - interval '1 day',
	clock_timestamp() + interval '9 days', repeat('9', 64), clock_timestamp() - interval '1 day');
insert into public.qorpera_model_login_versions(login_id, version, broker_authority_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at)
values ('68500000-0000-4000-8000-000000000101', 1, '68500000-0000-4000-8000-000000000041', 'vault-root-1',
	'company-envelope'::bytea, encode(sha256('company-envelope'::bytea), 'hex'), 'sign_in',
	clock_timestamp() - interval '1 day', clock_timestamp() + interval '9 days');
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider,
	created_by_user_id, created_at)
values ('68500000-0000-4000-8000-000000000061', '68500000-0000-4000-8000-000000000011', extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000001', 'openai', '92400000-0000-4000-8000-000000000001',
	clock_timestamp() - interval '1 day');
insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
	billing_source, consent_version, consented_by_user_id, allow_autonomous, quota_policy, created_by_user_id,
	credential_capsule_id, authorization_state, max_native_concurrency)
values ('68500000-0000-4000-8000-000000000061', 1, 'native_subscription', 'codex-cli', 'personal_subscription',
	'qorpera-native-provider-autonomous-consent/v1', '92400000-0000-4000-8000-000000000001', true,
	'{"monthly_microusd":1,"reservation_microusd":1,"max_calls_per_run":128,"max_input_tokens_per_run":100000000,"max_output_tokens_per_run":100000000,"max_concurrent_runs":32}',
	'92400000-0000-4000-8000-000000000001', '68500000-0000-4000-8000-000000000031', 'active', 32);
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('68500000-0000-4000-8000-000000000071', '68500000-0000-4000-8000-000000000011', extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
	provider_connection_version, allow_autonomous, created_by_user_id)
values ('68500000-0000-4000-8000-000000000071', 1, 'member_connection', '68500000-0000-4000-8000-000000000061', 1,
	true, '92400000-0000-4000-8000-000000000001');

-- Company C (the owner joins it later) and company D (the vault registers it later), both on the vault's principal.
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('68500000-0000-4000-8000-000000000012', 'Company C', '92400000-0000-4000-8000-000000000001'),
	('68500000-0000-4000-8000-000000000013', 'Company D', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('68500000-0000-4000-8000-000000000042', '68500000-0000-4000-8000-000000000012', 'https://vault.qorpera.test',
	'vault-root-1', repeat('e', 64), '68500000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('68500000-0000-4000-8000-000000000012');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('68500000-0000-4000-8000-000000000013', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test',
	'Owner', 'owner');

create function pg_temp.al_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.al_try(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	perform set_config('qorpera_test.al_last', coalesce(v_result, ''), true);
	return 'ok';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.al_issue(p_authority uuid, p_capability text, p_renew boolean default false)
returns text language sql as $$
	select pg_temp.al_try(format('select public.qorpera_issue_model_login(%L,%L,%L::jsonb,null,%L)::text',
		p_authority, p_capability, current_setting('qorpera_test.al_binding'), p_renew))
$$;
create function pg_temp.al_last() returns jsonb language sql as $$
	select nullif(current_setting('qorpera_test.al_last', true), '')::jsonb
$$;
grant execute on function pg_temp.al_expect(text,text,text), pg_temp.al_try(text), pg_temp.al_issue(uuid,text,boolean),
	pg_temp.al_last() to qorpera_secret_broker, service_role, authenticated;

-- 1. Only the vault calls the account functions; no API role reads the rows; the internal links are nobody's.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		foreach v_function in array array[
			'public.qorpera_complete_account_model_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamptz,timestamptz,text,text)',
			'public.qorpera_commit_account_model_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamptz,timestamptz)',
			'public.qorpera_release_account_model_login_renewal(uuid,text,uuid,uuid,bigint,boolean,text)',
			'public.qorpera_take_idle_account_model_login_renewal(uuid,text)',
			'public.qorpera_account_model_logins_without_account(uuid,text)',
			'public.qorpera_record_account_model_login_account(uuid,text,uuid,text)',
			'public.qorpera_switch_off_replaced_by_account_logins(uuid,text)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '% may call %', v_role, v_function; end if;
		end loop;
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_link_member_model_logins(uuid,uuid,uuid,uuid)',
			'public.qorpera_link_member_model_logins_everywhere(uuid,uuid)',
			'public.qorpera_switch_off_login_pair(uuid,uuid,uuid,uuid)',
			'public.qorpera_account_model_logins_enabled()'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '% may call %', v_role, v_function; end if;
		end loop;
		if has_table_privilege(v_role, 'public.qorpera_model_login_links', 'select')
			or has_table_privilege(v_role, 'public.qorpera_account_model_login_settings', 'select,update') then
			raise exception '% reads or switches account logins directly', v_role; end if;
	end loop;
	if has_function_privilege('service_role', 'public.qorpera_sign_out_account_model_login(uuid)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_sign_out_account_model_login(uuid)', 'execute')
		or not has_function_privilege('qorpera_secret_broker',
			'public.qorpera_take_idle_account_model_login_renewal(uuid,text)', 'execute') then
		raise exception 'the account grants are wrong'; end if;
	-- An account login is a Codex login, and names no company row.
	begin
		insert into public.qorpera_model_logins(id, owner_user_id, principal_id, provider, native_harness, current_version,
			access_issued_at, access_expires_at, login_kind)
		values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000001', '68500000-0000-4000-8000-000000000050',
			'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '1 day', 'chatgpt_plan');
		raise exception 'a ChatGPT plan account login was stored';
	exception when check_violation then null;
	end;
	begin
		insert into public.qorpera_model_logins(id, owner_user_id, principal_id, profile_id, provider, native_harness,
			current_version, access_issued_at, access_expires_at)
		values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000001', '68500000-0000-4000-8000-000000000050',
			'92400000-0000-4000-8000-000000000010', 'openai', 'codex-cli', 1, clock_timestamp(),
			clock_timestamp() + interval '1 day');
		raise exception 'an account login named a company';
	exception when check_violation then null;
	end;
end $$;

-- 2. Switched off (the default): the old behaviour. No account login is handed out, nothing links, a sign-in is a
-- company sign-in, and the founding table does not count the link.
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)),
	'42501:model login is unavailable to this broker', 'switched off, no account login is handed out');
reset session authorization;
do $$
begin
	if public.qorpera_link_member_model_logins('68500000-0000-4000-8000-000000000011', '92400000-0000-4000-8000-000000000001') <> 0
		or exists (select 1 from public.qorpera_eligible_member_accounts('92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000001') as account
			where account.connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid) then
		raise exception 'switched off, a link was made or counted'; end if;
end $$;
savepoint al_off_sign_in;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.al_off_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
	(current_setting('qorpera_test.al_binding')::jsonb ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli',
	repeat('7', 64), 900)::text, true) \g /dev/null
reset role;
select pg_temp.al_expect((select model_login_scope from public.qorpera_native_provider_login_sessions
	where id = (current_setting('qorpera_test.al_off_login')::jsonb ->> 'login_id')::uuid), 'company',
	'switched off, a sign-in is a company sign-in');
rollback to savepoint al_off_sign_in;
select pg_temp.base_claims('service_role');

update public.qorpera_account_model_login_settings set enabled = true;

-- 3. The live run gets the owner's account login from A's broker: the member, A, the run's identity, the vault's key.
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)), 'ok',
	'the run gets its account login');
reset session authorization;
select pg_temp.al_expect((select jsonb_build_object('scope', answer ->> 'scope', 'owner', answer ->> 'ownerUserId',
		'company', answer ->> 'companyId', 'identity', answer ->> 'computeIdentityId', 'login', answer ->> 'loginId',
		'key', answer ->> 'keyId', 'renewal', answer -> 'renewal')::text from pg_temp.al_last() as answer),
	jsonb_build_object('scope', 'account', 'owner', '92400000-0000-4000-8000-000000000001',
		'company', '92400000-0000-4000-8000-000000000010',
		'identity', current_setting('qorpera_test.al_binding')::jsonb ->> 'computeIdentityId',
		'login', '68500000-0000-4000-8000-000000000100', 'key', 'vault-root-1', 'renewal', null)::text,
	'the answer names the member, the run''s company and identity');

-- 4. Another company's broker on the same vault, a forged capability, A's broker without the shared vault, another
-- member's link on the run's capsule, a link whose owner is not its login's, and a run another member pays: no login.
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000041', repeat('d', 64)),
	'42501:model login is unavailable to this broker', 'another company''s broker on the same vault');
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('b', 64)),
	'42501:cloud secret broker authority is unavailable', 'a forged capability');
reset session authorization;
savepoint al_own_vault;
update public.qorpera_cloud_secret_broker_authorities set principal_id = null
where id = '68500000-0000-4000-8000-000000000040';
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)),
	'42501:model login is unavailable to this broker', 'a company with a vault of its own');
reset session authorization;
do $$
begin
	if exists (select 1 from public.qorpera_member_live_accounts('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001')) then
		raise exception 'a link counts in a company the login''s vault does not serve'; end if;
end $$;
rollback to savepoint al_own_vault;
savepoint al_other_member;
insert into public.qorpera_model_logins(id, owner_user_id, principal_id, provider, native_harness, current_version,
	access_issued_at, access_expires_at)
values ('68500000-0000-4000-8000-000000000102', '92400000-0000-4000-8000-000000000002',
	'68500000-0000-4000-8000-000000000050', 'openai', 'codex-cli', 1, clock_timestamp() - interval '1 minute',
	clock_timestamp() + interval '10 days');
insert into public.qorpera_model_login_versions(login_id, version, principal_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at)
values ('68500000-0000-4000-8000-000000000102', 1, '68500000-0000-4000-8000-000000000050', 'vault-root-1',
	'member-envelope'::bytea, encode(sha256('member-envelope'::bytea), 'hex'), 'sign_in',
	clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 days');
update public.qorpera_native_credential_capsules
set encrypted_capsule_reference = 'model-login/68500000-0000-4000-8000-000000000102'
where id = (current_setting('qorpera_test.al_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
update public.qorpera_model_login_links set login_id = '68500000-0000-4000-8000-000000000102',
	owner_user_id = '92400000-0000-4000-8000-000000000002'
where credential_capsule_id = (current_setting('qorpera_test.al_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)),
	'42501:model login is unavailable to this broker', 'another member''s login never serves the owner''s run');
reset session authorization;
update public.qorpera_model_login_links set owner_user_id = '92400000-0000-4000-8000-000000000001'
where credential_capsule_id = (current_setting('qorpera_test.al_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)),
	'42501:model login is unavailable to this broker', 'a link whose owner is not its login''s');
reset session authorization;
rollback to savepoint al_other_member;
savepoint al_other_payer;
update public.qorpera_execution_runs set sponsored_by_user_id = '92400000-0000-4000-8000-000000000002'
where id = (current_setting('qorpera_test.al_binding')::jsonb ->> 'runId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)),
	'42501:model login is unavailable to this broker', 'a run another member pays');
reset session authorization;
rollback to savepoint al_other_payer;

-- 5. Joining C links the owner's account login there: the identity, capsule, link, a connection that works while the
-- owner is away and a member binding, so C's founding table counts it. The vault registering D links D too.
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('68500000-0000-4000-8000-000000000012', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test',
	'Owner', 'owner');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('68500000-0000-4000-8000-000000000043', '68500000-0000-4000-8000-000000000013', 'https://vault.qorpera.test',
	'vault-root-1', repeat('f', 64), '68500000-0000-4000-8000-000000000050');
do $$
declare v_company uuid; v_account record;
begin
	foreach v_company in array array['68500000-0000-4000-8000-000000000012', '68500000-0000-4000-8000-000000000013']::uuid[] loop
		select * into v_account from public.qorpera_eligible_member_accounts(v_company, '92400000-0000-4000-8000-000000000001');
		if not found or (select count(*) from public.qorpera_eligible_member_accounts(v_company,
			'92400000-0000-4000-8000-000000000001')) <> 1 then
			raise exception 'company % does not count the account login', v_company; end if;
		if not exists (select 1 from public.qorpera_model_login_links as link
				join public.qorpera_native_credential_capsules as capsule on capsule.id = link.credential_capsule_id
				join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = capsule.id
				join public.qorpera_execution_sponsor_versions as sponsor on sponsor.provider_connection_id = version.connection_id
				where link.profile_id = v_company and link.login_id = '68500000-0000-4000-8000-000000000100'
					and capsule.compute_identity_id = v_account.compute_identity_id
					and capsule.encrypted_capsule_reference = 'model-login/68500000-0000-4000-8000-000000000100'
					and version.connection_id = v_account.connection_id and version.allow_autonomous
					and version.provider_account_email = 'base-owner@example.test'
					and sponsor.binding_id = v_account.binding_id and sponsor.allow_autonomous)
			or not public.qorpera_compute_identity_login_in_vault(v_account.compute_identity_id)
			or not public.qorpera_model_login_usage_in_vault(v_account.compute_identity_id) then
			raise exception 'company % is linked wrongly', v_company; end if;
	end loop;
	if (select count(*) from public.qorpera_model_logins where owner_user_id = '92400000-0000-4000-8000-000000000001') <> 1 then
		raise exception 'linking copied the account login'; end if;
	-- A company the member is not in, and a repeat, link nothing.
	if public.qorpera_link_member_model_logins('68500000-0000-4000-8000-000000000012', '92400000-0000-4000-8000-000000000002') <> 0
		or public.qorpera_link_member_model_logins('68500000-0000-4000-8000-000000000012', '92400000-0000-4000-8000-000000000001') <> 0 then
		raise exception 'a link was made for a non-member or twice'; end if;
end $$;

-- 6. The vault's switch-off pass: in B the owner's older company vault login of the same account has its binding moved
-- to the link and is switched off; A, C and D have nothing to switch off.
do $$
begin
	if public.qorpera_link_member_model_logins_everywhere('92400000-0000-4000-8000-000000000001') <> 1 then
		raise exception 'B was not linked'; end if;
	update public.qorpera_model_logins set account_identity = repeat('9', 64)
	where id = '68500000-0000-4000-8000-000000000100';
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_try($q$select public.qorpera_switch_off_replaced_by_account_logins(
	'68500000-0000-4000-8000-000000000050', repeat('a', 64))::text$q$), 'ok', 'the switch-off pass runs');
reset session authorization;
select pg_temp.al_expect(pg_temp.al_last() ->> 'switchedOff', '1', 'one older login switched off');
do $$
begin
	if (select status from public.qorpera_provider_connections where id = '68500000-0000-4000-8000-000000000061') <> 'revoked'
		or public.qorpera_sponsor_binding_connection('68500000-0000-4000-8000-000000000071') is distinct from (
			select version.connection_id from public.qorpera_model_login_links as link
			join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = link.credential_capsule_id
			where link.profile_id = '68500000-0000-4000-8000-000000000011') then
		raise exception 'B''s older login was not replaced by the link'; end if;
end $$;

-- 7. One renewal lock across companies and the vault's idle pass: a run past half the pass takes it, a second run and
-- the idle pass do not, a company broker cannot save it, the vault's principal saves the next version.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days'
where id = '68500000-0000-4000-8000-000000000100';
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64), true), 'ok',
	'a run past half the pass may renew');
select set_config('qorpera_test.al_token', pg_temp.al_last() #>> '{renewal,token}', true) \g /dev/null
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64), true), 'ok',
	'a second run still gets its login');
select pg_temp.al_expect((pg_temp.al_last() -> 'renewal')::text || '/' || (pg_temp.al_last() ->> 'renewing'), 'null/true',
	'the second run gets no second lock');
select pg_temp.al_expect(pg_temp.al_try($q$select public.qorpera_take_idle_account_model_login_renewal(
	'68500000-0000-4000-8000-000000000050', repeat('a', 64))::text$q$), 'ok', 'the idle pass runs');
select pg_temp.al_expect(pg_temp.al_last() ->> 'renewal', null, 'the idle pass takes no second lock');
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_commit_model_login_renewal(
	'68500000-0000-4000-8000-000000000040', repeat('c', 64), '68500000-0000-4000-8000-000000000100', %L, 1, 'vault-root-1',
	encode('renewed-v2'::bytea, 'base64'), encode(sha256('renewed-v2'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days')::text$q$, current_setting('qorpera_test.al_token'))),
	'55000:model login renewal lock is not held', 'a company broker cannot save an account login');
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_commit_account_model_login_renewal(
	'68500000-0000-4000-8000-000000000050', repeat('a', 64), '68500000-0000-4000-8000-000000000100', %L, 1, 'vault-root-1',
	encode('renewed-v2'::bytea, 'base64'), encode(sha256('renewed-v2'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days')::text$q$, current_setting('qorpera_test.al_token'))),
	'ok', 'the vault saves the renewal');
select pg_temp.al_expect(pg_temp.al_last() ->> 'version', '2', 'version 2 is saved');
reset session authorization;
-- Due again: the idle pass takes it, under the vault's key, and then no run takes a second lock.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days'
where id = '68500000-0000-4000-8000-000000000100';
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_try($q$select public.qorpera_take_idle_account_model_login_renewal(
	'68500000-0000-4000-8000-000000000050', repeat('a', 64))::text$q$), 'ok', 'the idle pass runs again');
select pg_temp.al_expect(jsonb_build_object('login', pg_temp.al_last() ->> 'loginId', 'owner', pg_temp.al_last() ->> 'ownerUserId',
		'version', pg_temp.al_last() ->> 'version', 'key', pg_temp.al_last() #>> '{renewal,keyId}')::text,
	jsonb_build_object('login', '68500000-0000-4000-8000-000000000100', 'owner', '92400000-0000-4000-8000-000000000001',
		'version', '2', 'key', 'vault-root-1')::text, 'the idle pass takes the account login once');
select set_config('qorpera_test.al_token', pg_temp.al_last() #>> '{renewal,token}', true) \g /dev/null
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64), true), 'ok',
	'a run during the idle renewal');
select pg_temp.al_expect((pg_temp.al_last() -> 'renewal')::text, 'null', 'the run takes no second lock');
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_release_account_model_login_renewal(
	'68500000-0000-4000-8000-000000000050', repeat('a', 64), '68500000-0000-4000-8000-000000000100', %L, 2, false,
	'renewer_failed')::text$q$, current_setting('qorpera_test.al_token'))), 'ok', 'the vault gives the lock back');
select pg_temp.al_expect(pg_temp.al_last() ->> 'released', 'true', 'the lock is given back');
reset session authorization;

-- 8. A usage limit reached in A blocks new work in the other companies: the login's, not A's.
insert into public.qorpera_provider_connection_usage_signals(profile_id, run_id, job_id, sponsor_binding_id,
	sponsor_version, provider_connection_id, provider_connection_version, provider, signal_kind, source, resets_at)
select run.profile_id, run.id, run.job_id, run.sponsor_binding_id, run.sponsor_version, sponsor.provider_connection_id,
	sponsor.provider_connection_version, 'openai', 'usage_limit', 'native_adapter', clock_timestamp() + interval '2 hours'
from public.qorpera_execution_runs as run
join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
	and sponsor.version = run.sponsor_version
where run.id = (current_setting('qorpera_test.al_binding')::jsonb ->> 'runId')::uuid;
do $$
declare v_account record;
begin
	select * into strict v_account from public.qorpera_member_live_accounts('68500000-0000-4000-8000-000000000012',
		'92400000-0000-4000-8000-000000000001');
	if v_account.remaining <> 0
		or exists (select 1 from public.qorpera_eligible_member_accounts('68500000-0000-4000-8000-000000000012',
			'92400000-0000-4000-8000-000000000001'))
		or public.qorpera_native_account_usage_limit_reset(v_account.connection_id) is null then
		raise exception 'a usage limit in A does not block C: %', v_account; end if;
	-- A connection that is no link keeps its own answer.
	if public.qorpera_native_account_remaining('68500000-0000-4000-8000-000000000061', 1)
		is distinct from public.qorpera_native_account_remaining_company('68500000-0000-4000-8000-000000000061', 1) then
		raise exception 'a connection that is no link changed its answer'; end if;
end $$;
delete from public.qorpera_provider_connection_usage_signals
where run_id = (current_setting('qorpera_test.al_binding')::jsonb ->> 'runId')::uuid;

-- 9. Leaving A leaves C working; deleting D leaves A and C working, and the account login stays.
insert into auth.users(id, email) values ('68500000-0000-4000-8000-000000000006', 'leaver@example.test');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('92400000-0000-4000-8000-000000000010', '68500000-0000-4000-8000-000000000006', 'leaver@example.test', 'Leaver', 'contributor'),
	('68500000-0000-4000-8000-000000000012', '68500000-0000-4000-8000-000000000006', 'leaver@example.test', 'Leaver', 'contributor');
insert into public.qorpera_model_logins(id, owner_user_id, principal_id, provider, native_harness, current_version,
	access_issued_at, access_expires_at)
values ('68500000-0000-4000-8000-000000000106', '68500000-0000-4000-8000-000000000006',
	'68500000-0000-4000-8000-000000000050', 'openai', 'codex-cli', 1, clock_timestamp() - interval '1 minute',
	clock_timestamp() + interval '10 days');
insert into public.qorpera_model_login_versions(login_id, version, principal_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at)
values ('68500000-0000-4000-8000-000000000106', 1, '68500000-0000-4000-8000-000000000050', 'vault-root-1',
	'leaver-envelope'::bytea, encode(sha256('leaver-envelope'::bytea), 'hex'), 'sign_in',
	clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 days');
do $$
declare v_result jsonb;
begin
	if public.qorpera_link_member_model_logins_everywhere('68500000-0000-4000-8000-000000000006') <> 2 then
		raise exception 'the leaver was not linked into A and C'; end if;
	delete from public.qorpera_profile_members
	where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = '68500000-0000-4000-8000-000000000006';
	if exists (select 1 from public.qorpera_member_live_accounts('92400000-0000-4000-8000-000000000010',
			'68500000-0000-4000-8000-000000000006'))
		or (select count(*) from public.qorpera_eligible_member_accounts('68500000-0000-4000-8000-000000000012',
			'68500000-0000-4000-8000-000000000006')) <> 1
		or not public.qorpera_account_model_login_used('68500000-0000-4000-8000-000000000106') then
		raise exception 'leaving A stopped C'; end if;
	v_result := public.qorpera_purge_company('68500000-0000-4000-8000-000000000013');
	if exists (select 1 from public.qorpera_profiles where id = '68500000-0000-4000-8000-000000000013')
		or exists (select 1 from public.qorpera_model_login_links where profile_id = '68500000-0000-4000-8000-000000000013')
		or not exists (select 1 from public.qorpera_model_logins where id = '68500000-0000-4000-8000-000000000100'
			and status = 'active')
		or (select count(*) from public.qorpera_eligible_member_accounts('68500000-0000-4000-8000-000000000011',
			'92400000-0000-4000-8000-000000000001')) <> 1 then
		raise exception 'deleting D reached the account login or B: %', v_result; end if;
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)), 'ok',
	'A''s run still gets the account login after D is deleted');
reset session authorization;

-- 10. An account sign-in in C: begun as account scope, read as such, refused as a company login, completed as an account
-- login linked into every company of the owner, repeated after a lost answer; a sign-in turned into a plan is a company
-- sign-in.
select set_config('qorpera_test.al_c_identity', (select identity.id from public.qorpera_member_compute_identities as identity
	where identity.profile_id = '68500000-0000-4000-8000-000000000012'
		and identity.owner_user_id = '92400000-0000-4000-8000-000000000001')::text, true) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.al_login', public.qorpera_begin_native_provider_login(
	'68500000-0000-4000-8000-000000000012', extensions.gen_random_uuid(), '68500000-0000-4000-8000-0000000000c1',
	current_setting('qorpera_test.al_c_identity')::uuid, 'openai', 'codex-cli', repeat('8', 64), 900)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
savepoint al_plan_scope;
update public.qorpera_native_provider_login_sessions set model_login_kind = 'chatgpt_plan'
where id = (current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')::uuid;
select pg_temp.al_expect((select model_login_scope from public.qorpera_native_provider_login_sessions
	where id = (current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')::uuid), 'company', 'a plan sign-in is a company sign-in');
rollback to savepoint al_plan_scope;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_describe_model_login_sign_in_v2(
	'68500000-0000-4000-8000-000000000042', repeat('e', 64), %L, repeat('8', 64))::text$q$,
	current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')), 'ok', 'the vault reads the sign-in');
select pg_temp.al_expect(pg_temp.al_last() ->> 'scope', 'account', 'the read names an account sign-in');
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_complete_model_login_sign_in(
	'68500000-0000-4000-8000-000000000042', repeat('e', 64), %L, repeat('8', 64), '68500000-0000-4000-8000-000000000107',
	'vault-root-1', encode('signed-in'::bytea, 'base64'), encode(sha256('signed-in'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days', null, 'base-owner@example.test')::text$q$,
	current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')),
	'42501:an account sign-in completes as an account login', 'an account sign-in never completes as a company login');
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_complete_account_model_login_sign_in(
	'68500000-0000-4000-8000-000000000042', repeat('e', 64), %L, repeat('8', 64), '68500000-0000-4000-8000-000000000107',
	'vault-root-1', encode('signed-in'::bytea, 'base64'), encode(sha256('signed-in'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days', null, 'base-owner@example.test')::text$q$,
	current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')), 'ok', 'the account sign-in completes');
select set_config('qorpera_test.al_completed', pg_temp.al_last()::text, true) \g /dev/null
select pg_temp.al_expect(pg_temp.al_try(format($q$select public.qorpera_complete_account_model_login_sign_in(
	'68500000-0000-4000-8000-000000000042', repeat('e', 64), %L, repeat('8', 64), '68500000-0000-4000-8000-000000000107',
	'vault-root-1', encode('signed-in'::bytea, 'base64'), encode(sha256('signed-in'::bytea), 'hex'),
	clock_timestamp(), clock_timestamp() + interval '10 days', null, 'base-owner@example.test')::text$q$,
	current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')), 'ok', 'a repeat after a lost answer');
select pg_temp.al_expect(pg_temp.al_last()::text, current_setting('qorpera_test.al_completed'), 'the repeat answers the same');
reset session authorization;
do $$
begin
	if not exists (select 1 from public.qorpera_model_logins where id = '68500000-0000-4000-8000-000000000107'
			and owner_user_id = '92400000-0000-4000-8000-000000000001' and principal_id = '68500000-0000-4000-8000-000000000050'
			and profile_id is null and provider_account_email = 'base-owner@example.test')
		or (select status from public.qorpera_native_provider_login_sessions
			where id = (current_setting('qorpera_test.al_login')::jsonb ->> 'login_id')::uuid) <> 'completed'
		or (select client_connection_id from public.qorpera_provider_connections
			where id = (current_setting('qorpera_test.al_completed')::jsonb ->> 'connectionId')::uuid)
			<> '68500000-0000-4000-8000-0000000000c1'
		or (select array_agg(profile_id::text order by profile_id::text) from public.qorpera_model_login_links
			where login_id = '68500000-0000-4000-8000-000000000107')
			<> array['68500000-0000-4000-8000-000000000011', '68500000-0000-4000-8000-000000000012',
				'92400000-0000-4000-8000-000000000010'] then
		raise exception 'the account sign-in did not link the owner''s companies'; end if;
end $$;

-- 11. Stop using it here (Disconnect in C) sticks: C's link of L is revoked and never made again; A keeps it.
select set_config('qorpera_test.al_c_connection', (select version.connection_id
	from public.qorpera_provider_connection_versions as version
	join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
	where capsule.profile_id = '68500000-0000-4000-8000-000000000012'
		and capsule.encrypted_capsule_reference = 'model-login/68500000-0000-4000-8000-000000000100' limit 1)::text, true) \g /dev/null
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_native_provider_connection('68500000-0000-4000-8000-000000000012',
	current_setting('qorpera_test.al_c_connection')::uuid) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
do $$
begin
	if public.qorpera_link_member_model_logins('68500000-0000-4000-8000-000000000012',
			'92400000-0000-4000-8000-000000000001', null, '68500000-0000-4000-8000-000000000100') <> 0 then
		raise exception 'a login the member stopped using was linked again'; end if;
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.al_expect(pg_temp.al_issue('68500000-0000-4000-8000-000000000040', repeat('c', 64)), 'ok',
	'A keeps the login C stopped using');
reset session authorization;

-- 12. Sign out everywhere: only its member may; every company's link is revoked and the login is ended.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.al_expect(pg_temp.al_try($q$select public.qorpera_sign_out_account_model_login(
	'68500000-0000-4000-8000-000000000100')::text$q$), '42501:Account model login is unavailable',
	'another member cannot sign the owner out');
reset role;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.al_expect(pg_temp.al_try($q$select public.qorpera_list_account_model_logins(
	'92400000-0000-4000-8000-000000000010')::text$q$), 'ok', 'the owner lists their account logins');
select pg_temp.al_expect((select jsonb_build_object('enabled', pg_temp.al_last() -> 'enabled',
		'logins', jsonb_array_length(pg_temp.al_last() -> 'logins'),
		'connections', (select jsonb_array_length(login -> 'connectionIds') from jsonb_array_elements(pg_temp.al_last() -> 'logins')
			as login where login ->> 'loginId' = '68500000-0000-4000-8000-000000000100'))::text),
	'{"logins": 2, "enabled": true, "connections": 1}', 'Settings reads the account logins');
select pg_temp.al_expect(pg_temp.al_try($q$select public.qorpera_sign_out_account_model_login(
	'68500000-0000-4000-8000-000000000100')::text$q$), 'ok', 'the owner signs out everywhere');
reset role;
select pg_temp.base_claims('service_role');
do $$
begin
	if (select status from public.qorpera_model_logins where id = '68500000-0000-4000-8000-000000000100') <> 'revoked'
		or exists (select 1 from public.qorpera_model_login_links as link
			join public.qorpera_native_credential_capsules as capsule on capsule.id = link.credential_capsule_id
			where link.login_id = '68500000-0000-4000-8000-000000000100' and capsule.status <> 'revoked')
		or exists (select 1 from public.qorpera_model_login_links as link
			join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = link.credential_capsule_id
			join public.qorpera_provider_connections as connection on connection.id = version.connection_id
			where link.login_id = '68500000-0000-4000-8000-000000000100' and connection.status <> 'revoked')
		or public.qorpera_link_member_model_logins_everywhere('92400000-0000-4000-8000-000000000001',
			'68500000-0000-4000-8000-000000000100') <> 0 then
		raise exception 'signing out everywhere left a link'; end if;
	-- The other account login (from the sign-in) is untouched.
	if (select status from public.qorpera_model_logins where id = '68500000-0000-4000-8000-000000000107') <> 'active' then
		raise exception 'signing out ended another login'; end if;
end $$;

rollback;
