import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

test("packages and pins the first-node LXD provider", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-lxd-provider-package-test-"));
	try {
		const packaged = spawnSync(process.execPath, ["scripts/package-lxd-provider.mjs", "--out", outputRoot], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(packaged.status, 0, packaged.stderr);

		const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf-8"));
		assert.equal(manifest.schema, "qorpera.lxd-provider-package/v1");
		assert.deepEqual(manifest.runtime, { node: ">=22.19.0" });
		assert.equal(manifest.artifacts.length, 2);
		const providerArtifact = await readFile(join(outputRoot, "qorpera-lxd-provider.mjs"));
		const provenanceArtifact = await readFile(join(outputRoot, "qorpera-lxd-image-provenance.mjs"));
		assert.deepEqual(manifest.artifacts[0], {
			file: "qorpera-lxd-provider.mjs",
			bytes: providerArtifact.byteLength,
			sha256: sha256(providerArtifact),
		});
		assert.deepEqual(manifest.artifacts[1], {
			file: "qorpera-lxd-image-provenance.mjs",
			bytes: provenanceArtifact.byteLength,
			sha256: sha256(provenanceArtifact),
		});

		const installerPath = join(repositoryRoot, "deploy/first-node/install-lxd-provider-host.sh");
		const installer = await readFile(installerPath, "utf-8");
		const unit = await readFile(join(repositoryRoot, "deploy/first-node/qorpera-lxd-provider.service"));
		assert.match(unit.toString(), /^ProcSubset=all$/m, "node admission requires CPU and memory metadata");
		assert.match(unit.toString(), /^ProtectProc=invisible$/m, "unrelated processes must remain hidden");
		const environmentExample = await readFile(
			join(repositoryRoot, "deploy/first-node/lxd-provider.env.example"),
		);
		const expectedPins = [
			`EXPECTED_PROVENANCE_TOOL_SHA256="${sha256(provenanceArtifact)}"`,
			`EXPECTED_UNIT_SHA256="${sha256(unit)}"`,
			`EXPECTED_ENV_EXAMPLE_SHA256="${sha256(environmentExample)}"`,
		];
		if (process.platform === "linux" && process.arch === "x64") {
			expectedPins.unshift(`EXPECTED_ARTIFACT_SHA256="${sha256(providerArtifact)}"`);
		} else {
			assert.match(installer, /EXPECTED_ARTIFACT_SHA256="[0-9a-f]{64}"/);
		}
		for (const expected of expectedPins) {
			assert.ok(installer.includes(expected), `installer is missing checksum pin ${expected}`);
		}
		for (const name of [
			"QORPERA_NATIVE_RUNTIME",
			"QORPERA_NATIVE_CODEX_FENCE_PATH",
			"QORPERA_NATIVE_CODEX_FENCE_SHA256",
			"QORPERA_NATIVE_OBJECT_GATEWAY_URL",
			"QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE",
			"QORPERA_LXD_COMPANY_NETWORK",
			"QORPERA_LXD_RECOVERY_VOLUME_PREFIX",
			"QORPERA_LXD_RECOVERY_VOLUME_SIZE",
			"QORPERA_CLOUD_SECRET_BROKER_URL",
			"QORPERA_LXD_CLOUD_SECRET_RUNTIME_TOKEN_FILE",
			"QORPERA_LXD_CLOUD_SECRET_CA_FILE",
			"QORPERA_LXD_CLOUD_SECRET_CA_SHA256",
		]) {
			assert.ok(environmentExample.includes(`${name}=`), `provider example is missing ${name}`);
		}
		assert.ok(!environmentExample.includes("QORPERA_NATIVE_OBJECT_GATEWAY_TOKEN="));
		assert.ok(!environmentExample.includes("QORPERA_CLOUD_SECRET_BROKER_TOKEN="));
		assert.ok(installer.includes("const payload = await response.json()"));
		assert.ok(installer.includes("payload.ok !== true || Object.keys(payload).length !== 1"));
		assert.ok(!installer.includes("(await response.text()) !=="));
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", installerPath], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);

		const statement = join(outputRoot, "statement.json");
		const privateKey = join(outputRoot, "private.pem");
		const publicKey = join(outputRoot, "public.pem");
		const provenance = join(outputRoot, "provenance.json");
		const keyPair = generateKeyPairSync("ed25519");
		const passphrase = "package-test-passphrase";
		await writeFile(
			privateKey,
			keyPair.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }),
		);
		await writeFile(publicKey, keyPair.publicKey.export({ type: "spki", format: "pem" }));
		const create = spawnSync(
			process.execPath,
			[
				join(outputRoot, "qorpera-lxd-image-provenance.mjs"),
				"create",
				"--image-server",
				"local",
				"--image-fingerprint",
				"a".repeat(64),
				"--base-image-fingerprint",
				"b".repeat(64),
				"--guest-package-manifest-sha256",
				"c".repeat(64),
				"--runner-image",
				`localhost/qorpera/sandbox-probe:test@sha256:${"1".repeat(64)}`,
				"--runner-image-archive-sha256",
				"2".repeat(64),
				"--runner-image-cosign-bundle-sha256",
				"3".repeat(64),
				"--source-repository",
				"https://github.com/Qorpera/Qorpera_Base.git",
				"--source-commit",
				"d".repeat(40),
				"--source-tree",
				"clean",
				"--tested-at",
				"2026-08-23T11:09:32.000Z",
				"--acceptance-evidence-sha256",
				"e".repeat(64),
				"--output",
				statement,
			],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(create.status, 0, create.stderr);
		const signed = spawnSync(
			process.execPath,
			[
				join(outputRoot, "qorpera-lxd-image-provenance.mjs"),
				"sign",
				"--statement",
				statement,
				"--private-key",
				privateKey,
				"--private-key-passphrase-stdin",
				"true",
				"--output",
				provenance,
			],
			{ cwd: repositoryRoot, encoding: "utf-8", input: `${passphrase}\n` },
		);
		assert.equal(signed.status, 0, signed.stderr);
		const verified = spawnSync(
			process.execPath,
			[
				join(outputRoot, "qorpera-lxd-image-provenance.mjs"),
				"verify",
				"--provenance",
				provenance,
				"--public-key",
				publicKey,
				"--image-server",
				"local",
				"--image-fingerprint",
				"a".repeat(64),
				"--guest-package-manifest-sha256",
				"c".repeat(64),
				"--runner-image",
				`localhost/qorpera/sandbox-probe:test@sha256:${"1".repeat(64)}`,
				"--runner-image-archive-sha256",
				"2".repeat(64),
				"--runner-image-cosign-bundle-sha256",
				"3".repeat(64),
			],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(verified.status, 0, verified.stderr);
		assert.match(verified.stdout, /LXD_IMAGE_PROVENANCE_VERIFIED/);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
