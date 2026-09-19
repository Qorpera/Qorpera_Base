-- A SQL journal permits stop-only cleanup when the NAS journal is unavailable.
-- Any intent permanently fences ordinary execution pending a separate reviewed
-- recovery protocol. It does not release capacity or establish a storage fence.
create table public.qorpera_coding_emergency_stops (
 id uuid primary key default extensions.gen_random_uuid(),
 worker_id uuid not null unique references public.qorpera_coding_workers(id) on delete restrict,
 request_id uuid not null references public.qorpera_coding_requests(id) on delete restrict,
 allocation_id uuid not null,
 instance_sha256 text not null check(instance_sha256 ~ '^[0-9a-f]{64}$'),
 claim_id uuid not null,
 operation_id uuid,
 state text not null check(state in ('dispatching','accepted','stopped','recovery-required')),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check(state not in ('accepted','stopped') or operation_id is not null)
);
alter table public.qorpera_coding_emergency_stops enable row level security;
revoke all on public.qorpera_coding_emergency_stops from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_describe_coding_cleanup(p_request_id uuid,p_lease_token uuid,p_owner text,p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
 plan public.qorpera_coding_vm_plans%rowtype; a public.qorpera_runtime_machine_allocations%rowtype; node jsonb;
begin
 if auth.role() is distinct from 'service_role' or p_lease_token is null or p_owner is null
  or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'Coding cleanup custody required' using errcode='42501'; end if;
 select * into q from public.qorpera_coding_requests where id=p_request_id;
 select * into w from public.qorpera_coding_workers where id=q.worker_id;
 if w.id is null then raise exception 'Coding cleanup custody unavailable' using errcode='42501'; end if;
 perform public.qorpera_lock_profile_gc_fence(w.company_id);
 select * into strict w from public.qorpera_coding_workers where id=w.id for update;
 select * into strict q from public.qorpera_coding_requests where id=p_request_id for update;
 if q.lease_token is distinct from p_lease_token or q.lease_owner is distinct from p_owner then
  raise exception 'Coding cleanup request custody differs' using errcode='42501'; end if;
 if exists(select 1 from public.qorpera_coding_requests newer where newer.worker_id=w.id and newer.id<>q.id
  and newer.created_at>q.created_at and newer.kind<>'cancel' and newer.status='leased' and newer.lease_until>clock_timestamp()) then
  raise exception 'Coding cleanup custody superseded by an active turn' using errcode='42501'; end if;
 if w.vm_id is null then
  -- This is proof that no repository VM admission or physical intent was ever
  -- persisted, not a missing-instance observation. Only a current cancellation
  -- may close that pre-provision lifecycle without issuing a physical stop.
  if q.kind<>'cancel' or q.status<>'leased' or q.lease_until is null or q.lease_until<=clock_timestamp()
   or exists(select 1 from public.qorpera_coding_vm_plans where worker_id=w.id)
   or exists(select 1 from public.qorpera_runtime_machine_allocations where coding_worker_id=w.id)
   or exists(select 1 from public.qorpera_coding_storage_volumes where worker_id=w.id)
   or exists(select 1 from public.qorpera_coding_emergency_stops where worker_id=w.id) then
   raise exception 'Coding cleanup absence unconfirmed' using errcode='42501'; end if;
  perform 1 from public.qorpera_coding_executors where environment_id=w.environment_id and owner=p_owner and enabled for share;
  if not found or q.lease_until<=clock_timestamp() then raise exception 'Coding cancellation custody expired' using errcode='42501'; end if;
  return jsonb_build_object('schema','qorpera.coding-cleanup-absent/v1','requestId',q.id,'workerId',w.id,'allocationId',null);
 end if;
 select * into plan from public.qorpera_coding_vm_plans where worker_id=w.id for share;
 select * into a from public.qorpera_runtime_machine_allocations where id=w.vm_id for share;
 if plan.worker_id is null or plan.allocation_id is distinct from w.vm_id or a.id is null
  or a.coding_worker_id is distinct from w.id or a.profile_id<>w.company_id or a.runner_id is not null
  or a.instance_sha256<>plan.instance_sha256 or a.released_at is not null then
  raise exception 'Coding cleanup allocation custody differs' using errcode='42501'; end if;
 select jsonb_build_object('nodeId',n.id,'nodeVersion',n.version) into node
  from public.qorpera_runtime_node_demands d join public.qorpera_runtime_nodes n on n.id=d.node_id
  where d.allocation_id=a.id and d.provider_kind='coding' and d.provider_id=a.provider_adapter
   and d.policy_sha256=plan.binding->>'providerPolicySha256' and d.released_at is null and n.machine_id_sha256=p_machine_id_sha256;
 if node is null then raise exception 'Coding cleanup node custody differs' using errcode='42501'; end if;
 return jsonb_build_object('schema','qorpera.coding-cleanup/v1','binding',plan.binding,'admission',
  jsonb_build_object('schema','qorpera.coding-vm-admission/v1','workerId',w.id,'allocationId',a.id,
  'instanceSha256',plan.instance_sha256,'intent','stop','validForMs',5000,'nodeId',node->'nodeId','nodeVersion',node->'nodeVersion'));
end $$;

create function public.qorpera_coding_emergency_stop_json(p_stop public.qorpera_coding_emergency_stops,p_dispatch boolean)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('schema','qorpera.coding-emergency-stop/v1','id',p_stop.id,'requestId',p_stop.request_id,'workerId',p_stop.worker_id,
  'allocationId',p_stop.allocation_id,'instanceSha256',p_stop.instance_sha256,'claimId',p_stop.claim_id,
  'operationId',p_stop.operation_id,'state',p_stop.state,'dispatch',p_dispatch)
$$;

create function public.qorpera_claim_coding_emergency_stop(p_request_id uuid,p_lease_token uuid,p_owner text,
 p_machine_id_sha256 text,p_binding_text text,p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; permit jsonb; stop public.qorpera_coding_emergency_stops%rowtype; won boolean;
begin
 descriptor:=public.qorpera_describe_coding_cleanup(p_request_id,p_lease_token,p_owner,p_machine_id_sha256);
 permit:=public.qorpera_authorize_coding_cleanup(p_request_id,p_lease_token,p_owner,p_binding_text,p_machine_id_sha256);
 if p_claim_id is null then raise exception 'Coding emergency claim required' using errcode='22023'; end if;
 insert into public.qorpera_coding_emergency_stops(worker_id,request_id,allocation_id,instance_sha256,claim_id,state)
 values((permit->>'workerId')::uuid,p_request_id,(permit->>'allocationId')::uuid,permit->>'instanceSha256',p_claim_id,'dispatching')
 on conflict(worker_id) do nothing returning * into stop;
 won:=found;
 if not won then
  select * into strict stop from public.qorpera_coding_emergency_stops where worker_id=(permit->>'workerId')::uuid for update;
  if (stop.request_id<>p_request_id and not exists(select 1 from public.qorpera_coding_requests
   where id=p_request_id and worker_id=stop.worker_id and kind='cancel' and status='leased' and lease_until>clock_timestamp()))
   or stop.allocation_id<>(permit->>'allocationId')::uuid or stop.instance_sha256<>permit->>'instanceSha256' then
   raise exception 'Coding emergency custody differs' using errcode='42501'; end if;
 else
  update public.qorpera_coding_workers set state='recovery-required',version=version+1,updated_at=clock_timestamp() where id=stop.worker_id;
 end if;
 return public.qorpera_coding_emergency_stop_json(stop,won);
end $$;

create function public.qorpera_record_coding_emergency_stop(p_request_id uuid,p_lease_token uuid,p_owner text,
 p_machine_id_sha256 text,p_claim_id uuid,p_operation_id uuid,p_state text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; stop public.qorpera_coding_emergency_stops%rowtype;
begin
 descriptor:=public.qorpera_describe_coding_cleanup(p_request_id,p_lease_token,p_owner,p_machine_id_sha256);
 select * into stop from public.qorpera_coding_emergency_stops where worker_id=(descriptor#>>'{admission,workerId}')::uuid for update;
 if stop.id is null or (stop.request_id<>p_request_id and not exists(select 1 from public.qorpera_coding_requests
   where id=p_request_id and worker_id=stop.worker_id and kind='cancel' and status='leased' and lease_until>clock_timestamp()))
  or stop.claim_id is distinct from p_claim_id
  or p_state is null or p_state not in ('accepted','stopped','recovery-required')
  or (stop.operation_id is not null and stop.operation_id is distinct from p_operation_id)
  or (p_state in ('accepted','stopped') and p_operation_id is null)
  or (stop.state='stopped' and p_state<>'stopped')
  or (stop.state='recovery-required' and p_state<>'recovery-required')
  or (p_state='stopped' and stop.state not in ('accepted','stopped')) then
  raise exception 'Coding emergency transition differs' using errcode='42501'; end if;
 update public.qorpera_coding_emergency_stops set state=p_state,operation_id=p_operation_id,updated_at=clock_timestamp()
  where id=stop.id returning * into stop;
 return public.qorpera_coding_emergency_stop_json(stop,false);
end $$;

-- Physical cleanup can increment the worker version. A still-live cancellation
-- reads the current same-worker snapshot before its ordinary CAS completion.
create function public.qorpera_describe_coding_cancellation(p_request_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
begin
 q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
 if q.kind<>'cancel' then raise exception 'Coding cancellation required' using errcode='42501'; end if;
 select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
 return public.qorpera_coding_worker_json(w);
end $$;

create function pg_temp.coding_emergency_patch() returns void language plpgsql as $$
declare target regprocedure:='public.qorpera_coding_locked_request(uuid,uuid)'; definition text; marker text:=E'\treturn q;';
begin
 definition:=pg_get_functiondef(target);
 if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'Coding emergency integration differs'; end if;
 execute replace(definition,marker,E'\tif q.kind<>''cancel'' and exists(select 1 from public.qorpera_coding_emergency_stops where worker_id=w.id) then\n\t\traise exception ''Coding emergency recovery required'' using errcode=''55000''; end if;\n'||marker);
end $$;
select pg_temp.coding_emergency_patch();
revoke all on function public.qorpera_describe_coding_cancellation(uuid,uuid),public.qorpera_describe_coding_cleanup(uuid,uuid,text,text),public.qorpera_coding_emergency_stop_json(public.qorpera_coding_emergency_stops,boolean),
 public.qorpera_claim_coding_emergency_stop(uuid,uuid,text,text,text,uuid),public.qorpera_record_coding_emergency_stop(uuid,uuid,text,text,uuid,uuid,text)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_describe_coding_cancellation(uuid,uuid),public.qorpera_describe_coding_cleanup(uuid,uuid,text,text),
 public.qorpera_claim_coding_emergency_stop(uuid,uuid,text,text,text,uuid),public.qorpera_record_coding_emergency_stop(uuid,uuid,text,text,uuid,uuid,text) to service_role;
