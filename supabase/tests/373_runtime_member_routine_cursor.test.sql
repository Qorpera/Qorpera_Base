-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Review of #316, 2026-09-25: a member's save (qorpera_upsert_cloud_routine)
-- gave the new version a fresh schedule cursor, and the scheduler kicks off a
-- fresh cursor at once. Renaming a Monday 08:30 brief on a Thursday ran it that
-- Thursday. A member's save now keeps the position its routine reached, per
-- schedule trigger id. Changed timing, or a resume after a missed slot,
-- restarts the schedule at the save: nothing runs at once and nothing is
-- caught up.

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
-- The scheduler records one occurrence the way the orchestrator does.
create function pg_temp.member_ran(p_client uuid,p_trigger text,p_at timestamptz,p_next timestamptz)
returns jsonb language plpgsql as $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.member_cursor(p_client,p_trigger);
begin
	return public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
		'member-cursor:' || extensions.gen_random_uuid(),p_trigger,p_at,v_cursor.last_scheduled_for,p_next,'{}');
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
-- the Mondays it missed while paused are skipped, not run in a burst.
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
select pg_temp.wake_assert(pg_temp.member_head(current_setting('qorpera_test.member_resumed')::uuid)
	#>> '{schedule_cursors,0,last_scheduled_for}' is not null,
	'The scheduler sees the resume position, so it neither kicks off nor catches up the missed Mondays');

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
	perform pg_temp.member_ran(v_client,'pulse',v_ahead,v_ahead + interval '1 hour');
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

rollback;
