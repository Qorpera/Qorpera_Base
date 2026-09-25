import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeComputerUsageObserver } from "../src/computer-usage-observer.ts";
import { ComputerUsageOutbox } from "../src/computer-usage-outbox.ts";
import {
	type ComputerUsageMethod,
	type ComputerUsageSample,
	parseComputerUsageSample,
} from "../src/computer-usage-sample.ts";
import type { LxdHostInventory, LxdInstanceFile } from "../src/lxd-client.ts";
import type { RuntimeNodeInventoryContext, RuntimeNodeInventoryPolicy } from "../src/runtime-node-inventory.ts";
import type { RuntimeNodeObserverHost, RuntimeNodeObserverMethod } from "../src/runtime-node-observer.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "computer-usage-")));
	roots.push(root);
	await chmod(root, 0o700);
	const sha = "a".repeat(64),
		bootId = randomUUID(),
		guestBootId = randomUUID();
	const policy: RuntimeNodeInventoryPolicy = {
		schema: "qorpera.runtime-node-inventory-policy/v1",
		nodeId: randomUUID(),
		host: {
			machineIdSha256: sha,
			socketPath: "/run/lxd.socket",
			socketGid: 2000,
			certificateSha256: sha,
			serverName: "node",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		operatingCpuMillis: 1000,
		operatingMemoryBytes: 1024 ** 3,
		infrastructure: [],
	};
	const context: RuntimeNodeInventoryContext = {
		policy,
		nodeVersion: 1,
		contextSha256: sha,
		headroomCpuMillis: 2000,
		headroomMemoryBytes: 2 * 1024 ** 3,
		allocations: ["coding", "login"].map((providerKind) => ({
			allocationId: randomUUID(),
			providerKind: providerKind as "coding" | "login",
			providerId: providerKind,
			policySha256: sha,
			instanceSha256: "b".repeat(64),
			cpuMillis: 2000,
			memoryBytes: 4 * 1024 ** 3,
			physical: null,
		})),
	};
	const inventory: LxdHostInventory = {
		server: {
			project: "default",
			certificateSha256: sha,
			serverName: "node",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		instances: context.allocations.map((a) => {
			const config = {
				"limits.cpu": "2",
				"limits.memory": "4GiB",
				"volatile.uuid": randomUUID(),
				"user.qorpera.schema":
					a.providerKind === "coding" ? "qorpera.lxd-coding-machine/v1" : "qorpera.native-login-vm/v2",
				"user.qorpera.allocation_id": a.allocationId,
				[`user.qorpera.${a.providerKind === "coding" ? "provider_id" : "provider_adapter"}`]: a.providerId,
				"user.qorpera.provider_policy_sha256": a.policySha256,
				"user.qorpera.instance_sha256": a.instanceSha256,
			};
			return {
				project: a.providerKind,
				name: "computer",
				location: "none",
				type: "virtual-machine",
				config,
				expandedConfig: { ...config },
				devices: {},
				expandedDevices: {},
				profiles: [],
				status: "Running",
				statusCode: 103,
			};
		}),
	};
	const host: RuntimeNodeObserverHost = {
		machineIdSha256: sha,
		cpuMillis: 16000,
		memoryBytes: 64 * 1024 ** 3,
		bootId,
		namespace: "mnt:[1]",
		socket: { dev: 1, ino: 2, uid: 0, gid: 2000, mode: 0o140660, nlink: 1 },
	};
	const samples: ComputerUsageSample[] = [];
	let lost = false;
	const registry = {
		call: vi.fn(async (method: ComputerUsageMethod | RuntimeNodeObserverMethod, args: Record<string, unknown>) => {
			if (method === "qorpera_runtime_node_inventory_context") return structuredClone(context);
			if (method === "qorpera_read_node_computer_usage")
				return { schema: "qorpera.node-computer-usage/v1", allocations: [] };
			const sample = structuredClone(args.p_sample) as ComputerUsageSample;
			samples.push(sample);
			if (lost) throw new Error("private transport response");
			return { observationId: sample.observationId, recorded: true, charged: false, reason: "observed" };
		}),
	};
	const client = {
		inspectHostInventory: vi.fn(async () => structuredClone(inventory)),
		readInstanceFile: vi.fn(
			async (_project: string, _name: string, path: string): Promise<LxdInstanceFile> => ({
				uid: 0,
				gid: 0,
				mode: 0o444,
				content: Buffer.from(path === "/proc/uptime" ? "100.00 0.00\n" : `${guestBootId}\n`),
			}),
		),
	};
	let now = new Date("2026-09-25T10:00:00.000Z");
	const ports = { client, host: vi.fn(async () => structuredClone(host)), now: () => now };
	const outbox = new ComputerUsageOutbox(root);
	return {
		root,
		inventory,
		host,
		ports,
		context,
		policy,
		registry,
		samples,
		outbox,
		setLost(value: boolean) {
			lost = value;
		},
		advance() {
			now = new Date(now.getTime() + 5000);
		},
		observer: new RuntimeComputerUsageObserver(policy, registry, outbox, ports),
	};
}
const signal = () => new AbortController().signal;
describe("physical computer shadow observer", () => {
	it("preserves an outbox sample when a receipt is malformed, and rejects conflicting persisted bytes", async () => {
		const f = await fixture();
		await f.observer.observe(signal());
		const sample = f.samples[0];
		await f.outbox.enqueue(sample);
		await expect(f.outbox.enqueue({ ...sample, uptimeMs: 200000 })).rejects.toThrow("CONFLICT");
		f.registry.call.mockResolvedValueOnce({
			observationId: sample.observationId,
			recorded: true,
			charged: false,
			reason: "excluded",
		});
		await expect(f.outbox.flush(f.registry, signal())).rejects.toThrow("UNCONFIRMED");
		expect(await readdir(f.root)).toHaveLength(1);
		await f.outbox.flush(f.registry, signal());
		expect(await readdir(f.root)).toEqual([]);
		expect(() =>
			parseComputerUsageSample({ ...sample, state: "gap", reason: ["missing"], uptimeMs: null, guestBootId: null }),
		).toThrow();
	});
	it("records absent and authority-changed allocations as unknown instead of reading their guests", async () => {
		const f = await fixture();
		f.inventory.instances = [];
		await f.observer.observe(signal());
		expect(f.samples[0]).toMatchObject({ state: "gap", reason: "missing", physicalId: null });
		expect(f.ports.client.readInstanceFile).not.toHaveBeenCalled();
	});
	it("emits one boot-bound sample per coding machine, excluding login helpers", async () => {
		const f = await fixture();
		await f.observer.observe(signal());
		expect(f.samples).toHaveLength(1);
		expect(f.samples[0]).toMatchObject({
			allocationId: f.context.allocations[0].allocationId,
			state: "running",
			uptimeMs: 100000,
			previousObservationId: null,
			hostBootId: f.host.bootId,
		});
		expect(f.ports.client.readInstanceFile).toHaveBeenCalledTimes(3);
		f.advance();
		await f.observer.observe(signal());
		expect(f.samples[1].previousObservationId).toBe(f.samples[0].observationId);
		expect(await readdir(f.root)).toEqual([]);
	});
	it("durably retries exactly the same sample after a lost response and restart, then resets continuity", async () => {
		const f = await fixture();
		f.setLost(true);
		await expect(f.observer.observe(signal())).rejects.toThrow("UNCONFIRMED");
		expect(await readdir(f.root)).toHaveLength(1);
		f.setLost(false);
		f.advance();
		const restarted = new RuntimeComputerUsageObserver(
			f.policy,
			f.registry,
			new ComputerUsageOutbox(f.root),
			f.ports,
		);
		await restarted.observe(signal());
		expect(f.samples[1]).toEqual(f.samples[0]);
		expect(f.samples[2].previousObservationId).toBeNull();
		expect(f.samples[2].observerId).not.toBe(f.samples[0].observerId);
	});
	it.each([
		["Stopped", 102],
		["Frozen", 110],
		["Starting", 106],
	])("records %s as a gap without reading an unavailable clock", async (status, statusCode) => {
		const f = await fixture();
		f.inventory.instances[0].status = String(status);
		f.inventory.instances[0].statusCode = Number(statusCode);
		await f.observer.observe(signal());
		expect(f.samples[0]).toMatchObject({ state: "gap", reason: "not_running", uptimeMs: null, guestBootId: null });
		expect(f.ports.client.readInstanceFile).not.toHaveBeenCalled();
	});
	it("invalidates continuity after a host failure without inventing an interval", async () => {
		const f = await fixture();
		await f.observer.observe(signal());
		f.advance();
		f.ports.host.mockRejectedValueOnce(new Error("host unavailable"));
		await expect(f.observer.observe(signal())).rejects.toThrow("UNCONFIRMED");
		f.advance();
		await f.observer.observe(signal());
		expect(f.samples[1].previousObservationId).toBeNull();
	});
	it("publishes a gap when the VM reboots during clock inspection", async () => {
		const f = await fixture();
		f.ports.client.readInstanceFile.mockResolvedValueOnce({
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		await f.observer.observe(signal());
		expect(f.samples[0]).toMatchObject({ state: "gap", reason: "unconfirmed", uptimeMs: null });
	});
	it("discards running evidence when the physical inventory changes during sampling", async () => {
		const f = await fixture();
		const changed = structuredClone(f.inventory);
		changed.instances = [];
		f.ports.client.inspectHostInventory
			.mockResolvedValueOnce(structuredClone(f.inventory))
			.mockResolvedValueOnce(changed);
		await f.observer.observe(signal());
		expect(f.samples[0]).toMatchObject({ state: "gap", reason: "unconfirmed" });
	});
	it("holds the serialization slot while cancelled IO is still pending", async () => {
		const f = await fixture();
		let finish!: () => void;
		f.ports.host.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(f.host);
				}),
		);
		const controller = new AbortController();
		const first = f.observer.observe(controller.signal);
		const rejected = expect(first).rejects.toThrow("UNCONFIRMED");
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		controller.abort();
		await expect(f.observer.observe(signal())).rejects.toThrow("BUSY");
		finish();
		await rejected;
		expect(f.samples).toHaveLength(0);
	});
});
