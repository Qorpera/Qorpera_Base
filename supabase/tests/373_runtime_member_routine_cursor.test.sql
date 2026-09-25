-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Review of #316, 2026-09-25: a member's save (qorpera_upsert_cloud_routine)
-- gave the new version a fresh schedule cursor, and the scheduler kicks off a
-- fresh cursor at once. Renaming a Monday 08:30 brief on a Thursday ran it that
-- Thursday. A member's save now keeps the position its routine reached, per
-- schedule trigger id, and a run still waiting for its start is offered again
-- to the new version. Changed timing, or a resume after a missed slot (with or
-- without a new version), restarts the schedule at the save: nothing runs at
-- once and nothing is caught up.

-- Saves the routine as the owner; every call is a new version.
create function pg_temp.member_save(p_client uuid,p_title text,p_triggers jsonb,p_enabled boolean default true)
returns jsonb language plpgsql as $$
declare v_result jsonb; v_claims text := current_setting('request.jwt.claims');
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_upsert_cloud_routine('30000000-0000-4000-8000-000000000020',p_client,
		extensions.gen_random_uuid(),'30000000-0000-4000-8000-000000000031',p_title,'Write the brief.',p_triggers,
		'low',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn',
		'agent_turn',p_enabled,'automatic',null,'{}');
	perform set_config('request.jwt.claims',v_claims,true);
	return v_result;
end
$$;
-- One trigger's cursor on the routine's current version.
create function pg_temp.member_cursor(p_client uuid,p_trigger text)
returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select cursor from public.qorpera_cloud_routine_schedule_cursors cursor
	join public.qorpera_cloud_routines routine on routine.id = cursor.routine_id and routine.current_version = cursor.routine_version
	where routine.client_routine_id = p_client and cursor.trigger_id = p_trigger
$$;
create function pg_temp.member_effective_at(p_client uuid) returns timestamptz language sql as $$
	select version.created_at from public.qorpera_cloud_routine_versions version
	join public.qorpera_cloud_routines routine on routine.id = version.routine_id and routine.current_version = version.version
	where routine.client_routine_id = p_client
$$;
-- The scheduler offers one occurrence the way the orchestrator does; it waits until it
-- becomes a run.
create function pg_temp.member_enqueued(p_client uuid,p_trigger text,p_at timestamptz,p_next timestamptz)
returns jsonb language plpgsql as $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.member_cursor(p_client,p_trigger);
begin
	return public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
		'member-cursor:' || extensions.gen_random_uuid(),p_trigger,p_at,v_cursor.last_scheduled_for,p_next,'{}');
end
$$;
-- The routine ran: its occurrence was offered and became a run.
create function pg_temp.member_ran(p_client uuid,p_trigger text,p_at timestamptz,p_next timestamptz)
returns jsonb language plpgsql as $$
declare v_result jsonb := pg_temp.member_enqueued(p_client,p_trigger,p_at,p_next);
begin
	perform public.qorpera_materialize_wake_execution_runs(64);
	perform pg_temp.wake_assert((select status from public.qorpera_wake_occurrences
		where id = (v_result ->> 'occurrence_id')::uuid) = 'materialized','Fixture: the occurrence became a run');
	return v_result;
end
$$;
-- What the scheduler sees: the routine's schedule head, or null when nothing is due.
create function pg_temp.member_head(p_client uuid) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null,500) -> 'items') item
	where item ->> 'routine_id' = (select id::text from public.qorpera_cloud_routines where client_routine_id = p_client)
$$;

-- A rename after the routine has run keeps its exact position: nothing is due until
-- the next Monday, so the scheduler does not even list it (the fresh cursor it got
-- before was listed and kicked off at once).
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.member_save(v_client,'Monday brief',v_brief);
	perform pg_temp.wake_assert(pg_temp.member_head(v_client) #>> '{schedule_cursors,0,last_scheduled_for}' is null,
		'Fixture: a new routine starts with a fresh cursor, owed its kickoff');
	perform pg_temp.wake_assert(pg_temp.member_ran(v_client,'brief',v_ran,v_ran + interval '7 days') ->> 'status' = 'queued',
		'Fixture: the brief ran on Monday');
	perform pg_temp.wake_assert((pg_temp.member_save(v_client,'Weekly brief',v_brief) ->> 'version')::int = 2,
		'Fixture: the rename is a new version');
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','A rename keeps the exact schedule position');
	perform pg_temp.wake_assert(pg_temp.member_head(v_client) is null,'After a rename nothing is due before the next slot');

	-- Only the reply policy changes: the timing is the same, so the position is too.
	perform pg_temp.member_save(v_client,'Weekly brief',jsonb_set(v_brief,'{0,replyPolicy}','"optional"'));
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','A reply policy change keeps the exact schedule position');
end $$;

