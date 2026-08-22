-- Physical object deletion is a two-phase operation. A durable authorization
-- is committed while the exact GC lease is live, bytes are removed by the
-- declared backend, and only then is the catalog row finalized. Outstanding
-- authorizations are independently reconcilable after worker or network loss.

create table public.qorpera_profile_object_deletion_authorizations (
	authorization_id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null,
	object_sha256 text not null check (object_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 8388608),
	backend text not null check (backend in ('supabase-storage', 'nas-object-gateway')),
	source_kind text not null check (source_kind in ('artifact_gc', 'company_gc', 'deleted_profile_gc')),
	source_id uuid not null,
	lease_id uuid not null,
	company_lease_profile_id uuid,
	company_lease_id uuid,
	deleted_profile_lease_profile_id uuid,
	deleted_profile_lease_id uuid,
	authorized_at timestamptz not null default statement_timestamp(),
	unique (profile_id, object_sha256),
	foreign key (company_lease_profile_id, company_lease_id)
		references public.qorpera_company_object_gc_leases(profile_id, lease_id) on delete restrict,
	foreign key (deleted_profile_lease_profile_id, deleted_profile_lease_id)
		references public.qorpera_deleted_profile_object_gc_leases(profile_id, lease_id) on delete restrict,
	check (
		(source_kind = 'artifact_gc'
			and company_lease_profile_id is null and company_lease_id is null
			and deleted_profile_lease_profile_id is null and deleted_profile_lease_id is null)
		or (source_kind = 'company_gc'
			and company_lease_profile_id = profile_id and company_lease_id = lease_id
			and deleted_profile_lease_profile_id is null and deleted_profile_lease_id is null)
		or (source_kind = 'deleted_profile_gc'
			and deleted_profile_lease_profile_id = profile_id and deleted_profile_lease_id = lease_id
			and company_lease_profile_id is null and company_lease_id is null)
	)
);

alter table public.qorpera_profile_object_deletion_authorizations enable row level security;
revoke all on public.qorpera_profile_object_deletion_authorizations from public, anon, authenticated;

-- A storage deletion that has entered the two-phase protocol must leave the
-- catalog intact for the service-only finalizer. Legacy, non-GC storage
-- deletion retains the existing mirror behavior and is surfaced by drift.
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
		if v_identity.profile_id is not null and not exists (
			select 1
			from public.qorpera_profile_object_deletion_authorizations as deletion_auth
			where deletion_auth.profile_id = v_identity.profile_id
				and deletion_auth.object_sha256 = v_identity.sha256
				and deletion_auth.backend = 'supabase-storage'
		) then
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

