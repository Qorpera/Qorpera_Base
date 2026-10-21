-- The company bank connection, part 2 (migration 20260930523000): the vault's bank sync follows the company's bank
-- secret, is claimed by the company's own authority, keeps booked transactions once each, records the summary, backs
-- off after a failure, marks the summary paused when the consent ends, starts over (deep) on a connect-again, refuses
-- a late answer from an earlier claim, and stops on a Disconnect, which also queues the
-- session's close at Enable Banking (as does a company's deletion). The shared vault asks which of its companies are
-- due. Nothing else reaches the tables.
begin;

insert into auth.users(id, email) values ('69100000-0000-4000-8000-000000000001', 'bank-owner@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('69100000-0000-4000-8000-000000000010', 'Nordlys Bank', '69100000-0000-4000-8000-000000000001'),
	('69100000-0000-4000-8000-000000000011', 'Shared Vault Company', '69100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('69100000-0000-4000-8000-000000000010', '69100000-0000-4000-8000-000000000001', 'bank-owner@example.test', 'Owner', 'owner'),
	('69100000-0000-4000-8000-000000000011', '69100000-0000-4000-8000-000000000001', 'bank-owner@example.test', 'Owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id) values
	('69100000-0000-4000-8000-000000000020', '69100000-0000-4000-8000-000000000010', 'Environment', 1, '69100000-0000-4000-8000-000000000001'),
	('69100000-0000-4000-8000-000000000021', '69100000-0000-4000-8000-000000000011', 'Environment', 1, '69100000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256, registers_companies_created_after)
values ('69100000-0000-4000-8000-000000000050', 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64), '2099-01-01 00:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256, principal_id) values
	('69100000-0000-4000-8000-0000000000d1', '69100000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-1', repeat('1', 64), null),
	('69100000-0000-4000-8000-0000000000d2', '69100000-0000-4000-8000-000000000011', 'https://vault.qorpera.test', 'vault-root-1', repeat('2', 64),
		'69100000-0000-4000-8000-000000000050');

create function pg_temp.refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'Failed: %', p_what; end if;
end
$$;
-- A sealed version as the capture leaves it.
create function pg_temp.seal(p_secret uuid, p_version bigint, p_authority uuid) returns void language plpgsql as $$
declare v_envelope bytea := extensions.gen_random_bytes(64) || convert_to(p_secret::text || p_version, 'UTF8');
begin
	insert into public.qorpera_cloud_secret_versions(secret_id, version, broker_authority_id, key_id, encrypted_envelope,
		envelope_sha256, created_by_user_id)
	values (p_secret, p_version, p_authority, (select key_id from public.qorpera_cloud_secret_broker_authorities where id = p_authority),
		v_envelope, encode(extensions.digest(v_envelope, 'sha256'), 'hex'), '69100000-0000-4000-8000-000000000001');
end
$$;
create function pg_temp.connect(p_secret uuid, p_profile uuid, p_environment uuid, p_authority uuid,
	p_owner_kind text default 'company') returns void language plpgsql as $$
begin
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, current_version, created_by_user_id, account_label)
	values (p_secret, p_profile, p_environment, p_authority, p_owner_kind,
		case when p_owner_kind = 'member' then '69100000-0000-4000-8000-000000000001'::uuid end,
		'bank', 'primary', 'Company bank', 1, '69100000-0000-4000-8000-000000000001', 'Danske Bank');
	perform pg_temp.seal(p_secret, 1, p_authority);
end
$$;
-- The broker's calls, under its own database login.
create function pg_temp.claim(p_authority uuid, p_capability text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_claim_bank_sync(p_authority, p_capability);
	reset session authorization;
	return v;
end
$$;
-- The lease is the current claim's unless a test names an earlier one.
create function pg_temp.lease(p_secret uuid) returns uuid language sql as $$
	select lease_id from public.qorpera_bank_syncs where secret_id = p_secret
$$;
create function pg_temp.record(p_authority uuid, p_capability text, p_secret uuid, p_version bigint, p_keys jsonb,
	p_transactions jsonb, p_lease uuid default null) returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := coalesce(p_lease, pg_temp.lease(p_secret));
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_record_bank_transactions(p_authority, p_capability, p_secret, p_version, v_lease, p_keys, p_transactions);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.finish(p_authority uuid, p_capability text, p_secret uuid, p_version bigint, p_outcome text,
	p_summary jsonb, p_error text default null, p_fetch text default 'deep', p_lease uuid default null)
returns jsonb language plpgsql as $$
declare v jsonb; v_lease uuid := coalesce(p_lease, pg_temp.lease(p_secret));
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_finish_bank_sync(p_authority, p_capability, p_secret, p_version, v_lease, p_outcome, p_summary,
		'2027-01-19T11:59:00.000000+00:00', p_fetch, p_error);
	reset session authorization;
	return v;
end
$$;
create function pg_temp.due(p_principal uuid, p_capability text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	set local session authorization qorpera_secret_broker;
	v := public.qorpera_broker_principal_bank_syncs_due(p_principal, p_capability);
	reset session authorization;
	return v;
end
$$;
grant execute on function pg_temp.claim(uuid, text), pg_temp.record(uuid, text, uuid, bigint, jsonb, jsonb, uuid),
	pg_temp.finish(uuid, text, uuid, bigint, text, jsonb, text, text, uuid), pg_temp.due(uuid, text),
	pg_temp.lease(uuid) to qorpera_secret_broker;
create function pg_temp.sync() returns public.qorpera_bank_syncs language sql as $$
	select * from public.qorpera_bank_syncs where profile_id = '69100000-0000-4000-8000-000000000010'
$$;
create function pg_temp.past() returns void language sql as $$
	update public.qorpera_bank_syncs set due_at = clock_timestamp() - interval '1 second'
	where profile_id = '69100000-0000-4000-8000-000000000010'
$$;
create function pg_temp.summary(p_saldo integer) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.bank-summary/v1', 'bank', 'Danske Bank', 'pausedSince', null, 'saldo', p_saldo)
$$;

-- 1. Only the broker's own functions reach the bank tables, and only the broker may call them.
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.check(not has_table_privilege(v_role, 'public.qorpera_bank_syncs', 'select'), v_role || ' reads no sync');
		perform pg_temp.check(not has_table_privilege(v_role, 'public.qorpera_bank_transactions', 'select'),
			v_role || ' reads no transaction');
	end loop;
	foreach v_function in array array['public.qorpera_claim_bank_sync(uuid,text)',
		'public.qorpera_record_bank_transactions(uuid,text,uuid,bigint,uuid,jsonb,jsonb)',
		'public.qorpera_finish_bank_sync(uuid,text,uuid,bigint,uuid,text,jsonb,timestamptz,text,text)',
		'public.qorpera_broker_principal_bank_syncs_due(uuid,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
			perform pg_temp.check(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' may not call ' || v_function);
		end loop;
		perform pg_temp.check(has_function_privilege('qorpera_secret_broker', v_function, 'execute'), 'the broker calls ' || v_function);
	end loop;
	perform pg_temp.check(not has_function_privilege('qorpera_secret_broker', 'public.qorpera_bank_sync_authority(uuid,text)', 'execute'),
		'the authority check is internal');
end $$;
select pg_temp.refused($$select public.qorpera_claim_bank_sync('69100000-0000-4000-8000-0000000000d1', repeat('1', 64))$$, '42501');

-- 2. A connect makes the company's sync due at once, for the deep fetch. A member's own bank secret makes none.
select pg_temp.connect('69100000-0000-4000-8000-0000000000e1', '69100000-0000-4000-8000-000000000010',
	'69100000-0000-4000-8000-000000000020', '69100000-0000-4000-8000-0000000000d1');
select pg_temp.connect('69100000-0000-4000-8000-0000000000e9', '69100000-0000-4000-8000-000000000010',
	'69100000-0000-4000-8000-000000000020', '69100000-0000-4000-8000-0000000000d1', 'member');
select pg_temp.check((pg_temp.sync()).status = 'waiting' and (pg_temp.sync()).due_at <= clock_timestamp()
	and (pg_temp.sync()).secret_id = '69100000-0000-4000-8000-0000000000e1' and not (pg_temp.sync()).deep_done, 'a connect is due now');
select pg_temp.check((select count(*) = 1 from public.qorpera_bank_syncs), 'one sync for the company');

-- 3. Another authority's capability is refused; the company's own claim leases it, with its sealed envelope.
select pg_temp.refused($$select pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('9', 64))$$, '42501');
do $$
declare v jsonb := pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64));
begin
	perform pg_temp.check(v ->> 'schema' = 'qorpera.bank-sync-claim/v1' and v ->> 'secretId' = '69100000-0000-4000-8000-0000000000e1'
		and (v ->> 'secretVersion')::bigint = 1 and v ->> 'keyId' = 'key-1' and (v ->> 'deep')::boolean and v -> 'since' = 'null'::jsonb
		and (v ->> 'lease')::uuid = (pg_temp.sync()).lease_id
		and v ->> 'companyId' = '69100000-0000-4000-8000-000000000010'
		and v ->> 'environmentId' = '69100000-0000-4000-8000-000000000020'
		and v ->> 'encryptedEnvelopeBase64' !~ E'\n'
		and v ->> 'envelopeSha256' = (select envelope_sha256 from public.qorpera_cloud_secret_versions
			where secret_id = '69100000-0000-4000-8000-0000000000e1' and version = 1), 'the claim: ' || v::text);
	perform pg_temp.check((pg_temp.sync()).lease_until > clock_timestamp() and (pg_temp.sync()).attempts = 1, 'leased');
	perform pg_temp.check(pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64)) is null, 'a leased sync is not claimed twice');
	perform pg_temp.check(pg_temp.claim('69100000-0000-4000-8000-0000000000d2', repeat('2', 64)) is null,
		'another company has nothing due');
end $$;

-- 4. Booked transactions are kept once each, only for the accounts the session reaches; the answer is what is kept.
do $$
declare
	v_keys jsonb := jsonb_build_array(repeat('a', 64));
	v_rows jsonb := jsonb_build_array(
		jsonb_build_object('accountKey', repeat('a', 64), 'key', repeat('1', 64), 'date', current_date - 3, 'amount', 500.5,
			'currency', 'DKK', 'counterparty', 'Wolt', 'text', null),
		jsonb_build_object('accountKey', repeat('a', 64), 'key', repeat('2', 64), 'date', current_date - 1, 'amount', -99,
			'currency', 'DKK', 'counterparty', null, 'text', 'Figma'),
		jsonb_build_object('accountKey', repeat('b', 64), 'key', repeat('3', 64), 'date', current_date, 'amount', 1,
			'currency', 'DKK', 'counterparty', null, 'text', null),
		jsonb_build_object('accountKey', repeat('a', 64), 'key', repeat('4', 64), 'date', current_date - 500, 'amount', 7,
			'currency', 'DKK', 'counterparty', null, 'text', null));
	v jsonb;
begin
	v := pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1, v_keys, v_rows);
	v := pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1, v_keys, v_rows);
	perform pg_temp.check((select count(*) = 3 from public.qorpera_bank_transactions), 'kept once each, never another account''s');
	-- The answer covers the last 13 months: the 500-day-old one is kept but not handed back.
	perform pg_temp.check(v ->> 'schema' = 'qorpera.bank-transactions-kept/v1' and jsonb_array_length(v -> 'transactions') = 2
		and (v -> 'transactions' -> 0 ->> 'amount')::numeric = 500.50 and v -> 'transactions' -> 1 ->> 'text' = 'Figma'
		and not (v -> 'transactions' -> 0) ? 'key', 'the kept answer: ' || v::text);
	perform pg_temp.refused(format($q$select pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, %L, %L)$q$, v_keys,
		jsonb_build_array(jsonb_build_object('accountKey', repeat('a', 64), 'key', repeat('5', 64), 'date', 'not a day',
			'amount', 1, 'currency', 'DKK'))), '22023');
	perform pg_temp.refused(format($q$select pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, %L, '[]')$q$, jsonb_build_array('not-a-key')), '22023');
	perform pg_temp.refused($q$select pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e9', 1, jsonb_build_array(repeat('a', 64)), '[]')$q$, '55000');
end $$;

-- 5. A summary makes the sync current, due in six hours; a late answer is refused.
do $$
declare v jsonb := pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1,
	'current', pg_temp.summary(1000));
