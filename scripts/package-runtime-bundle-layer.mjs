import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const RUNTIME_BUNDLE_LAYER_SCHEMA = "qorpera.runtime-bundle-layer/v1";
export const RUNTIME_LAYER_FILES = Object.freeze([
	"qorpera-ephemeral-runner.mjs",
	"qorpera-native-provider-host.mjs",
	"qorpera-identity-recovery-restore.mjs",
	"qorpera-native-isolation-child.mjs",
	"qorpera-sandbox-probe.mjs",
	"qorpera-lxd-runner-bootstrap.mjs",
	"qorpera-lxd-native-login-bootstrap.mjs",
	"qorpera-claude-home-shell.mjs",
	"run-job",
]);

const SHA_64 = /^[0-9a-f]{64}$/;

export function verifyRuntimeBundleLayerDirectory(directory, expectedBundleSha256 = null) {
	const manifestPath = join(directory, "manifest.json");
	const manifestStat = lstatSync(manifestPath);
	if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
		throw new Error("manifest.json must be a regular file");
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest?.schema !== RUNTIME_BUNDLE_LAYER_SCHEMA) {
		throw new Error(`Invalid runtime bundle layer schema: ${manifest?.schema}`);
	}
	if (typeof manifest.runtimeBundleSha256 !== "string" || !SHA_64.test(manifest.runtimeBundleSha256)) {
		throw new Error("Invalid runtimeBundleSha256 in runtime bundle layer manifest");
	}
	if (expectedBundleSha256 !== null && manifest.runtimeBundleSha256 !== expectedBundleSha256) {
		throw new Error(
			`Runtime bundle layer mismatch: manifest has ${manifest.runtimeBundleSha256}, expected ${expectedBundleSha256}`,
		);
	}
	if (!Array.isArray(manifest.artifacts)) {
		throw new Error("manifest.artifacts must be an array");
	}
	const declared = new Map();
	for (const item of manifest.artifacts) {
		if (
			!item ||
			typeof item.file !== "string" ||
			!RUNTIME_LAYER_FILES.includes(item.file) ||
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
	for (const required of RUNTIME_LAYER_FILES) {
		const entry = declared.get(required);
		if (!entry) throw new Error(`Missing required artifact in runtime bundle layer manifest: ${required}`);
		const target = join(directory, required);
		const info = lstatSync(target);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error(`Artifact must be a regular non-symlink file: ${required}`);
		}
		const bytes = readFileSync(target);
		const actualSha = createHash("sha256").update(bytes).digest("hex");
		if (bytes.byteLength !== entry.bytes || actualSha !== entry.sha256) {
			throw new Error(`Digest mismatch for runtime bundle layer artifact: ${required}`);
		}
	}
	return manifest;
}

export async function packageRuntimeBundleLayer({ outDir, env = process.env } = {}) {
	const outputRoot = resolve(outDir ?? join(repositoryRoot, ".artifacts/runtime-bundle-layer"));
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
		await mkdir(outputRoot, { recursive: true });
		const artifacts = [];
		for (const file of RUNTIME_LAYER_FILES) {
			await copyFile(join(runnerOut, file), join(outputRoot, file));
			const content = await readFile(join(outputRoot, file));
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
		await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		verifyRuntimeBundleLayerDirectory(outputRoot, runnerManifest.runtimeBundleSha256);
		return { outputRoot, manifest };
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function parseCliArgs(argv) {
	let outDir = resolve(repositoryRoot, ".artifacts/runtime-bundle-layer");
	let verifyDir = null;
	let expectedBundle = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out" && argv[i + 1]) outDir = resolve(argv[++i]);
		else if (arg === "--verify" && argv[i + 1]) verifyDir = resolve(argv[++i]);
		else if (arg === "--expected-bundle" && argv[i + 1]) expectedBundle = argv[++i];
		else {
			throw new Error(
				"Usage: node scripts/package-runtime-bundle-layer.mjs [--out <dir> | --verify <dir> [--expected-bundle <sha64>]]",
			);
		}
	}
	return { outDir, verifyDir, expectedBundle };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = parseCliArgs(process.argv.slice(2));
	if (args.verifyDir) {
		const manifest = verifyRuntimeBundleLayerDirectory(args.verifyDir, args.expectedBundle);
		process.stdout.write(`${JSON.stringify({ verified: true, runtimeBundleSha256: manifest.runtimeBundleSha256 })}\n`);
	} else {
		const result = await packageRuntimeBundleLayer({ outDir: args.outDir });
		process.stdout.write(`${result.outputRoot}\n`);
	}
}
