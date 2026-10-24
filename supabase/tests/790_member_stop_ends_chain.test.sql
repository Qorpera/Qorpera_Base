-- @fixture 605_runtime_auto_review_rules.test.sql until "-- A member's post in the agent's thread; its run reviews acting calls."
-- One Stop ends a whole chain of agent work (20260930533000; 2026-10-22 amendment, item 4; contract 14.6). The base's run
-- of Alice's (the owner's post in her thread) sends an email with a receipt, messages Bob, leaves Carol a held message
-- and ends. Bob's run, started on a real runner, raises a question card and an approval card in his thread and answers
-- Alice twice: the first answer is her new run, the second a wake waiting in the queue. The owner stops Bob's run:
-- Alice's live run and her queued wake end too, the held message is withdrawn, the sent email keeps its receipt, the
-- cards stay open and Bob's thread says their chain was stopped, and answering a card wakes Bob in a new run that is
-- reviewed against the answer. A later wake of the chain is cancelled at admission, or by the materializer when it
-- slipped in beside the Stop, and a machine event of Alice's ended run is put away, pass after pass, waking nobody. Who
-- may stop is unchanged, and another chain (the owner's post in Carol's thread) runs on. Runs on 605's fixture part
-- (596's card helpers, 605's rules). 791 runs the Stop against another Stop and against the materializer.
select pg_temp.base_claims('service_role');

create function pg_temp.cs_job(p_run uuid) returns public.qorpera_runner_jobs language sql as $$
	select job.* from public.qorpera_runner_jobs job join public.qorpera_execution_runs run on run.job_id = job.id
	where run.id = p_run
$$;
-- An agent's thread conversation, read once as the service (a member's role reads no rooms table).
create function pg_temp.cs_session(p_staff uuid) returns uuid language sql as $$
	select current_setting('qorpera_test.cs_thread_' || right(p_staff::text, 2))::uuid
$$;
select set_config('qorpera_test.cs_thread_' || right(room.bound_staff_agent_id::text, 2), room.session_id::text, false)
from public.qorpera_company_rooms room
where room.profile_id = '92400000-0000-4000-8000-000000000010' and room.bound_staff_agent_id in
	('92400000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000031', '92400000-0000-4000-8000-000000000032')
\g /dev/null
create function pg_temp.cs_denied(p_session uuid, p_run uuid) returns void language sql as $$
	select pg_temp.base_error(format('select public.qorpera_cancel_session_run(%L, %L)', p_session, p_run), '42501',
		'cloud run cancellation is not allowed')
