-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.u(p_n integer) returns uuid language sql immutable as $$
	select ('92400000-0000-4000-8000-00000000000' || p_n)::uuid
$$;
create function pg_temp.cid(p_n integer) returns uuid language sql immutable as $$
	select ('13470000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.as_user(p_user uuid) returns void language sql as $$
	select pg_temp.base_claims('authenticated', p_user)
$$;
create function pg_temp.as_service() returns void language sql as $$
	select pg_temp.base_claims('service_role')
$$;
create function pg_temp.manifest(p_text text, p_media text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"%s","executable":false,"chunks":[{"sha256":"%s","bytes":%s}]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')), p_media,
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')))
$$;
create function pg_temp.stage(p_text text, p_media text default 'image/png') returns jsonb language plpgsql as $$
declare v_seal jsonb := pg_temp.base_seal('{"kind":"platform"}', pg_temp.manifest(p_text, p_media));
begin
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'staging: ' || v_seal::text);
	return v_seal -> 'file';
end $$;
create function pg_temp.img(p_file jsonb) returns jsonb language sql immutable as $$
	select jsonb_build_object('objectSha256', p_file ->> 'fileSha256', 'bytes', p_file -> 'bytes', 'mediaType', p_file ->> 'mediaType')
$$;
create function pg_temp.begin_image(p_user uuid, p_surface uuid, p_cid uuid, p_file jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.as_user(p_user);
	r := public.qorpera_surface_image_begin(p_surface, p_cid, p_file ->> 'fileSha256', (p_file ->> 'bytes')::bigint, p_file ->> 'mediaType');
	perform pg_temp.as_service();
	return r;
end $$;
create function pg_temp.upload(p_user uuid, p_surface uuid, p_cid uuid, p_text text) returns jsonb language plpgsql as $$
declare v_file jsonb := pg_temp.stage(p_text);
begin
	perform pg_temp.begin_image(p_user, p_surface, p_cid, v_file);
	perform public.qorpera_surface_image_commit(p_user, p_surface, p_cid, v_file);
	return pg_temp.img(v_file);
end $$;
create function pg_temp.start(p_user uuid, p_surface uuid, p_cid uuid, p_images jsonb, p_count integer default null)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.as_user(p_user);
	r := public.qorpera_start_surface_session_with_images(p_surface, 'Fix the header like this', null, 'member', null, null,
		p_count, null, null, p_cid, p_images);
	perform pg_temp.as_service();
	return r;
end $$;
create function pg_temp.reply(p_user uuid, p_session uuid, p_cid uuid, p_images jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.as_user(p_user);
	r := public.qorpera_reply_surface_session_with_images(p_session, 'And this one', true, p_cid, p_images);
	perform pg_temp.as_service();
	return r;
end $$;
create function pg_temp.as_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
	perform pg_temp.as_user(p_user);
	execute p_sql into r;
	perform pg_temp.as_service();
	return r;
end $$;
create function pg_temp.entry_version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '92400000-0000-4000-8000-000000000020'
		and key_text = public.qorpera_folder_key(p_path) and kind <> 'claim'
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '92400000-0000-4000-8000-000000000020'
$$;
create function pg_temp.path(p_cid uuid, p_image jsonb) returns text language sql immutable as $$
	select format('QorperaOS/surfaces/site/images/%s/%s.png', p_cid, p_image ->> 'objectSha256')
$$;

update public.qorpera_surface_settings set enabled = true where singleton = true;
insert into public.qorpera_surfaces(id, profile_id, slug, title, surface_group, archetype, source_kind, created_by_user_id) values
	('13470000-0000-4000-8000-000000000a01', '92400000-0000-4000-8000-000000000010', 'site', 'Site', 'products', 'live_build',
		'code_repo', '92400000-0000-4000-8000-000000000001');
select pg_temp.as_service();

do $$
declare
	s constant uuid := '13470000-0000-4000-8000-000000000a01';
	f jsonb := pg_temp.stage('header shot'); r jsonb; v_seq bigint;
begin
	r := pg_temp.begin_image(pg_temp.u(1), s, pg_temp.cid(1), f);
	perform pg_temp.base_assert(r = jsonb_build_object('schema', 'qorpera.surface-image-begin/v1',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'surfaceId', s, 'clientInputId', pg_temp.cid(1),
		'sha256', f ->> 'fileSha256', 'bytes', f -> 'bytes', 'mediaType', 'image/png', 'path', pg_temp.path(pg_temp.cid(1), pg_temp.img(f))),
		'the begin names the surface folder path: ' || r::text);
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(1),
		f || '{"mediaType":"image/bmp"}'), '22023', 'Member attachment is invalid');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, null, %L)', pg_temp.u(1), s, f), '22023',
		'Member attachment is invalid');
	perform pg_temp.base_error(format('select public.qorpera_surface_image_begin(%L, %L, %L, %s, %L)', s, pg_temp.cid(1),
		f ->> 'fileSha256', f ->> 'bytes', 'image/png'), '42501', 'Member attachment authority is required');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(3), s, pg_temp.cid(1), f), '42501',
		'Editor membership required');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(5), s, pg_temp.cid(1), f), '42501',
		'Company membership required');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), extensions.gen_random_uuid(),
		pg_temp.cid(1), f), '42501', 'Member attachment session is unavailable');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(2), s, pg_temp.cid(1), f), '23505',
		'Attachment input id is bound to another member');

	r := public.qorpera_surface_image_commit(pg_temp.u(1), s, pg_temp.cid(1), f);
	perform pg_temp.base_assert(r = jsonb_build_object('schema', 'qorpera.surface-image/v1', 'sha256', f ->> 'fileSha256',
		'bytes', f -> 'bytes', 'mediaType', 'image/png', 'path', pg_temp.path(pg_temp.cid(1), pg_temp.img(f))), 'the save: ' || r::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_room_image_entry('92400000-0000-4000-8000-000000000020',
		pg_temp.path(pg_temp.cid(1), pg_temp.img(f)), pg_temp.img(f))), 'the image is a live folder file');
	v_seq := pg_temp.seq();
	perform pg_temp.base_assert(public.qorpera_surface_image_commit(pg_temp.u(1), s, pg_temp.cid(1), f) = r
		and pg_temp.seq() = v_seq, 'the same image again answers the same and commits nothing');
	perform pg_temp.base_error(format('select public.qorpera_surface_image_commit(%L, %L, %L, %L)', pg_temp.u(2), s, pg_temp.cid(1), f),
		'42501', 'Member attachment session is unavailable');
	perform pg_temp.base_error(format('select public.qorpera_surface_image_commit(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(1),
		f || '{"executable":true}'), '22023', 'Member attachment is invalid');
	perform pg_temp.as_user(pg_temp.u(1));
	perform pg_temp.base_error(format('select public.qorpera_surface_image_commit(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(1), f),
		'42501', 'Member attachment authority is required');
	perform pg_temp.as_service();
end $$;

do $$
declare s constant uuid := '13470000-0000-4000-8000-000000000a01'; i integer; f jsonb;
begin
	for i in 1..5 loop perform pg_temp.upload(pg_temp.u(1), s, pg_temp.cid(2), 'limit ' || i); end loop;
	perform pg_temp.base_assert((select count(*) from public.qorpera_folder_entries where environment_id = '92400000-0000-4000-8000-000000000020'
		and kind = 'file' and key_text like 'qorperaos/surfaces/site/images/' || pg_temp.cid(2)::text || '/%') = 5, 'five images saved');
	perform pg_temp.begin_image(pg_temp.u(1), s, pg_temp.cid(2), pg_temp.stage('limit 1'));
	f := pg_temp.stage('limit 6');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(2), f), '54000',
		'Member attachment capacity is reached');
	perform pg_temp.base_error(format('select public.qorpera_surface_image_commit(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(2), f),
		'54000', 'Member attachment capacity is reached');
end $$;

do $$
declare
	s constant uuid := '13470000-0000-4000-8000-000000000a01';
	a jsonb := pg_temp.upload(pg_temp.u(1), s, pg_temp.cid(3), 'start one');
	b jsonb := pg_temp.upload(pg_temp.u(1), s, pg_temp.cid(3), 'start two');
	r jsonb; again jsonb; v_sessions bigint; plain jsonb;
begin
	perform pg_temp.base_error(format('select pg_temp.start(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(3),
		jsonb_build_array(a, pg_temp.img(pg_temp.stage('never uploaded')))), '42501',
		'Attachment bytes must be uploaded for this exact member input');
	perform pg_temp.base_error(format('select pg_temp.start(%L, %L, %L, %L)', pg_temp.u(2), s, pg_temp.cid(3), jsonb_build_array(a)),
		'42501', 'Attachment bytes must be uploaded for this exact member input');
	perform pg_temp.base_error(format('select pg_temp.start(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(3), jsonb_build_array(a, a)),
		'22023', 'Member attachment is invalid');
	r := pg_temp.start(pg_temp.u(1), s, pg_temp.cid(3), jsonb_build_array(a, b));
	perform pg_temp.base_assert((select images from public.qorpera_surface_message_images where session_id = (r ->> 'id')::uuid
		and client_input_id = pg_temp.cid(3)) = jsonb_build_array(a, b), 'the start''s member message holds the images');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_surface_message_images r2
		join public.qorpera_surface_session_messages m on m.id = r2.message_id
		where r2.session_id = (r ->> 'id')::uuid and m.author_kind = 'member' and m.author_user_id = pg_temp.u(1)), 'on the member message');
	v_sessions := (select count(*) from public.qorpera_surface_sessions where surface_id = s);
	again := pg_temp.start(pg_temp.u(1), s, pg_temp.cid(3), jsonb_build_array(a, b));
	perform pg_temp.base_assert(again ->> 'id' = r ->> 'id' and (select count(*) from public.qorpera_surface_sessions where surface_id = s)
		= v_sessions, 'a replay answers the same session and starts none');
	perform pg_temp.base_error(format('select pg_temp.begin_image(%L, %L, %L, %L)', pg_temp.u(1), s, pg_temp.cid(3),
		pg_temp.stage('late')), '42501', 'Submitted input attachments cannot change');
	plain := pg_temp.start(pg_temp.u(1), s, pg_temp.cid(9), '[]'::jsonb);
	perform pg_temp.base_assert(plain ->> 'id' is not null and not exists (select 1 from public.qorpera_surface_message_images
		where session_id = (plain ->> 'id')::uuid), 'no images is the plain start');
	perform set_config('qorpera_test.smi_session', r ->> 'id', true);
