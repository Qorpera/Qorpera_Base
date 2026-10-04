import { randomUUID } from "node:crypto";
import {
	type CodingMachineStorage,
	type LxdCodingMachineBinding,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
} from "../../src/coding-machine.ts";
import type { LxdInstanceRecord } from "../../src/lxd-client.ts";

/** The MAC a test machine's agent card carries (as the agent plug gives it). */
export const testAgentMac = "0e:51:0a:d2:01:01";
/** A fake agent plug: every machine gets testAgentMac. */
export const testAgentPlug = async (): Promise<string> => testAgentMac;

export const codingMachineStorage: CodingMachineStorage = Object.freeze({
	policy: {
		schema: "qorpera.coding-nas-policy/v1" as const,
		mountPoint: "/mnt/coding",
		source: "10.0.0.2:/coding",
		serverAddress: "10.0.0.2",
		rootPath: "/mnt/coding",
	},
	machineIdSha256: "d".repeat(64),
});
export function codingMachineFixture(scope: Partial<LxdCodingMachineBinding> = {}): LxdCodingMachineBinding {
	return {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: randomUUID(),
		companyId: randomUUID(),
		environmentId: randomUUID(),
		memberUserId: randomUUID(),
		providerId: "coding",
		providerPolicySha256: "a".repeat(64),
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding",
		network: "qagent0",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
		rootDiskBytes: 32 * 1024 ** 3,
		...scope,
	};
}
/** The machine's instance as LXD reports it, running, with these sessions' folders attached. */
export function codingMachineInstance(
	machine: LxdCodingMachineBinding,
	sessions: readonly string[],
): LxdInstanceRecord {
	const plan = lxdCodingMachinePlan(machine);
	const devices = {
		...plan.request.devices,
		network: { ...plan.request.devices.network, hwaddr: testAgentMac },
		...Object.assign(
			{},
			...sessions.map((workerId) =>
				lxdCodingSessionDevices(lxdCodingSessionStorage(machine, codingMachineStorage, workerId)),
			),
		),
	};
	return {
		name: plan.request.name,
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		profiles: [],
		config: { ...plan.request.config, "volatile.base_image": machine.imageFingerprint },
		expandedConfig: { ...plan.request.config, "volatile.base_image": machine.imageFingerprint },
		devices,
		expandedDevices: structuredClone(devices),
	};
}
