-- A paid guard's forced physical stop revokes office admission. It is not a
-- guest service-stop acknowledgement, privacy acknowledgement, capacity release
-- or restart authorization. The original invocation and private state remain.
create table public.qorpera_runtime_office_computer_outages (
    request_id uuid primary key,
    activation_id uuid not null unique references public.qorpera_runtime_office_activations(activation_id),
    permit_id uuid not null references public.qorpera_coding_computer_permits(id),
    office_id uuid not null references public.qorpera_runtime_offices(id),
    request jsonb not null,
    receipt jsonb not null,
    registered_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_runtime_office_computer_outages enable row level security;
revoke all on public.qorpera_runtime_office_computer_outages from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_register_runtime_office_computer_outage(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_guard jsonb:=p_request->'guard'; v_local jsonb:=v_guard->'permit'; v_stop jsonb:=v_guard->'stopReceipt';
    v_activation_request jsonb:=p_request->'activation'; v_startup jsonb:=v_activation_request->'startup';
    v_context public.qorpera_runtime_computer_contexts%rowtype;
    v_permit public.qorpera_coding_computer_permits%rowtype;
    v_prestart public.qorpera_computer_prestart_attempts%rowtype;
    v_office public.qorpera_runtime_offices%rowtype;
    v_activation public.qorpera_runtime_office_activations%rowtype;
    v_prior public.qorpera_runtime_office_computer_outages%rowtype;
    v_transition public.qorpera_runtime_office_lifecycle_transitions%rowtype;
    v_expected jsonb; v_receipt jsonb; v_key text; v_generation bigint; v_state text;
    v_uuid text:='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
    if jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>20000
        or p_request-array['schema','requestId','activation','guard']<>'{}'::jsonb
        or not(p_request ?& array['schema','requestId','activation','guard'])
        or p_request->>'schema' is distinct from 'qorpera.office-computer-outage-request/v1'
        or coalesce(p_request->>'requestId','') !~ v_uuid
        or jsonb_typeof(v_activation_request) is distinct from 'object'
        or v_activation_request-array['activationId','providerId','providerPolicySha256','startup']<>'{}'::jsonb
        or not(v_activation_request ?& array['activationId','providerId','providerPolicySha256','startup'])
        or jsonb_typeof(v_guard) is distinct from 'object'
        or v_guard-array['permit','hostMachineIdSha256','physicalInstanceId','startOperationId','startDispatched','startSettled','startSucceeded','stopReceipt']<>'{}'::jsonb
        or not(v_guard ?& array['permit','hostMachineIdSha256','physicalInstanceId','startOperationId','startDispatched','startSettled','startSucceeded','stopReceipt'])
        or v_guard->'startDispatched' is distinct from 'true'::jsonb
        or v_guard->'startSettled' is distinct from 'true'::jsonb
        or v_guard->'startSucceeded' is distinct from 'true'::jsonb
        or coalesce(v_guard->>'startOperationId','') !~ v_uuid
        or coalesce(v_guard->>'physicalInstanceId','') !~ v_uuid
        or coalesce(v_guard->>'hostMachineIdSha256','') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(v_local) is distinct from 'object'
        or coalesce(v_local->>'permitId','') !~ v_uuid
        or coalesce(v_local->>'generation','') !~ '^[1-9][0-9]{0,15}$'
        or jsonb_typeof(v_stop) is distinct from 'object'
        or v_stop-array['permitId','generation','allocationId','instanceSha256','physicalInstanceId','hostBootId','observedUptimeMs','closedAtUptimeMs','closedHostBootId','state','operationId']<>'{}'::jsonb
        or not(v_stop ?& array['permitId','generation','allocationId','instanceSha256','physicalInstanceId','hostBootId','observedUptimeMs','closedAtUptimeMs','closedHostBootId','state','operationId'])
        or coalesce(v_stop->>'state','') not in ('stopped','absent')
        or coalesce(v_stop->>'closedHostBootId','') !~ v_uuid
        or (v_stop->'operationId'<>'null'::jsonb and coalesce(v_stop->>'operationId','') !~ v_uuid) then
        raise exception 'Invalid office computer outage proof' using errcode='22023'; end if;
    -- Reuse the existing exact startup/activation validator, without creating
    -- an operator lifecycle transition or claiming that one was requested.
    perform public.qorpera_assert_runtime_office_lifecycle_request(v_activation_request||jsonb_build_object(
        'schema','qorpera.office-lifecycle-request/v1','transitionId',p_request->'requestId','action','power_off'));
    foreach v_key in array array['observedUptimeMs','closedAtUptimeMs'] loop
        if jsonb_typeof(v_stop->v_key) is distinct from 'number' or (v_stop->>v_key) !~ '^(0|[1-9][0-9]{0,15})$'
            or (v_stop->>v_key)::numeric>9007199254740991 then
            raise exception 'Invalid office stop clock' using errcode='22023'; end if;
    end loop;
    v_generation:=(v_local->>'generation')::bigint;
    v_context:=public.qorpera_runtime_computer_permit_host((v_local->>'permitId')::uuid,p_executor_secret);
    if v_context.context->>'providerKind' is distinct from 'office' then
        raise exception 'Office host required' using errcode='42501'; end if;
    select * into strict v_permit from public.qorpera_coding_computer_permits where id=v_context.permit_id;
    -- Serialize with admission and lifecycle using profile -> office -> provider
    -- -> activation -> allocation, after independent immutable host enrollment.
    perform 1 from public.qorpera_profiles where id=v_permit.profile_id for update;
    select * into v_prior from public.qorpera_runtime_office_computer_outages
        where request_id=(p_request->>'requestId')::uuid or activation_id=(v_activation_request->>'activationId')::uuid;
    if found then
        if v_prior.request is distinct from p_request or v_prior.permit_id<>v_permit.id then
            raise exception 'Office outage cannot be rebound' using errcode='42501'; end if;
        return v_prior.receipt;
    end if;
    perform public.qorpera_assert_runtime_office_provider(v_startup->'scope',(v_startup->>'computerGeneration')::bigint,
        (v_activation_request->>'providerId')::uuid,v_activation_request->>'providerPolicySha256',false);
    select * into strict v_office from public.qorpera_runtime_offices where id=(v_startup#>>'{scope,companyComputerId}')::uuid;
    select * into v_activation from public.qorpera_runtime_office_activations
        where activation_id=(v_activation_request->>'activationId')::uuid for update;
    if not found or v_activation.superseded_at is not null or v_activation.state<>'active'
        or v_activation.office_id<>v_office.id or v_office.profile_id<>v_permit.profile_id
        or v_activation.computer_generation<>v_office.generation
        or v_activation.provider_id::text is distinct from v_activation_request->>'providerId'
        or v_activation.provider_policy_sha256 is distinct from v_activation_request->>'providerPolicySha256'
        or v_activation.allocation_id::text is distinct from v_startup->>'allocationId'
        or v_activation.instance_sha256 is distinct from v_startup->>'instanceSha256'
        or v_activation.image_sha256 is distinct from v_startup->>'imageSha256'
        or v_activation.bootstrap_sha256 is distinct from v_startup->>'bootstrapSha256'
        or v_activation.attestation->>'bootId' is distinct from v_startup->>'bootId'
        or v_activation.attestation->>'configurationSha256' is distinct from v_startup->>'configurationSha256'
        or v_activation.service_invocation_id is distinct from v_startup->>'serviceInvocationId'
        or v_context.context->>'officeId' is distinct from v_office.id::text
        or v_context.context->'computerGeneration' is distinct from to_jsonb(v_office.generation)
        or v_context.context->>'providerId' is distinct from v_activation.provider_id::text
        or v_context.context->>'policySha256' is distinct from v_activation.provider_policy_sha256
        or v_context.context->>'bootstrapSha256' is distinct from v_activation.bootstrap_sha256
        or v_context.request_identity->>'machineIdSha256' is distinct from v_guard->>'hostMachineIdSha256' then
        raise exception 'Office outage activation differs' using errcode='42501'; end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=v_activation.allocation_id
        and id=v_permit.allocation_id and profile_id=v_office.profile_id and office_id=v_office.id
        and computer_generation=v_office.generation and instance_sha256=v_activation.instance_sha256
        and provider_adapter='lxd' and released_at is null for update;
    if not found then raise exception 'Office outage allocation differs' using errcode='42501'; end if;
    select * into strict v_permit from public.qorpera_coding_computer_permits where id=v_permit.id for update;
    select * into v_prestart from public.qorpera_computer_prestart_attempts where permit_id=v_permit.id;
    if not found or v_prestart.kind<>'runtime' or v_prestart.profile_id<>v_permit.profile_id
        or v_prestart.host_key_id<>v_context.host_key_id or v_prestart.closure is not null
        or v_prestart.identity#>>'{guard,hostMachineIdSha256}' is distinct from v_guard->>'hostMachineIdSha256'
        or v_permit.state not in ('bound','closed') or v_permit.generation not in(v_generation,v_generation+1)
        or v_permit.guest_boot_id::text is distinct from v_startup->>'bootId'
        or v_permit.physical_id::text is distinct from v_guard->>'physicalInstanceId' then
        raise exception 'Office outage paid custody differs' using errcode='42501'; end if;
    v_expected:=public.qorpera_computer_permit_receipt(v_permit.id,v_generation)-'closure';
    -- Binding does not re-arm a first-window guard: its local permit may still
    -- be prepared with null guest/physical identities. SQL's bound identities
    -- must nevertheless match this exact activation and physical stop.
    if (v_local-array['issuedAt','deadline','validForMs','state','guestBootId','physicalId']) is distinct from
        (v_expected-array['issuedAt','deadline','validForMs','state','guestBootId','physicalId'])
        or not(v_local ?& array['issuedAt','deadline','validForMs','state','guestBootId','physicalId'])
        or (v_local->>'issuedAt')::timestamptz is distinct from (v_expected->>'issuedAt')::timestamptz
        or (v_local->>'deadline')::timestamptz is distinct from (v_expected->>'deadline')::timestamptz
        or coalesce(v_local->>'state','') not in ('prepared','bound','closed')
        or jsonb_typeof(v_local->'validForMs') is distinct from 'number'
        or v_local->>'validForMs' !~ '^(0|[1-9][0-9]{0,15})$'
        or (v_local->>'validForMs')::numeric not between 0 and
            (v_expected->>'windowMs')::numeric+(v_expected->>'stopReserveMs')::numeric
        or (v_local->'guestBootId'<>'null'::jsonb and v_local->'guestBootId' is distinct from v_expected->'guestBootId')
        or (v_local->'physicalId'<>'null'::jsonb and v_local->'physicalId' is distinct from v_expected->'physicalId')
        or v_stop->'permitId' is distinct from v_local->'permitId'
        or v_stop->'generation' is distinct from v_local->'generation'
        or v_stop->'allocationId' is distinct from v_local->'allocationId'
        or v_stop->'instanceSha256' is distinct from v_local->'instanceSha256'
        or v_stop->'hostBootId' is distinct from v_local->'hostBootId'
        or v_stop->'physicalInstanceId' is distinct from v_guard->'physicalInstanceId'
        or (v_stop->'closedHostBootId'=v_stop->'hostBootId' and
            (v_stop->>'closedAtUptimeMs')::numeric<(v_stop->>'observedUptimeMs')::numeric) then
        raise exception 'Office outage guard proof differs' using errcode='42501'; end if;
    select * into v_transition from public.qorpera_runtime_office_lifecycle_transitions where activation_id=v_activation.activation_id;
    if v_office.state='maintenance' and found
        and (v_transition.request-array['schema','transitionId','action'])=v_activation_request
        and exists(select 1 from public.qorpera_runtime_office_stops where transition_id=v_transition.id) then
        v_state:='orderly';
    elsif v_office.state='active' and not found then
        if not exists(select 1 from public.qorpera_runtime_node_instance_bindings where allocation_id=v_permit.allocation_id
            and node_id=v_permit.node_id and physical_id=v_permit.physical_id) then
            raise exception 'Office outage physical enrollment differs' using errcode='42501'; end if;
        v_state:='held';
        update public.qorpera_runtime_office_screens set epoch=epoch+1,drain_pending=true,
            drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null where office_id=v_office.id and not drain_pending;
        update public.qorpera_runtime_office_screens set lease_id=null,run_id=null,lease_expires_at=null,
            grant_version=null,native_binding=null,takeover_user_id=null,touched_at=clock_timestamp() where office_id=v_office.id;
        update public.qorpera_runtime_office_resources set state='draining' where office_id=v_office.id and state='active';
        update public.qorpera_runtime_office_viewers set state='draining' where office_id=v_office.id and state in ('issued','active');
        update public.qorpera_runtime_offices set state='maintenance',revision=revision+1 where id=v_office.id returning * into v_office;
    else
        -- A forced stop during unacknowledged operator draining needs explicit
        -- recovery. Preserve that chain and all privacy/drain challenges.
        raise exception 'Office outage overlaps unresolved lifecycle' using errcode='42501';
    end if;
    v_receipt:=jsonb_build_object('schema','qorpera.office-computer-outage/v1','request',p_request,'state',v_state,
        'officeRevision',v_office.revision,'registeredAtMs',floor(extract(epoch from clock_timestamp())*1000)::bigint);
    insert into public.qorpera_runtime_office_computer_outages(request_id,activation_id,permit_id,office_id,request,receipt)
        values((p_request->>'requestId')::uuid,v_activation.activation_id,v_permit.id,v_office.id,p_request,v_receipt);
    return v_receipt;
end $$;
revoke all on function public.qorpera_register_runtime_office_computer_outage(jsonb,text)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_register_runtime_office_computer_outage(jsonb,text) to service_role;
-- Private callees may have different hosted SECURITY DEFINER owners.
do $$ declare v_owner name; v_helper regprocedure; begin
    select pg_get_userbyid(proowner) into strict v_owner from pg_proc
        where oid='public.qorpera_register_runtime_office_computer_outage(jsonb,text)'::regprocedure;
    if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
        raise exception 'Office outage requires a trusted owner'; end if;
    foreach v_helper in array array[
        'public.qorpera_runtime_computer_permit_host(uuid,text)'::regprocedure,
        'public.qorpera_assert_runtime_office_lifecycle_request(jsonb)'::regprocedure,
        'public.qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)'::regprocedure,
        'public.qorpera_computer_permit_receipt(uuid,bigint)'::regprocedure] loop
        execute format('grant execute on function %s to %I',v_helper,v_owner);
    end loop;
end $$;
