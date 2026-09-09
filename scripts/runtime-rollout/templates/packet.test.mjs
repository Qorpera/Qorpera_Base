import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXED, INPUT, MUTATIONS, ROOT, STEPS, classifyReconciliation, hash, stateAt, validateMigration, validateReadback } from './contract.mjs';
import { buildSQL, reconciliationSQL } from './sql-packet.mjs';
import { verifySources } from './build-packet.mjs';
import { assertAbsent, assertDirectory, readTrusted, writeExclusive } from './files.mjs';
import { READY, RELEASE_PINS, checkPacket, executeCore, parseEnvelope, runStep, validateWindow } from './controller.mjs';
import { argumentsFor } from './transport.mjs';

const AT = '2026-09-02T14:00:00.000Z';
const PIN = Object.freeze({ bytes: 17, sha256: 'a'.repeat(64) });
const RECEIPTS = Object.freeze(Object.fromEntries(Object.keys(RELEASE_PINS).map(key => [key, PIN])));
function readback(step, state = stateAt(step)) {
  return { schema: 'qorpera.production-rollout-database-readback/v1', step, projectRef: FIXED.project, companyId: FIXED.company,
    environmentId: FIXED.environment, sourceCommit: FIXED.commit, runtimeBundleSha256: FIXED.bundle, observedAt: AT,
    database: 'postgres', executorRole: 'supabase_admin', ledgerVersions: state.versions,
    policy: { provider: 'openai', authenticationMode: 'native_subscription', nativeHarness: 'codex-cli', implementation: 'supported',
      enablement: state.paused ? 'disabled' : FIXED.initialEnablement, maxConcurrency: FIXED.concurrency,
      version: state.paused ? FIXED.policyVersionPaused : FIXED.policyVersionBefore,
      pauseReasonMatched: state.paused, initialReasonMatched: !state.paused },
    headAndOwnerMatched: true, identityMatched: true, legacyState: 'retired', activeBundle: state.activeBundle,
    globalWork: { jobs: 0, runs: 0, assignments: 0, requests: 0, leases: 0, receipts: 0, logins: 0, runners: 0 },
    historicalLedgerVersionsRetained: true, migrationRowsMatched: true, lifecycleDefinitionMatched: true,
    finalInterfacesMatched: step === 'final-readback', admissionReopened: false, productionReady: false };
}
function harness(step = 'pause', options = {}) {
  const records = new Map(), events = [], raw = Buffer.from(JSON.stringify([{ readback: options.readback ?? readback(step) }]));
  const dependencies = { step, reconciliation: options.reconciliation ?? false,
    preflight: async () => {
      events.push('preflight');
      for (const kind of ['intent', 'result', 'failure']) assert(!records.has(`rollout-${options.reconciliation ? 'reconcile-' : ''}${step}-${kind}.json`));
      return { packetSha256: PIN.sha256, sqlSha256: PIN.sha256, windowPin: PIN, predecessor: null, externalReceiptPins: RECEIPTS };
    },
    write: async (name, value) => {
      assert(!records.has(name)); events.push(name); records.set(name, value);
      if (options.failWrite && name.includes(options.failWrite)) throw Error('synthetic-private-write-error');
      return PIN;
    },
    invoke: async () => { events.push('invoke'); if (options.invocationError) throw Error('synthetic-private-transport-error');
      return { ok: options.transportOk ?? true, processGroupAbsent: options.groupAbsent ?? true, bytes: raw }; },
    postcheck: async () => { events.push('postcheck'); if (options.postcheckFailure) throw Error('synthetic-private-postcheck-error'); },
    now: () => AT };
  return { records, events, raw, dependencies };
}

