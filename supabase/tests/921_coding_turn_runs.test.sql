-- @fixture 988_runtime_coding_busy_checkins.test.sql until "-- 1. Busy for less than an hour"
-- W6a-1 (migration 20260930250000; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §10.1; the W6 note of 9 Oct): a
-- coding session's turns as runs of their own. A turn keeps the occurrence its begin made, set once, and its report names
-- the turn's run; F3's view refresh marks the session's open turn narrow, only from false to true, and the flag is frozen
-- once the turn ended; a session is narrow while any turn is, and its busy check-in then names neither the session nor a
-- command's text, only each command's commandId and turn. 988's base on 928's helpers: Alice's run, sessions a and b
-- (cancelled, their first turn ended) on the owner's machine on exec-988.

-- Whether p_sql is refused by the turn guard.
create function pg_temp.ct_refused(p_sql text) returns boolean language plpgsql as $$
begin
	execute p_sql;
	return false;
exception when sqlstate '55000' then return sqlerrm = 'A coding turn is recorded once';
end $$;
create function pg_temp.ct_turn(p_worker uuid, p_sequence integer) returns public.qorpera_coding_session_turns language sql as $$
	select * from public.qorpera_coding_session_turns where worker_id = p_worker and sequence = p_sequence
$$;
-- A session whose turns are not narrow, with triggers off (for an undone check).
create function pg_temp.ct_wide(p_worker uuid) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_session_turns set narrow = false where worker_id = p_worker;
	set local session_replication_role = origin;
end $$;

-- 1. Session a's second turn: its begin's occurrence, set once; a refresh marks it narrow; its report names its run -----
do $$
declare v_claim jsonb; v_begin jsonb; v_pass jsonb; v_token uuid; v_run uuid; v_event public.qorpera_runtime_worker_events;
	w public.qorpera_runtime_workers; t public.qorpera_coding_session_turns;
