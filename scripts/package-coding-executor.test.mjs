import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cloudRuntimeBundle, generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";

import { committedRuntimeBundle, runtimeBundleEnforced, runtimeBundlePackagingEnvironment } from "./runtime-bundle-release-train.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("packages the independent paid guard and pins its supervisor and explicit opt-in", async () => {
	const root = await mkdtemp(join(tmpdir(), "coding-executor-package-"));
	try {
		const expected = runtimeBundleEnforced() ? await generateCloudRuntimeBundle(true) : await committedRuntimeBundle();
		const source = await cloudRuntimeBundle();
		const output = join(root, "package");
		const result = spawnSync(process.execPath, ["scripts/package-coding-executor.mjs", "--out", output], {
			cwd: repository, encoding: "utf8", timeout: 60000, env: runtimeBundlePackagingEnvironment(),
		});
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
		assert.equal(manifest.runtimeBundleSha256, expected.sha256);
		assert.deepEqual(manifest.artifacts.map((entry) => entry.file), [
			"qorpera-paid-computer-guard.mjs", "qorpera-paid-computer-guard.service", "qorpera-coding-paid.conf",
		]);
		for (const entry of [manifest, ...manifest.artifacts]) {
			const bytes = await readFile(join(output, entry.file));
			assert.equal(entry.bytes, bytes.length);
			assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
		}
		for (const name of ["paid-computer-guard.ts", "qorpera-paid-computer-guard.service", "qorpera-coding-paid.conf"])
			assert.match(source.manifest.implementation[`deploy/coding-worker/${name}`], /^[a-f0-9]{64}$/);
		const guard = await readFile(join(output, "qorpera-paid-computer-guard.mjs"), "utf8");
		assert.doesNotMatch(guard, /SUPABASE_SERVICE_ROLE_KEY|qorpera-coding-registry|qorpera-coding-computer-executor/);
		const unit = await readFile(join(output, "qorpera-paid-computer-guard.service"), "utf8");
		assert.match(unit, /WatchdogSec=15s/);
		assert.match(unit, /RestrictAddressFamilies=AF_UNIX/);
		assert.match(unit, /StateDirectoryMode=0700/);
		assert.doesNotMatch(unit, /LoadCredential=|PartOf=.*coding-executor/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
