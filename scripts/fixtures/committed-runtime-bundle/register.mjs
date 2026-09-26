// Test and CI support only; production packaging never loads this module.
// Loaded with --import (see runtimeBundlePackagingEnvironment in
// scripts/runtime-bundle-release-train.mjs) when QORPERA_ENFORCE_RUNTIME_BUNDLE
// is not "1". It hands scripts/package-ephemeral-runner.mjs, and nothing else,
// the generator stand-in next to this file.
import { registerHooks } from "node:module";

const packager = new URL("../../package-ephemeral-runner.mjs", import.meta.url).href;
const generator = new URL("../../generate-cloud-runtime-bundle.mjs", import.meta.url).href;
const committed = new URL("./generate-cloud-runtime-bundle.mjs", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		return context.parentURL === packager && resolved.url === generator ? { ...resolved, url: committed } : resolved;
	},
});
