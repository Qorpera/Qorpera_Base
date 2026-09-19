import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLOUD_RUNTIME_ENTRY_POINTS, cloudRuntimeBundle, generateCloudRuntimeBundle, runtimeManifestText } from "./generate-cloud-runtime-bundle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("serializes the bounded manifest using PostgreSQL jsonb key order", () => {
	assert.equal(runtimeManifestText({ longer: "value", z: 1, a: [true, null] }), '{"a": [true, null], "z": 1, "longer": "value"}');
	assert.throws(() => runtimeManifestText({ a: 0.5 }), /Noninteger/);
	assert.throws(() => runtimeManifestText({ "é": true }), /Non-ASCII/);
});

test("the packaged native host embeds the same executable and policy pins as its manifest", async () => {
	const output = await mkdtemp(join(tmpdir(), "qorpera-runtime-package-test-"));
	try {
		const expected = await generateCloudRuntimeBundle(true);
		const packaged = spawnSync(process.execPath, ["scripts/package-ephemeral-runner.mjs", "--out", output], {
			cwd: repository, encoding: "utf8", timeout: 60_000,
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
	const fixture = await mkdtemp(join(tmpdir(), "qorpera-runtime-bundle-test-"));
	try {
		const current = await cloudRuntimeBundle();
		const files = new Set(Object.keys(current.manifest.implementation));
		for (const path of files) {
			await mkdir(dirname(join(fixture, path)), { recursive: true });
			await copyFile(join(repository, path), join(fixture, path));
		}
		const initial = await generateCloudRuntimeBundle(false, fixture);
		assert.equal(initial.sha256, current.sha256);
		assert.equal(initial.sha256, createHash("sha256").update(initial.text).digest("hex"));
		assert.deepEqual(initial.manifest.modelPolicy, { schema: "qorpera.model-reasoning/v1", effort: "low", overrides: "none" });
		for (const path of Object.values(CLOUD_RUNTIME_ENTRY_POINTS)) assert.match(initial.manifest.implementation[path], /^[0-9a-f]{64}$/);
		assert.match(initial.manifest.implementation["supabase/migrations/20260828020000_runtime_wake_bus.sql"], /^[0-9a-f]{64}$/);
		for (const path of ["packages/runtime/src/cloud-company-computer-browser-control.ts", "packages/runtime/src/cloud-company-computer-privacy.ts", "deploy/lxd-company-computer-guest/qorpera-screen-session", "deploy/lxd-company-computer-guest/qorpera-company-computer.service", "packages/runtime/src/cloud-company-computer-service-main.ts", "scripts/package-company-computer.mjs", "deploy/lxd-company-computer-guest/backdrops/qorpera-screen-pebble-00.png"]) {
			assert.match(initial.manifest.implementation[path], /^[0-9a-f]{64}$/);
		}
		assert.equal((await generateCloudRuntimeBundle(true, fixture)).sha256, initial.sha256);
		// Behavioral law and hire defaults have explicit, independently reviewable pins.
		for (const [name, component] of [["cloud-runtime-constitution", "constitution"], ["cloud-runtime-hire-overlays", "contextComposer"]]) {
			const path = join(fixture, `packages/runtime/src/${name}.ts`);
			const original = await readFile(path, "utf8");
			await writeFile(path, `${original}\n// Synthetic behavior revision.\n`);
			const revised = await cloudRuntimeBundle(fixture);
			assert.notEqual(revised.manifest.components[component], initial.manifest.components[component]);
			assert.notEqual(revised.manifest.components.providerBootstrap, initial.manifest.components.providerBootstrap);
			if (name === "cloud-runtime-hire-overlays") assert.equal(revised.manifest.components.constitution, initial.manifest.components.constitution);
			await writeFile(path, original);
		}
		await writeFile(join(fixture, "supabase/migrations/20260828020000_runtime_wake_bus.sql"), "-- Synthetic wake-bus drift.\n");
		await assert.rejects(generateCloudRuntimeBundle(true, fixture), /Runtime bundle is stale/);
		await generateCloudRuntimeBundle(false, fixture);

		// This helper runs in another process; it is not a transitive import.
		const helper = join(fixture, "packages/runtime/src/cloud-native-isolation-child.ts");
		await writeFile(helper, `${await readFile(helper, "utf8")}\n// Synthetic implementation change.\n`);
		await assert.rejects(generateCloudRuntimeBundle(true, fixture), /Runtime bundle is stale/);
		const changed = await generateCloudRuntimeBundle(false, fixture);
		assert.notEqual(changed.sha256, initial.sha256);
		assert.equal((await generateCloudRuntimeBundle(true, fixture)).sha256, changed.sha256);

		const generated = join(fixture, "packages/runtime/src/cloud-runtime-bundle.generated.ts");
		await writeFile(generated, "// Synthetic stale compiled bundle.\n");
		await assert.rejects(generateCloudRuntimeBundle(true, fixture), /Runtime bundle is stale/);
		await generateCloudRuntimeBundle(false, fixture);
		const activation = join(fixture, "supabase/migrations/20260828019900_runtime_bundle_activation.sql");
		await writeFile(activation, "-- Synthetic stale activation.\n");
		await assert.rejects(generateCloudRuntimeBundle(true, fixture), /Runtime bundle is stale/);

		const pin = join(fixture, "deploy/first-node/native-codex/linux-x64-artifact.json");
		const native = JSON.parse(await readFile(pin, "utf8"));
		for (const [field, value] of [
			["bytes", 0], ["bytes", 1024 ** 3 + 1], ["bytes", 0.5],
			["sha256", "unverified"], ["file", "other-binary"],
			["target", "aarch64-apple-darwin"], ["profile", "dev"],
		]) {
			const invalid = structuredClone(native);
			invalid.artifact[field] = value;
			await writeFile(pin, JSON.stringify(invalid));
			await assert.rejects(cloudRuntimeBundle(fixture), /Native artifact pin differs/);
		}
		native.source.patchSha256 = "f".repeat(64);
		await writeFile(pin, JSON.stringify(native));
		await assert.rejects(cloudRuntimeBundle(fixture), /Native artifact pin differs/);
		await copyFile(join(repository, "deploy/first-node/native-codex/linux-x64-artifact.json"), pin);
		const patch = join(fixture, "deploy/first-node/native-codex/0001-cloud-result-fence.patch");
		await writeFile(patch, `${await readFile(patch, "utf8")}\n# Unbuilt synthetic native patch.\n`);
		await assert.rejects(cloudRuntimeBundle(fixture), /Native artifact pin differs/);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});
