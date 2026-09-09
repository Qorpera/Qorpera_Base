-- Startup is a provider/guest handshake. Configuration is not activation:
-- the guest must report the exact running service invocation with both
-- listeners bound and work admission closed, then the provider must measure
-- that same invocation/boot before activating. No timeout reassigns ownership.
create table public.qorpera_runtime_office_activations (
	intent_id uuid primary key references public.qorpera_runtime_office_start_intents(id) on delete restrict,
	activation_id uuid not null unique,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null check(computer_generation between 1 and 9007199254740991),
	allocation_id uuid not null unique references public.qorpera_runtime_machine_allocations(id) on delete restrict,
	provider_id uuid not null,
	provider_policy_sha256 text not null check(provider_policy_sha256 ~ '^[0-9a-f]{64}$'),
	provider_binding_sha256 text not null check(provider_binding_sha256 ~ '^[0-9a-f]{64}$'),
	instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$'),
	image_sha256 text not null check(image_sha256 ~ '^[0-9a-f]{64}$'),
	bootstrap_sha256 text not null check(bootstrap_sha256 ~ '^[0-9a-f]{64}$'),
	attestation jsonb not null,
	mappings jsonb not null,
	state text not null check(state in ('prepared','ready','active')),
	service_invocation_id text check(service_invocation_id ~ '^[0-9a-f]{32}$' and service_invocation_id<>repeat('0',32)),
	ready_at timestamptz,
	activated_at timestamptz,
	unique(office_id,computer_generation),
	check((state='prepared' and service_invocation_id is null and ready_at is null and activated_at is null)
		or (state='ready' and service_invocation_id is not null and ready_at is not null and activated_at is null)
		or (state='active' and service_invocation_id is not null and ready_at is not null and activated_at is not null))
);

create function public.qorpera_assert_runtime_office_activation_attestation(p_value jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_key text; v_keys text[]:=array['schema','activationId','bootId','preparationObservationSha256',
	'configurationObservationSha256','configurationSha256','adoptionReceiptSha256','nativePort','viewerPort'];
begin
	if jsonb_typeof(p_value) is distinct from 'object' or p_value-v_keys<>'{}'::jsonb
		or not (p_value ?& v_keys) or p_value->>'schema' is distinct from 'qorpera.office-activation-attestation/v1' then
		raise exception 'Invalid office activation attestation' using errcode='22023'; end if;
	foreach v_key in array array['activationId','bootId'] loop
		if jsonb_typeof(p_value->v_key) is distinct from 'string'
			or p_value->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office activation identity' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['preparationObservationSha256','configurationObservationSha256','configurationSha256','adoptionReceiptSha256'] loop
		if jsonb_typeof(p_value->v_key) is distinct from 'string' or p_value->>v_key !~ '^[0-9a-f]{64}$' then
			raise exception 'Invalid office activation digest' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['nativePort','viewerPort'] loop
		if jsonb_typeof(p_value->v_key) is distinct from 'number' or p_value->>v_key !~ '^[1-9][0-9]{0,4}$'
			or (p_value->>v_key)::integer>65535 then
			raise exception 'Invalid office activation listener' using errcode='22023'; end if;
	end loop;
	if p_value->'nativePort'=p_value->'viewerPort' then raise exception 'Office activation listeners overlap' using errcode='22023'; end if;
end
$$;

create function public.qorpera_runtime_office_activation_result(p_value public.qorpera_runtime_office_activations)
returns jsonb language sql volatile set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-activation/v1','intentId',p_value.intent_id,
		'companyComputerId',p_value.office_id,'computerGeneration',p_value.computer_generation,
		'allocationId',p_value.allocation_id,'attestation',p_value.attestation,'state',p_value.state,
		'serviceInvocationId',p_value.service_invocation_id,
		'readinessFresh',p_value.ready_at is not null and p_value.ready_at>clock_timestamp()-interval '5 seconds')
$$;

create function public.qorpera_prepare_runtime_office_activation(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_allocation_id uuid,p_instance_sha256 text,p_provider_binding_sha256 text,p_provider_id uuid,p_provider_policy_sha256 text,
	p_mappings jsonb,p_attestation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.qorpera_runtime_office_start_intents%rowtype; v_existing public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_assert_runtime_office_activation_attestation(p_attestation);
	-- Acquires profile, office and provider locks before intent/allocation and
	-- verifies current request/grant authority and fully drained adopted surfaces.
	perform public.qorpera_check_runtime_office_adoption(p_scope,p_computer_generation,p_intent_id,p_allocation_id,
		p_instance_sha256,p_provider_binding_sha256,p_provider_id,p_provider_policy_sha256,p_mappings);
	select * into strict v_intent from public.qorpera_runtime_office_start_intents where id=p_intent_id;
	select * into v_existing from public.qorpera_runtime_office_activations where intent_id=p_intent_id for update;
	if found then
		if v_existing.activation_id<>(p_attestation->>'activationId')::uuid or v_existing.attestation<>p_attestation
			or v_existing.mappings<>p_mappings or v_existing.provider_id<>p_provider_id
			or v_existing.provider_policy_sha256<>p_provider_policy_sha256
			or v_existing.allocation_id<>p_allocation_id or v_existing.instance_sha256<>p_instance_sha256
			or v_existing.provider_binding_sha256<>p_provider_binding_sha256 then
			raise exception 'Office activation cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_activation_result(v_existing);
	end if;
	insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,
		provider_id,provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,state)
	values(p_intent_id,(p_attestation->>'activationId')::uuid,v_intent.office_id,p_computer_generation,p_allocation_id,
		p_provider_id,p_provider_policy_sha256,p_provider_binding_sha256,p_instance_sha256,v_intent.image_sha256,
		v_intent.bootstrap_sha256,p_attestation,p_mappings,'prepared') returning * into v_existing;
	return public.qorpera_runtime_office_activation_result(v_existing);
