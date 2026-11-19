-- @fixture 466_memory_run_resume_receipts.test.sql until "-- 1. The receipts read"

insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
	registers_companies_created_after)
values ('13040000-0000-4000-8000-000000000050', 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64),
	'2099-01-01 00:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('13040000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://vault.qorpera.test',
	'vault-root-1', repeat('c', 64), '13040000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
update public.qorpera_account_model_login_settings set enabled = true;

insert into public.qorpera_model_logins(id, owner_user_id, principal_id, provider, native_harness, current_version,
	access_issued_at, access_expires_at, login_kind, provider_account_email)
values ('13040000-0000-4000-8000-000000000100', '92400000-0000-4000-8000-000000000001',
	'13040000-0000-4000-8000-000000000050', 'openai', 'codex-cli', 1, clock_timestamp() - interval '10 minutes',
	clock_timestamp() + interval '10 days', 'codex', 'base-owner@example.test');
insert into public.qorpera_model_login_versions(login_id, version, principal_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at, created_at)
select login.id, 1, login.principal_id, 'vault-root-1', 'account-envelope-v1'::bytea,
	encode(sha256('account-envelope-v1'::bytea), 'hex'), 'sign_in', login.access_issued_at, login.access_expires_at,
	clock_timestamp() - interval '1 day'
from public.qorpera_model_logins as login where login.id = '13040000-0000-4000-8000-000000000100';
update public.qorpera_native_credential_capsules
set encrypted_capsule_reference = 'model-login/13040000-0000-4000-8000-000000000100'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
insert into public.qorpera_model_login_links(credential_capsule_id, login_id, profile_id, compute_identity_id, owner_user_id)
select capsule.id, '13040000-0000-4000-8000-000000000100', capsule.profile_id, capsule.compute_identity_id,
	capsule.owner_user_id
from public.qorpera_native_credential_capsules as capsule
where capsule.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid;

insert into public.qorpera_model_logins(id, owner_user_id, principal_id, provider, native_harness, current_version,
	access_issued_at, access_expires_at, login_kind, provider_account_email)
values ('13040000-0000-4000-8000-000000000101', '92400000-0000-4000-8000-000000000001',
	'13040000-0000-4000-8000-000000000050', 'openai', 'codex-cli', 1, clock_timestamp() - interval '1 minute',
	clock_timestamp() + interval '10 days', 'codex', 'base-owner@example.test');
insert into public.qorpera_model_login_versions(login_id, version, principal_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at)
select login.id, 1, login.principal_id, 'vault-root-1', 'fresh-envelope-v1'::bytea,
	encode(sha256('fresh-envelope-v1'::bytea), 'hex'), 'sign_in', login.access_issued_at, login.access_expires_at
from public.qorpera_model_logins as login where login.id = '13040000-0000-4000-8000-000000000101';

insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('13040000-0000-4000-8000-000000000011', 'Company B', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('13040000-0000-4000-8000-000000000041', '13040000-0000-4000-8000-000000000011', 'https://vault.qorpera.test',
	'vault-root-1', repeat('d', 64), '13040000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('13040000-0000-4000-8000-000000000011');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('13040000-0000-4000-8000-000000000011', '92400000-0000-4000-8000-000000000001', 'base-owner@example.test',
	'Owner', 'owner');

create function pg_temp.sr_login(p_id uuid default '13040000-0000-4000-8000-000000000100')
returns public.qorpera_model_logins language sql as $$
	select * from public.qorpera_model_logins where id = p_id
$$;
create function pg_temp.sr_b() returns record language sql as $$
	select account.binding_id, account.sponsor_version, account.connection_id
	from public.qorpera_model_login_links as link
	join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = link.credential_capsule_id
	cross join lateral (select * from public.qorpera_member_live_accounts(link.profile_id, link.owner_user_id) as live
		where live.connection_id = version.connection_id) as account
	where link.profile_id = '13040000-0000-4000-8000-000000000011'
		and link.login_id = '13040000-0000-4000-8000-000000000100'
$$;
create function pg_temp.sr_b_waits() returns boolean language sql as $$
	select public.qorpera_sponsor_waits_for_usage_limit(b.binding_id, b.sponsor_version)
	from pg_temp.sr_b() as b(binding_id uuid, sponsor_version bigint, connection_id uuid)
$$;
create function pg_temp.sr_a_waits() returns boolean language sql as $$
	select public.qorpera_sponsor_waits_for_usage_limit(run.sponsor_binding_id, run.sponsor_version)
	from public.qorpera_execution_runs as run where run.id = pg_temp.rr_run()
$$;
create function pg_temp.sr_refuse(p_binding jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_record_provider_usage_signal(p_binding, 'sign_in_refused');
end
$$;
create function pg_temp.sr_idle() returns jsonb language sql as $$
	select public.qorpera_take_idle_account_model_login_renewal('13040000-0000-4000-8000-000000000050', repeat('a', 64))
$$;
create function pg_temp.sr_issue(p_renew boolean) returns jsonb language sql as $$
	select public.qorpera_issue_model_login('13040000-0000-4000-8000-000000000040', repeat('c', 64),
		current_setting('qorpera_test.base_binding')::jsonb - 'provider' - 'nativeHarness' - 'model', null, p_renew)
$$;
create function pg_temp.sr_release(p_token text, p_permanent boolean) returns jsonb language sql as $$
	select public.qorpera_release_account_model_login_renewal('13040000-0000-4000-8000-000000000050', repeat('a', 64),
		'13040000-0000-4000-8000-000000000100', p_token::uuid, 1, p_permanent, 'refused')
$$;
create function pg_temp.sr_commit(p_token text) returns jsonb language sql as $$
	select public.qorpera_commit_account_model_login_renewal('13040000-0000-4000-8000-000000000050', repeat('a', 64),
		'13040000-0000-4000-8000-000000000100', p_token::uuid, 1, 'vault-root-1', encode('renewed-v2'::bytea, 'base64'),
		encode(sha256('renewed-v2'::bytea), 'hex'), clock_timestamp(), clock_timestamp() + interval '10 days')
$$;
create function pg_temp.sr_as_member(p_sql text) returns jsonb language plpgsql as $$
declare v_answer jsonb; v_claims text := current_setting('request.jwt.claims', true);
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	execute p_sql into v_answer;
	reset role;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_answer;
end
$$;
create function pg_temp.sr_recovery() returns jsonb language sql as $$
	select pg_temp.sr_as_member(format('select public.qorpera_get_execution_run_recovery(%L)', pg_temp.rr_run()))
$$;
create function pg_temp.sr_activity() returns jsonb language sql as $$
	select row from jsonb_array_elements(pg_temp.sr_as_member(
			'select public.qorpera_list_staff_execution_activity(''92400000-0000-4000-8000-000000000020'')')) as row
	where row ->> 'run_id' = pg_temp.rr_run()::text
$$;
create function pg_temp.sr_login_status() returns text language sql as $$
	select entry ->> 'login_status'
	from jsonb_array_elements(pg_temp.sr_as_member(
			'select public.qorpera_list_member_native_execution_connections(''92400000-0000-4000-8000-000000000010'')')
		-> 'connections') as entry
	where entry ->> 'connection_id' = (select sponsor.provider_connection_id::text
		from public.qorpera_execution_runs as run
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
			and sponsor.version = run.sponsor_version
		where run.id = pg_temp.rr_run())
$$;
create function pg_temp.sr_turned_away(p_binding jsonb) returns jsonb language sql as $$
	select pg_temp.rr_fail(p_binding,
		'Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]')
$$;
create function pg_temp.sr_company_idle() returns jsonb language sql as $$
	select public.qorpera_take_idle_model_login_renewal('13040000-0000-4000-8000-000000000040', repeat('c', 64))
$$;
grant execute on function pg_temp.sr_idle(), pg_temp.sr_issue(boolean), pg_temp.sr_release(text, boolean),
	pg_temp.sr_commit(text), pg_temp.sr_company_idle() to qorpera_secret_broker;

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_capsule_model_login(uuid)',
			'public.qorpera_connection_login_pass_refused(uuid,bigint)',
			'public.qorpera_note_model_login_pass_refused(uuid,timestamp with time zone)',
			'public.qorpera_rate_limit_wait_kind(uuid)', 'public.qorpera_run_wait_paused_for(uuid)',
			'public.qorpera_run_sign_in_refused(uuid)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'),
				v_role || ' may call ' || v_function);
		end loop;
	end loop;
	perform pg_temp.base_assert(pg_temp.sr_b() is not null, 'the account login is linked into company B');
	perform pg_temp.base_assert(not public.qorpera_model_login_renewal_due(pg_temp.sr_login(), clock_timestamp(), false)
		and not public.qorpera_model_login_renewal_due(pg_temp.sr_login(), clock_timestamp(), true),
		'a fresh pass is not due before any refusal');
	perform pg_temp.base_assert(not pg_temp.sr_a_waits() and not pg_temp.sr_b_waits(), 'nothing waits before a refusal');
	perform pg_temp.rr_begin(current_setting('qorpera_test.base_binding')::jsonb);
