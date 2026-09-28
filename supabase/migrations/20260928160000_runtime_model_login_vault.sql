-- Stateless Compute step 1, change 1: model logins in the vault.
--
-- A member's Codex login (auth.json) is kept by the cloud secret broker, envelope-encrypted
-- under the company's broker key, as immutable versions. The login is reached through a
-- pointer capsule row in qorpera_native_credential_capsules whose reference is
-- 'model-login/<login id>', so connection versions, leases and lease validation keep their
-- shape; the run's host asks the broker for its login instead of opening a capsule.
--
-- One writer per login: only the broker renews a login, holding a renewal lock that is one
-- row of qorpera_model_logins. Nothing else is locked for update: no company row, no fence,
-- no authority row (a saved version's foreign key takes only a key-share lock on its
-- authority). Runs never write a login back. Nothing uses this yet (changes 2 and 3).

create table public.qorpera_model_logins (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	credential_capsule_id uuid not null unique references public.qorpera_native_credential_capsules(id) on delete restrict,
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	provider text not null check (provider = 'openai'),
	native_harness text not null check (native_harness = 'codex-cli'),
	status text not null default 'active' check (status in ('active','needs_sign_in','revoked')),
	current_version bigint not null check (current_version between 1 and 9007199254740991),
	access_issued_at timestamptz not null,
	access_expires_at timestamptz not null,
	last_issued_at timestamptz,
	renewal_token uuid,
	renewal_until timestamptz,
	renewal_failures integer not null default 0 check (renewal_failures >= 0),
	last_renewal_failure text check (last_renewal_failure is null or last_renewal_failure ~ '^[a-z][a-z0-9_]{0,63}$'),
	renewal_failed_at timestamptz,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	check (access_expires_at > access_issued_at),
	check ((renewal_token is null) = (renewal_until is null))
);

-- Change 3's placement asks whether an identity's login is in the vault.
create index qorpera_model_logins_identity on public.qorpera_model_logins(compute_identity_id) where status = 'active';

create table public.qorpera_model_login_versions (
	login_id uuid not null references public.qorpera_model_logins(id) on delete restrict,
	version bigint not null check (version between 1 and 9007199254740991),
	broker_authority_id uuid not null references public.qorpera_cloud_secret_broker_authorities(id) on delete restrict,
	key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	encrypted_envelope bytea not null check (octet_length(encrypted_envelope) between 1 and 131072),
	envelope_sha256 text not null check (envelope_sha256 ~ '^[0-9a-f]{64}$'),
	origin text not null check (origin in ('sign_in','renewal')),
	access_issued_at timestamptz not null,
	access_expires_at timestamptz not null,
	created_at timestamptz not null default statement_timestamp(),
	primary key (login_id, version),
	unique (login_id, envelope_sha256),
	check (access_expires_at > access_issued_at)
);

