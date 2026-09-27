import assert from "node:assert/strict";
import { lstat, realpath, rm } from "node:fs/promises";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const phases = ["initial", "outage_recovery", "ordinary_resume", "service_restart", "root_reset"];

/** Boots come from direct /proc reads inside the actual LXD guest, bracketed
 * by exact physical ownership checks. Permits come independently from SQL.
 * A service restart keeps the resumed paid epoch; the other four boots must
 * each have exactly one distinct, closed permit. */
export function verifyOfficeLifecycleEpochs(boots, permits) {
	assert(Array.isArray(boots) && Array.isArray(permits), "Office epoch evidence missing");
	assert.deepEqual(boots.map(boot => boot.phase), phases, "Office lifecycle boot coverage differs");
	for (const boot of boots) for (const key of ["activationId", "allocationId", "physicalId", "hostBootId", "guestBootId"])
		assert(uuid.test(boot[key]), "Office physical boot identity invalid");
	assert.equal(new Set(boots.map(boot => boot.activationId)).size, phases.length, "Office activation reused");
	assert.equal(new Set(boots.map(boot => boot.allocationId)).size, 1, "Office allocation changed");
	assert.equal(new Set(boots.map(boot => boot.hostBootId)).size, 1, "Office host boot changed");
	const [initial, outage, resume, restart, reset] = boots;
	for (const boot of [outage, resume, restart]) assert.equal(boot.physicalId, initial.physicalId, "Retained office VM changed");
	assert.notEqual(reset.physicalId, initial.physicalId, "Office root reset did not replace VM");
	assert.equal(restart.guestBootId, resume.guestBootId, "Service restart changed the paid boot");
	const epochs = [initial, outage, resume, reset];
	assert.equal(new Set(epochs.map(boot => boot.guestBootId)).size, 4, "Office lifecycle reused a guest boot");
	assert.equal(permits.length, epochs.length, "Missing or extra office paid epoch");
	for (const permit of permits) {
		for (const key of ["permitId", "epoch", "allocationId", "physicalId", "hostBootId", "guestBootId"])
			assert(uuid.test(permit[key]), "Office SQL permit identity invalid");
		assert.equal(permit.state, "closed", "Office paid epoch remains open");
	}
	assert.equal(new Set(permits.map(permit => permit.permitId)).size, 4, "Duplicate office permit");
	assert.equal(new Set(permits.map(permit => permit.epoch)).size, 4, "Duplicate office paid epoch");
	const mapped = epochs.map(boot => {
		const matches = permits.filter(permit => ["allocationId", "physicalId", "hostBootId", "guestBootId"].every(key => permit[key] === boot[key]));
		assert.equal(matches.length, 1, "Physical office boot lacks one exact paid epoch");
		return { ...boot, permitId: matches[0].permitId, epoch: matches[0].epoch };
	});
	return { schema: "qorpera.office-lifecycle-epochs/v1", epochs: mapped,
		serviceRestart: { ...restart, permitId: mapped[2].permitId, epoch: mapped[2].epoch }, passed: true };
}

/** Inputs are read through production journal parsers/client APIs, never
 * repaired by the oracle. Closed SQL receipts and immutable SQL cursor tips
 * must agree with the durable archive and its fully acknowledged terminal
 * producer prefix before this disposable fixture can release custody. */
