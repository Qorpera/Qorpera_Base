import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOfficePathAbsent, officeOwnedDirectoryIdentity, removeOfficeOwnedDirectory,
	verifyOfficeGuardArchives, verifyOfficeLifecycleEpochs } from "./office-lifecycle-evidence.mjs";

const id = number => `67800000-0000-4000-8000-${String(number).padStart(12, "0")}`;
function fixture() {
	// Unit-only identities validate refusal paths, never physical acceptance.
	const boots = ["initial", "outage_recovery", "ordinary_resume", "service_restart", "root_reset"].map((phase, index) => ({
		phase, activationId: id(10 + index), allocationId: id(1), physicalId: id(index === 4 ? 3 : 2),
		hostBootId: id(4), guestBootId: id(index === 3 ? 22 : 20 + index),
	}));
	const permits = boots.filter(boot => boot.phase !== "service_restart").map((boot, index) => ({
		schema: "qorpera.computer-usage-permit/v2", permitId: id(30 + index), epoch: id(40 + index), state: "closed",
		allocationId: boot.allocationId, physicalId: boot.physicalId, hostBootId: boot.hostBootId, guestBootId: boot.guestBootId,
		prestart: { guardIncarnationId: id(5), prepareSha256: "a".repeat(64) }, validForMs: 0,
	}));
	const expected = permits.map((permit, index) => ({ permit,
		cursor: { sequence: 10 + index, sha256: String(index + 1).repeat(64), observationId: id(50 + index), sealed: true },
		sampleCount: 10 + index, terminalSample: { observationId: id(50 + index), physicalId: permit.physicalId, hostBootId: permit.hostBootId,
			guestUptimeMs: null, hostUptimeMs: 20000 + index, state: "stopped" },
	}));
	const archives = expected.map((row, index) => ({ sha256: String(index + 5).repeat(64), value: {
		schema: "qorpera.computer-guard-archive/v1", sequence: index + 1, previousSha256: index ? String(index + 4).repeat(64) : null,
		prestart: { intent: { permitId: row.permit.permitId, prepareSha256: row.permit.prestart.prepareSha256 }, guardIncarnationId: id(5) },
		closure: structuredClone(row.permit), guard: { phase: "stopped", startDispatched: true, startSettled: true, startSucceeded: true, usageRequired: true,
			permit: { permitId: row.permit.permitId }, machine: { physicalInstanceId: row.permit.physicalId },
			stopReceipt: { permitId: row.permit.permitId, allocationId: row.permit.allocationId, physicalInstanceId: row.permit.physicalId,
				hostBootId: row.permit.hostBootId, closedHostBootId: row.permit.hostBootId, closedAtUptimeMs: row.terminalSample.hostUptimeMs, state: "stopped" },
		},
	} }));
	const usage = expected.map((row, index) => ({ permitId: row.permit.permitId, status: structuredClone(archives[index].value.guard), page: {
		permitId: row.permit.permitId, epoch: row.permit.epoch, state: "sealed", finalSequence: row.cursor.sequence, entries: [],
		head: { sequence: row.cursor.sequence, sha256: row.cursor.sha256, observationId: row.cursor.observationId },
		acknowledgedThrough: { sequence: row.cursor.sequence, sha256: row.cursor.sha256, observationId: row.cursor.observationId },
	} }));
	return { boots, permits, expected, retained: { activeGuards: [], activePrestarts: [], journalGuards: [], archives, usage,
		anchor: { schema: "qorpera.computer-prestart-journal/v2", guardIncarnationId: id(5), records: [], archiveCount: 4, archiveHeadSha256: "8".repeat(64) } } };
}

test("four independently observed boots map exactly to four closed epochs; service restart reuses resume", () => {
	const { boots, permits } = fixture();
	const result = verifyOfficeLifecycleEpochs(boots, permits.toReversed());
	assert.equal(result.epochs.length, 4);
	assert.equal(result.serviceRestart.permitId, permits[2].permitId);
	assert.equal(result.serviceRestart.epoch, permits[2].epoch);
});

for (const [name, change] of [
	["missing physical boot", f => f.boots.splice(1, 1)],
	["missing SQL epoch", f => f.permits.splice(1, 1)],
	["extra SQL epoch", f => f.permits.push(structuredClone(f.permits[0]))],
	["duplicate permit", f => { f.permits[1].permitId = f.permits[0].permitId; }],
	["duplicate epoch", f => { f.permits[1].epoch = f.permits[0].epoch; }],
	["wrong paid boot", f => { f.permits[1].guestBootId = id(90); }],
	["wrong paid physical VM", f => { f.permits[1].physicalId = id(90); }],
	["wrong paid host boot", f => { f.permits[1].hostBootId = id(90); }],
	["wrong paid allocation", f => { f.permits[1].allocationId = id(90); }],
	["open paid epoch", f => { f.permits[1].state = "bound"; }],
	["restart reboot", f => { f.boots[3].guestBootId = id(90); }],
	["outage reused predecessor boot", f => { f.boots[1].guestBootId = f.boots[0].guestBootId; }],
	["reset retained old VM", f => { f.boots[4].physicalId = f.boots[0].physicalId; }],
	["resume replaced VM", f => { f.boots[2].physicalId = id(90); }],
	["duplicate activation", f => { f.boots[3].activationId = f.boots[2].activationId; }],
]) test(`epoch oracle refuses ${name}`, () => {
	const f = fixture(); change(f);
	assert.throws(() => verifyOfficeLifecycleEpochs(f.boots, f.permits));
});

