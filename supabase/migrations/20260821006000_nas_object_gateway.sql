-- Completes the self-owned object-storage trust boundary. Supabase remains the
-- authoritative catalog and retention coordinator; verified immutable bytes
-- may now live behind the trusted Qorpera NAS object gateway.

alter table public.qorpera_profile_objects
	drop constraint qorpera_profile_objects_backend_check;
alter table public.qorpera_profile_objects
	add constraint qorpera_profile_objects_backend_check
	check (backend in ('supabase-storage', 'nas-object-gateway'));

-- Storage mirroring must never erase or overwrite a row that has already been
-- migrated to the NAS. Deleting the legacy duplicate is then harmless.
create or replace function public.qorpera_mirror_profile_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_identity record;
begin
	if tg_op = 'DELETE' then
		select * into v_identity
		from public.qorpera_profile_object_identity(old.bucket_id, old.name, old.metadata);
		if v_identity.profile_id is not null then
			delete from public.qorpera_profile_objects
			where profile_id = v_identity.profile_id
				and sha256 = v_identity.sha256
				and backend = 'supabase-storage';
		end if;
		return old;
	end if;

	select * into v_identity
	from public.qorpera_profile_object_identity(new.bucket_id, new.name, new.metadata);
	if v_identity.profile_id is null or v_identity.sha256 is null or v_identity.bytes is null then
		return new;
	end if;
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend)
	values (v_identity.profile_id, v_identity.sha256, v_identity.bytes, 'supabase-storage')
	on conflict (profile_id, sha256) do update
	set bytes = excluded.bytes
	where qorpera_profile_objects.backend = 'supabase-storage';
	return new;
end
$$;

-- Drift is defined only for rows whose declared backend is Supabase Storage.
-- NAS rows intentionally have no storage.objects counterpart.
create or replace function public.qorpera_object_catalog_drift()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
	with live_raw as (
		select identity.profile_id, identity.sha256, identity.bytes
		from storage.objects as object
		cross join lateral
			public.qorpera_profile_object_identity(object.bucket_id, object.name, object.metadata) as identity
		where identity.profile_id is not null
			and identity.sha256 is not null
			and identity.bytes is not null
	), live as (
		select object.profile_id, object.sha256, object.bytes
		from live_raw as object
		where not exists (
			select 1
			from public.qorpera_profile_objects as catalog_object
			where catalog_object.profile_id = object.profile_id
				and catalog_object.sha256 = object.sha256
				and catalog_object.backend = 'nas-object-gateway'
		)
	), catalog as (
		select profile_id, sha256, bytes
		from public.qorpera_profile_objects
		where backend = 'supabase-storage'
	)
	select count(*)
	from (
		(
			select profile_id, sha256, bytes from live
			except
			select profile_id, sha256, bytes from catalog
		)
		union all
		(
			select profile_id, sha256, bytes from catalog
			except
			select profile_id, sha256, bytes from live
		)
	) as divergence
$$;

create or replace function public.qorpera_backfill_profile_object_catalog()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_adopted bigint;
begin
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend)
	select identity.profile_id, identity.sha256, identity.bytes, 'supabase-storage'
	from storage.objects as object
	cross join lateral
		public.qorpera_profile_object_identity(object.bucket_id, object.name, object.metadata) as identity
	where identity.profile_id is not null
		and identity.sha256 is not null
		and identity.bytes is not null
	on conflict (profile_id, sha256) do update
	set bytes = excluded.bytes
	where qorpera_profile_objects.backend = 'supabase-storage';
	get diagnostics v_adopted = row_count;
	return v_adopted;
end
$$;

