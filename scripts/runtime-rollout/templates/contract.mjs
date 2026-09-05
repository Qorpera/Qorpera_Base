import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inputs from './inputs.json' with { type: 'json' };

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const FIXED = Object.freeze(null); // Materialized by create-packet.mjs.
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const need = (condition, code = 'PACKET_REJECTED') => { if (!condition) throw Error(code); };
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isUtc = value => { try { return typeof value === 'string' && new Date(value).toISOString() === value; } catch { return false; } };
export const pinValid = value => exact(value, ['bytes', 'sha256']) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 4 * 1024 * 1024 && isSha(value.sha256);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const INPUT = freeze(inputs);
need(exact(INPUT, ['baselineVersions', 'productionOnly', 'migrations'])
  && INPUT.baselineVersions.length === FIXED.baselineCount && INPUT.productionOnly.length === 18 && INPUT.migrations.length === FIXED.migrationCount);
for (const values of [INPUT.baselineVersions, INPUT.productionOnly]) need(
  values.every(value => typeof value === 'string' && /^\d{14}$/.test(value))
  && new Set(values).size === values.length && isDeepStrictEqual([...values].sort(), values), 'INPUT_VERSIONS_REJECTED');
need(INPUT.productionOnly.every(value => INPUT.baselineVersions.includes(value))
  && isDeepStrictEqual(INPUT.migrations.map(row => row.version), [...INPUT.migrations.map(row => row.version)].sort())
  && INPUT.migrations.every(row => exact(row, ['file', 'version', 'bytes', 'sha256'])
    && !INPUT.baselineVersions.includes(row.version) && new RegExp(`^${row.version}_[a-z0-9_]+\\.sql$`).test(row.file)
    && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 256 * 1024 && isSha(row.sha256)), 'INPUT_MIGRATIONS_REJECTED');
export const MUTATIONS = Object.freeze(['pause', ...INPUT.migrations.map(row => row.version)]);
export const STEPS = Object.freeze(['preflight', ...MUTATIONS, 'final-readback']);
export function stepIndex(step) { const index = STEPS.indexOf(step); need(index >= 0, 'STEP_REJECTED'); return index; }
export function stateAt(step, after = true) {
  const index = stepIndex(step), completed = STEPS.slice(0, index + (after ? 1 : 0));
  const versions = [...INPUT.baselineVersions, ...INPUT.migrations.filter(row => completed.includes(row.version)).map(row => row.version)].sort();
  return { versions, paused: completed.includes('pause'), activated: completed.includes(FIXED.activationVersion) };
}
export function validateMigration(row, bytes) {
  need(INPUT.migrations.some(value => isDeepStrictEqual(value, row)), 'MIGRATION_PIN_REJECTED');
  need(Buffer.isBuffer(bytes) && bytes.length === row.bytes && hash(bytes) === row.sha256, 'MIGRATION_BYTES_REJECTED');
  return bytes;
}
export function validateReadback(value, step, expected = stateAt(step)) {
  need(exact(value, ['schema', 'step', 'projectRef', 'companyId', 'environmentId', 'sourceCommit', 'runtimeBundleSha256',
    'observedAt', 'database', 'executorRole', 'ledgerVersions', 'policy', 'headAndOwnerMatched', 'identityMatched',
    'legacyState', 'activeBundle', 'globalWork', 'historicalLedgerVersionsRetained', 'migrationRowsMatched',
    'lifecycleDefinitionMatched', 'finalInterfacesMatched', 'admissionReopened', 'productionReady']), 'READBACK_SHAPE_REJECTED');
  need(value.schema === 'qorpera.production-rollout-database-readback/v1' && value.step === step && value.projectRef === FIXED.project
    && value.companyId === FIXED.company && value.environmentId === FIXED.environment && value.sourceCommit === FIXED.commit
    && value.runtimeBundleSha256 === FIXED.bundle && isUtc(value.observedAt) && value.database === 'postgres'
    && ['postgres', 'supabase_admin'].includes(value.executorRole), 'READBACK_IDENTITY_REJECTED');
  need(isDeepStrictEqual(value.ledgerVersions, expected.versions), 'LEDGER_REJECTED');
  need(exact(value.policy, ['provider', 'authenticationMode', 'nativeHarness', 'implementation', 'enablement', 'maxConcurrency', 'version', 'pauseReasonMatched', 'initialReasonMatched'])
    && value.policy.provider === 'openai' && value.policy.authenticationMode === 'native_subscription' && value.policy.nativeHarness === 'codex-cli'
    && value.policy.implementation === 'supported' && value.policy.enablement === (expected.paused ? 'disabled' : FIXED.initialEnablement)
    && value.policy.version === (expected.paused ? FIXED.policyVersionPaused : FIXED.policyVersionBefore)
    && value.policy.maxConcurrency === FIXED.concurrency && value.policy.pauseReasonMatched === expected.paused
    && value.policy.initialReasonMatched === !expected.paused, 'POLICY_REJECTED');
  need(value.legacyState === 'retired', 'LEGACY_REJECTED');
  need(value.activeBundle === (expected.activated ? FIXED.bundle : FIXED.previousBundle), 'BUNDLE_REJECTED');
  need(exact(value.globalWork, ['jobs', 'runs', 'assignments', 'requests', 'leases', 'receipts', 'logins', 'runners'])
    && Object.values(value.globalWork).every(count => count === 0), 'DRAIN_REJECTED');
  need(value.headAndOwnerMatched === true && value.identityMatched === true && value.historicalLedgerVersionsRetained === true
    && value.migrationRowsMatched === true && value.lifecycleDefinitionMatched === true, 'TARGET_REJECTED');
  need(value.finalInterfacesMatched === (step === 'final-readback'), 'INTERFACES_REJECTED');
  need(value.admissionReopened === false && value.productionReady === false, 'OVERCLAIM_REJECTED');
  return value;
}
export function classifyReconciliation(candidate, step) {
  need(MUTATIONS.includes(step), 'RECONCILIATION_STEP_REJECTED');
  for (const [label, expected] of [['after-state-matched', stateAt(step)], ['before-state-matched', stateAt(step, false)]]) {
    try { validateReadback({ ...candidate, step }, step, expected); return label; } catch {}
  }
  return 'unmatched-or-unknown';
}
