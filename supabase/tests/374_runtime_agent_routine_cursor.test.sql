-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 2026-09-25: an agent's own routine save (qorpera_manage_agent_routine)
-- carried the previous cursor forward even when the agent changed the timing,
-- and the agent's resume only switched the status back. The scheduler then
-- ignored a new cadence until the old next slot came round and replayed every
-- missed slot, one run each. The agent path now uses the member path's rule
-- (#317, qorpera_routine_version_schedule_position, and its resume trigger): the
-- same timing keeps the exact position; changed timing, or switching a routine
-- back on after its next slot passed, restarts the schedule at the save or the
-- resume; a never-run cursor stays fresh and keeps its kickoff. A wall-clock
-- trigger's start the routine has passed is not timing, on both paths.
-- On #314 + #317 without this migration, the weekly-to-daily, slower, paused
-- save, started and member-start groups fail (the last two also without only
-- the start rule). The resume, suspension and ended-watch groups pass there
-- too, because #317's trigger covers a switch back on at the same version; they
-- hold it on the agent path. The same-timing, never-ran, member's-trigger and
-- leave-alone groups guard the carry that stays.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','agent-cursor-ack');

-- The agent's routine tool, one operation key per change.
create function pg_temp.agent_routine(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_routine(current_setting('qorpera_test.wake_binding')::jsonb,
		p_request || case when p_request ->> 'action' = 'list' then '{}'::jsonb
			else jsonb_build_object('operationKey','agent-cursor-' || extensions.gen_random_uuid()) end)
$$;
create function pg_temp.agent_save(p_key text,p_trigger jsonb,p_intent text default 'Write the brief.')
returns jsonb language sql as $$
	select pg_temp.agent_routine(jsonb_build_object('action','upsert','routineKey',p_key,'title','Brief','intent',p_intent,
		'trigger',p_trigger))
$$;
create function pg_temp.agent_row(p_key text) returns public.qorpera_cloud_routines language sql as $$
	select routine from public.qorpera_cloud_routines routine where routine.routine_key = p_key and routine.origin = 'agent'
$$;
-- The routine's cursor on its current version.
create function pg_temp.agent_cursor(p_key text) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select cursor from public.qorpera_cloud_routine_schedule_cursors cursor
	join public.qorpera_cloud_routines routine on routine.id = cursor.routine_id and routine.current_version = cursor.routine_version
	where routine.routine_key = p_key and routine.origin = 'agent' and cursor.trigger_id = 'agent'
$$;
create function pg_temp.agent_effective_at(p_key text) returns timestamptz language sql as $$
	select version.created_at from public.qorpera_cloud_routine_versions version
	join public.qorpera_cloud_routines routine on routine.id = version.routine_id and routine.current_version = version.version
	where routine.routine_key = p_key and routine.origin = 'agent'
$$;
-- The scheduler records one occurrence the way the orchestrator does. The fixture
-- then closes it as if it had run, so only the cursor tells the next run.
create function pg_temp.agent_ran(p_key text,p_at timestamptz,p_next timestamptz) returns jsonb language plpgsql as $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor(p_key); v_result jsonb;
begin
	v_result := public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
		'agent-cursor:' || extensions.gen_random_uuid(),'agent',p_at,v_cursor.last_scheduled_for,p_next,'{}');
	update public.qorpera_wake_occurrences set status = 'cancelled', blocked_reason = 'Fixture: this slot ran',
		finished_at = statement_timestamp() where id = (v_result ->> 'occurrence_id')::uuid;
	return v_result;
end
$$;
-- What the scheduler sees: the routine's schedule head, or null when nothing is due.
create function pg_temp.agent_head(p_key text) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null,500) -> 'items') item
	where item ->> 'routine_id' = (pg_temp.agent_row(p_key)).id::text
$$;
-- The next run the agent's own list shows.
create function pg_temp.agent_next_run(p_key text) returns text language sql as $$
	select routine ->> 'nextRunAt' from jsonb_array_elements(pg_temp.agent_routine('{"action":"list"}') -> 'routines') routine
	where routine ->> 'routineKey' = p_key
