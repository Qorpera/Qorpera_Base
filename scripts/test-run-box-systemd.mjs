/** The run box under real systemd (F3 step 2b; deploy/first-node/RUNTIME-FOLDER-SERVICE.md, "Step 2b"): the shared
 * execution package from this commit, installed by its own installer in a disposable systemd container, then one box
 * started, probed from the slot's native host account and stopped, as the shared execution service does for a run.
 * The box's folder is this repository's folder service (core in memory) mounted by the real folder program, which is
 * built here in the pinned Rust image unless QORPERA_FOLDER_MOUNT_BIN names a build. Needs Docker with /dev/fuse:
 *
 *   QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=sha256:<id> QORPERA_RUN_BOX_REQUIRE_TOOLBOX=1 node scripts/test-run-box-systemd.mjs
 *
 * with the image from scripts/fixtures/run-box-toolbox-image.Dockerfile, so the box's tools run in the real unit too
 * (deploy/test-machine/README.md, "The systemd suites"). */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { SYSTEMD_CONTAINER_SECURITY, systemdContainerBoot } from "./fixtures/systemd-container.mjs";

const repository = resolve(import.meta.dirname, "..");
const image = process.env.QORPERA_OFFICE_SYSTEMD_TEST_IMAGE;
if (process.argv.length !== 2 || !image || !/^(?:[^\s]+@)?sha256:[0-9a-f]{64}$/.test(image))
	throw new Error(
		"Usage: QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=<digest-pinned local image> [QORPERA_FOLDER_MOUNT_BIN=<built program>] [QORPERA_RUN_BOX_REQUIRE_TOOLBOX=1] node scripts/test-run-box-systemd.mjs",
	);
const temporary = await mkdtemp(join(tmpdir(), "run-box-systemd-"));
const command = (file, args, timeout = 600_000) => {
	const result = spawnSync(file, args, { cwd: repository, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "inherit"] });
	assert.equal(result.status, 0, `${file} ${args.join(" ")}`);
	return result.stdout.trim();
};
let container;
try {
	const program = join(temporary, "qorpera-folder");
	if (process.env.QORPERA_FOLDER_MOUNT_BIN) await copyFile(process.env.QORPERA_FOLDER_MOUNT_BIN, program);
	else command(process.execPath, ["scripts/build-folder-program.mjs", "--out", program]);
	const packaged = join(temporary, "package");
	command(process.execPath, ["scripts/package-shared-execution-service.mjs", "--out", packaged, "--folder-program", program]);
	for (const [entry, out] of [
		["scripts/fixtures/run-box-folder-peer.ts", "peer.mjs"],
		// The native host's run box tools (F3 step 2b-3), against the real box.
		["scripts/fixtures/run-box-tools-e2e.ts", "tools.mjs"],
	])
		await build({
			entryPoints: [join(repository, entry)],
			outfile: join(temporary, out),
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			logLevel: "silent",
			banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		});
	const args = ["run", "-d", "--name", basename(temporary), "--pull", "never", "--network", "none", "--cgroupns", "private"];
	// Container-only capabilities for its private systemd manager and the folder mount. The box unit itself keeps an
	// empty capability set (the proof checks it from inside the box).
	args.push("--cap-drop", "ALL", "--device", "/dev/fuse");
	for (const cap of ["SYS_ADMIN", "SYS_PTRACE", "SYS_RESOURCE", "SYS_CHROOT", "NET_ADMIN", "MKNOD", "CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "AUDIT_WRITE"])
		args.push("--cap-add", cap);
	args.push(
		...SYSTEMD_CONTAINER_SECURITY,
		"--cpus",
		"2",
		"--memory",
		"3g",
		"--pids-limit",
		"2048",
		"--tmpfs",
		"/run:rw,nosuid,nodev,size=128m,mode=755",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,size=256m,mode=1777",
		"--tmpfs",
		"/var/log/journal:rw,nosuid,nodev,size=16m,mode=755",
		"--env",
		"container=docker",
	);
	for (const [source, target] of [
		[packaged, "/fixture/package"],
		[join(temporary, "peer.mjs"), "/fixture/peer.mjs"],
		[join(temporary, "tools.mjs"), "/fixture/tools.mjs"],
		[join(repository, "scripts/fixtures/run-box-systemd.mjs"), "/fixture/check.mjs"],
	])
		args.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
	args.push(image, "/bin/bash", "-c", systemdContainerBoot());
	container = command("docker", args, 60_000);
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		const state = spawnSync("docker", ["exec", container, "systemctl", "is-system-running"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();
		if (state === "running" || state === "degraded") {
			ready = true;
			break;
		}
		await delay(500);
	}
	assert(ready, `Private systemd did not start: ${spawnSync("docker", ["logs", container], { encoding: "utf8" }).stdout}`);
	await new Promise((done, fail) => {
		const environment = process.env.QORPERA_RUN_BOX_REQUIRE_TOOLBOX === "1" ? ["-e", "QORPERA_RUN_BOX_REQUIRE_TOOLBOX=1"] : [];
		const child = spawn("docker", ["exec", ...environment, container, "node", "/fixture/check.mjs"], {
			stdio: "inherit",
			timeout: 300_000,
		});
		child.once("error", fail);
		child.once("exit", (code) => (code === 0 ? done() : fail(new Error("The run box systemd proof failed"))));
	});
	console.log(JSON.stringify({ image, network: "none", privateCgroupNamespace: true, fuse: true }));
} finally {
	try {
		if (container) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 60_000 });
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
