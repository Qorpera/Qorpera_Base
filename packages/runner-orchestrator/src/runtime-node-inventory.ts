import { isDeepStrictEqual } from "node:util";
import { cloudCodingSessionLayout } from "@qorpera/contracts";
import type { LxdHostInventory, LxdHostInventoryInstance } from "./lxd-client.ts";
import { lxdResourceBytes } from "./lxd-native-node-policy.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const MAX_CPU = 1024000,
	MAX_MEMORY = 1125899906842624;
const record = (value: unknown, keys: string) => officeRecord(value, keys.split(","));
function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("INVALID_NODE_INVENTORY_POLICY");
	return value;
}
function integer(value: unknown, max: number, min = 1): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
		throw new Error("INVALID_NODE_INVENTORY_POLICY");
	return value as number;
}
export interface RuntimeNodeInfrastructure {
	project: string;
	name: string;
	physicalId: string;
	type: "virtual-machine" | "container";
	configurationSha256: string;
	cpuMillis: number;
	memoryBytes: number;
}
export interface RuntimeNodeInventoryPolicy {
	schema: "qorpera.runtime-node-inventory-policy/v1";
	nodeId: string;
	host: {
		machineIdSha256: string;
		socketPath: string;
		socketGid: number;
		certificateSha256: string;
		serverName: string;
		serverVersion: string;
		architecture: "x86_64" | "aarch64";
	};
	operatingCpuMillis: number;
	operatingMemoryBytes: number;
	infrastructure: RuntimeNodeInfrastructure[];
}
export function parseRuntimeNodeInventoryPolicy(value: unknown): RuntimeNodeInventoryPolicy {
	const p = record(value, "schema,nodeId,host,operatingCpuMillis,operatingMemoryBytes,infrastructure");
	const h = record(
		p.host,
		"machineIdSha256,socketPath,socketGid,certificateSha256,serverName,serverVersion,architecture",
	);
	if (
		p.schema !== "qorpera.runtime-node-inventory-policy/v1" ||
		!["x86_64", "aarch64"].includes(h.architecture as string) ||
		!Array.isArray(p.infrastructure) ||
		p.infrastructure.length > 256
	)
		throw new Error("INVALID_NODE_INVENTORY_POLICY");
	const infrastructure = p.infrastructure.map((value): RuntimeNodeInfrastructure => {
		const i = record(value, "project,name,physicalId,type,configurationSha256,cpuMillis,memoryBytes");
		if (i.type !== "virtual-machine" && i.type !== "container") throw new Error("INVALID_NODE_INVENTORY_POLICY");
		return {
			project: text(i.project, NAME),
			name: text(i.name, NAME),
			physicalId: text(i.physicalId, UUID),
			type: i.type,
			configurationSha256: officeSha(i.configurationSha256),
			cpuMillis: integer(i.cpuMillis, MAX_CPU),
			memoryBytes: integer(i.memoryBytes, MAX_MEMORY),
		};
	});
	if (
		new Set(infrastructure.map((i) => JSON.stringify([i.project, i.name]))).size !== infrastructure.length ||
		new Set(infrastructure.map((i) => i.physicalId)).size !== infrastructure.length
	)
		throw new Error("INVALID_NODE_INVENTORY_POLICY");
	return {
		schema: p.schema,
		nodeId: text(p.nodeId, UUID),
		host: {
			machineIdSha256: officeSha(h.machineIdSha256),
			socketPath: officePhysicalPath(h.socketPath),
			socketGid: integer(h.socketGid, 2 ** 32 - 2, 0),
			certificateSha256: officeSha(h.certificateSha256),
			serverName: text(h.serverName, /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/),
			serverVersion: text(h.serverVersion, /^[A-Za-z0-9][A-Za-z0-9.+~-]{0,63}$/),
			architecture: h.architecture as "x86_64" | "aarch64",
		},
		operatingCpuMillis: integer(p.operatingCpuMillis, MAX_CPU),
		operatingMemoryBytes: integer(p.operatingMemoryBytes, MAX_MEMORY),
		infrastructure,
	};
}
export interface RuntimeNodeInventoryAllocation {
	allocationId: string;
	providerKind: "native" | "office" | "login" | "coding";
	providerId: string;
	policySha256: string;
	instanceSha256: string;
	cpuMillis: number;
	memoryBytes: number;
	physical: { project: string; name: string; physicalId: string; configurationSha256: string } | null;
}
export interface RuntimeNodeInventoryContext {
	policy: RuntimeNodeInventoryPolicy;
	nodeVersion: number;
	contextSha256: string;
	headroomCpuMillis: number;
	headroomMemoryBytes: number;
	allocations: RuntimeNodeInventoryAllocation[];
}
export function parseRuntimeNodeInventoryContext(value: unknown): RuntimeNodeInventoryContext {
	const c = record(value, "policy,nodeVersion,contextSha256,headroomCpuMillis,headroomMemoryBytes,allocations");
	if (!Array.isArray(c.allocations) || c.allocations.length > 4096) throw new Error("INVALID_NODE_INVENTORY_CONTEXT");
	const allocations = c.allocations.map((value) => {
		const a = record(
			value,
			"allocationId,providerKind,providerId,policySha256,instanceSha256,cpuMillis,memoryBytes,physical",
		);
		const physical = a.physical === null ? null : record(a.physical, "project,name,physicalId,configurationSha256");
		if (!["native", "office", "login", "coding"].includes(a.providerKind as string))
			throw new Error("INVALID_NODE_INVENTORY_CONTEXT");
		return {
			allocationId: text(a.allocationId, UUID),
			providerKind: a.providerKind as RuntimeNodeInventoryAllocation["providerKind"],
			providerId: text(a.providerId, a.providerKind === "office" ? UUID : /^[a-z][a-z0-9_-]{0,63}$/),
			policySha256: officeSha(a.policySha256),
			instanceSha256: officeSha(a.instanceSha256),
			cpuMillis: integer(a.cpuMillis, MAX_CPU),
			memoryBytes: integer(a.memoryBytes, MAX_MEMORY),
			physical:
				physical === null
					? null
					: {
							project: text(physical.project, NAME),
							name: text(physical.name, NAME),
							physicalId: text(physical.physicalId, UUID),
							configurationSha256: officeSha(physical.configurationSha256),
						},
		};
	});
	if (new Set(allocations.map((a) => a.allocationId)).size !== allocations.length)
		throw new Error("INVALID_NODE_INVENTORY_CONTEXT");
	return {
		policy: parseRuntimeNodeInventoryPolicy(c.policy),
		nodeVersion: integer(c.nodeVersion, Number.MAX_SAFE_INTEGER),
		contextSha256: officeSha(c.contextSha256),
		headroomCpuMillis: integer(c.headroomCpuMillis, MAX_CPU, 0),
		headroomMemoryBytes: integer(c.headroomMemoryBytes, MAX_MEMORY, 0),
		allocations,
	};
}
export type RuntimeNodePhysicalState = "starting" | "running" | "stopping" | "suspended" | "failed" | "unavailable";
export interface RuntimeNodeInventoryEntry {
	project: string;
	name: string;
	physicalId: string | null;
	type: string;
	state: RuntimeNodePhysicalState;
	configurationSha256: string;
	cpuMillis: number | null;
	memoryBytes: number | null;
	allocation: RuntimeNodeInventoryAllocation | null;
	category: "managed" | "infrastructure" | "unmanaged";
	reason: "UNREGISTERED_INSTANCE" | "INSTANCE_AUTHORITY_DIFFERS" | "INSTANCE_STATE_UNAVAILABLE" | null;
}

