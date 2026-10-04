-- @fixture 819_folder_core_dynamic_routine_tick.test.sql until "-- 9. Admission's own refusal"
-- Company folder core: a folder-v2 routine's expiry (20260930027000), now that the legacy sweep no longer runs (P28).
-- P04's folder list names a folder-v2 routine of any origin past its expiry, active or paused, paused company or not;
-- the restore ends it (`ended`, status expired) under the fence, the company row and the routine's rank-5 lock. An
-- expired active routine leaves the schedule heads, so the scheduler stops offering its slots; an expired paused one has
-- its queued runs cancelled. A routine not yet at its end, a snapshot-v1 company's routine, and a company being deleted
-- are left alone. The materializer's comment on F2's drain is corrected.

-- A member's schedule routine with a due slot (the heads' condition), ending at p_ends.
create function pg_temp.scheduled(p_ends timestamptz) returns uuid language plpgsql as $$
declare v_routine uuid := pg_temp.routine('member');
begin
	perform pg_temp.fx(format($f$update public.qorpera_cloud_routine_versions set triggers = '[{"id":"s1","kind":"schedule","intervalMinutes":60}]'
		where routine_id = %L$f$, v_routine));
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set expires_at = %L where id = %L', p_ends, v_routine));
	perform pg_temp.fx(format('insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, next_due_at)
		values (%L, 1, %L, %L)', v_routine, 's1', clock_timestamp() - interval '5 minutes'));
	return v_routine;
end $$;
create function pg_temp.headed(p_routine uuid) returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(public.qorpera_list_routine_schedule_heads(null, 500) -> 'items') as item(value)
		where item.value ->> 'routine_id' = p_routine::text)
$$;

-- 1. An active schedule routine past its end: listed and in the heads; the restore ends it; then neither.
do $$
declare v_routine uuid := pg_temp.scheduled(clock_timestamp() - interval '1 minute'); v_result jsonb;
	v_row public.qorpera_cloud_routines%rowtype;
begin
	perform pg_temp.path_claims('service_role');
	if not pg_temp.listed(v_routine) or not pg_temp.headed(v_routine) then
		raise exception 'An active routine past its end is listed, and still in the heads before it is ended'; end if;
	v_result := pg_temp.restore(v_routine);
	select * into v_row from public.qorpera_cloud_routines where id = v_routine;
	if v_result ->> 'status' <> 'ended' or v_row.status <> 'expired' or not v_row.expired_while_active
		or v_row.pause_reason is not null then
		raise exception 'The restore ends an expired routine: % %', v_result, to_jsonb(v_row); end if;
	if pg_temp.listed(v_routine) or pg_temp.headed(v_routine) then
		raise exception 'An ended routine is neither listed nor in the heads'; end if;
end $$;

-- 2. A paused routine past its end: ended, not as active, and its queued run cancelled.
do $$
declare v_routine uuid := pg_temp.scheduled(clock_timestamp() + interval '1 hour'); v_wake uuid; v_slot timestamptz;
	v_row public.qorpera_cloud_routines%rowtype;
begin
	-- A slot queued while the routine ran (before its end), then the routine paused and its end passed.
	select next_due_at into strict v_slot from public.qorpera_cloud_routine_schedule_cursors where routine_id = v_routine;
	perform pg_temp.path_claims('service_role');
	v_wake := (public.qorpera_enqueue_routine_wake(v_routine, 1, extensions.gen_random_uuid(), 'slot-1', 's1', v_slot, null,
		v_slot + interval '1 hour') ->> 'occurrence_id')::uuid;
	if (select status from public.qorpera_wake_occurrences where id = v_wake) is distinct from 'queued' then
		raise exception 'The slot is queued before the routine pauses'; end if;
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set status = %L, pause_reason = %L, expires_at = %L where id = %L',
		'paused', 'member', clock_timestamp() - interval '1 minute', v_routine));
	if not pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'ended' then
		raise exception 'A paused routine past its end is listed and ended'; end if;
	select * into v_row from public.qorpera_cloud_routines where id = v_routine;
	if v_row.status <> 'expired' or v_row.expired_while_active or v_row.pause_reason is not null
		or (select status || ':' || blocked_reason from public.qorpera_wake_occurrences where id = v_wake)
			is distinct from 'cancelled:Routine expired while paused' then
		raise exception 'A paused routine ends as not active, its queued run cancelled: %', to_jsonb(v_row); end if;
