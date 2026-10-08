-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Stateless Compute step 1, vault upkeep, on folder-v2: a member's old login is switched off once the member signed in to
-- the vault with the same account (20260928243500, 20260930059000), and the member's pins move only to a login of that
-- same account. The service role cannot record accounts or switch logins off; another company's broker reads and records
-- nothing; a recorded account cannot be changed. Another account, an earlier login's account, a vault login with no
-- recorded account and a ChatGPT plan of another person replace nothing; a move the database refuses moves no pin. The
-- old login's pins move to the vault login, it waits for its run, then it is revoked as Disconnect does; a vault
-- re-sign-in and a plan re-sign-in of the same person move the pins the same way. The old login is 924's owner's, its
-- work is 924's live run of Alice's (ported from snapshot-v1 in the legacy sweep).

select set_config('qorpera_test.so_identity', current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id', true);
select set_config('qorpera_test.so_node', current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id', true);
select set_config('qorpera_test.so_binding', current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id', true);
select set_config('qorpera_test.so_account', encode(sha256(convert_to('openai-account:account-1', 'utf8')), 'hex'), true);
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('69600000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test', 'company-kek-1', repeat('c', 64));
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('69600000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('69600000-0000-4000-8000-000000000041', '69600000-0000-4000-8000-000000000010', 'https://other.qorpera.test', 'other-kek-1', repeat('d', 64));

create function pg_temp.so_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.so_call(p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
	execute p_sql into v_result;
	return v_result;
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
-- One switch-off pass as the company's broker: "switched/waiting/refused".
create function pg_temp.so_pass()
returns text language sql as $$
	select (result ->> 'switchedOff') || '/' || (result ->> 'waiting') || '/' || (result ->> 'refused')
	from (select public.qorpera_switch_off_replaced_node_logins('69600000-0000-4000-8000-000000000040', repeat('c', 64)) as result) pass
$$;
-- The account the broker records for a login (the switched session authorization is the broker's).
create function pg_temp.so_record(p_login uuid, p_account text)
returns text language sql as $$
	select pg_temp.so_call(format($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000040',
		repeat('c', 64), %L, %L) ->> 'recorded'$q$, p_login, p_account))
$$;
-- The latest connection the member's base binding pays with.
create function pg_temp.so_pays(p_binding uuid)
returns text language sql as $$
	select sponsor.provider_connection_id::text from public.qorpera_execution_sponsor_versions sponsor
	where sponsor.binding_id = p_binding order by sponsor.version desc limit 1
$$;
grant execute on function pg_temp.so_expect(text,text,text), pg_temp.so_call(text), pg_temp.so_pass(),
	pg_temp.so_record(uuid,text) to qorpera_secret_broker, service_role;

-- 1. The service role can neither list, record nor switch off.
do $$
begin
	if has_function_privilege('service_role', 'public.qorpera_model_logins_without_account(uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_record_model_login_account(uuid,text,uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_switch_off_replaced_node_logins(uuid,text)', 'execute') then
		raise exception 'The switch-off is exposed to service_role'; end if;
end $$;

-- The node login has been read for usage: its account is recorded, as nodes record it.
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity)
select version.connection_id, version.version, current_setting('qorpera_test.so_account')
from public.qorpera_provider_connection_versions version
where version.connection_id = current_setting('qorpera_test.so_node')::uuid
order by version.version desc limit 1;

-- The owner signs in to the vault: pointer capsule, vault login version 1, and a new connection (consented).
do $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_connection uuid;
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = current_setting('qorpera_test.so_identity')::uuid;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
		owner_scope_key, provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values ('69600000-0000-4000-8000-000000000060', v_identity.profile_id, v_identity.id, v_identity.ownership_kind,
		v_identity.owner_user_id, v_identity.owner_scope_key, 'openai', 'codex-cli', 'model-login/69600000-0000-4000-8000-000000000050',
		repeat('a', 64), v_identity.owner_user_id);
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at)
	values ('69600000-0000-4000-8000-000000000050', v_identity.profile_id, v_identity.id, '69600000-0000-4000-8000-000000000060',
		'69600000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '10 days');
	insert into public.qorpera_model_login_versions(login_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, origin, access_issued_at, access_expires_at)
	values ('69600000-0000-4000-8000-000000000050', 1, '69600000-0000-4000-8000-000000000040', 'company-kek-1', 'envelope-one'::bytea,
		encode(sha256('envelope-one'::bytea), 'hex'), 'sign_in', clock_timestamp(), clock_timestamp() + interval '10 days');
	insert into public.qorpera_provider_connections(profile_id, client_connection_id, owner_user_id, provider, created_by_user_id, created_at)
	values (v_identity.profile_id, '69600000-0000-4000-8000-000000000080', v_identity.owner_user_id, 'openai',
		v_identity.owner_user_id, clock_timestamp())
	returning id into v_connection;
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, provider_account_reference, provider_account_email, billing_source, consent_version,
		consented_by_user_id, allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency)
	select v_connection, 1, 'native_subscription', 'codex-cli', null, null, null, 'personal_subscription',
		'qorpera-native-subscription-v1', v_identity.owner_user_id, true, previous.commercial_approval_reference,
		previous.quota_policy, v_identity.owner_user_id, '69600000-0000-4000-8000-000000000060', 'active', previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = current_setting('qorpera_test.so_node')::uuid
	order by previous.version desc limit 1;
	perform set_config('qorpera_test.so_vault', v_connection::text, true);
end $$;

-- 2. Another company's broker lists and records none of it; the company's broker records the account once, and a
-- recorded account cannot be changed.
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_call($q$select jsonb_array_length(public.qorpera_model_logins_without_account(
		'69600000-0000-4000-8000-000000000041', repeat('d', 64)) -> 'logins')::text$q$), '0', 'another company''s broker lists none of it');
select pg_temp.so_expect(pg_temp.so_call(format($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000041',
		repeat('d', 64), '69600000-0000-4000-8000-000000000050', %L) ->> 'recorded'$q$, current_setting('qorpera_test.so_account'))),
	'42501:model login is unavailable to this broker', 'another company''s broker cannot record it');
select pg_temp.so_expect(pg_temp.so_record('69600000-0000-4000-8000-000000000050', current_setting('qorpera_test.so_account')),
	'true', 'the account is recorded');
select pg_temp.so_expect(pg_temp.so_record('69600000-0000-4000-8000-000000000050', repeat('e', 64)),
	'22023:model login account differs from the recorded one', 'another account is refused');
reset session authorization;
set local role service_role;
select pg_temp.so_expect(public.qorpera_set_model_login_sign_in('92400000-0000-4000-8000-000000000010', true)::text,
	'true', 'the operator switches the company');
reset role;

-- 3. The node login of another account is left alone.
update public.qorpera_native_provider_account_metadata set provider_account_identity = repeat('e', 64)
where connection_id = current_setting('qorpera_test.so_node')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'another ChatGPT account is left alone');
reset session authorization;
update public.qorpera_native_provider_account_metadata set provider_account_identity = current_setting('qorpera_test.so_account')
where connection_id = current_setting('qorpera_test.so_node')::uuid;

