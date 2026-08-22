-- Native subscription execution and durable cloud-compute identity.
--
-- Provider credentials never cross this application/control-plane boundary.
-- An authorized member completes the provider's official login inside an
-- isolated member, company, department, or security-boundary cloud computer.
-- The resulting native credential store is sealed into an opaque capsule by
-- the runner provider. Supabase records only identity, consent, policy,
-- capsule metadata, and short-lived lease hashes.
-- This is not a claim of cryptographic infrastructure-operator blindness:
-- until confidential, attested compute is deployed, the infrastructure
-- operator may technically retain administrative access to a physical VM.

create table public.qorpera_provider_execution_policies (
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	authentication_mode text not null check (authentication_mode in (
		'native_subscription', 'enterprise_access_token', 'api_key', 'cloud_service_account'
	)),
	native_harness text not null check (
		char_length(btrim(native_harness)) between 1 and 120 and native_harness !~ E'[\r\n]'
	),
	implementation_status text not null check (implementation_status in ('planned', 'supported', 'retired')),
	enablement_status text not null check (enablement_status in ('disabled', 'enabled')),
	max_native_concurrency integer not null default 1 check (max_native_concurrency between 1 and 64),
	policy_version bigint not null default 1 check (policy_version > 0),
	disabled_reason text check (
		disabled_reason is null or char_length(btrim(disabled_reason)) between 1 and 1000
	),
	commercial_reference text check (
		commercial_reference is null
		or (char_length(btrim(commercial_reference)) between 1 and 512
			and commercial_reference !~ E'[\r\n]')
	),
	updated_by_user_id uuid references auth.users(id) on delete restrict,
	updated_at timestamptz not null default statement_timestamp(),
	primary key (provider, authentication_mode, native_harness),
	check (enablement_status <> 'enabled' or implementation_status = 'supported'),
	check ((enablement_status = 'disabled') = (disabled_reason is not null))
);

insert into public.qorpera_provider_execution_policies (
	provider, authentication_mode, native_harness, implementation_status,
	enablement_status, disabled_reason
) values
	(
		'openai', 'native_subscription', 'codex-cli', 'supported', 'enabled', null
	),
	(
		'anthropic', 'native_subscription', 'claude-code', 'supported', 'enabled', null
	)
on conflict do nothing;

create table public.qorpera_member_compute_identities (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	ownership_kind text not null default 'member'
		check (ownership_kind in ('member', 'company', 'department', 'security_boundary')),
	owner_user_id uuid,
	owner_scope_key text check (
		owner_scope_key is null
		or (char_length(btrim(owner_scope_key)) between 1 and 160 and owner_scope_key !~ E'[\r\n]')
	),
	client_identity_id uuid not null,
	display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
	template_key text not null default 'qorpera-member-linux' check (
		template_key ~ '^[a-z][a-z0-9._-]{0,119}$'
	),
	template_version text not null default 'v1' check (
		char_length(btrim(template_version)) between 1 and 120 and template_version !~ E'[\r\n]'
	),
	capabilities jsonb not null default '["agent_turn","company_substrate"]'::jsonb
		check (public.qorpera_runner_capabilities_valid(capabilities)),
	policy jsonb not null default '{}'::jsonb check (
		jsonb_typeof(policy) = 'object' and pg_column_size(policy) <= 65536
	),
	encrypted_profile_reference text check (
		encrypted_profile_reference is null
		or (char_length(btrim(encrypted_profile_reference)) between 1 and 512
			and encrypted_profile_reference !~ E'[\r\n]')
	),
	encrypted_overlay_reference text check (
		encrypted_overlay_reference is null
		or (char_length(btrim(encrypted_overlay_reference)) between 1 and 512
			and encrypted_overlay_reference !~ E'[\r\n]')
	),
	status text not null default 'active' check (status in ('active', 'disabled', 'retired')),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_identity_id),
	check (
		(ownership_kind = 'member' and owner_user_id is not null and owner_scope_key is null)
		or (ownership_kind = 'company' and owner_user_id is null and owner_scope_key is null)
		or (ownership_kind in ('department', 'security_boundary')
			and owner_user_id is null and owner_scope_key is not null)
	)
);

create unique index qorpera_member_compute_identity_owner
	on public.qorpera_member_compute_identities (profile_id, owner_user_id)
	where ownership_kind = 'member';

create function public.qorpera_retire_member_compute_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_member_compute_identities
	set status = 'retired', updated_at = statement_timestamp()
	where profile_id = old.profile_id and ownership_kind = 'member'
		and owner_user_id = old.user_id and status <> 'retired';
	return old;
end
$$;

create trigger qorpera_retire_member_compute_identity
after delete on public.qorpera_profile_members
for each row execute function public.qorpera_retire_member_compute_identity();

alter table public.qorpera_logical_computers
	add column compute_identity_id uuid references public.qorpera_member_compute_identities(id) on delete restrict,
	add column computer_class text not null default 'managed_sandbox'
		check (computer_class in ('managed_sandbox', 'company_computer'));

alter table public.qorpera_execution_runs
	add column compute_identity_id uuid references public.qorpera_member_compute_identities(id) on delete restrict,
	add column worker_class text not null default 'managed_sandbox'
		check (worker_class in ('managed_sandbox', 'company_computer')),
	add column requested_by_user_id uuid references auth.users(id) on delete restrict,
	add column sponsored_by_user_id uuid references auth.users(id) on delete restrict;

update public.qorpera_execution_runs
set requested_by_user_id = created_by_user_id
where requested_by_user_id is null;

update public.qorpera_execution_runs as run
set sponsored_by_user_id = connection.owner_user_id
from public.qorpera_execution_sponsor_versions as sponsor,
	public.qorpera_provider_connections as connection
where sponsor.binding_id = run.sponsor_binding_id
	and sponsor.version = run.sponsor_version
	and connection.id = sponsor.provider_connection_id
	and run.sponsored_by_user_id is null;

alter table public.qorpera_execution_runs
	alter column requested_by_user_id set not null;

create function public.qorpera_execution_run_native_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.requested_by_user_id is null then
		new.requested_by_user_id := new.created_by_user_id;
	end if;
	if new.sponsored_by_user_id is null then
		select connection.owner_user_id into new.sponsored_by_user_id
		from public.qorpera_execution_sponsor_versions as sponsor
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		where sponsor.binding_id = new.sponsor_binding_id
			and sponsor.version = new.sponsor_version;
	end if;
	return new;
end
$$;

create trigger qorpera_execution_run_native_provenance
before insert on public.qorpera_execution_runs
for each row execute function public.qorpera_execution_run_native_provenance();

