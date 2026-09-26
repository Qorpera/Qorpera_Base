import { expect } from "vitest";
import type { PaidComputerGuard, PaidComputerPermit } from "../../src/computer-paid-guard.ts";
import {
	paidComputerUsageCursor,
	parsePaidComputerUsageEntry,
	parsePaidComputerUsageFrame,
} from "../../src/computer-paid-usage.ts";

/** Drive one independent guard sampler turn deterministically in office tests. */
export async function sampleOfficeGuardUsage(guard: PaidComputerGuard): Promise<void> {
	guard.tickUsage();
	for (const record of await guard.list()) await guard.settleUsage(record.permit.permitId);
}

/** The SQL transport is fake; frames and predecessor checks come from the real
 * durable producer. Never synthesize successful samples from controller reads. */
export function acceptOfficeGuardUsage(
	request: Record<string, unknown>,
	permit: PaidComputerPermit,
	lastSample: Record<string, unknown> | null,
) {
	expect(request.permitId).toBe(permit.permitId);
	if (!Array.isArray(request.entries) || request.entries.length === 0) throw new Error("usage frames required");
	const frames = request.entries.map(parsePaidComputerUsageFrame);
	for (const frame of frames) {
		const entry = parsePaidComputerUsageEntry(JSON.parse(frame.entryText));
		expect(entry.permit.permitId).toBe(permit.permitId);
		expect(entry.permit.epoch).toBe(permit.epoch);
		const sample = entry.sample;
		if (sample.observationId === lastSample?.observationId) continue;
		expect(sample.previousObservationId).toBe(lastSample?.observationId ?? null);
		lastSample = { ...sample };
		if (sample.state === "running")
			permit = { ...permit, state: "bound", physicalId: sample.physicalId, guestBootId: sample.guestBootId };
	}
	return {
		schema: "qorpera.computer-guard-usage-receipt/v1",
		permit,
		lastSample,
		cursor: paidComputerUsageCursor(frames.at(-1)!),
		sealed: lastSample?.state === "stopped" || lastSample?.state === "absent",
	};
}
