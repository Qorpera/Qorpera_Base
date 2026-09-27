import { isDeepStrictEqual } from "node:util";
import { officeRecord, officeSha } from "../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import { parseRuntimeNodeInventoryContext, parseRuntimeNodeInventoryPolicy, reconcileRuntimeNodeInventory } from "../packages/runner-orchestrator/src/runtime-node-inventory.ts";

/** Separate from creation admission. Only an already-created, exactly enrolled
 * builder can use this mode. Evidence must come from the protected operator's
 * fresh SQL read and local complete scan; this function grants no RPC rights. */
export function verifyNodeBuilderExecution(contractValue, authorityValue, inventory, now) {
	const contract = officeRecord(contractValue, ["schema", "nodeId", "nodeVersion", "hostBootId", "inventoryPolicy", "inventoryPolicySha256", "observerConfigSha256", "builder"]);
	if (contract.schema !== "qorpera.node-builder-execution-contract/v1") throw new Error("BUILDER_EXECUTION_CONTRACT_INVALID");
	const policy = parseRuntimeNodeInventoryPolicy(contract.inventoryPolicy);
	const authority = officeRecord(authorityValue, ["schema", "readAt", "nodeEnabled", "nodeVersion", "inventoryReady", "policySha256", "observerConfigSha256", "context", "observation"]);
	const context = parseRuntimeNodeInventoryContext(authority.context);
	const observation = officeRecord(authority.observation, ["observationId", "observedAt", "state", "nodeVersion", "policySha256", "bootId", "entries"]);
	const fresh = (at, limit) => typeof at === "string" && Number.isFinite(Date.parse(at)) && now - Date.parse(at) >= 0 && now - Date.parse(at) < limit;
	if (!Number.isSafeInteger(now) || authority.schema !== "qorpera.node-builder-execution-authority/v1" || !fresh(authority.readAt, 5000) || !fresh(observation.observedAt, 60000))
		throw new Error("BUILDER_EXECUTION_AUTHORITY_EXPIRED");
	if (authority.nodeEnabled !== true || authority.inventoryReady !== true || observation.state !== "ready")
		throw new Error("BUILDER_EXECUTION_NODE_UNAVAILABLE");
	if (policy.nodeId !== contract.nodeId || !Number.isSafeInteger(contract.nodeVersion) || contract.nodeVersion < 1 ||
		context.nodeVersion !== contract.nodeVersion || authority.nodeVersion !== contract.nodeVersion || observation.nodeVersion !== contract.nodeVersion ||
		!isDeepStrictEqual(context.policy, policy) || authority.policySha256 !== officeSha(contract.inventoryPolicySha256) ||
		observation.policySha256 !== contract.inventoryPolicySha256 || authority.observerConfigSha256 !== officeSha(contract.observerConfigSha256) ||
		observation.bootId !== contract.hostBootId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(contract.hostBootId))
		throw new Error("BUILDER_EXECUTION_AUTHORITY_CHANGED");
	const enrolled = policy.infrastructure.find((item) => item.project === contract.builder?.project && item.name === contract.builder?.name);
	if (!enrolled || !isDeepStrictEqual(enrolled, contract.builder)) throw new Error("BUILDER_EXECUTION_NOT_ENROLLED");
	const local = reconcileRuntimeNodeInventory(inventory, context);
	if (local.state !== "ready") throw new Error("BUILDER_EXECUTION_LOCAL_INVENTORY_UNAVAILABLE");
	if (!Array.isArray(observation.entries)) throw new Error("BUILDER_EXECUTION_OBSERVATION_INVALID");
	for (const entries of [local.entries, observation.entries]) {
		const matching = entries.filter((item) => item.project === enrolled.project && item.name === enrolled.name);
		if (matching.length !== 1 || matching[0].category !== "infrastructure" || matching[0].reason !== null ||
			matching[0].physicalId !== enrolled.physicalId || matching[0].configurationSha256 !== enrolled.configurationSha256 ||
			matching[0].type !== "virtual-machine" || matching[0].cpuMillis !== enrolled.cpuMillis || matching[0].memoryBytes !== enrolled.memoryBytes)
			throw new Error("BUILDER_EXECUTION_BUILDER_DIFFERS");
	}
	return { schema: "qorpera.node-builder-execution-admission/v1", nodeId: contract.nodeId, nodeVersion: contract.nodeVersion,
		instanceUuid: enrolled.physicalId, contextSha256: context.contextSha256, observationId: observation.observationId,
		inventoryPolicySha256: contract.inventoryPolicySha256, validUntil: new Date(Math.min(now + 5000, Date.parse(authority.readAt) + 5000, Date.parse(observation.observedAt) + 60000)).toISOString() };
}