-- A routine that never ran keeps the kickoff it owes: its cursor stays fresh and the
-- scheduler kicks it off at the new version's effective time.
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_cursor public.qorpera_cloud_routine_schedule_cursors;
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
begin
	perform pg_temp.member_save(v_client,'New brief',v_brief);
	perform pg_temp.member_save(v_client,'New weekly brief',v_brief);
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'A never-run routine keeps a fresh cursor');
	perform pg_temp.wake_assert(pg_temp.member_head(v_client) #>> '{schedule_cursors,0,last_scheduled_for}' is null
		and (pg_temp.member_head(v_client) ->> 'effective_at')::timestamptz = pg_temp.member_effective_at(v_client),
		'The scheduler still sees the kickoff it owes, at the new version');
	perform pg_temp.member_save(v_client,'New daily brief',jsonb_set(v_brief,'{0,weekdays}','["monday","friday"]'));
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'Changed timing on a never-run routine keeps the kickoff it owes');
end $$;

-- Changed timing under the same id restarts the schedule at the save: the cursor stands
-- at the save, so the scheduler neither kicks off (the cursor is not fresh) nor replays
-- the new cadence's slots since the last run. Its first run is the new schedule's first
-- slot after the save. The position is millisecond-precise: the orchestrator reads it
-- into a JavaScript Date and sends it back as the expected position, which the enqueue
-- compares exactly.
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
	v_cursor public.qorpera_cloud_routine_schedule_cursors; v_saved_at timestamptz;
begin
	perform set_config('qorpera_test.member_daily',v_client::text,true);
	perform pg_temp.member_save(v_client,'Monday brief',v_brief);
	perform pg_temp.member_ran(v_client,'brief',v_ran,v_ran + interval '7 days');
	perform pg_temp.member_save(v_client,'Daily brief',jsonb_set(v_brief,'{0,weekdays}',
		'["monday","tuesday","wednesday","thursday","friday"]'));
	v_saved_at := pg_temp.member_effective_at(v_client);
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',v_saved_at)
		and v_cursor.last_scheduled_for > v_ran and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'Changed timing restarts the schedule at the save, to the millisecond');
end $$;
-- The scheduler lists it from its next poll (a later statement than the save).
do $$
declare v_client uuid := current_setting('qorpera_test.member_daily')::uuid; v_head jsonb := pg_temp.member_head(v_client);
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.member_cursor(v_client,'brief'); v_expected timestamptz;
begin
	perform pg_temp.wake_assert(v_head #>> '{schedule_cursors,0,last_scheduled_for}' is not null,
		'The scheduler sees a position, not a fresh cursor, so nothing runs at once');
	-- The orchestrator's expected position: its Date of the listed value, as an ISO string.
	v_expected := to_char((v_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz;
	perform pg_temp.wake_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,
		extensions.gen_random_uuid(),'member-cursor-first-daily',v_cursor.trigger_id,v_expected + interval '1 day',v_expected,
		v_expected + interval '2 days','{}') ->> 'status' = 'queued'
		and (pg_temp.member_cursor(v_client,'brief')).last_scheduled_for = v_expected + interval '1 day',
		'The first slot after the save is admitted against the position the orchestrator read');
end $$;

