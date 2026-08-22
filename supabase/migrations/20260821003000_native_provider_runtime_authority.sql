-- Runtime authority for provider-native subscription execution.
--
-- The runner renews the exclusive provider-connection lease while the native
-- harness is active. The native provider host independently validates the
-- complete run/runner/assignment/capsule tuple before decrypting a capsule and
-- while the harness is running. Service-role callers receive authority state,
-- never provider credential material.

create function public.qorpera_renew_native_provider_connection_lease(
	p_lease_id uuid,
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_seconds not between 30 and 900 then
		raise exception 'native provider lease renewal is invalid' using errcode = '42501';
	end if;
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select lease.* into v_lease
	from public.qorpera_native_provider_connection_leases as lease
	where lease.id = p_lease_id and lease.job_id = v_job.id
		and lease.runner_id = p_runner_id
		and lease.lease_token_sha256 = p_lease_token_sha256
	for update;
	if not found or v_lease.status <> 'active'
		or v_lease.expires_at <= statement_timestamp() then
		raise exception 'native provider lease is unavailable' using errcode = '55000';
	end if;
	select run.* into strict v_run
	from public.qorpera_execution_runs as run
	where run.id = v_lease.run_id and run.job_id = v_job.id;
	if not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run)
		or not exists (
			select 1
			from public.qorpera_execution_sponsor_versions as sponsor
			join public.qorpera_provider_connections as connection
				on connection.id = sponsor.provider_connection_id
			join public.qorpera_provider_connection_versions as version
				on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			join public.qorpera_native_credential_capsules as capsule
				on capsule.id = version.credential_capsule_id
			join public.qorpera_member_compute_identities as identity
				on identity.id = v_run.compute_identity_id
			join public.qorpera_provider_execution_policies as policy
				on policy.provider = connection.provider
				and policy.authentication_mode = 'native_subscription'
				and policy.native_harness = version.native_harness
			where sponsor.binding_id = v_run.sponsor_binding_id
				and sponsor.version = v_run.sponsor_version
				and sponsor.provider_connection_id = v_lease.provider_connection_id
				and sponsor.provider_connection_version = v_lease.provider_connection_version
				and connection.status = 'active'
				and version.authentication_mode = 'native_subscription'
				and version.authorization_state = 'active'
				and capsule.id = v_lease.credential_capsule_id
				and capsule.compute_identity_id = v_lease.compute_identity_id
				and capsule.status = 'active'
				and identity.status = 'active'
				and policy.implementation_status = 'supported'
				and policy.enablement_status = 'enabled'
		) then
		raise exception 'native provider authority was revoked' using errcode = '42501';
	end if;
	update public.qorpera_native_provider_connection_leases
	set expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds)
	where id = v_lease.id
	returning * into v_lease;
	return jsonb_build_object(
		'lease_id', v_lease.id,
		'run_id', v_lease.run_id,
		'status', v_lease.status,
		'expires_at', v_lease.expires_at
	);
end
$$;

