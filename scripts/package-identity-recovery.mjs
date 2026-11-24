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
		usage: "Usage: node scripts/package-identity-recovery.mjs --out <new-directory>",
	}),
	{ mode: 0o700 },
);
await bundleNodeEntries({
	entries: [
		["packages/runtime/src/cloud-identity-recovery-service-main.ts", "qorpera-identity-recovery-service.mjs"],
		["packages/runtime/src/cloud-identity-recovery-restore-main.ts", "qorpera-identity-recovery-restore.mjs"],
	],
	outputRoot: output,
});
await copyPackageFiles(["deploy/identity-recovery/qorpera-identity-recovery.service"], output);
const artifacts = await hashPackageFiles(
	["qorpera-identity-recovery-service.mjs", "qorpera-identity-recovery-restore.mjs", "qorpera-identity-recovery.service"],
	output,
);
await writeManifest(output, { schema: "qorpera.identity-recovery-package/v1", artifacts }, { mode: 0o600 });
console.log(output);
