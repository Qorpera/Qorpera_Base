-- Stateless Compute step 1, change 2B: a member signs in to the vault.
--
-- For a company switched to vault sign-in, the login gateway chooser sends a Codex sign-in to
-- the company's broker (`<service origin>/v1/model-logins/<company>/`) instead of a node. The
-- broker runs the official sign-in in its helper and completes it here in one transaction: a
-- pointer capsule 'model-login/<login id>', the vault login and its version 1, and the
-- connection version that points at the pointer capsule. No node key exists for such a login,
-- so the recovery backup a node sign-in needs does not apply to it. Claude sign-ins and
-- companies not switched keep the node path unchanged. A company can be switched only once
-- runs take their login from the vault (change 3). Usage checks move in a later change.

-- The sign-in that created a vault login. It is the evidence the recovery pin reads.
alter table public.qorpera_model_logins
	add column sign_in_session_id uuid unique
		references public.qorpera_native_provider_login_sessions(id) on delete set null;

-- Companies whose new Codex sign-ins go to the vault (switched one by one by an operator).
create table public.qorpera_model_login_sign_in_companies (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	enabled_at timestamptz not null default statement_timestamp()
);
alter table public.qorpera_model_login_sign_in_companies enable row level security;
revoke all on public.qorpera_model_login_sign_in_companies
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_set_model_login_sign_in(p_profile_id uuid, p_enabled boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or p_profile_id is null or p_enabled is null then
		raise exception 'model login sign-in switch requires service authority' using errcode = '42501';
	end if;
	if p_enabled then
		-- A vault login is usable only once runs take their login from the vault (change 3).
		if to_regprocedure('public.qorpera_compute_identity_login_in_vault(uuid)') is null then
			raise exception 'vault login runs are not installed' using errcode = '55000';
		end if;
		if not exists (select 1 from public.qorpera_cloud_secret_broker_authorities
			where profile_id = p_profile_id and status = 'active') then
			raise exception 'company has no active cloud secret broker' using errcode = '55000';
		end if;
		insert into public.qorpera_model_login_sign_in_companies(profile_id) values (p_profile_id)
		on conflict (profile_id) do nothing;
	else
		delete from public.qorpera_model_login_sign_in_companies where profile_id = p_profile_id;
	end if;
	return p_enabled;
end
$$;
revoke all on function public.qorpera_set_model_login_sign_in(uuid, boolean) from public, anon, authenticated;
grant execute on function public.qorpera_set_model_login_sign_in(uuid, boolean) to service_role;

-- The vault's sign-in base for a switched company with an active broker, else null.
create function public.qorpera_model_login_sign_in_url(p_profile_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
	select rtrim(authority.service_origin, '/') || '/v1/model-logins/' || company.profile_id::text || '/'
	from public.qorpera_model_login_sign_in_companies as company
	join public.qorpera_cloud_secret_broker_authorities as authority
		on authority.profile_id = company.profile_id and authority.status = 'active'
	where company.profile_id = p_profile_id
	order by authority.created_at desc, authority.id
	limit 1
$$;
revoke all on function public.qorpera_model_login_sign_in_url(uuid) from public, anon, authenticated, service_role;

do $$
declare
	v_target regprocedure;
	v_definition text;
	v_count integer;
	v_anchor text;
begin
	-- The recovery pin: a sign-in that created a vault login needs no node key backup.
	v_target := 'public.qorpera_pin_login_recovery_epoch()'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('qorpera_model_logins' in v_definition) = 0 then
		v_anchor := 'if new.status=''completed'' and exists(select 1 from public.qorpera_identity_recovery_authorities';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Login recovery pin source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			'if new.status=''completed'' and not exists(select 1 from public.qorpera_model_logins vault'
				|| ' where vault.sign_in_session_id=new.id)'
				|| ' and exists(select 1 from public.qorpera_identity_recovery_authorities');
	end if;

	-- The login gateway chooser: a switched company's Codex sign-in goes to its vault.
	v_target := 'public.qorpera_runtime_login_gateway_choose(text)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('qorpera_model_login_sign_in_url' in v_definition) = 0 then
		v_anchor := E'\tif v_session.id is not null then\n\t\tselect g.* into v_gateway from public.qorpera_runtime_login_machine_requests r';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Login gateway chooser source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			E'\tif v_session.id is not null and v_session.provider = ''openai'' and v_session.native_harness = ''codex-cli''\n'
			|| E'\t\tand public.qorpera_model_login_sign_in_url(v_session.profile_id) is not null then\n'
			|| E'\t\treturn jsonb_build_object(''url'', public.qorpera_model_login_sign_in_url(v_session.profile_id),\n'
			|| E'\t\t\t''providerId'', ''model-login-vault'', ''nodeId'', null, ''reason'', ''MODEL_LOGIN_VAULT'',\n'
			|| E'\t\t\t''identityHomes'', to_jsonb(v_homes));\n'
			|| E'\tend if;\n'
			|| v_anchor);
	end if;
end
$$;