export function verifyOfficeGuardArchives(expected, retained) {
	assert(Array.isArray(expected) && expected.length === 4, "Four office archive expectations required");
	assert.equal(new Set(expected.map(entry => entry.permit.permitId)).size, 4, "Duplicate archive expectation");
	for (const key of ["activeGuards", "activePrestarts", "journalGuards"])
		assert.deepEqual(retained[key], [], "Unarchived office custody remains");
	const { anchor, archives, usage } = retained;
	assert(anchor?.schema === "qorpera.computer-prestart-journal/v2" && uuid.test(anchor.guardIncarnationId), "Office archive anchor missing");
	assert.deepEqual(anchor.records, [], "Durable office prestarts remain");
	assert.equal(anchor.archiveCount, expected.length, "Office archive anchor count differs");
	assert.equal(archives.length, expected.length, "Missing or extra office archive");
	assert.equal(usage.length, expected.length, "Missing or extra office usage prefix");
	const seen = new Set(), summaries = [];
	let previousSha256 = null;
	for (const [index, archived] of archives.entries()) {
		const { value, sha256: digest } = archived;
		assert(sha256.test(digest), "Office archive digest invalid");
		assert.equal(value.schema, "qorpera.computer-guard-archive/v1");
		assert.equal(value.sequence, index + 1, "Office archive sequence differs");
		assert.equal(value.previousSha256, previousSha256, "Office archive chain differs");
		previousSha256 = digest;
		const permitId = value.prestart.intent.permitId;
		assert(!seen.has(permitId), "Duplicate office archive closure"); seen.add(permitId);
		const row = expected.find(entry => entry.permit.permitId === permitId);
		assert(row && row.permit.schema === "qorpera.computer-usage-permit/v2" && row.permit.state === "closed", "Archive lacks a closed SQL permit");
		assert.deepEqual(value.closure, row.permit, "Immutable archive closure differs from SQL");
		assert.equal(value.prestart.guardIncarnationId, anchor.guardIncarnationId, "Office archive incarnation differs");
		assert.equal(value.prestart.guardIncarnationId, row.permit.prestart.guardIncarnationId, "SQL prestart incarnation differs");
		assert.equal(value.prestart.intent.prepareSha256, row.permit.prestart.prepareSha256, "SQL prestart request differs");
		const guard = value.guard;
		assert(guard?.phase === "stopped" && guard.startDispatched && guard.startSettled && guard.startSucceeded === true
			&& guard.usageRequired === true && guard.stopReceipt, "Office archive lacks settled physical stop");
		assert.equal(guard.permit.permitId, permitId);
		assert.equal(guard.machine.physicalInstanceId, row.permit.physicalId);
		const matches = usage.filter(entry => entry.permitId === permitId);
		assert.equal(matches.length, 1, "Office archive lacks exact usage prefix");
		const { page, status } = matches[0];
		assert.deepEqual(status, guard, "Live archive read differs from durable guard");
		assert.equal(page.permitId, permitId); assert.equal(page.epoch, row.permit.epoch);
		assert.equal(page.state, "sealed", "Office usage prefix is not sealed");
		assert.equal(page.finalSequence, page.head.sequence, "Office usage final sequence differs");
		assert.deepEqual(page.entries, [], "Office usage prefix is not drained");
		assert.deepEqual(page.acknowledgedThrough, page.head, "Office usage acknowledgement trails head");
		assert(row.cursor?.sealed === true && Number.isSafeInteger(row.cursor.sequence) && row.cursor.sequence > 0
			&& sha256.test(row.cursor.sha256) && uuid.test(row.cursor.observationId), "SQL guard cursor is not sealed");
		assert.deepEqual(page.head, { sequence: row.cursor.sequence, sha256: row.cursor.sha256, observationId: row.cursor.observationId },
			"Office producer head differs from immutable SQL cursor");
		assert.equal(row.sampleCount, row.cursor.sequence, "SQL sample count differs from terminal cursor");
		const sample = row.terminalSample, stop = guard.stopReceipt;
		assert(sample && ["stopped", "absent"].includes(sample.state), "SQL terminal physical observation missing");
		assert.equal(sample.observationId, row.cursor.observationId);
		assert.equal(sample.physicalId, row.permit.physicalId);
		assert.equal(sample.hostBootId, row.permit.hostBootId);
		assert.equal(sample.guestUptimeMs, null);
		assert.equal(stop.permitId, permitId); assert.equal(stop.allocationId, row.permit.allocationId);
		assert.equal(stop.physicalInstanceId, sample.physicalId); assert.equal(stop.hostBootId, row.permit.hostBootId);
		assert.equal(stop.closedHostBootId, sample.hostBootId); assert.equal(stop.closedAtUptimeMs, sample.hostUptimeMs);
		assert.equal(stop.state, sample.state);
		summaries.push({ permitId, epoch: row.permit.epoch, physicalId: row.permit.physicalId, hostBootId: row.permit.hostBootId,
			guestBootId: row.permit.guestBootId, archiveSequence: value.sequence, archiveSha256: digest, cursor: page.head });
	}
	assert.equal(anchor.archiveHeadSha256, previousSha256, "Office archive anchor head differs");
	return { schema: "qorpera.office-guard-archive-proof/v1", archiveCount: summaries.length,
		archiveHeadSha256: previousSha256, permits: summaries, passed: true };
}

export async function assertOfficePathAbsent(path) {
	try { await lstat(path); }
	catch (error) { if (error.code === "ENOENT") return; throw error; }
	assert.fail("Owned office fixture path remains present");
}

/** Capture immediately after exclusive fixture creation; compare again only
 * after producers/guard stop and physical/financial closure succeeds. */
export async function officeOwnedDirectoryIdentity(path, uid, mode) {
	const value = await lstat(path);
	assert(value.isDirectory() && !value.isSymbolicLink() && value.uid === uid && (value.mode & 0o7777) === mode
		&& await realpath(path) === path, "Owned office directory identity invalid");
	return { path, dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode };
}

export async function removeOfficeOwnedDirectory(identity) {
	assert(identity, "Owned office directory identity missing");
	assert.deepEqual(await officeOwnedDirectoryIdentity(identity.path, identity.uid, identity.mode), identity,
		"Owned office directory identity changed");
	await rm(identity.path, { recursive: true });
	await assertOfficePathAbsent(identity.path);
}
