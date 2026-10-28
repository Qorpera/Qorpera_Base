-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- F3 step 5j-4 (migration 20260930514000): a coding machine's masking history in the secret broker's read
-- (qorpera_authorize_coding_environment's maskSecrets), on 928's base as 528 sets it up: Alice's coding session for the
-- owner, claimed by executor exec-613, served npm_token (71, the company's, granted on its repository) and her own
-- personal_key (75). The other secret rows and the uses written here stand in for completed captures and earlier
-- sessions on the machine.
-- 1. No attached machine: the uses name none, and maskSecrets is empty.
-- 2. Attached to d1: the uses name d1. A version the answer serves is never in maskSecrets.
-- 3. After a rotation the new version serves and the old one comes back in maskSecrets only, shaped as a secrets item.
-- 4. Only the versions used on the same machine by a session of the same member in this company, of a secret the vault
--    still serves here under this broker's current key; the others are skipped, never refused. A company secret no
--    longer granted here still masks.
-- 5. Disconnect and a member's departure take a secret's versions out.
-- 6. Detached: none.
-- 7. The bounds: the 64 newest uses, and no more than 256 KiB of envelopes.
-- 8. Only a use names a machine, and the patched body names the migration.

select pg_temp.base_claims('service_role');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('61300000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
-- Another company and its broker, for 4.
set local session_replication_role = replica;
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('61300000-0000-4000-8000-000000000011', 'Another company', '92400000-0000-4000-8000-000000000005');
set local session_replication_role = origin;
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('61300000-0000-4000-8000-000000000041', '61300000-0000-4000-8000-000000000011', 'https://broker.example.test',
	'company-kek-1', repeat('8', 64));

-- Alice's session claimed by exec-613; the owner's machines d1 and d2. Two copies of her session's worker stand in for
-- earlier sessions: b2 another member's, b3 hers in another company.
do $$
declare v_claim jsonb;
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-613', true,
		array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	perform pg_temp.base_assert(pg_temp.c3_dispatch(pg_temp.c3_alice(), 'mask-dispatch-613',
		'QorperaOS/agents/alice/todos/fix-login/session-613', pg_temp.c3_brief('61300000-0000-4000-8000-0000000000b1'))
		-> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch');
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner,
		machine_id_sha256, binding)
	select ('61300000-0000-4000-8000-0000000000d' || n)::uuid, 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-613', repeat('8', 64),
		binding::jsonb
	from (values (1, '{}'), (2, '{"number":2}')) as v(n, binding);
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-613', 300);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = '61300000-0000-4000-8000-0000000000b1',
		'the owner''s session is claimed: ' || coalesce(v_claim::text, 'none'));
	perform set_config('qorpera_test.env_worker', v_claim ->> 'workerId', true);
	perform set_config('qorpera_test.env_lease', v_claim ->> 'leaseToken', true);
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_workers
	select copy.*
	from public.qorpera_runtime_workers as worker
	cross join (values
		('{"id": "61300000-0000-4000-8000-0000000000b2", "worker_key": "mask-613-b2",
			"owner_user_id": "92400000-0000-4000-8000-000000000002"}'::jsonb),
		('{"id": "61300000-0000-4000-8000-0000000000b3", "worker_key": "mask-613-b3",
			"profile_id": "61300000-0000-4000-8000-000000000011"}'::jsonb)) as v(change)
	cross join lateral jsonb_populate_record(worker, v.change) as copy
	where worker.id = '61300000-0000-4000-8000-0000000000b1';
	perform set_config('session_replication_role', 'origin', true);
end $$;

-- Version p_version of secret p_n ('envelope nn.v', padded to p_bytes), sealed by p_authority under p_key.
create function pg_temp.mh_version(p_n text, p_version bigint, p_key text default 'company-kek-1',
	p_authority uuid default '61300000-0000-4000-8000-000000000040', p_bytes integer default 0) returns void
language sql as $$
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	select ('61300000-0000-4000-8000-0000000000' || p_n)::uuid, p_version, p_authority, p_key, sealed.envelope,
		encode(extensions.digest(sealed.envelope, 'sha256'), 'hex'), '92400000-0000-4000-8000-000000000001'
	from (select convert_to(rpad(text, greatest(p_bytes, length(text)), '.'), 'UTF8') as envelope
		from (select 'envelope ' || p_n || '.' || p_version as text) as named) as sealed
$$;
-- A sealed secret at version 1: the company's when p_owner is null, else that member's.
create function pg_temp.mh_secret(p_n text, p_owner uuid, p_connector text, p_name text) returns void
language sql as $$
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind,
		owner_user_id, connector_id, secret_name, purpose, current_version, created_by_user_id)
	values (('61300000-0000-4000-8000-0000000000' || p_n)::uuid, '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '61300000-0000-4000-8000-000000000040',
		case when p_owner is null then 'company' else 'member' end, p_owner, p_connector, p_name, 'Secret ' || p_n, 1,
		coalesce(p_owner, '92400000-0000-4000-8000-000000000001'));
	select pg_temp.mh_version(p_n, 1);
$$;
select pg_temp.mh_secret('71', null, 'environment', 'npm_token') \g /dev/null
select pg_temp.mh_secret('72', null, 'environment', 'sentry_dsn') \g /dev/null
select pg_temp.mh_secret('75', '92400000-0000-4000-8000-000000000001', 'environment', 'personal_key') \g /dev/null
select pg_temp.mh_secret('76', '92400000-0000-4000-8000-000000000002', 'environment', 'other_key') \g /dev/null
select pg_temp.mh_secret('79', null, 'environment', 'path') \g /dev/null
select pg_temp.mh_secret('7a', null, 'gmail', 'notes') \g /dev/null

-- A use of secret p_n's version p_version on p_machine by p_worker's session, p_minutes after this statement's time.
create function pg_temp.mh_use(p_n text, p_version bigint, p_minutes integer,
	p_machine uuid default '61300000-0000-4000-8000-0000000000d1',
	p_worker uuid default '61300000-0000-4000-8000-0000000000b1', p_connector text default 'environment') returns void
language sql as $$
	insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id, secret_id, secret_version,
		event_type, connector_id, coding_worker_id, coding_machine_id, created_at)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		('61300000-0000-4000-8000-0000000000' || p_n)::uuid, p_version, 'environment_secret_used', p_connector, p_worker,
		p_machine, statement_timestamp() + make_interval(mins => p_minutes))
