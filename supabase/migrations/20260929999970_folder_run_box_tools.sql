-- F3 step 2b-3 (deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"): the run box's tools, exec_command and
-- write_stdin, are runtime tools observed under their own names. Inert: no run offers them until the shared execution
-- service gives folder-v2 runs a box (QORPERA_SHARED_EXECUTION_RUN_BOX=on). No table, no lock target.

create function pg_temp.run_box_tools_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Run box tools integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.run_box_tools_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'read_event','send_mail',$old$,
	$new$'read_event','send_mail','exec_command','write_stdin',$new$);
