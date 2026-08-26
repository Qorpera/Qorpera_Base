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
 *
 * Publish with scripts/publish-shell-release.mjs — never `gh release upload`
 * the space-named exe directly (GitHub renames it and auto-update 404s).
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

// Packaging targets the platform it runs on. The closure copy below can only
// see the optional platform binaries npm installed for THIS host -- the Codex
// vendor packages are per-platform optional dependencies -- so cross-building
// would assemble an app whose agent binary is silently absent and the
// structural assertion at the end would (rightly) fail.
const isMac = process.platform === "darwin";
const codexTriple = isMac
	? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
	: (process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc");
const codexPlatformPackage = `codex-${isMac ? "darwin" : "win32"}-${process.arch}`;

// Workspace packages are copied as {package.json, dist} from their source dirs.
const workspaceDirs = {
	"@qorpera/company": "packages/company",
	"@qorpera/contracts": "packages/contracts",
	"@qorpera/pi-coding-agent": "packages/coding-agent",
	"@qorpera/pi-agent-core": "packages/agent",
	"@qorpera/pi-ai": "packages/ai",
	"@qorpera/pi-tui": "packages/tui",
	"@qorpera/pi-protocol": "packages/protocol",
	"@qorpera/pi-client": "packages/client",
	"@qorpera/pi-storage-sqlite-node": "packages/storage/sqlite-node",
};

/* The assembly below copies each workspace package's dist as it exists on
 * disk, so packing without rebuilding ships whatever was last compiled —
 * v0.20.15 shipped days-old dists this way and none of that release's
 * renderer changes reached users. Build the workspaces first; --no-build
 * (assembly only) remains for iterating on the packaging itself. */
if (!process.argv.includes("--no-build")) {
	const workspaceBuild = spawnSync("npm", ["run", "build", "--workspaces", "--if-present"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
	if (workspaceBuild.status !== 0) {
		console.error("pack-shell: workspace build failed");
		process.exit(1);
	}
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(join(appDir, "node_modules"), { recursive: true });

// 1. Shell code + product identity.
cpSync(join(repoRoot, "packages", "shell", "dist"), join(appDir, "dist"), { recursive: true });

/* Ad-hoc-signed builds cannot run their own binary as a sandboxed runtime
 * child (the child codesign check fails), so the app bundles the officially
 * signed Node and main falls back to it automatically until Developer ID
 * signing exists. */
const runtimeNode = join(repoRoot, "node_modules", ".qorpera-runtime-node", "bin", "node");
if (existsSync(runtimeNode)) {
	/* Outside node_modules on purpose: electron-builder prunes node_modules
	 * against the dependency list and silently dropped the binary when it
	 * lived there. */
	cpSync(runtimeNode, join(appDir, "runtime-node", "bin", "node"));
} else {
	console.warn("pack-shell: signed runtime node missing — ad-hoc builds will fail local execution");
}
writeFileSync(
	join(appDir, "package.json"),
	`${JSON.stringify(
		{
			name: "qorpera-base",
			productName: "Qorpera Base",
			version: productVersion,
			author: "Qorpera",
			private: true,
			type: "module",
			main: "dist/main.js",
			description: "Qorpera Base — the foundation every company controller is built on.",
			// electron-builder prunes node_modules against this dependency
			// list; without it the ENTIRE assembled closure (the agent
			// runtime) is silently dropped from the installer — shipped
			// hub-only apps until 0.15.0's repack caught it (2026-08-05).
			dependencies: {
				"@qorpera/pi-coding-agent": "*",
				...(shellPkg.dependencies ?? {}),
			},
		},
		null,
		"\t",
	)}\n`,
);

// 2. Production dependency closure, walked from the shell + coding agent.
const copied = new Set();
const missing = new Set();
const required = new Set();
const queue = ["@qorpera/pi-coding-agent", ...Object.keys(shellPkg.dependencies ?? {})].map((name) => ({
	name,
	required: true,
}));
while (queue.length > 0) {
	const { name, required: isRequired } = queue.shift();
	if (isRequired) required.add(name);
	if (copied.has(name) || name === "electron") continue;

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
			missing.add(name);
			continue;
		}
		cpSync(pkgDir, target, { recursive: true, dereference: true });
	}
	copied.add(name);

	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	for (const dep of Object.keys(pkg.dependencies ?? {})) {
		if (!copied.has(dep)) queue.push({ name: dep, required: true });
	}
	for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
		if (!copied.has(dep)) queue.push({ name: dep, required: false });
	}
}
const missingRequired = [...missing].filter((name) => required.has(name));
if (missingRequired.length > 0) {
	console.error(`required dependencies missing: ${missingRequired.join(", ")}`);
	process.exit(1);
}
const missingOptional = [...missing].filter((name) => !required.has(name));
if (missingOptional.length > 0) {
	console.warn(`optional dependencies skipped: ${missingOptional.join(", ")}`);
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
		"protocols:",
		'  - name: "Qorpera invitation"',
		"    schemes:",
		"      - qorpera",
		// The mac zip target is not optional: electron-updater updates from the
		// zip and only offers the dmg to humans. No signing identity is
		// configured here; electron-builder ad-hoc signs, which Apple Silicon
		// requires to launch at all. Real signing arrives via CSC_* env vars
		// without a config change.
		...(isMac
			? [
					"mac:",
					"  target:",
					"    - dmg",
					"    - zip",
					'  icon: "dist/assets/qorpera.png"',
					"  category: public.app-category.productivity",
				]
			: [
					"win:",
					"  target: nsis",
					'  icon: "dist/assets/qorpera.ico"',
					"nsis:",
					"  oneClick: true",
					"  perMachine: false",
				]),
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
	process.execPath,
	[join(rootModules, "electron-builder", "cli.js"), "--config", "electron-builder.yml", isMac ? "--mac" : "--win", "--publish", "never"],
	{ cwd: appDir, stdio: "inherit", shell: false },
);
if (builder.status !== 0) {
	console.error("electron-builder failed");
	process.exit(builder.status ?? 1);
}

// Structural assertion: the packed app must contain the agent and Codex runtimes.
// Guards against electron-builder pruning regressions — a hub-only app
// passes every smoke that doesn't open a company.
// electron-builder's unpacked output differs per platform: win-unpacked on
// Windows, mac[-arm64]/<Product>.app/Contents/Resources on macOS.
const packedResourcesRoot = isMac
	? join(outDir, process.arch === "arm64" ? "mac-arm64" : "mac", "Qorpera Base.app", "Contents", "Resources")
	: join(outDir, "win-unpacked", "resources");
const packedAppRoot = join(packedResourcesRoot, "app");
const packedRpcEntry = join(packedAppRoot, "node_modules", "@qorpera", "pi-coding-agent", "dist", "rpc-entry.js");
const packedCodexEntry = join(packedAppRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
const packedCodexExecutable = join(
	packedAppRoot,
	"node_modules",
	"@openai",
	codexPlatformPackage,
	"vendor",
	codexTriple,
	"bin",
	isMac ? "codex" : "codex.exe",
);
const packedRuntimeFiles = [packedRpcEntry, packedCodexEntry, packedCodexExecutable];
const missingPackedRuntimeFiles = packedRuntimeFiles.filter((path) => !existsSync(path));
if (missingPackedRuntimeFiles.length > 0) {
	console.error(`PACK VERIFICATION FAILED: runtime files missing:\n${missingPackedRuntimeFiles.join("\n")}`);
	process.exit(1);
}
console.log("pack verification: agent and Codex runtimes present in packed app");

// A structurally complete app can still ship an all-white Chromium frame.
// Exercise the unpacked packaged-mode renderer and let main reject a
// single-color capture before the installer is allowed to publish.
const packedShellExecutable = isMac
	? join(
			outDir,
			process.arch === "arm64" ? "mac-arm64" : "mac",
			"Qorpera Base.app",
			"Contents",
			"MacOS",
			"Qorpera Base",
		)
	: join(outDir, "win-unpacked", "Qorpera Base.exe");
const packedSmokeRoot = join(outDir, ".pack-smoke");
const packedSmokeShot = join(packedSmokeRoot, "shell.png");
const packedSmokeProfile = join(packedSmokeRoot, "profile");
rmSync(packedSmokeRoot, { recursive: true, force: true });
mkdirSync(packedSmokeRoot, { recursive: true });
const packedSmoke = spawnSync(
	packedShellExecutable,
	["--smoke-shot", packedSmokeShot, `--user-data-dir=${packedSmokeProfile}`],
	{
		encoding: "utf8",
		shell: false,
		timeout: 30_000,
		windowsHide: true,
	},
);
const packedSmokeOutput = `${packedSmoke.stdout ?? ""}${packedSmoke.stderr ?? ""}`.trim();
const packedSmokeDeadline = Date.now() + 30_000;
while (!existsSync(packedSmokeShot) && Date.now() < packedSmokeDeadline) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
if (packedSmoke.error || packedSmoke.status !== 0 || !existsSync(packedSmokeShot)) {
	console.error(`PACK VERIFICATION FAILED: packaged renderer did not paint\n${packedSmokeOutput}`);
	rmSync(packedSmokeRoot, { recursive: true, force: true });
	process.exit(packedSmoke.status ?? 1);
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
rmSync(packedSmokeRoot, { recursive: true, force: true });
console.log("pack verification: packaged renderer produced a nonblank frame");
console.log(`installer in ${outDir}`);
for (const file of readdirSync(outDir)) console.log(`  ${file}`);
