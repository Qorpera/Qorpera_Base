import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

test("packages and pins the management VM Runner Orchestrator", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-runner-orchestrator-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-runner-orchestrator.mjs", "--out", outputRoot],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(packaged.status, 0, packaged.stderr);

		const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf-8"));
		const artifact = await readFile(join(outputRoot, "qorpera-runner-orchestrator.mjs"));
		assert.equal(manifest.schema, "qorpera.runner-orchestrator-package/v1");
		assert.deepEqual(manifest.runtime, { node: ">=22.19.0" });
		assert.deepEqual(manifest.artifacts, [
			{
				file: "qorpera-runner-orchestrator.mjs",
				bytes: artifact.byteLength,
				sha256: sha256(artifact),
			},
		]);

		const installerPath = join(repositoryRoot, "deploy/first-node/install-runner-orchestrator-guest.sh");
		const installer = await readFile(installerPath, "utf-8");
		const unit = await readFile(join(repositoryRoot, "deploy/first-node/qorpera-runner-orchestrator.service"));
		const environmentExample = await readFile(
			join(repositoryRoot, "deploy/first-node/runner-orchestrator.env.example"),
		);
		const provisionerPath = join(repositoryRoot, "deploy/first-node/provision-runner-orchestrator-vm.sh");
		const provisioner = await readFile(provisionerPath, "utf-8");
		const updaterPath = join(repositoryRoot, "deploy/first-node/update-runner-orchestrator-guest.sh");
		const updater = await readFile(updaterPath, "utf-8");
		for (const expected of [
			`EXPECTED_ARTIFACT_SHA256="${sha256(artifact)}"`,
			`EXPECTED_UNIT_SHA256="${sha256(unit)}"`,
			`EXPECTED_ENV_EXAMPLE_SHA256="${sha256(environmentExample)}"`,
		]) {
			assert.ok(installer.includes(expected), `installer is missing checksum pin ${expected}`);
		}
		assert.ok(installer.includes("configuration=present-preserved"));
		assert.ok(installer.includes("Refusing an unsafe existing Runner Orchestrator configuration."));
		assert.ok(installer.includes("Refusing an incorrectly owned or readable Runner Orchestrator configuration."));
		assert.ok(installer.includes("root:root:600"));
		assert.ok(!installer.includes("Refusing to replace an already configured Runner Orchestrator."));
		for (const expected of [
			`EXPECTED_ARTIFACT_SHA256="${sha256(artifact)}"`,
			`EXPECTED_INSTALLER_SHA256="${sha256(Buffer.from(installer))}"`,
			`EXPECTED_UNIT_SHA256="${sha256(unit)}"`,
			`EXPECTED_ENV_EXAMPLE_SHA256="${sha256(environmentExample)}"`,
		]) {
			assert.ok(provisioner.includes(expected), `provisioner is missing checksum pin ${expected}`);
		}
		for (const expected of [
			`EXPECTED_ARTIFACT_SHA256="${sha256(artifact)}"`,
			`EXPECTED_INSTALLER_SHA256="${sha256(Buffer.from(installer))}"`,
			`EXPECTED_UNIT_SHA256="${sha256(unit)}"`,
			`EXPECTED_ENV_EXAMPLE_SHA256="${sha256(environmentExample)}"`,
		]) {
			assert.ok(updater.includes(expected), `updater is missing checksum pin ${expected}`);
		}
		assert.ok(updater.includes("configuration_before="));
		assert.ok(updater.includes("configuration_after="));
		assert.ok(updater.includes('echo "configuration=present-preserved"'));
		assert.ok(updater.includes('echo "service=disabled-inactive"'));
		assert.ok(provisioner.includes("cloud_init_ready_without_devlxd"));
		assert.ok(provisioner.includes('status.get("extended_status") != "degraded done"'));
		assert.ok(provisioner.includes('allowed_warnings = {"/dev/lxd/sock does not exist.", "Used fallback datasource"}'));
		assert.ok(!provisioner.includes("cloud-init status --wait >/dev/null"));
		for (const expected of [
			"ConditionPathExists=/etc/qorpera/runner-orchestrator.env",
			"User=qorpera-orchestrator",
			"ProtectSystem=strict",
			"ReadWritePaths=/var/lib/qorpera-orchestrator",
		]) {
			assert.ok(unit.includes(expected), `systemd unit is missing ${expected}`);
		}
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", installerPath, provisionerPath, updaterPath], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
