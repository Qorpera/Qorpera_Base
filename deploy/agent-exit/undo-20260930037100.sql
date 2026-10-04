-- Undo of migration 20260930037100 (agent exit health in placement): restores the four functions' text from before it,
-- exactly (each patch reversed, with the same check that its text is present exactly once). The demand's refusal list
-- keeps NODE_AGENT_EXIT_UNHEALTHY; nothing writes it once the patch is gone. Run as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f deploy/agent-exit/undo-20260930037100.sql
-- deploy/agent-exit/ROLLOUT.md, step 5. scripts/test-agent-exit-placement-undo.mjs (in the hosted-db suite) runs it after the
-- migration and compares the four functions, with their grants and owner, with what they were before it.

set local lock_timeout = '3s';

create function pg_temp.agent_exit_placement_undo(p_function regprocedure, p_patched text, p_original text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_patched, ''))) / length(p_patched) <> 1 then
		raise exception 'Agent exit placement undo: the patched text in % is not present exactly once', p_function;
	end if;
	execute replace(v_definition, p_patched, p_original);
end
$$;

select pg_temp.agent_exit_placement_undo(
	'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
	$new$ then v_reason:='COMPUTER_HOURS_EXHAUSTED';
 -- Agent exit health (20260930037100): a new Company Computer or agent's machine, or an agent's machine's wake, needs
 -- the node's exit; a Company Computer's wake and every coding machine cannot move and pass.
 elsif p_provider_kind in ('office','machine') and (v_demand.reserved_at is null
  or (p_provider_kind='machine' and v_demand.suspended_at is not null))
  and not public.qorpera_runtime_node_agent_exit_ready(v_node.id) then v_reason:='NODE_AGENT_EXIT_UNHEALTHY';$new$,
	$old$ then v_reason:='COMPUTER_HOURS_EXHAUSTED';$old$);

select pg_temp.agent_exit_placement_undo(
	'public.qorpera_company_machine_candidates(bigint,bigint,bigint,text,uuid)'::regprocedure,
	$new$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
		-- Agent exit health (20260930037100).
		and public.qorpera_runtime_node_agent_exit_ready(node.id)$new$,
	$old$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)$old$);

select pg_temp.agent_exit_placement_undo(
	'public.qorpera_coding_executor_pick(uuid)'::regprocedure,
	$new$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
		-- Agent exit health (20260930037100): a new member's machine only; one with a machine, storage or a turn stays.
		and public.qorpera_runtime_node_agent_exit_ready(node.id)$new$,
	$old$and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)$old$);

select pg_temp.agent_exit_placement_undo(
	'public.qorpera_runtime_node_placement_candidates(text)'::regprocedure,
	$new$and public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)
				-- Agent exit health (20260930037100): a new Company Computer needs the node's exit.
				and (p_provider_kind<>'office' or public.qorpera_runtime_node_agent_exit_ready(n.id))$new$,
	$old$and public.qorpera_runtime_node_inventory_ready(n.id,o.observation_id,n.version)$old$);
