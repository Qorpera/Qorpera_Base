-- Company state files, F2-1b parts A and B: what a folder-v2 run's context says about the company folder, and the login
-- setup a routine save needs first (§5 of deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md).
--
-- Inert for today's companies: a snapshot-v1 run's context is unchanged, byte for byte. A folder-v2 run's context
-- (once core C1c lets such a run's actor describe it) gains:
-- * folder: the agent's own folder name (agents/<handle>/, beside its agent.md: its memory and skills live there) and
--   its listed coworkers' by id. The runtime's cloudAgentFolder uses it; an agent without a folder (a row from before
--   the company's files) leaves it out, and the run keeps the folders by id;
-- * the company's name from the vision file's index. The copy on the company row waits for core C2's queue.
-- The vision itself, read in full with its version recorded, needs core C3's folder client and comes with it.
--
-- Part B: qorpera_prepare_routine_login, which the runtime's routine writer calls before it commits a routine file. A
-- routine version is paid by the saver's own login that pays for unattended work, and the commit reads that without a
-- lock (20260929310000). Setting such a login up takes the login FOR UPDATE and writes rows, as an agent's routine save
-- does today (qorpera_ensure_unattended_sponsor), so it happens here, in its own transaction, before the commit.

-- The folder-v2 facts of a run's agent, or null for a snapshot-v1 company: the company's name as its vision file says,
-- the agent's folder name, and the folder names of the coworkers the context lists (the same 50 active agents, by id).
create function public.qorpera_company_state_run_folder(p_environment_id uuid, p_staff_agent_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select case when f.core = 'folder-v2' then jsonb_build_object(
		'companyName', i.name,
		'agent', (select split_part(s.folder_path, '/', 2) from public.qorpera_profile_staff s
			where s.profile_id = f.profile_id and s.staff_agent_id = p_staff_agent_id and s.folder_environment_id = p_environment_id
				and s.folder_retired_at is null),
		'coworkers', coalesce((select jsonb_object_agg(c.staff_agent_id, split_part(c.folder_path, '/', 2))
			from (select s.staff_agent_id, s.folder_path, s.folder_environment_id, s.folder_retired_at
				from public.qorpera_profile_staff s
				where s.profile_id = f.profile_id and s.employment_status = 'active' and s.staff_agent_id <> p_staff_agent_id
				order by s.staff_agent_id limit 50) c
			where c.folder_environment_id = p_environment_id and c.folder_retired_at is null), '{}'::jsonb)) end
	from public.qorpera_company_files f
	left join public.qorpera_folder_company_index i on i.environment_id = f.environment_id
	where f.environment_id = p_environment_id
$$;

-- The run context: a folder-v2 company's name from its vision file, and its agents' folder names as `folder`, present
-- only when the agent has a folder (every other context keeps its exact shape, which older runtimes read closed).
do $$
declare v_definition text;
	v_anchors constant text[][] := array[
		array[$old$	v_history_count bigint; v_coworker_count bigint; v_result jsonb; v_continuation jsonb; v_recorded jsonb;
$old$, $new$	v_history_count bigint; v_coworker_count bigint; v_result jsonb; v_continuation jsonb; v_recorded jsonb; v_folder jsonb;
$new$],
		array[$old$	select name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;
$old$, $new$	select name into strict v_company_name from public.qorpera_profiles where id = v_run.profile_id;
	-- A folder-v2 company (F2-1b): its name as its vision file says, and its agents' folder names.
	v_folder := public.qorpera_company_state_run_folder(v_run.environment_id, v_run.staff_agent_id);
	v_company_name := coalesce(v_folder ->> 'companyName', v_company_name);
$new$],
		array[$old$			else jsonb_build_object('serviceTier',v_run.service_tier) end;
$old$, $new$			else jsonb_build_object('serviceTier',v_run.service_tier) end
		|| case when v_folder ->> 'agent' is null then '{}'::jsonb else jsonb_build_object('folder', v_folder - 'companyName') end;
$new$]];
	v_pair text[];
begin
	v_definition := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	foreach v_pair slice 1 in array v_anchors loop
		if (length(v_definition) - length(replace(v_definition, v_pair[1], ''))) / length(v_pair[1]) <> 1 then
			raise exception 'Run context anchor differs: %', left(v_pair[1], 60); end if;
		v_definition := replace(v_definition, v_pair[1], v_pair[2]);
	end loop;
	execute v_definition;
end
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

revoke all on function public.qorpera_company_state_run_folder(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_prepare_routine_login(jsonb) from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_prepare_routine_login(jsonb) to service_role;
