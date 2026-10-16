import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";

if (process.argv.length !== 4 || process.argv[2] !== "--out") throw new Error("Usage: package-coding-executor.mjs --out <new-directory>");
const output = resolve(process.argv[3]);
const bundle = await generateCloudRuntimeBundle(true);
await mkdir(output, { recursive: false, mode: 0o700 });
// v2: the executor and the host watchdog (qorpera-coding-host-watchdog.service), each its own bundle so
// neither carries the other's main.
const files = [];
for (const [entry, file] of [
	["deploy/coding-worker/executor.ts", "qorpera-coding-executor.mjs"],
	["deploy/coding-worker/host-watchdog.ts", "qorpera-coding-host-watchdog.mjs"],
]) {
	await build({ entryPoints: [entry], outfile: resolve(output, file),
		bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" });
	const bytes = await readFile(resolve(output, file));
	files.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.coding-executor-package/v2",
	runtimeBundleSha256: bundle.sha256, files }, null, 2)}\n`);
console.log(output);
