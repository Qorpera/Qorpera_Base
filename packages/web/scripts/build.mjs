// Build the web client into dist/: one bundled ES module, one stylesheet, the
// static shell, and the reused desktop assets. `--serve` keeps esbuild's dev
// server up with rebuild-on-request; no framework, no plugin chain.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { assertMemberWebInputs } from "../../../scripts/check-headless-packages.mjs";
import { prepareDeployment } from "./deployment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const userland = resolve(root, "../shell/userland");
const serve = process.argv.includes("--serve");
const deployment = prepareDeployment({
	configPath: process.env.QORPERA_WEB_CONFIG,
	release: process.argv.includes("--release"),
	serve,
	headersTemplate: readFileSync(join(root, "public/_headers"), "utf8"),
});
const port = Number(process.env.QORPERA_WEB_PORT ?? 5180);
const viewerRoot = resolve(root, "../member-web/ui");
const viewerSource = JSON.parse(readFileSync(join(viewerRoot, "SOURCE.json"), "utf8"));
for (const source of viewerSource.sources) {
	const bytes = readFileSync(join(viewerRoot, source.file));
	if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Viewer source differs from its accepted checksum");
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true });
writeFileSync(join(dist, "_headers"), deployment.headers);
cpSync(join(viewerRoot, "vendor/NOVNC_LICENSE.txt"), join(dist, "assets/NOVNC_LICENSE.txt"));
// Reused desktop art. The web app never reads these at build time beyond copying.
cpSync(join(userland, "fonts"), join(dist, "assets/fonts"), { recursive: true });
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
	"provider-google.svg",
	"provider-github.svg",
	"provider-openai.svg",
	"provider-anthropic.svg",
]) {
	cpSync(join(userland, icon), join(dist, "assets", icon));
}

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const options = {
	entryPoints: [{ in: join(root, "src/entry.mjs"), out: "main" }, { in: join(root, "src/styles/app.css"), out: "app" }],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: ["es2022"],
	outdir: dist,
	// Production bundles carry a content hash so a browser can never keep a
	// stale main.js across deploys; the HTML is rewritten to point at them.
	entryNames: serve ? "[name]" : "build/[name]-[hash]",
	metafile: true,
	plugins: [{ name: "member-authority-boundary", setup(build) {
		build.onEnd(result => {
			if (!result.metafile) return;
			// Stylesheets contain copied art/font URLs; executable outputs must be self-contained.
			assertMemberWebInputs({ ...result.metafile, outputs: Object.fromEntries(Object.entries(result.metafile.outputs).filter(([path]) => path.endsWith(".js"))) });
		});
	} }],
	sourcemap: true,
	// Fonts and art are copied into dist/assets above; leave their URLs untouched.
	external: ["*.woff2", "*.png", "*.svg"],
	minify: !serve,
	logLevel: "info",
	define: {
		...deployment.define,
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
	const result = await esbuild.build(options);
	writeFileSync(join(dist, "build-manifest.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
	const outputs = Object.keys(result.metafile.outputs).map((file) => file.slice(file.indexOf("dist/") + 5));
	const script = outputs.find((file) => /^build\/main-[A-Z0-9]+\.js$/.test(file));
	const style = outputs.find((file) => /^build\/app-[A-Z0-9]+\.css$/.test(file));
	if (!script || !style) throw new Error("Hashed bundle names were not produced");
	const html = readFileSync(join(dist, "index.html"), "utf8")
		.replace('href="./app.css"', `href="./${style}"`)
		.replace('src="./main.js"', `src="./${script}"`);
	writeFileSync(join(dist, "index.html"), html);
	const files = ["index.html", "_headers", script, style];
	writeFileSync(join(dist, "web-deployment.json"), `${JSON.stringify({
		...deployment.manifest,
		version,
		files: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(join(dist, file))).digest("hex")])),
	}, null, 2)}\n`);
	console.log(`index.html -> ${script}, ${style}`);
}
