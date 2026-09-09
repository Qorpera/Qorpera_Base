-- Explicit new-boot admission on the retained VM/allocation. Physical VM
-- shutdown, the new boot and protected history/configuration are independently
-- verified by the provider before this request. These digests retain that
-- evidence; SQL metadata cannot start a VM or substitute for root inspection.
-- Same-boot successor RPCs retain their existing closed request contract.
create index qorpera_office_activation_boot_history on public.qorpera_runtime_office_activations(allocation_id,(attestation->>'bootId'));

create function public.qorpera_assert_runtime_office_boot_successor_request(p_request jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_key text;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request-array['schema','predecessor','attestation','stopHistorySha256','powerOffCompletionSha256','bootObservationSha256']<>'{}'::jsonb
		or not(p_request ?& array['schema','predecessor','attestation','stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'])
		or p_request->>'schema' is distinct from 'qorpera.office-boot-successor-request/v1'
		or octet_length(p_request::text)>65536 then raise exception 'Invalid office boot successor request' using errcode='22023'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request->'predecessor');
	perform public.qorpera_assert_runtime_office_activation_attestation(p_request->'attestation');
	if p_request#>>'{predecessor,action}' not in ('reboot','power_off')
		or p_request#>'{attestation,activationId}'=p_request#>'{predecessor,activationId}'
		or p_request#>'{attestation,bootId}'=p_request#>'{predecessor,startup,bootId}'
		or p_request#>'{attestation,configurationSha256}'=p_request#>'{predecessor,startup,configurationSha256}' then
		raise exception 'Office boot successor requires a distinct boot and configuration' using errcode='22023'; end if;
	foreach v_key in array array['stopHistorySha256','powerOffCompletionSha256','bootObservationSha256'] loop
		if jsonb_typeof(p_request->v_key) is distinct from 'string' or (p_request->>v_key)!~'^[0-9a-f]{64}$' then
			raise exception 'Invalid office boot successor history' using errcode='22023'; end if;
	end loop;
end $$;

create function public.qorpera_runtime_office_boot_successor_result(p_activation public.qorpera_runtime_office_activations)
returns jsonb language sql volatile set search_path = '' as $$
	select public.qorpera_runtime_office_successor_result(p_activation)||jsonb_build_object('schema','qorpera.office-boot-successor/v1')
$$;

-- Recover the exact request through lost replies and preparation-disable.
-- Superseded candidates cannot regain the current pointer through this RPC.
create function public.qorpera_runtime_office_boot_successor_status(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype; v_successor public.qorpera_runtime_office_successors%rowtype;
begin
	perform public.qorpera_assert_runtime_office_boot_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid for share;
	select * into v_successor from public.qorpera_runtime_office_successors where activation_id=v_activation.activation_id for share;
	if v_successor.activation_id is null or v_successor.request<>p_request or v_activation.superseded_at is not null then
		raise exception 'Office boot successor identity unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_boot_successor_result(v_activation);
end $$;

create function public.qorpera_prepare_runtime_office_boot_successor(p_request jsonb)
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
	foreach v_key in array array['preparationObservationSha256','configurationObservationSha256','configurationSha256','adoptionReceiptSha256'] loop
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

-- Status is historical metadata. Dispatch needs current preparation authority;
-- the provider deducts RPC time from its five-second physical inspection window.
create function public.qorpera_check_runtime_office_boot_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
	v_successor public.qorpera_runtime_office_successors%rowtype;
begin
	perform public.qorpera_assert_runtime_office_boot_successor_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',
		(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_activation from public.qorpera_runtime_office_activations
		where activation_id=(p_request#>>'{attestation,activationId}')::uuid and superseded_at is null for share;
	select * into v_successor from public.qorpera_runtime_office_successors
		where activation_id=v_activation.activation_id for share;
	if v_activation.activation_id is null or v_successor.activation_id is null or v_successor.request<>p_request then
		raise exception 'Office boot successor identity unavailable' using errcode='42501'; end if;
	if v_activation.state='active' then
		perform public.qorpera_check_runtime_office_guest_binding(p_request#>'{predecessor,startup,scope}',
			v_activation.computer_generation,v_activation.allocation_id,v_activation.instance_sha256,
			v_activation.image_sha256,v_activation.bootstrap_sha256);
	else
		perform public.qorpera_check_runtime_office_successor_startup(v_activation);
	end if;
	return public.qorpera_runtime_office_boot_successor_result(v_activation);
end $$;

create function public.qorpera_activate_runtime_office_boot_successor(p_request jsonb,p_service_invocation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_runtime_office_boot_successor_status(p_request);
	select * into strict v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid;
	perform public.qorpera_activate_runtime_office(p_request#>'{predecessor,startup,scope}',v_activation.computer_generation,v_activation.intent_id,
		v_activation.activation_id,v_activation.provider_id,v_activation.provider_policy_sha256,p_service_invocation_id);
	return public.qorpera_runtime_office_boot_successor_status(p_request);
end $$;

revoke all on function public.qorpera_assert_runtime_office_boot_successor_request(jsonb),
	public.qorpera_runtime_office_boot_successor_result(public.qorpera_runtime_office_activations),
	public.qorpera_prepare_runtime_office_boot_successor(jsonb),public.qorpera_runtime_office_boot_successor_status(jsonb),
	public.qorpera_check_runtime_office_boot_successor(jsonb),public.qorpera_activate_runtime_office_boot_successor(jsonb,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_prepare_runtime_office_boot_successor(jsonb),public.qorpera_runtime_office_boot_successor_status(jsonb),
	public.qorpera_check_runtime_office_boot_successor(jsonb),public.qorpera_activate_runtime_office_boot_successor(jsonb,text) to service_role;
