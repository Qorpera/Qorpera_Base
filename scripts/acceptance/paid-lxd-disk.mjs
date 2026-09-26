import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert(process.argv.length === 4 && process.argv[2] === "--out", "Usage: node scripts/acceptance/paid-lxd-disk.mjs --out <directory>");
assert(process.platform === "linux" && process.getuid() === 0, "Requires root on disposable Linux");
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Only disposable GitHub-hosted runners are permitted");
assert((await stat("/run/systemd/system")).isDirectory(), "Requires real systemd");
const out = resolve(process.argv[3]);
await mkdir(out, { recursive: true, mode: 0o755 });
const install = "/opt/qorpera-paid-lxd-disk-acceptance", user = "qorpera-coding-executor", unit = "qorpera-paid-computer-guard.service";
const vm = "qorpera-paid-disk-acceptance", journal = "/var/lib/qorpera-paid-computer-guard";
const evidence = { schema: "qorpera.paid-lxd-disk-acceptance/v1", commit: process.env.GITHUB_SHA ?? null, scope: "Production guard, actual isolated ext4 ENOSPC, systemd restart and LXD KVM VM; synthetic paid permits and terminal SQL acknowledgements. No funding, billing, guest workload or full provider acceptance.", passed: false, cleanup: false, checks: {} };
let installed = false, mounted = false, createdVm = false;
function run(command, args, timeout = 30000) {
	const result = spawnSync(command, args, { cwd: repository, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr || result.error || result.stdout).slice(0, 2000)}`);
	return result.stdout.trim();
}
function probe(action, scenario, timeout = 30000) {
	return JSON.parse(run("runuser", ["-u", user, "--", process.execPath, `${install}/probe.mjs`, action, scenario], timeout));
}
async function until(read, accept, timeout, label) {
	const end = Date.now() + timeout;
	let last;
	while (Date.now() < end) {
		try { const value = await read(); if (accept(value)) return value; } catch (error) { last = String(error); }
		await delay(500);
	}
	throw new Error(`Timed out: ${label}${last ? `; ${last}` : ""}`);
}
const vmState = () => JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}/state`])).status;
const uptime = async () => Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000;
const guardRecord = async (permitId) => JSON.parse(await readFile(`${journal}/${permitId}.json`, "utf8"));
async function started(scenario) {
	const value = probe("start", scenario);
	await until(() => probe("status", scenario), (record) => record.startSettled && record.startSucceeded === true, 30000, "physical start settlement");
	assert.equal(vmState(), "Running");
	return value.armed;
}
async function confirmed(scenario, armed) {
	const stopped = await until(() => probe("stop", scenario), (record) => record.phase === "stopped", 30000, "durable physical stopped receipt");
	assert(stopped.stopReceipt && stopped.stopReceipt.state === "stopped");
	assert.equal(stopped.stopAtUptimeMs, armed.stopAtUptimeMs);
	assert.equal(stopped.deadlineUptimeMs, armed.deadlineUptimeMs);
	assert.equal(stopped.stopReceipt.physicalInstanceId, armed.machine.physicalInstanceId);
	assert.equal(vmState(), "Stopped");
	return stopped.stopReceipt;
}
try {
	evidence.checks.kvm = JSON.parse(run("python3", ["scripts/acceptance/paid-lxd-kvm.py"]));
	assert.deepEqual(JSON.parse(run("lxc", ["list", "--all-projects", "--format=json"])), [], "Requires an empty disposable LXD host");
	assert.deepEqual(JSON.parse(run("lxc", ["storage", "list", "--format=json"])), [], "Requires uninitialized LXD");
	run("lxd", ["init", "--auto", "--storage-backend", "dir"], 120000);
	evidence.lxdVersion = run("lxc", ["version"]);
	run("lxc", ["init", "ubuntu:24.04", vm, "--vm", "--no-profiles", "--storage", "default", "-c", "limits.cpu=2", "-c", "limits.memory=1GiB", "-c", "boot.autostart=false"], 240000);
	createdVm = true;
	const instance = JSON.parse(run("lxc", ["query", `/1.0/instances/${vm}`]));
	assert.equal(instance.type, "virtual-machine");
	evidence.imageFingerprint = instance.config["volatile.base_image"];
	await mkdir(install, { mode: 0o755 });
	for (const [entry, name] of [["deploy/coding-worker/paid-computer-guard.ts", "guard"], ["scripts/acceptance/paid-lxd-disk-probe.ts", "probe"]])
		await build({ absWorkingDir: repository, entryPoints: [entry], outfile: `${install}/${name}.mjs`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
	evidence.guardBundleSha256 = createHash("sha256").update(await readFile(`${install}/guard.mjs`)).digest("hex");
	run("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user]);
	run("usermod", ["--append", "--groups", "lxd", user]);
	run("install", ["-d", "-m", "0700", "-o", user, "-g", user, "/var/lib/qorpera-paid-lxd-disk-acceptance"]);
	// Fill only a private loop-backed journal filesystem; the host root disk and
	// LXD storage retain space to enforce physical stops and publish evidence.
	await mkdir(journal, { mode: 0o700 });
	const filesystem = `${install}/journal.ext4`;
	run("truncate", ["-s", "256M", filesystem]);
	run("mkfs.ext4", ["-F", "-m", "0", filesystem]);
	run("mount", ["-o", "loop,nodev,nosuid,noexec", filesystem, journal]);
	mounted = true;
	run("chown", [`${user}:${user}`, journal]);
	await chmod(journal, 0o700);
	const sourceUnit = await readFile(join(repository, "deploy/coding-worker/qorpera-paid-computer-guard.service"), "utf8");
	const service = sourceUnit.replace("ExecStart=/usr/bin/node /opt/qorpera-coding-executor/qorpera-paid-computer-guard.mjs", `ExecStart=${process.execPath} ${install}/guard.mjs`);
	assert.notEqual(service, sourceUnit);
	await writeFile(`/etc/systemd/system/${unit}`, service, { mode: 0o644, flag: "wx" });
	installed = true;
	evidence.systemdUnitSha256 = createHash("sha256").update(service).digest("hex");
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["start", unit]);
	assert.equal(run("systemctl", ["is-active", unit]), "active");
	evidence.checks.supervisorActive = true;

	console.log("Testing physical deadline enforcement with an actually full journal filesystem.");
	const full = await started("full"), fullDisk = probe("fill", "full");
	assert.equal(fullDisk.errno, "ENOSPC");
	await until(vmState, (state) => state === "Stopped", 105000, "physical stop despite ENOSPC");
	const stoppedAt = await uptime();
	assert(stoppedAt <= full.deadlineUptimeMs, "Physical stop must precede the original paid deadline");
	const held = probe("status", "full");
	assert.equal(held.phase, "stopping");
	assert.equal(held.stopReceipt, null, "A failed durable write must not publish financial stopped evidence");
	probe("free", "full");
	await unlink(`${journal}/filler.bin`);
	evidence.checks.fullDiskExpiry = { ...fullDisk, originalDeadlineUptimeMs: full.deadlineUptimeMs, physicalStoppedAtUptimeMs: stoppedAt, noFalseReceipt: true, stopReceipt: await confirmed("full", full) };

	console.log("Testing genuine archive-tail publication followed by ENOSPC anchor failure and systemd restart.");
	probe("padding", "tail");
	const tail = await started("tail");
	await mkdir(`${journal}/archive`, { mode: 0o700 });
	run("chown", [`${user}:${user}`, `${journal}/archive`]);
	const before = JSON.parse(await readFile(`${journal}/prestarts.json`, "utf8"));
	assert((await stat(`${journal}/prestarts.json`)).size > 65536);
	const tailDisk = probe("fill", "tail"), failed = probe("tail-archive", "tail");
	const after = JSON.parse(await readFile(`${journal}/prestarts.json`, "utf8"));
	assert.equal(after.archiveCount, before.archiveCount);
	const retained = (await readdir(`${journal}/archive`)).filter((name) => /^[0-9]{16}\.json$/.test(name));
	assert.equal(retained.length, before.archiveCount + 1, "An exact immutable archive tail must have committed before the anchor failed");
	const previousPid = run("systemctl", ["show", unit, "--property=MainPID", "--value"]);
	run("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", unit]);
	await until(() => run("systemctl", ["show", unit, "--property=MainPID", "--value"]), (pid) => pid !== "0" && pid !== previousPid, 20000, "systemd restart with unrepaired archive");
	await until(vmState, (state) => state === "Stopped", 20000, "startup stop-only custody despite ENOSPC archive repair");
	const startupStoppedAt = await uptime();
	assert(startupStoppedAt <= tail.deadlineUptimeMs);
	const unchanged = await guardRecord(tail.permit.permitId);
	assert.equal(unchanged.stopReceipt, null);
	assert.equal(unchanged.deadlineUptimeMs, tail.deadlineUptimeMs);
	assert.throws(() => probe("status", "tail"), "No admission socket may be ready before full archive recovery");
	probe("free", "tail");
	await unlink(`${journal}/filler.bin`);
	run("systemctl", ["reset-failed", unit]);
	run("systemctl", ["start", unit]);
	evidence.checks.interruptedArchiveRestart = { ...tailDisk, archivedPermitId: failed.permitId, originalDeadlineUptimeMs: tail.deadlineUptimeMs, physicalStoppedAtUptimeMs: startupStoppedAt, noFalseReceipt: true, admissionHeld: true, stopReceipt: await confirmed("tail", tail) };

	console.log("Creating more than the active-record limit of real immutable archive entries and measuring restart.");
	const history = probe("history", "history", 600000);
	const historyCount = (await readdir(`${journal}/archive`)).filter((name) => /^[0-9]{16}\.json$/.test(name)).length;
	assert.equal(historyCount, history.count);
	const active = await started("history");
	await delay(Math.max(0, active.stopAtUptimeMs - await uptime() - 250));
	const oldPid = run("systemctl", ["show", unit, "--property=MainPID", "--value"]), restartStarted = Date.now();
	run("systemctl", ["kill", "--kill-whom=main", "--signal=SIGKILL", unit]);
	const newPid = await until(() => run("systemctl", ["show", unit, "--property=MainPID", "--value"]), (pid) => pid !== "0" && pid !== oldPid, 20000, "history restart");
	await until(vmState, (state) => state === "Stopped", 25000, "expiry during retained-history restart");
	const historyStoppedAt = await uptime();
	assert(historyStoppedAt <= active.deadlineUptimeMs);
	await until(() => probe("status", "history"), (record) => record.permit.permitId === active.permit.permitId, 120000, "complete archive validation and readiness");
	evidence.checks.retainedHistoryRestart = { ...history, historyCount, firstPid: oldPid, secondPid: newPid, recoveryElapsedMs: Date.now() - restartStarted, originalDeadlineUptimeMs: active.deadlineUptimeMs, physicalStoppedAtUptimeMs: historyStoppedAt, stopReceipt: await confirmed("history", active) };
	run("systemctl", ["stop", unit]);
	assert.equal(run("systemctl", ["show", unit, "--property=ActiveState", "--value"]), "inactive");
	evidence.checks.supervisorInactive = true;
	evidence.notTested = ["SQL funding and settlement", "indefinite physical LXD transport failure", "unbounded retained-history sizes", "full provider and guest lifecycle"];
	evidence.passed = true;
} catch (error) {
	evidence.error = String(error); process.exitCode = 1;
} finally {
	if (installed) {
		try { await writeFile(join(out, "guard.log"), run("journalctl", ["-u", unit, "--no-pager", "--output=short-monotonic"]), { mode: 0o644 }); } catch { /* JSON preserves the failure. */ }
		try {
			run("systemctl", ["stop", unit]);
			assert.equal(run("systemctl", ["show", unit, "--property=ActiveState", "--value"]), "inactive");
		} catch { evidence.cleanupFailed = true; evidence.passed = false; process.exitCode = 1; }
	}
	if (createdVm) { try { run("lxc", ["delete", vm, "--force"], 60000); } catch { evidence.cleanupFailed = true; evidence.passed = false; process.exitCode = 1; } }
	if (mounted) { try { run("umount", [journal]); } catch { evidence.cleanupFailed = true; evidence.passed = false; process.exitCode = 1; } }
	evidence.cleanup = evidence.cleanupFailed !== true;
	evidence.cleanupScope = "Test VM deleted, guard service confirmed inactive, isolated journal filesystem unmounted. Dedicated account, installed test binaries/unit and detached filesystem image are retained only until disposable GitHub runner destruction.";
	await writeFile(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
	await chmod(out, 0o755);
	console.log(JSON.stringify(evidence));
}
