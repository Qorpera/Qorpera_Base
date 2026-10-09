-- Chat images on folder-v2 (supabase/CLIENT-CONTRACT.md "Chat images"; deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md
-- §6): a member's image in an agent's thread or a group chat is a folder file under the conversation's summary-tree root
-- (20260928509150), <root>/images/<client input id>/<sha256>.<png|jpg|gif|webp>. Only the platform writes it, by a memory
-- commit that names the conversation's generation, so an erase discards a save built before it. The input's body names
-- each image by hash, bytes and media type, as before; the hash is kept nowhere else.
--
-- 1. qorpera_memory_tree_path_allowed: a memory commit may also make <root>/images and a folder per input under it,
--    write an image there, and delete the images or a folder of them; qorpera_memory_tree_paths: each such change names
--    the conversation's generation, as a summary's does.
-- 2. qorpera_room_image_uploads: the member who may add images to one client input of one conversation.
-- 3. qorpera_room_image_begin (a member of the room): the input id, the image and the per-input limits (5 images and
--    8 MiB, as a post's), and the image's path. The object gateway stages the bytes as the platform, then calls
--    qorpera_room_image_commit (service role), which saves the file. qorpera_room_image_download (a member who may read
--    the conversation): one image of a canonical input, as its folder file.
-- 4. The post and the input trigger: each image of a new folder-v2 input is a live file that this member uploaded for
--    this input (42501 otherwise), and a submitted input's images do not change. Their snapshot-v1 arms stay the legacy
--    sweep's; step D drops the snapshot-v1 attachment upload with them.
-- 5. qorpera_room_image_orphan_sweep, every minute through pg_cron: a day after an input's last upload, the images that
--    no input lists are deleted, and the row with them; at most one folder commit per call.
-- The zoom does not name an image's path yet: the runtime reads an attachment's mediaType and bytes only, so the path
-- comes with the runtime that opens it. Every patched body carries the marker 20260930260000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_room_image_begin(uuid,uuid,text,bigint,text)') is not null then
		raise exception 'Chat images (20260930260000) is already applied'; end if;
end $$;

create function pg_temp.chat_images_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Chat images anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. A tree's images ---------------------------------------------------------------------------------------------------

-- The paths, added before the refusal of anything else, so W1's run log paths compose with them in either order.
select pg_temp.chat_images_replace('public.qorpera_memory_tree_path_allowed(text,text,text)'::regprocedure,
	E'\t\telse false\n',
	E'\t\t-- 20260930260000: a conversation''s chat images, a folder per client input, each image named by its hash.\n'
	|| E'\t\twhen p_rel = ''images'' then p_kind = ''folder'' and p_op in (''mkdir'',''new_folder'')\n'
	|| E'\t\twhen p_rel ~ ''^images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' then\n'
	|| E'\t\t\tp_kind = ''folder'' and p_op in (''mkdir'',''new_folder'',''delete'')\n'
	|| E'\t\twhen p_rel ~ ''^images/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\\.(png|jpg|gif|webp)$'' then\n'
	|| E'\t\t\tp_kind = ''file'' and p_op in (''write'',''delete'')\n'
	|| E'\t\telse false\n');

select pg_temp.chat_images_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	E'\t\t\t\t\t''a summary tree holds only tree.toml and its blocks; only blocks are deleted''))); end if;\n',
	E'\t\t\t\t\t/* 20260930260000 */ ''a summary tree holds only tree.toml, its blocks and its images; only blocks and images are deleted''))); end if;\n');
select pg_temp.chat_images_replace('public.qorpera_memory_tree_paths(uuid,text,text,text,jsonb,text,text)'::regprocedure,
	E'\t\t-- The root holds no summary, so making it names no generation.\n'
	|| E'\t\tif v_rel = ''tree.toml'' or v_rel ~ ''^t([0-9]|1[0-4])(/|$)'' then\n',
	E'\t\t-- The root holds no summary, so making it names no generation. Its images do (20260930260000), so an erase\n'
	|| E'\t\t-- discards an image saved from before it.\n'
	|| E'\t\tif v_rel = ''tree.toml'' or v_rel ~ ''^t([0-9]|1[0-4])(/|$)'' or v_rel ~ ''^images(/|$)'' then\n');

-- 2. The uploads -------------------------------------------------------------------------------------------------------

