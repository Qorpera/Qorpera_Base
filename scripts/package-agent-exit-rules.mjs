import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// The agent exit's rules reader (RUNTIME-AGENT-EXIT.md §10, E8b): one bundled program, its unit and the database's CA,
// which deploy/agent-exit/install-agent-exit.sh installs next to the exit's tools.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
	throw new Error("Usage: node scripts/package-agent-exit-rules.mjs --out <new-directory>");
}
const output = resolve(args[1]);
await mkdir(output, { mode: 0o700 });
await build({
	absWorkingDir: root,
	entryPoints: { "qorpera-agent-exit-rules": "packages/runtime/src/agent-exit-rules-main.ts" },
	outdir: output,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	banner: {
		js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);',
	},
	legalComments: "none",
	logLevel: "silent",
});
await copyFile(
	join(root, "deploy/agent-exit/qorpera-agent-exit-rules.service"),
	join(output, "qorpera-agent-exit-rules.service"),
);
await copyFile(
	join(root, "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"),
	join(output, "supabase-prod-ca-2021.crt"),
);
const artifacts = [];
for (const file of ["qorpera-agent-exit-rules.mjs", "qorpera-agent-exit-rules.service", "supabase-prod-ca-2021.crt"]) {
	const bytes = await readFile(join(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify({ schema: "qorpera.agent-exit-rules-package/v1", artifacts }, null, 2)}\n`,
	{ mode: 0o600 },
);
console.log(output);