begin
	perform pg_temp.check(v ->> 'status' = 'current' and (v ->> 'summaryGeneration')::bigint = 1, 'current: ' || v::text);
	perform pg_temp.check((pg_temp.sync()).deep_done and (pg_temp.sync()).lease_until is null and (pg_temp.sync()).attempts = 0
		and (pg_temp.sync()).due_at between clock_timestamp() + interval '5 hours 59 minutes' and clock_timestamp() + interval '6 hours'
		and (pg_temp.sync()).consent_until = '2027-01-19T11:59:00+00:00' and ((pg_temp.sync()).summary ->> 'saldo')::integer = 1000,
		'the summary and the next fetch');
	perform pg_temp.refused($q$select pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, 'current', pg_temp.summary(1))$q$, '55000');
	perform pg_temp.refused($q$select pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, 'current', '{"schema":"other"}')$q$, '22023');
	perform pg_temp.refused($q$select pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, 'failed', null, null)$q$, '22023');
end $$;

-- 5b. A claim whose lease ran out cannot answer once another claim holds the sync.
select pg_temp.past();
do $$
declare
	v_first uuid := (pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64)) ->> 'lease')::uuid;
	v_second uuid;
	v jsonb;
begin
	update public.qorpera_bank_syncs set lease_until = clock_timestamp() - interval '1 second'
	where profile_id = '69100000-0000-4000-8000-000000000010';
	v_second := (pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64)) ->> 'lease')::uuid;
	perform pg_temp.check(v_second is not null and v_second <> v_first, 'a new claim, a new lease');
	perform pg_temp.refused(format($q$select pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, 'current', pg_temp.summary(5), null, 'deep', %L)$q$, v_first), '55000');
	perform pg_temp.refused(format($q$select pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, jsonb_build_array(repeat('a', 64)), '[]', %L)$q$, v_first), '55000');
	perform pg_temp.check((pg_temp.sync()).lease_id = v_second, 'the earlier claim left the lease alone');
	v := pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1,
		'current', pg_temp.summary(1000), null, 'since');
	perform pg_temp.check((pg_temp.sync()).summary_generation = 2 and (pg_temp.sync()).lease_id is null
		and ((pg_temp.sync()).summary ->> 'saldo')::integer = 1000, 'the current claim answers: ' || v::text);
	perform pg_temp.refused($q$select pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
		'69100000-0000-4000-8000-0000000000e1', 1, 'current', pg_temp.summary(1), null, 'incomplete',
		'69100000-0000-4000-8000-0000000000f0')$q$, '22023');
