-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Chat images on folder-v2 (supabase/CLIENT-CONTRACT.md "Chat images"; 20260930260000): a member's image is a folder
-- file under the conversation's summary-tree root, <root>/images/<client input id>/<sha256>.<ext>. The begin: the room,
-- the image, the input id and its member, the limits. The gateway's save: one platform memory commit that makes the
-- folders still missing, a replay, the limits again. The post and the input trigger: each image a live file this member
-- uploaded for this input; a submitted input's images do not change. The download, the path rules (members and the
-- plain commit refused; a memory commit writes only an input's images, naming the generation), the grants, and an
-- erased message. The sweep is 411, the races 412, what a run and the zoom read of an image 413. The conversations are
-- a hired agent's thread and a group chat.

-- 970's helpers, with their own ids.
create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.agent_text(p_id uuid, p_name text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: agent\nstatus: active\n---\nSell.\n', p_id, p_name)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind','agent','status','active',
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
create function pg_temp.hire(p_handle text, p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name), pg_temp.member(1))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name), pg_temp.agent_parse(p_id, p_name))))
$$;
create function pg_temp.group_text(p_id uuid, p_name text, p_agents uuid[]) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nagents:\n%speople:\n  - 63400000-0000-4000-8000-000000000001\n---\nPlan the launch.\n',
		p_id, p_name, (select string_agg(format(E'  - %s\n', a), '') from unnest(p_agents) a))
$$;
create function pg_temp.new_group(p_handle text, p_id uuid, p_name text, p_agents uuid[]) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/groups/' || p_handle,
		'contents', jsonb_build_array(jsonb_build_object('path','group.md','kind','file',
			'file',pg_temp.stage(pg_temp.group_text(p_id, p_name, p_agents), pg_temp.member(1)))),
		'structured', jsonb_build_array(pg_temp.entry('QorperaOS/agents/groups/' || p_handle || '/group.md', 'group',
			pg_temp.group_text(p_id, p_name, p_agents),
			jsonb_build_object('kind','group','id',p_id,'name',p_name,'subtitle',null,'agents',to_jsonb(p_agents),
				'people','["63400000-0000-4000-8000-000000000001"]'::jsonb,'purpose','Plan the launch.'))))
$$;
create function pg_temp.id(p_name text) returns uuid language sql immutable as $$
	select ('41000000-0000-4000-8000-0000000000' || case p_name when 'nora' then 'a1' when 'otto' then 'a2' when 'launch' then 'b1' end)::uuid
$$;
-- An agent's thread conversation, and a group chat's.
create function pg_temp.thread(p_agent text) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = pg_temp.id(p_agent)
$$;
create function pg_temp.chat(p_group text) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where id = pg_temp.id(p_group)
$$;
-- A memory commit as the platform, naming one conversation's generation.
create function pg_temp.memory(p_key text, p_units jsonb, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', p_session,
			'generation', (select memory_generation from public.qorpera_shared_sessions where id = p_session)))))
$$;
-- A unit refused with one problem (as 941).
create function pg_temp.refused(p_result jsonb, p_unit integer, p_reason text, p_message text, p_code text default 'value',
	p_line integer default null)
returns void language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from 'refused' or v ->> 'reason' is distinct from p_reason
		or jsonb_array_length(v -> 'problems') is distinct from 1 or v -> 'problems' -> 0 ->> 'code' is distinct from p_code
		or v -> 'problems' -> 0 ->> 'message' is distinct from p_message
		or (v -> 'problems' -> 0 ->> 'line')::integer is distinct from p_line then
		raise exception 'Unit % expected % (%, line %: %), got %', p_unit, p_reason, p_code, p_line, p_message, p_result
			using errcode = 'QTF01'; end if;
end $$;
-- A path's live version, and the folder's clock.
create function pg_temp.version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
		and key_text = public.qorpera_folder_key(p_path) and kind <> 'claim'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'
$$;

-- The users (01 the owner, 02 and 04 contributors, 03 a viewer, 05 an admin), and the client input ids.
create function pg_temp.u(p_n integer) returns uuid language sql immutable as $$
	select ('63400000-0000-4000-8000-00000000000' || p_n)::uuid
