import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/** Enough of an x86-64 ELF header for the packager's check (the real program is built in the pinned Rust image). */
function fakeFolderProgram() {
	const bytes = Buffer.alloc(64);
	bytes.write("\x7fELF", 0, "latin1");
	bytes.writeUInt16LE(62, 18);
	return bytes;
}

test("packages and pins the shared execution service", async () => {
	const outputRoot = await mkdtemp(join(tmpdir(), "qorpera-shared-execution-package-"));
	const inputs = await mkdtemp(join(tmpdir(), "qorpera-shared-execution-inputs-"));
	try {
		const folderProgram = join(inputs, "qorpera-folder");
		await writeFile(folderProgram, fakeFolderProgram());
		const script = join(repositoryRoot, "scripts/package-shared-execution-service.mjs");
		const withoutProgram = spawnSync(process.execPath, [script, "--out", outputRoot], { cwd: repositoryRoot, encoding: "utf-8" });
		assert.notEqual(withoutProgram.status, 0, "the folder program is required");
		await writeFile(join(inputs, "not-elf"), "#!/bin/sh\n");
		const notElf = spawnSync(process.execPath, [script, "--out", outputRoot, "--folder-program", join(inputs, "not-elf")], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.notEqual(notElf.status, 0, "only an x86-64 Linux build is packaged");
		const packaged = spawnSync(process.execPath, [script, "--out", outputRoot, "--folder-program", folderProgram], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifest = JSON.parse(await readFile(join(outputRoot, "manifest.json"), "utf-8"));
		assert.equal(manifest.schema, "qorpera.shared-execution-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"install-shared-execution-guest.sh",
				"qorpera-runner-orchestrator.mjs",
				"qorpera-runner-orchestrator.service",
				"qorpera-shared-execution-service.mjs",
				"qorpera-shared-execution.service",
				"qorpera-shared-run-host@.service",
				"qorpera-shared-runner@.service",
				"qorpera-folder",
				"qorpera-folder-mount@.service",
				"shared-execution.env.example",
			].sort((a, b) => a.localeCompare(b, "en")),
		);
		assert.equal((await stat(join(outputRoot, "qorpera-folder"))).mode & 0o777, 0o755);
		const contents = new Map();
		for (const artifact of manifest.artifacts) {
			const content = await readFile(join(outputRoot, artifact.file));
			assert.equal(content.byteLength, artifact.bytes);
			assert.equal(sha256(content), artifact.sha256);
			contents.set(artifact.file, content);
		}
		const service = contents.get("qorpera-shared-execution-service.mjs").toString("utf-8");
		assert.ok(service.includes("qorpera.shared-execution-journal/v1"));
		assert.ok(service.includes("qorpera_reserve_runtime_machine"));
		assert.ok(!service.includes("import { spawn }"), "the service must be a single bundled artifact");
		for (const file of ["qorpera-shared-execution-service.mjs", "qorpera-runner-orchestrator.mjs"]) {
			const checked = spawnSync(process.execPath, ["--check", join(outputRoot, file)], { encoding: "utf-8" });
			assert.equal(checked.status, 0, checked.stderr);
		}
		const hostUnit = contents.get("qorpera-shared-run-host@.service").toString("utf-8");
		const runnerUnit = contents.get("qorpera-shared-runner@.service").toString("utf-8");
		assert.match(hostUnit, /^User=qorpera-shared-host-%i$/m);
		assert.match(hostUnit, /^LoadCredential=qorpera-native-provider-master-key:\/run\/qorpera-shared-execution\/slots\/%i\/credentials\/qorpera-native-provider-master-key$/m);
		assert.match(hostUnit, /^InaccessiblePaths=\/var\/lib\/qorpera\/identities /m);
		assert.match(hostUnit, /^RestrictNamespaces=user mnt pid net ipc uts cgroup$/m);
		assert.match(hostUnit, /^Restart=no$/m);
		assert.match(runnerUnit, /^User=qorpera-shared-runner-%i$/m);
		assert.match(runnerUnit, /^BindsTo=qorpera-shared-run-host@%i\.service$/m);
		assert.match(
			runnerUnit,
			/^Environment=QORPERA_RUNNER_CONFIG=\/var\/lib\/qorpera-shared-execution\/slots\/%i\/runner\/config\.json$/m,
		);
		assert.ok(!runnerUnit.includes("qorpera-runner-config"), "the runner configuration is not a credential");
		assert.match(runnerUnit, /^RestrictNamespaces=yes$/m);
		assert.ok(!runnerUnit.includes("poweroff"), "a sandbox runner must not power the execution host off");
		// The folder (F3) is root's: neither slot unit can see the mounts or the view files with their passes.
		for (const unit of [hostUnit, runnerUnit])
			assert.match(unit, /^InaccessiblePaths=.* \/srv\/qorpera-folder \/etc\/qorpera-folder /m);
		const installer = contents.get("install-shared-execution-guest.sh").toString("utf-8");
		const expectedPins = [
			`EXPECTED_SERVICE_UNIT_SHA256="${sha256(contents.get("qorpera-shared-execution.service"))}"`,
			`EXPECTED_HOST_UNIT_SHA256="${sha256(contents.get("qorpera-shared-run-host@.service"))}"`,
			`EXPECTED_RUNNER_UNIT_SHA256="${sha256(contents.get("qorpera-shared-runner@.service"))}"`,
			`EXPECTED_ENV_EXAMPLE_SHA256="${sha256(contents.get("shared-execution.env.example"))}"`,
			`EXPECTED_ORCHESTRATOR_UNIT_SHA256="${sha256(contents.get("qorpera-runner-orchestrator.service"))}"`,
			`EXPECTED_FOLDER_MOUNT_UNIT_SHA256="${sha256(contents.get("qorpera-folder-mount@.service"))}"`,
		];
		if (process.platform === "linux" && process.arch === "x64") {
			expectedPins.push(
				`EXPECTED_SERVICE_SHA256="${sha256(contents.get("qorpera-shared-execution-service.mjs"))}"`,
				`EXPECTED_ORCHESTRATOR_SHA256="${sha256(contents.get("qorpera-runner-orchestrator.mjs"))}"`,
			);
		} else {
			assert.match(installer, /EXPECTED_SERVICE_SHA256="[0-9a-f]{64}"/);
			assert.match(installer, /EXPECTED_ORCHESTRATOR_SHA256="[0-9a-f]{64}"/);
		}
		for (const expected of expectedPins) {
			assert.ok(installer.includes(expected), `installer is missing checksum pin ${expected}`);
		}
		assert.ok(installer.includes("useradd --system --no-create-home"));
		assert.ok(installer.includes("Nothing starts here"));
		assert.ok(installer.includes('verify_sha256 "${STAGING_ROOT}/qorpera-folder" "${EXPECTED_FOLDER_PROGRAM_SHA256}"'));
		assert.ok(!/systemctl (enable|start)[^\n]*qorpera-folder-mount/.test(installer), "no mount starts at install");
		const syntax = spawnSync("/usr/bin/env", ["bash", "-n", join(outputRoot, "install-shared-execution-guest.sh")], {
			encoding: "utf-8",
		});
		assert.equal(syntax.status, 0, syntax.stderr);
	} finally {
		await rm(outputRoot, { recursive: true, force: true });
		await rm(inputs, { recursive: true, force: true });
	}
});

test("a rebuild refuses a folder program other than the pinned build before anything stops", async () => {
	const rebuild = await readFile(join(repositoryRoot, "deploy/shared-execution/rebuild-exec-host.sh"), "utf-8");
	const check = rebuild.indexOf("is not the folder program the installer pins");
	assert.ok(check > 0);
	assert.ok(check < rebuild.indexOf("if [[ -n ${EXEC_PREFLIGHT_ONLY:-} ]]"), "checked with the other inputs, in a preflight too");
	assert.ok(check < rebuild.indexOf("systemctl disable --now qorpera-runner-orchestrator.service"));
});
