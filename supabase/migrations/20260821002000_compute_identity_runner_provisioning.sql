-- Service-authorized runner provisioning for cloud Compute Identities.
--
-- A managed provider may create a one-run physical worker without an online
-- member device. The immutable run remains the source of profile, identity,
-- template, policy, ownership, and capability authority; the provider only
-- supplies a client runner id, its adapter id, and a one-time activation hash.

insert into storage.buckets (id, name, public, file_size_limit)
values ('qorpera-native-compute-capsules', 'qorpera-native-compute-capsules', false, 67108864)
on conflict (id) do update
set public = false,
	file_size_limit = excluded.file_size_limit;

alter table public.qorpera_runners
	add column compute_identity_id uuid references public.qorpera_member_compute_identities(id) on delete restrict,
	add column worker_class text check (worker_class in ('managed_sandbox', 'company_computer')),
	add column provider_adapter text check (provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
	add column template_key text check (template_key ~ '^[a-z][a-z0-9._-]{0,119}$'),
	add column template_version text check (
		template_version is null
		or (char_length(btrim(template_version)) between 1 and 120 and template_version !~ E'[\r\n]')
	),
	add column compute_policy_sha256 text check (
		compute_policy_sha256 is null or compute_policy_sha256 ~ '^[0-9a-f]{64}$'
	);

create function public.qorpera_compute_policy_sha256(p_policy jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
	select encode(extensions.digest(convert_to(p_policy::text, 'utf8'), 'sha256'), 'hex')
$$;

revoke all on function public.qorpera_compute_policy_sha256(jsonb) from public;

create or replace function public.qorpera_runner_json(p_runner public.qorpera_runners)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'runner_id', p_runner.id,
		'profile_id', p_runner.profile_id,
		'client_runner_id', p_runner.client_runner_id,
		'display_name', p_runner.display_name,
		'runner_kind', p_runner.runner_kind,
		'capabilities', p_runner.capabilities,
		'max_concurrency', p_runner.max_concurrency,
		'status', p_runner.status,
		'online', p_runner.status = 'active' and p_runner.session_expires_at > statement_timestamp(),
		'platform', p_runner.platform,
		'runner_version', p_runner.runner_version,
		'logical_computer_id', p_runner.logical_computer_id,
		'compute_identity_id', p_runner.compute_identity_id,
		'worker_class', p_runner.worker_class,
		'provider_adapter', p_runner.provider_adapter,
		'template_key', p_runner.template_key,
		'template_version', p_runner.template_version,
		'compute_policy_sha256', p_runner.compute_policy_sha256,
		'activation_expires_at', p_runner.activation_expires_at,
		'session_expires_at', p_runner.session_expires_at,
		'registered_by_user_id', p_runner.registered_by_user_id,
		'created_at', p_runner.created_at,
		'activated_at', p_runner.activated_at,
		'last_seen_at', p_runner.last_seen_at,
		'revoked_by_user_id', p_runner.revoked_by_user_id,
		'revoked_at', p_runner.revoked_at,
		'active_lease_count', (
			select count(*)
			from public.qorpera_runner_jobs as job
			where job.runner_id = p_runner.id and job.status = 'leased'
				and job.lease_expires_at > statement_timestamp()
		)
	)
$$;

create function public.qorpera_provision_execution_runner(
	p_run_id uuid,
	p_client_runner_id uuid,
	p_provider_adapter text,
	p_activation_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
	v_runner public.qorpera_runners%rowtype;
	v_template_key text;
	v_template_version text;
	v_capabilities jsonb;
	v_policy jsonb;
	v_worker_class text;
begin
	if auth.role() <> 'service_role' or p_client_runner_id is null
		or coalesce(p_provider_adapter, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_activation_token_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'execution runner provisioning is invalid' using errcode = '42501';
	end if;
	select run.* into v_run
	from public.qorpera_execution_runs as run
	where run.id = p_run_id
	for share;
	if not found or v_run.compute_identity_id is null
		or v_run.deadline_at <= statement_timestamp()
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'execution compute authority is unavailable' using errcode = '42501';
	end if;
	select job.* into strict v_job
	from public.qorpera_runner_jobs as job
	where job.id = v_run.job_id and job.status = 'queued'
	for share;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_run.compute_identity_id
		and identity.profile_id = v_run.profile_id and identity.status = 'active'
	for share;
	if v_run.logical_computer_id is not null then
		select computer.* into strict v_computer
		from public.qorpera_logical_computers as computer
		where computer.id = v_run.logical_computer_id
			and computer.profile_id = v_run.profile_id
			and computer.compute_identity_id = v_identity.id
			and computer.status = 'active'
		for share;
		v_template_key := v_computer.template_key;
		v_template_version := v_computer.template_version;
		v_capabilities := v_computer.capabilities;
		v_policy := v_computer.policy;
		v_worker_class := v_computer.computer_class;
	else
		v_template_key := v_identity.template_key;
		v_template_version := v_identity.template_version;
		v_capabilities := v_identity.capabilities;
		v_policy := v_identity.policy;
		v_worker_class := v_run.worker_class;
	end if;
	if v_worker_class <> v_run.worker_class or not (v_capabilities ? v_run.required_capability) then
		raise exception 'execution compute template is incompatible' using errcode = '42501';
	end if;
	select runner.* into v_runner
	from public.qorpera_runners as runner
	where runner.profile_id = v_run.profile_id and runner.client_runner_id = p_client_runner_id
	for update;
	if found then
		if v_runner.runner_kind <> 'qorpera_computer'
			or v_runner.logical_computer_id is distinct from v_run.logical_computer_id
			or v_runner.compute_identity_id is distinct from v_identity.id
			or v_runner.worker_class is distinct from v_worker_class
			or v_runner.provider_adapter is distinct from p_provider_adapter
			or v_runner.template_key is distinct from v_template_key
			or v_runner.template_version is distinct from v_template_version
			or v_runner.compute_policy_sha256 is distinct from public.qorpera_compute_policy_sha256(v_policy)
			or v_runner.capabilities <> v_capabilities
			or v_runner.max_concurrency <> 1 then
			raise exception 'runner client id is already bound to other compute authority' using errcode = '23505';
		end if;
		if v_runner.status = 'pending' and v_runner.activation_expires_at <= statement_timestamp() then
			update public.qorpera_runners
			set activation_token_sha256 = p_activation_token_sha256,
				activation_expires_at = statement_timestamp() + interval '15 minutes'
			where id = v_runner.id
			returning * into v_runner;
		elsif v_runner.status = 'pending'
			and v_runner.activation_token_sha256 <> p_activation_token_sha256 then
			raise exception 'runner activation is already bound to another capability' using errcode = '23505';
		elsif v_runner.status = 'revoked' then
			raise exception 'execution runner is revoked' using errcode = '55000';
		end if;
		return public.qorpera_runner_json(v_runner);
	end if;
	insert into public.qorpera_runners (
		profile_id, client_runner_id, display_name, runner_kind, capabilities,
		max_concurrency, activation_token_sha256, activation_expires_at,
		registered_by_user_id, logical_computer_id, compute_identity_id,
		worker_class, provider_adapter, template_key, template_version,
		compute_policy_sha256
	) values (
		v_run.profile_id, p_client_runner_id,
		'Cloud worker ' || left(v_run.id::text, 8), 'qorpera_computer', v_capabilities,
		1, p_activation_token_sha256, statement_timestamp() + interval '15 minutes',
		v_run.requested_by_user_id, v_run.logical_computer_id, v_identity.id,
		v_worker_class, p_provider_adapter, v_template_key, v_template_version,
		public.qorpera_compute_policy_sha256(v_policy)
	) returning * into v_runner;
	perform public.qorpera_append_runner_audit(
		v_runner.profile_id, v_runner.id, v_job.id, 'runner_registered',
		jsonb_build_object(
			'run_id', v_run.id,
			'compute_identity_id', v_runner.compute_identity_id,
			'logical_computer_id', v_runner.logical_computer_id,
			'worker_class', v_runner.worker_class,
			'provider_adapter', v_runner.provider_adapter,
			'template_key', v_runner.template_key,
			'template_version', v_runner.template_version,
			'compute_policy_sha256', v_runner.compute_policy_sha256,
			'activation_expires_at', v_runner.activation_expires_at
		), v_run.requested_by_user_id
	);
	return public.qorpera_runner_json(v_runner);
end
$$;

create function public.qorpera_runner_assignment_compute_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_runner public.qorpera_runners%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
	v_template_key text;
	v_template_version text;
	v_policy jsonb;
	v_worker_class text;
begin
	select run.* into strict v_run
	from public.qorpera_execution_runs as run where run.id = new.run_id;
	if v_run.compute_identity_id is null then return new; end if;
	select runner.* into strict v_runner
	from public.qorpera_runners as runner where runner.id = new.runner_id;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_run.compute_identity_id and identity.status = 'active';
	if v_run.logical_computer_id is not null then
		select computer.* into strict v_computer
		from public.qorpera_logical_computers as computer
		where computer.id = v_run.logical_computer_id and computer.status = 'active';
		v_template_key := v_computer.template_key;
		v_template_version := v_computer.template_version;
		v_policy := v_computer.policy;
		v_worker_class := v_computer.computer_class;
	else
		v_template_key := v_identity.template_key;
		v_template_version := v_identity.template_version;
		v_policy := v_identity.policy;
		v_worker_class := v_run.worker_class;
	end if;
	if v_runner.runner_kind <> 'qorpera_computer'
		or v_runner.profile_id <> v_run.profile_id
		or v_runner.logical_computer_id is distinct from v_run.logical_computer_id
		or v_runner.compute_identity_id is distinct from v_run.compute_identity_id
		or v_runner.worker_class is distinct from v_worker_class
		or v_runner.template_key is distinct from v_template_key
		or v_runner.template_version is distinct from v_template_version
		or v_runner.compute_policy_sha256 is distinct from public.qorpera_compute_policy_sha256(v_policy) then
		raise exception 'runner does not attest the execution compute identity' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_runner_assignment_compute_guard
before insert on public.qorpera_runner_assignments
for each row execute function public.qorpera_runner_assignment_compute_guard();

create or replace function public.qorpera_execution_work_json(p_claim public.qorpera_runner_job_claims)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'claim_id', p_claim.id,
		'orchestrator_id', p_claim.orchestrator_id,
		'status', p_claim.status,
		'lease_expires_at', p_claim.lease_expires_at,
		'work', jsonb_build_object(
			'run_id', run.id,
			'job_id', job.id,
			'profile_id', run.profile_id,
			'environment_id', run.environment_id,
			'source_kind', run.source_kind,
			'source_id', run.source_id,
			'session_id', run.session_id,
			'substrate_version_id', run.substrate_version_id,
			'company_snapshot_id', run.company_snapshot_id,
			'staff_agent_id', run.staff_agent_id,
			'staff_version', run.staff_version,
			'input_ids', to_jsonb(run.input_ids),
			'required_capability', run.required_capability,
			'job_type', run.job_type,
			'payload', job.payload,
			'publication_mode', run.publication_mode,
			'review_policy_key', run.review_policy_key,
			'reviewer_staff_ids', to_jsonb(run.reviewer_staff_ids),
			'logical_computer_id', run.logical_computer_id,
			'compute_identity_id', run.compute_identity_id,
			'compute_identity_ownership_kind', identity.ownership_kind,
			'compute_identity_owner_user_id', identity.owner_user_id,
			'compute_identity_owner_scope_key', identity.owner_scope_key,
			'compute_template_key', coalesce(computer.template_key, identity.template_key),
			'compute_template_version', coalesce(computer.template_version, identity.template_version),
			'compute_policy_sha256', public.qorpera_compute_policy_sha256(coalesce(computer.policy, identity.policy)),
			'worker_class', run.worker_class,
			'requested_by_user_id', run.requested_by_user_id,
			'sponsored_by_user_id', run.sponsored_by_user_id,
			'transcript_start_sequence', run.transcript_start_sequence,
			'deadline_at', run.deadline_at,
			'attempt', job.attempt_count + 1,
			'sponsor', jsonb_build_object(
				'binding_id', sponsor.binding_id,
				'version', sponsor.version,
				'kind', sponsor.sponsor_kind,
				'provider_connection_id', connection.id,
				'provider_connection_version', sponsor.provider_connection_version,
				'provider', connection.provider,
				'authentication_mode', connection_version.authentication_mode,
				'native_harness', connection_version.native_harness,
				'allow_autonomous', sponsor.allow_autonomous
			),
			'model_policy', public.qorpera_runner_model_policy_json(model_policy)
		)
	)
	from public.qorpera_execution_runs as run
	join public.qorpera_runner_jobs as job on job.id = run.job_id
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.connection_id = sponsor.provider_connection_id
		and connection_version.version = sponsor.provider_connection_version
	join public.qorpera_runner_model_policies as model_policy on model_policy.job_id = job.id
	left join public.qorpera_member_compute_identities as identity on identity.id = run.compute_identity_id
	left join public.qorpera_logical_computers as computer on computer.id = run.logical_computer_id
	where run.id = p_claim.run_id
$$;

revoke all on function public.qorpera_provision_execution_runner(uuid, uuid, text, text) from public;
revoke all on function public.qorpera_runner_assignment_compute_guard() from public;
grant execute on function public.qorpera_provision_execution_runner(uuid, uuid, text, text) to service_role;

create function public.qorpera_describe_native_provider_login(
	p_login_id uuid,
	p_capability_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_login public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if auth.role() <> 'service_role' or p_capability_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'native provider login description is invalid' using errcode = '42501';
	end if;
	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.id = p_login_id and login.capability_sha256 = p_capability_sha256
		and login.status = 'pending' and login.expires_at > statement_timestamp()
	for update;
	if not found then
		raise exception 'native provider login is unavailable' using errcode = '55000';
	end if;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_login.compute_identity_id
		and identity.profile_id = v_login.profile_id and identity.status = 'active';
	return jsonb_build_object(
		'login_id', v_login.id,
		'profile_id', v_login.profile_id,
		'client_connection_id', v_login.client_connection_id,
		'compute_identity_id', v_identity.id,
		'compute_identity_ownership_kind', v_identity.ownership_kind,
		'compute_identity_owner_user_id', v_identity.owner_user_id,
		'compute_identity_owner_scope_key', v_identity.owner_scope_key,
		'provider', v_login.provider,
		'native_harness', v_login.native_harness,
		'expires_at', v_login.expires_at
	);
end
$$;

revoke all on function public.qorpera_describe_native_provider_login(uuid, text) from public;
grant execute on function public.qorpera_describe_native_provider_login(uuid, text) to service_role;

create function public.qorpera_native_run_model_authority(
	p_run_id uuid,
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_policy public.qorpera_runner_model_policies%rowtype;
	v_model jsonb;
begin
	if auth.role() <> 'service_role' then
		raise exception 'native model authority requires runner broker authority' using errcode = '42501';
	end if;
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if v_job.run_id is distinct from p_run_id then
		raise exception 'native model authority names another run' using errcode = '42501';
	end if;
	select policy.* into strict v_policy
	from public.qorpera_runner_model_policies as policy
	where policy.job_id = p_job_id;
	v_model := v_policy.allowed_models -> 0;
	if jsonb_array_length(v_policy.allowed_models) <> 1
		or coalesce(v_model ->> 'provider', '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(btrim(coalesce(v_model ->> 'model', ''))) not between 1 and 160 then
		raise exception 'native model authority is invalid' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'provider', v_model ->> 'provider',
		'model', v_model ->> 'model',
		'max_calls', v_policy.max_calls,
		'max_input_tokens', v_policy.max_input_tokens,
		'max_output_tokens', v_policy.max_output_tokens,
		'max_cost_microusd', v_policy.max_cost_microusd
	);
end
$$;

revoke all on function public.qorpera_native_run_model_authority(uuid, uuid, text, uuid, text) from public;
grant execute on function public.qorpera_native_run_model_authority(uuid, uuid, text, uuid, text) to service_role;
