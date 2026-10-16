import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { reconcileRuntimeNodeInventory, runtimeNodeInstanceConfigurationSha256 } from "../packages/runner-orchestrator/src/runtime-node-inventory.ts";
import { planNodeBuilderInventory } from "./node-builder-inventory-plan.mjs";

function fixture() {
	const sha = "a".repeat(64), nodeId = randomUUID();
	const policy = { schema: "qorpera.runtime-node-inventory-policy/v1", nodeId,
		host: { machineIdSha256: sha, socketPath: "/var/snap/lxd/common/lxd/unix.socket", socketGid: 2000,
			certificateSha256: sha, serverName: "fixture-node", serverVersion: "6.9", architecture: "x86_64" },
		operatingCpuMillis: 2000, operatingMemoryBytes: 8 * 1024 ** 3, infrastructure: [] };
	const config = { "limits.cpu": "4", "limits.memory": "8GiB", "volatile.uuid": randomUUID(),
		"boot.autostart": "false", "user.image-build-purpose": "reviewed-native-image", "cloud-init.user-data": "PRIVATE-BUILD-DATA" };
	const builder = { project: "image-build", name: "reviewed-builder", type: "virtual-machine", location: "none",
		status: "Stopped", statusCode: 102, config, expandedConfig: { ...config }, profiles: [], devices: {}, expandedDevices: {} };
	const pin = { project: builder.project, name: builder.name, physicalId: config["volatile.uuid"], type: builder.type,
		configurationSha256: runtimeNodeInstanceConfigurationSha256(builder), cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
	const context = { policy, nodeVersion: 22, contextSha256: sha, headroomCpuMillis: 8000,
		headroomMemoryBytes: 32 * 1024 ** 3, allocations: [] };
	const inventory = { server: { project: "default", certificateSha256: sha, serverName: "fixture-node", serverVersion: "6.9", architecture: "x86_64" }, instances: [builder] };
	return { context, inventory, previousPolicySha256: "b".repeat(64), builders: [pin] };
}

test("reviewed builder stops poisoning complete inventory without hiding or discounting it", () => {
	const f = fixture(), unchanged = structuredClone(f);
	assert.equal(reconcileRuntimeNodeInventory(f.inventory, f.context).state, "unavailable");
	const plan = planNodeBuilderInventory(f);
	assert.deepEqual(f, unchanged);
	const context = { ...f.context, policy: plan.replacement.args.p_policy };
	for (const [status, statusCode] of [["Stopped", 102], ["Running", 103]]) {
		f.inventory.instances[0].status = status; f.inventory.instances[0].statusCode = statusCode;
		const result = reconcileRuntimeNodeInventory(f.inventory, context);
		assert.equal(result.state, "ready");
		assert.equal(result.entries[0].category, "infrastructure");
		assert.equal(result.entries[0].cpuMillis, 4000);
	}
	assert.equal(plan.budget.requiredCpuMillis, 6000);
	assert.equal(plan.budget.requiredMemoryBytes, 16 * 1024 ** 3);
	assert.equal(plan.replacement.args.p_previous_sha256, f.previousPolicySha256);
	assert.equal(plan.expectedContextSha256, f.context.contextSha256);
	assert.equal(JSON.stringify(plan).includes("PRIVATE-BUILD-DATA"), false);
	// Absence never refunds infrastructure: the same reservation still has to fit.
	f.inventory.instances = [];
	assert.equal(reconcileRuntimeNodeInventory(f.inventory, { ...context, headroomCpuMillis: 5000 }).state, "unavailable");
});

for (const fault of ["uuid", "configuration", "cost", "unknown", "runtime-tag", "autostart", "running", "frozen", "missing", "headroom", "duplicate", "allocation-collision"]) {
	test(`refuses builder enrollment with ${fault}`, () => {
		const f = fixture(), i = f.inventory.instances[0];
		if (fault === "uuid") i.config["volatile.uuid"] = i.expandedConfig["volatile.uuid"] = randomUUID();
		if (fault === "configuration") i.expandedDevices.extra = { type: "disk", source: "/company" };
		if (fault === "cost") f.builders[0].cpuMillis = 1000;
		if (fault === "unknown") {
			const unknown = structuredClone(i); unknown.name = "other";
			unknown.config["volatile.uuid"] = unknown.expandedConfig["volatile.uuid"] = randomUUID();
			f.inventory.instances.push(unknown);
		}
		if (fault === "runtime-tag") {
			i.config["user.qorpera.purpose"] = i.expandedConfig["user.qorpera.purpose"] = "builder";
			f.builders[0].configurationSha256 = runtimeNodeInstanceConfigurationSha256(i);
		}
		if (fault === "autostart") {
			i.config["boot.autostart"] = i.expandedConfig["boot.autostart"] = "true";
			f.builders[0].configurationSha256 = runtimeNodeInstanceConfigurationSha256(i);
		}
		if (fault === "running") { i.status = "Running"; i.statusCode = 103; }
		if (fault === "frozen") { i.status = "Frozen"; i.statusCode = 110; }
		if (fault === "missing") f.inventory.instances = [];
		if (fault === "headroom") f.context.headroomMemoryBytes = 12 * 1024 ** 3;
		if (fault === "duplicate") f.builders.push(structuredClone(f.builders[0]));
		if (fault === "allocation-collision") f.context.allocations.push({ allocationId: randomUUID(), providerKind: "office", providerId: randomUUID(),
			policySha256: "a".repeat(64), instanceSha256: "c".repeat(64), cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3,
			physical: { project: i.project, name: i.name, physicalId: f.builders[0].physicalId, configurationSha256: f.builders[0].configurationSha256 } });
		assert.throws(() => planNodeBuilderInventory(f));
	});
}

test("later builder substitution/configuration drift still fences the node", () => {
	for (const fault of ["uuid", "limits", "device", "marker"]) {
		const f = fixture(), plan = planNodeBuilderInventory(f), i = f.inventory.instances[0];
		if (fault === "uuid") i.config["volatile.uuid"] = i.expandedConfig["volatile.uuid"] = randomUUID();
		if (fault === "limits") i.config["limits.cpu"] = i.expandedConfig["limits.cpu"] = "8";
		if (fault === "device") i.expandedDevices.extra = { type: "disk", source: "/credentials" };
		if (fault === "marker") i.config["user.qorpera.schema"] = i.expandedConfig["user.qorpera.schema"] = "qorpera.native-job-vm/v1";
		assert.equal(reconcileRuntimeNodeInventory(f.inventory, { ...f.context, policy: plan.replacement.args.p_policy }).state, "unavailable");
	}
});

test("retains existing managed office identity, reservation and projected state", () => {
	const f = fixture(), i = structuredClone(f.inventory.instances[0]);
	i.project = "company"; i.name = "existing-office";
	const allocationId = randomUUID(), providerId = randomUUID();
	i.config = { "volatile.uuid": randomUUID(), "limits.cpu": "8", "limits.memory": "16GiB",
		"user.qorpera.schema": "qorpera.lxd-office-guest/v2", "user.qorpera.allocation_id": allocationId,
		"user.qorpera.provider_id": providerId, "user.qorpera.provider_policy_sha256": "d".repeat(64),
		"user.qorpera.instance_sha256": "e".repeat(64) };
	i.expandedConfig = { ...i.config };
	f.inventory.instances.push(i);
	f.context.allocations.push({ allocationId, providerKind: "office", providerId, policySha256: "d".repeat(64),
		instanceSha256: "e".repeat(64), cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3,
		physical: { project: i.project, name: i.name, physicalId: i.config["volatile.uuid"], configurationSha256: runtimeNodeInstanceConfigurationSha256(i) } });
	const before = reconcileRuntimeNodeInventory(f.inventory, f.context), plan = planNodeBuilderInventory(f);
	const after = reconcileRuntimeNodeInventory(f.inventory, { ...f.context, policy: plan.replacement.args.p_policy });
	assert.equal(after.state, "ready");
	assert.deepEqual(after.entries[1], before.entries[1]);
	assert.equal(after.entries[1].allocation.allocationId, allocationId);
	assert.equal(after.entries[1].state, "suspended");
	assert.equal(plan.budget.requiredCpuMillis, 6000, "office stays charged in its ledger, not infrastructure headroom");
});

test("the printed budget includes a declared build space", () => {
	const f = fixture();
	f.context.policy = { ...f.context.policy, buildSpace: { project: "qorpera-build", network: "qorpera0", cpuMillis: 1000, memoryBytes: 1024 ** 3 } };
	f.context.headroomCpuMillis = 9000;
	f.context.headroomMemoryBytes = 33 * 1024 ** 3;
	const plan = planNodeBuilderInventory(f);
	assert.equal(plan.budget.requiredCpuMillis, 7000);
	assert.equal(plan.budget.requiredMemoryBytes, 17 * 1024 ** 3);
	assert.equal(plan.budget.remainingCpuMillis, 2000);
});

test("the printed budget includes the code hosts", () => {
	const f = fixture();
	f.context.policy = { ...f.context.policy, codeHosts: { imageFingerprint: "c".repeat(64), storagePool: "default", cpus: 2,
		memoryBytes: 4 * 1024 ** 3, rootDiskBytes: 20 * 1024 ** 3, running: 2 } };
	f.context.headroomCpuMillis = 11000;
	f.context.headroomMemoryBytes = 33 * 1024 ** 3;
	const plan = planNodeBuilderInventory(f);
	assert.equal(plan.budget.requiredCpuMillis, 10000);
	assert.equal(plan.budget.requiredMemoryBytes, 24 * 1024 ** 3);
	assert.equal(plan.budget.remainingCpuMillis, 1000);
});
