import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { drainComputerGuardUsage } from "../src/computer-guard-usage-uploader.ts";
import type { PaidComputerPermit } from "../src/computer-paid-guard.ts";
import {
	PAID_COMPUTER_USAGE_ZERO,
	type PaidComputerUsageCursor,
	type PaidComputerUsageEntry,
	type PaidComputerUsageFrame,
	type PaidComputerUsagePage,
	paidComputerUsageCursor,
	paidComputerUsageFrame,
} from "../src/computer-paid-usage.ts";

function fixture(count = 3, terminal = false) {
	const permit: PaidComputerPermit = {
		schema: "qorpera.computer-usage-permit/v2",
		mode: "paid",
		permitId: randomUUID(),
		allocationId: randomUUID(),
		instanceSha256: "a".repeat(64),
		nodeId: randomUUID(),
		epoch: randomUUID(),
		generation: 1,
		reservationId: randomUUID(),
		hostBootId: randomUUID(),
		guestBootId: null,
		physicalId: null,
		issuedAt: "2026-09-26T00:00:00.000Z",
		deadline: "2026-09-26T00:05:30.000Z",
		validForMs: 330000,
		windowMs: 300000,
		stopReserveMs: 30000,
		tariffVersion: 1,
		cpuMillis: 4000,
		memoryBytes: 8 * 1024 ** 3,
		state: "prepared",
		prestart: { guardIncarnationId: randomUUID(), prepareSha256: "b".repeat(64) },
	};
	const physicalInstanceId = randomUUID(),
		guestBootId = randomUUID(),
		frames: PaidComputerUsageFrame[] = [];
	const append = (stopped = false) => {
		const previous = frames.at(-1),
			cursor = previous ? paidComputerUsageCursor(previous) : PAID_COMPUTER_USAGE_ZERO;
		const sequence = frames.length + 1,
			uptime = sequence * 5000;
		const entry: PaidComputerUsageEntry = {
			schema: "qorpera.computer-guard-usage-entry/v1",
			sequence,
			previousSha256: cursor.sha256,
			permit,
			hostMachineIdSha256: "c".repeat(64),
			physicalInstanceId,
			deadlineUptimeMs: 330000,
			stopAtUptimeMs: 300000,
			sample: {
				observationId: randomUUID(),
				previousObservationId: cursor.observationId,
				hostBootId: permit.hostBootId,
				hostUptimeMs: uptime,
				physicalId: physicalInstanceId,
				guestBootId,
				guestUptimeMs: stopped ? null : uptime,
				observedAt: new Date(Date.parse(permit.issuedAt) + uptime).toISOString(),
				state: stopped ? "stopped" : "running",
				evidenceSha256: "d".repeat(64),
			},
			stopReceipt: stopped
				? {
						permitId: permit.permitId,
						generation: 1,
						allocationId: permit.allocationId,
						instanceSha256: permit.instanceSha256,
						physicalInstanceId,
						hostBootId: permit.hostBootId,
						observedUptimeMs: uptime,
						closedAtUptimeMs: uptime,
						closedHostBootId: permit.hostBootId,
						state: "stopped",
						operationId: randomUUID(),
					}
				: null,
		};
		frames.push(paidComputerUsageFrame(entry));
	};
	for (let i = 0; i < count; i++) append(terminal && i === count - 1);
	let acknowledged: PaidComputerUsageCursor = { ...PAID_COMPUTER_USAGE_ZERO },
		accepted = 0;
	const calls: string[] = [];
	let canonical: { permit: unknown; lastSample: unknown } | null = null;
	const guard = {
		readUsage: vi.fn(
			async (): Promise<PaidComputerUsagePage> => ({
				schema: "qorpera.computer-guard-usage-page/v1",
				permitId: permit.permitId,
				epoch: permit.epoch,
				acknowledgedThrough: acknowledged,
				head: frames.length ? paidComputerUsageCursor(frames.at(-1)!) : { ...PAID_COMPUTER_USAGE_ZERO },
				entries: frames.filter((frame) => frame.sequence > acknowledged.sequence).slice(0, 2),
				state: terminal ? "sealed" : "open",
				finalSequence: terminal ? frames.length : null,
			}),
		),
		ackUsage: vi.fn(async (_id: string, cursor: PaidComputerUsageCursor) => {
			expect(cursor).toEqual(paidComputerUsageCursor(frames[cursor.sequence - 1]!));
			expect(cursor.sequence).toBeLessThanOrEqual(accepted);
			calls.push(`ack:${cursor.sequence}`);
			acknowledged = cursor;
			return cursor;
		}),
	};
	const call = vi.fn(async (request: Record<string, unknown>): Promise<unknown> => {
		const entries = request.entries as PaidComputerUsageFrame[];
		for (const frame of entries) expect(frame).toEqual(frames[frame.sequence - 1]);
		accepted = Math.max(accepted, entries.at(-1)!.sequence);
		calls.push(`upload:${accepted}`);
		const last = JSON.parse(frames[accepted - 1]!.entryText) as PaidComputerUsageEntry;
		const result = {
			schema: "qorpera.computer-guard-usage-receipt/v1",
			permit: { ...permit, state: "bound", physicalId: physicalInstanceId, guestBootId },
			cursor: paidComputerUsageCursor(frames[accepted - 1]!),
			sealed: last.stopReceipt !== null,
			lastSample: last.sample,
		};
		canonical = result;
		return result;
	});
	return {
		permit,
		frames,
		guard,
		call,
		calls,
		append,
		drain: (lastSample: unknown = null) =>
			drainComputerGuardUsage({
				permit,
				lastSample,
				guard,
				call,
				recover: async () => {
					if (!canonical) throw new Error("No SQL history");
					return canonical;
				},
				signal: AbortSignal.timeout(10000),
			}),
	};
}

