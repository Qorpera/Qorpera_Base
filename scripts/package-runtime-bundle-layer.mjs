import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, closeSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RUNTIME_BUNDLE_LAYER_SCHEMA = "qorpera.runtime-bundle-layer/v1";
export const RUNTIME_HOST_LAYER_FILES = Object.freeze([
	"qorpera-ephemeral-runner.mjs",
	"qorpera-native-provider-host.mjs",
	"qorpera-identity-recovery-restore.mjs",
	"qorpera-native-isolation-child.mjs",
	"qorpera-lxd-runner-bootstrap.mjs",
	"qorpera-lxd-native-login-bootstrap.mjs",
	"qorpera-claude-home-shell.mjs",
]);

const BUNDLE_PINNED_ARTIFACTS = new Set(["qorpera-native-provider-host.mjs", "qorpera-ephemeral-runner.mjs"]);
const SHA_64 = /^[0-9a-f]{64}$/;

function readRegularFileNoFollow(filePath, label) {
	const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
	let fd;
	try {
		fd = openSync(filePath, flags);
	} catch (error) {
		throw new Error(`${label} must be a regular non-symlink file (${error.code || error.message})`);
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) {
			throw new Error(`${label} must be a regular non-symlink file`);
		}
		if ((info.mode & 0o022) !== 0) {
			throw new Error(`${label} must not be group- or world-writable`);
		}
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function verifyRuntimeBundleLayerDirectory(directory, options = {}) {
	const normalizedOptions =
		typeof options === "string"
			? { expectedBundleSha256: options, expectedManifestSha256: null }
			: {
					expectedBundleSha256: options?.expectedBundleSha256 ?? null,
					expectedManifestSha256: options?.expectedManifestSha256 ?? null,
				};
	if (typeof directory !== "string" || directory.length === 0 || !isAbsolute(directory) || directory.split(/[\\/]/).includes("..")) {
		throw new Error("Runtime bundle layer directory must be a clean absolute path");
	}
	const dirStat = lstatSync(directory);
	if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
		throw new Error("Runtime bundle layer directory must be a non-symlink directory");
	}
	if ((dirStat.mode & 0o022) !== 0) {
		throw new Error("Runtime bundle layer directory must not be group- or world-writable");
	}
	if (realpathSync(directory) !== resolve(directory)) {
		throw new Error("Runtime bundle layer directory must not contain symlinked path components");
	}
	if (normalizedOptions.expectedBundleSha256 !== null && !SHA_64.test(normalizedOptions.expectedBundleSha256)) {
		throw new Error("expectedBundleSha256 must be 64 lowercase hex characters");
	}
	if (normalizedOptions.expectedManifestSha256 !== null && !SHA_64.test(normalizedOptions.expectedManifestSha256)) {
		throw new Error("expectedManifestSha256 must be 64 lowercase hex characters");
	}

	const entries = readdirSync(directory).sort();
	const expectedEntries = ["manifest.json", ...RUNTIME_HOST_LAYER_FILES].sort();
	if (
		entries.length !== expectedEntries.length ||
		entries.some((entry, idx) => entry !== expectedEntries[idx])
	) {
		throw new Error(
			`Runtime bundle layer directory must contain exactly [${expectedEntries.join(", ")}] (found [${entries.join(", ")}])`,
		);
	}

	const manifestPath = join(directory, "manifest.json");
	const manifestBytes = readRegularFileNoFollow(manifestPath, "manifest.json");
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	if (normalizedOptions.expectedManifestSha256 !== null && manifestSha256 !== normalizedOptions.expectedManifestSha256) {
		throw new Error(
			`Runtime bundle layer manifest sha256 mismatch: got ${manifestSha256}, expected ${normalizedOptions.expectedManifestSha256}`,
		);
	}
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error("manifest.json must be a JSON object");
	}
	if (manifest.schema !== RUNTIME_BUNDLE_LAYER_SCHEMA) {
		throw new Error(`Invalid runtime bundle layer schema: ${manifest.schema}`);
	}
	if (typeof manifest.runtimeBundleSha256 !== "string" || !SHA_64.test(manifest.runtimeBundleSha256)) {
		throw new Error("Invalid runtimeBundleSha256 in runtime bundle layer manifest");
	}
	if (
		normalizedOptions.expectedBundleSha256 !== null &&
		manifest.runtimeBundleSha256 !== normalizedOptions.expectedBundleSha256
	) {
		throw new Error(
			`Runtime bundle layer mismatch: manifest has ${manifest.runtimeBundleSha256}, expected ${normalizedOptions.expectedBundleSha256}`,
		);
	}
	if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== RUNTIME_HOST_LAYER_FILES.length) {
		throw new Error("manifest.artifacts must list the exact host runtime layer files");
	}
	const declared = new Map();
	for (const item of manifest.artifacts) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			typeof item.file !== "string" ||
			!RUNTIME_HOST_LAYER_FILES.includes(item.file) ||
			declared.has(item.file) ||
			!Number.isSafeInteger(item.bytes) ||
			item.bytes < 1 ||
			typeof item.sha256 !== "string" ||
			!SHA_64.test(item.sha256)
		) {
			throw new Error(`Invalid artifact entry in runtime bundle layer manifest: ${item?.file}`);
		}
		declared.set(item.file, item);
	}
	for (const required of RUNTIME_HOST_LAYER_FILES) {
		const entry = declared.get(required);
		if (!entry) throw new Error(`Missing required artifact in runtime bundle layer manifest: ${required}`);
		const target = join(directory, required);
		const bytes = readRegularFileNoFollow(target, required);
		const actualSha = createHash("sha256").update(bytes).digest("hex");
		if (bytes.byteLength !== entry.bytes || actualSha !== entry.sha256) {
			throw new Error(`Digest mismatch for runtime bundle layer artifact: ${required}`);
		}
		if (BUNDLE_PINNED_ARTIFACTS.has(required) && !bytes.includes(Buffer.from(manifest.runtimeBundleSha256, "ascii"))) {
			throw new Error(`Compiled artifact ${required} does not embed runtimeBundleSha256 ${manifest.runtimeBundleSha256}`);
		}
	}
	return { manifest, manifestSha256 };
}

