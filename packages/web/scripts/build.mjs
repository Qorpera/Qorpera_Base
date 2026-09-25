// Build the web client into dist/: one bundled ES module, one stylesheet and
// the static shell with its assets. `--serve` keeps esbuild's dev server up
// with rebuild-on-request; no framework, no plugin chain.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { assertMemberWebInputs } from "../../../scripts/check-headless-packages.mjs";
import { prepareDeployment } from "./deployment.mjs";
import { designPxPlugin, readUiScale } from "./design-px.mjs";
import { webSourceProvenance } from "./provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const serve = process.argv.includes("--serve");
const deployment = prepareDeployment({
	configPath: process.env.QORPERA_WEB_CONFIG,
	configJson: process.env.QORPERA_WEB_CONFIG_JSON,
	release: process.argv.includes("--release"),
	serve,
	headersTemplate: readFileSync(join(root, "public/_headers"), "utf8"),
});
const provenance = webSourceProvenance(resolve(root, "../.."), process.argv.includes("--release"));
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
// A missing file under a long-cached directory must be a no-store 404, never
// the app page kept as that file (scripts/deployment.mjs).
for (const page of deployment.notFoundPages) {
	mkdirSync(dirname(join(dist, page)), { recursive: true });
	writeFileSync(join(dist, page), '<!doctype html>\n<meta charset="utf-8">\n<title>Not found</title>\n<p>Not found.</p>\n');
}
cpSync(join(viewerRoot, "vendor/NOVNC_LICENSE.txt"), join(dist, "assets/NOVNC_LICENSE.txt"));

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const boundary = { name: "member-authority-boundary", setup(build) {
	build.onEnd(result => {
		if (!result.metafile) return;
		// Stylesheets contain copied art/font URLs; executable outputs must be self-contained.
		assertMemberWebInputs({ ...result.metafile, outputs: Object.fromEntries(Object.entries(result.metafile.outputs).filter(([path]) => path.endsWith(".js"))) });
	});
} };
// The head script that sets the theme before the first paint. It runs as a
// classic script beside the vendored avatar scripts, so it is its own IIFE.
const themeOptions = {
	entryPoints: [{ in: join(root, "src/theme.ts"), out: "theme" }],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["es2022"],
	outdir: dist,
	entryNames: serve ? "[name]" : "build/[name]-[hash]",
	metafile: true,
	plugins: [boundary],
	minify: !serve,
	logLevel: "info",
};
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
	// Stylesheets are written in design pixels and drawn at tokens.css's --ui-scale (scripts/design-px.mjs).
	plugins: [boundary, designPxPlugin(readUiScale(join(root, "src/styles/tokens.css")))],
	sourcemap: true,
	// Fonts and art are copied into dist/assets above; leave their URLs untouched.
	external: ["*.woff2", "*.png", "*.svg"],
	minify: !serve,
	logLevel: "info",
	define: deployment.define,
};

if (serve) {
	await (await esbuild.context(themeOptions)).watch();
	const context = await esbuild.context(options);
	await context.watch();
	const { hosts, port: boundPort } = await context.serve({ servedir: dist, port, host: "127.0.0.1" });
	writeFileSync(join(dist, ".served"), `${hosts[0]}:${boundPort}\n`);
	console.log(`Qorpera web client serving on http://127.0.0.1:${boundPort}/`);
} else {
	const result = await esbuild.build(options);
	const themeResult = await esbuild.build(themeOptions);
	const metafile = {
		inputs: { ...result.metafile.inputs, ...themeResult.metafile.inputs },
		outputs: { ...result.metafile.outputs, ...themeResult.metafile.outputs },
	};
	writeFileSync(join(dist, "build-manifest.json"), `${JSON.stringify(metafile, null, 2)}\n`);
	const outputs = Object.keys(metafile.outputs).map((file) => file.slice(file.indexOf("dist/") + 5));
	const script = outputs.find((file) => /^build\/main-[A-Z0-9]+\.js$/.test(file));
	const style = outputs.find((file) => /^build\/app-[A-Z0-9]+\.css$/.test(file));
	const theme = outputs.find((file) => /^build\/theme-[A-Z0-9]+\.js$/.test(file));
	if (!script || !style || !theme) throw new Error("Hashed bundle names were not produced");
	const html = readFileSync(join(dist, "index.html"), "utf8")
		.replace('src="./theme.js"', `src="./${theme}"`)
		.replace('href="./app.css"', `href="./${style}"`)
		.replace('src="./main.js"', `src="./${script}"`);
	writeFileSync(join(dist, "index.html"), html);
	const files = ["index.html", "_headers", ...deployment.notFoundPages, theme, script, style];
	writeFileSync(join(dist, "web-deployment.json"), `${JSON.stringify({
		...deployment.manifest,
		...provenance,
		version,
		files: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(join(dist, file))).digest("hex")])),
	}, null, 2)}\n`);
	console.log(`index.html -> ${theme}, ${script}, ${style}`);
}
