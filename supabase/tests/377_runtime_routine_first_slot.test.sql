-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 2026-09-25: a routine waiting for its first slot (a restart position after a
-- save or a resume, or a fresh cursor waiting for a later start or a window) was
-- listed on every scheduler poll with nothing due, and showed no next run until
-- that slot ran. The orchestrator now raises its next due time to the first slot
-- through qorpera_advance_routine_next_due: a compare-and-set on the version,
-- the active status and the exact millisecond position, which never moves the
-- position and creates no occurrence. The routine then leaves the listing until
-- the slot, shows that slot as its next run, and the enqueue at the slot
-- compares the same position as before. The call does not exist on the previous
-- code, and the fresh cursor's next run was empty there.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','first-slot-ack');

-- The agent's routine tool, one operation key per change.
create function pg_temp.agent_routine(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_routine(current_setting('qorpera_test.wake_binding')::jsonb,
		p_request || case when p_request ->> 'action' = 'list' then '{}'::jsonb
			else jsonb_build_object('operationKey','first-slot-' || extensions.gen_random_uuid()) end)
$$;
create function pg_temp.agent_save(p_key text,p_trigger jsonb,p_intent text default 'Watch the orders.')
returns jsonb language sql as $$
	select pg_temp.agent_routine(jsonb_build_object('action','upsert','routineKey',p_key,'title','Watch','intent',p_intent,
		'trigger',p_trigger))
$$;
create function pg_temp.agent_row(p_key text) returns public.qorpera_cloud_routines language sql as $$
	select routine from public.qorpera_cloud_routines routine where routine.routine_key = p_key and routine.origin = 'agent'
$$;
create function pg_temp.agent_cursor(p_key text) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select cursor from public.qorpera_cloud_routine_schedule_cursors cursor
	join public.qorpera_cloud_routines routine on routine.id = cursor.routine_id and routine.current_version = cursor.routine_version
	where routine.routine_key = p_key and routine.origin = 'agent' and cursor.trigger_id = 'agent'
$$;
-- The scheduler records one occurrence the way the orchestrator does; the fixture then
-- closes it as if it had run, so only the cursor tells the next run.
create function pg_temp.agent_ran(p_key text,p_at timestamptz,p_next timestamptz) returns jsonb language plpgsql as $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor(p_key); v_result jsonb;
begin
	v_result := public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
		'first-slot:' || extensions.gen_random_uuid(),'agent',p_at,v_cursor.last_scheduled_for,p_next,'{}');
	update public.qorpera_wake_occurrences set status = 'cancelled', blocked_reason = 'Fixture: this slot ran',
		finished_at = statement_timestamp() where id = (v_result ->> 'occurrence_id')::uuid;
	return v_result;
end
$$;
-- What the scheduler sees: the routine's schedule head, or null when it is not listed.
create function pg_temp.head_of(p_routine uuid) returns jsonb language sql as $$
	select item from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null,500) -> 'items') item
	where item ->> 'routine_id' = p_routine::text
$$;
-- The next run the agent's own list shows.
create function pg_temp.agent_next_run(p_key text) returns timestamptz language sql as $$
	select (routine ->> 'nextRunAt')::timestamptz from jsonb_array_elements(pg_temp.agent_routine('{"action":"list"}') -> 'routines') routine
	where routine ->> 'routineKey' = p_key
