import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLOUD_RUNTIME_ENTRY_POINTS, cloudRuntimeBundle, generateCloudRuntimeBundle, runtimeManifestText } from "./generate-cloud-runtime-bundle.mjs";
import {
	committedRuntimeBundle,
	RUNTIME_BUNDLE_NOT_ENFORCED,
	runtimeBundleEnforced,
	runtimeBundlePackagingEnvironment,
} from "./runtime-bundle-release-train.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("serializes the bounded manifest using PostgreSQL jsonb key order", () => {
	assert.equal(runtimeManifestText({ longer: "value", z: 1, a: [true, null] }), '{"a": [true, null], "z": 1, "longer": "value"}');
	assert.throws(() => runtimeManifestText({ a: 0.5 }), /Noninteger/);
	assert.throws(() => runtimeManifestText({ "é": true }), /Non-ASCII/);
});

test("the packaged native host embeds the same executable and policy pins as its manifest", async (t) => {
	const output = await mkdtemp(join(tmpdir(), "qorpera-runtime-package-test-"));
	try {
		// A release branch must match its source. Elsewhere the committed files may
		// lag it (release train); the package must then carry the committed pins.
		const enforced = runtimeBundleEnforced();
		if (!enforced) t.diagnostic(`packaged against the committed bundle: ${RUNTIME_BUNDLE_NOT_ENFORCED}`);
		const expected = enforced ? await generateCloudRuntimeBundle(true) : await committedRuntimeBundle();
		const packaged = spawnSync(process.execPath, ["scripts/package-ephemeral-runner.mjs", "--out", output], {
			cwd: repository, encoding: "utf8", timeout: 60_000, env: runtimeBundlePackagingEnvironment(),
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
		assert.equal(manifest.runtimeBundleSha256, expected.sha256);
		const host = await readFile(join(output, "qorpera-native-provider-host.mjs"));
		assert.equal(manifest.artifacts.find((artifact) => artifact.file === "qorpera-native-provider-host.mjs").sha256,
			createHash("sha256").update(host).digest("hex"));
		for (const pin of [expected.sha256, expected.modelPolicySha256, expected.manifest.nativeBinarySha256]) {
			assert.ok(host.includes(Buffer.from(pin)), "The actual packaged host must enforce every admitted pin");
		}
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});

test("pins every packaged entrypoint and detects code, generated-output and artifact drift", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-runtime-bundle-test-"));
	try {
		const fixture = join(root, "base");
		const current = await cloudRuntimeBundle();
		const files = [...new Set(current.sourceFiles)];
		await Promise.all(
			files.map(async (path) => {
				await mkdir(dirname(join(fixture, path)), { recursive: true });
				await copyFile(join(repository, path), join(fixture, path));
			}),
		);
		const initial = await generateCloudRuntimeBundle(false, fixture);
		assert.equal(initial.sha256, current.sha256);
		assert.equal(initial.sha256, createHash("sha256").update(initial.text).digest("hex"));
		assert.ok(Buffer.byteLength(initial.text) < 96 * 1024, `Runtime manifest must stay well below the 512 KiB SQL bound: ${Buffer.byteLength(initial.text)} B`);
		assert.deepEqual(initial.manifest.modelPolicy, {
			schema: "qorpera.model-reasoning/v1",
			effort: "low",
			overrides: "routine-and-thread",
			allowed: ["low", "medium", "high"],
			fastMode: "thread",
			unattended: "high",
			claudeChoice: "thread",
			threadEfforts: ["xhigh"],
			geminiChoice: "thread",
		});
		for (const path of Object.values(CLOUD_RUNTIME_ENTRY_POINTS)) assert.match(initial.manifest.implementation[path], /^[0-9a-f]{64}$/);
		assert.equal(initial.manifest.implementation["supabase/migrations"], initial.manifest.components.authorization);
		assert.match(initial.manifest.implementation["supabase/migrations"], /^[0-9a-f]{64}$/);
		assert.equal(Object.keys(initial.manifest.implementation).filter((path) => path.startsWith("supabase/migrations/")).length, 0);

		const generatedFiles = [
			"packages/runtime/src/cloud-runtime-bundle.generated.ts",
			"deploy/first-node/native-codex/runtime-bundle-manifest.json",
			"supabase/migrations/20260828019900_runtime_bundle_activation.sql",
		];
		const allFixtureFiles = [...new Set([...files, ...generatedFiles])];
		let cloneSeq = 0;
		const withClone = async (overrides, fn) => {
			const clone = join(root, `c-${++cloneSeq}`);
			const overrideSet = new Set(Object.keys(overrides));
			await Promise.all(
				allFixtureFiles.map(async (path) => {
					const target = join(clone, path);
					await mkdir(dirname(target), { recursive: true });
					if (overrideSet.has(path)) await writeFile(target, overrides[path]);
					else await link(join(fixture, path), target);
				}),
			);
			return fn(clone);
		};

		const [constitutionOrig, overlaysOrig, helperOrig, pinOrig, patchOrig] = await Promise.all([
			readFile(join(fixture, "packages/runtime/src/cloud-runtime-constitution.ts"), "utf8"),
			readFile(join(fixture, "packages/runtime/src/cloud-runtime-hire-overlays.ts"), "utf8"),
			readFile(join(fixture, "packages/runtime/src/cloud-native-isolation-child.ts"), "utf8"),
			readFile(join(fixture, "deploy/first-node/native-codex/linux-x64-artifact.json"), "utf8"),
			readFile(join(fixture, "deploy/first-node/native-codex/0001-cloud-result-fence.patch"), "utf8"),
		]);
		const native = JSON.parse(pinOrig);
		const badNativeFields = [
			["bytes", 0], ["bytes", 1024 ** 3 + 1], ["bytes", 0.5],
			["sha256", "unverified"], ["file", "other-binary"],
			["target", "aarch64-apple-darwin"], ["profile", "dev"],
		];
		const badPatchPin = structuredClone(native);
		badPatchPin.source.patchSha256 = "f".repeat(64);

		await Promise.all([
			(async () => {
				assert.equal((await generateCloudRuntimeBundle(true, fixture)).sha256, initial.sha256);
			})(),
			withClone(
				{ "packages/runtime/src/cloud-runtime-constitution.ts": `${constitutionOrig}\n// Synthetic behavior revision.\n` },
				async (clone) => {
					const revised = await cloudRuntimeBundle(clone);
					assert.notEqual(revised.manifest.components.constitution, initial.manifest.components.constitution);
					assert.notEqual(revised.manifest.components.providerBootstrap, initial.manifest.components.providerBootstrap);
				},
			),
			withClone(
				{ "packages/runtime/src/cloud-runtime-hire-overlays.ts": `${overlaysOrig}\n// Synthetic behavior revision.\n` },
				async (clone) => {
					const revised = await cloudRuntimeBundle(clone);
					assert.notEqual(revised.manifest.components.contextComposer, initial.manifest.components.contextComposer);
					assert.notEqual(revised.manifest.components.providerBootstrap, initial.manifest.components.providerBootstrap);
					assert.equal(revised.manifest.components.constitution, initial.manifest.components.constitution);
				},
			),
			withClone({ "supabase/migrations/20260828020000_runtime_wake_bus.sql": "-- Synthetic wake-bus drift.\n" }, async (clone) => {
				await assert.rejects(generateCloudRuntimeBundle(true, clone), /Runtime bundle is stale/);
			}),
			withClone(
				{ "packages/runtime/src/cloud-native-isolation-child.ts": `${helperOrig}\n// Synthetic implementation change.\n` },
				async (clone) => {
					await assert.rejects(generateCloudRuntimeBundle(true, clone), /Runtime bundle is stale/);
					const changed = await generateCloudRuntimeBundle(false, clone);
					assert.notEqual(changed.sha256, initial.sha256);
					assert.equal((await generateCloudRuntimeBundle(true, clone)).sha256, changed.sha256);
				},
			),
			withClone({ "packages/runtime/src/cloud-runtime-bundle.generated.ts": "// Synthetic stale compiled bundle.\n" }, async (clone) => {
				await assert.rejects(generateCloudRuntimeBundle(true, clone), /Runtime bundle is stale/);
			}),
			withClone({ "supabase/migrations/20260828019900_runtime_bundle_activation.sql": "-- Synthetic stale activation.\n" }, async (clone) => {
				await assert.rejects(generateCloudRuntimeBundle(true, clone), /Runtime bundle is stale/);
			}),
			...badNativeFields.map(([field, value]) => {
				const invalid = structuredClone(native);
				invalid.artifact[field] = value;
				return withClone({ "deploy/first-node/native-codex/linux-x64-artifact.json": JSON.stringify(invalid) }, async (clone) => {
					await assert.rejects(cloudRuntimeBundle(clone), /Native artifact pin differs/);
				});
			}),
			withClone({ "deploy/first-node/native-codex/linux-x64-artifact.json": JSON.stringify(badPatchPin) }, async (clone) => {
				await assert.rejects(cloudRuntimeBundle(clone), /Native artifact pin differs/);
			}),
			withClone(
				{ "deploy/first-node/native-codex/0001-cloud-result-fence.patch": `${patchOrig}\n# Unbuilt synthetic native patch.\n` },
				async (clone) => {
					await assert.rejects(cloudRuntimeBundle(clone), /Native artifact pin differs/);
				},
			),
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
