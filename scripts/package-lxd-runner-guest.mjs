import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outputDirectory(args) {
	if (args.length === 0) return resolve(repositoryRoot, ".artifacts/lxd-runner-guest");
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/package-lxd-runner-guest.mjs [--out <directory>]");
	}
	return resolve(args[1]);
}

const outputRoot = outputDirectory(process.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "qorpera-lxd-runner-package-"));
try {
	const runnerRoot = join(temporaryRoot, "runner");
	const packaged = spawnSync(
		process.execPath,
		[resolve(repositoryRoot, "scripts/package-ephemeral-runner.mjs"), "--out", runnerRoot],
		{ cwd: repositoryRoot, encoding: "utf-8" },
	);
	if (packaged.status !== 0) throw new Error(packaged.stderr || "Ephemeral runner packaging failed");

	await rm(outputRoot, { recursive: true, force: true });
	await mkdir(join(outputRoot, "harness"), { recursive: true });
	const sources = new Map([
		["qorpera-ephemeral-runner.mjs", join(runnerRoot, "qorpera-ephemeral-runner.mjs")],
		["qorpera-native-provider-host.mjs", join(runnerRoot, "qorpera-native-provider-host.mjs")],
		["qorpera-sandbox-probe.mjs", join(runnerRoot, "qorpera-sandbox-probe.mjs")],
		["qorpera-lxd-runner-bootstrap.mjs", join(runnerRoot, "qorpera-lxd-runner-bootstrap.mjs")],
		["run-job", join(runnerRoot, "run-job")],
		[
			"qorpera-ephemeral-runner.service",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-ephemeral-runner.service"),
		],
		[
			"qorpera-native-provider-host.service",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-native-provider-host.service"),
		],
		[
			"qorpera-lxd-runner-bootstrap.service",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-lxd-runner-bootstrap.service"),
		],
		[
			"install-image-contract.sh",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/install-image-contract.sh"),
		],
		["harness/package.json", resolve(repositoryRoot, "deploy/lxd-runner-guest/harness/package.json")],
		[
			"harness/package-lock.json",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/harness/package-lock.json"),
		],
	]);

	for (const [file, source] of sources) await copyFile(source, join(outputRoot, file));
	await chmod(join(outputRoot, "run-job"), 0o555);
	await chmod(join(outputRoot, "install-image-contract.sh"), 0o555);

	const artifacts = [];
	for (const file of [...sources.keys()].sort()) {
		const content = await readFile(join(outputRoot, file));
		artifacts.push({
			file,
			bytes: content.byteLength,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	await writeFile(
		join(outputRoot, "manifest.json"),
		`${JSON.stringify(
			{
				schema: "qorpera.lxd-runner-guest-package/v1",
				platform: "linux-x64",
				runtime: { node: ">=22.19.0", podman: ">=5.0.0", cgroups: "v2" },
				nativeHarnesses: { codex: "0.147.0", claudeCode: "2.1.231" },
				artifacts,
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	console.log(outputRoot);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
