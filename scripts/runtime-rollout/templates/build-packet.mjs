// Offline public-artifact generation only. No credentials, process transport or time issuance.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED, INPUT, MUTATIONS, ROOT, STEPS, hash, need, validateMigration } from './contract.mjs';
import { assertAbsent, assertDirectory, readTrusted, writeExclusive } from './files.mjs';
import { buildSQL, reconciliationSQL } from './sql-packet.mjs';

export function verifySources() {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };
  const git = args => execFileSync('/usr/bin/git', ['--no-optional-locks', ...args], { cwd: FIXED.source, env, timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  need(git(['rev-parse', 'HEAD']).trim() === FIXED.commit, 'SOURCE_COMMIT_REJECTED');
  need(git(['status', '--porcelain', '--untracked-files=all']) === '', 'SOURCE_DIRTY');
  need(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD', 'SOURCE_NOT_DETACHED');
  // Fresh baseline and preflight evidence are separately pinned public inputs.
  need(hash(readTrusted(FIXED.baselineEvidence)) === FIXED.baselineSha256, 'PRIOR_EVIDENCE_CHANGED');
  need(hash(readTrusted(FIXED.preflightEvidence)) === FIXED.preflightSha256, 'PRIOR_EVIDENCE_CHANGED');
  const baseline = JSON.parse(readTrusted(FIXED.baselineEvidence))[0].r;
  need(baseline.count === FIXED.baselineCount && JSON.stringify(baseline.versions) === JSON.stringify(INPUT.baselineVersions)
    && baseline.activeBundle === FIXED.previousBundle, 'BASELINE_CHANGED');
  const sourceNames = readdirSync(join(FIXED.source, 'supabase/migrations')).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  need(sourceNames.length === FIXED.sourceMigrationCount, 'MIGRATION_INVENTORY_CHANGED');
  need(JSON.stringify(sourceNames.filter(name => !INPUT.baselineVersions.includes(name.slice(0, 14)))) === JSON.stringify(INPUT.migrations.map(row => row.file)), 'SOURCE_DELTA_CHANGED');
  const manifestBytes = readTrusted(join(FIXED.source, 'deploy/first-node/native-codex/runtime-bundle-manifest.json'));
  need(hash(manifestBytes) === FIXED.manifestSha256, 'RUNTIME_MANIFEST_CHANGED');
  const value = JSON.parse(manifestBytes), manifest = value.manifest ?? value;
  need(manifest.schema === 'qorpera.runtime-bundle/v2' && manifest.implementation && Object.keys(manifest.implementation).length > 100, 'RUNTIME_MANIFEST_REJECTED');
  for (const [path, pin] of Object.entries(manifest.implementation)) need(/^[a-zA-Z0-9_./-]+$/.test(path) && !path.includes('..') && hash(readTrusted(join(FIXED.source, path))) === pin, 'RUNTIME_SOURCE_CHANGED');
  for (const transition of FIXED.bundleActivations) {
    const activation = readTrusted(join(FIXED.source, 'supabase/migrations', INPUT.migrations.find(row => row.version === transition.migrationVersion).file)).toString('utf8');
    need(activation.includes(`'${transition.sha256}'`) && activation.includes(`'qorpera.cloud-runtime',${transition.version},`), 'ACTIVATION_PIN_REJECTED');
  }
  const migrations = new Map(INPUT.migrations.map(row => [row.version, validateMigration(row, readTrusted(join(FIXED.source, 'supabase/migrations', row.file)))]));
  return { migrations, implementationFilesVerified: Object.keys(manifest.implementation).length };
}
export function buildPacket() {
  assertDirectory(ROOT);
  const verified = verifySources();
  assertAbsent(join(ROOT, 'sql')); assertAbsent(join(ROOT, 'packet.json'));
  const files = [];
  for (const step of STEPS) files.push({ name: `${step}.sql`, bytes: Buffer.from(buildSQL(step, verified.migrations.get(step))) });
  for (const step of MUTATIONS) files.push({ name: `reconcile-${step}.sql`, bytes: Buffer.from(reconciliationSQL(step)) });
  mkdirSync(join(ROOT, 'sql'), { mode: 0o700 });
  const sql = Object.fromEntries(files.map(file => [file.name, writeExclusive(join(ROOT, 'sql', file.name), file.bytes)]));
  const packet = {
    schema: 'qorpera.company41-production-rollout-packet/v1', sourceCommit: FIXED.commit, runtimeBundleSha256: FIXED.bundle,
    previousRuntimeBundleSha256: FIXED.previousBundle, projectRef: FIXED.project, companyId: FIXED.company, environmentId: FIXED.environment,
    inputSha256: hash(readTrusted(join(ROOT, 'inputs.json'))), sourceMigrations: FIXED.sourceMigrationCount, baselineLedgerEntries: FIXED.baselineCount,
    finalLedgerEntries: FIXED.baselineCount + FIXED.migrationCount, predecessorPacketSha256: FIXED.predecessorPacketSha256, productionOnlyLedgerEntriesRetained: 18,
    mutations: MUTATIONS, sql, priorEvidenceSha256: FIXED.baselineSha256, preflightEvidenceSha256: FIXED.preflightSha256,
    implementationFilesVerified: verified.implementationFilesVerified,
    globalPolicyScope: { provider: 'openai', authenticationMode: 'native_subscription', nativeHarness: 'codex-cli', companyScoped: false },
    executionEnabled: false, issuedAt: null, expiresAt: null, actualFreshPhysicalFence: null, actualDisabledInstallation: null,
    actualSignedAcceptance: null, actualProductionReadbacks: [], productionReady: false,
    wakeBusIncluded: true, roomsIncluded: true, operatorStopIncluded: true, companyCeilingsRemoved: true, sponsorHandoffIncluded: true, autonomousConsentIncluded: true,
    defaultAgentReadGrantBackfillIncluded: true, bootstrapExecutionIncluded: false, recoveryKeyOperationsIncluded: false,
    admissionReenableIncluded: false, automaticReplayAllowed: false, installerChangesIncluded: false,
    companyComputersIncluded: INPUT.migrations.some(row => /^\d{14}_runtime_office_/.test(row.file)),
  };
  const pin = writeExclusive(join(ROOT, 'packet.json'), packet);
  return { passed: true, sqlFiles: files.length, mutationSteps: MUTATIONS.length, packet: pin, executionEnabled: false, productionWrites: false };
}
let direct = false; try { direct = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) {
  try { need(process.argv.length === 3 && process.argv[2] === 'build'); process.stdout.write(`${JSON.stringify(buildPacket())}\n`); }
  catch (error) { process.stdout.write(`{"passed":false,"code":"OFFLINE_BUILD_REJECTED","reason":${JSON.stringify(String(error?.message ?? error))},"productionWrites":false}\n`); process.exitCode = 1; }
}
