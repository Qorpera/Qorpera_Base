import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image || process.argv.length !== 2) throw new Error("Select an existing local QORPERA_OFFICE_TEST_IMAGE; no arguments");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-configuration-control-"));
try {
	const probe = join(temporary, "probe.mjs"), cert = join(temporary, "cert"), key = join(temporary, "key");
	assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { timeout: 15000, encoding: "utf8" }).status, 0);
	await build({ absWorkingDir: repository, entryPoints: ["packages/runtime/test/fixtures/company-computer-configuration-control-probe.ts"], outfile: probe, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	const result = spawnSync("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "64",
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--user", "0:0",
		"--tmpfs", "/etc/qorpera-office:rw,nosuid,nodev,size=20m,mode=0755", "--tmpfs", "/run/qorpera-office-preparation:rw,nosuid,nodev,size=48m,mode=0700",
		"--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, "--mount", `type=bind,src=${cert},dst=/fixture-cert,readonly`, "--mount", `type=bind,src=${key},dst=/fixture-key,readonly`,
		image, "node", "/probe.mjs", "--parent"], { stdio: "inherit", timeout: 120000 });
	assert.equal(result.status, 0, "Protected office configuration proof failed");
} finally { await rm(temporary, { recursive: true, force: true }); }
