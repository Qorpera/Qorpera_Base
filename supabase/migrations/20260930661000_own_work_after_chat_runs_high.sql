-- 20260930661000: work that carries on from a member's chat runs at the effort of the agent's own work, not the chat's.
-- Jonas, 8 November 2026: "they should default to use high for their own work, while the low reasoning is only for
-- light conversations with users". Under 20260930532000 a run that carried on a chain (a worker's report, a machine
-- event or check-in, an office start) kept the effort of the chain's first run, so a chain a member's turn started ran
-- at the chat's effort: on Rumlig 15 worker reports and 2 machine events ran low on 7 November, among them the Product
-- Lead building the concept app the founder asked for in chat.
-- Now only a chain whose first run was a wake (a routine's, a coworker's message, an agent's own work) keeps that run's
-- effort, so a routine's chosen effort still carries through its chain. A chain a member's turn started takes rule 4:
-- the agent's agent.md effort, else the policy's `unattended` (high). The member's turn itself keeps its conversation's
-- effort (rule 2), unchanged.

set local lock_timeout = '3s';

create function pg_temp.ow_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930661000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.ow_replace('public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)',
	$old$			and origin.requested_by_user_id = p_run.requested_by_user_id;$old$,
	$new$			and origin.requested_by_user_id = p_run.requested_by_user_id
			-- 20260930661000: only a chain a wake started keeps its first run's effort; a member's chat starts none.
			and origin.source_kind = 'wake';$new$);
