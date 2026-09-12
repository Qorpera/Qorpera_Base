import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/prepare-office-service-software-revision.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("prepares a verifiable service-only revision: previous inventory with only the service entry replaced, signed and planned", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "office-software-revision-"));
	try {
		const helper = join(temporary, "helper.mjs");
		await build({
			absWorkingDir: root,
			stdin: {
				contents: [
					'export { officeSoftwareFixture } from "./packages/runner-orchestrator/test/fixtures/office-software.ts";',
					'export { officeServiceRestartFixture } from "./packages/runner-orchestrator/test/fixtures/office-service-restart.ts";',
					'export { verifyLxdOfficeServiceSoftware } from "./packages/runner-orchestrator/src/lxd-office-service-software.ts";',
					'export { officeCanonical, officeDigest } from "./packages/runner-orchestrator/src/lxd-office-image-provenance.ts";',
				].join("\n"),
				resolveDir: root,
				loader: "ts",
			},
			outfile: helper,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22.19",
			logLevel: "silent",
		});
		const h = await import(pathToFileURL(helper).href);
		const software = h.officeSoftwareFixture(), restart = h.officeServiceRestartFixture();
		const predecessor = restart.request.stop.revocation.request, acknowledgement = restart.request.acknowledgement;
		const keys = generateKeyPairSync("ed25519");
		const previousManifest = join(temporary, "previous-manifest.json"), service = join(temporary, "service.mjs");
		const predecessorFile = join(temporary, "predecessor.json"), acknowledgementFile = join(temporary, "acknowledgement.json");
		const key = join(temporary, "signing.pem"), out = join(temporary, "revision");
		const serviceBytes = randomBytes(300);
		await writeFile(previousManifest, `${JSON.stringify(software.previous, null, 2)}\n`);
		await writeFile(service, serviceBytes);
		await writeFile(predecessorFile, JSON.stringify(predecessor));
		await writeFile(acknowledgementFile, JSON.stringify(acknowledgement));
		await writeFile(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
		const args = (overrides = {}) => Object.entries({
			"--previous-manifest": previousManifest, "--next-service": service, "--source-commit": "a".repeat(40), "--previous-source-commit": "1".repeat(40),
			"--repository": "https://example.test/source", "--evidence-sha256": hash("reviewed evidence"), "--predecessor": predecessorFile,
			"--stop-acknowledgement": acknowledgementFile, "--signing-key": key, "--out": out, "--acceptance-tested-at": "2026-09-12T10:00:00.000Z", ...overrides,
		}).flat();
		const run = (argv) => spawnSync(process.execPath, [script, ...argv], { cwd: tmpdir(), encoding: "utf8", timeout: 60000 });
		const prepared = run(args());
		assert.equal(prepared.status, 0, prepared.stderr);
		assert.equal(prepared.stderr, "");
		const summary = JSON.parse(prepared.stdout);
		assert.equal(summary.out, out);
		assert.deepEqual((await readdir(out)).sort(), ["README.md", "envelope.json", "manifest.json", "next-manifest.json", "plan.json", "previous-manifest.json", "qorpera-company-computer-service.mjs", "statement.json", "trust.json"]);
		const read = async (file) => readFile(join(out, file));
		const json = async (file) => JSON.parse((await read(file)).toString());
		const envelope = await json("envelope.json"), plan = await json("plan.json"), trust = await json("trust.json"), manifest = await json("manifest.json");
		const manifests = { previous: await read("previous-manifest.json"), next: await read("next-manifest.json") };
		assert.equal(manifests.previous.toString(), `${JSON.stringify(software.previous, null, 2)}\n`);
		const verified = h.verifyLxdOfficeServiceSoftware(envelope, plan, trust, manifests);
		assert.equal(verified.plan.updateId, summary.updateId);
		assert.equal(verified.planSha256, summary.planSha256);
		assert.equal(trust.verificationKeySpki, keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
		assert.equal(trust.statementSha256, h.officeDigest(envelope.statement));
		assert.equal(trust.planSha256, h.officeDigest(plan));
		assert.equal(plan.stopAcknowledgementSha256, h.officeDigest(acknowledgement));
		assert.deepEqual(plan.predecessor, predecessor);
		assert.equal(plan.statementSha256, trust.statementSha256);
		assert.notEqual(plan.updateId, plan.successorActivationId);
		const next = JSON.parse(manifests.next.toString());
		const expected = structuredClone(software.previous);
		const index = expected.artifacts.findIndex((artifact) => artifact.file === "qorpera-company-computer-service.mjs");
		expected.artifacts[index] = { ...expected.artifacts[index], bytes: 300, sha256: hash(serviceBytes) };
		assert.deepEqual(next, expected);
		const statement = envelope.statement;
		assert.deepEqual(statement.base, { imageSha256: predecessor.startup.imageSha256, bootstrapSha256: predecessor.startup.bootstrapSha256, packageManifestSha256: hash(manifests.previous), sourceCommit: "1".repeat(40) });
		assert.deepEqual(statement.previous, { packageManifestSha256: hash(manifests.previous), sourceCommit: "1".repeat(40), service: { path: "/opt/qorpera-office/qorpera-company-computer-service.mjs", bytes: 123, sha256: hash("qorpera-company-computer-service.mjs") } });
		assert.deepEqual(statement.next, { packageManifestSha256: hash(manifests.next), service: { path: "/opt/qorpera-office/qorpera-company-computer-service.mjs", bytes: 300, sha256: hash(serviceBytes) } });
		assert.deepEqual(statement.source, { repository: "https://example.test/source", commit: "a".repeat(40), tree: "clean" });
		assert.deepEqual(statement.acceptance, { testedAt: "2026-09-12T10:00:00.000Z", evidenceSha256: hash("reviewed evidence"), change: "service-only" });
		assert.deepEqual(await json("statement.json"), statement);
		assert.ok((await read("qorpera-company-computer-service.mjs")).equals(serviceBytes));
		assert.equal(manifest.schema, "qorpera.office-service-software-revision/v1");
		assert.equal(manifest.trustSha256, hash(h.officeCanonical(trust)));
		assert.equal(summary.trustSha256, manifest.trustSha256);
		for (const artifact of manifest.artifacts) assert.equal(hash(await read(artifact.file)), artifact.sha256);
		const readme = (await read("README.md")).toString();
		assert.match(readme, new RegExp(plan.updateId));
		for (const text of [prepared.stdout, readme, JSON.stringify(manifest)]) { assert.ok(!text.includes("PRIVATE KEY")); assert.ok(!text.includes(key)); }
		// Existing output, unchanged service and a foreign acknowledgement are refused.
		const existing = run(args());
		assert.equal(existing.status, 1); assert.equal(existing.stderr, "OFFICE_SOFTWARE_REVISION_OUTPUT_EXISTS\n");
		await writeFile(join(temporary, "same.mjs"), "qorpera-company-computer-service.mjs");
		const unchanged = run(args({ "--next-service": join(temporary, "same.mjs"), "--out": join(temporary, "unchanged") }));
		assert.equal(unchanged.status, 1); assert.equal(unchanged.stderr, "OFFICE_SOFTWARE_REVISION_INPUT_INVALID\n");
		await writeFile(join(temporary, "foreign.json"), JSON.stringify({ ...acknowledgement, request: { ...predecessor, transitionId: "00000000-0000-4000-8000-0000000000ff" } }));
		const foreign = run(args({ "--stop-acknowledgement": join(temporary, "foreign.json"), "--out": join(temporary, "foreign") }));
		assert.equal(foreign.status, 1); assert.equal(foreign.stderr, "OFFICE_SOFTWARE_REVISION_INPUT_INVALID\n");
		const wrongKey = join(temporary, "rsa.pem");
		await writeFile(wrongKey, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
		const badKey = run(args({ "--signing-key": wrongKey, "--out": join(temporary, "badkey") }));
		assert.equal(badKey.status, 1); assert.equal(badKey.stderr, "OFFICE_SOFTWARE_REVISION_KEY_INVALID\n");
		const encryptedKey = join(temporary, "encrypted.pem");
		await writeFile(encryptedKey, keys.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "fixture-passphrase" }), { mode: 0o600 });
		const locked = run(args({ "--signing-key": encryptedKey, "--out": join(temporary, "locked") }));
		assert.equal(locked.status, 1); assert.equal(locked.stderr, "OFFICE_SOFTWARE_REVISION_KEY_INVALID\n");
		const unlocked = spawnSync(process.execPath, [script, ...args({ "--signing-key": encryptedKey, "--signing-key-passphrase-stdin": "true", "--out": join(temporary, "unlocked") })], { cwd: tmpdir(), encoding: "utf8", timeout: 60000, input: "fixture-passphrase\n" });
		assert.equal(unlocked.status, 0, unlocked.stderr);
		assert.equal(JSON.parse(await readFile(join(temporary, "unlocked", "trust.json"), "utf8")).verificationKeySpki, keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
		const wrongPassphrase = spawnSync(process.execPath, [script, ...args({ "--signing-key": encryptedKey, "--signing-key-passphrase-stdin": "true", "--out": join(temporary, "wrongpass") })], { cwd: tmpdir(), encoding: "utf8", timeout: 60000, input: "not-it\n" });
		assert.equal(wrongPassphrase.status, 1); assert.equal(wrongPassphrase.stderr, "OFFICE_SOFTWARE_REVISION_KEY_INVALID\n");
		const retainedSuccessor = "00000000-0000-4000-8000-0000000000ee";
		const pinnedRun = run(args({ "--successor-activation-id": retainedSuccessor, "--out": join(temporary, "pinned") }));
		assert.equal(pinnedRun.status, 0, pinnedRun.stderr);
		assert.equal(JSON.parse(await readFile(join(temporary, "pinned", "plan.json"), "utf8")).successorActivationId, retainedSuccessor);
		const collidingSuccessor = run(args({ "--successor-activation-id": predecessor.activationId, "--out": join(temporary, "colliding") }));
		assert.equal(collidingSuccessor.status, 2); assert.equal(collidingSuccessor.stderr, "OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID\n");
		const missing = run(args().slice(2));
		assert.equal(missing.status, 2); assert.equal(missing.stderr, "OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID\n");
		const help = run(["--help"]);
		assert.equal(help.status, 0); assert.match(help.stdout, /--signing-key/);
		for (const name of ["unchanged", "foreign", "badkey", "locked", "wrongpass", "colliding"]) await assert.rejects(readdir(join(temporary, name)));
		// The retained stop-worker records are accepted as-is for both inputs.
		await writeFile(join(temporary, "stop-record.json"), JSON.stringify({ schema: "qorpera.lxd-office-stop-request/v1", request: restart.request.stop, command: acknowledgement.inspection.stop.command }));
		await writeFile(join(temporary, "completed-record.json"), JSON.stringify({ schema: "qorpera.lxd-office-stop-completion/v1", intentId: "00000000-0000-4000-8000-0000000000aa", allocationId: predecessor.startup.allocationId, transitionId: predecessor.transitionId, commandId: acknowledgement.inspection.stop.command.commandId, receipt: acknowledgement }));
		const retained = run(args({ "--predecessor": join(temporary, "stop-record.json"), "--stop-acknowledgement": join(temporary, "completed-record.json"), "--out": join(temporary, "retained") }));
		assert.equal(retained.status, 0, retained.stderr);
		const retainedPlan = JSON.parse((await readFile(join(temporary, "retained/plan.json"))).toString());
		assert.deepEqual(retainedPlan.predecessor, predecessor);
		assert.equal(retainedPlan.stopAcknowledgementSha256, plan.stopAcknowledgementSha256);
		assert.notEqual(retainedPlan.updateId, plan.updateId);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
