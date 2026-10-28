-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A routine waiting for its first slot on folder-v2 (ported from snapshot-v1 in the legacy sweep): a restart position
-- after a save or a resume, or a fresh cursor waiting for a later start or a window, has nothing due, so the
-- orchestrator raises its next due time to the first slot through qorpera_advance_routine_next_due: a compare-and-set on
-- the version, the active status and the exact millisecond position, which never moves the position and creates no
-- occurrence. The routine then leaves the scheduler's listing until the slot, shows that slot as its next run, and the
-- enqueue at the slot compares the same position as before. Routines are the owner's saves of Bob's routine files
-- (QorperaOS/agents/bob/routines/<name>.md); "ran" is a slot the scheduler offered that the folder materializer made a run,
-- which then ended; the next run is what an agent's routine read shows (qorpera_agent_routine_view) and what a member's list
-- shows.

create function pg_temp.fs_id(p_name text) returns uuid language sql immutable as $$
	select md5('first-slot:' || p_name)::uuid
$$;
create function pg_temp.fs_weekly(p_days jsonb, p_time text, p_starts text default null) returns jsonb language sql as $$
	select jsonb_build_object('when', 'weekly', 'days', p_days, 'time', p_time, 'starts', p_starts)
$$;
create function pg_temp.fs_every(p_minutes integer, p_starts text default null) returns jsonb language sql as $$
	select jsonb_build_object('when', 'every', 'minutes', p_minutes, 'starts', p_starts)
$$;
-- A routine's parse as the TS parser returns it (as 708 makes it); p_extra overrides keys.
create function pg_temp.fs_parse(p_name text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', pg_temp.fs_id(p_name), 'title', 'Watch', 'status', 'active', 'trigger', p_trigger,
		'timezone', case when p_trigger ->> 'when' = 'every' then null else 'Europe/Copenhagen' end, 'ends', null, 'runs', null,
		'quiet', null, 'effort', 'medium', 'reply', 'optional', 'conclusion', null, 'instructions', 'Watch the orders.') || p_extra
$$;
-- The owner saves Bob's routine file.
create function pg_temp.fs_save(p_name text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.base_commit(pg_temp.base_owner(), 'first-slot:' || extensions.gen_random_uuid(), jsonb_build_array(
		pg_temp.base_write('QorperaOS/agents/bob/routines/' || p_name || '.md', 'routine',
			E'---\n' || pg_temp.fs_parse(p_name, p_trigger, p_extra)::text || E'\n---\n', pg_temp.fs_parse(p_name, p_trigger, p_extra),
			pg_temp.base_version('QorperaOS/agents/bob/routines/' || p_name || '.md'))))
$$;
create function pg_temp.fs_row(p_name text) returns public.qorpera_cloud_routines language sql as $$
	select * from public.qorpera_cloud_routines where id = pg_temp.fs_id(p_name)
$$;
create function pg_temp.fs_cursor(p_name text) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select c.* from public.qorpera_cloud_routine_schedule_cursors c
	join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version
	where r.id = pg_temp.fs_id(p_name) and c.trigger_id = 'file'
$$;
-- The routine ran: the scheduler offered a slot against the position it read, the folder materializer made it a run, and
-- the run ended.
create function pg_temp.fs_ran(p_name text, p_at timestamptz, p_next timestamptz) returns jsonb language plpgsql as $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.fs_cursor(p_name); v_result jsonb;
begin
	v_result := public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, extensions.gen_random_uuid(),
		'first-slot:' || extensions.gen_random_uuid(), 'file', p_at, v_cursor.last_scheduled_for, p_next, '{}');
	perform pg_temp.base_materialize();
	perform pg_temp.base_assert((select status from public.qorpera_wake_occurrences where id = (v_result ->> 'occurrence_id')::uuid)
		= 'materialized', 'fixture: the slot became a run: ' || v_result::text);
	-- A conversation runs one run at a time (20260930538000): the run ends, so Bob's next slot in his thread can run.
	update public.qorpera_runner_jobs set status = 'failed', finished_at = clock_timestamp(), last_error = 'Fixture: the routine''s run ended'
	where run_id = (select run_id from public.qorpera_wake_occurrences where id = (v_result ->> 'occurrence_id')::uuid);
	return v_result;
