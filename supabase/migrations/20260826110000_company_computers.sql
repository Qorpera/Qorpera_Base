-- Step 3 Company Computers: the control-plane registry binding one persistent
-- logical computer to each company environment, with lifecycle and node
-- placement (deploy/first-node/STEP-3-COMPANY-COMPUTERS.md).
--
-- A Company Computer IS a logical computer: turns keep targeting it through
-- the existing logical_computer_id slot and worker_class 'company_computer'
-- that Step 2 already carries in the work and turn contracts. This migration
-- only adds the registry around that slot; it does not change how work is
-- addressed, provisioned, or published.
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

-- Physical placement targets. Nodes host many companies, so this registry is
-- cluster-scoped, not profile-scoped, and is service-plane state: members
-- never address nodes, they address their Company Computer.
create table public.qorpera_compute_nodes (
	id uuid primary key default extensions.gen_random_uuid(),
	node_key text not null unique check (node_key ~ '^[a-z][a-z0-9-]{0,62}$'),
	display_name text not null check (char_length(btrim(display_name)) between 1 and 120),
	provider_adapter text not null check (provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
	status text not null default 'active' check (status in ('active', 'draining', 'retired')),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp()
);

alter table public.qorpera_compute_nodes enable row level security;
revoke all on table public.qorpera_compute_nodes from anon, authenticated;

-- One persistent Company Computer per company environment. The row pins the
-- NAS dataset that carries the machine's working world (working Company File
-- checkout, workbench, browser profiles); the VM itself stays near-stateless
-- and replaceable, so migration and recovery are share reattachment plus a
-- lifecycle transition here, never data movement.
create table public.qorpera_company_computers (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	logical_computer_id uuid not null unique
		references public.qorpera_logical_computers(id) on delete restrict,
	node_id uuid references public.qorpera_compute_nodes(id) on delete restrict,
	migration_target_node_id uuid references public.qorpera_compute_nodes(id) on delete restrict,
	nas_dataset text not null unique check (
		nas_dataset ~ '^[a-z0-9][a-z0-9._-]{0,180}(/[a-z0-9][a-z0-9._-]{0,180}){0,7}$'
		and nas_dataset !~ '\.\.'
	),
	lifecycle_state text not null default 'provisioning' check (lifecycle_state in (
		'provisioning', 'active', 'snapshotting', 'migrating', 'recovering', 'retired'
	)),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	unique (id, profile_id),
	check (lifecycle_state = 'provisioning' or node_id is not null),
	check ((lifecycle_state = 'migrating') = (migration_target_node_id is not null)),
	check (migration_target_node_id is null or migration_target_node_id <> node_id)
);

-- The charter's sharing unit: at most one live Company Computer per company
-- environment. A retired computer may be replaced.
create unique index qorpera_company_computers_environment
	on public.qorpera_company_computers (environment_id)
	where lifecycle_state <> 'retired';

alter table public.qorpera_company_computers enable row level security;
revoke all on table public.qorpera_company_computers from anon, authenticated;

create table public.qorpera_company_computer_events (
	id bigint generated always as identity primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	company_computer_id uuid not null references public.qorpera_company_computers(id) on delete restrict,
	event_type text not null check (event_type in (
		'company_computer_registered', 'company_computer_lifecycle'
	)),
	payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
	actor_user_id uuid references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp()
);

create index qorpera_company_computer_events_computer_sequence
	on public.qorpera_company_computer_events (company_computer_id, id);

alter table public.qorpera_company_computer_events enable row level security;
revoke all on table public.qorpera_company_computer_events from anon, authenticated;

-- The registry row must always name a company-class logical computer of its
-- own profile whose compute identity is company-owned: tenancy is the company
-- environment, never a member account. Member-owned identities stay bound to
-- sponsor capsules and are delivered per staff session, not parked on the
-- shared machine.
create function public.qorpera_company_computer_binding_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_computer public.qorpera_logical_computers%rowtype;
begin
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = new.logical_computer_id;
	if v_computer.id is null
		or v_computer.profile_id <> new.profile_id
		or v_computer.computer_class <> 'company_computer'
		or v_computer.compute_identity_id is null
		or not exists (
			select 1 from public.qorpera_member_compute_identities as identity
			where identity.id = v_computer.compute_identity_id
				and identity.profile_id = new.profile_id
				and identity.ownership_kind = 'company'
		)
		or not exists (
			select 1 from public.qorpera_company_environments as environment
			where environment.id = new.environment_id and environment.profile_id = new.profile_id
		) then
		raise exception 'company computer binding is invalid' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_company_computer_binding_guard
