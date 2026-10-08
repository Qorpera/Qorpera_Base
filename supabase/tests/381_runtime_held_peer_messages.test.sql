-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Held coworker messages between agents' real runs, on folder-v2 (ported from snapshot-v1 in the legacy sweep; contract
-- 14.6, second cut): a peer message with priority false is written and shown like any other but wakes nobody; the
-- recipient reads it at its next wake of any kind, once, unless the run that read it failed. No hourly limit holds them
-- back (runtime v92). The sender is the base's leased run of Alice's; each recipient's wake is made a run by the folder
-- materializer and started on a real runner with a native lease.

-- An agent's thread conversation.
create function pg_temp.hm_session(p_staff uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms
	where profile_id = '92400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
-- Alice and Bob's pair transcript.
create function pg_temp.hm_pair() returns uuid language sql as $$
	select id from public.qorpera_shared_sessions where profile_id = '92400000-0000-4000-8000-000000000010'
		and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key('92400000-0000-4000-8000-000000000030',
			'92400000-0000-4000-8000-000000000031')
$$;
-- The materializer makes the one queued coworker wake a run; it starts on a real runner. Answers its binding.
create function pg_temp.hm_run(p_occurrence uuid) returns jsonb language plpgsql as $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid;
begin
	select run_id into v_run from public.qorpera_wake_occurrences where id = p_occurrence and status = 'materialized';
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run),
		'Coworker wake materialized: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end $$;
-- A live run of Carol's: Alice wakes her once; the binding is reused for Carol's own sends.
create function pg_temp.hm_carol() returns jsonb language plpgsql as $$
declare v_send jsonb; v_binding jsonb;
begin
	if coalesce(current_setting('qorpera_test.hm_carol', true), '') <> '' then return current_setting('qorpera_test.hm_carol')::jsonb; end if;
	v_send := public.qorpera_send_coworker_message(current_setting('qorpera_test.base_binding')::jsonb,
		'92400000-0000-4000-8000-000000000032', 'carol-open', 'Carol, a note for you.');
	v_binding := pg_temp.hm_run((v_send ->> 'occurrenceId')::uuid);
	perform set_config('qorpera_test.hm_carol', v_binding::text, true);
	return v_binding;
end $$;

