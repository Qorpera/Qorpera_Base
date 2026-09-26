-- Outage recovery is a distinct predecessor authority. It never fabricates an
-- orderly office_stops row or rewrites the original paid guard's stop proof.
create table public.qorpera_runtime_office_outage_recoveries (
    recovery_id uuid primary key,
    outage_request_id uuid not null unique references public.qorpera_runtime_office_computer_outages(request_id),
    activation_id uuid not null unique,
    start_command_id uuid not null unique,
    request jsonb not null,
    receipt jsonb not null,
    snapshot jsonb not null,
    termination_request jsonb,
    termination_receipt jsonb,
    successor_request jsonb,
    successor_revision bigint,
    prepared_at timestamptz not null default clock_timestamp(),
    check((termination_request is null)=(termination_receipt is null)),
    check((successor_request is null)=(successor_revision is null))
);
create table public.qorpera_runtime_office_outage_termination_challenges (
    inspection_id uuid primary key,
    recovery_id uuid not null references public.qorpera_runtime_office_outage_recoveries(recovery_id),
    request jsonb not null,
    issued_at timestamptz not null default clock_timestamp(),
    expires_at timestamptz not null
);

create function public.qorpera_assert_office_outage_recovery_request(p_request jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare k text;
begin
    if not public.qorpera_screen_metadata_object(p_request,array['schema','recoveryId','outageRequestId','activationId','startCommandId'])
        or p_request->>'schema' is distinct from 'qorpera.office-outage-recovery-request/v1' then
        raise exception 'Invalid office outage recovery request' using errcode='22023'; end if;
    foreach k in array array['recoveryId','outageRequestId','activationId','startCommandId'] loop
        if jsonb_typeof(p_request->k) is distinct from 'string' or p_request->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
            raise exception 'Invalid office outage recovery identity' using errcode='22023'; end if;
    end loop;
    if (select count(distinct e.v) from jsonb_each_text(p_request) e(k,v) where e.k<>'schema')<>4 then
        raise exception 'Office recovery identities must be distinct' using errcode='22023'; end if;
end $$;

-- Preserve the existing initial/resume/reset branches byte-for-byte. Only the
-- new typed intent may authorize an outage's fresh paid epoch.
do $$ declare d text:=pg_get_functiondef('public.qorpera_authorize_paid_office_start(jsonb)'::regprocedure); begin
    execute replace(d,'FUNCTION public.qorpera_authorize_paid_office_start(',
        'FUNCTION public.qorpera_authorize_paid_office_start_before_outage(');
end $$;
create or replace function public.qorpera_authorize_paid_office_start(p_request jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare i jsonb:=p_request->'officeIntent'; o public.qorpera_runtime_office_computer_outages%rowtype;
    r public.qorpera_runtime_office_outage_recoveries%rowtype; old_context public.qorpera_runtime_computer_contexts%rowtype;
begin
    if i->>'kind' is distinct from 'outage_recovery' then
        perform public.qorpera_authorize_paid_office_start_before_outage(p_request); return;
    end if;
    if not public.qorpera_screen_metadata_object(i,array['kind','request']) then raise exception 'Invalid outage paid intent' using errcode='22023'; end if;
    o:=public.qorpera_lock_office_outage_recovery(i->'request',true);
    select * into r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(i#>>'{request,recoveryId}')::uuid;
    select * into strict old_context from public.qorpera_runtime_computer_contexts where permit_id=o.permit_id;
    if r.request is distinct from i->'request' or r.termination_receipt is not null or r.successor_request is not null
        or p_request->>'requestId' is distinct from r.start_command_id::text
        or p_request->>'officeId' is distinct from o.office_id::text
        or p_request->'computerGeneration' is distinct from o.request#>'{activation,startup,computerGeneration}'
        or p_request->>'allocationId' is distinct from o.request#>>'{activation,startup,allocationId}'
        or p_request->>'instanceSha256' is distinct from o.request#>>'{activation,startup,instanceSha256}'
        or p_request->>'providerId' is distinct from old_context.request_identity->>'providerId'
        or p_request->>'policySha256' is distinct from old_context.request_identity->>'policySha256'
        or p_request->>'bootstrapSha256' is distinct from old_context.request_identity->>'bootstrapSha256'
        or p_request->>'machineIdSha256' is distinct from old_context.request_identity->>'machineIdSha256'
        or p_request->>'hostBootId' is distinct from o.request#>>'{guard,stopReceipt,closedHostBootId}'
        or not exists(select 1 from public.qorpera_computer_prestart_attempts where permit_id=r.start_command_id
            and kind='runtime' and host_key_id=old_context.host_key_id and closure is null)
        or exists(select 1 from public.qorpera_runtime_computer_contexts where request_identity#>>'{officeIntent,request,recoveryId}'=r.recovery_id::text)
        or r.snapshot is distinct from public.qorpera_office_outage_recovery_snapshot((select c from public.qorpera_runtime_offices c where id=o.office_id)) then
        raise exception 'Outage paid start authority differs' using errcode='42501'; end if;
end $$;

create function public.qorpera_check_office_outage_running(p_recovery public.qorpera_runtime_office_outage_recoveries,p_observation jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_office_computer_outages%rowtype; p public.qorpera_coding_computer_permits%rowtype;
    ctx public.qorpera_runtime_computer_contexts%rowtype; w public.qorpera_coding_computer_windows%rowtype; k text;
begin
    if not public.qorpera_screen_metadata_object(p_observation,array['schema','intentId','allocationId','recoveryId','activationId',
        'startCommandId','requestSha256','hostBootId','bootId','instanceSha256','physicalInstanceId','operationId'])
        or p_observation->>'schema' is distinct from 'qorpera.lxd-office-outage-resume-observation/v1' then
        raise exception 'Invalid outage boot observation' using errcode='22023'; end if;
    foreach k in array array['intentId','allocationId','recoveryId','activationId','startCommandId','hostBootId','bootId','physicalInstanceId','operationId'] loop
        if jsonb_typeof(p_observation->k) is distinct from 'string' or p_observation->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
            raise exception 'Invalid outage boot identity' using errcode='22023'; end if;
    end loop;
    foreach k in array array['requestSha256','instanceSha256'] loop
        if jsonb_typeof(p_observation->k) is distinct from 'string' or p_observation->>k !~ '^[0-9a-f]{64}$' then
            raise exception 'Invalid outage boot digest' using errcode='22023'; end if;
    end loop;
    select * into strict o from public.qorpera_runtime_office_computer_outages where request_id=p_recovery.outage_request_id;
    select * into p from public.qorpera_coding_computer_permits where id=p_recovery.start_command_id for share;
    select * into ctx from public.qorpera_runtime_computer_contexts where permit_id=p.id;
    select * into w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=p.generation;
    if p.id is null or ctx.permit_id is null or w.permit_id is null or p.state<>'bound'
        or p_observation->>'recoveryId' is distinct from p_recovery.recovery_id::text
        or p_observation->>'activationId' is distinct from p_recovery.activation_id::text
        or p_observation->>'startCommandId' is distinct from p_recovery.start_command_id::text
        or p_observation->>'intentId' is distinct from (select intent_id::text from public.qorpera_runtime_office_activations where activation_id=o.activation_id)
        or p_observation->>'allocationId' is distinct from p.allocation_id::text
        or p_observation->>'instanceSha256' is distinct from p.instance_sha256
        or p_observation->>'hostBootId' is distinct from p.host_boot_id::text
        or p_observation->>'bootId' is distinct from p.guest_boot_id::text
        or p_observation->>'physicalInstanceId' is distinct from p.physical_id::text
        or p_observation->>'bootId'=o.request#>>'{activation,startup,bootId}'
        or p_observation->>'physicalInstanceId' is distinct from o.request#>>'{guard,physicalInstanceId}'
        or ctx.request_identity#>'{officeIntent}' is distinct from jsonb_build_object('kind','outage_recovery','request',p_recovery.request)
        or ctx.host_key_id is distinct from (select host_key_id from public.qorpera_runtime_computer_contexts where permit_id=o.permit_id)
        or not exists(select 1 from public.qorpera_runtime_computer_host_keys where id=ctx.host_key_id and revoked_at is null)
        or not exists(select 1 from public.qorpera_runtime_node_instance_bindings where allocation_id=p.allocation_id and node_id=p.node_id and physical_id=p.physical_id)
        or clock_timestamp()>=w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000)
        or p.last_sample->>'state' is distinct from 'running' then
        raise exception 'Outage recovery running permit unavailable' using errcode='42501'; end if;
end $$;

create function public.qorpera_prepare_runtime_office_outage_termination(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare recovery jsonb; r public.qorpera_runtime_office_outage_recoveries%rowtype;
    ch public.qorpera_runtime_office_outage_termination_challenges%rowtype; t timestamptz; ttl bigint;
begin
    if not public.qorpera_screen_metadata_object(p_request,array['recovery','inspectionId','observation','bootObservationSha256'])
        or coalesce(p_request->>'inspectionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(p_request->>'bootObservationSha256','') !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid outage termination challenge' using errcode='22023'; end if;
    recovery:=public.qorpera_check_runtime_office_outage_recovery(p_request->'recovery',p_executor_secret)->'recovery';
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{recovery,recoveryId}')::uuid for update;
    perform public.qorpera_check_office_outage_running(r,p_request->'observation');
    select * into ch from public.qorpera_runtime_office_outage_termination_challenges where inspection_id=(p_request->>'inspectionId')::uuid;
    if found then
        if ch.request is distinct from p_request then raise exception 'Outage inspection cannot be rebound' using errcode='42501'; end if;
    else
        if (select count(*) from public.qorpera_runtime_office_outage_termination_challenges where recovery_id=r.recovery_id)>=64 then
            raise exception 'Outage inspection budget exhausted' using errcode='54000'; end if;
        t:=clock_timestamp();
        insert into public.qorpera_runtime_office_outage_termination_challenges(inspection_id,recovery_id,request,issued_at,expires_at)
            values((p_request->>'inspectionId')::uuid,r.recovery_id,p_request,t,t+interval '5 seconds') returning * into ch;
    end if;
    ttl:=least(5000,floor(extract(epoch from(ch.expires_at-clock_timestamp()))*1000)::bigint);
    if ttl<1 then raise exception 'Outage inspection expired' using errcode='42501'; end if;
    return jsonb_build_object('schema','qorpera.office-outage-termination-challenge/v1','request',p_request,'recovery',recovery,'validForMs',ttl);
end $$;

create function public.qorpera_ack_runtime_office_outage_termination(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i jsonb:=p_request->'inspection'; r public.qorpera_runtime_office_outage_recoveries%rowtype;
    ch public.qorpera_runtime_office_outage_termination_challenges%rowtype; o public.qorpera_runtime_office_computer_outages%rowtype;
    c public.qorpera_runtime_offices%rowtype; a public.qorpera_runtime_office_activations%rowtype; v_receipt jsonb; k text;
begin
    if not public.qorpera_screen_metadata_object(p_request,array['recovery','inspection'])
        or not public.qorpera_screen_metadata_object(i,array['schema','inspectionId','recoveryId','startCommandId','bootId','hostBootId','physicalInstanceId',
            'bootObservationSha256','predecessorConfigurationSha256','predecessorAdoptionReceiptSha256','cgroupState','preparationState','serviceState',
            'command','originPreparationSha256','originAdoptionReceiptSha256'])
        or i->>'schema' is distinct from 'qorpera.office-outage-termination-inspection/v1'
        or not public.qorpera_screen_metadata_object(i->'command',array['commandId','requestSha256','bootId'])
        or coalesce(i->>'cgroupState','') not in ('absent','empty')
        or i->>'preparationState' is distinct from 'unstarted' or i->>'serviceState' is distinct from 'unstarted' then
        raise exception 'Invalid outage termination inspection' using errcode='22023'; end if;
    foreach k in array array['inspectionId','recoveryId','startCommandId','bootId','hostBootId','physicalInstanceId'] loop
        if jsonb_typeof(i->k) is distinct from 'string' or i->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
            raise exception 'Invalid outage termination identity' using errcode='22023'; end if;
    end loop;
    foreach k in array array['bootObservationSha256','predecessorConfigurationSha256','predecessorAdoptionReceiptSha256','originPreparationSha256','originAdoptionReceiptSha256'] loop
        if jsonb_typeof(i->k) is distinct from 'string' or i->>k !~ '^[0-9a-f]{64}$' then
            raise exception 'Invalid outage termination digest' using errcode='22023'; end if;
    end loop;
    if coalesce(i#>>'{command,commandId}','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(i#>>'{command,requestSha256}','') !~ '^[0-9a-f]{64}$' or i#>'{command,bootId}' is distinct from i->'bootId' then
        raise exception 'Invalid outage termination command' using errcode='22023'; end if;
    perform public.qorpera_runtime_office_outage_recovery_status(p_request->'recovery',p_executor_secret);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{recovery,recoveryId}')::uuid for update;
    if r.termination_receipt is not null then
        if r.termination_request is distinct from p_request then raise exception 'Outage termination cannot be rebound' using errcode='42501'; end if;
        return r.termination_receipt;
    end if;
    perform public.qorpera_check_runtime_office_outage_recovery(p_request->'recovery',p_executor_secret);
    select * into ch from public.qorpera_runtime_office_outage_termination_challenges where inspection_id=(i->>'inspectionId')::uuid for update;
    if not found or ch.recovery_id<>r.recovery_id or clock_timestamp()>=ch.expires_at then
        raise exception 'Outage termination challenge unavailable' using errcode='42501'; end if;
    perform public.qorpera_check_office_outage_running(r,ch.request->'observation');
    select * into strict o from public.qorpera_runtime_office_computer_outages where request_id=r.outage_request_id;
    select * into strict a from public.qorpera_runtime_office_activations where activation_id=o.activation_id;
    foreach k in array array['recoveryId','startCommandId','bootId','hostBootId','physicalInstanceId'] loop
        if i->k is distinct from ch.request#>array['observation',k] then
            raise exception 'Outage termination observation differs' using errcode='42501'; end if;
    end loop;
    if i->'bootObservationSha256' is distinct from ch.request->'bootObservationSha256'
        or i->'predecessorConfigurationSha256' is distinct from a.attestation->'configurationSha256'
        or i->'predecessorAdoptionReceiptSha256' is distinct from a.attestation->'adoptionReceiptSha256'
        or i#>'{command,commandId}' in (i->'inspectionId',i->'startCommandId') then
        raise exception 'Outage predecessor inspection differs' using errcode='42501'; end if;
    -- The new boot proves old execution ended; this records no flush, completed
    -- work, service stop or privacy handoff. Only the locked snapshot is ended.
    update public.qorpera_runtime_office_resources set state='drained',drained_at=clock_timestamp() where office_id=o.office_id and state<>'drained';
    update public.qorpera_runtime_office_viewers set state='ended',ended_at=clock_timestamp() where office_id=o.office_id and state<>'ended';
    update public.qorpera_runtime_office_screens set drain_pending=false,drain_acknowledged_at=clock_timestamp() where office_id=o.office_id and drain_pending;
    update public.qorpera_runtime_offices set revision=revision+1 where id=o.office_id returning * into c;
    if clock_timestamp()>=ch.expires_at then raise exception 'Outage termination inspection expired' using errcode='42501'; end if;
    v_receipt:=jsonb_build_object('schema','qorpera.office-outage-termination-acknowledgement/v1','request',p_request,
        'officeRevision',c.revision,'acknowledgedAtMs',floor(extract(epoch from clock_timestamp())*1000)::bigint);
    update public.qorpera_runtime_office_outage_recoveries set termination_request=p_request,termination_receipt=v_receipt where recovery_id=r.recovery_id;
    return v_receipt;
end $$;

create function public.qorpera_office_outage_recovery_snapshot(p_office public.qorpera_runtime_offices)
returns jsonb language sql stable set search_path='' as $$
    select jsonb_build_object('officeRevision',p_office.revision,'privacyState',p_office.privacy_state,
        'privacyVersion',p_office.privacy_version,'privacyChallenge',p_office.privacy_challenge,
        'drains',public.qorpera_runtime_office_pending_stop_drains(p_office),
        'resources',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.qorpera_runtime_office_resources r
            where r.office_id=p_office.id and r.state<>'drained'),'[]'::jsonb),
        'viewers',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from public.qorpera_runtime_office_viewers v
            where v.office_id=p_office.id and v.state<>'ended'),'[]'::jsonb))
$$;

-- No caller-selected company/provider authority: every scope comes from the
-- retained outage. Only the outer RPC may authenticate an enrolled host.
create function public.qorpera_lock_office_outage_recovery(p_request jsonb,p_live boolean)
returns public.qorpera_runtime_office_computer_outages language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_office_computer_outages%rowtype; a public.qorpera_runtime_office_activations%rowtype;
    c public.qorpera_runtime_offices%rowtype; p public.qorpera_coding_computer_permits%rowtype;
begin
    if auth.role() is distinct from 'service_role' or p_live is null then raise exception 'Office recovery provider required' using errcode='42501'; end if;
    perform public.qorpera_assert_office_outage_recovery_request(p_request);
    select * into o from public.qorpera_runtime_office_computer_outages where request_id=(p_request->>'outageRequestId')::uuid;
    if not found or o.receipt->>'state' is distinct from 'held' then raise exception 'Held office outage required' using errcode='42501'; end if;
    select * into strict p from public.qorpera_coding_computer_permits where id=o.permit_id;
    perform public.qorpera_assert_runtime_office_provider(o.request#>'{activation,startup,scope}',
        (o.request#>>'{activation,startup,computerGeneration}')::bigint,
        (o.request#>>'{activation,providerId}')::uuid,o.request#>>'{activation,providerPolicySha256}',p_live);
    select * into strict c from public.qorpera_runtime_offices where id=o.office_id;
    select * into strict a from public.qorpera_runtime_office_activations where activation_id=o.activation_id for update;
    if p_live and (a.superseded_at is not null or a.state<>'active' or c.state<>'maintenance'
        or c.generation<>a.computer_generation or c.image_sha256<>a.image_sha256 or c.bootstrap_sha256<>a.bootstrap_sha256
        or public.qorpera_company_execution_paused(c.profile_id)
        or not exists(select 1 from public.qorpera_company_files f where f.environment_id=c.environment_id and f.profile_id=c.profile_id and f.state='ready' and f.path_gateway_version=1)
        or not exists(select 1 from public.qorpera_logical_computers l where l.id=c.logical_computer_id and l.status='active' and public.qorpera_runtime_office_matches(l))
        or exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions where activation_id=a.activation_id)) then
        raise exception 'Office outage recovery unavailable' using errcode='42501'; end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id and id=a.allocation_id
        and office_id=c.id and profile_id=c.profile_id and computer_generation=c.generation and instance_sha256=a.instance_sha256
        and provider_adapter='lxd' and released_at is null for update;
    if not found then raise exception 'Office outage allocation unavailable' using errcode='42501'; end if;
    select * into strict p from public.qorpera_coding_computer_permits where id=o.permit_id for update;
    if p_live and p.state<>'closed' then raise exception 'Office outage allowance unsettled' using errcode='42501'; end if;
    return o;
end $$;

create function public.qorpera_runtime_office_outage_recovery_status(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_office_computer_outages%rowtype; r public.qorpera_runtime_office_outage_recoveries%rowtype;
begin
    perform public.qorpera_assert_office_outage_recovery_request(p_request);
    select * into strict o from public.qorpera_runtime_office_computer_outages where request_id=(p_request->>'outageRequestId')::uuid;
    perform public.qorpera_runtime_computer_permit_host(o.permit_id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=(o.request#>>'{activation,startup,scope,companyId}')::uuid for update;
    select * into r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request->>'recoveryId')::uuid for share;
    if not found or r.request is distinct from p_request or r.outage_request_id<>o.request_id then
        raise exception 'Office outage recovery identity unavailable' using errcode='42501'; end if;
    return r.receipt;
end $$;

create function public.qorpera_prepare_runtime_office_outage_recovery(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_office_computer_outages%rowtype; r public.qorpera_runtime_office_outage_recoveries%rowtype;
    c public.qorpera_runtime_offices%rowtype; snapshot jsonb; receipt jsonb;
begin
    perform public.qorpera_assert_office_outage_recovery_request(p_request);
    select * into strict o from public.qorpera_runtime_office_computer_outages where request_id=(p_request->>'outageRequestId')::uuid;
    perform public.qorpera_runtime_computer_permit_host(o.permit_id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=(o.request#>>'{activation,startup,scope,companyId}')::uuid for update;
    select * into r from public.qorpera_runtime_office_outage_recoveries where outage_request_id=o.request_id or recovery_id=(p_request->>'recoveryId')::uuid;
    if found then
        if r.request is distinct from p_request then raise exception 'Office outage recovery cannot be rebound' using errcode='42501'; end if;
        return r.receipt;
    end if;
    o:=public.qorpera_lock_office_outage_recovery(p_request,true);
    if exists(select 1 from public.qorpera_runtime_office_activations where activation_id=(p_request->>'activationId')::uuid)
        or exists(select 1 from public.qorpera_coding_computer_permits where id=(p_request->>'startCommandId')::uuid)
        or exists(select 1 from public.qorpera_computer_prestart_attempts where permit_id=(p_request->>'startCommandId')::uuid) then
        raise exception 'Office recovery successor identity reused' using errcode='42501'; end if;
    select * into strict c from public.qorpera_runtime_offices where id=o.office_id;
    snapshot:=public.qorpera_office_outage_recovery_snapshot(c);
    receipt:=jsonb_build_object('schema','qorpera.office-outage-recovery/v1','request',p_request,'predecessor',o.request->'activation',
        'state','prepared')||(snapshot-array['resources','viewers']);
    insert into public.qorpera_runtime_office_outage_recoveries(recovery_id,outage_request_id,activation_id,start_command_id,request,receipt,snapshot)
        values((p_request->>'recoveryId')::uuid,o.request_id,(p_request->>'activationId')::uuid,(p_request->>'startCommandId')::uuid,p_request,receipt,snapshot);
    return receipt;
end $$;

create function public.qorpera_check_runtime_office_outage_recovery(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt jsonb; o public.qorpera_runtime_office_computer_outages%rowtype; r public.qorpera_runtime_office_outage_recoveries%rowtype;
begin
    receipt:=public.qorpera_runtime_office_outage_recovery_status(p_request,p_executor_secret);
    o:=public.qorpera_lock_office_outage_recovery(p_request,true);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request->>'recoveryId')::uuid;
    if r.termination_receipt is not null or r.successor_request is not null or r.snapshot is distinct from
        public.qorpera_office_outage_recovery_snapshot((select c from public.qorpera_runtime_offices c where id=o.office_id)) then
        raise exception 'Office outage recovery snapshot changed' using errcode='42501'; end if;
    return jsonb_build_object('schema','qorpera.office-outage-recovery-authority/v1','recovery',receipt,'validForMs',5000);
end $$;

create function public.qorpera_check_runtime_office_outage_configuration(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_outage_recoveries%rowtype; o public.qorpera_runtime_office_computer_outages%rowtype;
    c public.qorpera_runtime_offices%rowtype; a public.qorpera_runtime_office_activations%rowtype;
    ch public.qorpera_runtime_office_outage_termination_challenges%rowtype;
begin
    if not public.qorpera_screen_metadata_object(p_request,array['recovery','termination']) then
        raise exception 'Invalid office outage configuration request' using errcode='22023'; end if;
    perform public.qorpera_runtime_office_outage_recovery_status(p_request->'recovery',p_executor_secret);
    o:=public.qorpera_lock_office_outage_recovery(p_request->'recovery',true);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{recovery,recoveryId}')::uuid;
    if r.termination_receipt is null or r.termination_receipt is distinct from p_request->'termination' or r.successor_request is not null then
        raise exception 'Office outage configuration predecessor differs' using errcode='42501'; end if;
    select * into strict a from public.qorpera_runtime_office_activations where activation_id=o.activation_id;
    perform public.qorpera_check_runtime_office_restart_surfaces(a);
    select * into strict c from public.qorpera_runtime_offices where id=o.office_id;
    if to_jsonb(c.revision) is distinct from r.termination_receipt->'officeRevision'
        or c.privacy_state is distinct from r.snapshot->>'privacyState'
        or to_jsonb(c.privacy_version) is distinct from r.snapshot->'privacyVersion'
        or c.privacy_challenge is distinct from r.snapshot->'privacyChallenge' then
        raise exception 'Office outage configuration snapshot changed' using errcode='42501'; end if;
    select * into strict ch from public.qorpera_runtime_office_outage_termination_challenges where inspection_id=(r.termination_request#>>'{inspection,inspectionId}')::uuid;
    perform public.qorpera_check_office_outage_running(r,ch.request->'observation');
    return jsonb_build_object('schema','qorpera.office-outage-configuration-authority/v1','recovery',r.receipt,'termination',r.termination_receipt,'validForMs',5000);
end $$;

create function public.qorpera_assert_office_outage_successor_request(p_request jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
    if not public.qorpera_screen_metadata_object(p_request,array['schema','recovery','attestation','termination'])
        or p_request->>'schema' is distinct from 'qorpera.office-outage-successor-request/v1'
        or octet_length(p_request::text)>65536 then raise exception 'Invalid office outage successor request' using errcode='22023'; end if;
    perform public.qorpera_assert_office_outage_recovery_request(p_request->'recovery');
    perform public.qorpera_assert_runtime_office_activation_attestation(p_request->'attestation');
    if p_request#>'{attestation,activationId}' is distinct from p_request#>'{recovery,activationId}' then
        raise exception 'Office outage successor identity differs' using errcode='42501'; end if;
end $$;

create function public.qorpera_office_outage_successor_result(p_recovery public.qorpera_runtime_office_outage_recoveries)
returns jsonb language sql volatile set search_path='' as $$
    select jsonb_build_object('schema','qorpera.office-outage-successor/v1','request',p_recovery.successor_request,
        'state',a.state,'serviceInvocationId',a.service_invocation_id,
        'readinessFresh',a.ready_at is not null and a.ready_at>clock_timestamp()-interval '5 seconds',
        'officeRevision',p_recovery.successor_revision,'privacyVersion',p_recovery.snapshot->'privacyVersion')
    from public.qorpera_runtime_office_activations a where a.activation_id=p_recovery.activation_id
$$;

create function public.qorpera_runtime_office_outage_successor_status(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_outage_recoveries%rowtype;
begin
    perform public.qorpera_assert_office_outage_successor_request(p_request);
    perform public.qorpera_runtime_office_outage_recovery_status(p_request->'recovery',p_executor_secret);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{recovery,recoveryId}')::uuid;
    if r.successor_request is distinct from p_request then raise exception 'Office outage successor unavailable' using errcode='42501'; end if;
    return public.qorpera_office_outage_successor_result(r);
end $$;

create function public.qorpera_check_office_outage_successor_startup(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_outage_recoveries%rowtype; c public.qorpera_runtime_offices%rowtype;
    o public.qorpera_runtime_office_computer_outages%rowtype; ch public.qorpera_runtime_office_outage_termination_challenges%rowtype;
begin
    perform public.qorpera_check_runtime_office_restart_surfaces(p_activation);
    select * into r from public.qorpera_runtime_office_outage_recoveries where activation_id=p_activation.activation_id for share;
    select * into strict c from public.qorpera_runtime_offices where id=p_activation.office_id;
    select * into o from public.qorpera_runtime_office_computer_outages where request_id=r.outage_request_id;
    select * into ch from public.qorpera_runtime_office_outage_termination_challenges where inspection_id=(r.termination_request#>>'{inspection,inspectionId}')::uuid;
    if r.successor_request is null or r.termination_receipt is null or ch.recovery_id is distinct from r.recovery_id
        or r.successor_request->'attestation' is distinct from p_activation.attestation
        or p_activation.predecessor_activation_id is distinct from o.activation_id or p_activation.superseded_at is not null
        or c.revision is distinct from r.successor_revision
        or c.privacy_state is distinct from r.snapshot->>'privacyState'
        or to_jsonb(c.privacy_version) is distinct from r.snapshot->'privacyVersion'
        or c.privacy_challenge is distinct from r.snapshot->'privacyChallenge' then
        raise exception 'Outage successor snapshot changed' using errcode='42501'; end if;
    perform public.qorpera_check_office_outage_running(r,ch.request->'observation');
end $$;

-- Ordinary successors still require their actual stop FK. Outage successors
-- use their own acknowledged termination chain at every shared startup gate.
do $$ declare d text:=pg_get_functiondef('public.qorpera_check_runtime_office_successor_startup(public.qorpera_runtime_office_activations)'::regprocedure); begin
    execute replace(d,'FUNCTION public.qorpera_check_runtime_office_successor_startup(',
        'FUNCTION public.qorpera_check_office_successor_startup_before_outage(');
end $$;
create or replace function public.qorpera_check_runtime_office_successor_startup(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path='' as $$
begin
    if exists(select 1 from public.qorpera_runtime_office_outage_recoveries where activation_id=p_activation.activation_id) then
        perform public.qorpera_check_office_outage_successor_startup(p_activation);
    else
        perform public.qorpera_check_office_successor_startup_before_outage(p_activation);
    end if;
end $$;

create function public.qorpera_prepare_runtime_office_outage_successor(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_outage_recoveries%rowtype; o public.qorpera_runtime_office_computer_outages%rowtype;
    a public.qorpera_runtime_office_activations%rowtype; n public.qorpera_runtime_office_activations%rowtype;
    c public.qorpera_runtime_offices%rowtype; ch public.qorpera_runtime_office_outage_termination_challenges%rowtype; k text;
begin
    perform public.qorpera_assert_office_outage_successor_request(p_request);
    perform public.qorpera_runtime_office_outage_recovery_status(p_request->'recovery',p_executor_secret);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{recovery,recoveryId}')::uuid;
    if r.successor_request is not null then
        if r.successor_request is distinct from p_request then raise exception 'Outage successor cannot be rebound' using errcode='42501'; end if;
        return public.qorpera_office_outage_successor_result(r);
    end if;
    o:=public.qorpera_lock_office_outage_recovery(p_request->'recovery',true);
    if r.termination_receipt is null or r.termination_receipt is distinct from p_request->'termination' then
        raise exception 'Outage termination unacknowledged' using errcode='42501'; end if;
    select * into strict a from public.qorpera_runtime_office_activations where activation_id=o.activation_id;
    select * into strict ch from public.qorpera_runtime_office_outage_termination_challenges where inspection_id=(r.termination_request#>>'{inspection,inspectionId}')::uuid;
    perform public.qorpera_check_office_outage_running(r,ch.request->'observation');
    perform public.qorpera_check_runtime_office_restart_surfaces(a);
    select * into strict c from public.qorpera_runtime_offices where id=o.office_id;
    if to_jsonb(c.revision) is distinct from r.termination_receipt->'officeRevision'
        or c.privacy_state is distinct from r.snapshot->>'privacyState'
        or to_jsonb(c.privacy_version) is distinct from r.snapshot->'privacyVersion'
        or c.privacy_challenge is distinct from r.snapshot->'privacyChallenge'
        or p_request#>'{attestation,bootId}' is distinct from ch.request#>'{observation,bootId}'
        or exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=a.allocation_id and attestation->'bootId'=p_request#>'{attestation,bootId}')
        or p_request#>'{attestation,nativePort}' is distinct from a.attestation->'nativePort'
        or p_request#>'{attestation,viewerPort}' is distinct from a.attestation->'viewerPort'
        or p_request#>'{attestation,preparationObservationSha256}' is distinct from ch.request->'bootObservationSha256' then
        raise exception 'Outage successor predecessor differs' using errcode='42501'; end if;
    foreach k in array array['preparationObservationSha256','configurationObservationSha256','configurationSha256','adoptionReceiptSha256'] loop
        if p_request->'attestation'->k=a.attestation->k then raise exception 'Outage successor requires fresh observations' using errcode='42501'; end if;
    end loop;
    update public.qorpera_runtime_office_activations set superseded_at=clock_timestamp() where activation_id=a.activation_id;
    insert into public.qorpera_runtime_office_activations(intent_id,activation_id,office_id,computer_generation,allocation_id,provider_id,
        provider_policy_sha256,provider_binding_sha256,instance_sha256,image_sha256,bootstrap_sha256,attestation,mappings,state,predecessor_activation_id)
        values(a.intent_id,r.activation_id,a.office_id,a.computer_generation,a.allocation_id,a.provider_id,a.provider_policy_sha256,
            a.provider_binding_sha256,a.instance_sha256,a.image_sha256,a.bootstrap_sha256,p_request->'attestation',a.mappings,'prepared',a.activation_id)
        returning * into n;
    update public.qorpera_runtime_office_outage_recoveries set successor_request=p_request,successor_revision=c.revision where recovery_id=r.recovery_id returning * into r;
    perform public.qorpera_check_runtime_office_successor_startup(n);
    return public.qorpera_office_outage_successor_result(r);
end $$;

create function public.qorpera_check_runtime_office_outage_successor(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_outage_recoveries%rowtype; a public.qorpera_runtime_office_activations%rowtype; result jsonb;
begin
    result:=public.qorpera_runtime_office_outage_successor_status(p_request,p_executor_secret);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{recovery,recoveryId}')::uuid;
    perform public.qorpera_assert_runtime_office_provider(r.receipt#>'{predecessor,startup,scope}',
        (r.receipt#>>'{predecessor,startup,computerGeneration}')::bigint,(r.receipt#>>'{predecessor,providerId}')::uuid,
        r.receipt#>>'{predecessor,providerPolicySha256}',false);
    select * into strict a from public.qorpera_runtime_office_activations where activation_id=r.activation_id for share;
    if a.superseded_at is not null then raise exception 'Outage successor superseded' using errcode='42501'; end if;
    if a.state='active' then
        perform public.qorpera_check_runtime_office_guest_binding(r.receipt#>'{predecessor,startup,scope}',a.computer_generation,
            a.allocation_id,a.instance_sha256,a.image_sha256,a.bootstrap_sha256);
    else perform public.qorpera_check_runtime_office_successor_startup(a); end if;
    return jsonb_build_object('schema','qorpera.office-outage-successor-authority/v1','successor',result,'validForMs',5000);
end $$;

create function public.qorpera_activate_runtime_office_outage_successor(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.qorpera_runtime_office_outage_recoveries%rowtype; a public.qorpera_runtime_office_activations%rowtype;
begin
    if not public.qorpera_screen_metadata_object(p_request,array['successor','serviceInvocationId'])
        or coalesce(p_request->>'serviceInvocationId','') !~ '^[0-9a-f]{32}$' or p_request->>'serviceInvocationId'=repeat('0',32) then
        raise exception 'Invalid outage successor activation' using errcode='22023'; end if;
    perform public.qorpera_check_runtime_office_outage_successor(p_request->'successor',p_executor_secret);
    select * into strict r from public.qorpera_runtime_office_outage_recoveries where recovery_id=(p_request#>>'{successor,recovery,recoveryId}')::uuid;
    select * into strict a from public.qorpera_runtime_office_activations where activation_id=r.activation_id;
    perform public.qorpera_activate_runtime_office(r.receipt#>'{predecessor,startup,scope}',a.computer_generation,a.intent_id,
        a.activation_id,a.provider_id,a.provider_policy_sha256,p_request->>'serviceInvocationId');
    -- An idle wake may have admitted its successor before the provider lost
    -- power, without recording the idle reconciliation suffix. The admitted
    -- outage successor supersedes that historical cycle, never a newer cycle
    -- or one inferred solely from timestamps. Follow immutable activation FKs.
    with recursive ancestors as (
        select activation_id,predecessor_activation_id from public.qorpera_runtime_office_activations
            where activation_id=(r.receipt#>>'{predecessor,activationId}')::uuid
                and office_id=a.office_id and computer_generation=a.computer_generation
        union
        select previous.activation_id,previous.predecessor_activation_id
            from public.qorpera_runtime_office_activations previous join ancestors n on previous.activation_id=n.predecessor_activation_id
            where previous.office_id=a.office_id and previous.computer_generation=a.computer_generation
    )
    update public.qorpera_runtime_office_idle_cycles c set superseded_at=clock_timestamp()
        where c.office_id=a.office_id and c.computer_generation=a.computer_generation and c.superseded_at is null
            and exists(select 1 from public.qorpera_runtime_office_successors s join ancestors n on n.activation_id=s.activation_id
                where s.transition_id=c.transition_id);
    return public.qorpera_runtime_office_outage_successor_status(p_request->'successor',p_executor_secret);
end $$;

alter table public.qorpera_runtime_office_outage_recoveries enable row level security;
alter table public.qorpera_runtime_office_outage_termination_challenges enable row level security;
revoke all on public.qorpera_runtime_office_outage_recoveries,public.qorpera_runtime_office_outage_termination_challenges
    from public,anon,authenticated,service_role,qorpera_secret_broker;
do $$ declare f regprocedure; begin
    for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in (
            'qorpera_assert_office_outage_recovery_request','qorpera_office_outage_recovery_snapshot','qorpera_lock_office_outage_recovery',
            'qorpera_runtime_office_outage_recovery_status','qorpera_prepare_runtime_office_outage_recovery','qorpera_check_runtime_office_outage_recovery',
            'qorpera_authorize_paid_office_start_before_outage','qorpera_check_office_outage_running',
            'qorpera_prepare_runtime_office_outage_termination','qorpera_ack_runtime_office_outage_termination',
            'qorpera_check_runtime_office_outage_configuration',
            'qorpera_assert_office_outage_successor_request','qorpera_office_outage_successor_result','qorpera_runtime_office_outage_successor_status',
            'qorpera_check_office_outage_successor_startup','qorpera_check_office_successor_startup_before_outage',
            'qorpera_prepare_runtime_office_outage_successor','qorpera_check_runtime_office_outage_successor','qorpera_activate_runtime_office_outage_successor') loop
        execute format('revoke all on function %s from public,anon,authenticated,service_role,qorpera_secret_broker',f);
    end loop;
end $$;
grant execute on function public.qorpera_runtime_office_outage_recovery_status(jsonb,text),
    public.qorpera_prepare_runtime_office_outage_recovery(jsonb,text),public.qorpera_check_runtime_office_outage_recovery(jsonb,text),
    public.qorpera_prepare_runtime_office_outage_termination(jsonb,text),public.qorpera_ack_runtime_office_outage_termination(jsonb,text),
    public.qorpera_check_runtime_office_outage_configuration(jsonb,text),
    public.qorpera_runtime_office_outage_successor_status(jsonb,text),public.qorpera_prepare_runtime_office_outage_successor(jsonb,text),
    public.qorpera_check_runtime_office_outage_successor(jsonb,text),public.qorpera_activate_runtime_office_outage_successor(jsonb,text) to service_role;

-- Preserve split hosted SECURITY DEFINER ownership. Grant only direct private
-- call edges, never the helper API to service_role.
do $$ declare edge text[]; caller_owner name; begin
    foreach edge slice 1 in array array[
        array['qorpera_authorize_paid_office_start(jsonb)','qorpera_authorize_paid_office_start_before_outage(jsonb)'],
        array['qorpera_authorize_paid_office_start(jsonb)','qorpera_lock_office_outage_recovery(jsonb,boolean)'],
        array['qorpera_authorize_paid_office_start(jsonb)','qorpera_office_outage_recovery_snapshot(public.qorpera_runtime_offices)'],
        array['qorpera_check_runtime_office_successor_startup(public.qorpera_runtime_office_activations)','qorpera_check_office_outage_successor_startup(public.qorpera_runtime_office_activations)'],
        array['qorpera_check_runtime_office_successor_startup(public.qorpera_runtime_office_activations)','qorpera_check_office_successor_startup_before_outage(public.qorpera_runtime_office_activations)'],
        array['qorpera_lock_office_outage_recovery(jsonb,boolean)','qorpera_assert_runtime_office_provider(jsonb,bigint,uuid,text,boolean)'],
        array['qorpera_office_outage_recovery_snapshot(public.qorpera_runtime_offices)','qorpera_runtime_office_pending_stop_drains(public.qorpera_runtime_offices)'],
        array['qorpera_assert_office_outage_successor_request(jsonb)','qorpera_assert_runtime_office_activation_attestation(jsonb)'],
        array['qorpera_check_office_outage_successor_startup(public.qorpera_runtime_office_activations)','qorpera_check_runtime_office_restart_surfaces(public.qorpera_runtime_office_activations)'],
        array['qorpera_prepare_runtime_office_outage_successor(jsonb,text)','qorpera_check_runtime_office_restart_surfaces(public.qorpera_runtime_office_activations)'],
        array['qorpera_check_runtime_office_outage_configuration(jsonb,text)','qorpera_check_runtime_office_restart_surfaces(public.qorpera_runtime_office_activations)'],
        array['qorpera_prepare_runtime_office_outage_successor(jsonb,text)','qorpera_check_runtime_office_successor_startup(public.qorpera_runtime_office_activations)'],
        array['qorpera_check_runtime_office_outage_successor(jsonb,text)','qorpera_check_runtime_office_successor_startup(public.qorpera_runtime_office_activations)'],
        array['qorpera_runtime_office_outage_recovery_status(jsonb,text)','qorpera_runtime_computer_permit_host(uuid,text)'],
        array['qorpera_prepare_runtime_office_outage_recovery(jsonb,text)','qorpera_runtime_computer_permit_host(uuid,text)']
    ] loop
        select pg_get_userbyid(proowner) into strict caller_owner from pg_proc where oid=('public.'||edge[1])::regprocedure;
        if caller_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Outage authority requires trusted owner'; end if;
        execute format('grant execute on function public.%s to %I',edge[2],caller_owner);
    end loop;
end $$;
