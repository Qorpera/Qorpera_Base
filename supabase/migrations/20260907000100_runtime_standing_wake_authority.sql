-- A handoff changes the run's effective sponsor, not the standing authority
-- that admitted its wake. Resolve only this run's recorded handoff chain.
create unique index qorpera_sponsor_handoff_target on public.qorpera_execution_sponsor_handoffs(run_id,to_version);

create function public.qorpera_wake_standing_sponsor_version(p_wake public.qorpera_wake_occurrences)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_version bigint := p_wake.sponsor_version;
 v_handoff public.qorpera_execution_sponsor_handoffs%rowtype; v_depth integer;
begin
 if p_wake.run_id is null then return v_version; end if;
 select * into v_run from public.qorpera_execution_runs where id=p_wake.run_id;
 if not found or v_run.sponsor_binding_id is distinct from p_wake.sponsor_binding_id
  or v_run.sponsor_version is distinct from v_version then return null; end if;
 for v_depth in 0..8 loop
  select * into v_handoff from public.qorpera_execution_sponsor_handoffs
  where run_id=v_run.id and to_version=v_version;
  if not found then return v_version; end if;
  if v_depth=8 or v_handoff.job_id<>v_run.job_id or v_handoff.binding_id<>v_run.sponsor_binding_id
   or not exists (
    select 1 from public.qorpera_execution_sponsor_versions source
    join public.qorpera_execution_sponsor_versions target on target.binding_id=source.binding_id
    join public.qorpera_provider_connections a on a.id=source.provider_connection_id
    join public.qorpera_provider_connections b on b.id=target.provider_connection_id
    where source.binding_id=v_run.sponsor_binding_id and source.version=v_handoff.from_version
     and target.version=v_handoff.to_version and a.id=v_handoff.from_connection_id
     and b.id=v_handoff.to_connection_id and a.profile_id=v_run.profile_id and b.profile_id=v_run.profile_id
     and a.provider=b.provider and a.owner_user_id is not distinct from b.owner_user_id
   ) then return null; end if;
  v_version:=v_handoff.from_version;
 end loop;
 return null;
end $$;
revoke all on function public.qorpera_wake_standing_sponsor_version(public.qorpera_wake_occurrences)
 from public,anon,authenticated,service_role,qorpera_secret_broker;

do $$
declare v_definition text; v_old text; v_new text;
begin
 v_definition:=pg_get_functiondef('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure);
 v_old:='v_revision public.qorpera_company_path_revisions%rowtype; v_path text;';
 v_new:=v_old || E'\n v_standing_version bigint := public.qorpera_wake_standing_sponsor_version(p_wake);';
 if strpos(v_definition,v_old)=0 then raise exception 'Wake authority declaration differs'; end if;
 v_definition:=replace(v_definition,v_old,v_new);
 v_old:=E'begin\n\tif p_wake.wake_schema';
 v_new:=$new$begin
 if v_standing_version is null then return false; end if;
 -- Hold source authority through the effect transaction. NOWAIT avoids a
 -- lock inversion with an editor already holding a routine and its File.
 -- Contention retries; a changed repeatable-read row fails serialization.
 if p_wake.wake_kind='routine' then
  perform 1 from public.qorpera_cloud_routines where id=p_wake.routine_id for share nowait;
 elsif p_wake.wake_kind='agent' then
  perform 1 from public.qorpera_staff_execution_authorities
  where profile_id=p_wake.profile_id and staff_agent_id=p_wake.staff_agent_id for share nowait;
 elsif p_wake.wake_kind='room' then
  perform 1 from public.qorpera_company_rooms where session_id=p_wake.session_id for share nowait;
  perform 1 from public.qorpera_company_room_members member
  join public.qorpera_company_rooms room on room.id=member.room_id
  where room.session_id=p_wake.session_id and member.principal_id in (p_wake.requested_by_user_id,p_wake.staff_agent_id)
  order by member.principal_kind,member.principal_id for share of member nowait;
 end if;
	if p_wake.wake_schema$new$;
 if strpos(v_definition,v_old)=0 then raise exception 'Wake authority entry differs'; end if;
 v_definition:=replace(v_definition,v_old,v_new);
 v_old:='sponsor_version = p_wake.sponsor_version';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>2 then
  raise exception 'Standing wake sponsor comparisons differ'; end if;
 v_definition:=replace(v_definition,v_old,'sponsor_version = v_standing_version');
 execute v_definition;

 v_definition:=pg_get_functiondef('public.qorpera_runtime_wake_policy(uuid)'::regprocedure);
 v_old:='and v.sponsor_binding_id = v_run.sponsor_binding_id and v.sponsor_version = v_run.sponsor_version';
 v_new:='and v.sponsor_binding_id = v_run.sponsor_binding_id and v.sponsor_version = public.qorpera_wake_standing_sponsor_version(v_wake)';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Routine wake policy sponsor comparison differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;

create function public.qorpera_run_wake_authorized(p_run_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
begin
 select * into v_run from public.qorpera_execution_runs where id=p_run_id;
 if not found then return false; end if;
 if v_run.job_type<>'agent_turn' or v_run.source_kind not in ('session_turn','wake','room_delivery') then return true; end if;
 select * into v_wake from public.qorpera_wake_occurrences where run_id=p_run_id;
 return found and public.qorpera_wake_authorized(v_wake)
  and public.qorpera_runtime_wake_policy(p_run_id)->>'kind' is not distinct from v_wake.wake_kind;
end $$;
revoke all on function public.qorpera_run_wake_authorized(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;

do $$
declare v_definition text; v_old text; v_new text;
begin
 v_definition:=pg_get_functiondef('public.qorpera_native_tool_locked_run(jsonb)'::regprocedure);
 v_old:=E'\treturn v_run;';
 v_new:=E'\tif not public.qorpera_run_wake_authorized(v_run.id) then\n\t\traise exception ''Admitted wake authority is unavailable'' using errcode = ''42501'';\n\tend if;\n' || v_old;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Native effect authority return differs'; end if;
 execute replace(v_definition,v_old,v_new);
 v_definition:=pg_get_functiondef('public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure);
 v_old:=E'begin\n';
 v_new:=v_old || E' if not public.qorpera_run_wake_authorized(p_run_id) then\n  raise exception ''Admitted wake authority is unavailable'' using errcode = ''42501'';\n end if;\n';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Wake effect guard entry differs'; end if;
 execute replace(v_definition,v_old,v_new);
 v_definition:=pg_get_functiondef('public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure);
 v_old:=E'\t-- Only completed, canonical receipts may cross an attempt boundary.';
 v_new:=E'\tif not public.qorpera_run_wake_authorized(v_run.id) then return null; end if;\n' || v_old;
 if strpos(v_definition,v_old)=0 then raise exception 'Handoff authority entry differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;

-- Existing upgraded functions retain their original owners and privileges.
do $$ declare v_owner name; begin
 for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
  'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
  'public.qorpera_runtime_wake_policy(uuid)'::regprocedure,'public.qorpera_native_tool_locked_run(jsonb)'::regprocedure,
  'public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure,'public.qorpera_handoff_run_sponsor(uuid,text)'::regprocedure
 ]) loop
  if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Wake authority has an API owner'; end if;
  execute format('grant execute on function public.qorpera_wake_standing_sponsor_version(public.qorpera_wake_occurrences),public.qorpera_run_wake_authorized(uuid) to %I',v_owner);
 end loop;
end $$;