-- 1. A held message's shape and delivery.
savepoint hm_shape;
do $$
declare v_alice jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_bob jsonb; v_held jsonb; v_send jsonb; v_wake jsonb;
	v_carol_note jsonb; v_n integer; v_pair uuid; v_pending public.qorpera_pending_peer_messages; v_bob_run uuid;
	v_bob_id uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.base_public_send(v_alice, 'progress');
	-- A held message: a transcript event, both chips, a waiting row, no wake, its own receipt.
	v_held := public.qorpera_send_coworker_message(v_alice, v_bob_id, 'fyi-1', 'FYI: the note is updated.', false);
	perform pg_temp.base_assert(v_held ->> 'status' = 'held' and v_held -> 'occurrenceId' = 'null'::jsonb,
		'A held message returns a held receipt: ' || v_held::text);
	perform pg_temp.base_assert(public.qorpera_send_coworker_message(v_alice, v_bob_id, 'fyi-1', 'FYI: the note is updated.', false) = v_held,
		'A held receipt replays');
	perform pg_temp.base_error(format('select public.qorpera_send_coworker_message(%L, %L, %L, %L, true)', v_alice, v_bob_id, 'fyi-1',
		'FYI: the note is updated.'), '23505');
	v_pair := pg_temp.hm_pair();
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_wake_occurrences where source_kind = 'coworker'),
		'A held message wakes nobody');
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_session_events where session_id = v_pair and event_type = 'message'
		and (body #>> '{entry,delivery,held}')::boolean), 'The transcript shows the held message as held');
	perform pg_temp.base_assert((select count(*) = 2 from public.qorpera_session_events where event_type = 'session_info'
		and session_id in (pg_temp.hm_session('92400000-0000-4000-8000-000000000030'), pg_temp.hm_session(v_bob_id))
		and body ->> 'schema' = 'qorpera.peer-link/v1' and (body ->> 'held')::boolean), 'Both threads get a held chip');
	select * into strict v_pending from public.qorpera_pending_peer_messages where pair_session_id = v_pair;
	perform pg_temp.base_assert(v_pending.recipient_staff_id = v_bob_id and v_pending.delivered_run_id is null, 'The message waits for Bob');
	-- Carol also leaves Bob a note; Bob's next wake of any kind carries it. The wake here is a priority message from Alice,
	-- whose pair transcript already shows Alice's held note, so only Carol's arrives under heldMessages while both are
	-- claimed.
	v_carol_note := public.qorpera_send_coworker_message(pg_temp.hm_carol(), v_bob_id, 'carol-fyi', 'Carol: numbers are in.', false);
	perform pg_temp.base_assert(v_carol_note ->> 'status' = 'held', 'Carol''s note is held');
	v_send := public.qorpera_send_coworker_message(v_alice, v_bob_id, 'ask-1', 'And could you check it?');
	v_bob := pg_temp.hm_run((v_send ->> 'occurrenceId')::uuid);
	v_bob_run := (v_bob ->> 'runId')::uuid;
	v_wake := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.base_assert(jsonb_array_length(v_wake #> '{payload,heldMessages}') = 1
		and v_wake #>> '{payload,heldMessages,0,text}' = 'Carol: numbers are in.'
		and v_wake #>> '{payload,heldMessages,0,staffAgentId}' = '92400000-0000-4000-8000-000000000032',
		'Bob reads what another coworker left for him: ' || v_wake::text);
	perform pg_temp.base_assert(jsonb_array_length(v_wake #> '{payload,transcript}') = 2
		and v_wake #>> '{payload,transcript,0,text}' = 'FYI: the note is updated.', 'Alice''s held note is in the transcript, not repeated');
	perform pg_temp.base_assert((select count(*) = 2 from public.qorpera_pending_peer_messages where delivered_run_id = v_bob_run),
		'Both notes are claimed by the run');
	perform pg_temp.base_assert(jsonb_array_length(public.qorpera_read_native_wake(v_bob) #> '{payload,heldMessages}') = 1,
		'A re-read by the same run sees the same');
	perform public.qorpera_assert_wake_completion(v_bob_run);
	-- A later wake of Bob does not see them again.
	v_send := public.qorpera_send_coworker_message(v_alice, v_bob_id, 'ask-2', 'One more thing.');
	v_bob := pg_temp.hm_run((v_send ->> 'occurrenceId')::uuid);
	perform pg_temp.base_assert(not (public.qorpera_read_native_wake(v_bob) -> 'payload' ? 'heldMessages'), 'A delivered message is not delivered twice');
	perform public.qorpera_assert_wake_completion((v_bob ->> 'runId')::uuid);
	-- A held note the transcript window no longer shows is not swallowed by the same-pair rule.
	perform pg_temp.base_assert(public.qorpera_send_coworker_message(v_alice, v_bob_id, 'old-note', 'An old note.', false) ->> 'status' = 'held',
		'An old note is held');
	for v_n in 1..12 loop
		perform public.qorpera_send_coworker_message(v_alice, v_bob_id, 'filler-' || v_n::text, 'Filler ' || v_n::text, false);
	end loop;
	v_send := public.qorpera_send_coworker_message(v_alice, v_bob_id, 'ask-window', 'Windowed question.');
	v_bob := pg_temp.hm_run((v_send ->> 'occurrenceId')::uuid);
	v_wake := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.base_assert(jsonb_array_length(v_wake #> '{payload,transcript}') = 12, 'The transcript window is twelve');
	perform pg_temp.base_assert(v_wake #>> '{payload,heldMessages,0,text}' = 'An old note.' and v_wake #>> '{payload,heldMessages,1,text}' = 'Filler 1'
		and jsonb_array_length(v_wake #> '{payload,heldMessages}') = 2, 'Notes older than the transcript window still arrive');
	perform public.qorpera_assert_wake_completion((v_bob ->> 'runId')::uuid);
	-- Unless the run that claimed it failed: then the next wake gets it again.
	v_carol_note := public.qorpera_send_coworker_message(pg_temp.hm_carol(), v_bob_id, 'carol-fyi-2', 'Carol: one correction.', false);
	v_send := public.qorpera_send_coworker_message(v_alice, v_bob_id, 'ask-3', 'Third thing.');
	v_bob := pg_temp.hm_run((v_send ->> 'occurrenceId')::uuid);
	perform pg_temp.base_assert(public.qorpera_read_native_wake(v_bob) #>> '{payload,heldMessages,0,text}' = 'Carol: one correction.',
		'The failing run claimed the note');
	update public.qorpera_runner_jobs set status = 'failed', last_error = 'Fixture failure', finished_at = statement_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where run_id = (v_bob ->> 'runId')::uuid;
	v_send := public.qorpera_send_coworker_message(v_alice, v_bob_id, 'ask-4', 'Fourth thing.');
	v_bob := pg_temp.hm_run((v_send ->> 'occurrenceId')::uuid);
	perform pg_temp.base_assert(public.qorpera_read_native_wake(v_bob) #>> '{payload,heldMessages,0,text}' = 'Carol: one correction.',
		'A note claimed by a failed run is offered again');
end $$;
rollback to savepoint hm_shape;

-- 2. No hourly limit per pair (runtime v92): twenty-five held messages all wait, and a priority message still goes.
savepoint hm_budget;
do $$
declare v_alice jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_n integer;
	v_bob_id uuid := '92400000-0000-4000-8000-000000000031';
begin
	perform pg_temp.base_public_send(v_alice, 'progress');
	for v_n in 1..25 loop
		perform pg_temp.base_assert(public.qorpera_send_coworker_message(v_alice, v_bob_id, 'held-' || v_n::text, 'Held ' || v_n::text, false)
			->> 'status' = 'held', 'Held ' || v_n::text);
	end loop;
	perform pg_temp.base_assert(public.qorpera_send_coworker_message(v_alice, v_bob_id, 'ask-after', 'A question.') ->> 'status' = 'queued',
		'A priority message after many held ones is queued');
	perform pg_temp.base_assert((select count(*) = 25 from public.qorpera_pending_peer_messages
		where recipient_staff_id = v_bob_id and delivered_run_id is null), 'All twenty-five wait');
end $$;
rollback to savepoint hm_budget;

rollback;
