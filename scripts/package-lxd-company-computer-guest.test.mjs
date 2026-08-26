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
				"install-image-contract.sh",
				"qorpera-company-computer-bootstrap.mjs",
				"qorpera-company-computer-bootstrap.service",
				"qorpera-company-computer-runner.mjs",
				"qorpera-company-computer-runner.service",
				"qorpera-company-computer-screens.mjs",
				"qorpera-company-computer-screens.service",
				"qorpera-company-computer-sync.mjs",
				"qorpera-company-computer-sync.service",
				"qorpera-screen-session",
				"qorpera-screen-wallpaper.svg",
			],
		);
		for (const artifact of manifest.artifacts) {
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(content).digest("hex"), artifact.sha256);
		}
		const runnerManifest = await readFile(join(outputRoot, "runner/manifest.json"));
		assert.equal(
			createHash("sha256").update(runnerManifest).digest("hex"),
			manifest.runnerPackage.manifestSha256,
		);
		assert.equal(JSON.parse(runnerManifest.toString("utf-8")).schema, "qorpera.lxd-runner-guest-package/v1");
		assert.equal((await stat(join(outputRoot, "install-image-contract.sh"))).mode & 0o111, 0o111);
		assert.equal((await stat(join(outputRoot, "qorpera-screen-session"))).mode & 0o111, 0o111);
		for (const bundle of [
			"qorpera-company-computer-bootstrap.mjs",
			"qorpera-company-computer-runner.mjs",
			"qorpera-company-computer-sync.mjs",
			"qorpera-company-computer-screens.mjs",
		]) {
			const syntax = spawnSync(process.execPath, ["--check", join(outputRoot, bundle)], { encoding: "utf-8" });
			assert.equal(syntax.status, 0, syntax.stderr);
		}

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
		const installerPath = join(
			repositoryRoot,
			"deploy/lxd-company-computer-guest/install-image-contract.sh",
		);
		const installer = await readFile(installerPath, "utf-8");
		assert.match(installer, /apt-get install --yes[^\n]*\btigervnc-standalone-server\b/);
		assert.match(installer, /rsvg-convert[^\n]*qorpera-screen-wallpaper\.svg/);
		assert.match(installer, /apt-get install --yes[^\n]*\bxfce4\b/);
		assert.ok(installer.includes('bash "${PACKAGE_ROOT}/runner/install-image-contract.sh"'));
		const wrapperPath = join(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-screen-session");
		const wrapper = await readFile(wrapperPath, "utf-8");
		assert.ok(wrapper.includes("-localhost"), "the screen session must bind its VNC socket to loopback only");
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", builderPath, installerPath, wrapperPath], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
	}
});