test('fixed production scope: pause plus pinned ordered migrations, all 18 historical versions retained', () => {
  assert.equal(FIXED.project, 'wovsmjvghnbcbfazdtvr'); assert.equal(INPUT.migrations.length, FIXED.migrationCount);
  assert.deepEqual(MUTATIONS, ['pause', ...INPUT.migrations.map(row => row.version)]);
  assert.equal(MUTATIONS.length, FIXED.migrationCount + 1); assert.equal(STEPS.length, FIXED.migrationCount + 3);
  assert.equal(stateAt('preflight').versions.length, FIXED.baselineCount);
  assert.equal(stateAt('final-readback').versions.length, FIXED.baselineCount + FIXED.migrationCount);
  for (const step of STEPS) for (const version of INPUT.productionOnly) assert(stateAt(step).versions.includes(version));
  assert.equal(stateAt(FIXED.activationVersion, false).activated, false); assert.equal(stateAt(FIXED.activationVersion).activated, true);
  assert.equal(stateAt('pause', false).paused, false); assert.equal(stateAt('pause').paused, true);
});

test('current source, exact source bytes and the baseline verify without live IO', () => {
  const value = verifySources(); assert.equal(value.migrations.size, FIXED.migrationCount); assert(value.implementationFilesVerified > 100);
  for (const row of INPUT.migrations) assert.equal(hash(value.migrations.get(row.version)), row.sha256);
});

for (const step of STEPS) test(`closed readback accepts only correct current phase ${step}`, () => {
  const value = readback(step); assert.equal(validateReadback(value, step), value);
  const changed = structuredClone(value); changed.policy.version += 1;
  assert.throws(() => validateReadback(changed, step), /POLICY_REJECTED/);
  const bundle = structuredClone(value); bundle.activeBundle = 'c'.repeat(64);
  assert.throws(() => validateReadback(bundle, step), /BUNDLE_REJECTED/);
});

for (const [key, value] of [
  ['projectRef', 'tlnzirrtjufnexorsbic'], ['sourceCommit', '0'.repeat(40)], ['runtimeBundleSha256', '0'.repeat(64)],
  ['headAndOwnerMatched', false], ['identityMatched', false], ['lifecycleDefinitionMatched', false], ['legacyState', 'active'],
  ['migrationRowsMatched', false], ['historicalLedgerVersionsRetained', false],
  ['database', 'other'], ['executorRole', 'service_role'], ['productionReady', true], ['admissionReopened', true],
  ['unknown', 'synthetic-private-value'], ['observedAt', 'tomorrow']
]) test(`readback rejects ${key} mismatch or overclaim`, () => {
  const candidate = readback('pause'); candidate[key] = value; assert.throws(() => validateReadback(candidate, 'pause'));
});

for (const key of Object.keys(readback('pause').globalWork)) test(`readback rejects nonzero ${key}`, () => {
  const candidate = readback('pause'); candidate.globalWork[key] = 1; assert.throws(() => validateReadback(candidate, 'pause'), /DRAIN_REJECTED/);
});

test('zero work cannot substitute for a policy pause; missing or extra ledger entries cannot pass', () => {
  const value = readback('pause'); value.policy = readback('preflight').policy;
  assert.throws(() => validateReadback(value, 'pause'), /POLICY_REJECTED/);
  for (const versions of [INPUT.baselineVersions.slice(1), [...INPUT.baselineVersions, '20260828029999']]) {
    const candidate = readback('preflight'); candidate.ledgerVersions = versions; assert.throws(() => validateReadback(candidate, 'preflight'), /LEDGER_REJECTED/);
  }
});

test('the bundle activation is admitted only by its own step', () => {
  const early = readback('pause'); early.activeBundle = FIXED.bundle;
  assert.throws(() => validateReadback(early, 'pause'), /BUNDLE_REJECTED/);
  const late = readback('final-readback'); late.activeBundle = FIXED.previousBundle;
  assert.throws(() => validateReadback(late, 'final-readback'), /BUNDLE_REJECTED/);
});