end $$;

-- 6. After the deep fetch, a fetch starts two weeks before the newest booked day the last current fetch reached; a
-- failure keeps the summary and backs off, and what it kept before failing does not move that day.
select pg_temp.past();
do $$
declare v jsonb := pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64));
begin
	perform pg_temp.check(not (v ->> 'deep')::boolean and (v ->> 'since')::date = current_date - 15, 'the since day: ' || v::text);
	-- A newer transaction kept by a fetch that then fails.
	v := pg_temp.record('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1,
		jsonb_build_array(repeat('a', 64)), jsonb_build_array(jsonb_build_object('accountKey', repeat('a', 64),
			'key', repeat('6', 64), 'date', current_date, 'amount', 3, 'currency', 'DKK', 'counterparty', null, 'text', null)));
	v := pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1,
		'failed', null, 'the bank asked us to wait', 'since');
	perform pg_temp.check((pg_temp.sync()).status = 'current' and (pg_temp.sync()).last_error = 'the bank asked us to wait'
		and (pg_temp.sync()).due_at between clock_timestamp() + interval '14 minutes' and clock_timestamp() + interval '15 minutes'
		and (pg_temp.sync()).summary_generation = 2 and (pg_temp.sync()).fetched_through = current_date - 1,
		'a failure backs off, keeps the summary and its day');
