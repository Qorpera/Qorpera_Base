import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { CLOUD_RUNTIME_ENTRY_POINTS, generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";

function outputDirectory(args) {
	if (args.length === 0) return resolve(".artifacts/ephemeral-runner");
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/package-ephemeral-runner.mjs [--out <directory>]");
	}
	return resolve(args[1]);
}

const outputRoot = outputDirectory(process.argv.slice(2));
// Verify before touching the output. A stale compiled policy must not ship.
const runtimeBundle = await generateCloudRuntimeBundle(true);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
	entryPoints: CLOUD_RUNTIME_ENTRY_POINTS,
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
	"company-lock-heartbeat.mjs",
	"qorpera-ephemeral-runner.mjs",
	"qorpera-native-provider-host.mjs",
	"qorpera-identity-recovery-restore.mjs",
	"qorpera-native-isolation-child.mjs",
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
	`${JSON.stringify({ schema: "qorpera.ephemeral-runner-package/v1", runtimeBundleSha256: runtimeBundle.sha256, artifacts }, null, 2)}\n`,
	"utf-8",
);
console.log(outputRoot);
