-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the Step 2 authority/receipt RPCs using this real admitted native run."
-- Stateless Compute step 1, vault upkeep: a member's old node Codex login is switched off by itself once
-- the member signed in to the vault with the same ChatGPT account (20260928241000). The broker records
-- each vault login's account; while the company takes sign-ins in the vault, it moves the old login's
-- pins to the vault login, waits for the old login's work, then revokes it as Disconnect does. Another
-- account, a newer node login and a company switched back are left alone.
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
select set_config('qorpera_test.so_company', '16000000-0000-4000-8000-000000000010', false);
select set_config('qorpera_test.so_identity', current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id', false);
select set_config('qorpera_test.so_node', current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id', false);
select set_config('qorpera_test.so_binding', current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id', false);
select set_config('qorpera_test.so_account', encode(sha256(convert_to('openai-account:account-1', 'utf8')), 'hex'), false);
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69600000-0000-4000-8000-000000000040','16000000-0000-4000-8000-000000000010','https://secrets.qorpera.test','company-kek-1',repeat('c',64));
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('69600000-0000-4000-8000-000000000010','Other company','16000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('69600000-0000-4000-8000-000000000041','69600000-0000-4000-8000-000000000010','https://other.qorpera.test','other-kek-1',repeat('d',64));

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
	from (select public.qorpera_switch_off_replaced_node_logins('69600000-0000-4000-8000-000000000040', repeat('c',64)) as result) pass
$$;
-- A node connection of the member (a node capsule), created now.
create function pg_temp.so_node_login(p_connection uuid, p_capsule uuid)
returns void language plpgsql as $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = current_setting('qorpera_test.so_identity')::uuid;
	insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
		owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
	values (p_capsule,v_identity.profile_id,v_identity.id,v_identity.ownership_kind,v_identity.owner_user_id,
		v_identity.owner_scope_key,'openai','codex-cli','capsule/' || p_capsule::text,repeat('a',64),v_identity.owner_user_id);
	insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, owner_user_id, provider, created_by_user_id, created_at)
	values (p_connection, v_identity.profile_id, p_connection, v_identity.owner_user_id, 'openai', v_identity.owner_user_id, clock_timestamp());
	insert into public.qorpera_provider_connection_versions(connection_id,version,authentication_mode,native_harness,
		secret_reference,provider_account_reference,provider_account_email,billing_source,consent_version,
		consented_by_user_id,allow_autonomous,commercial_approval_reference,quota_policy,created_by_user_id,
		credential_capsule_id,authorization_state,max_native_concurrency)
	select p_connection, 1, 'native_subscription','codex-cli',null,null,null,'personal_subscription',
		'qorpera-native-subscription-v1',v_identity.owner_user_id,true,previous.commercial_approval_reference,
		previous.quota_policy,v_identity.owner_user_id,p_capsule,'active',previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = current_setting('qorpera_test.so_node')::uuid
	order by previous.version desc limit 1;
end $$;
grant execute on function pg_temp.so_expect(text,text,text), pg_temp.so_call(text), pg_temp.so_pass()
	to qorpera_secret_broker, service_role;

do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_model_logins_without_account(uuid,text)',
		'public.qorpera_record_model_login_account(uuid,text,uuid,text)',
		'public.qorpera_switch_off_replaced_node_logins(uuid,text)'] loop
		foreach v_role in array array['anon','authenticated','service_role'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '% is exposed to %', v_function, v_role; end if;
		end loop;
		if not has_function_privilege('qorpera_secret_broker', v_function, 'execute') then
			raise exception 'The broker cannot call %', v_function; end if;
	end loop;
end $$;

-- The node login has been read for usage: its account is recorded, as nodes record it.
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity)
select version.connection_id, version.version, current_setting('qorpera_test.so_account')
from public.qorpera_provider_connection_versions version
where version.connection_id = current_setting('qorpera_test.so_node')::uuid
order by version.version desc limit 1;

-- The member signs in to the vault: pointer capsule, vault login version 1, and a new connection (consented).
do $$
declare v_identity public.qorpera_member_compute_identities%rowtype;
	v_connection uuid;
begin
	select * into strict v_identity from public.qorpera_member_compute_identities
	where id = current_setting('qorpera_test.so_identity')::uuid;
	insert into public.qorpera_native_credential_capsules(id,profile_id,compute_identity_id,ownership_kind,owner_user_id,
		owner_scope_key,provider,native_harness,encrypted_capsule_reference,attestation_policy_sha256,created_by_user_id)
	values ('69600000-0000-4000-8000-000000000060',v_identity.profile_id,v_identity.id,v_identity.ownership_kind,
		v_identity.owner_user_id,v_identity.owner_scope_key,'openai','codex-cli','model-login/69600000-0000-4000-8000-000000000050',
		repeat('a',64),v_identity.owner_user_id);
	insert into public.qorpera_model_logins(id,profile_id,compute_identity_id,credential_capsule_id,broker_authority_id,
		provider,native_harness,current_version,access_issued_at,access_expires_at)
	values ('69600000-0000-4000-8000-000000000050',v_identity.profile_id,v_identity.id,'69600000-0000-4000-8000-000000000060',
		'69600000-0000-4000-8000-000000000040','openai','codex-cli',1,clock_timestamp(),clock_timestamp() + interval '10 days');
	insert into public.qorpera_model_login_versions(login_id,version,broker_authority_id,key_id,encrypted_envelope,
		envelope_sha256,origin,access_issued_at,access_expires_at)
	values ('69600000-0000-4000-8000-000000000050',1,'69600000-0000-4000-8000-000000000040','company-kek-1','envelope-one'::bytea,
		encode(sha256('envelope-one'::bytea),'hex'),'sign_in',clock_timestamp(),clock_timestamp() + interval '10 days');
	insert into public.qorpera_provider_connections(profile_id, client_connection_id, owner_user_id, provider, created_by_user_id, created_at)
	values (v_identity.profile_id, '69600000-0000-4000-8000-000000000080', v_identity.owner_user_id, 'openai',
		v_identity.owner_user_id, clock_timestamp())
	returning id into v_connection;
	insert into public.qorpera_provider_connection_versions(connection_id,version,authentication_mode,native_harness,
		secret_reference,provider_account_reference,provider_account_email,billing_source,consent_version,
		consented_by_user_id,allow_autonomous,commercial_approval_reference,quota_policy,created_by_user_id,
		credential_capsule_id,authorization_state,max_native_concurrency)
	select v_connection, 1, 'native_subscription','codex-cli',null,null,null,'personal_subscription',
		'qorpera-native-subscription-v1',v_identity.owner_user_id,true,previous.commercial_approval_reference,
		previous.quota_policy,v_identity.owner_user_id,'69600000-0000-4000-8000-000000000060','active',previous.max_native_concurrency
	from public.qorpera_provider_connection_versions previous
	where previous.connection_id = current_setting('qorpera_test.so_node')::uuid
	order by previous.version desc limit 1;
	perform set_config('qorpera_test.so_vault', v_connection::text, false);
end $$;

-- 1. The broker lists the vault login without an account, records it once, and refuses another account.
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_call($q$select (public.qorpera_model_logins_without_account(
		'69600000-0000-4000-8000-000000000040', repeat('c',64)) -> 'logins' -> 0 ->> 'loginId')$q$),
	'69600000-0000-4000-8000-000000000050', 'a vault login without an account is listed');
select pg_temp.so_expect(pg_temp.so_call($q$select convert_from(decode(public.qorpera_model_logins_without_account(
		'69600000-0000-4000-8000-000000000040', repeat('c',64)) -> 'logins' -> 0 ->> 'encryptedEnvelopeBase64', 'base64'), 'utf8')$q$),
	'envelope-one', 'with its current version to read it from');
select pg_temp.so_expect(pg_temp.so_call($q$select jsonb_array_length(public.qorpera_model_logins_without_account(
		'69600000-0000-4000-8000-000000000041', repeat('d',64)) -> 'logins')::text$q$), '0', 'another broker lists none of it');
select pg_temp.so_expect(pg_temp.so_call(format($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000041',
		repeat('d',64), '69600000-0000-4000-8000-000000000050', %L) ->> 'recorded'$q$, current_setting('qorpera_test.so_account'))),
	'42501:model login is unavailable to this broker', 'another broker cannot record it');
