import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";

if (process.argv.length !== 4 || process.argv[2] !== "--out") throw new Error("Usage: package-coding-executor.mjs --out <new-directory>");
const output = resolve(process.argv[3]);
const bundle = await generateCloudRuntimeBundle(true);
await mkdir(output, { recursive: false, mode: 0o700 });
const file = "qorpera-coding-executor.mjs";
await build({ entryPoints: ["deploy/coding-worker/executor.ts"], outfile: resolve(output, file),
	bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" });
const bytes = await readFile(resolve(output, file));
const artifacts = [];
const guardFile = "qorpera-paid-computer-guard.mjs";
await build({ entryPoints: ["deploy/coding-worker/paid-computer-guard.ts"], outfile: resolve(output, guardFile),
	bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" });
for (const name of [guardFile, "qorpera-paid-computer-guard.service", "qorpera-coding-paid.conf"]) {
	const artifact = name === guardFile ? await readFile(resolve(output, name)) : await readFile(`deploy/coding-worker/${name}`);
	if (name !== guardFile) await writeFile(resolve(output, name), artifact);
	artifacts.push({ file: name, sha256: createHash("sha256").update(artifact).digest("hex"), bytes: artifact.length });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.coding-executor-package/v1",
	runtimeBundleSha256: bundle.sha256, file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, artifacts }, null, 2)}\n`);
console.log(output);
