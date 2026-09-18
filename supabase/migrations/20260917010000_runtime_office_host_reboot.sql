-- 2026-09-17 amendment: host reboot as a Company Computer lifecycle event.
-- A node guard opens an ordinary `reboot` transition before the host goes down
-- and records it here as a host reboot; the provider records the resumed host
-- boot after the host is back; the boot-successor activation closes the row.
-- Members and providers see `maintenance: {reason: "host_reboot", ...}` next to
-- the office state, and an agent that needs the office during maintenance parks
-- a start intent exactly as during provisioning (the waiter survives; the
-- activation wake re-runs the agent when the successor activation is active).

create table public.qorpera_runtime_office_host_reboots (
	transition_id uuid primary key,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null,
	allocation_id uuid not null,
	activation_id uuid not null references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	shutdown_host_boot_id uuid not null,
	resumed_host_boot_id uuid,
	successor_activation_id uuid references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	requested_at timestamptz not null default clock_timestamp(),
	resumed_at timestamptz,
	activated_at timestamptz,
	check((resumed_host_boot_id is null) = (resumed_at is null)),
	check((successor_activation_id is null) = (activated_at is null)),
	check(successor_activation_id is null or resumed_at is not null)
);
create index qorpera_runtime_office_host_reboots_office_idx on public.qorpera_runtime_office_host_reboots(office_id,computer_generation,requested_at desc);
alter table public.qorpera_runtime_office_host_reboots enable row level security;
revoke all on public.qorpera_runtime_office_host_reboots from public,anon,authenticated,service_role;

