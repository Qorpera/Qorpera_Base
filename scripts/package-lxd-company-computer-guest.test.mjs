import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the complete pinned Company Computer guest contract", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-company-computer-package-test-"));
	try {
		const packaged = spawnSync(
			process.execPath,
			["scripts/package-lxd-company-computer-guest.mjs", "--out", outputRoot, "--contract-only"],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifestEncoded = await readFile(join(outputRoot, "manifest.json"), "utf-8");
		const manifest = JSON.parse(manifestEncoded);
		assert.equal(manifest.schema, "qorpera.lxd-company-computer-guest-package/v1");
		assert.equal(manifest.desktopStack, "xfce4-tigervnc");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"company-lock-heartbeat.mjs",
				"google-chrome-signing-key.asc",
				"install-image-contract.sh",
				"qorpera-chrome",
				"qorpera-chrome.desktop",
				"qorpera-files",
				"qorpera-files.desktop",
				"qorpera-terminal",
				"qorpera-terminal.desktop",
				"qorpera-company-computer-bootstrap.mjs",
				"qorpera-company-computer-bootstrap.service",
				"qorpera-company-computer-runner.mjs",
				"qorpera-company-computer-runner.service",
				"qorpera-company-computer-screens.mjs",
				"qorpera-company-computer-screens.service",
				"qorpera-screen-session",
				"xfce4-panel.xml",
				"wallpapers/pebble.svg",
				"wallpapers/folio.svg",
				"wallpapers/brain.svg",
				"wallpapers/wisp.svg",
				"wallpapers/halo.svg",
				"wallpapers/ribbon.svg",
				"wallpapers/bloom.svg",
			],
		);
		for (const artifact of manifest.artifacts) {
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
		}
		const bootstrapUnit = await readFile(
			join(outputRoot, "qorpera-company-computer-bootstrap.service"),
			"utf-8",
		);
		assert.ok(
			bootstrapUnit.includes(
				"ReadWritePaths=/var/lib/qorpera-bootstrap /var/lib/qorpera/identity /var/lib/qorpera-runner /var/lib/qorpera-native-provider /srv/qorpera/dataset",
			),
			"the bootstrap sandbox must allow writes to every prepared guest state root",
		);
		const runnerManifest = await readFile(join(outputRoot, "runner/manifest.json"));
		assert.equal(
			createHash("sha256").update(runnerManifest).digest("hex"),
			manifest.runnerPackage.manifestSha256,
		);
		assert.equal(JSON.parse(runnerManifest.toString("utf-8")).schema, "qorpera.lxd-runner-guest-package/v1");
		assert.equal((await stat(join(outputRoot, "install-image-contract.sh"))).mode & 0o111, 0o111);
		assert.equal((await stat(join(outputRoot, "qorpera-screen-session"))).mode & 0o111, 0o111);
		assert.equal((await stat(join(outputRoot, "qorpera-files"))).mode & 0o111, 0o111);
		assert.equal((await stat(join(outputRoot, "qorpera-terminal"))).mode & 0o111, 0o111);
		for (const bundle of [
			"qorpera-company-computer-bootstrap.mjs",
			"qorpera-company-computer-runner.mjs",
			"qorpera-company-computer-screens.mjs",
		]) {
			const syntax = spawnSync(process.execPath, ["--check", join(outputRoot, bundle)], { encoding: "utf-8" });
			assert.equal(syntax.status, 0, syntax.stderr);
		}
		const bootstrapBundle = await readFile(join(outputRoot, "qorpera-company-computer-bootstrap.mjs"), "utf-8");
		assert.ok(
			bootstrapBundle.includes('["start", "--no-block", service]'),
			"the bootstrap must enqueue services that are ordered after it without waiting on their jobs",
		);
		for (const serviceBundle of [
			"qorpera-company-computer-runner.mjs",
			"qorpera-company-computer-screens.mjs",
		]) {
			assert.ok(
				!(await readFile(join(outputRoot, serviceBundle), "utf-8")).includes("COMPANY_COMPUTER_BOOTSTRAP_READY"),
				`${serviceBundle} must not execute the bootstrap entrypoint`,
			);
		}
		assert.ok(
			!(await readFile(join(outputRoot, "qorpera-company-computer-runner.mjs"), "utf-8")).includes(
				"runEphemeralCloudRunnerServiceMain",
			),
			"the Company Computer runner bundle must not execute the standalone runner entrypoint",
		);

		const builderPath = join(
			repositoryRoot,
			"deploy/first-node/build-lxd-company-computer-image-candidate.sh",
		);
		const builder = await readFile(builderPath, "utf-8");
		const manifestSha256 = createHash("sha256").update(manifestEncoded).digest("hex");
		assert.ok(
			builder.includes(`EXPECTED_PACKAGE_MANIFEST_SHA256="${manifestSha256}"`),
			"the image candidate recipe must pin this exact package manifest",
		);
		const signer = await readFile(
			join(repositoryRoot, "deploy/first-node/sign-company-image-provenance.mjs"),
			"utf-8",
		);
		assert.ok(
			signer.includes(`"--guest-package-manifest-sha256", "${manifestSha256}"`),
			"the provenance signer must pin this exact package manifest",
		);
		const installerPath = join(
			repositoryRoot,
			"deploy/lxd-company-computer-guest/install-image-contract.sh",
		);
		const installer = await readFile(installerPath, "utf-8");
		assert.match(installer, /apt-get install --yes[^\n]*\btigervnc-standalone-server\b/);
		assert.match(installer, /rsvg-convert[^\n]*wallpapers\/\$\{creature\}\.svg/);
		assert.ok(installer.includes("google-chrome-stable"), "the image must install Chrome from the pinned-key repository");
		assert.ok(installer.includes('EXPECTED_PRIMARY_FINGERPRINT = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"'));
		assert.match(installer, /apt-get install --yes[^\n]*\bxfce4\b/);
		assert.ok(installer.includes('bash "${PACKAGE_ROOT}/runner/install-image-contract.sh"'));
		const wrapperPath = join(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-screen-session");
		const wrapper = await readFile(wrapperPath, "utf-8");
		assert.ok(wrapper.includes("-localhost"), "the screen session must bind its VNC socket to loopback only");
		assert.ok(
			wrapper.includes('screen_state="${screen_state_root}/screen-${ordinal}"'),
			"each display must keep its own persistent XFCE state",
		);
		assert.ok(wrapper.includes("umask 0007"), "new screen state must remain group writable");
		assert.ok(
			wrapper.includes('mkdir -p "${screen_state}"'),
			"the screen session must preserve modes on existing NAS-owned state",
		);
		assert.ok(
			!wrapper.includes('install -d -m 2770 "${screen_state}"'),
			"the screen session must not chmod existing NAS-owned state",
		);
		assert.ok(wrapper.includes("export XDG_CONFIG_HOME="), "XFCE must not share one config root across screens");
		assert.ok(wrapper.includes('cd "${company_root}"'), "desktop applications must start inside the live Company File");
		assert.ok(
			wrapper.includes("/srv/qorpera/dataset/.qorpera-computer/desktop-home"),
			"desktop state must stay outside the visible Company File",
		);
		assert.ok(wrapper.includes("/desktop-icons/style"), "the desktop contract must suppress raw XFCE icons");
		assert.ok(wrapper.includes("/desktop-menu/show"), "the desktop contract must preserve the native XFCE menu");
		assert.ok(wrapper.includes("/general/show_dock_shadow"), "the transparent dock must not retain a compositor shadow");
		assert.ok(wrapper.includes("-geometry 1920x1200"), "the desktop and viewer must share the 16:10 frame");
		assert.ok(wrapper.includes("QORPERA_SCREEN_MONITOR"), "the wallpaper must target the display's real monitor");
		const panel = await readFile(join(outputRoot, "xfce4-panel.xml"), "utf-8");
		assert.match(panel, /<property name="length" type="uint" value="1"\/>/);
		assert.doesNotMatch(panel, /<property name="length" type="double"/);
		assert.match(panel, /<property name="icon-size" type="uint" value="60"\/>/);
		assert.match(panel, /<property name="size" type="uint" value="78"\/>/);
		assert.match(panel, /<property name="background-style" type="uint" value="1"\/>/);
		assert.match(
			panel,
			/<property name="background-rgba" type="array">\s*(?:<value type="double" value="0"\/>\s*){4}<\/property>/,
		);
		assert.ok(panel.includes("qorpera-files.desktop"));
		assert.ok(panel.includes("qorpera-terminal.desktop"));
		assert.ok((await readFile(join(outputRoot, "qorpera-terminal"), "utf-8")).includes("--command=/bin/bash"));
		const screenService = await readFile(join(outputRoot, "qorpera-company-computer-screens.service"), "utf-8");
		assert.ok(screenService.includes("SupplementaryGroups=users"));
		assert.ok(screenService.includes("WorkingDirectory=/srv/qorpera/dataset/live"));
		assert.ok(screenService.includes("Environment=HOME=/srv/qorpera/dataset/.qorpera-computer/desktop-home"));
		assert.ok(screenService.includes("UMask=0007"));
		assert.ok(
			screenService.includes("NoNewPrivileges=yes"),
			"the screen service must retain its no-new-privileges boundary",
		);
		assert.ok(
			screenService.includes("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"),
			"desktop sandbox helpers need netlink while establishing their nested sandbox",
		);
		const runnerService = await readFile(join(outputRoot, "qorpera-company-computer-runner.service"), "utf-8");
		assert.ok(runnerService.includes("SupplementaryGroups=qorpera-native-execution users"));
		assert.ok(runnerService.includes("UMask=0007"));
		assert.ok(installer.includes("systemctl disable --now qorpera-company-computer-sync.service"));
		const syntax = spawnSync(
			"/usr/bin/env",
			[
				"bash",
				"-n",
				builderPath,
				installerPath,
				wrapperPath,
				join(outputRoot, "qorpera-files"),
				join(outputRoot, "qorpera-terminal"),
			],
			{
				cwd: repositoryRoot,
				encoding: "utf-8",
			},
		);
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
