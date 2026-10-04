-- @fixture 656_folder_core_run_wakes.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-3e (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.9): a folder-v2 dynamic routine's
-- next run. The folder list names the folder-v2 dynamic routines missing their run; the per-routine restore inserts
-- that run once (admitted, at its chosen instant), answers pending, changed, gone, not_folder and paused without one,
-- pauses a routine whose latest run a member stopped, and suspends (and tells its member) a routine whose run the kernel
-- refuses for want of authority, but raises admission's own refusal. The list leaves out limit-reached routines; an
-- expired one is listed and ended (20260930027000, test 889). The legacy path refuses folder-v2. Snapshot-v1 keeps its
-- text. Both functions are the service role's alone.

create function pg_temp.due(p_after uuid default null, p_limit integer default 100) returns jsonb language sql as $$
	select public.qorpera_folder_dynamic_routines_due(p_after, p_limit)
$$;
create function pg_temp.restore(p_routine uuid, p_version bigint default 1) returns jsonb language sql as $$
	select public.qorpera_folder_restore_dynamic_routine_run(p_routine, p_version)
$$;
create function pg_temp.listed(p_routine uuid) returns boolean language sql as $$
	select exists (select 1 from jsonb_array_elements(pg_temp.due() -> 'items') as item(value)
		where item.value ->> 'routine_id' = p_routine::text)
$$;

-- 1. Snapshot-v1 keeps its text: the legacy path with its first lines removed is the definition before this migration.
do $$
begin
	if md5(replace(pg_get_functiondef('public.qorpera_ensure_dynamic_routine_run(uuid)'::regprocedure),
			E'\t-- 20260930009500: a folder-v2 routine''s next run comes from qorpera_folder_restore_dynamic_routine_run.\n'
			|| E'\tif public.qorpera_company_is_folder_v2((select routine.profile_id from public.qorpera_cloud_routines as routine\n'
			|| E'\t\t\twhere routine.id = p_routine_id)) then\n'
			|| E'\t\traise exception ''A folder-v2 routine''''s next run comes from the folder tick'' using errcode = ''0A000''; end if;\n',
			'')) <> '2abbbce4e97a962ccb121b68d2ef385b' then
		raise exception 'The legacy dynamic tick''s snapshot-v1 text changed: %', md5(replace(pg_get_functiondef(
			'public.qorpera_ensure_dynamic_routine_run(uuid)'::regprocedure),
			E'\t-- 20260930009500: a folder-v2 routine''s next run comes from qorpera_folder_restore_dynamic_routine_run.\n'
			|| E'\tif public.qorpera_company_is_folder_v2((select routine.profile_id from public.qorpera_cloud_routines as routine\n'
			|| E'\t\t\twhere routine.id = p_routine_id)) then\n'
			|| E'\t\traise exception ''A folder-v2 routine''''s next run comes from the folder tick'' using errcode = ''0A000''; end if;\n',
			'')); end if;
end $$;