alter table public.qorpera_model_logins enable row level security;
alter table public.qorpera_model_login_versions enable row level security;
revoke all on public.qorpera_model_logins, public.qorpera_model_login_versions
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The broker's guard: its own database login, an active authority, the matching capability.
-- A plain read: the authority row is not locked.
create function public.qorpera_model_login_authority(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns public.qorpera_cloud_secret_broker_authorities
language plpgsql stable security definer set search_path = '' as $$
declare v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select authority.* into v_authority from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	return v_authority;
end
$$;

-- A run may receive its login only while the native lease validator would accept it: the
-- same conditions as qorpera_validate_native_provider_execution_lease (exact binding, job
-- leased and unexpired, assignment accepted and unexpired, lease live, sponsor and compute
-- available, connection, version, capsule and policy active, identity active and not fenced
-- on run and runner, company not paused), without company-wide locks: only a run no member
-- started takes, like the validator, a share lock on its member's connection row. The run's
-- host keeps validating its lease with the company fence every 15 s.
create function public.qorpera_model_login_run_binding(p_binding jsonb)
returns public.qorpera_native_provider_connection_leases
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	if jsonb_typeof(p_binding) is distinct from 'object'
		or (select array_agg(key order by key) from jsonb_object_keys(p_binding) as key)
			is distinct from array['assignmentId','computeIdentityId','credentialCapsuleId','jobId','leaseId','runId','runnerId']
		or exists (
			select 1 from jsonb_each(p_binding) as field
			where jsonb_typeof(field.value) <> 'string'
				or field.value #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		) then
		raise exception 'model login run binding is invalid' using errcode = '22023';
	end if;
	select run.* into v_run from public.qorpera_execution_runs as run
	where run.id = (p_binding ->> 'runId')::uuid and run.job_id = (p_binding ->> 'jobId')::uuid;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = (p_binding ->> 'jobId')::uuid and job.run_id = (p_binding ->> 'runId')::uuid;
	select lease.* into v_lease from public.qorpera_native_provider_connection_leases as lease
	where lease.id = (p_binding ->> 'leaseId')::uuid
		and lease.run_id = (p_binding ->> 'runId')::uuid and lease.job_id = (p_binding ->> 'jobId')::uuid
		and lease.runner_id = (p_binding ->> 'runnerId')::uuid
		and lease.assignment_id = (p_binding ->> 'assignmentId')::uuid
		and lease.credential_capsule_id = (p_binding ->> 'credentialCapsuleId')::uuid
		and lease.compute_identity_id = (p_binding ->> 'computeIdentityId')::uuid;
	if v_run.id is null or v_job.id is null or v_lease.id is null
		or v_job.status <> 'leased' or v_job.runner_id <> v_lease.runner_id
		or v_job.client_lease_id <> v_lease.assignment_id
		or v_job.lease_expires_at <= v_now
		or v_lease.status <> 'active' or v_lease.expires_at <= v_now
		or v_run.compute_identity_id is distinct from v_lease.compute_identity_id
		or public.qorpera_company_execution_paused(v_run.profile_id)
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run)
		or not exists (
			select 1 from public.qorpera_runners as runner
			join public.qorpera_member_compute_identities as identity on identity.id = runner.compute_identity_id
			where runner.id = v_lease.runner_id and runner.compute_identity_id = v_lease.compute_identity_id
				and runner.compute_recovery_epoch = identity.recovery_epoch
		)
		or not exists (
			select 1
			from public.qorpera_runner_assignments as assignment
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version
			join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
			join public.qorpera_provider_connection_versions as version
				on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
			join public.qorpera_member_compute_identities as identity on identity.id = v_run.compute_identity_id
			join public.qorpera_provider_execution_policies as policy
				on policy.provider = connection.provider
				and policy.authentication_mode = 'native_subscription'
				and policy.native_harness = version.native_harness
			where assignment.id = v_lease.assignment_id
				and assignment.run_id = v_run.id and assignment.job_id = v_job.id
				and assignment.runner_id = v_lease.runner_id
				and assignment.status = 'accepted' and assignment.expires_at > v_now
				and sponsor.provider_connection_id = v_lease.provider_connection_id
				and sponsor.provider_connection_version = v_lease.provider_connection_version
				and connection.provider = 'openai' and connection.status = 'active'
				and version.authentication_mode = 'native_subscription'
				and version.native_harness = 'codex-cli'
				and version.authorization_state = 'active'
				and capsule.id = v_lease.credential_capsule_id and capsule.status = 'active'
				and capsule.compute_identity_id = v_lease.compute_identity_id
				and identity.status = 'active' and identity.profile_id = v_run.profile_id
				and policy.implementation_status = 'supported'
				and policy.enablement_status = 'enabled'
		) then
		raise exception 'model login run binding is unavailable' using errcode = '42501';
	end if;
	return v_lease;
end
$$;

-- Hands a live run its login: the current version's envelope (the broker strips the renewal
-- token before the run sees it). With p_allow_renewal, a login past half its pass life
-- takes this login's renewal lock for the caller, unless another renewal holds it or the
-- last failed renewal is too recent (1, 2, 4 ... minutes after each failure in a row, at
-- most an hour). With
-- p_known_version equal to the current version and no renewal granted, no envelope is
-- returned (a run's host polling for a newer pass).
create function public.qorpera_issue_model_login(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_known_version bigint,
	p_allow_renewal boolean
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_login public.qorpera_model_logins%rowtype;
	v_version public.qorpera_model_login_versions%rowtype;
	v_renewal uuid;
	v_now timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_allow_renewal is null or (p_known_version is not null and p_known_version < 1) then
		raise exception 'model login issue request is invalid' using errcode = '22023';
	end if;
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select login.* into v_login from public.qorpera_model_logins as login
	where login.credential_capsule_id = v_lease.credential_capsule_id;
	if v_login.id is null or v_login.broker_authority_id <> v_authority.id
		or v_login.profile_id <> v_authority.profile_id or v_login.compute_identity_id <> v_lease.compute_identity_id then
		raise exception 'model login is unavailable to this broker' using errcode = '42501';
	end if;
	if v_login.status <> 'active' then
		raise exception 'model login needs a new sign-in' using errcode = '55000';
	end if;
	if p_allow_renewal
		and v_now >= v_login.access_issued_at + (v_login.access_expires_at - v_login.access_issued_at) / 2 then
		update public.qorpera_model_logins
		set renewal_token = extensions.gen_random_uuid(), renewal_until = v_now + interval '5 minutes',
			last_issued_at = v_now, updated_at = v_now
		where id = v_login.id and current_version = v_login.current_version and status = 'active'
			and (renewal_until is null or renewal_until < v_now)
			and (renewal_failed_at is null or renewal_failed_at <= v_now
				- least(interval '1 minute' * power(2, least(renewal_failures, 7) - 1), interval '1 hour'))
		returning renewal_token into v_renewal;
	end if;
	if v_renewal is null and (v_login.last_issued_at is null or v_login.last_issued_at < v_now - interval '1 minute') then
		update public.qorpera_model_logins set last_issued_at = v_now where id = v_login.id;
	end if;
	if v_renewal is null and p_known_version is not distinct from v_login.current_version then
		return jsonb_build_object(
			'schema', 'qorpera.model-login-issue/v1',
			'loginId', v_login.id,
			'companyId', v_login.profile_id,
			'computeIdentityId', v_login.compute_identity_id,
			'version', v_login.current_version,
			'accessIssuedAt', v_login.access_issued_at,
			'accessExpiresAt', v_login.access_expires_at,
			'renewing', v_login.renewal_until is not null and v_login.renewal_until >= v_now,
			'unchanged', true
		);
	end if;
	select version.* into strict v_version from public.qorpera_model_login_versions as version
	where version.login_id = v_login.id and version.version = v_login.current_version;
	return jsonb_build_object(
		'schema', 'qorpera.model-login-issue/v1',
		'loginId', v_login.id,
		'companyId', v_login.profile_id,
		'computeIdentityId', v_login.compute_identity_id,
		'version', v_version.version,
		'keyId', v_version.key_id,
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'accessIssuedAt', v_version.access_issued_at,
		'accessExpiresAt', v_version.access_expires_at,
		'renewing', v_renewal is null and v_login.renewal_until is not null and v_login.renewal_until >= v_now,
		'unchanged', false,
		'renewal', case when v_renewal is null then null else jsonb_build_object(
			'token', v_renewal, 'baseVersion', v_version.version, 'keyId', v_authority.key_id) end
	);
end
$$;

-- Saves a renewed login as the next version, only by the holder of the renewal lock taken on
-- exactly the version it renewed from (a lock token is written anew each time the lock is
-- taken, so a matching token proves nobody took it over, even after it lapsed), and only
-- for a later pass. A repeated call after a lost answer finds its own version saved.
create function public.qorpera_commit_model_login_renewal(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_renewal_token uuid,
	p_base_version bigint,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_envelope bytea;
	v_version bigint;
	v_now timestamptz := clock_timestamp();
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or p_renewal_token is null or p_base_version is null or p_base_version < 1
		or p_key_id is distinct from v_authority.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_access_issued_at is null or p_access_expires_at is null
		or p_access_expires_at <= p_access_issued_at
		or p_access_expires_at <= v_now
		or p_access_issued_at > v_now + interval '5 minutes'
		or p_access_expires_at - p_access_issued_at > interval '400 days' then
		raise exception 'model login renewal is invalid' using errcode = '22023';
	end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'model login renewal is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_model_logins as login
		join public.qorpera_model_login_versions as version
			on version.login_id = login.id and version.version = login.current_version
		where login.id = p_login_id and login.broker_authority_id = v_authority.id
			and login.current_version = p_base_version + 1 and version.envelope_sha256 = p_envelope_sha256
	) then
		return jsonb_build_object('schema', 'qorpera.model-login-renewal/v1', 'loginId', p_login_id,
			'version', p_base_version + 1);
	end if;
	update public.qorpera_model_logins
	set current_version = p_base_version + 1, access_issued_at = p_access_issued_at,
		access_expires_at = p_access_expires_at, renewal_token = null, renewal_until = null,
		renewal_failures = 0, last_renewal_failure = null, renewal_failed_at = null, updated_at = v_now
	where id = p_login_id and broker_authority_id = v_authority.id and status = 'active'
		and current_version = p_base_version and renewal_token = p_renewal_token
		and access_expires_at < p_access_expires_at
	returning current_version into v_version;
	if v_version is null then
		if exists (select 1 from public.qorpera_model_logins where id = p_login_id and broker_authority_id = v_authority.id
			and status = 'active' and current_version = p_base_version and renewal_token = p_renewal_token) then
			raise exception 'model login renewal is not a later pass' using errcode = '22023';
		end if;
		raise exception 'model login renewal lock is not held' using errcode = '55000';
	end if;
	insert into public.qorpera_model_login_versions(
		login_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, origin,
		access_issued_at, access_expires_at)
	values (p_login_id, v_version, v_authority.id, p_key_id, v_envelope, p_envelope_sha256, 'renewal',
		p_access_issued_at, p_access_expires_at);
	return jsonb_build_object('schema', 'qorpera.model-login-renewal/v1', 'loginId', p_login_id, 'version', v_version);
end
$$;

-- Gives the renewal lock back after a failed renewal. A permanent failure (the provider
-- refused the renewal token, or a renewal it made could not be saved) marks the login for a
-- new sign-in, but only while the login is still at the version the renewal started from: a
-- newer version (a fresh sign-in) is never marked. A transient failure lets a later caller
-- try again.
create function public.qorpera_release_model_login_renewal(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_renewal_token uuid,
	p_base_version bigint,
	p_permanent boolean,
	p_reason text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_status text;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or p_renewal_token is null or p_permanent is null
		or p_base_version is null or p_base_version < 1
		or coalesce(p_reason, '') !~ '^[a-z][a-z0-9_]{0,63}$' then
		raise exception 'model login renewal release is invalid' using errcode = '22023';
	end if;
	update public.qorpera_model_logins
	set status = case when p_permanent and status = 'active' and current_version = p_base_version
			then 'needs_sign_in' else status end,
		renewal_token = null, renewal_until = null,
		renewal_failures = renewal_failures + 1, last_renewal_failure = p_reason,
		renewal_failed_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = p_login_id and broker_authority_id = v_authority.id and renewal_token = p_renewal_token
	returning status into v_status;
	return jsonb_build_object('schema', 'qorpera.model-login-renewal-release/v1', 'loginId', p_login_id,
		'released', v_status is not null, 'status', v_status);
end
$$;

revoke all on function public.qorpera_model_login_authority(uuid,text),
	public.qorpera_model_login_run_binding(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_issue_model_login(uuid,text,jsonb,bigint,boolean),
	public.qorpera_commit_model_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamptz,timestamptz),
	public.qorpera_release_model_login_renewal(uuid,text,uuid,uuid,bigint,boolean,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_issue_model_login(uuid,text,jsonb,bigint,boolean),
	public.qorpera_commit_model_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamptz,timestamptz),
	public.qorpera_release_model_login_renewal(uuid,text,uuid,uuid,bigint,boolean,text)
	to qorpera_secret_broker;
