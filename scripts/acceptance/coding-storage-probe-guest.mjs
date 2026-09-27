import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rmdir, stat } from "node:fs/promises";

// Diagnostics only: all admission/configuration/storage operations below use
// the separately packaged production helpers without injected ports.
assert.equal(process.getuid(), 0);
const [workerId, transferId] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
assert(uuid.test(workerId) && uuid.test(transferId) && process.argv.length === 4);
const data = `/workspace/${workerId}`, custody = `/var/lib/qorpera-coding/${workerId}`;
const config = JSON.parse(await readFile(`/run/qorpera-coding/${workerId}/configuration/guest.json`, "utf8"));
const report = { schema: "qorpera.coding-storage-guest-probe/v1", workerId, transferId, uid: process.getuid(), sessionUid: config.uid,
  mountInfo: await readFile("/proc/self/mountinfo", "utf8"), ownership: {}, observations: {} };
for (const path of [data, custody, `${data}/repository`, `${data}/home`, `${data}/cache`, `${custody}/inbox`, `${custody}/git`, `${custody}/commands`, `${custody}/logs`]) {
  const entry = await stat(path);
  report.ownership[path] = { uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o7777 };
}
const invoke = (executable, args) => {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  return { status: result.status, signal: result.signal, stdout: result.stdout?.trim(), stderr: result.stderr?.trim(), error: result.error?.code ?? null };
};
report.observations.initialize = invoke("/usr/bin/node", ["/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "initialize", workerId]);
// Independent syscall observation distinguishes a custody permission failure
// from unrelated image, configuration, mount or helper refusal.
const probe = `${custody}/git/probe-${transferId}`;
try {
  await mkdir(probe, { mode: 0o755 });
  report.observations.rootCustodyCreate = { succeeded: true, uid: (await stat(probe)).uid };
  await rmdir(probe);
} catch (error) {
  report.observations.rootCustodyCreate = { succeeded: false, code: error.code ?? "UNKNOWN" };
}
report.observations.gitPrepare = invoke("/usr/bin/node", ["/opt/qorpera-coding/cloud-coding-git-guest.mjs", "prepare", workerId, transferId]);
// A session user can still write its correctly provisioned workspace. This
// proves that the negative supervisor result is not a read-only/broken mount.
report.observations.sessionWrite = invoke("/usr/bin/setpriv", ["--reuid", String(config.uid), "--regid", String(config.gid), "--clear-groups", "/usr/bin/node", "-e",
  "const fs=require('node:fs'); const p=process.argv[1]; fs.writeFileSync(p,'session-write-ok\\n',{flag:'wx',mode:0o600}); console.log(fs.readFileSync(p,'utf8').trim());", `${data}/repository/probe.txt`]);
console.log(JSON.stringify(report));
