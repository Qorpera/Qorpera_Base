-- Interim: the deployed runtime bundle's wake-envelope parser accepts only the
-- optional/optional room policy (parseCloudWakePolicy). Until a runtime bundle
-- with the agent-thread policy is active, room wakes into an agent thread carry
-- the standard room policy again; the thread's purpose asks the agent to answer
-- every post. 20260917050000 introduced the required final for bound rooms.
do $$
declare v_definition text; v_old text; v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure);
	v_old := $old$if v_wake.wake_kind = 'room' and exists (select 1 from public.qorpera_company_rooms room
		where room.session_id = v_wake.session_id and room.bound_staff_agent_id = v_wake.staff_agent_id) then
		v_reporting := 'required'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$old$;
	v_new := 'return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);';
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Agent thread policy clause differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$$;
