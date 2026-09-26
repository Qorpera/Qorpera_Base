-- Fleet offers describe already staged, host-specific office installations.
-- They never transfer custody of a retained generation. Selection reserves both
-- company and physical-node capacity atomically before either host may create.
create table public.qorpera_runtime_office_fleet_offers (
 office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
 computer_generation bigint not null,
 provider_id uuid not null,
 node_id uuid not null references public.qorpera_runtime_nodes(id) on delete restrict,
 allocation_id uuid not null unique,
 offer jsonb not null,
 ready_at timestamptz not null,
 selected_at timestamptz,
 primary key(office_id,computer_generation,provider_id)
);
alter table public.qorpera_runtime_office_fleet_offers enable row level security;
revoke all on public.qorpera_runtime_office_fleet_offers from public,anon,authenticated,service_role;

create function public.qorpera_runtime_office_fleet_status(p_scope jsonb,p_computer_generation bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_offices%rowtype; i public.qorpera_runtime_office_start_intents%rowtype;
 p public.qorpera_runtime_office_providers%rowtype; f public.qorpera_runtime_office_fleet_offers%rowtype; s text;
begin
 if auth.role() is distinct from 'service_role' or p_computer_generation is null then
  raise exception 'Office fleet authority required' using errcode='42501'; end if;
 select * into o from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
 if not found or p_scope is distinct from public.qorpera_runtime_office_scope(o) or o.generation<>p_computer_generation then
  raise exception 'Office fleet scope differs' using errcode='42501'; end if;
 select * into i from public.qorpera_runtime_office_start_intents where office_id=o.id and computer_generation=o.generation;
 select * into p from public.qorpera_runtime_office_providers where office_id=o.id and computer_generation=o.generation;
 if p.office_id is not null then
  select * into f from public.qorpera_runtime_office_fleet_offers where office_id=o.id and computer_generation=o.generation
   and provider_id=p.provider_id and selected_at is not null and offer->>'policySha256'=p.policy_sha256;
  s:=case when f.office_id is null then 'retained' else 'placed' end;
 elsif i.state='cancelled' or o.state not in ('provisioning','recovering') then s:='held';
 elsif i.id is null then s:='waiting';
 else s:='unplaced'; end if;
 return jsonb_build_object('schema','qorpera.office-fleet-status/v1','scope',p_scope,'computerGeneration',o.generation,
  'intentId',i.id,'state',s,'offer',f.offer);
end $$;

create function public.qorpera_offer_runtime_office_fleet(p_offer jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_offices%rowtype; i public.qorpera_runtime_office_start_intents%rowtype;
 p public.qorpera_runtime_node_providers%rowtype; n public.qorpera_runtime_nodes%rowtype;
 f public.qorpera_runtime_office_fleet_offers%rowtype; generation bigint; provider uuid;
begin
 if auth.role() is distinct from 'service_role' or jsonb_typeof(p_offer) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_offer))<>16
  or p_offer-array['schema','scope','computerGeneration','intentId','providerId','nodeId','policySha256','machineIdSha256',
   'allocationId','instanceSha256','providerBindingSha256','imageSha256','bootstrapSha256','cpuMillis','memoryBytes','serviceConfigSha256']<>'{}'::jsonb
  or p_offer->>'schema' is distinct from 'qorpera.office-fleet-offer/v1' then
  raise exception 'Invalid office fleet offer' using errcode='42501'; end if;
 if exists(select 1 from unnest(array['policySha256','machineIdSha256','instanceSha256','providerBindingSha256',
  'imageSha256','bootstrapSha256','serviceConfigSha256']) k where coalesce(p_offer->>k,'') !~ '^[0-9a-f]{64}$')
  or exists(select 1 from unnest(array['computerGeneration','cpuMillis','memoryBytes']) k
   where jsonb_typeof(p_offer->k) is distinct from 'number' or p_offer->>k !~ '^[1-9][0-9]*$') then
  raise exception 'Invalid office fleet offer identity' using errcode='42501'; end if;
 generation:=(p_offer->>'computerGeneration')::bigint; provider:=(p_offer->>'providerId')::uuid;
 if generation not between 1 and 9007199254740991 or provider is null or (p_offer->>'allocationId')::uuid is null
  or (p_offer->>'intentId')::uuid is null then raise exception 'Invalid office fleet identity' using errcode='42501'; end if;
 select * into o from public.qorpera_runtime_offices where id=(p_offer#>>'{scope,companyComputerId}')::uuid;
 if not found then raise exception 'Office fleet scope differs' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 select * into strict o from public.qorpera_runtime_offices where id=o.id for update;
 if p_offer->'scope' is distinct from public.qorpera_runtime_office_scope(o) or o.generation<>generation
  or o.image_sha256 is distinct from p_offer->>'imageSha256' or o.bootstrap_sha256 is distinct from p_offer->>'bootstrapSha256' then
  raise exception 'Office fleet scope differs' using errcode='42501'; end if;
 select * into i from public.qorpera_runtime_office_start_intents where id=(p_offer->>'intentId')::uuid for update;
 if not found then raise exception 'Office fleet intent unavailable' using errcode='42501'; end if;
 -- A committed selection is reconciled through status, never refreshed/rebound.
 if exists(select 1 from public.qorpera_runtime_office_providers where office_id=o.id and computer_generation=o.generation) then
  return public.qorpera_runtime_office_fleet_status(p_offer->'scope',generation); end if;
 perform public.qorpera_assert_runtime_office_start_source(o,i);
 if i.allocation_id is not null or exists(select 1 from public.qorpera_runtime_machine_allocations
  where office_id=o.id and computer_generation=o.generation) then
  raise exception 'Office fleet cannot adopt an allocation' using errcode='42501'; end if;
 select * into p from public.qorpera_runtime_node_providers where provider_kind='office'
  and provider_id=provider::text and policy_sha256=p_offer->>'policySha256';
 if not found or p.node_id is distinct from (p_offer->>'nodeId')::uuid or p.cpu_millis is distinct from (p_offer->>'cpuMillis')::bigint
  or p.memory_bytes is distinct from (p_offer->>'memoryBytes')::bigint then
  raise exception 'Office fleet node provider differs' using errcode='42501'; end if;
 select * into strict n from public.qorpera_runtime_nodes where id=p.node_id;
 if n.machine_id_sha256 is distinct from p_offer->>'machineIdSha256' then
  raise exception 'Office fleet host differs' using errcode='42501'; end if;
 select * into f from public.qorpera_runtime_office_fleet_offers where office_id=o.id and computer_generation=generation
  and provider_id=provider for update;
 if found and f.offer is distinct from p_offer then
  raise exception 'Office fleet offer cannot be rebound' using errcode='42501'; end if;
 insert into public.qorpera_runtime_office_fleet_offers(office_id,computer_generation,provider_id,node_id,allocation_id,offer,ready_at)
 values(o.id,generation,provider,p.node_id,(p_offer->>'allocationId')::uuid,p_offer,clock_timestamp())
 on conflict(office_id,computer_generation,provider_id) do update set ready_at=excluded.ready_at;
 return public.qorpera_runtime_office_fleet_status(p_offer->'scope',generation);
end $$;

create function public.qorpera_place_runtime_office_fleet(p_scope jsonb,p_computer_generation bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.qorpera_runtime_offices%rowtype; i public.qorpera_runtime_office_start_intents%rowtype;
 f public.qorpera_runtime_office_fleet_offers%rowtype; candidate record; result jsonb; node uuid;
begin
 if auth.role() is distinct from 'service_role' or p_computer_generation is null then
  raise exception 'Office fleet authority required' using errcode='42501'; end if;
 select * into o from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
 if not found then raise exception 'Office fleet scope differs' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(o.profile_id);
 select * into strict o from public.qorpera_runtime_offices where id=o.id for update;
 if p_scope is distinct from public.qorpera_runtime_office_scope(o) or o.generation<>p_computer_generation then
  raise exception 'Office fleet scope differs' using errcode='42501'; end if;
 if exists(select 1 from public.qorpera_runtime_office_providers where office_id=o.id and computer_generation=o.generation) then
  return public.qorpera_runtime_office_fleet_status(p_scope,p_computer_generation); end if;
 select * into i from public.qorpera_runtime_office_start_intents where office_id=o.id and computer_generation=o.generation for update;
 if not found or i.state='cancelled' or o.state not in ('provisioning','recovering') then
  return public.qorpera_runtime_office_fleet_status(p_scope,p_computer_generation); end if;
 perform public.qorpera_assert_runtime_office_start_source(o,i);
 if i.allocation_id is not null or exists(select 1 from public.qorpera_runtime_machine_allocations
  where office_id=o.id and computer_generation=o.generation) then
  raise exception 'Office fleet cannot adopt an allocation' using errcode='42501'; end if;
 -- Deterministic node locks serialize concurrent placements with every existing
 -- node reservation. No provider may commit a binding on the strength of a stale rank.
 for node in select distinct node_id from public.qorpera_runtime_office_fleet_offers
  where office_id=o.id and computer_generation=o.generation order by node_id loop
  perform 1 from public.qorpera_runtime_nodes where id=node for update;
 end loop;
 for candidate in
  select offers.*,rank.value as ranking from public.qorpera_runtime_office_fleet_offers offers
  join public.qorpera_runtime_node_providers p on p.provider_kind='office' and p.provider_id=offers.provider_id::text
   and p.policy_sha256=offers.offer->>'policySha256' and p.node_id=offers.node_id
  join public.qorpera_runtime_nodes n on n.id=offers.node_id
  join lateral jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('office')) rank(value)
   on rank.value->>'providerId'=offers.provider_id::text and (rank.value->>'nodeId')::uuid=offers.node_id
  where offers.office_id=o.id and offers.computer_generation=o.generation and offers.offer->>'intentId'=i.id::text
   and offers.ready_at>clock_timestamp()-interval '60 seconds' and (rank.value->>'eligible')::boolean
   and p.cpu_millis=(offers.offer->>'cpuMillis')::bigint and p.memory_bytes=(offers.offer->>'memoryBytes')::bigint
   and n.machine_id_sha256=offers.offer->>'machineIdSha256'
   -- Exact enrolled policy size, not the chooser's maximum historical size.
   and (rank.value->>'allocatedCpuMillis')::bigint+p.cpu_millis<=n.cpu_millis-n.headroom_cpu_millis
   and (rank.value->>'allocatedMemoryBytes')::bigint+p.memory_bytes<=n.memory_bytes-n.headroom_memory_bytes
  order by (rank.value->>'freeSlots')::bigint desc,(rank.value->>'allocatedCpuMillis')::bigint,
   (rank.value->>'allocatedMemoryBytes')::bigint,offers.node_id,offers.provider_id
 loop
  -- A final admission refusal rolls back enrollment, intent and allocation as
  -- one subtransaction. Another candidate may then be tried without ghost demand.
  begin
   perform public.qorpera_set_runtime_office_provider(p_scope,o.generation,candidate.provider_id,candidate.offer->>'policySha256',0,true);
   result:=public.qorpera_reserve_runtime_office_start(p_scope,o.generation,i.id,candidate.allocation_id,
    candidate.offer->>'instanceSha256',candidate.offer->>'imageSha256',candidate.offer->>'bootstrapSha256',
    candidate.offer->>'providerBindingSha256',candidate.provider_id,candidate.offer->>'policySha256');
   if result->>'state'='refused' then raise sqlstate 'QOF01'; end if;
   result:=public.qorpera_reserve_runtime_node_machine(candidate.allocation_id,'office',candidate.provider_id::text,
    candidate.offer->>'policySha256',candidate.offer->>'instanceSha256',candidate.offer->>'machineIdSha256',
    (candidate.offer->>'cpuMillis')::bigint,(candidate.offer->>'memoryBytes')::bigint);
   if result->>'state' is distinct from 'reserved' then raise sqlstate 'QOF01'; end if;
   update public.qorpera_runtime_office_fleet_offers set selected_at=clock_timestamp()
    where office_id=o.id and computer_generation=o.generation and provider_id=candidate.provider_id;
   insert into public.qorpera_runtime_node_placements(allocation_id,provider_kind,provider_id,node_id,decision,reason,preferred_node_id,candidates)
   values(candidate.allocation_id,'office',candidate.provider_id::text,candidate.node_id,'placed','OFFICE_FLEET_LEAST_LOADED',candidate.node_id,
    public.qorpera_runtime_node_placement_candidates('office'));
   return public.qorpera_runtime_office_fleet_status(p_scope,p_computer_generation);
  exception when sqlstate 'QOF01' then null;
  end;
 end loop;
 return public.qorpera_runtime_office_fleet_status(p_scope,p_computer_generation);
end $$;

revoke all on function public.qorpera_runtime_office_fleet_status(jsonb,bigint),
 public.qorpera_offer_runtime_office_fleet(jsonb),public.qorpera_place_runtime_office_fleet(jsonb,bigint)
 from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_office_fleet_status(jsonb,bigint),
 public.qorpera_offer_runtime_office_fleet(jsonb),public.qorpera_place_runtime_office_fleet(jsonb,bigint) to service_role;
