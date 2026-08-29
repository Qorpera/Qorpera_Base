import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeCompanyArtifact } from "./native-company-artifact.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function options(args) {
	let outputRoot = resolve(repositoryRoot, ".artifacts/lxd-runner-guest");
	let signedImageRoot = process.env.QORPERA_SIGNED_RUNNER_IMAGE_ROOT
		? resolve(process.env.QORPERA_SIGNED_RUNNER_IMAGE_ROOT)
		: undefined;
	let contractOnly = false;
	let nativeCompanyArtifactRoot;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--out" && args[index + 1]) {
			outputRoot = resolve(args[++index]);
		} else if (argument === "--signed-runner-image" && args[index + 1]) {
			signedImageRoot = resolve(args[++index]);
		} else if (argument === "--contract-only") {
			contractOnly = true;
		} else if (argument === "--native-company-artifact" && args[index + 1] && !nativeCompanyArtifactRoot) {
			nativeCompanyArtifactRoot = resolve(args[++index]);
		} else {
			throw new Error(
				"Usage: node scripts/package-lxd-runner-guest.mjs [--out <directory>] [--signed-runner-image <directory> | --contract-only] [--native-company-artifact <directory>]",
			);
		}
	}
	if (contractOnly === Boolean(signedImageRoot)) {
		throw new Error("Choose exactly one signed runner image directory or --contract-only");
	}
	return { outputRoot, signedImageRoot, nativeCompanyArtifactRoot };
}

const { outputRoot, signedImageRoot, nativeCompanyArtifactRoot } = options(process.argv.slice(2));

const physicalOutput = await realpath(outputRoot).catch((error) => {
	if (error.code === "ENOENT") return undefined;
	throw error;
});
for (const source of [repositoryRoot, signedImageRoot, nativeCompanyArtifactRoot].filter(Boolean)) {
	const physicalSource = await realpath(source);
	if (physicalOutput) {
		const child = relative(physicalOutput, physicalSource);
		if (child === "" || (child !== ".." && !child.startsWith(`..${sep}`))) {
			throw new Error("Guest package output must not contain a source artifact directory");
		}
	}
}
const nativeCompany = nativeCompanyArtifactRoot ? await verifyNativeCompanyArtifact(nativeCompanyArtifactRoot) : undefined;
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
	await mkdir(join(outputRoot, "runner-image"), { recursive: true });
	const sources = new Map([
		["company-lock-heartbeat.mjs", join(runnerRoot, "company-lock-heartbeat.mjs")],
		["qorpera-ephemeral-runner.mjs", join(runnerRoot, "qorpera-ephemeral-runner.mjs")],
		["qorpera-native-provider-host.mjs", join(runnerRoot, "qorpera-native-provider-host.mjs")],
		["qorpera-identity-recovery-restore.mjs", join(runnerRoot, "qorpera-identity-recovery-restore.mjs")],
		["qorpera-native-isolation-child.mjs", join(runnerRoot, "qorpera-native-isolation-child.mjs")],
		["qorpera-sandbox-probe.mjs", join(runnerRoot, "qorpera-sandbox-probe.mjs")],
		["qorpera-lxd-runner-bootstrap.mjs", join(runnerRoot, "qorpera-lxd-runner-bootstrap.mjs")],
		[
			"qorpera-lxd-native-login-bootstrap.mjs",
			join(runnerRoot, "qorpera-lxd-native-login-bootstrap.mjs"),
		],
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
			"qorpera-native-login-provider-host.service",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-native-login-provider-host.service"),
		],
		["qorpera-native-company-host.service", resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-native-company-host.service")],
		["qorpera-company-runner.service", resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-company-runner.service")],
		[
			"qorpera-lxd-runner-bootstrap.service",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-lxd-runner-bootstrap.service"),
		],
		[
			"qorpera-lxd-native-login-bootstrap.service",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/qorpera-lxd-native-login-bootstrap.service"),
		],
		[
			"install-image-contract.sh",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/install-image-contract.sh"),
		],
		[
			"runner-image/contract.json",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/runner-image-contract.json"),
		],
		["harness/package.json", resolve(repositoryRoot, "deploy/lxd-runner-guest/harness/package.json")],
		[
			"harness/package-lock.json",
			resolve(repositoryRoot, "deploy/lxd-runner-guest/harness/package-lock.json"),
		],
	]);
	if (nativeCompany) {
		await mkdir(join(outputRoot, "native-company"));
		for (const name of ["codex", "artifact.json", "LICENSE", "NOTICE"]) {
			sources.set(`native-company/${name}`, join(nativeCompany.root, name));
		}
	}

	for (const [file, source] of sources) await copyFile(source, join(outputRoot, file));
	const runnerImageContract = JSON.parse(await readFile(sources.get("runner-image/contract.json"), "utf-8"));
	if (
		runnerImageContract.schema !== "qorpera.ephemeral-runner-image-contract/v1" ||
		!runnerImageContract.archive ||
		!runnerImageContract.cosign_bundle
	) {
		throw new Error("Runner image contract is invalid");
	}
	const externalArtifacts = [runnerImageContract.archive, runnerImageContract.cosign_bundle];
	if (signedImageRoot) {
		for (const artifact of externalArtifacts) {
			const source = join(signedImageRoot, artifact.file.split("/").at(-1));
			const metadata = await lstat(source);
			const content = await readFile(source);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				content.byteLength !== artifact.bytes ||
				createHash("sha256").update(content).digest("hex") !== artifact.sha256
			) {
				throw new Error(`Signed runner image artifact does not match its contract: ${artifact.file}`);
			}
			await copyFile(source, join(outputRoot, artifact.file));
		}
	}
	await chmod(join(outputRoot, "run-job"), 0o555);
	await chmod(join(outputRoot, "install-image-contract.sh"), 0o555);
	if (nativeCompany) await chmod(join(outputRoot, "native-company/codex"), 0o555);

	const artifacts = [];
	for (const file of [...sources.keys()].sort()) {
		const content = await readFile(join(outputRoot, file));
		const digest = createHash("sha256").update(content).digest("hex");
		if (file === "native-company/codex" && digest !== nativeCompany.contract.binarySha256) {
			throw new Error("Native company binary changed during packaging");
		}
		artifacts.push({
			file,
			bytes: content.byteLength,
			sha256: digest,
		});
	}
	artifacts.push(...externalArtifacts.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })));
	artifacts.sort((left, right) => left.file.localeCompare(right.file, "en"));
	await writeFile(
		join(outputRoot, "manifest.json"),
		`${JSON.stringify(
			{
				schema: "qorpera.lxd-runner-guest-package/v1",
				platform: "linux-x64",
				runtime: { node: ">=22.19.0", podman: ">=5.0.0", cgroups: "v2" },
				nativeHarnesses: { codex: "0.147.0", claudeCode: "2.1.231" },
				...(nativeCompany ? { nativeCompany: nativeCompany.contract } : {}),
				runnerImage: runnerImageContract,
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
