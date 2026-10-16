// Builds what P3 (test/prove-coding-session-vm.sh) pushes, from this checkout, into a new directory:
//   guest/         today's coding guest package (scripts/package-coding-guest.mjs: the image's /opt/qorpera-coding)
//   p3/p3-executor.mjs  the node's executor composition (p3-executor.ts)
//   p3/p3-gateway.mjs   the runtime's coding command gateway, for the driver (the runtime's side of the HTTP)
//
//   node deploy/coding-worker/test/p3-package.mjs --out <new directory>
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

if (process.argv.length !== 4 || process.argv[2] !== "--out") throw new Error("Usage: p3-package.mjs --out <new-directory>");
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: false, mode: 0o755 });
execFileSync(process.execPath, ["scripts/package-coding-guest.mjs", "--out", resolve(output, "guest")], { stdio: ["ignore", "ignore", "inherit"] });
await mkdir(resolve(output, "p3"), { mode: 0o755 });
for (const [entry, file] of [
	["deploy/coding-worker/test/p3-executor.ts", "p3-executor.mjs"],
	["packages/runtime/src/cloud-coding-command-http.ts", "p3-gateway.mjs"],
]) {
	await build({ entryPoints: [entry], outfile: resolve(output, "p3", file),
		bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "warning" });
}
console.log(output);
