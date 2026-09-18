import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") throw new Error("Usage: package-office-code-package-control.mjs --out <new-directory>");
const output = resolve(args[1]);
await mkdir(output, { mode: 0o700 });
const artifacts = [];
for (const [purpose, entry] of [["bootstrap", "office-code-package-control.ts"], ["measure", "office-code-package-measure.ts"]]) {
	const file = `${purpose}.cjs`;
	const result = await build({ absWorkingDir: repository, entryPoints: [`deploy/lxd-company-computer-guest/${entry}`], outfile: join(output, file), bundle: true, platform: "node", format: "cjs", target: "node22.19", metafile: true, legalComments: "none", logLevel: "silent" });
	if (result.warnings.length || Object.keys(result.metafile.inputs).some((p) => /packages\/shell\/|node_modules\/(?:electron|playwright|@qorpera\/pi-)/.test(p)) || Object.values(result.metafile.outputs).some((o) => o.imports.some((i) => !i.path.startsWith("node:")))) throw new Error(`Unaccepted ${purpose} dependency`);
	const bytes = await readFile(join(output, file));
	if (bytes.length < 1 || bytes.length > 16 * 1024 ** 2) throw new Error("Code package tool exceeds bound");
	await chmod(join(output, file), 0o400);
	artifacts.push({ purpose, file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode: 0o400 });
}
await writeFile(join(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.office-code-package-tools/v1", platform: "linux", minimumNode: "22.19.0", artifacts }, null, 2)}\n`, { mode: 0o400 });
console.log(output);
