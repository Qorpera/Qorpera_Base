-- Company folder core, C1c-3a: a member's posts and writes on the folder fence
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6; inventory scratchpad reports/C1c3-inventory.md §1, §3-§9).
--
-- Changes only folder-v2 behaviour; snapshot-v1 keeps every path. On folder-v2 none of these takes the company row FOR
-- UPDATE (the gc fence) any more:
-- * qorpera_folder_company_enter: the prelude of a member's action that has no run: the pause (refused when asked), the
--   folder fence KEY SHARE with the pause read again, this company's row (rank 0), then the targets at ranks 1 to 7.
-- * Posting in a room (qorpera_post_company_room_message): the enter helper with the poster, the room's agents, the room
--   and both memberships, KEY SHARE; the recipients are read again under those locks (a changed room refuses as a
--   retryable conflict); the conversation FOR UPDATE; the input and mentions; the transcript events (the operation
--   clock) before the wakes; admission; the wakes. Images refuse until C1d gives conversations folder bytes.
-- * A room delivery's retry takes the enter helper in place of the gc fence and admission before its wake.
-- * An email draft takes no company row and no fence: the conversation, the draft, the action, as today.
-- * A member's own review rule serializes on the member's row FOR NO KEY UPDATE (rank 1), as an agent's "Ask first"
--   rule does, with the company row KEY SHARE (rank 0) for the rule's foreign key.
-- * Plain conversations (append_session_input, request_session_turn and its v2) refuse folder-v2 (0A000): nothing
--   delivers their turns before C3/C4 give them folder-v2 runs. So do the conversation attachment uploads and any
--   folder-v2 input carrying images.

-- 1. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ------------------------

create function pg_temp.c1c3a_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1c-3a guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1c-3a guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1c-3a guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;
create function pg_temp.c1c3a_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3a patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The enter helper -----------------------------------------------------------------------------------------------

