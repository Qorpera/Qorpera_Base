import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
	throw new Error("Usage: node scripts/package-model-login-helper.mjs --out <new-directory>");
}
const output = resolve(args[1]);
await mkdir(output, { mode: 0o700 });
await build({
	absWorkingDir: root,
	entryPoints: {
		"qorpera-model-login-helper": "packages/runtime/src/cloud-model-login-helper-main.ts",
		// The isolation launcher's child, shipped with the helper: a vault host runs no execution host.
		"qorpera-native-isolation-child": "packages/runtime/src/cloud-native-isolation-child.ts",
	},
	outdir: output,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	banner: {
		js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);',
	},
	legalComments: "none",
	logLevel: "silent",
});
await copyFile(
	join(root, "deploy/cloud-secret-broker/qorpera-model-login-helper.service"),
	join(output, "qorpera-model-login-helper.service"),
);
const artifacts = [];
for (const file of [
	"qorpera-model-login-helper.mjs",
	"qorpera-native-isolation-child.mjs",
	"qorpera-model-login-helper.service",
]) {
	const bytes = await readFile(join(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify({ schema: "qorpera.model-login-helper-package/v1", artifacts }, null, 2)}\n`,
	{ mode: 0o600 },
);
console.log(output);
