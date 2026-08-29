-- A retired label alone does not prove that a legacy raw NAS mount, process,
-- or placement binding is gone. Install the immutable physical-teardown
-- attestation before the Company File interlock so a production cutover can:
--
-- 1. retire and physically isolate the old computer;
-- 2. apply through this migration;
-- 3. register the exact teardown proof; and only then
-- 4. apply the fail-closed interlock and governed-computer migration.
--
-- The historical computer row and all dependent audit history remain intact.

create table public.qorpera_legacy_company_computer_teardowns (
	logical_computer_id uuid primary key
		references public.qorpera_logical_computers(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	client_teardown_id uuid not null,
	computer_authority_sha256 text not null check (computer_authority_sha256 ~ '^[0-9a-f]{64}$'),
	legacy_binding_sha256 text not null check (legacy_binding_sha256 ~ '^[0-9a-f]{64}$'),
	physical_teardown_sha256 text not null check (physical_teardown_sha256 ~ '^[0-9a-f]{64}$'),
	process_fence_sha256 text not null check (process_fence_sha256 ~ '^[0-9a-f]{64}$'),
	mount_detach_sha256 text not null check (mount_detach_sha256 ~ '^[0-9a-f]{64}$'),
	authorized_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_teardown_id),
	unique (profile_id, logical_computer_id)
);

alter table public.qorpera_legacy_company_computer_teardowns enable row level security;
revoke all on public.qorpera_legacy_company_computer_teardowns
	from public, anon, authenticated, service_role;

create function public.qorpera_legacy_company_computer_authority_sha256(
	p_computer public.qorpera_logical_computers
)
returns text
language sql
immutable
set search_path = ''
as $$
	select encode(extensions.digest(convert_to(jsonb_build_object(
		'id', p_computer.id,
		'profileId', p_computer.profile_id,
		'clientComputerId', p_computer.client_computer_id,
		'displayName', p_computer.display_name,
		'templateKey', p_computer.template_key,
		'templateVersion', p_computer.template_version,
		'capabilities', p_computer.capabilities,
		'policySha256', public.qorpera_compute_policy_sha256(p_computer.policy),
		'encryptedVolumeObjectSha256', p_computer.encrypted_volume_object_sha256,
		'status', p_computer.status,
		'createdByUserId', p_computer.created_by_user_id,
		'computeIdentityId', p_computer.compute_identity_id,
		'computerClass', p_computer.computer_class
	)::text, 'utf8'), 'sha256'), 'hex')
$$;

revoke all on function public.qorpera_legacy_company_computer_authority_sha256(
	public.qorpera_logical_computers
) from public, anon, authenticated, service_role;

