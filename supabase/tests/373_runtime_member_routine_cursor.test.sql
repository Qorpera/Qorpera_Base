-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Routine schedule positions on folder-v2 (ported from snapshot-v1 in the legacy sweep: 373, with 374's agent-save cases
-- folded in). A routine file's save makes a new version only when what a run pins changes, and every saver's version
-- takes its schedule position by the 2026-09-25 rules (qorpera_routine_version_schedule_position, #317 and #320): the
-- same timing keeps the exact position, and a run still waiting for its start is offered again to the new version; a
-- never-run cursor stays fresh and keeps its kickoff; changed timing, or a save of a paused or ended routine whose next
-- slot passed, restarts the schedule at the save; a pause and a resume keep the version, and switching the routine back
-- on after its next slot passed restarts the cursor in place. Nothing runs at once and nothing is caught up. The
-- position is millisecond-precise: the orchestrator reads it into a JavaScript Date and sends it back as the expected
-- position, which the enqueue compares exactly. A run's save (a reviewed change set) follows the same rule. Saves are the
-- owner's commits of Bob's routine files (agents/bob/routines/<name>.md), on the owner's paying login; "ran" is a slot
-- the scheduler offered that the folder materializer made a run.
--
-- Not ported, because a routine file cannot express them: an interval on a wall-clock trigger (the file's weekly timing
-- always stores 1440 minutes) and several schedule triggers in one routine, or a member's trigger beside an agent's (a
-- routine file has one trigger, `file`).

-- The routine `p_name`'s id.
create function pg_temp.rc_id(p_name text) returns uuid language sql immutable as $$
	select md5('routine-cursor:' || p_name)::uuid
$$;
create function pg_temp.rc_weekly(p_days jsonb, p_time text, p_starts text default null) returns jsonb language sql as $$
	select jsonb_build_object('when', 'weekly', 'days', p_days, 'time', p_time, 'starts', p_starts)
$$;
create function pg_temp.rc_every(p_minutes integer, p_starts text default null) returns jsonb language sql as $$
	select jsonb_build_object('when', 'every', 'minutes', p_minutes, 'starts', p_starts)
$$;
-- A routine's parse as the TS parser returns it (as 708 makes it); p_extra overrides keys.
create function pg_temp.rc_parse(p_name text, p_title text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', pg_temp.rc_id(p_name), 'title', p_title, 'status', 'active', 'trigger', p_trigger,
		'timezone', case when p_trigger ->> 'when' = 'every' then null else 'Europe/Copenhagen' end, 'ends', null, 'runs', null,
		'quiet', null, 'effort', 'medium', 'reply', 'optional', 'conclusion', null, 'instructions', 'Write the brief.') || p_extra
$$;
create function pg_temp.rc_unit(p_name text, p_title text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.base_write('agents/bob/routines/' || p_name || '.md', 'routine',
		E'---\n' || pg_temp.rc_parse(p_name, p_title, p_trigger, p_extra)::text || E'\n---\n',
		pg_temp.rc_parse(p_name, p_title, p_trigger, p_extra), pg_temp.base_version('agents/bob/routines/' || p_name || '.md'))
$$;
-- The owner saves Bob's routine file.
create function pg_temp.rc_save(p_name text, p_title text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.base_commit(pg_temp.base_owner(), 'routine-cursor:' || extensions.gen_random_uuid(),
		jsonb_build_array(pg_temp.rc_unit(p_name, p_title, p_trigger, p_extra)))
$$;
create function pg_temp.rc_row(p_name text) returns public.qorpera_cloud_routines language sql as $$
	select * from public.qorpera_cloud_routines where id = pg_temp.rc_id(p_name)
$$;
-- The routine's cursor on its current version.
create function pg_temp.rc_cursor(p_name text) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select c.* from public.qorpera_cloud_routine_schedule_cursors c
	join public.qorpera_cloud_routines r on r.id = c.routine_id and r.current_version = c.routine_version
	where r.id = pg_temp.rc_id(p_name) and c.trigger_id = 'file'
$$;
create function pg_temp.rc_effective_at(p_name text) returns timestamptz language sql as $$
	select v.created_at from public.qorpera_cloud_routine_versions v
	join public.qorpera_cloud_routines r on r.id = v.routine_id and r.current_version = v.version where r.id = pg_temp.rc_id(p_name)
$$;
-- The scheduler offers one slot against the position it read, the way the orchestrator does; it waits until it becomes a run.
create function pg_temp.rc_enqueued(p_name text, p_at timestamptz, p_next timestamptz) returns jsonb language plpgsql as $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.rc_cursor(p_name);
begin
	return public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, extensions.gen_random_uuid(),
		'routine-cursor:' || extensions.gen_random_uuid(), 'file', p_at, v_cursor.last_scheduled_for, p_next, '{}');
end
$$;
-- The routine ran: its slot was offered and the folder materializer made it a run.
create function pg_temp.rc_ran(p_name text, p_at timestamptz, p_next timestamptz) returns jsonb language plpgsql as $$
declare v_result jsonb := pg_temp.rc_enqueued(p_name, p_at, p_next);
begin
	perform pg_temp.base_materialize();
	perform pg_temp.base_assert((select status from public.qorpera_wake_occurrences where id = (v_result ->> 'occurrence_id')::uuid)
		= 'materialized', 'fixture: the slot became a run: ' || v_result::text);
	return v_result;
end
$$;
-- What the scheduler sees: the routine's schedule head, or null when nothing is due.
create function pg_temp.rc_head(p_name text) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null, 500) -> 'items') item
	where item ->> 'routine_id' = pg_temp.rc_id(p_name)::text