-- 4. Only the account recorded for the node's current login counts: a newer version of the node connection holds another
-- login (another account), and the earlier record of the same account does not make it the replaced login.
do $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = current_setting('qorpera_test.so_identity')::uuid;
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
		owner_scope_key, provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values ('69600000-0000-4000-8000-0000000000a1', v_identity.profile_id, v_identity.id, v_identity.ownership_kind,
		v_identity.owner_user_id, v_identity.owner_scope_key, 'openai', 'codex-cli', 'capsule/69600000-0000-4000-8000-0000000000a1',
		repeat('a', 64), v_identity.owner_user_id);
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		secret_reference, provider_account_reference, provider_account_email, billing_source, consent_version,
		consented_by_user_id, allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency)
	select previous.connection_id, previous.version + 1, previous.authentication_mode, previous.native_harness,
		previous.secret_reference, previous.provider_account_reference, previous.provider_account_email,
		previous.billing_source, previous.consent_version, previous.consented_by_user_id, previous.allow_autonomous,
		previous.commercial_approval_reference, previous.quota_policy, previous.created_by_user_id,
		'69600000-0000-4000-8000-0000000000a1', 'active', previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = current_setting('qorpera_test.so_node')::uuid
	order by previous.version desc limit 1;
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity)
	select version.connection_id, version.version, repeat('b', 64)
	from public.qorpera_provider_connection_versions version
	where version.connection_id = current_setting('qorpera_test.so_node')::uuid
		and version.credential_capsule_id = '69600000-0000-4000-8000-0000000000a1';
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'an earlier login''s account does not match the node''s current login');
reset session authorization;
-- The current login turns out to be the same account after all: its own record now counts.
update public.qorpera_native_provider_account_metadata seen set provider_account_identity = current_setting('qorpera_test.so_account')
from public.qorpera_provider_connection_versions version
where seen.connection_id = current_setting('qorpera_test.so_node')::uuid
	and version.connection_id = seen.connection_id and version.version = seen.connection_version
	and version.credential_capsule_id = '69600000-0000-4000-8000-0000000000a1';