-- The company a broker serves, so it can collect its finished sign-ins from the helper.
create function public.qorpera_model_login_broker_company(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text
)
returns uuid
language plpgsql security definer set search_path = '' as $$
begin
	return (public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256)).profile_id;
end
$$;

-- The broker reads a pending sign-in of its own company by the member's login capability.
create function public.qorpera_describe_model_login_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'model login sign-in request is invalid' using errcode = '22023';
	end if;
	select session.* into v_session from public.qorpera_native_provider_login_sessions as session
	where session.id = p_login_id;
	if v_session.id is null or v_session.capability_sha256 <> p_capability_sha256
		or v_session.profile_id <> v_authority.profile_id
		or v_session.provider <> 'openai' or v_session.native_harness <> 'codex-cli'
		or public.qorpera_model_login_sign_in_url(v_session.profile_id) is null then
		raise exception 'model login sign-in is unavailable' using errcode = '42501';
	end if;
	select identity.* into strict v_identity from public.qorpera_member_compute_identities as identity
	where identity.id = v_session.compute_identity_id;
	return jsonb_build_object(
		'schema', 'qorpera.model-login-sign-in/v1',
		'loginId', v_session.id,
		'profileId', v_session.profile_id,
		'computeIdentityId', v_session.compute_identity_id,
		'computeIdentityOwnershipKind', v_identity.ownership_kind,
		'computeIdentityOwnerUserId', v_identity.owner_user_id,
		'computeIdentityOwnerScopeKey', v_identity.owner_scope_key,
		'clientConnectionId', v_session.client_connection_id,
		'status', case when v_session.status = 'pending' and v_session.expires_at <= clock_timestamp()
			then 'expired' else v_session.status end,
		'expiresAt', v_session.expires_at,
		'keyId', v_authority.key_id,
		'modelLoginId', (select vault.id from public.qorpera_model_logins as vault
			where vault.sign_in_session_id = v_session.id)
	);
end
$$;

