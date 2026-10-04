import { describe, expect, it } from "vitest";
import { agentPlugCard, withAgentPlug } from "../src/agent-plug.ts";
import {
	assertLxdCompanyMachineInstance,
	type LxdCompanyMachineBinding,
	lxdCompanyMachineJournalPlan,
	lxdCompanyMachinePlan,
	parseCompanyMachinePolicy,
} from "../src/company-machine.ts";
import type { LxdInstanceRecord } from "../src/lxd-client.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const storage = {
	policy: {
		schema: "qorpera.coding-nas-policy/v1" as const,
		mountPoint: "/nas",
		rootPath: "/nas/coding",
		source: "10.0.0.2:/coding",
		serverAddress: "10.0.0.2",
	},
	machineIdSha256: "d".repeat(64),
};
function companyMachineBinding(overrides: Partial<LxdCompanyMachineBinding> = {}): LxdCompanyMachineBinding {
	return {
		schema: "qorpera.lxd-company-machine/v1",
		machineId: id(2),
		placementId: id(5),
		companyId: id(3),
		environmentId: id(4),
		providerId: "machine-node",
		providerPolicySha256: "a".repeat(64),
		project: "machines",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "machines",
		network: "qagent0",
		cpus: 8,
		memoryBytes: 32 * 1024 ** 3,
		rootDiskBytes: 100 * 1024 ** 3,
		repositoryWorkerId: null,
		...overrides,
	};
}
/** The instance LXD made from the request the agent plug completed. */
function instance(planned: ReturnType<typeof lxdCompanyMachinePlan>["request"]): LxdInstanceRecord {
	const request = withAgentPlug(planned, "network", "0e:51:0a:d2:01:07");
	return {
		name: request.name,
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		profiles: [],
		devices: structuredClone(request.devices),
		expandedDevices: structuredClone(request.devices),
		config: { ...request.config, "volatile.base_image": "b".repeat(64), "image.os": "ubuntu" },
		expandedConfig: { ...request.config, "volatile.base_image": "b".repeat(64), "image.os": "ubuntu" },
	};
}

