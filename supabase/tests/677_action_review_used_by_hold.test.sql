-- @fixture 605_runtime_auto_review_rules.test.sql until "-- A member's post in the agent's thread; its run reviews acting calls."
-- The woken agent's repeat after a slow holder (20260930489000, fix A for the runtime's hold retry, #1227). A call that
-- holds an approval card polls it (qorpera_await_action_review) and renews a 10 s heartbeat; an answer given once the
-- heartbeat lapsed wakes the agent, and the woken run repeats the call. If the holder was only slow and uses the
-- approval itself, the repeat is told it was used, however long after the wake (20260926130000 told it so only within
-- 30 s, and reviewed it again after: under an allow rule the action ran twice). A woken repeat that used the approval
-- itself makes no other run's call 'used'. Bob's run in his thread holds; the answer's wake is a real run. Runs on 605's
-- fixture part (its rules and helpers).

-- The shape: the mark, the two patched bodies, and the same grants.
do $$
declare v_begin text := (select prosrc from pg_proc where oid = 'public.qorpera_begin_action_review(jsonb,jsonb)'::regprocedure);
	v_await text := (select prosrc from pg_proc
		where oid = 'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)'::regprocedure);
begin
	perform pg_temp.base_assert((select atttypid = 'boolean'::regtype and attnotnull from pg_attribute
		where attrelid = 'public.qorpera_action_reviews'::regclass and attname = 'consumed_by_hold' and not attisdropped)
		and (select pg_get_expr(adbin, adrelid) = 'false' from pg_attrdef join pg_attribute
			on attrelid = adrelid and attnum = adnum
			where adrelid = 'public.qorpera_action_reviews'::regclass and attname = 'consumed_by_hold'),
		'Every review has the mark, unset unless a held call used its approval');
	perform pg_temp.base_assert(position('and v_review.consumed_by_hold' in v_begin) > 0
		and position('30 seconds' in v_begin) = 0 and position('woken_at + interval ''1 hour''' in v_begin) > 0
		and position('consumed_by_hold = true' in v_await) > 0 and position('consumed_by_hold' in
			regexp_replace(v_begin, 'and v_review\.consumed_by_hold\n', '')) = 0,
		'Begin reads the mark instead of the 30 s window, and only the held call''s poll sets it');
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_begin_action_review(jsonb,jsonb)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_begin_action_review(jsonb,jsonb)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)', 'execute'),
		'The runtime alone calls both, as before');
end
$$;

-- Bob's run in his thread: the holder.
select set_config('qorpera_test.fa_holder', pg_temp.cd_post(current_setting('qorpera_test.card_room')::uuid,
	'Bob, tell Acme the meeting moved.')::text, false) \g /dev/null

-- A. The holder's polls fail past its heartbeat, the member's answer wakes the agent, and the holder's poll gets
-- through 40 s after the wake and runs the action. The woken repeat has nothing left to do.
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb; v_record jsonb; v_answer jsonb; v_begin jsonb;
	v_woken jsonb; v_id uuid; v_wake public.qorpera_wake_occurrences%rowtype; v_review public.qorpera_action_reviews%rowtype;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('d', 64));
