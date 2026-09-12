import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error("Usage: node scripts/package-lxd-office-provider.mjs --out <owned-output-directory>");
const output = resolve(args[1]);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Node 22's ESM facade for node:http evaluates its WebSocket getter and loads
// Undici/WASM even for a named request import. CJS keeps the native HTTP
// transport usable under --jitless without weakening service hardening.
const artifacts = [];
for (const [entry, file] of [
	["lxd-office-provider-cli.ts", "qorpera-office-provider.cjs"],
	["lxd-office-host-namespace-cli.ts", "qorpera-office-host-namespace.cjs"],
	["lxd-office-installation-cli.ts", "qorpera-office-provider-install.cjs"],
	["lxd-office-software-update-cli.ts", "qorpera-office-software-update.cjs"],
]) {
	await build({ entryPoints: [`packages/runner-orchestrator/src/${entry}`], outfile: resolve(output, file), bundle: true, platform: "node", format: "cjs", target: "node22.19", legalComments: "none", logLevel: "silent" });
	const bytes = await readFile(resolve(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
for (const file of ["qorpera-office-provider.service.in", "qorpera-office-host-namespace.service"]) {
	const bytes = await readFile(resolve("deploy/first-node", file));
	await writeFile(resolve(output, file), bytes);
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.lxd-office-provider-package/v1", runtime: { node: ">=22.19.0", platform: "linux" }, artifacts }, null, 2)}\n`);
console.log(JSON.stringify({ output, artifacts }));