test("immutable closure, terminal SQL cursor and drained producer anchor agree for every epoch", () => {
	const { expected, retained } = fixture();
	const result = verifyOfficeGuardArchives(expected.toReversed(), retained);
	assert.equal(result.archiveCount, 4);
	assert.equal(result.archiveHeadSha256, "8".repeat(64));
	assert.deepEqual(result.permits.map(row => row.permitId), retained.archives.map(row => row.value.closure.permitId));
});

for (const [name, change] of [
	["live guard", f => f.retained.activeGuards.push({})],
	["live prestart", f => f.retained.activePrestarts.push({})],
	["unarchived disk guard", f => f.retained.journalGuards.push({})],
	["durable prestart", f => f.retained.anchor.records.push({})],
	["missing archive", f => f.retained.archives.pop()],
	["extra archive", f => f.retained.archives.push(structuredClone(f.retained.archives[0]))],
	["duplicate archived permit", f => { f.retained.archives[1].value.prestart.intent.permitId = f.expected[0].permit.permitId; }],
	["wrong closure", f => { f.retained.archives[1].value.closure.epoch = id(90); }],
	["open SQL receipt", f => { f.expected[1].permit.state = "bound"; }],
	["wrong archive sequence", f => { f.retained.archives[1].value.sequence++; }],
	["broken archive chain", f => { f.retained.archives[1].value.previousSha256 = "f".repeat(64); }],
	["wrong anchor count", f => { f.retained.anchor.archiveCount++; }],
	["wrong anchor head", f => { f.retained.anchor.archiveHeadSha256 = "f".repeat(64); }],
	["wrong guard incarnation", f => { f.retained.anchor.guardIncarnationId = id(90); }],
	["different prepared request", f => { f.retained.archives[1].value.prestart.intent.prepareSha256 = "f".repeat(64); }],
	["unsettled physical start", f => { f.retained.archives[1].value.guard.startSettled = false; }],
	["different retained status", f => { f.retained.usage[1].status.phase = "running"; }],
	["missing usage prefix", f => f.retained.usage.pop()],
	["unsealed usage", f => { f.retained.usage[1].page.state = "open"; }],
	["wrong final sequence", f => { f.retained.usage[1].page.finalSequence--; }],
	["pending upload", f => f.retained.usage[1].page.entries.push({})],
	["trailing ACK", f => { f.retained.usage[1].page.acknowledgedThrough.sequence--; }],
	["unsealed SQL cursor", f => { f.expected[1].cursor.sealed = false; }],
	["wrong SQL cursor hash", f => { f.expected[1].cursor.sha256 = "f".repeat(64); }],
	["wrong SQL cursor observation", f => { f.expected[1].cursor.observationId = id(90); }],
	["missing SQL sample", f => { f.expected[1].sampleCount--; }],
	["nonterminal SQL tip", f => { f.expected[1].terminalSample.state = "running"; }],
	["wrong terminal stop clock", f => { f.expected[1].terminalSample.hostUptimeMs++; }],
	["wrong terminal physical VM", f => { f.expected[1].terminalSample.physicalId = id(90); }],
]) test(`archive oracle refuses ${name}`, () => {
	const f = fixture(); change(f);
	assert.throws(() => verifyOfficeGuardArchives(f.expected, f.retained));
});

test("owned directory cleanup verifies absence and preserves replaced or symlinked custody", async () => {
	const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-office-oracle-"));
	const path = join(root, "owned"), moved = join(root, "retained");
	try {
		await assertOfficePathAbsent(path);
		await mkdir(path, { mode: 0o700 });
		await writeFile(join(path, "archive.json"), "retained", { mode: 0o600 });
		const identity = await officeOwnedDirectoryIdentity(path, process.getuid(), 0o700);
		await assert.rejects(assertOfficePathAbsent(path), /remains present/);
		await rename(path, moved); await mkdir(path, { mode: 0o700 });
		await assert.rejects(removeOfficeOwnedDirectory(identity), /identity changed/);
		await rm(path, { recursive: true }); await symlink(moved, path);
		await assert.rejects(removeOfficeOwnedDirectory(identity), /identity invalid/);
		await rm(path); await rename(moved, path);
		await assert.rejects(officeOwnedDirectoryIdentity(path, process.getuid() + 1, 0o700), /identity invalid/);
		await assert.rejects(officeOwnedDirectoryIdentity(path, process.getuid(), 0o755), /identity invalid/);
		await removeOfficeOwnedDirectory(identity);
		await assertOfficePathAbsent(path);
	} finally { await rm(root, { recursive: true, force: true }); }
});