$$;
create function pg_temp.cid(p_n integer) returns uuid language sql immutable as $$
	select ('41000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
-- An image's file as its seal answers it, and the image as an input lists it.
create function pg_temp.file(p_text text, p_media text default 'image/png') returns jsonb language sql immutable as $$
	select jsonb_build_object('manifestSha256', pg_temp.hash(pg_temp.manifest(array[p_text], p_media)), 'fileSha256', pg_temp.hash(p_text),
		'bytes', octet_length(convert_to(p_text, 'utf8')), 'mediaType', p_media, 'executable', false)
$$;
create function pg_temp.img(p_file jsonb) returns jsonb language sql immutable as $$
	select jsonb_build_object('objectSha256', p_file ->> 'fileSha256', 'bytes', p_file -> 'bytes', 'mediaType', p_file ->> 'mediaType')
$$;
-- An image staged as the platform, as the object gateway stages it (version 2).
create function pg_temp.image(p_text text, p_media text default 'image/png') returns jsonb language plpgsql as $$
declare v_manifest text := pg_temp.manifest(array[p_text], p_media); v_open jsonb; v_object text; v_seal jsonb;
begin
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', v_manifest);
	foreach v_object in array array[p_text, v_manifest] loop
		if not (v_open -> 'present') ? pg_temp.hash(v_object) then
			perform public.qorpera_folder_confirm_object('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
				(v_open ->> 'intentId')::uuid, pg_temp.hash(v_object), octet_length(convert_to(v_object, 'utf8'))); end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'sealed' or v_seal -> 'file' <> pg_temp.file(p_text, p_media) then raise exception 'Fixture: %', v_seal; end if;
	return v_seal -> 'file';
end $$;
-- A member's begin (with the member's claims), the gateway's save (the service role's), and both for a staged image.
create function pg_temp.begin_image(p_user uuid, p_session uuid, p_cid uuid, p_file jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	r := public.qorpera_room_image_begin(p_session, p_cid, p_file ->> 'fileSha256', (p_file ->> 'bytes')::bigint, p_file ->> 'mediaType');
	perform pg_temp.path_claims('service_role');
	return r;
end $$;
create function pg_temp.save_image(p_user uuid, p_session uuid, p_cid uuid, p_file jsonb) returns jsonb language sql as $$
	select public.qorpera_room_image_commit(p_user, p_session, p_cid, p_file)
$$;
create function pg_temp.upload(p_user uuid, p_session uuid, p_cid uuid, p_text text) returns jsonb language plpgsql as $$
declare v_file jsonb := pg_temp.image(p_text);
begin
	perform pg_temp.begin_image(p_user, p_session, p_cid, v_file);
	return pg_temp.save_image(p_user, p_session, p_cid, v_file);
end $$;
-- A member's post in a conversation, with its images, on 634's login binding (the owner's).
create function pg_temp.say(p_user uuid, p_session uuid, p_cid uuid, p_text text, p_images jsonb default '[]') returns jsonb
language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.path_claims('authenticated', p_user);
	r := public.qorpera_post_company_room_message((select id from public.qorpera_company_rooms where session_id = p_session), p_cid,
		jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', p_text)
			|| case when jsonb_array_length(p_images) > 0 then jsonb_build_object('images', p_images) else '{}'::jsonb end,
		'63400000-0000-4000-8000-0000000000b1', 1);
	perform pg_temp.path_claims('service_role');
	return r;
end $$;

-- The setup: Nora and Otto hired, and a group chat with both. Neither conversation has a tree root yet.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'images-setup',
	'[{"op":"mkdir","path":"QorperaOS"},{"op":"mkdir","path":"QorperaOS/agents"},{"op":"mkdir","path":"QorperaOS/agents/groups"}]'), 3, 'saved')
	\g /dev/null
do $$
declare r jsonb; nora constant uuid := pg_temp.id('nora'); otto constant uuid := pg_temp.id('otto');
begin
	r := pg_temp.commit(pg_temp.member(1), 'images-hire', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'), pg_temp.hire('otto', otto, 'Otto')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'images-group', jsonb_build_array(
		pg_temp.new_group('launch', pg_temp.id('launch'), 'Launch', array[nora, otto]))), 1, 'saved');
	if pg_temp.thread('nora') is null or pg_temp.chat('launch') is null or pg_temp.version('qorperaos/agents/nora/memory/thread') is not null
		or pg_temp.version('qorperaos/agents/groups/launch/memory') is not null then
		raise exception 'Fixture: Nora''s thread and the group chat, with no tree root'; end if;
end $$;

-- The chat image checks start here (411 runs everything above this line).