$$;
create function pg_temp.cs_receipts() returns jsonb language sql as $$
	select coalesce(jsonb_agg(to_jsonb(receipt) order by receipt.id), '[]'::jsonb)
	from public.qorpera_run_operation_receipts receipt
	where receipt.run_id in ((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
		(current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid)
$$;
create function pg_temp.cs_notes(p_session uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(event.body order by event.sequence), '[]'::jsonb) from public.qorpera_session_events event
	where event.session_id = p_session and event.event_type = 'session_info'
		and event.body ->> 'schema' = 'qorpera.chain-stopped/v1'
$$;

-- The shape: the patched functions carry the change, and the new functions and table are internal.
do $$
declare v_stop text := (select prosrc from pg_proc
	where oid = 'public.qorpera_cancel_session_run_profile_scope(uuid,uuid)'::regprocedure);
begin
	perform pg_temp.base_assert(position('qorpera_stop_run_chain(p_run_id)' in v_stop) > 0
		and position('pg_advisory_xact_lock(public.qorpera_causal_chain_key(' in v_stop) > 0
		and position('pg_advisory_xact_lock(public.qorpera_causal_chain_key(' in v_stop) < position('for update of job' in v_stop)
		and position('run.source_kind in (''session_turn'',''room_delivery'',''wake'')' in (select prosrc from pg_proc
			where oid = 'public.qorpera_cancel_session_run_profile_scope(uuid,uuid)'::regprocedure)) > 0
		and position('20260930533000' in (select prosrc from pg_proc
			where oid = 'public.qorpera_pin_wake_occurrence()'::regprocedure)) > 0
		and position('20260930533000' in (select prosrc from pg_proc
			where oid = 'public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)'::regprocedure)) > 0
		and position('20260930533000' in (select prosrc from pg_proc
			where oid = 'public.qorpera_wake_origin(public.qorpera_wake_occurrences)'::regprocedure)) > 0
		and position('20260930518000' in (select prosrc from pg_proc
			where oid = 'public.qorpera_wake_origin(public.qorpera_wake_occurrences)'::regprocedure)) > 0
		and position('qorpera_run_chain_stopped(v_run.id)' in (select prosrc from pg_proc
			where oid = 'public.qorpera_folder_parent_continuation(uuid,text)'::regprocedure)) > 0
		and position('qorpera_run_chain_stopped(v_parent.id)' in (select prosrc from pg_proc
			where oid = 'public.qorpera_folder_office_wakes_company(uuid,integer)'::regprocedure)) > 0,
		'The Stop (its chain lock before the job), admission, the approval answer, the origin, the parent continuation and '
		|| 'the office start carry the chain Stop; the earlier patches stay');
	perform pg_temp.base_assert(not has_function_privilege('authenticated', 'public.qorpera_stop_run_chain(uuid)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_stop_run_chain(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_stop_run_chain(uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_causal_chain_stopped(uuid,uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_run_chain_stopped(uuid)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_causal_chain_key(uuid,uuid)', 'execute')
		and not has_table_privilege('authenticated', 'public.qorpera_stopped_chains', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_stopped_chains', 'select')
		and has_function_privilege('authenticated', 'public.qorpera_cancel_session_run(uuid,uuid)', 'execute'),
		'The chain Stop is reached only through the conversation Stop');
end $$;

-- Alice's run (the base's): its acknowledgement, an email it sent (a completed receipt), a message to Bob and a held
-- message to Carol, its final report, and its end. Bob's run in his thread starts on a real runner.
do $$
declare v_alice jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_send jsonb; v_held jsonb; v_pass jsonb;
	v_bob_run uuid; v_receipt uuid := '79000000-0000-4000-8000-0000000000e1';
begin
	perform pg_temp.base_public_send(v_alice, 'progress');
	perform pg_temp.base_assert(public.qorpera_folder_begin_run_receipt(v_alice, v_receipt, 'send_email:acme', repeat('e', 64),
		repeat('f', 64), false) ->> 'state' = 'executing', 'Fixture: Alice''s email begins');
	perform pg_temp.base_assert(public.qorpera_folder_complete_run_receipt(v_alice, v_receipt, repeat('e', 64),
		'{"sent":true,"messageId":"acme-1"}') ->> 'state' = 'completed', 'Fixture: Alice''s email is sent');
	v_send := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000031', 'cs-ask',
		'Could you check the price list?');
	v_held := public.qorpera_send_coworker_message(v_alice, '92400000-0000-4000-8000-000000000032', 'cs-fyi',
		'FYI: prices change on Monday.', false);
	perform pg_temp.base_assert(v_send ->> 'status' = 'queued' and v_held ->> 'status' = 'held',
		'Fixture: Bob is woken, Carol''s message is held: ' || v_send::text || v_held::text);
	perform pg_temp.base_public_send(v_alice, 'final', 'cs-final');
	update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
		lease_token_sha256 = null, lease_expires_at = null where id = (v_alice ->> 'jobId')::uuid;
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_bob_run from public.qorpera_wake_occurrences
	where id = (v_send ->> 'occurrenceId')::uuid and status = 'materialized';
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_bob_run), 'Fixture: Bob''s run: ' || v_pass::text);
	perform set_config('qorpera_test.cs_bob', pg_temp.base_start(v_bob_run)::text, false);
	perform set_config('qorpera_test.cs_bob_wake', v_send ->> 'occurrenceId', false);
end $$;

-- Bob's run raises a question card and an approval card in his thread (the approval's holder heartbeat lies ahead). The
-- owner's post in Carol's thread is another chain, made a run. Then Bob answers Alice: the answer is her new run, still
-- queued, and his second answer a wake waiting in the queue.
do $$
declare v_bob jsonb := current_setting('qorpera_test.cs_bob')::jsonb; v_card jsonb; v_review uuid; v_reply jsonb;
	v_carol jsonb; v_pass jsonb; v_carol_run uuid; v_answer jsonb; v_alice_run uuid;