-- The prelude of a member's (or the platform's) action on a folder-v2 company that has no run (core §3 steps 3-4): the
-- pause read, the folder fence KEY SHARE and the pause read again (when the action must stop with the company: every
-- wake inserter), this company's row KEY SHARE (rank 0), then the targets at ranks 1 to 7, merged so the stronger mode
-- wins, as the run entry locks them. Runs keep qorpera_folder_run_enter and qorpera_folder_tool_run.
create function public.qorpera_folder_company_enter(p_environment_id uuid, p_profile_id uuid, p_targets jsonb,
	p_refuse_paused boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_targets jsonb := coalesce(p_targets, '[]'::jsonb);
begin
	if jsonb_typeof(v_targets) is distinct from 'array' or exists (select 1 from jsonb_array_elements(v_targets) t
		where jsonb_typeof(t) <> 'object' or coalesce(t ->> 'rank', '') !~ '^[1-7]$' or t ->> 'tbl' is null or t ->> 'key' is null
			or coalesce(t ->> 'mode', '') not in ('keyshare','share','nokeyupdate','update')
			or t ->> 'tbl' = 'qorpera_profiles' or (t ->> 'rank' in ('6','7') and t ->> 'mode' <> 'keyshare')) then
		raise exception 'Folder lock targets are malformed' using errcode = 'XX000'; end if;
	if not exists (select 1 from public.qorpera_company_files where environment_id = p_environment_id
		and profile_id = p_profile_id and core = 'folder-v2') then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if coalesce(p_refuse_paused, true) and public.qorpera_company_execution_paused(p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for key share;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if coalesce(p_refuse_paused, true) and public.qorpera_company_execution_paused(p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	v_targets := jsonb_build_array(jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles', 'key', p_profile_id::text,
		'mode', 'keyshare', 'required', true)) || v_targets;
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 0::smallint, 0::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 1::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 2::smallint, 2::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 6::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 7::smallint);
end $$;

-- 3. Posting in a room -------------------------------------------------------------------------------------------------

-- Today's rules and result (the room and membership, the prompt, the member's own login, the pause, a replay by client
-- input id, mentions narrowing the agents who answer, one room wake per answering agent), in core §3's order. A post
-- names the room and its agents from an unlocked read; after the locks the agents are read again, and a room whose agents
-- changed meanwhile refuses as a retryable conflict (a post that waited behind a change of the room).
create function public.qorpera_folder_post_room_message(p_room_id uuid, p_client_input_id uuid, p_body jsonb,
	p_sponsor_binding_id uuid, p_sponsor_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room public.qorpera_company_rooms%rowtype; v_user uuid := auth.uid();
	v_input public.qorpera_session_inputs%rowtype; v_staff uuid; v_ids uuid[] := '{}'::uuid[]; v_id uuid; v_text text;
	v_mentioned uuid[] := '{}'::uuid[]; v_agents uuid[]; v_locked uuid[]; v_answering uuid[];
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Room posting requires a member' using errcode = '42501'; end if;
	select * into v_room from public.qorpera_company_rooms where id = p_room_id;
	if not found or v_room.status <> 'active' or v_room.session_id is null
		or not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = v_room.profile_id and member.user_id = v_user)
		or not exists (select 1 from public.qorpera_company_room_members member
			where member.room_id = v_room.id and member.principal_kind = 'member' and member.principal_id = v_user
				and member.status = 'active') then
		raise exception 'Room is unavailable' using errcode = '42501'; end if;
	if p_client_input_id is null or jsonb_typeof(p_body) is distinct from 'object'
		or p_body ->> 'schema' is distinct from 'qorpera.session-prompt/v1'
		or p_body - array['schema','text','images'] <> '{}'::jsonb
		or jsonb_typeof(p_body -> 'text') <> 'string'
		or not public.qorpera_room_post_images_valid(p_body, v_room.bound_staff_agent_id is not null) then
		raise exception 'Room message is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_body -> 'images') = 'array' and jsonb_array_length(p_body -> 'images') > 0 then
		raise exception 'Images in conversations do not serve folder-v2 companies yet' using errcode = '0A000'; end if;
	v_text := p_body ->> 'text';
	if v_text !~ '[^[:space:]]' or octet_length(convert_to(v_text,'utf8')) > 65536 then
		raise exception 'Room message is invalid' using errcode = '22023'; end if;
	if p_sponsor_binding_id is null or p_sponsor_version is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings binding
			join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id and version.version = p_sponsor_version
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_room.profile_id and binding.status = 'active'
				and binding.created_by_user_id = v_user) then
		raise exception 'Room sponsor is unavailable' using errcode = '42501'; end if;
	-- The room's agents, as the answering loop reads them.
	v_agents := array(select member.principal_id from public.qorpera_company_room_members member
		join public.qorpera_profile_staff staff on staff.profile_id = v_room.profile_id
			and staff.staff_agent_id = member.principal_id and staff.employment_status = 'active'
		where member.room_id = v_room.id and member.principal_kind = 'staff_agent' and member.status = 'active'
		order by member.principal_id);
	perform public.qorpera_folder_company_enter(v_room.environment_id, v_room.profile_id,
		jsonb_build_array(
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_room.profile_id::text || ':' || v_user::text,
				'mode', 'keyshare', 'required', true),
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_rooms', 'key', v_room.id::text, 'mode', 'keyshare', 'required', true),
			jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members', 'key', v_room.id::text || ':member:' || v_user::text,
				'mode', 'keyshare', 'required', true))
		|| coalesce((select jsonb_agg(t) from unnest(v_agents) a(id), lateral (values
			(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_room.profile_id::text || ':' || a.id::text,
				'mode', 'keyshare', 'required', false)),
			(jsonb_build_object('rank', 4, 'tbl', 'qorpera_company_room_members', 'key', v_room.id::text || ':staff_agent:' || a.id::text,
				'mode', 'keyshare', 'required', false))) x(t)), '[]'::jsonb),
		true);
	-- Read again under the locks: the room, the poster's place in it, and its agents.
	select * into v_room from public.qorpera_company_rooms where id = p_room_id;
	if v_room.status <> 'active' or v_room.session_id is null
		or not exists (select 1 from public.qorpera_company_room_members member
			where member.room_id = v_room.id and member.principal_kind = 'member' and member.principal_id = v_user
				and member.status = 'active') then
		raise exception 'Room is unavailable' using errcode = '42501'; end if;
	v_locked := array(select member.principal_id from public.qorpera_company_room_members member
		join public.qorpera_profile_staff staff on staff.profile_id = v_room.profile_id
			and staff.staff_agent_id = member.principal_id and staff.employment_status = 'active'
		where member.room_id = v_room.id and member.principal_kind = 'staff_agent' and member.status = 'active'
		order by member.principal_id);
	if v_locked is distinct from v_agents then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Room changed while the message waited', 'details', null, 'hint', null)::text, detail = '{"status":409,"headers":{}}'; end if;
	-- The conversation, FOR UPDATE, before its first write (C1C §5.6).
	perform 1 from public.qorpera_shared_sessions where id = v_room.session_id and status = 'open' for update;
	if not found then raise exception 'Room conversation is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_shared_sessions session
		where session.id = v_room.session_id and session.profile_id = v_room.profile_id
			and session.environment_id = v_room.environment_id and session.execution_scope ->> 'roomId' = v_room.id::text) then
		raise exception 'Room transcript binding is unavailable' using errcode = '42501'; end if;
	select * into v_input from public.qorpera_session_inputs
	where session_id = v_room.session_id and client_input_id = p_client_input_id;
	if found then
		if v_input.author_user_id <> v_user or v_input.body <> p_body then
			raise exception 'Room input id is bound to different content' using errcode = '23505'; end if;
		select coalesce(array_agg(id order by staff_agent_id),'{}'::uuid[]) into v_ids from public.qorpera_wake_occurrences
		where wake_kind = 'room' and source_kind = 'room' and source_id = v_input.id;
		perform public.qorpera_append_admitted_input_events(v_room.session_id, array[v_input.id]);
	else
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body,completed_at)
		values (v_room.session_id,p_client_input_id,'user_message',v_user,p_body,clock_timestamp()) returning * into v_input;
		-- Mentions (20260928010000): agents named alone answer; members named are told.
		v_mentioned := public.qorpera_record_room_mentions(v_room.id,v_input.id,v_user,v_text);
		v_answering := array(select a from unnest(v_locked) a where cardinality(v_mentioned) = 0 or a = any(v_mentioned) order by a);
		-- The transcript events (the operation clock) before admission, which is the last lock before the folder clock.
		perform public.qorpera_append_admitted_input_events(v_room.session_id, array[v_input.id]);
		if cardinality(v_answering) > 0 then
			perform public.qorpera_folder_admit_wakes(v_room.profile_id);
		end if;
		foreach v_staff in array v_answering loop
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,
				staff_agent_id,requested_by_user_id,sponsor_binding_id,sponsor_version,session_id,trigger_id,occurrence_key,
				scheduled_for,not_before,payload)
			values (v_id,v_room.profile_id,v_room.environment_id,'room','room',v_input.id,v_staff,v_user,
				p_sponsor_binding_id,p_sponsor_version,v_room.session_id,'room',
				'room:' || v_room.id::text || ':' || v_input.id::text || ':' || v_staff::text,
				clock_timestamp(),clock_timestamp(),
				jsonb_build_object('roomId',v_room.id,'inputIds',jsonb_build_array(v_input.id),'recipientStaffId',v_staff));
			v_ids := array_append(v_ids,v_id);
		end loop;
	end if;
	return jsonb_build_object('schema','qorpera.company-room-post/v1','roomId',v_room.id,'sessionId',v_room.session_id,
		'inputId',v_input.id,'occurrenceIds',to_jsonb(v_ids));
