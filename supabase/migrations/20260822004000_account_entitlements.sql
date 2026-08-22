-- Product entitlement is cloud authority. Normal accounts retain the 50 GiB
-- freemium NAS allocation; explicitly granted internal accounts are
-- complimentary, receive the full feature set, and have unlimited allocation.

create table public.qorpera_account_entitlements (
	user_id uuid primary key references auth.users(id) on delete cascade,
	plan_key text not null check (plan_key in ('freemium', 'internal')),
	billing_mode text not null check (billing_mode in ('free', 'complimentary')),
	feature_set text not null check (feature_set in ('standard', 'all')),
	storage_allocation text not null check (storage_allocation in ('metered', 'unlimited')),
	operator_reference text not null check (char_length(btrim(operator_reference)) between 1 and 256),
	reason text not null check (char_length(btrim(reason)) between 1 and 512),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	check (
		(plan_key = 'freemium' and billing_mode = 'free' and feature_set = 'standard'
			and storage_allocation = 'metered')
		or (plan_key = 'internal' and billing_mode = 'complimentary' and feature_set = 'all'
			and storage_allocation = 'unlimited')
	)
);

create table public.qorpera_account_entitlement_changes (
	id bigint generated always as identity primary key,
	user_id uuid not null references auth.users(id) on delete cascade,
	previous_entitlement jsonb not null check (jsonb_typeof(previous_entitlement) = 'object'),
	current_entitlement jsonb not null check (jsonb_typeof(current_entitlement) = 'object'),
	operator_reference text not null check (char_length(btrim(operator_reference)) between 1 and 256),
	reason text not null check (char_length(btrim(reason)) between 1 and 512),
	changed_at timestamptz not null default statement_timestamp()
);

alter table public.qorpera_account_entitlements enable row level security;
alter table public.qorpera_account_entitlement_changes enable row level security;
revoke all on public.qorpera_account_entitlements from public, anon, authenticated, service_role;
revoke all on public.qorpera_account_entitlement_changes from public, anon, authenticated, service_role;
revoke all on sequence public.qorpera_account_entitlement_changes_id_seq from public, anon, authenticated, service_role;

