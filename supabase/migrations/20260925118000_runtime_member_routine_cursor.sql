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
-- * A cursor that never scheduled anything stays fresh, so a kickoff the
--   routine still owes is not lost (it runs at the new version's effective
--   time unless the trigger names a later start).
-- * The same timing (the trigger is unchanged apart from replyPolicy and the
--   order of its weekdays or months) keeps the exact position, like the agent
--   path: the next run is the one already due, on the same cadence. This holds
--   while the routine is active, and for a paused or ended routine whose next
--   slot is still ahead.
-- * Changed timing under the same id (time, weekdays, time zone, interval,
--   start) restarts the schedule at the save: nothing runs at once and nothing
--   is caught up; the first run is the new schedule's first slot after the
--   save. Carrying the old position instead would make the scheduler replay
--   every slot of the new cadence since the last run, one run each (weekly to
--   daily on a Thursday = three runs at once), and the old next-due time would
--   hide a faster cadence until the old slot came round.
-- * A save of a paused or ended routine whose next slot has passed (typically
--   switching it back on) restarts the same way: the slots it missed while it
--   was off are skipped, not run in a burst.
--
-- The restart position is the save's effective time truncated to the
-- millisecond. The orchestrator reads the cursor into a JavaScript Date and
-- sends it back as the expected position, which the enqueue compares exactly,
-- so a microsecond value would refuse every later occurrence. The position
-- never moves behind the one the routine already reached.

create function pg_temp.member_cursor_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Member routine cursor patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

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
	select v_routine.id, v_next_version, trigger.value ->> 'id',
		case when previous.keeps then previous.last_scheduled_for else previous.restart end,
		case when previous.keeps then previous.next_due_at
			else coalesce(previous.restart + interval '1 millisecond', '-infinity'::timestamptz) end
	from jsonb_array_elements(p_triggers) as trigger(value)
	left join lateral (
		select earlier_cursor.last_scheduled_for is not null
				-- The same timing: equal apart from the reply policy and the order of days or months.
				and (earlier.value - array['replyPolicy', 'weekdays', 'months'])
					= (trigger.value - array['replyPolicy', 'weekdays', 'months'])
				and array(select day from jsonb_array_elements_text(earlier.value -> 'weekdays') as day order by day)
					= array(select day from jsonb_array_elements_text(trigger.value -> 'weekdays') as day order by day)
				and array(select month from jsonb_array_elements_text(earlier.value -> 'months') as month order by month)
					= array(select month from jsonb_array_elements_text(trigger.value -> 'months') as month order by month)
				and (v_routine.status = 'active' or earlier_cursor.next_due_at > v_version.created_at) as keeps,
			earlier_cursor.last_scheduled_for, earlier_cursor.next_due_at,
			case when earlier_cursor.last_scheduled_for is not null then greatest(
				earlier_cursor.last_scheduled_for, date_trunc('milliseconds', v_version.created_at)) end as restart
		from public.qorpera_cloud_routine_versions as earlier_version
		cross join lateral jsonb_array_elements(earlier_version.triggers) as earlier(value)
		join public.qorpera_cloud_routine_schedule_cursors as earlier_cursor
			on earlier_cursor.routine_id = earlier_version.routine_id
				and earlier_cursor.routine_version = earlier_version.version
				and earlier_cursor.trigger_id = earlier.value ->> 'id'
		where earlier_version.routine_id = v_routine.id and earlier_version.version = v_routine.current_version
			and earlier.value ->> 'kind' = 'schedule' and earlier.value ->> 'id' = trigger.value ->> 'id'
	) as previous on true
	where trigger.value ->> 'kind' = 'schedule';$new$);
