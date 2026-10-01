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
	throw new Error("Select a prepared, digest-pinned local office/systemd image with QORPERA_OFFICE_SYSTEMD_TEST_IMAGE");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-image-systemd-"));
const command = (file, args) => {
	const result = spawnSync(file, args, { cwd: repository, encoding: "utf8", timeout: 60000 });
	assert.equal(result.status, 0, `${file}: ${result.stderr}`); return result.stdout.trim();
};
let container;
try {
	const packaged = join(temporary, "package");
	command(process.execPath, ["scripts/package-company-computer.mjs", "--out", packaged]);
	const consumer = join(temporary, "consumer.mjs");
	await build({absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-image-systemd-consumer.ts"], outfile: consumer, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent"});
	const args = ["run", "-d", "--name", basename(temporary), "--pull", "never", "--network", "none", "--cgroupns", "private", "--cap-drop", "ALL"];
	// Root fixture privileges only; installed guest service units are unchanged.
	for (const cap of ["SYS_ADMIN", "SYS_PTRACE", "SYS_RESOURCE", "SYS_CHROOT", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "AUDIT_WRITE"])
		args.push("--cap-add", cap);
	args.push(...SYSTEMD_CONTAINER_SECURITY, "--cpus", "2", "--memory", "1g", "--pids-limit", "2048",
		"--tmpfs", "/run:rw,nosuid,nodev,size=192m,mode=755", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777", "--tmpfs", "/var/log/journal:rw,nosuid,nodev,size=16m,mode=755", "--tmpfs", "/etc/systemd/system:rw,nosuid,nodev,size=16m,mode=755", "--env", "container=docker");
	for (const [source, target] of [[packaged, "/fixture/package"], [consumer, "/fixture/consumer.mjs"], [join(repository, "scripts/fixtures/office-image-installation-systemd.mjs"), "/fixture/check.mjs"], [join(repository, "scripts/fixtures/office-boot-credentials-systemd.mjs"), "/fixture/boot-credentials.mjs"]])
		args.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
	args.push(image, "/bin/bash", "-c", systemdContainerBoot());
	container = command("docker", args);
	let ready = false;
	for (let i = 0; i < 40; i++) {
		const state = spawnSync("docker", ["exec", container, "systemctl", "is-system-running"], { encoding: "utf8", timeout: 10000 }).stdout?.trim();
		if (["running", "degraded"].includes(state)) { ready = true; break; }
		await delay(500);
	}
	assert(ready, "Disposable systemd manager did not start");
	await new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", container, "node", "/fixture/check.mjs"], { stdio: "inherit", timeout: 600000 });
		child.once("error", reject);
		child.once("exit", code => code === 0 ? resolve() : reject(new Error("Disposable office image installation proof failed")));
	});
	console.log(JSON.stringify({ image, network: "none", privateCgroupNamespace: true, hostCgroupBind: false }));
} finally {
	try { if (container) command("docker", ["rm", "-f", container]); }
	finally { await rm(temporary, { recursive: true, force: true }); }
}
