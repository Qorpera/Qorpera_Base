-- @fixture 928_folder_coding_dispatch.test.sql until "-- 1. The refusals"
-- 20260930109000: check-ins for coding sessions under one idle rule for every machine (the 2026-10-03 amendment, item
-- 5, its coding part), on folder-v2. A coding session busy on its machine since its last turn ended has its agent asked
-- after 1, 3 and 7 hours, then every 24, once per mark, in the conversation of the run steering it, through 098000's
-- machine check-ins and their drain. Nothing is asked under an hour, nor about a session that is not busy, detached,
-- archived, retired or erased, whose agent is archived, whose report waits, that has a new turn, or that C3c's quiet
-- question is on its way to; the body names the session as manage_worker does and bounds what still runs. Delivery
-- waits for the conversation's run to end; a question that no longer stands is suppressed; the question's run archives
-- the session only as it was when asked. 928's helpers on 924's base: Alice's run, two of its coding sessions
-- (cancelled, so their first turn ended), attached to the owner's machine on exec-988.

do $$
declare v_alice jsonb := pg_temp.c3_alice();
begin
	perform public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-988', true, array['codex']);
	perform public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true);
	for i in 1 .. 2 loop
		perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'cb-dispatch-' || i,
			'QorperaOS/agents/alice/todos/fix-login/session-' || chr(96 + i), pg_temp.c3_brief(('98800000-0000-4000-8000-0000000000b' || i)::uuid,
				p_title => case i when 1 then 'Fix the login page' else 'Fix the logout page' end))
			-> 'units' -> 0 ->> 'outcome' = 'saved', 'dispatch ' || i);
		perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder',
			'QorperaOS/agents/alice/todos/fix-login/session-' || chr(96 + i), 'operationKey', 'cb-cancel-' || i));
		perform pg_temp.base_assert((select settled_at from public.qorpera_coding_session_turns
			where worker_id = ('98800000-0000-4000-8000-0000000000b' || i)::uuid and sequence = 1) is not null, 'turn 1 ended: ' || i);
	end loop;
	-- The owner's coding machine on exec-988 (928's).
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
	values ('98800000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-988', repeat('7', 64), '{}');
	set local session_replication_role = origin;
end $$;

-- A session attached to the machine, which last found it busy p_ago ago, running p_running (unchanged when null).
create function pg_temp.cb_busy(p_worker uuid, p_ago interval, p_running jsonb default null) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_sessions set attached_machine_id = '98800000-0000-4000-8000-0000000000d1',
		attachment_token = coalesce(attachment_token, extensions.gen_random_uuid()),
		attachment_until = clock_timestamp() + interval '10 minutes',
		attachment_turn = coalesce(attachment_turn, (select w.sequence from public.qorpera_runtime_workers w where w.id = p_worker)),
		attached_at = coalesce(attached_at, clock_timestamp()), observed_at = clock_timestamp(), busy_at = clock_timestamp() - p_ago,
		running_commands = coalesce(p_running, running_commands)
	where worker_id = p_worker;
	set local session_replication_role = origin;
end $$;
-- A session busy p_by longer: the end of its current turn and its questions' since move back together.
create function pg_temp.cb_age(p_worker uuid, p_by interval) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_coding_session_turns turn set settled_at = turn.settled_at - p_by
	from public.qorpera_runtime_workers w where w.id = p_worker and turn.worker_id = w.id and turn.sequence = w.sequence;
	update public.qorpera_machine_checkins set since = since - p_by where machine_kind = 'coding' and subject_id = p_worker;
	set local session_replication_role = origin;
end $$;
create function pg_temp.cb_settled(p_worker uuid, p_sequence integer) returns timestamptz language sql as $$
	select settled_at from public.qorpera_coding_session_turns where worker_id = p_worker and sequence = p_sequence
$$;
-- The mark a session is due to be asked at, if any.
create function pg_temp.cb_mark(p_worker uuid) returns integer language sql as $$
	select unasked.mark from public.qorpera_coding_busy_checkins_unasked('92400000-0000-4000-8000-000000000020') unasked
	where unasked.worker_id = p_worker
