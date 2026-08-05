/**
 * Assemble the distributable Qorpera Base app and build the installer.
 *
 * Monorepo-immune packaging: instead of teaching electron-builder about npm
 * workspaces, we assemble a self-contained app directory —
 *
 *   build/shell-app/
 *     package.json            (product identity + version)
 *     dist/…                  (shell main/preload/renderer)
 *     node_modules/…          (@qorpera/* dists + full production closure)
 *
 * — and point electron-builder at that. asar is OFF on purpose: the shell
 * spawns the coding agent's rpc-entry as a real file with
 * ELECTRON_RUN_AS_NODE, and jiti loads extension TypeScript from disk at
 * runtime; archives buy risk here, not value.
 *
 * Usage: node scripts/pack-shell.mjs [--no-build]   (installer lands in build/shell-dist)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(repoRoot, "build", "shell-app");
const outDir = join(repoRoot, "build", "shell-dist");
const rootModules = join(repoRoot, "node_modules");

const shellPkg = JSON.parse(readFileSync(join(repoRoot, "packages", "shell", "package.json"), "utf8"));
const productVersion = shellPkg.productVersion ?? "0.1.0";
const electronVersion = shellPkg.devDependencies.electron;

// Workspace packages are copied as {package.json, dist} from their source dirs.
const workspaceDirs = {
	"@qorpera/pi-coding-agent": "packages/coding-agent",
	"@qorpera/pi-agent-core": "packages/agent",
	"@qorpera/pi-ai": "packages/ai",
	"@qorpera/pi-tui": "packages/tui",
	"@qorpera/pi-protocol": "packages/protocol",
	"@qorpera/pi-client": "packages/client",
	"@qorpera/pi-server": "packages/server",
	"@qorpera/pi-storage-sqlite-node": "packages/storage/sqlite-node",
};

rmSync(appDir, { recursive: true, force: true });
mkdirSync(join(appDir, "node_modules"), { recursive: true });

// 1. Shell code + product identity.
cpSync(join(repoRoot, "packages", "shell", "dist"), join(appDir, "dist"), { recursive: true });
writeFileSync(
	join(appDir, "package.json"),
	`${JSON.stringify(
		{
			name: "qorpera-base",
			productName: "Qorpera Base",
			version: productVersion,
			private: true,
			type: "module",
			main: "dist/main.js",
			description: "Qorpera Base — the foundation every company controller is built on.",
		},
		null,
		"\t",
	)}\n`,
);

// 2. Production dependency closure, walked from the shell + coding agent.
const copied = new Set();
const missing = [];
const queue = ["@qorpera/pi-coding-agent", ...Object.keys(shellPkg.dependencies ?? {})];
while (queue.length > 0) {
	const name = queue.shift();
	if (copied.has(name) || name === "electron") continue;
	copied.add(name);

	let pkgDir;
	const target = join(appDir, "node_modules", ...name.split("/"));
	if (workspaceDirs[name]) {
		pkgDir = join(repoRoot, workspaceDirs[name]);
		mkdirSync(target, { recursive: true });
		cpSync(join(pkgDir, "package.json"), join(target, "package.json"));
		if (existsSync(join(pkgDir, "dist"))) {
			cpSync(join(pkgDir, "dist"), join(target, "dist"), { recursive: true });
		}
		// The coding agent serves docs/themes at runtime; keep them.
		for (const extra of ["docs", "README.md"]) {
			if (existsSync(join(pkgDir, extra))) cpSync(join(pkgDir, extra), join(target, extra), { recursive: true });
		}
	} else {
		pkgDir = join(rootModules, ...name.split("/"));
		if (!existsSync(pkgDir)) {
			missing.push(name);
			continue;
		}
		cpSync(pkgDir, target, { recursive: true, dereference: true });
	}

	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
		if (!copied.has(dep)) queue.push(dep);
	}
}
if (missing.length > 0) {
	console.warn(`optional/missing deps skipped: ${missing.join(", ")}`);
}
console.log(`assembled ${copied.size} packages into ${appDir}`);

// 3. electron-builder config + run.
writeFileSync(
	join(appDir, "electron-builder.yml"),
	[
		"appId: com.qorpera.base",
		'productName: "Qorpera Base"',
		`electronVersion: "${electronVersion}"`,
		"asar: false",
		"npmRebuild: false",
		"nodeGypRebuild: false",
		"directories:",
		`  output: "${outDir.replace(/\\/g, "/")}"`,
		"files:",
		'  - "**/*"',
		"win:",
		"  target: nsis",
		'  icon: "dist/assets/qorpera.ico"',
		"nsis:",
		"  oneClick: true",
		"  perMachine: false",
		"publish:",
		"  provider: github",
		"  owner: Qorpera",
		"  repo: Qorpera_Base_Releases",
		"",
	].join("\n"),
);

if (process.argv.includes("--no-build")) {
	console.log("assembly only (--no-build)");
	process.exit(0);
}
const builder = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["electron-builder", "--config", "electron-builder.yml", "--win", "--publish", "never"],
	{ cwd: appDir, stdio: "inherit", shell: process.platform === "win32" },
);
if (builder.status !== 0) {
	console.error("electron-builder failed");
	process.exit(builder.status ?? 1);
}
console.log(`installer in ${outDir}`);
for (const file of readdirSync(outDir)) console.log(`  ${file}`);
