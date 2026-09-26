-- Only the independently enrolled billing bridge can read or resolve ambiguous
-- commands. Neither user sessions nor ordinary service-role guests gain access.
do $$ declare definition text; anchor text; replacement text; begin
    definition:=pg_get_functiondef('public.qorpera_computer_billing_rpc(text,jsonb,text)'::regprocedure);
    anchor:='    v_allowed:=case p_method';
    replacement:=anchor||E'\n        when ''qorpera_describe_computer_billing_command'' then array[''p_command_id'']\n        when ''qorpera_recover_computer_billing_command'' then array[''p_command_id'',''p_proof'']';
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Recovery bridge allowlist differs'; end if;
    definition:=replace(definition,anchor,replacement);
    anchor:='    case p_method';
    replacement:=anchor||E'\n    when ''qorpera_describe_computer_billing_command'' then return public.qorpera_describe_computer_billing_command((p_args->>''p_command_id'')::uuid);\n    when ''qorpera_recover_computer_billing_command'' then return public.qorpera_recover_computer_billing_command((p_args->>''p_command_id'')::uuid,p_args->''p_proof'');';
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'Recovery bridge dispatch differs'; end if;
    execute replace(definition,anchor,replacement);
end $$;