test('source pin mismatch and unknown migration are rejected before generating SQL', () => {
  const row = INPUT.migrations[0], bytes = readFileSync(join(FIXED.source, 'supabase/migrations', row.file));
  assert.throws(() => validateMigration({ ...row, sha256: PIN.sha256 }, bytes), /MIGRATION_PIN_REJECTED/);
  assert.throws(() => buildSQL(row.version, Buffer.concat([bytes, Buffer.from('x')])), /MIGRATION_BYTES_REJECTED/);
  assert.throws(() => buildSQL('20260828029999', bytes), /STEP_REJECTED/);
});

test('every generated migration has a single mutating transaction, exact original ledger bytes and postguards before commit', () => {
  for (const row of INPUT.migrations) {
    const bytes = readFileSync(join(FIXED.source, 'supabase/migrations', row.file)), sql = buildSQL(row.version, bytes);
    assert(sql.startsWith('begin transaction isolation level serializable;\n'));
    assert.equal([...sql.matchAll(/^commit;$/gm)].length, 1, row.version);
    assert.equal([...sql.matchAll(/^begin transaction isolation level/gm)].length, 2, row.version);
    assert(!/^\s*begin\s*;/im.test(sql), row.version);
    const ledger = sql.indexOf('insert into supabase_migrations.schema_migrations(version,name,statements)');
    const commit = sql.indexOf('\ncommit;');
    assert(ledger > 0 && ledger < commit && sql.indexOf('do $rollout_guard$', ledger) < commit);
    const hex = sql.match(/array\[convert_from\(decode\('([a-f0-9]+)','hex'\),'UTF8'\)\]/)?.[1];
    assert(hex && Buffer.from(hex, 'hex').equals(bytes), row.version);
    assert(sql.endsWith('rollback;\n')); assert(sql.includes("set local transaction_timeout='50s'"));
    assert(sql.includes(bytes.toString('utf8')));
    assert(sql.includes('BUNDLE_PRESTATE_REJECTED') && sql.includes('DRAIN_PRESTATE_REJECTED'));
  }
});

test('pause is global only for the exact provider tuple, keeps concurrency 64 and preserves unrelated policy fields', () => {
  const sql = buildSQL('pause');
  assert(sql.includes("provider='openai' and authentication_mode='native_subscription' and native_harness='codex-cli'"));
  assert(sql.includes(`policy_version=${FIXED.policyVersionBefore}`) && sql.includes(`policy_version=${FIXED.policyVersionPaused}`));
  assert(sql.includes("'supported','disabled',64,"));
  assert(sql.includes('before_policy.commercial_reference') && sql.includes('after_policy.updated_by_user_id is distinct from before_policy.updated_by_user_id'));
  assert(!sql.includes("'supported','enabled'")); assert(!sql.includes('reset provider'));
  assert(sql.includes('share row exclusive mode')); assert(sql.includes('DRAIN_PRESTATE_REJECTED'));
});

test('read-only queries cannot mutate; reconciliation checks only existing migration rows and never claims rollback', () => {
  for (const step of MUTATIONS) {
    const sql = reconciliationSQL(step); assert(sql.startsWith('begin transaction isolation level repeatable read read only;'));
    assert(!/\b(insert|update|delete|create|alter|drop|perform)\b/i.test(sql));
    assert(sql.includes('present.version=expected.version')); assert(sql.endsWith('rollback;\n'));
  }
  assert.equal(classifyReconciliation(readback('pause'), 'pause'), 'after-state-matched');
  assert.equal(classifyReconciliation(readback('pause', stateAt('pause', false)), 'pause'), 'before-state-matched');
  assert.equal(classifyReconciliation({ unknown: 'not-exposed' }, 'pause'), 'unmatched-or-unknown');
});

