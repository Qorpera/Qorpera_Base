-- Durable control-plane contracts for cloud execution.
--
-- Supabase owns queued work, immutable run pins, sponsorship, orchestration
-- claims, assignments, and leases. Runners never select global work. A
-- separate orchestrator claims a job, chooses a physical runner, and delivers
-- one short-lived assignment capability out of band.

create function public.qorpera_provider_quota_policy_valid(p_policy jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_key text;
	v_monthly bigint;
	v_reservation bigint;
begin
	if p_policy is null or jsonb_typeof(p_policy) <> 'object' then return false; end if;
	for v_key in select jsonb_object_keys(p_policy)
	loop
		if v_key not in (
			'monthly_microusd', 'reservation_microusd', 'max_calls_per_run',
			'max_input_tokens_per_run', 'max_output_tokens_per_run', 'max_concurrent_runs'
		) then return false; end if;
	end loop;
	if not p_policy ?& array[
		'monthly_microusd', 'reservation_microusd', 'max_calls_per_run',
		'max_input_tokens_per_run', 'max_output_tokens_per_run', 'max_concurrent_runs'
	] then return false; end if;
	if exists (
		select 1 from jsonb_each_text(p_policy) as field(key, value)
		where field.value !~ '^[0-9]+$'
	) then return false; end if;
	v_monthly := (p_policy ->> 'monthly_microusd')::bigint;
	v_reservation := (p_policy ->> 'reservation_microusd')::bigint;
	return v_monthly between 1 and 9007199254740991
		and v_reservation between 1 and v_monthly
		and (p_policy ->> 'max_calls_per_run')::bigint between 1 and 128
		and (p_policy ->> 'max_input_tokens_per_run')::bigint between 1 and 100000000
		and (p_policy ->> 'max_output_tokens_per_run')::bigint between 1 and 100000000
		and (p_policy ->> 'max_concurrent_runs')::bigint between 1 and 1000;
exception when others then
	return false;
end
$$;

revoke all on function public.qorpera_provider_quota_policy_valid(jsonb) from public;

create function public.qorpera_uuid_array_is_unique(p_values uuid[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
	select cardinality(p_values) = (
		select count(distinct item.value)
		from unnest(p_values) as item(value)
	)
$$;

revoke all on function public.qorpera_uuid_array_is_unique(uuid[]) from public;

create table public.qorpera_provider_connections (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_connection_id uuid not null,
	owner_user_id uuid references auth.users(id) on delete restrict,
	provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
	status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_connection_id)
);

create table public.qorpera_provider_connection_versions (
	connection_id uuid not null references public.qorpera_provider_connections(id) on delete restrict,
	version bigint not null check (version > 0),
	authentication_mode text not null check (authentication_mode in (
		'native_subscription', 'enterprise_access_token', 'api_key', 'cloud_service_account'
	)),
	native_harness text not null check (
		char_length(btrim(native_harness)) between 1 and 120 and native_harness !~ E'[\r\n]'
	),
	secret_reference text not null check (
		char_length(btrim(secret_reference)) between 1 and 512 and secret_reference !~ E'[\r\n]'
	),
	provider_account_reference text check (
		provider_account_reference is null
		or (char_length(btrim(provider_account_reference)) between 1 and 512
			and provider_account_reference !~ E'[\r\n]')
	),
	billing_source text not null check (
		char_length(btrim(billing_source)) between 1 and 120 and billing_source !~ E'[\r\n]'
	),
	consent_version text not null check (
		char_length(btrim(consent_version)) between 1 and 120 and consent_version !~ E'[\r\n]'
	),
	consented_by_user_id uuid not null references auth.users(id) on delete restrict,
	consented_at timestamptz not null default statement_timestamp(),
	allow_autonomous boolean not null default false,
	commercial_approval_reference text check (
		commercial_approval_reference is null
		or (char_length(btrim(commercial_approval_reference)) between 1 and 512
			and commercial_approval_reference !~ E'[\r\n]')
	),
	quota_policy jsonb not null default '{}'::jsonb check (
		pg_column_size(quota_policy) <= 16384
		and public.qorpera_provider_quota_policy_valid(quota_policy)
	),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	primary key (connection_id, version)
);

create table public.qorpera_execution_sponsor_bindings (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_binding_id uuid not null,
	status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_binding_id)
);

create table public.qorpera_execution_sponsor_versions (
	binding_id uuid not null references public.qorpera_execution_sponsor_bindings(id) on delete restrict,
	version bigint not null check (version > 0),
	sponsor_kind text not null check (sponsor_kind in (
		'member_connection', 'company_service_account', 'company_api_billing'
	)),
	provider_connection_id uuid not null,
	provider_connection_version bigint not null,
	allow_autonomous boolean not null default false,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	primary key (binding_id, version),
	foreign key (provider_connection_id, provider_connection_version)
		references public.qorpera_provider_connection_versions(connection_id, version) on delete restrict
);

create table public.qorpera_logical_computers (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	client_computer_id uuid not null,
	display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
	template_key text not null check (template_key ~ '^[a-z][a-z0-9._-]{0,119}$'),
	template_version text not null check (
		char_length(btrim(template_version)) between 1 and 120 and template_version !~ E'[\r\n]'
	),
	capabilities jsonb not null check (public.qorpera_runner_capabilities_valid(capabilities)),
	policy jsonb not null default '{}'::jsonb check (
		jsonb_typeof(policy) = 'object' and pg_column_size(policy) <= 65536
	),
	encrypted_volume_object_sha256 text check (encrypted_volume_object_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'active' check (status in ('active', 'disabled', 'retired')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_computer_id),
	foreign key (profile_id, encrypted_volume_object_sha256)
		references public.qorpera_profile_objects(profile_id, sha256) on delete restrict
);

alter table public.qorpera_runners
	add column logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict;

-- Review work uses the named staff member's explicitly configured execution
-- authority. It must never silently inherit the producing run's provider,
-- because the reviewer can use a different native model/provider connection.
create table public.qorpera_staff_execution_authorities (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	staff_agent_id uuid not null,
	sponsor_binding_id uuid not null,
	sponsor_version bigint not null,
	logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
	configured_by_user_id uuid not null references auth.users(id) on delete restrict,
	configured_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, staff_agent_id),
	foreign key (profile_id, staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete restrict,
	foreign key (sponsor_binding_id, sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict
);

alter table public.qorpera_staff_execution_authorities enable row level security;
revoke all on public.qorpera_staff_execution_authorities from anon, authenticated;

create table public.qorpera_execution_runs (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	source_kind text not null check (source_kind in (
		'session_turn', 'wake', 'manual', 'room_delivery', 'system'
	)),
	source_id uuid not null,
	session_id uuid references public.qorpera_shared_sessions(id) on delete restrict,
	job_id uuid not null unique references public.qorpera_runner_jobs(id) on delete restrict,
	substrate_version_id uuid not null references public.qorpera_company_substrate_versions(id) on delete restrict,
	company_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	staff_agent_id uuid not null,
	staff_version bigint not null check (staff_version > 0),
	input_ids uuid[] not null default '{}'::uuid[] check (cardinality(input_ids) <= 32),
	sponsor_binding_id uuid not null,
	sponsor_version bigint not null,
	required_capability text not null check (
		required_capability in ('agent_turn', 'git_worktree', 'company_substrate')
	),
	job_type text not null check (job_type ~ '^[a-z][a-z0-9_-]{0,63}$'),
	payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
	publication_mode text not null default 'automatic' check (publication_mode in ('automatic', 'review')),
	review_policy_key text check (
		review_policy_key is null
		or (char_length(btrim(review_policy_key)) between 1 and 128 and review_policy_key !~ E'[\r\n]')
	),
	reviewer_staff_ids uuid[] not null default '{}'::uuid[] check (
		cardinality(reviewer_staff_ids) <= 20 and public.qorpera_uuid_array_is_unique(reviewer_staff_ids)
	),
	logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
	transcript_start_sequence bigint not null check (transcript_start_sequence >= 0),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	deadline_at timestamptz not null default statement_timestamp() + interval '6 hours',
	unique (id, profile_id),
	unique (profile_id, source_kind, source_id),
	check (
		(publication_mode = 'automatic' and review_policy_key is null and cardinality(reviewer_staff_ids) = 0)
		or (publication_mode = 'review' and review_policy_key is not null and cardinality(reviewer_staff_ids) > 0)
	),
	check ((source_kind = 'session_turn') = (cardinality(input_ids) > 0)),
	check (deadline_at > created_at and deadline_at <= created_at + interval '24 hours'),
	foreign key (sponsor_binding_id, sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict
);

alter table public.qorpera_execution_runs
	drop constraint qorpera_execution_runs_source_kind_check,
	add constraint qorpera_execution_runs_source_kind_check check (source_kind in (
		'session_turn', 'wake', 'manual', 'room_delivery', 'proposal_review', 'system'
	));

alter table public.qorpera_company_proposal_comments
	alter column author_user_id drop not null,
	add column author_staff_agent_id uuid,
	add constraint qorpera_company_proposal_comments_one_author check (
		num_nonnulls(author_user_id, author_staff_agent_id) = 1
	);

create table public.qorpera_company_proposal_review_assignments (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	proposal_id uuid not null,
	proposal_revision bigint not null,
	reviewer_staff_agent_id uuid not null,
	reviewer_sponsor_binding_id uuid not null,
	reviewer_sponsor_version bigint not null,
	reviewer_logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
	status text not null default 'queued' check (
		status in ('queued', 'running', 'approved', 'changes_requested', 'failed')
	),
	run_id uuid unique references public.qorpera_execution_runs(id) on delete restrict,
	comment_id uuid unique references public.qorpera_company_proposal_comments(id) on delete restrict,
	failure_reason text check (
		failure_reason is null or char_length(btrim(failure_reason)) between 1 and 1000
	),
	created_at timestamptz not null default statement_timestamp(),
	started_at timestamptz,
	completed_at timestamptz,
	unique (proposal_id, proposal_revision, reviewer_staff_agent_id),
	foreign key (proposal_id, proposal_revision)
		references public.qorpera_company_proposal_revisions(proposal_id, revision) on delete restrict,
	foreign key (profile_id, reviewer_staff_agent_id)
		references public.qorpera_profile_staff(profile_id, staff_agent_id) on delete restrict,
	foreign key (reviewer_sponsor_binding_id, reviewer_sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict,
	check (
		(status = 'queued' and run_id is null and started_at is null and completed_at is null)
		or (status = 'running' and run_id is not null and started_at is not null and completed_at is null)
		or (status in ('approved', 'changes_requested')
			and run_id is not null and comment_id is not null and started_at is not null and completed_at is not null)
		or (status = 'failed' and comment_id is null and failure_reason is not null and completed_at is not null
			and ((run_id is null and started_at is null) or (run_id is not null and started_at is not null)))
	)
);

create index qorpera_company_proposal_reviews_queue
	on public.qorpera_company_proposal_review_assignments (created_at, id)
	where status = 'queued';

alter table public.qorpera_company_proposal_review_assignments enable row level security;
revoke all on public.qorpera_company_proposal_review_assignments from anon, authenticated;

create function public.qorpera_seed_company_proposal_reviews()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_inserted integer;
begin
	update public.qorpera_runner_jobs as job
	set status = 'cancelled',
		terminal_lease_token_sha256 = case
			when job.status = 'leased' then job.lease_token_sha256
			else job.terminal_lease_token_sha256
		end,
		lease_token_sha256 = null, lease_expires_at = null,
		finished_at = statement_timestamp(),
		last_error = 'Proposal review was superseded by a newer revision'
	from public.qorpera_company_proposal_review_assignments as review
	where review.proposal_id = new.proposal_id and review.proposal_revision < new.revision
		and review.status = 'running' and job.run_id = review.run_id
		and job.status in ('queued', 'leased');
	update public.qorpera_company_proposal_review_assignments
	set status = 'failed', completed_at = statement_timestamp(),
		failure_reason = 'Proposal review was superseded by a newer revision'
	where proposal_id = new.proposal_id and proposal_revision < new.revision
		and status in ('queued', 'running');
	insert into public.qorpera_company_proposal_review_assignments (
		profile_id, proposal_id, proposal_revision, reviewer_staff_agent_id,
		reviewer_sponsor_binding_id, reviewer_sponsor_version, reviewer_logical_computer_id
	)
	select proposal.profile_id, proposal.id, new.revision, reviewer.staff_agent_id,
		authority.sponsor_binding_id, authority.sponsor_version, authority.logical_computer_id
	from public.qorpera_company_proposals as proposal
	cross join unnest(proposal.reviewer_staff_ids) as reviewer(staff_agent_id)
	join public.qorpera_staff_execution_authorities as authority
		on authority.profile_id = proposal.profile_id and authority.staff_agent_id = reviewer.staff_agent_id
	where proposal.id = new.proposal_id and proposal.execution_kind = 'run'
	on conflict (proposal_id, proposal_revision, reviewer_staff_agent_id) do nothing;
	get diagnostics v_inserted = row_count;
	if v_inserted <> coalesce((
		select cardinality(proposal.reviewer_staff_ids)
		from public.qorpera_company_proposals as proposal
		where proposal.id = new.proposal_id and proposal.execution_kind = 'run'
	), 0) then
		raise exception 'proposal reviewer execution authority is unavailable' using errcode = '55000';
	end if;
	return new;
end
$$;

create trigger qorpera_seed_company_proposal_reviews
after insert on public.qorpera_company_proposal_revisions
for each row execute function public.qorpera_seed_company_proposal_reviews();

insert into public.qorpera_company_proposal_review_assignments (
	profile_id, proposal_id, proposal_revision, reviewer_staff_agent_id,
	reviewer_sponsor_binding_id, reviewer_sponsor_version, reviewer_logical_computer_id
)
select proposal.profile_id, proposal.id, revision.revision, reviewer.staff_agent_id,
	authority.sponsor_binding_id, authority.sponsor_version, authority.logical_computer_id
from public.qorpera_company_proposals as proposal
join public.qorpera_company_proposal_revisions as revision on revision.proposal_id = proposal.id
cross join unnest(proposal.reviewer_staff_ids) as reviewer(staff_agent_id)
join public.qorpera_staff_execution_authorities as authority
	on authority.profile_id = proposal.profile_id and authority.staff_agent_id = reviewer.staff_agent_id
where proposal.execution_kind = 'run'
on conflict (proposal_id, proposal_revision, reviewer_staff_agent_id) do nothing;

alter table public.qorpera_runner_model_policies
	add column max_cost_microusd bigint not null default 9007199254740991
		check (max_cost_microusd between 1 and 9007199254740991);

alter table public.qorpera_runner_model_requests
	drop constraint qorpera_runner_model_requests_status_check,
	drop constraint qorpera_runner_model_requests_check,
	add constraint qorpera_runner_model_requests_status_check
		check (status in ('reserved', 'completed', 'failed', 'ambiguous')),
	add constraint qorpera_runner_model_requests_check check (
		(status = 'reserved' and response is null and error_code is null and finalized_at is null)
		or (status = 'completed' and response is not null and error_code is null and finalized_at is not null)
		or (status in ('failed', 'ambiguous') and response is null and error_code is not null and finalized_at is not null)
	);

create table public.qorpera_execution_sponsor_reservations (
	run_id uuid primary key references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null unique references public.qorpera_runner_jobs(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	binding_id uuid not null,
	sponsor_version bigint not null,
	provider_connection_id uuid not null,
	provider_connection_version bigint not null,
	period_start timestamptz not null,
	reserved_microusd bigint not null check (reserved_microusd between 1 and 9007199254740991),
	actual_microusd bigint check (actual_microusd between 0 and 9007199254740991),
	status text not null default 'reserved' check (status in ('reserved', 'settled')),
	created_at timestamptz not null default statement_timestamp(),
	settled_at timestamptz,
	foreign key (binding_id, sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict,
	foreign key (provider_connection_id, provider_connection_version)
		references public.qorpera_provider_connection_versions(connection_id, version) on delete restrict,
	check ((status = 'settled') = (actual_microusd is not null and settled_at is not null))
);

create table public.qorpera_execution_run_budgets (
	run_id uuid primary key references public.qorpera_execution_runs(id) on delete restrict,
	transcript_event_count integer not null default 0 check (transcript_event_count between 0 and 2000),
	transcript_bytes bigint not null default 0 check (transcript_bytes between 0 and 67108864),
	operation_count integer not null default 0 check (operation_count between 0 and 256),
	company_object_count integer not null default 0 check (company_object_count between 0 and 8500000),
	company_object_bytes bigint not null default 0 check (company_object_bytes between 0 and 1099511627776),
	created_at timestamptz not null default statement_timestamp()
);

create index qorpera_execution_sponsor_reservations_budget
	on public.qorpera_execution_sponsor_reservations (
		provider_connection_id, provider_connection_version, period_start, status
	);

alter table public.qorpera_runner_jobs
	add column run_id uuid unique references public.qorpera_execution_runs(id) on delete restrict,
	add column dispatch_failure_count integer not null default 0
		check (dispatch_failure_count between 0 and 8);

alter table public.qorpera_session_inputs
	add column execution_run_id uuid references public.qorpera_execution_runs(id) on delete restrict;

create index qorpera_session_inputs_execution_run
	on public.qorpera_session_inputs (execution_run_id, position)
	where execution_run_id is not null;

create table public.qorpera_session_execution_bindings (
	session_id uuid primary key references public.qorpera_shared_sessions(id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	staff_agent_id uuid not null,
	sponsor_binding_id uuid not null,
	sponsor_version bigint not null,
	logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
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
	configured_by_user_id uuid not null references auth.users(id) on delete restrict,
	configured_at timestamptz not null default statement_timestamp(),
	foreign key (sponsor_binding_id, sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict,
	check (
		(publication_mode = 'automatic' and review_policy_key is null and cardinality(reviewer_staff_ids) = 0)
		or (publication_mode = 'review' and review_policy_key is not null and cardinality(reviewer_staff_ids) > 0)
	)
);

-- Recurring work is company control-plane state, not a desktop preference.
-- Definitions are versioned so an occurrence and its eventual run always
-- preserve the exact prompt, trigger, sponsor, placement, and review policy
-- that existed when the occurrence was admitted.
create table public.qorpera_cloud_routines (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	client_routine_id uuid not null,
	current_version bigint not null default 0 check (current_version >= 0),
	status text not null default 'active' check (status in ('active', 'paused', 'retired')),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_routine_id),
	unique (id, profile_id, environment_id)
);

create table public.qorpera_cloud_routine_versions (
	routine_id uuid not null references public.qorpera_cloud_routines(id) on delete restrict,
	version bigint not null check (version > 0),
	client_version_id uuid not null,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	staff_agent_id uuid not null,
	title text not null check (octet_length(convert_to(btrim(title), 'utf8')) between 1 and 160 and title !~ E'[\r\n]'),
	prompt text not null check (octet_length(convert_to(btrim(prompt), 'utf8')) between 1 and 32768),
	triggers jsonb not null check (
		jsonb_typeof(triggers) = 'array'
		and jsonb_array_length(triggers) between 1 and 12
		and pg_column_size(triggers) <= 12288
	),
	effort text not null check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
	sponsor_binding_id uuid not null,
	sponsor_version bigint not null,
	logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
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
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	primary key (routine_id, version),
	unique (routine_id, client_version_id),
	foreign key (routine_id, profile_id, environment_id)
		references public.qorpera_cloud_routines(id, profile_id, environment_id) on delete restrict,
	foreign key (sponsor_binding_id, sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict,
	check (
		(publication_mode = 'automatic' and review_policy_key is null and cardinality(reviewer_staff_ids) = 0)
		or (publication_mode = 'review' and review_policy_key is not null and cardinality(reviewer_staff_ids) > 0)
	)
);

-- Schedule cursors are durable control-plane state. The scheduler advances a
-- cursor in the same transaction that admits its deterministic wake, so an
-- orchestrator outage or lost notification cannot silently lose a slot.
create table public.qorpera_cloud_routine_schedule_cursors (
	routine_id uuid not null,
	routine_version bigint not null,
	trigger_id text not null check (
		octet_length(convert_to(btrim(trigger_id), 'utf8')) between 1 and 160 and trigger_id !~ E'[\r\n]'
	),
	last_scheduled_for timestamptz,
	next_due_at timestamptz not null default '-infinity'::timestamptz,
	updated_at timestamptz not null default statement_timestamp(),
	primary key (routine_id, routine_version, trigger_id),
	foreign key (routine_id, routine_version)
		references public.qorpera_cloud_routine_versions(routine_id, version) on delete restrict,
	check (last_scheduled_for is null or next_due_at > last_scheduled_for)
);

create index qorpera_cloud_routine_schedule_cursors_due
	on public.qorpera_cloud_routine_schedule_cursors (next_due_at, routine_id, routine_version);

create table public.qorpera_wake_occurrences (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	routine_id uuid not null,
	routine_version bigint not null,
	trigger_id text not null check (
		octet_length(convert_to(btrim(trigger_id), 'utf8')) between 1 and 160 and trigger_id !~ E'[\r\n]'
	),
	occurrence_key text not null check (
		octet_length(convert_to(btrim(occurrence_key), 'utf8')) between 1 and 256 and occurrence_key !~ E'[\r\n]'
	),
	scheduled_for timestamptz not null,
	not_before timestamptz not null,
	payload jsonb not null default '{}'::jsonb check (
		jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192
	),
	status text not null default 'queued' check (
		status in ('queued', 'materialized', 'completed', 'failed', 'requires_review', 'cancelled')
	),
	blocked_reason text check (
		blocked_reason is null or char_length(btrim(blocked_reason)) between 1 and 1000
	),
	run_id uuid unique references public.qorpera_execution_runs(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	finished_at timestamptz,
	unique (routine_id, occurrence_key),
	foreign key (routine_id, routine_version)
		references public.qorpera_cloud_routine_versions(routine_id, version) on delete restrict,
	check (
		(status = 'queued' and run_id is null)
		or (status in ('materialized', 'completed', 'failed', 'requires_review') and run_id is not null)
		or status = 'cancelled'
	),
	check ((status in ('completed', 'failed', 'requires_review', 'cancelled')) = (finished_at is not null))
);

create index qorpera_wake_occurrences_runnable
	on public.qorpera_wake_occurrences (not_before, created_at, id)
	where status = 'queued';

create function public.qorpera_guard_runner_owned_session_input()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.turn_id is distinct from old.turn_id and (
		old.execution_run_id is not null
		or exists (
			select 1
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.session_id = old.session_id
				and run.source_kind = 'session_turn'
				and job.status in ('queued', 'leased')
		)
	) then
		raise exception 'session is owned by a cloud execution run' using errcode = '40001';
	end if;
	return new;
end
$$;

create trigger qorpera_guard_runner_owned_session_input
before update of turn_id on public.qorpera_session_inputs
for each row execute function public.qorpera_guard_runner_owned_session_input();

create function public.qorpera_guard_legacy_owned_session_input()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if old.turn_id is not null
		and new.execution_run_id is distinct from old.execution_run_id then
		raise exception 'session input is owned by a legacy execution turn' using errcode = '40001';
	end if;
	return new;
end
$$;

create trigger qorpera_guard_legacy_owned_session_input
before update of execution_run_id on public.qorpera_session_inputs
for each row execute function public.qorpera_guard_legacy_owned_session_input();

create function public.qorpera_guard_cloud_bound_legacy_turn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if exists (
		select 1 from public.qorpera_session_execution_bindings as binding
		where binding.session_id = new.session_id
	) or exists (
		select 1
		from public.qorpera_execution_runs as run
		join public.qorpera_runner_jobs as job on job.id = run.job_id
		where run.session_id = new.session_id and job.status in ('queued', 'leased')
	) then
		raise exception 'session is bound to cloud execution' using errcode = '40001';
	end if;
	return new;
end
$$;

create trigger qorpera_guard_cloud_bound_legacy_turn
before insert on public.qorpera_session_turns
for each row execute function public.qorpera_guard_cloud_bound_legacy_turn();

create or replace function public.qorpera_runner_job_json(p_job public.qorpera_runner_jobs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'job_id', p_job.id,
		'run_id', p_job.run_id,
		'profile_id', p_job.profile_id,
		'environment_id', p_job.environment_id,
		'session_id', p_job.session_id,
		'substrate_version_id', p_job.substrate_version_id,
		'client_job_id', p_job.client_job_id,
		'assignment_id', p_job.client_lease_id,
		'required_capability', p_job.required_capability,
		'job_type', p_job.job_type,
		'payload', p_job.payload,
		'status', p_job.status,
		'attempt_count', p_job.attempt_count,
		'dispatch_failure_count', p_job.dispatch_failure_count,
		'runner_id', p_job.runner_id,
		'result', p_job.result,
		'output_artifact_count', p_job.output_artifact_count,
		'output_artifact_index_id', p_job.output_artifact_index_id,
		'output_substrate_version_id', p_job.output_substrate_version_id,
		'last_error', p_job.last_error,
		'created_by_user_id', p_job.created_by_user_id,
		'created_at', p_job.created_at,
		'started_at', p_job.started_at,
		'lease_expires_at', p_job.lease_expires_at,
		'finished_at', p_job.finished_at,
		'cancelled_by_user_id', p_job.cancelled_by_user_id,
		'cancelled_at', p_job.cancelled_at
	)
$$;

create table public.qorpera_execution_run_events (
	id bigint generated always as identity primary key,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	event_type text not null check (event_type in (
		'queued', 'orchestrator_claimed', 'runner_assigned', 'runner_started',
		'lease_renewed', 'infrastructure_retry', 'completed', 'failed',
		'cancelled', 'review_pending', 'provider_session_bound',
		'recovery_released', 'recovery_discarded'
	)),
	payload jsonb not null default '{}'::jsonb check (
		jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536
	),
	created_at timestamptz not null default statement_timestamp()
);

create index qorpera_execution_run_events_run_sequence
	on public.qorpera_execution_run_events (run_id, id);

create table public.qorpera_provider_session_owners (
	provider_connection_id uuid not null,
	provider_connection_version bigint not null,
	provider_session_id text not null check (
		char_length(btrim(provider_session_id)) between 1 and 1024 and provider_session_id !~ E'[\r\n]'
	),
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	qorpera_session_id uuid references public.qorpera_shared_sessions(id) on delete restrict,
	origin_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	primary key (provider_connection_id, provider_connection_version, provider_session_id),
	foreign key (provider_connection_id, provider_connection_version)
		references public.qorpera_provider_connection_versions(connection_id, version) on delete restrict
);

create table public.qorpera_execution_provider_sessions (
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	provider_connection_id uuid not null,
	provider_connection_version bigint not null,
	provider_session_id text not null check (
		char_length(btrim(provider_session_id)) between 1 and 1024 and provider_session_id !~ E'[\r\n]'
	),
	context_checkpoint_object_sha256 text check (context_checkpoint_object_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default statement_timestamp(),
	primary key (run_id, provider_connection_id, provider_session_id),
	foreign key (run_id, profile_id)
		references public.qorpera_execution_runs(id, profile_id) on delete restrict,
	foreign key (provider_connection_id, provider_connection_version)
		references public.qorpera_provider_connection_versions(connection_id, version) on delete restrict,
	foreign key (provider_connection_id, provider_connection_version, provider_session_id)
		references public.qorpera_provider_session_owners(
			provider_connection_id, provider_connection_version, provider_session_id
		) on delete restrict,
	foreign key (profile_id, context_checkpoint_object_sha256)
		references public.qorpera_profile_objects(profile_id, sha256) on delete restrict
);

create unique index qorpera_execution_provider_sessions_one_per_run_provider
	on public.qorpera_execution_provider_sessions (run_id, provider_connection_id);

create or replace function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
	select computer.encrypted_volume_object_sha256
	from public.qorpera_logical_computers as computer
	where computer.profile_id = p_profile_id
		and computer.status <> 'retired'
		and computer.encrypted_volume_object_sha256 is not null
	union
	select provider_session.context_checkpoint_object_sha256
	from public.qorpera_execution_provider_sessions as provider_session
	join public.qorpera_execution_runs as run on run.id = provider_session.run_id
	join public.qorpera_runner_jobs as job on job.id = run.job_id
	where provider_session.profile_id = p_profile_id
		and provider_session.context_checkpoint_object_sha256 is not null
		and (
			job.status in ('queued', 'leased')
			or provider_session.created_at >= statement_timestamp() - interval '30 days'
			or (run.session_id is not null
				and exists (
					select 1 from public.qorpera_shared_sessions as shared_session
					where shared_session.id = run.session_id and shared_session.status = 'open'
				)
				and not exists (
				select 1
				from public.qorpera_execution_provider_sessions as newer_session
				join public.qorpera_execution_runs as newer_run on newer_run.id = newer_session.run_id
				where newer_run.session_id = run.session_id
					and newer_session.profile_id = provider_session.profile_id
					and (newer_session.created_at, newer_session.run_id)
						> (provider_session.created_at, provider_session.run_id)
			))
		)
$$;

create function public.qorpera_release_expired_provider_checkpoint_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_execution_provider_sessions as provider_session
	set context_checkpoint_object_sha256 = null
	from public.qorpera_execution_runs as run
	join public.qorpera_runner_jobs as job on job.id = run.job_id
	where provider_session.run_id = run.id
		and provider_session.profile_id = old.profile_id
		and provider_session.context_checkpoint_object_sha256 = old.sha256
		and job.status in ('completed', 'failed', 'cancelled')
		and provider_session.created_at < statement_timestamp() - interval '30 days'
		and (run.session_id is null or exists (
			select 1 from public.qorpera_shared_sessions as shared_session
			where shared_session.id = run.session_id and shared_session.status <> 'open'
		) or exists (
			select 1
			from public.qorpera_execution_provider_sessions as newer_session
			join public.qorpera_execution_runs as newer_run on newer_run.id = newer_session.run_id
			where newer_run.session_id = run.session_id
				and newer_session.profile_id = provider_session.profile_id
				and (newer_session.created_at, newer_session.run_id)
					> (provider_session.created_at, provider_session.run_id)
		));
	return old;
end
$$;

create trigger qorpera_release_expired_provider_checkpoint_reference
before delete on public.qorpera_profile_objects
for each row execute function public.qorpera_release_expired_provider_checkpoint_reference();

create table public.qorpera_runner_orchestrators (
	id uuid primary key,
	display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
	provider_adapter text not null check (provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
	control_token_sha256 text not null check (control_token_sha256 ~ '^[0-9a-f]{64}$'),
	control_token_expires_at timestamptz not null,
	status text not null default 'active' check (status in ('active', 'draining', 'revoked')),
	registered_at timestamptz not null default statement_timestamp(),
	last_heartbeat_at timestamptz not null default statement_timestamp()
);

create table public.qorpera_runner_job_claims (
	id uuid primary key,
	orchestrator_id uuid not null references public.qorpera_runner_orchestrators(id) on delete restrict,
	client_claim_id uuid not null,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	status text not null default 'claimed' check (status in ('claimed', 'assigned', 'accepted', 'released')),
	lease_expires_at timestamptz not null,
	created_at timestamptz not null default statement_timestamp(),
	released_at timestamptz,
	release_reason text check (release_reason is null or char_length(release_reason) between 1 and 1000),
	unique (orchestrator_id, client_claim_id),
	check ((status = 'released') = (released_at is not null))
);

create unique index qorpera_runner_job_claims_one_active
	on public.qorpera_runner_job_claims (job_id)
	where status in ('claimed', 'assigned');

create table public.qorpera_runner_assignments (
	id uuid primary key,
	claim_id uuid not null references public.qorpera_runner_job_claims(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	runner_id uuid not null references public.qorpera_runners(id) on delete restrict,
	capability_sha256 text not null check (capability_sha256 ~ '^[0-9a-f]{64}$'),
	status text not null default 'offered' check (status in (
		'offered', 'accepted', 'delivery_failed', 'expired', 'completed', 'failed'
	)),
	expires_at timestamptz not null,
	created_at timestamptz not null default statement_timestamp(),
	accepted_at timestamptz,
	finished_at timestamptz,
	last_error text check (last_error is null or char_length(last_error) between 1 and 1000),
	check ((status = 'accepted') = (accepted_at is not null and finished_at is null)),
	check ((status in ('completed', 'failed')) = (finished_at is not null))
);

create unique index qorpera_runner_assignments_one_live
	on public.qorpera_runner_assignments (claim_id)
	where status in ('offered', 'accepted');

-- The legacy workspace trigger correctly prevents one authenticated desktop
-- writer from advancing another writer's fork. A runner, however, prepares a
-- candidate on behalf of an immutable cloud run while authenticated as the
-- service role. This transaction-local intent is the narrow bridge between
-- those models: the runner RPC records the exact candidate it authorized, the
-- existing snapshot trigger consumes that exact metadata, and the intent is
-- removed before the transaction commits.
create table public.qorpera_runner_company_revision_intents (
	client_revision_id uuid primary key,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	assignment_id uuid not null references public.qorpera_runner_assignments(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	workspace_id uuid not null references public.qorpera_company_workspaces(id) on delete restrict,
	parent_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	tree_manifest_sha256 text not null check (tree_manifest_sha256 ~ '^[0-9a-f]{64}$'),
	tree_manifest_bytes integer not null check (tree_manifest_bytes between 1 and 8388608),
	tree_contract_version integer not null check (tree_contract_version = 3),
	file_count integer not null check (file_count between 0 and 50000),
	total_bytes bigint not null check (total_bytes between 0 and 1099511627776),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (run_id, client_revision_id)
);

create table public.qorpera_runner_company_revision_outputs (
	snapshot_id uuid primary key references public.qorpera_company_snapshots(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	assignment_id uuid not null references public.qorpera_runner_assignments(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (run_id),
	unique (assignment_id, snapshot_id)
);

create or replace function public.qorpera_enforce_company_workspace_writer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_workspace public.qorpera_company_workspaces%rowtype;
begin
	select workspace.* into v_workspace
	from public.qorpera_company_workspaces as workspace
	where workspace.id = new.workspace_id;
	if not found
		or v_workspace.profile_id <> new.profile_id
		or v_workspace.environment_id <> new.environment_id then
		raise exception 'company snapshot workspace is invalid' using errcode = '22023';
	end if;
	if auth.uid() is not null
		and v_workspace.created_by_user_id = auth.uid()
		and new.created_by_user_id = auth.uid() then
		return new;
	end if;
	if exists (
		select 1
		from public.qorpera_runner_company_revision_intents as intent
		where intent.client_revision_id = new.client_snapshot_id
			and intent.profile_id = new.profile_id
			and intent.environment_id = new.environment_id
			and intent.workspace_id = new.workspace_id
			and intent.parent_snapshot_id is not distinct from new.parent_snapshot_id
			and intent.tree_manifest_sha256 = new.tree_manifest_sha256
			and intent.tree_manifest_bytes = new.tree_manifest_bytes
			and intent.tree_contract_version = new.tree_contract_version
			and intent.file_count = new.file_count
			and intent.total_bytes = new.total_bytes
			and intent.created_by_user_id = new.created_by_user_id
	) then
		return new;
	end if;
	raise exception 'company workspace head belongs to another writer' using errcode = '42501';
end
$$;

create table public.qorpera_run_operation_receipts (
	id uuid primary key,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null references public.qorpera_runner_jobs(id) on delete restrict,
	assignment_id uuid not null references public.qorpera_runner_assignments(id) on delete restrict,
	logical_operation_key text not null check (
		char_length(btrim(logical_operation_key)) between 1 and 256 and logical_operation_key !~ E'[\r\n]'
	),
	operation_kind text not null check (operation_kind ~ '^[a-z][a-z0-9_]{0,63}$'),
	input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
	downstream_idempotency_sha256 text not null check (downstream_idempotency_sha256 ~ '^[0-9a-f]{64}$'),
	requires_company_revision boolean not null default false,
	status text not null default 'executing' check (status in ('executing', 'completed', 'ambiguous', 'cancelled')),
	result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 65536)),
	output_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	proposal_id uuid references public.qorpera_company_proposals(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	completed_at timestamptz,
	recovery_resolution text check (
		recovery_resolution is null or recovery_resolution in ('confirmed_completed', 'confirmed_not_run')
	),
	recovery_resolved_by_user_id uuid references auth.users(id) on delete restrict,
	recovery_resolved_at timestamptz,
	unique (run_id, logical_operation_key),
	check ((status = 'completed') = (result is not null)),
	check ((status = 'executing') = (completed_at is null)),
	check (not (output_snapshot_id is not null and proposal_id is not null)),
	check ((recovery_resolution is null) = (recovery_resolved_at is null)),
	check ((recovery_resolution is null) = (recovery_resolved_by_user_id is null))
);

create index qorpera_run_operation_receipts_unresolved
	on public.qorpera_run_operation_receipts (run_id, created_at, id)
	where status in ('executing', 'ambiguous');

alter table public.qorpera_company_proposals
	drop constraint qorpera_company_proposals_execution_kind_check,
	add constraint qorpera_company_proposals_execution_kind_check
		check (execution_kind in ('turn', 'wake', 'run'));

create table public.qorpera_execution_run_results (
	run_id uuid primary key references public.qorpera_execution_runs(id) on delete restrict,
	job_id uuid not null unique references public.qorpera_runner_jobs(id) on delete restrict,
	assignment_id uuid not null references public.qorpera_runner_assignments(id) on delete restrict,
	runner_id uuid not null references public.qorpera_runners(id) on delete restrict,
	transcript_end_sequence bigint not null check (transcript_end_sequence >= 0),
	company_disposition text not null check (
		company_disposition in ('unchanged', 'published', 'review_pending')
	),
	output_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	proposal_id uuid references public.qorpera_company_proposals(id) on delete restrict,
	client_artifact_index_id uuid not null,
	client_substrate_version_id uuid not null,
	result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
	completed_at timestamptz not null default statement_timestamp(),
	check (
		(company_disposition = 'unchanged' and output_snapshot_id is null and proposal_id is null)
		or (company_disposition = 'published' and output_snapshot_id is not null and proposal_id is null)
		or (company_disposition = 'review_pending' and output_snapshot_id is not null and proposal_id is not null)
	)
);

alter table public.qorpera_runner_job_output_objects
	add column purposes text[] not null default array['artifact']::text[]
		check (
			purposes = array['artifact']::text[]
			or purposes = array['company_file']::text[]
			or purposes = array['artifact', 'company_file']::text[]
		);

alter table public.qorpera_session_events
	drop constraint qorpera_session_events_execution_kind_check,
	add constraint qorpera_session_events_execution_kind_check
		check (execution_kind is null or execution_kind in ('turn', 'wake', 'run')),
	add column runner_assignment_id uuid references public.qorpera_runner_assignments(id) on delete restrict,
	add column session_input_id uuid unique references public.qorpera_session_inputs(id) on delete restrict,
	add check ((execution_kind = 'run') = (runner_assignment_id is not null)),
	add check (session_input_id is null or (event_type = 'message' and execution_kind is null));

create or replace function public.qorpera_read_session_events(
	p_session_id uuid,
	p_after_sequence bigint default 0,
	p_limit integer default 200
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
	v_profile_id := public.qorpera_session_profile_id(p_session_id);
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	if p_after_sequence < 0 or p_limit not between 1 and 500 then
		raise exception 'event page is invalid' using errcode = '22023';
	end if;
	return coalesce(
		(
			select jsonb_agg(
				jsonb_build_object(
					'session_id', event.session_id,
					'sequence', event.sequence,
					'event_id', event.event_id,
					'event_type', event.event_type,
					'actor_user_id', event.actor_user_id,
					'body', event.body,
					'previous_hash', event.previous_hash,
					'event_hash', event.event_hash,
					'execution_kind', event.execution_kind,
					'execution_id', event.execution_id,
					'execution_claimant_id', event.execution_claimant_id,
					'runner_assignment_id', event.runner_assignment_id,
					'session_input_id', event.session_input_id,
					'created_at', event.created_at
				)
				order by event.sequence
			)
			from (
				select source.*
				from public.qorpera_session_events as source
				where source.session_id = p_session_id and source.sequence > p_after_sequence
				order by source.sequence
				limit p_limit
			) as event
		),
		'[]'::jsonb
	);
end
$$;

create or replace function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
	select computer.encrypted_volume_object_sha256
	from public.qorpera_logical_computers as computer
	where computer.profile_id = p_profile_id
		and computer.status <> 'retired'
		and computer.encrypted_volume_object_sha256 is not null
	union
	select provider_session.context_checkpoint_object_sha256
	from public.qorpera_execution_provider_sessions as provider_session
	join public.qorpera_execution_runs as run on run.id = provider_session.run_id
	join public.qorpera_runner_jobs as job on job.id = run.job_id
	where provider_session.profile_id = p_profile_id
		and provider_session.context_checkpoint_object_sha256 is not null
		and (
			job.status in ('queued', 'leased')
			or provider_session.created_at >= statement_timestamp() - interval '30 days'
			or (run.session_id is not null
				and exists (
					select 1 from public.qorpera_shared_sessions as shared_session
					where shared_session.id = run.session_id and shared_session.status = 'open'
				)
				and not exists (
				select 1
				from public.qorpera_execution_provider_sessions as newer_session
				join public.qorpera_execution_runs as newer_run on newer_run.id = newer_session.run_id
				where newer_run.session_id = run.session_id
					and newer_session.profile_id = provider_session.profile_id
					and (newer_session.created_at, newer_session.run_id)
						> (provider_session.created_at, provider_session.run_id)
			))
		)
	union
	select attachment ->> 'objectSha256'
	from public.qorpera_shared_sessions as session
	join public.qorpera_session_events as event on event.session_id = session.id
	cross join lateral jsonb_array_elements(
		coalesce(event.body #> '{entry,qorperaAttachments}', '[]'::jsonb)
	) as attachment
	where session.profile_id = p_profile_id
		and event.session_input_id is not null
		and attachment ->> 'objectSha256' ~ '^[0-9a-f]{64}$'
$$;

alter table public.qorpera_provider_connections enable row level security;
alter table public.qorpera_provider_connection_versions enable row level security;
alter table public.qorpera_execution_sponsor_bindings enable row level security;
alter table public.qorpera_execution_sponsor_versions enable row level security;
alter table public.qorpera_logical_computers enable row level security;
alter table public.qorpera_execution_runs enable row level security;
alter table public.qorpera_execution_sponsor_reservations enable row level security;
alter table public.qorpera_execution_run_budgets enable row level security;
alter table public.qorpera_execution_run_events enable row level security;
alter table public.qorpera_provider_session_owners enable row level security;
alter table public.qorpera_execution_provider_sessions enable row level security;
alter table public.qorpera_runner_orchestrators enable row level security;
alter table public.qorpera_runner_job_claims enable row level security;
alter table public.qorpera_runner_assignments enable row level security;
alter table public.qorpera_runner_company_revision_intents enable row level security;
alter table public.qorpera_runner_company_revision_outputs enable row level security;
alter table public.qorpera_run_operation_receipts enable row level security;
alter table public.qorpera_execution_run_results enable row level security;
alter table public.qorpera_session_execution_bindings enable row level security;
alter table public.qorpera_cloud_routines enable row level security;
alter table public.qorpera_cloud_routine_versions enable row level security;
alter table public.qorpera_wake_occurrences enable row level security;

revoke all on public.qorpera_provider_connections from anon, authenticated;
revoke all on public.qorpera_provider_connection_versions from anon, authenticated;
revoke all on public.qorpera_execution_sponsor_bindings from anon, authenticated;
revoke all on public.qorpera_execution_sponsor_versions from anon, authenticated;
revoke all on public.qorpera_logical_computers from anon, authenticated;
revoke all on public.qorpera_execution_runs from anon, authenticated;
revoke all on public.qorpera_execution_sponsor_reservations from anon, authenticated;
revoke all on public.qorpera_execution_run_budgets from anon, authenticated;
revoke all on public.qorpera_execution_run_events from anon, authenticated;
revoke all on public.qorpera_provider_session_owners from anon, authenticated;
revoke all on public.qorpera_execution_provider_sessions from anon, authenticated;
revoke all on public.qorpera_runner_orchestrators from anon, authenticated;
revoke all on public.qorpera_runner_job_claims from anon, authenticated;
revoke all on public.qorpera_runner_assignments from anon, authenticated;
revoke all on public.qorpera_runner_company_revision_intents from anon, authenticated, service_role;
revoke all on public.qorpera_runner_company_revision_outputs from anon, authenticated;
revoke all on public.qorpera_run_operation_receipts from anon, authenticated;
revoke all on public.qorpera_execution_run_results from anon, authenticated;
revoke all on public.qorpera_session_execution_bindings from anon, authenticated;
revoke all on public.qorpera_cloud_routines from anon, authenticated;
revoke all on public.qorpera_cloud_routine_versions from anon, authenticated;
revoke all on public.qorpera_wake_occurrences from anon, authenticated;

create function public.qorpera_execution_run_json(p_run public.qorpera_execution_runs)
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

create function public.qorpera_execution_work_json(p_claim public.qorpera_runner_job_claims)
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
			'transcript_start_sequence', run.transcript_start_sequence,
			'deadline_at', run.deadline_at,
			'attempt', job.attempt_count + 1,
			'sponsor', jsonb_build_object(
				'binding_id', sponsor.binding_id,
				'version', sponsor.version,
				'kind', sponsor.sponsor_kind,
				'provider_connection_id', connection.id,
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
	where run.id = p_claim.run_id
$$;

revoke all on function public.qorpera_execution_run_json(public.qorpera_execution_runs) from public;
revoke all on function public.qorpera_execution_work_json(public.qorpera_runner_job_claims) from public;

create or replace function public.qorpera_runner_model_policy_json(
	p_policy public.qorpera_runner_model_policies
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'job_id', p_policy.job_id,
		'profile_id', p_policy.profile_id,
		'environment_id', p_policy.environment_id,
		'allowed_models', p_policy.allowed_models,
		'max_calls', p_policy.max_calls,
		'max_input_tokens', p_policy.max_input_tokens,
		'max_output_tokens', p_policy.max_output_tokens,
		'max_cost_microusd', p_policy.max_cost_microusd,
		'authorized_by_user_id', p_policy.authorized_by_user_id,
		'created_at', p_policy.created_at
	)
$$;

create function public.qorpera_reserve_execution_sponsor_authority(p_run_id uuid)
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
		or v_staff.model_provider is distinct from v_connection.provider or v_staff.model_id is null
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
		jsonb_build_array(jsonb_build_object('provider', v_connection.provider, 'model', v_staff.model_id)),
		(v_connection_version.quota_policy ->> 'max_calls_per_run')::integer,
		(v_connection_version.quota_policy ->> 'max_input_tokens_per_run')::bigint,
		(v_connection_version.quota_policy ->> 'max_output_tokens_per_run')::bigint,
		v_reservation, v_sponsor.created_by_user_id
	);
	return true;
end
$$;

create function public.qorpera_execution_sponsor_available(p_run public.qorpera_execution_runs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_run.sponsor_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		join public.qorpera_execution_sponsor_reservations as reservation
			on reservation.run_id = p_run.id and reservation.status = 'reserved'
		join public.qorpera_runner_model_policies as policy on policy.job_id = p_run.job_id
		where binding.id = p_run.sponsor_binding_id and binding.profile_id = p_run.profile_id
			and binding.status = 'active' and connection.profile_id = p_run.profile_id
			and connection.status = 'active'
			and (
				sponsor.sponsor_kind <> 'member_connection'
				or exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = p_run.profile_id
						and member.user_id = connection.owner_user_id
				)
			)
	)
$$;

create function public.qorpera_execution_compute_available(p_run public.qorpera_execution_runs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_run.logical_computer_id is null or exists (
		select 1
		from public.qorpera_logical_computers as computer
		join public.qorpera_runner_jobs as job on job.id = p_run.job_id
		where computer.id = p_run.logical_computer_id
			and computer.profile_id = p_run.profile_id
			and computer.status = 'active'
			and computer.capabilities ? job.required_capability
	)
$$;

revoke all on function public.qorpera_runner_model_policy_json(public.qorpera_runner_model_policies) from public;
revoke all on function public.qorpera_reserve_execution_sponsor_authority(uuid) from public;
revoke all on function public.qorpera_execution_sponsor_available(public.qorpera_execution_runs) from public;
revoke all on function public.qorpera_execution_compute_available(public.qorpera_execution_runs) from public;

create or replace function public.qorpera_runner_broker_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns public.qorpera_runner_jobs
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role'
		or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner broker authorization is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
		and job.status = 'leased' and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp();
	if not found then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	if v_job.run_id is not null then
		select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if not found or v_run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(v_run)
			or not public.qorpera_execution_compute_available(v_run) then
			raise exception 'runner execution sponsor is unavailable' using errcode = '42501';
		end if;
	end if;
	return v_job;
end
$$;

create or replace function public.qorpera_runner_broker_locked_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text
)
returns public.qorpera_runner_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
		and job.status = 'leased' and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp()
	for update;
	if not found then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if v_run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(v_run)
			or not public.qorpera_execution_compute_available(v_run) then
			raise exception 'runner execution sponsor is unavailable' using errcode = '42501';
		end if;
	end if;
	return v_job;
end
$$;

create function public.qorpera_runner_model_gateway_authority(p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'schema', 'qorpera.model-gateway-authority/v1',
		'run_id', run.id,
		'job_id', run.job_id,
		'sponsor_binding_id', sponsor.binding_id,
		'sponsor_version', sponsor.version,
		'provider_connection_id', connection.id,
		'provider_connection_version', connection_version.version,
		'provider', connection.provider,
		'authentication_mode', connection_version.authentication_mode,
		'native_harness', connection_version.native_harness,
		'max_cost_microusd', least(policy.max_cost_microusd, reservation.reserved_microusd)
			- coalesce((
				select sum(observation.cost_microusd)
				from public.qorpera_runner_model_usage_observations as observation
				where observation.job_id = run.job_id
			), 0)
	)
	from public.qorpera_execution_runs as run
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as connection_version
		on connection_version.connection_id = sponsor.provider_connection_id
		and connection_version.version = sponsor.provider_connection_version
	join public.qorpera_execution_sponsor_reservations as reservation
		on reservation.run_id = run.id and reservation.status = 'reserved'
	join public.qorpera_runner_model_policies as policy on policy.job_id = run.job_id
	where run.job_id = p_job_id
$$;

create or replace function public.qorpera_runner_broker_reserve_model_request(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_request_id uuid,
	p_provider text,
	p_model text,
	p_request_sha256 text,
	p_input_token_reservation bigint,
	p_output_token_reservation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_policy public.qorpera_runner_model_policies%rowtype;
	v_request public.qorpera_runner_model_requests%rowtype;
	v_authority jsonb;
	v_calls bigint;
	v_input_tokens bigint;
	v_output_tokens bigint;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select policy.* into v_policy
	from public.qorpera_runner_model_policies as policy where policy.job_id = v_job.id for update;
	if not found then
		raise exception 'runner job has no model authority' using errcode = '42501';
	end if;
	if p_request_id is null
		or coalesce(p_provider, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or char_length(coalesce(p_model, '')) not between 1 and 160
		or p_model <> btrim(p_model) or p_model ~ E'[\r\n]'
		or coalesce(p_request_sha256, '') !~ '^[0-9a-f]{64}$'
		or p_input_token_reservation is null
		or p_input_token_reservation not between 1 and 100000000
		or p_output_token_reservation is null
		or p_output_token_reservation not between 1 and 1000000
		or not exists (
			select 1 from jsonb_array_elements(v_policy.allowed_models) as allowed(value)
			where allowed.value ->> 'provider' = p_provider and allowed.value ->> 'model' = p_model
		) then
		raise exception 'runner model request is outside its policy' using errcode = '42501';
	end if;

	select request.* into v_request
	from public.qorpera_runner_model_requests as request
	where request.job_id = v_job.id and request.client_request_id = p_request_id
	for update;
	if found then
		if v_request.provider <> p_provider
			or v_request.model <> p_model
			or v_request.request_sha256 <> p_request_sha256
			or v_request.input_token_reservation <> p_input_token_reservation
			or v_request.output_token_reservation <> p_output_token_reservation then
			raise exception 'runner model request id is already bound to other work' using errcode = '23505';
		end if;
		if v_request.status = 'completed' then
			return jsonb_build_object('state', 'completed', 'response', v_request.response);
		end if;
		if v_request.status = 'failed' then return jsonb_build_object('state', 'failed'); end if;
		if v_request.status = 'ambiguous' then return jsonb_build_object('state', 'ambiguous'); end if;
		update public.qorpera_runner_model_requests
		set runner_id = p_runner_id,
			reservation_expires_at = statement_timestamp() + interval '5 minutes'
		where id = v_request.id;
		v_authority := public.qorpera_runner_model_gateway_authority(v_job.id);
		if v_job.run_id is not null and (
			v_authority is null or (v_authority ->> 'max_cost_microusd')::bigint <= 0
		) then
			raise exception 'runner model cost budget is exhausted' using errcode = '55000';
		end if;
		return jsonb_strip_nulls(jsonb_build_object(
			'state', 'reserved', 'replay', true, 'authority', v_authority
		));
	end if;

	select count(*) into v_calls
	from public.qorpera_runner_model_requests as request where request.job_id = v_job.id;
	select
		coalesce(sum(observation.input_tokens), 0)
			+ coalesce((select sum(request.input_token_reservation)
				from public.qorpera_runner_model_requests as request
				where request.job_id = v_job.id and request.status = 'reserved'), 0),
		coalesce(sum(observation.output_tokens), 0)
			+ coalesce((select sum(request.output_token_reservation)
				from public.qorpera_runner_model_requests as request
				where request.job_id = v_job.id and request.status = 'reserved'), 0)
	into v_input_tokens, v_output_tokens
	from public.qorpera_runner_model_usage_observations as observation
	where observation.job_id = v_job.id;
	if v_calls >= v_policy.max_calls
		or v_input_tokens + p_input_token_reservation > v_policy.max_input_tokens
		or v_output_tokens + p_output_token_reservation > v_policy.max_output_tokens
		or (v_job.run_id is not null and exists (
			select 1 from public.qorpera_runner_model_requests as request
			where request.job_id = v_job.id and request.status = 'reserved'
		)) then
		raise exception 'runner model policy budget is exhausted' using errcode = '55000';
	end if;
	v_authority := public.qorpera_runner_model_gateway_authority(v_job.id);
	if v_job.run_id is not null and (
		v_authority is null or (v_authority ->> 'max_cost_microusd')::bigint <= 0
	) then
		raise exception 'runner model cost budget is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_runner_model_requests (
		job_id, profile_id, environment_id, runner_id, actor_user_id, authorized_by_user_id,
		client_request_id, provider, model, request_sha256,
		input_token_reservation, output_token_reservation
	) values (
		v_job.id, v_job.profile_id, v_job.environment_id, p_runner_id,
		v_job.created_by_user_id, v_policy.authorized_by_user_id,
		p_request_id, p_provider, p_model, p_request_sha256,
		p_input_token_reservation, p_output_token_reservation
	);
	return jsonb_strip_nulls(jsonb_build_object('state', 'reserved', 'authority', v_authority));
end
$$;

create or replace function public.qorpera_runner_broker_finalize_model_request(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_request_id uuid,
	p_request_sha256 text,
	p_outcome text,
	p_input_tokens bigint,
	p_output_tokens bigint,
	p_cost_microusd bigint,
	p_response jsonb,
	p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_policy public.qorpera_runner_model_policies%rowtype;
	v_request public.qorpera_runner_model_requests%rowtype;
	v_observation public.qorpera_runner_model_usage_observations%rowtype;
	v_reservation public.qorpera_execution_sponsor_reservations%rowtype;
	v_response jsonb;
	v_cost_used bigint;
	v_effective_outcome text;
	v_effective_error_code text;
	v_budget_exceeded boolean := false;
begin
	if auth.role() <> 'service_role' or p_session_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_lease_token_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner model finalization is invalid' using errcode = '42501';
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id
		and (
			(job.status = 'leased' and job.lease_token_sha256 = p_lease_token_sha256)
			or (job.status in ('completed', 'failed', 'cancelled')
				and job.terminal_lease_token_sha256 = p_lease_token_sha256)
		)
	for update;
	if not found then
		raise exception 'runner model finalization authority is unavailable' using errcode = '40001';
	end if;
	select policy.* into v_policy
	from public.qorpera_runner_model_policies as policy where policy.job_id = v_job.id for update;
	select request.* into v_request
	from public.qorpera_runner_model_requests as request
	where request.job_id = v_job.id and request.client_request_id = p_request_id
	for update;
	if not found or v_request.runner_id <> p_runner_id or v_request.request_sha256 <> p_request_sha256 then
		raise exception 'runner model reservation is unavailable' using errcode = '40001';
	end if;
	if coalesce(p_outcome, '') not in ('completed', 'failed')
		or p_input_tokens is null or p_input_tokens not between 0 and 100000000
		or p_output_tokens is null or p_output_tokens not between 0 and 100000000
		or p_cost_microusd is null or p_cost_microusd not between 0 and 9007199254740991
		or (p_outcome = 'completed' and (p_error_code is not null or pg_column_size(coalesce(p_response, 'null'::jsonb)) > 589824))
		or (p_outcome = 'failed' and (
			p_response is not null
			or p_error_code is null
			or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$'
			or char_length(p_error_code) > 64
		)) then
		raise exception 'runner model result is invalid' using errcode = '22023';
	end if;
	if v_job.run_id is not null then
		select reservation.* into strict v_reservation
		from public.qorpera_execution_sponsor_reservations as reservation
		where reservation.run_id = v_job.run_id
		for update;
		select coalesce(sum(observation.cost_microusd), 0) into v_cost_used
		from public.qorpera_runner_model_usage_observations as observation
		where observation.job_id = v_job.id and observation.request_id <> v_request.id;
		v_budget_exceeded := v_cost_used + p_cost_microusd
			> least(v_policy.max_cost_microusd, v_reservation.reserved_microusd);
	end if;
	v_effective_outcome := case when v_budget_exceeded then 'failed' else p_outcome end;
	v_effective_error_code := case when v_budget_exceeded then 'gateway_cost_exceeded' else p_error_code end;
	v_response := case when v_effective_outcome = 'completed' then jsonb_build_object(
		'request_id', v_request.client_request_id,
		'provider', v_request.provider,
		'model', v_request.model,
		'output', coalesce(p_response, 'null'::jsonb),
		'usage', jsonb_build_object(
			'input_tokens', p_input_tokens,
			'output_tokens', p_output_tokens,
			'cost_microusd', p_cost_microusd
		)
	) else null end;

	if v_request.status not in ('reserved', 'ambiguous') then
		select observation.* into strict v_observation
		from public.qorpera_runner_model_usage_observations as observation
		where observation.request_id = v_request.id;
		if v_request.status <> v_effective_outcome
			or v_request.response is distinct from v_response
			or v_request.error_code is distinct from v_effective_error_code
			or v_observation.input_tokens <> p_input_tokens
			or v_observation.output_tokens <> p_output_tokens
			or v_observation.cost_microusd <> p_cost_microusd then
			raise exception 'runner model result replay differs' using errcode = '23505';
		end if;
		return coalesce(v_request.response, jsonb_build_object('state', 'failed'));
	end if;
	update public.qorpera_runner_model_requests
	set status = v_effective_outcome, response = v_response,
		error_code = v_effective_error_code, finalized_at = statement_timestamp()
	where id = v_request.id returning * into v_request;
	insert into public.qorpera_runner_model_usage_observations (
		request_id, profile_id, environment_id, job_id, runner_id,
		actor_user_id, authorized_by_user_id, provider, model,
		outcome, input_tokens, output_tokens, cost_microusd
	) values (
		v_request.id, v_request.profile_id, v_request.environment_id, v_request.job_id, v_request.runner_id,
		v_request.actor_user_id, v_request.authorized_by_user_id, v_request.provider, v_request.model,
		v_effective_outcome, p_input_tokens, p_output_tokens, p_cost_microusd
	);
	if v_budget_exceeded then
		perform public.qorpera_terminalize_runner_attempt(
			v_job.id, 'failed', 'Model gateway reported cost above the reserved run budget', false
		);
	end if;
	if v_job.run_id is not null and not exists (
		select 1 from public.qorpera_runner_model_requests as request
		where request.job_id = v_job.id and request.status = 'reserved'
	) and (select job.status from public.qorpera_runner_jobs as job where job.id = v_job.id)
		in ('completed', 'failed', 'cancelled') then
		update public.qorpera_execution_sponsor_reservations as reservation
		set status = 'settled', actual_microusd = coalesce((
				select sum(observation.cost_microusd)
				from public.qorpera_runner_model_usage_observations as observation
				where observation.job_id = v_job.id
			), 0), settled_at = statement_timestamp()
		where reservation.run_id = v_job.run_id and reservation.status in ('reserved', 'settled');
	end if;
	return coalesce(v_response, jsonb_build_object('state', 'failed'));
end
$$;

create function public.qorpera_set_provider_connection_status(
	p_profile_id uuid,
	p_connection_id uuid,
	p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_connection public.qorpera_provider_connections%rowtype;
begin
	select connection.* into v_connection from public.qorpera_provider_connections as connection
	where connection.id = p_connection_id and connection.profile_id = p_profile_id for update;
	if auth.uid() is null or not (
		public.qorpera_can_authorize_profile(p_profile_id)
		or (v_connection.owner_user_id = auth.uid() and p_status = 'revoked')
	) then
		raise exception 'provider connection lifecycle requires authorize access' using errcode = '42501';
	end if;
	if not found or p_status not in ('active', 'disabled', 'revoked')
		or (v_connection.status = 'revoked' and p_status <> 'revoked') then
		raise exception 'provider connection lifecycle transition is invalid' using errcode = '55000';
	end if;
	update public.qorpera_provider_connections set status = p_status
	where id = v_connection.id returning * into v_connection;
	if p_status <> 'active' then
		perform public.qorpera_terminalize_runner_attempt(
			job.id, 'failed', 'Execution provider connection was ' || p_status, false
		)
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on job.id = run.job_id
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
		where job.status in ('queued', 'leased') and sponsor.provider_connection_id = v_connection.id;
	end if;
	return jsonb_build_object('connection_id', v_connection.id, 'status', v_connection.status);
end
$$;

create function public.qorpera_cascade_provider_connection_unavailability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if old.status = new.status or new.status = 'active' then return new; end if;
	perform public.qorpera_terminalize_runner_attempt(
		job.id, 'failed', 'Execution provider connection was ' || new.status, false
	)
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on job.id = run.job_id
	join public.qorpera_execution_sponsor_versions as sponsor
		on sponsor.binding_id = run.sponsor_binding_id and sponsor.version = run.sponsor_version
	where job.status in ('queued', 'leased') and sponsor.provider_connection_id = new.id;
	return new;
end
$$;

create trigger qorpera_cascade_provider_connection_unavailability
after update of status on public.qorpera_provider_connections
for each row execute function public.qorpera_cascade_provider_connection_unavailability();

create function public.qorpera_revoke_departed_member_provider_connections()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_provider_connections
	set status = 'revoked'
	where profile_id = old.profile_id and owner_user_id = old.user_id and status <> 'revoked';
	return old;
end
$$;

create trigger qorpera_revoke_departed_member_provider_connections
after delete on public.qorpera_profile_members
for each row execute function public.qorpera_revoke_departed_member_provider_connections();

create function public.qorpera_set_execution_sponsor_status(
	p_profile_id uuid,
	p_binding_id uuid,
	p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
begin
	select binding.* into v_binding from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = p_binding_id and binding.profile_id = p_profile_id for update;
	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'execution sponsor lifecycle requires authorize access' using errcode = '42501';
	end if;
	if not found or p_status not in ('active', 'disabled', 'revoked')
		or (v_binding.status = 'revoked' and p_status <> 'revoked') then
		raise exception 'execution sponsor lifecycle transition is invalid' using errcode = '55000';
	end if;
	update public.qorpera_execution_sponsor_bindings set status = p_status
	where id = v_binding.id returning * into v_binding;
	if p_status <> 'active' then
		perform public.qorpera_terminalize_runner_attempt(
			job.id, 'failed', 'Execution sponsor was ' || p_status, false
		)
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on job.id = run.job_id
		where job.status in ('queued', 'leased') and run.sponsor_binding_id = v_binding.id;
	end if;
	return jsonb_build_object('binding_id', v_binding.id, 'status', v_binding.status);
end
$$;

create function public.qorpera_upsert_logical_computer(
	p_profile_id uuid,
	p_client_computer_id uuid,
	p_display_name text,
	p_template_key text,
	p_template_version text,
	p_capabilities jsonb,
	p_policy jsonb default '{}'::jsonb,
	p_encrypted_volume_object_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_computer public.qorpera_logical_computers%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'logical computer configuration requires authorize access' using errcode = '42501';
	end if;
	if p_client_computer_id is null
		or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120
		or coalesce(p_template_key, '') !~ '^[a-z][a-z0-9._-]{0,119}$'
		or char_length(btrim(coalesce(p_template_version, ''))) not between 1 and 120
		or not public.qorpera_runner_capabilities_valid(p_capabilities)
		or jsonb_typeof(p_policy) <> 'object' or pg_column_size(p_policy) > 65536
		or (p_encrypted_volume_object_sha256 is not null and (
			p_encrypted_volume_object_sha256 !~ '^[0-9a-f]{64}$'
			or not exists (
				select 1 from public.qorpera_profile_objects as object
				where object.profile_id = p_profile_id and object.sha256 = p_encrypted_volume_object_sha256
			)
		)) then
		raise exception 'logical computer configuration is invalid' using errcode = '22023';
	end if;
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.profile_id = p_profile_id and computer.client_computer_id = p_client_computer_id
	for update;
	if found and v_computer.status = 'retired' then
		raise exception 'logical computer is retired' using errcode = '55000';
	end if;
	insert into public.qorpera_logical_computers (
		profile_id, client_computer_id, display_name, template_key, template_version,
		capabilities, policy, encrypted_volume_object_sha256, created_by_user_id
	) values (
		p_profile_id, p_client_computer_id, btrim(p_display_name), p_template_key,
		btrim(p_template_version), p_capabilities, p_policy,
		p_encrypted_volume_object_sha256, v_user_id
	)
	on conflict (profile_id, client_computer_id) do update set
		display_name = excluded.display_name,
		template_key = excluded.template_key,
		template_version = excluded.template_version,
		capabilities = excluded.capabilities,
		policy = excluded.policy,
		encrypted_volume_object_sha256 = excluded.encrypted_volume_object_sha256,
		updated_at = statement_timestamp()
	returning * into v_computer;
	return jsonb_build_object(
		'logical_computer_id', v_computer.id,
		'status', v_computer.status,
		'template_key', v_computer.template_key,
		'template_version', v_computer.template_version,
		'capabilities', v_computer.capabilities
	);
end
$$;

create function public.qorpera_set_logical_computer_status(
	p_profile_id uuid,
	p_logical_computer_id uuid,
	p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_computer public.qorpera_logical_computers%rowtype;
begin
	select computer.* into v_computer from public.qorpera_logical_computers as computer
	where computer.id = p_logical_computer_id and computer.profile_id = p_profile_id for update;
	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'logical computer lifecycle requires authorize access' using errcode = '42501';
	end if;
	if not found or p_status not in ('active', 'disabled', 'retired')
		or (v_computer.status = 'retired' and p_status <> 'retired') then
		raise exception 'logical computer lifecycle transition is invalid' using errcode = '55000';
	end if;
	update public.qorpera_logical_computers
	set status = p_status,
		encrypted_volume_object_sha256 = case
			when p_status = 'retired' then null
			else encrypted_volume_object_sha256
		end,
		updated_at = statement_timestamp()
	where id = v_computer.id returning * into v_computer;
	if p_status <> 'active' then
		perform public.qorpera_terminalize_runner_attempt(
			job.id, 'failed', 'Logical computer was ' || p_status, false
		)
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on job.id = run.job_id
		where job.status in ('queued', 'leased')
			and (
				run.logical_computer_id = v_computer.id
				or (
					job.status = 'leased'
					and exists (
						select 1 from public.qorpera_runners as runner
						where runner.id = job.runner_id
							and runner.logical_computer_id = v_computer.id
					)
				)
			);
	end if;
	return jsonb_build_object('logical_computer_id', v_computer.id, 'status', v_computer.status);
end
$$;

revoke all on function public.qorpera_runner_broker_job(uuid, text, uuid, text) from public;
revoke all on function public.qorpera_runner_broker_locked_job(uuid, text, uuid, text) from public;
revoke all on function public.qorpera_runner_model_gateway_authority(uuid) from public;
revoke all on function public.qorpera_set_provider_connection_status(uuid, uuid, text) from public;
revoke all on function public.qorpera_cascade_provider_connection_unavailability() from public;
revoke all on function public.qorpera_revoke_departed_member_provider_connections() from public;
revoke all on function public.qorpera_set_execution_sponsor_status(uuid, uuid, text) from public;
revoke all on function public.qorpera_upsert_logical_computer(uuid, uuid, text, text, text, jsonb, jsonb, text) from public;
revoke all on function public.qorpera_set_logical_computer_status(uuid, uuid, text) from public;

create function public.qorpera_register_provider_connection(
	p_profile_id uuid,
	p_client_connection_id uuid,
	p_owner_user_id uuid,
	p_provider text,
	p_authentication_mode text,
	p_native_harness text,
	p_secret_reference text,
	p_provider_account_reference text,
	p_billing_source text,
	p_consent_version text,
	p_commercial_approval_reference text default null,
	p_quota_policy jsonb default '{}'::jsonb,
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
	v_version bigint;
begin
	if v_user_id is null then
		raise exception 'provider connection requires authentication' using errcode = '42501';
	end if;
	if p_client_connection_id is null or coalesce(p_provider, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_authentication_mode not in (
			'native_subscription', 'enterprise_access_token', 'api_key', 'cloud_service_account'
		) or char_length(btrim(coalesce(p_native_harness, ''))) not between 1 and 120
		or char_length(btrim(coalesce(p_secret_reference, ''))) not between 1 and 512
		or char_length(btrim(coalesce(p_billing_source, ''))) not between 1 and 120
		or char_length(btrim(coalesce(p_consent_version, ''))) not between 1 and 120
		or pg_column_size(p_quota_policy) > 16384
		or not public.qorpera_provider_quota_policy_valid(p_quota_policy) then
		raise exception 'provider connection is invalid' using errcode = '22023';
	end if;
	if p_authentication_mode in ('native_subscription', 'enterprise_access_token')
		and char_length(btrim(coalesce(p_commercial_approval_reference, ''))) < 1 then
		raise exception 'hosted provider credential requires commercial approval' using errcode = '42501';
	end if;
	if p_authentication_mode = 'native_subscription' and p_provider in ('anthropic', 'google', 'xai') then
		raise exception 'provider subscription cannot authorize hosted execution' using errcode = '42501';
	end if;
	if p_owner_user_id is not null and not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = p_owner_user_id
	) then
		raise exception 'provider connection owner is not a company member' using errcode = '22023';
	end if;
	if p_owner_user_id is not null and p_owner_user_id is distinct from v_user_id then
		raise exception 'personal provider connection requires owner consent' using errcode = '42501';
	end if;
	if p_owner_user_id is null and not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'company provider connection requires authorize access' using errcode = '42501';
	end if;
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.profile_id = p_profile_id and connection.client_connection_id = p_client_connection_id
	for update;
	if found then
		if v_connection.provider <> p_provider or v_connection.owner_user_id is distinct from p_owner_user_id then
			raise exception 'provider connection id is already bound to other authority' using errcode = '23505';
		end if;
	else
		insert into public.qorpera_provider_connections (
			profile_id, client_connection_id, owner_user_id, provider, created_by_user_id
		) values (p_profile_id, p_client_connection_id, p_owner_user_id, p_provider, v_user_id)
		returning * into v_connection;
	end if;
	select coalesce(max(version), 0) + 1 into v_version
	from public.qorpera_provider_connection_versions where connection_id = v_connection.id;
	insert into public.qorpera_provider_connection_versions (
		connection_id, version, authentication_mode, native_harness, secret_reference,
		provider_account_reference, billing_source, consent_version, consented_by_user_id,
		allow_autonomous, commercial_approval_reference, quota_policy, created_by_user_id
	) values (
		v_connection.id, v_version, p_authentication_mode, btrim(p_native_harness),
		btrim(p_secret_reference), nullif(btrim(p_provider_account_reference), ''),
		btrim(p_billing_source), btrim(p_consent_version), v_user_id,
		coalesce(p_allow_autonomous, false),
		nullif(btrim(p_commercial_approval_reference), ''), p_quota_policy, v_user_id
	);
	return jsonb_build_object('connection_id', v_connection.id, 'version', v_version);
end
$$;

create function public.qorpera_create_execution_sponsor_binding(
	p_profile_id uuid,
	p_client_binding_id uuid,
	p_sponsor_kind text,
	p_provider_connection_id uuid,
	p_provider_connection_version bigint,
	p_allow_autonomous boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
	v_version bigint;
begin
	if v_user_id is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'execution sponsor requires authorize access' using errcode = '42501';
	end if;
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = p_provider_connection_id and connection.profile_id = p_profile_id
		and connection.status = 'active';
	if not found or p_client_binding_id is null or p_sponsor_kind not in (
		'member_connection', 'company_service_account', 'company_api_billing'
	) then
		raise exception 'execution sponsor is invalid' using errcode = '22023';
	end if;
	select version.* into v_connection_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = p_provider_connection_id
		and version.version = p_provider_connection_version;
	if not found then
		raise exception 'execution sponsor is invalid' using errcode = '22023';
	end if;
	if p_sponsor_kind = 'member_connection' and v_connection.owner_user_id is null then
		raise exception 'member sponsor requires a member-owned connection' using errcode = '22023';
	end if;
	if p_sponsor_kind <> 'member_connection' and v_connection.owner_user_id is not null then
		raise exception 'company sponsor requires a company-owned connection' using errcode = '22023';
	end if;
	if p_sponsor_kind = 'member_connection'
		and (v_connection_version.consented_by_user_id is distinct from v_connection.owner_user_id
			or (coalesce(p_allow_autonomous, false) and not v_connection_version.allow_autonomous)) then
		raise exception 'member execution sponsor exceeds the owner consent' using errcode = '42501';
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
	end if;
	select coalesce(max(version), 0) + 1 into v_version
	from public.qorpera_execution_sponsor_versions where binding_id = v_binding.id;
	insert into public.qorpera_execution_sponsor_versions (
		binding_id, version, sponsor_kind, provider_connection_id,
		provider_connection_version, allow_autonomous, created_by_user_id
	) values (
		v_binding.id, v_version, p_sponsor_kind, p_provider_connection_id,
		p_provider_connection_version, coalesce(p_allow_autonomous, false), v_user_id
	);
	return jsonb_build_object('binding_id', v_binding.id, 'version', v_version);
end
$$;

create function public.qorpera_configure_staff_execution_authority(
	p_profile_id uuid,
	p_staff_agent_id uuid,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_logical_computer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_staff public.qorpera_profile_staff%rowtype;
	v_authority public.qorpera_staff_execution_authorities%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'staff execution authority requires authorize access' using errcode = '42501';
	end if;
	select staff.* into v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
		and staff.employment_status = 'active';
	if v_staff.staff_agent_id is null or v_staff.model_id is null or not exists (
		select 1
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_sponsor_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		where binding.id = p_sponsor_binding_id and binding.profile_id = p_profile_id
			and binding.status = 'active' and sponsor.allow_autonomous
			and connection.profile_id = p_profile_id and connection.status = 'active'
			and connection.provider = v_staff.model_provider
			and (
				sponsor.sponsor_kind <> 'member_connection'
				or exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = p_profile_id and member.user_id = connection.owner_user_id
				)
			)
	) or (p_logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = p_logical_computer_id and computer.profile_id = p_profile_id
			and computer.status = 'active' and computer.capabilities ? 'agent_turn'
	)) then
		raise exception 'staff execution authority is unavailable' using errcode = '22023';
	end if;
	insert into public.qorpera_staff_execution_authorities (
		profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
		logical_computer_id, configured_by_user_id
	) values (
		p_profile_id, p_staff_agent_id, p_sponsor_binding_id, p_sponsor_version,
		p_logical_computer_id, v_user_id
	)
	on conflict (profile_id, staff_agent_id) do update set
		sponsor_binding_id = excluded.sponsor_binding_id,
		sponsor_version = excluded.sponsor_version,
		logical_computer_id = excluded.logical_computer_id,
		configured_by_user_id = excluded.configured_by_user_id,
		configured_at = statement_timestamp()
	returning * into v_authority;
	return jsonb_build_object(
		'profile_id', v_authority.profile_id,
		'staff_agent_id', v_authority.staff_agent_id,
		'sponsor_binding_id', v_authority.sponsor_binding_id,
		'sponsor_version', v_authority.sponsor_version,
		'logical_computer_id', v_authority.logical_computer_id,
		'configured_at', v_authority.configured_at
	);
end
$$;

create function public.qorpera_configure_session_execution(
	p_session_id uuid,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_logical_computer_id uuid,
	p_required_capability text,
	p_job_type text,
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
	v_staff_agent_id uuid;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_result public.qorpera_session_execution_bindings%rowtype;
begin
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = p_session_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_session.profile_id) then
		raise exception 'session execution configuration requires authorize access' using errcode = '42501';
	end if;
	begin
		v_staff_agent_id := v_session.staff_agent_id::uuid;
	exception when others then
		raise exception 'session has no durable staff identity' using errcode = '22023';
	end;
	select binding.* into v_binding
	from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = p_sponsor_binding_id and binding.profile_id = v_session.profile_id
		and binding.status = 'active';
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version;
	select connection.* into v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id and connection.profile_id = v_session.profile_id
		and connection.status = 'active';
	if v_binding.id is null or v_sponsor.binding_id is null or v_connection.id is null
		or p_required_capability not in ('agent_turn', 'git_worktree', 'company_substrate')
		or coalesce(p_job_type, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_publication_mode not in ('automatic', 'review')
		or not public.qorpera_uuid_array_is_unique(coalesce(p_reviewer_staff_ids, '{}'::uuid[]))
		or (
			p_publication_mode = 'automatic'
			and (p_review_policy_key is not null or cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) <> 0)
		)
		or (
			p_publication_mode = 'review'
			and (
				char_length(btrim(coalesce(p_review_policy_key, ''))) not between 1 and 128
				or cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) not between 1 and 20
			)
		)
		or not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_session.profile_id and staff.staff_agent_id = v_staff_agent_id
				and staff.employment_status = 'active'
		)
		or (p_logical_computer_id is not null and not exists (
			select 1 from public.qorpera_logical_computers as computer
			where computer.id = p_logical_computer_id and computer.profile_id = v_session.profile_id
				and computer.status = 'active' and computer.capabilities ? p_required_capability
		))
		or exists (
			select 1 from unnest(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) as requested(staff_agent_id)
			where not exists (
				select 1 from public.qorpera_profile_staff as staff
				where staff.profile_id = v_session.profile_id
					and staff.staff_agent_id = requested.staff_agent_id
					and staff.employment_status = 'active'
			) or not exists (
				select 1 from public.qorpera_staff_execution_authorities as authority
				where authority.profile_id = v_session.profile_id
					and authority.staff_agent_id = requested.staff_agent_id
			)
		) then
		raise exception 'session execution configuration is invalid' using errcode = '22023';
	end if;
	if v_sponsor.sponsor_kind = 'member_connection'
		and v_connection.owner_user_id is distinct from v_user_id then
		raise exception 'member execution sponsor requires its owner' using errcode = '42501';
	end if;
	insert into public.qorpera_session_execution_bindings (
		session_id, profile_id, staff_agent_id, sponsor_binding_id, sponsor_version,
		logical_computer_id, required_capability, job_type, publication_mode,
		review_policy_key, reviewer_staff_ids, configured_by_user_id
	) values (
		v_session.id, v_session.profile_id, v_staff_agent_id, p_sponsor_binding_id, p_sponsor_version,
		p_logical_computer_id, p_required_capability, p_job_type, p_publication_mode,
		nullif(btrim(p_review_policy_key), ''), coalesce(p_reviewer_staff_ids, '{}'::uuid[]), v_user_id
	)
	on conflict (session_id) do update set
		staff_agent_id = excluded.staff_agent_id,
		sponsor_binding_id = excluded.sponsor_binding_id,
		sponsor_version = excluded.sponsor_version,
		logical_computer_id = excluded.logical_computer_id,
		required_capability = excluded.required_capability,
		job_type = excluded.job_type,
		publication_mode = excluded.publication_mode,
		review_policy_key = excluded.review_policy_key,
		reviewer_staff_ids = excluded.reviewer_staff_ids,
		configured_by_user_id = excluded.configured_by_user_id,
		configured_at = statement_timestamp()
	returning * into v_result;
	return jsonb_build_object(
		'session_id', v_result.session_id,
		'staff_agent_id', v_result.staff_agent_id,
		'sponsor_binding_id', v_result.sponsor_binding_id,
		'sponsor_version', v_result.sponsor_version,
		'logical_computer_id', v_result.logical_computer_id,
		'required_capability', v_result.required_capability,
		'job_type', v_result.job_type,
		'publication_mode', v_result.publication_mode,
		'review_policy_key', v_result.review_policy_key,
		'reviewer_staff_ids', to_jsonb(v_result.reviewer_staff_ids),
		'configured_at', v_result.configured_at
	);
end
$$;

create function public.qorpera_cloud_routine_trigger_valid(p_trigger jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
	v_interval integer;
	v_weekdays text[];
begin
	if p_trigger is null or jsonb_typeof(p_trigger) <> 'object'
		or not (p_trigger ?& array['id', 'kind', 'intervalMinutes'])
		or jsonb_typeof(p_trigger -> 'id') <> 'string'
		or p_trigger ->> 'id' <> btrim(p_trigger ->> 'id')
		or octet_length(convert_to(p_trigger ->> 'id', 'utf8')) not between 1 and 160
		or p_trigger ->> 'id' ~ E'[\r\n]'
		or p_trigger ->> 'kind' <> 'schedule'
		or jsonb_typeof(p_trigger -> 'intervalMinutes') <> 'number'
		or (p_trigger ->> 'intervalMinutes') !~ '^[0-9]+$' then
		return false;
	end if;
	v_interval := (p_trigger ->> 'intervalMinutes')::integer;
	if v_interval not between 5 and 10080 then return false; end if;

	if p_trigger ? 'weekdays' or p_trigger ? 'localTime' or p_trigger ? 'timeZone' then
		if not (p_trigger ?& array['weekdays', 'localTime', 'timeZone'])
			or p_trigger ? 'startAt'
			or (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'weekdays' - 'localTime' - 'timeZone') <> '{}'::jsonb
			or jsonb_typeof(p_trigger -> 'weekdays') <> 'array'
			or jsonb_array_length(p_trigger -> 'weekdays') not between 1 and 7
			or jsonb_typeof(p_trigger -> 'localTime') <> 'string'
			or (p_trigger ->> 'localTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			or jsonb_typeof(p_trigger -> 'timeZone') <> 'string'
			or char_length(p_trigger ->> 'timeZone') not between 1 and 128
			or p_trigger ->> 'timeZone' = 'auto'
			or not exists (
				select 1 from pg_catalog.pg_timezone_names as zone
				where zone.name = p_trigger ->> 'timeZone'
			) then
			return false;
		end if;
		select array_agg(day.value order by day.ordinality) into v_weekdays
		from jsonb_array_elements_text(p_trigger -> 'weekdays') with ordinality as day(value, ordinality);
		if cardinality(v_weekdays) <> jsonb_array_length(p_trigger -> 'weekdays')
			or cardinality(v_weekdays) <> (select count(distinct weekday) from unnest(v_weekdays) as item(weekday))
			or exists (
				select 1 from unnest(v_weekdays) as item(weekday)
				where item.weekday not in (
					'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
				)
			) then
			return false;
		end if;
	else
		if (p_trigger - 'id' - 'kind' - 'intervalMinutes' - 'startAt') <> '{}'::jsonb then
			return false;
		end if;
		if p_trigger ? 'startAt' then
			if jsonb_typeof(p_trigger -> 'startAt') <> 'string'
				or (p_trigger ->> 'startAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' then
				return false;
			end if;
			if not isfinite((p_trigger ->> 'startAt')::timestamptz) then return false; end if;
		end if;
	end if;
	return true;
exception when others then
	return false;
end
$$;

revoke all on function public.qorpera_cloud_routine_trigger_valid(jsonb) from public;

create function public.qorpera_upsert_cloud_routine(
	p_environment_id uuid,
	p_client_routine_id uuid,
	p_client_version_id uuid,
	p_staff_agent_id uuid,
	p_title text,
	p_prompt text,
	p_triggers jsonb,
	p_effort text,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_logical_computer_id uuid,
	p_required_capability text,
	p_job_type text,
	p_enabled boolean,
	p_publication_mode text,
	p_review_policy_key text,
	p_reviewer_staff_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_routine public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_reviewers uuid[];
	v_content jsonb;
	v_content_sha256 text;
	v_next_version bigint;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_user_id is null or v_profile_id is null or not public.qorpera_can_authorize_profile(v_profile_id) then
		raise exception 'cloud routine requires authorize access' using errcode = '42501';
	end if;
	v_reviewers := array(
		select distinct requested.staff_agent_id
		from unnest(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) as requested(staff_agent_id)
		order by requested.staff_agent_id
	);
	if p_client_routine_id is null or p_client_version_id is null or p_staff_agent_id is null
		or octet_length(convert_to(btrim(coalesce(p_title, '')), 'utf8')) not between 1 and 160
		or p_title ~ E'[\r\n]'
		or octet_length(convert_to(btrim(coalesce(p_prompt, '')), 'utf8')) not between 1 and 32768
		or p_triggers is null or jsonb_typeof(p_triggers) <> 'array'
		or jsonb_array_length(p_triggers) not between 1 and 12
		or pg_column_size(p_triggers) > 12288
		or p_effort not in ('low', 'medium', 'high', 'xhigh', 'max')
		or p_required_capability not in ('agent_turn', 'git_worktree', 'company_substrate')
		or coalesce(p_job_type, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_enabled is null
		or p_publication_mode not in ('automatic', 'review')
		or cardinality(v_reviewers) <> cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[]))
		or (
			p_publication_mode = 'automatic'
			and (p_review_policy_key is not null or cardinality(v_reviewers) <> 0)
		)
		or (
			p_publication_mode = 'review'
			and (
				char_length(btrim(coalesce(p_review_policy_key, ''))) not between 1 and 128
				or cardinality(v_reviewers) not between 1 and 20
			)
		) then
		raise exception 'cloud routine is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1
		from jsonb_array_elements(p_triggers) as trigger(value)
		where not public.qorpera_cloud_routine_trigger_valid(trigger.value)
	) or (
		select count(distinct trigger.value ->> 'id')
		from jsonb_array_elements(p_triggers) as trigger(value)
	) <> jsonb_array_length(p_triggers) then
		raise exception 'cloud routine triggers are invalid' using errcode = '22023';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_staff as staff
		where staff.profile_id = v_profile_id and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active'
	) or exists (
		select 1 from unnest(v_reviewers) as requested(staff_agent_id)
		where not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_profile_id
				and staff.staff_agent_id = requested.staff_agent_id
				and staff.employment_status = 'active'
		) or not exists (
			select 1 from public.qorpera_staff_execution_authorities as authority
			where authority.profile_id = v_profile_id
				and authority.staff_agent_id = requested.staff_agent_id
		)
	) then
		raise exception 'cloud routine staff is unavailable' using errcode = '22023';
	end if;
	if not exists (
		select 1
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_sponsor_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		where binding.id = p_sponsor_binding_id and binding.profile_id = v_profile_id
			and binding.status = 'active' and sponsor.allow_autonomous
			and connection.profile_id = v_profile_id and connection.status = 'active'
			and (sponsor.sponsor_kind <> 'member_connection' or connection.owner_user_id = v_user_id)
	) or (p_logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = p_logical_computer_id and computer.profile_id = v_profile_id
			and computer.status = 'active' and computer.capabilities ? p_required_capability
	)) then
		raise exception 'cloud routine execution authority is unavailable' using errcode = '42501';
	end if;
	v_content := jsonb_build_object(
		'staff_agent_id', p_staff_agent_id,
		'title', btrim(p_title),
		'prompt', btrim(p_prompt),
		'triggers', p_triggers,
		'effort', p_effort,
		'sponsor_binding_id', p_sponsor_binding_id,
		'sponsor_version', p_sponsor_version,
		'logical_computer_id', p_logical_computer_id,
		'required_capability', p_required_capability,
		'job_type', p_job_type,
		'publication_mode', p_publication_mode,
		'review_policy_key', nullif(btrim(p_review_policy_key), ''),
		'reviewer_staff_ids', to_jsonb(v_reviewers)
	);
	if pg_column_size(v_content) > 53248 then
		raise exception 'cloud routine execution envelope is too large' using errcode = '22023';
	end if;
	v_content_sha256 := encode(extensions.digest(convert_to(v_content::text, 'utf8'), 'sha256'), 'hex');
	select routine.* into v_routine
	from public.qorpera_cloud_routines as routine
	where routine.profile_id = v_profile_id and routine.client_routine_id = p_client_routine_id
	for update;
	if not found then
		insert into public.qorpera_cloud_routines (
			profile_id, environment_id, client_routine_id, status, created_by_user_id
		) values (
			v_profile_id, p_environment_id, p_client_routine_id,
			case when p_enabled then 'active' else 'paused' end, v_user_id
		) returning * into v_routine;
	elsif v_routine.environment_id <> p_environment_id or v_routine.status = 'retired' then
		raise exception 'cloud routine identity is unavailable' using errcode = '55000';
	end if;
	select version.* into v_version
	from public.qorpera_cloud_routine_versions as version
	where version.routine_id = v_routine.id and version.client_version_id = p_client_version_id;
	if found then
		if v_version.content_sha256 <> v_content_sha256 then
			raise exception 'cloud routine version id is already bound to other content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'routine_id', v_routine.id, 'client_routine_id', v_routine.client_routine_id,
			'version', v_version.version, 'status', v_routine.status,
			'content_sha256', v_version.content_sha256
		);
	end if;
	v_next_version := v_routine.current_version + 1;
	insert into public.qorpera_cloud_routine_versions (
		routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort,
		sponsor_binding_id, sponsor_version, logical_computer_id,
		required_capability, job_type, publication_mode, review_policy_key,
		reviewer_staff_ids, content_sha256, created_by_user_id
	) values (
		v_routine.id, v_next_version, p_client_version_id, v_profile_id, p_environment_id,
		p_staff_agent_id, btrim(p_title), btrim(p_prompt), p_triggers, p_effort,
		p_sponsor_binding_id, p_sponsor_version, p_logical_computer_id,
		p_required_capability, p_job_type, p_publication_mode,
		nullif(btrim(p_review_policy_key), ''), v_reviewers, v_content_sha256, v_user_id
	) returning * into v_version;
	insert into public.qorpera_cloud_routine_schedule_cursors (
		routine_id, routine_version, trigger_id
	)
	select v_routine.id, v_next_version, trigger.value ->> 'id'
	from jsonb_array_elements(p_triggers) as trigger(value)
	where trigger.value ->> 'kind' = 'schedule';
	update public.qorpera_cloud_routines
	set current_version = v_next_version,
		status = case when p_enabled then 'active' else 'paused' end,
		updated_at = statement_timestamp()
	where id = v_routine.id
	returning * into v_routine;
	return jsonb_build_object(
		'routine_id', v_routine.id, 'client_routine_id', v_routine.client_routine_id,
		'version', v_version.version, 'status', v_routine.status,
		'content_sha256', v_version.content_sha256
	);
end
$$;

create function public.qorpera_enqueue_routine_wake(
	p_routine_id uuid,
	p_expected_version bigint,
	p_occurrence_id uuid,
	p_occurrence_key text,
	p_trigger_id text,
	p_scheduled_for timestamptz,
	p_expected_last_scheduled_for timestamptz,
	p_next_due_at timestamptz,
	p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_routine public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_occurrence public.qorpera_wake_occurrences%rowtype;
	v_cursor public.qorpera_cloud_routine_schedule_cursors%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'wake enqueue requires control-plane authority' using errcode = '42501';
	end if;
	if p_occurrence_id is null or p_expected_version is null or p_expected_version < 1
		or octet_length(convert_to(btrim(coalesce(p_occurrence_key, '')), 'utf8')) not between 1 and 256
		or p_occurrence_key ~ E'[\r\n]'
		or octet_length(convert_to(btrim(coalesce(p_trigger_id, '')), 'utf8')) not between 1 and 160
		or p_trigger_id ~ E'[\r\n]'
		or p_scheduled_for is null or p_next_due_at is null or p_next_due_at <= p_scheduled_for
		or p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 8192 then
		raise exception 'wake occurrence is invalid' using errcode = '22023';
	end if;
	select routine.* into v_routine
	from public.qorpera_cloud_routines as routine where routine.id = p_routine_id
	for share;
	select version.* into v_version
	from public.qorpera_cloud_routine_versions as version
	where version.routine_id = p_routine_id and version.version = p_expected_version;
	if v_routine.id is null or v_routine.status <> 'active'
		or v_routine.current_version <> p_expected_version or v_version.routine_id is null
		or not exists (
			select 1 from jsonb_array_elements(v_version.triggers) as trigger(value)
			where trigger.value ->> 'id' = btrim(p_trigger_id)
				and trigger.value ->> 'kind' = 'schedule'
		) then
		raise exception 'wake routine version is unavailable' using errcode = '40001';
	end if;
	select cursor.* into v_cursor
	from public.qorpera_cloud_routine_schedule_cursors as cursor
	where cursor.routine_id = p_routine_id
		and cursor.routine_version = p_expected_version
		and cursor.trigger_id = btrim(p_trigger_id)
	for update;
	if not found then
		raise exception 'wake schedule cursor is unavailable' using errcode = '40001';
	end if;
	select occurrence.* into v_occurrence
	from public.qorpera_wake_occurrences as occurrence
	where occurrence.routine_id = p_routine_id and occurrence.occurrence_key = btrim(p_occurrence_key);
	if found then
		if v_occurrence.id <> p_occurrence_id
			or v_occurrence.routine_version <> p_expected_version
			or v_occurrence.trigger_id <> btrim(p_trigger_id)
			or v_occurrence.scheduled_for <> p_scheduled_for
			or v_occurrence.payload <> p_payload then
			raise exception 'wake occurrence key is already bound to other work' using errcode = '23505';
		end if;
	end if;
	if v_cursor.last_scheduled_for is distinct from p_expected_last_scheduled_for then
		if v_cursor.last_scheduled_for = p_scheduled_for and v_cursor.next_due_at = p_next_due_at
			and v_occurrence.id is not null then
			return jsonb_build_object(
				'occurrence_id', v_occurrence.id, 'status', v_occurrence.status,
				'run_id', v_occurrence.run_id, 'scheduled_for', v_occurrence.scheduled_for
			);
		end if;
		raise exception 'wake schedule cursor changed' using errcode = '40001';
	end if;
	if p_expected_last_scheduled_for is not null and p_scheduled_for <= p_expected_last_scheduled_for then
		raise exception 'wake schedule did not advance' using errcode = '22023';
	end if;
	if v_occurrence.id is null then
		insert into public.qorpera_wake_occurrences (
			id, profile_id, environment_id, routine_id, routine_version,
			trigger_id, occurrence_key, scheduled_for, not_before, payload
		) values (
			p_occurrence_id, v_routine.profile_id, v_routine.environment_id,
			v_routine.id, v_version.version, btrim(p_trigger_id), btrim(p_occurrence_key),
			p_scheduled_for, p_scheduled_for, p_payload
		) returning * into v_occurrence;
	end if;
	update public.qorpera_cloud_routine_schedule_cursors
	set last_scheduled_for = p_scheduled_for,
		next_due_at = p_next_due_at,
		updated_at = statement_timestamp()
	where routine_id = p_routine_id and routine_version = p_expected_version
		and trigger_id = btrim(p_trigger_id);
	return jsonb_build_object(
		'occurrence_id', v_occurrence.id, 'status', v_occurrence.status,
		'run_id', v_occurrence.run_id, 'scheduled_for', v_occurrence.scheduled_for
	);
end
$$;

create function public.qorpera_list_cloud_routines(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company read access is required' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'routine_id', routine.id,
			'client_routine_id', routine.client_routine_id,
			'version', version.version,
			'status', routine.status,
			'staff_agent_id', version.staff_agent_id,
			'title', version.title,
			'prompt', version.prompt,
			'triggers', version.triggers,
			'effort', version.effort,
			'sponsor_binding_id', version.sponsor_binding_id,
			'sponsor_version', version.sponsor_version,
			'logical_computer_id', version.logical_computer_id,
			'required_capability', version.required_capability,
			'job_type', version.job_type,
			'publication_mode', version.publication_mode,
			'review_policy_key', version.review_policy_key,
			'reviewer_staff_ids', to_jsonb(version.reviewer_staff_ids),
			'content_sha256', version.content_sha256,
			'created_at', routine.created_at,
			'updated_at', routine.updated_at
		) order by routine.created_at, routine.id)
		from public.qorpera_cloud_routines as routine
		join public.qorpera_cloud_routine_versions as version
			on version.routine_id = routine.id and version.version = routine.current_version
		where routine.profile_id = v_profile_id and routine.environment_id = p_environment_id
	), '[]'::jsonb);
end
$$;

create function public.qorpera_list_wake_occurrences(
	p_environment_id uuid,
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
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company read access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'wake occurrence limit is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'occurrence_id', occurrence.id,
			'routine_id', occurrence.routine_id,
			'routine_version', occurrence.routine_version,
			'trigger_id', occurrence.trigger_id,
			'occurrence_key', occurrence.occurrence_key,
			'scheduled_for', occurrence.scheduled_for,
			'not_before', occurrence.not_before,
			'status', occurrence.status,
			'blocked_reason', occurrence.blocked_reason,
			'run_id', occurrence.run_id,
			'created_at', occurrence.created_at,
			'finished_at', occurrence.finished_at
		) order by occurrence.created_at desc, occurrence.id desc)
		from (
			select wake.* from public.qorpera_wake_occurrences as wake
			where wake.profile_id = v_profile_id and wake.environment_id = p_environment_id
			order by wake.created_at desc, wake.id desc
			limit p_limit
		) as occurrence
	), '[]'::jsonb);
end
$$;

create function public.qorpera_list_routine_schedule_heads(
	p_after_routine_id uuid default null,
	p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_items jsonb;
	v_next uuid;
	v_has_more boolean;
begin
	if auth.role() <> 'service_role' then
		raise exception 'routine schedule discovery requires control-plane authority' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'routine schedule page limit is invalid' using errcode = '22023';
	end if;
	with page as (
		select routine.*, version.staff_agent_id, version.triggers, version.content_sha256,
			version.created_at as version_effective_at,
			(
				select jsonb_agg(jsonb_build_object(
					'trigger_id', cursor.trigger_id,
					'last_scheduled_for', cursor.last_scheduled_for,
					'next_due_at', case when cursor.last_scheduled_for is null then null else cursor.next_due_at end
				) order by cursor.trigger_id)
				from public.qorpera_cloud_routine_schedule_cursors as cursor
				where cursor.routine_id = routine.id and cursor.routine_version = routine.current_version
			) as schedule_cursors
		from public.qorpera_cloud_routines as routine
		join public.qorpera_cloud_routine_versions as version
			on version.routine_id = routine.id and version.version = routine.current_version
		where routine.status = 'active'
			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and exists (
				select 1 from public.qorpera_cloud_routine_schedule_cursors as cursor
				where cursor.routine_id = routine.id and cursor.routine_version = routine.current_version
					and cursor.next_due_at <= statement_timestamp()
			)
		order by routine.id
		limit p_limit + 1
	), visible as (
		select * from page order by id limit p_limit
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'routine_id', visible.id,
		'profile_id', visible.profile_id,
		'environment_id', visible.environment_id,
		'version', visible.current_version,
		'staff_agent_id', visible.staff_agent_id,
		'triggers', visible.triggers,
		'schedule_cursors', visible.schedule_cursors,
		'content_sha256', visible.content_sha256,
		'effective_at', visible.version_effective_at,
		'updated_at', visible.updated_at
	) order by visible.id), '[]'::jsonb), (array_agg(visible.id order by visible.id desc))[1]
	into v_items, v_next
	from visible;
	select exists (
		select 1 from public.qorpera_cloud_routines as routine
		where routine.status = 'active' and v_next is not null and routine.id > v_next
			and exists (
				select 1 from public.qorpera_cloud_routine_schedule_cursors as cursor
				where cursor.routine_id = routine.id and cursor.routine_version = routine.current_version
					and cursor.next_due_at <= statement_timestamp()
			)
	) into v_has_more;
	return jsonb_build_object(
		'items', v_items,
		'has_more', v_has_more,
		'next_after_routine_id', case when v_has_more then v_next else null end
	);
end
$$;

create function public.qorpera_enqueue_execution_run(
	p_run_id uuid,
	p_environment_id uuid,
	p_session_id uuid,
	p_source_kind text,
	p_source_id uuid,
	p_substrate_version_id uuid,
	p_staff_agent_id uuid,
	p_staff_version bigint,
	p_sponsor_binding_id uuid,
	p_sponsor_version bigint,
	p_required_capability text,
	p_job_type text,
	p_payload jsonb,
	p_publication_mode text default 'automatic',
	p_review_policy_key text default null,
	p_reviewer_staff_ids uuid[] default '{}'::uuid[],
	p_logical_computer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_environment public.qorpera_company_environments%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_payload_sha256 text;
	v_transcript_start_sequence bigint := 0;
begin
	select environment.* into v_environment
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if v_user_id is null or not found or not public.qorpera_can_write_profile(v_environment.profile_id) then
		raise exception 'execution run requires company write access' using errcode = '42501';
	end if;
	select substrate.* into v_substrate
	from public.qorpera_company_substrate_versions as substrate
	where substrate.id = p_substrate_version_id
		and substrate.profile_id = v_environment.profile_id
		and substrate.environment_id = p_environment_id;
	select file.* into v_file
	from public.qorpera_company_files as file
	where file.profile_id = v_environment.profile_id and file.environment_id = p_environment_id
	for share;
	select staff.* into v_staff
	from public.qorpera_profile_staff as staff
	where staff.profile_id = v_environment.profile_id and staff.staff_agent_id = p_staff_agent_id
		and staff.version = p_staff_version and staff.employment_status = 'active';
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version;
	select binding.* into v_binding
	from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = p_sponsor_binding_id
		and binding.profile_id = v_environment.profile_id and binding.status = 'active';
	if p_run_id is null or p_source_id is null or v_binding.id is null or v_sponsor.binding_id is null
		or v_substrate.id is null or v_file.environment_id is null or v_staff.staff_agent_id is null
		or v_substrate.company_snapshot_id is distinct from v_file.head_snapshot_id
		or p_source_kind not in ('wake', 'manual', 'room_delivery', 'system')
		or p_staff_version is null or p_staff_version < 1
		or p_required_capability not in ('agent_turn', 'git_worktree', 'company_substrate')
		or coalesce(p_job_type, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 65536
		or p_publication_mode not in ('automatic', 'review')
		or not public.qorpera_uuid_array_is_unique(coalesce(p_reviewer_staff_ids, '{}'::uuid[]))
		or (
			p_publication_mode = 'automatic'
			and (p_review_policy_key is not null or cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) <> 0)
		)
		or (
			p_publication_mode = 'review'
			and (
				char_length(btrim(coalesce(p_review_policy_key, ''))) not between 1 and 128
				or cardinality(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) not between 1 and 20
			)
		)
		or (p_session_id is not null and not exists (
			select 1 from public.qorpera_shared_sessions as session
			where session.id = p_session_id and session.environment_id = p_environment_id
				and session.profile_id = v_environment.profile_id
		))
		or (p_logical_computer_id is not null and not exists (
			select 1 from public.qorpera_logical_computers as computer
			where computer.id = p_logical_computer_id and computer.profile_id = v_environment.profile_id
				and computer.status = 'active' and computer.capabilities ? p_required_capability
		)) then
		raise exception 'execution run is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from unnest(coalesce(p_reviewer_staff_ids, '{}'::uuid[])) as requested(staff_agent_id)
		where not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_environment.profile_id
				and staff.staff_agent_id = requested.staff_agent_id
				and staff.employment_status = 'active'
		) or not exists (
			select 1 from public.qorpera_staff_execution_authorities as authority
			where authority.profile_id = v_environment.profile_id
				and authority.staff_agent_id = requested.staff_agent_id
		)
	) then
		raise exception 'execution reviewer is unavailable' using errcode = '22023';
	end if;
	if p_source_kind <> 'session_turn' and not v_sponsor.allow_autonomous then
		raise exception 'execution sponsor does not permit autonomous work' using errcode = '42501';
	end if;
	select connection.* into strict v_connection
	from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id and connection.status = 'active';
	if v_sponsor.sponsor_kind = 'member_connection' and v_connection.owner_user_id <> v_user_id then
		raise exception 'member execution sponsor belongs to another user' using errcode = '42501';
	end if;
	if p_session_id is not null then
		select coalesce(max(event.sequence), 0) into v_transcript_start_sequence
		from public.qorpera_session_events as event where event.session_id = p_session_id;
	end if;
	v_payload_sha256 := encode(extensions.digest(convert_to(p_payload::text, 'utf8'), 'sha256'), 'hex');
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	if found then
		if v_run.environment_id <> p_environment_id or v_run.source_kind <> p_source_kind
			or v_run.source_id <> p_source_id or v_run.substrate_version_id <> p_substrate_version_id
			or v_run.staff_agent_id <> p_staff_agent_id
			or v_run.staff_version <> p_staff_version
			or v_run.sponsor_binding_id <> p_sponsor_binding_id
			or v_run.sponsor_version <> p_sponsor_version
			or v_run.publication_mode <> p_publication_mode
			or v_run.review_policy_key is distinct from nullif(btrim(p_review_policy_key), '')
			or v_run.reviewer_staff_ids is distinct from coalesce(p_reviewer_staff_ids, '{}'::uuid[])
			or v_run.logical_computer_id is distinct from p_logical_computer_id
			or v_run.payload_sha256 <> v_payload_sha256 then
			raise exception 'execution run id is already bound to other work' using errcode = '23505';
		end if;
		return public.qorpera_execution_run_json(v_run);
	end if;
	insert into public.qorpera_runner_jobs (
		profile_id, environment_id, session_id, substrate_version_id, client_job_id,
		required_capability, job_type, payload, created_by_user_id
	) values (
		v_environment.profile_id, p_environment_id, p_session_id, p_substrate_version_id, p_run_id,
		p_required_capability, p_job_type, p_payload, v_user_id
	) returning * into v_job;
	insert into public.qorpera_execution_runs (
		id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
		substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
		sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
		transcript_start_sequence, created_by_user_id
	) values (
		p_run_id, v_environment.profile_id, p_environment_id, p_source_kind, p_source_id,
		p_session_id, v_job.id, p_substrate_version_id, v_substrate.company_snapshot_id,
		p_staff_agent_id, p_staff_version, '{}'::uuid[], p_sponsor_binding_id, p_sponsor_version,
		p_required_capability, p_job_type, v_payload_sha256, p_publication_mode,
		nullif(btrim(p_review_policy_key), ''), coalesce(p_reviewer_staff_ids, '{}'::uuid[]), p_logical_computer_id,
		v_transcript_start_sequence, v_user_id
	) returning * into v_run;
	update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
	if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
		raise exception 'execution sponsor authority or quota is unavailable' using errcode = '55000';
	end if;
	insert into public.qorpera_execution_run_events (run_id, event_type)
	values (v_run.id, 'queued');
	return public.qorpera_execution_run_json(v_run);
end
$$;

create function public.qorpera_append_execution_input_events(
	p_session_id uuid,
	p_input_ids uuid[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint;
	v_previous_hash text;
	v_parent_entry_id text;
	v_body jsonb;
	v_text text;
	v_images jsonb;
	v_event_hash text;
begin
	if auth.role() <> 'service_role' or p_session_id is null
		or coalesce(cardinality(p_input_ids), 0) not between 1 and 32
		or cardinality(p_input_ids) <> (select count(distinct input_id) from unnest(p_input_ids) as input_id) then
		raise exception 'execution input transcript authority is invalid' using errcode = '42501';
	end if;
	select session.* into strict v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id and session.status = 'open'
	for update;
	if (
		select count(*)
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
	) <> cardinality(p_input_ids) then
		raise exception 'execution input transcript set changed' using errcode = '40001';
	end if;
	select event.sequence, event.event_hash, event.body #>> '{entry,id}'
	into v_sequence, v_previous_hash, v_parent_entry_id
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
	order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	for v_input in
		select input.*
		from public.qorpera_session_inputs as input
		where input.session_id = p_session_id and input.id = any(p_input_ids)
		order by input.position
	loop
		if v_input.kind <> 'user_message'
			or v_input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' then
			continue;
		end if;
		select event.* into v_existing
		from public.qorpera_session_events as event
		where event.event_id = v_input.id;
		if found then
			if v_existing.session_id <> p_session_id
				or v_existing.session_input_id is distinct from v_input.id
				or v_existing.actor_user_id <> v_input.author_user_id
				or v_existing.event_type <> 'message' then
				raise exception 'session input event id is already bound to other content' using errcode = '23505';
			end if;
			continue;
		end if;
		v_text := coalesce(v_input.body ->> 'displayText', v_input.body ->> 'text', '');
		v_images := case when jsonb_typeof(v_input.body -> 'images') = 'array'
			then v_input.body -> 'images' else '[]'::jsonb end;
		if v_text = '' then
			v_text := case jsonb_array_length(v_images)
				when 1 then '[Attached image]'
				else '[' || jsonb_array_length(v_images)::text || ' attached images]'
			end;
		end if;
		v_body := jsonb_build_object(
			'schema', 'qorpera.runner-transcript-entry/v1',
			'entry', jsonb_build_object(
				'type', 'message',
				'id', v_input.id,
				'parentId', v_parent_entry_id,
				'timestamp', to_char(v_input.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'message', jsonb_build_object(
					'role', 'user',
					'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text)),
					'timestamp', floor(extract(epoch from v_input.created_at) * 1000)::bigint
				),
				'qorperaAttachments', v_images
			)
		);
		v_sequence := v_sequence + 1;
		v_event_hash := encode(extensions.digest(convert_to(
			coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
				'session_id', p_session_id,
				'sequence', v_sequence,
				'event_id', v_input.id,
				'event_type', 'message',
				'actor_user_id', v_input.author_user_id,
				'body', v_body,
				'session_input_id', v_input.id,
				'created_at', v_input.created_at
			)::text,
			'utf8'
		), 'sha256'), 'hex');
		insert into public.qorpera_session_events (
			session_id, sequence, event_id, event_type, actor_user_id, body,
			previous_hash, event_hash, session_input_id, created_at
		) values (
			p_session_id, v_sequence, v_input.id, 'message', v_input.author_user_id, v_body,
			v_previous_hash, v_event_hash, v_input.id, v_input.created_at
		);
		v_previous_hash := v_event_hash;
		v_parent_entry_id := v_input.id::text;
	end loop;
	update public.qorpera_shared_sessions
	set updated_at = statement_timestamp()
	where id = p_session_id;
	return v_sequence;
end
$$;

revoke all on function public.qorpera_append_execution_input_events(uuid, uuid[]) from public;

create function public.qorpera_materialize_session_execution_runs(p_limit integer default 32)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_binding public.qorpera_session_execution_bindings%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run_id uuid;
	v_input_ids uuid[];
	v_payload jsonb;
	v_payload_sha256 text;
	v_transcript_start_sequence bigint;
	v_claimed integer;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 64 then
		raise exception 'session run materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_binding in
		select binding.*
		from public.qorpera_session_execution_bindings as binding
		join public.qorpera_shared_sessions as session on session.id = binding.session_id
		where session.status = 'open'
			and exists (
				select 1 from public.qorpera_session_inputs as input
				where input.session_id = binding.session_id
					and input.completed_at is null and input.failed_at is null
					and input.execution_run_id is null and input.turn_id is null
			)
			and not exists (
				select 1 from public.qorpera_session_turns as legacy_turn
				where legacy_turn.session_id = binding.session_id and legacy_turn.status = 'active'
			)
		order by session.updated_at, binding.session_id
		for update of binding skip locked
		limit p_limit
	loop
		select session.* into v_session
		from public.qorpera_shared_sessions as session
		where session.id = v_binding.session_id
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
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_session.profile_id and file.environment_id = v_session.environment_id
		for share;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_session.profile_id
			and substrate.environment_id = v_session.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_session.profile_id
			and staff.staff_agent_id = v_binding.staff_agent_id
			and staff.employment_status = 'active';
		if v_file.head_snapshot_id is null or v_substrate.id is null or v_staff.staff_agent_id is null
			or not exists (
				select 1 from public.qorpera_execution_sponsor_bindings as binding
				join public.qorpera_execution_sponsor_versions as sponsor
					on sponsor.binding_id = binding.id and sponsor.version = v_binding.sponsor_version
				join public.qorpera_provider_connections as connection
					on connection.id = sponsor.provider_connection_id
				where binding.id = v_binding.sponsor_binding_id
					and binding.profile_id = v_session.profile_id and binding.status = 'active'
					and connection.profile_id = v_session.profile_id and connection.status = 'active'
			) then
			continue;
		end if;
		with pending as (
			select input.id, input.position, input.body,
				case when jsonb_typeof(input.body -> 'images') = 'array'
					then jsonb_array_length(input.body -> 'images') else 0 end as image_count,
				input.body ->> 'schema' = 'qorpera.staff-intro-retry/v1' as intro_retry
			from public.qorpera_session_inputs as input
			where input.session_id = v_session.id
				and input.completed_at is null and input.failed_at is null
				and input.execution_run_id is null and input.turn_id is null
			order by input.position
			limit 33
		), marked as (
			select pending.*,
				min(pending.position) over () as first_position,
				min(pending.position) filter (where pending.intro_retry) over () as first_intro_retry_position
			from pending
		), turn_segment as (
			select marked.* from marked
			where marked.first_intro_retry_position is null
				or (marked.first_position = marked.first_intro_retry_position
					and marked.position = marked.first_intro_retry_position)
				or (marked.first_position < marked.first_intro_retry_position
					and marked.position < marked.first_intro_retry_position)
		), bounded as (
			select turn_segment.*,
				row_number() over (order by turn_segment.position) as cumulative_inputs,
				sum(octet_length(turn_segment.body::text)) over (order by turn_segment.position) as cumulative_body_bytes,
				sum(turn_segment.image_count) over (order by turn_segment.position) as cumulative_images,
				sum(coalesce((
					select sum((image ->> 'bytes')::bigint)
					from jsonb_array_elements(coalesce(turn_segment.body -> 'images', '[]'::jsonb)) as image
				), 0)) over (order by turn_segment.position) as cumulative_image_bytes
			from turn_segment
		)
		select array_agg(bounded.id order by bounded.position)
		into v_input_ids
		from bounded
		where bounded.cumulative_inputs <= 32
			and bounded.cumulative_body_bytes <= 524288
			and bounded.cumulative_images <= 5
			and bounded.cumulative_image_bytes <= 8388608;
		if v_input_ids is null then continue; end if;
		v_run_id := extensions.gen_random_uuid();
		v_payload := jsonb_build_object(
			'schema', 'qorpera.session-turn-run/v1',
			'session_id', v_session.id,
			'input_ids', to_jsonb(v_input_ids)
		);
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		select coalesce(max(event.sequence), 0) into v_transcript_start_sequence
		from public.qorpera_session_events as event where event.session_id = v_session.id;
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_session.profile_id, v_session.environment_id, v_session.id, v_substrate.id, v_run_id,
			v_binding.required_capability, v_binding.job_type, v_payload, v_binding.configured_by_user_id
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
			publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
			transcript_start_sequence, created_by_user_id
		) values (
			v_run_id, v_session.profile_id, v_session.environment_id, 'session_turn', v_run_id,
			v_session.id, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, v_input_ids,
			v_binding.sponsor_binding_id, v_binding.sponsor_version,
			v_binding.required_capability, v_binding.job_type, v_payload_sha256,
			v_binding.publication_mode, v_binding.review_policy_key, v_binding.reviewer_staff_ids,
			v_binding.logical_computer_id, v_transcript_start_sequence, v_binding.configured_by_user_id
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			continue;
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = v_run.id
		where id = any(v_input_ids) and execution_run_id is null and turn_id is null
			and completed_at is null and failed_at is null;
		get diagnostics v_claimed = row_count;
		if v_claimed <> cardinality(v_input_ids) then
			raise exception 'session inputs changed during run materialization' using errcode = '40001';
		end if;
		v_transcript_start_sequence := public.qorpera_append_execution_input_events(v_session.id, v_input_ids);
		update public.qorpera_execution_runs
		set transcript_start_sequence = v_transcript_start_sequence
		where id = v_run.id
		returning * into v_run;
		update public.qorpera_shared_sessions
		set company_snapshot_id = v_file.head_snapshot_id,
			staff_version = v_staff.version,
			updated_at = statement_timestamp()
		where id = v_session.id;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'queued', jsonb_build_object('input_count', cardinality(v_input_ids)));
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;

create function public.qorpera_materialize_wake_execution_runs(p_limit integer default 32)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_occurrence public.qorpera_wake_occurrences%rowtype;
	v_routine public.qorpera_cloud_routines%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run_id uuid;
	v_payload jsonb;
	v_payload_sha256 text;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 64 then
		raise exception 'wake run materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_occurrence in
		select occurrence.*
		from public.qorpera_wake_occurrences as occurrence
		where occurrence.status = 'queued' and occurrence.not_before <= statement_timestamp()
		order by occurrence.not_before, occurrence.created_at, occurrence.id
		for update skip locked
		limit p_limit
	loop
		select routine.* into v_routine
		from public.qorpera_cloud_routines as routine where routine.id = v_occurrence.routine_id;
		select version.* into v_version
		from public.qorpera_cloud_routine_versions as version
		where version.routine_id = v_occurrence.routine_id
			and version.version = v_occurrence.routine_version;
		if v_routine.id is null or v_version.routine_id is null or v_routine.status <> 'active' then
			update public.qorpera_wake_occurrences
			set status = 'cancelled', blocked_reason = 'Routine was paused or retired before dispatch',
				finished_at = statement_timestamp()
			where id = v_occurrence.id;
			continue;
		end if;
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_occurrence.profile_id
			and file.environment_id = v_occurrence.environment_id
		for share;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_occurrence.profile_id
			and substrate.environment_id = v_occurrence.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_occurrence.profile_id
			and staff.staff_agent_id = v_version.staff_agent_id
			and staff.employment_status = 'active';
		if v_file.head_snapshot_id is null or v_substrate.id is null or v_staff.staff_agent_id is null
			or not exists (
				select 1
				from public.qorpera_execution_sponsor_bindings as binding
				join public.qorpera_execution_sponsor_versions as sponsor
					on sponsor.binding_id = binding.id and sponsor.version = v_version.sponsor_version
				join public.qorpera_provider_connections as connection
					on connection.id = sponsor.provider_connection_id
				where binding.id = v_version.sponsor_binding_id
					and binding.profile_id = v_occurrence.profile_id and binding.status = 'active'
					and sponsor.allow_autonomous
					and connection.profile_id = v_occurrence.profile_id and connection.status = 'active'
			) or (v_version.logical_computer_id is not null and not exists (
				select 1 from public.qorpera_logical_computers as computer
				where computer.id = v_version.logical_computer_id
					and computer.profile_id = v_occurrence.profile_id
					and computer.status = 'active'
					and computer.capabilities ? v_version.required_capability
			)) then
			update public.qorpera_wake_occurrences
			set blocked_reason = 'Pinned Company File, staff, sponsor, or logical computer is unavailable'
			where id = v_occurrence.id;
			continue;
		end if;
		v_run_id := extensions.gen_random_uuid();
		v_payload := jsonb_build_object(
			'schema', 'qorpera.routine-wake-run/v1',
			'occurrence_id', v_occurrence.id,
			'occurrence_key', v_occurrence.occurrence_key,
			'scheduled_for', v_occurrence.scheduled_for,
			'trigger_id', v_occurrence.trigger_id,
			'routine', jsonb_build_object(
				'id', v_routine.id,
				'version', v_version.version,
				'title', v_version.title,
				'prompt', v_version.prompt,
				'effort', v_version.effort,
				'triggers', v_version.triggers
			),
			'event', v_occurrence.payload
		);
		if pg_column_size(v_payload) > 65536 then
			update public.qorpera_wake_occurrences
			set blocked_reason = 'Routine execution envelope exceeds the runner payload limit'
			where id = v_occurrence.id;
			continue;
		end if;
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_occurrence.profile_id, v_occurrence.environment_id, null, v_substrate.id, v_run_id,
			v_version.required_capability, v_version.job_type, v_payload, v_version.created_by_user_id
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type,
			payload_sha256, publication_mode, review_policy_key, reviewer_staff_ids,
			logical_computer_id, transcript_start_sequence, created_by_user_id
		) values (
			v_run_id, v_occurrence.profile_id, v_occurrence.environment_id, 'wake', v_occurrence.id,
			null, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, '{}'::uuid[],
			v_version.sponsor_binding_id, v_version.sponsor_version,
			v_version.required_capability, v_version.job_type, v_payload_sha256,
			v_version.publication_mode, v_version.review_policy_key,
			v_version.reviewer_staff_ids, v_version.logical_computer_id,
			0, v_version.created_by_user_id
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_wake_occurrences
			set blocked_reason = 'Execution sponsor authority or quota is unavailable'
			where id = v_occurrence.id;
			continue;
		end if;
		update public.qorpera_wake_occurrences
		set status = 'materialized', run_id = v_run.id, blocked_reason = null
		where id = v_occurrence.id;
		insert into public.qorpera_execution_run_events (run_id, event_type)
		values (v_run.id, 'queued');
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;

create function public.qorpera_materialize_company_proposal_review_runs(p_limit integer default 32)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_review public.qorpera_company_proposal_review_assignments%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_revision public.qorpera_company_proposal_revisions%rowtype;
	v_origin public.qorpera_execution_runs%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_staff public.qorpera_profile_staff%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_run_id uuid;
	v_payload jsonb;
	v_payload_sha256 text;
	v_runs jsonb := '[]'::jsonb;
begin
	if auth.role() <> 'service_role' or p_limit not between 1 and 64 then
		raise exception 'proposal review materialization requires control-plane authority' using errcode = '42501';
	end if;
	for v_review in
		select review.*
		from public.qorpera_company_proposal_review_assignments as review
		join public.qorpera_company_proposals as proposal on proposal.id = review.proposal_id
		where review.status = 'queued' and proposal.status = 'open'
			and review.proposal_revision = (
				select max(revision.revision)
				from public.qorpera_company_proposal_revisions as revision
				where revision.proposal_id = review.proposal_id
			)
		order by review.created_at, review.id
		for update of review skip locked
		limit p_limit
	loop
		select proposal.* into v_proposal
		from public.qorpera_company_proposals as proposal where proposal.id = v_review.proposal_id;
		select revision.* into v_revision
		from public.qorpera_company_proposal_revisions as revision
		where revision.proposal_id = v_review.proposal_id
			and revision.revision = v_review.proposal_revision;
		select run.* into v_origin
		from public.qorpera_execution_runs as run
		where v_proposal.execution_kind = 'run' and run.id = v_proposal.execution_id;
		select file.* into v_file
		from public.qorpera_company_files as file
		where file.profile_id = v_review.profile_id and file.environment_id = v_proposal.environment_id
		for share;
		select substrate.* into v_substrate
		from public.qorpera_company_substrate_versions as substrate
		where substrate.profile_id = v_review.profile_id
			and substrate.environment_id = v_proposal.environment_id
			and substrate.company_snapshot_id = v_file.head_snapshot_id
		order by substrate.created_at desc, substrate.id desc
		limit 1;
		select staff.* into v_staff
		from public.qorpera_profile_staff as staff
		where staff.profile_id = v_review.profile_id
			and staff.staff_agent_id = v_review.reviewer_staff_agent_id
			and staff.employment_status = 'active';
		select snapshot.* into v_snapshot
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = v_revision.proposal_snapshot_id
			and snapshot.profile_id = v_review.profile_id
			and snapshot.environment_id = v_proposal.environment_id;
		if v_proposal.id is null or v_revision.proposal_id is null or v_origin.id is null
			or v_file.head_snapshot_id is null or v_substrate.id is null
			or v_staff.staff_agent_id is null or v_snapshot.id is null
			or not exists (
				select 1 from public.qorpera_execution_sponsor_versions as sponsor
				where sponsor.binding_id = v_review.reviewer_sponsor_binding_id
					and sponsor.version = v_review.reviewer_sponsor_version and sponsor.allow_autonomous
			) then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer configuration, sponsor, or pinned Company File is unavailable'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		v_payload := jsonb_build_object(
			'schema', 'qorpera.company-proposal-review/v1',
			'proposal_id', v_proposal.id,
			'proposal_revision', v_review.proposal_revision,
			'policy_key', v_proposal.policy_key,
			'title', v_proposal.title,
			'base_snapshot_id', v_revision.base_snapshot_id,
			'proposal_snapshot', public.qorpera_company_snapshot_json(v_snapshot),
			'instruction', 'Review the proposed Company File revision. Return an approve or request_changes decision with a concise, evidence-based comment.'
		);
		if pg_column_size(v_payload) > 65536 then
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer input exceeds the durable runner payload limit'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		v_payload_sha256 := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
		v_run_id := extensions.gen_random_uuid();
		insert into public.qorpera_runner_jobs (
			profile_id, environment_id, session_id, substrate_version_id, client_job_id,
			required_capability, job_type, payload, created_by_user_id
		) values (
			v_review.profile_id, v_proposal.environment_id, null, v_substrate.id, v_run_id,
			'agent_turn', 'proposal_review', v_payload, v_proposal.created_by_user_id
		) returning * into v_job;
		insert into public.qorpera_execution_runs (
			id, profile_id, environment_id, source_kind, source_id, session_id, job_id,
			substrate_version_id, company_snapshot_id, staff_agent_id, staff_version, input_ids,
			sponsor_binding_id, sponsor_version, required_capability, job_type, payload_sha256,
			publication_mode, review_policy_key, reviewer_staff_ids, logical_computer_id,
			transcript_start_sequence, created_by_user_id
		) values (
			v_run_id, v_review.profile_id, v_proposal.environment_id, 'proposal_review', v_run_id,
			null, v_job.id, v_substrate.id, v_file.head_snapshot_id,
			v_staff.staff_agent_id, v_staff.version, '{}'::uuid[],
			v_review.reviewer_sponsor_binding_id, v_review.reviewer_sponsor_version,
			'agent_turn', 'proposal_review',
			v_payload_sha256, 'automatic', null, '{}'::uuid[], v_review.reviewer_logical_computer_id,
			0, v_proposal.created_by_user_id
		) returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_company_proposal_review_assignments
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = 'Reviewer execution sponsor, provider, or quota is unavailable'
			where id = v_review.id and status = 'queued';
			continue;
		end if;
		update public.qorpera_company_proposal_review_assignments
		set status = 'running', run_id = v_run.id, started_at = statement_timestamp()
		where id = v_review.id and status = 'queued';
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'queued', jsonb_build_object(
			'proposal_id', v_proposal.id, 'proposal_revision', v_review.proposal_revision
		));
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;

create or replace function public.qorpera_runner_broker_authorize_input_object(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_object_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_bytes bigint;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if p_object_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner input object is invalid' using errcode = '22023';
	end if;
	select authorized.bytes into v_bytes
	from (
		select entry.bytes
		from public.qorpera_object_reachability_graphs as graph
		join public.qorpera_object_reachability_entries as entry on entry.graph_id = graph.id
		join public.qorpera_company_substrate_versions as version
			on version.id = v_job.substrate_version_id
		where graph.status = 'complete' and graph.closure_verified
			and entry.object_sha256 = p_object_sha256
			and (
				(graph.root_kind = 'company_snapshot' and graph.root_id = version.company_snapshot_id)
				or (graph.root_kind = 'artifact' and exists (
					select 1
					from public.qorpera_artifact_index_entries as index_entry
					where index_entry.index_id = version.artifact_index_id
						and index_entry.artifact_id = graph.root_id
				))
			)
		union
		select entry.bytes
		from public.qorpera_company_proposal_review_assignments as review
		join public.qorpera_company_proposal_revisions as revision
			on revision.proposal_id = review.proposal_id
			and revision.revision = review.proposal_revision
		join public.qorpera_object_reachability_graphs as graph
			on graph.root_kind = 'company_snapshot'
			and graph.root_id = revision.proposal_snapshot_id
			and graph.status = 'complete' and graph.closure_verified
		join public.qorpera_object_reachability_entries as entry on entry.graph_id = graph.id
		where review.run_id = v_job.run_id and review.status = 'running'
			and entry.object_sha256 = p_object_sha256
		union
		select (image ->> 'bytes')::bigint
		from public.qorpera_execution_runs as run
		cross join unnest(run.input_ids) as requested(input_id)
		join public.qorpera_session_inputs as input
			on input.id = requested.input_id
			and input.session_id = run.session_id
			and input.execution_run_id = run.id
		cross join lateral jsonb_array_elements(input.body -> 'images') as image
		where run.id = v_job.run_id
			and run.job_id = v_job.id
			and run.source_kind = 'session_turn'
			and image ->> 'objectSha256' = p_object_sha256
		union
		select output.bytes
		from public.qorpera_runner_job_output_objects as output
		where output.job_id = v_job.id
			and output.object_sha256 = p_object_sha256
			and output.uploaded_at is not null
	) as authorized
	limit 1;
	if not found then
		raise exception 'runner input object is outside the job substrate' using errcode = '42501';
	end if;
	if not public.qorpera_object_exists(v_job.profile_id, p_object_sha256, v_bytes) then
		raise exception 'runner input object is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'profile_id', v_job.profile_id,
		'object_sha256', p_object_sha256,
		'bytes', v_bytes
	);
end
$$;

create function public.qorpera_register_runner_orchestrator(
	p_orchestrator_id uuid,
	p_display_name text,
	p_provider_adapter text,
	p_control_token_sha256 text,
	p_control_token_seconds integer default 86400
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_orchestrator public.qorpera_runner_orchestrators%rowtype;
begin
	if auth.role() <> 'service_role' or p_orchestrator_id is null
		or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120
		or coalesce(p_provider_adapter, '') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or p_control_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_control_token_seconds not between 300 and 604800 then
		raise exception 'orchestrator registration is invalid' using errcode = '42501';
	end if;
	insert into public.qorpera_runner_orchestrators (
		id, display_name, provider_adapter, control_token_sha256, control_token_expires_at
	)
	values (
		p_orchestrator_id, btrim(p_display_name), p_provider_adapter, p_control_token_sha256,
		statement_timestamp() + make_interval(secs => p_control_token_seconds)
	)
	on conflict (id) do update set
		display_name = excluded.display_name,
		provider_adapter = excluded.provider_adapter,
		control_token_sha256 = excluded.control_token_sha256,
		control_token_expires_at = excluded.control_token_expires_at,
		last_heartbeat_at = statement_timestamp()
	where public.qorpera_runner_orchestrators.status <> 'revoked'
	returning * into v_orchestrator;
	if not found then raise exception 'orchestrator is revoked' using errcode = '42501'; end if;
	return jsonb_build_object(
		'orchestrator_id', v_orchestrator.id,
		'provider_adapter', v_orchestrator.provider_adapter,
		'status', v_orchestrator.status,
		'last_heartbeat_at', v_orchestrator.last_heartbeat_at
	);
end
$$;

create function public.qorpera_runner_orchestrator_control_valid(
	p_orchestrator_id uuid,
	p_control_token_sha256 text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select auth.role() = 'service_role' and exists (
		select 1 from public.qorpera_runner_orchestrators as orchestrator
		where orchestrator.id = p_orchestrator_id
			and orchestrator.status in ('active', 'draining')
			and orchestrator.control_token_sha256 = p_control_token_sha256
			and orchestrator.control_token_expires_at > statement_timestamp()
	)
$$;

create function public.qorpera_quarantine_runner_model_requests(
	p_job_id uuid,
	p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_quarantined integer;
begin
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	if not found or v_job.run_id is null
		or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
		raise exception 'model request quarantine is invalid' using errcode = '22023';
	end if;
	update public.qorpera_runner_model_requests
	set status = 'ambiguous', response = null,
		error_code = 'gateway_outcome_unknown', finalized_at = statement_timestamp()
	where job_id = v_job.id and status = 'reserved';
	get diagnostics v_quarantined = row_count;
	if v_quarantined = 0 then return false; end if;
	-- Unknown gateway spend is settled pessimistically at the reserved ceiling.
	-- A later authenticated gateway result may replace this estimate through
	-- the normal immutable finalization path.
	update public.qorpera_execution_sponsor_reservations
	set status = 'settled', actual_microusd = reserved_microusd,
		settled_at = statement_timestamp()
	where run_id = v_job.run_id and status = 'reserved';
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_job.run_id, 'review_pending', jsonb_build_object(
		'reason', 'ambiguous_model_usage',
		'detail', left(btrim(p_reason), 1000),
		'request_count', v_quarantined
	));
	return true;
end
$$;

revoke all on function public.qorpera_quarantine_runner_model_requests(uuid, text) from public;

create function public.qorpera_terminalize_runner_attempt(
	p_job_id uuid,
	p_terminal_status text,
	p_reason text,
	p_allow_pristine_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_output public.qorpera_runner_company_revision_outputs%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_trail_end_sequence bigint := 0;
	v_has_partial boolean := false;
	v_has_unresolved_operation boolean := false;
	v_model_quarantined boolean := false;
	v_changed integer := 0;
	v_reason text := left(btrim(coalesce(p_reason, '')), 1000);
begin
	if p_terminal_status not in ('failed', 'cancelled')
		or p_allow_pristine_retry is null or char_length(v_reason) < 1 then
		raise exception 'runner attempt termination is invalid' using errcode = '22023';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if not found then
		raise exception 'runner attempt is unavailable' using errcode = '55000';
	end if;
	if v_job.status in ('completed', 'failed', 'cancelled') then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if v_job.status not in ('queued', 'leased') then
		raise exception 'runner attempt cannot be terminated' using errcode = '55000';
	end if;
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run
		where run.id = v_job.run_id and run.job_id = v_job.id;
		if v_job.status = 'leased' then
			v_model_quarantined := public.qorpera_quarantine_runner_model_requests(v_job.id, v_reason);
			update public.qorpera_run_operation_receipts
			set status = 'ambiguous', completed_at = coalesce(completed_at, statement_timestamp())
			where run_id = v_run.id and status = 'executing';
			get diagnostics v_changed = row_count;
			v_has_unresolved_operation := v_changed > 0 or exists (
				select 1 from public.qorpera_run_operation_receipts as receipt
				where receipt.run_id = v_run.id and receipt.status = 'ambiguous'
			);
			v_has_partial := v_model_quarantined or v_has_unresolved_operation
				or exists (
					select 1 from public.qorpera_session_events as event
					where event.execution_kind = 'run' and event.execution_id = v_run.id
						and event.runner_assignment_id = v_job.client_lease_id
				) or exists (
					select 1 from public.qorpera_runner_model_requests as request
					where request.job_id = v_job.id
				) or exists (
					select 1 from public.qorpera_run_operation_receipts as receipt
					where receipt.run_id = v_run.id
				) or exists (
					select 1 from public.qorpera_runner_job_artifacts as artifact
					where artifact.job_id = v_job.id
				) or exists (
					select 1 from public.qorpera_runner_job_output_objects as object
					where object.job_id = v_job.id
				) or exists (
					select 1 from public.qorpera_runner_company_revision_outputs as output
					where output.job_id = v_job.id
				);
			if v_has_partial then
				select output.* into v_output
				from public.qorpera_runner_company_revision_outputs as output
				join public.qorpera_run_operation_receipts as receipt
					on receipt.run_id = output.run_id
					and receipt.status = 'completed'
					and receipt.requires_company_revision
					and receipt.output_snapshot_id = output.snapshot_id
				where output.run_id = v_run.id and output.job_id = v_job.id
					and output.assignment_id = v_job.client_lease_id
					and public.qorpera_object_root_has_current_proof('company_snapshot', output.snapshot_id)
				order by output.created_at desc limit 1;
				if found then
					if v_run.session_id is not null then
						select coalesce(max(event.sequence), v_run.transcript_start_sequence)
						into v_trail_end_sequence
						from public.qorpera_session_events as event
						where event.session_id = v_run.session_id;
					end if;
					insert into public.qorpera_company_proposals (
						profile_id, environment_id, client_proposal_id, base_snapshot_id,
						proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
						session_id, trail_end_sequence, reason, policy_key, title,
						reviewer_staff_ids, created_by_user_id
					) values (
						v_run.profile_id, v_run.environment_id, v_run.id, v_run.company_snapshot_id,
						v_output.snapshot_id, 'run', v_run.id, v_run.id,
						v_run.session_id, v_trail_end_sequence, 'recovery', null,
						'Recover completed operation Company File output',
						'{}'::uuid[], v_run.created_by_user_id
					)
					on conflict (profile_id, client_proposal_id) do update
					set title = excluded.title
					where public.qorpera_company_proposals.proposal_snapshot_id = excluded.proposal_snapshot_id
					returning * into v_proposal;
					if v_proposal.id is null then
						raise exception 'recovery proposal id is already bound to another candidate'
							using errcode = '23505';
					end if;
					update public.qorpera_run_operation_receipts
					set proposal_id = v_proposal.id, output_snapshot_id = null
					where run_id = v_run.id and status = 'completed'
						and requires_company_revision and output_snapshot_id = v_output.snapshot_id;
				end if;
			end if;
		end if;
	end if;
	if p_allow_pristine_retry and v_job.status = 'leased' and not v_has_partial
		and v_job.attempt_count < 8 and (
			v_job.run_id is null or v_run.deadline_at > statement_timestamp()
		) then
		update public.qorpera_runner_jobs
		set status = 'queued', runner_id = null, client_lease_id = null,
			terminal_lease_token_sha256 = lease_token_sha256, lease_token_sha256 = null,
			lease_expires_at = null, last_error = v_reason
		where id = v_job.id returning * into v_job;
		return public.qorpera_runner_job_json(v_job);
	end if;
	update public.qorpera_runner_jobs
	set status = p_terminal_status,
		terminal_lease_token_sha256 = case
			when status = 'leased' then lease_token_sha256
			else terminal_lease_token_sha256
		end,
		lease_token_sha256 = null, lease_expires_at = null,
		finished_at = statement_timestamp(),
		last_error = case
			when v_has_partial then v_reason || '; durable attempt output requires review'
			else v_reason
		end
	where id = v_job.id returning * into v_job;
	if v_job.run_id is not null and v_has_partial then
		if not v_model_quarantined then
			insert into public.qorpera_execution_run_events (run_id, event_type, payload)
			values (v_run.id, 'review_pending', jsonb_build_object(
				'reason', case when v_has_unresolved_operation then 'ambiguous_operation' else 'partial_attempt_output' end,
				'assignment_id', v_job.client_lease_id,
				'proposal_id', v_proposal.id
			));
		end if;
		update public.qorpera_wake_occurrences
		set status = 'requires_review', blocked_reason = v_job.last_error,
			finished_at = statement_timestamp()
		where run_id = v_run.id and status = 'failed';
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$$;

revoke all on function public.qorpera_terminalize_runner_attempt(uuid, text, text, boolean) from public;

create function public.qorpera_reconcile_runner_orchestrator(p_orchestrator_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_released integer := 0;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' or not exists (
		select 1 from public.qorpera_runner_orchestrators as orchestrator
		where orchestrator.id = p_orchestrator_id and orchestrator.status = 'active'
	) then
		raise exception 'orchestrator is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_runner_orchestrators
	set last_heartbeat_at = statement_timestamp() where id = p_orchestrator_id;
	perform public.qorpera_materialize_session_execution_runs(32);
	perform public.qorpera_materialize_wake_execution_runs(32);
	perform public.qorpera_materialize_company_proposal_review_runs(32);
	perform public.qorpera_quarantine_runner_model_requests(
		job.id, 'The runner disappeared before the model gateway result was recorded'
	)
	from public.qorpera_runner_jobs as job
	where job.status in ('completed', 'failed', 'cancelled')
		and exists (
			select 1 from public.qorpera_runner_model_requests as request
			where request.job_id = job.id and request.status = 'reserved'
				and request.reservation_expires_at <= statement_timestamp()
		);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Execution sponsor, model policy, or quota reservation is unavailable'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and not public.qorpera_execution_sponsor_available(run);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Pinned logical computer is unavailable or incompatible'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and not public.qorpera_execution_compute_available(run);
	update public.qorpera_runner_jobs as job
	set status = 'failed', finished_at = statement_timestamp(),
		last_error = 'Execution deadline expired before runner acceptance'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and run.deadline_at <= statement_timestamp();
	for v_job in
		select job.* from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on run.id = job.run_id
		where job.status = 'leased' and (
			job.lease_expires_at <= statement_timestamp()
			or run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(run)
			or not public.qorpera_execution_compute_available(run)
		)
		for update skip locked
	loop
		select run.* into strict v_run
		from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if v_run.deadline_at <= statement_timestamp() then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Execution deadline expired before durable completion', false
			);
		elsif not public.qorpera_execution_sponsor_available(v_run) then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Execution sponsor or provider authority became unavailable', false
			);
		elsif not public.qorpera_execution_compute_available(v_run) then
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Pinned logical computer became unavailable or incompatible', false
			);
		else
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Runner lease expired before durable completion', true
			);
		end if;
	end loop;
	update public.qorpera_runner_assignments as assignment
	set status = 'expired', last_error = 'Assignment was not accepted before expiry'
	where assignment.status = 'offered' and assignment.expires_at <= statement_timestamp();
	update public.qorpera_runner_job_claims as claim
	set status = 'released', released_at = statement_timestamp(),
		release_reason = 'Orchestrator claim expired before runner acceptance'
	where claim.status in ('claimed', 'assigned') and claim.lease_expires_at <= statement_timestamp();
	get diagnostics v_released = row_count;
	return jsonb_build_object('released', v_released);
end
$$;

create function public.qorpera_list_retained_runner_claims(p_orchestrator_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.role() <> 'service_role' then
		raise exception 'orchestrator access is required' using errcode = '42501';
	end if;
	return coalesce((
		select jsonb_agg(public.qorpera_execution_work_json(claim) order by claim.created_at, claim.id)
		from public.qorpera_runner_job_claims as claim
		where claim.orchestrator_id = p_orchestrator_id
			and claim.status in ('claimed', 'assigned')
			and claim.lease_expires_at > statement_timestamp()
	), '[]'::jsonb);
end
$$;

create function public.qorpera_claim_runner_job_for_orchestrator(
	p_orchestrator_id uuid,
	p_client_claim_id uuid,
	p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' or p_client_claim_id is null
		or p_lease_seconds not between 30 and 900 then
		raise exception 'orchestrator claim is invalid' using errcode = '42501';
	end if;
	perform public.qorpera_reconcile_runner_orchestrator(p_orchestrator_id);
	select claim.* into v_claim
	from public.qorpera_runner_job_claims as claim
	where claim.orchestrator_id = p_orchestrator_id and claim.client_claim_id = p_client_claim_id;
	if found then
		if v_claim.status not in ('claimed', 'assigned')
			or v_claim.lease_expires_at <= statement_timestamp() then
			raise exception 'orchestrator claim replay is unavailable' using errcode = '40001';
		end if;
		return public.qorpera_execution_work_json(v_claim);
	end if;
	select job.* into v_job
	from public.qorpera_runner_jobs as job
	join public.qorpera_execution_runs as run on run.id = job.run_id
	where job.status = 'queued' and job.attempt_count < 8 and job.dispatch_failure_count < 8
		and run.deadline_at > statement_timestamp()
		and public.qorpera_execution_sponsor_available(run)
		and public.qorpera_execution_compute_available(run)
		and not exists (
			select 1 from public.qorpera_runner_job_claims as active_claim
			where active_claim.job_id = job.id and active_claim.status in ('claimed', 'assigned')
		)
	order by job.created_at, job.id
	for update of job skip locked limit 1;
	if not found then return 'null'::jsonb; end if;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	insert into public.qorpera_runner_job_claims (
		id, orchestrator_id, client_claim_id, job_id, run_id, lease_expires_at
	) values (
		p_client_claim_id, p_orchestrator_id, p_client_claim_id, v_job.id, v_run.id,
		least(v_run.deadline_at, statement_timestamp() + make_interval(secs => p_lease_seconds))
	) returning * into v_claim;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_run.id, 'orchestrator_claimed', jsonb_build_object(
		'orchestrator_id', p_orchestrator_id, 'claim_id', v_claim.id
	));
	return public.qorpera_execution_work_json(v_claim);
end
$$;

create function public.qorpera_renew_runner_job_claim(
	p_orchestrator_id uuid,
	p_claim_id uuid,
	p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role' or p_lease_seconds not between 30 and 900 then
		raise exception 'orchestrator claim renewal is invalid' using errcode = '42501';
	end if;
	select claim.* into v_claim
	from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id
	for update;
	if not found or v_claim.status <> 'claimed'
		or v_claim.lease_expires_at <= statement_timestamp()
		or not exists (
			select 1 from public.qorpera_runner_orchestrators as orchestrator
			where orchestrator.id = p_orchestrator_id and orchestrator.status = 'active'
		) then
		raise exception 'orchestrator claim is unavailable' using errcode = '40001';
	end if;
	select run.* into strict v_run
	from public.qorpera_execution_runs as run where run.id = v_claim.run_id;
	if v_run.deadline_at <= statement_timestamp()
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'orchestrator claim is unavailable' using errcode = '40001';
	end if;
	update public.qorpera_runner_job_claims
	set lease_expires_at = least(v_run.deadline_at, statement_timestamp() + make_interval(secs => p_lease_seconds))
	where id = v_claim.id returning * into v_claim;
	update public.qorpera_runner_orchestrators
	set last_heartbeat_at = statement_timestamp() where id = p_orchestrator_id;
	return public.qorpera_execution_work_json(v_claim);
end
$$;

create function public.qorpera_assign_runner_job(
	p_orchestrator_id uuid,
	p_claim_id uuid,
	p_runner_id uuid,
	p_client_assignment_id uuid,
	p_capability_sha256 text,
	p_assignment_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
begin
	if auth.role() <> 'service_role' or p_client_assignment_id is null
		or p_capability_sha256 !~ '^[0-9a-f]{64}$'
		or p_assignment_seconds not between 30 and 900 then
		raise exception 'runner assignment is invalid' using errcode = '42501';
	end if;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id for update;
	if not found or v_claim.status not in ('claimed', 'assigned')
		or v_claim.lease_expires_at <= statement_timestamp() then
		raise exception 'orchestrator claim is unavailable' using errcode = '40001';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_claim.job_id for update;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_claim.run_id;
	if v_run.deadline_at <= statement_timestamp()
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'execution sponsor is unavailable' using errcode = '42501';
	end if;
	if v_run.logical_computer_id is not null then
		update public.qorpera_runners as runner
		set logical_computer_id = v_run.logical_computer_id
		where runner.id = p_runner_id and runner.profile_id = v_job.profile_id
			and runner.logical_computer_id is null
			and not exists (
				select 1 from public.qorpera_runner_jobs as active_job
				where active_job.runner_id = runner.id and active_job.status = 'leased'
			);
	end if;
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.profile_id = v_job.profile_id
		and runner.status = 'active' and runner.session_expires_at > statement_timestamp()
		and runner.capabilities ? v_job.required_capability
		and (v_run.logical_computer_id is null or runner.logical_computer_id = v_run.logical_computer_id)
		and (
			runner.logical_computer_id is null
			or exists (
				select 1 from public.qorpera_logical_computers as computer
				where computer.id = runner.logical_computer_id and computer.profile_id = v_run.profile_id
					and computer.status = 'active' and computer.capabilities ? v_job.required_capability
			)
		)
	for update;
	if not found then raise exception 'compatible runner is unavailable' using errcode = '55000'; end if;
	update public.qorpera_runner_assignments as assignment
	set status = 'delivery_failed', last_error = 'Superseded after orchestrator recovery'
	where assignment.claim_id = v_claim.id and assignment.status = 'offered';
	insert into public.qorpera_runner_assignments (
		id, claim_id, job_id, run_id, runner_id, capability_sha256, expires_at
	) values (
		p_client_assignment_id, v_claim.id, v_claim.job_id, v_claim.run_id,
		p_runner_id, p_capability_sha256,
		least(v_run.deadline_at, v_claim.lease_expires_at, statement_timestamp() + make_interval(secs => p_assignment_seconds))
	) returning * into v_assignment;
	update public.qorpera_runner_job_claims set status = 'assigned' where id = v_claim.id;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'runner_assigned', jsonb_build_object(
		'orchestrator_id', p_orchestrator_id,
		'assignment_id', v_assignment.id,
		'runner_id', p_runner_id,
		'expires_at', v_assignment.expires_at
	));
	return jsonb_build_object(
		'assignment_id', v_assignment.id,
		'claim_id', v_assignment.claim_id,
		'run_id', v_assignment.run_id,
		'job_id', v_assignment.job_id,
		'runner_id', v_assignment.runner_id,
		'capability_sha256', v_assignment.capability_sha256,
		'expires_at', v_assignment.expires_at
	);
end
$$;

create function public.qorpera_release_runner_job_claim(
	p_orchestrator_id uuid,
	p_claim_id uuid,
	p_client_assignment_id uuid,
	p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
begin
	if auth.role() <> 'service_role' or p_client_assignment_id is null
		or char_length(btrim(coalesce(p_error, ''))) not between 1 and 1000 then
		raise exception 'runner claim release is invalid' using errcode = '42501';
	end if;
	select claim.* into v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = p_claim_id and claim.orchestrator_id = p_orchestrator_id for update;
	if not found then
		raise exception 'runner claim is unavailable' using errcode = '40001';
	end if;
	if v_claim.status = 'released' then
		return jsonb_build_object('released', true);
	end if;
	if v_claim.status not in ('claimed', 'assigned') then
		raise exception 'runner claim is already owned by a runner' using errcode = '40001';
	end if;
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = p_client_assignment_id and assignment.claim_id = p_claim_id for update;
	if v_claim.status = 'assigned' and (not found or v_assignment.status <> 'offered') then
		raise exception 'runner assignment is unavailable' using errcode = '40001';
	end if;
	if v_assignment.id is not null and v_assignment.status = 'offered' then
		update public.qorpera_runner_assignments
		set status = 'delivery_failed', last_error = btrim(p_error) where id = v_assignment.id;
	end if;
	update public.qorpera_runner_job_claims
	set status = 'released', released_at = statement_timestamp(), release_reason = btrim(p_error)
	where id = p_claim_id;
	update public.qorpera_runner_jobs
	set dispatch_failure_count = dispatch_failure_count + 1,
		last_error = btrim(p_error)
	where id = v_claim.job_id and status = 'queued' and dispatch_failure_count < 8
	returning * into v_job;
	if v_job.id is not null and v_job.dispatch_failure_count >= 8 then
		update public.qorpera_runner_jobs
		set status = 'failed', finished_at = statement_timestamp(),
			last_error = 'Runner dispatch failed after the final infrastructure attempt: ' || btrim(p_error)
		where id = v_job.id returning * into v_job;
	end if;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'infrastructure_retry', jsonb_build_object(
		'assignment_id', v_assignment.id, 'reason', btrim(p_error),
		'dispatch_failure_count', v_job.dispatch_failure_count,
		'terminal', coalesce(v_job.status = 'failed', false)
	));
	return jsonb_build_object(
		'released', true,
		'dispatch_failure_count', v_job.dispatch_failure_count,
		'terminal', coalesce(v_job.status = 'failed', false)
	);
end
$$;

create function public.qorpera_accept_runner_assignment(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_assignment_id uuid,
	p_job_id uuid,
	p_assignment_capability_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_runner public.qorpera_runners%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_claim public.qorpera_runner_job_claims%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	if auth.role() <> 'service_role'
		or p_assignment_capability_sha256 !~ '^[0-9a-f]{64}$'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner assignment acceptance is invalid' using errcode = '42501';
	end if;
	select runner.* into strict v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id and runner.status = 'active' for update;
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = p_assignment_id and assignment.job_id = p_job_id
		and assignment.runner_id = p_runner_id for update;
	if not found or v_assignment.capability_sha256 <> p_assignment_capability_sha256 then
		raise exception 'runner assignment capability is unavailable' using errcode = '42501';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id for update;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.deadline_at <= statement_timestamp()
		or not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'execution sponsor is unavailable' using errcode = '42501';
	end if;
	if v_assignment.status = 'accepted' and v_job.status = 'leased'
		and v_job.runner_id = p_runner_id
		and v_job.client_lease_id = p_assignment_id
		and v_job.lease_token_sha256 = p_assignment_capability_sha256
		and v_job.lease_expires_at > statement_timestamp() then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if v_assignment.status <> 'offered' or v_assignment.expires_at <= statement_timestamp()
		or v_job.status <> 'queued' then
		raise exception 'runner assignment is unavailable' using errcode = '40001';
	end if;
	if (
		select count(*) from public.qorpera_runner_jobs as active_job
		where active_job.runner_id = p_runner_id and active_job.status = 'leased'
			and active_job.lease_expires_at > statement_timestamp()
	) >= v_runner.max_concurrency then
		raise exception 'runner is at capacity' using errcode = '55000';
	end if;
	select claim.* into strict v_claim from public.qorpera_runner_job_claims as claim
	where claim.id = v_assignment.claim_id and claim.status = 'assigned'
		and claim.lease_expires_at > statement_timestamp() for update;
	update public.qorpera_runner_jobs
	set status = 'leased', runner_id = p_runner_id, client_lease_id = p_assignment_id,
		lease_token_sha256 = p_assignment_capability_sha256,
		lease_expires_at = least(v_run.deadline_at, statement_timestamp() + interval '2 minutes'),
		attempt_count = attempt_count + 1,
		started_at = coalesce(started_at, statement_timestamp()), last_error = null
	where id = p_job_id returning * into v_job;
	update public.qorpera_runner_assignments
	set status = 'accepted', accepted_at = statement_timestamp() where id = p_assignment_id;
	update public.qorpera_runner_job_claims set status = 'accepted' where id = v_claim.id;
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_claim.run_id, 'runner_started', jsonb_build_object(
		'assignment_id', p_assignment_id, 'runner_id', p_runner_id,
		'lease_expires_at', v_job.lease_expires_at
	));
	return public.qorpera_runner_job_json(v_job);
end
$$;

create or replace function public.qorpera_renew_runner_job(
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
	v_run public.qorpera_execution_runs%rowtype;
	v_lease_expires_at timestamptz;
begin
	if auth.role() <> 'service_role'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job renewal is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.status = 'leased' and job.runner_id = p_runner_id
		and job.lease_token_sha256 = p_lease_token_sha256
		and job.lease_expires_at > statement_timestamp() for update;
	if not found then raise exception 'runner job lease is unavailable' using errcode = '40001'; end if;
	v_lease_expires_at := statement_timestamp() + interval '2 minutes';
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if v_run.deadline_at <= statement_timestamp()
			or not public.qorpera_execution_sponsor_available(v_run)
			or not public.qorpera_execution_compute_available(v_run) then
			raise exception 'runner job authority is unavailable' using errcode = '40001';
		end if;
		v_lease_expires_at := least(v_lease_expires_at, v_run.deadline_at);
	end if;
	update public.qorpera_runner_jobs
	set lease_expires_at = v_lease_expires_at
	where id = p_job_id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id, 'job_lease_renewed',
		jsonb_build_object('lease_expires_at', v_job.lease_expires_at), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;

create function public.qorpera_begin_run_operation_receipt(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_receipt_id uuid,
	p_logical_operation_key text,
	p_operation_kind text,
	p_input_sha256 text,
	p_downstream_idempotency_sha256 text,
	p_requires_company_revision boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if exists (
		select 1 from public.qorpera_execution_runs as run
		where run.id = v_job.run_id and run.source_kind = 'proposal_review'
	) then
		raise exception 'proposal review executions cannot perform operations' using errcode = '42501';
	end if;
	if v_job.run_id is null or p_receipt_id is null
		or char_length(btrim(coalesce(p_logical_operation_key, ''))) not between 1 and 256
		or coalesce(p_operation_kind, '') !~ '^[a-z][a-z0-9_]{0,63}$'
		or p_input_sha256 !~ '^[0-9a-f]{64}$'
		or p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$'
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.job_id = p_job_id
				and assignment.run_id = v_job.run_id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
		) then
		raise exception 'run operation authority is invalid' using errcode = '42501';
	end if;
	select receipt.* into v_receipt
	from public.qorpera_run_operation_receipts as receipt
	where receipt.run_id = v_job.run_id and receipt.logical_operation_key = btrim(p_logical_operation_key)
	for update;
	if found then
		if v_receipt.operation_kind <> p_operation_kind
			or v_receipt.input_sha256 <> p_input_sha256
			or v_receipt.downstream_idempotency_sha256 <> p_downstream_idempotency_sha256
			or v_receipt.requires_company_revision <> coalesce(p_requires_company_revision, false) then
			raise exception 'logical operation key is already bound to other work' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'state', v_receipt.status,
			'receipt_id', v_receipt.id,
			'result', v_receipt.result,
			'output_snapshot_id', v_receipt.output_snapshot_id,
			'proposal_id', v_receipt.proposal_id
		);
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as unresolved
		where unresolved.run_id = v_job.run_id and unresolved.status in ('executing', 'ambiguous')
	) then
		raise exception 'run has an unresolved operation' using errcode = '55000';
	end if;
	update public.qorpera_execution_run_budgets
	set operation_count = operation_count + 1
	where run_id = v_job.run_id and operation_count < 256;
	if not found then
		raise exception 'run operation budget is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_run_operation_receipts (
		id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, requires_company_revision
	) values (
		p_receipt_id, v_job.run_id, p_job_id, p_assignment_id, btrim(p_logical_operation_key),
		p_operation_kind, p_input_sha256, p_downstream_idempotency_sha256,
		coalesce(p_requires_company_revision, false)
	) returning * into v_receipt;
	return jsonb_build_object('state', 'executing', 'receipt_id', v_receipt.id);
end
$$;

create function public.qorpera_complete_run_operation_receipt(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_receipt_id uuid,
	p_input_sha256 text,
	p_result jsonb,
	p_output_snapshot_id uuid default null,
	p_proposal_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 65536
		or (p_output_snapshot_id is not null and p_proposal_id is not null) then
		raise exception 'run operation result is invalid' using errcode = '22023';
	end if;
	select receipt.* into v_receipt
	from public.qorpera_run_operation_receipts as receipt
	where receipt.id = p_receipt_id and receipt.run_id = v_job.run_id for update;
	if not found or v_receipt.job_id <> p_job_id or v_receipt.assignment_id <> p_assignment_id
		or v_receipt.input_sha256 <> p_input_sha256 then
		raise exception 'run operation receipt is unavailable' using errcode = '40001';
	end if;
	if v_receipt.status = 'completed' then
		if v_receipt.result <> p_result
			or v_receipt.output_snapshot_id is distinct from p_output_snapshot_id
			or v_receipt.proposal_id is distinct from p_proposal_id then
			raise exception 'run operation completion replay differs' using errcode = '23505';
		end if;
		return jsonb_build_object('state', 'completed', 'receipt_id', v_receipt.id, 'result', v_receipt.result);
	end if;
	if v_receipt.status <> 'executing' then
		raise exception 'run operation requires recovery review' using errcode = '55000';
	end if;
	if v_receipt.requires_company_revision and p_output_snapshot_id is null and p_proposal_id is null then
		raise exception 'Company File operation has no durable revision' using errcode = '55000';
	end if;
	if p_output_snapshot_id is not null and not exists (
		select 1 from public.qorpera_company_snapshots as snapshot
		join public.qorpera_company_snapshot_publications as publication
			on publication.snapshot_id = snapshot.id and publication.status in ('prepared', 'published')
		join public.qorpera_runner_company_revision_outputs as output
			on output.snapshot_id = snapshot.id
		where snapshot.id = p_output_snapshot_id and snapshot.profile_id = v_job.profile_id
			and snapshot.environment_id = v_job.environment_id
			and output.run_id = v_job.run_id and output.job_id = v_job.id
			and output.assignment_id = v_receipt.assignment_id
			and public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
	) then
		raise exception 'Company File operation snapshot is not the verified run candidate' using errcode = '55000';
	end if;
	if p_proposal_id is not null and not exists (
		select 1 from public.qorpera_company_proposals as proposal
		join public.qorpera_runner_company_revision_outputs as output
			on output.snapshot_id = proposal.proposal_snapshot_id
		where proposal.id = p_proposal_id and proposal.profile_id = v_job.profile_id
			and proposal.environment_id = v_job.environment_id
			and proposal.execution_kind = 'run' and proposal.execution_id = v_job.run_id
			and proposal.execution_claimant_id = v_job.run_id
			and output.run_id = v_job.run_id and output.job_id = v_job.id
			and output.assignment_id = v_receipt.assignment_id
	) then
		raise exception 'Company File operation proposal is not owned by this run' using errcode = '55000';
	end if;
	update public.qorpera_run_operation_receipts
	set status = 'completed', result = p_result,
		output_snapshot_id = p_output_snapshot_id, proposal_id = p_proposal_id,
		completed_at = statement_timestamp()
	where id = p_receipt_id returning * into v_receipt;
	return jsonb_build_object('state', 'completed', 'receipt_id', v_receipt.id, 'result', v_receipt.result);
end
$$;

create function public.qorpera_resolve_run_operation_receipt(
	p_receipt_id uuid,
	p_resolution text,
	p_result jsonb default null,
	p_output_snapshot_id uuid default null,
	p_proposal_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
begin
	select receipt.* into v_receipt
	from public.qorpera_run_operation_receipts as receipt where receipt.id = p_receipt_id for update;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_receipt.run_id;
	if v_user_id is null or v_receipt.id is null or not public.qorpera_can_authorize_profile(v_run.profile_id) then
		raise exception 'operation recovery requires authorize access' using errcode = '42501';
	end if;
	if v_receipt.status <> 'ambiguous'
		or p_resolution not in ('confirmed_completed', 'confirmed_not_run') then
		raise exception 'operation recovery is unavailable' using errcode = '55000';
	end if;
	if p_resolution = 'confirmed_completed' then
		if jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 65536
			or (v_receipt.requires_company_revision and p_output_snapshot_id is null and p_proposal_id is null)
			or (p_output_snapshot_id is not null and p_proposal_id is not null) then
			raise exception 'operation recovery result is invalid' using errcode = '22023';
		end if;
		if p_output_snapshot_id is not null and not exists (
			select 1 from public.qorpera_company_snapshots as snapshot
			join public.qorpera_company_snapshot_publications as publication
				on publication.snapshot_id = snapshot.id and publication.status in ('prepared', 'published')
			join public.qorpera_runner_company_revision_outputs as output
				on output.snapshot_id = snapshot.id
			where snapshot.id = p_output_snapshot_id and snapshot.profile_id = v_run.profile_id
				and snapshot.environment_id = v_run.environment_id
				and output.run_id = v_run.id and output.job_id = v_receipt.job_id
				and output.assignment_id = v_receipt.assignment_id
				and public.qorpera_object_root_has_current_proof('company_snapshot', snapshot.id)
		) then
			raise exception 'recovered Company File snapshot is not the verified run candidate' using errcode = '55000';
		end if;
		if p_proposal_id is not null and not exists (
			select 1 from public.qorpera_company_proposals as proposal
			join public.qorpera_runner_company_revision_outputs as output
				on output.snapshot_id = proposal.proposal_snapshot_id
			where proposal.id = p_proposal_id and proposal.profile_id = v_run.profile_id
				and proposal.environment_id = v_run.environment_id
				and proposal.execution_kind = 'run' and proposal.execution_id = v_run.id
				and proposal.execution_claimant_id = v_run.id
				and output.run_id = v_run.id and output.job_id = v_receipt.job_id
				and output.assignment_id = v_receipt.assignment_id
		) then
			raise exception 'recovered Company File proposal is unavailable' using errcode = '55000';
		end if;
		update public.qorpera_run_operation_receipts
		set status = 'completed', result = p_result, output_snapshot_id = p_output_snapshot_id,
			proposal_id = p_proposal_id, recovery_resolution = p_resolution,
			recovery_resolved_by_user_id = v_user_id, recovery_resolved_at = statement_timestamp()
		where id = p_receipt_id returning * into v_receipt;
	else
		update public.qorpera_run_operation_receipts
		set status = 'cancelled', recovery_resolution = p_resolution,
			recovery_resolved_by_user_id = v_user_id, recovery_resolved_at = statement_timestamp()
		where id = p_receipt_id returning * into v_receipt;
	end if;
	return jsonb_build_object(
		'receipt_id', v_receipt.id, 'status', v_receipt.status,
		'recovery_resolution', v_receipt.recovery_resolution
	);
end
$$;

create function public.qorpera_bind_execution_provider_session(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_provider_session_id text,
	p_context_checkpoint_object_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_owner public.qorpera_provider_session_owners%rowtype;
	v_existing public.qorpera_execution_provider_sessions%rowtype;
	v_provider_session_id text := btrim(p_provider_session_id);
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	select sponsor.* into strict v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	if v_run.id is null or char_length(coalesce(v_provider_session_id, '')) not between 1 and 1024
		or p_provider_session_id ~ E'[\r\n]'
		or (p_context_checkpoint_object_sha256 is not null
			and p_context_checkpoint_object_sha256 !~ '^[0-9a-f]{64}$') then
		raise exception 'provider session binding is invalid' using errcode = '22023';
	end if;
	if p_context_checkpoint_object_sha256 is not null and not exists (
		select 1
		from public.qorpera_runner_job_output_objects as output
		join public.qorpera_profile_objects as object
			on object.profile_id = output.profile_id
			and object.sha256 = output.object_sha256
			and object.bytes = output.bytes
		where output.job_id = v_job.id
			and output.profile_id = v_run.profile_id
			and output.object_sha256 = p_context_checkpoint_object_sha256
			and output.uploaded_at is not null
			and 'artifact' = any(output.purposes)
	) then
		raise exception 'provider context checkpoint is not an uploaded run output' using errcode = '55000';
	end if;
	select session.* into v_existing
	from public.qorpera_execution_provider_sessions as session
	where session.run_id = v_run.id
		and session.provider_connection_id = v_sponsor.provider_connection_id;
	if found then
		if v_existing.provider_connection_version <> v_sponsor.provider_connection_version
			or v_existing.provider_session_id <> v_provider_session_id
			or v_existing.context_checkpoint_object_sha256 is distinct from p_context_checkpoint_object_sha256 then
			raise exception 'provider session is already bound to other state' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'run_id', v_run.id,
			'provider_connection_id', v_existing.provider_connection_id,
			'provider_session_id', v_existing.provider_session_id
		);
	end if;
	select owner.* into v_owner
	from public.qorpera_provider_session_owners as owner
	where owner.provider_connection_id = v_sponsor.provider_connection_id
		and owner.provider_connection_version = v_sponsor.provider_connection_version
		and owner.provider_session_id = v_provider_session_id
	for update;
	if found then
		if v_owner.profile_id <> v_run.profile_id
			or v_owner.qorpera_session_id is distinct from v_run.session_id
			or (v_run.session_id is null and v_owner.origin_run_id <> v_run.id) then
			raise exception 'provider session belongs to another Qorpera session' using errcode = '23505';
		end if;
	else
		insert into public.qorpera_provider_session_owners (
			provider_connection_id, provider_connection_version, provider_session_id,
			profile_id, qorpera_session_id, origin_run_id
		) values (
			v_sponsor.provider_connection_id, v_sponsor.provider_connection_version,
			v_provider_session_id, v_run.profile_id, v_run.session_id, v_run.id
		);
	end if;
	insert into public.qorpera_execution_provider_sessions (
		run_id, profile_id, provider_connection_id, provider_connection_version,
		provider_session_id, context_checkpoint_object_sha256
	) values (
		v_run.id, v_run.profile_id, v_sponsor.provider_connection_id,
		v_sponsor.provider_connection_version, v_provider_session_id,
		p_context_checkpoint_object_sha256
	);
	insert into public.qorpera_execution_run_events (run_id, event_type, payload)
	values (v_run.id, 'provider_session_bound', jsonb_build_object(
		'provider_connection_id', v_sponsor.provider_connection_id,
		'has_context_checkpoint', p_context_checkpoint_object_sha256 is not null
	));
	return jsonb_build_object(
		'run_id', v_run.id,
		'provider_connection_id', v_sponsor.provider_connection_id,
		'provider_session_id', v_provider_session_id
	);
end
$$;

create function public.qorpera_runner_transcript_entry_valid(
	p_event_type text,
	p_body jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_entry jsonb := p_body -> 'entry';
	v_message jsonb;
begin
	if coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or jsonb_typeof(v_entry) <> 'object'
		or coalesce(jsonb_typeof(v_entry -> 'parentId'), '') not in ('null', 'string')
		or (jsonb_typeof(v_entry -> 'parentId') = 'string'
			and octet_length(convert_to(v_entry ->> 'parentId', 'utf8')) not between 1 and 128)
		or coalesce(v_entry ->> 'timestamp', '') !~
			'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$' then
		return false;
	end if;
	if p_event_type = 'message' then
		v_message := v_entry -> 'message';
		if v_entry ->> 'type' <> 'message'
			or jsonb_typeof(v_message) <> 'object'
			or coalesce(v_message ->> 'role', '') not in ('assistant', 'tool')
			or jsonb_typeof(v_message -> 'content') <> 'array'
			or jsonb_array_length(v_message -> 'content') not between 1 and 256
			or exists (
				select 1 from jsonb_array_elements(v_message -> 'content') as part(value)
				where jsonb_typeof(part.value) <> 'object'
					or coalesce(part.value ->> 'type', '') not in ('text', 'thinking', 'toolCall', 'image')
					or (part.value ->> 'type' = 'text' and jsonb_typeof(part.value -> 'text') <> 'string')
					or (part.value ->> 'type' = 'thinking'
						and jsonb_typeof(part.value -> 'thinking') <> 'string')
					or (part.value ->> 'type' = 'toolCall' and (
						jsonb_typeof(part.value -> 'id') <> 'string'
						or jsonb_typeof(part.value -> 'name') <> 'string'
						or jsonb_typeof(part.value -> 'arguments') <> 'object'
					))
					or (part.value ->> 'type' = 'image' and (
						jsonb_typeof(part.value -> 'data') <> 'string'
						or jsonb_typeof(part.value -> 'mimeType') <> 'string'
					))
			) then
			return false;
		end if;
		return true;
	end if;
	return p_event_type in (
		'run_receipt', 'artifact_receipt', 'authorization_request', 'authorization_decision'
	) and v_entry ->> 'type' = 'custom'
		and v_entry ->> 'customType' = p_event_type
		and jsonb_typeof(v_entry -> 'data') = 'object'
		and (select count(*) from jsonb_object_keys(v_entry -> 'data')) between 1 and 64;
end
$$;

revoke all on function public.qorpera_runner_transcript_entry_valid(text, jsonb) from public;

create function public.qorpera_append_runner_transcript_event(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if v_run.id is null or v_run.session_id is null or p_event_id is null
		or p_event_type not in (
			'message', 'run_receipt', 'artifact_receipt',
			'authorization_request', 'authorization_decision'
		) or p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144
		or coalesce(p_body ->> 'schema', '') <> 'qorpera.runner-transcript-entry/v1'
		or coalesce(jsonb_typeof(p_body -> 'entry'), '') <> 'object'
		or coalesce(p_body #>> '{entry,id}', '') <> p_event_id::text
		or not public.qorpera_runner_transcript_entry_valid(p_event_type, p_body)
		or coalesce(p_body #>> '{entry,execution,kind}', '') <> 'run'
		or coalesce(p_body #>> '{entry,execution,id}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,claimantId}', '') <> v_run.id::text
		or coalesce(p_body #>> '{entry,execution,runnerAssignmentId}', '') <> p_assignment_id::text
		or not exists (
			select 1 from public.qorpera_runner_assignments as assignment
			where assignment.id = p_assignment_id and assignment.job_id = p_job_id
				and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
				and assignment.status = 'accepted'
		) then
		raise exception 'runner transcript authority is invalid' using errcode = '42501';
	end if;
	select event.* into v_existing
	from public.qorpera_session_events as event where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> v_run.session_id or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body or v_existing.execution_kind <> 'run'
			or v_existing.execution_id <> v_run.id
			or v_existing.execution_claimant_id <> v_run.id then
			raise exception 'runner event id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id, 'sequence', v_existing.sequence,
			'event_id', v_existing.event_id, 'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id, 'body', v_existing.body,
			'previous_hash', v_existing.previous_hash, 'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind, 'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'runner_assignment_id', v_existing.runner_assignment_id,
			'created_at', v_existing.created_at
		);
	end if;
	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = v_run.session_id for update;
	if not found or v_session.status <> 'open'
		or v_session.profile_id <> v_run.profile_id or v_session.environment_id <> v_run.environment_id
		or v_session.company_snapshot_id <> v_run.company_snapshot_id
		or v_session.staff_version <> v_run.staff_version then
		raise exception 'runner transcript session pins changed' using errcode = '40001';
	end if;
	if jsonb_typeof(p_body #> '{entry,parentId}') = 'string'
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body #>> '{entry,id}' = p_body #>> '{entry,parentId}'
		)
		and not exists (
			select 1
			from public.qorpera_session_events as parent
			where parent.session_id = v_session.id
				and parent.body ->> 'schema' = 'qorpera.shared-trail-entry-part/v1'
				and parent.body ->> 'entryId' = p_body #>> '{entry,parentId}'
				and jsonb_typeof(parent.body -> 'partIndex') = 'number'
				and jsonb_typeof(parent.body -> 'partCount') = 'number'
			group by parent.body ->> 'entryId', parent.body ->> 'partCount',
				parent.execution_kind, parent.execution_id, parent.execution_claimant_id
			having count(distinct (parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer
				and min((parent.body ->> 'partIndex')::integer) = 0
				and max((parent.body ->> 'partIndex')::integer) = (parent.body ->> 'partCount')::integer - 1
		) then
		raise exception 'runner transcript parent is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_execution_run_budgets
	set transcript_event_count = transcript_event_count + 1,
		transcript_bytes = transcript_bytes + octet_length(convert_to(p_body::text, 'utf8'))
	where run_id = v_run.id and transcript_event_count < 2000
		and transcript_bytes + octet_length(convert_to(p_body::text, 'utf8')) <= 67108864;
	if not found then
		raise exception 'runner transcript budget is exhausted' using errcode = '55000';
	end if;
	select event.sequence, event.event_hash into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = v_session.id order by event.sequence desc limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise exception 'session event sequence changed' using errcode = '40001';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(extensions.digest(convert_to(
		coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
			'session_id', v_session.id,
			'sequence', v_sequence,
			'event_id', p_event_id,
			'event_type', p_event_type,
			'actor_user_id', v_run.created_by_user_id,
			'body', p_body,
			'execution_kind', 'run',
			'execution_id', v_run.id,
			'execution_claimant_id', v_run.id,
			'runner_assignment_id', p_assignment_id,
			'created_at', v_created_at
		)::text, 'utf8'), 'sha256'), 'hex');
	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, runner_assignment_id, created_at
	) values (
		v_session.id, v_sequence, p_event_id, p_event_type, v_run.created_by_user_id, p_body,
		v_previous_hash, v_event_hash, 'run', v_run.id, v_run.id, p_assignment_id, v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = v_session.id;
	return jsonb_build_object(
		'session_id', v_session.id, 'sequence', v_sequence,
		'event_id', p_event_id, 'event_type', p_event_type,
		'actor_user_id', v_run.created_by_user_id, 'body', p_body,
		'previous_hash', v_previous_hash, 'event_hash', v_event_hash,
		'execution_kind', 'run', 'execution_id', v_run.id,
		'execution_claimant_id', v_run.id, 'runner_assignment_id', p_assignment_id,
		'created_at', v_created_at
	);
end
$$;

create function public.qorpera_complete_runner_job_v5(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_client_artifact_index_id uuid,
	p_client_substrate_version_id uuid,
	p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_result jsonb;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if v_job.run_id is not null then
		select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
		if exists (
			select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
		) then
			raise exception 'runner execution has an unresolved operation' using errcode = '55000';
		end if;
		if v_run.session_id is not null and not exists (
			select 1 from public.qorpera_session_events as event
			where event.session_id = v_run.session_id and event.execution_kind = 'run'
				and event.execution_id = v_run.id and event.sequence > v_run.transcript_start_sequence
		) then
			raise exception 'runner execution has no durable transcript output' using errcode = '55000';
		end if;
	end if;
	v_result := public.qorpera_complete_runner_job_v4(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_client_artifact_index_id, p_client_substrate_version_id, p_result
	);
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs
		set completed_at = coalesce(completed_at, statement_timestamp())
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		if exists (
			select 1 from unnest(v_run.input_ids) as expected(input_id)
			where not exists (
				select 1 from public.qorpera_session_inputs as input
				where input.id = expected.input_id and input.session_id = v_run.session_id
					and input.execution_run_id = v_run.id and input.completed_at is not null
			)
		) then
			raise exception 'runner session inputs changed before completion' using errcode = '40001';
		end if;
	end if;
	return v_result;
end
$$;

create or replace function public.qorpera_runner_broker_authorize_output_object(
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
	v_count integer;
	v_total_bytes bigint;
	v_media_type text := lower(btrim(p_media_type));
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	if exists (
		select 1 from public.qorpera_execution_runs as run
		where run.id = v_job.run_id and run.source_kind = 'proposal_review'
	) then
		raise exception 'proposal review executions cannot create artifacts' using errcode = '42501';
	end if;
	if p_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 0 and 8388608
		or char_length(v_media_type) not between 3 and 256
		or v_media_type not like '%/%'
		or v_media_type ~ E'[\r\n]' then
		raise exception 'runner output object is invalid' using errcode = '22023';
	end if;
	select output.* into v_existing
	from public.qorpera_runner_job_output_objects as output
	where output.job_id = v_job.id and output.object_sha256 = p_object_sha256
	for update;
	if found then
		if v_existing.bytes <> p_bytes or v_existing.media_type <> v_media_type then
			raise exception 'runner output hash is already bound to different metadata' using errcode = '23505';
		end if;
		if not ('artifact' = any(v_existing.purposes)) then
			update public.qorpera_runner_job_output_objects
			set purposes = array['artifact', 'company_file']::text[]
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
	select count(*), coalesce(sum(output.bytes), 0)
	into v_count, v_total_bytes
	from public.qorpera_runner_job_output_objects as output
	where output.job_id = v_job.id and 'artifact' = any(output.purposes);
	if v_count >= 100 or v_total_bytes + p_bytes > 67108864 then
		raise exception 'runner job output limit is exhausted' using errcode = '55000';
	end if;
	insert into public.qorpera_runner_job_output_objects (
		job_id, profile_id, object_sha256, bytes, media_type, purposes
	) values (
		v_job.id, v_job.profile_id, p_object_sha256, p_bytes, v_media_type,
		array['artifact']::text[]
	) returning * into v_existing;
	return jsonb_build_object(
		'profile_id', v_existing.profile_id,
		'object_sha256', v_existing.object_sha256,
		'bytes', v_existing.bytes,
		'uploaded', false
	);
end
$$;

create function public.qorpera_runner_broker_authorize_company_file_object(
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
	v_storage_limit bigint;
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
	select min(file.storage_limit_bytes) into v_storage_limit
	from public.qorpera_company_files as file where file.profile_id = v_job.profile_id;
	if v_storage_limit is null then
		raise exception 'runner Company File storage authority is unavailable' using errcode = '55000';
	end if;
	-- Contract-v3 writers use one manifest per file and canonical 4 MiB chunks.
	-- Counters make each authorization O(1); the independent closure verifier
	-- still proves which authorized objects form the final candidate.
	v_max_objects := 50001::bigint + ceiling(v_storage_limit::numeric / 4194304)::bigint;
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
				and company_object_bytes + p_bytes <= v_storage_limit;
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
		and company_object_bytes + p_bytes <= v_storage_limit;
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
				+ ceiling(v_file.storage_limit_bytes::numeric / 4194304)::bigint,
			'max_total_bytes', v_file.storage_limit_bytes,
			'tree_contract_version', 3
		)
	);
end
$$;

-- A runner may prepare a candidate revision only for its currently leased,
-- accepted assignment. The immutable object closure is still verified by the
-- trusted verifier; preparing a row never advances the canonical head.
create function public.qorpera_runner_prepare_company_revision(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_client_revision_id uuid,
	p_tree_manifest_sha256 text,
	p_tree_manifest_bytes integer,
	p_tree_contract_version integer,
	p_file_count integer,
	p_total_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_manifest_bytes bigint;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'runner execution authority is unavailable' using errcode = '42501';
	end if;
	if v_run.source_kind = 'proposal_review' then
		raise exception 'proposal review executions cannot create Company File revisions' using errcode = '42501';
	end if;
	select file.* into strict v_file from public.qorpera_company_files as file
	where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for share;
	if not exists (
		select 1 from public.qorpera_runner_assignments as assignment
		where assignment.id = p_assignment_id and assignment.job_id = v_job.id
			and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
			and assignment.status = 'accepted'
	) or p_client_revision_id is null
		or p_tree_manifest_sha256 !~ '^[0-9a-f]{64}$'
		or p_tree_manifest_bytes not between 1 and 8388608
		or p_tree_contract_version is distinct from 3
		or p_file_count not between 0 and 50000
		or p_total_bytes not between 0 and 1099511627776 then
		raise exception 'runner Company File revision is invalid' using errcode = '22023';
	end if;
	select object.bytes into v_manifest_bytes
	from public.qorpera_profile_objects as object
	where object.profile_id = v_run.profile_id and object.sha256 = p_tree_manifest_sha256;
	if v_manifest_bytes is distinct from p_tree_manifest_bytes::bigint then
		raise exception 'runner Company File manifest is unavailable' using errcode = '55000';
	end if;
	select snapshot.* into v_snapshot from public.qorpera_company_snapshots as snapshot
	where snapshot.profile_id = v_run.profile_id and snapshot.client_snapshot_id = p_client_revision_id;
	if found then
		if v_snapshot.environment_id <> v_run.environment_id
			or v_snapshot.workspace_id <> v_file.canonical_workspace_id
			or v_snapshot.parent_snapshot_id is distinct from v_run.company_snapshot_id
			or v_snapshot.tree_manifest_sha256 <> p_tree_manifest_sha256
			or v_snapshot.tree_manifest_bytes <> p_tree_manifest_bytes
			or v_snapshot.tree_contract_version <> p_tree_contract_version
			or v_snapshot.file_count <> p_file_count
			or v_snapshot.total_bytes <> p_total_bytes
			or v_snapshot.created_by_user_id <> v_run.created_by_user_id
			or not exists (
				select 1 from public.qorpera_company_snapshot_publications as publication
				where publication.snapshot_id = v_snapshot.id
					and publication.expected_head_snapshot_id is not distinct from v_run.company_snapshot_id
			) or not exists (
				select 1 from public.qorpera_runner_company_revision_outputs as output
				where output.snapshot_id = v_snapshot.id and output.run_id = v_run.id
					and output.job_id = v_job.id and output.assignment_id = p_assignment_id
			) then
			raise exception 'runner revision id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_snapshot_json(v_snapshot);
	end if;
	insert into public.qorpera_runner_company_revision_intents (
		client_revision_id, run_id, job_id, assignment_id, profile_id,
		environment_id, workspace_id, parent_snapshot_id, tree_manifest_sha256,
		tree_manifest_bytes, tree_contract_version, file_count, total_bytes,
		created_by_user_id
	) values (
		p_client_revision_id, v_run.id, v_job.id, p_assignment_id, v_run.profile_id,
		v_run.environment_id, v_file.canonical_workspace_id, v_run.company_snapshot_id,
		p_tree_manifest_sha256, p_tree_manifest_bytes, p_tree_contract_version,
		p_file_count, p_total_bytes, v_run.created_by_user_id
	);
	insert into public.qorpera_company_snapshots (
		profile_id, environment_id, workspace_id, client_snapshot_id, parent_snapshot_id,
		tree_manifest_sha256, tree_manifest_bytes, tree_contract_version, file_count,
		total_bytes, created_by_user_id
	) values (
		v_run.profile_id, v_run.environment_id, v_file.canonical_workspace_id,
		p_client_revision_id, v_run.company_snapshot_id, p_tree_manifest_sha256,
		p_tree_manifest_bytes, p_tree_contract_version, p_file_count, p_total_bytes,
		v_run.created_by_user_id
	) returning * into v_snapshot;
	delete from public.qorpera_runner_company_revision_intents
	where client_revision_id = p_client_revision_id and run_id = v_run.id;
	insert into public.qorpera_company_snapshot_publications (
		snapshot_id, expected_head_snapshot_id
	) values (v_snapshot.id, v_run.company_snapshot_id);
	insert into public.qorpera_runner_company_revision_outputs (
		snapshot_id, run_id, job_id, assignment_id
	) values (v_snapshot.id, v_run.id, v_job.id, p_assignment_id);
	return public.qorpera_company_snapshot_json(v_snapshot);
end
$$;

create function public.qorpera_runner_company_revision_snapshot(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_snapshot_id uuid
)
returns public.qorpera_company_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
begin
	v_job := public.qorpera_runner_broker_locked_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	join public.qorpera_company_snapshot_publications as publication on publication.snapshot_id = snapshot.id
	where snapshot.id = p_snapshot_id and snapshot.profile_id = v_run.profile_id
		and snapshot.environment_id = v_run.environment_id
		and snapshot.parent_snapshot_id is not distinct from v_run.company_snapshot_id
		and publication.expected_head_snapshot_id is not distinct from v_run.company_snapshot_id
		and publication.status = 'prepared';
	if not found or not exists (
		select 1 from public.qorpera_runner_assignments as assignment
		where assignment.id = p_assignment_id and assignment.job_id = v_job.id
			and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
			and assignment.status = 'accepted'
	) then
		raise exception 'runner Company File revision is unavailable' using errcode = '40001';
	end if;
	return v_snapshot;
end
$$;

create function public.qorpera_runner_begin_company_revision_graph(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_snapshot_id uuid,
	p_client_graph_id uuid,
	p_root_object_sha256 text,
	p_content_sha256 text,
	p_object_count integer,
	p_storage_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_existing public.qorpera_object_reachability_graphs%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
begin
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, p_snapshot_id
	);
	if p_client_graph_id is null or p_root_object_sha256 is distinct from v_snapshot.tree_manifest_sha256
		or p_content_sha256 !~ '^[0-9a-f]{64}$' or p_object_count not between 1 and 400000
		or p_storage_bytes not between 0 and 2199023255552 then
		raise exception 'runner Company File reachability graph is invalid' using errcode = '22023';
	end if;
	select graph.* into v_existing from public.qorpera_object_reachability_graphs as graph
	where graph.root_kind = 'company_snapshot' and graph.root_id = p_snapshot_id;
	if found then
		if v_existing.profile_id <> v_snapshot.profile_id
			or v_existing.environment_id <> v_snapshot.environment_id
			or v_existing.client_graph_id <> p_client_graph_id
			or v_existing.root_object_sha256 <> p_root_object_sha256
			or v_existing.contract_version <> 1
			or v_existing.content_sha256 <> p_content_sha256
			or v_existing.object_count <> p_object_count
			or v_existing.storage_bytes <> p_storage_bytes then
			raise exception 'runner Company File graph is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_object_reachability_graph_json(v_existing);
	end if;
	insert into public.qorpera_object_reachability_graphs (
		profile_id, environment_id, root_kind, root_id, client_graph_id,
		root_object_sha256, contract_version, content_sha256, object_count,
		storage_bytes, created_by_user_id
	) values (
		v_snapshot.profile_id, v_snapshot.environment_id, 'company_snapshot', v_snapshot.id,
		p_client_graph_id, p_root_object_sha256, 1, p_content_sha256, p_object_count,
		p_storage_bytes, v_snapshot.created_by_user_id
	) returning * into v_graph;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

create function public.qorpera_runner_append_company_revision_graph(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_graph_id uuid,
	p_entries jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_input_count integer;
	v_valid_count integer;
begin
	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot' for update;
	if not found then
		raise exception 'runner Company File graph is unavailable' using errcode = '40001';
	end if;
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, v_graph.root_id
	);
	if v_graph.status <> 'uploading' or jsonb_typeof(p_entries) <> 'array'
		or jsonb_array_length(p_entries) not between 1 and 500 then
		raise exception 'runner Company File graph page is invalid' using errcode = '22023';
	end if;
	select count(*), count(*) filter (
		where entry.sha256 ~ '^[0-9a-f]{64}$' and entry.bytes between 0 and 8388608
	) into v_input_count, v_valid_count
	from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint);
	if v_input_count <> jsonb_array_length(p_entries) or v_valid_count <> v_input_count
		or v_input_count <> (
			select count(distinct entry.sha256)
			from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
		) or exists (
			select 1 from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
			left join public.qorpera_profile_objects as object
				on object.profile_id = v_snapshot.profile_id and object.sha256 = entry.sha256
			where object.profile_id is null or object.bytes <> entry.bytes
		) or exists (
			select 1 from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
			join public.qorpera_object_reachability_entries as existing
				on existing.graph_id = p_graph_id and existing.object_sha256 = entry.sha256
			where existing.bytes <> entry.bytes
		) then
		raise exception 'runner Company File graph page is invalid' using errcode = '22023';
	end if;
	insert into public.qorpera_object_reachability_entries (graph_id, object_sha256, bytes)
	select p_graph_id, entry.sha256, entry.bytes
	from jsonb_to_recordset(p_entries) as entry(sha256 text, bytes bigint)
	order by entry.sha256 on conflict (graph_id, object_sha256) do nothing;
	select count(*) into v_input_count from public.qorpera_object_reachability_entries as entry
	where entry.graph_id = p_graph_id;
	if v_input_count > v_graph.object_count then
		raise exception 'runner Company File graph exceeds its declared size' using errcode = '22023';
	end if;
	return v_input_count;
end
$$;

create function public.qorpera_runner_complete_company_revision_graph(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_graph_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_object_count integer;
	v_storage_bytes bigint;
	v_content_sha256 text;
begin
	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot' for update;
	if not found then
		raise exception 'runner Company File graph is unavailable' using errcode = '40001';
	end if;
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, v_graph.root_id
	);
	if v_graph.status = 'complete' then
		return public.qorpera_object_reachability_graph_json(v_graph);
	end if;
	select count(*), coalesce(sum(entry.bytes), 0), encode(
		extensions.digest(convert_to(coalesce(string_agg(
			entry.object_sha256 || ':' || entry.bytes::text, E'\n' order by entry.object_sha256
		), ''), 'utf8'), 'sha256'), 'hex'
	) into v_object_count, v_storage_bytes, v_content_sha256
	from public.qorpera_object_reachability_entries as entry where entry.graph_id = p_graph_id;
	if v_object_count <> v_graph.object_count or v_storage_bytes <> v_graph.storage_bytes
		or v_content_sha256 <> v_graph.content_sha256
		or not exists (
			select 1 from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = p_graph_id and entry.object_sha256 = v_graph.root_object_sha256
		) or not public.qorpera_object_graph_objects_available(p_graph_id) then
		raise exception 'runner Company File graph does not match its declaration' using errcode = '22023';
	end if;
	update public.qorpera_object_reachability_graphs
	set status = 'complete', completed_at = statement_timestamp()
	where id = p_graph_id returning * into v_graph;
	return public.qorpera_object_reachability_graph_json(v_graph);
end
$$;

create function public.qorpera_runner_authorize_company_revision_verification(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_snapshot_id uuid,
	p_graph_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
begin
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, p_snapshot_id
	);
	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot'
		and graph.root_id = p_snapshot_id and graph.status = 'complete';
	if not found then
		raise exception 'runner Company File graph is incomplete' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'snapshot_id', v_snapshot.id,
		'graph_id', v_graph.id,
		'verified_user_id', v_snapshot.created_by_user_id
	);
end
$$;

create function public.qorpera_runner_finalize_company_revision_verification(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_assignment_id uuid,
	p_snapshot_id uuid,
	p_graph_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_graph public.qorpera_object_reachability_graphs%rowtype;
	v_proof public.qorpera_object_restore_proofs%rowtype;
begin
	v_snapshot := public.qorpera_runner_company_revision_snapshot(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_assignment_id, p_snapshot_id
	);
	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot'
		and graph.root_id = p_snapshot_id and graph.status = 'complete'
		and graph.closure_verified;
	if not found or not exists (
		select 1 from public.qorpera_company_snapshot_publications as publication
		where publication.snapshot_id = p_snapshot_id
			and publication.restricted_content_sha256 is not null
	) then
		raise exception 'runner Company File verification is incomplete' using errcode = '55000';
	end if;
	select proof.* into v_proof from public.qorpera_object_restore_proofs as proof
	where proof.profile_id = v_snapshot.profile_id and proof.client_proof_id = v_graph.id for update;
	if found then
		if v_proof.graph_id <> v_graph.id
			or v_proof.restored_content_sha256 <> v_snapshot.tree_manifest_sha256
			or v_proof.restored_bytes <> v_snapshot.total_bytes
			or v_proof.verified_by_user_id <> v_snapshot.created_by_user_id then
			raise exception 'runner Company File proof is bound to different content' using errcode = '23505';
		end if;
		update public.qorpera_object_restore_proofs
		set verified_at = statement_timestamp(), valid_until = statement_timestamp() + interval '7 days'
		where id = v_proof.id returning * into v_proof;
	else
		insert into public.qorpera_object_restore_proofs (
			graph_id, profile_id, client_proof_id, restored_content_sha256,
			restored_bytes, verified_by_user_id
		) values (
			v_graph.id, v_snapshot.profile_id, v_graph.id, v_snapshot.tree_manifest_sha256,
			v_snapshot.total_bytes, v_snapshot.created_by_user_id
		) returning * into v_proof;
	end if;
	return public.qorpera_object_restore_proof_json(v_proof);
end
$$;

-- Completion is one transaction across the runner result, immutable transcript
-- boundary, exact queued inputs, and Company File disposition. A candidate is
-- either CAS-published or becomes a durable team-visible proposal; it is never
-- left as authoritative state on the physical runner.
create function public.qorpera_complete_runner_job_v6(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_client_artifact_index_id uuid,
	p_client_substrate_version_id uuid,
	p_output_snapshot_id uuid,
	p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_assignment public.qorpera_runner_assignments%rowtype;
	v_existing public.qorpera_execution_run_results%rowtype;
	v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_publication public.qorpera_company_snapshot_publications%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_transcript_end_sequence bigint := 0;
	v_result_sha256 text;
	v_head_restricted_content_sha256 text;
	v_disposition text := 'unchanged';
	v_reason text;
	v_title text;
	v_completed jsonb;
	v_completed_inputs integer;
	v_review_assignment public.qorpera_company_proposal_review_assignments%rowtype;
	v_review jsonb;
	v_review_decision text;
	v_review_comment text;
	v_review_comment_id uuid;
begin
	if auth.role() <> 'service_role' or p_client_artifact_index_id is null
		or p_client_substrate_version_id is null or p_result is null
		or jsonb_typeof(p_result) <> 'object'
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job completion is invalid' using errcode = '42501';
	end if;
	v_result_sha256 := encode(extensions.digest(convert_to(p_result::text, 'utf8'), 'sha256'), 'hex');
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id and job.runner_id = p_runner_id for update;
	if not found then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	select result.* into v_existing from public.qorpera_execution_run_results as result
	where result.job_id = v_job.id;
	if found then
		if v_job.status <> 'completed' or v_job.terminal_lease_token_sha256 <> p_lease_token_sha256
			or v_existing.runner_id <> p_runner_id
			or v_existing.output_snapshot_id is distinct from p_output_snapshot_id
			or v_existing.client_artifact_index_id <> p_client_artifact_index_id
			or v_existing.client_substrate_version_id <> p_client_substrate_version_id
			or v_existing.result_sha256 <> v_result_sha256 then
			raise exception 'runner completion replay differs from the stored result' using errcode = '23505';
		end if;
		return public.qorpera_runner_job_json(v_job);
	end if;
	if v_job.status <> 'leased' or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if not public.qorpera_execution_sponsor_available(v_run)
		or not public.qorpera_execution_compute_available(v_run) then
		raise exception 'runner execution authority is unavailable' using errcode = '42501';
	end if;
	if v_run.source_kind = 'proposal_review' then
		select review.* into v_review_assignment
		from public.qorpera_company_proposal_review_assignments as review
		where review.run_id = v_run.id for update;
		select proposal.* into v_proposal
		from public.qorpera_company_proposals as proposal
		where proposal.id = v_review_assignment.proposal_id for share;
		v_review := p_result -> 'review';
		v_review_decision := v_review ->> 'decision';
		v_review_comment := btrim(v_review ->> 'comment');
		if v_review_assignment.id is null or v_review_assignment.status <> 'running'
			or v_proposal.status <> 'open' or v_review_assignment.proposal_revision <> (
				select max(revision.revision)
				from public.qorpera_company_proposal_revisions as revision
				where revision.proposal_id = v_review_assignment.proposal_id
			)
			or p_output_snapshot_id is not null
			or exists (
				select 1 from public.qorpera_runner_job_artifacts as artifact
				where artifact.job_id = v_job.id
			)
			or jsonb_typeof(v_review) <> 'object'
			or v_review_decision is null or v_review_decision not in ('approve', 'request_changes')
			or coalesce(char_length(v_review_comment), 0) not between 1 and 16384
			or exists (
				select 1 from jsonb_object_keys(v_review) as field(key)
				where field.key not in ('decision', 'comment')
			) then
			raise exception 'proposal review result is invalid' using errcode = '22023';
		end if;
	end if;
	select assignment.* into v_assignment from public.qorpera_runner_assignments as assignment
	where assignment.id = v_job.client_lease_id and assignment.job_id = v_job.id
		and assignment.run_id = v_run.id and assignment.runner_id = p_runner_id
		and assignment.status = 'accepted' for update;
	if not found then
		raise exception 'runner assignment is unavailable' using errcode = '40001';
	end if;
	if exists (
		select 1 from public.qorpera_runner_model_requests as request
		where request.job_id = v_job.id and request.status = 'reserved'
	) or exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
	) then
		raise exception 'runner execution has unresolved work' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		left join public.qorpera_company_proposals as proposal on proposal.id = receipt.proposal_id
		where receipt.run_id = v_run.id and receipt.status = 'completed'
			and receipt.requires_company_revision
			and coalesce(receipt.output_snapshot_id, proposal.proposal_snapshot_id)
				is distinct from p_output_snapshot_id
	) then
		raise exception 'runner completion omitted an operation-bound Company File candidate' using errcode = '55000';
	end if;
	if v_run.session_id is not null then
		select max(event.sequence) into v_transcript_end_sequence
		from public.qorpera_session_events as event
		where event.session_id = v_run.session_id and event.execution_kind = 'run'
			and event.execution_id = v_run.id and event.runner_assignment_id = v_assignment.id;
		if v_transcript_end_sequence is null
			or v_transcript_end_sequence <= v_run.transcript_start_sequence
			or not exists (
				select 1
				from public.qorpera_session_events as event
				cross join lateral jsonb_array_elements(case
					when jsonb_typeof(event.body #> '{entry,message,content}') = 'array'
						then event.body #> '{entry,message,content}'
					else '[]'::jsonb
				end) as part(value)
				where event.session_id = v_run.session_id
					and event.sequence > v_run.transcript_start_sequence
					and event.sequence <= v_transcript_end_sequence
					and event.execution_kind = 'run'
					and event.execution_id = v_run.id
					and event.runner_assignment_id = v_assignment.id
					and event.event_type = 'message'
					and event.body #>> '{entry,message,role}' = 'assistant'
					and part.value ->> 'type' = 'text'
					and char_length(btrim(part.value ->> 'text')) > 0
			)
			or exists (
				select 1 from public.qorpera_session_events as event
				where event.session_id = v_run.session_id
					and event.sequence > v_run.transcript_start_sequence
					and event.sequence <= v_transcript_end_sequence
					and (
						event.execution_kind is distinct from 'run'
						or event.execution_id is distinct from v_run.id
						or event.runner_assignment_id is distinct from v_assignment.id
					)
			) then
			raise exception 'runner transcript boundary is invalid' using errcode = '55000';
		end if;
	else
		v_transcript_end_sequence := 0;
	end if;

	if p_output_snapshot_id is not null then
		select file.* into strict v_file from public.qorpera_company_files as file
		where file.profile_id = v_run.profile_id and file.environment_id = v_run.environment_id for update;
		select snapshot.* into v_snapshot
		from public.qorpera_company_snapshots as snapshot
		where snapshot.id = p_output_snapshot_id and snapshot.profile_id = v_run.profile_id
			and snapshot.environment_id = v_run.environment_id
			and snapshot.workspace_id = v_file.canonical_workspace_id;
		select publication.* into v_publication
		from public.qorpera_company_snapshot_publications as publication
		where publication.snapshot_id = p_output_snapshot_id;
		if v_snapshot.id is null or v_publication.snapshot_id is null
			or v_snapshot.parent_snapshot_id is distinct from v_run.company_snapshot_id
			or v_publication.expected_head_snapshot_id is distinct from v_run.company_snapshot_id
			or v_publication.status <> 'prepared'
			or v_publication.restricted_content_sha256 is null
			or not exists (
				select 1 from public.qorpera_runner_company_revision_outputs as output
				where output.snapshot_id = v_snapshot.id and output.run_id = v_run.id
					and output.job_id = v_job.id and output.assignment_id = v_assignment.id
			)
			or not public.qorpera_object_root_has_current_proof('company_snapshot', v_snapshot.id) then
			raise exception 'runner Company File output is not durably verified' using errcode = '55000';
		end if;
		select publication.restricted_content_sha256 into v_head_restricted_content_sha256
		from public.qorpera_company_snapshot_publications as publication
		where publication.snapshot_id = v_file.head_snapshot_id;
		if v_run.publication_mode = 'automatic'
			and v_file.head_snapshot_id is not distinct from v_run.company_snapshot_id
			and v_publication.restricted_content_sha256 is not distinct from v_head_restricted_content_sha256 then
			update public.qorpera_company_snapshot_publications
			set status = 'published', published_at = statement_timestamp()
			where snapshot_id = v_snapshot.id;
			update public.qorpera_company_workspaces
			set head_snapshot_id = v_snapshot.id, updated_at = statement_timestamp()
			where id = v_file.canonical_workspace_id;
			update public.qorpera_company_files
			set head_snapshot_id = v_snapshot.id, state = 'ready',
				logical_bytes = v_snapshot.total_bytes, updated_at = statement_timestamp()
			where environment_id = v_file.environment_id;
			v_disposition := 'published';
		else
			v_reason := case
				when v_run.publication_mode = 'review' then 'policy'
				when v_publication.restricted_content_sha256 is distinct from v_head_restricted_content_sha256 then 'authority'
				else 'conflict'
			end;
			select left('Review ' || coalesce(staff.display_name, 'agent') || ' output', 256)
			into v_title from public.qorpera_profile_staff as staff
			where staff.profile_id = v_run.profile_id and staff.staff_agent_id = v_run.staff_agent_id;
			insert into public.qorpera_company_proposals (
				profile_id, environment_id, client_proposal_id, base_snapshot_id,
				proposal_snapshot_id, execution_kind, execution_id, execution_claimant_id,
				session_id, trail_end_sequence, reason, policy_key, title,
				reviewer_staff_ids, created_by_user_id
			) values (
				v_run.profile_id, v_run.environment_id, v_run.id, v_run.company_snapshot_id,
				v_snapshot.id, 'run', v_run.id, v_run.id, v_run.session_id,
				v_transcript_end_sequence, v_reason,
				case when v_reason = 'policy' then v_run.review_policy_key else null end,
				coalesce(v_title, 'Review agent output'),
				case when v_reason = 'policy' then v_run.reviewer_staff_ids else '{}'::uuid[] end,
				v_run.created_by_user_id
			)
			on conflict (profile_id, client_proposal_id) do nothing
			returning * into v_proposal;
			if not found then
				select proposal.* into strict v_proposal
				from public.qorpera_company_proposals as proposal
				where proposal.profile_id = v_run.profile_id and proposal.client_proposal_id = v_run.id;
				if v_proposal.proposal_snapshot_id <> v_snapshot.id
					or v_proposal.execution_kind <> 'run' or v_proposal.execution_id <> v_run.id then
					raise exception 'runner proposal id is already bound to different output' using errcode = '23505';
				end if;
			end if;
			v_disposition := 'review_pending';
		end if;
	end if;

	v_completed := public.qorpera_complete_runner_job_v4(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256,
		p_client_artifact_index_id, p_client_substrate_version_id, p_result
	);
	update public.qorpera_runner_jobs
	set result = result || jsonb_build_object(
		'company_file', jsonb_build_object(
			'disposition', v_disposition,
			'output_snapshot_id', p_output_snapshot_id,
			'proposal_id', case when v_disposition = 'review_pending' then v_proposal.id else null end
		)
	)
	where id = v_job.id
	returning * into v_job;
	if pg_column_size(v_job.result) > 65536 then
		raise exception 'runner completion result is too large' using errcode = '22023';
	end if;
	insert into public.qorpera_execution_run_results (
		run_id, job_id, assignment_id, runner_id, transcript_end_sequence,
		company_disposition, output_snapshot_id, proposal_id,
		client_artifact_index_id, client_substrate_version_id, result_sha256
	) values (
		v_run.id, v_job.id, v_assignment.id, p_runner_id, v_transcript_end_sequence,
		v_disposition, p_output_snapshot_id,
		case when v_disposition = 'review_pending' then v_proposal.id else null end,
		p_client_artifact_index_id, p_client_substrate_version_id, v_result_sha256
	);
	if v_run.source_kind = 'proposal_review' then
		insert into public.qorpera_company_proposal_comments (
			proposal_id, client_comment_id, body, author_staff_agent_id
		) values (
			v_review_assignment.proposal_id, v_run.id, v_review_comment, v_run.staff_agent_id
		)
		returning id into v_review_comment_id;
		update public.qorpera_company_proposal_review_assignments
		set status = case v_review_decision
				when 'approve' then 'approved'
				else 'changes_requested'
			end,
			comment_id = v_review_comment_id,
			completed_at = statement_timestamp()
		where id = v_review_assignment.id and status = 'running';
	end if;
	if v_run.source_kind = 'session_turn' then
		update public.qorpera_session_inputs
		set completed_at = coalesce(completed_at, statement_timestamp())
		where execution_run_id = v_run.id and completed_at is null and failed_at is null;
		get diagnostics v_completed_inputs = row_count;
		if v_completed_inputs <> cardinality(v_run.input_ids) then
			raise exception 'runner session inputs changed before completion' using errcode = '40001';
		end if;
	end if;
	if v_disposition = 'review_pending' then
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'review_pending', jsonb_build_object('proposal_id', v_proposal.id));
	end if;
	return public.qorpera_runner_job_json(v_job);
end
$$;

create function public.qorpera_runner_broker_list_transcript(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_after_sequence bigint,
	p_limit integer
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
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run
	from public.qorpera_execution_runs as run
	where run.id = v_job.run_id and run.job_id = v_job.id;
	if p_after_sequence < 0 or p_after_sequence > v_run.transcript_start_sequence
		or p_limit not between 1 and 500 then
		raise exception 'runner transcript page is invalid' using errcode = '22023';
	end if;
	if v_run.session_id is null then return '[]'::jsonb; end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'session_id', event.session_id,
			'sequence', event.sequence,
			'event_id', event.event_id,
			'event_type', event.event_type,
			'actor_user_id', event.actor_user_id,
			'body', event.body,
			'previous_hash', event.previous_hash,
			'event_hash', event.event_hash,
			'execution_kind', event.execution_kind,
			'execution_id', event.execution_id,
			'execution_claimant_id', event.execution_claimant_id,
			'runner_assignment_id', event.runner_assignment_id,
			'created_at', event.created_at
		) order by event.sequence)
		from (
			select source.*
			from public.qorpera_session_events as source
			where source.session_id = v_run.session_id
				and source.sequence > p_after_sequence
				and source.sequence <= v_run.transcript_start_sequence
			order by source.sequence
			limit p_limit
		) as event
	), '[]'::jsonb);
end
$$;

create function public.qorpera_runner_broker_list_inputs(
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
	v_result jsonb;
begin
	v_job := public.qorpera_runner_broker_job(
		p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256
	);
	select run.* into strict v_run
	from public.qorpera_execution_runs as run
	where run.id = v_job.run_id and run.job_id = v_job.id;
	if v_run.source_kind <> 'session_turn' then return '[]'::jsonb; end if;
	select jsonb_agg(jsonb_build_object(
		'input_id', input.id,
		'position', input.position,
		'kind', input.kind,
		'author_user_id', input.author_user_id,
		'author_display_name', coalesce(member.display_name, 'Former company member'),
		'body', input.body,
		'created_at', input.created_at
	) order by requested.ordinality)
	into v_result
	from unnest(v_run.input_ids) with ordinality as requested(input_id, ordinality)
	join public.qorpera_session_inputs as input
		on input.id = requested.input_id and input.session_id = v_run.session_id
		and input.execution_run_id = v_run.id
	left join public.qorpera_profile_members as member
		on member.profile_id = v_run.profile_id and member.user_id = input.author_user_id;
	if jsonb_array_length(coalesce(v_result, '[]'::jsonb)) <> cardinality(v_run.input_ids) then
		raise exception 'runner execution input set is incomplete' using errcode = '55000';
	end if;
	return coalesce(v_result, '[]'::jsonb);
end
$$;

create function public.qorpera_list_execution_run_recoveries(
	p_profile_id uuid,
	p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	if not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'company read access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 500 then
		raise exception 'execution recovery limit is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'run_id', recovery.id,
			'source_kind', recovery.source_kind,
			'session_id', recovery.session_id,
			'source_id', recovery.source_id,
			'job_status', recovery.job_status,
			'last_error', recovery.last_error,
			'input_count', cardinality(recovery.input_ids),
			'input_preview', recovery.input_preview,
			'has_ambiguous_operation', recovery.has_ambiguous_operation,
			'proposal_id', recovery.proposal_id,
			'created_at', recovery.created_at,
			'finished_at', recovery.finished_at
		) order by recovery.finished_at desc, recovery.id desc)
		from (
			select run.*, job.status as job_status, job.last_error, job.finished_at,
				left(coalesce((
					select input.body ->> 'text'
					from unnest(run.input_ids) with ordinality as requested(input_id, ordinality)
					join public.qorpera_session_inputs as input on input.id = requested.input_id
					order by requested.ordinality limit 1
				), ''), 300) as input_preview,
				exists (
					select 1 from public.qorpera_run_operation_receipts as receipt
					where receipt.run_id = run.id and receipt.status in ('executing', 'ambiguous')
				) as has_ambiguous_operation,
				(
					select proposal.id from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
					order by proposal.created_at desc limit 1
				) as proposal_id
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.profile_id = p_profile_id and job.status in ('failed', 'cancelled')
				and run.source_kind <> 'proposal_review'
				and not exists (
					select 1 from public.qorpera_execution_run_events as resolved
					where resolved.run_id = run.id
						and resolved.event_type in ('recovery_released', 'recovery_discarded')
				)
			order by job.finished_at desc, run.id desc
			limit p_limit
		) as recovery
	), '[]'::jsonb);
end
$$;

create function public.qorpera_get_execution_run_recovery(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
begin
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id;
	if not found or not public.qorpera_can_read_profile(v_run.profile_id) then
		raise exception 'execution recovery is unavailable' using errcode = '42501';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id;
	if v_job.status not in ('failed', 'cancelled') or exists (
		select 1 from public.qorpera_execution_run_events as resolved
		where resolved.run_id = v_run.id
			and resolved.event_type in ('recovery_released', 'recovery_discarded')
	) then
		raise exception 'execution recovery is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'run', public.qorpera_execution_run_json(v_run),
		'job', public.qorpera_runner_job_json(v_job),
		'proposal_id', (
			select proposal.id from public.qorpera_company_proposals as proposal
			where proposal.execution_kind = 'run' and proposal.execution_id = v_run.id
				and proposal.status = 'open'
			order by proposal.created_at desc limit 1
		),
		'inputs', coalesce((
			select jsonb_agg(jsonb_build_object(
				'input_id', input.id,
				'position', input.position,
				'kind', input.kind,
				'author_user_id', input.author_user_id,
				'author_display_name', coalesce(member.display_name, 'Former company member'),
				'body', input.body,
				'created_at', input.created_at,
				'failed_at', input.failed_at,
				'failure_reason', input.failure_reason
			) order by requested.ordinality)
			from unnest(v_run.input_ids) with ordinality as requested(input_id, ordinality)
			join public.qorpera_session_inputs as input on input.id = requested.input_id
			left join public.qorpera_profile_members as member
				on member.profile_id = v_run.profile_id and member.user_id = input.author_user_id
		), '[]'::jsonb),
		'operations', coalesce((
			select jsonb_agg(jsonb_build_object(
				'receipt_id', receipt.id,
				'operation_id', receipt.id,
				'operation_kind', receipt.operation_kind,
				'logical_operation_key', receipt.logical_operation_key,
				'status', receipt.status,
				'result', receipt.result,
				'requires_company_revision', receipt.requires_company_revision,
				'output_snapshot_id', receipt.output_snapshot_id,
				'proposal_id', receipt.proposal_id,
				'recovery_resolution', receipt.recovery_resolution,
				'created_at', receipt.created_at
			) order by receipt.created_at, receipt.id)
			from public.qorpera_run_operation_receipts as receipt where receipt.run_id = v_run.id
		), '[]'::jsonb)
	);
end
$$;

create function public.qorpera_list_session_execution_run_recoveries(
	p_session_id uuid,
	p_limit integer default 20
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
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'session execution recovery is unavailable' using errcode = '42501';
	end if;
	if p_limit not between 1 and 20 then
		raise exception 'session execution recovery limit is invalid' using errcode = '22023';
	end if;
	return coalesce((
		select jsonb_agg(public.qorpera_get_execution_run_recovery(recovery.run_id)
			order by recovery.finished_at desc, recovery.run_id desc)
		from (
			select run.id as run_id, job.finished_at
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.session_id = p_session_id and run.source_kind = 'session_turn'
				and job.status in ('failed', 'cancelled')
				and not exists (
					select 1 from public.qorpera_execution_run_events as resolved
					where resolved.run_id = run.id
						and resolved.event_type in ('recovery_released', 'recovery_discarded')
				)
			order by job.finished_at desc, run.id desc
			limit p_limit
		) as recovery
	), '[]'::jsonb);
end
$$;

create function public.qorpera_list_staff_execution_activity(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company execution activity is unavailable' using errcode = '42501';
	end if;
	return coalesce((
		with candidates as (
			select run.id as run_id, run.staff_agent_id, run.source_kind, job.status as job_status,
				case
					when job.status in ('failed', 'cancelled') or exists (
						select 1 from public.qorpera_company_proposals as proposal
						where proposal.execution_kind = 'run' and proposal.execution_id = run.id
							and proposal.status = 'open'
					) then 'needs_attention'
					when job.status = 'leased' then 'working'
					else 'waiting'
				end as activity,
				case
					when job.status in ('failed', 'cancelled') then 3
					when job.status = 'leased' then 2
					else 1
				end as priority,
				coalesce(job.finished_at, job.started_at, job.created_at) as updated_at
			from public.qorpera_execution_runs as run
			join public.qorpera_runner_jobs as job on job.id = run.job_id
			where run.environment_id = p_environment_id and (
				job.status in ('queued', 'leased')
				or (job.status in ('failed', 'cancelled') and (
					(run.source_kind = 'session_turn' and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded')
					))
					or (run.source_kind = 'wake' and exists (
						select 1 from public.qorpera_wake_occurrences as occurrence
						where occurrence.run_id = run.id and occurrence.status in ('failed', 'requires_review')
					) and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded')
					))
					or (run.source_kind = 'proposal_review' and exists (
						select 1
						from public.qorpera_company_proposal_review_assignments as review
						join public.qorpera_company_proposals as proposal on proposal.id = review.proposal_id
						where review.run_id = run.id and review.status = 'failed' and proposal.status = 'open'
							and review.proposal_revision = (
								select max(revision.revision)
								from public.qorpera_company_proposal_revisions as revision
								where revision.proposal_id = proposal.id
							)
					))
					or (run.source_kind in ('manual', 'room_delivery', 'system') and not exists (
						select 1 from public.qorpera_execution_run_events as resolved
						where resolved.run_id = run.id
							and resolved.event_type in ('recovery_released', 'recovery_discarded')
					))
				))
				or (job.status = 'completed' and exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				))
			)
		), current_activity as (
			select distinct on (staff_agent_id) *
			from candidates
			order by staff_agent_id, priority desc, updated_at desc, run_id desc
		)
		select jsonb_agg(jsonb_build_object(
			'run_id', activity.run_id,
			'staff_agent_id', activity.staff_agent_id,
			'source_kind', activity.source_kind,
			'job_status', activity.job_status,
			'activity', activity.activity,
			'updated_at', activity.updated_at
		) order by activity.staff_agent_id)
		from current_activity as activity
	), '[]'::jsonb);
end
$$;

create function public.qorpera_resolve_failed_execution_run(
	p_run_id uuid,
	p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_changed integer;
begin
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = p_run_id for update;
	if auth.uid() is null or not found or not public.qorpera_can_write_profile(v_run.profile_id) then
		raise exception 'execution recovery requires company write access' using errcode = '42501';
	end if;
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id for update;
	if v_job.status not in ('failed', 'cancelled')
		or p_action not in ('retry', 'discard')
		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
		or (p_action = 'discard' and v_run.source_kind = 'proposal_review') then
		raise exception 'execution recovery action is unavailable' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_execution_run_events as resolved
		where resolved.run_id = v_run.id
			and resolved.event_type in ('recovery_released', 'recovery_discarded')
	) then
		raise exception 'execution recovery was already resolved' using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_run_operation_receipts as receipt
		where receipt.run_id = v_run.id and receipt.status in ('executing', 'ambiguous')
	) or exists (
		select 1 from public.qorpera_company_proposals as proposal
		where proposal.execution_kind = 'run' and proposal.execution_id = v_run.id
			and proposal.status = 'open'
	) then
		raise exception 'execution recovery still has an unresolved durable outcome' using errcode = '55000';
	end if;
	if p_action = 'retry' then
		if exists (
			select 1 from public.qorpera_run_operation_receipts as receipt
			where receipt.run_id = v_run.id and receipt.status = 'completed'
		) then
			raise exception 'execution recovery cannot retry work with a durable operation outcome or open proposal' using errcode = '55000';
		end if;
		update public.qorpera_session_inputs
		set execution_run_id = null, failed_at = null, failure_reason = null
		where id = any(v_run.input_ids) and execution_run_id = v_run.id
			and completed_at is null;
		get diagnostics v_changed = row_count;
		if v_changed <> cardinality(v_run.input_ids) then
			raise exception 'execution recovery input set changed' using errcode = '40001';
		end if;
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_released', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
		update public.qorpera_shared_sessions set updated_at = statement_timestamp()
		where id = v_run.session_id;
	else
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (v_run.id, 'recovery_discarded', jsonb_build_object(
			'action', p_action, 'resolved_by_user_id', auth.uid()
		));
	end if;
	return jsonb_build_object('run_id', v_run.id, 'action', p_action, 'resolved', true);
end
$$;

create function public.qorpera_runner_execution_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_event text;
begin
	if new.run_id is null or new.status = old.status then return new; end if;
	v_event := case new.status
		when 'queued' then 'infrastructure_retry'
		when 'completed' then 'completed'
		when 'failed' then 'failed'
		when 'cancelled' then 'cancelled'
		else null
	end;
	if v_event is not null then
		insert into public.qorpera_execution_run_events (run_id, event_type, payload)
		values (new.run_id, v_event, jsonb_build_object(
			'runner_id', new.runner_id, 'attempt_count', new.attempt_count,
			'error', new.last_error
		));
	end if;
	if old.status = 'leased' and new.status <> 'leased' then
		update public.qorpera_runner_assignments
		set status = case when new.status = 'completed' then 'completed' else 'failed' end,
			finished_at = statement_timestamp(), last_error = new.last_error
		where job_id = new.id and status = 'accepted';
	end if;
	if new.status in ('completed', 'failed', 'cancelled') then
		update public.qorpera_execution_sponsor_reservations as reservation
		set status = 'settled',
			actual_microusd = coalesce((
				select sum(observation.cost_microusd)
				from public.qorpera_runner_model_usage_observations as observation
				where observation.job_id = new.id
			), 0),
			settled_at = statement_timestamp()
		where reservation.run_id = new.run_id and reservation.status = 'reserved'
			and not exists (
				select 1 from public.qorpera_runner_model_requests as request
				where request.job_id = new.id and request.status = 'reserved'
			);
		update public.qorpera_wake_occurrences
		set status = case
				when new.status = 'completed' and exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run'
						and proposal.execution_id = new.run_id and proposal.status = 'open'
				) then 'requires_review'
				else new.status
			end,
			blocked_reason = case
				when new.status = 'completed' and exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run'
						and proposal.execution_id = new.run_id and proposal.status = 'open'
				) then 'Company File output is awaiting review'
				when new.status = 'completed' then null
				else new.last_error
			end,
			finished_at = statement_timestamp()
		where run_id = new.run_id and status = 'materialized';
		if new.status in ('failed', 'cancelled') then
			update public.qorpera_company_proposal_review_assignments as review
			set status = 'failed', completed_at = statement_timestamp(),
				failure_reason = left(coalesce(new.last_error, 'Proposal review execution failed'), 1000)
			from public.qorpera_execution_runs as run
			where run.id = new.run_id and run.source_kind = 'proposal_review'
				and review.run_id = run.id and review.status = 'running';
			update public.qorpera_session_inputs
			set failed_at = coalesce(failed_at, statement_timestamp()),
				failure_reason = coalesce(failure_reason, left(coalesce(
					new.last_error, 'Cloud execution ended before durable completion'
				), 2048))
			where execution_run_id = new.run_id and completed_at is null and failed_at is null;
		end if;
		-- Output authority is only a live runner capability. Immutable artifacts,
		-- snapshots, proposals, and their reachability graphs retain published
		-- objects independently; terminal authorizations must not grow forever.
		delete from public.qorpera_runner_job_output_objects where job_id = new.id;
	end if;
	return new;
end
$$;

create trigger qorpera_runner_execution_status_event
after update of status on public.qorpera_runner_jobs
for each row execute function public.qorpera_runner_execution_status_event();

create function public.qorpera_runner_proposal_wake_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.execution_kind = 'run' and new.status <> old.status then
		update public.qorpera_runner_jobs as job
		set status = 'cancelled',
			terminal_lease_token_sha256 = case
				when job.status = 'leased' then job.lease_token_sha256
				else job.terminal_lease_token_sha256
			end,
			lease_token_sha256 = null, lease_expires_at = null,
			finished_at = statement_timestamp(),
			last_error = 'Proposal review was closed before this assignment completed'
		from public.qorpera_company_proposal_review_assignments as review
		where review.proposal_id = new.id and review.status = 'running'
			and job.run_id = review.run_id and job.status in ('queued', 'leased');
		update public.qorpera_company_proposal_review_assignments
		set status = 'failed', completed_at = statement_timestamp(),
			failure_reason = 'Proposal review was closed before this assignment completed'
		where proposal_id = new.id and status in ('queued', 'running');
		update public.qorpera_wake_occurrences as occurrence
		set status = case new.status when 'accepted' then 'completed' else 'cancelled' end,
			blocked_reason = case
				when new.status = 'accepted' then null
				else 'Company File review proposal was rejected'
			end,
			finished_at = statement_timestamp()
		from public.qorpera_execution_runs as run
		where run.id = new.execution_id and run.source_kind = 'wake'
			and occurrence.run_id = run.id
			and occurrence.status = 'requires_review';
	end if;
	return new;
end
$$;

create trigger qorpera_runner_proposal_wake_status
after update of status on public.qorpera_company_proposals
for each row execute function public.qorpera_runner_proposal_wake_status();

create or replace function public.qorpera_company_proposal_json(p_proposal public.qorpera_company_proposals)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'proposal_id', p_proposal.id,
		'profile_id', p_proposal.profile_id,
		'environment_id', p_proposal.environment_id,
		'client_proposal_id', p_proposal.client_proposal_id,
		'base_snapshot_id', p_proposal.base_snapshot_id,
		'proposal_snapshot', public.qorpera_company_snapshot_json(snapshot),
		'execution_kind', p_proposal.execution_kind,
		'execution_id', p_proposal.execution_id,
		'execution_claimant_id', p_proposal.execution_claimant_id,
		'session_id', p_proposal.session_id,
		'trail_end_sequence', p_proposal.trail_end_sequence,
		'reason', p_proposal.reason,
		'policy_key', p_proposal.policy_key,
		'title', p_proposal.title,
		'reviewer_staff_ids', to_jsonb(p_proposal.reviewer_staff_ids),
		'review_revision', coalesce((
			select max(revision.revision)
			from public.qorpera_company_proposal_revisions as revision
			where revision.proposal_id = p_proposal.id
		), 1),
		'reviews', coalesce((
			select jsonb_agg(jsonb_build_object(
				'assignment_id', review.id,
				'proposal_revision', review.proposal_revision,
				'reviewer_staff_agent_id', review.reviewer_staff_agent_id,
				'reviewer_name', coalesce(staff.display_name, 'Former staff member'),
				'status', review.status,
				'run_id', review.run_id,
				'comment_id', review.comment_id,
				'failure_reason', review.failure_reason,
				'created_at', review.created_at,
				'started_at', review.started_at,
				'completed_at', review.completed_at
			) order by review.created_at, review.id)
			from public.qorpera_company_proposal_review_assignments as review
			left join public.qorpera_profile_staff as staff
				on staff.profile_id = review.profile_id
				and staff.staff_agent_id = review.reviewer_staff_agent_id
			where review.proposal_id = p_proposal.id
				and review.proposal_revision = (
					select max(revision.revision)
					from public.qorpera_company_proposal_revisions as revision
					where revision.proposal_id = p_proposal.id
				)
		), '[]'::jsonb),
		'status', p_proposal.status,
		'created_by_user_id', p_proposal.created_by_user_id,
		'created_by_name', coalesce(member.display_name, 'Former company member'),
		'created_at', p_proposal.created_at,
		'resolved_by_user_id', p_proposal.resolved_by_user_id,
		'resolved_at', p_proposal.resolved_at
	)
	from public.qorpera_company_snapshots as snapshot
	left join public.qorpera_profile_members as member
		on member.profile_id = p_proposal.profile_id and member.user_id = p_proposal.created_by_user_id
	where snapshot.id = p_proposal.proposal_snapshot_id
$$;

create or replace function public.qorpera_accept_company_proposal(
	p_proposal_id uuid,
	p_expected_proposal_snapshot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_proposal public.qorpera_company_proposals%rowtype;
	v_revision bigint;
begin
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_proposal.profile_id) then
		raise exception 'company proposal authorization is required' using errcode = '42501';
	end if;
	if v_proposal.proposal_snapshot_id is distinct from p_expected_proposal_snapshot_id then
		raise exception 'company proposal changed before acceptance' using errcode = '40001';
	end if;
	if v_proposal.status = 'accepted' then
		return public.qorpera_company_proposal_json(v_proposal);
	end if;
	if v_proposal.status <> 'open' then
		raise exception 'company proposal was resolved before acceptance' using errcode = '40001';
	end if;
	select max(revision.revision) into v_revision
	from public.qorpera_company_proposal_revisions as revision
	where revision.proposal_id = v_proposal.id;
	if v_proposal.execution_kind = 'run' and cardinality(v_proposal.reviewer_staff_ids) > 0 and (
		(select count(*)
		 from public.qorpera_company_proposal_review_assignments as review
		 where review.proposal_id = v_proposal.id and review.proposal_revision = v_revision)
			<> cardinality(v_proposal.reviewer_staff_ids)
		or exists (
			select 1
			from public.qorpera_company_proposal_review_assignments as review
			where review.proposal_id = v_proposal.id and review.proposal_revision = v_revision
				and review.status <> 'approved'
		)
	) then
		raise exception 'company proposal still requires its configured reviews' using errcode = '55000';
	end if;
	update public.qorpera_company_proposals
	set status = 'accepted', resolved_by_user_id = v_user_id, resolved_at = statement_timestamp()
	where id = v_proposal.id
	returning * into v_proposal;
	perform public.qorpera_publish_company_file_revision(
		v_proposal.environment_id, v_proposal.proposal_snapshot_id, v_proposal.base_snapshot_id
	);
	return public.qorpera_company_proposal_json(v_proposal);
end
$$;

create function public.qorpera_retry_company_proposal_review(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_review public.qorpera_company_proposal_review_assignments%rowtype;
	v_proposal public.qorpera_company_proposals%rowtype;
	v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_revision bigint;
begin
	select review.* into v_review
	from public.qorpera_company_proposal_review_assignments as review
	where review.id = p_assignment_id for update;
	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal where proposal.id = v_review.proposal_id;
	if auth.uid() is null or v_review.id is null or v_proposal.id is null
		or not public.qorpera_can_authorize_profile(v_review.profile_id) then
		raise exception 'proposal review recovery requires authorize access' using errcode = '42501';
	end if;
	select max(revision.revision) into v_revision
	from public.qorpera_company_proposal_revisions as revision
	where revision.proposal_id = v_review.proposal_id;
	if v_proposal.status <> 'open' or v_review.status <> 'failed'
		or v_review.proposal_revision <> v_revision then
		raise exception 'proposal review retry is unavailable' using errcode = '55000';
	end if;
	select authority.* into v_authority
	from public.qorpera_staff_execution_authorities as authority
	where authority.profile_id = v_review.profile_id
		and authority.staff_agent_id = v_review.reviewer_staff_agent_id;
	if v_authority.staff_agent_id is null or not exists (
		select 1
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = v_authority.sponsor_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		join public.qorpera_profile_staff as staff
			on staff.profile_id = v_review.profile_id
			and staff.staff_agent_id = v_review.reviewer_staff_agent_id
		where binding.id = v_authority.sponsor_binding_id and binding.profile_id = v_review.profile_id
			and binding.status = 'active' and sponsor.allow_autonomous
			and connection.profile_id = v_review.profile_id and connection.status = 'active'
			and staff.employment_status = 'active' and staff.model_provider = connection.provider
	) or (v_authority.logical_computer_id is not null and not exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.id = v_authority.logical_computer_id and computer.profile_id = v_review.profile_id
			and computer.status = 'active' and computer.capabilities ? 'agent_turn'
	)) then
		raise exception 'configure a current execution authority for this reviewer before retrying' using errcode = '55000';
	end if;
	update public.qorpera_company_proposal_review_assignments
	set status = 'queued', run_id = null, failure_reason = null,
		started_at = null, completed_at = null,
		reviewer_sponsor_binding_id = v_authority.sponsor_binding_id,
		reviewer_sponsor_version = v_authority.sponsor_version,
		reviewer_logical_computer_id = v_authority.logical_computer_id
	where id = v_review.id
	returning * into v_review;
	return jsonb_build_object(
		'assignment_id', v_review.id,
		'proposal_id', v_review.proposal_id,
		'proposal_revision', v_review.proposal_revision,
		'status', v_review.status
	);
end
$$;

create or replace function public.qorpera_list_company_proposal_comments(
	p_proposal_id uuid,
	p_after_created_at timestamptz default null,
	p_after_id uuid default null,
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
	select proposal.profile_id into v_profile_id
	from public.qorpera_company_proposals as proposal where proposal.id = p_proposal_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'company proposal comment access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 100 or ((p_after_created_at is null) is distinct from (p_after_id is null)) then
		raise exception 'company proposal comment page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select comment.*, coalesce(member.display_name, staff.display_name, 'Former company member') as author_name
			from public.qorpera_company_proposal_comments as comment
			left join public.qorpera_profile_members as member
				on member.profile_id = v_profile_id and member.user_id = comment.author_user_id
			left join public.qorpera_profile_staff as staff
				on staff.profile_id = v_profile_id and staff.staff_agent_id = comment.author_staff_agent_id
			where comment.proposal_id = p_proposal_id
				and (p_after_created_at is null or (comment.created_at, comment.id) > (p_after_created_at, p_after_id))
			order by comment.created_at, comment.id
			limit p_limit + 1
		), page as (
			select * from visible order by created_at, id limit p_limit
		)
		select jsonb_build_object(
			'items', coalesce((select jsonb_agg(jsonb_build_object(
				'comment_id', comment.id,
				'proposal_id', comment.proposal_id,
				'body', comment.body,
				'author_user_id', comment.author_user_id,
				'author_staff_agent_id', comment.author_staff_agent_id,
				'author_name', comment.author_name,
				'created_at', comment.created_at
			) order by comment.created_at, comment.id) from page as comment), '[]'::jsonb),
			'has_more', (select count(*) > p_limit from visible),
			'next_created_at', (select max(created_at) from page),
			'next_id', (select id from page order by created_at desc, id desc limit 1)
		)
	);
end
$$;

create or replace function public.qorpera_fail_runner_job(
	p_runner_id uuid,
	p_session_token_sha256 text,
	p_job_id uuid,
	p_lease_token_sha256 text,
	p_error text,
	p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_job public.qorpera_runner_jobs%rowtype;
	v_error text := left(coalesce(nullif(btrim(p_error), ''), 'Runner job failed'), 1000);
begin
	if auth.role() <> 'service_role' or p_retryable is null
		or not public.qorpera_runner_session_valid(p_runner_id, p_session_token_sha256) then
		raise exception 'runner job failure is invalid' using errcode = '42501';
	end if;
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if found and v_job.terminal_lease_token_sha256 = p_lease_token_sha256
		and v_job.last_error like v_error || '%'
		and v_job.status in ('queued', 'failed', 'cancelled') then
		return public.qorpera_runner_job_json(v_job);
	end if;
	if not found or v_job.status <> 'leased' or v_job.runner_id <> p_runner_id
		or v_job.lease_token_sha256 <> p_lease_token_sha256
		or v_job.lease_expires_at <= statement_timestamp() then
		raise exception 'runner job lease is unavailable' using errcode = '40001';
	end if;
	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'failed', v_error, p_retryable
	);
	select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, p_runner_id, v_job.id,
		case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
		jsonb_build_object('attempt_count', v_job.attempt_count), null
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;

create or replace function public.qorpera_revoke_runner(p_runner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
begin
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner revocation requires full access' using errcode = '42501';
	end if;
	if v_runner.status = 'revoked' then return public.qorpera_runner_json(v_runner); end if;
	for v_job in
		select job.* from public.qorpera_runner_jobs as job
		where job.runner_id = p_runner_id and job.status = 'leased'
	loop
		perform public.qorpera_terminalize_runner_attempt(
			v_job.id, 'failed', 'Runner was revoked before completion', true
		);
		select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_job.id;
		perform public.qorpera_append_runner_audit(
			v_job.profile_id, p_runner_id, v_job.id,
			case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
			jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'runner_revoked'), v_user_id
		);
	end loop;
	update public.qorpera_runners
	set status = 'revoked', session_token_sha256 = null, session_expires_at = null,
		previous_session_token_sha256 = null, previous_session_expires_at = null,
		last_renewal_id = null, revoked_by_user_id = v_user_id,
		revoked_at = statement_timestamp()
	where id = p_runner_id returning * into v_runner;
	perform public.qorpera_append_runner_audit(
		v_runner.profile_id, v_runner.id, null, 'runner_revoked', '{}'::jsonb, v_user_id
	);
	return public.qorpera_runner_json(v_runner);
end
$$;

create or replace function public.qorpera_reissue_runner_activation(
	p_runner_id uuid,
	p_activation_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_runner public.qorpera_runners%rowtype;
	v_job public.qorpera_runner_jobs%rowtype;
	v_previous_status text;
begin
	select runner.* into v_runner from public.qorpera_runners as runner
	where runner.id = p_runner_id for update;
	if v_user_id is null or not found or not public.qorpera_can_authorize_profile(v_runner.profile_id) then
		raise exception 'runner registration requires full access' using errcode = '42501';
	end if;
	if v_runner.status = 'revoked' or p_activation_token_sha256 !~ '^[0-9a-f]{64}$' then
		raise exception 'runner activation cannot be reissued' using errcode = '55000';
	end if;
	v_previous_status := v_runner.status;
	if v_runner.status = 'active' then
		for v_job in
			select job.* from public.qorpera_runner_jobs as job
			where job.runner_id = p_runner_id and job.status = 'leased'
		loop
			perform public.qorpera_terminalize_runner_attempt(
				v_job.id, 'failed', 'Runner session was reset for re-pairing', true
			);
			select job.* into strict v_job from public.qorpera_runner_jobs as job where job.id = v_job.id;
			perform public.qorpera_append_runner_audit(
				v_job.profile_id, p_runner_id, v_job.id,
				case when v_job.status = 'queued' then 'job_requeued' else 'job_failed' end,
				jsonb_build_object('attempt_count', v_job.attempt_count, 'reason', 'runner_repaired'), v_user_id
			);
		end loop;
	end if;
	update public.qorpera_runners
	set status = 'pending', activation_token_sha256 = p_activation_token_sha256,
		activation_expires_at = statement_timestamp() + interval '15 minutes',
		session_token_sha256 = null, session_expires_at = null,
		previous_session_token_sha256 = null, previous_session_expires_at = null,
		last_renewal_id = null, platform = null, runner_version = null,
		activated_at = null
	where id = p_runner_id returning * into v_runner;
	perform public.qorpera_append_runner_audit(
		v_runner.profile_id, v_runner.id, null, 'runner_registered',
		jsonb_build_object(
			'reissued', true,
			'previous_status', v_previous_status,
			'activation_expires_at', v_runner.activation_expires_at
		), v_user_id
	);
	return public.qorpera_runner_json(v_runner);
end
$$;

-- Cancellation revokes live execution authority but preserves the exact
-- terminal runner/token identity required for an already-dispatched model
-- request to report its immutable gateway outcome after the cancellation.
create or replace function public.qorpera_cancel_runner_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_job public.qorpera_runner_jobs%rowtype;
begin
	select job.* into v_job from public.qorpera_runner_jobs as job
	where job.id = p_job_id for update;
	if v_user_id is null or not found or not (
		v_job.created_by_user_id = v_user_id or public.qorpera_can_authorize_profile(v_job.profile_id)
	) then
		raise exception 'runner job cancellation is not allowed' using errcode = '42501';
	end if;
	if v_job.status = 'cancelled' then return public.qorpera_runner_job_json(v_job); end if;
	if v_job.status in ('completed', 'failed') then
		raise exception 'runner job is already finished' using errcode = '55000';
	end if;
	perform public.qorpera_terminalize_runner_attempt(
		v_job.id, 'cancelled', 'Runner job was cancelled by a company member', false
	);
	update public.qorpera_runner_jobs
	set cancelled_by_user_id = v_user_id, cancelled_at = statement_timestamp()
	where id = p_job_id returning * into v_job;
	perform public.qorpera_append_runner_audit(
		v_job.profile_id, v_job.runner_id, v_job.id, 'job_cancelled', '{}'::jsonb, v_user_id
	);
	return public.qorpera_runner_job_json(v_job);
end
$$;

-- Runners are assignment consumers, not queue schedulers.
revoke execute on function public.qorpera_claim_runner_job(uuid, text, uuid, text) from service_role;

revoke all on function public.qorpera_register_provider_connection(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, boolean) from public;
revoke all on function public.qorpera_create_execution_sponsor_binding(uuid, uuid, text, uuid, bigint, boolean) from public;
revoke all on function public.qorpera_configure_staff_execution_authority(uuid, uuid, uuid, bigint, uuid) from public;
revoke all on function public.qorpera_configure_session_execution(uuid, uuid, bigint, uuid, text, text, text, text, uuid[]) from public;
revoke all on function public.qorpera_upsert_cloud_routine(uuid, uuid, uuid, uuid, text, text, jsonb, text, uuid, bigint, uuid, text, text, boolean, text, text, uuid[]) from public;
revoke all on function public.qorpera_enqueue_routine_wake(uuid, bigint, uuid, text, text, timestamptz, timestamptz, timestamptz, jsonb) from public;
revoke all on function public.qorpera_list_cloud_routines(uuid) from public;
revoke all on function public.qorpera_list_wake_occurrences(uuid, integer) from public;
revoke all on function public.qorpera_list_routine_schedule_heads(uuid, integer) from public;
revoke all on function public.qorpera_enqueue_execution_run(uuid, uuid, uuid, text, uuid, uuid, uuid, bigint, uuid, bigint, text, text, jsonb, text, text, uuid[], uuid) from public;
revoke all on function public.qorpera_materialize_session_execution_runs(integer) from public;
revoke all on function public.qorpera_materialize_wake_execution_runs(integer) from public;
revoke all on function public.qorpera_materialize_company_proposal_review_runs(integer) from public;
revoke all on function public.qorpera_seed_company_proposal_reviews() from public;
revoke all on function public.qorpera_retry_company_proposal_review(uuid) from public;
revoke all on function public.qorpera_guard_runner_owned_session_input() from public;
revoke all on function public.qorpera_guard_legacy_owned_session_input() from public;
revoke all on function public.qorpera_guard_cloud_bound_legacy_turn() from public;
revoke all on function public.qorpera_register_runner_orchestrator(uuid, text, text, text, integer) from public;
revoke all on function public.qorpera_runner_orchestrator_control_valid(uuid, text) from public;
revoke all on function public.qorpera_reconcile_runner_orchestrator(uuid) from public;
revoke all on function public.qorpera_list_retained_runner_claims(uuid) from public;
revoke all on function public.qorpera_claim_runner_job_for_orchestrator(uuid, uuid, integer) from public;
revoke all on function public.qorpera_assign_runner_job(uuid, uuid, uuid, uuid, text, integer) from public;
revoke all on function public.qorpera_renew_runner_job_claim(uuid, uuid, integer) from public;
revoke all on function public.qorpera_release_runner_job_claim(uuid, uuid, uuid, text) from public;
revoke all on function public.qorpera_accept_runner_assignment(uuid, text, uuid, uuid, text) from public;
revoke all on function public.qorpera_begin_run_operation_receipt(uuid, text, uuid, text, uuid, uuid, text, text, text, text, boolean) from public;
revoke all on function public.qorpera_complete_run_operation_receipt(uuid, text, uuid, text, uuid, uuid, text, jsonb, uuid, uuid) from public;
revoke all on function public.qorpera_resolve_run_operation_receipt(uuid, text, jsonb, uuid, uuid) from public;
revoke all on function public.qorpera_bind_execution_provider_session(uuid, text, uuid, text, text, text) from public;
revoke all on function public.qorpera_append_runner_transcript_event(uuid, text, uuid, text, uuid, uuid, text, jsonb, bigint) from public;
revoke all on function public.qorpera_complete_runner_job_v5(uuid, text, uuid, text, uuid, uuid, jsonb) from public;
revoke execute on function public.qorpera_complete_runner_job_v5(uuid, text, uuid, text, uuid, uuid, jsonb) from service_role;
revoke all on function public.qorpera_runner_prepare_company_revision(uuid, text, uuid, text, uuid, uuid, text, integer, integer, integer, bigint) from public;
revoke all on function public.qorpera_runner_company_revision_snapshot(uuid, text, uuid, text, uuid, uuid) from public;
revoke all on function public.qorpera_runner_begin_company_revision_graph(uuid, text, uuid, text, uuid, uuid, uuid, text, text, integer, bigint) from public;
revoke all on function public.qorpera_runner_append_company_revision_graph(uuid, text, uuid, text, uuid, uuid, jsonb) from public;
revoke all on function public.qorpera_runner_complete_company_revision_graph(uuid, text, uuid, text, uuid, uuid) from public;
revoke all on function public.qorpera_runner_authorize_company_revision_verification(uuid, text, uuid, text, uuid, uuid, uuid) from public;
revoke all on function public.qorpera_runner_finalize_company_revision_verification(uuid, text, uuid, text, uuid, uuid, uuid) from public;
revoke all on function public.qorpera_complete_runner_job_v6(uuid, text, uuid, text, uuid, uuid, uuid, jsonb) from public;
revoke all on function public.qorpera_runner_broker_list_transcript(uuid, text, uuid, text, bigint, integer) from public;
revoke all on function public.qorpera_runner_broker_list_inputs(uuid, text, uuid, text) from public;
revoke all on function public.qorpera_runner_broker_authorize_company_file_object(uuid, text, uuid, text, text, bigint, text) from public;
revoke all on function public.qorpera_list_execution_run_recoveries(uuid, integer) from public;
revoke all on function public.qorpera_get_execution_run_recovery(uuid) from public;
revoke all on function public.qorpera_list_session_execution_run_recoveries(uuid, integer) from public;
revoke all on function public.qorpera_list_staff_execution_activity(uuid) from public;
revoke all on function public.qorpera_resolve_failed_execution_run(uuid, text) from public;
revoke all on function public.qorpera_runner_execution_status_event() from public;
revoke all on function public.qorpera_runner_proposal_wake_status() from public;
revoke all on function public.qorpera_release_expired_provider_checkpoint_reference() from public;

grant execute on function public.qorpera_register_provider_connection(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, boolean) to authenticated;
grant execute on function public.qorpera_create_execution_sponsor_binding(uuid, uuid, text, uuid, bigint, boolean) to authenticated;
grant execute on function public.qorpera_configure_staff_execution_authority(uuid, uuid, uuid, bigint, uuid) to authenticated;
grant execute on function public.qorpera_set_provider_connection_status(uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_set_execution_sponsor_status(uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_upsert_logical_computer(uuid, uuid, text, text, text, jsonb, jsonb, text) to authenticated;
grant execute on function public.qorpera_set_logical_computer_status(uuid, uuid, text) to authenticated;
grant execute on function public.qorpera_configure_session_execution(uuid, uuid, bigint, uuid, text, text, text, text, uuid[]) to authenticated;
grant execute on function public.qorpera_upsert_cloud_routine(uuid, uuid, uuid, uuid, text, text, jsonb, text, uuid, bigint, uuid, text, text, boolean, text, text, uuid[]) to authenticated;
grant execute on function public.qorpera_enqueue_routine_wake(uuid, bigint, uuid, text, text, timestamptz, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.qorpera_list_cloud_routines(uuid) to authenticated;
grant execute on function public.qorpera_list_wake_occurrences(uuid, integer) to authenticated;
grant execute on function public.qorpera_list_routine_schedule_heads(uuid, integer) to service_role;
grant execute on function public.qorpera_enqueue_execution_run(uuid, uuid, uuid, text, uuid, uuid, uuid, bigint, uuid, bigint, text, text, jsonb, text, text, uuid[], uuid) to authenticated;
grant execute on function public.qorpera_materialize_session_execution_runs(integer) to service_role;
grant execute on function public.qorpera_materialize_wake_execution_runs(integer) to service_role;
grant execute on function public.qorpera_materialize_company_proposal_review_runs(integer) to service_role;
grant execute on function public.qorpera_retry_company_proposal_review(uuid) to authenticated;
grant execute on function public.qorpera_register_runner_orchestrator(uuid, text, text, text, integer) to service_role;
grant execute on function public.qorpera_runner_orchestrator_control_valid(uuid, text) to service_role;
grant execute on function public.qorpera_reconcile_runner_orchestrator(uuid) to service_role;
grant execute on function public.qorpera_list_retained_runner_claims(uuid) to service_role;
grant execute on function public.qorpera_claim_runner_job_for_orchestrator(uuid, uuid, integer) to service_role;
grant execute on function public.qorpera_assign_runner_job(uuid, uuid, uuid, uuid, text, integer) to service_role;
grant execute on function public.qorpera_renew_runner_job_claim(uuid, uuid, integer) to service_role;
grant execute on function public.qorpera_release_runner_job_claim(uuid, uuid, uuid, text) to service_role;
grant execute on function public.qorpera_accept_runner_assignment(uuid, text, uuid, uuid, text) to service_role;
grant execute on function public.qorpera_begin_run_operation_receipt(uuid, text, uuid, text, uuid, uuid, text, text, text, text, boolean) to service_role;
grant execute on function public.qorpera_complete_run_operation_receipt(uuid, text, uuid, text, uuid, uuid, text, jsonb, uuid, uuid) to service_role;
grant execute on function public.qorpera_resolve_run_operation_receipt(uuid, text, jsonb, uuid, uuid) to authenticated;
grant execute on function public.qorpera_bind_execution_provider_session(uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.qorpera_append_runner_transcript_event(uuid, text, uuid, text, uuid, uuid, text, jsonb, bigint) to service_role;
grant execute on function public.qorpera_runner_prepare_company_revision(uuid, text, uuid, text, uuid, uuid, text, integer, integer, integer, bigint) to service_role;
grant execute on function public.qorpera_runner_begin_company_revision_graph(uuid, text, uuid, text, uuid, uuid, uuid, text, text, integer, bigint) to service_role;
grant execute on function public.qorpera_runner_append_company_revision_graph(uuid, text, uuid, text, uuid, uuid, jsonb) to service_role;
grant execute on function public.qorpera_runner_complete_company_revision_graph(uuid, text, uuid, text, uuid, uuid) to service_role;
grant execute on function public.qorpera_runner_authorize_company_revision_verification(uuid, text, uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function public.qorpera_runner_finalize_company_revision_verification(uuid, text, uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function public.qorpera_complete_runner_job_v6(uuid, text, uuid, text, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.qorpera_runner_broker_list_transcript(uuid, text, uuid, text, bigint, integer) to service_role;
grant execute on function public.qorpera_runner_broker_list_inputs(uuid, text, uuid, text) to service_role;
grant execute on function public.qorpera_runner_broker_authorize_company_file_object(uuid, text, uuid, text, text, bigint, text) to service_role;
grant execute on function public.qorpera_list_execution_run_recoveries(uuid, integer) to authenticated;
grant execute on function public.qorpera_get_execution_run_recovery(uuid) to authenticated;
grant execute on function public.qorpera_list_session_execution_run_recoveries(uuid, integer) to authenticated;
grant execute on function public.qorpera_list_staff_execution_activity(uuid) to authenticated;
grant execute on function public.qorpera_resolve_failed_execution_run(uuid, text) to authenticated;
