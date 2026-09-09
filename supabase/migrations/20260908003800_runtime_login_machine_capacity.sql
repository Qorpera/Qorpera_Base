-- A login VM is a real physical allocation, with its own login authority. It
-- cannot borrow a job or office identity. One login attempt owns one VM; later
-- attempts require a new allocation after confirmed physical deletion.
alter table public.qorpera_runtime_machine_allocations
 add column login_session_id uuid unique references public.qorpera_native_provider_login_sessions(id) on delete restrict,
 add column login_compute_identity_id uuid references public.qorpera_member_compute_identities(id) on delete restrict,
 drop constraint qorpera_runtime_machine_allocations_check,
 add constraint qorpera_runtime_machine_allocation_source check(
  (run_id is not null and runner_id is not null and office_id is null and computer_generation is null
   and login_session_id is null and login_compute_identity_id is null)
  or (run_id is null and runner_id is null and office_id is not null and computer_generation is not null and computer_generation>0
   and login_session_id is null and login_compute_identity_id is null)
  or (run_id is null and runner_id is null and office_id is null and computer_generation is null
   and login_session_id is not null and login_compute_identity_id is not null));
create unique index qorpera_runtime_login_identity_occupied
 on public.qorpera_runtime_machine_allocations(login_compute_identity_id)
 where login_compute_identity_id is not null and released_at is null;

-- Retain the immutable request even when the company or identity is occupied.
-- No capability bytes, credential capsules or account contents are recorded.
create table public.qorpera_runtime_login_machine_requests (
 allocation_id uuid primary key,
 login_session_id uuid not null unique references public.qorpera_native_provider_login_sessions(id) on delete restrict,
 profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
 compute_identity_id uuid not null references public.qorpera_member_compute_identities(id) on delete restrict,
 provider_adapter text not null check(provider_adapter ~ '^[a-z][a-z0-9_-]{0,63}$'),
 instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$'),
 requested_at timestamptz not null default clock_timestamp(),
 last_checked_at timestamptz not null default clock_timestamp(),
 released_at timestamptz,
 last_refusal text check(last_refusal in ('COMPANY_PAUSED','MACHINE_CAPACITY_EXHAUSTED','COMPUTE_IDENTITY_OCCUPIED')),
 unique(provider_adapter,instance_sha256)
);
alter table public.qorpera_runtime_login_machine_requests enable row level security;
revoke all on public.qorpera_runtime_login_machine_requests from public,anon,authenticated,service_role;

