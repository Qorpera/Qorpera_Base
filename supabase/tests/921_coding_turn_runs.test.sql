-- @fixture 988_runtime_coding_busy_checkins.test.sql until "-- 1. Busy for less than an hour"
-- W6a (migration 20260930250000; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §10.1; the W6 note of 9 Oct): a
-- coding session's turns as runs of their own. A turn keeps the occurrence its begin made, set once, and its report names
-- the turn's run; F3's view refresh marks the session's open turn narrow, only from false to true, and the flag is frozen
-- once the turn ended; a read of the session's view outside the every-agent part makes the open turn's run narrow at
-- once, and its settle and the next begin mark the turn; the run log's machine check (qorpera_memory_run_machine_narrow)
-- answers for the turn's run, and run.toml's origin makes a member's answer's turn continue the turn it answers, with no
-- parent step; a session is narrow while any turn or its view is, and its busy check-in then names
-- neither the session nor a command's text, only each command's commandId and turn. 988's base on 928's helpers: Alice's
-- run, sessions a and b (cancelled, their first turn ended) on the owner's machine on exec-988.

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
	-- F3's view refresh finds a path outside the every-agent part: the open turn is narrow, and so are the session and
	-- the turn's run (its machine, and so its origin for run.toml).
	perform pg_temp.base_assert(not public.qorpera_coding_session_narrow(t.worker_id)
		and not public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020', v_run)
		and not (public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', v_run) ->> 'narrow')::boolean,
		'not narrow before');
	perform pg_temp.base_assert(public.qorpera_coding_turn_mark_narrow(t.worker_id) and public.qorpera_coding_turn_mark_narrow(t.worker_id),
		'the refresh marks the open turn');
	-- (A statement of its own: the stable checks read the statement's snapshot.)
	perform pg_temp.base_assert((pg_temp.ct_turn(t.worker_id, 2)).narrow and not (pg_temp.ct_turn(t.worker_id, 1)).narrow
		and public.qorpera_coding_session_narrow(t.worker_id), 'the narrow turn');
	perform pg_temp.base_assert(public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020', v_run)
		and (public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', v_run) ->> 'narrow')::boolean
		and not public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000021', v_run)
		and not public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020',
			(pg_temp.c3_worker(t.worker_id)).steering_run_id),
		'the narrow turn''s run: ' || public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', v_run)::text);
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
		and not public.qorpera_coding_turn_mark_narrow(w.id) and public.qorpera_coding_session_narrow(w.id)
		and public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020', v_run),
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

-- 4. Session a's view reads a path outside the every-agent part: its open turn's run is narrow at once, its settle -------
-- marks the turn, and the next begin starts narrow
do $$
declare c_env constant uuid := '92400000-0000-4000-8000-000000000020';
	w public.qorpera_runtime_workers := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b1');
	v_root uuid; v_sales uuid; v_view uuid; v_claim jsonb; v_token uuid; v_run2 uuid; v_run3 uuid; v_run4 uuid;
begin
	-- As if its second turn had not been narrow.
	perform pg_temp.ct_wide(w.id);
	v_run2 := (select o.run_id from public.qorpera_wake_occurrences o where o.id = (pg_temp.ct_turn(w.id, 2)).occurrence_id);
	select id into strict v_root from public.qorpera_company_path_resources where environment_id = c_env and path = '';
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values (c_env, 'sales', 'subtree', 'company_shared', 'normal', '92400000-0000-4000-8000-000000000001') returning id into v_sales;
	insert into public.qorpera_folder_views(environment_id, profile_id, kind, staff_agent_id, member_user_id, worker_access, worker_id,
		attachment_token, pass_sha256, lease_until)
	values (c_env, w.profile_id, 'coding_session', w.staff_agent_id, w.owner_user_id, w.access, w.id,
		extensions.gen_random_uuid(), extensions.digest('921', 'sha256'), clock_timestamp() + interval '1 minute')
	returning id into v_view;
	insert into public.qorpera_folder_view_reads(view_id, environment_id, resource_id, resource_revision) values (v_view, c_env, v_root, 1);
	perform pg_temp.base_assert(not public.qorpera_coding_view_narrow(w.id) and not public.qorpera_coding_session_narrow(w.id)
		and v_run2 is not null and not public.qorpera_memory_run_machine_narrow(c_env, v_run2), 'a view of the company-wide part');
	-- Turn 3 begins wide.
	perform pg_temp.c3_answer(w.id, 'Add a test.');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-988', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = w.id::text, 'the third claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(w.id)).lease_token;
	perform public.qorpera_begin_coding_turn(w.id, v_token, '{}');
	perform pg_temp.base_materialize();
	v_run3 := (select o.run_id from public.qorpera_wake_occurrences o where o.id = (pg_temp.ct_turn(w.id, 3)).occurrence_id);
	perform pg_temp.base_assert(v_run3 is not null and not (pg_temp.ct_turn(w.id, 3)).narrow
		and not public.qorpera_memory_run_machine_narrow(c_env, v_run3), 'turn 3 begins wide: ' || to_jsonb(pg_temp.ct_turn(w.id, 3))::text);
	-- A member's answer started it (W1b's worker rule, for run.toml): no parent step, and it continues the turn it answers.
	perform pg_temp.base_assert((public.qorpera_memory_run_origin(c_env, v_run3) ->> 'parent') is null
		and (public.qorpera_memory_run_origin(c_env, v_run3) ->> 'step') is null
		and public.qorpera_memory_run_origin(c_env, v_run3) ->> 'continues' = v_run2::text,
		'turn 3 continues turn 2: ' || public.qorpera_memory_run_origin(c_env, v_run3)::text);
	-- The view reads sales: before any refresh marks the turn, its run is narrow, and the ended turn's run stays wide.
	insert into public.qorpera_folder_view_reads(view_id, environment_id, resource_id, resource_revision) values (v_view, c_env, v_sales, 1);
	perform pg_temp.base_assert(public.qorpera_coding_view_narrow(w.id) and public.qorpera_coding_session_narrow(w.id)
		and not (pg_temp.ct_turn(w.id, 3)).narrow and public.qorpera_memory_run_machine_narrow(c_env, v_run3)
		and (public.qorpera_memory_run_origin(c_env, v_run3) ->> 'narrow')::boolean
		and not public.qorpera_memory_run_machine_narrow(c_env, v_run2),
		'the view read sales: ' || public.qorpera_memory_run_origin(c_env, v_run3)::text);
	-- Its end marks the turn, so its run stays narrow after it ended.
	perform public.qorpera_complete_coding_turn(w.id, v_token, 'succeeded', 'The old route has a test.');
	perform pg_temp.base_assert((pg_temp.ct_turn(w.id, 3)).outcome is not null and (pg_temp.ct_turn(w.id, 3)).narrow
		and public.qorpera_memory_run_machine_narrow(c_env, v_run3) and not public.qorpera_coding_turn_mark_narrow(w.id)
		and public.qorpera_coding_session_narrow(w.id), 'turn 3 ended narrow: ' || to_jsonb(pg_temp.ct_turn(w.id, 3))::text);
	-- With every turn wide again, the session is still narrow by its view, and its next begin marks turn 4.
	perform pg_temp.ct_wide(w.id);
	perform pg_temp.base_assert(public.qorpera_coding_session_narrow(w.id)
		and not public.qorpera_memory_run_machine_narrow(c_env, v_run3), 'between turns, narrow by its view');
	perform pg_temp.c3_answer(w.id, 'And one for the new route.');
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-988', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = w.id::text, 'the fourth claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(w.id)).lease_token;
	perform pg_temp.base_assert(not (pg_temp.ct_turn(w.id, 4)).narrow, 'turn 4 is wide before its begin');
	perform public.qorpera_begin_coding_turn(w.id, v_token, '{}');
	perform pg_temp.base_materialize();
	v_run4 := (select o.run_id from public.qorpera_wake_occurrences o where o.id = (pg_temp.ct_turn(w.id, 4)).occurrence_id);
	perform pg_temp.base_assert(v_run4 is not null and (pg_temp.ct_turn(w.id, 4)).narrow and not (pg_temp.ct_turn(w.id, 3)).narrow
		and public.qorpera_memory_run_machine_narrow(c_env, v_run4)
		and (public.qorpera_memory_run_origin(c_env, v_run4) ->> 'narrow')::boolean
		and (public.qorpera_memory_run_origin(c_env, v_run4) ->> 'parent') is null
		and public.qorpera_memory_run_origin(c_env, v_run4) ->> 'continues' = v_run3::text,
		'turn 4 begins narrow: ' || public.qorpera_memory_run_origin(c_env, v_run4)::text);
