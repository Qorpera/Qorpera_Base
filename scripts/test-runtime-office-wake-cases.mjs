import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// The wake fixture (supabase/tests/300_runtime_wake_bus.test.sql) claims its job,
// assignment and native provider lease with 120-second bounds. Drivers that
// consume the binding late (after activation, screen, lifecycle and stop phases
// with database restarts) must keep those bounds live through the real runner
// renewal RPCs; the native lease validator refuses any expired row and neither
// renewal accepts a row that has already lapsed, so renew at phase boundaries.
export function renewOfficeWakeBinding({ setup, service, execute }) {
 const b=setup.binding;
 const args=`'${b.runnerId}',repeat('2',64),'${b.jobId}',repeat('3',64)`;
 const renewed=JSON.parse(execute(`${service} select public.qorpera_renew_runner_job(${args}); select public.qorpera_renew_native_provider_connection_lease('${b.leaseId}',${args},900);`).split("\n").at(-1));
 assert.equal(renewed.lease_id,b.leaseId); assert.equal(renewed.status,"active");
 return renewed;
}

// Existing RPCs complete the real receipt and parent run. Only physical office
// measurements and the native model output are fixture data.
export async function prepareOfficeWake({ setup, intent, service, execute, literal }) {
 const b=setup.binding;
 renewOfficeWakeBinding({ setup, service, execute });
 console.log("Wake fixture binding bounds before native begin: "+execute(`select jsonb_build_object('clock',clock_timestamp(),
  'jobLeaseExpiresAt',(select lease_expires_at from public.qorpera_runner_jobs where id='${b.jobId}'),
  'assignmentExpiresAt',(select expires_at from public.qorpera_runner_assignments where id='${b.assignmentId}'),
  'nativeLeaseExpiresAt',(select expires_at from public.qorpera_native_provider_connection_leases where id='${b.leaseId}'));`));
 const waiter=JSON.parse(execute("select row_to_json(w) from public.qorpera_runtime_office_start_waiters w;"));
 assert.equal(waiter.parent_run_id,b.runId); assert.equal(waiter.intent_id,intent);
 assert.equal(waiter.staff_version,setup.identity.staffVersion);
 assert.equal(waiter.grant_id,setup.descriptor.resources.officeGrantId);
 assert.equal(waiter.state,"waiting");
 const binarySha=execute(`select public.qorpera_execution_runtime_manifest(r)->>'nativeBinarySha256' from public.qorpera_execution_runs r where id='${b.runId}';`);
 assert.match(binarySha,/^[0-9a-f]{64}$/);
 execute(`${service} select public.qorpera_begin_native_company_execution_v2(${literal(b)},'${binarySha}',
  '${setup.identity.runtimeBundleSha256}','${setup.identity.reasoningPolicySha256}',
  '{"type":"namespace","name":"qorpera","description":"Offline office wake fixture","tools":[{"type":"function","name":"computer_start","description":"Synthetic native fixture","inputSchema":{"type":"object","additionalProperties":false}}]}',repeat('c',64),10);`);
 execute(`${service} select public.qorpera_materialize_wake_execution_runs(32);`);
 assert.equal(execute("select count(*) from public.qorpera_wake_occurrences where source_kind='office-activation';"),"0");
 const receipt=JSON.parse(execute(`select row_to_json(r) from public.qorpera_run_operation_receipts r where id='${waiter.receipt_id}';`));
 const result={schema:"qorpera.cloud-tool-operation-result/v1", inputSha256:receipt.input_sha256, content:{kind:"json",value:{schema:"qorpera.office-start-intent/v1",intentId:intent,companyComputerId:setup.descriptor.scope.companyComputerId,computerGeneration:1,state:"requested"}}};
 execute(`${service} select public.qorpera_complete_native_tool_operation(${literal(b)},'${receipt.id}','${receipt.input_sha256}',${literal(result)});`);
 const send=JSON.parse(execute(`${service} select public.qorpera_send_native_agent_message('${b.leaseId}','${b.runId}','${b.jobId}','${b.runnerId}','${b.assignmentId}','${b.credentialCapsuleId}','${b.computeIdentityId}','openai','codex-cli','office-awaiting-final','The shared office is starting; the pending work will continue when it is ready.','final');`));
 const substrate=execute(`select substrate_version_id from public.qorpera_execution_runs where id='${b.runId}';`);
 const completed={schema:"qorpera.runner-result/v1",runtime:"company-path-v1",backend:"native-company-runtime",native_lease_id:b.leaseId,substrate_version_id:substrate,output_count:0,output_bytes:0,publication:null,
  backend_result:{schema:"qorpera.native-harness-result/v2",run_id:b.runId,message_count:2,final_message_id:send.messageId,provider_session_id:"offline-office-wake-fixture"},
  usage:{schema:"qorpera.runner-usage/v1",execution_ms:50,input_bytes:0,output_bytes:0,result_bytes:300,limits:{wall_time_ms:1000,memory_bytes:67108864,cpu_millis:1000,max_pids:16,max_input_bytes:1048576,max_output_bytes:0,max_result_bytes:4096}}};
 execute(`${service} select public.qorpera_complete_runner_job_v6('${b.runnerId}',repeat('2',64),'${b.jobId}',repeat('3',64),'${randomUUID()}','${randomUUID()}',null,${literal(completed)});`);
 assert.equal(execute(`select status from public.qorpera_runner_jobs where id='${b.jobId}';`),"completed");
 execute(`${service} select public.qorpera_materialize_wake_execution_runs(32);`);
 assert.equal(execute("select count(*) from public.qorpera_wake_occurrences where source_kind='office-activation';"),"0");
 console.log("PASS: native/member coalescing retains one agent continuation; completed receipt and real parent completion do not wake before activation");
 return waiter;
}

