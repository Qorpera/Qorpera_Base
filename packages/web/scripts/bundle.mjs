// What the web client is bundled into, shared by scripts/build.mjs and
// scripts/bundle.test.mjs so the test checks exactly what ships.
//
// main.js is split (esbuild `splitting`): the vendor chunk (src/vendor.ts),
// which main.js imports and index.html preloads, plus chunks main.js loads
// only when needed: the figures' recorded motion (ui/figure-motion-data.ts)
// and the computer screen renderer with noVNC (ui/screen-viewer.mjs).
// theme.js is a separate classic script for the head.
import { join, relative, resolve, sep } from "node:path";
import { assertMemberWebInputs } from "../../../scripts/check-headless-packages.mjs";
import { designPxPlugin, readUiScale } from "./design-px.mjs";

const boundary = {
	name: "member-authority-boundary",
	setup(build) {
		build.onEnd((result) => {
			if (!result.metafile) return;
			// Stylesheets contain copied art/font URLs; executable outputs must be self-contained.
			assertMemberWebInputs({ ...result.metafile, outputs: Object.fromEntries(Object.entries(result.metafile.outputs).filter(([path]) => path.endsWith(".js"))) });
		});
	},
};

/** esbuild options for the app (main.js, its chunks, app.css) and the head script. */
export function bundleOptions({ root, outdir, serve = false, define }) {
	// Production files carry a content hash so a browser can never keep a
	// stale one across deploys; index.html is rewritten to point at them.
	const entryNames = serve ? "[name]" : "build/[name]-[hash]";
	return {
		// The head script that sets the theme before the first paint. It runs as a
		// classic script beside the vendored avatar scripts, so it is its own IIFE.
		theme: {
			absWorkingDir: root,
			entryPoints: [{ in: join(root, "src/theme.ts"), out: "theme" }],
			bundle: true,
			format: "iife",
			platform: "browser",
			target: ["es2022"],
			outdir,
			entryNames,
			metafile: true,
			plugins: [boundary],
			minify: !serve,
			logLevel: "info",
		},
		app: {
			absWorkingDir: root,
			entryPoints: [
				{ in: join(root, "src/entry.mjs"), out: "main" },
				// Never loaded itself: it gives the vendor code a chunk of its own (src/vendor.ts).
				{ in: join(root, "src/vendor.ts"), out: "vendor" },
				{ in: join(root, "src/styles/app.css"), out: "app" },
			],
			bundle: true,
			format: "esm",
			splitting: true,
			platform: "browser",
			target: ["es2022"],
			outdir,
			entryNames,
			chunkNames: serve ? "[name]-[hash]" : "build/[name]-[hash]",
			metafile: true,
			// Stylesheets are written in design pixels and drawn at tokens.css's --ui-scale (scripts/design-px.mjs).
			plugins: [boundary, designPxPlugin(readUiScale(join(root, "src/styles/tokens.css")))],
			// Lower the size gates emitted by design-px for browsers without CSS nesting.
			supported: { nesting: false },
			sourcemap: true,
			// Fonts and art are copied into dist/assets; leave their URLs untouched.
			external: ["*.woff2", "*.png", "*.svg"],
			minify: !serve,
			logLevel: "info",
			define,
		},
	};
}

/** The built files by role, as paths relative to `outdir` with "/" separators. */
export function bundleLayout(metafile, { root, outdir }) {
	const name = (path) => relative(outdir, resolve(root, path)).split(sep).join("/");
	const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) => [name(path), output]));
	const entry = (source, extension) =>
		[...outputs].find(([file, output]) => output.entryPoint === source && file.endsWith(extension))?.[0];
	const script = entry("src/entry.mjs", ".js");
	const vendor = entry("src/vendor.ts", ".js");
	const style = entry("src/styles/app.css", ".css");
	const theme = entry("src/theme.ts", ".js");
	if (!script || !vendor || !style || !theme) throw new Error("The bundle's entry files were not produced");
	/** Every chunk a file imports statically, and theirs: fetched before it runs. */
	const imported = (file, found = new Set()) => {
		for (const item of outputs.get(file)?.imports ?? []) {
			if (item.kind !== "import-statement" || item.external || found.has(name(item.path))) continue;
			found.add(name(item.path));
			imported(name(item.path), found);
		}
		return found;
	};
	const preload = imported(script);
	const vendorChunks = imported(vendor);
	const files = [...outputs.keys()].filter((file) => !file.endsWith(".map")).sort();
	return {
		/** The metafile's outputs under the same names. */
		outputs: Object.fromEntries(outputs),
		script,
		style,
		theme,
		/** What main.js imports before it runs; index.html preloads it beside main.js. */
		preload: [...preload].sort(),
		/** What the vendor entry imports: the vendor code's chunk, and the few
		 * bytes esbuild shares between every entry (the build's define). */
		vendor: [...vendorChunks].sort(),
		/** Every script and stylesheet the deployment manifest checksums (not source maps). */
		files,
		/** Scripts main.js loads only on demand, by dynamic import. */
		lazy: files.filter(
			(file) => file.endsWith(".js") && ![script, vendor, theme].includes(file) && !preload.has(file) && !vendorChunks.has(file),
		),
	};
}

/** The vendored classic scripts index.html loads by a fixed name from
 * `/assets/`, which is cached for a day; each gets its content hash as a
 * query, so a deploy that changes one is fetched at once. */
export const VENDORED_SCRIPTS = ["assets/avatars/motion-model.js", "assets/avatars/avatar-appearance.js"];

/** Point index.html at the hashed files and preload main.js's static chunks,
 * so splitting adds no request that waits for main.js to be parsed.
 * `versions` maps each of VENDORED_SCRIPTS to its content hash. */
export function rewriteIndex(html, layout, versions) {
	const once = (text, from, to) => {
		if (text.split(from).length !== 2) throw new Error(`index.html must contain ${from} exactly once`);
		return text.replace(from, () => to);
	};
	const preload = layout.preload.map((file) => `<link rel="modulepreload" href="./${file}">\n`).join("");
	let result = once(html, 'src="./theme.js"', `src="./${layout.theme}"`);
	for (const file of VENDORED_SCRIPTS) {
		if (!/^[\da-f]{12}$/.test(versions?.[file] ?? "")) throw new Error(`No content hash for ${file}`);
		result = once(result, `src="./${file}"`, `src="./${file}?v=${versions[file]}"`);
	}
	result = once(result, 'href="./app.css"', `href="./${layout.style}"`);
	result = once(result, 'src="./main.js"', `src="./${layout.script}"`);
	return once(result, "</head>", `${preload}</head>`);
}
