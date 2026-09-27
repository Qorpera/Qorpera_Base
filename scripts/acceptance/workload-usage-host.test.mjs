import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertEmptyWorkloadInventory, assertWorkloadFile, assertWorkloadHostManifest, assertWorkloadImageHostManifest, assertWorkloadShape } from "./workload-usage-host.mjs";

const manifest = () => ({ schema: "qorpera.workload-usage-host/v1", complete: true, disposableHost: true,
 hostMachineIdSha256: "a".repeat(64), hostBootId: "12345678-1234-4234-8234-123456789012", commit: "b".repeat(40),
 imageFingerprint: "c".repeat(64), bootstrapSha256: "d".repeat(64) });

test("explicit disposable host binds source, current machine and boot, and both image pins", () => {
 const host = manifest(); assert.equal(assertWorkloadHostManifest(host, host), host);
 for (const key of ["hostMachineIdSha256", "hostBootId", "commit", "imageFingerprint", "bootstrapSha256"])
  assert.throws(() => assertWorkloadHostManifest(host, { ...host, [key]: "different" }), /differs/);
 for (const patch of [{ complete: false }, { disposableHost: false }, { schema: "other" }, { githubHosted: true }, { headroomCpuMillis: 0 }, { cleanupProduction: true }])
  assert.throws(() => assertWorkloadHostManifest({ ...host, ...patch }, host));
});

test("larger shapes retain identical CPU/memory infrastructure reserves", () => {
 const small = { cpuMillis: 2000, memoryBytes: 8 * 1024 ** 3 }, large = { cpuMillis: 4000, memoryBytes: 16 * 1024 ** 3 };
 for (const memoryGiB of [1, 4]) assertWorkloadShape({ cpuCount: 1, memoryBytes: memoryGiB * 1024 ** 3 }, small);
 for (const memoryGiB of [2, 8, 10]) assertWorkloadShape({ cpuCount: 2, memoryBytes: memoryGiB * 1024 ** 3 }, large);
 assert.throws(() => assertWorkloadShape({ cpuCount: 2, memoryBytes: 2 * 1024 ** 3 }, small), /CPU capacity/);
 assert.throws(() => assertWorkloadShape({ cpuCount: 1, memoryBytes: 6 * 1024 ** 3 }, small), /memory capacity/);
 for (const cpuCount of [0, 1.5, 65, NaN]) assert.throws(() => assertWorkloadShape({ cpuCount, memoryBytes: 1024 ** 3 }, large));
});

test("pre-image designation authenticates host/source without accepting invented output image hashes", () => {
 const { imageFingerprint: _image, bootstrapSha256: _bootstrap, ...source } = manifest();
 const host = { ...source, schema: "qorpera.workload-image-host/v1" };
 assert.equal(assertWorkloadImageHostManifest(host, host), host);
 for (const patch of [{ hostBootId: "different" }, { commit: "0".repeat(40) }, { hostMachineIdSha256: "0".repeat(64) }])
  assert.throws(() => assertWorkloadImageHostManifest(host, { ...host, ...patch }));
 assert.throws(() => assertWorkloadImageHostManifest({ ...host, imageFingerprint: "c".repeat(64) }, host));
 assert.throws(() => assertWorkloadHostManifest(host, host));
 const measured = { ...host, schema: "qorpera.workload-usage-host/v1", imageFingerprint: "c".repeat(64), bootstrapSha256: "d".repeat(64) };
 assert.equal(assertWorkloadHostManifest(measured, measured), measured);
});

test("designating a disposable host never admits unrelated LXD custody", () => {
 const empty = { instances: [], projects: [{ name: "default" }], pools: [{ name: "default" }], customVolumes: [] };
 assertEmptyWorkloadInventory(empty);
 for (const [key, extra] of [["instances", { name: "production" }], ["projects", { name: "retained" }], ["pools", { name: "other" }], ["customVolumes", { name: "identity", type: "custom" }]])
  assert.throws(() => assertEmptyWorkloadInventory({ ...empty, [key]: [...empty[key], extra] }), /unrelated/);
});

test("private operator manifests and public child receipts require strict root custody", () => {
 const file = { isFile: () => true, uid: 0, nlink: 1, size: 1000, mode: 0o600 };
 assertWorkloadFile(file, 0o600); assertWorkloadFile({ ...file, mode: 0o444 }, 0o444);
 for (const patch of [{ uid: 1000 }, { nlink: 2 }, { size: 0 }, { size: 16385 }, { mode: 0o644 }, { mode: 0o666 }, { isFile: () => false }])
  assert.throws(() => assertWorkloadFile({ ...file, ...patch }, 0o600), /Root-owned/);
 assert.throws(() => assertWorkloadFile(file, 0o444), /Root-owned/);
});

test("bundled workload tools import host checks without running any acceptance CLI", async () => {
 const root = await mkdtemp(join(tmpdir(), "qorpera-workload-host-import-"));
 try {
  const outfile = join(root, "tools.mjs"), repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  await build({ absWorkingDir: repository, entryPoints: ["scripts/acceptance/workload-usage-tools.ts"], outfile,
   bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
   banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  const result = spawnSync(process.execPath, [outfile, "import-only"], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
 } finally { await rm(root, { recursive: true, force: true }); }
});
