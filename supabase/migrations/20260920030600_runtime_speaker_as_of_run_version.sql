-- A run whose agent was edited meanwhile still speaks under a name. The speaker
-- row kept the name only while the agent's version equalled the run's, so after
-- 20260920030500 let runs outlive edits, such a message had no name and clients
-- labelled it with the agent's raw id in rooms.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_capture_session_event_speaker()'::regprocedure), 'sha256'), 'hex') <> '0de8f4c3818053052f45948e04189cfe7880c81268a4132f31dc893617417071' then
		raise exception 'Reviewed function definition changed: qorpera_capture_session_event_speaker';
	end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.qorpera_capture_session_event_speaker()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if new.execution_kind='run' and new.session_input_id is null and new.event_type='message'
 and new.body #>> '{entry,message,role}'='assistant'
 and new.body #>> '{entry,delivery,schema}'='qorpera.agent-send/v1'
 and new.body #>> '{entry,delivery,phase}' in ('progress','final') then
  insert into public.qorpera_session_event_speakers(event_id,run_id,staff_agent_id,staff_version,display_name)
  select new.event_id,run.id,run.staff_agent_id,run.staff_version,
   -- An edit applies from the next run: a run speaks under the name recorded for
   -- its own version, also after its agent was renamed or otherwise edited meanwhile.
   case when staff.version=run.staff_version then staff.display_name else (
    select operation.payload ->> 'display_name' from public.qorpera_company_operations as operation
    where operation.profile_id=run.profile_id and operation.operation_type='staff_state'
     and operation.entity_id=run.staff_agent_id and operation.entity_version=run.staff_version
    order by operation.sequence desc limit 1) end
  from public.qorpera_execution_runs run
  join public.qorpera_shared_sessions session on session.id=new.session_id
   and session.profile_id=run.profile_id and session.environment_id=run.environment_id
  left join public.qorpera_profile_staff staff on staff.profile_id=run.profile_id and staff.staff_agent_id=run.staff_agent_id
  where run.id=new.execution_id and run.session_id=new.session_id;
  if not found then raise exception 'Public send speaker provenance is unavailable' using errcode='42501'; end if;
 end if;
 return new;
end $function$
;
