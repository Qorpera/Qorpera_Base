import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const codingFixtureRepository = Object.freeze({ host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" });
export const codingFixtureRemote = "https://github.com/Qorpera/Qorpera_Base.git";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const uuidValue = (value) => { assert(typeof value === "string" && uuid.test(value), "CODING_EVIDENCE_UUID_INVALID"); return value; };
const hashValue = (value) => { assert(typeof value === "string" && sha256.test(value), "CODING_EVIDENCE_HASH_INVALID"); return value; };
const integerValue = (value) => { assert(Number.isSafeInteger(value) && value >= 0, "CODING_EVIDENCE_COUNTER_INVALID"); return value; };
const booleanValue = (value) => { assert(typeof value === "boolean", "CODING_EVIDENCE_BOOLEAN_INVALID"); return value; };
const boundedRows = (value) => { assert(Array.isArray(value) && value.length <= 8, "CODING_EVIDENCE_ROW_LIMIT"); return value; };
const exactFields = (value, fields) => {
  assert(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === fields.sort().join(), "CODING_EVIDENCE_FIELDS_INVALID");
};

/** Invoke the real retained transport. Count only this command's attempted
 * effects, so concurrent commands/maintenance do not manufacture a refusal.
 * Delegates retain their receiver, arguments, values and errors unchanged. */
export async function assertDetachedCodingTransport({ client, transport, scope, input }, signal) {
  uuidValue(scope.workerId); uuidValue(scope.vmId); uuidValue(scope.requestId); uuidValue(input.commandId); hashValue(input.inputSha256);
  const originalPush = client.pushInstanceFile, originalExec = client.execInstance;
  let staged = 0, dispatched = 0;
  client.pushInstanceFile = function(...args) {
    if (args[2] === `/var/lib/qorpera-coding/${scope.workerId}/inbox/${input.commandId}.json`) staged++;
    return originalPush.apply(this, args);
  };
  client.execInstance = function(...args) {
    if (Array.isArray(args[2]) && args[2][1] === "/opt/qorpera-coding/cloud-coding-command-guest.mjs" && args[2][4] === input.commandId) dispatched++;
    return originalExec.apply(this, args);
  };
  try {
    await assert.rejects(transport.start(scope, input, signal), (error) => error instanceof Error && error.message === "CODING_HOST_TURN_NOT_PREPARED");
    assert(staged === 0 && dispatched === 0, "CODING_DETACHED_TRANSPORT_EFFECT_ATTEMPTED");
    return { schema: "qorpera.coding-detached-transport/v1", workerId: scope.workerId, vmId: scope.vmId,
      requestId: scope.requestId, turn: integerValue(scope.turn), commandId: input.commandId, inputSha256: input.inputSha256,
      refusal: "CODING_HOST_TURN_NOT_PREPARED", stagingAttempts: staged, dispatchAttempts: dispatched };
  } finally { client.pushInstanceFile = originalPush; client.execInstance = originalExec; }
}

/** Query only the exact exercised command IDs, with a fixed projection. Raw
 * result text, logical bindings, lease material and arbitrary JSON stay in SQL. */
export async function readCodingOperationEvidence(query, commands) {
  boundedRows(commands); assert(commands.length > 0, "CODING_OPERATION_EVIDENCE_MISSING");
  const ids = commands.map((command) => uuidValue(command.commandId));
  assert(new Set(ids).size === ids.length, "CODING_OPERATION_EVIDENCE_DUPLICATE");
  const rows = JSON.parse(await query(`select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'runId',run_id,'jobId',job_id,'assignmentId',assignment_id,'operationKind',operation_kind,
    'inputSha256',input_sha256,'status',status,'completedAt',completed_at,
    'resultSchema',result->>'schema','resultInputSha256',result->>'inputSha256','contentKind',result#>>'{content,kind}',
    'receiptSchema',result#>>'{content,value,schema}','workerId',result#>>'{content,value,workerId}',
    'commandId',result#>>'{content,value,commandId}','receiptInputSha256',result#>>'{content,value,inputSha256}',
    'receiptState',result#>>'{content,value,state}','exitCode',result#>'{content,value,exitCode}',
    'outputSha256',encode(extensions.digest(convert_to(result#>>'{content,value,output}','UTF8'),'sha256'),'hex')
    ) order by id),'[]') from public.qorpera_run_operation_receipts where id in (${ids.map(id => `'${id}'::uuid`).join(",")});`));
  boundedRows(rows); assert(rows.length === commands.length, "CODING_OPERATION_EVIDENCE_MISSING");
  assert(new Set(rows.map(row => row.id)).size === rows.length, "CODING_OPERATION_EVIDENCE_DUPLICATE");
  for (const row of rows) {
    exactFields(row, ["id","runId","jobId","assignmentId","operationKind","inputSha256","status","completedAt",
      "resultSchema","resultInputSha256","contentKind","receiptSchema","workerId","commandId","receiptInputSha256","receiptState","exitCode","outputSha256"]);
    const command = commands.find(value => value.commandId === row.id);
    assert(command, "CODING_OPERATION_EVIDENCE_FOREIGN");
    for (const key of ["runId","jobId","assignmentId","workerId"]) assert(uuidValue(row[key]) === uuidValue(command[key]), "CODING_OPERATION_IDENTITY_DIFFERS");
    assert(row.commandId === row.id && row.operationKind === "cloud_tool" && row.status === "completed", "CODING_OPERATION_NOT_COMPLETED");
    assert(typeof row.completedAt === "string" && row.completedAt.length <= 40 && Number.isFinite(Date.parse(row.completedAt)), "CODING_OPERATION_COMPLETION_TIME_INVALID");
    assert([row.inputSha256,row.resultInputSha256,row.receiptInputSha256].every(value => hashValue(value) === command.inputSha256), "CODING_OPERATION_INPUT_DIFFERS");
    assert(row.resultSchema === "qorpera.cloud-tool-operation-result/v1" && row.contentKind === "json" && row.receiptSchema === "qorpera.coding-command-result/v2", "CODING_OPERATION_RESULT_INVALID");
    assert(row.receiptState === "succeeded" && row.exitCode === 0 && command.receipt.state === "succeeded" && command.receipt.exitCode === 0, "CODING_OPERATION_RESULT_FAILED");
    assert(hashValue(row.outputSha256) === createHash("sha256").update(command.receipt.output).digest("hex"), "CODING_OPERATION_OUTPUT_DIFFERS");
  }
  return { schema: "qorpera.coding-operation-evidence/v1", rows };
}

/** Captured immediately before successful controller archival removes the
 * active guard state. Every exported field has a bounded, closed type. */
export function codingTerminalGuardProjection(permitId, closure, prestart, record, page) {
  assert(closure.state === "closed" && record.phase === "stopped" && record.usageRequired === true, "CODING_TERMINAL_GUARD_NOT_STOPPED");
  assert(page.state === "sealed" && page.finalSequence > 0, "CODING_TERMINAL_USAGE_NOT_SEALED");
  for (const id of [closure.permitId,record.permit.permitId,prestart.intent.permitId,page.permitId]) assert(uuidValue(id) === uuidValue(permitId), "CODING_TERMINAL_PERMIT_DIFFERS");
  const cursor = (value) => ({ sequence: integerValue(value.sequence), sha256: hashValue(value.sha256), observationId: uuidValue(value.observationId) });
  const head = cursor(page.head), acknowledgedThrough = cursor(page.acknowledgedThrough);
  assert(JSON.stringify(head) === JSON.stringify(acknowledgedThrough) && head.sequence === page.finalSequence, "CODING_TERMINAL_USAGE_UNACKNOWLEDGED");
  assert(["dispatched","retired"].includes(prestart.state), "CODING_TERMINAL_PRESTART_INVALID");
  const stop = record.stopReceipt;
  assert(stop && ["stopped","absent"].includes(stop.state), "CODING_TERMINAL_STOP_RECEIPT_MISSING");
  const result = { schema: "qorpera.coding-terminal-guard/v1", permitId: uuidValue(permitId),
    allocationId: uuidValue(closure.allocationId), epoch: uuidValue(closure.epoch), generation: integerValue(closure.generation),
    reservationId: uuidValue(closure.reservationId), instanceSha256: hashValue(closure.instanceSha256),
    physicalId: uuidValue(record.machine.physicalInstanceId), hostBootId: uuidValue(closure.hostBootId),
    phase: "stopped", sqlState: "closed", startDispatched: booleanValue(record.startDispatched),
    startSettled: booleanValue(record.startSettled), startSucceeded: booleanValue(record.startSucceeded),
    prestart: { state: prestart.state, guardIncarnationId: uuidValue(prestart.guardIncarnationId), prepareSha256: hashValue(prestart.intent.prepareSha256) },
    stopReceipt: { permitId: uuidValue(stop.permitId), allocationId: uuidValue(stop.allocationId), generation: integerValue(stop.generation),
      instanceSha256: hashValue(stop.instanceSha256), physicalInstanceId: uuidValue(stop.physicalInstanceId),
      hostBootId: uuidValue(stop.hostBootId), closedHostBootId: uuidValue(stop.closedHostBootId),
      observedUptimeMs: integerValue(stop.observedUptimeMs), closedAtUptimeMs: integerValue(stop.closedAtUptimeMs),
      state: stop.state, operationId: stop.operationId === null ? null : uuidValue(stop.operationId) },
    usage: { state: "sealed", permitId: uuidValue(page.permitId), epoch: uuidValue(page.epoch), finalSequence: integerValue(page.finalSequence), head, acknowledgedThrough } };
  assert(result.startDispatched && result.startSettled && result.startSucceeded && result.generation > 0, "CODING_TERMINAL_START_UNCONFIRMED");
  assert(result.allocationId === record.machine.allocationId && result.allocationId === prestart.intent.allocationId && result.allocationId === stop.allocationId &&
    result.instanceSha256 === prestart.intent.instanceSha256 && result.instanceSha256 === stop.instanceSha256 && result.physicalId === stop.physicalInstanceId &&
    result.hostBootId === prestart.intent.hostBootId && result.hostBootId === stop.hostBootId && result.epoch === page.epoch &&
    result.permitId === stop.permitId && result.generation === stop.generation && closure.prestart?.guardIncarnationId === result.prestart.guardIncarnationId &&
    closure.prestart?.prepareSha256 === result.prestart.prepareSha256, "CODING_TERMINAL_IDENTITY_DIFFERS");
  return result;
}

/** Diagnostics never change archive authority, its arguments, result or error.
 * A capture failure is remembered and fails acceptance after real closure. */
export function observeCodingGuardArchive(guard) {
  const archive = guard.archive;
  const observations = new Map(); let failed = false;
  guard.archive = async function(permitId, closure, signal) {
    let observation;
    if (closure?.state === "closed") {
      try {
        uuidValue(permitId); assert(observations.size < 8 || observations.has(permitId), "CODING_EVIDENCE_ROW_LIMIT");
        observation = observations.get(permitId);
        if (!observation) {
          const checked = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
          observation = { ...codingTerminalGuardProjection(permitId, closure, await guard.prestartStatus(permitId, checked),
            await guard.status(permitId, checked), await guard.readUsage(permitId, { limit: 1 }, checked)), archiveAcknowledged: false };
          observations.set(permitId, observation);
        }
      } catch { failed = true; }
    }
    const result = await archive.call(this, permitId, closure, signal);
    if (observation) observation.archiveAcknowledged = true;
    return result;
  };
  return { evidence: () => ({ schema: "qorpera.coding-guard-archives/v1", captureFailed: failed, records: [...observations.values()] }) };
}

export function codingCleanupProjection(sql, intents, records) {
  assertCodingExecutorCleanup(sql, intents, records);
  assert(intents.every(value => ["dispatched","retired","abandoned"].includes(value.state)), "CODING_FINAL_PRESTART_STATE_INVALID");
  return { schema: "qorpera.coding-final-custody/v1", openReservations: integerValue(sql.openReservations), openPermits: integerValue(sql.openPermits),
    closedPermitIds: boundedRows(sql.closedPermitIds).map(uuidValue), closedAttemptIds: boundedRows(sql.closedAttemptIds).map(uuidValue),
    activePrestarts: boundedRows(intents).map(value => ({ permitId: uuidValue(value.intent.permitId), allocationId: uuidValue(value.intent.allocationId), state: value.state })),
    activeRecords: boundedRows(records).map(value => ({ permitId: uuidValue(value.permit.permitId), allocationId: uuidValue(value.machine.allocationId), phase: value.phase })) };
}

export function assertCodingExecutorRetainedEvidence(value) {
  const { accounting, operationEvidence, guardArchives, finalCustody } = value;
  for (const proof of [value.detach?.retainedTransportAfterDetach, value.reuse?.retainedTransportAfterReattach]) {
    assert(proof?.schema === "qorpera.coding-detached-transport/v1" && proof.refusal === "CODING_HOST_TURN_NOT_PREPARED" &&
      proof.stagingAttempts === 0 && proof.dispatchAttempts === 0, "CODING_RETAINED_TRANSPORT_PROOF_MISSING");
    assert(value.commands.some(command => command.workerId === proof.workerId && command.commandId === proof.commandId && command.inputSha256 === proof.inputSha256), "CODING_RETAINED_TRANSPORT_IDENTITY_DIFFERS");
  }
  assert(JSON.stringify(value.detach.retainedTransportAfterDetach) === JSON.stringify(value.reuse.retainedTransportAfterReattach), "CODING_RETAINED_TRANSPORT_CHANGED");
  assert(operationEvidence?.schema === "qorpera.coding-operation-evidence/v1" && operationEvidence.rows.length === 4 && value.commands.length === 4, "CODING_OPERATION_EVIDENCE_MISSING");
  assert(guardArchives?.schema === "qorpera.coding-guard-archives/v1" && !guardArchives.captureFailed && guardArchives.records.length === 1, "CODING_TERMINAL_GUARD_EVIDENCE_MISSING");
  const terminal = guardArchives.records[0], sample = accounting.samples.at(-1);
  assert(terminal.archiveAcknowledged && terminal.permitId === accounting.permit.id && terminal.allocationId === accounting.permit.allocation_id &&
    terminal.epoch === accounting.permit.epoch && terminal.generation === accounting.permit.generation && terminal.physicalId === accounting.permit.physical_id &&
    terminal.hostBootId === accounting.permit.host_boot_id && terminal.usage.head.sequence === sample.sequence &&
    terminal.usage.head.observationId === sample.sample.observationId && terminal.stopReceipt.state === sample.sample.state, "CODING_TERMINAL_SQL_IDENTITY_DIFFERS");
  assert(finalCustody?.schema === "qorpera.coding-final-custody/v1" && finalCustody.openReservations === 0 && finalCustody.openPermits === 0 &&
    finalCustody.activePrestarts.length === 0 && finalCustody.activeRecords.length === 0 && finalCustody.closedPermitIds.includes(terminal.permitId), "CODING_FINAL_CUSTODY_NOT_EMPTY");
}

/** Match the executor's bounded retry only for a complete PostgreSQL busy
 * refusal. The native adapter already parsed the one actual ERROR record;
 * timeout/transport uncertainty and other SQL failures never enter this lane. */
export async function beginCodingFixtureTurn(begin, leaseUntil, signal, {
  now = Date.now, pause = (ms) => delay(ms, undefined, {signal}), random = Math.random,
} = {}) {
  const admitBy = Date.parse(leaseUntil);
  assert(Number.isFinite(admitBy), "Invalid original coding lease");
  for(let attempt=0;;attempt++) {
    signal.throwIfAborted();
    if(now() >= admitBy) throw new Error("CODING_EXECUTOR_ACCEPTANCE_TIMEOUT:turn admission");
    try { return await begin(); }
    catch(error) {
      const wait = Math.min(2000,250 * 2 ** Math.min(attempt,3)) * (0.5 + random()/2);
      if(error?.diagnostic?.sqlState !== "55P03" || now() + wait >= admitBy) throw error;
      await pause(wait);
    }
  }
}

/** Accepted stop dispatch is not physical or financial closure. Observe the
 * same guard until stopped; only the controller's sealed-prefix ACK/finish
 * may release its managed permit. No synthetic stop or settlement is added. */
export async function settleCodingFixtureStop({allocationId,permitId,guard,controller},signal,{
  now = () => performance.now(), pause = (ms) => delay(ms,undefined,{signal}),
}={}) {
  const deadline=now()+60000, checked=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
  while(controller.manages(allocationId)) {
    checked.throwIfAborted();
    if(now()>=deadline) throw new Error("CODING_EXECUTOR_ACCEPTANCE_TIMEOUT:sealed stop settlement");
    const record=await guard.status(permitId,checked);
    assert.equal(record.permit.permitId,permitId,"Stop permit changed");
    assert.equal(record.machine.allocationId,allocationId,"Stop allocation changed");
    assert(["stopping","stopped"].includes(record.phase),"Stop custody is not terminalizing");
    if(record.phase==="stopped") await controller.observe(allocationId,checked);
    if(controller.manages(allocationId)) await pause(500);
  }
}

/** A fresh scan is required after this exact stale-context publication. The
 * production observer service retries scans; one rejected snapshot must not
 * permanently stop this harness's inventory loop. No stale result is ready. */
export async function observeCodingInventory(observe, publicationDiagnostic) {
  try {
    assert.equal((await observe()).state, "ready");
    return "ready";
  } catch (error) {
    const diagnostic = publicationDiagnostic();
    if (error.message === "NODE_OBSERVER_UNCONFIRMED" && diagnostic?.sqlState === "PGRST" &&
      diagnostic?.messageSha256 === "cdb872cf2da33ad6c9453e77b61887bf8435e859185e086dbe5b3ab3faaa3099") return "retry";
    throw error;
  }
}

/** Every requester gets a new serialized physical scan. A post-boot caller
 * cannot reuse the successful empty-host scan from before VM creation. */
export function createCodingInventoryRefresh(observe, publicationDiagnostic, {
  now = () => performance.now(), pause = (ms, signal) => delay(ms, undefined, {signal}), onRetry = () => {},
} = {}) {
  let pending = Promise.resolve();
  return (caller) => {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]), deadline = now() + 30000;
    const work = pending.catch(() => undefined).then(async () => {
      for (;;) {
        signal.throwIfAborted();
        if(now() >= deadline) throw new Error("CODING_INVENTORY_REFRESH_TIMEOUT");
        if(await observeCodingInventory(()=>observe(signal), publicationDiagnostic)==="ready") return;
        onRetry();
        await pause(5000,signal);
      }
    });
    pending = work;
    return work;
  };
}