-- The current active activation as the startup identity a lifecycle request
-- must carry. Provider-scoped; the guard uses it to author the transition.
create function public.qorpera_runtime_office_provider_activation(p_scope jsonb,p_computer_generation bigint,
	p_provider_id uuid,p_provider_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_provider public.qorpera_runtime_office_providers%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	v_provider:=public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_provider.office_id;
	select * into v_activation from public.qorpera_runtime_office_activations where office_id=v_office.id
		and computer_generation=v_office.generation and provider_id=v_provider.provider_id and state='active' for share;
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

-- Opened by the node guard before the host goes down, for the exact request
-- it then retains as the provider's recovery plan. The transition itself is
-- begun by the provider (qorpera_begin_runtime_office_lifecycle) when it picks
-- the plan up; this row only names the cause. Idempotent for the same request.
create function public.qorpera_begin_runtime_office_host_reboot(p_request jsonb,p_host_boot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_start jsonb:=p_request->'startup'; v_office public.qorpera_runtime_offices%rowtype;
	v_activation public.qorpera_runtime_office_activations%rowtype; v_row public.qorpera_runtime_office_host_reboots%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	if p_request->>'action'<>'reboot' or p_host_boot_id is null then
		raise exception 'Host reboot requires a reboot transition' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_provider(v_start->'scope',(v_start->>'computerGeneration')::bigint,
		(p_request->>'providerId')::uuid,p_request->>'providerPolicySha256',false);
	select * into strict v_office from public.qorpera_runtime_offices where id=(v_start#>>'{scope,companyComputerId}')::uuid for share;
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request->>'activationId')::uuid for share;
	if not found or v_activation.state<>'active' or v_activation.office_id<>v_office.id or v_activation.computer_generation<>v_office.generation
		or v_activation.allocation_id::text is distinct from v_start->>'allocationId'
		or v_activation.attestation->>'bootId' is distinct from v_start->>'bootId'
		or v_activation.service_invocation_id is distinct from v_start->>'serviceInvocationId' then
		raise exception 'Host reboot activation differs' using errcode='42501'; end if;
	select * into v_row from public.qorpera_runtime_office_host_reboots where transition_id=(p_request->>'transitionId')::uuid for update;
	if found then
		if v_row.activation_id<>v_activation.activation_id or v_row.shutdown_host_boot_id<>p_host_boot_id then
			raise exception 'Host reboot cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_host_reboot_result(v_row);
	end if;
	if v_office.state<>'active' then raise exception 'Host reboot requires an active office' using errcode='42501'; end if;
	if exists(select 1 from public.qorpera_runtime_office_host_reboots where office_id=v_office.id
		and computer_generation=v_office.generation and activated_at is null) then
		raise exception 'Host reboot already pending' using errcode='42501'; end if;
	insert into public.qorpera_runtime_office_host_reboots(transition_id,office_id,computer_generation,allocation_id,activation_id,shutdown_host_boot_id)
	values((p_request->>'transitionId')::uuid,v_office.id,v_office.generation,v_activation.allocation_id,v_activation.activation_id,p_host_boot_id)
	returning * into v_row;
	return public.qorpera_runtime_office_host_reboot_result(v_row);
end
$$;

create function public.qorpera_runtime_office_host_reboot_result(p_row public.qorpera_runtime_office_host_reboots)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-host-reboot/v1','transitionId',p_row.transition_id,'activationId',p_row.activation_id,
		'allocationId',p_row.allocation_id,'shutdownHostBootId',p_row.shutdown_host_boot_id,'resumedHostBootId',p_row.resumed_host_boot_id,
		'successorActivationId',p_row.successor_activation_id,'requestedAt',p_row.requested_at,'resumedAt',p_row.resumed_at,'activatedAt',p_row.activated_at,
		'state',case when p_row.activated_at is not null then 'activated' when p_row.resumed_at is not null then 'resumed' else 'requested' end)
$$;

-- Recorded by the provider after the host is back, once it has verified the
-- stopped guest and published its host reboot receipt, before the resume.
create function public.qorpera_record_runtime_office_host_reboot_resume(p_request jsonb,p_resumed_host_boot_id uuid)
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
	if p_resumed_host_boot_id=v_row.shutdown_host_boot_id then raise exception 'Host reboot resume host differs' using errcode='42501'; end if;
	update public.qorpera_runtime_office_host_reboots set resumed_host_boot_id=p_resumed_host_boot_id,resumed_at=clock_timestamp()
		where transition_id=v_row.transition_id returning * into v_row;
	return public.qorpera_runtime_office_host_reboot_result(v_row);
end
$$;

-- The boot-successor activation closes the host reboot it belongs to.
create or replace function public.qorpera_activate_runtime_office_boot_successor(p_request jsonb,p_service_invocation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_runtime_office_boot_successor_status(p_request);
	select * into strict v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request#>>'{attestation,activationId}')::uuid;
	perform public.qorpera_activate_runtime_office(p_request#>'{predecessor,startup,scope}',v_activation.computer_generation,v_activation.intent_id,
		v_activation.activation_id,v_activation.provider_id,v_activation.provider_policy_sha256,p_service_invocation_id);
	update public.qorpera_runtime_office_host_reboots set successor_activation_id=v_activation.activation_id,activated_at=clock_timestamp()
		where transition_id=(p_request#>>'{predecessor,transitionId}')::uuid and activated_at is null and resumed_at is not null;
	return public.qorpera_runtime_office_boot_successor_status(p_request);
end $$;

-- Member/provider-visible maintenance cause: the pending host reboot of the
-- current generation, or null. Read-only helper for the status views.
create function public.qorpera_runtime_office_maintenance(p_office public.qorpera_runtime_offices)
returns jsonb language sql stable set search_path = '' as $$
	select case when r.transition_id is null then null else jsonb_build_object('reason','host_reboot','transitionId',r.transition_id,
		'requestedAt',r.requested_at,'resumedAt',r.resumed_at,'activatedAt',r.activated_at,
		'state',case when r.activated_at is not null then 'activated' when r.resumed_at is not null then 'resumed' else 'requested' end) end
	from (select * from public.qorpera_runtime_office_host_reboots h where h.office_id=p_office.id and h.computer_generation=p_office.generation
		and (h.activated_at is null or p_office.state='maintenance') order by h.requested_at desc limit 1) r
$$;

create or replace function public.qorpera_runtime_office_start_status(p_scope jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_intent public.qorpera_runtime_office_start_intents%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Office start status requires membership' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=v_office.id for share;
	if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid() for share;
	if not found then raise exception 'Office start status requires membership' using errcode='42501'; end if;
	select * into v_intent from public.qorpera_runtime_office_start_intents
		where office_id=v_office.id and computer_generation=v_office.generation for share;
	return jsonb_build_object('scope',public.qorpera_runtime_office_scope(v_office),'computerGeneration',v_office.generation,
		'officeState',v_office.state,'intent',case when v_intent.id is not null then public.qorpera_runtime_office_start_result(v_intent) else null end,
		'maintenance',public.qorpera_runtime_office_maintenance(v_office));
end
$$;

create or replace function public.qorpera_runtime_office_member_status(p_scope jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_screens jsonb; v_viewers jsonb;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Office member required' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid for share;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()) then
		raise exception 'Office member unavailable' using errcode='42501'; end if;
	select coalesce(jsonb_agg(jsonb_build_object('binding',p_scope||jsonb_build_object('computerGeneration',v_office.generation,
		'screenId',s.id,'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id),
		'epoch',s.epoch,'drainPending',s.drain_pending,'takeoverMemberId',s.takeover_user_id,
		'driver',case when s.drain_pending then 'draining' when s.takeover_user_id is not null then 'member'
			when s.lease_id is not null then 'agent' else 'idle' end) order by s.ordinal),'[]'::jsonb)
	into v_screens from public.qorpera_runtime_office_screens s where s.office_id=v_office.id;
	select coalesce(jsonb_agg(jsonb_build_object('viewerSessionId',v.id,'screenId',v.screen_id,'mode',v.mode,'state',v.state)
		order by v.issued_at,v.id),'[]'::jsonb) into v_viewers from public.qorpera_runtime_office_viewers v
		where v.office_id=v_office.id and v.member_id=auth.uid() and v.state<>'ended'
		and (v.mode='control' or v.expires_at>clock_timestamp());
	return jsonb_build_object('scope',p_scope,'computerGeneration',v_office.generation,'state',v_office.state,
		'privacyState',v_office.privacy_state,'privacyVersion',v_office.privacy_version,'screens',v_screens,'viewers',v_viewers,
		'maintenance',public.qorpera_runtime_office_maintenance(v_office));
end
$$;

-- During a host reboot an agent's start request parks a waiter, as during
-- provisioning. Maintenance for any other cause keeps the old answer.
create or replace function public.qorpera_native_office_start_descriptor(p_binding jsonb,p_allow_active boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Native office authority required' using errcode='42501'; end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	if v_authority#>>'{identity,audienceKind}' is distinct from 'company' then
		raise exception 'Shared office start requires company audience' using errcode='42501'; end if;
	select * into v_office from public.qorpera_runtime_offices o
		where o.environment_id=(v_authority#>>'{identity,environmentId}')::uuid
		and o.profile_id=(v_authority#>>'{identity,companyId}')::uuid
		and (o.state in ('provisioning','recovering') or (p_allow_active is true and o.state='active')
			or (o.state='maintenance' and public.qorpera_runtime_office_maintenance(o) is not null)) for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	if public.qorpera_company_execution_paused(v_office.profile_id)
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
			and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=v_office.logical_computer_id
			and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
		return '{"state":"unavailable"}'::jsonb; end if;
	select * into v_access from public.qorpera_runtime_office_access where office_id=v_office.id
		and staff_agent_id=(v_authority#>>'{identity,staffAgentId}')::uuid and profile_id=v_office.profile_id and state='active' for share;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	if exists(select 1 from public.qorpera_runtime_office_start_intents where office_id=v_office.id
		and computer_generation=v_office.generation and state='cancelled') then return '{"state":"unavailable"}'::jsonb; end if;
	if v_office.state='active' and not exists(select 1 from public.qorpera_runtime_office_start_intents intent
		join public.qorpera_runtime_machine_allocations allocation on allocation.id=intent.allocation_id
		where intent.office_id=v_office.id and intent.computer_generation=v_office.generation and intent.state='reserved'
		and intent.image_sha256=v_office.image_sha256 and intent.bootstrap_sha256=v_office.bootstrap_sha256
		and allocation.office_id=v_office.id and allocation.computer_generation=v_office.generation
		and allocation.instance_sha256=intent.instance_sha256 and allocation.released_at is null) then
		return '{"state":"unavailable"}'::jsonb; end if;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('state','available','scope',public.qorpera_runtime_office_scope(v_office),
		'computerGeneration',v_office.generation,'resources',jsonb_build_object('officeGrantId',v_access.grant_id,'officeGrantVersion',v_access.version));
end
$$;

revoke all on function public.qorpera_runtime_office_provider_activation(jsonb,bigint,uuid,text),
	public.qorpera_begin_runtime_office_host_reboot(jsonb,uuid),public.qorpera_runtime_office_host_reboot_result(public.qorpera_runtime_office_host_reboots),
	public.qorpera_record_runtime_office_host_reboot_resume(jsonb,uuid),public.qorpera_runtime_office_maintenance(public.qorpera_runtime_offices),
	public.qorpera_activate_runtime_office_boot_successor(jsonb,text),public.qorpera_runtime_office_start_status(jsonb),
	public.qorpera_runtime_office_member_status(jsonb),public.qorpera_native_office_start_descriptor(jsonb,boolean)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_office_provider_activation(jsonb,bigint,uuid,text),
	public.qorpera_begin_runtime_office_host_reboot(jsonb,uuid),public.qorpera_record_runtime_office_host_reboot_resume(jsonb,uuid),
	public.qorpera_activate_runtime_office_boot_successor(jsonb,text),public.qorpera_native_office_start_descriptor(jsonb,boolean) to service_role;
grant execute on function public.qorpera_runtime_office_start_status(jsonb),public.qorpera_runtime_office_member_status(jsonb) to authenticated;
