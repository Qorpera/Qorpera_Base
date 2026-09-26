import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizedUsageUs, readWorkloadUsage, verifyWorkloadUsage, verifyWorkloadActivity } from "./workload-usage-evidence.mjs";

const tariff = { reference_cpu_millis: 4000, reference_memory_bytes: 8589934592 };
function fixture() {
	// Unit-only clock data validates the acceptance oracle's negative cases.
	// It must never be emitted as real-LXD acceptance evidence.
	const shape = { cpuMillis: 2000, memoryBytes: 1073741824 };
	const shapeProvenance = { nodeId: "00000000-0000-4000-8000-000000000001", providerKind: "coding", policySha256: "f".repeat(64) };
	const samples = [0, 1000, 2000, 3000, 4000, 5000].map((time, index) => ({
		observationId: `sample-${index}`, previousObservationId: index ? `sample-${index - 1}` : null,
		hostBootId: "host", hostUptimeMs: time + 100000, physicalId: "physical", guestBootId: "guest",
		guestUptimeMs: index === 2 || index === 5 ? null : time + 10000,
		observedAt: new Date(1800000000000 + time).toISOString(),
		state: index === 2 ? "gap" : index === 5 ? "stopped" : "running", evidenceSha256: "a".repeat(64),
	}));
	const evidence = {
		permit: { id: "permit", allocation_id: "allocation", node_id: shapeProvenance.nodeId, host_boot_id: "host", physical_id: "physical", guest_boot_id: "guest", state: "closed" },
		stream: { resource_kind: "coding_machine", resource_shape: { ...shape, source: "admitted_node_demand", ...shapeProvenance }, active_ms: "2000", elapsed_ms: "5000", closed: true }, tariff,
		samples: samples.map((sample, index) => ({ sequence: index + 1, sample, coverage: ["initial", "continuous", "gap", "gap", "continuous", "terminal"][index] })),
		checkpoints: [0, 0, 1000, 1000, 1000, 2000, 2000].map((active, sequence) => ({ sequence, active_ms: String(active), elapsed_ms: String(Math.max(0, sequence - 1) * 1000), evidence_sha256: "a".repeat(64) })),
		reservations: [{ id: "reservation", from_standard_us: "0", reserved_us: "2000000" }],
		holds: [{ reservation_id: "reservation", bucket_id: "one", user_id: "responsible", draw_order: 1, amount_us: "750000" }, { reservation_id: "reservation", bucket_id: "two", user_id: "fallback", draw_order: 2, amount_us: "1250000" }],
		settlements: [{ reservation_id: "reservation", through_sequence: 5, total_standard_us: "1000000", debited_us: "1000000", released_us: "1000000" }],
		debits: [{ reservation_id: "reservation", bucket_id: "one", debited_us: "750000", released_us: "0" }, { reservation_id: "reservation", bucket_id: "two", debited_us: "250000", released_us: "1000000" }],
	};
	return { evidence, expected: { kind: "coding_machine", shape, shapeProvenance, physicalId: "physical", hostBootId: "host", guestBootId: "guest", physicalSamples: samples, firstPayerByReservation: { reservation: "responsible" } } };
}

test("normalization covers fractional CPU, memory-dominant, dedicated and excluded login helpers", () => {
	assert.equal(normalizedUsageUs(1001, { cpuMillis: 2000, memoryBytes: 1073741824 }, tariff, "coding_machine"), 500500n);
	assert.equal(normalizedUsageUs(1001, { cpuMillis: 2000, memoryBytes: 17179869184 }, tariff, "company_computer"), 2002000n);
	assert.equal(normalizedUsageUs(1, { cpuMillis: 1, memoryBytes: 1 }, tariff, "agent_sandbox"), 1n);
	assert.equal(normalizedUsageUs(999999, null, tariff, "login_helper"), 0n);
	assert.throws(() => normalizedUsageUs(1, null, tariff, "company_computer"), /Unknown shape/);
});

