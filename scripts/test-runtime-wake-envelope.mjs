import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCloudNativeToolAuthority, parseCloudNativeToolBinding } from "../packages/shell/src/cloud-native-tool-authority.ts";
import { parseCloudWakeEnvelope } from "../packages/shell/src/cloud-wake-bus.ts";

// The disposable database driver supplies the real SQL-produced authority and
// envelope together. No model, provider, HTTP request or fabricated identity is
// involved in this contract check.
const cases = JSON.parse(readFileSync(0, "utf8"));
assert.deepEqual(cases.map((item) => item.name), [
	"human", "first-run", "routine-default", "routine-optional", "routine-required", "routine-silent", "company-file", "agent",
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
	schema: "qorpera.wake-policy/v1", kind: "room", initial: "optional", final: "optional", silenceAllowed: true, maxPublicSends: 3,
} }, parseCloudNativeToolAuthority(human.authority, parseCloudNativeToolBinding(human.binding)).identity));
console.log("SQL-produced human, first-run, schedule, File and agent envelopes pass the actual TypeScript parser; room stays rejected");