$$;
-- The orchestrator's expected position: its Date of the listed value, as an ISO string.
create function pg_temp.rc_read(p_head jsonb) returns timestamptz language sql as $$
	select to_char((p_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz
$$;
-- The routine as an agent's run reads it (qorpera_folder_agent_routines builds each entry from this view).
create function pg_temp.rc_view(p_name text) returns jsonb language sql as $$
	select public.qorpera_agent_routine_view(pg_temp.rc_row(p_name))
$$;
-- An instant to the millisecond, as the file writes it (the parser's one form: no trailing zeros).
create function pg_temp.rc_ms(p_at timestamptz) returns text language sql immutable as $$
	select public.qorpera_company_state_instant_text(date_trunc('milliseconds', p_at))
$$;

-- 0. A run of Bob's, started before anything else is queued: section 15 saves a routine file as this run.
select pg_temp.rc_save('desk', 'Desk', pg_temp.rc_every(60)) \g /dev/null
do $$
declare v_wake jsonb := pg_temp.rc_enqueued('desk', date_trunc('milliseconds', statement_timestamp() - interval '1 minute'),
	date_trunc('milliseconds', statement_timestamp() + interval '59 minutes'));
	v_pass jsonb := pg_temp.base_materialize();
begin
	perform pg_temp.base_assert(jsonb_array_length(v_pass -> 'run_ids') = 1, 'fixture: Bob''s desk run: ' || v_pass::text);
	perform set_config('qorpera_test.rc_bob', pg_temp.base_start((select run_id from public.qorpera_wake_occurrences
		where id = (v_wake ->> 'occurrence_id')::uuid))::text, true);
end
$$;

-- 1. A rename after the routine ran keeps its exact position: nothing is due until the next Monday, so the scheduler
--    does not even list it (a fresh cursor would be kicked off at once), and the kept position is the next run. New
--    instructions, or only a new reply, keep the timing and so the position.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_brief jsonb := pg_temp.rc_weekly('["mon"]', '08:30'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('monday', 'Monday brief', v_brief);
	perform pg_temp.base_assert(pg_temp.rc_head('monday') is not null
		and pg_temp.rc_head('monday') #>> '{schedule_cursors,0,last_scheduled_for}' is null,
		'fixture: a new routine starts with a fresh cursor, owed its kickoff');
	perform pg_temp.base_assert(pg_temp.rc_ran('monday', v_ran, v_ran + interval '7 days') ->> 'status' = 'queued',
		'fixture: the brief ran on Monday');
	perform pg_temp.rc_save('monday', 'Weekly brief', v_brief);
	v_cursor := pg_temp.rc_cursor('monday');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days', 'a rename keeps the exact schedule position: ' || to_jsonb(v_cursor)::text);
	perform pg_temp.base_assert(pg_temp.rc_head('monday') is null, 'after a rename nothing is due before the next slot');
	perform pg_temp.base_assert((pg_temp.rc_view('monday') ->> 'nextRunAt')::timestamptz = v_ran + interval '7 days',
		'a kept position is the next run');
	perform pg_temp.rc_save('monday', 'Weekly brief', v_brief, '{"instructions":"Write a shorter brief."}');
	v_cursor := pg_temp.rc_cursor('monday');
	perform pg_temp.base_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days', 'new instructions keep the exact position');
	perform pg_temp.rc_save('monday', 'Weekly brief', v_brief, '{"instructions":"Write a shorter brief.","reply":"silent"}');
	v_cursor := pg_temp.rc_cursor('monday');
	perform pg_temp.base_assert(v_cursor.routine_version = 4 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days', 'a reply change keeps the exact position');
end
$$;

-- 2. A routine that never ran keeps the kickoff it owes: its cursor stays fresh, also when its timing changes, and the
--    scheduler kicks it off at the new version's effective time.
do $$
declare v_brief jsonb := pg_temp.rc_weekly('["mon"]', '08:30'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('new', 'New brief', v_brief);
	perform pg_temp.rc_save('new', 'New weekly brief', v_brief);
	v_cursor := pg_temp.rc_cursor('new');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz, 'a never-run routine keeps a fresh cursor');
	perform pg_temp.base_assert(pg_temp.rc_head('new') #>> '{schedule_cursors,0,last_scheduled_for}' is null
		and (pg_temp.rc_head('new') ->> 'effective_at')::timestamptz = pg_temp.rc_effective_at('new'),
		'the scheduler still sees the kickoff it owes, at the new version');
	perform pg_temp.rc_save('new', 'New weekly brief', pg_temp.rc_weekly('["mon","fri"]', '08:30'));
	v_cursor := pg_temp.rc_cursor('new');
	perform pg_temp.base_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz, 'changed timing on a never-run routine keeps the kickoff it owes');
	perform pg_temp.rc_save('new', 'New weekly brief', pg_temp.rc_every(60));
	v_cursor := pg_temp.rc_cursor('new');
	perform pg_temp.base_assert(v_cursor.routine_version = 4 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz, 'a never-run weekly routine made hourly keeps its kickoff');
	-- Paused and resumed, a never-run routine keeps its fresh cursor too.
	perform pg_temp.rc_save('fresh-resume', 'Brief', v_brief);
	perform pg_temp.rc_save('fresh-resume', 'Brief', v_brief, '{"status":"paused"}');
	perform pg_temp.rc_save('fresh-resume', 'Brief', v_brief);
	v_cursor := pg_temp.rc_cursor('fresh-resume');
	perform pg_temp.base_assert((pg_temp.rc_row('fresh-resume')).status = 'active' and v_cursor.routine_version = 1
		and v_cursor.last_scheduled_for is null and v_cursor.next_due_at = '-infinity'::timestamptz,
		'a never-run routine paused and resumed keeps its fresh cursor');
end
$$;

-- 3. Changed timing restarts the schedule at the save: a weekly Monday brief that ran on Monday becomes daily on a later
--    day. The cursor stands at the save, so the scheduler neither kicks it off (it is not fresh) nor replays the daily
--    slots since the last run; the first run is the first daily slot after the save.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('daily', 'Monday brief', pg_temp.rc_weekly('["mon"]', '08:30'));
	perform pg_temp.rc_ran('daily', v_ran, v_ran + interval '7 days');
	perform pg_temp.rc_save('daily', 'Daily brief', pg_temp.rc_weekly('["mon","tue","wed","thu","fri","sat","sun"]', '08:30'));
	v_cursor := pg_temp.rc_cursor('daily');
	perform pg_temp.base_assert(v_cursor.routine_version = 2
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', pg_temp.rc_effective_at('daily'))
		and v_cursor.last_scheduled_for > v_ran and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'changed timing restarts the schedule at the save, to the millisecond: ' || to_jsonb(v_cursor)::text);
end
$$;
-- The scheduler lists it from its next poll (a later statement than the save), at the restart position, which is not a
-- run time; the first slot after the save is admitted against the position the orchestrator read.
do $$
declare v_head jsonb := pg_temp.rc_head('daily'); v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.rc_cursor('daily');
	v_expected timestamptz;
begin
	perform pg_temp.base_assert(v_head #>> '{schedule_cursors,0,last_scheduled_for}' is not null,
		'the scheduler sees a position, not a fresh cursor, so nothing runs at once');
	perform pg_temp.base_assert(pg_temp.rc_view('daily') ->> 'nextRunAt' is null, 'a restart position is not shown as the next run');
	v_expected := pg_temp.rc_read(v_head);
	perform pg_temp.base_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version,
		extensions.gen_random_uuid(), 'routine-cursor-first-daily', 'file', v_expected + interval '1 day', v_expected,
		v_expected + interval '2 days', '{}') ->> 'status' = 'queued'
		and (pg_temp.rc_cursor('daily')).last_scheduled_for = v_expected + interval '1 day',
		'the first slot after the save is admitted against the position the orchestrator read');
end
$$;

-- 4. An active routine keeps even an overdue position on a save with the same timing (that slot is owed), and a save that
--    changes nothing makes no version and leaves the position alone.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 day');
	v_overdue timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '2 hours');
	v_brief jsonb := pg_temp.rc_weekly('["mon","fri"]', '08:00'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('overdue', 'Brief', v_brief);
	perform pg_temp.rc_ran('overdue', v_ran, v_overdue);
	perform pg_temp.rc_save('overdue', 'Brief', v_brief, '{"instructions":"Write the brief, then file it."}');
	v_cursor := pg_temp.rc_cursor('overdue');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_overdue,
		'an active routine keeps even an overdue position');
	perform pg_temp.rc_save('overdue', 'Brief', v_brief, '{"instructions":"Write the brief, then file it."}');
	v_cursor := pg_temp.rc_cursor('overdue');
	perform pg_temp.base_assert((pg_temp.rc_row('overdue')).current_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_overdue, 'an unchanged save of an active routine keeps the version and its overdue position');
end
$$;

-- 5. A changed cadence never moves the position behind the one the routine reached, even when the scheduler's clock ran
--    ahead of the database's: an every-2-hours routine slowed to daily.
do $$
declare v_ahead timestamptz := date_trunc('milliseconds', statement_timestamp() + interval '10 seconds');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('slower', 'Pulse', pg_temp.rc_every(120));
	perform pg_temp.rc_enqueued('slower', v_ahead, v_ahead + interval '2 hours');
	perform pg_temp.rc_save('slower', 'Pulse', pg_temp.rc_every(1440));
	v_cursor := pg_temp.rc_cursor('slower');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ahead
		and v_cursor.next_due_at = v_ahead + interval '1 millisecond', 'a changed cadence restarts, never behind the position it reached');
