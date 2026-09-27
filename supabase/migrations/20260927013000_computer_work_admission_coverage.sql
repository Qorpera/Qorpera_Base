-- Funding/physical running/guard ACK do not imply trustworthy clock coverage.
-- Admission reads the current canonical sample; settlement and custody remain
-- available during a gap and never manufacture charges for unknown time.
create function public.qorpera_computer_work_ready(p_permit_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
    select exists(select 1 from public.qorpera_coding_computer_permits p
        join public.qorpera_runtime_machine_allocations a on a.id=p.allocation_id
        join public.qorpera_coding_computer_windows w on w.permit_id=p.id and w.generation=p.generation
        join public.qorpera_computer_allowance_reservations r on r.id=w.reservation_id
        join public.qorpera_runtime_node_demands d on d.allocation_id=a.id
        join public.qorpera_runtime_nodes n on n.id=d.node_id
        where p.id=p_permit_id and p.state='bound' and a.released_at is null
        and a.instance_sha256=p.instance_sha256 and d.node_id=p.node_id and n.enabled
        and d.reserved_at is not null and d.released_at is null and d.suspended_at is null
        and r.settled_at is null and r.allocation_id=a.id and r.epoch=p.epoch
        and w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000)>clock_timestamp()
        and public.qorpera_computer_sample_ready(p.id,p.last_sample)
        and p.last_sample->>'hostBootId'=p.host_boot_id::text
        and p.last_sample->>'guestBootId'=p.guest_boot_id::text
        and p.last_sample->>'physicalId'=p.physical_id::text
        and (p.last_sample->>'observedAt')::timestamptz between clock_timestamp()-interval '10 seconds' and clock_timestamp())
$$;

create function public.qorpera_assert_office_computer_work_ready(p_activation public.qorpera_runtime_office_activations)
returns void language plpgsql security definer set search_path='' as $$
declare company uuid;
begin
    select profile_id into strict company from public.qorpera_runtime_offices where id=p_activation.office_id;
    if not public.qorpera_company_paid_computer_mode(company) then return; end if;
    if not exists(select 1 from public.qorpera_coding_computer_permits p
        join public.qorpera_runtime_computer_contexts c on c.permit_id=p.id
        join public.qorpera_runtime_computer_host_keys k on k.id=c.host_key_id
        join public.qorpera_runtime_nodes n on n.id=p.node_id
        where p.profile_id=company and p.allocation_id=p_activation.allocation_id
        and p.instance_sha256=p_activation.instance_sha256
        and p.guest_boot_id::text=p_activation.attestation->>'bootId'
        and c.context->>'providerKind'='office'
        and c.context->>'officeId'=p_activation.office_id::text
        and c.context->>'computerGeneration'=p_activation.computer_generation::text
        and c.context->>'bootstrapSha256'=p_activation.bootstrap_sha256
        and k.provider_id=p_activation.provider_id::text and k.policy_sha256=p_activation.provider_policy_sha256
        and k.revoked_at is null and k.node_id=p.node_id and k.machine_id_sha256=n.machine_id_sha256
        and public.qorpera_computer_work_ready(p.id)) then
        raise exception 'Office computer metering not ready' using errcode='55000';
    end if;
end $$;

revoke all on function public.qorpera_computer_work_ready(uuid),
    public.qorpera_assert_office_computer_work_ready(public.qorpera_runtime_office_activations)
    from public,anon,authenticated,service_role,qorpera_secret_broker;

create function pg_temp.work_admission_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare definition text:=pg_get_functiondef(p_target);
begin
    if (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
        raise exception 'Reviewed work admission source changed: %',p_target; end if;
    execute replace(definition,p_old,p_new);
end $$;
select pg_temp.work_admission_patch('public.qorpera_describe_coding_computer_permit(jsonb,text)',
    '''lastSample'',p.last_sample,',
    '''lastSample'',p.last_sample,''workReady'',public.qorpera_computer_work_ready(p.id),');
select pg_temp.work_admission_patch('public.qorpera_describe_runtime_computer_permit(jsonb,text)',
    '''lastSample'',p.last_sample,',
    '''lastSample'',p.last_sample,''workReady'',public.qorpera_computer_work_ready(p.id),');
select pg_temp.work_admission_patch('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)',
    E'\tif v_activation.state=''active'' then',
    E'\tperform public.qorpera_assert_office_computer_work_ready(v_activation);\n\tif v_activation.state=''active'' then');
-- Prepared/ready startup admits closed listeners only: it must remain possible
-- before the first sample. Active startup refresh opens/keeps work admission.
-- Do not gate generic guest binding: stop/resume/reset custody also uses it.
select pg_temp.work_admission_patch('public.qorpera_lock_runtime_office_startup(jsonb)',
    E'\tif v_activation.state=''active'' then',
    E'\tif v_activation.state=''active'' then\n\t\tperform public.qorpera_assert_office_computer_work_ready(v_activation);');

-- Preserve split trusted SECURITY DEFINER ownership without granting the
-- private predicates to runtime credentials or the secret broker.
do $$ declare caller regprocedure; helper regprocedure; owner_name name; begin
    for caller,helper in select * from (values
        ('public.qorpera_computer_work_ready(uuid)'::regprocedure,'public.qorpera_computer_sample_ready(uuid,jsonb)'::regprocedure),
        ('public.qorpera_assert_office_computer_work_ready(public.qorpera_runtime_office_activations)'::regprocedure,'public.qorpera_computer_work_ready(uuid)'::regprocedure),
        ('public.qorpera_describe_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_work_ready(uuid)'::regprocedure),
        ('public.qorpera_describe_runtime_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_computer_work_ready(uuid)'::regprocedure),
        ('public.qorpera_activate_runtime_office(jsonb,bigint,uuid,uuid,uuid,text,text)'::regprocedure,
            'public.qorpera_assert_office_computer_work_ready(public.qorpera_runtime_office_activations)'::regprocedure),
        ('public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure,
            'public.qorpera_assert_office_computer_work_ready(public.qorpera_runtime_office_activations)'::regprocedure)
    ) edge(caller,helper) loop
        select pg_get_userbyid(proowner) into strict owner_name from pg_proc where oid=caller and prosecdef;
        if owner_name in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Trusted work admission caller required'; end if;
        execute format('grant execute on function %s to %I',helper,owner_name);
    end loop;
end $$;
