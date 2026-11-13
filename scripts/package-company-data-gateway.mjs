import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Packages the data gateway (deploy/company-data/kit/README.md) for a machine: one file that holds the kit's entry,
 * the gateway and node-postgres as the repository's lockfile pins it, with its sha256 beside it in sha256sum's form.
 * The kit's compose file mounts the folder and runs the file only if it matches. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/package-company-data-gateway.mjs --out <new-directory>";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error(usage);
const output = resolve(args[1]);
await mkdir(output, { mode: 0o755 });
const file = "qorpera-company-data-gateway.mjs";
await build({
	absWorkingDir: root,
	entryPoints: { "qorpera-company-data-gateway": "deploy/company-data/kit/gateway-main.mjs" },
	outdir: output,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	// The Node of the kit's gateway image (docker-compose.yml, scripts/run-on-node-plan.mjs NODE_IMAGE).
	target: "node24.21",
	// node-postgres loads pg-native only when a caller asks for it; the gateway never does.
	external: ["pg-native"],
	banner: {
		js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);',
	},
	legalComments: "none",
	logLevel: "silent",
});
const bytes = await readFile(join(output, file));
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(join(output, `${file}.sha256`), `${sha256}  ${file}\n`, { mode: 0o644, flag: "wx" });
const pg = JSON.parse(await readFile(join(root, "node_modules/pg/package.json"), "utf8")).version;
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify({ schema: "qorpera.company-data-gateway-package/v1", pg, artifacts: [{ file, bytes: bytes.byteLength, sha256 }] }, null, 2)}\n`,
	{ mode: 0o644, flag: "wx" },
);
console.log(output);
