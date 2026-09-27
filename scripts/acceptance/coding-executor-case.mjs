import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expandTestFixture } from "../test-hosted-db.mjs";
import { startNativePostgres } from "./native-postgres.mjs";
import { retainSecondCodingClaim } from "./workload-usage-shared.mjs";
import { readWorkloadUsage, verifyWorkloadUsage } from "./workload-usage-evidence.mjs";
import { assertWorkloadRun, assertWorkloadShape } from "./workload-usage-host.mjs";
import { assertCodingExecutorCleanup, assertCodingExecutorEvidence, codingFixtureRepository, codingReadinessProjection, codingGuardReadinessProjection, localCodingFixtureGit, waitForCodingWorkspace } from "./coding-executor-fixture.mjs";
import { CodingComputerController, CODING_COMPUTER_RPCS, CODING_EXECUTOR_RPCS, CODING_HOST_RPCS,
  LxdCodingExecutorHost, parseCodingSessionClaim, parseCodingTurnState, codingTurnScope,
  createCodingNasStorage, createCodingBrokerGitRunner, authorizeCodingCommand,
  cloudNativeToolOperationEnvelope, parseCloudNativeToolAuthority, PaidComputerGuardClient,
  readPaidComputerHostClock, LxdUnixClient, RuntimeNodeInventoryObserver, physicalHost,
  workloadUsageSamples } from "./coding-executor-tools.mjs";

// Actual physical executor boundaries; only model-run/source metadata and paid
// invoices are SQL fixtures. No model is invoked and nothing reaches GitHub.
const directory = dirname(fileURLToPath(import.meta.url));
const options = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(process.platform, "linux"); assert(process.getuid() > 0);
const provenance = await assertWorkloadRun({ githubHosted: true });
const { out, imageFingerprint, bootstrapSha256, nas, guest: guestPolicy, bareRepository } = options;
const cpuCount = 1, memoryBytes = 2 * 1024 ** 3;
assertWorkloadShape({ cpuCount, memoryBytes }, { cpuMillis: cpus().length * 1000, memoryBytes: totalmem() });
const companyId = "30000000-0000-4000-8000-000000000010", memberId = "30000000-0000-4000-8000-000000000001";
const environmentId = "30000000-0000-4000-8000-000000000020", nodeId = randomUUID(), owner = "exec-test";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const literal = (value) => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("base64")}','base64'),'UTF8')::jsonb`;
const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;
const service = `set local role service_role; set local request.jwt.claims='{"role":"service_role"}';`;
const signal = AbortSignal.timeout(16 * 60000), maintenanceStop = new AbortController();
const client = new LxdUnixClient(), executorSecret = randomBytes(48).toString("base64url");
const guard = new PaidComputerGuardClient("/run/qorpera-paid-computer-guard/control.sock");
const evidence = { schema: "qorpera.coding-executor-physical/v1", commit: provenance.commit,
  scope: "Production executor host, real NFS/virtiofs Git checkout and sandboxed session commands; fixture repository transport, logical model bindings and invoice funding. No model, GitHub publication, signed release-image or installed whole-service claim.",
  image: options.imageEvidence, exportPolicy: "identity-preserving-loopback-only", passed: false, cleanup: false,
  sessions: [], gitTransport: [], commands: [], checks: {}, rpcTrace: [] };
