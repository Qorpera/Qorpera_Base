import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";

if (process.argv.length !== 4 || process.argv[2] !== "--out") throw new Error("Usage: package-runtime-computer-guard.mjs --out <new-directory>");
const output = resolve(process.argv[3]);
const bundle = await generateCloudRuntimeBundle(true);
await mkdir(output, { recursive: false, mode: 0o700 });
const file = "qorpera-runtime-computer-guard.mjs";
await build({ entryPoints: ["deploy/runtime-computers/paid-computer-guard.ts"], outfile: resolve(output, file),
	bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "none", logLevel: "silent" });
const names = [file];
const template = await readFile("deploy/runtime-computers/qorpera-computer-guard.service.in", "utf8");
for (const [provider, account] of [["native", "qorpera-provider"], ["office", "qorpera-office-provider"]]) {
	const unit = `qorpera-${provider}-computer-guard.service`, dropIn = `qorpera-${provider}-computer-paid.conf`;
	await writeFile(resolve(output, unit), template.replaceAll("@PROVIDER@", provider).replaceAll("@ACCOUNT@", account));
	await writeFile(resolve(output, dropIn), await readFile(`deploy/runtime-computers/${dropIn}`));
	names.push(unit, dropIn);
}
const artifacts = await Promise.all(names.map(async (name) => {
	const bytes = await readFile(resolve(output, name));
	return { file: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({ schema: "qorpera.runtime-computer-guard-package/v1", runtimeBundleSha256: bundle.sha256, artifacts }, null, 2)}\n`);
console.log(output);