end
$$;

-- 6. A pause and a resume in the file keep the version. Resumed before its next slot, the routine keeps its exact
--    position; resumed after its next slot passed, the cursor restarts at the resume, so the Mondays it missed while paused
--    are skipped, not run in a burst. A save of a paused routine with new instructions keeps the position while its next
--    slot is ahead, and restarts the schedule at the save once that slot has passed.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 day');
	v_long_ago timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '15 days');
	v_brief jsonb := pg_temp.rc_weekly('["mon"]', '08:30'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('soon', 'Monday brief', v_brief);
	perform pg_temp.rc_ran('soon', v_ran, v_ran + interval '7 days');
	perform pg_temp.rc_save('soon', 'Monday brief', v_brief, '{"status":"paused"}');
	perform pg_temp.base_assert((pg_temp.rc_row('soon')).status = 'paused' and (pg_temp.rc_row('soon')).pause_reason = 'member'
		and (pg_temp.rc_row('soon')).current_version = 1, 'fixture: the owner pauses the brief, at the same version');
	v_cursor := pg_temp.rc_cursor('soon');
	perform pg_temp.base_assert(v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_ran + interval '7 days',
		'a pause keeps the exact schedule position');
	perform pg_temp.rc_save('soon', 'Monday brief', v_brief);
	v_cursor := pg_temp.rc_cursor('soon');
	perform pg_temp.base_assert((pg_temp.rc_row('soon')).status = 'active' and v_cursor.routine_version = 1
		and v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_ran + interval '7 days' and pg_temp.rc_head('soon') is null,
		'resumed before its next slot, the routine keeps its version and exact position, and runs nothing at once');

	perform pg_temp.rc_save('late', 'Monday brief', v_brief);
	perform pg_temp.rc_ran('late', v_long_ago, v_long_ago + interval '7 days');
	perform pg_temp.rc_save('late', 'Monday brief', v_brief, '{"status":"paused"}');
	perform pg_temp.base_assert((pg_temp.rc_cursor('late')).last_scheduled_for = v_long_ago, 'a pause keeps even an overdue position');
	perform pg_temp.rc_save('late', 'Monday brief', v_brief);
	v_cursor := pg_temp.rc_cursor('late');
	perform pg_temp.base_assert((pg_temp.rc_row('late')).status = 'active' and v_cursor.routine_version = 1
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'resumed after missed slots, the cursor restarts at the resume: ' || to_jsonb(v_cursor)::text);

	perform pg_temp.rc_save('paused-soon', 'Monday brief', v_brief);
	perform pg_temp.rc_ran('paused-soon', v_ran, v_ran + interval '7 days');
	perform pg_temp.rc_save('paused-soon', 'Monday brief', v_brief, '{"status":"paused"}');
	perform pg_temp.rc_save('paused-soon', 'Monday brief', v_brief, '{"status":"paused","instructions":"Write the brief for the new team."}');
	v_cursor := pg_temp.rc_cursor('paused-soon');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days', 'a save of a paused routine before its next slot keeps the position');

	perform pg_temp.rc_save('paused-late', 'Monday brief', v_brief);
	perform pg_temp.rc_ran('paused-late', v_long_ago, v_long_ago + interval '7 days');
	perform pg_temp.rc_save('paused-late', 'Monday brief', v_brief, '{"status":"paused"}');
	perform pg_temp.rc_save('paused-late', 'Monday brief', v_brief, '{"status":"paused","instructions":"Write the brief for the new team."}');
	v_cursor := pg_temp.rc_cursor('paused-late');
	perform pg_temp.base_assert(v_cursor.routine_version = 2
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', pg_temp.rc_effective_at('paused-late'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'a save of a paused routine after its next slot passed restarts the schedule at the save');
end
$$;
-- The scheduler sees the resume position from its next poll: it neither kicks off nor catches up the missed Mondays, it is
-- not shown as the next run, and the first Monday after the resume is admitted against the position it read.
do $$
declare v_head jsonb := pg_temp.rc_head('late'); v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.rc_cursor('late');
	v_expected timestamptz;
begin
	perform pg_temp.base_assert(v_head #>> '{schedule_cursors,0,last_scheduled_for}' is not null
		and pg_temp.rc_view('late') ->> 'nextRunAt' is null, 'the scheduler sees the resume position; it is not the next run');
	v_expected := pg_temp.rc_read(v_head);
	perform pg_temp.base_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version,
		extensions.gen_random_uuid(), 'routine-cursor-first-after-resume', 'file', v_expected + interval '3 days', v_expected,
		v_expected + interval '10 days', '{}') ->> 'status' = 'queued',
		'the first Monday after the resume is admitted against the position the orchestrator read');
