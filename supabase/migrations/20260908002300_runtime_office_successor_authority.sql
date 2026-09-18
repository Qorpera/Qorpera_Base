-- Metadata recovery is intentionally available while preparation is disabled.
-- Physical successor dispatch needs a separate current-state check. The caller
-- deducts RPC latency from the five-second window and retains the same request.
create function public.qorpera_check_runtime_office_successor(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
	v_successor public.qorpera_runtime_office_successors%rowtype;
begin
	perform public.qorpera_assert_runtime_office_successor_request(p_request);
	-- Common lock order: profile fence, office, provider, activation, successor.
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{predecessor,startup,scope}',
		(p_request#>>'{predecessor,startup,computerGeneration}')::bigint,
		(p_request#>>'{predecessor,providerId}')::uuid,p_request#>>'{predecessor,providerPolicySha256}',false);
	select * into v_activation from public.qorpera_runtime_office_activations
		where activation_id=(p_request#>>'{attestation,activationId}')::uuid and superseded_at is null for share;
	select * into v_successor from public.qorpera_runtime_office_successors
		where activation_id=v_activation.activation_id for share;
	if v_activation.activation_id is null or v_successor.activation_id is null or v_successor.request<>p_request then
		raise exception 'Office successor identity unavailable' using errcode='42501'; end if;
	if v_activation.state='active' then
		-- An already active invocation may be inspected after preparation-disable.
		-- This branch never grants permission to dispatch a new start.
		perform public.qorpera_check_runtime_office_guest_binding(p_request#>'{predecessor,startup,scope}',
			v_activation.computer_generation,v_activation.allocation_id,v_activation.instance_sha256,
			v_activation.image_sha256,v_activation.bootstrap_sha256);
	else
		perform public.qorpera_check_runtime_office_successor_startup(v_activation);
	end if;
	return public.qorpera_runtime_office_successor_result(v_activation);
end $$;
revoke all on function public.qorpera_check_runtime_office_successor(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_check_runtime_office_successor(jsonb) to service_role;