end $$;

do $$
declare s constant uuid := '13470000-0000-4000-8000-000000000a01'; a jsonb := pg_temp.upload(pg_temp.u(1), s, pg_temp.cid(4), 'variant');
	r jsonb;
begin
	r := pg_temp.start(pg_temp.u(1), s, pg_temp.cid(4), jsonb_build_array(a), 2);
	perform pg_temp.base_assert((select count(*) from public.qorpera_surface_message_images i
		join public.qorpera_surface_sessions ss on ss.id = i.session_id
		where i.client_input_id = pg_temp.cid(4) and ss.exploration_id = (r ->> 'explorationId')::uuid) = 2,
		'both variants hold the images: ' || r::text);
end $$;

do $$
declare
	s constant uuid := '13470000-0000-4000-8000-000000000a01';
	v_session constant uuid := current_setting('qorpera_test.smi_session')::uuid;
	a jsonb := pg_temp.upload(pg_temp.u(1), s, pg_temp.cid(5), 'reply one');
	extra jsonb := pg_temp.upload(pg_temp.u(1), s, pg_temp.cid(5), 'reply unlisted');
	v_messages bigint;
begin
	perform pg_temp.reply(pg_temp.u(1), v_session, pg_temp.cid(5), jsonb_build_array(a));
	perform pg_temp.base_assert((select m.body from public.qorpera_surface_message_images i
		join public.qorpera_surface_session_messages m on m.id = i.message_id
		where i.session_id = v_session and i.client_input_id = pg_temp.cid(5)) = 'And this one', 'the reply''s message holds the images');
	v_messages := (select count(*) from public.qorpera_surface_session_messages where session_id = v_session);
	perform pg_temp.reply(pg_temp.u(1), v_session, pg_temp.cid(5), jsonb_build_array(a));
	perform pg_temp.base_assert((select count(*) from public.qorpera_surface_session_messages where session_id = v_session) = v_messages,
		'a replayed reply adds no message');
	perform pg_temp.base_error(format('select pg_temp.reply(%L, %L, %L, %L)', pg_temp.u(1),
		(select session_id from public.qorpera_surface_message_images where client_input_id = pg_temp.cid(4) limit 1), pg_temp.cid(3),
		jsonb_build_array(pg_temp.img(pg_temp.stage('start one')))), '42501', 'Submitted input attachments cannot change');
	perform pg_temp.base_error(format('select pg_temp.reply(%L, %L, %L, %L)', pg_temp.u(3), v_session, pg_temp.cid(5),
		jsonb_build_array(a)), '42501', 'Editor membership required');
	perform set_config('qorpera_test.smi_reply_image', a::text, true);
	perform set_config('qorpera_test.smi_extra_image', extra::text, true);
