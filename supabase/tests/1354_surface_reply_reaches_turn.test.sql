-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.srrt_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_reply_reaches_turn: %', p_message;
	end if;
end $$;

create function pg_temp.srrt_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.srrt_turn(p_profile_id uuid, p_session_id uuid, p_lease uuid)
returns text language plpgsql as $$
declare v_prompt text;
begin
	update public.qorpera_surface_sessions set state = 'running', lease_token = p_lease where id = p_session_id;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_prompt := public.qorpera_native_surface_read_session_turn(p_profile_id, p_session_id, p_lease) ->> 'prompt';
	reset role;
	return v_prompt;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_opening constant text := 'Write the launch note for the Aarhus cafés';
	v_surface uuid;
	v_session uuid;
	v_lease_1 constant uuid := '13540000-0000-4000-8000-000000000101';
	v_lease_2 constant uuid := '13540000-0000-4000-8000-000000000102';
	v_lease_3 constant uuid := '13540000-0000-4000-8000-000000000103';
	v_lease_4 constant uuid := '13540000-0000-4000-8000-000000000104';
	v_lease_5 constant uuid := '13540000-0000-4000-8000-000000000105';
	v_prompt text;
	v_conversation text;
	v_anna_message uuid;
	v_base timestamptz;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	select v_company, v_bo, 'bo@example.test', 'Bo', 'contributor'
	where not exists (select 1 from public.qorpera_profile_members where profile_id = v_company and user_id = v_bo);

	perform pg_temp.srrt_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_company, 'Launch Note', 'launch-note', 'studio', 'report', 'figure:book', null,
		'surfaces/launch-note', null, false) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, v_opening, 'Launch note') ->> 'id')::uuid;
	reset role;

	v_prompt := pg_temp.srrt_turn(v_company, v_session, v_lease_1);
	perform pg_temp.srrt_assert(v_prompt = v_opening, 'the first turn reads the request unchanged, got ' || coalesce(v_prompt, 'null'));

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_native_surface_complete_turn(v_company, v_session, 'needs_input', 'Which tone should the note have?',
		'{"text":"Which tone should the note have?","options":["Warm","Formal"]}'::jsonb, null, null, v_lease_1);
	reset role;
	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body)
	values (v_company, v_session, 'system', 'Previous attempt failed; retrying automatically.');

	v_prompt := pg_temp.srrt_turn(v_company, v_session, v_lease_2);
	perform pg_temp.srrt_assert(
		position(E'## Your open question\nWhich tone should the note have?\nOptions: Warm; Formal' in v_prompt) > 0,
		'a turn read while the question is open carries it, got ' || v_prompt
	);
	update public.qorpera_surface_sessions set state = 'needs_input', lease_token = null where id = v_session;

	perform pg_temp.srrt_as(v_anna);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_session, 'Warm, and name the three cafés', true);
	reset role;
	perform pg_temp.srrt_assert(
		(select question is null and state = 'queued' from public.qorpera_surface_sessions where id = v_session),
		'the answer clears the question and queues the session'
	);
	select id into v_anna_message from public.qorpera_surface_session_messages
	where session_id = v_session and author_kind = 'member' and body = 'Warm, and name the three cafés';
	insert into public.qorpera_surface_message_images(message_id, session_id, surface_id, profile_id, client_input_id, images)
	values (v_anna_message, v_session, v_surface, v_company, '13540000-0000-4000-8000-000000000201',
		jsonb_build_array(jsonb_build_object('objectSha256', repeat('a', 64), 'bytes', 10, 'mediaType', 'image/png')));

	perform pg_temp.srrt_as(v_bo);
	set local role authenticated;
	perform public.qorpera_reply_surface_session(v_session, 'Keep it under a hundred words', true);
	reset role;

	if position('note' in (select pg_get_constraintdef(c.oid) from pg_constraint c
		where c.conname = 'qorpera_surface_session_messages_author_kind_check')) = 0 then
		-- WHY: quiet notes (author_kind 'note') come with #2244; until then the kind is allowed here as #2244 allows it.
		set constraints all immediate;
		alter table public.qorpera_surface_session_messages
			drop constraint qorpera_surface_session_messages_author_kind_check,
			add constraint qorpera_surface_session_messages_author_kind_check
				check (author_kind in ('member', 'session', 'system', 'note'));
	end if;
	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_company, v_session, 'note', v_bo, '@Anna the price list is wrong');

	v_prompt := pg_temp.srrt_turn(v_company, v_session, v_lease_3);
	perform pg_temp.srrt_assert(left(v_prompt, length(v_opening)) = v_opening, 'the turn still starts with the request');
	perform pg_temp.srrt_assert(
		(length(v_prompt) - length(replace(v_prompt, v_opening, ''))) / length(v_opening) = 1,
		'the opening message is not repeated in the conversation'
	);
	perform pg_temp.srrt_assert(position(E'Anna:\nWarm, and name the three cafés\n[1 image attached]' in v_prompt) > 0,
		'the answer to the question reaches the turn under its member''s name, with its image, got ' || v_prompt);
	perform pg_temp.srrt_assert(position(E'Bo:\nKeep it under a hundred words' in v_prompt) > 0,
		'a teammate''s reply reaches the turn under his name');
	perform pg_temp.srrt_assert(position(E'You:\nWhich tone should the note have?' in v_prompt) > 0,
		'the agent''s earlier message reaches the turn as its own');
	perform pg_temp.srrt_assert(
		position('You:' in v_prompt) < position('Anna:' in v_prompt) and position('Anna:' in v_prompt) < position('Bo:' in v_prompt),
		'the conversation is oldest first'
	);
	perform pg_temp.srrt_assert(position('Previous attempt failed' in v_prompt) = 0, 'a system line is left out');
	perform pg_temp.srrt_assert(position('price list' in v_prompt) = 0, 'a quiet note is left out');
	perform pg_temp.srrt_assert(position('## Your open question' in v_prompt) = 0, 'an answered question is not shown as open');
	perform pg_temp.srrt_assert(position('left out' in v_prompt) = 0, 'nothing is left out of a short conversation');
	update public.qorpera_surface_sessions set state = 'ready', lease_token = null where id = v_session;

	v_base := clock_timestamp() + interval '1 minute';
	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body, created_at)
	select v_company, v_session, 'member', v_anna, 'Line ' || lpad(n::text, 2, '0'), v_base + n * interval '1 second'
	from generate_series(1, 60) n;
	v_prompt := pg_temp.srrt_turn(v_company, v_session, v_lease_4);
	perform pg_temp.srrt_assert(position(E'Anna:\nLine 60' in v_prompt) > 0 and position(E'Anna:\nLine 21' in v_prompt) > 0,
		'the newest forty messages are kept');
	perform pg_temp.srrt_assert(position(E'Anna:\nLine 20' in v_prompt) = 0 and position('Bo:' in v_prompt) = 0,
		'older messages past forty are left out');
	perform pg_temp.srrt_assert(position('(23 earlier messages are left out.)' in v_prompt) > 0,
		'the turn says how many messages were left out, got ' || v_prompt);
	update public.qorpera_surface_sessions set state = 'ready', lease_token = null where id = v_session;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body, created_at)
	select v_company, v_session, 'member', v_bo, 'Long ' || lpad(n::text, 2, '0') || ' ' || repeat('é', 3000),
		v_base + interval '2 minutes' + n * interval '1 second'
	from generate_series(1, 10) n;
	v_prompt := pg_temp.srrt_turn(v_company, v_session, v_lease_5);
	v_conversation := substr(v_prompt, position(E'\n\n' || 'Bo:' in v_prompt));
	perform pg_temp.srrt_assert(position('Long 10' in v_prompt) > 0, 'the newest message is kept under the byte cap');
	perform pg_temp.srrt_assert(position('Long 04' in v_prompt) = 0 and position('Line ' in v_prompt) = 0,
		'the oldest messages go first under the byte cap');
	perform pg_temp.srrt_assert(octet_length(v_conversation) <= 24000,
		'the conversation stays under the byte cap, got ' || octet_length(v_conversation) || ' bytes');
	perform pg_temp.srrt_assert(octet_length(v_prompt) <= 24500,
		'the whole prompt stays bounded, got ' || octet_length(v_prompt) || ' bytes');
	perform pg_temp.srrt_assert(position(E'Bo:\nLong 05' in v_prompt) > 0
		and position(E'Bo:\nLong 05' in v_prompt) < position(E'Bo:\nLong 10' in v_prompt),
		'the six newest long messages fit, oldest first');
	perform pg_temp.srrt_assert(
		(length(v_prompt) - length(replace(v_prompt, E'\u00e9\n[message cut]', ''))) / length(E'\u00e9\n[message cut]') = 6,
		'each clipped message says it was cut');

	perform pg_temp.srrt_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_company, 'Site', 'site', 'studio', 'report', 'figure:book', null,
		'surfaces/site', null, false) ->> 'id')::uuid;
	v_session := (public.qorpera_start_surface_session(v_surface, 'Add a pricing section', 'Pricing') ->> 'id')::uuid;
	reset role;
	update public.qorpera_surfaces set source_kind = 'code_repo', repository_key = 'site' where id = v_surface;
	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, author_user_id, body)
	values (v_company, v_session, 'session', null, 'Which plans should it list?'),
		(v_company, v_session, 'member', v_anna, 'Only the two paid plans');
	v_prompt := pg_temp.srrt_turn(v_company, v_session, '13540000-0000-4000-8000-000000000106');
	perform pg_temp.srrt_assert(v_prompt = 'Add a pricing section',
		'a code_repo turn keeps the request alone (its reply comes as dispatch.followUp), got ' || coalesce(v_prompt, 'null'));
end $$;
