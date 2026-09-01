// Build the web client into dist/: one bundled ES module, one stylesheet, the
// static shell, and the reused desktop assets. `--serve` keeps esbuild's dev
// server up with rebuild-on-request; no framework, no plugin chain.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const userland = resolve(root, "../shell/userland");
const serve = process.argv.includes("--serve");
const port = Number(process.env.QORPERA_WEB_PORT ?? 5180);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true });
// Reused desktop art. The web app never reads these at build time beyond copying.
cpSync(join(userland, "fonts"), join(dist, "assets/fonts"), { recursive: true });
cpSync(join(userland, "staff-creatures"), join(dist, "assets/staff-creatures"), { recursive: true });
for (const icon of [
	"icon-plus.svg",
	"icon-check.svg",
	"icon-x.svg",
	"icon-log-out.svg",
	"icon-settings.svg",
	"icon-switch-company.svg",
	"icon-chevron-down.svg",
	"icon-clock.svg",
	"icon-attach.svg",
]) {
	cpSync(join(userland, icon), join(dist, "assets", icon));
}
cpSync(resolve(root, "../shell/assets/qorpera.png"), join(dist, "assets/qorpera.png"));

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const options = {
	entryPoints: [join(root, "src/main.ts"), join(root, "src/styles/app.css")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: ["es2022"],
	outdir: dist,
	entryNames: "[name]",
	sourcemap: true,
	// Fonts and art are copied into dist/assets above; leave their URLs untouched.
	external: ["*.woff2", "*.png", "*.svg"],
	minify: !serve,
	logLevel: "info",
	define: {
		__QORPERA_WEB_VERSION__: JSON.stringify(version),
		__QORPERA_WEB_MODE__: JSON.stringify(serve ? "development" : "production"),
	},
};

if (serve) {
	const context = await esbuild.context(options);
	await context.watch();
	const { hosts, port: boundPort } = await context.serve({ servedir: dist, port, host: "127.0.0.1" });
	writeFileSync(join(dist, ".served"), `${hosts[0]}:${boundPort}\n`);
	console.log(`Qorpera web client serving on http://127.0.0.1:${boundPort}/`);
} else {
	await esbuild.build(options);
}
