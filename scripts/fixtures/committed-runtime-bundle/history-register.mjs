// Explicit test-only preload used by test-runtime-history.mjs. Never used by
// the direct provenance rollout gate or any packager.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeBundleEnforced } from "../../runtime-bundle-release-train.mjs";

const driver = new URL("../../test-runtime-provenance.mjs", import.meta.url).href;
assert.equal(runtimeBundleEnforced(), false, "Committed history fixture forbidden in release acceptance");
assert.equal(pathToFileURL(resolve(process.argv[1] ?? "")).href, driver, "History fixture restricted to its SQL test driver");
const generator = new URL("../../generate-cloud-runtime-bundle.mjs", import.meta.url).href;
const committed = new URL("./generate-cloud-runtime-bundle.mjs", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		return context.parentURL === driver && resolved.url === generator ? { ...resolved, url: committed } : resolved;
	},
});
