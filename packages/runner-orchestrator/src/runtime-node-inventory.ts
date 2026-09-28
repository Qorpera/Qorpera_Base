import { isDeepStrictEqual } from "node:util";
import { cloudCodingSessionLayout } from "@qorpera/contracts";
import {
	type ExecutionHostIdentityVolumes,
	executionHostIdentityDevices,
	MAX_EXECUTION_HOST_IDENTITIES,
	parseExecutionHostIdentityVolumes,
} from "./execution-host-identity.ts";
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
	/** A shared execution host (deploy/shared-execution): the node's login
	 * gateway hot-plugs each Compute Identity volume into it. Only devices of
	 * exactly that shape are left out of its digest (execution-host-identity.ts)
	 * and reported as the entry's `identities`; the registry accepts only
	 * identities whose login machine this node reserved. */
	identityVolumes?: ExecutionHostIdentityVolumes;
}
/** A declared space for image build machines (a builder and its verifier).
 * Every instance in `project` is a build machine: a virtual machine with
 * explicit limits, its root disk and network only, and no Qorpera marker but
 * the builder's own. Together they may use at most the declared CPU and
 * memory, which the policy always counts against the node's headroom whether
 * a build runs or not. So a build never makes the node unavailable, and
 * nothing else can hide in the build project. */
export interface RuntimeNodeBuildSpace {
	project: string;
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
	buildSpace?: RuntimeNodeBuildSpace;
}
export function parseRuntimeNodeInventoryPolicy(value: unknown): RuntimeNodeInventoryPolicy {
	const building = !!value && typeof value === "object" && Object.hasOwn(value, "buildSpace");
	const p = record(
		value,
		`schema,nodeId,host,operatingCpuMillis,operatingMemoryBytes,infrastructure${building ? ",buildSpace" : ""}`,
	);
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
		const hosting = !!value && typeof value === "object" && Object.hasOwn(value, "identityVolumes");
		const i = record(
			value,
			`project,name,physicalId,type,configurationSha256,cpuMillis,memoryBytes${hosting ? ",identityVolumes" : ""}`,
		);
		if ((i.type !== "virtual-machine" && i.type !== "container") || (hosting && i.type !== "virtual-machine"))
			throw new Error("INVALID_NODE_INVENTORY_POLICY");
		let identityVolumes: ExecutionHostIdentityVolumes | undefined;
		try {
			identityVolumes = hosting ? parseExecutionHostIdentityVolumes(i.identityVolumes) : undefined;
		} catch {
			throw new Error("INVALID_NODE_INVENTORY_POLICY");
		}
		return {
			project: text(i.project, NAME),
			name: text(i.name, NAME),
			physicalId: text(i.physicalId, UUID),
			type: i.type,
			configurationSha256: officeSha(i.configurationSha256),
			cpuMillis: integer(i.cpuMillis, MAX_CPU),
			memoryBytes: integer(i.memoryBytes, MAX_MEMORY),
			...(identityVolumes ? { identityVolumes } : {}),
		};
	});
	let buildSpace: RuntimeNodeBuildSpace | undefined;
	if (building) {
		const b = record(p.buildSpace, "project,cpuMillis,memoryBytes");
		buildSpace = {
			project: text(b.project, NAME),
			cpuMillis: integer(b.cpuMillis, MAX_CPU),
			memoryBytes: integer(b.memoryBytes, MAX_MEMORY),
		};
	}
	if (
		new Set(infrastructure.map((i) => JSON.stringify([i.project, i.name]))).size !== infrastructure.length ||
		new Set(infrastructure.map((i) => i.physicalId)).size !== infrastructure.length ||
		(buildSpace && infrastructure.some((i) => i.project === buildSpace.project))
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
		...(buildSpace ? { buildSpace } : {}),
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
	/** Only when the policy declares an identity host: every identity this node
	 * reserved a login or account-refresh machine for, which is when its login
	 * gateway creates the identity's volume. The host may mount no other. */
	acceptedIdentities?: string[];
}
export function parseRuntimeNodeInventoryContext(value: unknown): RuntimeNodeInventoryContext {
	const hosting = !!value && typeof value === "object" && Object.hasOwn(value, "acceptedIdentities");
	const c = record(
		value,
		`policy,nodeVersion,contextSha256,headroomCpuMillis,headroomMemoryBytes,allocations${hosting ? ",acceptedIdentities" : ""}`,
	);
	if (
		hosting &&
		(!Array.isArray(c.acceptedIdentities) ||
			c.acceptedIdentities.some((id) => typeof id !== "string" || !UUID.test(id)))
	)
		throw new Error("INVALID_NODE_INVENTORY_CONTEXT");
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
		...(hosting ? { acceptedIdentities: [...(c.acceptedIdentities as string[])] } : {}),
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
	category: "managed" | "infrastructure" | "build" | "unmanaged";
	reason:
		| "UNREGISTERED_INSTANCE"
		| "INSTANCE_AUTHORITY_DIFFERS"
		| "INSTANCE_STATE_UNAVAILABLE"
		| "BUILD_SPACE_EXCEEDED"
		| null;
	/** Only on an infrastructure entry whose policy declares identityVolumes:
	 * the identities of its identity devices, sorted. */
	identities?: string[];
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
 * folders' NAS placement itself. Likewise a shared execution host enrolled
 * with identityVolumes: its identity devices are left out of the digest and
 * returned as `identities`, which the registry checks one by one. */
export function runtimeNodeInstanceConfiguration(
	i: LxdHostInventoryInstance,
	identityVolumes?: ExecutionHostIdentityVolumes,
): { configurationSha256: string; identities?: string[] } {
	const stable = (value: Record<string, string>) =>
		Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith("volatile.")));
	const machine =
		i.config["user.qorpera.schema"] === "qorpera.lxd-coding-machine/v1" &&
		i.expandedConfig["user.qorpera.schema"] === "qorpera.lxd-coding-machine/v1";
	const enrolled = (value: Record<string, Readonly<Record<string, string>>>) =>
		machine ? Object.fromEntries(Object.entries(value).filter(([k, device]) => !sessionFolder(k, device))) : value;
	const hosted: Partial<ReturnType<typeof executionHostIdentityDevices>> &
		Pick<LxdHostInventoryInstance, "devices" | "expandedDevices"> = identityVolumes
		? executionHostIdentityDevices(identityVolumes, i.devices, i.expandedDevices)
		: { devices: i.devices, expandedDevices: i.expandedDevices };
	if (hosted.identities && hosted.identities.length > MAX_EXECUTION_HOST_IDENTITIES)
		throw new Error("NODE_INVENTORY_IDENTITIES_EXCEEDED");
	return {
		configurationSha256: officeDigest({
			type: i.type,
			profiles: i.profiles,
			config: stable(i.config),
			expandedConfig: stable(i.expandedConfig),
			devices: enrolled(hosted.devices),
			expandedDevices: enrolled(hosted.expandedDevices),
		}),
		...(hosted.identities ? { identities: hosted.identities } : {}),
	};
}
export function runtimeNodeInstanceConfigurationSha256(
	i: LxdHostInventoryInstance,
	identityVolumes?: ExecutionHostIdentityVolumes,
): string {
	return runtimeNodeInstanceConfiguration(i, identityVolumes).configurationSha256;
}
const BUILD_MARKERS = new Set(["user.qorpera.image_builder", "user.qorpera.purpose"]);
/** A build machine as the image lane makes one: a virtual machine whose only
 * devices are its root disk from a storage pool and network interfaces, with
 * no raw hypervisor settings and no Qorpera marker but the builder's own. It
 * can mount no host path or volume, so no company, identity or login disk. */
