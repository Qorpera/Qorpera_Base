-- @fixture 605_runtime_auto_review_rules.test.sql until "-- A member's post in the agent's thread; its run reviews acting calls."
-- The run an answer woke repeats a call that another call already ran (20260930489000, fix A for the runtime's hold
-- retry, #1227). A call that holds an approval card polls it (qorpera_await_action_review) and renews a 10 s heartbeat;
-- an answer given once the heartbeat lapsed, or after the hold ended early, wakes the agent, and the woken run repeats
-- the call. If another call used the approval first (the slow holder's poll, or the holder's own retry), the woken
-- run's repeat is told it was used, however long after the wake it comes, and no other run is told so. The card that
-- woke the run is read first, so a newer card of the same action does not hide it. 20260926130000 read this from the
-- time (used within 30 s of the wake, asked within an hour) and from the latest review only: a later use let the action
-- run twice under an allow rule, and other runs' calls of it were refused as used. Bob's run in his thread holds, and
-- each case starts from it (a savepoint each). A conversation runs one run at a time (20260930538000): each answer's
-- wake waits in his thread and becomes a real run once the holder's run ends. Bob's run in a group chat is a run the
-- answer did not wake. An approval's run carries the holder's run as its origin, whose request its review reads
-- (20260930518000, C6-8b; G). Runs on 605's fixture part (its rules and helpers).

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
-- While the holder's run lives, the answer's wake waits in its thread: a pass makes no run of it.
create function pg_temp.fa_waits(p_answer jsonb) returns void language plpgsql as $$
declare v_pass jsonb := pg_temp.base_materialize(); v_wake public.qorpera_wake_occurrences%rowtype;
begin
	select * into strict v_wake from public.qorpera_wake_occurrences
	where source_kind = 'room' and source_id = (p_answer ->> 'inputId')::uuid and wake_kind = 'room';
	perform pg_temp.base_assert(coalesce(v_pass -> 'run_ids', '[]'::jsonb) = '[]'::jsonb and v_wake.status = 'queued'
		and v_wake.run_id is null and v_wake.blocked_reason is null,
		'The answer''s wake waits while the holder''s run lives: ' || v_pass::text || to_jsonb(v_wake)::text);
end $$;
-- A run ends: its runner's job is over, and the conversation's next run may begin.
create function pg_temp.fa_end(p_binding jsonb) returns void language sql as $$
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: the run ended',
		lease_token_sha256 = null, lease_expires_at = null
	where run_id = (p_binding ->> 'runId')::uuid
$$;

-- Bob's run in his thread: the holder.
select set_config('qorpera_test.fa_holder', pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid,
	'Bob, tell Acme the meeting moved.')::text, false) \g /dev/null
-- Another run of Bob's: the owner's post in a group chat with Bob and Carol names Bob. One run at a time holds for a
-- conversation, not for an agent: this run works beside the holder.
do $$
declare v_text text := E'---\nid: 67700000-0000-4000-8000-0000000000c1\nname: Launch\nagents:\n  - 92400000-0000-4000-8000-000000000031\n'
		|| E'  - 92400000-0000-4000-8000-000000000032\npeople:\n  - 92400000-0000-4000-8000-000000000001\n---\nPlan the launch.\n';
	v_result jsonb; v_pass jsonb; v_run uuid;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'fa-group-launch', jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/groups'),
		jsonb_build_object('op', 'new_folder', 'path', 'QorperaOS/agents/groups/launch',
			'contents', jsonb_build_array(jsonb_build_object('path', 'group.md', 'kind', 'file', 'file', pg_temp.base_stage(v_text))),
			'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/groups/launch/group.md', 'kind', 'group', 'text', v_text,
				'parse', jsonb_build_object('kind', 'group', 'id', '67700000-0000-4000-8000-0000000000c1', 'name', 'Launch', 'subtitle', null,
					'agents', '["92400000-0000-4000-8000-000000000031","92400000-0000-4000-8000-000000000032"]'::jsonb,
					'people', '["92400000-0000-4000-8000-000000000001"]'::jsonb, 'purpose', 'Plan the launch.'), 'parserVersion', 1)))));
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_post_company_room_message('67700000-0000-4000-8000-0000000000c1', extensions.gen_random_uuid(),
		'{"schema":"qorpera.session-prompt/v1","text":"@Bob, is the launch list ready?"}',
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1);
	reset role;
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_result #>> '{occurrenceIds,0}')::uuid;
	perform pg_temp.base_assert(jsonb_array_length(v_result -> 'occurrenceIds') = 1 and v_pass -> 'run_ids' = jsonb_build_array(v_run)
		and (select run.staff_agent_id = '92400000-0000-4000-8000-000000000031' and run.session_id = room.session_id
			from public.qorpera_execution_runs run, public.qorpera_company_rooms room
			where run.id = v_run and room.id = '67700000-0000-4000-8000-0000000000c1'),
		'Fixture: Bob''s run in the group chat: ' || v_pass::text);
	perform set_config('qorpera_test.fa_other', pg_temp.base_start(v_run)::text, false);
