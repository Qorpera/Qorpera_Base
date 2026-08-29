import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
	throw new Error("Usage: node scripts/package-cloud-secret-canary.mjs --out <new-directory>");
}
const output = resolve(args[1]);
await mkdir(output, { mode: 0o700 });
await build({
	absWorkingDir: root,
	entryPoints: {
		"qorpera-cloud-secret-broker-canary-service": "packages/shell/src/cloud-secret-canary-service-main.ts",
		"qorpera-step2-secret-canary-destination": "packages/shell/src/cloud-secret-canary-destination-main.ts",
	},
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
const staticArtifacts = [
	"qorpera-cloud-secret-broker-canary.service",
	"qorpera-step2-secret-canary-destination.service",
	"qorpera-cloud-secret-capture-proxy.service",
	"capture-proxy.conf",
	"qorpera-step2-secret-canary-driver.mjs",
];
for (const file of staticArtifacts) {
	await copyFile(join(root, "deploy/cloud-secret-broker/azure", file), join(output, file));
}
await copyFile(
	join(root, "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"),
	join(output, "supabase-prod-ca-2021.crt"),
);
const files = [
	"qorpera-cloud-secret-broker-canary-service.mjs",
	"qorpera-step2-secret-canary-destination.mjs",
	"supabase-prod-ca-2021.crt",
	...staticArtifacts,
];
const artifacts = [];
for (const file of files) {
	const bytes = await readFile(join(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const adapterSpecification = JSON.stringify({
	schema: "qorpera.step2-secret-canary-adapter/v1",
	connectorId: "step2_canary",
	operationId: "record_marker",
	operationVersion: 1,
	destinationOrigin: "https://127.0.0.1:9443",
	credentialPlacement: "authorization-bearer",
	requestPath: "/v1/effects",
});
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify(
		{
			schema: "qorpera.step2-secret-canary-package/v1",
			adapter: {
				connectorId: "step2_canary",
				operationId: "record_marker",
				operationVersion: 1,
				destinationOrigin: "https://127.0.0.1:9443",
				adapterSha256: createHash("sha256").update(adapterSpecification).digest("hex"),
			},
			artifacts,
		},
		null,
		2,
	)}\n`,
	{ mode: 0o600 },
);
console.log(output);