$$;
-- The orchestrator's expected position: its Date of the listed value, as an ISO string.
create function pg_temp.agent_read_position(p_head jsonb) returns timestamptz language sql as $$
	select to_char((p_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz
$$;

-- Weekly Monday 08:00 that ran on Monday becomes daily 08:00 on Thursday. The old
-- cursor would have hidden the new cadence until the next Monday and then replayed the
-- daily slots since the last run. The schedule restarts at the save instead: nothing
-- runs at once, nothing is caught up, and the first run is the first daily slot after
-- the save.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_weekly jsonb := '{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen","replyPolicy":"optional"}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('weekly-to-daily',v_weekly);
	perform pg_temp.wake_assert(pg_temp.agent_ran('weekly-to-daily',v_ran,v_ran + interval '7 days') ->> 'status' = 'queued',
		'Fixture: the weekly brief ran on Monday');
	perform pg_temp.wake_assert((pg_temp.agent_save('weekly-to-daily',jsonb_set(v_weekly,'{weekdays}',
		'["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]')) #>> '{routine,version}')::int = 2,
		'Fixture: the daily cadence is a new version');
	v_cursor := pg_temp.agent_cursor('weekly-to-daily');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2
		and v_cursor.last_scheduled_for = date_trunc('milliseconds',pg_temp.agent_effective_at('weekly-to-daily'))
		and v_cursor.last_scheduled_for > v_ran and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'Changed timing restarts the schedule at the save, to the millisecond');
end $$;
-- From its next poll (a later statement than the save) the scheduler lists the routine
-- at the restart position, not the old Monday, and not as a fresh cursor (no kickoff).
-- The first slot after the save is admitted against the position the orchestrator read.
do $$
declare v_head jsonb := pg_temp.agent_head('weekly-to-daily'); v_expected timestamptz;
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor('weekly-to-daily');
begin
	perform pg_temp.wake_assert(v_head #>> '{schedule_cursors,0,last_scheduled_for}' is not null,
		'The scheduler sees the new cadence at once, at a position, so nothing runs at once');
	perform pg_temp.wake_assert(pg_temp.agent_next_run('weekly-to-daily') is null,
		'A restart position is not shown as the next run');
	v_expected := pg_temp.agent_read_position(v_head);
	perform pg_temp.wake_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,
		extensions.gen_random_uuid(),'agent-cursor-first-daily','agent',v_expected + interval '1 day',v_expected,
		v_expected + interval '2 days','{}') ->> 'status' = 'queued'
		and (pg_temp.agent_cursor('weekly-to-daily')).last_scheduled_for = v_expected + interval '1 day',
		'The first daily slot is admitted against the millisecond position');
end $$;

-- The same timing keeps the exact position: a changed intent, a changed reply policy,
-- or the same days in another order. That holds while the routine is active even when
-- its next slot is overdue (the scheduler owes it now).
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_overdue timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 hours');
	v_trigger jsonb := '{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday","friday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen","replyPolicy":"optional"}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('same-timing',v_trigger);
	perform pg_temp.agent_ran('same-timing',v_ran,v_ran + interval '4 days');
	perform pg_temp.agent_save('same-timing',v_trigger,'Write a shorter brief.');
	v_cursor := pg_temp.agent_cursor('same-timing');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '4 days','A changed intent keeps the exact position');
	perform pg_temp.wake_assert(pg_temp.agent_next_run('same-timing')::timestamptz = v_ran + interval '4 days',
		'A kept position is the next run');
	perform pg_temp.agent_save('same-timing',jsonb_set(jsonb_set(v_trigger,'{replyPolicy}','"silent"'),'{weekdays}',
		'["friday","monday"]'),'Write a shorter brief.');
	v_cursor := pg_temp.agent_cursor('same-timing');
	perform pg_temp.wake_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '4 days','A reply policy and day order change keeps the exact position');

	perform pg_temp.agent_save('overdue',v_trigger);
	perform pg_temp.agent_ran('overdue',v_ran,v_overdue);
	perform pg_temp.agent_save('overdue',v_trigger,'Write the brief, then file it.');
	v_cursor := pg_temp.agent_cursor('overdue');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_overdue,'An active routine keeps even an overdue position: that slot is owed');
end $$;

-- A routine that never ran keeps the kickoff it owes, even when its timing changes.
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('never-ran','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],
		"localTime":"08:00","timeZone":"Europe/Copenhagen"}');
	perform pg_temp.agent_save('never-ran','{"kind":"schedule","intervalMinutes":60}');
	v_cursor := pg_temp.agent_cursor('never-ran');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'A never-run routine keeps a fresh cursor, and its kickoff');
end $$;

