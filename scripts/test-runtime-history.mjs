// Feature-branch SQL history acceptance against the last committed release
// identity. This is not a rollout gate: test-runtime-provenance.mjs remains
// strict when invoked directly and release CI always invokes it directly.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkRuntimeBundle, runtimeBundleEnforced } from "./runtime-bundle-release-train.mjs";

assert.equal(process.argv.length, 2, "Usage: test-runtime-history.mjs");
assert.equal(runtimeBundleEnforced(), false, "Release acceptance must invoke test-runtime-provenance.mjs directly");
const result = await checkRuntimeBundle({ enforced: false });
console.log(`SQL history acceptance against committed release identity; source freshness ${result.fresh ? "verified" : "NOT verified"}. This does not certify a release.`);

const run = spawnSync(process.execPath, [
	"--import", new URL("./fixtures/committed-runtime-bundle/history-register.mjs", import.meta.url).href,
	fileURLToPath(new URL("./test-runtime-provenance.mjs", import.meta.url)),
], { stdio: "inherit", timeout: 15 * 60000 });
if (run.error) throw run.error;
assert.equal(run.status, 0, "Committed-identity SQL history acceptance failed");
