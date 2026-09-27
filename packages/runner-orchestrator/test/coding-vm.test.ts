import { describe, expect, it } from "vitest";
import { assertLxdCodingVmInstance, type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import { codingStorageFixture } from "./helpers/coding-storage.ts";

// A kept per-session VM from before per-member machines: only its binding and
// identity remain in use, to retire it (its journal: coding-machine.test.ts).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function binding(): LxdCodingVmBinding {
	return {
		schema: "qorpera.lxd-coding-vm/v2",
		storage: codingStorageFixture({ workerId: id(1), companyId: id(3), environmentId: id(4) }),
		workerId: id(1),
		allocationId: id(2),
		companyId: id(3),
		environmentId: id(4),
		providerId: "native-node",
		providerPolicySha256: "a".repeat(64),
		repository: { host: "github.com", owner: "qorpera", name: "project", baseBranch: "main" },
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding-disks",
		network: "coding-net",
		cpus: 2,
		memoryBytes: 4096 * 1024 ** 2,
		rootDiskBytes: 64 * 1024 ** 3,
	};
}
describe("a kept per-session coding VM's binding", () => {
	it("pins repository, branch, resources, NAS mounts and image without inherited profiles or identity mounts", () => {
		const plan = lxdCodingVmPlan(binding());
		expect(plan.request.profiles).toEqual([]);
		expect(Object.keys(plan.request.devices).sort()).toEqual(["custody", "data", "network", "root"]);
		expect(plan.request.name).toBe(`qorpera-coding-${id(1).replaceAll("-", "")}`);
		expect(plan.request.config["user.qorpera.branch"]).toBe(`qorpera/coding/${id(1)}`);
		expect(plan.request.config["boot.autostart"]).toBe("false");
		expect(
			lxdCodingVmPlan({ ...binding(), repository: { ...binding().repository, name: "other" } }).instanceSha256,
		).not.toBe(plan.instanceSha256);
	});
	it.each([
		{ profiles: ["default"] },
		{ imageFingerprint: "latest" },
		{ cpus: 65 },
		{ network: "../other" },
		{ workerId: "bad" },
		{ rootDiskBytes: Infinity },
		{ computeIdentityPath: "/secret" },
	])("rejects inadmissible binding %j", (patch) => {
		expect(() => lxdCodingVmPlan({ ...binding(), ...patch })).toThrow("INVALID_CODING_VM_BINDING");
	});
	it("recognizes only its exact instance", () => {
		const plan = lxdCodingVmPlan(binding());
		const instance = {
			name: plan.request.name,
			type: "virtual-machine" as const,
			status: "Stopped",
			statusCode: 102,
			profiles: [],
			devices: structuredClone(plan.request.devices),
			expandedDevices: structuredClone(plan.request.devices),
			config: { ...plan.request.config, "volatile.base_image": binding().imageFingerprint },
			expandedConfig: { ...plan.request.config, "volatile.base_image": binding().imageFingerprint },
		};
		expect(() => assertLxdCodingVmInstance(binding(), instance)).not.toThrow();
		expect(() =>
			assertLxdCodingVmInstance(binding(), {
				...instance,
				expandedDevices: {
					...instance.expandedDevices,
					secret: { type: "disk", source: "/secret", path: "/secret" },
				},
			}),
		).toThrow("CODING_VM_DRIFTED");
	});
});
