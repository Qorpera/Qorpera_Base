-- 20260930244000: the legacy sweep, step F1a (routines). Three functions keep only their folder-v2 body, and the one
-- that does nothing on folder-v2 goes (folder-v2 only, the founder's decision of 3 October):
-- - qorpera_advance_routine_next_due takes the company row KEY SHARE; the gc fence was snapshot-v1's;
-- - qorpera_enqueue_routine_wake hands every wake to qorpera_folder_enqueue_routine_wake, after the same checks;
-- - the wake insert trigger qorpera_routine_occurrence_lifecycle takes the routine FOR NO KEY UPDATE;
-- - qorpera_routine_stops_with_agent and its trigger on qorpera_profile_staff are dropped: on folder-v2 it returned at
--   once, and the follow-up queue ends an archived agent's routines (20260930022000, P15).
-- The rest of each body is the live text, unchanged; create or replace keeps every grant.

set local lock_timeout = '3s';

create or replace function public.qorpera_advance_routine_next_due(p_routine_id uuid, p_expected_version bigint,
	p_trigger_id text, p_expected_last_scheduled_for timestamptz, p_next_due_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
	-- Already waiting for that slot or a later one (another orchestrator raised it, or
	-- the routine is listed for another trigger): answer without the company's fence.
	-- Nothing is written; a read that moved meanwhile is read again at the next poll.
	select cursor.* into v_cursor
	from public.qorpera_cloud_routine_schedule_cursors as cursor
	join public.qorpera_cloud_routines as routine
		on routine.id = cursor.routine_id and routine.current_version = cursor.routine_version
	where cursor.routine_id = p_routine_id and cursor.routine_version = p_expected_version
		and cursor.trigger_id = btrim(p_trigger_id) and routine.status = 'active'
		and cursor.last_scheduled_for is not distinct from p_expected_last_scheduled_for
		and cursor.next_due_at >= p_next_due_at;
	if found then
		return jsonb_build_object('status', 'unchanged', 'next_due_at', v_cursor.next_due_at);
	end if;
	-- The enqueue's lock order (profile fence, routine, cursor): the enqueue may
	-- expire the routine while it holds the cursor.
	-- 20260930244000 (legacy sweep F1a): folder-v2 only, so the company row KEY SHARE (the gc fence was snapshot-v1's).
	perform 1 from public.qorpera_profiles where id = v_profile_id for key share;
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
				-- A fresh cursor only when its kickoff is forgone whatever the time: a
				-- window, or a start after the version's effective time (startAt is
				-- millisecond-exact, so this agrees with the orchestrator's Date).
				and (p_expected_last_scheduled_for is not null or trigger.value ? 'windowStart'
					or (trigger.value ->> 'startAt')::timestamptz > version.created_at)
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
$function$;

create or replace function public.qorpera_enqueue_routine_wake(p_routine_id uuid, p_expected_version bigint,
	p_occurrence_id uuid, p_occurrence_key text, p_trigger_id text, p_scheduled_for timestamptz,
	p_expected_last_scheduled_for timestamptz, p_next_due_at timestamptz, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	if auth.role() <> 'service_role' then
		raise exception 'wake enqueue requires control-plane authority' using errcode = '42501';
	end if;
	if p_occurrence_id is null or p_expected_version is null or p_expected_version < 1
		or octet_length(convert_to(btrim(coalesce(p_occurrence_key, '')), 'utf8')) not between 1 and 256
		or p_occurrence_key ~ E'[\r\n]'
		or octet_length(convert_to(btrim(coalesce(p_trigger_id, '')), 'utf8')) not between 1 and 160
		or p_trigger_id ~ E'[\r\n]'
		or p_scheduled_for is null or p_next_due_at is null or p_next_due_at <= p_scheduled_for
		or p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 8192 then
		raise exception 'wake occurrence is invalid' using errcode = '22023';
	end if;
	-- 20260930244000 (legacy sweep F1a): folder-v2 only. The folder core enqueues every routine's wake; a routine that is
	-- gone is refused there (42501), as the gc fence refused it.
	return public.qorpera_folder_enqueue_routine_wake(p_routine_id, p_expected_version, p_occurrence_id, p_occurrence_key,
		p_trigger_id, p_scheduled_for, p_expected_last_scheduled_for, p_next_due_at, p_payload);
end
$function$;

create or replace function public.qorpera_routine_occurrence_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_routine public.qorpera_cloud_routines%rowtype; v_local timestamp; v_now time; v_end timestamp;
begin
	if new.wake_kind <> 'routine' or new.routine_id is null then return new; end if;
	-- 20260930244000 (legacy sweep F1a): folder-v2 only, so the routine FOR NO KEY UPDATE.
	select * into v_routine from public.qorpera_cloud_routines where id = new.routine_id for no key update;
	if v_routine.expires_at is not null and new.scheduled_for >= v_routine.expires_at then
		raise exception 'Routine has expired' using errcode = '55000'; end if;
	if v_routine.max_occurrences is not null
		and public.qorpera_routine_occurrence_count(new.routine_id) >= v_routine.max_occurrences then
		raise exception 'Routine occurrence limit reached' using errcode = '55000'; end if;
	if v_routine.quiet_start is not null then
		v_local := greatest(new.not_before, statement_timestamp()) at time zone v_routine.quiet_time_zone;
		v_now := v_local::time;
		if (v_routine.quiet_start < v_routine.quiet_end and v_now >= v_routine.quiet_start and v_now < v_routine.quiet_end)
			or (v_routine.quiet_start > v_routine.quiet_end and (v_now >= v_routine.quiet_start or v_now < v_routine.quiet_end)) then
			v_end := date_trunc('day', v_local) + v_routine.quiet_end
				+ case when v_now >= v_routine.quiet_end then interval '1 day' else interval '0' end;
			new.not_before := v_end at time zone v_routine.quiet_time_zone;
		end if;
	end if;
	return new;
end
$function$;

drop trigger qorpera_profile_staff_routines_stop on public.qorpera_profile_staff;
drop function public.qorpera_routine_stops_with_agent();
