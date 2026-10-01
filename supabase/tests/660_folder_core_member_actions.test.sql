-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C1c-3a (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6): a member's posts and writes on the
-- folder fence. The enter helper; posting in an agent's thread and in a group chat with no agent; a room delivery's
-- retry; an email draft and a member's own review rule without the company row FOR UPDATE; plain conversations,
-- attachments and images refusing folder-v2. Races are in 661.

create function pg_temp.post(p_room uuid, p_client uuid, p_body jsonb, p_binding uuid default '63400000-0000-4000-8000-0000000000b1')
returns jsonb language sql as $$
	select public.qorpera_post_company_room_message(p_room, p_client, p_body, p_binding, 1)
$$;
create function pg_temp.prompt(p_text text) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text)
$$;
create function pg_temp.thread_room(p_staff uuid) returns uuid language sql as $$
	select id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_staff
$$;
create function pg_temp.admitted() returns bigint language sql as $$
	select admitted from public.qorpera_folder_admissions where profile_id = '63400000-0000-4000-8000-000000000010'
$$;
create function pg_temp.without_guard(p_definition text) returns text language plpgsql as $$
declare v_body integer := position('$function$' in p_definition); v_at integer; v_end integer;
begin
	v_at := v_body + position(E'\nbegin\n' in substr(p_definition, v_body)) - 1 + length(E'\nbegin\n');
	v_end := v_at + position(E'\n' in substr(p_definition, v_at));
	return substr(p_definition, 1, v_at - 1) || substr(p_definition, v_end);
end $$;
create function pg_temp.guarded(p_fn text, p_line text, p_md5 text) returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn::regprocedure);
begin
	if position(E'\nbegin\n\t' || p_line in v_def) = 0 or md5(pg_temp.without_guard(v_def)) <> p_md5 then
		raise exception 'The snapshot-v1 body of % changed', p_fn; end if;
end $$;