end
$$;
-- What the scheduler sees: the routine's schedule head, or null when it is not listed.
create function pg_temp.fs_head(p_name text) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null, 500) -> 'items') item
	where item ->> 'routine_id' = pg_temp.fs_id(p_name)::text
$$;
-- The orchestrator's expected position: its Date of the listed value, as an ISO string.
create function pg_temp.fs_read(p_head jsonb) returns timestamptz language sql as $$
	select to_char((p_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz
$$;
-- The orchestrator's call, as the edge function passes it on.
create function pg_temp.fs_advance(p_cursor public.qorpera_cloud_routine_schedule_cursors, p_expected timestamptz, p_next timestamptz)
returns jsonb language sql as $$
	select public.qorpera_advance_routine_next_due(p_cursor.routine_id, p_cursor.routine_version, p_cursor.trigger_id, p_expected, p_next)
$$;
create function pg_temp.fs_occurrences(p_name text) returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences where routine_id = pg_temp.fs_id(p_name)
$$;
-- The next run an agent's routine read shows (qorpera_folder_agent_routines builds each entry from this view).
create function pg_temp.fs_next_run(p_name text) returns timestamptz language sql as $$
	select (public.qorpera_agent_routine_view(pg_temp.fs_row(p_name)) ->> 'nextRunAt')::timestamptz
$$;
-- The next run the owner's routine list shows.
create function pg_temp.fs_member_next_run(p_name text) returns timestamptz language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_next timestamptz;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	select (routine ->> 'next_run_at')::timestamptz into v_next
	from jsonb_array_elements(public.qorpera_list_cloud_routines('92400000-0000-4000-8000-000000000020')) routine
	where (routine ->> 'client_routine_id')::uuid = pg_temp.fs_id(p_name);
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	return v_next;
end
$$;
-- An instant as the file writes it (the parser's one form: no trailing zeros).
create function pg_temp.fs_instant(p_at timestamptz) returns text language sql immutable as $$
	select public.qorpera_company_state_instant_text(p_at)
$$;
create function pg_temp.fs_monday() returns jsonb language sql as $$
	select pg_temp.fs_weekly('["mon"]', '08:00')
$$;

-- 1. An every-2-hours watch that ran is loosened to weekly: the save restarts the schedule at the save, one millisecond
--    before it is due.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 hour');
begin
	perform pg_temp.fs_save('loosened', pg_temp.fs_every(120));
	perform pg_temp.base_assert(pg_temp.fs_ran('loosened', v_ran, v_ran + interval '2 hours') ->> 'status' = 'queued',
		'fixture: the watch ran an hour ago');
	perform pg_temp.fs_save('loosened', pg_temp.fs_monday());
	perform pg_temp.base_assert((pg_temp.fs_cursor('loosened')).next_due_at = (pg_temp.fs_cursor('loosened')).last_scheduled_for
		+ interval '1 millisecond', 'fixture: the save restarted the schedule');
end
$$;
-- The scheduler's next poll lists it with nothing due; it raises the next due time to the first Monday it computed,
-- against the position it read. The position stays, no occurrence is created, and the routine leaves the listing at once.
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.fs_cursor('loosened'); v_head jsonb := pg_temp.fs_head('loosened');
	v_expected timestamptz; v_first timestamptz; v_before bigint := pg_temp.fs_occurrences('loosened'); v_result jsonb;
begin
	perform pg_temp.base_assert(v_head is not null and pg_temp.fs_next_run('loosened') is null,
		'a restart position is listed at once and shows no next run');
	v_expected := pg_temp.fs_read(v_head);
	v_first := date_trunc('minute', v_expected) + interval '5 days';
	v_result := pg_temp.fs_advance(v_cursor, v_expected, v_first);
	perform pg_temp.base_assert(v_result ->> 'status' = 'advanced' and (v_result ->> 'next_due_at')::timestamptz = v_first,
		'the first slot is set against the millisecond position the orchestrator read: ' || v_result::text);
	v_cursor := pg_temp.fs_cursor('loosened');
	perform pg_temp.base_assert(v_cursor.last_scheduled_for = v_expected and v_cursor.next_due_at = v_first
		and pg_temp.fs_occurrences('loosened') = v_before, 'the raise keeps the position and creates no occurrence');
	perform pg_temp.base_assert(pg_temp.fs_head('loosened') is null, 'the routine is not listed before its first slot');
	perform pg_temp.base_assert(pg_temp.fs_next_run('loosened') = v_first, 'its first slot is the next run it shows');
	-- Another orchestrator computed the same slot: nothing changes. A time before the one set never lowers it.
	v_result := pg_temp.fs_advance(v_cursor, v_expected, v_first);
	perform pg_temp.base_assert(v_result ->> 'status' = 'unchanged' and (pg_temp.fs_cursor('loosened')).next_due_at = v_first,
		'the same slot twice changes nothing');
	v_result := pg_temp.fs_advance(v_cursor, v_expected, v_first - interval '1 day');
	perform pg_temp.base_assert(v_result ->> 'status' = 'unchanged' and (v_result ->> 'next_due_at')::timestamptz = v_first
		and (pg_temp.fs_cursor('loosened')).next_due_at = v_first, 'a raise never moves the next due time back');
	-- At the slot the enqueue compares the same position as before the raise.
	perform pg_temp.base_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version,
		extensions.gen_random_uuid(), 'first-slot-monday', 'file', v_first, v_expected, v_first + interval '7 days', '{}')
		->> 'status' = 'queued' and (pg_temp.fs_cursor('loosened')).last_scheduled_for = v_first,
		'the first slot is admitted against the same position');
end
$$;

-- 2. Compare-and-set: anything that moved since the orchestrator read the cursor answers 'stale' and changes nothing, so
--    the next poll reads it again.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 hour');
	v_cursor public.qorpera_cloud_routine_schedule_cursors; v_old public.qorpera_cloud_routine_schedule_cursors;
	v_first timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 hour') + interval '3 hours'; v_result jsonb;
begin
	perform pg_temp.fs_save('raced', pg_temp.fs_every(60));
	perform pg_temp.fs_ran('raced', v_ran, v_ran + interval '1 hour');
	v_cursor := pg_temp.fs_cursor('raced');
	-- A position off by a microsecond (or a millisecond) is another position.
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_ran + interval '1 microsecond', v_first) ->> 'status' = 'stale'
		and pg_temp.fs_advance(v_cursor, v_ran - interval '1 millisecond', v_first) ->> 'status' = 'stale'
		and (pg_temp.fs_cursor('raced')).next_due_at = v_ran + interval '1 hour', 'a different position is stale');
	-- A fresh cursor's call (no position) does not match a cursor that has one.
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, null, v_first) ->> 'status' = 'stale', 'a missing position is stale');
	-- An occurrence admitted in between moved the position.
	perform pg_temp.fs_ran('raced', v_ran + interval '1 hour', v_ran + interval '2 hours');
	v_result := pg_temp.fs_advance(v_cursor, v_ran, v_first);
	perform pg_temp.base_assert(v_result ->> 'status' = 'stale' and (v_result ->> 'next_due_at')::timestamptz = v_ran + interval '2 hours'
		and (pg_temp.fs_cursor('raced')).next_due_at = v_ran + interval '2 hours', 'an admitted slot makes the read stale');
	-- A pause in the file.
	v_cursor := pg_temp.fs_cursor('raced');
	perform pg_temp.fs_save('raced', pg_temp.fs_every(60), '{"status":"paused"}');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_ran + interval '1 hour', v_first) ->> 'status' = 'stale'
		and (pg_temp.fs_cursor('raced')).next_due_at = v_ran + interval '2 hours', 'a paused routine is stale');
	perform pg_temp.fs_save('raced', pg_temp.fs_every(60));
	-- A new version: the old version's cursor is no longer the routine's.
	v_old := pg_temp.fs_cursor('raced');
	perform pg_temp.fs_save('raced', pg_temp.fs_every(60), '{"instructions":"Watch the returns too."}');
	perform pg_temp.base_assert((pg_temp.fs_row('raced')).current_version = 2, 'fixture: a new version');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_old, v_old.last_scheduled_for, v_first) ->> 'status' = 'stale'
		and (select next_due_at from public.qorpera_cloud_routine_schedule_cursors
			where routine_id = v_old.routine_id and routine_version = 1 and trigger_id = 'file') = v_old.next_due_at,
		'an older version is stale');
	-- Another trigger id, or a routine that does not exist.
	v_cursor := pg_temp.fs_cursor('raced');
	perform pg_temp.base_assert(public.qorpera_advance_routine_next_due(v_cursor.routine_id, v_cursor.routine_version, 'pulse',
		v_cursor.last_scheduled_for, v_first) ->> 'status' = 'stale'
		and public.qorpera_advance_routine_next_due(extensions.gen_random_uuid(), 1, 'file', v_cursor.last_scheduled_for, v_first)
			= '{"status":"stale","next_due_at":null}'::jsonb, 'an unknown trigger or routine is stale');
