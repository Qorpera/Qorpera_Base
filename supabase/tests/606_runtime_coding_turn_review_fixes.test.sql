-- @fixture 601_runtime_coding_turn_continuity.test.sql until "-- 7. Only the turn's own runner reads its context."
-- Coding turn continuity, review fixes (20260925125000): a turn's outcome names
-- only the pull request it published; a coding worker cannot commit a sequence
-- without its turn; the newest earlier turn is always in the history window.

-- 1. Only the turn that published a pull request names it; a later push to the same PR is that turn's.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_turn jsonb; v_prs jsonb;
begin
	select jsonb_object_agg(turn.sequence::text, turn.outcome -> 'pullRequest') into v_prs
	from public.qorpera_coding_session_turns turn where turn.worker_id = v_worker.id;
	perform pg_temp.wake_assert(v_prs ->> '1' like '%/pull/204%'
		and (select bool_and(value = 'null'::jsonb) from jsonb_each(v_prs - '1')),
		'Turn 1 published PR 204; the turns after it published nothing: '||v_prs::text);
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Push the retry log to the same PR.','30000000-0000-4000-8000-000000000601');
	perform pg_temp.path_claims('service_role');
	v_turn := pg_temp.next_turn('fix-send');
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid,'succeeded','Retry log added.',null,
		'{"url":"https://github.com/Qorpera/Qorpera_Base/pull/204","number":204,"headSha":"f4d8f9f1c0b6e5a2d3c4b5a69788776655443322"}',
		null,null,null,null,null);
	perform pg_temp.wake_assert((select turn.outcome #>> '{pullRequest,headSha}' from public.qorpera_coding_session_turns turn
		where turn.worker_id = v_worker.id and turn.sequence = (pg_temp.worker_row('fix-send')).sequence) = 'f4d8f9f1c0b6e5a2d3c4b5a69788776655443322',
		'A new head pushed to the same PR is that turn''s publication');
end $$;

-- 2. Every sequence a coding worker commits has its turn: all the paths above pass the
--    deferred check; a sequence moved without its turn is refused.
do $$
declare v_worker uuid := (pg_temp.worker_row('fix-send')).id;
begin
	set constraints public.qorpera_runtime_workers_coding_turn_recorded, public.qorpera_runtime_workers_coding_turn_sequence immediate;
	begin
		update public.qorpera_runtime_workers set sequence = sequence + 1 where id = v_worker;
		raise exception 'A sequence without its turn was accepted';
	exception when object_not_in_prerequisite_state then null;
	end;
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).sequence = (select max(sequence) from public.qorpera_coding_session_turns
		where worker_id = v_worker),'The refused move left the worker at its last recorded turn');
	begin
		insert into public.qorpera_runtime_workers(profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access, revival,
			dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
		select profile_id, environment_id, staff_agent_id, todo_id, 'no-turn', species, title, access, revival, dispatch, requested_by_user_id,
			steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version from public.qorpera_runtime_workers where id = v_worker;
		raise exception 'A coding worker without its first turn was accepted';
	exception when object_not_in_prerequisite_state then null;
	end;
	set constraints public.qorpera_runtime_workers_coding_turn_recorded, public.qorpera_runtime_workers_coding_turn_sequence deferred;
end $$;

-- 3. The newest earlier turn is kept even when it alone is over the history budget.
do $$
declare v_worker public.qorpera_runtime_workers; v_turn jsonb; v_context jsonb; v_wide text := repeat(chr(1), 4000);
	v_question text := 'Keep the raw log?' || repeat(chr(1), 900);
begin
	perform pg_temp.worker('{"action":"dispatch","operationKey":"c10","todoKey":"composer-latency","workerKey":"fix-send-10",
		"title":"Wide output","goal":"Keep the log.","definitionOfDone":"Its test passes.","access":"read",
		"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');
	v_worker := pg_temp.worker_row('fix-send-10');
	v_turn := pg_temp.next_turn('fix-send-10');
	perform public.qorpera_submit_coding_turn(v_turn -> 'binding',jsonb_build_object('kind','ask','operationKey','wide',
		'summary',v_wide,'question',v_question,'options',jsonb_build_array('Yes','No')));
	perform pg_temp.end_turn('fix-send-10',v_turn);
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid,'blocked',v_wide,v_question,
		null,null,null,null,null,'["Yes","No"]');
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id,'Yes','30000000-0000-4000-8000-000000000602');
	perform pg_temp.path_claims('service_role');
	v_turn := pg_temp.next_turn('fix-send-10');
	v_context := public.qorpera_read_coding_turn_context(v_turn -> 'binding');
	perform pg_temp.wake_assert(octet_length((v_context #> '{earlierTurns,0}')::text) > 49152
		and jsonb_array_length(v_context -> 'earlierTurns') = 1 and (v_context ->> 'omittedEarlierTurns')::int = 0
		and v_context #>> '{earlierTurns,0,submitted,question}' = v_question and v_context #>> '{input,answers,question}' = v_question,
		'An oversized previous turn is still in the context: '||octet_length((v_context -> 'earlierTurns')::text));
	perform public.qorpera_complete_coding_turn(v_worker.id,(v_turn #>> '{claim,leaseToken}')::uuid,'failed','Stopped for the test.');
end $$;

-- 4. Kernel functions only.
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_assert_coding_turn_recorded()','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_assert_coding_turn_recorded()','EXECUTE')
	and not has_function_privilege('service_role','public.qorpera_coding_turn_outcome(text,jsonb,jsonb)','EXECUTE')
	and not has_function_privilege('qorpera_secret_broker','public.qorpera_coding_turn_outcome(text,jsonb,jsonb)','EXECUTE')
	and to_regprocedure('public.qorpera_coding_turn_outcome(text,jsonb)') is null,
	'The review fixes add no API surface');

rollback;