end $$;

do $$
declare
	v_session constant uuid := current_setting('qorpera_test.smi_session')::uuid;
	a constant jsonb := current_setting('qorpera_test.smi_reply_image')::jsonb;
	r jsonb;
begin
	r := pg_temp.as_call(pg_temp.u(3), format('select public.qorpera_surface_session_images(%L)', v_session));
	perform pg_temp.base_assert(r ->> 'schema' = 'qorpera.surface-session-images/v1' and r ->> 'sessionId' = v_session::text
		and jsonb_array_length(r -> 'messages') = 2 and r #>> '{messages,0,clientInputId}' = pg_temp.cid(3)::text
		and r #>> '{messages,1,clientInputId}' = pg_temp.cid(5)::text
		and r #> '{messages,1,images}' = jsonb_build_array(jsonb_build_object('sha256', a ->> 'objectSha256', 'bytes', a -> 'bytes',
			'mediaType', 'image/png')), 'the session''s images in message order: ' || r::text);
	perform pg_temp.base_error(format('select pg_temp.as_call(%L, %L)', pg_temp.u(5),
		format('select public.qorpera_surface_session_images(%L)', v_session)), '42501', 'Company membership required');
	r := pg_temp.as_call(pg_temp.u(3), format('select public.qorpera_surface_image_download(%L, %L, %L)', v_session, pg_temp.cid(5),
		a ->> 'objectSha256'));
	perform pg_temp.base_assert(r - 'manifestSha256' = jsonb_build_object('schema', 'qorpera.surface-image-download/v1',
		'environmentId', '92400000-0000-4000-8000-000000000020', 'sessionId', v_session, 'clientInputId', pg_temp.cid(5),
		'sha256', a ->> 'objectSha256', 'bytes', a -> 'bytes', 'mediaType', 'image/png', 'fileSha256', a ->> 'objectSha256',
		'path', pg_temp.path(pg_temp.cid(5), a)) and r ->> 'manifestSha256' ~ '^[0-9a-f]{64}$', 'the download: ' || r::text);
	perform pg_temp.base_error(format('select pg_temp.as_call(%L, %L)', pg_temp.u(3),
		format('select public.qorpera_surface_image_download(%L, %L, %L)', v_session, pg_temp.cid(5),
			current_setting('qorpera_test.smi_extra_image')::jsonb ->> 'objectSha256')), '42501', 'Attachment does not belong to this input');
	perform pg_temp.base_error(format('select pg_temp.as_call(%L, %L)', pg_temp.u(5),
		format('select public.qorpera_surface_image_download(%L, %L, %L)', v_session, pg_temp.cid(5), a ->> 'objectSha256')), '42501',
		'Surface attachment access is unavailable');
	perform pg_temp.base_error(format('select public.qorpera_surface_image_download(%L, %L, %L)', v_session, pg_temp.cid(5),
		a ->> 'objectSha256'), '42501', 'Surface attachment access is unavailable');