end
$$;

-- 3. The call is the control plane's, and its times must make sense.
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.fs_cursor('raced');
begin
	perform pg_temp.base_error(format('select public.qorpera_advance_routine_next_due(%L, %s, %L, %L, %L)', v_cursor.routine_id,
		v_cursor.routine_version, 'file', v_cursor.last_scheduled_for, v_cursor.last_scheduled_for), '22023', 'routine next due time is invalid');
	perform pg_temp.base_error(format('select public.qorpera_advance_routine_next_due(%L, %s, %L, %L, null)', v_cursor.routine_id,
		v_cursor.routine_version, 'file', v_cursor.last_scheduled_for), '22023');
	perform pg_temp.base_error(format('select public.qorpera_advance_routine_next_due(%L, %s, %L, null, %L)', v_cursor.routine_id,
		v_cursor.routine_version, 'file', 'infinity'), '22023');
	perform pg_temp.base_error(format('select public.qorpera_advance_routine_next_due(%L, %s, %L, %L, %L)', v_cursor.routine_id,
		v_cursor.routine_version, E'file\n', v_cursor.last_scheduled_for, v_cursor.next_due_at + interval '1 day'), '22023');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_advance_routine_next_due(%L, %s, %L, %L, %L)', v_cursor.routine_id,
		v_cursor.routine_version, 'file', v_cursor.last_scheduled_for, v_cursor.next_due_at + interval '1 day'), '42501');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not has_function_privilege('authenticated',
		'public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)', 'execute')
		and not has_function_privilege('anon', 'public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)', 'execute'),
		'only the service role may call it');
