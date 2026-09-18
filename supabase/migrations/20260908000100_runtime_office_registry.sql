-- Step 4 preparation: durable shared-office identity and agent screen leases.
-- No office is activated by this migration. The provider readiness/power gate
-- must attest the guest and governed projection before setting state=active.
-- Native subscription computers keep their existing ephemeral policy.

create table public.qorpera_runtime_offices (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null unique references public.qorpera_company_environments(id) on delete restrict,
	logical_computer_id uuid not null unique references public.qorpera_logical_computers(id)
		on delete restrict deferrable initially deferred,
	client_computer_id uuid not null,
	image_sha256 text not null check (image_sha256 ~ '^[0-9a-f]{64}$'),
	bootstrap_sha256 text not null check (bootstrap_sha256 ~ '^[0-9a-f]{64}$'),
	state text not null default 'provisioning' check (state in ('provisioning','active','maintenance','recovering','retired')),
	generation bigint not null default 1 check (generation between 1 and 9007199254740991),
	revision bigint not null default 1 check (revision between 1 and 9007199254740991),
	max_screens integer not null check (max_screens between 1 and 32),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	unique(profile_id,client_computer_id)
);

create function public.qorpera_runtime_office_policy()
returns jsonb language sql immutable set search_path = '' as $$
	select '{"schema":"qorpera.shared-office-policy/v1","runtime":"shared-office-v1","executionBoundary":"virtual_machine","companyFileAccess":"path_gateway_only","canonicalMount":false,"lifecycle":"persistent_workbench","providerCredentials":false,"providerAdapter":"lxd"}'::jsonb
$$;

create function public.qorpera_runtime_office_matches(p_computer public.qorpera_logical_computers)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists(select 1 from public.qorpera_runtime_offices office
		where office.logical_computer_id=p_computer.id and office.profile_id=p_computer.profile_id
		and office.client_computer_id=p_computer.client_computer_id
		and p_computer.computer_class='company_computer' and p_computer.compute_identity_id is null
		and p_computer.template_key='qorpera-shared-office' and p_computer.template_version='v1'
		and p_computer.capabilities='["company_substrate"]'::jsonb
		and p_computer.policy=public.qorpera_runtime_office_policy()
		and p_computer.encrypted_volume_object_sha256 is null)
$$;

-- Keep the legacy teardown and native mediation checks intact. A shared office
-- is admitted only by its immutable, separately registered workbench binding.
create or replace function public.qorpera_enforce_company_path_computer_interlock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_table_name = 'qorpera_logical_computers' then
		if tg_op = 'UPDATE' and old.computer_class = 'company_computer'
			and (new.computer_class is distinct from old.computer_class
				or new.profile_id is distinct from old.profile_id) then
			raise exception 'Legacy company computer access cannot be cleared by relabelling its binding' using errcode='55000';
		end if;
		if new.computer_class <> 'company_computer' then return new; end if;
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if public.qorpera_governed_company_computer_matches(new)
			or public.qorpera_runtime_office_matches(new)
			or public.qorpera_legacy_company_computer_teardown_matches(new) then return new; end if;
		if exists(select 1 from public.qorpera_company_files where profile_id=new.profile_id and path_gateway_version=1) then
			raise exception 'Governed Company Files require a path-mediated company computer' using errcode='55000';
		end if;
	elsif tg_table_name = 'qorpera_company_files' then
		if new.path_gateway_version is distinct from 1 then return new; end if;
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if exists(select 1 from public.qorpera_logical_computers computer
			where computer.profile_id=new.profile_id and computer.computer_class='company_computer'
			and not public.qorpera_governed_company_computer_matches(computer)
			and not public.qorpera_runtime_office_matches(computer)
			and not public.qorpera_legacy_company_computer_teardown_matches(computer)) then
			raise exception 'Company File cutover requires verified removal of legacy computer access' using errcode='55000';
		end if;
	else
		raise exception 'Invalid Company File interlock target' using errcode='55000';
	end if;
	return new;
end
$$;