end $$;

do $$
declare
	v_session constant uuid := current_setting('qorpera_test.smi_session')::uuid;
	a constant jsonb := current_setting('qorpera_test.smi_reply_image')::jsonb;
	v_lease constant uuid := extensions.gen_random_uuid(); r jsonb; v_gone jsonb;
begin
	update public.qorpera_surface_sessions set state = 'running', lease_token = v_lease where id = v_session;
	r := public.qorpera_native_surface_session_images('92400000-0000-4000-8000-000000000010', v_session, v_lease);
	perform pg_temp.base_assert(r ->> 'schema' = 'qorpera.native-surface-session-images/v1'
		and r ->> 'latestMemberMessageId' = (select id::text from public.qorpera_surface_session_messages where session_id = v_session
			and author_kind = 'member' order by created_at desc limit 1)
		and jsonb_array_length(r -> 'messages') = 2 and (r #>> '{messages,0,latest}')::boolean is false
		and (r #>> '{messages,1,latest}')::boolean
		and r #> '{messages,1,images}' = jsonb_build_array(jsonb_build_object('sha256', a ->> 'objectSha256', 'bytes', a -> 'bytes',
			'mediaType', 'image/png', 'path', pg_temp.path(pg_temp.cid(5), a))), 'the runtime read: ' || r::text);
	perform pg_temp.base_error(format('select public.qorpera_native_surface_session_images(%L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', v_session, extensions.gen_random_uuid()), '42501', 'Surface session lease is not active');
	perform pg_temp.base_error(format('select public.qorpera_native_surface_session_images(%L, %L, %L)',
		extensions.gen_random_uuid(), v_session, v_lease), '42501', 'Surface session does not belong to profile');
	v_gone := r #> '{messages,0,images,0}';
	perform pg_temp.base_commit('{"kind":"platform"}', 'smi-tamper', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', v_gone ->> 'path', 'expectedVersion', pg_temp.entry_version(v_gone ->> 'path'))));
	r := public.qorpera_native_surface_session_images('92400000-0000-4000-8000-000000000010', v_session, v_lease);
	perform pg_temp.base_assert(jsonb_array_length(r #> '{messages,0,images}') = 1
		and r #>> '{messages,0,images,0,sha256}' <> v_gone ->> 'sha256', 'a gone image is left out: ' || r::text);
	perform pg_temp.base_error(format('select pg_temp.as_call(%L, %L)', pg_temp.u(1),
		format('select public.qorpera_surface_image_download(%L, %L, %L)', v_session, pg_temp.cid(3), v_gone ->> 'sha256')), '55000',
		'Attachment object is unavailable');
	update public.qorpera_surface_sessions set state = 'queued', lease_token = null where id = v_session;
end $$;

do $$
declare s constant uuid := '13470000-0000-4000-8000-000000000a01';
	a constant jsonb := current_setting('qorpera_test.smi_reply_image')::jsonb;
	extra constant jsonb := current_setting('qorpera_test.smi_extra_image')::jsonb;
begin
	update public.qorpera_surface_image_uploads set updated_at = clock_timestamp() - interval '25 hours'
	where surface_id = s and client_input_id in (pg_temp.cid(2), pg_temp.cid(5));
	perform set_config('request.jwt.claims', '', true);
	perform public.qorpera_surface_image_orphan_sweep();
	perform public.qorpera_surface_image_orphan_sweep();
	perform pg_temp.as_service();
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_surface_image_uploads where surface_id = s
		and client_input_id in (pg_temp.cid(2), pg_temp.cid(5))), 'the swept rows are gone');
	perform pg_temp.base_assert(pg_temp.entry_version('QorperaOS/surfaces/site/images/' || pg_temp.cid(2)) is null,
		'the folder of an input never sent is deleted');
	perform pg_temp.base_assert(pg_temp.entry_version(pg_temp.path(pg_temp.cid(5), extra)) is null
		and pg_temp.entry_version(pg_temp.path(pg_temp.cid(5), a)) is not null, 'a sent input keeps only the images it lists');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_surface_image_uploads where surface_id = s
		and client_input_id = pg_temp.cid(3)), 'a recent input is left');