// Explicit projections only: RPC/guard objects also contain retained intent,
// bindings and credentials. Never spread them into acceptance diagnostics.
export function codingReadinessProjection(value, now = Date.now()) {
  const permit = value?.permit, sample = value?.lastSample;
  const age = now - Date.parse(sample?.observedAt);
  return {
    workReady: typeof value?.workReady === "boolean" ? value.workReady : null,
    permitState: ["prepared", "bound", "closed"].includes(permit?.state) ? permit.state : null,
    generation: Number.isSafeInteger(permit?.generation) && permit.generation > 0 ? permit.generation : null,
    sampleState: ["running", "gap", "stopped", "absent"].includes(sample?.state) ? sample.state : null,
    sampleAgeMs: Number.isSafeInteger(age) && Math.abs(age) <= 86400000 ? age : null,
    samplePhysicalMatches: typeof sample?.physicalId === "string" && sample.physicalId === permit?.physicalId,
    sampleHostBootMatches: typeof sample?.hostBootId === "string" && sample.hostBootId === permit?.hostBootId,
    sampleGuestBootMatches: typeof sample?.guestBootId === "string" && sample.guestBootId === permit?.guestBootId,
  };
}

export function codingGuardReadinessProjection(record, page, canonical, clock) {
  const bounded = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const age = clock?.uptimeMs - canonical?.lastSample?.hostUptimeMs;
  return {
    phase: ["armed", "starting", "running", "stopping", "stopped"].includes(record?.phase) ? record.phase : null,
    usageRequired: record?.usageRequired === true,
    usageState: ["open", "sealed", "unconfirmed"].includes(page?.state) ? page.state : null,
    headSequence: bounded(page?.head?.sequence), acknowledgedSequence: bounded(page?.acknowledgedThrough?.sequence),
    headAcknowledged: typeof page?.head?.sha256 === "string" && page.head.sha256 === page?.acknowledgedThrough?.sha256 && page.head.sequence === page?.acknowledgedThrough?.sequence,
    headMatchesCanonical: typeof page?.head?.observationId === "string" && page.head.observationId === canonical?.lastSample?.observationId,
    permitMatchesCanonical: typeof record?.permit?.permitId === "string" && record.permit.permitId === canonical?.permit?.permitId,
    generationMatchesCanonical: Number.isSafeInteger(record?.permit?.generation) && record.permit.generation === canonical?.permit?.generation,
    physicalMatchesCanonical: typeof record?.machine?.physicalInstanceId === "string" && record.machine.physicalInstanceId === canonical?.lastSample?.physicalId,
    hostBootMatchesCanonical: typeof clock?.hostBootId === "string" && clock.hostBootId === canonical?.permit?.hostBootId,
    sampleHostAgeMs: Number.isSafeInteger(age) && Math.abs(age) <= 86400000 ? age : null,
    beforeStop: Number.isSafeInteger(clock?.uptimeMs) && Number.isSafeInteger(record?.stopAtUptimeMs) && clock.uptimeMs < record.stopAtUptimeMs,
  };
}

