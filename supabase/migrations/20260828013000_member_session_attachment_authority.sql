-- A hash is not proof that a member supplied an attachment. Governed-company
-- inputs bind an actual, cloud-verified upload to one human and client input.
-- Historical inputs were already shared under the preceding company policy.
alter table public.qorpera_company_files add column member_attachment_authority_from timestamptz;
update public.qorpera_company_files set member_attachment_authority_from = clock_timestamp()
where path_gateway_version = 1;

create function public.qorpera_pin_member_attachment_authority()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'UPDATE' and old.member_attachment_authority_from is not null then
		new.member_attachment_authority_from := old.member_attachment_authority_from;
	elsif new.path_gateway_version = 1 then
		new.member_attachment_authority_from := clock_timestamp();
	else new.member_attachment_authority_from := null; end if;
	return new;
end
$$;
create trigger qorpera_pin_member_attachment_authority before insert or update on public.qorpera_company_files
for each row execute function public.qorpera_pin_member_attachment_authority();

create table public.qorpera_member_session_attachment_uploads (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete restrict,
	client_input_id uuid not null,
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 1 and 8388608),
	media_type text not null check (media_type in ('image/png','image/jpeg','image/gif','image/webp')),
	expires_at timestamptz not null default clock_timestamp() + interval '10 minutes',
	verified_at timestamptz,
	accepted_input_id uuid references public.qorpera_session_inputs(id) on delete cascade deferrable initially deferred,
	unique (session_id,user_id,client_input_id,sha256),
	check (accepted_input_id is null or verified_at is not null)
);
alter table public.qorpera_member_session_attachment_uploads enable row level security;
revoke all on public.qorpera_member_session_attachment_uploads from public,anon,authenticated,service_role;
create index qorpera_member_session_attachment_pending on public.qorpera_member_session_attachment_uploads(profile_id,user_id,expires_at)
where accepted_input_id is null;
create index qorpera_member_session_attachment_input on public.qorpera_member_session_attachment_uploads(accepted_input_id,sha256);

