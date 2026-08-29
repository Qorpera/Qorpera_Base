import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the complete pinned LXD runner guest contract", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-lxd-runner-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-lxd-runner-guest.mjs", "--out", outputRoot, "--contract-only"],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifestEncoded = await readFile(join(outputRoot, "manifest.json"), "utf-8");
		const manifest = JSON.parse(manifestEncoded);
		assert.equal(manifest.schema, "qorpera.lxd-runner-guest-package/v1");
		assert.deepEqual(manifest.nativeHarnesses, { codex: "0.147.0", claudeCode: "2.1.231" });
		assert.equal(manifest.runnerImage.schema, "qorpera.ephemeral-runner-image-contract/v1");
		assert.match(manifest.runnerImage.image, /@sha256:[0-9a-f]{64}$/);
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"company-lock-heartbeat.mjs",
				"harness/package-lock.json",
				"harness/package.json",
				"install-image-contract.sh",
				"qorpera-company-runner.service",
				"qorpera-ephemeral-runner.mjs",
				"qorpera-ephemeral-runner.service",
				"qorpera-identity-recovery-restore.mjs",
				"qorpera-lxd-native-login-bootstrap.mjs",
				"qorpera-lxd-native-login-bootstrap.service",
				"qorpera-lxd-runner-bootstrap.mjs",
				"qorpera-lxd-runner-bootstrap.service",
				"qorpera-native-company-host.service",
				"qorpera-native-isolation-child.mjs",
				"qorpera-native-provider-host.mjs",
				"qorpera-native-provider-host.service",
				"qorpera-sandbox-probe.mjs",
				"run-job",
				"runner-image/contract.json",
				"runner-image/qorpera-sandbox-probe.cosign-bundle.json",
				"runner-image/qorpera-sandbox-probe.oci.tar",
			],
		);
		for (const artifact of manifest.artifacts) {
			if (artifact.file === manifest.runnerImage.archive.file || artifact.file === manifest.runnerImage.cosign_bundle.file) {
				continue;
			}
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
		}
		assert.equal((await stat(join(outputRoot, "install-image-contract.sh"))).mode & 0o111, 0o111);
		const ephemeralRunnerService = await readFile(
			join(outputRoot, "qorpera-ephemeral-runner.service"),
			"utf-8",
		);
		const nativeProviderService = await readFile(
			join(outputRoot, "qorpera-native-provider-host.service"),
			"utf-8",
		);
		assert.match(
			ephemeralRunnerService,
			/^ReadWritePaths=.*(?:^|\s)-\/qorpera\/company-live(?:\s|$)/m,
			"ProtectSystem=strict must leave the optional live Company File writable for the runner",
		);
		assert.match(
			nativeProviderService,
			/^ReadWritePaths=.*(?:^|\s)-\/qorpera\/company-live(?:\s|$)/m,
			"ProtectSystem=strict must leave the optional live Company File writable for the native harness",
		);
		for (const [serviceName, service] of [
			["ephemeral runner", ephemeralRunnerService],
			["native provider", nativeProviderService],
		]) {
			assert.match(
				service,
				/^SupplementaryGroups=.*\busers\b.*$/m,
				`${serviceName} must join the NAS-mapped sharing group`,
			);
			assert.match(service, /^UMask=0007$/m, `${serviceName} must preserve group access to shared files`);
		}
		for (const name of ["qorpera-native-company-host.service", "qorpera-company-runner.service"]) {
			const service = await readFile(join(outputRoot, name), "utf-8");
			assert.match(service, /^UMask=0077$/m);
			assert.match(service, /^NoNewPrivileges=yes$/m);
			assert.match(service, /^ProtectControlGroups=yes$/m);
			assert.match(service, /^InaccessiblePaths=.*\/qorpera\/company-live/m);
			assert.doesNotMatch(service, /^ReadWritePaths=.*\/qorpera\/company-live/m);
			assert.doesNotMatch(service, /^SupplementaryGroups=/m);
			assert.doesNotMatch(service, /safe\.directory/);
		}
		const companyHost = await readFile(join(outputRoot, "qorpera-native-company-host.service"), "utf-8");
		const companyRunner = await readFile(join(outputRoot, "qorpera-company-runner.service"), "utf-8");
		assert.match(companyHost, /^User=qorpera-native-company$/m);
		assert.match(companyHost, /^LoadCredential=qorpera-native-object-token:/m);
		assert.match(companyHost, /^LoadCredential=qorpera-cloud-secret-runtime:/m);
		assert.match(companyHost, /^LoadCredential=qorpera-cloud-secret-ca:/m);
		assert.match(
			companyHost,
			/^Environment=NODE_EXTRA_CA_CERTS=\/run\/credentials\/qorpera-native-company-host\.service\/qorpera-cloud-secret-ca$/m,
		);
		assert.match(companyHost, /^LoadCredential=qorpera-native-identity-epoch:/m);
		assert.match(nativeProviderService, /^LoadCredential=qorpera-native-identity-epoch:/m);
		assert.ok(!manifest.artifacts.some((artifact) => artifact.file === "qorpera-identity-recovery-service.mjs"));
		assert.match(companyHost, /^RestrictNamespaces=user mnt pid net ipc uts cgroup$/m);
		assert.match(companyHost, /^ProcSubset=all$/m);
		assert.match(companyHost, /^ProtectProc=invisible$/m);
		assert.match(companyHost, /^ProtectHostname=private$/m);
		assert.match(companyHost, /^ProtectKernelTunables=no$/m);
		assert.match(companyHost, /^ProtectKernelLogs=no$/m);
		assert.match(companyHost, /^CapabilityBoundingSet=$/m);
		assert.match(companyHost, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK$/m);
		assert.match(companyHost, /^MemoryMax=2G$/m);
		assert.match(companyHost, /^TasksMax=256$/m);
		assert.match(companyHost, /^CPUQuota=200%$/m);
		assert.match(companyRunner, /^User=qorpera-company-runner$/m);
		assert.match(companyRunner, /^AssertPathIsMountPoint=\/var\/lib\/qorpera-runner$/m);
		assert.doesNotMatch(companyRunner, /LoadCredential=qorpera-(?:supabase-service-key|native-object-token)/);

		const builderPath = join(repositoryRoot, "deploy/first-node/build-lxd-runner-image-candidate.sh");
		const builder = await readFile(builderPath, "utf-8");
		const acceptancePath = join(
			repositoryRoot,
			"deploy/first-node/verify-lxd-runner-image-candidate.sh",
		);
		const acceptance = await readFile(acceptancePath, "utf-8");
		const installer = await readFile(
			join(repositoryRoot, "deploy/lxd-runner-guest/install-image-contract.sh"),
			"utf-8",
		);
		const candidateEncoded = await readFile(
			join(repositoryRoot, "deploy/first-node/native-codex/guest-package-manifest.json"),
			"utf-8",
		);
		const candidate = JSON.parse(candidateEncoded);
		const candidateSha256 = createHash("sha256").update(candidateEncoded).digest("hex");
		const source = JSON.parse(await readFile(join(repositoryRoot, "deploy/first-node/native-codex/source.json"), "utf-8"));
		const builderPin = builder.match(/EXPECTED_PACKAGE_MANIFEST_SHA256="([0-9a-f]{64})"/)?.[1];
		const acceptancePin = acceptance.match(/EXPECTED_PACKAGE_MANIFEST_SHA256="([0-9a-f]{64})"/)?.[1];
		assert.ok(builderPin, "image candidate builder must pin a package manifest");
		assert.equal(acceptancePin, builderPin, "image candidate recipes must pin the same package manifest");
		assert.equal(builderPin, candidateSha256, "candidate recipes must pin the full governed guest manifest");
		assert.equal(candidate.nativeCompany.schema, "qorpera.native-company-guest/v1");
		assert.equal(candidate.nativeCompany.sourceCommit, source.commit);
		assert.equal(candidate.nativeCompany.patchSha256, source.patchSha256);
		assert.equal(candidate.nativeCompany.profile, "release");
		assert.equal(candidate.nativeCompany.target, "x86_64-unknown-linux-gnu");
		assert.deepEqual(candidate.artifacts.filter((item) => item.file.startsWith("native-company/")).map((item) => item.file), [
			"native-company/artifact.json", "native-company/codex", "native-company/LICENSE", "native-company/NOTICE",
		]);
		assert.equal(candidate.artifacts.find((item) => item.file === "native-company/codex").sha256, candidate.nativeCompany.binarySha256);
		assert.ok(acceptance.includes(`EXPECTED_NATIVE_CODEX_SHA256="${candidate.nativeCompany.binarySha256}"`));
		assert.ok(acceptance.includes(`EXPECTED_NATIVE_HELPER_SHA256="${candidate.artifacts.find((item) => item.file === "qorpera-native-isolation-child.mjs").sha256}"`));
		if (process.platform === "linux" && process.arch === "x64") {
			const { nativeCompany: _nativeCompany, ...withoutNative } = candidate;
			withoutNative.artifacts = candidate.artifacts.filter((item) => !item.file.startsWith("native-company/"));
			assert.deepEqual(
				withoutNative,
				manifest,
				"governed candidate must include every current Linux x64 runtime artifact without stale or omitted bundles",
			);
		}
		assert.ok(builder.includes('LXD_BUILDER_PROJECT="default"'));
		assert.match(installer, /apt-get install --yes[^\n]*\bcrun\b/);
		assert.match(installer, /apt-get install --yes[^\n]*\bbubblewrap\b/);
		assert.ok(installer.includes("/usr/bin/podman info >/dev/null"));
		assert.ok(acceptance.includes("install -d -o qorpera-runner -g qorpera-runner -m 0700 /run/qorpera-runner"));
		assert.ok(acceptance.includes("XDG_RUNTIME_DIR=/run/qorpera-runner"));
		assert.ok(!acceptance.includes("XDG_RUNTIME_DIR=/var/lib/qorpera-runner/tmp"));
		assert.ok(acceptance.includes("! mountpoint -q /var/lib/qorpera/identity"));
		assert.ok(acceptance.includes("qorpera-company-runner.service qorpera-native-company-host.service"));
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", builderPath, acceptancePath], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
