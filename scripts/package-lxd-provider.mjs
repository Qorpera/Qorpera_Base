import { jitlessServiceBundleOptions } from "./jitless-service-bundle.mjs";
import {
	bundleNodeEntries,
	ESM_REQUIRE_BANNER,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const outputRoot = parseOutArg(process.argv.slice(2), {
	usage: "Usage: node scripts/package-lxd-provider.mjs [--out <directory>]",
	defaultDir: ".artifacts/lxd-provider",
});
await prepareOutputDir(outputRoot, { clean: true });
const entries = [
	["packages/runner-orchestrator/src/provider-cli.ts", "qorpera-lxd-provider.mjs", jitlessServiceBundleOptions],
	["packages/runner-orchestrator/src/lxd-image-provenance-cli.ts", "qorpera-lxd-image-provenance.mjs"],
];
await bundleNodeEntries({ entries, outputRoot, banner: ESM_REQUIRE_BANNER });
const artifacts = await hashPackageFiles(
	entries.map(([, file]) => file),
	outputRoot,
);
await writeManifest(outputRoot, {
	schema: "qorpera.lxd-provider-package/v1",
	runtime: { node: ">=22.19.0" },
	artifacts,
});
console.log(outputRoot);