end
$$;

-- Provider metadata recovery is allowed after preparation-disable. It grants
-- neither startup nor work and never recreates missing activation identity.
create function public.qorpera_runtime_office_activation_status(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_activation_id uuid,p_provider_id uuid,p_provider_policy_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);
	select * into v_activation from public.qorpera_runtime_office_activations where intent_id=p_intent_id
		and activation_id=p_activation_id and office_id=(p_scope->>'companyComputerId')::uuid
		and computer_generation=p_computer_generation and provider_id=p_provider_id and provider_policy_sha256=p_provider_policy_sha256 for share;
	if not found then raise exception 'Office activation identity unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_activation_result(v_activation);
end
$$;

-- Internal only. Acquires the common lock order before examining readiness.
-- A different service invocation never takes over because a heartbeat expired.
create function public.qorpera_lock_runtime_office_startup(p_startup jsonb)
returns public.qorpera_runtime_office_activations language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype; v_key text;
	v_keys text[]:=array['scope','computerGeneration','allocationId','instanceSha256','imageSha256','bootstrapSha256',
		'bootId','configurationSha256','serviceInvocationId'];
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_startup) is distinct from 'object'
		or p_startup-v_keys<>'{}'::jsonb or not (p_startup ?& v_keys)
		or jsonb_typeof(p_startup->'computerGeneration') is distinct from 'number'
		or p_startup->>'computerGeneration' !~ '^[1-9][0-9]{0,15}$'
		or (p_startup->>'computerGeneration')::bigint>9007199254740991
		or jsonb_typeof(p_startup->'serviceInvocationId') is distinct from 'string'
		or p_startup->>'serviceInvocationId' !~ '^[0-9a-f]{32}$'
		or p_startup->>'serviceInvocationId'=repeat('0',32) then
		raise exception 'Invalid office startup identity' using errcode='42501'; end if;
	foreach v_key in array array['allocationId','bootId'] loop
		if jsonb_typeof(p_startup->v_key) is distinct from 'string'
			or p_startup->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office startup identity' using errcode='42501'; end if;
	end loop;
	foreach v_key in array array['instanceSha256','imageSha256','bootstrapSha256','configurationSha256'] loop
		if jsonb_typeof(p_startup->v_key) is distinct from 'string' or p_startup->>v_key !~ '^[0-9a-f]{64}$' then
			raise exception 'Invalid office startup digest' using errcode='42501'; end if;
	end loop;
	select * into v_activation from public.qorpera_runtime_office_activations
		where allocation_id=(p_startup->>'allocationId')::uuid;
	if not found then raise exception 'Office startup not prepared' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_provider(p_startup->'scope',(p_startup->>'computerGeneration')::bigint,
		v_activation.provider_id,v_activation.provider_policy_sha256,false);
	select * into strict v_activation from public.qorpera_runtime_office_activations where intent_id=v_activation.intent_id for update;
	if v_activation.office_id::text is distinct from p_startup#>>'{scope,companyComputerId}'
		or v_activation.computer_generation::text is distinct from p_startup->>'computerGeneration'
		or v_activation.instance_sha256 is distinct from p_startup->>'instanceSha256'
		or v_activation.image_sha256 is distinct from p_startup->>'imageSha256'
		or v_activation.bootstrap_sha256 is distinct from p_startup->>'bootstrapSha256'
		or v_activation.attestation->>'bootId' is distinct from p_startup->>'bootId'
		or v_activation.attestation->>'configurationSha256' is distinct from p_startup->>'configurationSha256'
		or (v_activation.service_invocation_id is not null and v_activation.service_invocation_id<>p_startup->>'serviceInvocationId') then
		raise exception 'Office startup binding differs' using errcode='42501'; end if;
	if v_activation.state='active' then
		perform public.qorpera_check_runtime_office_guest_binding(p_startup->'scope',v_activation.computer_generation,
			v_activation.allocation_id,v_activation.instance_sha256,v_activation.image_sha256,v_activation.bootstrap_sha256);
	else
		perform public.qorpera_check_runtime_office_adoption(p_startup->'scope',v_activation.computer_generation,
			v_activation.intent_id,v_activation.allocation_id,v_activation.instance_sha256,v_activation.provider_binding_sha256,
			v_activation.provider_id,v_activation.provider_policy_sha256,v_activation.mappings);
	end if;
	return v_activation;
end
$$;

