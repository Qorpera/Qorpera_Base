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
test("packages independent native and office guards with separate account custody", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-guard-package-"));
	try {
		const expected = runtimeBundleEnforced() ? await generateCloudRuntimeBundle(true) : await committedRuntimeBundle();
		const source = await cloudRuntimeBundle(), output = join(root, "package");
		const result = spawnSync(process.execPath, ["scripts/package-runtime-computer-guard.mjs", "--out", output], {
			cwd: repository, encoding: "utf8", timeout: 60000, env: runtimeBundlePackagingEnvironment(),
		});
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
		assert.equal(manifest.runtimeBundleSha256, expected.sha256);
		assert.equal(manifest.artifacts.length, 5);
		for (const entry of manifest.artifacts) {
			const bytes = await readFile(join(output, entry.file));
			assert.equal(entry.bytes, bytes.length);
			assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
		}
		for (const [provider, account] of [["native", "qorpera-provider"], ["office", "qorpera-office-provider"]]) {
			const unit = await readFile(join(output, `qorpera-${provider}-computer-guard.service`), "utf8");
			assert.ok(unit.includes(`User=${account}\nGroup=${account}`));
			assert.ok(unit.includes(`StateDirectory=qorpera-${provider}-computer-guard`));
			assert.match(unit, /WatchdogSec=15s/);
			assert.match(unit, /RestrictAddressFamilies=AF_UNIX/);
			assert.match(unit, /StateDirectoryMode=0700/);
			assert.doesNotMatch(unit, /@\w+@|LoadCredential=|PartOf=|Requires=qorpera-.*provider/);
		}
		const file = join(output, "qorpera-runtime-computer-guard.mjs");
		assert.doesNotMatch(await readFile(file, "utf8"), /SUPABASE_SERVICE_ROLE_KEY|p_executor_secret|RuntimeComputerHttpControl/);
		const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
		const invalid = spawnSync(process.execPath, [file, "--provider", "coding"], { encoding: "utf8" });
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, /Usage:/);
		const { NOTIFY_SOCKET: _notifySocket, ...environment } = process.env;
		for (const provider of ["native", "office"]) {
			const unsupervised = spawnSync(process.execPath, [file, "--provider", provider], {
				encoding: "utf8", env: environment, timeout: 5000,
			});
			assert.equal(unsupervised.status, 1, unsupervised.stderr);
			assert.equal(unsupervised.stderr.trim(), "PAID_GUARD_START_FAILED");
		}
		assert.match(source.manifest.implementation["deploy/runtime-computers/paid-computer-guard.ts"], /^[a-f0-9]{64}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
