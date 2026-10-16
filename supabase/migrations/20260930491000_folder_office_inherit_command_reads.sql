-- A command that outlived its run: F3 step 4, slice 4d-4e (deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md, "A
-- command that outlived its run"). Before a shell command's output reaches a run other than the one that started it,
-- that run takes in the command's view's reads (qorpera_folder_run_inherit_view_reads, C1b-3 §6: "when a run takes in
-- a view's output"). The office holds no run actor, so this wrapper finds the reading run itself: from the effect
-- receipt of the action that reads the output, whose office resource names its run.
-- - The reading action is on the command's screen, in the environment's office, and is not the command's own start.
--   Otherwise: "Folder inheritance read is not current" (42501).
-- - Its run's job is leased: the actor is the run's (as a command view's live run, 20260928539120). Otherwise "Run is
--   unavailable" (42501).
-- - The take-in is inherit_view_reads' own, with the reading action's receipt as the inherit id: a retry of the action
--   replays its answer, and each new read takes in what the view released since. It refuses a run of another agent or
--   member ("A run inherits only its own agent's and member's views"), the pause (55000) and a read the run can no
--   longer read ("A released read is no longer readable").
-- The office's caller is the platform (service role) only.
set local lock_timeout = '3s';

create function public.qorpera_folder_office_inherit_command_reads(p_environment_id uuid, p_shell_command_id uuid,
	p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_command public.qorpera_runtime_office_shell_commands%rowtype;
	v_resource public.qorpera_runtime_office_resources%rowtype;
	v_view uuid; v_actor jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_environment_id is null or p_shell_command_id is null or p_receipt_id is null then
		raise exception 'Folder inheritance is invalid' using errcode = '22023'; end if;
	select * into v_command from public.qorpera_runtime_office_shell_commands where id = p_shell_command_id;
	select * into v_resource from public.qorpera_runtime_office_resources where receipt_id = p_receipt_id;
	select v.id into v_view from public.qorpera_folder_views v
	where v.shell_command_id = p_shell_command_id and v.environment_id = p_environment_id;
	-- coalesce: a missing row must refuse, not compare to null.
	if not coalesce(v_view is not null and v_resource.screen_id = v_command.screen_id
			and v_resource.office_id = v_command.office_id and v_resource.receipt_id <> v_command.id
			and exists (select 1 from public.qorpera_runtime_offices o
				where o.id = v_command.office_id and o.environment_id = p_environment_id), false) then
		raise exception 'Folder inheritance read is not current' using errcode = '42501'; end if;
	select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
	into v_actor
	from public.qorpera_execution_runs r join public.qorpera_runner_jobs j on j.id = r.job_id
	where r.id = v_resource.run_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp();
	if v_actor is null then raise exception 'Run is unavailable' using errcode = '42501'; end if;
	return public.qorpera_folder_run_inherit_view_reads(p_environment_id, v_actor, v_view, p_receipt_id);
end $$;

revoke all on function public.qorpera_folder_office_inherit_command_reads(uuid, uuid, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_office_inherit_command_reads(uuid, uuid, uuid) to service_role;

-- Its owner (this migration's role) reaches what it reads and the take-in, which may have a private owner.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
	where oid = 'public.qorpera_folder_office_inherit_command_reads(uuid,uuid,uuid)'::regprocedure;
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception 'Office inherit function has an API owner'; end if;
	if not has_function_privilege(v_owner, 'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)', 'execute')
		or exists (select 1 from unnest(array['public.qorpera_runtime_office_shell_commands',
			'public.qorpera_runtime_office_resources', 'public.qorpera_folder_views', 'public.qorpera_runtime_offices',
			'public.qorpera_execution_runs', 'public.qorpera_runner_jobs']) t(name)
			where not has_table_privilege(v_owner, t.name, 'select')) then
		raise exception 'Office inherit function owner cannot reach the take-in'; end if;
end $$;
