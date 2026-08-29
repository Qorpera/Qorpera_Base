import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
	throw new Error("Usage: node scripts/package-identity-recovery.mjs --out <new-directory>");
}
const output = resolve(args[1]);
// No overwrite or broad recursive cleanup. Each build gets a fresh artifact directory.
await mkdir(output, { mode: 0o700 });
await build({
	absWorkingDir: root,
	entryPoints: {
		"qorpera-identity-recovery-service": "packages/shell/src/cloud-identity-recovery-service-main.ts",
		"qorpera-identity-recovery-restore": "packages/shell/src/cloud-identity-recovery-restore-main.ts",
	},
	outdir: output, outExtension: { ".js": ".mjs" }, bundle: true,
	platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent",
});
await copyFile(join(root, "deploy/identity-recovery/qorpera-identity-recovery.service"), join(output, "qorpera-identity-recovery.service"));
const artifacts = [];
for (const file of ["qorpera-identity-recovery-service.mjs", "qorpera-identity-recovery-restore.mjs", "qorpera-identity-recovery.service"]) {
	const bytes = await readFile(join(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(join(output, "manifest.json"), JSON.stringify({ schema: "qorpera.identity-recovery-package/v1", artifacts }, null, 2)+"\n", { mode: 0o600 });
console.log(output);