end
$$;

-- 7. Three authorization failures suspend the routine. When the owner resumes it with an unchanged save (780 §1), the
--    slots that passed meanwhile are skipped: the cursor restarts at the resume.
do $$
declare v_index integer; v_result jsonb; v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('suspended', 'Pulse', pg_temp.rc_every(5), '{"reply":"silent"}');
	for v_index in 1..3 loop
		v_result := pg_temp.rc_enqueued('suspended', date_trunc('milliseconds', statement_timestamp() - make_interval(mins => 40 - 10 * v_index)),
			date_trunc('milliseconds', statement_timestamp() - make_interval(mins => 35 - 10 * v_index)));
		update public.qorpera_wake_occurrences set status = 'cancelled', blocked_reason = 'Wake execution authority is unavailable',
			finished_at = statement_timestamp() where id = (v_result ->> 'occurrence_id')::uuid;
	end loop;
	perform pg_temp.base_assert((pg_temp.rc_row('suspended')).status = 'paused'
		and (pg_temp.rc_row('suspended')).pause_reason = 'authorization_failed', 'fixture: three authorization failures suspend the routine');
	perform pg_temp.rc_save('suspended', 'Pulse', pg_temp.rc_every(5), '{"reply":"silent"}');
	v_cursor := pg_temp.rc_cursor('suspended');
	perform pg_temp.base_assert((pg_temp.rc_row('suspended')).status = 'active' and v_cursor.routine_version = 1
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'a resume after the authorization suspension restarts the schedule at the resume: ' || to_jsonb(v_cursor)::text);
end
$$;