-- Login completion already takes login -> profile/identity/policy locks.
-- Serialize company allocations using the same profile fence as jobs/offices;
-- neither node-only policies nor native job admission acquire a login lock.
create function public.qorpera_reserve_runtime_login_machine(p_allocation_id uuid,p_provider_adapter text,
 p_instance_sha256 text,p_login_id uuid,p_capability_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 v_login public.qorpera_native_provider_login_sessions%rowtype;
 v_identity public.qorpera_member_compute_identities%rowtype;
 v_request public.qorpera_runtime_login_machine_requests%rowtype;
 v_allocation public.qorpera_runtime_machine_allocations%rowtype;
 v_role text; v_limit integer; v_count bigint; v_reason text;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_login_id is null
  or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$'
  or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$'
  or coalesce(p_capability_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid login machine reservation' using errcode='42501'; end if;
 select * into v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 if not found or v_login.capability_sha256 is distinct from p_capability_sha256 then
  raise exception 'Login machine authority unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 select * into v_identity from public.qorpera_member_compute_identities where id=v_login.compute_identity_id
  and profile_id=v_login.profile_id and status='active' for share;
 if not found then raise exception 'Login machine identity unavailable' using errcode='42501'; end if;
 select role into v_role from public.qorpera_profile_members where profile_id=v_login.profile_id
  and user_id=v_login.requested_by_user_id for share;
 if not found or not ((v_identity.ownership_kind='member' and v_identity.owner_user_id=v_login.requested_by_user_id)
  or (v_identity.ownership_kind<>'member' and v_role in ('owner','admin'))) then
  raise exception 'Login machine membership unavailable' using errcode='42501'; end if;
 perform 1 from public.qorpera_provider_execution_policies where provider=v_login.provider
  and authentication_mode='native_subscription' and native_harness=v_login.native_harness
  and implementation_status='supported' and enablement_status='enabled' for share;
 if not found then raise exception 'Login machine provider unavailable' using errcode='42501'; end if;
 if v_login.status<>'pending' or v_login.expires_at<=clock_timestamp() then
  raise exception 'Login machine session unavailable' using errcode='42501'; end if;
 insert into public.qorpera_runtime_login_machine_requests(allocation_id,login_session_id,profile_id,compute_identity_id,provider_adapter,instance_sha256)
  values(p_allocation_id,p_login_id,v_login.profile_id,v_identity.id,p_provider_adapter,p_instance_sha256)
  on conflict(allocation_id) do nothing;
 select * into strict v_request from public.qorpera_runtime_login_machine_requests where allocation_id=p_allocation_id for update;
 if v_request.login_session_id<>p_login_id or v_request.profile_id<>v_login.profile_id or v_request.compute_identity_id<>v_identity.id
  or v_request.provider_adapter<>p_provider_adapter or v_request.instance_sha256<>p_instance_sha256 or v_request.released_at is not null then
  raise exception 'Login machine request cannot be rebound' using errcode='42501'; end if;
 select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
 if found and (v_allocation.profile_id<>v_login.profile_id or v_allocation.login_session_id is distinct from p_login_id
  or v_allocation.login_compute_identity_id is distinct from v_identity.id or v_allocation.provider_adapter<>p_provider_adapter
  or v_allocation.instance_sha256<>p_instance_sha256 or v_allocation.released_at is not null) then
  raise exception 'Login machine allocation cannot be rebound or revived' using errcode='42501'; end if;
 if public.qorpera_company_execution_paused(v_login.profile_id) then v_reason:='COMPANY_PAUSED';
 elsif exists(select 1 from public.qorpera_runtime_machine_allocations a left join public.qorpera_runners r on r.id=a.runner_id
  where a.profile_id=v_login.profile_id and a.released_at is null and a.id<>p_allocation_id
   and (a.login_compute_identity_id=v_identity.id or r.compute_identity_id=v_identity.id)) then
  v_reason:='COMPUTE_IDENTITY_OCCUPIED';
 elsif v_allocation.id is null then
  select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_login.profile_id),8) into v_limit;
  select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_login.profile_id and released_at is null;
  if v_count>=v_limit then v_reason:='MACHINE_CAPACITY_EXHAUSTED'; end if;
 end if;
 update public.qorpera_runtime_login_machine_requests set last_checked_at=clock_timestamp(),last_refusal=v_reason where allocation_id=p_allocation_id;
 if v_reason is not null then return jsonb_build_object('state','refused','reason',v_reason); end if;
 if v_allocation.id is null then
  insert into public.qorpera_runtime_machine_allocations(id,profile_id,login_session_id,login_compute_identity_id,provider_adapter,instance_sha256)
   values(p_allocation_id,v_login.profile_id,p_login_id,v_identity.id,p_provider_adapter,p_instance_sha256);
 end if;
 if v_login.expires_at<=clock_timestamp() then raise exception 'Login machine session expired' using errcode='42501'; end if;
 return jsonb_build_object('state','reserved','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256);
end
$$;

-- Cleanup remains possible after expiry, cancellation, membership/identity
-- revocation, company pause or provider disable. This describes intent; it is
-- never a proof that the physical VM or its pending operations are gone.
create function public.qorpera_describe_runtime_login_machine(p_allocation_id uuid,p_provider_adapter text,p_instance_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request public.qorpera_runtime_login_machine_requests%rowtype;
 v_login public.qorpera_native_provider_login_sessions%rowtype; v_usable boolean; v_released timestamptz;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null
  or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$' or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Login machine supervisor required' using errcode='42501'; end if;
 select * into v_request from public.qorpera_runtime_login_machine_requests where allocation_id=p_allocation_id;
 if not found or v_request.provider_adapter<>p_provider_adapter or v_request.instance_sha256<>p_instance_sha256 then
  raise exception 'Login machine request differs' using errcode='42501'; end if;
 select * into strict v_login from public.qorpera_native_provider_login_sessions where id=v_request.login_session_id;
 select released_at into v_released from public.qorpera_runtime_machine_allocations where id=p_allocation_id;
 v_released:=coalesce(v_released,v_request.released_at);
 v_usable:=v_login.status='pending' and v_login.expires_at>clock_timestamp()
  and not public.qorpera_company_execution_paused(v_request.profile_id)
  and public.qorpera_provider_execution_enabled(v_login.provider,'native_subscription',v_login.native_harness)
  and exists(select 1 from public.qorpera_member_compute_identities i join public.qorpera_profile_members m
   on m.profile_id=i.profile_id and m.user_id=v_login.requested_by_user_id
   where i.id=v_request.compute_identity_id and i.profile_id=v_request.profile_id and i.status='active'
    and ((i.ownership_kind='member' and i.owner_user_id=m.user_id) or (i.ownership_kind<>'member' and m.role in ('owner','admin'))));
 return jsonb_build_object('allocationId',p_allocation_id,'loginId',v_login.id,'profileId',v_request.profile_id,
  'computeIdentityId',v_request.compute_identity_id,'status',v_login.status,'expiresAt',v_login.expires_at,
  'cleanupRequired',not coalesce(v_usable,false) or v_released is not null,'releasedAt',v_released);
end
$$;
-- Permanent closure also fences a delayed first reservation whose transaction
-- had not committed when physical cleanup finished. Expiry alone never calls
-- this function: the provider must settle all create/start operations and
-- confirm that the exact physical VM is absent before acknowledging deletion.
create function public.qorpera_release_runtime_login_machine(p_allocation_id uuid,p_provider_adapter text,p_instance_sha256 text,p_login_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_login public.qorpera_native_provider_login_sessions%rowtype;
 v_request public.qorpera_runtime_login_machine_requests%rowtype;
 v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_released timestamptz;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_login_id is null
  or coalesce(p_provider_adapter,'') !~ '^[a-z][a-z0-9_-]{0,63}$' or coalesce(p_instance_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Login machine supervisor required' using errcode='42501'; end if;
 select * into strict v_login from public.qorpera_native_provider_login_sessions where id=p_login_id for update;
 perform public.qorpera_lock_profile_gc_fence(v_login.profile_id);
 insert into public.qorpera_runtime_login_machine_requests(allocation_id,login_session_id,profile_id,compute_identity_id,provider_adapter,instance_sha256)
  values(p_allocation_id,p_login_id,v_login.profile_id,v_login.compute_identity_id,p_provider_adapter,p_instance_sha256)
  on conflict(allocation_id) do nothing;
 select * into strict v_request from public.qorpera_runtime_login_machine_requests where allocation_id=p_allocation_id for update;
 if v_request.login_session_id<>p_login_id or v_request.profile_id<>v_login.profile_id or v_request.compute_identity_id<>v_login.compute_identity_id
  or v_request.provider_adapter<>p_provider_adapter or v_request.instance_sha256<>p_instance_sha256 then
  raise exception 'Login machine deletion identity differs' using errcode='42501'; end if;
 select * into v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
 if found and (v_allocation.login_session_id is distinct from p_login_id or v_allocation.profile_id<>v_login.profile_id
  or v_allocation.login_compute_identity_id is distinct from v_login.compute_identity_id or v_allocation.provider_adapter<>p_provider_adapter
  or v_allocation.instance_sha256<>p_instance_sha256) then
  raise exception 'Login machine deletion allocation differs' using errcode='42501'; end if;
 v_released:=coalesce(v_request.released_at,v_allocation.released_at,clock_timestamp());
 update public.qorpera_runtime_machine_allocations set released_at=v_released where id=p_allocation_id and released_at is null;
 update public.qorpera_runtime_login_machine_requests set released_at=v_released where allocation_id=p_allocation_id and released_at is null;
 return jsonb_build_object('state','released','allocationId',p_allocation_id,'instanceSha256',p_instance_sha256);
end
$$;
revoke all on function public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text),
 public.qorpera_describe_runtime_login_machine(uuid,text,text),public.qorpera_release_runtime_login_machine(uuid,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text),
 public.qorpera_describe_runtime_login_machine(uuid,text,text),public.qorpera_release_runtime_login_machine(uuid,text,text,uuid) to service_role;

alter table public.qorpera_runtime_node_providers
 drop constraint qorpera_runtime_node_providers_provider_kind_check,
 drop constraint qorpera_runtime_node_providers_check,
 add constraint qorpera_runtime_node_providers_provider_kind_check check(provider_kind in ('native','office','login')),
 add constraint qorpera_runtime_node_providers_check check((provider_kind in ('native','login') and provider_id ~ '^[a-z][a-z0-9_-]{0,63}$')
  or (provider_kind='office' and provider_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));

-- Preserve the existing office/native gates while extending the real source
-- identities. No admission, health or release function is replaced by a stub.
create or replace function public.qorpera_reserve_runtime_machine(p_allocation_id uuid,p_provider_adapter text,p_instance_sha256 text,
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
	-- The same identity disk cannot be attached to a login and a job VM.
	-- The profile fence serializes both reservation paths.
	if p_run_id is not null and exists(select 1 from public.qorpera_runtime_machine_allocations
		where profile_id=v_profile and login_compute_identity_id=v_run.compute_identity_id and released_at is null) then
		return '{"state":"refused","reason":"COMPUTE_IDENTITY_OCCUPIED"}'::jsonb; end if;
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


create or replace function public.qorpera_reserve_runtime_node_machine(p_allocation_id uuid,p_provider_kind text,p_provider_id text,
 p_policy_sha256 text,p_instance_sha256 text,p_machine_id_sha256 text,p_cpu_millis bigint,p_memory_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_provider public.qorpera_runtime_node_providers%rowtype;
 v_node public.qorpera_runtime_nodes%rowtype; v_demand public.qorpera_runtime_node_demands%rowtype;
 v_observation public.qorpera_runtime_node_observations%rowtype; v_profile uuid; v_reason text;
 v_cpu bigint; v_memory bigint; v_valid bigint;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_provider_kind is null
  or p_provider_kind not in ('native','office','login') or p_provider_id is null then
  raise exception 'Node allocation authority required' using errcode='42501'; end if;
 select profile_id into v_profile from public.qorpera_runtime_machine_allocations where id=p_allocation_id;
 if not found then raise exception 'Company machine reservation required' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(v_profile);
 select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id=p_allocation_id for update;
 if v_allocation.released_at is not null or v_allocation.instance_sha256 is distinct from p_instance_sha256
  or public.qorpera_company_execution_paused(v_profile) then
  raise exception 'Company machine reservation unavailable' using errcode='42501'; end if;
 select * into v_provider from public.qorpera_runtime_node_providers
  where provider_kind=p_provider_kind and provider_id=p_provider_id and policy_sha256=p_policy_sha256;
 if not found then return '{"state":"refused","reason":"NODE_PROVIDER_UNCONFIGURED"}'::jsonb; end if;
 if v_provider.policy_sha256 is distinct from p_policy_sha256
  or v_provider.cpu_millis is distinct from p_cpu_millis or v_provider.memory_bytes is distinct from p_memory_bytes
  or (p_provider_kind='native' and (v_allocation.runner_id is null or v_allocation.provider_adapter<>p_provider_id))
  or (p_provider_kind='login' and (v_allocation.login_session_id is null or v_allocation.provider_adapter<>p_provider_id))
  or (p_provider_kind='office' and (v_allocation.office_id is null or not exists(
   select 1 from public.qorpera_runtime_office_providers where office_id=v_allocation.office_id
    and computer_generation=v_allocation.computer_generation and provider_id::text=p_provider_id and policy_sha256=p_policy_sha256))) then
  raise exception 'Node provider allocation differs' using errcode='42501'; end if;
 select * into strict v_node from public.qorpera_runtime_nodes where id=v_provider.node_id for update;
 if v_node.machine_id_sha256 is distinct from p_machine_id_sha256 then
  raise exception 'Node host identity differs' using errcode='42501'; end if;
 insert into public.qorpera_runtime_node_demands(allocation_id,node_id,provider_kind,provider_id,policy_sha256,cpu_millis,memory_bytes)
  values(p_allocation_id,v_node.id,p_provider_kind,p_provider_id,p_policy_sha256,v_provider.cpu_millis,v_provider.memory_bytes)
  on conflict(allocation_id) do nothing;
 select * into strict v_demand from public.qorpera_runtime_node_demands where allocation_id=p_allocation_id for update;
 if v_demand.node_id<>v_node.id or v_demand.provider_kind<>p_provider_kind or v_demand.provider_id<>p_provider_id
  or v_demand.policy_sha256<>p_policy_sha256 or v_demand.cpu_millis<>v_provider.cpu_millis
  or v_demand.memory_bytes<>v_provider.memory_bytes or v_demand.released_at is not null then
  raise exception 'Node placement cannot be rebound or revived' using errcode='42501'; end if;
 select * into v_observation from public.qorpera_runtime_node_observations where node_id=v_node.id;
 if not v_node.enabled then v_reason:='NODE_DISABLED';
 elsif v_observation.node_id is null or v_observation.observed_at<=clock_timestamp()-interval '60 seconds'
  or v_observation.observed_at>clock_timestamp()+interval '2 seconds' or v_observation.observation->>'state'<>'ready' then
  v_reason:='NODE_OBSERVATION_UNAVAILABLE';
 elsif (v_observation.observation->>'cpuMillis')::bigint<v_node.cpu_millis
  or (v_observation.observation->>'memoryBytes')::bigint<v_node.memory_bytes then v_reason:='NODE_HARDWARE_CHANGED';
 else
  select coalesce(sum(cpu_millis),0),coalesce(sum(memory_bytes),0) into v_cpu,v_memory
   from public.qorpera_runtime_node_demands where node_id=v_node.id and reserved_at is not null and released_at is null;
  if v_demand.reserved_at is null and (v_cpu+v_demand.cpu_millis>v_node.cpu_millis-v_node.headroom_cpu_millis
   or v_memory+v_demand.memory_bytes>v_node.memory_bytes-v_node.headroom_memory_bytes) then v_reason:='NODE_CAPACITY_EXHAUSTED'; end if;
 end if;
 update public.qorpera_runtime_node_demands set last_checked_at=clock_timestamp(),last_refusal=v_reason,
  reserved_at=case when v_reason is null then coalesce(reserved_at,clock_timestamp()) else reserved_at end where allocation_id=p_allocation_id;
 if v_reason is not null then return jsonb_build_object('state','refused','reason',v_reason); end if;
 v_valid:=least(5000,floor(extract(epoch from (v_observation.observed_at+interval '60 seconds'-clock_timestamp()))*1000)::bigint);
 if v_valid<1 then raise exception 'Node observation expired' using errcode='42501'; end if;
 return jsonb_build_object('state','reserved','allocationId',p_allocation_id,'nodeId',v_node.id,'nodeVersion',v_node.version,
  'instanceSha256',p_instance_sha256,'cpuMillis',v_provider.cpu_millis,'memoryBytes',v_provider.memory_bytes,'validForMs',v_valid);
end
$$;
