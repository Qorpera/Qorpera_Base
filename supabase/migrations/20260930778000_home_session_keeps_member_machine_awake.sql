set local lock_timeout = '3s';

do $$
declare
	v_function regprocedure := 'public.qorpera_company_machine_member_only(public.qorpera_company_machines)';
	v_definition text := pg_get_functiondef(v_function);
	v_anchor text := $old$			and receipt.result #>> '{content,value,machine,machineId}' = p_machine.id::text) then
		return false; end if;
	return true;
end $old$;
	v_owner name;
begin
	if position('20260930759000' in v_definition) = 0 then
		raise exception '20260930778000 needs 20260930759000''s qorpera_company_machine_member_only'; end if;
	if position('qorpera_company_home_sessions' in v_definition) > 0 then
		raise exception '20260930778000 is already applied'; end if;
	if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
		raise exception '20260930778000 anchor differs in %', v_function; end if;
	execute replace(v_definition, v_anchor, $new$			and receipt.result #>> '{content,value,machine,machineId}' = p_machine.id::text) then
		return false; end if;
	if exists (select 1 from public.qorpera_company_home_sessions home
		join public.qorpera_execution_runs run on run.id = home.run_id
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where home.machine_id = p_machine.id and home.closed_at is null and job.status in ('queued', 'leased')) then
		return false; end if;
	return true;
end $new$);
	select pg_get_userbyid(proowner) into v_owner from pg_proc where oid = v_function;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_company_home_sessions to %I', v_owner); end if;
	if strpos((select prosrc from pg_proc where oid = v_function), 'qorpera_company_home_sessions') = 0
		or strpos((select prosrc from pg_proc where oid = v_function), '20260930759000') = 0 then
		raise exception '20260930778000: the patched body is not what it should be'; end if;
end $$;
