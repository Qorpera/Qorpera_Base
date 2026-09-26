-- Hiring/default-delegation checks were added to existing definer functions.
-- Their owners can predate, and differ from, the migration role that owns the
-- new private helpers. Preserve the callers and grant only their reviewed
-- dependencies; API roles must not gain a direct helper entrypoint.
do $$
declare caller regprocedure; owner_name name; definer boolean;
begin
    foreach caller in array array[
        'public.qorpera_company_path_approved_actor(uuid,text)'::regprocedure,
        'public.qorpera_self_approve_organization_proposal(jsonb,uuid)'::regprocedure
    ] loop
        select pg_get_userbyid(proowner),prosecdef into strict owner_name,definer
        from pg_proc where oid=caller;
        if not definer or owner_name in ('anon','authenticated','service_role','qorpera_secret_broker') then
            raise exception 'Hiring caller must have a trusted SECURITY DEFINER owner: %',caller;
        end if;
        execute format('grant execute on function public.qorpera_agent_creatable_path_kind(text) to %I',owner_name);
        execute format('grant execute on function public.qorpera_assert_agent_default_delegation(uuid,uuid) to %I',owner_name);
    end loop;
end
$$;