begin
	v_card := pg_temp.cd_card(v_bob, '79000000-0000-4000-8000-0000000000c1');
	perform pg_temp.base_assert(v_card ->> 'session_id' = pg_temp.cs_session('92400000-0000-4000-8000-000000000031')::text
		and v_card ->> 'actor_user_id' = '92400000-0000-4000-8000-000000000001', 'Fixture: Bob asks in his thread: ' || v_card::text);
	v_review := (pg_temp.rv_record(v_bob, 'cs-call-1', repeat('d', 64), 'ask',
		array['60500000-0000-4000-8000-000000000a01']::uuid[]) ->> 'reviewId')::uuid;
	perform pg_temp.base_assert((select held_until > clock_timestamp() + interval '5 seconds' and card_session_id = pg_temp.cs_session(
		'92400000-0000-4000-8000-000000000031') from public.qorpera_action_reviews where id = v_review),
		'Fixture: the approval card is held by Bob''s call');
	v_carol := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000032',
		'Carol, draft the newsletter.');
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_carol_run from public.qorpera_wake_occurrences where id = (v_carol ->> 0)::uuid;
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_carol_run), 'Fixture: Carol''s run: ' || v_pass::text);
	v_answer := public.qorpera_send_coworker_message(v_bob, '92400000-0000-4000-8000-000000000030', 'cs-answer',
		'The price list is checked.');
	v_pass := pg_temp.base_materialize();
	select run_id into strict v_alice_run from public.qorpera_wake_occurrences
	where id = (v_answer ->> 'occurrenceId')::uuid and status = 'materialized';
	perform pg_temp.base_assert(v_pass -> 'run_ids' = jsonb_build_array(v_alice_run)
		and (pg_temp.cs_job(v_alice_run)).status = 'queued', 'Fixture: Bob''s answer is Alice''s new run: ' || v_pass::text);
	v_reply := public.qorpera_send_coworker_message(v_bob, '92400000-0000-4000-8000-000000000030', 'cs-reply',
		'And the discount table too.');
	perform pg_temp.base_assert(v_reply ->> 'status' = 'queued' and (select status = 'queued'
		from public.qorpera_wake_occurrences where id = (v_reply ->> 'occurrenceId')::uuid),
		'Fixture: Bob answers Alice again, and her wake waits: ' || v_reply::text);
	perform set_config('qorpera_test.cs_alice2', v_alice_run::text, false);
	perform set_config('qorpera_test.cs_review', v_review::text, false);
	perform set_config('qorpera_test.cs_reply', v_reply ->> 'occurrenceId', false);
	perform set_config('qorpera_test.cs_carol_run', v_carol_run::text, false);
	-- Every receipt of the chain's runs as the Stop finds them: the email's, and the messages'.
	perform set_config('qorpera_test.cs_receipts', pg_temp.cs_receipts()::text, false);
end $$;

