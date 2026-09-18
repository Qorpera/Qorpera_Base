import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { FIXED, MUTATIONS, ROOT, STEPS, classifyReconciliation, exact, hash, isSha, isUtc, need, pinValid, stepIndex, validateReadback } from './contract.mjs';
import { assertAbsent, assertDirectory, readTrusted, writeExclusive } from './files.mjs';
import { verifySources } from './build-packet.mjs';
import { buildSQL, reconciliationSQL } from './sql-packet.mjs';
import { CLI_SHA256, capture, verifyCli } from './transport.mjs';

export const READY = false;
export const PACKET_SHA256 = null;
export const LOCAL_PINS = Object.freeze({});
// Not timestamps or acceptance flags. Main must review/preserve the actual public
// receipts and separately freeze their literal hashes in an activation successor.
export const RELEASE_PINS = Object.freeze({ executionWindow: null, sourceAcceptance: null, physicalFence: null, disabledInstallation: null });
export const EVIDENCE = `${ROOT}/evidence`;
const artifact = (step, kind, reconciliation = false) => `rollout-${reconciliation ? 'reconcile-' : ''}${step}-${kind}.json`;
const CONTEXT = Object.freeze({ projectRef: FIXED.project, companyId: FIXED.company, environmentId: FIXED.environment,
  sourceCommit: FIXED.commit, runtimeBundleSha256: FIXED.bundle });
const noReady = () => ({ passed: false, code: 'DISPATCH_DISABLED', cliInvocations: 0, productionWrites: false, automaticReplayAllowed: false });