end $$;

-- 5. Grants and markers ------------------------------------------------------------------------------------------------
select pg_temp.base_assert(not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['public.qorpera_coding_view_narrow(uuid)', 'public.qorpera_coding_turn_mark_narrow(uuid)',
		'public.qorpera_coding_session_narrow(uuid)', 'public.qorpera_coding_turn_runs(uuid,timestamp with time zone)',
		'public.qorpera_memory_run_machine_narrow(uuid,uuid)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute')), 'only the platform runs these');
select pg_temp.base_assert(not exists (select 1 from unnest(array['public.qorpera_coding_view_narrow(uuid)',
		'public.qorpera_coding_turn_mark_narrow(uuid)', 'public.qorpera_coding_session_narrow(uuid)',
		'public.qorpera_coding_turn_runs(uuid,timestamp with time zone)', 'public.qorpera_coding_session_turn_guard()',
		'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)', 'public.qorpera_settle_coding_turn()',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_memory_run_machine_narrow(uuid,uuid)', 'public.qorpera_ask_busy_coding_sessions(uuid,integer)',
		'public.qorpera_folder_erasure_step(integer,integer,integer)']) f(name)
	where position('20260930250000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each new or patched function names this migration');
select pg_temp.base_assert(position('20260930231000' in pg_get_functiondef('public.qorpera_memory_run_machine_narrow(uuid,uuid)'::regprocedure)) > 0,
	'the run log''s machine check keeps W1b''s marker');

rollback;
