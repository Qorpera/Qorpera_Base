import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the model login helper apart from the broker and every execution host", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-login-helper-package-test-"));
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-model-login-helper.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
		assert.equal(manifest.schema, "qorpera.model-login-helper-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			["qorpera-model-login-helper.mjs", "qorpera-model-login-helper.service"],
		);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
		}
		const executable = join(destination, "qorpera-model-login-helper.mjs");
		const bundle = await readFile(executable, "utf8");
		// The helper never holds the vault's keys, a database login or a service key.
		assert.ok(!bundle.includes("CloudSecretKeyring"));
		assert.ok(!bundle.includes("qorpera_secret_broker"));
		assert.ok(!bundle.includes("NativeProviderHost"));
		const help = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /pinned official Codex/);
		const service = await readFile(join(destination, "qorpera-model-login-helper.service"), "utf8");
		assert.match(service, /^ProtectSystem=strict$/m);
		assert.match(service, /^NoNewPrivileges=yes$/m);
		assert.match(service, /^CapabilityBoundingSet=$/m);
		assert.match(service, /^RuntimeDirectory=qorpera-model-login-helper$/m);
		assert.match(service, /^LoadCredential=qorpera-model-login-helper-token:/m);
		assert.doesNotMatch(service, /qorpera-cloud-secret-keyring|qorpera-supabase-service-key/);
		assert.ok(!service.includes("Environment=QORPERA_"));
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
