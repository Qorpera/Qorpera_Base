import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages directly executable ephemeral runner bundles", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-ephemeral-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-ephemeral-runner.mjs", "--out", outputRoot],
			{ cwd: repositoryRoot, encoding: "utf-8" },
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

		const probe = spawnSync(process.execPath, [join(outputRoot, "qorpera-sandbox-probe.mjs")], {
			input: "{}\n",
			encoding: "utf-8",
		});
		assert.equal(probe.status, 1);
		assert.equal(probe.stderr.trim(), "Container request schema is unsupported");

		const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf-8"));
		assert.equal(manifest.schema, "qorpera.ephemeral-runner-package/v1");
		for (const artifact of manifest.artifacts) {
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
		}
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
