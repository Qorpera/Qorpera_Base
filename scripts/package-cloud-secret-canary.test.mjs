import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages one destination-bound custody canary with encrypted systemd credentials", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-secret-canary-package-test-"));
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-cloud-secret-canary.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const encoded = await readFile(join(destination, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(manifest.schema, "qorpera.step2-secret-canary-package/v1");
		assert.deepEqual(manifest.adapter, {
			connectorId: "step2_canary",
			operationId: "record_marker",
			operationVersion: 1,
			destinationOrigin: "https://127.0.0.1:9443",
			adapterSha256: manifest.adapter.adapterSha256,
		});
		assert.match(manifest.adapter.adapterSha256, /^[0-9a-f]{64}$/);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
		}
		for (const executable of [
			"qorpera-cloud-secret-broker-canary-service.mjs",
			"qorpera-step2-secret-canary-destination.mjs",
			"qorpera-step2-secret-canary-driver.mjs",
		]) {
			const bundle = await readFile(join(destination, executable), "utf8");
			assert.ok(!bundle.includes("DesktopSecretVault"));
			assert.ok(!bundle.includes("LocalSecretStore"));
			assert.ok(!bundle.includes("secret://"));
			assert.ok(!bundle.includes("getSecret"));
			assert.equal(
				spawnSync(process.execPath, ["--check", join(destination, executable)], { encoding: "utf8" }).status,
				0,
			);
		}
		const brokerExecutable = join(destination, "qorpera-cloud-secret-broker-canary-service.mjs");
		const described = spawnSync(process.execPath, [brokerExecutable, "--describe"], {
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(described.status, 0, described.stderr);
		assert.equal(described.signal, null);
		assert.equal(described.stdout.trim(), "Qorpera Step 2 secret-custody canary broker; fixed adapter only.");
		assert.equal(described.stderr, "");
		const brokerUnit = await readFile(join(destination, "qorpera-cloud-secret-broker-canary.service"), "utf8");
		assert.match(brokerUnit, /^LoadCredentialEncrypted=qorpera-cloud-secret-keyring$/m);
		assert.match(brokerUnit, /^LoadCredentialEncrypted=qorpera-cloud-secret-runtime$/m);
		assert.match(brokerUnit, /^LoadCredentialEncrypted=qorpera-cloud-secret-database-url$/m);
		assert.match(brokerUnit, /^LoadCredential=qorpera-cloud-secret-database-ca:/m);
		assert.doesNotMatch(brokerUnit, /qorpera-supabase-service-key/);
		assert.deepEqual(
			brokerUnit.split("\n").filter((line) => line.startsWith("LoadCredential=")),
			[
				"LoadCredential=qorpera-cloud-secret-database-ca:/usr/local/lib/qorpera-step2-secret-canary/supabase-prod-ca-2021.crt",
			],
		);
		const destinationUnit = await readFile(
			join(destination, "qorpera-step2-secret-canary-destination.service"),
			"utf8",
		);
		assert.match(destinationUnit, /^LoadCredentialEncrypted=qorpera-step2-canary-provider-token$/m);
		const proxy = await readFile(join(destination, "capture-proxy.conf"), "utf8");
		assert.match(proxy, /^\s*access_log off;$/m);
		assert.match(proxy, /^\s*client_body_buffer_size 96k;$/m);
		assert.match(proxy, /^\s*location ~ "\^\/v1\/captures\/\[0-9a-fA-F-\]\{36\}\$" \{$/m);
		assert.match(proxy, /^\s*location = \/v1\/operations \{$/m);
		assert.match(proxy, /^\s*allow 2\.110\.77\.200;$/m);
		assert.match(proxy, /^\s*deny all;$/m);
		const proxyUnit = await readFile(join(destination, "qorpera-cloud-secret-capture-proxy.service"), "utf8");
		assert.match(proxyUnit, /^User=qorpera-secret-proxy$/m);
		assert.match(proxyUnit, /^Group=qorpera-secret-proxy$/m);
		assert.match(proxyUnit, /^CacheDirectory=qorpera-secret-capture-proxy\/client$/m);
		assert.match(proxyUnit, /^CacheDirectory=qorpera-secret-capture-proxy\/proxy$/m);
		const repeated = spawnSync(
			process.execPath,
			["scripts/package-cloud-secret-canary.mjs", "--out", destination],
			{ cwd: repositoryRoot, encoding: "utf8" },
		);
		assert.notEqual(repeated.status, 0);
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), encoded);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
