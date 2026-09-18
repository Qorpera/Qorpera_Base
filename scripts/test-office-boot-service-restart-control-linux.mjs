import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), ".."), image = process.env.QORPERA_OFFICE_TEST_IMAGE;
if (!image || process.argv.length !== 2) throw new Error("Select an existing local QORPERA_OFFICE_TEST_IMAGE; no arguments");
if (process.env.QORPERA_OFFICE_TEST_RESET !== undefined && process.env.QORPERA_OFFICE_TEST_RESET !== "1") throw new Error("QORPERA_OFFICE_TEST_RESET must be 1 when selecting reset proof");
const family = process.env.QORPERA_OFFICE_TEST_RESET === "1" ? "reset" : "boot";
const identity = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 10000 });
assert.equal(identity.status, 0, "Proof image must already exist locally");
const imageId = identity.stdout.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
console.log(JSON.stringify({ family, imageId, network: "none", readOnlyRoot: true, syntheticSystemdSqlAndPriorBoot: true, deployed: false }));
const temporary = await mkdtemp(join(tmpdir(), "qorpera-boot-service-restart-")), volume = `qorpera-boot-service-restart-${randomUUID()}`, container = `${volume}-probe`;
try {
	const probe = join(temporary, "probe.mjs"), cert = join(temporary, "cert"), key = join(temporary, "key");
	assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { timeout: 15000, encoding: "utf8" }).status, 0);
	await build({ absWorkingDir: repository, entryPoints: [`packages/runtime/test/fixtures/company-computer-${family}-service-restart-probe.ts`], outfile: probe, bundle: true, platform: "node", format: "esm", target: "node22.19", logLevel: "silent" });
	const result = spawnSync("docker", ["run", "--name", container, "--rm", "--pull", "never", "--network", "none", "--read-only", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "64",
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP", "--user", "0:0",
		"--mount", `type=volume,source=${volume},target=/var/lib/qorpera-office`, "--tmpfs", "/etc/qorpera-office:rw,nosuid,nodev,size=20m,mode=0755", "--tmpfs", "/run/qorpera-office-preparation:rw,nosuid,nodev,size=48m,mode=0700",
		"--tmpfs", "/run/qorpera-office/private:rw,nosuid,nodev,size=8m,mode=0700,uid=1000,gid=1000",
		"--mount", `type=bind,src=${probe},dst=/probe.mjs,readonly`, "--mount", `type=bind,src=${cert},dst=/fixture-cert,readonly`, "--mount", `type=bind,src=${key},dst=/fixture-key,readonly`,
		imageId, "node", "/probe.mjs", "--parent"], { stdio: "inherit", timeout: 600000 });
	assert.equal(result.status, 0, `Protected retained ${family} service restart proof failed`);
} finally {
	spawnSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10000 });
	spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore", timeout: 10000 });
	await rm(temporary, { recursive: true, force: true });
}
