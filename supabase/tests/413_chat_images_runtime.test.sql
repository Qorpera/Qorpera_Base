-- @fixture 410_chat_images.test.sql until "-- The chat image checks start here (411 runs everything above this line)."
-- Chat images on folder-v2, the runtime part (20260930360000): an agent finds a member's image by its folder path. The
-- run's context lists a member's message's images by path, the current request's and an earlier message's alike, and
-- none once the message is erased; the zoom names each image's path beside its media type and bytes. The helper keeps
-- the input's order and leaves out what has no path; it is no API role's.

-- 1. A run's context: Nora's thread, a message with two images. As the current request, and later as an earlier message,
-- it lists both paths in order and no attachmentCount; erased, none. The run's job lists none.
do $$
declare
	ns uuid := pg_temp.thread('nora'); a constant jsonb := pg_temp.file('thirty-one a'); b constant jsonb := pg_temp.file('thirty-one b');
	paths jsonb; p jsonb; r jsonb; s jsonb;
	v_run public.qorpera_execution_runs%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_event public.qorpera_session_events%rowtype;
begin
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(31), 'thirty-one a');
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(31), 'thirty-one b');
	r := pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(31), 'Compare these', jsonb_build_array(pg_temp.img(a), pg_temp.img(b)));
	paths := jsonb_build_array(
		format('agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(31), a ->> 'fileSha256'),
		format('agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(31), b ->> 'fileSha256'));

	-- A run value that names the input is enough for the source (as 815's); the input's run is a hand-built one.
	p := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', pg_temp.u(1));
	select * into strict v_run from public.qorpera_execution_runs where id = (p ->> 'runId')::uuid;
	update public.qorpera_session_inputs set execution_run_id = v_run.id where id = (r ->> 'inputId')::uuid
	returning * into strict v_input;
	v_run.session_id := ns; v_run.input_ids := array[v_input.id]; v_run.requested_by_user_id := v_input.author_user_id;
	v_run.runtime_bundle_id := v_input.runtime_bundle_id; v_run.runtime_bundle_sha256 := v_input.runtime_bundle_sha256;
	s := public.qorpera_company_context_source(v_run, 'input', v_input.id);
	perform pg_temp.same(jsonb_build_array(s ->> 'kind', s -> 'images', s ? 'attachmentCount'),
		jsonb_build_array('current_human_request', paths, false), 'The current request');
	perform pg_temp.same(public.qorpera_company_context_source(v_run, 'job', v_run.id) -> 'images', '[]', 'The run''s job');

	select * into strict v_event from public.qorpera_session_events where event_id = v_input.id;
	v_run.input_ids := '{}'::uuid[]; v_run.transcript_start_sequence := v_event.sequence;
	s := public.qorpera_company_context_source(v_run, 'history', v_event.event_id);
	perform pg_temp.same(jsonb_build_array(s ->> 'kind', s -> 'images', s ? 'attachmentCount'),
		jsonb_build_array('historical_human_message', paths, false), 'The earlier message');

	perform pg_temp.fx(format('update public.qorpera_session_events set body = %L where event_id = %L', '{"erased":true}', v_event.event_id));
	perform pg_temp.same(public.qorpera_company_context_source(v_run, 'history', v_event.event_id) -> 'images', '[]',
		'The erased message');
end $$;

-- 2. The zoom: a member's image names its path, in a thread and in a group chat; a message with no image has none.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); f constant jsonb := pg_temp.file('thirty-two');
	g constant jsonb := pg_temp.file('thirty-three', 'image/webp'); r jsonb; q jsonb; n jsonb;
begin
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(32), 'thirty-two');
	r := pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(32), 'See this', jsonb_build_array(pg_temp.img(f)));
	n := pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(34), 'No image');
	perform pg_temp.same((select jsonb_agg(e.value -> 'attachments' order by e.value ->> 'eventId' = r ->> 'inputId' desc)
			from jsonb_array_elements(public.qorpera_memory_events(ns, 0, 50)) e
			where e.value ->> 'eventId' in (r ->> 'inputId', n ->> 'inputId')),
		jsonb_build_array(jsonb_build_array(jsonb_build_object('mediaType', 'image/png', 'bytes', f -> 'bytes',
			'path', format('agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(32), f ->> 'fileSha256'))), null),
		'The zoom''s image in a thread');

	perform pg_temp.begin_image(pg_temp.u(1), ls, pg_temp.cid(33), pg_temp.image('thirty-three', 'image/webp'));
	perform pg_temp.save_image(pg_temp.u(1), ls, pg_temp.cid(33), g);
	q := pg_temp.say(pg_temp.u(1), ls, pg_temp.cid(33), 'Look', jsonb_build_array(pg_temp.img(g)));
	perform pg_temp.same((select e.value -> 'attachments' from jsonb_array_elements(public.qorpera_memory_events(ls, 0, 50)) e
			where e.value ->> 'eventId' = q ->> 'inputId'),
		jsonb_build_array(jsonb_build_object('mediaType', 'image/webp', 'bytes', g -> 'bytes',
			'path', format('agents/groups/launch/memory/images/%s/%s.webp', pg_temp.cid(33), g ->> 'fileSha256'))),
		'The zoom''s image in a group chat');
end $$;

-- 3. The helper: the input's order; an image with no path (malformed, or a conversation with no tree root) is left out;
-- a body with no images lists none. No API role may call it.
do $$
declare
	ns uuid := pg_temp.thread('nora'); a constant jsonb := pg_temp.img(pg_temp.file('x')); b constant jsonb := pg_temp.img(pg_temp.file('y'));
	a1 uuid := (select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '63400000-0000-4000-8000-0000000000a1');
	v_bad text;
begin
	perform pg_temp.same(public.qorpera_room_input_image_paths(ns, pg_temp.cid(35), jsonb_build_object('images',
			jsonb_build_array(b, a || '{"mediaType":"image/bmp"}', a))),
		jsonb_build_array(format('agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(35), b ->> 'objectSha256'),
			format('agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(35), a ->> 'objectSha256')), 'The paths in order');
	perform pg_temp.same(public.qorpera_room_input_image_paths(a1, pg_temp.cid(35), jsonb_build_object('images', jsonb_build_array(a))),
		'[]', 'A conversation with no tree root');
	perform pg_temp.same(public.qorpera_room_input_image_paths(ns, pg_temp.cid(35), '{"text":"Hi"}'), '[]', 'No images');
	perform pg_temp.same(public.qorpera_room_input_image_paths(ns, null, jsonb_build_object('images', jsonb_build_array(a))), '[]',
		'No input id');
	select string_agg(r, ', ') into v_bad from unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, 'public.qorpera_room_input_image_paths(uuid,uuid,jsonb)', 'execute');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if (select prosecdef from pg_proc where oid = 'public.qorpera_room_input_image_paths(uuid,uuid,jsonb)'::regprocedure) then
		raise exception 'The helper is no definer''s'; end if;
end $$;

rollback;
