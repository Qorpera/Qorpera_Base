import { statfs } from "node:fs/promises";
import type { CpuInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NODE_DISK_TIMEOUT_MS,
	NODE_SAMPLE_INTERVAL_MS,
	NODE_STALE_AFTER_MS,
	type NodeObservationSources,
	ProviderNodeObservability,
} from "../src/node-observability.ts";

vi.mock("node:fs/promises", () => ({ statfs: vi.fn() }));

const START = Date.parse("2026-08-31T12:00:00.000Z");
const NODE_ID = "20000000-0000-4000-8000-000000000001";
const SPACE = { blockSize: 4096n, blocks: 1000n, availableBlocks: 250n };
const monitors: ProviderNodeObservability[] = [];

function times(user = 0, idle = 0): CpuInfo["times"] {
	return { user, nice: 0, sys: 0, idle, irq: 0 };
}

function fixture(overrides: Partial<NodeObservationSources> = {}) {
	const sources = {
		cpuTimes: vi.fn(() => [times(100, 100)]),
		memory: vi.fn(() => ({ totalBytes: 16_000, freeBytes: 4_000 })),
		disk: vi.fn(async () => SPACE),
		now: vi.fn(() => Date.now()),
		monotonicNow: vi.fn(() => Date.now() - START),
	};
	const monitor = new ProviderNodeObservability({
		providerAdapter: "managed",
		nodeId: NODE_ID,
		softwareVersion: "0.83.0",
		sources: { ...sources, ...overrides },
	});
	monitors.push(monitor);
	return { monitor, sources };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	vi.mocked(statfs).mockReset();
});

afterEach(() => {
	for (const monitor of monitors.splice(0)) monitor.stop();
	vi.useRealTimers();
});

