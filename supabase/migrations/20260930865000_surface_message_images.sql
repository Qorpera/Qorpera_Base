set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_image_begin(uuid,uuid,text,bigint,text)') is not null then
		raise exception 'Surface message images (20260930865000) is already applied'; end if;
	if to_regclass('public.qorpera_surface_session_messages') is null
		or to_regprocedure('public.qorpera_room_image_entry(uuid,text,jsonb)') is null
		or to_regprocedure('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)') is null then
		raise exception 'Surface message images (20260930865000) requires 20260930857000 and 20260930260000 first'; end if;
end $$;

create function pg_temp.smi_replace(p_function regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_function);
	v_i integer := 1;
	v_hits integer;
begin
	while v_i <= coalesce(array_length(p_pairs, 1), 0) loop
		v_hits := case when p_pairs[v_i] = '' then 0
			else (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]) end;
		if v_hits <> 1 then
			raise exception '20260930865000: anchor matched % time(s) in %: %', v_hits, p_function, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create table public.qorpera_surface_image_uploads (
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	client_input_id uuid not null,
	environment_id uuid not null,
	user_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (surface_id, client_input_id)
);
create index qorpera_surface_image_uploads_updated on public.qorpera_surface_image_uploads(updated_at);
alter table public.qorpera_surface_image_uploads enable row level security;
revoke all on public.qorpera_surface_image_uploads from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_message_images (
	message_id uuid primary key references public.qorpera_surface_session_messages(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_input_id uuid not null,
	images jsonb not null check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) between 1 and 5),
	created_at timestamptz not null default clock_timestamp(),
	unique (session_id, client_input_id)
);
create index qorpera_surface_message_images_input on public.qorpera_surface_message_images(surface_id, client_input_id);
alter table public.qorpera_surface_message_images enable row level security;
revoke all on public.qorpera_surface_message_images from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_image_environment(p_profile_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select environment_id from public.qorpera_company_files where profile_id = p_profile_id and core = 'folder-v2' limit 1
$$;

create function public.qorpera_surface_image_dir(p_surface_id uuid, p_client_input_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select 'QorperaOS/surfaces/' || s.slug || '/images/' || p_client_input_id::text
	from public.qorpera_surfaces s where s.id = p_surface_id and p_client_input_id is not null
$$;

create function public.qorpera_surface_image_path(p_surface_id uuid, p_client_input_id uuid, p_image jsonb)
returns text language sql stable security definer set search_path = '' as $$
	select public.qorpera_surface_image_dir(p_surface_id, p_client_input_id) || '/' || (p_image ->> 'objectSha256') || '.'
		|| case p_image ->> 'mediaType' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif'
			when 'image/webp' then 'webp' end
	where jsonb_typeof(p_image) = 'object' and coalesce(p_image ->> 'objectSha256', '') ~ '^[0-9a-f]{64}$'
		and p_image ->> 'mediaType' in ('image/png','image/jpeg','image/gif','image/webp')
$$;

create function public.qorpera_surface_images_normalized(p_images jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
begin
	if jsonb_typeof(p_images) is distinct from 'array' or jsonb_array_length(p_images) not between 1 and 5
		or not public.qorpera_room_post_images_valid(jsonb_build_object('images', p_images), true)
		or (select count(distinct i.value ->> 'objectSha256') from jsonb_array_elements(p_images) i) <> jsonb_array_length(p_images) then
		return null; end if;
	return (select jsonb_agg(jsonb_build_object('objectSha256', i.value ->> 'objectSha256', 'bytes', i.value -> 'bytes',
		'mediaType', i.value ->> 'mediaType') order by i.n) from jsonb_array_elements(p_images) with ordinality i(value, n));
end $$;

create function public.qorpera_surface_images_check(p_surface_id uuid, p_client_input_id uuid, p_user_id uuid, p_images jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_environment uuid := public.qorpera_surface_image_environment(
	(select profile_id from public.qorpera_surfaces where id = p_surface_id));
begin
	if v_environment is null
		or not exists (select 1 from public.qorpera_surface_image_uploads u where u.surface_id = p_surface_id
			and u.client_input_id = p_client_input_id and u.user_id = p_user_id and u.environment_id = v_environment)
		or exists (select 1 from jsonb_array_elements(p_images) i where not exists (select 1
			from public.qorpera_room_image_entry(v_environment,
				public.qorpera_surface_image_path(p_surface_id, p_client_input_id, i.value), i.value))) then
		raise exception 'Attachment bytes must be uploaded for this exact member input' using errcode = '42501'; end if;
end $$;

create function public.qorpera_surface_image_begin(p_surface_id uuid, p_client_input_id uuid, p_sha256 text, p_bytes bigint,
	p_media_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_surface public.qorpera_surfaces%rowtype; v_environment uuid;
	v_upload public.qorpera_surface_image_uploads%rowtype; v_image jsonb; v_path text;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Member attachment authority is required' using errcode = '42501'; end if;
	v_image := jsonb_build_object('objectSha256', p_sha256, 'bytes', p_bytes, 'mediaType', p_media_type);
	if p_client_input_id is null or public.qorpera_surface_images_normalized(jsonb_build_array(v_image)) is null then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);
	if exists (select 1 from public.qorpera_surface_message_images where surface_id = p_surface_id
		and client_input_id = p_client_input_id) then
		raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
	v_environment := public.qorpera_surface_image_environment(v_surface.profile_id);
	v_path := public.qorpera_surface_image_path(p_surface_id, p_client_input_id, v_image);
	if v_environment is null or v_path is null then
		raise exception 'Attachment folder is unavailable' using errcode = '55000'; end if;
	perform 1 from public.qorpera_profiles where id = v_surface.profile_id for key share;
	if not found then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_surface_image_uploads(surface_id, client_input_id, environment_id, user_id)
	values (p_surface_id, p_client_input_id, v_environment, v_user)
	on conflict (surface_id, client_input_id) do nothing;
	select * into v_upload from public.qorpera_surface_image_uploads
	where surface_id = p_surface_id and client_input_id = p_client_input_id for update;
	if not found then
		raise exception 'Member attachment could not be saved' using errcode = '55000'; end if;
	if v_upload.user_id <> v_user then
		raise exception 'Attachment input id is bound to another member' using errcode = '23505'; end if;
	if public.qorpera_room_image_capacity_reached(v_environment, v_path, p_bytes) then
		raise exception 'Member attachment capacity is reached' using errcode = '54000'; end if;
	update public.qorpera_surface_image_uploads set updated_at = clock_timestamp()
	where surface_id = p_surface_id and client_input_id = p_client_input_id;
	return jsonb_build_object('schema', 'qorpera.surface-image-begin/v1', 'environmentId', v_environment,
		'surfaceId', p_surface_id, 'clientInputId', p_client_input_id, 'sha256', p_sha256, 'bytes', p_bytes,
		'mediaType', p_media_type, 'path', v_path);
end $$;

create function public.qorpera_surface_image_commit(p_user_id uuid, p_surface_id uuid, p_client_input_id uuid, p_file jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_keys constant text[] := array['manifestSha256','fileSha256','bytes','mediaType','executable'];
	v_surface public.qorpera_surfaces%rowtype; v_upload public.qorpera_surface_image_uploads%rowtype;
	v_image jsonb; v_path text; v_dir text; v_units jsonb; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Member attachment authority is required' using errcode = '42501'; end if;
	if p_user_id is null or p_surface_id is null or p_client_input_id is null or jsonb_typeof(p_file) is distinct from 'object'
		or not (p_file ?& c_keys) or p_file - c_keys <> '{}'::jsonb or p_file -> 'executable' <> 'false'::jsonb
		or jsonb_typeof(p_file -> 'manifestSha256') is distinct from 'string' or p_file ->> 'manifestSha256' !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(p_file -> 'fileSha256') is distinct from 'string' then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	v_image := jsonb_build_object('objectSha256', p_file -> 'fileSha256', 'bytes', p_file -> 'bytes', 'mediaType', p_file -> 'mediaType');
	if public.qorpera_surface_images_normalized(jsonb_build_array(v_image)) is null then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_profiles
	where id = (select profile_id from public.qorpera_surfaces where id = p_surface_id) for key share;
	if not found then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	select * into v_upload from public.qorpera_surface_image_uploads
	where surface_id = p_surface_id and client_input_id = p_client_input_id for update;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_upload.user_id is distinct from p_user_id or v_surface.id is null
		or v_upload.environment_id is distinct from public.qorpera_surface_image_environment(v_surface.profile_id)
		or not exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_surface.profile_id
			and m.user_id = p_user_id and m.role <> 'viewer') then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_surface_message_images where surface_id = p_surface_id
		and client_input_id = p_client_input_id) then
		raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
	v_dir := public.qorpera_surface_image_dir(p_surface_id, p_client_input_id);
	v_path := public.qorpera_surface_image_path(p_surface_id, p_client_input_id, v_image);
	if v_dir is null or v_path is null then
		raise exception 'Attachment folder is unavailable' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_room_image_entry(v_upload.environment_id, v_path, v_image)) then
		if public.qorpera_room_image_capacity_reached(v_upload.environment_id, v_path, (v_image ->> 'bytes')::bigint) then
			raise exception 'Member attachment capacity is reached' using errcode = '54000'; end if;
		select coalesce(jsonb_agg(jsonb_build_object('op', 'mkdir', 'path', f.path) order by f.n), '[]'::jsonb) into v_units
		from unnest(array['QorperaOS', 'QorperaOS/surfaces', 'QorperaOS/surfaces/' || v_surface.slug,
			'QorperaOS/surfaces/' || v_surface.slug || '/images', v_dir]) with ordinality f(path, n)
		where not exists (select 1 from public.qorpera_folder_entries e
			where e.environment_id = v_upload.environment_id
				and e.key_sha256 = extensions.digest(public.qorpera_folder_key(f.path), 'sha256') and e.kind <> 'claim');
		v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'write', 'path', v_path, 'file', p_file));
		v_result := public.qorpera_folder_commit(v_upload.environment_id, '{"kind":"platform"}'::jsonb,
			'surface-image:' || p_client_input_id::text || ':' || extensions.gen_random_uuid()::text, v_units, null, null);
		if exists (select 1 from jsonb_array_elements(v_result -> 'units') u
				where u.value ->> 'outcome' <> 'saved' and u.value ->> 'reason' is distinct from 'exists')
			or not exists (select 1 from public.qorpera_room_image_entry(v_upload.environment_id, v_path, v_image)) then
			raise exception 'Member attachment could not be saved' using errcode = '55000'; end if;
	end if;
	update public.qorpera_surface_image_uploads set updated_at = clock_timestamp()
	where surface_id = p_surface_id and client_input_id = p_client_input_id;
	return jsonb_build_object('schema', 'qorpera.surface-image/v1', 'sha256', v_image ->> 'objectSha256', 'bytes', v_image -> 'bytes',
		'mediaType', v_image ->> 'mediaType', 'path', v_path);
