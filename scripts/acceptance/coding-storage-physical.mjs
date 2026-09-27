import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, mkdir, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { classifyCodingStorageProbe } from "./coding-storage-probe-contract.mjs";

// Diagnostic infrastructure only. No company, model, GitHub, paid admission,
// repository execution or production deployment is represented by this VM.
assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert(process.argv.length === 4 && process.argv[2] === "--out");
assert(cpus().length >= 2 && totalmem() > 3 * 1024 ** 3);
assert((await stat("/dev/kvm")).isCharacterDevice());
const repository = fileURLToPath(new URL("../../", import.meta.url)), out = resolve(process.argv[3]);
const root = "/srv/qorpera-coding-storage-probe", exported = `${root}/export`, mount = `${root}/mount`;
const exportsFile = "/etc/exports.d/qorpera-coding-storage-probe.exports", vm = "qorpera-coding-storage-probe";
const workerId = randomUUID(), companyId = randomUUID(), environmentId = randomUUID(), vmId = randomUUID(), transferId = randomUUID();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidence = { schema: "qorpera.coding-storage-physical-probe/v1", commit: process.env.GITHUB_SHA ?? null,
  scope: "Diagnostic real root-squashed NFSv4 + LXD virtiofs + unchanged production coding storage/Git helpers. No executor, repository, billing, model or GitHub acceptance.",
  diagnosticCompleted: false, compatible: false, cleanup: false, phase: "preflight" };
