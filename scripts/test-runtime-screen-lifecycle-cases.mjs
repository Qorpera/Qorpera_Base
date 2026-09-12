import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Model PostgREST's JSON request -> typed SQL argument conversion. In
// particular, a top-level JSON null becomes SQL NULL even for a jsonb column.
const rpcSql=args=>`select public.qorpera_record_runtime_screen_event(a.p_startup,a.p_binding,a.p_privacy,a.p_event)
 from json_to_record('${JSON.stringify(args).replaceAll("'","''")}') as a(p_startup jsonb,p_binding jsonb,p_privacy jsonb,p_event jsonb);`;

// Called after the real provider/startup SQL activation. Desired screen power
// and readiness/reaping measurements are fixtures; no Linux display is claimed.
export async function testRuntimeScreenLifecycle({startup,service,literal,execute,race,restartDatabase,CompanyComputerScreenLifecyclePublisher,retainOpen=false}) {
 const conversion=JSON.parse(execute(`select jsonb_build_object('jsonArgumentIsSqlNull',j.p_privacy is null,
  'jsonbArgumentIsSqlNull',b.p_privacy is null,'nestedPrivacyIsJsonNull',j.p_event->'privacy'='null'::jsonb)
  from json_to_record('{"p_privacy":null,"p_event":{"privacy":null}}') j(p_privacy jsonb,p_event jsonb),
  jsonb_to_record('{"p_privacy":null}') b(p_privacy jsonb);`));
 assert.deepEqual(conversion,{jsonArgumentIsSqlNull:true,jsonbArgumentIsSqlNull:true,nestedPrivacyIsJsonNull:true});
 console.log('SCREEN_RPC_JSON_NULL_CONVERSION='+JSON.stringify(conversion));
 const office=startup.scope.companyComputerId;
 const saved=JSON.parse(execute(`select jsonb_build_object('id',id,'power',power) from public.qorpera_runtime_office_screens where office_id='${office}' order by ordinal limit 1;`));
 execute(`update public.qorpera_runtime_office_screens set power='open' where id='${saved.id}';`);
 try {
  const binding=JSON.parse(execute(`select public.qorpera_runtime_office_scope(o)||jsonb_build_object('computerGeneration',o.generation,'screenId',s.id,'screenOrdinal',s.ordinal,'screenGeneration',s.generation,'staffAgentId',s.staff_agent_id) from public.qorpera_runtime_offices o join public.qorpera_runtime_office_screens s on s.office_id=o.id where s.id='${saved.id}';`));
  const lifetimeId=randomUUID();let sequence=0;
  const event=(state,reason)=>({lifetimeId,eventId:randomUUID(),sequence:++sequence,observedAt:new Date().toISOString(),state,reason});
  const command=e=>`${service} ${rpcSql({p_startup:startup,p_binding:binding,p_privacy:null,p_event:e})}`;
  const requested=event('requested','SCREEN_REQUESTED'),results=await race([command(requested),command(requested)]);
  for(const result of results)assert.equal(result.code,0,result.error);
  assert.deepEqual(JSON.parse(results[0].output),JSON.parse(results[1].output));
  assert.deepEqual(JSON.parse(execute(`${service} select public.qorpera_record_runtime_screen_event(${literal(startup)},${literal(binding)},'null'::jsonb,${literal(requested)});`)),JSON.parse(results[0].output));
  for(const p_privacy of [[],false,'null',{unexpected:true}]){
   const [denied]=await race([`${service} ${rpcSql({p_startup:startup,p_binding:binding,p_privacy,p_event:requested})}`]);
   assert.notEqual(denied.code,0,'Malformed privacy became shared authority');
  }
  for(const field of ['p_startup','p_binding','p_event']){
   const args={p_startup:startup,p_binding:binding,p_privacy:null,p_event:requested};args[field]=null;
   const [denied]=await race([`${service} ${rpcSql(args)}`]);
   assert.notEqual(denied.code,0,'Required null argument became valid');
  }
  assert.equal(execute(`select count(*) from public.qorpera_runtime_screen_events where lifetime_id='${lifetimeId}';`),'1');
  const ready=event('ready','DESKTOP_READY');const readyReceipt=JSON.parse(execute(command(ready)));
  // A response can be lost after commit. Resending its exact immutable event
  // retains the original receipt and cannot refresh its observation timestamp.
  assert.deepEqual(JSON.parse(execute(command(ready))),readyReceipt);
  const closing=event('closing','SCREEN_DRAIN_REQUESTED');execute(command(closing));
  const closed=event('closed','DESKTOP_REAPED');const closedReceipt=JSON.parse(execute(command(closed)));
  const history=()=>JSON.parse(execute(`${service} select public.qorpera_runtime_screen_events('${lifetimeId}',0,1000);`));
  const before=history();assert.equal(before.events.length,4);assert.equal(before.state,'closed');
  assert.deepEqual(before.events.map(v=>v.event.state),['requested','ready','closing','closed']);
  const attempts=[],receipts=[];let loseReady=true,loseClosing=true;
  const producer=new CompanyComputerScreenLifecyclePublisher(startup,{call:async(method,args)=>{
   assert.equal(method,'qorpera_record_runtime_screen_event');attempts.push(structuredClone(args));
   const receipt=JSON.parse(execute(`${service} ${rpcSql(args)}`));
   receipts.push(receipt);
   if(args.p_event.state==='ready'&&loseReady){loseReady=false;throw new Error('fixture discarded committed ready response');}
   if(args.p_event.state==='closing'&&loseClosing){loseClosing=false;throw new Error('fixture discarded committed closing response');}
   return receipt;
  }});
  const life=producer.create(binding,null),signal=new AbortController().signal;
  await life.requested(signal);
  await assert.rejects(life.ready(signal),/SCREEN_LIFECYCLE_UNCONFIRMED/);
  await life.ready(signal);
  await assert.rejects(life.closing('SCREEN_DRAIN_REQUESTED',signal),/SCREEN_LIFECYCLE_UNCONFIRMED/);
  await life.closed(signal);
  assert.deepEqual(attempts[1],attempts[2]);assert.deepEqual(receipts[1],receipts[2]);
  assert.deepEqual(attempts[3],attempts[4]);assert.deepEqual(receipts[3],receipts[4]);
  const producerHistory=()=>JSON.parse(execute(`${service} select public.qorpera_runtime_screen_events('${life.lifetimeId}',0,1000);`));
  const produced=producerHistory();assert.equal(produced.state,'closed');
  assert.deepEqual(produced.events.map(v=>v.event.state),['requested','ready','closing','closed']);
  assert.deepEqual(produced.events.map(v=>v.event.sequence),[1,2,3,4]);
  const usageCommand=`${service} select public.qorpera_runtime_screen_history('${life.lifetimeId}',(${literal(produced.events[0].event.observedAt)}#>>'{}')::timestamptz,statement_timestamp());`;
  const usage=JSON.parse(execute(usageCommand));
  assert.equal(usage.method,'guest_screen_heartbeat_hold');assert.equal(usage.exactTransitionTimes,false);
  assert.equal(usage.termination,null);assert.equal(usage.guestClosedAt,produced.closedAt);
  const discovered=[],pages=[];let cursor=null;
  do {
   const page=JSON.parse(execute(`${service} select public.qorpera_runtime_screen_lifetimes('${startup.allocationId}',${cursor?`'${cursor}'`:'null'},1);`));
   assert.equal(page.snapshotAcrossPages,false);assert.equal(page.coverage,'registered_lifetimes_only');
   pages.push(page);discovered.push(...page.lifetimes.map(l=>l.lifetimeId));cursor=page.nextLifetimeId;
  } while(cursor);
  assert.deepEqual(discovered.sort(),[lifetimeId,life.lifetimeId].sort());assert.equal(pages.length,2);
  await restartDatabase();assert.deepEqual(history(),before);assert.deepEqual(JSON.parse(execute(command(closed))),closedReceipt);
  assert.deepEqual(producerHistory(),produced);
  assert.deepEqual(JSON.parse(execute(`${service} select public.qorpera_runtime_screen_history('${life.lifetimeId}',(${literal(usage.from)}#>>'{}')::timestamptz,(${literal(usage.until)}#>>'{}')::timestamptz);`)),usage);
  let openLifetimeId=null;
  if(retainOpen){const interrupted=producer.create(binding,null);await interrupted.requested(signal);await interrupted.ready(signal);openLifetimeId=interrupted.lifetimeId;}
  console.log('SCREEN_LIFECYCLE_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-screen-lifecycle-sql-proof/v3',actualSql:true,actualAdmittedActivation:true,concurrentReplayOnce:true,lostReplyPreservesReceipt:true,historySurvivesRestart:true,events:8,typescriptPublisherIntegrated:true,usageSurvivesRestart:true,paginatedDiscovery:true,physicalDesktop:'fixture',physicalGuestHooksExercised:false}));
  return {openLifetimeId};
 } finally {execute(`update public.qorpera_runtime_office_screens set power='${saved.power}' where id='${saved.id}';`);}
}
