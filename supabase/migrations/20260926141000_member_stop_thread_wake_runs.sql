-- A member's Stop stops the run the agent is on in the displayed conversation,
-- whatever woke it.
--
-- A routine run is a wake run (source_kind 'wake') in its agent's thread, and so
-- are a coworker message's run in the receiver's thread and a worker report's
-- continuation in its parent's conversation. The conversation run control
-- (qorpera_get_session_run_control, qorpera_cancel_session_run) only saw a
-- member's own turns ('session_turn'), so the web's Stop never offered these
-- runs: a routine run could not be stopped from the web, and a loop between two
-- agents had no member Stop although the contract names it as the way to end one
-- (5.3, 14.6). With dynamic routines (PR #314) a member's Stop of a routine run
-- also pauses that routine once; it keys on the cancelled_by_user_id set below.
--
-- Authority is unchanged: the member may write the conversation and either
-- created the run's job (for a routine run, the member who saved the routine
-- version; for an agent wake, the member its causal chain runs for) or is an
-- owner or admin, the rule of qorpera_cancel_runner_job_profile_scope. The
-- cancellation still goes through qorpera_cancel_runner_job, which records the
-- member in cancelled_by_user_id. Room deliveries, proposal reviews and
-- sessionless work (worker runs, office activations) are not conversation runs
-- here and stay out.
--
-- Both functions are edited in place through their current text, so each keeps
-- its ACL (the read and the member cancel are granted to authenticated; the
-- profile-scope cancel stays internal).

create function pg_temp.stop_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Conversation Stop patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.stop_patch('public.qorpera_get_session_run_control(uuid)',
	$old$and run.source_kind = 'session_turn' and job.status in ('queued','leased')$old$,
	$new$and run.source_kind in ('session_turn','wake') and job.status in ('queued','leased')$new$);

select pg_temp.stop_patch('public.qorpera_cancel_session_run_profile_scope(uuid,uuid)',
	$old$and run.staff_agent_id::text = v_session.staff_agent_id and run.source_kind = 'session_turn'$old$,
	$new$and run.staff_agent_id::text = v_session.staff_agent_id and run.source_kind in ('session_turn','wake')$new$);
