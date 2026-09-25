-- Review of #316, 2026-09-25: a member's save ran the routine at once.
--
-- qorpera_upsert_cloud_routine gave every new version a fresh schedule cursor,
-- and the scheduler kicks off a fresh cursor at the version's effective time
-- unless its trigger names a later start. So renaming a Monday 08:30 brief on
-- a Thursday ran it that Thursday, and pausing and resuming a routine re-ran it
-- even when it had already run that day. An agent's own save
-- (qorpera_manage_agent_routine) already carried the cursor forward. A member's
-- save now does too, per schedule trigger id:
--
-- * A trigger id the current version has no schedule trigger for starts fresh,
--   as before: a new schedule gets its kickoff.
-- * A cursor that never scheduled anything, or whose kickoff is still waiting
--   to become a run, stays fresh, so a kickoff the routine still owes is not
--   lost (it runs at the new version's effective time unless the trigger names
--   a later start).
-- * The same timing keeps the exact position, like the agent path: the next
--   run is the one already due, on the same cadence. This holds while the
--   routine is active, and for a paused or ended routine whose next slot is
--   still ahead. The same timing means the trigger is unchanged apart from its
--   reply policy, the order of its weekdays or months, and an interval that a
--   wall-clock trigger does not use.
-- * A run still waiting for its start (an occurrence not yet a run, held by
--   quiet hours or admission) is refused once a newer version exists. With the
--   same timing its slot is offered again to the new version, so the edit
--   applies to that run instead of losing it (only slots after the last one
--   that became a run; a slot counts once toward a finite routine's limit).
--   Known limit: a waiting run that an edit replaces (a waiting kickoff moving
--   to the new version, or changed timing) still counts toward a finite
--   routine's limit, so such a routine can end one run early.
-- * Changed timing under the same id (time, weekdays, time zone, interval,
--   start) restarts the schedule at the save: nothing runs at once and nothing
--   is caught up; the first run is the new schedule's first slot after the
--   save. A waiting run of the old schedule is replaced by the new schedule.
--   Carrying the old position instead would make the scheduler replay every
--   slot of the new cadence since the last run, one run each (weekly to daily
--   on a Thursday = three runs at once), and the old next-due time would hide
--   a faster cadence until the old slot came round.
-- * A save of a paused or ended routine whose next slot has passed (typically
--   switching it back on) restarts the same way: the slots it missed while it
--   was off are skipped, not run in a burst.
--
-- A routine switched back on without a new version (an agent's resume, also
-- after the authorization-failure suspension, or an agent save whose content is
-- unchanged) restarts its cursor in place the same way once its next slot has
-- passed. A member's pause keeps the position, so without this an agent's
-- resume after it would replay every slot the pause skipped. (PR #320 adds the
-- same trigger for the agent path and skips it when it exists.)
--
-- The restart position is the effective time truncated to the millisecond,
-- with next_due_at one millisecond later so the scheduler lists the routine at
-- its next poll and computes the first slot after it. The orchestrator reads
-- the cursor into a JavaScript Date and sends it back as the expected position,
-- which the enqueue compares exactly, so a microsecond value would refuse every
-- later occurrence. A restart never moves the position behind the one the
-- routine already reached. A restart position is not a run time, so
-- qorpera_routine_next_run_at (v114, when present) does not show it.

create function pg_temp.member_cursor_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Member routine cursor patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- What a schedule trigger's timing is, and where a new version's cursor stands
-- ---------------------------------------------------------------------------
-- The fields the scheduler reads for the trigger's shape: no reply policy, days
-- and months as sets, and no interval on a wall-clock (localTime) trigger.
create function public.qorpera_routine_schedule_timing(p_trigger jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select (p_trigger - (array['replyPolicy', 'weekdays', 'months']
			|| case when p_trigger ? 'localTime' then array['intervalMinutes'] else '{}'::text[] end))
		|| jsonb_build_object(
			'weekdays', (select jsonb_agg(day order by day) from jsonb_array_elements_text(p_trigger -> 'weekdays') as day),
			'months', (select jsonb_agg(month order by month) from jsonb_array_elements_text(p_trigger -> 'months') as month))
$$;

-- The cursor a schedule trigger takes in a new version of a routine whose
-- current version is p_version (the rules are in the header above).
create function public.qorpera_routine_version_schedule_position(
	p_routine_id uuid, p_version bigint, p_trigger jsonb, p_effective_at timestamptz,
	p_was_active boolean, p_stays_active boolean,
	out last_scheduled_for timestamptz, out next_due_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
	v_earlier jsonb; v_version_at timestamptz; v_waiting timestamptz;
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype; v_same boolean;
begin
	next_due_at := '-infinity';
	select trigger.value, version.created_at into v_earlier, v_version_at
	from public.qorpera_cloud_routine_versions version
	cross join lateral jsonb_array_elements(version.triggers) as trigger(value)
	where version.routine_id = p_routine_id and version.version = p_version
		and trigger.value ->> 'kind' = 'schedule' and trigger.value ->> 'id' = p_trigger ->> 'id';
	select cursor.* into v_cursor from public.qorpera_cloud_routine_schedule_cursors cursor
	where cursor.routine_id = p_routine_id and cursor.routine_version = p_version
		and cursor.trigger_id = p_trigger ->> 'id';
	if v_earlier is null or v_cursor.last_scheduled_for is null or exists (
		select 1 from public.qorpera_wake_occurrences occurrence
		where occurrence.routine_id = p_routine_id and occurrence.routine_version = p_version
			and occurrence.trigger_id = p_trigger ->> 'id' and occurrence.status = 'queued'
			and occurrence.scheduled_for = date_trunc('milliseconds', v_version_at)) then
		return;
	end if;
	v_same := public.qorpera_routine_schedule_timing(v_earlier) = public.qorpera_routine_schedule_timing(p_trigger);
	if v_same and p_was_active and p_stays_active then
		-- Only slots after the last one that became a run: a stale slot that waited
		-- while a later one ran is not run again.
		select min(occurrence.scheduled_for) into v_waiting from public.qorpera_wake_occurrences occurrence
		where occurrence.routine_id = p_routine_id and occurrence.routine_version = p_version
			and occurrence.trigger_id = p_trigger ->> 'id' and occurrence.status = 'queued'
			and occurrence.scheduled_for > coalesce((select max(handed.scheduled_for)
				from public.qorpera_wake_occurrences handed
				where handed.routine_id = p_routine_id and handed.routine_version = p_version
					and handed.trigger_id = p_trigger ->> 'id' and handed.run_id is not null), '-infinity'::timestamptz);
		if v_waiting is not null then
			last_scheduled_for := v_waiting - interval '1 millisecond';
			next_due_at := v_waiting;
			return;
		end if;
	end if;
	if v_same and (p_was_active or v_cursor.next_due_at > p_effective_at) then
		last_scheduled_for := v_cursor.last_scheduled_for;
		next_due_at := v_cursor.next_due_at;
		return;
	end if;
	last_scheduled_for := greatest(v_cursor.last_scheduled_for, date_trunc('milliseconds', p_effective_at));
	next_due_at := last_scheduled_for + interval '1 millisecond';
end
$$;
-- Internal only: the member save calls them. PostgreSQL grants new functions to PUBLIC.
revoke all on function public.qorpera_routine_schedule_timing(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_routine_version_schedule_position(uuid, bigint, jsonb, timestamptz, boolean, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- ---------------------------------------------------------------------------
-- The member save
-- ---------------------------------------------------------------------------
select pg_temp.member_cursor_patch(
	'public.qorpera_upsert_cloud_routine(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid,bigint,uuid,text,text,boolean,text,text,uuid[])'::regprocedure,
	$old$	insert into public.qorpera_cloud_routine_schedule_cursors (
		routine_id, routine_version, trigger_id
	)
	select v_routine.id, v_next_version, trigger.value ->> 'id'
	from jsonb_array_elements(p_triggers) as trigger(value)
	where trigger.value ->> 'kind' = 'schedule';$old$,
	$new$	-- Each schedule trigger keeps the position its routine reached (migration
	-- runtime_member_routine_cursor). v_routine is still the row before this save.
	insert into public.qorpera_cloud_routine_schedule_cursors (
		routine_id, routine_version, trigger_id, last_scheduled_for, next_due_at
	)
	select v_routine.id, v_next_version, trigger.value ->> 'id', position.last_scheduled_for, position.next_due_at
	from jsonb_array_elements(p_triggers) as trigger(value)
	cross join lateral public.qorpera_routine_version_schedule_position(v_routine.id, v_routine.current_version,
		trigger.value, v_version.created_at, v_routine.status = 'active', p_enabled) as position
	where trigger.value ->> 'kind' = 'schedule';$new$);

-- ---------------------------------------------------------------------------
-- A slot offered again counts once toward a finite routine's limit
-- ---------------------------------------------------------------------------
-- The old version's refused occurrence and the new version's occurrence of the
-- same slot are two rows. max_occurrences counts slots, so each schedule slot
-- (trigger and instant) and each file event counts once; otherwise an edit
-- while a run waits would expire a finite routine one run early.
create function public.qorpera_routine_occurrence_count(p_routine_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
	select count(distinct (wake.trigger_id, coalesce(wake.file_event_id::text, ''), wake.scheduled_for))
	from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine_id
$$;
revoke all on function public.qorpera_routine_occurrence_count(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
select pg_temp.member_cursor_patch('public.qorpera_routine_occurrence_lifecycle()'::regprocedure,
	$old$	if v_routine.max_occurrences is not null and (select count(*) from public.qorpera_wake_occurrences wake
		where wake.routine_id = new.routine_id) >= v_routine.max_occurrences then$old$,
	$new$	if v_routine.max_occurrences is not null
		and public.qorpera_routine_occurrence_count(new.routine_id) >= v_routine.max_occurrences then$new$);
select pg_temp.member_cursor_patch('public.qorpera_routine_occurrence_recorded()'::regprocedure,
	$old$			and (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = routine.id)
				>= routine.max_occurrences;$old$,
	$new$			and public.qorpera_routine_occurrence_count(routine.id) >= routine.max_occurrences;$new$);
-- What an agent sees beside maxOccurrences counts the same way (v114 keeps this
-- expression when it extends the view).
select pg_temp.member_cursor_patch('public.qorpera_agent_routine_view(public.qorpera_cloud_routines)'::regprocedure,
	$old$'occurrences', (select count(*) from public.qorpera_wake_occurrences wake where wake.routine_id = p_routine.id)$old$,
	$new$'occurrences', public.qorpera_routine_occurrence_count(p_routine.id)$new$);

-- ---------------------------------------------------------------------------
-- Switched back on at the same version: restart once the next slot passed
-- ---------------------------------------------------------------------------
-- Every path that switches a routine back on without a new version lands here:
-- the agent's resume (including after the authorization-failure suspension)
-- and an agent save whose content is unchanged. A new version decides its own
-- cursor (above, or in the agent save), so a change of version is not this
-- trigger's case. The cursor moves in place: the scheduler reads it fresh on
-- every poll, and an occurrence offered against the old position is refused
-- by the enqueue's exact compare and offered again from the new one.
create function public.qorpera_routine_resume_restarts_schedule()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz := date_trunc('milliseconds', statement_timestamp());
begin
	update public.qorpera_cloud_routine_schedule_cursors cursor
	set last_scheduled_for = greatest(cursor.last_scheduled_for, v_at),
		next_due_at = greatest(cursor.last_scheduled_for, v_at) + interval '1 millisecond',
		updated_at = statement_timestamp()
	where cursor.routine_id = new.id and cursor.routine_version = new.current_version
		and cursor.last_scheduled_for is not null and cursor.next_due_at <= statement_timestamp();
	return null;
end
$$;
create trigger qorpera_cloud_routine_resume_restarts_schedule after update of status on public.qorpera_cloud_routines
	for each row when (old.status is distinct from 'active' and new.status = 'active'
		and new.current_version = old.current_version)
	execute function public.qorpera_routine_resume_restarts_schedule();
-- Internal only: the trigger calls it.
revoke all on function public.qorpera_routine_resume_restarts_schedule()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- ---------------------------------------------------------------------------
-- The next run shown to agents and members (v114, when present)
-- ---------------------------------------------------------------------------
-- A restart position (next_due_at one millisecond after the position) only
-- tells the scheduler to compute the first slot after it; it is not a run time.
-- qorpera_routine_next_run_at arrives with v114 (#314), which merges first;
-- PR #320 checks for this same predicate and then leaves the function alone.
do $$
begin
	if to_regprocedure('public.qorpera_routine_next_run_at(uuid)') is null then
		raise notice 'qorpera_routine_next_run_at is absent (v114 not applied): nothing to patch';
		return;
	end if;
	if pg_get_functiondef(to_regprocedure('public.qorpera_routine_next_run_at(uuid)'))
		like '%cursor.last_scheduled_for + interval ''1 millisecond''%' then
		return;
	end if;
	perform pg_temp.member_cursor_patch('public.qorpera_routine_next_run_at(uuid)'::regprocedure,
		$old$				and cursor.last_scheduled_for is not null and cursor.next_due_at > '-infinity'::timestamptz),$old$,
		$new$				and cursor.last_scheduled_for is not null and cursor.next_due_at > '-infinity'::timestamptz
				-- A restart position is not a run time (migration runtime_member_routine_cursor).
				and cursor.next_due_at <> cursor.last_scheduled_for + interval '1 millisecond'),$new$);
end
$$;
