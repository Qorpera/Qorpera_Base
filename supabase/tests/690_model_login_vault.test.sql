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
grant execute on function pg_temp.expect(text,text,text), pg_temp.issue(uuid,text,jsonb,bigint,boolean),
	pg_temp.commit_renewal(text,uuid,bigint,bytea), pg_temp.release_renewal(uuid,boolean) to qorpera_secret_broker;

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
	'40001:model login renewal lock is not held','the same lock cannot save twice');
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

-- A failed renewal gives the lock back; a permanent failure asks for a new sign-in and the
-- login stops being handed out.
update public.qorpera_model_logins set access_issued_at = clock_timestamp() - interval '6 days',
	access_expires_at = clock_timestamp() + interval '4 days'
where id = '69000000-0000-4000-8000-000000000050';
set local session authorization qorpera_secret_broker;
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select pg_temp.expect(pg_temp.release_renewal(
	(current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}')::uuid,false),'true','a transient failure');
select pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true);
select pg_temp.expect((current_setting('qorpera_test.vault_issue')::jsonb -> 'renewal' is not null)::text,'true',
	'the next caller may try again');
select pg_temp.expect(pg_temp.release_renewal(
	(current_setting('qorpera_test.vault_issue')::jsonb #>> '{renewal,token}')::uuid,true),'true','a permanent failure');
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,2,true),
	'55000:model login needs a new sign-in','a login that needs a new sign-in is not handed out');
reset session authorization;

-- A released lease no longer reaches the login.
update public.qorpera_model_logins set status = 'active' where id = '69000000-0000-4000-8000-000000000050';
update public.qorpera_native_provider_connection_leases set status = 'released', released_at = clock_timestamp()
where id = (current_setting('qorpera_test.vault_binding')::jsonb ->> 'leaseId')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.expect(pg_temp.issue('69000000-0000-4000-8000-000000000040',repeat('c',64),
	current_setting('qorpera_test.vault_binding')::jsonb,null,false),
	'42501:model login run binding is unavailable','a released lease');
reset session authorization;

rollback;
