import { isDeepStrictEqual } from "node:util";

export interface RuntimeNodeRegistry {
	call(
		method: "qorpera_reserve_runtime_node_machine",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface RuntimeNodeMachine {
	allocationId: string;
	providerKind: "native" | "office" | "login";
	providerId: string;
	policySha256: string;
	instanceSha256: string;
	machineIdSha256: string;
	cpuMillis: number;
	memoryBytes: number;
}
export const NODE_CAPACITY_REFUSALS = [
	"NODE_PROVIDER_UNCONFIGURED",
	"NODE_DISABLED",
	"NODE_OBSERVATION_UNAVAILABLE",
	"NODE_HARDWARE_CHANGED",
	"NODE_CAPACITY_EXHAUSTED",
] as const;
export type RuntimeNodeCapacityRefusal = (typeof NODE_CAPACITY_REFUSALS)[number];
export type RuntimeNodeAdmission =
	| { state: "refused"; reason: RuntimeNodeCapacityRefusal }
	| { state: "reserved"; nodeId: string; nodeVersion: number; signal: AbortSignal; validForMs: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

/** A company reservation is required separately. This gate binds its exact
 * physical allocation to an enrolled host budget and fresh host observation.
 * Call immediately before dispatch, after the current physical/tenant checks.
 * Refusal, timeout and lost responses never release an allocation or retry IO. */
export async function reserveRuntimeNodeMachine(
	value: RuntimeNodeMachine,
	registry: RuntimeNodeRegistry,
	caller: AbortSignal,
): Promise<RuntimeNodeAdmission> {
	caller.throwIfAborted();
	const machine = structuredClone(value);
	if (
		!UUID.test(machine.allocationId) ||
		!SHA.test(machine.policySha256) ||
		!SHA.test(machine.instanceSha256) ||
		!SHA.test(machine.machineIdSha256) ||
		!["native", "office", "login"].includes(machine.providerKind) ||
		!(machine.providerKind === "office" ? UUID : /^[a-z][a-z0-9_-]{0,63}$/).test(machine.providerId) ||
		!Number.isSafeInteger(machine.cpuMillis) ||
		machine.cpuMillis < 1 ||
		machine.cpuMillis > 1024000 ||
		!Number.isSafeInteger(machine.memoryBytes) ||
		machine.memoryBytes < 1 ||
		machine.memoryBytes > 1125899906842624
	)
		throw new Error("INVALID_RUNTIME_NODE_MACHINE");
	const started = performance.now();
	const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
	const result = await registry.call(
		"qorpera_reserve_runtime_node_machine",
		{
			p_allocation_id: machine.allocationId,
			p_provider_kind: machine.providerKind,
			p_provider_id: machine.providerId,
			p_policy_sha256: machine.policySha256,
			p_instance_sha256: machine.instanceSha256,
			p_machine_id_sha256: machine.machineIdSha256,
			p_cpu_millis: machine.cpuMillis,
			p_memory_bytes: machine.memoryBytes,
		},
		signal,
	);
	signal.throwIfAborted();
	for (const reason of NODE_CAPACITY_REFUSALS)
		if (isDeepStrictEqual(result, { state: "refused", reason })) return { state: "refused", reason };
	if (result === null || typeof result !== "object" || Array.isArray(result))
		throw new Error("NODE_ADMISSION_UNCONFIRMED");
	const record = result as Record<string, unknown>;
	if (
		typeof record.nodeId !== "string" ||
		!UUID.test(record.nodeId) ||
		!Number.isSafeInteger(record.nodeVersion) ||
		(record.nodeVersion as number) < 1 ||
		!Number.isSafeInteger(record.validForMs) ||
		(record.validForMs as number) < 1 ||
		(record.validForMs as number) > 5000 ||
		!isDeepStrictEqual(result, {
			state: "reserved",
			allocationId: machine.allocationId,
			nodeId: record.nodeId,
			nodeVersion: record.nodeVersion,
			instanceSha256: machine.instanceSha256,
			cpuMillis: machine.cpuMillis,
			memoryBytes: machine.memoryBytes,
			validForMs: record.validForMs,
		})
	)
		throw new Error("NODE_ADMISSION_UNCONFIRMED");
	const validForMs = Math.floor((record.validForMs as number) - (performance.now() - started));
	if (validForMs < 1) throw new Error("NODE_ADMISSION_EXPIRED");
	return {
		state: "reserved",
		nodeId: record.nodeId,
		nodeVersion: record.nodeVersion as number,
		signal: AbortSignal.any([signal, AbortSignal.timeout(validForMs)]),
		validForMs,
	};
}
