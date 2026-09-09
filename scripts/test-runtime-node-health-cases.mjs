import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

// Actual publisher and SQL, with typed fixture measurements. The installed
// systemd probe separately supplies actual Linux kernel/filesystem evidence.
export async function testRuntimeNodeHealth({nodeId,sql,psql,service,literal,quote,restartDatabase,RuntimeNodeHealthPublisher}) {
 const policy=sql(`select policy_sha256 from public.qorpera_runtime_node_inventory_policies where node_id=${quote(nodeId)};`);
 const machine=sql(`select machine_id_sha256 from public.qorpera_runtime_nodes where id=${quote(nodeId)};`);
 const call=(name,args,role=service)=>JSON.parse(sql(`${role} select public.${name}(${args.join(',')});`).split('\n').at(-1));
 const view=()=>call('qorpera_runtime_node_health',[quote(nodeId)]);
 assert.equal(view().reason,'OBSERVATION_MISSING');assert.equal(view().currentMeasurement,null);
 const snapshot=()=>sql(`select jsonb_build_object('nodes',(select jsonb_agg(to_jsonb(n) order by id) from public.qorpera_runtime_nodes n),
  'demands',(select jsonb_agg(to_jsonb(d) order by allocation_id) from public.qorpera_runtime_node_demands d),
  'allocations',(select jsonb_agg(to_jsonb(a) order by id) from public.qorpera_runtime_machine_allocations a),
  'inventory',(select jsonb_agg(to_jsonb(i) order by observation_id) from public.qorpera_runtime_node_inventory_receipts i));`);
 const before=snapshot(),records=[];let fail=false,loseReply=true;
 const sample=(offset=0)=>{const at=Date.now()+offset;return {schema:'qorpera.runtime-node-health/v1',nodeId,machineIdSha256:machine,policySha256:policy,
  observerPackageSha256:'e'.repeat(64),bootId:'36000000-0000-4000-8000-000000000011',observationId:randomUUID(),observedAt:new Date(at).toISOString(),
  cpu:{usedBasisPoints:2500,from:new Date(at-1000).toISOString(),until:new Date(at).toISOString()},memory:{totalBytes:8192,availableBytes:4096},
  rootFilesystem:{totalBytes:81920,freeBytes:40960,availableBytes:40000},
  network:{receivedBytes:20,sentBytes:10,receiveErrors:1,sendErrors:2,receiveDrops:3,sendDrops:4},errors:[]};};
 const registry={async call(method,args){assert.equal(method,'qorpera_observe_runtime_node_health');const record=structuredClone(args.p_observation);records.push(record);
  const result=call(method,[literal(record)]);if(loseReply){loseReply=false;throw new Error('discarded committed health receipt');}return result;}};
 const publisher=new RuntimeNodeHealthPublisher(nodeId,machine,policy,registry,async()=>{if(fail)throw new Error('PRIVATE measurement failure');return sample();});
 await assert.rejects(publisher.observe(new AbortController().signal),/discarded/);assert.equal(records.length,1);
 assert.deepEqual(view().currentMeasurement,records[0]);assert.equal(view().state,'complete');assert.equal(view().usedForAdmission,false);
 const oldReceipt=call('qorpera_observe_runtime_node_health',[literal(records[0])]);
 fail=true;await publisher.observe(new AbortController().signal);const failed=view();assert.equal(failed.state,'unknown');assert.equal(failed.reason,'COLLECTION_UNCONFIRMED');
 assert.equal(failed.currentMeasurement,null);assert.equal(failed.lastObservation.observerPackageSha256,null);
 assert.deepEqual(call('qorpera_observe_runtime_node_health',[literal(records[0])]),oldReceipt);
 assert.equal(view().observationId,failed.observationId,'old replay must not restore healthy state');
 const delayed=sample(-10000);call('qorpera_observe_runtime_node_health',[literal(delayed)]);assert.equal(view().observationId,failed.observationId);
 fail=false;await publisher.observe(new AbortController().signal);assert.equal(view().state,'complete');
 const concurrent=sample();
 const race=async statements=>Promise.all(statements.map(statement=>new Promise((resolve,reject)=>{
  const child=spawn('docker',psql,{stdio:['pipe','pipe','pipe']});let output='',error='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{error+=b;});child.once('error',reject);
  child.once('close',code=>{clearTimeout(timer);resolve({code,output,error});});child.stdin.end(statement);
 })));
 const submit=value=>`${service} select public.qorpera_observe_runtime_node_health(${literal(value)});`;
 const pair=await race([submit(concurrent),submit(concurrent)]);assert(pair.every(r=>r.code===0),JSON.stringify(pair));assert.equal(pair[0].output,pair[1].output);
 assert.equal(sql(`select count(*) from public.qorpera_runtime_node_health_receipts where node_id=${quote(nodeId)} and observation_id=${quote(concurrent.observationId)};`),'1');
 const changed={...concurrent,memory:{totalBytes:8192,availableBytes:1}};assert.throws(()=>sql(submit(changed)),/identity changed/);
 const paged=[];let time=null,id=null;
 do {const page=call('qorpera_runtime_node_health_history',[quote(nodeId),time?quote(time):'null',id?quote(id):'null','1']);
  assert.equal(page.snapshotAcrossPages,false);paged.push(...page.records.map(r=>r.observation));time=page.nextBeforeTime;id=page.nextBeforeId;}while(id);
 assert.equal(paged.length,5);assert(paged.some(o=>o.observationId===delayed.observationId));assert(paged.some(o=>o.bootId===null));
 const ids=paged.map(o=>o.observationId);assert.equal(new Set(ids).size,ids.length);
 for(const bad of [{...sample(),secret:'PRIVATE'}, {...sample(),memory:null}, {...sample(),errors:['PRIVATE error']}, {...sample(),cpu:{usedBasisPoints:10001,from:records[0].cpu.from,until:records[0].cpu.until}},
  {...sample(),rootFilesystem:{totalBytes:10,freeBytes:11,availableBytes:1}}, {...sample(),network:{...concurrent.network,sendErrors:-1}},
  {...sample(),bootId:null},sample(-120000),sample(60000),{...sample(),policySha256:'f'.repeat(64)}]) assert.throws(()=>sql(submit(bad)));
 sql(`begin; set local request.jwt.claims='{"role":"service_role"}';
  update public.qorpera_runtime_node_health_receipts set observed_at=statement_timestamp()-interval '61 seconds'
   where node_id=${quote(nodeId)} and observation_id=${quote(concurrent.observationId)};
  do $proof$ declare v jsonb; begin
   v:=public.qorpera_runtime_node_health(${quote(nodeId)});
   if v->>'reason'<>'OBSERVATION_STALE' or v->'currentMeasurement'<>'null'::jsonb or v->'lastObservation'='null'::jsonb then raise exception 'Stale health reported current'; end if;
   begin perform public.qorpera_runtime_node_health_history(${quote(nodeId)},null,null,1001);raise exception 'Unbounded health page'; exception when invalid_parameter_value then null; end;
   begin perform public.qorpera_runtime_node_health_history(${quote(nodeId)},null,extensions.gen_random_uuid(),1);raise exception 'Partial cursor accepted'; exception when invalid_parameter_value then null; end;
   if exists(select 1 from unnest(array['anon','authenticated','qorpera_secret_broker']) role where has_function_privilege(role,'public.qorpera_runtime_node_health(uuid)','execute')
    or has_function_privilege(role,'public.qorpera_runtime_node_health_history(uuid,timestamptz,uuid,integer)','execute')
    or has_function_privilege(role,'public.qorpera_observe_runtime_node_health(jsonb)','execute')) then raise exception 'Health RPC leaked'; end if;
   if has_function_privilege('service_role','public.qorpera_assert_runtime_node_health(jsonb)','execute') or has_table_privilege('service_role','public.qorpera_runtime_node_health_receipts','SELECT,INSERT,UPDATE,DELETE') then raise exception 'Raw health custody leaked'; end if;
   perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
   begin perform public.qorpera_runtime_node_health(${quote(nodeId)});raise exception 'Member health read'; exception when insufficient_privilege then null; end;
  end $proof$; rollback;`);
 const retained=call('qorpera_runtime_node_health_history',[quote(nodeId)]);
 assert.equal(snapshot(),before);await restartDatabase();assert.deepEqual(call('qorpera_runtime_node_health_history',[quote(nodeId)]),retained);
 assert.equal(view().observationId,concurrent.observationId);assert.equal(snapshot(),before);
 console.log('NODE_HEALTH_SQL_PROOF='+JSON.stringify({schema:'qorpera.runtime-node-health-sql-proof/v1',actualSql:true,actualPublisher:true,
  measurements:'fixture',closedMetadata:true,explicitUnavailable:true,lostCommittedReply:true,concurrentReplayOnce:true,
  outOfOrderDoesNotRefresh:true,historyPagination:true,staleUnknown:true,operatorOnly:true,admissionAndAllocationsUnchanged:true,databaseRestart:true,observations:5}));
}
