import {
	bundleNodeEntries,
	copyPackageFiles,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const output = await prepareOutputDir(
	parseOutArg(process.argv.slice(2), {
		usage: "Usage: node scripts/package-runtime-node-observer.mjs --out <new-output-directory>",
	}),
);
const entries = [
	["packages/runner-orchestrator/src/runtime-node-observer-main.ts", "qorpera-node-observer.cjs"],
	["packages/runner-orchestrator/src/lxd-office-host-namespace-cli.ts", "qorpera-node-host-namespace.cjs"],
	["packages/runner-orchestrator/src/runtime-node-observer-installation-cli.ts", "qorpera-node-observer-install.cjs"],
];
await bundleNodeEntries({ entries, outputRoot: output, format: "cjs" });
const units = ["deploy/first-node/qorpera-node-observer.service.in", "deploy/first-node/qorpera-node-host-namespace.service"];
await copyPackageFiles(units, output);
const artifacts = await hashPackageFiles(
	[...entries.map(([, file]) => file), ...units.map((unit) => unit.split("/").at(-1))],
	output,
);
const manifest = {
	schema: "qorpera.runtime-node-observer-package/v1",
	runtime: { node: ">=22.19.0", platform: "linux" },
	artifacts,
};
await writeManifest(output, manifest);
console.log(JSON.stringify({ output, ...manifest }));
