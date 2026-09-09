-- Explicit recovery starts by revoking admission, never by expiring the old
-- invocation. This migration intentionally provides no stop acknowledgement,
-- reactivation, generation reassignment or resource-release shortcut.
create table public.qorpera_runtime_office_lifecycle_transitions (
	id uuid primary key,
	activation_id uuid not null unique references public.qorpera_runtime_office_activations(activation_id) on delete restrict,
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint not null check(computer_generation between 1 and 9007199254740991),
	allocation_id uuid not null references public.qorpera_runtime_machine_allocations(id) on delete restrict,
	request jsonb not null,
	state text not null default 'draining' check(state='draining'),
	revocation_revision bigint not null check(revocation_revision between 1 and 9007199254740991),
	requested_at timestamptz not null default clock_timestamp(),
	drains jsonb not null check(jsonb_typeof(drains)='array' and jsonb_array_length(drains)<=32),
	unique(office_id,computer_generation)
);

create function public.qorpera_assert_runtime_office_lifecycle_request(p_request jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_start jsonb:=p_request->'startup'; v_key text;
	v_keys text[]:=array['schema','transitionId','action','activationId','providerId','providerPolicySha256','startup'];
	v_start_keys text[]:=array['scope','computerGeneration','allocationId','instanceSha256','imageSha256','bootstrapSha256','bootId','configurationSha256','serviceInvocationId'];
	v_scope_keys text[]:=array['companyId','environmentId','companyComputerId','logicalComputerId'];
begin
	if jsonb_typeof(p_request) is distinct from 'object' or p_request-v_keys<>'{}'::jsonb or not(p_request ?& v_keys)
		or p_request->>'schema' is distinct from 'qorpera.office-lifecycle-request/v1'
		or coalesce(p_request->>'action','') not in ('service_restart','reboot','power_off','replace')
		or jsonb_typeof(v_start) is distinct from 'object' or v_start-v_start_keys<>'{}'::jsonb or not(v_start ?& v_start_keys)
		or jsonb_typeof(v_start->'scope') is distinct from 'object' or (v_start->'scope')-v_scope_keys<>'{}'::jsonb
		or not((v_start->'scope') ?& v_scope_keys) then raise exception 'Invalid office lifecycle request' using errcode='22023'; end if;
	foreach v_key in array array['transitionId','activationId','providerId'] loop
		if jsonb_typeof(p_request->v_key) is distinct from 'string' or p_request->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office lifecycle identity' using errcode='22023'; end if;
	end loop;
	foreach v_key in array v_scope_keys loop
		if jsonb_typeof(v_start#>array['scope',v_key]) is distinct from 'string' or v_start#>>array['scope',v_key] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office lifecycle scope' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['allocationId','bootId'] loop
		if jsonb_typeof(v_start->v_key) is distinct from 'string' or v_start->>v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Invalid office lifecycle boot' using errcode='22023'; end if;
	end loop;
	foreach v_key in array array['instanceSha256','imageSha256','bootstrapSha256','configurationSha256'] loop
		if jsonb_typeof(v_start->v_key) is distinct from 'string' or v_start->>v_key !~ '^[0-9a-f]{64}$' then
			raise exception 'Invalid office lifecycle digest' using errcode='22023'; end if;
	end loop;
	if jsonb_typeof(p_request->'providerPolicySha256') is distinct from 'string' or p_request->>'providerPolicySha256' !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(v_start->'computerGeneration') is distinct from 'number' or v_start->>'computerGeneration' !~ '^[1-9][0-9]{0,15}$'
		or (v_start->>'computerGeneration')::bigint>9007199254740991
		or jsonb_typeof(v_start->'serviceInvocationId') is distinct from 'string' or v_start->>'serviceInvocationId' !~ '^[0-9a-f]{32}$'
		or v_start->>'serviceInvocationId'=repeat('0',32) then raise exception 'Invalid office lifecycle binding' using errcode='22023'; end if;
end
$$;

create function public.qorpera_runtime_office_lifecycle_result(p_value public.qorpera_runtime_office_lifecycle_transitions)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.office-lifecycle-transition/v1','request',p_value.request,'state',p_value.state,
		'revocationRevision',p_value.revocation_revision,'requestedAtMs',floor(extract(epoch from p_value.requested_at)*1000)::bigint,'drains',p_value.drains)
$$;

-- Profile -> office -> provider -> activation -> allocation -> transition,
-- consistent with startup. Recovery remains available after preparation is
-- disabled or execution is paused: revoking work cannot require work authority.
create function public.qorpera_begin_runtime_office_lifecycle(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_start jsonb:=p_request->'startup'; v_office public.qorpera_runtime_offices%rowtype;
	v_activation public.qorpera_runtime_office_activations%rowtype; v_existing public.qorpera_runtime_office_lifecycle_transitions%rowtype;
	v_drains jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(v_start->'scope',(v_start->>'computerGeneration')::bigint,
		(p_request->>'providerId')::uuid,p_request->>'providerPolicySha256',false);
	select * into strict v_office from public.qorpera_runtime_offices where id=(v_start#>>'{scope,companyComputerId}')::uuid;
	select * into v_activation from public.qorpera_runtime_office_activations where activation_id=(p_request->>'activationId')::uuid for update;
	if not found or v_activation.state<>'active' or v_activation.office_id<>v_office.id or v_activation.computer_generation<>v_office.generation
		or v_activation.provider_id::text is distinct from p_request->>'providerId' or v_activation.provider_policy_sha256 is distinct from p_request->>'providerPolicySha256'
		or v_activation.allocation_id::text is distinct from v_start->>'allocationId' or v_activation.instance_sha256 is distinct from v_start->>'instanceSha256'
		or v_activation.image_sha256 is distinct from v_start->>'imageSha256' or v_activation.bootstrap_sha256 is distinct from v_start->>'bootstrapSha256'
		or v_activation.attestation->>'bootId' is distinct from v_start->>'bootId'
		or v_activation.attestation->>'configurationSha256' is distinct from v_start->>'configurationSha256'
		or v_activation.service_invocation_id is distinct from v_start->>'serviceInvocationId' then
		raise exception 'Office lifecycle activation differs' using errcode='42501'; end if;
	perform 1 from public.qorpera_runtime_machine_allocations where id=v_activation.allocation_id and office_id=v_office.id
		and computer_generation=v_office.generation and profile_id=v_office.profile_id and provider_adapter='lxd'
		and instance_sha256=v_activation.instance_sha256 and released_at is null for share;
	if not found then raise exception 'Office lifecycle allocation differs' using errcode='42501'; end if;
	select * into v_existing from public.qorpera_runtime_office_lifecycle_transitions where office_id=v_office.id and computer_generation=v_office.generation for update;
	if found then
		if v_existing.request<>p_request or v_office.state<>'maintenance' then raise exception 'Office lifecycle cannot be rebound' using errcode='42501'; end if;
		return public.qorpera_runtime_office_lifecycle_result(v_existing);
	end if;
	if v_office.state<>'active' then raise exception 'Office lifecycle is unavailable' using errcode='42501'; end if;
	-- Do not replace an outstanding screen challenge. Its old driver may still
	-- be draining. Fence the whole office and preserve that exact acknowledgement.
	update public.qorpera_runtime_office_screens set epoch=epoch+1,drain_pending=true,
		drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null
		where office_id=v_office.id and not drain_pending;
	update public.qorpera_runtime_office_screens set lease_id=null,run_id=null,lease_expires_at=null,
		grant_version=null,native_binding=null,takeover_user_id=null,touched_at=clock_timestamp() where office_id=v_office.id;
	update public.qorpera_runtime_office_resources set state='draining' where office_id=v_office.id and state='active';
	update public.qorpera_runtime_office_viewers set state='draining' where office_id=v_office.id and state in ('issued','active');
	-- Keep private profiles, privacy challenge and workbench provenance intact.
	-- A later physical stop receipt must resolve them; this is not a privacy ack.
	update public.qorpera_runtime_offices set state='maintenance',revision=revision+1 where id=v_office.id returning * into v_office;
	select coalesce(jsonb_agg(jsonb_build_object('state','draining','drainId',s.drain_id,'epoch',s.epoch,
		'binding',v_start->'scope'||jsonb_build_object('computerGeneration',v_office.generation,'screenId',s.id,'screenOrdinal',s.ordinal,
			'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id)) order by s.ordinal),'[]'::jsonb)
	into v_drains from public.qorpera_runtime_office_screens s where s.office_id=v_office.id;
	insert into public.qorpera_runtime_office_lifecycle_transitions(id,activation_id,office_id,computer_generation,allocation_id,request,revocation_revision,drains)
	values((p_request->>'transitionId')::uuid,v_activation.activation_id,v_office.id,v_office.generation,v_activation.allocation_id,p_request,v_office.revision,v_drains)
	returning * into v_existing;
	return public.qorpera_runtime_office_lifecycle_result(v_existing);
end
$$;

-- Read-only recovery; a missing transition is never recreated by status.
create function public.qorpera_runtime_office_lifecycle_status(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_existing public.qorpera_runtime_office_lifecycle_transitions%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Office provider required' using errcode='42501'; end if;
	perform public.qorpera_assert_runtime_office_lifecycle_request(p_request);
	perform public.qorpera_assert_runtime_office_provider(p_request#>'{startup,scope}',(p_request#>>'{startup,computerGeneration}')::bigint,
		(p_request->>'providerId')::uuid,p_request->>'providerPolicySha256',false);
	select * into v_existing from public.qorpera_runtime_office_lifecycle_transitions where id=(p_request->>'transitionId')::uuid for share;
	if not found or v_existing.request<>p_request then raise exception 'Office lifecycle identity unavailable' using errcode='42501'; end if;
	return public.qorpera_runtime_office_lifecycle_result(v_existing);
end
$$;

alter table public.qorpera_runtime_office_lifecycle_transitions enable row level security;
revoke all on public.qorpera_runtime_office_lifecycle_transitions from public,anon,authenticated,service_role;
revoke all on function public.qorpera_assert_runtime_office_lifecycle_request(jsonb),
	public.qorpera_runtime_office_lifecycle_result(public.qorpera_runtime_office_lifecycle_transitions),
	public.qorpera_begin_runtime_office_lifecycle(jsonb),public.qorpera_runtime_office_lifecycle_status(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_begin_runtime_office_lifecycle(jsonb),public.qorpera_runtime_office_lifecycle_status(jsonb) to service_role;
