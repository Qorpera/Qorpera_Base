-- A stale billing retrieval lease is an application conflict. Preserve the
-- funding routine's security attributes/grants and genuine engine errors.
do $$
declare
    definition text := pg_get_functiondef('public.qorpera_apply_computer_invoice_funding(text,uuid,jsonb,boolean)'::regprocedure);
    anchor text := 'raise exception ''Billing retrieval lease unavailable'' using errcode=''40001''';
begin
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
        raise exception 'Reviewed invoice funding conflict source changed';
    end if;
    execute replace(definition,anchor,$replacement$raise sqlstate 'PGRST' using
        message=jsonb_build_object('code','QRC01','message','Billing retrieval lease unavailable','details',null,'hint',null)::text,
        detail='{"status":409,"headers":{}}'$replacement$);
end $$;
