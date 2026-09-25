-- Paid physical custody extends the same ledger and measured sample chain to
-- native and office allocations. Public legacy paid admission remains denied.
-- Operator enrollment pins resources independently of service-role node setup.
-- Native per-run bootstrap bytes contain transient credentials, so an enrolled
-- host may generate them under its pinned provider policy (expected bootstrap
-- NULL). Their exact digest is immutable per permit/instance. This trusts that
-- enrolled host's composition; it does not independently attest template bytes.
-- Office bootstrap is static and must be pinned in operator enrollment.
create table public.qorpera_runtime_computer_host_keys (
    id uuid primary key default extensions.gen_random_uuid(),
    node_id uuid not null references public.qorpera_runtime_nodes(id),
    provider_kind text not null check(provider_kind in ('native','office')),
    provider_id text not null,
    policy_sha256 text not null check(policy_sha256 ~ '^[0-9a-f]{64}$'),
    machine_id_sha256 text not null check(machine_id_sha256 ~ '^[0-9a-f]{64}$'),
    bootstrap_sha256 text check(bootstrap_sha256 ~ '^[0-9a-f]{64}$'),
    check(provider_kind='native' or bootstrap_sha256 is not null),
    cpu_millis bigint not null check(cpu_millis between 1 and 1024000),
    memory_bytes bigint not null check(memory_bytes between 1 and 1125899906842624),
    backend text not null check(backend='lxd'),
    key_sha256 text not null unique check(key_sha256 ~ '^[0-9a-f]{64}$'),
    revoked_at timestamptz,
    created_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_runtime_computer_contexts (
    permit_id uuid primary key references public.qorpera_coding_computer_permits(id),
    host_key_id uuid not null references public.qorpera_runtime_computer_host_keys(id),
    context jsonb not null check(jsonb_typeof(context)='object'),
    request_identity jsonb not null check(jsonb_typeof(request_identity)='object')
);
-- Clone the already-reviewed capacity authority, changing only the paid gate.
-- The clones are private and can only be reached after independent host auth.
create function pg_temp.runtime_paid_clone(p_source regprocedure,p_name text,p_gate text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_source); v_name text;
begin
    select proname into strict v_name from pg_proc where oid=p_source;
    if (length(v_definition)-length(replace(v_definition,p_gate,'')))/length(p_gate)<>1 then
        raise exception 'Paid capacity clone source differs: %',p_source; end if;
    v_definition:=replace(v_definition,'FUNCTION public.'||v_name||'(','FUNCTION public.'||p_name||'(');
    execute replace(v_definition,p_gate,'');
end $$;
select pg_temp.runtime_paid_clone('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)',
    'qorpera_reserve_paid_runtime_machine_internal',
    $gate$	if public.qorpera_company_paid_computer_mode(v_profile) then
		return '{"state":"refused","reason":"PAID_COMPUTER_PATH_UNSUPPORTED"}'::jsonb; end if;
$gate$);
select pg_temp.runtime_paid_clone('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
    'qorpera_reserve_paid_runtime_node_internal',
    $gate$ if public.qorpera_company_paid_computer_mode(v_profile)
  and not (p_provider_kind='login' and num_nonnulls(v_allocation.login_session_id,v_allocation.account_refresh_request_id)=1
   and v_allocation.login_compute_identity_id is not null)
  and not (p_provider_kind='coding' and v_allocation.coding_machine_id is not null) then
  return '{"state":"refused","reason":"PAID_COMPUTER_PATH_UNSUPPORTED"}'::jsonb; end if;
$gate$);

create function public.qorpera_runtime_computer_host(p_request jsonb,p_executor_secret text)
returns public.qorpera_runtime_computer_host_keys language plpgsql security definer set search_path='' as $$
declare k public.qorpera_runtime_computer_host_keys%rowtype;
begin
    if auth.role() is distinct from 'service_role' or p_executor_secret is null or octet_length(p_executor_secret) not between 32 and 512
        or p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>20000 then
        raise exception 'Dedicated runtime host authority required' using errcode='42501'; end if;
    select * into k from public.qorpera_runtime_computer_host_keys where revoked_at is null
        and key_sha256=encode(extensions.digest(convert_to(p_executor_secret,'UTF8'),'sha256'),'hex') for share;
    if not found or k.provider_kind is distinct from p_request->>'providerKind' or k.provider_id is distinct from p_request->>'providerId'
        or k.policy_sha256 is distinct from p_request->>'policySha256' or k.machine_id_sha256 is distinct from p_request->>'machineIdSha256'
        or coalesce(p_request->>'bootstrapSha256','') !~ '^[0-9a-f]{64}$'
        or (k.bootstrap_sha256 is not null and k.bootstrap_sha256 is distinct from p_request->>'bootstrapSha256') then
        raise exception 'Runtime host scope differs' using errcode='42501'; end if;
    return k;
end $$;

-- Office lifecycle admission is supplied by the protected office adapter. An
-- enrolled generic host alone must not invent a start/resume/reset intent.
create function public.qorpera_authorize_paid_office_start(p_request jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin raise exception 'Paid office lifecycle is not installed' using errcode='55000'; end $$;

create function public.qorpera_runtime_computer_profile(p_request jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_profile uuid;
begin
    if p_request->>'providerKind'='native' and p_request->>'officeId' is null and p_request->>'computerGeneration' is null then
        select run.profile_id into v_profile from public.qorpera_execution_runs run join public.qorpera_runners runner on runner.id=(p_request->>'runnerId')::uuid
            where run.id=(p_request->>'runId')::uuid and runner.profile_id=run.profile_id
            and runner.client_runner_id=(p_request->>'allocationId')::uuid and runner.provider_adapter=p_request->>'providerId'
            and runner.compute_identity_id is not distinct from run.compute_identity_id and runner.logical_computer_id is not distinct from run.logical_computer_id;
    elsif p_request->>'providerKind'='office' and p_request->>'runId' is null and p_request->>'runnerId' is null then
        select office.profile_id into v_profile from public.qorpera_runtime_offices office
            join public.qorpera_runtime_office_providers provider on provider.office_id=office.id and provider.computer_generation=office.generation
            where office.id=(p_request->>'officeId')::uuid and office.generation=(p_request->>'computerGeneration')::bigint
            and provider.provider_id::text=p_request->>'providerId' and provider.policy_sha256=p_request->>'policySha256';
    end if;
    if v_profile is null then raise exception 'Runtime allocation source differs' using errcode='42501'; end if;
    return v_profile;
end $$;

-- The historical table names are retained internally so all old managed-epoch,
-- mode-switch, raw-checkpoint, and shadow-observer fences cover these permits.
create or replace function public.qorpera_apply_coding_computer_sample(p_permit_id uuid,p_generation bigint,p_sample jsonb,p_terminal boolean)
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
        s.elapsed_ms+v_elapsed,s.active_ms+v_delta,v_time,p_terminal,s.resource_kind,p_sample->>'evidenceSha256');
    insert into public.qorpera_coding_computer_samples(permit_id,observation_id,generation,sample,sequence,coverage)
        values(p.id,(p_sample->>'observationId')::uuid,p_generation,p_sample,v_sequence,v_coverage);
    update public.qorpera_coding_computer_permits set last_sample=p_sample,
        physical_id=case when p_sample->>'state'='running' then (p_sample->>'physicalId')::uuid else physical_id end,
        guest_boot_id=case when p_sample->>'state'='running' then (p_sample->>'guestBootId')::uuid else guest_boot_id end,
        state=case when not p_terminal and p_sample->>'state'='running' then 'bound' else state end where id=p.id;
    return v_sequence;
end $$;


create function public.qorpera_runtime_computer_receipt(p_permit_id uuid,p_generation bigint)
returns jsonb language sql volatile security definer set search_path='' as $$
    select public.qorpera_computer_permit_receipt(p_permit_id,p_generation)||jsonb_build_object('runtimeContext',context)
    from public.qorpera_runtime_computer_contexts where permit_id=p_permit_id
$$;
create function public.qorpera_describe_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare k public.qorpera_runtime_computer_host_keys%rowtype; p public.qorpera_coding_computer_permits%rowtype; v_profile uuid;
begin
    k:=public.qorpera_runtime_computer_host(p_request,p_executor_secret);
    v_profile:=public.qorpera_runtime_computer_profile(p_request);
    select permit.* into p from public.qorpera_coding_computer_permits permit join public.qorpera_runtime_computer_contexts context on context.permit_id=permit.id
        where permit.allocation_id=(p_request->>'allocationId')::uuid and permit.profile_id=v_profile and context.host_key_id=k.id
        and (case when p_request->>'permitId' is null then permit.state<>'closed' else permit.id=(p_request->>'permitId')::uuid end);
    if p.id is not null and not exists(select 1 from public.qorpera_runtime_computer_contexts c where c.permit_id=p.id
        and c.context->>'bootstrapSha256' is not distinct from p_request->>'bootstrapSha256'
        and c.context->>'runId' is not distinct from p_request->>'runId'
        and c.context->>'runnerId' is not distinct from p_request->>'runnerId'
        and c.context->>'officeId' is not distinct from p_request->>'officeId'
        and c.context->>'computerGeneration' is not distinct from p_request->>'computerGeneration'
        and (p_request->>'instanceSha256' is null or p.instance_sha256=p_request->>'instanceSha256')) then
        raise exception 'Runtime permit recovery identity differs' using errcode='42501'; end if;
    return jsonb_build_object('mode',case when public.qorpera_company_paid_computer_mode(v_profile) then 'paid' else 'shadow' end,
        'permit',case when p.id is not null then public.qorpera_runtime_computer_receipt(p.id,p.generation) else null end,
        'lastSample',p.last_sample,'hostBootMatches',p.host_boot_id=(p_request->>'hostBootId')::uuid);
end $$;

create function public.qorpera_prepare_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare k public.qorpera_runtime_computer_host_keys%rowtype; c public.qorpera_coding_computer_commands%rowtype;
    d public.qorpera_runtime_node_demands%rowtype; tariff public.qorpera_computer_tariff_versions%rowtype;
    v_id uuid; v_profile uuid; v_allocation uuid; v_epoch uuid; v_requester uuid; v_preferred uuid; v_job uuid;
    v_now timestamptz; v_deadline timestamptz; v_window integer; v_margin integer; v_kind text; v_amount bigint; v_normal jsonb; v_capacity jsonb; v_context jsonb;
begin
    k:=public.qorpera_runtime_computer_host(p_request,p_executor_secret);
    if p_request->>'schema' is distinct from 'qorpera.runtime-computer-prepare/v1' or p_request->>'requestId' is null
        or coalesce(p_request->>'instanceSha256','') !~ '^[0-9a-f]{64}$' or p_request->>'hostBootId' is null then
        raise exception 'Invalid runtime permit request' using errcode='22023'; end if;
    v_profile:=public.qorpera_runtime_computer_profile(p_request); v_id:=(p_request->>'requestId')::uuid; v_allocation:=(p_request->>'allocationId')::uuid;
    -- Match native admission's job -> profile -> allocation lock ordering.
    if k.provider_kind='native' then
        select job_id,requested_by_user_id into strict v_job,v_requester from public.qorpera_execution_runs where id=(p_request->>'runId')::uuid;
        perform 1 from public.qorpera_runner_jobs where id=v_job for update;
    end if;
    perform public.qorpera_lock_profile_gc_fence(v_profile);
    select computer_usage_owner_user_id into v_preferred from public.qorpera_profiles where id=v_profile for update;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;
    if found then
        if c.action<>'prepare' or c.request<>p_request or not exists(select 1 from public.qorpera_runtime_computer_contexts where permit_id=c.permit_id and host_key_id=k.id) then
            raise exception 'Runtime permit replay differs' using errcode='23505'; end if;
        return public.qorpera_runtime_computer_receipt(c.permit_id,c.generation);
    end if;
    if not public.qorpera_company_paid_computer_mode(v_profile) then raise exception 'Company paid mode not enabled' using errcode='55000'; end if;
    if k.backend<>'lxd' then raise exception 'Paid systemd runtime is not supported' using errcode='55000'; end if;
    if k.provider_kind='office' then perform public.qorpera_authorize_paid_office_start(p_request); end if;
    if not exists(select 1 from public.qorpera_runtime_node_providers provider join public.qorpera_runtime_nodes node on node.id=provider.node_id
        where provider.node_id=k.node_id and provider.provider_kind=k.provider_kind and provider.provider_id=k.provider_id and provider.policy_sha256=k.policy_sha256
        and provider.cpu_millis=k.cpu_millis and provider.memory_bytes=k.memory_bytes and node.machine_id_sha256=k.machine_id_sha256 and node.enabled) then
        raise exception 'Enrolled runtime resource policy differs' using errcode='42501'; end if;
    if k.provider_kind='office' then
        -- Initial stopped creation already reserves this allocation. Resume and
        -- reset retain it while the office is in maintenance; only the fresh
        -- lifecycle hook above may authorize another physical start.
        perform 1 from public.qorpera_runtime_machine_allocations where id=v_allocation
            and profile_id=v_profile and office_id=(p_request->>'officeId')::uuid
            and computer_generation=(p_request->>'computerGeneration')::bigint
            and provider_adapter='lxd' and instance_sha256=p_request->>'instanceSha256'
            and released_at is null for update;
        if not found then raise exception 'Office allocation no longer admitted' using errcode='42501'; end if;
    else
        v_capacity:=public.qorpera_reserve_paid_runtime_machine_internal(v_allocation,k.provider_id,
            p_request->>'instanceSha256',(p_request->>'runId')::uuid,(p_request->>'runnerId')::uuid,null,null);
        if v_capacity->>'state' is distinct from 'reserved' then raise exception 'Runtime machine capacity refused: %',v_capacity->>'reason' using errcode='55000'; end if;
    end if;
    v_capacity:=public.qorpera_reserve_paid_runtime_node_internal(v_allocation,k.provider_kind,k.provider_id,k.policy_sha256,p_request->>'instanceSha256',k.machine_id_sha256,k.cpu_millis,k.memory_bytes);
    if v_capacity->>'state' is distinct from 'reserved' then raise exception 'Runtime node capacity refused: %',v_capacity->>'reason' using errcode='55000'; end if;
    select * into strict d from public.qorpera_runtime_node_demands where allocation_id=v_allocation;
    if exists(select 1 from public.qorpera_computer_usage_streams where allocation_id=v_allocation and not closed) then
        raise exception 'Runtime computer has an unresolved epoch' using errcode='55000'; end if;
    v_window:=(p_request->>'windowMs')::integer; v_margin:=(p_request->>'stopReserveMs')::integer;
    if v_window is null or v_window not between 30000 and 300000 or v_margin is null or v_margin not between 30000 and 60000 then
        raise exception 'Bounded runtime permit required' using errcode='22023'; end if;
    v_kind:=case when k.provider_kind='office' then 'company_computer' else 'agent_sandbox' end;
    v_now:=clock_timestamp(); v_deadline:=v_now+make_interval(secs=>(v_window+v_margin)::double precision/1000); v_epoch:=extensions.gen_random_uuid();
    perform public.qorpera_record_computer_usage_checkpoint_internal(v_allocation,p_request->>'instanceSha256',v_epoch,0,0,0,v_now,false,v_kind,
        encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex'));
    select * into strict tariff from public.qorpera_computer_tariff_versions where version=(select tariff_version from public.qorpera_computer_billing_readiness);
    v_normal:=public.qorpera_standard_computer_time(v_window+v_margin,d.cpu_millis,d.memory_bytes,v_kind,tariff.reference_cpu_millis,tariff.reference_memory_bytes);
    v_amount:=ceil((v_normal->>'numerator')::numeric*1000/(v_normal->>'denominator')::numeric)::bigint;
    perform public.qorpera_reserve_computer_allowance_internal(v_id,v_profile,v_requester,case when k.provider_kind='office' then v_preferred else null end,v_allocation,v_epoch,v_amount,v_deadline);
    insert into public.qorpera_coding_computer_permits values(v_id,v_allocation,v_profile,d.node_id,p_request->>'instanceSha256',v_epoch,(p_request->>'hostBootId')::uuid,null,null,'prepared',1,null,null);
    insert into public.qorpera_coding_computer_windows values(v_id,1,v_id,v_now,v_deadline,v_window,v_margin);
    insert into public.qorpera_coding_computer_commands(request_id,action,request,permit_id,generation) values(v_id,'prepare',p_request,v_id,1);
    v_context:=jsonb_build_object('providerKind',k.provider_kind,'providerId',k.provider_id,'policySha256',k.policy_sha256,'bootstrapSha256',p_request->>'bootstrapSha256',
        'resourceKind',v_kind,'backend',k.backend,'runId',p_request->'runId','runnerId',p_request->'runnerId','officeId',p_request->'officeId','computerGeneration',p_request->'computerGeneration');
    insert into public.qorpera_runtime_computer_contexts values(v_id,k.id,v_context,p_request);
    return public.qorpera_runtime_computer_receipt(v_id,1);
end $$;

-- Later requests derive scope from immutable prepare metadata, not caller
-- selected member IDs, resource shapes, or provider identities.
create function public.qorpera_runtime_computer_permit_host(p_permit_id uuid,p_executor_secret text)
returns public.qorpera_runtime_computer_contexts language plpgsql security definer set search_path='' as $$
declare c public.qorpera_runtime_computer_contexts%rowtype; k public.qorpera_runtime_computer_host_keys%rowtype;
begin
    select * into strict c from public.qorpera_runtime_computer_contexts where permit_id=p_permit_id;
    k:=public.qorpera_runtime_computer_host(c.request_identity,p_executor_secret);
    if k.id<>c.host_key_id then raise exception 'Runtime permit host changed' using errcode='42501'; end if;
    return c;
end $$;
create function public.qorpera_checkpoint_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; v_seq bigint;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    perform public.qorpera_runtime_computer_permit_host(p.id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=p.profile_id for update;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id for update;
    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,(p_request->>'generation')::bigint,p_request->'sample',false);
    return jsonb_build_object('recorded',true,'sequence',v_seq,'permit',public.qorpera_runtime_computer_receipt(p.id,(p_request->>'generation')::bigint));
end $$;
create function public.qorpera_bind_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
    if p_request#>>'{sample,state}' is distinct from 'running' then raise exception 'Running sample required' using errcode='22023'; end if;
    return public.qorpera_checkpoint_runtime_computer_permit(p_request,p_executor_secret);
end $$;

create function public.qorpera_renew_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; w public.qorpera_coding_computer_windows%rowtype;
    c public.qorpera_coding_computer_commands%rowtype; ctx public.qorpera_runtime_computer_contexts%rowtype;
    k public.qorpera_runtime_computer_host_keys%rowtype; s public.qorpera_computer_usage_streams%rowtype; tariff public.qorpera_computer_tariff_versions%rowtype;
    v_id uuid; v_seq bigint; v_deadline timestamptz; v_normal jsonb; v_amount bigint; v_window integer; v_margin integer;
    v_requester uuid; v_preferred uuid; v_capacity jsonb;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    ctx:=public.qorpera_runtime_computer_permit_host(p.id,p_executor_secret);
    select * into strict k from public.qorpera_runtime_computer_host_keys where id=ctx.host_key_id;
    if ctx.context->>'runId' is not null then
        select requested_by_user_id into strict v_requester from public.qorpera_execution_runs where id=(ctx.context->>'runId')::uuid;
        perform 1 from public.qorpera_runner_jobs where id=(select job_id from public.qorpera_execution_runs where id=(ctx.context->>'runId')::uuid) for update;
    end if;
    perform public.qorpera_lock_profile_gc_fence(p.profile_id);
    select computer_usage_owner_user_id into v_preferred from public.qorpera_profiles where id=p.profile_id for update;
    v_id:=(p_request->>'requestId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;
    if found then
        if c.action<>'renew' or c.request<>p_request then raise exception 'Renewal replay differs' using errcode='23505'; end if;
        return public.qorpera_runtime_computer_receipt(c.permit_id,c.generation);
    end if;
    perform 1 from public.qorpera_runtime_machine_allocations where id=p.allocation_id and released_at is null for update;
    if not found then raise exception 'Allocation released' using errcode='55000'; end if;
    select * into strict p from public.qorpera_coding_computer_permits where id=p.id for update;
    select * into strict w from public.qorpera_coding_computer_windows where permit_id=p.id and generation=p.generation;
    if not public.qorpera_company_paid_computer_mode(p.profile_id) or p.state<>'bound' or (p_request->>'generation')::bigint is distinct from p.generation
        or clock_timestamp()>=w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000)
        or p_request#>>'{sample,state}' is distinct from 'running' then raise exception 'Runtime permit cannot renew' using errcode='55000'; end if;
    if public.qorpera_company_execution_paused(p.profile_id) or not exists(select 1 from public.qorpera_runtime_node_demands demand
        join public.qorpera_runtime_nodes node on node.id=demand.node_id where demand.allocation_id=p.allocation_id and demand.node_id=k.node_id
        and demand.reserved_at is not null and demand.released_at is null and demand.suspended_at is null
        and demand.provider_kind=k.provider_kind and demand.provider_id=k.provider_id and demand.policy_sha256=k.policy_sha256
        and demand.cpu_millis=k.cpu_millis and demand.memory_bytes=k.memory_bytes and node.enabled and node.machine_id_sha256=k.machine_id_sha256) then
        raise exception 'Runtime physical authority withdrawn' using errcode='42501'; end if;
    -- Recheck source membership/sponsorship and current office generation. A
    -- ended run or withdrawn source cannot fund another physical interval.
    if k.provider_kind='office' then
        -- Startup has one bounded window. Renew only after this exact guest
        -- boot activates; maintenance/revocation never extends that authority.
        if not exists(select 1 from public.qorpera_runtime_offices office
            join public.qorpera_runtime_office_providers provider on provider.office_id=office.id and provider.computer_generation=office.generation
            join public.qorpera_runtime_office_activations activation on activation.office_id=office.id and activation.computer_generation=office.generation
            join public.qorpera_runtime_machine_allocations allocation on allocation.id=activation.allocation_id
            join public.qorpera_logical_computers logical on logical.id=office.logical_computer_id
            join public.qorpera_company_files files on files.profile_id=office.profile_id
            where office.id=(ctx.context->>'officeId')::uuid and office.profile_id=p.profile_id
            and office.generation=(ctx.context->>'computerGeneration')::bigint and office.state='active'
            and provider.provider_id::text=k.provider_id and provider.policy_sha256=k.policy_sha256 and provider.preparation_enabled
            and activation.state='active' and activation.superseded_at is null and activation.attestation->>'bootId'=p.guest_boot_id::text
            and activation.provider_id::text=k.provider_id and activation.provider_policy_sha256=k.policy_sha256
            and activation.bootstrap_sha256=ctx.context->>'bootstrapSha256' and activation.instance_sha256=p.instance_sha256
            and allocation.id=p.allocation_id and allocation.profile_id=p.profile_id and allocation.office_id=office.id
            and allocation.computer_generation=office.generation and allocation.provider_adapter='lxd'
            and allocation.instance_sha256=p.instance_sha256 and allocation.released_at is null
            and logical.status='active' and public.qorpera_runtime_office_matches(logical) and files.environment_id=office.environment_id and files.state='ready' and files.path_gateway_version=1
            and not exists(select 1 from public.qorpera_runtime_office_lifecycle_transitions transition where transition.activation_id=activation.activation_id)) then
            raise exception 'Office active boot authority withdrawn' using errcode='42501'; end if;
    else
        v_capacity:=public.qorpera_reserve_paid_runtime_machine_internal(p.allocation_id,k.provider_id,
            p.instance_sha256,(ctx.context->>'runId')::uuid,(ctx.context->>'runnerId')::uuid,null,null);
        if v_capacity->>'state' is distinct from 'reserved' then raise exception 'Runtime source no longer admitted' using errcode='55000'; end if;
    end if;
    v_window:=(p_request->>'windowMs')::integer; v_margin:=(p_request->>'stopReserveMs')::integer;
    if v_window is null or v_window not between 30000 and 300000 or v_margin is null or v_margin not between 30000 and 60000 then
        raise exception 'Bounded renewal required' using errcode='22023'; end if;
    v_seq:=public.qorpera_apply_coding_computer_sample(p.id,p.generation,p_request->'sample',false);
    select * into strict s from public.qorpera_computer_usage_streams where allocation_id=p.allocation_id and epoch=p.epoch;
    if s.observed_at<clock_timestamp()-interval '15 seconds' then raise exception 'Fresh renewal sample required' using errcode='55000'; end if;
    v_deadline:=least(s.observed_at,clock_timestamp())+make_interval(secs=>(v_window+v_margin)::double precision/1000);
    select * into strict tariff from public.qorpera_computer_tariff_versions where version=s.tariff_version;
    v_normal:=public.qorpera_standard_computer_time(s.active_ms+v_window+v_margin,(s.resource_shape->>'cpuMillis')::bigint,(s.resource_shape->>'memoryBytes')::bigint,
        s.resource_kind,tariff.reference_cpu_millis,tariff.reference_memory_bytes);
    v_amount:=ceil((v_normal->>'numerator')::numeric*1000/(v_normal->>'denominator')::numeric)::bigint;
    perform public.qorpera_settle_computer_allowance_internal(w.reservation_id,v_seq);
    v_amount:=v_amount-(select settled_standard_us from public.qorpera_computer_allowance_cursors where allocation_id=p.allocation_id and epoch=p.epoch);
    perform public.qorpera_reserve_computer_allowance_internal(v_id,p.profile_id,v_requester,case when k.provider_kind='office' then v_preferred else null end,p.allocation_id,p.epoch,v_amount,v_deadline);
    insert into public.qorpera_coding_computer_windows values(p.id,p.generation+1,v_id,clock_timestamp(),v_deadline,v_window,v_margin);
    update public.qorpera_coding_computer_permits set generation=generation+1 where id=p.id;
    insert into public.qorpera_coding_computer_commands(request_id,action,request,permit_id,generation) values(v_id,'renew',p_request,p.id,p.generation+1);
    return public.qorpera_runtime_computer_receipt(p.id,p.generation+1);
end $$;
create function public.qorpera_finish_runtime_computer_permit(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype; w public.qorpera_coding_computer_windows%rowtype;
    c public.qorpera_coding_computer_commands%rowtype; v_id uuid; v_seq bigint; v_settle_seq bigint;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=(p_request->>'permitId')::uuid;
    perform public.qorpera_runtime_computer_permit_host(p.id,p_executor_secret);
    perform 1 from public.qorpera_profiles where id=p.profile_id for update;
    v_id:=(p_request->>'requestId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('computer-permit-command:'||v_id::text,0));
    select * into c from public.qorpera_coding_computer_commands where request_id=v_id;
    if found then
        if c.action<>'finish' or c.request<>p_request then raise exception 'Finish replay differs' using errcode='23505'; end if;
        return public.qorpera_runtime_computer_receipt(c.permit_id,c.generation);
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
    return public.qorpera_runtime_computer_receipt(p.id,p.generation);
end $$;


-- Guest native launch can consume only the already bound host permit for its
-- exact run/runner/allocation. This grants no model account or sponsor changes.
create function public.qorpera_native_computer_permit_ready(p_runner_id uuid,p_run_id uuid default null)
returns boolean language sql volatile security definer set search_path='' as $$
    select exists(select 1 from public.qorpera_runtime_machine_allocations a
        join public.qorpera_coding_computer_permits p on p.allocation_id=a.id
        join public.qorpera_runtime_computer_contexts c on c.permit_id=p.id
        join public.qorpera_runtime_computer_host_keys k on k.id=c.host_key_id
        join public.qorpera_coding_computer_windows w on w.permit_id=p.id and w.generation=p.generation
        join public.qorpera_computer_allowance_reservations r on r.id=w.reservation_id
        join public.qorpera_runners runner on runner.id=a.runner_id
        join public.qorpera_runtime_node_demands d on d.allocation_id=a.id
        join public.qorpera_runtime_nodes n on n.id=d.node_id
        where a.runner_id=p_runner_id and (p_run_id is null or a.run_id=p_run_id)
        and a.id=runner.client_runner_id and a.released_at is null and runner.status='active'
        and c.context->>'providerKind'='native' and (c.context->>'runId')::uuid=a.run_id and (c.context->>'runnerId')::uuid=a.runner_id
        and p.instance_sha256=a.instance_sha256 and p.state='bound' and p.last_sample->>'state'='running'
        and (p.last_sample->>'observedAt')::timestamptz>=clock_timestamp()-interval '15 seconds'
        and k.revoked_at is null and k.node_id=p.node_id and k.machine_id_sha256=n.machine_id_sha256 and n.enabled
        and d.node_id=p.node_id and d.reserved_at is not null and d.released_at is null and d.suspended_at is null
        and d.cpu_millis=k.cpu_millis and d.memory_bytes=k.memory_bytes and d.policy_sha256=k.policy_sha256
        and r.settled_at is null and r.allocation_id=a.id and r.epoch=p.epoch
        and w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000)>clock_timestamp())
$$;
create function pg_temp.runtime_paid_patch(p_source regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_source);
begin
    if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then raise exception 'Paid runtime integration differs: %',p_source; end if;
    execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.runtime_paid_patch('public.qorpera_observe_computer_usage(jsonb)',
    $old$and coding_machine_id is not null;$old$,
    $new$and login_session_id is null and account_refresh_request_id is null;$new$);
select pg_temp.runtime_paid_patch('public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)',
    $old$if public.qorpera_company_paid_computer_mode(v_run.profile_id) then$old$,
    $new$if public.qorpera_company_paid_computer_mode(v_run.profile_id)
        and not public.qorpera_native_computer_permit_ready((p_binding->>'runnerId')::uuid,v_run.id) then$new$);
select pg_temp.runtime_paid_patch('public.qorpera_claim_runner_job(uuid,text,uuid,text)',
    $old$if public.qorpera_company_paid_computer_mode((select profile_id from public.qorpera_runners where id=p_runner_id)) then$old$,
    $new$if public.qorpera_company_paid_computer_mode((select profile_id from public.qorpera_runners where id=p_runner_id))
        and not public.qorpera_native_computer_permit_ready(p_runner_id) then$new$);

do $$ declare f regprocedure; t text; begin
    foreach t in array array['qorpera_runtime_computer_host_keys','qorpera_runtime_computer_contexts'] loop
        execute format('alter table public.%I enable row level security',t);
        execute format('revoke all on public.%I from public,anon,authenticated,service_role,qorpera_secret_broker',t);
    end loop;
    for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname=any(array[
        'qorpera_reserve_paid_runtime_machine_internal','qorpera_reserve_paid_runtime_node_internal','qorpera_runtime_computer_host',
        'qorpera_authorize_paid_office_start','qorpera_runtime_computer_profile','qorpera_runtime_computer_receipt','qorpera_runtime_computer_permit_host',
        'qorpera_prepare_runtime_computer_permit','qorpera_describe_runtime_computer_permit','qorpera_bind_runtime_computer_permit',
        'qorpera_checkpoint_runtime_computer_permit','qorpera_renew_runtime_computer_permit','qorpera_finish_runtime_computer_permit',
        'qorpera_native_computer_permit_ready']) loop
        execute format('revoke all on function %s from public,anon,authenticated,service_role,qorpera_secret_broker',f);
    end loop;
end $$;
grant execute on function public.qorpera_prepare_runtime_computer_permit(jsonb,text),public.qorpera_describe_runtime_computer_permit(jsonb,text),
    public.qorpera_bind_runtime_computer_permit(jsonb,text),public.qorpera_checkpoint_runtime_computer_permit(jsonb,text),
    public.qorpera_renew_runtime_computer_permit(jsonb,text),public.qorpera_finish_runtime_computer_permit(jsonb,text) to service_role;
