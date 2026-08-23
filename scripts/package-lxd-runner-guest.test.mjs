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
			["scripts/package-lxd-runner-guest.mjs", "--out", outputRoot],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifestEncoded = await readFile(join(outputRoot, "manifest.json"), "utf-8");
		const manifest = JSON.parse(manifestEncoded);
		assert.equal(manifest.schema, "qorpera.lxd-runner-guest-package/v1");
		assert.deepEqual(manifest.nativeHarnesses, { codex: "0.147.0", claudeCode: "2.1.231" });
		assert.equal(manifest.artifacts.length, 11);
		for (const artifact of manifest.artifacts) {
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
		const manifestSha256 = createHash("sha256").update(manifestEncoded).digest("hex");
		for (const recipe of [builder, acceptance]) {
			assert.ok(
				recipe.includes(`EXPECTED_PACKAGE_MANIFEST_SHA256="${manifestSha256}"`),
				"each image candidate recipe must pin this exact package manifest",
			);
		}
		assert.ok(builder.includes('LXD_BUILDER_PROJECT="default"'));
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", builderPath, acceptancePath], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
