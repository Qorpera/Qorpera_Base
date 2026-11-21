import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

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

const BUNDLE_PINNED_ARTIFACTS = new Set(["qorpera-native-provider-host.mjs"]);
const SHA_64 = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
const EXPECTED_ENTRY_NAMES = Object.freeze(["manifest.json", ...RUNTIME_HOST_LAYER_FILES].sort());

function readRegularFileNoFollow(filePath, label, maxBytes = null) {
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
		if (maxBytes !== null && (info.size < 1 || info.size > maxBytes)) {
			throw new Error(`${label} size ${info.size} is outside allowed bounds (1..${maxBytes})`);
		}
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

function validateManifestAndBuffers(entryBuffers, { expectedBundleSha256 = null, expectedManifestSha256 = null } = {}) {
	const actualNames = [...entryBuffers.keys()].sort();
	if (
		actualNames.length !== EXPECTED_ENTRY_NAMES.length ||
		actualNames.some((entry, idx) => entry !== EXPECTED_ENTRY_NAMES[idx])
	) {
		throw new Error(
			`Runtime bundle layer must contain exactly [${EXPECTED_ENTRY_NAMES.join(", ")}] (found [${actualNames.join(", ")}])`,
		);
	}
	const manifestBytes = entryBuffers.get("manifest.json");
	const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
	if (expectedManifestSha256 !== null && manifestSha256 !== expectedManifestSha256) {
		throw new Error(
			`Runtime bundle layer manifest sha256 mismatch: got ${manifestSha256}, expected ${expectedManifestSha256}`,
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
	if (expectedBundleSha256 !== null && manifest.runtimeBundleSha256 !== expectedBundleSha256) {
		throw new Error(
			`Runtime bundle layer mismatch: manifest has ${manifest.runtimeBundleSha256}, expected ${expectedBundleSha256}`,
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
		const bytes = entryBuffers.get(required);
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

function writeOctalField(buffer, offset, length, value) {
	const encoded = value.toString(8).padStart(length - 1, "0");
	if (encoded.length > length - 1) {
		throw new Error(`Tar octal overflow for value ${value}`);
	}
	buffer.write(encoded, offset, length - 1, "ascii");
	buffer[offset + length - 1] = 0;
}

export function buildDeterministicTarGz(entries) {
	const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const chunks = [];
	for (const entry of sorted) {
		if (typeof entry.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/.test(entry.name)) {
			throw new Error(`Invalid tar entry name: ${entry.name}`);
		}
		const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
		const header = Buffer.alloc(512, 0);
		header.write(entry.name, 0, entry.name.length, "ascii");
		writeOctalField(header, 100, 8, entry.mode ?? 0o444);
		writeOctalField(header, 108, 8, 0);
		writeOctalField(header, 116, 8, 0);
		writeOctalField(header, 124, 12, content.byteLength);
		writeOctalField(header, 136, 12, 0);
		header.fill(0x20, 148, 156);
		header[156] = 0x30;
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		header.write("root", 265, 4, "ascii");
		header.write("root", 297, 4, "ascii");
		writeOctalField(header, 329, 8, 0);
		writeOctalField(header, 337, 8, 0);
		let checksum = 0;
		for (let i = 0; i < 512; i++) checksum += header[i];
		const checksumStr = checksum.toString(8).padStart(6, "0");
		header.write(checksumStr, 148, 6, "ascii");
		header[154] = 0;
		header[155] = 0x20;
		chunks.push(header);
		chunks.push(content);
		const rem = content.byteLength % 512;
		if (rem !== 0) {
			chunks.push(Buffer.alloc(512 - rem, 0));
		}
	}
	chunks.push(Buffer.alloc(1024, 0));
	const gz = Buffer.from(gzipSync(Buffer.concat(chunks), { level: 9 }));
	gz[4] = 0;
	gz[5] = 0;
	gz[6] = 0;
	gz[7] = 0;
	gz[9] = 3;
	return gz;
}

function readCString(buffer, start, end) {
	let stop = start;
	while (stop < end && buffer[stop] !== 0) stop += 1;
	return buffer.subarray(start, stop).toString("utf8");
}

function parseOctalField(buffer, start, end, label) {
	const raw = readCString(buffer, start, end).trim();
	if (!/^[0-7]+$/.test(raw)) {
		throw new Error(`Invalid tar ${label}`);
	}
	return Number.parseInt(raw, 8);
}

export function parseStrictTarGz(archiveBytes) {
	const tarBytes = gunzipSync(archiveBytes, { maxOutputLength: MAX_EXTRACTED_BYTES });
	if (tarBytes.byteLength < 1024 || tarBytes.byteLength % 512 !== 0) {
		throw new Error("Invalid tar archive framing");
	}
	const files = new Map();
	let offset = 0;
	let sawEndMarker = false;
	while (offset < tarBytes.byteLength) {
		const header = tarBytes.subarray(offset, offset + 512);
		const isZeroBlock = header.every((byte) => byte === 0);
		if (isZeroBlock) {
			for (let pos = offset; pos < tarBytes.byteLength; pos++) {
				if (tarBytes[pos] !== 0) {
					throw new Error("Unexpected trailing data after tar end-of-archive blocks");
				}
			}
			sawEndMarker = true;
			break;
		}
		const storedChecksum = parseOctalField(header, 148, 156, "checksum");
		let computed = 0;
		for (let i = 0; i < 512; i++) {
			computed += i >= 148 && i < 156 ? 0x20 : header[i];
		}
		if (storedChecksum !== computed) {
			throw new Error("Invalid tar header checksum");
		}
		const typeflag = header[156];
		if (typeflag !== 0x30 && typeflag !== 0) {
			throw new Error(`Unsupported tar entry typeflag: ${typeflag}`);
		}
		const prefix = readCString(header, 345, 500);
		if (prefix.length > 0) {
			throw new Error(`Tar entry must not use path prefix: ${prefix}`);
		}
		const name = readCString(header, 0, 100);
		if (!name || /[\\/\0]/.test(name) || name === "." || name === "..") {
			throw new Error(`Unsafe tar entry name: ${name}`);
		}
		if (files.has(name)) {
			throw new Error(`Duplicate tar entry: ${name}`);
		}
		const size = parseOctalField(header, 124, 136, "size");
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (dataEnd > tarBytes.byteLength) {
			throw new Error(`Truncated tar entry: ${name}`);
		}
		files.set(name, Buffer.from(tarBytes.subarray(dataStart, dataEnd)));
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	if (!sawEndMarker) {
		throw new Error("Missing tar end-of-archive zero blocks");
	}
	return files;
}

export function verifyRuntimeBundleLayerDirectory(directory, options = {}) {
	const normalizedOptions =
		typeof options === "string"
			? { expectedBundleSha256: options, expectedManifestSha256: null }
			: {
					expectedBundleSha256: options?.expectedBundleSha256 ?? null,
					expectedManifestSha256: options?.expectedManifestSha256 ?? null,
				};
	if (
		typeof directory !== "string" ||
		directory.length === 0 ||
		!isAbsolute(directory) ||
		directory.split(/[\\/]/).includes("..")
	) {
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
	if (
		entries.length !== EXPECTED_ENTRY_NAMES.length ||
		entries.some((entry, idx) => entry !== EXPECTED_ENTRY_NAMES[idx])
	) {
		throw new Error(
			`Runtime bundle layer directory must contain exactly [${EXPECTED_ENTRY_NAMES.join(", ")}] (found [${entries.join(", ")}])`,
		);
	}

	const entryBuffers = new Map();
	for (const name of EXPECTED_ENTRY_NAMES) {
		entryBuffers.set(name, readRegularFileNoFollow(join(directory, name), name));
	}
	return validateManifestAndBuffers(entryBuffers, normalizedOptions);
}

export function verifyRuntimeBundleLayerArchive(archivePath, options = {}) {
	const expectedArchiveSha256 = options?.expectedArchiveSha256 ?? null;
	const expectedManifestSha256 = options?.expectedManifestSha256 ?? null;
	const expectedBundleSha256 = options?.expectedBundleSha256 ?? null;
	if (
		typeof archivePath !== "string" ||
		archivePath.length === 0 ||
		!isAbsolute(archivePath) ||
		archivePath.split(/[\\/]/).includes("..")
	) {
		throw new Error("Runtime bundle layer archive must be a clean absolute path");
	}
	if (expectedArchiveSha256 !== null && !SHA_64.test(expectedArchiveSha256)) {
		throw new Error("expectedArchiveSha256 must be 64 lowercase hex characters");
	}
	if (expectedManifestSha256 !== null && !SHA_64.test(expectedManifestSha256)) {
		throw new Error("expectedManifestSha256 must be 64 lowercase hex characters");
	}
	if (expectedBundleSha256 !== null && !SHA_64.test(expectedBundleSha256)) {
		throw new Error("expectedBundleSha256 must be 64 lowercase hex characters");
	}
	const archiveStat = lstatSync(archivePath);
	if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
		throw new Error("Runtime bundle layer archive must be a non-symlink regular file");
	}
	if (realpathSync(archivePath) !== resolve(archivePath)) {
		throw new Error("Runtime bundle layer archive must not contain symlinked path components");
	}
	const archiveBytes = readRegularFileNoFollow(archivePath, "runtime bundle layer archive", MAX_ARCHIVE_BYTES);
	const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
	if (expectedArchiveSha256 !== null && archiveSha256 !== expectedArchiveSha256) {
		throw new Error(
			`Runtime bundle layer archive sha256 mismatch: got ${archiveSha256}, expected ${expectedArchiveSha256}`,
		);
	}
	const entryBuffers = parseStrictTarGz(archiveBytes);
	const { manifest, manifestSha256 } = validateManifestAndBuffers(entryBuffers, {
		expectedBundleSha256,
		expectedManifestSha256,
	});
	return { manifest, manifestSha256, archiveSha256, bytes: archiveBytes.byteLength };
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

export async function packageRuntimeBundleLayerArchive({ archivePath, env = process.env } = {}) {
	const targetPath = resolve(archivePath ?? join(repositoryRoot, ".artifacts/qorpera-runtime-bundle-layer.tar.gz"));
	await assertSafeOutputRoot(targetPath);
	const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-runtime-archive-"));
	try {
		const layerDir = join(tempRoot, "layer");
		const { outputRoot, manifest, manifestSha256 } = await packageRuntimeBundleLayer({ outDir: layerDir, env });
		const entries = [
			{ name: "manifest.json", mode: 0o444, content: await readFile(join(outputRoot, "manifest.json")) },
			...(await Promise.all(
				RUNTIME_HOST_LAYER_FILES.map(async (file) => ({
					name: file,
					mode: 0o555,
					content: await readFile(join(outputRoot, file)),
				})),
			)),
		];
		const gzBytes = buildDeterministicTarGz(entries);
		if (gzBytes.byteLength > MAX_ARCHIVE_BYTES) {
			throw new Error(`Runtime bundle layer archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
		}
		await mkdir(dirname(targetPath), { recursive: true, mode: 0o755 });
		const temporaryTarget = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
		try {
			await writeFile(temporaryTarget, gzBytes, { mode: 0o444 });
			await chmod(temporaryTarget, 0o444);
			await rename(temporaryTarget, targetPath);
		} catch (error) {
			await rm(temporaryTarget, { force: true }).catch(() => {});
			throw error;
		}
		const physicalArchive = await realpath(targetPath);
		const verified = verifyRuntimeBundleLayerArchive(physicalArchive, {
			expectedBundleSha256: manifest.runtimeBundleSha256,
			expectedManifestSha256: manifestSha256,
		});
		return {
			archivePath: physicalArchive,
			archiveSha256: verified.archiveSha256,
			bytes: verified.bytes,
			manifest,
			manifestSha256,
		};
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
	let archivePath = null;
	let verifyDir = null;
	let verifyArchivePath = null;
	let expectedArchive = null;
	let expectedBundle = null;
	let expectedManifest = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") {
			outDir = resolve(readValue(argv, i, "--out"));
			i += 1;
		} else if (arg === "--archive") {
			archivePath = resolve(readValue(argv, i, "--archive"));
			i += 1;
		} else if (arg === "--verify") {
			verifyDir = readValue(argv, i, "--verify");
			i += 1;
		} else if (arg === "--verify-archive") {
			verifyArchivePath = readValue(argv, i, "--verify-archive");
			i += 1;
		} else if (arg === "--expected-archive") {
			expectedArchive = readValue(argv, i, "--expected-archive");
			i += 1;
		} else if (arg === "--expected-bundle") {
			expectedBundle = readValue(argv, i, "--expected-bundle");
			i += 1;
		} else if (arg === "--expected-manifest") {
			expectedManifest = readValue(argv, i, "--expected-manifest");
			i += 1;
		} else {
			throw new Error(
				"Usage: node scripts/package-runtime-bundle-layer.mjs [--out <dir> | --archive <file.tar.gz> | --verify <dir> [--expected-manifest <sha64>] [--expected-bundle <sha64>] | --verify-archive <file.tar.gz> [--expected-archive <sha64>] [--expected-manifest <sha64>] [--expected-bundle <sha64>]]",
			);
		}
	}
	const modes = [outDir, archivePath, verifyDir, verifyArchivePath].filter(Boolean).length;
	if (modes > 1) {
		throw new Error("--out, --archive, --verify, and --verify-archive cannot be combined");
	}
	if (expectedArchive && !verifyArchivePath) {
		throw new Error("--expected-archive requires --verify-archive");
	}
	if (!verifyDir && !verifyArchivePath && (expectedBundle || expectedManifest)) {
		throw new Error("--expected-bundle and --expected-manifest require --verify or --verify-archive");
	}
	return {
		outDir: outDir ?? resolve(repositoryRoot, ".artifacts/runtime-bundle-layer"),
		archivePath,
		verifyDir,
		verifyArchivePath,
		expectedArchive,
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
	} else if (args.verifyArchivePath) {
		const { manifest, manifestSha256, archiveSha256, bytes } = verifyRuntimeBundleLayerArchive(
			args.verifyArchivePath,
			{
				expectedArchiveSha256: args.expectedArchive,
				expectedBundleSha256: args.expectedBundle,
				expectedManifestSha256: args.expectedManifest,
			},
		);
		process.stdout.write(
			`${JSON.stringify({ verified: true, runtimeBundleSha256: manifest.runtimeBundleSha256, manifestSha256, archiveSha256, bytes })}\n`,
		);
	} else if (args.archivePath) {
		const result = await packageRuntimeBundleLayerArchive({ archivePath: args.archivePath });
		process.stdout.write(
			`${JSON.stringify({ archivePath: result.archivePath, archiveSha256: result.archiveSha256, bytes: result.bytes, runtimeBundleSha256: result.manifest.runtimeBundleSha256, manifestSha256: result.manifestSha256 })}\n`,
		);
	} else {
		const result = await packageRuntimeBundleLayer({ outDir: args.outDir });
		process.stdout.write(
			`${JSON.stringify({ outputRoot: result.outputRoot, runtimeBundleSha256: result.manifest.runtimeBundleSha256, manifestSha256: result.manifestSha256 })}\n`,
		);
	}
}
