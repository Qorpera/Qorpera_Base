import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { SYSTEMD_CONTAINER_SECURITY, systemdContainerBoot } from "./fixtures/systemd-container.mjs";

const repository = resolve(import.meta.dirname, "..");
const image = process.env.QORPERA_OFFICE_SYSTEMD_TEST_IMAGE;
if (process.argv.length !== 2 || !image || !/^(?:[^\s]+@)?sha256:[0-9a-f]{64}$/.test(image))
	throw new Error("Select a prepared, digest-pinned local systemd/Node 22 image with QORPERA_OFFICE_SYSTEMD_TEST_IMAGE");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-install-systemd-"));
let container;
const command = (file, args, timeout = 60000) => {
	const result = spawnSync(file, args, { cwd: repository, encoding: "utf8", timeout });
	assert.equal(result.status, 0, `${file}: ${result.stderr}`);
	return result.stdout.trim();
};
try {
	const packaged = join(temporary, "package"), fixture = join(temporary, "physical.cjs");
	command(process.execPath, ["scripts/package-lxd-office-provider.mjs", "--out", packaged]);
	await build({ absWorkingDir: repository, stdin: {
		contents: 'export { officePhysicalFixture } from "./packages/runner-orchestrator/test/fixtures/office-physical-policy.ts"; export { lxdOfficePhysicalPolicySha256 } from "./packages/runner-orchestrator/src/lxd-office-physical-policy.ts";',
		resolveDir: repository,
	}, outfile: fixture, bundle: true, platform: "node", format: "cjs", target: "node22.19", logLevel: "silent" });
	command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"]);
	const args = ["run", "-d", "--name", basename(temporary), "--pull", "never", "--network", "none", "--cgroupns", "private", "--cap-drop", "ALL"];
	// These capabilities belong to the disposable root fixture. The installed
	// provider unit is exercised unchanged and retains empty capability sets.
	for (const cap of ["SYS_ADMIN", "SYS_PTRACE", "SYS_RESOURCE", "SYS_CHROOT", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "AUDIT_WRITE", "MKNOD"])
		args.push("--cap-add", cap);
	args.push("--device-cgroup-rule", "c 10:237 rwm", "--device-cgroup-rule", "b 7:* rwm", ...SYSTEMD_CONTAINER_SECURITY, "--cpus", "2", "--memory", "768m", "--pids-limit", "1024",
		"--tmpfs", "/run:rw,nosuid,nodev,size=128m,mode=755", "--tmpfs", "/tmp:rw,nosuid,nodev,size=192m,mode=1777", "--tmpfs", "/var/log/journal:rw,nosuid,nodev,size=16m,mode=755", "--tmpfs", "/etc/systemd/system:rw,nosuid,nodev,size=16m,mode=755", "--env", "container=docker");
	for (const [source, target] of [[packaged, "/fixture/package"], [fixture, "/fixture/physical.cjs"], [join(repository, "scripts/fixtures/office-installation-systemd.mjs"), "/fixture/check.mjs"], [temporary, "/fixture/tls"]])
		args.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
	// Only the container's own cgroup namespace is remounted. No host cgroup or
	// block-device bind is passed; the probe mounts its own autoclearing loop file.
	// The agent exit's installer makes the plug group on a node; the provider unit fails to start without it.
	args.push(image, "/bin/bash", "-c", systemdContainerBoot("groupadd --gid 1101 office-lxd-test && groupadd --gid 1102 qorpera-agent-plug"));
	container = command("docker", args);
	let ready = false;
	for (let i = 0; i < 40; i++) {
		const state = spawnSync("docker", ["exec", container, "systemctl", "is-system-running"], { encoding: "utf8", timeout: 10000 }).stdout?.trim();
		if (["running", "degraded"].includes(state)) { ready = true; break; }
		await delay(500);
	}
	assert(ready, "Disposable systemd manager did not start");
	await new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", container, "node", "/fixture/check.mjs"], { stdio: "inherit", timeout: 300000 });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Disposable office installation proof failed")));
	});
	console.log(JSON.stringify({ image, network: "none", privateCgroupNamespace: true, hostCgroupBind: false }));
} finally {
	try { if (container) command("docker", ["rm", "-f", container]); }
	finally { await rm(temporary, { recursive: true, force: true }); }
}
