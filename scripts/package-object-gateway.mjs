import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

function outputDirectory(args) {
	if (args.length === 0) return resolve(".artifacts/object-gateway");
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/package-object-gateway.mjs [--out <directory>]");
	}
	return resolve(args[1]);
}

const outputRoot = outputDirectory(process.argv.slice(2));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const entryPoints = [["packages/object-gateway/src/cli.ts", "qorpera-object-gateway.mjs"]];
for (const [entryPoint, file] of entryPoints) {
	await build({
		entryPoints: [entryPoint],
		outfile: resolve(outputRoot, file),
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
}

const artifacts = [];
for (const [, file] of entryPoints) {
	const content = await readFile(resolve(outputRoot, file));
	artifacts.push({ file, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") });
}
await writeFile(
	resolve(outputRoot, "manifest.json"),
	`${JSON.stringify({ schema: "qorpera.object-gateway-package/v1", runtime: { node: ">=22.19.0" }, artifacts }, null, 2)}\n`,
	"utf-8",
);
console.log(outputRoot);