-- 2. The list and the restore: an agent's dynamic routine is listed until its run is inserted (once, admitted, due at
-- its chosen instant, already past here), then answered as pending; a stale version is changed, an unknown routine
-- gone; a snapshot-v1 company's routine is never listed and answered not_folder; the legacy path refuses folder-v2.
do $$
declare v_routine uuid := pg_temp.routine('agent'); v_result jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_admitted bigint; v_control uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('service_role');
	if not pg_temp.listed(v_routine) then raise exception 'The dynamic routine must be listed: %', pg_temp.due(); end if;
	if pg_temp.restore(v_routine, 2) ->> 'status' <> 'changed' or pg_temp.restore(extensions.gen_random_uuid()) ->> 'status' <> 'gone' then
		raise exception 'A stale version is changed and an unknown routine gone'; end if;
	select admitted into v_admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010';
	v_result := pg_temp.restore(v_routine);
	select * into v_wake from public.qorpera_wake_occurrences where id = (v_result ->> 'occurrence_id')::uuid;
	if v_result ->> 'status' <> 'inserted' or v_wake.routine_id is distinct from v_routine or v_wake.occurrence_key <> 'once:1:1'
		or v_wake.not_before > clock_timestamp() or v_wake.payload ->> 'attempt' <> '1'
		or (select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010')
			<> v_admitted + 1 then
		raise exception 'The restore inserts one admitted run: % / %', v_result, to_jsonb(v_wake); end if;
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'pending' then
		raise exception 'A routine with its run pending is not listed and answers pending'; end if;
	perform pg_temp.raises_like(format('select public.qorpera_ensure_dynamic_routine_run(%L)', v_routine), '0A000',
		'A folder-v2 routine''s next run comes from the folder tick');
	-- The snapshot-v1 control company's dynamic routine.
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routines(id, profile_id, environment_id, client_routine_id,
		current_version, status, created_by_user_id, origin, owner_staff_agent_id, routine_key)
		values (%L, '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021', extensions.gen_random_uuid(), 1,
			'active', '63400000-0000-4000-8000-000000000001', 'agent', extensions.gen_random_uuid(), 'r-control')$f$, v_control));
	perform pg_temp.fx(format($f$insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id,
		environment_id, staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, content_sha256, created_by_user_id)
		values (%L, 1, extensions.gen_random_uuid(), '64700000-0000-4000-8000-000000000011', '64700000-0000-4000-8000-000000000021',
			extensions.gen_random_uuid(), 'Control', 'Control.', '[{"id":"t1","kind":"once","at":"2026-10-01T09:00:00Z","timeZone":"UTC"}]',
			'medium', extensions.gen_random_uuid(), 1, repeat('e', 64), '63400000-0000-4000-8000-000000000001')$f$, v_control));
	if pg_temp.listed(v_control) or pg_temp.restore(v_control) ->> 'status' <> 'not_folder' then
		raise exception 'A snapshot-v1 routine is not the folder tick''s'; end if;
end $$;

-- 3. A paused company: not listed, and the restore answers paused without a run.
do $$
declare v_routine uuid := pg_temp.routine('agent');
begin
	perform pg_temp.path_claims('service_role');
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason)
	values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', 'test');
	if pg_temp.listed(v_routine) or pg_temp.restore(v_routine) ->> 'status' <> 'paused'
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_routine) then
		raise exception 'A paused company''s routine gets no run'; end if;
	delete from public.qorpera_company_execution_pauses where profile_id = '63400000-0000-4000-8000-000000000010';
end $$;

-- 4. A member's Stop of the routine's latest run pauses the routine, once, and it leaves the list. The run is built by
-- hand (triggers off): its job cancelled by the member, as a Stop leaves it, and the routine's wake failed with it.
do $$
declare v_routine uuid := pg_temp.routine('agent'); v_wake uuid; v_run uuid := extensions.gen_random_uuid();
	v_job uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('service_role');
	v_wake := (pg_temp.restore(v_routine) ->> 'occurrence_id')::uuid;
	perform pg_temp.fx(format($f$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id,
		client_job_id, required_capability, job_type, payload, created_by_user_id, status, run_id, cancelled_at, cancelled_by_user_id)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(),
			extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}', '63400000-0000-4000-8000-000000000002', 'cancelled', %L,
			clock_timestamp(), '63400000-0000-4000-8000-000000000002')$f$, v_job, v_run));
	perform pg_temp.fx(format($f$insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id,
		job_id, substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version,
		required_capability, job_type, payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id,
		model_provider, model_id, model_selection, audience_kind, runtime_bundle_id, runtime_bundle_sha256, input_ids)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'wake', %L, %L,
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), '63400000-0000-4000-8000-0000000000a1', 1,
			'63400000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0,
			'63400000-0000-4000-8000-000000000002', '63400000-0000-4000-8000-000000000002', 'openai', 'gpt-test',
			'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64), '{}')$f$, v_run, v_wake, v_job));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set status = %L, run_id = %L, finished_at = clock_timestamp()
		where id = %L', 'failed', v_run, v_wake));
	if pg_temp.restore(v_routine) ->> 'status' <> 'stopped'
		or (select status || '/' || pause_reason from public.qorpera_cloud_routines where id = v_routine) <> 'paused/member'
		or (select blocked_reason from public.qorpera_wake_occurrences where id = v_wake) <> 'A member stopped this run; the routine paused'
		or pg_temp.listed(v_routine) then
		raise exception 'A stopped run pauses its routine'; end if;
