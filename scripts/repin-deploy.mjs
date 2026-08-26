import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const run = (script, out, extra = []) => {
	const result = spawnSync(process.execPath, [script, "--out", out, ...extra], { cwd: repo, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr);
};
const setPin = (path, key, value) => {
	const file = readFileSync(path, "utf-8");
	const pattern = new RegExp(`${key}="[0-9a-f]{64}"`);
	if (!pattern.test(file)) throw new Error(`${path} has no pin ${key}`);
	const next = file.replace(pattern, `${key}="${value}"`);
	if (next !== file) {
		writeFileSync(path, next);
		console.log(`updated ${key} in ${path}`);
	} else {
		console.log(`unchanged ${key} in ${path}`);
	}
};

// 1. LXD provider package pins.
const providerOut = mkdtempSync(join(tmpdir(), "repin-provider-"));
run("scripts/package-lxd-provider.mjs", providerOut);
const providerInstaller = join(repo, "deploy/first-node/install-lxd-provider-host.sh");
setPin(providerInstaller, "EXPECTED_ARTIFACT_SHA256", sha256(readFileSync(join(providerOut, "qorpera-lxd-provider.mjs"))));
setPin(
	providerInstaller,
	"EXPECTED_PROVENANCE_TOOL_SHA256",
	sha256(readFileSync(join(providerOut, "qorpera-lxd-image-provenance.mjs"))),
);
setPin(
	providerInstaller,
	"EXPECTED_UNIT_SHA256",
	sha256(readFileSync(join(repo, "deploy/first-node/qorpera-lxd-provider.service"))),
);
setPin(
	providerInstaller,
	"EXPECTED_ENV_EXAMPLE_SHA256",
	sha256(readFileSync(join(repo, "deploy/first-node/lxd-provider.env.example"))),
);
const companyInstaller = join(repo, "deploy/first-node/install-lxd-company-provider-host.sh");
setPin(companyInstaller, "EXPECTED_ARTIFACT_SHA256", sha256(readFileSync(join(providerOut, "qorpera-lxd-provider.mjs"))));
setPin(
	companyInstaller,
	"EXPECTED_UNIT_SHA256",
	sha256(readFileSync(join(repo, "deploy/first-node/qorpera-lxd-company-provider.service"))),
);
setPin(
	companyInstaller,
	"EXPECTED_ENV_EXAMPLE_SHA256",
	sha256(readFileSync(join(repo, "deploy/first-node/lxd-company-provider.env.example"))),
);
rmSync(providerOut, { recursive: true, force: true });

// 2. Runner orchestrator package pins (installer first, then the provisioner
// that pins the installer's own hash).
const orchestratorOut = mkdtempSync(join(tmpdir(), "repin-orchestrator-"));
run("scripts/package-runner-orchestrator.mjs", orchestratorOut);
const orchestratorArtifactSha = sha256(readFileSync(join(orchestratorOut, "qorpera-runner-orchestrator.mjs")));
const orchestratorUnitSha = sha256(readFileSync(join(repo, "deploy/first-node/qorpera-runner-orchestrator.service")));
const orchestratorEnvSha = sha256(readFileSync(join(repo, "deploy/first-node/runner-orchestrator.env.example")));
const orchestratorInstaller = join(repo, "deploy/first-node/install-runner-orchestrator-guest.sh");
setPin(orchestratorInstaller, "EXPECTED_ARTIFACT_SHA256", orchestratorArtifactSha);
setPin(orchestratorInstaller, "EXPECTED_UNIT_SHA256", orchestratorUnitSha);
setPin(orchestratorInstaller, "EXPECTED_ENV_EXAMPLE_SHA256", orchestratorEnvSha);
const provisioner = join(repo, "deploy/first-node/provision-runner-orchestrator-vm.sh");
setPin(provisioner, "EXPECTED_ARTIFACT_SHA256", orchestratorArtifactSha);
setPin(provisioner, "EXPECTED_INSTALLER_SHA256", sha256(readFileSync(orchestratorInstaller)));
setPin(provisioner, "EXPECTED_UNIT_SHA256", orchestratorUnitSha);
setPin(provisioner, "EXPECTED_ENV_EXAMPLE_SHA256", orchestratorEnvSha);
rmSync(orchestratorOut, { recursive: true, force: true });

// 2b. Runner guest package pin in its image-candidate and acceptance recipes.
const runnerGuestOut = mkdtempSync(join(tmpdir(), "repin-runner-guest-"));
run("scripts/package-lxd-runner-guest.mjs", runnerGuestOut, ["--contract-only"]);
const runnerGuestSha = sha256(readFileSync(join(runnerGuestOut, "manifest.json")));
setPin(join(repo, "deploy/first-node/build-lxd-runner-image-candidate.sh"), "EXPECTED_PACKAGE_MANIFEST_SHA256", runnerGuestSha);
setPin(join(repo, "deploy/first-node/verify-lxd-runner-image-candidate.sh"), "EXPECTED_PACKAGE_MANIFEST_SHA256", runnerGuestSha);
rmSync(runnerGuestOut, { recursive: true, force: true });

// 3. Company computer guest package pin in its image-candidate recipe.
const companyOut = mkdtempSync(join(tmpdir(), "repin-company-"));
run("scripts/package-lxd-company-computer-guest.mjs", companyOut, ["--contract-only"]);
setPin(
	join(repo, "deploy/first-node/build-lxd-company-computer-image-candidate.sh"),
	"EXPECTED_PACKAGE_MANIFEST_SHA256",
	sha256(readFileSync(join(companyOut, "manifest.json"))),
);
rmSync(companyOut, { recursive: true, force: true });
console.log("repin complete");