/** The production host separately bounds VM creation/boot. Start the metering
 * convergence budget only when that path actually reports its prerequisite. */
export async function waitForCodingWorkspace(prepare, signal, { now = () => performance.now(), pause = (ms) => delay(ms, undefined, { signal }) } = {}) {
  let deadline = null;
  for (;;) {
    signal.throwIfAborted();
    if (deadline !== null && now() >= deadline) throw new Error("CODING_EXECUTOR_ACCEPTANCE_TIMEOUT:initial independent paid sample");
    try { return await prepare(); }
    catch (error) {
      if (error.message !== "CODING_MACHINE_UNAVAILABLE:COMPUTER_USAGE_NOT_READY") throw error;
      deadline ??= now() + 45000;
    }
    await pause(500);
  }
}

/** The only substitute: the fixture's two read-only remote Git operations.
 * The real broker still executes every Git operation in its Linux sandbox.
 * It receives no network namespace and no HTTP credential for these reads. */
export function localCodingFixtureGit({ bareRepository, runGit, record = () => {} }) {
  assert(isAbsolute(bareRepository) && typeof runGit === "function");
  return async (input) => {
    if (!input.network) return runGit(input);
    const remoteIndex = input.args.indexOf(codingFixtureRemote);
    assert(remoteIndex >= 0 && input.args.lastIndexOf(codingFixtureRemote) === remoteIndex, "Only the exact local fixture remote is supported");
    const lookup = input.args.slice(-5).join("\0") === ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/master"].join("\0");
    const fetch = input.args.slice(-6).join("\0") === ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", codingFixtureRemote, "refs/heads/master:refs/heads/master"].join("\0");
    assert(lookup || fetch, "Fixture transport cannot push, change refs or access arbitrary URLs");
    assert(input.args.filter((arg) => /^https?:|^file:|^ssh:/.test(arg)).length === 1);
    assert.equal(input.env.GIT_CONFIG_COUNT, "1");
    assert.equal(input.env.GIT_CONFIG_KEY_0, `http.${codingFixtureRemote}.extraHeader`);
    assert(/^Authorization: Basic [A-Za-z0-9+/=]+$/.test(input.env.GIT_CONFIG_VALUE_0));
    assert(isAbsolute(input.scratchRoot) && isAbsolute(input.cwd));
    const child = relative(input.scratchRoot, input.cwd);
    assert(child !== ".." && !child.startsWith("../") && !isAbsolute(child));
    const copied = join(await mkdtemp(join(input.scratchRoot, ".acceptance-remote-")), "repository.git");
    const source = await lstat(bareRepository);
    assert(source.isDirectory() && !source.isSymbolicLink());
    await cp(bareRepository, copied, { recursive: true, errorOnExist: true, force: false });
    const env = { ...input.env, GIT_ALLOW_PROTOCOL: "file" };
    delete env.GIT_CONFIG_COUNT; delete env.GIT_CONFIG_KEY_0; delete env.GIT_CONFIG_VALUE_0;
    const args = input.args.map((arg) => arg === codingFixtureRemote ? copied : arg);
    args.unshift("-c", "protocol.file.allow=always");
    record({ operation: lookup ? "ls-remote" : "fetch", remote: codingFixtureRemote, network: false });
    return runGit({ ...input, network: false, args, env });
  };
}