-- 1. The begin: the image's path for a member of the room, and the input id held for that member. A malformed image or
-- input id, the service role, a viewer, a stranger, a member who is not in the room and an unknown conversation
-- refuse; a conversation with no tree root (634's agent, with no folder) has no place for it; another member cannot
-- add to the input.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); f constant jsonb := pg_temp.file('nora one'); bad jsonb;
	who record;
	a1 uuid := (select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '63400000-0000-4000-8000-0000000000a1');
begin
	perform pg_temp.same(pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(1), f), jsonb_build_object('schema', 'qorpera.room-image-begin/v1',
		'environmentId', '63400000-0000-4000-8000-000000000020', 'sessionId', ns, 'clientInputId', pg_temp.cid(1),
		'sha256', f ->> 'fileSha256', 'bytes', f -> 'bytes', 'mediaType', 'image/png',
		'path', format('qorperaos/agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(1), f ->> 'fileSha256')), 'The begin');
	if not exists (select 1 from public.qorpera_room_image_uploads where session_id = ns and client_input_id = pg_temp.cid(1)
		and user_id = pg_temp.u(1) and environment_id = '63400000-0000-4000-8000-000000000020') then
		raise exception 'The begin holds the input id for its member'; end if;
	foreach bad in array array[f || '{"mediaType":"image/bmp"}'::jsonb, f || '{"bytes":0}'::jsonb, f || '{"bytes":8388609}'::jsonb,
		f || '{"fileSha256":"abc"}'::jsonb] loop
		perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(1), bad),
			'22023', 'Member attachment is invalid');
	end loop;
	perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, null, %L)', pg_temp.u(1), ns, f), '22023',
		'Member attachment is invalid');
	perform pg_temp.raises_like(format('select public.qorpera_room_image_begin(%L, %L, %L, %s, %L)', ns, pg_temp.cid(1),
		f ->> 'fileSha256', f ->> 'bytes', 'image/png'), '42501', 'Member attachment authority is required');
	for who in select * from (values ('64700000-0000-4000-8000-0000000000ff'::uuid, ns), (pg_temp.u(3), ns), (pg_temp.u(2), ls),
		(pg_temp.u(1), extensions.gen_random_uuid())) v(usr, sess) loop
		perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', who.usr, who.sess, pg_temp.cid(1), f),
			'42501', 'Member attachment session is unavailable');
	end loop;
	perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), a1, pg_temp.cid(11), f),
		'55000', 'Attachment folder is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(2), ns, pg_temp.cid(1), f),
		'23505', 'Attachment input id is bound to another member');
end $$;

-- 2. The save (the gateway's, as the service role): the first makes the root, images/ and the input's folder, then the
-- file, in one memory commit as the platform; the same file again is a replay that commits nothing; a group chat's image
-- goes under its own root. The member's claims, a file that is not a sealed image's, an input id nobody began and
-- another member refuse.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); f constant jsonb := pg_temp.image('nora one');
	g constant jsonb := pg_temp.image('launch one'); root constant text := 'qorperaos/agents/nora/memory/thread';
	dir constant text := root || '/images/' || pg_temp.cid(1); v_path constant text := dir || '/' || (f ->> 'fileSha256') || '.png';
	gpath constant text := format('qorperaos/agents/groups/launch/memory/images/%s/%s.png', pg_temp.cid(2), g ->> 'fileSha256');
	r jsonb; v uuid; bad jsonb;
