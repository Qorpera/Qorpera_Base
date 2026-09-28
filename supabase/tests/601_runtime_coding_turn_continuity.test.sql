-- @fixture 396_runtime_coding_executor.test.sql until "-- 4. Control plane only."
-- A coding session's turns are one conversation (review findings #4 and #8, 2026-09-25).
--
-- Every turn is a row of its own: what started it (the dispatch, the agent's
-- follow-up or the owner's answer), what the harness submitted in it, and how
-- it ended. A submission belongs to its turn's sequence, so an executor lost
-- after the harness submitted cannot hand that submission to the next turn:
-- the owner's retry runs. The next turn reads the session's own earlier turns,
-- including the exact question it asked and its choices, so a short answer
-- ("B") is enough.
--
-- The fixture leaves fix-send at sequence 2: turn 1 finished with draft PR 204,
-- turn 2 asked "Keep 250 ms, or raise to 500 ms?" and waits for the owner.

create function pg_temp.observe() returns void language sql as $$
	select public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
		'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
		public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
		jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
	select null::void
$$;
create function pg_temp.storage(p_worker uuid) returns jsonb language sql as $$
	select current_setting('qorpera_test.coding_storage')::jsonb || jsonb_build_object('volumeId',p_worker,'workerId',p_worker,
		'dataSource','/srv/coding/executor/workers/30000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000020/' || p_worker::text || '/data',
		'custodySource','/srv/coding/executor/workers/30000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000020/' || p_worker::text || '/guest-state')
$$;
-- The executor's side of one turn, as coding-executor.ts runs it: claim, machine, admission; then the runner starts the run.
create function pg_temp.next_turn(p_key text) returns jsonb language plpgsql as $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row(p_key); v_claim jsonb; v_turn jsonb; v_run uuid;
begin
	perform pg_temp.observe();
	v_claim := public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert(v_claim ->> 'workerId' = v_worker.id::text,'The executor claims '||p_key||': '||coalesce(v_claim::text,'nothing'));
	perform public.qorpera_plan_coding_machine(v_worker.id,(v_claim ->> 'leaseToken')::uuid,repeat('c',64));
	perform pg_temp.wake_assert(public.qorpera_authorize_coding_machine_run(v_worker.id,(v_claim ->> 'leaseToken')::uuid,
		current_setting('qorpera_test.coding_binding'),pg_temp.storage(v_worker.id),repeat('c',64)) ->> 'intent' = 'run',
		'The turn runs on the member''s machine');
	v_turn := public.qorpera_begin_coding_turn(v_worker.id,(v_claim ->> 'leaseToken')::uuid,
		jsonb_build_object('vmId',current_setting('qorpera_test.coding_vm'),'turnId',public.qorpera_coding_turn_id(v_worker.id,(v_claim ->> 'sequence')::int)));
	perform public.qorpera_materialize_wake_execution_runs(8);
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_turn ->> 'occurrenceId')::uuid;
	return jsonb_build_object('claim',v_claim,'run',v_run,'binding',pg_temp.wake_start(v_run));
