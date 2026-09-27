import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error("Usage: node scripts/package-runtime-node-updater.mjs --out <owned-output-directory>");
const output = resolve(args[1]);
await mkdir(output, { recursive: true });
await build({ entryPoints: ["packages/runner-orchestrator/src/runtime-node-update-cli.ts"], outfile: resolve(output, "qorpera-node-updater.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22.19", legalComments: "none", logLevel: "silent" });
const names = ["qorpera-node-updater.cjs", "qorpera-node-updater.service", "qorpera-node-updater.timer"], artifacts = [];
for (const file of names) {
	if (!file.endsWith(".cjs")) await writeFile(resolve(output, file), await readFile(resolve("deploy/first-node", file)));
	const bytes = await readFile(resolve(output, file));
	artifacts.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.node-updater-package/v1", runtime: { node: ">=22.19.0" }, artifacts }, null, 2)}\n`);
console.log(output);
