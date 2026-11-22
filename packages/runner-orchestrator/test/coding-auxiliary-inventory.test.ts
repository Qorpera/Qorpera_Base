import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentPlugCard } from "../src/agent-plug.ts";
import { CODING_MACHINE_BASE_CONFIG } from "../src/coding-machine.ts";
import { CODING_SNAPSHOT_BUILDER_SCHEMA } from "../src/coding-snapshots.ts";
import { CODING_STANDBY_SCHEMA } from "../src/coding-standby-pool.ts";
import type { LxdHostInventory, LxdHostInventoryInstance } from "../src/lxd-client.ts";
import {
	type CodingAuxiliaryPolicy,
	parseRuntimeNodeInventoryPolicy,
	reconcileRuntimeNodeInventory,
	runtimeNodeReserved,
} from "../src/runtime-node-inventory.ts";
import { RuntimeNodeInventoryObserver } from "../src/runtime-node-observer.ts";

const GIB = 1024 ** 3;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function makeAuxPolicy(overrides: Partial<CodingAuxiliaryPolicy> = {}): CodingAuxiliaryPolicy {
	return {
		project: "coding",
		storagePool: "coding-disks",
		cpus: 4,
		memoryBytes: 8 * GIB,
		rootDiskBytes: 64 * GIB,
		maxBuilders: 1,
		maxStandby: 2,
		...overrides,
	};
}

