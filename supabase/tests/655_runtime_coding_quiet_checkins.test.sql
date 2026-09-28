-- @fixture 601_runtime_coding_turn_continuity.test.sql until "-- 1. Executor loss right after the harness submitted"
-- Coding sessions: the agent is asked before a quiet session is archived
-- (2026-09-28). After 1, 3 and 7 days without a turn the agent that started a
-- session is asked, once per mark, through its worker-completion continuation;
-- a session archived, reopened or busy meanwhile is not asked.
--
-- The fixture leaves fix-send waiting for its owner; here its report reaches
-- the agent and the agent's continuation ends first.

create function pg_temp.asks(p_worker uuid) returns setof public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where occurrence_key like 'coding-quiet:' || p_worker::text || ':%' order by created_at, id
$$;
create function pg_temp.ask() returns integer language sql as $$ select public.qorpera_ask_quiet_coding_sessions('exec-test') $$;
-- Time passes for the quiet period (and the mark asked for it).
create function pg_temp.pass(p_worker uuid, p_by interval) returns void language sql as $$
	update public.qorpera_coding_sessions set updated_at = updated_at - p_by, quiet_asked_for = quiet_asked_for - p_by where worker_id = p_worker
$$;
-- The agent's continuation is over (here: settled without a run).
create function pg_temp.answered(p_worker uuid) returns void language sql as $$
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
	where occurrence_key like 'coding-quiet:' || p_worker::text || ':%' and status = 'queued'
$$;

-- 1. A day without a turn: the agent is asked once, in the shape of a report it already reads.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_wake public.qorpera_wake_occurrences;
	v_completion jsonb;
begin
	-- The agent's run ends and the question reaches it (the report drain), and that continuation ends.
	perform pg_temp.finish_job(v_worker.steering_run_id, 'failed');
	perform public.qorpera_drain_worker_wakes(32);
	perform pg_temp.wake_assert((pg_temp.worker_row('fix-send')).completion_state = 'delivered', 'The report reached the agent');
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
	where id = (pg_temp.worker_row('fix-send')).completion_occurrence_id;
	v_worker := pg_temp.worker_row('fix-send');
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '20 hours', busy_at = null where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.ask() = 0 and not exists (select 1 from pg_temp.asks(v_worker.id)), 'Not asked before a day');
	perform pg_temp.pass(v_worker.id, interval '6 hours');
	perform pg_temp.wake_assert(pg_temp.ask() = 1, 'Asked after a day');
	select * into strict v_wake from pg_temp.asks(v_worker.id);
	v_completion := v_wake.payload #> '{completions,0}';
	perform pg_temp.wake_assert(v_wake.status = 'queued' and v_wake.wake_kind = 'agent' and v_wake.source_kind = 'worker-completion'
		and v_wake.trigger_id = 'worker-completion' and v_wake.source_id = v_worker.id and v_wake.parent_run_id = v_worker.steering_run_id
		and v_wake.staff_agent_id = v_worker.staff_agent_id and v_wake.occurrence_key like '%:1'
		and v_wake.payload ->> 'schema' = 'qorpera.worker-completion/v1' and jsonb_array_length(v_wake.payload -> 'completions') = 1
		and (select array_agg(key order by key) from jsonb_object_keys(v_completion) key)
			= array['needs','outcome','outputs','sequence','summary','summaryTruncated','title','todoKey','workerKey']
		and v_completion ->> 'workerKey' = 'fix-send' and v_completion ->> 'outcome' = 'blocked'
		and v_completion -> 'needs' = 'null'::jsonb and v_completion -> 'outputs' = '[]'::jsonb
		and v_completion ->> 'summary' like 'This is not a new report. The coding session "%" (repository %/%, branch %) has had no turn for 1 day. %'
		and v_completion ->> 'summary' like '%asked its owner a question that is still unanswered%'
		and v_completion ->> 'summary' like '%archive it now with manage_worker action archive%'
		and v_completion ->> 'summary' like '%Left alone, it is archived automatically after 30 quiet days.'
		and length(v_completion ->> 'summary') <= 1200,
		'The question is one worker-completion report: '||v_wake.payload::text);
	perform pg_temp.wake_assert((pg_temp.session_row('fix-send')).quiet_asked_days = 1
		and exists (select 1 from public.qorpera_coding_session_events where worker_id = v_worker.id and kind = 'step' and actor = 'kernel'
			and body ->> 'quietDays' = '1' and body ->> 'text' = 'Quiet for 1 day; asked the agent whether it can be archived'),
		'The thread tells that the agent was asked');
	-- Once per mark.
	perform pg_temp.wake_assert(pg_temp.ask() = 0 and (select count(*) from pg_temp.asks(v_worker.id)) = 1, 'Asked once per mark');
end $$;