create function public.qorpera_authorize_profile_object_deletion(
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint,
	p_backend text,
	p_lease_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authorization public.qorpera_profile_object_deletion_authorizations%rowtype;
	v_object public.qorpera_profile_objects%rowtype;
	v_source_kind text;
	v_source_id uuid;
begin
	if auth.role() <> 'service_role'
		or p_profile_id is null
		or p_lease_id is null
		or p_sha256 is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null
		or p_bytes not between 0 and 8388608
		or p_backend is null
		or p_backend not in ('supabase-storage', 'nas-object-gateway') then
		raise exception 'object deletion authorization is invalid' using errcode = '42501';
	end if;
	select deletion_auth.* into v_authorization
	from public.qorpera_profile_object_deletion_authorizations as deletion_auth
	where deletion_auth.profile_id = p_profile_id and deletion_auth.object_sha256 = p_sha256
	for update;
	if found then
		if v_authorization.bytes is distinct from p_bytes
			or v_authorization.backend is distinct from p_backend then
			raise exception 'object deletion authorization does not match the catalog address' using errcode = '55000';
		end if;
		return jsonb_build_object('state', 'authorized', 'authorization_id', v_authorization.authorization_id);
	end if;

	select plan.id, 'artifact_gc' into v_source_id, v_source_kind
	from public.qorpera_artifact_gc_plans as plan
	join public.qorpera_artifact_gc_plan_entries as entry on entry.plan_id = plan.id
	where plan.profile_id = p_profile_id
		and plan.status = 'deleting'
		and plan.lease_id = p_lease_id
		and plan.lease_expires_at > statement_timestamp()
		and entry.object_sha256 = p_sha256
		and entry.bytes = p_bytes
		and entry.status = 'pending'
	for update of plan;
	if not found then
		select lease.profile_id, 'company_gc' into v_source_id, v_source_kind
		from public.qorpera_company_object_gc_leases as lease
		join public.qorpera_company_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
		for update of lease;
	end if;
	if v_source_kind is null then
		select lease.profile_id, 'deleted_profile_gc' into v_source_id, v_source_kind
		from public.qorpera_deleted_profile_object_gc_leases as lease
		join public.qorpera_deleted_profile_object_gc_entries as entry
			on entry.profile_id = lease.profile_id and entry.lease_id = lease.lease_id
		where lease.profile_id = p_profile_id
			and lease.lease_id = p_lease_id
			and lease.lease_expires_at > statement_timestamp()
			and entry.object_sha256 = p_sha256
			and entry.bytes = p_bytes
			and entry.backend = p_backend
		for update of lease;
	end if;
	if v_source_kind is null then
		raise exception 'object deletion lease is unavailable' using errcode = '40001';
	end if;

	if v_source_kind <> 'deleted_profile_gc' then
		perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	end if;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256
	for update;
	if not found then
		return jsonb_build_object('state', 'completed');
	end if;
	if v_object.bytes <> p_bytes or v_object.backend <> p_backend then
		raise exception 'object deletion does not match the catalog' using errcode = '55000';
	end if;
	insert into public.qorpera_profile_object_deletion_authorizations (
		profile_id, object_sha256, bytes, backend, source_kind, source_id, lease_id,
		company_lease_profile_id, company_lease_id,
		deleted_profile_lease_profile_id, deleted_profile_lease_id
	) values (
		p_profile_id, p_sha256, p_bytes, p_backend, v_source_kind, v_source_id, p_lease_id,
		case when v_source_kind = 'company_gc' then p_profile_id else null end,
		case when v_source_kind = 'company_gc' then p_lease_id else null end,
		case when v_source_kind = 'deleted_profile_gc' then p_profile_id else null end,
		case when v_source_kind = 'deleted_profile_gc' then p_lease_id else null end
	) returning * into v_authorization;
	return jsonb_build_object('state', 'authorized', 'authorization_id', v_authorization.authorization_id);
end
$$;

create function public.qorpera_describe_profile_object_deletion_authorization(
	p_authorization_id uuid,
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
	v_authorization public.qorpera_profile_object_deletion_authorizations%rowtype;
begin
	if auth.role() <> 'service_role'
		or p_authorization_id is null
		or p_profile_id is null
		or p_sha256 is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null
		or p_bytes not between 0 and 8388608
		or p_backend is null
		or p_backend not in ('supabase-storage', 'nas-object-gateway') then
		raise exception 'object deletion authorization is invalid' using errcode = '42501';
	end if;
	select deletion_auth.* into v_authorization
	from public.qorpera_profile_object_deletion_authorizations as deletion_auth
	where deletion_auth.authorization_id = p_authorization_id
	for update;
	if not found then
		if exists (
			select 1 from public.qorpera_profile_objects as object
			where object.profile_id = p_profile_id and object.sha256 = p_sha256
		) then
			raise exception 'object deletion authorization is unavailable' using errcode = '55000';
		end if;
		return jsonb_build_object('state', 'completed');
	end if;
	if v_authorization.profile_id is distinct from p_profile_id
		or v_authorization.object_sha256 is distinct from p_sha256
		or v_authorization.bytes is distinct from p_bytes
		or v_authorization.backend is distinct from p_backend then
		raise exception 'object deletion authorization does not match' using errcode = '55000';
	end if;
	return jsonb_build_object('state', 'authorized', 'authorization_id', v_authorization.authorization_id);
end
$$;

create function public.qorpera_finalize_profile_object_deletion(
	p_authorization_id uuid,
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint,
	p_backend text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authorization public.qorpera_profile_object_deletion_authorizations%rowtype;
	v_deleted boolean;
begin
	if auth.role() <> 'service_role'
		or p_authorization_id is null
		or p_profile_id is null
		or p_sha256 is null
		or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null
		or p_bytes not between 0 and 8388608
		or p_backend is null
		or p_backend not in ('supabase-storage', 'nas-object-gateway') then
		raise exception 'object deletion finalization is invalid' using errcode = '42501';
	end if;
	select deletion_auth.* into v_authorization
	from public.qorpera_profile_object_deletion_authorizations as deletion_auth
	where deletion_auth.authorization_id = p_authorization_id
	for update;
	if not found then
		if exists (
			select 1 from public.qorpera_profile_objects as object
			where object.profile_id = p_profile_id and object.sha256 = p_sha256
		) then
			raise exception 'object deletion finalization authorization is unavailable' using errcode = '55000';
		end if;
		return false;
	end if;
	if v_authorization.profile_id is distinct from p_profile_id
		or v_authorization.object_sha256 is distinct from p_sha256
		or v_authorization.bytes is distinct from p_bytes
		or v_authorization.backend is distinct from p_backend then
		raise exception 'object deletion finalization does not match' using errcode = '55000';
	end if;
	if exists (select 1 from public.qorpera_profiles as profile where profile.id = p_profile_id) then
		perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	end if;
	delete from public.qorpera_profile_objects
	where profile_id = p_profile_id and sha256 = p_sha256 and bytes = p_bytes and backend = p_backend;
	v_deleted := found;
	if not v_deleted and exists (
		select 1 from public.qorpera_profile_objects as object
		where object.profile_id = p_profile_id and object.sha256 = p_sha256
	) then
		raise exception 'object deletion finalization does not match the catalog' using errcode = '55000';
	end if;
	delete from public.qorpera_profile_object_deletion_authorizations
	where authorization_id = p_authorization_id;
	return v_deleted;
end
$$;

create function public.qorpera_list_authorized_profile_object_deletions(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 100 then
		raise exception 'object deletion reconciliation is invalid' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'authorization_id', deletion_auth.authorization_id,
			'profile_id', deletion_auth.profile_id,
			'sha256', deletion_auth.object_sha256,
			'bytes', deletion_auth.bytes,
			'path', deletion_auth.profile_id::text || '/' || deletion_auth.object_sha256,
			'backend', deletion_auth.backend
		) order by deletion_auth.authorized_at, deletion_auth.authorization_id)
		from (
			select candidate.*
			from public.qorpera_profile_object_deletion_authorizations as candidate
			order by candidate.authorized_at, candidate.authorization_id
			limit p_limit
		) as deletion_auth
	), '[]'::jsonb);