-- The broker completes a sign-in with the member's login, sealed under the company's broker
-- key, in one transaction. A repeat after a lost answer finds its own login and succeeds.
create function public.qorpera_complete_model_login_sign_in(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_login_id uuid,
	p_capability_sha256 text,
	p_model_login_id uuid,
	p_key_id text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_access_issued_at timestamptz,
	p_access_expires_at timestamptz,
	p_provider_account_reference text,
	p_provider_account_email text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_session public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_existing public.qorpera_model_logins%rowtype;
	v_capsule_id uuid := extensions.gen_random_uuid();
	v_envelope bytea;
	v_version bigint;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_login_id is null or p_model_login_id is null
		or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_key_id is distinct from v_authority.key_id
		or coalesce(p_envelope_sha256, '') !~ '^[0-9a-f]{64}$'
		or char_length(coalesce(p_encrypted_envelope_base64, '')) not between 1 and 180000
		or p_access_issued_at is null or p_access_expires_at is null
		or p_access_expires_at <= p_access_issued_at
		or p_access_expires_at <= clock_timestamp()
		or (p_provider_account_reference is not null
			and char_length(btrim(p_provider_account_reference)) not between 1 and 512)
		or (p_provider_account_email is not null
			and char_length(btrim(p_provider_account_email)) not between 3 and 254) then
		raise exception 'model login sign-in completion is invalid' using errcode = '22023';
	end if;
	v_envelope := decode(p_encrypted_envelope_base64, 'base64');
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope, 'sha256'), 'hex') <> p_envelope_sha256 then
		raise exception 'model login sign-in completion is invalid' using errcode = '22023';
	end if;
	select session.* into v_session from public.qorpera_native_provider_login_sessions as session
	where session.id = p_login_id
	for update;
	if v_session.id is null or v_session.capability_sha256 <> p_capability_sha256
		or v_session.profile_id <> v_authority.profile_id
		or v_session.provider <> 'openai' or v_session.native_harness <> 'codex-cli' then
		raise exception 'model login sign-in is unavailable' using errcode = '42501';
	end if;
	-- A repeat of a completion whose answer was lost.
	select vault.* into v_existing from public.qorpera_model_logins as vault
	where vault.sign_in_session_id = v_session.id;
	if v_existing.id is not null then
		if v_existing.id <> p_model_login_id or not exists (
			select 1 from public.qorpera_model_login_versions as version
			where version.login_id = v_existing.id and version.version = 1
				and version.envelope_sha256 = p_envelope_sha256) then
			raise exception 'model login sign-in is already complete' using errcode = '55000';
		end if;
		return (
			select jsonb_build_object('schema', 'qorpera.model-login-sign-in-complete/v1',
				'loginId', v_session.id, 'modelLoginId', v_existing.id,
				'credentialCapsuleId', v_existing.credential_capsule_id,
				'connectionId', version.connection_id, 'connectionVersion', version.version)
			from public.qorpera_provider_connection_versions as version
			where version.credential_capsule_id = v_existing.credential_capsule_id
			order by version.version desc limit 1
		);
	end if;
	if v_session.status <> 'pending' or v_session.expires_at <= statement_timestamp()
		or public.qorpera_model_login_sign_in_url(v_session.profile_id) is null then
		raise exception 'model login sign-in is unavailable' using errcode = '55000';
	end if;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_session.compute_identity_id and identity.profile_id = v_session.profile_id
		and identity.status = 'active';
	select policy.* into v_policy
	from public.qorpera_provider_execution_policies as policy
	where policy.provider = v_session.provider
		and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = v_session.native_harness
		and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled'
	for share;
	if not found then
		raise exception 'native provider policy does not authorize this connection' using errcode = '42501';
	end if;
	-- The pointer capsule: the connection version, the lease and the run's host reach the vault
	-- login through it. Its attestation names the vault, not a node host.
	insert into public.qorpera_native_credential_capsules (
		id, profile_id, compute_identity_id, ownership_kind, owner_user_id, owner_scope_key,
		provider, native_harness, encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id
	) values (
		v_capsule_id, v_session.profile_id, v_session.compute_identity_id,
		v_identity.ownership_kind, v_identity.owner_user_id, v_identity.owner_scope_key,
		v_session.provider, v_session.native_harness, 'model-login/' || p_model_login_id::text,
		encode(extensions.digest('qorpera.model-login-vault/v1', 'sha256'), 'hex'), v_session.requested_by_user_id
	);
	insert into public.qorpera_model_logins (
		id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider,
		native_harness, current_version, access_issued_at, access_expires_at, sign_in_session_id
	) values (
		p_model_login_id, v_session.profile_id, v_session.compute_identity_id, v_capsule_id, v_authority.id,
		v_session.provider, v_session.native_harness, 1, p_access_issued_at, p_access_expires_at, v_session.id
	);
	insert into public.qorpera_model_login_versions (
		login_id, version, broker_authority_id, key_id, encrypted_envelope, envelope_sha256, origin,
		access_issued_at, access_expires_at
	) values (
		p_model_login_id, 1, v_authority.id, p_key_id, v_envelope, p_envelope_sha256, 'sign_in',
		p_access_issued_at, p_access_expires_at
	);
	-- The connection and its new version, exactly as a node sign-in records them.
	insert into public.qorpera_provider_connections (
		profile_id, client_connection_id, owner_user_id, provider, created_by_user_id
	) values (
		v_session.profile_id, v_session.client_connection_id, v_identity.owner_user_id,
		v_session.provider, v_session.requested_by_user_id
	)
	on conflict (profile_id, client_connection_id) do update set
		status = case
			when public.qorpera_provider_connections.owner_user_id is not distinct from excluded.owner_user_id
				and public.qorpera_provider_connections.provider = excluded.provider
			then 'active'
			else public.qorpera_provider_connections.status
		end
	returning * into v_connection;
	if v_connection.owner_user_id is distinct from v_identity.owner_user_id
		or v_connection.provider <> v_session.provider then
		raise exception 'provider connection identity is already bound' using errcode = '23505';
	end if;
	select coalesce(max(version), 0) + 1 into v_version
	from public.qorpera_provider_connection_versions
	where connection_id = v_connection.id;
	insert into public.qorpera_provider_connection_versions (
		connection_id, version, authentication_mode, native_harness, secret_reference,
		provider_account_reference, provider_account_email, billing_source, consent_version, consented_by_user_id,
		allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency
	) values (
		v_connection.id, v_version, 'native_subscription', v_session.native_harness, null,
		nullif(btrim(p_provider_account_reference), ''), nullif(btrim(p_provider_account_email), ''),
		'personal_subscription', 'qorpera-native-subscription-v1', v_session.requested_by_user_id, false,
		v_policy.commercial_reference,
		jsonb_build_object('monthly_microusd', 1, 'reservation_microusd', 1, 'max_calls_per_run', 128,
			'max_input_tokens_per_run', 100000000, 'max_output_tokens_per_run', 100000000,
			'max_concurrent_runs', v_policy.max_native_concurrency),
		v_session.requested_by_user_id, v_capsule_id, 'active', v_policy.max_native_concurrency
	);
	-- The recovery pin still fences a recovering identity; it finds this vault login and asks
	-- for no node key backup.
	update public.qorpera_native_provider_login_sessions
	set status = 'completed', completed_at = statement_timestamp()
	where id = v_session.id;
	return jsonb_build_object('schema', 'qorpera.model-login-sign-in-complete/v1',
		'loginId', v_session.id, 'modelLoginId', p_model_login_id, 'credentialCapsuleId', v_capsule_id,
		'connectionId', v_connection.id, 'connectionVersion', v_version);
end
$$;

revoke all on function
	public.qorpera_model_login_broker_company(uuid, text),
	public.qorpera_describe_model_login_sign_in(uuid, text, uuid, text),
	public.qorpera_complete_model_login_sign_in(uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text)
	from public, anon, authenticated, service_role;
grant execute on function
	public.qorpera_model_login_broker_company(uuid, text),
	public.qorpera_describe_model_login_sign_in(uuid, text, uuid, text),
	public.qorpera_complete_model_login_sign_in(uuid, text, uuid, text, uuid, text, text, text, timestamptz, timestamptz, text, text)
	to qorpera_secret_broker;