before insert or update of profile_id, environment_id, logical_computer_id
on public.qorpera_company_computers
for each row execute function public.qorpera_company_computer_binding_guard();

create function public.qorpera_append_company_computer_event(
	p_profile_id uuid,
	p_company_computer_id uuid,
	p_event_type text,
	p_payload jsonb,
	p_actor_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.qorpera_company_computer_events (
		profile_id, company_computer_id, event_type, payload, actor_user_id
	) values (p_profile_id, p_company_computer_id, p_event_type, p_payload, p_actor_user_id);
end
$$;

revoke all on function public.qorpera_append_company_computer_event(uuid, uuid, text, jsonb, uuid) from public;

create function public.qorpera_company_computer_json(p_computer public.qorpera_company_computers)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'company_computer_id', p_computer.id,
		'profile_id', p_computer.profile_id,
		'environment_id', p_computer.environment_id,
		'logical_computer_id', p_computer.logical_computer_id,
		'lifecycle_state', p_computer.lifecycle_state,
		'nas_dataset', p_computer.nas_dataset,
		'node_key', (
			select node.node_key from public.qorpera_compute_nodes as node
			where node.id = p_computer.node_id
		),
		'migration_target_node_key', (
			select node.node_key from public.qorpera_compute_nodes as node
			where node.id = p_computer.migration_target_node_id
		),
		'created_at', p_computer.created_at,
		'updated_at', p_computer.updated_at
	)
$$;

revoke all on function public.qorpera_company_computer_json(public.qorpera_company_computers) from public;

