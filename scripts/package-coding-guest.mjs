import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

if (process.argv.length !== 4 || process.argv[2] !== "--out") {
	throw new Error("Usage: package-coding-guest.mjs --out <new-directory>");
}
const output = resolve(process.argv[3]);
const sources = [
	["packages/runtime/src/cloud-coding-storage-guest-main.ts", "cloud-coding-storage-guest.mjs"],
	["packages/runtime/src/cloud-coding-command-guest.ts", "cloud-coding-command-guest.mjs"],
	["packages/runtime/src/cloud-coding-git-guest.ts", "cloud-coding-git-guest.mjs"],
	["packages/runtime/src/cloud-coding-watchdog-main.ts", "cloud-coding-watchdog.mjs"],
];
// Read every prerequisite before creating an output directory. Packaging cannot
// install an image or mutate guest/host services; its output is reviewable data.
await Promise.all(sources.map(([source]) => readFile(source)));
const installation = JSON.parse(await readFile("deploy/coding-worker/command-guest-installation.json", "utf8"));
await mkdir(output, { recursive: false, mode: 0o700 });
const artifacts = [];
for (const [source, file] of sources) {
	await build({
		entryPoints: [source],
		outfile: resolve(output, file),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		legalComments: "none",
		logLevel: "silent",
	});
	const bytes = await readFile(resolve(output, file));
	if (bytes.length > 65536) throw new Error(`Coding guest artifact exceeds protected transport bound: ${file}`);
	artifacts.push({ file, source, installedPath: `/opt/qorpera-coding/${file}`, owner: "root:root", mode: "0444",
		sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({
	schema: "qorpera.coding-guest-package/v1", artifacts, installation, installationPerformed: false,
}, null, 2)}\n`, { mode: 0o600 });
console.log(output);