end
$$;

create or replace function public.qorpera_profile_gc_deletion_active(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.qorpera_artifact_gc_plans as plan
		where plan.profile_id = p_profile_id and plan.status = 'deleting'
	) or exists (
		select 1 from public.qorpera_company_object_gc_leases as lease
		where lease.profile_id = p_profile_id and lease.lease_expires_at > statement_timestamp()
	) or exists (
		select 1 from public.qorpera_profile_object_deletion_authorizations as deletion_auth
		where deletion_auth.profile_id = p_profile_id
	)
$$;

create or replace function public.qorpera_cancel_artifact_gc_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_plan public.qorpera_artifact_gc_plans%rowtype;
	v_expired_recovery boolean;
begin
	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_plan.profile_id) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
	if exists (
		select 1 from public.qorpera_profile_object_deletion_authorizations as deletion_auth
		where deletion_auth.source_kind = 'artifact_gc' and deletion_auth.source_id = p_plan_id
	) then
		raise exception 'artifact cleanup has an authorized physical deletion' using errcode = '55000';
	end if;
	if v_plan.status = 'cancelled' then return public.qorpera_artifact_gc_plan_json(v_plan); end if;
	v_expired_recovery := v_plan.status = 'deleting'
		and v_plan.lease_expires_at <= statement_timestamp() - interval '1 minute';
	if (v_plan.started_at is not null and not v_expired_recovery)
		or (v_plan.status not in ('waiting', 'retrying') and not v_expired_recovery) then
		raise exception 'artifact cleanup plan can no longer be cancelled' using errcode = '55000';
	end if;
	perform public.qorpera_lock_profile_gc_fence(v_plan.profile_id);
	update public.qorpera_artifact_gc_plans
	set status = 'cancelled', cancelled_by_user_id = v_user_id,
		cancelled_at = statement_timestamp(), lease_id = null, lease_expires_at = null
	where id = p_plan_id returning * into v_plan;
	perform public.qorpera_append_artifact_gc_audit(
		v_plan,
		'cancelled',
		jsonb_build_object('expired_lease_recovery', v_expired_recovery),
		v_user_id
	);
	return public.qorpera_artifact_gc_plan_json(v_plan);
