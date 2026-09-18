import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the secret broker separately from every execution host", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-secret-broker-package-test-"));
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-cloud-secret-broker.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const encoded = await readFile(join(destination, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(manifest.schema, "qorpera.cloud-secret-broker-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"qorpera-cloud-secret-broker-service.mjs",
				"qorpera-cloud-secret-broker.service",
				"supabase-prod-ca-2021.crt",
			],
		);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
		}
		const executable = join(destination, "qorpera-cloud-secret-broker-service.mjs");
		const bundle = await readFile(executable, "utf8");
		assert.ok(!bundle.includes("DesktopSecretVault"));
		assert.ok(!bundle.includes("LocalSecretStore"));
		assert.ok(!bundle.includes("secret://"));
		assert.ok(!bundle.includes("NativeProviderHost"));
		const syntax = spawnSync(process.execPath, ["--check", executable], { encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
		const help = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /systemd credentials and a TLS reverse proxy/);
		const service = await readFile(join(destination, "qorpera-cloud-secret-broker.service"), "utf8");
		assert.match(service, /^ProtectSystem=strict$/m);
		assert.match(service, /^NoNewPrivileges=yes$/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-keyring:/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-runtime:/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-database-url:/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-database-ca:/m);
		assert.doesNotMatch(service, /qorpera-supabase-service-key/);
		assert.ok(!service.includes("Environment=QORPERA_"));
		const repeated = spawnSync(
			process.execPath,
			["scripts/package-cloud-secret-broker.mjs", "--out", destination],
			{ cwd: repositoryRoot, encoding: "utf8" },
		);
		assert.notEqual(repeated.status, 0);
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), encoded);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
