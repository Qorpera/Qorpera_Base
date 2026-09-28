-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Stateless Compute step 1 (change 1): a model login kept by the vault. A live run gets its
-- login through its exact native lease; only one renewal at a time holds a login's lock;
-- a renewal is saved only by the lock holder on the version it renewed from.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
do $$
declare v_run_id uuid := (current_setting('qorpera_test.own_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_claim jsonb; v_runner jsonb; v_assignment jsonb; v_native jsonb; v_runner_id uuid; v_job_id uuid;
begin
	v_claim := public.qorpera_claim_runner_job_for_orchestrator(
		'16000000-0000-4000-8000-000000000092','69000000-0000-4000-8000-0000000000d1',120);
	if (v_claim -> 'work' ->> 'run_id')::uuid is distinct from v_run_id then
		raise exception 'fixture did not claim the member-native turn'; end if;
	v_job_id := (v_claim -> 'work' ->> 'job_id')::uuid;
	v_runner := public.qorpera_provision_execution_runner(v_run_id,'69000000-0000-4000-8000-0000000000d2','process',repeat('4',64));
	v_runner_id := (v_runner ->> 'runner_id')::uuid;
	perform public.qorpera_activate_runner(v_runner_id,repeat('4',64),repeat('5',64),'linux','model-login-vault-test');
	v_assignment := public.qorpera_assign_runner_job('16000000-0000-4000-8000-000000000092',(v_claim ->> 'claim_id')::uuid,
		v_runner_id,'69000000-0000-4000-8000-0000000000d3',repeat('6',64),120);
	perform public.qorpera_accept_runner_assignment(v_runner_id,repeat('5',64),(v_assignment ->> 'assignment_id')::uuid,
		v_job_id,repeat('6',64));
	v_native := public.qorpera_acquire_native_provider_connection_lease(v_run_id,v_runner_id,repeat('5',64),
		(v_assignment ->> 'assignment_id')::uuid,repeat('6',64),120);
	perform set_config('qorpera_test.vault_binding',jsonb_build_object(
		'leaseId',v_native ->> 'lease_id','runId',v_run_id,'jobId',v_job_id,'runnerId',v_runner_id,
		'assignmentId',v_assignment ->> 'assignment_id','credentialCapsuleId',v_native ->> 'credential_capsule_id',
		'computeIdentityId',v_native ->> 'compute_identity_id')::text,false);
end $$;
reset role;

-- The company's broker, a second company's broker, and the login the vault keeps for the
-- fixture's capsule (version 1, a pass issued 10 minutes ago that lasts 10 days).
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('69000000-0000-4000-8000-000000000010','Other company','16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69000000-0000-4000-8000-000000000040','16000000-0000-4000-8000-000000000010','https://secrets.qorpera.test','company-kek-1',repeat('c',64)),
	('69000000-0000-4000-8000-000000000041','69000000-0000-4000-8000-000000000010','https://secrets.qorpera.test','other-kek-1',repeat('d',64));
insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
	provider,native_harness,current_version,access_issued_at,access_expires_at)
select '69000000-0000-4000-8000-000000000050',identity.profile_id,identity.id,capsule.id,
	'69000000-0000-4000-8000-000000000040','openai','codex-cli',1,
	clock_timestamp() - interval '10 minutes',clock_timestamp() + interval '10 days'
from public.qorpera_native_credential_capsules capsule
join public.qorpera_member_compute_identities identity on identity.id = capsule.compute_identity_id
where capsule.id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
insert into public.qorpera_model_login_versions(login_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,origin,access_issued_at,access_expires_at)
select login.id,1,login.broker_authority_id,'company-kek-1','envelope-v1'::bytea,
	encode(extensions.digest('envelope-v1'::bytea,'sha256'),'hex'),'sign_in',login.access_issued_at,login.access_expires_at
from public.qorpera_model_logins login where login.id = '69000000-0000-4000-8000-000000000050';

create function pg_temp.expect(p_actual text, p_expected text, p_label text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;
create function pg_temp.issue(p_authority uuid, p_capability text, p_binding jsonb, p_known bigint, p_renew boolean)
returns text language plpgsql as $$
declare v_result jsonb;
begin
	v_result := public.qorpera_issue_model_login(p_authority,p_capability,p_binding,p_known,p_renew);
	perform set_config('qorpera_test.vault_issue',v_result::text,false);
	return 'issued';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.commit_renewal(p_capability text, p_token uuid, p_base bigint, p_envelope bytea)
returns text language plpgsql as $$
begin
	perform public.qorpera_commit_model_login_renewal('69000000-0000-4000-8000-000000000040',p_capability,
		'69000000-0000-4000-8000-000000000050',p_token,p_base,'company-kek-1',encode(p_envelope,'base64'),
		encode(sha256(p_envelope),'hex'),clock_timestamp(),clock_timestamp() + interval '10 days');
	return 'committed';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.release_renewal(p_token uuid, p_permanent boolean)
returns text language plpgsql as $$
begin
	return public.qorpera_release_model_login_renewal('69000000-0000-4000-8000-000000000040',repeat('c',64),
		'69000000-0000-4000-8000-000000000050',p_token,p_permanent,'provider_refused') ->> 'released';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
create function pg_temp.commit_raw(p_token uuid, p_base bigint, p_key text, p_envelope_base64 text, p_sha text,
	p_issued timestamptz, p_expires timestamptz)
returns text language plpgsql as $$
begin
	perform public.qorpera_commit_model_login_renewal('69000000-0000-4000-8000-000000000040',repeat('c',64),
		'69000000-0000-4000-8000-000000000050',p_token,p_base,p_key,p_envelope_base64,p_sha,p_issued,p_expires);
	return 'committed';
exception when others then return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.expect(text,text,text), pg_temp.issue(uuid,text,jsonb,bigint,boolean),
	pg_temp.commit_renewal(text,uuid,bigint,bytea), pg_temp.release_renewal(uuid,boolean),
	pg_temp.commit_raw(uuid,bigint,text,text,text,timestamptz,timestamptz) to qorpera_secret_broker;

-- Only the broker's own login may call; the service role and members may not.
set role service_role;
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,false),
	'42501:permission denied for function qorpera_issue_model_login','the service role cannot take a login');
