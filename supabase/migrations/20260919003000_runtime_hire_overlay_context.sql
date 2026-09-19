-- Step 10 distinguishes the canonical company Co-Founder from an employee's
-- editable name, role or charter. Keep the admitted, pageable job specification
-- and all existing context authority/continuation checks unchanged.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$'schema','qorpera.native-company-context/v1'$old$;
	v_new := $new$'schema','qorpera.native-company-context/v2'$new$;
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Hire overlay context schema clause differs'; end if;
	v_definition := replace(v_definition,v_old,v_new);
	v_old := $old$'agent',jsonb_build_object('id',v_staff.staff_agent_id,'version',v_staff.version,'name',v_staff.display_name,'role',v_staff.role),$old$;
	v_new := $new$'agent',jsonb_build_object('id',v_staff.staff_agent_id,'version',v_staff.version,'name',v_staff.display_name,'role',v_staff.role),
		'agentKind',case when exists (select 1 from public.qorpera_company_cofounders cofounder
			where cofounder.profile_id = v_run.profile_id and cofounder.staff_agent_id = v_run.staff_agent_id)
			then 'cofounder' else 'employee' end,
		-- Match the canonical progress receipt used by the wake work gate,
		-- including its exact conversation. A sponsor change keeps the run
		-- and its sends; another assignment does not require another greeting.
		'initialAcknowledgementSatisfied',exists (
			select 1 from public.qorpera_agent_sends send
			join public.qorpera_session_events event on event.event_id = send.event_id
			where send.run_id = v_run.id and event.execution_id = v_run.id
				and send.session_id = v_run.session_id and event.session_id = v_run.session_id
				and send.phase = 'progress'),$new$;
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Hire overlay context agent clause differs'; end if;
	execute replace(v_definition,v_old,v_new);
end
$$;