const SESSION_DEVICE = /^(data|custody)-([0-9a-f]{32})$/;
/** A session's NAS folder exactly as the coding executor hot-plugs it: a
 * required directory disk at that session's data or custody root, from that
 * session's own NAS folder. Anything else under such a name is enrollment. */
function sessionFolder(name: string, device: Readonly<Record<string, string>>): boolean {
	const match = SESSION_DEVICE.exec(name);
	if (!match) return false;
	const compact = match[2];
	const workerId = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
	let layout: ReturnType<typeof cloudCodingSessionLayout>;
	try {
		layout = cloudCodingSessionLayout(workerId);
	} catch {
		return false;
	}
	const data = match[1] === "data";
	return (
		Object.keys(device).sort().join() === "path,required,source,type" &&
		device.type === "disk" &&
		device.required === "true" &&
		device.path === (data ? layout.dataRoot : layout.custodyRoot) &&
		device.source.startsWith("/") &&
		!device.source.split("/").some((part) => part === ".." || part === ".") &&
		device.source.endsWith(`/${workerId}/${data ? "data" : "guest-state"}`)
	);
}

/** Hash configuration without disclosing cloud-init or other host secrets.
 * Volatile runtime bookkeeping is not enrollment policy; the actual physical
 * UUID is bound separately. Both local and effective configuration are hashed.
 * A member's coding machine hot-plugs each session's two NAS folders while
 * that session's turn runs (data-<worker>, custody-<worker>); they are not its
 * enrollment, so its digest covers everything else. Only a device of exactly
 * that shape is left out (sessionFolder); the coding executor checks the
 * folders' NAS placement itself. */
