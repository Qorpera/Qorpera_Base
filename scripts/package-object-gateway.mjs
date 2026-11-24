import {
	bundleNodeEntries,
	ESM_REQUIRE_BANNER,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const outputRoot = parseOutArg(process.argv.slice(2), {
	usage: "Usage: node scripts/package-object-gateway.mjs [--out <directory>]",
	defaultDir: ".artifacts/object-gateway",
});
await prepareOutputDir(outputRoot, { clean: true });
await bundleNodeEntries({
	entries: [["packages/object-gateway/src/cli.ts", "qorpera-object-gateway.mjs"]],
	outputRoot,
	banner: ESM_REQUIRE_BANNER,
});
const artifacts = await hashPackageFiles(["qorpera-object-gateway.mjs"], outputRoot);
await writeManifest(outputRoot, {
	schema: "qorpera.object-gateway-package/v1",
	runtime: { node: ">=22.19.0" },
	artifacts,
});
console.log(outputRoot);