-- 2. The next marks, one revival of the parent at a time; only the latest mark reached.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send');
begin
	perform pg_temp.pass(v_worker.id, interval '3 days');
	perform pg_temp.wake_assert(pg_temp.ask() = 0, 'A question still on its way to the agent holds the next one back');
	perform pg_temp.answered(v_worker.id);
	perform pg_temp.wake_assert(pg_temp.ask() = 1 and (pg_temp.session_row('fix-send')).quiet_asked_days = 3
		and (select array_agg(right(occurrence_key, 2) order by right(occurrence_key, 2)) from pg_temp.asks(v_worker.id)) = array[':1',':3'],
		'Asked again at three days');
	perform pg_temp.answered(v_worker.id);
	-- An executor away over the seventh day asks once, for seven.
	perform pg_temp.pass(v_worker.id, interval '10 days');
	perform pg_temp.wake_assert(pg_temp.ask() = 1, 'Asked at seven days');
	perform pg_temp.wake_assert(pg_temp.ask() = 0
		and (select array_agg(right(occurrence_key, 2) order by right(occurrence_key, 2)) from pg_temp.asks(v_worker.id)) = array[':1',':3',':7'],
		'Asked once, for seven, and not again: '||(select string_agg(right(occurrence_key, 2)||'/'||status, ',' order by right(occurrence_key, 2)) from pg_temp.asks(v_worker.id)));
	perform pg_temp.answered(v_worker.id);
end $$;

-- 3. A new quiet period asks again; a busy command, a pause, a run of the parent or an archive hold it back.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_job uuid;
begin
	-- A turn happened: the session is quiet since, and nothing is asked before a day.
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '2 hours' where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.ask() = 0, 'A new turn starts a new quiet period');
	update public.qorpera_coding_sessions set updated_at = clock_timestamp() - interval '30 hours' where worker_id = v_worker.id;
	-- A command that works keeps it from being quiet.
	update public.qorpera_coding_sessions set busy_at = clock_timestamp() - interval '1 hour' where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.ask() = 0, 'A busy session is not quiet');
	update public.qorpera_coding_sessions set busy_at = null where worker_id = v_worker.id;
	-- A paused company is asked once resumed.
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
	values (v_worker.profile_id, v_worker.owner_user_id);
	perform pg_temp.wake_assert(pg_temp.ask() = 0 and (pg_temp.session_row('fix-send')).quiet_asked_days = 7, 'Not asked while paused');
	delete from public.qorpera_company_execution_pauses where profile_id = v_worker.profile_id;
	-- Not while the parent runs.
	v_job := (select job_id from public.qorpera_execution_runs where id = v_worker.steering_run_id);
	update public.qorpera_runner_jobs set status = 'leased', lease_token_sha256 = repeat('d',64), lease_expires_at = clock_timestamp() + interval '1 minute',
		finished_at = null, last_error = null where id = v_job;
	perform pg_temp.wake_assert(pg_temp.ask() = 0, 'Not asked while the parent runs');
	perform pg_temp.finish_job(v_worker.steering_run_id, 'failed');
	-- Through the executor's quiet-session scan, which still counts only what it archived.
	perform pg_temp.wake_assert(public.qorpera_archive_quiet_coding_sessions('exec-test') = 0
		and (select count(*) from pg_temp.asks(v_worker.id)) = 4 and (pg_temp.session_row('fix-send')).quiet_asked_days = 1,
		'The executor''s scan asks for the new quiet period');
	perform pg_temp.answered(v_worker.id);
	-- An archived session is not asked.
	perform pg_temp.pass(v_worker.id, interval '3 days');
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'agent' where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.ask() = 0 and (select count(*) from pg_temp.asks(v_worker.id)) = 4, 'An archived session is not asked');
end $$;

-- 4. A new turn withdraws a question no run has taken yet; stopping a question stops only that run.
do $$
declare v_worker public.qorpera_runtime_workers := pg_temp.worker_row('fix-send'); v_ask public.qorpera_wake_occurrences;
begin
	update public.qorpera_coding_sessions set archived_at = null, archived_by = null, updated_at = clock_timestamp() - interval '30 hours'
	where worker_id = v_worker.id;
	perform pg_temp.wake_assert(pg_temp.ask() = 1, 'Asked again for a new quiet period');
	select * into strict v_ask from pg_temp.asks(v_worker.id) where status = 'queued';
	-- The owner answers the session's question before the agent's run took the check-in.
	perform pg_temp.as_user('30000000-0000-4000-8000-000000000001');
	perform public.qorpera_answer_coding_session(v_worker.id, 'Keep 250 ms.', '30000000-0000-4000-8000-000000000655');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.wake_assert((select status from public.qorpera_wake_occurrences where id = v_ask.id) = 'cancelled'
		and (pg_temp.worker_row('fix-send')).state = 'active',
		'A new turn withdraws the question');
	-- A person who stops a question run stops only that run: the parent's reports and workers are held back only by a
	-- stopped report run (the function the drain and the ask consult).
	perform pg_temp.wake_assert(pg_get_functiondef('public.qorpera_worker_revival_stopped(uuid)'::regprocedure)
		like '%revival.source_kind = ''worker-completion''%and revival.occurrence_key not like ''coding-quiet:%''%',
		'A stopped question is no stopped revival');
end $$;

-- 5. Only the executor asks.
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_ask_quiet_coding_sessions(text)','EXECUTE')
	and has_function_privilege('service_role','public.qorpera_ask_quiet_coding_sessions(text)','EXECUTE')
	and not has_function_privilege('authenticated','public.qorpera_coding_quiet_mark(timestamptz)','EXECUTE'),
	'Grants: the executor asks');