-- 5. A move the database refuses (the vault login's provider is not enabled) moves no pin.
update public.qorpera_provider_execution_policies set enablement_status = 'disabled', disabled_reason = 'Switch-off test'
where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli';
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/1', 'a refused move');
reset session authorization;
update public.qorpera_provider_execution_policies set enablement_status = 'enabled', disabled_reason = null
where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli';
select pg_temp.so_expect(pg_temp.so_pays(current_setting('qorpera_test.so_binding')::uuid),
	current_setting('qorpera_test.so_node'), 'a refused move moves no pin');

-- 6. Alice's live run still pays with the old login: the pins move to the vault login, and the old login waits for the run.
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/1/0', 'the old login waits for its run');
reset session authorization;
select pg_temp.so_expect((select jsonb_build_object('connection', sponsor.provider_connection_id::text, 'version', sponsor.version)::text
	from public.qorpera_execution_sponsor_versions sponsor
	where sponsor.binding_id = current_setting('qorpera_test.so_binding')::uuid order by sponsor.version desc limit 1),
	jsonb_build_object('connection', current_setting('qorpera_test.so_vault'), 'version', 2)::text,
	'the owner''s binding pays with the vault login from its next version');
select pg_temp.so_expect((select status from public.qorpera_provider_connections
	where id = current_setting('qorpera_test.so_node')::uuid), 'active', 'the old login stays on while its run runs');

-- 7. The run finishes: the next pass switches the old login off as Disconnect does; the vault login stays on.
select public.qorpera_terminalize_runner_attempt((current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid,
	'failed', 'Switch-off test finishes the run', false) \g /dev/null
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '1/0/0', 'the old login is switched off');
reset session authorization;
select pg_temp.so_expect((select jsonb_build_object(
		'connection', connection.status,
		'versions', (select string_agg(distinct version.authorization_state, ',') from public.qorpera_provider_connection_versions version
			where version.connection_id = connection.id and version.authentication_mode = 'native_subscription'),
		'capsules', (select string_agg(distinct capsule.status, ',') from public.qorpera_provider_connection_versions version
			join public.qorpera_native_credential_capsules capsule on capsule.id = version.credential_capsule_id
			where version.connection_id = connection.id),
		'leases', (select count(*) from public.qorpera_native_provider_connection_leases lease
			where lease.provider_connection_id = connection.id and lease.status = 'active'),
		'vault', (select vault.status from public.qorpera_provider_connections vault
			where vault.id = current_setting('qorpera_test.so_vault')::uuid))::text
	from public.qorpera_provider_connections connection where connection.id = current_setting('qorpera_test.so_node')::uuid),
	jsonb_build_object('connection', 'revoked', 'versions', 'revoked', 'capsules', 'revoked', 'leases', 0, 'vault', 'active')::text,
	'revoked as Disconnect revokes it: connection, versions, capsules and leases; the vault login stays on');

-- 8. The owner signs in to the vault again with the same account (the vault login needs a new sign-in): the real
-- completion makes a new connection beside it. Until the new login's account is recorded nothing pairs them; then the
-- pins move to the new login and the old vault login is switched off.
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '69600000-0000-4000-8000-000000000050';
do $$
declare v_columns text; v_base jsonb;
begin
	select string_agg(quote_ident(attname), ',' order by attnum) into v_columns from pg_attribute
	where attrelid = 'public.qorpera_native_provider_login_sessions'::regclass
		and attnum > 0 and not attisdropped and attgenerated = '';
	select to_jsonb(session) into strict v_base from public.qorpera_native_provider_login_sessions as session
	where session.compute_identity_id = current_setting('qorpera_test.so_identity')::uuid
		and session.provider = 'openai' and session.native_harness = 'codex-cli'
	order by session.created_at limit 1;
	execute format('insert into public.qorpera_native_provider_login_sessions (%1$s) select %1$s from '
		|| 'jsonb_populate_record(null::public.qorpera_native_provider_login_sessions, $1)', v_columns)
	using v_base || jsonb_build_object('id', '69600000-0000-4000-8000-0000000000d1',
		'client_login_id', '69600000-0000-4000-8000-0000000000d2', 'client_connection_id', '69600000-0000-4000-8000-0000000000d3',
		'capability_sha256', encode(sha256('sign-in-again'::bytea), 'hex'), 'status', 'pending', 'completed_at', null,
		'created_at', clock_timestamp(), 'expires_at', clock_timestamp() + interval '10 minutes');
end $$;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.so_again', public.qorpera_complete_model_login_sign_in('69600000-0000-4000-8000-000000000040',
	repeat('c', 64), '69600000-0000-4000-8000-0000000000d1', encode(sha256('sign-in-again'::bytea), 'hex'),
	'69600000-0000-4000-8000-0000000000b0', 'company-kek-1', encode('envelope-again'::bytea, 'base64'),
	encode(sha256('envelope-again'::bytea), 'hex'), clock_timestamp() - interval '1 minute', clock_timestamp() + interval '10 days',
	'account-reference', 'base-owner@example.test')::text, true) \g /dev/null
