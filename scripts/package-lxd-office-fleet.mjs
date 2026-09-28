import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const [option, directory, ...extra] = process.argv.slice(2);
if (option !== "--out" || !directory || extra.length) throw new Error("Usage: node scripts/package-lxd-office-fleet.mjs --out NEW_DIRECTORY");
const output = resolve(directory);
await mkdir(output, { recursive: false });
const artifacts = [];
for (const [entry, file] of [
	["lxd-office-fleet-cli.ts", "qorpera-office-fleet.cjs"],
	["lxd-office-fleet-installation-cli.ts", "qorpera-office-fleet-install.cjs"],
	["lxd-office-node-base-cli.ts", "qorpera-office-node-base.cjs"],
]) {
	await build({ entryPoints: [`packages/runner-orchestrator/src/${entry}`], outfile: resolve(output, file), bundle: true,
		platform: "node", format: "cjs", target: "node22.19", legalComments: "none", logLevel: "silent" });
	const bytes = await readFile(resolve(output, file));
	artifacts.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.office-fleet-package/v1", artifacts }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, artifacts })}\n`);
