import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMPANY_COMPUTER_WALLPAPER_FILES } from "../packages/runtime/src/cloud-company-computer-wallpapers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("packages and starts the headless office outside the workspace, with all runtime resources", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-package-"));
	try {
		const output = join(temporary, "package");
		const run = () => spawnSync(process.execPath, ["scripts/package-company-computer.mjs", "--out", output], { cwd: root, timeout: 60000, encoding: "utf8" });
		const built = run(); assert.equal(built.status, 0, built.stderr);
		const encoded = await readFile(join(output, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(manifest.schema, "qorpera.company-computer-package/v1");
		assert.equal(manifest.playwright, "1.62.1");
		for (const file of ["qorpera-office-image-install.cjs", "qorpera-office-runtime.conf", "qorpera-office-private.mount.in"]) assert.ok(manifest.artifacts.some(artifact => artifact.file === file), file);
		const imageInstaller = spawnSync(process.execPath, [join(output, "qorpera-office-image-install.cjs"), "--unexpected"], {cwd: temporary, encoding: "utf8", timeout: 10000});
		assert.equal(imageInstaller.status, 2); assert.equal(imageInstaller.stderr, "OFFICE_IMAGE_ARGUMENTS_INVALID\n");
		assert.ok(manifest.artifacts.length > 100);
		assert.deepEqual(manifest.artifacts.filter((artifact) => artifact.file.startsWith("wallpapers/")).map((artifact) => artifact.file).sort(), COMPANY_COMPUTER_WALLPAPER_FILES.map((file) => `wallpapers/${file}`));
		for (const file of ["qorpera-office-preparation.conf", "qorpera-company-computer-preparation-control.mjs", "qorpera-company-computer-preparation.mjs", "qorpera-company-computer-preparation.service", "office-browser-child.mjs", "qorpera-screen-session", "qorpera-screen-xfce", "wallpapers/qorpera-screen-pebble.png", "node_modules/playwright-core/index.mjs", "node_modules/playwright-core/browsers.json", "LICENSE"]) {
			assert.ok(manifest.artifacts.some((artifact) => artifact.file === file), file);
		}
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(output, artifact.file));
			assert.equal(bytes.length, artifact.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
		}
		const executable = join(output, "qorpera-company-computer-service.mjs");
		for (const script of [executable, join(output, "office-browser-child.mjs"), join(output, "qorpera-company-computer-preparation.mjs"), join(output, "qorpera-company-computer-preparation-control.mjs")]) {
			const syntax = spawnSync(process.execPath, ["--check", script], { cwd: temporary, encoding: "utf8" });
			assert.equal(syntax.status, 0, syntax.stderr);
		}
		const env = { PATH: process.env.PATH, HOME: temporary };
		const help = spawnSync(process.execPath, [executable, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Headless shared office/);
		for (const args of [[], ["--config", "secret-that-must-not-leak"]]) {
			const failed = spawnSync(process.execPath, [executable, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1, failed.stderr); assert.doesNotMatch(failed.stderr, /secret-that-must-not-leak|Error:|node_modules/);
		}
		const unit = await readFile(join(output, "qorpera-company-computer.service"), "utf8");
		for (const line of ["User=qorpera-office", "KillMode=mixed", "SendSIGKILL=yes", "TimeoutStopSec=70", "MemoryMax=4G", "TasksMax=512", "CPUQuota=200%", "NoNewPrivileges=yes", "CapabilityBoundingSet=", "LimitCORE=0"])
			assert.ok(unit.split("\n").includes(line), line);
		assert.equal(unit.match(/^LoadCredential=.*:\/etc\/qorpera-office\/boots\/%b\/credentials\//gm).length, 6);
		const preparation = join(output, "qorpera-company-computer-preparation.mjs");
		const prepHelp = spawnSync(process.execPath, [preparation, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(prepHelp.status, 0, prepHelp.stderr); assert.match(prepHelp.stdout, /Read-only office guest preparation/);
		const prepFailed = spawnSync(process.execPath, [preparation, "--config", "must-not-leak"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(prepFailed.status, 1); assert.doesNotMatch(prepFailed.stderr, /must-not-leak|Error:|node_modules/);
		const control = join(output, "qorpera-company-computer-preparation-control.mjs");
		const controlHelp = spawnSync(process.execPath, [control, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(controlHelp.status, 0, controlHelp.stderr); assert.match(controlHelp.stdout, /Protected office preparation control/);
		const controlFailed = spawnSync(process.execPath, [control, "--config", "must-not-leak"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(controlFailed.status, 1); assert.doesNotMatch(controlFailed.stderr, /must-not-leak|Error:|node_modules/);
		const configuration = join(output, "qorpera-company-computer-configuration-control.mjs");
		assert.ok(manifest.artifacts.some(artifact => artifact.file === "qorpera-company-computer-configuration-control.mjs"));
		const configurationHelp = spawnSync(process.execPath, [configuration, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(configurationHelp.status, 0, configurationHelp.stderr); assert.match(configurationHelp.stdout, /Protected office configuration installation/);
		for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
			const failed = spawnSync(process.execPath, [configuration, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
		}
		const prepUnit = await readFile(join(output, "qorpera-company-computer-preparation.service"), "utf8");
		const bootConfiguration = join(output, "qorpera-company-computer-boot-configuration-control.mjs");
        for (const helper of ["termination", "configuration", "service-start"]) {
            const file = `qorpera-company-computer-outage-${helper}-control.mjs`;
            const executable = join(output, file);
            assert.ok(manifest.artifacts.some(artifact => artifact.file === file));
            const help = spawnSync(process.execPath, [executable, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
            assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Protected/);
            for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
                const failed = spawnSync(process.execPath, [executable, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
                assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
            }
        }
		assert.ok(manifest.artifacts.some(artifact => artifact.file === "qorpera-company-computer-boot-configuration-control.mjs"));
		const bootHelp = spawnSync(process.execPath, [bootConfiguration, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(bootHelp.status, 0, bootHelp.stderr); assert.match(bootHelp.stdout, /Protected/);
		for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
			const failed = spawnSync(process.execPath, [bootConfiguration, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
		}
		const serviceStop=join(output,"qorpera-company-computer-service-stop-control.mjs");
		assert.ok(manifest.artifacts.some(artifact=>artifact.file==="qorpera-company-computer-service-stop-control.mjs"));
		const stopHelp=spawnSync(process.execPath,[serviceStop,"--help"],{cwd:temporary,env,encoding:"utf8",timeout:10000});
		assert.equal(stopHelp.status,0,stopHelp.stderr);assert.match(stopHelp.stdout,/Protected office stop/);
		for(const args of [[],["--config","must-not-leak"],["--locked","must-not-leak","x","y"]]){
			const failed=spawnSync(process.execPath,[serviceStop,...args],{cwd:temporary,env,encoding:"utf8",timeout:10000});
			assert.equal(failed.status,1);assert.doesNotMatch(failed.stderr,/must-not-leak|Error:|node_modules/);
		}
		const serviceStart = join(output, "qorpera-company-computer-service-start-control.mjs");
		const bootServiceStart = join(output, "qorpera-company-computer-boot-service-start-control.mjs");
		assert.ok(manifest.artifacts.some(artifact => artifact.file === "qorpera-company-computer-boot-service-start-control.mjs"));
		const bootStartHelp = spawnSync(process.execPath, [bootServiceStart, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(bootStartHelp.status, 0, bootStartHelp.stderr); assert.match(bootStartHelp.stdout, /Protected retained-boot/);
		for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
			const failed = spawnSync(process.execPath, [bootServiceStart, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
		}
		const bootServiceRestart = join(output, "qorpera-company-computer-boot-service-restart-control.mjs");
		assert.ok(manifest.artifacts.some(artifact => artifact.file === "qorpera-company-computer-boot-service-restart-control.mjs"));
		const bootRestartHelp = spawnSync(process.execPath, [bootServiceRestart, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(bootRestartHelp.status, 0, bootRestartHelp.stderr); assert.match(bootRestartHelp.stdout, /Protected retained-boot/);
		for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
			const failed = spawnSync(process.execPath, [bootServiceRestart, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
		}
		const serviceRestart = join(output, "qorpera-company-computer-service-restart-control.mjs");
		assert.ok(manifest.artifacts.some(artifact => artifact.file === "qorpera-company-computer-service-restart-control.mjs"));
		const restartHelp = spawnSync(process.execPath, [serviceRestart, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(restartHelp.status, 0, restartHelp.stderr); assert.match(restartHelp.stdout, /Protected office service restart/);
		for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
			const failed = spawnSync(process.execPath, [serviceRestart, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
		}
		assert.ok(manifest.artifacts.some(artifact => artifact.file === "qorpera-company-computer-service-start-control.mjs"));
		const serviceStartHelp = spawnSync(process.execPath, [serviceStart, "--help"], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
		assert.equal(serviceStartHelp.status, 0, serviceStartHelp.stderr); assert.match(serviceStartHelp.stdout, /Protected office service start/);
		for (const args of [[], ["--config", "must-not-leak"], ["--locked", "must-not-leak", "x", "y"]]) {
			const failed = spawnSync(process.execPath, [serviceStart, ...args], { cwd: temporary, env, encoding: "utf8", timeout: 10000 });
			assert.equal(failed.status, 1); assert.doesNotMatch(failed.stderr, /must-not-leak|Error:|node_modules/);
		}
		assert.match(prepUnit, /^PrivateNetwork=yes$/m);
		assert.match(prepUnit, /^ReadOnlyPaths=\/var\/lib\/qorpera-office /m);
		assert.doesNotMatch(prepUnit, /LoadCredential=|ReadWritePaths=|Conflicts=|WantedBy=/);
		// Only the durable event outbox persists as service-owned state. Boot
		// credentials and authority remain outside this directory and writable roots.
		const settings = unit.split("\n").map(line => line.trim());
		assert.deepEqual(settings.filter(line => /^StateDirectory(?:Mode)?\s*=/.test(line)), [
			"StateDirectory=qorpera-office-events",
			"StateDirectoryMode=0700",
		]);
		for (const line of ["Group=qorpera-office", "UMask=0077", "ProtectSystem=strict"]) assert.ok(settings.includes(line), line);
		assert.deepEqual(settings.filter(line => /^ReadWritePaths\s*=/.test(line)), [
			"ReadWritePaths=/var/lib/qorpera-office /run/qorpera-office /var/lib/qorpera-office-events",
		]);
		assert.doesNotMatch(unit, /EnvironmentFile=|LoadCredential=.*(?:identity|provider|openai)|ReadWritePaths=.*company-live|RuntimeDirectory=/);
		const repeated = run(); assert.notEqual(repeated.status, 0); assert.equal(await readFile(join(output, "manifest.json"), "utf8"), encoded);
	} finally { await rm(temporary, { recursive: true, force: true }); }
});