$$;
-- The company's step and whether the page lists the company, as the drain calls them.
create function pg_temp.cb_step() returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_machine_checkins_company('92400000-0000-4000-8000-000000000020', 8);
end $$;
create function pg_temp.cb_due() returns boolean language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_machine_checkins_due(null, 100) -> 'items' @> '[{"environment_id":"92400000-0000-4000-8000-000000000020"}]';
end $$;
-- A step's counts, as "asked/delivered/suppressed/undeliverable", or its state.
create function pg_temp.cb_counts(p_step jsonb) returns text language sql as $$
	select case when p_step ->> 'state' = 'done' then concat_ws('/', p_step ->> 'asked', p_step ->> 'delivered',
		p_step ->> 'suppressed', p_step ->> 'undeliverable') else p_step ->> 'state' end
$$;
create function pg_temp.cb_question(p_worker uuid, p_mark integer) returns public.qorpera_machine_checkins language sql as $$
	select * from public.qorpera_machine_checkins where machine_kind = 'coding' and subject_id = p_worker and mark_hours = p_mark
	order by created_at desc limit 1
$$;
-- Whether p_check (a boolean expression) holds once p_sql ran, with triggers off when p_raw; both are undone after.
create function pg_temp.cb_after(p_sql text, p_check text, p_raw boolean default true) returns boolean language plpgsql as $$
declare v_ok boolean;
begin
	begin
		if p_raw then set local session_replication_role = replica; end if;
		execute p_sql;
		set local session_replication_role = origin;
		execute 'select ' || p_check into v_ok;
		raise exception 'Undone' using errcode = 'QB988';
	exception when sqlstate 'QB988' then null;
	end;
	return v_ok;
end $$;
-- C3c's quiet question about a session, as its drain inserts it (admitted), then left in p_status.
create function pg_temp.cb_quiet(p_worker uuid, p_status text) returns void language plpgsql as $$
declare w public.qorpera_runtime_workers := pg_temp.c3_worker(p_worker); v_wake public.qorpera_wake_occurrences;
begin
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_folder_admit_wakes(w.profile_id);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
		parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (extensions.gen_random_uuid(), w.profile_id, w.environment_id, 'agent', 'worker-completion', w.id, w.staff_agent_id,
		w.steering_run_id, 'worker-completion', 'coding-quiet:' || w.id::text || ':1000:1', clock_timestamp(), clock_timestamp(),
		public.qorpera_worker_completion_payload(w.steering_run_id, array[w.id]))
	returning * into v_wake;
	perform set_config('qorpera.folder_wake_admission', '', true);
	perform pg_temp.base_assert(v_wake.status = 'queued', 'the quiet question: ' || to_jsonb(v_wake)::text);
	if p_status <> 'queued' then
		set local session_replication_role = replica;
		update public.qorpera_wake_occurrences set status = p_status, finished_at = clock_timestamp(), blocked_reason = 'Withdrawn'
		where id = v_wake.id;
		set local session_replication_role = origin;
	end if;
end $$;
-- A question's run: the materializer makes it, a runner leases it; answers its binding (934's).
create function pg_temp.cb_run(p_wake uuid) returns jsonb language plpgsql as $$
declare v_pass jsonb := pg_temp.base_materialize(); v_run uuid;
begin
	select run_id into v_run from public.qorpera_wake_occurrences where id = p_wake and status = 'materialized';
	perform pg_temp.base_assert(v_run is not null and v_pass -> 'run_ids' = jsonb_build_array(v_run), 'the question''s run: ' || v_pass::text);
	return pg_temp.base_start(v_run);
