-- Explicit, bounded read delegation. The gateway policy is disabled by default.
-- This response is installed only by the trusted gateway after its own RPC;
-- it is not a caller-presented bearer credential or an offline identity issuer.
do $$
begin
	if not exists (
		select 1 from pg_catalog.pg_attribute
		where attrelid = 'storage.objects'::regclass and attname = 'user_metadata'
			and atttypid = 'jsonb'::regtype and not attisdropped
	) then
		raise exception 'Storage user_metadata support is required for the replica fence' using errcode = '55000';
	end if;
end
$$;

create function public.qorpera_issue_profile_object_read_lease(
	p_profile_id uuid, p_sha256 text, p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_object jsonb;
	v_session_id text := auth.jwt() ->> 'session_id';
	v_exp text := auth.jwt() ->> 'exp';
	v_now timestamptz := statement_timestamp();
	v_expires timestamptz;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or p_profile_id is null or p_sha256 is null
		or p_lease_seconds is null or p_lease_seconds not between 1 and 60
		or v_session_id is null or v_session_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
		or v_exp is null or v_exp !~ '^[0-9]{1,11}$' then
		raise exception 'read delegation authority is invalid' using errcode = '42501';
	end if;
	v_expires := least(to_timestamp(v_exp::double precision), v_now + make_interval(secs => p_lease_seconds));
	if v_expires <= v_now then
		raise exception 'read delegation session has expired' using errcode = '42501';
	end if;
	v_object := public.qorpera_authorize_profile_object_download(p_profile_id, p_sha256);
	return v_object || jsonb_build_object('read_lease', jsonb_build_object(
		'leaseId', extensions.gen_random_uuid(), 'profileId', p_profile_id,
		'sha256', p_sha256, 'subjectId', auth.uid(), 'sessionId', v_session_id,
		'issuedAt', v_now, 'expiresAt', v_expires
	));
end
$$;

-- All background copying is subordinate to the existing catalog and GC fence.
-- Unlike initial upload confirmation, neither function can resurrect a row.
create function public.qorpera_authorize_profile_object_replication(
	p_profile_id uuid, p_sha256 text, p_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() is distinct from 'service_role'
		or p_profile_id is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null or p_bytes not between 0 and 8388608 then
		raise exception 'replication authority is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'replication is fenced by cleanup' using errcode = '40001';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	if not found then raise exception 'replication company is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_objects
	where profile_id = p_profile_id and sha256 = p_sha256 and bytes = p_bytes for key share;
	if not found then raise exception 'replication object is unavailable' using errcode = '42501'; end if;
	return true;
end
$$;

create function public.qorpera_confirm_profile_object_replica(
	p_profile_id uuid, p_sha256 text, p_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform public.qorpera_authorize_profile_object_replication(p_profile_id, p_sha256, p_bytes);
	update public.qorpera_profile_objects set backend = 'nas-object-gateway'
	where profile_id = p_profile_id and sha256 = p_sha256 and bytes = p_bytes;
	if not found then raise exception 'replication object is unavailable' using errcode = '42501'; end if;
	return true;
end
$$;

-- Enforce the fence at the actual Storage metadata transaction, including a
-- late POST whose caller timed out. Ordinary member/runner uploads are not
-- relabelled as replicas. user_metadata is owned by Supabase Storage.
create function public.qorpera_guard_nas_replica_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_identity record;
	v_replica_bytes text := new.user_metadata ->> 'qorpera_nas_replica_bytes';
	v_storage_bytes text := coalesce(new.metadata ->> 'size', new.metadata ->> 'contentLength');
begin
	if new.user_metadata -> 'qorpera_nas_replica' is distinct from 'true'::jsonb then
		return new;
	end if;
	if v_replica_bytes is null or v_replica_bytes !~ '^[0-9]{1,9}$'
		or v_replica_bytes::bigint > 8388608
		or new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}$' then
		raise exception 'replica identity is invalid' using errcode = '42501';
	end if;
	-- Storage's permission preflight can have contentLength rather than size,
	-- or no physical metadata yet. It still carries our exact byte commitment.
	-- The final transaction's physical size must match that commitment.
	if v_storage_bytes is not null and (v_storage_bytes !~ '^[0-9]{1,9}$' or v_storage_bytes::bigint <> v_replica_bytes::bigint) then
		raise exception 'replica size changed' using errcode = '42501';
	end if;
	select * into v_identity from public.qorpera_profile_object_identity(
		new.bucket_id, new.name, jsonb_build_object('size', v_replica_bytes)
	);
	perform public.qorpera_authorize_profile_object_replication(v_identity.profile_id, v_identity.sha256, v_identity.bytes);
	return new;
end
$$;

create trigger qorpera_guard_nas_replica_insert
before insert or update on storage.objects
for each row execute function public.qorpera_guard_nas_replica_insert();

revoke all on function public.qorpera_issue_profile_object_read_lease(uuid, text, integer) from public, anon, service_role;
grant execute on function public.qorpera_issue_profile_object_read_lease(uuid, text, integer) to authenticated;
revoke all on function public.qorpera_authorize_profile_object_replication(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.qorpera_confirm_profile_object_replica(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.qorpera_guard_nas_replica_insert() from public, anon, authenticated, service_role;
grant execute on function public.qorpera_authorize_profile_object_replication(uuid, text, bigint) to service_role;
grant execute on function public.qorpera_confirm_profile_object_replica(uuid, text, bigint) to service_role;
