-- 2026-09-25, found while building the member-save fix (#317): an agent's
-- changed timing, or an agent's resume, ran a routine in a burst.
--
-- qorpera_manage_agent_routine carried the schedule cursor of the previous
-- version forward unconditionally, even when the agent changed the trigger's
-- timing. The scheduler lists a routine only once its cursor's next_due_at has
-- passed, and then replays every slot of the current cadence since the last
-- run, one run each (up to 32; more are coalesced into one). A weekly Monday
-- 08:00 routine that ran on Monday and became daily 08:00 on Thursday ran
-- nothing until the next Monday and then seven times at once. The agent's
-- resume (also the way out of the authorization-failure suspension) only
-- switched the status back, so a routine paused for N slots replayed them all.
--
-- The agent path now follows the member path's rule (#317), per schedule
-- trigger:
--
-- * A cursor that never scheduled anything, or a trigger that becomes a
--   schedule (the previous version had a listener or a dynamic run), starts
--   fresh, so a kickoff the routine still owes is not lost.
-- * The same timing (the trigger unchanged apart from replyPolicy and the order
--   of its weekdays or months) keeps the exact position while the routine is
--   active, and for a paused or ended routine whose next slot is still ahead.
-- * Changed timing restarts the schedule at the save: nothing runs at once and
--   nothing is caught up; the first run is the new schedule's first slot after
--   the save. So does a save of a paused or ended routine whose next slot has
--   passed (switching it back on skips the slots it missed while it was off).
-- * A routine switched back on without a new version (the agent's resume, or
--   a save whose content is unchanged) moves its cursor the same way: kept
--   while its next slot is ahead, restarted at the resume once it has passed.
--   The cursor moves in place because the version stays; the scheduler reads
--   the cursor fresh on every poll and the enqueue compares the position it
--   read exactly, so an occurrence offered against the old position is refused
--   and offered again from the new one.
--
-- The restart position is the effective time (the new version's created_at,
-- or the resume) truncated to the millisecond, never behind the position the
-- routine already reached, with next_due_at one millisecond later so the
-- scheduler lists the routine at its next poll and computes the first slot
-- after it. The orchestrator reads the cursor into a JavaScript Date and sends
-- it back as the expected position, which qorpera_enqueue_routine_wake compares
-- exactly: a microsecond position would refuse every later occurrence.
--
-- A restart position is not a run time, so qorpera_routine_next_run_at (what an
-- agent and a member see as the next run) skips it instead of showing a time
-- in the past.

create function pg_temp.agent_cursor_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Agent routine cursor patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- A new version: keep, restart or start fresh
-- ---------------------------------------------------------------------------
select pg_temp.agent_cursor_patch('public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure,
	$old$			-- A new version keeps the schedule position its routine already reached, so an
			-- edit neither re-runs the routine at once nor loses the kickoff a never-run
			-- routine still owes (the scheduler kicks off any version with a fresh cursor).
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id,
				last_scheduled_for, next_due_at)
			select v_routine.id, v_next, 'agent', previous.last_scheduled_for, coalesce(previous.next_due_at, '-infinity'::timestamptz)
			from (select 1) once
			left join public.qorpera_cloud_routine_schedule_cursors previous
				on previous.routine_id = v_routine.id and previous.routine_version = v_routine.current_version
				and previous.trigger_id = 'agent' and previous.last_scheduled_for is not null
			where v_trigger ->> 'kind' = 'schedule';$old$,
	$new$			-- A new version keeps the schedule position its routine reached while the timing
			-- is the same, restarts it at the save when the timing changed or the routine is
			-- switched back on after its next slot passed, and keeps a never-run cursor fresh
			-- so the kickoff it owes is not lost (migration runtime_agent_routine_cursor).
			-- v_routine and v_version are still the routine and version before this save.
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id,
				last_scheduled_for, next_due_at)
			select v_routine.id, v_next, 'agent',
				case when previous.keeps then previous.last_scheduled_for else previous.restart end,
				case when previous.keeps then previous.next_due_at
					else coalesce(previous.restart + interval '1 millisecond', '-infinity'::timestamptz) end
			from public.qorpera_cloud_routine_versions saved
			left join lateral (
				-- The same timing: equal apart from the reply policy and the order of days or months.
				select (earlier_trigger.value - array['replyPolicy', 'weekdays', 'months'])
						= (v_trigger - array['replyPolicy', 'weekdays', 'months'])
					and array(select day from jsonb_array_elements_text(earlier_trigger.value -> 'weekdays') as day order by day)
						= array(select day from jsonb_array_elements_text(v_trigger -> 'weekdays') as day order by day)
					and array(select month from jsonb_array_elements_text(earlier_trigger.value -> 'months') as month order by month)
						= array(select month from jsonb_array_elements_text(v_trigger -> 'months') as month order by month)
					and (v_routine.status = 'active' or earlier.next_due_at > saved.created_at) as keeps,
					earlier.last_scheduled_for, earlier.next_due_at,
					greatest(earlier.last_scheduled_for, date_trunc('milliseconds', saved.created_at)) as restart
				from public.qorpera_cloud_routine_schedule_cursors earlier
				-- The previous trigger by its id: a member's save may have left others beside it.
				join jsonb_array_elements(v_version.triggers) as earlier_trigger(value)
					on earlier_trigger.value ->> 'id' = earlier.trigger_id and earlier_trigger.value ->> 'kind' = 'schedule'
				where earlier.routine_id = v_routine.id and earlier.routine_version = v_routine.current_version
					and earlier.trigger_id = 'agent' and earlier.last_scheduled_for is not null
			) as previous on true
			where saved.routine_id = v_routine.id and saved.version = v_next and v_trigger ->> 'kind' = 'schedule';$new$);

-- ---------------------------------------------------------------------------
-- Switched back on at the same version: restart once the next slot passed
-- ---------------------------------------------------------------------------
-- Every path that switches a routine back on without a new version lands here,
-- for any routine: today the agent's resume (including after the
-- authorization-failure suspension) and an agent save whose content is unchanged
-- (which re-activates a paused or ended routine). A new version decides its own
-- cursor above (or in the member save), so a change of version is not this
-- trigger's case.
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
-- Internal only: the trigger calls it. PostgreSQL grants new functions to PUBLIC.
revoke all on function public.qorpera_routine_resume_restarts_schedule()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- ---------------------------------------------------------------------------
-- The next run shown to agents and members
-- ---------------------------------------------------------------------------
-- A restart position (next_due_at one millisecond after the position) only
-- tells the scheduler to compute the first slot after it; it is not a run time.
-- The member save (#317) restarts the same way and its re-cut may already have
-- made this function skip it (a predicate on last_scheduled_for + 1 ms); then
-- there is nothing to change here. Test 374 checks the behaviour either way.
do $$
begin
	if pg_get_functiondef('public.qorpera_routine_next_run_at(uuid)'::regprocedure)
		like '%cursor.last_scheduled_for + interval ''1 millisecond''%' then
		raise notice 'qorpera_routine_next_run_at already skips a restart position';
		return;
	end if;
	perform pg_temp.agent_cursor_patch('public.qorpera_routine_next_run_at(uuid)'::regprocedure,
		$old$				and cursor.last_scheduled_for is not null and cursor.next_due_at > '-infinity'::timestamptz),$old$,
		$new$				and cursor.last_scheduled_for is not null and cursor.next_due_at > '-infinity'::timestamptz
				-- A restart position is not a run time (migration runtime_agent_routine_cursor).
				and cursor.next_due_at <> cursor.last_scheduled_for + interval '1 millisecond'),$new$);
end
$$;