test("reconciles exact physical awake time and responsible-member-first fallback", () => {
	const { evidence, expected } = fixture();
	const result = verifyWorkloadUsage(evidence, expected);
	assert.equal(result.debitedUs, "1000000");
	assert.deepEqual(result.observationMargins, { firstObservedGuestBootAgeMs: 10000,
		pairedClockUncertaintyMsPerContinuousSegment: 1000, unobservedSubsecondSuspension: "not resolved by sampled clocks",
		beforeFirstPairedObservation: "unmeasured; excluded from billing", lastRunningToTerminalHostMs: 1000,
		observedUnchargedElapsedMs: "3000" });
	// Exact replay contributes one SQL observation, not another machine interval.
	expected.physicalSamples.push(structuredClone(expected.physicalSamples[1]));
	assert.equal(verifyWorkloadUsage(evidence, expected).samples, 6);
});

test("outage proof requires actual continuous SQL intervals and includes their allocated debit", () => {
	const { evidence, expected } = fixture();
	const times = [0, 5000, 10000, 15000, 20000, 21000];
	for (const [index, record] of evidence.samples.entries()) {
		Object.assign(record.sample, { hostUptimeMs: 100000 + times[index],
			guestUptimeMs: index === 5 ? null : 10000 + times[index],
			observedAt: new Date(1800000000000 + times[index]).toISOString(),
			state: index === 5 ? "stopped" : "running" });
		record.coverage = index === 0 ? "initial" : index === 5 ? "terminal" : "continuous";
	}
	evidence.checkpoints = [0, 0, 5000, 10000, 15000, 20000, 20000].map((active, sequence) => ({
		sequence, active_ms: String(active), elapsed_ms: String(sequence ? times[sequence - 1] : 0), evidence_sha256: "a".repeat(64) }));
	Object.assign(evidence.stream, { active_ms: "20000", elapsed_ms: "21000" });
	evidence.reservations[0].reserved_us = "20000000";
	evidence.holds[1].amount_us = "19250000";
	Object.assign(evidence.settlements[0], { total_standard_us: "10000000", debited_us: "10000000", released_us: "10000000" });
	Object.assign(evidence.debits[1], { debited_us: "9250000", released_us: "10000000" });
	expected.controllerOutage = { observationIds: ["sample-2", "sample-3", "sample-4"] };
	assert.deepEqual(verifyWorkloadUsage(evidence, expected).controllerOutage,
		{ activeMs: "15000", allocatedStandardUs: "7500000", observations: 3 });
	expected.controllerOutage.observationIds[0] = "missing";
	assert.throws(() => verifyWorkloadUsage(evidence, expected), /missing from SQL/);
});

test("rejects charging a stopped or observation-gap interval", () => {
	const { evidence, expected } = fixture();
	evidence.checkpoints[3].active_ms = "2000";
	assert.throws(() => verifyWorkloadUsage(evidence, expected), /over\/under-counted/);
});

function clockFixture(host, guest, cumulativeActive, coverage) {
	const result = fixture(), { evidence } = result;
	for (const [index, row] of evidence.samples.entries()) {
		Object.assign(row.sample, { hostUptimeMs: 100000 + host[index], guestUptimeMs: guest[index] === null ? null : 10000 + guest[index],
			observedAt: new Date(1800000000000 + host[index]).toISOString(), state: index === 5 ? "stopped" : "running" });
		row.coverage = coverage[index];
	}
	evidence.checkpoints = [0, ...cumulativeActive].map((active, sequence) => ({ sequence, active_ms: String(active),
		elapsed_ms: String(sequence ? host[sequence - 1] : 0), evidence_sha256: "a".repeat(64) }));
	Object.assign(evidence.stream, { active_ms: String(cumulativeActive.at(-1)), elapsed_ms: String(host.at(-1)) });
	const cost = cumulativeActive.at(-1) * 500;
	evidence.reservations[0].reserved_us = "20000000";
	evidence.holds[1].amount_us = "19250000";
	Object.assign(evidence.settlements[0], { total_standard_us: String(cost), debited_us: String(cost), released_us: String(20000000 - cost) });
	Object.assign(evidence.debits[1], { debited_us: String(cost - 750000), released_us: String(20000000 - cost) });
	return result;
}

