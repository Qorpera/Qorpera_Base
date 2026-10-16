-- A test machine's output takes in its reads: F3 step 6, slice 6d-3b (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md,
-- "Reads", rules 3 and 5). Before what a command on a test machine printed, or how it ended, reaches a run, that run
-- takes in the reads of the machine's view (qorpera_folder_run_inherit_view_reads, C1b-3 §6), as an office command's
-- output does (20260930491000). The machine executor holds no run actor, so this wrapper builds it, for the run whose
-- authorized read or cancel (qorpera_authorize_machine_command) gets the output.
-- - The placement is a test machine's, neither retired nor removed, and on the boot the executor read the output on.
--   Otherwise "Folder inheritance read is not current" (42501).
-- - The view is the placement's newest: a test machine's open carries the read set of the placement's newest view
--   (20260930420000), so the newest holds every read the disk was served. A placement that never had a view has none
--   to take in, and answers so (viewId null, reads 0).
-- - The run is in the machine's environment and its job is leased: the actor is the run's (as a command view's live
--   run, 20260928539120). Otherwise "Run is unavailable" (42501).
-- - The take-in is inherit_view_reads' own, idempotent per inherit id (the executor's, one per read). It refuses the
--   pause (55000) and a run without the company-wide view (20260930480000). A read the run can no longer read ("A
--   released read is no longer readable", "A read is no longer readable") comes back with the detail
--   "qorpera.test-machine/unreadable": the executor holds the output back and retires the placement (rule 5).
-- The caller is the machine executor (service role) only.
set local lock_timeout = '3s';

create function public.qorpera_folder_test_machine_inherit_reads(p_placement_id uuid, p_boot_id uuid, p_run_id uuid,
	p_inherit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_view uuid; v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_placement_id is null or p_boot_id is null or p_run_id is null or p_inherit_id is null then
		raise exception 'Folder inheritance is invalid' using errcode = '22023'; end if;
	select * into v_placement from public.qorpera_company_machine_placements where id = p_placement_id;
	select * into v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	-- coalesce: a missing row must refuse, not compare to null.
	if not coalesce(v_machine.id is not null and v_placement.retired_at is null and v_placement.removed_at is null
			and v_placement.boot_id = p_boot_id, false) then
		raise exception 'Folder inheritance read is not current' using errcode = '42501'; end if;
	select v.id into v_view from public.qorpera_folder_views v
	where v.kind = 'test_machine' and v.placement_id = v_placement.id and v.environment_id = v_machine.environment_id
	order by v.created_at desc, v.id desc limit 1;
	select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
	into v_actor
	from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
	where r.id = p_run_id and r.environment_id = v_machine.environment_id and j.status = 'leased'
		and j.lease_expires_at > clock_timestamp();
	if v_actor is null then raise exception 'Run is unavailable' using errcode = '42501'; end if;
	if v_view is null then
		return jsonb_build_object('schema','qorpera.folder-inherit/v1','inheritId',p_inherit_id,'viewId',null,'reads',0,
			'replay',false);
	end if;
	begin
		return public.qorpera_folder_run_inherit_view_reads(v_machine.environment_id, v_actor, v_view, p_inherit_id);
	exception when insufficient_privilege then
		if sqlerrm in ('A released read is no longer readable', 'A read is no longer readable') then
			raise exception '%', sqlerrm using errcode = '42501', detail = 'qorpera.test-machine/unreadable'; end if;
		raise;
	end;
end $$;

revoke all on function public.qorpera_folder_test_machine_inherit_reads(uuid, uuid, uuid, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_test_machine_inherit_reads(uuid, uuid, uuid, uuid) to service_role;

-- Its owner (this migration's role) reaches what it reads and the take-in, which may have a private owner.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
	where oid = 'public.qorpera_folder_test_machine_inherit_reads(uuid,uuid,uuid,uuid)'::regprocedure;
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'Test machine inherit function has an API owner'; end if;
	if not has_function_privilege(v_owner, 'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)', 'execute')
		or exists (select 1 from unnest(array['public.qorpera_company_machine_placements',
			'public.qorpera_company_machines', 'public.qorpera_folder_views', 'public.qorpera_execution_runs',
			'public.qorpera_runner_jobs']) t(name)
			where not has_table_privilege(v_owner, t.name, 'select')) then
		raise exception 'Test machine inherit function owner cannot reach the take-in'; end if;
end $$;