reset role;
set role authenticated;
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,false),
	'42501:permission denied for function qorpera_issue_model_login','a member cannot take a login');
reset role;
do $$ begin
	if has_table_privilege('service_role','public.qorpera_model_logins','select')
		or has_table_privilege('qorpera_secret_broker','public.qorpera_model_login_versions','select')
		or has_table_privilege('authenticated','public.qorpera_model_login_versions','select') then
		raise exception 'login rows are readable outside the vault functions'; end if;
end $$;

set local session authorization qorpera_secret_broker;
-- A live run of the identity gets the current version; nothing renews while the pass is fresh.
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,true),'issued','a live run gets its login');
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'version','1','current version');
select pg_temp.expect(convert_from(decode(current_setting('qorpera_test.vault_issue')::jsonb ->> 'encryptedEnvelopeBase64','base64'),'utf8'),
	'envelope-v1','the stored envelope');
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'renewal',null,'no renewal for a fresh pass');
-- A host that already holds version 1 gets no envelope back.
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,1,true);
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'unchanged','true','known version is unchanged');
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'encryptedEnvelopeBase64',null,'no envelope when unchanged');

-- Refusals: a forged capability, another company's broker, a binding that is off by one id,
-- a binding with an extra key.
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('e',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,false),
	'42501:cloud secret broker authority is unavailable','a forged capability');
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000041',repeat('d',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,false),
	'42501:model login is unavailable to this broker','another company''s broker');
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	jsonb_set(current_setting('qorpera_test.vault_binding')::jsonb,'{assignmentId}','"69000000-0000-4000-8000-0000000000ff"'),null,false),
	'42501:model login run binding is unavailable','another assignment');
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb || '{"model":"gpt-native"}',null,false),
	'22023:model login run binding is invalid','an extra binding key');
reset session authorization;

-- Past half its pass life, the first caller takes the renewal lock; a second caller does
-- not, and sees that a renewal is running.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
-- A broker without a renewer never takes the lock.
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,1,false);
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'unchanged','true','no lock without renewal');
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'renewing','false','nothing is renewing');
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,1,true);
select set_config('qorpera_test.vault_renewal',current_setting('qorpera_test.vault_issue')::jsonb ->> 'renewal',false);
select pg_temp.expect(current_setting('qorpera_test.vault_renewal')::jsonb ->> 'baseVersion','1','renewal from version 1');
select pg_temp.expect(current_setting('qorpera_test.vault_renewal')::jsonb ->> 'keyId','company-kek-1','renewal under the current key');
select pg_temp.expect((current_setting('qorpera_test.vault_issue')::jsonb ? 'encryptedEnvelopeBase64')::text,'true',
	'the renewer gets the envelope');
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,1,true);
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'renewal',null,'a second caller gets no lock');
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'renewing','true','it sees the renewal running');

