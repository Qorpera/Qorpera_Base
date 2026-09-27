import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chown, cp, lstat, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { waitForCodingChild } from "./coding-executor-fixture.mjs";
import { assertWorkloadRun, assertWorkloadShape } from "./workload-usage-host.mjs";

// Fresh GitHub-hosted diagnostic infrastructure only. No production host,
// company, payment provider, model provider or GitHub repository is contacted.
assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
await assertWorkloadRun({ githubHosted: true });
assert.equal(process.argv.length, 4); assert.equal(process.argv[2], "--out");
assertWorkloadShape({ cpuCount: 1, memoryBytes: 2 * 1024 ** 3 }, { cpuMillis: cpus().length * 1000, memoryBytes: totalmem() });
assert((await stat("/dev/kvm")).isCharacterDevice());
const repository = fileURLToPath(new URL("../../", import.meta.url)), out = resolve(process.argv[3]);
const root = "/opt/qorpera-coding-executor-acceptance", source = `${root}/source`, account = "qorpera-usage-acceptance", uid = 1251;
const imageVm = "qorpera-coding-executor-image", imageAlias = "qorpera-coding-executor-diagnostic";
const unit = "qorpera-coding-executor-acceptance-guard.service", guardState = "/var/lib/qorpera-paid-computer-guard";
const exportRoot = `${root}/export`, mount = `${root}/nas`, exportsFile = "/etc/exports.d/qorpera-coding-executor-acceptance.exports";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const evidence = { schema: "qorpera.coding-executor-physical/v1", commit: process.env.GITHUB_SHA ?? null,
  passed: false, cleanup: false, hostCleanup: false, phase: "preflight" };
const forwardingRules = [];
let user = false, createdRoot = false, exported = false, mounted = false, imageCreated = false, imageFingerprint, installed = false, childStarted = false, childEvidence, stateIdentity;
function command(executable, args, timeout = 30000) {
  const result = spawnSync(executable, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 4 * 1024 ** 2 });
  return { status: result.status, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}