end $$;

do $$
declare v_errcode text;
begin
	create or replace function public.qorpera_authorize_coding_turn(p_binding jsonb) returns jsonb language sql as $f$
		select jsonb_build_object('coding', jsonb_build_object('surfaceSessionId', p_binding ->> 'surface'))
	$f$;
	create or replace function public.qorpera_begin_native_company_execution_v2(p_binding jsonb, p_binary_sha256 text,
		p_runtime_bundle_sha256 text, p_reasoning_policy_sha256 text, p_tool_catalog_text text, p_context_sha256 text,
		p_context_bytes integer) returns jsonb language sql as $f$ select '{"admitted":true}'::jsonb $f$;
	perform pg_temp.base_assert(public.qorpera_begin_native_coding_execution(
		jsonb_build_object('surface', extensions.gen_random_uuid()), repeat('a', 64), repeat('b', 64), repeat('c', 64),
		'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"coding_finish"},{"name":"coding_ask"},{"name":"coding_record_change"},{"name":"coding_view_attachment"}]}',
		repeat('d', 64), 100) = '{"admitted":true}'::jsonb, 'a surface session admits its seven tools');
	begin
		perform public.qorpera_begin_native_coding_execution('{}'::jsonb, repeat('a', 64), repeat('b', 64), repeat('c', 64),
			'{"tools":[{"name":"coding_run_command"},{"name":"coding_read_command"},{"name":"coding_cancel_command"},{"name":"coding_finish"},{"name":"coding_view_attachment"}]}',
			repeat('d', 64), 100);
	exception when others then v_errcode := sqlstate || ':' || sqlerrm;
	end;
	perform pg_temp.base_assert(v_errcode = '42501:Coding catalog must contain only coding tools',
		'a coding session without a surface refuses coding_view_attachment: ' || coalesce(v_errcode, 'ok'));
	perform pg_temp.base_assert(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)
		like '%''coding_record_change'',''coding_view_attachment'',%', 'observations take coding_view_attachment');
