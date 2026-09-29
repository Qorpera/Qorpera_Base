-- Company delete, step D6 (deploy/first-node/RUNTIME-COMPANY-DELETE.md): cancel a connected account's
-- tokens at Google and GitHub themselves, not only on our side, when a member disconnects it and when
-- its company is deleted. Until now Disconnect only marked the secret revoked, and a deleted company's
-- tokens stayed live upstream (GitHub's never expire).
--
-- Every time a Gmail, Google Drive or GitHub secret goes from active to revoked, each of its stored
-- versions is queued. The ledger has no link to the company, so its rows outlive the purge as receipts;
-- it never holds a token or an account name. The broker that sealed a version (a company's own broker,
-- or the shared vault for the company) claims it, opens the envelope, calls the provider's revoke and
-- completes it. Deleting a company revokes its connector secrets at each finisher pass, and the finisher
-- waits for the company's queue (at most six hours, counted from the later of the deletion request and
-- the entry) before the purge; entries still open then are marked abandoned, since the purge deletes
-- the envelopes.
--
-- Google withdraws the account's whole grant to our one OAuth client on any revoke. Founder's option A
-- (29 Sep): while the same Google account is still connected (active Gmail or Drive, any company not
-- being deleted, this one included), the Google revoke is skipped (`kept_shared`); our copy is still
-- revoked. An entry whose secret has no account name is skipped the same way. Only a Google secret's
-- current version is revoked: its account name is the only one known, and revoking it withdraws the
-- grant of every older token of that account; an older version (which may be another account's, after
-- a reconnect) completes as `superseded`. A disconnected Google entry waits ten minutes, so a quick
-- reconnect of the same account is seen as still connected. GitHub revokes one token per version.
-- Lock order: the finisher holds the company fence (qorpera_lock_profile_gc_fence), then locks the
-- company's secrets in id order, then their grants. Disconnect locks one secret, its grants, then takes
-- a key-share lock on the company row with its audit row; a Disconnect racing the finisher of a
-- deleting company can deadlock, and Postgres ends one of them (the finisher retries next pass).

create table public.qorpera_connector_token_revocations (
	secret_id uuid not null,
	version bigint not null check (version > 0),
	-- Plain ids: the company, environment and broker may be gone.
	profile_id uuid not null,
	environment_id uuid not null,
	broker_authority_id uuid not null,
	connector_id text not null check (connector_id in ('gmail', 'google_drive', 'github')),
	reason text not null check (reason in ('disconnected', 'company_deleted')),
	requested_at timestamptz not null default clock_timestamp(),
	lease_until timestamptz,
	attempts integer not null default 0 check (attempts >= 0),
	last_error text check (last_error is null or char_length(last_error) between 1 and 500),
	outcome text check (outcome in ('revoked', 'already_invalid', 'not_ours', 'kept_shared', 'superseded',
		'envelope_gone', 'abandoned')),
	completed_at timestamptz,
	primary key (secret_id, version),
	check ((outcome is null) = (completed_at is null))
);
create index qorpera_connector_token_revocations_due
	on public.qorpera_connector_token_revocations (broker_authority_id, attempts, requested_at)
	where completed_at is null;
create index qorpera_connector_token_revocations_company
	on public.qorpera_connector_token_revocations (profile_id)
	where completed_at is null;
alter table public.qorpera_connector_token_revocations enable row level security;
revoke all on public.qorpera_connector_token_revocations
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The "same account still connected" check of option A.
create index qorpera_cloud_secrets_active_google_account
	on public.qorpera_cloud_secrets (lower(account_label))
	where status = 'active' and connector_id in ('gmail', 'google_drive');