end
$$;

-- A. The holder's polls fail past its heartbeat, the member's answer wakes the agent, and the holder's poll gets
-- through 40 s after the wake and runs the action. The woken run begins once the holder's run ends, and its repeat has
-- nothing left to do, hours later too.
savepoint fa_case;
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
	perform pg_temp.fa_waits(v_answer);

	-- The holder's poll gets through 40 s after the wake (stood in for by moving the wake back).
	update public.qorpera_action_reviews set woken_at = woken_at - interval '40 seconds' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'approved',
		'The slow holder uses the approval');
	select * into strict v_review from public.qorpera_action_reviews where id = v_id;
	perform pg_temp.base_assert(v_review.consumed_run_id = (v_holder ->> 'runId')::uuid
		and v_review.consumed_at >= v_review.woken_at + interval '30 seconds', 'The holder used it, more than 30 s after the wake');
	-- The holder ran the action: its own next call of it is reviewed afresh.
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'The holder''s own repeat is reviewed afresh');

	-- The holder's run ends; the woken run begins.
	perform pg_temp.fa_end(v_holder);
	v_woken := pg_temp.fa_woken_run(v_answer);
	perform pg_temp.base_assert(v_woken ->> 'runId' <> v_holder ->> 'runId', 'The woken run is another run');
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_id::text
		and v_begin ->> 'answeredBy' = 'Owner', 'The woken repeat is told the approval was used: ' || v_begin::text);

	-- A conversation runs one turn at a time, so the woken run may begin hours after the wake.
	update public.qorpera_action_reviews set woken_at = clock_timestamp() - interval '2 hours' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'used',
		'Hours after the wake, the woken repeat is still told so');
end
$$;
rollback to savepoint fa_case;

-- B. The hold ends early (the call is refused as unavailable, parks its card, and may be tried once more), the member's
-- answer wakes the agent, and the holder's retry runs the action. The woken repeat has nothing left to do; a run the
-- answer did not wake is reviewed afresh, even within 30 s of the wake (20260926130000 told each the other's answer).
savepoint fa_case;
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_answer jsonb; v_woken jsonb; v_id uuid;
	v_other jsonb := current_setting('qorpera_test.fa_other')::jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('e', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-2', repeat('e', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, true, true) ->> 'state' = 'parked',
		'A hold that ends early parks its card');
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'The answer to the parked card wakes the agent');
	perform pg_temp.fa_waits(v_answer);
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'approved',
		'The holder''s retry uses the approval');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_other, c_call) ->> 'state' = 'review',
		'A run the answer did not wake is reviewed afresh, within 30 s of the wake');
	-- The woken run begins once the holder's run ends, here two hours after the wake.
	perform pg_temp.fa_end(v_holder);
	v_woken := pg_temp.fa_woken_run(v_answer);
	update public.qorpera_action_reviews set woken_at = clock_timestamp() - interval '2 hours' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'used',
		'The woken repeat is told the approval was used');
end
$$;
rollback to savepoint fa_case;