-- 1. Snapshot-v1 keeps its text: the guarded bodies without their first line, the patched ones with each patch reversed.
do $$
declare v_def text;
begin
	perform pg_temp.guarded('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)',
		'if public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_company_rooms where id = p_room_id)) then',
		'a2855619c55a2b7b84a3f6f436eefab2');
	perform pg_temp.guarded('public.qorpera_append_session_input(uuid,uuid,text,jsonb)',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception', '5cefad1d5b1b3cb674b0da8c7188e78a');
	-- 20260928319750 checks the caller's role before the session row lock in both turn requests.
	perform pg_temp.guarded('public.qorpera_request_session_turn(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception', '3d34c736990ae3981be314a2f91f0865');
	perform pg_temp.guarded('public.qorpera_request_session_turn_v2(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception', 'c686c32d20a604c8567d402d3070ed43');
	perform pg_temp.guarded('public.qorpera_begin_member_session_attachment_upload(uuid,uuid,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception', 'c0d997043587eef3b9aaf206ec40b426');
	perform pg_temp.guarded('public.qorpera_stage_member_session_attachment(uuid,boolean)',
		'if public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_member_session_attachment_uploads', '5719b15198298781e258c05dd727cc31');
	perform pg_temp.guarded('public.qorpera_require_member_session_attachment_uploads()',
		'if jsonb_typeof(new.body -> ''images'') = ''array'' and jsonb_array_length(new.body -> ''images'') > 0 and', '653ab54d255f9c03b429410380d94053');
	v_def := pg_get_functiondef('public.qorpera_retry_room_delivery(uuid,uuid,bigint)'::regprocedure);
	v_def := replace(v_def, substr(v_def, position(E'\tif public.qorpera_company_is_folder_v2(v_run.profile_id) then\n\t\tselect * into v_room' in v_def),
		position(E'\telse\n\tperform public.qorpera_lock_profile_gc_fence(v_run.profile_id);\n' in v_def)
		- position(E'\tif public.qorpera_company_is_folder_v2(v_run.profile_id) then\n\t\tselect * into v_room' in v_def) + length(E'\telse\n')), '');
	v_def := replace(v_def, E'\tselect * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id for share;\n\tend if;\n',
		E'\tselect * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id for share;\n');
	v_def := replace(v_def, E'\tif public.qorpera_company_is_folder_v2(v_run.profile_id) then\n\t\tperform public.qorpera_folder_admit_wakes(v_run.profile_id);\n\tend if;\n', '');
	if md5(v_def) <> '651ea250acf28dc6caaf20d07f8400e5' then raise exception 'The retry''s snapshot-v1 text changed'; end if;
	if md5(replace(pg_get_functiondef('public.qorpera_get_email_draft(uuid,uuid)'::regprocedure),
			E' if not public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then\n'
			|| E' perform public.qorpera_lock_profile_gc_fence(public.qorpera_session_profile_id(p_session_id));\n'
			|| E' end if;\n',
			E' perform public.qorpera_lock_profile_gc_fence(public.qorpera_session_profile_id(p_session_id));\n'))
		<> '2128c1efe83f2cff527ac4e416b6bf43' then raise exception 'The email draft''s snapshot-v1 text changed'; end if;
	if md5(replace(pg_get_functiondef('public.qorpera_save_review_rule(uuid,uuid,text,text,text)'::regprocedure),
			E'\tif exists (select 1 from public.qorpera_company_files f where f.profile_id = p_profile_id and f.core = ''folder-v2'') then\n'
			|| E'\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for key share;\n'
			|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_user for no key update;\n'
			|| E'\t\tif not found then raise exception ''Only members of this company can write rules'' using errcode = ''42501''; end if;\n'
			|| E'\telse\n'
			|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
			|| E'\tend if;\n',
			E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'))
		<> '0a9b54ff8466f641e78e028adfeedf35' then raise exception 'The review rule''s snapshot-v1 text changed'; end if;
end $$;

-- 2. The enter helper: only a folder-v2 company; the pause refuses when asked; targets never name the company row (the
-- helper takes it) or a rank it does not lock.
do $$
begin
	perform public.qorpera_folder_company_enter('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', '[]', true);
	perform pg_temp.raises_like(format('select public.qorpera_folder_company_enter(%L, %L, %L, true)', '64700000-0000-4000-8000-000000000021',
		'64700000-0000-4000-8000-000000000011', '[]'), '42501', 'Company folder is unavailable');
	perform pg_temp.raises_like(format('select public.qorpera_folder_company_enter(%L, %L, %L, true)', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', '[{"rank":0,"tbl":"qorpera_profiles","key":"63400000-0000-4000-8000-000000000010","mode":"keyshare"}]'),
		'XX000', 'Folder lock targets are malformed');
	perform pg_temp.raises_like(format('select public.qorpera_folder_company_enter(%L, %L, %L, true)', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', '[{"rank":8,"tbl":"qorpera_cloud_secrets","key":"x","mode":"keyshare"}]'),
		'XX000', 'Folder lock targets are malformed');
	perform pg_temp.fx('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values
		(''63400000-0000-4000-8000-000000000010'', ''63400000-0000-4000-8000-000000000001'', ''test'')');
	perform pg_temp.raises_like(format('select public.qorpera_folder_company_enter(%L, %L, %L, true)', '63400000-0000-4000-8000-000000000020',
		'63400000-0000-4000-8000-000000000010', '[]'), '55000', 'Company execution is paused');
	perform public.qorpera_folder_company_enter('63400000-0000-4000-8000-000000000020', '63400000-0000-4000-8000-000000000010', '[]', false);
	perform pg_temp.fx('delete from public.qorpera_company_execution_pauses where profile_id = ''63400000-0000-4000-8000-000000000010''');
end $$;

-- 3. Posting in an agent's thread: the input, the transcript events, admission and the agent's room wake; a replay adds
-- nothing; images, a non-member and the pause refuse; images refuse first, before the pause and the login checks.
do $$
declare
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; v_room uuid := pg_temp.thread_room(c_a);
	v_session uuid := (select session_id from public.qorpera_company_rooms where id = pg_temp.thread_room(c_a));
	v_before bigint := pg_temp.admitted(); r jsonb; r2 jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	r := pg_temp.post(v_room, '66000000-0000-4000-8000-0000000000c1', pg_temp.prompt('Can you check the numbers?'));
	select * into v_wake from public.qorpera_wake_occurrences where id = (r -> 'occurrenceIds' ->> 0)::uuid;
	if jsonb_array_length(r -> 'occurrenceIds') <> 1 or v_wake.wake_kind <> 'room' or v_wake.staff_agent_id <> c_a
		or v_wake.session_id <> v_session or v_wake.status <> 'queued' or v_wake.requested_by_user_id <> '63400000-0000-4000-8000-000000000001'
		or pg_temp.admitted() <> v_before + 1
		or not exists (select 1 from public.qorpera_session_events where session_id = v_session
			and body::text like '%' || (r ->> 'inputId') || '%') then
		raise exception 'A folder-v2 post in an agent''s thread: % %', r, to_jsonb(v_wake); end if;
	r2 := pg_temp.post(v_room, '66000000-0000-4000-8000-0000000000c1', pg_temp.prompt('Can you check the numbers?'));
	if r2 <> r or pg_temp.admitted() <> v_before + 1 then raise exception 'A replayed post: %', r2; end if;
	perform pg_temp.raises_like(format('select pg_temp.post(%L, %L, %L)', v_room, '66000000-0000-4000-8000-0000000000c1',
		pg_temp.prompt('Something else')), '23505', 'Room input id is bound to different content');
	perform pg_temp.raises_like(format('select pg_temp.post(%L, %L, %L)', v_room, extensions.gen_random_uuid(),
		pg_temp.prompt('See this') || jsonb_build_object('images', jsonb_build_array(jsonb_build_object('objectSha256', repeat('a', 64),
			'bytes', 100, 'mediaType', 'image/png')))), '0A000', 'Images in conversations do not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format('select pg_temp.post(%L, %L, %L, %L)', v_room, extensions.gen_random_uuid(),
		pg_temp.prompt('See this') || jsonb_build_object('images', jsonb_build_array(jsonb_build_object('objectSha256', repeat('a', 64),
			'bytes', 100, 'mediaType', 'image/png'))), extensions.gen_random_uuid()), '0A000',
		'Images in conversations do not serve folder-v2 companies yet');
	perform pg_temp.fx('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values
		(''63400000-0000-4000-8000-000000000010'', ''63400000-0000-4000-8000-000000000001'', ''test'')');
	perform pg_temp.raises_like(format('select pg_temp.post(%L, %L, %L)', v_room, extensions.gen_random_uuid(),
		pg_temp.prompt('See this') || jsonb_build_object('images', jsonb_build_array(jsonb_build_object('objectSha256', repeat('a', 64),
			'bytes', 100, 'mediaType', 'image/png')))), '0A000', 'Images in conversations do not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format('select pg_temp.post(%L, %L, %L)', v_room, extensions.gen_random_uuid(), pg_temp.prompt('Hi')),
		'55000', 'Company execution is paused');
	perform pg_temp.fx('delete from public.qorpera_company_execution_pauses where profile_id = ''63400000-0000-4000-8000-000000000010''');
	perform pg_temp.path_claims('authenticated', '64700000-0000-4000-8000-0000000000ff');
	perform pg_temp.raises_like(format('select pg_temp.post(%L, %L, %L)', v_room, extensions.gen_random_uuid(), pg_temp.prompt('Hi')),
		'42501', 'Room is unavailable');
	-- The snapshot-v1 post is not refused as folder-v2 (the control company has no room: its own refusal).
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.not_refused(format('select pg_temp.post(%L, %L, %L)', extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		pg_temp.prompt('Hi')));
	perform pg_temp.path_claims('service_role');
end $$;

-- 4. A group chat with no agent: the post lands, with no wake and no admission.
do $$
declare v_room uuid := extensions.gen_random_uuid(); v_session uuid := extensions.gen_random_uuid(); v_before bigint := pg_temp.admitted(); r jsonb;
begin
	perform pg_temp.fx(format($f$insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id,
		audience_kind, execution_scope) values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'Planning',
		'63400000-0000-4000-8000-000000000001', 'company', jsonb_build_object('roomId', %L))$f$, v_session, v_room));
	perform pg_temp.fx(format($f$insert into public.qorpera_company_rooms(id, profile_id, environment_id, room_key, name, purpose, status, version,
		source_path, source_path_version, source_snapshot_id, source_file_sha256, created_by_user_id, session_id)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020',
		'planning', 'Planning', 'Plans.', 'active', 1, 'organization/rooms/planning.json', extensions.gen_random_uuid(),
		extensions.gen_random_uuid(), repeat('e', 64), '63400000-0000-4000-8000-000000000001', %L)$f$,
		v_room, v_session));
	perform pg_temp.fx(format($f$insert into public.qorpera_company_room_members(room_id, principal_kind, principal_id, status, source_path_version)
		values (%L, 'member', '63400000-0000-4000-8000-000000000001', 'active', extensions.gen_random_uuid())$f$, v_room));
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	r := pg_temp.post(v_room, extensions.gen_random_uuid(), pg_temp.prompt('Plans for Q4.'));
	perform pg_temp.path_claims('service_role');
	if jsonb_array_length(r -> 'occurrenceIds') <> 0 or pg_temp.admitted() <> v_before
		or not exists (select 1 from public.qorpera_session_inputs where id = (r ->> 'inputId')::uuid and session_id = v_session) then
		raise exception 'A post in a group chat with no agent: %', r; end if;
end $$;

-- 5. A room delivery's retry: its failed run's author asks again; the folder enter and admission, then a new wake.
do $$
declare
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; v_room uuid := pg_temp.thread_room(c_a); r jsonb; v jsonb;
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_before bigint;
begin
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	r := pg_temp.post(v_room, extensions.gen_random_uuid(), pg_temp.prompt('Please retry this.'));
	perform pg_temp.path_claims('service_role');
	-- The wake's run failed (hand-built: a room delivery run and its failed job).
	perform pg_temp.fx(format($f$insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id,
		required_capability, job_type, payload, created_by_user_id, status, finished_at, run_id) values (%L, '63400000-0000-4000-8000-000000000010',
		'63400000-0000-4000-8000-000000000020', extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		'63400000-0000-4000-8000-000000000001', 'failed', clock_timestamp(), %L)$f$, v_job, v_run));
	perform pg_temp.fx(format($f$insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id,
		substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability,
		job_type, payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id,
		model_selection, audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
		values (%L, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'room_delivery', %L, %L,
			extensions.gen_random_uuid(), extensions.gen_random_uuid(), %L, 1, '63400000-0000-4000-8000-0000000000b1', 1, 'agent_turn',
			'agent_turn', repeat('c', 64), 0, '63400000-0000-4000-8000-000000000001', '63400000-0000-4000-8000-000000000001', 'openai',
			'gpt-test', 'provider_default', 'company', extensions.gen_random_uuid(), repeat('b', 64),
			(select session_id from public.qorpera_company_rooms where id = %L), '{}')$f$,
		v_run, r -> 'occurrenceIds' ->> 0, v_job, c_a, v_room));
	perform pg_temp.fx(format('update public.qorpera_wake_occurrences set run_id = %L, status = %L where id = %L', v_run, 'materialized',
		r -> 'occurrenceIds' ->> 0));
	v_before := pg_temp.admitted();
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	v := public.qorpera_retry_room_delivery(v_run, '63400000-0000-4000-8000-0000000000b1', 1);
	perform pg_temp.path_claims('service_role');
	if v ->> 'occurrenceId' is null or pg_temp.admitted() <> v_before + 1
		or (select status from public.qorpera_wake_occurrences where id = (v ->> 'occurrenceId')::uuid) is distinct from 'queued'
		or not exists (select 1 from public.qorpera_execution_run_events where run_id = v_run and event_type = 'recovery_released') then
		raise exception 'A folder-v2 room retry: %', v; end if;
end $$;

-- 6. A member's own review rule on folder-v2 saves and changes (the member's row, not the company row); a company rule
-- stays in rules/.
do $$
declare v jsonb; v_rule uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000002');
	v := public.qorpera_save_review_rule('63400000-0000-4000-8000-000000000010', v_rule, 'member', 'Sending money', 'ask_first');
	v := public.qorpera_save_review_rule('63400000-0000-4000-8000-000000000010', v_rule, 'member', 'Sending money abroad', 'ask_first');
	if (select when_text from public.qorpera_review_rules where id = v_rule) is distinct from 'Sending money abroad'
		or (select member_user_id from public.qorpera_review_rules where id = v_rule) is distinct from '63400000-0000-4000-8000-000000000002' then
		raise exception 'A member''s own rule on folder-v2: %', v; end if;
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_save_review_rule(%L, %L, %L, %L, %L)', '63400000-0000-4000-8000-000000000010',
		extensions.gen_random_uuid(), 'company', 'Deleting files', 'ask_first'), '55000', '%rules/%');
	perform pg_temp.path_claims('service_role');