describe("guard-owned sample upload", () => {
	it("uploads immutable pages and acknowledges only SQL-accepted prefixes before terminal closure", async () => {
		const f = fixture(3, true);
		const result = await f.drain();
		expect(f.calls).toEqual(["upload:2", "ack:2", "upload:3", "ack:3"]);
		expect(result.sealed).toBe(true);
		expect(result.sample?.state).toBe("stopped");
	});
	it("retains an empty open first stream without inventing bind or clocks", async () => {
		const f = fixture(0);
		expect(await f.drain()).toEqual({ permit: f.permit, sample: null, sealed: false });
		expect(f.call).not.toHaveBeenCalled();
		expect(f.guard.ackUsage).not.toHaveBeenCalled();
	});
	it("replays identical bytes after a committed upload loses its reply", async () => {
		const f = fixture(2),
			call = f.call.getMockImplementation()!;
		f.call.mockImplementationOnce(async (request) => {
			await call(request);
			throw new Error("reply lost");
		});
		await expect(f.drain()).rejects.toThrow("reply lost");
		expect(f.guard.ackUsage).not.toHaveBeenCalled();
		await f.drain();
		expect(f.call.mock.calls[0]?.[0]).toEqual(f.call.mock.calls[1]?.[0]);
	});
	it("replays the retained prefix when durable acknowledgement fails", async () => {
		const f = fixture(2);
		f.guard.ackUsage.mockRejectedValueOnce(new Error("fsync unavailable"));
		await expect(f.drain()).rejects.toThrow("fsync unavailable");
		await f.drain();
		expect(f.call.mock.calls[0]?.[0]).toEqual(f.call.mock.calls[1]?.[0]);
	});
	it("recovers canonical history after ACK fsync succeeds but its reply is lost", async () => {
		const f = fixture(2),
			ack = f.guard.ackUsage.getMockImplementation()!;
		f.guard.ackUsage.mockImplementationOnce(async (id, cursor) => {
			await ack(id, cursor);
			throw new Error("ACK reply lost");
		});
		await expect(f.drain()).rejects.toThrow("ACK reply lost");
		f.call.mockClear();
		const recovered = await f.drain();
		expect(recovered.sample?.observationId).toBe(paidComputerUsageCursor(f.frames.at(-1)!).observationId);
		expect(f.call).not.toHaveBeenCalled();
	});

	it.each(["cursor", "identity", "sample"])("does not acknowledge a differing canonical %s", async (failure) => {
		const f = fixture(2),
			call = f.call.getMockImplementation()!;
		f.call.mockImplementationOnce(async (request) => {
			const receipt = (await call(request)) as Record<string, any>;
			if (failure === "cursor") receipt.cursor.sha256 = "f".repeat(64);
			if (failure === "identity") receipt.permit.epoch = randomUUID();
			if (failure === "sample") receipt.lastSample.guestUptimeMs++;
			return receipt;
		});
		await expect(f.drain()).rejects.toThrow("RECEIPT_DIFFERS");
		expect(f.guard.ackUsage).not.toHaveBeenCalled();
	});
	it("recovers a fully acknowledged sealed tip without creating another terminal observation", async () => {
		const f = fixture(3, true),
			first = await f.drain();
		f.call.mockClear();
		expect(await f.drain(first.sample)).toMatchObject({ sample: first.sample, sealed: true });
		expect(f.call).not.toHaveBeenCalled();
	});
	it("does not chase new producer entries beyond its captured prefix", async () => {
		const f = fixture(2),
			ack = f.guard.ackUsage.getMockImplementation()!;
		f.guard.ackUsage.mockImplementationOnce(async (id, cursor) => {
			const result = await ack(id, cursor);
			f.append();
			return result;
		});
		await f.drain();
		expect(f.calls).toEqual(["upload:2", "ack:2"]);
		expect(f.frames).toHaveLength(3);
	});
	it("refuses an unconfirmed stream without an upload", async () => {
		const f = fixture(2),
			read = f.guard.readUsage.getMockImplementation()!;
		f.guard.readUsage.mockImplementationOnce(async () => ({ ...(await read()), state: "unconfirmed" }));
		await expect(f.drain()).rejects.toThrow("USAGE_UNCONFIRMED");
		expect(f.call).not.toHaveBeenCalled();
	});
});
