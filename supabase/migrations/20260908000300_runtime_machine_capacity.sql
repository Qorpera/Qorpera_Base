-- Capacity is reserved before physical creation and is never freed by a
-- timeout, terminal run, idle screen, suspension, or lost provider response.
create table public.qorpera_company_machine_limits (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete restrict,
	max_machines integer not null check(max_machines between 1 and 64),
	version bigint not null check(version between 1 and 9007199254740991),
	updated_by_user_id uuid not null references auth.users(id) on delete restrict
);
create table public.qorpera_runtime_machine_allocations (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	runner_id uuid unique references public.qorpera_runners(id) on delete restrict,
	office_id uuid references public.qorpera_runtime_offices(id) on delete restrict,
	computer_generation bigint,
	provider_adapter text not null check(provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
	instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$'),
	reserved_at timestamptz not null default clock_timestamp(),
	released_at timestamptz,
	check((run_id is not null and runner_id is not null and office_id is null and computer_generation is null)
		or (run_id is null and runner_id is null and office_id is not null and computer_generation>0)),
	unique(office_id,computer_generation),
	unique(provider_adapter,instance_sha256)
);
create index qorpera_runtime_machine_occupied on public.qorpera_runtime_machine_allocations(profile_id) where released_at is null;
create table public.qorpera_runtime_machine_refusals (
	allocation_id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	used integer not null,
	ceiling integer not null,
	created_at timestamptz not null default clock_timestamp()
);

create function public.qorpera_company_machine_capacity(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Machine capacity access denied' using errcode='42501'; end if;
	return jsonb_build_object('maxMachines',coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=p_profile_id),8),
		'version',coalesce((select version from public.qorpera_company_machine_limits where profile_id=p_profile_id),0),
		'allocatedMachines',(select count(*) from public.qorpera_runtime_machine_allocations where profile_id=p_profile_id and released_at is null));
end
$$;

