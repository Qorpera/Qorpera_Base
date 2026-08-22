-- Profile deletion removes every live authority row except immutable object
-- bytes. Keep those orphaned catalog rows as the durable cleanup queue and
-- lease their physical deletion through the same trusted gateway boundary.

create table public.qorpera_deleted_profile_object_gc_leases (
	profile_id uuid primary key,
	lease_id uuid not null unique,
	lease_expires_at timestamptz not null,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, lease_id)
);

create table public.qorpera_deleted_profile_object_gc_entries (
	profile_id uuid not null,
	lease_id uuid not null,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes >= 0),
	backend text not null check (backend in ('supabase-storage', 'nas-object-gateway')),
	primary key (profile_id, object_sha256),
	foreign key (profile_id, lease_id)
		references public.qorpera_deleted_profile_object_gc_leases(profile_id, lease_id)
		on delete cascade
);

alter table public.qorpera_deleted_profile_object_gc_leases enable row level security;
alter table public.qorpera_deleted_profile_object_gc_entries enable row level security;
revoke all on public.qorpera_deleted_profile_object_gc_leases from anon, authenticated;
revoke all on public.qorpera_deleted_profile_object_gc_entries from anon, authenticated;

create function public.qorpera_claim_deleted_profile_object_gc(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_objects jsonb;
begin
	if auth.role() <> 'service_role' or p_lease_id is null or p_limit not between 1 and 100 then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_deleted_profile_object_gc_leases
	where lease_expires_at <= statement_timestamp();

	for v_profile_id in
		select object.profile_id
		from public.qorpera_profile_objects as object
		where not exists (
			select 1 from public.qorpera_profiles as profile where profile.id = object.profile_id
		)
			and not exists (
				select 1 from public.qorpera_deleted_profile_object_gc_leases as lease
				where lease.profile_id = object.profile_id
			)
		group by object.profile_id
		order by min(object.created_at), object.profile_id
	loop
		insert into public.qorpera_deleted_profile_object_gc_leases (profile_id, lease_id, lease_expires_at)
		values (v_profile_id, p_lease_id, statement_timestamp() + interval '10 minutes')
		on conflict (profile_id) do nothing;
		if not found then
			continue;
		end if;
		insert into public.qorpera_deleted_profile_object_gc_entries (
			profile_id,
			lease_id,
			object_sha256,
			bytes,
			backend
		)
		select object.profile_id, p_lease_id, object.sha256, object.bytes, object.backend
		from public.qorpera_profile_objects as object
		where object.profile_id = v_profile_id
		order by object.created_at, object.sha256
		limit p_limit;
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', entry.profile_id::text || '/' || entry.object_sha256,
			'backend', entry.backend
		) order by entry.object_sha256) into v_objects
		from public.qorpera_deleted_profile_object_gc_entries as entry
		where entry.profile_id = v_profile_id and entry.lease_id = p_lease_id;
		if v_objects is null then
			delete from public.qorpera_deleted_profile_object_gc_leases
			where profile_id = v_profile_id and lease_id = p_lease_id;
			continue;
		end if;
		return jsonb_build_object(
			'profile_id', v_profile_id,
			'lease_id', p_lease_id,
			'objects', v_objects
		);
	end loop;
	return null;
end
$$;

create function public.qorpera_renew_deleted_profile_object_gc(
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

create function public.qorpera_complete_deleted_profile_object_gc(
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
	if auth.role() <> 'service_role' or cardinality(p_object_sha256s) not between 1 and 100 then
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

create function public.qorpera_release_deleted_profile_object_gc(p_profile_id uuid, p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_deleted_profile_object_gc_leases
	where profile_id = p_profile_id and lease_id = p_lease_id;
end
$$;

create or replace function public.qorpera_confirm_profile_object_deletion(
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint,
	p_backend text,
	p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_deleted boolean;
begin
	if auth.role() <> 'service_role'
		or p_backend <> 'nas-object-gateway'
		or p_lease_id is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608 then
		raise exception 'object deletion confirmation is invalid' using errcode = '42501';
	end if;
	if not exists (
		select 1
		from public.qorpera_artifact_gc_plans as plan
		join public.qorpera_artifact_gc_plan_entries as entry on entry.plan_id = plan.id
		where plan.profile_id = p_profile_id
			and plan.status = 'deleting'
			and plan.lease_id = p_lease_id
			and plan.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.status = 'pending'
	) and not exists (
		select 1
		from public.qorpera_company_object_gc_leases as lease
		join public.qorpera_company_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
	) and not exists (
		select 1
		from public.qorpera_deleted_profile_object_gc_leases as lease
		join public.qorpera_deleted_profile_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.backend = p_backend
	) then
		raise exception 'object deletion lease is unavailable' using errcode = '40001';
	end if;
	delete from public.qorpera_profile_objects
	where profile_id = p_profile_id
		and sha256 = p_sha256
		and bytes = p_bytes
		and backend = p_backend;
	v_deleted := found;
	if not v_deleted and exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = p_sha256
	) then
		raise exception 'object deletion does not match the catalog' using errcode = '55000';
	end if;
	return v_deleted;
end
$$;

revoke all on function public.qorpera_claim_deleted_profile_object_gc(integer, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_renew_deleted_profile_object_gc(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.qorpera_complete_deleted_profile_object_gc(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.qorpera_release_deleted_profile_object_gc(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_claim_deleted_profile_object_gc(integer, uuid) to service_role;
grant execute on function public.qorpera_renew_deleted_profile_object_gc(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_complete_deleted_profile_object_gc(uuid, uuid, text[]) to service_role;
grant execute on function public.qorpera_release_deleted_profile_object_gc(uuid, uuid) to service_role;