-- Only the holder may save, only on the version it renewed from, only with a matching digest.
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),'69000000-0000-4000-8000-0000000000ee',1,'envelope-v2'::bytea),
	'40001:model login renewal lock is not held','a caller without the lock');
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),
	(current_setting('qorpera_test.vault_renewal')::jsonb ->> 'token')::uuid,2,'envelope-v2'::bytea),
	'40001:model login renewal lock is not held','the wrong base version');
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),
	(current_setting('qorpera_test.vault_renewal')::jsonb ->> 'token')::uuid,1,'envelope-v2'::bytea),
	'committed','the lock holder saves version 2');
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),
	(current_setting('qorpera_test.vault_renewal')::jsonb ->> 'token')::uuid,1,'envelope-v2b'::bytea),
	'40001:model login renewal lock is not held','the same lock cannot save a second, different login');
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),
	(current_setting('qorpera_test.vault_renewal')::jsonb ->> 'token')::uuid,1,'envelope-v2'::bytea),
	'committed','repeating the save after a lost answer finds it saved');
-- A host that knew version 1 now gets version 2.
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,1,true);
select pg_temp.expect(current_setting('qorpera_test.vault_issue')::jsonb ->> 'version','2','a newer version for the host');
select pg_temp.expect(convert_from(decode(current_setting('qorpera_test.vault_issue')::jsonb ->> 'encryptedEnvelopeBase64','base64'),'utf8'),
	'envelope-v2','the renewed envelope');
reset session authorization;
do $$ begin
	if (select count(*) from public.qorpera_model_login_versions where login_id = '69000000-0000-4000-8000-000000000050') <> 2
		or exists (select 1 from public.qorpera_model_logins where id = '69000000-0000-4000-8000-000000000050'
			and (renewal_token is not null or current_version <> 2)) then
		raise exception 'the renewal did not leave exactly two versions and a free lock'; end if;
end $$;

-- A failed renewal gives the lock back. The next try waits (1, 2, 4 ... minutes); a
-- permanent failure asks for a new sign-in and the login stops being handed out.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select pg_temp.expect(pg_temp.release_renewal('69000000-0000-4000-8000-0000000000ee',false),'false',
	'another caller cannot give the lock back');
select pg_temp.expect(pg_temp.release_renewal(
	(current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}')::uuid,false),'true','a transient failure');
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select pg_temp.expect((current_setting('qorpera_test.vault_issue')::jsonb -> 'renewal' is not null)::text,'false',
	'no second try within a minute of a failure');
reset session authorization;
update public.qorpera_model_logins set renewal_failed_at = clock_timestamp() - interval '2 minutes'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select pg_temp.expect((current_setting('qorpera_test.vault_issue')::jsonb -> 'renewal' is not null)::text,'true',
	'a later caller may try again');
select pg_temp.expect(pg_temp.release_renewal(
	(current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}')::uuid,true),'true','a permanent failure');
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true),
	'55000:model login needs a new sign-in','a login that needs a new sign-in is not handed out');
reset session authorization;

-- A lapsed lock taken over by another caller: the old holder can neither save nor give it
-- back, the new holder saves. A lapsed lock nobody took is still its holder's to save.
update public.qorpera_model_logins set status = 'active', renewal_failures = 0, renewal_failed_at = null,
	access_issued_at = clock_timestamp() - interval '6 days', access_expires_at = clock_timestamp() + interval '4 days'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select set_config('qorpera_test.old_token',current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}',false);
reset session authorization;
update public.qorpera_model_logins set renewal_until = clock_timestamp() - interval '1 second'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select set_config('qorpera_test.new_token',current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}',false);
select pg_temp.expect((current_setting('qorpera_test.new_token') <> current_setting('qorpera_test.old_token'))::text,'true',
	'a lapsed lock is taken with a new token');
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),current_setting('qorpera_test.old_token')::uuid,2,'envelope-v3-old'::bytea),
	'40001:model login renewal lock is not held','the old holder cannot save');
select pg_temp.expect(pg_temp.release_renewal(current_setting('qorpera_test.old_token')::uuid,false),'false',
	'the old holder cannot give the lock back');
