import { isDeepStrictEqual } from "node:util";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { assertLxdOfficePhysicalBinding, type LxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { type RuntimeNodeRegistry, reserveRuntimeNodeMachine } from "./runtime-node-admission.ts";

export function reserveLxdOfficeNodeMachine(
	policy: LxdOfficePhysicalPolicy,
	binding: LxdOfficeGuestBinding,
	registry: RuntimeNodeRegistry,
	signal: AbortSignal,
) {
	assertLxdOfficePhysicalBinding(policy, binding);
	const plan = lxdOfficeGuestPlan(binding);
	return reserveRuntimeNodeMachine(
		{
			allocationId: binding.allocationId,
			providerKind: "office",
			providerId: binding.providerId,
			policySha256: binding.providerPolicySha256,
			instanceSha256: plan.instanceSha256,
			machineIdSha256: policy.host.machineIdSha256,
			cpuMillis: binding.cpus * 1000,
			memoryBytes: binding.memoryBytes,
		},
		registry,
		signal,
	);
}

export interface LxdOfficeNodeSuspensionRegistry {
	call(
		method: "qorpera_suspend_runtime_node_machine",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export type LxdOfficeNodeSuspension =
	| { state: "suspended" }
	| { state: "kept"; reason: "NOT_RESERVED" | "RESUME_PENDING" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** After a confirmed stop of an explicit power-off, the computer's node demand
 * is suspended: the slot is free for other machines until resume re-admits it
 * through the ordinary reservation. SQL keeps the slot when a resume was already
 * requested. Anything but an exact receipt is unconfirmed. */
export async function suspendLxdOfficeNodeMachine(
	policy: LxdOfficePhysicalPolicy,
	binding: LxdOfficeGuestBinding,
	transitionId: string,
	registry: LxdOfficeNodeSuspensionRegistry,
	signal: AbortSignal,
): Promise<LxdOfficeNodeSuspension> {
	assertLxdOfficePhysicalBinding(policy, binding);
	if (!UUID.test(transitionId)) throw new Error("NODE_SUSPENSION_INVALID");
	const result = await registry.call(
		"qorpera_suspend_runtime_node_machine",
		{
			p_allocation_id: binding.allocationId,
			p_provider_id: binding.providerId,
			p_policy_sha256: binding.providerPolicySha256,
			p_instance_sha256: lxdOfficeGuestPlan(binding).instanceSha256,
			p_machine_id_sha256: policy.host.machineIdSha256,
			p_transition_id: transitionId,
		},
		signal,
	);
	signal.throwIfAborted();
	for (const reason of ["NOT_RESERVED", "RESUME_PENDING"] as const)
		if (isDeepStrictEqual(result, { state: "kept", reason })) return { state: "kept", reason };
	const receipt = result as Record<string, unknown> | null;
	if (
		receipt === null ||
		typeof receipt !== "object" ||
		Array.isArray(receipt) ||
		Object.keys(receipt).sort().join() !== "allocationId,nodeId,state,suspendedAt" ||
		receipt.state !== "suspended" ||
		receipt.allocationId !== binding.allocationId ||
		typeof receipt.nodeId !== "string" ||
		!UUID.test(receipt.nodeId) ||
		typeof receipt.suspendedAt !== "string" ||
		!Number.isFinite(Date.parse(receipt.suspendedAt))
	)
		throw new Error("NODE_SUSPENSION_UNCONFIRMED");
	return { state: "suspended" };
}
