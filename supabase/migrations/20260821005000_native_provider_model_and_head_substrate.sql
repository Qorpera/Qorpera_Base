-- Pin provider-specific model authority on every execution run and keep every
-- canonical Company File head independently runnable. Native subscription
-- turns may deliberately use the provider harness default; non-native model
-- traffic still requires an explicit staff/provider mapping.

create table public.qorpera_staff_provider_models (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	staff_agent_id uuid not null,
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	model_id text not null check (
		char_length(btrim(model_id)) between 1 and 256
		and model_id <> 'provider-default'
		and model_id !~ E'[\r\n]'
	),
	version bigint not null default 1 check (version > 0),
	configured_by_user_id uuid not null references auth.users(id) on delete restrict,
	configured_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, staff_agent_id, provider),
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete restrict
);

alter table public.qorpera_staff_provider_models enable row level security;
revoke all on public.qorpera_staff_provider_models from anon, authenticated;

insert into public.qorpera_staff_provider_models (
	profile_id, staff_agent_id, provider, model_id, configured_by_user_id, configured_at
)
select staff.profile_id, staff.staff_agent_id, staff.model_provider, staff.model_id,
	staff.updated_by_user_id, staff.updated_at
from public.qorpera_profile_staff as staff
where staff.model_provider is not null and staff.model_id is not null
on conflict do nothing;

create function public.qorpera_sync_staff_primary_provider_model()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.model_provider is not null and new.model_id is not null then
		insert into public.qorpera_staff_provider_models (
			profile_id, staff_agent_id, provider, model_id, configured_by_user_id, configured_at
		) values (
			new.profile_id, new.staff_agent_id, new.model_provider, new.model_id,
			new.updated_by_user_id, new.updated_at
		)
		on conflict (profile_id, staff_agent_id, provider) do update
		set model_id = excluded.model_id,
			version = public.qorpera_staff_provider_models.version + 1,
			configured_by_user_id = excluded.configured_by_user_id,
			configured_at = excluded.configured_at
		where public.qorpera_staff_provider_models.model_id <> excluded.model_id;
	end if;
	return new;
end
$$;

create trigger qorpera_profile_staff_provider_model
after insert or update of model_provider, model_id on public.qorpera_profile_staff
for each row execute function public.qorpera_sync_staff_primary_provider_model();