-- 1. Who may stop is unchanged: a contributor who did not start the chain and a viewer cannot stop Bob's run, and their
--    refusals end nothing.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
select pg_temp.cs_denied(pg_temp.cs_session('92400000-0000-4000-8000-000000000031'),
	(current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid);
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000003');
select pg_temp.cs_denied(pg_temp.cs_session('92400000-0000-4000-8000-000000000031'),
	(current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid);
reset role;
select pg_temp.base_assert((pg_temp.cs_job(current_setting('qorpera_test.cs_alice2')::uuid)).status = 'queued'
	and (pg_temp.cs_job((current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid)).status = 'leased'
	and (select status = 'queued' from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.cs_reply')::uuid)
	and not exists (select 1 from public.qorpera_stopped_chains), 'Refused Stops end nothing');

-- 2. The owner stops Bob's run in his thread: the Stop answers for that run, as before, and ends its whole chain.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_cancel_session_run(pg_temp.cs_session('92400000-0000-4000-8000-000000000031'),
	(current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid) = jsonb_build_object(
	'session_id', pg_temp.cs_session('92400000-0000-4000-8000-000000000031'),
	'run_id', current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId', 'status', 'cancelled'), 'The Stop confirms Bob''s run');
select pg_temp.base_assert(public.qorpera_get_session_run_control(pg_temp.cs_session('92400000-0000-4000-8000-000000000031')) -> 'run'
		= 'null'::jsonb
	and public.qorpera_get_session_run_control(pg_temp.cs_session('92400000-0000-4000-8000-000000000030')) -> 'run' = 'null'::jsonb,
	'Neither agent''s thread has a live run after the Stop');
reset role;
do $$
declare v_alice uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_alice2 uuid := current_setting('qorpera_test.cs_alice2')::uuid;
	v_bob uuid := (current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid; v_root uuid;
	v_reply public.qorpera_wake_occurrences%rowtype;
begin
	select causal_root_id into strict v_root from public.qorpera_wake_occurrences where run_id = v_alice;
	perform pg_temp.base_assert((select causal_root_id from public.qorpera_wake_occurrences where run_id = v_bob) = v_root
		and (select causal_root_id from public.qorpera_wake_occurrences where run_id = v_alice2) = v_root,
		'Fixture: Bob''s and Alice''s new runs are in the chain the owner''s post started');
	-- The other agent's live run ends, as the member's own Stop ends a run.
	perform pg_temp.base_assert((pg_temp.cs_job(v_alice2)).status = 'cancelled'
		and (pg_temp.cs_job(v_alice2)).cancelled_by_user_id = '92400000-0000-4000-8000-000000000001'
		and (pg_temp.cs_job(v_alice2)).last_error = 'A member stopped this chain of agent work'
		and (pg_temp.cs_job(v_bob)).status = 'cancelled'
		and (pg_temp.cs_job(v_bob)).cancelled_by_user_id = '92400000-0000-4000-8000-000000000001',
		'Alice''s live run is stopped with Bob''s, by the owner: ' || to_jsonb(pg_temp.cs_job(v_alice2))::text);
	perform pg_temp.base_assert((select count(*) = 1 from public.qorpera_runner_audit_receipts receipt
		where receipt.job_id = (pg_temp.cs_job(v_alice2)).id and receipt.event_type = 'job_cancelled'
			and receipt.actor_user_id = '92400000-0000-4000-8000-000000000001'
			and receipt.payload = jsonb_build_object('chainRootId', v_root, 'stoppedRunId', v_bob)),
		'Its cancellation is audited as the chain''s');
	perform pg_temp.base_assert((select status = 'cancelled' from public.qorpera_wake_occurrences where run_id = v_alice2)
		and (select status = 'cancelled' from public.qorpera_wake_occurrences where run_id = v_bob),
		'Both runs'' wakes end cancelled');
	-- A run of the chain that had ended stays as it ended.
	perform pg_temp.base_assert((pg_temp.cs_job(v_alice)).status = 'completed' and (pg_temp.cs_job(v_alice)).cancelled_by_user_id is null
		and (select status = 'completed' from public.qorpera_wake_occurrences where run_id = v_alice),
		'Alice''s ended run stays completed');
	-- Bob's answer to Alice, still queued, never wakes her.
	select * into strict v_reply from public.qorpera_wake_occurrences where id = current_setting('qorpera_test.cs_reply')::uuid;
	perform pg_temp.base_assert(v_reply.status = 'cancelled' and v_reply.run_id is null and v_reply.finished_at is not null
		and v_reply.blocked_reason = 'A member stopped this chain of agent work' and v_reply.causal_root_id = v_root,
		'The queued wake of the chain is cancelled: ' || to_jsonb(v_reply)::text);
	-- The held message to Carol is withdrawn; the pair transcript keeps it.
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_pending_peer_messages
			where recipient_staff_id = '92400000-0000-4000-8000-000000000032')
		and exists (select 1 from public.qorpera_session_events event where event.event_type = 'message'
			and event.body #>> '{entry,delivery,schema}' = 'qorpera.peer-message/v1'
			and event.body #>> '{entry,delivery,operationKey}' = 'cs-fyi'),
		'The held message no run read is withdrawn; the transcript keeps it');
	perform pg_temp.base_assert((select count(*) = 1 and bool_and(causal_root_id = v_root and stopped_run_id = v_bob
			and stopped_by_user_id = '92400000-0000-4000-8000-000000000001')
		from public.qorpera_stopped_chains), 'The chain''s root is recorded as stopped by the owner');
	-- Another chain runs on.
	perform pg_temp.base_assert((pg_temp.cs_job(current_setting('qorpera_test.cs_carol_run')::uuid)).status = 'queued',
		'The owner''s post in Carol''s thread is another chain and stays queued');
end $$;

-- 3. The email Alice sent keeps its receipt: nothing is undone, and nothing is sent again.
select pg_temp.base_assert(pg_temp.cs_receipts() = current_setting('qorpera_test.cs_receipts')::jsonb
	and pg_temp.cs_receipts() @> '[{"logical_operation_key":"send_email:acme","status":"completed",
		"result":{"sent":true,"messageId":"acme-1"}}]', 'A sent outside action keeps its receipt as it was');

-- 4. The cards stay open, and Bob's thread says their chain was stopped, once. Alice's thread raised none.
do $$
declare v_bob uuid := (current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid;
	v_notes jsonb := pg_temp.cs_notes(pg_temp.cs_session('92400000-0000-4000-8000-000000000031'));
begin
	perform pg_temp.base_assert((select count(*) = 2 from public.qorpera_session_events event
		where event.execution_kind = 'run' and event.execution_id = v_bob
			and event.event_type in ('interaction_request', 'authorization_request')
			and event.event_id in ('79000000-0000-4000-8000-0000000000c1', current_setting('qorpera_test.cs_review')::uuid)),
		'Fixture: both cards are Bob''s run''s');
	perform pg_temp.base_assert(v_notes = jsonb_build_array(jsonb_build_object('schema', 'qorpera.chain-stopped/v1',
		'cardIds', jsonb_build_array('79000000-0000-4000-8000-0000000000c1', current_setting('qorpera_test.cs_review')),
		'stoppedRunId', v_bob, 'stoppedByUserId', '92400000-0000-4000-8000-000000000001')),
		'Bob''s thread names its cards as stopped: ' || v_notes::text);
	perform pg_temp.base_assert(pg_temp.cs_notes(pg_temp.cs_session('92400000-0000-4000-8000-000000000030')) = '[]'::jsonb,
		'A thread without cards of the chain gets no note');
	perform pg_temp.base_assert((select answer is null and decision = 'ask' from public.qorpera_action_reviews
		where id = current_setting('qorpera_test.cs_review')::uuid)
		and not exists (select 1 from public.qorpera_session_events where event_type = 'interaction_answer'),
		'The cards stay open');
end $$;

-- 5. A retried Stop reads back: it cancels nothing twice and adds no second note.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_cancel_session_run(pg_temp.cs_session('92400000-0000-4000-8000-000000000031'),
	(current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid) ->> 'status' = 'cancelled', 'A retried Stop reads back');
reset role;
select pg_temp.base_assert((select count(*) = 2 from public.qorpera_runner_audit_receipts receipt
	where receipt.event_type = 'job_cancelled' and receipt.job_id in (
		(pg_temp.cs_job(current_setting('qorpera_test.cs_alice2')::uuid)).id,
		(pg_temp.cs_job((current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid)).id))
	and jsonb_array_length(pg_temp.cs_notes(pg_temp.cs_session('92400000-0000-4000-8000-000000000031'))) = 1,
	'The retry repeats no cancellation and no note');

-- 6. The chain stays stopped. A wake it would still cause (Bob's message to Alice landing late) is cancelled at
--    admission; one admitted beside the Stop, before the record was visible, is refused by the materializer (791 runs
--    that race with two connections).
do $$
declare v_bob uuid := (current_setting('qorpera_test.cs_bob')::jsonb ->> 'runId')::uuid; v_late public.qorpera_wake_occurrences;
	v_stopped public.qorpera_stopped_chains; v_pass jsonb;
begin
	perform public.qorpera_folder_admit_wakes('92400000-0000-4000-8000-000000000010');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, staff_agent_id,
		parent_run_id, session_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'agent',
		'coworker', '92400000-0000-4000-8000-000000000030', v_bob, pg_temp.cs_session('92400000-0000-4000-8000-000000000030'),
		'coworker', 'coworker:' || v_bob || ':cs-late', clock_timestamp(), clock_timestamp(), '{"text":"One more thing."}')
	returning * into v_late;
	perform pg_temp.base_assert(v_late.status = 'cancelled' and v_late.blocked_reason = 'A member stopped this chain of agent work'
		and v_late.finished_at is not null, 'A late wake of the stopped chain is cancelled at admission: ' || to_jsonb(v_late)::text);
	-- Admitted while the Stop committed: the record not yet visible to its admission.
	delete from public.qorpera_stopped_chains returning * into strict v_stopped;
	perform public.qorpera_folder_admit_wakes('92400000-0000-4000-8000-000000000010');
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, staff_agent_id,
		parent_run_id, session_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'agent',
		'coworker', '92400000-0000-4000-8000-000000000030', v_bob, pg_temp.cs_session('92400000-0000-4000-8000-000000000030'),
		'coworker', 'coworker:' || v_bob || ':cs-race', clock_timestamp(), clock_timestamp(), '{"text":"And another."}')
	returning * into v_late;
	perform pg_temp.base_assert(v_late.status = 'queued', 'Fixture: the racing wake is admitted');
	insert into public.qorpera_stopped_chains(profile_id, causal_root_id, stopped_run_id, stopped_by_user_id, stopped_at)
	values (v_stopped.profile_id, v_stopped.causal_root_id, v_stopped.stopped_run_id, v_stopped.stopped_by_user_id,
		v_stopped.stopped_at);
	v_pass := pg_temp.base_materialize();
	select * into strict v_late from public.qorpera_wake_occurrences where id = v_late.id;
	perform pg_temp.base_assert(v_late.status = 'cancelled' and v_late.run_id is null
		and v_late.blocked_reason = 'The run could not start: A member stopped this chain of agent work'
		and v_pass -> 'run_ids' = '[]'::jsonb and (v_pass ->> 'cancelled')::integer = 1,
		'The materializer refuses a run of the stopped chain: ' || to_jsonb(v_late)::text || v_pass::text);
end $$;

-- 6b. A machine of Alice's ended run reports after the Stop. The step that carries a parent's events sees the parent's
--     chain stopped and puts the event away; its next pass has nothing left, and no wake is ever tried.
do $$
declare v_alice public.qorpera_execution_runs; v_event uuid := '79000000-0000-4000-8000-0000000000d1'; v_first jsonb;
	v_second jsonb;
begin
	select * into strict v_alice from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	perform pg_temp.base_assert(public.qorpera_folder_parent_continuation(v_alice.id, 'machine-event') = 'stopped'
		and public.qorpera_folder_parent_continuation(v_alice.id, 'machine-checkin') = 'stopped',
		'An ended parent whose chain was stopped is stopped for its machines');
	-- A machine Alice's run started (its row only: no node, no placement) and its report, as the machine's step writes it.
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
		started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
	values ('79000000-0000-4000-8000-0000000000d2', v_alice.profile_id, v_alice.environment_id, 'price-check', 'Check the prices.',
		v_alice.staff_agent_id, v_alice.id, extensions.gen_random_uuid(), v_alice.requested_by_user_id, 1, 1073741824, 10737418240,
		'standard', 'task');
	insert into public.qorpera_company_machine_events(id, machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind)
	values (v_event, '79000000-0000-4000-8000-0000000000d2', v_alice.profile_id, v_alice.environment_id, v_alice.staff_agent_id,
		v_alice.id, 'running');
	perform set_config('session_replication_role', 'origin', true);
	v_first := public.qorpera_folder_machine_events_company('92400000-0000-4000-8000-000000000020', 8);
	v_second := public.qorpera_folder_machine_events_company('92400000-0000-4000-8000-000000000020', 8);
	perform pg_temp.base_assert(v_first ->> 'state' = 'done' and (v_first ->> 'suppressed')::integer = 1
		and (v_first ->> 'delivered')::integer = 0 and v_second ->> 'state' = 'idle'
		and (select delivery = 'suppressed' from public.qorpera_company_machine_events where id = v_event)
		and not exists (select 1 from public.qorpera_wake_occurrences where parent_run_id = v_alice.id
			and source_kind = 'machine-event'),
		'The event is put away once and no wake is tried: ' || v_first::text || v_second::text);
end $$;

-- 7. An answer starts new work. The approval card's holder is gone, so Allow once wakes Bob although the holder's
--    heartbeat lay ahead, in a new chain whose run carries no origin: its review reads the answer, not Bob's stopped
--    request. The question card's answer wakes him too. Both become runs; Alice is woken by nothing.
do $$
declare v_answer jsonb; v_wake public.qorpera_wake_occurrences; v_client uuid := '79000000-0000-4000-8000-0000000000a1';
	v_question public.qorpera_wake_occurrences; v_pass jsonb; v_root uuid;
begin
	select causal_root_id into strict v_root from public.qorpera_stopped_chains;
	perform pg_temp.base_assert((select held_until > clock_timestamp() from public.qorpera_action_reviews
		where id = current_setting('qorpera_test.cs_review')::uuid), 'Fixture: the stopped holder''s heartbeat still lies ahead');
	v_answer := pg_temp.rv_answer('92400000-0000-4000-8000-000000000001', current_setting('qorpera_test.cs_review')::uuid,
		'allow_once');
	perform pg_temp.base_assert((v_answer ->> 'woke')::boolean, 'The answer wakes Bob: ' || v_answer::text);
	select * into strict v_wake from public.qorpera_wake_occurrences
	where source_kind = 'room' and source_id = (v_answer ->> 'inputId')::uuid;
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.causal_root_id = v_wake.id and v_wake.causal_root_id <> v_root
		and v_wake.origin_run_id is null and v_wake.session_id = pg_temp.cs_session('92400000-0000-4000-8000-000000000031'),
		'The approval''s run is new work with no origin in the stopped chain: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(v_client, '79000000-0000-4000-8000-0000000000c1', 'answered', '{"values":["general"]}');
	perform pg_temp.base_claims('service_role');
	select wake.* into strict v_question from public.qorpera_wake_occurrences wake
	join public.qorpera_session_inputs input on input.id = wake.source_id and wake.source_kind = 'room'
	where input.client_input_id = v_client;
	perform pg_temp.base_assert(v_question.status = 'queued' and v_question.causal_root_id = v_question.id,
		'The question''s answer wakes Bob in new work: ' || to_jsonb(v_question)::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 2
		and (select bool_and(run.staff_agent_id = '92400000-0000-4000-8000-000000000031')
			from public.qorpera_execution_runs run where run.id in (select (jsonb_array_elements_text(v_pass -> 'run_ids'))::uuid))
		and (select status = 'materialized' from public.qorpera_wake_occurrences where id = v_wake.id)
		and (select status = 'materialized' from public.qorpera_wake_occurrences where id = v_question.id),
		'Both answers become Bob''s runs, and nothing wakes Alice: ' || v_pass::text);
	perform set_config('qorpera_test.cs_answer_runs', (v_pass -> 'run_ids')::text, false);
end $$;

-- 8. A Stop of a run whose chain holds nothing else ends that run alone.
set local role authenticated;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select pg_temp.base_assert(public.qorpera_cancel_session_run(pg_temp.cs_session('92400000-0000-4000-8000-000000000032'),
	current_setting('qorpera_test.cs_carol_run')::uuid) ->> 'status' = 'cancelled', 'The owner stops Carol''s run');
reset role;
select pg_temp.base_assert((select count(*) = 2 from public.qorpera_stopped_chains)
	and (select count(*) = 1 from public.qorpera_runner_audit_receipts receipt
		where receipt.event_type = 'job_cancelled' and receipt.job_id = (pg_temp.cs_job(current_setting('qorpera_test.cs_carol_run')::uuid)).id)
	and jsonb_array_length(pg_temp.cs_notes(pg_temp.cs_session('92400000-0000-4000-8000-000000000032'))) = 0
	and (select bool_and((pg_temp.cs_job(run.value::uuid)).status = 'queued')
		from jsonb_array_elements_text(current_setting('qorpera_test.cs_answer_runs')::jsonb) run),
	'Carol''s run ends alone; the answers'' runs stay queued');

rollback;
