-- 20260930416000: the legacy sweep, step D17 (the snapshot-v1 chat image upload). A member's image in a conversation
-- was an object that the member began (qorpera_begin_member_session_attachment_upload), the object gateway staged
-- (qorpera_stage_member_session_attachment) and the input trigger bound to that member's input; a reader of the
-- conversation then fetched it (qorpera_authorize_member_session_attachment). All of it serves a company on the
-- version-1 Company File only (folder-v2 only, the founder's decision of 3 October): the begin and the stage refuse
-- folder-v2 (20260928289620), and the fetch needs a version-1 Company File, which the qorpera_company_files check forbids
-- on folder-v2. On folder-v2 a chat image is a folder file (20260930260000), and the object gateway's routes call the
-- room image functions; nothing calls the three.
-- 1. The input trigger keeps its folder-v2 arm (20260930260000) as it is, and its name and place, and loses the
--    snapshot-v1 arm after it, which returned at once on any company off the version-1 Company File.
-- 2. The retained object set stops reading the uploads (the layer 20260828013000 added): the deleted company's bytes do
--    not wait for them, and there are none on folder-v2.
-- 3. Dropped: the begin, the stage and the fetch; the pin of the time from which a version-1 Company File asked for an
--    upload (its trigger on qorpera_company_files, its function and its column, which only the fetch read).
-- 4. The table qorpera_member_session_attachment_uploads, which must be empty.
-- Every patched body names this migration (20260930416000), and every earlier marker in it stays.
set local lock_timeout = '3s';

create function pg_temp.d17_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep D17 anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The input trigger. ----------------------------------------------------------------------------------------------

-- The snapshot-v1 arm first: the function is recreated after each patch, and the arm names the declarations.
select pg_temp.d17_patch('public.qorpera_require_member_session_attachment_uploads()'::regprocedure,
$old$	select file.* into v_file from public.qorpera_company_files file
	join public.qorpera_shared_sessions session on session.environment_id = file.environment_id where session.id = new.session_id;
	if v_file.path_gateway_version is distinct from 1 then return new; end if;
	if tg_op = 'UPDATE' then
		if (old.body,old.author_user_id,old.client_input_id,old.session_id) is distinct from
			(new.body,new.author_user_id,new.client_input_id,new.session_id) then
			raise exception 'Canonical input identity cannot change' using errcode = '42501'; end if;
		return new;
	end if;
	if new.kind <> 'user_message' or new.body ->> 'schema' <> 'qorpera.session-prompt/v1' then return new; end if;
	for v_image in select value from jsonb_array_elements(new.body -> 'images') loop
		select * into v_upload from public.qorpera_member_session_attachment_uploads where session_id = new.session_id
			and user_id = new.author_user_id and client_input_id = new.client_input_id
			and sha256 = v_image ->> 'objectSha256' and bytes = (v_image ->> 'bytes')::bigint
			and media_type = v_image ->> 'mediaType' for update;
		if not found or v_upload.verified_at is null or v_upload.expires_at <= clock_timestamp()
			or (v_upload.accepted_input_id is not null and v_upload.accepted_input_id <> new.id) then
			raise exception 'Attachment bytes must be uploaded for this exact member input' using errcode = '42501'; end if;
		update public.qorpera_member_session_attachment_uploads set accepted_input_id = new.id where id = v_upload.id;
	end loop;
$old$,
$new$	-- 20260930416000 (legacy sweep D17): the snapshot-v1 upload check went with its uploads.
$new$);

select pg_temp.d17_patch('public.qorpera_require_member_session_attachment_uploads()'::regprocedure,
$old$
declare v_file public.qorpera_company_files%rowtype; v_image jsonb;
	v_upload public.qorpera_member_session_attachment_uploads%rowtype;
begin
$old$,
$new$
begin
$new$);

-- 2. The retained object set. ----------------------------------------------------------------------------------------

select pg_temp.d17_patch('public.qorpera_company_pre_observation_retained_object_hashes(uuid)'::regprocedure,
$old$
	union
	select sha256 from public.qorpera_member_session_attachment_uploads
	where profile_id = p_profile_id and (accepted_input_id is not null or expires_at > clock_timestamp())
$old$,
$new$
	-- 20260930416000 (legacy sweep D17): no snapshot-v1 chat image upload is retained; they went with their table.
$new$);

-- 3. The upload's functions and the authority pin. -------------------------------------------------------------------

drop function public.qorpera_begin_member_session_attachment_upload(uuid,uuid,text,bigint,text);
drop function public.qorpera_stage_member_session_attachment(uuid,boolean);
drop function public.qorpera_authorize_member_session_attachment(uuid,uuid,text);

drop trigger qorpera_pin_member_attachment_authority on public.qorpera_company_files;
drop function public.qorpera_pin_member_attachment_authority();
alter table public.qorpera_company_files drop column member_attachment_authority_from;

-- 4. Last, because dropping the table locks the tables its foreign keys name (the company, the conversation, its
-- inputs and auth.users) until the migration commits. It goes only while empty; the lock keeps an upload from arriving
-- between the check and the drop. All in one statement, as 20260930330000 does: a bare LOCK TABLE fails where each
-- statement commits. Its two indexes go with it.
do $$
begin
	lock table public.qorpera_member_session_attachment_uploads in access exclusive mode;
	if exists (select 1 from public.qorpera_member_session_attachment_uploads) then
		raise exception 'Legacy sweep D17 drops the snapshot-v1 chat image uploads only while there are none'
			using errcode = '55000'; end if;
	drop table public.qorpera_member_session_attachment_uploads;
end $$;

-- Nothing that runs may still name them.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_member_session_attachment_uploads\M'
				|| '|qorpera_(begin_member_session_attachment_upload|stage_member_session_attachment)\M'
				|| '|qorpera_authorize_member_session_attachment\M|qorpera_pin_member_attachment_authority\M'
				|| '|member_attachment_authority_from\M')
	loop
		raise exception 'Function % still names the snapshot-v1 chat image upload', v_name;
	end loop;
end $$;
