-- The company bank connection, part 2 (Bank interface): the vault keeps each connected company's bank
-- summary current. A company connects its bank through Enable Banking like any other connector (a
-- company secret with connector id 'bank': the session id and the accounts the member shared, sealed by
-- the company's vault). This migration gives the vault its queue and its record:
--
-- - qorpera_bank_syncs: one row a company, following its bank secret. A new or rotated bank secret (a
--   connect or a connect-again) is due at once and asks for the deep fetch, since a bank gives its full
--   history only for a short while after the member signs in; afterwards the row is due every six hours
--   (PSD2 allows four unattended fetches a day). A Disconnect stops it. The reduced summary
--   (qorpera.bank-summary/v1, what the Bank page draws) and its generation are kept here; writing it to
--   the company folder is the object gateway's (part 3), never the vault's.
-- - qorpera_bank_transactions: the booked transactions fetched so far, so a summary can cover more
--   history than a bank hands out after the first sign-in. An account is known only by a hash of its
--   bank identity, a transaction by a hash the vault computes; no account number is stored.
--
-- Only the vault's own functions reach these tables (as the broker role, with the company's authority);
-- they go with the company when it is deleted.

create table public.qorpera_bank_syncs (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	secret_id uuid not null,
	secret_version bigint not null check (secret_version > 0),
	-- waiting: connected, no summary yet; current: summarized, due again later; failed: the last fetch
	-- failed and is tried again; ended: the bank's consent ended (connect again); disconnected.
	status text not null check (status in ('waiting', 'current', 'failed', 'ended', 'disconnected')),
	due_at timestamptz,
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	last_error text check (last_error is null or char_length(last_error) between 1 and 300),
	deep_done boolean not null default false,
	consent_until timestamptz,
	fetched_at timestamptz,
	summary jsonb check (summary is null or (jsonb_typeof(summary) = 'object'
		and summary->>'schema' = 'qorpera.bank-summary/v1' and pg_column_size(summary) <= 262144)),
	summary_generation bigint not null default 0 check (summary_generation >= 0),
	summary_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	check ((status in ('ended', 'disconnected')) = (due_at is null)),
	check ((summary is null) = (summary_generation = 0))
);
create index qorpera_bank_syncs_due on public.qorpera_bank_syncs (due_at) where due_at is not null;
alter table public.qorpera_bank_syncs enable row level security;
revoke all on public.qorpera_bank_syncs from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_bank_transactions (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	account_key text not null check (account_key ~ '^[0-9a-f]{64}$'),
	transaction_key text not null check (transaction_key ~ '^[0-9a-f]{64}$'),
	booked_on date not null,
	amount numeric(18, 2) not null,
	currency text not null check (currency ~ '^[A-Z]{3}$'),
	counterparty text check (counterparty is null or char_length(counterparty) between 1 and 140),
	remittance text check (remittance is null or char_length(remittance) between 1 and 280),
	first_seen_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, account_key, transaction_key)
);
create index qorpera_bank_transactions_booked
	on public.qorpera_bank_transactions (profile_id, account_key, booked_on);
alter table public.qorpera_bank_transactions enable row level security;
revoke all on public.qorpera_bank_transactions from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The sync follows the company's bank secret: a connect or connect-again is due now and fetches deep; a
-- Disconnect stops it. A company has one bank connection; connecting another bank replaces the first.
create function public.qorpera_bank_sync_follow_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.connector_id <> 'bank' or new.owner_kind <> 'company' then
		return new;
	end if;
	if new.status = 'active' then
		insert into public.qorpera_bank_syncs as sync (profile_id, secret_id, secret_version, status, due_at)
		values (new.profile_id, new.id, new.current_version, 'waiting', clock_timestamp())
		on conflict (profile_id) do update
		set secret_id = excluded.secret_id, secret_version = excluded.secret_version,
			status = case when sync.summary is null then 'waiting' else 'current' end,
			due_at = clock_timestamp(), lease_until = null, attempts = 0, last_error = null,
			deep_done = false, consent_until = null, updated_at = clock_timestamp()
		where sync.secret_id <> excluded.secret_id or sync.secret_version <> excluded.secret_version
			or sync.status in ('ended', 'disconnected');
	else
		update public.qorpera_bank_syncs
		set status = 'disconnected', due_at = null, lease_until = null, updated_at = clock_timestamp()
		where profile_id = new.profile_id and secret_id = new.id;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_bank_sync_follow_secret()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_bank_sync_follow_secret
	after insert or update of status, current_version on public.qorpera_cloud_secrets
	for each row execute function public.qorpera_bank_sync_follow_secret();