function run(executable, args, timeout) {
  const result = command(executable, args, timeout);
  assert.equal(result.status, 0, `CODING_EXECUTOR_ACCEPTANCE_COMMAND_FAILED:${executable}:${result.stderr.slice(0, 1500)}`);
  return result.stdout;
}
const guest = (args, timeout) => run("lxc", ["exec", imageVm, "--", ...args], timeout);
try {
  await mkdir(out, { recursive: true, mode: 0o755 });
  assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), []);
  assert.deepEqual(JSON.parse(run("lxc", ["storage", "list", "--format=json"])), []);
  assert.equal(run("exportfs", []), "");
  for (const path of [root, guardState, "/run/qorpera-paid-computer-guard", `/etc/systemd/system/${unit}`, exportsFile])
    await assert.rejects(lstat(path), { code: "ENOENT" }, "Existing custody must not be touched");
  for (const key of [account, String(uid)]) assert.equal(command("getent", ["passwd", key]).status, 2);
  run("lxd", ["init", "--auto", "--storage-backend", "dir"], 90000);
  run("lxc", ["network", "set", "lxdbr0", "ipv6.address", "none"]);
  run("lxc", ["network", "set", "lxdbr0", "ipv4.nat", "true"]);
  await mkdir(root, { mode: 0o755 }); createdRoot = true;
  run("useradd", ["--uid", String(uid), "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", account]); user = true;
  run("usermod", ["--append", "--groups", "lxd", account]);
  await mkdir(`${source}/scripts/acceptance`, { recursive: true, mode: 0o755 });
  await mkdir(`${source}/supabase`, { recursive: true, mode: 0o755 });
  for (const name of ["native-postgres.mjs", "coding-executor-case.mjs", "coding-executor-fixture.mjs", "workload-usage-host.mjs", "workload-usage-evidence.mjs", "workload-usage-shared.mjs"])
    await cp(join(repository, "scripts/acceptance", name), `${source}/scripts/acceptance/${name}`);
  await cp(join(repository, "scripts/test-hosted-db.mjs"), `${source}/scripts/test-hosted-db.mjs`);
  for (const name of ["migrations", "tests"]) await cp(join(repository, "supabase", name), `${source}/supabase/${name}`, { recursive: true });
  const bundle = async (entry, outfile) => build({ absWorkingDir: repository, entryPoints: [entry], outfile,
    bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  await bundle("scripts/acceptance/coding-executor-tools.ts", `${source}/scripts/acceptance/coding-executor-tools.mjs`);
  run(process.execPath, [`${source}/scripts/acceptance/coding-executor-tools.mjs`, "namespace"]);
  evidence.phase = "diagnostic_image_before_paid_admission";
  run(process.execPath, ["scripts/package-coding-guest.mjs", "--out", `${root}/package`], 60000);
  const manifest = JSON.parse(await readFile(`${root}/package/manifest.json`, "utf8"));
  run("lxc", ["init", "ubuntu:24.04", imageVm, "--vm", "--no-profiles", "--storage", "default", "-c", "limits.cpu=1", "-c", "limits.memory=2GiB"], 240000); imageCreated = true;
  run("lxc", ["config", "device", "add", imageVm, "network", "nic", "network=lxdbr0", "name=eth0"]);
  const baseImageFingerprint = JSON.parse(run("lxc", ["query", `/1.0/instances/${imageVm}`])).config["volatile.base_image"];
  run("lxc", ["start", imageVm], 90000);
  let ready = false;
  for (let n = 0; n < 120; n++) { if (command("lxc", ["exec", imageVm, "--", "true"], 3000).status === 0) { ready = true; break; } await delay(1000); }
  assert(ready, "Diagnostic image agent unavailable");
  // The hosted runner may retain a container firewall with FORWARD DROP.
  // Pin exceptions to this image-building VM and web egress only.
  let address;
  const addressDeadline = Date.now() + 30000;
  while (Date.now() < addressDeadline) {
    const result = command("lxc", ["exec", imageVm, "--", "ip", "-j", "-4", "address", "show", "dev", "eth0"], Math.min(3000, addressDeadline - Date.now()));
    if (result.status === 0) address = JSON.parse(result.stdout)[0]?.addr_info?.find((a) => a.scope === "global")?.local;
    if (address) break;
    await delay(Math.min(1000, Math.max(0, addressDeadline - Date.now())));
  }
  assert(address, "Diagnostic image DHCP unavailable after 30 seconds");
  const outward = JSON.parse(run("ip", ["-j", "-4", "route", "get", "1.1.1.1"]))[0].dev;
  assert(/^\d+\.\d+\.\d+\.\d+$/.test(address) && /^[a-zA-Z0-9_.-]+$/.test(outward) && outward !== "lxdbr0");
  evidence.imageNetwork = { address, outward, beforeForwardRules: run("iptables", ["-S", "FORWARD"]) };
  for (const rule of [
    ["FORWARD", "-i", "lxdbr0", "-s", `${address}/32`, "-o", outward, "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED", "-m", "comment", "--comment", "qorpera-coding-executor-image", "-j", "ACCEPT"],
    ["FORWARD", "-i", outward, "-o", "lxdbr0", "-d", `${address}/32`, "-p", "tcp", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", "qorpera-coding-executor-image", "-j", "ACCEPT"],
  ]) { run("iptables", ["-I", rule[0], "1", ...rule.slice(1)]); forwardingRules.push(rule); }
  guest(["/usr/bin/cloud-init", "status", "--wait"], 120000);
  guest(["/usr/bin/env", "DEBIAN_FRONTEND=noninteractive", "/usr/bin/apt-get", "update"], 120000);
  guest(["/usr/bin/env", "DEBIAN_FRONTEND=noninteractive", "/usr/bin/apt-get", "install", "--yes", "git", "libnss-systemd", "python3", "ca-certificates"], 120000);
  guest(["mkdir", "-p", "/opt/qorpera-coding", "/workspace", "/var/lib/qorpera-coding", "/run/qorpera-coding"]);
  guest(["chmod", "0755", "/opt/qorpera-coding", "/workspace", "/var/lib/qorpera-coding", "/run/qorpera-coding"]);
  guest(["useradd", "--uid", "1100", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", "coding-image"]);
  run("lxc", ["file", "push", process.execPath, `${imageVm}/usr/bin/node`, "--mode=0755", "--uid=0", "--gid=0"]);
  const installation = { schema: "qorpera.coding-executor-diagnostic-image/v1", signedRelease: false,
    baseImageFingerprint, nodeSha256: hash(await readFile(process.execPath)), nodeVersion: guest(["/usr/bin/node", "--version"]),
    gitVersion: guest(["git", "--version"]), artifacts: manifest.artifacts, units: [] };
  for (const artifact of manifest.artifacts) {
    const path = `${root}/package/${artifact.file}`; assert.equal(hash(await readFile(path)), artifact.sha256);
    run("lxc", ["file", "push", path, `${imageVm}${artifact.installedPath}`, "--mode=0444", "--uid=0", "--gid=0"]);
    assert.equal(guest(["sha256sum", artifact.installedPath]).split(" ")[0], artifact.sha256);
  }
  for (const name of ["qorpera-coding-watchdog.service", "qorpera-coding-watchdog.timer", "qorpera-coding.slice"]) {
    const path = join(repository, "deploy/coding-worker", name), sha256 = hash(await readFile(path));
    run("lxc", ["file", "push", path, `${imageVm}/etc/systemd/system/${name}`, "--mode=0444", "--uid=0", "--gid=0"]);
    assert.equal(guest(["sha256sum", `/etc/systemd/system/${name}`]).split(" ")[0], sha256); installation.units.push({ name, sha256 });
  }
  guest(["systemctl", "mask", "apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service", "unattended-upgrades.service"]);
  guest(["systemctl", "daemon-reload"]); guest(["systemctl", "enable", "--now", "qorpera-coding-watchdog.timer"]);
  guest(["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "image"]);
  const bootstrapSha256 = hash(JSON.stringify(installation));
  run("lxc", ["stop", imageVm], 60000);
  run("lxc", ["publish", imageVm, "--alias", imageAlias], 120000);
  imageFingerprint = JSON.parse(run("lxc", ["image", "info", imageAlias, "--format=json"])).fingerprint;
  assert(/^[a-f0-9]{64}$/.test(imageFingerprint));
  const image = JSON.parse(run("lxc", ["query", `/1.0/images/${imageFingerprint}`]));
  run("lxc", ["query", "-X", "PUT", `/1.0/images/${imageFingerprint}`, "-d", JSON.stringify({ auto_update: false, public: false, properties: image.properties, profiles: [] })]);
  run("lxc", ["delete", imageVm]); imageCreated = false;
  while (forwardingRules.length) run("iptables", ["-D", ...forwardingRules.pop()]);
  evidence.image = { ...installation, imageFingerprint, bootstrapSha256 };
  evidence.phase = "private_identity_preserving_nfs";
  await mkdir(exportRoot, { mode: 0o755 }); await mkdir(`${exportRoot}/coding`, { mode: 0o755 }); await mkdir(mount, { mode: 0o755 });
  await mkdir(`${exportRoot}/coding/executor`, { mode: 0o700 }); await chown(`${exportRoot}/coding/executor`, uid, uid);
  await mkdir("/etc/exports.d", { recursive: true, mode: 0o755 });
  await writeFile(exportsFile, `${exportRoot} 127.0.0.1(rw,sync,no_root_squash,no_all_squash,no_subtree_check,fsid=0)\n${exportRoot}/coding 127.0.0.1(rw,sync,no_root_squash,no_all_squash,no_subtree_check,fsid=1)\n`, { flag: "wx", mode: 0o644 }); exported = true;
  run("systemctl", ["start", "nfs-server"]); run("exportfs", ["-ra"]);
  evidence.exports = run("exportfs", ["-v"]);
  const exports = [...evidence.exports.matchAll(/(?:^|\n)(\S+)\s+127\.0\.0\.1\(([^)]+)\)/g)].map((m) => ({ path: m[1], flags: new Set(m[2].split(",")) }));
  assert.deepEqual(exports.map((e) => e.path).sort(), [exportRoot, `${exportRoot}/coding`].sort());
  assert(exports.every((e) => ["rw", "sync", "no_root_squash", "no_all_squash"].every((f) => e.flags.has(f)) && !e.flags.has("root_squash") && !e.flags.has("all_squash")));
  run("mount", ["-t", "nfs4", "-o", "vers=4.2,proto=tcp,hard,nosuid,nodev", "127.0.0.1:/coding", mount]); mounted = true;
  const nas = { schema: "qorpera.coding-nas-policy/v1", mountPoint: mount, rootPath: `${mount}/executor`, source: "127.0.0.1:/coding", serverAddress: "127.0.0.1" };
  evidence.privateRoot = { uid: (await stat(nas.rootPath)).uid, mode: (await stat(nas.rootPath)).mode & 0o7777 };
  assert.deepEqual(evidence.privateRoot, { uid, mode: 0o700 });
  await mkdir(`${root}/fixture`, { mode: 0o755 });
  const fixture = `${root}/fixture/repo`;
  run("git", ["init", "--initial-branch=master", fixture]);
  await writeFile(`${fixture}/value.txt`, "initial\n", { flag: "wx" });
  run("git", ["-C", fixture, "add", "value.txt"]);
  run("git", ["-C", fixture, "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-m", "fixture"]);
  run("git", ["clone", "--bare", "--no-hardlinks", fixture, `${root}/fixture/repository.git`]);
  await bundle("deploy/coding-worker/paid-computer-guard.ts", `${root}/guard.mjs`);
  const template = await readFile(join(repository, "deploy/coding-worker/qorpera-paid-computer-guard.service"), "utf8");
  await writeFile(`/etc/systemd/system/${unit}`, template.replaceAll("qorpera-coding-executor", account)
    .replace(/ExecStart=[^\n]+/, `ExecStart=${process.execPath} ${root}/guard.mjs`), { flag: "wx", mode: 0o644 }); installed = true;
  run("systemctl", ["daemon-reload"]); run("systemctl", ["start", unit]); stateIdentity = await lstat(guardState);
  assert(stateIdentity.isDirectory() && !stateIdentity.isSymbolicLink() && stateIdentity.uid === uid);
  const artifactHash = (name) => manifest.artifacts.find((a) => a.file === name).sha256;
  const guestPolicy = { uid: 1100, gid: 1100, resourceProfile: { maxTimeoutMs: 60000, memoryBytes: 512 * 1024 ** 2, tasksMax: 64, cpuQuotaPercent: 100, maxLogBytes: 1048576 },
    storageHelperSha256: artifactHash("cloud-coding-storage-guest.mjs"), commandHelperSha256: artifactHash("cloud-coding-command-guest.mjs"),
    gitHelperSha256: artifactHash("cloud-coding-git-guest.mjs"), watchdogHelperSha256: artifactHash("cloud-coding-watchdog.mjs") };
  await mkdir(`${root}/results`, { mode: 0o700 }); await chown(`${root}/results`, uid, uid);
  await writeFile(`${root}/case.json`, JSON.stringify({ out: `${root}/results/evidence.json`, imageFingerprint, bootstrapSha256,
    nas, guest: guestPolicy, bareRepository: `${root}/fixture/repository.git`, socketGid: (await stat("/var/snap/lxd/common/lxd/unix.socket")).gid,
    imageEvidence: evidence.image }), { flag: "wx", mode: 0o444 });
  evidence.phase = "real_executor"; childStarted = true;
  const child = spawn("runuser", ["-u", account, "--", process.execPath, `${source}/scripts/acceptance/coding-executor-case.mjs`, `${root}/case.json`], { stdio: "inherit", detached: true });
  const code = await waitForCodingChild(child, { timeoutMs: 18 * 60000, kill: (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } } });
  childEvidence = JSON.parse(await readFile(`${root}/results/evidence.json`, "utf8"));
  Object.assign(evidence, childEvidence); assert.equal(code, 0); assert(evidence.passed && evidence.cleanup);
} catch (error) { evidence.error ??= String(error).slice(0, 4000); evidence.passed = false; process.exitCode = 1; }
finally {
  try {
    while (forwardingRules.length) run("iptables", ["-D", ...forwardingRules.pop()]);
    if (imageCreated) { run("lxc", ["delete", imageVm, "--force"], 60000); imageCreated = false; }
    // Missing child closure retains guard, database, NAS and its account.
    assert(!childStarted || childEvidence?.cleanup === true, "Unconfirmed executor custody retained");
    assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), []);
    if (installed) {
      assert(stateIdentity, "Guard startup custody identity unconfirmed; retain service and state");
      run("systemctl", ["stop", unit]);
      const now = await lstat(guardState); assert.equal(now.ino, stateIdentity.ino); assert.equal(now.dev, stateIdentity.dev);
      await rm(guardState, { recursive: true }); await unlink(`/etc/systemd/system/${unit}`); run("systemctl", ["daemon-reload"]);
    }
    if (mounted) run("umount", [mount], 30000);
    if (exported) { await unlink(exportsFile); run("exportfs", ["-ra"]); }
    if (imageFingerprint) run("lxc", ["image", "delete", imageFingerprint]);
    if (user) run("userdel", [account]);
    if (createdRoot) await rm(root, { recursive: true });
    evidence.hostCleanup = true;
  } catch (error) { evidence.hostCleanup = false; evidence.passed = false; evidence.hostCleanupError = String(error).slice(0, 2000); process.exitCode = 1; }
  await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ phase: evidence.phase, passed: evidence.passed, cleanup: evidence.cleanup, hostCleanup: evidence.hostCleanup }));
}