-- C. The holder's run ends before its poll gets through, so the woken repeat comes first and uses the approval itself.
-- The slow holder's poll can no longer come: its run has ended before the woken run began. From then on the action is
-- reviewed afresh in every run: another run's, the woken one's own next call, and the thread's next run's
-- (20260926130000 refused the holder's and other runs' calls of it as used for an hour).
savepoint fa_case;
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_answer jsonb; v_woken jsonb; v_id uuid;
	v_other jsonb := current_setting('qorpera_test.fa_other')::jsonb; v_next jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('f', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-3', repeat('f', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_id;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'An answer after the heartbeat lapsed wakes the agent');
	perform pg_temp.fa_end(v_holder);
	v_woken := pg_temp.fa_woken_run(v_answer);
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'approved',
		'The woken repeat uses the approval');
	perform pg_temp.base_assert((select consumed_run_id = (v_woken ->> 'runId')::uuid from public.qorpera_action_reviews
		where id = v_id), 'The approval is used once, by the woken run');
	-- The slow holder's poll no longer gets through: its run has ended.
	perform pg_temp.base_error(format('select public.qorpera_await_action_review(%L::jsonb, %L::uuid, false)', v_holder, v_id),
		'42501', 'Run is unavailable');
	-- A poll of the card by a live run that did not use it (Bob's run in the group chat) is told it was used.
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_other, v_id, false) ->> 'state' = 'used',
		'Another run''s poll of the card finds it used');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_other, c_call) ->> 'state' = 'review',
		'Another run''s call of the action is reviewed afresh');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'review',
		'So is the woken run''s own next call');
	-- The woken run ends; the owner's next post in the thread is the next run there.
	perform pg_temp.fa_end(v_woken);
	v_next := pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid, 'Bob, send Acme the new time again.');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_next, c_call) ->> 'state' = 'review',
		'So is the thread''s next run''s');
end
$$;
rollback to savepoint fa_case;

-- D. A card answered while its call still held it woke no one: the holder uses it, and no other call is told it was used.
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_id uuid;
	v_other jsonb := current_setting('qorpera_test.fa_other')::jsonb;
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
-- hide the older one (by the latest review alone, the first woken run reviewed the action afresh). The two wakes wait
-- for the holder's run, and become runs in turn once it ends, the first answer's first.
savepoint fa_case;
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_first uuid; v_answer jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('9', 64));
begin
	v_first := (pg_temp.rv_record(v_holder, 'fa-call-5', repeat('9', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_first;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_first, 'allow_once');
	perform pg_temp.fa_waits(v_answer);
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_first, false) ->> 'state' = 'approved',
		'The slow holder uses the first approval');
	-- The holder calls the same action again; the second card's answer wakes the agent again.
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'The holder''s next call of the action is reviewed afresh');
	perform set_config('qorpera_test.fa_first', jsonb_build_object('reviewId', v_first, 'answer', v_answer)::text, false);
end
$$;
-- The second card, in a later statement: its wake is due after the first's.
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_second uuid; v_answer jsonb;
	v_first jsonb := current_setting('qorpera_test.fa_first')::jsonb; v_first_run jsonb; v_second_run jsonb; v_begin jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('9', 64));
begin
	v_second := (pg_temp.rv_record(v_holder, 'fa-call-6', repeat('9', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_second;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_second, 'allow_once');
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_second, false) ->> 'state' = 'approved',
		'The slow holder uses the second approval');
	perform pg_temp.fa_end(v_holder);
	v_first_run := pg_temp.fa_woken_run(v_first -> 'answer');
	v_begin := public.qorpera_begin_action_review(v_first_run, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_first ->> 'reviewId',
		'The first woken repeat is told its own card''s approval was used: ' || v_begin::text);
	perform pg_temp.fa_end(v_first_run);
	v_second_run := pg_temp.fa_woken_run(v_answer);
	v_begin := public.qorpera_begin_action_review(v_second_run, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_second::text,
		'So is the second: ' || v_begin::text);
end
$$;
rollback to savepoint fa_case;

