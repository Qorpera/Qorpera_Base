import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, chown, cp, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertWorkloadRun, preflightWorkloadHost } from "./workload-usage-host.mjs";
import { collectWorkloadGuardDiagnostics, workloadGuardDiagnosticsPlugin } from "./workload-usage-guard-diagnostics.mjs";

// One private database/guard/account per case on an admitted disposable host.
// Cases can run sequentially after cleanup, reusing the same built image.
// The existing image preparation stage
// owns LXD installation and a pinned, agent-enabled Ubuntu image. This runner
// neither downloads another image nor touches a production node.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
 const name = args[i]; assert(!Object.hasOwn(options, name), "Duplicate workload CLI argument");
 if (["--pool-fallback", "--renew", "--shared-claims", "--shape-mismatch", "--preflight-only"].includes(name)) options[name] = true;
 else {
  assert(["--kind", "--cpus", "--memory-gib", "--image-context", "--out", "--plan", "--disposable-host"].includes(name) && args[i + 1], "Invalid workload CLI");
  options[name] = args[++i];
 }
}
const kind = options["--kind"], cpuCount = Number(options["--cpus"]), memoryBytes = Number(options["--memory-gib"]) * 1024 ** 3;
const planKey = options["--plan"] ?? "basis", poolFallback = options["--pool-fallback"] ?? false;
const renew = options["--renew"] ?? false;
const sharedClaims = options["--shared-claims"] ?? false;
const shapeMismatch = options["--shape-mismatch"] ?? false;
assert(["native", "coding", "login"].includes(kind));
assert(["basis", "dedicated"].includes(planKey) && !(kind === "login" && (poolFallback || renew)));
assert(!sharedClaims || (kind === "coding" && !renew && !poolFallback));
assert(!shapeMismatch || (kind === "native" && !renew && !poolFallback));
assert(Number.isInteger(cpuCount) && cpuCount >= 1 && cpuCount <= 64);
assert(Number.isSafeInteger(memoryBytes) && memoryBytes >= 1024 ** 3 && memoryBytes <= 1024 ** 4);
assert(options["--out"] && options["--image-context"]);
const out = resolve(options["--out"]), context = JSON.parse(await readFile(resolve(options["--image-context"]), "utf8"));
assert(/^[0-9a-f]{64}$/.test(context.imageFingerprint)); assert(/^[0-9a-f]{64}$/.test(context.bootstrapSha256));
assert(!options["--preflight-only"] || options["--disposable-host"], "Preflight-only requires an explicitly designated disposable host");
const hostReceipt = options["--disposable-host"] ? await preflightWorkloadHost({ path: options["--disposable-host"], repository, context, cpuCount, memoryBytes }) : null;
if (!hostReceipt) await assertWorkloadRun({ githubHosted: true });
if (options["--preflight-only"]) { console.log(JSON.stringify(hostReceipt, null, 2)); process.exit(0); }
const root = `/opt/qorpera-workload-usage-${kind}-${cpuCount}-${memoryBytes}-${planKey}-${poolFallback ? "pool" : "member"}-${renew ? "renew" : "short"}${sharedClaims ? "-shared" : ""}${shapeMismatch ? "-mismatch" : ""}`, source = `${root}/source`, account = "qorpera-usage-acceptance", uid = 1251;
const unit = "qorpera-workload-usage-acceptance.service";
const guardState = `/var/lib/${kind === "coding" ? "qorpera-paid-computer-guard" : "qorpera-native-computer-guard"}`;
let installed = false, createdUser = false, childStarted = false, childEvidence = null, stateIdentity, guardInvocation;
function run(command, commandArgs, timeout = 30000) {
 const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 ** 2 });
 assert.equal(result.status, 0, `WORKLOAD_ACCEPTANCE_COMMAND_FAILED: ${command}`);
 return result.stdout.trim();
}
try {
 await mkdir(out, { recursive: true, mode: 0o755 }); await mkdir(root, { mode: 0o755 });
 assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), [], "Refuse unrelated LXD instances");
 run("useradd", ["--uid", String(uid), "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", account]); createdUser = true;
 run("usermod", ["--append", "--groups", "lxd", account]);
 await mkdir(`${source}/scripts/acceptance`, { recursive: true, mode: 0o755 });
 await mkdir(`${source}/supabase`, { recursive: true, mode: 0o755 });
 for (const name of ["native-postgres.mjs", "workload-usage-case.mjs", "workload-usage-host.mjs", "workload-usage-evidence.mjs", "workload-usage-shared.mjs", "workload-usage-guest.py"]) await cp(join(repository, "scripts/acceptance", name), `${source}/scripts/acceptance/${name}`);
 await cp(join(repository, "scripts/test-hosted-db.mjs"), `${source}/scripts/test-hosted-db.mjs`);
 await cp(join(repository, "supabase/migrations"), `${source}/supabase/migrations`, { recursive: true });
 await cp(join(repository, "supabase/tests"), `${source}/supabase/tests`, { recursive: true });
 await build({ absWorkingDir: repository, entryPoints: ["scripts/acceptance/workload-usage-tools.ts"], outfile: `${source}/scripts/acceptance/workload-usage-tools.mjs`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
 run(process.execPath, [`${source}/scripts/acceptance/workload-usage-tools.mjs`, "namespace"]);
 if (kind !== "login") {
  await assert.rejects(lstat(guardState), { code: "ENOENT" }, "Refuse pre-existing guard state");
  const coding = kind === "coding";
  await build({ absWorkingDir: repository, entryPoints: [coding ? "deploy/coding-worker/paid-computer-guard.ts" : "deploy/runtime-computers/paid-computer-guard.ts"], outfile: `${root}/guard.mjs`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
   plugins: [workloadGuardDiagnosticsPlugin(repository)],
   banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  const template = await readFile(join(repository, coding ? "deploy/coding-worker/qorpera-paid-computer-guard.service" : "deploy/runtime-computers/qorpera-computer-guard.service.in"), "utf8");
  const bytes = template.replaceAll("qorpera-coding-executor", account).replaceAll("@ACCOUNT@", account).replaceAll("@PROVIDER@", "native")
   .replace(/ExecStart=[^\n]+/, `ExecStart=${process.execPath} ${root}/guard.mjs${coding ? "" : " --provider native"}`);
  await writeFile(`/etc/systemd/system/${unit}`, bytes, { flag: "wx", mode: 0o644 }); installed = true;
  run("systemctl", ["daemon-reload"]); run("systemctl", ["start", unit]);
  guardInvocation = run("systemctl", ["show", unit, "--property=InvocationID", "--value"]);
  assert(/^[0-9a-f]{32}$/.test(guardInvocation), "Guard service invocation unconfirmed");
  stateIdentity = await lstat(guardState); assert(stateIdentity.isDirectory() && !stateIdentity.isSymbolicLink() && stateIdentity.uid === uid);
 }
 await mkdir(`${root}/results`, { mode: 0o700 }); await chown(`${root}/results`, uid, uid);
 const provenance = hostReceipt ? { hostReceiptPath: `${root}/host-receipt.json` } : { githubHosted: true };
 if (hostReceipt) await writeFile(provenance.hostReceiptPath, `${JSON.stringify(hostReceipt)}\n`, { flag: "wx", mode: 0o444 });
 await writeFile(`${root}/case.json`, `${JSON.stringify({ kind, cpuCount, memoryBytes, planKey, poolFallback, renew, sharedClaims, shapeMismatch, imageFingerprint: context.imageFingerprint,
  bootstrapSha256: context.bootstrapSha256, provenance, out: `${root}/results/evidence.json` })}\n`, { flag: "wx", mode: 0o444 });
 childStarted = true;
 const code = await new Promise((done, reject) => {
  const child = spawn("runuser", ["-u", account, "--", process.execPath, `${source}/scripts/acceptance/workload-usage-case.mjs`, `${root}/case.json`], { stdio: "inherit" });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 18 * 60000);
  child.once("error", reject); child.once("close", (status) => { clearTimeout(timeout); done(status); });
 });
 await cp(`${root}/results/evidence.json`, join(out, "evidence.json")); await chmod(join(out, "evidence.json"), 0o644);
 childEvidence = JSON.parse(await readFile(join(out, "evidence.json"), "utf8"));
 assert.equal(code, 0, "Physical workload accounting failed; inspect evidence.json");
 assert(childEvidence.passed && childEvidence.cleanup);
} finally {
 let hostCleanup = false;
 let guardCaptureDiagnostics;
 if (installed) {
  try {
   const current = run("systemctl", ["show", unit, "--property=InvocationID", "--value"]);
   const invocations = [...new Set([guardInvocation, current].filter(value => /^[0-9a-f]{32}$/.test(value ?? "")))];
   assert(invocations.length > 0, "Guard diagnostic invocation missing");
   const text = invocations.map(id => run("journalctl", ["--no-pager", "--output=cat", "--lines=2048", `_SYSTEMD_UNIT=${unit}`, `_SYSTEMD_INVOCATION_ID=${id}`])).join("\n");
   guardCaptureDiagnostics = { status: "collected", serviceInvocationScope: "initial-and-current", serviceRestartObserved: invocations.length > 1,
    ...collectWorkloadGuardDiagnostics(text) };
  } catch { guardCaptureDiagnostics = { status: "unavailable", code: "GUARD_DIAGNOSTIC_COLLECTION_FAILED" }; }
 }
 try {
  // An unconfirmed child may still have a physical VM. Preserve its independent
  // stop authority, durable journal and service account until that is resolved.
  // Before any child/guard existed, setup-only resources are safe to remove.
  if (childEvidence?.cleanup === true || (!childStarted && !installed)) {
   if (installed) {
    run("systemctl", ["stop", unit]);
    if (stateIdentity) {
     const current = await lstat(guardState);
     assert.equal(current.ino, stateIdentity.ino); assert.equal(current.dev, stateIdentity.dev); assert.equal(current.uid, uid);
     await rm(guardState, { recursive: true });
    }
    await unlink(`/etc/systemd/system/${unit}`); run("systemctl", ["daemon-reload"]);
   }
   if (createdUser) run("userdel", [account]);
   hostCleanup = true;
  }
 } finally {
  // A matrix may continue only after both child and parent cleanup succeeded.
  // Missing child evidence must never be mistaken for confirmed shutdown.
  if (childEvidence || installed || childStarted) {
   await writeFile(join(out, "evidence.json"), `${JSON.stringify({
    ...(childEvidence ?? { schema: "qorpera.physical-workload-usage/v1", commit: hostReceipt?.host.commit ?? process.env.GITHUB_SHA,
     kind, passed: false, cleanup: false, error: "Child cleanup evidence unavailable; independent guard custody retained" }),
    hostCleanup,
    ...(guardCaptureDiagnostics ? { guardCaptureDiagnostics } : {}),
   }, null, 2)}\n`, { mode: 0o644 });
  }
 }
}