-- Each version of a connector secret that has just been revoked (Disconnect, a member's removal, a
-- company's deletion).
create function public.qorpera_queue_connector_token_revocations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_connector_token_revocations (secret_id, version, profile_id, environment_id,
		broker_authority_id, connector_id, reason)
	select version.secret_id, version.version, new.profile_id, new.environment_id, version.broker_authority_id,
		new.connector_id,
		case when exists (
			select 1 from public.qorpera_company_deletions as deletion
			where deletion.profile_id = new.profile_id and deletion.purged_at is null
		) then 'company_deleted' else 'disconnected' end
	from public.qorpera_cloud_secret_versions as version
	where version.secret_id = new.id
	on conflict (secret_id, version) do nothing;
	return null;
end
$$;
revoke all on function public.qorpera_queue_connector_token_revocations()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_cloud_secrets_queue_token_revocations
	after update of status on public.qorpera_cloud_secrets
	for each row
	when (old.status = 'active' and new.status = 'revoked' and new.connector_id in ('gmail', 'google_drive', 'github'))
	execute function public.qorpera_queue_connector_token_revocations();

-- A deleting company's connector secrets, revoked as Disconnect does (their grants too). Internal: the
-- finisher calls it under the company fence at each pass, so a connection captured late goes as well.
create function public.qorpera_revoke_company_connector_secrets(p_profile_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_count integer;
begin
	-- Secrets first, in id order, then their grants: the order Disconnect uses for one secret.
	perform 1 from public.qorpera_cloud_secrets
	where profile_id = p_profile_id and status = 'active' and connector_id in ('gmail', 'google_drive', 'github')
	order by id
	for update;
	with revoked as (
		update public.qorpera_cloud_secrets
		set status = 'revoked', revoked_at = statement_timestamp(), updated_at = statement_timestamp()
		where profile_id = p_profile_id and status = 'active' and connector_id in ('gmail', 'google_drive', 'github')
		returning id
	), grants as (
		update public.qorpera_cloud_secret_operation_grants as grant_row
		set status = 'revoked', revoked_at = statement_timestamp()
		from revoked
		where grant_row.secret_id = revoked.id and grant_row.status = 'active'
		returning grant_row.id
	)
	select count(*) into v_count from revoked;
	return v_count;
end
$$;
revoke all on function public.qorpera_revoke_company_connector_secrets(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Open entries the finisher still waits for: each gets six hours from the later of the deletion
-- request and its own queueing.
create function public.qorpera_company_token_revocations_open(p_profile_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
	select count(*)
	from public.qorpera_connector_token_revocations as revocation
	join public.qorpera_company_deletions as deletion on deletion.profile_id = revocation.profile_id
	where revocation.profile_id = p_profile_id and revocation.completed_at is null
		and greatest(revocation.requested_at, deletion.requested_at) > clock_timestamp() - interval '6 hours'
$$;
revoke all on function public.qorpera_company_token_revocations_open(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Right before the purge: what is still open cannot be revoked any more (the envelopes go).
create function public.qorpera_abandon_company_token_revocations(p_profile_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_count integer;
begin
	update public.qorpera_connector_token_revocations
	set outcome = 'abandoned', completed_at = clock_timestamp(), lease_until = null
	where profile_id = p_profile_id and completed_at is null;
	get diagnostics v_count = row_count;
	return v_count;
end
$$;
revoke all on function public.qorpera_abandon_company_token_revocations(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- A broker's due entries, leased for five minutes: those that keep failing come last. An entry whose
-- version is gone, an older version of a Google secret and a Google entry whose account is still
-- connected (option A) complete here without reaching the broker. A disconnected Google entry is due
-- ten minutes after the Disconnect.
create function public.qorpera_claim_connector_token_revocations(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_row record;
	v_outcome text;
	v_claimed jsonb := '[]'::jsonb;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_limit is null or p_limit not between 1 and 20 then
		raise exception 'token revocation claim is invalid' using errcode = '22023';
	end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	for v_row in
		select revocation.secret_id, revocation.version, revocation.profile_id, revocation.environment_id,
			revocation.connector_id, version.key_id, version.encrypted_envelope, version.envelope_sha256,
			secret.account_label, secret.current_version
		from public.qorpera_connector_token_revocations as revocation
		left join public.qorpera_cloud_secret_versions as version
			on version.secret_id = revocation.secret_id and version.version = revocation.version
		left join public.qorpera_cloud_secrets as secret on secret.id = revocation.secret_id
		where revocation.broker_authority_id = v_authority.id and revocation.completed_at is null
			and (revocation.lease_until is null or revocation.lease_until <= clock_timestamp())
			and not (revocation.connector_id in ('gmail', 'google_drive') and revocation.reason = 'disconnected'
				and revocation.requested_at > clock_timestamp() - interval '10 minutes')
		order by revocation.attempts, revocation.requested_at, revocation.secret_id, revocation.version
		limit p_limit
		for update of revocation skip locked
	loop
		v_outcome := case
			when v_row.encrypted_envelope is null then 'envelope_gone'
			when v_row.connector_id in ('gmail', 'google_drive') and v_row.version <> v_row.current_version
				then 'superseded'
			when v_row.connector_id in ('gmail', 'google_drive') and (v_row.account_label is null or exists (
				select 1 from public.qorpera_cloud_secrets as other
				where other.status = 'active' and other.connector_id in ('gmail', 'google_drive')
					and lower(other.account_label) = lower(v_row.account_label)
					and not exists (
						select 1 from public.qorpera_company_deletions as deletion
						where deletion.profile_id = other.profile_id and deletion.purged_at is null
					)
			)) then 'kept_shared'
		end;
		if v_outcome is not null then
			update public.qorpera_connector_token_revocations
			set outcome = v_outcome, completed_at = clock_timestamp(), lease_until = null
			where secret_id = v_row.secret_id and version = v_row.version;
			continue;
		end if;
		update public.qorpera_connector_token_revocations
		set lease_until = clock_timestamp() + interval '5 minutes', attempts = attempts + 1
		where secret_id = v_row.secret_id and version = v_row.version;
		v_claimed := v_claimed || jsonb_build_array(jsonb_build_object(
			'schema', 'qorpera.connector-token-revocation/v1',
			'companyId', v_row.profile_id, 'environmentId', v_row.environment_id,
			'secretId', v_row.secret_id, 'secretVersion', v_row.version, 'keyId', v_row.key_id,
			'connectorId', v_row.connector_id,
			-- Postgres breaks base64 lines at 76 characters; the claim carries one line.
			'encryptedEnvelopeBase64', translate(encode(v_row.encrypted_envelope, 'base64'), E'\n', ''),
			'envelopeSha256', v_row.envelope_sha256
		));
	end loop;
	return v_claimed;
end
$$;
revoke all on function public.qorpera_claim_connector_token_revocations(uuid, text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_connector_token_revocations(uuid, text, integer)
	to qorpera_secret_broker;

-- The broker's answer for one claimed entry: an outcome, or an error after which the entry is offered
-- again later (one minute, doubling to an hour). Idempotent: a completed entry keeps its outcome. After
-- the purge the company's authority is gone, so a late answer is refused.
create function public.qorpera_complete_connector_token_revocation(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_version bigint,
	p_outcome text,
	p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_row public.qorpera_connector_token_revocations%rowtype;
	v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_secret_id is null or p_version is null or (p_outcome is null) = (v_error is null)
		or p_outcome not in ('revoked', 'already_invalid', 'not_ours') then
		raise exception 'token revocation completion is invalid' using errcode = '22023';
	end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	select revocation.* into v_row
	from public.qorpera_connector_token_revocations as revocation
	where revocation.secret_id = p_secret_id and revocation.version = p_version
		and revocation.broker_authority_id = v_authority.id
	for update;
	if v_row.secret_id is null then
		raise exception 'token revocation is unknown' using errcode = 'P0002';
	end if;
	if p_outcome is not null and v_row.completed_at is null then
		update public.qorpera_connector_token_revocations
		set outcome = p_outcome, completed_at = clock_timestamp(), lease_until = null, last_error = null
		where secret_id = p_secret_id and version = p_version
		returning * into v_row;
	elsif p_outcome is null and v_row.completed_at is null then
		update public.qorpera_connector_token_revocations
		set last_error = v_error,
			lease_until = clock_timestamp() + least(interval '1 minute' * power(2, least(attempts - 1, 6)), interval '1 hour')
		where secret_id = p_secret_id and version = p_version
		returning * into v_row;
	end if;
	return jsonb_build_object('schema', 'qorpera.connector-token-revocation-result/v1',
		'secretId', v_row.secret_id, 'secretVersion', v_row.version, 'outcome', v_row.outcome);
end
$$;
revoke all on function public.qorpera_complete_connector_token_revocation(uuid, text, uuid, bigint, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_connector_token_revocation(uuid, text, uuid, bigint, text, text)
	to qorpera_secret_broker;

-- The finisher (as patched by 20260929480000): revoke the company's connector secrets at each pass, wait
-- for the queue, and mark what is still open abandoned right before the storage capture and the purge,
-- in the purge's subtransaction.
do $guard$
begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_finish_company_deletion(uuid)'::regprocedure), 'sha256'), 'hex')
		<> '8d6e98d10b9e021adc01d8696935a3131f0e6f1faeb2420586457147987fc27d' then
		raise exception 'Reviewed function definition changed: public.qorpera_finish_company_deletion(uuid)';
	end if;
end
$guard$;
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_finish_company_deletion(uuid)'::regprocedure);
	v_patches text[][] := array[
		array[E'\t\t\tv_holdings := public.qorpera_company_node_holdings(p_profile_id);\n',
			E'\t\t\tv_holdings := public.qorpera_company_node_holdings(p_profile_id);\n'
			|| E'\t\t\tperform public.qorpera_revoke_company_connector_secrets(p_profile_id);\n'
			|| E'\t\t\tv_holdings := v_holdings || jsonb_build_object(\'connector_tokens\',\n'
			|| E'\t\t\t\tpublic.qorpera_company_token_revocations_open(p_profile_id));\n'],
		array[E'\t\t\tor (v_holdings ->> \'node_updates\')::bigint > 0) then\n',
			E'\t\t\tor (v_holdings ->> \'node_updates\')::bigint > 0\n'
			|| E'\t\t\tor (v_holdings ->> \'connector_tokens\')::bigint > 0) then\n'],
		array[E'\t\t\t\tperform public.qorpera_capture_company_storage(p_profile_id);\n',
			E'\t\t\t\tperform public.qorpera_abandon_company_token_revocations(p_profile_id);\n'
			|| E'\t\t\t\tperform public.qorpera_capture_company_storage(p_profile_id);\n']
	];
begin
	for i in 1 .. array_length(v_patches, 1) loop
		if (length(v_definition) - length(replace(v_definition, v_patches[i][1], ''))) / length(v_patches[i][1]) <> 1 then
			raise exception 'Company deletion finisher differs';
		end if;
		v_definition := replace(v_definition, v_patches[i][1], v_patches[i][2]);
	end loop;
	execute v_definition;
end
$$;
