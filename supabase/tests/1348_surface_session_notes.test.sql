-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ssn_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_session_notes: %', p_message;
	end if;
end $$;

create function pg_temp.ssn_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.ssn_refusal(p_user_id uuid, p_statement text)
returns text language plpgsql as $$
begin
	perform pg_temp.ssn_as(p_user_id);
	set local role authenticated;
	execute p_statement;
	reset role;
	return 'ok';
exception when others then
	reset role;
	return sqlstate;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_eve constant uuid := '13480000-0000-4000-8000-000000000005';
	v_vic constant uuid := '13480000-0000-4000-8000-000000000006';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_surface uuid;
	v_session_id uuid;
	v_json jsonb;
	v_note jsonb;
	v_before public.qorpera_surface_sessions%rowtype;
	v_after public.qorpera_surface_sessions%rowtype;
	v_wakes integer;
	v_claimed jsonb;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into auth.users(id, email) values (v_eve, 'eve-ssn@example.test'), (v_vic, 'vic-ssn@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values (v_company, v_vic, 'vic-ssn@example.test', 'Vic', 'viewer');

	perform pg_temp.ssn_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_company, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true) ->> 'id')::uuid;
	v_json := public.qorpera_start_surface_session(v_surface, 'Warm the accent', 'Accent');
	reset role;
	v_session_id := (v_json ->> 'id')::uuid;
	perform pg_temp.ssn_assert(
		(v_json ->> 'turnRequestedByUserId')::uuid = v_anna,
		'a session nobody replied to shows its starter''s turn'
	);

	perform pg_temp.ssn_as(v_bo);
	set local role authenticated;
	v_json := public.qorpera_reply_surface_session(v_session_id, 'Make it a little darker', true);
	reset role;
	perform pg_temp.ssn_assert(
		(v_json ->> 'turnRequestedByUserId')::uuid = v_bo and (v_json ->> 'createdByUserId')::uuid = v_anna,
		'a teammate''s reply shows the teammate''s turn and keeps the starter'
	);
	perform pg_temp.ssn_assert(
		(select bool_and(message -> 'noteTo' = 'null'::jsonb) from jsonb_array_elements(v_json -> 'messages') message),
		'replies carry no note recipients'
	);

	update public.qorpera_surface_sessions
	set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null, updated_at = clock_timestamp() - interval '1 minute'
	where id = v_session_id;
	select * into strict v_before from public.qorpera_surface_sessions where id = v_session_id;
	select count(*) into v_wakes from public.qorpera_wake_occurrences where source_id = v_session_id;

	perform pg_temp.ssn_as(v_bo);
	set local role authenticated;
	v_json := public.qorpera_surface_session_note(v_session_id, '  @Anna does the accent look right?  ', array[v_anna, v_anna]);
	reset role;
	select message into v_note from jsonb_array_elements(v_json -> 'messages') message where message ->> 'authorKind' = 'note';
	perform pg_temp.ssn_assert(
		v_note ->> 'text' = '@Anna does the accent look right?'
			and (v_note ->> 'authorUserId')::uuid = v_bo
			and v_note -> 'noteTo' = jsonb_build_array(v_anna),
		'a note is kept as the author''s note to each teammate it names, once'
	);
	select * into strict v_after from public.qorpera_surface_sessions where id = v_session_id;
	perform pg_temp.ssn_assert(
		v_after.state = 'ready' and v_after.updated_at = v_before.updated_at and v_after.wake_id is null
			and v_after.lease_token is null and v_after.retry_count = v_before.retry_count
			and v_after.turn_requested_by_user_id = v_bo and v_after.has_active_chat = v_before.has_active_chat,
		'a note never queues, wakes or takes over the session'
	);
	perform pg_temp.ssn_assert(
		(select count(*) from public.qorpera_wake_occurrences where source_id = v_session_id) = v_wakes,
		'a note makes no wake'
	);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	reset role;
	perform pg_temp.ssn_assert(
		not exists (
			select 1 from jsonb_array_elements(coalesce(v_claimed -> 'sessions', '[]'::jsonb)) elem
			where (elem ->> 'sessionId')::uuid = v_session_id
		),
		'the sessions lane never claims a session for a note'
	);
	perform pg_temp.ssn_assert(
		(select m.id from public.qorpera_surface_session_messages m
			where m.session_id = v_session_id and m.author_kind = 'member'
			order by m.created_at desc, m.id desc limit 1)
		= (select m.id from public.qorpera_surface_session_messages m
			where m.session_id = v_session_id and m.author_user_id = v_bo and m.body = 'Make it a little darker'),
		'the latest member message a turn reads is still the reply, never the note'
	);

	perform pg_temp.ssn_as(v_anna);
	set local role authenticated;
	v_json := public.qorpera_surface_unseen_notes(v_company);
	reset role;
	perform pg_temp.ssn_assert(
		v_json = jsonb_build_array(jsonb_build_object('surfaceId', v_surface, 'sessionId', v_session_id, 'count', 1)),
		'the teammate named sees the unseen note'
	);
	perform pg_temp.ssn_as(v_bo);
	set local role authenticated;
	perform pg_temp.ssn_assert(public.qorpera_surface_unseen_notes(v_company) = '[]'::jsonb, 'the author has nothing unseen');
	perform pg_temp.ssn_assert(public.qorpera_surface_notes_seen(v_session_id) = 0, 'the author marks nothing seen');
	reset role;
	perform pg_temp.ssn_as(v_anna);
	set local role authenticated;
	perform pg_temp.ssn_assert(public.qorpera_surface_notes_seen(v_session_id) = 1, 'the teammate marks the note seen');
	perform pg_temp.ssn_assert(public.qorpera_surface_unseen_notes(v_company) = '[]'::jsonb, 'a seen note is no longer listed');
	reset role;

	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_bo, format('select public.qorpera_surface_session_note(%L, %L, array[%L]::uuid[])', v_session_id, 'Me?', v_bo)) = '22023',
		'a note to oneself is refused'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_bo, format('select public.qorpera_surface_session_note(%L, %L, %L::uuid[])', v_session_id, 'Anyone?', '{}')) = '22023',
		'a note naming nobody is refused'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_bo, format('select public.qorpera_surface_session_note(%L, %L, array[%L]::uuid[])', v_session_id, '  ', v_anna)) = '22023',
		'an empty note is refused'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_bo, format('select public.qorpera_surface_session_note(%L, %L, array[%L, %L]::uuid[])', v_session_id, 'Hi', v_anna, v_eve)) = '42501',
		'a note naming someone outside the company is refused'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_eve, format('select public.qorpera_surface_session_note(%L, %L, array[%L]::uuid[])', v_session_id, 'Hi', v_anna)) = '42501',
		'someone outside the company cannot write a note'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_vic, format('select public.qorpera_surface_session_note(%L, %L, array[%L]::uuid[])', v_session_id, 'Hi', v_anna)) = '42501',
		'a viewer cannot write a note'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_vic, format('select public.qorpera_surface_unseen_notes(%L)', v_company)) = 'ok',
		'a viewer reads their own unseen notes'
	);
	perform pg_temp.ssn_assert(
		pg_temp.ssn_refusal(v_eve, format('select public.qorpera_surface_unseen_notes(%L)', v_company)) = '42501'
			and pg_temp.ssn_refusal(v_eve, format('select public.qorpera_surface_notes_seen(%L)', v_session_id)) = '42501',
		'someone outside the company reads and marks nothing'
	);
	perform pg_temp.ssn_assert(
		(select count(*) from public.qorpera_surface_session_messages where session_id = v_session_id and author_kind = 'note') = 1,
		'refused notes leave nothing behind'
	);

	perform pg_temp.ssn_assert(
		has_function_privilege('authenticated', 'public.qorpera_surface_session_note(uuid,text,uuid[])', 'execute')
			and not has_function_privilege('anon', 'public.qorpera_surface_session_note(uuid,text,uuid[])', 'execute')
			and not has_function_privilege('anon', 'public.qorpera_surface_unseen_notes(uuid)', 'execute')
			and not has_function_privilege('service_role', 'public.qorpera_surface_notes_seen(uuid)', 'execute'),
		'the note RPCs are for signed-in members only'
	);

	reset role;
	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_company, v_session_id, 'member', v_bo, 'Make the accent darker please');
	update public.qorpera_surface_sessions set state = 'running', lease_token = '13480000-0000-4000-8000-000000000001'
	where id = v_session_id;
	v_json := public.qorpera_native_surface_read_session_turn(v_company, v_session_id, '13480000-0000-4000-8000-000000000001');
	perform pg_temp.ssn_assert(
		strpos(v_json ->> 'prompt', 'Make the accent darker please') > 0
			and strpos(v_json ->> 'prompt', 'does the accent look right?') = 0,
		'a folder turn reads the member reply but never the note'
	);
end $$;