begin
	v_record := pg_temp.rv_record(v_holder, 'fa-call-1', repeat('d', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]);
	v_id := (v_record ->> 'reviewId')::uuid;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'pending',
		'The holder polls its card');
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_id;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'An answer after the heartbeat lapsed wakes the agent');
	select * into strict v_wake from public.qorpera_wake_occurrences
	where source_id = (v_answer ->> 'inputId')::uuid and wake_kind = 'room';
	perform pg_temp.base_assert(pg_temp.base_materialize() ->> 'state' = 'done', 'The wake is turned into a run');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_wake.id;
	v_woken := pg_temp.base_start(v_wake.run_id);
	perform set_config('qorpera_test.fa_woken', v_woken::text, false);
	perform pg_temp.base_assert(v_woken ->> 'runId' <> v_holder ->> 'runId', 'The woken run is another run');

	-- The holder's poll gets through 40 s after the wake (stood in for by moving the wake back).
	update public.qorpera_action_reviews set woken_at = woken_at - interval '40 seconds' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'approved',
		'The slow holder uses the approval');
	select * into strict v_review from public.qorpera_action_reviews where id = v_id;
	perform pg_temp.base_assert(v_review.consumed_by_hold and v_review.consumed_run_id = (v_holder ->> 'runId')::uuid
		and v_review.consumed_at >= v_review.woken_at + interval '30 seconds',
		'A held call used it, more than 30 s after the wake');
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'used' and v_begin ->> 'reviewId' = v_id::text
		and v_begin ->> 'answeredBy' = 'Owner', 'The woken repeat is told the approval was used: ' || v_begin::text);

	-- As long as the hold may last with its retries, and longer.
	update public.qorpera_action_reviews set woken_at = clock_timestamp() - interval '6 minutes' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'used',
		'Minutes after the wake, the repeat is still told so');
	-- The holder ran the action: its own next call of it is reviewed afresh.
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'The holder''s own repeat is reviewed afresh');
	-- An hour after the wake, the repeat is reviewed afresh.
	update public.qorpera_action_reviews set woken_at = clock_timestamp() - interval '61 minutes' where id = v_id;
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'review',
		'An hour after the wake, a repeat is reviewed afresh');
end
$$;

-- B. The woken repeat comes first and uses the approval itself: the slow holder then finds it used, and another call of
-- the same action is reviewed afresh, even within 30 s of the wake (20260926130000 refused it as used for an hour).
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb;
	v_woken jsonb := current_setting('qorpera_test.fa_woken')::jsonb; v_record jsonb; v_answer jsonb; v_begin jsonb;
	v_id uuid; v_review public.qorpera_action_reviews%rowtype;
	c_call constant jsonb := jsonb_build_object('tool', 'send_email', 'argumentSha256', repeat('e', 64));
begin
	v_record := pg_temp.rv_record(v_holder, 'fa-call-2', repeat('e', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]);
	v_id := (v_record ->> 'reviewId')::uuid;
	update public.qorpera_action_reviews set held_until = clock_timestamp() - interval '1 second' where id = v_id;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'The answer wakes the agent');
	v_begin := public.qorpera_begin_action_review(v_woken, c_call);
	perform pg_temp.base_assert(v_begin ->> 'state' = 'approved' and v_begin ->> 'reviewId' = v_id::text,
		'The woken repeat uses the approval');
	select * into strict v_review from public.qorpera_action_reviews where id = v_id;
	perform pg_temp.base_assert(not v_review.consumed_by_hold and v_review.consumed_run_id = (v_woken ->> 'runId')::uuid
		and clock_timestamp() < v_review.woken_at + interval '30 seconds', 'A call that began used it, within 30 s of the wake');
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'used',
		'The slow holder finds it used and does not run the action');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_holder, c_call) ->> 'state' = 'review',
		'Another run''s call of the same action is reviewed afresh');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, c_call) ->> 'state' = 'review',
		'And the woken run''s own next call, as before');
end
$$;

-- C. A card answered while its call still held it woke no one: the holder uses it, and no other call is told it was used.
do $$
declare v_holder jsonb := current_setting('qorpera_test.fa_holder')::jsonb;
	v_woken jsonb := current_setting('qorpera_test.fa_woken')::jsonb; v_record jsonb; v_answer jsonb; v_id uuid;
begin
	v_record := pg_temp.rv_record(v_holder, 'fa-call-3', repeat('f', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a02']::uuid[]);
	v_id := (v_record ->> 'reviewId')::uuid;
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', v_id, 'allow_once');
	perform pg_temp.base_assert(not (v_answer ->> 'woke')::boolean, 'An answer to a held card wakes no one');
	perform pg_temp.base_assert(public.qorpera_await_action_review(v_holder, v_id, false) ->> 'state' = 'approved',
		'The holder uses it');
	perform pg_temp.base_assert((select consumed_by_hold and woken_at is null from public.qorpera_action_reviews
		where id = v_id), 'A held call used it, and nothing woke');
	perform pg_temp.base_assert(public.qorpera_begin_action_review(v_woken, jsonb_build_object('tool', 'send_email',
		'argumentSha256', repeat('f', 64))) ->> 'state' = 'review', 'Another run''s call of it is reviewed afresh');
end
$$;

rollback;
