import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expandTestFixture } from "../test-hosted-db.mjs";
import { startNativePostgres } from "./native-postgres.mjs";
import { readWorkloadUsage, verifyWorkloadUsage, verifyWorkloadActivity } from "./workload-usage-evidence.mjs";
import { CodingComputerController, CODING_COMPUTER_RPCS, parseCodingSessionClaim, lxdCodingMachinePlan,
 PaidComputerGuardClient, readPaidComputerHostClock, LxdUnixClient, RuntimeComputerController,
 RUNTIME_COMPUTER_RPCS, RuntimeNodeInventoryObserver, physicalHost, exerciseRuntimeWorkloadUsage } from "./workload-usage-tools.mjs";

// This runs as the dedicated guard UID on an empty, disposable GitHub runner.
// Company/model/source metadata and invoice funding are labeled SQL fixtures.
// Every VM, inventory binding, clock, guard receipt and paid sample is physical.
const directory = dirname(fileURLToPath(import.meta.url));
const options = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(process.platform, "linux"); assert(process.getuid() > 0);
assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const { kind, cpuCount, memoryBytes, imageFingerprint, bootstrapSha256, planKey, poolFallback, renew, out } = options;
assert(["native", "coding", "login"].includes(kind));
assert(["basis", "dedicated"].includes(planKey) && typeof poolFallback === "boolean" && typeof renew === "boolean" && !(kind === "login" && (poolFallback || renew)));
assert(Number.isSafeInteger(cpuCount) && cpuCount > 0 && cpuCount * 1000 + 500 <= cpus().length * 1000);
assert(Number.isSafeInteger(memoryBytes) && memoryBytes >= 1024 ** 3 && memoryBytes + 2 * 1024 ** 3 < totalmem());
assert(/^[0-9a-f]{64}$/.test(imageFingerprint) && /^[0-9a-f]{64}$/.test(bootstrapSha256));
const companyId = "30000000-0000-4000-8000-000000000010", memberId = "30000000-0000-4000-8000-000000000001";
const environmentId = "30000000-0000-4000-8000-000000000020", nodeId = randomUUID();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const literal = (value) => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("base64")}','base64'),'UTF8')::jsonb`;
const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;
const service = `set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
const socketPath = "/var/snap/lxd/common/lxd/unix.socket", client = new LxdUnixClient(socketPath);
const signal = AbortSignal.timeout(15 * 60000), executorSecret = randomBytes(48).toString("base64url");
const evidence = { schema: "qorpera.physical-workload-usage/v1", commit: process.env.GITHUB_SHA, kind,
 shape: { cpuMillis: cpuCount * 1000, memoryBytes }, planKey, poolFallback, renew, funding: "test invoice through actual subscription/funding RPCs",
 sourceFixture: "396 dispatch prefix; no model, repository or login-provider operation executed. Paid guests execute the fixed offline CPU/memory/disk acceptance workload.",
 passed: false, checks: {}, cleanup: false };
let database, machineName, phase = "database";
const log = (value) => console.log(JSON.stringify({ phase, kind, ...value }));
async function until(read, accept, milliseconds, label) {
 const end = Date.now() + milliseconds;
 while (Date.now() < end) { const result = await read(); if (accept(result)) return result; await delay(500, undefined, { signal }); }
 throw new Error(`WORKLOAD_ACCEPTANCE_TIMEOUT: ${label}`);
}
try {
 database = await startNativePostgres({ binDirectory: "/usr/lib/postgresql/17/bin" });
 evidence.migrationCount = database.migrationCount;
 const query = database.query;
 phase = "source_fixture"; log({});
 const fixtures = new Map();
 for (const name of await readdir(join(directory, "../../supabase/tests"))) {
  if (name.endsWith(".test.sql")) fixtures.set(name, await readFile(join(directory, "../../supabase/tests", name), "utf8"));
 }
 const expanded = expandTestFixture("396_runtime_coding_executor.test.sql", (name) => fixtures.get(name));
 const marker = "-- 1. Deployment policies belong to the executor;";
 assert(expanded.includes(marker));
 // Request a real, supported fifteen-minute logical lease so natural paid
 // renewal does not outlive the source fixture's ordinary two-minute lease.
 // This changes only public lease-request arguments, never a physical clock.
 const base = expanded.slice(0, expanded.indexOf(marker)).replaceAll(",120);", ",900);");
 // Finish only fixture logical runs before selecting paid mode. No physical
 // accounting rows or clocks are seeded by this source prefix.
 const native = kind === "native" ? `
 insert into public.qorpera_session_inputs(id,session_id,client_input_id,kind,author_user_id,body)
 values('64000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000042',extensions.gen_random_uuid(),'kickoff','${memberId}','{"schema":"qorpera.staff-kickoff/v1"}');
 select set_config('qorpera_test.physical_run',pg_temp.wake_input_run(array['64000000-0000-4000-8000-000000000001'::uuid])::text,true);
 update public.qorpera_runner_jobs set created_at=clock_timestamp()-interval '1 day' where run_id=current_setting('qorpera_test.physical_run')::uuid;
 select set_config('qorpera_test.physical_binding',pg_temp.wake_start(current_setting('qorpera_test.physical_run')::uuid)::text,true);` : "";
 const setup = await query(`${base}
 select pg_temp.path_claims('service_role');
 select public.qorpera_release_runtime_machine(id,provider_adapter,instance_sha256) from public.qorpera_runtime_machine_allocations where profile_id='${companyId}' and released_at is null;
 select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','physical-acceptance-parent-final');
 select pg_temp.finish_job(run_id) from public.qorpera_runner_jobs where profile_id='${companyId}' and status in ('leased','running');
 insert into public.qorpera_company_computer_billing_modes(profile_id,mode) values('${companyId}','paid');
 ${native}
 select jsonb_build_object('identity',current_setting('qorpera_test.wake_identity')::jsonb,
 'binding',current_setting('qorpera_test.physical_binding',true)::jsonb,
 'workerId',(pg_temp.worker_row('fix-send')).id,
 'allocationId',(select client_runner_id from public.qorpera_runners where id=(current_setting('qorpera_test.physical_binding',true)::jsonb->>'runnerId')::uuid)); commit;`, { timeoutMs: 120000 });
 const source = JSON.parse(setup.split("\n").at(-1));
 assert.equal(await query("select count(*) from public.qorpera_coding_computer_samples;"), "0");
 phase = "physical_inventory";
 assert.equal((await client.inspectHostInventory(signal)).instances.length, 0, "Unrelated LXD instances refused");
 const server = await client.inspectOfficeServer("default", signal), clock = await readPaidComputerHostClock();
 const host = { machineIdSha256: clock.hostMachineIdSha256, socketPath, socketGid: (await stat(socketPath)).gid,
 certificateSha256: server.certificateSha256, serverName: server.serverName, serverVersion: server.serverVersion, architecture: server.architecture };
 const inventoryPolicy = { schema: "qorpera.runtime-node-inventory-policy/v1", nodeId, host,
 operatingCpuMillis: 500, operatingMemoryBytes: 1024 ** 3, infrastructure: [] };
 const policySha256 = hash(JSON.stringify({ kind, imageFingerprint, bootstrapSha256, cpuCount, memoryBytes, host }));
 const providerId = kind === "native" ? "process" : kind === "coding" ? "coding-acceptance" : "lxd";
 await query(`begin; ${service}
 select public.qorpera_configure_runtime_node(${literal({ schema: "qorpera.runtime-node-policy/v1", nodeId,
 machineIdSha256: host.machineIdSha256, label: "workload-acceptance", cpuMillis: cpus().length * 1000, memoryBytes: totalmem(),
 headroomCpuMillis: 500, headroomMemoryBytes: 2 * 1024 ** 3, standardCpuMillis: cpuCount * 1000, standardMemoryBytes: memoryBytes, enabled: true })},0);
 select public.qorpera_enroll_runtime_node_inventory(${literal(inventoryPolicy)});
 select public.qorpera_enroll_runtime_node_provider('${nodeId}','${host.machineIdSha256}','${kind}','${providerId}','${policySha256}',${cpuCount * 1000},${memoryBytes}); commit;`);
 // Narrow, local service-role adapter; arguments use PostgreSQL's actual
 // signature. It exposes no network endpoint and never logs credentials.
 const allowed = new Set([...CODING_COMPUTER_RPCS, ...RUNTIME_COMPUTER_RPCS,
 "qorpera_runtime_node_inventory_context", "qorpera_observe_runtime_node_inventory", "qorpera_observe_runtime_node", "qorpera_observe_runtime_node_health"]);
 const signatures = JSON.parse(await query(`select jsonb_agg(jsonb_build_object('name',p.proname,'args',
 (select jsonb_agg(jsonb_build_object('name',p.proargnames[a.n],'type',format_type(a.t,null)) order by a.n) from unnest(p.proargtypes::oid[]) with ordinality a(t,n))))
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${[...allowed].map(quoted).join(",")});`));
 const calls = [];
 const control = { async call(method, args, callSignal) {
  evidence.lastControlMethod = method;
  assert(allowed.has(method)); const signature = signatures.filter((row) => row.name === method); assert.equal(signature.length, 1);
  const paid = CODING_COMPUTER_RPCS.includes(method) || RUNTIME_COMPUTER_RPCS.includes(method);
  const input = paid ? { ...args, p_executor_secret: executorSecret } : args;
  assert.deepEqual(Object.keys(input).sort(), signature[0].args.map((arg) => arg.name).sort());
  assert(signature[0].args.every((arg) => /^[a-z_][a-z0-9_]*$/.test(arg.name) && ["uuid", "jsonb", "text"].includes(arg.type)));
  const typed = signature[0].args.map((arg) => `${arg.name} ${arg.type}`).join(",");
  const parameters = signature[0].args.map((arg) => `${arg.name}=>(select ${arg.name} from input)`).join(",");
  const value = JSON.parse(await query(`begin; ${service} with input as (select * from jsonb_to_record(${literal(input)}) as args(${typed}))
   select coalesce(to_jsonb(public.${method}(${parameters})),'null'::jsonb); commit;`, { signal: callSignal }));
  if (args.p_request?.sample) calls.push({ method, args: structuredClone(args) });
  return value;
 } };
 // Keep the same protected host probe as the production observer, but expose
 // its bounded refusal code before the observer deliberately redacts causes.
 await physicalHost(inventoryPolicy, signal);
 const observer = new RuntimeNodeInventoryObserver(inventoryPolicy, control);
 assert.equal((await observer.observe(signal)).state, "ready"); evidence.checks.actualNodeInventory = true;
 // Grants are intentionally test invoices, not a second Stripe purchase. The
 // same owner-only reconciler creates immutable spendable entitlement. Guest
 // service-role authority deliberately cannot mint or alter payment truth.
 await query(`begin; ${service} reset role; select public.qorpera_map_computer_billing_customer('${memberId}','cus_WorkloadAcceptance');
 do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
 perform public.qorpera_reconcile_computer_subscription('evt_WorkloadAcceptance',t,jsonb_build_object('subscriptionId','sub_WorkloadAcceptance','customerId','cus_WorkloadAcceptance','userId','${memberId}','planKey','${planKey}','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
 perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_WorkloadAcceptance','subscriptionId','sub_WorkloadAcceptance','customerId','cus_WorkloadAcceptance','planKey','${planKey}','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',${planKey === "basis" ? 18500 : 159200},'billingReason','subscription_create','status','paid','currency','dkk')); end $$; commit;`);
 const fallbackMember = "30000000-0000-4000-8000-000000000002";
 if (poolFallback) {
  await query(`begin; ${service} reset role; select public.qorpera_map_computer_billing_customer('${fallbackMember}','cus_WorkloadFallback');
   do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
   perform public.qorpera_reconcile_computer_subscription('evt_WorkloadFallback',t,jsonb_build_object('subscriptionId','sub_WorkloadFallback','customerId','cus_WorkloadFallback','userId','${fallbackMember}','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
   perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_WorkloadFallback','subscriptionId','sub_WorkloadFallback','customerId','cus_WorkloadFallback','planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk')); end $$;
   reset role; update public.qorpera_computer_allowance_buckets set debited_us=issued_us-1000000 where user_id='${memberId}';
   set local role authenticated; set local request.jwt.claims='{"role":"authenticated","sub":"${fallbackMember}"}';
   select public.qorpera_set_company_computer_pool('${companyId}',true); commit;`);
  evidence.startingBalanceFixture = "Responsible member has one standard-computer second remaining. Prior debit is operator-seeded test history, not claimed as physical usage. This run's samples and settlements are actual.";
 }
 const balances = async () => JSON.parse(await query("select jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'plan',plan_key,'issuedUs',issued_us::text,'reservedUs',reserved_us::text,'debitedUs',debited_us::text,'periodStart',period_start,'periodEnd',period_end) order by user_id) from public.qorpera_computer_allowance_buckets;"));
 evidence.balancesBefore = await balances();
 for (const bucket of evidence.balancesBefore) {
  const issued = bucket.plan === "dedicated" ? BigInt(Date.parse(bucket.periodEnd) - Date.parse(bucket.periodStart)) * 1000n : 74n * 3600000000n;
  assert.equal(BigInt(bucket.issuedUs), issued, "Subscription grant differs from advertised hours/calendar period");
 }
 const guardSocketPath = kind === "coding" ? "/run/qorpera-paid-computer-guard/control.sock" : "/run/qorpera-native-computer-guard/control.sock";
 const guard = new PaidComputerGuardClient(guardSocketPath);
 let controller, context, allocationId, request, codingBinding, storage, claim;
 if (kind === "coding") {
  phase = "coding_admission";
  const policy = { providerId, providerPolicySha256: policySha256, project: "default", imageFingerprint, bootstrapSha256,
   storagePool: "default", network: "lxdbr0", cpus: cpuCount, memoryBytes, rootDiskBytes: 30 * 1024 ** 3 };
  const nas = { schema: "qorpera.coding-nas-policy/v1", mountPoint: "/srv/coding", rootPath: "/srv/coding/executor", source: "127.0.0.1:/coding", serverAddress: "127.0.0.1" };
  await query(`begin; ${service} select public.qorpera_configure_coding_vm_policy('${environmentId}','exec-test',${literal(policy)});
   select public.qorpera_configure_coding_nas_policy('${environmentId}','exec-test','${host.machineIdSha256}',${literal(nas)});
   reset role; insert into public.qorpera_computer_executor_keys(environment_id,owner,machine_id_sha256,key_sha256) values('${environmentId}','exec-test','${host.machineIdSha256}','${hash(executorSecret)}'); commit;`);
  claim = parseCodingSessionClaim(JSON.parse(await query(`begin; ${service} select public.qorpera_claim_coding_session('exec-test',300); commit;`)));
  const planned = JSON.parse(await query(`begin; ${service} select public.qorpera_plan_coding_machine('${claim.workerId}','${claim.leaseToken}','${host.machineIdSha256}'); commit;`));
  const plan = lxdCodingMachinePlan(planned.binding); codingBinding = plan.binding; allocationId = codingBinding.machineId; request = plan.request;
  storage = { policy: nas, machineIdSha256: host.machineIdSha256 };
  const root = `${nas.rootPath}/workers/${companyId}/${environmentId}/${claim.workerId}`;
  const sessionStorage = { schema: "qorpera.coding-storage/v1", volumeId: claim.workerId, workerId: claim.workerId, companyId, environmentId,
   writerGeneration: 1, machineIdSha256: host.machineIdSha256, policy: nas, dataSource: `${root}/data`, custodySource: `${root}/guest-state`, dataTarget: "/workspace", custodyTarget: "/var/lib/qorpera-coding" };
  const admitted = JSON.parse(await query(`begin; ${service} select public.qorpera_authorize_coding_machine_run('${claim.workerId}','${claim.leaseToken}',${quoted(plan.text)},${literal(sessionStorage)},'${host.machineIdSha256}'); commit;`));
  assert.equal(admitted.schema, "qorpera.coding-machine-admission/v2"); assert.equal(admitted.fundingRequired, true);
  controller = new CodingComputerController({ control, guard, client, clock: readPaidComputerHostClock, storage, owner: "exec-test" });
  await controller.ensure(claim, codingBinding, signal);
 } else {
  phase = `${kind}_admission`; allocationId = kind === "native" ? source.allocationId : randomUUID();
  const instanceSha256 = hash(JSON.stringify({ allocationId, kind, imageFingerprint, policySha256 }));
  request = { name: `qorpera-usage-${allocationId.replaceAll("-", "")}`, type: "virtual-machine", profiles: [], source: { type: "image", fingerprint: imageFingerprint },
   config: { "boot.autostart": "false", "limits.cpu": String(cpuCount), "limits.memory": String(memoryBytes),
    "user.qorpera.schema": kind === "native" ? "qorpera.native-job-vm/v1" : "qorpera.native-login-vm/v2",
    [`user.qorpera.${kind === "native" ? "acquisition_id" : "allocation_id"}`]: allocationId,
    "user.qorpera.provider_adapter": providerId, "user.qorpera.provider_policy_sha256": policySha256, "user.qorpera.instance_sha256": instanceSha256 },
   devices: { root: { type: "disk", path: "/", pool: "default", size: String(30 * 1024 ** 3) }, network: { type: "nic", network: "lxdbr0", name: "eth0" } } };
  if (kind === "native") {
   context = { allocationId, providerKind: "native", providerId, policySha256, instanceSha256, bootstrapSha256,
    runId: source.binding.runId, runnerId: source.binding.runnerId, officeId: null, computerGeneration: null };
   await query(`insert into public.qorpera_runtime_computer_host_keys(node_id,provider_kind,provider_id,policy_sha256,machine_id_sha256,bootstrap_sha256,cpu_millis,memory_bytes,backend,key_sha256)
    values('${nodeId}','native','${providerId}','${policySha256}','${host.machineIdSha256}','${bootstrapSha256}',${cpuCount * 1000},${memoryBytes},'lxd','${hash(executorSecret)}');`);
   controller = new RuntimeComputerController({ control, guard, client, clock: readPaidComputerHostClock });
   assert.equal((await controller.ensure(context, randomUUID(), signal)).mode, "paid");
  } else {
   const login = JSON.parse(await query(`begin; set local role authenticated; set local request.jwt.claims='{"role":"authenticated","sub":"${memberId}"}';
    select public.qorpera_begin_native_provider_login('${companyId}','${randomUUID()}','${randomUUID()}','${source.identity.compute_identity_id}','openai','codex-cli','${"8".repeat(64)}',900); commit;`));
   const reserved = JSON.parse(await query(`begin; ${service} select public.qorpera_reserve_runtime_login_machine('${allocationId}','lxd','${instanceSha256}','${login.login_id}','${"8".repeat(64)}'); commit;`));
   assert.equal(reserved.state, "reserved");
   const node = JSON.parse(await query(`begin; ${service} select public.qorpera_reserve_runtime_node_machine('${allocationId}','login','lxd','${policySha256}','${instanceSha256}','${host.machineIdSha256}',${cpuCount * 1000},${memoryBytes}); commit;`));
   assert.equal(node.state, "reserved");
  }
 }
 phase = "physical_start"; machineName = request.name;
 await client.createInstance("default", request, signal);
 assert.equal((await observer.observe(signal)).state, "ready");
 assert.equal(await query(`select count(*) from public.qorpera_runtime_node_instance_bindings where allocation_id='${allocationId}';`), "1");
 if (kind === "coding") await controller.start(allocationId, signal);
 else if (kind === "native") await controller.start(allocationId, { kind: "lxd", project: "default", instanceName: request.name, profiles: [], config: request.config, devices: request.devices }, signal);
 else await client.setInstancePower("default", machineName, "start", signal);
 await until(async () => { try { return await client.readInstanceFile("default", machineName, "/proc/uptime", 128, signal); } catch { return null; } }, Boolean, 150000, "guest Linux clock");
 assert.equal((await observer.observe(signal)).state, "ready");
 phase = "metering";
 if (kind !== "login") {
  // Observe actual idle time before starting the fixed guest exercise. LXD
  // exec and controller observations remain concurrent so busy time cannot
  // disappear behind a blocking ten-second command.
  await controller.observe(allocationId, signal);
  const idleObservationIds = [];
  for (let n = 0; n < 2; n++) {
   await delay(1100, undefined, { signal }); await controller.observe(allocationId, signal);
   idleObservationIds.push(calls.at(-1).args.p_request.sample.observationId);
  }
  const guestScript = `/var/tmp/qorpera-usage-${allocationId}.py`, guestMarker = `/var/tmp/qorpera-usage-${allocationId}.json`;
  const payload = await readFile(join(directory, "workload-usage-guest.py"), "utf8");
  await client.pushInstanceFile("default", machineName, guestScript, payload, 0o400, signal);
  let finished = false, failure;
  const execution = client.execInstance("default", machineName, ["/usr/bin/python3", guestScript, guestMarker], AbortSignal.any([signal, AbortSignal.timeout(45000)]))
   .catch((error) => { failure = error; }).finally(() => { finished = true; });
  while (!finished) { await delay(1000, undefined, { signal }); await controller.observe(allocationId, signal); }
  await execution; if (failure) throw failure;
  const completion = JSON.parse((await client.readInstanceFile("default", machineName, guestMarker, 4096, signal)).content.toString("utf8"));
  assert.equal(completion.schema, "qorpera.guest-workload-completion/v1"); assert.equal(completion.completed, true);
  assert.equal(completion.touchedMemoryBytes, 64 * 1024 ** 2); assert.equal(completion.writtenDiskBytes, 32 * 1024 ** 2);
  assert(completion.hashIterations > 0 && completion.cpuTimeMs > 0 && /^[a-f0-9]{64}$/.test(completion.sha256));
  assert(completion.finishedGuestUptimeMs - completion.startedGuestUptimeMs >= 10000);
  await client.execInstance("default", machineName, ["/bin/rm", "--", guestScript, guestMarker], signal);
  evidence.guestWorkload = { payloadSha256: hash(payload), idleObservationIds, completion };
 }
 if (kind === "native") {
  const probe = await exerciseRuntimeWorkloadUsage({ context, guardSocketPath, lxdSocketPath: socketPath, control,
   disposableRun: { githubHosted: true, companyId }, close: true, renew, signal });
  const accounting = await readWorkloadUsage(query, probe.permitId);
  probe.physicalSamples = calls.map((call) => call.args.p_request.sample);
  probe.firstPayerByReservation = Object.fromEntries(accounting.reservations.map((row) => [row.id,
   poolFallback && BigInt(row.from_standard_us) >= 1000000n ? fallbackMember : memberId]));
  evidence.reconciliation = verifyWorkloadUsage(accounting, probe); evidence.probe = probe; evidence.accounting = accounting;
 } else if (kind === "coding") {
  const original = await guard.latest(allocationId, signal); assert(original?.phase === "running");
  for (let n = 0; n < 3; n++) { await controller.observe(allocationId, signal); await delay(1100, undefined, { signal }); }
  if (renew) {
   log({ waitingForActualRenewal: true });
   await until(async () => {
    await controller.observe(allocationId, signal);
    const record = await guard.status(original.permit.permitId, signal);
    if (record.permit.generation > original.permit.generation) return true;
    await delay(4500, undefined, { signal }); return false;
   }, Boolean, 330000, "natural funded window renewal");
   const renewal = calls.at(-1); assert.equal(renewal.method, "qorpera_renew_coding_computer_permit");
   await control.call(renewal.method, structuredClone(renewal.args), signal);
   await controller.observe(allocationId, signal);
   evidence.checks.actualWindowRenewal = true; evidence.checks.exactRenewalReplay = true;
  }
  const beforeRestart = await guard.status(original.permit.permitId, signal);
  const last = calls.at(-1); assert.equal(last.method, "qorpera_checkpoint_coding_computer_permit"); await control.call(last.method, last.args, signal);
  controller = new CodingComputerController({ control, guard, client, clock: readPaidComputerHostClock, storage, owner: "exec-test" });
  await controller.initialize(signal); await controller.observe(allocationId, signal);
  assert.equal(calls.at(-1).args.p_request.sample.state, "gap");
  assert.equal((await guard.status(original.permit.permitId, signal)).deadlineUptimeMs, beforeRestart.deadlineUptimeMs);
  for (let n = 0; n < 2; n++) { await delay(1100, undefined, { signal }); await controller.observe(allocationId, signal); }
  await controller.stop(allocationId, signal);
  await until(() => guard.status(original.permit.permitId, signal), (record) => record.phase === "stopped" && record.stopReceipt, 45000, "guard stop");
  await controller.observe(allocationId, signal);
  const terminal = calls.at(-1); assert.equal(terminal.method, "qorpera_finish_coding_computer_permit"); await control.call(terminal.method, terminal.args, signal);
  const accounting = await readWorkloadUsage(query, original.permit.permitId), first = calls.find((call) => call.args.p_request.sample.state === "running").args.p_request.sample;
  const probe = { kind: "coding_machine", shape: evidence.shape, physicalId: first.physicalId, hostBootId: first.hostBootId, guestBootId: first.guestBootId,
   physicalSamples: calls.map((call) => call.args.p_request.sample), firstPayerByReservation: Object.fromEntries(accounting.reservations.map((row) => [row.id,
    poolFallback && BigInt(row.from_standard_us) >= 1000000n ? fallbackMember : memberId])) };
  evidence.reconciliation = verifyWorkloadUsage(accounting, probe); evidence.probe = probe; evidence.accounting = accounting;
 } else {
  const before = await client.readInstanceFile("default", machineName, "/proc/uptime", 128, signal);
  await delay(2200, undefined, { signal });
  const after = await client.readInstanceFile("default", machineName, "/proc/uptime", 128, signal);
  assert(Number(after.content.toString().split(" ")[0]) > Number(before.content.toString().split(" ")[0]));
  await client.setInstancePower("default", machineName, "stop", signal);
  assert.equal(await query("select count(*) from public.qorpera_coding_computer_permits;"), "0");
  assert.equal(await query("select coalesce(sum(debited_us+reserved_us),0) from public.qorpera_computer_allowance_buckets;"), "0");
  evidence.checks.physicalLoginAwakeButUncharged = true;
 }
 assert.equal((await client.getInstance("default", machineName, signal)).status, "Stopped");
 if (evidence.guestWorkload) {
  evidence.activityReconciliation = verifyWorkloadActivity(evidence.accounting, evidence.guestWorkload);
  evidence.checks.actualBusyGuestWorkload = true; evidence.checks.idleAndBusyUseSameTariff = true;
 }
 evidence.balancesAfter = await balances();
 for (const before of evidence.balancesBefore) {
  const after = evidence.balancesAfter.find((bucket) => bucket.id === before.id);
  assert.equal(after.issuedUs, before.issuedUs); assert.equal(after.reservedUs, "0");
  const charged = (evidence.accounting?.debits ?? []).filter((debit) => debit.bucket_id === before.id).reduce((sum, debit) => sum + BigInt(debit.debited_us), 0n);
  assert.equal(BigInt(after.debitedUs) - BigInt(before.debitedUs), charged, "Actual global balance drain differs from this physical VM's settlement");
 }
 if (poolFallback) {
  assert(evidence.accounting.reservations.every((reservation) => reservation.requested_by_user_id === memberId), "Test source must have the responsible member");
  const owner = evidence.balancesAfter.find((bucket) => bucket.userId === memberId), fallback = evidence.balancesAfter.find((bucket) => bucket.userId === fallbackMember);
  assert.equal(owner.debitedUs, owner.issuedUs, "Responsible balance did not drain first");
  assert(BigInt(fallback.debitedUs) > 0n, "No measured interval reached pooled fallback");
  evidence.checks.responsibleThenPoolActuallyDebited = true;
 }
 evidence.checks.physicalStop = true; evidence.passed = true;
} catch (error) {
 evidence.phase = phase; evidence.error = String(error); process.exitCode = 1;
} finally {
 try {
  if (machineName) {
   const physical = await client.getInstance("default", machineName, AbortSignal.timeout(10000));
   if (physical && physical.status !== "Stopped") await client.setInstancePower("default", machineName, "stop", AbortSignal.timeout(45000));
   if (physical) await client.deleteInstance("default", machineName, AbortSignal.timeout(60000));
  }
  await database?.close(); evidence.cleanup = true;
 } catch { evidence.cleanup = false; evidence.passed = false; process.exitCode = 1; }
 await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
 log({ passed: evidence.passed, cleanup: evidence.cleanup, error: evidence.error, reconciliation: evidence.reconciliation });
}
