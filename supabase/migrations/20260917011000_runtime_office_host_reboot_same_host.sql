-- Host reboot follow-up (17 Sep 2026): a guard-opened host reboot whose host
-- did not change (the reboot was cancelled, or the node came back on the same
-- boot) still resolves. The provider records the resume with the unchanged host
-- boot, and the boot-successor activation closes the row either way.

create or replace function public.qorpera_record_runtime_office_host_reboot_resume(p_request jsonb,p_resumed_host_boot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_runtime_office_host_reboots%rowtype; v_office public.qorpera_runtime_offices%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{startup,scope}',(p_request#>>'{startup,computerGeneration}')::bigint,
		(p_request->>'providerId')::uuid,p_request->>'providerPolicySha256',false);
	select * into v_row from public.qorpera_runtime_office_host_reboots where transition_id=(p_request->>'transitionId')::uuid for update;
	if not found or v_row.activation_id::text<>p_request->>'activationId' or p_resumed_host_boot_id is null then
		raise exception 'Host reboot transition differs' using errcode='42501'; end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=v_row.office_id;
	if v_office.state<>'maintenance' or v_office.generation<>v_row.computer_generation
		or not exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions t where t.id=v_row.transition_id) then
		raise exception 'Host reboot resume requires the draining transition' using errcode='42501'; end if;
	if v_row.resumed_host_boot_id is not null then
		if v_row.resumed_host_boot_id<>p_resumed_host_boot_id then raise exception 'Host reboot cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_host_reboot_result(v_row);
	end if;
	update public.qorpera_runtime_office_host_reboots set resumed_host_boot_id=p_resumed_host_boot_id,resumed_at=clock_timestamp()
		where transition_id=v_row.transition_id returning * into v_row;
	return public.qorpera_runtime_office_host_reboot_result(v_row);
end
$$;

create or replace function public.qorpera_activate_runtime_office_boot_successor(p_request jsonb,p_service_invocation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_runtime_office_boot_successor_status(p_request);
	select * into strict v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid;
	perform public.qorpera_activate_runtime_office(p_request#>'{predecessor,startup,scope}',v_activation.computer_generation,v_activation.intent_id,
		v_activation.activation_id,v_activation.provider_id,v_activation.provider_policy_sha256,p_service_invocation_id);
	-- A row still unresolved here (no resume recorded) resumed on the shutdown host boot.
	update public.qorpera_runtime_office_host_reboots set resumed_host_boot_id=coalesce(resumed_host_boot_id,shutdown_host_boot_id),
		resumed_at=coalesce(resumed_at,clock_timestamp()),successor_activation_id=v_activation.activation_id,activated_at=clock_timestamp()
		where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid and activated_at is null;
	return public.qorpera_runtime_office_boot_successor_status(p_request);
end $$;

revoke all on function public.qorpera_record_runtime_office_host_reboot_resume(jsonb,uuid),
	public.qorpera_activate_runtime_office_boot_successor(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_record_runtime_office_host_reboot_resume(jsonb,uuid),
	public.qorpera_activate_runtime_office_boot_successor(jsonb,text) to service_role;
