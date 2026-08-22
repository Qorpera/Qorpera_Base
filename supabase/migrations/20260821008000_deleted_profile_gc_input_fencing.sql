-- Service-only cleanup calls must fail closed on null or malformed lease
-- inputs. In particular, a null object list must never complete a lease and
-- cascade its pending entries while physical catalog rows remain.

create or replace function public.qorpera_renew_deleted_profile_object_gc(
	p_profile_id uuid,
	p_lease_id uuid,
	p_object_sha256s text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role'
		or p_profile_id is null
		or p_lease_id is null
		or p_object_sha256s is null
		or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		)
		or exists (
			select 1 from unnest(p_object_sha256s) as sha256
			where sha256 !~ '^[0-9a-f]{64}$'
		) then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	select count(*) into v_expected
	from public.qorpera_deleted_profile_object_gc_entries as entry
	where entry.profile_id = p_profile_id
		and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s);
	if v_expected <> cardinality(p_object_sha256s) then
		raise exception 'deleted profile object cleanup lease is stale' using errcode = '40001';
	end if;
	update public.qorpera_deleted_profile_object_gc_leases
	set lease_expires_at = statement_timestamp() + interval '10 minutes'
	where profile_id = p_profile_id
		and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise exception 'deleted profile object cleanup lease is unavailable' using errcode = '40001';
	end if;
end
$$;

create or replace function public.qorpera_complete_deleted_profile_object_gc(
	p_profile_id uuid,
	p_lease_id uuid,
	p_object_sha256s text[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_expected integer;
begin
	if auth.role() <> 'service_role'
		or p_profile_id is null
		or p_lease_id is null
		or p_object_sha256s is null
		or cardinality(p_object_sha256s) not between 1 and 100
		or cardinality(p_object_sha256s) <> (
			select count(distinct sha256) from unnest(p_object_sha256s) as sha256
		)
		or exists (
			select 1 from unnest(p_object_sha256s) as sha256
			where sha256 !~ '^[0-9a-f]{64}$'
		) then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	select count(*) into v_expected
	from public.qorpera_deleted_profile_object_gc_entries as entry
	where entry.profile_id = p_profile_id
		and entry.lease_id = p_lease_id
		and entry.object_sha256 = any(p_object_sha256s);
	if v_expected <> cardinality(p_object_sha256s) or exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = any(p_object_sha256s)
	) then
		raise exception 'deleted profile object cleanup was not confirmed by storage' using errcode = '55000';
	end if;
	delete from public.qorpera_deleted_profile_object_gc_leases
	where profile_id = p_profile_id
		and lease_id = p_lease_id
		and lease_expires_at > statement_timestamp();
	if not found then
		raise exception 'deleted profile object cleanup lease is unavailable' using errcode = '40001';
	end if;
	return v_expected;
end
$$;

create or replace function public.qorpera_release_deleted_profile_object_gc(p_profile_id uuid, p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' or p_profile_id is null or p_lease_id is null then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_deleted_profile_object_gc_leases
	where profile_id = p_profile_id and lease_id = p_lease_id;
end
$$;

revoke all on function public.qorpera_renew_deleted_profile_object_gc(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.qorpera_complete_deleted_profile_object_gc(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.qorpera_release_deleted_profile_object_gc(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_renew_deleted_profile_object_gc(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_complete_deleted_profile_object_gc(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_release_deleted_profile_object_gc(uuid, uuid) to service_role;
