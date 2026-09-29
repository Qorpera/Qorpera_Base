-- Company state files, F2-1b part A: what a folder-v2 run's context says about the company folder (§5 of
-- deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md).
--
-- Inert for today's companies: a snapshot-v1 run's context is unchanged, byte for byte. A folder-v2 run's context
-- (once core C1c lets such a run's actor describe it) gains:
-- * folder: the agent's own folder name (agents/<handle>/, beside its agent.md: its memory and skills live there) and
--   its listed coworkers' by id. The runtime's cloudAgentFolder uses it; an agent without a folder (a row from before
--   the company's files) leaves it out, and the run keeps the folders by id;
-- * the company's name from the vision file's index. The copy on the company row waits for core C2's queue.
-- The vision itself, read in full with its version recorded, needs core C3's folder client and comes with it.

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

revoke all on function public.qorpera_company_state_run_folder(uuid, uuid) from public, anon, authenticated, service_role;