test('actual CLI array envelope accepted and buffer erased; alternatives/unknown fields denied without diagnostics', () => {
  const good = Buffer.from(JSON.stringify([{ readback: readback('pause') }]));
  assert.equal(parseEnvelope(good).step, 'pause'); assert(good.every(byte => byte === 0));
  for (const value of [{ readback: {} }, { result: [{ readback: {} }] }, [], [{ readback: {} }, { readback: {} }], [{ readback: {}, error: 'private' }]]) {
    const bytes = Buffer.from(JSON.stringify(value)); assert.throws(() => parseEnvelope(bytes), /CLI_ENVELOPE_REJECTED/);
    assert(bytes.every(byte => byte === 0));
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(256 * 1024 + 1, 0x61), Buffer.from([0xff])]) {
    assert.throws(() => parseEnvelope(bytes)); assert(bytes.every(byte => byte === 0));
  }
});

test('fixed CLI arguments cannot select another project, arbitrary query or shell/path', () => {
  assert.deepEqual(argumentsFor('pause'), ['db', 'query', '--linked', '--project-ref', FIXED.project, '--file', `${ROOT}/sql/pause.sql`, '--output', 'json']);
  for (const step of ['../pause', 'pause;anything', '--help', 'preflight\n']) assert.throws(() => argumentsFor(step));
  assert.throws(() => argumentsFor('final-readback', true));
});

test('disabled operational entrypoint rejects before any filesystem, credential or process access', async () => {
  assert.equal(READY, false); assert(Object.values(RELEASE_PINS).every(value => value === null));
  assert.deepEqual(await runStep('pause'), { record: { passed: false, code: 'DISPATCH_DISABLED', cliInvocations: 0,
    productionWrites: false, automaticReplayAllowed: false }, pin: null });
});

test('frozen generated inventory is exactly re-readable and regenerates from current public pins', () => {
  const packet = checkPacket(); assert.equal(Object.keys(packet.sql).length, STEPS.length + MUTATIONS.length);
  assert.equal(packet.executionEnabled, false); assert.equal(packet.issuedAt, null); assert.equal(packet.expiresAt, null);
  assert.equal(packet.actualFreshPhysicalFence, null); assert.equal(packet.actualDisabledInstallation, null);
  assert.equal(packet.actualSignedAcceptance, null); assert.deepEqual(packet.actualProductionReadbacks, []);
  assert.equal(packet.finalLedgerEntries, FIXED.baselineCount + FIXED.migrationCount); assert.equal(packet.predecessorPacketSha256, FIXED.predecessorPacketSha256);
});

test('execution window requires explicit global pause scope, pinned real gates and bounded fresh interval', () => {
  const gates = Object.fromEntries(Object.keys(RELEASE_PINS).map(key => [key, PIN.sha256]));
  const value = { schema: 'qorpera.company41-production-rollout-window/v1', projectRef: FIXED.project, companyId: FIXED.company,
    environmentId: FIXED.environment, sourceCommit: FIXED.commit, runtimeBundleSha256: FIXED.bundle, packetSha256: PIN.sha256,
    issuedAt: AT, expiresAt: '2026-09-02T15:00:00.000Z', operator: 'Jonas.mk@qorpera.com', globalOpenAIPolicyPauseAcknowledged: true,
    sourceAcceptanceSha256: PIN.sha256, physicalFenceSha256: PIN.sha256, disabledInstallationSha256: PIN.sha256 };
  assert.equal(validateWindow(value, PIN.sha256, gates, Date.parse(AT)), value);
  for (const delta of [{ globalOpenAIPolicyPauseAcknowledged: false }, { issuedAt: null }, { expiresAt: '2026-09-02T17:00:00.000Z' },
    { packetSha256: 'b'.repeat(64) }, { extra: true }, { physicalFenceSha256: 'b'.repeat(64) }])
    assert.throws(() => validateWindow({ ...value, ...delta }, PIN.sha256, gates, Date.parse(AT)));
  assert.throws(() => validateWindow(value, PIN.sha256, gates, Date.parse(value.expiresAt)));
});

