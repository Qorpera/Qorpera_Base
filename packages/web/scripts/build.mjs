// Build the web client into dist/: the split ES module bundle (main.js and its
// chunks, scripts/bundle.mjs), one stylesheet, the head script and the static
// shell with its assets. `--serve` keeps esbuild's dev server up with
// rebuild-on-request; no framework, no plugin chain.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { bundleLayout, bundleOptions, rewriteIndex } from "./bundle.mjs";
import { prepareDeployment } from "./deployment.mjs";
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
const { app: options, theme: themeOptions } = bundleOptions({ root, outdir: dist, serve, define: deployment.define });

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
	const layout = bundleLayout(metafile, { root, outdir: dist });
	writeFileSync(join(dist, "index.html"), rewriteIndex(readFileSync(join(dist, "index.html"), "utf8"), layout));
	// Every script and stylesheet, chunks included: a deploy check can tell each file this build made.
	const files = ["index.html", "_headers", ...deployment.notFoundPages, ...layout.files];
	writeFileSync(join(dist, "web-deployment.json"), `${JSON.stringify({
		...deployment.manifest,
		...provenance,
		version,
		files: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(join(dist, file))).digest("hex")])),
	}, null, 2)}\n`);
	console.log(`index.html -> ${layout.theme}, ${layout.script} (preloads ${layout.preload.join(", ")}), ${layout.style}; on demand: ${layout.lazy.join(", ")}`);
}
