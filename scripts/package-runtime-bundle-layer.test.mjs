import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	packageRuntimeBundleLayer,
	RUNTIME_BUNDLE_LAYER_SCHEMA,
	RUNTIME_LAYER_FILES,
	verifyRuntimeBundleLayerDirectory,
} from "./package-runtime-bundle-layer.mjs";
import { runtimeBundlePackagingEnvironment } from "./runtime-bundle-release-train.mjs";

function writeFakeLayer(dir, bundleSha) {
	const artifacts = [];
	for (const file of RUNTIME_LAYER_FILES) {
		const content = Buffer.from(`// ${file}\n`);
		writeFileSync(join(dir, file), content);
		artifacts.push({
			file,
			bytes: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	writeFileSync(
		join(dir, "manifest.json"),
		`${JSON.stringify({ schema: RUNTIME_BUNDLE_LAYER_SCHEMA, runtimeBundleSha256: bundleSha, artifacts }, null, 2)}\n`,
		"utf8",
	);
}

test("verifyRuntimeBundleLayerDirectory validates clean layers and refuses tampering, bundle mismatch, or symlinks", () => {
	const dir = mkdtempSync(join(tmpdir(), "qorpera-layer-verify-"));
	try {
		const bundleSha = "a".repeat(64);
		writeFakeLayer(dir, bundleSha);
		const verified = verifyRuntimeBundleLayerDirectory(dir, bundleSha);
		assert.equal(verified.runtimeBundleSha256, bundleSha);
		assert.equal(verified.artifacts.length, RUNTIME_LAYER_FILES.length);

		assert.throws(() => verifyRuntimeBundleLayerDirectory(dir, "b".repeat(64)), /Runtime bundle layer mismatch/);

		writeFileSync(join(dir, "qorpera-native-provider-host.mjs"), "tampered\n");
		assert.throws(() => verifyRuntimeBundleLayerDirectory(dir, bundleSha), /Digest mismatch/);

		const symDir = mkdtempSync(join(tmpdir(), "qorpera-layer-sym-"));
		try {
			writeFakeLayer(symDir, bundleSha);
			rmSync(join(symDir, "run-job"));
			symlinkSync(join(dir, "run-job"), join(symDir, "run-job"));
			assert.throws(() => verifyRuntimeBundleLayerDirectory(symDir, bundleSha), /non-symlink/);
		} finally {
			rmSync(symDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("packageRuntimeBundleLayer produces a verified thin runtime code directory", async () => {
	const outDir = mkdtempSync(join(tmpdir(), "qorpera-layer-pkg-"));
	try {
		const { manifest } = await packageRuntimeBundleLayer({
			outDir,
			env: runtimeBundlePackagingEnvironment(),
		});
		assert.equal(manifest.schema, RUNTIME_BUNDLE_LAYER_SCHEMA);
		assert.equal(manifest.artifacts.length, RUNTIME_LAYER_FILES.length);
		const totalBytes = manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0);
		assert.ok(totalBytes > 1024 && totalBytes < 32 * 1024 * 1024);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
