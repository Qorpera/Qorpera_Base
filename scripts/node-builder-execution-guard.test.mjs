import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { reconcileRuntimeNodeInventory, runtimeNodeInstanceConfigurationSha256 } from "../packages/runner-orchestrator/src/runtime-node-inventory.ts";
import { verifyNodeBuilderExecution } from "./node-builder-execution-guard.mjs";

function fixture() {
	const now = Date.now(), sha = "a".repeat(64), nodeId = randomUUID(), hostBootId = randomUUID();
	const config = { "limits.cpu": "4", "limits.memory": "8GiB", "volatile.uuid": randomUUID(), "boot.autostart": "false", "user.image-build-purpose": "runtime-sep21" };
	const vm = { project: "qorpera-native-image-sep21", name: "qorpera-native-image-build-sep21-a1", type: "virtual-machine", location: "none", status: "Stopped", statusCode: 102,
		config, expandedConfig: { ...config }, devices: {}, expandedDevices: {}, profiles: [] };
	const builder = { project: vm.project, name: vm.name, physicalId: config["volatile.uuid"], type: vm.type, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3,
		configurationSha256: runtimeNodeInstanceConfigurationSha256(vm) };
	const inventoryPolicy = { schema: "qorpera.runtime-node-inventory-policy/v1", nodeId,
		host: { machineIdSha256: sha, socketPath: "/var/snap/lxd/common/lxd/unix.socket", socketGid: 101, certificateSha256: sha, serverName: "company41-node-02", serverVersion: "6.9", architecture: "x86_64" },
		operatingCpuMillis: 8000, operatingMemoryBytes: 24 * 1024 ** 3, infrastructure: [builder] };
	const inventory = { server: { project: "default", certificateSha256: sha, serverName: "company41-node-02", serverVersion: "6.9", architecture: "x86_64" }, instances: [vm] };
	const context = { policy: inventoryPolicy, nodeVersion: 11, contextSha256: sha, headroomCpuMillis: 12000, headroomMemoryBytes: 62952345600, allocations: [] };
	const contract = { schema: "qorpera.node-builder-execution-contract/v1", nodeId, nodeVersion: 11, hostBootId, inventoryPolicy, inventoryPolicySha256: "b".repeat(64), observerConfigSha256: "c".repeat(64), builder };
	const authority = { schema: "qorpera.node-builder-execution-authority/v1", readAt: new Date(now - 1000).toISOString(), nodeEnabled: true, nodeVersion: 11, inventoryReady: true,
		policySha256: contract.inventoryPolicySha256, observerConfigSha256: contract.observerConfigSha256, context,
		observation: { observationId: randomUUID(), observedAt: new Date(now - 10000).toISOString(), state: "ready", nodeVersion: 11,
			policySha256: contract.inventoryPolicySha256, bootId: hostBootId, entries: reconcileRuntimeNodeInventory(inventory, context).entries } };
	return { contract, authority, inventory, now };
}

test("enabled admission requires exact enrolled builder and fresh complete observations", () => {
	const f = fixture();
	const admitted = verifyNodeBuilderExecution(f.contract, f.authority, f.inventory, f.now);
	assert.equal(admitted.instanceUuid, f.contract.builder.physicalId);
	assert.equal(Date.parse(admitted.validUntil), Date.parse(f.authority.readAt) + 5000);
	f.inventory.instances[0].status = "Running"; f.inventory.instances[0].statusCode = 103;
	assert.equal(verifyNodeBuilderExecution(f.contract, f.authority, f.inventory, f.now).nodeVersion, 11);
});

for (const fault of ["expired-read", "expired-observation", "future-read", "disabled", "not-ready", "version", "policy", "observer-config", "boot", "missing-builder", "unregistered", "changed-config", "unknown-vm", "insufficient-headroom", "observation-omits-builder", "observation-undercharges"]) {
	test(`enabled mode refuses ${fault}`, () => {
		const f = fixture(), a = f.authority, i = f.inventory.instances[0];
		if (fault === "expired-read") a.readAt = new Date(f.now - 5000).toISOString();
		if (fault === "expired-observation") a.observation.observedAt = new Date(f.now - 60000).toISOString();
		if (fault === "future-read") a.readAt = new Date(f.now + 1).toISOString();
		if (fault === "disabled") a.nodeEnabled = false;
		if (fault === "not-ready") a.inventoryReady = false;
		if (fault === "version") a.context.nodeVersion++;
		if (fault === "policy") a.policySha256 = "d".repeat(64);
		if (fault === "observer-config") a.observerConfigSha256 = "d".repeat(64);
		if (fault === "boot") a.observation.bootId = randomUUID();
		if (fault === "missing-builder") f.inventory.instances = [];
		if (fault === "unregistered") { a.context.policy = structuredClone(a.context.policy); a.context.policy.infrastructure = []; }
		if (fault === "changed-config") i.expandedDevices.extra = { type: "disk", source: "/company" };
		if (fault === "unknown-vm") { const other = structuredClone(i); other.name = "unknown"; other.config["volatile.uuid"] = other.expandedConfig["volatile.uuid"] = randomUUID(); f.inventory.instances.push(other); }
		if (fault === "insufficient-headroom") a.context.headroomCpuMillis = 8000;
		if (fault === "observation-omits-builder") a.observation.entries = [];
		if (fault === "observation-undercharges") a.observation.entries[0].cpuMillis = 1000;
		assert.throws(() => verifyNodeBuilderExecution(f.contract, a, f.inventory, f.now));
	});
}