create table public.qorpera_room_image_uploads (
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	client_input_id uuid not null,
	environment_id uuid not null,
	user_id uuid not null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	primary key (session_id, client_input_id)
);
create index qorpera_room_image_uploads_updated on public.qorpera_room_image_uploads(updated_at);
alter table public.qorpera_room_image_uploads enable row level security;
revoke all on public.qorpera_room_image_uploads from public, anon, authenticated, service_role;
comment on table public.qorpera_room_image_uploads is
	'Chat images on folder-v2 (20260930260000): the member who may add images to one client input of one conversation. '
	'The images are folder files under the conversation''s tree root; updated_at is the last upload, and the sweep deletes '
	'what no input lists a day after it.';

-- 3. Helpers (plain reads) ---------------------------------------------------------------------------------------------

-- The member's folder-v2 room for a conversation: active, bound to the open conversation, with the member in the company
-- and active in the room. No row otherwise.
create function public.qorpera_room_image_room(p_session_id uuid, p_user_id uuid)
returns setof public.qorpera_company_rooms language sql stable set search_path = '' as $$
	select r.* from public.qorpera_company_rooms r
	join public.qorpera_shared_sessions s on s.id = r.session_id
	where r.session_id = p_session_id and r.status = 'active' and s.status = 'open' and s.profile_id = r.profile_id
		and s.environment_id = r.environment_id and s.execution_scope ->> 'roomId' = r.id::text
		and public.qorpera_company_is_folder_v2(r.profile_id)
		and exists (select 1 from public.qorpera_profile_members m where m.profile_id = r.profile_id and m.user_id = p_user_id)
		and exists (select 1 from public.qorpera_company_room_members m where m.room_id = r.id and m.principal_kind = 'member'
			and m.principal_id = p_user_id and m.status = 'active')
	limit 1
$$;

-- A conversation's tree root key: its agent's for a thread, its group chat's for a group chat; null when it has none.
create function public.qorpera_room_image_root(p_session_id uuid)
returns text language sql stable set search_path = '' as $$
	select public.qorpera_memory_owner_root(s.environment_id, case when r.bound_staff_agent_id is not null then 'agent' else 'group' end,
		coalesce(r.bound_staff_agent_id, r.id))
	from public.qorpera_shared_sessions s
	join public.qorpera_company_rooms r on r.session_id = s.id
	where s.id = p_session_id
	limit 1
$$;

-- An image's key: <root>/images/<client input id>/<sha256>.<ext>; null when the conversation has no root or the image
-- is malformed.
create function public.qorpera_room_image_path(p_session_id uuid, p_client_input_id uuid, p_image jsonb)
returns text language sql stable set search_path = '' as $$
	select public.qorpera_room_image_root(p_session_id) || '/images/' || p_client_input_id::text || '/' || (p_image ->> 'objectSha256')
		|| '.' || case p_image ->> 'mediaType' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/gif' then 'gif'
			when 'image/webp' then 'webp' end
	where p_client_input_id is not null and jsonb_typeof(p_image) = 'object'
		and coalesce(p_image ->> 'objectSha256', '') ~ '^[0-9a-f]{64}$'
		and p_image ->> 'mediaType' in ('image/png','image/jpeg','image/gif','image/webp')
$$;

-- The live file at an image's path with its hash, bytes and media type; no row otherwise.
create function public.qorpera_room_image_entry(p_environment_id uuid, p_path text, p_image jsonb)
returns setof public.qorpera_folder_entries language sql stable set search_path = '' as $$
	select e.* from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(public.qorpera_folder_key(p_path), 'sha256')
		and e.kind = 'file' and e.file_sha256 = p_image ->> 'objectSha256' and to_jsonb(e.bytes) = p_image -> 'bytes'
		and e.media_type = p_image ->> 'mediaType'
$$;

-- Whether one more image of p_bytes at p_path would pass an input's limits: 5 images and 8 MiB, counting the live files
-- beside it and not the one at p_path.
create function public.qorpera_room_image_capacity_reached(p_environment_id uuid, p_path text, p_bytes bigint)
returns boolean language sql stable set search_path = '' as $$
	select count(*) >= 5 or coalesce(sum(e.bytes), 0) + p_bytes > 8388608
	from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'file'
		and e.parent_key_sha256 = extensions.digest(public.qorpera_folder_key(regexp_replace(p_path, '/[^/]+$', '')), 'sha256')
		and e.key_sha256 <> extensions.digest(public.qorpera_folder_key(p_path), 'sha256')
$$;

