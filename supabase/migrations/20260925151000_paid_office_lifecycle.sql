-- Protected office capacity preparation creates a stopped computer only.
-- Paid power-on remains gated by the separately funded generic permit and the
-- exact initial-adoption, explicit-resume, or reset-phase authority below.
do $$
declare definition text:=pg_get_functiondef('public.qorpera_reserve_runtime_office_start_unbound(jsonb,bigint,uuid,uuid,text,text,text,text)'::regprocedure);
begin
    if position('public.qorpera_reserve_runtime_machine(' in definition)=0 then raise exception 'Office reservation source differs'; end if;
    definition:=replace(definition,'FUNCTION public.qorpera_reserve_runtime_office_start_unbound(',
        'FUNCTION public.qorpera_reserve_paid_office_start_internal(');
    execute replace(definition,'public.qorpera_reserve_runtime_machine(','public.qorpera_reserve_paid_runtime_machine_internal(');
end $$;

create function public.qorpera_paid_office_admission(p_request jsonb,p_executor_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare k public.qorpera_runtime_computer_host_keys%rowtype; a jsonb:=p_request->'start'; v_profile uuid; v_result jsonb;
begin
    k:=public.qorpera_runtime_computer_host(p_request,p_executor_secret);
    if k.provider_kind<>'office' or k.backend<>'lxd' or p_request->>'action' is null or p_request->>'action' not in ('reserve','node')
        or not public.qorpera_screen_metadata_object(a,array['p_provider_id','p_provider_policy_sha256','p_scope',
            'p_computer_generation','p_intent_id','p_allocation_id','p_instance_sha256','p_provider_binding_sha256','p_image_sha256','p_bootstrap_sha256'])
        or a->>'p_provider_id' is distinct from k.provider_id or a->>'p_provider_policy_sha256' is distinct from k.policy_sha256
        or a->>'p_bootstrap_sha256' is distinct from k.bootstrap_sha256 or a->>'p_allocation_id' is distinct from p_request->>'allocationId'
        or a->>'p_instance_sha256' is distinct from p_request->>'instanceSha256'
        or a#>>'{p_scope,companyComputerId}' is distinct from p_request->>'officeId'
        or a->'p_computer_generation' is distinct from p_request->'computerGeneration' then
        raise exception 'Paid office preparation scope differs' using errcode='42501'; end if;
    v_profile:=public.qorpera_runtime_computer_profile(p_request);
    perform public.qorpera_lock_profile_gc_fence(v_profile);
    perform 1 from public.qorpera_profiles where id=v_profile for update;
    if not public.qorpera_company_paid_computer_mode(v_profile) then return '{"mode":"shadow"}'::jsonb; end if;
    perform public.qorpera_assert_runtime_office_provider(a->'p_scope',(a->>'p_computer_generation')::bigint,
        (a->>'p_provider_id')::uuid,a->>'p_provider_policy_sha256',true);
    if p_request->>'action'='reserve' then
        v_result:=public.qorpera_reserve_paid_office_start_internal(a->'p_scope',(a->>'p_computer_generation')::bigint,
            (a->>'p_intent_id')::uuid,(a->>'p_allocation_id')::uuid,a->>'p_instance_sha256',a->>'p_image_sha256',
            a->>'p_bootstrap_sha256',a->>'p_provider_binding_sha256');
    else
        perform public.qorpera_check_runtime_office_start(a->'p_scope',(a->>'p_computer_generation')::bigint,
            (a->>'p_intent_id')::uuid,(a->>'p_allocation_id')::uuid,a->>'p_instance_sha256',a->>'p_provider_binding_sha256',
            (a->>'p_provider_id')::uuid,a->>'p_provider_policy_sha256');
        v_result:=public.qorpera_reserve_paid_runtime_node_internal((a->>'p_allocation_id')::uuid,'office',k.provider_id,k.policy_sha256,
            a->>'p_instance_sha256',k.machine_id_sha256,k.cpu_millis,k.memory_bytes);
    end if;
    return jsonb_build_object('mode','paid','result',v_result);
end $$;

create or replace function public.qorpera_authorize_paid_office_start(p_request jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare i jsonb:=p_request->'officeIntent'; b jsonb; result jsonb; a jsonb; office public.qorpera_runtime_offices%rowtype;
begin
    if auth.role() is distinct from 'service_role' or jsonb_typeof(i) is distinct from 'object' then
        raise exception 'Paid office lifecycle intent required' using errcode='42501'; end if;
    select * into strict office from public.qorpera_runtime_offices where id=(p_request->>'officeId')::uuid for update;
    if i->>'kind'='initial' then
        if not public.qorpera_screen_metadata_object(i,array['kind','intentId','providerBindingSha256','mappings']) then
            raise exception 'Invalid paid initial boot intent' using errcode='22023'; end if;
        if exists(select 1 from public.qorpera_runtime_office_activations where allocation_id=(p_request->>'allocationId')::uuid)
            or exists(select 1 from public.qorpera_runtime_computer_contexts where request_identity->>'allocationId'=p_request->>'allocationId') then
            raise exception 'Paid initial boot already attempted; recovery required' using errcode='42501'; end if;
        perform public.qorpera_check_runtime_office_adoption(public.qorpera_runtime_office_scope(office),
            (p_request->>'computerGeneration')::bigint,(i->>'intentId')::uuid,(p_request->>'allocationId')::uuid,
            p_request->>'instanceSha256',i->>'providerBindingSha256',(p_request->>'providerId')::uuid,p_request->>'policySha256',i->'mappings');
        return;
    elsif i->>'kind'='resume' then
        if not public.qorpera_screen_metadata_object(i,array['kind','request']) then raise exception 'Invalid paid resume intent' using errcode='22023'; end if;
        b:=i#>'{request,predecessor}';
        result:=public.qorpera_check_runtime_office_boot_intent(i->'request');
        if result->>'state' is distinct from 'prepared' then raise exception 'Office resume already admitted' using errcode='42501'; end if;
        if exists(select 1 from public.qorpera_runtime_computer_contexts where request_identity#>>'{officeIntent,request,bootIntentId}'=i#>>'{request,bootIntentId}') then
            raise exception 'Paid resume already attempted; recovery required' using errcode='42501'; end if;
    elsif i->>'kind'='reset' then
        if not public.qorpera_screen_metadata_object(i,array['kind','plan']) then raise exception 'Invalid paid reset intent' using errcode='22023'; end if;
        b:=i#>'{plan,predecessor}';
        perform public.qorpera_gate_runtime_office_reset_phase(public.qorpera_lock_runtime_office_reset(i->'plan',false),'restored');
        if p_request->>'requestId' is distinct from i#>>'{plan,commands,startCommandId}' then
            raise exception 'Paid reset start phase differs' using errcode='42501'; end if;
    else raise exception 'Unsupported paid office lifecycle intent' using errcode='42501'; end if;
    a:=b->'startup';
    if a->'scope' is distinct from public.qorpera_runtime_office_scope(office)
        or a->>'allocationId' is distinct from p_request->>'allocationId' or a->>'instanceSha256' is distinct from p_request->>'instanceSha256'
        or a->'computerGeneration' is distinct from p_request->'computerGeneration'
        or b->>'providerId' is distinct from p_request->>'providerId' or b->>'providerPolicySha256' is distinct from p_request->>'policySha256' then
        raise exception 'Paid office lifecycle source differs' using errcode='42501'; end if;
end $$;

revoke all on function public.qorpera_reserve_paid_office_start_internal(jsonb,bigint,uuid,uuid,text,text,text,text),
    public.qorpera_authorize_paid_office_start(jsonb),public.qorpera_paid_office_admission(jsonb,text)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_paid_office_admission(jsonb,text) to service_role;
