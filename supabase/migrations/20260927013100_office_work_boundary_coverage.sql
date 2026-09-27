-- Effects use this distinct authority; generic guest binding remains available
-- for stop, drain and retained-state custody even while metering is uncertain.
create function public.qorpera_check_runtime_office_work_binding(p_startup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare activation public.qorpera_runtime_office_activations%rowtype; valid_ms bigint:=5000;
begin
    -- The existing lock helper authenticates service role and exact scope,
    -- allocation, boot, configuration and invocation against the CURRENT
    -- nonsuperseded activation. A predecessor on the same boot cannot use it.
    activation:=public.qorpera_lock_runtime_office_startup(p_startup);
    if activation.state<>'active' or activation.service_invocation_id is null then
        raise exception 'Office work binding differs' using errcode='42501'; end if;
    perform public.qorpera_assert_office_computer_work_ready(activation);
    if public.qorpera_company_paid_computer_mode((p_startup#>>'{scope,companyId}')::uuid) then
        -- Deduct the age of the canonical sample from the authority lifetime.
        -- A slow response must never extend its ten-second readiness window.
        select greatest(0,least(5000,floor(extract(epoch from least(
            (p.last_sample->>'observedAt')::timestamptz+interval '10 seconds',
            w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000))-clock_timestamp())*1000)))::bigint
        into valid_ms from public.qorpera_coding_computer_permits p
        join public.qorpera_coding_computer_windows w on w.permit_id=p.id and w.generation=p.generation
        where p.allocation_id=activation.allocation_id and p.state='bound' and public.qorpera_computer_work_ready(p.id);
        if coalesce(valid_ms,0)<1 then
            raise exception 'Office computer metering not ready' using errcode='55000'; end if;
    end if;
    return jsonb_build_object('state','authorized','computerGeneration',activation.computer_generation,'validForMs',valid_ms);
end $$;
revoke all on function public.qorpera_check_runtime_office_work_binding(jsonb)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_check_runtime_office_work_binding(jsonb) to service_role;

-- Only the new trusted definer receives execution on these private predicates.
do $$ declare owner_name name; helper regprocedure; begin
    select pg_get_userbyid(proowner) into strict owner_name from pg_proc
        where oid='public.qorpera_check_runtime_office_work_binding(jsonb)'::regprocedure and prosecdef;
    if owner_name in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Trusted work boundary owner required'; end if;
    foreach helper in array array[
        'public.qorpera_assert_office_computer_work_ready(public.qorpera_runtime_office_activations)'::regprocedure,
        'public.qorpera_computer_work_ready(uuid)'::regprocedure,
        'public.qorpera_company_paid_computer_mode(uuid)'::regprocedure,
        'public.qorpera_lock_runtime_office_startup(jsonb)'::regprocedure
    ] loop execute format('grant execute on function %s to %I',helper,owner_name); end loop;
end $$;