-- An every-2-hours routine that the agent slows to daily, while the scheduler's clock
-- ran ahead of the database's: the restart never moves behind the position reached.
do $$
declare v_ahead timestamptz := date_trunc('milliseconds',statement_timestamp() + interval '10 seconds');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('slower','{"kind":"schedule","intervalMinutes":120}');
	perform pg_temp.agent_ran('slower',v_ahead,v_ahead + interval '2 hours');
	perform pg_temp.agent_save('slower','{"kind":"schedule","intervalMinutes":1440}');
	v_cursor := pg_temp.agent_cursor('slower');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_ahead and v_cursor.next_due_at = v_ahead + interval '1 millisecond',
		'A changed cadence restarts, never behind the position it reached');
end $$;

-- A save of a paused routine keeps the position while its next slot is ahead and
-- restarts the schedule once that slot has passed (the slots it missed while it was off
-- are skipped, not run in a burst).
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '15 days');
	v_trigger jsonb := '{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('paused-soon',v_trigger);
	perform pg_temp.agent_ran('paused-soon',v_ran,v_ran + interval '7 days');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"paused-soon"}');
	perform pg_temp.agent_save('paused-soon',v_trigger,'Write the brief for the new team.');
	v_cursor := pg_temp.agent_cursor('paused-soon');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','A save of a paused routine before its next slot keeps the position');

	perform pg_temp.agent_save('paused-late',v_trigger);
	perform pg_temp.agent_ran('paused-late',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"paused-late"}');
	perform pg_temp.agent_save('paused-late',v_trigger,'Write the brief for the new team.');
	v_cursor := pg_temp.agent_cursor('paused-late');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2
		and v_cursor.last_scheduled_for = date_trunc('milliseconds',pg_temp.agent_effective_at('paused-late'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'A save of a paused routine after its next slot passed restarts the schedule at the save');
end $$;

-- The agent's resume keeps the version, so its cursor moves in place: kept while the
-- next slot is ahead, restarted at the resume once it has passed.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '15 days');
	v_trigger jsonb := '{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('resume-soon',v_trigger);
	perform pg_temp.agent_ran('resume-soon',v_ran,v_ran + interval '7 days');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"resume-soon"}');
	perform pg_temp.wake_assert(pg_temp.agent_routine('{"action":"resume","routineKey":"resume-soon"}')
		#>> '{routine,status}' = 'active','Fixture: the agent resumes the routine');
	v_cursor := pg_temp.agent_cursor('resume-soon');
	perform pg_temp.wake_assert(v_cursor.routine_version = 1 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days',
		'Resumed before its next slot, the routine keeps its exact position');

	perform pg_temp.agent_save('resume-late',v_trigger);
	perform pg_temp.agent_ran('resume-late',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"resume-late"}');
	perform pg_temp.wake_assert((pg_temp.agent_cursor('resume-late')).last_scheduled_for = v_long_ago,
		'A pause keeps even an overdue position');
	perform pg_temp.agent_routine('{"action":"resume","routineKey":"resume-late"}');
	v_cursor := pg_temp.agent_cursor('resume-late');
	perform pg_temp.wake_assert(v_cursor.routine_version = 1
		and v_cursor.last_scheduled_for = date_trunc('milliseconds',statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'Resumed after missed slots, the schedule restarts at the resume');

	-- An unchanged save switches a paused routine back on at the same version: the same rule.
	perform pg_temp.agent_save('unchanged-late',v_trigger);
	perform pg_temp.agent_ran('unchanged-late',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"unchanged-late"}');
	perform pg_temp.wake_assert(pg_temp.agent_save('unchanged-late',v_trigger) #>> '{routine,status}' = 'active'
		and (pg_temp.agent_row('unchanged-late')).current_version = 1,'Fixture: an unchanged save resumes at the same version');
	v_cursor := pg_temp.agent_cursor('unchanged-late');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'An unchanged save of a paused routine after missed slots restarts the schedule');
end $$;
-- The scheduler sees the resume position from its next poll: it neither kicks off nor
-- catches up the missed Mondays, and the first Monday after the resume is admitted.
do $$
declare v_head jsonb := pg_temp.agent_head('resume-late'); v_expected timestamptz;
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor('resume-late');
begin
	perform pg_temp.wake_assert(v_head #>> '{schedule_cursors,0,last_scheduled_for}' is not null
		and pg_temp.agent_next_run('resume-late') is null,
		'The scheduler sees the resume position; it is not shown as the next run');
	v_expected := pg_temp.agent_read_position(v_head);
	perform pg_temp.wake_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,
		extensions.gen_random_uuid(),'agent-cursor-first-after-resume','agent',v_expected + interval '3 days',v_expected,
		v_expected + interval '10 days','{}') ->> 'status' = 'queued',
		'The first Monday after the resume is admitted against the position the orchestrator read');