end $$;

create function public.qorpera_surface_image_download(p_session_id uuid, p_client_input_id uuid, p_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_surface_sessions%rowtype; v_environment uuid; v_image jsonb;
	v_entry public.qorpera_folder_entries%rowtype;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_session.id is null
		or not exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_session.profile_id
			and m.user_id = auth.uid()) then
		raise exception 'Surface attachment access is unavailable' using errcode = '42501'; end if;
	select i.value into v_image
	from public.qorpera_surface_message_images r, jsonb_array_elements(r.images) i
	where r.session_id = p_session_id and r.client_input_id = p_client_input_id and i.value ->> 'objectSha256' = p_sha256
	limit 1;
	if v_image is null then
		raise exception 'Attachment does not belong to this input' using errcode = '42501'; end if;
	v_environment := public.qorpera_surface_image_environment(v_session.profile_id);
	select * into v_entry from public.qorpera_room_image_entry(v_environment,
		public.qorpera_surface_image_path(v_session.surface_id, p_client_input_id, v_image), v_image);
	if not found then
		raise exception 'Attachment object is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('schema', 'qorpera.surface-image-download/v1', 'environmentId', v_environment,
		'sessionId', p_session_id, 'clientInputId', p_client_input_id, 'sha256', p_sha256, 'bytes', v_entry.bytes,
		'mediaType', v_entry.media_type, 'manifestSha256', v_entry.manifest_sha256, 'fileSha256', v_entry.file_sha256,
		'path', v_entry.path);
