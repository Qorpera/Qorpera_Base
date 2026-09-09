-- Resume keeps the original prepared workbench and immutable preparation identity.
-- Only the boot/configuration/receipt observations advance. The previous admission
-- check demanded a new preparation digest, rejecting the concrete retained-boot
-- worker and implying a preparation that must never run on a retained workbench.
-- Keep prior migrations/records intact and require exact preparation continuity.

create or replace function public.qorpera_prepare_runtime_office_boot_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_old public.qorpera_runtime_office_activations%rowtype; v_next public.qorpera_runtime_office_activations%rowtype;
	v_existing public.qorpera_runtime_office_successors%rowtype; v_office public.qorpera_runtime_offices%rowtype; v_key text;
begin
	perform public.qorpera_assert_runtime_office_boot_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_existing from public.qorpera_runtime_office_successors where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid;
	if found then
		if v_existing.request<>p_request then raise exception 'Office boot successor cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_boot_successor_status(p_request);
	end if;
	perform public.qorpera_check_runtime_office_boot_handoff(p_request);
	-- Common profile -> office -> provider -> activation lock order also
	-- serializes boot-history checks with service successors and founder pause.
	v_transition:=public.qorpera_lock_runtime_office_stop(p_request->'predecessor');
	select * into strict v_old from public.qorpera_runtime_office_activations where activation_id=v_transition.activation_id;
	perform 1 from public.qorpera_runtime_office_stops where transition_id=v_transition.id for share;
	if not found then raise exception 'Office predecessor stop unacknowledged' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=v_old.allocation_id
		and attestation->>'bootId'=p_request#>>'{attestation,bootId}') then
		raise exception 'Office boot identity cannot be reused' using errcode='42501'; end if;
	foreach v_key in array array['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'] loop
		if exists(select 1 from public.qorpera_runtime_office_successors s
			join public.qorpera_runtime_office_activations a using(activation_id)
			where a.allocation_id=v_old.allocation_id and s.request->v_key=p_request->v_key) then
			raise exception 'Office boot evidence cannot be reused' using errcode='42501'; end if;
	end loop;
	if p_request#>'{attestation,nativePort}' is distinct from v_old.attestation->'nativePort'
		or p_request#>'{attestation,viewerPort}' is distinct from v_old.attestation->'viewerPort' then
		raise exception 'Office boot listener binding changed' using errcode='42501'; end if;
	if p_request#>'{attestation,preparationObservationSha256}' is distinct from v_old.attestation->'preparationObservationSha256' then
		raise exception 'Office boot preparation identity changed' using errcode='42501'; end if;
	foreach v_key in array array['configurationObservationSha256','configurationSha256','adoptionReceiptSha256'] loop
		if p_request->'attestation'->v_key=v_old.attestation->v_key then
			raise exception 'Office boot requires fresh protected observations' using errcode='42501'; end if;
	end loop;
	perform public.qorpera_check_runtime_office_restart_surfaces(v_old);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_old.office_id;
	update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=v_old.activation_id;
	insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,provider_id,
		provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,state,predecessor_activation_id)
	values(v_old.intent_id,(p_request#>>'{attestation,activationId}')::uuid,v_old.office_id,v_old.computer_generation,v_old.allocation_id,v_old.provider_id,
		v_old.provider_policy_sha256,v_old.provider_binding_sha256,v_old.instance_sha256,v_old.image_sha256,v_old.bootstrap_sha256,p_request->'attestation',v_old.mappings,'prepared',v_old.activation_id)
	returning * into v_next;
	insert into public.qorpera_runtime_office_successors(activation_id,transition_id,request,office_revision,privacy_state,privacy_version,privacy_challenge)
	values(v_next.activation_id,v_transition.id,p_request,v_office.revision,v_office.privacy_state,v_office.privacy_version,v_office.privacy_challenge);
	perform public.qorpera_check_runtime_office_successor_startup(v_next);
	return public.qorpera_runtime_office_boot_successor_result(v_next);
end $$;