create function public.qorpera_authorize_profile_object_upload(
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_object public.qorpera_profile_objects%rowtype;
begin
	if auth.uid() is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608 then
		raise exception 'object upload authority is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_profile_object_writes_allowed(p_profile_id) then
		raise exception 'profile object write access is required' using errcode = '42501';
	end if;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256;
	if found and v_object.bytes <> p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505';
	end if;
	return jsonb_build_object(
		'allowed', true,
		'exists', found,
		'backend', case when found then v_object.backend else null end,
		'bytes', p_bytes
	);
end
$$;

create function public.qorpera_authorize_profile_object_download(
	p_profile_id uuid,
	p_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_object public.qorpera_profile_objects%rowtype;
begin
	if auth.uid() is null or p_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'object download authority is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256;
	if not found then
		raise exception 'profile object is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object('backend', v_object.backend, 'bytes', v_object.bytes);
end
$$;

create function public.qorpera_confirm_profile_object_upload(
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint,
	p_backend text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_object public.qorpera_profile_objects%rowtype;
begin
	if auth.role() <> 'service_role'
		or p_backend <> 'nas-object-gateway'
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608 then
		raise exception 'object upload confirmation is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'profile object writes are temporarily fenced' using errcode = '40001';
	end if;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256
	for update;
	if found and v_object.bytes <> p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505';
	end if;
	insert into public.qorpera_profile_objects (profile_id, sha256, bytes, backend)
	values (p_profile_id, p_sha256, p_bytes, p_backend)
	on conflict (profile_id, sha256) do update
	set backend = excluded.backend;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256;
	return jsonb_build_object(
		'profile_id', v_object.profile_id,
		'sha256', v_object.sha256,
		'bytes', v_object.bytes,
		'backend', v_object.backend
	);
end
$$;

create function public.qorpera_confirm_profile_object_deletion(
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
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
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

create function public.qorpera_list_profile_objects_for_migration(
	p_after_profile_id uuid,
	p_after_sha256 text,
	p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role'
		or p_limit not between 1 and 500
		or (p_after_profile_id is null) <> (p_after_sha256 is null)
		or (p_after_sha256 is not null and p_after_sha256 !~ '^[0-9a-f]{64}$') then
		raise exception 'object migration cursor is invalid' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'profile_id', object.profile_id,
			'sha256', object.sha256,
			'bytes', object.bytes
		) order by object.profile_id, object.sha256)
		from (
			select candidate.profile_id, candidate.sha256, candidate.bytes
			from public.qorpera_profile_objects as candidate
			where candidate.backend = 'supabase-storage'
				and (
					p_after_profile_id is null
					or candidate.profile_id > p_after_profile_id
					or (candidate.profile_id = p_after_profile_id and candidate.sha256 > p_after_sha256)
				)
			order by candidate.profile_id, candidate.sha256
			limit p_limit
		) as object
	), '[]'::jsonb);
end
$$;

create or replace function public.qorpera_claim_artifact_gc_objects(
	p_plan_id uuid,
	p_lease_id uuid,
	p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_plan public.qorpera_artifact_gc_plans%rowtype;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 100 then
		raise exception 'artifact cleanup object claim is invalid' using errcode = '42501';
	end if;
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan
	where plan.id = p_plan_id and plan.status = 'deleting'
		and plan.lease_id = p_lease_id and plan.lease_expires_at > statement_timestamp()
	for update;
	if not found then raise exception 'artifact cleanup lease is unavailable' using errcode = '40001'; end if;

	update public.qorpera_artifact_gc_plan_entries as entry
	set status = 'retained', acknowledged_at = statement_timestamp()
	where entry.plan_id = p_plan_id and entry.status = 'pending'
		and exists (
			select 1
			from public.qorpera_object_reachability_entries as retained_entry
			join public.qorpera_object_reachability_graphs as retained_graph
				on retained_graph.id = retained_entry.graph_id
			where retained_entry.object_sha256 = entry.object_sha256
				and retained_graph.id <> v_plan.graph_id
				and retained_graph.profile_id = v_plan.profile_id
				and retained_graph.status = 'complete'
		);

	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', v_plan.profile_id::text || '/' || entry.object_sha256,
			'backend', coalesce(object.backend, 'missing')
		) order by entry.object_sha256)
		from (
			select candidate.* from public.qorpera_artifact_gc_plan_entries as candidate
			where candidate.plan_id = p_plan_id and candidate.status = 'pending'
			order by candidate.object_sha256 limit p_limit
		) as entry
		left join public.qorpera_profile_objects as object
			on object.profile_id = v_plan.profile_id and object.sha256 = entry.object_sha256
	), '[]'::jsonb);
end
$$;

create or replace function public.qorpera_claim_company_object_gc(p_limit integer, p_lease_id uuid)
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
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	delete from public.qorpera_company_object_gc_leases
	where lease_expires_at <= statement_timestamp();

	for v_profile_id in
		select object.profile_id
		from public.qorpera_profile_objects as object
		join public.qorpera_company_files as file on file.profile_id = object.profile_id
		where object.created_at < statement_timestamp() - interval '24 hours'
			and not exists (
				select 1
				from public.qorpera_company_retained_object_hashes(object.profile_id) as retained
				where retained.object_sha256 = object.sha256
			)
		group by object.profile_id
		order by min(object.created_at), object.profile_id
	loop
		perform public.qorpera_lock_profile_gc_fence(v_profile_id);
		if public.qorpera_profile_gc_deletion_active(v_profile_id) then
			continue;
		end if;
		insert into public.qorpera_company_object_gc_leases (profile_id, lease_id, lease_expires_at)
		values (v_profile_id, p_lease_id, statement_timestamp() + interval '10 minutes');
		insert into public.qorpera_company_object_gc_entries (profile_id, lease_id, object_sha256, bytes)
		select object.profile_id, p_lease_id, object.sha256, object.bytes
		from public.qorpera_profile_objects as object
		where object.profile_id = v_profile_id
			and object.created_at < statement_timestamp() - interval '24 hours'
			and not exists (
				select 1
				from public.qorpera_company_retained_object_hashes(v_profile_id) as retained
				where retained.object_sha256 = object.sha256
			)
		order by object.created_at, object.sha256
		limit p_limit;
		select jsonb_agg(jsonb_build_object(
			'sha256', entry.object_sha256,
			'bytes', entry.bytes,
			'path', entry.profile_id::text || '/' || entry.object_sha256,
			'backend', coalesce(object.backend, 'missing')
		) order by entry.object_sha256) into v_objects
		from public.qorpera_company_object_gc_entries as entry
		left join public.qorpera_profile_objects as object
			on object.profile_id = entry.profile_id and object.sha256 = entry.object_sha256
		where entry.profile_id = v_profile_id and entry.lease_id = p_lease_id;
		if v_objects is null then
			delete from public.qorpera_company_object_gc_leases
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

revoke all on function public.qorpera_authorize_profile_object_upload(uuid, text, bigint) from public, anon;
revoke all on function public.qorpera_authorize_profile_object_download(uuid, text) from public, anon;
revoke all on function public.qorpera_confirm_profile_object_upload(uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.qorpera_confirm_profile_object_deletion(uuid, text, bigint, text, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_list_profile_objects_for_migration(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.qorpera_authorize_profile_object_upload(uuid, text, bigint) to authenticated;
grant execute on function public.qorpera_authorize_profile_object_download(uuid, text) to authenticated;
grant execute on function public.qorpera_confirm_profile_object_upload(uuid, text, bigint, text) to service_role;
grant execute on function public.qorpera_confirm_profile_object_deletion(uuid, text, bigint, text, uuid) to service_role;
grant execute on function public.qorpera_list_profile_objects_for_migration(uuid, text, integer) to service_role;