end
$$;

create function public.qorpera_cancel_artifact_gc_plan_v2(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	return public.qorpera_cancel_artifact_gc_plan(p_plan_id);
end
$$;

create function public.qorpera_fail_artifact_gc_plan_v2(p_plan_id uuid, p_lease_id uuid, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'artifact cleanup worker authorization is invalid' using errcode = '42501';
	end if;
	if exists (
		select 1 from public.qorpera_profile_object_deletion_authorizations as deletion_auth
		where deletion_auth.source_kind = 'artifact_gc' and deletion_auth.source_id = p_plan_id
	) then
		raise exception 'artifact cleanup physical deletion must be reconciled' using errcode = '55000';
	end if;
	return public.qorpera_fail_artifact_gc_plan(p_plan_id, p_lease_id, p_error);
end
$$;

create function public.qorpera_release_company_object_gc_v2(p_profile_id uuid, p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'company object cleanup authorization is invalid' using errcode = '42501';
	end if;
	if exists (
		select 1 from public.qorpera_profile_object_deletion_authorizations as deletion_auth
		where deletion_auth.source_kind = 'company_gc'
			and deletion_auth.source_id = p_profile_id and deletion_auth.lease_id = p_lease_id
	) then
		raise exception 'company object physical deletion must be reconciled' using errcode = '55000';
	end if;
	perform public.qorpera_release_company_object_gc(p_profile_id, p_lease_id);
end
$$;

create function public.qorpera_release_deleted_profile_object_gc_v2(p_profile_id uuid, p_lease_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'deleted profile object cleanup authorization is invalid' using errcode = '42501';
	end if;
	if exists (
		select 1 from public.qorpera_profile_object_deletion_authorizations as deletion_auth
		where deletion_auth.source_kind = 'deleted_profile_gc'
			and deletion_auth.source_id = p_profile_id and deletion_auth.lease_id = p_lease_id
	) then
		raise exception 'deleted profile object physical deletion must be reconciled' using errcode = '55000';
	end if;
	perform public.qorpera_release_deleted_profile_object_gc(p_profile_id, p_lease_id);
end
$$;

-- Exact client-request replay is part of sponsor provenance. Reusing a request
-- id with a different input, sponsor, compute identity or review policy is a
-- conflict, never a silent selection of the earlier sponsor.
create function public.qorpera_request_session_turn_v2(
	p_session_id uuid,
	p_client_input_id uuid,
	p_client_request_id uuid,
	p_body jsonb,
	p_sponsor_mode text,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_requested_sponsor_user_id uuid,
	p_compute_identity_id uuid,
	p_logical_computer_id uuid,
	p_worker_class text default 'managed_sandbox',
	p_required_capability text default 'agent_turn',
	p_job_type text default 'agent_turn',
	p_publication_mode text default 'automatic',
	p_review_policy_key text default null,
	p_reviewer_staff_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_request public.qorpera_session_turn_requests%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
begin
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if v_user_id is null or not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'session turn request is unavailable' using errcode = '42501';
	end if;
	select request.* into v_request
	from public.qorpera_session_turn_requests as request
	where request.session_id = p_session_id and request.client_request_id = p_client_request_id;
	if found then
		select input.* into v_input
		from public.qorpera_session_inputs as input
		where input.id = v_request.input_id;
		if v_request.requested_by_user_id is distinct from v_user_id
			or v_input.client_input_id is distinct from p_client_input_id
			or v_input.author_user_id is distinct from v_user_id
			or v_input.kind is distinct from 'user_message'
			or v_input.body is distinct from p_body
			or v_request.sponsor_mode is distinct from p_sponsor_mode
			or v_request.sponsor_binding_id is distinct from p_sponsor_binding_id
			or v_request.sponsor_version is distinct from p_sponsor_version
			or v_request.requested_sponsor_user_id is distinct from p_requested_sponsor_user_id
			or v_request.compute_identity_id is distinct from p_compute_identity_id
			or v_request.logical_computer_id is distinct from p_logical_computer_id
			or v_request.worker_class is distinct from p_worker_class
			or v_request.required_capability is distinct from p_required_capability
			or v_request.job_type is distinct from p_job_type
			or v_request.publication_mode is distinct from p_publication_mode
			or v_request.review_policy_key is distinct from nullif(btrim(p_review_policy_key), '')
			or v_request.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[]) then
			raise exception 'session turn client request id is bound to another request' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'turn_request_id', v_request.id,
			'input_id', v_request.input_id,
			'status', v_request.status,
			'sponsor_mode', v_request.sponsor_mode
		);
	end if;
	return public.qorpera_request_session_turn(
		p_session_id, p_client_input_id, p_client_request_id, p_body, p_sponsor_mode,
		p_sponsor_binding_id, p_sponsor_version, p_requested_sponsor_user_id,
		p_compute_identity_id, p_logical_computer_id, p_worker_class, p_required_capability,
		p_job_type, p_publication_mode, p_review_policy_key, p_reviewer_staff_ids
	);
end
$$;

revoke all on function public.qorpera_confirm_profile_object_deletion(uuid, text, bigint, text, uuid) from service_role;
revoke all on function public.qorpera_fail_artifact_gc_plan(uuid, uuid, text) from service_role;
revoke all on function public.qorpera_release_company_object_gc(uuid, uuid) from service_role;
revoke all on function public.qorpera_release_deleted_profile_object_gc(uuid, uuid) from service_role;
revoke all on function public.qorpera_request_session_turn(uuid, uuid, uuid, jsonb, text, uuid, bigint, uuid, uuid, uuid, text, text, text, text, text, uuid[]) from authenticated;

revoke all on function public.qorpera_authorize_profile_object_deletion(uuid, text, bigint, text, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_describe_profile_object_deletion_authorization(uuid, uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.qorpera_finalize_profile_object_deletion(uuid, uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.qorpera_list_authorized_profile_object_deletions(integer) from public, anon, authenticated;
revoke all on function public.qorpera_cancel_artifact_gc_plan_v2(uuid) from public, anon;
revoke all on function public.qorpera_fail_artifact_gc_plan_v2(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qorpera_release_company_object_gc_v2(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_release_deleted_profile_object_gc_v2(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_request_session_turn_v2(uuid, uuid, uuid, jsonb, text, uuid, bigint, uuid, uuid, uuid, text, text, text, text, text, uuid[]) from public, anon;

grant execute on function public.qorpera_authorize_profile_object_deletion(uuid, text, bigint, text, uuid) to service_role;
grant execute on function public.qorpera_describe_profile_object_deletion_authorization(uuid, uuid, text, bigint, text) to service_role;
grant execute on function public.qorpera_finalize_profile_object_deletion(uuid, uuid, text, bigint, text) to service_role;
grant execute on function public.qorpera_list_authorized_profile_object_deletions(integer) to service_role;
grant execute on function public.qorpera_cancel_artifact_gc_plan_v2(uuid) to authenticated;
grant execute on function public.qorpera_fail_artifact_gc_plan_v2(uuid, uuid, text) to service_role;
grant execute on function public.qorpera_release_company_object_gc_v2(uuid, uuid) to service_role;
grant execute on function public.qorpera_release_deleted_profile_object_gc_v2(uuid, uuid) to service_role;
grant execute on function public.qorpera_request_session_turn_v2(uuid, uuid, uuid, jsonb, text, uuid, bigint, uuid, uuid, uuid, text, text, text, text, text, uuid[]) to authenticated;
