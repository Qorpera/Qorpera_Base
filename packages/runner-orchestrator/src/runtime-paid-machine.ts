import { isDeepStrictEqual } from "node:util";
import type { LxdInstanceRecord } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** The trusted host records the exact stopped VM before handing start custody
 * to the independent guard. No guest credential or billing choice belongs here. */
export interface RuntimePaidComputerMachine {
	kind: "runtime";
	allocationId: string;
	nodeId: string;
	instanceSha256: string;
	providerKind: "native" | "office";
	physicalTarget: {
		kind: "lxd";
		project: string;
		instanceName: string;
		profiles: readonly string[];
		config: Readonly<Record<string, string>>;
		devices: Readonly<Record<string, Readonly<Record<string, string>>>>;
	};
	cpuMillis: number;
	memoryBytes: number;
	physicalInstanceId: string;
	hostMachineIdSha256: string;
	hostBootId: string;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAID_GUARD_RUNTIME_INVALID");
	return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("PAID_GUARD_RUNTIME_INVALID");
	return value;
}
function shape(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1125899906842624)
		throw new Error("PAID_GUARD_RUNTIME_INVALID");
	return Number(value);
}
function strings(value: unknown): Record<string, string> {
	const input = object(value);
	if (Object.keys(input).length > 128) throw new Error("PAID_GUARD_RUNTIME_INVALID");
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(input)) {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(key) ||
			typeof item !== "string" ||
			item.length > 4096 ||
			/[\0\r\n]/.test(item)
		)
			throw new Error("PAID_GUARD_RUNTIME_INVALID");
		result[key] = item;
	}
	return result;
}
export function parseRuntimePaidComputerMachine(value: unknown): RuntimePaidComputerMachine {
	const input = object(value),
		target = object(input.physicalTarget);
	if (
		input.kind !== "runtime" ||
		(input.providerKind !== "native" && input.providerKind !== "office") ||
		target.kind !== "lxd" ||
		!Array.isArray(target.profiles) ||
		target.profiles.length > 16 ||
		JSON.stringify(value).length > 24000
	)
		throw new Error("PAID_GUARD_RUNTIME_INVALID");
	const devices: Record<string, Record<string, string>> = {};
	for (const [name, device] of Object.entries(object(target.devices))) devices[text(name, NAME)] = strings(device);
	if (Object.keys(devices).length > 32) throw new Error("PAID_GUARD_RUNTIME_INVALID");
	const config = strings(target.config);
	if (
		Object.keys(config).some(
			(key) => key.startsWith("volatile.") || key.startsWith("image.") || key.startsWith("cloud-init."),
		)
	)
		throw new Error("PAID_GUARD_RUNTIME_INVALID");
	return {
		kind: "runtime",
		allocationId: text(input.allocationId, UUID),
		nodeId: text(input.nodeId, UUID),
		instanceSha256: text(input.instanceSha256, SHA),
		providerKind: input.providerKind,
		physicalTarget: {
			kind: "lxd",
			project: text(target.project, NAME),
			instanceName: text(target.instanceName, NAME),
			profiles: target.profiles.map((profile) => text(profile, NAME)),
			config,
			devices,
		},
		cpuMillis: shape(input.cpuMillis),
		memoryBytes: shape(input.memoryBytes),
		physicalInstanceId: text(input.physicalInstanceId, UUID),
		hostMachineIdSha256: text(input.hostMachineIdSha256, SHA),
		hostBootId: text(input.hostBootId, UUID),
	};
}
/** Recheck the whole physical authority at every start, stop and observation.
 * Ignore only LXD's own image/volatile facts; UUID remains independently pinned. */
export function assertRuntimePaidComputerInstance(
	machine: RuntimePaidComputerMachine,
	instance: LxdInstanceRecord,
): void {
	const target = machine.physicalTarget;
	if (
		instance.name !== target.instanceName ||
		instance.type !== "virtual-machine" ||
		!isDeepStrictEqual(instance.profiles, target.profiles) ||
		!isDeepStrictEqual(instance.devices, target.devices) ||
		!isDeepStrictEqual(instance.expandedDevices, target.devices) ||
		instance.config["volatile.uuid"] !== machine.physicalInstanceId ||
		instance.expandedConfig["volatile.uuid"] !== machine.physicalInstanceId ||
		[instance.config, instance.expandedConfig].some(
			(config) =>
				Object.entries(target.config).some(([key, value]) => config[key] !== value) ||
				Object.keys(config).some(
					(key) => !Object.hasOwn(target.config, key) && !key.startsWith("image.") && !key.startsWith("volatile."),
				),
		)
	)
		throw new Error("PAID_GUARD_PHYSICAL_INSTANCE_DIFFERS");
}