end
$$;

-- 4. A raised restart position is a slot still ahead: a pause and a resume before it keep it (#320's resume rule), and a
--    same-timing save carries it.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 hour');
	v_cursor public.qorpera_cloud_routine_schedule_cursors; v_first timestamptz;
begin
	perform pg_temp.fs_save('kept', pg_temp.fs_every(120));
	perform pg_temp.fs_ran('kept', v_ran, v_ran + interval '2 hours');
	perform pg_temp.fs_save('kept', pg_temp.fs_monday());
	v_cursor := pg_temp.fs_cursor('kept');
	v_first := date_trunc('minute', v_cursor.last_scheduled_for) + interval '4 days';
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_cursor.last_scheduled_for, v_first) ->> 'status' = 'advanced',
		'fixture: the scheduler raised the restart position');
	perform pg_temp.fs_save('kept', pg_temp.fs_monday(), '{"status":"paused"}');
	perform pg_temp.fs_save('kept', pg_temp.fs_monday());
	perform pg_temp.base_assert((pg_temp.fs_cursor('kept')).last_scheduled_for = v_cursor.last_scheduled_for
		and (pg_temp.fs_cursor('kept')).next_due_at = v_first, 'a resume before the raised slot keeps it');
	perform pg_temp.fs_save('kept', pg_temp.fs_monday(), '{"reply":"silent","instructions":"Watch the orders quietly."}');
	perform pg_temp.base_assert((pg_temp.fs_cursor('kept')).routine_version = 3
		and (pg_temp.fs_cursor('kept')).last_scheduled_for = v_cursor.last_scheduled_for
		and (pg_temp.fs_cursor('kept')).next_due_at = v_first, 'a same-timing save carries the raised slot');
