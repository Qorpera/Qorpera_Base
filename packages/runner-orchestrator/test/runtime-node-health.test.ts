import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { type CpuInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	collectRuntimeNodeHealthProcess,
	measuredRuntimeNodeHealth,
	parseRuntimeNodeHealth,
	type RuntimeNodeHealth,
	RuntimeNodeHealthPublisher,
	runtimeNodeCpuUsage,
	runtimeNodeMemory,
	runtimeNodeNetwork,
	runtimeNodeObserverSoftware,
} from "../src/runtime-node-health.ts";
import type { RuntimeNodeObserverRegistry } from "../src/runtime-node-observer.ts";

const linux = process.platform === "linux" && !!process.geteuid?.();
const nodeId = "36000000-0000-4000-8000-000000000010",
	machine = "c".repeat(64);
const policy = "d".repeat(64);
const from = "2026-09-09T00:00:00.000Z",
	until = "2026-09-09T00:00:01.000Z";
function sample(): RuntimeNodeHealth {
	return {
		schema: "qorpera.runtime-node-health/v1",
		nodeId,
		machineIdSha256: machine,
		policySha256: policy,
		observerPackageSha256: "e".repeat(64),
		bootId: "36000000-0000-4000-8000-000000000011",
		observationId: "36000000-0000-4000-8000-000000000012",
		observedAt: until,
		cpu: { usedBasisPoints: 2500, from, until },
		memory: { totalBytes: 8192, availableBytes: 4096 },
		rootFilesystem: { totalBytes: 81920, freeBytes: 40960, availableBytes: 40000 },
		network: { receivedBytes: 20, sentBytes: 10, receiveErrors: 1, sendErrors: 2, receiveDrops: 3, sendDrops: 4 },
		errors: [],
	};
}
const cpu = (user: number, idle: number): CpuInfo => ({
	model: "fixture",
	speed: 1000,
	times: { user, idle, nice: 0, sys: 0, irq: 0 },
});
const network = (rows: string[]) =>
	`Inter-|   Receive                                                |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n${rows.join("\n")}\n`;
const registryCall = () =>
	vi.fn<RuntimeNodeObserverRegistry["call"]>(async (_method, args) => {
		const observation = args.p_observation as RuntimeNodeHealth;
		return { nodeId, observationId: observation.observationId, observedAt: observation.observedAt };
	});
