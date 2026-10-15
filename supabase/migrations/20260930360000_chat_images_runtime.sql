-- Chat images on folder-v2, the runtime part (20260930260000 made each image a folder file under the conversation's
-- summary-tree root, <root>/images/<client input id>/<sha256>.<ext>): an agent finds a member's image by its path and
-- opens it with company_read.
--
-- 1. qorpera_room_input_image_paths: an input's images as their folder paths, in the input's order.
-- 2. qorpera_company_context_source: a member's message, current or earlier, lists its images' paths as `images` where
--    it had only `attachmentCount`; any other source lists none. The run's context, its pages and the parent inputs a
--    worker's wake carries all take it from here.
-- 3. qorpera_memory_event: a member's image in the zoom names its `path` beside its media type and bytes.
-- Every patched body carries the marker 20260930360000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; chat images come first.
do $$ begin
	if to_regprocedure('public.qorpera_room_input_image_paths(uuid,uuid,jsonb)') is not null then
		raise exception 'Chat images runtime (20260930360000) is already applied'; end if;
	if to_regprocedure('public.qorpera_room_image_path(uuid,uuid,jsonb)') is null then
		raise exception 'Chat images runtime (20260930360000) needs chat images (20260930260000)'; end if;
end $$;

-- Every edit of one function at once: its body compiles only with all of them (v_attachments becomes v_images).
create function pg_temp.chat_images_runtime_replace(p_function regprocedure, p_old text[], p_new text[])
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if cardinality(p_old) is distinct from cardinality(p_new) then raise exception 'Chat images runtime edits differ'; end if;
	for i in 1 .. cardinality(p_old) loop
		if p_old[i] = '' or (length(v_definition) - length(replace(v_definition, p_old[i], ''))) / length(p_old[i]) <> 1 then
			raise exception 'Chat images runtime anchor differs in %: %', p_function, left(p_old[i], 80); end if;
		v_definition := replace(v_definition, p_old[i], p_new[i]);
	end loop;
	execute v_definition;
end $$;

-- 1. An input's image paths ------------------------------------------------------------------------------------------

-- The folder paths of an input's images (its body's `images`), in order; an image with no path (its conversation has no
-- tree root, or it is malformed) is left out. [] for an input with none.
create function public.qorpera_room_input_image_paths(p_session_id uuid, p_client_input_id uuid, p_body jsonb)
returns jsonb language sql stable set search_path = '' as $$
	select coalesce(jsonb_agg(p.path order by i.n) filter (where p.path is not null), '[]'::jsonb)
	from jsonb_array_elements(case when jsonb_typeof(p_body -> 'images') = 'array' then p_body -> 'images' else '[]'::jsonb end)
		with ordinality as i(value, n)
	cross join lateral (select public.qorpera_room_image_path(p_session_id, p_client_input_id, i.value) as path) p
$$;
revoke all on function public.qorpera_room_input_image_paths(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- 2. The run's context ------------------------------------------------------------------------------------------------

select pg_temp.chat_images_runtime_replace('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)',
	array[
		E'\tv_attachments integer := 0;\n',
		E'\t\tif jsonb_typeof(v_input.body -> ''images'') = ''array'' then v_attachments := jsonb_array_length(v_input.body -> ''images''); end if;\n',
		E'\t\tif found then v_kind := ''historical_human_message''; v_actor_kind := ''human''; v_author := v_input.author_user_id;\n',
		$old$'attachmentCount',v_attachments,$old$],
	array[
		E'\tv_images jsonb := ''[]''; -- 20260930360000: a member''s images by path, where attachmentCount was.\n',
		E'\t\tv_images := public.qorpera_room_input_image_paths(v_input.session_id, v_input.client_input_id, v_input.body);\n',
		E'\t\tif found then v_kind := ''historical_human_message''; v_actor_kind := ''human''; v_author := v_input.author_user_id;\n'
		|| E'\t\t\t-- 20260930360000: an earlier message names its images by path too, unless it was erased.\n'
		|| E'\t\t\tif v_event.body is distinct from ''{"erased":true}''::jsonb then\n'
		|| E'\t\t\t\tv_images := public.qorpera_room_input_image_paths(v_input.session_id, v_input.client_input_id, v_input.body); end if;\n',
		$new$/* 20260930360000 */ 'images',v_images,$new$]);

-- 3. The zoom ---------------------------------------------------------------------------------------------------------

select pg_temp.chat_images_runtime_replace('public.qorpera_memory_event(uuid,public.qorpera_session_events,bigint)',
	array[
		E'\t\tv_attachments := (select jsonb_agg(jsonb_build_object(''mediaType'', a.value -> ''mediaType'', ''bytes'', a.value -> ''bytes'') order by a.n)\n'
		|| E'\t\t\tfrom jsonb_array_elements(case when jsonb_typeof(v_entry -> ''qorperaAttachments'') = ''array''\n'
		|| E'\t\t\t\tthen v_entry -> ''qorperaAttachments'' else ''[]''::jsonb end) with ordinality as a(value, n));\n'],
	array[
		E'\t\t-- 20260930360000: a member''s image names its folder path, where company_read opens it.\n'
		|| E'\t\tv_attachments := (select jsonb_agg(jsonb_build_object(''mediaType'', a.value -> ''mediaType'', ''bytes'', a.value -> ''bytes'')\n'
		|| E'\t\t\t\t|| case when p.path is null then ''{}''::jsonb else jsonb_build_object(''path'', p.path) end order by a.n)\n'
		|| E'\t\t\tfrom jsonb_array_elements(case when jsonb_typeof(v_entry -> ''qorperaAttachments'') = ''array''\n'
		|| E'\t\t\t\tthen v_entry -> ''qorperaAttachments'' else ''[]''::jsonb end) with ordinality as a(value, n)\n'
		|| E'\t\t\tcross join lateral (select public.qorpera_room_image_path(p_event.session_id, v_input.client_input_id, a.value) as path) p);\n']);