create function public.qorpera_put_staff_provider_model(
	p_profile_id uuid,
	p_staff_agent_id uuid,
	p_provider text,
	p_model_id text,
	p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_current public.qorpera_staff_provider_models%rowtype;
	v_result public.qorpera_staff_provider_models%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'staff provider model requires company write access' using errcode = '42501';
	end if;
	if p_staff_agent_id is null
		or coalesce(p_provider, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(btrim(coalesce(p_model_id, ''))) not between 1 and 256
		or p_model_id <> btrim(p_model_id)
		or p_model_id = 'provider-default'
		or p_model_id ~ E'[\r\n]'
		or not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
				and staff.employment_status = 'active'
		) then
		raise exception 'staff provider model is invalid' using errcode = '22023';
	end if;
	select mapping.* into v_current
	from public.qorpera_staff_provider_models as mapping
	where mapping.profile_id = p_profile_id and mapping.staff_agent_id = p_staff_agent_id
		and mapping.provider = p_provider
	for update;
	if not found then
		if p_expected_version is not null then
			raise exception 'staff provider model version conflict' using errcode = '40001';
		end if;
		insert into public.qorpera_staff_provider_models (
			profile_id, staff_agent_id, provider, model_id, configured_by_user_id
		) values (
			p_profile_id, p_staff_agent_id, p_provider, p_model_id, v_user_id
		) returning * into v_result;
	elsif p_expected_version is null then
		if v_current.model_id <> p_model_id then
			raise exception 'staff provider model version conflict' using errcode = '40001';
		end if;
		v_result := v_current;
	elsif v_current.version <> p_expected_version then
		raise exception 'staff provider model version conflict' using errcode = '40001';
	else
		update public.qorpera_staff_provider_models
		set model_id = p_model_id,
			version = version + 1,
			configured_by_user_id = v_user_id,
			configured_at = statement_timestamp()
		where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id
			and provider = p_provider
		returning * into v_result;
	end if;
	return jsonb_build_object(
		'profile_id', v_result.profile_id,
		'staff_agent_id', v_result.staff_agent_id,
		'provider', v_result.provider,
		'model_id', v_result.model_id,
		'version', v_result.version,
		'configured_by_user_id', v_result.configured_by_user_id,
		'configured_at', v_result.configured_at
	);
end
$$;

revoke all on function public.qorpera_put_staff_provider_model(uuid, uuid, text, text, bigint) from public;
grant execute on function public.qorpera_put_staff_provider_model(uuid, uuid, text, text, bigint) to authenticated;

alter table public.qorpera_execution_runs
	add column model_provider text check (model_provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	add column model_id text check (
		model_id is null or (
			char_length(btrim(model_id)) between 1 and 256 and model_id !~ E'[\r\n]'
		)
	),
	add column model_selection text check (
		model_selection is null or model_selection in ('provider_mapping', 'provider_default')
	),
	add column model_mapping_version bigint check (model_mapping_version is null or model_mapping_version > 0);

create function public.qorpera_execution_run_model_authority()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_staff public.qorpera_profile_staff%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_mapping public.qorpera_staff_provider_models%rowtype;
begin
	select staff.* into strict v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = new.profile_id and staff.staff_agent_id = new.staff_agent_id
		and staff.version = new.staff_version and staff.employment_status = 'active';
	select connection.* into strict v_connection
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connections as connection
		on connection.id = sponsor.provider_connection_id
	where sponsor.binding_id = new.sponsor_binding_id and sponsor.version = new.sponsor_version
		and connection.profile_id = new.profile_id;
	select version.* into strict v_connection_version
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connection_versions as version
		on version.connection_id = sponsor.provider_connection_id
		and version.version = sponsor.provider_connection_version
	where sponsor.binding_id = new.sponsor_binding_id and sponsor.version = new.sponsor_version;
	select mapping.* into v_mapping
	from public.qorpera_staff_provider_models as mapping
	where mapping.profile_id = new.profile_id and mapping.staff_agent_id = new.staff_agent_id
		and mapping.provider = v_connection.provider;
	new.model_provider := v_connection.provider;
	if found then
		new.model_id := v_mapping.model_id;
		new.model_selection := 'provider_mapping';
		new.model_mapping_version := v_mapping.version;
	elsif v_connection_version.authentication_mode = 'native_subscription' then
		new.model_id := 'provider-default';
		new.model_selection := 'provider_default';
		new.model_mapping_version := null;
	else
		raise exception 'staff has no model authority for the selected provider' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_execution_run_model_authority
before insert on public.qorpera_execution_runs
for each row execute function public.qorpera_execution_run_model_authority();

with authority as (
	select run.id as run_id, connection.provider,
		coalesce(policy_model.model_id, mapping.model_id, case
			when connection_version.authentication_mode = 'native_subscription' then 'provider-default'
			when staff.model_provider = connection.provider then staff.model_id
		end) as model_id,
		case
			when coalesce(policy_model.model_id, mapping.model_id) = 'provider-default'
				or (policy_model.model_id is null and mapping.model_id is null
					and connection_version.authentication_mode = 'native_subscription')
				then 'provider_default'
			else 'provider_mapping'
		end as model_selection,
		case when policy_model.model_id is null then mapping.version end as model_mapping_version
	from public.qorpera_execution_runs as run
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.connection_id = sponsor.provider_connection_id
		and connection_version.version = sponsor.provider_connection_version
	join public.qorpera_profile_staff as staff on staff.profile_id = run.profile_id
		and staff.staff_agent_id = run.staff_agent_id
	left join public.qorpera_staff_provider_models as mapping on mapping.profile_id = run.profile_id
		and mapping.staff_agent_id = run.staff_agent_id and mapping.provider = connection.provider
	left join lateral (
		select allowed.value ->> 'model' as model_id
		from public.qorpera_runner_model_policies as policy
		cross join lateral jsonb_array_elements(policy.allowed_models)
			with ordinality as allowed(value, ordinality)
		where policy.job_id = run.job_id
			and allowed.value ->> 'provider' = connection.provider
			and char_length(coalesce(allowed.value ->> 'model', '')) between 1 and 256
		order by allowed.ordinality
		limit 1
	) as policy_model on true
)
update public.qorpera_execution_runs as run
set model_provider = authority.provider,
	model_id = authority.model_id,
	model_selection = authority.model_selection,
	model_mapping_version = authority.model_mapping_version
from authority where authority.run_id = run.id;

alter table public.qorpera_execution_runs
	alter column model_provider set not null,
	alter column model_id set not null,
	alter column model_selection set not null;

create or replace function public.qorpera_execution_run_json(p_run public.qorpera_execution_runs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'run_id', p_run.id,
		'profile_id', p_run.profile_id,
		'environment_id', p_run.environment_id,
		'source_kind', p_run.source_kind,
		'source_id', p_run.source_id,
		'session_id', p_run.session_id,
		'job_id', p_run.job_id,
		'substrate_version_id', p_run.substrate_version_id,
		'company_snapshot_id', p_run.company_snapshot_id,
		'staff_agent_id', p_run.staff_agent_id,
		'staff_version', p_run.staff_version,
		'model_provider', p_run.model_provider,
		'model_id', p_run.model_id,
		'model_selection', p_run.model_selection,
		'model_mapping_version', p_run.model_mapping_version,
		'input_ids', to_jsonb(p_run.input_ids),
		'sponsor_binding_id', p_run.sponsor_binding_id,
		'sponsor_version', p_run.sponsor_version,
		'required_capability', p_run.required_capability,
		'job_type', p_run.job_type,
		'payload_sha256', p_run.payload_sha256,
		'publication_mode', p_run.publication_mode,
		'review_policy_key', p_run.review_policy_key,
		'reviewer_staff_ids', to_jsonb(p_run.reviewer_staff_ids),
		'logical_computer_id', p_run.logical_computer_id,
		'compute_identity_id', p_run.compute_identity_id,
		'compute_identity_ownership_kind', (
			select identity.ownership_kind from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'compute_identity_owner_user_id', (
			select identity.owner_user_id from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'compute_identity_owner_scope_key', (
			select identity.owner_scope_key from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'worker_class', p_run.worker_class,
		'requested_by_user_id', p_run.requested_by_user_id,
		'sponsored_by_user_id', p_run.sponsored_by_user_id,
		'transcript_start_sequence', p_run.transcript_start_sequence,
		'status', coalesce((
			select event.event_type from public.qorpera_execution_run_events as event
			where event.run_id = p_run.id order by event.id desc limit 1
		), 'queued'),
		'created_by_user_id', p_run.created_by_user_id,
		'created_at', p_run.created_at,
		'deadline_at', p_run.deadline_at
	)
$$;

create or replace function public.qorpera_reserve_execution_sponsor_authority(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_existing public.qorpera_execution_sponsor_reservations%rowtype;
	v_period_start timestamptz := date_trunc('month', statement_timestamp());
	v_monthly bigint;
	v_reservation bigint;
	v_max_concurrent integer;
	v_reserved_total bigint;
	v_actual_total bigint;
	v_active integer;
begin
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	select reservation.* into v_existing
	from public.qorpera_execution_sponsor_reservations as reservation where reservation.run_id = v_run.id;
	if found then
		return v_existing.job_id = v_run.job_id and v_existing.binding_id = v_run.sponsor_binding_id
			and v_existing.sponsor_version = v_run.sponsor_version;
	end if;
	select binding.* into v_binding
	from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = v_run.sponsor_binding_id and binding.profile_id = v_run.profile_id
		and binding.status = 'active';
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id
		and connection.profile_id = v_run.profile_id and connection.status = 'active'
	for update;
	select version.* into v_connection_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_sponsor.provider_connection_id
		and version.version = v_sponsor.provider_connection_version
	for update;
	select staff.* into v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id
		and staff.version = v_run.staff_version and staff.employment_status = 'active';
	if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
		or v_connection_version.connection_id is null or v_staff.staff_agent_id is null
		or v_run.model_provider is distinct from v_connection.provider or v_run.model_id is null
		or (v_run.model_id = 'provider-default'
			and v_connection_version.authentication_mode <> 'native_subscription')
		or (v_sponsor.sponsor_kind = 'member_connection' and not exists (
			select 1 from public.qorpera_profile_members as member
			where member.profile_id = v_run.profile_id and member.user_id = v_connection.owner_user_id
		)) or not public.qorpera_provider_quota_policy_valid(v_connection_version.quota_policy) then
		return false;
	end if;
	v_monthly := (v_connection_version.quota_policy ->> 'monthly_microusd')::bigint;
	v_reservation := (v_connection_version.quota_policy ->> 'reservation_microusd')::bigint;
	v_max_concurrent := (v_connection_version.quota_policy ->> 'max_concurrent_runs')::integer;
	select count(*) filter (where reservation.status = 'reserved'),
		coalesce(sum(reservation.reserved_microusd) filter (where reservation.status = 'reserved'), 0),
		coalesce(sum(reservation.actual_microusd) filter (where reservation.status = 'settled'), 0)
	into v_active, v_reserved_total, v_actual_total
	from public.qorpera_execution_sponsor_reservations as reservation
	where reservation.provider_connection_id = v_connection.id
		and reservation.period_start = v_period_start;
	if v_active >= v_max_concurrent or v_reserved_total + v_actual_total + v_reservation > v_monthly then
		return false;
	end if;
	insert into public.qorpera_execution_sponsor_reservations (
		run_id, job_id, profile_id, binding_id, sponsor_version,
		provider_connection_id, provider_connection_version, period_start, reserved_microusd
	) values (
		v_run.id, v_run.job_id, v_run.profile_id, v_sponsor.binding_id, v_sponsor.version,
		v_connection.id, v_connection_version.version, v_period_start, v_reservation
	);
	insert into public.qorpera_execution_run_budgets (run_id) values (v_run.id);
	insert into public.qorpera_runner_model_policies (
		job_id, profile_id, environment_id, allowed_models, max_calls,
		max_input_tokens, max_output_tokens, max_cost_microusd, authorized_by_user_id
	) values (
		v_run.job_id, v_run.profile_id, v_run.environment_id,
		jsonb_build_array(jsonb_build_object('provider', v_run.model_provider, 'model', v_run.model_id)),
		(v_connection_version.quota_policy ->> 'max_calls_per_run')::integer,
		(v_connection_version.quota_policy ->> 'max_input_tokens_per_run')::bigint,
		(v_connection_version.quota_policy ->> 'max_output_tokens_per_run')::bigint,
		v_reservation, v_sponsor.created_by_user_id
	);
	return true;
end
$$;

create function public.qorpera_ensure_current_company_substrate(
	p_profile_id uuid,
	p_environment_id uuid,
	p_snapshot_id uuid,
	p_artifact_index_id uuid,
	p_created_by_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_artifact_index public.qorpera_artifact_indexes%rowtype;
	v_existing public.qorpera_company_substrate_versions%rowtype;
	v_operation_sequence bigint := 0;
	v_operation_count bigint := 0;
	v_artifact_manifest_sha256 text;
	v_content_sha256 text;
	v_version_id uuid;
begin
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.environment_id = p_environment_id
	for update;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_snapshot_id and snapshot.profile_id = p_profile_id
		and snapshot.environment_id = p_environment_id;
	if v_file.environment_id is null or v_snapshot.id is null
		or v_file.head_snapshot_id is distinct from p_snapshot_id
		or p_created_by_user_id is null
		or not exists (
			select 1 from public.qorpera_company_snapshot_publications as publication
			where publication.snapshot_id = p_snapshot_id and publication.status = 'published'
		) then
		raise exception 'current Company File substrate authority is invalid' using errcode = '55000';
	end if;
	if p_artifact_index_id is not null then
		select artifact_index.* into v_artifact_index
		from public.qorpera_artifact_indexes as artifact_index
		where artifact_index.id = p_artifact_index_id
			and artifact_index.profile_id = p_profile_id
			and artifact_index.environment_id = p_environment_id;
		if not found then
			raise exception 'current Company File artifact index is invalid' using errcode = '55000';
		end if;
		v_artifact_manifest_sha256 := v_artifact_index.content_sha256;
	end if;
	select clock.last_sequence into v_operation_sequence
	from public.qorpera_profile_operation_clocks as clock where clock.profile_id = p_profile_id;
	v_operation_sequence := coalesce(v_operation_sequence, 0);
	select count(*) into v_operation_count
	from public.qorpera_company_operations as operation
	where operation.profile_id = p_profile_id and operation.sequence <= v_operation_sequence
		and (operation.environment_id is null or operation.environment_id = p_environment_id);
	select version.* into v_existing
	from public.qorpera_company_substrate_versions as version
	where version.profile_id = p_profile_id and version.environment_id = p_environment_id
		and version.company_snapshot_id = p_snapshot_id
		and version.operation_sequence = v_operation_sequence
		and version.operation_count = v_operation_count
		and version.artifact_index_id is not distinct from p_artifact_index_id
	order by version.created_at desc, version.id desc
	limit 1;
	if found then return v_existing.id; end if;
	v_content_sha256 := encode(extensions.digest(convert_to(jsonb_build_object(
		'contract_version', 1,
		'profile_id', p_profile_id,
		'environment_id', p_environment_id,
		'company_snapshot_id', p_snapshot_id,
		'operation_sequence', v_operation_sequence,
		'artifact_manifest_sha256', v_artifact_manifest_sha256
	)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_company_substrate_versions (
		profile_id, environment_id, company_snapshot_id, client_version_id,
		contract_version, operation_sequence, operation_count, artifact_index_id,
		artifact_manifest_sha256, content_sha256, created_by_user_id
	) values (
		p_profile_id, p_environment_id, p_snapshot_id, extensions.gen_random_uuid(),
		1, v_operation_sequence, v_operation_count, p_artifact_index_id,
		v_artifact_manifest_sha256, v_content_sha256, p_created_by_user_id
	) returning id into v_version_id;
	return v_version_id;
end
$$;

create function public.qorpera_company_head_substrate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_artifact_index_id uuid;
	v_created_by_user_id uuid;
begin
	if new.head_snapshot_id is null or (
		tg_op = 'UPDATE' and new.head_snapshot_id is not distinct from old.head_snapshot_id
	) then
		return new;
	end if;
	if not exists (
		select 1 from public.qorpera_company_snapshot_publications as publication
		where publication.snapshot_id = new.head_snapshot_id and publication.status = 'published'
	) then
		return new;
	end if;
	select snapshot.created_by_user_id into strict v_created_by_user_id
	from public.qorpera_company_snapshots as snapshot where snapshot.id = new.head_snapshot_id;
	select version.artifact_index_id into v_artifact_index_id
	from public.qorpera_company_substrate_versions as version
	where version.profile_id = new.profile_id and version.environment_id = new.environment_id
		and version.company_snapshot_id in (new.head_snapshot_id, case when tg_op = 'UPDATE' then old.head_snapshot_id else null end)
	order by (version.company_snapshot_id = new.head_snapshot_id) desc,
		version.created_at desc, version.id desc
	limit 1;
	perform public.qorpera_ensure_current_company_substrate(
		new.profile_id, new.environment_id, new.head_snapshot_id,
		v_artifact_index_id, v_created_by_user_id
	);
	return new;
end
$$;

create trigger qorpera_company_head_substrate
after insert or update of head_snapshot_id on public.qorpera_company_files
for each row execute function public.qorpera_company_head_substrate();

create function public.qorpera_staff_current_head_substrate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_artifact_index_id uuid;
begin
	for v_file in
		select file.* from public.qorpera_company_files as file
		where file.profile_id = new.profile_id and file.head_snapshot_id is not null
			and exists (
				select 1 from public.qorpera_company_snapshot_publications as publication
				where publication.snapshot_id = file.head_snapshot_id and publication.status = 'published'
			)
	loop
		select version.artifact_index_id into v_artifact_index_id
		from public.qorpera_company_substrate_versions as version
		where version.profile_id = v_file.profile_id and version.environment_id = v_file.environment_id
			and version.company_snapshot_id = v_file.head_snapshot_id
		order by version.created_at desc, version.id desc limit 1;
		perform public.qorpera_ensure_current_company_substrate(
			v_file.profile_id, v_file.environment_id, v_file.head_snapshot_id,
			v_artifact_index_id, new.updated_by_user_id
		);
	end loop;
	return new;
end
$$;

create trigger qorpera_profile_staff_refresh_current_substrate
after insert or update on public.qorpera_profile_staff
for each row execute function public.qorpera_staff_current_head_substrate();

create function public.qorpera_runner_completed_head_substrate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_snapshot_id uuid;
	v_artifact_index_id uuid;
begin
	if new.status <> 'completed' or new.run_id is null
		or (old.status = 'completed' and new.output_artifact_index_id is not distinct from old.output_artifact_index_id) then
		return new;
	end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = new.run_id;
	select output.snapshot_id into v_snapshot_id
	from public.qorpera_runner_company_revision_outputs as output
	join public.qorpera_company_snapshot_publications as publication
		on publication.snapshot_id = output.snapshot_id and publication.status = 'published'
	join public.qorpera_company_files as file on file.profile_id = v_run.profile_id
		and file.environment_id = v_run.environment_id and file.head_snapshot_id = output.snapshot_id
	where output.run_id = v_run.id and output.job_id = new.id
	order by output.created_at desc limit 1;
	if v_snapshot_id is null then return new; end if;
	v_artifact_index_id := new.output_artifact_index_id;
	if v_artifact_index_id is null then
		select version.artifact_index_id into v_artifact_index_id
		from public.qorpera_company_substrate_versions as version
		where version.profile_id = v_run.profile_id and version.environment_id = v_run.environment_id
			and version.company_snapshot_id = v_snapshot_id
		order by version.created_at desc, version.id desc limit 1;
	end if;
	perform public.qorpera_ensure_current_company_substrate(
		v_run.profile_id, v_run.environment_id, v_snapshot_id,
		v_artifact_index_id, v_run.created_by_user_id
	);
	return new;
end
$$;

create trigger qorpera_runner_completed_head_substrate
after update of status, output_artifact_index_id on public.qorpera_runner_jobs
for each row execute function public.qorpera_runner_completed_head_substrate();

revoke all on function public.qorpera_execution_run_model_authority() from public;
revoke all on function public.qorpera_sync_staff_primary_provider_model() from public;
revoke all on function public.qorpera_ensure_current_company_substrate(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function public.qorpera_company_head_substrate() from public;
revoke all on function public.qorpera_staff_current_head_substrate() from public;
revoke all on function public.qorpera_runner_completed_head_substrate() from public;

do $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_artifact_index_id uuid;
	v_created_by_user_id uuid;
begin
	for v_file in
		select file.* from public.qorpera_company_files as file
		where file.head_snapshot_id is not null and exists (
			select 1 from public.qorpera_company_snapshot_publications as publication
			where publication.snapshot_id = file.head_snapshot_id and publication.status = 'published'
		)
	loop
		select version.artifact_index_id into v_artifact_index_id
		from public.qorpera_company_substrate_versions as version
		where version.profile_id = v_file.profile_id and version.environment_id = v_file.environment_id
			and version.company_snapshot_id = v_file.head_snapshot_id
		order by version.created_at desc, version.id desc limit 1;
		select snapshot.created_by_user_id into strict v_created_by_user_id
		from public.qorpera_company_snapshots as snapshot where snapshot.id = v_file.head_snapshot_id;
		perform public.qorpera_ensure_current_company_substrate(
			v_file.profile_id, v_file.environment_id, v_file.head_snapshot_id,
			v_artifact_index_id, v_created_by_user_id
		);
	end loop;
end
$$;