end $$;
-- A run's job ends (completed) or is stopped by the owner (cancelled), with the columns each state requires (934's).
create function pg_temp.cb_end(p_binding jsonb, p_status text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set status = p_status, lease_token_sha256 = null, lease_expires_at = null,
		result = case when p_status = 'completed' then '{}'::jsonb end,
		finished_at = case when p_status = 'completed' then clock_timestamp() end,
		cancelled_at = case when p_status = 'cancelled' then clock_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then '92400000-0000-4000-8000-000000000001'::uuid end
	where id = (p_binding ->> 'jobId')::uuid;
	set local session_replication_role = origin;
end $$;
-- A run archiving a session, as manage_worker calls it.
create function pg_temp.cb_archive(p_binding jsonb, p_folder text, p_key text) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_archive_coding_worker(p_binding, jsonb_build_object('folder', p_folder, 'operationKey', p_key));
end $$;

-- 1. Busy for less than an hour since its turn ended: nothing is asked --------------------------------------------------
do $$
begin
	perform pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b1', interval '10 seconds',
		'[{"commandId":"98800000-0000-4000-8000-0000000000c1","turn":1,"command":"npm run dev"}]');
	perform pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b2', interval '10 seconds',
		'[{"commandId":"98800000-0000-4000-8000-0000000000c2","turn":1,"command":"npm test -- --watch"}]');
	perform pg_temp.cb_age('98800000-0000-4000-8000-0000000000b1', interval '50 minutes');
	perform pg_temp.cb_age('98800000-0000-4000-8000-0000000000b2', interval '50 minutes');
	perform pg_temp.base_assert(public.qorpera_coding_busy_since(pg_temp.c3_session('98800000-0000-4000-8000-0000000000b1'),
		pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b1')) = pg_temp.cb_settled('98800000-0000-4000-8000-0000000000b1', 1),
		'busy since its turn ended');
	perform pg_temp.base_assert(pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b1') is null
		and pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b2') is null and not pg_temp.cb_due()
		and pg_temp.cb_step() ->> 'state' = 'idle', 'nothing asked under an hour');
end $$;

-- 2. At an hour: due, in the conversation of the run steering the session; who is not asked ----------------------------
do $$
declare w public.qorpera_runtime_workers := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b1'); v_unasked record;
begin
	perform pg_temp.cb_age(w.id, interval '20 minutes');
	perform pg_temp.cb_age('98800000-0000-4000-8000-0000000000b2', interval '30 minutes');
	select * into v_unasked from public.qorpera_coding_busy_checkins_unasked('92400000-0000-4000-8000-000000000020') u
	where u.worker_id = w.id;
	perform pg_temp.base_assert(pg_temp.cb_due() and v_unasked.mark = 1 and v_unasked.since = pg_temp.cb_settled(w.id, 1)
		and v_unasked.conversation_run_id = (pg_temp.c3_alice() ->> 'runId')::uuid and v_unasked.conversation_run_id = w.steering_run_id
		and v_unasked.staff_agent_id = '92400000-0000-4000-8000-000000000030' and v_unasked.profile_id = '92400000-0000-4000-8000-000000000010'
		and v_unasked.environment_id = '92400000-0000-4000-8000-000000000020'
		and pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b2') = 1, 'due at an hour: ' || to_jsonb(v_unasked)::text);
end $$;
-- Each of these takes the session out of the list; each is undone after.
select pg_temp.base_assert(pg_temp.cb_after('select 1', $c$pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b1') = 1$c$, false),
	'listed as it is');
select pg_temp.base_assert(not pg_temp.cb_after(v.sql, $c$pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b1') is not null$c$, v.raw),
	'not asked: ' || v.what)
from (values
	($q$update public.qorpera_coding_sessions set busy_at = clock_timestamp() - interval '2 minutes'
		where worker_id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'not busy for two minutes'),
	($q$update public.qorpera_coding_sessions set busy_at = null where worker_id = '98800000-0000-4000-8000-0000000000b1'$q$, true,
		'never found busy'),
	($q$update public.qorpera_coding_sessions set attachment_until = clock_timestamp() - interval '1 second'
		where worker_id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'its attachment ran out'),
	($q$update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'detached'),
	($q$update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
		where worker_id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'archived'),
	($q$update public.qorpera_profile_staff set employment_status = 'archived'
		where staff_agent_id = '92400000-0000-4000-8000-000000000030'$q$, true, 'its agent archived'),
	($q$update public.qorpera_runtime_workers set folder_retired_at = clock_timestamp()
		where id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'its worker retired'),
	($q$update public.qorpera_runtime_agent_todos set folder_retired_at = clock_timestamp()
		where id = (select todo_id from public.qorpera_runtime_workers where id = '98800000-0000-4000-8000-0000000000b1')$q$, true,
		'its todo retired'),
	($q$update public.qorpera_runtime_workers set folder_retired_at = clock_timestamp(), title = 'Erased',
		worker_key = 'erased.' || replace(id::text, '-', ''), folder_path = null, folder_key = null, folder_environment_id = null,
		folder_erased_at = clock_timestamp() where id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'its worker erased'),
	($q$update public.qorpera_runtime_workers set completion_state = 'waiting'
		where id = '98800000-0000-4000-8000-0000000000b1'$q$, true, 'its report waits'),
	($q$select pg_temp.c3_answer('98800000-0000-4000-8000-0000000000b1', 'One more thing.')$q$, false, 'a new turn'),
	($q$select pg_temp.cb_quiet('98800000-0000-4000-8000-0000000000b1', 'queued')$q$, false, 'C3c''s quiet question on its way')
) v(sql, raw, what);
-- A quiet question that was withdrawn no longer holds it back.
select pg_temp.base_assert(pg_temp.cb_after($q$select pg_temp.cb_quiet('98800000-0000-4000-8000-0000000000b1', 'cancelled')$q$,
	$c$pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b1') = 1$c$, false), 'a withdrawn quiet question');
-- What still runs, as much as fits: at most 8 commands and 2400 bytes of them, oldest turn first, the rest counted.
select pg_temp.base_assert(pg_temp.cb_after(format($q$select pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b1', interval '10 seconds',
		%L), public.qorpera_ask_busy_coding_sessions('92400000-0000-4000-8000-000000000020', 8)$q$,
		(select jsonb_agg(jsonb_build_object('commandId', extensions.gen_random_uuid(), 'turn', 2 - (n % 2),
			'command', 'npm run job-' || n) order by n) from generate_series(1, 10) n)),
	$c$(pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).body -> 'running' = (select jsonb_agg(jsonb_build_object(
		'command', 'npm run job-' || n, 'turn', 2 - (n % 2)) order by 2 - (n % 2), n) from generate_series(1, 10) n where n not in (8, 10))
		and ((pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).body ->> 'more')::integer = 2$c$, false),
	'eight commands, turn 1 first, two more counted');
select pg_temp.base_assert(pg_temp.cb_after(format($q$select pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b1', interval '10 seconds',
		%L), public.qorpera_ask_busy_coding_sessions('92400000-0000-4000-8000-000000000020', 8)$q$,
		(select jsonb_agg(jsonb_build_object('commandId', extensions.gen_random_uuid(), 'turn', 1, 'command', repeat(chr(230), 300)))
			from generate_series(1, 8))),
	$c$jsonb_array_length((pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).body -> 'running') = 5
		and char_length((pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).body #>> '{running,0,command}') = 200
		and ((pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).body ->> 'more')::integer = 3$c$, false),
	'2400 bytes of commands, each its first 200 characters');
-- While Alice's run still runs, both are asked and wait; the company is then neither due nor stepped.
do $$
declare v_step jsonb; w public.qorpera_runtime_workers := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b1');
	q1 public.qorpera_machine_checkins; q2 public.qorpera_machine_checkins;
begin
	perform pg_temp.cb_busy(w.id, interval '10 seconds');
	perform pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b2', interval '10 seconds');
	v_step := pg_temp.cb_step();
	perform pg_temp.base_assert(pg_temp.cb_counts(v_step) = '2/0/0/0', 'both asked, none delivered: ' || v_step::text);
	q1 := pg_temp.cb_question(w.id, 1); q2 := pg_temp.cb_question('98800000-0000-4000-8000-0000000000b2', 1);
	perform pg_temp.base_assert(q1.delivery = 'waiting' and q1.parent_run_id = (pg_temp.c3_alice() ->> 'runId')::uuid
		and q1.staff_agent_id = '92400000-0000-4000-8000-000000000030' and q1.environment_id = '92400000-0000-4000-8000-000000000020'
		and q1.since = pg_temp.cb_settled(w.id, 1) and q2.delivery = 'waiting' and q2.parent_run_id = q1.parent_run_id,
		'the questions: ' || to_jsonb(q1)::text);
	perform pg_temp.base_assert(q1.body = jsonb_build_object('machine', format('the coding session "Fix the login page" '
			'(repository Qorpera/Qorpera_Base, branch qorpera/coding/%s)', w.id), 'busyHours', 1,
		'running', '[{"command":"npm run dev","turn":1}]'::jsonb, 'more', 0, 'todoKey', 'fix-login', 'workerKey', w.worker_key),
		'the body: ' || q1.body::text);
	perform pg_temp.base_assert(public.qorpera_machine_checkin_current(q1) and public.qorpera_machine_checkin_current(q2), 'both stand');
	perform pg_temp.base_assert(pg_temp.cb_mark(w.id) is null and pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b2') is null
		and not pg_temp.cb_due() and pg_temp.cb_step() ->> 'state' = 'idle', 'asked once; a running conversation waits');
end $$;

-- 3. Alice's turn ended: the standing question goes into her conversation; one that no longer stands is suppressed -----
do $$
declare v_alice jsonb := pg_temp.c3_alice(); v_step jsonb; v_run public.qorpera_execution_runs; v_wake public.qorpera_wake_occurrences;
	w public.qorpera_runtime_workers := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b1'); q1 public.qorpera_machine_checkins;
begin
	perform pg_temp.cb_busy(w.id, interval '10 seconds');
	-- b2's commands went quiet five minutes ago.
	perform pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b2', interval '5 minutes');
	perform pg_temp.base_assert(not public.qorpera_machine_checkin_current(pg_temp.cb_question('98800000-0000-4000-8000-0000000000b2', 1)),
		'a quiet session''s question no longer stands');
	perform pg_temp.cb_end(v_alice, 'completed');
	perform pg_temp.base_assert(pg_temp.cb_due(), 'due once Alice''s turn ended');
	v_step := pg_temp.cb_step();
	perform pg_temp.base_assert(pg_temp.cb_counts(v_step) = '0/1/1/0', 'one delivered, one suppressed: ' || v_step::text);
	select * into v_run from public.qorpera_execution_runs where id = (v_alice ->> 'runId')::uuid;
	select * into v_wake from public.qorpera_wake_occurrences where parent_run_id = v_run.id and source_kind = 'machine-checkin';
	q1 := pg_temp.cb_question(w.id, 1);
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.wake_kind = 'agent' and v_wake.trigger_id = 'machine-checkin'
		and v_wake.source_id = q1.id and v_wake.session_id = v_run.session_id and v_wake.staff_agent_id = v_run.staff_agent_id
		and v_wake.requested_by_user_id = v_run.requested_by_user_id and public.qorpera_folder_wake_authorized(v_wake),
		'one authorized wake into Alice''s conversation: ' || to_jsonb(v_wake)::text);
	perform pg_temp.base_assert(v_wake.payload ->> 'schema' = 'qorpera.machine-checkin/v1' and v_wake.payload ->> 'parentRunId' = v_run.id::text
		and jsonb_array_length(v_wake.payload -> 'checkins') = 1 and (v_wake.payload ->> 'stillWaiting')::integer = 0
		and v_wake.payload #>> '{checkins,0,checkinId}' = q1.id::text and v_wake.payload #>> '{checkins,0,machineKind}' = 'coding'
		and (v_wake.payload #>> '{checkins,0,since}')::timestamptz = q1.since
		and ((v_wake.payload -> 'checkins' -> 0) - 'checkinId' - 'machineKind' - 'since' - 'askedAt') = q1.body,
		'the payload: ' || v_wake.payload::text);
	perform pg_temp.base_assert(q1.delivery = 'delivered' and q1.occurrence_id = v_wake.id
		and (pg_temp.cb_question('98800000-0000-4000-8000-0000000000b2', 1)).delivery = 'suppressed', 'delivered by that wake');
	perform pg_temp.base_assert(pg_temp.cb_step() ->> 'state' = 'idle' and not pg_temp.cb_due(), 'nothing more meanwhile');
end $$;

-- 4. The question's run may archive the session it asked about (undone) --------------------------------------------------
do $$
declare v_q jsonb := pg_temp.cb_run((pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).occurrence_id);
begin
	perform set_config('qorpera_test.cb_question_run', v_q::text, true);
	perform pg_temp.base_assert(pg_temp.cb_after(format('select pg_temp.cb_archive(%L, %L, %L)', v_q,
			'QorperaOS/agents/alice/todos/fix-login/session-a', 'cb-archive-1'),
		$c$(pg_temp.c3_session('98800000-0000-4000-8000-0000000000b1')).archived_by = 'agent'$c$, false),
		'the question''s run archives the session');
end $$;

-- 5. Three hours: asked again; the hour-one question no longer stands; the new one waits while the question's run runs --
do $$
declare v_step jsonb;
begin
	perform pg_temp.cb_busy('98800000-0000-4000-8000-0000000000b1', interval '10 seconds');
	perform pg_temp.cb_age('98800000-0000-4000-8000-0000000000b1', interval '2 hours');
	perform pg_temp.base_assert(pg_temp.cb_mark('98800000-0000-4000-8000-0000000000b1') = 3 and pg_temp.cb_due(), 'due at three hours');
	v_step := pg_temp.cb_step();
	perform pg_temp.base_assert(pg_temp.cb_counts(v_step) = '1/0/0/0', 'asked at three hours: ' || v_step::text);
	perform pg_temp.base_assert((pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 3)).delivery = 'waiting'
		and (pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 3)).since
			= (pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)).since
		and (pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 3)).body ->> 'busyHours' = '3'
		and public.qorpera_machine_checkin_current(pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 3))
		and not public.qorpera_machine_checkin_current(pg_temp.cb_question('98800000-0000-4000-8000-0000000000b1', 1)),
		'the three-hour question replaces the hour-one question');
	perform pg_temp.base_assert(pg_temp.cb_step() ->> 'state' = 'idle' and not pg_temp.cb_due(), 'one continuation at a time');
