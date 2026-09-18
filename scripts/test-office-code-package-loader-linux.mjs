import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), ".."), tag = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!tag || process.argv.length !== 2) throw new Error("Select an existing QORPERA_OFFICE_TEST_IMAGE; no arguments");
const inspect = spawnSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 10000 });
assert.equal(inspect.status, 0);
const image = inspect.stdout.trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
const temporary = await mkdtemp(join(tmpdir(), "qorpera-code-loader-")), container = `qorpera-code-loader-${randomUUID()}`;
try {
	const probe = join(temporary, "probe.mjs");
	await build({ absWorkingDir: repository, entryPoints: ["packages/runner-orchestrator/test/fixtures/office-code-package-loader-probe.ts"], outfile: probe, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	console.log(JSON.stringify({ image, network: "none", readOnlyRoot: true, deployed: false }));
	const result = spawnSync("docker", ["run", "--name", container, "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--pids-limit", "64", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--user", "0:0", "--tmpfs", "/run/qorpera-office-preparation:rw,nosuid,nodev,size=20m,mode=0700", "--tmpfs", "/tmp:rw,nosuid,nodev,size=20m,mode=1777", "--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, image, "node", "/probe.mjs"], { stdio: "inherit", timeout: 60000 });
	assert.equal(result.status, 0, "Root loader Linux proof failed");
} finally {
	spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10000 });
	await rm(temporary, { recursive: true, force: true });
}