export function runtimeNodeInstanceConfigurationSha256(i: LxdHostInventoryInstance): string {
	const stable = (value: Record<string, string>) =>
		Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith("volatile.")));
	const machine =
		i.config["user.qorpera.schema"] === "qorpera.lxd-coding-machine/v1" &&
		i.expandedConfig["user.qorpera.schema"] === "qorpera.lxd-coding-machine/v1";
	const enrolled = (value: Record<string, Readonly<Record<string, string>>>) =>
		machine ? Object.fromEntries(Object.entries(value).filter(([k, device]) => !sessionFolder(k, device))) : value;
	return officeDigest({
		type: i.type,
		profiles: i.profiles,
		config: stable(i.config),
		expandedConfig: stable(i.expandedConfig),
		devices: enrolled(i.devices),
		expandedDevices: enrolled(i.expandedDevices),
	});
}
function state(i: LxdHostInventoryInstance): RuntimeNodePhysicalState {
	const states: Record<number, [string, RuntimeNodePhysicalState]> = {
		102: ["Stopped", "suspended"],
		103: ["Running", "running"],
		106: ["Starting", "starting"],
		107: ["Stopping", "stopping"],
		109: ["Freezing", "stopping"],
		110: ["Frozen", "suspended"],
		112: ["Error", "failed"],
	};
	return states[i.statusCode]?.[0] === i.status ? states[i.statusCode][1] : "unavailable";
}
function cost(i: LxdHostInventoryInstance): { cpuMillis: number | null; memoryBytes: number | null } {
	let cpuMillis: number | null = null,
		memoryBytes: number | null = null;
	try {
		const cpu = text(i.expandedConfig["limits.cpu"], /^[1-9][0-9]{0,3}$/);
		cpuMillis = integer(Number(cpu) * 1000, MAX_CPU);
	} catch {
		/* Unlimited or pinned CPU sets have no supported exact cost. */
	}
	try {
		const memory = i.expandedConfig["limits.memory"];
		memoryBytes = integer(/^[1-9][0-9]{0,15}$/.test(memory) ? Number(memory) : lxdResourceBytes(memory), MAX_MEMORY);
	} catch {
		/* Unknown is not zero, including for a stopped instance. */
	}
	return { cpuMillis, memoryBytes };
}
function allocation(
	i: LxdHostInventoryInstance,
	c: RuntimeNodeInventoryContext,
): RuntimeNodeInventoryAllocation | null {
	const tag = (name: string): string | undefined => {
		const k = `user.qorpera.${name}`;
		return i.config[k] === i.expandedConfig[k] ? i.config[k] : undefined;
	};
	const kind =
		tag("schema") === "qorpera.lxd-office-guest/v2"
			? "office"
			: tag("schema") === "qorpera.native-login-vm/v2"
				? "login"
				: tag("schema") === "qorpera.native-job-vm/v1"
					? "native"
					: tag("schema") === "qorpera.lxd-coding-vm/v2" || tag("schema") === "qorpera.lxd-coding-machine/v1"
						? "coding"
						: null;
	const id = kind === "native" ? tag("acquisition_id") : tag("allocation_id");
	const expected = c.allocations.find((a) => a.allocationId === id);
	if (
		!expected ||
		i.type !== "virtual-machine" ||
		kind !== expected.providerKind ||
		tag(kind === "office" || kind === "coding" ? "provider_id" : "provider_adapter") !== expected.providerId ||
		tag("provider_policy_sha256") !== expected.policySha256 ||
		tag("instance_sha256") !== expected.instanceSha256
	)
		return null;
	// Runtime plans always set local limits. Inherited overrides cannot reduce
	// the charge or change the effective reservation behind a matching marker.
	if (
		i.config["limits.cpu"] !== i.expandedConfig["limits.cpu"] ||
		i.config["limits.memory"] !== i.expandedConfig["limits.memory"]
	)
		return null;
	return expected;
}
export function reconcileRuntimeNodeInventory(inventory: LxdHostInventory, context: RuntimeNodeInventoryContext) {
	const c = parseRuntimeNodeInventoryContext(context),
		p = c.policy;
	if (
		!isDeepStrictEqual(inventory.server, {
			project: "default",
			certificateSha256: p.host.certificateSha256,
			serverName: p.host.serverName,
			serverVersion: p.host.serverVersion,
			architecture: p.host.architecture,
		}) ||
		inventory.instances.length > 4096
	)
		throw new Error("NODE_INVENTORY_HOST_DIFFERS");
	const seen = new Set<string>(),
		physical = new Set<string>(),
		managed = new Set<string>();
	const entries: RuntimeNodeInventoryEntry[] = inventory.instances.map((i) => {
		const key = JSON.stringify([text(i.project, NAME), text(i.name, NAME)]);
		if (seen.has(key)) throw new Error("NODE_INVENTORY_DUPLICATE_INSTANCE");
		seen.add(key);
		const physicalId =
			UUID.test(i.config["volatile.uuid"] ?? "") && i.config["volatile.uuid"] === i.expandedConfig["volatile.uuid"]
				? i.config["volatile.uuid"]
				: null;
		if (physicalId && physical.has(physicalId)) throw new Error("NODE_INVENTORY_DUPLICATE_INSTANCE");
		if (physicalId) physical.add(physicalId);
		const configurationSha256 = runtimeNodeInstanceConfigurationSha256(i),
			resources = cost(i),
			a = allocation(i, c),
			s = state(i);
		let category: RuntimeNodeInventoryEntry["category"] = "unmanaged",
			reason: RuntimeNodeInventoryEntry["reason"] = "UNREGISTERED_INSTANCE";
		if (a) {
			if (managed.has(a.allocationId)) throw new Error("NODE_INVENTORY_DUPLICATE_ALLOCATION");
			managed.add(a.allocationId);
			category = "managed";
			reason =
				physicalId &&
				a.cpuMillis === resources.cpuMillis &&
				a.memoryBytes === resources.memoryBytes &&
				(a.physical === null ||
					isDeepStrictEqual(a.physical, { project: i.project, name: i.name, physicalId, configurationSha256 }))
					? null
					: "INSTANCE_AUTHORITY_DIFFERS";
		} else {
			const infra = p.infrastructure.find((v) => v.project === i.project && v.name === i.name);
			if (infra) {
				category = "infrastructure";
				reason =
					isDeepStrictEqual(infra, {
						project: i.project,
						name: i.name,
						physicalId,
						type: i.type,
						configurationSha256,
						...resources,
					}) &&
					!Object.keys(i.expandedConfig).some(
						(k) => k.startsWith("user.qorpera.") && k !== "user.qorpera.management_vm",
					)
						? null
						: "INSTANCE_AUTHORITY_DIFFERS";
			}
		}
		if (!reason && s === "unavailable") reason = "INSTANCE_STATE_UNAVAILABLE";
		return {
			project: i.project,
			name: i.name,
			physicalId,
			type: i.type,
			state: s,
			configurationSha256,
			...resources,
			allocation: a,
			category,
			reason,
		};
	});
	const headroomValid =
		p.operatingCpuMillis + p.infrastructure.reduce((sum, i) => sum + i.cpuMillis, 0) <= c.headroomCpuMillis &&
		p.operatingMemoryBytes + p.infrastructure.reduce((sum, i) => sum + i.memoryBytes, 0) <= c.headroomMemoryBytes;
	return {
		state: headroomValid && entries.every((i) => i.reason === null) ? ("ready" as const) : ("unavailable" as const),
		entries,
		headroomValid,
	};
}