end $$;

-- 6. A new turn since the question: its run may not archive the session, even once that turn ended and the session is
--    busy again; the three-hour question no longer stands -----------------------------------------------------------------
do $$
declare v_q jsonb := current_setting('qorpera_test.cb_question_run')::jsonb; v_folder text := 'QorperaOS/agents/alice/todos/fix-login/session-a';
	v_step jsonb; w public.qorpera_runtime_workers;
begin
	perform pg_temp.c3_answer('98800000-0000-4000-8000-0000000000b1', 'Keep the dev server, and add a test.');
	w := pg_temp.c3_worker('98800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 2, 'the owner''s new turn');
	perform pg_temp.base_error(format('select pg_temp.cb_archive(%L, %L, %L)', v_q, v_folder, 'cb-archive-2'), '55000',
		'The session has a new turn since you were asked; leave it');
	perform public.qorpera_cancel_worker(w, null, 'parent_stopped');
	perform pg_temp.cb_busy(w.id, interval '10 seconds');
	w := pg_temp.c3_worker(w.id);
	perform pg_temp.base_assert(w.state = 'cancelled' and public.qorpera_coding_busy_since(pg_temp.c3_session(w.id), w)
		= pg_temp.cb_settled(w.id, 2) and pg_temp.cb_settled(w.id, 2) > (pg_temp.cb_question(w.id, 1)).since,
		'busy again since its second turn ended');
	perform pg_temp.base_error(format('select pg_temp.cb_archive(%L, %L, %L)', v_q, v_folder, 'cb-archive-3'), '55000',
		'The session has a new turn since you were asked; leave it');
	perform pg_temp.base_assert((pg_temp.c3_session(w.id)).archived_at is null, 'the session is kept');
	perform pg_temp.cb_end(v_q, 'completed');
	v_step := pg_temp.cb_step();
	perform pg_temp.base_assert(pg_temp.cb_counts(v_step) = '0/0/1/0' and (pg_temp.cb_question(w.id, 3)).delivery = 'suppressed',
		'the three-hour question no longer stands: ' || v_step::text);
	perform pg_temp.base_assert(pg_temp.cb_mark(w.id) is null and pg_temp.cb_step() ->> 'state' = 'idle' and not pg_temp.cb_due(),
		'its new count starts over');
end $$;

-- 7. Bounds, grants and markers -------------------------------------------------------------------------------------------
select pg_temp.base_error(format('select public.qorpera_ask_busy_coding_sessions(%L, %s)', v.env, v.n), '22023',
	'Coding session check-in bound is invalid')
from (values ('92400000-0000-4000-8000-000000000020'::uuid, 0), ('92400000-0000-4000-8000-000000000020', 257), (null, 8)) v(env, n);
select pg_temp.base_assert(not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) r(role)
	cross join unnest(array['public.qorpera_coding_busy_since(public.qorpera_coding_sessions,public.qorpera_runtime_workers)',
		'public.qorpera_coding_busy_checkins_unasked(uuid)', 'public.qorpera_ask_busy_coding_sessions(uuid,integer)',
		'public.qorpera_coding_question_stale(uuid,public.qorpera_runtime_workers)']) f(name)
	where has_function_privilege(r.role, f.name, 'execute'))
	and has_function_privilege('service_role', 'public.qorpera_folder_machine_checkins_due(uuid,integer)', 'execute')
	and has_function_privilege('service_role', 'public.qorpera_folder_machine_checkins_company(uuid,integer)', 'execute'),
	'only the platform runs these');
select pg_temp.base_assert(not exists (select 1 from unnest(array[
		'public.qorpera_coding_busy_since(public.qorpera_coding_sessions,public.qorpera_runtime_workers)',
		'public.qorpera_coding_busy_checkins_unasked(uuid)', 'public.qorpera_ask_busy_coding_sessions(uuid,integer)',
		'public.qorpera_coding_question_stale(uuid,public.qorpera_runtime_workers)',
		'public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)',
		'public.qorpera_folder_machine_checkins_due(uuid,integer)', 'public.qorpera_folder_machine_checkins_company(uuid,integer)']) f(name)
	where position('20260930109000' in pg_get_functiondef(f.name::regprocedure)) = 0), 'each new or patched function names this migration');

rollback;