begin
	perform pg_temp.path_claims('authenticated', pg_temp.u(1));
	perform pg_temp.raises_like(format('select pg_temp.save_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(1), f), '42501',
		'Member attachment authority is required');
	perform pg_temp.path_claims('service_role');
	foreach bad in array array[f || '{"extra":1}'::jsonb, f || '{"executable":true}'::jsonb, f - 'manifestSha256'] loop
		perform pg_temp.raises_like(format('select pg_temp.save_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(1), bad),
			'22023', 'Member attachment is invalid');
	end loop;
	perform pg_temp.raises_like(format('select pg_temp.save_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(6), f),
		'42501', 'Member attachment session is unavailable');
	perform pg_temp.raises_like(format('select pg_temp.save_image(%L, %L, %L, %L)', pg_temp.u(2), ns, pg_temp.cid(1), f),
		'42501', 'Member attachment session is unavailable');
	if pg_temp.version(root) is not null then raise exception 'Nothing refused made the root'; end if;

	r := pg_temp.save_image(pg_temp.u(1), ns, pg_temp.cid(1), f);
	perform pg_temp.same(r, jsonb_build_object('schema', 'qorpera.room-image/v1', 'sha256', f ->> 'fileSha256', 'bytes', f -> 'bytes',
		'mediaType', 'image/png', 'path', v_path), 'The save');
	if pg_temp.version(root) is null or pg_temp.version(root || '/images') is null or pg_temp.version(dir) is null
		or (select kind from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
			and key_text = public.qorpera_folder_key(v_path)) is distinct from 'file' then
		raise exception 'The save makes the root, images/, the input''s folder and the file'; end if;
	if (select count(*) filter (where actor_kind = 'platform') || '/' || count(*) from public.qorpera_folder_commits
		where environment_id = '63400000-0000-4000-8000-000000000020' and operation_key like 'chat-image:' || pg_temp.cid(1) || ':%') <> '1/1' then
		raise exception 'The save is one memory commit as the platform'; end if;
	v := pg_temp.version(v_path);
	perform pg_temp.same(pg_temp.save_image(pg_temp.u(1), ns, pg_temp.cid(1), f), r, 'A replayed save');
	if pg_temp.version(v_path) is distinct from v or (select count(*) from public.qorpera_folder_commits
		where environment_id = '63400000-0000-4000-8000-000000000020' and operation_key like 'chat-image:' || pg_temp.cid(1) || ':%') <> 1 then
		raise exception 'A replayed save commits nothing'; end if;

	perform pg_temp.begin_image(pg_temp.u(1), ls, pg_temp.cid(2), g);
	perform pg_temp.same(pg_temp.save_image(pg_temp.u(1), ls, pg_temp.cid(2), g) -> 'path', to_jsonb(gpath), 'A group chat''s image');
	if pg_temp.version(gpath) is null then raise exception 'A group chat''s image is under its root'; end if;
end $$;

-- 3. An input's limits, at the begin and again at the save: five images, then 8 MiB. Another image of a full input
-- refuses; the same image again does not count itself.
do $$
declare ns uuid := pg_temp.thread('nora'); i integer;
	big constant jsonb := jsonb_build_object('fileSha256', repeat('b', 64), 'bytes', 8388608, 'mediaType', 'image/png');
begin
	for i in 1..4 loop perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(3), 'three ' || i); end loop;
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(3), pg_temp.image('three 5'));
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(3), pg_temp.image('three 6'));
	perform pg_temp.save_image(pg_temp.u(1), ns, pg_temp.cid(3), pg_temp.file('three 5'));
	perform pg_temp.raises_like(format('select pg_temp.save_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(3), pg_temp.file('three 6')),
		'54000', 'Member attachment capacity is reached');
	perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(3), pg_temp.file('three 7')),
		'54000', 'Member attachment capacity is reached');
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(3), pg_temp.file('three 1'));
	if (select count(*) from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020'
		and parent_key_sha256 = extensions.digest(public.qorpera_folder_key('qorperaos/agents/nora/memory/thread/images/' || pg_temp.cid(3)), 'sha256')
		and kind = 'file') <> 5 then
		raise exception 'An input holds five images'; end if;

	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(4), 'four');
	perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(4), big),
		'54000', 'Member attachment capacity is reached');
	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(5), big);
end $$;

-- 4. The post: each image a live file this member uploaded for this input; a replay answers the same. An image begun and
-- not saved, other bytes and another member refuse, before the sponsor's login. A posted input's images do not change:
-- its begin and save refuse. A group chat's post.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); f constant jsonb := pg_temp.file('nora one');
	e constant jsonb := pg_temp.file('eight'); r jsonb;
