import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { FIXED, MUTATIONS, ROOT, STEPS, hash, need } from './contract.mjs';
import { readTrusted } from './files.mjs';

export const CLI = FIXED.cliPath;
export const CLI_SHA256 = '42a9fe8b8a266bc0fbde804c08efb75cc0653480e91ba3f20fba1c3c27a7b49a';
export function argumentsFor(step, reconciliation = false) {
  need((reconciliation ? MUTATIONS : STEPS).includes(step), 'TRANSPORT_STEP_REJECTED');
  return ['db', 'query', '--linked', '--project-ref', FIXED.project, '--file', join(ROOT, 'sql', `${reconciliation ? 'reconcile-' : ''}${step}.sql`), '--output', 'json'];
}
export function verifyCli() { need(hash(readTrusted(CLI, 128 * 1024 * 1024)) === CLI_SHA256, 'CLI_CHANGED'); }
// One local invocation; the CLI's internal HTTP attempt count is NOT claimed.
// Atomic server pre-state guards make any post-commit internal resend reject.
export function capture(step, reconciliation = false, { spawnImpl = spawn, kill = process.kill.bind(process), deadlineMs = 55000 } = {}) {
  const args = argumentsFor(step, reconciliation);
  need(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 55000, 'DEADLINE_REJECTED');
  return new Promise(resolve => {
    const chunks = []; let total = 0, done = false, failed = false, timer, hard, force, closed = false, child;
    const absentGroup = () => { if (!child) return true; if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return false;
      try { kill(-child.pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; } };
    const send = signal => { if (Number.isInteger(child?.pid) && child.pid > 1) try { kill(-child.pid, signal); } catch {} };
    const finish = (code, forced = false) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(hard); clearTimeout(force);
      const processGroupAbsent = absentGroup(), ok = !failed && !forced && code === 0 && closed && processGroupAbsent;
      const bytes = ok ? Buffer.concat(chunks) : Buffer.alloc(0); chunks.forEach(chunk => chunk.fill(0));
      if (!ok) { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); }
      resolve({ ok, bytes, processGroupAbsent });
    };
    const abort = () => { if (done || failed) return; failed = true; send('SIGTERM');
      force = setTimeout(() => send('SIGKILL'), 2000); hard = setTimeout(() => { send('SIGKILL'); finish(null, true); }, 5000); };
    try {
      child = spawnImpl(CLI, args, { cwd: FIXED.source, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', CI: 'true', SUPABASE_TELEMETRY_DISABLED: 'true' } });
      child.once('error', abort); need(Number.isSafeInteger(child.pid) && child.pid > 1, 'CHILD_REJECTED');
      timer = setTimeout(abort, deadlineMs);
      child.stdout.on('data', chunk => { total += chunk.length; if (!failed && total <= 256 * 1024) chunks.push(Buffer.from(chunk)); else abort(); chunk.fill(0); });
      child.stderr.on('data', chunk => { total += chunk.length; if (total > 256 * 1024) abort(); chunk.fill(0); });
      child.once('close', code => { closed = true; if (!absentGroup()) abort(); else finish(code); });
    } catch { failed = true; send('SIGKILL'); finish(null, true); }
  });
}
