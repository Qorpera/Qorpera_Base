import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { COMPANY_COMPUTER_WALLPAPER_FILES } from "../packages/runtime/src/cloud-company-computer-wallpapers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
	throw new Error("Usage: node scripts/package-company-computer.mjs --out <new-directory>");
}
const output = resolve(args[1]);
const wallpaperRoot = join(root, "deploy/lxd-company-computer-guest/backdrops");
const wallpapers = await readdir(wallpaperRoot, { withFileTypes: true });
if (wallpapers.some((entry) => !entry.isFile()) || wallpapers.map((entry) => entry.name).sort().join() !== COMPANY_COMPUTER_WALLPAPER_FILES.join()) {
	throw new Error("Office wallpaper inventory differs from the runtime catalog");
}
// Never overwrite an existing candidate, source directory or mounted state.
await mkdir(output, { mode: 0o700 });
const bundled = await build({
	absWorkingDir: root,
	entryPoints: {
		"qorpera-company-computer-service": "packages/runtime/src/cloud-company-computer-service-main.ts",
		"qorpera-company-computer-preparation": "packages/runtime/src/cloud-company-computer-preparation-main.ts",
		"qorpera-company-computer-preparation-control": "packages/runtime/src/cloud-company-computer-preparation-control-main.ts",
		"qorpera-company-computer-configuration-control": "packages/runtime/src/cloud-company-computer-configuration-control-main.ts",
		"qorpera-company-computer-boot-configuration-control": "packages/runtime/src/cloud-company-computer-boot-configuration-control-main.ts",
		"qorpera-company-computer-boot-service-restart-control": "packages/runtime/src/cloud-company-computer-boot-service-restart-control-main.ts",
		"qorpera-company-computer-reset-service-restart-control": "packages/runtime/src/cloud-company-computer-reset-service-restart-control-main.ts",
		"qorpera-company-computer-boot-service-start-control": "packages/runtime/src/cloud-company-computer-boot-service-start-control-main.ts",
		"qorpera-company-computer-service-start-control": "packages/runtime/src/cloud-company-computer-service-start-control-main.ts",
		"qorpera-company-computer-service-stop-control": "packages/runtime/src/cloud-company-computer-service-stop-control-main.ts",
		"qorpera-company-computer-service-restart-control": "packages/runtime/src/cloud-company-computer-service-restart-control-main.ts",
		"qorpera-company-computer-reset-configuration-control": "packages/runtime/src/cloud-company-computer-reset-configuration-control-main.ts",
		"qorpera-company-computer-reset-service-start-control": "packages/runtime/src/cloud-company-computer-reset-service-start-control-main.ts",
		"office-browser-child": "packages/runtime/src/cloud-company-computer-browser-child.ts",
	},
	outdir: output, outExtension: { ".js": ".mjs" }, bundle: true,
	external: ["playwright-core"], platform: "node", format: "esm", target: "node22.19", metafile: true,
	banner: { js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);' },
	legalComments: "none", logLevel: "silent",
});
if (Object.keys(bundled.metafile.inputs).some((path) => /packages\/shell\/|node_modules\/electron(?:-updater)?\//.test(path))) {
	throw new Error("Office package contains desktop implementation");
}
await build({ absWorkingDir: root, entryPoints: ["packages/runner-orchestrator/src/lxd-office-image-installation-cli.ts"], outfile: join(output, "qorpera-office-image-install.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22.19", legalComments: "none", logLevel: "silent" });

async function copyTree(source, destination) {
	await mkdir(destination, { mode: 0o755 });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.isDirectory()) await copyTree(join(source, entry.name), join(destination, entry.name));
		else if (entry.isFile()) {
			await copyFile(join(source, entry.name), join(destination, entry.name));
			await chmod(join(destination, entry.name), 0o444);
		} else throw new Error("Office package dependency contains a non-regular entry");
	}
}
const require = createRequire(import.meta.url);
const playwright = dirname(require.resolve("playwright-core/package.json"));
const metadata = JSON.parse(await readFile(join(playwright, "package.json"), "utf8"));
const runtime = JSON.parse(await readFile(join(root, "packages/runtime/package.json"), "utf8"));
if (metadata.version !== runtime.dependencies["playwright-core"] || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
	throw new Error("Office package requires the exactly pinned Playwright package");
}
await mkdir(join(output, "node_modules"), { mode: 0o755 });
await copyTree(playwright, join(output, "node_modules/playwright-core"));
for (const name of ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service", "qorpera-office-preparation.conf", "qorpera-office-runtime.conf", "qorpera-office-private.mount.in", "qorpera-screen-session", "qorpera-screen-xfce", "qorpera-browser-policy.json", "qorpera-office-browser-bwrap.apparmor", "qorpera-computer-network.nft", "qorpera-computer-network.service", "qorpera-computer-plumb", "qorpera-computer-plumb.socket", "qorpera-computer-plumb@.service", "qorpera-agent-plug.rules", "qorpera-agent-plug.network", "qorpera-agent-plug-networkd.conf"]) {
	await copyFile(join(root, "deploy/lxd-company-computer-guest", name), join(output, name));
	// The plumber is root-only where it is installed (it locks its own file); the
	// package copy stays readable for every build step that hashes or stages it.
	await chmod(join(output, name), name.startsWith("qorpera-screen-") || name === "qorpera-computer-plumb" ? 0o555 : 0o444);
}
await mkdir(join(output, "wallpapers"), { mode: 0o755 });
// Reuse the existing artwork as inert image bytes, never desktop application code.
// One static frame per stable wallpaper identity plus 24 hourly frames each.
for (const name of COMPANY_COMPUTER_WALLPAPER_FILES) {
	await copyFile(join(wallpaperRoot, name), join(output, "wallpapers", name));
	await chmod(join(output, "wallpapers", name), 0o444);
}
await copyFile(join(root, "deploy/lxd-company-computer-guest/qorpera-screen-browser"), join(output, "qorpera-screen-browser"));
await chmod(join(output, "qorpera-screen-browser"), 0o555);
await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
const artifacts = [];
async function inventory(directory = "") {
	for (const entry of (await readdir(join(output, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) await inventory(file);
		else if (entry.isFile()) {
			const bytes = await readFile(join(output, file));
			artifacts.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
		} else throw new Error("Invalid office package artifact");
	}
}
await inventory();
await writeFile(join(output, "manifest.json"), `${JSON.stringify({
	schema: "qorpera.company-computer-package/v1", platform: "linux", minimumNode: "22.19.0",
	playwright: metadata.version, artifacts,
	// This package supplies service code/assets; the provider must still pin a
	// complete OS/browser image and prepare adopted mounts before activation.
	imagePrerequisites: ["cgroup-v2", "systemd-credentials", "unprivileged-user-namespaces", "bubblewrap", "tini", "xfce", "tigervnc", "chromium"],
}, null, 2)}\n`, { mode: 0o600 });
console.log(output);