select pg_temp.so_expect(pg_temp.so_call($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000040',
		repeat('c',64), '69600000-0000-4000-8000-000000000050', 'not-a-digest') ->> 'recorded'$q$),
	'22023:model login account is invalid', 'an account that is no digest');
select pg_temp.so_expect(pg_temp.so_call(format($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000040',
		repeat('c',64), '69600000-0000-4000-8000-000000000050', %L) ->> 'recorded'$q$, current_setting('qorpera_test.so_account'))),
	'true', 'the account is recorded');
select pg_temp.so_expect(pg_temp.so_call(format($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000040',
		repeat('c',64), '69600000-0000-4000-8000-000000000050', %L) ->> 'recorded'$q$, current_setting('qorpera_test.so_account'))),
	'true', 'recording it again is answered as recorded');
select pg_temp.so_expect(pg_temp.so_call($q$select public.qorpera_record_model_login_account('69600000-0000-4000-8000-000000000040',
		repeat('c',64), '69600000-0000-4000-8000-000000000050', repeat('e',64)) ->> 'recorded'$q$),
	'22023:model login account differs from the recorded one', 'another account is refused');
select pg_temp.so_expect(pg_temp.so_call($q$select jsonb_array_length(public.qorpera_model_logins_without_account(
		'69600000-0000-4000-8000-000000000040', repeat('c',64)) -> 'logins')::text$q$), '0', 'a recorded login is not listed again');

-- 2. The company does not take sign-ins in the vault yet: nothing is switched off.
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'a company not switched to the vault keeps its node logins');
reset session authorization;
set role service_role;
select pg_temp.so_expect(public.qorpera_set_model_login_sign_in('16000000-0000-4000-8000-000000000010', true)::text,
	'true', 'the operator switches the company');