begin
	perform pg_temp.c3_answer('98800000-0000-4000-8000-0000000000b1', 'Keep the old route.');
	-- Between the input and the begin the turn is open, with no occurrence yet.
	t := pg_temp.ct_turn('98800000-0000-4000-8000-0000000000b1', 2);
	perform pg_temp.base_assert(t.outcome is null and t.occurrence_id is null and not t.narrow, 'the open turn: ' || to_jsonb(t)::text);
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-988', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = t.worker_id::text, 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(t.worker_id)).lease_token;
	v_begin := public.qorpera_begin_coding_turn(t.worker_id, v_token, '{}');
	t := pg_temp.ct_turn(t.worker_id, 2);
	perform pg_temp.base_assert(t.occurrence_id = (v_begin ->> 'occurrenceId')::uuid
		and t.occurrence_id = (pg_temp.c3_worker(t.worker_id)).occurrence_id
		and (pg_temp.ct_turn(t.worker_id, 1)).occurrence_id is null, 'the begin''s occurrence: ' || to_jsonb(t)::text);
	perform pg_temp.base_assert(pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set occurrence_id = null
			where worker_id = %L and sequence = 2', t.worker_id))
		and pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set occurrence_id = (select o.id
			from public.qorpera_wake_occurrences o where o.id <> %L limit 1) where worker_id = %L and sequence = 2',
			t.occurrence_id, t.worker_id)), 'the occurrence is set once');
	-- The materializer makes it the turn's run.
	v_pass := pg_temp.base_materialize();
	v_run := (select o.run_id from public.qorpera_wake_occurrences o where o.id = t.occurrence_id);
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' ? v_run::text, 'the turn''s run: ' || v_pass::text);
	-- F3's view refresh finds a path outside the every-agent part: the open turn is narrow, and so is the session.
	perform pg_temp.base_assert(not public.qorpera_coding_session_narrow(t.worker_id), 'not narrow before');
	perform pg_temp.base_assert(public.qorpera_coding_turn_mark_narrow(t.worker_id) and public.qorpera_coding_turn_mark_narrow(t.worker_id)
		and (pg_temp.ct_turn(t.worker_id, 2)).narrow and not (pg_temp.ct_turn(t.worker_id, 1)).narrow
		and public.qorpera_coding_session_narrow(t.worker_id), 'the narrow turn');
	perform pg_temp.base_assert(pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set narrow = false
		where worker_id = %L and sequence = 2', t.worker_id)), 'narrow stays narrow');
	-- The executor completes the turn: its report, and the reported event's body, name the run.
	perform public.qorpera_complete_coding_turn(t.worker_id, v_token, 'succeeded', 'The login page accepts a pasted code.');
	w := pg_temp.c3_worker(t.worker_id);
	select * into strict v_event from public.qorpera_runtime_worker_events e
	where e.worker_id = w.id and e.sequence = 2 and e.kind = 'reported';
	perform pg_temp.base_assert(w.state = 'succeeded' and w.result ->> 'runId' = v_run::text and v_event.body = w.result
		and v_event.run_id is null, 'the report: ' || w.result::text);
	-- Ended: the flag is frozen, and a refresh now finds no open turn.
	t := pg_temp.ct_turn(w.id, 2);
	perform pg_temp.base_assert(t.outcome is not null and t.narrow and t.occurrence_id is not null
		and not public.qorpera_coding_turn_mark_narrow(w.id) and public.qorpera_coding_session_narrow(w.id),
		'the ended turn: ' || to_jsonb(t)::text);
	perform pg_temp.base_assert(pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set narrow = false
			where worker_id = %L and sequence = 2', w.id))
		and pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set occurrence_id = null
			where worker_id = %L and sequence = 2', w.id))
		and pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set narrow = true
			where worker_id = %L and sequence = 1', w.id)), 'an ended turn stays as it ended');
end $$;

-- 2. Session b: no open turn between turns; one opened by an input is marked before its begin, and stays narrow ---------
do $$
declare w public.qorpera_runtime_workers := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b2');
begin
	perform pg_temp.base_assert(not public.qorpera_coding_turn_mark_narrow(w.id) and not public.qorpera_coding_session_narrow(w.id)
		and not (pg_temp.ct_turn(w.id, 1)).narrow, 'between turns nothing is marked');
	perform pg_temp.c3_answer(w.id, 'Use the new route.');
	perform pg_temp.base_assert(public.qorpera_coding_turn_mark_narrow(w.id) and (pg_temp.ct_turn(w.id, 2)).narrow
		and (pg_temp.ct_turn(w.id, 2)).occurrence_id is null, 'the open turn is marked');
	perform public.qorpera_folder_cancel_agent_worker(pg_temp.c3_alice(), jsonb_build_object('folder',
		'agents/alice/todos/fix-login/session-b', 'operationKey', 'ct-cancel-b'));
	perform pg_temp.base_assert((pg_temp.ct_turn(w.id, 2)).outcome is not null and (pg_temp.ct_turn(w.id, 2)).narrow
		and public.qorpera_coding_session_narrow(w.id), 'it ended narrow');
	-- Busy for an hour since, with two commands.
	perform pg_temp.cb_busy(w.id, interval '10 seconds', '[{"commandId":"92100000-0000-4000-8000-0000000000c1","turn":2,'
		'"command":"npm run dev -- --port 4100"},{"commandId":"92100000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test -- --watch"}]');
	perform pg_temp.cb_age(w.id, interval '61 minutes');
	perform pg_temp.base_assert(pg_temp.cb_mark(w.id) = 1, 'due at an hour');
end $$;

-- 3. Its check-in names it only as narrow, and each command by its commandId and turn ----------------------------------
-- Were it not narrow, it would be named as before (undone).
select pg_temp.base_assert(pg_temp.cb_after($q$select pg_temp.ct_wide('98800000-0000-4000-8000-0000000000b2'),
		public.qorpera_ask_busy_coding_sessions('92400000-0000-4000-8000-000000000020', 8)$q$,
	$c$(pg_temp.cb_question('98800000-0000-4000-8000-0000000000b2', 1)).body ->> 'machine' = format('the coding session '
			'"Fix the logout page" (repository Qorpera/Qorpera_Base, branch qorpera/coding/%s)', '98800000-0000-4000-8000-0000000000b2')
		and (pg_temp.cb_question('98800000-0000-4000-8000-0000000000b2', 1)).body -> 'running'
			= '[{"command":"npm test -- --watch","turn":1},{"command":"npm run dev -- --port 4100","turn":2}]'::jsonb$c$, false),
	'a session that is not narrow');
do $$
declare w public.qorpera_runtime_workers := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b2'); q public.qorpera_machine_checkins;
begin
	perform pg_temp.base_assert(public.qorpera_ask_busy_coding_sessions('92400000-0000-4000-8000-000000000020', 8) = 1, 'asked once');
	q := pg_temp.cb_question(w.id, 1);
	perform pg_temp.base_assert(q.body = jsonb_build_object('machine', 'a coding session that read files only some agents may read',
		'busyHours', 1, 'running', '[{"commandId":"92100000-0000-4000-8000-0000000000c2","turn":1},'
			'{"commandId":"92100000-0000-4000-8000-0000000000c1","turn":2}]'::jsonb,
		'more', 0, 'todoKey', 'fix-login', 'workerKey', w.worker_key), 'the narrow body: ' || q.body::text);
	perform pg_temp.base_assert(public.qorpera_machine_checkin_current(q), 'it stands');
end $$;

-- 4. Grants and markers ------------------------------------------------------------------------------------------------
select pg_temp.base_assert(not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['public.qorpera_coding_turn_mark_narrow(uuid)', 'public.qorpera_coding_session_narrow(uuid)',
		'public.qorpera_coding_turn_runs(uuid,timestamp with time zone)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute')), 'only the platform runs these');
select pg_temp.base_assert(not exists (select 1 from unnest(array['public.qorpera_coding_turn_mark_narrow(uuid)',
		'public.qorpera_coding_session_narrow(uuid)', 'public.qorpera_coding_turn_runs(uuid,timestamp with time zone)',
		'public.qorpera_coding_session_turn_guard()', 'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_ask_busy_coding_sessions(uuid,integer)', 'public.qorpera_folder_erasure_step(integer,integer,integer)']) f(name)
	where position('20260930250000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each new or patched function names this migration');

rollback;