end $$;

-- Three authorization failures suspend the routine. When the agent resumes it after
-- the account works again, the slots that passed meanwhile are skipped.
do $$
declare v_row public.qorpera_cloud_routines; v_routine jsonb; v_id uuid; v_index int;
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('suspended','{"kind":"schedule","intervalMinutes":5,"replyPolicy":"silent"}');
	v_row := pg_temp.agent_row('suspended');
	v_routine := jsonb_build_object('routine_id',v_row.id,'version',v_row.current_version);
	for v_index in 1..3 loop
		v_id := pg_temp.wake_schedule(v_routine,'suspended-' || v_index,statement_timestamp() - make_interval(mins => 40 - 10 * v_index));
		update public.qorpera_wake_occurrences set status = 'cancelled',
			blocked_reason = 'Wake execution authority is unavailable', finished_at = statement_timestamp() where id = v_id;
	end loop;
	perform pg_temp.wake_assert((pg_temp.agent_row('suspended')).pause_reason = 'authorization_failed',
		'Fixture: three authorization failures suspend the routine');
	perform pg_temp.agent_routine('{"action":"resume","routineKey":"suspended"}');
	v_cursor := pg_temp.agent_cursor('suspended');
	perform pg_temp.wake_assert((pg_temp.agent_row('suspended')).status = 'active'
		and v_cursor.last_scheduled_for = date_trunc('milliseconds',statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'A resume after the authorization suspension restarts the schedule at the resume');
end $$;

-- A finite watch that ended after its last permitted run and is extended by a save with
-- unchanged content switches back on at the same version: the Mondays that passed while
-- it was ended are skipped, not run in a burst.
do $$
declare v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '15 days');
	v_request jsonb := '{"action":"upsert","routineKey":"finite","title":"Brief","intent":"Write the brief.",
		"trigger":{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00","timeZone":"Europe/Copenhagen"}}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_routine(v_request || '{"maxOccurrences":1}');
	perform pg_temp.agent_ran('finite',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.wake_assert((pg_temp.agent_row('finite')).status = 'expired','Fixture: the last permitted run ended the watch');
	perform pg_temp.wake_assert(pg_temp.agent_routine(v_request || '{"maxOccurrences":5}') #>> '{routine,status}' = 'active'
		and (pg_temp.agent_row('finite')).current_version = 1,'Fixture: the extension keeps the version');
	v_cursor := pg_temp.agent_cursor('finite');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'An ended routine switched back on after missed slots restarts the schedule');
end $$;

-- A member's save may leave other triggers beside the agent's. The agent's next save with
-- the same timing compares against its own trigger (by id), not the first one, and keeps
-- the exact position.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_row public.qorpera_cloud_routines; v_agent jsonb; v_claims text := current_setting('request.jwt.claims');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('shared','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}');
	v_row := pg_temp.agent_row('shared');
	select triggers -> 0 into v_agent from public.qorpera_cloud_routine_versions where routine_id = v_row.id and version = 1;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_upsert_cloud_routine(v_row.environment_id,v_row.client_routine_id,extensions.gen_random_uuid(),
		v_row.owner_staff_agent_id,'Brief','Write the brief.',jsonb_build_array('{"id":"pulse","kind":"schedule","intervalMinutes":60}'::jsonb,v_agent),
		'medium',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn','agent_turn',true,
		'automatic',null,'{}');
	perform set_config('request.jwt.claims',v_claims,true);
	perform pg_temp.wake_assert((pg_temp.agent_row('shared')).current_version = 2,'Fixture: a member saved two triggers');
	perform pg_temp.agent_ran('shared',v_ran,v_ran + interval '7 days');
	perform pg_temp.agent_save('shared','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}','Write the brief for the board.');
	v_cursor := pg_temp.agent_cursor('shared');
	perform pg_temp.wake_assert(v_cursor.routine_version = 3 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','The agent''s same timing keeps its position beside a member''s trigger');
end $$;

-- A wall-clock trigger's start only holds back its first run. An agent that set a
-- routine up with firstRunAt and saves it again without one, once the routine has run
-- past that start, keeps the exact position. A new start still ahead is a change. An
-- interval trigger's start anchors its grid, so a change to it restarts the schedule.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_start text := to_char((statement_timestamp() - interval '10 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
	v_later text := to_char((statement_timestamp() + interval '5 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
	v_weekly jsonb := '{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00","timeZone":"Europe/Copenhagen"}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('started',v_weekly || jsonb_build_object('startAt',v_start));
	perform pg_temp.agent_ran('started',v_ran,v_ran + interval '7 days');
	perform pg_temp.agent_save('started',v_weekly,'Write the brief for the board.');
	v_cursor := pg_temp.agent_cursor('started');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for = v_ran
		and v_cursor.next_due_at = v_ran + interval '7 days','A wall-clock start already passed is not timing');
	perform pg_temp.agent_save('started',v_weekly || jsonb_build_object('startAt',v_later),'Write the brief for the board.');
	v_cursor := pg_temp.agent_cursor('started');
	perform pg_temp.wake_assert(v_cursor.routine_version = 3
		and v_cursor.last_scheduled_for = date_trunc('milliseconds',pg_temp.agent_effective_at('started'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond','A start still ahead is timing');

	perform pg_temp.agent_save('anchored',jsonb_build_object('kind','schedule','intervalMinutes',60,'startAt',v_start));
	perform pg_temp.agent_ran('anchored',v_ran,v_ran + interval '1 hour');
	perform pg_temp.agent_save('anchored','{"kind":"schedule","intervalMinutes":60}','Write the brief for the board.');
	v_cursor := pg_temp.agent_cursor('anchored');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',pg_temp.agent_effective_at('anchored'))
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'An interval trigger''s start anchors its grid, so dropping it restarts the schedule');
end $$;

-- A member's save follows the same rule (both saves use qorpera_routine_version_schedule_position).
do $$
declare v_client uuid := extensions.gen_random_uuid(); v_claims text := current_setting('request.jwt.claims');
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_start text := to_char((statement_timestamp() - interval '10 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
	v_weekly jsonb := '{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}';
	v_routine uuid; v_ran_id uuid; v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_routine := (public.qorpera_upsert_cloud_routine('30000000-0000-4000-8000-000000000020',v_client,extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-000000000031','Monday brief','Write the brief.',jsonb_build_array(v_weekly || jsonb_build_object('startAt',v_start)),
		'low',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn','agent_turn',true,
		'automatic',null,'{}') ->> 'routine_id')::uuid;
	perform set_config('request.jwt.claims',v_claims,true);
	select * into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_routine and routine_version = 1;
	-- The Monday run, recorded and finished (a run still waiting would be offered again).
	v_ran_id := (public.qorpera_enqueue_routine_wake(v_routine,1,extensions.gen_random_uuid(),'member-start:' || v_routine,'brief',
		v_ran,null,v_ran + interval '7 days','{}') ->> 'occurrence_id')::uuid;
	update public.qorpera_wake_occurrences set status = 'cancelled', blocked_reason = 'Fixture: this slot ran',
		finished_at = statement_timestamp() where id = v_ran_id;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_upsert_cloud_routine('30000000-0000-4000-8000-000000000020',v_client,extensions.gen_random_uuid(),
		'30000000-0000-4000-8000-000000000031','Monday brief','Write the brief.',jsonb_build_array(v_weekly),
		'low',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn','agent_turn',true,
		'automatic',null,'{}');
	perform set_config('request.jwt.claims',v_claims,true);
	select * into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_routine and routine_version = 2;
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_ran + interval '7 days',
		'A member''s save without a start already passed keeps the exact position too');
end $$;

-- What a switch back on must leave alone: an unchanged save of a routine that is already
-- active keeps even an overdue position (that slot is owed), and pausing and resuming a
-- routine that never ran keeps its fresh cursor (and the kickoff it owes).
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 day');
	v_overdue timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '2 hours');
	v_trigger jsonb := '{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00","timeZone":"Europe/Copenhagen"}';
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('active-unchanged',v_trigger);
	perform pg_temp.agent_ran('active-unchanged',v_ran,v_overdue);
	perform pg_temp.wake_assert(pg_temp.agent_save('active-unchanged',v_trigger) #>> '{routine,version}' = '1',
		'Fixture: an unchanged save of an active routine keeps the version');
	v_cursor := pg_temp.agent_cursor('active-unchanged');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_ran and v_cursor.next_due_at = v_overdue,
		'An unchanged save of an active routine keeps its overdue position');

	perform pg_temp.agent_save('fresh-resume',v_trigger);
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"fresh-resume"}');
	perform pg_temp.agent_routine('{"action":"resume","routineKey":"fresh-resume"}');
	v_cursor := pg_temp.agent_cursor('fresh-resume');
	perform pg_temp.wake_assert((pg_temp.agent_row('fresh-resume')).status = 'active' and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'A never-run routine resumed keeps its fresh cursor');
end $$;

rollback;
