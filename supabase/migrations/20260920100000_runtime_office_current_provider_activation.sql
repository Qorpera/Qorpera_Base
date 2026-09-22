-- Superseded activations remain active history. Lifecycle discovery must return
-- only the current activation, including its current boot and service identity.
create or replace function public.qorpera_runtime_office_provider_activation(p_scope jsonb,p_computer_generation bigint,
	p_provider_id uuid,p_provider_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_provider public.qorpera_runtime_office_providers%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	v_provider:=public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_provider.office_id;
	select * into v_activation from public.qorpera_runtime_office_activations where office_id=v_office.id
		and computer_generation=v_office.generation and provider_id=v_provider.provider_id and state='active' and superseded_at is null for share;
	if not found then return jsonb_build_object('schema','qorpera.office-provider-activation/v1','officeState',v_office.state,'activation',null); end if;
	return jsonb_build_object('schema','qorpera.office-provider-activation/v1','officeState',v_office.state,
		'activation',jsonb_build_object('activationId',v_activation.activation_id,'providerId',v_activation.provider_id,
			'providerPolicySha256',v_activation.provider_policy_sha256,
			'startup',jsonb_build_object('scope',public.qorpera_runtime_office_scope(v_office),'computerGeneration',v_office.generation,
				'allocationId',v_activation.allocation_id,'instanceSha256',v_activation.instance_sha256,
				'imageSha256',v_activation.image_sha256,'bootstrapSha256',v_activation.bootstrap_sha256,
				'bootId',v_activation.attestation->>'bootId','configurationSha256',v_activation.attestation->>'configurationSha256',
				'serviceInvocationId',v_activation.service_invocation_id)));
end
$$;