end $$;

-- 7. An ended consent marks the kept summary paused from today and stops until the member connects again.
select pg_temp.past();
do $$
declare v jsonb := pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64));
begin
	perform pg_temp.check((v ->> 'since')::date = current_date - 15, 'the retry starts where the last current fetch did: ' || v::text);
	v := pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64), '69100000-0000-4000-8000-0000000000e1', 1,
		'ended', null, null, 'since');
	perform pg_temp.check((pg_temp.sync()).status = 'ended' and (pg_temp.sync()).due_at is null
		and (pg_temp.sync()).summary ->> 'pausedSince' = to_char(current_date, 'YYYY-MM-DD')
		and (pg_temp.sync()).summary_generation = 3, 'ended: ' || to_jsonb(pg_temp.sync())::text);
	perform pg_temp.check(pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64)) is null, 'nothing due when ended');
end $$;

-- 8. A connect-again (the secret's next version) is due at once and fetches deep again; a Disconnect stops the sync.
update public.qorpera_cloud_secrets set current_version = 2 where id = '69100000-0000-4000-8000-0000000000e1';
select pg_temp.seal('69100000-0000-4000-8000-0000000000e1', 2, '69100000-0000-4000-8000-0000000000d1');
select pg_temp.check((pg_temp.sync()).status = 'current' and (pg_temp.sync()).secret_version = 2 and not (pg_temp.sync()).deep_done
	and (pg_temp.sync()).due_at <= clock_timestamp(), 'a connect-again is due now');
select pg_temp.check((pg_temp.claim('69100000-0000-4000-8000-0000000000d1', repeat('1', 64)) ->> 'secretVersion')::bigint = 2,
	'the new version is claimed');
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(),
	revoked_by_user_id = '69100000-0000-4000-8000-000000000001'
where id = '69100000-0000-4000-8000-0000000000e1';
select pg_temp.check((pg_temp.sync()).status = 'disconnected' and (pg_temp.sync()).due_at is null and (pg_temp.sync()).lease_until is null,
	'a Disconnect stops the sync');
-- Each sealed session of the connection is queued for its close at Enable Banking.
select pg_temp.check((select array_agg(version order by version) = array[1, 2]::bigint[]
		and bool_and(connector_id = 'bank' and reason = 'disconnected' and completed_at is null)
	from public.qorpera_connector_token_revocations where secret_id = '69100000-0000-4000-8000-0000000000e1'),
	'the Disconnect queues every version''s close');
select pg_temp.refused($q$select pg_temp.finish('69100000-0000-4000-8000-0000000000d1', repeat('1', 64),
	'69100000-0000-4000-8000-0000000000e1', 2, 'current', pg_temp.summary(1))$q$, '55000');

-- 9. The shared vault asks which of its companies are due: only those on its authorities.
select pg_temp.connect('69100000-0000-4000-8000-0000000000e2', '69100000-0000-4000-8000-000000000011',
	'69100000-0000-4000-8000-000000000021', '69100000-0000-4000-8000-0000000000d2');
select pg_temp.check(pg_temp.due('69100000-0000-4000-8000-000000000050', repeat('a', 64)) = jsonb_build_object(
	'schema', 'qorpera.broker-principal-bank-syncs/v1', 'companyIds', jsonb_build_array('69100000-0000-4000-8000-000000000011')),
	'the principal sees its due company');
select pg_temp.refused($$select pg_temp.due('69100000-0000-4000-8000-000000000050', repeat('b', 64))$$, '42501');

-- 10. A deleting company's finisher revokes its bank connection too, which queues the session's close.
select pg_temp.check(public.qorpera_revoke_company_connector_secrets('69100000-0000-4000-8000-000000000011') = 1,
	'the company''s bank secret is revoked with its other connections');
select pg_temp.check(exists (select 1 from public.qorpera_connector_token_revocations
	where secret_id = '69100000-0000-4000-8000-0000000000e2' and connector_id = 'bank' and completed_at is null)
	and (select status = 'disconnected' from public.qorpera_bank_syncs where profile_id = '69100000-0000-4000-8000-000000000011'),
	'its close is queued and its sync stopped');

rollback;
