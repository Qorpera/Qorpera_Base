-- Application authority/version conflicts must not trigger PostgREST's engine
-- serialization retry. Preserve the existing QRC01 HTTP 409 contract, original
-- messages, function security attributes and grants. Genuine engine errors are
-- untouched; no serialization_failure handler or blanket wrapper is installed.
create function pg_temp.computer_application_conflict(p_source regprocedure,p_old text,p_message text)
returns void language plpgsql as $$
declare definition text:=pg_get_functiondef(p_source); replacement text;
begin
    if (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
        raise exception 'Reviewed computer conflict source changed: %',p_source; end if;
    replacement:=format($replacement$raise sqlstate 'PGRST' using message=jsonb_build_object('code','QRC01','message',%L,'details',null,'hint',null)::text,
        detail='{"status":409,"headers":{}}'$replacement$,p_message);
    execute replace(definition,p_old,replacement);
end $$;
select pg_temp.computer_application_conflict('public.qorpera_accept_computer_usage_ownership(uuid,uuid)',
    'raise exception ''Computer Usage owner changed; refresh before accepting'' using errcode = ''40001''','Computer Usage owner changed; refresh before accepting');
select pg_temp.computer_application_conflict('public.qorpera_finish_computer_billing_command(uuid,uuid,jsonb)',
    'raise exception ''Billing command lease unavailable'' using errcode=''40001''','Billing command lease unavailable');
select pg_temp.computer_application_conflict('public.qorpera_finish_computer_billing_sync(text,uuid,jsonb,jsonb)',
    'raise exception ''Billing retrieval lease unavailable'' using errcode=''40001''','Billing retrieval lease unavailable');
select pg_temp.computer_application_conflict('public.qorpera_reconcile_computer_subscription(text,timestamp with time zone,jsonb)',
    'raise exception ''Subscription event ordering is ambiguous'' using errcode=''40001''','Subscription event ordering is ambiguous');
select pg_temp.computer_application_conflict('public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)',
    'raise exception ''Computer permit generation unavailable'' using errcode=''40001''','Computer permit generation unavailable');
select pg_temp.computer_application_conflict('public.qorpera_apply_coding_computer_sample(uuid,bigint,jsonb,boolean)',
    'raise exception ''Paid observation predecessor differs'' using errcode=''40001''','Paid observation predecessor differs');
select pg_temp.computer_application_conflict('public.qorpera_finish_coding_computer_permit(jsonb,text)',
    'raise exception ''Computer generation changed'' using errcode=''40001''','Computer generation changed');
select pg_temp.computer_application_conflict('public.qorpera_finish_runtime_computer_permit(jsonb,text)',
    'raise exception ''Computer generation changed'' using errcode=''40001''','Computer generation changed');