-- 8. A finite routine that ended after its last permitted run and is extended by a save with unchanged timing switches
--    back on at the same version: the Mondays that passed while it was ended are skipped, not run in a burst.
do $$
declare v_long_ago timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '15 days');
	v_brief jsonb := pg_temp.rc_weekly('["mon"]', '08:00'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('finite', 'Brief', v_brief, '{"runs":1}');
	perform pg_temp.rc_ran('finite', v_long_ago, v_long_ago + interval '7 days');
	perform pg_temp.base_assert((pg_temp.rc_row('finite')).status = 'expired', 'fixture: the last permitted run ended the routine');
	perform pg_temp.rc_save('finite', 'Brief', v_brief, '{"runs":5}');
	v_cursor := pg_temp.rc_cursor('finite');
	perform pg_temp.base_assert((pg_temp.rc_row('finite')).status = 'active' and v_cursor.routine_version = 1
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'an ended routine switched back on after missed slots restarts the schedule');
end
$$;

-- 9. A wall-clock trigger's start only holds back its first run: once the routine has run past it, a save without it keeps
--    the exact position, and a new start still ahead is a change. An interval trigger's start anchors its grid, so
--    dropping it restarts the schedule.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_start text := pg_temp.rc_ms(statement_timestamp() - interval '10 days');
	v_later text := pg_temp.rc_ms(statement_timestamp() + interval '5 days'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('started', 'Brief', pg_temp.rc_weekly('["mon"]', '08:00', v_start));
	perform pg_temp.rc_ran('started', v_ran, v_ran + interval '7 days');
	perform pg_temp.rc_save('started', 'Brief', pg_temp.rc_weekly('["mon"]', '08:00'), '{"instructions":"Write the brief for the board."}');
	v_cursor := pg_temp.rc_cursor('started');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days', 'a wall-clock start already passed is not timing');
	perform pg_temp.rc_save('started', 'Brief', pg_temp.rc_weekly('["mon"]', '08:00', v_later), '{"instructions":"Write the brief for the board."}');
	v_cursor := pg_temp.rc_cursor('started');
	perform pg_temp.base_assert(v_cursor.routine_version = 3
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', pg_temp.rc_effective_at('started'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond', 'a start still ahead is timing');

	perform pg_temp.rc_save('anchored', 'Pulse', pg_temp.rc_every(60, v_start));
	perform pg_temp.rc_ran('anchored', v_ran, v_ran + interval '1 hour');
	perform pg_temp.rc_save('anchored', 'Pulse', pg_temp.rc_every(60), '{"instructions":"Write the brief for the board."}');
	v_cursor := pg_temp.rc_cursor('anchored');
	perform pg_temp.base_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds', pg_temp.rc_effective_at('anchored'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'an interval trigger''s start anchors its grid, so dropping it restarts the schedule');
end
$$;

-- 10. The order of the days is not timing: a rename that writes ["mon","sun"] as ["sun","mon"] keeps the exact position.
--     A file-change routine that becomes a schedule (its trigger is `file` either way) is a new schedule: fresh, with
--     its kickoff.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 day');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('weekend', 'Weekend review', pg_temp.rc_weekly('["mon","sun"]', '18:00'));
	perform pg_temp.rc_ran('weekend', v_ran, v_ran + interval '6 days');
	perform pg_temp.rc_save('weekend', 'Weekend wrap-up', pg_temp.rc_weekly('["sun","mon"]', '18:00'));
	v_cursor := pg_temp.rc_cursor('weekend');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '6 days', 'reordered weekdays keep the exact position');

	perform pg_temp.rc_save('watch', 'Notes watch', '{"when":"file-change","watch":"notes","match":"subtree"}');
	perform pg_temp.base_assert(pg_temp.rc_cursor('watch') is null, 'fixture: a file-change routine has no schedule cursor');
	perform pg_temp.rc_save('watch', 'Notes digest', pg_temp.rc_weekly('["fri"]', '16:00'));
	v_cursor := pg_temp.rc_cursor('watch');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz, 'a file-change routine that becomes a schedule starts fresh, with its kickoff');
