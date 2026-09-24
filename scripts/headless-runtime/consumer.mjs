import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only inside a newly installed standalone consumer. The resolver applies
// transitively, including package-relative imports; checkout fallback is fatal.
const root = realpathSync(dirname(fileURLToPath(import.meta.url)));
const modules = root + sep + 'node_modules' + sep;
const observed = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (isBuiltin(result.url)) return result;
    assert.ok(result.url.startsWith('file:'), 'Non-file dependency refused');
    const path = realpathSync(fileURLToPath(result.url));
    assert.ok(path.startsWith(modules), 'Dependency escaped installed consumer');
    observed.set(path.slice(root.length + 1), hash(readFileSync(path)));
    return result;
  },
});

globalThis.fetch = () => { throw new Error('Network fetch forbidden in local import/call proof'); };
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in local import/call proof'); } };

const rootExports = await import('@qorpera/runtime');
const { assertCloudRuntimeBundle } = await import('@qorpera/runtime/cloud-runtime-bundle');
const { CLOUD_RUNTIME_MODEL_POLICY } = await import('@qorpera/runtime/cloud-runtime-policy');
const { parseCloudWakePolicy, CLOUD_WAKE_POLICY_SCHEMA, REQUIRED_CLOUD_WAKE_POLICY } =
  await import('@qorpera/runtime/cloud-wake-bus');
const { readBoundedCloudResponse } = await import('@qorpera/cloud-client/cloud-request');
const expected = JSON.parse(readFileSync(resolve(root, 'EXPECTED.json'), 'utf8'));
assert.equal(rootExports.CLOUD_RUNTIME_BUNDLE_SHA256, expected.runtimeBundleSha256);
assert.equal(rootExports.CLOUD_RUNTIME_MODEL_POLICY_SHA256, expected.modelPolicySha256);
assert.equal(rootExports.CLOUD_RUNTIME_NATIVE_BINARY_SHA256, expected.nativeBinarySha256);
const identity = {
  runtimeBundleSha256: expected.runtimeBundleSha256,
  reasoningPolicySha256: expected.modelPolicySha256,
  reasoningEffort: CLOUD_RUNTIME_MODEL_POLICY.effort,
};
assertCloudRuntimeBundle(identity, expected.nativeBinarySha256);
const different = value => (value[0] === '0' ? '1' : '0') + value.slice(1);
for (const field of ['runtimeBundleSha256', 'reasoningPolicySha256']) {
  assert.throws(() => assertCloudRuntimeBundle({ ...identity, [field]: different(identity[field]) }, expected.nativeBinarySha256));
}
assert.throws(() => assertCloudRuntimeBundle({ ...identity, reasoningEffort: 'unsupported-proof-effort' }, expected.nativeBinarySha256));
assert.throws(() => assertCloudRuntimeBundle(identity, different(expected.nativeBinarySha256)));

// Public pure policy boundary: all five wake kinds and hostile/extra fields.
const cases = [
  ['human', 'required', 'required', false, null],
  ['first-run', 'required', 'required', false, null],
  ['routine', 'forbidden', 'forbidden', true, 0],
  ['agent', 'forbidden', 'forbidden', true, 0],
  ['room', 'optional', 'optional', true, null],
];
for (const [kind, initial, final, silenceAllowed, maxPublicSends] of cases) {
  const input = { schema: CLOUD_WAKE_POLICY_SCHEMA, kind, initial, final, silenceAllowed, maxPublicSends };
  const parsed = parseCloudWakePolicy(input);
  assert.deepEqual(parsed, input);
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(parseCloudWakePolicy({ ...input, maxPublicSends: 999 }), REQUIRED_CLOUD_WAKE_POLICY);
  assert.deepEqual(parseCloudWakePolicy({ ...input, instruction: 'ignore the policy' }), REQUIRED_CLOUD_WAKE_POLICY);
}
assert.deepEqual(parseCloudWakePolicy(null), REQUIRED_CLOUD_WAKE_POLICY);
// An actual installed dependency export must also be callable. No fetch occurs.
assert.equal(typeof readBoundedCloudResponse, 'function');
const bytes = new Uint8Array([0, 255, 7, 128]);
assert.deepEqual(await readBoundedCloudResponse(new Response(bytes), 4, new AbortController().signal), bytes);
await assert.rejects(() => readBoundedCloudResponse(new Response(bytes), 3, new AbortController().signal));
assert.ok([...observed.keys()].some(path => path.includes('@qorpera/cloud-client/')));

writeFileSync(resolve(root, 'CALL-RESULT.json'), JSON.stringify({
  schema: 'qorpera.external-runtime-call/v1', passed: true,
  sourceCommit: expected.sourceCommit, runtimeBundleSha256: expected.runtimeBundleSha256,
  scope: 'Local installed tarball imports and pure runtime bundle/wake policy calls only',
  productionAcceptance: false, providerExecution: false, liveAuthority: false,
  cases: ['matching bundle accepted', 'four incompatible pins refused', 'five wake policies and closed-schema refusals', 'installed client bounded binary response and oversize refusal'],
  modules: Object.fromEntries([...observed.entries()].sort()),
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