-- A new input's images (the post's check, and the trigger's): the member began this input's uploads, and each image is a
-- live file at its path with its hash, bytes and media type. Volatile, so each read sees what committed before it.
create function public.qorpera_room_images_check(p_session_id uuid, p_client_input_id uuid, p_user_id uuid, p_body jsonb)
returns void language plpgsql set search_path = '' as $$
declare v_environment uuid := (select environment_id from public.qorpera_shared_sessions where id = p_session_id);
begin
	if v_environment is null or jsonb_typeof(p_body -> 'images') is distinct from 'array'
		or not exists (select 1 from public.qorpera_room_image_uploads u where u.session_id = p_session_id
			and u.client_input_id = p_client_input_id and u.user_id = p_user_id)
		or exists (select 1 from jsonb_array_elements(p_body -> 'images') i where not exists (select 1
			from public.qorpera_room_image_entry(v_environment,
				public.qorpera_room_image_path(p_session_id, p_client_input_id, i.value), i.value))) then
		raise exception 'Attachment bytes must be uploaded for this exact member input' using errcode = '42501'; end if;
end $$;

-- 4. Begin, commit and download ----------------------------------------------------------------------------------------

-- A member's first step for one image of an input not yet posted: the room, the image, the input id (which this member
-- holds from the first image on) and the limits. Answers the image's path; the gateway stages the bytes and commits.
create function public.qorpera_room_image_begin(p_session_id uuid, p_client_input_id uuid, p_sha256 text, p_bytes bigint,
	p_media_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_room public.qorpera_company_rooms%rowtype;
	v_upload public.qorpera_room_image_uploads%rowtype; v_image jsonb; v_path text;
begin
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'Member attachment authority is required' using errcode = '42501'; end if;
	v_image := jsonb_build_object('objectSha256', p_sha256, 'bytes', p_bytes, 'mediaType', p_media_type);
	if p_client_input_id is null
		or not public.qorpera_room_post_images_valid(jsonb_build_object('images', jsonb_build_array(v_image)), true) then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	select * into v_room from public.qorpera_room_image_room(p_session_id, v_user);
	if v_room.id is null then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_session_inputs where session_id = p_session_id and client_input_id = p_client_input_id) then
		raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
	v_path := public.qorpera_room_image_path(p_session_id, p_client_input_id, v_image);
	if v_path is null then
		raise exception 'Attachment folder is unavailable' using errcode = '55000'; end if;
	-- The company first (KEY SHARE, rank 0), as the commit and the sweep take it.
	perform 1 from public.qorpera_profiles where id = v_room.profile_id for key share;
	if not found then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_room_image_uploads(session_id, client_input_id, environment_id, user_id)
	values (p_session_id, p_client_input_id, v_room.environment_id, v_user)
	on conflict (session_id, client_input_id) do nothing;
	select * into v_upload from public.qorpera_room_image_uploads
	where session_id = p_session_id and client_input_id = p_client_input_id for update;
	if not found then
		raise exception 'Member attachment could not be saved' using errcode = '55000'; end if;
	if v_upload.user_id <> v_user then
		raise exception 'Attachment input id is bound to another member' using errcode = '23505'; end if;
	if public.qorpera_room_image_capacity_reached(v_room.environment_id, v_path, p_bytes) then
		raise exception 'Member attachment capacity is reached' using errcode = '54000'; end if;
	update public.qorpera_room_image_uploads set updated_at = clock_timestamp()
	where session_id = p_session_id and client_input_id = p_client_input_id;
	return jsonb_build_object('schema', 'qorpera.room-image-begin/v1', 'environmentId', v_room.environment_id,
		'sessionId', p_session_id, 'clientInputId', p_client_input_id, 'sha256', p_sha256, 'bytes', p_bytes,
		'mediaType', p_media_type, 'path', v_path);
end $$;