reset session authorization;
-- The web keeps the owner's standing consent to work while away on the new login.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_consent_provider_connection_autonomous('92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.so_again')::jsonb ->> 'connectionId')::uuid, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'a new vault login with no recorded account replaces nothing');
select pg_temp.so_expect(pg_temp.so_record('69600000-0000-4000-8000-0000000000b0', current_setting('qorpera_test.so_account')),
	'true', 'the new vault login''s account is recorded');
select pg_temp.so_expect(pg_temp.so_pass(), '1/0/0', 'the old vault login is switched off');
reset session authorization;
select pg_temp.so_expect(jsonb_build_object('pays', pg_temp.so_pays(current_setting('qorpera_test.so_binding')::uuid),
		'old', (select status from public.qorpera_provider_connections where id = current_setting('qorpera_test.so_vault')::uuid))::text,
	jsonb_build_object('pays', current_setting('qorpera_test.so_again')::jsonb ->> 'connectionId', 'old', 'revoked')::text,
	'the owner''s binding pays with the new vault login; the old one is switched off');

-- 9. A ChatGPT plan the owner signs in to again: a plan login's account is its verified OpenAI subject, so the pass
-- pairs a plan that needs a new sign-in with the same person's new plan, and never with another person's plan.
update public.qorpera_chatgpt_plan_settings set enabled = true;
set local role service_role;
select pg_temp.so_expect(public.qorpera_set_chatgpt_plan_company('92400000-0000-4000-8000-000000000010', true)::text,
	'true', 'the operator lists the company for plans');
