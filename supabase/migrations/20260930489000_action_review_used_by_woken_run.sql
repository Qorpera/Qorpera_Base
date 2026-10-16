-- The run a member's answer woke is told the approval was used whenever another call used it; no other run is
-- (fix A, for the runtime's hold retry of v181, #1227).
--
-- qorpera_begin_action_review (20260926130000) answers 'used' when a member's answer woke the agent but a call of
-- another run had already used the approval: the repeat the wake asks for has nothing left to do. It read this from
-- the time: used within 30 s of the wake meant the call that was still holding the card (its heartbeat had lapsed, so
-- the answer woke the agent), and the answer applied to any run of that agent for that member for an hour. Faults:
-- 1. A holding call whose polls fail for longer uses the approval more than 30 s after the wake. The woken repeat is
--    then reviewed again, and under an allow rule (Always allow saves one) the action runs twice. So the runtime (#1227)
--    asks a failed poll again only until 5 s after the answer could first have woken the agent, not until its hold ends.
--    The same holds for the holder's own retry after its hold ended early (the agent is told it may try the identical
--    call once more): that retry uses the approval through begin, maybe more than 30 s after the wake.
-- 2. The wake queues a turn in the card's conversation, which runs one turn at a time, so the woken run begins only
--    after the holder's run ends. If that is more than an hour after the wake, the repeat is reviewed again.
-- 3. A woken repeat that used the approval itself within 30 s of the wake made the same exact call of the agent's other
--    runs for that member 'used' for an hour: refused as already run, with nothing written and no card.
--
-- Now begin answers 'used' to the run the answer woke, and only to it: the run of the room wake whose source is the
-- answer's input (on folder-v2 an answer wakes the agent only in its thread: a card in a plain conversation refuses;
-- a retried delivery's wake has the same source). However long after the wake, and whichever other call used it (the
-- holder's poll, the holder's own retry, or another run's identical call: the member approved it once). A woken run
-- that used the approval itself is reviewed afresh on its next call, as before.
--
-- Begin keeps its signature, grants and settings (the host call allows one function per name, 20260928409985).
-- DB only: no caller changes; the runtime may then ask a failed poll again until its hold ends.
set local lock_timeout = '3s';

create temporary table fix_a_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid = 'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure;

-- Replaces p_old, found exactly once in the function's definition, by p_new, and runs the result.
create function pg_temp.fix_a_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930489000: the patch anchor is not found once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.fix_a_patch('public.qorpera_begin_action_review(jsonb,jsonb)',
	E'\t\tand v_review.consumed_at < v_review.woken_at + interval ''30 seconds''\n'
	|| E'\t\tand clock_timestamp() < v_review.woken_at + interval ''1 hour'' then\n'
	|| E'\t\t-- The answer woke the agent, but the call that was still holding ran it: the\n'
	|| E'\t\t-- repeat the wake asks for has nothing left to do.\n',
	E'\t\tand exists (\n'
	|| E'\t\t\tselect 1 from public.qorpera_wake_occurrences as wake\n'
	|| E'\t\t\tjoin public.qorpera_session_inputs as input on input.id = wake.source_id\n'
	|| E'\t\t\twhere wake.run_id = v_run.id and wake.source_kind = ''room''\n'
	|| E'\t\t\t\tand input.body ->> ''schema'' = ''qorpera.interaction-answer/v1''\n'
	|| E'\t\t\t\tand input.body ->> ''interactionId'' = v_review.id::text) then\n'
	|| E'\t\t-- The answer woke the agent and this is the run it woke, but another call ran it\n'
	|| E'\t\t-- (the holder, however long after the wake, or the holder''s retry; 20260930489000):\n'
	|| E'\t\t-- the repeat the wake asks for has nothing left to do.\n');

do $$
declare v_begin text := (select prosrc from pg_proc where oid = 'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure);
begin
	if position('20260930489000' in v_begin) = 0 or position('where wake.run_id = v_run.id and wake.source_kind = ''room''' in v_begin) = 0
		or position('30 seconds' in v_begin) > 0 or position('1 hour' in v_begin) > 0
		or exists (
			select 1 from pg_temp.fix_a_before as prior join pg_proc as patched on patched.oid = prior.oid
			where patched.prosecdef is distinct from prior.prosecdef or patched.proconfig is distinct from prior.proconfig
				or patched.provolatile is distinct from prior.provolatile
				or patched.proacl::text is distinct from prior.proacl::text)
		or (select count(*) from pg_proc where proname = 'qorpera_begin_action_review') <> 1 then
		raise exception '20260930489000: qorpera_begin_action_review did not change as expected'; end if;
end $$;
