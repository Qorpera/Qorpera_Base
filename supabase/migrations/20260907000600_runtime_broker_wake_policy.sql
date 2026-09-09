-- Policy data is shared by trusted validators without impersonating an API
-- caller. The public RPC keeps its service-role guard; the broker gains no RPC.
do $$
declare v_definition text; v_old text; v_owner name; v_signature regprocedure;
begin
 v_definition:=pg_get_functiondef('public.qorpera_runtime_wake_policy(uuid)'::regprocedure);
 v_old:=E'\tif auth.role() is distinct from ''service_role'' then\n\t\traise exception ''Wake policy authority is required'' using errcode = ''42501''; end if;\n';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Wake policy API guard differs'; end if;
 v_definition:=replace(v_definition,v_old,'');
 v_old:='FUNCTION public.qorpera_runtime_wake_policy(';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Wake policy signature differs'; end if;
 execute replace(v_definition,v_old,'FUNCTION public.qorpera_runtime_wake_policy_internal(');
 revoke all on function public.qorpera_runtime_wake_policy_internal(uuid)
  from public,anon,authenticated,service_role,qorpera_secret_broker;
 for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
  'public.qorpera_runtime_wake_policy(uuid)'::regprocedure,'public.qorpera_run_wake_authorized(uuid)'::regprocedure,
  'public.qorpera_wake_ancestry(uuid,uuid,uuid,uuid)'::regprocedure,'public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure
 ]) loop
  if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
   raise exception 'Wake policy validator has an API owner'; end if;
  execute format('grant execute on function public.qorpera_runtime_wake_policy_internal(uuid) to %I',v_owner);
 end loop;
 foreach v_signature in array array[
  'public.qorpera_run_wake_authorized(uuid)'::regprocedure,
  'public.qorpera_wake_ancestry(uuid,uuid,uuid,uuid)'::regprocedure,
  'public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure
 ] loop
  v_definition:=pg_get_functiondef(v_signature);
  v_old:='public.qorpera_runtime_wake_policy(';
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
   raise exception 'Trusted wake policy call differs: %',v_signature; end if;
  execute replace(v_definition,v_old,'public.qorpera_runtime_wake_policy_internal(');
 end loop;
 -- A receipt was admitted by the host earlier. Recheck stop, acknowledgement
 -- and final-output state when the broker authorizes the actual secret use.
 v_definition:=pg_get_functiondef('public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure);
 v_old:=E'\tv_grant := public.qorpera_native_connector_locked_grant(p_binding,p_grant_id);';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Broker grant validation differs'; end if;
 execute replace(v_definition,v_old,v_old || E'\n\tperform public.qorpera_assert_wake_work_allowed((p_binding->>''runId'')::uuid);');
end $$;

create or replace function public.qorpera_runtime_wake_policy(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Wake policy authority is required' using errcode='42501'; end if;
 return public.qorpera_runtime_wake_policy_internal(p_run_id);
end $$;