function buildMachine(i: LxdHostInventoryInstance): boolean {
	if (i.type !== "virtual-machine") return false;
	for (const config of [i.config, i.expandedConfig])
		for (const [key, value] of Object.entries(config)) {
			if (key.startsWith("raw.")) return false;
			if (key.startsWith("user.qorpera.") && !BUILD_MARKERS.has(key)) return false;
			if (key === "user.qorpera.image_builder" && value !== "true") return false;
		}
	for (const devices of [i.devices, i.expandedDevices])
		for (const device of Object.values(devices)) {
			if (device.type === "nic") continue;
			if (
				device.type !== "disk" ||
				device.path !== "/" ||
				typeof device.pool !== "string" ||
				device.source !== undefined ||
				Object.keys(device).some((k) => !["type", "path", "pool", "size", "size.state"].includes(k))
			)
				return false;
		}
	return true;
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
		p = c.policy,
		accepted = new Set(c.acceptedIdentities);
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
		const build = p.buildSpace?.project === i.project,
			a = build ? null : allocation(i, c),
			infra = a || build ? undefined : p.infrastructure.find((v) => v.project === i.project && v.name === i.name),
			{ configurationSha256, identities } = runtimeNodeInstanceConfiguration(i, infra?.identityVolumes),
			resources = cost(i),
			s = state(i);
		let category: RuntimeNodeInventoryEntry["category"] = "unmanaged",
			reason: RuntimeNodeInventoryEntry["reason"] = "UNREGISTERED_INSTANCE";
		if (build) {
			// Build machines never stand for an allocation or infrastructure entry.
			category = "build";
			reason =
				physicalId && resources.cpuMillis !== null && resources.memoryBytes !== null && buildMachine(i)
					? null
					: "INSTANCE_AUTHORITY_DIFFERS";
		} else if (a) {
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
		} else if (infra) {
			category = "infrastructure";
			reason =
				isDeepStrictEqual(infra, {
					project: i.project,
					name: i.name,
					physicalId,
					type: i.type,
					configurationSha256,
					...resources,
					...(infra.identityVolumes ? { identityVolumes: infra.identityVolumes } : {}),
				}) &&
				(identities ?? []).every((id) => accepted.has(id)) &&
				!Object.keys(i.expandedConfig).some(
					(k) => k.startsWith("user.qorpera.") && k !== "user.qorpera.management_vm",
				)
					? null
					: "INSTANCE_AUTHORITY_DIFFERS";
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
			...(identities ? { identities } : {}),
		};
	});
	// Build machines share one declared space, stopped ones included.
	const builds = entries.filter((e) => e.category === "build");
	if (
		p.buildSpace &&
		(builds.reduce((sum, e) => sum + (e.cpuMillis ?? 0), 0) > p.buildSpace.cpuMillis ||
			builds.reduce((sum, e) => sum + (e.memoryBytes ?? 0), 0) > p.buildSpace.memoryBytes)
	)
		for (const e of builds) if (e.reason === null) e.reason = "BUILD_SPACE_EXCEEDED";
	const headroomValid =
		p.operatingCpuMillis +
			p.infrastructure.reduce((sum, i) => sum + i.cpuMillis, 0) +
			(p.buildSpace?.cpuMillis ?? 0) <=
			c.headroomCpuMillis &&
		p.operatingMemoryBytes +
			p.infrastructure.reduce((sum, i) => sum + i.memoryBytes, 0) +
			(p.buildSpace?.memoryBytes ?? 0) <=
			c.headroomMemoryBytes;
	return {
		state: headroomValid && entries.every((i) => i.reason === null) ? ("ready" as const) : ("unavailable" as const),
		entries,
		headroomValid,
	};
}