end
$$;

-- 11. A run still waiting for its start (a slot not yet a run: quiet hours, admission) is refused once a newer version
--     exists (superseded). With the same timing its slot is offered again to the new version, so the edit applies to that
--     run instead of losing it. A waiting kickoff leaves the new version fresh, owed its kickoff. With changed timing the
--     new schedule replaces it. These hold because a save decides the cursor before it moves the routine to the new version.
do $$
declare v_slot timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '2 minutes');
	v_brief jsonb := pg_temp.rc_weekly('["mon"]', '08:30'); v_cursor public.qorpera_cloud_routine_schedule_cursors; v_waiting uuid;
begin
	perform pg_temp.rc_save('waiting', 'Monday brief', v_brief);
	v_waiting := (pg_temp.rc_enqueued('waiting', v_slot, v_slot + interval '7 days') ->> 'occurrence_id')::uuid;
	perform set_config('qorpera_test.rc_waiting', v_waiting::text, true);
	perform pg_temp.rc_save('waiting', 'Weekly brief', v_brief);
	v_cursor := pg_temp.rc_cursor('waiting');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_slot - interval '1 millisecond'
		and v_cursor.next_due_at = v_slot, 'a slot still waiting for its run is offered again to the new version');
	perform pg_temp.base_assert((select status = 'cancelled' and blocked_reason = 'Superseded by a newer version'
		from public.qorpera_wake_occurrences where id = v_waiting), 'the old version''s waiting run is superseded');

	perform pg_temp.rc_save('kickoff', 'New brief', v_brief);
	perform pg_temp.rc_enqueued('kickoff', date_trunc('milliseconds', pg_temp.rc_effective_at('kickoff')),
		date_trunc('milliseconds', pg_temp.rc_effective_at('kickoff')) + interval '7 days');
	perform pg_temp.rc_save('kickoff', 'New weekly brief', v_brief);
	v_cursor := pg_temp.rc_cursor('kickoff');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz, 'a waiting kickoff leaves the new version fresh, owed its kickoff');

	perform pg_temp.rc_save('retimed', 'Monday brief', v_brief);
	perform pg_temp.rc_enqueued('retimed', v_slot, v_slot + interval '7 days');
	perform pg_temp.rc_save('retimed', 'Friday brief', pg_temp.rc_weekly('["fri"]', '08:30'));
	v_cursor := pg_temp.rc_cursor('retimed');
	perform pg_temp.base_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds', pg_temp.rc_effective_at('retimed'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'with changed timing the new schedule replaces a waiting run of the old one');
end
$$;
-- The scheduler offers the same slot to the new version against the position it read, and that one becomes the run.
do $$
declare v_head jsonb := pg_temp.rc_head('waiting'); v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.rc_cursor('waiting');
	v_expected timestamptz; v_new jsonb;
