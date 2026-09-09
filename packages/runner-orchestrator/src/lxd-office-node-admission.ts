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
