-- A routine occurrence that falls due while the company is paused was admitted
-- and cancelled at once (contract 7.4) while the scheduler advanced its cursor,
-- so the slot was lost: the v67 cut cancelled three routine kickoffs this way.
-- The enqueue now answers 'deferred' without inserting or advancing while the
-- company is paused; the orchestrator offers the same occurrence again on its
-- next poll and it is admitted after the resume.

CREATE OR REPLACE FUNCTION public.qorpera_enqueue_routine_wake(p_routine_id uuid, p_expected_version bigint, p_occurrence_id uuid, p_occurrence_key text, p_trigger_id text, p_scheduled_for timestamp with time zone, p_expected_last_scheduled_for timestamp with time zone, p_next_due_at timestamp with time zone, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
	v_routine public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_occurrence public.qorpera_wake_occurrences%rowtype;
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
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
	perform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_cloud_routines where id=p_routine_id));
	select routine.* into v_routine
	from public.qorpera_cloud_routines as routine where routine.id = p_routine_id
	for share;
	select version.* into v_version
	from public.qorpera_cloud_routine_versions as version
	where version.routine_id = p_routine_id and version.version = p_expected_version;
	if v_routine.id is null or v_routine.status <> 'active'
		or v_routine.current_version <> p_expected_version or v_version.routine_id is null
		or not exists (
			select 1 from jsonb_array_elements(v_version.triggers) as trigger(value)
			where trigger.value ->> 'id' = btrim(p_trigger_id)
				and trigger.value ->> 'kind' = 'schedule'
		) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake routine version is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select cursor.* into v_cursor
	from public.qorpera_cloud_routine_schedule_cursors as cursor
	where cursor.routine_id = p_routine_id
		and cursor.routine_version = p_expected_version
		and cursor.trigger_id = btrim(p_trigger_id)
	for update;
	if not found then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake schedule cursor is unavailable', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	select occurrence.* into v_occurrence
	from public.qorpera_wake_occurrences as occurrence
	where occurrence.routine_id = p_routine_id and occurrence.occurrence_key = btrim(p_occurrence_key);
	if found then
		if v_occurrence.id <> p_occurrence_id
			or v_occurrence.routine_version <> p_expected_version
			or v_occurrence.trigger_id <> btrim(p_trigger_id)
			or v_occurrence.scheduled_for <> p_scheduled_for
			or v_occurrence.payload <> p_payload then
			raise exception 'wake occurrence key is already bound to other work' using errcode = '23505';
		end if;
	end if;
	if v_cursor.last_scheduled_for is distinct from p_expected_last_scheduled_for then
		if v_cursor.last_scheduled_for = p_scheduled_for and v_cursor.next_due_at = p_next_due_at
			and v_occurrence.id is not null then
			return jsonb_build_object(
				'occurrence_id', v_occurrence.id, 'status', v_occurrence.status,
				'run_id', v_occurrence.run_id, 'scheduled_for', v_occurrence.scheduled_for
			);
		end if;
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'wake schedule cursor changed', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	if p_expected_last_scheduled_for is not null and p_scheduled_for <= p_expected_last_scheduled_for then
		raise exception 'wake schedule did not advance' using errcode = '22023';
	end if;
	-- A founder pause defers standing work instead of skipping it: the occurrence
	-- is not admitted (admission would cancel it, contract 7.4) and the cursor does
	-- not move, so the same slot is offered again once execution resumes.
	if v_occurrence.id is null and public.qorpera_company_execution_paused(v_routine.profile_id) then
		return jsonb_build_object(
			'occurrence_id', null, 'status', 'deferred', 'run_id', null,
			'scheduled_for', p_scheduled_for, 'reason', 'Company execution is paused'
		);
	end if;
	if v_occurrence.id is null then
		insert into public.qorpera_wake_occurrences (
			id, profile_id, environment_id, routine_id, routine_version,
			trigger_id, occurrence_key, scheduled_for, not_before, payload
		) values (
			p_occurrence_id, v_routine.profile_id, v_routine.environment_id,
			v_routine.id, v_version.version, btrim(p_trigger_id), btrim(p_occurrence_key),
			p_scheduled_for, p_scheduled_for, p_payload
		) returning * into v_occurrence;
	end if;
	update public.qorpera_cloud_routine_schedule_cursors
	set last_scheduled_for = p_scheduled_for,
		next_due_at = p_next_due_at,
		updated_at = statement_timestamp()
	where routine_id = p_routine_id and routine_version = p_expected_version
		and trigger_id = btrim(p_trigger_id);
	return jsonb_build_object(
		'occurrence_id', v_occurrence.id, 'status', v_occurrence.status,
		'run_id', v_occurrence.run_id, 'scheduled_for', v_occurrence.scheduled_for
	);
end
$function$;
