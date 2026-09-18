-- Runtime bundle v28 is active: its wake-envelope parser honours a required final
-- for room wakes (parseCloudWakePolicy room branch). Restore the agent-thread
-- clause that 20260917051000 removed as an interim: a room wake into a room bound
-- to the woken agent reports required, so the agent answers every post.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure);
	v_old := 'return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);';
	v_new := $new$if v_wake.wake_kind = 'room' and exists (select 1 from public.qorpera_company_rooms room
		where room.session_id = v_wake.session_id and room.bound_staff_agent_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Runtime wake policy return differs'; end if;
	if position('bound_staff_agent_id' in v_definition) > 0 then
		raise exception 'Agent thread policy clause already present'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
