import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const STAFF_CREATURES = ["pebble", "folio", "brain", "wisp", "halo", "ribbon", "bloom"];
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
	["company-lock-heartbeat.mjs", join(outputRoot, "runner", "company-lock-heartbeat.mjs")],
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
		"qorpera-chrome",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-chrome"),
	],
	[
		"qorpera-chrome.desktop",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/qorpera-chrome.desktop"),
	],
	[
		"xfce4-panel.xml",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/xfce4-panel.xml"),
	],
	[
		"google-chrome-signing-key.asc",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/google-chrome-signing-key.asc"),
	],
	[
		"install-image-contract.sh",
		resolve(repositoryRoot, "deploy/lxd-company-computer-guest/install-image-contract.sh"),
	],
]);
for (const [file, source] of sources) await copyFile(source, join(outputRoot, file));
await chmod(join(outputRoot, "qorpera-screen-session"), 0o555);
await chmod(join(outputRoot, "qorpera-chrome"), 0o555);
await chmod(join(outputRoot, "install-image-contract.sh"), 0o555);

// One wallpaper per creature: the screen agent dresses each screen with its
// owning agent's creature, so the image bakes the whole cast. Generated
// here from the shell's creature art so desktop and sidepanel card always
// share one source of truth.
await mkdir(join(outputRoot, "wallpapers"), { recursive: true });
for (const creature of STAFF_CREATURES) {
	const art = await readFile(
		resolve(repositoryRoot, `packages/shell/userland/staff-creatures/${creature}.png`),
	);
	const encoded = art.toString("base64");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="2560" height="1600" viewBox="0 0 2560 1600">
<defs>
<radialGradient id="field" cx="50%" cy="38%" r="85%">
<stop offset="0%" stop-color="#f4f5f6"/>
<stop offset="52%" stop-color="#e6e8ea"/>
<stop offset="100%" stop-color="#cfd3d7"/>
</radialGradient>
<filter id="tint-light" color-interpolation-filters="sRGB">
<feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.85 0"/>
<feGaussianBlur stdDeviation="3"/>
</filter>
<filter id="tint-dark" color-interpolation-filters="sRGB">
<feColorMatrix type="matrix" values="0 0 0 0 0.38  0 0 0 0 0.40  0 0 0 0 0.43  0 0 0 0.34 0"/>
</filter>
</defs>
<rect width="2560" height="1600" fill="url(#field)"/>
<image x="1005" y="530" width="550" height="550" filter="url(#tint-light)" transform="translate(0 5)" xlink:href="data:image/png;base64,${encoded}"/>
<image x="1005" y="530" width="550" height="550" filter="url(#tint-dark)" xlink:href="data:image/png;base64,${encoded}"/>
</svg>
`;
	await writeFile(join(outputRoot, "wallpapers", `${creature}.svg`), svg, "utf-8");
}

const files = [
	"company-lock-heartbeat.mjs",
	"google-chrome-signing-key.asc",
	"install-image-contract.sh",
	"qorpera-chrome",
	"qorpera-chrome.desktop",
	"qorpera-company-computer-bootstrap.mjs",
	"qorpera-company-computer-bootstrap.service",
	"qorpera-company-computer-runner.mjs",
	"qorpera-company-computer-runner.service",
	"qorpera-company-computer-screens.mjs",
	"qorpera-company-computer-screens.service",
	"qorpera-company-computer-sync.mjs",
	"qorpera-company-computer-sync.service",
	"qorpera-screen-session",
	"xfce4-panel.xml",
	...STAFF_CREATURES.map((creature) => `wallpapers/${creature}.svg`),
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
