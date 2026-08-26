import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function options(args) {
	let outputRoot = resolve(repositoryRoot, ".artifacts/lxd-company-computer-guest");
	const runnerArgs = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--out" && args[index + 1]) {
			outputRoot = resolve(args[++index]);
		} else if (argument === "--signed-runner-image" && args[index + 1]) {
			runnerArgs.push("--signed-runner-image", args[++index]);
		} else if (argument === "--contract-only") {
			runnerArgs.push("--contract-only");
		} else {
			throw new Error(
				"Usage: node scripts/package-lxd-company-computer-guest.mjs [--out <directory>] [--signed-runner-image <directory> | --contract-only]",
			);
		}
	}
	return { outputRoot, runnerArgs };
}

const { outputRoot, runnerArgs } = options(process.argv.slice(2));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

// The Company Computer image is a strict superset of the runner image: the
// complete runner guest package nests under runner/ and is pinned by its
// manifest hash, so the runner lane on the shared machine is byte-for-byte
// the reviewed runner contract.
const runnerPackaged = spawnSync(
	process.execPath,
	[
		resolve(repositoryRoot, "scripts/package-lxd-runner-guest.mjs"),
		"--out",
		join(outputRoot, "runner"),
		...runnerArgs,
	],
	{ cwd: repositoryRoot, encoding: "utf-8" },
);
if (runnerPackaged.status !== 0) throw new Error(runnerPackaged.stderr || "Runner guest packaging failed");

await build({
	entryPoints: {
		"qorpera-company-computer-bootstrap": "packages/shell/src/cloud-company-computer-bootstrap-main.ts",
		"qorpera-company-computer-sync": "packages/shell/src/cloud-company-computer-sync-main.ts",
		"qorpera-company-computer-screens": "packages/shell/src/cloud-company-computer-screens-main.ts",
		"qorpera-company-computer-runner": "packages/shell/src/cloud-company-computer-runner-main.ts",
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

const sources = new Map([
	[
		"qorpera-company-computer-bootstrap.service",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-company-computer-bootstrap.service"),
	],
	[
		"qorpera-company-computer-sync.service",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-company-computer-sync.service"),
	],
	[
		"qorpera-company-computer-screens.service",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-company-computer-screens.service"),
	],
	[
		"qorpera-company-computer-runner.service",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-company-computer-runner.service"),
	],
	[
		"qorpera-screen-session",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-screen-session"),
	],
	[
		"install-image-contract.sh",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/install-image-contract.sh"),
	],
]);
for (const [file, source] of sources) await copyFile(source, join(outputRoot, file));
await chmod(join(outputRoot, "qorpera-screen-session"), 0o555);
await chmod(join(outputRoot, "install-image-contract.sh"), 0o555);

const files = [
	"install-image-contract.sh",
	"qorpera-company-computer-bootstrap.mjs",
	"qorpera-company-computer-bootstrap.service",
	"qorpera-company-computer-runner.mjs",
	"qorpera-company-computer-runner.service",
	"qorpera-company-computer-screens.mjs",
	"qorpera-company-computer-screens.service",
	"qorpera-company-computer-sync.mjs",
	"qorpera-company-computer-sync.service",
	"qorpera-screen-session",
];
const artifacts = [];
for (const file of files) {
	const content = await readFile(join(outputRoot, file));
	artifacts.push({
		file,
		bytes: content.byteLength,
		sha256: createHash("sha256").update(content).digest("hex"),
	});
}
const runnerManifest = await readFile(join(outputRoot, "runner/manifest.json"));
await writeFile(
	join(outputRoot, "manifest.json"),
	`${JSON.stringify(
		{
			schema: "qorpera.lxd-company-computer-guest-package/v1",
			platform: "linux-x64",
			desktopStack: "xfce4-tigervnc",
			runnerPackage: {
				manifestSha256: createHash("sha256").update(runnerManifest).digest("hex"),
			},
			artifacts,
		},
		null,
		2,
	)}\n`,
	"utf-8",
);
console.log(outputRoot);