end $$;

do $$
declare v record;
begin
	for v in select * from (values
		('public.qorpera_surface_image_begin(uuid,uuid,text,bigint,text)', true, false),
		('public.qorpera_surface_image_download(uuid,uuid,text)', true, false),
		('public.qorpera_start_surface_session_with_images(uuid,text,text,text,text,jsonb,integer,text,text[],uuid,jsonb)', true, false),
		('public.qorpera_reply_surface_session_with_images(uuid,text,boolean,uuid,jsonb)', true, false),
		('public.qorpera_surface_session_images(uuid)', true, false),
		('public.qorpera_surface_image_commit(uuid,uuid,uuid,jsonb)', false, true),
		('public.qorpera_native_surface_session_images(uuid,uuid,uuid)', false, true),
		('public.qorpera_surface_image_orphan_sweep(integer)', false, false),
		('public.qorpera_surface_images_check(uuid,uuid,uuid,jsonb)', false, false)) t(fn, member, service) loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v.fn, 'execute')
			and has_function_privilege('authenticated', v.fn, 'execute') = v.member
			and has_function_privilege('service_role', v.fn, 'execute') = v.service, 'grants of ' || v.fn);
	end loop;
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_native_host_calls
		where name = 'qorpera_native_surface_session_images' and scope = 'profile'), 'the runtime read is a host call');
end $$;

rollback;