describe("company machine plan", () => {
	it("hashes the canonical binding text SQL pins (qorpera_company_machine_binding_text)", () => {
		const plan = lxdCompanyMachinePlan(companyMachineBinding());
		// The same text supabase/tests/628 asserts for this binding.
		expect(plan.text).toBe(
			`{"schema":"qorpera.lxd-company-machine/v1","machineId":"${id(2)}","placementId":"${id(5)}","companyId":"${id(3)}","environmentId":"${id(4)}",` +
				`"providerId":"machine-node","providerPolicySha256":"${"a".repeat(64)}","project":"machines","imageFingerprint":"${"b".repeat(64)}",` +
				`"bootstrapSha256":"${"c".repeat(64)}","storagePool":"machines","network":"qagent0","cpus":8,"memoryBytes":34359738368,` +
				`"rootDiskBytes":107374182400,"repositoryWorkerId":null}`,
		);
		// Key order in the input never changes the text.
		const shuffled = Object.fromEntries(
			Object.entries(companyMachineBinding()).reverse(),
		) as unknown as LxdCompanyMachineBinding;
		expect(lxdCompanyMachinePlan(shuffled).instanceSha256).toBe(plan.instanceSha256);
	});

	it("creates exactly the placement SQL made: its size, its markers, its network and nothing else", () => {
		const { request, instanceSha256 } = lxdCompanyMachinePlan(companyMachineBinding());
		expect(request).toEqual({
			name: "qorpera-machine-00000000000040008000000000000005",
			type: "virtual-machine",
			profiles: [],
			source: { type: "image", fingerprint: "b".repeat(64) },
			config: {
				"boot.mode": "uefi-secureboot",
				"boot.autostart": "false",
				"limits.cpu": "8",
				"limits.memory": "34359738368",
				"user.qorpera.schema": "qorpera.lxd-company-machine/v1",
				"user.qorpera.machine_id": id(2),
				"user.qorpera.placement_id": id(5),
				"user.qorpera.allocation_id": id(5),
				"user.qorpera.company_id": id(3),
				"user.qorpera.environment_id": id(4),
				"user.qorpera.provider_id": "machine-node",
				"user.qorpera.instance_sha256": instanceSha256,
				"user.qorpera.provider_policy_sha256": "a".repeat(64),
				"user.qorpera.bootstrap_sha256": "c".repeat(64),
			},
			devices: {
				root: { type: "disk", path: "/", pool: "machines", size: "107374182400" },
				// On the agents' bridge; its MAC comes from the agent plug right before the create.
				network: agentPlugCard("eth0"),
			},
		});
	});

	it("attaches a coding session's repository read-only from this node's NAS", () => {
		const binding = companyMachineBinding({ repositoryWorkerId: id(9) });
		expect(() => lxdCompanyMachinePlan(binding)).toThrow("COMPANY_MACHINE_REPOSITORY_UNAVAILABLE");
		expect(lxdCompanyMachinePlan(binding, storage).request.devices.repository).toEqual({
			type: "disk",
			source: `/nas/coding/workers/${id(3)}/${id(4)}/${id(9)}/data/repository`,
			path: "/mnt/repository",
			readonly: "true",
			required: "true",
		});
	});

	it.each([
		{ cpus: 65 },
		{ cpus: 0 },
		{ memoryBytes: 512 * 1024 ** 2 },
		{ memoryBytes: 3.5 * 1024 ** 3 },
		{ rootDiskBytes: 5 * 1024 ** 3 },
		{ network: "Bad Net" },
		{ network: "machine-net" },
		{ imageFingerprint: "x" },
		{ repositoryWorkerId: "worker" },
		{ placementId: "placement" },
	])("refuses a binding outside its bounds: %o", (overrides) => {
		expect(() =>
			lxdCompanyMachinePlan(companyMachineBinding(overrides as Partial<LxdCompanyMachineBinding>), storage),
		).toThrow("INVALID_COMPANY_MACHINE");
	});

	it("journals and receipts the placement, not the machine: a new placement is a new instance", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding(), storage);
		expect([journal.machineId, journal.journalName, journal.name]).toEqual([
			id(5),
			id(5),
			"qorpera-machine-00000000000040008000000000000005",
		]);
		const moved = lxdCompanyMachineJournalPlan(companyMachineBinding({ placementId: id(6) }), storage);
		expect(moved.instanceSha256).not.toBe(journal.instanceSha256);
		expect(moved.name).not.toBe(journal.name);
	});

	it("refuses an instance anything was added to", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding(), storage);
		const request = journal.request!;
		expect(() => journal.assertInstance(instance(request))).not.toThrow();
		const extraDevice = instance(request);
		(extraDevice.devices as Record<string, Record<string, string>>).host = {
			type: "disk",
			source: "/",
			path: "/host",
		};
		expect(() => assertLxdCompanyMachineInstance(request, "b".repeat(64), extraDevice)).toThrow(
			"COMPANY_MACHINE_DRIFTED",
		);
		const extraConfig = instance(request);
		(extraConfig.config as Record<string, string>)["security.privileged"] = "true";
		expect(() => journal.assertInstance(extraConfig)).toThrow("COMPANY_MACHINE_DRIFTED");
		const otherImage = instance(request);
		(otherImage.expandedConfig as Record<string, string>)["volatile.base_image"] = "e".repeat(64);
		expect(() => journal.assertInstance(otherImage)).toThrow("COMPANY_MACHINE_DRIFTED");
		// Its agent card: a plug MAC, exactly the card's keys, on the agents' bridge.
		for (const card of [
			{ ...agentPlugCard("eth0") },
			{ ...agentPlugCard("eth0"), hwaddr: "00:16:3e:00:00:01" },
			{ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:00:07" },
			{ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:07", parent: "machine-net" },
			{ ...agentPlugCard("eth0"), hwaddr: "0e:51:0a:d2:01:07", "ipv4.address": "10.210.1.7" },
			{ type: "nic", network: "machine-net", name: "eth0" },
		]) {
			const other = instance(request);
			other.devices = { ...other.devices, network: card };
			other.expandedDevices = structuredClone(other.devices);
			expect(() => journal.assertInstance(other)).toThrow("COMPANY_MACHINE_DRIFTED");
		}
	});

	it("names its plug claim: the machine, its company and this placement's instance", () => {
		const journal = lxdCompanyMachineJournalPlan(companyMachineBinding(), storage);
		expect(journal.agentPlug).toEqual({
			claim: {
				kind: "machine",
				companyId: id(3),
				machineId: id(2),
				memberUserId: null,
				project: "machines",
				instance: "qorpera-machine-00000000000040008000000000000005",
			},
			device: "network",
		});
	});

	it("reads a node policy only in its closed shape", () => {
		const policy = {
			providerId: "machine-node",
			providerPolicySha256: "a".repeat(64),
			project: "machines",
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "machines",
			network: "qagent0",
		};
		expect(parseCompanyMachinePolicy(policy)).toEqual(policy);
		expect(() => parseCompanyMachinePolicy({ ...policy, network: "machine-net" })).toThrow(
			"INVALID_COMPANY_MACHINE_POLICY",
		);
		expect(() => parseCompanyMachinePolicy({ ...policy, cpus: 4 })).toThrow("INVALID_COMPANY_MACHINE_POLICY");
		expect(() => parseCompanyMachinePolicy({ ...policy, project: "../x" })).toThrow("INVALID_COMPANY_MACHINE_POLICY");
	});
});
