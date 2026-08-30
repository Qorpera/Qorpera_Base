-- Runtime Step 2. A Company Computer may coexist with a governed Company
-- File only when the cloud control plane created the immutable mediation
-- binding. The physical worker remains a one-run VM using company-path-v1;
-- this does not admit the older raw-mounted, long-lived desktop prototype.

create function public.qorpera_governed_company_computer_policy()
returns jsonb
language sql
immutable
set search_path = ''
as $$
	select jsonb_build_object(
		'schema', 'qorpera.governed-company-computer-policy/v1',
		'runtime', 'company-path-v1',
		'executionBoundary', 'virtual_machine',
		'companyFileAccess', 'path_gateway_only',
		'canonicalMount', false,
		'lifecycle', 'ephemeral_per_run',
		'recovery', 'retained_volume',
		'providerAdapter', 'lxd'
	)
$$;

revoke all on function public.qorpera_governed_company_computer_policy()
	from public, anon, authenticated, service_role;

-- Production may retain this trigger from the earlier Company Computer
-- registry, including its default PUBLIC/API grants. Preserve its owner,
-- definition and existing trigger bindings, but do not let a new least-
-- privilege service inherit permission to attach it to another table.
do $$
declare
	v_guard regprocedure := to_regprocedure('public.qorpera_company_computer_binding_guard()');
begin
	if v_guard is not null then
		if not exists (
			select 1 from pg_proc where oid = v_guard and prorettype = 'trigger'::regtype
		) then
			raise exception 'Legacy Company Computer guard has an unexpected signature';
		end if;
		execute 'revoke all on function public.qorpera_company_computer_binding_guard()
			from public, anon, authenticated, service_role';
	end if;
end
$$;

create table public.qorpera_governed_company_computers (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete restrict,
	logical_computer_id uuid not null unique,
	client_computer_id uuid not null,
	compute_identity_id uuid not null unique
		references public.qorpera_member_compute_identities(id) on delete restrict,
	template_key text not null check (template_key ~ '^[a-z][a-z0-9._-]{0,119}$'),
	template_version text not null check (
		char_length(btrim(template_version)) between 1 and 120 and template_version !~ E'[\r\n]'
	),
	capabilities jsonb not null check (capabilities = '["agent_turn"]'::jsonb),
	policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
	runtime text not null check (runtime = 'company-path-v1'),
	execution_boundary text not null check (execution_boundary = 'virtual_machine'),
	company_file_access text not null check (company_file_access = 'path_gateway_only'),
	canonical_mount boolean not null check (not canonical_mount),
	lifecycle text not null check (lifecycle = 'ephemeral_per_run'),
	recovery_mode text not null check (recovery_mode = 'retained_volume'),
	provider_adapter text not null check (provider_adapter = 'lxd'),
	guest_image_fingerprint text not null check (guest_image_fingerprint ~ '^[0-9a-f]{64}$'),
	guest_bootstrap_sha256 text not null check (guest_bootstrap_sha256 ~ '^[0-9a-f]{64}$'),
	native_binary_sha256 text not null check (native_binary_sha256 ~ '^[0-9a-f]{64}$'),
	authorized_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_computer_id),
	foreign key (logical_computer_id)
		references public.qorpera_logical_computers(id) on delete restrict
		deferrable initially deferred
);

alter table public.qorpera_governed_company_computers enable row level security;
revoke all on public.qorpera_governed_company_computers
	from public, anon, authenticated, service_role;

create function public.qorpera_governed_company_computer_matches(
	p_computer public.qorpera_logical_computers
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_governed_company_computers as binding
		where binding.profile_id = p_computer.profile_id
			and binding.logical_computer_id = p_computer.id
			and binding.client_computer_id = p_computer.client_computer_id
			and binding.compute_identity_id = p_computer.compute_identity_id
			and binding.template_key = p_computer.template_key
			and binding.template_version = p_computer.template_version
			and binding.capabilities = p_computer.capabilities
			and binding.policy_sha256 = public.qorpera_compute_policy_sha256(p_computer.policy)
			and p_computer.policy = public.qorpera_governed_company_computer_policy()
			and p_computer.computer_class = 'company_computer'
			and p_computer.encrypted_volume_object_sha256 is null
			and binding.runtime = 'company-path-v1'
			and binding.execution_boundary = 'virtual_machine'
			and binding.company_file_access = 'path_gateway_only'
			and not binding.canonical_mount
			and binding.lifecycle = 'ephemeral_per_run'
			and binding.recovery_mode = 'retained_volume'
			and binding.provider_adapter = 'lxd'
	)