end $$;

savepoint sr_newer_than_lease;
do $$
declare v_receipt jsonb;
begin
	update public.qorpera_model_login_versions set created_at = clock_timestamp()
	where login_id = '13040000-0000-4000-8000-000000000100' and version = 1;
	v_receipt := pg_temp.sr_refuse(current_setting('qorpera_test.base_binding')::jsonb);
	perform pg_temp.base_assert(v_receipt ->> 'signalKind' = 'sign_in_refused', 'the refusal is recorded: ' || v_receipt::text);
	perform pg_temp.base_assert((pg_temp.sr_login()).refused_version is null,
		'a version made after the run''s lease began is never marked by that run');
end $$;
rollback to savepoint sr_newer_than_lease;

savepoint sr_company_login;
do $$
declare v_capsule uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
	v_identity uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'computeIdentityId')::uuid;
begin
	delete from public.qorpera_model_login_links where credential_capsule_id = v_capsule;
	update public.qorpera_native_credential_capsules
	set encrypted_capsule_reference = 'model-login/13040000-0000-4000-8000-000000000200' where id = v_capsule;
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at)
	values ('13040000-0000-4000-8000-000000000200', '92400000-0000-4000-8000-000000000010', v_identity, v_capsule,
		'13040000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1, clock_timestamp() - interval '10 minutes',
		clock_timestamp() + interval '10 days');
	insert into public.qorpera_native_credential_capsules(id, profile_id, compute_identity_id, ownership_kind, owner_user_id,
		provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id)
	values ('13040000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000010', v_identity, 'member',
		'92400000-0000-4000-8000-000000000001', 'openai', 'codex-cli',
		'model-login/13040000-0000-4000-8000-000000000201', repeat('0', 64), '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
		provider, native_harness, current_version, access_issued_at, access_expires_at)
	values ('13040000-0000-4000-8000-000000000201', '92400000-0000-4000-8000-000000000010', v_identity,
		'13040000-0000-4000-8000-000000000031', '13040000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1,
		clock_timestamp() - interval '9 days', clock_timestamp() + interval '1 day');
	insert into public.qorpera_model_login_versions(login_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, origin, access_issued_at, access_expires_at, created_at)
	select login.id, 1, login.broker_authority_id, 'vault-root-1', ('company-envelope-' || login.id)::bytea,
		encode(sha256(('company-envelope-' || login.id)::bytea), 'hex'), 'sign_in', login.access_issued_at,
		login.access_expires_at, clock_timestamp() - interval '1 day'
	from public.qorpera_model_logins as login
	where login.id in ('13040000-0000-4000-8000-000000000200', '13040000-0000-4000-8000-000000000201');
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider,
		created_by_user_id)
	values ('13040000-0000-4000-8000-000000000061', '92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		'92400000-0000-4000-8000-000000000001', 'openai', '92400000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connection_versions(connection_id, version, authentication_mode, native_harness,
		billing_source, consent_version, consented_by_user_id, allow_autonomous, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency)
	values ('13040000-0000-4000-8000-000000000061', 1, 'native_subscription', 'codex-cli', 'personal_subscription',
		'qorpera-native-provider-autonomous-consent/v1', '92400000-0000-4000-8000-000000000001', true,
		'{"monthly_microusd":1,"reservation_microusd":1,"max_calls_per_run":128,"max_input_tokens_per_run":100000000,"max_output_tokens_per_run":100000000,"max_concurrent_runs":32}',
		'92400000-0000-4000-8000-000000000001', '13040000-0000-4000-8000-000000000031', 'active', 32);
	perform pg_temp.base_assert((public.qorpera_capsule_model_login(v_capsule)).id = '13040000-0000-4000-8000-000000000200',
		'the run''s capsule is a company login''s now');
	perform pg_temp.base_assert(not pg_temp.sr_a_waits(), 'the company login holds nothing before a refusal');
	perform pg_temp.sr_refuse(current_setting('qorpera_test.base_binding')::jsonb);
	perform pg_temp.base_assert((pg_temp.sr_login('13040000-0000-4000-8000-000000000200')).refused_version = 1
		and (pg_temp.sr_login('13040000-0000-4000-8000-000000000201')).refused_version is null
		and (pg_temp.sr_login()).refused_version is null,
		'a refusal on a run of a company login''s capsule marks that login, and no other');
	perform pg_temp.base_assert(pg_temp.sr_a_waits(), 'new work the company login pays for waits');
end $$;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.sr_company_idle', pg_temp.sr_company_idle()::text, true) \g /dev/null
reset session authorization;
select pg_temp.base_assert(current_setting('qorpera_test.sr_company_idle')::jsonb ->> 'loginId'
		= '13040000-0000-4000-8000-000000000200',
	'the company''s idle pass renews the refused login before one closer to its end: '
		|| current_setting('qorpera_test.sr_company_idle'));
do $$
declare v_login public.qorpera_model_logins;
begin
	update public.qorpera_model_logins set login_kind = 'chatgpt_plan', renewal_token = null, renewal_until = null,
		renew_not_before = clock_timestamp() + interval '40 minutes'
	where id = '13040000-0000-4000-8000-000000000200';
	v_login := pg_temp.sr_login('13040000-0000-4000-8000-000000000200');
	perform pg_temp.base_assert(v_login.refused_version = v_login.current_version
		and not public.qorpera_model_login_renewal_due(v_login, clock_timestamp(), false)
		and not public.qorpera_model_login_renewal_due(v_login, clock_timestamp(), true),
		'a refused plan pass is not due before OpenAI''s earliest renewal time');
	update public.qorpera_model_logins set renew_not_before = clock_timestamp() - interval '1 second'
	where id = '13040000-0000-4000-8000-000000000200';
	v_login := pg_temp.sr_login('13040000-0000-4000-8000-000000000200');
	perform pg_temp.base_assert(public.qorpera_model_login_renewal_due(v_login, clock_timestamp(), false)
		and public.qorpera_model_login_renewal_due(v_login, clock_timestamp(), true),
		'and due at once after it');
	update public.qorpera_model_logins set refused_version = null, refused_at = null
	where id = '13040000-0000-4000-8000-000000000200';
	perform pg_temp.base_assert(not public.qorpera_model_login_renewal_due(
			pg_temp.sr_login('13040000-0000-4000-8000-000000000200'), clock_timestamp(), true),
		'a plan pass nobody refused keeps its own rule');
end $$;
rollback to savepoint sr_company_login;

do $$
declare v_receipt jsonb; v_login public.qorpera_model_logins;
begin
	v_receipt := pg_temp.sr_refuse(current_setting('qorpera_test.base_binding')::jsonb);
	v_login := pg_temp.sr_login();
	perform pg_temp.base_assert(v_receipt ->> 'signalKind' = 'sign_in_refused' and v_receipt ->> 'replayed' = 'false'
		and v_receipt -> 'notifiedUserIds' = '[]'::jsonb, 'the refusal is a signal of its own: ' || v_receipt::text);
	perform pg_temp.base_assert(v_login.refused_version = 1 and v_login.refused_at is not null
		and v_login.status = 'active' and v_login.current_version = 1, 'the login''s pass is marked refused');
	perform pg_temp.base_assert((pg_temp.sr_login('13040000-0000-4000-8000-000000000101')).refused_version is null,
		'the member''s fresh sign-in is never marked');
	perform pg_temp.base_assert(public.qorpera_model_login_renewal_due(v_login, clock_timestamp(), false)
		and public.qorpera_model_login_renewal_due(v_login, clock_timestamp(), true), 'its renewal is due now');
	perform pg_temp.base_assert(pg_temp.sr_a_waits() and pg_temp.sr_b_waits(),
		'new work on the login waits in every company it is linked into');
	perform pg_temp.base_assert(pg_temp.sr_refuse(current_setting('qorpera_test.base_binding')::jsonb) ->> 'replayed' = 'true'
		and (pg_temp.sr_login()).refused_at = v_login.refused_at, 'a repeat changes nothing');
end $$;

savepoint sr_company_deleted;
delete from public.qorpera_profile_members
where profile_id = '92400000-0000-4000-8000-000000000010' and user_id <> '92400000-0000-4000-8000-000000000001';
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_delete_hosted_profile('92400000-0000-4000-8000-000000000010') \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
select public.qorpera_purge_company('92400000-0000-4000-8000-000000000010') \g /dev/null
do $$
begin
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_profiles
			where id = '92400000-0000-4000-8000-000000000010')
		and not exists (select 1 from public.qorpera_provider_connection_usage_signals
			where profile_id = '92400000-0000-4000-8000-000000000010'),
		'the company that reported the refusal is deleted, its signal with it');
	perform pg_temp.base_assert(pg_temp.sr_b_waits() and (pg_temp.sr_login()).refused_version = 1,
		'the hold is the login''s: deleting the company that reported it does not end it');
