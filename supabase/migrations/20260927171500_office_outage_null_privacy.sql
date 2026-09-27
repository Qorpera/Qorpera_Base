-- Snapshot construction serializes a fresh office's SQL NULL challenge as
-- explicit JSON null. Normalize only the current column: a missing snapshot
-- key must still differ, and every other privacy/authority fence is unchanged.
do $$ declare target regprocedure; definition text; previous_owner oid; previous_acl aclitem[];
    previous_security_definer boolean; previous_config text[];
    old_expression text:=$old$c.privacy_challenge is distinct from r.snapshot->'privacyChallenge'$old$;
    new_expression text:=$new$coalesce(c.privacy_challenge,'null'::jsonb) is distinct from r.snapshot->'privacyChallenge'$new$;
begin
    foreach target in array array[
        'public.qorpera_check_runtime_office_outage_configuration(jsonb,text)'::regprocedure,
        'public.qorpera_check_office_outage_successor_startup(public.qorpera_runtime_office_activations)'::regprocedure,
        'public.qorpera_prepare_runtime_office_outage_successor(jsonb,text)'::regprocedure
    ] loop
        definition:=pg_get_functiondef(target);
        if length(definition)-length(replace(definition,old_expression,''))<>length(old_expression) then
            raise exception 'Expected exactly one office outage privacy comparison in %',target;
        end if;
        select proowner,proacl,prosecdef,proconfig into strict previous_owner,previous_acl,previous_security_definer,previous_config
            from pg_proc where oid=target;
        -- CREATE OR REPLACE preserves identity, ownership and existing grants.
        execute replace(definition,old_expression,new_expression);
        if not exists(select 1 from pg_proc where oid=target and proowner=previous_owner
            and proacl is not distinct from previous_acl and prosecdef=previous_security_definer
            and proconfig is not distinct from previous_config) then
            raise exception 'Office outage privacy patch changed function authority: %',target;
        end if;
    end loop;
end $$;
