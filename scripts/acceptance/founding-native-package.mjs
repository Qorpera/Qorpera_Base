import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cloudRuntimeBundle, generateCloudRuntimeBundle } from "../generate-cloud-runtime-bundle.mjs";
import {
	committedRuntimeBundle,
	runtimeBundleEnforced,
	runtimeBundlePackagingEnvironment,
} from "../runtime-bundle-release-train.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function foundingNativePackageOptions(args) {
	const result = {};
	for (let i = 0; i < args.length; i += 2) {
		const field = {
				"--out": "out",
				"--signed-runner-image": "signedImage",
				"--native-company-artifact": "nativeArtifact",
			}[args[i]],
			value = args[i + 1];
		assert(
			field &&
				!result[field] &&
				typeof value === "string" &&
				isAbsolute(value) &&
				resolve(value) === value &&
				value !== "/" &&
				!/[\x00-\x20\x7f'\\]/.test(value),
			"Exact isolated packaging paths required",
		);
		result[field] = value;
	}
	assert(
		Object.keys(result).length === 3,
		"Require --out, --signed-runner-image and --native-company-artifact; contract-only packages cannot boot",
	);
	for (const source of [repository, result.signedImage, result.nativeArtifact])
		assert(
			result.out !== source && !source.startsWith(`${result.out}/`) && !result.out.startsWith(`${source}/`),
			"Package output must be separate from source artifacts and repository",
		);
	return result;
}

export function foundingNativePackageEnvironment(environment = process.env) {
	// Do not inherit arbitrary loader hooks, including a caller-injected stale
	// bundle bypass under strict enforcement. Only our existing reviewed test
	// hook may be installed, and only by the release-train helper.
	assert(!environment.NODE_OPTIONS, "Inherited NODE_OPTIONS refused for isolated packaging");
	return runtimeBundlePackagingEnvironment(environment);
}

export async function verifyFoundingNativePackage(directory) {
	const bytes = await readFile(join(directory, "manifest.json")),
		manifest = JSON.parse(bytes);
	assert.equal(manifest.schema, "qorpera.lxd-runner-guest-package/v1");
	assert.equal(manifest.platform, "linux-x64");
	assert.equal(manifest.nativeCompany?.schema, "qorpera.native-company-guest/v1");
	const seen = new Set();
	assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0);
	for (const artifact of manifest.artifacts) {
		assert(
			typeof artifact.file === "string" &&
				/^[A-Za-z0-9_.\/-]+$/.test(artifact.file) &&
				!artifact.file.startsWith("/") &&
				artifact.file.split("/").every((part) => part && part !== "." && part !== "..") &&
				!seen.has(artifact.file),
			"Unsafe or duplicate package artifact",
		);
		seen.add(artifact.file);
		const path = join(directory, artifact.file),
			info = await lstat(path);
		assert(info.isFile() && !info.isSymbolicLink() && (await realpath(path)) === path);
		assert.equal(info.size, artifact.bytes);
		assert.equal(digest(await readFile(path)), artifact.sha256);
	}
	for (const file of [
		"native-company/codex",
		manifest.runnerImage?.archive?.file,
		manifest.runnerImage?.cosign_bundle?.file,
	])
		assert(
			typeof file === "string" && seen.has(file),
			"Bootable pinned native and signed runner artifacts required",
		);
	return { sha256: digest(bytes), artifacts: manifest.artifacts.length };
}

export async function packageFoundingNative(options, environment = process.env) {
	const env = foundingNativePackageEnvironment(environment);
	assert(
		process.platform === "linux" && process.arch === "x64",
		"Build the joined guest package on Linux x64",
	);
	for (const path of [options.signedImage, options.nativeArtifact, dirname(options.out)])
		assert.equal(await realpath(path), path, "Canonical physical source and output-parent paths required");
	assert.equal(
		await lstat(options.out).catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		}),
		null,
		"Existing package output refused",
	);
	const enforced = runtimeBundleEnforced(environment);
	const current = enforced ? await generateCloudRuntimeBundle(true) : await cloudRuntimeBundle();
	const committed = await committedRuntimeBundle();
	await mkdir(options.out, { mode: 0o700 });
	const output = join(options.out, "package");
	await promisify(execFile)(
		process.execPath,
		[
			join(repository, "scripts/package-lxd-runner-guest.mjs"),
			"--out",
			output,
			"--signed-runner-image",
			options.signedImage,
			"--native-company-artifact",
			options.nativeArtifact,
		],
		{ cwd: repository, env, timeout: 300000, maxBuffer: 1024 * 1024 },
	);
	const verified = await verifyFoundingNativePackage(output);
	assert.equal(
		(await cloudRuntimeBundle()).sha256,
		current.sha256,
		"Runtime source changed during packaging",
	);
	assert.equal(
		(await committedRuntimeBundle()).sha256,
		committed.sha256,
		"Committed bundle changed during packaging",
	);
	const evidence = {
		schema: "qorpera.founding-native-test-package/v1",
		testOnly: true,
		productionDeploymentAuthorized: false,
		bundleFreshnessEnforced: enforced,
		sourceMatchesCommittedIdentity: current.sha256 === committed.sha256,
		currentSource: { runtimeBundleSha256: current.sha256, implementation: current.manifest.implementation },
		committedIdentity: {
			runtimeBundleSha256: committed.sha256,
			modelPolicySha256: committed.modelPolicySha256,
			nativeBinarySha256: committed.manifest.nativeBinarySha256,
		},
		package: { directory: output, manifestSha256: verified.sha256, artifactCount: verified.artifacts },
		boundary:
			"Current source bundled for isolated acceptance; committed embedded runtime identity is retained. This is not a release artifact, deployment approval or physical execution proof.",
	};
	await writeFile(join(options.out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	return evidence;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const evidence = await packageFoundingNative(foundingNativePackageOptions(process.argv.slice(2)));
	console.log(
		JSON.stringify({
			testOnly: true,
			...evidence.package,
			evidence: join(dirname(evidence.package.directory), "evidence.json"),
		}),
	);
}
