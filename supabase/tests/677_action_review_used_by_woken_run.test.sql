-- @fixture 605_runtime_auto_review_rules.test.sql until "-- A member's post in the agent's thread; its run reviews acting calls."
-- The run an answer woke repeats a call that another call already ran (20260930489000, fix A for the runtime's hold
-- retry, #1227). A call that holds an approval card polls it (qorpera_await_action_review) and renews a 10 s heartbeat;
-- an answer given once the heartbeat lapsed, or after the hold ended early, wakes the agent, and the woken run repeats
-- the call. If another call used the approval first (the slow holder's poll, or the holder's own retry), the woken
-- run's repeat is told it was used, however long after the wake it comes, and no other run is told so. The card that
-- woke the run is read first, so a newer card of the same action does not hide it. 20260926130000 read this from the
-- time (used within 30 s of the wake, asked within an hour) and from the latest review only: a later use let the action
-- run twice under an allow rule, and other runs' calls of it were refused as used. Bob's run in his thread holds; each
-- answer's wake is a real run. Runs on 605's fixture part (its rules and helpers).

-- The shape: the patched body, and the same grants.
do $$
declare v_begin text := (select prosrc from pg_proc where oid = 'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure);
begin
	perform pg_temp.base_assert(position('20260930489000' in v_begin) > 0
		and position('where review.id = (select (input.body ->> ''interactionId'')::uuid from public.qorpera_wake_occurrences as wake'
			in v_begin) > 0
		and position('where wake.run_id = v_run.id and wake.source_kind = ''room''' in v_begin) > 0
		and position('20260930489000' in v_begin) < position('-- The latest review of exactly this action' in v_begin)
		and position('woken_at' in v_begin) = 0 and position('30 seconds' in v_begin) = 0 and position('1 hour' in v_begin) = 0,
		'Begin reads the card that woke the run, before the latest review, instead of the 30 s window and the hour');
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_begin_action_review(jsonb,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_begin_action_review(jsonb,jsonb)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_begin_action_review(jsonb,jsonb)', 'execute'),
		'The runtime alone calls it, as before');
end
$$;

-- The run an answer's wake becomes: one materializer pass turns the wake into a run, started on a runner with a lease;
-- answers the run's binding.
create function pg_temp.fa_woken_run(p_answer jsonb) returns jsonb language plpgsql as $$
declare v_pass jsonb; v_run uuid;
begin
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences
	where source_kind = 'room' and source_id = (p_answer ->> 'inputId')::uuid and wake_kind = 'room';
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run),
		'The answer''s wake is a run: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end $$;

-- Bob's run in his thread: the holder.
select set_config('qorpera_test.fa_holder', pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid,
	'Bob, tell Acme the meeting moved.')::text, false) \g /dev/null

-- A. The holder's polls fail past its heartbeat, the member's answer wakes the agent, and the holder's poll gets
-- through 40 s after the wake and runs the action. The woken repeat has nothing left to do, hours later too.
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_answer jsonb; v_begin jsonb; v_woken jsonb;
	v_id uuid; v_review public.qorpera_action_reviews%rowtype;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('d', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-1', repeat('d', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'pending',
		'The holder polls its card');
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_id;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'An answer after the heartbeat lapsed wakes the agent');
	v_woken := pg_temp.fa_woken_run(v_answer);
	perform set_config('qorpera_test.fa_woken', v_woken::text, false);
	perform pg_temp.base_assert(v_woken ->> 'runId' <> v_holder ->> 'runId', 'The woken run is another run');

	-- The holder's poll gets through 40 s after the wake (stood in for by moving the wake back).
	update public.qorpera_action_reviews set woken_at = woken_at - interval '40 seconds' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'approved',
		'The slow holder uses the approval');
	select * into strict v_review from public.qorpera_action_reviews where id = v_id;
	perform pg_temp.base_assert(v_review.consumed_run_id = (v_holder ->> 'runId')::uuid
		and v_review.consumed_at >= v_review.woken_at + interval '30 seconds', 'The holder used it, more than 30 s after the wake');
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_id::text
		and v_begin ->> 'answeredBy' = 'Owner', 'The woken repeat is told the approval was used: ' || v_begin::text);

	-- A conversation runs one turn at a time, so the woken run may begin hours after the wake.
	update public.qorpera_action_reviews set woken_at = clock_timestamp() - interval '2 hours' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'used',
		'Hours after the wake, the woken repeat is still told so');
	-- The holder ran the action: its own next call of it is reviewed afresh.
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'The holder''s own repeat is reviewed afresh');
end
$$;

