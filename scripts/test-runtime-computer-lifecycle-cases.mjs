import assert from 'node:assert/strict';

// Uses real admission/stop/release records produced by the caller. Physical
// provider measurements in these disposable SQL probes remain fixtures.
export async function testRuntimeComputerLifecycle({allocationId,service,literal,execute,restartDatabase,kind,stopped=false,closing=stopped,released=false,expectedBootRequests=0}) {
 const call=sql=>JSON.parse(execute(`${service} ${sql}`).split('\n').at(-1));
 const window=call(`select jsonb_build_object('from',statement_timestamp()-interval '1 hour','until',statement_timestamp());`);
 const quote=value=>`(${literal(value)}#>>'{}')`;
 const read=(from=window.from,until=window.until)=>call(`select public.qorpera_runtime_computer_lifecycle('${allocationId}',${quote(from)}::timestamptz,${quote(until)}::timestamptz);`);
 const snapshot=()=>execute(`select jsonb_build_object(
  'allocations',(select jsonb_agg(to_jsonb(a) order by id) from public.qorpera_runtime_machine_allocations a),
  'offices',(select jsonb_agg(to_jsonb(o) order by id) from public.qorpera_runtime_offices o),
  'activations',(select jsonb_agg(to_jsonb(v) order by activation_id) from public.qorpera_runtime_office_activations v),
  'transitions',(select jsonb_agg(to_jsonb(t) order by id) from public.qorpera_runtime_office_lifecycle_transitions t),
  'stops',(select jsonb_agg(to_jsonb(s) order by transition_id) from public.qorpera_runtime_office_stops s),
  'demands',(select jsonb_agg(to_jsonb(d) order by allocation_id) from public.qorpera_runtime_node_demands d));`);
 const before=snapshot(),result=read(),events=result.controlEvents;
 assert.equal(result.schema,'qorpera.runtime-computer-lifecycle/v1');
 assert.equal(result.allocationId,allocationId);assert.equal(result.window,'half_open');
 assert.equal(result.exactVmTransitionTimesAvailable,false);assert.equal(result.missingPhysicalTransitions,'unknown');
 assert.equal(result.viewerEventsIncluded,false);assert.equal(result.queryCreatesAuthority,false);
 assert(events.some(e=>e.layer==='company_allocation'&&e.event==='reserved'));
 assert.equal(events.some(e=>e.layer==='company_allocation'&&e.event==='released'),released);
 for(const event of events){
  assert.equal(event.timeBasis,'database_recorded');assert.equal(event.physicalTransitionAt,null);
  assert(event.sourceId&&event.reason);assert(!('request' in event));assert(!('inspection' in event));
 }
 if(kind==='office'){
  assert(events.some(e=>e.layer==='office_admission'&&e.event==='requested'));
  assert(events.some(e=>e.layer==='office_service'&&e.event==='ready'));
  assert.equal(events.some(e=>e.layer==='office_service'&&e.event==='stop_acknowledged'),stopped);
  assert.equal(events.some(e=>e.layer==='office_admission'&&e.event==='closing'),closing);
  const bootRequests=events.filter(e=>e.layer==='vm_control');
  assert.equal(bootRequests.length,expectedBootRequests);
  for(const event of bootRequests){assert.equal(event.event,'boot_requested');assert(event.activationId&&event.transitionId);}
  const activations=JSON.parse(execute(`select jsonb_agg(jsonb_build_object('id',activation_id,'at',activated_at,'generation',computer_generation))
   from public.qorpera_runtime_office_activations where allocation_id='${allocationId}' and activated_at is not null;`).split('\n').at(-1));
  assert.equal(events.filter(e=>e.layer==='office_service'&&e.event==='ready').length,activations.length);
  for(const activation of activations){const event=events.find(e=>e.event==='ready'&&e.activationId===activation.id);
   assert(event);assert.equal(event.recordedAt,activation.at);assert.equal(event.computerGeneration,activation.generation);}
  if(stopped){
   // Fixture-only privileged comparison; the operator itself reads only the RPC.
   const stops=JSON.parse(execute(`select jsonb_agg(jsonb_build_object('id',s.transition_id,'at',s.acknowledged_at,'activation',t.activation_id,'action',t.request->>'action'))
    from public.qorpera_runtime_office_stops s join public.qorpera_runtime_office_lifecycle_transitions t on t.id=s.transition_id where t.allocation_id='${allocationId}';`).split('\n').at(-1));
   for(const stop of stops){const event=events.find(e=>e.source==='office_stop'&&e.sourceId===stop.id);
    assert(event);assert.equal(event.recordedAt,stop.at);assert.equal(event.activationId,stop.activation);assert.equal(event.action,stop.action);}
   assert(!events.some(e=>e.event==='released'),'service stop must keep capacity charged');
  }
 }else{
  assert(!events.some(e=>e.layer.startsWith('office_')));
  assert(result.physicalHistory);assert.equal(result.physicalHistory.method,'physical_inventory_sample_hold');
  assert.equal(result.physicalHistory.exactTransitionTimes,false);
  assert.equal(events.some(e=>e.layer==='node_allocation'&&e.event==='released'),released);
 }
 // Partition on the exact microsecond timestamp supplied by PostgreSQL. Equal
 // time events stay together and appear once; JavaScript millisecond conversion
 // must not round a source boundary or turn this into a physical timestamp.
 const split=events[Math.floor(events.length/2)].recordedAt;
 if(split!==window.from&&split!==window.until){
  assert.deepEqual([...read(window.from,split).controlEvents,...read(split,window.until).controlEvents],events);
 }
 assert.equal(snapshot(),before);
 await restartDatabase();assert.deepEqual(read(),result);assert.equal(snapshot(),before);
 execute(`begin; set local request.jwt.claims='{"role":"service_role"}';
  do $proof$ begin
   if exists(select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) r where
    has_function_privilege(r,'public.qorpera_runtime_computer_lifecycle(uuid,timestamptz,timestamptz)','execute')) then
    raise exception 'Non-operator lifecycle access'; end if;
   begin perform public.qorpera_runtime_computer_lifecycle('${allocationId}',now()-interval '25 hours',now());
    raise exception 'Oversized lifecycle window accepted'; exception when invalid_parameter_value then null; end;
   begin perform public.qorpera_runtime_computer_lifecycle('${allocationId}',now(),'infinity');
    raise exception 'Infinite lifecycle window accepted'; exception when invalid_parameter_value then null; end;
   begin perform public.qorpera_runtime_computer_lifecycle('${allocationId}',null,now());
    raise exception 'Missing lifecycle window accepted'; exception when invalid_parameter_value then null; end;
   begin perform public.qorpera_runtime_computer_lifecycle('${allocationId}',now(),now()+interval '1 second');
    raise exception 'Future lifecycle window accepted'; exception when invalid_parameter_value then null; end;
   begin perform public.qorpera_runtime_computer_lifecycle(extensions.gen_random_uuid(),now()-interval '1 hour',now());
    raise exception 'Unknown lifecycle allocation accepted'; exception when invalid_parameter_value then null; end;
   perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
   begin perform public.qorpera_runtime_computer_lifecycle('${allocationId}',now()-interval '1 hour',now());
    raise exception 'Member read operator lifecycle'; exception when insufficient_privilege then null; end;
  end $proof$; rollback;`);
 if(kind==='office'){
  // Artificial retained history is confined to a rolled-back arithmetic fixture.
  // Production service/boot authority is still exercised by the caller.
  execute(`begin; set local request.jwt.claims='{"role":"service_role"}';
   do $proof$ declare original public.qorpera_runtime_office_activations%rowtype;
    candidate public.qorpera_runtime_office_activations%rowtype; t timestamptz:='2020-01-01T00:00:00Z'; result jsonb;
   begin
    select * into strict original from public.qorpera_runtime_office_activations where allocation_id='${allocationId}' and superseded_at is null;
    for i in 1..501 loop
     candidate:=original; candidate.activation_id:=extensions.gen_random_uuid();candidate.predecessor_activation_id:=original.activation_id;
     candidate.service_invocation_id:=replace(candidate.activation_id::text,'-','');
     candidate.state:='active';candidate.ready_at:=t;candidate.activated_at:=t;candidate.superseded_at:=t+interval '1 second';
     insert into public.qorpera_runtime_office_activations select (candidate).*;
     original:=candidate;
    end loop;
    begin perform public.qorpera_runtime_computer_lifecycle('${allocationId}',t,t+interval '1 hour');
     raise exception 'Unbounded lifecycle response accepted'; exception when program_limit_exceeded then null; end;
    result:=public.qorpera_runtime_computer_lifecycle('${allocationId}',t+interval '2 seconds',t+interval '1 hour');
    if result->'controlEvents'<>'[]'::jsonb or result->'missingPhysicalTransitions'<>'"unknown"'::jsonb then
     raise exception 'Missing lifecycle evidence was fabricated'; end if;
   end $proof$; rollback;`);
 }
 assert.equal(snapshot(),before);
 console.log('COMPUTER_LIFECYCLE_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-computer-lifecycle-proof/v1',kind,
  actualSql:true,actualControlRecords:true,serviceStopped:stopped,resourcesReleased:released,events:events.length,
  physicalMeasurements:'fixture',bootRequests:expectedBootRequests,layersSeparate:true,exactPhysicalTimesNotInvented:true,microsecondWindowPartition:true,
  readOnly:true,operatorOnly:true,databaseRestart:true,boundedResponse:kind==='office'}));
}