create function public.qorpera_guard_runtime_office_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if exists(select 1 from public.qorpera_runtime_offices where logical_computer_id=old.id)
		and (new.id is distinct from old.id or not public.qorpera_runtime_office_matches(new)) then
		raise exception 'Shared office binding is immutable' using errcode='42501';
	end if;
	return new;
end
$$;
create trigger qorpera_guard_runtime_office_binding before update on public.qorpera_logical_computers
for each row execute function public.qorpera_guard_runtime_office_binding();

create function public.qorpera_register_runtime_office(
	p_environment_id uuid,p_client_computer_id uuid,p_image_sha256 text,p_bootstrap_sha256 text,p_max_screens integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid;
	v_office public.qorpera_runtime_offices%rowtype;
	v_logical uuid := extensions.gen_random_uuid();
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null
		or p_client_computer_id is null or coalesce(p_image_sha256,'') !~ '^[0-9a-f]{64}$'
		or coalesce(p_bootstrap_sha256,'') !~ '^[0-9a-f]{64}$' or p_max_screens is null
		or p_max_screens not between 1 and 32 then
		raise exception 'Invalid shared office registration' using errcode='42501';
	end if;
	select profile_id into strict v_profile from public.qorpera_company_environments where id=p_environment_id;
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	if not exists(select 1 from public.qorpera_profile_members where profile_id=v_profile
		and user_id=auth.uid() and role in ('owner','admin'))
		or not exists(select 1 from public.qorpera_company_files where environment_id=p_environment_id
			and profile_id=v_profile and state='ready' and path_gateway_version=1) then
		raise exception 'Shared office registration is unavailable' using errcode='42501';
	end if;
	select * into v_office from public.qorpera_runtime_offices where environment_id=p_environment_id for update;
	if found then
		if v_office.client_computer_id<>p_client_computer_id or v_office.image_sha256<>p_image_sha256
			or v_office.bootstrap_sha256<>p_bootstrap_sha256 or v_office.max_screens<>p_max_screens then
			raise exception 'Shared office registration differs' using errcode='23505';
		end if;
	else
		if exists(select 1 from public.qorpera_logical_computers computer
			where computer.profile_id=v_profile and computer.computer_class='company_computer'
			and not public.qorpera_governed_company_computer_matches(computer)
			and not public.qorpera_runtime_office_matches(computer)
			and not public.qorpera_legacy_company_computer_teardown_matches(computer)) then
			raise exception 'Legacy office requires verified teardown or adoption' using errcode='55000';
		end if;
		insert into public.qorpera_runtime_offices(profile_id,environment_id,logical_computer_id,client_computer_id,
			image_sha256,bootstrap_sha256,max_screens,created_by_user_id)
		values(v_profile,p_environment_id,v_logical,p_client_computer_id,p_image_sha256,p_bootstrap_sha256,p_max_screens,auth.uid())
		returning * into v_office;
		insert into public.qorpera_logical_computers(id,profile_id,client_computer_id,display_name,template_key,
			template_version,capabilities,policy,computer_class,created_by_user_id)
		values(v_logical,v_profile,p_client_computer_id,'Shared office','qorpera-shared-office','v1',
			'["company_substrate"]',public.qorpera_runtime_office_policy(),'company_computer',auth.uid());
	end if;
	return jsonb_build_object('companyId',v_office.profile_id,'environmentId',v_office.environment_id,
		'companyComputerId',v_office.id,'logicalComputerId',v_office.logical_computer_id,'state',v_office.state);
end
$$;

create table public.qorpera_runtime_office_access (
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	staff_agent_id uuid not null,
	profile_id uuid not null,
	grant_id uuid not null unique default extensions.gen_random_uuid(),
	version bigint not null default 1 check(version between 1 and 9007199254740991),
	state text not null check(state in ('active','revoked')),
	-- The browser profile and private sign-in protocol are added by their own
	-- grant adapter. No browser/profile/desktop access is inferred from this row.
	capabilities jsonb not null check(capabilities='["shell"]'::jsonb),
	configured_by_user_id uuid not null references auth.users(id) on delete restrict,
	primary key(office_id,staff_agent_id),
	foreign key(profile_id,staff_agent_id) references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict
);

create function public.qorpera_set_runtime_office_access(p_office_id uuid,p_staff_agent_id uuid,p_expected_version bigint,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office public.qorpera_runtime_offices%rowtype; v_access public.qorpera_runtime_office_access%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_enabled is null
		or p_expected_version is null or p_expected_version<0 then
		raise exception 'Invalid shared office grant' using errcode='42501';
	end if;
	select * into strict v_office from public.qorpera_runtime_offices where id=p_office_id;
	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);
	select * into strict v_office from public.qorpera_runtime_offices where id=p_office_id for update;
	if v_office.state='retired' or not exists(select 1 from public.qorpera_profile_members
		where profile_id=v_office.profile_id and user_id=auth.uid() and role in ('owner','admin'))
		or not exists(select 1 from public.qorpera_profile_staff where profile_id=v_office.profile_id
			and staff_agent_id=p_staff_agent_id and employment_status='active') then
		raise exception 'Shared office grant is unavailable' using errcode='42501';
	end if;
	select * into v_access from public.qorpera_runtime_office_access
		where office_id=p_office_id and staff_agent_id=p_staff_agent_id for update;
	if coalesce(v_access.version,0)<>p_expected_version then
		raise exception 'Shared office grant version changed' using errcode='40001';
	end if;
	insert into public.qorpera_runtime_office_access(office_id,staff_agent_id,profile_id,state,capabilities,configured_by_user_id)
	values(p_office_id,p_staff_agent_id,v_office.profile_id,case when p_enabled then 'active' else 'revoked' end,'["shell"]',auth.uid())
	on conflict(office_id,staff_agent_id) do update set version=qorpera_runtime_office_access.version+1,
		state=excluded.state,configured_by_user_id=excluded.configured_by_user_id
	returning * into v_access;
	return jsonb_build_object('grantId',v_access.grant_id,'version',v_access.version,'state',v_access.state);
end
$$;

create table public.qorpera_runtime_office_screens (
	office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	id uuid not null unique default extensions.gen_random_uuid(),
	ordinal integer not null check(ordinal between 1 and 32),
	staff_agent_id uuid not null,
	generation bigint not null default 1 check(generation between 1 and 9007199254740991),
	epoch bigint not null default 0 check(epoch between 0 and 9007199254740991),
	power text not null default 'closed' check(power in ('open','closed')),
	lease_id uuid,
	run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	lease_expires_at timestamptz,
	grant_version bigint,
	native_binding jsonb,
	drain_pending boolean not null default false,
	touched_at timestamptz not null default clock_timestamp(),
	primary key(office_id,ordinal),
	unique(office_id,staff_agent_id),
	check((lease_id is null and run_id is null and lease_expires_at is null and grant_version is null and native_binding is null)
		or (lease_id is not null and run_id is not null and lease_expires_at is not null and grant_version>0
			and native_binding is not null and power='open')),
	foreign key(office_id,staff_agent_id) references public.qorpera_runtime_office_access(office_id,staff_agent_id) on delete restrict
);

create function public.qorpera_runtime_office_scope(p_office public.qorpera_runtime_offices)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('companyId',p_office.profile_id,'environmentId',p_office.environment_id,
		'companyComputerId',p_office.id,'logicalComputerId',p_office.logical_computer_id)
$$;

create function public.qorpera_runtime_office_screen_lease(p_office public.qorpera_runtime_offices,p_screen public.qorpera_runtime_office_screens)
returns jsonb language sql volatile set search_path = '' as $$
	select jsonb_build_object('binding',public.qorpera_runtime_office_scope(p_office)||jsonb_build_object(
		'computerGeneration',p_office.generation,'screenId',p_screen.id,'screenOrdinal',p_screen.ordinal,
		'screenGeneration',p_screen.generation,'staffAgentId',p_screen.staff_agent_id),
		'leaseId',p_screen.lease_id,'epoch',p_screen.epoch,'driver',jsonb_build_object(
			'kind','agent','runId',p_screen.run_id,'staffAgentId',p_screen.staff_agent_id),
		'validForMs',least(30000,greatest(0,floor(extract(epoch from(p_screen.lease_expires_at-clock_timestamp()))*1000)::bigint)))
$$;

-- Every operation uses the existing full native binding and job-first locks.
-- An explicit refusal has no screen mutation. A transport error is never a
-- refusal and must never be translated into permission to reacquire.
create function public.qorpera_native_office_screen(
	p_binding jsonb,p_scope jsonb,p_action text,p_lease jsonb default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_authority jsonb;
	v_office public.qorpera_runtime_offices%rowtype;
	v_access public.qorpera_runtime_office_access%rowtype;
	v_screen public.qorpera_runtime_office_screens%rowtype;
	v_staff uuid;
	v_run uuid;
	v_until timestamptz;
	v_ordinal integer;
	v_lease jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_action is null
		or p_action not in ('acquire','renew','check','release') then
		raise exception 'Invalid office screen request' using errcode='42501';
	end if;
	if p_action='release' then
		-- Cleanup remains available after run/grant revocation, with the exact
		-- admitted native binding, screen generation, lease and epoch. It grants
		-- no effect or data access and cannot clear a replacement's lease.
		select * into v_office from public.qorpera_runtime_offices
			where id=(p_scope->>'companyComputerId')::uuid for update;
		if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
			raise exception 'Office cleanup scope differs' using errcode='42501';
		end if;
		select * into v_screen from public.qorpera_runtime_office_screens
			where office_id=v_office.id and id=(p_lease#>>'{binding,screenId}')::uuid for update;
		if found and v_screen.lease_id is not null and v_screen.native_binding=p_binding
			and p_lease-'validForMs'=public.qorpera_runtime_office_screen_lease(v_office,v_screen)-'validForMs' then
			update public.qorpera_runtime_office_screens set lease_id=null,run_id=null,lease_expires_at=null,
				grant_version=null,native_binding=null,epoch=epoch+1,touched_at=clock_timestamp() where id=v_screen.id;
			update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id;
		end if;
		return jsonb_build_object('state','released');
	end if;
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_staff:=(v_authority#>>'{identity,staffAgentId}')::uuid;
	v_run:=(v_authority#>>'{identity,runId}')::uuid;
	-- Capture the authority deadline before the office lock; a lock wait cannot
	-- extend a native run or transform an expired screen into a fresh lease.
	v_until:=clock_timestamp()+((v_authority->>'validForMs')::bigint*interval '1 millisecond');
	select * into v_office from public.qorpera_runtime_offices
		where id=(p_scope->>'companyComputerId')::uuid for update;
	if not found or p_scope is distinct from public.qorpera_runtime_office_scope(v_office)
		or v_office.profile_id::text is distinct from v_authority#>>'{identity,companyId}'
		or v_office.environment_id::text is distinct from v_authority#>>'{identity,environmentId}'
		or v_office.state<>'active' or v_until<=clock_timestamp()
		or not exists(select 1 from public.qorpera_company_files where environment_id=v_office.environment_id
			and profile_id=v_office.profile_id and state='ready' and path_gateway_version=1)
		or not exists(select 1 from public.qorpera_logical_computers computer where computer.id=v_office.logical_computer_id
			and computer.status='active' and public.qorpera_runtime_office_matches(computer)) then
		raise exception 'Office authority unavailable' using errcode='42501';
	end if;
	select * into v_access from public.qorpera_runtime_office_access
		where office_id=v_office.id and staff_agent_id=v_staff and profile_id=v_office.profile_id for share;
	if not found or v_access.state<>'active' then
		raise exception 'Office resource grant unavailable' using errcode='42501';
	end if;
	select * into v_screen from public.qorpera_runtime_office_screens
		where office_id=v_office.id and staff_agent_id=v_staff for update;
	if p_action='acquire' then
		if p_lease is not null then raise exception 'Acquire cannot name an old lease' using errcode='22023'; end if;
		-- Expiry revokes effects but is not proof of a drained guest. Reaping
		-- an abandoned lease belongs to the acknowledged supervisor path.
		if found and (v_screen.drain_pending or v_screen.lease_id is not null) then
			return jsonb_build_object('state','refused','reason','SCREEN_OCCUPIED');
		end if;
		if v_screen.id is null then
			select slot into v_ordinal from generate_series(1,v_office.max_screens) slot
				where not exists(select 1 from public.qorpera_runtime_office_screens where office_id=v_office.id and ordinal=slot)
				order by slot limit 1;
			if v_ordinal is null then return jsonb_build_object('state','refused','reason','SCREEN_CAPACITY_EXHAUSTED'); end if;
			insert into public.qorpera_runtime_office_screens(office_id,ordinal,staff_agent_id)
			values(v_office.id,v_ordinal,v_staff) returning * into v_screen;
		end if;
		update public.qorpera_runtime_office_screens set power='open',
			generation=generation+case when power='closed' then 1 else 0 end,epoch=epoch+1,
			lease_id=extensions.gen_random_uuid(),run_id=v_run,grant_version=v_access.version,native_binding=p_binding,
			lease_expires_at=v_until,touched_at=clock_timestamp()
		where id=v_screen.id returning * into v_screen;
	else
		if v_screen.id is null then raise exception 'Office screen unavailable' using errcode='42501'; end if;
		v_lease:=public.qorpera_runtime_office_screen_lease(v_office,v_screen);
		if p_lease is null or jsonb_typeof(p_lease) is distinct from 'object'
			or p_lease-'validForMs' is distinct from v_lease-'validForMs' then
			raise exception 'Office screen lease changed' using errcode='42501';
		end if;
		if v_screen.run_id is distinct from v_run then raise exception 'Office run changed' using errcode='42501'; end if;
		if v_screen.drain_pending or v_screen.grant_version<>v_access.version
			or v_screen.lease_expires_at<=clock_timestamp() or v_screen.power<>'open'
			or v_screen.native_binding is distinct from p_binding then
			raise exception 'Office screen lease expired' using errcode='42501';
		end if;
		if p_action='renew' then
			update public.qorpera_runtime_office_screens set lease_expires_at=v_until,touched_at=clock_timestamp()
			where id=v_screen.id returning * into v_screen;
		end if;
	end if;
	if p_action<>'check' then update public.qorpera_runtime_offices set revision=revision+1 where id=v_office.id; end if;
	v_lease:=public.qorpera_runtime_office_screen_lease(v_office,v_screen);
	-- Recheck native authority after all waits before releasing a capability.
	v_authority:=public.qorpera_describe_native_tool_authority(p_binding);
	v_lease:=jsonb_set(v_lease,'{validForMs}',to_jsonb(least((v_lease->>'validForMs')::bigint,
		(v_authority->>'validForMs')::bigint)));
	if (v_lease->>'validForMs')::bigint<1 then raise exception 'Office lease expired' using errcode='42501'; end if;
	return jsonb_build_object('state','admitted','lease',v_lease);
end
$$;

alter table public.qorpera_runtime_offices enable row level security;
alter table public.qorpera_runtime_office_access enable row level security;
alter table public.qorpera_runtime_office_screens enable row level security;
revoke all on public.qorpera_runtime_offices,public.qorpera_runtime_office_access,public.qorpera_runtime_office_screens
	from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_office_policy(),public.qorpera_runtime_office_matches(public.qorpera_logical_computers),
	public.qorpera_guard_runtime_office_binding(),public.qorpera_runtime_office_scope(public.qorpera_runtime_offices),
	public.qorpera_runtime_office_screen_lease(public.qorpera_runtime_offices,public.qorpera_runtime_office_screens),
	public.qorpera_register_runtime_office(uuid,uuid,text,text,integer),public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean),
	public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_register_runtime_office(uuid,uuid,text,text,integer),
	public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean) to authenticated;
grant execute on function public.qorpera_native_office_screen(jsonb,jsonb,text,jsonb) to service_role;