const startedAt = new Date().toISOString();
let ownsRoot = false, exportedNow = false, mounted = false, createdVm = false;
function command(executable, args, timeout = 30000) {
  const result = spawnSync(executable, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 2 * 1024 ** 2 });
  return { status: result.status, signal: result.signal, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), error: result.error?.code ?? null };
}
function run(executable, args, timeout) {
  const result = command(executable, args, timeout);
  assert.equal(result.status, 0, `${executable} failed: ${JSON.stringify(result).slice(0, 3000)}`);
  return result.stdout;
}
const guest = (args, timeout) => run("lxc", ["exec", vm, "--", ...args], timeout);
async function directory(path, uid, mode) { await mkdir(path, { mode }); await chown(path, uid, uid); await chmod(path, mode); }
async function file(path, content, uid, mode) { await writeFile(path, content, { mode, flag: "wx" }); await chown(path, uid, uid); }
async function diagnostics() {
  const result = {};
  for (const [key, executable, args] of [
    ["state", "lxc", ["query", `/1.0/instances/${vm}/state`]],
    ["instance", "lxc", ["query", `/1.0/instances/${vm}`]],
    ["operations", "lxc", ["query", "/1.0/operations?recursion=1"]],
    ["instanceLog", "lxc", ["info", vm, "--show-log"]],
    ["daemonJournal", "journalctl", ["-u", "snap.lxd.daemon", "--since", startedAt, "-n", "120", "--no-pager", "--output=short-monotonic"]],
  ]) {
    const observed = command(executable, args, 5000);
    result[key] = { ...observed, stdout: observed.stdout.slice(-32768), stderr: observed.stderr.slice(-4096) };
  }
  const logs = `/var/snap/lxd/common/lxd/logs/${vm}`;
  result.physicalLogs = {};
  try {
    const ownedNames = new Set(["qemu.log", "qemu.early.log", "disk.coding-data.log", "disk.coding-custody.log"]);
    for (const name of (await readdir(logs)).filter((name) => ownedNames.has(name) || /^virtiofs[A-Za-z0-9_.-]*\.log$/.test(name)).slice(0, 12)) {
      try {
        const handle = await open(join(logs, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const entry = await handle.stat();
          if (!entry.isFile()) continue;
          const bytes = Buffer.alloc(Math.min(entry.size, 32768));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, Math.max(0, entry.size - bytes.length));
          result.physicalLogs[name] = { bytes: entry.size, tail: bytes.subarray(0, bytesRead).toString("utf8") };
        } finally { await handle.close(); }
      } catch (error) { result.physicalLogs[name] = { error: error.code ?? "UNKNOWN" }; }
    }
  } catch (error) { result.logReadCode = error.code ?? "UNKNOWN"; }
  return result;
}
try {
  await mkdir(out, { recursive: true, mode: 0o755 });
  assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), []);
  assert.deepEqual(JSON.parse(run("lxc", ["storage", "list", "--format=json"])), [], "Fresh uninitialized disposable LXD required");
  assert.equal(run("exportfs", []), "", "No existing NFS exports permitted");
  run("lxd", ["init", "--auto", "--storage-backend", "dir"], 90000);
  run("lxc", ["network", "set", "lxdbr0", "ipv6.address", "none"]);
  evidence.lxdVersion = run("lxc", ["version"]);
  await directory(root, 0, 0o755); ownsRoot = true;
  await directory(exported, 0, 0o755); await directory(`${exported}/coding`, 0, 0o755); await directory(mount, 0, 0o755);
  await directory(`${exported}/coding/executor`, 1100, 0o700);
  await file(`${exported}/coding/executor/traversal-sentinel`, "executor-readable\n", 1100, 0o600);
  await mkdir("/etc/exports.d", { recursive: true, mode: 0o755 });
  const exports = `${exported} 127.0.0.1(rw,sync,root_squash,no_subtree_check,fsid=0)\n${exported}/coding 127.0.0.1(rw,sync,root_squash,no_subtree_check,fsid=1)\n`;
  await writeFile(exportsFile, exports, { mode: 0o644, flag: "wx" }); exportedNow = true;
  run("systemctl", ["start", "nfs-server"]); run("exportfs", ["-ra"]);
  evidence.exports = run("exportfs", ["-v"]);
  assert(evidence.exports.includes("root_squash") && !evidence.exports.includes("no_root_squash"));
  run("mount", ["-t", "nfs4", "-o", "vers=4.2,proto=tcp,hard,nosuid,nodev", "127.0.0.1:/coding", mount]); mounted = true;
  evidence.hostMountInfo = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter((line) => line.includes(` ${mount} `));
  assert.equal(evidence.hostMountInfo.length, 1); assert(evidence.hostMountInfo[0].includes(" - nfs4 "));
  evidence.phase = "production_private_ancestry";
  const traversal = { owner: 1100, mode: 0o700, root: null,
    executor: command("setpriv", ["--reuid=1100", "--regid=1100", "--clear-groups", "cat", `${mount}/executor/traversal-sentinel`]) };
  try { traversal.root = { succeeded: true, content: await readFile(`${mount}/executor/traversal-sentinel`, "utf8") }; }
  catch (error) { traversal.root = { succeeded: false, code: error.code ?? "UNKNOWN" }; }
  assert.equal(traversal.executor.status, 0); assert.equal(traversal.executor.stdout, "executor-readable");
  evidence.productionAncestry = traversal;
  // Separate diagnostic, intentionally NOT full host NAS admission: make only
  // host ancestors traversable to isolate guest dynamic custody semantics.
  // Session roots, data/custody children and helper ownership remain exact.
  await chmod(`${exported}/coding/executor`, 0o755);
  evidence.helperIsolation = { hostAncestorsMode: "0755", productionHostAdmissionClaimed: false, rootSquashUnchanged: true };
  let cursor = `${exported}/coding/executor`;
  for (const name of ["workers", companyId, environmentId, workerId]) { cursor += `/${name}`; await directory(cursor, 1100, 0o755); }
  await directory(`${cursor}/data`, 1100, 0o755); await directory(`${cursor}/guest-state`, 1100, 0o755);
  for (const name of ["repository", "home", "cache"]) await directory(`${cursor}/data/${name}`, 200000, 0o700);
  for (const name of ["inbox", "logs", "commands", "git"]) await directory(`${cursor}/guest-state/${name}`, 0, 0o755);
  const source = `${mount}/executor/workers/${companyId}/${environmentId}/${workerId}`;
  const storage = { schema: "qorpera.coding-storage/v1", volumeId: workerId, workerId, companyId, environmentId, writerGeneration: 1,
    machineIdSha256: hash((await readFile("/etc/machine-id", "utf8")).trim()),
    policy: { schema: "qorpera.coding-nas-policy/v1", mountPoint: mount, rootPath: `${mount}/executor`, source: "127.0.0.1:/coding", serverAddress: "127.0.0.1" },
    dataSource: `${source}/data`, custodySource: `${source}/guest-state`, dataTarget: "/workspace", custodyTarget: "/var/lib/qorpera-coding" };
  for (const name of ["data", "guest-state"]) await file(`${cursor}/${name}/.qorpera-volume.json`, JSON.stringify(storage), 1100, 0o444);
  const request = { schema: "qorpera.coding-git-transfer/v1", workerId, vmId, transferId, action: "seed",
    repository: { host: "github.com", owner: "acceptance", name: "offline", baseBranch: "main" }, headSha: "a".repeat(40), bundleSha256: "b".repeat(64), bundleBytes: 1 };
  // Server-side staging is explicit: this probe tests the subsequent dynamic
  // supervisor writes, not LXD's already problematic root-owned inbox upload.
  await file(`${cursor}/guest-state/inbox/${transferId}.git.json`, JSON.stringify(request), 0, 0o444);
  run(process.execPath, ["scripts/package-coding-guest.mjs", "--out", `${root}/package`], 60000);
  const manifest = JSON.parse(await readFile(`${root}/package/manifest.json`, "utf8")); evidence.package = manifest;
  evidence.phase = "guest_start";
  run("lxc", ["init", "ubuntu:24.04", vm, "--vm", "--no-profiles", "--storage", "default", "-c", "limits.cpu=1", "-c", "limits.memory=1GiB"], 240000); createdVm = true;
  const instance = JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}`]));
  evidence.baseImageFingerprint = instance.config["volatile.base_image"]; evidence.physicalId = instance.config["volatile.uuid"];
  run("lxc", ["config", "device", "add", vm, "coding-data", "disk", `source=${source}/data`, `path=/workspace/${workerId}`]);
  run("lxc", ["config", "device", "add", vm, "coding-custody", "disk", `source=${source}/guest-state`, `path=/var/lib/qorpera-coding/${workerId}`]);
  run("lxc", ["start", vm], 60000);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (command("lxc", ["exec", vm, "--", "true"], 3000).status === 0) { ready = true; break; }
    await delay(1000);
  }
  assert(ready, "Guest agent unavailable");
  guest(["mkdir", "-p", "/opt/qorpera-coding", "/run/qorpera-coding"]);
  run("lxc", ["file", "push", process.execPath, `${vm}/usr/bin/node`, "--mode=0755", "--uid=0", "--gid=0"]);
  evidence.node = { version: guest(["/usr/bin/node", "--version"]), sha256: hash(await readFile(process.execPath)) };
  for (const artifact of manifest.artifacts) {
    const path = `${root}/package/${artifact.file}`;
    assert.equal(hash(await readFile(path)), artifact.sha256);
    run("lxc", ["file", "push", path, `${vm}${artifact.installedPath}`, "--mode=0444", "--uid=0", "--gid=0"]);
    assert.equal(guest(["sha256sum", artifact.installedPath]).split(" ")[0], artifact.sha256);
  }
  guest(["systemctl", "mask", "apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service", "unattended-upgrades.service"]);
  const bootId = guest(["cat", "/proc/sys/kernel/random/boot_id"]), layout = `/workspace/${workerId}`;
  const config = { schema: "qorpera.coding-command-guest/v3", workerId, vmId, bootId, uid: 200000, gid: 200000,
    workspacePath: `${layout}/repository`, homePath: `${layout}/home`, cachePath: `${layout}/cache`, outputRoot: `/var/lib/qorpera-coding/${workerId}/logs`,
    resourceProfile: { maxTimeoutMs: 30000, memoryBytes: 268435456, tasksMax: 32, cpuQuotaPercent: 50, maxLogBytes: 1048576 } };
  guest(["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "prepare", workerId]);
  const packet = { schema: "qorpera.coding-configuration-install/v1", guest: config, storage };
  await file(`${root}/configuration.json`, JSON.stringify(packet), 0, 0o444);
  run("lxc", ["file", "push", `${root}/configuration.json`, `${vm}/run/qorpera-coding/${workerId}/configuration/configuration-inbox.json`, "--mode=0444", "--uid=0", "--gid=0"]);
  guest(["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "install", workerId]);
  run("lxc", ["file", "push", "scripts/acceptance/coding-storage-probe-guest.mjs", `${vm}/opt/qorpera-coding/probe.mjs`, "--mode=0444", "--uid=0", "--gid=0"]);
  evidence.phase = "production_guest_helpers";
  evidence.guest = JSON.parse(guest(["/usr/bin/node", "/opt/qorpera-coding/probe.mjs", workerId, transferId], 60000));
  evidence.result = classifyCodingStorageProbe(evidence.guest);
  evidence.diagnosticCompleted = true; evidence.compatible = evidence.result.compatible;
  if (!evidence.compatible) process.exitCode = 2; // Proven incompatibility is deliberately not a green acceptance.
} catch (error) {
  evidence.error = String(error).slice(0, 6000); process.exitCode = 1;
} finally {
  if (createdVm) evidence.physicalDiagnostics = await diagnostics();
  try {
    if (createdVm) run("lxc", ["delete", vm, "--force"], 60000);
    if (mounted) run("umount", [mount], 30000);
    if (exportedNow) { await unlink(exportsFile); run("exportfs", ["-ra"]); }
    if (ownsRoot) await rm(root, { recursive: true });
    evidence.cleanup = true;
  } catch (error) { evidence.cleanupError = String(error).slice(0, 2000); evidence.compatible = false; process.exitCode = 1; }
  await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ diagnosticCompleted: evidence.diagnosticCompleted, compatible: evidence.compatible, result: evidence.result, phase: evidence.phase, cleanup: evidence.cleanup }));
}