$$;
-- The orchestrator's expected position: its Date of the listed value, as an ISO string.
create function pg_temp.read_position(p_head jsonb) returns timestamptz language sql as $$
	select to_char((p_head #>> '{schedule_cursors,0,last_scheduled_for}')::timestamptz at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')::timestamptz
$$;
-- The orchestrator's call, as the edge function passes it on.
create function pg_temp.advance(p_cursor public.qorpera_cloud_routine_schedule_cursors,p_expected timestamptz,p_next timestamptz)
returns jsonb language sql as $$
	select public.qorpera_advance_routine_next_due(p_cursor.routine_id,p_cursor.routine_version,p_cursor.trigger_id,p_expected,p_next)
$$;
create function pg_temp.occurrences(p_routine uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_wake_occurrences where routine_id = p_routine
$$;

-- An every-2-hours watch that ran is loosened to weekly: the agent's save restarts the
-- schedule at the save, one millisecond before it is due.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 hour');
begin
	perform pg_temp.agent_save('loosened','{"kind":"schedule","intervalMinutes":120}');
	perform pg_temp.wake_assert(pg_temp.agent_ran('loosened',v_ran,v_ran + interval '2 hours') ->> 'status' = 'queued',
		'Fixture: the watch ran an hour ago');
	perform pg_temp.agent_save('loosened','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}');
	perform pg_temp.wake_assert((pg_temp.agent_cursor('loosened')).next_due_at
		= (pg_temp.agent_cursor('loosened')).last_scheduled_for + interval '1 millisecond','Fixture: the save restarted the schedule');
end $$;
-- The scheduler's next poll lists it with nothing due; it raises the next due time to the
-- first Monday it computed, against the position it read. The position stays, no
-- occurrence is created, and the routine leaves the listing at once.
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.agent_row('loosened'); v_head jsonb;
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor('loosened');
	v_expected timestamptz; v_first timestamptz; v_before bigint; v_result jsonb;
begin
	v_head := pg_temp.head_of(v_row.id);
	perform pg_temp.wake_assert(v_head is not null and pg_temp.agent_next_run('loosened') is null,
		'A restart position is listed at once and shows no next run');
	v_expected := pg_temp.read_position(v_head);
	v_first := date_trunc('minute',v_expected) + interval '5 days';
	v_before := pg_temp.occurrences(v_row.id);
	v_result := pg_temp.advance(v_cursor,v_expected,v_first);
	perform pg_temp.wake_assert(v_result ->> 'status' = 'advanced' and (v_result ->> 'next_due_at')::timestamptz = v_first,
		'The first slot is set against the millisecond position the orchestrator read');
	v_cursor := pg_temp.agent_cursor('loosened');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = v_expected and v_cursor.next_due_at = v_first
		and pg_temp.occurrences(v_row.id) = v_before,'The raise keeps the position and creates no occurrence');
	perform pg_temp.wake_assert(pg_temp.head_of(v_row.id) is null,'The routine is not listed before its first slot');
	perform pg_temp.wake_assert(pg_temp.agent_next_run('loosened') = v_first,'Its first slot is the next run it shows');

	-- Another orchestrator computed the same slot: nothing changes. A time before the one
	-- set never lowers it.
	v_result := pg_temp.advance(v_cursor,v_expected,v_first);
	perform pg_temp.wake_assert(v_result ->> 'status' = 'unchanged' and (pg_temp.agent_cursor('loosened')).next_due_at = v_first,
		'The same slot twice changes nothing');
	v_result := pg_temp.advance(v_cursor,v_expected,v_first - interval '1 day');
	perform pg_temp.wake_assert(v_result ->> 'status' = 'unchanged' and (v_result ->> 'next_due_at')::timestamptz = v_first
		and (pg_temp.agent_cursor('loosened')).next_due_at = v_first,'A raise never moves the next due time back');

	-- At the slot the enqueue compares the same position as before the raise.
	perform pg_temp.wake_assert(public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,
		extensions.gen_random_uuid(),'first-slot-monday','agent',v_first,v_expected,v_first + interval '7 days','{}')
		->> 'status' = 'queued' and (pg_temp.agent_cursor('loosened')).last_scheduled_for = v_first,
		'The first slot is admitted against the same position');
end $$;

-- Compare-and-set: anything that moved since the orchestrator read the cursor answers
-- 'stale' and changes nothing, so the next poll reads it again.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 hour');
	v_row public.qorpera_cloud_routines; v_cursor public.qorpera_cloud_routine_schedule_cursors; v_old public.qorpera_cloud_routine_schedule_cursors;
	v_first timestamptz; v_result jsonb;
begin
	perform pg_temp.agent_save('raced','{"kind":"schedule","intervalMinutes":60}');
	perform pg_temp.agent_ran('raced',v_ran,v_ran + interval '1 hour');
	v_cursor := pg_temp.agent_cursor('raced');
	v_row := pg_temp.agent_row('raced');
	v_first := v_ran + interval '3 hours';

	-- A position off by a microsecond (or a millisecond) is another position.
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_ran + interval '1 microsecond',v_first) ->> 'status' = 'stale'
		and pg_temp.advance(v_cursor,v_ran - interval '1 millisecond',v_first) ->> 'status' = 'stale'
		and (pg_temp.agent_cursor('raced')).next_due_at = v_ran + interval '1 hour','A different position is stale');
	-- A fresh cursor's call (no position) does not match a cursor that has one.
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,null,v_first) ->> 'status' = 'stale','A missing position is stale');
	-- An occurrence admitted in between moved the position.
	perform pg_temp.agent_ran('raced',v_ran + interval '1 hour',v_ran + interval '2 hours');
	v_result := pg_temp.advance(v_cursor,v_ran,v_first);
	perform pg_temp.wake_assert(v_result ->> 'status' = 'stale'
		and (v_result ->> 'next_due_at')::timestamptz = v_ran + interval '2 hours'
		and (pg_temp.agent_cursor('raced')).next_due_at = v_ran + interval '2 hours','An admitted slot makes the read stale');
	-- A pause.
	v_cursor := pg_temp.agent_cursor('raced');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"raced"}');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_ran + interval '1 hour',v_first) ->> 'status' = 'stale'
		and (pg_temp.agent_cursor('raced')).next_due_at = v_ran + interval '2 hours','A paused routine is stale');
	perform pg_temp.agent_routine('{"action":"resume","routineKey":"raced"}');
	-- A new version: the old version's cursor is no longer the routine's.
	v_old := pg_temp.agent_cursor('raced');
	perform pg_temp.agent_save('raced','{"kind":"schedule","intervalMinutes":60}','Watch the returns too.');
	perform pg_temp.wake_assert((pg_temp.agent_row('raced')).current_version = 2,'Fixture: a new version');
	perform pg_temp.wake_assert(pg_temp.advance(v_old,v_old.last_scheduled_for,v_first) ->> 'status' = 'stale'
		and (select next_due_at from public.qorpera_cloud_routine_schedule_cursors
			where routine_id = v_old.routine_id and routine_version = 1 and trigger_id = 'agent') = v_old.next_due_at,
		'An older version is stale');
	-- Another trigger id, or a routine that does not exist.
	v_cursor := pg_temp.agent_cursor('raced');
	perform pg_temp.wake_assert(public.qorpera_advance_routine_next_due(v_cursor.routine_id,v_cursor.routine_version,'pulse',
		v_cursor.last_scheduled_for,v_first) ->> 'status' = 'stale'
		and public.qorpera_advance_routine_next_due(extensions.gen_random_uuid(),1,'agent',v_cursor.last_scheduled_for,v_first)
			= '{"status":"stale","next_due_at":null}'::jsonb,'An unknown trigger or routine is stale');
