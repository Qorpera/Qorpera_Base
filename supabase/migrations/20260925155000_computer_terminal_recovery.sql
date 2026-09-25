-- Terminal settlement follows the original enrolled executor after the live
-- coding machine has moved on. This grants no prepare, bind or renewal rights.
-- Revoking that original enrollment still withdraws terminal authority.
create function public.qorpera_coding_computer_terminal_host(p_permit_id uuid,p_executor_secret text)
returns void language plpgsql security definer set search_path='' as $$
declare p public.qorpera_coding_computer_permits%rowtype;
    a public.qorpera_computer_prestart_attempts%rowtype; v_request jsonb; v_identity jsonb;
begin
    select * into strict p from public.qorpera_coding_computer_permits where id=p_permit_id;
    select * into a from public.qorpera_computer_prestart_attempts where permit_id=p.id;
    if not found then
        -- Existing legacy custody has no original prestart enrollment to use.
        perform public.qorpera_computer_executor_machine(p.allocation_id,p_executor_secret);
        return;
    end if;
    if a.kind<>'coding' or a.profile_id<>p.profile_id
        or a.identity->>'kind' is distinct from 'coding'
        or (a.identity->>'profileId')::uuid is distinct from p.profile_id
        or (a.identity->>'hostKeyId')::uuid is distinct from a.host_key_id
        or (a.identity#>>'{guard,permitId}')::uuid is distinct from p.id
        or (a.identity#>>'{guard,allocationId}')::uuid is distinct from p.allocation_id
        or a.identity#>>'{guard,instanceSha256}' is distinct from p.instance_sha256
        or (a.identity#>>'{guard,hostBootId}')::uuid is distinct from p.host_boot_id then
        raise exception 'Original terminal computer identity differs' using errcode='42501';
    end if;
    v_request:=a.prepare_request_text::jsonb||jsonb_build_object('prepareRequestText',a.prepare_request_text,
        'prestart',jsonb_build_object('guardIncarnationId',a.identity#>'{guard,guardIncarnationId}',
            'prepareSha256',a.identity#>'{guard,prepareSha256}'));
    v_identity:=public.qorpera_computer_prestart_identity(v_request,p_executor_secret,'coding');
    if v_identity is distinct from a.identity then
        raise exception 'Original terminal computer enrollment differs' using errcode='42501';
    end if;
end $$;

-- Keep the existing finish transaction, generation/predecessor checks, physical
-- stop requirement and settlement ledger. Only its authentication source moves.
do $$ declare definition text; original text:='perform public.qorpera_computer_executor_machine(p.allocation_id,p_executor_secret);'; begin
    definition:=pg_get_functiondef('public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure);
    if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
        raise exception 'Coding terminal authentication source changed'; end if;
    execute replace(definition,original,'perform public.qorpera_coding_computer_terminal_host(p.id,p_executor_secret);');
end $$;

revoke all on function public.qorpera_coding_computer_terminal_host(uuid,text)
    from public,anon,authenticated,service_role,qorpera_secret_broker;
-- SECURITY DEFINER owners may differ across hosted installations. Grant only
-- these reviewed private call edges; no API role can invoke the helper itself.
do $$ declare v_caller regprocedure; v_helper regprocedure; v_owner name; v_definer boolean; begin
    for v_caller,v_helper in select * from (values
        ('public.qorpera_finish_coding_computer_permit(jsonb,text)'::regprocedure,'public.qorpera_coding_computer_terminal_host(uuid,text)'::regprocedure),
        ('public.qorpera_coding_computer_terminal_host(uuid,text)'::regprocedure,'public.qorpera_computer_prestart_identity(jsonb,text,text)'::regprocedure),
        ('public.qorpera_coding_computer_terminal_host(uuid,text)'::regprocedure,'public.qorpera_computer_executor_machine(uuid,text)'::regprocedure)
    ) edge(caller,helper) loop
        select pg_get_userbyid(proowner),prosecdef into strict v_owner,v_definer from pg_proc where oid=v_caller;
        if not v_definer or v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
            raise exception 'Terminal computer helper requires a trusted SECURITY DEFINER caller: %',v_caller; end if;
        execute format('grant execute on function %s to %I',v_helper,v_owner);
    end loop;
end $$;
