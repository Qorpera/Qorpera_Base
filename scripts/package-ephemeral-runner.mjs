import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

function outputDirectory(args) {
	if (args.length === 0) return resolve(".artifacts/ephemeral-runner");
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/package-ephemeral-runner.mjs [--out <directory>]");
	}
	return resolve(args[1]);
}

const outputRoot = outputDirectory(process.argv.slice(2));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
	entryPoints: {
		"qorpera-ephemeral-runner": "packages/shell/src/cloud-runner-service-main.ts",
		"qorpera-native-provider-host": "packages/shell/src/cloud-native-provider-service-main.ts",
		"qorpera-sandbox-probe": "packages/shell/src/cloud-runner-container-main.ts",
		"qorpera-lxd-runner-bootstrap": "packages/shell/src/lxd-runner-bootstrap-main.ts",
		"qorpera-lxd-native-login-bootstrap": "packages/shell/src/lxd-native-login-bootstrap-main.ts",
	},
	outdir: outputRoot,
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
await copyFile("deploy/ephemeral-runner/image/run-job", resolve(outputRoot, "run-job"));

const files = [
	"qorpera-ephemeral-runner.mjs",
	"qorpera-native-provider-host.mjs",
	"qorpera-sandbox-probe.mjs",
	"qorpera-lxd-runner-bootstrap.mjs",
	"qorpera-lxd-native-login-bootstrap.mjs",
	"run-job",
];
const artifacts = [];
for (const file of files) {
	const content = await readFile(resolve(outputRoot, file));
	artifacts.push({
		file,
		bytes: content.byteLength,
		sha256: createHash("sha256").update(content).digest("hex"),
	});
}
await writeFile(
	resolve(outputRoot, "manifest.json"),
	`${JSON.stringify({ schema: "qorpera.ephemeral-runner-package/v1", artifacts }, null, 2)}\n`,
	"utf-8",
);
console.log(outputRoot);
