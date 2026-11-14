-- 20260930772000 (Claude Code on the agent's home, slice C4c; lanes/agent-box-20261113/C4-WORKER-DESIGN.md as the lane's
-- lead ruled it, 14 Nov 2026): a Claude Code worker works on its agent's own machine, with the agent's own rights there.
--
-- The home's sharing rule (qorpera_folder_home_shared, 20260930754000) gives a run a machine only when the run's worker
-- access equals that of the run that started the machine. The agent's own turn starts its home with no worker, so the
-- run of a Claude Code worker (C4a, 20260930770000) was refused its agent's machine (HOME_NOT_SHARED), while its dispatch
-- had checked the home as the dispatching run sees it. The founder's rule is that the machine is the agent's: Claude
-- Code's shell there is the agent's account with sudo, its files are the machine's own mount. So:
-- 1. A plain worker with harness claude-code and access write shares a machine of its own agent started for the member
--    who asked for it (the worker's member), by that agent's own run (no worker) or by a write worker, and only while
--    the agent and that member read the folder's root, as today (qorpera_claude_worker_on_home). Nothing else widens: a
--    Codex worker, a coding session (its access is read, and the table keeps claude-code to in-house workers,
--    20260930770000), a read worker and another member's run share exactly what they shared before.
-- 2. The dispatch refuses a Claude Code worker that is not write, and a follow-up of one, in words the agent can act on.
-- 3. The dispatch's home check (qorpera_claude_worker_home) asks the question the worker's run will ask
--    (qorpera_claude_worker_on_home), no longer the dispatching run's own sharing: a dispatch that passes is never a run
--    refused at the home for its sharing.
--
-- A write worker's rights in the folder are its agent's: the folder refuses writes only to a read worker
-- (qorpera_folder_actor_resource_allowed, 20260928259230), and a write worker's run reads and writes as its member and
-- its agent do. What a worker may not do is manage workers (contract 13), which nothing on the machine reaches.
--
-- Exact-text patches: each fails unless the function has the text given exactly once. Every new or patched body names
-- this migration (20260930772000).

set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_claude_worker_on_home(public.qorpera_company_machines, uuid, uuid)') is not null then
		raise exception 'Claude Code workers on the home (20260930772000) are already applied'; end if;
	if to_regprocedure('public.qorpera_claude_worker_home(uuid, uuid, uuid, uuid)') is null then
		raise exception 'Claude Code workers on the home (20260930772000) need 20260930770000 first'; end if;
end $$;

create function pg_temp.c4c_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C4c anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Which machine a Claude Code worker works on ----------------------------------------------------------------------

-- Whether a Claude Code worker of agent p_staff_agent_id, asked for by member p_member_user_id, works on p_machine: the
-- agent's own machine, started for that member by the agent's own run (no worker) or by a write worker, and only while
-- the agent and the member read the folder's root. A machine a read worker or a coding session started is not one.
-- Internal.
create function public.qorpera_claude_worker_on_home(p_machine public.qorpera_company_machines, p_staff_agent_id uuid,
	p_member_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930772000.
	select coalesce(p_machine.started_by_staff_agent_id = p_staff_agent_id
		and p_machine.requested_by_user_id = p_member_user_id
		and (public.qorpera_run_worker(p_machine.started_by_run_id)).access is distinct from 'read'
		and public.qorpera_folder_reads_root(p_machine.environment_id, p_machine.profile_id, p_staff_agent_id,
			p_member_user_id), false)
$$;
revoke all on function public.qorpera_claude_worker_on_home(public.qorpera_company_machines, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Whether the run p_run_id is a Claude Code worker's with write access, of agent p_staff_agent_id and asked for by
-- p_member_user_id, that works on p_machine. A claude-code worker is always in-house (the table's check, 20260930770000).
-- Internal.
create function public.qorpera_claude_worker_shares(p_machine public.qorpera_company_machines, p_staff_agent_id uuid,
	p_member_user_id uuid, p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930772000.
	select coalesce((select worker.harness = 'claude-code' and worker.access = 'write'
			and worker.staff_agent_id = p_staff_agent_id and worker.requested_by_user_id = p_member_user_id
		from public.qorpera_run_worker(p_run_id) worker), false)
		and public.qorpera_claude_worker_on_home(p_machine, p_staff_agent_id, p_member_user_id)
$$;
revoke all on function public.qorpera_claude_worker_shares(public.qorpera_company_machines, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The home's sharing rule: today's, or a Claude Code worker on its agent's machine.
select pg_temp.c4c_replace('public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)'::regprocedure,
	$old$			p_member_user_id), false)
$old$,
	$new$			p_member_user_id), false)
		-- 20260930772000: a Claude Code worker with write access works on its agent's machine with the agent's own rights.
		or public.qorpera_claude_worker_shares(p_machine, p_staff_agent_id, p_member_user_id, p_run_id)
$new$);

-- 2. The dispatch asks what the worker's run will ask --------------------------------------------------------------------

select pg_temp.c4c_replace('public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$				and public.qorpera_folder_home_shared(machine, p_staff_agent_id, p_member_user_id, p_run_id)$old$,
	$new$				-- 20260930772000: the machine the worker's run will share (qorpera_folder_home_shared's Claude Code branch),
				-- not the one the dispatching run shares.
				and public.qorpera_claude_worker_on_home(machine, p_staff_agent_id, p_member_user_id)$new$);

-- 3. Only with write access ------------------------------------------------------------------------------------------------

select pg_temp.c4c_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			elsif v_species = 'in-house' and v_request ? 'harness'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$old$,
	$new$			-- 20260930772000: Claude Code works on the agent's machine with the agent's own rights.
			elsif v_species = 'in-house' and v_request ? 'harness' and v_request ->> 'access' is distinct from 'write' then
				v_problem := 'Claude Code works on your machine with your own rights: dispatch it with write access, or without Claude Code';
			elsif v_species = 'in-house' and v_request ? 'harness'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$new$);

select pg_temp.c4c_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			elsif v_worker.harness = 'claude-code'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$old$,
	$new$			-- 20260930772000: and so does a follow-up of one.
			elsif v_worker.harness = 'claude-code' and v_worker.access is distinct from 'write' then
				v_problem := 'Claude Code works on your machine with your own rights: dispatch it with write access, or without Claude Code';
			elsif v_worker.harness = 'claude-code'
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then$new$);

-- The patched functions may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_claude_worker_shares(public.qorpera_company_machines,uuid,uuid,uuid)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Claude Code home function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_claude_worker_on_home(public.qorpera_company_machines, '
				'uuid, uuid), public.qorpera_claude_worker_shares(public.qorpera_company_machines, uuid, uuid, uuid) to %I',
				v_owner);
		end if;
	end loop;
end $$;

-- The deploy guard: every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)',
		'public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)',
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'
	]::regprocedure[] loop
		if position('20260930772000' in pg_get_functiondef(v_function)) = 0 then
			raise exception '% does not carry 20260930772000', v_function; end if;
	end loop;
end
$guard$;
