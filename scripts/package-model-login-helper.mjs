import {
	bundleNodeEntries,
	copyPackageFiles,
	ESM_REQUIRE_BANNER,
	hashPackageFiles,
	parseOutArg,
	prepareOutputDir,
	writeManifest,
} from "./package-service.mjs";

const output = await prepareOutputDir(
	parseOutArg(process.argv.slice(2), {
		usage: "Usage: node scripts/package-model-login-helper.mjs --out <new-directory>",
	}),
	{ mode: 0o700 },
);
await bundleNodeEntries({
	entries: [
		["packages/runtime/src/cloud-model-login-helper-main.ts", "qorpera-model-login-helper.mjs"],
		["packages/runtime/src/cloud-native-isolation-child.ts", "qorpera-native-isolation-child.mjs"],
	],
	outputRoot: output,
	banner: ESM_REQUIRE_BANNER,
});
await copyPackageFiles(["deploy/cloud-secret-broker/qorpera-model-login-helper.service"], output);
const artifacts = await hashPackageFiles(
	["qorpera-model-login-helper.mjs", "qorpera-native-isolation-child.mjs", "qorpera-model-login-helper.service"],
	output,
);
await writeManifest(output, { schema: "qorpera.model-login-helper-package/v1", artifacts }, { mode: 0o600 });
console.log(output);