-- Member-facing registration. Creates the company-class logical computer and
-- its registry row in one authorized step, because the Step 2 configure RPC
-- can neither set computer_class nor bind a compute identity. Idempotent on
-- the client computer id; a repeated call must name the same binding.
create function public.qorpera_register_company_computer(
	p_profile_id uuid,
	p_client_computer_id uuid,
	p_environment_id uuid,
	p_display_name text,
	p_template_key text,
	p_template_version text,
	p_capabilities jsonb,
	p_policy jsonb,
	p_compute_identity_id uuid,
	p_nas_dataset text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_logical public.qorpera_logical_computers%rowtype;
	v_registry public.qorpera_company_computers%rowtype;
begin
	if v_user_id is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'company computer registration requires authorize access' using errcode = '42501';
	end if;
	if p_client_computer_id is null or p_environment_id is null or p_compute_identity_id is null
		or char_length(btrim(coalesce(p_display_name, ''))) not between 1 and 120
		or coalesce(p_template_key, '') !~ '^[a-z][a-z0-9._-]{0,119}$'
		or char_length(btrim(coalesce(p_template_version, ''))) not between 1 and 120
		or not public.qorpera_runner_capabilities_valid(p_capabilities)
		or jsonb_typeof(coalesce(p_policy, '{}'::jsonb)) <> 'object'
		or pg_column_size(coalesce(p_policy, '{}'::jsonb)) > 65536 then
		raise exception 'company computer registration is invalid' using errcode = '22023';
	end if;
	if not exists (
		select 1 from public.qorpera_member_compute_identities as identity
		where identity.id = p_compute_identity_id and identity.profile_id = p_profile_id
			and identity.ownership_kind = 'company' and identity.status = 'active'
	) then
		raise exception 'company computer requires an active company-owned compute identity'
			using errcode = '42501';
	end if;
	select computer.* into v_logical
	from public.qorpera_logical_computers as computer
	where computer.profile_id = p_profile_id and computer.client_computer_id = p_client_computer_id
	for update;
	if found then
		select registry.* into v_registry
		from public.qorpera_company_computers as registry
		where registry.logical_computer_id = v_logical.id
		for update;
		if v_logical.computer_class <> 'company_computer' or v_registry.id is null
			or v_registry.environment_id <> p_environment_id
			or v_registry.nas_dataset <> p_nas_dataset
			or v_logical.compute_identity_id is distinct from p_compute_identity_id then
			raise exception 'company computer client id is already bound to other authority'
				using errcode = '23505';
		end if;
		return public.qorpera_company_computer_json(v_registry);
	end if;
	insert into public.qorpera_logical_computers (
		profile_id, client_computer_id, display_name, template_key, template_version,
		capabilities, policy, computer_class, compute_identity_id, created_by_user_id
	) values (
		p_profile_id, p_client_computer_id, btrim(p_display_name), p_template_key,
		btrim(p_template_version), p_capabilities, coalesce(p_policy, '{}'::jsonb),
		'company_computer', p_compute_identity_id, v_user_id
	) returning * into v_logical;
	insert into public.qorpera_company_computers (
		profile_id, environment_id, logical_computer_id, nas_dataset, created_by_user_id
	) values (
		p_profile_id, p_environment_id, v_logical.id, p_nas_dataset, v_user_id
	) returning * into v_registry;
	perform public.qorpera_append_company_computer_event(
		p_profile_id, v_registry.id, 'company_computer_registered',
		jsonb_build_object(
			'environment_id', p_environment_id,
			'logical_computer_id', v_logical.id,
			'compute_identity_id', p_compute_identity_id,
			'template_key', v_logical.template_key,
			'template_version', v_logical.template_version,
			'nas_dataset', p_nas_dataset
		), v_user_id
	);
	return public.qorpera_company_computer_json(v_registry);
end
$$;

revoke all on function public.qorpera_register_company_computer(
	uuid, uuid, uuid, text, text, text, jsonb, jsonb, uuid, text
) from public;
grant execute on function public.qorpera_register_company_computer(
	uuid, uuid, uuid, text, text, text, jsonb, jsonb, uuid, text
) to authenticated;

-- Service-plane lifecycle machine, driven by the provider adapter and future
-- lifecycle tooling. Placement is adopted on provisioning -> active, changed
-- by the migrating round trip, and optionally re-adopted when recovery lands
-- the share on another node.
create function public.qorpera_company_computer_lifecycle(
	p_company_computer_id uuid,
	p_state text,
	p_node_key text default null,
	p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_registry public.qorpera_company_computers%rowtype;
	v_node public.qorpera_compute_nodes%rowtype;
	v_previous text;
begin
	if auth.role() <> 'service_role'
		or p_state not in ('provisioning', 'active', 'snapshotting', 'migrating', 'recovering', 'retired')
		or jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object'
		or pg_column_size(coalesce(p_detail, '{}'::jsonb)) > 4096 then
		raise exception 'company computer lifecycle authority is invalid' using errcode = '42501';
	end if;
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.id = p_company_computer_id
	for update;
	if not found then
		raise exception 'company computer is unknown' using errcode = '55000';
	end if;
	v_previous := v_registry.lifecycle_state;
	if not (
		(v_previous = 'provisioning' and p_state in ('active', 'retired'))
		or (v_previous = 'active' and p_state in ('snapshotting', 'migrating', 'recovering', 'retired'))
		or (v_previous = 'snapshotting' and p_state in ('active', 'recovering', 'retired'))
		or (v_previous = 'migrating' and p_state in ('active', 'recovering', 'retired'))
		or (v_previous = 'recovering' and p_state in ('active', 'retired'))
	) then
		raise exception 'company computer lifecycle transition % -> % is invalid', v_previous, p_state
			using errcode = '55000';
	end if;
	if p_node_key is not null then
		select node.* into v_node
		from public.qorpera_compute_nodes as node
		where node.node_key = p_node_key and node.status = 'active';
		if not found then
			raise exception 'company computer placement node is unavailable' using errcode = '55000';
		end if;
	end if;
	if v_previous = 'provisioning' and p_state = 'active' then
		if v_node.id is null then
			raise exception 'company computer activation requires node placement' using errcode = '55000';
		end if;
		v_registry.node_id := v_node.id;
	elsif p_state = 'migrating' then
		if v_node.id is null or v_node.id = v_registry.node_id then
			raise exception 'company computer migration requires a distinct target node' using errcode = '55000';
		end if;
		v_registry.migration_target_node_id := v_node.id;
	elsif v_previous = 'migrating' and p_state = 'active' then
		v_registry.node_id := v_registry.migration_target_node_id;
		v_registry.migration_target_node_id := null;
	elsif v_previous = 'recovering' and p_state = 'active' and v_node.id is not null then
		v_registry.node_id := v_node.id;
	end if;
	if v_previous = 'migrating' and p_state <> 'active' then
		v_registry.migration_target_node_id := null;
	end if;
	update public.qorpera_company_computers
	set lifecycle_state = p_state,
		node_id = v_registry.node_id,
		migration_target_node_id = v_registry.migration_target_node_id,
		updated_at = statement_timestamp()
	where id = v_registry.id
	returning * into v_registry;
	if p_state = 'retired' then
		-- Retirement mirrors the Step 2 logical-computer retire effects so
		-- queued work stops addressing the machine and no volume reference
		-- outlives it.
		update public.qorpera_logical_computers
		set status = 'retired',
			encrypted_volume_object_sha256 = null,
			updated_at = statement_timestamp()
		where id = v_registry.logical_computer_id;
		perform public.qorpera_terminalize_runner_attempt(
			job.id, 'failed', 'Company computer was retired', false
		)
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on job.id = run.job_id
		where job.status in ('queued', 'leased')
			and (
				run.logical_computer_id = v_registry.logical_computer_id
				or (
					job.status = 'leased'
					and exists (
						select 1 from public.qorpera_runners as runner
						where runner.id = job.runner_id
							and runner.logical_computer_id = v_registry.logical_computer_id
					)
				)
			);
	end if;
	perform public.qorpera_append_company_computer_event(
		v_registry.profile_id, v_registry.id, 'company_computer_lifecycle',
		jsonb_build_object(
			'from', v_previous,
			'to', p_state,
			'node_key', p_node_key,
			'detail', coalesce(p_detail, '{}'::jsonb)
		)
	);
	return public.qorpera_company_computer_json(v_registry);
end
$$;

revoke all on function public.qorpera_company_computer_lifecycle(uuid, text, text, jsonb) from public;
grant execute on function public.qorpera_company_computer_lifecycle(uuid, text, text, jsonb) to service_role;

-- Provider-adapter read: the persistent lane resolves the dataset and
-- placement pinned here instead of deriving them, so the control plane stays
-- the single writer for where a Company Computer lives.
create function public.qorpera_describe_company_computer(p_logical_computer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_registry public.qorpera_company_computers%rowtype;
	v_logical public.qorpera_logical_computers%rowtype;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer description requires provider authority' using errcode = '42501';
	end if;
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.logical_computer_id = p_logical_computer_id;
	if not found then
		raise exception 'company computer is unknown' using errcode = '55000';
	end if;
	select computer.* into strict v_logical
	from public.qorpera_logical_computers as computer
	where computer.id = v_registry.logical_computer_id;
	return public.qorpera_company_computer_json(v_registry) || jsonb_build_object(
		'logical_computer_status', v_logical.status,
		'compute_identity_id', v_logical.compute_identity_id,
		'template_key', v_logical.template_key,
		'template_version', v_logical.template_version,
		'capabilities', v_logical.capabilities,
		'compute_policy_sha256', public.qorpera_compute_policy_sha256(v_logical.policy)
	);
end
$$;

revoke all on function public.qorpera_describe_company_computer(uuid) from public;
grant execute on function public.qorpera_describe_company_computer(uuid) to service_role;

-- Dispatch gate: work aimed at a Company Computer stays dispatchable while
-- the machine is provisioning (the first acquire creates it), active, or
-- snapshotting (dataset snapshots are crash-consistent and concurrent with
-- execution). Migrating, recovering, and retired machines must not accept
-- new dispatch. Vacuously true for every logical computer without a registry
-- row, so Step 2 behavior is unchanged.
create or replace function public.qorpera_execution_compute_available(p_run public.qorpera_execution_runs)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_run.logical_computer_id is null or (
		exists (
			select 1
			from public.qorpera_logical_computers as computer
			join public.qorpera_runner_jobs as job on job.id = p_run.job_id
			where computer.id = p_run.logical_computer_id
				and computer.profile_id = p_run.profile_id
				and computer.status = 'active'
				and computer.capabilities ? job.required_capability
		)
		and not exists (
			select 1
			from public.qorpera_company_computers as registry
			where registry.logical_computer_id = p_run.logical_computer_id
				and registry.lifecycle_state not in ('provisioning', 'active', 'snapshotting')
		)
	)
$$;
