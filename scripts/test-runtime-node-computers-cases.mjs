import assert from 'node:assert/strict';

// The caller supplies an actual admitted native allocation and a freshly
// published managed VM observation; physical host/LXD values are fixtures.
export function testRuntimeNodeComputers({nodeId,allocationId,sql,rpc,quote}) {
 const officeId='34000000-0000-4000-8000-000000000088';
 const read=(cursor=null,limit=100)=>rpc('qorpera_runtime_node_computers',[quote(nodeId),cursor?quote(cursor):'null',String(limit)]);
 const machine=()=>read().computers.find(c=>c.allocationId===allocationId);
 assert.equal(machine().physicalState,'running');
 assert.equal(machine().runningWorkState,'with_active_jobs');
 assert.equal(machine().jobActivity.knownActiveJobCount,1);
 const refused=rpc('qorpera_reserve_runtime_node_machine',[quote(officeId),"'office'","'36000000-0000-4000-8000-000000000001'",quote('f'.repeat(64)),quote('b'.repeat(64)),quote('c'.repeat(64)),'2000','2147483648']);
 assert.equal(refused.reason,'NODE_CAPACITY_EXHAUSTED');
 const pending=read().computers.find(c=>c.allocationId===officeId);
 assert.equal(pending.nodeAllocationState,'pending');assert.equal(pending.physicalState,'unknown');
 assert.equal(pending.lastAdmissionRefusal,'NODE_CAPACITY_EXHAUSTED');assert.equal(pending.nodeReservedAt,null);
 const first=read(null,1);assert.equal(first.hasMore,true);assert.equal(first.computers.length,1);
 const last=read(first.nextAllocationId,1);assert.equal(last.hasMore,false);assert.equal(last.nextAllocationId,null);
 assert.deepEqual([...first.computers,...last.computers].map(c=>c.allocationId),read().computers.map(c=>c.allocationId));
 assert.equal(first.snapshotAcrossPages,false);assert.equal(first.cpuUtilization,null);assert.equal(first.freeDiskBytes,null);
 assert.equal(first.humanActivity,null);assert.equal(first.overflow,'unavailable');
 sql(`begin; set local request.jwt.claims='{"role":"service_role"}';
 do $proof$ declare a public.qorpera_runtime_machine_allocations%rowtype; office public.qorpera_runtime_machine_allocations%rowtype;
  j uuid; saved public.qorpera_runner_jobs%rowtype; result jsonb; item jsonb; t timestamptz:=statement_timestamp();
 begin
  select * into strict a from public.qorpera_runtime_machine_allocations where id='${allocationId}';
  select * into strict office from public.qorpera_runtime_machine_allocations where id='${officeId}';
  select job_id into strict j from public.qorpera_execution_runs where id=a.run_id;
  select * into strict saved from public.qorpera_runner_jobs where id=j;
  update public.qorpera_runner_jobs set lease_expires_at=t-interval '1 second' where id=j;
  result:=public.qorpera_runtime_node_computers('${nodeId}');
  select c into item from jsonb_array_elements(result->'computers') c where c->>'allocationId'=a.id::text;
  if item->>'runningWorkState'<>'unknown' or item#>>'{jobActivity,state}'<>'unknown'
   or item#>'{jobActivity,countComplete}'<>'false'::jsonb then raise exception 'Expired job was reported idle'; end if;
  update public.qorpera_runner_jobs set status='queued',lease_expires_at=null,lease_token_sha256=null where id=j;
  result:=public.qorpera_runtime_node_computers('${nodeId}');
  select c into item from jsonb_array_elements(result->'computers') c where c->>'allocationId'=a.id::text;
  if item->>'runningWorkState'<>'without_recorded_active_jobs' or item#>>'{jobActivity,state}'<>'none_recorded'
   or item->>'nodeAllocationState'<>'reserved' or item->'nodeReleasedAt'<>'null'::jsonb then raise exception 'No-job allocation became free'; end if;
  update public.qorpera_runner_jobs set status=saved.status,lease_expires_at=t+interval '5 minutes',lease_token_sha256=saved.lease_token_sha256 where id=j;
  -- Shared screen/run linkage is a rolled-back record fixture, not admission.
  insert into public.qorpera_runtime_office_screens(office_id,ordinal,staff_agent_id)
   select office_id,row_number() over(order by staff_agent_id)::integer,staff_agent_id
    from public.qorpera_runtime_office_access where office_id=office.office_id;
  update public.qorpera_runtime_office_screens set drain_pending=false,drain_id=null,drain_acknowledged_at=null,
   power='open',lease_id=extensions.gen_random_uuid(),run_id=a.run_id,lease_expires_at=t+interval '1 minute',grant_version=1,native_binding='{}'
   where office_id=office.office_id;
  result:=public.qorpera_runtime_computer_job_activity(office,t);
  if result->>'state'<>'active' or (result->>'knownActiveJobCount')::integer<>1 then raise exception 'Shared screen activity differs: %',result; end if;
  update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid() where office_id=office.office_id;
  if public.qorpera_runtime_computer_job_activity(office,t)->>'state'<>'unknown' then raise exception 'Pending screen drain became idle'; end if;
  update public.qorpera_runtime_node_observations set observed_at=t-interval '61 seconds' where node_id='${nodeId}';
  result:=public.qorpera_runtime_node_computers('${nodeId}');
  if result->>'observationUnavailableReason'<>'OBSERVATION_STALE' or exists(select 1 from jsonb_array_elements(result->'computers') c
   where c->>'physicalState'<>'unknown' or c->>'runningWorkState'<>'not_classified') then raise exception 'Stale inventory was reported live'; end if;
  if exists(select 1 from public.qorpera_runtime_machine_allocations where id=a.id and released_at is not null) then raise exception 'View released allocation'; end if;
  begin perform public.qorpera_runtime_node_computers('${nodeId}',null,0);raise exception 'Zero page accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.qorpera_runtime_node_computers('${nodeId}',null,1001);raise exception 'Large page accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.qorpera_runtime_node_computers(extensions.gen_random_uuid());raise exception 'Unknown node accepted'; exception when invalid_parameter_value then null; end;
  if exists(select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r where has_function_privilege(r,
   'public.qorpera_runtime_node_computers(uuid,uuid,integer)','execute')) then raise exception 'Operator page leaked'; end if;
  if has_function_privilege('service_role','public.qorpera_runtime_computer_job_activity(public.qorpera_runtime_machine_allocations,timestamptz)','execute') then
   raise exception 'Private helper leaked'; end if;
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  begin perform public.qorpera_runtime_node_computers('${nodeId}');raise exception 'Member read page'; exception when insufficient_privilege then null; end;
 end $proof$; rollback;`);
 return {
  assertPhysical(state,reason){const item=machine();assert(item);assert.equal(item.physicalState,state);
   if(reason)assert.equal(item.physicalStateReason,reason);assert.equal(item.nodeReleasedAt,null);assert.equal(item.capacityReleaseInferredFromActivity,false);},
  assertReleased(){assert.equal(machine(),undefined);assert.equal(read().computers.length,1);assert.equal(read().computers[0].allocationId,officeId);},
 };
}