begin
	r := pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(1), 'See this', jsonb_build_array(pg_temp.img(f)));
	perform pg_temp.same((select body -> 'images' from public.qorpera_session_inputs where id = (r ->> 'inputId')::uuid),
		jsonb_build_array(pg_temp.img(f)), 'The input''s images');
	perform pg_temp.same(pg_temp.say(pg_temp.u(1), ns, pg_temp.cid(1), 'See this', jsonb_build_array(pg_temp.img(f))), r, 'A replayed post');
	perform set_config('qorpera_test.nora_input', r ->> 'inputId', true);

	perform pg_temp.begin_image(pg_temp.u(1), ns, pg_temp.cid(7), pg_temp.file('seven'));
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(8), 'eight');
	perform pg_temp.raises_like(format('select pg_temp.say(%L, %L, %L, %L, %L)', u, ns, pg_temp.cid(c), 'Look', jsonb_build_array(i)),
		'42501', 'Attachment bytes must be uploaded for this exact member input')
	from (values (pg_temp.u(1), 7, pg_temp.img(pg_temp.file('seven'))), (pg_temp.u(1), 8, pg_temp.img(e) || jsonb_build_object('bytes', (e ->> 'bytes')::integer + 1)),
		(pg_temp.u(2), 8, pg_temp.img(e))) v(u, c, i);
	perform pg_temp.raises_like(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(1), f),
		'42501', 'Submitted input attachments cannot change');
	perform pg_temp.raises_like(format('select pg_temp.save_image(%L, %L, %L, %L)', pg_temp.u(1), ns, pg_temp.cid(1), f),
		'42501', 'Submitted input attachments cannot change');

	r := pg_temp.say(pg_temp.u(1), ls, pg_temp.cid(2), 'Look', jsonb_build_array(pg_temp.img(pg_temp.file('launch one'))));
	perform set_config('qorpera_test.launch_input', r ->> 'inputId', true);
end $$;

-- 5. The input trigger decides for any writer: an input inserted with images is a member's prompt whose images that
-- member uploaded for it. A submitted input's images and author do not change; its text may, and an erase that leaves
-- no images passes.
do $$
declare
	ns uuid := pg_temp.thread('nora'); v_body jsonb := jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'text', 'Nine',
		'images', jsonb_build_array(pg_temp.img(pg_temp.file('nine'))));
	ins constant text := 'insert into public.qorpera_session_inputs(session_id, client_input_id, kind, author_user_id, body)
		values (%L, %L, %L, %L, %L)';
	v_id uuid;
begin
	perform pg_temp.upload(pg_temp.u(1), ns, pg_temp.cid(9), 'nine');
	perform pg_temp.raises_like(format(ins, ns, pg_temp.cid(9), v.k, v.author, v.b), '42501',
		'Attachment bytes must be uploaded for this exact member input')
	from (values ('kickoff', pg_temp.u(1), v_body), ('user_message', pg_temp.u(1), v_body - 'schema'),
		('user_message', pg_temp.u(2), v_body)) v(k, author, b);
	execute format(ins, ns, pg_temp.cid(9), 'user_message', pg_temp.u(1), v_body);
	v_id := (select id from public.qorpera_session_inputs where session_id = ns and client_input_id = pg_temp.cid(9));
	perform pg_temp.raises_like(format('update public.qorpera_session_inputs set body = jsonb_set(body, ''{images}'', %L) where id = %L',
		jsonb_build_array(pg_temp.img(pg_temp.file('nora one'))), v_id), '42501', 'Submitted input attachments cannot change');
	perform pg_temp.raises_like(format('update public.qorpera_session_inputs set author_user_id = %L where id = %L', pg_temp.u(2), v_id),
		'42501', 'Submitted input attachments cannot change');
	update public.qorpera_session_inputs set body = body || '{"text":"Nine, edited"}' where id = v_id;
	update public.qorpera_session_inputs set body = jsonb_set(body, '{images}', '[]') where id = v_id;
	if (select i.body from public.qorpera_session_inputs i where i.id = v_id) is distinct from v_body || '{"text":"Nine, edited","images":[]}' then
		raise exception 'The text changed, then the images were erased'; end if;
	perform set_config('qorpera_test.direct_input', v_id::text, true);
end $$;

-- 6. The download: a member who may read the conversation (a viewer too) gets an image of a canonical input, as its
-- folder file. A stranger, the service role, an image the input does not list and an input that is not a canonical
-- prompt (none, or one inserted with no transcript event) refuse; an image deleted since serves nothing.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); f constant jsonb := pg_temp.file('nora one');
	g constant jsonb := pg_temp.file('launch one'); inp uuid := current_setting('qorpera_test.nora_input')::uuid;
	ginp uuid := current_setting('qorpera_test.launch_input')::uuid;
	gpath constant text := format('QorperaOS/agents/groups/launch/memory/images/%s/%s.png', pg_temp.cid(2), g ->> 'fileSha256');
	n integer; want jsonb;