async function assertSafeOutputRoot(outputRoot) {
	const physicalOutput = await realpath(outputRoot).catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	const physicalRepo = await realpath(repositoryRoot);
	const candidate = physicalOutput ?? outputRoot;
	const child = relative(candidate, physicalRepo);
	if (child === "" || (child !== ".." && !child.startsWith(`..${sep}`))) {
		throw new Error("Runtime bundle layer output directory must not contain the repository root");
	}
}

export async function packageRuntimeBundleLayer({ outDir, env = process.env } = {}) {
	const outputRoot = resolve(outDir ?? join(repositoryRoot, ".artifacts/runtime-bundle-layer"));
	await assertSafeOutputRoot(outputRoot);
	const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-runtime-layer-"));
	try {
		const runnerOut = join(tempRoot, "runner");
		const packaged = spawnSync(
			process.execPath,
			[resolve(repositoryRoot, "scripts/package-ephemeral-runner.mjs"), "--out", runnerOut],
			{ cwd: repositoryRoot, env, encoding: "utf8" },
		);
		if (packaged.status !== 0) {
			throw new Error(packaged.stderr || "package-ephemeral-runner.mjs failed");
		}
		const runnerManifest = JSON.parse(await readFile(join(runnerOut, "manifest.json"), "utf8"));
		await rm(outputRoot, { recursive: true, force: true });
		await mkdir(outputRoot, { recursive: true, mode: 0o755 });
		await chmod(outputRoot, 0o755);
		const artifacts = [];
		for (const file of RUNTIME_HOST_LAYER_FILES) {
			const dest = join(outputRoot, file);
			await copyFile(join(runnerOut, file), dest);
			await chmod(dest, 0o555);
			const content = await readFile(dest);
			artifacts.push({
				file,
				bytes: content.byteLength,
				sha256: createHash("sha256").update(content).digest("hex"),
			});
		}
		const manifest = {
			schema: RUNTIME_BUNDLE_LAYER_SCHEMA,
			runtimeBundleSha256: runnerManifest.runtimeBundleSha256,
			artifacts,
		};
		const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
		const manifestDest = join(outputRoot, "manifest.json");
		await writeFile(manifestDest, manifestText, { encoding: "utf8", mode: 0o444 });
		await chmod(manifestDest, 0o444);
		const physicalOutput = await realpath(outputRoot);
		const { manifestSha256 } = verifyRuntimeBundleLayerDirectory(physicalOutput, {
			expectedBundleSha256: runnerManifest.runtimeBundleSha256,
		});
		return { outputRoot: physicalOutput, manifest, manifestSha256 };
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function readValue(argv, index, flagName) {
	const value = argv[index + 1];
	if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
		throw new Error(`Flag ${flagName} requires a value`);
	}
	return value;
}

export function parseCliArgs(argv) {
	let outDir = null;
	let verifyDir = null;
	let expectedBundle = null;
	let expectedManifest = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") {
			outDir = resolve(readValue(argv, i, "--out"));
			i += 1;
		} else if (arg === "--verify") {
			verifyDir = readValue(argv, i, "--verify");
			i += 1;
		} else if (arg === "--expected-bundle") {
			expectedBundle = readValue(argv, i, "--expected-bundle");
			i += 1;
		} else if (arg === "--expected-manifest") {
			expectedManifest = readValue(argv, i, "--expected-manifest");
			i += 1;
		} else {
			throw new Error(
				"Usage: node scripts/package-runtime-bundle-layer.mjs [--out <dir> | --verify <dir> [--expected-manifest <sha64>] [--expected-bundle <sha64>]]",
			);
		}
	}
	if (verifyDir && outDir) {
		throw new Error("--verify and --out cannot be combined");
	}
	if (!verifyDir && (expectedBundle || expectedManifest)) {
		throw new Error("--expected-bundle and --expected-manifest require --verify");
	}
	return {
		outDir: outDir ?? resolve(repositoryRoot, ".artifacts/runtime-bundle-layer"),
		verifyDir,
		expectedBundle,
		expectedManifest,
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parseCliArgs(process.argv.slice(2));
	if (args.verifyDir) {
		const { manifest, manifestSha256 } = verifyRuntimeBundleLayerDirectory(args.verifyDir, {
			expectedBundleSha256: args.expectedBundle,
			expectedManifestSha256: args.expectedManifest,
		});
		process.stdout.write(
			`${JSON.stringify({ verified: true, runtimeBundleSha256: manifest.runtimeBundleSha256, manifestSha256 })}\n`,
		);
	} else {
		const result = await packageRuntimeBundleLayer({ outDir: args.outDir });
		process.stdout.write(
			`${JSON.stringify({ outputRoot: result.outputRoot, runtimeBundleSha256: result.manifest.runtimeBundleSha256, manifestSha256: result.manifestSha256 })}\n`,
		);
	}
}