end
$$;
-- The run ended; the executor reads the turn back and completes it from the submission.
create function pg_temp.end_turn(p_key text,p_turn jsonb) returns jsonb language plpgsql as $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row(p_key);
begin
	perform pg_temp.finish_job((p_turn ->> 'run')::uuid,'completed');
	update public.qorpera_wake_occurrences set status = 'completed', finished_at = clock_timestamp() where run_id = (p_turn ->> 'run')::uuid;
	return public.qorpera_describe_coding_turn(v_worker.id,(p_turn #>> '{claim,leaseToken}')::uuid);
end
$$;
select pg_temp.path_claims('service_role');

-- 1. Executor loss right after the harness submitted, then the owner's retry (#8).
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn3 jsonb; v_turn4 jsonb; v_submitted jsonb; v_state jsonb;
	v_authority jsonb; v_ask jsonb;
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Raise it.','30000000-0000-4000-8000-000000000301');
	perform pg_temp.path_claims('service_role');
	v_turn3 := pg_temp.next_turn('fix-send');
	perform set_config('qorpera_test.turn3',v_turn3::text,true);
	v_submitted := public.qorpera_submit_coding_turn(v_turn3 -> 'binding',jsonb_build_object('kind','ask','operationKey','backoff',
		'summary','The poll interval is 500 ms now.','question','Should the poll also back off after errors?','options',jsonb_build_array('Yes','No')));
	perform pg_temp.wake_assert(v_submitted ->> 'kind' = 'ask' and (v_submitted ->> 'sequence')::int = 3,'Turn 3 submitted its question');
	-- The executor disappears before it completes the turn; its lease lapses and the next poll settles the session.
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform pg_temp.wake_assert(public.qorpera_claim_coding_session('exec-test',60) is null,'Nothing else is claimable');
	v_worker := pg_temp.worker_row('fix-send');
	perform pg_temp.wake_assert(v_worker.state = 'failed' and (pg_temp.session_row('fix-send')).phase = 'failed'
		and v_worker.result ->> 'reason' = 'executor-lease-expired',
		'Executor loss fails the session visibly: '||v_worker.result::text);
	perform pg_temp.wake_assert(v_worker.result ->> 'summary' like '%Should the poll also back off after errors?%',
		'The lost turn''s question is not lost: the owner and the agent read it in the result: '||(v_worker.result ->> 'summary'));
	perform pg_temp.wake_error($q$select public.qorpera_submit_coding_turn((current_setting('qorpera_test.turn3')::jsonb) -> 'binding',
		jsonb_build_object('kind','finish','operationKey','late','summary','Late.','headSha','c4d8f9f1c0b6e5a2d3c4b5a69788776655443322'))$q$,'42501');
	-- The owner retries. The retry must run: a new sequence never inherits the lost turn's submission.
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Yes, back off.','30000000-0000-4000-8000-000000000302');
	perform pg_temp.path_claims('service_role');
	v_turn4 := pg_temp.next_turn('fix-send');
	perform set_config('qorpera_test.turn4',v_turn4::text,true);
	v_state := public.qorpera_describe_coding_turn(v_worker.id,(v_turn4 #>> '{claim,leaseToken}')::uuid);
	v_authority := public.qorpera_authorize_coding_turn(v_turn4 -> 'binding');
	perform pg_temp.wake_assert((v_authority #>> '{coding,sequence}')::int = 4 and v_authority #> '{coding,submission}' = 'null'::jsonb
		and v_state -> 'submission' = 'null'::jsonb,
		'The retry starts without the lost turn''s submission: '||coalesce(v_authority #>> '{coding,submission}','null'));
	v_ask := public.qorpera_submit_coding_turn(v_turn4 -> 'binding',jsonb_build_object('kind','ask','operationKey','cap',
		'summary','Errors back off now.','question','Which retry cap?','options',jsonb_build_array('A: 3 tries','B: 5 tries')));
	perform pg_temp.wake_assert(v_ask ->> 'question' = 'Which retry cap?' and (v_ask ->> 'sequence')::int = 4
		and public.qorpera_authorize_coding_turn(v_turn4 -> 'binding') #>> '{coding,submission,question}' = 'Which retry cap?',
		'The retry records its own submission');
	-- The executor finishes turn 4 the ordinary way: the question goes to the owner with its choices.
	v_state := pg_temp.end_turn('fix-send',v_turn4);
	perform pg_temp.wake_assert(v_state #>> '{submission,question}' = 'Which retry cap?','The executor reads turn 4''s own question');
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn4 #>> '{claim,leaseToken}')::uuid,'blocked',v_state #>> '{submission,summary}',
		v_state #>> '{submission,question}',null,null,null,null,null,v_state #> '{submission,options}');
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).state = 'blocked' and (pg_temp.session_row('fix-send')).phase = 'awaiting_input',
		'Turn 4 waits for the owner');
end $$;

-- 2. Each turn is kept as it happened; a settled turn and its submission never change.
do $$
declare v_worker uuid := (pg_temp.worker_row('fix-send')).id; v_turn public.qorpera_coding_session_turns;
begin
	perform pg_temp.wake_assert((select array_agg(turn.sequence order by turn.sequence) from public.qorpera_coding_session_turns turn
		where turn.worker_id = v_worker) = array[1,2,3,4],'Every turn of the session has its row');
	select * into strict v_turn from public.qorpera_coding_session_turns where worker_id = v_worker and sequence = 1;
	perform pg_temp.wake_assert(v_turn.input_from = 'dispatch' and v_turn.input_text is null and v_turn.submission ->> 'kind' = 'finish'
		and v_turn.outcome ->> 'state' = 'succeeded' and v_turn.outcome #>> '{pullRequest,number}' = '204','Turn 1: the dispatch, its commit and its PR');
	select * into strict v_turn from public.qorpera_coding_session_turns where worker_id = v_worker and sequence = 2;
	perform pg_temp.wake_assert(v_turn.input_from = 'member' and v_turn.input_text = 'Also fix the group chat composer.' and v_turn.submission is null
		and v_turn.outcome ->> 'state' = 'blocked' and v_turn.outcome ->> 'needs' = 'Keep 250 ms, or raise to 500 ms?'
		and v_turn.outcome -> 'options' = '["Keep 250 ms","Raise to 500 ms"]'::jsonb,'Turn 2: the owner''s follow-up and the question it ended with');
	select * into strict v_turn from public.qorpera_coding_session_turns where worker_id = v_worker and sequence = 3;
	perform pg_temp.wake_assert(v_turn.input_from = 'member' and v_turn.input_text = 'Raise it.' and v_turn.submission ->> 'question' = 'Should the poll also back off after errors?'
		and v_turn.outcome ->> 'state' = 'failed' and v_turn.outcome ->> 'reason' = 'executor-lease-expired' and v_turn.settled_at is not null,
		'Turn 3 keeps the submission its lost executor never acted on, settled as failed');
	perform pg_temp.wake_error(format($q$update public.qorpera_coding_session_turns set submission = null, submission_receipt_id = null, submitted_at = null
		where worker_id = %L and sequence = 3$q$,v_worker),'55000');
	perform pg_temp.wake_error(format($q$update public.qorpera_coding_session_turns set outcome = outcome || '{"state":"succeeded"}' where worker_id = %L and sequence = 3$q$,v_worker),'55000');
	perform pg_temp.wake_error(format($q$update public.qorpera_coding_session_turns set input_text = 'Something else.' where worker_id = %L and sequence = 2$q$,v_worker),'55000');
	perform pg_temp.wake_error(format($q$delete from public.qorpera_coding_session_turns where worker_id = %L and sequence = 1$q$,v_worker),'55000');
	perform pg_temp.wake_error(format($q$insert into public.qorpera_coding_session_turns(worker_id, sequence, input_from, input_text, submission,
		submission_receipt_id, submitted_at) select %L, 99, 'agent', 'x', submission, submission_receipt_id, submitted_at
		from public.qorpera_coding_session_turns where worker_id = %L and sequence = 3$q$,v_worker,v_worker),'23514');
	perform pg_temp.wake_assert(not exists (select 1 from information_schema.columns where table_schema = 'public'
		and table_name = 'qorpera_coding_sessions' and column_name in ('submission','submission_receipt_id')),
		'The session has no submission of its own any more: only turns have submissions');
end $$;

-- 3. The owner answers with one letter. The next turn reads the question it asked, its choices and the answer,
--    and the session's earlier turns, from the kernel; nothing has to be guessed from the repository (#4).
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn5 jsonb; v_context jsonb; v_earlier jsonb;
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'B','30000000-0000-4000-8000-000000000303');
	perform pg_temp.path_claims('service_role');
	v_turn5 := pg_temp.next_turn('fix-send');
	perform set_config('qorpera_test.turn5',v_turn5::text,true);
	v_context := public.qorpera_read_coding_turn_context(v_turn5 -> 'binding');
	perform pg_temp.wake_assert(v_context ->> 'schema' = 'qorpera.coding-turn-context/v2' and v_context ->> 'workerId' = v_worker.id::text
		and (v_context ->> 'sequence')::int = 5 and (v_context ->> 'omittedEarlierTurns')::int = 0
		and v_context -> 'input' = jsonb_build_object('from','member','text','B','answers',
			jsonb_build_object('question','Which retry cap?','options',jsonb_build_array('A: 3 tries','B: 5 tries'))),
		'The answer arrives with the exact question and choices it answers: '||(v_context -> 'input')::text);
	v_earlier := v_context -> 'earlierTurns';
	perform pg_temp.wake_assert(jsonb_array_length(v_earlier) = 4
		and (select array_agg((turn ->> 'sequence')::int order by ordinal) from jsonb_array_elements(v_earlier) with ordinality entry(turn, ordinal)) = array[1,2,3,4],
		'Every earlier turn is there, oldest first');
	perform pg_temp.wake_assert(v_earlier -> 0 = jsonb_build_object('sequence',1,'input',jsonb_build_object('from','dispatch','text',null),
			'submitted',jsonb_build_object('kind','finish','summary','Composer posts first; the send test covers it.','question',null,'options','[]'::jsonb,
				'headSha','b4d8f9f1c0b6e5a2d3c4b5a69788776655443322'),
			'outcome',jsonb_build_object('state','succeeded','summary','Composer posts first; the send test covers it.','reason',null,'needs',null,'options','[]'::jsonb,
				'pullRequest',jsonb_build_object('url','https://github.com/Qorpera/Qorpera_Base/pull/204','number',204,'headSha','b4d8f9f1c0b6e5a2d3c4b5a69788776655443322'))),
		'Turn 1 as the next turn reads it: '||(v_earlier -> 0)::text);
	perform pg_temp.wake_assert(v_earlier #> '{1,input}' = '{"from":"member","text":"Also fix the group chat composer."}'::jsonb
		and v_earlier #> '{1,submitted}' = 'null'::jsonb and v_earlier #>> '{1,outcome,needs}' = 'Keep 250 ms, or raise to 500 ms?'
		and v_earlier #> '{2,input}' = '{"from":"member","text":"Raise it."}'::jsonb
		and v_earlier #>> '{2,submitted,question}' = 'Should the poll also back off after errors?' and v_earlier #> '{2,submitted,options}' = '["Yes","No"]'::jsonb
		and v_earlier #>> '{2,outcome,state}' = 'failed' and v_earlier #>> '{2,outcome,reason}' = 'executor-lease-expired'
		and v_earlier #> '{3,input}' = '{"from":"member","text":"Yes, back off."}'::jsonb
		and v_earlier #>> '{3,outcome,state}' = 'blocked' and v_earlier #> '{3,outcome,options}' = '["A: 3 tries","B: 5 tries"]'::jsonb,
		'The earlier questions, answers and outcomes are all there: '||v_earlier::text);
	perform pg_temp.wake_assert(public.qorpera_read_coding_turn_context(v_turn5 -> 'binding') = v_context,'The context is stable within the turn');
	perform pg_temp.wake_error($q$select public.qorpera_read_coding_turn_context((current_setting('qorpera_test.turn4')::jsonb) -> 'binding')$q$,'42501');
	perform pg_temp.wake_error($q$select public.qorpera_read_coding_turn_context(current_setting('qorpera_test.parent_binding')::jsonb)$q$,'42501');
end $$;

-- 4. The agent's own follow-up is a turn too. A turn that fails without submitting anything leaves the question open.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn5 jsonb := current_setting('qorpera_test.turn5')::jsonb;
	v_turn public.qorpera_coding_session_turns; v_receipt jsonb;
begin
	perform pg_temp.end_turn('fix-send',v_turn5);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn5 #>> '{claim,leaseToken}')::uuid,'failed','The coding turn ended without a submission.');
	v_receipt := pg_temp.worker('{"action":"followup","operationKey":"f-cap","todoKey":"composer-latency","workerKey":"fix-send","text":"Use five tries."}');
	select * into strict v_turn from public.qorpera_coding_session_turns where worker_id = v_worker.id and sequence = 6;
	perform pg_temp.wake_assert(v_receipt #>> '{worker,sequence}' = '6' and v_turn.input_from = 'agent' and v_turn.input_text = 'Use five tries.'
		and v_turn.input_run_id = (current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId')::uuid and v_turn.submission is null
		and v_turn.outcome is null and (select outcome ->> 'state' from public.qorpera_coding_session_turns where worker_id = v_worker.id and sequence = 5) = 'failed',
		'The agent''s follow-up opens turn 6 after turn 5 settled');
end $$;
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn6 jsonb; v_context jsonb;
begin
	v_turn6 := pg_temp.next_turn('fix-send');
	v_context := public.qorpera_read_coding_turn_context(v_turn6 -> 'binding');
	perform pg_temp.wake_assert(v_context -> 'input' = '{"from":"agent","text":"Use five tries.","answers":{"question":"Which retry cap?","options":["A: 3 tries","B: 5 tries"]}}'::jsonb
		and jsonb_array_length(v_context -> 'earlierTurns') = 5,
		'Turn 5 failed without submitting: the reply after it still answers turn 4''s question: '||(v_context -> 'input')::text);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn6 #>> '{claim,leaseToken}')::uuid,'succeeded','Five tries it is.');
end $$;
-- Once a later turn has finished, the question is answered: the next reply answers nothing.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn7 jsonb; v_context jsonb;
begin
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Thanks, also log each retry.','30000000-0000-4000-8000-000000000304');
	perform pg_temp.path_claims('service_role');
	v_turn7 := pg_temp.next_turn('fix-send');
	v_context := public.qorpera_read_coding_turn_context(v_turn7 -> 'binding');
	perform pg_temp.wake_assert(v_context -> 'input' = '{"from":"member","text":"Thanks, also log each retry.","answers":null}'::jsonb
		and v_context #>> '{earlierTurns,5,outcome,state}' = 'succeeded','A finished turn closes the question: '||(v_context -> 'input')::text);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn7 #>> '{claim,leaseToken}')::uuid,'failed','Stopped for the test.');
end $$;

-- 5. A retry right after an ask the executor never delivered: the question is offered as what the reply may answer.
do $$
declare v_worker public.qorpera_runtime_workers; v_turn jsonb; v_context jsonb;
begin
	perform pg_temp.worker('{"action":"dispatch","operationKey":"c7","todoKey":"composer-latency","workerKey":"fix-send-7",
		"title":"Typing indicator","goal":"Show who is typing.","definitionOfDone":"Its test passes.","access":"read",
		"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');
	v_worker := pg_temp.worker_row('fix-send-7');
	v_turn := pg_temp.next_turn('fix-send-7');
	v_context := public.qorpera_read_coding_turn_context(v_turn -> 'binding');
	perform pg_temp.wake_assert(v_context -> 'input' = '{"from":"dispatch","text":null,"answers":null}'::jsonb
		and v_context -> 'earlierTurns' = '[]'::jsonb,'A first turn starts from its dispatch alone');
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','ask','operationKey','dots',
		'summary','Indicator drafted.','question','Dots or text?','options',jsonb_build_array('Dots','Text')));
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Dots.','30000000-0000-4000-8000-000000000307');
	perform pg_temp.path_claims('service_role');
	v_turn := pg_temp.next_turn('fix-send-7');
	v_context := public.qorpera_read_coding_turn_context(v_turn -> 'binding');
	perform pg_temp.wake_assert(v_context -> 'input' = '{"from":"member","text":"Dots.","answers":{"question":"Dots or text?","options":["Dots","Text"]}}'::jsonb
		and public.qorpera_authorize_coding_turn(v_turn -> 'binding') #> '{coding,submission}' = 'null'::jsonb,
		'The retry after a lost question runs clean and knows the question: '||(v_context -> 'input')::text);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid,'failed','Stopped for the test.');
end $$;

-- 6. A cancellation settles the turn and keeps its question; a lost executor names the commit it did not publish.
do $$
declare v_worker public.qorpera_runtime_workers; v_turn jsonb; v_context jsonb; v_settled public.qorpera_coding_session_turns;
begin
	perform pg_temp.worker('{"action":"dispatch","operationKey":"c8","todoKey":"composer-latency","workerKey":"fix-send-8",
		"title":"Read receipts","goal":"Show read receipts.","definitionOfDone":"Its test passes.","access":"read",
		"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');
	v_worker := pg_temp.worker_row('fix-send-8');
	v_turn := pg_temp.next_turn('fix-send-8');
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','ask','operationKey','ticks',
		'summary','Receipts drafted.','question','One tick or two?','options',jsonb_build_array('One','Two')));
	perform pg_temp.worker('{"action":"cancel","operationKey":"c8-cancel","todoKey":"composer-latency","workerKey":"fix-send-8"}');
	select * into strict v_settled from public.qorpera_coding_session_turns where worker_id = v_worker.id and sequence = 1;
	perform pg_temp.wake_assert(v_settled.outcome ->> 'state' = 'cancelled' and v_settled.outcome ->> 'reason' = 'parent_cancelled'
		and v_settled.submission ->> 'question' = 'One tick or two?','A cancellation settles the turn with its submission: '||v_settled.outcome::text);
	perform pg_temp.worker('{"action":"followup","operationKey":"c8-again","todoKey":"composer-latency","workerKey":"fix-send-8","text":"Two ticks."}');
	v_turn := pg_temp.next_turn('fix-send-8');
	v_context := public.qorpera_read_coding_turn_context(v_turn -> 'binding');
	perform pg_temp.wake_assert(v_context -> 'input' = '{"from":"agent","text":"Two ticks.","answers":{"question":"One tick or two?","options":["One","Two"]}}'::jsonb,
		'The follow-up after a cancelled question answers it: '||(v_context -> 'input')::text);
	-- The harness finishes; the executor is lost before publishing, then again while publishing.
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','finish','operationKey','two',
		'summary','Two ticks.','headSha','d4d8f9f1c0b6e5a2d3c4b5a69788776655443322'));
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send-8')).result ->> 'summary'
		= 'The coding executor stopped responding; the workspace is kept. Commit d4d8f9f1c0b6 was submitted but not published; a follow-up can publish it.',
		'A lost executor names the unpublished commit: '||((pg_temp.worker_row('fix-send-8')).result ->> 'summary'));
	perform pg_temp.worker('{"action":"followup","operationKey":"c8-publish","todoKey":"composer-latency","workerKey":"fix-send-8","text":"Publish it."}');
	v_turn := pg_temp.next_turn('fix-send-8');
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','finish','operationKey','two',
		'summary','Two ticks.','headSha','d4d8f9f1c0b6e5a2d3c4b5a69788776655443322'));
	perform public.qorpera_record_coding_progress(v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid,'publishing','Publishing the draft pull request');
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = v_worker.id;
	perform public.qorpera_claim_coding_session('exec-test',60);
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send-8')).result ->> 'summary' like '%Commit d4d8f9f1c0b6 was being published; the draft pull request may exist.%',
		'An executor lost while publishing does not claim the PR is missing: '||((pg_temp.worker_row('fix-send-8')).result ->> 'summary'));
end $$;

-- 7. Only the turn's own runner reads its context.
select pg_temp.as_user('30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_read_coding_turn_context((current_setting('qorpera_test.turn5')::jsonb) -> 'binding')$q$,'42501');
select pg_temp.path_claims('service_role');
select pg_temp.wake_assert(has_function_privilege('service_role','public.qorpera_read_coding_turn_context(jsonb)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_read_coding_turn_context(jsonb)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_read_coding_turn_context(jsonb)','EXECUTE')
	and not has_function_privilege('qorpera_secret_broker','public.qorpera_read_coding_turn_context(jsonb)','EXECUTE')
	and not has_function_privilege('service_role','public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)','EXECUTE')
	and not has_table_privilege('service_role','public.qorpera_coding_session_turns','SELECT,INSERT,UPDATE,DELETE')
	and not has_table_privilege('authenticated','public.qorpera_coding_session_turns','SELECT,INSERT,UPDATE,DELETE'),
	'Turns are kernel state: read through the turn''s own authority only');

rollback;