begin
	want := jsonb_build_object('schema', 'qorpera.room-image-download/v1', 'environmentId', '63400000-0000-4000-8000-000000000020',
		'sessionId', ns, 'inputId', inp, 'sha256', f ->> 'fileSha256', 'bytes', f -> 'bytes', 'mediaType', 'image/png',
		'manifestSha256', f ->> 'manifestSha256', 'fileSha256', f ->> 'fileSha256',
		'path', format('QorperaOS/agents/nora/memory/thread/images/%s/%s.png', pg_temp.cid(1), f ->> 'fileSha256'));
	foreach n in array array[1, 3] loop
		perform pg_temp.path_claims('authenticated', pg_temp.u(n));
		perform pg_temp.same(public.qorpera_room_image_download(ns, inp, f ->> 'fileSha256'), want, 'A download by member ' || n);
	end loop;
	perform pg_temp.path_claims('authenticated', '64700000-0000-4000-8000-0000000000ff');
	perform pg_temp.raises_like(format('select public.qorpera_room_image_download(%L, %L, %L)', ns, inp, f ->> 'fileSha256'),
		'42501', 'Chat attachment access is unavailable');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.raises_like(format('select public.qorpera_room_image_download(%L, %L, %L)', ns, inp, f ->> 'fileSha256'),
		'42501', 'Chat attachment access is unavailable');
	perform pg_temp.path_claims('authenticated', pg_temp.u(1));
	perform pg_temp.raises_like(format('select public.qorpera_room_image_download(%L, %L, %L)', ns, inp, repeat('c', 64)),
		'42501', 'Attachment does not belong to this canonical input');
	perform pg_temp.raises_like(format('select public.qorpera_room_image_download(%L, %L, %L)', ns, x.input, x.sha),
		'42501', 'Canonical chat input is unavailable')
	from (values (extensions.gen_random_uuid(), f ->> 'fileSha256'),
		(current_setting('qorpera_test.direct_input')::uuid, pg_temp.file('nine') ->> 'fileSha256')) x(input, sha);
	perform pg_temp.same(public.qorpera_room_image_download(ls, ginp, g ->> 'fileSha256') -> 'path', to_jsonb(gpath),
		'A group chat''s download');
	perform pg_temp.path_claims('service_role');
	perform pg_temp.expect(pg_temp.memory('images-delete', jsonb_build_array(jsonb_build_object('op', 'delete', 'path', gpath,
		'expectedVersion', pg_temp.version(gpath))), ls), 1, 'saved');
	perform pg_temp.path_claims('authenticated', pg_temp.u(1));
	perform pg_temp.raises_like(format('select public.qorpera_room_image_download(%L, %L, %L)', ls, ginp, g ->> 'fileSha256'),
		'55000', 'Attachment object is unavailable');
	perform pg_temp.path_claims('service_role');
end $$;

-- 7. The paths: a member's commit and the plain commit never touch a conversation's images, before its tree.toml too. A
-- memory commit writes only an input's folder of images, each named by its hash, deletes only those, and names the
-- conversation's generation.
do $$
declare
	ns uuid := pg_temp.thread('nora'); ls uuid := pg_temp.chat('launch'); f constant jsonb := pg_temp.file('nora one');
	x constant jsonb := pg_temp.image('ten'); root constant text := 'qorperaos/agents/nora/memory/thread';
	dir constant text := root || '/images/' || pg_temp.cid(1); v_path constant text := dir || '/' || (f ->> 'fileSha256') || '.png';
	platform_only constant text := 'summary trees are written by the platform only';
	only_tree constant text := 'a summary tree holds only tree.toml, its blocks and its images; only blocks and images are deleted';
	r jsonb;