test('one private invocation follows durable intent and validated result, with no HTTP-count or production acceptance claim', async () => {
  const h = harness(), result = await executeCore(h.dependencies);
  assert.equal(result.record.passed, true); assert.equal(result.record.cliInvocations, 1);
  assert.equal(result.record.databaseTransportAttemptCountKnown, false); assert.equal(result.record.productionReady, false);
  assert.equal(result.record.externalGateClaimsReperformedHere, false); assert.equal(result.record.admissionReopened, false);
  assert.deepEqual(h.events.slice(0, 3), ['preflight', 'rollout-pause-intent.json', 'invoke']); assert(h.raw.every(byte => byte === 0));
});

for (const [name, options] of [
  ['failed intent', { failWrite: '-intent' }], ['lost reply', { invocationError: true }], ['denial', { transportOk: false }],
  ['unconfirmed child', { groupAbsent: false }], ['changed source after commit', { postcheckFailure: true }],
  ['full result write with failed durability', { failWrite: '-result' }], ['bad readback', { readback: { private: 'synthetic-private-value' } }]
]) test(`failure isolation: ${name}; no replay, rollback assertion or raw error`, async () => {
  const h = harness('pause', options), result = await executeCore(h.dependencies);
  assert.equal(result.record.passed, false); assert.equal(result.record.rollbackConfirmed, false);
  assert.equal(result.record.cliInvocations, options.failWrite === '-intent' ? 0 : 1);
  assert.equal(result.record.mutationMayHaveCommitted, options.failWrite !== '-intent');
  assert.equal(result.record.automaticReplayAllowed, false);
  assert(!JSON.stringify([...h.records.values(), result]).includes('synthetic-private'));
  assert(h.raw.every(byte => byte === 0) || options.failWrite === '-intent' || options.invocationError);
  const count = h.events.filter(event => event === 'invoke').length;
  assert.equal((await executeCore(h.dependencies)).record.passed, false);
  assert.equal(h.events.filter(event => event === 'invoke').length, count);
  if (options.failWrite === '-result') {
    assert(h.records.has('rollout-pause-result.json')); assert(h.records.has('rollout-pause-failure.json'));
  }
});

test('read-only reconciliation reports observed state but cannot promote the original uncertain operation', async () => {
  for (const value of [readback('pause'), readback('pause', stateAt('pause', false)), { private: 'not-returned' }]) {
    const h = harness('pause', { reconciliation: true, readback: value }), result = await executeCore(h.dependencies);
    assert.equal(result.record.productionMutationAttempted, false); assert.equal(result.record.transactionReadbackMatched, false);
    assert.equal(result.record.originalAttemptStillUnconfirmed, true); assert.equal(result.record.automaticReplayAllowed, false);
    if (result.record.classification === 'unmatched-or-unknown') assert.equal(result.record.readback, null);
    assert(!JSON.stringify(result).includes('not-returned'));
  }
});

test('owned evidence guards reject symlinks, hardlinks, permissive files, oversize and overwrites', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rollout-offline-test.')));
  try {
    chmodSync(directory, 0o700); assertDirectory(directory);
    const file = join(directory, 'one.json'), pin = writeExclusive(file, { synthetic: true });
    assert.equal(hash(readTrusted(file)), pin.sha256); assert.throws(() => writeExclusive(file, { synthetic: false }));
    const link = join(directory, 'link.json'); symlinkSync(file, link); assert.throws(() => readTrusted(link)); assert.throws(() => assertAbsent(link));
    const hard = join(directory, 'hard.json'); linkSync(file, hard); assert.throws(() => readTrusted(file));
    const open = join(directory, 'open.json'); writeFileSync(open, '{}', { mode: 0o666 }); chmodSync(open, 0o666); assert.throws(() => readTrusted(open));
    const large = join(directory, 'large.json'); writeFileSync(large, Buffer.alloc(11), { mode: 0o600 }); assert.throws(() => readTrusted(large, 10));
    const folder = join(directory, 'folder'); mkdirSync(folder, { mode: 0o700 }); const alias = join(directory, 'alias'); symlinkSync(folder, alias); assert.throws(() => assertDirectory(alias));
    assertAbsent(join(directory, 'absent.json'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
