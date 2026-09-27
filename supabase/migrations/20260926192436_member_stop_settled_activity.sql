-- A run a member stopped is not a failure.
--
-- qorpera_list_staff_execution_activity reports one run per agent and ranks a
-- failed or cancelled run (3) above the run the agent is working on (2), so an
-- undismissed failure stands for the agent until a member dismisses it. A
-- cancelled job is always a member's Stop: the job table ties status
-- 'cancelled' to cancelled_at and cancelled_at to cancelled_by_user_id, and
-- only the member cancellation (qorpera_cancel_runner_job, which the
-- conversation Stop calls) sets them. A stopped wake already dropped out,
-- because its occurrence ends 'cancelled'. A stopped member turn
-- ('session_turn') or post in an agent's thread ('room_delivery') stayed as
-- needs_attention until someone dismissed it: the web showed the agent as
-- failed with Try again, and, because the agent no longer read as working, the
-- composer lost its Stop for the agent's other live runs, such as a routine run
-- in the same thread.
--
-- Product call (Jonas, 2026-09-26): a stopped run just reads as stopped. It no
-- longer stands in for the agent, and Try again is not offered: to repeat the
-- message the member sends it again. The one thing a Stop can leave behind is
-- a Company File proposal of the run's own (partial durable output becomes a
-- recovery proposal when the attempt ends). While it is open it still asks for
-- the decision, for every kind of run, a wake included, but it ranks below all
-- of the agent's work (0), queued runs included, so it never hides a Stop.
--
-- Three exact-once text patches of the current function
-- (20260922010000_runtime_failed_run_acknowledgment.sql), so it keeps its ACL:
-- a stopped run never enters through the failure branches, it is listed like a
-- completed run while its own proposal is open, and it ranks lowest. Runs no
-- member stopped are unchanged, and so are the recovery actions:
-- qorpera_retry_room_delivery still accepts a stopped post from its author, but
-- the web no longer offers it. A proposal review a member stopped (reachable
-- only through the job-id cancel, never from the web) drops out as well; the
-- proposal it was reviewing still waits in the Company File.

create function pg_temp.settled_stop_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Stopped run activity patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.settled_stop_patch('public.qorpera_list_staff_execution_activity(uuid)',
	$old$or (job.status in ('failed', 'cancelled') and ($old$,
	$new$or (job.status in ('failed', 'cancelled') and job.cancelled_by_user_id is null and ( -- a member's Stop is no failure$new$);
select pg_temp.settled_stop_patch('public.qorpera_list_staff_execution_activity(uuid)',
	$old$or (job.status = 'completed' and exists ($old$,
	$new$or ((job.status = 'completed' or job.cancelled_by_user_id is not null) and exists ( -- a decision, finished or stopped$new$);
select pg_temp.settled_stop_patch('public.qorpera_list_staff_execution_activity(uuid)',
	$old$when job.status in ('failed', 'cancelled') then 3$old$,
	$new$when job.cancelled_by_user_id is not null then 0 -- a stop's decision waits below all work
					when job.status in ('failed', 'cancelled') then 3$new$);
