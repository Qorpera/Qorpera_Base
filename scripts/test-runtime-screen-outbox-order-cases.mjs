import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Real lifecycle SQL and the production outbox; only physical desktop events
// are synthetic. A queued closure must precede the next screen lifetime even
// when UUID order is reversed and observations share the same millisecond.
export async function testRuntimeScreenOutboxOrder({startup,binding,service,execute,rpcSql,CompanyComputerScreenOutbox}) {
 const directory=await realpath(await mkdtemp(join(tmpdir(),'screen-order-sql-')));
 const signal=new AbortController().signal;
 const [nextId,priorId]=[randomUUID(),randomUUID()].sort();
 const observedAt=new Date().toISOString();
 const observation=(id,sequence,state,reason)=>({schema:'qorpera.runtime-screen-observation/v1',startup,binding,privacy:null,
  event:{lifetimeId:id,eventId:randomUUID(),sequence,state,reason,observedAt}});
 const direct=record=>JSON.parse(execute(`${service} ${rpcSql({p_startup:startup,p_binding:binding,p_privacy:null,p_event:record.event})}`));
 const delivered=[];
 const queue=await CompanyComputerScreenOutbox.open(directory,startup.scope,[],{call:async(method,args)=>{
  assert.equal(method,'qorpera_record_runtime_screen_event','Canonical publication unexpectedly fell back to unconfirmed custody');
  const receipt=JSON.parse(execute(`${service} ${rpcSql(args)}`));delivered.push(args.p_event);return receipt;
 }});
 try {
  direct(observation(priorId,1,'requested','SCREEN_REQUESTED'));
  direct(observation(priorId,2,'ready','DESKTOP_READY'));
  for(const record of [observation(priorId,3,'closing','SCREEN_DRAIN_REQUESTED'),observation(priorId,4,'closed','DESKTOP_REAPED'),
   observation(nextId,1,'requested','SCREEN_REQUESTED'),observation(nextId,2,'ready','DESKTOP_READY')])await queue.retain(record,signal);
  for(let i=0;i<4;i++)await queue.flush(signal);
  assert.deepEqual(delivered.map(e=>[e.lifetimeId,e.state]),[[priorId,'closing'],[priorId,'closed'],[nextId,'requested'],[nextId,'ready']]);
  assert.deepEqual((await readdir(directory)).sort(),['scope.json']);
  assert.equal(execute(`select count(*) from public.qorpera_runtime_screen_lifetimes where id in ('${priorId}','${nextId}') and closed_at is null;`),'1');
  const history=JSON.parse(execute(`${service} select public.qorpera_runtime_screen_events('${nextId}',0,10);`));
  assert.deepEqual(history.events.map(e=>e.event.state),['requested','ready']);
  direct(observation(nextId,3,'closing','SCREEN_DRAIN_REQUESTED'));direct(observation(nextId,4,'closed','DESKTOP_REAPED'));
  console.log('SCREEN_OUTBOX_ORDER_SQL_PROOF='+JSON.stringify({actualSql:true,productionOutbox:true,reversedUuidOrder:true,sameMillisecond:true,
   priorClosedBeforeReopen:true,canonicalEvents:4,retentionFallbacks:0,physicalDesktop:'fixture'}));
 } finally {await queue.close();await rm(directory,{recursive:true,force:true});}
}