export async function testOfficeWake({ setup, intent, service, owner, execute, literal, race, session, until, helpers, parseCloudWakeEnvelope, createHttpCompanyComputerSessionFactory, CloudNativeToolRun, CloudNativeToolOperations, restartDatabase }) {
 const materialize=`select public.qorpera_materialize_wake_execution_runs(32);`;
 const snapshot=()=>JSON.parse(execute(`select jsonb_build_object('waiters',(select count(*) from public.qorpera_runtime_office_start_waiters),'wakes',(select count(*) from public.qorpera_wake_occurrences where source_kind='office-activation'),'runs',(select count(*) from public.qorpera_execution_runs where source_id in (select id from public.qorpera_wake_occurrences where source_kind='office-activation')));`));
 assert.deepEqual(snapshot(),{waiters:1,wakes:0,runs:0});
 for (const change of [
  "update public.qorpera_runtime_office_access set state='revoked';",
  "delete from public.qorpera_staff_execution_authorities;",
 ]) {
  execute(`begin; ${change} ${service} ${materialize} reset role; do $$ begin
   if exists(select 1 from public.qorpera_runtime_office_start_waiters where state<>'cancelled')
    or exists(select 1 from public.qorpera_wake_occurrences where source_kind='office-activation') then raise exception 'Revoked source admitted an office wake'; end if;
   end $$; rollback;`);
 }
 execute(`begin; ${owner} select public.qorpera_set_company_execution_pause('${setup.identity.companyId}',true,'pending office wake');
  reset role; ${service} ${materialize} reset role; do $$ begin
  if exists(select 1 from public.qorpera_runtime_office_start_waiters where state<>'waiting')
   or exists(select 1 from public.qorpera_wake_occurrences where source_kind='office-activation') then raise exception 'Paused office wake was delivered'; end if;
  end $$; rollback;`);
 console.log("PASS: revoked office grants or missing standing authority cancel pending delivery without breaking the queue; founder pause leaves demand waiting");
 execute(`begin; ${service} ${materialize} rollback;`);
 assert.deepEqual(snapshot(),{waiters:1,wakes:0,runs:0});
 await restartDatabase();
 assert.deepEqual(snapshot(),{waiters:1,wakes:0,runs:0});
 assert.equal(execute("select count(*) from public.qorpera_runtime_office_activations where state='active';"),"1");
 console.log("PASS: rolled-back materialization and a real PostgreSQL restart retain the accepted waiter and activation without an orphan wake or run");
 const held=session();
 held.child.stdin.write(`begin; select id from public.qorpera_profiles where id='${setup.identity.companyId}' for update; select 'PROFILE_HELD';\n`);
 await until(()=>held.output().includes("PROFILE_HELD"));
 try {
  const [contended]=await race([`${service} set statement_timeout='2s'; ${materialize}`]);
  assert.equal(contended.code,0,contended.error); assert.deepEqual(JSON.parse(contended.output),[]);
  const [checked]=await race(["set statement_timeout='2s'; select public.qorpera_office_waiter_authorized(w) from public.qorpera_runtime_office_start_waiters w;"]);
  assert.notEqual(checked.code,0); assert.match(checked.error,/could not obtain lock on row in relation "qorpera_profiles"/);
  assert.deepEqual(snapshot(),{waiters:1,wakes:0,runs:0});
 } finally {held.child.stdin.end("rollback;\n"); const result=await held.done; assert.equal(result.code,0,result.error);}
 console.log("PASS: profile contention skips delivery and makes standalone office continuation validation retry before taking office locks");
 const contenders=await race([`${service} ${materialize}`,`${service} ${materialize}`]);
 for(const r of contenders) assert.equal(r.code,0,r.error);
 assert.deepEqual(snapshot(),{waiters:1,wakes:1,runs:1});
 const wake=JSON.parse(execute("select row_to_json(w) from public.qorpera_wake_occurrences w where source_kind='office-activation';"));
 assert.equal(wake.parent_run_id,setup.binding.runId); assert.equal(wake.wake_kind,"agent");
 assert.equal(wake.occurrence_key,`office-activation:${intent}:${setup.binding.runId}`); assert.equal(wake.session_id,null);
 assert.equal(wake.payload.intentId,intent); assert.equal(wake.payload.computerGeneration,1);
 execute(`${service} ${materialize}`); assert.deepEqual(snapshot(),{waiters:1,wakes:1,runs:1});
 assert.equal(execute(`select public.qorpera_run_wake_authorized('${wake.run_id}');`),"t");
 const continuation=JSON.parse(execute(`select public.qorpera_run_continuation(r) from public.qorpera_execution_runs r where id='${wake.run_id}';`));
 assert.equal(continuation.schema,"qorpera.office-start-continuation/v1"); assert.equal(continuation.parentRunId,setup.binding.runId);
 assert.equal(continuation.parentInputs.length,1); assert.equal(continuation.receipts.length,1); assert.equal(continuation.priorSends.length,2);
 const launched=JSON.parse(execute(`begin; ${helpers} ${service} select pg_temp.wake_start('${wake.run_id}'); commit;`).split("\n").at(-1));
 const authority=JSON.parse(execute(`${service} select public.qorpera_describe_native_tool_authority(${literal(launched)});`));
 const envelope=JSON.parse(execute(`${service} select public.qorpera_read_native_wake(${literal(launched)});`));
 const parsed=parseCloudWakeEnvelope(envelope,authority.identity);
 assert.equal(parsed.kind,"agent"); assert.equal(parsed.actorUserId,null); assert.equal(parsed.actorStaffId,null);
 assert.equal(parsed.policy.maxPublicSends,0); assert.equal(parsed.parentRunId,setup.binding.runId);
 const context=JSON.parse(execute(`${service} select public.qorpera_describe_company_run_context(${literal(launched)});`));
 assert.equal(context.currentInputs.length,0); assert.equal(context.continuation.sourceKind,"continuation");
 assert.equal(context.continuation.id,wake.run_id);
 const run=await CloudNativeToolRun.open(launched,{describeToolAuthority:async()=>JSON.parse(execute(`${service} select public.qorpera_describe_native_tool_authority(${literal(launched)});`))},new AbortController().signal);
 try {
  const noEffect=async()=>{throw new Error("Discovery must not execute a guest effect or create a native receipt");};
  const factory=createHttpCompanyComputerSessionFactory({url:`https://office.invalid/office/${setup.descriptor.scope.companyComputerId}/native`,token:"a".repeat(43),fetch:noEffect,
   registry:{call:async(method,args)=>{
    assert.equal(method,"qorpera_native_office_descriptor"); assert.deepEqual(args.p_binding,launched);
    return JSON.parse(execute(`${service} select public.qorpera_native_office_descriptor(${literal(launched)});`));
   }}});
  const office=await factory(run,new CloudNativeToolOperations(run,{beginToolOperation:noEffect,completeToolOperation:noEffect}));
  assert(office); assert(office.tools.some(tool=>tool.name==="computer_shell")); assert(office.tools.some(tool=>tool.name==="computer_screen"));
  assert(!office.tools.some(tool=>tool.name==="computer_start")); await office.close();
 } finally {run.close();}
 console.log("PASS: concurrent post-activation drain and repeated polling create one ordinary wake/run; actual native reader/parser receives attributed continuation and zero public sends");
 console.log("PASS: the actual headless native session factory discovers active office tools for the continuation without a desktop, guest request or provider call");
 // Reversible transactions leave the admitted run untouched between cases.
 const rejected=[
  `update public.qorpera_runtime_office_access set state='revoked';`,
  `update public.qorpera_runtime_offices set generation=generation+1;`,
  `update public.qorpera_runtime_offices set state='recovering';`,
  `update public.qorpera_shared_sessions set status='closed' where id='${setup.identity.sessionId}';`,
  `update public.qorpera_runtime_machine_allocations set released_at=clock_timestamp() where office_id='${setup.descriptor.scope.companyComputerId}';`,
 ];
 for(const change of rejected) assert.equal(execute(`begin; ${change} select public.qorpera_run_wake_authorized('${wake.run_id}'); rollback;`),"f");
 execute(`begin; ${owner} select public.qorpera_set_company_execution_pause('${setup.identity.companyId}',true,'offline continuation test'); reset role; do $$ begin if public.qorpera_run_wake_authorized('${wake.run_id}') then raise exception 'Paused office wake retained authority'; end if; end $$; rollback;`);
 for(const sql of ["select * from public.qorpera_runtime_office_start_waiters;","select public.qorpera_drain_office_activation_wakes(32);"]){
  const [denied]=await race([`${service} ${sql}`]); assert.notEqual(denied.code,0); assert.match(denied.error,/permission denied/);
 }
 console.log("PASS: current office grant, generation, state, allocation, parent source and founder-stop fences remain enforced after materialization; waiter internals are not API authority");
 return {wakeId:wake.id,runId:wake.run_id};
}
