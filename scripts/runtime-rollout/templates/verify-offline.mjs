import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, hash } from "./contract.mjs";
import { assertAbsent, readTrusted, writeExclusive } from "./files.mjs";
import { PACKET_SHA256, checkPacket } from "./controller.mjs";

checkPacket();
assertAbsent(join(ROOT, "OFFLINE-TESTS.json"));
const names = ["packet.test.mjs", "transport.test.mjs", "contract.mjs", "files.mjs", "sql-packet.mjs", "build-packet.mjs", "transport.mjs", "controller.mjs", "inputs.json", "packet.json"];
const pins = Object.fromEntries(names.map((name) => [name, hash(readTrusted(join(ROOT, name)))]));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...names.slice(0, 2)], {
	cwd: ROOT, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert(!result.error && result.status === 0, "Offline tests failed");
const counts = [...result.stdout.matchAll(/^# (tests|pass|fail) (\d+)$/gm)];
assert.equal(counts.length, 3, "Test summary is missing or ambiguous");
const totals = Object.fromEntries(counts.map((match) => [match[1], Number(match[2])]));
assert(totals.tests > 0 && totals.pass === totals.tests && totals.fail === 0);
for (const name of names) assert.equal(hash(readTrusted(join(ROOT, name))), pins[name], "Tested bytes changed");
writeExclusive(join(ROOT, "OFFLINE-TESTS.json"), {
	schema: "qorpera.rollout-offline-tests/v1", packetSha256: PACKET_SHA256, passed: true, tests: totals.tests,
	failed: totals.fail, fileSha256: pins, transcriptSha256: hash(result.stdout), productionWrites: false,
	actualCLIInvocations: 0, actualDatabaseInvocations: 0,
});