-- Pausing and resuming. Resumed before its next slot, the routine keeps its exact
-- position. Resumed after its next slot passed, the schedule restarts at the resume:
-- the Mondays it missed while paused are skipped, not run in a burst. (Any save of a
-- paused routine whose next slot passed restarts the same way.)
do $$
declare v_soon uuid := extensions.gen_random_uuid(); v_late uuid := extensions.gen_random_uuid();
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '15 days');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.member_save(v_soon,'Monday brief',v_brief);
	perform pg_temp.member_ran(v_soon,'brief',v_ran,v_ran + interval '7 days');
	perform pg_temp.wake_assert(pg_temp.member_save(v_soon,'Monday brief',v_brief,false) ->> 'status' = 'paused',
		'Fixture: the member pauses the brief');
	v_cursor := pg_temp.member_cursor(v_soon,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_ran + interval '7 days',
		'A pause keeps the exact schedule position');
	perform pg_temp.wake_assert(pg_temp.member_save(v_soon,'Monday brief',v_brief,true) ->> 'status' = 'active',
		'Fixture: the member resumes the brief');
	v_cursor := pg_temp.member_cursor(v_soon,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days' and pg_temp.member_head(v_soon) is null,
		'Resumed before its next slot, the routine keeps its exact position and runs nothing at once');

	perform pg_temp.member_save(v_late,'Monday brief',v_brief);
	perform pg_temp.member_ran(v_late,'brief',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.member_save(v_late,'Monday brief',v_brief,false);
	v_cursor := pg_temp.member_cursor(v_late,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_long_ago,'A pause keeps even an overdue position');
	perform pg_temp.member_save(v_late,'Monday brief',v_brief,true);
	v_cursor := pg_temp.member_cursor(v_late,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',pg_temp.member_effective_at(v_late))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'Resumed after missed slots, the schedule restarts at the resume');
	perform set_config('qorpera_test.member_resumed',v_late::text,true);
end $$;
do $$
declare v_client uuid := current_setting('qorpera_test.member_resumed')::uuid; v_head jsonb := pg_temp.member_head(v_client);
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.member_cursor(v_client,'brief'); v_expected timestamptz;
begin
	perform pg_temp.wake_assert(v_head #>> '{schedule_cursors,0,last_scheduled_for}' is not null,
		'The scheduler sees the resume position, so it neither kicks off nor catches up the missed Mondays');
	v_expected := to_char((v_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz;
	perform pg_temp.wake_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,
		extensions.gen_random_uuid(),'member-cursor-first-after-resume',v_cursor.trigger_id,v_expected + interval '3 days',
		v_expected,v_expected + interval '10 days','{}') ->> 'status' = 'queued',
		'The first Monday after the resume is admitted against the position the orchestrator read');
end $$;

-- The order of the days is not timing: a rename that rewrites ["monday","sunday"] in
-- the web editor's order keeps the exact position. A trigger that was a listener and
-- becomes a schedule under the same id is a new schedule: fresh, with its kickoff.
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_watch uuid := extensions.gen_random_uuid();
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.member_save(v_client,'Weekend review','[{"id":"review","kind":"schedule","intervalMinutes":1440,
		"weekdays":["monday","sunday"],"localTime":"18:00","timeZone":"Europe/Copenhagen"}]');
	perform pg_temp.member_ran(v_client,'review',v_ran,v_ran + interval '6 days');
	perform pg_temp.member_save(v_client,'Weekend wrap-up','[{"id":"review","kind":"schedule","intervalMinutes":1440,
		"weekdays":["sunday","monday"],"localTime":"18:00","timeZone":"Europe/Copenhagen"}]');
	v_cursor := pg_temp.member_cursor(v_client,'review');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '6 days','Reordered weekdays keep the exact position');

	perform pg_temp.member_save(v_watch,'Notes watch',
		'[{"id":"watch","kind":"listener","source":"company-file","path":"notes","match":"subtree","timeZone":"UTC"}]');
	perform pg_temp.wake_assert(pg_temp.member_cursor(v_watch,'watch') is null,'Fixture: a listener has no schedule cursor');
	perform pg_temp.member_save(v_watch,'Notes digest','[{"id":"watch","kind":"schedule","intervalMinutes":1440,
		"weekdays":["friday"],"localTime":"16:00","timeZone":"Europe/Copenhagen"}]');
	v_cursor := pg_temp.member_cursor(v_watch,'watch');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'A listener that becomes a schedule starts fresh, with its kickoff');
end $$;

-- An interval a wall-clock trigger does not use is not timing either: a weekly trigger
-- stored with intervalMinutes 10080 and rewritten by the web editor with 1440 keeps its
-- exact position.
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_cursor public.qorpera_cloud_routine_schedule_cursors;
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 days');
begin
	perform pg_temp.member_save(v_client,'Monday brief','[{"id":"brief","kind":"schedule","intervalMinutes":10080,
		"weekdays":["monday"],"localTime":"08:30","timeZone":"Europe/Copenhagen"}]');
	perform pg_temp.member_ran(v_client,'brief',v_ran,v_ran + interval '7 days');
	perform pg_temp.member_save(v_client,'Weekly brief','[{"id":"brief","kind":"schedule","intervalMinutes":1440,
		"weekdays":["monday"],"localTime":"08:30","timeZone":"Europe/Copenhagen"}]');
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','An unused interval on a wall-clock trigger keeps the exact position');
end $$;