create function public.qorpera_account_entitlement_json(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(
		(
			select jsonb_build_object(
				'plan_key', entitlement.plan_key,
				'billing_mode', entitlement.billing_mode,
				'feature_set', entitlement.feature_set,
				'storage_allocation', entitlement.storage_allocation,
				'storage_allocation_bytes', case
					when entitlement.storage_allocation = 'unlimited' then null
					else 53687091200
				end,
				'source', 'explicit',
				'updated_at', entitlement.updated_at
			)
			from public.qorpera_account_entitlements as entitlement
			where entitlement.user_id = p_user_id
		),
		jsonb_build_object(
			'plan_key', 'freemium',
			'billing_mode', 'free',
			'feature_set', 'standard',
			'storage_allocation', 'metered',
			'storage_allocation_bytes', 53687091200,
			'source', 'default',
			'updated_at', null
		)
	)
$$;

create function public.qorpera_profile_entitlement_json(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_account_entitlement_json((
		select member.user_id
		from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.role = 'owner'
	))
$$;

create function public.qorpera_profile_storage_is_unlimited(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_profile_entitlement_json(p_profile_id) ->> 'storage_allocation' = 'unlimited'
$$;

create function public.qorpera_profile_company_output_limit(p_profile_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
	-- Unlimited allocation removes product metering. A single execution still
	-- obeys the 1 TiB Company File tree safety contract.
	select case
		when public.qorpera_profile_storage_is_unlimited(p_profile_id) then 1099511627776::bigint
		else (
			select min(file.storage_limit_bytes)
			from public.qorpera_company_files as file
			where file.profile_id = p_profile_id
		)
	end
$$;

create function public.qorpera_get_account_entitlement()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	return public.qorpera_account_entitlement_json(v_user_id);
end
$$;

create function public.qorpera_set_account_entitlement(
	p_user_id uuid,
	p_plan_key text,
	p_billing_mode text,
	p_feature_set text,
	p_storage_allocation text,
	p_operator_reference text,
	p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_previous jsonb;
	v_current jsonb;
	v_operator_reference text := btrim(p_operator_reference);
	v_reason text := btrim(p_reason);
begin
	if auth.role() <> 'service_role' then
		raise exception 'account entitlement authority is invalid' using errcode = '42501';
	end if;
	if not exists (select 1 from auth.users as account where account.id = p_user_id)
		or char_length(v_operator_reference) not between 1 and 256
		or char_length(v_reason) not between 1 and 512
		or not (
			(p_plan_key = 'freemium' and p_billing_mode = 'free' and p_feature_set = 'standard'
				and p_storage_allocation = 'metered')
			or (p_plan_key = 'internal' and p_billing_mode = 'complimentary' and p_feature_set = 'all'
				and p_storage_allocation = 'unlimited')
		) then
		raise exception 'account entitlement contract is invalid' using errcode = '22023';
	end if;
	if p_storage_allocation = 'metered' and exists (
		select 1
		from public.qorpera_company_files as file
		join public.qorpera_profile_members as member on member.profile_id = file.profile_id
		where member.user_id = p_user_id and member.role = 'owner'
			and file.storage_used_bytes > file.storage_limit_bytes
	) then
		raise exception 'account storage exceeds the requested metered allocation' using errcode = '23514';
	end if;

	v_previous := public.qorpera_account_entitlement_json(p_user_id);
	insert into public.qorpera_account_entitlements (
		user_id, plan_key, billing_mode, feature_set, storage_allocation,
		operator_reference, reason
	) values (
		p_user_id, p_plan_key, p_billing_mode, p_feature_set, p_storage_allocation,
		v_operator_reference, v_reason
	)
	on conflict (user_id) do update
	set plan_key = excluded.plan_key,
		billing_mode = excluded.billing_mode,
		feature_set = excluded.feature_set,
		storage_allocation = excluded.storage_allocation,
		operator_reference = excluded.operator_reference,
		reason = excluded.reason,
		updated_at = statement_timestamp();
	v_current := public.qorpera_account_entitlement_json(p_user_id);
	insert into public.qorpera_account_entitlement_changes (
		user_id, previous_entitlement, current_entitlement, operator_reference, reason
	) values (
		p_user_id, v_previous, v_current, v_operator_reference, v_reason
	);
	return v_current;
end
$$;

revoke all on function public.qorpera_account_entitlement_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_profile_entitlement_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_profile_storage_is_unlimited(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_profile_company_output_limit(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_get_account_entitlement() from public, anon;
revoke all on function public.qorpera_set_account_entitlement(uuid, text, text, text, text, text, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_get_account_entitlement() to authenticated;
grant execute on function public.qorpera_set_account_entitlement(uuid, text, text, text, text, text, text) to service_role;

create or replace function public.qorpera_company_file_json(p_file public.qorpera_company_files)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'profile_id', p_file.profile_id,
		'environment_id', p_file.environment_id,
		'canonical_workspace_id', p_file.canonical_workspace_id,
		'head_snapshot_id', p_file.head_snapshot_id,
		'state', p_file.state,
		'logical_bytes', p_file.logical_bytes,
		'retained_storage_bytes', coalesce((
			select sum(object.bytes)
			from public.qorpera_profile_objects as object
			where object.profile_id = p_file.profile_id
				and exists (
					select 1
					from public.qorpera_company_retained_object_hashes(p_file.profile_id) as retained
					where retained.object_sha256 = object.sha256
				)
		), 0),
		'storage_used_bytes', p_file.storage_used_bytes,
		'storage_limit_bytes', p_file.storage_limit_bytes,
		'object_backends', coalesce((
			select jsonb_agg(backend.backend order by backend.backend)
			from (
				select distinct object.backend
				from public.qorpera_profile_objects as object
				where object.profile_id = p_file.profile_id
			) as backend
		), '[]'::jsonb),
		'entitlement', public.qorpera_profile_entitlement_json(p_file.profile_id),
		'created_at', p_file.created_at,
		'updated_at', p_file.updated_at
	)
$$;

create or replace function public.qorpera_enforce_company_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_identity record;
	v_limit bigint;
	v_used bigint;
	v_existing_bytes bigint;
begin
	select * into v_identity
	from public.qorpera_profile_object_identity(new.bucket_id, new.name, new.metadata);
	if v_identity.profile_id is null or v_identity.sha256 is null or v_identity.bytes is null then
		return new;
	end if;
	if public.qorpera_profile_storage_is_unlimited(v_identity.profile_id) then
		return new;
	end if;

	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id
	for update;
	select min(file.storage_limit_bytes), max(file.storage_used_bytes)
	into v_limit, v_used
	from public.qorpera_company_files as file
	where file.profile_id = v_identity.profile_id;
	if v_limit is null then
		return new;
	end if;
	select object.bytes into v_existing_bytes
	from public.qorpera_profile_objects as object
	where object.profile_id = v_identity.profile_id and object.sha256 = v_identity.sha256;
	if v_used + v_identity.bytes - coalesce(v_existing_bytes, 0) > v_limit then
		raise exception 'company storage allowance exceeded' using errcode = '23514';
	end if;
	return new;
end
$$;

create or replace function public.qorpera_authorize_profile_object_upload(
	p_profile_id uuid,
	p_sha256 text,
	p_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_object public.qorpera_profile_objects%rowtype;
	v_exists boolean;
	v_limit bigint;
	v_used bigint;
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
	v_exists := found;
	if v_exists and v_object.bytes <> p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505';
	end if;
	if not v_exists and not public.qorpera_profile_storage_is_unlimited(p_profile_id) then
		select min(file.storage_limit_bytes), max(file.storage_used_bytes)
		into v_limit, v_used
		from public.qorpera_company_files as file
		where file.profile_id = p_profile_id;
		if v_limit is null then
			raise exception 'company storage authority is unavailable' using errcode = '55000';
		end if;
		if v_used + p_bytes > v_limit then
			raise exception 'company storage allowance exceeded' using errcode = '23514';
		end if;
	end if;
	return jsonb_build_object(
		'allowed', true,
		'exists', v_exists,
		'backend', case when v_exists then v_object.backend else null end,
		'bytes', p_bytes
	);
end
$$;

create or replace function public.qorpera_confirm_profile_object_upload(
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
	v_limit bigint;
	v_used bigint;
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
	perform 1
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id
	for update;
	if not found then
		raise exception 'company storage authority is unavailable' using errcode = '55000';
	end if;
	select min(file.storage_limit_bytes), max(file.storage_used_bytes)
	into v_limit, v_used
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id;
	select object.* into v_object
	from public.qorpera_profile_objects as object
	where object.profile_id = p_profile_id and object.sha256 = p_sha256
	for update;
	if found and v_object.bytes <> p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505';
	end if;
	if not found and not public.qorpera_profile_storage_is_unlimited(p_profile_id)
		and v_used + p_bytes > v_limit then
		raise exception 'company storage allowance exceeded' using errcode = '23514';
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

revoke all on function public.qorpera_authorize_profile_object_upload(uuid, text, bigint) from public, anon;
revoke all on function public.qorpera_confirm_profile_object_upload(uuid, text, bigint, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_authorize_profile_object_upload(uuid, text, bigint) to authenticated;
grant execute on function public.qorpera_confirm_profile_object_upload(uuid, text, bigint, text) to service_role;

create or replace function public.qorpera_runner_broker_authorize_company_file_object(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_object_sha256 text,
	p_bytes bigint,
	p_media_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_existing public.qorpera_runner_job_output_objects%rowtype;
	v_output_limit bigint;
	v_max_objects bigint;
	v_media_type text := lower(btrim(p_media_type));
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if exists (
		select 1 from public.qorpera_execution_runs as run
		where run.id = v_job.run_id and run.source_kind = 'proposal_review'
	) then
		raise exception 'proposal review executions cannot write Company File objects' using errcode = '42501';
	end if;
	if p_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 1 and 8388608
		or char_length(v_media_type) not between 3 and 256
		or v_media_type not like '%/%'
		or v_media_type ~ E'[\r\n]' then
		raise exception 'runner Company File object is invalid' using errcode = '22023';
	end if;
	v_output_limit := public.qorpera_profile_company_output_limit(v_job.profile_id);
	if v_output_limit is null then
		raise exception 'runner Company File storage authority is unavailable' using errcode = '55000';
	end if;
	-- Contract-v3 writers use one manifest per file and canonical 4 MiB chunks.
	-- This is an execution safety budget, independent from unlimited account
	-- allocation and billing.
	v_max_objects := 50001::bigint + ceiling(v_output_limit::numeric / 4194304)::bigint;
	select output.* into v_existing
	from public.qorpera_runner_job_output_objects as output
	where output.job_id = v_job.id and output.object_sha256 = p_object_sha256
	for update;
	if found then
		if v_existing.bytes <> p_bytes or v_existing.media_type <> v_media_type then
			raise exception 'runner output hash is already bound to different metadata' using errcode = '23505';
		end if;
		if not ('company_file' = any(v_existing.purposes)) then
			update public.qorpera_execution_run_budgets
			set company_object_count = company_object_count + 1,
				company_object_bytes = company_object_bytes + p_bytes
			where run_id = v_job.run_id
				and company_object_count < v_max_objects
				and company_object_bytes + p_bytes <= v_output_limit;
			if not found then
				raise exception 'runner Company File object authorization budget is exhausted' using errcode = '55000';
			end if;
			update public.qorpera_runner_job_output_objects
			set purposes = case
				when 'artifact' = any(purposes) then array['artifact', 'company_file']::text[]
				else array['company_file']::text[]
			end
			where job_id = v_job.id and object_sha256 = p_object_sha256
			returning * into v_existing;
		end if;
		return jsonb_build_object(
			'profile_id', v_existing.profile_id,
			'object_sha256', v_existing.object_sha256,
			'bytes', v_existing.bytes,
			'uploaded', v_existing.uploaded_at is not null
		);
	end if;
	update public.qorpera_execution_run_budgets
	set company_object_count = company_object_count + 1,
		company_object_bytes = company_object_bytes + p_bytes
	where run_id = v_job.run_id
		and company_object_count < v_max_objects
		and company_object_bytes + p_bytes <= v_output_limit;
	if not found then
		raise exception 'runner Company File object authorization budget is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_runner_job_output_objects (
		job_id, profile_id, object_sha256, bytes, media_type, purposes
	) values (
		v_job.id, v_job.profile_id, p_object_sha256, p_bytes, v_media_type,
		array['company_file']::text[]
	) returning * into v_existing;
	return jsonb_build_object(
		'profile_id', v_existing.profile_id,
		'object_sha256', v_existing.object_sha256,
		'bytes', v_existing.bytes,
		'uploaded', false
	);
end
$$;

create or replace function public.qorpera_runner_broker_describe(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_proposal_snapshot public.qorpera_company_snapshots%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_index public.qorpera_artifact_indexes%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_output_limit bigint;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run
	from public.qorpera_execution_runs as run
	where run.id = v_job.run_id and run.job_id = v_job.id;
	select version.* into strict v_version
	from public.qorpera_company_substrate_versions as version
	where version.id = v_job.substrate_version_id;
	select snapshot.* into strict v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = v_version.company_snapshot_id;
	if v_run.source_kind = 'proposal_review' then
		select snapshot.* into strict v_proposal_snapshot
		from public.qorpera_company_proposal_review_assignments as review
		join public.qorpera_company_proposal_revisions as revision
			on revision.proposal_id = review.proposal_id
			and revision.revision = review.proposal_revision
		join public.qorpera_company_snapshots as snapshot
			on snapshot.id = revision.proposal_snapshot_id
		where review.run_id = v_run.id and review.status = 'running';
	end if;
	select file.* into strict v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_job.profile_id and file.environment_id = v_job.environment_id;
	v_output_limit := public.qorpera_profile_company_output_limit(v_job.profile_id);
	if v_output_limit is null then
		raise exception 'runner Company File storage authority is unavailable' using errcode = '55000';
	end if;
	if v_version.artifact_index_id is not null then
		select artifact_index.* into strict v_index
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.id = v_version.artifact_index_id;
	end if;
	select binding.* into strict v_binding
	from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = v_run.sponsor_binding_id and binding.status = 'active';
	select sponsor.* into strict v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	select connection.* into strict v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id and connection.status = 'active';
	select connection_version.* into strict v_connection_version
	from public.qorpera_provider_connection_versions as connection_version
	where connection_version.connection_id = v_sponsor.provider_connection_id
		and connection_version.version = v_sponsor.provider_connection_version;
	if v_job.run_id is null or v_job.client_lease_id is null
		or v_run.profile_id <> v_job.profile_id
		or v_run.environment_id <> v_job.environment_id
		or v_run.substrate_version_id <> v_job.substrate_version_id
		or v_run.company_snapshot_id <> v_snapshot.id
		or v_binding.profile_id <> v_job.profile_id
		or v_connection.profile_id <> v_job.profile_id
		or v_version.profile_id <> v_job.profile_id
		or v_version.environment_id <> v_job.environment_id
		or v_snapshot.profile_id <> v_job.profile_id
		or v_snapshot.environment_id <> v_job.environment_id
		or (v_run.source_kind = 'proposal_review' and (
			v_proposal_snapshot.profile_id <> v_job.profile_id
			or v_proposal_snapshot.environment_id <> v_job.environment_id
		))
		or (v_index.id is not null and (
			v_index.profile_id <> v_job.profile_id
			or v_index.environment_id <> v_job.environment_id
			or v_index.content_sha256 is distinct from v_version.artifact_manifest_sha256
		)) then
		raise exception 'runner job authority is inconsistent' using errcode = '55000';
	end if;
	if not exists (
		select 1
		from public.qorpera_runner_assignments as assignment
		where assignment.id = v_job.client_lease_id and assignment.job_id = v_job.id
			and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
			and assignment.status = 'accepted'
	) or not exists (
		select 1
		from public.qorpera_object_reachability_graphs as graph
		where graph.root_kind = 'company_snapshot'
			and graph.root_id = v_snapshot.id
			and graph.status = 'complete'
			and graph.closure_verified
	) or exists (
		select 1
		from public.qorpera_artifact_index_entries as entry
		where entry.index_id = v_index.id
			and not exists (
				select 1
				from public.qorpera_object_reachability_graphs as graph
				where graph.root_kind = 'artifact'
					and graph.root_id = entry.artifact_id
					and graph.status = 'complete'
					and graph.closure_verified
			)
	) or (
		v_run.source_kind = 'proposal_review' and not exists (
			select 1
			from public.qorpera_object_reachability_graphs as graph
			where graph.root_kind = 'company_snapshot'
				and graph.root_id = v_proposal_snapshot.id
				and graph.status = 'complete'
				and graph.closure_verified
		)
	) then
		raise exception 'runner job substrate is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'job', public.qorpera_runner_job_json(v_job),
		'run', public.qorpera_execution_run_json(v_run),
		'sponsor', jsonb_build_object(
			'binding_id', v_sponsor.binding_id,
			'version', v_sponsor.version,
			'kind', v_sponsor.sponsor_kind,
			'provider_connection_id', v_connection.id,
			'provider_connection_version', v_sponsor.provider_connection_version,
			'provider', v_connection.provider,
			'authentication_mode', v_connection_version.authentication_mode,
			'native_harness', v_connection_version.native_harness,
			'allow_autonomous', v_sponsor.allow_autonomous
		),
		'version', public.qorpera_company_substrate_version_json(v_version),
		'snapshot', jsonb_build_object(
			'snapshot_id', v_snapshot.id,
			'profile_id', v_snapshot.profile_id,
			'environment_id', v_snapshot.environment_id,
			'workspace_id', v_snapshot.workspace_id,
			'client_snapshot_id', v_snapshot.client_snapshot_id,
			'parent_snapshot_id', v_snapshot.parent_snapshot_id,
			'tree_manifest_sha256', v_snapshot.tree_manifest_sha256,
			'tree_manifest_bytes', v_snapshot.tree_manifest_bytes,
			'tree_contract_version', v_snapshot.tree_contract_version,
			'file_count', v_snapshot.file_count,
			'total_bytes', v_snapshot.total_bytes,
			'created_by_user_id', v_snapshot.created_by_user_id,
			'created_at', v_snapshot.created_at
		),
		'proposal_snapshot', case
			when v_proposal_snapshot.id is null then 'null'::jsonb
			else public.qorpera_company_snapshot_json(v_proposal_snapshot)
		end,
		'artifact_index', case
			when v_index.id is null then 'null'::jsonb
			else public.qorpera_artifact_index_json(v_index)
		end,
		'output_limits', jsonb_build_object(
			'max_object_bytes', 8388608,
			'max_object_count', 100,
			'max_total_bytes', 67108864,
			'root_contract', 'qorpera.object/v1'
		),
		'company_file_output_limits', jsonb_build_object(
			'max_object_bytes', 8388608,
			'max_object_count', 50001::bigint
				+ ceiling(v_output_limit::numeric / 4194304)::bigint,
			'max_total_bytes', v_output_limit,
			'tree_contract_version', 3
		)
	);
end
$$;
