import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image || process.argv.length !== 2) throw new Error("Select an existing local QORPERA_OFFICE_TEST_IMAGE; no arguments");
const temporary = await mkdtemp(join(tmpdir(), "qorpera-software-files-"));
try {
	const probe = join(temporary, "probe.mjs");
	await build({absWorkingDir: root, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-service-software-files.ts"], outfile: probe, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent"});
	const result = spawnSync("docker", ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "32", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--user", "0:0",
		"--tmpfs", "/opt/qorpera-office:rw,nosuid,nodev,size=16m,mode=0755", "--tmpfs", "/var/lib/qorpera-office-service-software:rw,nosuid,nodev,size=16m,mode=0700", "--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, image, "node", "/probe.mjs"], {stdio: "inherit", timeout: 60000});
	assert.equal(result.status, 0, "Office service software filesystem proof failed");
} finally { await rm(temporary, {recursive: true, force: true}); }
