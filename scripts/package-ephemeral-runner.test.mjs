import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runtimeBundlePackagingEnvironment } from "./runtime-bundle-release-train.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages directly executable ephemeral runner bundles", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-ephemeral-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-ephemeral-runner.mjs", "--out", outputRoot],
			{ cwd: repositoryRoot, encoding: "utf-8", env: runtimeBundlePackagingEnvironment() },
		);
		assert.equal(packaged.status, 0, packaged.stderr);

		const serviceEnvironment = { ...process.env };
		delete serviceEnvironment.QORPERA_RUNNER_CONFIG;
		const service = spawnSync(process.execPath, [join(outputRoot, "qorpera-ephemeral-runner.mjs")], {
			env: serviceEnvironment,
			encoding: "utf-8",
		});
		assert.equal(service.status, 1);
		assert.equal(service.stderr.trim(), "QORPERA_RUNNER_CONFIG is required");

		const nativeService = spawnSync(
			process.execPath,
			[join(outputRoot, "qorpera-native-provider-host.mjs")],
			{ env: serviceEnvironment, encoding: "utf-8" },
		);
		assert.equal(nativeService.status, 1);
		assert.equal(nativeService.stderr.trim(), "QORPERA_SUPABASE_URL is required");

		const probe = spawnSync(process.execPath, [join(outputRoot, "qorpera-sandbox-probe.mjs")], {
			input: "{}\n",
			encoding: "utf-8",
		});
		assert.equal(probe.status, 1);
		assert.equal(probe.stderr.trim(), "Container request schema is unsupported");

		const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf-8"));
		assert.equal(manifest.schema, "qorpera.ephemeral-runner-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"company-lock-heartbeat.mjs",
				"qorpera-ephemeral-runner.mjs",
				"qorpera-native-provider-host.mjs",
				"qorpera-identity-recovery-restore.mjs",
				"qorpera-native-isolation-child.mjs",
				"qorpera-sandbox-probe.mjs",
				"qorpera-lxd-runner-bootstrap.mjs",
				"qorpera-lxd-native-login-bootstrap.mjs",
				"run-job",
			],
		);
		for (const artifact of manifest.artifacts) {
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
		}
		const recovery = spawnSync(process.execPath, [join(outputRoot, "qorpera-identity-recovery-restore.mjs"), "--help"], {
			encoding: "utf-8",
		});
		assert.equal(recovery.status, 0, recovery.stderr);
		assert.match(recovery.stdout, /No work is started/);
		assert.ok(!manifest.artifacts.some((artifact) => artifact.file === "qorpera-identity-recovery-service.mjs"));
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
