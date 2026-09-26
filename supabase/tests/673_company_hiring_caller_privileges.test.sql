begin;
-- The historical-upgrade driver separately moves these callers to a distinct
-- owner before helper creation and executes real company-path approval. This
-- check also protects ordinary installs from exposing either helper directly.
do $$
declare caller regprocedure; helper regprocedure; owner_name name; api_role name;
begin
    foreach helper in array array[
        'public.qorpera_agent_creatable_path_kind(text)'::regprocedure,
        'public.qorpera_assert_agent_default_delegation(uuid,uuid)'::regprocedure
    ] loop
        foreach api_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
            if has_function_privilege(api_role,helper,'EXECUTE') then
                raise exception 'Private hiring helper exposed to %: %',api_role,helper;
            end if;
        end loop;
        foreach caller in array array[
            'public.qorpera_company_path_approved_actor(uuid,text)'::regprocedure,
            'public.qorpera_self_approve_organization_proposal(jsonb,uuid)'::regprocedure
        ] loop
            select pg_get_userbyid(proowner) into strict owner_name from pg_proc where oid=caller and prosecdef;
            if not has_function_privilege(owner_name,helper,'EXECUTE') then
                raise exception 'Hiring caller % cannot invoke %',caller,helper;
            end if;
        end loop;
    end loop;
end
$$;
rollback;
