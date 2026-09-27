import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertCodingFixtureParents, assertCodingExecutorCleanup, assertCodingExecutorEvidence, assertCodingExecutorRetainedEvidence, assertDetachedCodingTransport, beginCodingFixtureTurn, settleCodingFixtureStop, codingCleanupProjection, codingImageAddress, codingFixtureRemote, codingReadinessProjection, codingGuardReadinessProjection, codingTerminalGuardProjection, createCodingInventoryRefresh, localCodingFixtureGit, observeCodingGuardArchive, observeCodingInventory, readCodingOperationEvidence, waitForCodingChild, waitForCodingWorkspace } from "./coding-executor-fixture.mjs";

const execute = promisify(execFile);

test("retained transport is invoked after detach/reuse, with exact refusal and no matching guest effect", async () => {
  const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
  const input = { commandId: randomUUID(), inputSha256: "a".repeat(64), command: "echo previously-authorized-command", timeoutMs: 1000 };
  const calls = [], signal = new AbortController().signal;
  const client = {
    pushInstanceFile(...args) { assert.equal(this, client); calls.push(["push",args]); return "pushed"; },
    execInstance(...args) { assert.equal(this, client); calls.push(["exec",args]); return "executed"; },
  };
  const originalPush = client.pushInstanceFile, originalExec = client.execInstance;
  let attempts = 0;
  const transport = { async start(actualScope, actualInput, checked) {
    assert.equal(actualScope,scope); assert.equal(actualInput,input); assert.equal(checked,signal); attempts++;
    // Another session's concurrent effect must still receive its original call.
    assert.equal(await client.execInstance("default","vm",["/usr/bin/node","/opt/qorpera-coding/cloud-coding-command-guest.mjs","start",randomUUID(),randomUUID()],signal),"executed");
    throw new Error("CODING_HOST_TURN_NOT_PREPARED");
  } };
  const retained = { client, transport, scope, input };
  const detached = await assertDetachedCodingTransport(retained,signal);
  assert.deepEqual(await assertDetachedCodingTransport(retained,signal),detached); assert.equal(attempts,2);
  assert.equal(detached.stagingAttempts,0); assert.equal(detached.dispatchAttempts,0); assert.equal(calls.length,2);
  for (const effect of ["push","exec"]) {
    const leaking = { async start() {
      if(effect === "push") await client.pushInstanceFile("default","vm",`/var/lib/qorpera-coding/${scope.workerId}/inbox/${input.commandId}.json`,"private-command",0o444,signal);
      else await client.execInstance("default","vm",["/usr/bin/node","/opt/qorpera-coding/cloud-coding-command-guest.mjs","start",scope.workerId,input.commandId],signal);
      throw new Error("CODING_HOST_TURN_NOT_PREPARED");
    } };
    await assert.rejects(assertDetachedCodingTransport({...retained,transport:leaking},signal),/EFFECT_ATTEMPTED/);
    assert.equal(client.pushInstanceFile,originalPush); assert.equal(client.execInstance,originalExec);
  }
  for(const start of [async()=>({state:"running"}),async()=>{throw new Error("CODING_COMMAND_SCOPE_DIFFERS");}])
    await assert.rejects(assertDetachedCodingTransport({...retained,transport:{start}},signal));
  assert.equal(client.pushInstanceFile,originalPush); assert.equal(client.execInstance,originalExec);
});

function operationFixture() {
  const command = { workerId: randomUUID(), commandId: randomUUID(), runId: randomUUID(), jobId: randomUUID(), assignmentId: randomUUID(),
    inputSha256: "a".repeat(64), receipt: {state:"succeeded",exitCode:0,output:"private output excluded from projection"} };
  const row = { id: command.commandId, runId: command.runId, jobId: command.jobId, assignmentId: command.assignmentId,
    operationKind:"cloud_tool", inputSha256:command.inputSha256, status:"completed", completedAt:"2026-09-27T00:00:00.000+00:00",
    resultSchema:"qorpera.cloud-tool-operation-result/v1", resultInputSha256:command.inputSha256, contentKind:"json", receiptSchema:"qorpera.coding-command-result/v2",
    workerId:command.workerId, commandId:command.commandId, receiptInputSha256:command.inputSha256, receiptState:"succeeded", exitCode:0,
    outputSha256:createHash("sha256").update(command.receipt.output).digest("hex") };
  return {command,row};
}