end $$;

create function public.qorpera_surface_image_input_lock(p_profile_id uuid, p_surface_id uuid, p_client_input_id uuid,
	p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	perform 1 from public.qorpera_surface_image_uploads
	where surface_id = p_surface_id and client_input_id = p_client_input_id and user_id = p_user_id for update;
	if not found then
		raise exception 'Attachment bytes must be uploaded for this exact member input' using errcode = '42501'; end if;
end $$;

create function public.qorpera_start_surface_session_with_images(
	p_surface_id uuid,
	p_prompt text,
	p_title text default null,
	p_origin_kind text default 'member',
	p_origin_label text default null,
	p_origin_ref jsonb default null,
	p_exploration_count integer default null,
	p_exploration_title text default null,
	p_variant_labels text[] default null,
	p_client_input_id uuid default null,
	p_images jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_images jsonb; v_surface public.qorpera_surfaces%rowtype; v_user uuid; v_existing uuid; v_result jsonb;
	v_session public.qorpera_surface_sessions%rowtype;
begin
	if p_images is null or p_images = '[]'::jsonb then
		return public.qorpera_start_surface_session(p_surface_id, p_prompt, p_title, p_origin_kind, p_origin_label, p_origin_ref,
			p_exploration_count, p_exploration_title, p_variant_labels);
	end if;
	v_images := public.qorpera_surface_images_normalized(p_images);
	if p_client_input_id is null or v_images is null then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	v_user := public.qorpera_assert_surface_member(v_surface.profile_id, true);
	perform public.qorpera_surface_image_input_lock(v_surface.profile_id, v_surface.id, p_client_input_id, v_user);
	select r.session_id into v_existing from public.qorpera_surface_message_images r
	where r.surface_id = p_surface_id and r.client_input_id = p_client_input_id
	order by r.created_at desc, r.message_id limit 1;
	if v_existing is not null then
		select * into v_session from public.qorpera_surface_sessions where id = v_existing;
		return public.qorpera_surface_session_json(v_session);
	end if;
	perform public.qorpera_surface_images_check(p_surface_id, p_client_input_id, v_user, v_images);
	v_result := public.qorpera_start_surface_session(p_surface_id, p_prompt, p_title, p_origin_kind, p_origin_label, p_origin_ref,
		p_exploration_count, p_exploration_title, p_variant_labels);
	select * into v_session from public.qorpera_surface_sessions where id = (v_result ->> 'id')::uuid;
	insert into public.qorpera_surface_message_images(message_id, session_id, surface_id, profile_id, client_input_id, images)
	select m.id, m.session_id, p_surface_id, v_surface.profile_id, p_client_input_id, v_images
	from public.qorpera_surface_sessions s
	join public.qorpera_surface_session_messages m on m.session_id = s.id and m.author_kind = 'member' and m.author_user_id = v_user
	where s.surface_id = p_surface_id and s.created_by_user_id = v_user
		and (s.id = v_session.id or (v_session.exploration_id is not null and s.exploration_id = v_session.exploration_id));
	if not found then
		raise exception 'Surface session images could not be attached' using errcode = '55000'; end if;
	return v_result;
end $$;

create function public.qorpera_reply_surface_session_with_images(p_session_id uuid, p_message text, p_keep_open boolean,
	p_client_input_id uuid, p_images jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_images jsonb; v_session public.qorpera_surface_sessions%rowtype; v_surface public.qorpera_surfaces%rowtype;
	v_user uuid; v_result jsonb; v_message uuid;
begin
	if p_images is null or p_images = '[]'::jsonb then
		return public.qorpera_reply_surface_session(p_session_id, p_message, p_keep_open);
	end if;
	v_images := public.qorpera_surface_images_normalized(p_images);
	if p_client_input_id is null or v_images is null then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_user := public.qorpera_assert_surface_member(v_session.profile_id, true);
	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
	perform public.qorpera_surface_image_input_lock(v_surface.profile_id, v_surface.id, p_client_input_id, v_user);
	if exists (select 1 from public.qorpera_surface_message_images where session_id = p_session_id
		and client_input_id = p_client_input_id) then
		return public.qorpera_surface_session_json(v_session);
	end if;
	if exists (select 1 from public.qorpera_surface_message_images where surface_id = v_surface.id
		and client_input_id = p_client_input_id) then
		raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
	perform public.qorpera_surface_images_check(v_surface.id, p_client_input_id, v_user, v_images);
	v_result := public.qorpera_reply_surface_session(p_session_id, p_message, p_keep_open);
	select m.id into v_message from public.qorpera_surface_session_messages m
	where m.session_id = p_session_id and m.author_kind = 'member' and m.author_user_id = v_user
		and not exists (select 1 from public.qorpera_surface_message_images r where r.message_id = m.id)
	order by m.created_at desc, m.id desc limit 1;
	if v_message is null then
		raise exception 'Surface session images could not be attached' using errcode = '55000'; end if;
	insert into public.qorpera_surface_message_images(message_id, session_id, surface_id, profile_id, client_input_id, images)
	values (v_message, p_session_id, v_surface.id, v_session.profile_id, p_client_input_id, v_images);
	return v_result;
end $$;

create function public.qorpera_surface_session_images(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_surface_sessions%rowtype;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, false);
	return jsonb_build_object('schema', 'qorpera.surface-session-images/v1', 'sessionId', p_session_id,
		'messages', coalesce((select jsonb_agg(jsonb_build_object('messageId', r.message_id, 'clientInputId', r.client_input_id,
			'images', (select jsonb_agg(jsonb_build_object('sha256', i.value ->> 'objectSha256', 'bytes', i.value -> 'bytes',
				'mediaType', i.value ->> 'mediaType') order by i.n) from jsonb_array_elements(r.images) with ordinality i(value, n)))
			order by m.created_at, m.id)
		from public.qorpera_surface_message_images r
		join public.qorpera_surface_session_messages m on m.id = r.message_id
		where r.session_id = p_session_id), '[]'::jsonb));
end $$;

create function public.qorpera_native_surface_session_images(p_profile_id uuid, p_session_id uuid, p_lease_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_surface_sessions%rowtype; v_environment uuid; v_latest uuid;
begin
	if p_lease_token is null then
		raise exception 'Surface session images read requires lease token' using errcode = '42501'; end if;
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id and profile_id = p_profile_id;
	if v_session.id is null then
		raise exception 'Surface session does not belong to profile' using errcode = '42501'; end if;
	if v_session.state not in ('running', 'reconciling_running') or v_session.lease_token is distinct from p_lease_token then
		raise exception 'Surface session lease is not active' using errcode = '42501'; end if;
	v_environment := public.qorpera_surface_image_environment(p_profile_id);
	select m.id into v_latest from public.qorpera_surface_session_messages m
	where m.session_id = p_session_id and m.author_kind = 'member'
	order by m.created_at desc, m.id desc limit 1;
	return jsonb_build_object('schema', 'qorpera.native-surface-session-images/v1', 'sessionId', p_session_id,
		'latestMemberMessageId', v_latest,
		'messages', coalesce((select jsonb_agg(jsonb_build_object('messageId', x.message_id, 'clientInputId', x.client_input_id,
			'latest', x.message_id = v_latest, 'images', x.images) order by x.created_at, x.message_id)
		from (select r.message_id, r.client_input_id, m.created_at,
				(select jsonb_agg(jsonb_build_object('sha256', e.file_sha256, 'bytes', e.bytes, 'mediaType', e.media_type,
					'path', e.path) order by i.n)
				from jsonb_array_elements(r.images) with ordinality i(value, n)
				cross join lateral public.qorpera_room_image_entry(v_environment,
					public.qorpera_surface_image_path(r.surface_id, r.client_input_id, i.value), i.value) e) as images
			from public.qorpera_surface_message_images r
			join public.qorpera_surface_session_messages m on m.id = r.message_id
			where r.session_id = p_session_id) x
		where x.images is not null), '[]'::jsonb));
end $$;

create function public.qorpera_surface_image_orphan_sweep(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_candidate record; v_row public.qorpera_surface_image_uploads%rowtype; v_listed jsonb; v_dir text;
	v_folder public.qorpera_folder_entries%rowtype; v_units jsonb; v_result jsonb;
	v_claims text; v_claim_role text; v_saved boolean; v_done integer := 0;
begin
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'The surface image sweep runs at read committed' using errcode = '25000'; end if;
	for v_candidate in select u.surface_id, u.client_input_id, s.profile_id
		from public.qorpera_surface_image_uploads u join public.qorpera_surfaces s on s.id = u.surface_id
		where u.updated_at < clock_timestamp() - interval '24 hours'
			and not exists (select 1 from public.qorpera_company_deletions d where d.profile_id = s.profile_id)
		order by u.updated_at limit greatest(coalesce(p_limit, 100), 0)
	loop
		perform 1 from public.qorpera_profiles where id = v_candidate.profile_id for key share skip locked;
		if not found then continue; end if;
		select * into v_row from public.qorpera_surface_image_uploads
		where surface_id = v_candidate.surface_id and client_input_id = v_candidate.client_input_id
			and updated_at < clock_timestamp() - interval '24 hours'
		for update skip locked;
		if not found then continue; end if;
		v_units := '[]'::jsonb; v_saved := false;
		begin
			v_folder := null;
			select coalesce(jsonb_agg(distinct i.value), '[]'::jsonb) into v_listed
			from public.qorpera_surface_message_images r, jsonb_array_elements(r.images) i
			where r.surface_id = v_row.surface_id and r.client_input_id = v_row.client_input_id;
			v_dir := public.qorpera_surface_image_dir(v_row.surface_id, v_row.client_input_id);
			select * into v_folder from public.qorpera_folder_entries
			where environment_id = v_row.environment_id and key_sha256 = extensions.digest(public.qorpera_folder_key(v_dir), 'sha256')
				and kind = 'folder';
			if v_folder.path is not null and jsonb_array_length(v_listed) = 0 then
				v_units := jsonb_build_array(jsonb_build_object('op', 'delete', 'path', v_folder.path, 'expectedVersion', v_folder.version,
					'asOfSeq', (select c.last_seq from public.qorpera_folder_clocks c where c.environment_id = v_row.environment_id)));
			elsif v_folder.path is not null then
				v_units := coalesce((select jsonb_agg(jsonb_build_object('op', 'delete', 'path', e.path, 'expectedVersion', e.version)
						order by e.path)
					from public.qorpera_folder_entries e
					where e.environment_id = v_row.environment_id
						and e.parent_key_sha256 = extensions.digest(public.qorpera_folder_key(v_dir), 'sha256')
						and e.kind <> 'claim' and not exists (select 1 from jsonb_array_elements(v_listed) i
							where public.qorpera_folder_key(public.qorpera_surface_image_path(v_row.surface_id, v_row.client_input_id, i.value))
								= e.key_text)),
					'[]'::jsonb);
			end if;
			if jsonb_array_length(v_units) > 0 then
				v_claims := current_setting('request.jwt.claims', true);
				v_claim_role := current_setting('request.jwt.claim.role', true);
				perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
				perform set_config('request.jwt.claim.role', 'service_role', true);
				v_result := public.qorpera_folder_commit(v_row.environment_id, '{"kind":"platform"}'::jsonb,
					'surface-image-sweep:' || v_row.client_input_id::text || ':' || extensions.gen_random_uuid()::text, v_units, null, null);
				perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
				perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
				if exists (select 1 from jsonb_array_elements(v_result -> 'units') u
					where u.value ->> 'outcome' <> 'saved' and u.value ->> 'reason' is distinct from 'missing') then
					raise exception 'Surface images of input % were not deleted: %', v_row.client_input_id, v_result -> 'units'
						using errcode = '55000'; end if;
				if jsonb_array_length(v_listed) = 0 and exists (select 1 from public.qorpera_surface_message_images
					where surface_id = v_row.surface_id and client_input_id = v_row.client_input_id) then
					raise exception 'Input % was sent while its images were swept', v_row.client_input_id using errcode = '55000'; end if;
			end if;
			delete from public.qorpera_surface_image_uploads
			where surface_id = v_row.surface_id and client_input_id = v_row.client_input_id;
			v_done := v_done + 1;
			v_saved := jsonb_array_length(v_units) > 0;
		exception when others then
			raise warning 'Surface image sweep left input % of surface % for later: %', v_row.client_input_id, v_row.surface_id, sqlerrm;
		end;
		exit when v_saved;
	end loop;
	return v_done;
end $$;

create function public.qorpera_schedule_surface_image_sweep()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The surface image sweep was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.surface-image-sweep-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-surface-image-sweep', '* * * * *', 'select public.qorpera_surface_image_orphan_sweep()');
		v_clean := cron.schedule('qorpera-surface-image-sweep-log', '31 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-surface-image-sweep')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The surface image sweep was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.surface-image-sweep-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.surface-image-sweep-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

select pg_temp.smi_replace('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure, array[
	$old$not between 4 and (case when v_is_surface then 6 else 5 end)$old$,
	$new$not between 4 and (case when v_is_surface then 7 else 5 end)$new$,
	$old$and not (v_is_surface and tool ->> 'name' = 'coding_record_change')$old$,
	$new$and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment'))$new$
]);

select pg_temp.smi_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure, array[
	$old$'coding_record_change','propose_surface',$old$,
	$new$'coding_record_change','coding_view_attachment','propose_surface',$new$
]);

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_native_surface_session_images', 'profile')
on conflict (name) do nothing;

revoke all on function public.qorpera_surface_image_environment(uuid), public.qorpera_surface_image_dir(uuid, uuid),
	public.qorpera_surface_image_path(uuid, uuid, jsonb), public.qorpera_surface_images_normalized(jsonb),
	public.qorpera_surface_images_check(uuid, uuid, uuid, jsonb),
	public.qorpera_surface_image_input_lock(uuid, uuid, uuid, uuid),
	public.qorpera_surface_image_orphan_sweep(integer), public.qorpera_schedule_surface_image_sweep()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_surface_image_begin(uuid, uuid, text, bigint, text),
	public.qorpera_surface_image_download(uuid, uuid, text),
	public.qorpera_start_surface_session_with_images(uuid, text, text, text, text, jsonb, integer, text, text[], uuid, jsonb),
	public.qorpera_reply_surface_session_with_images(uuid, text, boolean, uuid, jsonb),
	public.qorpera_surface_session_images(uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_surface_image_begin(uuid, uuid, text, bigint, text),
	public.qorpera_surface_image_download(uuid, uuid, text),
	public.qorpera_start_surface_session_with_images(uuid, text, text, text, text, jsonb, integer, text, text[], uuid, jsonb),
	public.qorpera_reply_surface_session_with_images(uuid, text, boolean, uuid, jsonb),
	public.qorpera_surface_session_images(uuid)
	to authenticated;
revoke all on function public.qorpera_surface_image_commit(uuid, uuid, uuid, jsonb),
	public.qorpera_native_surface_session_images(uuid, uuid, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_surface_image_commit(uuid, uuid, uuid, jsonb),
	public.qorpera_native_surface_session_images(uuid, uuid, uuid)
	to service_role;

select public.qorpera_schedule_surface_image_sweep();

drop function pg_temp.smi_replace(regprocedure, text[]);
