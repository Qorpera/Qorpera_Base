import { generateCloudRuntimeBundle } from "./generate-cloud-runtime-bundle.mjs";
import {
	bundleNodeEntries,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const output = parseOutArg(process.argv.slice(2), {
	usage: "Usage: package-coding-executor.mjs --out <new-directory>",
});
const bundle = await generateCloudRuntimeBundle(true);
await prepareOutputDir(output, { mode: 0o700 });
const entries = [
	["deploy/coding-worker/executor.ts", "qorpera-coding-executor.mjs"],
	["deploy/coding-worker/host-watchdog.ts", "qorpera-coding-host-watchdog.mjs"],
];
await bundleNodeEntries({ entries, outputRoot: output });
const files = await hashPackageFiles(
	entries.map(([, file]) => file),
	output,
);
await writeManifest(output, {
	schema: "qorpera.coding-executor-package/v2",
	runtimeBundleSha256: bundle.sha256,
	files,
});
console.log(output);