create function public.qorpera_runtime_office_startup_result(p_value public.qorpera_runtime_office_activations)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-startup-authority/v1','activationId',p_value.activation_id,
		'bootId',p_value.attestation->>'bootId','configurationSha256',p_value.attestation->>'configurationSha256',
		'state',p_value.state,'serviceInvocationId',p_value.service_invocation_id,'validForMs',5000)
$$;

-- Startup authority permits physical preflight and closed listeners only.
-- Ordinary effects, viewers, screens and privacy entry still require active.
create function public.qorpera_check_runtime_office_startup(p_startup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	return public.qorpera_runtime_office_startup_result(public.qorpera_lock_runtime_office_startup(p_startup));
end
$$;

create function public.qorpera_report_runtime_office_ready(p_startup jsonb,p_activation_id uuid,p_native_port integer,p_viewer_port integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	v_activation:=public.qorpera_lock_runtime_office_startup(p_startup);
	if p_activation_id is distinct from v_activation.activation_id
		or p_native_port is distinct from (v_activation.attestation->>'nativePort')::integer
		or p_viewer_port is distinct from (v_activation.attestation->>'viewerPort')::integer then
		raise exception 'Office readiness differs' using errcode='42501'; end if;
	if v_activation.state<>'active' then
		update public.qorpera_runtime_office_activations set state='ready',service_invocation_id=p_startup->>'serviceInvocationId',
			ready_at=clock_timestamp() where intent_id=v_activation.intent_id returning * into v_activation;
	end if;
	return public.qorpera_runtime_office_startup_result(v_activation);
end
$$;

-- Provider calls only after independently measuring the exact running guest
-- boot, configuration and ordinary unit invocation. SQL cannot measure those
-- physical facts, so its immutable readiness record is necessary but not enough.
create function public.qorpera_activate_runtime_office(p_scope jsonb,p_computer_generation bigint,p_intent_id uuid,
	p_activation_id uuid,p_provider_id uuid,p_provider_policy_sha256 text,p_service_invocation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_activation public.qorpera_runtime_office_activations%rowtype;
begin
	perform public.qorpera_assert_runtime_office_provider(p_scope,p_computer_generation,p_provider_id,p_provider_policy_sha256,false);
	select * into v_activation from public.qorpera_runtime_office_activations where intent_id=p_intent_id
		and activation_id=p_activation_id and office_id=(p_scope->>'companyComputerId')::uuid
		and computer_generation=p_computer_generation and provider_id=p_provider_id and provider_policy_sha256=p_provider_policy_sha256 for update;
	if not found or v_activation.service_invocation_id is null
		or p_service_invocation_id is distinct from v_activation.service_invocation_id then
		raise exception 'Office activation readiness unavailable' using errcode='42501'; end if;
	if v_activation.state='active' then
		-- Lost committed replies recover the same activation without rerunning
		-- preparation against an already active office.
		perform public.qorpera_check_runtime_office_guest_binding(p_scope,p_computer_generation,v_activation.allocation_id,
			v_activation.instance_sha256,v_activation.image_sha256,v_activation.bootstrap_sha256);
		return public.qorpera_runtime_office_activation_result(v_activation);
	end if;
	perform public.qorpera_check_runtime_office_adoption(p_scope,p_computer_generation,p_intent_id,v_activation.allocation_id,
		v_activation.instance_sha256,v_activation.provider_binding_sha256,p_provider_id,p_provider_policy_sha256,v_activation.mappings);
	if v_activation.state<>'ready' or v_activation.ready_at is null or v_activation.ready_at<=clock_timestamp()-interval '5 seconds' then
		raise exception 'Office activation readiness expired' using errcode='42501'; end if;
	update public.qorpera_runtime_offices set state='active' where id=v_activation.office_id;
	update public.qorpera_runtime_office_activations set state='active',activated_at=clock_timestamp()
		where intent_id=v_activation.intent_id returning * into v_activation;
	return public.qorpera_runtime_office_activation_result(v_activation);
end
$$;

alter table public.qorpera_runtime_office_activations enable row level security;
revoke all on public.qorpera_runtime_office_activations from public,anon,authenticated,service_role;
revoke all on function public.qorpera_assert_runtime_office_activation_attestation(jsonb),
	public.qorpera_runtime_office_activation_result(public.qorpera_runtime_office_activations),
	public.qorpera_prepare_runtime_office_activation(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb,jsonb),
	public.qorpera_runtime_office_activation_status(jsonb,bigint,uuid,uuid,uuid,text),
	public.qorpera_lock_runtime_office_startup(jsonb),
	public.qorpera_runtime_office_startup_result(public.qorpera_runtime_office_activations),
	public.qorpera_check_runtime_office_startup(jsonb),
	public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer),
	public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_prepare_runtime_office_activation(jsonb,bigint,uuid,uuid,text,text,uuid,text,jsonb,jsonb),
	public.qorpera_runtime_office_activation_status(jsonb,bigint,uuid,uuid,uuid,text),
	public.qorpera_check_runtime_office_startup(jsonb),
	public.qorpera_report_runtime_office_ready(jsonb,uuid,integer,integer),
	public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text) to service_role;