end $$;
rollback to savepoint sr_company_deleted;

savepoint sr_hold_lapses;
do $$
begin
	update public.qorpera_model_logins set refused_at = clock_timestamp() - interval '31 minutes'
	where id = '13040000-0000-4000-8000-000000000100';
	perform pg_temp.base_assert(not pg_temp.sr_b_waits()
		and public.qorpera_model_login_renewal_due(pg_temp.sr_login(), clock_timestamp(), true),
		'after half an hour new work starts again, and the renewal stays due');
end $$;
rollback to savepoint sr_hold_lapses;

savepoint sr_revoked;
do $$
begin
	update public.qorpera_model_logins set status = 'revoked' where id = '13040000-0000-4000-8000-000000000100';
	perform pg_temp.sr_refuse(current_setting('qorpera_test.base_binding')::jsonb);
	perform pg_temp.base_assert((pg_temp.sr_login()).status = 'revoked' and not pg_temp.sr_b_waits(),
		'a revoked login stays revoked and holds nothing');
end $$;
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sr_idle() -> 'renewal' = 'null'::jsonb, 'a revoked login is never renewed');
reset session authorization;
rollback to savepoint sr_revoked;

savepoint sr_run_renews;
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.sr_issue', pg_temp.sr_issue(true)::text, true) \g /dev/null
reset session authorization;
select pg_temp.base_assert(current_setting('qorpera_test.sr_issue')::jsonb #>> '{renewal,baseVersion}' = '1',
	'the next run''s login takes the renewal lock at once: ' || current_setting('qorpera_test.sr_issue'));