test("alternating capture latency has one segment bound, not a smaller-clock tax each interval", () => {
	for (const guest of [[0, 4000, 10000, 14000, 20000, null], [0, 6000, 10000, 16000, 20000, null]]) {
		const { evidence, expected } = clockFixture([0, 5000, 10000, 15000, 20000, 21000], guest,
			[0, 5000, 10000, 15000, 20000, 20000], ["initial", "continuous", "continuous", "continuous", "continuous", "terminal"]);
		assert.equal(verifyWorkloadUsage(evidence, expected).activeMs, "20000");
		evidence.checkpoints[2].active_ms = "4000";
		assert.throws(() => verifyWorkloadUsage(evidence, expected), /over\/under-counted/);
	}
});

test("repeated small clock drift breaks continuity at the cumulative uncertainty limit", () => {
	const { evidence, expected } = clockFixture([0, 5000, 10000, 15000, 20000, 21000], [0, 4500, 9000, 13500, 18500, null],
		[0, 5000, 10000, 10000, 15000, 15000], ["initial", "continuous", "continuous", "gap", "continuous", "terminal"]);
	assert.equal(verifyWorkloadUsage(evidence, expected).activeMs, "15000");
	evidence.samples[3].coverage = "continuous";
	assert.throws(() => verifyWorkloadUsage(evidence, expected), /coverage differs/);
});

test("frozen guest clock cannot pass a short host interval merely within the one-second tolerance", () => {
	const { evidence, expected } = clockFixture([0, 500, 1000, 1500, 2000, 2500], [0, 0, 500, 1000, 1500, null],
		[0, 0, 500, 1000, 1500, 1500], ["initial", "gap", "continuous", "continuous", "continuous", "terminal"]);
	assert.equal(verifyWorkloadUsage(evidence, expected).activeMs, "1500");
});

test("renewal differences cumulative usage and exhausts responsible allowance before the next window", () => {
	const { evidence, expected } = fixture();
	evidence.reservations = [
		{ id: "first", from_standard_us: "0", reserved_us: "1000000" },
		{ id: "second", from_standard_us: "500000", reserved_us: "1000000" },
	];
	evidence.holds = [
		{ reservation_id: "first", bucket_id: "one", user_id: "responsible", draw_order: 1, amount_us: "250000" },
		{ reservation_id: "first", bucket_id: "two", user_id: "fallback", draw_order: 2, amount_us: "750000" },
		{ reservation_id: "second", bucket_id: "two", user_id: "fallback", draw_order: 1, amount_us: "1000000" },
	];
	evidence.settlements = [
		{ reservation_id: "first", through_sequence: 2, total_standard_us: "500000", debited_us: "500000", released_us: "500000" },
		{ reservation_id: "second", through_sequence: 5, total_standard_us: "1000000", debited_us: "500000", released_us: "500000" },
	];
	evidence.debits = [
		{ reservation_id: "first", bucket_id: "one", debited_us: "250000", released_us: "0" },
		{ reservation_id: "first", bucket_id: "two", debited_us: "250000", released_us: "500000" },
		{ reservation_id: "second", bucket_id: "two", debited_us: "500000", released_us: "500000" },
	];
	expected.firstPayerByReservation = { first: "responsible", second: "fallback" };
	assert.equal(verifyWorkloadUsage(evidence, expected).debitedUs, "1000000");
	evidence.settlements[1].debited_us = "1000000";
	assert.throws(() => verifyWorkloadUsage(evidence, expected), /Settlement debit differs/);
});