end $$;

-- The call is the control plane's, and its times must make sense.
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor('raced');
	v_claims text := current_setting('request.jwt.claims');
begin
	perform pg_temp.wake_error(format('select public.qorpera_advance_routine_next_due(%L,%s,%L,%L,%L)',v_cursor.routine_id,
		v_cursor.routine_version,'agent',v_cursor.last_scheduled_for,v_cursor.last_scheduled_for),'22023','routine next due time is invalid');
	perform pg_temp.wake_error(format('select public.qorpera_advance_routine_next_due(%L,%s,%L,%L,null)',v_cursor.routine_id,
		v_cursor.routine_version,'agent',v_cursor.last_scheduled_for),'22023');
	perform pg_temp.wake_error(format('select public.qorpera_advance_routine_next_due(%L,%s,%L,null,%L)',v_cursor.routine_id,
		v_cursor.routine_version,'agent','infinity'),'22023');
	perform pg_temp.wake_error(format('select public.qorpera_advance_routine_next_due(%L,%s,%L,%L,%L)',v_cursor.routine_id,
		v_cursor.routine_version,E'agent\n',v_cursor.last_scheduled_for,v_cursor.next_due_at + interval '1 day'),'22023');
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform pg_temp.wake_error(format('select public.qorpera_advance_routine_next_due(%L,%s,%L,%L,%L)',v_cursor.routine_id,
		v_cursor.routine_version,'agent',v_cursor.last_scheduled_for,v_cursor.next_due_at + interval '1 day'),'42501');
	perform set_config('request.jwt.claims',v_claims,true);
	perform pg_temp.wake_assert(not has_function_privilege('authenticated',
		'public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)','execute')
		and not has_function_privilege('anon','public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)','execute')
		and has_function_privilege('service_role','public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)','execute'),
		'Only the service role may call it');