-- The object gateway's save of one staged image (service role; the bytes staged by the platform actor): the company
-- KEY SHARE, then the member's upload row FOR UPDATE, the room again, the limits again, then one memory commit as the
-- platform that makes the folders still missing and writes the file, naming the conversation's generation. An input
-- posted meanwhile refuses it. The same file again answers as saved.
--
-- Locks: the company row comes first (rank 0), so a purge, which holds it FOR UPDATE before its cascade reaches the
-- conversation and this row, is met there and never in the other order. The upload row comes before the memory
-- commit's own locks (its operation key is new each time, then the conversation FOR SHARE at rank 11, the paths and
-- the clock). A commit that finds the generation raised (an erase between the read and the conversation's lock) saves
-- nothing and leaves the clock alone; the second attempt holds the conversation's lock from the first, so it reads the
-- generation that stays.
create function public.qorpera_room_image_commit(p_user_id uuid, p_session_id uuid, p_client_input_id uuid, p_file jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_keys constant text[] := array['manifestSha256','fileSha256','bytes','mediaType','executable'];
	v_room public.qorpera_company_rooms%rowtype; v_upload public.qorpera_room_image_uploads%rowtype;
	v_image jsonb; v_root text; v_path text; v_dir text; v_units jsonb; v_result jsonb; v_attempt integer := 0;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Member attachment authority is required' using errcode = '42501'; end if;
	if p_user_id is null or p_session_id is null or p_client_input_id is null or jsonb_typeof(p_file) is distinct from 'object'
		or not (p_file ?& c_keys) or p_file - c_keys <> '{}'::jsonb or p_file -> 'executable' <> 'false'::jsonb
		or jsonb_typeof(p_file -> 'manifestSha256') is distinct from 'string' or p_file ->> 'manifestSha256' !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(p_file -> 'fileSha256') is distinct from 'string' then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	v_image := jsonb_build_object('objectSha256', p_file -> 'fileSha256', 'bytes', p_file -> 'bytes', 'mediaType', p_file -> 'mediaType');
	if not public.qorpera_room_post_images_valid(jsonb_build_object('images', jsonb_build_array(v_image)), true) then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_profiles
	where id = (select profile_id from public.qorpera_shared_sessions where id = p_session_id) for key share;
	if not found then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	select * into v_upload from public.qorpera_room_image_uploads
	where session_id = p_session_id and client_input_id = p_client_input_id for update;
	select * into v_room from public.qorpera_room_image_room(p_session_id, p_user_id);
	if v_upload.user_id is distinct from p_user_id or v_room.id is null or v_room.environment_id <> v_upload.environment_id then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_session_inputs where session_id = p_session_id and client_input_id = p_client_input_id) then
		raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
	v_root := public.qorpera_room_image_root(p_session_id);
	v_path := public.qorpera_room_image_path(p_session_id, p_client_input_id, v_image);
	if v_root is null or v_path is null then
		raise exception 'Attachment folder is unavailable' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_room_image_entry(v_room.environment_id, v_path, v_image)) then
		if public.qorpera_room_image_capacity_reached(v_room.environment_id, v_path, (v_image ->> 'bytes')::bigint) then
			raise exception 'Member attachment capacity is reached' using errcode = '54000'; end if;
		v_dir := v_root || '/images/' || p_client_input_id::text;
		-- The folders still missing on the way (an agent's notebook folder, the root, images/, the input's), then the image.
		select coalesce(jsonb_agg(jsonb_build_object('op', 'mkdir', 'path', f.path) order by f.n), '[]'::jsonb) into v_units
		from unnest(array[case when v_root ~ '/thread$' then regexp_replace(v_root, '/thread$', '') end, v_root,
			v_root || '/images', v_dir]) with ordinality f(path, n)
		where f.path is not null and not exists (select 1 from public.qorpera_folder_entries e
			where e.environment_id = v_room.environment_id and e.key_sha256 = extensions.digest(public.qorpera_folder_key(f.path), 'sha256')
				and e.kind <> 'claim');
		v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'write', 'path', v_path, 'file', p_file));
		loop
			v_attempt := v_attempt + 1;
			v_result := public.qorpera_folder_memory_commit(v_room.environment_id, '{"kind":"platform"}'::jsonb,
				'chat-image:' || p_client_input_id::text || ':' || extensions.gen_random_uuid()::text, v_units,
				jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', p_session_id,
					'generation', (select memory_generation from public.qorpera_shared_sessions where id = p_session_id)))));
			exit when v_attempt >= 2 or not exists (select 1 from jsonb_array_elements(v_result -> 'units') u
				where u.value ->> 'reason' = 'memory_generation_stale');
		end loop;
		-- A folder made meanwhile is no failure; the file must be there now.
		if exists (select 1 from jsonb_array_elements(v_result -> 'units') u
				where u.value ->> 'outcome' <> 'saved' and u.value ->> 'reason' is distinct from 'exists')
			or not exists (select 1 from public.qorpera_room_image_entry(v_room.environment_id, v_path, v_image)) then
			raise exception 'Member attachment could not be saved' using errcode = '55000'; end if;
		if exists (select 1 from public.qorpera_session_inputs where session_id = p_session_id and client_input_id = p_client_input_id) then
			raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
	end if;
	update public.qorpera_room_image_uploads set updated_at = clock_timestamp()
	where session_id = p_session_id and client_input_id = p_client_input_id;
	return jsonb_build_object('schema', 'qorpera.room-image/v1', 'sha256', v_image ->> 'objectSha256', 'bytes', v_image -> 'bytes',
		'mediaType', v_image ->> 'mediaType', 'path', v_path);
