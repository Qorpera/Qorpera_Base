import { createHash, X509Certificate } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runtimeAssetsPlugin } from "./runtime-assets-plugin.mjs";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ESM_REQUIRE_BANNER = Object.freeze({
	js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);',
});

export function parseOutArg(args, { usage, defaultDir = null } = {}) {
	if (args.length === 0 && defaultDir !== null) return resolve(defaultDir);
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error(usage);
	return resolve(args[1]);
}

export function parseFlagMap(args, { allowed, usage }) {
	const allowedSet = new Set(allowed);
	const options = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const [name, value] = [args[index], args[index + 1]];
		if (!allowedSet.has(name) || !value || options.has(name)) throw new Error(usage);
		options.set(name, value);
	}
	return options;
}

export async function prepareOutputDir(outputRoot, { clean = false, mode } = {}) {
	if (clean) await rm(outputRoot, { recursive: true, force: true });
	await mkdir(outputRoot, clean ? { recursive: true, ...(mode ? { mode } : {}) } : { recursive: false, ...(mode ? { mode } : {}) });
	return outputRoot;
}

export async function bundleNodeEntries({
	entries,
	outputRoot,
	format = "esm",
	target = "node22.19",
	banner,
	external,
	extraOptions,
	root = REPOSITORY_ROOT,
}) {
	const plugins = [...(extraOptions?.plugins ?? []), runtimeAssetsPlugin(root)];
	for (const entry of entries) {
		const [source, file, overrides = {}] = Array.isArray(entry) ? entry : [entry.source, entry.file, entry.options ?? {}];
		await build({
			absWorkingDir: root,
			entryPoints: [resolve(root, source)],
			outfile: resolve(outputRoot, file),
			bundle: true,
			platform: "node",
			format,
			target,
			minifyWhitespace: true,
			minifySyntax: true,
			...(banner ? { banner } : {}),
			...(external ? { external } : {}),
			...extraOptions,
			...overrides,
			plugins: [...plugins, ...(overrides.plugins ?? [])],
			legalComments: "none",
			logLevel: "silent",
		});
	}
}

export async function copyPackageFiles(copies, outputRoot, root = REPOSITORY_ROOT) {
	for (const entry of copies) {
		const [source, destName, mode] = Array.isArray(entry)
			? entry
			: [entry, entry.split("/").at(-1), undefined];
		const target = join(outputRoot, destName);
		await copyFile(resolve(root, source), target);
		if (mode !== undefined) await chmod(target, mode);
	}
}

export function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function hashPackageFiles(files, outputRoot) {
	const artifacts = [];
	for (const file of files) {
		const bytes = await readFile(join(outputRoot, file));
		artifacts.push({ file, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
	}
	return artifacts;
}

export async function writeManifest(outputRoot, manifest, options) {
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	await writeFile(join(outputRoot, "manifest.json"), text, options ?? "utf-8");
	return text;
}

export async function readLinuxX64Elf(filePath, errorMessage) {
	const bytes = await readFile(filePath);
	if (bytes.subarray(0, 4).toString("latin1") !== "\x7fELF" || bytes.readUInt16LE(18) !== 62) {
		throw new Error(errorMessage);
	}
	return bytes;
}

export async function loadDatabaseOwnCa(file, sha256) {
	if (file === undefined && sha256 === undefined) return undefined;
	if (file === undefined || sha256 === undefined) {
		throw new Error("--database-ca and --database-ca-sha256 go together");
	}
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("--database-ca-sha256 is not a sha256 (64 lowercase hex digits)");
	if (!(await lstat(file)).isFile()) throw new Error("--database-ca is not a regular file");
	const bytes = await readFile(file);
	if (bytes.byteLength > 64 * 1024) throw new Error("--database-ca exceeds 64 KiB limit");
	if (sha256Hex(bytes) !== sha256) {
		throw new Error("--database-ca does not match --database-ca-sha256");
	}
	const pem = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;
	let certificate;
	try {
		if (!pem.test(bytes.toString("utf8"))) throw new Error();
		certificate = new X509Certificate(bytes);
	} catch {
		throw new Error("--database-ca is not one PEM certificate");
	}
	if (certificate.ca !== true) throw new Error("--database-ca is not a CA certificate");
	return { bytes, sha256 };
}

export async function writeDatabaseOwnCaFiles(outputRoot, ownCa, dropInLines) {
	if (!ownCa) return [];
	await writeFile(join(outputRoot, "database-own-ca.crt"), ownCa.bytes, { mode: 0o644, flag: "wx" });
	await writeFile(join(outputRoot, "database-own-ca.sha256"), `${ownCa.sha256}\n`, { mode: 0o644, flag: "wx" });
	await writeFile(join(outputRoot, "database-own-ca.conf"), `${dropInLines.join("\n")}\n`, { mode: 0o644, flag: "wx" });
	return ["database-own-ca.crt", "database-own-ca.sha256", "database-own-ca.conf"];
}