create function public.qorpera_validate_native_provider_execution_lease(
	p_lease_id uuid,
	p_run_id uuid,
	p_job_id uuid,
	p_runner_id uuid,
	p_assignment_id uuid,
	p_credential_capsule_id uuid,
	p_compute_identity_id uuid,
	p_provider text,
	p_native_harness text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'native provider host authority is required' using errcode = '42501';
	end if;
	select run.* into v_run
	from public.qorpera_execution_runs as run
	where run.id = p_run_id and run.job_id = p_job_id
	for share;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.run_id = p_run_id
	for share;
	select lease.* into v_lease
	from public.qorpera_native_provider_connection_leases as lease
	where lease.id = p_lease_id
		and lease.run_id = p_run_id and lease.job_id = p_job_id
		and lease.runner_id = p_runner_id and lease.assignment_id = p_assignment_id
		and lease.credential_capsule_id = p_credential_capsule_id
		and lease.compute_identity_id = p_compute_identity_id
	for share;
	if v_run.id is null or v_job.id is null or v_lease.id is null
		or v_job.status <> 'leased' or v_job.runner_id <> p_runner_id
		or v_job.client_lease_id <> p_assignment_id
		or v_job.lease_expires_at <= statement_timestamp()
		or v_lease.status <> 'active' or v_lease.expires_at <= statement_timestamp()
		or v_run.compute_identity_id is distinct from p_compute_identity_id
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run)
		or not exists (
			select 1
			from public.qorpera_runner_assignments as assignment
			join public.qorpera_execution_sponsor_versions as sponsor
				on sponsor.binding_id = v_run.sponsor_binding_id
				and sponsor.version = v_run.sponsor_version
			join public.qorpera_provider_connections as connection
				on connection.id = sponsor.provider_connection_id
			join public.qorpera_provider_connection_versions as version
				on version.connection_id = sponsor.provider_connection_id
				and version.version = sponsor.provider_connection_version
			join public.qorpera_native_credential_capsules as capsule
				on capsule.id = version.credential_capsule_id
			join public.qorpera_member_compute_identities as identity
				on identity.id = v_run.compute_identity_id
			join public.qorpera_provider_execution_policies as policy
				on policy.provider = connection.provider
				and policy.authentication_mode = 'native_subscription'
				and policy.native_harness = version.native_harness
			where assignment.id = p_assignment_id
				and assignment.run_id = p_run_id and assignment.job_id = p_job_id
				and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
				and assignment.expires_at > statement_timestamp()
				and sponsor.provider_connection_id = v_lease.provider_connection_id
				and sponsor.provider_connection_version = v_lease.provider_connection_version
				and connection.provider = p_provider and connection.status = 'active'
				and version.authentication_mode = 'native_subscription'
				and version.native_harness = p_native_harness
				and version.authorization_state = 'active'
				and capsule.id = p_credential_capsule_id and capsule.status = 'active'
				and capsule.compute_identity_id = p_compute_identity_id
				and identity.status = 'active'
				and policy.implementation_status = 'supported'
				and policy.enablement_status = 'enabled'
		) then
		raise exception 'native provider execution authority is unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'lease_id', v_lease.id,
		'run_id', v_lease.run_id,
		'job_id', v_lease.job_id,
		'runner_id', v_lease.runner_id,
		'assignment_id', v_lease.assignment_id,
		'credential_capsule_id', v_lease.credential_capsule_id,
		'compute_identity_id', v_lease.compute_identity_id,
		'status', v_lease.status,
		'expires_at', v_lease.expires_at
	);
end
$$;

create function public.qorpera_revoke_native_provider_connection(
	p_profile_id uuid,
	p_connection_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_connection public.qorpera_provider_connections%rowtype;
	v_capsules uuid[];
begin
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = p_connection_id and connection.profile_id = p_profile_id
		and connection.owner_user_id = v_user_id
	for update;
	if v_user_id is null or not found then
		raise exception 'native provider connection is unavailable' using errcode = '42501';
	end if;
	select coalesce(array_agg(version.credential_capsule_id), '{}'::uuid[]) into v_capsules
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_connection.id
		and version.authentication_mode = 'native_subscription'
		and version.credential_capsule_id is not null;
	perform public.qorpera_set_provider_connection_status(p_profile_id, v_connection.id, 'revoked');
	update public.qorpera_provider_connection_versions
	set authorization_state = 'revoked'
	where connection_id = v_connection.id and authentication_mode = 'native_subscription'
		and authorization_state <> 'revoked';
	update public.qorpera_native_credential_capsules
	set status = 'revoked', revoked_at = coalesce(revoked_at, statement_timestamp())
	where id = any(v_capsules) and status <> 'revoked';
	update public.qorpera_native_provider_connection_leases
	set status = 'revoked', released_at = statement_timestamp()
	where provider_connection_id = v_connection.id and status = 'active';
	return jsonb_build_object(
		'connection_id', v_connection.id,
		'status', 'revoked',
		'revoked_capsule_count', cardinality(v_capsules)
	);
end
$$;

revoke all on function public.qorpera_renew_native_provider_connection_lease(uuid, uuid, text, uuid, text, integer) from public;
revoke all on function public.qorpera_validate_native_provider_execution_lease(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) from public;
revoke all on function public.qorpera_revoke_native_provider_connection(uuid, uuid) from public;
grant execute on function public.qorpera_renew_native_provider_connection_lease(uuid, uuid, text, uuid, text, integer) to service_role;
grant execute on function public.qorpera_validate_native_provider_execution_lease(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.qorpera_revoke_native_provider_connection(uuid, uuid) to authenticated;