begin
	perform pg_temp.refused(pg_temp.commit(pg_temp.member(1), 'images-member-1', jsonb_build_array(jsonb_build_object('op', 'mkdir',
		'path', root || '/images/' || pg_temp.cid(12)))), 1, 'platform_only', platform_only);
	perform pg_temp.refused(pg_temp.commit(pg_temp.member(1), 'images-member-2', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', v_path, 'expectedVersion', pg_temp.version(v_path)))), 1, 'platform_only', platform_only);
	perform pg_temp.refused(pg_temp.commit('{"kind":"platform"}', 'images-platform', jsonb_build_array(jsonb_build_object('op', 'mkdir',
		'path', root || '/images/' || pg_temp.cid(12)))), 1, 'platform_only', platform_only);
	for r in select pg_temp.memory('images-rule-' || t.n, jsonb_build_array(t.unit), ns) from unnest(array[
		jsonb_build_object('op', 'write', 'path', dir || '/notes.md', 'file', pg_temp.stage('A note.')),
		jsonb_build_object('op', 'write', 'path', dir || '/' || (x ->> 'fileSha256') || '.bmp', 'file', x),
		jsonb_build_object('op', 'mkdir', 'path', root || '/images/not-an-input'),
		jsonb_build_object('op', 'write', 'path', root || '/images/' || (x ->> 'fileSha256') || '.png', 'file', x),
		jsonb_build_object('op', 'delete', 'path', root || '/images', 'expectedVersion', pg_temp.version(root || '/images'),
			'asOfSeq', pg_temp.seq())]) with ordinality t(unit, n) order by t.n loop
		perform pg_temp.refused(r, 1, 'structured_rule', only_tree);
	end loop;
	perform pg_temp.refused(pg_temp.memory('images-rule-other', jsonb_build_array(jsonb_build_object('op', 'write',
		'path', dir || '/' || (x ->> 'fileSha256') || '.png', 'file', x)), ls), 1, 'structured_rule',
		'a summary tree''s change names its conversation''s generation');
	if pg_temp.version(v_path) is null or pg_temp.version(root || '/images') is null or pg_temp.version(root || '/images/' || pg_temp.cid(12)) is not null
		or pg_temp.version(dir || '/' || (x ->> 'fileSha256') || '.png') is not null then
		raise exception 'Nothing refused changed the images'; end if;
end $$;

-- 8. The grants: the begin and the download are a member's, the save the service role's; the helpers, the sweep and its
-- schedule no API role's, nor the uploads. The three calls and the sweep are the definer's.
do $$
declare
	v_bad text;
	c_all constant regprocedure[] := array['public.qorpera_room_image_room(uuid,uuid)', 'public.qorpera_room_image_root(uuid)',
		'public.qorpera_room_image_path(uuid,uuid,jsonb)', 'public.qorpera_room_image_entry(uuid,text,jsonb)',
		'public.qorpera_room_image_capacity_reached(uuid,text,bigint)', 'public.qorpera_room_images_check(uuid,uuid,uuid,jsonb)',
		'public.qorpera_room_image_begin(uuid,uuid,text,bigint,text)', 'public.qorpera_room_image_commit(uuid,uuid,uuid,jsonb)',
		'public.qorpera_room_image_download(uuid,uuid,text)', 'public.qorpera_room_image_orphan_sweep(integer)',
		'public.qorpera_schedule_room_image_sweep()']::regprocedure[];
begin
	select string_agg(f::text || ' ' || r, ', ') into v_bad
	from unnest(c_all) f, unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, f, 'execute') is distinct from (
		(f in ('public.qorpera_room_image_begin(uuid,uuid,text,bigint,text)'::regprocedure,
			'public.qorpera_room_image_download(uuid,uuid,text)'::regprocedure) and r = 'authenticated')
		or (f = 'public.qorpera_room_image_commit(uuid,uuid,uuid,jsonb)'::regprocedure and r = 'service_role'));
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	select string_agg(r || ' ' || p, ', ') into v_bad
	from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete']) p
	where has_table_privilege(r, 'public.qorpera_room_image_uploads', p);
	if v_bad is not null then raise exception 'The uploads are no API role''s: %', v_bad; end if;
	select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc p
	where p.oid = any(c_all::oid[]) and p.prosecdef is distinct from (p.proname in ('qorpera_room_image_begin', 'qorpera_room_image_commit',
		'qorpera_room_image_download', 'qorpera_room_image_orphan_sweep'));
	if v_bad is not null then raise exception 'Wrong definers: %', v_bad; end if;
end $$;

-- 9. An erased message serves no image.
do $$
declare ns uuid := pg_temp.thread('nora'); inp uuid := current_setting('qorpera_test.nora_input')::uuid;
begin
	perform pg_temp.fx(format('update public.qorpera_session_events set body = %L where session_id = %L and event_id = %L',
		'{"erased":true}', ns, inp));
	perform pg_temp.path_claims('authenticated', pg_temp.u(1));
	perform pg_temp.raises_like(format('select public.qorpera_room_image_download(%L, %L, %L)', ns, inp,
		pg_temp.file('nora one') ->> 'fileSha256'), '42501', 'Canonical chat input is unavailable');
	perform pg_temp.path_claims('service_role');
end $$;

rollback;
