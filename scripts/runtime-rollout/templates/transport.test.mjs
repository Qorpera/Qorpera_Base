import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CLI, capture } from './transport.mjs';
import { FIXED } from './contract.mjs';

function fixture({ closedGroup = true, permissionError = false, onSpawn = () => {}, onTerm = true } = {}) {
  const child = new EventEmitter(); child.pid = 471001; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let absent = false, spawns = 0, unrefs = 0;
  child.unref = () => { unrefs += 1; };
  const signals = [], payloads = [], options = {
    spawnImpl: (executable, args, spec) => {
      spawns += 1; assert.equal(executable, CLI); assert.equal(spec.cwd, FIXED.source); assert.equal(spec.detached, true);
      assert.deepEqual(spec.stdio, ['ignore', 'pipe', 'pipe']); assert(!args.includes('--password')); assert(!Object.hasOwn(spec.env, 'SUPABASE_ACCESS_TOKEN'));
      queueMicrotask(() => onSpawn({ child, stdout: bytes => { payloads.push(bytes); child.stdout.emit('data', bytes); },
        stderr: bytes => { payloads.push(bytes); child.stderr.emit('data', bytes); },
        close: code => { absent = closedGroup; child.stdout.end(); child.stderr.end(); child.emit('close', code); } }));
      return child;
    },
    kill: (pid, signal) => {
      assert.equal(pid, -child.pid);
      if (signal === 0) {
        if (permissionError) { const error = Error('private-permission-error'); error.code = 'EPERM'; throw error; }
        if (absent) { const error = Error('private-gone'); error.code = 'ESRCH'; throw error; }
        return;
      }
      signals.push(signal);
      if (signal === 'SIGTERM' && onTerm) queueMicrotask(() => { absent = true; child.stdout.end(); child.stderr.end(); child.emit('close', null); });
    }, deadlineMs: 20,
  };
  return { options, signals, payloads, child, spawns: () => spawns, unrefs: () => unrefs };
}

test('one fake invocation succeeds only after zero exit, closed pipes and confirmed absent process group', async () => {
  const f = fixture({ onSpawn: ({ stdout, close }) => { stdout(Buffer.from('[{"readback":{}}]')); close(0); } });
  const result = await capture('preflight', false, f.options);
  assert.equal(result.ok, true); assert.equal(result.processGroupAbsent, true); assert.equal(f.spawns(), 1);
  assert.equal(result.bytes.toString(), '[{"readback":{}}]'); assert(f.payloads.every(bytes => bytes.every(byte => byte === 0)));
  result.bytes.fill(0); assert.deepEqual(f.signals, []);
});

test('private stderr never leaves result, even when CLI also returns a valid read-only response', async () => {
  const f = fixture({ onSpawn: ({ stdout, stderr, close }) => {
    stdout(Buffer.from('[]')); stderr(Buffer.from('synthetic-private-note')); close(0);
  } });
  const result = await capture('preflight', false, f.options);
  assert.equal(result.ok, true); assert(!result.bytes.toString().includes('private'));
  assert(f.payloads.every(bytes => bytes.every(byte => byte === 0))); result.bytes.fill(0);
});

test('nonzero exit drops all private diagnostics and does not retry', async () => {
  const f = fixture({ onSpawn: ({ stdout, stderr, close }) => { stdout(Buffer.from('synthetic-private')); stderr(Buffer.from('denied')); close(1); } });
  const result = await capture('pause', false, f.options);
  assert.equal(result.ok, false); assert.equal(result.bytes.length, 0); assert.equal(f.spawns(), 1); assert.equal(f.unrefs(), 1);
});

test('timeout independently signals owned group and rejects a later zero exit', async () => {
  const f = fixture();
  const result = await capture('pause', false, { ...f.options, deadlineMs: 1 });
  assert.equal(result.ok, false); assert.equal(result.bytes.length, 0); assert.equal(f.spawns(), 1);
  assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(result.processGroupAbsent, true);
});

test('combined stdout/stderr bound aborts once and erases buffered data', async () => {
  const f = fixture({ onSpawn: ({ stdout, stderr }) => { stdout(Buffer.alloc(180 * 1024, 0x61)); stderr(Buffer.alloc(100 * 1024, 0x62)); } });
  const result = await capture('pause', false, f.options);
  assert.equal(result.ok, false); assert.equal(result.bytes.length, 0); assert.equal(f.spawns(), 1);
  assert.deepEqual(f.signals, ['SIGTERM']); assert(f.payloads.every(bytes => bytes.every(byte => byte === 0)));
});

test('child error remains fixed failure without exposing its private error text', async () => {
  const f = fixture({ onSpawn: ({ child }) => child.emit('error', Error('synthetic-private-error')) });
  const result = await capture('pause', false, f.options);
  assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('private')); assert.equal(f.spawns(), 1);
});

test('permission-denied group observation is never treated as absence; hard fence remains bounded', async () => {
  const f = fixture({ permissionError: true, onTerm: false, onSpawn: ({ stdout, close }) => { stdout(Buffer.from('[]')); close(0); } });
  const began = Date.now(), result = await capture('pause', false, f.options);
  assert.equal(result.ok, false); assert.equal(result.processGroupAbsent, false); assert(Date.now() - began < 6500);
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL', 'SIGKILL']); assert.equal(f.unrefs(), 1); assert.equal(f.spawns(), 1);
});

test('invalid step/deadline fails before the fake child can start', () => {
  const f = fixture();
  assert.throws(() => capture('../arbitrary', false, f.options));
  assert.throws(() => capture('pause', false, { ...f.options, deadlineMs: 55001 }));
  assert.throws(() => capture('pause', false, { ...f.options, deadlineMs: 0 }));
  assert.equal(f.spawns(), 0);
});
