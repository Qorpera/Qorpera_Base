-- Stateless Compute step 1, change 2C: the vault reads the usage of the logins it keeps.
--
-- The account refresh chooser sends a refresh of an identity whose Codex login is in the vault (it
-- has a vault login and no Codex login on a node) to its company's broker (`<service origin>/v1/
-- model-logins/<company>/`), whether or not the company still takes new sign-ins in the vault. A
-- Claude login stays on a node and is never refreshed there (nodes read Codex usage only), so it
-- does not keep a Codex vault login's usage on the node path. The broker reads, under the
-- refresh's own capability, the current version of each vault login of that identity, reads its
-- usage with the pass (the same `wham/usage` call a node makes, no machine), records the display
-- metadata for the connection version that uses the login, and completes the refresh. An
-- identity still moving (a Codex login on a node beside its vault login) keeps the node path,
-- which reads its node logins and skips its vault ones.

-- The refresh chooser and the broker find the connection versions that use a capsule on every
-- poll; the node's own list reaches them only through the connection.
create index qorpera_provider_connection_versions_capsule
	on public.qorpera_provider_connection_versions(credential_capsule_id)
	where credential_capsule_id is not null;

-- The company's vault base, when it has an active broker.
create function public.qorpera_model_login_vault_url(p_profile_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
	select rtrim(authority.service_origin, '/') || '/v1/model-logins/' || authority.profile_id::text || '/'
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.profile_id = p_profile_id and authority.status = 'active'
	order by authority.created_at desc, authority.id
	limit 1
$$;
revoke all on function public.qorpera_model_login_vault_url(uuid) from public, anon, authenticated, service_role;

-- Whether an identity's Codex usage is read in the vault: it has a vault login behind an active
-- pointer (in any state: one that needs a new sign-in reads nothing there, and boots no machine)
-- and no Codex login a node would read (the node's own list: an active capsule that the latest,
-- active, native version of an active OpenAI connection uses).
create function public.qorpera_model_login_usage_in_vault(p_compute_identity_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_model_logins as vault on vault.credential_capsule_id = capsule.id
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
				and vault.compute_identity_id = p_compute_identity_id
		)
		and not exists (
			select 1 from public.qorpera_native_credential_capsules as capsule
			join public.qorpera_provider_connection_versions as version on version.credential_capsule_id = capsule.id
			join public.qorpera_provider_connections as connection on connection.id = version.connection_id
			where capsule.compute_identity_id = p_compute_identity_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference !~ '^model-login/[0-9a-f-]{36}$'
				and connection.status = 'active' and connection.provider = 'openai'
				and version.authorization_state = 'active' and version.authentication_mode = 'native_subscription'
				and version.native_harness = 'codex-cli'
				and not exists (select 1 from public.qorpera_provider_connection_versions as newer
					where newer.connection_id = version.connection_id and newer.version > version.version)
		)
$$;
revoke all on function public.qorpera_model_login_usage_in_vault(uuid) from public, anon, authenticated, service_role;

do $$
declare
	v_target regprocedure;
	v_definition text;
	v_count integer;
	v_anchor text;
begin
	-- The refresh chooser: an identity whose login is in the vault goes to its company's vault.
	v_target := 'public.qorpera_runtime_account_refresh_gateway_choose(text)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	if position('qorpera_model_login_vault_url' in v_definition) = 0 then
		v_anchor := E'\tif v_session.id is not null then\n\t\tselect g.* into v_gateway from public.qorpera_runtime_account_refresh_machine_requests r';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Account refresh chooser source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			E'\tif v_session.id is not null and public.qorpera_model_login_usage_in_vault(v_session.compute_identity_id)\n'
			|| E'\t\tand public.qorpera_model_login_vault_url(v_session.profile_id) is not null then\n'
			|| E'\t\treturn jsonb_build_object(''url'', public.qorpera_model_login_vault_url(v_session.profile_id),\n'
			|| E'\t\t\t''providerId'', ''model-login-vault'', ''nodeId'', null, ''reason'', ''MODEL_LOGIN_VAULT'',\n'
			|| E'\t\t\t''identityHomes'', to_jsonb(v_homes));\n'
			|| E'\tend if;\n'
			|| v_anchor);
	end if;
end
$$;

-- The refresh this capability names, if it belongs to this broker's company.
create function public.qorpera_model_login_account_refresh(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_capability_sha256 text
)
returns public.qorpera_native_account_refresh_requests
language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_request public.qorpera_native_account_refresh_requests%rowtype;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_request_id is null or coalesce(p_capability_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'model login account refresh request is invalid' using errcode = '22023';
	end if;
	-- The node's own route checks: the refresh is live, and its member still owns the identity
	-- with a role that may refresh.
	select request.* into v_request from public.qorpera_native_account_refresh_requests as request
	where request.id = p_request_id and request.capability_sha256 = p_capability_sha256
		and request.expires_at > clock_timestamp() and request.status in ('pending', 'completed');
	if v_request.id is null or v_request.profile_id <> v_authority.profile_id
		or not exists (select 1 from public.qorpera_member_compute_identities as identity
			join public.qorpera_profile_members as member
				on member.profile_id = identity.profile_id and member.user_id = v_request.requested_by_user_id
			where identity.id = v_request.compute_identity_id and identity.profile_id = v_request.profile_id
				and identity.status = 'active' and identity.ownership_kind = 'member'
				and identity.owner_user_id = v_request.requested_by_user_id
				and member.role in ('owner', 'admin', 'contributor')) then
		raise exception 'model login account refresh is unavailable' using errcode = '42501';
	end if;
	return v_request;
end
$$;
revoke all on function public.qorpera_model_login_account_refresh(uuid, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The broker reads the refresh and the current version of each vault login of its identity that
-- the latest version of an active connection uses.
create function public.qorpera_describe_model_login_account_refresh(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	return jsonb_build_object(
		'schema', 'qorpera.model-login-account-refresh/v1',
		'requestId', v_request.id,
		'profileId', v_request.profile_id,
		'computeIdentityId', v_request.compute_identity_id,
		'requestedByUserId', v_request.requested_by_user_id,
		'status', v_request.status,
		'expiresAt', v_request.expires_at,
		-- Only a pending refresh reads logins, at most 8 of them.
		'logins', case when v_request.status <> 'pending' then '[]'::jsonb else coalesce((
			select jsonb_agg(login order by login ->> 'loginId') from (select jsonb_build_object(
				'loginId', vault.id,
				'version', version.version,
				'keyId', version.key_id,
				'encryptedEnvelopeBase64', encode(version.encrypted_envelope, 'base64'),
				'envelopeSha256', version.envelope_sha256,
				'connectionId', connection_version.connection_id,
				'connectionVersion', connection_version.version,
				'credentialCapsuleId', vault.credential_capsule_id
			) as login
			from public.qorpera_model_logins as vault
			join public.qorpera_native_credential_capsules as capsule
				on capsule.id = vault.credential_capsule_id and capsule.status = 'active'
				and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
			join public.qorpera_model_login_versions as version
				on version.login_id = vault.id and version.version = vault.current_version
			join public.qorpera_provider_connection_versions as connection_version
				on connection_version.credential_capsule_id = vault.credential_capsule_id
				and connection_version.authorization_state = 'active'
			join public.qorpera_provider_connections as connection
				on connection.id = connection_version.connection_id and connection.status = 'active'
			left join public.qorpera_native_provider_account_metadata as seen
				on seen.connection_id = connection_version.connection_id
				and seen.connection_version = connection_version.version
			where vault.compute_identity_id = v_request.compute_identity_id
				and vault.profile_id = v_request.profile_id
				and vault.status = 'active'
				and vault.broker_authority_id = p_broker_authority_id
				and not exists (select 1 from public.qorpera_provider_connection_versions as newer
					where newer.connection_id = connection_version.connection_id
						and newer.version > connection_version.version)
			-- Never read first, then the longest unread, as a node lists them.
			order by seen.checked_at nulls first, vault.id
			limit 8) as logins
		), '[]'::jsonb) end
	);
end
$$;

-- The broker records one vault login's display metadata for the connection version that uses it,
-- with the same checks and merge rule as a node's record.
create function public.qorpera_record_model_login_account_metadata(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_capability_sha256 text,
	p_login_id uuid,
	p_connection_id uuid,
	p_connection_version bigint,
	p_provider_account_email text,
	p_provider_account_usage jsonb,
	p_provider_account_identity text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
	v_window jsonb;
	v_observed timestamptz;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	if v_request.status not in ('pending', 'completed') or v_request.expires_at <= clock_timestamp() then
		raise exception 'model login account refresh has ended' using errcode = '55000';
	end if;
	perform 1 from public.qorpera_model_logins as vault
	join public.qorpera_native_credential_capsules as capsule
		on capsule.id = vault.credential_capsule_id and capsule.status = 'active'
		and capsule.encrypted_capsule_reference = 'model-login/' || vault.id::text
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.credential_capsule_id = vault.credential_capsule_id
		and connection_version.connection_id = p_connection_id and connection_version.version = p_connection_version
		and connection_version.authorization_state = 'active'
	join public.qorpera_provider_connections as connection
		on connection.id = connection_version.connection_id and connection.status = 'active'
	where vault.id = p_login_id and vault.status = 'active'
		and vault.compute_identity_id = v_request.compute_identity_id
		and vault.profile_id = v_request.profile_id
		and vault.broker_authority_id = p_broker_authority_id
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection_version.connection_id and newer.version > connection_version.version);
	if not found then raise exception 'model login account metadata connection unavailable' using errcode = '42501'; end if;
	if p_provider_account_email is not null and (
		char_length(p_provider_account_email) not between 3 and 254
		or p_provider_account_email <> btrim(p_provider_account_email)
		or p_provider_account_email !~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+\.[^[:space:]@[:cntrl:]]+$'
	) then raise exception 'Account email invalid' using errcode = '22023'; end if;
	if p_provider_account_identity is not null and p_provider_account_identity !~ '^[0-9a-f]{64}$' then
		raise exception 'Account identity invalid' using errcode = '22023'; end if;
	if p_provider_account_usage is not null then
		if jsonb_typeof(p_provider_account_usage) <> 'object' or pg_column_size(p_provider_account_usage) > 4096
			or p_provider_account_usage - array['observedAt','windows'] <> '{}'::jsonb
			or jsonb_typeof(p_provider_account_usage -> 'observedAt') is distinct from 'string'
			or jsonb_typeof(p_provider_account_usage -> 'windows') is distinct from 'array' then
			raise exception 'Account usage invalid' using errcode = '22023'; end if;
		v_observed := (p_provider_account_usage ->> 'observedAt')::timestamptz;
		if v_observed not between clock_timestamp() - interval '5 minutes' and clock_timestamp() + interval '30 seconds'
			or jsonb_array_length(p_provider_account_usage -> 'windows') not between 1 and 2 then
			raise exception 'Account usage observation invalid' using errcode = '22023'; end if;
		for v_window in select value from jsonb_array_elements(p_provider_account_usage -> 'windows') loop
			if jsonb_typeof(v_window) <> 'object'
				or v_window - array['id','label','usedPercent','resetAt','windowSeconds'] <> '{}'::jsonb
				or coalesce(v_window ->> 'id','') not in ('primary','secondary')
				or jsonb_typeof(v_window -> 'label') is distinct from 'string'
				or char_length(v_window ->> 'label') not between 1 and 80
				or jsonb_typeof(v_window -> 'usedPercent') is distinct from 'number'
				or (v_window ->> 'usedPercent')::numeric not between 0 and 100
				or (v_window ? 'windowSeconds' and (jsonb_typeof(v_window -> 'windowSeconds') <> 'number'
					or (v_window ->> 'windowSeconds')::numeric not between 1 and 31536000)) then
				raise exception 'Account usage window invalid' using errcode = '22023'; end if;
			if v_window ? 'resetAt' and (jsonb_typeof(v_window -> 'resetAt') <> 'string'
				or (v_window ->> 'resetAt')::timestamptz not between v_observed - interval '1 day' and v_observed + interval '366 days') then
				raise exception 'Account usage reset invalid' using errcode = '22023'; end if;
		end loop;
		if (select count(distinct value ->> 'id') from jsonb_array_elements(p_provider_account_usage -> 'windows'))
			<> jsonb_array_length(p_provider_account_usage -> 'windows') then
			raise exception 'Duplicate usage window' using errcode = '22023'; end if;
	end if;
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_email,
		provider_account_usage, provider_account_identity)
	values (p_connection_id, p_connection_version, p_provider_account_email, p_provider_account_usage, p_provider_account_identity)
	on conflict (connection_id, connection_version) do update set
		provider_account_identity = coalesce(excluded.provider_account_identity, qorpera_native_provider_account_metadata.provider_account_identity),
		provider_account_email = coalesce(excluded.provider_account_email, qorpera_native_provider_account_metadata.provider_account_email),
		provider_account_usage = case when excluded.provider_account_usage is not null
			and (qorpera_native_provider_account_metadata.provider_account_usage is null
				or (excluded.provider_account_usage ->> 'observedAt')::timestamptz >= (qorpera_native_provider_account_metadata.provider_account_usage ->> 'observedAt')::timestamptz)
			then excluded.provider_account_usage else qorpera_native_provider_account_metadata.provider_account_usage end,
		checked_at = clock_timestamp();
	return true;
end
$$;

-- The broker completes the refresh once its bounded reads have settled (not a claim that every
-- provider answered), as a node does.
create function public.qorpera_complete_model_login_account_refresh(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_capability_sha256 text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
	v_request public.qorpera_native_account_refresh_requests%rowtype;
begin
	v_request := public.qorpera_model_login_account_refresh(
		p_broker_authority_id, p_broker_capability_sha256, p_request_id, p_capability_sha256);
	select request.* into strict v_request from public.qorpera_native_account_refresh_requests as request
	where request.id = p_request_id
	for update;
	if v_request.expires_at <= clock_timestamp() or v_request.status not in ('pending', 'completed') then
		raise exception 'model login account refresh has ended' using errcode = '55000';
	end if;
	update public.qorpera_native_account_refresh_requests
	set status = 'completed', completed_at = coalesce(completed_at, clock_timestamp())
	where id = p_request_id;
	return true;
end
$$;

revoke all on function
	public.qorpera_describe_model_login_account_refresh(uuid, text, uuid, text),
	public.qorpera_record_model_login_account_metadata(uuid, text, uuid, text, uuid, uuid, bigint, text, jsonb, text),
	public.qorpera_complete_model_login_account_refresh(uuid, text, uuid, text)
	from public, anon, authenticated, service_role;
grant execute on function
	public.qorpera_describe_model_login_account_refresh(uuid, text, uuid, text),
	public.qorpera_record_model_login_account_metadata(uuid, text, uuid, text, uuid, uuid, bigint, text, jsonb, text),
	public.qorpera_complete_model_login_account_refresh(uuid, text, uuid, text)
	to qorpera_secret_broker;
