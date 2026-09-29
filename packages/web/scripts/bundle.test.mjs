import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { bundleLayout, bundleOptions, rewriteIndex } from "./bundle.mjs";
import { prepareDeployment } from "./deployment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Never written to: these builds keep their files in memory.
const outdir = join(root, "dist-bundle-test");
const { define } = prepareDeployment({ headersTemplate: readFileSync(join(root, "public/_headers"), "utf8") });

/** The production bundle, built as scripts/build.mjs builds it. */
async function bundle(plugins = []) {
	const { app, theme } = bundleOptions({ root, outdir, define });
	const quiet = { write: false, logLevel: "silent" };
	const [appResult, themeResult] = await Promise.all([
		build({ ...app, ...quiet, plugins: [...plugins, ...app.plugins] }),
		build({ ...theme, ...quiet }),
	]);
	const layout = bundleLayout(
		{ inputs: {}, outputs: { ...appResult.metafile.outputs, ...themeResult.metafile.outputs } },
		{ root, outdir },
	);
	const text = Object.fromEntries(
		[...appResult.outputFiles, ...themeResult.outputFiles].map((file) => [file.path.slice(outdir.length + 1), file.text]),
	);
	return { layout, text };
}
const built = bundle();

/** The inputs that put bytes into these output files. */
function inputsOf(layout, files) {
	return files.flatMap((file) =>
		Object.entries(layout.outputs[file].inputs)
			.filter(([, input]) => input.bytesInOutput > 0)
			.map(([path]) => path),
	);
}
const MOTION_DATA = /status-2d-v1\/(?:working-frames|eye-clips|eye-tracks)\.mjs$/;
const NOVNC = /member-web\/ui\/(?:screen-viewer|vendor\/novnc-rfb)\.js$/;
const VENDOR = /node_modules\/(?:@supabase\/|marked\/)/;

test("the first screen never downloads the figures' motion data or noVNC; main.js imports them on demand", async () => {
	const { layout } = await built;
	const first = [layout.script, ...layout.preload];
	assert.deepEqual(inputsOf(layout, first).filter((path) => MOTION_DATA.test(path) || NOVNC.test(path)), []);
	const lazy = inputsOf(layout, layout.lazy);
	assert.equal(lazy.filter((path) => MOTION_DATA.test(path)).length, 3);
	assert.equal(lazy.filter((path) => NOVNC.test(path)).length, 2);
	const dynamic = layout.outputs[layout.script].imports.filter((item) => item.kind === "dynamic-import");
	assert.equal(dynamic.length, 2);
	assert.deepEqual(
		layout.lazy.filter((file) => /^build\/(?:figure-motion-data|screen-viewer)-[A-Z0-9]+\.js$/.test(file)).length,
		2,
	);
});

test("vendor code has its own preloaded chunk, whose name an app-only change keeps", async () => {
	const { layout } = await built;
	const vendorChunk = layout.vendor.filter((file) => inputsOf(layout, [file]).some((path) => VENDOR.test(path)));
	assert.equal(vendorChunk.length, 1);
	const vendored = inputsOf(layout, vendorChunk);
	assert.ok(vendored.some((path) => /node_modules\/@supabase\/supabase-js\//.test(path)));
	assert.ok(vendored.some((path) => /node_modules\/marked\//.test(path)));
	// An import src/vendor.ts does not list would land here instead.
	const elsewhere = [layout.script, ...layout.preload, ...layout.lazy].filter((file) => !vendorChunk.includes(file));
	assert.deepEqual(inputsOf(layout, elsewhere).filter((path) => VENDOR.test(path)), []);
	for (const file of layout.vendor) assert.ok(layout.preload.includes(file), file);
	// A deploy that changes only app code: main.js is renamed, the vendor chunk is not.
	const changed = await bundle([
		{
			name: "app-change",
			setup(build) {
				build.onLoad({ filter: /[\\/]src[\\/]main\.ts$/ }, ({ path }) => ({
					contents: `${readFileSync(path, "utf8")}\nconsole.info("changed");\n`,
					loader: "ts",
				}));
			},
		},
	]);
	assert.notEqual(changed.layout.script, layout.script);
	assert.deepEqual(changed.layout.vendor, layout.vendor);
});

test("theme.js restores appearance before paint without the dictionary", async () => {
	const { layout, text } = await built;
	const inputs = inputsOf(layout, [layout.theme]);
	assert.deepEqual(inputs.filter((path) => /src\/ui\/(?:danish\/|preferences\.ts$)/.test(path)), []);
	assert.ok(text[layout.theme].length < 2048, `theme.js is ${text[layout.theme].length} bytes`);
	const stored = { "qorpera.web.theme": "dark", "qorpera.web.composer-color": "green", "qorpera.web.ui-size": "small" };
	const root = { dataset: {} };
	const context = {
		localStorage: { getItem: (key) => stored[key] ?? null },
		document: { documentElement: root, querySelectorAll: () => [] },
		window: { matchMedia: () => ({ matches: false }), dispatchEvent() {} },
		Event: class {},
	};
	runInNewContext(text[layout.theme], context);
	assert.deepEqual(root.dataset, { theme: "dark", composerColor: "green", uiSize: "small" });
	// With nothing stored it follows the device.
	const device = { dataset: {} };
	runInNewContext(text[layout.theme], {
		...context,
		localStorage: { getItem: () => null },
		document: { documentElement: device, querySelectorAll: () => [] },
		window: { matchMedia: () => ({ matches: true }), dispatchEvent() {} },
	});
	assert.deepEqual(device.dataset, { theme: "dark", composerColor: "blue", uiSize: "big" });
});

test("index.html points at the hashed files and preloads what main.js imports", async () => {
	const { layout } = await built;
	const template = readFileSync(join(root, "public/index.html"), "utf8");
	const html = rewriteIndex(template, layout);
	const head = html.slice(0, html.indexOf("</head>"));
	assert.ok(layout.preload.length > 0);
	for (const file of layout.preload) assert.ok(head.includes(`<link rel="modulepreload" href="./${file}">`), file);
	for (const file of layout.lazy) assert.ok(!html.includes(file), file);
	assert.ok(head.includes(`<script src="./${layout.theme}"></script>`));
	assert.ok(head.includes(`<link rel="stylesheet" href="./${layout.style}">`));
	assert.ok(html.includes(`<script type="module" src="./${layout.script}"></script>`));
	// The avatar globals still come before the module that uses them.
	assert.ok(html.indexOf("avatar-appearance.js") < html.indexOf(layout.script));
	assert.throws(() => rewriteIndex(template.replace('src="./main.js"', ""), layout), /main\.js/);
});

test("the deployment manifest checksums every script and stylesheet the build made", async () => {
	const { layout } = await built;
	const expected = [layout.script, layout.style, layout.theme, ...layout.preload, ...layout.lazy];
	for (const file of expected) assert.ok(layout.files.includes(file), file);
	assert.deepEqual(
		layout.files,
		Object.keys(layout.outputs)
			.filter((file) => !file.endsWith(".map"))
			.sort(),
	);
	assert.ok(layout.files.every((file) => file.startsWith("build/")));
});
