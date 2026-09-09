import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Called within the actual Unix reader/publisher + PostgreSQL probe. Physical
// host/daemon replies are fixtures; this helper never fabricates query results.
export function testRuntimeHostInventory({nodeId,sql,rpc,quote}) {
 const query=(id=null,project=null,name=null,limit=100)=>rpc('qorpera_runtime_host_inventory',
  [quote(nodeId),id===null?'null':quote(id),project===null?'null':quote(project),name===null?'null':quote(name),String(limit)]);
 const missing=query();assert.equal(missing.currentStateReason,'INVENTORY_MISSING');assert.equal(missing.reportedEntryCount,null);
 assert.deepEqual(missing.entries,[]);
 for(const role of ['anon','authenticated','qorpera_secret_broker'])assert.equal(sql(`select has_function_privilege(${quote(role)},'public.qorpera_runtime_host_inventory(uuid,uuid,text,text,integer)','EXECUTE');`),'f');
 assert.throws(()=>query(null,'default','management'),/Invalid host inventory page/);
 assert.throws(()=>query(randomUUID()),/Observation is unavailable/);
 assert.throws(()=>query(null,null,null,0),/Invalid host inventory page/);
 assert.throws(()=>query(null,null,null,1001),/Invalid host inventory page/);
 assert.throws(()=>query(null,null,null,null),/Invalid host inventory page/);
 const records=value=>value.entries.map(({currentState,currentStateReason,...entry})=>entry);
 let retained;
 return {
  query,
  assertReady(expectedCount) {
   const value=query();assert.equal(value.currentStateAvailable,true);assert.equal(value.reportedEntryCount,expectedCount);
   assert.equal(value.coverage,'complete_host_observation');assert.equal(value.entries.find(e=>e.category==='infrastructure').name,'management');
   assert.equal(value.entries.some(e=>e.currentState==='unknown'),false);
   assert.equal(JSON.stringify(value).includes('PRIVATE-INFRASTRUCTURE-CREDENTIAL'),false);
   assert.equal(JSON.stringify(value).includes('socketPath'),false);assert.equal(JSON.stringify(value).includes('cloud-init'),false);
   assert.equal(value.resourceReleaseInferred,false);assert.equal(value.observerPackageSha256,null);
   return value;
  },
  assertManaged(allocationId) {
   const value=this.assertReady(2),entry=value.entries.find(e=>e.category==='managed');
   assert.equal(entry.recordedAllocation.allocationId,allocationId);assert.equal(entry.companyId,'30000000-0000-4000-8000-000000000010');
   assert.equal(entry.currentState,'running');assert.equal(entry.jobActivity,null);
   const first=query(null,null,null,1);assert.equal(first.hasMore,true);
   const second=query(first.observationId,first.nextProject,first.nextName,1);assert.equal(second.hasMore,false);
   assert.deepEqual([...first.entries,...second.entries],value.entries);
   retained={id:value.observationId,records:records(value),observedAt:value.observedAt,first};
   // Explicit historical receipt and node-policy fixtures are rolled back;
   // they do not represent a production telemetry/admission write.
   const receipt=JSON.parse(sql(`select observation from public.qorpera_runtime_node_observation_receipts where node_id=${quote(nodeId)} and observation_id=${quote(value.observationId)};`));
   const staleId=randomUUID(),stale={...receipt,observationId:staleId,observedAt:new Date(Date.now()-61000).toISOString()};
   const service=`set request.jwt.claims='{"role":"service_role"}';set local role service_role;`;
   // Explicit historical receipt fixture, not a production telemetry write.
   const result=JSON.parse(sql(`begin;insert into public.qorpera_runtime_node_observation_receipts(node_id,observation_id,observed_at,observation)
    values(${quote(nodeId)},${quote(staleId)},${quote(stale.observedAt)},${quote(JSON.stringify(stale))}::jsonb);
    insert into public.qorpera_runtime_node_inventory_receipts select node_id,${quote(staleId)}::uuid,node_version,policy_sha256,context_sha256,inventory from public.qorpera_runtime_node_inventory_receipts where node_id=${quote(nodeId)} and observation_id=${quote(value.observationId)};
    update public.qorpera_runtime_node_observations set observation_id=${quote(staleId)},observed_at=${quote(stale.observedAt)},observation=${quote(JSON.stringify(stale))}::jsonb where node_id=${quote(nodeId)};
    ${service}select public.qorpera_runtime_host_inventory(${quote(nodeId)});rollback;`));
   assert.equal(result.currentStateReason,'OBSERVATION_STALE');assert.equal(result.entries.length,2);
   assert(result.entries.every(e=>e.currentState==='unknown'));assert.equal(result.entries.find(e=>e.category==='managed').reportedState,'running');
   assert.equal(Date.parse(result.observedAt),Date.parse(stale.observedAt));
   for(const [assignment,reason] of [['version=version+1','INVENTORY_POLICY_CHANGED'],['cpu_millis=cpu_millis+1000','NODE_HARDWARE_CHANGED']]) {
    const changed=JSON.parse(sql(`begin;update public.qorpera_runtime_nodes set ${assignment} where id=${quote(nodeId)};
     ${service}select public.qorpera_runtime_host_inventory(${quote(nodeId)});rollback;`));
    assert.equal(changed.currentStateReason,reason);assert(changed.entries.every(e=>e.currentState==='unknown'));
    assert.deepEqual(records(changed),retained.records);
   }
  },
  assertSubstituted() {
   const value=query();assert.equal(value.currentStateAvailable,false);assert.equal(value.currentStateReason,'NODE_UNAVAILABLE');
   assert(value.entries.some(e=>e.reportedReason==='INSTANCE_AUTHORITY_DIFFERS'));
   assert(value.entries.every(e=>e.currentState==='unknown'));
  },
  assertUnmanaged() {
   const value=query(),entry=value.entries.find(e=>e.category==='unmanaged');
   assert.equal(value.reportedEntryCount,3);assert.equal(entry.name,'stopped-unmanaged');assert.equal(entry.reportedState,'suspended');
   assert.equal(entry.reportedReason,'UNREGISTERED_INSTANCE');assert.equal(entry.currentState,'unknown');
   assert.equal(entry.recordedAllocation,null);assert.equal(entry.companyId,null);assert.equal(value.currentStateReason,'NODE_UNAVAILABLE');
   const first=query(null,null,null,1),second=query(first.observationId,first.nextProject,first.nextName,1),third=query(first.observationId,second.nextProject,second.nextName,1);
   assert.equal(second.hasMore,true);assert.equal(third.hasMore,false);assert.deepEqual([...first.entries,...second.entries,...third.entries],value.entries);
  },
  assertUnavailable() {
   const value=query();assert.equal(value.currentStateAvailable,false);assert(value.currentStateReason);
   assert.equal(value.coverage,'unconfirmed_observation_entries');assert.equal(value.reportedEntryCount,null);
   assert.deepEqual(value.entries,[]);
  },
  assertHistorical() {
   const value=query(retained.id);assert.equal(value.currentStateReason,'OBSERVATION_SUPERSEDED');
   assert.equal(value.observedAt,retained.observedAt);assert.deepEqual(records(value),retained.records);
   const next=query(retained.id,retained.first.nextProject,retained.first.nextName,1);
   assert.deepEqual([...records(retained.first),...records(next)],retained.records);
   assert(value.entries.every(e=>e.currentState==='unknown'));return value;
  },
 };
}