export function assertCodingExecutorEvidence(value) {
  assert.equal(value.schema, "qorpera.coding-executor-physical/v1");
  assert.equal(value.sessions.length, 2);
  assert.equal(new Set(value.sessions.map((s) => s.uid)).size, 2);
  assert(value.sessions.every((s) => Number.isInteger(s.uid) && s.uid >= 200000 && s.editTestCommit && s.crossSessionDenied && s.custodyWriteDenied));
  assert.equal(new Set(value.sessions.map((s) => s.vmId)).size, 1);
  assert.equal(value.reuse.sameVm, true); assert.equal(value.reuse.sameStorageMarker, true);
  assert.equal(value.reuse.sameCommit, true); assert.equal(value.reuse.reseeded, false);
  assert.equal(value.detach.otherSessionContinued, true); assert.equal(value.detach.oldTransportRefused, true);
  assert.equal(value.accounting.permit.state, "closed");
  assert(value.reconciliation && BigInt(value.reconciliation.debitedUs) > 0n);
  assert.equal(value.reservedUsAfter, "0");
  assert.equal(value.balanceBefore.issuedUs, value.balanceAfter.issuedUs);
  assert.equal(value.balanceBefore.reservedUs, "0"); assert.equal(value.balanceAfter.reservedUs, "0");
  assert.equal(BigInt(value.balanceAfter.debitedUs) - BigInt(value.balanceBefore.debitedUs), BigInt(value.reconciliation.debitedUs));
}

