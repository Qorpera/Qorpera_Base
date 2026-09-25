-- Operator enrollment only. Runtime guests also possess the service role, so
-- it is not sufficient authority to operate a paid physical-computer permit.
create table public.qorpera_computer_executor_keys (
    id uuid primary key default extensions.gen_random_uuid(),
    environment_id uuid not null references public.qorpera_company_environments(id),
    owner text not null,
    machine_id_sha256 text not null check(machine_id_sha256 ~ '^[0-9a-f]{64}$'),
    key_sha256 text not null unique check(key_sha256 ~ '^[0-9a-f]{64}$'),
    revoked_at timestamptz,
    created_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_coding_computer_permits (
    id uuid primary key,
    allocation_id uuid not null references public.qorpera_runtime_machine_allocations(id),
    profile_id uuid not null references public.qorpera_profiles(id),
    node_id uuid not null references public.qorpera_runtime_nodes(id),
    instance_sha256 text not null,
    epoch uuid not null,
    host_boot_id uuid not null,
    physical_id uuid,
    guest_boot_id uuid,
    state text not null check(state in ('prepared','bound','closed')),
    generation bigint not null check(generation>0),
    last_sample jsonb,
    closed_at timestamptz,
    foreign key(allocation_id,epoch) references public.qorpera_computer_usage_streams(allocation_id,epoch),
    check((state='closed')=(closed_at is not null))
);
create unique index qorpera_coding_computer_one_permit on public.qorpera_coding_computer_permits(allocation_id) where state<>'closed';
create table public.qorpera_coding_computer_windows (
    permit_id uuid not null references public.qorpera_coding_computer_permits(id),
    generation bigint not null,
    reservation_id uuid not null unique references public.qorpera_computer_allowance_reservations(id),
    issued_at timestamptz not null,
    deadline timestamptz not null,
    window_ms integer not null check(window_ms between 30000 and 300000),
    stop_reserve_ms integer not null check(stop_reserve_ms between 30000 and 60000),
    primary key(permit_id,generation),
    check(deadline>issued_at)
);
create table public.qorpera_coding_computer_commands (
    request_id uuid primary key,
    action text not null check(action in ('prepare','renew','finish')),
    request jsonb not null,
    permit_id uuid not null references public.qorpera_coding_computer_permits(id),
    generation bigint not null,
    created_at timestamptz not null default clock_timestamp(),
    foreign key(permit_id,generation) references public.qorpera_coding_computer_windows(permit_id,generation)
);
create table public.qorpera_coding_computer_samples (
    permit_id uuid not null references public.qorpera_coding_computer_permits(id),
    observation_id uuid not null,
    generation bigint not null,
    sample jsonb not null,
    sequence bigint not null,
    coverage text not null check(coverage in ('initial','continuous','gap','terminal')),
    created_at timestamptz not null default clock_timestamp(),
    primary key(permit_id,observation_id),
    foreign key(permit_id,generation) references public.qorpera_coding_computer_windows(permit_id,generation)
);

-- Legacy service-role entry points must not mutate protected paid epochs or
-- free their holds. Internal calls use private implementations, never a GUC
-- flag that a guest could set itself.
alter function public.qorpera_record_computer_usage_checkpoint(uuid,text,uuid,bigint,bigint,bigint,timestamptz,boolean,text,text)
    rename to qorpera_record_computer_usage_checkpoint_internal;
alter function public.qorpera_reserve_computer_allowance(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz)
    rename to qorpera_reserve_computer_allowance_internal;
alter function public.qorpera_settle_computer_allowance(uuid,bigint) rename to qorpera_settle_computer_allowance_internal;
create function public.qorpera_record_computer_usage_checkpoint(p_allocation_id uuid,p_instance_sha256 text,p_epoch uuid,
    p_sequence bigint,p_elapsed_ms bigint,p_active_ms bigint,p_observed_at timestamptz,p_closed boolean,p_resource_kind text,p_evidence_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
    perform 1 from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
    if exists(select 1 from public.qorpera_coding_computer_permits where allocation_id=p_allocation_id and epoch=p_epoch) then
        raise exception 'Paid checkpoint requires executor custody' using errcode='42501'; end if;
    return public.qorpera_record_computer_usage_checkpoint_internal(p_allocation_id,p_instance_sha256,p_epoch,p_sequence,p_elapsed_ms,p_active_ms,p_observed_at,p_closed,p_resource_kind,p_evidence_sha256);
end $$;
create function public.qorpera_reserve_computer_allowance(p_reservation_id uuid,p_profile_id uuid,p_requested_by_user_id uuid,
    p_preferred_user_id uuid,p_allocation_id uuid,p_epoch uuid,p_amount_us bigint,p_deadline timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
    perform 1 from public.qorpera_profiles where id=p_profile_id for update;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
    if exists(select 1 from public.qorpera_coding_computer_permits where allocation_id=p_allocation_id and epoch=p_epoch) then
        raise exception 'Paid reservation requires executor custody' using errcode='42501'; end if;
    return public.qorpera_reserve_computer_allowance_internal(p_reservation_id,p_profile_id,p_requested_by_user_id,p_preferred_user_id,p_allocation_id,p_epoch,p_amount_us,p_deadline);
end $$;
create function public.qorpera_settle_computer_allowance(p_reservation_id uuid,p_through_sequence bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_profile uuid;
begin
    select profile_id into strict v_profile from public.qorpera_computer_allowance_reservations where id=p_reservation_id;
    perform 1 from public.qorpera_profiles where id=v_profile for update;
    if exists(select 1 from public.qorpera_coding_computer_windows where reservation_id=p_reservation_id) then
        raise exception 'Paid settlement requires executor custody' using errcode='42501'; end if;
    return public.qorpera_settle_computer_allowance_internal(p_reservation_id,p_through_sequence);
end $$;
alter function public.qorpera_observe_computer_usage(jsonb) rename to qorpera_observe_computer_usage_shadow_internal;
create function public.qorpera_observe_computer_usage(p_sample jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_profile uuid;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Observer authority required' using errcode='42501'; end if;
    select profile_id into v_profile from public.qorpera_runtime_machine_allocations
        where id=(p_sample->>'allocationId')::uuid and coding_machine_id is not null;
    if v_profile is not null and (public.qorpera_company_paid_computer_mode(v_profile) or exists(select 1 from public.qorpera_coding_computer_permits
        where allocation_id=(p_sample->>'allocationId')::uuid and state<>'closed')) then
        return jsonb_build_object('observationId',p_sample->>'observationId','recorded',false,'charged',false,'reason','paid_meter_owned');
    end if;
    return public.qorpera_observe_computer_usage_shadow_internal(p_sample);
end $$;

create function public.qorpera_computer_executor_machine(p_machine_id uuid,p_executor_secret text)
returns public.qorpera_coding_machines language plpgsql security definer set search_path='' as $$
declare m public.qorpera_coding_machines%rowtype;
begin
    if auth.role() is distinct from 'service_role' or p_executor_secret is null or octet_length(p_executor_secret) not between 32 and 512 then
        raise exception 'Dedicated computer executor authority required' using errcode='42501'; end if;
    select * into m from public.qorpera_coding_machines where id=p_machine_id;
    if not found or m.kind<>'member' or not exists(select 1 from public.qorpera_computer_executor_keys where environment_id=m.environment_id
        and owner=m.owner and machine_id_sha256=m.machine_id_sha256 and revoked_at is null
        and key_sha256=encode(extensions.digest(convert_to(p_executor_secret,'UTF8'),'sha256'),'hex')) then
        raise exception 'Dedicated computer executor authority required' using errcode='42501'; end if;
    return m;
end $$;

create function public.qorpera_computer_permit_receipt(p_permit_id uuid,p_generation bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; w public.qorpera_coding_computer_windows%rowtype;
    s public.qorpera_computer_usage_streams%rowtype;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=p_permit_id;
    select * into strict w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=p_generation;
    select * into strict s from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch;
    return jsonb_build_object('schema','qorpera.computer-usage-permit/v1','mode','paid','permitId',p.id,'allocationId',p.allocation_id,
        'instanceSha256',p.instance_sha256,'nodeId',p.node_id,'epoch',p.epoch,'generation',w.generation,'reservationId',w.reservation_id,
        'hostBootId',p.host_boot_id,'guestBootId',p.guest_boot_id,'physicalId',p.physical_id,'state',p.state,
        'issuedAt',w.issued_at,'deadline',w.deadline,'validForMs',case when p.state='closed' then 0 else greatest(0,floor(extract(epoch from w.deadline-clock_timestamp())*1000))::bigint end,
        'windowMs',w.window_ms,'stopReserveMs',w.stop_reserve_ms,'tariffVersion',s.tariff_version,
        'cpuMillis',(s.resource_shape->>'cpuMillis')::bigint,'memoryBytes',(s.resource_shape->>'memoryBytes')::bigint);
end $$;

create function public.qorpera_prepare_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.qorpera_coding_machines%rowtype; session public.qorpera_coding_sessions%rowtype;
    d public.qorpera_runtime_node_demands%rowtype; c public.qorpera_coding_computer_commands%rowtype;
    tariff public.qorpera_computer_tariff_versions%rowtype; v_id uuid; v_epoch uuid; v_now timestamptz; v_deadline timestamptz;
    v_normal jsonb; v_amount bigint; v_window integer; v_margin integer;
begin
    if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>20000
        or p_request->>'schema' is distinct from 'qorpera.coding-computer-prepare/v1'
        or not p_request ?& array['requestId','workerId','leaseToken','machineId','owner','bindingText','machineIdSha256','hostBootId','windowMs','stopReserveMs']
        or (select count(*) from jsonb_object_keys(p_request))<>11 or exists(select 1 from jsonb_each_text(p_request) field where field.value is null) then
        raise exception 'Invalid permit request' using errcode='22023'; end if;
    m:=public.qorpera_computer_executor_machine((p_request->>'machineId')::uuid,p_executor_secret);
    if m.owner is distinct from p_request->>'owner' or m.machine_id_sha256 is distinct from p_request->>'machineIdSha256'
        or m.binding is distinct from (p_request->>'bindingText')::jsonb or m.instance_sha256 is distinct from encode(extensions.digest(convert_to(p_request->>'bindingText','UTF8'),'sha256'),'hex') then
        raise exception 'Computer binding differs' using errcode='42501'; end if;
    perform 1 from public.qorpera_profiles where id=m.profile_id for update;
    v_id:=(p_request->>'requestId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;
    if found then
        if c.action<>'prepare' or c.request<>p_request then raise exception 'Permit request replay differs' using errcode='23505'; end if;
        return public.qorpera_computer_permit_receipt(c.permit_id,c.generation);
    end if;
    if not public.qorpera_company_paid_computer_mode(m.profile_id) then raise exception 'Company paid mode not enabled' using errcode='55000'; end if;
    session:=public.qorpera_coding_leased_session((p_request->>'workerId')::uuid,(p_request->>'leaseToken')::uuid);
    if session.lease_token is null or session.lease_until is null or session.lease_until<=clock_timestamp()
        or session.vm_allocation_id is distinct from m.id or session.lease_owner is distinct from m.owner or session.profile_id<>m.profile_id
        or not exists(select 1 from public.qorpera_runtime_workers where id=session.worker_id and owner_user_id=m.member_user_id and state='active') then
        raise exception 'Current coding worker authority required' using errcode='42501'; end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=m.id and coding_machine_id=m.id and instance_sha256=m.instance_sha256 and released_at is null for update;
    if not found or m.removing_at is not null or m.removed_at is not null then raise exception 'Coding allocation unavailable' using errcode='42501'; end if;
    select * into d from public.qorpera_runtime_node_demands where allocation_id=m.id and provider_kind='coding'
        and provider_id=m.binding->>'providerId' and policy_sha256=m.binding->>'providerPolicySha256'
        and reserved_at is not null and released_at is null and suspended_at is null and last_refusal is null
        and last_checked_at>=clock_timestamp()-interval '5 seconds' for update;
    if not found or not exists(select 1 from public.qorpera_runtime_nodes where id=d.node_id and machine_id_sha256=m.machine_id_sha256 and enabled) then
        raise exception 'Admitted computer resource shape required' using errcode='42501'; end if;
    if exists(select 1 from public.qorpera_computer_usage_streams where allocation_id=m.id and not closed) then
        raise exception 'Computer already has an epoch; recover or adopt explicitly' using errcode='55000'; end if;
    v_window:=(p_request->>'windowMs')::integer; v_margin:=(p_request->>'stopReserveMs')::integer;
    if v_window is null or v_window not between 30000 and 300000 or v_margin is null or v_margin not between 30000 and 60000
        or p_request->>'hostBootId' is null then raise exception 'Bounded computer permit window required' using errcode='22023'; end if;
    v_now:=clock_timestamp(); v_deadline:=v_now+make_interval(secs=>(v_window+v_margin)::double precision/1000); v_epoch:=extensions.gen_random_uuid();
    perform public.qorpera_record_computer_usage_checkpoint_internal(m.id,m.instance_sha256,v_epoch,0,0,0,v_now,false,'coding_machine',
        encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex'));
    select * into strict tariff from public.qorpera_computer_tariff_versions where version=(select tariff_version from public.qorpera_computer_billing_readiness);
    v_normal:=public.qorpera_standard_computer_time(v_window+v_margin,d.cpu_millis,d.memory_bytes,'coding_machine',tariff.reference_cpu_millis,tariff.reference_memory_bytes);
    v_amount:=ceil((v_normal->>'numerator')::numeric*1000/(v_normal->>'denominator')::numeric)::bigint;
    perform public.qorpera_reserve_computer_allowance_internal(v_id,m.profile_id,m.member_user_id,null,m.id,v_epoch,v_amount,v_deadline);
    insert into public.qorpera_coding_computer_permits values(v_id,m.id,m.profile_id,d.node_id,m.instance_sha256,v_epoch,(p_request->>'hostBootId')::uuid,null,null,'prepared',1,null,null);
    insert into public.qorpera_coding_computer_windows values(v_id,1,v_id,v_now,v_deadline,v_window,v_margin);
    insert into public.qorpera_coding_computer_commands(request_id,action,request,permit_id,generation) values(v_id,'prepare',p_request,v_id,1);
    return public.qorpera_computer_permit_receipt(v_id,1);
end $$;

create function public.qorpera_describe_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.qorpera_coding_machines%rowtype; p public.qorpera_coding_computer_permits%rowtype;
begin
    m:=public.qorpera_computer_executor_machine((p_request->>'machineId')::uuid,p_executor_secret);
    if m.owner is distinct from p_request->>'owner' or m.machine_id_sha256 is distinct from p_request->>'machineIdSha256' then
        raise exception 'Computer executor identity differs' using errcode='42501'; end if;
    select * into p from public.qorpera_coding_computer_permits where allocation_id=m.id
        and (case when p_request->>'permitId' is null then state<>'closed' else id=(p_request->>'permitId')::uuid end) order by generation desc limit 1;
    if not found then return null; end if;
    return jsonb_build_object('permit',public.qorpera_computer_permit_receipt(p.id,p.generation),'lastSample',p.last_sample,
        'hostBootMatches',p.host_boot_id=(p_request->>'hostBootId')::uuid);
end $$;

-- Apply a sample only under dedicated executor authority. The API never accepts
-- caller-selected billable time. First observation and unknown gaps charge zero.
create function public.qorpera_apply_coding_computer_sample(p_permit_id uuid,p_generation bigint,p_sample jsonb,p_terminal boolean)
returns bigint language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; w public.qorpera_coding_computer_windows%rowtype;
    s public.qorpera_computer_usage_streams%rowtype; old public.qorpera_coding_computer_samples%rowtype;
    v_time timestamptz; v_host bigint; v_guest bigint; v_delta bigint:=0; v_elapsed bigint:=0; v_sequence bigint;
    v_host_delta bigint; v_guest_delta bigint; v_wall numeric; v_coverage text:='gap';
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=p_permit_id for update;
    if p_sample is null or jsonb_typeof(p_sample)<>'object' or octet_length(p_sample::text)>4096 or (select count(*) from jsonb_object_keys(p_sample))<>10
        or not p_sample ?& array['observationId','previousObservationId','hostBootId','hostUptimeMs','physicalId','guestBootId','guestUptimeMs','observedAt','state','evidenceSha256']
        or coalesce(p_sample->>'state','') not in ('running','gap','stopped','absent') or coalesce(p_sample->>'evidenceSha256','') !~ '^[0-9a-f]{64}$'
        or p_sample->>'observationId' is null or p_sample->>'hostBootId' is null or p_sample->>'observedAt' is null
        or coalesce(p_sample->>'hostUptimeMs','') !~ '^(0|[1-9][0-9]{0,15})$' then raise exception 'Invalid physical computer sample' using errcode='22023'; end if;
    select * into old from public.qorpera_coding_computer_samples where permit_id=p.id and observation_id=(p_sample->>'observationId')::uuid;
    if found then
        if old.sample<>p_sample or old.generation<>p_generation then raise exception 'Paid sample replay differs' using errcode='23505'; end if;
        return old.sequence;
    end if;
    if p.state='closed' or p_generation is distinct from p.generation then raise exception 'Computer permit generation unavailable' using errcode='40001'; end if;
    select * into strict w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=p_generation;
    select * into strict s from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch for update;
    v_time:=(p_sample->>'observedAt')::timestamptz; v_host:=(p_sample->>'hostUptimeMs')::bigint; v_guest:=(p_sample->>'guestUptimeMs')::bigint;
    if not isfinite(v_time) or v_time>clock_timestamp()+interval '2 seconds' or v_time<s.observed_at or v_host>9007199254740991
        or (v_guest is not null and (v_guest<0 or v_guest>9007199254740991))
        or (p_terminal is distinct from (p_sample->>'state' in ('stopped','absent'))) then
        raise exception 'Computer sample clock or terminal state differs' using errcode='22023'; end if;
    if not p_terminal and ((p_sample->>'hostBootId')::uuid<>p.host_boot_id or v_time>w.deadline) then
        raise exception 'Computer permit expired or host rebooted' using errcode='55000'; end if;
    if p_sample->>'state'='running' then
        if p_sample->>'physicalId' is null or p_sample->>'guestBootId' is null or v_guest is null
            or not exists(select 1 from public.qorpera_runtime_node_instance_bindings where allocation_id=p.allocation_id and node_id=p.node_id
                and physical_id=(p_sample->>'physicalId')::uuid) then raise exception 'Enrolled physical boot required' using errcode='42501'; end if;
        if p.guest_boot_id is not null and (p.guest_boot_id is distinct from (p_sample->>'guestBootId')::uuid or p.physical_id is distinct from (p_sample->>'physicalId')::uuid) then
            raise exception 'Paid computer boot changed' using errcode='42501'; end if;
    end if;
    if p_terminal and ((p_sample->>'state'='stopped' and p_sample->>'physicalId' is null)
        or (p.physical_id is not null and p_sample->>'physicalId' is not null and p.physical_id is distinct from (p_sample->>'physicalId')::uuid)
        or (p.guest_boot_id is not null and p_sample->>'guestBootId' is not null and p.guest_boot_id is distinct from (p_sample->>'guestBootId')::uuid)) then
        raise exception 'Terminal computer identity differs' using errcode='42501'; end if;
    if p.last_sample is not null and p_sample->>'previousObservationId' is distinct from p.last_sample->>'observationId' then
        raise exception 'Paid observation predecessor differs' using errcode='40001'; end if;
    if p.last_sample is null and p_sample->>'previousObservationId' is not null then raise exception 'First sample has a predecessor' using errcode='22023'; end if;
    if p.last_sample is not null and p.last_sample->>'hostBootId'=p_sample->>'hostBootId' then
        v_host_delta:=v_host-(p.last_sample->>'hostUptimeMs')::bigint;
        if v_host_delta<0 then raise exception 'Host uptime went backwards' using errcode='22023'; end if;
        v_elapsed:=v_host_delta;
        v_guest_delta:=v_guest-(p.last_sample->>'guestUptimeMs')::bigint;
        v_wall:=extract(epoch from v_time-(p.last_sample->>'observedAt')::timestamptz)*1000;
        if p_sample->>'state'='running' and p.last_sample->>'state'='running' and v_host_delta<=15000
            and v_guest_delta>=0 and abs(v_guest_delta-v_host_delta)<=1000 and abs(v_wall-v_host_delta)<=1000 then
            v_delta:=least(v_guest_delta,v_host_delta); v_coverage:='continuous';
        end if;
    elsif p.last_sample is null then v_coverage:='initial'; end if;
    if p_terminal then v_coverage:='terminal'; end if;
    v_sequence:=s.last_sequence+1;
    perform public.qorpera_record_computer_usage_checkpoint_internal(p.allocation_id,p.instance_sha256,p.epoch,v_sequence,
        s.elapsed_ms+v_elapsed,s.active_ms+v_delta,v_time,p_terminal,'coding_machine',p_sample->>'evidenceSha256');
    insert into public.qorpera_coding_computer_samples(permit_id,observation_id,generation,sample,sequence,coverage)
        values(p.id,(p_sample->>'observationId')::uuid,p_generation,p_sample,v_sequence,v_coverage);
    update public.qorpera_coding_computer_permits set last_sample=p_sample,
        physical_id=case when p_sample->>'state'='running' then (p_sample->>'physicalId')::uuid else physical_id end,
        guest_boot_id=case when p_sample->>'state'='running' then (p_sample->>'guestBootId')::uuid else guest_boot_id end,
        state=case when not p_terminal and p_sample->>'state'='running' then 'bound' else state end where id=p.id;
    return v_sequence;
end $$;

create function public.qorpera_checkpoint_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; v_seq bigint;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    perform public.qorpera_computer_executor_machine(p.allocation_id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=p.profile_id for update;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id for update;
    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,(p_request->>'generation')::bigint,p_request->'sample',false);
    return jsonb_build_object('recorded',true,'sequence',v_seq,'permit',public.qorpera_computer_permit_receipt(p.id,(p_request->>'generation')::bigint));
end $$;
create function public.qorpera_bind_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
    if p_request#>>'{sample,state}' is distinct from 'running' then raise exception 'Running boot sample required' using errcode='22023'; end if;
    return public.qorpera_checkpoint_coding_computer_permit(p_request,p_executor_secret);
end $$;

create function public.qorpera_renew_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; w public.qorpera_coding_computer_windows%rowtype;
    c public.qorpera_coding_computer_commands%rowtype; m public.qorpera_coding_machines%rowtype;
    s public.qorpera_computer_usage_streams%rowtype; tariff public.qorpera_computer_tariff_versions%rowtype;
    v_id uuid; v_seq bigint; v_deadline timestamptz; v_normal jsonb; v_amount bigint; v_window integer; v_margin integer;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    m:=public.qorpera_computer_executor_machine(p.allocation_id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=p.profile_id for update;
    v_id:=(p_request->>'requestId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;
    if found then
        if c.action<>'renew' or c.request<>p_request then raise exception 'Renewal replay differs' using errcode='23505'; end if;
        return public.qorpera_computer_permit_receipt(c.permit_id,c.generation);
    end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id and released_at is null for update;
    if not found then raise exception 'Allocation released' using errcode='55000'; end if;
    select * into strict p from public.qorpera_coding_computer_permits where id=p.id for update;
    select * into strict w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=p.generation;
    if not public.qorpera_company_paid_computer_mode(p.profile_id) or p.state<>'bound' or (p_request->>'generation')::bigint is distinct from p.generation
        or clock_timestamp()>=w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000)
        or p_request#>>'{sample,state}' is distinct from 'running' then raise exception 'Computer permit cannot renew' using errcode='55000'; end if;
    if m.removing_at is not null or m.removed_at is not null or m.instance_sha256 is distinct from p.instance_sha256
        or not exists(select 1 from public.qorpera_runtime_node_demands demand join public.qorpera_runtime_nodes node on node.id=demand.node_id
            where demand.allocation_id=p.allocation_id and demand.node_id=p.node_id and demand.reserved_at is not null
            and demand.released_at is null and demand.suspended_at is null and node.enabled) then
        raise exception 'Computer physical authority withdrawn' using errcode='42501'; end if;
    v_window:=(p_request->>'windowMs')::integer; v_margin:=(p_request->>'stopReserveMs')::integer;
    if v_window is null or v_window not between 30000 and 300000 or v_margin is null or v_margin not between 30000 and 60000 then
        raise exception 'Bounded renewal required' using errcode='22023'; end if;
    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,p.generation,p_request->'sample',false);
    select * into strict s from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch;
    if s.observed_at<clock_timestamp()-interval '15 seconds' then raise exception 'Fresh renewal sample required' using errcode='55000'; end if;
    v_deadline:=least(s.observed_at,clock_timestamp())+make_interval(secs=>(v_window+v_margin)::double precision/1000);
    select * into strict tariff from public.qorpera_computer_tariff_versions where version=s.tariff_version;
    v_normal:=public.qorpera_standard_computer_time(s.active_ms+v_window+v_margin,(s.resource_shape->>'cpuMillis')::bigint,(s.resource_shape->>'memoryBytes')::bigint,
        'coding_machine',tariff.reference_cpu_millis,tariff.reference_memory_bytes);
    v_amount:=ceil((v_normal->>'numerator')::numeric*1000/(v_normal->>'denominator')::numeric)::bigint;
    perform public.qorpera_settle_computer_allowance_internal(w.reservation_id,v_seq);
    v_amount:=v_amount-(select settled_standard_us from public.qorpera_computer_allowance_cursors where allocation_id=p.allocation_id and epoch=p.epoch);
    perform public.qorpera_reserve_computer_allowance_internal(v_id,p.profile_id,m.member_user_id,null,p.allocation_id,p.epoch,v_amount,v_deadline);
    insert into public.qorpera_coding_computer_windows values(p.id,p.generation+1,v_id,clock_timestamp(),v_deadline,v_window,v_margin);
    update public.qorpera_coding_computer_permits set generation=generation+1 where id=p.id;
    insert into public.qorpera_coding_computer_commands(request_id,action,request,permit_id,generation) values(v_id,'renew',p_request,p.id,p.generation+1);
    return public.qorpera_computer_permit_receipt(p.id,p.generation+1);
end $$;

create function public.qorpera_finish_coding_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; w public.qorpera_coding_computer_windows%rowtype;
    c public.qorpera_coding_computer_commands%rowtype; v_id uuid; v_seq bigint; v_settle_seq bigint;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    perform public.qorpera_computer_executor_machine(p.allocation_id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=p.profile_id for update;
    v_id:=(p_request->>'requestId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;
    if found then
        if c.action<>'finish' or c.request<>p_request then raise exception 'Finish replay differs' using errcode='23505'; end if;
        return public.qorpera_computer_permit_receipt(c.permit_id,c.generation);
    end if;
    if p_request->'guardClosed' is distinct from 'true'::jsonb then raise exception 'Physical guard terminal proof required' using errcode='42501'; end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id for update;
    select * into strict p from public.qorpera_coding_computer_permits where id=p.id for update;
    if p.state='closed' or (p_request->>'generation')::bigint is distinct from p.generation then raise exception 'Computer generation changed' using errcode='40001'; end if;
    select * into strict w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=p.generation;
    select last_sequence into strict v_settle_seq from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch;
    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,p.generation,p_request->'sample',true);
    -- Stopped/absent proof adds no guessed active interval. If the proof arrives
    -- after the deadline, debit the last known checkpoint within its hold;
    -- retain the later terminal observation as explicit gap evidence.
    perform public.qorpera_settle_computer_allowance_internal(w.reservation_id,v_settle_seq);
    update public.qorpera_coding_computer_permits set state='closed',closed_at=clock_timestamp() where id=p.id;
    insert into public.qorpera_coding_computer_commands(request_id,action,request,permit_id,generation) values(v_id,'finish',p_request,p.id,p.generation);
    return public.qorpera_computer_permit_receipt(p.id,p.generation);
end $$;

do $$ declare t text; f regprocedure; begin
    foreach t in array array['qorpera_computer_executor_keys','qorpera_coding_computer_permits','qorpera_coding_computer_windows','qorpera_coding_computer_commands','qorpera_coding_computer_samples'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
    end loop;
    for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
        'qorpera_record_computer_usage_checkpoint_internal','qorpera_reserve_computer_allowance_internal','qorpera_settle_computer_allowance_internal','qorpera_observe_computer_usage_shadow_internal',
        'qorpera_computer_executor_machine','qorpera_computer_permit_receipt','qorpera_apply_coding_computer_sample',
        'qorpera_prepare_coding_computer_permit','qorpera_describe_coding_computer_permit','qorpera_checkpoint_coding_computer_permit','qorpera_bind_coding_computer_permit',
        'qorpera_renew_coding_computer_permit','qorpera_finish_coding_computer_permit','qorpera_record_computer_usage_checkpoint','qorpera_reserve_computer_allowance','qorpera_settle_computer_allowance','qorpera_observe_computer_usage') loop
        execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
    end loop;
end $$;
grant execute on function public.qorpera_prepare_coding_computer_permit(jsonb,text),public.qorpera_describe_coding_computer_permit(jsonb,text),
    public.qorpera_checkpoint_coding_computer_permit(jsonb,text),public.qorpera_bind_coding_computer_permit(jsonb,text),
    public.qorpera_renew_coding_computer_permit(jsonb,text),public.qorpera_finish_coding_computer_permit(jsonb,text),
    public.qorpera_record_computer_usage_checkpoint(uuid,text,uuid,bigint,bigint,bigint,timestamptz,boolean,text,text),
    public.qorpera_reserve_computer_allowance(uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz),public.qorpera_settle_computer_allowance(uuid,bigint),
    public.qorpera_observe_computer_usage(jsonb) to service_role;