end $$;

-- 4. Dispatch and patches ------------------------------------------------------------------------------------------

do $$
declare c_plain constant text := 'This conversation does not serve folder-v2 companies yet';
begin
	perform pg_temp.c1c3a_guard('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)',
		'if public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_company_rooms where id = p_room_id)) then '
		|| 'return public.qorpera_folder_post_room_message(p_room_id, p_client_input_id, p_body, p_sponsor_binding_id, p_sponsor_version); end if;');

	-- A room delivery's retry: the enter helper (the author, the agent, the room and both memberships) in place of the gc
	-- fence, and admission before its wake. Its job and run locks come first, as today (core §3 step 2).
	perform pg_temp.c1c3a_replace('public.qorpera_retry_room_delivery(uuid,uuid,bigint)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_run.profile_id);\n'
		|| E'\tselect * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id for share;\n',
		E'\tif public.qorpera_company_is_folder_v2(v_run.profile_id) then\n'
		|| E'\t\tselect * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id;\n'
		|| E'\t\tif v_room.id is null then raise exception ''Room is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\t\tperform public.qorpera_folder_company_enter(v_run.environment_id, v_run.profile_id, jsonb_build_array(\n'
		|| E'\t\t\tjsonb_build_object(''rank'', 1, ''tbl'', ''qorpera_profile_members'', ''key'', v_run.profile_id::text || '':'' || v_user::text,\n'
		|| E'\t\t\t\t''mode'', ''keyshare'', ''required'', false),\n'
		|| E'\t\t\tjsonb_build_object(''rank'', 2, ''tbl'', ''qorpera_profile_staff'', ''key'', v_run.profile_id::text || '':'' || v_wake.staff_agent_id::text,\n'
		|| E'\t\t\t\t''mode'', ''keyshare'', ''required'', false),\n'
		|| E'\t\t\tjsonb_build_object(''rank'', 4, ''tbl'', ''qorpera_company_rooms'', ''key'', v_room.id::text, ''mode'', ''keyshare'', ''required'', false),\n'
		|| E'\t\t\tjsonb_build_object(''rank'', 4, ''tbl'', ''qorpera_company_room_members'', ''key'', v_room.id::text || '':member:'' || v_user::text,\n'
		|| E'\t\t\t\t''mode'', ''keyshare'', ''required'', false),\n'
		|| E'\t\t\tjsonb_build_object(''rank'', 4, ''tbl'', ''qorpera_company_room_members'',\n'
		|| E'\t\t\t\t''key'', v_room.id::text || '':staff_agent:'' || v_wake.staff_agent_id::text, ''mode'', ''keyshare'', ''required'', false)), true);\n'
		|| E'\t\tselect * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id;\n'
		|| E'\telse\n'
		|| E'\tperform public.qorpera_lock_profile_gc_fence(v_run.profile_id);\n'
		|| E'\tselect * into v_room from public.qorpera_company_rooms where session_id = v_wake.session_id for share;\n'
		|| E'\tend if;\n', 1);
	perform pg_temp.c1c3a_replace('public.qorpera_retry_room_delivery(uuid,uuid,bigint)',
		E'\tinsert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,\n',
		E'\tif public.qorpera_company_is_folder_v2(v_run.profile_id) then\n'
		|| E'\t\tperform public.qorpera_folder_admit_wakes(v_run.profile_id);\n'
		|| E'\tend if;\n'
		|| E'\tinsert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,\n', 1);

	-- An email draft on folder-v2: no company row and no fence (it inserts no row that names the company); the
	-- conversation, the draft and the action, as today.
	perform pg_temp.c1c3a_replace('public.qorpera_get_email_draft(uuid,uuid)',
		E' perform public.qorpera_lock_profile_gc_fence(public.qorpera_session_profile_id(p_session_id));\n',
		E' if not public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then\n'
		|| E' perform public.qorpera_lock_profile_gc_fence(public.qorpera_session_profile_id(p_session_id));\n'
		|| E' end if;\n', 1);

	-- A member's own review rule on folder-v2: the company row KEY SHARE (rank 0, for the rule's foreign key), then the
	-- member's row FOR NO KEY UPDATE (rank 1), where an agent's "Ask first" rule for this member serializes too.
	perform pg_temp.c1c3a_replace('public.qorpera_save_review_rule(uuid,uuid,text,text,text)',
		E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n',
		E'\tif exists (select 1 from public.qorpera_company_files f where f.profile_id = p_profile_id and f.core = ''folder-v2'') then\n'
		|| E'\t\tperform 1 from public.qorpera_profiles where id = p_profile_id for key share;\n'
		|| E'\t\tperform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_user for no key update;\n'
		|| E'\telse\n'
		|| E'\tperform 1 from public.qorpera_profiles where id = p_profile_id for update;\n'
		|| E'\tend if;\n', 1);

	-- Plain conversations and their attachments refuse folder-v2 until C3/C4 give them folder-v2 runs and C1d bytes.
	perform pg_temp.c1c3a_guard('public.qorpera_append_session_input(uuid,uuid,text,jsonb)',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception '''
		|| c_plain || ''' using errcode = ''0A000''; end if;');
	perform pg_temp.c1c3a_guard('public.qorpera_request_session_turn(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception '''
		|| c_plain || ''' using errcode = ''0A000''; end if;');
	perform pg_temp.c1c3a_guard('public.qorpera_request_session_turn_v2(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception '''
		|| c_plain || ''' using errcode = ''0A000''; end if;');
	perform pg_temp.c1c3a_guard('public.qorpera_begin_member_session_attachment_upload(uuid,uuid,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(p_session_id)) then raise exception '
		|| '''Images in conversations do not serve folder-v2 companies yet'' using errcode = ''0A000''; end if;');
	perform pg_temp.c1c3a_guard('public.qorpera_stage_member_session_attachment(uuid,boolean)',
		'if public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_member_session_attachment_uploads where id = p_upload_id)) then '
		|| 'raise exception ''Images in conversations do not serve folder-v2 companies yet'' using errcode = ''0A000''; end if;');
	-- The upload check returns early for any company not on the path gateway, folder-v2 included: an input with images
	-- on folder-v2 refuses instead.
	perform pg_temp.c1c3a_guard('public.qorpera_require_member_session_attachment_uploads()',
		'if tg_op = ''INSERT'' and jsonb_typeof(new.body -> ''images'') = ''array'' and jsonb_array_length(new.body -> ''images'') > 0 '
		|| 'and public.qorpera_company_is_folder_v2(public.qorpera_session_profile_id(new.session_id)) then raise exception '
		|| '''Images in conversations do not serve folder-v2 companies yet'' using errcode = ''0A000''; end if;');
end $$;

-- 5. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through the dispatchers and the folder paths.
revoke all on function public.qorpera_folder_company_enter(uuid, uuid, jsonb, boolean) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_post_room_message(uuid, uuid, jsonb, uuid, bigint)
	from public, anon, authenticated, service_role;