end $$;

-- A raised restart position is a slot still ahead: a pause and a resume before it keep
-- it (#320's resume rule), and a same-timing save carries it.
do $$
declare v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '1 hour');
	v_cursor public.qorpera_cloud_routine_schedule_cursors; v_first timestamptz;
begin
	perform pg_temp.agent_save('kept','{"kind":"schedule","intervalMinutes":120}');
	perform pg_temp.agent_ran('kept',v_ran,v_ran + interval '2 hours');
	perform pg_temp.agent_save('kept','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}');
	v_cursor := pg_temp.agent_cursor('kept');
	v_first := date_trunc('minute',v_cursor.last_scheduled_for) + interval '4 days';
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_cursor.last_scheduled_for,v_first) ->> 'status' = 'advanced',
		'Fixture: the scheduler raised the restart position');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"kept"}');
	perform pg_temp.agent_routine('{"action":"resume","routineKey":"kept"}');
	perform pg_temp.wake_assert((pg_temp.agent_cursor('kept')).last_scheduled_for = v_cursor.last_scheduled_for
		and (pg_temp.agent_cursor('kept')).next_due_at = v_first,'A resume before the raised slot keeps it');
	perform pg_temp.agent_save('kept','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen","replyPolicy":"silent"}','Watch the orders quietly.');
	perform pg_temp.wake_assert((pg_temp.agent_cursor('kept')).routine_version = 3
		and (pg_temp.agent_cursor('kept')).last_scheduled_for = v_cursor.last_scheduled_for
		and (pg_temp.agent_cursor('kept')).next_due_at = v_first,'A same-timing save carries the raised slot');
end $$;

-- A fresh cursor waiting for a later start: the scheduler raises it without a position.
-- It stays fresh (it never ran), shows its first slot, and leaves the listing.
do $$
declare v_start timestamptz := date_trunc('hour',statement_timestamp()) + interval '3 days';
	v_row public.qorpera_cloud_routines;
begin
	perform pg_temp.agent_save('later',jsonb_build_object('kind','schedule','intervalMinutes',1440,'weekdays',
		'["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]'::jsonb,'localTime','08:00','timeZone','UTC',
		'startAt',to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.000"Z"')));
	v_row := pg_temp.agent_row('later');
	perform pg_temp.wake_assert((pg_temp.agent_cursor('later')).last_scheduled_for is null
		and (pg_temp.agent_cursor('later')).next_due_at = '-infinity'::timestamptz
		and pg_temp.head_of(v_row.id) #>> '{schedule_cursors,0,last_scheduled_for}' is null
		and pg_temp.agent_next_run('later') is null,'Fixture: a fresh cursor is listed and shows no next run');
end $$;
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.agent_row('later');
	v_cursor public.qorpera_cloud_routine_schedule_cursors := pg_temp.agent_cursor('later');
	v_first timestamptz := date_trunc('day',statement_timestamp()) + interval '4 days 8 hours'; v_result jsonb;
begin
	v_result := pg_temp.advance(v_cursor,null,v_first);
	perform pg_temp.wake_assert(v_result ->> 'status' = 'advanced' and pg_temp.occurrences(v_row.id) = 0,
		'A fresh cursor is raised without a position and nothing runs');
	v_cursor := pg_temp.agent_cursor('later');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for is null and v_cursor.next_due_at = v_first
		and pg_temp.head_of(v_row.id) is null and pg_temp.agent_next_run('later') = v_first,
		'It stays fresh, leaves the listing and shows its first slot');
	-- A read with a position is not this cursor.
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_first - interval '1 day',v_first + interval '1 day') ->> 'status' = 'stale',
		'A position does not match a fresh cursor');
	-- A changed intent is a new version: the cursor that never ran stays fresh (#320), so the
	-- raise does not turn into a position and the scheduler raises the new one again.
	perform pg_temp.agent_save('later',(select (triggers -> 0) - 'id' from public.qorpera_cloud_routine_versions
		where routine_id = v_row.id and version = 1),'Watch the orders and the returns.');
	v_cursor := pg_temp.agent_cursor('later');
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.last_scheduled_for is null
		and v_cursor.next_due_at = '-infinity'::timestamptz,'A new version of a never-run routine starts fresh again');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,null,v_first) ->> 'status' = 'advanced'
		and public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
			'first-slot-later','agent',v_first,null,v_first + interval '1 day','{}') ->> 'status' = 'queued'
		and (pg_temp.agent_cursor('later')).last_scheduled_for = v_first,
		'At its first slot the fresh cursor is admitted as before, without a position');