export function parseEnvelope(bytes) {
  need(Buffer.isBuffer(bytes), 'CLI_BUFFER_REJECTED');
  try {
    need(bytes.length > 0 && bytes.length <= 256 * 1024, 'CLI_SIZE_REJECTED');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    need(Array.isArray(value) && value.length === 1 && exact(value[0], ['readback']), 'CLI_ENVELOPE_REJECTED');
    return value[0].readback;
  } finally { bytes.fill(0); }
}
export function validateWindow(value, packetSha256, releasePins, now) {
  need(exact(value, ['schema', ...Object.keys(CONTEXT), 'packetSha256', 'issuedAt', 'expiresAt', 'operator',
    'globalOpenAIPolicyPauseAcknowledged', 'sourceAcceptanceSha256', 'physicalFenceSha256', 'disabledInstallationSha256']), 'WINDOW_SHAPE_REJECTED');
  need(value.schema === 'qorpera.company41-production-rollout-window/v1' && Object.entries(CONTEXT).every(([key, expected]) => value[key] === expected)
    && value.packetSha256 === packetSha256 && value.operator === 'Jonas.mk@qorpera.com' && value.globalOpenAIPolicyPauseAcknowledged === true, 'WINDOW_SCOPE_REJECTED');
  need(isUtc(value.issuedAt) && isUtc(value.expiresAt) && Date.parse(value.issuedAt) <= now && now < Date.parse(value.expiresAt)
    && Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 0 && Date.parse(value.expiresAt) - Date.parse(value.issuedAt) <= 2 * 60 * 60 * 1000, 'WINDOW_TIME_REJECTED');
  for (const key of ['sourceAcceptance', 'physicalFence', 'disabledInstallation']) need(isSha(releasePins[key]) && value[`${key}Sha256`] === releasePins[key], 'WINDOW_GATE_PIN_REJECTED');
  return value;
}
export function checkPacket() {
  assertDirectory(ROOT);
  need(isSha(PACKET_SHA256) && LOCAL_PINS && Object.keys(LOCAL_PINS).length === 6, 'LOCAL_PINS_UNFROZEN');
  for (const [name, pin] of Object.entries(LOCAL_PINS)) need(['contract.mjs', 'files.mjs', 'sql-packet.mjs', 'build-packet.mjs', 'transport.mjs', 'inputs.json'].includes(name)
    && isSha(pin) && hash(readTrusted(join(ROOT, name))) === pin, 'LOCAL_FILE_CHANGED');
  const verified = verifySources(), bytes = readTrusted(join(ROOT, 'packet.json'));
  need(hash(bytes) === PACKET_SHA256, 'PACKET_CHANGED');
  const packet = JSON.parse(bytes);
  need(packet.schema === 'qorpera.company41-production-rollout-packet/v1' && packet.inputSha256 === hash(readTrusted(join(ROOT, 'inputs.json')))
    && isDeepStrictEqual(packet.mutations, MUTATIONS), 'PACKET_REJECTED');
  const names = [...STEPS.map(step => `${step}.sql`), ...MUTATIONS.map(step => `reconcile-${step}.sql`)];
  need(exact(packet.sql, names), 'SQL_INVENTORY_REJECTED');
  for (const step of STEPS) {
    const name = `${step}.sql`, current = readTrusted(join(ROOT, 'sql', name));
    need(pinValid(packet.sql[name]) && current.length === packet.sql[name].bytes && hash(current) === packet.sql[name].sha256
      && current.equals(Buffer.from(buildSQL(step, verified.migrations.get(step)))), 'SQL_CHANGED');
  }
  for (const step of MUTATIONS) {
    const name = `reconcile-${step}.sql`, current = readTrusted(join(ROOT, 'sql', name));
    need(pinValid(packet.sql[name]) && current.length === packet.sql[name].bytes && hash(current) === packet.sql[name].sha256
      && current.equals(Buffer.from(reconciliationSQL(step))), 'SQL_CHANGED');
  }
  return packet;
}
function release(packet) {
  need(Object.values(RELEASE_PINS).every(isSha), 'ACTUAL_GATE_BINDINGS_UNISSUED');
  assertDirectory(join(ROOT, 'release'));
  const pins = {};
  for (const [key, expected] of Object.entries(RELEASE_PINS)) {
    const bytes = readTrusted(join(ROOT, 'release', `${key}.json`)); need(hash(bytes) === expected, 'RELEASE_BYTES_CHANGED');
    pins[key] = { bytes: bytes.length, sha256: expected };
    if (key === 'executionWindow') validateWindow(JSON.parse(bytes), PACKET_SHA256, RELEASE_PINS, Date.now());
  }
  need(packet.executionEnabled === false && packet.actualProductionReadbacks.length === 0, 'DECLARATIVE_PACKET_CHANGED');
  return pins;
}
export async function executeCore({ step, reconciliation = false, preflight, write, invoke, postcheck, now = () => new Date().toISOString() }) {
  stepIndex(step); need(!reconciliation || MUTATIONS.includes(step), 'RECONCILIATION_REJECTED');
  let stage = 'preflight', invoked = false, reserved = false, raw = null, before;
  try {
    before = await preflight();
    need(exact(before, ['packetSha256', 'sqlSha256', 'windowPin', 'predecessor', 'externalReceiptPins'])
      && isSha(before.packetSha256) && isSha(before.sqlSha256) && pinValid(before.windowPin)
      && (before.predecessor === null || pinValid(before.predecessor))
      && exact(before.externalReceiptPins, Object.keys(RELEASE_PINS)) && Object.values(before.externalReceiptPins).every(pinValid), 'PREFLIGHT_RESULT_REJECTED');
    stage = 'intent';
    const intent = await write(artifact(step, 'intent', reconciliation), { schema: 'qorpera.production-rollout-intent/v1', at: now(), ...CONTEXT,
      step, reconciliation, packetSha256: before.packetSha256, sqlSha256: before.sqlSha256, windowPin: before.windowPin,
      predecessor: before.predecessor, externalReceiptPins: before.externalReceiptPins,
      cliSha256: CLI_SHA256, globalOpenAIPolicyScope: true, maximumLocalInvocations: 1, automaticReplayAllowed: false });
    need(pinValid(intent), 'INTENT_UNCONFIRMED'); reserved = true;
    stage = 'private-invocation'; invoked = true;
    const captured = await invoke(); raw = captured?.bytes;
    need(captured?.ok === true && captured?.processGroupAbsent === true, 'TRANSPORT_UNCONFIRMED');
    stage = 'readback'; const candidate = parseEnvelope(raw); raw = null;
    let readback = null, classification = null;
    if (reconciliation) {
      classification = classifyReconciliation(candidate, step);
      if (classification !== 'unmatched-or-unknown') readback = candidate;
    } else readback = validateReadback(candidate, step);
    stage = 'postcheck'; await postcheck(before);
    const result = { schema: reconciliation ? 'qorpera.production-rollout-reconciliation/v1' : 'qorpera.production-rollout-step/v1',
      passed: reconciliation ? classification !== 'unmatched-or-unknown' : true, at: now(), ...CONTEXT, step, intent,
      packetSha256: before.packetSha256, sqlSha256: before.sqlSha256, windowPin: before.windowPin, externalReceiptPins: before.externalReceiptPins,
      readback, classification, cliSha256: CLI_SHA256, cliInvocations: 1, databaseTransportAttemptCountKnown: false, processGroupAbsent: true,
      transactionReadbackMatched: !reconciliation, originalAttemptStillUnconfirmed: reconciliation,
      externalReceiptBytesMatched: true, externalGateClaimsReperformedHere: false,
      productionMutationAttempted: !reconciliation && MUTATIONS.includes(step), productionReady: false,
      admissionReopened: false, bootstrapExecuted: false, automaticReplayAllowed: false,
      rawDiagnosticsReturned: false, credentialValuesReturned: false };
    stage = 'preserve'; const pin = await write(artifact(step, 'result', reconciliation), result); need(pinValid(pin), 'RESULT_UNCONFIRMED');
    return { record: result, pin };
  } catch {
    if (Buffer.isBuffer(raw)) raw.fill(0);
    const failure = { schema: 'qorpera.production-rollout-failure/v1', passed: false, at: now(), ...CONTEXT, step, reconciliation,
      stage, code: 'STEP_UNCONFIRMED', cliInvocations: invoked ? 1 : 0,
      mutationMayHaveCommitted: invoked && !reconciliation && MUTATIONS.includes(step), rollbackConfirmed: false,
      productionReady: false, admissionReopened: false, automaticReplayAllowed: false, rawDiagnosticsReturned: false, credentialValuesReturned: false };
    if (reserved) try { return { record: failure, pin: await write(artifact(step, 'failure', reconciliation), failure) }; } catch {}
    return { record: failure, pin: null };
  }
}
function localPreflight(step, reconciliation) {
  const packet = checkPacket(), receiptPins = release(packet); verifyCli();
  assertDirectory(EVIDENCE);
  for (const kind of ['intent', 'result', 'failure']) assertAbsent(join(EVIDENCE, artifact(step, kind, reconciliation)));
  let predecessor = null;
  if (reconciliation) {
    const originalIntent = readTrusted(join(EVIDENCE, artifact(step, 'intent')));
    const value = JSON.parse(originalIntent); need(value.step === step && value.schema === 'qorpera.production-rollout-intent/v1'
      && value.packetSha256 === PACKET_SHA256 && value.windowPin.sha256 === RELEASE_PINS.executionWindow, 'ORIGINAL_INTENT_REJECTED');
    predecessor = { bytes: originalIntent.length, sha256: hash(originalIntent) };
    // Reconciliation never promotes or overwrites this original result/failure.
  } else if (step !== 'preflight') {
    const previous = STEPS[stepIndex(step) - 1];
    assertAbsent(join(EVIDENCE, artifact(previous, 'failure')));
    const priorBytes = readTrusted(join(EVIDENCE, artifact(previous, 'result'))), prior = JSON.parse(priorBytes);
    need(prior.schema === 'qorpera.production-rollout-step/v1' && prior.passed === true && prior.step === previous
      && prior.packetSha256 === PACKET_SHA256 && prior.windowPin.sha256 === RELEASE_PINS.executionWindow
      && prior.sqlSha256 === packet.sql[`${previous}.sql`].sha256 && prior.automaticReplayAllowed === false
      && prior.transactionReadbackMatched === true, 'PREDECESSOR_REJECTED');
    validateReadback(prior.readback, previous);
    const priorIntent = readTrusted(join(EVIDENCE, artifact(previous, 'intent')));
    need(pinValid(prior.intent) && hash(priorIntent) === prior.intent.sha256 && priorIntent.length === prior.intent.bytes, 'PREDECESSOR_INTENT_REJECTED');
    predecessor = { bytes: priorBytes.length, sha256: hash(priorBytes) };
  }
  const sqlSha256 = packet.sql[`${reconciliation ? 'reconcile-' : ''}${step}.sql`].sha256;
  return { packetSha256: PACKET_SHA256, sqlSha256, windowPin: receiptPins.executionWindow, predecessor, externalReceiptPins: receiptPins };
}
export async function runStep(step, reconciliation = false) {
  if (!READY) return { record: noReady(), pin: null };
  return executeCore({ step, reconciliation, preflight: () => localPreflight(step, reconciliation),
    write: (name, value) => writeExclusive(join(EVIDENCE, name), value), invoke: () => capture(step, reconciliation),
    postcheck: () => { checkPacket(); verifyCli(); release(JSON.parse(readTrusted(join(ROOT, 'packet.json')))); } });
}
let direct = false; try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) {
  const main = async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === 'check') {
      const packet = checkPacket(); process.stdout.write(`${JSON.stringify({ passed: true, packetSha256: PACKET_SHA256, sourceMigrations: packet.sourceMigrations,
        mutationSteps: packet.mutations.length, sqlFiles: Object.keys(packet.sql).length, executionEnabled: READY, actualGateBindingsIssued: Object.values(RELEASE_PINS).every(isSha), productionWrites: false })}\n`); return;
    }
    need(args.length === 2 && ['execute', 'reconcile'].includes(args[0]), 'ARGUMENTS_REJECTED');
    const result = await runStep(args[1], args[0] === 'reconcile');
    process.stdout.write(`${JSON.stringify({ passed: result.record.passed, code: result.record.code ?? null, step: result.record.step ?? null,
      classification: result.record.classification ?? null, pin: result.pin, cliInvocations: result.record.cliInvocations,
      productionReady: false, admissionReopened: false, automaticReplayAllowed: false })}\n`);
    if (!result.record.passed) process.exitCode = 1;
  };
  main().catch(() => { process.stdout.write('{"passed":false,"code":"CLOSED_ENTRYPOINT","productionReady":false,"automaticReplayAllowed":false}\n'); process.exitCode = 1; });
}
