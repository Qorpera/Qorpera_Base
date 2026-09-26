import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert(process.argv.length === 4 && process.argv[2] === "--out", "Usage: node scripts/acceptance/paid-lxd-guard.mjs --out <directory>");
assert(process.platform === "linux" && process.getuid() === 0, "Requires root on disposable Linux");
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Only disposable GitHub-hosted runners are permitted");
assert((await stat("/run/systemd/system")).isDirectory(), "Requires real systemd");
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true, mode: 0o755 });
const install = "/opt/qorpera-paid-lxd-acceptance";
const unit = "qorpera-paid-computer-guard.service";
const user = "qorpera-coding-executor";
const vm = "qorpera-paid-acceptance";
const evidence = { schema: "qorpera.paid-lxd-physical-acceptance/v1", commit: process.env.GITHUB_SHA ?? null, scope: "Production guard, real Linux clock, systemd, LXD and KVM VM with synthetic permit. No SQL, billing, Stripe, full provider, or office-image acceptance.", passed: false, checks: {} };
let installed = false;
let createdVm = false;
function run(command, args, timeout = 30000) {
	const result = spawnSync(command, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr || result.error || result.stdout).slice(0, 2000)}`);
	return result.stdout.trim();
}
function probe(action) {
	return JSON.parse(run("runuser", ["-u", user, "--", process.execPath, join(install, "probe.mjs"), action]));
}
async function until(read, accept, timeoutMs, label) {
	const end = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < end) {
		try { const value = read(); if (accept(value)) return value; } catch (error) { lastError = String(error); }
		await delay(1000);
	}
	throw new Error(`Timed out: ${label}${lastError ? `; last observation: ${lastError}` : ""}`);
}
try {
	evidence.checks.kvm = JSON.parse(run("python3", ["scripts/acceptance/paid-lxd-kvm.py"]));
	evidence.hostVirtualization = run("systemctl", ["show", "--property=Virtualization", "--value"]);
	// Refuse existing workloads: even a new project can disturb enrolled-host inventory.
	assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), [], "LXD must have no instances");
	assert.deepEqual(JSON.parse(run("lxc", ["storage", "list", "--format=json"])), [], "LXD must be uninitialized");
	run("lxd", ["init", "--auto", "--storage-backend", "dir"], 120000);
	evidence.lxdVersion = run("lxc", ["version"]);
	run("lxc", ["init", "ubuntu:24.04", vm, "--vm", "--no-profiles", "--storage", "default", "-c", "limits.cpu=2", "-c", "limits.memory=1GiB"], 240000);
	createdVm = true;
	const instance = JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}`]));
	assert.equal(instance.type, "virtual-machine");
	evidence.imageFingerprint = instance.config["volatile.base_image"] ?? null;
	await mkdir(install, { mode: 0o755 });
	for (const [entry, name] of [["deploy/coding-worker/paid-computer-guard.ts", "guard"], ["scripts/acceptance/paid-lxd-probe.ts", "probe"]]) {
		await build({ absWorkingDir: repository, entryPoints: [entry], outfile: join(install, `${name}.mjs`), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
	}
	evidence.guardBundleSha256 = createHash("sha256").update(await readFile(join(install, "guard.mjs"))).digest("hex");
	run("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user]);
	run("usermod", ["--append", "--groups", "lxd", user]);
	run("install", ["-d", "-m", "0700", "-o", user, "-g", user, "/var/lib/qorpera-paid-lxd-acceptance"]);
	const sourceUnit = await readFile(join(repository, "deploy/coding-worker/qorpera-paid-computer-guard.service"), "utf8");
	const service = sourceUnit.replace("ExecStart=/usr/bin/node /opt/qorpera-coding-executor/qorpera-paid-computer-guard.mjs", `ExecStart=${process.execPath} ${install}/guard.mjs`);
	assert.notEqual(service, sourceUnit, "Production unit ExecStart must be substituted explicitly");
	evidence.systemdUnitSha256 = createHash("sha256").update(service).digest("hex");
	await writeFile(`/etc/systemd/system/${unit}`, service, { mode: 0o644, flag: "wx" });
	installed = true;
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["start", unit]);
	const { armed, start } = probe("start");
	evidence.startOperationId = start.operationId;
	evidence.deadlineUptimeMs = armed.deadlineUptimeMs;
	evidence.stopAtUptimeMs = armed.stopAtUptimeMs;
	await until(() => probe("status"), (record) => record.startSettled && record.startSucceeded === true, 45000, "real start operation settlement");
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}/state`])).status, "Running");
	evidence.checks.vmRunning = true;
	// The short-lived IPC client exited. No provider or renewal process exists.
	evidence.checks.providerAbsent = true;
	const firstPid = run("systemctl", ["show", unit, "--property=MainPID", "--value"]);
	run("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", unit]);
	const secondPid = await until(() => run("systemctl", ["show", unit, "--property=MainPID", "--value"]), (pid) => pid !== "0" && pid !== firstPid, 25000, "systemd automatic restart");
	const recovered = await until(() => probe("status"), (record) => record.permit.permitId === armed.permit.permitId, 20000, "guard journal recovery");
	assert.equal(recovered.deadlineUptimeMs, armed.deadlineUptimeMs);
	assert.equal(recovered.stopAtUptimeMs, armed.stopAtUptimeMs);
	const rearmed = probe("rearm");
	assert.equal(rearmed.deadlineUptimeMs, armed.deadlineUptimeMs);
	evidence.checks.sigkillRestart = { firstPid, secondPid, deadlinePreserved: true, replayCannotExtend: true };
	const stopped = await until(() => probe("status"), (record) => record.phase === "stopped", 190000, "independent expiry physical stop");
	assert(stopped.stopReceipt && stopped.stopReceipt.state === "stopped");
	assert(stopped.stopReceipt.closedAtUptimeMs <= armed.deadlineUptimeMs, "Confirmed stop must precede paid deadline");
	assert.equal(stopped.stopReceipt.physicalInstanceId, armed.machine.physicalInstanceId);
	assert.equal(JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}/state`])).status, "Stopped");
	evidence.checks.expiryStop = { physicalStopped: true, stopReceipt: stopped.stopReceipt, deadlineMarginMs: armed.deadlineUptimeMs - stopped.stopReceipt.closedAtUptimeMs };
	evidence.notTested = ["stalled LXD socket", "SQL funding and settlement", "full office outage recovery", "guest service activation"];
	evidence.passed = true;
} catch (error) {
	evidence.error = String(error);
	process.exitCode = 1;
} finally {
	if (installed) {
		try { await writeFile(join(out, "guard.log"), run("journalctl", ["-u", unit, "--no-pager", "--output=short-monotonic"]), { mode: 0o644 }); } catch { /* Evidence JSON still records failure. */ }
		try { run("systemctl", ["stop", unit]); } catch { /* Runner destruction is the final cleanup boundary. */ }
	}
	if (createdVm) { try { run("lxc", ["delete", vm, "--force"], 60000); } catch { evidence.cleanupFailed = true; evidence.passed = false; process.exitCode = 1; } }
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	await chmod(out, 0o755);
	console.log(JSON.stringify(evidence));
}
