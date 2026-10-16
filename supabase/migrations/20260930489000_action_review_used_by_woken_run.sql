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
-- 4. The answer applied to the latest review of the action only, so a newer card of the same action (the holder called
--    it again) hid the card that woke the run: its repeat was reviewed afresh, or held on the newer card.
--
-- Now begin first reads the card that woke the run, and only the run it woke: the run of the room wake whose source
-- is the answer's input (on folder-v2 an answer wakes the agent only in its thread: a card in a plain conversation
-- refuses; a retried delivery's wake has the same source). If that card is of exactly this action, its approval is the
-- one the repeat uses, and if another call used it (the holder's poll, the holder's own retry, or another run's
-- identical call: the member approved it once), the repeat is told 'used', however long after the wake. Otherwise begin
-- goes on as before, without the old 'used' answer: a woken run that used the approval itself is reviewed afresh on its
-- next call, and no other run is told 'used'.
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

-- The woken run's own card first: before the latest review of the action, so a newer card of it does not hide it.
select pg_temp.fix_a_patch('public.qorpera_begin_action_review(jsonb,jsonb)',
	E'\t-- The latest review of exactly this action, by this agent, for the same member\n',
	E'\t-- The run a member''s answer woke repeats the call of the card answered, and that card''s approval is the one\n'
	|| E'\t-- it uses (20260930489000). If another call used it first (the call that was still holding, however long after\n'
	|| E'\t-- the wake, or that call''s retry), the repeat has nothing left to do. A newer card of the action does not hide\n'
	|| E'\t-- it. On folder-v2 an answer wakes the agent only in its thread, through a room wake of the answer''s input (a\n'
	|| E'\t-- retried delivery has the same source); no other run is told the approval was used.\n'
	|| E'\tselect review.* into v_review from public.qorpera_action_reviews as review\n'
	|| E'\twhere review.id = (select (input.body ->> ''interactionId'')::uuid from public.qorpera_wake_occurrences as wake\n'
	|| E'\t\t\tjoin public.qorpera_session_inputs as input on input.id = wake.source_id\n'
	|| E'\t\t\twhere wake.run_id = v_run.id and wake.source_kind = ''room''\n'
	|| E'\t\t\t\tand input.body ->> ''schema'' = ''qorpera.interaction-answer/v1'' and input.body ->> ''surface'' = ''approval'')\n'
	|| E'\t\tand review.profile_id = v_run.profile_id and review.staff_agent_id = v_run.staff_agent_id\n'
	|| E'\t\tand review.tool_name = p_call ->> ''tool'' and review.argument_sha256 = p_call ->> ''argumentSha256''\n'
	|| E'\t\tand review.decision = ''ask'' and review.answer in (''allow_once'', ''always_allow'')\n'
	|| E'\tfor update;\n'
	|| E'\tif found and v_review.consumed_at is null then\n'
	|| E'\t\tupdate public.qorpera_action_reviews set consumed_at = clock_timestamp(), consumed_run_id = v_run.id\n'
	|| E'\t\twhere id = v_review.id;\n'
	|| E'\t\treturn jsonb_build_object(''schema'', ''qorpera.action-review-begin/v1'', ''state'', ''approved'', ''reviewId'', v_review.id,\n'
	|| E'\t\t\t''answeredBy'', public.qorpera_review_member_name(v_run.profile_id, v_review.answered_by_user_id));\n'
	|| E'\telsif found and v_review.consumed_run_id is distinct from v_run.id then\n'
	|| E'\t\treturn jsonb_build_object(''schema'', ''qorpera.action-review-begin/v1'', ''state'', ''used'', ''reviewId'', v_review.id,\n'
	|| E'\t\t\t''answeredBy'', public.qorpera_review_member_name(v_run.profile_id, v_review.answered_by_user_id));\n'
	|| E'\tend if;\n'
	|| E'\t-- The latest review of exactly this action, by this agent, for the same member\n');

-- The 30 s window and the hour go: the check above is the only 'used' answer.
select pg_temp.fix_a_patch('public.qorpera_begin_action_review(jsonb,jsonb)',
	E'\telsif found and v_review.woken_at is not null and v_review.consumed_run_id is distinct from v_run.id\n'
	|| E'\t\tand v_review.consumed_at < v_review.woken_at + interval ''30 seconds''\n'
	|| E'\t\tand clock_timestamp() < v_review.woken_at + interval ''1 hour'' then\n'
	|| E'\t\t-- The answer woke the agent, but the call that was still holding ran it: the\n'
	|| E'\t\t-- repeat the wake asks for has nothing left to do.\n'
	|| E'\t\treturn jsonb_build_object(''schema'', ''qorpera.action-review-begin/v1'', ''state'', ''used'', ''reviewId'', v_review.id,\n'
	|| E'\t\t\t''answeredBy'', public.qorpera_review_member_name(v_run.profile_id, v_review.answered_by_user_id));\n',
	'');

do $$
declare v_begin text := (select prosrc from pg_proc where oid = 'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure);
begin
	if position('20260930489000' in v_begin) = 0 or position('where wake.run_id = v_run.id and wake.source_kind = ''room''' in v_begin) = 0
		or position('20260930489000' in v_begin) > position('-- The latest review of exactly this action' in v_begin)
		or position('woken_at' in v_begin) > 0 or position('30 seconds' in v_begin) > 0 or position('1 hour' in v_begin) > 0
		or (length(v_begin) - length(replace(v_begin, '''state'', ''used''', ''))) / length('''state'', ''used''') <> 1
		or exists (
			select 1 from pg_temp.fix_a_before as prior join pg_proc as patched on patched.oid = prior.oid
			where patched.prosecdef is distinct from prior.prosecdef or patched.proconfig is distinct from prior.proconfig
				or patched.provolatile is distinct from prior.provolatile
				or patched.proacl::text is distinct from prior.proacl::text)
		or (select count(*) from pg_proc where proname = 'qorpera_begin_action_review') <> 1 then
		raise exception '20260930489000: qorpera_begin_action_review did not change as expected'; end if;
end $$;
