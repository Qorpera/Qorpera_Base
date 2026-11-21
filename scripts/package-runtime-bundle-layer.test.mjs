import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRelease } from "../deploy/node-agent/make-release.mjs";
import { parseRelease } from "../deploy/node-agent/qorpera-node-agent.mjs";
import {
	buildDeterministicTarGz,
	packageRuntimeBundleLayer,
	packageRuntimeBundleLayerArchive,
	parseCliArgs,
	RUNTIME_BUNDLE_LAYER_SCHEMA,
	RUNTIME_HOST_LAYER_FILES,
	verifyRuntimeBundleLayerArchive,
	verifyRuntimeBundleLayerDirectory,
} from "./package-runtime-bundle-layer.mjs";
import { runtimeBundlePackagingEnvironment } from "./runtime-bundle-release-train.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeFakeLayer(dir, bundleSha, { omitPin = false } = {}) {
	chmodSync(dir, 0o755);
	const artifacts = [];
	const entries = [];
	for (const file of RUNTIME_HOST_LAYER_FILES) {
		const includePin = !omitPin && file === "qorpera-native-provider-host.mjs";
		const content = Buffer.from(
			includePin
				? `export const bundle = ${JSON.stringify(bundleSha)};\nexport const file = ${JSON.stringify(file)};\n`
				: `export const file = ${JSON.stringify(file)};\n`,
		);
		const filePath = join(dir, file);
		writeFileSync(filePath, content, { mode: 0o555 });
		chmodSync(filePath, 0o555);
		artifacts.push({
			file,
			bytes: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
		entries.push({ name: file, mode: 0o555, content });
	}
	const manifestText = `${JSON.stringify({ schema: RUNTIME_BUNDLE_LAYER_SCHEMA, runtimeBundleSha256: bundleSha, artifacts }, null, 2)}\n`;
	const manifestPath = join(dir, "manifest.json");
	writeFileSync(manifestPath, manifestText, { encoding: "utf8", mode: 0o444 });
	chmodSync(manifestPath, 0o444);
	entries.push({ name: "manifest.json", mode: 0o444, content: Buffer.from(manifestText, "utf8") });
	return { manifestSha: createHash("sha256").update(manifestText).digest("hex"), entries };
}

test("verifyRuntimeBundleLayerDirectory validates clean layers and refuses tampering, extra files, symlinks, bad modes, and unpinned code", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-verify-")));
	const extraDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-extra-")));
	const symDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-sym-")));
	const unpinnedDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-unpinned-")));
	const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-link-")));
	try {
		const bundleSha = "a".repeat(64);
		const { manifestSha } = writeFakeLayer(dir, bundleSha);
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
	assert.throws(() => parseCliArgs(["--archive", "/tmp/a.tar.gz", "--out", "/tmp/b"]), /cannot be combined/);
	assert.throws(() => parseCliArgs(["--verify-archive", "/tmp/a.tar.gz", "--verify", "/tmp/b"]), /cannot be combined/);
	assert.throws(() => parseCliArgs(["--expected-archive", "a".repeat(64)]), /requires --verify-archive/);
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

test("packageRuntimeBundleLayerArchive builds a deterministic flat tar.gz accepted and Ed25519-signed by make-release.mjs", async () => {
	const workDir = realpathSync(mkdtempSync(join(tmpdir(), "qorpera-layer-archive-")));
	try {
		const archiveOne = join(workDir, "qorpera-runtime-bundle-layer.tar.gz");
		const archiveTwo = join(workDir, "qorpera-runtime-bundle-layer-copy.tar.gz");
		const env = runtimeBundlePackagingEnvironment();
		const first = await packageRuntimeBundleLayerArchive({ archivePath: archiveOne, env });
		const second = await packageRuntimeBundleLayerArchive({ archivePath: archiveTwo, env });
		assert.equal(first.archiveSha256, second.archiveSha256);
		assert.equal(first.bytes, second.bytes);
		assert.equal(statSync(first.archivePath).mode & 0o777, 0o444);
		assert.ok(first.bytes > 1024 && first.bytes < 64 * 1024 * 1024);

		const verified = verifyRuntimeBundleLayerArchive(first.archivePath, {
			expectedArchiveSha256: first.archiveSha256,
			expectedManifestSha256: first.manifestSha256,
			expectedBundleSha256: first.manifest.runtimeBundleSha256,
		});
		assert.equal(verified.archiveSha256, first.archiveSha256);
		assert.throws(
			() => verifyRuntimeBundleLayerArchive(first.archivePath, { expectedArchiveSha256: "0".repeat(64) }),
			/archive sha256 mismatch/,
		);

		const linkPath = join(workDir, "link.tar.gz");
		symlinkSync(first.archivePath, linkPath);
		assert.throws(() => verifyRuntimeBundleLayerArchive(linkPath), /non-symlink regular file/);

		const fakeDir = join(workDir, "fake-layer");
		mkdirSync(fakeDir, { recursive: true });
		const { entries } = writeFakeLayer(fakeDir, "e".repeat(64));
		const extraArchive = join(workDir, "extra.tar.gz");
		writeFileSync(
			extraArchive,
			buildDeterministicTarGz([...entries, { name: "rogue.mjs", mode: 0o555, content: Buffer.from("export {};\n") }]),
			{ mode: 0o444 },
		);
		chmodSync(extraArchive, 0o444);
		assert.throws(() => verifyRuntimeBundleLayerArchive(extraArchive), /must contain exact/);
		assert.throws(() => buildDeterministicTarGz([{ name: "../escape", mode: 0o444, content: Buffer.from("x") }]), /Invalid tar entry name/);

		const dummyProgram = join(workDir, "qorpera-dummy.mjs");
		writeFileSync(dummyProgram, "console.log('ok');\n", { mode: 0o555 });
		const { privateKey } = generateKeyPairSync("ed25519");
		const releaseDir = join(workDir, "release-158");
		const release = await buildRelease(
			{
				revision: 158,
				previousRevision: 157,
				sourceCommit: "a".repeat(40),
				runtimeBundleSha256: first.manifest.runtimeBundleSha256,
				order: "schema-first",
				files: {
					"qorpera-dummy.mjs": dummyProgram,
					"qorpera-runtime-bundle-layer.tar.gz": first.archivePath,
				},
				roles: {
					observer: {
						component: "qorpera-dummy.mjs",
						env: {
							QORPERA_RUNTIME_BUNDLE_ARCHIVE: "${release}/qorpera-runtime-bundle-layer.tar.gz",
						},
					},
				},
			},
			privateKey.export({ type: "pkcs8", format: "pem" }),
			releaseDir,
		);
		const parsed = parseRelease(readFileSync(join(releaseDir, "release.json")));
		const archiveEntry = parsed.files.find((item) => item.name === "qorpera-runtime-bundle-layer.tar.gz");
		assert.ok(archiveEntry);
		assert.equal(archiveEntry.sha256, first.archiveSha256);
		assert.equal(archiveEntry.bytes, first.bytes);
		assert.equal(release.revision, 158);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
});
