import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { memberWebCsp, parseMemberWebConfig } from "../packages/member-web/src/config.ts";
import { assertMemberWebInputs } from "./check-headless-packages.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
/** Builds an unpublished, independent static client. Output must be new; the
 * only deployment input is a closed public configuration, never a session. */
export async function packageMemberWeb({ out, config: input, root = repository }) {
	const config = parseMemberWebConfig(input), destination = resolve(out), ui = join(root, "packages/member-web/ui");
	const source = JSON.parse(await readFile(join(ui, "SOURCE.json"), "utf8"));
	for (const entry of source.sources) {
		const bytes = await readFile(join(ui, entry.file));
		if (sha256(bytes) !== entry.sha256) throw new Error(`Viewer source changed: ${entry.file}`);
	}
	const bundle = await build({ absWorkingDir: root, entryPoints: ["packages/member-web/src/entry.mjs"],
		bundle: true, platform: "browser", format: "esm", target: "es2022", outfile: "app.js", metafile: true, write: false, logLevel: "silent" });
	assertMemberWebInputs(bundle.metafile);
	const csp = memberWebCsp(config), metaCsp = csp.replace("; frame-ancestors 'none'", "");
	const headers = `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Cache-Control: no-store\n`;
	const files = new Map([
		["app.js", Buffer.from(bundle.outputFiles[0].contents)],
		["index.html", Buffer.from((await readFile(join(ui, "index.html"), "utf8")).replace("__QORPERA_CSP__", metaCsp))],
		["app.css", await readFile(join(ui, "app.css"))],
		["screens.css", await readFile(join(ui, "screens.css"))],
		["NOVNC_LICENSE.txt", await readFile(join(ui, "vendor/NOVNC_LICENSE.txt"))],
		["config.json", Buffer.from(`${JSON.stringify(config, null, 2)}\n`)],
		["_headers", Buffer.from(headers)],
	]);
	const manifest = { schema: "qorpera.member-web-package/v1", publicConfig: true, runtimeIncluded: false,
		browserInputs: Object.keys(bundle.metafile.inputs).sort(),
		files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
	// mkdir is exclusive: never replace an existing deployable output directory.
	await mkdir(destination);
	for (const [name, bytes] of files) await writeFile(join(destination, name), bytes, { flag: "wx" });
	await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length !== 4 || args[0] !== "--out" || args[2] !== "--config") throw new Error("Usage: node scripts/package-member-web.mjs --out NEW_DIRECTORY --config PUBLIC_CONFIG_JSON");
	console.log(JSON.stringify(await packageMemberWeb({ out: args[1], config: JSON.parse(await readFile(args[3], "utf8")) })));
}