create function public.qorpera_begin_member_session_attachment_upload(
	p_session_id uuid,p_client_input_id uuid,p_sha256 text,p_bytes bigint,p_media_type text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_upload public.qorpera_member_session_attachment_uploads%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Member attachment authority is required' using errcode = '42501'; end if;
	v_profile := public.qorpera_session_profile_for_write(p_session_id);
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	if not public.qorpera_company_uses_path_gateway(v_profile) or public.qorpera_profile_gc_deletion_active(v_profile)
		or not exists (select 1 from public.qorpera_shared_sessions where id = p_session_id and status = 'open') then
		raise exception 'Member attachment session is unavailable' using errcode = '42501'; end if;
	if p_client_input_id is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null or p_bytes not between 1 and 8388608 or p_media_type is null
		or p_media_type not in ('image/png','image/jpeg','image/gif','image/webp') then
		raise exception 'Member attachment is invalid' using errcode = '22023'; end if;
	-- The GC fence also serializes the small per-input upload budget.
	select * into v_upload from public.qorpera_member_session_attachment_uploads
	where session_id = p_session_id and user_id = auth.uid() and client_input_id = p_client_input_id and sha256 = p_sha256 for update;
	if found then
		if v_upload.bytes <> p_bytes or v_upload.media_type <> p_media_type then
			raise exception 'Attachment identity is bound to different bytes' using errcode = '23505'; end if;
		if v_upload.accepted_input_id is null then
			update public.qorpera_member_session_attachment_uploads set verified_at = null,
				expires_at = clock_timestamp() + interval '10 minutes' where id = v_upload.id returning * into v_upload;
		end if;
	else
		if (select count(*) from public.qorpera_member_session_attachment_uploads where session_id = p_session_id
			and user_id = auth.uid() and client_input_id = p_client_input_id) >= 5
			or (select coalesce(sum(bytes),0) from public.qorpera_member_session_attachment_uploads where session_id = p_session_id
			and user_id = auth.uid() and client_input_id = p_client_input_id) + p_bytes > 8388608
			or (select count(*) from public.qorpera_member_session_attachment_uploads where profile_id = v_profile
			and user_id = auth.uid() and accepted_input_id is null and expires_at > clock_timestamp()) >= 100 then
			raise exception 'Member attachment capacity is reached' using errcode = '54000'; end if;
		if exists (select 1 from public.qorpera_session_inputs where session_id = p_session_id and client_input_id = p_client_input_id) then
			raise exception 'Submitted input attachments cannot change' using errcode = '42501'; end if;
		insert into public.qorpera_member_session_attachment_uploads(profile_id,session_id,user_id,client_input_id,sha256,bytes,media_type)
		values (v_profile,p_session_id,auth.uid(),p_client_input_id,p_sha256,p_bytes,p_media_type) returning * into v_upload;
	end if;
	return jsonb_build_object('uploadId',v_upload.id,'companyId',v_profile,'sessionId',p_session_id,
		'clientInputId',p_client_input_id,'sha256',p_sha256,'bytes',p_bytes,'mediaType',p_media_type);
end
$$;

create function public.qorpera_stage_member_session_attachment(p_upload_id uuid,p_confirm boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_upload public.qorpera_member_session_attachment_uploads%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_confirm is null then
		raise exception 'Cloud attachment verifier is required' using errcode = '42501'; end if;
	select * into v_upload from public.qorpera_member_session_attachment_uploads where id = p_upload_id;
	if not found then raise exception 'Attachment upload is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_upload.profile_id);
	select * into strict v_upload from public.qorpera_member_session_attachment_uploads where id = p_upload_id for update;
	perform 1 from public.qorpera_profile_members where profile_id = v_upload.profile_id and user_id = v_upload.user_id
		and role in ('owner','admin','contributor') for share;
	if not found or not public.qorpera_company_uses_path_gateway(v_upload.profile_id)
		or public.qorpera_profile_gc_deletion_active(v_upload.profile_id)
		or (v_upload.accepted_input_id is null and v_upload.expires_at <= clock_timestamp()) then
		raise exception 'Attachment upload authority expired or changed' using errcode = '42501'; end if;
	if p_confirm then
		perform public.qorpera_confirm_profile_object_upload(v_upload.profile_id,v_upload.sha256,v_upload.bytes,'nas-object-gateway');
		update public.qorpera_member_session_attachment_uploads set verified_at = coalesce(verified_at,clock_timestamp()) where id = p_upload_id;
	end if;
	return v_upload.profile_id;
end
$$;

create function public.qorpera_require_member_session_attachment_uploads()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_image jsonb;
	v_upload public.qorpera_member_session_attachment_uploads%rowtype;
begin
	select file.* into v_file from public.qorpera_company_files file
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
	return new;
end
$$;
create trigger qorpera_require_member_session_attachment_uploads after insert or update of body,author_user_id,client_input_id,session_id
on public.qorpera_session_inputs for each row execute function public.qorpera_require_member_session_attachment_uploads();

create function public.qorpera_authorize_member_session_attachment(p_session_id uuid,p_input_id uuid,p_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_file public.qorpera_company_files%rowtype; v_image jsonb; v_object public.qorpera_profile_objects%rowtype;
begin
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id;
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_session.id is null
		or not public.qorpera_can_read_profile(v_session.profile_id) then
		raise exception 'Chat attachment access is unavailable' using errcode = '42501'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = v_session.environment_id;
	select * into v_input from public.qorpera_session_inputs where id = p_input_id and session_id = p_session_id;
	if v_file.path_gateway_version is distinct from 1 or v_input.kind is distinct from 'user_message'
		or v_input.body ->> 'schema' is distinct from 'qorpera.session-prompt/v1'
		or not exists (select 1 from public.qorpera_session_events where session_id = p_session_id
			and event_id = p_input_id and session_input_id = p_input_id and actor_user_id = v_input.author_user_id) then
		raise exception 'Canonical chat input is unavailable' using errcode = '42501'; end if;
	select value into v_image from jsonb_array_elements(v_input.body -> 'images') where value ->> 'objectSha256' = p_sha256 limit 1;
	if v_image is null or (v_input.created_at >= v_file.member_attachment_authority_from and not exists (
		select 1 from public.qorpera_member_session_attachment_uploads where accepted_input_id = p_input_id
			and session_id = p_session_id and user_id = v_input.author_user_id and client_input_id = v_input.client_input_id
			and sha256 = p_sha256 and bytes = (v_image ->> 'bytes')::bigint and media_type = v_image ->> 'mediaType'
			and verified_at is not null)) then
		raise exception 'Attachment does not belong to this canonical input' using errcode = '42501'; end if;
	select * into v_object from public.qorpera_profile_objects where profile_id = v_session.profile_id and sha256 = p_sha256;
	if not found or v_object.bytes <> (v_image ->> 'bytes')::bigint then
		raise exception 'Attachment object is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('companyId',v_session.profile_id,'sessionId',p_session_id,'inputId',p_input_id,
		'sha256',p_sha256,'bytes',v_object.bytes,'mediaType',v_image ->> 'mediaType');
end
$$;

alter function public.qorpera_company_additional_retained_object_hashes(uuid)
rename to qorpera_company_retained_objects_before_member_attachments;
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table(object_sha256 text) language sql stable security definer set search_path = '' as $$
	select object_sha256 from public.qorpera_company_retained_objects_before_member_attachments(p_profile_id)
	union
	select sha256 from public.qorpera_member_session_attachment_uploads
	where profile_id = p_profile_id and (accepted_input_id is not null or expires_at > clock_timestamp())
$$;

revoke all on function public.qorpera_pin_member_attachment_authority() from public,anon,authenticated,service_role;
revoke all on function public.qorpera_require_member_session_attachment_uploads() from public,anon,authenticated,service_role;
revoke all on function public.qorpera_begin_member_session_attachment_upload(uuid,uuid,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_stage_member_session_attachment(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_authorize_member_session_attachment(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_company_retained_objects_before_member_attachments(uuid) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_company_additional_retained_object_hashes(uuid) from public,anon,authenticated,service_role;
-- The stable retention entry point may still be owned by the role that
-- created it in production, while this final private callee is recreated by
-- the migration role. Grant only that discovered SECURITY DEFINER owner.
do $$
declare v_retained_owner name;
begin
	select pg_catalog.pg_get_userbyid(procedure.proowner) into strict v_retained_owner
	from pg_catalog.pg_proc procedure
	where procedure.oid = 'public.qorpera_company_retained_object_hashes(uuid)'::regprocedure;
	execute format(
		'grant execute on function public.qorpera_company_additional_retained_object_hashes(uuid) to %I',
		v_retained_owner
	);
end
$$;
grant execute on function public.qorpera_begin_member_session_attachment_upload(uuid,uuid,text,bigint,text) to authenticated;
grant execute on function public.qorpera_authorize_member_session_attachment(uuid,uuid,text) to authenticated;
grant execute on function public.qorpera_stage_member_session_attachment(uuid,boolean) to service_role;