end $$;

-- One image of a canonical input, for a member who may read the conversation: the folder file the gateway serves. An
-- erased message serves none.
create function public.qorpera_room_image_download(p_session_id uuid, p_input_id uuid, p_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_input public.qorpera_session_inputs%rowtype; v_image jsonb;
	v_entry public.qorpera_folder_entries%rowtype;
begin
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id;
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_session.id is null
		or not public.qorpera_company_is_folder_v2(v_session.profile_id) or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Chat attachment access is unavailable' using errcode = '42501'; end if;
	select * into v_input from public.qorpera_session_inputs where id = p_input_id and session_id = p_session_id;
	if v_input.kind is distinct from 'user_message' or v_input.body ->> 'schema' is distinct from 'qorpera.session-prompt/v1'
		or not exists (select 1 from public.qorpera_session_events where session_id = p_session_id and event_id = p_input_id
			and session_input_id = p_input_id and actor_user_id = v_input.author_user_id and body <> '{"erased":true}'::jsonb) then
		raise exception 'Canonical chat input is unavailable' using errcode = '42501'; end if;
	select i.value into v_image from jsonb_array_elements(case when jsonb_typeof(v_input.body -> 'images') = 'array'
		then v_input.body -> 'images' else '[]'::jsonb end) i where i.value ->> 'objectSha256' = p_sha256 limit 1;
	if v_image is null then
		raise exception 'Attachment does not belong to this canonical input' using errcode = '42501'; end if;
	select * into v_entry from public.qorpera_room_image_entry(v_session.environment_id,
		public.qorpera_room_image_path(p_session_id, v_input.client_input_id, v_image), v_image);
	if not found then
		raise exception 'Attachment object is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('schema', 'qorpera.room-image-download/v1', 'environmentId', v_session.environment_id,
		'sessionId', p_session_id, 'inputId', p_input_id, 'sha256', p_sha256, 'bytes', v_entry.bytes, 'mediaType', v_entry.media_type,
		'manifestSha256', v_entry.manifest_sha256, 'fileSha256', v_entry.file_sha256, 'path', v_entry.path);
end $$;

-- 5. The post and the input trigger ------------------------------------------------------------------------------------

-- The post checks the images before the sponsor and the locks, for a clear refusal; the trigger's check below decides.
select pg_temp.chat_images_replace('public.qorpera_folder_post_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure,
	E'\tif jsonb_typeof(p_body -> ''images'') = ''array'' and jsonb_array_length(p_body -> ''images'') > 0 then\n'
	|| E'\t\traise exception ''Images in conversations do not serve folder-v2 companies yet'' using errcode = ''0A000''; end if;\n',
	E'\t-- 20260930260000: each image is a live file this member uploaded for this input, unless the input is there already\n'
	|| E'\t-- (a replay, compared below).\n'
	|| E'\tif jsonb_typeof(p_body -> ''images'') = ''array'' and jsonb_array_length(p_body -> ''images'') > 0\n'
	|| E'\t\tand not exists (select 1 from public.qorpera_session_inputs where session_id = v_room.session_id\n'
	|| E'\t\t\tand client_input_id = p_client_input_id) then\n'
	|| E'\t\tperform public.qorpera_room_images_check(v_room.session_id, p_client_input_id, v_user, p_body); end if;\n');