-- F. The card that woke the run is the approval its repeat uses, though a newer card of the same action waits in the
-- conversation (by the latest review alone, the woken repeat held on the newer card).
savepoint fa_case;
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_id uuid; v_newer uuid; v_woken jsonb;
	v_begin jsonb; v_answer jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('8', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-7', repeat('8', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, true, true) ->> 'state' = 'parked',
		'A hold that ends early parks its card');
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	-- The holder calls the same action again, raising a newer card, before its run ends and the woken run begins.
	v_newer := (pg_temp.rv_record(v_holder, 'fa-call-8', repeat('8', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.fa_end(v_holder);
	v_woken := pg_temp.fa_woken_run(v_answer);
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'approved' and v_begin ->> 'reviewId' = v_id::text,
		'The woken repeat uses the approval that woke it: ' || v_begin::text);
	perform pg_temp.base_assert((select answer is null and consumed_at is null from public.qorpera_action_reviews
		where id = v_newer), 'The newer card still waits for its own answer');
end
$$;
rollback to savepoint fa_case;

-- G. The run an approval woke carries on the holder's work (20260930518000, C6-8b): its wake records the holder's run as
-- its origin, and describe gives it the holder's request beside the answer, as its review reads them, after the
-- holder's run ended. The approval still covers the card's action alone, once: the run's other acting calls, a routine
-- change too, are reviewed. A Deny's run carries no origin.
savepoint fa_case;
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_id uuid; v_answer jsonb; v_woken jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype; v_context jsonb; v_begin jsonb;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('7', 64));
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-9', repeat('7', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, true, true) ->> 'state' = 'parked',
		'A hold that ends early parks its card');
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.fa_end(v_holder);
	v_woken := pg_temp.fa_woken_run(v_answer);
	select * into strict v_wake from public.qorpera_wake_occurrences where run_id = (v_woken ->> 'runId')::uuid;
	perform pg_temp.base_assert(v_wake.wake_kind = 'room' and v_wake.source_id = (v_answer ->> 'inputId')::uuid
		and v_wake.origin_run_id = (v_holder ->> 'runId')::uuid,
		'The woken run''s wake carries the holder''s run as its origin: ' || to_jsonb(v_wake)::text);
	v_context := public.qorpera_describe_company_run_context(v_woken);
	perform pg_temp.base_assert(v_context #>> '{origin,runId}' = v_holder ->> 'runId'
		and v_context #> '{origin,routineIntent}' = 'null'::jsonb
		and exists (select 1 from jsonb_array_elements(v_context #> '{origin,inputs}') as input
			where input ->> 'sourceKind' = 'history'
				and input ->> 'authorUserId' = '92400000-0000-4000-8000-000000000001'
				and (input #>> '{content,text}')::jsonb #>> '{entry,message,content,0,text}'
					= 'Bob, tell Acme the meeting moved.'),
		'Describe gives the woken run the holder''s request, the post its wake named: '
			|| coalesce(v_context -> 'origin', 'null')::text);
	perform pg_temp.base_assert(exists (select 1 from jsonb_array_elements(v_context -> 'history') as entry
			where entry ->> 'id' = v_answer ->> 'inputId'),
		'Describe gives the woken run the answer beside it: ' || coalesce(v_context -> 'history', 'null')::text);
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'approved' and v_begin ->> 'reviewId' = v_id::text,
		'The woken run runs the card''s action on its approval: ' || v_begin::text);
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'review',
		'Once: its next call of the action is reviewed afresh');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, jsonb_build_object('tool', 'manage_routine',
		'argumentSha256', repeat('6', 64))) ->> 'state' = 'review', 'A routine change in the woken run is reviewed');
end
$$;
rollback to savepoint fa_case;
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_id uuid; v_answer jsonb; v_woken jsonb;
begin
	v_id := (pg_temp.rv_record(v_holder, 'fa-call-10', repeat('5', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, true, true) ->> 'state' = 'parked',
		'A hold that ends early parks its card');
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'deny');
	perform pg_temp.fa_end(v_holder);
	v_woken := pg_temp.fa_woken_run(v_answer);
	perform pg_temp.base_assert((select origin_run_id is null from public.qorpera_wake_occurrences
		where run_id = (v_woken ->> 'runId')::uuid) and not public.qorpera_describe_company_run_context(v_woken) ? 'origin',
		'A Deny''s run carries no origin');
end
$$;

rollback;
