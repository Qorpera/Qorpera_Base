-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- F3 step 5j-1 (migration 20260930438000): the secret broker's read of a coding session's environment
-- (qorpera_authorize_coding_environment), on 928's base: Alice's coding session for the owner, on Qorpera/Qorpera_Base,
-- claimed by executor exec-528. The secret rows stand in for completed captures (sealed version 1 by the broker).
-- 1. What serves: the owner's own environment secrets, and the company's granted on the session's repository by a
--    current owner or administrator; for a name both have, the company's. Not a company secret without a grant, one
--    granted on another repository, another member's, a name no capture gives, or another connector's secret. Each
--    secret served writes one audit row naming the coding worker.
-- 2. Only on a live lease, in a phase that runs commands.
-- 3. The refusals, each writing nothing.
-- 4. An issuer who stops being an owner or administrator: their grants stop serving at once.
-- 5. Withdrawal, Disconnect and a demotion, for good.
-- 6. Only the secret broker may call it.

select pg_temp.base_claims('service_role');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('52800000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
-- Another company's broker, for 3.
set local session_replication_role = replica;
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('52800000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
set local session_replication_role = origin;
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('52800000-0000-4000-8000-000000000041', '52800000-0000-4000-8000-000000000011', 'https://broker.example.test',
	'company-kek-1', repeat('8', 64));

-- Alice's session on Qorpera/Qorpera_Base for the owner, claimed by exec-528 (as 982 sets up its own).
do $$
declare v_claim jsonb;
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-528', true,
		array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	perform pg_temp.base_assert(pg_temp.c3_dispatch(pg_temp.c3_alice(), 'env-dispatch-528',
		'agents/alice/todos/fix-login/session-528', pg_temp.c3_brief('52800000-0000-4000-8000-0000000000b1'))
		-> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch');
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner,
		machine_id_sha256, binding)
	values ('52800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-528', repeat('8', 64),
		'{}');
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-528', 300);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '52800000-0000-4000-8000-0000000000b1'
		and (pg_temp.c3_worker('52800000-0000-4000-8000-0000000000b1')).owner_user_id
			= '92400000-0000-4000-8000-000000000001',
		'the owner''s session is claimed: ' || coalesce(v_claim::text, 'none'));
	perform set_config('qorpera_test.env_worker', v_claim ->> 'workerId', true);
	perform set_config('qorpera_test.env_lease', v_claim ->> 'leaseToken', true);
end $$;

-- A sealed secret: the company's when p_owner is null, else that member's.
create function pg_temp.env_secret(p_n text, p_owner uuid, p_connector text, p_name text) returns void
language sql as $$
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
	values (('52800000-0000-4000-8000-0000000000' || p_n)::uuid, '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '52800000-0000-4000-8000-000000000040',
		case when p_owner is null then 'company' else 'member' end, p_owner, p_connector, p_name, 'Secret ' || p_n, 1,
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (('52800000-0000-4000-8000-0000000000' || p_n)::uuid, 1, '52800000-0000-4000-8000-000000000040',
		'company-kek-1', convert_to('envelope ' || p_n, 'UTF8'),
		encode(extensions.digest(convert_to('envelope ' || p_n, 'UTF8'), 'sha256'), 'hex'),
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
$$;
select pg_temp.env_secret('71', null, 'environment', 'npm_token') \g /dev/null
select pg_temp.env_secret('72', null, 'environment', 'sentry_dsn') \g /dev/null
select pg_temp.env_secret('73', null, 'environment', 'shared_name') \g /dev/null
select pg_temp.env_secret('74', '92400000-0000-4000-8000-000000000001', 'environment', 'shared_name') \g /dev/null
select pg_temp.env_secret('75', '92400000-0000-4000-8000-000000000001', 'environment', 'personal_key') \g /dev/null
select pg_temp.env_secret('76', '92400000-0000-4000-8000-000000000002', 'environment', 'other_key') \g /dev/null
select pg_temp.env_secret('77', null, 'environment', 'deploy_key') \g /dev/null
select pg_temp.env_secret('78', null, 'environment', 'admin_key') \g /dev/null
select pg_temp.env_secret('79', null, 'environment', 'path') \g /dev/null
select pg_temp.env_secret('7a', null, 'gmail', 'notes') \g /dev/null

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.env_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.env_try(text) to qorpera_secret_broker, authenticated;
create function pg_temp.env_member(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.env_try(p_sql);
	reset role;
	return v;
end $$;
create function pg_temp.env_grant(p_user uuid, p_secret uuid, p_repository text) returns text language sql as $$
	select pg_temp.env_member(p_user, format('select public.qorpera_grant_coding_environment_secret(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', p_secret, p_repository))
$$;
-- A call as the secret broker.
create function pg_temp.env_broker(p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform set_config('request.jwt.claims', '{}', true);
	execute 'set local session authorization qorpera_secret_broker';
	v := pg_temp.env_try(p_sql);
	execute 'reset session authorization';
	return v;
end $$;
create function pg_temp.env_authorize(p_worker uuid, p_lease uuid, p_owner text default 'exec-528',
	p_authority uuid default '52800000-0000-4000-8000-000000000040', p_capability text default repeat('9', 64))
returns text language sql as $$
	select pg_temp.env_broker(format('select public.qorpera_authorize_coding_environment(%L, %L, %L, %L, %L)',
		p_authority, p_capability, p_worker, p_lease, p_owner))
$$;
-- The broker's call for the claimed session, as the executor's lease gives it.
create function pg_temp.env_now() returns text language sql as $$
	select pg_temp.env_authorize(current_setting('qorpera_test.env_worker')::uuid,
		current_setting('qorpera_test.env_lease')::uuid)
$$;
-- What a call served, as NAME=nn (the secret's last two digits) in the answer's order; a refusal as it is.
create function pg_temp.env_served(p_result text) returns text language sql as $$
	select case when p_result like 'ok:%' then coalesce((
		select string_agg((e ->> 'name') || '=' || right(e ->> 'secretId', 2), ',' order by n)
		from jsonb_array_elements(substring(p_result from 4)::jsonb -> 'secrets') with ordinality as s(e, n)), '')
		else p_result end
$$;
-- What the call serves after a change (made with the triggers off unless p_replica is false), which is then undone.
create function pg_temp.env_after(p_change text, p_replica boolean default true) returns text language plpgsql as $$
begin
	if p_replica then perform set_config('session_replication_role', 'replica', true); end if;
	execute p_change;
	perform set_config('session_replication_role', 'origin', true);
	raise exception using errcode = 'QE528', message = pg_temp.env_served(pg_temp.env_now());
exception when sqlstate 'QE528' then
	return sqlerrm;
end $$;
create function pg_temp.env_used() returns bigint language sql as $$
	select count(*) from public.qorpera_cloud_secret_audit_events
	where profile_id = '92400000-0000-4000-8000-000000000010' and event_type = 'environment_secret_used'
$$;

-- The grants: the owner's on the session's repository (npm_token, shared_name) and on another (deploy_key), the
-- administrator's (admin_key); and two that no member could give, written directly: PATH and a Gmail secret.
do $$
declare v_result text;
begin
	foreach v_result in array array[
		pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52800000-0000-4000-8000-000000000071',
			'Qorpera/Qorpera_Base'),
		pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52800000-0000-4000-8000-000000000073',
			'qorpera/qorpera_base'),
		pg_temp.env_grant('92400000-0000-4000-8000-000000000001', '52800000-0000-4000-8000-000000000077',
			'Qorpera/other'),
		pg_temp.env_grant('92400000-0000-4000-8000-000000000004', '52800000-0000-4000-8000-000000000078',
			'Qorpera/Qorpera_Base')] loop
		perform pg_temp.base_assert(v_result like 'ok:%', 'a grant: ' || v_result);
	end loop;
	insert into public.qorpera_coding_environment_grants(profile_id, environment_id, secret_id, repository,
		issued_by_user_id)
	select '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', secret_id,
		'qorpera/qorpera_base', '92400000-0000-4000-8000-000000000001'
	from unnest(array['52800000-0000-4000-8000-000000000079', '52800000-0000-4000-8000-00000000007a']::uuid[])
		as s(secret_id);
end $$;

-- 1. What serves -----------------------------------------------------------------------------------------------------
do $$
declare
	v_worker uuid := current_setting('qorpera_test.env_worker')::uuid;
	v_result text := pg_temp.env_now();
	v_answer jsonb;
	v_entry jsonb;
begin
	perform pg_temp.base_assert(
		pg_temp.env_served(v_result) = 'ADMIN_KEY=78,NPM_TOKEN=71,PERSONAL_KEY=75,SHARED_NAME=73',
		'the first call: ' || v_result);
	v_answer := substring(v_result from 4)::jsonb;
	perform pg_temp.base_assert(v_answer ->> 'schema' = 'qorpera.coding-environment-authorization/v1'
		and v_answer ->> 'companyId' = '92400000-0000-4000-8000-000000000010'
		and v_answer ->> 'environmentId' = '92400000-0000-4000-8000-000000000020'
		and v_answer ->> 'workerId' = v_worker::text
		and v_answer -> 'repository' = (pg_temp.c3_session(v_worker)).repository, 'the answer: ' || v_result);
	v_entry := v_answer -> 'secrets' -> 1;
	perform pg_temp.base_assert(v_entry = jsonb_build_object('name', 'NPM_TOKEN',
		'secretId', '52800000-0000-4000-8000-000000000071', 'secretVersion', 1, 'keyId', 'company-kek-1',
		'ownerKind', 'company', 'encryptedEnvelopeBase64', encode(convert_to('envelope 71', 'UTF8'), 'base64'),
		'envelopeSha256', encode(extensions.digest(convert_to('envelope 71', 'UTF8'), 'sha256'), 'hex')),
		'the company''s entry: ' || v_entry::text);
	perform pg_temp.base_assert(v_answer -> 'secrets' -> 2 ->> 'ownerKind' = 'member', 'the member''s entry');
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
		where event_type = 'environment_secret_used' and coding_worker_id = v_worker and connector_id = 'environment'
			and actor_user_id is null and secret_version = 1
			and secret_id in ('52800000-0000-4000-8000-000000000078', '52800000-0000-4000-8000-000000000071',
				'52800000-0000-4000-8000-000000000075', '52800000-0000-4000-8000-000000000073')) = 4
		and pg_temp.env_used() = 4, 'one audit row per secret served');
end $$;

-- 2. The lease and the phase -----------------------------------------------------------------------------------------
do $$
declare
	v_phase text;
	v_result text;
	v_all text := 'ADMIN_KEY=78,NPM_TOKEN=71,PERSONAL_KEY=75,SHARED_NAME=73';
begin
	foreach v_phase in array array['running', 'awaiting_input', 'input_ready', 'publishing'] loop
		v_result := pg_temp.env_after(format(
			'update public.qorpera_coding_sessions set phase = %L where worker_id = %L', v_phase,
			current_setting('qorpera_test.env_worker')));
		perform pg_temp.base_assert(v_result = v_all, v_phase || ': ' || v_result);
	end loop;
	foreach v_phase in array array['queued', 'completed', 'failed', 'cancelled'] loop
		v_result := pg_temp.env_after(format(
			'update public.qorpera_coding_sessions set phase = %L where worker_id = %L', v_phase,
			current_setting('qorpera_test.env_worker')));
		perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable',
			v_phase || ': ' || v_result);
	end loop;
	v_result := pg_temp.env_after(format('update public.qorpera_coding_sessions
		set lease_until = clock_timestamp() - interval ''1 second'' where worker_id = %L',
		current_setting('qorpera_test.env_worker')));
	perform pg_temp.base_assert(v_result = '42501:coding session lease is unavailable',
		'an expired lease: ' || v_result);
end $$;

-- 3. The refusals ----------------------------------------------------------------------------------------------------
do $$
declare
	v_worker uuid := current_setting('qorpera_test.env_worker')::uuid;
	v_lease uuid := current_setting('qorpera_test.env_lease')::uuid;
	v_used bigint := pg_temp.env_used();
	v_result text;
	v_lease_refused text := '42501:coding session lease is unavailable';
begin
	-- Anyone but the broker (here the database's owner).
	v_result := pg_temp.env_try(format('select public.qorpera_authorize_coding_environment(%L, %L, %L, %L, %L)',
		'52800000-0000-4000-8000-000000000040', repeat('9', 64), v_worker, v_lease, 'exec-528'));
	perform pg_temp.base_assert(v_result = '42501:cloud secret broker authority is required',
		'not the broker: ' || v_result);
	-- A malformed request.
	foreach v_result in array array[pg_temp.env_authorize(null, v_lease), pg_temp.env_authorize(v_worker, null),
		pg_temp.env_authorize(v_worker, v_lease, 'exec 528'), pg_temp.env_authorize(v_worker, v_lease, null)] loop
		perform pg_temp.base_assert(v_result = '22023:coding environment request is invalid', 'malformed: ' || v_result);
	end loop;
	-- The broker's own proof.
	foreach v_result in array array[
		pg_temp.env_authorize(v_worker, v_lease, p_capability => repeat('7', 64)),
		pg_temp.env_authorize(v_worker, v_lease, p_authority => '52800000-0000-4000-8000-0000000000ff')] loop
		perform pg_temp.base_assert(v_result = '42501:cloud secret broker authority is unavailable',
			'the authority: ' || v_result);
	end loop;
	-- A session that is not there, or another company's.
	foreach v_result in array array[pg_temp.env_authorize('52800000-0000-4000-8000-0000000000ff', v_lease),
		pg_temp.env_authorize(v_worker, v_lease, p_authority => '52800000-0000-4000-8000-000000000041',
			p_capability => repeat('8', 64))] loop
		perform pg_temp.base_assert(v_result = '42501:coding session is unavailable to this broker',
			'the session: ' || v_result);
	end loop;
	-- Another lease, or another executor.
	foreach v_result in array array[pg_temp.env_authorize(v_worker, '52800000-0000-4000-8000-0000000000ff'),
		pg_temp.env_authorize(v_worker, v_lease, 'exec-other')] loop
		perform pg_temp.base_assert(v_result = v_lease_refused, 'the lease: ' || v_result);
	end loop;
	-- The executor switched off, the worker no longer active, the agent's repository grant switched off, the session's
	-- member made a viewer, a version under another key.
	v_result := pg_temp.env_after('update public.qorpera_coding_executors set enabled = false
		where environment_id = ''92400000-0000-4000-8000-000000000020''');
	perform pg_temp.base_assert(v_result = '42501:coding executor is unavailable', 'the executor: ' || v_result);
	v_result := pg_temp.env_after(format(
		'update public.qorpera_runtime_workers set state = ''failed'', result = ''{}'' where id = %L', v_worker));
	perform pg_temp.base_assert(v_result = '42501:coding executor is unavailable', 'the worker: ' || v_result);
	v_result := pg_temp.env_after('update public.qorpera_coding_repository_grants set enabled = false
		where environment_id = ''92400000-0000-4000-8000-000000000020''');
	perform pg_temp.base_assert(v_result = '42501:coding repository grant is unavailable', 'the agent: ' || v_result);
	v_result := pg_temp.env_after('update public.qorpera_profile_members set role = ''viewer''
		where profile_id = ''92400000-0000-4000-8000-000000000010''
			and user_id = ''92400000-0000-4000-8000-000000000001''');
	perform pg_temp.base_assert(v_result = '42501:coding session member is unavailable', 'the member: ' || v_result);
	v_result := pg_temp.env_after('update public.qorpera_cloud_secret_versions set key_id = ''company-kek-2''
		where secret_id = ''52800000-0000-4000-8000-000000000071''');
	perform pg_temp.base_assert(v_result = '42501:cloud secret version is unavailable', 'the version: ' || v_result);
	perform pg_temp.base_assert(pg_temp.env_used() = v_used, 'a refusal writes no audit row');
end $$;

-- 4. An issuer who stops being an owner or administrator -------------------------------------------------------------
do $$
declare v_result text;
begin
	-- The owner made a contributor: their grants stop serving, and their own shared_name serves in the company's place.
	v_result := pg_temp.env_after('update public.qorpera_profile_members set role = ''contributor''
		where profile_id = ''92400000-0000-4000-8000-000000000010''
			and user_id = ''92400000-0000-4000-8000-000000000001''');
	perform pg_temp.base_assert(v_result = 'ADMIN_KEY=78,PERSONAL_KEY=75,SHARED_NAME=74',
		'the owner demoted: ' || v_result);
	v_result := pg_temp.env_after('update public.qorpera_profile_members set role = ''contributor''
		where profile_id = ''92400000-0000-4000-8000-000000000010''
			and user_id = ''92400000-0000-4000-8000-000000000004''');
	perform pg_temp.base_assert(v_result = 'NPM_TOKEN=71,PERSONAL_KEY=75,SHARED_NAME=73',
		'the administrator demoted: ' || v_result);
	-- No live grant and none of the member's own: nothing.
	v_result := pg_temp.env_after('update public.qorpera_coding_environment_grants
		set status = ''revoked'', revoked_at = statement_timestamp();
		update public.qorpera_cloud_secrets set owner_user_id = ''92400000-0000-4000-8000-000000000002''
		where id in (''52800000-0000-4000-8000-000000000074'', ''52800000-0000-4000-8000-000000000075'')');
	perform pg_temp.base_assert(v_result = '', 'nothing granted, nothing the member''s: ' || v_result);
end $$;

-- 5. Withdrawal, Disconnect and a demotion ---------------------------------------------------------------------------
do $$
declare v_result text;
begin
	-- The owner withdraws shared_name's grant: the member's own serves.
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_revoke_coding_environment_grant(%L, %L)', '92400000-0000-4000-8000-000000000010',
		(select id from public.qorpera_coding_environment_grants
			where secret_id = '52800000-0000-4000-8000-000000000073')));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the withdrawal: ' || v_result);
	v_result := pg_temp.env_served(pg_temp.env_now());
	perform pg_temp.base_assert(v_result = 'ADMIN_KEY=78,NPM_TOKEN=71,PERSONAL_KEY=75,SHARED_NAME=74',
		'after the withdrawal: ' || v_result);
	-- The owner disconnects npm_token.
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_revoke_cloud_secret(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'52800000-0000-4000-8000-000000000071'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'Disconnect: ' || v_result);
	v_result := pg_temp.env_served(pg_temp.env_now());
	perform pg_temp.base_assert(v_result = 'ADMIN_KEY=78,PERSONAL_KEY=75,SHARED_NAME=74',
		'after Disconnect: ' || v_result);
	-- The owner makes the administrator a contributor, then an administrator again: admin_key stays off.
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'contributor'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the demotion: ' || v_result);
	v_result := pg_temp.env_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_update_profile_member_role(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'admin'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'the promotion: ' || v_result);
	v_result := pg_temp.env_served(pg_temp.env_now());
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75,SHARED_NAME=74', 'after the demotion: ' || v_result);
end $$;

-- 6. Only the secret broker ------------------------------------------------------------------------------------------
do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role,
			'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)', 'execute'), v_role);
	end loop;
	perform pg_temp.base_assert(has_function_privilege('qorpera_secret_broker',
		'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)', 'execute'), 'the broker');
end $$;

rollback;
