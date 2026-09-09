import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Real local outbox + publisher + PostgreSQL. The observations are fixture
// physical measurements. Prepare them before actual SQL revocation/stop, then
// export afterwards without authorizing work or changing confirmed usage.
export async function prepareScreenObservationRecovery({startup,openLifetimeId,service,owner,literal,execute,race,restartDatabase,
 CompanyComputerScreenLifecyclePublisher,CompanyComputerScreenOutbox}) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'qorpera-screen-recovery-'))),signal=new AbortController().signal;
 const textLiteral=value=>literal(value)+"#>>'{}'";
 const call=(sql,role=service)=>JSON.parse(execute(`${role} ${sql}`).split('\n').at(-1));
 const history=call(`select public.qorpera_runtime_screen_events('${openLifetimeId}',0,1000);`),binding=history.binding;
 const attempts=[],retentions=new Map();let exportAvailable=false,lostReply=true,queue;
 const registry={async call(method,args){
  attempts.push({method,args:structuredClone(args)});
  if(!exportAvailable)throw new Error('fixture export outage');
  let receipt;
  if(method==='qorpera_record_runtime_screen_event')receipt=call(`select public.qorpera_record_runtime_screen_event(${literal(args.p_startup)},${literal(args.p_binding)},${literal(args.p_privacy)},${literal(args.p_event)});`);
  else {
   assert.equal(method,'qorpera_retain_runtime_screen_observation');
   receipt=call(`select public.qorpera_retain_runtime_screen_observation((${textLiteral(args.p_record)}));`);
   const old=retentions.get(receipt.eventId);if(old)assert.deepEqual(receipt,old);else retentions.set(receipt.eventId,receipt);
   if(lostReply){lostReply=false;throw new Error('fixture discarded committed retention receipt');}
  }
  return receipt;
 }};
 try {
  queue=await CompanyComputerScreenOutbox.open(root,startup.scope,[],registry);
  const publisher=new CompanyComputerScreenLifecyclePublisher(startup,registry,queue);
  const privateChallenge={scope:startup.scope,computerGeneration:startup.computerGeneration,challengeId:randomUUID(),version:1,state:'entering',
   memberId:randomUUID(),profileId:randomUUID(),profileVersion:1,screenId:binding.screenId,
   drains:[{state:'draining',drainId:randomUUID(),epoch:1,binding}]};
  const lives=[];
  for(const privacy of [null,privateChallenge]){
   const life=publisher.create(binding,privacy);lives.push(life.lifetimeId);
   await life.requested(signal);await life.ready(signal);await life.closing('OFFICE_SERVICE_STOPPING',signal);await life.closed(signal);
  }
  let sequence=history.lastSequence;
  for(const [state,reason] of [['ready','SCREEN_HEARTBEAT'],['closing','OFFICE_SERVICE_STOPPING'],['closed','DESKTOP_REAPED']])
   await queue.retain({schema:'qorpera.runtime-screen-observation/v1',startup,binding,privacy:null,
    event:{lifetimeId:openLifetimeId,eventId:randomUUID(),sequence:++sequence,observedAt:new Date().toISOString(),state,reason}},signal);
  const names=(await readdir(root)).filter(name=>name!=='scope.json').sort();assert.equal(names.length,11);
  const records=await Promise.all(names.map(name=>readFile(join(root,name),'utf8')));
  const suffixRecord=records.find(record=>{const e=JSON.parse(record).event;return e.lifetimeId===openLifetimeId&&e.sequence===3;}),suffix=JSON.parse(suffixRecord);
  const retainSuffix=`public.qorpera_retain_runtime_screen_observation((${textLiteral(suffixRecord)}))`;
  const canonicalSuffix=`public.qorpera_record_runtime_screen_event(${literal(startup)},${literal(binding)},'null'::jsonb,${literal(suffix.event)})`;
  const setup=`begin; update public.qorpera_runtime_office_screens set power='open' where id='${binding.screenId}'; ${service}`;
  // Both orders are exercised while canonical authority is still available.
  // The first transaction must roll back instead of promoting retained bytes.
  const [guarded]=await race([`${setup} select ${retainSuffix}; select ${canonicalSuffix}; rollback;`]);
  assert.notEqual(guarded.code,0);assert.match(guarded.error,/retained unconfirmed observations/);
  execute(`${setup} do $proof$ declare receipt jsonb; begin receipt:=${canonicalSuffix};
   if ${retainSuffix}<>receipt then raise exception 'late canonical receipt changed'; end if; end $proof$; rollback;`);
  assert.equal(execute('select count(*) from public.qorpera_runtime_screen_observations;'),'0');
  assert.equal(attempts.length,0);await queue.flush(signal);assert.equal(attempts.length,6);
  assert.deepEqual(await Promise.all(names.map(name=>readFile(join(root,name),'utf8'))),records);
  await queue.close();
  return {
   async finish(){
    try {
     const before=execute(`select jsonb_build_object('allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.qorpera_runtime_machine_allocations a),
      'offices',(select jsonb_agg(to_jsonb(o) order by o.id) from public.qorpera_runtime_offices o),
      'events',(select jsonb_agg(to_jsonb(e) order by e.event_id) from public.qorpera_runtime_screen_events e),
      'lifetimes',(select jsonb_agg(to_jsonb(l) order by l.id) from public.qorpera_runtime_screen_lifetimes l));`);
     exportAvailable=true;queue=await CompanyComputerScreenOutbox.open(root,startup.scope,[],registry);
     for(let i=0;i<6;i++)await queue.flush(signal);
     assert.deepEqual(await readdir(root),['scope.json']);assert.equal(retentions.size,11);assert.equal(lostReply,false);
     for(const record of records){
      const original=JSON.parse(record),receipt=retentions.get(original.event.eventId);
      assert.equal(receipt.confirmation,'unconfirmed');assert.equal(receipt.observationSha256,createHash('sha256').update(record).digest('hex'));
      assert.deepEqual(call(`select public.qorpera_retain_runtime_screen_observation((${textLiteral(record)}));`),receipt);
     }
     const after=execute(`select jsonb_build_object('allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.qorpera_runtime_machine_allocations a),
      'offices',(select jsonb_agg(to_jsonb(o) order by o.id) from public.qorpera_runtime_offices o),
      'events',(select jsonb_agg(to_jsonb(e) order by e.event_id) from public.qorpera_runtime_screen_events e),
      'lifetimes',(select jsonb_agg(to_jsonb(l) order by l.id) from public.qorpera_runtime_screen_lifetimes l));`);
     assert.equal(after,before);
     const read=id=>call(`select public.qorpera_runtime_screen_observation_events('${id}',0,1000);`);
     const prefix=read(openLifetimeId);assert.equal(prefix.canonicalState,'ready');assert.equal(prefix.canonicalClosedAt,null);
     assert.equal(prefix.reportedState,'closed');assert.equal(prefix.confirmedThroughSequence,2);assert.equal(prefix.firstUnconfirmedSequence,3);
     assert.deepEqual(prefix.events.map(e=>e.confirmation),['authority_checked','authority_checked','unconfirmed','unconfirmed','unconfirmed']);
     const snapshots=new Map([[openLifetimeId,prefix]]);
     for(const [index,id] of lives.entries()){
      const page=read(id);snapshots.set(id,page);assert.equal(page.confirmation,'unconfirmed_suffix');assert.equal(page.canonicalState,null);
      assert.equal(page.confirmedThroughSequence,0);assert.equal(page.reportedState,'closed');assert.equal(page.usageIncludesUnconfirmed,false);
      assert.equal(page.kind,index===0?'shared':'private');assert(!JSON.stringify(page).includes(privateChallenge.challengeId));
      assert.deepEqual(page.events.map(r=>r.event.state),['requested','ready','closing','closed']);
     }
     const found=[];let cursor=null;
     do {const page=call(`select public.qorpera_runtime_screen_observation_lifetimes('${startup.allocationId}',${cursor?`'${cursor}'`:'null'},1);`);
      assert.equal(page.coverage,'retained_observations_only');assert.equal(page.snapshotAcrossPages,false);
      found.push(...page.lifetimes.map(l=>l.lifetimeId));cursor=page.nextLifetimeId;}while(cursor);
     for(const id of [openLifetimeId,...lives])assert(found.includes(id));
     const retention=record=>`select public.qorpera_retain_runtime_screen_observation((${textLiteral(record)}));`;
     const deny=async(sql,role=service)=>{const [r]=await race([`${role} ${sql}`]);assert.notEqual(r.code,0,'Unexpected retained observation admission');return r;};
     await deny(retention(records[0]),owner);
     for(const sql of [`select * from public.qorpera_runtime_screen_observations;`,
      `select public.qorpera_assert_screen_observation(${literal(JSON.parse(records[0]))});`])await deny(sql);
     await deny(`select public.qorpera_runtime_screen_observation_events('${lives[0]}',0,1);`,owner);
     await deny(`select public.qorpera_runtime_screen_observation_lifetimes('${startup.allocationId}',null,1);`,owner);
     await deny(`select public.qorpera_runtime_screen_observation_events('${lives[0]}',0,1001);`);
     await deny(`select public.qorpera_runtime_screen_observation_lifetimes('${startup.allocationId}',null,0);`);
     await deny(retention(records[0]+' '));
     const item=JSON.parse(records.find(r=>JSON.parse(r).event.lifetimeId===lives[0]&&JSON.parse(r).event.sequence===1));
     for(const altered of [{...item,extra:'refuse'}, {...item,startup:{...item.startup,bootId:randomUUID()}},
      {...item,binding:{...item.binding,extra:'refuse'}},{...item,event:{...item.event,reason:'arbitrary raw exception'}},
      {...item,event:{...item.event,sequence:0}},{...item,event:{...item.event,observedAt:'2026-02-30T01:00:00.000Z'}}])
      await deny(retention(JSON.stringify(altered)));
     const concurrent={...item,event:{...item.event,lifetimeId:randomUUID(),eventId:randomUUID()}};
     const command=retention(JSON.stringify(concurrent));const raced=await race([`${service} ${command}`,`${service} ${command}`]);
     for(const r of raced)assert.equal(r.code,0,r.error);assert.deepEqual(JSON.parse(raced[0].output),JSON.parse(raced[1].output));
     await restartDatabase();for(const [id,snapshot]of snapshots)assert.deepEqual(read(id),snapshot);
     for(const record of records)assert.deepEqual(call(retention(record)),retentions.get(JSON.parse(record).event.eventId));
     assert.equal(execute('select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;'),'1');
     console.log('SCREEN_OBSERVATION_RECOVERY_SQL_PROOF='+JSON.stringify({schema:'qorpera.screen-observation-recovery-sql-proof/v1',actualSql:true,
      actualPublisherAndDiskOutbox:true,observationsRetainedBeforeRevocation:11,exportAfterActualStop:true,lostRetentionReplyRecovered:true,
      exactOriginalRecordHashes:true,unregisteredLifetimesVisible:true,privateChallengeHidden:true,canonicalHistoryAndAllocationsUnchanged:true,
      concurrentReplayOnce:true,lateDirectPromotionRefused:true,committedCanonicalReceiptRecovered:true,databaseRestartPreservesReceiptsAndQueries:true,physicalObservations:'fixture'}));
    }finally{await queue?.close();await rm(root,{recursive:true,force:true});}
   },
   async close(){await queue?.close();await rm(root,{recursive:true,force:true});},
  };
 } catch(error){await queue?.close();await rm(root,{recursive:true,force:true});throw error;}
}
