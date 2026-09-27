import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = ["schema", "complete", "disposableHost", "hostMachineIdSha256", "hostBootId", "commit", "imageFingerprint", "bootstrapSha256"];

function assertSourcePins(host, observed) {
 assert.equal(host.complete, true); assert.equal(host.disposableHost, true);
 assert(/^[a-f0-9]{64}$/.test(host.hostMachineIdSha256));
 assert(/^[a-f0-9]{40}$/.test(host.commit)); assert(/^[a-f0-9-]{36}$/.test(host.hostBootId));
 for (const key of ["hostMachineIdSha256", "hostBootId", "commit"])
  assert.equal(host[key], observed[key], `Disposable host ${key} differs`);
}

export function assertWorkloadHostManifest(host, observed) {
 assert.deepEqual(Object.keys(host).sort(), [...keys].sort(), "Unexpected disposable host manifest fields");
 assert.equal(host.schema, "qorpera.workload-usage-host/v1");
 assertSourcePins(host, observed);
 for (const key of ["imageFingerprint", "bootstrapSha256"]) {
  assert(/^[a-f0-9]{64}$/.test(host[key])); assert.equal(host[key], observed[key], `Disposable host ${key} differs`);
 }
 return host;
}

export function assertWorkloadImageHostManifest(host, observed) {
 assert.deepEqual(Object.keys(host).sort(), keys.filter((key) => !["imageFingerprint", "bootstrapSha256"].includes(key)).sort());
 assert.equal(host.schema, "qorpera.workload-image-host/v1");
 // The measured image hashes are added only after image acceptance succeeds.
 assertSourcePins(host, observed);
 return host;
}

export function assertWorkloadShape({ cpuCount, memoryBytes }, capacity) {
 assert(Number.isSafeInteger(cpuCount) && cpuCount > 0 && cpuCount <= 64);
 assert(Number.isSafeInteger(memoryBytes) && memoryBytes >= 1024 ** 3 && memoryBytes <= 1024 ** 4);
 assert(cpuCount * 1000 + 500 <= capacity.cpuMillis, "Requested VM exceeds CPU capacity with 500m headroom");
 assert(memoryBytes + 2 * 1024 ** 3 < capacity.memoryBytes, "Requested VM exceeds memory capacity with 2 GiB headroom");
}

export function assertWorkloadFile(info, mode) {
 assert(info.isFile() && info.uid === 0 && info.nlink === 1 && info.size > 0 && info.size <= 16384 &&
  (info.mode & 0o777) === mode, "Root-owned immutable/private regular acceptance file required");
}

async function protectedJson(path, mode) {
 assert(isAbsolute(path) && await realpath(path) === path, "Canonical acceptance path required");
 for (let parent = dirname(path); ; parent = dirname(parent)) {
  const info = await lstat(parent);
  assert(info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0, "Acceptance ancestors must remain root controlled");
  if (parent === "/") break;
 }
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const info = await file.stat(); assertWorkloadFile(info, mode);
  const bytes = await file.readFile();
  const after = await file.stat();
  assert.equal(after.size, info.size); assert.equal(after.mtimeMs, info.mtimeMs); assert.equal(after.ctimeMs, info.ctimeMs);
  assert.equal(bytes.length, info.size);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: hash(bytes) };
 } finally { await file.close(); }
}

async function identity() {
 const machine = (await readFile("/etc/machine-id", "utf8")).trim();
 const hostBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
 assert(/^[a-f0-9]{32}$/.test(machine)); assert(/^[a-f0-9-]{36}$/.test(hostBootId));
 return { hostMachineIdSha256: hash(machine), hostBootId };
}

export async function assertWorkloadRun(provenance) {
 assert.equal(process.platform, "linux");
 if (provenance.githubHosted === true) {
  assert.deepEqual(Object.keys(provenance).sort(), ["githubHosted"]);
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  return { mode: "github-hosted", commit: process.env.GITHUB_SHA ?? null };
 }
 assert.deepEqual(Object.keys(provenance), ["hostReceiptPath"]);
 const { value: receipt } = await protectedJson(provenance.hostReceiptPath, 0o444);
 assert.equal(receipt.schema, "qorpera.workload-usage-host-receipt/v1");
 assert(/^[a-f0-9]{64}$/.test(receipt.manifestSha256));
 assertWorkloadHostManifest(receipt.host, { ...receipt.host, ...await identity() });
 return { mode: "operator-designated-disposable", commit: receipt.host.commit,
  manifestSha256: receipt.manifestSha256, hostMachineIdSha256: receipt.host.hostMachineIdSha256, hostBootId: receipt.host.hostBootId };
}

export function assertEmptyWorkloadInventory({ instances, projects, pools, customVolumes }) {
 assert.deepEqual(instances, [], "Refuse unrelated LXD instances");
 assert.deepEqual(projects.map((item) => item.name).sort(), ["default"], "Refuse unrelated LXD projects");
 assert.deepEqual(pools.map((item) => item.name).sort(), ["default"], "Refuse unrelated LXD storage pools");
 assert.deepEqual(customVolumes, [], "Refuse unrelated LXD custom volumes");
}

/** Read-only checks plus an immediately closed KVM_CREATE_VM capability probe.
 * No software installation, image download, account, service or DB creation.
 * The operator's prior host designation is required; this manifest proves pins,
 * and must never be treated as permission to clean unrelated resources. */
