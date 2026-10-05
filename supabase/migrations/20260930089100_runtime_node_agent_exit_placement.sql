-- Agent exit E2d, part 2 of 2: exit health in placement (20260930089100). Contract: section 19, 2026-10-03 amendment
-- "agent traffic leaves through the agent exit", item 10 (a node whose exit is not healthy takes no new agent road
-- machines; a machine that cannot move starts on its node). Needs part 1 (20260930089000) and, before it is applied,
-- every node's exit healthy through it and the node release whose providers wait on the new refusal
-- (deploy/agent-exit/ROLLOUT.md): there is no switch, so a node without a healthy exit takes no new Company Computer or
-- agent's machine from here on.
--
-- - qorpera_reserve_runtime_node_machine refuses NODE_AGENT_EXIT_UNHEALTHY for a new Company Computer (`office`) or
--   agent's machine (`machine`), and for the wake of an agent's machine (admission then moves it, as for a full node).
--   The wake of a Company Computer or of an agent's machine tied to its repository's node, and every coding machine,
--   pass: they cannot move (a Company Computer keeps its allocation, the others their repository's or member's
--   storage), so they start on their node, without internet while its exit is down. The check comes after the node's
--   observation: an observer that stopped reads as NODE_OBSERVATION_UNAVAILABLE, whose grace keeps a sleeping machine
--   on its node while the node may only be looking away;
-- - the candidates of new agents' machines, of new Company Computers and of new coding machines (the executor pick's
--   fresh branch) leave such a node out.

set local lock_timeout = '3s';

-- Not before every node's exit is healthy (deploy/agent-exit/ROLLOUT.md): there is no switch, so applied too early this
-- would keep every new Company Computer and agent's machine off a node. A database without such a node (a new one, a
-- test) passes.
do $guard$
begin
	if exists (select 1 from public.qorpera_runtime_nodes node where node.enabled
		and exists (select 1 from public.qorpera_runtime_node_providers provider where provider.node_id = node.id
			and provider.provider_kind in ('office', 'machine', 'coding'))
		and not public.qorpera_runtime_node_agent_exit_ready(node.id)) then
		raise exception 'Agent exit placement: an enabled node has no healthy, current exit (deploy/agent-exit/ROLLOUT.md)'
			using errcode = '55000';
	end if;
end
$guard$;

-- The demand's last refusal may now say NODE_AGENT_EXIT_UNHEALTHY.
do $check$
declare v_name text;
begin
	select constraint_row.conname into strict v_name
	from pg_constraint constraint_row
	where constraint_row.conrelid = 'public.qorpera_runtime_node_demands'::regclass and constraint_row.contype = 'c'
		and pg_get_constraintdef(constraint_row.oid) like '%last_refusal%';
	execute format('alter table public.qorpera_runtime_node_demands drop constraint %I', v_name);
end
$check$;
alter table public.qorpera_runtime_node_demands add constraint qorpera_runtime_node_demands_last_refusal_check
	check (last_refusal in ('NODE_DISABLED', 'NODE_OBSERVATION_UNAVAILABLE', 'NODE_HARDWARE_CHANGED',
		'NODE_CAPACITY_EXHAUSTED', 'COMPUTER_HOURS_EXHAUSTED', 'NODE_AGENT_EXIT_UNHEALTHY'));

-- Each patch names its anchor, which must be present exactly once, and carries this slot in the patched body.
create function pg_temp.agent_exit_placement_patch_20260930089100(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Agent exit placement: the anchor in % is not present exactly once', p_function;
	end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.agent_exit_placement_patch_20260930089100(
	'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
	$old$ then v_reason:='NODE_HARDWARE_CHANGED';$old$,
	$new$ then v_reason:='NODE_HARDWARE_CHANGED';
 -- Agent exit health (20260930089100): a new Company Computer or agent's machine, or an agent's machine's wake, needs
 -- the node's exit; a Company Computer's wake, a repository-tied machine's wake and every coding machine cannot move
 -- and pass.
 elsif p_provider_kind in ('office','machine') and (v_demand.reserved_at is null
  or (p_provider_kind='machine' and v_demand.suspended_at is not null and not exists(
   select 1 from public.qorpera_company_machine_placements placement
   join public.qorpera_company_machines machine on machine.id=placement.machine_id
   where placement.id=v_allocation.company_machine_placement_id and machine.repository_worker_id is not null)))
  and not public.qorpera_runtime_node_agent_exit_ready(v_node.id) then v_reason:='NODE_AGENT_EXIT_UNHEALTHY';$new$);

select pg_temp.agent_exit_placement_patch_20260930089100(
	'public.qorpera_company_machine_candidates(bigint,bigint,bigint,text,uuid)'::regprocedure,
	$old$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)$old$,
	$new$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
		-- Agent exit health (20260930089100).
		and public.qorpera_runtime_node_agent_exit_ready(node.id)$new$);

select pg_temp.agent_exit_placement_patch_20260930089100(
	'public.qorpera_coding_executor_pick(uuid)'::regprocedure,
	$old$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)$old$,
	$new$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
		-- Agent exit health (20260930089100): a new member's machine only; one with a machine, storage or a turn stays.
		and public.qorpera_runtime_node_agent_exit_ready(node.id)$new$);

select pg_temp.agent_exit_placement_patch_20260930089100(
	'public.qorpera_runtime_node_placement_candidates(text)'::regprocedure,
	$old$and public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)$old$,
	$new$and public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)
				-- Agent exit health (20260930089100): a new Company Computer needs the node's exit.
				and (p_provider_kind<>'office' or public.qorpera_runtime_node_agent_exit_ready(n.id))$new$);
