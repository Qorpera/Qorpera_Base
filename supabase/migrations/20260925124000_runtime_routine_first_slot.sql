-- 2026-09-25, follow-up to the routine cursor fixes (#317 member saves, #320
-- agent saves and resumes): a routine waiting for its first slot was listed on
-- every scheduler poll and showed no next run.
--
-- A save with changed timing, or a switch back on after the next slot passed,
-- restarts the schedule at a millisecond position with next_due_at one
-- millisecond later. The scheduler (qorpera_list_routine_schedule_heads) lists
-- every routine with a cursor whose next_due_at has passed, so it listed that
-- routine at once and on every poll after, and found nothing due until the new
-- cadence's first slot: up to a whole period (an hourly routine loosened to
-- weekly stayed listed for a week, a monthly window for weeks). And
-- qorpera_routine_next_run_at skips a restart position, so the next run an
-- agent and a member see stayed empty until that slot ran. A fresh cursor that
-- waits for a later startAt or a window's first slot had both effects too (it
-- sits at -infinity, and the next run ignores fresh cursors).
--
-- The orchestrator now raises such a cursor's next_due_at to the first slot it
-- computed, through qorpera_advance_routine_next_due. That call creates no
-- occurrence and never moves the position (last_scheduled_for): it compares
-- the routine's current version, its active status and the exact position the
-- orchestrator read (the orchestrator sends it back as a JavaScript Date ISO
-- string, like the enqueue, so the position is compared to the millisecond),
-- and it only raises next_due_at. Anything that moved in between (a save, a
-- pause, a resume, an admitted slot) answers 'stale' and the next poll reads
-- the cursor again. When the slot comes, the listing offers the routine and the
-- enqueue compares the same position as before.
--
-- A fresh cursor stays fresh (no position), so its first run is still the latest
-- slot at or after its version's effective time and #317/#320 still treat it as
-- never run. The orchestrator raises one only when its kickoff is forgone
-- whatever the time: its trigger names a start after the version's effective
-- time, or a window bounds its run times. A fresh cursor that may still owe a
-- kickoff is never raised.
--
-- The next run shown to agents and members (qorpera_routine_next_run_at) now
-- also shows a fresh cursor's raised first slot. A restart position is still
-- not a run time: it shows nothing for the moment until the scheduler's next
-- poll raises it.

create function public.qorpera_advance_routine_next_due(
	p_routine_id uuid,
	p_expected_version bigint,
	p_trigger_id text,
	p_expected_last_scheduled_for timestamptz,
	p_next_due_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid;
	v_routine public.qorpera_cloud_routines%rowtype;
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'routine schedule advance requires control-plane authority' using errcode = '42501';
	end if;
	if p_routine_id is null or p_expected_version is null or p_expected_version < 1
		or octet_length(convert_to(btrim(coalesce(p_trigger_id, '')), 'utf8')) not between 1 and 160
		or p_trigger_id ~ E'[\r\n]'
		or p_next_due_at is null or not isfinite(p_next_due_at)
		or (p_expected_last_scheduled_for is not null
			and (not isfinite(p_expected_last_scheduled_for) or p_next_due_at <= p_expected_last_scheduled_for)) then
		raise exception 'routine next due time is invalid' using errcode = '22023';
	end if;
	select routine.profile_id into v_profile_id from public.qorpera_cloud_routines as routine where routine.id = p_routine_id;
	if v_profile_id is null then
		return jsonb_build_object('status', 'stale', 'next_due_at', null);
	end if;
	-- The enqueue's lock order (profile fence, routine, cursor): the enqueue may
	-- expire the routine while it holds the cursor.
	perform public.qorpera_lock_profile_gc_fence(v_profile_id);
	select routine.* into v_routine
	from public.qorpera_cloud_routines as routine where routine.id = p_routine_id
	for share;
	select cursor.* into v_cursor
	from public.qorpera_cloud_routine_schedule_cursors as cursor
	where cursor.routine_id = p_routine_id
		and cursor.routine_version = p_expected_version
		and cursor.trigger_id = btrim(p_trigger_id)
	for update;
	if v_routine.id is null or v_routine.status <> 'active'
		or v_routine.current_version <> p_expected_version or v_cursor.routine_id is null
		or v_cursor.last_scheduled_for is distinct from p_expected_last_scheduled_for
		or not exists (
			select 1 from public.qorpera_cloud_routine_versions as version
			cross join lateral jsonb_array_elements(version.triggers) as trigger(value)
			where version.routine_id = p_routine_id and version.version = p_expected_version
				and trigger.value ->> 'id' = btrim(p_trigger_id) and trigger.value ->> 'kind' = 'schedule'
		) then
		return jsonb_build_object('status', 'stale', 'next_due_at', nullif(v_cursor.next_due_at, '-infinity'::timestamptz));
	end if;
	-- Only ever later: two orchestrators computing the same slot, or a slot the
	-- cursor already waits for, change nothing.
	if v_cursor.next_due_at >= p_next_due_at then
		return jsonb_build_object('status', 'unchanged', 'next_due_at', v_cursor.next_due_at);
	end if;
	update public.qorpera_cloud_routine_schedule_cursors
	set next_due_at = p_next_due_at, updated_at = statement_timestamp()
	where routine_id = p_routine_id and routine_version = p_expected_version
		and trigger_id = btrim(p_trigger_id);
	return jsonb_build_object('status', 'advanced', 'next_due_at', p_next_due_at);
end
$$;
revoke all on function public.qorpera_advance_routine_next_due(uuid, bigint, text, timestamptz, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_advance_routine_next_due(uuid, bigint, text, timestamptz, timestamptz)
	to service_role;

-- The next run shown to agents and members. Restated whole (it is small): the
-- restart-position skip came from #320 and may also come from #317's re-cut,
-- in either wording, and this version replaces both.
create or replace function public.qorpera_routine_next_run_at(p_routine_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select case when routine.status <> 'active' then null else coalesce(
		(select min(wake.not_before) from public.qorpera_wake_occurrences wake
			where wake.routine_id = routine.id and wake.routine_version = routine.current_version and wake.status = 'queued'),
		-- Each schedule cursor's next slot: after a position, or the first slot the
		-- scheduler raised a fresh cursor to (one still at -infinity has none yet, or
		-- owes a kickoff that runs at once). A restart position (next due one
		-- millisecond after it) is not a run time; the scheduler raises it to the
		-- first slot at its next poll (migration runtime_routine_first_slot).
		(select min(cursor.next_due_at) from public.qorpera_cloud_routine_schedule_cursors cursor
			where cursor.routine_id = routine.id and cursor.routine_version = routine.current_version
				and cursor.next_due_at > '-infinity'::timestamptz
				and (cursor.last_scheduled_for is null
					or cursor.next_due_at <> cursor.last_scheduled_for + interval '1 millisecond')),
		-- A dynamic routine's chosen time, before the tick inserts its run (not while
		-- a run of this version works: then the next run is not chosen yet).
		(select greatest((version.triggers -> 0 ->> 'at')::timestamptz, statement_timestamp())
			from public.qorpera_cloud_routine_versions version
			where version.routine_id = routine.id and version.version = routine.current_version
				and version.triggers -> 0 ->> 'kind' = 'once' and routine.origin = 'agent'
				and not exists (select 1 from public.qorpera_wake_occurrences wake
					where wake.routine_id = routine.id and wake.routine_version = routine.current_version))) end
	from public.qorpera_cloud_routines routine where routine.id = p_routine_id
$$;