async function preflight({ path, repository, context, cpuCount, memoryBytes }, imagePreparation) {
 assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
 assert.equal(process.arch, "x64"); assert(Number(process.versions.node.split(".")[0]) >= 24);
 const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 ** 2 });
  assert.equal(result.status, 0, `Disposable preflight command failed: ${command}`);
  return result.stdout.trim();
 };
 const { value: host, sha256 } = await protectedJson(path, 0o600);
 assert.equal(run("/usr/bin/git", ["-C", repository, "status", "--porcelain", "--untracked-files=normal"]), "", "Clean pinned source required");
 const observed = { ...await identity(), commit: run("/usr/bin/git", ["-C", repository, "rev-parse", "HEAD"]) };
 if (imagePreparation) assertWorkloadImageHostManifest(host, observed);
 else assertWorkloadHostManifest(host, { ...observed, imageFingerprint: context.imageFingerprint, bootstrapSha256: context.bootstrapSha256 });
 const capacity = { cpuMillis: cpus().length * 1000, memoryBytes: totalmem() };
 assertWorkloadShape({ cpuCount, memoryBytes }, capacity);
 assert.equal((await readFile("/proc/1/comm", "utf8")).trim(), "systemd");
 assert((await lstat("/dev/kvm")).isCharacterDevice());
 const kvm = JSON.parse(run("/usr/bin/python3", [join(repository, "scripts/acceptance/paid-lxd-kvm.py")]));
 assert.deepEqual(kvm, { apiVersion: 12, createVm: true });
 for (const name of ["postgres", "initdb", "pg_ctl", "psql"]) {
  const path = `/usr/lib/postgresql/17/bin/${name}`, info = await lstat(path);
  assert(info.isFile() && info.uid === 0 && (info.mode & 0o022) === 0, "Protected PostgreSQL17 executable required");
  assert(/^[a-z_]+ \(PostgreSQL\) 17\.[0-9]+(?: \([^\r\n]*\))?$/.test(run(path, ["--version"])), "PostgreSQL 17 release required");
 }
 const lxc = (args) => JSON.parse(run("/snap/bin/lxc", args));
 if (imagePreparation) {
  assert.deepEqual(lxc(["list", "--all-projects", "--format=json"]), [], "Fresh image host must have no instances");
  assert.deepEqual(lxc(["storage", "list", "--format=json"]), [], "Fresh uninitialized image host required");
  assert.deepEqual(lxc(["image", "list", "--format=json"]), [], "Refuse unrelated retained images");
  assert.deepEqual(lxc(["project", "list", "--format=json"]).map((item) => item.name), ["default"]);
  await assert.rejects(lstat("/opt/qorpera-office-image-acceptance"), { code: "ENOENT" }, "Retained image custody must remain untouched");
 } else {
  assertEmptyWorkloadInventory({ instances: lxc(["list", "--all-projects", "--format=json"]),
   projects: lxc(["project", "list", "--format=json"]), pools: lxc(["storage", "list", "--format=json"]),
   customVolumes: lxc(["storage", "volume", "list", "default", "--all-projects", "--format=json"]).filter((item) => item.type === "custom") });
  const image = lxc(["query", `/1.0/images/${host.imageFingerprint}`]);
  assert.equal(image.fingerprint, host.imageFingerprint); assert.equal(image.type, "virtual-machine");
 }
 const server = lxc(["query", "/1.0"]);
 const snap = run("/usr/bin/snap", ["list", "lxd"]).split("\n");
 assert.equal(snap.length, 2); assert.deepEqual(snap[1].trim().split(/\s+/).slice(0, 3), ["lxd", "6.9-ab8fad2", "40424"]);
 assert(["6.9", "6.9-ab8fad2"].includes(server.environment.server_version), "Pinned LXD6.9 server required");
 const networks = lxc(["network", "list", "--format=json"]).filter((item) => item.managed);
 assert.equal(networks.length, imagePreparation ? 0 : 1, "Only the acceptance bridge may be managed");
 if (!imagePreparation) { assert.equal(networks[0].name, "lxdbr0"); assert.equal(networks[0].type, "bridge"); }
 for (const path of ["/var/lib/qorpera-paid-computer-guard", "/var/lib/qorpera-native-computer-guard",
  "/run/qorpera-paid-computer-guard", "/run/qorpera-native-computer-guard",
  "/etc/systemd/system/qorpera-workload-usage-acceptance.service"])
  await assert.rejects(lstat(path), { code: "ENOENT" }, "Existing guard custody must remain untouched");
 for (const [database, key] of [["passwd", "1251"], ["passwd", "qorpera-usage-acceptance"], ["group", "1251"], ["group", "qorpera-usage-acceptance"]]) {
  const result = spawnSync("/usr/bin/getent", [database, key], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 2, "Reserved workload account/group must be absent");
  assert.equal(result.stdout, "");
 }
 return { schema: imagePreparation ? "qorpera.workload-image-host-receipt/v1" : "qorpera.workload-usage-host-receipt/v1", manifestSha256: sha256, host, capacity, kvm };
}

export const preflightWorkloadHost = (options) => preflight(options, false);
export const preflightWorkloadImageHost = (options) => preflight({ ...options, cpuCount: 2, memoryBytes: 4 * 1024 ** 3 }, true);
