import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

function outputDirectory(args) {
	if (args.length === 0) return resolve(".artifacts/runner-orchestrator");
	if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
		throw new Error("Usage: node scripts/package-runner-orchestrator.mjs [--out <directory>]");
	}
	return resolve(args[1]);
}

const outputRoot = outputDirectory(process.argv.slice(2));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const artifact = "qorpera-runner-orchestrator.mjs";
await build({
	entryPoints: ["packages/runner-orchestrator/src/cli.ts"],
	outfile: resolve(outputRoot, artifact),
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

const content = await readFile(resolve(outputRoot, artifact));
await writeFile(
	resolve(outputRoot, "manifest.json"),
	`${JSON.stringify(
		{
			schema: "qorpera.runner-orchestrator-package/v1",
			runtime: { node: ">=22.19.0" },
			artifacts: [
				{
					file: artifact,
					bytes: content.byteLength,
					sha256: createHash("sha256").update(content).digest("hex"),
				},
			],
		},
		null,
		2,
	)}\n`,
	"utf-8",
);
console.log(outputRoot);
