// Seals tested bytes; never issues approval, a release window, or a production claim.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED, ROOT, exact, hash, need, pinValid } from "./contract.mjs";
import { assertAbsent, assertDirectory, readTrusted, writeExclusive } from "./files.mjs";
import { PACKET_SHA256, READY, RELEASE_PINS, checkPacket } from "./controller.mjs";

const ROOT_FILES = ["README.md", "OFFLINE-TESTS.json", "WRAPPER-REHEARSAL.json", "build-packet.mjs", "contract.mjs",
	"controller.mjs", "files.mjs", "freeze-packet.mjs", "verify-offline.mjs", "inputs.json", "packet.json",
	"packet.test.mjs", "sql-packet.mjs", "transport.mjs", "transport.test.mjs", "rehearse-wrapper.mjs", "rehearsal-baseline.json"];
const pinFor = (name) => { const bytes = readTrusted(join(ROOT, name)); return { bytes: bytes.length, sha256: hash(bytes) }; };
function inventoryNames(sealed) {
	assertDirectory(ROOT); assertDirectory(join(ROOT, "sql"));
	need(!READY && Object.values(RELEASE_PINS).every((value) => value === null), "NOT_DISABLED_PACKET");
	const packet = checkPacket();
	need(JSON.stringify(readdirSync(ROOT).sort()) === JSON.stringify([...ROOT_FILES, "sql", ...(sealed ? ["FROZEN.json", "SHA256SUMS"] : [])].sort()), "ROOT_INVENTORY_CHANGED");
	need(JSON.stringify(readdirSync(join(ROOT, "sql")).sort()) === JSON.stringify(Object.keys(packet.sql).sort()), "SQL_INVENTORY_CHANGED");
	const tests = JSON.parse(readTrusted(join(ROOT, "OFFLINE-TESTS.json")));
	need(tests.schema === "qorpera.rollout-offline-tests/v1" && tests.packetSha256 === PACKET_SHA256 && tests.passed === true
		&& Number.isSafeInteger(tests.tests) && tests.tests > 0 && tests.failed === 0 && tests.productionWrites === false, "TEST_RECEIPT_REJECTED");
	need(exact(tests.fileSha256, ["packet.test.mjs", "transport.test.mjs", "contract.mjs", "files.mjs", "sql-packet.mjs", "build-packet.mjs", "transport.mjs", "controller.mjs", "inputs.json", "packet.json"]), "TEST_INVENTORY_REJECTED");
	for (const [name, pin] of Object.entries(tests.fileSha256)) need(pinFor(name).sha256 === pin, "TESTED_BYTES_CHANGED");
	const rehearsal = JSON.parse(readTrusted(join(ROOT, "WRAPPER-REHEARSAL.json")));
	need(rehearsal.schema === "qorpera.rollout-wrapper-rehearsal/v1" && rehearsal.packetSha256 === PACKET_SHA256
		&& rehearsal.passed === true && rehearsal.databaseKind === "disposable-postgresql" && rehearsal.productionWrites === false
		&& rehearsal.allMutationStepsRehearsed === true && rehearsal.replayRejected === true && rehearsal.cleanupConfirmed === true
		&& rehearsal.rehearsalToolSha256 === pinFor("rehearse-wrapper.mjs").sha256
		&& rehearsal.baselineSha256 === pinFor("rehearsal-baseline.json").sha256
		&& exact(rehearsal.sql, Object.keys(packet.sql))
		&& Object.entries(packet.sql).every(([name, pin]) => rehearsal.sql[name] === pin.sha256), "REHEARSAL_RECEIPT_REJECTED");
	return [...ROOT_FILES, ...Object.keys(packet.sql).map((name) => `sql/${name}`)].sort();
}
const checksums = (files) => Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, pin]) => `${pin.sha256}  ${name}\n`).join("");
export function freezePacket() {
	assertAbsent(join(ROOT, "FROZEN.json")); assertAbsent(join(ROOT, "SHA256SUMS"));
	const files = Object.fromEntries(inventoryNames(false).map((name) => [name, pinFor(name)]));
	const manifest = { schema: "qorpera.company41-production-rollout-offline-freeze/v2", sourceCommit: FIXED.commit,
		runtimeBundleSha256: FIXED.bundle, projectRef: FIXED.project, packetSha256: PACKET_SHA256, files,
		offlineTests: pinFor("OFFLINE-TESTS.json"), wrapperRehearsal: pinFor("WRAPPER-REHEARSAL.json"),
		issuedAt: null, expiresAt: null, executionEnabled: false, actualGateBindingsIssued: false,
		productionReady: false, productionWrites: false };
	const frozen = writeExclusive(join(ROOT, "FROZEN.json"), manifest);
	writeExclusive(join(ROOT, "SHA256SUMS"), Buffer.from(checksums({ ...files, "FROZEN.json": frozen })));
	return verifyPacket();
}
export function verifyPacket() {
	const names = inventoryNames(true), bytes = readTrusted(join(ROOT, "FROZEN.json")), manifest = JSON.parse(bytes);
	need(manifest.schema === "qorpera.company41-production-rollout-offline-freeze/v2" && manifest.packetSha256 === PACKET_SHA256
		&& manifest.sourceCommit === FIXED.commit && manifest.runtimeBundleSha256 === FIXED.bundle && manifest.projectRef === FIXED.project
		&& manifest.executionEnabled === false && manifest.actualGateBindingsIssued === false && manifest.productionWrites === false
		&& manifest.productionReady === false && manifest.issuedAt === null && manifest.expiresAt === null && exact(manifest.files, names), "FROZEN_MANIFEST_REJECTED");
	for (const [name, pin] of Object.entries(manifest.files)) {
		const current = pinFor(name); need(pinValid(pin) && current.bytes === pin.bytes && current.sha256 === pin.sha256, "FROZEN_BYTES_CHANGED");
	}
	for (const [key, name] of [["offlineTests", "OFFLINE-TESTS.json"], ["wrapperRehearsal", "WRAPPER-REHEARSAL.json"]])
		need(JSON.stringify(manifest[key]) === JSON.stringify(pinFor(name)), "RECEIPT_PIN_CHANGED");
	const pin = { bytes: bytes.length, sha256: hash(bytes) };
	need(readTrusted(join(ROOT, "SHA256SUMS")).equals(Buffer.from(checksums({ ...manifest.files, "FROZEN.json": pin }))), "SUMS_CHANGED");
	return { passed: true, files: names.length, manifest: pin, packetSha256: PACKET_SHA256, executionEnabled: false, actualGateBindingsIssued: false, productionWrites: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { need(process.argv.length === 3 && ["freeze", "verify"].includes(process.argv[2]));
		console.log(JSON.stringify(process.argv[2] === "freeze" ? freezePacket() : verifyPacket()));
	} catch (error) { console.error(JSON.stringify({ passed: false, code: "OFFLINE_FREEZE_REJECTED", reason: error.message, productionWrites: false })); process.exitCode = 1; }
}