test("bounded SQL operation evidence independently binds completed identities, input and output without raw results", async () => {
  const {command,row} = operationFixture(); let queried;
  const read = async(value,commands=[command])=>readCodingOperationEvidence(async(sql)=>{queried=sql;return JSON.stringify(value);},commands);
  const result = await read([row]); assert.deepEqual(result.rows,[row]);
  assert(queried.includes(`'${command.commandId}'::uuid`)); assert(!queried.includes(command.receipt.output));
  assert(!JSON.stringify(result).includes(command.receipt.output)); assert(!/select\s+\*|to_jsonb\(|p_binding/.test(queried));
  for (const mutation of [{runId:randomUUID()},{jobId:randomUUID()},{assignmentId:randomUUID()},{workerId:randomUUID()},
    {id:randomUUID()},{commandId:randomUUID()},{inputSha256:"b".repeat(64)},{resultInputSha256:"b".repeat(64)},
    {receiptInputSha256:"b".repeat(64)},{status:"executing"},{receiptState:"failed"},{exitCode:1},
    {completedAt:null},{outputSha256:"b".repeat(64)},{secret:"must-not-retain"}]) await assert.rejects(read([{...row,...mutation}]));
  for(const rows of [[],[row,row],Array(9).fill(row)]) await assert.rejects(read(rows));
  queried=null;
  await assert.rejects(read([row],[{...command,commandId:"' OR true --"}])); assert.equal(queried,null);
});

function terminalGuardFixture() {
  const permitId=randomUUID(),allocationId=randomUUID(),epoch=randomUUID(),hostBootId=randomUUID(),physicalId=randomUUID();
  const instanceSha256="a".repeat(64),prepareSha256="b".repeat(64),guardIncarnationId=randomUUID();
  const closure={state:"closed",permitId,allocationId,epoch,generation:1,reservationId:randomUUID(),instanceSha256,hostBootId,
    prestart:{guardIncarnationId,prepareSha256},secret:"must-not-retain"};
  const prestart={state:"retired",guardIncarnationId,intent:{permitId,allocationId,instanceSha256,hostBootId,prepareSha256,prepareRequestText:"must-not-retain"}};
  const stopReceipt={permitId,allocationId,generation:1,instanceSha256,physicalInstanceId:physicalId,hostBootId,closedHostBootId:hostBootId,
    observedUptimeMs:10000,closedAtUptimeMs:10000,state:"stopped",operationId:randomUUID(),secret:"must-not-retain"};
  const record={phase:"stopped",usageRequired:true,permit:{permitId,secret:"must-not-retain"},machine:{allocationId,physicalInstanceId:physicalId,binding:{secret:"must-not-retain"}},
    startDispatched:true,startSettled:true,startSucceeded:true,stopReceipt};
  const head={sequence:32,sha256:"c".repeat(64),observationId:randomUUID()};
  const page={state:"sealed",permitId,epoch,head,acknowledgedThrough:{...head},finalSequence:32,entries:[{secret:"must-not-retain"}]};
  return {permitId,closure,prestart,record,page};
}

test("terminal guard projection requires stopped sealed acknowledged identity and strips arbitrary guard material", () => {
  const f=terminalGuardFixture(), project=(value)=>codingTerminalGuardProjection(value.permitId,value.closure,value.prestart,value.record,value.page);
  const result=project(f); assert.equal(result.usage.head.sequence,32); assert.equal(result.stopReceipt.state,"stopped");
  assert(!JSON.stringify(result).includes("must-not-retain"));
  // A stop already observed by the guard need not dispatch an LXD operation.
  // ACK removes page entries, while the durable head still names the sealed tip.
  const acknowledged=structuredClone(f);acknowledged.record.stopReceipt.operationId=null;acknowledged.page.entries=[];
  const retained=project(acknowledged);assert.equal(retained.stopReceipt.operationId,null);assert.deepEqual(retained.usage.head,result.usage.head);
  for(const mutate of [x=>{x.closure.state="bound";},x=>{x.record.phase="stopping";},x=>{x.record.startSettled=false;},
    x=>{x.page.state="open";},x=>{x.page.acknowledgedThrough.sequence--;},x=>{x.page.acknowledgedThrough.sha256="d".repeat(64);},
    x=>{x.page.finalSequence++;},x=>{x.page.head.observationId="private";},x=>{x.prestart.state="registered";},
    x=>{x.record.stopReceipt=null;},x=>{delete x.record.stopReceipt.operationId;},x=>{x.record.stopReceipt.operationId="private";},
    x=>{x.record.stopReceipt.allocationId=randomUUID();},x=>{x.closure.prestart.prepareSha256="d".repeat(64);}]) {
    const changed=structuredClone(f);mutate(changed);assert.throws(()=>project(changed));
  }
});

test("archive observation preserves real archive calls, errors, cancellation and cleanup despite capture failure", async () => {
  const f=terminalGuardFixture(), signal=new AbortController().signal, calls=[]; let captureFails=false, archiveFails;
  const guard={
    async prestartStatus(id,checked){assert.equal(id,f.permitId);assert(checked instanceof AbortSignal);return f.prestart;},
    async status(){if(captureFails)throw new Error("private guard failure");return f.record;},
    async readUsage(id,options){assert.equal(id,f.permitId);assert.deepEqual(options,{limit:1});return f.page;},
    async archive(...args){assert.equal(this,guard);calls.push(args);if(archiveFails)throw archiveFails;return "original-result";},
  };
  const observer=observeCodingGuardArchive(guard);
  assert.equal(await guard.archive(f.permitId,f.closure,signal),"original-result");
  assert.equal(calls[0][0],f.permitId);assert.equal(calls[0][1],f.closure);assert.equal(calls[0][2],signal);
  assert.equal(observer.evidence().records[0].archiveAcknowledged,true);assert.equal(observer.evidence().captureFailed,false);
  await guard.archive(f.permitId,f.closure,signal);assert.equal(observer.evidence().records.length,1);
  // A failed capture never prevents the underlying cleanup operation.
  const failedGuard={...guard,archive:async(...args)=>{calls.push(args);return "closed-despite-diagnostic";}};
  captureFails=true;const failedObserver=observeCodingGuardArchive(failedGuard);
  assert.equal(await failedGuard.archive(f.permitId,f.closure,signal),"closed-despite-diagnostic");
  assert.equal(failedObserver.evidence().captureFailed,true);assert.equal(failedObserver.evidence().records.length,0);
  assert(!JSON.stringify(failedObserver.evidence()).includes("private"));
  archiveFails=new Error("actual archive failure");
  await assert.rejects(guard.archive(f.permitId,f.closure,signal),error=>error===archiveFails);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(guard.archive(f.permitId,f.closure,cancelled.signal),error=>error===archiveFails);
  assert.equal(calls.at(-1)[2],cancelled.signal);
});

test("final retained evidence joins archival to SQL and rejects incomplete stale-transport or nonempty custody proof", () => {
  const f=terminalGuardFixture(),terminal={...codingTerminalGuardProjection(f.permitId,f.closure,f.prestart,f.record,f.page),archiveAcknowledged:true};
  const fixtures=Array.from({length:4},operationFixture),commands=fixtures.map(x=>x.command);
  const stale={schema:"qorpera.coding-detached-transport/v1",workerId:commands[0].workerId,commandId:commands[0].commandId,inputSha256:commands[0].inputSha256,
    refusal:"CODING_HOST_TURN_NOT_PREPARED",stagingAttempts:0,dispatchAttempts:0};
  const finalCustody=codingCleanupProjection({openReservations:0,openPermits:0,closedPermitIds:[f.permitId],closedAttemptIds:[f.permitId],secret:"must-not-retain"},[],[]);
  assert(!JSON.stringify(finalCustody).includes("must-not-retain"));
  const proof={commands,operationEvidence:{schema:"qorpera.coding-operation-evidence/v1",rows:fixtures.map(x=>x.row)},
    detach:{retainedTransportAfterDetach:stale},reuse:{retainedTransportAfterReattach:{...stale}},guardArchives:{schema:"qorpera.coding-guard-archives/v1",captureFailed:false,records:[terminal]},finalCustody,
    accounting:{permit:{id:f.permitId,allocation_id:f.closure.allocationId,epoch:f.closure.epoch,generation:1,physical_id:f.record.machine.physicalInstanceId,host_boot_id:f.closure.hostBootId},
      samples:[{sequence:32,sample:{observationId:f.page.head.observationId,state:"stopped"}}]}};
  assert.doesNotThrow(()=>assertCodingExecutorRetainedEvidence(proof));
  for(const mutate of [x=>{delete x.detach.retainedTransportAfterDetach;},x=>{x.reuse.retainedTransportAfterReattach.commandId=randomUUID();},
    x=>{x.detach.retainedTransportAfterDetach.dispatchAttempts=1;},x=>{x.operationEvidence.rows.pop();},x=>{x.guardArchives.captureFailed=true;},
    x=>{x.guardArchives.records[0].archiveAcknowledged=false;},x=>{x.accounting.samples[0].sequence++;},x=>{x.finalCustody.activeRecords=[{}];},x=>{x.finalCustody.closedPermitIds=[];}]) {
    const changed=structuredClone(proof);mutate(changed);assert.throws(()=>assertCodingExecutorRetainedEvidence(changed));
  }
  assert.throws(()=>codingCleanupProjection({...finalCustody,closedPermitIds:Array(9).fill(f.permitId)},[],[]),/ROW_LIMIT/);
  assert.throws(()=>codingCleanupProjection(finalCustody,[{state:"private",intent:{permitId:f.permitId}}],[]),/STATE_INVALID/);
});

test("begin retries only complete native busy refusals under the original lease and cancellation", async () => {
  const busy=Object.assign(new Error("SQL output withheld"),{diagnostic:{sqlState:"55P03"}});
  let clock=0,calls=0;
  const waits=[], timing={now:()=>clock,random:()=>1,pause:async(ms)=>{waits.push(ms);clock+=ms;}};
  const admission=Object.freeze({workerId:"retained",turnId:"same"}), received=[];
  const result=await beginCodingFixtureTurn(async()=>{received.push(admission);if(++calls<4)throw busy;return {started:true};},new Date(5000).toISOString(),new AbortController().signal,timing);
  assert.deepEqual(result,{started:true});assert.deepEqual(waits,[250,500,1000]);assert(received.every(value=>value===admission));
  for(const error of [new Error("55P03"),null,Object.assign(new Error("other"),{diagnostic:{sqlState:"42501"}}),Object.assign(new Error("deadlock"),{diagnostic:{sqlState:"40P01"}})]) {
    let attempts=0;
    await assert.rejects(beginCodingFixtureTurn(async()=>{attempts++;throw error;},new Date(5000).toISOString(),new AbortController().signal,timing),value=>value===error);
    assert.equal(attempts,1);
  }
  clock=0;calls=0;
  await assert.rejects(beginCodingFixtureTurn(async()=>{calls++;throw busy;},new Date(1000).toISOString(),new AbortController().signal,timing),error=>error===busy);
  assert.equal(clock,750);assert.equal(calls,3);
  const abort=new AbortController();abort.abort();calls=0;
  await assert.rejects(beginCodingFixtureTurn(async()=>{calls++;},new Date(5000).toISOString(),abort.signal,timing));assert.equal(calls,0);
});

test("stop settlement waits for exact physical stop and sealed controller closure", async () => {
  let phase="stopping",managed=true,observed=0,clock=0;
  const observedPhases=[];
  const target={allocationId:"allocation",permitId:"permit",guard:{status:async()=>({phase,permit:{permitId:"permit"},machine:{allocationId:"allocation"}})},
    controller:{manages:()=>managed,observe:async()=>{observedPhases.push(phase);if(++observed===2)managed=false;}}};
  await settleCodingFixtureStop(target,new AbortController().signal,{now:()=>clock,pause:async(ms)=>{clock+=ms;phase="stopped";}});
  assert.deepEqual(observedPhases,["stopped","stopped"]);assert.equal(managed,false);assert.equal(clock,1000);
  for(const record of [{phase:"running",permit:{permitId:"permit"},machine:{allocationId:"allocation"}},
    {phase:"stopped",permit:{permitId:"foreign"},machine:{allocationId:"allocation"}},
    {phase:"stopped",permit:{permitId:"permit"},machine:{allocationId:"foreign"}}]) {
    managed=true;observed=0;
    await assert.rejects(settleCodingFixtureStop({...target,guard:{status:async()=>record}},new AbortController().signal));assert.equal(observed,0);
  }
  phase="stopped";managed=true;
  const failure=new Error("unconfirmed sample upload");
  await assert.rejects(settleCodingFixtureStop({...target,controller:{manages:()=>true,observe:async()=>{throw failure;}}},new AbortController().signal),error=>error===failure);
  phase="stopping";clock=0;observed=0;
  await assert.rejects(settleCodingFixtureStop(target,new AbortController().signal,{now:()=>clock,pause:async(ms)=>{clock+=ms;}}),/TIMEOUT:sealed stop settlement/);
  assert.equal(clock,60000);assert.equal(observed,0);assert.equal(managed,true);
});

test("inventory context contention needs a fresh successful scan and never retries arbitrary authority failures", async () => {
  const stale = {sqlState:"PGRST",messageSha256:"cdb872cf2da33ad6c9453e77b61887bf8435e859185e086dbe5b3ab3faaa3099"};
  const failure = new Error("NODE_OBSERVER_UNCONFIRMED");
  let scans=0, admission=0;
  const scan = async () => { scans++; if(scans===1) throw failure; return {state:"ready"}; };
  for(let attempt=0;attempt<2;attempt++) {
    if(await observeCodingInventory(scan,()=>attempt===0?stale:undefined)==="ready") admission++;
    assert.equal(admission,attempt);
  }
  assert.equal(scans,2); assert.equal(admission,1);
  for(const diagnostic of [undefined,{...stale,sqlState:"42501"},{...stale,messageSha256:"different"}])
    await assert.rejects(observeCodingInventory(async()=>{throw failure;},()=>diagnostic),error=>error===failure);
  await assert.rejects(observeCodingInventory(async()=>({state:"unavailable"}),()=>stale));
  const aborted=new Error("ABORTED");
  await assert.rejects(observeCodingInventory(async()=>{throw aborted;},()=>stale),error=>error===aborted);
});

test("post-boot refresh queues a new scan behind background work, retries only stale context and stays bounded", async () => {
  let release, entered;
  const blocking=new Promise(resolve=>{release=resolve;}), started=new Promise(resolve=>{entered=resolve;});
  let scans=0, clock=0, retries=0;
  const stale={sqlState:"PGRST",messageSha256:"cdb872cf2da33ad6c9453e77b61887bf8435e859185e086dbe5b3ab3faaa3099"};
  const options={now:()=>clock,pause:async(ms)=>{clock+=ms;},onRetry:()=>{retries++;}};
  const refresh=createCodingInventoryRefresh(async()=>{
    scans++;
    if(scans===1){entered();await blocking;}
    if(scans===2)throw new Error("NODE_OBSERVER_UNCONFIRMED");
    return {state:"ready"};
  },()=>stale,options);
  const signal=new AbortController().signal;
  const background=refresh(signal); await started;
  let uploaded=false;
  const postBoot=refresh(signal).then(()=>{uploaded=true;});
  await Promise.resolve(); assert.equal(scans,1); assert.equal(uploaded,false);
  release(); await Promise.all([background,postBoot]);
  assert.equal(scans,3); assert.equal(retries,1); assert.equal(uploaded,true);
  const never=createCodingInventoryRefresh(async()=>{throw new Error("NODE_OBSERVER_UNCONFIRMED");},()=>stale,options);
  const before=clock;
  await assert.rejects(never(signal),/REFRESH_TIMEOUT/);assert.equal(clock-before,30000);
  const abort=new AbortController();abort.abort();const previous=scans;
  await assert.rejects(refresh(abort.signal));assert.equal(scans,previous);
});

test("readiness diagnostics distinguish canonical admission from an unacknowledged guard tip without leaking source data", () => {
  const canonical = { secret: "must-not-retain", workReady: true, permit: { permitId: "permit", state: "bound", generation: 1, physicalId: "physical", hostBootId: "host", guestBootId: "guest", credential: "must-not-retain" },
    lastSample: { state: "running", observationId: "sample", observedAt: "2026-01-01T00:00:00.000Z", hostUptimeMs: 1000, physicalId: "physical", hostBootId: "host", guestBootId: "guest" } };
  const result = codingReadinessProjection(canonical, Date.parse("2026-01-01T00:00:01.000Z"));
  assert.equal(result.workReady, true); assert.equal(result.sampleAgeMs, 1000); assert.equal(result.sampleGuestBootMatches, true);
  const record = { phase: "running", usageRequired: true, permit: canonical.permit, machine: {physicalInstanceId:"physical"}, stopAtUptimeMs:3000, prepareRequestText:"must-not-retain" };
  const page = {state:"open",head:{sequence:2,observationId:"new",sha256:"new-sha"},acknowledgedThrough:{sequence:1,sha256:"old-sha"},entries:[{secret:"must-not-retain"}]};
  const behind = codingGuardReadinessProjection(record,page,canonical,{uptimeMs:2000,hostBootId:"host"});
  assert.equal(behind.headAcknowledged,false); assert.equal(behind.headMatchesCanonical,false);
  assert.equal(behind.permitMatchesCanonical,true); assert.equal(behind.sampleHostAgeMs,1000); assert.equal(behind.beforeStop,true);
  page.head.observationId="sample"; page.acknowledgedThrough={sequence:2,sha256:"new-sha"};
  const caughtUp = codingGuardReadinessProjection(record,page,canonical,{uptimeMs:2000,hostBootId:"host"});
  assert.equal(caughtUp.headAcknowledged,true); assert.equal(caughtUp.headMatchesCanonical,true);
  const invalid = codingReadinessProjection({permit:{state:"must-not-retain",generation:"must-not-retain"},lastSample:{state:"must-not-retain",observedAt:"must-not-retain"}});
  assert.equal(invalid.permitState,null); assert.equal(invalid.sampleState,null); assert.equal(invalid.sampleAgeMs,null);
  for(const value of [result,behind,caughtUp,invalid]) assert(!JSON.stringify(value).includes("must-not-retain"));
});

test("metering wait begins after boot and expires without renewing its budget or swallowing other failures", async () => {
  const notReady = () => new Error("CODING_MACHINE_UNAVAILABLE:COMPUTER_USAGE_NOT_READY");
  let clock = 0, calls = 0;
  const timing = { now: () => clock, pause: async (ms) => { clock += ms; } };
  const result = await waitForCodingWorkspace(async () => {
    calls++; if (calls === 1) { clock += 120000; throw notReady(); }
    return { vmId: "real-result" };
  }, new AbortController().signal, timing);
  assert.deepEqual(result, { vmId: "real-result" }); assert.equal(calls, 2);
  const started = clock;
  await assert.rejects(waitForCodingWorkspace(async () => { throw notReady(); }, new AbortController().signal, timing), /TIMEOUT:initial independent paid sample/);
  assert.equal(clock - started, 45000);
  const failure = new Error("COMPUTER_AUTHORITY_REFUSED");
  await assert.rejects(waitForCodingWorkspace(async () => { throw failure; }, new AbortController().signal, timing), (error) => error === failure);
  const stopped = new AbortController(); stopped.abort(); let effects = 0;
  await assert.rejects(waitForCodingWorkspace(async () => { effects++; }, stopped.signal, timing)); assert.equal(effects, 0);
});
function input(scratchRoot, args) {
  return { scratchRoot, cwd: scratchRoot, network: true, args,
    env: { PATH: process.env.PATH, HOME: scratchRoot, XDG_CONFIG_HOME: scratchRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${codingFixtureRemote}.extraHeader`, GIT_CONFIG_VALUE_0: "Authorization: Basic Zml4dHVyZQ==" },
    signal: AbortSignal.timeout(10000) };
}
test("fixture URL substitution performs real local Git reads, strips credentials and disables network", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-executor-fixture-"));
  try {
    const repo = join(root, "source"), bare = join(root, "bare.git");
    await execute("git", ["init", "--initial-branch=master", repo]);
    await writeFile(join(repo, "value.txt"), "initial\n");
    await execute("git", ["-C", repo, "add", "value.txt"]);
    await execute("git", ["-C", repo, "-c", "user.name=Acceptance", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
    const head = (await execute("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await execute("git", ["clone", "--bare", "--no-hardlinks", repo, bare]);
    const observed = [];
    const adapter = localCodingFixtureGit({ bareRepository: bare, runGit: async (command) => {
      assert.equal(command.network, false); assert.equal(command.env.GIT_ALLOW_PROTOCOL, "file");
      assert.equal(command.env.GIT_CONFIG_COUNT, undefined); assert.equal(command.env.GIT_CONFIG_VALUE_0, undefined);
      assert(!command.args.includes(codingFixtureRemote)); observed.push(command.args);
      return (await execute("git", command.args, { cwd: command.cwd, env: command.env })).stdout;
    } });
    const lookup = join(root, "lookup"); await mkdir(lookup);
    assert.equal(await adapter(input(lookup, ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/master"])), `${head}\trefs/heads/master\n`);
    const fetched = join(root, "fetch"); await mkdir(fetched); await execute("git", ["init", "--bare", fetched]);
    await adapter(input(fetched, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", codingFixtureRemote, "refs/heads/master:refs/heads/master"]));
    assert.equal((await execute("git", ["-C", fetched, "rev-parse", "master"])).stdout.trim(), head);
    assert.equal(observed.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("fixture refuses alternate endpoints, push, branches and credential scope before execution", async () => {
  let calls = 0;
  const adapter = localCodingFixtureGit({ bareRepository: "/never/read", runGit: async () => { calls++; } });
  for (const args of [
    ["ls-remote", "--refs", "--heads", "https://github.com/other/repo.git", "refs/heads/master"],
    ["push", codingFixtureRemote, "HEAD:refs/heads/master"],
    ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/other"],
    ["fetch", codingFixtureRemote, "refs/heads/master"],
  ]) await assert.rejects(adapter(input("/tmp/unused", args)));
  const wrong = input("/tmp/unused", ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/master"]);
  wrong.env.GIT_CONFIG_KEY_0 = "http.https://elsewhere.invalid.extraHeader";
  await assert.rejects(adapter(wrong)); assert.equal(calls, 0);
});
test("real executor evidence cannot pass without two-user isolation, preserved reuse and closed paid settlement", () => {
  const proof = () => ({ schema: "qorpera.coding-executor-physical/v1",
    sessions: [200000, 200001].map((uid) => ({ uid, vmId: "same", editTestCommit: true, crossSessionDenied: true, custodyWriteDenied: true })),
    reuse: { sameVm: true, sameStorageMarker: true, sameCommit: true, reseeded: false },
    detach: { otherSessionContinued: true, oldTransportRefused: true },
    balanceBefore: { issuedUs: "10000", debitedUs: "0", reservedUs: "0" }, balanceAfter: { issuedUs: "10000", debitedUs: "1000", reservedUs: "0" },
    accounting: { permit: { state: "closed" } }, reconciliation: { debitedUs: "1000" }, reservedUsAfter: "0" });
  assert.doesNotThrow(() => assertCodingExecutorEvidence(proof()));
  for (const mutate of [
    (p) => { p.sessions[1].uid = p.sessions[0].uid; }, (p) => { p.sessions[0].crossSessionDenied = false; },
    (p) => { p.sessions[0].custodyWriteDenied = false; }, (p) => { p.reuse.reseeded = true; },
    (p) => { p.detach.otherSessionContinued = false; }, (p) => { p.accounting.permit.state = "bound"; },
    (p) => { p.reservedUsAfter = "1"; }, (p) => { p.reconciliation.debitedUs = "0"; },
  ]) { const value = proof(); mutate(value); assert.throws(() => assertCodingExecutorEvidence(value)); }
});

test("failed prepare retains empty-VM custody until both guard and SQL close", () => {
  const sql = { openReservations: 0, openPermits: 0, closedPermitIds: [], closedAttemptIds: [] };
  const intent = { state: "registered", intent: { permitId: "one" } };
  assert.throws(() => assertCodingExecutorCleanup(sql, [intent], []));
  assert.throws(() => assertCodingExecutorCleanup({ ...sql, openReservations: 1 }, [], []));
  assert.throws(() => assertCodingExecutorCleanup({ ...sql, openPermits: 1 }, [], []));
  intent.state = "abandoned";
  assert.throws(() => assertCodingExecutorCleanup(sql, [intent], []));
  assert.doesNotThrow(() => assertCodingExecutorCleanup({ ...sql, closedAttemptIds: ["one"] }, [intent], []));
  const record = { phase: "running", permit: { permitId: "one" }, stopReceipt: null };
  const closed = { ...sql, closedPermitIds: ["one"] };
  assert.throws(() => assertCodingExecutorCleanup(closed, [], [record]));
  assert.doesNotThrow(() => assertCodingExecutorCleanup(closed, [], [{ ...record, phase: "stopped", stopReceipt: {} }]));
});

test("timed out child escalates without treating its later exit as successful cleanup", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const signals = [];
  await assert.rejects(waitForCodingChild(child, { timeoutMs: 20, graceMs: 30, kill: (signal) => { signals.push(signal); child.kill(signal); } }), /custody retained/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("image address follows the guest default-route device and remains inside the managed bridge", () => {
  const link = (name, ip) => ({ ifname: name, addr_info: [{ family: "inet", scope: "global", local: ip }] });
  const route = (name) => ({ dst: "default", dev: name });
  assert.equal(codingImageAddress([link("enp5s0", "10.22.1.2")], [], "10.22.1.1/24"), null);
  for (const name of ["eth0", "enp5s0"]) assert.deepEqual(codingImageAddress([link("lo", "127.0.0.1"), link(name, "10.22.1.2")], [route(name)], "10.22.1.1/24"), { device: name, address: "10.22.1.2" });
  assert.equal(codingImageAddress([link("eth0", "10.22.1.2")], [route("enp5s0")], "10.22.1.1/24"), null);
  assert.throws(() => codingImageAddress([link("enp5s0", "10.23.1.2")], [route("enp5s0")], "10.22.1.1/24"), /outside/);
  assert.throws(() => codingImageAddress([link("enp5s0", "10.22.1.2")], [route("eth0"), route("enp5s0")], "10.22.1.1/24"), /Ambiguous/);
});

test("fixture preflight rejects writable, foreign-owned and symlinked system ancestry", () => {
  const parents = () => ["/", "/var", "/var/lib"].map((path) => ({ path, canonical: path, directory: true, symlink: false, uid: 0, gid: 0, mode: 0o755 }));
  assert.doesNotThrow(() => assertCodingFixtureParents(parents()));
  for (const mutation of [{ mode: 0o777 }, { mode: 0o775 }, { uid: 1001 }, { symlink: true }, { canonical: "/elsewhere" }]) {
    const value = parents(); Object.assign(value[2], mutation);
    assert.throws(() => assertCodingFixtureParents(value));
  }
});