end
$$;

-- 5. A fresh cursor waiting for a later start: the scheduler raises it without a position. It stays fresh (it never
--    ran), shows its first slot, and leaves the listing.
do $$
declare v_start text := pg_temp.fs_instant(date_trunc('hour', statement_timestamp()) + interval '3 days');
begin
	perform set_config('qorpera_test.fs_later_start', v_start, true);
	perform pg_temp.fs_save('later', pg_temp.fs_weekly('["mon","tue","wed","thu","fri","sat","sun"]', '08:00', v_start), '{"timezone":"UTC"}');
	perform pg_temp.base_assert((pg_temp.fs_cursor('later')).last_scheduled_for is null
		and (pg_temp.fs_cursor('later')).next_due_at = '-infinity'::timestamptz
		and pg_temp.fs_head('later') #>> '{schedule_cursors,0,last_scheduled_for}' is null
		and pg_temp.fs_next_run('later') is null, 'fixture: a fresh cursor is listed and shows no next run');
end
$$;
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.fs_cursor('later');
	v_first timestamptz := date_trunc('day', statement_timestamp()) + interval '4 days 8 hours'; v_result jsonb;
begin
	v_result := pg_temp.fs_advance(v_cursor, null, v_first);
	perform pg_temp.base_assert(v_result ->> 'status' = 'advanced' and pg_temp.fs_occurrences('later') = 0,
		'a fresh cursor is raised without a position and nothing runs');
	v_cursor := pg_temp.fs_cursor('later');
	perform pg_temp.base_assert(v_cursor.last_scheduled_for is null and v_cursor.next_due_at = v_first
		and pg_temp.fs_head('later') is null and pg_temp.fs_next_run('later') = v_first,
		'it stays fresh, leaves the listing and shows its first slot');
	-- A read with a position is not this cursor.
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_first - interval '1 day', v_first + interval '1 day') ->> 'status' = 'stale',
		'a position does not match a fresh cursor');
	-- New instructions are a new version: the cursor that never ran stays fresh (#320), so the raise does not turn into a
	-- position and the scheduler raises the new one again.
	perform pg_temp.fs_save('later', pg_temp.fs_weekly('["mon","tue","wed","thu","fri","sat","sun"]', '08:00',
		current_setting('qorpera_test.fs_later_start')), '{"timezone":"UTC","instructions":"Watch the orders and the returns."}');
	v_cursor := pg_temp.fs_cursor('later');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz, 'a new version of a never-run routine starts fresh again');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, null, v_first) ->> 'status' = 'advanced'
		and public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, extensions.gen_random_uuid(),
			'first-slot-later', 'file', v_first, null, v_first + interval '1 day', '{}') ->> 'status' = 'queued'
		and (pg_temp.fs_cursor('later')).last_scheduled_for = v_first,
		'at its first slot the fresh cursor is admitted as before, without a position');
end
$$;

-- 6. A fresh cursor that may still owe its kickoff is never raised: no start, or a start already reached when the version
--    was saved. The call refuses it, so a kickoff is not postponed even if an orchestrator asked.
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.fs_save('owes-kickoff', pg_temp.fs_every(60));
	v_cursor := pg_temp.fs_cursor('owes-kickoff');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, null, date_trunc('hour', statement_timestamp()) + interval '1 hour')
		->> 'status' = 'stale' and (pg_temp.fs_cursor('owes-kickoff')).next_due_at = '-infinity'::timestamptz,
		'a fresh cursor without a later start keeps its kickoff');
	perform pg_temp.fs_save('start-reached', pg_temp.fs_every(60, pg_temp.fs_instant(date_trunc('hour', statement_timestamp() - interval '1 day'))));
	v_cursor := pg_temp.fs_cursor('start-reached');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, null, date_trunc('hour', statement_timestamp()) + interval '1 hour')
		->> 'status' = 'stale' and (pg_temp.fs_cursor('start-reached')).next_due_at = '-infinity'::timestamptz,
		'a fresh cursor whose start was reached at the save keeps its kickoff');
