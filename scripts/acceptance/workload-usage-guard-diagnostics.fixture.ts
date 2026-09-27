import assert from "node:assert/strict";
import test from "node:test";
import type { PaidComputerGuardPhysical, PaidComputerHostClock, PaidComputerMachine } from "../../packages/runner-orchestrator/src/computer-paid-guard.ts";
import { LxdPaidComputerUsageCapture } from "./workload-usage-guard-diagnostics.ts";

const boot = "00000000-0000-4000-8000-000000000001", allocation = "00000000-0000-4000-8000-000000000002";
const machine = { kind: "runtime", allocationId: allocation, physicalInstanceId: "00000000-0000-4000-8000-000000000003",
	hostMachineIdSha256: "a".repeat(64), hostBootId: boot, physicalTarget: { project: "default", instanceName: "owned-vm" } } as unknown as PaidComputerMachine;

function fixture(options: { bracket?: number; hostChanged?: number; stopped?: boolean; failure?: Error; brokenReporter?: boolean } = {}) {
	let ticks = 0, reads = 0;
	const records: unknown[] = [], signals: AbortSignal[] = [], receivedMachines: PaidComputerMachine[] = [];
	const clock = async (): Promise<PaidComputerHostClock> => ({ hostMachineIdSha256: "a".repeat(64),
		hostBootId: reads === options.hostChanged ? "00000000-0000-4000-8000-000000000099" : boot,
		uptimeMs: reads++ === 0 ? 1000 : 1000 + (options.bracket ?? 150) });
	const physical: PaidComputerGuardPhysical = {
		async inspect(value, signal) { receivedMachines.push(value); signals.push(signal); return options.stopped ? "stopped" : "running"; },
		async start() { throw new Error("Never called"); }, async startSettled() { throw new Error("Never called"); }, async stop() { throw new Error("Never called"); },
	};
	const guest = { bootId: boot, uptimeMs: 100, secret: "NEVER_DIAGNOSE" };
	const client = { async readInstanceClock(project: string, name: string, signal?: AbortSignal) {
		assert.equal(project, "default"); assert.equal(name, "owned-vm"); assert(signal); signals.push(signal);
		if (options.failure) throw options.failure;
		return guest;
	} };
	const capture = new LxdPaidComputerUsageCapture(client, physical, clock, { now: () => ticks++, report: (record) => {
		records.push(record); if (options.brokenReporter) throw new Error("PRIVATE_REPORT_ERROR");
	} });
	return { capture, records, signals, receivedMachines };
}

test("original capture succeeds with exact ports, signals and safe paired phase diagnostics", async () => {
	const fixtureState = fixture(), signal = new AbortController().signal;
	const result = await fixtureState.capture.capture(machine, signal);
	assert.equal(result.host.uptimeMs, 1150); assert.equal(result.guestBootId, boot); assert.equal(result.guestUptimeMs, 100);
	assert.match(result.evidenceSha256, /^[0-9a-f]{64}$/); assert.match(result.observedAt, /^\d{4}-/);
	assert(fixtureState.signals.every(value => value === signal)); assert(fixtureState.receivedMachines.every(value => value === machine));
	assert.equal(fixtureState.records.length, 1);
	assert.match(JSON.stringify(fixtureState.records), /"code":"CONFIRMED"/);
	assert.doesNotMatch(JSON.stringify(fixtureState.records), /NEVER_DIAGNOSE|PRIVATE/);
	assert.deepEqual((fixtureState.records[0] as { steps: { phase: string }[] }).steps.map(step => step.phase),
		["host-before", "physical-before", "guest-clock", "physical-after", "host-after"]);
});

test("original guest transport rejection remains the identical error and emits no raw error text", async () => {
	const failure = new Error("secret credential detail"), state = fixture({ failure });
	await assert.rejects(state.capture.capture(machine, new AbortController().signal), error => error === failure);
	assert.match(JSON.stringify(state.records), /GUEST_CLOCK_FAILED/); assert.doesNotMatch(JSON.stringify(state.records), /secret|credential/);
});

for (const [name, options, code] of [
	["over-one-second bracket", { bracket: 1001 }, "HOST_BRACKET_EXCEEDED"],
	["backward host time", { bracket: -1 }, "HOST_CLOCK_BACKWARD"],
	["initial host identity mismatch", { hostChanged: 0 }, "HOST_IDENTITY_DIFFERS"],
	["final host identity mismatch", { hostChanged: 1 }, "HOST_IDENTITY_DIFFERS"],
	["physical state mismatch", { stopped: true }, "PHYSICAL_NOT_RUNNING"],
] as const) test(`${name} remains refused by the real capture`, async () => {
	const state = fixture(options);
	await assert.rejects(state.capture.capture(machine, new AbortController().signal), /PAID_USAGE_CLOCK_UNCONFIRMED/);
	assert.equal((state.records[0] as { code: string }).code, code);
});

test("aborted capture never reaches the ports and preserves the original abort reason", async () => {
	const state = fixture(), signal = AbortSignal.abort(new Error("private abort"));
	await assert.rejects(state.capture.capture(machine, signal), error => error === signal.reason);
	assert.equal(state.signals.length, 0); assert.match(JSON.stringify(state.records), /ABORTED/);
	assert.doesNotMatch(JSON.stringify(state.records), /private abort/);
});

test("broken diagnostic reporting changes neither success nor original failure", async () => {
	assert.equal((await fixture({ brokenReporter: true }).capture.capture(machine, new AbortController().signal)).guestUptimeMs, 100);
	const failure = new Error("private failure"), state = fixture({ brokenReporter: true, failure });
	await assert.rejects(state.capture.capture(machine, new AbortController().signal), error => error === failure);
});

test("concurrent captures retain separate identity and phase sequences", async () => {
	let reads = 0;
	const records: { allocationId: string | null; steps: { phase: string }[] }[] = [];
	const physical: PaidComputerGuardPhysical = { async inspect() { return "running"; },
		async start() { throw new Error("Never called"); }, async startSettled() { throw new Error("Never called"); }, async stop() { throw new Error("Never called"); } };
	const capture = new LxdPaidComputerUsageCapture({ async readInstanceClock() { return { bootId: boot, uptimeMs: 100 }; } }, physical,
		async () => ({ hostMachineIdSha256: "a".repeat(64), hostBootId: boot, uptimeMs: reads++ < 2 ? 1000 : 1100 }),
		{ report: record => records.push(record) });
	const other = { ...machine, allocationId: "00000000-0000-4000-8000-000000000004" };
	await Promise.all([capture.capture(machine, new AbortController().signal), capture.capture(other, new AbortController().signal)]);
	assert.equal(new Set(records.map(record => record.allocationId)).size, 2);
	for (const record of records) assert.deepEqual(record.steps.map(step => step.phase),
		["host-before", "physical-before", "guest-clock", "physical-after", "host-after"]);
});