reset role;
-- A plan sign-in of the owner, begun and completed as the product does; p_n names its ids and envelope.
create function pg_temp.so_plan(p_n text) returns jsonb language plpgsql as $$
declare v_login jsonb; v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	execute 'set local role authenticated';
	v_login := public.qorpera_begin_chatgpt_plan_sign_in('92400000-0000-4000-8000-000000000010',
		('69600000-0000-4000-8000-0000000001' || p_n || '1')::uuid, ('69600000-0000-4000-8000-0000000001' || p_n || '2')::uuid,
		current_setting('qorpera_test.so_identity')::uuid, encode(sha256(('plan-' || p_n)::bytea), 'hex'));
	execute 'reset role';
	execute 'set local session authorization qorpera_secret_broker';
	v_result := public.qorpera_complete_chatgpt_plan_sign_in('69600000-0000-4000-8000-000000000040', repeat('c', 64),
		(v_login ->> 'login_id')::uuid, encode(sha256(('plan-' || p_n)::bytea), 'hex'),
		('69600000-0000-4000-8000-0000000001' || p_n || '0')::uuid, 'company-kek-1',
		encode(('plan-envelope-' || p_n)::bytea, 'base64'), encode(sha256(('plan-envelope-' || p_n)::bytea), 'hex'),
		clock_timestamp() - interval '1 minute', clock_timestamp() + interval '59 minutes', 'account-subject',
		'base-owner@example.test', clock_timestamp() + interval '20 minutes');
	execute 'reset session authorization';
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
-- A plan login's account as the broker records it: its verified subject, in the plan namespace.
create function pg_temp.so_plan_account(p_n text, p_subject text) returns text language plpgsql as $$
declare v_result text;
begin
	execute 'set local session authorization qorpera_secret_broker';
	v_result := pg_temp.so_record(('69600000-0000-4000-8000-0000000001' || p_n || '0')::uuid,
		encode(sha256(convert_to('openai-subject:' || p_subject, 'utf8')), 'hex'));
	execute 'reset session authorization';
	return v_result;
end $$;
grant execute on function pg_temp.so_plan(text), pg_temp.so_plan_account(text,text) to qorpera_secret_broker, authenticated;

select set_config('qorpera_test.so_plan_a', pg_temp.so_plan('a')::text, true);
-- The owner's binding on plan A.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.so_plan_a_binding', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '69600000-0000-4000-8000-0000000001a3',
	(current_setting('qorpera_test.so_plan_a')::jsonb ->> 'connectionId')::uuid,
	(current_setting('qorpera_test.so_plan_a')::jsonb ->> 'connectionVersion')::bigint, false) ->> 'binding_id', true);
reset role;
select pg_temp.base_claims('service_role');
-- Plan A needs a new sign-in; its subject is recorded.
update public.qorpera_model_logins set status = 'needs_sign_in' where id = '69600000-0000-4000-8000-0000000001a0';
select pg_temp.so_expect(pg_temp.so_plan_account('a', 'subject-1'), 'true', 'plan A''s subject is recorded');
-- The owner signs in with another person's plan: nothing pairs them.
select set_config('qorpera_test.so_plan_b', pg_temp.so_plan('b')::text, true);
select pg_temp.so_expect(pg_temp.so_plan_account('b', 'subject-2'), 'true', 'plan B''s subject is recorded');
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'a plan of another person replaces nothing');
reset session authorization;
-- The owner disconnects plan B and signs in with their own plan again.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_native_provider_connection('92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.so_plan_b')::jsonb ->> 'connectionId')::uuid) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
select set_config('qorpera_test.so_plan_c', pg_temp.so_plan('c')::text, true);
select pg_temp.so_expect(pg_temp.so_plan_account('c', 'subject-1'), 'true', 'plan C''s subject is recorded');
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '1/0/0', 'plan A is switched off for the same person''s plan C');
reset session authorization;
select pg_temp.so_expect(pg_temp.so_pays(current_setting('qorpera_test.so_plan_a_binding')::uuid),
	current_setting('qorpera_test.so_plan_c')::jsonb ->> 'connectionId', 'the plan binding pays with plan C');

rollback;