test("rejects extra per-session checkpoints and fabricated physical identity", () => {
	const first = fixture(); first.evidence.checkpoints.push(structuredClone(first.evidence.checkpoints.at(-1)));
	assert.throws(() => verifyWorkloadUsage(first.evidence, first.expected), /Extra\/missing/);
	const second = fixture(); second.expected.physicalId = "other-vm";
	assert.throws(() => verifyWorkloadUsage(second.evidence, second.expected), /Physical VM/);
});

test("strict dimensions and independently enrolled shape provenance are both required", () => {
	for (const [field, value] of [["cpuMillis", 4000], ["memoryBytes", 2147483648], ["nodeId", "00000000-0000-4000-8000-000000000002"], ["providerKind", "office"], ["policySha256", "e".repeat(64)], ["source", "caller"]]) {
		const { evidence, expected } = fixture();
		evidence.stream.resource_shape[field] = value;
		assert.throws(() => verifyWorkloadUsage(evidence, expected), /shape differs|provenance differs/);
	}
	const { evidence, expected } = fixture();
	delete expected.shapeProvenance;
	assert.throws(() => verifyWorkloadUsage(evidence, expected), /provenance required/);
});

test("rejects wrong payer, duplicate debit and failure to release an unused hold", () => {
	const first = fixture(); first.expected.firstPayerByReservation.reservation = "fallback";
	assert.throws(() => verifyWorkloadUsage(first.evidence, first.expected), /Responsible member/);
	const second = fixture(); second.evidence.debits.push(structuredClone(second.evidence.debits[0]));
	assert.throws(() => verifyWorkloadUsage(second.evidence, second.expected), /Missing\/duplicate source/);
	const third = fixture(); third.evidence.debits[1].released_us = "999999";
	assert.throws(() => verifyWorkloadUsage(third.evidence, third.expected), /remainder refunded/);
});

test("read-only evidence query refuses SQL interpolation and does not select host secrets", async () => {
	await assert.rejects(readWorkloadUsage(() => assert.fail("must not execute"), "' ; select"), /UUID/);
	await readWorkloadUsage(async (sql) => {
		assert(!sql.includes("executor_secret") && !sql.includes("key_sha256") && !sql.includes("prepare_request"));
		assert(sql.startsWith("with p as")); return "{}";
	}, "00000000-0000-4000-8000-000000000001");
});

test("idle and completed busy guest intervals allocate the same pinned shape tariff", () => {
	const evidence = { tariff, stream: { resource_kind: "agent_sandbox", resource_shape: { cpuMillis: 2000, memoryBytes: 1073741824 }, tariff_version: 1 },
		samples: Array.from({ length: 12 }, (_, index) => ({ sequence: index + 1, coverage: index ? "continuous" : "initial",
			sample: { observationId: `phase-${index}`, state: "running", guestUptimeMs: index * 1000 } })),
		checkpoints: Array.from({ length: 13 }, (_, sequence) => ({ sequence, active_ms: String(Math.max(sequence - 1, 0) * 1000) })) };
	const activity = { idleObservationIds: ["phase-1", "phase-2"], completion: { startedGuestUptimeMs: 2500, finishedGuestUptimeMs: 10500 } };
	const result = verifyWorkloadActivity(evidence, activity);
	assert.equal(result.phases.idle.activeMs, "2000"); assert.equal(result.phases.idle.allocatedStandardUs, "1000000");
	assert.equal(result.phases.busy.activeMs, "7000"); assert.equal(result.phases.busy.allocatedStandardUs, "3500000");
	const bad = structuredClone(activity); bad.completion.finishedGuestUptimeMs = 4500;
	assert.throws(() => verifyWorkloadActivity(evidence, bad), /Insufficient/);
	evidence.samples[6].coverage = "gap";
	assert.throws(() => verifyWorkloadActivity(evidence, activity), /continuous physical coverage/);
});