-- The company's authority, checked as every broker function checks it.
create function public.qorpera_bank_sync_authority(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns public.qorpera_cloud_secret_broker_authorities
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	return v_authority;
end
$$;
revoke all on function public.qorpera_bank_sync_authority(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The company's due bank sync, leased for ten minutes, with its sealed session: null when nothing is
-- due. A secret no longer active, or sealed by another authority, stops the sync here.
create function public.qorpera_claim_bank_sync(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_row record;
	v_now timestamptz := clock_timestamp();
	v_since date;
begin
	v_authority := public.qorpera_bank_sync_authority(p_broker_authority_id, p_broker_capability_sha256);
	select sync.secret_id, sync.secret_version, sync.deep_done, secret.status as secret_status,
		secret.current_version, secret.environment_id, version.key_id, version.encrypted_envelope,
		version.envelope_sha256, version.broker_authority_id as sealed_for
	into v_row
	from public.qorpera_bank_syncs as sync
	left join public.qorpera_cloud_secrets as secret on secret.id = sync.secret_id
	left join public.qorpera_cloud_secret_versions as version
		on version.secret_id = sync.secret_id and version.version = sync.secret_version
	where sync.profile_id = v_authority.profile_id and sync.due_at <= v_now
		and (sync.lease_until is null or sync.lease_until <= v_now)
	for update of sync skip locked;
	if not found then
		return null;
	end if;
	if v_row.secret_status is distinct from 'active' or v_row.current_version <> v_row.secret_version
		or v_row.encrypted_envelope is null or v_row.sealed_for <> v_authority.id then
		update public.qorpera_bank_syncs
		set status = 'disconnected', due_at = null, lease_until = null, updated_at = v_now
		where profile_id = v_authority.profile_id;
		return null;
	end if;
	update public.qorpera_bank_syncs
	set lease_until = v_now + interval '10 minutes', attempts = attempts + 1, updated_at = v_now
	where profile_id = v_authority.profile_id;
	-- After the deep fetch, a fetch starts two weeks before the newest booked day it has: a bank may book
	-- a payment some days after its date.
	if v_row.deep_done then
		select max(booked_on) - 14 into v_since
		from public.qorpera_bank_transactions
		where profile_id = v_authority.profile_id;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.bank-sync-claim/v1',
		'companyId', v_authority.profile_id, 'environmentId', v_row.environment_id,
		'secretId', v_row.secret_id, 'secretVersion', v_row.secret_version, 'keyId', v_row.key_id,
		-- Postgres breaks base64 lines at 76 characters; the claim carries one line.
		'encryptedEnvelopeBase64', translate(encode(v_row.encrypted_envelope, 'base64'), E'\n', ''),
		'envelopeSha256', v_row.envelope_sha256,
		'deep', not v_row.deep_done,
		'since', v_since
	);
end
$$;
revoke all on function public.qorpera_claim_bank_sync(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_bank_sync(uuid, text) to qorpera_secret_broker;

-- The leased sync's booked transactions, kept once each; the answer is every kept transaction of the
-- accounts the session reaches (the last 13 months: the summary draws a year), for the summary. A transaction already kept
-- keeps its first form.
create function public.qorpera_record_bank_transactions(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_account_keys jsonb,
	p_transactions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_sync public.qorpera_bank_syncs%rowtype;
	v_kept jsonb;
begin
	v_authority := public.qorpera_bank_sync_authority(p_broker_authority_id, p_broker_capability_sha256);
	if jsonb_typeof(p_account_keys) is distinct from 'array' or jsonb_array_length(p_account_keys) not between 1 and 32
		or exists (select 1 from jsonb_array_elements(p_account_keys) as item(value)
			where jsonb_typeof(item.value) <> 'string' or item.value #>> '{}' !~ '^[0-9a-f]{64}$')
		or jsonb_typeof(p_transactions) is distinct from 'array' or jsonb_array_length(p_transactions) > 20000 then
		raise exception 'bank transactions are invalid' using errcode = '22023';
	end if;
	select sync.* into v_sync
	from public.qorpera_bank_syncs as sync
	where sync.profile_id = v_authority.profile_id
	for update;
	if v_sync.profile_id is null or v_sync.secret_id is distinct from p_secret_id
		or v_sync.secret_version is distinct from p_secret_version
		or v_sync.lease_until is null or v_sync.lease_until <= clock_timestamp() then
		raise exception 'bank sync is not leased' using errcode = '55000';
	end if;
	begin
		insert into public.qorpera_bank_transactions
			(profile_id, account_key, transaction_key, booked_on, amount, currency, counterparty, remittance)
		select v_authority.profile_id, item.value->>'accountKey', item.value->>'key', (item.value->>'date')::date,
			(item.value->>'amount')::numeric(18, 2), item.value->>'currency',
			nullif(item.value->>'counterparty', ''), nullif(item.value->>'text', '')
		from jsonb_array_elements(p_transactions) as item(value)
		where item.value->>'accountKey' in (select key.value #>> '{}' from jsonb_array_elements(p_account_keys) as key(value))
		on conflict (profile_id, account_key, transaction_key) do nothing;
	exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
		or numeric_value_out_of_range or check_violation or not_null_violation then
		raise exception 'bank transactions are invalid' using errcode = '22023';
	end;
	select coalesce(jsonb_agg(jsonb_build_object(
		'accountKey', kept.account_key, 'date', kept.booked_on, 'amount', kept.amount, 'currency', kept.currency,
		'counterparty', kept.counterparty, 'text', kept.remittance
	) order by kept.account_key, kept.booked_on, kept.transaction_key), '[]'::jsonb) into v_kept
	from public.qorpera_bank_transactions as kept
	where kept.profile_id = v_authority.profile_id
		and kept.account_key in (select key.value #>> '{}' from jsonb_array_elements(p_account_keys) as key(value))
		and kept.booked_on >= (current_date - interval '13 months')::date;
	return jsonb_build_object('schema', 'qorpera.bank-transactions-kept/v1', 'transactions', v_kept);
end
$$;
revoke all on function public.qorpera_record_bank_transactions(uuid, text, uuid, bigint, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_bank_transactions(uuid, text, uuid, bigint, jsonb, jsonb)
	to qorpera_secret_broker;

-- The end of a leased sync:
-- - current: a new summary; due again in six hours.
-- - ended: the bank's consent ended; the summary kept is marked paused from today (the Bank page says
--   so), and nothing is due until the member connects again.
-- - failed: offered again after 15 minutes, doubling to six hours; the summary kept is unchanged.
-- A late answer (the lease ran out, or the secret changed) is refused.
create function public.qorpera_finish_bank_sync(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_outcome text,
	p_summary jsonb,
	p_consent_until timestamptz,
	p_deep boolean,
	p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_sync public.qorpera_bank_syncs%rowtype;
	v_now timestamptz := clock_timestamp();
	v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
	v_summary jsonb;
begin
	v_authority := public.qorpera_bank_sync_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_outcome is null or p_outcome not in ('current', 'ended', 'failed') or p_deep is null
		or (p_outcome = 'current' and p_summary is null)
		or (p_outcome <> 'current' and p_summary is not null)
		or (p_outcome = 'failed' and v_error is null)
		or (p_summary is not null and (jsonb_typeof(p_summary) <> 'object'
			or p_summary->>'schema' is distinct from 'qorpera.bank-summary/v1' or pg_column_size(p_summary) > 262144)) then
		raise exception 'bank sync answer is invalid' using errcode = '22023';
	end if;
	select sync.* into v_sync
	from public.qorpera_bank_syncs as sync
	where sync.profile_id = v_authority.profile_id
	for update;
	if v_sync.profile_id is null or v_sync.secret_id is distinct from p_secret_id
		or v_sync.secret_version is distinct from p_secret_version
		or v_sync.lease_until is null or v_sync.lease_until <= v_now then
		raise exception 'bank sync is not leased' using errcode = '55000';
	end if;
	v_summary := case
		when p_summary is not null then p_summary
		when p_outcome = 'ended' and v_sync.summary is not null and v_sync.summary->>'pausedSince' is null
			then jsonb_set(v_sync.summary, '{pausedSince}', to_jsonb(to_char(current_date, 'YYYY-MM-DD')))
	end;
	update public.qorpera_bank_syncs
	set status = case p_outcome when 'failed' then case when v_sync.summary is null then 'failed' else v_sync.status end
			else p_outcome end,
		due_at = case p_outcome
			when 'current' then v_now + interval '6 hours'
			when 'failed' then v_now + least(interval '15 minutes' * power(2, least(greatest(v_sync.attempts - 1, 0), 5)),
				interval '6 hours')
		end,
		lease_until = null,
		attempts = case when p_outcome = 'failed' then v_sync.attempts else 0 end,
		last_error = case when p_outcome = 'failed' then v_error end,
		deep_done = v_sync.deep_done or (p_outcome = 'current' and p_deep),
		consent_until = coalesce(p_consent_until, v_sync.consent_until),
		fetched_at = case when p_outcome = 'failed' then v_sync.fetched_at else v_now end,
		summary = coalesce(v_summary, v_sync.summary),
		summary_generation = v_sync.summary_generation + case when v_summary is null then 0 else 1 end,
		summary_at = case when v_summary is null then v_sync.summary_at else v_now end,
		updated_at = v_now
	where profile_id = v_authority.profile_id
	returning * into v_sync;
	return jsonb_build_object('schema', 'qorpera.bank-sync-result/v1', 'status', v_sync.status,
		'summaryGeneration', v_sync.summary_generation, 'dueAt', v_sync.due_at);
end
$$;
revoke all on function public.qorpera_finish_bank_sync(uuid, text, uuid, bigint, text, jsonb, timestamptz, boolean, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_finish_bank_sync(uuid, text, uuid, bigint, text, jsonb, timestamptz, boolean, text)
	to qorpera_secret_broker;

-- The shared vault's served companies with a bank sync due: one call a pass.
create function public.qorpera_broker_principal_bank_syncs_due(p_principal_id uuid, p_capability_sha256 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_due jsonb;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	select coalesce(jsonb_agg(due.profile_id order by due.profile_id), '[]'::jsonb) into v_due
	from (
		select sync.profile_id
		from public.qorpera_bank_syncs as sync
		join public.qorpera_cloud_secret_broker_authorities as authority
			on authority.profile_id = sync.profile_id and authority.principal_id = v_principal.id
				and authority.status = 'active'
		where sync.due_at <= clock_timestamp()
			and (sync.lease_until is null or sync.lease_until <= clock_timestamp())
		order by sync.due_at
		limit 1000
	) as due;
	return jsonb_build_object('schema', 'qorpera.broker-principal-bank-syncs/v1', 'companyIds', v_due);
end
$$;
revoke all on function public.qorpera_broker_principal_bank_syncs_due(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_broker_principal_bank_syncs_due(uuid, text) to qorpera_secret_broker;
