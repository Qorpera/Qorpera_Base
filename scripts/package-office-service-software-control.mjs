import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) throw new Error("Usage: node scripts/package-office-service-software-control.mjs --out <new-directory>");
const output = resolve(args[1]);
await mkdir(output, { mode: 0o700 });
const file = "software-control.mjs";
const result = await build({ absWorkingDir: root, entryPoints: ["deploy/lxd-company-computer-guest/office-service-software-control.ts"], outfile: join(output, file), bundle: true, platform: "node", format: "esm", target: "node22.19", metafile: true, legalComments: "none", logLevel: "silent" });
if (Object.keys(result.metafile.inputs).some((path) => /packages\/shell\/|node_modules\/(?:electron|playwright|@qorpera\/pi-)/.test(path)) || Object.values(result.metafile.outputs).some((entry) => entry.imports.some((item) => !item.path.startsWith("node:")))) throw new Error("Office software control has an unexpected dependency");
await chmod(join(output, file), 0o400);
const bytes = await readFile(join(output, file));
await writeFile(join(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.office-software-control-package/v1", platform: "linux", minimumNode: "22.19.0", artifact: { file, path: "/run/qorpera-office-preparation/software-control.mjs", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode: 256 }, purpose: "temporary-provider-root-control", historicalOfficeImageUnchanged: true }, null, 2)}\n`, { mode: 0o400 });
console.log(output);