reset session authorization;
update public.qorpera_model_logins set renewal_until = clock_timestamp() - interval '1 second'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.expect(pg_temp.commit_renewal(repeat('c',64),current_setting('qorpera_test.new_token')::uuid,2,'envelope-v3'::bytea),
	'committed','a lapsed lock nobody took is still its holder''s to save');

-- A save must name the current key, match its digest, keep sane times and bring a later pass.
reset session authorization;
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,3,true);
select set_config('qorpera_test.token',current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}',false);
select pg_temp.expect(pg_temp.commit_raw(current_setting('qorpera_test.token')::uuid,3,'other-kek-1',
	encode('envelope-v4'::bytea,'base64'),encode(sha256('envelope-v4'::bytea),'hex'),clock_timestamp(),clock_timestamp() + interval '10 days'),
	'22023:model login renewal is invalid','another key');
select pg_temp.expect(pg_temp.commit_raw(current_setting('qorpera_test.token')::uuid,3,'company-kek-1',
	encode('envelope-v4'::bytea,'base64'),repeat('0',64),clock_timestamp(),clock_timestamp() + interval '10 days'),
	'22023:model login renewal is invalid','a digest that does not match');
select pg_temp.expect(pg_temp.commit_raw(current_setting('qorpera_test.token')::uuid,3,'company-kek-1',
	encode('envelope-v4'::bytea,'base64'),encode(sha256('envelope-v4'::bytea),'hex'),clock_timestamp(),clock_timestamp() - interval '1 second'),
	'22023:model login renewal is invalid','a pass that has already ended');
select pg_temp.expect(pg_temp.commit_raw(current_setting('qorpera_test.token')::uuid,3,'company-kek-1',
	encode('envelope-v4'::bytea,'base64'),encode(sha256('envelope-v4'::bytea),'hex'),clock_timestamp() + interval '1 hour',clock_timestamp() + interval '10 days'),
	'22023:model login renewal is invalid','a pass issued in the future');
select pg_temp.expect(pg_temp.commit_raw(current_setting('qorpera_test.token')::uuid,3,'company-kek-1',
	encode('envelope-v4'::bytea,'base64'),encode(sha256('envelope-v4'::bytea),'hex'),clock_timestamp(),clock_timestamp() + interval '1 day'),
	'40001:model login renewal lock is not held','a pass that ends sooner than the current one');
reset session authorization;

-- The run check matches the lease validator: a paused company, an expired job lease or
-- assignment, a disabled identity, a revoked capsule or a released lease gets no login.
update public.qorpera_model_logins set renewal_token = null, renewal_until = null
where id = '69000000-0000-4000-8000-000000000050';
create function pg_temp.refused(p_label text) returns void language plpgsql as $$
begin
	perform pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
		current_setting('qorpera_test.vault_binding')::jsonb,null,false),
		'42501:model login run binding is unavailable',p_label);
end $$;
grant execute on function pg_temp.refused(text) to qorpera_secret_broker;
savepoint paused;
insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id)
values ('16000000-0000-4000-8000-000000000010','16000000-0000-4000-8000-000000000001');
set local session authorization qorpera_secret_broker;
select pg_temp.refused('a paused company');
reset session authorization;
rollback to savepoint paused;
savepoint job_expired;
update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'jobId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.refused('an expired job lease');
reset session authorization;
rollback to savepoint job_expired;
savepoint assignment_expired;
update public.qorpera_runner_assignments set expires_at = clock_timestamp() - interval '1 second'
where id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'assignmentId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.refused('an expired assignment');
reset session authorization;
rollback to savepoint assignment_expired;
savepoint identity_disabled;
update public.qorpera_member_compute_identities set status = 'disabled'
where id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'computeIdentityId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.refused('a disabled identity');
reset session authorization;
rollback to savepoint identity_disabled;
savepoint capsule_revoked;
update public.qorpera_native_credential_capsules set status = 'revoked', revoked_at = clock_timestamp()
where id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'credentialCapsuleId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.refused('a revoked capsule');
reset session authorization;
rollback to savepoint capsule_revoked;
-- Still handed out with nothing changed.
set local session authorization qorpera_secret_broker;
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,false),'issued','the unchanged run still gets its login');
reset session authorization;
update public.qorpera_native_provider_connection_leases set status = 'released', released_at = clock_timestamp()
where id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'leaseId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.refused('a released lease');
reset session authorization;

rollback;
