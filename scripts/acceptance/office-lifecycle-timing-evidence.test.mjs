import assert from "node:assert/strict";
import test from "node:test";
import { OFFICE_RESET_TIMING_SCHEMA, officeResetTimingHistory, projectOfficeResetTiming } from "./office-lifecycle-timing-evidence.mjs";

function fixture(attempt = 1) {
	return { schema: OFFICE_RESET_TIMING_SCHEMA, attempt, elapsedMs: 5100, outcome: "rejected", parentAborted: false,
		total: 1, omitted: 0, pendingAtSettlement: 0, records: [{ stage: "package_measurement", atMs: 100,
			elapsedMs: 5000, outcome: "rejected", parentAborted: false, operationAborted: true,
			physicalAborted: true, physicalLease: 3, physicalRemainingMs: 0 }] };
}

test("process-transport projection retains observed timing and signal states without private payloads", () => {
	const expected = fixture(), value = structuredClone(expected);
	value.request = { token: "private-token" };
	value.error = "private-token";
	value.records[0].path = "/private-token";
	value.records[0].value = { credential: "private-token" };
	value.records[0].abort = "private-token";
	assert.deepEqual(projectOfficeResetTiming(JSON.parse(JSON.stringify(value))), expected);
	assert(!JSON.stringify(projectOfficeResetTiming(value)).includes("private-token"));
	// Unknown signal state and unfinished work stay explicit, not a success claim.
	const incomplete = fixture();
	incomplete.pendingAtSettlement = 2;
	incomplete.records[0].operationAborted = null;
	incomplete.records[0].physicalAborted = null;
	incomplete.records[0].physicalLease = null;
	incomplete.records[0].physicalRemainingMs = null;
	assert.deepEqual(projectOfficeResetTiming(incomplete), incomplete);
});

test("invalid timing envelopes are rejected instead of inventing complete evidence", () => {
	for (const patch of [
		{ schema: "qorpera.office-acceptance-reset-timing/v2" }, { attempt: 0 }, { attempt: -1 },
		{ attempt: 1.5 }, { elapsedMs: Infinity }, { elapsedMs: 600001 }, { total: 2 }, { omitted: -1 },
		{ pendingAtSettlement: -1 }, { pendingAtSettlement: "private-token" },
		{ outcome: "private-token" }, { parentAborted: "private-token" }, { records: {} },
	]) assert.equal(projectOfficeResetTiming({ ...fixture(), ...patch }), null);
	for (const value of [null, [], "private-token", {}]) assert.equal(projectOfficeResetTiming(value), null);
});

test("malformed or unrecognized stage rows reject the complete transported attempt", () => {
	for (const patch of [
		{ stage: "private-token" }, { atMs: -1 }, { atMs: 600001 }, { elapsedMs: NaN }, { elapsedMs: 0.5 },
		{ outcome: "private-token" }, { parentAborted: null }, { operationAborted: "private-token" },
		{ physicalAborted: "private-token" }, { physicalLease: 0 }, { physicalLease: 600001 },
		{ physicalRemainingMs: -1 }, { physicalRemainingMs: 5001 },
	]) {
		const value = fixture();
		Object.assign(value.records[0], patch);
		assert.equal(projectOfficeResetTiming(value), null);
	}
});

test("stage export stays bounded and preserves omitted-record accounting", () => {
	const value = fixture();
	value.records = Array.from({ length: 96 }, () => structuredClone(value.records[0]));
	value.total = 120;
	value.omitted = 24;
	assert.deepEqual(projectOfficeResetTiming(value), value);
	value.records.push(structuredClone(value.records[0]));
	value.total++;
	assert.equal(projectOfficeResetTiming(value), null);
});

test("long retry history and unrelated lifecycle chatter preserve first and recent reset evidence", () => {
	const history = officeResetTimingHistory();
	for (let attempt = 1; attempt <= 20; attempt++) {
		for (let i = 0; i < 50; i++) assert.equal(history.accept({ schema: "qorpera.office-lifecycle/v1", state: "private-token" }), false);
		assert.equal(history.accept(fixture(attempt)), true);
	}
	assert.equal(history.accept({ ...fixture(), records: [{ stage: "private-token" }] }), true);
	assert.equal(history.accept({ ...fixture(), total: 9 }), true);
	const snapshot = history.snapshot();
	assert.equal(snapshot.total, 20);
	assert.equal(snapshot.rejected, 2);
	assert.equal(snapshot.omitted, 6);
	assert.deepEqual(snapshot.first.map(value => value.attempt), [1, 2]);
	assert.deepEqual(snapshot.recent.map(value => value.attempt), Array.from({ length: 12 }, (_, index) => index + 9));
	assert(!JSON.stringify(snapshot).includes("private-token"));
});

test("caller mutation cannot rewrite retained diagnostic history", () => {
	const history = officeResetTimingHistory(), input = fixture();
	history.accept(input);
	input.records[0].stage = "private-token";
	const snapshot = history.snapshot();
	snapshot.first[0].records[0].stage = "private-token";
	snapshot.first.length = 0;
	assert.deepEqual(history.snapshot().first, [fixture()]);
});