$$;

revoke all on function public.qorpera_governed_company_computer_matches(
	public.qorpera_logical_computers
) from public, anon, authenticated, service_role;

create or replace function public.qorpera_enforce_company_path_computer_interlock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_table_name = 'qorpera_logical_computers' then
		if tg_op = 'UPDATE' and old.computer_class = 'company_computer'
			and (new.computer_class is distinct from old.computer_class
				or new.profile_id is distinct from old.profile_id) then
			raise exception 'Legacy company computer access cannot be cleared by relabelling its binding'
				using errcode = '55000';
		end if;
		if new.computer_class <> 'company_computer' then return new; end if;
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if public.qorpera_governed_company_computer_matches(new)
			or public.qorpera_legacy_company_computer_teardown_matches(new) then return new; end if;
		if exists (select 1 from public.qorpera_company_files
			where profile_id = new.profile_id and path_gateway_version = 1) then
			raise exception 'Governed Company Files require a path-mediated company computer'
				using errcode = '55000';
		end if;
	elsif tg_table_name = 'qorpera_company_files' then
		if new.path_gateway_version is distinct from 1 then return new; end if;
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if exists (
			select 1 from public.qorpera_logical_computers as computer
			where computer.profile_id = new.profile_id
				and computer.computer_class = 'company_computer'
				and not public.qorpera_governed_company_computer_matches(computer)
				and not public.qorpera_legacy_company_computer_teardown_matches(computer)
		) then
			raise exception 'Company File cutover requires verified removal of legacy computer access'
				using errcode = '55000';
		end if;
	else
		raise exception 'Invalid Company File interlock target' using errcode = '55000';
	end if;
	return new;
end
$$;

create function public.qorpera_guard_governed_company_computer_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if public.qorpera_governed_company_computer_matches(old) and (
		new.profile_id is distinct from old.profile_id
		or new.client_computer_id is distinct from old.client_computer_id
		or new.template_key is distinct from old.template_key
		or new.template_version is distinct from old.template_version
		or new.capabilities is distinct from old.capabilities
		or new.policy is distinct from old.policy
		or new.encrypted_volume_object_sha256 is distinct from old.encrypted_volume_object_sha256
		or new.compute_identity_id is distinct from old.compute_identity_id
		or new.computer_class is distinct from old.computer_class
	) then
		raise exception 'Governed company computer authority is immutable'
			using errcode = '42501';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_guard_governed_company_computer_update()
	from public, anon, authenticated, service_role;

create trigger qorpera_guard_governed_company_computer_update
before update on public.qorpera_logical_computers
for each row execute function public.qorpera_guard_governed_company_computer_update();