end $$;

-- 7. An email draft on folder-v2 goes past the company row (no fence) to its own checks.
do $$
declare c_a constant uuid := '63400000-0000-4000-8000-0000000000a1';
begin
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_get_email_draft(%L, %L)',
		(select session_id from public.qorpera_company_rooms where id = pg_temp.thread_room(c_a)), extensions.gen_random_uuid()),
		'22023', 'email draft unavailable');
	perform pg_temp.path_claims('service_role');
end $$;

-- 8. Plain conversations, their attachments and images in any folder-v2 input, inserted or changed, refuse.
do $$
declare c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; v_session uuid;
	v_upload uuid := extensions.gen_random_uuid();
begin
	v_session := (select session_id from public.qorpera_company_rooms where id = pg_temp.thread_room(c_a));
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_append_session_input(%L, %L, %L, %L)', v_session, extensions.gen_random_uuid(),
		'user_message', pg_temp.prompt('Hi')), '0A000', 'This conversation does not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format('select public.qorpera_request_session_turn(%L, %L, %L, %L, %L, null, null, null, null, null)',
		v_session, extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.prompt('Hi'), 'member_connection'),
		'0A000', 'This conversation does not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format('select public.qorpera_request_session_turn_v2(%L, %L, %L, %L, %L, null, null, null, null, null)',
		v_session, extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.prompt('Hi'), 'member_connection'),
		'0A000', 'This conversation does not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format('select public.qorpera_begin_member_session_attachment_upload(%L, %L, %L, 100, %L)', v_session,
		extensions.gen_random_uuid(), repeat('a', 64), 'image/png'), '0A000', 'Images in conversations do not serve folder-v2 companies yet');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.fx(format($f$insert into public.qorpera_member_session_attachment_uploads(id, profile_id, session_id, user_id,
		client_input_id, sha256, bytes, media_type, expires_at) values (%L, '63400000-0000-4000-8000-000000000010', %L,
		'63400000-0000-4000-8000-000000000001', extensions.gen_random_uuid(), repeat('a', 64), 100, 'image/png',
		clock_timestamp() + interval '1 hour')$f$, v_upload, v_session));
	perform pg_temp.path_claims('authenticated', '63400000-0000-4000-8000-000000000001');
	perform pg_temp.raises_like(format('select public.qorpera_stage_member_session_attachment(%L, true)', v_upload), '0A000',
		'Images in conversations do not serve folder-v2 companies yet');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.raises_like(format($f$insert into public.qorpera_session_inputs(session_id, client_input_id, kind, author_user_id, body)
		values (%L, extensions.gen_random_uuid(), 'user_message', '63400000-0000-4000-8000-000000000001', %L)$f$, v_session,
		pg_temp.prompt('See this') || jsonb_build_object('images', jsonb_build_array(jsonb_build_object('objectSha256', repeat('a', 64),
			'bytes', 100, 'mediaType', 'image/png')))), '0A000', 'Images in conversations do not serve folder-v2 companies yet');
	perform pg_temp.raises_like(format($f$update public.qorpera_session_inputs set body = body || %L
		where session_id = %L and client_input_id = '66000000-0000-4000-8000-0000000000c1'$f$,
		jsonb_build_object('images', jsonb_build_array(jsonb_build_object('objectSha256', repeat('a', 64), 'bytes', 100,
			'mediaType', 'image/png'))), v_session), '0A000', 'Images in conversations do not serve folder-v2 companies yet');
end $$;

-- 9. Privileges: the new functions are postgres-only.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_folder_company_enter(uuid,uuid,jsonb,boolean)',
		'public.qorpera_folder_post_room_message(uuid,uuid,jsonb,uuid,bigint)'] loop
		if has_function_privilege('service_role', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
			or has_function_privilege('anon', v_fn, 'execute') then
			raise exception '% must be postgres-only', v_fn; end if;
	end loop;
end $$;

rollback;