/** Absence of a VM is not proof that an admitted start cannot arrive later. */
export function assertCodingExecutorCleanup(sql, intents, records) {
  assert.equal(sql.openReservations, 0, "Unsettled allowance custody must be retained");
  assert.equal(sql.openPermits, 0, "Open permit custody must be retained");
  const closed = new Set([...sql.closedPermitIds, ...sql.closedAttemptIds]);
  for (const intent of intents) {
    assert.notEqual(intent.state, "registered", "Undispatched intent requires durable cancellation before cleanup");
    assert(closed.has(intent.intent.permitId), "Guard intent has no confirmed SQL closure");
  }
  for (const record of records) {
    assert.equal(record.phase, "stopped", "Physical custody has not stopped");
    assert(record.stopReceipt && closed.has(record.permit.permitId), "Physical stop requires matching SQL closure");
  }
}

/** Stop only this harness process group. Independent systemd custody survives. */
export function waitForCodingChild(child, { timeoutMs, graceMs = 10000, kill = (signal) => child.kill(signal) }) {
  return new Promise((resolve, reject) => {
    let expired = false, escalation, final;
    const finish = (error, code) => {
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(final);
      child.removeListener("error", onError); child.removeListener("close", onClose);
      if (error) reject(error); else resolve(code);
    };
    const onError = (error) => finish(error);
    const onClose = (code) => finish(expired ? new Error("Coding executor timed out; custody retained") : null, code);
    const timer = setTimeout(() => {
      expired = true;
      try { kill("SIGTERM"); } catch (error) { finish(error); return; }
      escalation = setTimeout(() => {
        try { kill("SIGKILL"); } catch (error) { finish(error); return; }
        final = setTimeout(() => { child.unref(); finish(new Error("Coding executor exit unconfirmed; custody retained")); }, graceMs);
      }, graceMs);
    }, timeoutMs);
    child.once("error", onError); child.once("close", onClose);
  });
}