end $$;

-- 5. A run the kernel refuses for want of authority (the version's member no longer in the company): no run, no
-- admission; the routine is suspended and its member told once.
do $$
declare v_routine uuid := pg_temp.routine('agent'); v_admitted bigint; v_result jsonb;
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx($f$delete from public.qorpera_profile_members
		where profile_id = '63400000-0000-4000-8000-000000000010' and user_id = '63400000-0000-4000-8000-000000000002'$f$);
	select admitted into v_admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010';
	v_result := pg_temp.restore(v_routine);
	if v_result ->> 'status' <> 'suspended'
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_routine)
		or (select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010')
			<> v_admitted
		or (select status || '/' || pause_reason from public.qorpera_cloud_routines where id = v_routine) <> 'paused/authorization_failed'
		or (select count(*) from public.qorpera_member_notifications where dedupe_key = 'routine:' || v_routine::text) <> 1 then
		raise exception 'A refused run suspends its routine and tells its member: % / % / % / %', v_result,
			(select status || '/' || coalesce(pause_reason, '') from public.qorpera_cloud_routines where id = v_routine),
			(select count(*) from public.qorpera_member_notifications where dedupe_key = 'routine:' || v_routine::text),
			(select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010')
				- v_admitted; end if;
	perform pg_temp.fx($f$insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
		('63400000-0000-4000-8000-000000000010','63400000-0000-4000-8000-000000000002','authority-member@example.test','Member',
			'contributor')$f$);
end $$;

-- 5b. P15 (20260930022000): an archived agent's routine waits ('paused'): no run, no admission, no suspension; a mark for
-- the agent makes the follow-up queue pause the routine (agent_archived).
do $$
declare v_routine uuid := pg_temp.routine('agent'); v_admitted bigint; v_result jsonb;
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx($f$update public.qorpera_profile_staff set employment_status = 'archived'
		where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = '63400000-0000-4000-8000-0000000000a1'$f$);
	select admitted into v_admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010';
	v_result := pg_temp.restore(v_routine);
	if v_result ->> 'status' <> 'paused'
		or exists (select 1 from public.qorpera_wake_occurrences where routine_id = v_routine)
		or (select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010')
			<> v_admitted
		or (select status from public.qorpera_cloud_routines where id = v_routine) <> 'active'
		or exists (select 1 from public.qorpera_member_notifications where dedupe_key = 'routine:' || v_routine::text)
		or not exists (select 1 from public.qorpera_folder_follow_up_marks where environment_id = '63400000-0000-4000-8000-000000000020'
			and subject_kind = 'agent' and subject_id = '63400000-0000-4000-8000-0000000000a1' and commit_id is null) then
		raise exception 'An archived agent''s routine waits and marks its agent: %', v_result; end if;
	perform pg_temp.fx($f$delete from public.qorpera_folder_follow_up_marks where environment_id = '63400000-0000-4000-8000-000000000020'$f$);
	perform pg_temp.fx($f$update public.qorpera_profile_staff set employment_status = 'active'
		where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = '63400000-0000-4000-8000-0000000000a1'$f$);
end $$;

-- 6. Only the service role: a member, and an anonymous caller, are refused; neither function is granted to the API's
-- other roles.
do $$
declare v_routine uuid := pg_temp.routine('agent'); v_fn text;
begin
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like('select pg_temp.due()', '42501', 'routine schedule discovery requires control-plane authority');
	perform pg_temp.raises_like(format('select pg_temp.restore(%L)', v_routine), '42501', 'routine firing requires control-plane authority');
	perform pg_temp.path_claims('service_role');
	foreach v_fn in array array['public.qorpera_folder_dynamic_routines_due(uuid,integer)',
		'public.qorpera_folder_restore_dynamic_routine_run(uuid,bigint)'] loop
		if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
			or not has_function_privilege('service_role', v_fn, 'execute') then
			raise exception '% must be the service role''s alone', v_fn; end if;
	end loop;
	perform pg_temp.raises_like('select pg_temp.due(null, 0)', '22023', 'routine schedule page limit is invalid');
end $$;

-- 7. Paging: a page of one names its cursor, and the next page starts after it.
do $$
declare v_first uuid := pg_temp.routine('agent'); v_second uuid := pg_temp.routine('agent'); v_page jsonb; v_seen uuid[] := '{}';
	v_after uuid;
begin
	perform pg_temp.path_claims('service_role');
	loop
		v_page := pg_temp.due(v_after, 1);
		if jsonb_array_length(v_page -> 'items') > 1 or (v_page ->> 'has_more')::boolean <> (v_page ? 'next_after_routine_id'
			and v_page -> 'next_after_routine_id' <> 'null'::jsonb) then
			raise exception 'A page of one: %', v_page; end if;
		v_seen := v_seen || array(select (item.value ->> 'routine_id')::uuid from jsonb_array_elements(v_page -> 'items') as item(value));
		exit when not (v_page ->> 'has_more')::boolean;
		v_after := (v_page ->> 'next_after_routine_id')::uuid;
	end loop;
	if not (v_first = any (v_seen) and v_second = any (v_seen)) then raise exception 'Paging must visit every routine: %', v_seen; end if;
end $$;

-- 8. The list leaves out a routine at its occurrence limit (an earlier occurrence, cancelled, by hand), which the
-- restore answers `ended` for. One past its expiry is listed so the restore can end it (20260930027000; test 889).
do $$
declare v_expired uuid := pg_temp.routine('agent'); v_limited uuid := pg_temp.routine('agent', 1);
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx(format('update public.qorpera_cloud_routines set expires_at = clock_timestamp() - interval %L where id = %L',
		'1 minute', v_expired));
	perform pg_temp.fx(format($f$insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id,
		routine_version, trigger_id, occurrence_key, scheduled_for, not_before, payload, status, finished_at)
		values (extensions.gen_random_uuid(), '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', %L, 1,
			't1', 'once:1:1', clock_timestamp(), clock_timestamp(), '{}', 'cancelled', clock_timestamp())$f$, v_limited));
	if not pg_temp.listed(v_expired) or pg_temp.listed(v_limited) then
		raise exception 'An expired routine is listed and a limited one is not'; end if;
	if pg_temp.restore(v_expired) ->> 'status' <> 'ended' or pg_temp.restore(v_limited) ->> 'status' <> 'ended' then
		raise exception 'An expired or limited routine is ended'; end if;
	-- Read after the restores, in its own statement (a scalar subquery beside them would be read first).
	if (select status from public.qorpera_cloud_routines where id = v_expired) <> 'expired' then
		raise exception 'The expired routine''s status says so'; end if;
end $$;

-- 9. Admission's own refusal (the company has no admission row) is raised, not taken for the kernel refusing the run:
-- the routine stays active and nobody is told. (Last: the admission row stays deleted.)
do $$
declare v_routine uuid := pg_temp.routine('agent');
begin
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx($f$delete from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010'$f$);
	perform pg_temp.raises_like(format('select pg_temp.restore(%L)', v_routine), '42501', 'Company folder is unavailable');
	if (select status from public.qorpera_cloud_routines where id = v_routine) <> 'active'
		or exists (select 1 from public.qorpera_member_notifications where dedupe_key = 'routine:' || v_routine::text) then
		raise exception 'Admission''s own refusal must not suspend the routine'; end if;
end $$;

rollback;