rollback to savepoint sr_run_renews;

set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.sr_idle', pg_temp.sr_idle()::text, true) \g /dev/null
reset session authorization;
select pg_temp.base_assert(current_setting('qorpera_test.sr_idle')::jsonb ->> 'loginId' = '13040000-0000-4000-8000-000000000100'
	and current_setting('qorpera_test.sr_idle')::jsonb #>> '{renewal,baseVersion}' = '1',
	'the vault''s idle pass renews the refused login first, never the fresh one: ' || current_setting('qorpera_test.sr_idle'));
select set_config('qorpera_test.sr_token', current_setting('qorpera_test.sr_idle')::jsonb #>> '{renewal,token}', true)
	\g /dev/null

savepoint sr_renewed;
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sr_commit(current_setting('qorpera_test.sr_token')) ->> 'version' = '2',
	'the renewal is saved through the one lock');
reset session authorization;
do $$
begin
	perform pg_temp.base_assert((pg_temp.sr_login()).current_version = 2 and (pg_temp.sr_login()).status = 'active'
		and not pg_temp.sr_b_waits() and not pg_temp.sr_a_waits()
		and not public.qorpera_model_login_renewal_due(pg_temp.sr_login(), clock_timestamp(), true),
		'a good renewal ends the hold, and the new pass is not due');
