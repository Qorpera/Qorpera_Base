import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	packageRuntimeBundleLayer,
	parseCliArgs,
	RUNTIME_BUNDLE_LAYER_SCHEMA,
	RUNTIME_HOST_LAYER_FILES,
	verifyRuntimeBundleLayerDirectory,
} from "./package-runtime-bundle-layer.mjs";
import { runtimeBundlePackagingEnvironment } from "./runtime-bundle-release-train.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeFakeLayer(dir, bundleSha, { omitPin = false } = {}) {
	chmodSync(dir, 0o755);
	const artifacts = [];
	for (const file of RUNTIME_HOST_LAYER_FILES) {
		const content = Buffer.from(
			omitPin ? `export const file = ${JSON.stringify(file)};\n` : `export const bundle = ${JSON.stringify(bundleSha)};\nexport const file = ${JSON.stringify(file)};\n`,
		);
		const filePath = join(dir, file);
		writeFileSync(filePath, content, { mode: 0o555 });
		chmodSync(filePath, 0o555);
		artifacts.push({
			file,
			bytes: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	const manifestText = `${JSON.stringify({ schema: RUNTIME_BUNDLE_LAYER_SCHEMA, runtimeBundleSha256: bundleSha, artifacts }, null, 2)}\n`;
	const manifestPath = join(dir, "manifest.json");
	writeFileSync(manifestPath, manifestText, { encoding: "utf8", mode: 0o444 });
	chmodSync(manifestPath, 0o444);
	return createHash("sha256").update(manifestText).digest("hex");
}

test("verifyRuntimeBundleLayerDirectory validates clean layers and refuses tampering, extra files, symlinks, bad modes, and unpinned code", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-verify-")));
	const extraDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-extra-")));
	const symDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-sym-")));
	const unpinnedDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-unpinned-")));
	const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-link-")));
	try {
		const bundleSha = "a".repeat(64);
		const manifestSha = writeFakeLayer(dir, bundleSha);
		const verified = verifyRuntimeBundleLayerDirectory(dir, {
			expectedBundleSha256: bundleSha,
			expectedManifestSha256: manifestSha,
		});
		assert.equal(verified.manifest.runtimeBundleSha256, bundleSha);
		assert.equal(verified.manifestSha256, manifestSha);
		assert.equal(verified.manifest.artifacts.length, 7);

		assert.throws(
			() => verifyRuntimeBundleLayerDirectory(dir, { expectedManifestSha256: "b".repeat(64) }),
			/manifest sha256 mismatch/,
		);
		assert.throws(
			() => verifyRuntimeBundleLayerDirectory(dir, { expectedBundleSha256: "b".repeat(64) }),
			/Runtime bundle layer mismatch/,
		);

		const symlinkToDir = join(linkParent, "layer-link");
		symlinkSync(dir, symlinkToDir);
		assert.throws(() => verifyRuntimeBundleLayerDirectory(symlinkToDir), /non-symlink directory/);

		writeFakeLayer(extraDir, bundleSha);
		writeFileSync(join(extraDir, "unexpected.mjs"), "export {};\n");
		assert.throws(() => verifyRuntimeBundleLayerDirectory(extraDir), /must contain exact/);

		writeFakeLayer(unpinnedDir, bundleSha, { omitPin: true });
		assert.throws(() => verifyRuntimeBundleLayerDirectory(unpinnedDir), /does not embed runtimeBundleSha256/);

		writeFakeLayer(symDir, bundleSha);
		chmodSync(join(symDir, "qorpera-claude-home-shell.mjs"), 0o664);
		assert.throws(() => verifyRuntimeBundleLayerDirectory(symDir), /group- or world-writable/);
		rmSync(join(symDir, "qorpera-claude-home-shell.mjs"));
		symlinkSync(join(dir, "qorpera-claude-home-shell.mjs"), join(symDir, "qorpera-claude-home-shell.mjs"));
		assert.throws(() => verifyRuntimeBundleLayerDirectory(symDir), /non-symlink/);

		chmodSync(join(dir, "qorpera-native-provider-host.mjs"), 0o644);
		writeFileSync(join(dir, "qorpera-native-provider-host.mjs"), "tampered\n");
		assert.throws(() => verifyRuntimeBundleLayerDirectory(dir, { expectedBundleSha256: bundleSha }), /Digest mismatch/);
	} finally {
		for (const item of [dir, extraDir, symDir, unpinnedDir, linkParent]) {
			rmSync(item, { recursive: true, force: true });
		}
	}
});

test("parseCliArgs rejects conflicting flags and packageRuntimeBundleLayer guards repo root and sets 0555/0444 modes", async () => {
	assert.throws(() => parseCliArgs(["--verify", "/tmp/a", "--out", "/tmp/b"]), /cannot be combined/);
	assert.throws(() => parseCliArgs(["--expected-bundle", "a".repeat(64)]), /require --verify/);
	assert.throws(() => parseCliArgs(["--expected-manifest", "a".repeat(64)]), /require --verify/);
	assert.throws(() => parseCliArgs(["--verify", "--out"]), /requires a value/);

	await assert.rejects(() => packageRuntimeBundleLayer({ outDir: repositoryRoot }), /must not contain the repository root/);

	const outDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-pkg-")));
	try {
		const { outputRoot, manifest, manifestSha256 } = await packageRuntimeBundleLayer({
			outDir,
			env: runtimeBundlePackagingEnvironment(),
		});
		assert.equal(manifest.schema, RUNTIME_BUNDLE_LAYER_SCHEMA);
		assert.equal(manifest.artifacts.length, 7);
		assert.match(manifestSha256, /^[0-9a-f]{64}$/);
		assert.equal(statSync(join(outputRoot, "manifest.json")).mode & 0o777, 0o444);
		for (const file of RUNTIME_HOST_LAYER_FILES) {
			assert.equal(statSync(join(outputRoot, file)).mode & 0o777, 0o555);
		}
		const totalBytes = manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0);
		assert.ok(totalBytes > 1024 && totalBytes < 32 * 1024 * 1024);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
