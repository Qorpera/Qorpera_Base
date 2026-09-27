-- A member's Stop in a conversation reaches the agent's runs there, not only the
-- member turns of a plain conversation.
--
-- The conversation run control (qorpera_get_session_run_control,
-- qorpera_cancel_session_run) only saw 'session_turn' runs. In an agent's own
-- thread every run is something else: a member's message there is a room post
-- ('room_delivery'), and a routine run, the answer to a coworker message and a
-- worker report's continuation are wake runs ('wake'). So the web's Stop never
-- offered a routine run, a member could not stop the reply to their own message
-- in the agent's thread, and a loop between two agents had no member Stop
-- although the contract names it as the way to end one (5.3, 14.6). With dynamic
-- routines (PR #314) a member's Stop of a routine run also pauses that routine
-- once; it keys on the cancelled_by_user_id that this path records.
--
-- Authority is unchanged: the member may write the conversation and either
-- created the run's job (the member who posted; for a routine run, the member who
-- saved the routine version or for whom its agent set it up; for an agent wake,
-- the member its causal chain runs for) or is an owner or admin, the rule of
-- qorpera_cancel_runner_job_profile_scope. The cancellation still goes through
-- qorpera_cancel_runner_job. A run must match the conversation, its company,
-- environment and agent, so team rooms (no agent) and work without a
-- conversation (worker runs, office activations) stay out, and so do proposal
-- reviews (not listed).
--
-- When several runs are live, the read names one the member may stop before one
-- they may not, then the working one, then the oldest: a contributor keeps the
-- Stop for their own queued message while another member's routine run works.
-- For an owner or admin every run qualifies, so it is the working run.
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
	$new$and run.source_kind in ('session_turn','room_delivery','wake') and job.status in ('queued','leased')$new$);
select pg_temp.stop_patch('public.qorpera_get_session_run_control(uuid)',
	$old$order by (job.status = 'leased') desc,job.created_at,run.id limit 1;$old$,
	$new$order by (job.created_by_user_id = auth.uid() or exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = v_session.profile_id and member.user_id = auth.uid()
			and member.role in ('owner','admin'))) is true desc,
		(job.status = 'leased') desc,job.created_at,run.id limit 1;$new$);

select pg_temp.stop_patch('public.qorpera_cancel_session_run_profile_scope(uuid,uuid)',
	$old$and run.staff_agent_id::text = v_session.staff_agent_id and run.source_kind = 'session_turn'$old$,
	$new$and run.staff_agent_id::text = v_session.staff_agent_id and run.source_kind in ('session_turn','room_delivery','wake')$new$);