reset role;

-- 3. The node login of another account is left alone.
update public.qorpera_native_provider_account_metadata set provider_account_identity = repeat('e',64)
where connection_id = current_setting('qorpera_test.so_node')::uuid;
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'another ChatGPT account is left alone');
reset session authorization;
update public.qorpera_native_provider_account_metadata set provider_account_identity = current_setting('qorpera_test.so_account')
where connection_id = current_setting('qorpera_test.so_node')::uuid;

-- 4. A move the database refuses (the vault login's provider is not enabled) changes nothing.
update public.qorpera_provider_execution_policies set enablement_status = 'disabled', disabled_reason = 'Switch-off test'
where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli';
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/1', 'a refused move');
reset session authorization;
update public.qorpera_provider_execution_policies set enablement_status = 'enabled', disabled_reason = null
where provider = 'openai' and authentication_mode = 'native_subscription' and native_harness = 'codex-cli';
select pg_temp.so_expect((select sponsor.provider_connection_id::text from public.qorpera_execution_sponsor_versions sponsor
	where sponsor.binding_id = current_setting('qorpera_test.so_binding')::uuid order by sponsor.version desc limit 1),
	current_setting('qorpera_test.so_node'), 'a refused move moves no pin');

-- 5. The member's queued turn still names the old login: its pins move to the vault login, and the old
-- login waits for that work.
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/1/0', 'the old login waits for its work');
reset session authorization;
select pg_temp.so_expect((select jsonb_build_object('connection', sponsor.provider_connection_id::text, 'version', sponsor.version)::text
	from public.qorpera_execution_sponsor_versions sponsor
	where sponsor.binding_id = current_setting('qorpera_test.so_binding')::uuid order by sponsor.version desc limit 1),
	jsonb_build_object('connection', current_setting('qorpera_test.so_vault'), 'version', 2)::text,
	'the member''s binding pays with the vault login from its next version');
select pg_temp.so_expect((select status from public.qorpera_provider_connections
	where id = current_setting('qorpera_test.so_node')::uuid), 'active', 'the old login stays on while its work runs');

-- 6. A node login the member made after signing in to the vault (a company that went back to node
-- sign-ins) is never switched off.
select pg_temp.so_node_login('69600000-0000-4000-8000-000000000090', '69600000-0000-4000-8000-000000000091');
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_identity)
values ('69600000-0000-4000-8000-000000000090', 1, current_setting('qorpera_test.so_account'));

-- 7. Each kind of work holds the old login on its own: the job (its queued turns cancelled) and the
-- queued turns (the job finished), each shown in a savepoint and undone.
create function pg_temp.so_finish_job() returns void language sql as $$
	select public.qorpera_terminalize_runner_attempt(job.id, 'failed', 'Switch-off test finishes the turn', false)
	from public.qorpera_runner_jobs job
	join public.qorpera_execution_runs run on run.job_id = job.id
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	where job.status in ('queued','leased') and sponsor.provider_connection_id = current_setting('qorpera_test.so_node')::uuid
$$;
create function pg_temp.so_cancel_turns() returns bigint language sql as $$
	with cancelled as (
		update public.qorpera_session_turn_requests request set status = 'cancelled'
		from public.qorpera_execution_sponsor_versions sponsor
		where request.status = 'queued' and sponsor.binding_id = request.sponsor_binding_id
			and sponsor.version = request.sponsor_version
			and sponsor.provider_connection_id = current_setting('qorpera_test.so_node')::uuid
		returning request.id)
	select count(*) from cancelled
$$;
savepoint so_turns_only;
select pg_temp.so_finish_job();
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/1/0', 'a queued turn on the old login holds it');
reset session authorization;
rollback to savepoint so_turns_only;
select pg_temp.so_expect((pg_temp.so_cancel_turns() > 0)::text, 'true', 'the member has queued turns on the old login');
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/1/0', 'a queued job on the old login holds it');
reset session authorization;
-- The work finishes: the next pass switches the old login off as Disconnect does.
select pg_temp.so_finish_job();
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
			where lease.provider_connection_id = connection.id and lease.status = 'active'))::text
	from public.qorpera_provider_connections connection where connection.id = current_setting('qorpera_test.so_node')::uuid),
	jsonb_build_object('connection', 'revoked', 'versions', 'revoked', 'capsules', 'revoked', 'leases', 0)::text,
	'revoked as Disconnect revokes it: connection, versions, capsules and leases');
select pg_temp.so_expect((select jsonb_build_object('vault', vault.status, 'newer', newer.status)::text
	from public.qorpera_provider_connections vault, public.qorpera_provider_connections newer
	where vault.id = current_setting('qorpera_test.so_vault')::uuid and newer.id = '69600000-0000-4000-8000-000000000090'),
	jsonb_build_object('vault', 'active', 'newer', 'active')::text, 'the vault login and a newer node login stay on');

-- 8. Nothing is left to switch off.
set local session authorization qorpera_secret_broker;
select pg_temp.so_expect(pg_temp.so_pass(), '0/0/0', 'a second pass finds nothing');
reset session authorization;