end $$;

-- A fresh cursor that may still owe its kickoff is never raised: no start, or a start
-- already reached when the version was saved. The call refuses it, so a kickoff is not
-- postponed even if an orchestrator asked.
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('owes-kickoff','{"kind":"schedule","intervalMinutes":60}');
	v_cursor := pg_temp.agent_cursor('owes-kickoff');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,null,date_trunc('hour',statement_timestamp()) + interval '1 hour')
		->> 'status' = 'stale' and (pg_temp.agent_cursor('owes-kickoff')).next_due_at = '-infinity'::timestamptz,
		'A fresh cursor without a later start keeps its kickoff');
	perform pg_temp.agent_save('start-reached',jsonb_build_object('kind','schedule','intervalMinutes',60,'startAt',
		to_char((statement_timestamp() - interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:00:00.000"Z"')));
	v_cursor := pg_temp.agent_cursor('start-reached');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,null,date_trunc('hour',statement_timestamp()) + interval '1 hour')
		->> 'status' = 'stale' and (pg_temp.agent_cursor('start-reached')).next_due_at = '-infinity'::timestamptz,
		'A fresh cursor whose start was reached at the save keeps its kickoff');
end $$;

-- A raised slot that passed is due again: the routine is listed, and a resume after it
-- restarts the schedule at the resume (#320), so nothing is caught up.
do $$
declare v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_save('passed','{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}');
	-- A restart position three days ago, raised to a slot one day later (both passed).
	perform pg_temp.agent_ran('passed',v_long_ago,v_long_ago + interval '1 millisecond');
	v_cursor := pg_temp.agent_cursor('passed');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_long_ago,v_long_ago + interval '1 day') ->> 'status' = 'advanced',
		'Fixture: the scheduler raised the restart position to a slot that has passed');
end $$;
do $$
declare v_row public.qorpera_cloud_routines := pg_temp.agent_row('passed'); v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.wake_assert(pg_temp.head_of(v_row.id) is not null,'A raised slot that passed is listed again');
	perform pg_temp.agent_routine('{"action":"pause","routineKey":"passed"}');
	perform pg_temp.agent_routine('{"action":"resume","routineKey":"passed"}');
	v_cursor := pg_temp.agent_cursor('passed');
	perform pg_temp.wake_assert(v_cursor.last_scheduled_for = date_trunc('milliseconds',statement_timestamp())
		and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond',
		'A resume after the raised slot passed restarts the schedule at the resume');
end $$;

-- An ended routine is not raised.
do $$
declare v_long_ago timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '15 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.agent_routine('{"action":"upsert","routineKey":"ended","title":"Watch","intent":"Watch the orders.",
		"maxOccurrences":1,"trigger":{"kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],"localTime":"08:00",
		"timeZone":"Europe/Copenhagen"}}');
	perform pg_temp.agent_ran('ended',v_long_ago,v_long_ago + interval '7 days');
	perform pg_temp.wake_assert((pg_temp.agent_row('ended')).status = 'expired','Fixture: the last permitted run ended the watch');
	v_cursor := pg_temp.agent_cursor('ended');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_long_ago,v_long_ago + interval '14 days') ->> 'status' = 'stale'
		and (pg_temp.agent_cursor('ended')).next_due_at = v_long_ago + interval '7 days','An ended routine is stale');
end $$;

