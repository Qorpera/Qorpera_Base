import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, chownSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** Runs as root in a disposable Linux container. Each packaged office control
 * (with the test fault prologue) sits at its guest path and runs exactly as the
 * provider submits it, through the real image checks, preparation lock and
 * flock child. LXD records what the invoked process writes. */
interface Control {
	readonly purpose: string;
	readonly failure: string;
	readonly file: string;
	readonly guestPath: string;
}
const controls = JSON.parse(readFileSync("/probe/controls.json", "utf8")) as Control[];
const lock = "/run/qorpera-office-preparation/control.lock",
	childFault = "/tmp/qorpera-test-child-fault",
	childRan = "/tmp/qorpera-test-child-ran";
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 0);
if (!existsSync("/usr/bin/node")) {
	copyFileSync(process.execPath, "/usr/bin/node");
	chmodSync("/usr/bin/node", 0o755);
}
chmodSync("/run/qorpera-office-preparation", 0o700);
writeFileSync(lock, "", { mode: 0o600 });
for (const control of controls) {
	// libuv's copyfile keeps the source owner: the bind-mounted probe's uid on Linux hosts.
	copyFileSync(control.file, control.guestPath);
	chownSync(control.guestPath, 0, 0);
	chmodSync(control.guestPath, control.guestPath.startsWith("/run/") ? 0o400 : 0o444);
}
const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const command = ["11111111-1111-4111-8111-111111111111", "a".repeat(64), bootId];

const timings: number[] = [];
function run(control: Control) {
	const started = performance.now();
	const tool = createHash("sha256").update(readFileSync(control.guestPath)).digest("hex");
	const args =
		control.purpose === "install"
			? [...command, tool, "b".repeat(64)]
			: control.purpose === "measure"
				? [...command, tool]
				: command;
	const result = spawnSync("/usr/bin/env", ["-i", "/usr/bin/node", control.guestPath, ...args], {
		cwd: "/",
		encoding: "utf8",
		timeout: 60000,
	});
	timings.push(Math.round(performance.now() - started));
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
async function holdLock() {
	const holder = spawn(
		"/usr/bin/flock",
		["--exclusive", "--no-fork", lock, "/usr/bin/node", "-e", "console.log('held');setTimeout(()=>{},60000)"],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	await once(holder.stdout, "data");
	return holder;
}

for (const control of controls) {
	const refusal = { status: 1, stdout: "", stderr: `${control.failure}\n` };
	for (const [fault, expected] of [
		["success", { status: 0, stdout: "", stderr: "" }],
		["refusal", refusal],
		["uncaught", refusal],
	] as const) {
		writeFileSync(childFault, fault);
		rmSync(childRan, { force: true });
		assert.deepEqual(run(control), expected, `${control.purpose}: locked child ${fault}`);
		assert.equal(readFileSync(childRan, "utf8"), fault, `${control.purpose}: locked child did not run`);
	}
	writeFileSync(childFault, "success");
	rmSync(childRan, { force: true });
	const holder = await holdLock();
	try {
		assert.deepEqual(run(control), refusal, `${control.purpose}: lock held`);
		assert.equal(existsSync(childRan), false, `${control.purpose}: child ran without the lock`);
	} finally {
		holder.kill("SIGKILL");
		await once(holder, "close");
	}
	rmSync(childFault, { force: true });
	assert.deepEqual(run(control), refusal, `${control.purpose}: real locked control without a staged request`);
	console.log(
		JSON.stringify({ purpose: control.purpose, recordedOutput: "exact", scenarios: 5, elapsedMs: timings.splice(0) }),
	);
}
console.log(JSON.stringify({ controls: controls.length, actualLinuxRoot: true, lockedChildOutputRecorded: false }));
