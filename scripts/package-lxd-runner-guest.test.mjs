import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the complete pinned LXD runner guest contract", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-lxd-runner-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-lxd-runner-guest.mjs", "--out", outputRoot, "--contract-only"],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifestEncoded = await readFile(join(outputRoot, "manifest.json"), "utf-8");
		const manifest = JSON.parse(manifestEncoded);
		assert.equal(manifest.schema, "qorpera.lxd-runner-guest-package/v1");
		assert.deepEqual(manifest.nativeHarnesses, { codex: "0.147.0", claudeCode: "2.1.231" });
		assert.equal(manifest.runnerImage.schema, "qorpera.ephemeral-runner-image-contract/v1");
		assert.match(manifest.runnerImage.image, /@sha256:[0-9a-f]{64}$/);
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"harness/package-lock.json",
				"harness/package.json",
				"install-image-contract.sh",
				"qorpera-ephemeral-runner.mjs",
				"qorpera-ephemeral-runner.service",
				"qorpera-lxd-native-login-bootstrap.mjs",
				"qorpera-lxd-native-login-bootstrap.service",
				"qorpera-lxd-runner-bootstrap.mjs",
				"qorpera-lxd-runner-bootstrap.service",
				"qorpera-native-provider-host.mjs",
				"qorpera-native-provider-host.service",
				"qorpera-sandbox-probe.mjs",
				"run-job",
				"runner-image/contract.json",
				"runner-image/qorpera-sandbox-probe.cosign-bundle.json",
				"runner-image/qorpera-sandbox-probe.oci.tar",
			],
		);
		for (const artifact of manifest.artifacts) {
			if (artifact.file === manifest.runnerImage.archive.file || artifact.file === manifest.runnerImage.cosign_bundle.file) {
				continue;
			}
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
		}
		assert.equal((await stat(join(outputRoot, "install-image-contract.sh"))).mode & 0o111, 0o111);

		const builderPath = join(repositoryRoot, "deploy/first-node/build-lxd-runner-image-candidate.sh");
		const builder = await readFile(builderPath, "utf-8");
		const acceptancePath = join(
			repositoryRoot,
			"deploy/first-node/verify-lxd-runner-image-candidate.sh",
		);
		const acceptance = await readFile(acceptancePath, "utf-8");
		const installer = await readFile(
			join(repositoryRoot, "deploy/lxd-runner-guest/install-image-contract.sh"),
			"utf-8",
		);
		const manifestSha256 = createHash("sha256").update(manifestEncoded).digest("hex");
		for (const recipe of [builder, acceptance]) {
			assert.ok(
				recipe.includes(`EXPECTED_PACKAGE_MANIFEST_SHA256="${manifestSha256}"`),
				"each image candidate recipe must pin this exact package manifest",
			);
		}
		assert.ok(builder.includes('LXD_BUILDER_PROJECT="default"'));
		assert.match(installer, /apt-get install --yes[^\n]*\bcrun\b/);
		assert.ok(installer.includes("/usr/bin/podman info >/dev/null"));
		assert.ok(acceptance.includes("install -d -o qorpera-runner -g qorpera-runner -m 0700 /run/qorpera-runner"));
		assert.ok(acceptance.includes("XDG_RUNTIME_DIR=/run/qorpera-runner"));
		assert.ok(!acceptance.includes("XDG_RUNTIME_DIR=/var/lib/qorpera-runner/tmp"));
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", builderPath, acceptancePath], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