/** VM device names are selected by the guest; do not assume container eth0. */
export function codingImageAddress(addresses, routes, bridgeCidr) {
  const defaults = routes.filter((route) => route.dst === "default");
  if (defaults.length === 0) return null;
  assert.equal(defaults.length, 1, "Ambiguous guest default route");
  const device = defaults[0].dev;
  assert(typeof device === "string" && /^[a-zA-Z0-9_.:-]{1,32}$/.test(device));
  const candidates = addresses.filter((link) => link.ifname === device).flatMap((link) => link.addr_info ?? [])
    .filter((entry) => entry.family === "inet" && entry.scope === "global");
  if (candidates.length === 0) return null;
  assert.equal(candidates.length, 1, "Ambiguous guest IPv4 address");
  const numeric = (ip) => {
    assert(typeof ip === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip));
    const bytes = ip.split(".").map(Number); assert(bytes.every((b) => b >= 0 && b <= 255));
    return bytes.reduce((sum, byte) => sum * 256 + byte, 0);
  };
  const [bridge, prefix] = bridgeCidr.split("/");
  assert(/^\d+$/.test(prefix) && Number(prefix) >= 8 && Number(prefix) <= 30);
  assert.equal(Math.floor(numeric(candidates[0].local) / 2 ** (32 - Number(prefix))),
    Math.floor(numeric(bridge) / 2 ** (32 - Number(prefix))), "Guest address is outside the managed bridge");
  return { device, address: candidates[0].local };
}

/** Select an already protected task parent; never repair global host paths. */
export function assertCodingFixtureParents(parents) {
  assert.deepEqual(parents.map((entry) => entry.path), ["/", "/var", "/var/lib"]);
  for (const entry of parents) {
    assert(entry.directory && !entry.symlink && entry.canonical === entry.path, "Fixture ancestor must be a canonical directory");
    assert.equal(entry.uid, 0, "Fixture ancestor must remain root owned");
    assert.equal(entry.mode & 0o022, 0, "Fixture ancestor must not be group/world writable");
  }
}
