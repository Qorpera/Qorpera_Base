import { jitlessServiceBundleOptions } from "./jitless-service-bundle.mjs";
import {
	bundleNodeEntries,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const outputRoot = parseOutArg(process.argv.slice(2), {
	usage: "Usage: node scripts/package-runner-orchestrator.mjs [--out <directory>]",
	defaultDir: ".artifacts/runner-orchestrator",
});
await prepareOutputDir(outputRoot, { clean: true });
const artifact = "qorpera-runner-orchestrator.mjs";
await bundleNodeEntries({
	entries: [["packages/runner-orchestrator/src/cli.ts", artifact]],
	outputRoot,
	extraOptions: jitlessServiceBundleOptions,
});
const artifacts = await hashPackageFiles([artifact], outputRoot);
await writeManifest(outputRoot, {
	schema: "qorpera.runner-orchestrator-package/v1",
	runtime: { node: ">=22.19.0" },
	artifacts,
});
console.log(outputRoot);