create table public.qorpera_native_provider_login_sessions (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	client_login_id uuid not null,
	client_connection_id uuid not null,
	provider text not null,
	native_harness text not null,
	capability_sha256 text not null check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled', 'expired')),
	requested_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	expires_at timestamptz not null,
	completed_at timestamptz,
	unique (profile_id, client_login_id),
	unique (profile_id, client_connection_id),
	check (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
	check ((status = 'completed') = (completed_at is not null))
);

-- The login-session FK fixes the authentication mode to native subscriptions
-- without duplicating a caller-controlled value in every row.
alter table public.qorpera_native_provider_login_sessions
	add column authentication_mode text generated always as ('native_subscription'::text) stored,
	add foreign key (provider, authentication_mode, native_harness)
		references public.qorpera_provider_execution_policies(provider, authentication_mode, native_harness)
		deferrable initially deferred;

create table public.qorpera_native_credential_capsules (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	ownership_kind text not null check (
		ownership_kind in ('member', 'company', 'department', 'security_boundary')
	),
	owner_user_id uuid,
	owner_scope_key text check (
		owner_scope_key is null
		or (char_length(btrim(owner_scope_key)) between 1 and 160 and owner_scope_key !~ E'[\r\n]')
	),
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	native_harness text not null check (
		char_length(btrim(native_harness)) between 1 and 120 and native_harness !~ E'[\r\n]'
	),
	encrypted_capsule_reference text not null check (
		char_length(btrim(encrypted_capsule_reference)) between 1 and 512
		and encrypted_capsule_reference !~ E'[\r\n]'
	),
	attestation_policy_sha256 text not null check (attestation_policy_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	revoked_at timestamptz,
	unique (profile_id, encrypted_capsule_reference),
	check (
		(ownership_kind = 'member' and owner_user_id is not null and owner_scope_key is null)
		or (ownership_kind = 'company' and owner_user_id is null and owner_scope_key is null)
		or (ownership_kind in ('department', 'security_boundary')
			and owner_user_id is null and owner_scope_key is not null)
	),
	check ((status = 'revoked') = (revoked_at is not null))
);

alter table public.qorpera_provider_connection_versions
	alter column secret_reference drop not null,
	add column credential_capsule_id uuid references public.qorpera_native_credential_capsules(id) on delete restrict,
	add column authorization_state text not null default 'active'
		check (authorization_state in ('active', 'reauthentication_required', 'revoked')),
	add column max_native_concurrency integer check (max_native_concurrency between 1 and 64),
	add constraint qorpera_provider_connection_version_credential_kind check (
		(authentication_mode = 'native_subscription'
			and secret_reference is null
			and credential_capsule_id is not null
			and max_native_concurrency is not null)
		or (authentication_mode <> 'native_subscription'
			and secret_reference is not null
			and credential_capsule_id is null
			and max_native_concurrency is null)
	) not valid;

create or replace function public.qorpera_execution_run_native_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
begin
	if new.requested_by_user_id is null then
		new.requested_by_user_id := new.created_by_user_id;
	end if;
	select sponsor.* into strict v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = new.sponsor_binding_id and sponsor.version = new.sponsor_version;
	select connection.* into strict v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id;
	select version.* into strict v_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_sponsor.provider_connection_id
		and version.version = v_sponsor.provider_connection_version;
	if new.sponsored_by_user_id is null then
		new.sponsored_by_user_id := v_connection.owner_user_id;
	end if;
	if new.compute_identity_id is not null then
		select identity.* into strict v_identity
		from public.qorpera_member_compute_identities as identity
		where identity.id = new.compute_identity_id and identity.profile_id = new.profile_id
			and identity.status = 'active';
		if (v_sponsor.sponsor_kind = 'member_connection' and (
			v_identity.ownership_kind <> 'member'
			or v_identity.owner_user_id is distinct from v_connection.owner_user_id
		)) or (v_sponsor.sponsor_kind <> 'member_connection' and (
			v_identity.ownership_kind = 'member' or v_connection.owner_user_id is not null
		)) then
			raise exception 'execution compute identity does not own its sponsor authority' using errcode = '42501';
		end if;
	end if;
	if v_version.authentication_mode = 'native_subscription' then
		select capsule.* into strict v_capsule
		from public.qorpera_native_credential_capsules as capsule
		where capsule.id = v_version.credential_capsule_id and capsule.status = 'active';
		if v_identity.id is null or v_capsule.compute_identity_id <> v_identity.id
			or v_capsule.ownership_kind <> v_identity.ownership_kind
			or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
			or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key then
			raise exception 'native execution credential does not belong to its compute identity' using errcode = '42501';
		end if;
	end if;
	return new;
end
$$;

create table public.qorpera_session_turn_requests (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	client_request_id uuid not null,
	input_id uuid not null unique references public.qorpera_session_inputs(id) on delete restrict,
	requested_by_user_id uuid not null references auth.users(id) on delete restrict,
	sponsor_mode text not null check (sponsor_mode in (
		'member_connection', 'company_connection', 'sponsorship_request'
	)),
	sponsor_binding_id uuid,
	sponsor_version bigint,
	sponsored_by_user_id uuid references auth.users(id) on delete restrict,
	requested_sponsor_user_id uuid references auth.users(id) on delete restrict,
	compute_identity_id uuid references public.qorpera_member_compute_identities(id) on delete restrict,
	logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
	worker_class text not null check (worker_class in ('managed_sandbox', 'company_computer')),
	required_capability text not null default 'agent_turn' check (
		required_capability in ('agent_turn', 'git_worktree', 'company_substrate')
	),
	job_type text not null default 'agent_turn' check (job_type ~ '^[a-z][a-z0-9_-]{0,63}$'),
	publication_mode text not null default 'automatic' check (publication_mode in ('automatic', 'review')),
	review_policy_key text check (
		review_policy_key is null
		or (char_length(btrim(review_policy_key)) between 1 and 128 and review_policy_key !~ E'[\r\n]')
	),
	reviewer_staff_ids uuid[] not null default '{}'::uuid[] check (
		cardinality(reviewer_staff_ids) <= 20 and public.qorpera_uuid_array_is_unique(reviewer_staff_ids)
	),
	status text not null check (status in (
		'pending_sponsorship', 'queued', 'materialized', 'cancelled', 'failed'
	)),
	run_id uuid unique references public.qorpera_execution_runs(id) on delete restrict,
	failure_reason text check (
		failure_reason is null or char_length(btrim(failure_reason)) between 1 and 1000
	),
	created_at timestamptz not null default statement_timestamp(),
	sponsored_at timestamptz,
	materialized_at timestamptz,
	unique (session_id, client_request_id),
	foreign key (sponsor_binding_id, sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict,
	check (
		(sponsor_mode = 'sponsorship_request'
			and ((status = 'pending_sponsorship'
				and sponsor_binding_id is null and sponsor_version is null
				and sponsored_by_user_id is null and compute_identity_id is null
				and requested_sponsor_user_id is not null and sponsored_at is null)
			or (status <> 'pending_sponsorship'
				and sponsor_binding_id is not null and sponsor_version is not null
				and sponsored_by_user_id is not null and compute_identity_id is not null
				and requested_sponsor_user_id is not null and sponsored_at is not null)))
		or (sponsor_mode = 'member_connection'
			and status <> 'pending_sponsorship'
			and sponsor_binding_id is not null and sponsor_version is not null
			and sponsored_by_user_id is not null and compute_identity_id is not null
			and requested_sponsor_user_id is null and sponsored_at is not null)
		or (sponsor_mode = 'company_connection'
			and status <> 'pending_sponsorship'
			and sponsor_binding_id is not null and sponsor_version is not null
			and sponsored_by_user_id is null
			and requested_sponsor_user_id is null and sponsored_at is not null)
	),
	check (
		(status = 'materialized' and run_id is not null and materialized_at is not null)
		or (status <> 'materialized' and run_id is null and materialized_at is null)
	),
	check ((status = 'failed') = (failure_reason is not null)),
	check (worker_class = 'managed_sandbox' or logical_computer_id is not null),
	check (
		(publication_mode = 'automatic' and review_policy_key is null and cardinality(reviewer_staff_ids) = 0)
		or (publication_mode = 'review' and review_policy_key is not null and cardinality(reviewer_staff_ids) > 0)
	)
);

create index qorpera_session_turn_requests_queue
	on public.qorpera_session_turn_requests (created_at, id)
	where status = 'queued';

create table public.qorpera_native_provider_connection_leases (
	id uuid primary key default extensions.gen_random_uuid(),
	run_id uuid not null unique references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null unique references public.qorpera_runner_jobs(id) on delete restrict,
	provider_connection_id uuid not null,
	provider_connection_version bigint not null,
	credential_capsule_id uuid not null references public.qorpera_native_credential_capsules(id) on delete restrict,
	compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
	runner_id uuid not null references public.qorpera_runners(id) on delete restrict,
	assignment_id uuid not null unique references public.qorpera_runner_assignments(id) on delete restrict,
	lease_token_sha256 text not null check (lease_token_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active', 'released', 'revoked', 'expired')),
	created_at timestamptz not null default statement_timestamp(),
	expires_at timestamptz not null,
	released_at timestamptz,
	foreign key (provider_connection_id, provider_connection_version)
		references public.qorpera_provider_connection_versions(connection_id, version) on delete restrict,
	check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
	check ((status = 'active') = (released_at is null))
);

create index qorpera_native_provider_connection_leases_active
	on public.qorpera_native_provider_connection_leases (provider_connection_id, expires_at)
	where status = 'active';

alter table public.qorpera_provider_execution_policies enable row level security;
alter table public.qorpera_member_compute_identities enable row level security;
alter table public.qorpera_native_provider_login_sessions enable row level security;
alter table public.qorpera_native_credential_capsules enable row level security;
alter table public.qorpera_session_turn_requests enable row level security;
alter table public.qorpera_native_provider_connection_leases enable row level security;

revoke all on public.qorpera_provider_execution_policies from anon, authenticated;
revoke all on public.qorpera_member_compute_identities from anon, authenticated;
revoke all on public.qorpera_native_provider_login_sessions from anon, authenticated;
revoke all on public.qorpera_native_credential_capsules from anon, authenticated;
revoke all on public.qorpera_session_turn_requests from anon, authenticated;
revoke all on public.qorpera_native_provider_connection_leases from anon, authenticated;

create function public.qorpera_provider_execution_enabled(
	p_provider text,
	p_authentication_mode text,
	p_native_harness text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_provider_execution_policies as policy
		where policy.provider = p_provider
			and policy.authentication_mode = p_authentication_mode
			and policy.native_harness = p_native_harness
			and policy.implementation_status = 'supported'
			and policy.enablement_status = 'enabled'
	)
$$;

create function public.qorpera_set_provider_execution_policy(
	p_provider text,
	p_authentication_mode text,
	p_native_harness text,
	p_implementation_status text,
	p_enablement_status text,
	p_max_native_concurrency integer,
	p_disabled_reason text,
	p_commercial_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_policy public.qorpera_provider_execution_policies%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'provider execution policy requires deployment authority' using errcode = '42501';
	end if;
	insert into public.qorpera_provider_execution_policies (
		provider, authentication_mode, native_harness, implementation_status,
		enablement_status, max_native_concurrency, disabled_reason, commercial_reference,
		policy_version, updated_at
	) values (
		p_provider, p_authentication_mode, btrim(p_native_harness), p_implementation_status,
		p_enablement_status, p_max_native_concurrency, nullif(btrim(p_disabled_reason), ''),
		nullif(btrim(p_commercial_reference), ''), 1, statement_timestamp()
	)
	on conflict (provider, authentication_mode, native_harness) do update set
		implementation_status = excluded.implementation_status,
		enablement_status = excluded.enablement_status,
		max_native_concurrency = excluded.max_native_concurrency,
		disabled_reason = excluded.disabled_reason,
		commercial_reference = excluded.commercial_reference,
		policy_version = public.qorpera_provider_execution_policies.policy_version + 1,
		updated_at = statement_timestamp()
	returning * into v_policy;
	return jsonb_build_object(
		'provider', v_policy.provider,
		'authentication_mode', v_policy.authentication_mode,
		'native_harness', v_policy.native_harness,
		'implementation_status', v_policy.implementation_status,
		'enablement_status', v_policy.enablement_status,
		'max_native_concurrency', v_policy.max_native_concurrency,
		'policy_version', v_policy.policy_version
	);
end
$$;

create function public.qorpera_upsert_member_compute_identity(
	p_profile_id uuid,
	p_client_identity_id uuid,
	p_display_name text,
	p_template_key text,
	p_template_version text,
	p_capabilities jsonb,
	p_policy jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if v_user_id is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user_id
	) or p_client_identity_id is null
		or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120
		or coalesce(p_template_key, '') !~ '^[a-z][a-z0-9._-]{0,119}$'
		or char_length(btrim(coalesce(p_template_version, ''))) not between 1 and 120
		or not public.qorpera_runner_capabilities_valid(p_capabilities)
		or jsonb_typeof(p_policy) is distinct from 'object' or pg_column_size(p_policy) > 65536 then
		raise exception 'member compute identity is invalid' using errcode = '22023';
	end if;
	select identity.* into v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
		and identity.owner_user_id = v_user_id
	for update;
	if v_identity.id is null then
		insert into public.qorpera_member_compute_identities (
			profile_id, ownership_kind, owner_user_id, client_identity_id, display_name,
			template_key, template_version, capabilities, policy
		) values (
			p_profile_id, 'member', v_user_id, p_client_identity_id, btrim(p_display_name),
			p_template_key, btrim(p_template_version), p_capabilities, p_policy
		) returning * into v_identity;
	elsif v_identity.client_identity_id <> p_client_identity_id then
		raise exception 'member compute identity id is already bound' using errcode = '23505';
	else
		update public.qorpera_member_compute_identities
		set display_name = btrim(p_display_name), template_key = p_template_key,
			template_version = btrim(p_template_version), capabilities = p_capabilities,
			policy = p_policy, updated_at = statement_timestamp()
		where id = v_identity.id
		returning * into v_identity;
	end if;
	return jsonb_build_object(
		'compute_identity_id', v_identity.id,
		'ownership_kind', v_identity.ownership_kind,
		'owner_user_id', v_identity.owner_user_id,
		'owner_scope_key', v_identity.owner_scope_key,
		'display_name', v_identity.display_name,
		'template_key', v_identity.template_key,
		'template_version', v_identity.template_version,
		'capabilities', v_identity.capabilities,
		'policy', v_identity.policy,
		'status', v_identity.status,
		'created_at', v_identity.created_at,
		'updated_at', v_identity.updated_at
	);
end
$$;

create function public.qorpera_upsert_scoped_compute_identity(
	p_profile_id uuid,
	p_client_identity_id uuid,
	p_ownership_kind text,
	p_owner_scope_key text,
	p_display_name text,
	p_template_key text,
	p_template_version text,
	p_capabilities jsonb,
	p_policy jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_scope_key text := nullif(btrim(p_owner_scope_key), '');
begin
	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id)
		or p_client_identity_id is null
		or p_ownership_kind not in ('company', 'department', 'security_boundary')
		or (p_ownership_kind = 'company' and v_scope_key is not null)
		or (p_ownership_kind in ('department', 'security_boundary') and (
			v_scope_key is null or char_length(v_scope_key) > 160 or v_scope_key ~ E'[\r\n]'
		))
		or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120
		or coalesce(p_template_key, '') !~ '^[a-z][a-z0-9._-]{0,119}$'
		or char_length(btrim(coalesce(p_template_version, ''))) not between 1 and 120
		or not public.qorpera_runner_capabilities_valid(p_capabilities)
		or jsonb_typeof(p_policy) is distinct from 'object' or pg_column_size(p_policy) > 65536 then
		raise exception 'scoped compute identity is invalid' using errcode = '22023';
	end if;
	select identity.* into v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.profile_id = p_profile_id and identity.client_identity_id = p_client_identity_id
	for update;
	if v_identity.id is null then
		insert into public.qorpera_member_compute_identities (
			profile_id, ownership_kind, owner_scope_key, client_identity_id, display_name,
			template_key, template_version, capabilities, policy
		) values (
			p_profile_id, p_ownership_kind, v_scope_key, p_client_identity_id, btrim(p_display_name),
			p_template_key, btrim(p_template_version), p_capabilities, p_policy
		) returning * into v_identity;
	elsif v_identity.ownership_kind <> p_ownership_kind
		or v_identity.owner_scope_key is distinct from v_scope_key
		or v_identity.owner_user_id is not null then
		raise exception 'scoped compute identity id is already bound' using errcode = '23505';
	else
		update public.qorpera_member_compute_identities
		set display_name = btrim(p_display_name), template_key = p_template_key,
			template_version = btrim(p_template_version), capabilities = p_capabilities,
			policy = p_policy, updated_at = statement_timestamp()
		where id = v_identity.id
		returning * into v_identity;
	end if;
	return jsonb_build_object(
		'compute_identity_id', v_identity.id,
		'ownership_kind', v_identity.ownership_kind,
		'owner_user_id', v_identity.owner_user_id,
		'owner_scope_key', v_identity.owner_scope_key,
		'display_name', v_identity.display_name,
		'template_key', v_identity.template_key,
		'template_version', v_identity.template_version,
		'capabilities', v_identity.capabilities,
		'policy', v_identity.policy,
		'status', v_identity.status,
		'created_at', v_identity.created_at,
		'updated_at', v_identity.updated_at
	);
end
$$;

create function public.qorpera_begin_native_provider_login(
	p_profile_id uuid,
	p_client_login_id uuid,
	p_client_connection_id uuid,
	p_compute_identity_id uuid,
	p_provider text,
	p_native_harness text,
	p_capability_sha256 text,
	p_login_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_login public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	select identity.* into v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = p_compute_identity_id and identity.profile_id = p_profile_id
		and identity.status = 'active';
	if v_user_id is null or p_client_login_id is null or p_client_connection_id is null
		or p_capability_sha256 !~ '^[0-9a-f]{64}$' or p_login_seconds not between 60 and 3600
		or v_identity.id is null
		or not (
			(v_identity.ownership_kind = 'member' and v_identity.owner_user_id = v_user_id)
			or (v_identity.ownership_kind <> 'member' and public.qorpera_can_authorize_profile(p_profile_id))
		) then
		raise exception 'native provider login is invalid' using errcode = '22023';
	end if;
	if not public.qorpera_provider_execution_enabled(p_provider, 'native_subscription', p_native_harness) then
		raise exception 'native provider execution is not enabled for this deployment' using errcode = '55000';
	end if;
	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.profile_id = p_profile_id and login.client_login_id = p_client_login_id
	for update;
	if found then
		if v_login.compute_identity_id <> p_compute_identity_id
			or v_login.client_connection_id <> p_client_connection_id
			or v_login.provider <> p_provider or v_login.native_harness <> p_native_harness
			or v_login.capability_sha256 <> p_capability_sha256
			or v_login.requested_by_user_id <> v_user_id then
			raise exception 'native provider login id is already bound to other authority' using errcode = '23505';
		end if;
	else
		insert into public.qorpera_native_provider_login_sessions (
			profile_id, compute_identity_id, client_login_id, client_connection_id,
			provider, native_harness, capability_sha256, requested_by_user_id, expires_at
		) values (
			p_profile_id, p_compute_identity_id, p_client_login_id, p_client_connection_id,
			p_provider, btrim(p_native_harness), p_capability_sha256, v_user_id,
			statement_timestamp() + make_interval(secs => p_login_seconds)
		) returning * into v_login;
	end if;
	return jsonb_build_object(
		'login_id', v_login.id,
		'compute_identity_id', v_login.compute_identity_id,
		'compute_identity_ownership_kind', v_identity.ownership_kind,
		'compute_identity_owner_user_id', v_identity.owner_user_id,
		'compute_identity_owner_scope_key', v_identity.owner_scope_key,
		'provider', v_login.provider,
		'native_harness', v_login.native_harness,
		'status', v_login.status,
		'expires_at', v_login.expires_at
	);
end
$$;

create function public.qorpera_complete_native_provider_login(
	p_login_id uuid,
	p_capability_sha256 text,
	p_capsule_id uuid,
	p_encrypted_capsule_reference text,
	p_attestation_policy_sha256 text,
	p_provider_account_reference text,
	p_billing_source text,
	p_consent_version text,
	p_quota_policy jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_login public.qorpera_native_provider_login_sessions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_version bigint;
begin
	if auth.role() <> 'service_role' or p_capsule_id is null
		or p_capability_sha256 !~ '^[0-9a-f]{64}$'
		or p_attestation_policy_sha256 !~ '^[0-9a-f]{64}$'
		or char_length(btrim(coalesce(p_encrypted_capsule_reference, ''))) not between 1 and 512
		or char_length(btrim(coalesce(p_billing_source, ''))) not between 1 and 120
		or char_length(btrim(coalesce(p_consent_version, ''))) not between 1 and 120
		or not public.qorpera_provider_quota_policy_valid(p_quota_policy) then
		raise exception 'native provider login completion is invalid' using errcode = '22023';
	end if;
	select login.* into v_login
	from public.qorpera_native_provider_login_sessions as login
	where login.id = p_login_id
	for update;
	if not found or v_login.capability_sha256 <> p_capability_sha256
		or v_login.status <> 'pending' or v_login.expires_at <= statement_timestamp() then
		raise exception 'native provider login is unavailable' using errcode = '55000';
	end if;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_login.compute_identity_id and identity.profile_id = v_login.profile_id
		and identity.status = 'active';
	select policy.* into v_policy
	from public.qorpera_provider_execution_policies as policy
	where policy.provider = v_login.provider
		and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = v_login.native_harness
		and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled'
	for share;
	if not found or (p_quota_policy ->> 'max_concurrent_runs')::integer > v_policy.max_native_concurrency then
		raise exception 'native provider policy does not authorize this connection' using errcode = '42501';
	end if;
	insert into public.qorpera_native_credential_capsules (
		id, profile_id, compute_identity_id, ownership_kind, owner_user_id, owner_scope_key,
		provider, native_harness,
		encrypted_capsule_reference, attestation_policy_sha256, created_by_user_id
	) values (
		p_capsule_id, v_login.profile_id, v_login.compute_identity_id,
		v_identity.ownership_kind, v_identity.owner_user_id, v_identity.owner_scope_key, v_login.provider,
		v_login.native_harness, btrim(p_encrypted_capsule_reference), p_attestation_policy_sha256,
		v_login.requested_by_user_id
	) returning * into v_capsule;
	insert into public.qorpera_provider_connections (
		profile_id, client_connection_id, owner_user_id, provider, created_by_user_id
	) values (
		v_login.profile_id, v_login.client_connection_id, v_identity.owner_user_id,
		v_login.provider, v_login.requested_by_user_id
	)
	on conflict (profile_id, client_connection_id) do update set
		status = case
			when public.qorpera_provider_connections.owner_user_id is not distinct from excluded.owner_user_id
				and public.qorpera_provider_connections.provider = excluded.provider
			then 'active'
			else public.qorpera_provider_connections.status
	end
	returning * into v_connection;
	if v_connection.owner_user_id is distinct from v_identity.owner_user_id
		or v_connection.provider <> v_login.provider then
		raise exception 'provider connection identity is already bound' using errcode = '23505';
	end if;
	select coalesce(max(version), 0) + 1 into v_version
	from public.qorpera_provider_connection_versions
	where connection_id = v_connection.id;
	insert into public.qorpera_provider_connection_versions (
		connection_id, version, authentication_mode, native_harness, secret_reference,
		provider_account_reference, billing_source, consent_version, consented_by_user_id,
		allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id,
		credential_capsule_id, authorization_state, max_native_concurrency
	) values (
		v_connection.id, v_version, 'native_subscription', v_login.native_harness, null,
		nullif(btrim(p_provider_account_reference), ''), btrim(p_billing_source), btrim(p_consent_version),
		v_login.requested_by_user_id, false, v_policy.commercial_reference, p_quota_policy,
		v_login.requested_by_user_id, v_capsule.id, 'active', v_policy.max_native_concurrency
	);
	update public.qorpera_native_provider_login_sessions
	set status = 'completed', completed_at = statement_timestamp()
	where id = v_login.id;
	return jsonb_build_object(
		'connection_id', v_connection.id,
		'version', v_version,
		'compute_identity_id', v_login.compute_identity_id,
		'ownership_kind', v_identity.ownership_kind,
		'owner_user_id', v_identity.owner_user_id,
		'owner_scope_key', v_identity.owner_scope_key,
		'credential_capsule_id', v_capsule.id,
		'provider', v_login.provider,
		'native_harness', v_login.native_harness,
		'authorization_state', 'active'
	);
end
$$;

create function public.qorpera_create_member_execution_sponsor(
	p_profile_id uuid,
	p_client_binding_id uuid,
	p_provider_connection_id uuid,
	p_provider_connection_version bigint,
	p_allow_autonomous boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_existing_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_sponsor_version bigint;
begin
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = p_provider_connection_id and connection.profile_id = p_profile_id
		and connection.owner_user_id = v_user_id and connection.status = 'active';
	select version.* into v_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = p_provider_connection_id
		and version.version = p_provider_connection_version
		and version.authorization_state = 'active';
	if v_user_id is null or p_client_binding_id is null or v_connection.id is null or v_version.connection_id is null
		or (coalesce(p_allow_autonomous, false) and not v_version.allow_autonomous) then
		raise exception 'member execution sponsor is invalid' using errcode = '42501';
	end if;
	select binding.* into v_binding
	from public.qorpera_execution_sponsor_bindings as binding
	where binding.profile_id = p_profile_id and binding.client_binding_id = p_client_binding_id
	for update;
	if not found then
		insert into public.qorpera_execution_sponsor_bindings (
			profile_id, client_binding_id, created_by_user_id
		) values (p_profile_id, p_client_binding_id, v_user_id)
		returning * into v_binding;
	else
		if v_binding.created_by_user_id <> v_user_id then
			raise exception 'member sponsor identity is already bound' using errcode = '23505';
		end if;
		select sponsor.* into v_existing_sponsor
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_binding.id
		order by sponsor.version desc
		limit 1;
		if v_existing_sponsor.binding_id is not null then
			if v_existing_sponsor.sponsor_kind <> 'member_connection'
				or v_existing_sponsor.provider_connection_id <> p_provider_connection_id
				or v_existing_sponsor.provider_connection_version <> p_provider_connection_version
				or v_existing_sponsor.allow_autonomous <> coalesce(p_allow_autonomous, false)
				or v_existing_sponsor.created_by_user_id <> v_user_id then
				raise exception 'member sponsor operation id is already bound to other authority' using errcode = '23505';
			end if;
			return jsonb_build_object(
				'binding_id', v_existing_sponsor.binding_id,
				'version', v_existing_sponsor.version
			);
		end if;
	end if;
	select coalesce(max(version), 0) + 1 into v_sponsor_version
	from public.qorpera_execution_sponsor_versions where binding_id = v_binding.id;
	insert into public.qorpera_execution_sponsor_versions (
		binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id
	) values (
		v_binding.id, v_sponsor_version, 'member_connection', p_provider_connection_id,
		p_provider_connection_version, coalesce(p_allow_autonomous, false), v_user_id
	);
	return jsonb_build_object('binding_id', v_binding.id, 'version', v_sponsor_version);
end
$$;

create function public.qorpera_request_session_turn(
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
	v_input jsonb;
	v_request public.qorpera_session_turn_requests%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_initial_status text;
	v_sponsored_by uuid;
	v_sponsored_at timestamptz;
begin
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = p_session_id for update;
	if v_user_id is null or not found or v_session.status <> 'open'
		or not public.qorpera_can_write_profile(v_session.profile_id)
		or p_client_request_id is null
		or p_sponsor_mode not in ('member_connection', 'company_connection', 'sponsorship_request')
		or p_worker_class not in ('managed_sandbox', 'company_computer')
		or p_required_capability not in ('agent_turn', 'git_worktree', 'company_substrate')
		or coalesce(p_job_type, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_publication_mode not in ('automatic', 'review')
		or not public.qorpera_uuid_array_is_unique(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) then
		raise exception 'session turn request is invalid' using errcode = '22023';
	end if;
	if p_sponsor_mode = 'sponsorship_request' then
		if p_sponsor_binding_id is not null or p_sponsor_version is not null
			or p_compute_identity_id is not null or p_requested_sponsor_user_id is null
			or not exists (
				select 1 from public.qorpera_profile_members as member
				where member.profile_id = v_session.profile_id
					and member.user_id = p_requested_sponsor_user_id
			) then
			raise exception 'sponsorship request is invalid' using errcode = '22023';
		end if;
		v_initial_status := 'pending_sponsorship';
		v_sponsored_by := null;
		v_sponsored_at := null;
	else
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version;
		select connection.* into v_connection
		from public.qorpera_provider_connections as connection
		where connection.id = v_sponsor.provider_connection_id
			and connection.profile_id = v_session.profile_id and connection.status = 'active';
		select version.* into v_connection_version
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_sponsor.provider_connection_id
			and version.version = v_sponsor.provider_connection_version
			and version.authorization_state = 'active';
		if p_compute_identity_id is not null then
			select identity.* into v_identity
			from public.qorpera_member_compute_identities as identity
			where identity.id = p_compute_identity_id and identity.profile_id = v_session.profile_id
				and identity.status = 'active';
		end if;
		if v_sponsor.binding_id is null or v_connection.id is null or not exists (
			select 1 from public.qorpera_execution_sponsor_bindings as binding
			where binding.id = p_sponsor_binding_id and binding.profile_id = v_session.profile_id
				and binding.status = 'active'
		) or v_connection_version.connection_id is null
			or (p_sponsor_mode = 'member_connection' and (
				v_identity.ownership_kind is distinct from 'member'
				or v_identity.owner_user_id is distinct from v_user_id
			)) then
			raise exception 'session turn sponsor is unavailable' using errcode = '42501';
		end if;
		if p_sponsor_mode = 'member_connection' and (
			v_sponsor.sponsor_kind <> 'member_connection' or v_connection.owner_user_id <> v_user_id
		) then
			raise exception 'personal session turn requires the requester connection' using errcode = '42501';
		end if;
		if p_sponsor_mode = 'company_connection' and v_sponsor.sponsor_kind = 'member_connection' then
			raise exception 'company session turn requires a company connection' using errcode = '42501';
		end if;
		if p_sponsor_mode = 'company_connection' and (
			v_identity.id is null or v_identity.ownership_kind = 'member'
			or not public.qorpera_can_authorize_profile(v_session.profile_id)
		) then
			raise exception 'company session turn compute identity is unavailable' using errcode = '42501';
		end if;
		if v_connection_version.authentication_mode = 'native_subscription' then
			select capsule.* into v_capsule
			from public.qorpera_native_credential_capsules as capsule
			where capsule.id = v_connection_version.credential_capsule_id and capsule.status = 'active';
			if v_identity.id is null or v_capsule.compute_identity_id is distinct from v_identity.id
				or v_capsule.ownership_kind <> v_identity.ownership_kind
				or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
				or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key then
				raise exception 'native session turn credential ownership is unavailable' using errcode = '42501';
			end if;
		end if;
		v_initial_status := 'queued';
		v_sponsored_by := case when p_sponsor_mode = 'member_connection' then v_user_id else null end;
		v_sponsored_at := statement_timestamp();
	end if;
	if p_logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = p_logical_computer_id and computer.profile_id = v_session.profile_id
			and computer.status = 'active' and computer.computer_class = p_worker_class
			and computer.compute_identity_id is not distinct from p_compute_identity_id
			and computer.capabilities ? p_required_capability
	) then
		raise exception 'session turn logical computer is unavailable' using errcode = '42501';
	end if;
	select request.* into v_request
	from public.qorpera_session_turn_requests as request
	where request.session_id = p_session_id and request.client_request_id = p_client_request_id;
	if found then
		return jsonb_build_object(
			'turn_request_id', v_request.id,
			'input_id', v_request.input_id,
			'status', v_request.status,
			'sponsor_mode', v_request.sponsor_mode
		);
	end if;
	v_input := public.qorpera_append_session_input(p_session_id, p_client_input_id, 'user_message', p_body);
	insert into public.qorpera_session_turn_requests (
		profile_id, session_id, client_request_id, input_id, requested_by_user_id,
		sponsor_mode, sponsor_binding_id, sponsor_version, sponsored_by_user_id,
		requested_sponsor_user_id, compute_identity_id, logical_computer_id, worker_class,
		required_capability, job_type, publication_mode, review_policy_key,
		reviewer_staff_ids, status, sponsored_at
	) values (
		v_session.profile_id, v_session.id, p_client_request_id, (v_input ->> 'input_id')::uuid,
		v_user_id, p_sponsor_mode, p_sponsor_binding_id, p_sponsor_version, v_sponsored_by,
		p_requested_sponsor_user_id, p_compute_identity_id, p_logical_computer_id, p_worker_class,
		p_required_capability, p_job_type, p_publication_mode, nullif(btrim(p_review_policy_key), ''),
		coalesce(p_reviewer_staff_ids, '{}'::uuid[]), v_initial_status, v_sponsored_at
	) returning * into v_request;
	return jsonb_build_object(
		'turn_request_id', v_request.id,
		'input_id', v_request.input_id,
		'status', v_request.status,
		'sponsor_mode', v_request.sponsor_mode
	);
end
$$;

create function public.qorpera_approve_session_turn_sponsorship(
	p_turn_request_id uuid,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_compute_identity_id uuid,
	p_logical_computer_id uuid default null,
	p_worker_class text default 'managed_sandbox'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_request public.qorpera_session_turn_requests%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
begin
	select request.* into v_request
	from public.qorpera_session_turn_requests as request
	where request.id = p_turn_request_id
	for update;
	if v_user_id is null or not found or v_request.status <> 'pending_sponsorship'
		or v_request.requested_sponsor_user_id <> v_user_id
		or p_worker_class not in ('managed_sandbox', 'company_computer') then
		raise exception 'session turn sponsorship is unavailable' using errcode = '42501';
	end if;
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version
		and sponsor.sponsor_kind = 'member_connection';
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id
		and connection.profile_id = v_request.profile_id
		and connection.owner_user_id = v_user_id and connection.status = 'active';
	if v_sponsor.binding_id is null or v_connection.id is null or not exists (
		select 1 from public.qorpera_execution_sponsor_bindings as binding
		where binding.id = p_sponsor_binding_id and binding.profile_id = v_request.profile_id
			and binding.status = 'active'
	) or not exists (
		select 1 from public.qorpera_member_compute_identities as identity
		where identity.id = p_compute_identity_id and identity.profile_id = v_request.profile_id
			and identity.ownership_kind = 'member'
			and identity.owner_user_id = v_user_id and identity.status = 'active'
	) then
		raise exception 'session turn sponsor authority is invalid' using errcode = '42501';
	end if;
	if p_logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = p_logical_computer_id and computer.profile_id = v_request.profile_id
			and computer.compute_identity_id = p_compute_identity_id
			and computer.computer_class = p_worker_class and computer.status = 'active'
			and computer.capabilities ? v_request.required_capability
	) then
		raise exception 'session turn sponsor computer is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_session_turn_requests
	set sponsor_binding_id = p_sponsor_binding_id,
		sponsor_version = p_sponsor_version,
		sponsored_by_user_id = v_user_id,
		compute_identity_id = p_compute_identity_id,
		logical_computer_id = p_logical_computer_id,
		worker_class = p_worker_class,
		status = 'queued',
		sponsored_at = statement_timestamp()
	where id = v_request.id
	returning * into v_request;
	return jsonb_build_object(
		'turn_request_id', v_request.id,
		'status', v_request.status,
		'sponsor_binding_id', v_request.sponsor_binding_id,
		'sponsor_version', v_request.sponsor_version,
		'sponsored_by_user_id', v_request.sponsored_by_user_id,
		'compute_identity_id', v_request.compute_identity_id,
		'worker_class', v_request.worker_class
	);
end
$$;

create function public.qorpera_list_member_native_execution_connections(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_identity public.qorpera_member_compute_identities%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'native execution connections are unavailable' using errcode = '42501';
	end if;
	select identity.* into v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
		and identity.owner_user_id = v_user_id;
	return jsonb_build_object(
		'compute_identity', case when v_identity.id is null then null else jsonb_build_object(
			'compute_identity_id', v_identity.id,
			'ownership_kind', v_identity.ownership_kind,
			'owner_user_id', v_identity.owner_user_id,
			'owner_scope_key', v_identity.owner_scope_key,
			'display_name', v_identity.display_name,
			'template_key', v_identity.template_key,
			'template_version', v_identity.template_version,
			'capabilities', v_identity.capabilities,
			'policy', v_identity.policy,
			'status', v_identity.status,
			'created_at', v_identity.created_at,
			'updated_at', v_identity.updated_at
		) end,
		'connections', coalesce((
			select jsonb_agg(jsonb_build_object(
				'connection_id', connection.id,
				'connection_version', version.version,
				'provider', connection.provider,
				'native_harness', version.native_harness,
				'authorization_state', version.authorization_state,
				'max_native_concurrency', version.max_native_concurrency,
				'provider_account_reference', version.provider_account_reference,
				'billing_source', version.billing_source,
				'consent_version', version.consent_version,
				'consented_at', version.consented_at,
				'connection_status', connection.status,
				'sponsor_binding_id', sponsor.binding_id,
				'sponsor_version', sponsor.version,
				'policy', jsonb_build_object(
					'implementation_status', policy.implementation_status,
					'enablement_status', policy.enablement_status,
					'policy_version', policy.policy_version,
					'disabled_reason', policy.disabled_reason
				)
			) order by connection.provider, version.created_at desc)
			from public.qorpera_provider_connections as connection
			join public.qorpera_provider_connection_versions as version
				on version.connection_id = connection.id
				and version.authentication_mode = 'native_subscription'
			join public.qorpera_native_credential_capsules as capsule
				on capsule.id = version.credential_capsule_id
			join public.qorpera_provider_execution_policies as policy
				on policy.provider = connection.provider
				and policy.authentication_mode = version.authentication_mode
				and policy.native_harness = version.native_harness
			left join lateral (
				select sponsor_version.binding_id, sponsor_version.version
				from public.qorpera_execution_sponsor_versions as sponsor_version
				join public.qorpera_execution_sponsor_bindings as binding
					on binding.id = sponsor_version.binding_id and binding.status = 'active'
				where sponsor_version.provider_connection_id = connection.id
					and sponsor_version.provider_connection_version = version.version
					and sponsor_version.sponsor_kind = 'member_connection'
				order by sponsor_version.created_at desc, sponsor_version.version desc
				limit 1
			) as sponsor on true
			where connection.profile_id = p_profile_id
				and connection.owner_user_id = v_user_id
				and capsule.compute_identity_id = v_identity.id
		), '[]'::jsonb)
	);
end
$$;

create function public.qorpera_list_compute_identities(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'compute identities are unavailable' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'compute_identity_id', identity.id,
			'ownership_kind', identity.ownership_kind,
			'owner_user_id', identity.owner_user_id,
			'owner_scope_key', identity.owner_scope_key,
			'display_name', identity.display_name,
			'template_key', identity.template_key,
			'template_version', identity.template_version,
			'capabilities', identity.capabilities,
			'policy', identity.policy,
			'status', identity.status,
			'created_at', identity.created_at,
			'updated_at', identity.updated_at
		) order by identity.created_at, identity.id)
		from public.qorpera_member_compute_identities as identity
		where identity.profile_id = p_profile_id
			and (
				identity.ownership_kind <> 'member'
				or identity.owner_user_id = auth.uid()
				or public.qorpera_can_authorize_profile(p_profile_id)
			)
	), '[]'::jsonb);
end
$$;

create function public.qorpera_list_session_turn_requests(
	p_session_id uuid,
	p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select session.profile_id into v_profile_id
	from public.qorpera_shared_sessions as session where session.id = p_session_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id)
		or p_limit not between 1 and 250 then
		raise exception 'session turn provenance is unavailable' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'turn_request_id', request.id,
			'input_id', request.input_id,
			'requested_by_user_id', request.requested_by_user_id,
			'requested_by_name', requester.display_name,
			'sponsor_mode', request.sponsor_mode,
			'sponsored_by_user_id', request.sponsored_by_user_id,
			'sponsored_by_name', sponsor_member.display_name,
			'requested_sponsor_user_id', request.requested_sponsor_user_id,
			'provider', connection.provider,
			'provider_connection_id', connection.id,
			'provider_connection_version', sponsor.provider_connection_version,
			'native_harness', connection_version.native_harness,
			'authentication_mode', connection_version.authentication_mode,
			'compute_identity_id', request.compute_identity_id,
			'compute_identity_ownership_kind', identity.ownership_kind,
			'compute_identity_owner_user_id', identity.owner_user_id,
			'compute_identity_owner_scope_key', identity.owner_scope_key,
			'worker_class', request.worker_class,
			'status', request.status,
			'run_id', request.run_id,
			'run_status', job.status,
			'failure_reason', request.failure_reason,
			'created_at', request.created_at,
			'sponsored_at', request.sponsored_at,
			'materialized_at', request.materialized_at
		) order by request.created_at desc, request.id desc)
		from (
			select item.*
			from public.qorpera_session_turn_requests as item
			where item.session_id = p_session_id
			order by item.created_at desc, item.id desc
			limit p_limit
		) as request
		left join public.qorpera_profile_members as requester
			on requester.profile_id = request.profile_id and requester.user_id = request.requested_by_user_id
		left join public.qorpera_profile_members as sponsor_member
			on sponsor_member.profile_id = request.profile_id and sponsor_member.user_id = request.sponsored_by_user_id
		left join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = request.sponsor_binding_id and sponsor.version = request.sponsor_version
		left join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		left join public.qorpera_provider_connection_versions as connection_version
			on connection_version.connection_id = sponsor.provider_connection_id
			and connection_version.version = sponsor.provider_connection_version
		left join public.qorpera_member_compute_identities as identity
			on identity.id = request.compute_identity_id
		left join public.qorpera_execution_runs as run on run.id = request.run_id
		left join public.qorpera_runner_jobs as job on job.id = run.job_id
	), '[]'::jsonb);
end
$$;

create function public.qorpera_acquire_native_provider_connection_lease(
	p_run_id uuid,
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_assignment_id uuid,
	p_lease_token_sha256 text,
	p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_policy public.qorpera_provider_execution_policies%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_active integer;
begin
	if auth.role() <> 'service_role' or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_seconds not between 30 and 900 then
		raise exception 'native provider lease request is invalid' using errcode = '42501';
	end if;
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256,
		(select run.job_id from public.qorpera_execution_runs as run where run.id = p_run_id),
		p_lease_token_sha256
	);
	if v_job.run_id is distinct from p_run_id then
		raise exception 'native provider lease names another execution run' using errcode = '42501';
	end if;
	select run.* into strict v_run
	from public.qorpera_execution_runs as run where run.id = p_run_id;
	select sponsor.* into strict v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	select connection.* into strict v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id and connection.status = 'active'
	for update;
	select version.* into strict v_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_connection.id
		and version.version = v_sponsor.provider_connection_version
		and version.authentication_mode = 'native_subscription'
		and version.authorization_state = 'active';
	select capsule.* into strict v_capsule
	from public.qorpera_native_credential_capsules as capsule
	where capsule.id = v_version.credential_capsule_id and capsule.status = 'active';
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_run.compute_identity_id and identity.status = 'active';
	select policy.* into strict v_policy
	from public.qorpera_provider_execution_policies as policy
	where policy.provider = v_connection.provider
		and policy.authentication_mode = 'native_subscription'
		and policy.native_harness = v_version.native_harness
		and policy.implementation_status = 'supported'
		and policy.enablement_status = 'enabled';
	if v_run.compute_identity_id is null or v_run.compute_identity_id <> v_capsule.compute_identity_id
		or v_capsule.ownership_kind <> v_identity.ownership_kind
		or v_capsule.owner_user_id is distinct from v_identity.owner_user_id
		or v_capsule.owner_scope_key is distinct from v_identity.owner_scope_key
		or v_job.status <> 'leased' or v_job.runner_id <> p_runner_id
		or v_job.client_lease_id <> p_assignment_id
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.run_id = v_run.id
				and assignment.job_id = v_job.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted' and assignment.expires_at > statement_timestamp()
		) then
		raise exception 'native provider lease is outside the accepted assignment' using errcode = '42501';
	end if;
	select lease.* into v_lease
	from public.qorpera_native_provider_connection_leases as lease
	where lease.run_id = v_run.id
	for update;
	if found then
		if v_lease.job_id <> v_job.id
			or v_lease.provider_connection_id <> v_connection.id
			or v_lease.provider_connection_version <> v_version.version
			or v_lease.credential_capsule_id <> v_capsule.id
			or v_lease.compute_identity_id <> v_run.compute_identity_id
			or v_lease.runner_id <> p_runner_id
			or v_lease.assignment_id <> p_assignment_id
			or v_lease.lease_token_sha256 <> p_lease_token_sha256 then
			raise exception 'native provider lease is already bound to another assignment' using errcode = '23505';
		end if;
		update public.qorpera_native_provider_connection_leases
		set status = 'active',
			expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
			released_at = null
		where id = v_lease.id
		returning * into v_lease;
		return jsonb_build_object(
			'lease_id', v_lease.id,
			'run_id', v_lease.run_id,
			'provider_connection_id', v_lease.provider_connection_id,
			'provider_connection_version', v_lease.provider_connection_version,
			'credential_capsule_id', v_lease.credential_capsule_id,
			'encrypted_capsule_reference', v_capsule.encrypted_capsule_reference,
			'attestation_policy_sha256', v_capsule.attestation_policy_sha256,
			'compute_identity_id', v_lease.compute_identity_id,
			'compute_identity_ownership_kind', v_identity.ownership_kind,
			'compute_identity_owner_user_id', v_identity.owner_user_id,
			'compute_identity_owner_scope_key', v_identity.owner_scope_key,
			'credential_ownership_kind', v_capsule.ownership_kind,
			'credential_owner_user_id', v_capsule.owner_user_id,
			'credential_owner_scope_key', v_capsule.owner_scope_key,
			'provider', v_connection.provider,
			'authentication_mode', 'native_subscription',
			'native_harness', v_version.native_harness,
			'runner_id', v_lease.runner_id,
			'assignment_id', v_lease.assignment_id,
			'expires_at', v_lease.expires_at
		);
	end if;
	update public.qorpera_native_provider_connection_leases
	set status = 'expired', released_at = statement_timestamp()
	where provider_connection_id = v_connection.id and status = 'active'
		and expires_at <= statement_timestamp();
	select count(*) into v_active
	from public.qorpera_native_provider_connection_leases as lease
	where lease.provider_connection_id = v_connection.id and lease.status = 'active';
	if v_active >= least(v_version.max_native_concurrency, v_policy.max_native_concurrency) then
		raise exception 'native provider connection already has its allowed execution lease' using errcode = '55000';
	end if;
	insert into public.qorpera_native_provider_connection_leases (
		run_id, job_id, provider_connection_id, provider_connection_version,
		credential_capsule_id, compute_identity_id, runner_id, assignment_id,
		lease_token_sha256, expires_at
	) values (
		v_run.id, v_job.id, v_connection.id, v_version.version, v_capsule.id,
		v_run.compute_identity_id, p_runner_id, p_assignment_id, p_lease_token_sha256,
		statement_timestamp() + make_interval(secs => p_lease_seconds)
	) returning * into v_lease;
	return jsonb_build_object(
		'lease_id', v_lease.id,
		'run_id', v_lease.run_id,
		'provider_connection_id', v_lease.provider_connection_id,
		'provider_connection_version', v_lease.provider_connection_version,
		'credential_capsule_id', v_lease.credential_capsule_id,
		'encrypted_capsule_reference', v_capsule.encrypted_capsule_reference,
		'attestation_policy_sha256', v_capsule.attestation_policy_sha256,
		'compute_identity_id', v_lease.compute_identity_id,
		'compute_identity_ownership_kind', v_identity.ownership_kind,
		'compute_identity_owner_user_id', v_identity.owner_user_id,
		'compute_identity_owner_scope_key', v_identity.owner_scope_key,
		'credential_ownership_kind', v_capsule.ownership_kind,
		'credential_owner_user_id', v_capsule.owner_user_id,
		'credential_owner_scope_key', v_capsule.owner_scope_key,
		'provider', v_connection.provider,
		'authentication_mode', 'native_subscription',
		'native_harness', v_version.native_harness,
		'runner_id', v_lease.runner_id,
		'assignment_id', v_lease.assignment_id,
		'expires_at', v_lease.expires_at
	);
end
$$;

create function public.qorpera_release_native_provider_connection_lease(
	p_lease_id uuid,
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_status text default 'released'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
begin
	if auth.role() <> 'service_role' or p_status not in ('released', 'revoked', 'expired') then
		raise exception 'native provider lease release is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	update public.qorpera_native_provider_connection_leases
	set status = p_status, released_at = statement_timestamp()
	where id = p_lease_id and runner_id = p_runner_id and job_id = p_job_id
		and lease_token_sha256 = p_lease_token_sha256 and status = 'active'
	returning * into v_lease;
	if not found then
		raise exception 'native provider lease is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object('lease_id', v_lease.id, 'status', v_lease.status);
end
$$;

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
			select identity.ownership_kind
			from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'compute_identity_owner_user_id', (
			select identity.owner_user_id
			from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'compute_identity_owner_scope_key', (
			select identity.owner_scope_key
			from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'worker_class', p_run.worker_class,
		'requested_by_user_id', p_run.requested_by_user_id,
		'sponsored_by_user_id', p_run.sponsored_by_user_id,
		'transcript_start_sequence', p_run.transcript_start_sequence,
		'status', coalesce((
			select event.event_type
			from public.qorpera_execution_run_events as event
			where event.run_id = p_run.id
			order by event.id desc limit 1
		), 'queued'),
		'created_by_user_id', p_run.created_by_user_id,
		'created_at', p_run.created_at,
		'deadline_at', p_run.deadline_at
	)
$$;

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
	where run.id = p_claim.run_id
$$;

create function public.qorpera_materialize_session_turn_requests(p_limit integer default 32)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_request public.qorpera_session_turn_requests%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_capsule public.qorpera_native_credential_capsules%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_payload jsonb;
	v_payload_sha256 text;
	v_transcript_start_sequence bigint;
	v_claimed integer;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 64 then
		raise exception 'session turn materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_request in
		select request.*
		from public.qorpera_session_turn_requests as request
		join public.qorpera_shared_sessions as session
			on session.id = request.session_id and session.status = 'open'
		join public.qorpera_session_inputs as input
			on input.id = request.input_id and input.session_id = request.session_id
		join public.qorpera_company_files as file
			on file.profile_id = request.profile_id and file.environment_id = session.environment_id
		where request.status = 'queued'
			and input.completed_at is null and input.failed_at is null
			and input.execution_run_id is null and input.turn_id is null
			and file.head_snapshot_id is not null
			and exists (
				select 1 from public.qorpera_company_substrate_versions as substrate
				where substrate.profile_id = request.profile_id
					and substrate.environment_id = session.environment_id
					and substrate.company_snapshot_id = file.head_snapshot_id
			)
		order by request.created_at, request.id
		for update of request skip locked
		limit p_limit
	loop
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.id = v_request.session_id
		for update;
		if not found or v_session.status <> 'open' or exists (
			select 1
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.session_id = v_session.id and run.source_kind = 'session_turn'
				and job.status in ('queued', 'leased')
		) or exists (
			select 1 from public.qorpera_session_turns as legacy_turn
			where legacy_turn.session_id = v_session.id and legacy_turn.status = 'active'
		) then
			continue;
		end if;
		select input.* into v_input
		from public.qorpera_session_inputs as input
		where input.id = v_request.input_id and input.session_id = v_session.id
		for update;
		if not found or v_input.completed_at is not null or v_input.failed_at is not null
			or v_input.execution_run_id is not null or v_input.turn_id is not null then
			continue;
		end if;
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_request.profile_id and file.environment_id = v_session.environment_id
		for share;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_request.profile_id
			and substrate.environment_id = v_session.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_request.profile_id
			and staff.staff_agent_id = v_session.staff_agent_id::uuid
			and staff.employment_status = 'active';
		if v_file.head_snapshot_id is null or v_substrate.id is null or v_staff.staff_agent_id is null then
			continue;
		end if;
		select binding.* into v_binding
		from public.qorpera_execution_sponsor_bindings as binding
		where binding.id = v_request.sponsor_binding_id
			and binding.profile_id = v_request.profile_id and binding.status = 'active';
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_request.sponsor_binding_id
			and sponsor.version = v_request.sponsor_version;
		select connection.* into v_connection
		from public.qorpera_provider_connections as connection
		where connection.id = v_sponsor.provider_connection_id
			and connection.profile_id = v_request.profile_id and connection.status = 'active';
		select version.* into v_connection_version
		from public.qorpera_provider_connection_versions as version
		where version.connection_id = v_sponsor.provider_connection_id
			and version.version = v_sponsor.provider_connection_version
			and version.authorization_state = 'active';
		if v_request.compute_identity_id is not null then
			select identity.* into v_identity
			from public.qorpera_member_compute_identities as identity
			where identity.id = v_request.compute_identity_id
				and identity.profile_id = v_request.profile_id and identity.status = 'active';
		else
			v_identity := null;
		end if;
		if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
			or v_connection_version.connection_id is null
			or (v_request.sponsor_mode in ('member_connection', 'sponsorship_request') and (
				v_sponsor.sponsor_kind <> 'member_connection'
				or v_connection.owner_user_id is distinct from v_request.sponsored_by_user_id
				or v_identity.ownership_kind <> 'member'
				or v_identity.owner_user_id is distinct from v_request.sponsored_by_user_id
				or not exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = v_request.profile_id
						and member.user_id = v_request.sponsored_by_user_id
				)
			))
			or (v_request.sponsor_mode = 'company_connection' and (
				v_sponsor.sponsor_kind = 'member_connection'
				or v_identity.id is null or v_identity.ownership_kind = 'member'
			))
			or (v_request.logical_computer_id is not null and not exists (
				select 1 from public.qorpera_logical_computers as computer
				where computer.id = v_request.logical_computer_id
					and computer.profile_id = v_request.profile_id and computer.status = 'active'
					and computer.computer_class = v_request.worker_class
					and computer.compute_identity_id is not distinct from v_request.compute_identity_id
					and computer.capabilities ? v_request.required_capability
			)) then
			update public.qorpera_session_turn_requests
			set status = 'failed', failure_reason = 'The selected execution sponsor or computer is no longer available'
			where id = v_request.id;
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(),
				failure_reason = 'The selected execution sponsor or computer is no longer available'
			where id = v_input.id;
			continue;
		end if;
		if v_connection_version.authentication_mode = 'native_subscription' then
			select capsule.* into v_capsule
			from public.qorpera_native_credential_capsules as capsule
			where capsule.id = v_connection_version.credential_capsule_id
				and capsule.compute_identity_id = v_request.compute_identity_id
				and capsule.ownership_kind = v_identity.ownership_kind
				and capsule.owner_user_id is not distinct from v_identity.owner_user_id
				and capsule.owner_scope_key is not distinct from v_identity.owner_scope_key
				and capsule.status = 'active';
			if v_capsule.id is null or not public.qorpera_provider_execution_enabled(
				v_connection.provider, 'native_subscription', v_connection_version.native_harness
			) then
				update public.qorpera_session_turn_requests
				set status = 'failed', failure_reason = 'The selected native provider connection is not enabled'
				where id = v_request.id;
				update public.qorpera_session_inputs
				set failed_at = statement_timestamp(),
					failure_reason = 'The selected native provider connection is not enabled'
				where id = v_input.id;
				continue;
			end if;
		end if;
		v_payload := jsonb_build_object(
			'schema', 'qorpera.sponsored-session-turn/v1',
			'turn_request_id', v_request.id,
			'session_id', v_session.id,
			'input_ids', jsonb_build_array(v_input.id),
			'requested_by_user_id', v_request.requested_by_user_id,
			'sponsored_by_user_id', v_request.sponsored_by_user_id,
			'sponsor_mode', v_request.sponsor_mode,
			'compute_identity_id', v_request.compute_identity_id,
			'worker_class', v_request.worker_class
		);
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		select coalesce(max(event.sequence), 0) into v_transcript_start_sequence
		from public.qorpera_session_events as event where event.session_id = v_session.id;
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_request.profile_id, v_session.environment_id, v_session.id, v_substrate.id, v_request.id,
			v_request.required_capability, v_request.job_type, v_payload, v_request.requested_by_user_id
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
			publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
			compute_identity_id, worker_class, requested_by_user_id, sponsored_by_user_id,
			transcript_start_sequence, created_by_user_id
		) values (
			v_request.id, v_request.profile_id, v_session.environment_id, 'session_turn', v_request.id,
			v_session.id, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, array[v_input.id],
			v_request.sponsor_binding_id, v_request.sponsor_version,
			v_request.required_capability, v_request.job_type, v_payload_sha256,
			v_request.publication_mode, v_request.review_policy_key, v_request.reviewer_staff_ids,
			v_request.logical_computer_id, v_request.compute_identity_id, v_request.worker_class,
			v_request.requested_by_user_id, v_request.sponsored_by_user_id,
			v_transcript_start_sequence, v_request.requested_by_user_id
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_session_turn_requests
			set status = 'failed', failure_reason = 'The selected sponsor quota or model authority is unavailable'
			where id = v_request.id;
			update public.qorpera_session_inputs
			set failed_at = statement_timestamp(),
				failure_reason = 'The selected sponsor quota or model authority is unavailable'
			where id = v_input.id;
			continue;
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = v_run.id
		where id = v_input.id and execution_run_id is null and turn_id is null
			and completed_at is null and failed_at is null;
		get diagnostics v_claimed = row_count;
		if v_claimed <> 1 then
			raise exception 'session input changed during sponsored turn materialization' using errcode = '40001';
		end if;
		v_transcript_start_sequence := public.qorpera_append_execution_input_events(
			v_session.id, array[v_input.id]
		);
		update public.qorpera_execution_runs
		set transcript_start_sequence = v_transcript_start_sequence
		where id = v_run.id
		returning * into v_run;
		update public.qorpera_session_turn_requests
		set status = 'materialized', run_id = v_run.id, materialized_at = statement_timestamp()
		where id = v_request.id;
		update public.qorpera_shared_sessions
		set company_snapshot_id = v_file.head_snapshot_id,
			staff_version = v_staff.version,
			updated_at = statement_timestamp()
		where id = v_session.id;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'queued', jsonb_build_object(
			'input_count', 1,
			'turn_request_id', v_request.id,
			'requested_by_user_id', v_request.requested_by_user_id,
			'sponsored_by_user_id', v_request.sponsored_by_user_id,
			'sponsor_binding_id', v_request.sponsor_binding_id,
			'sponsor_version', v_request.sponsor_version
		));
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;

alter function public.qorpera_reconcile_runner_orchestrator(uuid)
	rename to qorpera_reconcile_runner_orchestrator_without_sponsored_turns;

create function public.qorpera_reconcile_runner_orchestrator(p_orchestrator_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform public.qorpera_materialize_session_turn_requests(32);
	return public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(p_orchestrator_id);
end
$$;

revoke all on function public.qorpera_retire_member_compute_identity() from public;
revoke all on function public.qorpera_execution_run_native_provenance() from public;
revoke all on function public.qorpera_provider_execution_enabled(text, text, text) from public;
revoke all on function public.qorpera_set_provider_execution_policy(text, text, text, text, text, integer, text, text) from public;
revoke all on function public.qorpera_upsert_member_compute_identity(uuid, uuid, text, text, text, jsonb, jsonb) from public;
revoke all on function public.qorpera_upsert_scoped_compute_identity(uuid, uuid, text, text, text, text, text, jsonb, jsonb) from public;
revoke all on function public.qorpera_begin_native_provider_login(uuid, uuid, uuid, uuid, text, text, text, integer) from public;
revoke all on function public.qorpera_complete_native_provider_login(uuid, text, uuid, text, text, text, text, text, jsonb) from public;
revoke all on function public.qorpera_create_member_execution_sponsor(uuid, uuid, uuid, bigint, boolean) from public;
revoke all on function public.qorpera_request_session_turn(uuid, uuid, uuid, jsonb, text, uuid, bigint, uuid, uuid, uuid, text, text, text, text, text, uuid[]) from public;
revoke all on function public.qorpera_approve_session_turn_sponsorship(uuid, uuid, bigint, uuid, uuid, text) from public;
revoke all on function public.qorpera_list_member_native_execution_connections(uuid) from public;
revoke all on function public.qorpera_list_compute_identities(uuid) from public;
revoke all on function public.qorpera_list_session_turn_requests(uuid, integer) from public;
revoke all on function public.qorpera_acquire_native_provider_connection_lease(uuid, uuid, text, uuid, text, integer) from public;
revoke all on function public.qorpera_release_native_provider_connection_lease(uuid, uuid, text, uuid, text, text) from public;
revoke all on function public.qorpera_materialize_session_turn_requests(integer) from public;
revoke all on function public.qorpera_reconcile_runner_orchestrator(uuid) from public;

grant execute on function public.qorpera_upsert_member_compute_identity(uuid, uuid, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.qorpera_upsert_scoped_compute_identity(uuid, uuid, text, text, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.qorpera_begin_native_provider_login(uuid, uuid, uuid, uuid, text, text, text, integer) to authenticated;
grant execute on function public.qorpera_create_member_execution_sponsor(uuid, uuid, uuid, bigint, boolean) to authenticated;
grant execute on function public.qorpera_request_session_turn(uuid, uuid, uuid, jsonb, text, uuid, bigint, uuid, uuid, uuid, text, text, text, text, text, uuid[]) to authenticated;
grant execute on function public.qorpera_approve_session_turn_sponsorship(uuid, uuid, bigint, uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_list_member_native_execution_connections(uuid) to authenticated;
grant execute on function public.qorpera_list_compute_identities(uuid) to authenticated;
grant execute on function public.qorpera_list_session_turn_requests(uuid, integer) to authenticated;
grant execute on function public.qorpera_set_provider_execution_policy(text, text, text, text, text, integer, text, text) to service_role;
grant execute on function public.qorpera_complete_native_provider_login(uuid, text, uuid, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.qorpera_acquire_native_provider_connection_lease(uuid, uuid, text, uuid, text, integer) to service_role;
grant execute on function public.qorpera_release_native_provider_connection_lease(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.qorpera_materialize_session_turn_requests(integer) to service_role;
grant execute on function public.qorpera_reconcile_runner_orchestrator(uuid) to service_role;
