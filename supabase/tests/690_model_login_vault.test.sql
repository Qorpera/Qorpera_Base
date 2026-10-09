-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Stateless Compute step 1 (change 1) on folder-v2: a model login kept by the vault is handed only to its own company's
-- broker, for a live run's exact native lease. The service role cannot take a login and no API role reads login rows; a
-- forged capability, another company's broker, a binding off by one id or with an extra key, and a run the lease
-- validator would stop (a paused company, an expired job lease or assignment, a disabled identity, a revoked capsule, a
-- released lease) get no login. The run is 924's live run of Alice's (ported from snapshot-v1 in the legacy sweep).

-- The run's binding as the host sends it, the company's broker, a second company's broker, and the login the vault
-- keeps for the run's capsule (version 1).
select set_config('qorpera_test.mv_binding',
	(current_setting('qorpera_test.base_binding')::jsonb - 'provider' - 'nativeHarness' - 'model')::text, true);
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('69000000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('69000000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test', 'company-kek-1', repeat('c', 64)),
	('69000000-0000-4000-8000-000000000041', '69000000-0000-4000-8000-000000000010', 'https://secrets.qorpera.test', 'other-kek-1', repeat('d', 64));
insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id,
	provider, native_harness, current_version, access_issued_at, access_expires_at)
select '69000000-0000-4000-8000-000000000050', identity.profile_id, identity.id, capsule.id,
	'69000000-0000-4000-8000-000000000040', 'openai', 'codex-cli', 1,
	clock_timestamp() - interval '10 minutes', clock_timestamp() + interval '10 days'
from public.qorpera_native_credential_capsules capsule
join public.qorpera_member_compute_identities identity on identity.id = capsule.compute_identity_id
where capsule.id = (current_setting('qorpera_test.mv_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
insert into public.qorpera_model_login_versions(login_id, version, broker_authority_id, key_id, encrypted_envelope,
	envelope_sha256, origin, access_issued_at, access_expires_at)
select login.id, 1, login.broker_authority_id, 'company-kek-1', 'envelope-v1'::bytea,
	encode(extensions.digest('envelope-v1'::bytea, 'sha256'), 'hex'), 'sign_in', login.access_issued_at, login.access_expires_at
from public.qorpera_model_logins login where login.id = '69000000-0000-4000-8000-000000000050';

create function pg_temp.mv_expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.mv_issue(p_authority uuid, p_capability text, p_binding jsonb)
returns text language plpgsql as $$
begin
	perform public.qorpera_issue_model_login(p_authority, p_capability, p_binding, null, false);
	return 'issued';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.mv_refused(p_label text) returns void language plpgsql as $$
begin
	perform pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('c', 64),
		current_setting('qorpera_test.mv_binding')::jsonb), '42501:model login run binding is unavailable', p_label);
end $$;
grant execute on function pg_temp.mv_expect(text,text,text), pg_temp.mv_issue(uuid,text,jsonb), pg_temp.mv_refused(text)
	to qorpera_secret_broker, service_role;

-- 1. Only a broker may call; the service role may not, and no API role or the broker reads login rows directly.
set local role service_role;
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('c', 64),
	current_setting('qorpera_test.mv_binding')::jsonb),
	'42501:permission denied for function qorpera_issue_model_login', 'the service role cannot take a login');
reset role;
do $$ begin
	if has_table_privilege('service_role', 'public.qorpera_model_logins', 'select')
		or has_table_privilege('qorpera_secret_broker', 'public.qorpera_model_login_versions', 'select')
		or has_table_privilege('authenticated', 'public.qorpera_model_login_versions', 'select') then
		raise exception 'login rows are readable outside the vault functions'; end if;
end $$;

-- 2. The live run gets its login from its company's broker; a forged capability, another company's broker, a binding
-- that is off by one id and a binding with an extra key get none.
set local session authorization qorpera_secret_broker;
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('c', 64),
	current_setting('qorpera_test.mv_binding')::jsonb), 'issued', 'a live run gets its login');
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('e', 64),
	current_setting('qorpera_test.mv_binding')::jsonb),
	'42501:cloud secret broker authority is unavailable', 'a forged capability');
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000041', repeat('d', 64),
	current_setting('qorpera_test.mv_binding')::jsonb),
	'42501:model login is unavailable to this broker', 'another company''s broker');
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('c', 64),
	jsonb_set(current_setting('qorpera_test.mv_binding')::jsonb, '{assignmentId}', '"69000000-0000-4000-8000-0000000000ff"')),
	'42501:model login run binding is unavailable', 'another assignment');
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('c', 64),
	current_setting('qorpera_test.mv_binding')::jsonb || '{"model":"gpt-native"}'),
	'22023:model login run binding is invalid', 'an extra binding key');
reset session authorization;

-- 3. The run check matches the lease validator: a paused company, an expired job lease or assignment, a disabled
-- identity, a revoked capsule or a released lease gets no login. Each is shown in a savepoint and undone.
savepoint mv_paused;
insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
set local session authorization qorpera_secret_broker;
select pg_temp.mv_refused('a paused company');
reset session authorization;
rollback to savepoint mv_paused;
savepoint mv_job_expired;
update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.mv_binding')::jsonb ->> 'jobId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mv_refused('an expired job lease');
reset session authorization;
rollback to savepoint mv_job_expired;
savepoint mv_assignment_expired;
update public.qorpera_runner_assignments set expires_at = clock_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.mv_binding')::jsonb ->> 'assignmentId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mv_refused('an expired assignment');
reset session authorization;
rollback to savepoint mv_assignment_expired;
savepoint mv_identity_disabled;
update public.qorpera_member_compute_identities set status = 'disabled'
where id = (current_setting('qorpera_test.mv_binding')::jsonb ->> 'computeIdentityId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mv_refused('a disabled identity');
reset session authorization;
rollback to savepoint mv_identity_disabled;
savepoint mv_capsule_revoked;
update public.qorpera_native_credential_capsules set status = 'revoked', revoked_at = clock_timestamp()
where id = (current_setting('qorpera_test.mv_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mv_refused('a revoked capsule');
reset session authorization;
rollback to savepoint mv_capsule_revoked;
-- Still handed out with nothing changed; then the lease is released.
set local session authorization qorpera_secret_broker;
select pg_temp.mv_expect(pg_temp.mv_issue('69000000-0000-4000-8000-000000000040', repeat('c', 64),
	current_setting('qorpera_test.mv_binding')::jsonb), 'issued', 'the unchanged run still gets its login');
reset session authorization;
update public.qorpera_native_provider_connection_leases set status = 'released', released_at = clock_timestamp()
where id = (current_setting('qorpera_test.mv_binding')::jsonb ->> 'leaseId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.mv_refused('a released lease');
reset session authorization;

rollback;