function makePolicy(aux?: CodingAuxiliaryPolicy) {
	return parseRuntimeNodeInventoryPolicy({
		schema: "qorpera.runtime-node-inventory-policy/v1",
		nodeId: randomUUID(),
		host: {
			machineIdSha256: SHA_A,
			socketPath: "/var/snap/lxd/common/lxd/unix.socket",
			socketGid: 120,
			certificateSha256: SHA_B,
			serverName: "node-01",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		operatingCpuMillis: 2000,
		operatingMemoryBytes: 4 * GIB,
		infrastructure: [],
		...(aux ? { codingAuxiliary: aux } : {}),
	});
}

function makeBuilderInstance(
	overrides: Partial<LxdHostInventoryInstance> = {},
	extraConfig: Record<string, string> = {},
	deviceOverrides?: Record<string, Record<string, string>>,
): LxdHostInventoryInstance {
	const buildId = randomUUID();
	const config: Record<string, string> = {
		...CODING_MACHINE_BASE_CONFIG,
		"limits.cpu": "4",
		"limits.memory": String(8 * GIB),
		"user.qorpera.schema": CODING_SNAPSHOT_BUILDER_SCHEMA,
		"user.qorpera.company_id": randomUUID(),
		"user.qorpera.machine_id": buildId,
		"user.qorpera.member_user_id": randomUUID(),
		"user.qorpera.owner": "coding-node-01",
		"user.qorpera.build_id": buildId,
		"user.qorpera.setup_digest": SHA_C,
		"volatile.uuid": randomUUID(),
		...extraConfig,
	};
	const devices: Record<string, Record<string, string>> = {
		root: { type: "disk", path: "/", pool: "coding-disks", size: String(64 * GIB) },
		network: { ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:02" },
		...deviceOverrides,
	};
	return {
		project: "coding",
		name: `qorpera-coding-snap-${buildId.replaceAll("-", "").slice(0, 24)}`,
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		location: "none",
		profiles: [],
		config,
		expandedConfig: { ...config },
		devices,
		expandedDevices: { ...devices },
		...overrides,
	};
}

function makeStandbyInstance(
	overrides: Partial<LxdHostInventoryInstance> = {},
	extraConfig: Record<string, string> = {},
	deviceOverrides?: Record<string, Record<string, string>>,
): LxdHostInventoryInstance {
	const config: Record<string, string> = {
		...CODING_MACHINE_BASE_CONFIG,
		"limits.cpu": "4",
		"limits.memory": String(8 * GIB),
		"user.qorpera.schema": CODING_STANDBY_SCHEMA,
		"user.qorpera.standby_image": SHA_C,
		"volatile.uuid": randomUUID(),
		...extraConfig,
	};
	const devices: Record<string, Record<string, string>> = {
		root: { type: "disk", path: "/", pool: "coding-disks", size: String(64 * GIB) },
		...deviceOverrides,
	};
	return {
		project: "coding",
		name: `qorpera-coding-standby-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
		type: "virtual-machine",
		status: "Stopped",
		statusCode: 102,
		location: "none",
		profiles: [],
		config,
		expandedConfig: { ...config },
		devices,
		expandedDevices: { ...devices },
		...overrides,
	};
}

function makeInventory(instances: LxdHostInventoryInstance[]): LxdHostInventory {
	return {
		server: {
			project: "default",
			certificateSha256: SHA_B,
			serverName: "node-01",
			serverVersion: "6.9",
			architecture: "x86_64",
		},
		instances,
	};
}

describe("codingAuxiliary node inventory and observer", () => {
	it("accepts a registered snapshot builder and stopped standby VMs and reserves builder headroom", async () => {
		const aux = makeAuxPolicy({ maxBuilders: 1, maxStandby: 2 });
		const policy = makePolicy(aux);
		expect(runtimeNodeReserved(policy)).toEqual({
			cpuMillis: 6000,
			memoryBytes: 12 * GIB,
		});

		const builder = makeBuilderInstance();
		const standbyA = makeStandbyInstance();
		const standbyB = makeStandbyInstance();
		const inventory = makeInventory([builder, standbyA, standbyB]);
		const context = {
			policy,
			nodeVersion: 1,
			contextSha256: SHA_A,
			headroomCpuMillis: 8000,
			headroomMemoryBytes: 16 * GIB,
			allocations: [],
		};

		const reconciled = reconcileRuntimeNodeInventory(inventory, context);
		expect(reconciled.state).toBe("ready");
		expect(reconciled.headroomValid).toBe(true);
		expect(reconciled.entries.map((entry) => [entry.category, entry.reason])).toEqual([
			["coding-snapshot-builder", null],
			["coding-standby", null],
			["coding-standby", null],
		]);

		let publishedMethod = "";
		let publishedArgs: Record<string, unknown> = {};
		const bootId = randomUUID();
		const observer = new RuntimeNodeInventoryObserver(
			policy,
			{
				call: async (method, args) => {
					if (method === "qorpera_runtime_node_inventory_context") return context;
					publishedMethod = method;
					publishedArgs = args;
					const obs = args.p_observation as Record<string, unknown>;
					return {
						nodeId: obs.nodeId,
						observationId: obs.observationId,
						observedAt: obs.observedAt,
					};
				},
			},
			{
				lxd: { inspectHostInventory: async () => inventory },
				host: async () => ({
					machineIdSha256: SHA_A,
					bootId,
					namespace: "mnt:[4026531840]",
					socket: { dev: 1, ino: 2, uid: 0, gid: 120, mode: 0o140660, nlink: 1 },
					cpuMillis: 16000,
					memoryBytes: 32 * GIB,
				}),
				healthRecord: async () => undefined,
			},
		);
		const result = await observer.observe(AbortSignal.timeout(5_000));
		expect(result.state).toBe("ready");
		expect(result.reason).toBeNull();
		expect(publishedMethod).toBe("qorpera_observe_runtime_node_inventory");
		expect((publishedArgs.p_observation as Record<string, unknown>).state).toBe("ready");
	});

	it("marks the node unavailable when codingAuxiliary is missing, headroom is insufficient, or limits are exceeded", () => {
		const builder = makeBuilderInstance();
		const standby = makeStandbyInstance();

		const noAuxPolicy = makePolicy(undefined);
		const noAux = reconcileRuntimeNodeInventory(makeInventory([builder, standby]), {
			policy: noAuxPolicy,
			nodeVersion: 1,
			contextSha256: SHA_A,
			headroomCpuMillis: 16000,
			headroomMemoryBytes: 32 * GIB,
			allocations: [],
		});
		expect(noAux.state).toBe("unavailable");
		expect(noAux.entries.every((e) => e.category === "unmanaged" && e.reason === "UNREGISTERED_INSTANCE")).toBe(true);

		const tightPolicy = makePolicy(makeAuxPolicy({ maxBuilders: 1, maxStandby: 1 }));
		const tight = reconcileRuntimeNodeInventory(makeInventory([builder]), {
			policy: tightPolicy,
			nodeVersion: 1,
			contextSha256: SHA_A,
			headroomCpuMillis: 4000,
			headroomMemoryBytes: 8 * GIB,
			allocations: [],
		});
		expect(tight.state).toBe("unavailable");
		expect(tight.headroomValid).toBe(false);

		const overBuilders = reconcileRuntimeNodeInventory(
			makeInventory([makeBuilderInstance(), makeBuilderInstance()]),
			{
				policy: tightPolicy,
				nodeVersion: 1,
				contextSha256: SHA_A,
				headroomCpuMillis: 16000,
				headroomMemoryBytes: 32 * GIB,
				allocations: [],
			},
		);
		expect(overBuilders.state).toBe("unavailable");
		expect(overBuilders.entries.every((e) => e.reason === "CODING_SNAPSHOT_BUILDER_SPACE_EXCEEDED")).toBe(true);

		const overStandby = reconcileRuntimeNodeInventory(makeInventory([makeStandbyInstance(), makeStandbyInstance()]), {
			policy: tightPolicy,
			nodeVersion: 1,
			contextSha256: SHA_A,
			headroomCpuMillis: 16000,
			headroomMemoryBytes: 32 * GIB,
			allocations: [],
		});
		expect(overStandby.state).toBe("unavailable");
		expect(overStandby.entries.every((e) => e.reason === "CODING_STANDBY_SPACE_EXCEEDED")).toBe(true);
	});

	it("rejects forbidden config keys (security.secureboot), running standby VMs, and non-agent-plug builder NICs", () => {
		const policy = makePolicy(makeAuxPolicy());
		const context = {
			policy,
			nodeVersion: 1,
			contextSha256: SHA_A,
			headroomCpuMillis: 16000,
			headroomMemoryBytes: 32 * GIB,
			allocations: [],
		};

		const badSecureboot = makeBuilderInstance({}, { "security.secureboot": "false" });
		expect(reconcileRuntimeNodeInventory(makeInventory([badSecureboot]), context).entries[0].reason).toBe(
			"INSTANCE_AUTHORITY_DIFFERS",
		);

		const badNic = makeBuilderInstance({}, {}, { network: { type: "nic", network: "lxdbr0" } });
		expect(reconcileRuntimeNodeInventory(makeInventory([badNic]), context).entries[0].reason).toBe(
			"INSTANCE_AUTHORITY_DIFFERS",
		);

		const runningStandby = makeStandbyInstance({ status: "Running", statusCode: 103 });
		expect(reconcileRuntimeNodeInventory(makeInventory([runningStandby]), context).entries[0].reason).toBe(
			"INSTANCE_AUTHORITY_DIFFERS",
		);

		const standbyWithNic = makeStandbyInstance(
			{},
			{},
			{ network: { ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:03" } },
		);
		expect(reconcileRuntimeNodeInventory(makeInventory([standbyWithNic]), context).entries[0].reason).toBe(
			"INSTANCE_AUTHORITY_DIFFERS",
		);
	});
});