-- The trigger's folder-v2 arm: an input inserted with images is a member's prompt whose images pass the check, read
-- after the conversation's lock; a submitted input's images, author, id and conversation do not change. An update that
-- leaves no images (an erase) passes on to the snapshot-v1 arm, which returns.
select pg_temp.chat_images_replace('public.qorpera_require_member_session_attachment_uploads()'::regprocedure,
	'if jsonb_typeof(new.body -> ''images'') = ''array'' and jsonb_array_length(new.body -> ''images'') > 0 '
	|| 'and public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_shared_sessions where id = new.session_id)) then raise exception '
	|| '''Images in conversations do not serve folder-v2 companies yet'' using errcode = ''0A000''; end if;',
	'if jsonb_typeof(new.body -> ''images'') = ''array'' and jsonb_array_length(new.body -> ''images'') > 0 '
	|| E'and public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_shared_sessions where id = new.session_id)) then\n'
	|| E'\t\t-- 20260930260000: chat images on folder-v2.\n'
	|| E'\t\tif tg_op = ''UPDATE'' then\n'
	|| E'\t\t\tif (old.body -> ''images'', old.author_user_id, old.client_input_id, old.session_id)\n'
	|| E'\t\t\t\tis distinct from (new.body -> ''images'', new.author_user_id, new.client_input_id, new.session_id) then\n'
	|| E'\t\t\t\traise exception ''Submitted input attachments cannot change'' using errcode = ''42501''; end if;\n'
	|| E'\t\t\treturn new;\n'
	|| E'\t\tend if;\n'
	|| E'\t\tif new.kind <> ''user_message'' or new.body ->> ''schema'' is distinct from ''qorpera.session-prompt/v1'' then\n'
	|| E'\t\t\traise exception ''Attachment bytes must be uploaded for this exact member input'' using errcode = ''42501''; end if;\n'
	|| E'\t\tperform public.qorpera_room_images_check(new.session_id, new.client_input_id, new.author_user_id, new.body);\n'
	|| E'\t\treturn new;\n'
	|| E'\tend if;');

-- 6. The orphan sweep ---------------------------------------------------------------------------------------------------

-- A day after an input's last upload: with no input, its images folder is deleted; with one, the images it does not
-- list; then the row goes. A row with nothing to delete just goes, many in one call. A deletion is one memory commit as
-- the platform, naming the conversation's generation, and the first that saves ends the call: its locks, the company's
-- clock last, stay held to the end of the transaction, and nothing is locked after the clock. A commit that fails is
-- rolled back with every lock it took, and its row waits for a later call.
-- Each row takes its company KEY SHARE first (rank 0; skipped while a purge holds it, and a company being deleted is no
-- candidate), then the row FOR UPDATE (skipped while a begin or a commit holds it). An input posted while the sweep
-- deletes waits for the conversation's lock and is then refused, or is found after the commit and undoes it.
create function public.qorpera_room_image_orphan_sweep(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_candidate record; v_row public.qorpera_room_image_uploads%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_root text; v_dir text; v_folder public.qorpera_folder_entries%rowtype; v_units jsonb; v_result jsonb;
	v_claims text; v_claim_role text; v_saved boolean; v_done integer := 0;
begin
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'The chat image sweep runs at read committed' using errcode = '25000'; end if;
	for v_candidate in select u.session_id, u.client_input_id, s.profile_id
		from public.qorpera_room_image_uploads u join public.qorpera_shared_sessions s on s.id = u.session_id
		where u.updated_at < clock_timestamp() - interval '24 hours'
			and not exists (select 1 from public.qorpera_company_deletions d where d.profile_id = s.profile_id)
		order by u.updated_at limit greatest(coalesce(p_limit, 100), 0)
	loop
		perform 1 from public.qorpera_profiles where id = v_candidate.profile_id for key share skip locked;
		if not found then continue; end if;
		select * into v_row from public.qorpera_room_image_uploads
		where session_id = v_candidate.session_id and client_input_id = v_candidate.client_input_id
			and updated_at < clock_timestamp() - interval '24 hours'
		for update skip locked;
		if not found then continue; end if;
		v_units := '[]'::jsonb; v_saved := false;
		begin
			v_input := null; v_folder := null;
			select * into v_input from public.qorpera_session_inputs
			where session_id = v_row.session_id and client_input_id = v_row.client_input_id;
			v_root := public.qorpera_room_image_root(v_row.session_id);
			if v_root is not null then
				v_dir := v_root || '/images/' || v_row.client_input_id::text;
				select * into v_folder from public.qorpera_folder_entries
				where environment_id = v_row.environment_id and key_sha256 = extensions.digest(public.qorpera_folder_key(v_dir), 'sha256')
					and kind = 'folder';
			end if;
			if v_folder.path is not null and (v_input.id is null or jsonb_typeof(v_input.body -> 'images') is distinct from 'array'
				or jsonb_array_length(v_input.body -> 'images') = 0) then
				v_units := jsonb_build_array(jsonb_build_object('op', 'delete', 'path', v_folder.path, 'expectedVersion', v_folder.version,
					'asOfSeq', (select c.last_seq from public.qorpera_folder_clocks c where c.environment_id = v_row.environment_id)));
			elsif v_folder.path is not null then
				v_units := coalesce((select jsonb_agg(jsonb_build_object('op', 'delete', 'path', e.path, 'expectedVersion', e.version)
						order by e.path)
					from public.qorpera_folder_entries e
					where e.environment_id = v_row.environment_id
						and e.parent_key_sha256 = extensions.digest(public.qorpera_folder_key(v_dir), 'sha256')
						and e.kind <> 'claim' and not exists (select 1 from jsonb_array_elements(v_input.body -> 'images') i
							where public.qorpera_folder_key(public.qorpera_room_image_path(v_row.session_id, v_row.client_input_id, i.value))
								= e.key_text)),
					'[]'::jsonb);
			end if;
			if jsonb_array_length(v_units) > 0 then
				-- As the platform's own service caller, for this commit only.
				v_claims := current_setting('request.jwt.claims', true);
				v_claim_role := current_setting('request.jwt.claim.role', true);
				perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
				perform set_config('request.jwt.claim.role', 'service_role', true);
				v_result := public.qorpera_folder_memory_commit(v_row.environment_id, '{"kind":"platform"}'::jsonb,
					'chat-image-sweep:' || v_row.client_input_id::text || ':' || extensions.gen_random_uuid()::text, v_units,
					jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', v_row.session_id,
						'generation', (select memory_generation from public.qorpera_shared_sessions where id = v_row.session_id)))));
				perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
				perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
				if exists (select 1 from jsonb_array_elements(v_result -> 'units') u
					where u.value ->> 'outcome' <> 'saved' and u.value ->> 'reason' is distinct from 'missing') then
					raise exception 'Chat images of input % were not deleted: %', v_row.client_input_id, v_result -> 'units'
						using errcode = '55000'; end if;
				if v_input.id is null and exists (select 1 from public.qorpera_session_inputs
					where session_id = v_row.session_id and client_input_id = v_row.client_input_id) then
					raise exception 'Input % was posted while its images were swept', v_row.client_input_id using errcode = '55000'; end if;
			end if;
			delete from public.qorpera_room_image_uploads
			where session_id = v_row.session_id and client_input_id = v_row.client_input_id;
			v_done := v_done + 1;
			v_saved := jsonb_array_length(v_units) > 0;
		exception when others then
			raise warning 'Chat image sweep left input % of conversation % for later: %', v_row.client_input_id, v_row.session_id, sqlerrm;
		end;
		exit when v_saved;
	end loop;
	return v_done;
end $$;

-- Every minute through pg_cron, with its run log kept a day, as the folder erasure (20260928469190).
create function public.qorpera_schedule_room_image_sweep()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The chat image sweep was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.room-image-sweep-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-room-image-sweep', '* * * * *', 'select public.qorpera_room_image_orphan_sweep()');
		v_clean := cron.schedule('qorpera-room-image-sweep-log', '29 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-room-image-sweep')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The chat image sweep was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.room-image-sweep-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.room-image-sweep-schedule/v1', 'scheduled', true, 'jobs', jsonb_build_array(v_step, v_clean));
end $$;

-- 7. Privileges ----------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_room_image_room(uuid, uuid), public.qorpera_room_image_root(uuid),
	public.qorpera_room_image_path(uuid, uuid, jsonb), public.qorpera_room_image_entry(uuid, text, jsonb),
	public.qorpera_room_image_capacity_reached(uuid, text, bigint), public.qorpera_room_images_check(uuid, uuid, uuid, jsonb),
	public.qorpera_room_image_orphan_sweep(integer), public.qorpera_schedule_room_image_sweep()
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_room_image_begin(uuid, uuid, text, bigint, text),
	public.qorpera_room_image_download(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.qorpera_room_image_begin(uuid, uuid, text, bigint, text),
	public.qorpera_room_image_download(uuid, uuid, text) to authenticated;
revoke all on function public.qorpera_room_image_commit(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_room_image_commit(uuid, uuid, uuid, jsonb) to service_role;

select public.qorpera_schedule_room_image_sweep();

drop function pg_temp.chat_images_replace(regprocedure, text, text);
