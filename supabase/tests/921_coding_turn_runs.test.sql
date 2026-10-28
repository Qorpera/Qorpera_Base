-- @fixture 988_runtime_coding_busy_checkins.test.sql until "-- 1. Busy for less than an hour"
-- W6a (migration 20260930250000; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §4.5, §10.1; the W6 note of 9 Oct): a
-- coding session's turns as runs of their own. A turn keeps the occurrence its begin made, set once, and its report names
-- the turn's run; F3's view refresh marks the session's open turn narrow, only from false to true, and the flag is frozen
-- once the turn ended; a read of the session's view outside the every-agent part makes the open turn's run narrow at
-- once, and its settle and the next begin mark the turn; the run log's machine check (qorpera_memory_run_machine_narrow)
-- answers for the turn's run, as W1b's host call (qorpera_memory_step_narrow) and its file rules ask it, so a log block
-- written after the view's read must be narrow; run.toml's origin makes a member's answer's turn continue the turn it
-- answers, with no parent step; a session is narrow while any turn or its view is, or any turn's run is by its place
-- (session c: dispatched at a narrow step, then followed up from another run) or its log, and its busy check-in then
-- names neither the session nor a command's text, only each command's commandId and turn. 988's base on 928's helpers:
-- Alice's run, sessions a and b (cancelled, their first turn ended) on the owner's machine on exec-988.

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
-- A turn's run.
create function pg_temp.ct_run(p_worker uuid, p_sequence integer) returns uuid language sql as $$
	select o.run_id from public.qorpera_wake_occurrences o where o.id = (pg_temp.ct_turn(p_worker, p_sequence)).occurrence_id
$$;
-- A run's log, narrow or not, from its origin, as W1b's apply indexes its run.toml (triggers off).
create function pg_temp.ct_log(p_run uuid, p_narrow boolean) returns void language plpgsql as $$
declare v_origin jsonb := public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', p_run);
begin
	set local session_replication_role = replica;
	insert into public.qorpera_memory_run_logs(environment_id, run_id, session_id, parent_run_id, parent_step, continues_run_id,
		narrow, run_path, run_key, toml_path_version, commit_id)
	values ('92400000-0000-4000-8000-000000000020', p_run, (v_origin ->> 'conversation')::uuid, (v_origin ->> 'parent')::uuid,
		(v_origin ->> 'step')::integer, (v_origin ->> 'continues')::uuid, p_narrow, 'QorperaOS/agents/alice/memory/thread/runs/' || p_run,
		'qorperaos/agents/alice/memory/thread/runs/' || p_run, extensions.gen_random_uuid(), extensions.gen_random_uuid());
	set local session_replication_role = origin;
end $$;
-- A manage_worker step of a run's log (call call-921-<j>), finished or pending, narrow or not, as W1b's apply indexes its
-- line (triggers off).
create function pg_temp.ct_step(p_run uuid, p_j integer, p_narrow boolean, p_finished boolean default true) returns void
language plpgsql as $$
begin
	set local session_replication_role = replica;
	insert into public.qorpera_memory_run_steps(environment_id, run_id, j, tool, call_id, narrow, erased, finished, line_sha256,
		fixed_sha256, block_path, block_key, block_path_version, commit_id)
	values ('92400000-0000-4000-8000-000000000020', p_run, p_j, 'manage_worker', 'call-921-' || p_j, p_narrow, false, p_finished,
		repeat('a', 64), repeat('b', 64), 'QorperaOS/agents/alice/memory/thread/runs/' || p_run || '/log/00000000.jsonl',
		'qorperaos/agents/alice/memory/thread/runs/' || p_run || '/log/00000000.jsonl', extensions.gen_random_uuid(), extensions.gen_random_uuid())
	on conflict (environment_id, run_id, j) do update set narrow = excluded.narrow;
	set local session_replication_role = origin;
end $$;

