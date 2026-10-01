-- Company folder core: the soft storage quota before the NAS write (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §3,
-- §5, "Follow-ups from C1d-1b's review").
--
-- The object gateway authorizes each put before it writes the NAS file, then confirms after it. The quota was checked
-- only at confirm, after the write, so a company at its limit left the refused object on the NAS outside the catalog,
-- where C1d-2's catalog-driven GC never finds it. Now the authorization checks it for an object the catalog lacks,
-- before the write, and the confirm no longer refuses for it: a put that was let in is kept. The quota stays soft, as
-- before: uploads in flight at once can pass the limit by what they carry. Folder-v2 only; no real folder-v2 company
-- exists before C1c-3, which needs this first.

-- The scheduler and wake admission never queue behind this migration's locks.
set local lock_timeout = '3s';

-- The definitions this was reviewed against (20260928279520).
do $guard$
declare v_check record;
begin
	for v_check in select * from (values
		('public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)',
			'0131324fd2384d11bfdf9248d27a3237989e1060e871d94f36a81db9ab34dbf2'),
		('public.qorpera_folder_confirm_object(uuid,jsonb,uuid,text,bigint)',
			'295dab1f6c563145143b0db51351ad4b38ac2c9e51473ffd1c79d6e7cbbb076b')) c(target, digest)
	loop
		if encode(extensions.digest(pg_get_functiondef(v_check.target::regprocedure), 'sha256'), 'hex') <> v_check.digest then
			raise exception 'Reviewed function definition changed: %', v_check.target;
		end if;
	end loop;
end
$guard$;

-- A chunk's put, from the gateway, before it writes the NAS file (C1D §3.2): the intent and its object row, as before,
-- and the soft quota for an object the catalog lacks (23514), so a company at its limit is refused before any byte is
-- written. Plain reads; the gateway calls it again inside its journal lane, still before the write.
create or replace function public.qorpera_folder_authorize_object_upload(p_environment_id uuid, p_actor jsonb, p_intent uuid,
	p_sha256 text, p_bytes bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_intent public.qorpera_folder_upload_intents%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_intent := public.qorpera_folder_put_intent(p_environment_id, p_actor, p_intent);
	if not exists (select 1 from public.qorpera_folder_upload_intent_objects
		where intent_id = p_intent and sha256 = p_sha256 and bytes = p_bytes) then
		raise exception 'Object is not part of this upload' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_profile_objects where profile_id = v_intent.profile_id and sha256 = p_sha256) then
		perform public.qorpera_folder_storage_quota_check(v_intent.profile_id, p_bytes);
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-object-upload/v1', 'profileId', v_intent.profile_id);
end $$;

-- After the gateway's NAS put (C1D §3.3): the intent and its object row again, then the row is marked put and the
-- catalog row inserted. No quota check here: the authorization before the write let this object in, and refusing it
-- now would strand its bytes on the NAS.
create or replace function public.qorpera_folder_confirm_object(p_environment_id uuid, p_actor jsonb, p_intent uuid, p_sha256 text,
	p_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_intent public.qorpera_folder_upload_intents%rowtype; v_bytes bigint; v_stored boolean;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_intent := public.qorpera_folder_put_intent(p_environment_id, p_actor, p_intent);
	if not exists (select 1 from public.qorpera_folder_upload_intent_objects
		where intent_id = p_intent and sha256 = p_sha256 and bytes = p_bytes) then
		raise exception 'Object is not part of this upload' using errcode = '42501'; end if;
	update public.qorpera_folder_upload_intent_objects set put = true
	where intent_id = p_intent and sha256 = p_sha256 and bytes = p_bytes and not put;
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend)
	values (v_intent.profile_id, p_sha256, p_bytes, 'nas-object-gateway')
	on conflict (profile_id, sha256) do nothing;
	v_stored := found;
	select bytes into v_bytes from public.qorpera_profile_objects where profile_id = v_intent.profile_id and sha256 = p_sha256
	for key share;
	if v_bytes is distinct from p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-object/v1', 'sha256', p_sha256, 'bytes', p_bytes, 'stored', v_stored);
end $$;