create function public.qorpera_legacy_company_computer_teardown_matches(
	p_computer public.qorpera_logical_computers
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_computer.computer_class = 'company_computer'
		and p_computer.status = 'retired'
		and p_computer.encrypted_volume_object_sha256 is null
		and exists (
			select 1
			from public.qorpera_legacy_company_computer_teardowns as teardown
			where teardown.logical_computer_id = p_computer.id
				and teardown.profile_id = p_computer.profile_id
				and teardown.computer_authority_sha256 =
					public.qorpera_legacy_company_computer_authority_sha256(p_computer)
		)
$$;

revoke all on function public.qorpera_legacy_company_computer_teardown_matches(
	public.qorpera_logical_computers
) from public, anon, authenticated, service_role;

create function public.qorpera_register_legacy_company_computer_teardown(
	p_profile_id uuid,
	p_logical_computer_id uuid,
	p_client_teardown_id uuid,
	p_legacy_binding_sha256 text,
	p_physical_teardown_sha256 text,
	p_process_fence_sha256 text,
	p_mount_detach_sha256 text,
	p_authorized_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_computer public.qorpera_logical_computers%rowtype;
	v_teardown public.qorpera_legacy_company_computer_teardowns%rowtype;
	v_authority_sha256 text;
begin
	if auth.role() is distinct from 'service_role'
		or p_client_teardown_id is null
		or coalesce(p_legacy_binding_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_physical_teardown_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_process_fence_sha256, '') !~ '^[0-9a-f]{64}$'
		or coalesce(p_mount_detach_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Legacy company computer teardown authority is invalid'
			using errcode = '42501';
	end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id
			and member.user_id = p_authorized_by_user_id
			and member.role in ('owner', 'admin')
	) then
		raise exception 'Legacy company computer teardown authority is unavailable'
			using errcode = '42501';
	end if;
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = p_logical_computer_id
		and computer.profile_id = p_profile_id
	for update;
	if not found
		or v_computer.computer_class <> 'company_computer'
		or v_computer.status <> 'retired'
		or v_computer.encrypted_volume_object_sha256 is not null then
		raise exception 'Legacy company computer is not physically teardown-ready'
			using errcode = '55000';
	end if;
	if exists (
		select 1 from public.qorpera_runners as runner
		where runner.logical_computer_id = v_computer.id
			and runner.status in ('pending', 'active')
	) or exists (
		select 1
		from public.qorpera_runner_assignments as assignment
		join public.qorpera_runners as runner on runner.id = assignment.runner_id
		where runner.logical_computer_id = v_computer.id
			and assignment.status in ('offered', 'accepted')
	) or exists (
		select 1
		from public.qorpera_runner_jobs as job
		left join public.qorpera_runners as runner on runner.id = job.runner_id
		left join public.qorpera_execution_runs as run on run.job_id = job.id
		where job.status in ('queued', 'leased')
			and (runner.logical_computer_id = v_computer.id
				or run.logical_computer_id = v_computer.id)
	) or exists (
		select 1 from public.qorpera_session_turn_requests as request
		where request.logical_computer_id = v_computer.id
			and request.status in ('pending_sponsorship', 'queued')
	) then
		raise exception 'Legacy company computer still has addressable work'
			using errcode = '55000';
	end if;
	v_authority_sha256 := public.qorpera_legacy_company_computer_authority_sha256(v_computer);
	select teardown.* into v_teardown
	from public.qorpera_legacy_company_computer_teardowns as teardown
	where teardown.logical_computer_id = v_computer.id
	for update;
	if found then
		if v_teardown.profile_id is distinct from p_profile_id
			or v_teardown.client_teardown_id is distinct from p_client_teardown_id
			or v_teardown.computer_authority_sha256 is distinct from v_authority_sha256
			or v_teardown.legacy_binding_sha256 is distinct from p_legacy_binding_sha256
			or v_teardown.physical_teardown_sha256 is distinct from p_physical_teardown_sha256
			or v_teardown.process_fence_sha256 is distinct from p_process_fence_sha256
			or v_teardown.mount_detach_sha256 is distinct from p_mount_detach_sha256
			or v_teardown.authorized_by_user_id is distinct from p_authorized_by_user_id then
			raise exception 'Legacy company computer has another teardown attestation'
				using errcode = '23505';
		end if;
		return jsonb_build_object(
			'logical_computer_id', v_teardown.logical_computer_id,
			'profile_id', v_teardown.profile_id,
			'computer_authority_sha256', v_teardown.computer_authority_sha256,
			'legacy_binding_sha256', v_teardown.legacy_binding_sha256,
			'physical_teardown_sha256', v_teardown.physical_teardown_sha256,
			'process_fence_sha256', v_teardown.process_fence_sha256,
			'mount_detach_sha256', v_teardown.mount_detach_sha256,
			'created_at', v_teardown.created_at
		);
	end if;
	insert into public.qorpera_legacy_company_computer_teardowns (
		logical_computer_id, profile_id, client_teardown_id,
		computer_authority_sha256, legacy_binding_sha256,
		physical_teardown_sha256, process_fence_sha256, mount_detach_sha256,
		authorized_by_user_id
	) values (
		v_computer.id, v_computer.profile_id, p_client_teardown_id,
		v_authority_sha256, p_legacy_binding_sha256,
		p_physical_teardown_sha256, p_process_fence_sha256, p_mount_detach_sha256,
		p_authorized_by_user_id
	) returning * into v_teardown;
	return jsonb_build_object(
		'logical_computer_id', v_teardown.logical_computer_id,
		'profile_id', v_teardown.profile_id,
		'computer_authority_sha256', v_teardown.computer_authority_sha256,
		'legacy_binding_sha256', v_teardown.legacy_binding_sha256,
		'physical_teardown_sha256', v_teardown.physical_teardown_sha256,
		'process_fence_sha256', v_teardown.process_fence_sha256,
		'mount_detach_sha256', v_teardown.mount_detach_sha256,
		'created_at', v_teardown.created_at
	);
end
$$;

revoke all on function public.qorpera_register_legacy_company_computer_teardown(
	uuid, uuid, uuid, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.qorpera_register_legacy_company_computer_teardown(
	uuid, uuid, uuid, text, text, text, text, uuid
) to service_role;

create function public.qorpera_guard_legacy_company_computer_teardown()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	raise exception 'Legacy company computer teardown evidence is immutable'
		using errcode = '42501';
end
$$;

revoke all on function public.qorpera_guard_legacy_company_computer_teardown()
	from public, anon, authenticated, service_role;

create trigger qorpera_guard_legacy_company_computer_teardown
before update or delete on public.qorpera_legacy_company_computer_teardowns
for each row execute function public.qorpera_guard_legacy_company_computer_teardown();

create function public.qorpera_guard_torn_down_legacy_company_computer()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if exists (
		select 1 from public.qorpera_legacy_company_computer_teardowns as teardown
		where teardown.logical_computer_id = old.id
	) then
		raise exception 'Torn-down legacy company computer history is immutable'
			using errcode = '42501';
	end if;
	return case when tg_op = 'DELETE' then old else new end;
end
$$;

revoke all on function public.qorpera_guard_torn_down_legacy_company_computer()
	from public, anon, authenticated, service_role;

create trigger qorpera_guard_torn_down_legacy_company_computer
before update or delete on public.qorpera_logical_computers
for each row execute function public.qorpera_guard_torn_down_legacy_company_computer();

-- Serialize every core work binding with the same logical-computer row locked
-- by teardown registration. A concurrent insert either commits first and
-- makes attestation fail, or observes the committed tombstone and is denied.
create function public.qorpera_guard_torn_down_legacy_computer_work()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_computer public.qorpera_logical_computers%rowtype;
begin
	select computer.* into v_computer
	from public.qorpera_logical_computers as computer
	where computer.id = new.logical_computer_id
	for share;
	if found and exists (
		select 1 from public.qorpera_legacy_company_computer_teardowns as teardown
		where teardown.logical_computer_id = v_computer.id
	) then
		raise exception 'Torn-down legacy company computer cannot receive work'
			using errcode = '42501';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_guard_torn_down_legacy_computer_work()
	from public, anon, authenticated, service_role;

create trigger qorpera_guard_torn_down_legacy_computer_runner
before insert or update on public.qorpera_runners
for each row execute function public.qorpera_guard_torn_down_legacy_computer_work();

create trigger qorpera_guard_torn_down_legacy_computer_run
before insert or update on public.qorpera_execution_runs
for each row execute function public.qorpera_guard_torn_down_legacy_computer_work();

create trigger qorpera_guard_torn_down_legacy_computer_turn
before insert or update on public.qorpera_session_turn_requests
for each row execute function public.qorpera_guard_torn_down_legacy_computer_work();

create function public.qorpera_guard_torn_down_legacy_computer_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_logical_computer_id uuid;
begin
	select runner.logical_computer_id into v_logical_computer_id
	from public.qorpera_runners as runner
	where runner.id = new.runner_id;
	if found then
		perform 1 from public.qorpera_logical_computers as computer
		where computer.id = v_logical_computer_id
		for share;
		if exists (
			select 1 from public.qorpera_legacy_company_computer_teardowns as teardown
			where teardown.logical_computer_id = v_logical_computer_id
		) then
			raise exception 'Torn-down legacy company computer cannot receive work'
				using errcode = '42501';
		end if;
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_guard_torn_down_legacy_computer_assignment()
	from public, anon, authenticated, service_role;

create trigger qorpera_guard_torn_down_legacy_computer_assignment
before insert or update on public.qorpera_runner_assignments
for each row execute function public.qorpera_guard_torn_down_legacy_computer_assignment();