create function public.qorpera_set_company_machine_limit(p_profile_id uuid,p_max_machines integer,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_version bigint;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_max_machines is null
		or p_max_machines not between 1 and 64 or p_expected_version is null or p_expected_version<0 then
		raise exception 'Invalid machine ceiling' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	perform 1 from public.qorpera_profile_members where profile_id=p_profile_id and user_id=auth.uid() and role in ('owner','admin') for share;
	if not found then raise exception 'Machine ceiling requires founder authority' using errcode='42501'; end if;
	select version into v_version from public.qorpera_company_machine_limits where profile_id=p_profile_id for update;
	if coalesce(v_version,0)<>p_expected_version then raise exception 'Machine ceiling version changed' using errcode='40001'; end if;
	insert into public.qorpera_company_machine_limits(profile_id,max_machines,version,updated_by_user_id)
	values(p_profile_id,p_max_machines,1,auth.uid()) on conflict(profile_id) do update
		set max_machines=excluded.max_machines,version=qorpera_company_machine_limits.version+1,updated_by_user_id=auth.uid();
	return public.qorpera_company_machine_capacity(p_profile_id);
end
$$;

create function public.qorpera_reserve_runtime_machine(p_allocation_id uuid,p_provider_adapter text,p_instance_sha256 text,
	p_run_id uuid default null,p_runner_id uuid default null,p_office_id uuid default null,p_computer_generation bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid; v_job_id uuid; v_limit integer; v_count bigint;
	v_run public.qorpera_execution_runs%rowtype; v_runner public.qorpera_runners%rowtype;
	v_office public.qorpera_runtime_offices%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null
		or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$' or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$'
		or not ((p_run_id is not null and p_runner_id is not null and p_office_id is null and p_computer_generation is null)
			or (p_run_id is null and p_runner_id is null and p_office_id is not null and p_computer_generation is not null and p_computer_generation>0)) then
		raise exception 'Invalid machine reservation' using errcode='42501'; end if;
	if p_run_id is not null then
		select profile_id,job_id into strict v_profile,v_job_id from public.qorpera_execution_runs where id=p_run_id;
		-- Existing native admission uses job -> profile -> run/runner locks.
		perform 1 from public.qorpera_runner_jobs where id=v_job_id for update;
	else
		select profile_id into strict v_profile from public.qorpera_runtime_offices where id=p_office_id;
	end if;
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	if public.qorpera_company_execution_paused(v_profile) then
		return '{"state":"refused","reason":"COMPANY_PAUSED"}'::jsonb; end if;
	if p_run_id is not null then
		select * into strict v_run from public.qorpera_execution_runs where id=p_run_id for share;
		select * into v_runner from public.qorpera_runners where id=p_runner_id for share;
		if not found or v_runner.profile_id<>v_profile or v_runner.client_runner_id<>p_allocation_id
			or v_runner.provider_adapter is distinct from p_provider_adapter or v_runner.status='revoked'
			or v_runner.compute_identity_id is distinct from v_run.compute_identity_id
			or v_runner.logical_computer_id is distinct from v_run.logical_computer_id
			or not public.qorpera_execution_compute_available(v_run) or not public.qorpera_execution_sponsor_available(v_run)
			or not exists(select 1 from public.qorpera_runner_jobs where id=v_job_id and status in ('queued','leased','running')
				and (status='queued' or runner_id=p_runner_id)) then
			raise exception 'Machine execution authority unavailable' using errcode='42501'; end if;
	else
		select * into strict v_office from public.qorpera_runtime_offices where id=p_office_id for update;
		if v_office.generation<>p_computer_generation or v_office.state not in ('provisioning','active','recovering')
			or p_provider_adapter<>'lxd' or not exists(select 1 from public.qorpera_company_files
				where environment_id=v_office.environment_id and profile_id=v_profile and state='ready' and path_gateway_version=1)
			or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=v_office.logical_computer_id
				and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
			raise exception 'Office machine authority unavailable' using errcode='42501'; end if;
	end if;
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
	if found then
		if v_allocation.profile_id<>v_profile or v_allocation.run_id is distinct from p_run_id
			or v_allocation.runner_id is distinct from p_runner_id or v_allocation.office_id is distinct from p_office_id
			or v_allocation.computer_generation is distinct from p_computer_generation or v_allocation.provider_adapter<>p_provider_adapter
			or v_allocation.instance_sha256<>p_instance_sha256 or v_allocation.released_at is not null then
			raise exception 'Machine reservation cannot be rebound or revived' using errcode='42501'; end if;
	else
		select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_profile),8) into v_limit;
		select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_profile and released_at is null;
		if v_count>=v_limit then
			-- This committed refusal is distinct from an ambiguous transport failure.
			insert into public.qorpera_runtime_machine_refusals(allocation_id,profile_id,used,ceiling)
			values(p_allocation_id,v_profile,v_count,v_limit) on conflict(allocation_id) do nothing;
			if found then
				insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
				select v_profile,user_id,'company_ceiling_tripped',jsonb_build_object('schema','qorpera.member-notification.machine-capacity/v1',
					'dimension','machines','used',v_count,'ceiling',v_limit,'allocationId',p_allocation_id),'machines:'||p_allocation_id::text
				from public.qorpera_profile_members where profile_id=v_profile and role in ('owner','admin')
				on conflict(profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
			end if;
			return jsonb_build_object('state','refused','reason','MACHINE_CAPACITY_EXHAUSTED');
		end if;
		insert into public.qorpera_runtime_machine_allocations(id,profile_id,run_id,runner_id,office_id,computer_generation,provider_adapter,instance_sha256)
		values(p_allocation_id,v_profile,p_run_id,p_runner_id,p_office_id,p_computer_generation,p_provider_adapter,p_instance_sha256);
	end if;
	if p_run_id is not null and v_run.deadline_at<=clock_timestamp() then
		raise exception 'Machine execution deadline expired' using errcode='42501'; end if;
	return jsonb_build_object('state','reserved','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256);
end
$$;

-- Provider-only physical deletion proof. The provider must confirm absence of
-- this exact journaled VM after all pending create/start operations settle.
create function public.qorpera_release_runtime_machine(p_allocation_id uuid,p_provider_adapter text,p_instance_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_allocation_id is null
		or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$' or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Machine supervisor authority required' using errcode='42501'; end if;
	select profile_id into v_profile from public.qorpera_runtime_machine_allocations where id=p_allocation_id;
	if found then
		perform public.qorpera_lock_profile_gc_fence(v_profile);
		select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
		if v_allocation.provider_adapter<>p_provider_adapter or v_allocation.instance_sha256<>p_instance_sha256 then
			raise exception 'Machine deletion proof differs' using errcode='42501'; end if;
		update public.qorpera_runtime_machine_allocations set released_at=coalesce(released_at,clock_timestamp()) where id=p_allocation_id;
	end if;
	return jsonb_build_object('state','released','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256);
end
$$;

alter table public.qorpera_company_machine_limits enable row level security;
alter table public.qorpera_runtime_machine_allocations enable row level security;
alter table public.qorpera_runtime_machine_refusals enable row level security;
revoke all on public.qorpera_company_machine_limits,public.qorpera_runtime_machine_allocations,public.qorpera_runtime_machine_refusals from public,anon,authenticated,service_role;
revoke all on function public.qorpera_company_machine_capacity(uuid),public.qorpera_set_company_machine_limit(uuid,integer,bigint),
	public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint),public.qorpera_release_runtime_machine(uuid,text,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_company_machine_capacity(uuid),public.qorpera_set_company_machine_limit(uuid,integer,bigint) to authenticated;
grant execute on function public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint),public.qorpera_release_runtime_machine(uuid,text,text) to service_role;
