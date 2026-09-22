import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { jitlessServiceBundleOptions } from "./jitless-service-bundle.mjs";

/** Shared execution package: the service that turns one execution host VM
 * into a sandbox pool, its slot unit templates, the co-located orchestrator
 * and the fail-closed guest installer. Installed on top of the pinned runner
 * guest image; the image itself is not part of this package. */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outputDirectory(args) {
	if (args.length === 0) return resolve(".artifacts/shared-execution");
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/package-shared-execution-service.mjs [--out <directory>]");
	}
	return resolve(args[1]);
}

const outputRoot = outputDirectory(process.argv.slice(2));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const entryPoints = [
	["packages/runner-orchestrator/src/shared-execution-cli.ts", "qorpera-shared-execution-service.mjs"],
	["packages/runner-orchestrator/src/cli.ts", "qorpera-runner-orchestrator.mjs"],
];
for (const [entryPoint, file] of entryPoints) {
	await build({
		entryPoints: [resolve(repositoryRoot, entryPoint)],
		outfile: resolve(outputRoot, file),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		...jitlessServiceBundleOptions,
		legalComments: "none",
		logLevel: "silent",
	});
}
const copies = [
	"deploy/shared-execution/qorpera-shared-execution.service",
	"deploy/shared-execution/qorpera-shared-run-host@.service",
	"deploy/shared-execution/qorpera-shared-runner@.service",
	"deploy/shared-execution/shared-execution.env.example",
	"deploy/shared-execution/install-shared-execution-guest.sh",
	"deploy/first-node/qorpera-runner-orchestrator.service",
];
for (const source of copies) {
	await copyFile(resolve(repositoryRoot, source), resolve(outputRoot, source.split("/").at(-1)));
}

const files = [...entryPoints.map(([, file]) => file), ...copies.map((source) => source.split("/").at(-1))].sort((a, b) =>
	a.localeCompare(b, "en"),
);
const artifacts = [];
for (const file of files) {
	const content = await readFile(resolve(outputRoot, file));
	artifacts.push({ file, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") });
}
await writeFile(
	resolve(outputRoot, "manifest.json"),
	`${JSON.stringify(
		{
			schema: "qorpera.shared-execution-package/v1",
			runtime: { node: ">=22.19.0", systemd: ">=255" },
			artifacts,
		},
		null,
		2,
	)}\n`,
	"utf-8",
);
console.log(outputRoot);
