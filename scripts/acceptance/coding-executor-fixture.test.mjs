import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertCodingFixtureParents, assertCodingExecutorCleanup, assertCodingExecutorEvidence, beginCodingFixtureTurn, settleCodingFixtureStop, codingImageAddress, codingFixtureRemote, codingReadinessProjection, codingGuardReadinessProjection, createCodingInventoryRefresh, localCodingFixtureGit, observeCodingInventory, waitForCodingChild, waitForCodingWorkspace } from "./coding-executor-fixture.mjs";

const execute = promisify(execFile);

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