let database, host, controller, observer, maintenance, maintenanceFailure, allocationId, machineName, phase = "database";
const attached = new Set(), activeClaims = new Map(), calls = [], canonicalPermits = new Map();
async function until(read, accept, budget, label) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (maintenanceFailure) throw maintenanceFailure;
    const value = await read(); if (accept(value)) return value;
    await delay(500, undefined, { signal });
  }
  throw new Error(`CODING_EXECUTOR_ACCEPTANCE_TIMEOUT:${label}`);
}
try {
  database = await startNativePostgres({ binDirectory: "/usr/lib/postgresql/17/bin" });
  const query = database.query; evidence.migrationCount = database.migrationCount;
  const fixtures = new Map();
  for (const name of await readdir(join(directory, "../../supabase/tests")))
    if (name.endsWith(".test.sql")) fixtures.set(name, await readFile(join(directory, "../../supabase/tests", name), "utf8"));
  const fixture = expandTestFixture("396_runtime_coding_executor.test.sql", (name) => fixtures.get(name));
  const marker = "-- 1. Deployment policies belong to the executor;";
  assert(fixture.includes(marker));
  const base = retainSecondCodingClaim(fixture.slice(0, fixture.indexOf(marker)).replaceAll(",120);", ",900);"));
  await query(`${base}
    select pg_temp.path_claims('service_role');
    select public.qorpera_release_runtime_machine(id,provider_adapter,instance_sha256) from public.qorpera_runtime_machine_allocations where profile_id='${companyId}' and released_at is null;
    select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','coding-executor-acceptance-parent-final');
    select pg_temp.finish_job(run_id) from public.qorpera_runner_jobs where profile_id='${companyId}' and status in ('leased','running');
    insert into public.qorpera_company_computer_billing_modes(profile_id,mode) values('${companyId}','paid'); commit;`, { timeoutMs: 120000 });
  phase = "inventory";
  assert.equal((await client.inspectHostInventory(signal)).instances.length, 0);
  const server = await client.inspectOfficeServer("default", signal), clock = await readPaidComputerHostClock();
  const physical = { machineIdSha256: clock.hostMachineIdSha256, socketPath: "/var/snap/lxd/common/lxd/unix.socket",
    socketGid: options.socketGid, certificateSha256: server.certificateSha256, serverName: server.serverName,
    serverVersion: server.serverVersion, architecture: server.architecture };
  const inventory = { schema: "qorpera.runtime-node-inventory-policy/v1", nodeId, host: physical,
    operatingCpuMillis: 500, operatingMemoryBytes: 1024 ** 3, infrastructure: [] };
  const policySha256 = hash(JSON.stringify({ imageFingerprint, bootstrapSha256, physical, cpuCount, memoryBytes }));
  const vmPolicy = { providerId: "coding-acceptance", providerPolicySha256: policySha256, project: "default",
    imageFingerprint, bootstrapSha256, storagePool: "default", network: "lxdbr0", cpus: cpuCount, memoryBytes, rootDiskBytes: 30 * 1024 ** 3 };
  await query(`begin; ${service}
    select public.qorpera_configure_runtime_node(${literal({ schema: "qorpera.runtime-node-policy/v1", nodeId,
      machineIdSha256: physical.machineIdSha256, label: "coding-executor-acceptance", cpuMillis: cpus().length * 1000,
      memoryBytes: totalmem(), headroomCpuMillis: 500, headroomMemoryBytes: 2 * 1024 ** 3,
      standardCpuMillis: 1000, standardMemoryBytes: memoryBytes, enabled: true })},0);
    select public.qorpera_enroll_runtime_node_inventory(${literal(inventory)});
    select public.qorpera_enroll_runtime_node_provider('${nodeId}','${physical.machineIdSha256}','coding','coding-acceptance','${policySha256}',1000,${memoryBytes});
    select public.qorpera_configure_coding_vm_policy('${environmentId}','${owner}',${literal(vmPolicy)});
    select public.qorpera_configure_coding_nas_policy('${environmentId}','${owner}','${physical.machineIdSha256}',${literal(nas)});
    reset role; insert into public.qorpera_computer_executor_keys(environment_id,owner,machine_id_sha256,key_sha256)
    values('${environmentId}','${owner}','${physical.machineIdSha256}','${hash(executorSecret)}');
    select public.qorpera_map_computer_billing_customer('${memberId}','cus_CodingExecutorAcceptance');
    do $$ declare t timestamptz:=clock_timestamp()-interval '1 day'; begin
    perform public.qorpera_reconcile_computer_subscription('evt_CodingExecutorAcceptance',t,jsonb_build_object('subscriptionId','sub_CodingExecutorAcceptance','customerId','cus_CodingExecutorAcceptance','userId','${memberId}','planKey','basis','planVersion',1,'status','active','periodStart',t,'periodEnd',t+interval '1 month'));
    perform public.qorpera_fund_computer_invoice(jsonb_build_object('invoiceId','in_CodingExecutorAcceptance','subscriptionId','sub_CodingExecutorAcceptance','customerId','cus_CodingExecutorAcceptance','planKey','basis','planVersion',1,'periodStart',t,'periodEnd',t+interval '1 month','amountPaid',18500,'billingReason','subscription_create','status','paid','currency','dkk')); end $$; commit;`);
  const balance = async () => JSON.parse(await query("select jsonb_build_object('issuedUs',sum(issued_us)::text,'debitedUs',sum(debited_us)::text,'reservedUs',sum(reserved_us)::text) from public.qorpera_computer_allowance_buckets;"));
  evidence.balanceBefore = await balance();
  const allowed = new Set([...CODING_COMPUTER_RPCS, ...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS,
    "qorpera_runtime_node_inventory_context", "qorpera_observe_runtime_node_inventory", "qorpera_observe_runtime_node", "qorpera_observe_runtime_node_health",
    "qorpera_authorize_coding_command", "qorpera_authorize_coding_turn", "qorpera_begin_native_tool_operation", "qorpera_complete_native_tool_operation"]);
  const signatures = JSON.parse(await query(`select jsonb_agg(jsonb_build_object('name',p.proname,'required',p.pronargs-p.pronargdefaults,'args',
    (select jsonb_agg(jsonb_build_object('name',p.proargnames[a.n],'type',format_type(a.t,null)) order by a.n)
    from unnest(p.proargtypes::oid[]) with ordinality a(t,n)))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (${[...allowed].map(quoted).join(",")});`));
  const control = { async call(method, args, checked) {
    assert(allowed.has(method)); checked.throwIfAborted();
    const variants = signatures.filter((s) => s.name === method); assert.equal(variants.length, 1);
    const signature = variants[0], input = CODING_COMPUTER_RPCS.includes(method) ? { ...args, p_executor_secret: executorSecret } : args;
    const supplied = signature.args.filter((arg) => Object.hasOwn(input, arg.name));
    assert.deepEqual(Object.keys(input).sort(), supplied.map((arg) => arg.name).sort());
    assert(signature.args.slice(0, signature.required).every((arg) => Object.hasOwn(input, arg.name)));
    assert(supplied.every((arg) => /^[a-z_][a-z0-9_]*$/.test(arg.name) && ["uuid", "jsonb", "text", "integer", "bigint", "boolean"].includes(arg.type)));
    const typed = supplied.map((arg) => `${arg.name} ${arg.type}`).join(",");
    const parameters = supplied.map((arg) => `${arg.name}=>(select ${arg.name} from input)`).join(",");
    const trace = { method, state: "pending" }; evidence.rpcTrace.push(trace);
    if (evidence.rpcTrace.length > 128) evidence.rpcTrace.shift();
    let result;
    try {
      result = JSON.parse(await query(`begin; ${service} with input as (select * from jsonb_to_record(${literal(input)}) as args(${typed}))
        select coalesce(to_jsonb(public.${method}(${parameters})),'null'::jsonb); commit;`, { signal: checked }));
      trace.state = "completed";
      if (["qorpera_describe_coding_computer_permit", "qorpera_record_computer_guard_samples"].includes(method)) {
        trace.readiness = codingReadinessProjection(result);
        trace.workAdmission = method === "qorpera_describe_coding_computer_permit" && typeof args.p_request?.permitId === "string";
        if (typeof result?.permit?.permitId === "string") canonicalPermits.set(result.permit.permitId, result);
      }
    } catch (error) {
      trace.state = "failed";
      if (error.diagnostic) trace.diagnostic = error.diagnostic;
      throw error;
    }
    if (args.p_request?.sample || Array.isArray(args.p_request?.entries)) calls.push({ method, args: structuredClone(args) });
    return result;
  } };
  await physicalHost(inventory, signal);
  observer = new RuntimeNodeInventoryObserver(inventory, control);
  assert.equal((await observer.observe(signal)).state, "ready");
  const storage = createCodingNasStorage(nas), journalRoot = await storage.prepareControl(signal);
  controller = new CodingComputerController({ control, guard, client, clock: readPaidComputerHostClock,
    storage: { policy: nas, machineIdSha256: physical.machineIdSha256 }, owner });
  await controller.initialize(signal);
  host = new LxdCodingExecutorHost({ control, owner, machineIdSha256: physical.machineIdSha256,
    computerUsage: controller, vmPolicy, storagePolicy: nas, guest: guestPolicy, client, journalRoot,
    repositoryCredentials: { async withRepositoryToken(scope, repository, use, checked) {
      checked.throwIfAborted(); assert.equal(scope.companyId, companyId); assert.deepEqual(repository, codingFixtureRepository);
      assert(activeClaims.get(scope.workerId)?.leaseToken === scope.leaseToken);
      return use("fixture_credential_never_valid_remotely");
    } },
    runGit: localCodingFixtureGit({ bareRepository, runGit: createCodingBrokerGitRunner(), record: (r) => evidence.gitTransport.push(r) }) });
  maintenance = (async () => {
    const checked = AbortSignal.any([signal, maintenanceStop.signal]);
    try {
      while (!checked.aborted) {
        assert.equal((await observer.observe(checked)).state, "ready");
        await controller.maintain(checked);
        for (const claim of activeClaims.values()) {
          let until;
          try { until = await control.call("qorpera_heartbeat_coding_session", { p_worker_id: claim.workerId, p_lease_token: claim.leaseToken, p_lease_seconds: 300 }, checked); }
          catch (error) { if (activeClaims.get(claim.workerId) !== claim) continue; throw error; }
          assert.equal(typeof until, "string"); claim.leaseUntil = until;
          if (attached.has(claim.workerId)) {
            try { await host.refreshLease(claim, checked); }
            catch (error) { if (attached.has(claim.workerId) && error.message !== "CODING_MACHINE_UNAVAILABLE:COMPUTER_USAGE_NOT_READY") throw error; }
          }
        }
        await delay(5000, undefined, { signal: checked });
      }
    } catch (error) { if (!maintenanceStop.signal.aborted) maintenanceFailure = error; }
  })();
  const rpc = (method, args) => control.call(method, args, signal);
  const claimOne = async () => {
    const claim = parseCodingSessionClaim(await rpc("qorpera_claim_coding_session", { p_owner: owner, p_lease_seconds: 300 }));
    activeClaims.set(claim.workerId, claim); return claim;
  };
  const prepare = async (claim) => {
    const args = { p_worker_id: claim.workerId, p_lease_token: claim.leaseToken };
    const turn = parseCodingTurnState(await rpc("qorpera_describe_coding_turn", args), claim);
    const workspace = await waitForCodingWorkspace(() => {
      if (maintenanceFailure) throw maintenanceFailure;
      return host.prepareWorkspace(claim, turn, signal);
    }, signal);
    allocationId = workspace.vmId; machineName = `qorpera-coding-machine-${allocationId.replaceAll("-", "")}`;
    attached.add(claim.workerId); await host.refreshLease(claim, signal);
    await rpc("qorpera_record_coding_progress", { ...args, p_last_step: "Acceptance checkout ready", p_base_sha: workspace.baseSha, p_vm_allocation_id: workspace.vmId });
    return { claim, turn, workspace, scope: codingTurnScope(claim.workerId, workspace.vmId, claim.sequence) };
  };
  // Reuse the existing logical runner fixture only. It acquires actual SQL
  // authority; no model process/provider credential is executed or faked.
  const wake = fixtures.get("300_runtime_wake_bus.test.sql");
  const wakeStart = wake.slice(wake.indexOf("create function pg_temp.wake_start("), wake.indexOf("create function pg_temp.wake_public_send("));
  assert(wakeStart.startsWith("create function pg_temp.wake_start(") && wakeStart.includes("qorpera_accept_runner_assignment"));
  const begin = async (session) => {
    const begun = await rpc("qorpera_begin_coding_turn", { p_worker_id: session.claim.workerId, p_lease_token: session.claim.leaseToken,
      p_coding: { vmId: session.workspace.vmId, turnId: session.turn.turnId } });
    const value = await query(`begin; ${service}
      create function pg_temp.wake_assert(ok boolean,message text) returns void language plpgsql as $$ begin if not coalesce(ok,false) then raise exception '%',message; end if; end $$;
      ${wakeStart}
      select public.qorpera_materialize_wake_execution_runs(8);
      update public.qorpera_runner_jobs set created_at=clock_timestamp()-interval '1 day' where run_id=(select run_id from public.qorpera_wake_occurrences where id='${begun.occurrenceId}');
      select pg_temp.wake_start((select run_id from public.qorpera_wake_occurrences where id='${begun.occurrenceId}')); commit;`);
    session.binding = JSON.parse(value.split("\n").at(-1));
  };
  phase = "workspace_prepare";
  const sessions = [await prepare(await claimOne()), await prepare(await claimOne())];
  assert.equal(sessions[0].workspace.vmId, sessions[1].workspace.vmId);
  for (const session of sessions) {
    await begin(session);
    const configPath = `/run/qorpera-coding/${session.claim.workerId}/configuration/guest.json`;
    session.configuration = JSON.parse((await client.readInstanceFile("default", machineName, configPath, 8192, signal)).content.toString());
    evidence.sessions.push({ workerId: session.claim.workerId, vmId: session.workspace.vmId, uid: session.configuration.uid, baseSha: session.workspace.baseSha });
  }
  assert.notEqual(sessions[0].configuration.uid, sessions[1].configuration.uid);
  const command = async (session, text, timeoutMs = 30000, wait = true) => {
    const authority = await rpc("qorpera_authorize_coding_turn", { p_binding: session.binding });
    const parsed = parseCloudNativeToolAuthority({ schema: authority.schema, identity: authority.identity, validForMs: authority.validForMs }, session.binding);
    const commandId = randomUUID(), operationKey = commandId;
    const inputSha256 = hash(cloudNativeToolOperationEnvelope(parsed.identity, { tool: "coding_run_command", toolVersion: "v1", logicalOperationKey: operationKey,
      arguments: { operationKey, command: text, timeoutMs }, target: { schema: "qorpera.coding-command-target/v1", ...session.scope }, requiresCompanyRevision: false }));
    await rpc("qorpera_begin_native_tool_operation", { p_binding: session.binding, p_receipt_id: commandId,
      p_logical_operation_key: `coding_run_command:${operationKey}`, p_input_sha256: inputSha256, p_downstream_idempotency_sha256: hash(commandId), p_requires_company_revision: false });
    const request = { binding: session.binding, scope: session.scope, action: "start", input: { commandId, inputSha256, command: text, timeoutMs } };
    const transport = await host.commandTransport(session.scope, (action, scope, id, digest, checked) => authorizeCodingCommand(control,
      { binding: session.binding, scope, action, input: action === "start" ? request.input : action === "read" ? { commandId: id, offset: 0, limit: 16384 } : { commandId: id } }, checked), signal);
    const started = await transport.start(session.scope, request.input, signal);
    const finish = async () => {
      const result = await until(() => transport.read(session.scope, { commandId, offset: 0, limit: 16384 }, signal),
        (r) => ["succeeded", "failed", "cancelled", "unconfirmed"].includes(r.state), timeoutMs + 15000, "session command");
      assert.equal(result.state, "succeeded", result.output);
      assert.equal(result.exitCode, 0, result.output);
      const stored = { schema: "qorpera.cloud-tool-operation-result/v1", inputSha256, content: { kind: "json", value: result } };
      const completed = await rpc("qorpera_complete_native_tool_operation", { p_binding: session.binding, p_receipt_id: commandId, p_input_sha256: inputSha256, p_result: stored });
      assert.equal(completed.run_id, session.binding.runId); assert.equal(completed.receipt_id, commandId);
      assert.equal(completed.state, "completed"); assert.deepEqual(completed.result, stored);
      evidence.commands.push({ operationCompleted: true, workerId: session.claim.workerId, commandId, inputSha256, receipt: result });
      return result;
    };
    return wait ? finish() : { started, finish, transport };
  };
  phase = "real_git_and_isolation";
  for (const [index, session] of sessions.entries()) {
    const other = sessions[1 - index].claim.workerId;
    const deniedIo = `python3 - <<'PYDENIED'\nimport errno\nfor path, mode in [("/workspace/${other}/repository/value.txt", "r"), ("/workspace/${other}/repository/forbidden-write", "w"), ("/var/lib/qorpera-coding/${session.claim.workerId}/commands/forbidden-write", "w")]:\n try:\n  with open(path, mode) as f:\n   f.read(1) if mode == "r" else f.write("must-not-write")\n except OSError as error:\n  assert error.errno in (errno.EACCES, errno.EPERM, errno.ENOENT, errno.EROFS), error\n else:\n  raise RuntimeError("Protected I/O unexpectedly succeeded")\nprint("isolation-ok")\nPYDENIED`;
    const result = await command(session, `set -eu\ntest "$(id -u)" = ${session.configuration.uid}\nprintf 'changed-${index}\\n' > value.txt\ntest "$(cat value.txt)" = changed-${index}\ngit add value.txt\ngit -c user.name=Acceptance -c user.email=acceptance@example.invalid commit -m acceptance\ngit rev-parse HEAD\n${deniedIo}`);
    const commit = result.output.split("\n").find((line) => /^[a-f0-9]{40}$/.test(line)); assert(commit);
    Object.assign(evidence.sessions[index], { headSha: commit, editTestCommit: true, crossSessionDenied: result.output.includes("isolation-ok"), custodyWriteDenied: true });
  }
  const permit = await guard.latest(allocationId, signal); assert(permit?.usageRequired);
  assert.equal(await query(`select count(*) from public.qorpera_coding_computer_permits where allocation_id='${allocationId}';`), "1");
  assert.equal(await query(`select count(*) from public.qorpera_computer_usage_streams where allocation_id='${allocationId}';`), "1");
  const first = sessions[0], second = sessions[1];
  const retainedMarker = await readFile(`${nas.rootPath}/workers/${companyId}/${environmentId}/${first.claim.workerId}/data/.qorpera-volume.json`, "utf8");
  const running = await command(second, "set -eu\necho continuing\nsleep 12\ntest -f value.txt\necho continued-after-detach", 25000, false);
  phase = "detach_and_reuse";
  attached.delete(first.claim.workerId); await host.detachSession(first.claim, signal);
  await assert.rejects(host.commandTransport(first.scope, async () => { throw new Error("Must not authorize detached session"); }, signal), /CODING_HOST_TURN_NOT_PREPARED/);
  const other = await running.finish();
  evidence.detach = { otherSessionContinued: other.output.includes("continued-after-detach"), oldTransportRefused: true };
  const finishSource = async (session, outcome) => {
    activeClaims.delete(session.claim.workerId);
    // This only terminates the explicitly synthetic model-run fixture. All
    // physical custody and command effects already passed their real gates.
    await query(`begin; ${service} reset role;
      update public.qorpera_runner_jobs set status='completed',result='{}',finished_at=clock_timestamp(),lease_token_sha256=null,lease_expires_at=null where run_id='${session.binding.runId}';
      update public.qorpera_wake_occurrences set status='completed',finished_at=clock_timestamp() where run_id='${session.binding.runId}'; commit;`);
    return rpc("qorpera_complete_coding_turn", { p_worker_id: session.claim.workerId, p_lease_token: session.claim.leaseToken,
      p_outcome: outcome, p_summary: "Offline physical acceptance; no model or GitHub publication.", p_needs: outcome === "blocked" ? "Continue acceptance" : null });
  };
  await finishSource(first, "blocked"); activeClaims.delete(first.claim.workerId);
  await query(`begin; set local role authenticated; set local request.jwt.claims='{"role":"authenticated","sub":"${memberId}"}';
    select public.qorpera_answer_coding_session('${first.claim.workerId}','Continue acceptance','${randomUUID()}'); commit;`);
  const beforeSeeds = evidence.gitTransport.filter((r) => r.operation === "fetch").length;
  const reused = await prepare(await claimOne()); assert.equal(reused.claim.workerId, first.claim.workerId); await begin(reused);
  const recovered = await command(reused, "set -eu\ngit rev-parse HEAD\ntest \"$(cat value.txt)\" = changed-0\necho reuse-ok");
  evidence.reuse = { sameVm: reused.workspace.vmId === first.workspace.vmId,
    sameStorageMarker: retainedMarker === await readFile(`${nas.rootPath}/workers/${companyId}/${environmentId}/${first.claim.workerId}/data/.qorpera-volume.json`, "utf8"),
    sameCommit: recovered.output.includes(evidence.sessions[0].headSha), reseeded: evidence.gitTransport.filter((r) => r.operation === "fetch").length !== beforeSeeds };
  for (const session of [reused, second]) {
    attached.delete(session.claim.workerId); await host.detachSession(session.claim, signal);
    await finishSource(session, "failed"); activeClaims.delete(session.claim.workerId);
  }
  phase = "settlement";
  await controller.stop(allocationId, signal);
  await until(async () => { await controller.observe(allocationId, signal); return controller.manages(allocationId); }, (v) => !v, 60000, "sealed stop settlement");
  evidence.accounting = await readWorkloadUsage(query, permit.permit.permitId);
  const observed = workloadUsageSamples(calls), initial = observed.find((sample) => sample.state === "running"); assert(initial);
  evidence.reconciliation = verifyWorkloadUsage(evidence.accounting, { kind: "coding_machine", shape: { cpuMillis: 1000, memoryBytes },
    physicalId: initial.physicalId, hostBootId: initial.hostBootId, guestBootId: initial.guestBootId,
    shapeProvenance: { nodeId, providerKind: "coding", policySha256 }, physicalSamples: observed,
    firstPayerByReservation: Object.fromEntries(evidence.accounting.reservations.map((r) => [r.id, memberId])) });
  evidence.balanceAfter = await balance();
  evidence.reservedUsAfter = await query("select sum(reserved_us)::text from public.qorpera_computer_allowance_buckets;");
  assertCodingExecutorEvidence(evidence); evidence.passed = true;
} catch (error) {
  evidence.phase = phase; evidence.error = String(error).slice(0, 4000); process.exitCode = 1;
  // One bounded failure snapshot, not extra queries on each 500ms retry.
  // Read-only verdicts cannot bind, settle, extend or manufacture usage.
  if (database) {
    try {
      evidence.readinessFailure = { sql: JSON.parse(await database.query(`select coalesce(jsonb_agg(jsonb_build_object(
        'permitState',p.state,'generation',p.generation,'sampleState',p.last_sample->>'state',
        'sampleAgeMs',floor(extract(epoch from clock_timestamp()-(p.last_sample->>'observedAt')::timestamptz)*1000),
        'coverage',s.coverage,'sampleReady',public.qorpera_computer_sample_ready(p.id,p.last_sample),
        'workReady',public.qorpera_computer_work_ready(p.id),
        'allocationUnreleased',a.released_at is null,'allocationIdentityMatches',a.instance_sha256=p.instance_sha256,
        'nodeMatches',d.node_id=p.node_id,'nodeEnabled',n.enabled,
        'demandReserved',d.reserved_at is not null,'demandUnreleased',d.released_at is null,'demandUnsuspended',d.suspended_at is null,
        'reservationUnsettled',r.settled_at is null,'reservationAllocationMatches',r.allocation_id=p.allocation_id,
        'reservationEpochMatches',r.epoch=p.epoch,
        'beforeWorkDeadline',w.deadline-make_interval(secs=>w.stop_reserve_ms::double precision/1000)>clock_timestamp(),
        'hostBootMatches',p.last_sample->>'hostBootId'=p.host_boot_id::text,
        'guestBootMatches',p.last_sample->>'guestBootId'=p.guest_boot_id::text,
        'physicalMatches',p.last_sample->>'physicalId'=p.physical_id::text)), '[]')
        from (select * from public.qorpera_coding_computer_permits where profile_id='${companyId}' order by id limit 4) p
        left join public.qorpera_runtime_machine_allocations a on a.id=p.allocation_id
        left join public.qorpera_runtime_node_demands d on d.allocation_id=p.allocation_id
        left join public.qorpera_runtime_nodes n on n.id=d.node_id
        left join public.qorpera_coding_computer_windows w on w.permit_id=p.id and w.generation=p.generation
        left join public.qorpera_computer_allowance_reservations r on r.id=w.reservation_id
        left join public.qorpera_coding_computer_samples s on s.permit_id=p.id and s.observation_id=(p.last_sample->>'observationId')::uuid;`, {timeoutMs:10000})), guard: [] };
      for (const [permitId, canonical] of [...canonicalPermits].slice(-4)) {
        try {
          const checked = AbortSignal.timeout(10000);
          const record = await guard.status(permitId, checked), page = await guard.readUsage(permitId, {limit:1}, checked);
          evidence.readinessFailure.guard.push(codingGuardReadinessProjection(record, page, canonical, await readPaidComputerHostClock()));
        } catch { evidence.readinessFailure.guard.push({ unavailable: true }); }
      }
    } catch { evidence.readinessFailure = { unavailable: true }; }
  }
} finally {
  maintenanceStop.abort(); await maintenance;
  try {
    for (const claim of activeClaims.values()) await host?.detachSession(claim, AbortSignal.timeout(45000));
    if (allocationId && controller?.manages(allocationId)) {
      await controller.stop(allocationId, AbortSignal.timeout(45000));
      const deadline = Date.now() + 60000;
      while (controller.manages(allocationId) && Date.now() < deadline) { await controller.observe(allocationId, AbortSignal.timeout(10000)); await delay(1000); }
      assert(!controller.manages(allocationId), "Retain unsettled custody");
    }
    // A failed prepare may have reserved usage before returning its VM ID.
    // Audit every SQL hold and durable guard intent, even with zero VMs.
    if (database) {
      const custody = JSON.parse(await database.query(`select jsonb_build_object(
        'openReservations',(select count(*) from public.qorpera_computer_allowance_reservations where settled_at is null),
        'openPermits',(select count(*) from public.qorpera_coding_computer_permits where state<>'closed'),
        'closedPermitIds',coalesce((select jsonb_agg(id) from public.qorpera_coding_computer_permits where state='closed'),'[]'),
        'closedAttemptIds',coalesce((select jsonb_agg(permit_id) from public.qorpera_computer_prestart_attempts where closure is not null),'[]'));`));
      assertCodingExecutorCleanup(custody, await guard.listPrestarts(AbortSignal.timeout(10000)), await guard.list(AbortSignal.timeout(10000)));
      evidence.custodyClosed = true;
    }
    const instances = (await client.inspectHostInventory(AbortSignal.timeout(10000))).instances;
    assert(instances.length <= 1, "Unexpected physical instances; retain all custody");
    if (instances.length) {
      assert(machineName, "Unidentified VM must not be deleted");
      const vm = await client.getInstance("default", machineName, AbortSignal.timeout(10000)); assert.equal(vm?.status, "Stopped");
      await client.deleteInstance("default", machineName, AbortSignal.timeout(60000));
    }
    await database?.close(); evidence.cleanup = true;
  } catch (error) {
    await database?.close({ keepFiles: true });
    evidence.cleanupError = String(error).slice(0, 2000); evidence.cleanup = false; evidence.passed = false; process.exitCode = 1;
  }
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ phase, passed: evidence.passed, cleanup: evidence.cleanup, error: evidence.error }));
}
