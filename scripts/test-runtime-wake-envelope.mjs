import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Resolve headless workspace source without depending on a stale dist tree.
const compiled = await build({
 stdin: { contents: 'export { parseCloudNativeToolAuthority, parseCloudNativeToolBinding } from "../packages/runtime/src/cloud-native-tool-authority.ts"; export { parseCloudWakeEnvelope } from "../packages/runtime/src/cloud-wake-bus.ts";', resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
 bundle: true, platform: "node", format: "esm", target: "node22", write: false, logLevel: "silent",
});
const { parseCloudNativeToolAuthority, parseCloudNativeToolBinding, parseCloudWakeEnvelope } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);

// The disposable database driver supplies the real SQL-produced authority and
// envelope together. No model, provider, HTTP request or fabricated identity is
// involved in this contract check.
const cases = JSON.parse(readFileSync(0, "utf8"));
assert.deepEqual(cases.map((item) => item.name), [
	"human", "first-run", "routine-default", "routine-optional", "routine-required", "routine-silent", "agent",
]);
for (const item of cases) {
	const binding = parseCloudNativeToolBinding(item.binding);
	const authority = parseCloudNativeToolAuthority(item.authority, binding);
	const envelope = parseCloudWakeEnvelope(item.envelope, authority.identity);
	assert.deepEqual(envelope, item.envelope, `SQL / TypeScript envelope drift: ${item.name}`);
	assert(Object.isFrozen(envelope) && Object.isFrozen(envelope.payload) && Object.isFrozen(envelope.policy));
}
const human = cases[0];
assert.throws(() => parseCloudWakeEnvelope({ ...human.envelope, kind: "room", policy: {
	schema: "qorpera.wake-policy/v1", kind: "room", initial: "optional", final: "optional", silenceAllowed: true, maxPublicSends: null,
} }, parseCloudNativeToolAuthority(human.authority, parseCloudNativeToolBinding(human.binding)).identity));
console.log("SQL-produced human, first-run, schedule and agent envelopes pass the actual TypeScript parser; a relabeled human envelope stays rejected as a room");
