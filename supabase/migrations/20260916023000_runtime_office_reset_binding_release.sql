-- Office root reset: release the deleted root's node instance binding.
--
-- The node observer binds a managed allocation to its instance's physical
-- identity (volatile.uuid + configuration digest) once and afterwards reports
-- INSTANCE_AUTHORITY_DIFFERS when the instance differs. A governed reset
-- deletes the root and creates a new instance for the same allocation, but
-- the root_deleted acknowledgement kept the old binding: the recreated root
-- was reported as differing, the node stayed unavailable and the reset's
-- restored phase (which needs node admission before the first start) could
-- never proceed (D-OFFICE-RESET-1, isolated generation 10, 16 Sep 2026).
--
-- Acknowledging root_deleted now releases the binding of the deleted root;
-- the next node observation binds the recreated root as it binds any new
-- managed instance. The existing reviewed function is patched in place.
do $migration$
declare s text;
	old text:=E'\tif clock_timestamp()>=v_challenge.expires_at then raise exception ''Office reset acknowledgement expired'' using errcode=''42501''; end if;\n\treturn public.qorpera_runtime_office_reset_result(v_reset);';
	new text:=E'\tif clock_timestamp()>=v_challenge.expires_at then raise exception ''Office reset acknowledgement expired'' using errcode=''42501''; end if;\n\t-- The deleted root''s physical identity is released so the next node observation binds the recreated root.\n\tif v_challenge.phase=''root_deleted'' then\n\t\tdelete from public.qorpera_runtime_node_instance_bindings where allocation_id=v_reset.allocation_id; end if;\n\treturn public.qorpera_runtime_office_reset_result(v_reset);';
begin
	s:=pg_get_functiondef('public.qorpera_ack_runtime_office_reset_phase(jsonb,uuid,jsonb)'::regprocedure);
	if (length(s)-length(replace(s,old,'')))/length(old)<>1 then raise exception 'Reset ack source differs'; end if;
	execute replace(s,old,new);
end $migration$;