-- A run still waiting for its start (an occurrence not yet a run: quiet hours, admission)
-- is refused once a newer version exists. With the same timing its slot is offered again
-- to the new version, so the rename applies to that run instead of losing it. A waiting
-- kickoff moves to the new version. With changed timing the new schedule replaces it.
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_kickoff uuid := extensions.gen_random_uuid();
	v_retimed uuid := extensions.gen_random_uuid(); v_cursor public.qorpera_cloud_routine_schedule_cursors;
	v_slot timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 minutes');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
begin
	perform set_config('qorpera_test.member_waiting',v_client::text,true);
	perform pg_temp.member_save(v_client,'Monday brief',v_brief);
	perform set_config('qorpera_test.member_waiting_run',
		pg_temp.member_enqueued(v_client,'brief',v_slot,v_slot + interval '7 days') ->> 'occurrence_id',true);
	perform pg_temp.member_save(v_client,'Weekly brief',v_brief);
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_slot - interval '1 millisecond'
		and v_cursor.next_due_at = v_slot,'A slot still waiting for its run is offered again to the new version');

	perform pg_temp.member_save(v_kickoff,'New brief',v_brief);
	perform pg_temp.member_enqueued(v_kickoff,'brief',date_trunc('milliseconds',pg_temp.member_effective_at(v_kickoff)),
		date_trunc('milliseconds',pg_temp.member_effective_at(v_kickoff)) + interval '7 days');
	perform pg_temp.member_save(v_kickoff,'New weekly brief',jsonb_set(v_brief,'{0,localTime}','"09:00"'));
	v_cursor := pg_temp.member_cursor(v_kickoff,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'A kickoff still waiting for its run moves to the new version');

	perform pg_temp.member_save(v_retimed,'Monday brief',v_brief);
	perform pg_temp.member_enqueued(v_retimed,'brief',v_slot,v_slot + interval '7 days');
	perform pg_temp.member_save(v_retimed,'Friday brief',jsonb_set(v_brief,'{0,weekdays}','["friday"]'));
	v_cursor := pg_temp.member_cursor(v_retimed,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',pg_temp.member_effective_at(v_retimed))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'With changed timing the new schedule replaces a waiting run of the old one');
end $$;
-- The old version's waiting occurrence is refused; the scheduler offers the same slot to
-- the new version against the position it read, and that one becomes the run.
do $$
declare v_client uuid := current_setting('qorpera_test.member_waiting')::uuid; v_head jsonb := pg_temp.member_head(v_client);
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.member_cursor(v_client,'brief');
	v_old uuid := current_setting('qorpera_test.member_waiting_run')::uuid; v_expected timestamptz; v_new jsonb;
begin
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert((select status from public.qorpera_wake_occurrences where id = v_old) = 'cancelled',
		'Fixture: the old version''s waiting occurrence is refused');
	v_expected := to_char((v_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz;
	v_new := public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
		'member-cursor-waiting-again',v_cursor.trigger_id,v_cursor.next_due_at,v_expected,v_cursor.next_due_at + interval '7 days','{}');
	perform public.qorpera_materialize_wake_execution_runs(8);
	perform pg_temp.wake_assert(v_expected = v_cursor.last_scheduled_for
		and (select status from public.qorpera_wake_occurrences where id = (v_new ->> 'occurrence_id')::uuid) = 'materialized',
		'The waiting slot runs under the new version');
end $$;

-- A member's pause keeps the position. An agent's resume switches the routine back on
-- without a new version; once the next slot has passed the cursor restarts in place, so
-- the slots the pause skipped are not replayed. Resumed before its next slot, it is kept.
do $$
declare v_late uuid := extensions.gen_random_uuid(); v_soon uuid := extensions.gen_random_uuid();
	v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '15 days');
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.member_save(v_late,'Monday brief',v_brief);
	perform pg_temp.member_ran(v_late,'brief',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.member_save(v_late,'Monday brief',v_brief,false);
	update public.qorpera_cloud_routines set status = 'active', pause_reason = null where client_routine_id = v_late;
	v_cursor := pg_temp.member_cursor(v_late,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2
		and v_cursor.last_scheduled_for = date_trunc('milliseconds',statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'A resume without a new version restarts an overdue cursor in place');

	perform pg_temp.member_save(v_soon,'Monday brief',v_brief);
	perform pg_temp.member_ran(v_soon,'brief',v_ran,v_ran + interval '7 days');
	perform pg_temp.member_save(v_soon,'Monday brief',v_brief,false);
	update public.qorpera_cloud_routines set status = 'active', pause_reason = null where client_routine_id = v_soon;
	v_cursor := pg_temp.member_cursor(v_soon,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_ran + interval '7 days',
		'A resume without a new version keeps a cursor whose next slot is ahead');
end $$;

-- A restart position is not a run time: once qorpera_routine_next_run_at exists (v114),
-- it does not show one as the next run.
do $$
declare v_client uuid := extensions.gen_random_uuid();
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30",
		"timeZone":"Europe/Copenhagen"}]';
begin
	if to_regprocedure('public.qorpera_routine_next_run_at(uuid)') is null then return; end if;
	perform pg_temp.member_save(v_client,'Monday brief',v_brief);
	-- Where the scheduler leaves a cursor after a run, without a waiting occurrence.
	update public.qorpera_cloud_routine_schedule_cursors cursor set last_scheduled_for = v_ran,
		next_due_at = v_ran + interval '7 days'
	from public.qorpera_cloud_routines routine
	where routine.client_routine_id = v_client and cursor.routine_id = routine.id;
	perform pg_temp.wake_assert(public.qorpera_routine_next_run_at(
		(select id from public.qorpera_cloud_routines where client_routine_id = v_client)) = v_ran + interval '7 days',
		'Fixture: a carried position shows its next slot');
	perform pg_temp.member_save(v_client,'Daily brief',jsonb_set(v_brief,'{0,weekdays}','["monday","tuesday","wednesday"]'));
	perform pg_temp.wake_assert(public.qorpera_routine_next_run_at(
		(select id from public.qorpera_cloud_routines where client_routine_id = v_client)) is null,
		'A restart position is not shown as the next run');
end $$;

-- Each schedule trigger is decided on its own: a kept trigger keeps its position, a
-- changed one restarts at the save, a new id starts fresh with its kickoff. A position
-- never moves behind the one the routine reached, even when the scheduler's clock ran
-- ahead of the database's.
do $$
declare v_client uuid := extensions.gen_random_uuid();
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 hours');
	v_ahead timestamptz := date_trunc('milliseconds',statement_timestamp() + interval '10 seconds');
	v_first jsonb := jsonb_build_array(
		'{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:30","timeZone":"Europe/Copenhagen"}'::jsonb,
		jsonb_build_object('id','pulse','kind','schedule','intervalMinutes',60,
			'startAt',to_char((statement_timestamp() - interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:00:00.000"Z"')));
	v_second jsonb; v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.member_save(v_client,'Two schedules',v_first);
	perform pg_temp.member_ran(v_client,'brief',v_ran,v_ran + interval '7 days');
	perform pg_temp.member_enqueued(v_client,'pulse',v_ahead,v_ahead + interval '1 hour');
	v_second := jsonb_build_array(v_first -> 0,jsonb_set(v_first -> 1,'{intervalMinutes}','30'),
		'{"id":"digest","kind":"schedule","intervalMinutes":1440,"weekdays":["friday"],"localTime":"16:00","timeZone":"Europe/Copenhagen"}'::jsonb);
	perform pg_temp.member_save(v_client,'Two schedules and a digest',v_second);
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','An unchanged trigger keeps its position beside changed ones');
	v_cursor := pg_temp.member_cursor(v_client,'pulse');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_ahead and v_cursor.next_due_at = v_ahead + interval '1 millisecond',
		'A changed trigger restarts, never behind the position it reached');
	v_cursor := pg_temp.member_cursor(v_client,'digest');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for is null and v_cursor.next_due_at = '-infinity'::timestamptz,
		'A new trigger id starts fresh, with its kickoff');
end $$;

-- A finite routine counts each slot once: a slot offered again after an edit and its
-- refused twin of the old version are one of its permitted runs, so an edit while a
-- run waits does not end the routine one run early.
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_row public.qorpera_cloud_routines;
	v_a timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_b timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 days');
	v_c timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440}]';
begin
	perform pg_temp.member_save(v_client,'Three briefs',v_brief);
	update public.qorpera_cloud_routines set max_occurrences = 3 where client_routine_id = v_client;
	perform pg_temp.member_ran(v_client,'brief',v_a,v_b);
	perform pg_temp.member_enqueued(v_client,'brief',v_b,v_c);
	perform pg_temp.member_save(v_client,'Three daily briefs',v_brief);
	perform pg_temp.member_ran(v_client,'brief',v_b,v_c);
	select * into v_row from public.qorpera_cloud_routines where client_routine_id = v_client;
	perform pg_temp.wake_assert(v_row.status = 'active'
		and (select count(*) from public.qorpera_wake_occurrences where routine_id = v_row.id) = 3,
		'The slot offered again and its refused twin count once toward the limit');
	perform pg_temp.wake_assert((public.qorpera_agent_routine_view(v_row) ->> 'occurrences')::int = 2,
		'An agent sees the slots counted the same way');
	perform pg_temp.member_ran(v_client,'brief',v_c,v_c + interval '1 day');
	select * into v_row from public.qorpera_cloud_routines where client_routine_id = v_client;
	perform pg_temp.wake_assert(v_row.status = 'expired' and v_row.expired_while_active,
		'The third slot is the routine''s last run');
end $$;

-- A slot that waited while a later one already ran is stale: an edit does not offer it
-- again (it would run after the later slot).
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_cursor public.qorpera_cloud_routine_schedule_cursors;
	v_first timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 days');
	v_second timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_stale uuid;
	v_brief jsonb := '[{"id":"brief","kind":"schedule","intervalMinutes":1440}]';
begin
	perform pg_temp.member_save(v_client,'Daily brief',v_brief);
	-- Quiet hours now: the first slot waits for the window's end.
	update public.qorpera_cloud_routines set quiet_start = ((statement_timestamp() at time zone 'UTC') - interval '1 hour')::time,
		quiet_end = ((statement_timestamp() at time zone 'UTC') + interval '2 hours')::time, quiet_time_zone = 'UTC'
	where client_routine_id = v_client;
	v_stale := (pg_temp.member_enqueued(v_client,'brief',v_first,v_second) ->> 'occurrence_id')::uuid;
	update public.qorpera_cloud_routines set quiet_start = null, quiet_end = null, quiet_time_zone = null
	where client_routine_id = v_client;
	perform pg_temp.member_ran(v_client,'brief',v_second,v_second + interval '1 day');
	perform pg_temp.wake_assert((select status from public.qorpera_wake_occurrences where id = v_stale) = 'queued',
		'Fixture: the first slot still waits while the second one ran');
	perform pg_temp.member_save(v_client,'Daily brief, renamed',v_brief);
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_second
		and v_cursor.next_due_at = v_second + interval '1 day','A stale waiting slot is not offered again');

	-- A later slot that was cancelled never ran, so it does not make the waiting one stale.
	v_client := extensions.gen_random_uuid();
	perform pg_temp.member_save(v_client,'Daily brief',v_brief);
	update public.qorpera_cloud_routines set quiet_start = ((statement_timestamp() at time zone 'UTC') - interval '1 hour')::time,
		quiet_end = ((statement_timestamp() at time zone 'UTC') + interval '2 hours')::time, quiet_time_zone = 'UTC'
	where client_routine_id = v_client;
	perform pg_temp.member_enqueued(v_client,'brief',v_first,v_second);
	update public.qorpera_cloud_routines set quiet_start = null, quiet_end = null, quiet_time_zone = null
	where client_routine_id = v_client;
	v_stale := (pg_temp.member_enqueued(v_client,'brief',v_second,v_second + interval '1 day') ->> 'occurrence_id')::uuid;
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = statement_timestamp(),
		blocked_reason = 'Test: cancelled before it ran'
	where id = v_stale;
	perform pg_temp.member_save(v_client,'Daily brief, renamed',v_brief);
	v_cursor := pg_temp.member_cursor(v_client,'brief');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_first - interval '1 millisecond' and v_cursor.next_due_at = v_first,
		'A cancelled later slot does not stop the waiting one being offered again');
end $$;

rollback;
