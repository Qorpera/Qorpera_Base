import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(repository, "deploy/first-node/native-codex/source-guest-package-manifest.json");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
	throw new Error("Usage: node scripts/generate-lxd-guest-source-manifest.mjs [--check]");
}
// This records buildable source bytes. The sealed v56 manifest and its image,
// archive, signature and acceptance pins remain a separate historical record.
const bundle = await generateCloudRuntimeBundle(true);
const output = await mkdtemp(join(tmpdir(), "qorpera-source-guest-"));
try {
	const packaged = spawnSync(process.execPath, ["scripts/package-lxd-runner-guest.mjs", "--out", output, "--contract-only"], {
		cwd: repository, encoding: "utf8", timeout: 60_000,
	});
	if (packaged.status !== 0) throw new Error(packaged.error?.message || packaged.stderr || "Guest packaging failed");
	const manifest = {
		schema: "qorpera.lxd-guest-source/v1",
		runtimeBundleSha256: bundle.sha256,
		package: JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
	};
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	if (process.argv.includes("--check")) {
		if (await readFile(destination, "utf8").catch(() => null) !== text) {
			throw new Error("Source guest package is stale; run node scripts/generate-lxd-guest-source-manifest.mjs");
		}
	} else await writeFile(destination, text);
	console.log(`Source guest package for runtime ${bundle.sha256}: ${process.argv.includes("--check") ? "verified" : "generated"}`);
} finally {
	await rm(output, { recursive: true, force: true });
}
