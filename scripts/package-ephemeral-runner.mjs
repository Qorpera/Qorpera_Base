import { CLOUD_RUNTIME_ENTRY_POINTS, generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";
import {
	bundleNodeEntries,
	copyPackageFiles,
	ESM_REQUIRE_BANNER,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const outputRoot = parseOutArg(process.argv.slice(2), {
	usage: "Usage: node scripts/package-ephemeral-runner.mjs [--out <directory>]",
	defaultDir: ".artifacts/ephemeral-runner",
});
const runtimeBundle = await generateCloudRuntimeBundle(true);
await prepareOutputDir(outputRoot, { clean: true });

const entries = Object.entries(CLOUD_RUNTIME_ENTRY_POINTS).map(([name, source]) => [source, `${name}.mjs`]);
await bundleNodeEntries({ entries, outputRoot, banner: ESM_REQUIRE_BANNER });
await copyPackageFiles([["deploy/ephemeral-runner/image/run-job", "run-job"]], outputRoot);

const files = [...entries.map(([, file]) => file), "run-job"];
const artifacts = await hashPackageFiles(files, outputRoot);
await writeManifest(outputRoot, {
	schema: "qorpera.ephemeral-runner-package/v1",
	runtimeBundleSha256: runtimeBundle.sha256,
	artifacts,
});
console.log(outputRoot);
