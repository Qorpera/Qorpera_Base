-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Contract 14.6, second cut: a peer message with priority false is written and
-- shown like any other but wakes nobody; the recipient reads it at its next
-- wake of any kind. Held messages count toward the pair's hourly budget.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.alice_binding',current_setting('qorpera_test.wake_binding'),true);

create function pg_temp.wake_run_binding(p_occurrence uuid) returns jsonb language plpgsql as $$
declare v_run uuid;
begin
	perform public.qorpera_materialize_wake_execution_runs(1);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = p_occurrence;
	return pg_temp.wake_start(v_run);
end
$$;
create function pg_temp.pair_session() returns uuid language sql as $$
	select id from public.qorpera_shared_sessions where profile_id = '30000000-0000-4000-8000-000000000010'
		and execution_scope ->> 'agentPairKey' = public.qorpera_agent_pair_key('30000000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000031')
$$;

savepoint held_shape;
do $$
declare v_alice jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_bob jsonb; v_held jsonb; v_send jsonb; v_wake jsonb;
	v_pair uuid; v_pending public.qorpera_pending_peer_messages%rowtype; v_bob_run uuid;
	v_bob_id uuid := '30000000-0000-4000-8000-000000000031';
begin
	perform pg_temp.wake_public_send(v_alice,'progress');
	-- A held message: transcript event, both chips, a waiting row, no wake, its own receipt.
	v_held := public.qorpera_send_coworker_message(v_alice,v_bob_id,'fyi-1','FYI: the note is updated.',false);
	perform pg_temp.wake_assert(v_held ->> 'status' = 'held' and v_held -> 'occurrenceId' = 'null'::jsonb,'A held message returns a held receipt');
	perform pg_temp.wake_assert(public.qorpera_send_coworker_message(v_alice,v_bob_id,'fyi-1','FYI: the note is updated.',false) = v_held,'A held receipt replays');
	perform pg_temp.wake_error(format('select public.qorpera_send_coworker_message(%L,%L,%L,%L,true)',v_alice,v_bob_id,'fyi-1','FYI: the note is updated.'),'23505');
	v_pair := pg_temp.pair_session();
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_wake_occurrences where source_kind = 'coworker'),'A held message wakes nobody');
	perform pg_temp.wake_assert((select count(*) = 1 from public.qorpera_session_events where session_id = v_pair and event_type = 'message'
		and (body #>> '{entry,delivery,held}')::boolean),'The transcript shows the held message as held');
	perform pg_temp.wake_assert((select count(*) = 2 from public.qorpera_session_events where event_type = 'session_info'
		and body ->> 'schema' = 'qorpera.peer-link/v1' and (body ->> 'held')::boolean),'Both threads get a held chip');
	select * into strict v_pending from public.qorpera_pending_peer_messages where pair_session_id = v_pair;
	perform pg_temp.wake_assert(v_pending.recipient_staff_id = v_bob_id and v_pending.delivered_run_id is null,'The message waits for Bob');
	-- Bob's next wake of any kind carries it: here a priority message from Alice.
	v_send := public.qorpera_send_coworker_message(v_alice,v_bob_id,'ask-1','And could you check it?');
	v_bob := pg_temp.wake_run_binding((v_send ->> 'occurrenceId')::uuid);
	v_bob_run := (v_bob ->> 'runId')::uuid;
	v_wake := public.qorpera_read_native_wake(v_bob);
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,heldMessages}') = 1
		and v_wake #>> '{payload,heldMessages,0,text}' = 'FYI: the note is updated.'
		and v_wake #>> '{payload,heldMessages,0,staffAgentId}' = '30000000-0000-4000-8000-000000000030'
		and v_wake #>> '{payload,heldMessages,0,pairSessionId}' = v_pair::text,'Bob reads what was left for him');
	perform pg_temp.wake_assert(jsonb_array_length(v_wake #> '{payload,transcript}') = 2,'The transcript in the wake has both messages');
	perform pg_temp.wake_assert((select delivered_run_id = v_bob_run from public.qorpera_pending_peer_messages where id = v_pending.id),'Delivery is recorded against the run');
	perform pg_temp.wake_assert(jsonb_array_length(public.qorpera_read_native_wake(v_bob) #> '{payload,heldMessages}') = 1,'A re-read by the same run sees the same');
	perform public.qorpera_assert_wake_completion(v_bob_run);
	-- A later wake of Bob does not see it again.
	v_send := public.qorpera_send_coworker_message(v_alice,v_bob_id,'ask-2','One more thing.');
	v_bob := pg_temp.wake_run_binding((v_send ->> 'occurrenceId')::uuid);
	perform pg_temp.wake_assert(not (public.qorpera_read_native_wake(v_bob) -> 'payload' ? 'heldMessages'),'A delivered message is not delivered twice');
end
$$;
rollback to held_shape;

savepoint held_budget;
do $$
declare v_alice jsonb := current_setting('qorpera_test.alice_binding')::jsonb; v_n integer; v_send jsonb;
	v_bob_id uuid := '30000000-0000-4000-8000-000000000031';
begin
	perform pg_temp.wake_public_send(v_alice,'progress');
	-- Held messages count toward the pair's hourly budget, and the hop rule does not apply to them.
	for v_n in 1..20 loop
		perform pg_temp.wake_assert(public.qorpera_send_coworker_message(v_alice,v_bob_id,'held-' || v_n::text,'Held ' || v_n::text,false) ->> 'status' = 'held','Held ' || v_n::text);
	end loop;
	v_send := public.qorpera_send_coworker_message(v_alice,v_bob_id,'held-21','Held 21',false);
	perform pg_temp.wake_assert(v_send ->> 'status' = 'causal-fence','Twenty-one held messages in an hour are too many');
	perform pg_temp.wake_assert(public.qorpera_send_coworker_message(v_alice,v_bob_id,'ask-after','A question.') ->> 'status' = 'causal-fence','The pair is paused for priority messages too');
	perform pg_temp.wake_assert((select count(*) = 20 from public.qorpera_pending_peer_messages),'Only twenty wait');
end
$$;
rollback to held_budget;