begin
	perform pg_temp.base_materialize();
	perform pg_temp.base_assert((select status from public.qorpera_wake_occurrences
		where id = current_setting('qorpera_test.rc_waiting')::uuid) = 'cancelled', 'the old version''s waiting run stays refused');
	v_expected := pg_temp.rc_read(v_head);
	v_new := public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, extensions.gen_random_uuid(),
		'routine-cursor-waiting-again', 'file', v_cursor.next_due_at, v_expected, v_cursor.next_due_at + interval '7 days', '{}');
	perform pg_temp.base_materialize();
	perform pg_temp.base_assert(v_expected = v_cursor.last_scheduled_for
		and (select status from public.qorpera_wake_occurrences where id = (v_new ->> 'occurrence_id')::uuid) = 'materialized',
		'the waiting slot runs under the new version');
end
$$;

-- 12. A restart position is not a run time: qorpera_routine_next_run_at shows the next slot of a carried position, and
--     no next run once a save restarts the schedule.
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
begin
	perform pg_temp.rc_save('shown', 'Monday brief', pg_temp.rc_weekly('["mon"]', '08:30'));
	perform pg_temp.rc_ran('shown', v_ran, v_ran + interval '7 days');
	perform pg_temp.base_assert(public.qorpera_routine_next_run_at(pg_temp.rc_id('shown')) = v_ran + interval '7 days',
		'fixture: a carried position shows its next slot');
	perform pg_temp.rc_save('shown', 'Daily brief', pg_temp.rc_weekly('["mon","tue","wed"]', '08:30'));
	perform pg_temp.base_assert(public.qorpera_routine_next_run_at(pg_temp.rc_id('shown')) is null,
		'a restart position is not shown as the next run');
end
$$;

-- 13. A finite routine counts each slot once: a slot offered again after an edit and its refused twin of the old version
--     are one of its permitted runs, so an edit while a run waits does not end the routine one run early.
do $$
declare v_a timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_b timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '2 days');
	v_c timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 day');
begin
	perform pg_temp.rc_save('three', 'Three briefs', pg_temp.rc_every(1440), '{"runs":3}');
	perform pg_temp.rc_ran('three', v_a, v_b);
	perform pg_temp.rc_enqueued('three', v_b, v_c);
	perform pg_temp.rc_save('three', 'Three daily briefs', pg_temp.rc_every(1440), '{"runs":3}');
	perform pg_temp.rc_ran('three', v_b, v_c);
	perform pg_temp.base_assert((pg_temp.rc_row('three')).status = 'active'
		and (select count(*) from public.qorpera_wake_occurrences where routine_id = pg_temp.rc_id('three')) = 3,
		'the slot offered again and its refused twin count once toward the limit');
	perform pg_temp.base_assert((pg_temp.rc_view('three') ->> 'occurrences')::integer = 2, 'an agent sees the slots counted the same way');
	perform pg_temp.rc_ran('three', v_c, v_c + interval '1 day');
	perform pg_temp.base_assert((pg_temp.rc_row('three')).status = 'expired' and (pg_temp.rc_row('three')).expired_while_active,
		'the third slot is the routine''s last run');
end
$$;

-- 14. A slot that waited while a later one already ran is stale: an edit does not offer it again (it would run after the
--     later slot). A later slot that was cancelled never ran, so it does not make the waiting one stale. Quiet hours (the
--     file's, a change of the row and no new version) hold the first slot.
create function pg_temp.rc_quiet() returns jsonb language sql as $$
	select jsonb_build_object('quiet', jsonb_build_object('start', to_char((statement_timestamp() at time zone 'UTC') - interval '1 hour', 'HH24:MI'),
		'end', to_char((statement_timestamp() at time zone 'UTC') + interval '2 hours', 'HH24:MI'), 'timezone', 'UTC'))
$$;
do $$
declare v_first timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '2 days');
	v_second timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '1 day');
	v_stale uuid; v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('stale', 'Daily brief', pg_temp.rc_every(1440), pg_temp.rc_quiet());
	v_stale := (pg_temp.rc_enqueued('stale', v_first, v_second) ->> 'occurrence_id')::uuid;
	perform pg_temp.rc_save('stale', 'Daily brief', pg_temp.rc_every(1440));
	perform pg_temp.base_assert((pg_temp.rc_row('stale')).current_version = 1, 'fixture: quiet hours are the row''s');
	perform pg_temp.rc_ran('stale', v_second, v_second + interval '1 day');
	perform pg_temp.base_assert((select status from public.qorpera_wake_occurrences where id = v_stale) = 'queued',
		'fixture: the first slot still waits while the second one ran');
	perform pg_temp.rc_save('stale', 'Daily brief, renamed', pg_temp.rc_every(1440));
	v_cursor := pg_temp.rc_cursor('stale');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_second
		and v_cursor.next_due_at = v_second + interval '1 day', 'a stale waiting slot is not offered again: ' || to_jsonb(v_cursor)::text);

	perform pg_temp.rc_save('cancelled-later', 'Daily brief', pg_temp.rc_every(1440), pg_temp.rc_quiet());
	perform pg_temp.rc_enqueued('cancelled-later', v_first, v_second);
	perform pg_temp.rc_save('cancelled-later', 'Daily brief', pg_temp.rc_every(1440));
	v_stale := (pg_temp.rc_enqueued('cancelled-later', v_second, v_second + interval '1 day') ->> 'occurrence_id')::uuid;
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = statement_timestamp(),
		blocked_reason = 'Test: cancelled before it ran' where id = v_stale;
	perform pg_temp.rc_save('cancelled-later', 'Daily brief, renamed', pg_temp.rc_every(1440));
	v_cursor := pg_temp.rc_cursor('cancelled-later');
	perform pg_temp.base_assert(v_cursor.last_scheduled_for = v_first - interval '1 millisecond' and v_cursor.next_due_at = v_first,
		'a cancelled later slot does not stop the waiting one being offered again');
