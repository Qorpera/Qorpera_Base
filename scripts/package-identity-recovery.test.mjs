import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages an independent recovery authority and a separate restore client", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-recovery-package-test-"));
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-identity-recovery.mjs", "--out", destination], {
			cwd: repositoryRoot, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const encoded = await readFile(join(destination, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(manifest.schema, "qorpera.identity-recovery-package/v1");
		assert.deepEqual(manifest.artifacts.map((artifact) => artifact.file), [
			"qorpera-identity-recovery-service.mjs", "qorpera-identity-recovery-restore.mjs",
			"qorpera-identity-recovery.service",
		]);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
			if (!artifact.file.endsWith(".mjs")) continue;
			const checked = spawnSync(process.execPath, ["--check", join(destination, artifact.file)], { encoding: "utf8" });
			assert.equal(checked.status, 0, checked.stderr);
			const help = spawnSync(process.execPath, [join(destination, artifact.file), "--help"], { encoding: "utf8" });
			assert.equal(help.status, 0, help.stderr);
			assert.ok(help.stdout.trim());
		}
		const client = await readFile(join(destination, "qorpera-identity-recovery-restore.mjs"), "utf8");
		assert.ok(!client.includes("class CloudIdentityRecoveryAuthority"));
		assert.ok(!client.includes("CloudIdentityRecoveryAuthority ="));
		const service = await readFile(join(destination, "qorpera-identity-recovery.service"), "utf8");
		assert.match(service, /^ProtectSystem=strict$/m);
		assert.match(service, /^UMask=0077$/m);
		assert.match(service, /^NoNewPrivileges=yes$/m);
		assert.match(service, /^LoadCredential=qorpera-recovery-wrapping-key:/m);
		assert.match(service, /^LoadCredential=qorpera-recovery-signing-key:/m);
		assert.match(service, /^RequiresMountsFor=\/var\/lib\/qorpera-recovery$/m);
		assert.match(service, /^ReadWritePaths=\/var\/lib\/qorpera-recovery \/mnt\/qorpera-recovery$/m);
		assert.ok(!/^RequiresMountsFor=.*\/mnt\//m.test(service));
		const unconfigured = spawnSync(process.execPath, [join(destination, "qorpera-identity-recovery-service.mjs")], {
			encoding: "utf8", env: { CREDENTIALS_DIRECTORY: "" },
		});
		assert.equal(unconfigured.status, 1);
		assert.match(unconfigured.stderr, /^Cloud identity recovery service could not start or continue;/);
		assert.ok(!unconfigured.stderr.includes(" at "));
		const repeated = spawnSync(process.execPath, ["scripts/package-identity-recovery.mjs", "--out", destination], {
			cwd: repositoryRoot, encoding: "utf8",
		});
		assert.notEqual(repeated.status, 0);
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), encoded);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
