import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LxdHostInventory, LxdHostInventoryInstance } from "../src/lxd-client.ts";
import {
	parseRuntimeNodeInventoryPolicy,
	type RuntimeNodeInventoryContext,
	type RuntimeNodeInventoryPolicy,
	reconcileRuntimeNodeInventory,
	runtimeNodeInstanceConfigurationSha256,
} from "../src/runtime-node-inventory.ts";
import {
	RuntimeNodeInventoryObserver,
	type RuntimeNodeObserverHost,
	type RuntimeNodeObserverRegistry,
} from "../src/runtime-node-observer.ts";

const sha = "a".repeat(64),
	signal = () => new AbortController().signal;
type TestInstance = Omit<LxdHostInventoryInstance, "config" | "expandedConfig" | "devices" | "expandedDevices"> & {
	config: Record<string, string>;
	expandedConfig: Record<string, string>;
	devices: Record<string, Record<string, string>>;
	expandedDevices: Record<string, Record<string, string>>;
};
function fixture() {
	const policy: RuntimeNodeInventoryPolicy = {
		schema: "qorpera.runtime-node-inventory-policy/v1",
		nodeId: randomUUID(),
		host: {
			machineIdSha256: sha,
			socketPath: "/var/snap/lxd/common/lxd/unix.socket",
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
		headroomCpuMillis: 4000,
		headroomMemoryBytes: 8 * 1024 ** 3,
		allocations: ["native", "office", "login"].map((kind) => ({
			allocationId: randomUUID(),
			providerKind: kind as "native" | "office" | "login",
			providerId: kind === "office" ? randomUUID() : kind,
			policySha256: sha,
			instanceSha256: "b".repeat(64),
			physical: null,
			cpuMillis: 2000,
			memoryBytes: 4 * 1024 ** 3,
		})),
	};
	const instances: TestInstance[] = context.allocations.map((a) => {
		const config = {
			"limits.cpu": "2",
			"limits.memory": a.providerKind === "office" ? String(4 * 1024 ** 3) : "4GiB",
			"volatile.uuid": randomUUID(),
			"user.qorpera.schema":
				a.providerKind === "office"
					? "qorpera.lxd-office-guest/v2"
					: a.providerKind === "native"
						? "qorpera.native-job-vm/v1"
						: "qorpera.native-login-vm/v2",
			[`user.qorpera.${a.providerKind === "native" ? "acquisition_id" : "allocation_id"}`]: a.allocationId,
			[`user.qorpera.${a.providerKind === "office" ? "provider_id" : "provider_adapter"}`]: a.providerId,
			"user.qorpera.provider_policy_sha256": a.policySha256,
			"user.qorpera.instance_sha256": a.instanceSha256,
		};
		return {
			name: "computer",
			project: a.providerKind,
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
	});
	const inventory: { server: LxdHostInventory["server"]; instances: TestInstance[] } = {
		server: {
			project: "default",
			certificateSha256: sha,
			serverName: "node",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		instances,
	};
	const host: RuntimeNodeObserverHost = {
		machineIdSha256: sha,
		cpuMillis: 16000,
		memoryBytes: 64 * 1024 ** 3,
		bootId: randomUUID(),
		namespace: "mnt:[1]",
		socket: { dev: 1, ino: 2, uid: 0, gid: 2000, mode: 0o140660, nlink: 1 },
	};
	return { policy, context, inventory, host };
}
describe("complete host inventory reconciliation", () => {
	it.each(["uuid", "project", "name", "configuration"])("blocks replacement of an observed physical %s", (fault) => {
		const f = fixture(),
			i = f.inventory.instances[0];
		f.context.allocations[0].physical = {
			project: i.project,
			name: i.name,
			physicalId: i.config["volatile.uuid"],
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		};
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("ready");
		if (fault === "uuid") i.config["volatile.uuid"] = i.expandedConfig["volatile.uuid"] = randomUUID();
		if (fault === "project") i.project = "different";
		if (fault === "name") i.name = "different";
		if (fault === "configuration") i.expandedDevices.extra = { type: "disk", source: "/changed" };
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it("matches all three physical provider types with exact ledger costs across projects", () => {
		const f = fixture(),
			result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("ready");
		expect(result.entries.map((i) => i.allocation?.providerKind)).toEqual(["native", "office", "login"]);
	});
	it.each(["Stopped", "Frozen", "Starting", "Stopping", "Error"])(
		"retains %s computers and their charge",
		(status) => {
			const f = fixture();
			f.inventory.instances[0].status = status;
			f.inventory.instances[0].statusCode = { Stopped: 102, Frozen: 110, Starting: 106, Stopping: 107, Error: 112 }[
				status
			]!;
			const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
			expect(result.state).toBe("ready");
			expect(result.entries[0].allocation).toEqual(f.context.allocations[0]);
			expect(result.entries[0].state).not.toBe("running");
		},
	);
	it("does not release reservations when an allocated VM is absent", () => {
		const f = fixture();
		f.inventory.instances = [];
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context)).toEqual({
			state: "ready",
			entries: [],
			headroomValid: true,
		});
		expect(f.context.allocations).toHaveLength(3);
	});
	it.each([
		"legacy",
		"unmanaged-container",
		"wrong-policy",
		"wrong-instance",
		"wrong-provider",
		"wrong-allocation",
		"expanded-tag",
		"expanded-cpu",
		"expanded-memory",
		"unlimited",
		"pinned",
		"missing-uuid",
		"unknown-state",
	])("blocks unaccounted or altered instance: %s", (fault) => {
		const f = fixture(),
			i = f.inventory.instances[0];
		if (fault === "legacy") delete i.config["user.qorpera.schema"];
		if (fault === "unmanaged-container") i.type = "container";
		for (const [test, key] of [
			["wrong-policy", "provider_policy_sha256"],
			["wrong-instance", "instance_sha256"],
			["wrong-provider", "provider_adapter"],
			["wrong-allocation", "acquisition_id"],
		])
			if (fault === test) i.config[`user.qorpera.${key}`] = i.expandedConfig[`user.qorpera.${key}`] = "changed";
		if (fault === "expanded-tag") i.expandedConfig["user.qorpera.instance_sha256"] = "c".repeat(64);
		if (fault === "expanded-cpu") i.expandedConfig["limits.cpu"] = "8";
		if (fault === "expanded-memory") i.expandedConfig["limits.memory"] = "8GiB";
		if (fault === "unlimited") delete i.expandedConfig["limits.memory"];
		if (fault === "pinned") i.config["limits.cpu"] = i.expandedConfig["limits.cpu"] = "0-7";
		if (fault === "missing-uuid") delete i.config["volatile.uuid"];
		if (fault === "unknown-state") i.status = "Unknown";
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it.each(["physical", "allocation", "name"])("refuses duplicate %s identity", (fault) => {
		const f = fixture(),
			i = structuredClone(f.inventory.instances[0]);
		if (fault !== "name") i.name = "second";
		if (fault === "allocation") i.config["volatile.uuid"] = i.expandedConfig["volatile.uuid"] = randomUUID();
		f.inventory.instances.push(i);
		expect(() => reconcileRuntimeNodeInventory(f.inventory, f.context)).toThrow("DUPLICATE");
	});
	it("enrolls infrastructure by exact physical identity/configuration and charges it inside headroom", () => {
		const f = fixture(),
			i = structuredClone(f.inventory.instances[0]);
		i.name = "management";
		i.project = "default";
		i.config = {
			"limits.cpu": "2",
			"limits.memory": "4GiB",
			"volatile.uuid": randomUUID(),
			"cloud-init.user-data": "PRIVATE_BYTES",
			"user.qorpera.management_vm": "fixture-management-marker",
		};
		i.expandedConfig = { ...i.config };
		f.inventory.instances.push(i);
		f.policy.infrastructure.push({
			project: i.project,
			name: i.name,
			type: "virtual-machine",
			physicalId: i.config["volatile.uuid"],
			cpuMillis: 2000,
			memoryBytes: 4 * 1024 ** 3,
			configurationSha256: runtimeNodeInstanceConfigurationSha256(i),
		});
		const result = reconcileRuntimeNodeInventory(f.inventory, f.context);
		expect(result.state).toBe("ready");
		expect(result.entries[3].category).toBe("infrastructure");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_BYTES");
		f.context.headroomCpuMillis = 2000;
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
		f.context.headroomCpuMillis = 4000;
		i.expandedConfig["cloud-init.user-data"] = "changed";
		expect(reconcileRuntimeNodeInventory(f.inventory, f.context).state).toBe("unavailable");
	});
	it.each([null, [], { extra: true }, "bad"])("refuses invalid policy %#", (value) =>
		expect(() => parseRuntimeNodeInventoryPolicy(value)).toThrow(),
	);
	it("refuses scalar coercion, duplicate infrastructure and a substituted daemon", () => {
		const f = fixture();
		expect(() => parseRuntimeNodeInventoryPolicy({ ...f.policy, operatingCpuMillis: [1000] })).toThrow();
		f.inventory.server.serverName = "other";
		expect(() => reconcileRuntimeNodeInventory(f.inventory, f.context)).toThrow("HOST_DIFFERS");
	});
});

describe("trusted node inventory publisher composition", () => {
	function observer(change?: (method: string, args: Record<string, unknown>) => void) {
		const f = fixture();
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const registry: RuntimeNodeObserverRegistry = {
			call: vi.fn(async (method, args) => {
				calls.push({ method, args: structuredClone(args) });
				change?.(method, args);
				if (method === "qorpera_runtime_node_inventory_context") return structuredClone(f.context);
				const o = args.p_observation as Record<string, unknown>;
				return { nodeId: o.nodeId, observationId: o.observationId, observedAt: o.observedAt };
			}),
		};
		const ports = {
			host: vi.fn(async () => structuredClone(f.host)),
			lxd: { inspectHostInventory: vi.fn(async () => structuredClone(f.inventory)) },
		};
		return { ...f, calls, registry, ports, observer: new RuntimeNodeInventoryObserver(f.policy, registry, ports) };
	}
	it("publishes a bounded receipt after complete inventory and matching physical readback", async () => {
		const f = observer();
		expect((await f.observer.observe(signal())).state).toBe("ready");
		expect(f.ports.host).toHaveBeenCalledTimes(2);
		expect(f.calls.map((c) => c.method)).toEqual([
			"qorpera_runtime_node_inventory_context",
			"qorpera_observe_runtime_node_inventory",
		]);
		expect(f.calls[1].args.p_inventory).toMatchObject({
			bootId: f.host.bootId,
			entries: Array(3).fill({ category: "managed" }),
		});
	});
	it.each(["socket", "boot", "hardware", "policy", "inventory"])(
		"publishes unavailable after failed %s evidence",
		async (fault) => {
			const f = observer();
			if (fault === "policy") {
				f.context.policy = structuredClone(f.policy);
				f.context.policy.host.serverName = "other";
			}
			if (fault === "inventory") f.ports.lxd.inspectHostInventory.mockRejectedValue(new Error("SECRET"));
			if (["socket", "boot", "hardware"].includes(fault))
				f.ports.host.mockResolvedValueOnce(structuredClone(f.host)).mockImplementation(async () => {
					const h = structuredClone(f.host);
					if (fault === "socket") h.socket.ino++;
					if (fault === "boot") h.bootId = randomUUID();
					if (fault === "hardware") h.cpuMillis++;
					return h;
				});
			expect((await f.observer.observe(signal())).state).toBe("unavailable");
			expect(f.calls.at(-1)?.method).toBe("qorpera_observe_runtime_node");
			expect(JSON.stringify(f.calls)).not.toContain("SECRET");
		},
	);
	it("publishes unknown machines without dropping them or claiming a ready host", async () => {
		const f = observer();
		delete f.inventory.instances[0].config["user.qorpera.schema"];
		expect((await f.observer.observe(signal())).state).toBe("unavailable");
		expect(f.calls.at(-1)?.args.p_inventory).toMatchObject({
			entries: [{ category: "unmanaged" }, { category: "managed" }, { category: "managed" }],
		});
	});
	it("does not rebind an uncertain publication or retry it with new bytes", async () => {
		const f = observer((method) => {
			if (method === "qorpera_observe_runtime_node_inventory") throw new Error("PRIVATE RESPONSE");
		});
		await expect(f.observer.observe(signal())).rejects.toThrow(/^NODE_OBSERVER_UNCONFIRMED$/);
		expect(f.calls).toHaveLength(2);
	});
	it("holds the observation slot until cancelled host IO actually settles", async () => {
		const f = observer(),
			controller = new AbortController();
		let settle!: () => void;
		f.ports.host.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					settle = () => resolve(f.host);
				}),
		);
		const first = f.observer.observe(controller.signal),
			assertion = expect(first).rejects.toThrow("UNCONFIRMED");
		controller.abort();
		await expect(f.observer.observe(signal())).rejects.toThrow("BUSY");
		expect(f.calls).toHaveLength(0);
		settle();
		await assertion;
		expect((await f.observer.observe(signal())).state).toBe("ready");
	});
});
