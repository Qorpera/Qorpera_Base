-- Keep the sign-in correlation distinct from the server-owned connection ID.
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
				'client_connection_id', connection.client_connection_id,
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
