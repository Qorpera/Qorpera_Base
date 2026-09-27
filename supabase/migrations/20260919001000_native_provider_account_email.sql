-- Provider account email is display-only metadata. Existing opaque references
-- remain unchanged; old connections gain an email when they sign in again.
alter table public.qorpera_provider_connection_versions
add column provider_account_email text check (
    provider_account_email is null or (
        char_length(provider_account_email) between 3 and 254
        and provider_account_email = btrim(provider_account_email)
        and provider_account_email ~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+\.[^[:space:]@[:cntrl:]]+$'
    )
);

drop function public.qorpera_complete_native_provider_login(uuid, text, uuid, text, text, text, text, text, jsonb);

create function public.qorpera_complete_native_provider_login(
	p_login_id uuid,
	p_capability_sha256 text,
	p_capsule_id uuid,
	p_encrypted_capsule_reference text,
	p_attestation_policy_sha256 text,
	p_provider_account_reference text,
	p_billing_source text,
	p_consent_version text,
	p_quota_policy jsonb,
	p_provider_account_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_login public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_version bigint;
begin
	if auth.role() <> 'service_role' or p_capsule_id is null
		or p_capability_sha256 !~ '^[0-9a-f]{64}$'
		or p_attestation_policy_sha256 !~ '^[0-9a-f]{64}$'
		or char_length(btrim(coalesce(p_encrypted_capsule_reference, ''))) not between 1 and 512
		or char_length(btrim(coalesce(p_billing_source, ''))) not between 1 and 120
		or char_length(btrim(coalesce(p_consent_version, ''))) not between 1 and 120
		or not public.qorpera_provider_quota_policy_valid(p_quota_policy) then
		raise exception 'native provider login completion is invalid' using errcode = '22023';
	end if;
	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.id = p_login_id
	for update;
	if not found or v_login.capability_sha256 <> p_capability_sha256
		or v_login.status <> 'pending' or v_login.expires_at <= statement_timestamp() then
		raise exception 'native provider login is unavailable' using errcode = '55000';
	end if;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_login.compute_identity_id and identity.profile_id = v_login.profile_id
		and identity.status = 'active';
	select policy.* into v_policy
	from public.qorpera_provider_execution_policies as policy
	where policy.provider = v_login.provider
		and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = v_login.native_harness
		and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled'
	for share;
	if not found or (p_quota_policy ->> 'max_concurrent_runs')::integer > v_policy.max_native_concurrency then
		raise exception 'native provider policy does not authorize this connection' using errcode = '42501';
	end if;
	insert into public.qorpera_native_credential_capsules (
		id, profile_id, compute_identity_id, ownership_kind, owner_user_id, owner_scope_key,
		provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id
	) values (
		p_capsule_id, v_login.profile_id, v_login.compute_identity_id,
		v_identity.ownership_kind, v_identity.owner_user_id, v_identity.owner_scope_key, v_login.provider,
		v_login.native_harness, btrim(p_encrypted_capsule_reference), p_attestation_policy_sha256,
		v_login.requested_by_user_id
	) returning * into v_capsule;
	insert into public.qorpera_provider_connections (
		profile_id, client_connection_id, owner_user_id, provider, created_by_user_id
	) values (
		v_login.profile_id, v_login.client_connection_id, v_identity.owner_user_id,
		v_login.provider, v_login.requested_by_user_id
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
		or v_connection.provider <> v_login.provider then
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
		v_connection.id, v_version, 'native_subscription', v_login.native_harness, null,
		nullif(btrim(p_provider_account_reference), ''), nullif(btrim(p_provider_account_email), ''), btrim(p_billing_source), btrim(p_consent_version),
		v_login.requested_by_user_id, false, v_policy.commercial_reference, p_quota_policy,
		v_login.requested_by_user_id, v_capsule.id, 'active', v_policy.max_native_concurrency
	);
	update public.qorpera_native_provider_login_sessions
	set status = 'completed', completed_at = statement_timestamp()
	where id = v_login.id;
	return jsonb_build_object(
		'connection_id', v_connection.id,
		'version', v_version,
		'compute_identity_id', v_login.compute_identity_id,
		'ownership_kind', v_identity.ownership_kind,
		'owner_user_id', v_identity.owner_user_id,
		'owner_scope_key', v_identity.owner_scope_key,
		'credential_capsule_id', v_capsule.id,
		'provider', v_login.provider,
		'native_harness', v_login.native_harness,
		'authorization_state', 'active'
	);
end
$$;

create or replace function public.qorpera_list_member_native_execution_connections(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'native execution connections are unavailable' using errcode = '42501';
	end if;
	select identity.* into v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
		and identity.owner_user_id = v_user_id;
	return jsonb_build_object(
		'compute_identity', case when v_identity.id is null then null else jsonb_build_object(
			'compute_identity_id', v_identity.id,
			'ownership_kind', v_identity.ownership_kind,
			'owner_user_id', v_identity.owner_user_id,
			'owner_scope_key', v_identity.owner_scope_key,
			'display_name', v_identity.display_name,
			'template_key', v_identity.template_key,
			'template_version', v_identity.template_version,
			'capabilities', v_identity.capabilities,
			'policy', v_identity.policy,
			'status', v_identity.status,
			'created_at', v_identity.created_at,
			'updated_at', v_identity.updated_at
		) end,
		'connections', coalesce((
			select jsonb_agg(jsonb_build_object(
				'connection_id', connection.id,
				'connection_version', version.version,
				'provider', connection.provider,
				'native_harness', version.native_harness,
				'authorization_state', version.authorization_state,
				'max_native_concurrency', version.max_native_concurrency,
				'provider_account_reference', version.provider_account_reference,
				'provider_account_email', version.provider_account_email,
				'billing_source', version.billing_source,
				'consent_version', version.consent_version,
				'consented_at', version.consented_at,
				'connection_status', connection.status,
				'sponsor_binding_id', sponsor.binding_id,
				'sponsor_version', sponsor.version,
				'policy', jsonb_build_object(
					'implementation_status', policy.implementation_status,
					'enablement_status', policy.enablement_status,
					'policy_version', policy.policy_version,
					'disabled_reason', policy.disabled_reason
				)
			) order by connection.provider, version.created_at desc)
			from public.qorpera_provider_connections as connection
			join public.qorpera_provider_connection_versions as version
				on version.connection_id = connection.id
				and version.authentication_mode = 'native_subscription'
			join public.qorpera_native_credential_capsules as capsule
				on capsule.id = version.credential_capsule_id
			join public.qorpera_provider_execution_policies as policy
				on policy.provider = connection.provider
				and policy.authentication_mode = version.authentication_mode
				and policy.native_harness = version.native_harness
			left join lateral (
				select sponsor_version.binding_id, sponsor_version.version
				from public.qorpera_execution_sponsor_versions as sponsor_version
				join public.qorpera_execution_sponsor_bindings as binding
					on binding.id = sponsor_version.binding_id and binding.status = 'active'
				where sponsor_version.provider_connection_id = connection.id
					and sponsor_version.provider_connection_version = version.version
					and sponsor_version.sponsor_kind = 'member_connection'
				order by sponsor_version.created_at desc, sponsor_version.version desc
				limit 1
			) as sponsor on true
			where connection.profile_id = p_profile_id
				and connection.owner_user_id = v_user_id
				and capsule.compute_identity_id = v_identity.id
		), '[]'::jsonb)
	);
end
$$;

revoke all on function public.qorpera_complete_native_provider_login(uuid, text, uuid, text, text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.qorpera_complete_native_provider_login(uuid, text, uuid, text, text, text, text, text, jsonb, text) to service_role;
