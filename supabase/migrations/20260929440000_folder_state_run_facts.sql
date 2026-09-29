-- Company state files, F2-1b parts A and B: the folder names a folder-v2 run's context gives, and the login setup a
-- routine save needs first (§5 of deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md).
--
-- Inert for today's companies: nothing here changes a snapshot-v1 run, and nothing calls either function yet.
--
-- Part A: qorpera_company_state_run_folder gives the folder names of a folder-v2 company's agents (agents/<handle>/,
-- beside each agent.md: its memory and skills live there). Core C1c-2 gives qorpera_describe_company_run_context its
-- folder-v2 body (RUNTIME-COMPANY-FOLDER-C1C.md §5.4); that body adds these as the context's `folder`, for the agent
-- and the coworkers it lists, when the agent has a folder. The runtime's cloudAgentFolder uses them. An agent without a
-- folder (a row from before the company's files) has none, and the run keeps the folders by id.
--
-- Part B: qorpera_prepare_routine_login, which the runtime's routine writer will call before it commits a routine file.
-- A routine version is paid by the saver's own login that pays for unattended work, and the commit reads that without a
-- lock (qorpera_company_state_routine_payer, #523). Setting such a login up takes the login FOR UPDATE and writes rows,
-- as an agent's routine save does today (qorpera_ensure_unattended_sponsor), so it happens here, in its own transaction,
-- before the commit. The consent and binding it records stay if the save is then refused; they are the default consent
-- an agent's save records today, and the next save uses them. It takes the run's job, then the login, as
-- qorpera_manage_agent_routine does, so it can meet a member switching that login off (40P01): the writer retries it.

-- The folder names of a run's agent and of the coworkers its context lists (p_coworkers: the same ids, so the folders
-- name no coworker the context does not), or null for a snapshot-v1 company or an agent without a folder. A coworker
-- without a folder is left out.
create function public.qorpera_company_state_run_folder(p_environment_id uuid, p_staff_agent_id uuid, p_coworkers uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('agent', split_part(s.folder_path, '/', 2),
		'coworkers', coalesce((select jsonb_object_agg(c.staff_agent_id, split_part(c.folder_path, '/', 2))
			from public.qorpera_profile_staff c
			where c.profile_id = f.profile_id and c.staff_agent_id = any (p_coworkers) and c.staff_agent_id <> p_staff_agent_id
				and c.folder_environment_id = p_environment_id and c.folder_retired_at is null), '{}'::jsonb))
	from public.qorpera_company_files f
	join public.qorpera_profile_staff s on s.profile_id = f.profile_id and s.staff_agent_id = p_staff_agent_id
		and s.folder_environment_id = p_environment_id and s.folder_retired_at is null
	where f.environment_id = p_environment_id and f.core = 'folder-v2'
$$;

-- Part B. The login a run's requester pays with for unattended work, set up as an agent's routine save does today: an
-- existing one that serves them, else their own connected login, consented and bound in their name. Null when they have
-- none (the routine save then waits for one). Nothing else changes, and a retry finds what the first call set up.
create function public.qorpera_prepare_routine_login(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_login jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null then raise exception 'Routine authority is unavailable' using errcode = '42501'; end if;
	select jsonb_build_object('bindingId', sponsor.binding_id, 'version', sponsor.version) into v_login
	from public.qorpera_ensure_unattended_sponsor(v_run) sponsor;
	return jsonb_build_object('schema', 'qorpera.routine-login/v1', 'runId', v_run.id, 'login', v_login);
end $$;

revoke all on function public.qorpera_company_state_run_folder(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_prepare_routine_login(jsonb) from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_prepare_routine_login(jsonb) to service_role;
