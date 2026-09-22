import { isDeepStrictEqual } from "node:util";
import {
	parseRuntimeNodeInventoryContext,
	parseRuntimeNodeInventoryPolicy,
	reconcileRuntimeNodeInventory,
} from "../packages/runner-orchestrator/src/runtime-node-inventory.ts";
import { officeRecord, officeSha } from "../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";

/** Offline proposal only. Reviewed pins are inputs, never inferred authority
 * from a VM name, public marker, or current observation. The ordinary observer
 * and SQL enrollment remain the authority after the operator applies a plan. */
export function planNodeBuilderInventory(value) {
	const input = officeRecord(value, ["context", "inventory", "previousPolicySha256", "builders"]);
	const context = parseRuntimeNodeInventoryContext(input.context);
	const previousPolicySha256 = officeSha(input.previousPolicySha256);
	if (!Array.isArray(input.builders) || input.builders.length === 0 || input.builders.length > 2)
		throw new Error("BUILDER_INVENTORY_EXPECTS_ONE_OR_TWO_BUILDERS");
	const policy = parseRuntimeNodeInventoryPolicy({
		...context.policy,
		infrastructure: [...context.policy.infrastructure, ...input.builders],
	});
	const builders = policy.infrastructure.slice(context.policy.infrastructure.length);
	if (builders.some((builder) => builder.type !== "virtual-machine"))
		throw new Error("BUILDER_INVENTORY_REQUIRES_VM");
	const before = reconcileRuntimeNodeInventory(input.inventory, context);
	const after = reconcileRuntimeNodeInventory(input.inventory, { ...context, policy });
	if (!after.headroomValid) throw new Error("BUILDER_INVENTORY_HEADROOM_EXCEEDED");
	for (const builder of builders) {
		const entry = after.entries.find((entry) => entry.project === builder.project && entry.name === builder.name);
		if (!entry || entry.category !== "infrastructure" || entry.reason !== null)
			throw new Error("BUILDER_INVENTORY_PIN_DIFFERS");
		// Frozen is also projected as suspended: require the original stopped
		// state, rather than authorizing a process still running in a frozen VM.
		const instance = input.inventory.instances.find(
			(instance) => instance.project === builder.project && instance.name === builder.name,
		);
		if (instance.status !== "Stopped" || instance.statusCode !== 102)
			throw new Error("BUILDER_INVENTORY_REQUIRES_STOPPED_VM");
		if (instance.config["boot.autostart"] !== "false" || instance.expandedConfig["boot.autostart"] !== "false")
			throw new Error("BUILDER_INVENTORY_AUTOSTART_REFUSED");
		if (Object.keys(instance.config).concat(Object.keys(instance.expandedConfig)).some((key) => key.startsWith("user.qorpera.")))
			throw new Error("BUILDER_INVENTORY_RUNTIME_METADATA_REFUSED");
		// A reviewed builder cannot displace an existing allocation's physical
		// binding, even when that allocation's VM is absent from the scan.
		if (context.allocations.some((allocation) => allocation.physical && (
			allocation.physical.physicalId === builder.physicalId ||
			(allocation.physical.project === builder.project && allocation.physical.name === builder.name)
		))) throw new Error("BUILDER_INVENTORY_ALLOCATION_COLLISION");
	}
	if (after.state !== "ready") throw new Error("BUILDER_INVENTORY_OTHER_INSTANCE_UNAVAILABLE");
	const retainedBefore = before.entries.filter((entry) => !builders.some(
		(builder) => builder.project === entry.project && builder.name === entry.name,
	));
	const retainedAfter = after.entries.filter((entry) => !builders.some(
		(builder) => builder.project === entry.project && builder.name === entry.name,
	));
	if (!isDeepStrictEqual(retainedBefore, retainedAfter)) throw new Error("BUILDER_INVENTORY_EXISTING_AUTHORITY_CHANGED");
	const requiredCpuMillis = policy.operatingCpuMillis + policy.infrastructure.reduce((sum, item) => sum + item.cpuMillis, 0);
	const requiredMemoryBytes = policy.operatingMemoryBytes + policy.infrastructure.reduce((sum, item) => sum + item.memoryBytes, 0);
	return {
		schema: "qorpera.node-builder-inventory-plan/v1",
		reviewOnly: true,
		nodeId: policy.nodeId,
		expectedNodeVersion: context.nodeVersion,
		expectedContextSha256: context.contextSha256,
		previousPolicy: context.policy,
		replacement: {
			method: "qorpera_replace_runtime_node_inventory",
			args: { p_policy: policy, p_previous_sha256: previousPolicySha256 },
		},
		budget: {
			headroomCpuMillis: context.headroomCpuMillis,
			headroomMemoryBytes: context.headroomMemoryBytes,
			requiredCpuMillis,
			requiredMemoryBytes,
			remainingCpuMillis: context.headroomCpuMillis - requiredCpuMillis,
			remainingMemoryBytes: context.headroomMemoryBytes - requiredMemoryBytes,
		},
		builders,
	};
}