describe("bounded node health evidence", () => {
	it("computes weighted CPU time across CPUs and rejects reset/hotplug/empty samples", () => {
		expect(
			runtimeNodeCpuUsage([cpu(0, 0), cpu(0, 0)], [cpu(500, 500), cpu(0, 1000)], from, until).usedBasisPoints,
		).toBe(2500);
		for (const [a, b] of [
			[[], []],
			[[cpu(1, 1)], [cpu(0, 2)]],
			[[cpu(1, 1)], [cpu(1, 1)]],
			[[cpu(1, 1)], []],
		] as [CpuInfo[], CpuInfo[]][])
			expect(() => runtimeNodeCpuUsage(a, b, from, until)).toThrow();
	});
	it("uses Linux MemAvailable, not free-memory or a configured reservation", () => {
		expect(runtimeNodeMemory("MemTotal: 8192 kB\nMemFree: 1 kB\nMemAvailable: 4096 kB\n")).toEqual({
			totalBytes: 8388608,
			availableBytes: 4194304,
		});
		for (const text of [
			"MemTotal: 8192 kB\n",
			"MemTotal: 8192 kB\nMemAvailable: 8193 kB\n",
			"MemTotal: 8192 kB\nMemTotal: 8192 kB\nMemAvailable: 1 kB\n",
		])
			expect(() => runtimeNodeMemory(text)).toThrow();
	});
	it("retains cumulative network error/drop counts without leaking interface names or counting loopback", () => {
		const row = "eth-private: 10 1 2 3 0 0 0 0 20 1 4 5 0 0 0 0";
		const result = runtimeNodeNetwork(network([row, "lo: 999 9 9 9 0 0 0 0 999 9 9 9 0 0 0 0"]));
		expect(result).toEqual({
			receivedBytes: 10,
			sentBytes: 20,
			receiveErrors: 2,
			sendErrors: 4,
			receiveDrops: 3,
			sendDrops: 5,
		});
		expect(JSON.stringify(result)).not.toContain("eth-private");
		expect(() => runtimeNodeNetwork(network([row, row]))).toThrow();
		expect(() => runtimeNodeNetwork(network(["lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"]))).toThrow();
		expect(() => runtimeNodeNetwork(network(["eth0: 1 2 3"]))).toThrow();
	});
	it("requires exact closed metadata and explicit reasons for unavailable fields", () => {
		expect(parseRuntimeNodeHealth(sample())).toEqual(sample());
		const partial = { ...sample(), rootFilesystem: null, errors: ["ROOT_FILESYSTEM_UNAVAILABLE"] };
		expect(parseRuntimeNodeHealth(partial)).toEqual(partial);
		for (const invalid of [
			{ ...sample(), rootFilesystem: null },
			{ ...sample(), errors: ["PRIVATE FAILURE"] },
			{ ...sample(), cpu: { ...sample().cpu, usedBasisPoints: 10001 } },
			{ ...sample(), observedAt: "2026-09-09T00:00:00.000Z" },
			{ ...sample(), memory: { totalBytes: 10, availableBytes: 11 } },
			{ ...sample(), rootFilesystem: { totalBytes: 20, freeBytes: 10, availableBytes: 11 } },
			{ ...sample(), network: { ...sample().network, receiveErrors: -1 } },
			{ ...sample(), credential: "PRIVATE" },
			{ ...sample(), bootId: null },
			{ ...partial, errors: ["ROOT_FILESYSTEM_UNAVAILABLE", "ROOT_FILESYSTEM_UNAVAILABLE"] },
		])
			expect(() => parseRuntimeNodeHealth(invalid)).toThrow();
	});
	it("gives a measured report a new time-ordered id and keeps everything else", () => {
		vi.useFakeTimers({ now: Date.parse(until) });
		try {
			const report = measuredRuntimeNodeHealth({ ...sample() });
			expect(report.observationId[14]).toBe("7");
			expect(report.observationId.replaceAll("-", "").slice(0, 12)).toBe(
				Date.parse(until).toString(16).padStart(12, "0"),
			);
			expect({ ...report, observationId: sample().observationId }).toEqual(sample());
		} finally {
			vi.useRealTimers();
		}
	});
	it("publishes exact identity and refuses mismatched acknowledgements", async () => {
		const call = registryCall();
		const publisher = new RuntimeNodeHealthPublisher(nodeId, machine, policy, { call }, async () => sample());
		await publisher.observe(new AbortController().signal);
		expect(call.mock.calls[0]!.slice(0, 2)).toEqual([
			"qorpera_observe_runtime_node_health",
			{ p_observation: sample() },
		]);
		call.mockResolvedValueOnce({ nodeId, observationId: "wrong", observedAt: until });
		await expect(publisher.observe(new AbortController().signal)).rejects.toThrow(
			"NODE_HEALTH_PUBLICATION_UNCONFIRMED",
		);
	});
	it("reports failed collection without fabricated measurements or raw errors and does not retry an ambiguous publication", async () => {
		const call = registryCall();
		const collect = vi.fn(async () => {
			throw new Error("PRIVATE filesystem path");
		});
		const publisher = new RuntimeNodeHealthPublisher(nodeId, machine, policy, { call }, collect);
		await publisher.observe(new AbortController().signal);
		const observation = call.mock.calls[0]![1].p_observation;
		// A time-ordered id: reports land beside each other in the receipts' index.
		expect((observation as { observationId: string }).observationId[14]).toBe("7");
		expect(parseRuntimeNodeHealth(observation)).toMatchObject({
			bootId: null,
			cpu: null,
			memory: null,
			network: null,
			rootFilesystem: null,
			errors: ["COLLECTION_UNCONFIRMED"],
		});
		expect(JSON.stringify(observation)).not.toContain("PRIVATE");
		call.mockRejectedValueOnce(new Error("lost receipt"));
		await expect(publisher.observe(new AbortController().signal)).rejects.toThrow("lost receipt");
		expect(call).toHaveBeenCalledTimes(2);
	});
	it("keeps one measurement in flight and cancellation starts no new export", async () => {
		const controller = new AbortController();
		let finish!: (value: RuntimeNodeHealth) => void;
		const collect = vi.fn(
				() =>
					new Promise<RuntimeNodeHealth>((resolve) => {
						finish = resolve;
					}),
			),
			call = vi.fn();
		const publisher = new RuntimeNodeHealthPublisher(nodeId, machine, policy, { call }, collect),
			pending = publisher.observe(controller.signal);
		await expect(publisher.observe(controller.signal)).rejects.toThrow("NODE_HEALTH_BUSY");
		controller.abort();
		finish(sample());
		await expect(pending).rejects.toThrow();
		expect(call).not.toHaveBeenCalled();
	});
	it("runs the probe from the running observer's own file, not the first installation's path", async () => {
		// A cut's observer is a file of its own (16 Oct 2026: both nodes' observers spawned the first installation's
		// path, which node 2 does not have, so every sample since was COLLECTION_UNCONFIRMED).
		const observer = join(await mkdtemp(join(tmpdir(), "qorpera-node-health-")), "observer-node02-v180.cjs");
		await writeFile(
			observer,
			[
				"const env = Object.keys(process.env).join();",
				'if (process.argv.length !== 3 || process.argv[2] !== "--health-probe" || env !== "PATH") process.exit(1);',
				`process.stdout.write(${JSON.stringify(`${JSON.stringify(sample())}\n`)});`,
			].join("\n"),
		);
		await expect(collectRuntimeNodeHealthProcess(new AbortController().signal, observer)).resolves.toEqual(sample());
		await writeFile(observer, "process.exit(1);\n");
		await expect(collectRuntimeNodeHealthProcess(new AbortController().signal, observer)).rejects.toThrow(
			"NODE_HEALTH_COLLECTION_UNCONFIRMED",
		);
	});
	it.runIf(linux)("names a cut's observer by its own bytes, only from a file its account cannot change", async () => {
		const observer = join(await mkdtemp(join(tmpdir(), "qorpera-node-health-")), "observer-node02-v180.cjs");
		await writeFile(observer, "observer", { mode: 0o444 });
		await expect(runtimeNodeObserverSoftware(observer, policy)).rejects.toThrow("OFFICE_HOST_PATH_UNPROTECTED");
		// Any root-owned file in root-owned directories stands in for the installed observer.
		expect(await runtimeNodeObserverSoftware("/etc/passwd", policy)).toBe(
			createHash("sha256").update(readFileSync("/etc/passwd")).digest("hex"),
		);
	});
});
