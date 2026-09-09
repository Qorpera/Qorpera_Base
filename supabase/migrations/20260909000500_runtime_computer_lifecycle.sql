-- Operator-only projection of existing custody records. Database receipt times
-- are not exact VM transition times. This query never admits work or releases
-- capacity; physical sample-held history stays a separate, explicitly estimated
-- component. No new export dependency is introduced into product operations.
create index qorpera_office_activation_lifecycle_history
 on public.qorpera_runtime_office_activations(allocation_id,activated_at,activation_id);
create index qorpera_office_transition_lifecycle_history
 on public.qorpera_runtime_office_lifecycle_transitions(allocation_id,requested_at,id);

create function public.qorpera_runtime_computer_lifecycle(p_allocation_id uuid,p_from timestamptz,p_until timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a public.qorpera_runtime_machine_allocations%rowtype;
 d public.qorpera_runtime_node_demands%rowtype;
 o public.qorpera_runtime_offices%rowtype;
 v_events jsonb; v_count bigint; v_physical jsonb; v_result jsonb;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Computer lifecycle requires operator authority' using errcode='42501'; end if;
 if p_allocation_id is null or p_from is null or p_until is null or not isfinite(p_from) or not isfinite(p_until)
  or p_from>=p_until or p_until-p_from>interval '24 hours' or p_until>statement_timestamp() then
  raise exception 'Computer lifecycle requires a finite past window of at most 24 hours' using errcode='22023'; end if;
 select * into a from public.qorpera_runtime_machine_allocations where id=p_allocation_id;
 if not found then raise exception 'Computer allocation is unavailable' using errcode='22023'; end if;
 select * into d from public.qorpera_runtime_node_demands where allocation_id=a.id;
 select * into o from public.qorpera_runtime_offices where id=a.office_id;

 -- Retain exact source identities, without copying requests, challenges,
 -- member identities, credentials or private browser metadata. An action is
 -- the recorded request category, never an inferred reason for physical exit.
 with activations as materialized (
  select * from public.qorpera_runtime_office_activations where allocation_id=a.id
 ), transitions as materialized (
  select * from public.qorpera_runtime_office_lifecycle_transitions where allocation_id=a.id
 ), events as (
  select 'company_allocation'::text layer,'reserved'::text event,a.reserved_at at,a.id source_id,
   'machine_allocation'::text source,'COMPANY_CAPACITY_RESERVED'::text reason,null::text action,
   null::uuid activation_id,null::uuid transition_id,a.computer_generation generation
  union all select 'company_allocation','released',a.released_at,a.id,'machine_allocation',
   'COMPANY_CAPACITY_RELEASED',null,null,null,a.computer_generation
  union all select 'node_allocation','requested',d.requested_at,a.id,'node_demand',
   'NODE_CAPACITY_REQUESTED',null,null,null,a.computer_generation
  union all select 'node_allocation','reserved',d.reserved_at,a.id,'node_demand',
   'NODE_CAPACITY_RESERVED',null,null,null,a.computer_generation
  union all select 'node_allocation','released',d.released_at,a.id,'node_demand',
   'NODE_CAPACITY_RELEASED',null,null,null,a.computer_generation
  union all select 'office_admission','requested',s.created_at,s.id,'office_start_intent',
   'OFFICE_START_REQUESTED',null,null,null,s.computer_generation
   from public.qorpera_runtime_office_start_intents s where s.allocation_id=a.id
  union all select 'office_admission','cancelled',s.cancelled_at,s.id,'office_start_intent',
   'OFFICE_START_CANCELLED',null,null,null,s.computer_generation
   from public.qorpera_runtime_office_start_intents s where s.allocation_id=a.id
  -- ready_at can be refreshed before activation. Only activated_at supplies a
  -- durable admission boundary; it does not claim the instant the VM powered on.
  union all select 'office_service','ready',v.activated_at,v.activation_id,'office_activation',
   'OFFICE_ACTIVATED',null,v.activation_id,null,v.computer_generation from activations v
  union all select 'office_admission','superseded',v.superseded_at,v.activation_id,'office_activation',
   'SUCCESSOR_PREPARED',null,v.activation_id,null,v.computer_generation from activations v
  union all select 'office_admission','closing',t.requested_at,t.id,'office_lifecycle_transition',
   'OFFICE_ADMISSION_REVOKED',t.request->>'action',t.activation_id,t.id,t.computer_generation from transitions t
  union all select 'office_service','stop_acknowledged',s.acknowledged_at,s.transition_id,'office_stop',
   'OFFICE_SERVICE_ABSENCE_CONFIRMED',t.request->>'action',t.activation_id,t.id,t.computer_generation
   from public.qorpera_runtime_office_stops s join transitions t on t.id=s.transition_id
  union all select 'office_admission','successor_prepared',s.prepared_at,s.activation_id,'office_successor',
   'SUCCESSOR_PREPARED',s.request#>>'{predecessor,action}',s.activation_id,s.transition_id,v.computer_generation
   from public.qorpera_runtime_office_successors s join activations v using(activation_id)
  union all select 'vm_control','boot_requested',b.prepared_at,b.boot_intent_id,'office_boot_intent',
   'RETAINED_VM_BOOT_REQUESTED',t.request->>'action',b.activation_id,b.transition_id,t.computer_generation
   from public.qorpera_runtime_office_boot_intents b join transitions t on t.id=b.transition_id
 ), bounded as materialized (
  select * from events where at>=p_from and at<p_until order by at,layer,event,source_id limit 1001
 ) select count(*),coalesce(jsonb_agg(jsonb_build_object(
   'layer',layer,'event',event,'recordedAt',at,'timeBasis','database_recorded',
   'physicalTransitionAt',null,'source',source,'sourceId',source_id,'reason',reason,'action',action,
   'activationId',activation_id,'transitionId',transition_id,'computerGeneration',generation)
   order by at,layer,event,source_id),'[]') into v_count,v_events from bounded;
 if v_count>1000 then raise exception 'Computer lifecycle requires a smaller window' using errcode='54000'; end if;
 if d.allocation_id is not null then
  v_physical:=public.qorpera_runtime_computer_history(a.id,p_from,p_until);
 end if;
 v_result:=jsonb_build_object('schema','qorpera.runtime-computer-lifecycle/v1',
  'allocationId',a.id,'profileId',a.profile_id,'officeId',a.office_id,'logicalComputerId',o.logical_computer_id,
  'environmentId',o.environment_id,'runId',a.run_id,'loginSessionId',a.login_session_id,
  'providerAdapter',a.provider_adapter,'instanceSha256',a.instance_sha256,
  'from',p_from,'until',p_until,'window','half_open','coverage','retained_control_records_and_physical_samples',
  'controlEvents',v_events,'physicalHistory',v_physical,
  'physicalHistoryUnavailableReason',case when d.allocation_id is null then 'NODE_PLACEMENT_NOT_RECORDED' else null end,
  'exactVmTransitionTimesAvailable',false,'missingPhysicalTransitions','unknown',
  'viewerEventsIncluded',false,'queryCreatesAuthority',false);
 if octet_length(v_result::text)>4194304 then
  raise exception 'Computer lifecycle response requires a smaller window' using errcode='54000'; end if;
 return v_result;
end
$$;
revoke all on function public.qorpera_runtime_computer_lifecycle(uuid,timestamptz,timestamptz)
 from public,anon,authenticated,service_role;
grant execute on function public.qorpera_runtime_computer_lifecycle(uuid,timestamptz,timestamptz) to service_role;