-- B. The hold ends early (the call is refused as unavailable, parks its card, and may be tried once more), the member's
-- answer wakes the agent, and the holder's retry runs the action. The woken repeat has nothing left to do; a run the
-- answer did not wake is reviewed afresh, even within 30 s of the wake (20260926130000 told each the other's answer).
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_answer jsonb; v_woken jsonb; v_id uuid;
	v_other jsonb := current_setting('qorpera_test.fa_woken')::jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('e', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-2', repeat('e', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, true, true) ->> 'state' = 'parked',
		'A hold that ends early parks its card');
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'The answer to the parked card wakes the agent');
	v_woken := pg_temp.fa_woken_run(v_answer);
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'approved',
		'The holder''s retry uses the approval');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_other, c_call) ->> 'state' = 'review',
		'A run the answer did not wake is reviewed afresh, within 30 s of the wake');
	-- The woken run begins once the holder's run ends, here two hours after the wake.
	update public.qorpera_action_reviews set woken_at = clock_timestamp() - interval '2 hours' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'used',
		'The woken repeat is told the approval was used');
end
$$;

-- C. The woken repeat comes first and uses the approval itself: the slow holder's poll finds it used, and from then on
-- the action is reviewed afresh in every run, the woken one too (20260926130000 refused the holder's and other runs'
-- calls of it as used for an hour).
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_answer jsonb; v_woken jsonb; v_id uuid;
	v_other jsonb := current_setting('qorpera_test.fa_woken')::jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('f', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-3', repeat('f', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_id;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'An answer after the heartbeat lapsed wakes the agent');
	v_woken := pg_temp.fa_woken_run(v_answer);
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'approved',
		'The woken repeat uses the approval');
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'used',
		'The slow holder finds it used');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'The holder''s next call of the action is reviewed afresh');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_other, c_call) ->> 'state' = 'review',
		'So is another run''s');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'review',
		'So is the woken run''s own next call');
end
$$;

-- D. A card answered while its call still held it woke no one: the holder uses it, and no other call is told it was used.
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_id uuid;
	v_other jsonb := current_setting('qorpera_test.fa_woken')::jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('a', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-4', repeat('a', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert((pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once')
		->> 'woke')::boolean = false, 'The held card is answered and wakes no one');
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'approved',
		'The holder uses the approval');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_other, c_call) ->> 'state' = 'review',
		'Another run''s call of it is reviewed afresh');
end
$$;

-- E. Two cards of the same action, each answered after its heartbeat lapsed, and the slow holder used both approvals
-- before either woken run began: each woken repeat is told its own card's approval was used. The newer card does not
-- hide the older one (by the latest review alone, the first woken run reviewed the action afresh).
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_first uuid; v_second uuid;
	v_first_run jsonb; v_second_run jsonb; v_begin jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('9', 64));
begin
	v_first := (pg_temp.rv_record(v_holder, 'fa-call-5', repeat('9', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_first;
	v_first_run := pg_temp.fa_woken_run(pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_first, 'allow_once'));
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_first, false) ->> 'state' = 'approved',
		'The slow holder uses the first approval');
	-- The holder calls the same action again; the second card's answer wakes the agent again.
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'The holder''s next call of the action is reviewed afresh');
	v_second := (pg_temp.rv_record(v_holder, 'fa-call-6', repeat('9', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_second;
	v_second_run := pg_temp.fa_woken_run(pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_second, 'allow_once'));
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_second, false) ->> 'state' = 'approved',
		'The slow holder uses the second approval');
	v_begin := public.qorpera_begin_action_review(v_first_run, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_first::text,
		'The first woken repeat is told its own card''s approval was used: ' || v_begin::text);
	v_begin := public.qorpera_begin_action_review(v_second_run, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_second::text,
		'So is the second: ' || v_begin::text);
end
$$;

-- F. The card that woke the run is the approval its repeat uses, though a newer card of the same action waits in the
-- conversation (by the latest review alone, the woken repeat held on the newer card).
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_id uuid; v_newer uuid; v_woken jsonb;
	v_begin jsonb; v_other jsonb := current_setting('qorpera_test.fa_woken')::jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('8', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-7', repeat('8', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, true, true) ->> 'state' = 'parked',
		'A hold that ends early parks its card');
	v_woken := pg_temp.fa_woken_run(pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once'));
	-- Another run raises a card of the same action before the woken run begins.
	v_newer := (pg_temp.rv_record(v_other, 'fa-call-8', repeat('8', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'approved' and v_begin ->> 'reviewId' = v_id::text,
		'The woken repeat uses the approval that woke it: ' || v_begin::text);
	perform pg_temp.base_assert((select answer is null and consumed_at is null from public.qorpera_action_reviews
		where id = v_newer), 'The newer card still waits for its own answer');
end
$$;

rollback;