describe("provider node observations", () => {
	it("starts unknown, uses no measurements on queries, and does not invent network health", () => {
		const { monitor, sources } = fixture();
		for (let i = 0; i < 5; i += 1) {
			const snapshot = monitor.snapshot();
			expect(snapshot).toMatchObject({
				schema: "qorpera.node-observation/v1",
				providerAdapter: "managed",
				nodeId: NODE_ID,
				softwareVersion: "0.83.0",
				retention: "latest-in-process-only",
				scope: "provider-host",
			});
			for (const metric of [snapshot.cpu, snapshot.memory, snapshot.disk]) {
				expect(metric).toEqual({
					status: "unknown",
					reason: "not_sampled",
					observedAt: null,
					attemptedAt: null,
					freshness: "unknown",
					value: null,
				});
			}
			expect(snapshot.network).toEqual({ ...snapshot.cpu, reason: "not_observed" });
		}
		expect(sources.cpuTimes).not.toHaveBeenCalled();
		expect(sources.memory).not.toHaveBeenCalled();
		expect(sources.disk).not.toHaveBeenCalled();
	});

	it("uses a measured CPU delta rather than cumulative counters or load average", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().cpu).toMatchObject({ status: "unknown", reason: "warming_up", value: null });
		sources.cpuTimes.mockReturnValue([times(150, 250)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu).toEqual({
			status: "observed",
			reason: null,
			observedAt: new Date(START + NODE_SAMPLE_INTERVAL_MS).toISOString(),
			attemptedAt: new Date(START + NODE_SAMPLE_INTERVAL_MS).toISOString(),
			freshness: "fresh",
			value: { utilizationRatio: 0.25, windowMs: NODE_SAMPLE_INTERVAL_MS, logicalCpuCount: 1 },
		});
	});

	it("distinguishes measured zero CPU from a missing reading", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		sources.cpuTimes.mockReturnValue([times(100, 200)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.value?.utilizationRatio).toBe(0);
		sources.cpuTimes.mockReturnValue([times(200, 200)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.value?.utilizationRatio).toBe(1);
	});

	it("aggregates all logical CPUs without deriving admission capacity", async () => {
		const { monitor, sources } = fixture();
		sources.cpuTimes.mockReturnValue([times(100, 100), times(100, 100)]);
		monitor.start();
		sources.cpuTimes.mockReturnValue([times(200, 100), times(100, 400)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.value).toEqual({
			utilizationRatio: 0.25,
			windowMs: NODE_SAMPLE_INTERVAL_MS,
			logicalCpuCount: 2,
		});
		expect(JSON.stringify(monitor.snapshot())).not.toMatch(/capacity|reservation|slot|loadAverage/);
	});

	it("labels OS nonfree memory honestly and measures only root-filesystem available bytes", async () => {
		const { monitor } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().memory.value).toEqual({
			totalBytes: 16_000,
			freeBytes: 4_000,
			usedBytes: 12_000,
			basis: "os-total-minus-free",
		});
		expect(monitor.snapshot().disk.value).toEqual({
			totalBytes: 4_096_000,
			availableBytes: 1_024_000,
			scope: "provider-root-filesystem",
		});
		expect(monitor.snapshot().network.status).toBe("unknown");
	});

	it("uses exactly statfs on the fixed root filesystem, with no configured path or content read", async () => {
		vi.mocked(statfs).mockResolvedValue({
			type: 1n,
			bsize: 4096n,
			blocks: 1000n,
			bfree: 300n,
			bavail: 250n,
			files: 100n,
			ffree: 50n,
		});
		const monitor = new ProviderNodeObservability({
			providerAdapter: "managed",
			sources: {
				cpuTimes: () => [times(0, 0)],
				memory: () => ({ totalBytes: 1000, freeBytes: 500 }),
				now: () => Date.now(),
				monotonicNow: () => Date.now() - START,
			},
		});
		monitors.push(monitor);
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(statfs).toHaveBeenCalledExactlyOnceWith("/", { bigint: true });
		expect(monitor.snapshot().disk.value?.availableBytes).toBe(1_024_000);
		for (let index = 0; index < 5; index += 1) monitor.snapshot();
		expect(statfs).toHaveBeenCalledTimes(1);
	});

	it("retains measured values and timestamps when they become stale or the wall clock goes backwards", async () => {
		const { monitor } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		const original = monitor.snapshot();
		monitor.stop();
		vi.setSystemTime(START + NODE_STALE_AFTER_MS);
		expect(monitor.snapshot().memory).toEqual({ ...original.memory, freshness: "stale" });
		expect(monitor.snapshot().disk).toEqual({ ...original.disk, freshness: "stale" });
		vi.setSystemTime(START - 1);
		expect(monitor.snapshot().memory.freshness).toBe("stale");
		expect(monitor.snapshot().cpu.freshness).toBe("unknown");
	});

	it("keeps the last successful measurement through a failed attempt without restamping it", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		const original = monitor.snapshot().memory;
		sources.memory.mockImplementation(() => {
			throw new Error("PRIVATE path /secret/token bearer material");
		});
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().memory).toEqual({
			...original,
			status: "unavailable",
			reason: "read_failed",
			attemptedAt: new Date(START + NODE_SAMPLE_INTERVAL_MS).toISOString(),
		});
		await vi.advanceTimersByTimeAsync(NODE_STALE_AFTER_MS);
		expect(monitor.snapshot().memory.freshness).toBe("stale");
		expect(monitor.snapshot().memory.observedAt).toBe(original.observedAt);
		expect(JSON.stringify(monitor.snapshot())).not.toMatch(/PRIVATE|secret|bearer/);
	});

	it("does not let callers mutate retained observations", async () => {
		const { monitor } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		const snapshot = monitor.snapshot();
		snapshot.memory.value!.usedBytes = 0;
		snapshot.disk.value!.availableBytes = 0;
		expect(monitor.snapshot().memory.value?.usedBytes).toBe(12_000);
		expect(monitor.snapshot().disk.value?.availableBytes).toBe(1_024_000);
	});

	it.each([
		{ totalBytes: 0, freeBytes: 0 },
		{ totalBytes: -1, freeBytes: 0 },
		{ totalBytes: 100, freeBytes: -1 },
		{ totalBytes: 100, freeBytes: 101 },
		{ totalBytes: Number.MAX_SAFE_INTEGER + 1, freeBytes: 0 },
		{ totalBytes: 100, freeBytes: Number.NaN },
	])("reports invalid memory as unavailable, never zero: %j", (memory) => {
		const { monitor } = fixture({ memory: () => memory });
		monitor.start();
		expect(monitor.snapshot().memory).toMatchObject({
			status: "unavailable",
			reason: "invalid_measurement",
			value: null,
		});
	});

	it("handles unavailable, reset and hotplugged CPU counters without reporting fictitious utilization", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		sources.cpuTimes.mockReturnValue([times(99, 500)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu).toMatchObject({ status: "unknown", reason: "counter_reset", value: null });
		sources.cpuTimes.mockReturnValue([times(110, 600), times(20, 40)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.reason).toBe("counter_reset");
		sources.cpuTimes.mockReturnValue([]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu).toMatchObject({ status: "unknown", reason: "not_supported", value: null });
		sources.cpuTimes.mockReturnValue([times(120, 700)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.reason).toBe("warming_up");
	});

	it("rejects invalid or zero-advance CPU counters and long sampling gaps", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.reason).toBe("invalid_measurement");
		sources.cpuTimes.mockReturnValue([times(Number.NaN, 200)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu).toMatchObject({ reason: "invalid_measurement", value: null });
		sources.cpuTimes.mockReturnValue([times(200, 200)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.reason).toBe("warming_up");
		sources.monotonicNow.mockReturnValue(1_000_000);
		sources.cpuTimes.mockReturnValue([times(300, 300)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu.reason).toBe("sampling_gap");
	});

	it("caps CPU-array and aggregate counter work", async () => {
		const { monitor, sources } = fixture();
		sources.cpuTimes.mockReturnValue(Array.from({ length: 4097 }, () => times(0, 0)));
		monitor.start();
		expect(monitor.snapshot().cpu.reason).toBe("invalid_measurement");
		sources.cpuTimes.mockReturnValue([times(0, 0), times(0, 0)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		sources.cpuTimes.mockReturnValue([times(Number.MAX_SAFE_INTEGER, 0), times(Number.MAX_SAFE_INTEGER, 0)]);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot().cpu).toMatchObject({ status: "unavailable", reason: "invalid_measurement" });
	});

	it.each([
		{ blockSize: 0n, blocks: 100n, availableBlocks: 1n },
		{ blockSize: 1n, blocks: 0n, availableBlocks: 0n },
		{ blockSize: 1n, blocks: 100n, availableBlocks: -1n },
		{ blockSize: 1n, blocks: 100n, availableBlocks: 101n },
		{ blockSize: 4096n, blocks: BigInt(Number.MAX_SAFE_INTEGER), availableBlocks: 1n },
	])("rejects invalid or unrepresentable disk measurement case %#", async (space) => {
		const { monitor } = fixture({ disk: async () => space });
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().disk).toMatchObject({
			status: "unavailable",
			reason: "invalid_measurement",
			value: null,
		});
	});

	it("reports a genuinely full disk as observed zero available bytes", async () => {
		const { monitor } = fixture({ disk: async () => ({ ...SPACE, availableBlocks: 0n }) });
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().disk).toMatchObject({ status: "observed", value: { availableBytes: 0 } });
	});

	it("bounds a hung statfs to one outstanding syscall and never promotes a late result", async () => {
		let resolveDisk!: (value: typeof SPACE) => void;
		const pending = new Promise<typeof SPACE>((resolve) => {
			resolveDisk = resolve;
		});
		const { monitor, sources } = fixture();
		sources.disk.mockReturnValueOnce(pending);
		monitor.start();
		await vi.advanceTimersByTimeAsync(NODE_DISK_TIMEOUT_MS);
		expect(monitor.snapshot().disk).toMatchObject({ status: "unavailable", reason: "timeout", value: null });
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS * 10);
		expect(sources.disk).toHaveBeenCalledTimes(1);
		resolveDisk(SPACE);
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().disk.observedAt).toBeNull();
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(sources.disk).toHaveBeenCalledTimes(2);
		expect(monitor.snapshot().disk.status).toBe("observed");
	});

	it("also rejects a late result when the deadline timer has not fired", async () => {
		const { monitor, sources } = fixture();
		sources.disk.mockImplementation(async () => {
			sources.monotonicNow.mockReturnValue(NODE_DISK_TIMEOUT_MS + 1);
			return SPACE;
		});
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().disk).toMatchObject({ status: "unavailable", reason: "timeout", value: null });
	});

	it("cleans timers on stop and retains the hung-operation fence across restart", async () => {
		let resolveDisk!: (value: typeof SPACE) => void;
		const { monitor, sources } = fixture();
		sources.disk.mockReturnValueOnce(
			new Promise<typeof SPACE>((resolve) => {
				resolveDisk = resolve;
			}),
		);
		monitor.start();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sources.cpuTimes).toHaveBeenCalledTimes(1);
		monitor.stop();
		monitor.stop();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS * 3);
		expect(sources.cpuTimes).toHaveBeenCalledTimes(1);
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(sources.disk).toHaveBeenCalledTimes(1);
		resolveDisk(SPACE);
		await vi.advanceTimersByTimeAsync(0);
		expect(monitor.snapshot().disk.observedAt).toBeNull();
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(sources.disk).toHaveBeenCalledTimes(2);
		expect(monitor.snapshot().disk.status).toBe("observed");
	});

	it("does not start a queued filesystem probe after immediate service shutdown", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		monitor.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(sources.disk).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains exceptions in all samplers and never exports raw errors", async () => {
		const error = new Error("Bearer PRIVATE_CREDENTIAL from /root/private");
		const { monitor } = fixture({
			cpuTimes: () => {
				throw error;
			},
			memory: () => {
				throw error;
			},
			disk: async () => {
				throw error;
			},
		});
		expect(() => monitor.start()).not.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		for (const item of [monitor.snapshot().cpu, monitor.snapshot().memory, monitor.snapshot().disk]) {
			expect(item).toMatchObject({ status: "unavailable", reason: "read_failed", value: null });
		}
		expect(JSON.stringify(monitor.snapshot())).not.toMatch(/Bearer|PRIVATE|root|private/);
	});

	it("shows unavailable clocks without inventing freshness or performing another disk read", async () => {
		const { monitor, sources } = fixture();
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		sources.now.mockReturnValue(Number.NaN);
		await vi.advanceTimersByTimeAsync(NODE_SAMPLE_INTERVAL_MS);
		expect(monitor.snapshot()).toMatchObject({
			asOf: null,
			memory: { status: "unavailable", reason: "clock_unavailable", freshness: "stale" },
		});
		expect(sources.disk).toHaveBeenCalledTimes(1);
	});

	it.each(["/root/PRIVATE", "Bearer PRIVATE", "a".repeat(43), "0.83.0\nPRIVATE", "https://private.example"])(
		"does not echo invalid optional identity/build text: %s",
		(value) => {
			const monitor = new ProviderNodeObservability({
				providerAdapter: value,
				nodeId: value,
				softwareVersion: value,
			});
			const snapshot = monitor.snapshot();
			expect(snapshot.nodeId).toBeNull();
			expect(snapshot.softwareVersion).toBeNull();
			// An adapter label has its own existing closed grammar; no arbitrary text is returned.
			if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) expect(snapshot.providerAdapter).toBeNull();
			expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|https:|\/root/);
		},
	);

	it("accepts a closed source-commit build identifier and leaves missing metadata null", () => {
		const current = new ProviderNodeObservability({ providerAdapter: "managed", softwareVersion: "a".repeat(40) });
		expect(current.snapshot()).toMatchObject({ nodeId: null, softwareVersion: "a".repeat(40) });
		const missing = new ProviderNodeObservability({ providerAdapter: "managed" });
		expect(missing.snapshot()).toMatchObject({ providerAdapter: "managed", nodeId: null, softwareVersion: null });
	});
});