-- A member's save restarts the same way (#317), and a member sees the raised slot.
create function pg_temp.member_save(p_client uuid,p_triggers jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb; v_claims text := current_setting('request.jwt.claims');
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	v_result := public.qorpera_upsert_cloud_routine('30000000-0000-4000-8000-000000000020',p_client,
		extensions.gen_random_uuid(),'30000000-0000-4000-8000-000000000031','Brief','Write the brief.',p_triggers,
		'low',(current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid,1,null,'agent_turn',
		'agent_turn',true,'automatic',null,'{}');
	perform set_config('request.jwt.claims',v_claims,true);
	return v_result;
end
$$;
create function pg_temp.member_cursor(p_client uuid) returns public.qorpera_cloud_routine_schedule_cursors language sql as $$
	select cursor from public.qorpera_cloud_routine_schedule_cursors cursor
	join public.qorpera_cloud_routines routine on routine.id = cursor.routine_id and routine.current_version = cursor.routine_version
	where routine.client_routine_id = p_client and cursor.trigger_id = 'brief'
$$;
create function pg_temp.member_next_run(p_client uuid) returns timestamptz language plpgsql as $$
declare v_claims text := current_setting('request.jwt.claims'); v_next timestamptz;
begin
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	select (routine ->> 'next_run_at')::timestamptz into v_next
	from jsonb_array_elements(public.qorpera_list_cloud_routines('30000000-0000-4000-8000-000000000020')) routine
	where (routine ->> 'client_routine_id')::uuid = p_client;
	perform set_config('request.jwt.claims',v_claims,true);
	return v_next;
end
$$;
do $$
declare v_client uuid := '37700000-0000-4000-8000-000000000001';
	v_ran timestamptz := date_trunc('milliseconds',statement_timestamp() - interval '3 days');
	v_cursor public.qorpera_cloud_routine_schedule_cursors;
begin
	perform pg_temp.member_save(v_client,'[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["monday"],
		"localTime":"08:30","timeZone":"Europe/Copenhagen"}]');
	v_cursor := pg_temp.member_cursor(v_client);
	perform public.qorpera_enqueue_routine_wake(v_cursor.routine_id,v_cursor.routine_version,extensions.gen_random_uuid(),
		'first-slot-member','brief',v_ran,null,v_ran + interval '7 days','{}');
	perform pg_temp.member_save(v_client,'[{"id":"brief","kind":"schedule","intervalMinutes":1440,"weekdays":["tuesday"],
		"localTime":"08:30","timeZone":"Europe/Copenhagen"}]');
	v_cursor := pg_temp.member_cursor(v_client);
	perform pg_temp.wake_assert(v_cursor.routine_version = 2 and v_cursor.next_due_at = v_cursor.last_scheduled_for + interval '1 millisecond'
		and pg_temp.member_next_run(v_client) is null,'Fixture: the member''s changed timing restarted the schedule');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,v_cursor.last_scheduled_for,
		date_trunc('minute',v_cursor.last_scheduled_for) + interval '6 days') ->> 'status' = 'advanced'
		and pg_temp.member_next_run(v_client) = date_trunc('minute',v_cursor.last_scheduled_for) + interval '6 days',
		'The member sees the first slot the scheduler set');

	-- A window bounds the run times, so a fresh window cursor owes no kickoff and is raised.
	perform pg_temp.member_save('37700000-0000-4000-8000-000000000002','[{"id":"brief","kind":"schedule","intervalMinutes":30,
		"weekdays":["monday","tuesday","wednesday","thursday","friday"],"windowStart":"09:00","windowEnd":"10:00","timeZone":"UTC"}]');
	v_cursor := pg_temp.member_cursor('37700000-0000-4000-8000-000000000002');
	perform pg_temp.wake_assert(pg_temp.advance(v_cursor,null,date_trunc('day',statement_timestamp()) + interval '1 day 9 hours')
		->> 'status' = 'advanced' and (pg_temp.member_cursor('37700000-0000-4000-8000-000000000002')).last_scheduled_for is null
		and pg_temp.member_next_run('37700000-0000-4000-8000-000000000002') = date_trunc('day',statement_timestamp()) + interval '1 day 9 hours',
		'A fresh window cursor is raised to its first slot and shows it');
end $$;

rollback;
