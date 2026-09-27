import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image || process.argv.length !== 2) throw new Error("Select an existing local QORPERA_OFFICE_TEST_IMAGE; no arguments");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-preparation-proof-"));
try {
	const probe = join(temporary, "probe.mjs");
	await build({ absWorkingDir: repository, entryPoints: ["packages/runtime/test/fixtures/company-computer-preparation-probe.ts"], outfile: probe,
		bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	for (const scenario of ["normal", "empty", "file-change", "missing", "extra", "symlink-file", "symlink-directory", "hardlink", "fifo", "wrong-mode", "foreign-owner", "wrong-boot", "wrong-mount", "unsafe-request", "request-symlink", "missing-invocation", "cancelled", "unmasked"]) {
		const volume = `qorpera-preparation-${randomUUID()}`;
		const container = `${volume}-probe`;
		try {
			const result = spawnSync("docker", ["run", "--name", container, "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "64",
				"--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP", "--cap-add", "DAC_READ_SEARCH",
				"--user", "0:0", "--mount", `type=volume,source=${volume},target=/var/lib/qorpera-office`,
				"--tmpfs", "/etc/qorpera-office:rw,nosuid,nodev,size=20m,mode=0755",
				// The probe writes the image's apt masks here (or leaves one out for "unmasked").
				"--tmpfs", "/etc/systemd/system:rw,nosuid,nodev,size=1m,mode=0755", "--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`,
				image, "node", "/probe.mjs", "--parent", scenario], { stdio: "inherit", timeout: 60000 });
			assert.equal(result.status, 0, `Preparation proof failed: ${scenario}`);
		} finally {
			spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10000 });
			spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore", timeout: 10000 });
		}
	}
} finally { await rm(temporary, { recursive: true, force: true }); }