end
$$;

-- 7. A raised slot that passed is due again: the routine is listed, and a resume after it restarts the schedule at the
--    resume (#320), so nothing is caught up.
do $$
declare v_long_ago timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.fs_save('passed', pg_temp.fs_monday());
	-- A restart position three days ago, raised to a slot one day later (both passed).
	perform pg_temp.fs_ran('passed', v_long_ago, v_long_ago + interval '1 millisecond');
	v_cursor := pg_temp.fs_cursor('passed');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_long_ago, v_long_ago + interval '1 day') ->> 'status' = 'advanced',
		'fixture: the scheduler raised the restart position to a slot that has passed');
end
$$;
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.base_assert(pg_temp.fs_head('passed') is not null, 'a raised slot that passed is listed again');
	perform pg_temp.fs_save('passed', pg_temp.fs_monday(), '{"status":"paused"}');
	perform pg_temp.fs_save('passed', pg_temp.fs_monday());
	v_cursor := pg_temp.fs_cursor('passed');
	perform pg_temp.base_assert(v_cursor.routine_version = 1 and v_cursor.last_scheduled_for = date_trunc('milliseconds', statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'a resume after the raised slot passed restarts the schedule at the resume');
end
$$;

-- 8. An ended routine is not raised.
do $$
declare v_long_ago timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '15 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.fs_save('ended', pg_temp.fs_monday(), '{"runs":1}');
	perform pg_temp.fs_ran('ended', v_long_ago, v_long_ago + interval '7 days');
	perform pg_temp.base_assert((pg_temp.fs_row('ended')).status = 'expired', 'fixture: the last permitted run ended the routine');
	v_cursor := pg_temp.fs_cursor('ended');
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_long_ago, v_long_ago + interval '14 days') ->> 'status' = 'stale'
		and (pg_temp.fs_cursor('ended')).next_due_at = v_long_ago + interval '7 days', 'an ended routine is stale');
end
$$;

-- 9. A member sees the raised slot in their routine list: changed timing restarted the schedule (no next run shown), and
--    the scheduler's first slot is the next run. A window bounds the run times, so a fresh window cursor owes no kickoff,
--    is raised, and shows its first slot.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors; v_first timestamptz;
begin
	perform pg_temp.fs_save('brief', pg_temp.fs_weekly('["mon"]', '08:30'));
	v_cursor := pg_temp.fs_cursor('brief');
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, extensions.gen_random_uuid(),
		'first-slot-member', 'file', v_ran, null, v_ran + interval '7 days', '{}');
	perform pg_temp.fs_save('brief', pg_temp.fs_weekly('["tue"]', '08:30'));
	v_cursor := pg_temp.fs_cursor('brief');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond'
		and pg_temp.fs_member_next_run('brief') is null, 'fixture: the changed timing restarted the schedule');
	v_first := date_trunc('minute', v_cursor.last_scheduled_for) + interval '6 days';
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, v_cursor.last_scheduled_for, v_first) ->> 'status' = 'advanced'
		and pg_temp.fs_member_next_run('brief') = v_first, 'the member sees the first slot the scheduler set');

	perform pg_temp.fs_save('window', '{"when":"window","minutes":30,"from":"09:00","to":"10:00","days":["mon","tue","wed","thu","fri"],
		"months":null}', '{"timezone":"UTC"}');
	v_cursor := pg_temp.fs_cursor('window');
	v_first := date_trunc('day', statement_timestamp()) + interval '1 day 9 hours';
	perform pg_temp.base_assert(pg_temp.fs_advance(v_cursor, null, v_first) ->> 'status' = 'advanced'
		and (pg_temp.fs_cursor('window')).last_scheduled_for is null and pg_temp.fs_member_next_run('window') = v_first,
		'a fresh window cursor is raised to its first slot and shows it');
end
$$;

rollback;
