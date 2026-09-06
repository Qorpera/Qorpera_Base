-- Same-assignment replay cannot revive terminal or expired native authority.
-- Rebinding remains exclusive to the recorded sponsor handoff and retains
-- the capacity recheck under the target connection's lock.
do $$
declare v_target regprocedure := 'public.qorpera_acquire_native_provider_connection_lease(uuid,uuid,text,uuid,text,integer)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target); v_old text; v_new text;
begin
	v_old := $old$		if v_lease.status <> 'active' and v_lease.job_id = v_job.id
			and public.qorpera_run_native_start_superseded(v_run.id) then$old$;
	v_new := $new$		if v_lease.status <> 'active' and v_lease.job_id = v_job.id
			and v_lease.runner_id <> p_runner_id and v_lease.assignment_id <> p_assignment_id
			and public.qorpera_run_native_start_superseded(v_run.id)
			and exists (select 1 from public.qorpera_execution_sponsor_handoffs handoff
				where handoff.run_id = v_run.id and handoff.job_id = v_job.id
					and handoff.binding_id = v_run.sponsor_binding_id and handoff.to_version = v_run.sponsor_version
					and handoff.from_connection_id = v_lease.provider_connection_id
					and handoff.to_connection_id = v_connection.id
					and handoff.from_connection_id <> handoff.to_connection_id) then$new$;
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Native lease handoff upgrade source differs'; end if;
	v_definition := replace(v_definition,v_old,v_new);
	v_old := $old$				lease_token_sha256 = p_lease_token_sha256, created_at = statement_timestamp(),$old$;
	v_new := $new$				status = 'active', released_at = null,
				lease_token_sha256 = p_lease_token_sha256, created_at = statement_timestamp(),$new$;
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Native lease rebind upgrade source differs'; end if;
	v_definition := replace(v_definition,v_old,v_new);
	v_old := E'\t\tif v_lease.job_id <> v_job.id';
	v_new := E'\t\tif v_lease.status <> ''active'' or v_lease.expires_at <= clock_timestamp() then\n\t\t\traise exception ''native provider lease is terminal or expired'' using errcode = ''55000'';\n\t\tend if;\n' || v_old;
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Native lease replay upgrade source differs'; end if;
	execute replace(v_definition,v_old,v_new);
end
$$;
