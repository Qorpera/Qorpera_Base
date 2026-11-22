import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GUEST_IMAGE_SELF_UPDATE_UNITS } from "../packages/runtime/src/lxd-guest-image-updates.ts";
import {
	RUNTIME_BUNDLE_NOT_ENFORCED,
	runtimeBundleEnforced,
	runtimeBundlePackagingEnvironment,
} from "./runtime-bundle-release-train.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the complete pinned LXD runner guest contract", async (t) => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-lxd-runner-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-lxd-runner-guest.mjs", "--out", outputRoot, "--contract-only"],
			{ cwd: repositoryRoot, encoding: "utf-8", env: runtimeBundlePackagingEnvironment() },
		);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifestEncoded = await readFile(join(outputRoot, "manifest.json"), "utf-8");
		const manifest = JSON.parse(manifestEncoded);
		assert.equal(manifest.schema, "qorpera.lxd-runner-guest-package/v1");
		const claudePin = JSON.parse(
			await readFile(join(repositoryRoot, "deploy/first-node/native-claude/linux-x64-artifact.json"), "utf-8"),
		);
		assert.deepEqual(manifest.nativeHarnesses, { codex: "0.147.0", claudeCode: claudePin.source.version });
		assert.equal(manifest.runnerImage.schema, "qorpera.ephemeral-runner-image-contract/v1");
		assert.match(manifest.runnerImage.image, /@sha256:[0-9a-f]{64}$/);
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"harness/package-lock.json",
				"harness/package.json",
				"install-image-contract.sh",
				"native-claude/artifact.json",
				"qorpera-claude-box-ns.apparmor",
				"qorpera-claude-box-stage.sh",
				"qorpera-claude-home-shell.mjs",
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
				"qorpera-native-login-provider-host.service",
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
		// The Claude Code box's parts (slice C2) are the repository's own bytes; the shell prefix runs as it is packaged.
		for (const [file, source] of [
			["native-claude/artifact.json", "deploy/first-node/native-claude/linux-x64-artifact.json"],
			["qorpera-claude-box-stage.sh", "deploy/claude-box/qorpera-claude-box-stage.sh"],
			["qorpera-claude-box-ns.apparmor", "deploy/claude-box/qorpera-claude-box-ns.apparmor"],
		])
			assert.deepEqual(await readFile(join(outputRoot, file)), await readFile(join(repositoryRoot, source)), file);
		const shellCheck = spawnSync(process.execPath, ["--check", join(outputRoot, "qorpera-claude-home-shell.mjs")], {
			encoding: "utf-8",
		});
		assert.equal(shellCheck.status, 0, shellCheck.stderr);
		const ephemeralRunnerService = await readFile(
			join(outputRoot, "qorpera-ephemeral-runner.service"),
			"utf-8",
		);
		const nativeProviderService = await readFile(
			join(outputRoot, "qorpera-native-provider-host.service"),
			"utf-8",
		);
		const nativeLoginBootstrapService = await readFile(
			join(outputRoot, "qorpera-lxd-native-login-bootstrap.service"),
			"utf-8",
		);
		const nativeLoginProviderService = await readFile(
			join(outputRoot, "qorpera-native-login-provider-host.service"),
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
		// A vault login guest has no identity volume; the bootstrap checks the mount by custody.
		// A unit condition would skip it silently and the guest would never become ready.
		const runnerBootstrap = await readFile(join(outputRoot, "qorpera-lxd-runner-bootstrap.service"), "utf-8");
		assert.doesNotMatch(runnerBootstrap, /^ConditionPathIsMountPoint=/m);
		assert.match(runnerBootstrap, /^ConditionPathExists=\/var\/lib\/qorpera-bootstrap\/bootstrap\.json$/m);
		const companyHost = await readFile(join(outputRoot, "qorpera-native-company-host.service"), "utf-8");
		const companyRunner = await readFile(join(outputRoot, "qorpera-company-runner.service"), "utf-8");
		assert.match(companyHost, /^User=qorpera-native-company$/m);
		assert.match(companyHost, /^LoadCredential=qorpera-native-object-token:/m);
		assert.match(companyHost, /^LoadCredential=qorpera-office-native:\/var\/lib\/qorpera-bootstrap\/credentials\/qorpera-office-native$/m);
		assert.match(companyHost, /^LoadCredential=qorpera-coding-command:\/var\/lib\/qorpera-bootstrap\/credentials\/qorpera-coding-command$/m);
		assert.match(companyHost, /^LoadCredential=qorpera-cloud-secret-runtime:/m);
		assert.match(companyHost, /^LoadCredential=qorpera-cloud-secret-ca:/m);
		assert.match(
			companyHost,
			/^Environment=NODE_EXTRA_CA_CERTS=\/run\/credentials\/qorpera-native-company-host\.service\/qorpera-cloud-secret-ca$/m,
		);
		assert.match(companyHost, /^LoadCredential=qorpera-native-identity-epoch:/m);
		assert.match(nativeProviderService, /^LoadCredential=qorpera-native-identity-epoch:/m);
		assert.match(nativeLoginProviderService, /^LoadCredential=qorpera-identity-recovery-ca:/m);
		assert.match(
			nativeLoginProviderService,
			/^Environment=NODE_EXTRA_CA_CERTS=\/run\/credentials\/qorpera-native-login-provider-host\.service\/qorpera-identity-recovery-ca$/m,
		);
		assert.match(nativeLoginProviderService, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
		assert.doesNotMatch(nativeLoginProviderService, /\/qorpera\/company-live.*ReadWritePaths|ReadWritePaths=.*\/qorpera\/company-live/m);
		assert.match(nativeLoginBootstrapService, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
		assert.doesNotMatch(nativeLoginBootstrapService, /\bAF_NETLINK\b/);
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
		// G2-5: no guest unit is given the service key.
		const guestUnits = (await readdir(join(repositoryRoot, "deploy/lxd-runner-guest"))).filter((name) =>
			name.endsWith(".service"),
		);
		assert.ok(guestUnits.length >= 3);
		for (const name of guestUnits)
			assert.doesNotMatch(
				await readFile(join(repositoryRoot, "deploy/lxd-runner-guest", name), "utf-8"),
				/supabase-service-key|SUPABASE_SERVICE_KEY/,
				name,
			);

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
			join(repositoryRoot, "deploy/first-node/native-codex/v56-guest-package-manifest.json"),
			"utf-8",
		);
		const candidate = JSON.parse(candidateEncoded);
		const candidateSha256 = createHash("sha256").update(candidateEncoded).digest("hex");
		const source = JSON.parse(await readFile(join(repositoryRoot, "deploy/first-node/native-codex/linux-x64-direct-tools-proof.json"), "utf-8")).native.source;
		const builderPin = builder.match(/EXPECTED_PACKAGE_MANIFEST_SHA256="([0-9a-f]{64})"/)?.[1];
		const acceptancePin = acceptance.match(/EXPECTED_PACKAGE_MANIFEST_SHA256="([0-9a-f]{64})"/)?.[1];
		const builderArchivePin = builder.match(/EXPECTED_PACKAGE_ARCHIVE_SHA256="([0-9a-f]{64})"/)?.[1];
		const acceptanceArchivePin = acceptance.match(/EXPECTED_PACKAGE_ARCHIVE_SHA256="([0-9a-f]{64})"/)?.[1];
		const builderSourceCommit = builder.match(/EXPECTED_SOURCE_COMMIT="([0-9a-f]{40})"/)?.[1];
		const acceptanceSourceCommit = acceptance.match(/EXPECTED_SOURCE_COMMIT="([0-9a-f]{40})"/)?.[1];
		assert.ok(builderPin, "image candidate builder must pin a package manifest");
		assert.equal(acceptancePin, builderPin, "image candidate recipes must pin the same package manifest");
		assert.match(builderArchivePin ?? "", /^[0-9a-f]{64}$/);
		assert.equal(acceptanceArchivePin, builderArchivePin, "image candidate recipes must pin the same package archive");
		assert.match(builderSourceCommit ?? "", /^[0-9a-f]{40}$/);
		assert.equal(acceptanceSourceCommit, builderSourceCommit, "image candidate recipes must pin the same source commit");
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
		assert.ok(acceptance.includes(`EXPECTED_NATIVE_PROVIDER_HOST_SHA256="${candidate.artifacts.find((item) => item.file === "qorpera-native-provider-host.mjs").sha256}"`));
		assert.ok(acceptance.includes(`EXPECTED_NATIVE_COMPANY_SERVICE_SHA256="${candidate.artifacts.find((item) => item.file === "qorpera-native-company-host.service").sha256}"`));
		assert.ok(acceptance.includes(`EXPECTED_RUNNER_BOOTSTRAP_SHA256="${candidate.artifacts.find((item) => item.file === "qorpera-lxd-runner-bootstrap.mjs").sha256}"`));
		// These recipes are the frozen v56 release, whose original manifest is
		// retained by its archive hash. Current runtime bytes have their own pin.
		// A release branch re-pins it; feature branches leave it at the last
		// release (deploy/first-node/RUNTIME-RELEASE-TRAIN.md).
		if (runtimeBundleEnforced()) {
			const currentCandidate = JSON.parse(await readFile(
				join(repositoryRoot, "deploy/first-node/native-codex/guest-package-manifest.json"), "utf-8",
			));
			const currentArtifact = JSON.parse(await readFile(join(repositoryRoot, "deploy/first-node/native-codex/linux-x64-artifact.json"), "utf-8"));
			assert.equal(currentCandidate.nativeCompany.binarySha256, currentArtifact.artifact.sha256);
			assert.equal(currentCandidate.nativeCompany.sourceCommit, currentArtifact.source.commit);
			assert.equal(currentCandidate.nativeCompany.patchSha256, currentArtifact.source.patchSha256);
			if (process.platform === "linux" && process.arch === "x64") {
				const { nativeCompany: _nativeCompany, ...withoutNative } = currentCandidate;
				withoutNative.artifacts = currentCandidate.artifacts.filter((item) => !item.file.startsWith("native-company/"));
				assert.deepEqual(
					withoutNative,
					manifest,
					"governed candidate must include every current Linux x64 runtime artifact without stale or omitted bundles",
				);
			}
		} else {
			t.diagnostic(`current guest pin not compared with its source: ${RUNTIME_BUNDLE_NOT_ENFORCED}`);
		}
		assert.ok(builder.includes("--no-same-owner"));
		assert.match(installer, /apt-get install --yes[^\n]*\bcrun\b/);
		assert.match(installer, /apt-get install --yes[^\n]*\bbubblewrap\b/);
		// One Claude Code on the image: the pinned unmodified build, never the harness packages' (2.1.231 leaked the
		// sign-in in the box's set-up; nothing older than 2.1.311 stays).
		assert.match(installer, /apt-get install --yes[^\n]*\bsshfs\b/);
		const harness = JSON.parse(await readFile(join(repositoryRoot, "deploy/lxd-runner-guest/harness/package.json"), "utf-8"));
		assert.deepEqual(Object.keys(harness.dependencies), ["@openai/codex"]);
		assert.doesNotMatch(
			await readFile(join(repositoryRoot, "deploy/lxd-runner-guest/harness/package-lock.json"), "utf-8"),
			/anthropic/,
		);
		assert.doesNotMatch(installer, /node_modules\/@anthropic-ai\/claude-code/);
		assert.ok(installer.includes('ln -sfn "${CLAUDE_DIR}/claude" /usr/local/bin/claude'));
		assert.ok(installer.includes("CLAUDE_DIR=/opt/qorpera-harnesses/native-claude"));
		assert.ok(installer.includes("`sha512-${digest.digest(\"base64\")}` !== pin.source.integrity"));
		assert.ok(installer.includes('install -o root -g "${CLAUDE_BOX_GROUP}" -m 0750 /usr/bin/unshare /opt/qorpera-runner/qorpera-claude-box-ns'));
		assert.ok(installer.includes("/etc/apparmor.d/qorpera-claude-box-ns"));
		assert.ok(installer.includes('grep -Fxq "qorpera-claude-box-ns (unconfined)" /sys/kernel/security/apparmor/profiles'));
		// The runtime's paths are the image's.
		const box = await readFile(join(repositoryRoot, "packages/runtime/src/cloud-claude-box.ts"), "utf-8");
		for (const path of [
			"/opt/qorpera-harnesses/native-claude/claude",
			"/opt/qorpera-runner/qorpera-claude-home-shell.mjs",
			"/opt/qorpera-runner/qorpera-claude-box-stage.sh",
			"/opt/qorpera-runner/qorpera-claude-box-ns",
			"/usr/bin/sshfs",
		])
			assert.ok(box.includes(`"${path}"`), path);
		assert.ok(
			(await readFile(join(repositoryRoot, "deploy/claude-box/qorpera-claude-box-ns.apparmor"), "utf-8")).includes(
				"profile qorpera-claude-box-ns /opt/qorpera-runner/qorpera-claude-box-ns flags=(unconfined) {",
			),
		);
		// The box's checks come after everything they check is installed, and before the image says it is done.
		const boxChecks = installer.indexOf("claude_box_refuse() {");
		assert.ok(boxChecks > installer.indexOf("apparmor_parser --replace --write-cache /etc/apparmor.d/qorpera-claude-box-ns"));
		assert.ok(boxChecks < installer.indexOf("LXD_RUNNER_IMAGE_CONTRACT_INSTALLED"));
		assert.ok(installer.includes("/usr/bin/podman info >/dev/null"));
		// The published image never updates itself (run d1f454e2, 2026-09-24): the
		// units the guest bootstraps check are masked before anything is installed,
		// with no apt job left running, and proven masked at the end.
		assert.ok(installer.includes(`SELF_UPDATE_UNITS=(${GUEST_IMAGE_SELF_UPDATE_UNITS.join(" ")})`));
		const masking = installer.indexOf('systemctl mask "${SELF_UPDATE_UNITS[@]}"');
		assert.ok(masking > 0 && masking < installer.indexOf("apt-get update"));
		assert.ok(installer.indexOf("systemctl show --property=ActiveState --value") > masking);
		const proof = installer.indexOf('[[ $(readlink "/etc/systemd/system/${unit}") != /dev/null ]]');
		assert.ok(proof > installer.indexOf("systemctl enable qorpera-lxd-runner-bootstrap.service"));
		assert.ok(installer.includes('[[ $(systemctl is-enabled "${unit}" 2>/dev/null) != masked ]]'));
		assert.ok(proof < installer.indexOf("LXD_RUNNER_IMAGE_CONTRACT_INSTALLED"));
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

test("qorpera-claude-box-stage bounds sshfs teardown with SIGKILL and preserves the box exit code", async () => {
	const work = await mkdtemp(join(tmpdir(), "qorpera-claude-box-stage-test-"));
	let sshfsPid = 0;
	try {
		const bin = join(work, "bin");
		const mnt = join(work, "mnt");
		const pidFile = join(work, "sshfs.pid");
		await mkdir(bin);
		await mkdir(mnt);
		await writeFile(join(bin, "mountpoint"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(bin, "umount"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(
			join(bin, "setpriv"),
			'#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$1" = "--" ] && shift\nexec "$@"\n',
			{ mode: 0o755 },
		);
		const stubSshfs = join(bin, "stub-sshfs");
		await writeFile(
			stubSshfs,
			`#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 1; done\n`,
			{ mode: 0o755 },
		);
		const started = Date.now();
		const stagePath = join(repositoryRoot, "deploy/claude-box/qorpera-claude-box-stage.sh");
		const run = spawnSync(
			"/bin/bash",
			[
				"-c",
				'exec 4</dev/null 5>/dev/null; exec /bin/bash "$1" "$2" "$3" passive -- /bin/sh -c \'while [ ! -s "$1" ]; do sleep 0.01; done; exit 7\' _ "$4"',
				"_",
				stagePath,
				mnt,
				stubSshfs,
				pidFile,
			],
			{
				cwd: work,
				encoding: "utf-8",
				timeout: 6000,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			},
		);
		const elapsed = Date.now() - started;
		assert.equal(run.status, 7, run.stderr);
		assert.ok(elapsed < 4500, `expected bounded sshfs teardown, took ${elapsed}ms`);
		sshfsPid = Number((await readFile(pidFile, "utf-8")).trim());
		assert.ok(Number.isInteger(sshfsPid) && sshfsPid > 0);
		assert.throws(() => process.kill(sshfsPid, 0), { code: "ESRCH" });
	} finally {
		if (sshfsPid > 0) {
			try {
				process.kill(sshfsPid, "SIGKILL");
			} catch {}
		}
		await rm(work, { recursive: true, force: true });
	}
});