end $$;

-- 3. A paused company: its routines past their end still end (the legacy sweep's rule); one not at its end is left.
do $$
declare v_ended uuid := pg_temp.scheduled(clock_timestamp() - interval '1 minute');
	v_running uuid := pg_temp.scheduled(clock_timestamp() + interval '1 day');
begin
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		'63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000002', 'Expiry test'));
	perform pg_temp.path_claims('service_role');
	if not pg_temp.listed(v_ended) or pg_temp.listed(v_running) then
		raise exception 'On a paused company, only the routine past its end is listed'; end if;
	if pg_temp.restore(v_ended) ->> 'status' <> 'ended' or pg_temp.restore(v_running) ->> 'status' <> 'paused' then
		raise exception 'A paused company''s expired routine ends; the other answers paused'; end if;
	-- Read in a statement of its own: one expression's subqueries see the snapshot from before its restores.
	if (select status from public.qorpera_cloud_routines where id = v_ended) <> 'expired'
		or (select status from public.qorpera_cloud_routines where id = v_running) <> 'active' then
		raise exception 'A paused company''s expired routine is expired; the other stays active'; end if;
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L',
		'63400000-0000-4000-8000-000000000010'));
end $$;

-- 4. A snapshot-v1 company's routine past its end is not the folder tick's.
do $$
declare v_control uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id,
		current_version, status, created_by_user_id, origin, expires_at)
		values (%L, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', extensions.gen_random_uuid(), 1,
			'active', '63400000-0000-4000-8000-000000000001', 'member', clock_timestamp() - interval '1 minute')$f$, v_control));
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id,
		environment_id, staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
		values (%L, 1, extensions.gen_random_uuid(), '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021',
			extensions.gen_random_uuid(), 'Control', 'Control.', '[{"id":"s1","kind":"schedule","intervalMinutes":60}]',
			'medium', extensions.gen_random_uuid(), 1, repeat('e', 64), '63400000-0000-4000-8000-000000000001')$f$, v_control));
	perform pg_temp.path_claims('service_role');
	if pg_temp.listed(v_control) or pg_temp.restore(v_control) ->> 'status' <> 'not_folder' then
		raise exception 'A snapshot-v1 routine is not the folder tick''s'; end if;
	if (select status from public.qorpera_cloud_routines where id = v_control) <> 'active' then
		raise exception 'A snapshot-v1 routine is left active'; end if;
end $$;

-- 4b. A company being deleted: its expired routine is left to the purge (C1c-3g: effects refuse); the restore answers
-- paused, as for any routine of a paused company.
do $$
declare v_routine uuid := pg_temp.scheduled(clock_timestamp() - interval '1 minute');
begin
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values (%L, %L)',
		'63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001'));
	perform pg_temp.path_claims('service_role');
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'paused' then
		raise exception 'A deleting company''s expired routine is not listed and answers paused'; end if;
	if (select status from public.qorpera_cloud_routines where id = v_routine) <> 'active' then
		raise exception 'A deleting company''s routine is left to its purge'; end if;
	perform pg_temp.fx(format('delete from public.qorpera_company_deletions where profile_id = %L',
		'63400000-0000-4000-8000-000000000010'));
end $$;

-- 5. P28's tidy-up: the materializer no longer says F2's drain runs inside it.
do $$
declare v_def text := pg_get_functiondef('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure);
begin
	if position('F2-5b-3 calls the folder worker drain here' in v_def) > 0
		or position('20260930027000: F2''s worker drain and the listener (P29) run in their own transactions' in v_def) = 0 then
		raise exception 'The materializer''s comment on F2''s drain is not the corrected one'; end if;
end $$;

rollback;