end
$$;

-- 15. An agent's save follows the same rule: Bob's run (section 0) saves his routine with changed timing, as a change set
--     its review allowed (an agent's routine change is delegation), and the schedule restarts at its save; its save with
--     the same timing keeps the position.
create function pg_temp.rc_agent_save(p_name text, p_title text, p_trigger jsonb, p_extra jsonb default '{}') returns jsonb
language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.rc_bob')::jsonb; v_units jsonb := jsonb_build_array(pg_temp.rc_unit(p_name, p_title,
		p_trigger, p_extra));
	v_actor jsonb := jsonb_build_object('kind', 'run', 'runId', v_binding -> 'runId', 'jobId', v_binding -> 'jobId',
		'runnerId', v_binding -> 'runnerId', 'assignmentId', v_binding -> 'assignmentId');
	v_manifest text; v_review uuid; v_result jsonb;
begin
	-- The run takes possession of the bytes it commits, as its own upload would.
	for v_manifest in select distinct i.manifest_text from jsonb_array_elements(v_units) u
		join public.qorpera_folder_upload_intents i on i.environment_id = '92400000-0000-4000-8000-000000000020'
			and i.manifest_sha256 = u -> 'file' ->> 'manifestSha256' loop
		perform pg_temp.base_seal(v_actor, v_manifest);
	end loop;
	-- The review's allow, recorded for exactly this change set (as 708's reviewed helper leaves it).
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('92400000-0000-4000-8000-000000000020', (v_binding ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(v_units),
		array(select generate_series(1, jsonb_array_length(v_units))), 'allow')
	returning id into v_review;
	v_result := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', v_actor, 'routine-cursor:' || extensions.gen_random_uuid(),
		v_units, v_review);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the run''s save: ' || v_result::text);
	perform pg_temp.base_follow_ups();
	return v_result;
end
$$;
do $$
declare v_ran timestamptz := date_trunc('milliseconds', statement_timestamp() - interval '3 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.rc_save('agent', 'Monday brief', pg_temp.rc_weekly('["mon"]', '08:00'));
	perform pg_temp.rc_ran('agent', v_ran, v_ran + interval '7 days');
	perform pg_temp.rc_agent_save('agent', 'Monday brief', pg_temp.rc_weekly('["mon"]', '08:00'), '{"instructions":"Write the brief for the board."}');
	v_cursor := pg_temp.rc_cursor('agent');
	perform pg_temp.base_assert((select run_id from public.qorpera_folder_commits where id = (pg_temp.rc_row('agent')).folder_commit_id)
		= (current_setting('qorpera_test.rc_bob')::jsonb ->> 'runId')::uuid, 'fixture: Bob''s run saved the routine');
	perform pg_temp.base_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days', 'an agent''s save with the same timing keeps the exact position');
	perform pg_temp.rc_agent_save('agent', 'Daily brief', pg_temp.rc_weekly('["mon","tue","wed","thu","fri","sat","sun"]', '08:00'),
		'{"instructions":"Write the brief for the board."}');
	v_cursor := pg_temp.rc_cursor('agent');
	perform pg_temp.base_assert(v_cursor.routine_version = 3
		and v_cursor.last_scheduled_for = date_trunc('milliseconds', pg_temp.rc_effective_at('agent'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'an agent''s changed timing restarts the schedule at its save: ' || to_jsonb(v_cursor)::text);
end
$$;

rollback;
