// Test and CI support only; production packaging never loads this module.
// Loaded with --import (see runtimeBundlePackagingEnvironment in
// scripts/runtime-bundle-release-train.mjs) when QORPERA_ENFORCE_RUNTIME_BUNDLE
// is not "1". Only the explicitly listed packagers receive the generator
// stand-in next to this file; production packaging never enables this hook.
import { registerHooks } from "node:module";

const packagers = new Set([
	"package-ephemeral-runner.mjs",
	"package-coding-executor.mjs",
	"package-runtime-computer-guard.mjs",
].map((name) => new URL(`../../${name}`, import.meta.url).href));
const generator = new URL("../../generate-cloud-runtime-bundle.mjs", import.meta.url).href;
const committed = new URL("./generate-cloud-runtime-bundle.mjs", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		return packagers.has(context.parentURL) && resolved.url === generator ? { ...resolved, url: committed } : resolved;
	},
});