$$;
-- A new current version of secret p_n.
create function pg_temp.mh_rotate(p_n text, p_version bigint) returns void language plpgsql as $$
begin
	perform pg_temp.mh_version(p_n, p_version);
	set local session_replication_role = replica;
	update public.qorpera_cloud_secrets set current_version = p_version
	where id = ('61300000-0000-4000-8000-0000000000' || p_n)::uuid;
	set local session_replication_role = origin;
end $$;
-- Alice's session attached to p_machine, as the run authority attaches it.
create function pg_temp.mh_attach(p_machine uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set attached_machine_id = p_machine,
		attachment_token = extensions.gen_random_uuid(), attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = (select worker.sequence from public.qorpera_runtime_workers as worker
			where worker.id = '61300000-0000-4000-8000-0000000000b1'),
		attached_at = clock_timestamp(), observed_at = clock_timestamp()
	where worker_id = '61300000-0000-4000-8000-0000000000b1';
	set local session_replication_role = origin;
end $$;

-- Every call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.mh_try(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
	execute p_sql into v;
	return 'ok:' || v::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.mh_try(text) to qorpera_secret_broker, authenticated;
create function pg_temp.mh_member(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := pg_temp.mh_try(p_sql);
	reset role;
	return v;
end $$;
-- The broker's call for the claimed session, as the executor's lease gives it.
create function pg_temp.mh_now() returns text language plpgsql as $$
declare v text;
begin
	perform set_config('request.jwt.claims', '{}', true);
	execute 'set local session authorization qorpera_secret_broker';
	v := pg_temp.mh_try(format('select public.qorpera_authorize_coding_environment(%L, %L, %L, %L, %L)',
		'61300000-0000-4000-8000-000000000040', repeat('9', 64), current_setting('qorpera_test.env_worker'),
		current_setting('qorpera_test.env_lease'), 'exec-613'));
	execute 'reset session authorization';
	return v;
end $$;
-- A call's secrets, then its maskSecrets, each as NAME=nn.v (the secret's last two digits and the version) in the
-- answer's order; a refusal as it is.
create function pg_temp.mh_answer(p_result text) returns text language sql as $$
	select case when p_result like 'ok:%' then (
		select string_agg(coalesce((
			select string_agg((e ->> 'name') || '=' || right(e ->> 'secretId', 2) || '.' || (e ->> 'secretVersion'), ','
				order by n)
			from jsonb_array_elements(substring(p_result from 4)::jsonb -> part) with ordinality as s(e, n)), ''), ' / '
			order by o)
		from unnest(array['secrets', 'maskSecrets']) with ordinality as u(part, o))
		else p_result end
$$;
-- What the call answers after a change (made with the triggers off), which is then undone.
create function pg_temp.mh_after(p_change text) returns text language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	execute p_change;
	perform set_config('session_replication_role', 'origin', true);
	raise exception using errcode = 'QE613', message = pg_temp.mh_answer(pg_temp.mh_now());
exception when sqlstate 'QE613' then
	return sqlerrm;
end $$;
-- The uses written for the company's secrets on p_machine (none: on no machine).
create function pg_temp.mh_used(p_machine uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_cloud_secret_audit_events
	where profile_id = '92400000-0000-4000-8000-000000000010' and event_type = 'environment_secret_used'
		and coding_machine_id is not distinct from p_machine
$$;

do $$
declare v_result text := pg_temp.mh_member('92400000-0000-4000-8000-000000000001', format(
	'select public.qorpera_grant_coding_environment_secret(%L, %L, %L)', '92400000-0000-4000-8000-000000000010',
	'61300000-0000-4000-8000-000000000071', 'Qorpera/Qorpera_Base'));
begin
	perform pg_temp.base_assert(v_result like 'ok:%', 'npm_token''s grant: ' || v_result);
end $$;

-- 1. No attached machine ---------------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	perform pg_temp.base_assert((pg_temp.c3_session('61300000-0000-4000-8000-0000000000b1')).attached_machine_id is null,
		'the session is not attached');
	v_result := pg_temp.mh_now();
	perform pg_temp.base_assert(pg_temp.mh_answer(v_result) = 'NPM_TOKEN=71.1,PERSONAL_KEY=75.1 / ',
		'unattached: ' || v_result);
	perform pg_temp.base_assert(substring(v_result from 4)::jsonb -> 'maskSecrets' = '[]'::jsonb, 'maskSecrets is empty');
	perform pg_temp.base_assert(pg_temp.mh_used(null) = 2, 'two uses, on no machine');
end $$;

-- 2. Attached to d1 --------------------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	perform pg_temp.mh_attach('61300000-0000-4000-8000-0000000000d1');
	v_result := pg_temp.mh_now();
	perform pg_temp.base_assert(pg_temp.mh_answer(v_result) = 'NPM_TOKEN=71.1,PERSONAL_KEY=75.1 / ',
		'attached: ' || v_result);
	perform pg_temp.base_assert(pg_temp.mh_used('61300000-0000-4000-8000-0000000000d1') = 2
		and pg_temp.mh_used(null) = 2, 'two uses on d1');
	perform pg_temp.base_assert((select count(*) from public.qorpera_cloud_secret_audit_events
		where coding_machine_id is not null and (event_type <> 'environment_secret_used' or secret_version <> 1
			or coding_worker_id <> '61300000-0000-4000-8000-0000000000b1')) = 0, 'each names the session''s worker');
end $$;

-- 3. A rotation ------------------------------------------------------------------------------------------------------
do $$
declare
	v_result text;
	v_answer jsonb;
begin
	perform pg_temp.mh_rotate('71', 2);
	v_result := pg_temp.mh_now();
	perform pg_temp.base_assert(pg_temp.mh_answer(v_result) = 'NPM_TOKEN=71.2,PERSONAL_KEY=75.1 / NPM_TOKEN=71.1',
		'rotated: ' || v_result);
	v_answer := substring(v_result from 4)::jsonb;
	perform pg_temp.base_assert(v_answer -> 'maskSecrets' -> 0 = jsonb_build_object('name', 'NPM_TOKEN',
		'secretId', '61300000-0000-4000-8000-000000000071', 'secretVersion', 1, 'keyId', 'company-kek-1',
		'ownerKind', 'company', 'encryptedEnvelopeBase64', encode(convert_to('envelope 71.1', 'UTF8'), 'base64'),
		'envelopeSha256', encode(extensions.digest(convert_to('envelope 71.1', 'UTF8'), 'sha256'), 'hex')),
		'the old version''s entry: ' || (v_answer -> 'maskSecrets' -> 0)::text);
	perform pg_temp.base_assert((select array_agg(k order by k) from jsonb_object_keys(v_answer -> 'secrets' -> 0) as k)
		= (select array_agg(k order by k) from jsonb_object_keys(v_answer -> 'maskSecrets' -> 0) as k),
		'a secrets item''s keys');
	-- The rotated version's own use is of the version served.
	v_result := pg_temp.mh_now();
	perform pg_temp.base_assert(pg_temp.mh_answer(v_result) = 'NPM_TOKEN=71.2,PERSONAL_KEY=75.1 / NPM_TOKEN=71.1',
		'again: ' || v_result);
end $$;

-- 4. Which uses ------------------------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	-- Skipped: a version used on d2; on d1 by another member's session, by Alice's in another company; one sealed under
	-- another key, or by another broker; a name no capture gives; another connector's secret; another member's own.
	perform pg_temp.mh_version('71', 10);
	perform pg_temp.mh_use('71', 10, 1, p_machine => '61300000-0000-4000-8000-0000000000d2');
	perform pg_temp.mh_version('71', 11);
	perform pg_temp.mh_use('71', 11, 2, p_worker => '61300000-0000-4000-8000-0000000000b2');
	perform pg_temp.mh_version('71', 12);
	perform pg_temp.mh_use('71', 12, 3, p_worker => '61300000-0000-4000-8000-0000000000b3');
	perform pg_temp.mh_version('71', 13, 'company-kek-0');
	perform pg_temp.mh_use('71', 13, 2);
	perform pg_temp.mh_version('71', 14, p_authority => '61300000-0000-4000-8000-000000000041');
	perform pg_temp.mh_use('71', 14, 2);
	perform pg_temp.mh_use('79', 1, 2);
	perform pg_temp.mh_use('7a', 1, 2, p_connector => 'gmail');
	perform pg_temp.mh_use('76', 1, 2);
	-- Another member's later use of version 1 does not move it.
	perform pg_temp.mh_use('71', 1, 6, p_worker => '61300000-0000-4000-8000-0000000000b2');
	-- Masked: Alice's own secret's older version, and the company's.
	perform pg_temp.mh_version('75', 5);
	perform pg_temp.mh_use('75', 5, 4);
	perform pg_temp.mh_version('71', 15);
	perform pg_temp.mh_use('71', 15, 5);
	v_result := pg_temp.mh_answer(pg_temp.mh_now());
	perform pg_temp.base_assert(v_result
		= 'NPM_TOKEN=71.2,PERSONAL_KEY=75.1 / NPM_TOKEN=71.15,PERSONAL_KEY=75.5,NPM_TOKEN=71.1', 'the uses: ' || v_result);
	-- The same rows, b2 Alice's and b3 in this company: theirs come back.
	v_result := pg_temp.mh_after('update public.qorpera_runtime_workers
		set owner_user_id = ''92400000-0000-4000-8000-000000000001'' where id = ''61300000-0000-4000-8000-0000000000b2'';
		update public.qorpera_runtime_workers set profile_id = ''92400000-0000-4000-8000-000000000010''
		where id = ''61300000-0000-4000-8000-0000000000b3''');
	perform pg_temp.base_assert(v_result = 'NPM_TOKEN=71.2,PERSONAL_KEY=75.1 / '
		'NPM_TOKEN=71.1,NPM_TOKEN=71.15,PERSONAL_KEY=75.5,NPM_TOKEN=71.12,NPM_TOKEN=71.11', 'hers: ' || v_result);
	-- npm_token's grant withdrawn: it no longer serves, and all its versions mask.
	v_result := pg_temp.mh_after('update public.qorpera_coding_environment_grants
		set status = ''revoked'', revoked_at = statement_timestamp()');
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75.1 / NPM_TOKEN=71.15,PERSONAL_KEY=75.5,NPM_TOKEN=71.2,'
		'NPM_TOKEN=71.1', 'no longer granted: ' || v_result);
end $$;

-- 5. Disconnect and a departure --------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	-- Alice's secrets as her departure leaves them (the trigger's change, her membership kept): none come back.
	v_result := pg_temp.mh_after('update public.qorpera_cloud_secrets
		set status = ''revoked'', revoked_at = statement_timestamp(), updated_at = statement_timestamp()
		where owner_kind = ''member'' and owner_user_id = ''92400000-0000-4000-8000-000000000001''');
	perform pg_temp.base_assert(v_result = 'NPM_TOKEN=71.2 / NPM_TOKEN=71.15,NPM_TOKEN=71.1',
		'her secrets revoked: ' || v_result);
	-- The owner disconnects npm_token.
	v_result := pg_temp.mh_member('92400000-0000-4000-8000-000000000001', format(
		'select public.qorpera_revoke_cloud_secret(%L, %L)', '92400000-0000-4000-8000-000000000010',
		'61300000-0000-4000-8000-000000000071'));
	perform pg_temp.base_assert(v_result like 'ok:%', 'Disconnect: ' || v_result);
	v_result := pg_temp.mh_answer(pg_temp.mh_now());
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75.1 / PERSONAL_KEY=75.5', 'after Disconnect: ' || v_result);
end $$;

-- 6. Detached --------------------------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	v_result := pg_temp.mh_after('update public.qorpera_coding_sessions set attached_machine_id = null,
		attachment_token = null, attachment_until = null, attachment_turn = null, attached_at = null
		where worker_id = ''61300000-0000-4000-8000-0000000000b1''');
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75.1 / ', 'detached: ' || v_result);
	v_result := pg_temp.mh_after('update public.qorpera_coding_sessions
		set attached_machine_id = ''61300000-0000-4000-8000-0000000000d2''
		where worker_id = ''61300000-0000-4000-8000-0000000000b1''');
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75.1 / ', 'attached to d2: ' || v_result);
end $$;

-- 7. The bounds ------------------------------------------------------------------------------------------------------
do $$
declare v_result text;
begin
	-- 69 more versions of sentry_dsn (a company secret granted nowhere), each used later than the one before.
	v_result := pg_temp.mh_after('select pg_temp.mh_version(''72'', v), pg_temp.mh_use(''72'', v, 60 + v::integer)
		from generate_series(2, 70) as v');
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75.1 / ' || (select string_agg('SENTRY_DSN=72.' || v, ','
		order by v desc) from generate_series(7, 70) as v), 'the 64 newest: ' || v_result);
	-- Three of 100000 bytes: two fit in 256 KiB, and nothing after the third.
	v_result := pg_temp.mh_after('select pg_temp.mh_version(''72'', v, p_bytes => 100000),
		pg_temp.mh_use(''72'', v, 60 + v::integer) from generate_series(2, 4) as v');
	perform pg_temp.base_assert(v_result = 'PERSONAL_KEY=75.1 / SENTRY_DSN=72.4,SENTRY_DSN=72.3',
		'256 KiB: ' || v_result);
end $$;

-- 8. The audit row, and the body -------------------------------------------------------------------------------------
do $$
declare v_broker text := pg_get_functiondef(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure);
begin
	perform pg_temp.base_error($q$insert into public.qorpera_cloud_secret_audit_events(profile_id, environment_id,
		secret_id, secret_version, event_type, connector_id, coding_machine_id) values (
		'92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
		'61300000-0000-4000-8000-000000000072', 1, 'environment_grant_issued', 'environment',
		'61300000-0000-4000-8000-0000000000d1')$q$, '23514', 'new row for relation "qorpera_cloud_secret_audit_events" '
		'violates check constraint "qorpera_cloud_secret_audit_events_coding_machine"');
	perform pg_temp.base_assert(position('20260930514000' in v_broker) > 0
		and position('20260930440000' in v_broker) > 0, 'the body names 20260930514000 and keeps 20260930440000');
end $$;

rollback;