create function public.qorpera_register_governed_company_computer(
	p_profile_id uuid,
	p_client_computer_id uuid,
	p_compute_identity_id uuid,
	p_guest_image_fingerprint text,
	p_guest_bootstrap_sha256 text,
	p_native_binary_sha256 text,
	p_authorized_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_binding public.qorpera_governed_company_computers%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_computer_id uuid := extensions.gen_random_uuid();
	v_policy jsonb := public.qorpera_governed_company_computer_policy();
begin
	if auth.role() is distinct from 'service_role'
		or p_client_computer_id is null
		or coalesce(p_guest_image_fingerprint, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_guest_bootstrap_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_native_binary_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Governed company computer registration is invalid'
			using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id
			and member.user_id = p_authorized_by_user_id
			and member.role in ('owner', 'admin')
	) or not exists (
		select 1 from public.qorpera_company_files as file
		where file.profile_id = p_profile_id
			and file.state = 'ready'
			and file.path_gateway_version = 1
	) then
		raise exception 'Governed company computer authority is unavailable'
			using errcode = '42501';
	end if;
	select identity.* into v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = p_compute_identity_id
		and identity.profile_id = p_profile_id
		and identity.ownership_kind = 'company'
		and identity.status = 'active'
		and identity.recovery_pending_id is null
	for share;
	if not found or not (v_identity.capabilities ? 'agent_turn') then
		raise exception 'Governed company computer Compute Identity is unavailable'
			using errcode = '42501';
	end if;
	select binding.* into v_binding
	from public.qorpera_governed_company_computers as binding
	where binding.profile_id = p_profile_id
	for update;
	if found then
		select computer.* into strict v_computer
		from public.qorpera_logical_computers as computer
		where computer.id = v_binding.logical_computer_id;
		if v_binding.client_computer_id is distinct from p_client_computer_id
			or v_binding.compute_identity_id is distinct from p_compute_identity_id
			or v_binding.guest_image_fingerprint is distinct from p_guest_image_fingerprint
			or v_binding.guest_bootstrap_sha256 is distinct from p_guest_bootstrap_sha256
			or v_binding.native_binary_sha256 is distinct from p_native_binary_sha256
			or v_binding.authorized_by_user_id is distinct from p_authorized_by_user_id
			or not public.qorpera_governed_company_computer_matches(v_computer) then
			raise exception 'Company already has another governed computer authority'
				using errcode = '23505';
		end if;
		return jsonb_build_object(
			'logical_computer_id', v_computer.id,
			'profile_id', v_computer.profile_id,
			'compute_identity_id', v_computer.compute_identity_id,
			'worker_class', v_computer.computer_class,
			'runtime', v_binding.runtime,
			'provider_adapter', v_binding.provider_adapter,
			'policy_sha256', v_binding.policy_sha256,
			'status', v_computer.status
		);
	end if;
	if exists (
		select 1 from public.qorpera_logical_computers as computer
		where computer.profile_id = p_profile_id
			and computer.computer_class = 'company_computer'
			and not public.qorpera_legacy_company_computer_teardown_matches(computer)
	) then
		raise exception 'Legacy company computer requires verified physical teardown before mediation'
			using errcode = '55000';
	end if;
	insert into public.qorpera_governed_company_computers (
		profile_id, logical_computer_id, client_computer_id, compute_identity_id,
		template_key, template_version, capabilities, policy_sha256,
		runtime, execution_boundary, company_file_access, canonical_mount,
		lifecycle, recovery_mode, provider_adapter, guest_image_fingerprint,
		guest_bootstrap_sha256, native_binary_sha256, authorized_by_user_id
	) values (
		p_profile_id, v_computer_id, p_client_computer_id, p_compute_identity_id,
		v_identity.template_key, v_identity.template_version, '["agent_turn"]'::jsonb,
		public.qorpera_compute_policy_sha256(v_policy), 'company-path-v1',
		'virtual_machine', 'path_gateway_only', false, 'ephemeral_per_run',
		'retained_volume', 'lxd', p_guest_image_fingerprint,
		p_guest_bootstrap_sha256, p_native_binary_sha256, p_authorized_by_user_id
	);
	insert into public.qorpera_logical_computers (
		id, profile_id, client_computer_id, display_name, template_key,
		template_version, capabilities, policy, encrypted_volume_object_sha256,
		status, created_by_user_id, compute_identity_id, computer_class
	) values (
		v_computer_id, p_profile_id, p_client_computer_id, 'Company Computer',
		v_identity.template_key, v_identity.template_version, '["agent_turn"]'::jsonb,
		v_policy, null, 'active', p_authorized_by_user_id,
		p_compute_identity_id, 'company_computer'
	) returning * into v_computer;
	return jsonb_build_object(
		'logical_computer_id', v_computer.id,
		'profile_id', v_computer.profile_id,
		'compute_identity_id', v_computer.compute_identity_id,
		'worker_class', v_computer.computer_class,
		'runtime', 'company-path-v1',
		'provider_adapter', 'lxd',
		'policy_sha256', public.qorpera_compute_policy_sha256(v_policy),
		'status', v_computer.status
	);
end
$$;

revoke all on function public.qorpera_register_governed_company_computer(
	uuid, uuid, uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.qorpera_register_governed_company_computer(
	uuid, uuid, uuid, text, text, text, uuid
) to service_role;

create function public.qorpera_describe_governed_company_computer(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_binding public.qorpera_governed_company_computers%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
begin
	if auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Governed company computer is unavailable' using errcode = '42501';
	end if;
	select binding.* into v_binding
	from public.qorpera_governed_company_computers as binding
	where binding.profile_id = p_profile_id;
	if not found then
		raise exception 'Governed company computer is unavailable' using errcode = '55000';
	end if;
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = v_binding.logical_computer_id;
	if not found or not public.qorpera_governed_company_computer_matches(v_computer) then
		raise exception 'Governed company computer is unavailable' using errcode = '55000';
	end if;
	return jsonb_build_object(
		'logical_computer_id', v_computer.id,
		'profile_id', v_computer.profile_id,
		'display_name', v_computer.display_name,
		'compute_identity_id', v_computer.compute_identity_id,
		'worker_class', v_computer.computer_class,
		'template_key', v_computer.template_key,
		'template_version', v_computer.template_version,
		'capabilities', v_computer.capabilities,
		'policy_sha256', v_binding.policy_sha256,
		'runtime', v_binding.runtime,
		'execution_boundary', v_binding.execution_boundary,
		'company_file_access', v_binding.company_file_access,
		'canonical_mount', v_binding.canonical_mount,
		'lifecycle', v_binding.lifecycle,
		'recovery_mode', v_binding.recovery_mode,
		'provider_adapter', v_binding.provider_adapter,
		'status', v_computer.status
	);
end
$$;

revoke all on function public.qorpera_describe_governed_company_computer(uuid)
	from public, anon;
grant execute on function public.qorpera_describe_governed_company_computer(uuid)
	to authenticated;

create function public.qorpera_enforce_governed_company_computer_work()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_computer public.qorpera_logical_computers%rowtype;
begin
	if new.worker_class <> 'company_computer' then return new; end if;
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = new.logical_computer_id
		and computer.profile_id = new.profile_id
		and computer.compute_identity_id = new.compute_identity_id
		and computer.status = 'active';
	if not found or not public.qorpera_governed_company_computer_matches(v_computer) then
		raise exception 'Company computer work requires cloud-governed path mediation'
			using errcode = '42501';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_enforce_governed_company_computer_work()
	from public, anon, authenticated, service_role;

create trigger qorpera_governed_company_computer_turn_request
before insert or update on public.qorpera_session_turn_requests
for each row execute function public.qorpera_enforce_governed_company_computer_work();

create trigger qorpera_governed_company_computer_execution_run
before insert or update on public.qorpera_execution_runs
for each row execute function public.qorpera_enforce_governed_company_computer_work();

create function public.qorpera_enforce_governed_company_computer_runner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_computer public.qorpera_logical_computers%rowtype;
	v_binding public.qorpera_governed_company_computers%rowtype;
begin
	if new.worker_class is distinct from 'company_computer' then return new; end if;
	if tg_op = 'UPDATE' and old.worker_class = 'company_computer'
		and new.status = 'revoked' then return new; end if;
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = new.logical_computer_id
		and computer.profile_id = new.profile_id
		and computer.compute_identity_id = new.compute_identity_id
		and computer.status = 'active';
	if not found or not public.qorpera_governed_company_computer_matches(v_computer) then
		raise exception 'Company computer runner requires cloud-governed path mediation'
			using errcode = '42501';
	end if;
	select binding.* into v_binding
	from public.qorpera_governed_company_computers as binding
	where binding.logical_computer_id = v_computer.id;
	if not found
		or new.provider_adapter is distinct from v_binding.provider_adapter
		or new.template_key is distinct from v_binding.template_key
		or new.template_version is distinct from v_binding.template_version
		or new.capabilities is distinct from v_binding.capabilities
		or new.compute_policy_sha256 is distinct from v_binding.policy_sha256 then
		raise exception 'Company computer runner requires cloud-governed path mediation'
			using errcode = '42501';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_enforce_governed_company_computer_runner()
	from public, anon, authenticated, service_role;

create trigger qorpera_governed_company_computer_runner
before insert or update on public.qorpera_runners
for each row execute function public.qorpera_enforce_governed_company_computer_runner();

create function public.qorpera_enforce_governed_company_computer_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_runner public.qorpera_runners%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
begin
	select runner.* into strict v_runner
	from public.qorpera_runners as runner where runner.id = new.runner_id;
	if v_runner.worker_class is distinct from 'company_computer' then return new; end if;
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = v_runner.logical_computer_id
		and computer.profile_id = v_runner.profile_id
		and computer.compute_identity_id = v_runner.compute_identity_id
		and computer.status = 'active';
	if not found or not public.qorpera_governed_company_computer_matches(v_computer) then
		raise exception 'Company computer assignment requires cloud-governed path mediation'
			using errcode = '42501';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_enforce_governed_company_computer_assignment()
	from public, anon, authenticated, service_role;

create trigger qorpera_governed_company_computer_assignment
before insert or update on public.qorpera_runner_assignments
for each row execute function public.qorpera_enforce_governed_company_computer_assignment();

-- Do not turn an already running legacy desktop into governed evidence. A
-- later production change must be quiescent and must reconcile any active
-- legacy runner before this migration can be applied.
do $$
begin
	if exists (
		select 1 from public.qorpera_runners as runner
		where runner.worker_class = 'company_computer'
			and runner.status in ('pending', 'active')
	) then
		raise exception 'Active legacy company computer runner requires reconciliation'
			using errcode = '55000';
	end if;
end
$$;
