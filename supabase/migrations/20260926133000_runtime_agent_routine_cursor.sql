-- 2026-09-25, found while building the member-save fix (#317): an agent's
-- changed timing, or an agent's resume, ran a routine in a burst.
--
-- qorpera_manage_agent_routine carried the schedule cursor of the previous
-- version forward unconditionally, even when the agent changed the trigger's
-- timing. The scheduler lists a routine only once its cursor's next_due_at has
-- passed, and then replays every slot of the current cadence since the last
-- run, one run each (up to 32; more are coalesced into one). A weekly Monday
-- 08:00 routine that ran on Monday and became daily 08:00 on Thursday ran
-- nothing until the next Monday and then seven times at once.
--
-- The agent's save now takes each new version's cursor from the rule the
-- member's save uses (qorpera_routine_version_schedule_position, migration
-- runtime_member_routine_cursor, which must run first): the same timing keeps
-- the exact position (and offers a run still waiting for its start again to
-- the new version); changed timing, or a save that switches a paused or ended
-- routine back on after its next slot passed, restarts the schedule at the
-- save at a millisecond position (nothing runs at once, nothing is caught up);
-- a cursor that never scheduled anything, or a trigger that becomes a
-- schedule, starts fresh and keeps its kickoff. The agent's status-only resume
-- (also after the authorization-failure suspension) is covered by the same
-- migration's trigger qorpera_cloud_routine_resume_restarts_schedule, and a
-- restart position is not shown as the next run (qorpera_routine_next_run_at,
-- patched there too).
--
-- For both saves, the start of a wall-clock (localTime) trigger that the
-- routine has already reached is no longer part of its timing: it only holds
-- back the first run, so an agent that set a routine up with firstRunAt and
-- saves it later without one has not changed when it runs. An interval
-- trigger's start anchors its grid, so a change to it is still a change of
-- timing.

do $$
begin
	if to_regprocedure('public.qorpera_routine_version_schedule_position(uuid,bigint,jsonb,timestamptz,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_routine_resume_restarts_schedule()') is null then
		raise exception 'Migration runtime_agent_routine_cursor needs runtime_member_routine_cursor first';
	end if;
	-- A restart position must not show as the next run. runtime_member_routine_cursor
	-- patches qorpera_routine_next_run_at only when dynamic routines (v131) are there,
	-- and this migration always runs after both.
	if to_regprocedure('public.qorpera_routine_next_run_at(uuid)') is not null
		and pg_get_functiondef(to_regprocedure('public.qorpera_routine_next_run_at(uuid)'))
			not like '%cursor.last_scheduled_for + interval ''1 millisecond''%' then
		raise exception 'Migration runtime_agent_routine_cursor needs qorpera_routine_next_run_at to skip a restart position';
	end if;
end
$$;

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
-- A wall-clock start the routine has passed is not timing
-- ---------------------------------------------------------------------------
-- The trigger as it acts after a position its cursor reached.
create function public.qorpera_routine_trigger_after(p_trigger jsonb, p_position timestamptz)
returns jsonb language sql stable set search_path = '' as $$
	select case when p_trigger ? 'localTime' and p_trigger ? 'startAt'
			and (p_trigger ->> 'startAt')::timestamptz <= p_position
		then p_trigger - 'startAt' else p_trigger end
$$;
-- Internal only: the cursor rule calls it. PostgreSQL grants new functions to PUBLIC.
revoke all on function public.qorpera_routine_trigger_after(jsonb, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.agent_cursor_patch(
	'public.qorpera_routine_version_schedule_position(uuid,bigint,jsonb,timestamptz,boolean,boolean)'::regprocedure,
	$old$	v_same := public.qorpera_routine_schedule_timing(v_earlier) = public.qorpera_routine_schedule_timing(p_trigger);$old$,
	$new$	-- A wall-clock start the routine has passed is not timing (migration runtime_agent_routine_cursor).
	v_same := public.qorpera_routine_schedule_timing(public.qorpera_routine_trigger_after(v_earlier, v_cursor.last_scheduled_for))
		= public.qorpera_routine_schedule_timing(public.qorpera_routine_trigger_after(p_trigger, v_cursor.last_scheduled_for));$new$);

-- ---------------------------------------------------------------------------
-- The agent's save: the rule both saves share
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
	$new$			-- A new version's cursor follows the rule a member's save uses (migrations
			-- runtime_member_routine_cursor and runtime_agent_routine_cursor): the same timing
			-- keeps the position, changed timing or a late switch back on restarts it at the
			-- save, and a never-run cursor stays fresh with the kickoff it owes. v_routine is
			-- still the routine before this save; v_status is its status after it. This runs
			-- before the routine moves to the new version, which supersedes the old version's
			-- queued runs: a run still waiting is offered again only while it is visible here.
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id,
				last_scheduled_for, next_due_at)
			select v_routine.id, v_next, 'agent', position.last_scheduled_for, position.next_due_at
			from public.qorpera_cloud_routine_versions saved
			cross join lateral public.qorpera_routine_version_schedule_position(v_routine.id, v_routine.current_version,
				v_trigger, saved.created_at, v_routine.status = 'active', v_status = 'active') as position
			where saved.routine_id = v_routine.id and saved.version = v_next and v_trigger ->> 'kind' = 'schedule';$new$);
