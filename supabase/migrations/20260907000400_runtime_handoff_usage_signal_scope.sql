-- Each sponsor epoch can exhaust a different connection. Retain previous
-- signals while deduplicating retries within the current sponsor version.
do $$ declare v_constraint name; begin
 select conname into strict v_constraint from pg_constraint
 where conrelid='public.qorpera_provider_connection_usage_signals'::regclass
  and contype='u' and pg_get_constraintdef(oid)='UNIQUE (run_id, signal_kind)';
 execute format('alter table public.qorpera_provider_connection_usage_signals drop constraint %I',v_constraint);
end $$;
alter table public.qorpera_provider_connection_usage_signals
 add constraint qorpera_usage_signal_sponsor_epoch unique(run_id,sponsor_version,signal_kind);
do $$
declare v_definition text:=pg_get_functiondef('public.qorpera_record_provider_usage_signal(jsonb,text,timestamptz)'::regprocedure);
 v_old text; v_new text;
begin
 v_old:='on conflict (run_id,signal_kind) do nothing';
 v_new:='on conflict (run_id,sponsor_version,signal_kind) do nothing';
 if strpos(v_definition,v_old)=0 then raise exception 'Usage signal replay scope differs'; end if;
 v_definition:=replace(v_definition,v_old,v_new);
 v_old:='where run_id = v_run.id and signal_kind = p_signal_kind;';
 v_new:='where run_id = v_run.id and sponsor_version = v_run.sponsor_version and signal_kind = p_signal_kind;';
 if strpos(v_definition,v_old)=0 then raise exception 'Usage signal lookup scope differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;