end $$;
do $$
declare v_job public.qorpera_runner_jobs; v_pause jsonb; v_activity jsonb; v_next jsonb;
begin
	perform pg_temp.sr_turned_away(current_setting('qorpera_test.base_binding')::jsonb);
	select * into strict v_job from public.qorpera_runner_jobs where run_id = pg_temp.rr_run();
	perform pg_temp.base_assert(v_job.status = 'queued' and v_job.attempt_count = 0
		and v_job.dispatch_deferred_until between statement_timestamp() + interval '48 seconds'
			and statement_timestamp() + interval '72 seconds',
		'the member''s message waits about a minute and tries again: ' || to_jsonb(v_job)::text);
	select payload into strict v_pause from public.qorpera_execution_run_events
	where run_id = pg_temp.rr_run() and event_type = 'run_paused';
	perform pg_temp.base_assert(v_pause ->> 'pausedFor' = 'sign_in_refused', 'it waits for the sign-in: ' || v_pause::text);
	v_activity := pg_temp.sr_activity();
	perform pg_temp.base_assert(v_activity ->> 'paused_for' = 'sign_in_refused' and v_activity -> 'movable' = 'false',
		'its activity says so, and it never moves to another login: ' || coalesce(v_activity::text, 'none'));
	update public.qorpera_runner_jobs set dispatch_deferred_until = clock_timestamp() - interval '1 second',
		queued_at = clock_timestamp() - interval '1 second'
	where id = v_job.id;
	v_next := pg_temp.base_start(pg_temp.rr_run());
	perform pg_temp.base_assert((select lease.provider_connection_id = sponsor.provider_connection_id
			from public.qorpera_native_provider_connection_leases as lease
			join public.qorpera_execution_runs as run on run.id = lease.run_id
			join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = run.sponsor_binding_id
				and sponsor.version = run.sponsor_version
			where lease.id = (v_next ->> 'leaseId')::uuid)
		and (select capsule.encrypted_capsule_reference from public.qorpera_native_credential_capsules as capsule
			where capsule.id = (v_next ->> 'credentialCapsuleId')::uuid)
			= 'model-login/13040000-0000-4000-8000-000000000100',
		'the next attempt runs on the same login');
end $$;
rollback to savepoint sr_renewed;

set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.sr_release(current_setting('qorpera_test.sr_token'), true) ->> 'status' = 'needs_sign_in',
	'a refused renewal asks for a new sign-in');
reset session authorization;
do $$
declare v_job public.qorpera_runner_jobs; v_recovery jsonb;
begin
	perform pg_temp.base_assert((pg_temp.sr_login('13040000-0000-4000-8000-000000000101')).status = 'active'
		and (pg_temp.sr_login('13040000-0000-4000-8000-000000000101')).refused_version is null,
		'the fresh sign-in is never marked');
	perform pg_temp.base_assert(not pg_temp.sr_b_waits() and not pg_temp.sr_a_waits(),
		'the hold ends once the login needs a new sign-in');
	perform pg_temp.base_assert(pg_temp.sr_login_status() = 'needs_sign_in', 'the member''s list says the login needs a new sign-in');
	perform pg_temp.sr_turned_away(current_setting('qorpera_test.base_binding')::jsonb);
	select * into strict v_job from public.qorpera_runner_jobs where run_id = pg_temp.rr_run();
	perform pg_temp.base_assert(v_job.status = 'failed' and pg_temp.rr_events(pg_temp.rr_run(), 'run_paused') = 0,
		'a message on a login that needs a new sign-in does not wait for nothing');
	v_recovery := pg_temp.sr_recovery();
	perform pg_temp.base_assert(v_recovery -> 'sign_in_refused' = 'true' and v_recovery -> 'rate_limited' = 'false'
		and v_recovery -> 'usage_limit' = 'false', 'its recovery says ChatGPT no longer accepts the sign-in: ' || v_recovery::text);
end $$;

set constraints all immediate;
rollback;
