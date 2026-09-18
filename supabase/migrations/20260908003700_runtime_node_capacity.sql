-- Shared host capacity, distinct from a company's machine ceiling. Enrollment
-- is an explicit operator action. A reservation is neither VM readiness nor
-- measured utilization; stale health never releases its resources.
create table public.qorpera_runtime_nodes (
 id uuid primary key,
 machine_id_sha256 text not null unique check(machine_id_sha256 ~ '^[0-9a-f]{64}$'),
 label text not null check(label ~ '^[a-z][a-z0-9-]{0,62}$'),
 version bigint not null check(version between 1 and 9007199254740991),
 cpu_millis bigint not null check(cpu_millis between 1000 and 1024000),
 memory_bytes bigint not null check(memory_bytes between 1048576 and 1125899906842624),
 headroom_cpu_millis bigint not null check(headroom_cpu_millis>=0 and headroom_cpu_millis<cpu_millis),
 headroom_memory_bytes bigint not null check(headroom_memory_bytes>=0 and headroom_memory_bytes<memory_bytes),
 standard_cpu_millis bigint not null check(standard_cpu_millis>0 and standard_cpu_millis<=cpu_millis-headroom_cpu_millis),
 standard_memory_bytes bigint not null check(standard_memory_bytes>0 and standard_memory_bytes<=memory_bytes-headroom_memory_bytes),
 enabled boolean not null,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_runtime_node_policies (
 node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
 version bigint not null,
 policy jsonb not null,
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(node_id,version)
);
create table public.qorpera_runtime_node_providers (
 provider_kind text not null check(provider_kind in ('native','office')),
 provider_id text not null,
 node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
 policy_sha256 text not null check(policy_sha256 ~ '^[0-9a-f]{64}$'),
 cpu_millis bigint not null check(cpu_millis between 1 and 1024000),
 memory_bytes bigint not null check(memory_bytes between 1 and 1125899906842624),
 created_at timestamptz not null default clock_timestamp(),
 primary key(provider_kind,provider_id,policy_sha256),
 check((provider_kind='native' and provider_id ~ '^[a-z][a-z0-9_-]{0,63}$')
  or (provider_kind='office' and provider_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
);
-- Keep immutable receipts for observation identity, and a separate latest row
-- for bounded admission reads. Only operators can access these records; no
-- automatic expiry deletes policy, demand or observation evidence.
create table public.qorpera_runtime_node_observation_receipts (
 node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
 observation_id uuid not null,
 observed_at timestamptz not null check(isfinite(observed_at)),
 received_at timestamptz not null default clock_timestamp(),
 observation jsonb not null,
 primary key(node_id,observation_id)
);
-- Freshness uses the original measurement time, never a replayed delivery.
create table public.qorpera_runtime_node_observations (
 node_id uuid primary key references public.qorpera_runtime_nodes(id) on delete restrict,
 observation_id uuid not null,
 observed_at timestamptz not null check(isfinite(observed_at)),
 received_at timestamptz not null default clock_timestamp(),
 observation jsonb not null
);
create table public.qorpera_runtime_node_demands (
 allocation_id uuid primary key references public.qorpera_runtime_machine_allocations(id) on delete restrict,
 node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
 provider_kind text not null,
 provider_id text not null,
 policy_sha256 text not null,
 cpu_millis bigint not null,
 memory_bytes bigint not null,
 requested_at timestamptz not null default clock_timestamp(),
 last_checked_at timestamptz not null default clock_timestamp(),
 last_refusal text check(last_refusal in ('NODE_DISABLED','NODE_OBSERVATION_UNAVAILABLE','NODE_HARDWARE_CHANGED','NODE_CAPACITY_EXHAUSTED')),
 reserved_at timestamptz,
 released_at timestamptz,
 foreign key(provider_kind,provider_id,policy_sha256) references public.qorpera_runtime_node_providers(provider_kind,provider_id,policy_sha256),
 check(released_at is null or reserved_at is not null)
);
create index qorpera_runtime_node_occupied on public.qorpera_runtime_node_demands(node_id)
 where reserved_at is not null and released_at is null;

create function public.qorpera_configure_runtime_node(p_policy jsonb,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_id uuid; v_cpu bigint; v_memory bigint;
begin
 if auth.role() is distinct from 'service_role' or p_expected_version is null or p_expected_version not between 0 and 9007199254740990
  or jsonb_typeof(p_policy) is distinct from 'object'
  or p_policy-array['schema','nodeId','machineIdSha256','label','cpuMillis','memoryBytes','headroomCpuMillis','headroomMemoryBytes','standardCpuMillis','standardMemoryBytes','enabled']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_policy))<>11
  or p_policy->>'schema' is distinct from 'qorpera.runtime-node-policy/v1'
  or jsonb_typeof(p_policy->'enabled') is distinct from 'boolean' then
  raise exception 'Invalid node policy' using errcode='42501'; end if;
 begin
  v_id:=(p_policy->>'nodeId')::uuid;
  if v_id is null or coalesce(p_policy->>'machineIdSha256','') !~ '^[0-9a-f]{64}$'
   or coalesce(p_policy->>'label','') !~ '^[a-z][a-z0-9-]{0,62}$' then raise check_violation; end if;
  if exists(select 1 from unnest(array['cpuMillis','memoryBytes','headroomCpuMillis','headroomMemoryBytes','standardCpuMillis','standardMemoryBytes']) k
   where jsonb_typeof(p_policy->k) is distinct from 'number' or p_policy->>k !~ '^(0|[1-9][0-9]*)$') then raise check_violation; end if;
 exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node policy' using errcode='42501'; end;
 -- Serialize first registration as well as later edits; no company lock is
 -- taken from this node-only configuration path.
 perform pg_advisory_xact_lock(hashtextextended('qorpera.runtime-node:'||v_id::text,0));
 select * into v_node from public.qorpera_runtime_nodes where id=v_id for update;
 if (found and v_node.version<>p_expected_version) or (not found and p_expected_version<>0) then
  raise exception 'Node policy version changed' using errcode='40001'; end if;
 if v_node.id is not null and v_node.machine_id_sha256<>p_policy->>'machineIdSha256' then
  raise exception 'Node host identity is immutable' using errcode='42501'; end if;
 select coalesce(sum(cpu_millis),0),coalesce(sum(memory_bytes),0) into v_cpu,v_memory
  from public.qorpera_runtime_node_demands where node_id=v_id and reserved_at is not null and released_at is null;
 begin
  if v_cpu>(p_policy->>'cpuMillis')::bigint-(p_policy->>'headroomCpuMillis')::bigint
   or v_memory>(p_policy->>'memoryBytes')::bigint-(p_policy->>'headroomMemoryBytes')::bigint then
   raise exception 'Node policy would discard occupied capacity' using errcode='55000'; end if;
  insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,
   headroom_cpu_millis,headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
  values(v_id,p_policy->>'machineIdSha256',p_policy->>'label',p_expected_version+1,(p_policy->>'cpuMillis')::bigint,
   (p_policy->>'memoryBytes')::bigint,(p_policy->>'headroomCpuMillis')::bigint,(p_policy->>'headroomMemoryBytes')::bigint,
   (p_policy->>'standardCpuMillis')::bigint,(p_policy->>'standardMemoryBytes')::bigint,(p_policy->>'enabled')::boolean)
  on conflict(id) do update set label=excluded.label,version=excluded.version,cpu_millis=excluded.cpu_millis,
   memory_bytes=excluded.memory_bytes,headroom_cpu_millis=excluded.headroom_cpu_millis,headroom_memory_bytes=excluded.headroom_memory_bytes,
   standard_cpu_millis=excluded.standard_cpu_millis,standard_memory_bytes=excluded.standard_memory_bytes,
   enabled=excluded.enabled,updated_at=clock_timestamp() returning * into v_node;
 exception when numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node policy limits' using errcode='42501'; end;
 insert into public.qorpera_runtime_node_policies(node_id,version,policy) values(v_id,v_node.version,p_policy);
 return jsonb_build_object('nodeId',v_id,'version',v_node.version);
end
$$;

create function public.qorpera_enroll_runtime_node_provider(p_node_id uuid,p_machine_id_sha256 text,
 p_provider_kind text,p_provider_id text,p_policy_sha256 text,p_cpu_millis bigint,p_memory_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_provider public.qorpera_runtime_node_providers%rowtype;
begin
 if auth.role() is distinct from 'service_role' or p_node_id is null or p_provider_kind is null or p_provider_id is null
  or p_cpu_millis is null or p_memory_bytes is null or coalesce(p_policy_sha256,'') !~ '^[0-9a-f]{64}$' then
  raise exception 'Invalid node provider' using errcode='42501'; end if;
 select * into v_node from public.qorpera_runtime_nodes where id=p_node_id for update;
 if not found or v_node.machine_id_sha256 is distinct from p_machine_id_sha256 then
  raise exception 'Node host identity differs' using errcode='42501'; end if;
 if p_cpu_millis<1 or p_cpu_millis>v_node.cpu_millis-v_node.headroom_cpu_millis
  or p_memory_bytes<1 or p_memory_bytes>v_node.memory_bytes-v_node.headroom_memory_bytes then
  raise exception 'Provider exceeds node capacity' using errcode='42501'; end if;
 begin
  insert into public.qorpera_runtime_node_providers(provider_kind,provider_id,node_id,policy_sha256,cpu_millis,memory_bytes)
   values(p_provider_kind,p_provider_id,p_node_id,p_policy_sha256,p_cpu_millis,p_memory_bytes)
   on conflict(provider_kind,provider_id,policy_sha256) do nothing;
 exception when check_violation then raise exception 'Invalid node provider' using errcode='42501'; end;
 select * into strict v_provider from public.qorpera_runtime_node_providers
  where provider_kind=p_provider_kind and provider_id=p_provider_id and policy_sha256=p_policy_sha256 for share;
 if v_provider.node_id<>p_node_id or v_provider.policy_sha256<>p_policy_sha256
  or v_provider.cpu_millis<>p_cpu_millis or v_provider.memory_bytes<>p_memory_bytes then
  raise exception 'Node provider binding is immutable' using errcode='42501'; end if;
 return jsonb_build_object('nodeId',p_node_id,'providerKind',p_provider_kind,'providerId',p_provider_id,
  'policySha256',p_policy_sha256,'cpuMillis',p_cpu_millis,'memoryBytes',p_memory_bytes);
end
$$;

create function public.qorpera_observe_runtime_node(p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_previous public.qorpera_runtime_node_observations%rowtype;
 v_receipt public.qorpera_runtime_node_observation_receipts%rowtype;
 v_id uuid; v_observation uuid; v_at timestamptz; v_cpu bigint; v_memory bigint;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_observation) is distinct from 'object'
  or p_observation-array['schema','nodeId','machineIdSha256','observationId','observedAt','cpuMillis','memoryBytes','state']<>'{}'::jsonb
  or (select count(*) from jsonb_object_keys(p_observation))<>8
  or p_observation->>'schema' is distinct from 'qorpera.runtime-node-observation/v1'
  or coalesce(p_observation->>'state','') not in ('ready','unavailable')
  or coalesce(p_observation->>'observedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then
  raise exception 'Invalid node observation' using errcode='42501'; end if;
 begin
  v_id:=(p_observation->>'nodeId')::uuid; v_observation:=(p_observation->>'observationId')::uuid;
  v_at:=(p_observation->>'observedAt')::timestamptz;
  v_cpu:=(p_observation->>'cpuMillis')::bigint; v_memory:=(p_observation->>'memoryBytes')::bigint;
  if v_id is null or v_observation is null or v_at is null or not isfinite(v_at)
   or jsonb_typeof(p_observation->'cpuMillis') is distinct from 'number'
   or jsonb_typeof(p_observation->'memoryBytes') is distinct from 'number'
   or coalesce(p_observation->>'cpuMillis','') !~ '^[1-9][0-9]*$'
   or coalesce(p_observation->>'memoryBytes','') !~ '^[1-9][0-9]*$'
   or v_cpu not between 1 and 1024000 or v_memory not between 1 and 1125899906842624 then raise check_violation; end if;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or check_violation then
  raise exception 'Invalid node observation' using errcode='42501'; end;
 select * into v_node from public.qorpera_runtime_nodes where id=v_id for update;
 if not found or v_node.machine_id_sha256 is distinct from p_observation->>'machineIdSha256' then
  raise exception 'Node host identity differs' using errcode='42501'; end if;
 select * into v_receipt from public.qorpera_runtime_node_observation_receipts where node_id=v_id and observation_id=v_observation;
 if found then
  if v_receipt.observation<>p_observation then raise exception 'Node observation identity changed' using errcode='42501'; end if;
  return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_receipt.observed_at);
 end if;
 if v_at>clock_timestamp()+interval '2 seconds' or v_at<clock_timestamp()-interval '60 seconds' then
  raise exception 'Node observation is not current' using errcode='42501'; end if;
 select * into v_previous from public.qorpera_runtime_node_observations where node_id=v_id;
 if v_previous.node_id is not null and v_at<=v_previous.observed_at then
  raise exception 'Node observation arrived out of order' using errcode='40001'; end if;
 insert into public.qorpera_runtime_node_observation_receipts(node_id,observation_id,observed_at,observation)
  values(v_id,v_observation,v_at,p_observation);
 insert into public.qorpera_runtime_node_observations(node_id,observation_id,observed_at,observation)
  values(v_id,v_observation,v_at,p_observation) on conflict(node_id) do update set observation_id=excluded.observation_id,
   observed_at=excluded.observed_at,observation=excluded.observation,received_at=clock_timestamp();
 return jsonb_build_object('nodeId',v_id,'observationId',v_observation,'observedAt',v_at);
end
$$;

-- Lock order: existing profile fence -> company allocation -> node -> demand.
-- Node-only policy/observation functions never acquire a profile lock.
create function public.qorpera_reserve_runtime_node_machine(p_allocation_id uuid,p_provider_kind text,p_provider_id text,
 p_policy_sha256 text,p_instance_sha256 text,p_machine_id_sha256 text,p_cpu_millis bigint,p_memory_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_allocation public.qorpera_runtime_machine_allocations%rowtype; v_provider public.qorpera_runtime_node_providers%rowtype;
 v_node public.qorpera_runtime_nodes%rowtype; v_demand public.qorpera_runtime_node_demands%rowtype;
 v_observation public.qorpera_runtime_node_observations%rowtype; v_profile uuid; v_reason text;
 v_cpu bigint; v_memory bigint; v_valid bigint;
begin
 if auth.role() is distinct from 'service_role' or p_allocation_id is null or p_provider_kind is null
  or p_provider_kind not in ('native','office') or p_provider_id is null then
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

-- Reuse the existing provider-only, exact physical deletion acknowledgement.
-- A stop, job completion, failed observation or TTL never invokes this release.
create function public.qorpera_release_runtime_node_machine()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_node uuid;
begin
 if old.released_at is null and new.released_at is not null then
  select node_id into v_node from public.qorpera_runtime_node_demands where allocation_id=new.id;
  if found then
   perform 1 from public.qorpera_runtime_nodes where id=v_node for update;
   update public.qorpera_runtime_node_demands set released_at=new.released_at where allocation_id=new.id and reserved_at is not null;
  end if;
 end if;
 return new;
end
$$;
create trigger qorpera_release_runtime_node_machine after update of released_at on public.qorpera_runtime_machine_allocations
 for each row execute function public.qorpera_release_runtime_node_machine();

create function public.qorpera_runtime_node_capacity(p_node_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_observation public.qorpera_runtime_node_observations%rowtype;
 v_cpu bigint; v_memory bigint; v_allocated bigint; v_pending bigint; v_companies bigint; v_eligible boolean; v_slots bigint;
begin
 if auth.role() is distinct from 'service_role' or p_node_id is null then raise exception 'Operator authority required' using errcode='42501'; end if;
 select * into v_node from public.qorpera_runtime_nodes where id=p_node_id for share;
 if not found then return '{"schema":"qorpera.runtime-node-capacity/v1","state":"unconfigured","admissibleSlots":0,"overflow":"unavailable"}'::jsonb; end if;
 select * into v_observation from public.qorpera_runtime_node_observations where node_id=p_node_id;
 select coalesce(sum(d.cpu_millis),0),coalesce(sum(d.memory_bytes),0),count(*),count(distinct a.profile_id)
  into v_cpu,v_memory,v_allocated,v_companies from public.qorpera_runtime_node_demands d
  join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  where d.node_id=p_node_id and d.reserved_at is not null and d.released_at is null;
 select count(*) into v_pending from public.qorpera_runtime_node_demands d
  join public.qorpera_runtime_machine_allocations a on a.id=d.allocation_id
  where d.node_id=p_node_id and d.reserved_at is null and a.released_at is null;
 v_eligible:=v_node.enabled and v_observation.observed_at>clock_timestamp()-interval '60 seconds'
  and v_observation.observed_at<=clock_timestamp()+interval '2 seconds' and v_observation.observation->>'state'='ready'
  and (v_observation.observation->>'cpuMillis')::bigint>=v_node.cpu_millis
  and (v_observation.observation->>'memoryBytes')::bigint>=v_node.memory_bytes;
 v_slots:=greatest(0,least((v_node.cpu_millis-v_node.headroom_cpu_millis-v_cpu)/v_node.standard_cpu_millis,
  (v_node.memory_bytes-v_node.headroom_memory_bytes-v_memory)/v_node.standard_memory_bytes));
 return jsonb_build_object('schema','qorpera.runtime-node-capacity/v1','nodeId',v_node.id,'label',v_node.label,'version',v_node.version,
  'state',case when coalesce(v_eligible,false) then 'eligible' else 'unavailable' end,
  'observedAt',v_observation.observed_at,'asOf',clock_timestamp(),'capacityBasis','configured resources minus headroom and unreleased reservations',
  'allocatedCpuMillis',v_cpu,'allocatedMemoryBytes',v_memory,'allocatedComputers',v_allocated,'allocatedCompanies',v_companies,
  'pendingRequests',v_pending,'standardCpuMillis',v_node.standard_cpu_millis,'standardMemoryBytes',v_node.standard_memory_bytes,
  'admissibleSlots',case when coalesce(v_eligible,false) then v_slots else 0 end,'overflow','unavailable',
  'physicalComputerStates','not supplied by this reservation view','activeUsers',null,'activeUserSource','not observed');
end
$$;

alter table public.qorpera_runtime_nodes enable row level security;
alter table public.qorpera_runtime_node_policies enable row level security;
alter table public.qorpera_runtime_node_providers enable row level security;
alter table public.qorpera_runtime_node_observations enable row level security;
alter table public.qorpera_runtime_node_observation_receipts enable row level security;
alter table public.qorpera_runtime_node_demands enable row level security;
revoke all on public.qorpera_runtime_nodes,public.qorpera_runtime_node_policies,public.qorpera_runtime_node_providers,
 public.qorpera_runtime_node_observations,public.qorpera_runtime_node_observation_receipts,public.qorpera_runtime_node_demands from public,anon,authenticated,service_role;
revoke all on function public.qorpera_configure_runtime_node(jsonb,bigint),
 public.qorpera_enroll_runtime_node_provider(uuid,text,text,text,text,bigint,bigint),public.qorpera_observe_runtime_node(jsonb),
 public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint),public.qorpera_release_runtime_node_machine(),
 public.qorpera_runtime_node_capacity(uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_configure_runtime_node(jsonb,bigint),
 public.qorpera_enroll_runtime_node_provider(uuid,text,text,text,text,bigint,bigint),public.qorpera_observe_runtime_node(jsonb),
 public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint),public.qorpera_runtime_node_capacity(uuid) to service_role;