-- 1. Session a's second turn: its begin's occurrence, set once; a refresh marks it narrow; its report names its run -----
do $$
declare v_claim jsonb; v_begin jsonb; v_pass jsonb; v_bind jsonb; v_token uuid; v_run uuid;
	v_event public.qorpera_runtime_worker_events; w public.qorpera_runtime_workers; t public.qorpera_coding_session_turns;
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
	-- The materializer makes it the turn's run, which a runner leases.
	v_pass := pg_temp.base_materialize();
	v_run := (select o.run_id from public.qorpera_wake_occurrences o where o.id = t.occurrence_id);
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' ? v_run::text, 'the turn''s run: ' || v_pass::text);
	v_bind := pg_temp.base_start(v_run);
	-- F3's view refresh finds a path outside the every-agent part: the open turn is narrow, and so are the session and
	-- the turn's run (its machine, as the run's host call reads it, and so its origin for run.toml).
	perform pg_temp.base_assert(not public.qorpera_coding_session_narrow(t.worker_id)
		and not public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020', v_run)
		and not (public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', v_run) ->> 'narrow')::boolean
		and public.qorpera_memory_step_narrow('92400000-0000-4000-8000-000000000020', (v_bind ->> 'jobId')::uuid, v_run, '[]')
			= '{"log":false,"machine":false,"restricted":[]}', 'not narrow before');
	perform pg_temp.base_assert(public.qorpera_coding_turn_mark_narrow(t.worker_id) and public.qorpera_coding_turn_mark_narrow(t.worker_id),
		'the refresh marks the open turn');
	-- (A statement of its own: the stable checks read the statement's snapshot.)
	perform pg_temp.base_assert((pg_temp.ct_turn(t.worker_id, 2)).narrow and not (pg_temp.ct_turn(t.worker_id, 1)).narrow
		and public.qorpera_coding_session_narrow(t.worker_id), 'the narrow turn');
	perform pg_temp.base_assert(public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020', v_run)
		and (public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', v_run) ->> 'narrow')::boolean
		and (public.qorpera_memory_step_narrow('92400000-0000-4000-8000-000000000020', (v_bind ->> 'jobId')::uuid, v_run, '[]')
			->> 'machine')::boolean
		and not public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000021', v_run)
		and not public.qorpera_memory_run_machine_narrow('92400000-0000-4000-8000-000000000020',
			(pg_temp.c3_worker(t.worker_id)).steering_run_id),
		'the narrow turn''s run: ' || public.qorpera_memory_run_origin('92400000-0000-4000-8000-000000000020', v_run)::text);
	perform pg_temp.base_assert(pg_temp.ct_refused(format('update public.qorpera_coding_session_turns set narrow = false
		where worker_id = %L and sequence = 2', t.worker_id)), 'narrow stays narrow');
	-- The run's job ends, then the executor completes the turn: its report, and the reported event's body, name the run.
	perform pg_temp.cb_end(v_bind, 'completed');
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
		'QorperaOS/agents/alice/todos/fix-login/session-b', 'operationKey', 'ct-cancel-b'));
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
	v_root uuid; v_sales uuid; v_view uuid; v_claim jsonb; v_token uuid; v_run2 uuid; v_run3 uuid; v_run4 uuid; v_bind3 jsonb;
	v_bind4 jsonb; v_key text; v_wide text; v_narrow text;
	c_paths constant jsonb := '["/company/QorperaOS/vision/vision.md","/company/sales/q3.md"]';
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
	-- A runner leases its run, and its log is made wide. Its host call finds the machine wide (only sales is outside the
	-- every-agent part), and W1b's file rules take a wide block.
	v_bind3 := pg_temp.base_start(v_run3);
	perform pg_temp.ct_log(v_run3, false);
	v_key := 'qorperaos/agents/alice/memory/thread/runs/' || v_run3 || '/log/00000000.jsonl';
	v_wide := '{"j":0,"tool":"coding_run_command","call":"call-921","args":"{\"command\":\"npm test\"}","args_bytes":22,'
		'"args_hash":null,"result":null,"reads":[],"releases":[],"paths":[],"text":"","at":"2026-10-09T12:00:00Z"}' || E'\n';
	v_narrow := format('{"j":0,"tool":"coding_run_command","call":"call-921","args_hash":"%s","narrow":true,"finished":false,'
		'"releases":[],"at":"2026-10-09T12:00:00Z"}', repeat('c', 64)) || E'\n';
	perform pg_temp.base_assert(public.qorpera_memory_step_narrow(c_env, (v_bind3 ->> 'jobId')::uuid, v_run3, c_paths)
			= '{"log":false,"machine":false,"restricted":["/company/sales/q3.md"]}'
		and public.qorpera_memory_run_log_file_rules(c_env, jsonb_build_object(v_key, jsonb_build_object('text', v_wide)), v_key,
			'memory-steps', '{"kind":"memory-steps"}', v_wide) is null,
		'a wide machine: ' || public.qorpera_memory_step_narrow(c_env, (v_bind3 ->> 'jobId')::uuid, v_run3, c_paths)::text);
	-- The view reads sales: before any refresh marks the turn, its run is narrow, and the ended turn's run stays wide.
	insert into public.qorpera_folder_view_reads(view_id, environment_id, resource_id, resource_revision) values (v_view, c_env, v_sales, 1);
	perform pg_temp.base_assert(public.qorpera_coding_view_narrow(w.id) and public.qorpera_coding_session_narrow(w.id)
		and not (pg_temp.ct_turn(w.id, 3)).narrow and public.qorpera_memory_run_machine_narrow(c_env, v_run3)
		and (public.qorpera_memory_run_origin(c_env, v_run3) ->> 'narrow')::boolean
		and not public.qorpera_memory_run_machine_narrow(c_env, v_run2),
		'the view read sales: ' || public.qorpera_memory_run_origin(c_env, v_run3)::text);
	-- So its host call finds the machine narrow, and the next block must be narrow: W1b's file rules refuse a wide one.
	perform pg_temp.base_assert(public.qorpera_memory_step_narrow(c_env, (v_bind3 ->> 'jobId')::uuid, v_run3, c_paths)
			= '{"log":false,"machine":true,"restricted":["/company/sales/q3.md"]}'
		and public.qorpera_memory_run_log_file_rules(c_env, jsonb_build_object(v_key, jsonb_build_object('text', v_wide)), v_key,
			'memory-steps', '{"kind":"memory-steps"}', v_wide) -> 'problems' -> 0 ->> 'message'
			= 'step 0 comes after its machine went narrow and is written narrow'
		and public.qorpera_memory_run_log_file_rules(c_env, jsonb_build_object(v_key, jsonb_build_object('text', v_narrow)), v_key,
			'memory-steps', '{"kind":"memory-steps"}', v_narrow) is null,
		'a narrow machine: ' || coalesce(public.qorpera_memory_run_log_file_rules(c_env, jsonb_build_object(v_key,
			jsonb_build_object('text', v_wide)), v_key, 'memory-steps', '{"kind":"memory-steps"}', v_wide)::text, 'taken'));
	-- The run's job ends, then its turn: the end marks the turn, so its run stays narrow after it ended.
	perform pg_temp.cb_end(v_bind3, 'completed');
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
	v_bind4 := pg_temp.base_start(v_run4);
	perform pg_temp.cb_end(v_bind4, 'completed');
	perform public.qorpera_complete_coding_turn(w.id, v_token, 'succeeded', 'The new route has a test.');
end $$;

-- 5. Session c, dispatched at a narrow step of Alice's run, then followed up from another run of hers: no turn of it and
--    no view is narrow, but its first turn's run is by its place, so its check-in names it only as narrow --------------
do $$
declare c_env constant uuid := '92400000-0000-4000-8000-000000000020'; c_id constant uuid := '92100000-0000-4000-8000-0000000000b3';
	c_folder constant text := 'QorperaOS/agents/alice/todos/fix-login/session-c'; v_alice jsonb := pg_temp.c3_alice(); v_result jsonb;
	v_claim jsonb; v_token uuid; v_wakes jsonb; v_bind jsonb; v_y jsonb; v_s uuid := (pg_temp.c3_alice() ->> 'runId')::uuid;
	v_t1 uuid; v_y_run uuid; v_t2 uuid;
begin
	-- Step 7 of Alice's run dispatches it: a narrow manage_worker step, pending in her log (which is not narrow) while
	-- the call runs, which the dispatch names with its call id (W4a-2).
	perform pg_temp.ct_log(v_s, false);
	perform pg_temp.ct_step(v_s, 7, true, p_finished => false);
	v_result := pg_temp.c3_dispatch(v_alice, 'ct-dispatch-c', c_folder, pg_temp.c3_brief(c_id, p_title => 'Fix the signup page'),
		'{"parentStep":7,"parentCall":"call-921-7"}');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'session c''s dispatch: ' || v_result::text);
	-- Its first turn: claimed, begun, a run a runner leases.
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-988', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = c_id::text, 'session c''s claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(c_id)).lease_token;
	perform public.qorpera_begin_coding_turn(c_id, v_token, '{}');
	perform pg_temp.base_materialize();
	v_t1 := pg_temp.ct_run(c_id, 1);
	perform pg_temp.base_assert(v_t1 is not null, 'session c''s first run');
	v_bind := pg_temp.base_start(v_t1);
	-- Narrow by its place (run.toml's origin), though neither the turn nor a view is.
	perform pg_temp.base_assert(public.qorpera_memory_run_origin(c_env, v_t1) ->> 'parent' = v_s::text
		and public.qorpera_memory_run_origin(c_env, v_t1) ->> 'step' = '7'
		and (public.qorpera_memory_run_origin(c_env, v_t1) ->> 'narrow')::boolean
		and not (pg_temp.ct_turn(c_id, 1)).narrow and not public.qorpera_coding_view_narrow(c_id)
		and not public.qorpera_memory_run_machine_narrow(c_env, v_t1) and public.qorpera_coding_session_narrow(c_id),
		'narrow by its dispatching step: ' || public.qorpera_memory_run_origin(c_env, v_t1)::text);
	-- Alice stops it; its run's job and then her own end.
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', c_folder, 'operationKey', 'ct-cancel-c1'));
	perform pg_temp.cb_end(v_bind, 'completed');
	perform pg_temp.cb_end(v_alice, 'completed');
	-- The owner writes to Alice again: her next run, Y, which is not narrow, follows the session up.
	v_wakes := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000030', 'Also the reset page.');
	perform pg_temp.base_materialize();
	v_y_run := (select o.run_id from public.qorpera_wake_occurrences o where o.id = (v_wakes ->> 0)::uuid);
	perform pg_temp.base_assert(jsonb_array_length(v_wakes) = 1 and v_y_run is not null and v_y_run <> v_s
		and not (public.qorpera_memory_run_origin(c_env, v_y_run) ->> 'narrow')::boolean, 'Alice''s next run: ' || v_wakes::text);
	v_y := pg_temp.base_start(v_y_run);
	v_result := pg_temp.c3_followup(v_y, 'ct-followup-c', c_folder, 'Also the reset page.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the follow-up: ' || v_result::text);
	perform pg_temp.base_assert((pg_temp.c3_worker(c_id)).steering_run_id = v_y_run and (pg_temp.c3_worker(c_id)).sequence = 2,
		'Y steers it: ' || to_jsonb(pg_temp.c3_worker(c_id))::text);
	-- Its second turn continues the first, with no parent step; then Y stops it too.
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-988', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = c_id::text, 'session c''s second claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(c_id)).lease_token;
	perform public.qorpera_begin_coding_turn(c_id, v_token, '{}');
	perform pg_temp.base_materialize();
	v_t2 := pg_temp.ct_run(c_id, 2);
	perform pg_temp.base_assert(v_t2 is not null and public.qorpera_memory_run_origin(c_env, v_t2) ->> 'continues' = v_t1::text
		and (public.qorpera_memory_run_origin(c_env, v_t2) ->> 'parent') is null and not (pg_temp.ct_turn(c_id, 2)).narrow,
		'turn 2 continues turn 1: ' || coalesce(public.qorpera_memory_run_origin(c_env, v_t2)::text, 'no run'));
	perform public.qorpera_folder_cancel_agent_worker(v_y, jsonb_build_object('folder', c_folder, 'operationKey', 'ct-cancel-c2'));
	perform pg_temp.base_assert((pg_temp.ct_turn(c_id, 2)).outcome is not null and public.qorpera_coding_session_narrow(c_id),
		'it ended narrow by its first turn''s run');
	-- Busy for an hour since, with a command from each turn.
	perform pg_temp.cb_busy(c_id, interval '10 seconds', '[{"commandId":"92100000-0000-4000-8000-0000000000c3","turn":1,'
		'"command":"npm run dev"},{"commandId":"92100000-0000-4000-8000-0000000000c4","turn":2,"command":"npm test"}]');
	perform pg_temp.cb_age(c_id, interval '61 minutes');
	perform pg_temp.base_assert(pg_temp.cb_mark(c_id) = 1, 'session c is due at an hour');
end $$;
-- Were its dispatching step not narrow, it would not be narrow, and its check-in would name it (undone); its first
-- turn's log, narrow, makes it narrow too (undone).
select pg_temp.base_assert(not pg_temp.cb_after($q$select pg_temp.ct_step((pg_temp.c3_alice() ->> 'runId')::uuid, 7, false)$q$,
		$c$public.qorpera_coding_session_narrow('92100000-0000-4000-8000-0000000000b3')$c$, false)
	and pg_temp.cb_after($q$select pg_temp.ct_step((pg_temp.c3_alice() ->> 'runId')::uuid, 7, false),
			pg_temp.ct_log(pg_temp.ct_run('92100000-0000-4000-8000-0000000000b3', 1), true)$q$,
		$c$public.qorpera_coding_session_narrow('92100000-0000-4000-8000-0000000000b3')$c$, false),
	'narrow by its first turn''s place or log');
select pg_temp.base_assert(pg_temp.cb_after($q$select pg_temp.ct_step((pg_temp.c3_alice() ->> 'runId')::uuid, 7, false),
		public.qorpera_ask_busy_coding_sessions('92400000-0000-4000-8000-000000000020', 8)$q$,
	$c$(pg_temp.cb_question('92100000-0000-4000-8000-0000000000b3', 1)).body ->> 'machine' = format('the coding session '
			'"Fix the signup page" (repository Qorpera/Qorpera_Base, branch qorpera/coding/%s)', '92100000-0000-4000-8000-0000000000b3')
		and (pg_temp.cb_question('92100000-0000-4000-8000-0000000000b3', 1)).body -> 'running'
			= '[{"command":"npm run dev","turn":1},{"command":"npm test","turn":2}]'::jsonb$c$, false),
	'session c, were it not narrow');
do $$
declare w public.qorpera_runtime_workers := pg_temp.c3_worker('92100000-0000-4000-8000-0000000000b3'); q public.qorpera_machine_checkins;
begin
	perform pg_temp.base_assert(public.qorpera_ask_busy_coding_sessions('92400000-0000-4000-8000-000000000020', 8) = 1,
		'session c asked once');
	q := pg_temp.cb_question(w.id, 1);
	perform pg_temp.base_assert(q.parent_run_id = w.steering_run_id and q.parent_run_id <> (pg_temp.c3_alice() ->> 'runId')::uuid
		and q.body = jsonb_build_object('machine', 'a coding session that read files only some agents may read',
			'busyHours', 1, 'running', '[{"commandId":"92100000-0000-4000-8000-0000000000c3","turn":1},'
				'{"commandId":"92100000-0000-4000-8000-0000000000c4","turn":2}]'::jsonb,
			'more', 0, 'todoKey', 'fix-login', 'workerKey', w.worker_key)
		and public.qorpera_machine_checkin_current(q), 'session c''s narrow body, in Y''s conversation: ' || to_jsonb(q)::text);
end $$;

-- 6. Grants and markers ------------------------------------------------------------------------------------------------
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
