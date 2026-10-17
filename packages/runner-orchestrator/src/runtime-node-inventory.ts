import { isDeepStrictEqual } from "node:util";
import { cloudCodingSessionLayout } from "@qorpera/contracts";
import {
	CODE_HOST_PROJECT,
	type CodeHostPolicy,
	codeHostInstanceMatches,
	codeHostReservation,
	parseCodeHostPolicy,
} from "./code-host.ts";
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
	/** Listed by its job, so a rebuild onto a new image needs no new policy.
	 * Only `execution-host`, the node's shared execution host: LXD's `image.*`
	 * keys are left out of its digest, and its image (`volatile.base_image`)
	 * must be the runner image a signed release on the node pins
	 * (runtime-node-releases.ts). Everything else stays exact. */
	role?: RuntimeNodeInfrastructureRole;
}
export type RuntimeNodeInfrastructureRole = "execution-host";
/** A declared space for image build machines (a builder and its verifier).
 * Every instance in `project` is a build machine (buildMachine below). Together
 * they may use at most the declared CPU and memory, which the policy always
 * counts against the node's headroom whether a build runs or not. So a build
 * never makes the node unavailable, and nothing else can hide in the build
 * project. `network` is the only network a build machine may join. */
export interface RuntimeNodeBuildSpace {
	project: string;
	network: string;
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
	/** The node's code hosts (code-host.ts): each company's `code-host` VM in its own project, made by the coding
	 * executor under the same policy. `running` of them are always reserved, like the build space; a code host
	 * is accepted only exactly as the executor makes it. Without it, anything in such a project is unregistered. */
	codeHosts?: CodeHostPolicy;
}
/** What the policy holds back from the node's headroom whether anything runs or not. */
export function runtimeNodeReserved(p: RuntimeNodeInventoryPolicy): { cpuMillis: number; memoryBytes: number } {
	const hosts = codeHostReservation(p.codeHosts);
	return {
		cpuMillis:
			p.operatingCpuMillis +
			p.infrastructure.reduce((sum, i) => sum + i.cpuMillis, 0) +
			(p.buildSpace?.cpuMillis ?? 0) +
			hosts.cpuMillis,
		memoryBytes:
			p.operatingMemoryBytes +
			p.infrastructure.reduce((sum, i) => sum + i.memoryBytes, 0) +
			(p.buildSpace?.memoryBytes ?? 0) +
			hosts.memoryBytes,
	};
}
export function parseRuntimeNodeInventoryPolicy(value: unknown): RuntimeNodeInventoryPolicy {
	const building = !!value && typeof value === "object" && Object.hasOwn(value, "buildSpace");
	const coding = !!value && typeof value === "object" && Object.hasOwn(value, "codeHosts");
	const p = record(
		value,
		`schema,nodeId,host,operatingCpuMillis,operatingMemoryBytes,infrastructure${building ? ",buildSpace" : ""}${coding ? ",codeHosts" : ""}`,
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
		const byRole = !!value && typeof value === "object" && Object.hasOwn(value, "role");
		const i = record(
			value,
			`project,name,physicalId,type,configurationSha256,cpuMillis,memoryBytes${hosting ? ",identityVolumes" : ""}${byRole ? ",role" : ""}`,
		);
		if (
			(i.type !== "virtual-machine" && i.type !== "container") ||
			((hosting || byRole) && i.type !== "virtual-machine") ||
			(byRole && i.role !== "execution-host")
		)
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
			...(byRole ? { role: "execution-host" as const } : {}),
		};
	});
	let buildSpace: RuntimeNodeBuildSpace | undefined;
	if (building) {
		const b = record(p.buildSpace, "project,network,cpuMillis,memoryBytes");
		buildSpace = {
			project: text(b.project, NAME),
			network: text(b.network, NAME),
			cpuMillis: integer(b.cpuMillis, MAX_CPU),
			memoryBytes: integer(b.memoryBytes, MAX_MEMORY),
		};
	}
	let codeHosts: CodeHostPolicy | undefined;
	try {
		codeHosts = coding ? parseCodeHostPolicy(p.codeHosts) : undefined;
	} catch {
		throw new Error("INVALID_NODE_INVENTORY_POLICY");
	}
	if (
		new Set(infrastructure.map((i) => JSON.stringify([i.project, i.name]))).size !== infrastructure.length ||
		new Set(infrastructure.map((i) => i.physicalId)).size !== infrastructure.length ||
		(buildSpace && infrastructure.some((i) => i.project === buildSpace.project)) ||
		// A code host project holds its code host and nothing else.
		infrastructure.some((i) => CODE_HOST_PROJECT.test(i.project)) ||
		(buildSpace && CODE_HOST_PROJECT.test(buildSpace.project))
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
		...(codeHosts ? { codeHosts } : {}),
	};
}
export interface RuntimeNodeInventoryAllocation {
	allocationId: string;
	providerKind: "native" | "office" | "login" | "coding" | "machine";
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
		if (!["native", "office", "login", "coding", "machine"].includes(a.providerKind as string))
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
	category: "managed" | "infrastructure" | "build" | "code-host" | "unmanaged";
	reason:
		| "UNREGISTERED_INSTANCE"
		| "INSTANCE_AUTHORITY_DIFFERS"
		| "INSTANCE_STATE_UNAVAILABLE"
		| "BUILD_SPACE_EXCEEDED"
		| "INSTANCE_IMAGE_NOT_RELEASED"
		| "CODE_HOST_SPACE_EXCEEDED"
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
 * returned as `identities`, which the registry checks one by one. An entry
 * listed by role also leaves out the `image.*` keys LXD copies from the image;
 * the observer checks the image itself against the node's signed releases. */
export function runtimeNodeInstanceConfiguration(
	i: LxdHostInventoryInstance,
	identityVolumes?: ExecutionHostIdentityVolumes,
	role?: RuntimeNodeInfrastructureRole,
): { configurationSha256: string; identities?: string[] } {
	const stable = (value: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(value).filter(([k]) => !k.startsWith("volatile.") && !(role && k.startsWith("image."))),
		);
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
	role?: RuntimeNodeInfrastructureRole,
): string {
	return runtimeNodeInstanceConfiguration(i, identityVolumes, role).configurationSha256;
}
/** Configuration a build machine may carry: its limits and boot settings, the
 * keys LXD itself keeps (`volatile.*`) or copies from the image (`image.*`),
 * and the builder's own two markers. Anything else, known today or added to
 * LXD later, is refused. */
const BUILD_CONFIG = new Set([
	"limits.cpu",
	"limits.memory",
	"boot.autostart",
	"boot.mode",
	"security.secureboot",
	"security.csm",
	"user.qorpera.image_builder",
	"user.qorpera.purpose",
]);
const BUILD_NIC = new Set([
	"type",
	"name",
	"network",
	"hwaddr",
	"security.ipv4_filtering",
	"security.ipv6_filtering",
	"security.mac_filtering",
	"security.port_isolation",
]);
/** A build machine as the image lane makes one: a virtual machine with an
 * allowlisted configuration (never autostarting), one root disk of a declared
 * size from a storage pool, and network interfaces only on the build space's
 * network with MAC, IPv4 and IPv6 filtering and port isolation on, like every runtime guest. It can mount no host path or
 * volume (so no company, identity or login disk) and reach no other network. */
function buildMachine(i: LxdHostInventoryInstance, space: RuntimeNodeBuildSpace): boolean {
	if (i.type !== "virtual-machine") return false;
	for (const config of [i.config, i.expandedConfig])
		for (const [key, value] of Object.entries(config)) {
			if (key.startsWith("volatile.") || key.startsWith("image.")) continue;
			if (!BUILD_CONFIG.has(key)) return false;
			if (key === "user.qorpera.image_builder" && value !== "true") return false;
			if (key === "boot.autostart" && value !== "false") return false;
		}
	// The root may come from a profile (only in the expanded devices) or be the instance's own.
	for (const [devices, required] of [
		[i.devices, false],
		[i.expandedDevices, true],
	] as const) {
		let roots = 0;
		for (const device of Object.values(devices)) {
			if (device.type === "nic") {
				if (
					Object.keys(device).some((k) => !BUILD_NIC.has(k)) ||
					device.network !== space.network ||
					device["security.mac_filtering"] !== "true" ||
					device["security.ipv4_filtering"] !== "true" ||
					device["security.ipv6_filtering"] !== "true" ||
					device["security.port_isolation"] !== "true"
				)
					return false;
				continue;
			}
			if (
				device.type !== "disk" ||
				device.path !== "/" ||
				typeof device.pool !== "string" ||
				typeof device.size !== "string" ||
				!/^[1-9][0-9]*(\.[0-9]+)?[A-Za-z]{0,3}$/.test(device.size) ||
				Object.keys(device).some((k) => !["type", "path", "pool", "size", "size.state"].includes(k))
			)
				return false;
			roots += 1;
		}
		if (roots > 1 || (required && roots !== 1)) return false;
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
						: tag("schema") === "qorpera.lxd-company-machine/v2"
							? "machine"
							: null;
	const id = kind === "native" ? tag("acquisition_id") : tag("allocation_id");
	const expected = c.allocations.find((a) => a.allocationId === id);
	if (
		!expected ||
		i.type !== "virtual-machine" ||
		kind !== expected.providerKind ||
		tag(kind === "office" || kind === "coding" || kind === "machine" ? "provider_id" : "provider_adapter") !==
			expected.providerId ||
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
/** `releasedImages`: the runner images the node's signed releases pin
 * (readNodeReleaseImages). Only entries listed by role consult it. */
export function reconcileRuntimeNodeInventory(
	inventory: LxdHostInventory,
	context: RuntimeNodeInventoryContext,
	releasedImages: ReadonlySet<string> = new Set(),
) {
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
		// The policy keeps code host projects apart from the build space and infrastructure.
		const host = CODE_HOST_PROJECT.test(i.project),
			build = p.buildSpace?.project === i.project,
			a = build || host ? null : allocation(i, c),
			infra =
				a || build || host ? undefined : p.infrastructure.find((v) => v.project === i.project && v.name === i.name),
			{ configurationSha256, identities } = runtimeNodeInstanceConfiguration(i, infra?.identityVolumes, infra?.role),
			resources = cost(i),
			s = state(i);
		let category: RuntimeNodeInventoryEntry["category"] = "unmanaged",
			reason: RuntimeNodeInventoryEntry["reason"] = "UNREGISTERED_INSTANCE";
		if (build) {
			// Build machines never stand for an allocation or infrastructure entry.
			category = "build";
			reason =
				physicalId &&
				resources.cpuMillis !== null &&
				resources.memoryBytes !== null &&
				p.buildSpace &&
				buildMachine(i, p.buildSpace)
					? null
					: "INSTANCE_AUTHORITY_DIFFERS";
		} else if (host) {
			// Exactly as the executor makes it, or unregistered. The executor never freezes one, and a frozen VM
			// would keep its memory outside the running count.
			if (p.codeHosts && physicalId && codeHostInstanceMatches(p.codeHosts, i.project, i)) {
				category = "code-host";
				reason = i.statusCode === 110 ? "INSTANCE_AUTHORITY_DIFFERS" : null;
			}
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
			const image = i.config["volatile.base_image"];
			reason = !(
				isDeepStrictEqual(infra, {
					project: i.project,
					name: i.name,
					physicalId,
					type: i.type,
					configurationSha256,
					...resources,
					...(infra.identityVolumes ? { identityVolumes: infra.identityVolumes } : {}),
					...(infra.role ? { role: infra.role } : {}),
				}) &&
				(identities ?? []).every((id) => accepted.has(id)) &&
				!Object.keys(i.expandedConfig).some(
					(k) => k.startsWith("user.qorpera.") && k !== "user.qorpera.management_vm",
				)
			)
				? "INSTANCE_AUTHORITY_DIFFERS"
				: infra.role &&
						!(
							typeof image === "string" &&
							image === i.expandedConfig["volatile.base_image"] &&
							releasedImages.has(image)
						)
					? "INSTANCE_IMAGE_NOT_RELEASED"
					: null;
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
	// At most the policy's `running` code hosts are not stopped; each is the policy's size.
	const hosts = entries.filter((e) => e.category === "code-host" && e.state !== "suspended");
	if (p.codeHosts && hosts.length > p.codeHosts.running)
		for (const e of hosts) if (e.reason === null) e.reason = "CODE_HOST_SPACE_EXCEEDED";
	const reserved = runtimeNodeReserved(p);
	const headroomValid = reserved.cpuMillis <= c.headroomCpuMillis && reserved.memoryBytes <= c.headroomMemoryBytes;
	return {
		state: headroomValid && entries.every((i) => i.reason === null) ? ("ready" as const) : ("unavailable" as const),
		entries,
		headroomValid,
	};
}
